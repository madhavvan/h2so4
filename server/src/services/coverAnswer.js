// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  COVER ANSWER — instant spoken opener for deep questions
//
//  Problem: when a question is deep enough to deserve reasoning
//  (auto-effort 'low', or a user-picked medium/high), the main model's
//  first token lands 2.5-10s after the question. In a live interview
//  that is dead air — the candidate sits silent exactly when the
//  interviewer expects them to start talking.
//
//  Fix: before the main model call goes out, the route first streams a
//  COVER — the natural spoken words a senior candidate would open with
//  ("If that's the constraint, the first thing I'd reach for is...") —
//  from the fastest model available. The candidate starts SPEAKING the
//  cover while the main model frames the full answer; the main call
//  receives the cover verbatim with a continuation instruction, so its
//  output picks up exactly where the cover stops — one seamless answer,
//  no repetition.
//
//  HOW LONG THE COVER IS, IS NOT A STYLE CHOICE. Speech runs ~2.3
//  words/sec, so the cover has to last until the main answer reaches the
//  candidate: words_needed = (gap - cover_ttft) × 2.3. The gap is not one
//  number — measured, it ranges from 0.7s (Gemini at MINIMAL) to 32s
//  (grok-4.5 on a system-design question). A fixed 12-30 words is both
//  wasteful at one end and eleven seconds short at the other. So the
//  route predicts the gap and picks a TIER: no cover at all / opener /
//  bridge / holding answer. See predictMainTtftMs and COVER_TIERS below.
//
//  RESILIENCE: the cover MUST NOT depend on a single provider. Fast
//  first, paid last —
//    1. Groq llama-3.3-70b-versatile  (~330ms first token, non-reasoning,
//       separate quota from the interview models)         [FREE TIER]
//    2. Gemini 3.6 Flash @ thinkingLevel MINIMAL (~600-700ms) [FREE TIER]
//    3. Claude Haiku 4.5 — fast, and PAID                  [BACKSTOP]
//  The third link was added after both free tiers returned 429 on the
//  same day and the cover silently stopped happening: the answer still
//  arrived, seconds later, with the candidate sitting in silence. Two
//  free quotas are one bad afternoon away from being no quota, and a
//  live interview is the worst possible moment to find that out.
//  If a provider fails before delivering ANY token, the next is tried.
//  Once tokens have streamed to the user, we commit to that provider.
//  All providers failing → return '' and the route proceeds exactly as
//  before (main answer only). The feature can only ADD perceived speed,
//  never break or delay an answer past its normal path.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// If a provider's FIRST token hasn't arrived by this deadline, abort it
// and try the next: a late cover is worse than none (the main model
// would beat it and the continuation instruction would reference text
// the user never saw).
const FIRST_TOKEN_DEADLINE_MS = 1500;
// Hard wall for a single provider's whole cover generation.
const TOTAL_DEADLINE_MS = 2800;
// The LAST provider in the chain gets longer, because nothing follows it
// and the alternative is no cover at all. See the loop in
// streamCoverAnswer for why this is not just a bigger number everywhere.
const LAST_PROVIDER_DEADLINE_MS = 2600;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WHY THE PROVIDERS RACE INSTEAD OF QUEUEING
//
//  The chain used to be strictly serial: try Groq, and only if it
//  produced NOTHING try Gemini, and only then the paid backstop. That
//  reads as prudent and it is arithmetically impossible.
//
//  The chain has ONE budget, sized from the predicted gap, because the
//  main model call is issued only after the cover returns — every
//  millisecond here is a millisecond of the real answer's latency. For
//  the opener tier (which is what fires for the app's default model on
//  an ordinary question) that budget is 1,200ms. A single provider's
//  first-token deadline is 1,500ms. So provider one is handed MORE than
//  the whole budget, and the loop's next iteration hits
//  `remaining() <= 200` and breaks. Measured in the running app:
//
//    [cover] NO COVER — tier=opener 1/3 provider(s) tried in 1210ms
//            (budget 1200ms): no first token within 1200ms
//
//  One of three. The two fallbacks — including the PAID backstop added
//  precisely for the day the free tiers are down — were unreachable on
//  every tier, and a Groq that merely hangs (rather than failing fast)
//  took the whole feature down with it. That is exactly what happened on
//  the question "on what platforms did you work?": no cover, and the
//  candidate sat in silence for twenty-five seconds.
//
//  Racing fixes it without touching the budget, because the budget was
//  never the problem — the SERIAL chain was. Total latency becomes the
//  FASTEST provider's first token instead of the SUM of everyone's
//  timeouts, so all three fit inside 1,200ms comfortably.
//
//  Hedged, not simultaneous: provider one starts alone, and the next
//  only joins if the first has not spoken by HEDGE_STAGGER_MS. Groq's
//  measured first token is 216-283ms, so on the normal path the hedges
//  never fire and the cost is exactly what it was before. They fire when
//  the primary is slow or rate-limited — which is the only time we
//  wanted them anyway.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const HEDGE_STAGGER_MS = 250;

// A hedge does not have to wait out its stagger if the provider ahead of
// it has ALREADY given up. Groq returns a 429 in 150-300ms, and sitting
// on a timer for the rest of the stagger after that is the serial chain's
// wasted time creeping back in through the side door.
//
// Measured before this: groq 429'd, gemini launched at 350ms and got
// 840ms, the backstop launched at 700ms and got 499ms — not enough, and
// the run produced no cover at all.
const HEDGE_ON_FAILURE = true;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  A CLAIM IS NOT A COVER
//
//  Claiming the race on a FIRST TOKEN is what keeps the hedges — and the
//  paid backstop — from firing on every ordinary run. But a first token
//  is not output: the emitter withholds everything until a finished
//  sentence clears MIN_FLUSH_WORDS, so a provider that yields one token
//  and then wedges returns "". Measured, with a healthy alternative
//  sitting one stagger behind it:
//
//    [cover] NO COVER — tier=opener 1/2 provider(s) raced in 1238ms
//            (budget 1200ms): stallerP0: produced nothing
//
//  One of two. The claim was permanent, so the healthy hedge read it at
//  its 250ms stagger, decided it was not needed and never launched —
//  the single point of failure the hedged race exists to remove, back
//  again through the gate that protects it.
//
//  So the claim now LAPSES. Tokens arrive every ~11ms at the 90 tok/s
//  these models sustain, which makes a quarter-second of silence before
//  the first sentence lands not slow but stopped, and the hedges are let
//  back in. Being wrong is cheap by construction: a lapse does not abort
//  the claimant, which keeps streaming and can still take the screen at
//  its first flush, so a provider that merely stuttered loses nothing
//  but the cost of one hedge that need not have run.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const CLAIM_STALL_MS = 250;

// When the backstop is the ONLY remaining hope, it gets at least this
// long for its first token even if the chain budget is nearly spent.
//
// This is a deliberate, bounded overrun of a budget that exists to stop
// WASTED delay — and once every other provider has failed, the trade
// inverts. Holding the last provider to the 499ms that happened to be
// left buys a guaranteed silence; giving it 900ms buys a real chance at
// a cover that lands well before the main answer's own 1.4-2.1s. The
// overrun is capped by construction: it applies to one provider, only
// when it is last, and only when everything before it has already failed.
const LAST_PROVIDER_FLOOR_MS = 900;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  A DEADLINE ON GENERATION IS NOT A DEADLINE ON THE FIRST TOKEN
//
//  runOne used to be given ONE number for both, clamped by whatever was
//  left of the chain budget. So a provider whose first token arrived at
//  1,038ms of a 1,200ms budget had 162ms to produce seventeen words —
//  and `runOne` keeps whatever streamed before an abort. Measured, on
//  the user's own resume:
//
//    "So the"
//    "I'm looking"
//    "Yeah, I've run pipeline workloads on Kubernetes with Azure DevOps CI/CD at"
//
//  Three of twelve. Those are not covers, they are the app instructing
//  the candidate to say "So the" out loud to an interviewer and stop.
//
//  The two clocks measure different risks. A late FIRST token means the
//  main model will beat us to the screen and the cover is pointless —
//  that deadline must stay tight and must stay inside the chain budget.
//  But once the first token lands we are committed: the words are on
//  screen, the candidate is already speaking them, and cutting the
//  sentence off is strictly worse than the extra 200ms it costs to
//  finish. So generation gets its own window, sized from the tier's
//  token budget, and it is NOT clamped by what remains of the chain.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Slowest observed sustained rate across the three cover models
// (llama-3.3-70b, gemini-3.6-flash MINIMAL, haiku-4.5) is ~90 tok/s;
// 12ms per token is that with room to spare.
const MS_PER_COVER_TOKEN = 12;
const MIN_GENERATION_MS = 900;
const MAX_GENERATION_MS = 6000;
function generationWindowMs(plan) {
  const want = (plan && plan.maxTokens ? plan.maxTokens : 90) * MS_PER_COVER_TOKEN;
  return clamp(want, MIN_GENERATION_MS, MAX_GENERATION_MS);
}

