// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  END-TO-END RENDERER PROBE
//
//  Simulates the FULL renderer chain:
//    1. Admin's root WS opens, joins as agent (mimics App.tsx hook)
//    2. Customer opens, joins as customer
//    3. Customer sends a message via WS
//    4. Admin's WS receives → mimics App.tsx onmessage dispatching
//       'minicaai-support-event' DOM CustomEvent → mimics SupportBot's
//       inbox listener catching the event and updating state.
//    5. Admin "types" a reply via sendInboxMessage → mimics
//       SupportBot dispatching 'minicaai-support-send' DOM event →
//       mimics App.tsx onSendRequest catching it and calling ws.send.
//    6. Customer's WS receives the agent's message.
//
//  This catches bugs in the bridge layer that probe-real-scenario
//  (which uses raw ws.send) misses.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

'use strict';
const WebSocket = require('ws');
const EventEmitter = require('events');

const URL = 'ws://localhost:4000/ws/support';
const AGENT_EMAIL = 'nippu@gmail.com';
const CUSTOMER_EMAIL = `e2e-renderer-${Date.now()}@example.com`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Renderer-side DOM event bus simulation.
const bus = new EventEmitter();

// ── Admin root-WS simulation (App.tsx SUPPORT AGENT BACKGROUND CHANNEL) ──
function spawnAdmin() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const received = [];
    let outboundCount = 0;
    let inboundCount = 0;
    let wsOpenedAt = null;

    ws.on('open', () => {
      wsOpenedAt = Date.now();
      ws.send(JSON.stringify({ type: 'join', role: 'agent', user: AGENT_EMAIL, name: 'Nippu (renderer-sim)' }));
      // Mimic App.tsx onSendRequest — catch minicaai-support-send and forward to ws.
      bus.on('minicaai-support-send', (payload) => {
        const wsOpen = ws.readyState === WebSocket.OPEN;
        if (!payload || !wsOpen) {
          console.warn('[admin-bridge] DROP — ws not open');
          return;
        }
        outboundCount++;
        ws.send(JSON.stringify(payload));
      });
      resolve({ ws, received, getOutCount: () => outboundCount, getInCount: () => inboundCount });
    });
    ws.on('message', raw => {
      try {
        const data = JSON.parse(raw);
        received.push(data);
        inboundCount++;
        // Mimic App.tsx — dispatch a DOM-like event into our bus.
        bus.emit('minicaai-support-event', data);
      } catch {}
    });
    ws.on('error', err => reject(err));
    setTimeout(() => reject(new Error('admin WS open timeout')), 5_000);
  });
}

// ── SupportBot inbox listener simulation ──
// Mirrors what SupportBot.tsx does on minicaai-support-event for
// type:'customer_joined' and type:'message'.
function spawnInboxState() {
  const customers = new Map();
  const messages = new Map();
  bus.on('minicaai-support-event', (data) => {
    if (data.type === 'customer_joined') {
      customers.set(data.email, { email: data.email, name: data.name, threadId: data.threadId });
    } else if (data.type === 'message') {
      const em = data.from || '';
      if (!em) return;
      const isOutbound = data.outbound === true;
      const arr = messages.get(em) || [];
      arr.push({ from: isOutbound ? 'agent' : 'customer', text: data.text });
      messages.set(em, arr);
    }
  });
  return { customers, messages };
}

// ── Customer WS simulation ──
function spawnCustomer() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const received = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', role: 'customer', user: CUSTOMER_EMAIL, name: 'E2E Customer' }));
      resolve({ ws, received });
    });
    ws.on('message', raw => {
      try { received.push(JSON.parse(raw)); } catch {}
    });
    ws.on('error', err => reject(err));
    setTimeout(() => reject(new Error('customer WS open timeout')), 5_000);
  });
}

function assert(label, cond, detail) {
  console.log(cond ? `✅ ${label}` : `❌ ${label} — ${detail || ''}`);
  if (!cond) throw new Error(`assertion failed: ${label}`);
}

(async () => {
  const db = require('../src/database');

  console.log('\n=== Step 1: admin root WS opens (mimics App.tsx hook) ===\n');
  const admin = await spawnAdmin();
  const inbox = spawnInboxState();
  await sleep(300);

  console.log('\n=== Step 2: customer joins ===\n');
  const cust = await spawnCustomer();
  await sleep(600);

  assert('Admin received customer_joined via WS', admin.received.some(m => m.type === 'customer_joined' && m.email === CUSTOMER_EMAIL));
  assert('SupportBot inbox state has the customer', inbox.customers.has(CUSTOMER_EMAIL),
    `customers map keys: [${[...inbox.customers.keys()].join(', ')}]`);

  console.log('\n=== Step 3: customer sends "hello admin" ===\n');
  cust.ws.send(JSON.stringify({ type: 'message', text: 'hello admin' }));
  await sleep(500);

  assert('SupportBot inbox messages has the customer message',
    (inbox.messages.get(CUSTOMER_EMAIL) || []).some(m => m.from === 'customer' && m.text === 'hello admin'),
    `messages[customer]: ${JSON.stringify(inbox.messages.get(CUSTOMER_EMAIL))}`);

  console.log('\n=== Step 4: admin types reply via SupportBot CustomEvent (mimics sendInboxMessage) ===\n');
  // Mimic SupportBot.tsx sendInboxMessage → dispatches minicaai-support-send
  bus.emit('minicaai-support-send', {
    type: 'message',
    to: CUSTOMER_EMAIL,
    text: 'hi! how can I help?',
  });
  await sleep(600);

  console.log(`Admin bridge outbound count: ${admin.getOutCount()}`);
  assert('Admin bridge forwarded the outbound message to the WS', admin.getOutCount() === 1);

  assert('Customer WS received the agent message',
    cust.received.some(m => m.type === 'message' && m.text === 'hi! how can I help?'),
    `customer frames: [${cust.received.map(m => m.type + (m.text ? ':' + m.text : '')).join(', ')}]`);

  console.log('\n=== Step 5: verify DB persistence ===\n');
  const thread = db.findResumableSupportThread(CUSTOMER_EMAIL);
  assert('Thread exists in DB', !!thread, `customer email: ${CUSTOMER_EMAIL}`);
  if (thread) {
    const msgs = db.getSupportMessages(thread.id);
    console.log(`   ${msgs.length} messages in DB:`);
    for (const m of msgs) console.log(`     - [${m.sender_role}] "${m.text}"`);
    assert('Customer message persisted', msgs.some(m => m.sender_role === 'customer' && m.text === 'hello admin'));
    assert('Agent message persisted', msgs.some(m => m.sender_role === 'agent' && m.text === 'hi! how can I help?'));
  }

  console.log('\n=== Cleanup ===\n');
  if (thread) db.getDB().prepare('DELETE FROM support_threads WHERE id = ?').run(thread.id);
  admin.ws.close();
  cust.ws.close();
  bus.removeAllListeners();
  await sleep(300);

  console.log('\n✅✅✅ End-to-end renderer bridge works through every link.\n');
  process.exit(0);
})().catch(e => {
  console.error('\n❌ PROBE FAILED:', e.message);
  process.exit(1);
});
