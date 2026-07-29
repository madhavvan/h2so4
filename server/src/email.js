// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  EMAIL — Resend (HTTPS) primary, SMTP fallback
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Primary transport is Resend over HTTPS (port 443). Railway (and most
// cloud hosts) blocks or rate-limits outbound SMTP to Gmail/Office365,
// which is why we moved off nodemailer-to-Gmail. Resend uses plain
// HTTPS so the TCP path always works.
//
// If RESEND_API_KEY is not set we fall back to nodemailer/SMTP — still
// useful for local dev against Mailhog or a personal Gmail. If neither
// is configured we log the message (including reset links) to the
// console so local dev never silently swallows email.

let resendClient = null;
let resendInitAttempted = false;
let transporterPromise = null;

function getResendClient() {
  if (resendInitAttempted) return resendClient;
  resendInitAttempted = true;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log('[email] RESEND_API_KEY not set — falling back to SMTP');
    return null;
  }

  try {
    const { Resend } = require('resend');
    resendClient = new Resend(apiKey);
    console.log('[email] Resend initialized — using HTTPS API transport');
  } catch (err) {
    console.error('[email] resend package not installed — run `npm install resend` in the server directory:', err && err.message);
    resendClient = null;
  }
  return resendClient;
}

function getTransporter() {
  if (transporterPromise) return transporterPromise;

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  // Strip whitespace. Gmail app passwords are shown as "abcd efgh ijkl mnop"
  // and users paste them as-is into Railway; those spaces then travel
  // through SMTP AUTH PLAIN and Gmail rejects (often slowly, hanging the
  // connection). Same hygiene on the username to be safe.
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').replace(/\s+/g, '');

  console.log(`[email] SMTP config — host=${host || '(not set)'}, port=${port}, user=${user || '(not set)'}, pass=${pass ? `**** (${pass.length} chars)` : '(not set)'}`);

  if (!host || !user || !pass) {
    console.error('[email] SMTP not configured — missing:', [!host && 'SMTP_HOST', !user && 'SMTP_USER', !pass && 'SMTP_PASS'].filter(Boolean).join(', '));
    transporterPromise = Promise.resolve(null);
    return transporterPromise;
  }

  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      // Aggressive timeouts. Nodemailer defaults are 2 min connect and
      // 10 min socket — any stuck Gmail handshake would hang requests
      // effectively forever. Fail fast so callers can retry or respond.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    // Probe the connection. On failure, clear the cached promise so the
    // next sendMail rebuilds the transport — otherwise one bad boot
    // permanently breaks email until the process restarts.
    transporter.verify()
      .then(() => console.log('[email] SMTP connection verified — ready to send'))
      .catch((err) => {
        console.error('[email] SMTP connection FAILED:', err && err.message);
        transporterPromise = null;
      });
    transporterPromise = Promise.resolve(transporter);
  } catch (err) {
    console.error('[email] nodemailer not installed — run `npm install nodemailer` in the server directory.');
    transporterPromise = Promise.resolve(null);
  }
  return transporterPromise;
}

async function sendMail({ to, subject, html, text, replyTo }) {
  const from = process.env.EMAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@minicaai.com';

  // ── Primary: Resend (HTTPS, survives cloud egress restrictions) ──
  const resend = getResendClient();
  if (resend) {
    try {
      // Resend SDK v3+ returns { data, error } instead of throwing.
      // Wrap `to` as an array — string works too, but array is the
      // documented shape and avoids SDK edge cases.
      const result = await resend.emails.send({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      });
      if (result && result.error) {
        const msg = result.error.message || JSON.stringify(result.error);
        console.error('[email:resend] send failed:', msg);
        return { ok: false, reason: 'resend_failed', error: msg };
      }
      const messageId = result && result.data && result.data.id;
      console.log('[email:resend] sent' + (messageId ? ` messageId=${messageId}` : ''));
      return { ok: true, messageId };
    } catch (err) {
      console.error('[email:resend] send threw:', err && err.message);
      return { ok: false, reason: 'resend_threw', error: err && err.message };
    }
  }

  // ── Fallback: SMTP (nodemailer) ──
  const transporter = await getTransporter();
  if (!transporter) {
    console.warn('━'.repeat(60));
    console.warn('[email] No transport configured (no RESEND_API_KEY and no SMTP) — message not sent.');
    console.warn(`        To:      ${to}`);
    console.warn(`        Subject: ${subject}`);
    if (text) console.warn(`        Body:    ${text}`);
    console.warn('━'.repeat(60));
    return { ok: false, reason: 'no_transport_configured' };
  }

  try {
    const info = await transporter.sendMail({ from, to, subject, html, text, ...(replyTo ? { replyTo } : {}) });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error('[email:smtp] send failed:', err && err.message);
    // Bust the transport cache on failure so the next call rebuilds.
    // Cheap, and avoids a zombie transporter on transient network blips.
    transporterPromise = null;
    return { ok: false, reason: 'send_failed', error: err && err.message };
  }
}

