// Gemini answers a shallow question in 0.73s when called on the raw
// route and 5.6-9.5s through the app. Somewhere between "the user hit
// send" and "the server saw a request" there is multi-second client
// work, or there is not and the raw probe was measuring the wrong shape.
// CDP Network events settle it: send → requestWillBeSent →
// responseReceived → first data.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WS = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const main = list.find((t) => t.type === 'page' && t.url.includes('localhost:3005') && !t.url.includes('popout'));
const ws = new WS(main.webSocketDebuggerUrl, { maxPayload: 2 ** 28 });
await new Promise((r) => ws.on('open', r));
let id = 0; const P = new Map();
const events = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); return; }
  if (m.method && /^Network\./.test(m.method)) events.push({ at: Date.now(), method: m.method, p: m.params });
});
const call = (method, params = {}) => new Promise((res) => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = (e) => call('Runtime.evaluate', { expression: e, returnByValue: true }).then((r) => r.result?.result?.value);

await call('Network.enable', {});
const model = await ev(`localStorage.getItem('SELECTED_MODEL')`);
console.log('model =', model);

const Q = 'Walk me through your background and what you have spent most of your time on.';
for (let run = 1; run <= 2; run++) {
  events.length = 0;
  const t0 = Date.now();
  await ev(`(() => { window.__dev_executeSend(${JSON.stringify(Q)}); return 1; })()`);
  await sleep(20000);

  const stream = events.filter((e) => (e.p?.request?.url || e.p?.response?.url || '').includes('/ai/stream/'));
  const sent = stream.find((e) => e.method === 'Network.requestWillBeSent');
  const recv = stream.find((e) => e.method === 'Network.responseReceived');
  const data = stream.find((e) => e.method === 'Network.dataReceived');
  const finished = stream.find((e) => e.method === 'Network.loadingFinished');
  const rel = (e) => (e ? `${e.at - t0}ms` : '—');
  console.log(`run ${run}: url=${sent?.p?.request?.url?.split('/ai')[1] || '?'}`);
  console.log(`   send→requestWillBeSent  ${rel(sent)}   ← client prep (prompt build, evidence, cover context, offload)`);
  console.log(`   →responseReceived       ${rel(recv)}`);
  console.log(`   →first dataReceived     ${rel(data)}   ← first bytes on the wire`);
  console.log(`   →loadingFinished        ${rel(finished)}`);
  // Any other requests fired in the same window (offload uploads, etc.)
  const others = events.filter((e) => e.method === 'Network.requestWillBeSent' && !(e.p?.request?.url || '').includes('/ai/stream/'))
    .map((e) => `${e.at - t0}ms ${(e.p.request.url || '').replace(/^https?:\/\/[^/]+/, '')}`);
  if (others.length) console.log('   other requests:', others.join(' | '));
  await sleep(4000);
}
ws.close();
