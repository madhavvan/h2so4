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

const { enrichTranscript } = require('../services/freshContext');

// Pull the most recent user-role message from a messages array.
// Used by all "messages: [...]"-shaped routes (OpenAI/xAI/Groq/Claude).
function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
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

// Prepend FRESH_CONTEXT to the existing system instruction. Order
// matters: grounding evidence first, voice rules after. The model is
// instructed (in freshContext.formatContext) to internalize, not cite.
function prependFreshToSystem(systemInstruction, freshContext) {
  if (!freshContext) return systemInstruction;
  const existing = String(systemInstruction || '');
  return existing ? `${freshContext}\n\n${existing}` : freshContext;
}

// Same idea but for messages-array shape: find the system message and
// prepend its content; if no system message exists, insert one at [0].
function prependFreshToMessages(messages, freshContext) {
  if (!freshContext) return messages;
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const sysIdx = messages.findIndex(m => m && m.role === 'system');
  if (sysIdx === -1) {
    return [{ role: 'system', content: freshContext }, ...messages];
  }
  const copy = messages.slice();
  const cur = copy[sysIdx] || {};
  copy[sysIdx] = { ...cur, content: prependFreshToSystem(cur.content, freshContext) };
  return copy;
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
// Mirrors services/licenseService.ts FEATURE_GATES.models, in shorthand:
//   - PAID  → basic + pro + max  (GPT-5.5, Grok, Groq GPT-OSS-120B)
//   - MAX   → max only           (Claude Sonnet 4.6, Auto-Type planner)
// Free tier: only Gemini, ungated. Defined here so adding a new model
// route only requires picking the right gate, not hand-listing tiers.
const PAID = ['basic', 'pro', 'max'];
const MAX_ONLY = ['max'];

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
router.post('/chat/gemini', geminiQuotaGate, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Gemini not configured' });

  try {
    const { prompt, systemInstruction, history, fileParts } = req.body;
    const fresh = await tryEnrich(prompt, req.headers['x-request-id']);
    const enrichedSystem = prependFreshToSystem(systemInstruction, fresh?.context);

    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    const parts = [];
    // Add binary file parts (images/PDFs)
    if (fileParts && fileParts.length > 0) {
      fileParts.forEach(fp => parts.push({ inlineData: { mimeType: fp.mimeType, data: fp.data } }));
    }
    parts.push({ text: prompt });

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: enrichedSystem || '',
        temperature: 0.7,
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
// GPT-5.5 reasoning_effort knob. Accepted values for gpt-5.5 are
// `none, low, medium, high, xhigh` — `minimal` is gpt-5-only and
// returns HTTP 400 here. The client (App.tsx) sends the user's
// chosen level in `req.body.reasoning_effort`; resolveReasoningEffort
// validates the input AND tier-gates it: only Max users can pick
// anything other than 'none'. Without the tier gate, a tampered
// client could escalate to 'high' on a basic/pro subscription.
//
// We deliberately do NOT pass `verbosity` — that parameter is on
// the Responses API surface and openai-node's chat.completions
// types only accept it inconsistently across versions. Passing it
// would risk 400'ing every paid user. (See openai-python #2610.)
//
// Temperature is still omitted — GPT-5.5 rejects any non-default
// value with HTTP 400. Same for top_p / presence_penalty /
// frequency_penalty / logprobs.

// Allowed values for the chat.completions API on gpt-5.5. 'xhigh' is
// supported by the model but intentionally not exposed to clients —
// avoids surprise bills if a UI bug ever sent it. 'auto' is a special
// pseudo-value that triggers question-shape-based effort selection
// (coding→low, system design→medium, etc.); it never reaches OpenAI.
const ALLOWED_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'auto'];

// Auto-effort mapping: question category → reasoning_effort value.
// EVERYTHING DEFAULTS TO 'none'. Rationale: the Brave-backed fresh-context
// retrieval already supplies the model with grounded, current evidence
// for the question shapes that previously benefited from extra reasoning
// (system design, ML, case/strategy — all the analytical categories).
// Once the model has authoritative source content in its prompt, extra
// reasoning_effort buys very little quality and costs material latency
// (+5-15s on hard categories with 'medium'). Speed wins.
//
// The mapping stays as a Map (not a constant 'none') so a future
// per-category bump is a one-line change if we ever decide a specific
// shape benefits from reasoning that fresh-context can't provide.
//
// Users who explicitly want 'low' / 'medium' / 'high' can still pick
// those manually from the reasoning-effort dial — we honor explicit
// choice and only auto-pick when the client sends 'auto' or no value.
const AUTO_EFFORT_BY_CATEGORY = {
  coding:         'none',
  system_design:  'none',  // Brave fresh-context covers the trade-off depth
  ml_data:        'none',  // Brave fresh-context covers the model-choice depth
  quantitative:   'none',
  strategy_case:  'none',  // Brave fresh-context covers recent business signals
  behavioral:     'none',
  concept:        'none',
  clarifier:      'none',
  other:          'none',
};

const { classifyQuestion } = require('../services/questionClassifier');

// Single source of truth for tier-gating + validation. Returns the
// effort string to pass to OpenAI. Non-Max tiers always get 'none'
// regardless of what the client sent — defense in depth, since the
// client UI also locks the bar but a tampered client could bypass it.
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

  // Auto mode: classify the transcript and map category → effort.
  let validated;
  if (requested === 'auto') {
    const t = transcript || (Array.isArray(req.body?.messages)
      ? lastUserMessage(req.body.messages) : '');
    const { category } = classifyQuestion(t);
    validated = AUTO_EFFORT_BY_CATEGORY[category] || 'low';
  } else {
    validated = requested;
  }

  // Tier gate: non-Max users always get 'none' (cost control — high
  // reasoning_effort is ~5x the per-call cost). Auto-classification
  // for non-Max users still runs but is silently downgraded here.
  const tier = req.license?.tier || 'free';
  if (tier !== 'max' && validated !== 'none') {
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
// Provider hard caps as of 2026-05:
//   OpenAI gpt-5.5            16,384 max_completion_tokens
//   Anthropic Sonnet 4.6      64,000 max_tokens
//   xAI grok-4-1-fast         8,000 max_tokens (model-specific)
//   Groq openai/gpt-oss-120b  8,192 max_tokens
//   Gemini 3-flash-preview    8,192 maxOutputTokens (SDK default)
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

router.post('/chat/openai', requireTier(...PAID), async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OpenAI not configured' });

  try {
    const { messages } = req.body;
    const fresh = await tryEnrich(lastUserMessage(messages), req.headers['x-request-id']);
    const enrichedMessages = prependFreshToMessages(messages, fresh?.context);

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
      model: 'gpt-5.5',
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
router.post('/chat/xai', requireTier(...PAID), async (req, res) => {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'xAI not configured' });

  try {
    const { messages } = req.body;
    const fresh = await tryEnrich(lastUserMessage(messages), req.headers['x-request-id']);
    const enrichedMessages = prependFreshToMessages(messages, fresh?.context);

    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });

    // Match the stream-route bump: 1,600 was a leftover from the
    // fast-response experiment and truncated long answers; 8,000
    // baseline is the new floor with scaling on top.
    const sysText = extractSystemText(enrichedMessages);
    const maxTokens = scaleTokensForInstructions(sysText, 8000, 8000);

    const completion = await client.chat.completions.create({
      model: 'grok-4-1-fast-non-reasoning',
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
//     other chat models (Sonnet, GPT-5.5, Gemini 3 Flash). Scout-17B
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
router.post('/chat/groq', requireTier(...PAID), async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Groq not configured' });

  try {
    const { messages } = req.body;
    const fresh = await tryEnrich(lastUserMessage(messages), req.headers['x-request-id']);
    const enrichedMessages = prependFreshToMessages(messages, fresh?.context);

    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey });

    // Mirror the stream-route scaling — keeps chat + stream parity for
    // STAR / detailed custom-instruction users hitting this path.
    const sysText = extractSystemText(enrichedMessages);
    const maxTokens = scaleTokensForInstructions(sysText, 8000, 8192);

    const completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: enrichedMessages,
      max_tokens: maxTokens,
      temperature: 0.7,
    });

    res.json({ text: completion.choices[0]?.message?.content || '' });
  } catch (err) {
    if (is429(err)) {
      console.warn('[groq] upstream 429:', err.message);
      return res.status(429).json(rateLimitedJson('Groq'));
    }
    console.error('Groq proxy error:', err.message);
    res.status(500).json({ error: 'AI request failed', detail: err.message });
  }
});

// ── Claude (Anthropic) — Sonnet 4.6 with hosted web_search tool ──
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

router.post('/chat/claude', requireTier(...MAX_ONLY), async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !Anthropic) return res.status(503).json({ error: 'Claude not configured' });

  try {
    const { messages, systemInstruction, enableWebSearch } = req.body;
    const fresh = await tryEnrich(lastUserMessage(messages), req.headers['x-request-id']);
    const enrichedSystem = prependFreshToSystem(systemInstruction, fresh?.context);

    const client = new Anthropic({ apiKey });

    const tools = [];
    if (enableWebSearch !== false) {
      tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 3 });
    }

    const system = enrichedSystem
      ? [{ type: 'text', text: enrichedSystem, cache_control: { type: 'ephemeral' } }]
      : undefined;

    // Match the stream route — non-streaming chat path also needs
    // custom-instruction-aware token scaling. Sonnet 4.6 supports
    // up to 64,000 max_tokens, so STAR / detailed responses can scale
    // up to 32,000 here without truncation.
    const maxTokens = scaleTokensForInstructions(enrichedSystem || '', 16000, 64000);

    const completion = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages,
      tools: tools.length ? tools : undefined,
      temperature: 0.7,
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
});

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

  // Per-request AbortController: hooked to the TCP `close` event so
  // that a client disconnect immediately stops whatever we're reading
  // from the upstream provider. Without this we'd keep for-await'ing
  // tokens no one will ever see — and paying for them.
  const controller = new AbortController();
  let closed = false;
  const onClose = () => {
    if (closed) return;
    closed = true;
    try { controller.abort(); } catch {}
  };
  req.on('close', onClose);

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
router.post('/stream/gemini', geminiQuotaGate, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Gemini not configured' });

  const sse = openSseStream(req, res);
  try {
    const { prompt, systemInstruction, fileParts } = req.body;
    const fresh = await tryEnrich(prompt, req.headers['x-request-id']);
    const enrichedSystem = prependFreshToSystem(systemInstruction, fresh?.context);

    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    const parts = [];
    if (fileParts && fileParts.length > 0) {
      fileParts.forEach(fp => parts.push({ inlineData: { mimeType: fp.mimeType, data: fp.data } }));
    }
    parts.push({ text: prompt });

    const stream = await ai.models.generateContentStream({
      model: 'gemini-3-flash-preview',
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: enrichedSystem || '',
        temperature: 0.7,
        abortSignal: sse.signal,
      }
    });

    for await (const event of stream) {
      if (sse.closed) break;
      const piece = event?.text;
      if (piece) sse.send(piece);
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
// resolveReasoningEffort (validates the value AND tier-gates — only Max
// users can opt into anything beyond 'none'). See the chat handler
// comment block above for full rationale on which params are safe to pass.
router.post('/stream/openai', requireTier(...PAID), async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OpenAI not configured' });

  const sse = openSseStream(req, res);
  try {
    const { messages } = req.body;
    const fresh = await tryEnrich(lastUserMessage(messages), req.headers['x-request-id']);
    const enrichedMessages = prependFreshToMessages(messages, fresh?.context);

    const reasoningEffort = resolveReasoningEffort(req);
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey });

    // Scale max_completion_tokens based on user custom instructions
    // embedded in the system prompt (STAR method / detailed / etc.).
    // Base 16,000 already near gpt-5.5's hard cap of 16,384, so the
    // scaling is mostly a no-op here — but the helper is still applied
    // for symmetry with the other 3 stream providers and so future
    // base bumps automatically respect the cap.
    const sysText = extractSystemText(enrichedMessages);
    const maxTokens = scaleTokensForInstructions(sysText, 16000, 16384);

    const stream = await openai.chat.completions.create(
      {
        model: 'gpt-5.5',
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
      if (piece) sse.send(piece);
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
router.post('/stream/xai', requireTier(...PAID), async (req, res) => {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'xAI not configured' });

  const sse = openSseStream(req, res);
  try {
    const { messages } = req.body;
    const fresh = await tryEnrich(lastUserMessage(messages), req.headers['x-request-id']);
    const enrichedMessages = prependFreshToMessages(messages, fresh?.context);

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

    const stream = await client.chat.completions.create(
      {
        model: 'grok-4-1-fast-non-reasoning',
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
      if (piece) sse.send(piece);
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
router.post('/stream/groq', requireTier(...PAID), async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Groq not configured' });

  const sse = openSseStream(req, res);
  try {
    const { messages } = req.body;
    const fresh = await tryEnrich(lastUserMessage(messages), req.headers['x-request-id']);
    const enrichedMessages = prependFreshToMessages(messages, fresh?.context);

    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey });

    // Groq base 8,000 with hard cap 8,192 — scaling is mostly a no-op
    // here (already near cap) but helper is applied for symmetry with
    // the other providers; long-form custom instructions push to 8,192.
    const sysText = extractSystemText(enrichedMessages);
    const maxTokens = scaleTokensForInstructions(sysText, 8000, 8192);

    const stream = await groq.chat.completions.create(
      {
        model: 'openai/gpt-oss-120b',
        max_tokens: maxTokens,
        messages: enrichedMessages,
        temperature: 0.7,
        stream: true,
      },
      { signal: sse.signal }
    );

    for await (const chunk of stream) {
      if (sse.closed) break;
      const piece = chunk?.choices?.[0]?.delta?.content;
      if (piece) sse.send(piece);
    }
    sse.done();
  } catch (err) {
    if (err?.name === 'AbortError' || sse.closed) { sse.done(); return; }
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

// ── Claude (stream) — Sonnet 4.6 with web_search ──
// Anthropic's `messages.stream(...)` returns a MessageStream helper with
// a `.on('text', cb)` event that fires for every text delta, hiding the
// raw content_block_delta filtering. Web-search activity (server_tool_use,
// web_search_tool_result, partial input_json_delta) is silently filtered
// out by the helper, so the candidate sees only the final answer text.
// Web search runs server-side on Anthropic's infra during a single API
// call — no extra round-trip on our end.
router.post('/stream/claude', requireTier(...MAX_ONLY), async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !Anthropic) return res.status(503).json({ error: 'Claude not configured' });

  const sse = openSseStream(req, res);
  try {
    const { messages, systemInstruction, enableWebSearch } = req.body;
    const fresh = await tryEnrich(lastUserMessage(messages), req.headers['x-request-id']);
    const enrichedSystem = prependFreshToSystem(systemInstruction, fresh?.context);

    const client = new Anthropic({ apiKey });

    const tools = [];
    if (enableWebSearch !== false) {
      tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 3 });
    }

    const system = enrichedSystem
      ? [{ type: 'text', text: enrichedSystem, cache_control: { type: 'ephemeral' } }]
      : undefined;

    // Claude Sonnet 4.6 supports up to 64,000 max_tokens. Base 16,000
    // is fine for most answers; long-form custom instructions (STAR
    // method, comprehensive deep-dives) scale up to 32,000+ here.
    // The systemInstruction is the cached static block, so the user's
    // custom instructions (prepended to it client-side) get cached
    // along with it — repeat calls read at 10% input cost.
    const maxTokens = scaleTokensForInstructions(enrichedSystem || '', 16000, 64000);

    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages,
      tools: tools.length ? tools : undefined,
      temperature: 0.7,
    }, { signal: sse.signal });

    stream.on('text', (textDelta) => {
      if (sse.closed) return;
      if (textDelta) sse.send(textDelta);
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
//  /autotype-agent — Sonnet 4.6 with tool-use (the "god-level" path)
//  Replaces the v1 Haiku one-shot at /autotype-plan. Sonnet's chain-
//  of-thought + tool_use guarantees richer plans for the hard cases
//  (HackerRank templates, mid-file insertions, partial signatures).
//  Caller uses this when deterministic UIA confidence < 0.85.
//  Cost: ~$0.013/call. Max-tier only.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Two-tier planner: Sonnet 4.6 (primary) → Groq Llama-3.3-70B (fallback).
// Both are AI agents with forced tool_choice, but they run on different
// vendors so an Anthropic outage doesn't sink Tier 2 entirely. The caller
// (electron/main.cjs) treats the response as opaque — `planner_used` in
// the body identifies which vendor served the plan.
router.post('/autotype-agent', requireTier(...MAX_ONLY), async (req, res) => {
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

  // ── Primary: Sonnet 4.6 ──
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
// text dump; Sonnet 4.6 reads the pixels, locates the caret, and returns
// the same plan shape the typing engine already consumes (plus the
// `move_relative` / `lines_delta` fields for invisible counted-arrow
// cursor repositioning). Falls through (caller's responsibility) to the
// text agent / Haiku / deterministic chain on any non-2xx.
router.post('/autotype-vision', requireTier(...MAX_ONLY), async (req, res) => {
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

router.post('/autotype-plan', requireTier(...MAX_ONLY), async (req, res) => {
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
