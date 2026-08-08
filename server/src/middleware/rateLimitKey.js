// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WHO ARE WE RATE LIMITING?
//
//  The general limiter used to count every request against the client's IP
//  address. That is correct for anonymous traffic and wrong for signed-in
//  traffic, because an IP is not a person: an office, a campus, a
//  coworking space or a corporate VPN puts every user behind one address,
//  so they share one bucket and starve each other. Measured cost of that:
//  a normal interview spends ~4 requests per question (pre-fetch, the
//  answer itself, and two conversation-sync writes) plus a usage heartbeat
//  every 20s — about 27 req/min at a normal pace and ~51 at a rapid-fire
//  one. Two colleagues on one router therefore sat at the 60/min ceiling
//  and a third pushed everyone over it. What gets refused is whatever
//  arrives next, which includes the answer request in a LIVE interview.
//
//  So: count signed-in requests against the user, anonymous requests
//  against the IP.
//
//  ── The signature MUST be verified ──
//  There is an older, weaker version of this idea further down index.js
//  for the AI limiter, which base64-decodes the JWT payload WITHOUT
//  checking the signature. That is survivable there only because every
//  /api/v1/ai/ route sits behind authMiddleware, so a forged token is
//  rejected a moment later and buys the attacker nothing.
//
//  It would NOT be survivable here. The general limiter is the outermost
//  guard on EVERY endpoint, including the unauthenticated ones. If it
//  trusted an unverified payload, anyone could send
//      Authorization: Bearer x.<base64 of {"id":"anything-1"}>.y
//  and rotate that id to mint unlimited buckets — defeating the brute
//  force protection on login, the reset-mail cap, and everything else.
//  jwt.verify() is an HMAC check costing microseconds; a forged, expired
//  or malformed token falls back to the IP bucket, which is exactly the
//  behaviour we want (no worse off than before per-user keying existed).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const { verifyToken } = require('./auth');

/**
 * Decide which bucket a request is counted against.
 *
 * @returns {{ key: string, ip: string, authenticated: boolean }}
 *   key           — bucket id: `u:<userId>` when the caller proved who they
 *                   are, otherwise the IP.
 *   ip            — always the raw IP, for the limiters that must stay
 *                   source-scoped (login brute force, reset-mail spam,
 *                   checkout abuse, anonymous support chat).
 *   authenticated — whether `key` is a verified user rather than an IP.
 */
function rateLimitIdentity(req) {
  const ip = (req && (req.ip || (req.connection && req.connection.remoteAddress))) || 'unknown';

  const auth = req && req.headers && req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) {
      try {
        // Full signature + expiry check. Throws on forged, tampered,
        // expired or malformed tokens — all of which fall through to IP.
        const decoded = verifyToken(token);
        if (decoded && decoded.id) {
          return { key: `u:${decoded.id}`, ip, authenticated: true };
        }
      } catch {
        // Deliberately silent: an expired token during a long interview is
        // routine, not an incident, and this runs on every request.
      }
    }
  }

  return { key: ip, ip, authenticated: false };
}

/**
 * The account a request is TRYING to act on, for endpoints where the
 * caller is not signed in yet — login, signup, forgot-password.
 *
 * Why this exists: those endpoints were protected by an IP bucket alone,
 * which is the wrong axis in both directions.
 *
 *   Too weak — there was no per-account counter anywhere in the codebase
 *   (no failed_attempts, no locked_until, nothing). An attacker with a
 *   pool of cheap IPs got a FRESH bucket per address against one target
 *   email, so a distributed brute force against a specific account was
 *   effectively unlimited. Counting per account closes that, because the
 *   account is the thing being attacked and it does not change when the
 *   attacker changes address.
 *
 *   Too strict — one office, campus or VPN is one IP, so a handful of
 *   colleagues signing in within the window locked everyone else out of
 *   their own accounts.
 *
 * So: a tight bucket on the account, a looser one on the address, and a
 * request has to satisfy both.
 *
 * Returns null when there is no usable email, in which case only the IP
 * bucket applies. That is not a bypass — a login with no email cannot
 * authenticate anyone.
 *
 * @returns {string|null} `a:<normalized email>` or null
 */
function rateLimitAccountKey(req) {
  const email = req && req.body && req.body.email;
  if (typeof email !== 'string') return null;
  // Must match how accounts are stored and looked up (database.js lowercases
  // on write), or "Alice@x.com" and "alice@x.com" would get separate buckets
  // and an attacker could double their attempts by changing capitalisation.
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.length > 254) return null;
  return `a:${normalized}`;
}

module.exports = { rateLimitIdentity, rateLimitAccountKey };
