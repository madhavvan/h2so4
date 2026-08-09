// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AI PROXY — Server-side AI calls so API keys stay hidden
//  Supports: Gemini, OpenAI, xAI (Grok), Groq, Claude
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { requireTier } = require('../middleware/tier');
const { requireActiveSubscriptionInRegion } = require('../middleware/regionGate');
const db = require('../database');
const router = express.Router();

// All AI routes require authentication.
router.use(authMiddleware);

// India-region paid-required gate. Hard-blocks free/trial/expired/refunded
// users in regions where free tier is not available (currently only IN).
// Admin emails bypass. Past-due/canceling states pass through (grace
// window — Razorpay auto-retry / through-cycle access). Without this,
// an IN user could DevTools-bypass the client paywall and use Gemini
// (and our other AI keys) without paying. (See middleware/regionGate.js
// for the full policy + rationale.)
router.use(requireActiveSubscriptionInRegion);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CONTEXT STORE — upload-once knowledge base
//
//  The renderer used to inline the whole uploaded KB (up to 400K chars)
//  into the system prompt of EVERY request. Now it uploads the blob once
//  via POST /context and sends a ⟪CTX:<sha256>⟫ placeholder instead, so
//  request bodies stay ~4KB no matter how many files are attached. This
//  middleware swaps the stored text back in before any handler runs, so
//  every downstream route (and the model) sees the identical fully
//  assembled prompt it saw before — provider prompt caches keep hitting.
//
//  A miss (evicted / server restarted / different instance) returns a
//  retryable 409 `context_missing`; the client clears its upload cache
//  and re-sends the full inline text once. Nothing breaks mid-interview.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const contextStore = require('../services/contextStore');

router.post('/context', (req, res) => {
  const { text, hash } = req.body || {};
  const result = contextStore.put(req.user?.id, text, hash);
  if (!result.ok) {
    const status = result.error === 'text_too_large' ? 413 : 400;
    return res.status(status).json({ error: result.error });
  }
  res.json({ ok: true, hash: result.hash, deduped: result.deduped });
});

// ── "I'm finished with those documents" ──
//
// The store had no way to be told this. Entries expired on a three-hour
// TTL, so after a user deleted their files, started a new conversation or
// signed out, their resume stayed resident on the server for the rest of
// that window with nothing referencing it. A TTL is a backstop against
// leaks, not a retention policy — the client knows the moment the knowledge
// base is gone, and it should be able to say so.
//
// Idempotent, unauthenticated beyond the router's own auth, and scoped to
// the caller: a user can only ever forget their own blobs.
router.post('/context/forget', (req, res) => {
  const dropped = contextStore.forgetUser(req.user?.id);
  res.json({ ok: true, dropped });
});

router.use((req, res, next) => {
  try {
    const userId = req.user?.id;
    const body = req.body;
    if (!userId || !body || typeof body !== 'object') return next();
    // ONE budget for all three fields. Per-call budgets would let a request
    // spend the whole ceiling three times over (systemInstruction + prompt +
    // messages), and the expansion is what we're bounding — not the field.
    const budget = contextStore.newResolveBudget();
    if (typeof body.systemInstruction === 'string') {
      body.systemInstruction = contextStore.resolveText(userId, body.systemInstruction, budget);
    }
    if (typeof body.prompt === 'string') {
      body.prompt = contextStore.resolveText(userId, body.prompt, budget);
    }
    if (Array.isArray(body.messages)) {
      body.messages = contextStore.resolveMessages(userId, body.messages, budget);
    }
    next();
  } catch (err) {
    if (err && err.code === 'CONTEXT_MISSING') {
      return res.status(409).json({
        error: 'context_missing',
        message: 'Uploaded context is no longer cached — resend it inline.',
      });
    }
    // Answered here rather than by falling through to next(err): the global
    // handler responds 500 unconditionally, and a 500 reads as "our fault,
    // retry" — which for this one is the opposite of what the client should do.
    if (err && err.code === 'CONTEXT_TOO_LARGE') {
      return res.status(413).json({
        error: 'context_too_large',
        message: 'Too many context placeholders in one request.',
      });
    }
    next(err);
  }
});

// ─── Free-tier daily quota for Gemini ─────────────────────────────────
// Free tier IS supposed to have Gemini access (documented), but until
// now there was no per-user daily cap. With the JWT-signature-not-
// verified pre-pass on the AI rate limiter, an attacker could forge a
// JWT and burn Google quota on our dime. This middleware uses the LIVE
// license tier (not the JWT's stale `req.user.tier`) and applies the
// 50/day cap from incrementAndCheckGeminiQuota only to free users.
function geminiQuotaGate(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const license = db.getLicenseByUserId(userId);
    const liveTier = license?.tier || 'free';
    const result = db.incrementAndCheckGeminiQuota(userId, liveTier);
    if (!result.ok) {
      return res.status(429).json({
        error: 'gemini_quota_exceeded',
        used: result.used,
        limit: result.limit,
        day: result.day,
        message: `Free tier is limited to ${result.limit} Gemini calls/day. Upgrade to Basic or higher for unlimited access.`,
      });
    }
    next();
  } catch (err) {
    console.warn('[gemini-quota] gate threw:', err && err.message);
    next(); // fail-open on quota infra errors — don't break the user's session
  }
}

// ─── Time-remaining gate (2026-07 policy) ─────────────────────────────
// The free tier is a ONE-TIME 10-minute trial (all models except Claude);
// once the trial bucket hits 0 NOTHING is free. Basic/Pro/Max draw from
// their paid credit bucket and hit the same 402 when it empties. Ultra,
// admins, and legacy unlimited licenses (credits/expiry -1 sentinels →
// resolveTimeBucket 'unlimited') bypass. Applied as the LAST middleware
// on every model route (chat + stream, all five providers) — NOT on
// /prefetch-context, /deepgram-key, or autotype-* (those are covered by
// their own gates and don't map 1:1 to interview minutes).
//
// FAIL OPEN: this app runs during live interviews. A DB blip inside this
// gate must never break a paying user's session — any internal error logs
// and lets the request through. Denial happens ONLY on a positively
// resolved empty bucket.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// Paid-plan lapse predicate — the SAME two checks requireTier applies to
// paid tiers (hasAccess status + expires_at), shared via
// services/subscriptionStates so the gemini routes (which deliberately
// carry no requireTier) and /usage/start deny a LAPSED plan the way every
// tiered route already does. Free rows are exempt by design: their status
// sits at 'trial' forever and their real wall is the trial bucket (the
// pinned free-trial contract in test/free-trial-gate-chain.test.js).
// Without this, a refunded/expired paid license kept riding the ungated
// Gemini route (and kept opening usage sessions) as long as its credit
// window hadn't lapsed — while all other model routes 403'd. The client
// reverts lapsed plans to Free features, so this closes the one
// "server allows it but client hides it" hole.
const { hasAccess, isPlanLapsed } = require('../services/subscriptionStates');

// ── The clock must be RUNNING, not merely non-empty ──────────────────
//
// requireTimeRemaining below asks "does this account have time left".
// That is not the same question as "is this account being charged right
// now", and the gap between them was a free ride: leave the mic off, and
// no session opens, so nothing is charged — but every model route still
// answered, because it only ever checked the balance. A trial user could
// type questions indefinitely and never lose a second of their ten
// minutes.
//
// So: one rule, everywhere. The session switch is the mic on the desktop
// and the Start button on the phone; while it is on you are charged, and
// only while it is on will the models answer. There is no second
// currency to reconcile and nothing for a client to get wrong, because
// the answer lives here rather than in any app's UI — hiding a Send
// button stops honest users, not a hand-written request.
//
// Deliberately NOT applied to the /autotype-* routes. Those are Ultra
// only, Ultra is unlimited, so there is no free ride to close there —
// and gating them would break typing code out of an answer you opened
// yesterday, with the mic sensibly off.
// Both version gates in this file (the session gate below, and the LLM
// cover in runCover) ask the same question: is this caller new enough to
// take part in a protocol it has to understand? That question, the header
// it reads, and the reasoning for why it is safe to gate on a spoofable
// value all live in one place now — two copies of a comparison is exactly
// how the two ends of a gate drift apart.
const {
  participatesInProtocol, MIN_PROTOCOL_CLIENT, versionRank, CLIENT_VERSION_HEADER,
} = require('../middleware/clientVersion');

// Kept as a named constant because the tests and the app release both refer
// to it: the shipped app version must be >= this or every gate here stays
// dormant forever.
//
// ⚠️ HELD ONE RELEASE AHEAD OF THE COVER — DELIBERATELY DORMANT (2026-08-08).
//
// This was `= MIN_PROTOCOL_CLIENT`, so shipping 4.0.19 armed the session gate
// and the LLM cover together. Within the hour a user reported the popout
// saying "Turn the mic on to start your session" WHILE THE MIC WAS ON, with
// answers still arriving in between — the gate refusing intermittently
// mid-interview.
//
// Cause is NOT the gate's logic; it is that "is a session live" is a
// SERVER-side row while the app has TWO renderers. The popout is a separate
// BrowserWindow with its own creditTimerService, mirroring the main window's
// mic through remoteIsListening. /usage/start RESUMES only inside
// USAGE_START_RESUME_MS (10s) and SUPERSEDES after that — and a user pops out
// minutes into an interview, so the popout's start supersedes the main
// window's session. When the popout's mirrored isListening then dips, its 8s
// debounce fires stop(), which settles the session it owns. The main window
// still holds intervalId, so its start() no-ops and it heartbeats a row that
// is already ended: no live session anywhere, mic still on, 428.
//
// The gate is correct and the cover is unrelated, so they are decoupled here
// rather than switching both off: the cover keeps running for 4.0.19, and the
// gate stays dormant until the two renderers can no longer fight over one
// session row. Re-arm by setting this back to MIN_PROTOCOL_CLIENT in the same
// release that ships the single-owner fix.
// ⚠️ MOVED 4.0.20 → 4.0.21 when 4.0.20 was cut — see the note on
// LLM_COVER_MIN_CLIENT. 4.0.20 DOES carry the single-owner fix below, but a
// gate is not armed in the same release that fixes it: 15k interviews start
// Monday, and "fixed in this build" and "proven in the field" are different
// claims. Arm it once 4.0.20 has run real traffic.
const SESSION_GATE_MIN_CLIENT = '4.0.21';

// ⚠️ THE LLM COVER IS HELD BACK TOO — DORMANT (2026-08-08).
//
// runCover is AWAITED before the main provider call on every streaming
// route, so when the client sends NO local opener the model round-trip is
// added to the answer. Measured from the deployed code via planCoverFor,
// 13 of 20 provider × question-shape combinations fire a cover:
//
//     gemini deep          +2000ms      openai deep          +2000-2800ms
//     openai shallow/high  +2800ms      xai shallow          +2800ms
//     xai deep             +4500ms      groq (any)           +4500ms
//     claude                  never (fast enough that no plan is made)
//
// Before 4.0.19 every one of those was 0ms, because runCover returned ''
// at the version gate. So 4.0.19 added up to 4.5s in front of an answer —
// and if the grounding guard then rejects the cover, that time buys the
// user NOTHING: the cover is dropped and the main answer starts late.
// That is the "sometimes getting late responses" report, hours after
// shipping, with 15k interviews on Monday.
//
// The feature is sound and the local opener (step 1 of runCover) is the
// part users actually feel — it costs 0ms and is NOT gated by this. What
// is unproven is the LLM fallback under real traffic. So it is held at a
// version nothing reports yet, exactly like the session gate, rather than
// disabled: re-arm by setting this to MIN_PROTOCOL_CLIENT once the cover
// has been measured end-to-end against live traffic (its own TTFT, its
// guard-rejection rate, and the main answer's TTFT behind it).
// ⚠️ MOVED 4.0.20 → 4.0.21 when 4.0.20 was cut. A held threshold set to the
// NEXT version arms itself the moment that version ships — the hold has to
// stay ahead of the release, not sit on it. The reachability test below is
// what catches this; it is the same shape as the bug that left the whole
// cover engine dormant, pointed the other way.
const LLM_COVER_MIN_CLIENT = '4.0.21';

/** Is this caller new enough for the LLM COVER specifically? */
function clientAtLeastLlmCover(req) {
  const want = versionRank(LLM_COVER_MIN_CLIENT);
  if (want === null) return false;
  const rank = typeof req.clientRank === 'number'
    ? req.clientRank
    : versionRank(req.headers && req.headers[CLIENT_VERSION_HEADER]);
  return rank !== null && rank >= want;
}

/**
 * Is this caller new enough for the SESSION GATE specifically?
 *
 * Mirrors participatesInProtocol but reads SESSION_GATE_MIN_CLIENT, so the
 * gate and the cover can sit on different releases. Works whether or not the
 * clientVersion middleware ran, for the same reason that one does: a gate
 * must not be defeatable by a missing mount. Unparseable / absent → null,
 * and `null >= n` is false, so such a caller is treated as old and NOT gated.
 */
function clientAtLeastSessionGate(req) {
  const want = versionRank(SESSION_GATE_MIN_CLIENT);
  if (want === null) return false; // a bad threshold must never enforce
  const rank = typeof req.clientRank === 'number'
    ? req.clientRank
    : versionRank(req.headers && req.headers[CLIENT_VERSION_HEADER]);
  return rank !== null && rank >= want;
}

function requireActiveSession(req, res, next) {
  try {
    if (ADMIN_EMAILS.includes((req.user?.email || '').toLowerCase())) return next();
    if (db.hasLiveUsageSession(req.user.id)) return next();

    // ── DO NOT 428 A CLIENT THAT CANNOT READ IT ──
    //
    // This gate is new. Every install older than SESSION_GATE_MIN_CLIENT has
    // zero handling for 428/session_required — grep v4.0.18's aiProxyService
    // and App.tsx and you find neither string — so to those users a refusal
    // here is not "start your session", it is a dead assistant mid-answer.
    //
    // The fleet updates over days, not at deploy time, so there is always a
    // window where the server is new and the client is not. On 2026-07-29 a
    // deploy landed in exactly that window and had to be reverted inside 14
    // minutes. This is the same shape, so it gets the same respect: the gate
    // enforces only where it can be understood, and stays quiet elsewhere.
    //
    // Cost of staying quiet: an old client with the mic off keeps getting
    // answers it is not charged for — the free ride this gate exists to
    // close. That leak shrinks to nothing as the fleet updates, and a
    // temporary billing leak is strictly cheaper than a silent outage during
    // someone's interview.
    //
    // Absent header = an old client (nothing before 4.0.19 sends one).
    //
    // Compared against SESSION_GATE_MIN_CLIENT, NOT participatesInProtocol:
    // this gate is held one release behind the cover on purpose (see the
    // constant). Using the shared helper here is what coupled them.
    // versionRank(null) is null and null >= anything is false, so a missing
    // or junk header still resolves to "old" — the safe direction.
    if (!clientAtLeastSessionGate(req)) {
      console.warn(
        `[requireActiveSession] not enforcing for client ${req.clientVersion || '(no version header)'} ` +
          `user=${req.user?.id} — pre-${SESSION_GATE_MIN_CLIENT} clients cannot render a 428`
      );
      return next();
    }
    // 428 Precondition Required — literally "do this first". Distinct
    // from no_time_remaining (402) and tier_required (403) because this
    // user may have plenty of time and the right plan; they simply have
    // not started. The client turns it into "start your session", never
    // into a paywall.
    //
    // NOT 409: that is already taken by context_missing, which the
    // desktop treats as "re-upload and retry automatically". A session
    // gate answered with 409 would be retried into the same refusal.
    return res.status(428).json({
      error: 'session_required',
      message: 'Start your session to use the models.',
    });
  } catch (err) {
    // Fail OPEN. A database hiccup must never silence the assistant in
    // the middle of a live interview; the worst case is a few unbilled
    // answers, which is strictly better than the alternative.
    console.error('[requireActiveSession] failing open:', err.message);
    return next();
  }
}

