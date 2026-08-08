// Under prefers-reduced-motion the seam must render its FINISHED frame
// and then hold perfectly still — both answers present, the join already
// made. A stage that animates anyway is an accessibility failure; a stage
// that renders empty is worse, because the section then says nothing at
// all to the people who need it least distracting.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const OUT = path.join(process.env.TEMP || os.tmpdir(), 'claude', 'C--Users-penta',
  'f504e286-3aa7-4b86-9abc-6580186c227c', 'scratchpad', 'seam');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9361;
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
// Reduced motion is forced through CDP (Emulation.setEmulatedMedia)
// below, not a launch flag — the flag is not stable across Edge builds
// and an unrecognised one makes the browser exit before binding the port.
const child = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(OUT, 'profile-rm2')}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', 'about:blank'], { detached: true, stdio: 'ignore' });
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
// Belt and braces: the CLI flag alone has been unreliable across Edge builds.
await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await cmd('Page.navigate', { url: 'http://localhost:3005/' });
for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('#seam .pl-seam')`)) break; await sleep(500); }
await ev(`document.querySelector('#seam').scrollIntoView({block:'start'}); document.querySelector('.pl-root').scrollTop -= 96; 1`);
await sleep(1500);

const snap = `(function(){
  var st = document.querySelector('#seam .pl-seam');
  return JSON.stringify({
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    beat: st.getAttribute('data-beat'),
    q: (st.querySelector('.pl-seam-q span').textContent||'').length,
    cover: (st.querySelector('.pl-seam-c').textContent||'').length,
    full: (st.querySelector('.pl-seam-f').textContent||'').length,
    clock: st.querySelector('.pl-seam-clock').textContent,
    stitchDisplay: getComputedStyle(st.querySelector('.pl-seam-stitch')).display,
    coverAnim: getComputedStyle(st.querySelector('.pl-seam-say')).animationName,
    caretDisplay: getComputedStyle(st.querySelector('.pl-seam-caret')).display,
    sheen: getComputedStyle(st, '::after').display
  });
})()`;

const a = JSON.parse(await ev(snap));
console.log('t=0  ', JSON.stringify(a));
await sleep(6000);
const b = JSON.parse(await ev(snap));
console.log('t=6s ', JSON.stringify(b));

const still = a.q === b.q && a.cover === b.cover && a.full === b.full && a.beat === b.beat && a.clock === b.clock;
console.log(`\nreduced-motion active : ${a.reduced}`);
console.log(`finished frame shown  : ${a.cover > 100 && a.full > 100 && a.stitchDisplay === 'inline-block'}`);
console.log(`held still over 6s    : ${still}`);
console.log(`plate anim off       : ${a.coverAnim === 'none'}`);
console.log(`caret suppressed     : ${a.caretDisplay === 'none'}`);

const r = await cmd('Page.captureScreenshot', { format: 'png' });
if (r.result?.data) fs.writeFileSync(path.join(OUT, 'reduced-motion.png'), Buffer.from(r.result.data, 'base64'));
ws.close();
try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue | Stop-Process -Force`]); } catch (_) {}
process.exit(0);
