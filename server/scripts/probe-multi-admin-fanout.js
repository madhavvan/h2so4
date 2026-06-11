// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MULTI-ADMIN FANOUT PROBE
//
//  Verifies the 2026-05-13 server fix that broadcasts an agent's
//  outbound message to OTHER agent sockets (Electron + browser
//  tabs of the same admin, or two different admins) so co-admin
//  views stay in sync without a refetch. The sender's OWN socket
//  is skipped (the renderer shows it optimistically already).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

'use strict';
const WebSocket = require('ws');
const URL = 'ws://localhost:4000/ws/support';
const AGENT_EMAIL = 'nippu@gmail.com';
const CUSTOMER_EMAIL = `mafanout-${Date.now()}@example.com`;

const log = (who, ...a) => console.log(`[${who}]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function open(role, email, name, label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const received = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', role, user: email, name }));
      resolve({ ws, received, label });
    });
    ws.on('message', raw => {
      try {
        const data = JSON.parse(raw);
        received.push(data);
        log(label, '← ' + data.type, JSON.stringify(data).slice(0, 160));
      } catch {}
    });
  });
}

function assert(label, cond, detail) {
  console.log(cond ? `✅ ${label}` : `❌ ${label} — ${detail || ''}`);
  if (!cond) throw new Error(`assertion failed: ${label}`);
}

(async () => {
  const db = require('../src/database');

  console.log('\n=== Two admin connections + one customer ===\n');
  const a1 = await open('agent', AGENT_EMAIL, 'Nippu (Electron)', 'admin-1');
  await sleep(200);
  const a2 = await open('agent', AGENT_EMAIL, 'Nippu (Browser)', 'admin-2');
  await sleep(300);
  const cust = await open('customer', CUSTOMER_EMAIL, 'Test', 'customer');
  await sleep(600);

  console.log('\n--- Admin-1 sends a message ---\n');
  a1.ws.send(JSON.stringify({ type: 'message', to: CUSTOMER_EMAIL, text: 'Hello from admin-1' }));
  await sleep(500);

  const customerGot = cust.received.some(m => m.type === 'message' && m.text === 'Hello from admin-1');
  const a2GotFanout = a2.received.some(m =>
    m.type === 'message' && m.text === 'Hello from admin-1' && m.outbound === true && m.from === CUSTOMER_EMAIL
  );
  const a1GotEcho = a1.received.some(m =>
    m.type === 'message' && m.text === 'Hello from admin-1' && m.outbound === true
  );

  assert('Customer received admin-1 message', customerGot);
  assert('Admin-2 received the FANOUT of admin-1 outbound', a2GotFanout,
    'expected outbound:true frame with from=customer email; got: ' +
    a2.received.filter(m => m.type === 'message').map(m => JSON.stringify(m)).join(' || '));
  assert('Admin-1 did NOT receive its own echo (sender skip)', !a1GotEcho,
    'sender should not receive its own outbound to avoid double-render');

  console.log('\n=== Cleanup ===\n');
  const thread = db.listOpenSupportThreads({ limit: 10 }).find(t => t.customer_email === CUSTOMER_EMAIL);
  if (thread) db.getDB().prepare('DELETE FROM support_threads WHERE id = ?').run(thread.id);
  a1.ws.close(); a2.ws.close(); cust.ws.close();
  await sleep(300);
  console.log('\n✅ multi-admin fanout works end-to-end.\n');
  process.exit(0);
})().catch(e => {
  console.error('\n❌ PROBE FAILED:', e.message);
  process.exit(1);
});
