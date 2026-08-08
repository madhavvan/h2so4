// Server says the cover was produced in ~600ms; the app painted it at
// ~12s. Split the difference: time the first SSE byte from a RAW HTTP
// client, with the cover ON. Raw fast + app slow ⇒ the renderer is
// holding it. Raw slow too ⇒ the bytes never left the server.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WS = require('ws');

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const main = list.find((t) => t.type === 'page' && t.url.includes('localhost:3005') && !t.url.includes('popout'));
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
  body: JSON.stringify({ device_id: 'sse-probe' }),
});

const RULES = ('RESPONSE RULES: speak in first person, no markdown headers, '
  + 'never invent an employer, anchor every claim in the knowledge base. ').repeat(110);
const Q = 'Walk me through your background and what you have spent most of your time on.';
const composed = `${RULES}\n<<<END RESPONSE RULES>>>\n\n---\n\nInterviewer (Current Audio): ${Q}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.`;

const t0 = Date.now();
const res = await fetch('http://127.0.0.1:4000/api/v1/ai/stream/xai', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
  body: JSON.stringify({
    messages: [
      { role: 'system', content: 'You are the candidate in a live interview.' },
      { role: 'user', content: composed },
    ],
    coverContext: 'PROFESSIONAL SUMMARY\nSenior Data Engineer.\nFidelity Investments — Kafka to Snowflake CDC, Airflow, dbt.\nOptum — Spark claims processing.',
  }),
});
console.log('status', res.status, 'content-encoding:', res.headers.get('content-encoding'), 'transfer:', res.headers.get('transfer-encoding'));

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let firstByte = null;
let firstToken = null;
let n = 0;
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  if (firstByte === null) { firstByte = Date.now() - t0; console.log(`first BYTE at ${firstByte}ms`); }
  buf += dec.decode(value, { stream: true });
  let m;
  while ((m = /data: (\{.*?\})\n/.exec(buf))) {
    try {
      const j = JSON.parse(m[1]);
      if (j.t) {
        n++;
        if (firstToken === null) { firstToken = Date.now() - t0; console.log(`first TOKEN at ${firstToken}ms: ${JSON.stringify(j.t.slice(0, 40))}`); }
        if (n === 20) console.log(`20th token at ${Date.now() - t0}ms`);
      }
    } catch {}
    buf = buf.slice(m.index + m[0].length);
  }
  if (Date.now() - t0 > 40000) { reader.cancel(); break; }
}
console.log(`done at ${Date.now() - t0}ms, ${n} tokens`);
