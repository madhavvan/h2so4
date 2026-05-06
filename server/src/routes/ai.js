// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AI PROXY — Server-side AI calls so API keys stay hidden
//  Supports: Gemini, OpenAI, xAI (Grok), Groq, Claude
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { requireTier } = require('../middleware/tier');
const router = express.Router();

// All AI routes require authentication
router.use(authMiddleware);

// ── Tier gate aliases ──
// Mirrors services/licenseService.ts FEATURE_GATES.models, in shorthand:
//   - PAID  → basic + pro + max  (GPT-5.5, Grok, Llama-4-Scout)
//   - MAX   → max only           (Claude Sonnet 4.6, Auto-Type planner)
// Free tier: only Gemini, ungated. Defined here so adding a new model
// route only requires picking the right gate, not hand-listing tiers.
const PAID = ['basic', 'pro', 'max'];
const MAX_ONLY = ['max'];

// ── Gemini ──
router.post('/chat/gemini', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Gemini not configured' });

  try {
    const { prompt, systemInstruction, history, fileParts } = req.body;

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
        systemInstruction: systemInstruction || '',
        temperature: 0.7,
      }
    });

    res.json({ text: response.text || '' });
  } catch (err) {
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
// avoids surprise bills if a UI bug ever sent it.
const ALLOWED_REASONING_EFFORTS = ['none', 'low', 'medium', 'high'];

// Single source of truth for tier-gating + validation. Returns the
// effort string to pass to OpenAI. Non-Max tiers always get 'none'
// regardless of what the client sent — defense in depth, since the
// client UI also locks the bar but a tampered client could bypass it.
//
// Default fallback is 'none' — matches the new product policy: every
// non-Max tier is locked to 'none' anyway, and Max users on the new
// client always send an explicit value. An old client that doesn't
// send the field at all (3.4.6 and earlier) deliberately gets 'none' so
// the new "instant first-response" baseline applies uniformly across
// the user base — Max users on old clients briefly see this until they
// update; they've never had reasoning-effort control before, so this
// is a product decision, not a regression.
function resolveReasoningEffort(req) {
  const requested = (req.body && typeof req.body.reasoning_effort === 'string')
    ? req.body.reasoning_effort
    : 'none';
  const validated = ALLOWED_REASONING_EFFORTS.includes(requested) ? requested : 'none';
  // req.license.tier is set by requireTier middleware (mirrors the live
  // license row, not the JWT — handles tier upgrades that landed after
  // login without forcing re-auth).
  const tier = req.license?.tier || 'free';
  if (tier !== 'max' && validated !== 'none') {
    return 'none';
  }
  return validated;
}

router.post('/chat/openai', requireTier(...PAID), async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OpenAI not configured' });

  try {
    const { messages } = req.body;
    const reasoningEffort = resolveReasoningEffort(req);
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey });

    const completion = await openai.chat.completions.create({
      model: 'gpt-5.5',
      messages,
      max_completion_tokens: 16000,
      reasoning_effort: reasoningEffort,
    });

    res.json({ text: completion.choices[0]?.message?.content || '' });
  } catch (err) {
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
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });

    const completion = await client.chat.completions.create({
      model: 'grok-4-1-fast-non-reasoning',
      messages,
      max_tokens: 1600,
      temperature: 0.7,
    });

    res.json({ text: completion.choices[0]?.message?.content || '' });
  } catch (err) {
    console.error('xAI proxy error:', err.message);
    res.status(500).json({ error: 'AI request failed', detail: err.message });
  }
});

// ── Groq ──
router.post('/chat/groq', requireTier(...PAID), async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Groq not configured' });

  try {
    const { messages } = req.body;
    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey });

    const completion = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages,
      temperature: 0.7,
    });

    res.json({ text: completion.choices[0]?.message?.content || '' });
  } catch (err) {
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
    const client = new Anthropic({ apiKey });

    const tools = [];
    if (enableWebSearch !== false) {
      tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 3 });
    }

    const system = systemInstruction
      ? [{ type: 'text', text: systemInstruction, cache_control: { type: 'ephemeral' } }]
      : undefined;

    const completion = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
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
router.post('/stream/gemini', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Gemini not configured' });

  const sse = openSseStream(req, res);
  try {
    const { prompt, systemInstruction, fileParts } = req.body;
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
        systemInstruction: systemInstruction || '',
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
    const reasoningEffort = resolveReasoningEffort(req);
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey });

    const stream = await openai.chat.completions.create(
      {
        model: 'gpt-5.5',
        messages,
        max_completion_tokens: 16000,
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
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });

    const stream = await client.chat.completions.create(
      {
        model: 'grok-4-1-fast-non-reasoning',
        messages,
        max_tokens: 1600,
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
    console.error('xAI stream error:', err.message);
    sse.error(err.message || 'AI request failed');
    sse.done();
  }
});

// ── Groq (stream) ──
router.post('/stream/groq', requireTier(...PAID), async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Groq not configured' });

  const sse = openSseStream(req, res);
  try {
    const { messages } = req.body;
    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey });

    const stream = await groq.chat.completions.create(
      {
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages,
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
    const client = new Anthropic({ apiKey });

    const tools = [];
    if (enableWebSearch !== false) {
      tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 3 });
    }

    const system = systemInstruction
      ? [{ type: 'text', text: systemInstruction, cache_control: { type: 'ephemeral' } }]
      : undefined;

    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
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

function fallbackToMasterKey(res, masterKey, reason) {
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
      console.warn('[deepgram] DEEPGRAM_PROJECT_ID not set — serving master key (security fallback). Configure DEEPGRAM_PROJECT_ID to mint short-lived per-user keys. (suppressing further warnings this process)');
    }
    return res.json({ key: masterKey });
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