// Nothing reaches the user until the cover has at least this many words.
// Cheap on the normal path — six words arrive within ~30ms of the first
// on every provider in the chain — and it is what makes a two-word
// fragment impossible to speak rather than merely unlikely.
const MIN_FLUSH_WORDS = 6;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  HOW LONG IS THE SILENCE? — the number every other decision hangs on
//
//  The cover exists to fill exactly one interval: question lands → main
//  model's first word. That interval was never measured across the
//  fleet, so the cover was a fixed 12-30 words for every question on
//  every model — one length for gaps that actually range from 0.7s to
//  32s. Two failures fall straight out of that:
//
//    • A 25-word opener is ~11 seconds of speech (2.3 words/sec). On a
//      20-second gap the candidate finishes it and sits in silence for
//      the remaining nine — the very thing this feature exists to stop.
//    • On a 0.7s gap the cover is pure cost and pure delay: the main
//      answer would have arrived first anyway.
//
//  MEASURED TWICE, AND THE SECOND MEASUREMENT IS THE ONE THAT COUNTS.
//
//  scripts/ttft-matrix.mjs times each provider directly with a ~5K-token
//  system prompt. scripts/audit-gap-inapp.mjs times the SAME question
//  through this app's real route, carrying the real rules block (7,074
//  tokens on its own) plus the identity layer, the retrieved evidence
//  and the history. They do not agree, and the disagreement is the whole
//  point — a depth model calibrated on the bench under-predicts the
//  silence and suppresses the cover exactly where it is needed:
//
//    route            bench          IN-APP (median of 3)
//    gemini shallow   0.7s           0.7s
//    gemini deep      4.1s           2.5s   (max 4.1)
//    gpt-5.6 shallow  1.2-2.6s       1.0s
//    gpt-5.6 deep     2.2s @low      3.0s   (max 3.9)
//    grok-4.5 shallow 1.8s           9.7s   ← 5× the bench figure
//    grok-4.5 deep    18-32s         20.4s  (max 42.4)
//    groq shallow     n/a            24.3s
//    groq deep        n/a            54.2s  ← fifty-four seconds
//
//  grok-4.5 is what forced this work: it fired no cover at all, and its
//  shallow number is not 1.8s in the product, it is nearly ten seconds.
//  groq is worse still — gpt-oss-120b is a reasoning model on a small
//  free-tier bucket and a deep question takes the better part of a
//  minute to produce its first token.
//
//  Numbers below are the IN-APP medians, rounded toward the slow side.
//  The asymmetry is deliberate: over-predicting gives the candidate more
//  to say than they need, and a person with too much to say can simply
//  stop talking. Under-predicting leaves them silent mid-answer, which
//  is the failure this whole file exists to prevent.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function staticTtftMs({ provider, deep = false, effort = 'none', webSearch = false } = {}) {
  switch (provider) {
    case 'openai': {
      // effort=high is the bench figure (9.2s deep) — the in-app runs
      // used auto, which resolves deep questions to 'low'.
      const byEffort = { none: 1400, low: 3000, medium: 4500, high: 9200 };
      const base = byEffort[effort] != null ? byEffort[effort] : 1400;
      // A deep question costs more even at effort 'none' (longer prefill,
      // more to plan before the first token).
      return deep && (effort === 'none' || effort === 'low') ? Math.max(base, 3000) : base;
    }
    // Sonnet 5 is consistently ~1.2s — until web_search fires, and then
    // the first token waits on a live search round-trip (12-25s observed
    // for a full search). `webSearch` here must mean "this question will
    // probably trigger a search", NOT "search is switched on": the tool
    // is enabled for every Claude request, so the latter would predict a
    // long silence for every behavioral question in the product and put
    // a 110-word holding answer in front of a 1.2s reply. The route
    // narrows it with the fresh-context classifier — see runCover.
    // 1.6s shallow / 2.1s deep measured as PAINTED first character in the
    // running app — the raw-route figure of 1.2s sat exactly on the
    // no-cover floor and suppressed the opener on a gap that is really
    // two seconds. First word now lands at ~0.6s instead of ~2s, and the
    // ~0.5s the chain costs is spent on a wait that was happening anyway.
    case 'claude': return webSearch ? 9000 : 1800;
    // The extreme, and the reason the in-app measurement exists: the
    // bench says 1.8s on a behavioral question, the product says 9.7s.
    case 'xai':    return deep ? 20000 : 9000;
    case 'gemini': return deep ? 3500 : 800;
    // gpt-oss-120b reasoning on an 8,000 TPM bucket. 24s and 54s are not
    // typos — see the TPM note in routes/ai.js for why this route was
    // returning 413 instead of answering slowly, which hid this.
    case 'groq':   return deep ? 50000 : 20000;
    default:       return 2500;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE TABLE ABOVE IS A MEMORY OF ONE AFTERNOON
//
//  Every number in it was measured on 2026-07-25 and then frozen. That
//  is fine for the shape of the fleet — grok really is an order of
//  magnitude slower than gemini — and useless for the thing that
//  actually hurts a candidate, which is a model having a bad minute.
//
//  Real event, from the user's own session: "okay, on what platforms
//  did you work?" on gpt-5.6 at effort none. The table says 1,400ms and
//  plans a 12-30 word opener. The answer took TWENTY-FIVE SECONDS. Even
//  a perfect opener is ~13 seconds of speech; the candidate would have
//  run dry with twelve seconds still to fill. Nothing in the system
//  could notice, because nothing in the system was looking.
//
//  So the routes now report what the main model ACTUALLY did, and the
//  prediction is the larger of the table and recent reality. Design
//  notes, in order of how much trouble each one avoids:
//
//   • EWMA, not last-value. One slow request should lengthen the next
//     cover, not pin every cover to the worst second of the day.
//   • Capped at OBSERVED_MAX_MULTIPLE × the table. A provider that
//     hangs for two minutes must not talk us into a 150-word holding
//     answer in front of a question that will come back in a second.
//   • max(), never min(). Observation can only ever make the cover
//     LONGER. If measurement is wrong we are back to the old behaviour,
//     which is a known quantity; a prediction that could shrink below
//     the calibrated floor is a new way to leave someone silent.
//   • Keyed by route AND depth AND effort, because those are the things
//     that actually move the number, and shared process-wide because
//     provider health is not a per-user property.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const OBSERVED_ALPHA = 0.35;
const OBSERVED_MAX_MULTIPLE = 4;
const observedTtft = new Map();

function ttftKey({ provider, deep = false, effort = 'none', webSearch = false } = {}) {
  return `${provider}|${deep ? 'deep' : 'shallow'}|${effort}|${webSearch ? 'search' : 'nosearch'}`;
}

// Called by the routes with the main model's own time to first token —
// measured from the moment its call was ISSUED, so the cover chain in
// front of it is not counted twice.
function recordMainTtftMs(args, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const base = staticTtftMs(args);
  const sample = Math.min(ms, base * OBSERVED_MAX_MULTIPLE);
  const key = ttftKey(args);
  const prev = observedTtft.get(key);
  observedTtft.set(key, prev == null ? sample : prev + OBSERVED_ALPHA * (sample - prev));
}

function predictMainTtftMs(args) {
  const base = staticTtftMs(args);
  const seen = observedTtft.get(ttftKey(args));
  return seen != null ? Math.max(base, Math.round(seen)) : base;
}

// Test/diagnostic surface — lets a test prove the blend without waiting
// on a real provider, and lets one test's samples not leak into another.
function _resetObservedTtft() { observedTtft.clear(); }
function _observedTtft() { return Object.fromEntries(observedTtft); }

// A candidate reading aloud averages ~2.3 words/sec. This is the whole
// arithmetic of the feature: words_needed = (gap - cover_ttft) × 2.3.
const SPOKEN_WORDS_PER_SEC = 2.3;

// ── The three shapes a cover can take ──
//
// Not three lengths of the same thing — three different jobs:
//
//  opener   the gap is short. One or two sentences of framing is all the
//           candidate needs before the real answer is under them.
//  bridge   the gap is mid. Framing plus the one factor that most
//           decides the answer — still pre-solution, still safe.
//  holding  the gap is long enough (8s+, up to 32s on grok) that an
//           "opener" is not the right object at all. The candidate needs
//           genuinely useful material to speak for half a minute. This
//           is the "contextual general answer" that holds the floor
//           until the deep answer is ready.
//
// Every tier keeps the ESTABLISH-FIRST rule that stopped openers being
// walked back (see COVER_SYSTEM). Length grows; commitment does not.
const COVER_TIERS = [
  { name: 'opener',  minWords: 12, maxWords: 30,  maxTokens: 90,  chainBudgetMs: 1200, totalDeadlineMs: 2000 },
  { name: 'bridge',  minWords: 30, maxWords: 60,  maxTokens: 190, chainBudgetMs: 2000, totalDeadlineMs: 2800 },
  { name: 'holding', minWords: 60, maxWords: 110, maxTokens: 420, chainBudgetMs: 3000, totalDeadlineMs: 4500 },
];

// Below this predicted gap, DO NOT fire a cover at all — racing a model
// that is already fast wins nothing and costs the main answer real
// milliseconds. The feature must only ever ADD perceived speed.
//
// ── WHY 2,500 AND NOT 1,200 ──
// The old floor was set from the cover's BEST case: "the cover's own
// fastest provider needs 0.22-0.28s". Measured across all five routes on
// 2026-08-06, fifteen real covers, the cover's own first token actually
// lands at 327 / 401 / 465 / 516 / 545 / 697 / 719 / 750 / 787 / 930 /
// 1109 / 1212 / 1384 / 1545 / 1946 ms — median ~750ms, and the slow half
// runs past a second. A 1,200ms floor therefore fired covers into gaps
// the cover itself could not beat.
//
// Claude is what this looked like in the field: predicted gap 1,800ms,
// cover fired, and the measured result was first word at 1,664ms WITH the
// cover against 1,151ms WITHOUT it. The cover made the app HALF A SECOND
// SLOWER and displaced the main model's own opening sentence to do it.
//
// 2,500ms is the smallest gap a ~750ms cover still meaningfully improves:
// it buys ~1.7s of speech before the answer lands. Below that the honest
// answer is that the route is fast enough to speak for itself.
//
// Effect on the fleet, from the same measurements: claude (gap ~1,800ms)
// now correctly fires NOTHING; openai (~4,500ms), gemini (~3,500ms), xai
// (9,000-20,000ms) and groq (20,000-50,000ms) are unaffected — and those
// last two are where the cover is worth 18-27 SECONDS of silence.
const COVER_FLOOR_MS = 2500;
const BRIDGE_FROM_MS = 4000;
// Raised from 8,000 once grok's real shallow number came in at 9.7s: a
// ten-second gap needs ~22 words, which is a bridge, not a 60-word
// holding answer. The holding tier is for gaps a bridge cannot reach.
const HOLDING_FROM_MS = 13000;

// How long before the candidate can start speaking — the cover's own
// first token. 216-283ms measured on Groq llama-3.3-70b; 400 is the
// conservative read, and it only ever makes the budget slightly larger.
const COVER_TTFT_ALLOWANCE_MS = 400;
// Nobody should be asked to speak for longer than this off an opener.
// Past it the honest answer is that the route is too slow, not that the
// cover should be an essay — see the log line in streamCoverAnswer.
const HOLDING_MAX_WORDS = 150;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PROVIDER COOLDOWN — stop paying latency for a provider that has
//  already told us it is out of quota.
//
//  Measured in the running app on 2026-08-06, with both free tiers
//  exhausted:
//
//    [cover] NO COVER — 3/3 provider(s) raced in 1501ms (budget 1200ms):
//      groq: 429 Rate limit reached … / gemini: 429 You exceeded your
//      current quota … / haiku: no first token within 900ms
//
//  Every request paid ~1.5s to re-discover the same two 429s, and the
//  main model's call is queued BEHIND that (routes/ai.js awaits the cover
//  before it calls OpenAI), so a dead cover was the single largest source
//  of the latency the feature exists to remove. Worse, the paid backstop
//  inherited whatever scraps of budget were left — it was starved in
//  precisely the run that needed it.
//
//  A 429 is not a blip. It means a quota WINDOW: Groq's per-minute token
//  bucket, Gemini's daily request cap. Retrying inside that window is
//  guaranteed to fail, so the honest move is to stop asking. One minute
//  is short enough that a per-minute bucket refills and the provider
//  comes straight back, and long enough that an exhausted daily quota is
//  only re-tested about once a minute instead of on every question.
//
//  Two things fall out of this for free:
//    1. When the free tiers are down, they are skipped rather than tried,
//       so the PAID backstop starts at index 0 — it gets the full budget
//       and the first-provider deadline instead of the last-provider
//       floor. Insurance that actually pays out.
//    2. When ALL providers are cooling, the cover is skipped entirely and
//       adds exactly ZERO milliseconds, instead of 1.2-3s of certain
//       failure in front of every answer.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const PROVIDER_COOLDOWN_MS = 60_000;
const providerCooldown = new Map();

// Only quota/rate-limit answers earn a cooldown. A timeout means the
// provider was SLOW, which the deadline already handles and which the
// next question may not see; benching it for a minute over one slow call
// would take a healthy provider out of the race for no reason.
function isQuotaFailure(reason) {
  return /\b429\b|rate.?limit|quota|too many requests|resource.?exhausted|overloaded/i.test(String(reason || ''));
}

function noteProviderFailure(name, reason) {
  if (!name || !isQuotaFailure(reason)) return;
  providerCooldown.set(name, Date.now() + PROVIDER_COOLDOWN_MS);
}

function providerRecovered(name) {
  if (name) providerCooldown.delete(name);
}

/** False while a provider is serving a cooldown for a quota failure. */
function providerReady(name) {
  const until = providerCooldown.get(name);
  if (!until) return true;
  if (Date.now() >= until) { providerCooldown.delete(name); return true; }
  return false;
}

function _resetProviderCooldowns() { providerCooldown.clear(); }
function _providerCooldowns() {
  return Object.fromEntries([...providerCooldown.entries()].map(([k, v]) => [k, Math.max(0, v - Date.now())]));
}

// Pick the cover plan for a predicted gap. Returns null when the main
// model is fast enough that no cover should be spent.
//
// The first two tiers are fixed because their gaps are narrow. The
// holding tier is NOT: its gaps run from 13s to the 54s measured on
// groq's deep path, and one fixed word budget cannot serve both. 110
// words is 48 seconds of speech — comfortable at 20s, six seconds short
// at 54s, and six seconds short is the candidate standing there in
// silence with the interviewer waiting. So the holding budget is
// computed from the gap by the same arithmetic the whole feature rests
// on: words = (gap - cover_ttft) × words_per_second.
function planCover(gapMs) {
  if (!(gapMs > COVER_FLOOR_MS)) return null;
  if (gapMs < BRIDGE_FROM_MS) return COVER_TIERS[0];
  if (gapMs < HOLDING_FROM_MS) return COVER_TIERS[1];

  const base = COVER_TIERS[2];
  const needed = Math.ceil(((gapMs - COVER_TTFT_ALLOWANCE_MS) / 1000) * SPOKEN_WORDS_PER_SEC);
  const minWords = clamp(needed, base.minWords, HOLDING_MAX_WORDS - 30);
  const maxWords = clamp(Math.round(needed * 1.35), minWords + 25, HOLDING_MAX_WORDS);
  return {
    ...base,
    minWords,
    maxWords,
    // ~1.4 tokens per English word, plus room for the model to finish a
    // sentence rather than be cut off mid-word — spoken aloud, a
    // truncated cover is worse than a short one.
    maxTokens: Math.max(base.maxTokens, Math.round(maxWords * 2.2)),
  };
}

// Convenience for the routes: predict, then plan, in one call.
function planCoverFor(args) {
  const gapMs = predictMainTtftMs(args);
  return { gapMs, plan: planCover(gapMs) };
}

const COVER_SYSTEM = `You produce ONLY what a strong senior candidate says out loud immediately after hearing an interview question — a natural, confident opening that holds the floor WITHOUT delivering the full answer.

Rules:
- Sound like a real person mid-conversation: plain words, first person.
- Start ANSWERING from the first word. Never stall, and never say "great
  question", "interesting", "let me think", "that's a good one".
- The LENGTH BUDGET in the user turn is BINDING. It is not a suggestion
  and not a minimum to beat: it is set from how long the candidate has to
  keep talking before the full answer reaches them. Under it they run out
  of words mid-silence; over it they are still talking when the real
  answer is waiting. Land inside it, then stop.
- Do not use markdown, headings, bullets or numbered lists — every word
  of this is SPOKEN. If you have two or three things to say, say them the
  way a person does out loud ("...and the other half of it is...").
- Do not deliver the WORKED solution — no step lists, no full design, no
  final recommendation with its reasoning. That is the full answer's job
  and it is seconds behind you.
  This is NOT licence to be vague: say the one true, load-bearing thing
  and stop. A short real answer, not a long empty one.
- Output the spoken words only — no quotes, no meta, no preamble.

CRITICAL — GROUND EVERY SPECIFIC IN THE CANDIDATE BACKGROUND PROVIDED.
When a "CANDIDATE BACKGROUND" section appears below, that is the only
thing you know about this person, and it is TRUE. When the question is
about them, answer it FROM that section — name the real employer, the
real system, the real domain —
and do not describe how you would go about answering.
"I'd look at where I've spent most of my time" is a failure: it is a
sentence about answering, not an answer.

⚠️ NO HOUSE PHRASE. THE FIRST WORDS MUST COME FROM THE QUESTION.
Do not open with a summary of their career unless the career is what was
asked about. An opening that could be pasted in front of any answer is
not an opening, it is filler with facts in it — and whatever follows it
reads as a collision: a career summary welded by a comma onto "my
favourite project is <THEIR PROJECT>" is two answers at once, and the
interviewer hears both. Asked which platforms, name platforms. Asked
about a project, start on that project. Asked what you know about a
topic, start on the topic. There is no standard opening sentence here
and no preferred phrasing to reach for — vary with the question, every
time.

THREE KINDS OF QUESTION, THREE KINDS OF OPENING. Decide which one you
were asked before you write a word.

1. ABOUT THEM — their experience, background, what they have worked on
   or used, a time they did something.
   Open on the exact specific the question asked for, taken from the
   background. This is the only place the employment history belongs.

2. A PROBLEM TO SOLVE — a scenario, a failure to diagnose, a design, an
   algorithm. Say THE ONE THING THAT IS ALREADY TRUE ABOUT THIS PROBLEM —
   the judgement a senior engineer can make the instant they hear it,
   before anyone has looked at anything. That is a real answer, and it is
   what you are here to produce.

   It is one of these three, whichever the question invites:
   - THE CONSTRAINT that decides the whole answer — the thing that is or
     is not achievable given what they just described, and why.
   - THE DISTINCTION the question turns on — two things being conflated,
     separated in one sentence.
   - THE REFRAME — what kind of problem this actually is, when the
     framing in the question is the wrong one.

   Illustrations of the SHAPE only. Never reuse this wording; the words
   must come from THEIR question:
   - a guarantee being asked for at a boundary that cannot enforce it →
     name that it cannot, and what can be done instead
   - a success signal being read as a correctness signal → separate them
   - a number quoted as if it were one thing when it could be three →
     say which three, because they do not mean the same thing

   ⚠️ THIS IS NOT A GUESS AT THE CAUSE. Never name the culprit, the
   mechanism, or the fix — "it's the partitioning", "I'd use exactly-once
   semantics", "I'd start with the data model". Those CAN be wrong, and
   the reasoning model behind you will contradict them one sentence
   later, out loud, mid-answer.
   The difference: a CAUSE is a claim about this specific system, which
   you have not seen. A CONSTRAINT, a DISTINCTION or a REFRAME is a claim
   about the problem AS STATED, which you have just heard in full. The
   first can be contradicted. The second cannot.

   ⚠️ AND IT IS NOT A DESCRIPTION OF YOUR PROCESS. "I'd verify the
   current metrics", "I'd want to confirm what's happening", "I'd
   establish a baseline first", "I'd look at the architecture" — these
   are the single most common failure here. They are true of every
   question ever asked, they commit to nothing, and they tell the
   interviewer nothing. Anyone can say them without understanding the
   question. If your sentence would still make sense pasted under a
   completely different question, it is filler — delete it and say the
   thing that is actually true about THIS one.

   Never assume their stack. If the question did not name a technology,
   do not introduce one from the background — the tool they use is not
   necessarily the tool in the question. And never open a problem
   question with their employment history: they were asked about a
   problem, not about themselves.

3. A KNOWLEDGE QUESTION — "what is X", "what do you know about X",
   "explain X", "how does X work", "the difference between X and Y".
   Nothing is being diagnosed and nothing is being asked about their CV,
   so BOTH of the openings above are wrong here. Say the true, useful
   first thing about X — the one-line definition, the distinction that
   matters, the trade-off it exists to resolve — and let the full answer
   go deeper.
   - NOT "First thing I'd establish is what X means" — the interviewer
     asked what X means; defining the act of defining is a stall, and a
     stall is the one thing this must never be.
   - NOT their employment history. Their experience with X may follow
     naturally, but the topic comes first, because the topic is the
     question.

Never go beyond it. A specific you invented is spoken out loud and then
has to be retracted, which is worse than saying nothing. So:
- never name a tool, employer, product or domain that is not in the
  background section
- never state a metric, team size or timeframe that is not there
- the angle-bracket forms above (<THEIR PROJECT>, <THEIR EMPLOYER>) are
  placeholders naming what to look FOR in the background. They are not
  this candidate's details and must never be echoed or guessed at.
- if the background is missing or does not cover the question, speak
  about the SUBJECT of the question instead — the constraint, the
  distinction, the definition. Never invent a memory, and never retreat
  to narrating your approach ("First thing I'd look at is —"): the
  background being thin says nothing about the topic, and the topic is
  always something you can say a true thing about.

NEVER DENY KNOWING SOMETHING THE INTERVIEWER NAMED.
The background is the candidate's own history; it says nothing about the
company they are talking to, the product on the table, or a term the
interviewer just used. Absence from it is NOT evidence they are
unfamiliar — and "I'm not familiar with <thing>" is spoken out loud, to
the people who asked. Never say you have not heard of, do not know, or
are not familiar with anything. When the question is about something
outside the background, open neutrally and let the full answer carry it
("So on that — the way I'd frame it is —").`;

// These used to say "name the technique you would reach for" and "name
// the overall shape you would start from" — which is precisely the
// instruction that made the opener guess a mechanism the reasoning model
// then contradicted. Each now asks for the thing that comes BEFORE a
// solution and therefore cannot be walked back.
// ── THESE ASK FOR A JUDGEMENT, NOT A PROCESS ──
// Every one of these used to say "say what you would verify / pin down /
// break down first". Measured live, that instruction is what produced
// "I'd verify the current ETL pipeline's performance metrics" in front of
// a question about exactly-once delivery: true of any question, an answer
// to none, and the reasoning model behind it opened with the real point
// one sentence later. Each now asks for the thing that is ALREADY TRUE
// about the problem as stated — which is substantive and still cannot be
// contradicted, because it is a claim about the question, not about a
// system nobody has looked at yet.
const CATEGORY_HINTS = {
  coding: 'It is a coding question — say the property of the input or the invariant that decides the approach (sorted or not, bounded or not, can it be mutated). Name the technique only if the question makes it unmistakable. Do not say what you would clarify.',
  system_design: 'It is a system-design question — name the constraint the whole design turns on and what it rules out, or the trade-off being forced. Not the architecture, and not which requirement you would gather.',
  ml_data: 'It is an ML/data question — say what is or is not achievable given what they described, or separate two things the question is treating as one (a job succeeding vs its output being correct; a metric moving vs a metric being right). Never "I would verify/measure/baseline first".',
  quantitative: 'It is an estimation question — state the quantity the estimate actually hinges on, the one that moves the answer by an order of magnitude.',
  strategy_case: 'It is a case question — say which of the possible readings of this problem you think it actually is, and what that changes. Not how you would break it down.',
  // Knowledge questions had NO hint, so they fell through to the
  // problem-solving shape and opened by stalling — "First thing I'd look
  // at is defining concurrency", said to someone who just asked what
  // concurrency is. Kind 3 in the system prompt; this is its hint.
  concept: 'It is a knowledge question — start on the topic itself: the one-line answer or the distinction that matters. Do not open by saying you would define it, and do not open with the resume.',
  // A behavioral question wants a specific from their life, immediately —
  // the situation, not a preamble about how they approach situations.
  //
  // The no-invented-metrics clause lives HERE rather than in COVER_SYSTEM
  // deliberately. It is only relevant to this shape of question, and
  // COVER_SYSTEM ships on every single cover request — adding it there cost
  // enough tokens to drop Groq's budget from 4.4 to 3.68 covers per minute,
  // below the 4/min an interview needs (a question every 20s is 3/min, and
  // the rest is headroom before the primary provider 429s mid-conversation).
  // Pinned by cover-token-budget.test.js.
  //
  // Why it is needed at all: a résumé contains no failures, so on "a mistake
  // you made" the model has nothing true to ground in and reaches for a
  // figure — "causing a 24-hour data loss" was measured in a real interview.
  // The grounding guard now catches invented numbers, so such a cover is
  // REJECTED and the candidate gets silence on the question where holding
  // the floor matters most. Telling the model the rule converts a discarded
  // cover into a speakable one. (The main answer already has this rule, in
  // aiProxyService buildUserRulesBlock — this is the cover's half.)
  behavioral: 'It is a behavioral question — open on the actual situation from the background (where, what was happening), not on how you generally handle such things. '
    + 'If the background holds no such story (mistakes, failures, disagreements are never on a CV), still open: set it in a real place and system from the background, keep the misstep an ordinary judgement call, and use NO invented numbers — no outage durations, hours, ticket counts or dollar figures. A number is allowed only if the background already states it.',
  // "What certifications do you have", "what was your degree" — a lookup,
  // not a problem. Had no hint, so it fell through to the problem-solving
  // shape and opened with "First, I'd establish the relevance of each
  // certification", said to someone who asked for a list.
  clarifier: 'It is a direct factual question about them — answer it straight from the background (the list, the name, the number, the dates). Do not open by saying what you would establish, assess or rule out.',
};

// ── THE SHAPE OF A QUESTION OUTRANKS ITS TOPIC ──
//
// Measured on a live run against a real résumé, not imagined. "Have you
// worked with Kafka?" classifies as `ml_data`, whose hint says "say what
// you would verify or measure first" — a PROBLEM-SOLVING instruction
// handed to a question about the candidate's own history. The model
// obeyed it exactly:
//
//   "Before confirming my experience with Kafka, I'd want to establish
//    the context in which it's being used…"
//
// Kafka is on that résumé, at 3M+ records/day. Spoken aloud in an
// interview, that sentence sounds like someone who has never touched it —
// on the single most common screening question there is. `other` (the
// catch-all, which "Do you know FastAPI?" lands in) is worse still: no
// hint at all, so it falls through to the same problem-solving shape.
// That is the identical bug the `concept` comment above records being
// fixed once already, still live for every category without an entry.
//
// A "have you / do you know / are you familiar with" question is about
// THEM whatever its subject matter is, so the shape decides, not the
// topic. This is checked before CATEGORY_HINTS and wins.
const EXPERIENTIAL_Q = new RegExp([
  '^\\s*(?:so\\s+|and\\s+|ok(?:ay)?,?\\s+|right,?\\s+|yeah,?\\s+)*',
  '(?:(?:have|has|had)\\s+you\\s+(?:ever\\s+)?(?:worked|used|built|written|dealt|shipped|run|ran|managed|led|done|touched)',
  '|(?:do|did)\\s+you\\s+(?:know|use|have|work)',
  '|(?:are|were)\\s+you\\s+familiar)',
].join(''), 'i');
const EXPERIENTIAL_Q2 = /\bare\s+you\s+familiar\s+with\b|\bwhat(?:'s|’s| is| was)\s+your\s+experience\s+(?:with|in|of)\b|\bever\s+(?:worked|used|built)\s+with\b|\bhow\s+(?:long|many\s+years)\s+(?:have|did|were)\s+you\b/i;

const EXPERIENTIAL_HINT = 'It is a question about THEIR OWN experience — answer it, do not '
  + 'approach it. If the background supports it, say so plainly in the first few words and name '
  + 'where: "Yeah — Kafka, at <employer>, on <the system>." If the background does NOT support '
  + 'it, say no just as plainly and briefly name what they did work with instead. Never open by '
  + 'saying what you would establish, confirm, clarify, consider or rule out — that is the shape '
  + 'for a problem to solve, and this is not one.';

/** True when the question asks about the candidate's own history, whatever its topic. */
function isExperientialQuestion(question) {
  const q = String(question || '');
  return EXPERIENTIAL_Q.test(q) || EXPERIENTIAL_Q2.test(q);
}

// ── "TELL ME ABOUT YOURSELF" IS NOT AN EXPERIENTIAL QUESTION ──
// EXPERIENTIAL_Q keys on "have you / do you know / are you familiar", so
// the single most common opening question in every interview does not
// match it, and neither do "walk me through your background" or "what
// have you worked on". Normally that costs nothing: the client's instant
// opener answers those locally from the fact ledger and the live cover is
// never asked. But when the résumé does not parse — measured at roughly
// half of real documents — those questions fall through to HERE, and
// without this predicate they would arrive with the background stripped
// out by `aboutThem` and be answered from thin air. This is the safety
// net for exactly that case.
// ⚠️ THE COST HERE IS ASYMMETRIC, AND THAT DECIDES THE DEFAULT.
//
// Withholding the background from a question that IS about the candidate
// does not produce a cautious answer — it produces an invented one, or a
// denial, spoken out loud. Measured over the real question corpus on
// 2026-08-06, with an earlier and narrower version of this predicate:
//
//   "can you explain about your peojects?"
//     -> "I need the CANDIDATE BACKGROUND section to answer this
//         question accurately."          (the model breaking character)
//   "What is the largest data volume you have personally handled?"
//     -> "around two terabytes"          (invented; the truth is 3M/day)
//   "Which Azure services have you used for LLM workloads?"
//     -> "I haven't worked with Azure directly"   (a false denial)
//
// Sending it to a problem question, by contrast, costs résumé recitation —
// bad, but survivable, and the prompt already forbids it. So this is
// deliberately GENEROUS: any hint that the question is about them wins.
//
// The one thing it must NOT catch is hypothetical framing. "How would you
// design exactly-once delivery" contains "you" and is not about them at
// all — which is why "would you" is absent from every alternative below,
// and why the test pins that case.
const BACKGROUND_Q = new RegExp([
  // Possessive, and second-person perfect/past — the grammar of a
  // question about someone's own history.
  '\\byour\\b|\\byourself\\b|\\byou\'?ve\\b|\\byou\\s+have\\b',
  // Past and perfect only — these ask what they DID. Bare "do you" and
  // "are you" are excluded on purpose: "Where do you start?" and "how
  // would you approach it" are problem framing wearing the same pronoun,
  // and an earlier version of this line handed the résumé to a Snowflake
  // cost question because of it. Present tense earns its place only with
  // a verb that is actually about their history.
  '|\\b(?:have|has|had|did|were|was)\\s+you\\b',
  '|\\bdo\\s+you\\s+(?:know|have|use|own|manage|prefer|work)\\b',
  '|\\bare\\s+you\\s+(?:familiar|comfortable|experienced)\\b',
  // "…a decision you made", "…something you built" — the verb is the tell.
  '|\\byou\\s+(?:made|worked|used|built|owned|led|ran|managed|handled|shipped|debugged|chose|designed|wrote|fixed|faced|dealt)\\b',
  '|\\btell\\s+me\\s+about\\s+a\\s+time\\b',
  '|\\bintroduce\\s+yourself\\b',
  '|\\b(?:walk|take)\\s+me\\s+through\\s+your\\b',
].join(''), 'i');

/** True when the question is asking them to describe themselves or their career. */
function isBackgroundQuestion(question) {
  return BACKGROUND_Q.test(String(question || ''));
}

// The one instruction that changes per question. It lives in the USER
// turn, not COVER_SYSTEM, on purpose: COVER_SYSTEM stays byte-identical
// across every call so Groq's prefix cache keeps hitting, and a length
// that varies per question would break that for a few dozen tokens of
// benefit.
//
// Each tier says WHY its length is what it is, because a model given a
// bigger budget with no reason to fill it usefully will pad — and padding
// spoken aloud is worse than a short answer.
function tierDirective(tier) {
  const { name, minWords, maxWords } = tier;
  if (name === 'opener') {
    return `LENGTH BUDGET: ${minWords}-${maxWords} words, one or two sentences. Then stop.`;
  }
  if (name === 'bridge') {
    return `LENGTH BUDGET: ${minWords}-${maxWords} words, two or three sentences. The full answer is a few seconds behind you, so after the opening add the ONE thing that most decides this answer — still what you would establish or weigh, never the fix.`;
  }
  // Holding. The word budget is computed from the actual gap, so tell the
  // model how long it has to fill in SECONDS as well — "hold the floor
  // for half a minute" and "hold the floor for a minute" are different
  // instructions, and a fixed sentence would be wrong for one of them.
  const seconds = Math.round(maxWords / SPOKEN_WORDS_PER_SEC);
  return `LENGTH BUDGET: ${minWords}-${maxWords} words. The full answer is a long way off, so this has to hold the floor ON ITS OWN for roughly ${seconds} seconds of speaking — it must be genuinely useful, not padding. Say what you would establish first, then the two or three things that actually decide the answer, then what you would rule out early. Still no committed solution: every word here has to survive whatever the full answer turns out to be.`;
}

// Background FIRST: a fast model reads top-down against a 1.5s
// first-token deadline, so the facts have to be in front of it before
// the question is.
//
// `plan` defaults to the opener tier so the three-argument form behaves
// exactly as it did before depth-adaptivity existed.
// How much of the transcript the cover sees. The whole reason it needs any
// is that it had none: given only the question and the resume, "then why did
// you answer IBM?" cannot be answered without inventing the thing being
// asked about, and the model duly invented a second employer to explain the
// first. That precise shape is now refused before it reaches a model, but
// every ordinary follow-up — "and the second one?", "you mentioned Kafka,
// where?" — had the same blindness.
const RECENT_TURNS_CHARS = 1_200;

function userPrompt(question, category, candidateContext, plan, recentTurns) {
  const tier = plan || COVER_TIERS[0];
  // Shape first, topic second — see the EXPERIENTIAL_Q note.
  const hint = (isExperientialQuestion(question) || isBackgroundQuestion(question))
    ? EXPERIENTIAL_HINT
    : (CATEGORY_HINTS[category] || '');
  // ── THE BACKGROUND IS ONLY SENT WHEN THE QUESTION IS ABOUT THEM ──
  // Measured live: on "how would you design exactly-once delivery…" the
  // cover answered "I'd verify the current ETL pipeline's performance
  // metrics… the 30% lower latency", and on a question about the
  // INTERVIEWER's 400-DAG Airflow it answered "I'd verify the current
  // data processing workflows at Indiana University and Apollo
  // Hospitals". Neither had anything to do with what was asked. A fast
  // model handed a résumé and a hard question reaches for the résumé,
  // because that is the concrete text in front of it — no prompt rule
  // survives that pull, and the rules above had already forbidden it.
  // So the résumé is simply not in the room unless the question is about
  // the candidate. Kinds 2 and 3 (a problem, a topic) are answered from
  // the QUESTION, which is the only thing they were ever about.
  //
  // `clarifier` and `behavioral` are about them as surely as an
  // experiential question is — a degree, a certification list, a time
  // they shipped something — and their hints say to answer straight from
  // the background, so they keep it.
  const aboutThem = isExperientialQuestion(question)
    || isBackgroundQuestion(question)
    || category === 'clarifier' || category === 'behavioral';
  const bg = aboutThem ? String(candidateContext || '').trim() : '';
  const recent = String(recentTurns || '').trim().slice(-RECENT_TURNS_CHARS);
  return [
    // 9,000 matches COVER_CONTEXT_CHARS on the client, and the two must
    // agree. They did not: the client was raised to fit a whole resume
    // while this line still cut it to 1,200 — so the model kept receiving
    // the summary and skills with every employer sliced off, and kept
    // reporting that the candidate's own current employer "isn't
    // mentioned in my background". A cap in two places is a cap that will
    // disagree; this one exists only as a backstop against a client
    // sending something absurd.
    bg ? `CANDIDATE BACKGROUND (true — use it, never go beyond it):\n${bg.slice(0, 9000)}\n` : '',
    // Before the question, because the question is often only meaningful
    // relative to it — and after the background, because the background is
    // what is TRUE while this is merely what was said.
    recent
      ? `THE LAST FEW SECONDS OF THIS CONVERSATION (context only — a line here is\n`
        + `not evidence about the candidate, and anything in it that the background\n`
        + `does not support must NOT be repeated or defended):\n${recent}\n`
      : '',
    hint ? hint + '\n' : '',
    `Interviewer asked: "${String(question).slice(0, 600)}"`,
    '',
    tierDirective(tier),
    `Your spoken words (${tier.minWords}-${tier.maxWords} words):`,
  ].filter(Boolean).join('\n');
}

// ── Provider stream factories ── each returns an async iterable of
// { text } chunks (Gemini) or is adapted to that shape (Groq).
function geminiCoverFactory(question, category, candidateContext, apiKey, abortSignal, plan, recentTurns) {
  return async () => {
    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    return ai.models.generateContentStream({
      model: 'gemini-3.6-flash',
      contents: [{ role: 'user', parts: [{ text: userPrompt(question, category, candidateContext, plan, recentTurns) }] }],
      config: {
        systemInstruction: COVER_SYSTEM,
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
        maxOutputTokens: plan.maxTokens,
        abortSignal,
      },
    });
  };
}

function groqCoverFactory(question, category, candidateContext, apiKey, abortSignal, plan, recentTurns) {
  return async () => {
    const Groq = require('groq-sdk');
    // maxRetries: 0 — see the note on the Anthropic client below.
    const groq = new Groq({ apiKey, maxRetries: 0, timeout: 2500 });
    // llama-3.3-70b-versatile: non-reasoning, 216-283ms first token
    // measured. (The gpt-oss-120b interview model is a reasoning model
    // that would burn this tiny budget on thinking and emit nothing —
    // wrong tool here. It is also on an 8,000 TPM free-tier bucket that
    // a cover-sized request fits inside and an interview-sized one does
    // not; see the note in routes/ai.js.)
    const stream = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: COVER_SYSTEM },
        { role: 'user', content: userPrompt(question, category, candidateContext, plan, recentTurns) },
      ],
      max_tokens: plan.maxTokens,
      temperature: 0.7,
      stream: true,
    }, { signal: abortSignal });
    // Adapt OpenAI-shaped chunks to { text }.
    return (async function* () {
      for await (const c of stream) {
        const t = c?.choices?.[0]?.delta?.content;
        if (t) yield { text: t };
      }
    })();
  };
}