function requireTimeRemaining(req, res, next) {
  try {
    if (ADMIN_EMAILS.includes((req.user?.email || '').toLowerCase())) return next();
    // requireTier already attached req.license on the tiered routes; the
    // gemini routes (quota-gated, no tier gate) look it up here.
    const license = req.license || db.getLicenseByUserId(req.user.id);
    // No license row → let the tier/region gate own that case (don't
    // double-deny with a confusing 402 on top of their 403).
    if (!license) return next();
    // Lapsed paid plan → the RENEW-shaped 403 (matches requireTier's copy
    // exactly, so the client's lapse handling sees one consistent shape).
    // On the tiered routes requireTier already denied before we run, so
    // this only ever fires for the gemini chain. Positively-resolved
    // deny only — internal errors still fail open below.
    if (isPlanLapsed(license)) {
      return res.status(403).json({
        error: 'tier_required',
        current: license.tier,
        current_status: hasAccess(license.status) ? 'lapsed' : license.status,
        message: 'Your subscription has expired. Please renew to continue.',
      });
    }
    const bucket = db.resolveTimeBucket(license);
    if (bucket.source === 'unlimited') return next();
    if (bucket.remaining <= 0) {
      return res.status(402).json({
        error: 'no_time_remaining',
        source: bucket.source,
        message: bucket.source === 'trial'
          ? 'Your 10-minute free trial is used up. Pick a plan to keep going.'
          : 'Your interview time is used up. Extend or buy another interview to continue.',
      });
    }
    next();
  } catch (err) {
    console.warn('[time-gate] threw:', err && err.message);
    next(); // FAIL OPEN — never break a live interview on an internal error
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  FRESH_CONTEXT injection helpers
//
//  When a chat call comes in, we classify the user's latest message
//  (the live transcript) — if it looks tool/UI/version-specific,
//  freshContext.enrichTranscript() fetches authoritative snippets
//  via Brave Search. The snippets get prepended to the system
//  instruction as a <FRESH_CONTEXT> block so the model grounds its
//  answer in current evidence instead of stale training memory.
//
//  Latency: ~5ms on cache hit, ~500ms on miss. Brave free tier
//  covers ~100 interviews/month; paid is $3/1k beyond.
//
//  Fail-open: if Brave is unreachable or BRAVE_API_KEY missing,
//  enrichTranscript returns null and the chat proceeds unmodified.
//  The caller never sees a retrieval error.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const { enrichTranscript, classify: needsLiveFacts } = require('../services/freshContext');

// Pull the most recent user-role message from a messages array.
// Used by all "messages: [...]"-shaped routes (OpenAI/xAI/Groq/Claude).
//
// Handles BOTH content shapes:
//   - string (history turns)
//   - multimodal part-array (the FINAL user turn: [{type:'text',text},
//     {type:'image_url',...}] on OpenAI-compatible routes, or
//     [{type:'text',text},{type:'image',...}] on the Claude route)
// The string-only version silently skipped the final array-shaped turn
// and fell back to the PREVIOUS turn's text — so chat-time enrichment
// and auto-effort classification ran on the wrong question.
function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .filter(p => p && p.type === 'text' && typeof p.text === 'string')
        .map(p => p.text)
        .join('\n');
      if (text) return text;
    }
  }
  return '';
}

// Strip a composed prompt down to the ACTUAL current question.
//
// The renderer wraps the live transcript in a large RESPONSE RULES block
// plus chat history and task framing before it reaches these routes.
// Classification (fresh-context + auto reasoning depth) must run on the
// QUESTION, not the wrapper:
//   - the rules block itself contains example phrases ("tell me about a
//     time...", "what's new in Python 3.13") that misclassify every call;
//   - the Brave cache key must equal what /prefetch-context stored, which
//     is the RAW transcript — a rules-laden key never hits that cache.
//
// Shapes handled (in priority order):
//   1. "...Interviewer (Current Audio): <q>..."   (gemini/xai/groq/claude
//      paths — history lines say "Interviewer (Transcript):", so taking
//      the LAST "Current Audio" marker isolates the live question)
//   2. "...<<<END RESPONSE RULES>>>\n\n---\n\n<q>..."  (openai path — no
//      audio marker; the question sits right after the rules terminator)
//   3. plain text (auto-solve, internal callers) — returned unchanged
// Trailing task framing / KB-hint blocks appended after the question are
// cut regardless of which shape matched.
function extractCurrentQuestion(text) {
  let s = String(text || '');
  const audioMarker = 'Interviewer (Current Audio):';
  const audioIdx = s.lastIndexOf(audioMarker);
  if (audioIdx !== -1) {
    s = s.slice(audioIdx + audioMarker.length);
  } else {
    const rulesEnd = '<<<END RESPONSE RULES>>>';
    const endIdx = s.lastIndexOf(rulesEnd);
    if (endIdx !== -1) s = s.slice(endIdx + rulesEnd.length).replace(/^[\s-]+/, '');
  }
  for (const stop of ['\n\nTask:', '\n\n[Remember:', '\n\n[Anchor', '\n\nRemember:']) {
    const i = s.indexOf(stop);
    if (i !== -1) s = s.slice(0, i);
  }
  return s.trim();
}

// Wrapper that NEVER throws — callers inline-await without try/catch.
// On any failure (classifier exception, SQLite locked, etc.), returns
// null and we skip injection. Logs the outcome for observability.
//
// CRITICAL: chat-time enrichment is CACHE-ONLY. We never trigger a
// live Brave call or page fetch from the chat path — that would block
// the model call by 500-2000ms on cold paths, which the user feels as
// a latency regression vs. the pre-retrieval baseline. Live work
// happens ONLY in /prefetch-context (async, 202'd, populates caches
// in the background while the user is still hearing the question).
//
// Net behavior:
//   - Cache hit → ~5ms, FRESH_CONTEXT injected, model gets grounded
//   - Cache miss → ~5ms, no enrichment, model uses training memory
//   - Brave down / no API key / timeout / etc. → never reached
//     because we don't fire live calls here
//
// User experience: ALWAYS the same speed. Web search is purely
// additive — it makes hits exceptional, but misses still answer.
async function tryEnrich(transcript, requestId) {
  try {
    const r = await enrichTranscript(transcript, { cacheOnly: true });
    if (r && r.context) {
      const tag = r.cached ? (r.stale ? 'stale-cache' : 'cache-hit') : 'fresh';
      const preview = String(transcript || '').slice(0, 80).replace(/\s+/g, ' ');
      console.log(`[fresh-context] ${tag} (${(r.sources || []).length} src) for "${preview}" req=${requestId || '-'}`);
    }
    return r;
  } catch (err) {
    console.warn('[fresh-context] enrich threw (fail-open):', err && err.message);
    return null;
  }
}

// Attach FRESH_CONTEXT to the request WITHOUT touching the system prompt.
//
// It used to be PREPENDED to the system instruction — which mutated the
// byte-prefix of every call whenever fresh context appeared (or stopped
// appearing). Every provider keys its prompt cache on a stable prefix
// (OpenAI automatic caching, Gemini implicit caching, xAI cached-input,
// Anthropic cache_control, Groq prefix cache) — so that prepend forced a
// full re-prefill of the multi-thousand-token KNOWLEDGE BASE system
// prompt on almost every turn. With big context files, that re-prefill
// IS the multi-second "reading your files" latency users feel.
//
// The block now rides at the END of the final user message, adjacent to
// the question it grounds. The static system prompt stays byte-stable
// for the whole session (cache hits from turn 2 onward), and the
// evidence gains salience — recency + user role outrank a system-prompt
// preamble (same rationale as buildUserRulesBlock on the client).
function appendFreshToPrompt(prompt, freshContext) {
  if (!freshContext) return prompt;
  const base = String(prompt || '');
  return base ? `${base}\n\n${freshContext}` : freshContext;
}

// Append a text block to the LAST user message — the ONLY sanctioned way
// to add per-turn material (fresh context, cover-answer continuation
// instructions) to a request. Never touch the system prompt: its
// byte-stability is what keeps provider prompt caches hot.
// Handles both content shapes — plain string, and the multimodal
// part-array of the final turn ({type:'text',text} is the same key on
// OpenAI-compatible and Anthropic shapes). Returns a shallow copy; the
// caller's array is never mutated. Unknown shapes pass through untouched
// (fail-open — losing an augment must never break a live interview).
function appendTextToLastUserMessage(messages, text) {
  if (!text) return messages;
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const copy = messages.slice();
  for (let i = copy.length - 1; i >= 0; i--) {
    const m = copy[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') {
      copy[i] = { ...m, content: appendFreshToPrompt(m.content, text) };
    } else if (Array.isArray(m.content)) {
      copy[i] = { ...m, content: [...m.content, { type: 'text', text }] };
    } else {
      return messages;
    }
    return copy;
  }
  return messages;
}

function appendFreshToMessages(messages, freshContext) {
  return appendTextToLastUserMessage(messages, freshContext);
}

// ── Upstream 429 detection ──
// Each provider SDK surfaces rate-limit errors slightly differently.
// We unify the detection here so every route can branch the catch
// uniformly: "is this an upstream rate-limit?" → return 429 to client
// with a provider-specific message, instead of swallowing it as a
// generic 500. The user-facing experience matters because "rate
// limited, try again" is actionable; "AI request failed" isn't.
function is429(err) {
  if (!err) return false;
  if (err.status === 429 || err.statusCode === 429 || err.code === 429) return true;
  if (err.code === 'rate_limit_exceeded') return true;
  if (err?.error?.code === 'rate_limit_exceeded') return true;
  if (err?.error?.error?.type === 'rate_limit_error') return true;  // Anthropic
  const msg = String(err.message || '');
  if (/\b429\b/.test(msg)) return true;
  if (/rate.?limit/i.test(msg)) return true;
  if (/RESOURCE_EXHAUSTED/.test(msg)) return true;  // Gemini / Vertex
  if (/quota.*exceeded/i.test(msg)) return true;
  return false;
}

// Build a uniform 429 response body for the client. The renderer's
// existing error toast appends "(Rate limited - please wait)" when it
// sees status 429 — this gives the user an actionable message instead
// of "AI request failed" which is what they see today.
function rateLimitedJson(provider) {
  return {
    error: `${provider} rate-limited — give it a few seconds and try again.`,
    provider,
    code: 'rate_limit',
  };
}

// ── Tier gate aliases ──
// Mirrors services/licenseService.ts FEATURE_GATES.models, in shorthand.
// The 2026-07 pricing overhaul re-laddered model access:
//   - TRIAL_MODELS→ free + all paid tiers      (GPT-5.6, Grok, Groq — every model
//                    except Claude; 'free' only counts while the one-time
//                    10-minute trial bucket has seconds, enforced by
//                    requireTimeRemaining → 402 at 0)
//   - PAID        → basic + pro + max + ultra  (kept for non-trial paid gates)
//   - CLAUDE_TIERS→ pro + max + ultra          (Claude Sonnet 5 — Basic and the
//                    free trial both exclude Claude)
//   - ULTRA_ONLY  → ultra only                 (Auto-Type — the Ultra-exclusive feature)
// Free tier (2026-07): the 10-minute trial covers the four non-Claude
// models; after it nothing is free — Gemini included (it stays behind
// geminiQuotaGate + the time gate). Defined here so adding a new model
// route only requires picking the right gate, not hand-listing tiers.
const TRIAL_MODELS = ['free', 'basic', 'pro', 'max', 'ultra'];
const PAID = ['basic', 'pro', 'max', 'ultra'];
const CLAUDE_TIERS = ['pro', 'max', 'ultra'];
const ULTRA_ONLY = ['ultra'];
//   - TRAIN_TIERS → max + ultra                 (Train Model — the Max
//                    differentiator, sold as "Max+" on every pricing
//                    surface and mirrored by FEATURE_GATES.trainModel)
const TRAIN_TIERS = ['max', 'ultra'];

