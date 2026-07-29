// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  IS THE COVER ACTUALLY ARRIVING, AND IS IT FAST?
//
//  The cover exists to kill dead air: the candidate starts SPEAKING
//  within a second while the reasoning model is still forming the real
//  answer. If it is not arriving — or arriving late — the feature is
//  doing nothing and the candidate sits silent, which is the exact
//  failure it was built to prevent.
//
//  Measures TIME TO FIRST CHARACTER on screen, then how much text exists
//  at 1s and 2s, and converts that to seconds of speaking (~2.3 words/s).
//
//  Usage:  node --env-file=.env scripts/cover-timing.mjs
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WS = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const main = list.find((t) => t.type === 'page' && t.url.includes('localhost:3005') && !t.url.includes('popout'));
if (!main) { console.error('desktop app not found on :9222'); process.exit(1); }
const ws = new WS(main.webSocketDebuggerUrl, { maxPayload: 2 ** 28 });
await new Promise((r) => ws.on('open', r));
let id = 0;
const P = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); } });
const ev = (e, ap = false) => new Promise((res) => {
  const i = ++id; P.set(i, res);
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, awaitPromise: ap, returnByValue: true } }));
}).then((r) => r.result?.result?.value);

const LAST = `(() => {
  const b = [...document.querySelectorAll('div')].filter(
    (d) => typeof d.className === 'string' && /prose|markdown/.test(d.className));
  const el = b[b.length - 1];
  return el ? el.innerText : '';
})()`;

const tok = await ev(`localStorage.getItem('minicaai_token')`);
await fetch('http://127.0.0.1:4000/api/v1/usage/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
  body: JSON.stringify({ device_id: 'cover-timing' }),
});

const QUESTIONS = [
  'A Spark job that used to run in 20 minutes now takes 3 hours. Nothing changed in the code. What do you look at, in order?',
  'Walk me through your background and what you have spent most of your time on.',
  'How would you design exactly-once delivery into a warehouse whose sink cannot deduplicate?',
];

for (const Q of QUESTIONS) {
  const before = await ev(LAST);
  const t0 = Date.now();
  await ev(`(() => { window.__dev_executeSend && window.__dev_executeSend(${JSON.stringify(Q)}); return 1; })()`);

  let firstChar = null;
  const snaps = [];
  for (let i = 0; i < 1200; i++) {
    const s = await ev(LAST);
    const isAnswer = s && s !== before && s.slice(0, 40) !== Q.slice(0, 40);
    if (isAnswer) {
      const t = Date.now() - t0;
      if (firstChar === null) firstChar = t;
      snaps.push({ t, text: s });
      const n = snaps.length;
      if (n > 4 && t > 5000 && s === snaps[n - 3].text && s === snaps[n - 5].text) break;
    }
    await sleep(35);
  }

  const at = (ms) => snaps.find((s) => s.t >= ms);
  const words = (s) => (s || '').trim().split(/\s+/).filter(Boolean).length;
  const last = snaps[snaps.length - 1];

  console.log('\n' + '━'.repeat(74));
  console.log('Q: ' + Q.slice(0, 70));
  console.log('─'.repeat(74));
  console.log('  first character on screen : ' + (firstChar === null ? 'NEVER' : firstChar + 'ms'));
  for (const ms of [800, 1500, 2500]) {
    const s = at(ms);
    if (s) {
      console.log('  at ' + (ms / 1000).toFixed(1) + 's : ' + words(s.text) + ' words  ≈ '
        + (words(s.text) / 2.3).toFixed(1) + 's of speaking');
    }
  }
  console.log('  settled : ' + (last ? last.t + 'ms, ' + words(last.text) + ' words' : 'never'));
  const early = at(1500);
  if (early) console.log('\n  what they can already be saying at 1.5s:\n    "' + early.text.slice(0, 190) + '"');
  await sleep(1500);
}

ws.close();
process.exit(0);
