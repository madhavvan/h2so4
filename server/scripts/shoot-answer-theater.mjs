// Capture the Answer Theater through its cycle, so the section can be
// judged as motion rather than as one frozen frame.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const W = Number(process.argv[2] || 1440), H = Number(process.argv[3] || 900);
const TAG = W < 500 ? 'mobile' : 'desktop';
const OUT = path.join(os.tmpdir(), 'claude', 'C--Users-penta', '7586704a-eea2-4204-a133-acc0ee56f32b', 'scratchpad', 'landing');
fs.mkdirSync(OUT, { recursive: true });
const PORT = W < 500 ? 9339 : 9338;

const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const child = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(OUT, 'profile-at-' + TAG)}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'], { detached: true, stdio: 'ignore' });
child.unref();
await sleep(3500);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 512 * 1024 * 1024 });
await new Promise(r => ws.on('open', r));
let id = 0; const P = new Map(); const errs = [];
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error')
    errs.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200));
  if (m.method === 'Runtime.exceptionThrown')
    errs.push('EXC: ' + String(m.params?.exceptionDetails?.exception?.description || '').slice(0, 200));
});
const cmd = (m, p = {}) => new Promise(res => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = (e) => cmd('Runtime.evaluate', { expression: e, returnByValue: true })
  .then(r => { if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description).slice(0, 240)); return r.result?.result?.value; });

await cmd('Runtime.enable'); await cmd('Page.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 500 });
await cmd('Page.navigate', { url: 'http://localhost:3005/' });

for (let i = 0; i < 60; i++) {
  await sleep(500);
  if (await ev(`!!document.querySelector('.pl-at')`).catch(() => false)) break;
}
const present = await ev(`!!document.querySelector('.pl-at')`);
console.log(`.pl-at present: ${present}`);
if (!present) { console.log('stage not found — is the section rendered?'); process.exit(1); }

// Scroll the stage into view inside the real scroller.
await ev(`(function(){
  var el = document.querySelector('.pl-at');
  el.scrollIntoView({ block: 'center' });
  return 1;
})()`);
await sleep(1500);

const shots = [];
for (let i = 0; i < 10; i++) {
  const state = JSON.parse(await ev(`(function(){
    var el = document.querySelector('.pl-at');
    var b = el.getBoundingClientRect();
    return JSON.stringify({
      beat: el.getAttribute('data-beat'),
      q: (el.querySelector('.pl-at-qtext')||{}).innerText || '',
      cover: (el.querySelector('.pl-at-cover')||{}).textContent || '',
      rest: (el.querySelector('.pl-at-rest')||{}).textContent || '',
      code: (el.querySelector('.pl-at-src')||{}).textContent || '',
      cap: (el.querySelector('.pl-at-cap')||{}).innerText || '',
      top: Math.round(b.top), h: Math.round(b.height), w: Math.round(b.width)
    });
  })()`));
  const r = await cmd('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) {
    const f = path.join(OUT, `theater-${TAG}-${String(i).padStart(2, '0')}.png`);
    fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
    shots.push(f);
  }
  console.log(`  frame ${i}  beat=${state.beat}  q=${state.q.length}c cover=${state.cover.length}c rest=${state.rest.length}c code=${state.code.length}c  box=${state.w}×${state.h}`);
  if (i === 0) console.log(`     caption: ${state.cap.replace(/\s+/g, ' ').slice(0, 100)}`);
  await sleep(1800);
}

const audit = JSON.parse(await ev(`(function(){
  var el = document.querySelector('.pl-at');
  var b = el.getBoundingClientRect();
  return JSON.stringify({
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    stageWidth: Math.round(b.width), viewport: window.innerWidth,
    ariaHidden: el.getAttribute('aria-hidden'),
    srText: (document.querySelector('.pl-sr-only')||{}).textContent ? (document.querySelector('.pl-sr-only').textContent.length + ' chars') : 'MISSING',
    srVisible: (function(){ var s = document.querySelector('.pl-sr-only'); if(!s) return 'n/a'; var r = s.getBoundingClientRect(); return (r.width<=2 && r.height<=2) ? 'hidden ok' : 'VISIBLE ('+Math.round(r.width)+'x'+Math.round(r.height)+')'; })()
  });
})()`));
console.log('\nAUDIT'); Object.entries(audit).forEach(([k, v]) => console.log(`  ${k}: ${JSON.stringify(v)}`));
console.log(`console errors: ${errs.length}`); errs.slice(0, 5).forEach(e => console.log('   ' + e));
console.log(`\nframes → ${OUT}`);

ws.close();
try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue | Stop-Process -Force`]); } catch (_) {}
process.exit(0);
