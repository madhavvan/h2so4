// Is the Groq cover ACCURATE when gpt-5.6 is the chosen answer model?
//
// Three separate questions, and they fail independently:
//   GROUNDED   does it state anything the resume does not contain?
//   SHAPE      does it open THIS question? COVER_SYSTEM forbids opening a
//              problem question with employment history, and forbids
//              narrating process ("first I'd look at...").
//   SEAM       does gpt-5.6's continuation repeat or contradict it? The
//              cover is handed to the main model as text to continue from,
//              so a restatement is a measurable failure, not a matter of taste.
//
// The cover is streamed into the SAME bubble as the answer, arriving as one
// piece at 0ms — so the text at first paint IS the cover, and everything
// after it is gpt-5.6. That is what makes the seam observable at all.
//
// ⚠️ Waits for a NEW bubble rather than for the text to change. Comparing
// against a snapshot taken before typing reads the PREVIOUS answer as this
// question's opener whenever the last one was still streaming — which is
// how live-drive.mjs reported an identical "first words" for two different
// questions.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const WS = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETTLE_MS = Number(process.env.SETTLE_MS || 2000);
const READ_MS = Number(process.env.READ_MS || 2500);

// Two of each kind, because the failure modes are kind-specific.
const QUESTIONS = [
  ['identity', 'Which companies have you worked for, and in what order?'],
  ['identity', 'What is the largest data volume you have personally owned?'],
  ['problem', 'You inherit a 400-DAG Airflow instance with no documentation and a 30 percent failure rate. What is your plan for the first week?'],
  ['problem', 'A stakeholder says their dashboard numbers are wrong but every pipeline is green. What do you do?'],
  ['knowledge', 'What is the difference between a star schema and a snowflake schema?'],
  ['knowledge', 'What does backpressure mean in a streaming system?'],
];

async function attach(url) {
  const ws = new WS(url, { maxPayload: 2 ** 28 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0; const pending = new Map();
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
console.log(`answer model: ${model}\n`);

const rows = [];
for (const [kind, q] of QUESTIONS) {
  const r = await app.evaluate(`(async () => {
    const BUBBLES = () => [...document.querySelectorAll('div')].filter(
      d => typeof d.className === 'string' && /prose|markdown/.test(d.className));
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    const n0 = BUBBLES().length;
    setter.call(ta, ${JSON.stringify(q)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, ${SETTLE_MS}));

    const t0 = Date.now();
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));

    // A NEW bubble is the only reliable signal that THIS answer started.
    let cover = '', firstMs = 0, last = '', stable = 0, doneMs = 0;
    for (let k = 0; k < 1200; k++) {
      await new Promise(r => setTimeout(r, 100));
      const b = BUBBLES();
      if (b.length <= n0 + 1) continue;          // question bubble only, or nothing yet
      const t = (b[b.length - 1].innerText || '').trim();
      if (!t) continue;
      if (!cover) { cover = t; firstMs = Date.now() - t0; }
      stable = (t === last) ? stable + 1 : 0;
      if (stable >= 30 && t.length > cover.length + 80) { doneMs = Date.now() - t0; break; }
      last = t;
    }
    return { cover, firstMs, full: last, doneMs };
  })()`);

  const cover = (r.cover || '').replace(/\s+/g, ' ').trim();
  const full = (r.full || '').replace(/\s+/g, ' ').trim();
  const continuation = full.startsWith(cover) ? full.slice(cover.length).trim() : full;
  rows.push({ kind, q, cover, continuation, firstMs: r.firstMs, doneMs: r.doneMs });
  console.log(`\n[${kind}] ${q}`);
  console.log(`   first paint ${r.firstMs}ms  |  settled ${(r.doneMs / 1000).toFixed(1)}s`);
  console.log(`   COVER (${cover.split(/\s+/).length}w): ${cover.slice(0, 300)}`);
  console.log(`   GPT CONTINUES: ${continuation.slice(0, 240)}`);
  await sleep(READ_MS);
}

// ── Grounding check against the resume actually loaded ──
const RESUME = process.env.RESUME_FILE
  || path.join(process.env.USERPROFILE || '', 'Downloads', 'VMADp_DataEngineer.pdf');
let resumeText = '';
try {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(RESUME)), useSystemFonts: true }).promise;
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    resumeText += ' ' + c.items.map((it) => it.str).join(' ');
  }
} catch (e) { console.log('\n(could not read the resume for the grounding check: ' + e.message + ')'); }
const flat = resumeText.replace(/\s+/g, ' ').toLowerCase();

// ⚠️ Use the SHIPPED detector, never a regex written here.
//
// The local one required "first thing/step" and the real text was
// "First, I'd inventory..." — a comma, not "thing" — so it slipped
// through and this script printed `shape: ok` six times on a set where
// two were plainly wrong. A checker that can quietly disagree with the
// code it is checking will eventually be believed over it.
const { opensWithProcessNarration } = require('../src/services/groundingGuard.js');

console.log('\n═══════════ ACCURACY ═══════════');
for (const r of rows) {
  // Drop the word that OPENS a sentence — it is capitalised by grammar,
  // not by meaning. Without this the checker reported "First" as an
  // off-resume name, which is noise sitting on top of the real signal.
  const body = r.cover.replace(/(^|[.!?]\s+)[A-Z][a-z]+/g, '$1');
  const names = [...new Set((body.match(/\b[A-Z][A-Za-z0-9&.+#'-]{2,}/g) || []))];
  const unknown = flat ? names.filter((n) => !flat.includes(n.toLowerCase().replace(/[.,]$/, ''))) : [];
  const recitesEmployer = r.kind !== 'identity'
    && /\b(at|with)\s+[A-Z]/.test(r.cover.slice(0, 90))
    && names.some((n) => flat.includes(n.toLowerCase()));
  const narrates = opensWithProcessNarration(r.cover);
  const repeats = r.continuation && r.cover
    && r.continuation.toLowerCase().slice(0, 160).includes(r.cover.toLowerCase().split(/[.!?]/)[0].slice(0, 40));
  console.log(`\n  [${r.kind}] ${r.q.slice(0, 62)}`);
  console.log(`     grounded : ${unknown.length ? 'OFF-RESUME -> ' + unknown.join(', ') : 'ok'}`);
  console.log(`     shape    : ${recitesEmployer ? 'RECITES EMPLOYER on a non-identity question' : narrates ? 'NARRATES PROCESS -> \"' + narrates + '\"' : 'ok'}`);
  console.log(`     seam     : ${repeats ? 'GPT RESTATES the cover' : 'ok'}`);
}
app.close();
process.exit(0);