// TODO(owner-decision): the 10-minute free trial is currently NOT available
// in India. requireActiveSubscriptionInRegion (mounted above via router.use)
// hard-403s any non-paid license for country_code='IN' BEFORE the TRIAL_MODELS
// carve-outs below ever run — an IN free signup never reaches the trial gates.
// If the owner wants IN signups to get the same one-time 10-minute trial, that
// is a regionGate.js POLICY change (e.g. allow tier='free' while
// trial_remaining_seconds > 0), not a change here. Deliberately left as-is per
// the 2026-07 policy freeze: do NOT silently widen free access in IN.

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  /models — which models may THIS account use?
//
//  The desktop answers this for itself from its licence, and publishes
//  the result to the phone over the mirror. That works right up to the
//  case that matters most: a phone that has never seen a computer —
//  someone who just installed it, or an App Store reviewer. It knows
//  only that Gemini exists on every plan, so a rate-limited Gemini is a
//  dead end on their very first question.
//
//  Answered here rather than re-derived on the phone because the tier
//  lists below are the SAME constants the model routes gate on. Any
//  other source — a copy of the client's feature table, a guess from the
//  tier string — is a second opinion that can disagree with the routes,
//  and the way it fails is offering someone a model they will be refused.
//
//  Display names are the phone's problem, not ours; it already has the
//  computer's labels and falls back to the key.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/models', (req, res) => {
  try {
    const email = (req.user?.email || '').toLowerCase();
    const isAdmin = ADMIN_EMAILS.includes(email);
    const license = db.getLicenseByUserId(req.user.id);
    const tier = isAdmin ? 'ultra' : (license?.tier || 'free');

    const allow = (tiers) => isAdmin || tiers.includes(tier);
    // Order matters — the phone uses the first as its default and the
    // rest, in order, as fallbacks when a provider is busy.
    //
    // Gemini is unconditional, and that is not a fudge: /stream/gemini
    // carries geminiQuotaGate, NOT requireTier, so it genuinely has no
    // tier requirement. Deriving it from TRIAL_MODELS instead would hand
    // an unrecognised tier an EMPTY list — a phone with no models at all,
    // which is indistinguishable from a broken app.
    const models = ['gemini'];
    if (allow(TRIAL_MODELS)) models.push('openai', 'xai', 'groq');
    if (allow(CLAUDE_TIERS)) models.push('claude');

    res.json({ tier, models });
  } catch (err) {
    console.error('[ai/models] error:', err.message);
    // Never leave the caller with nothing: Gemini is on every plan, so
    // the safe answer is the one the phone would have assumed anyway.
    res.json({ tier: 'free', models: ['gemini'] });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  /prefetch-context — speculative cache warming during transcription
//
//  Pattern: while the interviewer is still speaking and the renderer
//  is transcribing word-by-word, the renderer fires this endpoint
//  every ~500ms (debounced) with the current partial transcript. The
//  endpoint returns 202 IMMEDIATELY and runs enrichTranscript() in the
//  background, populating the Brave cache + page-content cache. By
//  the time the user hits Send and the real /chat/* route fires, the
//  caches are warm — the enrichment that would have cost ~1500ms cold
//  now costs ~10ms (cache hit).
//
//  Net effect: same perceived speed as before, but with rich grounded
//  fresh-context in every model call instead of stale training data.
//
//  Server-side dedup: same query within 30s = no-op. The renderer's
//  500ms debounce already limits the rate, but as the transcript
//  grows ("what tabs", "what tabs in AWS", "what tabs in AWS Glue"),
//  multiple slightly-different queries fire. We dedup at the exact-
//  query level — partial overlaps still fire because their fingerprints
//  differ (and they probably reach different docs pages anyway, so the
//  page cache picks them up).
//
//  Rate limiting: relies on the global aiLimiter middleware
//  (90/min/user). No separate bucket — keeping it simple.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Dedup map: normalized-query → last-fired-at. 30s TTL.
const PREFETCH_DEDUP_TTL_MS = 30_000;
const _prefetchDedup = new Map();

function _shouldDedupPrefetch(transcript) {
  const key = String(transcript || '').trim().toLowerCase().slice(0, 500);
  if (!key) return true;
  const now = Date.now();
  const last = _prefetchDedup.get(key);
  if (last && now - last < PREFETCH_DEDUP_TTL_MS) return true;
  _prefetchDedup.set(key, now);
  // Periodic cleanup so the map doesn't grow unbounded across long sessions.
  if (_prefetchDedup.size > 1000) {
    const cutoff = now - PREFETCH_DEDUP_TTL_MS;
    for (const [k, ts] of _prefetchDedup) {
      if (ts < cutoff) _prefetchDedup.delete(k);
    }
  }
  return false;
}

router.post('/prefetch-context', async (req, res) => {
  const { transcript } = req.body || {};
  if (!transcript || typeof transcript !== 'string' || transcript.length < 10) {
    return res.status(400).json({ error: 'transcript required (min 10 chars)' });
  }

  // Dedup: don't refire the exact same query inside 30s.
  if (_shouldDedupPrefetch(transcript)) {
    return res.status(202).json({ ok: true, deduped: true });
  }

  // 202 IMMEDIATELY — caller never blocks on retrieval. The work
  // continues in the event loop; cache writes happen as side effects.
  res.status(202).json({ ok: true, queued: true });

  // Fire-and-forget. We don't await this — the response is already
  // sent, but the promise continues executing until enrichTranscript
  // finishes (Brave search + page fetch + cache writes).
  const requestId = req.headers['x-request-id'] || `pf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  Promise.resolve().then(() => enrichTranscript(transcript))
    .then(result => {
      if (!result) return;
      const dfLen = result.deepFetch?.contentLength || 0;
      const tag = result.cached ? (result.stale ? 'stale-cache' : 'cache-hit') : 'fresh';
      const preview = String(transcript || '').slice(0, 60).replace(/\s+/g, ' ');
      console.log(`[prefetch] ${tag} deep=${dfLen}ch authority=${result.authority || '-'} "${preview}" req=${requestId} user=${req.user?.id || '-'}`);
    })
    .catch(err => {
      console.warn(`[prefetch] enrich failed req=${requestId}:`, err && err.message);
    });
});

// Test hook — exposes the dedup helper so test code can reset state
// between cases. Only used by Vitest.
function _resetPrefetchDedup() { _prefetchDedup.clear(); }

// ── Gemini ──
router.post('/chat/gemini', geminiQuotaGate, requireTimeRemaining, requireActiveSession, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Gemini not configured' });

  try {
    const { prompt, systemInstruction, history, fileParts } = req.body;
    // Strip rules/history framing before classification + retrieval —
    // both must see the raw live question (see extractCurrentQuestion).
    const question = extractCurrentQuestion(prompt);
    const fresh = await tryEnrich(question, req.headers['x-request-id']);
    // Cache-preserving injection: systemInstruction stays byte-stable so
    // Gemini's implicit prompt cache absorbs the KNOWLEDGE BASE after the
    // first call; evidence rides with the question instead.
    const enrichedPrompt = appendFreshToPrompt(prompt, fresh?.context);
    const deepQuestion = DEEP_CATEGORIES.has(classifyQuestion(question).category);

    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    const parts = [];
    // Add binary file parts (images/PDFs)
    if (fileParts && fileParts.length > 0) {
      fileParts.forEach(fp => parts.push({ inlineData: { mimeType: fp.mimeType, data: fp.data } }));
    }
    parts.push({ text: enrichedPrompt });

    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: systemInstruction || '',
        // Gemini 3.x: temperature/top_p/top_k are deprecated — ignored
        // today, HTTP 400 in future generations — so they're omitted.
        // Thinking defaults to 'medium' on 3.6-flash (seconds of dead air
        // before a live answer). Depth-matched instead: deep analytical
        // shapes get LOW (measured TTFT ~1.5s / total ~2.3s — inside the
        // ≤4s live budget), everything else the MINIMAL floor (~0.7s
        // TTFT). Uppercase values are the SDK's canonical ThinkingLevel
        // enum wire form (@google/genai).
        thinkingConfig: { thinkingLevel: deepQuestion ? 'LOW' : 'MINIMAL' },
      }
    });

    res.json({ text: response.text || '' });
  } catch (err) {
    if (is429(err)) {
      console.warn('[gemini] upstream 429:', err.message);
      return res.status(429).json(rateLimitedJson('Gemini'));
    }
    console.error('Gemini proxy error:', err.message);
    res.status(500).json({ error: 'AI request failed', detail: err.message });
  }
});

// ── OpenAI (GPT) ──
// GPT-5.6 reasoning_effort knob. Accepted values for gpt-5.6 are
// `none, low, medium, high, xhigh, max` — `minimal` is gpt-5-only and
// returns HTTP 400 here. The client (App.tsx) sends the user's
// chosen level in `req.body.reasoning_effort`; resolveReasoningEffort
// validates the input AND tier-gates it: only Max/Ultra users (and
// admins) can pick anything other than 'none'. Without the tier gate,
// a tampered client could escalate to 'high' on a basic/pro plan.
//
// We deliberately do NOT pass `verbosity` — that parameter is on
// the Responses API surface and openai-node's chat.completions
// types only accept it inconsistently across versions. Passing it
// would risk 400'ing every paid user. (See openai-python #2610.)
//
// Temperature is still omitted — the GPT-5.x reasoning family rejects
// any non-default value with HTTP 400. Same for top_p /
// presence_penalty / frequency_penalty / logprobs.
//
// GPT-5.6 note: on /v1/chat/completions, function tools are rejected
// whenever reasoning_effort != 'none'. These routes never pass tools,
// so every effort level stays valid here — but if tools are ever added
// to the OpenAI path, move it to the Responses API first.

// Allowed values for the chat.completions API on gpt-5.6. 'xhigh' and
// 'max' are supported by the model but intentionally not exposed to
// clients — avoids surprise bills if a UI bug ever sent one. 'auto' is a special
// pseudo-value that triggers question-shape-based effort selection
// (coding→low, system design→medium, etc.); it never reaches OpenAI.
const ALLOWED_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'auto'];

// Auto-effort mapping: question category → reasoning_effort value.
// 2026-07-22 depth-adaptive policy, measured on gpt-5.6 (streaming,
// realistic prompt sizes, 2 rounds):
//   'low'  → deep analytical shapes. Measured TTFT 2.5-3.2s — inside the
//            ≤4s live-answer budget — and the brief reasoning materially
//            improves correctness on code and multi-constraint design.
//   'none' → conversational / recall shapes where reasoning buys nothing.
//            Measured TTFT 0.8-1.9s.
// 'medium'/'high' are NEVER auto-picked: measured TTFT 3.6-8.9s blows the
// live budget. They remain available as explicit picks on the dial
// (Max/Ultra), where the user is knowingly trading speed for depth.
//
// Brave fresh-context still injects current evidence on top of whatever
// effort is chosen — freshness and depth are complementary here, not
// substitutes (the pre-2026-07 all-'none' policy treated them as
// substitutes; gpt-5.6's faster 'low' tier changed that math).
//
// Users who explicitly pick 'low' / 'medium' / 'high' on the dial are
// honored as-is; auto-pick fires only for 'auto' or a missing value.
const AUTO_EFFORT_BY_CATEGORY = {
  coding:         'low',
  system_design:  'low',
  ml_data:        'low',
  quantitative:   'low',
  strategy_case:  'low',
  behavioral:     'none',
  concept:        'none',
  clarifier:      'none',
  other:          'none',
};

// Categories whose auto effort is non-'none' — the single source of truth
// for "deep question". The Gemini routes reuse this to pick thinkingLevel
// LOW vs MINIMAL, so a future map tweak can't drift between providers.
const DEEP_CATEGORIES = new Set(
  Object.entries(AUTO_EFFORT_BY_CATEGORY)
    .filter(([, v]) => v !== 'none')
    .map(([k]) => k)
);

// ── Cover eligibility ──
// A cover (instant spoken opener) is worth firing for ANY real, substantive
// interview question — it's a cheap, fast Groq opener that kills dead air
// while the main answer forms. Deliberately DECOUPLED from reasoning depth:
// the classifier decides how HARD to think (coding/system-design → 'low');
// this decides whether to open the mouth first, which is yes for essentially
// every question. Previously the cover was tied to reasoning!=='none' OR a
// large raw-KB prompt — but KB retrieval made prompts small, so the
// large-prompt trigger vanished and any question the classifier scored
// 'none' (a system-design "pipeline" question it misreads, a behavioral
// "tell me about a challenging X") silently lost its cover. Gating on length
// alone is robust to every classifier gap: backchannels are already dropped
// client-side, and a sub-20-char input (one-word clarifier, stray noise)
// neither needs nor benefits from a spoken opener. Auto-Solve is excluded —
// its output is code typed straight into an editor.
function coverWorthy(question) {
  const q = String(question || '').trim();
  if (q.length < 20) return false;
  if (q.startsWith('Solve the coding problem')) return false;
  return true;
}

const { classifyQuestion } = require('../services/questionClassifier');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ONE COVER PATH, FIVE ROUTES
//
//  The cover used to be hand-wired into /stream/openai and /stream/claude
//  and nowhere else, on the reasoning that the other three models were
//  "fast enough that the main answer arrives before a cover would".
//  Measured (scripts/ttft-matrix.mjs), that reasoning had it backwards:
//
//    claude-sonnet-5   1.0-1.2s   ← had a cover
//    gpt-5.6 low       1.3-2.2s   ← had a cover
//    gemini LOW deep   4.1s       ← had none
//    grok-4.5 deep     18-32s     ← had none
//
//  The two routes with covers were the two FASTEST routes, and the model
//  that leaves a candidate silent for twenty seconds had nothing. Two
//  copies of the wiring is also how that kind of gap survives: a fix
//  applied to one copy is a fix half-applied.
//
//  So: one helper, every route, and the depth model decides per question
//  whether a cover is worth firing at all and how much the candidate
//  needs to say. Returns '' whenever there is no cover — a cover failure
//  of any kind degrades to exactly the pre-existing behavior.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE OPENER ARRIVES WITH THE REQUEST
//
//  The renderer composes the first sentence from its fact ledger before it
//  sends the question — in ~35 microseconds, out of spans of the user's own
//  documents (services/instantOpener.ts). When it does, this route has no
//  model to wait for: it writes the sentence and issues the main call
//  immediately.
//
//  That removes the whole reason the cover cost latency. `runCover` was
//  AWAITED before the main provider call, so its chain budget was added to
//  every answer: +1,200ms on openai and claude, +2,000ms on xai, +3,000ms
//  on groq. A local opener costs none of it.
//
//  `coverPolicy: 'suppress'` is the other half, and it is the fix for the
//  worst moment in the transcript. Asked "then why did you answer IBM?",
//  the old chain produced "That was based on my experience with their
//  systems at Accenture" — a second invented employer, to account for the
//  first — because a cover model is given the question and the resume and
//  no transcript, and is told never to deny anything. There is no opening
//  sentence that improves being challenged about a previous answer. The
//  client detects that shape and forbids a cover outright.
//
//  Length cap and control-character strip only. The text is derived from
//  the user's own uploaded documents by the user's own client, and can only
//  ever affect that user's answer — there is nothing here to authorise.
const OPENER_MAX_CHARS = 400;

function clientOpener(req) {
  const raw = req.body && req.body.instantOpener;
  if (typeof raw !== 'string') return '';
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > OPENER_MAX_CHARS) return '';
  return clean;
}

// The lines of the transcript the INTERVIEWER spoke, and only those.
//
// `recentTurns` arrives labelled from buildOpenerPayload on the client —
// "Interviewer: …" for the human, "You already said: …" for the candidate.
// What the interviewer said is external evidence and may widen the guard's
// vocabulary; what the app said last turn is a claim that may itself have
// been invented, and letting it back in is how a fabrication ends up
// vouching for its own sequel. Anything without the interviewer's label —
// including the head fragment a tail slice can leave behind — is not
// trusted, because being wrong in that direction costs a dropped cover and
// being wrong in the other costs a spoken lie.
//
// The mirror of interviewerLines() in services/instantOpener.ts. The two
// have to stay identical: server/test/grounding-parity.test.js exists
// because a client and a server that disagree about what is grounded are
// worse than either one alone.
function interviewerSaid(recentTurns) {
  return String(typeof recentTurns === 'string' ? recentTurns : '')
    .split('\n')
    .filter((line) => /^Interviewer:/.test(line.trim()))
    .join('\n');
}
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function runCover({ sse, req, question, provider, effort = 'none', webSearch = false }) {
  // ── 1. The client already knows what to say ──
  const local = clientOpener(req);
  if (local) {
    sse.send(local);
    sse.send(' ');
    console.log(`[cover] ${provider} user=${req.user?.id} LOCAL shape=${req.body?.coverShape || '-'} `
      + `words=${local.split(/\s+/).filter(Boolean).length} cost=0ms model=none`);
    return local;
  }

  // ── 2. An opener would make this moment worse ──
  if (req.body && req.body.coverPolicy === 'suppress') {
    console.log(`[cover] ${provider} user=${req.user?.id} SUPPRESSED shape=${req.body?.coverShape || '-'} `
      + `— the answer model has the transcript; an opener here can only guess`);
    return '';
  }

  if (!coverWorthy(question)) return '';
  // Measurement escape hatch. The depth model is calibrated on how long
  // the MAIN model takes, and once a cover is in front of it that number
  // is no longer observable — the first token on screen is the cover's.
  // This header turns the cover off for one request so the raw gap can be
  // re-measured through the real route, with the real prompt, whenever
  // the tiers need recalibrating (scripts/audit-gap-inapp.mjs). It can
  // only ever REMOVE a cover, so there is nothing here to abuse.
  if (req.headers['x-cover-disabled']) return '';

  // ── THE LLM COVER IS NOT SPENT ON A CLIENT THAT CANNOT RENDER IT ──
  //
  // Everything above this line is free: a client-supplied opener costs one
  // string lookup, and the suppress/worthiness checks are local. What
  // follows is a real model round-trip, and runCover is AWAITED before the
  // main model on every route — so for a client that cannot use the result
  // it is pure dead air in front of an answer that was already ready.
  //
  // The cover is a collaboration. The client sends coverContext (the facts
  // the opener may speak), coverVocabulary and coverShape, and renders the
  // opener ahead of the answer. Grep v4.0.18's aiProxyService for
  // `coverContext` and you get zero hits — so `candidateContext` arrives as
  // '' and the model is asked to open with nothing to stand on. Measured on
  // a system_design question: cost=1198ms, for a sentence that client will
  // never show and the grounding guard would be right to reject.
  //
  // That is the "sometimes taking time to give the answer" complaint that
  // started this work, about to be re-created for the whole installed fleet
  // by the change meant to fix it. The feature must only ever ADD speed —
  // see the `!plan` note below, which is the same rule applied to timing.
  // For a client that cannot use it, adding speed means doing nothing.
  //
  // ⚠️ HELD AT 4.0.20 — DORMANT ON PURPOSE (2026-08-08). See LLM_COVER_MIN_CLIENT.
  //
  // Everything ABOVE this line still runs, which is the point: the client's
  // locally-composed opener (step 1) is unaffected, so the fast path users
  // actually feel is untouched. Only the model round-trip below is held.
  if (!clientAtLeastLlmCover(req)) return '';

  const {
    streamCoverAnswer, planCoverFor, SPOKEN_WORDS_PER_SEC,
  } = require('../services/coverAnswer');

  const { category } = classifyQuestion(question);
  const deep = DEEP_CATEGORIES.has(category);
  const { gapMs, plan } = planCoverFor({ provider, deep, effort, webSearch });

  // No plan means the main model is predicted to beat the cover to the
  // screen. Firing anyway would cost the answer real milliseconds for a
  // sentence nobody needed — the feature must only ever ADD speed.
  if (!plan) return '';

  // ── HELD BACK UNTIL IT HAS BEEN CHECKED ──
  //
  // This used to be `onToken: (t) => sse.send(t)` — the model's words went
  // straight to the screen, and the screen is a person's mouth a fraction
  // of a second later. There is no way to unsay "I've spent several years
  // at IBM" once it has been forwarded, so the tokens are collected here
  // and released only after the whole sentence has been checked against
  // the knowledge base's vocabulary.
  //
  // The cost is the cover's own generation time before the first word,
  // which is the right trade on the only routes that still reach this
  // code: a plan exists here because the main answer is 9-50 seconds out
  // (grok, groq), so several hundred milliseconds buys a guarantee. The
  // fast routes are served by the client's local opener above and never
  // get this far.
  const t0 = Date.now();
  let held = '';
  const cover = await streamCoverAnswer({
    question,
    category,
    // The ledger DIGEST — every role, project, skill and metric in the
    // whole knowledge base in ~1-3KB, replacing the 9,000-char slice of a
    // single document that used to be sent here.
    candidateContext: typeof req.body?.coverContext === 'string' ? req.body.coverContext : '',
    // The last couple of exchanges. Without them a follow-up question is
    // unanswerable except by invention — see the RECENT_TURNS note in
    // coverAnswer.js.
    recentTurns: typeof req.body?.recentTurns === 'string' ? req.body.recentTurns : '',
    plan,
    groqKey: process.env.GROQ_API_KEY,
    geminiKey: process.env.GEMINI_API_KEY,
    // Paid backstop for the day both free tiers are rate-limited.
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    onToken: (t) => { held += t; },
    signal: sse.signal,
  });
  if (!cover) return '';

  // ── THE GUARD ──
  // A name the knowledge base does not contain, and that the interviewer
  // did not just say, was invented. Dropping the cover degrades to exactly
  // the pre-existing no-cover behaviour: the answer still arrives, a
  // little later, and nothing false was spoken.
  const { unverifiedProperNouns, hasBannedOpener, unverifiedNumbers } = require('../services/groundingGuard');
  const vocab = typeof req.body?.coverVocabulary === 'string' ? req.body.coverVocabulary : '';
  // The transcript counts as allowed vocabulary too: a name the interviewer
  // used two turns ago is theirs, not an invention. Adding it here is what
  // lets the cover answer a follow-up at all without being rejected for
  // echoing the thing being followed up on.
  //
  // ⚠️ HALF THE TRANSCRIPT, THOUGH. The candidate's own previous ANSWER is
  // in `recentTurns` as well, labelled "You already said:", and it was going
  // into `allowed` with everything else — so a name the model invented last
  // turn became trusted vocabulary this turn, and the sentence that explains
  // the invention sailed through the guard that had rejected the invention
  // itself. That is the IBM → Accenture cascade with the guard's own help,
  // and it bites hardest at the `vocab.trim() ? vocab : allowed` line below,
  // where `allowed` is not merely added to the knowledge base — it IS the
  // knowledge base. The model still SEES its previous answer: it is passed
  // to streamCoverAnswer above, in full, as prompt context. It just no
  // longer gets to vouch for itself.
  const allowed = `${question}\n${interviewerSaid(req.body?.recentTurns)}`;

  // ── NO KNOWLEDGE BASE IS THE STRICTEST CASE, NOT THE LOOSEST ──
  //
  // The guard abstains when the vocabulary is empty, and for the main answer
  // that is right: with nothing uploaded there is nothing to contradict, and
  // flagging every name would suppress every cover in the app's most common
  // state. Applied to the COVER it is exactly backwards, because a
  // no-documents session is precisely when a fast model has nothing to draw
  // on and reaches for a name. Measured live, with no files attached:
  //
  //   "At my previous role at Google, we experienced a major outage…"
  //   "I've worked at IBM and then spent several years at Accenture…"
  //
  // Both passed, because there was no vocabulary to fail against.
  //
  // So when there is no knowledge base, the QUESTION becomes the vocabulary:
  // any name the interviewer did not just say is, by construction, invented —
  // the candidate's background is unknown, so no name can be supported by it.
  // A cover in that state should be a stance about approach, which needs no
  // proper nouns at all (COVER_SYSTEM says exactly this). Losing a cover here
  // costs a moment of silence; keeping one costs a fabricated employer spoken
  // out loud.
  const invented = unverifiedProperNouns(vocab.trim() ? vocab : allowed, cover, allowed);

  // Style, not just facts. Measured over the last 400 answers in the user's
  // database, 15.3% opened with a phrase COVER_SYSTEM explicitly forbids —
  // three separate answers began with the identical words "Most of my time's
  // been on", one of them in front of a question about concurrency. The
  // prompt asked for variety and did not get it, so the check is here.
  const banned = hasBannedOpener(cover);
  if (banned) {
    console.warn(
      `[cover] REJECTED ${provider} user=${req.user?.id} tier=${plan.name} `
      + `bannedOpener="${banned}" after ${Date.now() - t0}ms — a canned opening in front of `
      + `an unrelated question is worse than no opening. text="${cover.slice(0, 100)}"`
    );
    return '';
  }
  if (invented.length) {
    console.warn(
      `[cover] REJECTED ${provider} user=${req.user?.id} tier=${plan.name} `
      + `invented=[${invented.join(', ')}] after ${Date.now() - t0}ms — dropping the opener `
      + `rather than speaking it. text="${cover.slice(0, 120)}"`
    );
    return '';
  }

  // ── AND THE NUMBERS ──
  // The check above polices NAMES. It has nothing to say about a figure, and
  // a cover that invents one is just as unspeakable: measured live against
  // the real providers, this was FORWARDED and would have been read aloud —
  //   "queries on our service metadata were timing out during peak traffic.
  //    I pulled the slow logs and ran test queries against different index
  //    sizes..."
  // — none of it on the résumé, every proper noun in it perfectly valid. A
  // number the candidate then has to defend is worse than one they never
  // said, because the REAL answer is still generating and has not seen the
  // cover's invention; the two can contradict each other out loud.
  // `candidateContext` is the digest the model was given, so anything it
  // quotes from there is supported by construction, and anything it did not
  // is a figure it made up.
  const madeUpNumbers = unverifiedNumbers(
    typeof req.body?.coverContext === 'string' ? req.body.coverContext : '',
    cover,
    allowed,
  );
  if (madeUpNumbers.length) {
    console.warn(
      `[cover] REJECTED ${provider} user=${req.user?.id} tier=${plan.name} `
      + `fabricatedNumbers=[${madeUpNumbers.join(', ')}] after ${Date.now() - t0}ms — a metric `
      + `the background does not contain. text="${cover.slice(0, 120)}"`
    );
    return '';
  }

  sse.send(held);
  // A space so the main model's first token cannot fuse onto the cover's
  // last word.
  sse.send(' ');
  const words = cover.split(/\s+/).filter(Boolean).length;
  // Log the arithmetic, not just the outcome: seconds of SPEECH bought
  // against the gap it has to cover is the only number that says whether
  // the candidate runs dry, and it is what a future tuning pass needs.
  console.log(
    `[cover] ${provider} user=${req.user?.id} tier=${plan.name} cat=${category} `
    + `effort=${effort} gap~${gapMs}ms cover=${Date.now() - t0}ms `
    + `words=${words} speech~${(words / SPOKEN_WORDS_PER_SEC).toFixed(1)}s`
  );
  return cover;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  REPORT WHAT THE MAIN MODEL ACTUALLY DID
//
//  The cover is sized from a table of latencies measured on one
//  afternoon in July. Tables do not notice a bad minute. A real
//  question on the app's default model — "okay, on what platforms did
//  you work?" on gpt-5.6 at effort none, predicted 1,400ms — took
//  twenty-five seconds, and the only trace it left was the absence of a
//  [cover] line in the log.
//
//  Two jobs, both cheap:
//    1. feed the observation back so the NEXT cover on this route is
//       sized for a provider that is currently slow (see the EWMA note
//       in coverAnswer.js), and
//    2. leave a line in the log when an answer blows past its
//       prediction, so "the model just sat there" is never again
//       something that has to be reconstructed from timestamps.
//
//  Timed from the moment the main call is ISSUED, which is AFTER the
//  cover chain — so the cover's own cost is never counted as the main
//  model's latency and fed back to make the next cover longer, which
//  would compound on itself.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const SLOW_ANSWER_LOG_MS = 8000;
function mainTtftReporter({ question, provider, effort = 'none', webSearch = false }) {
  const { recordMainTtftMs, predictMainTtftMs } = require('../services/coverAnswer');
  const { category } = classifyQuestion(question);
  const args = { provider, deep: DEEP_CATEGORIES.has(category), effort, webSearch };
  const predicted = predictMainTtftMs(args);
  let issuedAt = Date.now();
  let reported = false;
  return {
    // Call immediately before creating the provider stream.
    issued() { issuedAt = Date.now(); },
    // Call on the FIRST text delta. Idempotent.
    firstToken() {
      if (reported) return;
      reported = true;
      const ms = Date.now() - issuedAt;
      recordMainTtftMs(args, ms);
      if (ms >= SLOW_ANSWER_LOG_MS) {
        console.warn(`[ttft] SLOW main answer: ${provider} ${ms}ms (predicted ${predicted}ms, cat=${category}, effort=${effort}) — next cover on this route will be sized longer`);
      }
    },
  };
}

// Single source of truth for tier-gating + validation. Returns the
// effort string to pass to OpenAI. Tiers below Max/Ultra (non-admin)
// always get 'none' regardless of what the client sent — defense in
// depth, since the client UI also locks the bar but a tampered client
// could bypass it.
//
// `transcript` (optional) — when client sends `reasoning_effort: 'auto'`
// (or doesn't send the field), we classify the transcript and pick the
// effort level that matches the question's analytical depth. This lets
// Max-tier users keep the effort dial set to "auto" and trust the server
// to pick "low" for a coding question vs "medium" for a system design.
function resolveReasoningEffort(req, transcript) {
  const raw = (req.body && typeof req.body.reasoning_effort === 'string')
    ? req.body.reasoning_effort
    : 'auto';  // pre-existing clients that don't send the field now opt INTO auto;
               // explicit 'none' from clients still works (validated below)
  const requested = ALLOWED_REASONING_EFFORTS.includes(raw) ? raw : 'auto';

  // Auto mode: classify the CURRENT QUESTION and map category → effort.
  // extractCurrentQuestion strips the rules block / history framing —
  // classifying the raw composed message would match the rules block's
  // own example phrases and mislabel every call as behavioral.
  let validated;
  if (requested === 'auto') {
    const t = extractCurrentQuestion(transcript || (Array.isArray(req.body?.messages)
      ? lastUserMessage(req.body.messages) : ''));
    const { category } = classifyQuestion(t);
    validated = AUTO_EFFORT_BY_CATEGORY[category] || 'none';
  } else {
    validated = requested;
  }

  // Tier gate: the reasoning dial is a Max AND Ultra feature (mirror of
  // the client's FEATURE_GATES.reasoningEffortControl — pricing copy
  // sells Ultra as "Train Model + full reasoning control"); admins bypass
  // every gate. Everyone else always gets 'none' (cost control — high
  // reasoning_effort is ~5x the per-call cost), regardless of what a
  // tampered client sends. Auto-classification for gated users still
  // runs but is silently downgraded here. Note this reads the RAW tier:
  // a time-exhausted Max/Ultra keeps the dial (their plan is still
  // theirs) — requireTimeRemaining is what blocks out-of-time sends.
  const tier = req.license?.tier || 'free';
  const isAdminCaller = ADMIN_EMAILS.includes((req.user?.email || '').toLowerCase());
  if (tier !== 'max' && tier !== 'ultra' && !isAdminCaller && validated !== 'none') {
    return 'none';
  }
  return validated;
}

// ─────────────────────────────────────────────────────────────
// DYNAMIC max_tokens SCALING for user custom instructions
//
// User direction (2026-05-08): "if they give the instructions as
// STAR method, that will potentially require more tokens; in that
// case tokens limit must be increased and burn them. customer
// satisfaction not the tokens."
//
// Custom instructions arrive embedded inside the system prompt
// (the client's getCustomInstructionsBlock prepends them to the
// rest of the system text). We scan that text for keywords that
// imply long-form responses and scale max_tokens accordingly,
// capped at each provider's hard ceiling so we never request
// beyond what the API will accept. The keyword set is conservative
// — false positives just allocate extra TPM headroom (which is
// cheap; the API only bills actual generated tokens), false
// negatives truncate STAR-method answers mid-sentence (the bug
// we're fixing).
//
// Request budgets as of 2026-07. These are OUR caps, not the models'
// (gpt-5.6 allows up to 128K output, grok-4.5 and gemini-3.6-flash
// 65K+): interview answers never need more, and the cap bounds
// worst-case cost per call.
//   OpenAI gpt-5.6            16,384 max_completion_tokens (deliberate budget)
//   Anthropic Sonnet 5        64,000 max_tokens
//   xAI grok-4.5              8,000 max_tokens (deliberate budget)
//   Groq openai/gpt-oss-120b  8,192 max_tokens
//   Gemini 3.6 Flash          8,192 maxOutputTokens (SDK default)
// ─────────────────────────────────────────────────────────────

function extractSystemText(messages) {
  if (!Array.isArray(messages)) return '';
  const sys = messages.find(m => m && m.role === 'system');
  if (!sys) return '';
  if (typeof sys.content === 'string') return sys.content;
  if (Array.isArray(sys.content)) {
    return sys.content
      .map(p => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
      .join('\n');
  }
  return '';
}

function scaleTokensForInstructions(systemText, baseMax, hardCap) {
  if (!systemText || typeof systemText !== 'string') return Math.min(baseMax, hardCap);
  // Only the user-instructions block is worth scanning — but it lives
  // inside the same systemText so a regex sweep is fine. We lowercase
  // once so each .test() below doesn't re-lowercase the whole prompt.
  const text = systemText.toLowerCase();
  let multiplier = 1.0;
  // Strong: STAR-method behavioral answers expand to 800-1500 tokens
  // (situation + task + action + result, with detail in each).
  if (/\bstar\s*method\b|situation[\s\S]{0,400}?action[\s\S]{0,400}?result/.test(text)) {
    multiplier = Math.max(multiplier, 2.0);
  }
  // Moderate-strong: "detailed/comprehensive/thorough" responses tend
  // to run 1.5-1.8x baseline length.
  if (/\bdetailed\b|\bcomprehensive\b|\bin[\s-]depth\b|\bthorough\b/.test(text)) {
    multiplier = Math.max(multiplier, 1.6);
  }
  // Moderate: step-by-step explanations.
  if (/\bstep[\s-]by[\s-]step\b/.test(text)) {
    multiplier = Math.max(multiplier, 1.6);
  }
  // Moderate: code-example requests (system design + code = long).
  if (/\bcode\s+example|with\s+code|include\s+code|long\s+code|full\s+implementation/.test(text)) {
    multiplier = Math.max(multiplier, 1.5);
  }
  // Counter-signal: explicit "tight" instructions cap us at baseline,
  // so we don't over-allocate when the user explicitly wants brevity.
  if (/\bunder\s+\d+\s+words\b|\bbrief\b|\bconcise\b|\bterse\b|\bshort\s+answer\b/.test(text)) {
    multiplier = Math.min(multiplier, 1.0);
  }
  return Math.min(Math.round(baseMax * multiplier), hardCap);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GROQ'S TOKEN BUDGET COUNTS THE ANSWER YOU HAVE NOT WRITTEN YET
//
//  Both Groq routes asked for max_tokens: 8,000. Measured 2026-07-25
//  against the key in server/.env, `openai/gpt-oss-120b` on this org has
//  a tokens-per-minute limit of exactly 8,000 — and Groq admits a
//  request against TPM using input + max_tokens, BEFORE generating
//  anything. So the reservation alone consumed the entire minute's
//  budget and every request 413'd, with a two-word prompt:
//
//    "Request too large ... on tokens per minute (TPM):
//     Limit 8000, Requested 8239"          ← 193-token system prompt
//
//  Not "sometimes under load" — always, by arithmetic. Asking for a
//  reservation the size of the whole bucket cannot succeed no matter how
//  small the prompt is. (llama-3.3-70b-versatile, which the cover uses,
//  is on a 12,000 bucket and a cover reserves 90 — which is why covers
//  kept working while the answers behind them never arrived.)
//
//  Two things were wrong and both are fixed here:
//    1. the reservation. 8,000 was chosen as "the model's ceiling", not
//       as "what an interview answer needs". A long STAR answer is
//       ~1,500 tokens; 4,096 is generous and leaves the bucket room to
//       hold a prompt as well.
//    2. the error. is429() classified this as a rate-limit and told the
//       user "give it a few seconds and try again" — advice that could
//       never work, for a condition that is not transient. When the
//       PROMPT alone exceeds the bucket, no retry and no wait helps, and
//       saying so is the only honest thing to do.
const GROQ_BASE_MAX_TOKENS = 4096;
const GROQ_CAP_MAX_TOKENS = 8192;

// Pull the numbers out of Groq's own message — it tells us the limit and
// what it counted, which is everything needed to retry correctly.
function parseGroqTpm(err) {
  const msg = String(err?.error?.error?.message || err?.error?.message || err?.message || '');
  if (!/tokens per minute/i.test(msg)) return null;
  const limit = Number(/Limit\s+(\d+)/i.exec(msg)?.[1]);
  const requested = Number(/Requested\s+(\d+)/i.exec(msg)?.[1]);
  if (!Number.isFinite(limit) || !Number.isFinite(requested)) return null;
  return { limit, requested, msg };
}

// One self-healing retry: `requested - max_tokens` is the prompt's real
// token count, so we can compute the largest reservation that still fits
// and try again. If the prompt ALONE is over the limit there is no
// reservation that fits and we rethrow for the honest error path.
async function callGroqWithinTpm(groq, params, opts) {
  try {
    return await groq.chat.completions.create(params, opts);
  } catch (err) {
    const tpm = parseGroqTpm(err);
    if (!tpm) throw err;
    const promptTokens = tpm.requested - (params.max_tokens || 0);
    // 256 tokens of headroom: the accounting is approximate and a retry
    // that lands one token over is a retry wasted.
    const room = tpm.limit - promptTokens - 256;
    if (!(room >= 512)) throw err;
    console.warn(`[groq] TPM ${tpm.limit}: prompt ~${promptTokens} tok, retrying with max_tokens ${room} (was ${params.max_tokens})`);
    return groq.chat.completions.create({ ...params, max_tokens: room }, opts);
  }
}

// The message the candidate sees when even that cannot fit. Names the
// real constraint and the two things that actually resolve it.
function describeGroqTpmFailure(err) {
  const tpm = parseGroqTpm(err);
  if (!tpm) return null;
  return {
    log: `TPM limit ${tpm.limit} < requested ${tpm.requested} — this key cannot serve a prompt this size on this model. Upgrade the Groq plan or route this model elsewhere.`,
    userMessage: `This Groq model is capped at ${tpm.limit.toLocaleString()} tokens/minute on the current plan and this question needs about ${tpm.requested.toLocaleString()}. Switch models for now — waiting will not clear it.`,
  };
}
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

router.post('/chat/openai', requireTier(...TRIAL_MODELS), requireTimeRemaining, requireActiveSession, async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OpenAI not configured' });

  try {
    const { messages } = req.body;
    const fresh = await tryEnrich(extractCurrentQuestion(lastUserMessage(messages)), req.headers['x-request-id']);
    const enrichedMessages = appendFreshToMessages(messages, fresh?.context);

    const reasoningEffort = resolveReasoningEffort(req);
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey });

    // Match the stream route's scaling — non-streaming chat path needs
    // the same custom-instruction-aware token budget so STAR / detailed
    // responses don't truncate at the base limit when this endpoint is
    // the one in use (e.g., generateConversationTitle, generateOpenAI
    // helpers, prewarm flows).
    const sysText = extractSystemText(enrichedMessages);
    const maxTokens = scaleTokensForInstructions(sysText, 16000, 16384);

    const completion = await openai.chat.completions.create({
      model: 'gpt-5.6',
      messages: enrichedMessages,
      max_completion_tokens: maxTokens,
      reasoning_effort: reasoningEffort,
    });

    res.json({ text: completion.choices[0]?.message?.content || '' });
  } catch (err) {
    if (is429(err)) {
      console.warn('[openai] upstream 429:', err.message);
      return res.status(429).json(rateLimitedJson('OpenAI'));
    }
    console.error('OpenAI proxy error:', err.message);
    res.status(500).json({ error: 'AI request failed', detail: err.message });
  }
});

// ── xAI (Grok) ──
router.post('/chat/xai', requireTier(...TRIAL_MODELS), requireTimeRemaining, requireActiveSession, async (req, res) => {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'xAI not configured' });

  try {
    const { messages } = req.body;
    const fresh = await tryEnrich(extractCurrentQuestion(lastUserMessage(messages)), req.headers['x-request-id']);
    const enrichedMessages = appendFreshToMessages(messages, fresh?.context);

    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });

    // Match the stream-route bump: 1,600 was a leftover from the
    // fast-response experiment and truncated long answers; 8,000
    // baseline is the new floor with scaling on top.
    const sysText = extractSystemText(enrichedMessages);
    const maxTokens = scaleTokensForInstructions(sysText, 8000, 8000);

    const completion = await client.chat.completions.create({
      // grok-4.5 — NOTE the dot: xAI's API takes 'grok-4.5'; 'grok-4-5'
      // (dash form, used in URLs/slugs) returns model-not-found.
      model: 'grok-4.5',
      messages: enrichedMessages,
      max_tokens: maxTokens,
      temperature: 0.7,
    });

    res.json({ text: completion.choices[0]?.message?.content || '' });
  } catch (err) {
    if (is429(err)) {
      console.warn('[xai] upstream 429:', err.message);
      return res.status(429).json(rateLimitedJson('Grok'));
    }
    console.error('xAI proxy error:', err.message);
    res.status(500).json({ error: 'AI request failed', detail: err.message });
  }
});

// ── Groq ──
// Upgraded May 2026 from Llama-4-Scout-17B to GPT-OSS-120B:
//   - 7x parameter count (17B → 120B) closes the quality gap with the
//     other chat models (Sonnet, GPT-5.6, Gemini 3.6 Flash). Scout-17B
//     was structurally too small to follow the senior-instinct prompt
//     reliably — it would give junior-shaped answers despite the
//     prompt asking for non-obvious trade-offs and edge-case naming.
//   - GPT-OSS-120B has reasoning capabilities AND is faster on Groq's
//     hardware (500 t/sec vs Scout's slower throughput).
//   - Verified via console.groq.com/docs/models on the day of upgrade.
//     Production-grade, not preview.
//   - max_tokens added explicitly: Groq's default for Scout was small
//     and was likely truncating long answers. 8000 covers any realistic
//     interview answer with margin.
router.post('/chat/groq', requireTier(...TRIAL_MODELS), requireTimeRemaining, requireActiveSession, async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Groq not configured' });

  try {
    const { messages } = req.body;
    const fresh = await tryEnrich(extractCurrentQuestion(lastUserMessage(messages)), req.headers['x-request-id']);
    const enrichedMessages = appendFreshToMessages(messages, fresh?.context);

    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey });

    // Mirror the stream-route scaling — keeps chat + stream parity for
    // STAR / detailed custom-instruction users hitting this path, and
    // shares the TPM arithmetic fix (see callGroqWithinTpm).
    const sysText = extractSystemText(enrichedMessages);
    const maxTokens = scaleTokensForInstructions(sysText, GROQ_BASE_MAX_TOKENS, GROQ_CAP_MAX_TOKENS);

    const completion = await callGroqWithinTpm(groq, {
      model: 'openai/gpt-oss-120b',
      messages: enrichedMessages,
      max_tokens: maxTokens,
      temperature: 0.7,
    });

    res.json({ text: completion.choices[0]?.message?.content || '' });
  } catch (err) {
    const tpm = describeGroqTpmFailure(err);
    if (tpm) {
      console.error(`[groq] ${tpm.log}`);
      return res.status(413).json({ error: tpm.userMessage });
    }
    if (is429(err)) {
      console.warn('[groq] upstream 429:', err.message);
      return res.status(429).json(rateLimitedJson('Groq'));
    }
    console.error('Groq proxy error:', err.message);
    res.status(500).json({ error: 'AI request failed', detail: err.message });
  }
});

// ── Claude (Anthropic) — Sonnet 5 with hosted web_search tool ──
// The model decides on its own whether to invoke search. Most questions
// skip it and answer from memory in 1.5-3s; recent/niche questions
// search and answer in 3-5s. The system prompt is wrapped in a
// cache_control block so the long voice-rules + identity card pays
// for itself once per 5-minute window instead of per call.
//
// `web_search_20260209` is the current (Feb 2026) tool version, which
// supports dynamic filtering — Claude writes code to filter results
// before they hit the context window. ~24% fewer tokens, ~11% better
// accuracy than the older `web_search_20250305` according to Anthropic.
//
// CommonJS interop: the SDK ships dual ESM+CJS but the default-export
// landing differs by Node version, so normalize via (.default || mod)
// before instantiation. Storing the constructor at module scope avoids
// repeating the dance on every request.
const _AnthropicMod = (() => {
  try { return require('@anthropic-ai/sdk'); } catch { return null; }
})();
const Anthropic = _AnthropicMod && (_AnthropicMod.default || _AnthropicMod);

async function claudeChatHandler(req, res) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !Anthropic) return res.status(503).json({ error: 'Claude not configured' });

  try {
    const { messages, systemInstruction, enableWebSearch } = req.body;
    const fresh = await tryEnrich(extractCurrentQuestion(lastUserMessage(messages)), req.headers['x-request-id']);
    // Cache-preserving injection: the cache_control'd system block must
    // stay BYTE-STABLE or Anthropic re-writes the whole prompt cache
    // (full input price + full prefill latency) on every fresh-context
    // flip. Evidence rides with the question instead.
    const enrichedMessages = appendFreshToMessages(messages, fresh?.context);

    const client = new Anthropic({ apiKey });

    const tools = [];
    if (enableWebSearch !== false) {
      tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 3 });
    }

    const system = systemInstruction
      ? [{ type: 'text', text: systemInstruction, cache_control: { type: 'ephemeral' } }]
      : undefined;

    // Match the stream route — non-streaming chat path also needs
    // custom-instruction-aware token scaling. Sonnet 5 supports
    // up to 64,000 max_tokens, so STAR / detailed responses can scale
    // up to 32,000 here without truncation.
    const maxTokens = scaleTokensForInstructions(systemInstruction || '', 16000, 64000);

    const completion = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: maxTokens,
      system,
      messages: enrichedMessages,
      tools: tools.length ? tools : undefined,
      // Sonnet 5 defaults effort to 'high' (more thinking → slower + pricier).
      // For live-interview answers we want speed, so pin it low. Sonnet 5 is a
      // new-generation model and rejects sampling params (temperature/top_p),
      // so temperature is intentionally omitted (was 0.7 on Sonnet 4.6).
      output_config: { effort: 'low' },
    });

    // Anthropic returns a content array of blocks. server_tool_use and
    // web_search_tool_result blocks describe internal search activity —
    // concatenate only `text` blocks so the candidate sees only the final
    // answer, not "Searching the web…" markers or raw tool-call JSON.
    const text = (completion.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    res.json({ text });
  } catch (err) {
    if (is429(err)) {
      console.warn('[claude] upstream 429:', err.message);
      return res.status(429).json(rateLimitedJson('Claude'));
    }
    console.error('Claude proxy error:', err.message);
    res.status(500).json({ error: 'AI request failed', detail: err.message });
  }
}

// The live-answer path: Pro+, time left, and the clock actually running.
router.post('/chat/claude', requireTier(...CLAUDE_TIERS), requireTimeRemaining, requireActiveSession, claudeChatHandler);

// ── /chat/claude-train — Train Model's Claude calls ──────────────────
// Same handler, different gate, and both differences are the point.
//
// requireTier(max, ultra) instead of Pro+: Train Model is sold as the Max
// differentiator on every pricing surface (pricingService BASE_FEATURES_MAX,
// TIERS.md §2, the bot's tier table), but the ONLY thing enforcing it was
// FEATURE_GATES.trainModel — a render gate in the client. The work itself
// went to /chat/claude at Pro+, so anyone past the client gate got the
// $50→$89 upsell for free. Enforcement belongs on the server.
//
// NO requireActiveSession: this is pre-interview research — that is the
// entire product ("Train Model — pre-research the role"). Sending it
// through the live-answer gate meant a Max user who hadn't started their
// session got a 428, which trainClaudeModel swallowed into the misleading
// "Couldn't read resume — try again", and the only way to make it work was
// to turn the mic on, which starts the interview clock they paid for.
// Nothing is charged here either way: time burns via usage_sessions
// heartbeats, and there is no session.
//
// requireTimeRemaining is KEPT — training is ~15 web_search calls on
// Sonnet, so it stays behind a live, unexhausted pass. A Max buyer has
// their full 3 hours on the clock before the interview starts, so this
// never blocks the real use case; it only stops a spent pass from being
// farmed for free Claude.
router.post('/chat/claude-train', requireTier(...TRAIN_TIERS), requireTimeRemaining, claudeChatHandler);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  STREAMING VARIANTS — Server-Sent Events, token by token
//  Each handler opens an SSE response, forwards tokens from the
//  upstream provider as `data: {"t":"chunk"}` frames, and ends
//  with `data: [DONE]` so the client knows to close.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function openSseStream(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // ── THE DISCONNECT SIGNAL IS ON THE RESPONSE, NOT THE REQUEST ──
  //
  // Per-request AbortController, so a client disconnect immediately stops
  // whatever we are reading from the upstream provider — otherwise we keep
  // for-await'ing tokens no one will ever see, and paying for them.
  //
  // This was `req.on('close', onClose)`, and on Node 20 that event does not
  // mean what it reads as. `IncomingMessage` emits 'close' when the REQUEST
  // is complete — i.e. as soon as express.json() has consumed the body,
  // measured at ~1ms into the handler — not when the peer goes away. Two
  // consequences, both verified by experiment:
  //
  //   · In production the listener attached too LATE to hear it (the
  //     awaiting rate limiter in index.js defers the route handler past the
  //     tick in which 'close' fires), so the abort never ran at all. A
  //     client that hung up after 1s still had all 20 upstream tokens
  //     generated and billed. The protection this block describes did not
  //     exist.
  //   · Mount the same router with only synchronous middleware ahead of it
  //     and the listener DOES hear it: controller.abort() fires at ~3ms,
  //     `closed` goes true, every sse.send() becomes a no-op, the provider
  //     call throws "Request was aborted", and sse.done() early-returns so
  //     res.end() is never called — the response hangs until the client
  //     times out. Streaming worked only by accident of middleware order.
  //
  // ServerResponse 'close' is the documented disconnect signal: it fires
  // when the response finishes OR the connection is torn down early. On a
  // normal finish `closed` is already true and this is a no-op.
  const controller = new AbortController();
  let closed = false;
  const onClose = () => {
    if (closed) return;
    closed = true;
    try { controller.abort(); } catch {}
  };
  res.on('close', onClose);

  return {
    signal: controller.signal,
    get closed() { return closed; },
    send(chunk) {
      if (closed || !chunk) return;
      res.write(`data: ${JSON.stringify({ t: chunk })}\n\n`);
    },
    error(message) {
      if (closed) return;
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    },
    done() {
      if (closed) return;
      closed = true;
      try { res.write('data: [DONE]\n\n'); res.end(); } catch {}
    },
  };
}

// ── Gemini (stream) ──
router.post('/stream/gemini', geminiQuotaGate, requireTimeRemaining, requireActiveSession, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Gemini not configured' });

  const sse = openSseStream(req, res);
  try {
    const { prompt, systemInstruction, fileParts } = req.body;
    // See /chat/gemini: classify + retrieve on the raw live question;
    // fresh context rides with the question so the system prompt stays
    // byte-stable for Gemini's implicit prompt cache.
    const question = extractCurrentQuestion(prompt);
    const fresh = await tryEnrich(question, req.headers['x-request-id']);
    let enrichedPrompt = appendFreshToPrompt(prompt, fresh?.context);
    const deepQuestion = DEEP_CATEGORIES.has(classifyQuestion(question).category);

    // ── Instant cover answer ──
    // Gemini is the fastest model in the fleet on a shallow question
    // (0.7-0.8s at MINIMAL) and the depth model correctly fires NO cover
    // there — racing it would only slow the answer. But a deep question
    // lifts it to thinkingLevel LOW, which measured 4.1s to first token,
    // and that is a real silence. Same predictor, opposite answer,
    // decided per question rather than per route.
    {
      const { buildCoverContinuation } = require('../services/coverAnswer');
      const cover = await runCover({ sse, req, question, provider: 'gemini' });
      // Gemini's request is a single prompt string, not a message array,
      // so the continuation rides on the end of the prompt — same rule as
      // fresh context: never the system instruction, whose byte-stability
      // is what keeps the implicit prompt cache hot.
      if (cover) enrichedPrompt = appendFreshToPrompt(enrichedPrompt, buildCoverContinuation(cover));
    }

    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    const parts = [];
    if (fileParts && fileParts.length > 0) {
      fileParts.forEach(fp => parts.push({ inlineData: { mimeType: fp.mimeType, data: fp.data } }));
    }
    parts.push({ text: enrichedPrompt });

    const ttft = mainTtftReporter({ question, provider: 'gemini' });
    ttft.issued();
    const stream = await ai.models.generateContentStream({
      model: 'gemini-3.6-flash',
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: systemInstruction || '',
        // See /chat/gemini: sampling params deprecated on 3.x (omit);
        // thinkingLevel depth-matched — LOW on deep shapes (≈2.3s total
        // measured), MINIMAL floor otherwise.
        thinkingConfig: { thinkingLevel: deepQuestion ? 'LOW' : 'MINIMAL' },
        abortSignal: sse.signal,
      }
    });

    for await (const event of stream) {
      if (sse.closed) break;
      const piece = event?.text;
      if (piece) { ttft.firstToken(); sse.send(piece); }
    }
    sse.done();
  } catch (err) {
    if (err?.name === 'AbortError' || sse.closed) { sse.done(); return; }
    if (is429(err)) {
      console.warn('[gemini] upstream 429 (stream):', err.message);
      sse.error('Gemini rate-limited — give it a few seconds and try again.');
      sse.done();
      return;
    }
    console.error('Gemini stream error:', err.message);
    sse.error(err.message || 'AI request failed');
    sse.done();
  }
});

// ── OpenAI (stream) ──
// Mirrors /chat/openai: client-supplied reasoning_effort flows through
// resolveReasoningEffort (validates the value AND tier-gates — only
// Max/Ultra users and admins can opt into anything beyond 'none'). See
// the chat handler comment block above for full rationale on which
// params are safe to pass.
router.post('/stream/openai', requireTier(...TRIAL_MODELS), requireTimeRemaining, requireActiveSession, async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OpenAI not configured' });

  const sse = openSseStream(req, res);
  try {
    const { messages } = req.body;
    const question = extractCurrentQuestion(lastUserMessage(messages));
    const fresh = await tryEnrich(question, req.headers['x-request-id']);
    let enrichedMessages = appendFreshToMessages(messages, fresh?.context);

    const reasoningEffort = resolveReasoningEffort(req, question);

    // ── Instant cover answer ──
    // The main answer's first token can be seconds away (reasoning on a
    // deep question, a user-picked low/medium/high, cold prefill) — dead
    // air in a live interview. Stream a 12-30-word spoken opener from the
    // fastest model first (~0.3-0.7s to first word, sub-cent cost), then
    // hand the opener to the main model with a continuation instruction
    // so its answer picks up exactly where the cover stops — one seamless
    // answer, no repetition. The candidate speaks the cover (~10s aloud)
    // while the continuation lands underneath it.
    // Guard: never for Auto-Solve (its output is code typed into an
    // editor; a spoken opener would corrupt it). Cover failure of any
    // kind degrades to normal behavior — main answer only.
    const sysTextEarly = extractSystemText(enrichedMessages);
    // Cost guardrail: with KB retrieval the system prompt should stay small
    // (~8-15K chars) even for a 100-file KB. If it ever balloons past this,
    // retrieval failed and the whole KB is leaking into every turn — warn
    // loudly, without logging on every normal request.
    if (sysTextEarly.length > 60_000) {
      console.warn(`[promptsize] LARGE system prompt: ${sysTextEarly.length} chars (~${Math.round(sysTextEarly.length / 4)} tok) — retrieval may have failed`);
    }
    // Fire the instant cover for EVERY substantive question (coverWorthy) —
    // robust to classifier gaps, unlike the old reasoning/big-KB gate.
    // Depth comes from the RESOLVED effort, not the requested one: a
    // tier-gated user whose 'high' was downgraded to 'none' gets an
    // answer in ~1.4s and does not need a 110-word holding answer.
    {
      const { buildCoverContinuation } = require('../services/coverAnswer');
      const cover = await runCover({
        sse, req, question, provider: 'openai', effort: reasoningEffort,
      });
      if (cover) enrichedMessages = appendTextToLastUserMessage(enrichedMessages, buildCoverContinuation(cover));
    }

    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey });

    // Scale max_completion_tokens based on user custom instructions
    // embedded in the system prompt (STAR method / detailed / etc.).
    // Base 16,000 with a 16,384 request cap — a deliberate output
    // budget (gpt-5.6 itself allows up to 128K, but interview answers
    // never need it and the cap bounds worst-case cost). Helper still
    // applied for symmetry with the other 3 stream providers. Reuses the
    // system text extracted for the big-context cover check above — the
    // cover only appends to the last USER message, so it is unchanged.
    const maxTokens = scaleTokensForInstructions(sysTextEarly, 16000, 16384);

    const ttft = mainTtftReporter({ question, provider: 'openai', effort: reasoningEffort });
    ttft.issued();
    const stream = await openai.chat.completions.create(
      {
        model: 'gpt-5.6',
        messages: enrichedMessages,
        max_completion_tokens: maxTokens,
        reasoning_effort: reasoningEffort,
        stream: true,
      },
      { signal: sse.signal }
    );

    for await (const chunk of stream) {
      if (sse.closed) break;
      const piece = chunk?.choices?.[0]?.delta?.content;
      if (piece) { ttft.firstToken(); sse.send(piece); }
    }
    sse.done();
  } catch (err) {
    if (err?.name === 'AbortError' || sse.closed) { sse.done(); return; }
    if (is429(err)) {
      console.warn('[openai] upstream 429 (stream):', err.message);
      sse.error('OpenAI rate-limited — give it a few seconds and try again.');
      sse.done();
      return;
    }
    console.error('OpenAI stream error:', err.message);
    sse.error(err.message || 'AI request failed');
    sse.done();
  }
});

// ── xAI Grok (stream) ──
router.post('/stream/xai', requireTier(...TRIAL_MODELS), requireTimeRemaining, requireActiveSession, async (req, res) => {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'xAI not configured' });

  const sse = openSseStream(req, res);
  try {
    const { messages } = req.body;
    const question = extractCurrentQuestion(lastUserMessage(messages));
    const fresh = await tryEnrich(question, req.headers['x-request-id']);
    let enrichedMessages = appendFreshToMessages(messages, fresh?.context);

    // ── Instant cover answer — THE ROUTE THAT NEEDED IT MOST ──
    //
    // grok-4.5 measured 17.9s / 19.8s / 32.0s to first token on a
    // system-design question (1.8s on a behavioral one). This route had
    // no cover, so a candidate asking Grok a hard question sat in total
    // silence for up to half a minute with the app showing nothing.
    // At that gap the depth model picks the HOLDING tier: 60-110 words,
    // roughly 26-48 seconds of speech, which is the only thing that
    // actually covers it.
    {
      const { buildCoverContinuation } = require('../services/coverAnswer');
      const cover = await runCover({ sse, req, question, provider: 'xai' });
      if (cover) enrichedMessages = appendTextToLastUserMessage(enrichedMessages, buildCoverContinuation(cover));
    }

    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });

    // xAI baseline bumped from 1,600 (a leftover from the original
    // fast-response experiment) to 8,000 — the prior cap truncated
    // every STAR-method or detailed response mid-sentence. STAR
    // answers run 800-1500 tokens; comprehensive system-design 2-3k.
    // Scaling on top of the new baseline lets long-form custom
    // instructions push to the model's hard cap.
    const sysText = extractSystemText(enrichedMessages);
    const maxTokens = scaleTokensForInstructions(sysText, 8000, 8000);

    const ttft = mainTtftReporter({ question, provider: 'xai' });
    ttft.issued();
    const stream = await client.chat.completions.create(
      {
        // See /chat/xai: 'grok-4.5' with the dot — the dash form 404s.
        model: 'grok-4.5',
        messages: enrichedMessages,
        max_tokens: maxTokens,
        temperature: 0.7,
        stream: true,
      },
      { signal: sse.signal }
    );

    for await (const chunk of stream) {
      if (sse.closed) break;
      const piece = chunk?.choices?.[0]?.delta?.content;
      if (piece) { ttft.firstToken(); sse.send(piece); }
    }
    sse.done();
  } catch (err) {
    if (err?.name === 'AbortError' || sse.closed) { sse.done(); return; }
    if (is429(err)) {
      console.warn('[xai] upstream 429 (stream):', err.message);
      sse.error('Grok rate-limited — give it a few seconds and try again.');
      sse.done();
      return;
    }
    console.error('xAI stream error:', err.message);
    sse.error(err.message || 'AI request failed');
    sse.done();
  }
});

// ── Groq (stream) ──
// Same model upgrade as /chat/groq: Llama-4-Scout-17B → GPT-OSS-120B.
// See chat handler comment for full rationale.
router.post('/stream/groq', requireTier(...TRIAL_MODELS), requireTimeRemaining, requireActiveSession, async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Groq not configured' });

  const sse = openSseStream(req, res);
  try {
    const { messages } = req.body;
    const question = extractCurrentQuestion(lastUserMessage(messages));
    const fresh = await tryEnrich(question, req.headers['x-request-id']);
    let enrichedMessages = appendFreshToMessages(messages, fresh?.context);

    // ── Instant cover answer ──
    // gpt-oss-120b is a reasoning model, so its first token is seconds
    // out on anything substantive. The cover runs on llama-3.3-70b, a
    // DIFFERENT model with its own (larger) token bucket, so it is not
    // competing with the answer for the budget below.
    {
      const { buildCoverContinuation } = require('../services/coverAnswer');
      const cover = await runCover({ sse, req, question, provider: 'groq' });
      if (cover) enrichedMessages = appendTextToLastUserMessage(enrichedMessages, buildCoverContinuation(cover));
    }

    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey });

    const sysText = extractSystemText(enrichedMessages);
    const maxTokens = scaleTokensForInstructions(sysText, GROQ_BASE_MAX_TOKENS, GROQ_CAP_MAX_TOKENS);

    const ttft = mainTtftReporter({ question, provider: 'groq' });
    ttft.issued();
    const stream = await callGroqWithinTpm(groq, {
      model: 'openai/gpt-oss-120b',
      max_tokens: maxTokens,
      messages: enrichedMessages,
      temperature: 0.7,
      stream: true,
    }, { signal: sse.signal });

    for await (const chunk of stream) {
      if (sse.closed) break;
      const piece = chunk?.choices?.[0]?.delta?.content;
      if (piece) { ttft.firstToken(); sse.send(piece); }
    }
    sse.done();
  } catch (err) {
    if (err?.name === 'AbortError' || sse.closed) { sse.done(); return; }
    const tpm = describeGroqTpmFailure(err);
    if (tpm) {
      console.error(`[groq] ${tpm.log}`);
      sse.error(tpm.userMessage);
      sse.done();
      return;
    }
    if (is429(err)) {
      console.warn('[groq] upstream 429 (stream):', err.message);
      sse.error('Groq rate-limited — give it a few seconds and try again.');
      sse.done();
      return;
    }
    console.error('Groq stream error:', err.message);
    sse.error(err.message || 'AI request failed');
    sse.done();
  }
});

// ── Claude (stream) — Sonnet 5 with web_search ──
// Anthropic's `messages.stream(...)` returns a MessageStream helper with
// a `.on('text', cb)` event that fires for every text delta, hiding the
// raw content_block_delta filtering. Web-search activity (server_tool_use,
// web_search_tool_result, partial input_json_delta) is silently filtered
// out by the helper, so the candidate sees only the final answer text.
// Web search runs server-side on Anthropic's infra during a single API
// call — no extra round-trip on our end.
router.post('/stream/claude', requireTier(...CLAUDE_TIERS), requireTimeRemaining, requireActiveSession, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !Anthropic) return res.status(503).json({ error: 'Claude not configured' });

  const sse = openSseStream(req, res);
  try {
    const { messages, systemInstruction, enableWebSearch } = req.body;
    const question = extractCurrentQuestion(lastUserMessage(messages));
    const fresh = await tryEnrich(question, req.headers['x-request-id']);
    // See /chat/claude: keep the cache_control'd system block byte-stable;
    // fresh context rides with the question.
    let enrichedMessages = appendFreshToMessages(messages, fresh?.context);

    // ── Instant cover answer ──
    // Same engine as /stream/openai — fire for EVERY substantive question
    // (coverWorthy; classifier-independent). Claude's first token can lag
    // 2-5s when web_search fires mid-answer, so the opener matters even
    // more here. The cover text is handed to Claude with a continuation
    // instruction so the answer picks up seamlessly where it stops.
    // Sonnet 5 itself reaches first token in ~1.2s, so most questions here
    // get a short opener or none. But when web_search fires the first
    // token waits on a live search round-trip — that is where a Claude
    // question turns into a long silence, so the plan accounts for it.
    {
      const { buildCoverContinuation } = require('../services/coverAnswer');
      const cover = await runCover({
        sse, req, question, provider: 'claude', effort: 'low',
        // "Will this question probably send Claude to the web?", not
        // "is the tool switched on?" — the tool is on for every request,
        // so the raw flag would predict a 9-second silence for "tell me
        // about a time you disagreed with your manager". needsLiveFacts
        // is the same deterministic classifier that decides whether to
        // spend a Brave query: a named tool AND a question shape that
        // depends on current specifics, or an explicit update signal.
        // ~1ms of regex, and it is already the app's answer to exactly
        // this question.
        webSearch: enableWebSearch !== false && needsLiveFacts(question),
      });
      if (cover) enrichedMessages = appendTextToLastUserMessage(enrichedMessages, buildCoverContinuation(cover));
    }

    const client = new Anthropic({ apiKey });

    const tools = [];
    if (enableWebSearch !== false) {
      tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 3 });
    }

    const system = systemInstruction
      ? [{ type: 'text', text: systemInstruction, cache_control: { type: 'ephemeral' } }]
      : undefined;

    // Claude Sonnet 5 supports up to 64,000 max_tokens. Base 16,000
    // is fine for most answers; long-form custom instructions (STAR
    // method, comprehensive deep-dives) scale up to 32,000+ here.
    // The systemInstruction is the cached static block, so the user's
    // custom instructions (prepended to it client-side) get cached
    // along with it — repeat calls read at 10% input cost.
    const maxTokens = scaleTokensForInstructions(systemInstruction || '', 16000, 64000);

    const ttft = mainTtftReporter({
      question, provider: 'claude', effort: 'low',
      webSearch: enableWebSearch !== false && needsLiveFacts(question),
    });
    ttft.issued();
    const stream = client.messages.stream({
      model: 'claude-sonnet-5',
      max_tokens: maxTokens,
      system,
      messages: enrichedMessages,
      tools: tools.length ? tools : undefined,
      // See /chat/claude: pin effort low for latency, omit temperature (Sonnet 5
      // rejects sampling params).
      output_config: { effort: 'low' },
    }, { signal: sse.signal });

    stream.on('text', (textDelta) => {
      if (sse.closed) return;
      if (textDelta) { ttft.firstToken(); sse.send(textDelta); }
    });

    // .done() resolves when the stream completes (or rejects on error).
    // Awaiting here keeps the request open for the SSE relay; sse.done()
    // closes the response only after the model is fully finished.
    await stream.done();
    sse.done();
  } catch (err) {
    if (err?.name === 'AbortError' || sse.closed) { sse.done(); return; }
    if (is429(err)) {
      console.warn('[claude] upstream 429 (stream):', err.message);
      sse.error('Claude rate-limited — give it a few seconds and try again.');
      sse.done();
      return;
    }
    console.error('Claude stream error:', err.message);
    sse.error(err.message || 'AI request failed');
    sse.done();
  }
});

// ── Auto-type planner — Claude Haiku 4.5 ──
//
// The Auto-Type feature types AI-generated code into the candidate's
// editor. The hard part isn't the typing — it's figuring out WHERE to
// start: did the editor already have a partial signature? Are some
// lines already on screen? Where's the cursor?
//
// The Windows UIA path in main.cjs reads the editor's exact text +
// cursor position deterministically, then runs `planAutoTypeFromUIA`
// (a hand-rolled prefix matcher). When that planner's confidence is
// high (≥ 0.85), great — but it misses cases like "user already typed
// the function signature with a tiny whitespace diff" or "cursor is
// mid-block, append-below would duplicate enclosing scope."
//
// This endpoint wraps Claude Haiku 4.5 as a smarter fallback planner.
// Renderer sends the UIA snapshot + the code to type, gets back a
// JSON plan that the deterministic logic couldn't have produced.
// Cost: ~$0.005 per call. Latency target: ~500-800ms. Used only for
// Auto-Type, only on Max-tier (Auto-Type is gated to Max anyway).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  /autotype-agent — Sonnet 5 with tool-use (the "god-level" path)
//  Replaces the v1 Haiku one-shot at /autotype-plan. Sonnet's chain-
//  of-thought + tool_use guarantees richer plans for the hard cases
//  (HackerRank templates, mid-file insertions, partial signatures).
//  Caller uses this when deterministic UIA confidence < 0.85.
//  Cost: ~$0.013/call. Max-tier only.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Two-tier planner: Sonnet 5 (primary) → Groq Llama-3.3-70B (fallback).
// Both are AI agents with forced tool_choice, but they run on different
// vendors so an Anthropic outage doesn't sink Tier 2 entirely. The caller
// (electron/main.cjs) treats the response as opaque — `planner_used` in
// the body identifies which vendor served the plan.
router.post('/autotype-agent', requireTier(...ULTRA_ONLY), async (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;

  // Both planners unconfigured — 503 so the caller falls all the way
  // through to Tier 3 (Haiku) or Tier 4 (OCR). This is the only path
  // that should hit prod; prod has at minimum ANTHROPIC_API_KEY set.
  if (!anthropicKey && !groqKey) {
    return res.status(503).json({ error: 'No planner configured (need ANTHROPIC_API_KEY or GROQ_API_KEY)' });
  }

  const { editorText, cursorOffset, code, language } = req.body || {};
  if (typeof code !== 'string' || code.length === 0) {
    return res.status(400).json({ error: 'code is required' });
  }

  const requestId = req.headers['x-request-id'] || `at-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const sharedArgs = {
    editorText: editorText || '',
    cursorOffset: cursorOffset || 0,
    code,
    language: language || 'unknown',
    requestId,
  };

  // ── Primary: Sonnet 5 ──
  // Skipped entirely if ANTHROPIC_API_KEY isn't set (Groq-only deploy).
  let sonnetErr = null;
  if (anthropicKey) {
    try {
      const { runAutoTypeAgent } = require('../services/autoTypeAgent');
      const t0 = Date.now();
      const plan = await runAutoTypeAgent({ ...sharedArgs, apiKey: anthropicKey });
      const took = Date.now() - t0;
      console.log(`[autotype-agent] planner=sonnet user=${req.user?.id} took=${took}ms confidence=${plan.confidence} action=${plan.cursor_action} skip=L${plan.skip_leading}/T${plan.skip_trailing} wipe=${plan.wipe_chars}`);
      return res.json({ ...plan, planner_used: 'sonnet' });
    } catch (err) {
      sonnetErr = err;
      // EMPTY_CODE means the input is bad — Groq can't fix it. Short-
      // circuit before wasting a Groq call.
      if (err.code === 'EMPTY_CODE') {
        return res.status(400).json({ error: 'code is empty' });
      }
      console.warn(`[autotype-agent] sonnet failed (code=${err.code || '?'}, msg=${err.message}) — trying Groq fallback`);
    }
  }

  // ── Fallback: Groq Llama-3.3-70B ──
  // Fires when Sonnet threw OR ANTHROPIC_API_KEY wasn't set. If we get
  // here without GROQ_API_KEY, surface the Sonnet error (or 503 if no
  // Sonnet attempt was made).
  if (!groqKey) {
    if (sonnetErr) {
      console.error('[autotype-agent] sonnet failed and no Groq fallback configured:', sonnetErr.code || '', sonnetErr.message);
      if (sonnetErr.code === 'NOT_CONFIGURED') return res.status(503).json({ error: 'Claude not configured' });
      if (sonnetErr.code === 'NO_TOOL_CALL') return res.status(502).json({ error: 'Agent produced no plan' });
      return res.status(500).json({ error: 'Agent call failed', detail: sonnetErr.message });
    }
    return res.status(503).json({ error: 'No planner configured' });
  }

  try {
    const { runGroqAutoTypePlanner } = require('../services/groqAutoTypePlanner');
    const t0 = Date.now();
    const plan = await runGroqAutoTypePlanner({ ...sharedArgs, apiKey: groqKey });
    const took = Date.now() - t0;
    console.log(`[autotype-agent] planner=groq user=${req.user?.id} took=${took}ms confidence=${plan.confidence} action=${plan.cursor_action} skip=L${plan.skip_leading}/T${plan.skip_trailing} wipe=${plan.wipe_chars}${sonnetErr ? ` (after sonnet ${sonnetErr.code || 'error'})` : ''}`);
    return res.json({
      ...plan,
      planner_used: 'groq',
      // When we fail-over, surface why so logs (and eventually telemetry)
      // can attribute Groq usage to the right cause.
      sonnet_error: sonnetErr ? (sonnetErr.code || sonnetErr.message) : undefined,
    });
  } catch (groqErr) {
    console.error('[autotype-agent] both planners failed:', { sonnet: sonnetErr?.code, groq: groqErr.code || groqErr.message });
    if (groqErr.code === 'EMPTY_CODE') return res.status(400).json({ error: 'code is empty' });
    if (groqErr.code === 'NO_TOOL_CALL') return res.status(502).json({ error: 'Both planners produced no plan' });
    return res.status(502).json({ error: 'Agent call failed (both Sonnet and Groq)', detail: groqErr.message });
  }
});

// ── /autotype-vision ──
// Vision-grounded planner. Used when Windows UIA is blind to the target
// editor (browser-hosted Monaco/CodeMirror — HackerRank, CoderPad,
// CodeSignal). The caller sends a SCREENSHOT of the editor instead of a
// text dump; Sonnet 5 reads the pixels, locates the caret, and returns
// the same plan shape the typing engine already consumes (plus the
// `move_relative` / `lines_delta` fields for invisible counted-arrow
// cursor repositioning). Falls through (caller's responsibility) to the
// text agent / Haiku / deterministic chain on any non-2xx.
router.post('/autotype-vision', requireTier(...ULTRA_ONLY), async (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return res.status(503).json({ error: 'Claude not configured (need ANTHROPIC_API_KEY)' });
  }

  const { screenshotBase64, screenshotMediaType, code, language, editorText } = req.body || {};
  if (typeof code !== 'string' || code.length === 0) {
    return res.status(400).json({ error: 'code is required' });
  }
  if (typeof screenshotBase64 !== 'string' || screenshotBase64.length < 100) {
    return res.status(400).json({ error: 'screenshotBase64 is required' });
  }

  const requestId = req.headers['x-request-id'] || `atv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  try {
    const { runAutoTypeVisionAgent } = require('../services/autoTypeVisionAgent');
    const t0 = Date.now();
    const plan = await runAutoTypeVisionAgent({
      screenshotBase64,
      screenshotMediaType: screenshotMediaType || 'image/png',
      code,
      language: language || 'unknown',
      editorText: typeof editorText === 'string' ? editorText : '',
      apiKey: anthropicKey,
      requestId,
    });
    const took = Date.now() - t0;
    const opsSummary = (plan.operations || [])
      .map(o => `${o.op}[${o.start_line}${o.op === 'insert' ? '' : '-' + o.end_line}]`)
      .join(',');
    console.log(`[autotype-vision] user=${req.user?.id} took=${took}ms confidence=${plan.confidence} ops=${plan.operations ? plan.operations.length : 0} [${opsSummary}]`);
    return res.json({ ...plan, planner_used: 'vision' });
  } catch (err) {
    if (err.code === 'EMPTY_CODE') return res.status(400).json({ error: 'code is empty' });
    if (err.code === 'BAD_IMAGE') return res.status(400).json({ error: 'screenshot missing or unreadable' });
    if (err.code === 'NOT_CONFIGURED') return res.status(503).json({ error: 'Claude not configured' });
    if (err.code === 'NO_TOOL_CALL') return res.status(502).json({ error: 'Vision agent produced no plan' });
    console.error('[autotype-vision] failed:', err.code || '', err.message);
    return res.status(500).json({ error: 'Vision agent call failed', detail: err.message });
  }
});

// ⚠️ LOAD-BEARING ORDER — requireTier MUST stay ahead of the body checks.
// The desktop app uses this route as its Auto-Type entitlement probe: it
// POSTs deliberately WITHOUT `code`, so requireTier runs, the 400 below
// fires, and main.cjs reads "400 ⇒ this account is Ultra" without spending
// a Haiku call. Auto-Type is otherwise gated only by localStorage, which
// the user can edit — this probe is the real gate.
// So: a 400 from this route is an ENTITLEMENT ASSERTION, not just input
// validation. Inserting any body-validating middleware AHEAD of requireTier
// would make an unentitled account 400 too, and that is a paid-feature
// bypass, not a cosmetic bug. See electron/main.cjs autoTypeVerifyEntitlement.
router.post('/autotype-plan', requireTier(...ULTRA_ONLY), async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !Anthropic) {
    return res.status(503).json({ error: 'Claude not configured' });
  }

  try {
    const { editorText, cursorOffset, code, language } = req.body;
    if (typeof code !== 'string' || code.length === 0) {
      return res.status(400).json({ error: 'code is required' });
    }
    // Cap inputs so a runaway editor (1MB+ files) can't blow up our
    // token budget. 6000 chars covers any sane code-interview window.
    const editorTextSafe = String(editorText || '').slice(0, 6000);
    const codeSafe = String(code).slice(0, 6000);
    const cursorSafe = Number.isFinite(cursorOffset)
      ? Math.max(0, Math.min(editorTextSafe.length, Math.floor(cursorOffset)))
      : editorTextSafe.length;
    const langSafe = (language || 'unknown').toString().slice(0, 30);

    const client = new Anthropic({ apiKey });

    // Strict structured prompt — Haiku follows this format reliably.
    // We split the cursor mark into the editor text so Haiku doesn't
    // need to reason about offsets numerically (it just sees |⟨CURSOR⟩|
    // in the string at the right position).
    const editorWithMark =
      editorTextSafe.slice(0, cursorSafe) +
      '|⟨CURSOR⟩|' +
      editorTextSafe.slice(cursorSafe);

    const systemPrompt = `You are an Auto-Type planner. The user's editor currently shows EDITOR_TEXT (the marker |⟨CURSOR⟩| shows where the cursor is). The user wants to type CODE_TO_TYPE into the editor. Plan a complete typing sequence that gets the editor to the correct final state without duplicating, mangling, or skipping content.

Output ONLY a JSON object — no preamble, no markdown, no commentary:

{
  "cursor_action": "use_current" | "move_to_end" | "go_to_line",
  "target_line": integer,       // 1-indexed; only meaningful when cursor_action="go_to_line"
  "target_column": integer,     // 0-indexed column AFTER cursor moves to target_line
  "wipe_chars": integer,        // number of characters to backspace BEFORE typing (e.g., editor has "def fac" and code starts with "def factorial" — set wipe_chars=3 to clear "fac" and re-type)
  "wipe_first_line": boolean,   // true to do Home+Shift+End+Delete on the cursor line BEFORE typing (cleans up auto-indent / partial signature on the WHOLE line)
  "skip_leading": integer,      // number of leading lines of CODE_TO_TYPE that are ALREADY in EDITOR_TEXT verbatim and should NOT be re-typed
  "skip_trailing": integer,     // number of trailing lines of CODE_TO_TYPE that are ALREADY in EDITOR_TEXT below the cursor (e.g. closing braces)
  "prefix": string,             // optional text to type BEFORE the main content (e.g., "\\n" if we need to start a new line first). Keep tiny — usually "" or "\\n".
  "suffix": string,             // optional text to type AFTER the main content (e.g., closing brackets). Keep tiny — usually "".
  "confidence": number,         // 0.0 to 1.0 — your confidence in this plan; <0.5 means "not sure, type the safe default"
  "reasoning": string           // ONE short sentence explaining the plan
}

CURSOR_ACTION rules (choose ONE):
- "use_current" — cursor is already at a valid insertion point (e.g., end of file, on a blank line at correct scope, mid-expression you want completed). Type at current cursor position.
- "move_to_end" — cursor is in the WRONG place (middle of imports, inside an unrelated function, in a comment block). Move to end of file FIRST via Ctrl+End, then type. Choose this when CODE_TO_TYPE is meant to be APPENDED rather than inserted at cursor.
- "go_to_line" — cursor needs to be moved to a SPECIFIC line+column before typing (rare; mainly when inserting into a known empty function body in the middle of a file). Set target_line + target_column.

Decision rules for cursor_action:
- If cursor is at end of EDITOR_TEXT AND CODE_TO_TYPE is meant to be appended → "use_current"
- If cursor is mid-text AND CODE_TO_TYPE clearly continues from where cursor is (mid-expression, after partial signature, inside an empty body) → "use_current"
- If cursor is mid-text in a place where typing CODE_TO_TYPE would damage existing content (in imports, in a different function, inside a comment) → "move_to_end"
- If you're certain a specific line is the right insertion point → "go_to_line" with target_line + target_column

Other rules:
- If EDITOR_TEXT is empty or just whitespace: cursor_action="use_current", everything else 0/false, confidence=1.0
- If CODE_TO_TYPE is fully present in EDITOR_TEXT: skip_leading=total_lines_of_code, confidence=1.0
- wipe_chars and wipe_first_line are mutually compatible — wipe_chars runs FIRST (within current line), then wipe_first_line if true (selects whole line)
- Be conservative — when uncertain, prefer cursor_action="move_to_end" + skip_leading=0 (typing extra at end is recoverable; mangling existing code isn't)
- Whitespace differences are OK to ignore for skip_leading (re-indent happens at type time)`;

    const userPrompt = `LANGUAGE: ${langSafe}

EDITOR_TEXT:
\`\`\`
${editorWithMark}
\`\`\`

CODE_TO_TYPE:
\`\`\`
${codeSafe}
\`\`\`

JSON:`;

    const completion = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 400,                    // plan response is ~100-200 tokens
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
      temperature: 0.0,                   // deterministic — same input → same plan
    });

    const text = (completion.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    // Hunt for the JSON object — Haiku occasionally wraps in stray text
    // despite the strict prompt.
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return res.status(200).json({ ok: false, reason: 'no_json_in_reply' });
    }

    let plan;
    try {
      plan = JSON.parse(match[0]);
    } catch {
      return res.status(200).json({ ok: false, reason: 'json_parse_failed' });
    }

    // Sanitize the response — Haiku is mostly well-behaved but we never
    // trust unbounded ints from a planner that could push the typing
    // loop into never-never land.
    const codeLineCount = codeSafe.split('\n').length;
    const editorLineCount = editorTextSafe.split('\n').length;
    // cursor_action whitelist — anything else degrades to use_current
    const validActions = new Set(['use_current', 'move_to_end', 'go_to_line']);
    const cursorAction = validActions.has(plan.cursor_action) ? plan.cursor_action : 'use_current';
    const sanitized = {
      ok: true,
      cursor_action: cursorAction,
      target_line: cursorAction === 'go_to_line'
        ? Math.max(1, Math.min(editorLineCount + 1, Number(plan.target_line) || 1))
        : 0,
      target_column: cursorAction === 'go_to_line'
        ? Math.max(0, Math.min(500, Number(plan.target_column) || 0))
        : 0,
      // wipe_chars capped at 200 — anything beyond that is almost certainly a planner error;
      // a real "wipe partial token" use case is <20 chars.
      wipe_chars: Math.max(0, Math.min(200, Number(plan.wipe_chars) || 0)),
      wipe_first_line: Boolean(plan.wipe_first_line),
      skip_leading: Math.max(0, Math.min(codeLineCount, Number(plan.skip_leading) || 0)),
      skip_trailing: Math.max(0, Math.min(codeLineCount, Number(plan.skip_trailing) || 0)),
      // prefix/suffix capped tight — these should be tiny (newlines, brackets, "~" chars).
      // Anything longer means the planner tried to put main content here instead of `content`.
      prefix: typeof plan.prefix === 'string' ? plan.prefix.slice(0, 200) : '',
      suffix: typeof plan.suffix === 'string' ? plan.suffix.slice(0, 200) : '',
      confidence: Math.max(0, Math.min(1, Number(plan.confidence) || 0)),
      reasoning: String(plan.reasoning || '').slice(0, 200),
    };

    res.json(sanitized);
  } catch (err) {
    console.error('[autotype-plan] error:', err.message);
    res.status(500).json({ error: 'AI planning failed', detail: err.message });
  }
});

