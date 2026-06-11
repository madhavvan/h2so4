// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RESOLVE → RE-JOIN PROBE
//  Reproduces the exact 2026-05-13 bug: admin resolves a thread,
//  customer clicks Talk to a human again, admin's inbox should
//  see them as a NEW open thread (NOT the old resolved one).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

'use strict';

const WebSocket = require('ws');

const URL = 'ws://localhost:4000/ws/support';
const AGENT_EMAIL = 'nippu@gmail.com';
const CUSTOMER_EMAIL = `probe-rejoin-${Date.now()}@example.com`;

const log = (who, ...args) => console.log(`[${who}]`, ...args);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function open(role, email, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const received = [];
    ws.on('open', () => {
      log(role, 'socket OPEN');
      ws.send(JSON.stringify({ type: 'join', role, user: email, name }));
      resolve({ ws, received });
    });
    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw);
        received.push(data);
        log(role, '← frame', JSON.stringify(data).slice(0, 180));
      } catch {}
    });
    ws.on('close', () => log(role, 'socket CLOSED'));
    setTimeout(() => reject(new Error(`${role} WS timeout`)), 5_000);
  });
}

(async () => {
  const db = require('../src/database');

  console.log('\n=== STEP 1: First chat — customer joins ===\n');
  const agent = await open('agent', AGENT_EMAIL, 'Nippu');
  await sleep(300);
  const cust1 = await open('customer', CUSTOMER_EMAIL, 'Test Customer');
  await sleep(800);

  const thread1Id = agent.received.find(m => m.type === 'customer_joined')?.threadId;
  console.log(`thread1Id = ${thread1Id || '(NOT FOUND)'}`);
  if (!thread1Id) { console.log('❌ FAIL — no customer_joined seen by agent'); process.exit(1); }

  console.log('\n=== STEP 2: Agent replies + resolves ===\n');
  agent.ws.send(JSON.stringify({ type: 'message', to: CUSTOMER_EMAIL, text: 'How can I help?' }));
  await sleep(500);
  // Resolve via the same DB helper the REST route uses. Server's WS handler
  // doesn't have a direct resolve event, the REST route owns that.
  db.resolveSupportThread(thread1Id);
  // Mimic the route's WS push of csat_request to the customer's live socket.
  cust1.ws.send = cust1.ws.send.bind(cust1.ws);   // (no-op — we're calling on the server side via DB,
  //                                                    the customer would normally receive a csat_request frame here)
  // Trigger csat_request the same way the REST route does — find the socket
  // server-side and send it.
  await sleep(200);
  // Simulate the REST resolve push: we POST a synthetic csat_request to the
  // customer socket via the agent socket (which acts as a stand-in).
  // The REAL flow is: REST POST /resolve → server iterates supportClients →
  // pushes csat_request to matching customer socket. Here we just close the
  // customer socket to simulate the client tearing down on csat_request
  // (which is the new client behavior we wired today).
  cust1.ws.close(1000, 'csat_request — simulated client teardown');
  await sleep(500);

  const dbThread1 = db.getSupportThread(thread1Id);
  console.log(`Thread 1 status after resolve: ${dbThread1.status}`);
  if (dbThread1.status !== 'resolved') {
    console.log('❌ FAIL — thread not marked resolved');
    process.exit(1);
  }
  console.log('✅ Thread 1 is resolved.');

  console.log('\n=== STEP 3: Customer clicks Talk to a human AGAIN ===\n');
  const cust2 = await open('customer', CUSTOMER_EMAIL, 'Test Customer');
  await sleep(800);

  console.log('\n=== STEP 4: Did the agent see a NEW customer_joined? ===\n');
  // Filter: customer_joined events that arrived AFTER the first one.
  const joinedEvents = agent.received.filter(m => m.type === 'customer_joined' && m.email === CUSTOMER_EMAIL);
  console.log(`Agent received ${joinedEvents.length} customer_joined event(s)`);
  if (joinedEvents.length < 2) {
    console.log('❌ FAIL — agent did NOT receive a second customer_joined');
    process.exit(1);
  }
  const thread2Id = joinedEvents[joinedEvents.length - 1].threadId;
  console.log(`thread2Id = ${thread2Id}`);
  if (thread2Id === thread1Id) {
    console.log('❌ FAIL — server re-used the resolved thread instead of creating a new one!');
    process.exit(1);
  }
  console.log('✅ NEW threadId issued — server correctly skipped the resolved one.');

  console.log('\n=== STEP 5: DB has both threads, second is OPEN ===\n');
  const dbThread2 = db.getSupportThread(thread2Id);
  console.log(`Thread 2 status: ${dbThread2.status}`);
  if (dbThread2.status !== 'open') {
    console.log('❌ FAIL — new thread should be status=open');
    process.exit(1);
  }
  console.log('✅ New thread is OPEN.');

  console.log('\n=== STEP 6: Admin inbox list correctness ===\n');
  const open_ = db.listOpenSupportThreads({ limit: 10 });
  const newOpen = open_.find(t => t.id === thread2Id);
  const oldHidden = open_.find(t => t.id === thread1Id);
  console.log(`Open list contains thread2 (new)? ${!!newOpen ? '✅' : '❌'}`);
  console.log(`Open list excludes thread1 (resolved)? ${!oldHidden ? '✅' : '❌'}`);
  if (!newOpen) { process.exit(1); }
  if (oldHidden) { process.exit(1); }

  console.log('\n=== Cleanup ===\n');
  db.getDB().prepare('DELETE FROM support_threads WHERE id IN (?, ?)').run(thread1Id, thread2Id);
  agent.ws.close();
  cust2.ws.close();
  await sleep(200);
  console.log('✅ ALL CHECKS PASSED — resolve → re-join flow works end-to-end.');
  process.exit(0);
})().catch(e => {
  console.error('PROBE FAILED:', e);
  process.exit(1);
});
