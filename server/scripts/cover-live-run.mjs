// One visible end-to-end run of the rebuilt cover engine, in the REAL app.
//
// Reloads the renderer (so the client-side changes land off the vite dev
// server), brings the window to the front, starts a fresh conversation,
// uploads one document through the real Files panel, then asks a set of
// questions through the real composer — typing, pausing for the prewarm,
// and pressing Enter exactly as the auto-send timer would.
//
// Reports what the candidate actually saw: time to the FIRST PAINTED
// CHARACTER and the settled answer. Pair it with the server log
// ([prewarm]/[cover] lines) to see which covers were spoken and which the
// two rules refused.
//
//   RESUME_FILE=C:\...\x.docx node scripts/cover-live-run.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const WS = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RESUME = process.env.RESUME_FILE
  || path.join(process.env.USERPROFILE || '', 'Downloads', 'rishi_resume.docx');
// The real auto-send window: the composer sits for ~1,200ms after the last
// transcript word before the question fires. That is all the prewarm gets.
const SETTLE_MS = Number(process.env.SETTLE_MS || 1200);
const READ_MS = Number(process.env.READ_MS || 5000);

const QUESTIONS = (process.env.QUESTIONS && JSON.parse(process.env.QUESTIONS)) || [
  'So to start, tell me about yourself and what you have been working on.',
  'Have you worked with Kubernetes in production?',
  'What is the difference between the AMF and the SMF in a 5G core?',
  'How many nodes were you responsible for day to day?',
  'A subscriber attaches successfully but cannot browse. Where do you start?',
  'Have you ever worked on an Ericsson core?',
  'Walk me through what happens during a VoLTE call setup.',
  'What monitoring tooling did you actually use yourself?',
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
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  return { call, evaluate, close: () => ws.close() };
}

async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch { /* keep polling */ }
    await sleep(250);
  }
  throw new Error('timed out: ' + label);
}

async function findPage() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  return list.find((t) => t.type === 'page' && t.url.includes('localhost:3005') && !t.url.includes('popout'));
}

let main = await findPage();
if (!main) { console.error('desktop app not found on :9222'); process.exit(1); }
let app = await attach(main.webSocketDebuggerUrl);

// ── 1. Reload, so the renderer picks up the client-side changes ──
console.log('reloading the renderer…');
await app.call('Page.enable');
await app.call('Page.reload', { ignoreCache: true });
app.close();
await sleep(2500);
main = await findPage();
app = await attach(main.webSocketDebuggerUrl);
await until(() => app.evaluate(`!!document.querySelector('textarea')`), 30000, 'the app to come back');

// ── 2. Bring the window to the front, the app's own way ──
//
// The window parks itself off-screen at (-21333,-21333) at 159x27 when
// hidden, and Page.bringToFront does nothing for that. `focus-main-window`
// is the app's own restore path (smoothShow in electron/main.cjs).
await app.evaluate(`(() => { try { window.electronAPI.send('focus-main-window'); } catch (e) {} return 1; })()`);
await sleep(1200);
const geom = await app.evaluate(`JSON.stringify({x: window.screenX, y: window.screenY, w: outerWidth, h: outerHeight})`);
console.log('window: ' + geom);

// ── 3. Fresh conversation, then the document ──
await app.evaluate(`(() => { try { window.__dev_newSession && window.__dev_newSession(); } catch (e) {} return 1; })()`);
await sleep(2000);

if (!fs.existsSync(RESUME)) { console.error('document not found: ' + RESUME); process.exit(1); }
console.log('uploading: ' + path.basename(RESUME) + '  (' + (fs.statSync(RESUME).size / 1024).toFixed(0) + ' KB)');

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
await app.call('DOM.setFileInputFiles', { nodeId: found.result.nodeId, files: [RESUME] });

const base = path.basename(RESUME).replace(/\.[a-z]+$/i, '');
const ok = await until(
  () => app.evaluate(`document.body.innerText.includes(${JSON.stringify(base.slice(0, 12))})`),
  45000, 'the file to appear in the UI',
).catch(() => false);
console.log(ok ? 'document is in the knowledge base' : 'could not confirm the upload in the UI');
await sleep(2500);
await app.evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(
    (x) => /close|done/i.test(x.getAttribute('aria-label') || '') || x.innerText.trim() === '×');
  if (b) b.click();
  return 1;
})()`);
await sleep(1500);

// ── 4. The questions ──
const model = await app.evaluate(`localStorage.getItem('SELECTED_MODEL')`);
console.log(`\nmodel: ${model}   settle: ${SETTLE_MS}ms (the real auto-send window)   read pause: ${READ_MS}ms`);

const rows = [];
for (let i = 0; i < QUESTIONS.length; i++) {
  const q = QUESTIONS[i];
  console.log(`\n[${i + 1}/${QUESTIONS.length}] ${q}`);
  // Keep the window in front — the app hides itself on some transitions.
  await app.evaluate(`(() => { try { window.electronAPI.send('focus-main-window'); } catch (e) {} return 1; })()`);

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
        firstWords = t.slice(0, 160);
      }
      stable = (t === last) ? stable + 1 : 0;
      if (firstPaint && stable >= 30 && t.length > 250) { done = Date.now() - t0; break; }
      last = t;
    }
    return { firstPaint, firstWords, done, words: last ? last.split(/\\s+/).length : 0, full: last.slice(0, 700) };
  })()`);

  console.log(`      first words at ${r.firstPaint}ms  |  full answer ${r.done ? (r.done / 1000).toFixed(1) + 's' : 'still going'}  |  ${r.words} words`);
  console.log(`      "${(r.firstWords || '').replace(/\s+/g, ' ')}…"`);
  rows.push({ q, ...r });
  await sleep(READ_MS);
}

console.log('\n═══════════ SUMMARY ═══════════');
for (const r of rows) {
  console.log(`  ${String(r.firstPaint + 'ms').padStart(7)} first  ${String((r.done / 1000).toFixed(1) + 's').padStart(7)} full  ${String(r.words).padStart(4)}w   ${r.q.slice(0, 52)}`);
}
const paints = rows.map(r => r.firstPaint).filter(Boolean).sort((a, b) => a - b);
if (paints.length) console.log(`\n  median first paint: ${paints[Math.floor(paints.length / 2)]}ms`);
fs.writeFileSync(process.env.OUT || 'cover-live-run.json', JSON.stringify(rows, null, 1));
app.close();
process.exit(0);
