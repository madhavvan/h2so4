// Drive the RUNNING desktop app through a short interview, slowly enough
// that a person can watch it happen on screen.
//
// Unlike interview-drive.mjs this does NOT upload or reset the session — it
// uses whatever is already loaded, types into the real composer, waits for
// the prewarm to land, sends, and reports what the candidate actually saw:
// time to the FIRST PAINTED CHARACTER (the cover) and time to the settled
// answer.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WS = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How long to leave the typed question sitting before sending. The prewarm
// hook debounces 350ms and the cover takes 300-900ms, so this is the real
// equivalent of the 1,200ms auto-send window.
const SETTLE_MS = Number(process.env.SETTLE_MS || 1800);
// Pause between questions so the answer can actually be read.
const READ_MS = Number(process.env.READ_MS || 6000);

const QUESTIONS = [
  'To start, walk me through your background and what you have spent most of your time on.',
  'What is the largest data volume you have personally been responsible for, and what broke first as it grew?',
  'How would you design exactly-once delivery from Kafka into a warehouse when the sink is not idempotent and you cannot change it?',
  'A stakeholder says their dashboard numbers are wrong, but the pipeline is green. How do you handle that?',
  'You inherit a 400-DAG Airflow instance with no documentation and a 30 percent failure rate. First week, what is your plan?',
  'Be honest — what is a technical decision you made that turned out to be wrong, and what did it cost?',
];

async function attach(url) {
  const ws = new WS(url, { maxPayload: 2 ** 28 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const call = (method, params = {}) => new Promise((res) => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };
  return { evaluate, close: () => ws.close() };
}

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const main = list.find((t) => t.type === 'page' && t.url.includes('localhost:3005') && !t.url.includes('popout'));
if (!main) { console.error('desktop app not found on :9222'); process.exit(1); }
const app = await attach(main.webSocketDebuggerUrl);

const model = await app.evaluate(`localStorage.getItem('SELECTED_MODEL')`);
console.log(`model: ${model}   settle: ${SETTLE_MS}ms   read pause: ${READ_MS}ms\n`);

const rows = [];
for (let i = 0; i < QUESTIONS.length; i++) {
  const q = QUESTIONS[i];
  console.log(`\n[${i + 1}/${QUESTIONS.length}] ${q}`);

  const r = await app.evaluate(`(async () => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    const answerText = () => {
      const b = [...document.querySelectorAll('div')].filter(
        d => typeof d.className === 'string' && /prose|markdown/.test(d.className));
      const el = b[b.length - 1];
      return el ? el.innerText.trim() : '';
    };
    const before = answerText();
    // Type it the way a transcript lands, so the prewarm hook sees a real
    // input event rather than a value assignment React never hears about.
    setter.call(ta, ${JSON.stringify(q)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, ${SETTLE_MS}));

    const t0 = Date.now();
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));

    let firstPaint = 0, firstWords = '', last = '', stable = 0, done = 0;
    for (let k = 0; k < 900; k++) {
      await new Promise(r => setTimeout(r, 100));
      const t = answerText();
      if (!firstPaint && t && t !== before && t !== ${JSON.stringify(q)}) {
        firstPaint = Date.now() - t0;
        firstWords = t.slice(0, 130);
      }
      stable = (t === last) ? stable + 1 : 0;
      if (firstPaint && stable >= 35 && t.length > 250) { done = Date.now() - t0; break; }
      last = t;
    }
    return { firstPaint, firstWords, done, words: last ? last.split(/\\s+/).length : 0 };
  })()`);

  const line = `      first words at ${r.firstPaint}ms  |  full answer ${r.done ? (r.done / 1000).toFixed(1) + 's' : 'still going'}  |  ${r.words} words`;
  console.log(line);
  console.log(`      "${(r.firstWords || '').replace(/\s+/g, ' ')}…"`);
  rows.push({ q: q.slice(0, 46), ...r });
  await sleep(READ_MS);
}

console.log('\n═══════════ SUMMARY ═══════════');
for (const r of rows) {
  console.log(`  ${String(r.firstPaint + 'ms').padStart(7)} first  ${String((r.done / 1000).toFixed(1) + 's').padStart(7)} full  ${String(r.words).padStart(4)}w   ${r.q}`);
}
const paints = rows.map(r => r.firstPaint).filter(Boolean).sort((a, b) => a - b);
const fulls = rows.map(r => r.done).filter(Boolean).sort((a, b) => a - b);
console.log(`\n  median first paint: ${paints[Math.floor(paints.length / 2)]}ms`);
console.log(`  median full answer: ${(fulls[Math.floor(fulls.length / 2)] / 1000).toFixed(1)}s`);
app.close();
process.exit(0);
