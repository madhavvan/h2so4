// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RATE LIMITER BUCKETS
//
//  Every limiter in the app, in one place, with the axis it counts on and
//  why. Two rules run through all of it:
//
//    1. Count abuse on the thing being ABUSED, not on the address it came
//       from. For login that is the account; an attacker changes IP for
//       pennies and cannot change which account they are trying to break
//       into.
//    2. Count legitimate use per PERSON, not per address. An IP is an
//       office, a campus, a VPN, a phone tether — routinely dozens of
//       unrelated people who should not be able to lock each other out.
//
//  The old design used one axis (IP) for everything, which was
//  simultaneously too strict for the office and too weak for the attacker.
//  These are exported rather than defined inline so routes/auth.js can
//  clear a user's failure counter when they successfully sign in.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── Why RateLimiterMemory and not Redis ────────────────────────────────
// These counters live in this process and reset on every deploy. That is
// a deliberate fit, not an oversight: this service is single-instance by
// construction, and the limiters are the LEAST consequential thing that
// breaks if that ever changes. On a second replica you would also get
//
//   · SQLite on a Railway volume — volumes attach to one instance, so two
//     replicas means two divergent databases (or a failed mount)
//   · six setInterval sweeps in index.js running N times over — duplicate
//     reminder emails, duplicate cycle-end downgrades, N daily backups
//   · the WebSocket registries in services/remoteChannel.js and the
//     support socket map — a phone connected to replica A never sees an
//     event published from replica B, so device mirroring silently dies
//   · these buckets, with every limit effectively multiplied by N
//
// Swapping in RateLimiterRedis would fix the last item and leave the three
// above, which is worse than useless — it makes the setup look scalable
// while the real blockers are untouched. If this service ever genuinely
// needs to scale out, the database and the socket layer are the work; the
// limiters come along afterwards as the easy part.
//
// See docs/private/RUNBOOK.md § "Scaling and the single-instance rule".
const { RateLimiterMemory } = require('rate-limiter-flexible');

// ── General traffic ────────────────────────────────────────────────────
// ANONYMOUS, keyed by IP. For a caller who has not proved who they are the
// source address is the only identity available.
const generalLimiter = new RateLimiterMemory({ points: 60, duration: 60 });

// SIGNED-IN, keyed by verified user id. See middleware/rateLimitKey.js.
//   · A live interview costs ~4 requests per question (pre-fetch context,
//     the answer stream, two conversation-sync writes) plus a usage
//     heartbeat every 20s: ~27 req/min at a normal pace, ~51 rapid-fire.
//     A popout window or the phone companion adds more.
//   · 60/min left almost no headroom, and sat UNDER the limiter it fronts:
//     aiLimiter allows 90 AI calls/min/user but each also spends a general
//     point, so 90 was unreachable by construction.
//   · 180 gives ~3.5x headroom over the measured worst case and restores
//     aiLimiter as the binding constraint on inference spend.
// A backstop against a runaway client, not cost control.
const generalUserLimiter = new RateLimiterMemory({ points: 180, duration: 60 });

// ── Login ──────────────────────────────────────────────────────────────
// Per ACCOUNT. This is the brute-force protection, and before this it did
// not exist anywhere — there is no failed_attempts column, no lockout
// table, nothing. Protection was 10/5min/IP, so an attacker renting a
// hundred residential IPs had a hundred fresh buckets against one email
// and could grind ~1,000 guesses per 5 minutes unrecorded. Keyed on the
// account, that becomes 10 per 15 minutes no matter how many addresses
// they come from.
//
// Cleared on successful sign-in (see clearLoginAttempts), so a legitimate
// user reinstalling, switching devices or fat-fingering a password a few
// times never walks into it.
const loginAccountLimiter = new RateLimiterMemory({ points: 10, duration: 900 });

// Per IP, deliberately loose. Its job is no longer "stop guessing one
// password" (the account bucket does that) but "stop one source spraying
// many accounts". 10/5min locked out the 11th colleague on a shared
// office NAT trying to sign into their own account; 60 does not, while
// still capping a sprayer at 60 accounts per 5 minutes from one address.
const loginIpLimiter = new RateLimiterMemory({ points: 60, duration: 300 });

// ── Signup ─────────────────────────────────────────────────────────────
// IP only, and intentionally so: an attacker creating accounts uses a NEW
// email every time, so an account bucket would never see the same key
// twice and would protect nothing. Volume from a source is the only
// meaningful signal. Loosened 10 -> 20 so a team onboarding together on
// one office connection is not blocked halfway through.
const signupIpLimiter = new RateLimiterMemory({ points: 20, duration: 300 });

