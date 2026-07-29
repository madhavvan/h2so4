// The caption reached "This is the seam" but no seam rendered between the
// plates. Read the live computed styles rather than guessing from a frame.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const OUT = path.join(process.env.TEMP || os.tmpdir(), 'claude', 'seamdom');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9347;
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const child = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(OUT, 'p')}`, '--no-first-run', '--hide-scrollbars', 'about:blank'],
  { detached: true, stdio: 'ignore' });
child.unref();
await sleep(3500);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 2 ** 28 });
await new Promise(r => ws.on('open', r));
let id = 0; const P = new Map();
ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); } });
const cmd = (m, p = {}) => new Promise(res => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = e => cmd('Runtime.evaluate', { expression: e, returnByValue: true }).then(r => r.result?.result?.value);

await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: 'http://localhost:3005/' });
for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('#seam .pl-seam')`)) break; await sleep(500); }
await ev(`document.querySelector('#seam').scrollIntoView({block:'start'}); 1`);
await sleep(800);

const probe = `(function(){
  var st = document.querySelector('#seam .pl-seam');
  var j = st.querySelector('.pl-seam-joint');
  var lab = st.querySelector('.pl-seam-jointlabel');
  var hair = st.querySelector('.pl-seam-hair');
  var spark = st.querySelector('.pl-seam-spark');
  var cs = getComputedStyle(j), ls = getComputedStyle(lab), hs = getComputedStyle(hair), ss = getComputedStyle(spark);
  var jb = j.getBoundingClientRect(), lb = lab.getBoundingClientRect(), hb = hair.getBoundingClientRect();
  return JSON.stringify({
    beat: st.getAttribute('data-beat'),
    joint: {op: cs.opacity, h: Math.round(jb.height), w: Math.round(jb.width), disp: cs.display},
    label: {op: ls.opacity, w: Math.round(lb.width), h: Math.round(lb.height), color: ls.color, fill: ls.webkitTextFillColor, bg: ls.backgroundColor},
    hair: {w: Math.round(hb.width), h: Math.round(hb.height), bg: hs.backgroundImage.slice(0,60)},
    spark: {op: ss.opacity, top: ss.top, anim: ss.animationName}
  });
})()`;

for (let i = 0; i < 16; i++) {
  console.log(await ev(probe));
  await sleep(900);
}
ws.close();
try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue | Stop-Process -Force`]); } catch (_) {}
process.exit(0);
