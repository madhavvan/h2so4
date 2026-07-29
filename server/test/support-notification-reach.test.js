// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SUPPORT ALERTS — who can actually be reached
//
//  Every push path (the instant ntfy on "Talk to a human", the t+30s ntfy
//  rung, the t+5m SMS rung) selected recipients with
//  listOnlineSupportAgents, which requires a heartbeat inside 90 seconds.
//  That heartbeat only refreshes while an agent holds an open support
//  WebSocket. So the notification whose entire purpose is to buzz a phone
//  when nobody is watching the inbox was skipped in exactly that case, and
//  fired only when the agent already had the customer on screen.
//
//  Measured on the live database before the fix: three agents with an ntfy
//  topic configured, all with status 'online', and ZERO qualifying —
//  heartbeats 43 hours, 54 days and 67 days stale. Every
//  `[escalation] ntfy skip reason=no_agents_with_topic` was that, not a
//  missing topic.
//
//  The two questions are now separate queries:
//    listOnlineSupportAgents      — is a socket open (liveness). For UI.
//    listNotifiableSupportAgents  — does this agent want to be reached
//                                   (intent). For alerts.
//
//  'offline' is a deliberate mute and is never set automatically on
//  disconnect — doing that would rebuild the same bug, since closing the
//  inbox is precisely when the phone should ring.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const require = createRequire(import.meta.url);
const db = require('../src/database.js');

const STALE = Date.now() - 60 * 60 * 1000;   // an hour ago: laptop shut
const FRESH = Date.now() - 5_000;            // inbox open right now

function agent(email, { status = 'online', topic = null, phone = null, heartbeat = STALE, prefs = null } = {}) {
  db.setSupportAgentPresence({
    agent_email: email, status, ntfy_topic: topic, twilio_phone: phone,
    notification_prefs: prefs ? JSON.stringify(prefs) : null,
  });
  db.getDB().prepare('UPDATE support_agent_presence SET last_heartbeat_at = ?, status = ? WHERE agent_email = ?')
    .run(heartbeat, status, email.toLowerCase());
}

beforeAll(() => { db.getDB(); });

describe('reachability is not liveness', () => {
  it('reaches an agent whose laptop is shut — the whole point of a push', () => {
    agent('away@test.example', { topic: 'topic-away', heartbeat: STALE });

    // The old selector: needs a heartbeat inside 90s.
    const online = db.listOnlineSupportAgents().map(a => a.agent_email);
    expect(online).not.toContain('away@test.example');

    // The new one: they configured a topic and have not muted.
    const notifiable = db.listNotifiableSupportAgents().map(a => a.agent_email);
    expect(notifiable).toContain('away@test.example');
  });

  it('respects an explicit mute', () => {
    agent('muted@test.example', { status: 'offline', topic: 'topic-muted', heartbeat: FRESH });
    const notifiable = db.listNotifiableSupportAgents().map(a => a.agent_email);
    expect(notifiable).not.toContain('muted@test.example');
  });

  it("still includes 'away' — away is not do-not-disturb", () => {
    agent('stepped-out@test.example', { status: 'away', topic: 'topic-away2', heartbeat: STALE });
    expect(db.listNotifiableSupportAgents().map(a => a.agent_email))
      .toContain('stepped-out@test.example');
  });

  it('reproduces the live-database shape: topics configured, nobody reachable under the old rule', () => {
    // Three agents, status 'online', heartbeats long stale — exactly what
    // was measured in production.
    for (const n of [1, 2, 3]) {
      agent(`prod${n}@test.example`, { topic: `topic-prod${n}`, heartbeat: Date.now() - n * 24 * 3600 * 1000 });
    }
    const withTopic = ['prod1@test.example', 'prod2@test.example', 'prod3@test.example'];

    const onlineWithTopic = db.listOnlineSupportAgents()
      .filter(a => a.ntfy_topic && withTopic.includes(a.agent_email));
    expect(onlineWithTopic).toHaveLength(0);           // the bug

    const notifiableWithTopic = db.listNotifiableSupportAgents()
      .filter(a => a.ntfy_topic && withTopic.includes(a.agent_email));
    expect(notifiableWithTopic).toHaveLength(3);       // the fix
  });

  it('liveness query still works for the "an agent is here" UI', () => {
    agent('at-desk@test.example', { topic: 'topic-desk', heartbeat: FRESH });
    expect(db.listOnlineSupportAgents().map(a => a.agent_email)).toContain('at-desk@test.example');
  });
});

describe('escalation rows record what happened, not just that we looked', () => {
  let threadId;
  beforeAll(() => {
    db.createUser({
      id: 'u_esc', email: 'esc@test.example', name: 'Esc',
      password: 'pw-123456', tier: 'pro', country_code: 'US',
    });
    const t = db.createSupportThread({
      customer_email: 'esc@test.example', customer_name: 'Esc',
      customer_tier: 'pro', customer_user_id: 'u_esc',
      initial_question: 'is anyone there?', channel: 'bot',
    });
    threadId = t.id;
    db.enqueueSupportEscalations(threadId, [
      { channel: 'ntfy', fire_at: Date.now() - 1000 },
      { channel: 'email', fire_at: Date.now() - 1000 },
    ]);
  });

  const rowFor = (channel) => db.getDB()
    .prepare('SELECT * FROM support_escalation_queue WHERE thread_id = ? AND channel = ?')
    .get(threadId, channel);

  it('distinguishes a delivered alert from a silently skipped one', () => {
    db.markSupportEscalationFired(threadId, 'ntfy', 'skipped:no_agents_with_topic');
    db.markSupportEscalationFired(threadId, 'email', 'sent');

    const skipped = rowFor('ntfy');
    const sent = rowFor('email');

    // Before the outcome column both of these looked identical — a tidy
    // fired_at timestamp and no indication that one reached nobody.
    expect(skipped.fired_at).toBeTruthy();
    expect(sent.fired_at).toBeTruthy();
    expect(skipped.outcome).toBe('skipped:no_agents_with_topic');
    expect(sent.outcome).toBe('sent');
  });

  it('keeps the one-shot guarantee — a second mark cannot overwrite the first', () => {
    // fired_at IS NULL in the WHERE clause is what stops a failing channel
    // spinning in a retry loop; that must survive the outcome change.
    db.markSupportEscalationFired(threadId, 'ntfy', 'sent');
    expect(rowFor('ntfy').outcome).toBe('skipped:no_agents_with_topic');
  });

  it('accepts a legacy two-argument call', () => {
    db.enqueueSupportEscalations(threadId, [{ channel: 'sms', fire_at: Date.now() - 1000 }]);
    expect(() => db.markSupportEscalationFired(threadId, 'sms')).not.toThrow();
    const row = rowFor('sms');
    expect(row.fired_at).toBeTruthy();
    expect(row.outcome).toBeNull();   // honest "we don't know"
  });
});
