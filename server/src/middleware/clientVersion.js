// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE SERVER AND THE FLEET ARE NOT THE SAME AGE.
//
//  This server updates in about ninety seconds. The installed fleet updates
//  over days — some of it never. Every change written as though both halves
//  ship together has broken production here, five times:
//
//    2026-07-18  a feed URL baked into shipped builds pointed at a repo
//                that did not exist; nobody could download or update
//    2026-07-29  a partial deploy left client and server disagreeing;
//                reverted 14 minutes in
//    2026-08-08  requireActiveSession answered 428 to clients with no
//                handling for it — a dead assistant mid-interview
//    2026-08-08  the cover model was called for clients that cannot render
//                an opener: ~1.2s of dead air per question, fleet-wide
//    2026-08-08  /google/poll demanded a handoff code the shipped client
//                does not send — Google sign-in impossible for everyone
//
//  Same bug every time. So the boundary gets a name and one implementation.
//
//  ── WHAT THIS IS FOR, AND WHAT IT IS NOT FOR ──
//
//  The header is SPOOFABLE. A caller can claim any version. That is fine
//  for the things this gates:
//
//    · a session gate — forging "old" buys the free ride that already
//      exists in production today, so it is no worse than the status quo,
//      and the gate exists to stop the ACCIDENTAL free ride (mic off), not
//      a hand-written request
//    · a cover opener — forging "old" means you get no opener. Self-harm.
//
//  It must NEVER gate a security control. Version-gating the OAuth handoff
//  code, for instance, would let an attacker downgrade themselves to the
//  weaker path by omitting a header — so that one uses an operator flag and
//  a same-address check instead. Gate availability and cost. Never auth.
//
//  ── ABSENT MEANS OLD ──
//
//  Nothing before 4.0.19 sends this header, and unparseable input is
//  treated the same as missing. Both resolve to "old", which means "do not
//  enforce". Failing the other way — treating an unrecognised client as
//  modern — is what turns a bad header into an outage.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** The header every current client sends. One spelling, one place. */
const CLIENT_VERSION_HEADER = 'x-app-version';

/**
 * First client generation that participates in the version-gated protocols
 * (session gate, LLM cover). Anything below is left alone entirely.
 *
 * ⚠️ The APP RELEASE must be >= this. Ship 4.0.18 with this set to 4.0.19
 * and every gate stays dormant forever — silently, because "not enforcing"
 * looks exactly like "working".
 */
const MIN_PROTOCOL_CLIENT = '4.0.19';

/**
 * "4.0.18" -> 4000018, so a plain numeric compare orders releases.
 * Returns null for anything unparseable; callers treat null as "old".
 *
 * ⚠️ Number.isNaN(undefined) is FALSE. A two-part version like "4.1"
 * destructures patch to undefined, slips past a Number.isNaN guard, and
 * poisons the sum to NaN — and `NaN < threshold` is also false, so such a
 * client would be classified MODERN and gated. That is the exact failure
 * this module exists to prevent, so: Number.isFinite, which rejects
 * undefined and NaN alike. Pinned in client-version.test.js.
 */
function versionRank(v) {
  const parts = String(v == null ? '' : v).trim().replace(/^v/i, '').split('.');
  if (parts.length < 2) return null;
  const [maj, min, patch] = parts.map((n) => parseInt(n, 10));
  if (!Number.isFinite(maj) || !Number.isFinite(min)) return null;
  return maj * 1e6 + min * 1e3 + (Number.isFinite(patch) ? patch : 0);
}

/**
 * Express middleware. Parses the header once per request and attaches:
 *   req.clientVersion   raw string or null
 *   req.clientRank      number or null
 *   req.clientAtLeast() (version) => boolean
 *
 * Mount it ABOVE any gate that reads it. Never throws — a malformed header
 * must not be able to 500 a request.
 */
function clientVersion(req, _res, next) {
  let raw = null;
  try {
    const h = req.headers && req.headers[CLIENT_VERSION_HEADER];
    raw = typeof h === 'string' ? h.slice(0, 32) : null;
  } catch { raw = null; }

  const rank = versionRank(raw);
  req.clientVersion = raw;
  req.clientRank = rank;
  req.clientAtLeast = (target) => {
    const want = versionRank(target);
    if (want === null) return false; // a bad threshold must not enforce
    return rank !== null && rank >= want;
  };
  next();
}

/**
 * Convenience for gates: is this caller new enough to take part in the
 * version-gated protocols at all? Works whether or not the middleware ran,
 * so a gate cannot be defeated by a missing mount.
 */
function participatesInProtocol(req) {
  if (typeof req.clientAtLeast === 'function') return req.clientAtLeast(MIN_PROTOCOL_CLIENT);
  const rank = versionRank(req.headers && req.headers[CLIENT_VERSION_HEADER]);
  const want = versionRank(MIN_PROTOCOL_CLIENT);
  return rank !== null && want !== null && rank >= want;
}

/**
 * First client generation the 428 session gate is ENFORCED for. Held one
 * release AHEAD of the shipping build on purpose (session-gate-client-compat
 * pins that), and moved ahead again on every cut until the gate is armed
 * deliberately — see the note on SESSION_GATE_MIN_CLIENT in routes/ai.js.
 *
 * 2026-09-06: 4.0.23 shipped as an urgent fix (Google sign-in, macOS
 * capture). Arming a paywall gate for the first time inside that same build
 * was not the moment, so the hold moved 4.0.23 → 4.0.24. Arm it on purpose,
 * in a release whose only job is to arm it. (4.0.24 shipped the same evening
 * as an urgent fix release; the hold moved on again, 4.0.24 -> 4.0.25, then 4.0.25 -> 4.0.26 for the
 * installer-only 4.0.25 cut.)
 */
const SESSION_GATE_MIN_CLIENT = '4.0.26';

/**
 * First client generation that stops its own usage clock when the machine
 * sleeps or the screen locks (creditTimerService power hooks, shipped in
 * 4.0.23). From here the full-gap settle cap in routes/usage.js applies: a
 * silent gap on a still-open session is interview time and is billed up to
 * the liveness window, because a client that sleeps closes its session first.
 *
 * Deliberately NOT the session-gate constant. The two used to be one value
 * "so they arm on the same release", which meant a release could not ship
 * the billing half without also arming the gate — and vice versa. They are
 * separate facts about a client and move separately.
 */
const USAGE_FULL_GAP_MIN_CLIENT = '4.0.23';

/**
 * Is this caller at least `minVersion`? Reads req.clientRank when the
 * middleware ran and the raw header otherwise, so a gate cannot be defeated
 * by a missing mount. Unparseable / absent / bad threshold → false, i.e. the
 * caller is treated as OLD — the direction every gate in this codebase fails.
 */
function clientAtLeast(req, minVersion) {
  const want = versionRank(minVersion);
  if (want === null) return false;
  const rank = typeof req?.clientRank === 'number'
    ? req.clientRank
    : versionRank(req?.headers && req.headers[CLIENT_VERSION_HEADER]);
  return rank !== null && rank >= want;
}

module.exports = {
  clientVersion,
  participatesInProtocol,
  clientAtLeast,
  versionRank,
  CLIENT_VERSION_HEADER,
  MIN_PROTOCOL_CLIENT,
  SESSION_GATE_MIN_CLIENT,
  USAGE_FULL_GAP_MIN_CLIENT,
};
