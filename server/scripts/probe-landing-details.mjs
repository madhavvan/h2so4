// Detail probe for the public landing at phone width: which tap targets
// are undersized, does the animated headline expose a complete accessible
// name, and what does the pricing section actually say.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const W = Number(process.argv[2] || 390), H = Number(process.argv[3] || 844);
const OUT = path.join(os.tmpdir(), 'claude', 'C--Users-penta', '7586704a-eea2-4204-a133-acc0ee56f32b', 'scratchpad', 'landing');
const PORT = 9336;

const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const child = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(OUT, 'profile-detail')}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', 'about:blank'], { detached: true, stdio: 'ignore' });
child.unref();
await sleep(3500);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 512 * 1024 * 1024 });
await new Promise(r => ws.on('open', r));
let id = 0; const P = new Map();
ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); } });
const cmd = (m, p = {}) => new Promise(res => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = (e) => cmd('Runtime.evaluate', { expression: e, returnByValue: true })
  .then(r => { if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description).slice(0, 200)); return r.result?.result?.value; });

await cmd('Runtime.enable'); await cmd('Page.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 500 });
await cmd('Page.navigate', { url: 'http://localhost:3005/' });
// Wait for the app to actually MOUNT. A fixed sleep reported "1 interactive
// element" on a page that has 27 — the landing was still rendering.
let ready = false;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  const n = await ev(`document.querySelectorAll('a,button,[role=button]').length`).catch(() => 0);
  if (n >= 20 && await ev(`!!document.querySelector('h1')`).catch(() => false)) { ready = true; break; }
}
console.log(ready ? '(landing mounted)\n' : '(WARNING: landing never reached a mounted state)\n');
await sleep(1500);

console.log(`══ UNDERSIZED TAP TARGETS @ ${W}px (WCAG 2.5.5 asks for 44×44; 32 is the lenient floor) ══`);
const tt = JSON.parse(await ev(`(function(){
  var out = [];
  document.querySelectorAll('a,button,[role=button]').forEach(function(e){
    var b = e.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) return;
    if (b.height < 44 || b.width < 44) {
      out.push({
        tag: e.tagName.toLowerCase(),
        w: Math.round(b.width), h: Math.round(b.height),
        text: (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\\s+/g,' ').slice(0, 34)
      });
    }
  });
  return JSON.stringify(out);
})()`));
tt.forEach(t => console.log(`   ${String(t.w).padStart(4)}×${String(t.h).padStart(3)}  <${t.tag}>  ${JSON.stringify(t.text)}`));
console.log(`   → ${tt.length} of ${await ev(`document.querySelectorAll('a,button,[role=button]').length`)} interactive elements are under 44px in one dimension`);

console.log('\n══ ANIMATED HEADLINE — what a screen reader / crawler gets ══');
const h1 = JSON.parse(await ev(`(function(){
  var h = document.querySelector('h1');
  if (!h) return JSON.stringify({ none: true });
  var srOnly = h.querySelector('.sr-only, .visually-hidden, [class*=srOnly]');
  return JSON.stringify({
    innerText: h.innerText.replace(/\\s+/g,' ').trim(),
    ariaLabel: h.getAttribute('aria-label'),
    hasSrOnlyChild: !!srOnly,
    srOnlyText: srOnly ? srOnly.innerText.trim() : null,
    ariaHiddenChildren: h.querySelectorAll('[aria-hidden="true"]').length,
    html: h.innerHTML.replace(/\\s+/g,' ').slice(0, 320)
  });
})()`));
Object.entries(h1).forEach(([k, v]) => console.log(`   ${k}: ${JSON.stringify(v)}`));

// Sample the headline repeatedly to see whether it ever reads complete.
const samples = new Set();
for (let i = 0; i < 24; i++) {
  samples.add(String(await ev(`(document.querySelector('h1')||{}).innerText||''`)).replace(/\s+/g, ' ').trim());
  await sleep(400);
}
console.log(`   distinct headline states seen over ~10s: ${samples.size}`);
console.log(`   longest state observed: ${JSON.stringify([...samples].sort((a, b) => b.length - a.length)[0])}`);

console.log('\n══ PRICING SECTION TEXT ══');
const pricing = await ev(`(function(){
  var hs = Array.prototype.slice.call(document.querySelectorAll('h2'));
  var h = hs.find(function(x){ return /Pay for the interview/i.test(x.innerText); });
  if (!h) return '(pricing heading not found)';
  var sec = h.closest('section') || h.parentElement;
  return sec ? sec.innerText.replace(/\\n{2,}/g,'\\n').trim().slice(0, 1400) : '(no section)';
})()`);
console.log(pricing.split('\n').map(l => '   ' + l).join('\n'));

ws.close();
try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue | Stop-Process -Force`]); } catch (_) {}
process.exit(0);
