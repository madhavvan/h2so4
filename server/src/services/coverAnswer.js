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

// Below this predicted gap, DO NOT fire a cover at all. Gemini at
// thinkingLevel MINIMAL reaches its first token in 0.7-0.8s (bench AND
// in-app agree); the cover's own fastest provider needs 0.22-0.28s and
// then has to generate. Racing a model that fast wins nothing and costs
// the main answer real milliseconds — the feature must only ever ADD
// perceived speed.
const COVER_FLOOR_MS = 1200;
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
- Do not give the conclusion.
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
   algorithm. Open with WHAT YOU WOULD ESTABLISH FIRST, never with the
   solution, and never with their employment history.
   - "Before I change anything I'd want to confirm what's actually
     happening —", "First thing I'd establish is whether this starts at
     ingestion or downstream —", "I'd want to see one concrete example
     before I touch it —"
   - NOT "First thing I'd look at is the partitioning", NOT "I'd use
     Kafka's exactly-once semantics", NOT "I'd start with the data model"

   This is not timidity, it is the only thing that can be true. You are
   answering in under a second, before anyone has diagnosed anything —
   so a named cause or mechanism is a GUESS, and the full answer that
   follows will have actually reasoned. When they disagree the candidate
   has already said the wrong thing out loud and has to walk it back
   mid-sentence: "First thing I'd look at is the partitioning… before
   tuning anything, I'd confirm the slowdown is real." Incoherent, and
   the interviewer hears both halves.
   Naming what you would ESTABLISH cannot be contradicted, and the full
   answer continues from it naturally, because working out what is true
   before acting is what a senior engineer does anyway.

   Never assume their stack. If the question did not name a technology,
   do not introduce one from the background — the tool they use is not
   necessarily the tool in the question.

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
- if the background is missing or does not cover the question, fall back
  to a stance about your APPROACH ("First thing I'd look at is —")
  rather than inventing a memory.

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
const CATEGORY_HINTS = {
  coding: 'It is a coding question — say what you would clarify or check about the input first, or name the shape of the approach only if it is unmistakable from the question itself.',
  system_design: 'It is a system-design question — say which constraint or requirement you would pin down first, not the architecture.',
  ml_data: 'It is an ML/data question — say what you would verify or measure first, not the fix.',
  quantitative: 'It is an estimation question — say which direction you would size it from (top-down or bottom-up).',
  strategy_case: 'It is a case question — say how you would break the problem down first.',
  // Knowledge questions had NO hint, so they fell through to the
  // problem-solving shape and opened by stalling — "First thing I'd look
  // at is defining concurrency", said to someone who just asked what
  // concurrency is. Kind 3 in the system prompt; this is its hint.
  concept: 'It is a knowledge question — start on the topic itself: the one-line answer or the distinction that matters. Do not open by saying you would define it, and do not open with the resume.',
  // A behavioral question wants a specific from their life, immediately —
  // the situation, not a preamble about how they approach situations.
  behavioral: 'It is a behavioral question — open on the actual situation from the background (where, what was happening), not on how you generally handle such things.',
};

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
function userPrompt(question, category, candidateContext, plan) {
  const tier = plan || COVER_TIERS[0];
  const hint = CATEGORY_HINTS[category] || '';
  const bg = String(candidateContext || '').trim();
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
    hint ? hint + '\n' : '',
    `Interviewer asked: "${String(question).slice(0, 600)}"`,
    '',
    tierDirective(tier),
    `Your spoken words (${tier.minWords}-${tier.maxWords} words):`,
  ].filter(Boolean).join('\n');
}

// ── Provider stream factories ── each returns an async iterable of
// { text } chunks (Gemini) or is adapted to that shape (Groq).
function geminiCoverFactory(question, category, candidateContext, apiKey, abortSignal, plan) {
  return async () => {
    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    return ai.models.generateContentStream({
      model: 'gemini-3.6-flash',
      contents: [{ role: 'user', parts: [{ text: userPrompt(question, category, candidateContext, plan) }] }],
      config: {
        systemInstruction: COVER_SYSTEM,
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
        maxOutputTokens: plan.maxTokens,
        abortSignal,
      },
    });
  };
}

