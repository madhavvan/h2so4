// The stage is a FIXED height so three scenes of different lengths do not
// make it grow and shrink under the reader. That only works if the fixed
// height actually fits the tallest one — at every width. This measures
// the real content bottom against the body box, for all three scenes, at
// whatever width you pass.
//
//   node scripts/probe-seam-fit.mjs 390 844
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const W = Number(process.argv[2] || 390);
const H = Number(process.argv[3] || 844);
const OUT = path.join(process.env.TEMP || os.tmpdir(), 'claude', 'seamfit' + W);
fs.mkdirSync(OUT, { recursive: true });
// Unique per width, so runs at different widths never fight over a port
// (and a stale headless Edge from a previous run cannot silently answer).
const PORT = 9400 + (W % 90);
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

await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 500 });
await cmd('Page.navigate', { url: 'http://localhost:3005/' });
for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('#seam .pl-seam')`)) break; await sleep(500); }
await ev(`document.querySelector('#seam').scrollIntoView({block:'start'}); 1`);
await sleep(700);

// Worst case is the settled frame of each scene. Watch until every scene
// has been seen at beat 3 and record its content bottom.
const probe = `(function(){
  var st = document.querySelector('#seam .pl-seam');
  var body = st.querySelector('.pl-seam-body');
  var full = st.querySelector('.pl-seam-meta');
  var pips = st.querySelectorAll('.pl-seam-pips b');
  var on = -1; pips.forEach(function(p,i){ if (p.getAttribute('data-on')==='1') on = i; });
  var bb = body.getBoundingClientRect(), fb = full.getBoundingClientRect();
  return JSON.stringify({
    beat: st.getAttribute('data-beat'), scene: on,
    bodyH: Math.round(bb.height),
    contentBottom: Math.round(fb.bottom - bb.top),
    slack: Math.round(bb.bottom - fb.bottom),
    fullChars: (st.querySelector('.pl-seam-f').textContent||'').length
  });
})()`;

const seen = {};
for (let i = 0; i < 220; i++) {
  const s = JSON.parse(await ev(probe));
  if (s.beat === '3' && s.fullChars > 200) {
    const prev = seen[s.scene];
    if (!prev || s.contentBottom > prev.contentBottom) seen[s.scene] = s;
  }
  if (Object.keys(seen).length === 3) break;
  await sleep(450);
}
console.log(`width ${W}`);
let worst = 0;
for (const k of Object.keys(seen).sort()) {
  const s = seen[k];
  worst = Math.max(worst, s.contentBottom);
  const verdict = s.slack < 0 ? '  ⚠ CLIPPED' : (s.slack < 8 ? '  ⚠ tight' : '');
  console.log(`  scene ${k}: bodyH=${s.bodyH} contentBottom=${s.contentBottom} slack=${s.slack}px${verdict}`);
}
console.log(`  tallest content = ${worst}px`);
ws.close();
try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue | Stop-Process -Force`]); } catch (_) {}
process.exit(0);
