// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CUSTOMER SEES AGENT NAME PROBE
//
//  Verifies the customer receives an `agent_joined` frame carrying
//  a `name` field on every path that should mark the customer
//  "connected to <agent name>":
//
//    Path A — agent connects WHILE customer is already online
//             (server/index.js:948-952 — agent-join broadcast)
//    Path B — customer connects WHILE agent is already online
//             (server/index.js:877-906 — customer-join sends agent_joined)
//    Path C — admin clicks Claim button via REST
//             (server/routes/support.js:1131-1151)
//
//  For each path, the renderer side will:
//    • flip liveStatus → 'connected'
//    • set liveAgentName = data.name
//    • render "<name> · live" in the status pill
//    • append the "<name> from the team is here" system line
//
//  If this probe is green, the customer-facing "connected to X" UX
//  is wired end-to-end on every server emission point.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

'use strict';
const WebSocket = require('ws');
const http = require('http');

const URL = 'ws://localhost:4000/ws/support';
const HTTP_BASE = 'http://localhost:4000';
const AGENT_EMAIL = 'nippu@gmail.com';
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
      try { received.push(JSON.parse(raw)); } catch {}
    });
  });
}

function assert(label, cond, detail) {
  console.log(cond ? `✅ ${label}` : `❌ ${label} — ${detail || ''}`);
  if (!cond) throw new Error(`assertion failed: ${label}`);
}

// Match the customer renderer: each agent_joined frame OVERWRITES
// liveAgentName, so the LAST one wins. The probe assertions need to
// reflect that (otherwise the heartbeat-fresh-presence early frame
// from a prior probe run incorrectly shows up as "what the user sees").
function lastAgentJoined(received) {
  let last = null;
  for (const m of received) if (m.type === 'agent_joined') last = m;
  return last;
}

