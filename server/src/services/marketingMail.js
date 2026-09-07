// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MAIL TO THE WHOLE USER BASE — the rail promotions will ride on.
//
//  Today it sends one message: the welcome mail on account creation (both
//  the password signup and the two Google new-user paths in routes/auth.js).
//  That mail states the consent basis for later product updates and offers
//  and carries the signed unsubscribe link; the opt-out lands in
//  users.marketing_opt_out and db.getMarketingRecipients() honours it.
//  A campaign sender, when it comes, is a loop over that list — nothing
//  else is missing.
//
//  Transactional mail (receipts, password resets, security notices) does
//  NOT go through here and is never gated by the opt-out.
//
//  The unsubscribe token is an HMAC of the user id under JWT_SECRET:
//  unguessable, stateless, no expiry — the link in a mail opened next year
//  has to work. Rotating JWT_SECRET invalidates old links (the page then
//  says so and names support).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const crypto = require('node:crypto');
const email = require('../email');

// Mirrors middleware/auth.js, which has already refused to start in
// production without JWT_SECRET by the time this module loads.
const SECRET = process.env.JWT_SECRET
  || (process.env.NODE_ENV === 'production' ? null : 'minicaai-dev-secret-change-in-production');

function unsubscribeToken(userId) {
  return crypto.createHmac('sha256', String(SECRET || '')).update(`unsubscribe:${userId}`).digest('hex').slice(0, 32);
}

function verifyUnsubscribeToken(userId, token) {
  if (!userId || typeof token !== 'string' || !token) return false;
  const want = Buffer.from(unsubscribeToken(userId));
  const got = Buffer.from(token);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function publicBase(req) {
  const fromEnv = process.env.SERVER_URL;
  const fromReq = req && typeof req.get === 'function' ? `${req.protocol}://${req.get('host')}` : '';
  return String(fromEnv || fromReq || 'https://api.minicaai.com').replace(/\/+$/, '');
}

function unsubscribeUrl(req, userId) {
  return `${publicBase(req)}/api/v1/auth/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubscribeToken(userId)}`;
}

function transportConfigured() {
  return Boolean(process.env.RESEND_API_KEY || process.env.SMTP_HOST);
}

let _send = (args) => email.sendMail(args);

/**
 * Fire-and-forget. Resolves to the sendMail result (or a skip reason);
 * never rejects, never throws — a mail outage must never fail a signup.
 */
function sendWelcomeMail({ user, req, via }) {
  try {
    if (!user || !user.email || !user.id) return Promise.resolve({ ok: false, reason: 'no_user' });
    if (!transportConfigured()) {
      console.log(`[welcome-mail] via=${via} user=${user.id} skipped: no mail transport configured`);
      return Promise.resolve({ ok: false, reason: 'no_transport_configured' });
    }
    // Only a real https origin is trusted for the link a customer clicks;
    // a localhost or blank FRONTEND_URL falls back to the public site.
    const fe = String(process.env.FRONTEND_URL || '').trim();
    const signInUrl = (/^https:\/\/(?!localhost|127\.)/i.test(fe) ? fe : 'https://minicaai.com').replace(/\/+$/, '');
    const { subject, html, text } = email.renderWelcomeEmail({
      name: user.name,
      signInUrl,
      unsubscribeUrl: unsubscribeUrl(req, user.id),
    });
    return Promise.resolve(_send({ to: user.email, subject, html, text, replyTo: 'support@minicaai.com' }))
      .then((r) => {
        const ok = Boolean(r && r.ok);
        console.log(`[welcome-mail] via=${via} user=${user.id} ok=${ok}${ok ? '' : ` reason=${r && r.reason}`}`);
        return r || { ok: false, reason: 'no_result' };
      })
      .catch((err) => {
        console.error(`[welcome-mail] via=${via} user=${user.id} threw:`, err && err.message);
        return { ok: false, reason: 'threw' };
      });
  } catch (err) {
    console.error('[welcome-mail] render failed:', err && err.message);
    return Promise.resolve({ ok: false, reason: 'render_failed' });
  }
}

module.exports = {
  sendWelcomeMail,
  unsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeUrl,
  _test: {
    setSendMail(fn) { _send = fn || ((args) => email.sendMail(args)); },
  },
};