function renderPasswordResetEmail({ name, resetUrl }) {
  const safeName = (name || 'there').replace(/</g, '&lt;');
  const text = [
    `Hi ${safeName},`,
    '',
    'We received a request to reset the password for your minicaai account.',
    'Click the link below within the next hour to choose a new password:',
    '',
    resetUrl,
    '',
    "If you didn't request this, you can safely ignore this email — your password won't change.",
    '',
    '— The minicaai team',
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#050507;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e5e7eb">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:32px">
      <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);display:inline-block"></div>
      <div style="font-weight:700;font-size:18px;color:#fff">minicaai</div>
    </div>
    <h1 style="font-size:22px;font-weight:700;color:#fff;margin:0 0 16px">Reset your password</h1>
    <p style="font-size:14px;line-height:1.6;color:#9ca3af;margin:0 0 24px">
      Hi ${safeName}, we received a request to reset the password for your minicaai account.
      Click the button below within the next hour to choose a new password.
    </p>
    <div style="margin:32px 0">
      <a href="${resetUrl}" style="display:inline-block;padding:14px 28px;border-radius:12px;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;font-weight:600;font-size:14px;text-decoration:none">
        Reset password
      </a>
    </div>
    <p style="font-size:12px;color:#6b7280;margin:0 0 8px">Or paste this link into your browser:</p>
    <p style="font-size:12px;color:#9ca3af;word-break:break-all;margin:0 0 24px"><a href="${resetUrl}" style="color:#60a5fa">${resetUrl}</a></p>
    <div style="border-top:1px solid #1f2937;padding-top:16px;font-size:12px;color:#6b7280;line-height:1.6">
      If you didn't request this, you can safely ignore this email — your password won't change.
    </div>
  </div>
</body></html>`;

  return { subject: 'Reset your minicaai password', html, text };
}

// Sent from webhook handlers when Stripe/Razorpay reports a failed
// charge against an active subscription. We deliberately keep the body
// short and action-oriented because most failures are recoverable
// (expired card, declined CVC, insufficient funds) and the user just
// needs a one-click path back to billing.
//
// `manageUrl` should be the FRONTEND_URL — the SubscriptionGate UI on
// that page already exposes the right portal/cancel/upgrade controls
// based on the user's provider and tier.
function renderPaymentFailedEmail({ name, tier, manageUrl, reason }) {
  const safeName = (name || 'there').replace(/</g, '&lt;');
  const safeTier = (tier || 'your plan').toString().toUpperCase().replace(/</g, '&lt;');
  const safeReason = reason ? String(reason).replace(/</g, '&lt;').slice(0, 200) : '';
  const url = manageUrl || 'https://minicaai.com';

  const text = [
    `Hi ${safeName},`,
    '',
    `We weren't able to process the most recent payment for your minicaai ${safeTier} subscription.`,
    safeReason ? `Reason from your bank/card: ${safeReason}` : '',
    '',
    "Most failures are quick fixes — an expired card, a declined CVC, or a temporary hold. Open your billing page to update your payment method:",
    '',
    url,
    '',
    "We'll automatically retry over the next few days. If we still can't collect, your subscription will lapse and your account will downgrade to the free tier — no action needed if you'd prefer that outcome.",
    '',
    '— The minicaai team',
  ].filter(Boolean).join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#050507;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e5e7eb">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:32px">
      <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);display:inline-block"></div>
      <div style="font-weight:700;font-size:18px;color:#fff">minicaai</div>
    </div>
    <h1 style="font-size:22px;font-weight:700;color:#fff;margin:0 0 16px">Payment couldn't be processed</h1>
    <p style="font-size:14px;line-height:1.6;color:#9ca3af;margin:0 0 16px">
      Hi ${safeName}, we weren't able to process the most recent payment for your minicaai <strong style="color:#e5e7eb">${safeTier}</strong> subscription.
    </p>
    ${safeReason ? `<p style="font-size:13px;line-height:1.6;color:#fca5a5;background:#1f1416;border:1px solid #4c1d24;border-radius:8px;padding:10px 14px;margin:0 0 24px">Reason from your bank/card: ${safeReason}</p>` : ''}
    <p style="font-size:14px;line-height:1.6;color:#9ca3af;margin:0 0 24px">
      Most failures are quick fixes — an expired card, a declined CVC, or a temporary hold. Update your payment method below:
    </p>
    <div style="margin:24px 0">
      <a href="${url}" style="display:inline-block;padding:14px 28px;border-radius:12px;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;font-weight:600;font-size:14px;text-decoration:none">
        Update payment method
      </a>
    </div>
    <div style="border-top:1px solid #1f2937;padding-top:16px;font-size:12px;color:#6b7280;line-height:1.6">
      We'll automatically retry over the next few days. If we still can't collect, your subscription will lapse and your account will downgrade to the free tier — no action needed if you'd prefer that.
    </div>
  </div>
