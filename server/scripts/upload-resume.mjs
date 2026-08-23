// Fresh conversation + upload ONE resume into the running desktop app,
// then stop. The questions are left to the person testing.
//
// Extracted from interview-drive.mjs, which does the same setup before
// running its own ten-question script. Same CDP calls, same UI route: the
// Files panel is opened by clicking the button and the file goes through
// the real <input type=file>, so the app's own upload/extract/ledger path
// runs exactly as it does for a user.
//
//   RESUME_FILE=C:\...\VMADp_DataEngineer.pdf node scripts/upload-resume.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const WS = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RESUME = process.env.RESUME_FILE
  || path.join(process.env.USERPROFILE || '', 'Downloads', 'VMADp_DataEngineer.pdf');

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
    const r = await call('Runtime.evaluate', { expression, returnByValue: true });
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

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const main = list.find((t) => t.type === 'page' && t.url.includes('localhost:3005') && !t.url.includes('popout'));
if (!main) { console.error('desktop app not found on :9222'); process.exit(1); }
const app = await attach(main.webSocketDebuggerUrl);

if (!fs.existsSync(RESUME)) { console.error('resume not found: ' + RESUME); process.exit(1); }
console.log('uploading: ' + path.basename(RESUME) + '  (' + (fs.statSync(RESUME).size / 1024).toFixed(0) + ' KB)');

await app.evaluate(`(() => { try { window.__dev_newSession && window.__dev_newSession(); } catch (e) {} return 1; })()`);
await sleep(2000);

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
if (!found.result || !found.result.nodeId) { console.error('file input not found'); process.exit(1); }
await app.call('DOM.setFileInputFiles', { nodeId: found.result.nodeId, files: [RESUME] });

const base = path.basename(RESUME).replace(/\.[a-z]+$/i, '');
const ok = await until(
  () => app.evaluate(`document.body.innerText.includes(${JSON.stringify(base.slice(0, 14))})`),
  45000, 'the file to appear in the UI',
).catch(() => false);
console.log(ok ? 'file is in the knowledge base' : 'could not confirm the upload in the UI');
await sleep(3000);

// Close the panel so the composer is reachable again.
await app.evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(
    (x) => /close|done/i.test(x.getAttribute('aria-label') || '') || x.innerText.trim() === '×');
  if (b) b.click();
  return 1;
})()`);
await sleep(1000);
console.log('ready — the composer is yours.');
app.close();
process.exit(0);
