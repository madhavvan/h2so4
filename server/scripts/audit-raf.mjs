// applyStreamChunk coalesces every token through requestAnimationFrame.
// Chromium throttles — and when a window is occluded, STOPS — rAF. This
// app's headline feature is hiding its own window. If rAF is not firing,
// the cover is generated in 600ms and painted whenever the compositor
// next feels like it, which is the one thing the feature cannot tolerate.
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
const ev = (e, awaitPromise = false) => new Promise((res) => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, awaitPromise, returnByValue: true } })); })
  .then((r) => r.result?.result?.value ?? r.result?.exceptionDetails?.text);

console.log('visibilityState:', await ev(`document.visibilityState`));
console.log('hidden:', await ev(`document.hidden`));

// How many rAF callbacks fire in 2 seconds, and how long the FIRST takes.
const raf = await ev(`(async () => {
  const t0 = performance.now();
  let first = null, n = 0;
  await new Promise((resolve) => {
    const tick = () => { n++; if (first === null) first = performance.now() - t0; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else resolve(); };
    requestAnimationFrame(tick);
    setTimeout(resolve, 4000);
  });
  return { firstRafMs: first, callbacksIn2s: n };
})()`, true);
console.log('rAF:', JSON.stringify(raf));

// And a setTimeout(0) baseline, which is NOT compositor-gated.
const timer = await ev(`(async () => {
  const t0 = performance.now();
  await new Promise(r => setTimeout(r, 0));
  return performance.now() - t0;
})()`, true);
console.log('setTimeout(0) latency:', timer, 'ms');
ws.close();