// ── Deepgram key — short-lived per-user project tokens ──
//
// The client opens a WebSocket DIRECTLY to Deepgram for low-latency live
// transcription, which means it needs an API key. Returning the master
// DEEPGRAM_API_KEY would let any authenticated user extract it from
// DevTools and rack up unbounded transcription bills against the project.
//
// Fix: each call to this endpoint mints a fresh short-lived project key
// (1h TTL, scope=usage:write only, tagged with user_id) via Deepgram's
// project-keys API. The master key never leaves the server. A leaked
// per-user key expires on its own; abusive sessions can be revoked from
// the Deepgram dashboard by user tag.
//
// ROLLOUT: the new behavior only activates when DEEPGRAM_PROJECT_ID is
// set on the server env. Until then we fall back to the old master-key
// behavior + log a loud warning, so deploys don't break voice mode for
// existing users while you go set the env var. Once it's set, the
// fallback never runs.
// 2 hours — safely past the 99th percentile of interview lengths (most are
// 30-60 min). Once the WebSocket is open, the key TTL doesn't affect the
// live connection — Deepgram only checks the key at handshake. But on any
// reconnect (network blip, WiFi switch, sleep/wake) the client refreshes
// via getDeepgramKey() in useSpeechRecognition.ts, so even multi-hour
// sessions keep transcribing without the user ever noticing the rotation.
const DEEPGRAM_KEY_TTL_SECONDS = 7200;
// One-shot flag so we don't flood logs when DEEPGRAM_PROJECT_ID is unset
// and the client polls every ~1 minute on WebSocket reconnects.
let _deepgramProjectIdWarned = false;
// Process-level circuit breaker — when minting fails with a permanent error
// (insufficient scope, missing project), stop trying and serve the master
// key. Avoids burning Deepgram API calls + log spam on every reconnect.
// Cleared on server restart so a fixed env var or scope takes effect.
let _deepgramMintDisabled = false;
let _deepgramMintDisabledReason = null;
let _deepgramMintFallbackWarned = false;
let _deepgramStrictBlockWarned = false;

