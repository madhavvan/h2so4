// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  REAL-SCENARIO PROBE
//
//  Simulates exactly what the user is hitting: admin has TWO agent
//  connections (Electron + browser tab) at the same email, customer
//  joins, both directions of messaging must work, and reconnect
//  must heal anything that drops. Goal: pinpoint the actual gap so
//  the next fix is precise, not speculation.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

'use strict';
const WebSocket = require('ws');
const URL = 'ws://localhost:4000/ws/support';
const AGENT_EMAIL = 'nippu@gmail.com';
const CUSTOMER_EMAIL = `real-test-${Date.now()}@example.com`;

const log = (who, ...a) => console.log(`[${who}]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function open(role, email, name, label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const received = [];
    ws.on('open', () => {
      log(label, 'OPEN');
      ws.send(JSON.stringify({ type: 'join', role, user: email, name }));
      resolve({ ws, received, label });
    });
    ws.on('message', raw => {
      try {
        const data = JSON.parse(raw);
        received.push(data);
        log(label, '← ' + data.type, JSON.stringify(data).slice(0, 140));
      } catch {}
    });
    ws.on('close', (code, reason) => log(label, `CLOSED code=${code} reason="${reason}"`));
  });
}

function assert(label, cond, detail) {
  console.log(cond ? `✅ ${label}` : `❌ ${label} — ${detail || ''}`);
  if (!cond) throw new Error(`assertion failed: ${label}`);
}

(async () => {
  const db = require('../src/database');

  console.log('\n━━━ SCENARIO 1: Two admin connections + one customer ━━━\n');
  const adminElectron = await open('agent', AGENT_EMAIL, 'Nippu (Electron)', 'admin-electron');
  await sleep(200);
  const adminBrowser = await open('agent', AGENT_EMAIL, 'Nippu (Browser)', 'admin-browser');
  await sleep(400);

  // Customer joins. BOTH admin connections should receive customer_joined.
  console.log('\n--- Customer joins ---\n');
  const cust = await open('customer', CUSTOMER_EMAIL, 'Test Customer', 'customer');
  await sleep(1000);

  const electronGotJoin = adminElectron.received.some(m => m.type === 'customer_joined' && m.email === CUSTOMER_EMAIL);
  const browserGotJoin = adminBrowser.received.some(m => m.type === 'customer_joined' && m.email === CUSTOMER_EMAIL);
  assert('Admin Electron received customer_joined', electronGotJoin);
  assert('Admin Browser received customer_joined', browserGotJoin);

  // Customer should see agent_joined (one or both admins online)
  const custGotAgentJoined = cust.received.some(m => m.type === 'agent_joined');
  assert('Customer received agent_joined', custGotAgentJoined,
    'Frames: ' + cust.received.map(m => m.type).join(','));

  console.log('\n--- Admin Browser sends a message ---\n');
  adminBrowser.ws.send(JSON.stringify({ type: 'message', to: CUSTOMER_EMAIL, text: 'Hi from Browser' }));
  await sleep(600);
  const custGotBrowserMsg = cust.received.some(m => m.type === 'message' && m.text === 'Hi from Browser');
  assert('Customer received Browser admin message', custGotBrowserMsg);

  console.log('\n--- Admin Electron sends a message ---\n');
  adminElectron.ws.send(JSON.stringify({ type: 'message', to: CUSTOMER_EMAIL, text: 'Hi from Electron' }));
  await sleep(600);
  const custGotElectronMsg = cust.received.some(m => m.type === 'message' && m.text === 'Hi from Electron');
  assert('Customer received Electron admin message', custGotElectronMsg);

  console.log('\n--- Customer replies ---\n');
  cust.ws.send(JSON.stringify({ type: 'message', text: 'Got both, thanks!' }));
  await sleep(600);
  const electronGotReply = adminElectron.received.some(m => m.type === 'message' && m.text === 'Got both, thanks!');
  const browserGotReply = adminBrowser.received.some(m => m.type === 'message' && m.text === 'Got both, thanks!');
  assert('Admin Electron received customer reply', electronGotReply);
  assert('Admin Browser received customer reply', browserGotReply);

  console.log('\n━━━ SCENARIO 2: Customer disconnects + reconnects (network blip) ━━━\n');
  cust.ws.close(1000, 'simulated network blip');
  await sleep(800);
  const cust2 = await open('customer', CUSTOMER_EMAIL, 'Test Customer', 'customer-reconnect');
  await sleep(800);
  const cust2GotHistory = cust2.received.some(m => m.type === 'history' && Array.isArray(m.messages));
  assert('Reconnected customer received history',
    cust2GotHistory,
    'Reconnect should re-hydrate the conversation. Frames: ' + cust2.received.map(m => m.type).join(','));
  if (cust2GotHistory) {
    const history = cust2.received.find(m => m.type === 'history');
    const msgCount = history.messages.length;
    console.log(`   History contains ${msgCount} messages`);
    assert('History contains the 3 prior messages', msgCount >= 3,
      `expected at least 3, got ${msgCount}`);
  }

  console.log('\n--- After customer reconnect, admin can still send ---\n');
  adminElectron.ws.send(JSON.stringify({ type: 'message', to: CUSTOMER_EMAIL, text: 'After your reconnect' }));
  await sleep(600);
  const cust2GotAfterReconnect = cust2.received.some(m => m.type === 'message' && m.text === 'After your reconnect');
  assert('Customer received admin message after reconnect', cust2GotAfterReconnect);

  console.log('\n━━━ SCENARIO 3: Admin Browser disconnects, Electron alone ━━━\n');
  adminBrowser.ws.close(1000, 'browser tab closed');
  await sleep(500);
  cust2.ws.send(JSON.stringify({ type: 'message', text: 'After browser closed' }));
  await sleep(600);
  const electronGotSolo = adminElectron.received.some(m => m.type === 'message' && m.text === 'After browser closed');
  assert('Electron-only admin received customer message', electronGotSolo);

  console.log('\n━━━ CLEANUP ━━━\n');
  const thread = db.listOpenSupportThreads({ limit: 10 }).find(t => t.customer_email === CUSTOMER_EMAIL);
  if (thread) db.getDB().prepare('DELETE FROM support_threads WHERE id = ?').run(thread.id);
  adminElectron.ws.close();
  cust2.ws.close();
  await sleep(300);

  console.log('\n✅✅✅ ALL SCENARIOS PASSED — server WS layer is sound end-to-end.\n');
  process.exit(0);
})().catch(e => {
  console.error('\n❌ PROBE FAILED:', e.message);
  process.exit(1);
});
