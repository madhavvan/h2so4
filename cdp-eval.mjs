import WebSocket from 'ws';
const [, , base, expr, urlFilterArg] = process.argv;
const urlFilter = urlFilterArg || 'localhost';
const res = await fetch(`${base}/json/list`);
const targets = await res.json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && (t.url || '').includes(urlFilter)) || targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) { console.error('no page target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
let idc = 0; const pending = new Map();
ws.on('message', (b) => { const m = JSON.parse(b.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++idc; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
await send('Runtime.enable');
const { result, exceptionDetails } = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
if (exceptionDetails) console.log('EXCEPTION:', JSON.stringify(exceptionDetails.exception));
console.log(JSON.stringify(result.value, null, 2));
ws.close(); process.exit(0);
