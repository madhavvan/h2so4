// The landing scrolls inside a container, not the document body, so a
// captureBeyondViewport screenshot only ever returns the hero. This finds
// the real scroller, walks it a viewport at a time, and captures each
// panel — plus it times the hero's typewriter headline, which a single
// screenshot can only ever catch mid-animation.
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
const TAG = W < 500 ? 'mobile' : 'desktop';
const OUT = path.join(os.tmpdir(), 'claude', 'C--Users-penta', '7586704a-eea2-4204-a133-acc0ee56f32b', 'scratchpad', 'landing');
fs.mkdirSync(OUT, { recursive: true });
const PORT = W < 500 ? 9335 : 9334;

const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const child = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(OUT, 'profile-' + TAG)}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'], { detached: true, stdio: 'ignore' });
child.unref();
await sleep(3500);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 512 * 1024 * 1024 });
await new Promise(r => ws.on('open', r));
let id = 0; const P = new Map();
ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); } });
const cmd = (method, params = {}) => new Promise(res => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = (e, ap = false) => cmd('Runtime.evaluate', { expression: e, awaitPromise: ap, returnByValue: true })
  .then(r => { if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description).slice(0, 200)); return r.result?.result?.value; });

await cmd('Runtime.enable'); await cmd('Page.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 500 });
await cmd('Page.navigate', { url: 'http://localhost:3005/' });
await sleep(5000);

// ── How long does the hero headline take to finish typing? ──
const t0 = Date.now();
let settledAt = null, lastH1 = '';
for (let i = 0; i < 60; i++) {
  const h1 = await ev(`(document.querySelector('h1')||{}).innerText || ''`);
  if (h1 === lastH1 && h1.length > 0) { settledAt = Date.now() - t0; break; }
  lastH1 = h1;
  await sleep(500);
}
console.log(`hero headline settled after ~${settledAt === null ? '>30000' : settledAt}ms → ${JSON.stringify(lastH1)}`);

// ── Find the element that actually scrolls ──
const scroller = await ev(`(function(){
  var best = null, bestH = 0;
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var e = all[i], s = getComputedStyle(e);
    if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 50) {
      if (e.scrollHeight > bestH) { bestH = e.scrollHeight; best = e; }
    }
  }
  if (!best) return JSON.stringify({ sel: 'window', total: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) });
  best.setAttribute('data-shot-scroller','1');
  return JSON.stringify({ sel: '[data-shot-scroller]', total: best.scrollHeight, client: best.clientHeight });
})()`);
const sc = JSON.parse(scroller);
console.log(`scroller: ${sc.sel}  content height=${sc.total}px  (viewport ${H}px)`);

const setY = async (y) => ev(sc.sel === 'window'
  ? `window.scrollTo(0, ${y}); 1`
  : `document.querySelector('[data-shot-scroller]').scrollTop = ${y}; 1`);

const panels = Math.min(12, Math.ceil(sc.total / H));
const headings = [];
for (let i = 0; i < panels; i++) {
  await setY(i * H);
  await sleep(1400);
  const r = await cmd('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) fs.writeFileSync(path.join(OUT, `${TAG}-panel${String(i).padStart(2, '0')}.png`), Buffer.from(r.result.data, 'base64'));
  const vis = await ev(`(function(){
    var out = [];
    document.querySelectorAll('h1,h2,h3').forEach(function(h){
      var b = h.getBoundingClientRect();
      if (b.top < window.innerHeight && b.bottom > 0 && h.innerText.trim()) out.push(h.tagName + ': ' + h.innerText.trim().replace(/\\s+/g,' ').slice(0,70));
    });
    return JSON.stringify(out);
  })()`);
  const hs = JSON.parse(vis);
  headings.push({ panel: i, hs });
  console.log(`  panel ${i}: ${hs.length ? hs.join(' | ') : '(no headings in view)'}`);
}

// ── Whole-page checks at this width ──
const audit = JSON.parse(await ev(`JSON.stringify({
  overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
  tinyTapTargets: Array.prototype.filter.call(document.querySelectorAll('a,button,[role=button]'), function(e){
    var b = e.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && (b.height < 32 || b.width < 32);
  }).length,
  totalTapTargets: document.querySelectorAll('a,button,[role=button]').length,
  emptyLinks: Array.prototype.filter.call(document.querySelectorAll('a'), function(a){
    return !a.innerText.trim() && !a.getAttribute('aria-label') && !a.querySelector('img,svg');
  }).length,
  imgsNoAlt: Array.prototype.filter.call(document.images, function(i){ return !i.getAttribute('alt'); }).length,
  h1Count: document.querySelectorAll('h1').length,
  lang: document.documentElement.lang || null,
  metaDesc: (document.querySelector('meta[name=description]')||{}).content || null,
  title: document.title
})`));
console.log('\nAUDIT');
Object.entries(audit).forEach(([k, v]) => console.log(`  ${k}: ${JSON.stringify(v)}`));

ws.close();
try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue | Stop-Process -Force`]); } catch (_) {}
process.exit(0);
