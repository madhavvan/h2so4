// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CUSTOMER CAP-EVICTION PROBE
//
//  Verifies the server CORRECTLY enforces SUPPORT_MAX_PER_USER.customer=1
//  by closing the older WS with code 4000 when a newer one joins.
//  The renderer-side guard (in SupportBot.tsx ws.onclose) treats
//  code 4000 as "stop reconnecting"; without that guard the two
//  tabs would ping-pong forever in a 1s reconnect loop, which is
//  what produced the symptom "admin's message never lands".
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

'use strict';
const WebSocket = require('ws');
const URL = 'ws://localhost:4000/ws/support';
const CUSTOMER_EMAIL = `capevict-${Date.now()}@example.com`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function open(role, email, name, label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    let closeCode = null;
    let closeReason = null;
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', role, user: email, name }));
      resolve({ ws, getCloseCode: () => closeCode, getCloseReason: () => closeReason, label });
    });
    ws.on('close', (code, reason) => {
      closeCode = code;
      closeReason = reason?.toString() || '';
      console.log(`[${label}] CLOSED code=${code} reason="${closeReason}"`);
    });
  });
}

function assert(label, cond, detail) {
  console.log(cond ? `✅ ${label}` : `❌ ${label} — ${detail || ''}`);
  if (!cond) throw new Error(`assertion failed: ${label}`);
}

(async () => {
  const db = require('../src/database');

  console.log('\n=== Tab A connects as customer ===\n');
  const tabA = await open('customer', CUSTOMER_EMAIL, 'Cust', 'tab-A');
  await sleep(500);

  console.log('\n=== Tab B connects as same customer ===\n');
  const tabB = await open('customer', CUSTOMER_EMAIL, 'Cust', 'tab-B');
  await sleep(800);

  console.log('\n=== Verifying cap eviction ===\n');
  assert('Tab A was closed by server', tabA.getCloseCode() !== null,
    'older tab should have been disconnected');
  assert('Tab A close code is 4000 (Replaced by newer connection)',
    tabA.getCloseCode() === 4000,
    `got code=${tabA.getCloseCode()} reason="${tabA.getCloseReason()}"`);
  assert('Tab B is still open', tabB.ws.readyState === WebSocket.OPEN);

  console.log('\n=== Cleanup ===\n');
  const thread = db.listOpenSupportThreads({ limit: 10 }).find(t => t.customer_email === CUSTOMER_EMAIL);
  if (thread) db.getDB().prepare('DELETE FROM support_threads WHERE id = ?').run(thread.id);
  tabB.ws.close();
  await sleep(300);
  console.log('\n✅ cap-eviction emits code 4000 as expected.\n');
  process.exit(0);
})().catch(e => {
  console.error('\n❌ PROBE FAILED:', e.message);
  process.exit(1);
});
