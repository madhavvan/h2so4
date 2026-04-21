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

async function sendMail({ to, subject, html, text }) {
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
    const info = await transporter.sendMail({ from, to, subject, html, text });
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

module.exports = { sendMail, renderPasswordResetEmail, renderPaymentFailedEmail };
