// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PLAY THE RECRUITER. WATCH WHAT THE APP SAYS BACK.
//
//  Drives the REAL desktop app: uploads a real resume through the real
//  file input, starts a real usage session, sends real questions, and
//  reads what appears on screen.
//
//  Reports the FIRST WORDS separately from the settled answer. They come
//  from different models — the first words are the cover, spoken aloud
//  by the candidate before the main answer exists — and that split is
//  where the recent failures have lived.
//
//  Cost: ~6.5c per question on gpt-5.6, plus a fraction of a cent per
//  cover. Ten questions ≈ 65c.
//
//  Usage:  node --env-file=.env scripts/interview-drive.mjs
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const WS = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RESUME = process.env.RESUME_FILE
  || path.join(process.env.USERPROFILE || '', 'Downloads', 'VMADp_DataEngineer.docx');

// Ten questions a real hiring manager would ask a senior data engineer,
// escalating from screen to genuinely hard. The later ones are
// deliberately nasty: ambiguous, trade-off laden, and impossible to
// answer well by reciting a resume back.
const QUESTIONS = [
  'Thanks for joining. To start, walk me through your background and what you have spent most of your time on.',
  'What is the largest data volume you have personally been responsible for, and what broke first as it grew?',
  'You are ingesting from Kafka into Snowflake and downstream reports start showing duplicate rows right after a deploy. Walk me through how you would find the cause.',
  'A Spark job that used to run in 20 minutes now takes 3 hours. Nothing changed in the code. What do you look at, in order?',
  'How would you design exactly-once delivery from an event stream into a warehouse when the sink is not idempotent and you cannot change it?',
  'A stakeholder says the numbers in their dashboard are wrong. You check and the pipeline is green. How do you handle that, technically and with the stakeholder?',
  'Suppose we asked you to cut our Snowflake bill by 40 percent without degrading SLA. Where do you start, and what would you refuse to do?',
  'You inherit a 400-DAG Airflow instance with no documentation and a 30 percent failure rate. First week. What is your plan?',
  'Be honest. What is a technical decision you made that turned out to be wrong, and what did it cost?',
  'Last one, hypothetical. We need to backfill 3 years of history into a live table that is serving production reads, with no downtime and no duplicate rows. How?',
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
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  return { ws, call, evaluate, close: () => ws.close() };
}

async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch { /* keep polling */ }
    await sleep(250);
  }
  throw new Error('timed out: ' + label);
}

// The newest assistant bubble's text. Read from the rendered DOM, which
// is what the candidate is actually looking at.
const LAST_ANSWER = `(() => {
  const bubbles = [...document.querySelectorAll('div')].filter(d => {
    const c = d.className;
    return typeof c === 'string' && /prose|markdown/.test(c);
  });
  const el = bubbles[bubbles.length - 1];
  return el ? el.innerText : '';
})()`;

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const main = list.find((t) => t.type === 'page' && t.url.includes('localhost:3005') && !t.url.includes('popout'));
if (!main) { console.error('desktop app not found on :9222'); process.exit(1); }
const app = await attach(main.webSocketDebuggerUrl);

if (!fs.existsSync(RESUME)) { console.error('resume not found: ' + RESUME); process.exit(1); }
console.log('uploading: ' + path.basename(RESUME) + '  (' + (fs.statSync(RESUME).size / 1024).toFixed(0) + ' KB)');

// Fresh conversation so nothing earlier colours the answers.
await app.evaluate(`(() => { try { window.__dev_newSession && window.__dev_newSession(); } catch (e) {} return 1; })()`);
await sleep(2000);

