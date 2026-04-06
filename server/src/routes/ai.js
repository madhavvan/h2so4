// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AI PROXY — Server-side AI calls so API keys stay hidden
//  Supports: Gemini, OpenAI, xAI (Grok), Groq
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
      model: 'grok-4-1-fast',
      messages,
      max_tokens: 350,
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

// ── Deepgram API key (app fetches this to connect WebSocket) ──
router.get('/deepgram-key', (req, res) => {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return res.status(503).json({ error: 'Deepgram not configured' });
  res.json({ key });
});

module.exports = router;
