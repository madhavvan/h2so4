// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  HOW LONG IS THE SILENCE, PER MODEL?
//
//  The cover exists to fill the gap between the question landing and the
//  main model's first word. Every design decision about it — how long the
//  opener should be, which routes need one at all, how much budget the
//  provider chain may spend — depends on ONE number per model: time to
//  first token on a realistic interview prompt.
//
//  Those numbers were assumed, never measured across the whole fleet.
//  This measures them. Aborts each stream at the first token, so the bill
//  is a few cents for the entire matrix.
//
//  Usage:  node --env-file=.env scripts/ttft-matrix.mjs
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// A realistic system prompt: the rules block measured at ~7,074 tokens
// dominates every request, so a toy prompt would understate prefill.
const SYSTEM = ('You are the candidate in a live technical interview. '
  + 'Answer in first person, spoken register, no markdown headers. ').repeat(200);

const QUESTIONS = [
  { label: 'behavioral', q: 'Tell me about a time a production pipeline broke and you were the one who had to fix it.' },
  { label: 'system_design', q: 'How would you design exactly-once delivery from an event stream into a warehouse when the sink is not idempotent and you cannot change it?' },
];

function now() { return Number(process.hrtime.bigint() / 1000000n); }

async function timeStream(makeStream) {
  const t0 = now();
  try {
    const stream = await makeStream();
    for await (const ev of stream) {
      const piece = typeof ev === 'string' ? ev : (ev?.text ?? ev?.choices?.[0]?.delta?.content ?? (ev?.type === 'content_block_delta' ? ev.delta?.text : null));
      if (piece) return { ms: now() - t0, sample: String(piece).slice(0, 30) };
    }
    return { ms: now() - t0, sample: '(no text)' };
  } catch (err) {
    return { ms: now() - t0, error: String(err?.message || err).slice(0, 120) };
  }
}

const rows = [];
const record = async (name, fn) => {
  const r = await timeStream(fn);
  rows.push({ name, ...r });
  const tag = r.error ? `ERROR ${r.error}` : `${r.ms}ms`;
  console.log(`${name.padEnd(46)} ${tag}`);
};

// ── Main answer models ──
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const Groq = require('groq-sdk');
const { GoogleGenAI } = require('@google/genai');

for (const { label, q } of QUESTIONS) {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: q }];

  if (process.env.OPENAI_API_KEY) {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    for (const effort of ['none', 'low', 'medium', 'high']) {
      await record(`gpt-5.6 effort=${effort} [${label}]`, () => openai.chat.completions.create({
        model: 'gpt-5.6', messages, max_completion_tokens: 16000, reasoning_effort: effort, stream: true,
      }));
    }
  }

  if (process.env.ANTHROPIC_API_KEY) {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    await record(`claude-sonnet-5 effort=low [${label}]`, () => anthropic.messages.stream({
      model: 'claude-sonnet-5', max_tokens: 16000, system: SYSTEM,
      messages: [{ role: 'user', content: q }], output_config: { effort: 'low' },
    }));
  }

  if (process.env.XAI_API_KEY) {
    const xai = new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: 'https://api.x.ai/v1' });
    await record(`grok-4.5 [${label}]`, () => xai.chat.completions.create({
      model: 'grok-4.5', messages, max_tokens: 8000, temperature: 0.7, stream: true,
    }));
  }

  if (process.env.GROQ_API_KEY) {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    await record(`groq gpt-oss-120b [${label}]`, () => groq.chat.completions.create({
      model: 'openai/gpt-oss-120b', messages, max_tokens: 8000, temperature: 0.7, stream: true,
    }));
  }

  if (process.env.GEMINI_API_KEY) {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    for (const thinkingLevel of ['MINIMAL', 'LOW']) {
      await record(`gemini-3.6-flash think=${thinkingLevel} [${label}]`, () => ai.models.generateContentStream({
        model: 'gemini-3.6-flash',
        contents: [{ role: 'user', parts: [{ text: q }] }],
        config: { systemInstruction: SYSTEM, thinkingConfig: { thinkingLevel } },
      }));
    }
  }
}

// ── Cover providers, on the real cover prompt ──
const { COVER_SYSTEM, userPrompt } = require('../src/services/coverAnswer.js');
const RESUME = `PROFESSIONAL SUMMARY
Senior Data Engineer, 4+ years building streaming and batch platforms.
WORK EXPERIENCE
Fidelity Investments - Data Engineer. Kafka to Snowflake CDC, Airflow orchestration, dbt models.
Optum - Data Engineer. Claims pipelines on Spark, 41B rows, Aurora migration.`;

for (const { label, q } of QUESTIONS) {
  const up = userPrompt(q, label, RESUME);
  if (process.env.GROQ_API_KEY) {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY, maxRetries: 0, timeout: 2500 });
    await record(`COVER groq llama-3.3-70b [${label}]`, () => groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: COVER_SYSTEM }, { role: 'user', content: up }],
      max_tokens: 80, temperature: 0.7, stream: true,
    }));
  }
  if (process.env.GEMINI_API_KEY) {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    await record(`COVER gemini-3.6-flash [${label}]`, () => ai.models.generateContentStream({
      model: 'gemini-3.6-flash',
      contents: [{ role: 'user', parts: [{ text: up }] }],
      config: { systemInstruction: COVER_SYSTEM, thinkingConfig: { thinkingLevel: 'MINIMAL' }, maxOutputTokens: 90 },
    }));
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: 2500 });
    await record(`COVER claude-haiku-4-5 [${label}]`, () => anthropic.messages.create({
      model: 'claude-haiku-4-5', max_tokens: 90, system: COVER_SYSTEM,
      messages: [{ role: 'user', content: up }], stream: true,
    }));
  }
}

console.log('\n─── SUMMARY ───');
for (const r of rows) console.log(`${r.name.padEnd(46)} ${r.error ? 'ERROR: ' + r.error : r.ms + 'ms'}`);
