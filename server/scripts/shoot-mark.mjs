// Close-up of the brand mark through one full "given" cycle: question →
// first drop (the line you're given) → second drop (your own voice).
// Clipped to the mark's own box so the sequence can actually be judged.
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

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));
const child = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9343',
  `--user-data-dir=${path.join(OUT, 'profile-mark')}`, '--no-first-run',
  '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=2',
  'about:blank'], { detached: true, stdio: 'ignore' });
child.unref();
await sleep(3500);

const list = await (await fetch('http://127.0.0.1:9343/json/list')).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 5e8 });
await new Promise(r => ws.on('open', r));
let id = 0; const P = new Map();
ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); } });
const cmd = (m, p = {}) => new Promise(res => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = e => cmd('Runtime.evaluate', { expression: e, returnByValue: true })
  .then(r => { if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description).slice(0, 200)); return r.result?.result?.value; });

await cmd('Runtime.enable'); await cmd('Page.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await cmd('Page.navigate', { url: 'http://localhost:3005/' });

for (let i = 0; i < 60; i++) { await sleep(500); if (await ev(`!!document.querySelector('.pl-markbeat')`).catch(() => 0)) break; }
if (!await ev(`!!document.querySelector('.pl-markbeat')`)) { console.error('mark beat not found'); process.exit(1); }

await ev(`document.querySelector('.pl-markbeat').scrollIntoView({block:'center'});1`);
await sleep(1500);

const box = JSON.parse(await ev(`(function(){
  var e = document.querySelector('.pl-markbeat svg');
  var b = e.getBoundingClientRect();
  return JSON.stringify({x:b.x,y:b.y,w:b.width,h:b.height});
})()`));
console.log(`mark box: ${Math.round(box.w)}×${Math.round(box.h)} at (${Math.round(box.x)}, ${Math.round(box.y)})`);
const pad = 46;
const clip = { x: box.x - pad, y: box.y - pad, width: box.w + pad * 2, height: box.h + pad * 2, scale: 2 };

// 14 frames over ~7s covers the full 6.4s loop with margin.
for (let i = 0; i < 14; i++) {
  const r = await cmd('Page.captureScreenshot', { format: 'png', clip });
  if (r.result?.data) fs.writeFileSync(path.join(OUT, `mark-${String(i).padStart(2, '0')}.png`), Buffer.from(r.result.data, 'base64'));
  const st = JSON.parse(await ev(`(function(){
    var s = document.querySelector('.pl-markbeat svg');
    var g = function(sel){ var e = s.querySelector(sel); return e ? Number(getComputedStyle(e).opacity).toFixed(2) : 'n/a'; };
    return JSON.stringify({ q: g('.mm-q'), dot: g('.mm-q-dot'), lead: g('.mm-lead-g .mm-fill'), echo: g('.mm-echo-g .mm-fill') });
  })()`));
  console.log(`  frame ${String(i).padStart(2)}  question=${st.q} dot=${st.dot}  drop1=${st.lead}  drop2=${st.echo}`);
  await sleep(500);
}
console.log(`\nframes → ${OUT}\\mark-*.png`);

ws.close();
try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue | Stop-Process -Force`]); } catch (_) {}
process.exit(0);
