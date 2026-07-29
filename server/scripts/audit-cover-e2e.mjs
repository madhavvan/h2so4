// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DOES THE DEPTH-ADAPTIVE COVER ACTUALLY WORK, IN THE REAL APP?
//
//  Drives the running desktop app over CDP: loads a real resume into the
//  real knowledge base, opens a real usage session, and for each
//  (model, question-depth) pair measures
//
//    • time to FIRST CHARACTER on screen   (is the silence gone?)
//    • words on screen at 1s / 2s / 4s / 8s
//    • the settled answer
//
//  Pair the output with the server log's [cover] lines, which report the
//  tier that fired, the predicted gap, the chain time, and the SECONDS OF
//  SPEECH bought — the only number that says whether the candidate runs
//  dry before the deep answer lands.
//
//  Usage:
//    node scripts/audit-cover-e2e.mjs --probe
//    node scripts/audit-cover-e2e.mjs --models openai,xai,gemini
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const WS = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i === -1 ? def : argv[i + 1]; };
const PROBE_ONLY = argv.includes('--probe');
const MODELS = String(arg('models', 'openai')).split(',').filter(Boolean);
const EFFORT = arg('effort', null);
const ONLY_DEPTH = arg('depth', null);
// How long the answer must be unchanged before we call it finished. Must
// clear the slowest measured first-token gap (grok-4.5 at 32s) or a
// holding-tier cover gets reported as the entire answer.
const SETTLE_AFTER_MS = Number(arg('settle', 35000));

// A resume with real employers, so grounding is observable rather than
// asserted. Falls back to a literal file if the docx is not present.
const RESUME_TEXT = `PROFESSIONAL SUMMARY
Senior Data Engineer with 4+ years building streaming and batch platforms in regulated industries.

WORK EXPERIENCE
Fidelity Investments — Data Engineer (2023-present)
Built a Kafka to Snowflake change-data-capture pipeline moving 40M events/day with exactly-once semantics.
Owned Airflow orchestration for 220 DAGs; cut nightly batch cost 38 percent by moving to spot instances.
Rebuilt the dbt model layer and took p99 dashboard latency from 820ms to 90ms.

Optum — Data Engineer (2021-2023)
Claims processing on Spark across a 41 billion row estate; led the Aurora migration.
Designed the reconciliation framework that caught silent row-loss between the lake and the warehouse.

EDUCATION
M.S. Health Informatics, Indiana University.

SKILLS
Kafka, Snowflake, Airflow, dbt, Spark, Python, SQL, AWS, Terraform.`;