// The file input lives inside the Files panel and only exists while that
// panel is open — so open it the way a person does, by clicking the
// button, rather than reaching past the UI.
const opened = await app.evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(
    (x) => /files|knowledge base/i.test(x.getAttribute('aria-label') || ''));
  if (!b) return 'no-files-button';
  b.click();
  return 'opened';
})()`);
if (opened !== 'opened') { console.error('could not open the Files panel: ' + opened); process.exit(1); }
await until(() => app.evaluate(`!!document.querySelector('input[type=file]')`), 10000, 'the Files panel');

const doc = await app.call('DOM.getDocument');
const found = await app.call('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
if (!found.result || !found.result.nodeId) { console.error('file input not found in the UI'); process.exit(1); }
await app.call('DOM.setFileInputFiles', { nodeId: found.result.nodeId, files: [RESUME] });

const base = path.basename(RESUME).replace(/\.[a-z]+$/i, '');
const uploaded = await until(
  () => app.evaluate(`document.body.innerText.includes(${JSON.stringify(base.slice(0, 14))})`),
  45000, 'the file to appear in the UI',
).catch(() => false);
console.log(uploaded ? 'file is in the knowledge base\n' : 'could not confirm the upload in the UI\n');
await sleep(3000);

// Close the panel so the composer is reachable again.
await app.evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(
    (x) => /close/i.test(x.getAttribute('aria-label') || '') || x.textContent.trim() === '×');
  if (b) b.click();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return 1;
})()`);
await sleep(1200);

// The session gate: models refuse to answer unless a usage session is
// running. Opened from HERE rather than from the renderer — the renderer
// is served from localhost:3005 and its fetch to the API was failing,
// and the session is per-USER anyway, so it makes no difference which
// client opens it. Same effect as the user turning the mic on.
const tokenFromApp = await app.evaluate(`localStorage.getItem('minicaai_token')`);
const started = await fetch('http://127.0.0.1:4000/api/v1/usage/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenFromApp },
  body: JSON.stringify({ device_id: 'interview-drive' }),
}).then((r) => r.json()).catch((e) => ({ error: e.message }));
console.log('session: ' + (started.session_id ? started.source + ', ' + started.remaining + 's' : JSON.stringify(started)) + '\n');

const results = [];
for (let i = 0; i < QUESTIONS.length; i++) {
  const q = QUESTIONS[i];
  const beforeText = await app.evaluate(LAST_ANSWER);
  const t0 = Date.now();
  await app.evaluate(`(() => { window.__dev_executeSend && window.__dev_executeSend(${JSON.stringify(q)}); return 1; })()`);

  let firstAt = null;
  let firstWords = '';
  const answer = await until(async () => {
    const s = await app.evaluate(LAST_ANSWER);
    // Skip the user's own bubble. It is also a prose div and becomes the
    // last one the moment the question is sent, so an earlier version of
    // this recorded the QUESTION as "what was spoken first" for all ten.
    if (s && s !== beforeText && !q.startsWith(s.slice(0, 40)) && s.slice(0, 40) !== q.slice(0, 40)) {
      if (firstAt === null) { firstAt = Date.now() - t0; firstWords = s.slice(0, 220); }
      if (s.length > 150) {
        await sleep(2200);
        const again = await app.evaluate(LAST_ANSWER);
        if (again === s) return s;           // stopped growing → settled
      }
    }
    return false;
  }, 150000, 'answer to Q' + (i + 1)).catch(() => null);

  const total = Date.now() - t0;
  results.push({ n: i + 1, q, firstAt, firstWords, answer, totalMs: total });

  console.log('\n' + '━'.repeat(76));
  console.log('Q' + (i + 1) + '. ' + q);
  console.log('─'.repeat(76));
  console.log('  spoken first (' + (firstAt === null ? '?' : firstAt + 'ms') + '): "'
    + (firstWords || '').split('\n')[0].slice(0, 160) + '"');
  console.log('  settled after ' + (total / 1000).toFixed(1) + 's:\n');
  console.log((answer || '(no answer)').split('\n').map((l) => '    ' + l).join('\n').slice(0, 2400));
  await sleep(1500);
}

const out = path.join(process.cwd(), '..', '.phone-shots', 'interview-run.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log('\n\n' + '═'.repeat(76));
console.log('full transcript: ' + out);
app.close();
process.exit(0);
