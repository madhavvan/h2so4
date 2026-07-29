// The server logged a cover produced in 747ms; the screen showed nothing
// for 8.7 seconds. Everything between "the route emitted a token" and
// "the candidate can read it" lives on the client, so measure there:
// send the same question repeatedly WITHOUT reloading, and watch whether
// the first paint is slow every time or only on the first one after a
// reload (which would make it app warm-up, not the cover path).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WS = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const main = list.find((t) => t.type === 'page' && t.url.includes('localhost:3005') && !t.url.includes('popout'));
const ws = new WS(main.webSocketDebuggerUrl, { maxPayload: 2 ** 28 });
await new Promise((r) => ws.on('open', r));
let id = 0; const P = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); } });
const ev = (e) => new Promise((res) => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true } })); })
  .then((r) => r.result?.result?.value);

const Q = 'Walk me through your background and what you have spent most of your time on.';
const LAST = `(() => {
  const b = [...document.querySelectorAll('div')].filter(
    (d) => typeof d.className === 'string' && /prose|markdown/.test(d.className));
  const qn = ${JSON.stringify(Q.slice(0, 40))};
  for (let i = b.length - 1; i >= 0; i--) {
    const t = b[i].innerText || '';
    if (t && !t.includes(qn)) return t;
  }
  return '';
})()`;

console.log('model =', await ev(`localStorage.getItem('SELECTED_MODEL')`));

for (let run = 1; run <= 3; run++) {
  const before = (await ev(LAST)) || '';
  const t0 = Date.now();
  await ev(`(() => { window.__dev_executeSend(${JSON.stringify(Q)}); return 1; })()`);
  let first = null;
  let words = 0;
  for (let i = 0; i < 500; i++) {
    const cur = await ev(LAST);
    if (typeof cur === 'string' && cur && cur !== before) {
      if (first === null) first = Date.now() - t0;
      words = cur.split(/\s+/).filter(Boolean).length;
      if (Date.now() - t0 > (first + 12000)) break;
    }
    if (Date.now() - t0 > 60000) break;
    await sleep(80);
  }
  console.log(`run ${run}: firstPaint=${first}ms finalWords=${words}`);
  await sleep(4000);
}
ws.close();
