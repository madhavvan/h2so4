// Verify mixed-case email reliably routes admin → customer messages.
// Reproduces the 2026-05-13 bug where Mimi@gmail.com (customer joined
// with mixed case) wouldn't match mimi@gmail.com (admin inbox after
// REST fetch).
'use strict';
const WebSocket = require('ws');
const URL = 'ws://localhost:4000/ws/support';
const log = (who, ...a) => console.log(`[${who}]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function open(role, email, name) {
  return new Promise(resolve => {
    const ws = new WebSocket(URL);
    const received = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', role, user: email, name }));
      resolve({ ws, received });
    });
    ws.on('message', raw => {
      try { received.push(JSON.parse(raw)); }
      catch {}
    });
  });
}

(async () => {
  // Mixed-case email on the customer side
  const MIXED = `MixedCase-Test-${Date.now()}@Example.com`;
  const LOWER = MIXED.toLowerCase();

  const agent = await open('agent', 'nippu@gmail.com', 'Nippu');
  await sleep(300);
  const cust = await open('customer', MIXED, 'MixedCustomer');
  await sleep(800);

  // Agent uses LOWERCASE (what REST inbox returns)
  agent.ws.send(JSON.stringify({ type: 'message', to: LOWER, text: 'Hi from agent!' }));
  await sleep(800);

  const got = cust.received.filter(m => m.type === 'message');
  console.log(`Customer received ${got.length} message(s) after admin sent with lowercased 'to'`);
  if (got.length > 0) {
    console.log('✅ PASS — case-insensitive routing works');
  } else {
    console.log('❌ FAIL — admin message lost');
    console.log('Customer received frames:', cust.received.map(m => m.type).join(', '));
  }

  // Cleanup
  const db = require('../src/database');
  db.getDB().prepare('DELETE FROM support_threads WHERE customer_email = ?').run(LOWER);
  agent.ws.close();
  cust.ws.close();
  await sleep(200);
  process.exit(got.length > 0 ? 0 : 1);
})();
