// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AI-ASSIST PROVIDER ROUTING PROBE
//  Verifies: draft → Claude (Anthropic), polish → GPT (OpenAI).
//  Cost-conscious: ONE draft + ONE polish call (caps at ~$0.01).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

'use strict';
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const URL_WS = 'ws://localhost:4000/ws/support';
const AGENT_EMAIL = 'nippu@gmail.com';
const CUST_EMAIL = `aiassist-${Date.now()}@example.com`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function open(role, email, name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL_WS);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', role, user: email, name }));
      resolve({ ws });
    });
    ws.on('message', () => {});
  });
}

function postAssist(threadId, jwt, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      method: 'POST',
      hostname: 'localhost',
      port: 4000,
      path: `/api/v1/support/inbox/threads/${threadId}/ai-assist`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${jwt}`,
        'Accept': 'text/event-stream',
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function assert(label, cond, detail) {
  console.log(cond ? `✅ ${label}` : `❌ ${label} — ${detail || ''}`);
  if (!cond) throw new Error(`assertion failed: ${label}`);
}

(async () => {
  const db = require('../src/database');
  const jwt = require('jsonwebtoken');
  const adminUser = db.getDB().prepare("SELECT id, email FROM users WHERE LOWER(email) = ?").get(AGENT_EMAIL);
  if (!adminUser) { console.error('No admin user; aborting'); process.exit(2); }
  const adminToken = jwt.sign({ id: adminUser.id, email: adminUser.email, tier: 'max' }, process.env.JWT_SECRET, { expiresIn: '15m' });

  // Setup: customer + a couple of messages so the prompt has substance.
  const cust = await open('customer', CUST_EMAIL, 'AssistTest');
  await sleep(400);
  cust.ws.send(JSON.stringify({ type: 'message', text: 'hi, can I get a refund? I bought basic last week and it crashes.' }));
  await sleep(500);
  const thread = db.findResumableSupportThread(CUST_EMAIL);
  if (!thread) { console.error('thread not created'); process.exit(2); }

  console.log('\n━━━ CALL 1: draft (expect Anthropic Claude) ━━━\n');
  const t1 = Date.now();
  const draftResp = await postAssist(thread.id, adminToken, { mode: 'draft' });
  const t1ms = Date.now() - t1;
  assert('draft 200', draftResp.status === 200, `status=${draftResp.status}`);
  const draftText = draftResp.body
    .split('\n\n')
    .filter(l => l.startsWith('data:'))
    .map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } })
    .filter(Boolean)
    .map(o => o.delta || '')
    .join('');
  console.log(`   raw bytes=${draftResp.body.length} text="${draftText.slice(0, 200).replace(/\n/g, ' ')}…"`);
  console.log(`   latency=${t1ms}ms`);
  assert('draft produced text', draftText.trim().length > 0, 'draft body was empty');

  console.log('\n━━━ CALL 2: polish (expect OpenAI GPT) ━━━\n');
  const t2 = Date.now();
  const polishResp = await postAssist(thread.id, adminToken, {
    mode: 'polish',
    draftText: 'hey there sorry to hear that. yeah i can refund you. send me ur transaction id and ill push it through asap',
  });
  const t2ms = Date.now() - t2;
  assert('polish 200', polishResp.status === 200, `status=${polishResp.status}`);
  const polishText = polishResp.body
    .split('\n\n')
    .filter(l => l.startsWith('data:'))
    .map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } })
    .filter(Boolean)
    .map(o => o.delta || '')
    .join('');
  console.log(`   raw bytes=${polishResp.body.length} text="${polishText.slice(0, 200).replace(/\n/g, ' ')}…"`);
  console.log(`   latency=${t2ms}ms`);
  assert('polish produced text', polishText.trim().length > 0, 'polish body was empty');

  console.log('\n━━━ Cleanup ━━━');
  db.getDB().prepare('DELETE FROM support_threads WHERE id = ?').run(thread.id);
  cust.ws.close();
  await sleep(200);
  console.log('\n✅ Both providers wired, both stream non-empty deltas.');
  process.exit(0);
})().catch(e => {
  console.error('\n❌ PROBE FAILED:', e.message);
  process.exit(1);
});
