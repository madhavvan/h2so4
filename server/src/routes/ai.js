// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AI PROXY — Server-side AI calls so API keys stay hidden
//  Supports: Gemini, OpenAI, xAI (Grok), Groq, Claude
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

// All AI routes require authentication
router.use(authMiddleware);

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
router.post('/chat/openai', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OpenAI not configured' });

  try {
    const { messages } = req.body;
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey });

    const completion = await openai.chat.completions.create({
      model: 'gpt-5.4-mini',
      messages,
      max_completion_tokens: 16000,
      temperature: 0.7,
    });

    res.json({ text: completion.choices[0]?.message?.content || '' });
  } catch (err) {
    console.error('OpenAI proxy error:', err.message);
    res.status(500).json({ error: 'AI request failed', detail: err.message });
  }
});

// ── xAI (Grok) ──
router.post('/chat/xai', async (req, res) => {
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
router.post('/chat/groq', async (req, res) => {
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

router.post('/chat/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !Anthropic) return res.status(503).json({ error: 'Claude not configured' });

  try {
    const { messages, systemInstruction, enableWebSearch } = req.body;
    const client = new Anthropic({ apiKey });

    const tools = [];
    if (enableWebSearch !== false) {
      tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 2 });
    }

    const system = systemInstruction
      ? [{ type: 'text', text: systemInstruction, cache_control: { type: 'ephemeral' } }]
      : undefined;

    const completion = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
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
router.post('/stream/openai', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OpenAI not configured' });

  const sse = openSseStream(req, res);
  try {
    const { messages } = req.body;
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey });

    const stream = await openai.chat.completions.create(
      {
        model: 'gpt-5.4-mini',
        messages,
        max_completion_tokens: 16000,
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
    console.error('OpenAI stream error:', err.message);
    sse.error(err.message || 'AI request failed');
    sse.done();
  }
});

// ── xAI Grok (stream) ──
router.post('/stream/xai', async (req, res) => {
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
router.post('/stream/groq', async (req, res) => {
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
router.post('/stream/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !Anthropic) return res.status(503).json({ error: 'Claude not configured' });

  const sse = openSseStream(req, res);
  try {
    const { messages, systemInstruction, enableWebSearch } = req.body;
    const client = new Anthropic({ apiKey });

    const tools = [];
    if (enableWebSearch !== false) {
      tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 2 });
    }

    const system = systemInstruction
      ? [{ type: 'text', text: systemInstruction, cache_control: { type: 'ephemeral' } }]
      : undefined;

    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
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

// ── Deepgram API key (app fetches this to connect WebSocket) ──
router.get('/deepgram-key', (req, res) => {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return res.status(503).json({ error: 'Deepgram not configured' });
  res.json({ key });
});

module.exports = router;