function groqCoverFactory(question, category, candidateContext, apiKey, abortSignal, plan) {
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
        { role: 'user', content: userPrompt(question, category, candidateContext, plan) },
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
function anthropicCoverFactory(question, category, candidateContext, apiKey, abortSignal, plan) {
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
      messages: [{ role: 'user', content: userPrompt(question, category, candidateContext, plan) }],
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
// `claim()` is the race's gate. A provider calls it when it has its
// first token; the first caller wins and every other attempt aborts
// itself and discards what it has. Without a claim gate two providers
// that both answer would interleave their words into one sentence.
//
// Returns { text, failure } — text is what actually reached the user.
async function runOne(makeStream, onToken, outerSignal, firstTokenDeadlineMs, generationMs, claim) {
  const controller = new AbortController();
  const onOuterAbort = () => { try { controller.abort(); } catch {} };
  if (outerSignal) {
    if (outerSignal.aborted) return { text: '', failure: 'client gone' };
    outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const emitter = createCoverEmitter(onToken);
  let gotFirst = false;
  let lost = false;
  let cleanEnd = false;
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
          // The race gate. Losing here is not an error — another provider
          // simply answered first — so abort quietly and emit nothing.
          if (claim && !claim()) { lost = true; onOuterAbort(); return; }
          clearTimeout(firstTimer);
          genTimer = setTimeout(onOuterAbort, generationMs);
          armWall(generationMs);
        }
        emitter.push(piece);
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
    if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
  }
  if (lost) return { text: '', failure: 'lost the race' };
  // Clean end → the held-back head is real output. Abort → it is an
  // unfinished sentence and is dropped; only what the user already saw
  // is returned.
  const text = (cleanEnd ? emitter.finish() : emitter.abandon()).trim();
  if (!text && !failure) failure = 'produced nothing';
  return { text, failure };
}

async function streamCoverAnswer({
  question,
  category,
  candidateContext,
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
  // Test seam: race an injected field instead of the real vendors, so
  // the hedge, the claim gate and the backstop's reachability can be
  // proven deterministically without spending a provider call.
  if (Array.isArray(_providerFns) && _providerFns.length) {
    providers.push(..._providerFns);
    names.push(...(_names || _providerFns.map((_, i) => `p${i + 1}`)));
  }
  if (!providers.length && groqKey) { providers.push((sig) => groqCoverFactory(question, category, candidateContext, groqKey, sig, tier)()); names.push('groq'); }
  if (geminiKey) { providers.push((sig) => geminiCoverFactory(question, category, candidateContext, geminiKey, sig, tier)()); names.push('gemini'); }
  // Paid, and last — reached only when the free tiers are slow, exhausted
  // or down, which is exactly when it matters.
  if (anthropicKey) { providers.push((sig) => anthropicCoverFactory(question, category, candidateContext, anthropicKey, sig, tier)()); names.push('haiku'); }
  if (providers.length === 0) return '';

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
  let winner = -1;
  let launched = 0;
  const claim = (i) => () => {
    if (winner !== -1) return false;
    winner = i;
    return true;
  };

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

  const attempt = async (i) => {
    // Hedges wait their turn, then re-check. Deciding at launch time
    // rather than up front is the whole point: if the primary already
    // spoke, the hedge must not run at all — on the paid backstop that
    // is the difference between insurance and a standing bill.
    if (i > 0) {
      await waitTurn(i);
      if (winner !== -1) return { i, text: '', failure: 'not needed' };
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
      const r = await runOne(providers[i], onToken, signal, firstDeadline, genMs, claim(i));
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
      if (!r.text && r.failure && r.failure !== 'lost the race' && r.failure !== 'not needed') {
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
  MIN_FLUSH_WORDS,
  generationWindowMs,
  _resetObservedTtft,
  _observedTtft,
};