</body></html>`;

  return { subject: `Payment failed for your minicaai ${safeTier} subscription`, html, text };
}

// ── Tier change confirmation ─────────────────────────────────
// Sent when a user's subscription tier changes (upgrade, downgrade, or
// cycle-end-scheduled downgrade). Keeps the body short — the user
// already saw the in-app confirmation when they clicked the button; the
// email is the durable receipt + the moment they can audit "did this
// actually happen". Receipt-style, not marketing-style.
//
// Used by /payments/upgrade-tier (both Stripe and Razorpay paths).
function renderTierChangeEmail({ name, fromTier, toTier, provider, effectiveDate }) {
  const safeName = (name || 'there').toString().replace(/</g, '&lt;');
  const fromLabel = (fromTier || 'your current plan').toString().toUpperCase().replace(/</g, '&lt;');
  const toLabel = (toTier || 'a new plan').toString().toUpperCase().replace(/</g, '&lt;');
  const safeProvider = String(provider || 'your card').replace(/</g, '&lt;');
  const safeDate = String(effectiveDate || 'now').replace(/</g, '&lt;');

  const tierRank = { free: 0, basic: 1, pro: 2, max: 3 };
  const direction = (tierRank[toTier] > tierRank[fromTier]) ? 'upgrade'
    : (tierRank[toTier] < tierRank[fromTier]) ? 'downgrade'
    : 'change';

  const text = [
    `Hi ${safeName},`,
    '',
    `Your minicaai plan ${direction} is confirmed.`,
    '',
    `  From: ${fromLabel}`,
    `  To:   ${toLabel}`,
    `  When: ${safeDate}`,
    `  Via:  ${safeProvider}`,
    '',
    direction === 'upgrade'
      ? 'New features are unlocked already — open the app to use them.'
      : direction === 'downgrade'
        ? 'Your existing features stay live until the effective date above.'
        : 'No feature change — same access, different plan.',
    '',
    'If you didn\'t make this change, reply to this email and we\'ll revert it.',
    '',
    '— The minicaai team',
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#050507;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e5e7eb">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:32px">
      <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#3b82f6,#8b5cf6)"></div>
      <div style="font-weight:700;font-size:18px;color:#fff">minicaai</div>
    </div>
    <h1 style="font-size:22px;font-weight:700;color:#fff;margin:0 0 12px">Plan ${direction} confirmed</h1>
    <p style="font-size:14px;line-height:1.6;color:#9ca3af;margin:0 0 20px">Hi ${safeName}, your subscription was ${direction === 'change' ? 'updated' : direction === 'upgrade' ? 'upgraded' : 'downgraded'}.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 24px">
      <tr><td style="padding:8px 0;color:#6b7280;width:90px">From</td><td style="padding:8px 0;color:#e5e7eb;font-weight:600">${fromLabel}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280">To</td><td style="padding:8px 0;color:#e5e7eb;font-weight:600">${toLabel}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280">When</td><td style="padding:8px 0;color:#e5e7eb">${safeDate}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280">Via</td><td style="padding:8px 0;color:#e5e7eb">${safeProvider}</td></tr>
    </table>
    <p style="font-size:13px;line-height:1.6;color:#9ca3af;margin:0 0 20px">${
      direction === 'upgrade'
        ? 'New features are unlocked already — open the app to use them.'
        : direction === 'downgrade'
          ? 'Your existing features stay live until the effective date above.'
          : 'No feature change — same access, different plan.'
    }</p>
    <div style="border-top:1px solid #1f2937;padding-top:16px;font-size:12px;color:#6b7280;line-height:1.6">
      Didn't make this change? Reply to this email and we'll revert it.
    </div>
  </div>
</body></html>`;

  return { subject: `minicaai plan ${direction}: ${fromLabel} → ${toLabel}`, html, text };
}

