// Under prefers-reduced-motion the Answer Theater must render its FINISHED
// frame and then hold perfectly still — no streaming, no sheen, no pulse.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = path.join(os.tmpdir(), 'claude', 'C--Users-penta', '7586704a-eea2-4204-a133-acc0ee56f32b', 'scratchpad', 'landing');

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));
if (!EDGE) { console.error('Edge not found'); process.exit(1); }

const child = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9341',
  `--user-data-dir=${path.join(OUT, 'profile-a11y')}`, '--no-first-run',
  '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { detached: true, stdio: 'ignore' });
child.unref();
await sleep(3500);

const list = await (await fetch('http://127.0.0.1:9341/json/list')).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 5e8 });
await new Promise(r => ws.on('open', r));
let id = 0; const P = new Map(); const errs = [];
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error')
    errs.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 150));
});
const cmd = (m, p = {}) => new Promise(res => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = e => cmd('Runtime.evaluate', { expression: e, returnByValue: true }).then(r => r.result?.result?.value);

await cmd('Runtime.enable'); await cmd('Page.enable');
await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: 'http://localhost:3005/' });

for (let i = 0; i < 60; i++) { await sleep(500); if (await ev(`!!document.querySelector('.pl-at')`).catch(() => 0)) break; }
await ev(`document.querySelector('.pl-at').scrollIntoView({block:'center'});1`);
await sleep(2500);

const probe = `(function(){var e=document.querySelector('.pl-at');return JSON.stringify({
  beat: e.getAttribute('data-beat'),
  q: (e.querySelector('.pl-at-qtext')||{}).textContent.length,
  cover: (e.querySelector('.pl-at-cover')||{}).textContent.length,
  rest: (e.querySelector('.pl-at-rest')||{}).textContent.length,
  code: (e.querySelector('.pl-at-src')||{}).textContent.length
});})()`;

const a = JSON.parse(await ev(probe));
console.log('REDUCED MOTION');
console.log(`  beat=${a.beat} (4 = finished frame)   question=${a.q}c  cover=${a.cover}c  rest=${a.rest}c  code=${a.code}c`);
console.log(`  finished content rendered without animating: ${a.beat === '4' && a.cover > 50 && a.code > 50 ? 'YES' : 'NO'}`);
await sleep(3000);
const b = JSON.parse(await ev(probe));
console.log(`  held still over the next 3s: ${a.beat === b.beat && a.cover === b.cover && a.code === b.code ? 'YES (no motion)' : 'NO — it animated'}`);
console.log(`  console errors: ${errs.length}`);

// The brand mark must also settle: under reduced motion it should show the
// FINISHED quotation (both drops solid, no question, no trace) and hold.
await ev(`document.querySelector('.pl-markbeat').scrollIntoView({block:'center'});1`);
await sleep(1200);
const markProbe = `(function(){var s=document.querySelector('.pl-markbeat svg');
  var o=function(sel){var e=s.querySelector(sel);return e?Number(getComputedStyle(e).opacity).toFixed(2):'n/a';};
  return JSON.stringify({q:o('.mm-q'),dot:o('.mm-q-dot'),lead:o('.mm-lead-g .mm-fill'),echo:o('.mm-echo-g .mm-fill')});})()`;
const m1 = JSON.parse(await ev(markProbe));
await sleep(3000);
const m2 = JSON.parse(await ev(markProbe));
console.log('\nBRAND MARK under reduced motion');
console.log(`  question=${m1.q} dot=${m1.dot}  drop1=${m1.lead} drop2=${m1.echo}`);
console.log(`  shows the finished quotation: ${m1.lead === '1.00' && m1.echo === '1.00' && m1.q === '0.00' ? 'YES' : 'NO'}`);
console.log(`  held still over 3s: ${JSON.stringify(m1) === JSON.stringify(m2) ? 'YES (no motion)' : 'NO — it animated'}`);

ws.close();
try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue | Stop-Process -Force`]); } catch (_) {}
process.exit(0);