// ── Forgot password ────────────────────────────────────────────────────
// Per ACCOUNT. Each request sends a real email to a real person, so the
// abuse is mail-bombing one inbox — which the old 5/15min/IP did nothing
// to stop, since rotating IPs reset it. 3/hour per address makes the
// victim's inbox the limit rather than the attacker's IP budget.
const forgotAccountLimiter = new RateLimiterMemory({ points: 3, duration: 3600 });

// Per IP, loosened 5 -> 20/15min. Still caps a source enumerating many
// addresses, without five colleagues on one router exhausting the whole
// building's ability to reset a password.
const forgotIpLimiter = new RateLimiterMemory({ points: 20, duration: 900 });

// ── Checkout ───────────────────────────────────────────────────────────
// Per USER. Every hit creates a real Stripe/Razorpay artifact, so this
// exists to back-pressure scripted abuse before the provider's own
// account-wide ceilings. The caller is authenticated here, so the user is
// the correct axis — and two colleagues upgrading on the same office
// connection no longer contend.
const checkoutUserLimiter = new RateLimiterMemory({ points: 20, duration: 300 });

// Per IP backstop for the mass-account case (one attacker, many accounts,
// one machine). Loose enough to never bind on legitimate shared-office
// traffic; tight enough that automating provider artifacts needs real
// distribution, not just a signup loop.
const checkoutIpLimiter = new RateLimiterMemory({ points: 60, duration: 300 });

// ── Admin ──────────────────────────────────────────────────────────────
// Per ADMIN USER. Same reasoning as general traffic: two admins on the
// office VPN are one IP and were sharing a single browsing budget. The IP
// allowlist (ADMIN_IP_ALLOWLIST) is a separate control and unaffected.
const adminLimiter = new RateLimiterMemory({ points: 120, duration: 60 });
// Tight cap on state-mutating verbs, also per admin — enough for a burst
// of support actions, not enough for a compromised token to run thousands
// of refunds.
const adminDestructiveLimiter = new RateLimiterMemory({ points: 30, duration: 300 });

// ── AI ─────────────────────────────────────────────────────────────────
// Per USER. Each call is real money (Claude w/ web_search ~$0.05+), so a
// leaked token must not grind unbounded inference. 90/min ~ 1.5/sec
// sustained: breathing room for model switching, parallel chat-and-fresh-
// context calls and the Auto-Type planner sharing this bucket.
const aiLimiter = new RateLimiterMemory({ points: 90, duration: 60 });

// ── Support bot ────────────────────────────────────────────────────────
// IP, and it has to stay IP. The endpoint is genuinely anonymous — there
// is no account to key on, and the client-supplied sessionId is forgeable,
// so keying on it would be no limit at all. Two windows so an attacker can
// neither spike nor sustain. Accepted trade-off: a busy office shares
// these; support chat is low-frequency enough that it has not been a
// problem, and loosening it directly funds someone else's LLM bill.
const supportChatLimiter = new RateLimiterMemory({ points: 10, duration: 60 });
const supportChatHourly = new RateLimiterMemory({ points: 50, duration: 3600 });
// Each handoff fires Slack + Resend; stops a scripted form-spam loop from
// filling support@minicaai.com or paging the Slack channel.
const supportHandoffLimiter = new RateLimiterMemory({ points: 5, duration: 3600 });

/**
 * Forget a successful account's login failures.
 *
 * Without this the account bucket counts every ATTEMPT, so someone who
 * genuinely signs in ten times in fifteen minutes — reinstalling, moving
 * between laptop and popout, testing a build — would lock themselves out
 * of their own account with correct credentials. Clearing on success means
 * the bucket only ever accumulates unsuccessful attempts, which is the
 * thing we actually want to limit.
 *
 * Safe to call unconditionally; unknown keys are a no-op.
 */
async function clearLoginAttempts(email) {
  if (typeof email !== 'string') return;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return;
  try {
    await loginAccountLimiter.delete(`a:${normalized}`);
  } catch {
    // Never let bookkeeping fail a successful login.
  }
}

module.exports = {
  generalLimiter,
  generalUserLimiter,
  loginAccountLimiter,
  loginIpLimiter,
  signupIpLimiter,
  forgotAccountLimiter,
  forgotIpLimiter,
  checkoutUserLimiter,
  checkoutIpLimiter,
  adminLimiter,
  adminDestructiveLimiter,
  aiLimiter,
  supportChatLimiter,
  supportChatHourly,
  supportHandoffLimiter,
  clearLoginAttempts,
};