// ── Cancellation confirmation ───────────────────────────────
// Sent when a user cancels their subscription. Includes the period-end
// date and a one-click "reactivate" CTA (deep-links into the app's
// Manage Subscription screen via the existing minicaai://signin-complete
// protocol that we registered for Google OAuth handoff).
function renderCancellationEmail({ name, tier, effectiveDate, manageUrl }) {
  const safeName = (name || 'there').toString().replace(/</g, '&lt;');
  const safeTier = (tier || 'your plan').toString().toUpperCase().replace(/</g, '&lt;');
  const safeDate = String(effectiveDate || 'end of current cycle').replace(/</g, '&lt;');
  const url = manageUrl || 'https://minicaai.com/manage';

  const text = [
    `Hi ${safeName},`,
    '',
    `Your minicaai ${safeTier} subscription has been scheduled to cancel.`,
    `Your access continues until: ${safeDate}.`,
    '',
    `Changed your mind? Reactivate any time before then: ${url}`,
    '',
    '— The minicaai team',
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#050507;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e5e7eb">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:32px">
      <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#3b82f6,#8b5cf6)"></div>
      <div style="font-weight:700;font-size:18px;color:#fff">minicaai</div>
    </div>
    <h1 style="font-size:22px;font-weight:700;color:#fff;margin:0 0 12px">Cancellation scheduled</h1>
    <p style="font-size:14px;line-height:1.6;color:#9ca3af;margin:0 0 16px">Hi ${safeName}, your <strong style="color:#e5e7eb">${safeTier}</strong> subscription is set to cancel on <strong style="color:#e5e7eb">${safeDate}</strong>. You keep full access until then.</p>
    <div style="margin:24px 0">
      <a href="${url}" style="display:inline-block;padding:12px 24px;border-radius:10px;background:#f59e0b;color:#000;font-weight:700;font-size:14px;text-decoration:none">
        Changed your mind? Reactivate
      </a>
    </div>
    <div style="border-top:1px solid #1f2937;padding-top:16px;font-size:12px;color:#6b7280;line-height:1.6">
      No further action is required. We'll send one more email when access actually ends.
    </div>
  </div>
</body></html>`;

  return { subject: `Cancellation scheduled — keep ${safeTier} until ${safeDate}`, html, text };
}

// ── Access ended (cycle-end goodbye) ─────────────────────────
// Fires when the paid subscription cycle actually closes and the
// license has been transitioned to Free. This is the SECOND mail in
// the cancellation arc — the first was renderCancellationEmail
// ("scheduled to cancel"); this one says "your access has ended,
// here's what you keep and how to come back". Includes a one-click
// "Buy Basic now" CTA because Basic is the easiest path back in
// (one-time $25, no recurring commitment).
function renderAccessEndedEmail({ name, previousTier, buyBasicUrl, signInUrl }) {
  const safeName = (name || 'there').toString().replace(/</g, '&lt;');
  const safeTier = (previousTier || 'paid').toString().toUpperCase().replace(/</g, '&lt;');
  const basicUrl = buyBasicUrl || 'https://minicaai.com/#pricing';
  const inUrl = signInUrl || 'https://minicaai.com';

  const text = [
    `Hi ${safeName},`,
    '',
    `Your ${safeTier} access just ended and your account is now on the Free plan.`,
    '',
    `What you keep:`,
    `  - Your account, settings, custom instructions, and conversation history`,
    `  - 5 free practice sessions per month with Gemini`,
    '',
    `Easiest way back in: pick up Basic ($25 one-time, 3 sessions, 14-day window — no auto-renewal).`,
    basicUrl,
    '',
    `Or you can subscribe to Pro/Max again any time from Manage Subscription:`,
    inUrl,
    '',
    '— The minicaai team',
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#050507;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e5e7eb">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:32px">
      <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#3b82f6,#8b5cf6)"></div>
      <div style="font-weight:700;font-size:18px;color:#fff">minicaai</div>
    </div>
    <h1 style="font-size:22px;font-weight:700;color:#fff;margin:0 0 12px">Your ${safeTier} access has ended</h1>
    <p style="font-size:14px;line-height:1.6;color:#9ca3af;margin:0 0 16px">Hi ${safeName}, the cancellation we scheduled has taken effect. You're on the <strong style="color:#e5e7eb">Free plan</strong> now — your account, settings, custom instructions, and conversation history are all intact.</p>
    <div style="background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:14px 18px;margin:18px 0">
      <div style="font-size:12px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">What you keep on Free</div>
      <ul style="font-size:13px;line-height:1.7;color:#d1d5db;margin:0;padding-left:18px">
        <li>5 practice sessions per month</li>
        <li>Gemini model access</li>
        <li>Account, settings, custom instructions, history</li>
      </ul>
    </div>
    <p style="font-size:14px;line-height:1.6;color:#9ca3af;margin:0 0 8px">Easiest way back in is <strong style="color:#e5e7eb">Basic</strong> — $25 one-time, no auto-renewal, 3 sessions over 14 days:</p>
    <div style="margin:18px 0">
      <a href="${basicUrl}" style="display:inline-block;padding:12px 24px;border-radius:10px;background:linear-gradient(135deg,#10b981,#3b82f6);color:#fff;font-weight:700;font-size:14px;text-decoration:none">
        Get Basic — $25
      </a>
    </div>
    <p style="font-size:13px;line-height:1.6;color:#9ca3af;margin:14px 0 24px">Or come back to <a href="${inUrl}" style="color:#60a5fa">Manage Subscription</a> any time to switch to Pro or Max.</p>
    <div style="border-top:1px solid #1f2937;padding-top:16px;font-size:12px;color:#6b7280;line-height:1.6">
      Thanks for being a minicaai customer — we'd love to see you back.
    </div>
  </div>
</body></html>`;

  return { subject: `Your ${safeTier} access has ended — Free plan is active`, html, text };
}

// ── Google Sign-In linked (security notice) ──────────────────
// Sent when a Google sign-in is auto-linked to an EXISTING account that
// already has a password (routes/auth.js, both /google and the browser
// callback flow). This is the pre-hijack tripwire: if an attacker
// registered this email+password before the real owner ever signed in,
// the owner's first Google sign-in merges onto the attacker's account —
// this email is what tells the real owner that a password they may never
// have created exists, and resetting it is how they evict the attacker.
// Deliberately loud about the "this wasn't you" path.
function renderGoogleLinkedEmail({ name }) {
  const safeName = (name || 'there').toString().replace(/</g, '&lt;');
  const resetHint = 'https://minicaai.com';

  const text = [
    `Hi ${safeName},`,
    '',
    'Google Sign-In was just linked to your minicaai account. From now on you can sign in with Google or with your existing password — both work.',
    '',
    'As a precaution, every other signed-in session was logged out; only the device that just signed in with Google stays active.',
    '',
    "IMPORTANT: if you didn't do this — or you never set a password on this account — someone else may know that password. Open the app or minicaai.com, use \"Forgot password\", and choose a new one now. That locks out anyone else immediately.",
    '',
    '— The minicaai team',
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#050507;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e5e7eb">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:32px">
      <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);display:inline-block"></div>
      <div style="font-weight:700;font-size:18px;color:#fff">minicaai</div>
    </div>
    <h1 style="font-size:22px;font-weight:700;color:#fff;margin:0 0 16px">Google Sign-In was linked to your account</h1>
    <p style="font-size:14px;line-height:1.6;color:#9ca3af;margin:0 0 16px">
      Hi ${safeName}, Google Sign-In was just linked to your minicaai account. From now on you can sign in with Google or with your existing password — both work.
    </p>
    <p style="font-size:14px;line-height:1.6;color:#9ca3af;margin:0 0 24px">
      As a precaution, every other signed-in session was logged out; only the device that just signed in with Google stays active.
    </p>
    <p style="font-size:13px;line-height:1.6;color:#fca5a5;background:#1f1416;border:1px solid #4c1d24;border-radius:8px;padding:12px 14px;margin:0 0 24px">
      <strong>Didn't do this — or never set a password on this account?</strong> Someone else may know that password. Use "Forgot password" in the app or on <a href="${resetHint}" style="color:#f87171">minicaai.com</a> to choose a new one now; that locks out anyone else immediately.
    </p>
    <div style="border-top:1px solid #1f2937;padding-top:16px;font-size:12px;color:#6b7280;line-height:1.6">
      You're receiving this because a Google account with your email address signed in to minicaai.
    </div>
  </div>
</body></html>`;

  return { subject: 'Security notice: Google Sign-In was linked to your minicaai account', html, text };
}

// ── Pass expiring with unused time (lifecycle reminder) ──────
// Sent by the pass-expiry sweep (server/src/index.js) when a Basic/Pro/Max
// license still holds >1 min of paid interview time and its window closes
// within 3 days. Dedup is handled by lifecycle_emails — one send per
// (user, expiry window), no matter how often the sweep runs.
function renderPassExpiryEmail({ name, tier, minutesLeft, expiresDate, signInUrl }) {
  const safeName = (name || 'there').toString().replace(/</g, '&lt;');
  const safeTier = (tier || 'interview').toString().toUpperCase().replace(/</g, '&lt;');
  const mins = Math.max(1, Math.round(minutesLeft || 0));
  const dateStr = (expiresDate || '').toString().replace(/</g, '&lt;');
  const inUrl = signInUrl || 'https://minicaai.com';

  const text = [
    `Hi ${safeName},`,
    '',
    `Heads-up: your ${safeTier} pass still has ${mins} minute${mins === 1 ? '' : 's'} of interview time left,`,
    `and it expires on ${dateStr}.`,
    '',
    `Open minicaai before then to use it — unused time doesn't carry over.`,
    inUrl,
    '',
    '— The minicaai team',
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#050507;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e5e7eb">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:32px">
      <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#3b82f6,#8b5cf6)"></div>
      <div style="font-weight:700;font-size:18px;color:#fff">minicaai</div>
    </div>
    <h1 style="font-size:22px;font-weight:700;color:#fff;margin:0 0 12px">You still have ${mins} minute${mins === 1 ? '' : 's'} on your ${safeTier} pass</h1>
    <p style="font-size:14px;line-height:1.6;color:#9ca3af;margin:0 0 16px">Hi ${safeName}, your pass expires on <strong style="color:#e5e7eb">${dateStr}</strong> and unused time doesn't carry over. If there's an interview (or a practice round) ahead of you, this is the moment to use it.</p>
    <div style="margin:18px 0">
      <a href="${inUrl}" style="display:inline-block;padding:12px 24px;border-radius:10px;background:linear-gradient(135deg,#10b981,#3b82f6);color:#fff;font-weight:700;font-size:14px;text-decoration:none">
        Open minicaai
      </a>
    </div>
    <div style="border-top:1px solid #1f2937;padding-top:16px;font-size:12px;color:#6b7280;line-height:1.6">
      Running long on interview day? You can add 30 minutes any time with one click from inside the app.
    </div>
  </div>
</body></html>`;

  return { subject: `${mins} minute${mins === 1 ? '' : 's'} of interview time expires ${dateStr}`, html, text };
}

// ── Purchase confirmation ──
// The app emailed on failure, cancellation, tier change and pass expiry —
// but never on a successful charge. That left Stripe's own receipt as the
// only confirmation a buyer received, and Stripe receipts are off by
// default in test mode and easy to leave off in live. A customer who paid
// $159 and got nothing in their inbox has no reason to believe it worked.
//
// Amounts arrive in the provider's smallest unit (cents / paise), matching
// how the payments table stores them.
function renderPurchaseReceiptEmail({ name, tier, isTopUp, amount, currency, manageUrl }) {
  const safeName = (name || 'there').toString().replace(/</g, '&lt;');
  const safeTier = (tier || 'plan').toString().toUpperCase().replace(/</g, '&lt;');
  const code = (currency || 'USD').toString().toUpperCase().replace(/</g, '&lt;');
  const symbol = code === 'INR' ? '₹' : code === 'USD' ? '$' : '';
  const major = Number.isFinite(amount) ? (amount / 100) : null;
  const amountStr = major == null
    ? ''
    : (code === 'INR' ? `${symbol}${Math.round(major).toLocaleString('en-IN')}` : `${symbol}${major.toFixed(2)} ${code}`);
  const url = manageUrl || 'https://minicaai.com';

  const headline = isTopUp
    ? 'Extra interview time added'
    : `Your ${safeTier} plan is active`;
  const bodyLine = isTopUp
    ? 'The time is already on your clock — head back to your interview and keep going.'
    : `Open the app and sign in with this email; ${safeTier} is ready on every device you use.`;

  const text = [
    `Hi ${safeName},`,
    '',
    `${headline}.`,
    amountStr ? `Amount charged: ${amountStr}` : '',
    '',
    bodyLine,
    url,
    '',
    'Manage your plan, see past charges, or get a refund within the policy window from Manage Subscription inside the app.',
    '',
    '— The minicaai team',
  ].filter(Boolean).join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#050507;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e5e7eb">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:32px">
      <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#3b82f6,#8b5cf6)"></div>
      <div style="font-weight:700;font-size:18px;color:#fff">minicaai</div>
    </div>
    <h1 style="font-size:22px;font-weight:700;color:#fff;margin:0 0 12px">${headline}</h1>
    <p style="font-size:14px;line-height:1.6;color:#9ca3af;margin:0 0 16px">Hi ${safeName}, thanks — your payment went through${amountStr ? ` and <strong style="color:#e5e7eb">${amountStr}</strong> was charged` : ''}. ${bodyLine}</p>
    <div style="margin:18px 0">
      <a href="${url}" style="display:inline-block;padding:12px 24px;border-radius:10px;background:linear-gradient(135deg,#10b981,#3b82f6);color:#fff;font-weight:700;font-size:14px;text-decoration:none">
        Open minicaai
      </a>
    </div>
    <div style="border-top:1px solid #1f2937;padding-top:16px;font-size:12px;color:#6b7280;line-height:1.6">
      Manage your plan, review past charges, or request a refund within the policy window from <strong style="color:#9ca3af">Manage Subscription</strong> inside the app. Your card details are held by our payment provider — we never see them.
    </div>
  </div>
</body></html>`;

  return {
    subject: isTopUp ? 'Interview time added' : `Your minicaai ${safeTier} plan is active`,
    html,
    text,
  };
}

module.exports = { sendMail, renderPasswordResetEmail, renderPaymentFailedEmail, renderTierChangeEmail, renderCancellationEmail, renderAccessEndedEmail, renderGoogleLinkedEmail, renderPassExpiryEmail, renderPurchaseReceiptEmail };
