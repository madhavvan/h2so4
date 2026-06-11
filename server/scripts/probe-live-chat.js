// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LIVE CHAT END-TO-END PROBE
//  Spawn an admin + customer WebSocket, walk through the full
//  flow, log every frame, assert each expected event. If the
//  customer's "agent connected" never arrives, this script
//  prints exactly which step broke.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

'use strict';

const WebSocket = require('ws');

const URL = 'ws://localhost:4000/ws/support';
const AGENT_EMAIL = 'nippu@gmail.com';
const CUSTOMER_EMAIL = `probe-cust-${Date.now()}@example.com`;
const CUSTOMER_NAME = 'Probe Customer';

const log = (who, ...args) => console.log(`[${who}]`, ...args);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function open(role, email, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const received = [];
    ws.on('open', () => {
      log(role, 'socket OPEN');
      ws.send(JSON.stringify({ type: 'join', role, user: email, name }));
      log(role, '→ sent join', { role, user: email });
      resolve({ ws, received });
    });
    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw);
        received.push(data);
        log(role, '← frame', JSON.stringify(data).slice(0, 200));
      } catch { /* binary or malformed */ }
    });
    ws.on('error', (e) => log(role, 'ERROR', e.message));
    ws.on('close', (code, reason) => log(role, `socket CLOSED code=${code} reason="${reason}"`));
    setTimeout(() => reject(new Error(`${role} WS open timeout`)), 5_000);
  });
}

(async () => {
  console.log('\n=== STEP 1: Agent connects ===\n');
  const agent = await open('agent', AGENT_EMAIL, 'Nippu Probe');
  await sleep(500);

  console.log('\n=== STEP 2: Customer connects ===\n');
  const customer = await open('customer', CUSTOMER_EMAIL, CUSTOMER_NAME);
  await sleep(1500);

  console.log('\n=== STEP 3: Did the agent see customer_joined? ===\n');
  const sawCustomerJoined = agent.received.some(m => m.type === 'customer_joined' && m.email === CUSTOMER_EMAIL);
  console.log(sawCustomerJoined ? '✅ YES — agent got customer_joined' : '❌ NO — agent did NOT get customer_joined');

  console.log('\n=== STEP 4: Did the customer see agent_joined? ===\n');
  const sawAgentJoined = customer.received.some(m => m.type === 'agent_joined');
  console.log(sawAgentJoined ? '✅ YES — customer got agent_joined' : '❌ NO — customer did NOT get agent_joined');

  console.log('\n=== STEP 5: Customer sends a message ===\n');
  customer.ws.send(JSON.stringify({ type: 'message', text: 'Hi — please help!' }));
  await sleep(1000);
  const agentGotMsg = agent.received.filter(m => m.type === 'message' && m.from === CUSTOMER_EMAIL);
  console.log(agentGotMsg.length > 0
    ? `✅ YES — agent got ${agentGotMsg.length} message(s) from customer`
    : '❌ NO — agent did NOT get customer message');

  console.log('\n=== STEP 6: Agent sends a reply ===\n');
  agent.ws.send(JSON.stringify({ type: 'message', to: CUSTOMER_EMAIL, text: 'Hello, how can I help?' }));
  await sleep(1000);
  const custGotReply = customer.received.filter(m => m.type === 'message');
  console.log(custGotReply.length > 0
    ? `✅ YES — customer got ${custGotReply.length} message(s) from agent`
    : '❌ NO — customer did NOT get agent reply');

  console.log('\n=== STEP 7: DB state ===\n');
  const db = require('../src/database');
  const threads = db.listOpenSupportThreads({ limit: 5 });
  const ourThread = threads.find(t => t.customer_email === CUSTOMER_EMAIL);
  if (ourThread) {
    console.log(`✅ Thread exists: ${ourThread.id}`);
    console.log(`   status=${ourThread.status} assigned=${ourThread.assigned_agent_email || '(none)'}`);
    console.log(`   unread_from_customer=${ourThread.unread_from_customer}`);
    console.log(`   last_message_text="${ourThread.last_message_text}"`);
    console.log(`   last_message_role=${ourThread.last_message_role}`);
    const msgs = db.getSupportMessages(ourThread.id);
    console.log(`   ${msgs.length} messages in DB:`);
    for (const m of msgs) {
      console.log(`     - [${m.sender_role}] ${m.sender_email || ''}: "${m.text.slice(0, 60)}"`);
    }
  } else {
    console.log('❌ Thread NOT found in DB');
  }

  console.log('\n=== STEP 8: Agent presence ===\n');
  const presence = db.getSupportAgentPresence(AGENT_EMAIL);
  if (presence) {
    const ageSec = Math.round((Date.now() - presence.last_heartbeat_at) / 1000);
    console.log(`✅ presence row exists: status=${presence.status}, heartbeat ${ageSec}s ago`);
    console.log(`   ntfy_topic=${presence.ntfy_topic}`);
  } else {
    console.log('❌ No presence row for agent');
  }

  console.log('\n=== Cleanup ===\n');
  if (ourThread) {
    db.getDB().prepare('DELETE FROM support_threads WHERE id = ?').run(ourThread.id);
    console.log('Test thread deleted');
  }
  agent.ws.close();
  customer.ws.close();
  await sleep(300);

  process.exit(0);
})().catch(e => {
  console.error('PROBE FAILED:', e);
  process.exit(1);
});