// Opt-in hard lockdown. When DEEPGRAM_STRICT_NO_MASTER is set, the server
// NEVER hands the master DEEPGRAM_API_KEY to a client — if per-user minting
// can't be done, voice transcription degrades (503) instead of leaking a
// long-lived, full-scope key that DevTools could extract for unlimited
// transcription on our bill. Default OFF preserves the availability-first
// fallback below; flip it to 'true' once you've confirmed minting works
// (DEEPGRAM_PROJECT_ID set + the API key has keys:write scope).
const DEEPGRAM_STRICT_NO_MASTER = ['1', 'true', 'yes'].includes(
  String(process.env.DEEPGRAM_STRICT_NO_MASTER || '').toLowerCase()
);

function fallbackToMasterKey(res, masterKey, reason) {
  // Strict mode: refuse to serve the master key. Voice degrades rather than
  // exposing it. One loud error per process so the operator notices voice is
  // down and fixes minting (scope / project id).
  if (DEEPGRAM_STRICT_NO_MASTER) {
    if (!_deepgramStrictBlockWarned) {
      _deepgramStrictBlockWarned = true;
      console.error(`[deepgram] STRICT mode (DEEPGRAM_STRICT_NO_MASTER) — refusing to serve the master key. Voice transcription is DEGRADED until per-user minting works. Mint-unavailable reason: ${reason}. Fix: grant keys:write to the Deepgram API key AND set DEEPGRAM_PROJECT_ID. Suppressing further strict-block warnings this process.`);
    }
    return res.status(503).json({ error: 'voice_unavailable', message: 'Voice transcription is temporarily unavailable.' });
  }
  if (!_deepgramMintFallbackWarned) {
    _deepgramMintFallbackWarned = true;
    console.warn(`[deepgram] FALLING BACK TO MASTER KEY for the rest of this server process. Reason: ${reason}. Voice mode will keep working, but the master key is now reachable from the client (DevTools). Fix: grant keys:write scope to your Deepgram API key at https://console.deepgram.com/ → Settings → API Keys, OR set DEEPGRAM_PROJECT_ID to a project the key can mint into. Suppressing further fallback warnings this process.`);
  }
  return res.json({ key: masterKey });
}

