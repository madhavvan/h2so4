// TEMP dev-only CDP screenshot helper (uses project's `ws`). Safe to delete.
// Usage: node cdp-shot.mjs <cdpHttpBase> <outPng> [waitMs] [waitText] [urlFilter]
// Env: SHOT_BEYOND=0 for viewport-only; SHOT_SCROLL_TEXT to scroll a section in.
import WebSocket from 'ws';
const [, , base, outPng, waitMsArg, waitText, urlFilterArg] = process.argv;
const waitMs = Number(waitMsArg || 3500);
const urlFilter = urlFilterArg || 'localhost';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const res = await fetch(`${base}/json/list`);
const targets = await res.json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && (t.url || '').includes(urlFilter))
          || targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) { console.error('no page target'); process.exit(1); }
console.log('target:', page.url);
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
let idc = 0; const pending = new Map();
ws.on('message', (b) => { const m = JSON.parse(b.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++idc; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
await send('Page.enable'); await send('Runtime.enable');
if (waitText) {
  const deadline = Date.now() + waitMs * 4; let seen = false;
  while (Date.now() < deadline) {
    try { const { result } = await send('Runtime.evaluate', { expression: '(document.body&&document.body.innerText)||""', returnByValue: true });
      if (String(result.value || '').toLowerCase().includes(waitText.toLowerCase())) { seen = true; break; } } catch {}
    await sleep(400);
  }
  console.log(`waitText "${waitText}" seen=${seen}`); await sleep(1200);
} else { await sleep(waitMs); }
const scrollText = process.env.SHOT_SCROLL_TEXT;
if (scrollText) {
  try { await send('Runtime.evaluate', { expression: `(()=>{const n=${JSON.stringify(scrollText)}.toLowerCase();const el=Array.from(document.querySelectorAll('h1,h2,h3,p,div,section')).find(x=>(x.innerText||'').toLowerCase().includes(n));if(el)el.scrollIntoView({block:'center'});return !!el;})()`, returnByValue: true }); await sleep(1100); } catch {}
}
const beyond = process.env.SHOT_BEYOND !== '0';
const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: beyond, fromSurface: true });
const fs = await import('node:fs');
fs.writeFileSync(outPng, Buffer.from(data, 'base64'));
console.log(`wrote ${outPng} (${fs.statSync(outPng).size} bytes)`);
ws.close(); process.exit(0);
