// What does the SCREEN actually do during an answer? Samples the live DOM
// every 200ms through one question and prints a timeline, so we can see
// whether text renders progressively (cover visible early) or pops in at
// the end (cover invisible → no perceived-speed benefit).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tgt = list.find(x => x.type === 'page' && x.url.includes('localhost:3005') && !x.url.includes('popout'));
const ws = new WebSocket(tgt.webSocketDebuggerUrl, { maxPayload: 128 * 1024 * 1024 });
await new Promise(r => ws.on('open', r));
let id = 0; const P = new Map();
ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); } });
const cmd = (m, p = {}) => new Promise(res => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = (e, ap = false) => cmd('Runtime.evaluate', { expression: e, awaitPromise: ap, returnByValue: true }).then(r => r.result?.result?.value);
await cmd('Runtime.enable'); await cmd('Page.bringToFront');

const SNAP = `(function(){
  var caret = document.querySelectorAll('.stream-caret').length;
  var thinking = /THINKING \\(/.test(document.body.innerText);
  var starts = document.querySelectorAll('.flex.justify-start').length;
  var md = document.querySelectorAll('.markdown-body').length;
  var lastAi = '';
  var b = Array.prototype.slice.call(document.querySelectorAll('.flex.justify-start'));
  for (var i=0;i<b.length;i++){ var m2=b[i].querySelector('.markdown-body'); if(m2&&m2.innerText.trim()) lastAi=m2.innerText.trim(); }
  return JSON.stringify({caret:caret, thinking:thinking, starts:starts, md:md, lastLen:lastAi.length});
})()`;

await ev(`window.__dev_newSession()`); await sleep(1300);
for (let i = 0; i < 200; i++) { if (!(await ev(`(window.__dev_isProcessing?window.__dev_isProcessing():false)`))) break; await sleep(200); }

const Q = 'How would you design a distributed rate limiter across multiple regions, end to end?';
console.log(`\nQ: "${Q}"\n`);
console.log('  t(ms)  caret  thinking  aiBubbles  mdBlocks  lastAnswerChars');
const t0 = Date.now();
await ev(`(window.__dev_executeSend(${JSON.stringify(Q)}),1)`);
let sawCaret = 0, firstText = 0;
for (let i = 0; i < 90; i++) {
  const s = JSON.parse(await ev(SNAP));
  const t = Date.now() - t0;
  if (s.caret > 0) sawCaret++;
  if (!firstText && s.lastLen > 0) firstText = t;
  if (i % 2 === 0 || s.caret > 0) {
    console.log(`  ${String(t).padStart(5)}  ${String(s.caret).padStart(5)}  ${String(s.thinking).padStart(8)}  ${String(s.starts).padStart(9)}  ${String(s.md).padStart(8)}  ${String(s.lastLen).padStart(15)}`);
  }
  if (!s.thinking && s.caret === 0 && s.lastLen > 300 && t > 3000) break;
  await sleep(200);
}
console.log(`\n  samples with a visible streaming caret: ${sawCaret}`);
console.log(`  first moment any answer text was on screen: ${firstText}ms`);
ws.close(); process.exit(0);
