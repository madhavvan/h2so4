// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  EMAIL — nodemailer wrapper for transactional messages
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Config is read lazily so missing SMTP env vars never crash the server
// at boot. If SMTP is unconfigured we log the message (including reset
// links) to the console — useful in local dev but the caller should
// still treat it as a "sent" for user-facing messaging.

let transporterPromise = null;

function getTransporter() {
  if (transporterPromise) return transporterPromise;

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
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
    });
    transporterPromise = Promise.resolve(transporter);
  } catch (err) {
    console.error('[email] nodemailer not installed — run `npm install nodemailer` in the server directory.');
    transporterPromise = Promise.resolve(null);
  }
  return transporterPromise;
}

async function sendMail({ to, subject, html, text }) {
  const transporter = await getTransporter();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@minicaai.com';

  if (!transporter) {
    console.warn('━'.repeat(60));
    console.warn('[email] SMTP not configured — message not sent.');
    console.warn(`        To:      ${to}`);
    console.warn(`        Subject: ${subject}`);
    if (text) console.warn(`        Body:    ${text}`);
    console.warn('━'.repeat(60));
    return { ok: false, reason: 'smtp_not_configured' };
  }

  try {
    const info = await transporter.sendMail({ from, to, subject, html, text });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error('[email] send failed:', err && err.message);
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

module.exports = { sendMail, renderPasswordResetEmail };