const QUESTIONS = [
  { depth: 'shallow', q: 'Walk me through your background and what you have spent most of your time on.' },
  { depth: 'deep', q: 'How would you design exactly-once delivery from an event stream into a warehouse when the sink is not idempotent and you cannot change it?' },
];

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const main = list.find((t) => t.type === 'page' && t.url.includes('localhost:3005') && !t.url.includes('popout'));
if (!main) { console.error('desktop app not found on :9222'); process.exit(1); }
const ws = new WS(main.webSocketDebuggerUrl, { maxPayload: 2 ** 28 });
await new Promise((r) => ws.on('open', r));
let id = 0;
const P = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); } });
const call = (method, params = {}) => new Promise((res) => {
  const i = ++id; P.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expression, awaitPromise = false) => {
  const r = await call('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

const probe = async () => ev(`(() => ({
  token: !!localStorage.getItem('minicaai_token'),
  model: localStorage.getItem('SELECTED_MODEL'),
  effort: localStorage.getItem('REASONING_EFFORT'),
  processing: !!(window.__dev_isProcessing && window.__dev_isProcessing()),
  ctx: window.__dev_contextInfo ? window.__dev_contextInfo() : null,
}))()`);

console.log('app state:', JSON.stringify(await probe()));
if (PROBE_ONLY) { ws.close(); process.exit(0); }

const state = await probe();
if (!state?.token) { console.error('NOT SIGNED IN — cannot drive the answer path.'); ws.close(); process.exit(2); }

// ── Load the resume into the REAL knowledge base ──
// This is also the readiness test: prewarmRetrieval runs off the same
// state change, so by the time the first question goes out the index and
// the cover context must already be built.
if (!state.ctx || state.ctx.count === 0) {
  await ev(`(async () => {
    await window.__dev_addContextFile({
      id: 'audit-resume', name: 'VMADp_DataEngineer.docx', type: 'resume',
      content: ${JSON.stringify(RESUME_TEXT)},
    });
    return 1;
  })()`, true);
  await sleep(2500);
  console.log('knowledge base now:', JSON.stringify(await ev(`window.__dev_contextInfo()`)));
}
// Let the eager prewarm and the 900ms debounced prewarm both land.
await sleep(2000);

const tok = await ev(`localStorage.getItem('minicaai_token')`);
const startSession = () => fetch('http://127.0.0.1:4000/api/v1/usage/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
  body: JSON.stringify({ device_id: 'cover-audit' }),
}).then(r => r.text()).catch(e => String(e));
console.log('usage session:', (await startSession()).slice(0, 120));

// Read the last rendered ANSWER bubble. ⚠️ the user's own question is
// also a `prose` div and becomes the last one the instant it is sent —
// skip any candidate containing the question text.
const LAST = (q) => `(() => {
  const b = [...document.querySelectorAll('div')].filter(
    (d) => typeof d.className === 'string' && /prose|markdown/.test(d.className));
  const qn = ${JSON.stringify(q.slice(0, 40))};
  for (let i = b.length - 1; i >= 0; i--) {
    const t = b[i].innerText || '';
    if (t && !t.includes(qn)) return t;
  }
  return '';
})()`;

const words = (s) => (s || '').split(/\s+/).filter(Boolean).length;
const results = [];

for (const model of MODELS) {
  await ev(`(() => {
    localStorage.setItem('SELECTED_MODEL', ${JSON.stringify(model)});
    ${EFFORT ? `localStorage.setItem('REASONING_EFFORT', ${JSON.stringify(EFFORT)});` : ''}
    return 1;
  })()`);
  await call('Page.reload', {});
  await sleep(7000);
  await startSession();
  console.log(`\n══ model=${model} ${JSON.stringify(await probe())}`);

  for (const { depth, q } of QUESTIONS.filter(x => !ONLY_DEPTH || x.depth === ONLY_DEPTH)) {
    // ⚠️ The PREVIOUS answer is still on screen and is also a `prose`
    // div, so a naive "is there text yet?" reports ~75ms every time —
    // measuring the last answer, not this one. Snapshot it and only
    // count text that differs from it.
    const before = (await ev(LAST(q))) || '';
    const t0 = Date.now();
    await ev(`(() => { window.__dev_executeSend(${JSON.stringify(q)}); return 1; })()`);

    let firstChar = null;
    const at = {};
    let text = '';
    let settledFor = 0;
    let last = '';
    for (let i = 0; i < 900; i++) {
      const raw = await ev(LAST(q));
      const cur = (typeof raw === 'string' && raw !== before) ? raw : '';
      if (typeof cur === 'string') {
        if (cur.length && firstChar === null) firstChar = Date.now() - t0;
        if (cur) text = cur;
      }
      const el = Date.now() - t0;
      for (const mark of [1000, 2000, 4000, 8000, 15000]) {
        if (at[mark] === undefined && el >= mark) at[mark] = words(text);
      }
      settledFor = (text && text === last) ? settledFor + 1 : 0;
      last = text;
      // ⚠️ On a HOLDING-tier cover the screen is deliberately static for
      // many seconds — the whole point is that the cover lands early and
      // the deep answer follows much later. A short settle window here
      // stops the harness before the answer arrives and reports the
      // cover as the whole response. Wait out the longest gap measured
      // (grok at 32s) before believing the stream is finished.
      if (settledFor > 40 && el > SETTLE_AFTER_MS) break;   // 5s with no change
      if (el > 75000) break;
      await sleep(120);
    }
    const row = {
      model, depth, firstCharMs: firstChar,
      w1s: at[1000], w2s: at[2000], w4s: at[4000], w8s: at[8000], final: words(text),
    };
    results.push(row);
    console.log(`  ${depth.padEnd(8)} firstChar=${String(firstChar).padStart(5)}ms  words @1s=${at[1000]} @2s=${at[2000]} @4s=${at[4000]} @8s=${at[8000]} @15s=${at[15000]}  final=${row.final}`);
    console.log(`  ── full answer ──\n${text.replace(/\n{2,}/g, '\n')}\n  ────────────────`);
    await sleep(3000);
  }
}

console.log('\n─── RESULTS ───');
console.table(results);
fs.writeFileSync(path.join(process.cwd(), '.audit-cover-results.json'), JSON.stringify(results, null, 2));
ws.close();