// Both GET and POST are bound to the same handler. Older app builds
// (pre-3.4.x) called this with POST; current client uses GET. Routing
// both methods to the same handler keeps users on outdated binaries
// from breaking on speech-to-text setup until auto-update catches up.
// Safe to drop the POST binding once log telemetry shows zero POST
// traffic for several weeks.
const deepgramKeyHandler = async (req, res) => {
  const masterKey = process.env.DEEPGRAM_API_KEY;
  if (!masterKey) return res.status(503).json({ error: 'Deepgram not configured' });

  const projectId = process.env.DEEPGRAM_PROJECT_ID;
  if (!projectId) {
    // Rollout fallback — see header comment. Set DEEPGRAM_PROJECT_ID in
    // your Railway env to switch to ephemeral keys. Warn ONCE per server
    // process; clients reconnect every ~1min during long sessions and the
    // unguarded version flooded the log with the same message.
    if (!_deepgramProjectIdWarned) {
      _deepgramProjectIdWarned = true;
      console.warn('[deepgram] DEEPGRAM_PROJECT_ID not set — cannot mint per-user keys. Configure DEEPGRAM_PROJECT_ID to mint short-lived per-user keys. (suppressing further warnings this process)');
    }
    // Route through fallbackToMasterKey so DEEPGRAM_STRICT_NO_MASTER governs
    // this path too (serve master when permissive, 503 when strict).
    return fallbackToMasterKey(res, masterKey, 'DEEPGRAM_PROJECT_ID not set');
  }

  // Circuit-breaker fast path: a previous request hit a permanent mint
  // failure (403 insufficient scope, etc.). Don't waste an API call.
  if (_deepgramMintDisabled) {
    return fallbackToMasterKey(res, masterKey, _deepgramMintDisabledReason);
  }

  // Tag the key with user identity so the Deepgram dashboard's "Keys"
  // view shows who minted what — easy to spot/revoke abusive sessions.
  // Falls back to IP if for any reason req.user isn't populated (would
  // only happen if authMiddleware was bypassed, which shouldn't occur
  // since this route is mounted under it).
  const userTag = req.user?.id ? `user-${req.user.id}` : `ip-${req.ip || 'unknown'}`;

  try {
    const dgRes = await fetch(`https://api.deepgram.com/v1/projects/${projectId}/keys`, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${masterKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        comment: `minicaai-${userTag}-${Date.now()}`,
        scopes: ['usage:write'],
        time_to_live_in_seconds: DEEPGRAM_KEY_TTL_SECONDS,
      }),
    });

    if (!dgRes.ok) {
      const errText = await dgRes.text().catch(() => '');
      console.error(`[deepgram] mint failed (${dgRes.status}): ${errText.slice(0, 200)}`);

      // 403 = master key lacks the keys:write scope (or project membership).
      // This is PERMANENT until the user fixes it in the Deepgram dashboard,
      // so trip the circuit breaker — every subsequent /deepgram-key call
      // serves the master key directly without re-attempting the mint.
      // 404 = projectId is wrong/deleted — same situation, breaker trip.
      if (dgRes.status === 403 || dgRes.status === 404) {
        _deepgramMintDisabled = true;
        _deepgramMintDisabledReason = `Deepgram returned ${dgRes.status} on key mint (${dgRes.status === 403 ? 'insufficient scope — needs keys:write' : 'project not found — check DEEPGRAM_PROJECT_ID'})`;
        return fallbackToMasterKey(res, masterKey, _deepgramMintDisabledReason);
      }

      // 5xx / 429 / parse error / network — TRANSIENT. Serve master key for
      // this one request so voice mode works, but don't trip the breaker —
      // the next request might succeed.
      if (dgRes.status >= 500 || dgRes.status === 429) {
        return fallbackToMasterKey(res, masterKey, `Deepgram transient ${dgRes.status} — serving master this request`);
      }

      // 401 = master key itself is bad. Falling back wouldn't help (the same
      // key gets handed to the client and would also fail at handshake).
      // Other 4xx = our request body is malformed → genuine code bug.
      return res.status(503).json({ error: 'Voice mode temporarily unavailable' });
    }

    const data = await dgRes.json().catch(() => null);
    // Deepgram returns { api_key_id, key, comment, created, scopes }.
    // We only forward `key` to the client — the rest is for our records.
    if (!data || typeof data.key !== 'string') {
      console.error('[deepgram] mint response missing key field:', JSON.stringify(data || {}).slice(0, 200));
      // Malformed success response — treat as transient, fall back so the
      // user's voice session doesn't drop on a Deepgram-side glitch.
      return fallbackToMasterKey(res, masterKey, 'mint response missing key field');
    }

    res.json({ key: data.key });
  } catch (e) {
    console.error('[deepgram] mint error:', e.message);
    // Network failure / DNS / TLS — transient. Serve master key so the user
    // can keep transcribing while Deepgram is unreachable.
    return fallbackToMasterKey(res, masterKey, `mint exception: ${e.message}`);
  }
};