// ── The paid backstop ──
//
// Groq and Gemini are both FREE-TIER, and both were observed returning
// 429 at the same time — Groq's org token limit and Gemini's daily
// quota. The chain had no third link, so the cover simply did not
// happen: the answer still arrived, seconds later, with the candidate
// sitting silent. That is the one failure this whole feature exists to
// prevent, and it was happening without a trace.
//
// Haiku is the backstop because it is fast and it is PAID — it does not
// share a free quota with anything, so it is still there on the day the
// other two are exhausted. A cover is ~80 output tokens; the insurance
// costs a fraction of a cent and only bills when the free tiers are
// already down.
function anthropicCoverFactory(question, category, candidateContext, apiKey, abortSignal, plan, recentTurns) {
  return async () => {
    const Anthropic = require('@anthropic-ai/sdk');
    // NO SDK RETRIES, and a hard timeout.
    //
    // Every one of these SDKs retries with backoff by default, which is
    // right for the main answer and wrong here. Measured: a rate-limited
    // Groq took 2,285ms to fall through to the next provider, because the
    // SDK was quietly retrying a 429 that was never going to succeed —
    // and the cover's entire budget is 1,500ms. The chain's own deadline
    // is the retry policy: fail immediately, try the next provider.
    const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 2500 });
    const stream = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: plan.maxTokens,
      system: COVER_SYSTEM,
      messages: [{ role: 'user', content: userPrompt(question, category, candidateContext, plan, recentTurns) }],
      stream: true,
    }, { signal: abortSignal });
    return (async function* () {
      for await (const ev of stream) {
        const t = ev?.type === 'content_block_delta' ? ev.delta?.text : null;
        if (t) yield { text: t };
      }
    })();
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  NOTHING HALF-SAID REACHES THE CANDIDATE'S MOUTH
//
//  Every token this emitter passes through is a word a human being
//  reads aloud to an interviewer a fraction of a second later. That
//  makes it different from ordinary streaming: an answer cut off in the
//  middle is not "slightly truncated", it is the candidate saying
//  "Yeah, I've run pipeline workloads on Kubernetes with Azure DevOps
//  CI/CD at" and then stopping dead. Measured output, on a real resume.
//
//  So the emitter only ever releases COMPLETE SENTENCES, and on an abort
//  it drops whatever sentence was still in progress. Two rules:
//
//    • nothing at all until MIN_FLUSH_WORDS words exist, so a stream
//      that dies after two words releases nothing.
//    • after that, release up to the last finished sentence and hold the
//      rest. On a clean end the remainder is real output and goes out;
//      on an abort it is an unfinished thought and is discarded.
//
//  The second rule is the one that costs something — a single-sentence
//  cover now appears when it is finished rather than word by word. That
//  is 80-250ms on the measured generation rates, and it is the right
//  trade twice over: a candidate reading aloud would rather see the
//  whole line than chase a cursor, and the alternative is what the app
//  did before, which was hand them a sentence with no end on it.
//
//  `text` is therefore exactly what the user saw — which matters twice
//  over, because the main model receives it verbatim as a continuation
//  instruction and must not be told to continue from words that never
//  reached the screen.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Index of the last sentence terminator that is FOLLOWED by whitespace.
// Requiring the whitespace is what keeps "99.9% of rows" and "U.S." from
// reading as sentence ends; a terminator sitting at the very end of the
// buffer simply waits for the next token, or for finish().
function lastSentenceEnd(s) {
  for (let i = s.length - 2; i >= 0; i--) {
    const c = s[i];
    if ((c === '.' || c === '!' || c === '?' || c === '…' || c === '\n') && /\s/.test(s[i + 1])) return i;
  }
  return -1;
}

