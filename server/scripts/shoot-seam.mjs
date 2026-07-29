// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE SEAM SECTION — capture it through a full cycle
//
//  A self-playing stage cannot be judged from one screenshot: a single
//  frame always catches it mid-beat and looks broken. This scrolls the
//  seam section into view, then captures the STAGE ITSELF (clipped) at a
//  steady cadence across a whole rotation, and reports which beat and
//  which of the three questions was on screen for each frame.
//
//  Usage:  node scripts/shoot-seam.mjs [width] [height] [frames]
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const W = Number(process.argv[2] || 1440);
const H = Number(process.argv[3] || 900);
const FRAMES = Number(process.argv[4] || 14);
const TAG = W < 500 ? 'mobile' : 'desktop';
const OUT = path.join(process.env.TEMP || os.tmpdir(), 'claude', 'C--Users-penta',
  'f504e286-3aa7-4b86-9abc-6580186c227c', 'scratchpad', 'seam');
fs.mkdirSync(OUT, { recursive: true });
const PORT = W < 500 ? 9345 : 9344;

const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
if (!EDGE) { console.error('Edge not found'); process.exit(1); }
const child = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(OUT, 'profile-' + TAG)}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'], { detached: true, stdio: 'ignore' });
child.unref();
await sleep(3500);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 512 * 1024 * 1024 });
await new Promise(r => ws.on('open', r));
let id = 0; const P = new Map();
const consoleErrors = [];
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(String(m.params?.exceptionDetails?.text || 'exception'));
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    consoleErrors.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 160));
  }
});
const cmd = (method, params = {}) => new Promise(res => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = (e, ap = false) => cmd('Runtime.evaluate', { expression: e, awaitPromise: ap, returnByValue: true })
  .then(r => { if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description).slice(0, 240)); return r.result?.result?.value; });

await cmd('Runtime.enable'); await cmd('Page.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 500 });
await cmd('Page.navigate', { url: 'http://localhost:3005/' });

// A fixed sleep is not enough — at 6s the page can report no h1 at all.
// Poll for a mounted landing before measuring anything.
for (let i = 0; i < 40; i++) {
  const ready = await ev(`!!document.querySelector('#seam .pl-seam') && !!document.querySelector('h1')`);
  if (ready) break;
  await sleep(500);
}

// Scroll the seam section to the top of the viewport. The landing scrolls
// inside .pl-root, not the body, so scrollIntoView on the element is the
// only thing that works here.
// scrollIntoView puts the section top at the viewport top, where the
// sticky nav covers the headline. Back off past the nav.
await ev(`(function(){
  var s = document.querySelector('#seam');
  if (!s) return 0;
  s.scrollIntoView({block:'start'});
  var sc = s.closest('.pl-root') || document.scrollingElement;
  sc.scrollTop -= 96;
  return 1;
})()`);
await sleep(900);

const geo = JSON.parse(await ev(`(function(){
  var st = document.querySelector('#seam .pl-seam');
  var sec = document.querySelector('#seam');
  var b = st.getBoundingClientRect(), sb = sec.getBoundingClientRect();
  return JSON.stringify({stage:{x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)},
                         section:{y:Math.round(sb.y),h:Math.round(sb.height)}});
})()`));
console.log(`section h=${geo.section.h}px   stage ${geo.stage.w}×${geo.stage.h} at y=${geo.stage.y}`);

// Full-section frame first, for composition.
{
  const clip = { x: 0, y: Math.max(0, geo.section.y), width: W, height: Math.min(H, geo.section.h + 20), scale: 1 };
  const r = await cmd('Page.captureScreenshot', { format: 'png', clip });
  if (r.result?.data) fs.writeFileSync(path.join(OUT, `${TAG}-section.png`), Buffer.from(r.result.data, 'base64'));
}

// Then walk the stage through a cycle.
const read = `(function(){
  var st = document.querySelector('#seam .pl-seam');
  var cov = st.querySelector('.pl-seam-c');
  var full = st.querySelector('.pl-seam-f');
  var q = st.querySelector('.pl-seam-q span');
  var clock = st.querySelector('.pl-seam-clock');
  var pips = st.querySelectorAll('.pl-seam-pips b');
  var on = -1; pips.forEach(function(p,i){ if (p.getAttribute('data-on')==='1') on = i; });
  return JSON.stringify({
    beat: st.getAttribute('data-beat'), scene: on,
    q: (q && q.textContent || '').length,
    cover: (cov && cov.textContent || '').length,
    full: (full && full.textContent || '').length,
    clock: clock && clock.textContent,
  });
})()`;

for (let i = 0; i < FRAMES; i++) {
  const s = JSON.parse(await ev(read));
  const b = await ev(`(function(){var r=document.querySelector('#seam .pl-seam').getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)});})()`);
  const r0 = JSON.parse(b);
  const clip = { x: Math.max(0, r0.x - 6), y: Math.max(0, r0.y - 6), width: Math.min(W, r0.w + 12), height: Math.min(H - Math.max(0, r0.y - 6), r0.h + 12), scale: 1 };
  const shot = await cmd('Page.captureScreenshot', { format: 'png', clip });
  if (shot.result?.data) fs.writeFileSync(path.join(OUT, `${TAG}-f${String(i).padStart(2, '0')}.png`), Buffer.from(shot.result.data, 'base64'));
  console.log(`  f${String(i).padStart(2, '0')} beat=${s.beat} scene=${s.scene} q=${s.q} cover=${s.cover} full=${s.full} clock=${s.clock}`);
  await sleep(760);
}

const audit = JSON.parse(await ev(`JSON.stringify({
  overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
  seamOverflowX: (function(){ var s=document.querySelector('#seam'); return s ? s.scrollWidth > s.clientWidth + 1 : null; })(),
  h1Count: document.querySelectorAll('h1').length,
  h2InSeam: (document.querySelector('#seam h2')||{}).innerText || null,
  srText: ((document.querySelector('#seam .pl-sr-only')||{}).textContent||'').length,
  stageAriaHidden: (document.querySelector('#seam .pl-seam')||{}).getAttribute ? document.querySelector('#seam .pl-seam').getAttribute('aria-hidden') : null,
  tapTargets: document.querySelectorAll('a,button,[role=button]').length,
  panels: document.querySelectorAll('section, header, footer').length
})`));
console.log('\nAUDIT');
Object.entries(audit).forEach(([k, v]) => console.log(`  ${k}: ${JSON.stringify(v)}`));
console.log(`  consoleErrors: ${consoleErrors.length}${consoleErrors.length ? ' → ' + consoleErrors.slice(0, 3).join(' | ') : ''}`);
console.log(`\nframes → ${OUT}`);

ws.close();
try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue | Stop-Process -Force`]); } catch (_) {}
process.exit(0);
