// Upload each PROBLEM resume into the running app and ask the one question
// that used to expose the misparse, then print what the candidate would
// actually have said out loud.
//
// These four are the templates where the ledger read bullet text, field
// labels and section headings as employers. Nothing here is a fabrication
// check — every word was on the document — so the only way to see it is to
// look at the sentence the opener produces.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const WS = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DL = path.join(process.env.USERPROFILE || '', 'Downloads');
const RESUMES = (process.env.RESUMES || 'resumenvidi.pdf,resumevpentlam.pdf,rishi_resume.docx,VENU RESUME.pdf').split(',');
const QUESTION = process.env.QUESTION || 'Which companies have you worked for, and in what order?';

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
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  return { call, evaluate, close: () => ws.close() };
}

async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch { /* poll */ }
    await sleep(250);
  }
  throw new Error('timed out: ' + label);
}

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const main = list.find((t) => t.type === 'page' && t.url.includes('localhost:3005') && !t.url.includes('popout'));
if (!main) { console.error('desktop app not found on :9222'); process.exit(1); }
const app = await attach(main.webSocketDebuggerUrl);
console.log(`model: ${await app.evaluate(`localStorage.getItem('SELECTED_MODEL')`)}`);
console.log(`question: "${QUESTION}"\n`);

for (const file of RESUMES) {
  const full = path.join(DL, file.trim());
  if (!fs.existsSync(full)) { console.log(`  (missing: ${file})`); continue; }
  console.log(`\n─── ${file.trim()} ───`);

  // Fresh conversation, so the previous resume cannot colour this one.
  await app.evaluate(`(() => { try { window.__dev_newSession && window.__dev_newSession(); } catch (e) {} return 1; })()`);
  await sleep(2500);

  const opened = await app.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => /files|knowledge base/i.test(x.getAttribute('aria-label') || ''));
    if (!b) return 'no-files-button';
    b.click(); return 'opened';
  })()`);
  if (opened !== 'opened') { console.log(`   could not open Files panel: ${opened}`); continue; }
  await until(() => app.evaluate(`!!document.querySelector('input[type=file]')`), 10000, 'files panel');
  const doc = await app.call('DOM.getDocument');
  const found = await app.call('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
  await app.call('DOM.setFileInputFiles', { nodeId: found.result.nodeId, files: [full] });

  const base = path.basename(full).replace(/\.[a-z]+$/i, '').slice(0, 12);
  await until(() => app.evaluate(`document.body.innerText.includes(${JSON.stringify(base)})`), 45000, 'upload')
    .catch(() => console.log('   (upload not confirmed in the UI)'));
  await sleep(2500);
  await app.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => /close|done/i.test(x.getAttribute('aria-label') || '') || x.innerText.trim() === '×');
    if (b) b.click(); return 1;
  })()`);
  await sleep(1200);

  const r = await app.evaluate(`(async () => {
    const BUBBLES = () => [...document.querySelectorAll('div')].filter(
      d => typeof d.className === 'string' && /prose|markdown/.test(d.className));
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    const n0 = BUBBLES().length;
    setter.call(ta, ${JSON.stringify(QUESTION)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1800));
    const t0 = Date.now();
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    let spoken = '', firstMs = 0, last = '', stable = 0;
    for (let k = 0; k < 900; k++) {
      await new Promise(r => setTimeout(r, 100));
      const b = BUBBLES();
      if (b.length <= n0 + 1) continue;
      const t = (b[b.length - 1].innerText || '').trim();
      if (!t) continue;
      if (!spoken) { spoken = t; firstMs = Date.now() - t0; }
      stable = (t === last) ? stable + 1 : 0;
      if (stable >= 25 && t.length > spoken.length + 60) break;
      last = t;
    }
    return { spoken, firstMs, full: last };
  })()`);

  console.log(`   first paint ${r.firstMs}ms`);
  console.log(`   SPOKEN FIRST: "${(r.spoken || '(nothing)').replace(/\s+/g, ' ').slice(0, 200)}"`);
  await sleep(2500);
}

app.close();
process.exit(0);
