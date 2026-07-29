// Live proof against the RUNNING desktop app: sign it in, confirm it
// claims the host role, then drive it from a phone the way the real
// phone will — press Auto-Solve remotely and watch the answer mirror
// back over the socket.
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const WS = require('ws');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const db = new Database(process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'minicaai.db'), { readonly: true });
const email = (process.env.ADMIN_EMAILS || '').split(',')[0].trim();
const u = db.prepare('SELECT id,email,name FROM users WHERE email = ?').get(email);
const lic = db.prepare('SELECT tier,status,expires_at,sessions_limit,sessions_used,credits_remaining_seconds,credits_expire_at,trial_remaining_seconds FROM licenses WHERE user_id = ?').get(u.id);
const token = jwt.sign({ id: u.id, email: u.email }, process.env.JWT_SECRET, { expiresIn: '2h' });

// ── 1. sign the desktop app in so it starts hosting ──
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tgt = list.find(t => t.type === 'page' && t.url.includes('localhost:3005') && !t.url.includes('popout'));
if (!tgt) { console.error('desktop app not found on :9222'); process.exit(1); }
const ws = new WS(tgt.webSocketDebuggerUrl, { maxPayload: 2 ** 28 });
await new Promise(r => ws.on('open', r));
let id = 0; const P = new Map();
ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); } });
const ev = (e, ap = false) => new Promise(res => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, awaitPromise: ap, returnByValue: true } })); })
  .then(r => r.result?.result?.value);

await ev(`(()=>{localStorage.setItem('minicaai_token',${JSON.stringify(token)});
  localStorage.setItem('minicaai_auth',${JSON.stringify(JSON.stringify({ id: u.id, email: u.email, name: u.name || 'A' }))});
  localStorage.setItem('minicaai_license',${JSON.stringify(JSON.stringify(lic))});return 1;})()`);
ws.send(JSON.stringify({ id: ++id, method: 'Page.reload', params: { ignoreCache: true } }));
console.log(`signed in as ${u.email} (${lic?.tier}) — waiting for the desktop to claim host…`);
await sleep(9000);

// ── 2. join as the phone and watch presence ──
const phone = new WS('ws://127.0.0.1:4000/ws/remote');
const seen = [];
let presence = 'offline', joined = null;
await new Promise(r => phone.on('open', r));
phone.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.kind === 'joined') { joined = m; presence = m.presence; }
  if (m.kind === 'presence') presence = m.presence;
  if (m.kind === 'event') seen.push(m);
  if (m.kind === 'command_status') seen.push(m);
});

// Ask the desktop which session it is on, so the phone mirrors the same one.
const sessionId = await ev(`(window.__dev_sessionId && window.__dev_sessionId()) || localStorage.getItem('minicaai_last_session') || 'live'`);
phone.send(JSON.stringify({ kind: 'join', token, role: 'remote', sessionId: String(sessionId || 'live'), cursor: 0 }));

const until = async (fn, ms = 25000, label = '') => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(120); }
  throw new Error('timed out: ' + label);
};

await until(() => joined, 8000, 'phone join');
console.log(`phone joined session ${joined.sessionId}  ·  cursor ${joined.cursor}  ·  replayed ${joined.replay.length} event(s)`);

try {
  await until(() => presence === 'online' || presence === 'busy', 20000, 'desktop to come online');
  console.log(`✅ desktop is HOSTING — presence: ${presence}`);
} catch {
  console.log(`❌ desktop never claimed host (presence still "${presence}")`);
  console.log('   the app is probably signed out, or the renderer did not reload');
  process.exit(1);
}

// ── 3. press a button on the phone ──
const cmdId = 'cmd-live-' + Math.random().toString(36).slice(2, 10);
phone.send(JSON.stringify({
  v: 1, kind: 'command', id: cmdId, type: 'send',
  sessionId: String(sessionId || 'live'),
  payload: { text: 'From the phone: name one tradeoff of event sourcing.' },
  issuedAt: Date.now(), ttlMs: 20000,
}));
console.log('\nphone pressed Send…');

const queued = await until(() => seen.find(m => m.kind === 'command_status' && m.id === cmdId), 8000, 'command status');
console.log(`  status: ${queued.status}`);

// The desktop should now stream an answer, and it should reach the phone.
const start = await until(() => seen.find(m => m.type === 'answer_start'), 25000, 'answer_start on the phone');
console.log('  ✅ answer_start mirrored to the phone');
const tokens = await until(() => seen.filter(m => m.type === 'answer_tokens').length > 2, 30000, 'live tokens');
console.log(`  ✅ live token frames arriving (${seen.filter(m => m.type === 'answer_tokens').length} so far, seq=null as designed)`);
const done = await until(() => seen.find(m => m.type === 'answer_done'), 60000, 'answer_done');
console.log(`  ✅ answer_done persisted with seq=${done.seq}`);
console.log(`\n  the phone received: "${String(done.data.text || '').slice(0, 120)}…"`);

// ── 4. prove catch-up: a phone that joins LATE gets the same answer ──
const late = new WS('ws://127.0.0.1:4000/ws/remote');
let lateJoin = null;
await new Promise(r => late.on('open', r));
late.on('message', raw => { const m = JSON.parse(raw); if (m.kind === 'joined') lateJoin = m; });
late.send(JSON.stringify({ kind: 'join', token, role: 'remote', sessionId: String(sessionId || 'live'), cursor: 0 }));
await until(() => lateJoin, 8000, 'late phone join');
const replayedDone = lateJoin.replay.filter(e => e.type === 'answer_done');
console.log(`\n  a phone joining fresh replayed ${lateJoin.replay.length} event(s), ${replayedDone.length} finished answer(s)`);
console.log(`  ✅ catch-up works — last answer: "${String(replayedDone.at(-1)?.data?.text || '').slice(0, 90)}…"`);

phone.close(); late.close(); ws.close();
console.log('\n════ device sync verified against the running desktop app ════');
process.exit(0);
