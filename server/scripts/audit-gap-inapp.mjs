// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE BENCH LIED. MEASURE THE GAP WHERE IT ACTUALLY HAPPENS.
//
//  scripts/ttft-matrix.mjs measures a provider with a ~5K-token system
//  prompt and a bare question. The REAL request carries the app's rules
//  block (~7,074 tokens on its own), the identity layer, the retrieved
//  evidence and the chat history — and the difference is not small:
//  gemini-3.6-flash measured 0.7-0.8s on the bench and 4.8s in the app.
//
//  A depth model calibrated on the bench under-predicts the silence and
//  suppresses the cover exactly where it is needed. So this measures the
//  gap through the real route, with covers DISABLED, by asking the
//  server for a plain stream and timing the first token.
//
//  Usage: node scripts/audit-gap-inapp.mjs [--runs 3]
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WS = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
const RUNS = Number((argv[argv.indexOf('--runs') + 1]) || 3);

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const main = list.find((t) => t.type === 'page' && t.url.includes('localhost:3005') && !t.url.includes('popout'));
if (!main) { console.error('app not on :9222'); process.exit(1); }
const ws = new WS(main.webSocketDebuggerUrl, { maxPayload: 2 ** 28 });
await new Promise((r) => ws.on('open', r));
let id = 0; const P = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); } });
const ev = (e) => new Promise((res) => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true } })); })
  .then((r) => r.result?.result?.value);
const tok = await ev(`localStorage.getItem('minicaai_token')`);
ws.close();

await fetch('http://127.0.0.1:4000/api/v1/usage/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
  body: JSON.stringify({ device_id: 'gap-probe' }),
});

// A realistic composed prompt: the marker the routes split on, plus
// enough bulk to stand in for the rules block the client prepends.
const RULES = ('RESPONSE RULES: speak in first person, no markdown headers, '
  + 'never invent an employer, anchor every claim in the knowledge base. ').repeat(110);
const compose = (q) => `${RULES}\n<<<END RESPONSE RULES>>>\n\n---\n\nInterviewer (Current Audio): ${q}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.`;

const QUESTIONS = [
  ['shallow', 'Walk me through your background and what you have spent most of your time on.'],
  ['deep', 'How would you design exactly-once delivery from an event stream into a warehouse when the sink is not idempotent and you cannot change it?'],
];

// coverContext is deliberately omitted AND we use the plain composed
// prompt, so what we time is the MAIN model alone. `nocover` tells the
// route to skip the cover for this measurement only.
async function timeRoute(route, body) {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:4000/api/v1/ai${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok, 'x-cover-disabled': '1' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { err: `${res.status} ${(await res.text()).slice(0, 120)}` };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const m = /data: (\{.*?\})\n/.exec(buf);
    if (m) {
      try {
        const j = JSON.parse(m[1]);
        if (j.t) { reader.cancel(); return { ms: Date.now() - t0, first: j.t.slice(0, 24) }; }
        if (j.error) { reader.cancel(); return { err: j.error.slice(0, 120) }; }
      } catch {}
      buf = buf.slice(m.index + m[0].length);
    }
  }
  return { err: 'stream ended with no token' };
}

const ROUTES = [
  ['gemini', (q) => ['/stream/gemini', { prompt: compose(q), systemInstruction: 'You are the candidate in a live interview.' }]],
  ['openai', (q) => ['/stream/openai', { messages: [{ role: 'system', content: 'You are the candidate in a live interview.' }, { role: 'user', content: compose(q) }], reasoning_effort: 'auto' }]],
  ['xai', (q) => ['/stream/xai', { messages: [{ role: 'system', content: 'You are the candidate in a live interview.' }, { role: 'user', content: compose(q) }] }]],
  ['groq', (q) => ['/stream/groq', { messages: [{ role: 'system', content: 'You are the candidate in a live interview.' }, { role: 'user', content: compose(q) }] }]],
];

for (const [name, mk] of ROUTES) {
  for (const [depth, q] of QUESTIONS) {
    const samples = [];
    for (let i = 0; i < RUNS; i++) {
      const [route, body] = mk(q);
      const r = await timeRoute(route, body);
      samples.push(r.err ? `ERR(${r.err})` : r.ms);
      await sleep(1500);
    }
    const nums = samples.filter((s) => typeof s === 'number');
    const summary = nums.length
      ? `min=${Math.min(...nums)} max=${Math.max(...nums)} med=${nums.sort((a, b) => a - b)[Math.floor(nums.length / 2)]}`
      : String(samples[0]);
    console.log(`${name.padEnd(8)} ${depth.padEnd(8)} ${summary}   [${samples.join(', ')}]`);
  }
}
