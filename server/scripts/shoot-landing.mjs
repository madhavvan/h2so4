// Screenshot the PUBLIC landing page at desktop and phone widths, plus a
// few interaction states, so a verdict on it is based on what a visitor
// actually sees rather than on reading JSX.
//
// Signed-out is the default in a fresh headless profile (no token in
// localStorage), which is exactly the public view.
//
// NOTE: the hero globe is WebGL. Headless falls back to SwiftShader and a
// capture can land between frames, so a dark/!empty globe area in these
// PNGs is a capture artifact, not necessarily a page defect.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const OUT = path.join(os.tmpdir(), 'claude', 'C--Users-penta', '7586704a-eea2-4204-a133-acc0ee56f32b', 'scratchpad', 'landing');
fs.mkdirSync(OUT, { recursive: true });
const PROFILE = path.join(OUT, 'profile');
const PORT = 9333;
const URL = process.argv[2] || 'http://localhost:3005/';

const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
  .find(p => fs.existsSync(p));
if (!EDGE) { console.error('Edge not found'); process.exit(1); }

const child = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu-vsync',
  '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank',
], { detached: true, stdio: 'ignore' });
child.unref();
await sleep(3500);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 512 * 1024 * 1024 });
await new Promise(r => ws.on('open', r));
let id = 0; const P = new Map(); const errors = [];
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error')
    errors.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 180));
  if (m.method === 'Runtime.exceptionThrown')
    errors.push('EXC: ' + String(m.params?.exceptionDetails?.exception?.description || '').slice(0, 180));
});
const cmd = (method, params = {}) => new Promise(res => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = (e, ap = false) => cmd('Runtime.evaluate', { expression: e, awaitPromise: ap, returnByValue: true })
  .then(r => { if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description).slice(0, 200)); return r.result?.result?.value; });

await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Network.enable');

async function shoot(name, w, h, { full = false, settle = 4000 } = {}) {
  await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
  await cmd('Page.navigate', { url: URL });
  await sleep(settle);
  // Nudge lazy/scroll-reveal sections into their final state.
  await ev(`window.scrollTo(0, document.body.scrollHeight); 1`);
  await sleep(1200);
  await ev(`window.scrollTo(0, 0); 1`);
  await sleep(1200);
  let r = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
  if (!r.result?.data) r = await cmd('Page.captureScreenshot', { format: 'png' });
  if (!r.result?.data) { console.log(`   capture failed for ${name}: ${JSON.stringify(r.error || r).slice(0, 200)}`); return {}; }
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  const info = JSON.parse(await ev(`JSON.stringify({
    title: document.title,
    h: document.body.scrollHeight,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    imgs: document.images.length,
    brokenImgs: Array.prototype.filter.call(document.images, function(i){ return i.complete && i.naturalWidth === 0; }).length,
    h1: (document.querySelector('h1')||{}).innerText || null,
    ctas: Array.prototype.slice.call(document.querySelectorAll('button, a[role=button]')).length,
    priceText: (function(){ var m = document.body.innerText.match(/\\$\\d+(\\.\\d+)?/g); return m ? Array.from(new Set(m)).slice(0,12) : []; })(),
    tinyText: Array.prototype.filter.call(document.querySelectorAll('p,span,li,a,button'), function(e){
      var s = parseFloat(getComputedStyle(e).fontSize); return s > 0 && s < 12 && e.innerText && e.innerText.trim().length > 3;
    }).length
  })`));
  console.log(`\n── ${name} (${w}×${h}) ──`);
  console.log(`   ${file}`);
  console.log(`   title=${JSON.stringify(info.title)}  page height=${info.h}px`);
  console.log(`   h1=${JSON.stringify(info.h1)}`);
  console.log(`   horizontal overflow: ${info.overflowX ? `YES  (scrollW ${info.scrollW} > viewport ${info.innerW})` : 'no'}`);
  console.log(`   images=${info.imgs} broken=${info.brokenImgs}  interactive elements=${info.ctas}  sub-12px text nodes=${info.tinyText}`);
  console.log(`   prices on page: ${info.priceText.join(' ') || '(none found)'}`);
  return info;
}

await shoot('desktop-1440', 1440, 900, { full: true, settle: 5000 });
await shoot('mobile-390', 390, 844, { full: true, settle: 5000 });

console.log(`\n── console errors on the public landing: ${errors.length} ──`);
errors.slice(0, 8).forEach(e => console.log('   ' + e));

ws.close();
try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue | Stop-Process -Force`]); } catch (_) {}
process.exit(0);
