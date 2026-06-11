// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SUPPORT ESCALATION WORKER
//
//  Cron-style scanner that fires staged alerts when no agent claims a
//  customer's chat. The ladder, per the architecture decision on
//  2026-05-13:
//
//    t+0s   : Slack webhook (fired immediately from the WS handler)
//    t+30s  : ntfy.sh push to every online agent's topic
//    t+2m   : Resend email to support@minicaai.com
//    t+5m   : Twilio SMS (only if agent has twilio_phone + SMS enabled)
//    t+24h  : Auto-fallback bot reply to the customer ("we'll email you")
//
//  Each rung in the ladder fires INDEPENDENTLY — losing the ntfy push
//  doesn't prevent the email; losing the email doesn't prevent the SMS.
//  All rungs are CANCELED the moment any agent claims the thread (or it
//  resolves) via cancelSupportEscalations(threadId) in the DB layer.
//
//  Polling interval is 10s. The DB query is cheap (indexed on fire_at
//  partial-index), so this stays well under a millisecond per tick even
//  at thousands of queued rows.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

'use strict';

const db = require('../database');
const { sendNewCustomerAlert, sendNtfy, PRIORITY } = require('./ntfy');

const TICK_MS = 10_000;
let timer = null;

// Escalation timing table — what to enqueue when a customer thread is
// created. All offsets in ms from thread creation. Exported so the WS
// handler can call enqueueSupportEscalations with the same definition
// without drift.
const ESCALATION_LADDER = [
  { channel: 'ntfy',     delayMs:    30_000 },   // t+30s
  { channel: 'email',    delayMs:   120_000 },   // t+2m
  { channel: 'sms',      delayMs:   300_000 },   // t+5m
  { channel: 'fallback', delayMs: 86_400_000 },  // t+24h
];

/**
 * Build the rows to insert into support_escalation_queue for a freshly
 * opened thread. Called once on thread creation.
 */
function buildEscalationsFor(thread) {
  const now = thread.created_at || Date.now();
  return ESCALATION_LADDER.map(({ channel, delayMs }) => ({
    channel,
    fire_at: now + delayMs,
  }));
}

// ─── Channel dispatchers ──────────────────────────────────────────

async function fireNtfy(row) {
  // Send to every online agent's topic. If the topic field is empty
  // (older agent without setup), skip silently — they get the Slack/
  // email/desktop rungs anyway. We don't fail the row in that case.
  const agents = db.listOnlineSupportAgents();
  const targets = agents.filter(a => a.ntfy_topic && a.ntfy_topic.length > 0);
  if (targets.length === 0) {
    console.log(`[escalation] ntfy skip thread=${row.thread_id} reason=no_agents_with_topic`);
    return { ok: true, skipped: true };
  }
  const results = await Promise.all(targets.map(a =>
    sendNewCustomerAlert(a.ntfy_topic, {
      customerName: row.customer_name,
      customerEmail: row.customer_email,
      question: row.initial_question,
      threadId: row.thread_id,
      dashboardUrl: process.env.SERVER_URL
        ? `${process.env.SERVER_URL}/admin/support/${row.thread_id}`
        : undefined,
    }).then(r => ({ ok: r.ok, agent_email: a.agent_email }))
  ));
  const okCount = results.filter(r => r.ok).length;
  // Mark last_alert_at for every agent who got an OK response so
  // their inbox card can show "last alert Nm ago" without needing
  // them to fire a manual test.
  for (const r of results) {
    if (r.ok) {
      try { db.markNtfyAlertSent(r.agent_email); }
      catch { /* non-critical */ }
    }
  }
  console.log(`[escalation] ntfy thread=${row.thread_id} fanout=${targets.length} ok=${okCount}`);
  return { ok: okCount > 0, fanout: targets.length, ok_count: okCount };
}