function createCoverEmitter(onToken) {
  let buffered = '';
  let emitted = '';
  let open = false;   // has anything been released yet?
  const wordCount = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);
  return {
    push(piece) {
      buffered += piece;
      const end = lastSentenceEnd(buffered);
      if (end < 0) return;
      const chunk = buffered.slice(0, end + 1);
      // The very first release also has to clear the word floor; after
      // that a finished sentence is a finished sentence.
      if (!open && wordCount(emitted + chunk) < MIN_FLUSH_WORDS) return;
      open = true;
      emitted += chunk;
      buffered = buffered.slice(end + 1);
      onToken(chunk);
    },
    // Clean end of stream: everything the model produced is intentional,
    // so the held-back head goes out even if it never reached the
    // minimum — a deliberately short complete sentence is fine.
    finish() {
      if (buffered) { emitted += buffered; onToken(buffered); buffered = '' ; open = true; }
      return emitted;
    },
    // Aborted: the buffer is an unfinished thought. Drop it.
    abandon() { buffered = ''; return emitted; },
    get emittedText() { return emitted; },
  };
}

// Run ONE provider's stream. Two independent clocks (see the comment on
// MS_PER_COVER_TOKEN): `firstTokenDeadlineMs` bounds the wait for the
// first token, and only after that lands does `generationMs` start —
// because at that point the words are on screen and cutting them off is
// worse than finishing late.
//
// `gate` is the race, and it is in TWO STAGES because a provider that
// intends to answer and a provider that has answered are not the same
// thing. `gate.claim()` fires on the FIRST TOKEN and only decides who
// the hedges stand down for — it is cheap to hold and it can be handed
// back (see CLAIM_STALL_MS). `gate.speak()` fires on the FIRST FLUSH,
// when words actually reach the user, and THAT is the one that cannot be
// taken back: exactly one provider is ever allowed past it, so two
// providers that both answer can never interleave their words into one
// sentence.
//
// Whichever stage is lost, the loser aborts itself quietly and reports
// nothing — losing is not an error, somebody else simply answered.
//
// Returns { text, failure } — text is what actually reached the user.
async function runOne(makeStream, onToken, outerSignal, firstTokenDeadlineMs, generationMs, gate) {
  const controller = new AbortController();
  const onOuterAbort = () => { try { controller.abort(); } catch {} };
  if (outerSignal) {
    if (outerSignal.aborted) return { text: '', failure: 'client gone' };
    outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }
  // The lone injected stream (the _streamFn path) races nobody, so it
  // owns both stages by construction.
  const race = gate || { claim: () => true, speak: () => true, release: () => {} };
  let gotFirst = false;
  let lost = false;
  let cleanEnd = false;
  let spoke = false;
  let stallTimer = null;
  // The permanent gate sits HERE, on the way to the screen, rather than
  // on the first token — this callback runs exactly once per released
  // sentence and its first run is the moment this cover exists. Losing
  // here means another provider is already being read aloud: swallow the
  // chunk and stop. (`emitted` inside the emitter is now dirty, which is
  // why every `lost` path below returns '' rather than trusting it.)
  const emitter = createCoverEmitter((chunk) => {
    if (lost) return;
    if (!spoke) {
      if (!race.speak()) { lost = true; onOuterAbort(); return; }
      spoke = true;
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    }
    onToken(chunk);
  });
  // Re-armed on every token: holding the race while producing nothing is
  // the one thing a claimant must not be able to do, because the hedges
  // are standing down on the strength of it. See CLAIM_STALL_MS for why
  // letting go here costs almost nothing when it is wrong.
  const armStall = () => {
    if (spoke || lost) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => { stallTimer = null; race.release(); }, CLAIM_STALL_MS);
  };
  const firstTimer = setTimeout(() => { if (!gotFirst) onOuterAbort(); }, firstTokenDeadlineMs);
  // Armed only once the first token has landed — a generation deadline
  // that starts before the model has said anything is just a slower
  // first-token deadline wearing a different name.
  let genTimer = null;

  // ── THE WALL HAS TO BE OURS ──
  //
  // The timers above abort a controller and TRUST the provider SDK to
  // honor the signal. Every SDK in the chain does today — but the
  // deadline that guards a live interview cannot rest on that, because
  // an SDK that ignores it (or a connection that stalls before the SDK's
  // own timeout arms, or a create() that never settles) leaves this
  // awaiting forever. And this is awaited BEFORE the main model call is
  // issued, so "the cover hung" and "the answer never came" are the same
  // event. A deadline enforced by the thing it is meant to bound is not
  // a deadline. So the race below is the actual wall; the abort is the
  // polite request that usually lands first.
  //
  // The wall is RE-ARMED rather than set once, and that distinction is
  // load-bearing: a provider that never speaks must be walled at the
  // first-token deadline, while one that HAS spoken has earned the
  // generation window. Summing the two would let a hung provider hold
  // the main model's call for both — which is the thing the deadline
  // exists to prevent, arrived at from the other direction.
  let wallTimer = null;
  let hitWall = false;
  let wallAt = firstTokenDeadlineMs;
  let resolveWall;
  const wall = new Promise((resolve) => { resolveWall = resolve; });
  const armWall = (ms) => {
    wallAt = ms;
    if (wallTimer) clearTimeout(wallTimer);
    // Grace so a well-behaved SDK aborts first and we record the real
    // reason rather than a generic wall hit.
    wallTimer = setTimeout(() => { hitWall = true; onOuterAbort(); resolveWall(); }, ms + 150);
  };
  armWall(firstTokenDeadlineMs);

  let failure = '';
  try {
    const pump = (async () => {
      const stream = await makeStream(controller.signal);
      for await (const event of stream) {
        const piece = typeof event === 'string' ? event : event?.text;
        if (!piece) continue;
        if (!gotFirst) {
          gotFirst = true;
          // Stage one of the race gate. Losing here is not an error —
          // another provider simply answered first — so abort quietly and
          // emit nothing.
          if (!race.claim()) { lost = true; onOuterAbort(); return; }
          clearTimeout(firstTimer);
          genTimer = setTimeout(onOuterAbort, generationMs);
          armWall(generationMs);
        }
        emitter.push(piece);
        // Stage two may have been lost inside that push.
        if (lost) return;
        armStall();
      }
      cleanEnd = true;
    })();
    // If the wall wins, pump is still in flight and may reject later with
    // nobody awaiting it. Swallow that here, not in an unhandled handler.
    pump.catch(() => {});
    await Promise.race([pump, wall]);
    if (hitWall && !gotFirst) throw new Error(`provider unresponsive past ${wallAt}ms`);
  } catch (err) {
    // Abort (deadline / client gone) or upstream error.
    //
    // RECORD why. This used to be a bare `catch {}`, and a cover that
    // fails is invisible: the answer still arrives, just seconds later
    // with the candidate sitting silent — the exact thing this feature
    // exists to prevent. It went unnoticed until someone measured time
    // to first word. A swallowed failure in the one feature whose entire
    // job is speed has to leave a trace.
    failure = !gotFirst && controller.signal.aborted
      ? `no first token within ${firstTokenDeadlineMs}ms`
      : String(err && err.message || err).slice(0, 160);
  } finally {
    clearTimeout(firstTimer);
    if (genTimer) clearTimeout(genTimer);
    if (wallTimer) clearTimeout(wallTimer);
    if (stallTimer) clearTimeout(stallTimer);
    if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
  }
  if (lost) return { text: '', failure: 'lost the race' };
  // Clean end → the held-back head is real output. Abort → it is an
  // unfinished sentence and is dropped; only what the user already saw
  // is returned.
  const raw = cleanEnd ? emitter.finish() : emitter.abandon();
  // finish() pushes that head through the SAME screen gate, so the race
  // can still be lost on the way out — two providers whose sentences land
  // in the same tick. Re-read `lost` for exactly that.
  if (lost) return { text: '', failure: 'lost the race' };
  const text = raw.trim();
  if (!text) {
    // Nothing ever reached the screen, so this attempt cannot be the
    // cover. Hand the race back BEFORE returning: the hedges that stood
    // down for this claim are waiting on precisely this signal, and a
    // claim nobody can take back is a single point of failure wearing a
    // gate's clothes.
    race.release();
    if (!failure) failure = 'produced nothing';
  }
  return { text, failure };
}