router.get('/deepgram-key', deepgramKeyHandler);
router.post('/deepgram-key', deepgramKeyHandler);

module.exports = router;

// ── WHAT THIS BUILD ACTUALLY SENDS TO EACH PROVIDER ──
//
// Read by /api/health so "which models are you serving?" is answerable with
// one unauthenticated request instead of by reading a commit and trusting a
// deployment record. It exists because the model name shown in the app is a
// hardcoded CLIENT label (App.tsx MODEL_REGISTRY) that only changes with an
// app release — so the UI can honestly say "GPT-5.5" while the server has
// been calling gpt-5.6 for hours, and there was no way to tell which was
// true from outside.
//
// ⚠️ These must be the SAME string literals the route handlers pass as
// `model:`. A hand-maintained copy would drift and this would then lie
// with confidence, which is worse than saying nothing — so
// test/health-reports-real-models.test.js parses the handlers and fails if
// this list and the `model:` literals in this file ever disagree.
module.exports.servingModels = {
  openai: 'gpt-5.6',
  xai: 'grok-4.5',
  gemini: 'gemini-3.6-flash',
  groq: 'openai/gpt-oss-120b',
  claude: 'claude-sonnet-5',
};

// ── Test surface (Vitest only) ──
// Exposes the exact gate middlewares + tier lists the model routes are
// wired with, so test/free-trial-gate-chain.test.js can prove the full
// chain (region → tier → time) against a real in-memory license row —
// the free-trial contract can then never silently regress in a refactor.
// Runtime callers are unaffected: they import the router itself, and
// extra properties on the router function are invisible to app.use().
module.exports._test = {
  requireTimeRemaining,
  // The session gate, so its backward-compatibility contract can be tested
  // by CALLING it rather than by grepping this file for an implementation
  // shape. An earlier version of that test asserted the regex of an inline
  // version check and broke the moment the check moved into shared
  // middleware — while the behaviour was byte-for-byte identical. A test
  // that fails on a refactor it should not notice trains people to edit the
  // test, which is how a real regression eventually gets waved through.
  requireActiveSession,
  // Exported so the compat test asserts against the gate's OWN threshold
  // rather than MIN_PROTOCOL_CLIENT. The two are deliberately on different
  // releases while the popout/main-window session ownership is fixed; a test
  // that hardcoded either one would go green for the wrong reason.
  SESSION_GATE_MIN_CLIENT,
  LLM_COVER_MIN_CLIENT,
  runCover,
  geminiQuotaGate,
  resolveReasoningEffort,
  extractCurrentQuestion,
  lastUserMessage,
  appendFreshToPrompt,
  appendFreshToMessages,
  appendTextToLastUserMessage,
  AUTO_EFFORT_BY_CATEGORY,
  DEEP_CATEGORIES,
  coverWorthy,
  // Groq's TPM accounting — the arithmetic that made every interview
  // request on gpt-oss-120b impossible. Exported so the fix is pinned.
  parseGroqTpm,
  callGroqWithinTpm,
  describeGroqTpmFailure,
  GROQ_BASE_MAX_TOKENS,
  GROQ_CAP_MAX_TOKENS,
  TRIAL_MODELS,
  PAID,
  CLAUDE_TIERS,
  ULTRA_ONLY,
  _resetPrefetchDedup,
};