async function fireEmail(row) {
  const { sendMail } = require('../email');
  const to = process.env.SUPPORT_HANDOFF_EMAIL || 'support@minicaai.com';
  const subject = `[minicaai] waiting >2 min: ${row.customer_name || row.customer_email}`;
  const text = [
    'A customer has been waiting more than 2 minutes for a reply.',
    '',
    `From: ${row.customer_name || '(no name)'} <${row.customer_email}>`,
    `Question: ${row.initial_question || '(no initial question)'}`,
    `Thread: ${row.thread_id}`,
    '',
    `Open inbox: ${process.env.SERVER_URL || 'https://minicaai.com'}/admin/support/${row.thread_id}`,
  ].join('\n');
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;line-height:1.55;max-width:600px;">
    <h2 style="margin:0 0 12px;color:#dc2626;">Customer waiting &gt;2 min</h2>
    <p style="margin:6px 0;"><strong>From:</strong> ${escapeHtml(row.customer_name || '(no name)')} &lt;${escapeHtml(row.customer_email)}&gt;</p>
    <p style="margin:6px 0;"><strong>Question:</strong> ${escapeHtml(row.initial_question || '(none)')}</p>
    <p style="margin:6px 0;"><strong>Thread:</strong> <code>${escapeHtml(row.thread_id)}</code></p>
    <p style="margin:16px 0;">
      <a href="${process.env.SERVER_URL || 'https://minicaai.com'}/admin/support/${encodeURIComponent(row.thread_id)}"
         style="display:inline-block;padding:10px 16px;background:#3b82f6;color:white;text-decoration:none;border-radius:6px;font-weight:600;">
        Open inbox
      </a>
    </p>
  </div>`;
  try {
    const r = await sendMail({ to, subject, text, html });
    console.log(`[escalation] email thread=${row.thread_id} ok=${!!r?.ok}`);
    return { ok: !!r?.ok };
  } catch (e) {
    console.warn(`[escalation] email failed thread=${row.thread_id}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function fireSms(row) {
  // SMS is opt-in per agent (twilio_phone + sms:true in prefs). Skip
  // if no agent has it enabled — the email rung covers the urgency
  // case. We never error this rung: a missing Twilio config is normal.
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM) {
    console.log(`[escalation] sms skip thread=${row.thread_id} reason=twilio_not_configured`);
    return { ok: true, skipped: true };
  }
  const agents = db.listOnlineSupportAgents();
  const targets = agents.filter(a => {
    if (!a.twilio_phone) return false;
    try {
      const prefs = a.notification_prefs ? JSON.parse(a.notification_prefs) : {};
      return prefs.sms === true;
    } catch { return false; }
  });
  if (targets.length === 0) {
    console.log(`[escalation] sms skip thread=${row.thread_id} reason=no_agents_with_sms_pref`);
    return { ok: true, skipped: true };
  }
  // Lazy-load Twilio so the dependency is only required when actually
  // used in production. If the package isn't installed yet, log and
  // skip — graceful degradation.
  let twilio;
  try { twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN); }
  catch (e) {
    console.warn(`[escalation] twilio SDK not installed — npm install twilio. Skipping SMS.`);
    return { ok: true, skipped: true };
  }
  const body = `[minicaai] ${row.customer_name || row.customer_email} waiting >5min: "${(row.initial_question || '').slice(0, 100)}"`;
  const results = await Promise.allSettled(targets.map(a =>
    twilio.messages.create({ body, to: a.twilio_phone, from: process.env.TWILIO_FROM })
  ));
  const okCount = results.filter(r => r.status === 'fulfilled').length;
  console.log(`[escalation] sms thread=${row.thread_id} fanout=${targets.length} ok=${okCount}`);
  return { ok: okCount > 0, fanout: targets.length, ok_count: okCount };
}

async function fireFallback(row) {
  // 24h auto-reply: insert a system message so the customer knows we
  // didn't abandon them. Doesn't email the customer — the bot message
  // shows next time they open the panel.
  db.appendSupportMessage({
    thread_id: row.thread_id,
    sender_role: 'system',
    sender_name: 'Minica',
    text:
      "Hey — our team is slammed today and hasn't been able to reply yet. " +
      "I've recorded your question and we'll email you back within 24 hours. " +
      "Sorry for the delay.",
  });
  console.log(`[escalation] fallback thread=${row.thread_id} ok=true`);
  return { ok: true };
}

const DISPATCHERS = {
  ntfy: fireNtfy,
  email: fireEmail,
  sms: fireSms,
  fallback: fireFallback,
};

// ─── Tick loop ────────────────────────────────────────────────────

async function tick() {
  let due;
  try {
    due = db.getDueSupportEscalations();
  } catch (e) {
    console.error('[escalation] DB scan failed:', e.message);
    return;
  }
  if (!due || due.length === 0) return;
  for (const row of due) {
    const fn = DISPATCHERS[row.channel];
    if (!fn) {
      console.warn(`[escalation] unknown channel '${row.channel}' for thread=${row.thread_id} — marking fired to avoid retry loop`);
      db.markSupportEscalationFired(row.thread_id, row.channel);
      continue;
    }
    try {
      await fn(row);
    } catch (e) {
      console.error(`[escalation] dispatch ${row.channel} threw for thread=${row.thread_id}: ${e.message}`);
    }
    // ALWAYS mark fired, even on dispatcher errors — we don't want a
    // permanently-failing channel (e.g. expired Twilio creds) to
    // hammer ntfy/email retry attempts in a loop. The escalation row
    // is a one-shot; the underlying support_threads row stays open
    // for the agent to handle when they're back.
    db.markSupportEscalationFired(row.thread_id, row.channel);
  }
}

function start() {
  if (timer) return; // idempotent
  // First tick on a short delay, then every TICK_MS. unref() so this
  // doesn't block process exit during graceful shutdown.
  setTimeout(() => { tick().catch(() => {}); }, 5_000).unref();
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  timer.unref();
  console.log('[escalation] worker started, scanning every 10s');
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// ─── Small util ───────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = {
  start,
  stop,
  tick,                    // exposed for tests / manual triggering
  buildEscalationsFor,
  ESCALATION_LADDER,
};