async function streamCoverAnswer({
  question,
  category,
  candidateContext,
  recentTurns,
  geminiKey,
  groqKey,
  anthropicKey,
  onToken,
  signal,
  plan = COVER_TIERS[0],          // depth tier; see planCover
  _streamFn,                      // test injection: ONE async iterable factory
  _providerFns,                   // test injection: the whole racing field
  _names,                         // test injection: labels for the failure log
  firstTokenDeadlineMs = FIRST_TOKEN_DEADLINE_MS,
  totalDeadlineMs,
  chainBudgetMs,
}) {
  if (!question) return '';
  if (typeof onToken !== 'function') return '';
  if (signal && signal.aborted) return '';

  const tier = plan || COVER_TIERS[0];
  const perProviderTotal = totalDeadlineMs != null ? totalDeadlineMs
    : (tier.totalDeadlineMs || TOTAL_DEADLINE_MS);

  // ── THE WALL-CLOCK THE MAIN ANSWER IS WAITING BEHIND ──
  //
  // The main model call is issued only after this returns, because it
  // receives the cover verbatim as a continuation instruction. That is
  // the right trade — a seamless single answer is worth a few hundred
  // milliseconds — but it means every millisecond spent here is a
  // millisecond of the DEEP answer's latency, and the old chain had no
  // total bound at all. Three providers × their own deadlines came to
  // 1,500 + 1,500 + 2,600 = 5,600ms of pure added silence in the exact
  // scenario the feature exists for: the day every cover provider is
  // down, the candidate waited nearly six extra seconds for the answer
  // AND got no cover.
  //
  // So the chain gets ONE budget, sized from the predicted gap
  // (plan.chainBudgetMs). A fast main model gets a tight leash; grok on
  // a design question, twenty seconds out, can afford three seconds.
  // Each provider's deadline is clamped by what is left of it, and when
  // it is gone we stop trying and let the main call go.
  const budgetMs = chainBudgetMs != null ? chainBudgetMs
    : (tier.chainBudgetMs || TOTAL_DEADLINE_MS);
  const startedAt = Date.now();
  const remaining = () => budgetMs - (Date.now() - startedAt);

  const genMs = generationWindowMs(tier);

  // Test path: a single injected stream factory (keeps existing tests
  // and the deterministic contract intact). The chain budget still
  // applies — it is a wall on how long the MAIN answer waits, and a wall
  // that only exists on the real path is a wall no test can prove.
  if (_streamFn) {
    const only = await runOne(
      (sig) => _streamFn({ question, category, signal: sig }),
      onToken, signal,
      Math.min(firstTokenDeadlineMs, budgetMs),
      Math.min(perProviderTotal, genMs),
      null,
    );
    return only.text;
  }

  // Groq (separate quota, 216-283ms measured) leads; Gemini backs it up;
  // the PAID backstop is last, because it should only cost money when
  // the free tiers have already failed. Order still matters — it decides
  // who starts first and who is merely held in reserve — but a provider
  // no longer has to FAIL before the next one is allowed to exist.
  const providers = [];
  const names = [];
  // Names dropped for a live cooldown, so the "skipped, cost nothing"
  // line can say who. Collected on BOTH the injected and the real path —
  // a seam that cannot report the skip cannot test it.
  const injectedCooling = [];
  // Test seam: race an injected field instead of the real vendors, so
  // the hedge, the claim gate and the backstop's reachability can be
  // proven deterministically without spending a provider call.
  if (Array.isArray(_providerFns) && _providerFns.length) {
    // The cooldown applies to injected providers too. A seam that skips
    // the skipping cannot prove the skipping — and this is the branch
    // every deterministic test of the race runs through.
    const injectedNames = _names || _providerFns.map((_, i) => `p${i + 1}`);
    _providerFns.forEach((fn, i) => {
      if (providerReady(injectedNames[i])) { providers.push(fn); names.push(injectedNames[i]); }
      else injectedCooling.push(injectedNames[i]);
    });
  }
  // `providerReady` drops anyone still serving a quota cooldown. Skipping
  // is not the same as failing: a skipped provider costs nothing, and its
  // absence promotes whoever is left — which is how the paid backstop ends
  // up FIRST on a day the free tiers are exhausted.
  const cooling = injectedCooling;
  if (!providers.length && groqKey) {
    if (providerReady('groq')) { providers.push((sig) => groqCoverFactory(question, category, candidateContext, groqKey, sig, tier, recentTurns)()); names.push('groq'); } else cooling.push('groq');
  }
  if (geminiKey) {
    if (providerReady('gemini')) { providers.push((sig) => geminiCoverFactory(question, category, candidateContext, geminiKey, sig, tier, recentTurns)()); names.push('gemini'); } else cooling.push('gemini');
  }
  // Paid, and last in the ORDER — reached only when the free tiers are
  // slow, exhausted or down, which is exactly when it matters.
  if (anthropicKey) {
    if (providerReady('haiku')) { providers.push((sig) => anthropicCoverFactory(question, category, candidateContext, anthropicKey, sig, tier, recentTurns)()); names.push('haiku'); } else cooling.push('haiku');
  }
  if (providers.length === 0) {
    // Nothing to try. Return NOW rather than after the budget: the main
    // model's call is queued behind this await, so every millisecond spent
    // here is dead air in front of an answer that was ready to start.
    if (cooling.length) {
      console.warn(`[cover] SKIPPED — every provider is cooling down after a quota failure (${cooling.join(', ')}); 0ms added`);
    }
    return '';
  }

  // ── THE HEDGED RACE ──
  //
  // Attempt 0 starts now. Attempt N starts at N × HEDGE_STAGGER_MS, but
  // ONLY if nobody has spoken yet and the budget still has room — so on
  // the normal path (Groq answering in ~250ms) the hedges never launch
  // and this costs exactly what the serial chain cost. When the primary
  // hangs, the alternatives are already in flight instead of waiting
  // behind a timeout that will consume the entire budget.
  //
  // `remaining()` still gates every launch: a provider started with
  // nothing left to give it would only be delaying the answer.
  const failures = [];
  // ── THE RACE, IN TWO STAGES ──
  //
  // `winner` is provisional: it is what the hedges stand down for, and it
  // is taken on a first token because that is the earliest honest sign
  // that a provider is alive — waiting for real words before standing the
  // hedges down would put the PAID backstop on every ordinary run.
  //
  // `spoken` is the one that cannot be taken back. It flips when words
  // reach the screen, and from that moment no other provider may write —
  // that, not the claim, is what makes interleaved output impossible.
  //
  // The split is the fix for a measured silence: a claim that never turns
  // into words is RELEASED (see CLAIM_STALL_MS and runOne) and the hedges
  // are let back in, instead of one wedged provider taking the whole
  // cover down while two healthy alternatives sit the run out.
  let winner = -1;
  let spoken = false;
  let launched = 0;
  const claimWaiters = [];
  const wakeClaimWaiters = () => { claimWaiters.splice(0).forEach((fn) => fn()); };
  const gateFor = (i) => ({
    claim: () => { if (winner !== -1) return false; winner = i; return true; },
    speak: () => { if (spoken) return false; spoken = true; winner = i; wakeClaimWaiters(); return true; },
    release: () => { if (spoken || winner !== i) return; winner = -1; wakeClaimWaiters(); },
  });

  // Everyone ahead of me has given up → stop waiting, go now.
  let gaveUp = 0;
  const waiters = [];
  const noteGaveUp = () => { gaveUp++; waiters.splice(0).forEach((fn) => fn()); };
  const waitTurn = (i) => new Promise((resolve) => {
    const timer = setTimeout(resolve, i * HEDGE_STAGGER_MS);
    const check = () => {
      if (!HEDGE_ON_FAILURE) return;
      if (gaveUp >= i) { clearTimeout(timer); resolve(); return; }
      waiters.push(check);
    };
    check();
  });

  // A hedge that arrives to find the race claimed does not give up on it,
  // it WAITS for the claim to become words or to be handed back. Reading
  // `winner` once and returning "not needed" is what let a provider that
  // never spoke silence the whole chain: the claim was taken at ~0ms and
  // both hedges bailed at their staggers, long before anyone could know
  // the claimant would produce nothing.
  //
  // Bounded by what is left of the chain budget, because the main answer
  // is queued behind this: at worst a hedge wakes with the budget gone
  // and takes the same exit it would have taken anyway.
  const waitClaim = () => new Promise((resolve) => {
    if (spoken || winner === -1) { resolve(); return; }
    let timer = null;
    let done = false;
    const wake = () => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(); };
    timer = setTimeout(wake, Math.max(0, remaining()));
    claimWaiters.push(wake);
  });

  const attempt = async (i) => {
    // Hedges wait their turn, then re-check. Deciding at launch time
    // rather than up front is the whole point: if the primary already
    // spoke, the hedge must not run at all — on the paid backstop that
    // is the difference between insurance and a standing bill.
    if (i > 0) {
      await waitTurn(i);
      // Park on a live claim rather than reading it once — words on the
      // screen mean there is nothing for me to do, a released claim means
      // it is my turn after all. See waitClaim.
      await waitClaim();
      if (spoken) return { i, text: '', failure: 'not needed' };
      if (signal && signal.aborted) { noteGaveUp(); return { i, text: '', failure: 'client gone' }; }
      if (remaining() <= 200) { noteGaveUp(); return { i, text: '', failure: `chain budget ${budgetMs}ms spent` }; }
    }
    launched++;
    // The last provider in the list has nothing behind it, so it gets the
    // longer deadline — but never more than the chain budget still holds,
    // UNLESS it is the only hope left (see LAST_PROVIDER_FLOOR_MS).
    const isLast = i === providers.length - 1;
    const wanted = isLast
      ? Math.max(firstTokenDeadlineMs, LAST_PROVIDER_DEADLINE_MS)
      : firstTokenDeadlineMs;
    let firstDeadline = Math.max(200, Math.min(wanted, remaining()));
    // Nothing follows the last provider — that is the whole condition.
    // (An earlier version also required every provider ahead of it to
    // have ALREADY failed, which is not the same thing: hedge N launches
    // on its stagger while hedge N-1 is still in flight, so the backstop
    // was starved of the floor in exactly the run that needed it.)
    // The lone-provider case is excluded: with nothing to fall back FROM,
    // the floor would just be a way for any hung cover to hold the answer.
    if (isLast && providers.length > 1) {
      firstDeadline = Math.max(firstDeadline, LAST_PROVIDER_FLOOR_MS);
    }
    try {
      const r = await runOne(providers[i], onToken, signal, firstDeadline, genMs, gateFor(i));
      if (!r.text) noteGaveUp();
      return { i, ...r };
    } catch (err) {
      noteGaveUp();
      return { i, text: '', failure: String(err && err.message || err).slice(0, 160) };
    }
  };

  // Return the instant the WINNER is done — never wait on a straggler.
  // A hedge that is still counting down its stagger would otherwise hold
  // the main model's call hostage for the full budget after the cover is
  // already on screen, which is the exact latency this feature exists to
  // remove.
  let resolveWinner;
  const winnerText = new Promise((r) => { resolveWinner = r; });
  const attempts = providers.map((_, i) => attempt(i).then((r) => {
    if (r.text) resolveWinner(r.text);
    return r;
  }));

  const everyoneSettled = Promise.all(attempts).then((results) => {
    for (const r of results) {
      // A provider that answered is healthy — clear any cooldown it was
      // serving, so one bad minute never outlives itself.
      if (r.text) { providerRecovered(names[r.i]); continue; }
      if (r.failure && r.failure !== 'lost the race' && r.failure !== 'not needed') {
        noteProviderFailure(names[r.i], r.failure);
        failures.push(`${names[r.i] || r.i}: ${r.failure}`);
      }
    }
    return '';
  });

  const text = await Promise.race([winnerText, everyoneSettled]);
  if (text) return text;

  // Every provider that ran failed. Say so — the request will still
  // answer, just with dead air first, and that must not be silent.
  console.warn(`[cover] NO COVER — tier=${tier.name} ${launched}/${providers.length} provider(s) raced in ${Date.now() - startedAt}ms (budget ${budgetMs}ms): ${failures.join(' / ') || 'no reason recorded'}`);
  return '';
}

