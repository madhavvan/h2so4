// One-off LIVE end-to-end smoke: boots THIS working tree's server on an
// isolated port and drives real authenticated HTTP requests through the
// full chain (auth → regionGate → tier/time gates → route handler →
// provider → response). Catches what unit tests can't: stale identifiers
// inside handler bodies, param rejections, SSE plumbing.
// Run: node --env-file=.env scripts/e2e-live.mjs   (from server/)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');

const PORT = '4517'; // isolated — never collides with a running dev server on 4000
const BASE = `http://127.0.0.1:${PORT}`;
const adminEmail = (process.env.ADMIN_EMAILS || '').split(',')[0]?.trim();
if (!adminEmail || !process.env.JWT_SECRET) {
  console.log('E2E ABORT: ADMIN_EMAILS or JWT_SECRET missing in .env');
  process.exit(1);
}
const token = jwt.sign({ id: 'e2e-smoke-user', email: adminEmail }, process.env.JWT_SECRET, { expiresIn: '10m' });
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

const RULES = `<<<RESPONSE RULES — FOLLOW EXACTLY>>>\nEx: "Tell me about a time you debugged an issue."\n<<<END RESPONSE RULES>>>\n\n---\n\n`;
const DEEP_Q = 'How would you design a rate limiter that supports per-user quotas across multiple regions?';
const SYS = 'You are the candidate in a live interview. KNOWLEDGE BASE: senior data engineer, Kafka + Spark + Postgres. Answer briefly.';

const server = spawn(process.execPath, ['--env-file=.env', 'src/index.js'], {
  env: { ...process.env, PORT },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
server.stdout.on('data', d => { bootLog += d; });
server.stderr.on('data', d => { bootLog += d; });

const up = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/v1/ai/deepgram-key`, { headers: H });
      if (r.status) return r;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
};

const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };

try {
  const dg = await up();
  if (!dg) {
    console.log('FAIL  server-boot  never came up. Boot log tail:\n' + bootLog.slice(-1500));
    process.exit(1);
  }
  const dgBody = await dg.json().catch(() => ({}));
  record('deepgram-key', dg.status === 200 && typeof dgBody.key === 'string' && dgBody.key.length > 10,
    `http=${dg.status} keyLen=${dgBody.key ? dgBody.key.length : 0}`);

  // Gemini chat — composed gemini-shape prompt, DEEP question → exercises
  // extractCurrentQuestion → classify → thinkingLevel LOW → live Gemini.
  const gemPrompt = `${RULES}Interviewer (Transcript): what is a hashmap?\nCandidate (You): a key-value store.\n\nInterviewer (Current Audio): ${DEEP_Q}\n\n[Remember: draw from the Knowledge Base where relevant.]\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.`;
  const gem = await fetch(`${BASE}/api/v1/ai/chat/gemini`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ prompt: gemPrompt, systemInstruction: SYS, fileParts: [] }),
  });
  const gemBody = await gem.json().catch(() => ({}));
  record('chat/gemini deep→LOW', gem.status === 200 && (gemBody.text || '').length > 20,
    `http=${gem.status} textLen=${(gemBody.text || '').length}`);

  // OpenAI SSE stream — auto effort on a deep question (→ 'low'),
  // multimodal-array final user turn → exercises appendFreshToMessages
  // array path + lastUserMessage array support + SSE framing.
  const oaMessages = [
    { role: 'system', content: SYS },
    { role: 'user', content: [{ type: 'text', text: `${RULES}${DEEP_Q}\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.` }] },
  ];
  const oa = await fetch(`${BASE}/api/v1/ai/stream/openai`, {
    method: 'POST', headers: { ...H, Accept: 'text/event-stream' },
    body: JSON.stringify({ messages: oaMessages, reasoning_effort: 'auto' }),
  });
  let oaText = ''; let sawDone = false;
  if (oa.ok && oa.body) {
    const reader = oa.body.getReader(); const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, sep); buf = buf.slice(sep + 2);
        const line = frame.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { sawDone = true; continue; }
        try { const p = JSON.parse(payload); if (p.t) oaText += p.t; } catch {}
      }
    }
  }
  record('stream/openai auto+array', oa.status === 200 && sawDone && oaText.length > 20,
    `http=${oa.status} done=${sawDone} textLen=${oaText.length}`);

  // Claude chat — array-content final user turn + cache_control system.
  const clMessages = [
    { role: 'user', content: [{ type: 'text', text: `${RULES}Interviewer (Current Audio): What is the difference between REST and GraphQL?\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.` }] },
  ];
  const cl = await fetch(`${BASE}/api/v1/ai/chat/claude`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ messages: clMessages, systemInstruction: SYS, enableWebSearch: false }),
  });
  const clBody = await cl.json().catch(() => ({}));
  record('chat/claude array-content', cl.status === 200 && (clBody.text || '').length > 20,
    `http=${cl.status} textLen=${(clBody.text || '').length}`);

  // Cover engine — explicit 'low' effort forces the cover path. Expect:
  // first token FAST (cover from Gemini, target <2s), a continuation much
  // longer than the 12-30-word cover, and no verbatim repetition of the
  // opening (the no-repeat continuation contract).
  const cvMessages = [
    { role: 'system', content: SYS },
    { role: 'user', content: `${RULES}${DEEP_Q}\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.` },
  ];
  const t0 = Date.now();
  let cvTtft = null; let cvText = ''; let cvDone = false;
  const cv = await fetch(`${BASE}/api/v1/ai/stream/openai`, {
    method: 'POST', headers: { ...H, Accept: 'text/event-stream' },
    body: JSON.stringify({ messages: cvMessages, reasoning_effort: 'low' }),
  });
  if (cv.ok && cv.body) {
    const reader = cv.body.getReader(); const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, sep); buf = buf.slice(sep + 2);
        const line = frame.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { cvDone = true; continue; }
        try {
          const p = JSON.parse(payload);
          if (p.t) { if (cvTtft === null) cvTtft = Date.now() - t0; cvText += p.t; }
        } catch {}
      }
    }
  }
  const opening = cvText.split(/\s+/).slice(0, 8).join(' ');
  const repeated = opening.length > 20 && cvText.indexOf(opening, opening.length) !== -1;
  record('cover-engine stream/openai low',
    cv.status === 200 && cvDone && cvTtft !== null && cvTtft < 2500 && cvText.split(/\s+/).length > 60 && !repeated,
    `http=${cv.status} TTFT=${cvTtft}ms words=${cvText.split(/\s+/).length} repeatedOpening=${repeated}`);
  console.log('--- cover-engine sample (first 450 chars) ---\n' + cvText.slice(0, 450) + '\n---');

  const failed = results.filter(r => !r.ok);
  if (failed.length) {
    console.log('--- boot log tail ---\n' + bootLog.slice(-1200));
  }
  console.log(failed.length === 0 ? 'E2E: ALL PASS' : `E2E: ${failed.length} FAILURE(S)`);
} finally {
  server.kill();
}