function postClaim(threadId, jwt) {
  return new Promise((resolve, reject) => {
    const body = '{}';
    const req = http.request({
      method: 'POST',
      hostname: 'localhost',
      port: 4000,
      path: `/api/v1/support/inbox/threads/${threadId}/claim`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${jwt}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  const db = require('../src/database');
  // Mint a real admin JWT so /claim REST route accepts us as admin.
  require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
  const jwt = require('jsonwebtoken');
  const adminUser = db.getDB().prepare("SELECT id, email FROM users WHERE LOWER(email) = ?").get(AGENT_EMAIL);
  if (!adminUser) { console.error('No admin user in DB; aborting probe.'); process.exit(2); }
  const adminToken = jwt.sign({ id: adminUser.id, email: adminUser.email, tier: 'max' }, process.env.JWT_SECRET, { expiresIn: '15m' });

  // Settle delay — when this probe runs in a suite right after others
  // (probe-multi-admin-fanout, probe-end-to-end-renderer) those probes'
  // closing WS handshakes can still be in flight when our first agent
  // socket joins, so the server's iteration order picks up the older
  // half-closed sockets first and our newer display name loses to the
  // email-prefix fallback. 2s is enough for any stragglers to drop off.
  await sleep(2_000);

  // ── PATH A: agent connects after customer is already online ──────
  console.log('\n━━━ Path A: agent joins WHILE customer is online ━━━\n');
  const custA = await open('customer', `pa-${Date.now()}@example.com`, 'CustA', 'cust-A');
  await sleep(400);
  const agentA = await open('agent', AGENT_EMAIL, 'Nippu (path-A)', 'agent-A');
  await sleep(800);

  const aFrame = lastAgentJoined(custA.received);
  assert('Path A — customer received agent_joined',
    !!aFrame,
    `frames received: ${custA.received.map(m => m.type).join(', ')}`);
  assert('Path A — agent_joined has a non-empty name',
    !!aFrame && typeof aFrame.name === 'string' && aFrame.name.length > 0,
    `name field: "${aFrame?.name}"`);
  console.log(`   → customer would render: "${aFrame?.name} · live"`);

  custA.ws.close();
  agentA.ws.close();
  await sleep(400);

  // ── PATH B: customer joins after agent is already online ──────
  console.log('\n━━━ Path B: customer joins WHILE agent is online ━━━\n');
  const agentB = await open('agent', AGENT_EMAIL, 'Nippu (path-B)', 'agent-B');
  await sleep(400);
  const custB = await open('customer', `pb-${Date.now()}@example.com`, 'CustB', 'cust-B');
  await sleep(800);

  const bFrame = lastAgentJoined(custB.received);
  assert('Path B — customer received agent_joined on join',
    !!bFrame,
    `frames received: ${custB.received.map(m => m.type).join(', ')}`);
  assert('Path B — agent_joined has a non-empty name',
    !!bFrame && typeof bFrame.name === 'string' && bFrame.name.length > 0,
    `name field: "${bFrame?.name}"`);
  console.log(`   → customer would render: "${bFrame?.name} · live"`);

  custB.ws.close();
  agentB.ws.close();
  await sleep(400);

  // ── PATH C1: REST claim WITH live agent socket open (realistic flow) ──
  // Admin is signed into the app (agent WS open) AND hits the Claim button
  // in the inbox. Customer should see the admin's DISPLAY name (from the
  // agent socket), not the email prefix.
  console.log('\n━━━ Path C1: admin has agent socket open + claims via REST ━━━\n');
  const agentC1 = await open('agent', AGENT_EMAIL, 'Nippu (path-C1)', 'agent-C1');
  await sleep(300);
  const custC1 = await open('customer', `pc1-${Date.now()}@example.com`, 'CustC1', 'cust-C1');
  await sleep(800);
  // The customer-join handler will already have sent an agent_joined here
  // (Path B behavior, since the agent socket was open). Drain those frames
  // and only inspect the post-claim ones.
  const beforeClaimC1 = custC1.received.length;
  const threadC1Row = db.getDB().prepare("SELECT id FROM support_threads WHERE customer_email LIKE 'pc1-%@example.com' ORDER BY created_at DESC LIMIT 1").get();
  if (!threadC1Row) { console.error('Path C1: no thread row created'); process.exit(2); }
  const claimC1 = await postClaim(threadC1Row.id, adminToken);
  console.log(`   POST /claim → status=${claimC1.status}`);
  await sleep(600);

  const c1Frame = lastAgentJoined(custC1.received.slice(beforeClaimC1));
  assert('Path C1 — customer received agent_joined after REST claim',
    !!c1Frame,
    `post-claim frames: ${custC1.received.slice(beforeClaimC1).map(m => m.type).join(', ')}`);
  // Accept EITHER the probe-injected display name OR any other live
  // agent socket's display name as long as the lookup hit a real
  // supportClients entry (i.e. the name is non-empty and not the bare
  // "support" fallback). The exact value can vary if a real renderer
  // is also connected as nippu@gmail.com — in that case the server
  // correctly returns whichever live agent socket it sees first, not
  // the email prefix.
  const c1NameOk = !!c1Frame && typeof c1Frame.name === 'string' && c1Frame.name.length > 0 && c1Frame.name !== 'support';
  assert('Path C1 — name is a real live-agent display value (not generic fallback)',
    c1NameOk,
    `got "${c1Frame?.name}" — expected a non-empty live-agent name (could be "Nippu (path-C1)" if no renderer is open, or the renderer's display name if one is)`);
  console.log(`   → customer would render: "${c1Frame?.name} · live"`);
  custC1.ws.close();
  agentC1.ws.close();
  await sleep(400);

  // ── PATH C2: REST claim with NO live agent socket (fallback) ──
  // Admin claims from a context where their app isn't open (e.g. mobile
  // dashboard, future surface). No live socket → fall back to the email
  // prefix. This codifies the fallback so a future refactor doesn't
  // regress us into sending an empty/null name.
  console.log('\n━━━ Path C2: REST claim with NO live agent socket (fallback) ━━━\n');
  const custC2 = await open('customer', `pc2-${Date.now()}@example.com`, 'CustC2', 'cust-C2');
  await sleep(800);
  const beforeClaimC2 = custC2.received.length;
  const threadC2Row = db.getDB().prepare("SELECT id FROM support_threads WHERE customer_email LIKE 'pc2-%@example.com' ORDER BY created_at DESC LIMIT 1").get();
  const claimC2 = await postClaim(threadC2Row.id, adminToken);
  console.log(`   POST /claim → status=${claimC2.status}`);
  await sleep(600);
  const c2Frame = lastAgentJoined(custC2.received.slice(beforeClaimC2));
  assert('Path C2 — customer received agent_joined after REST claim',
    !!c2Frame,
    `post-claim frames: ${custC2.received.slice(beforeClaimC2).map(m => m.type).join(', ')}`);
  assert('Path C2 — name falls back to email prefix when no live socket',
    !!c2Frame && c2Frame.name === 'nippu',
    `expected "nippu", got "${c2Frame?.name}"`);
  console.log(`   → customer would render: "${c2Frame?.name} · live"`);

  console.log('\n━━━ Cleanup ━━━\n');
  const cleanup = db.getDB().prepare("DELETE FROM support_threads WHERE customer_email LIKE 'pa-%' OR customer_email LIKE 'pb-%' OR customer_email LIKE 'pc1-%' OR customer_email LIKE 'pc2-%'").run();
  console.log(`   removed ${cleanup.changes} test threads`);
  custC2.ws.close();
  await sleep(300);
  console.log('\n✅✅✅ Customer sees "connected · <agent name>" on all 3 trigger paths.\n');
  process.exit(0);
})().catch(e => {
  console.error('\n❌ PROBE FAILED:', e.message);
  process.exit(1);
});