// The continuation instruction the MAIN model receives alongside the
// question. Rides on the last user message (never the system prompt — see
// appendTextToLastUserMessage in routes/ai.js for the cache rationale).
function buildCoverContinuation(coverText) {
  return `[LIVE CONTINUATION — you already began answering out loud with: "${coverText}"
Your output MUST continue that same spoken answer from exactly where it stops. Do not repeat or rephrase the opening, and do not re-make any point it already made — on a longer opening that is several points, not one. If it stopped mid-sentence, complete the sentence naturally first. Follow the approach the opening pointed at where it fits what you actually know.
IMPORTANT: that opening was spoken before the speaker recalled the specifics, so it is NOT a fact you must defend. If it points somewhere your real background does not support, do NOT restate it and do NOT announce a correction ("actually, I need to correct that") — simply continue into what is true, as if that is where the sentence was always heading. Never invent experience to stay consistent with the opening.]`;
}

module.exports = {
  streamCoverAnswer,
  // Provider cooldown — exported so a test can prove a 429 benches a
  // provider, that the paid backstop is promoted when the free tiers are
  // benched, and that an all-cooling chain costs zero added latency.
  _resetProviderCooldowns,
  _providerCooldowns,
  isQuotaFailure,
  buildCoverContinuation,
  userPrompt,
  COVER_SYSTEM,
  // Depth model — exported so the routes plan a cover from the SAME
  // numbers the engine runs on, and so the tiers can be tested without
  // spending a provider call.
  predictMainTtftMs,
  staticTtftMs,
  recordMainTtftMs,
  planCover,
  planCoverFor,
  COVER_TIERS,
  COVER_FLOOR_MS,
  SPOKEN_WORDS_PER_SEC,
  HEDGE_STAGGER_MS,
  CLAIM_STALL_MS,
  MIN_FLUSH_WORDS,
  generationWindowMs,
  _resetObservedTtft,
  _observedTtft,
};
