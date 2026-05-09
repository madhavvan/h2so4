// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Fresh-Context Smoke Test
//
//  End-to-end pipeline check. Runs three scenarios:
//    1. Tool-specific question → expect prefetch fires Brave + page fetch
//    2. Conceptual question → expect classifier skips (no Brave call)
//    3. Update-signal question → expect classifier fires on signal alone
//
//  Run: TEST_SERVER=https://api.minicaai.com node scripts/test-prefetch.mjs
//   or: node scripts/test-prefetch.mjs   (defaults to localhost:4000)
//
//  Required env: ADMIN_EMAILS, JWT_SECRET (same as test-models.mjs)
//
//  After running, check server logs for these line patterns:
//    [prefetch] cache-hit deep=N authority=...
//    [fresh-context] cache-hit (N src) for "..."
//    [search] BRAVE_RATE_LIMITED — serving stale cache for "..."  (rate limit)
//    [search] BRAVE_TIMEOUT for "..." — no cache fallback         (timeout)
//
//  If you see [prefetch] and [fresh-context] lines, the pipeline works.
//  If you see Brave errors, those are gracefully handled — chat still answers.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import jwt from 'jsonwebtoken';

const SERVER = process.env.TEST_SERVER || 'http://localhost:4000';
const ADMIN_EMAIL = (process.env.ADMIN_EMAILS || '').split(',')[0].trim();
const JWT_SECRET = process.env.JWT_SECRET;
const SKIP_CHAT = process.env.SKIP_CHAT === '1';  // Skip chat calls if you only want prefetch verification

if (!ADMIN_EMAIL || !JWT_SECRET) {
  console.error('Missing ADMIN_EMAILS or JWT_SECRET — set the same env vars used by test-models.mjs');
  process.exit(1);
}

const token = jwt.sign({ id: 'test-admin', email: ADMIN_EMAIL, tier: 'max' }, JWT_SECRET, { expiresIn: '1h' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callPrefetch(transcript) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${SERVER}/api/v1/ai/prefetch-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ transcript }),
    });
    const elapsed = Date.now() - t0;
    const data = await res.json().catch(() => ({}));
    return { status: res.status, body: data, elapsedMs: elapsed };
  } catch (err) {
    return { status: 0, body: { error: err.message }, elapsedMs: Date.now() - t0 };
  }
}

async function callChat(prompt) {
  if (SKIP_CHAT) return { status: 0, skipped: true, elapsedMs: 0 };
  const t0 = Date.now();
  try {
    const res = await fetch(`${SERVER}/api/v1/ai/chat/openai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'You are a candidate in a live interview. Anchor specific facts in any FRESH_CONTEXT block provided. Speak naturally as a real human.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    const elapsed = Date.now() - t0;
    const data = await res.json().catch(() => ({}));
    return { status: res.status, body: data, elapsedMs: elapsed };
  } catch (err) {
    return { status: 0, body: { error: err.message }, elapsedMs: Date.now() - t0 };
  }
}

function bar(title) {
  const line = '━'.repeat(60);
  console.log(`\n${line}\n  ${title}\n${line}`);
}

async function runTest(label, transcript, expectedClassifierFires) {
  bar(`${label}`);
  console.log(`Q: "${transcript}"`);
  console.log(`Expected classifier fires: ${expectedClassifierFires}\n`);

  console.log(`▸ Step 1: prefetch (fires retrieval in background)`);
  const pf = await callPrefetch(transcript);
  console.log(`  HTTP ${pf.status} in ${pf.elapsedMs}ms — body: ${JSON.stringify(pf.body)}`);
  if (pf.status === 0) console.log(`  ⚠ Could not reach server. Is it running at ${SERVER}?`);

  if (pf.status >= 200 && pf.status < 300) {
    console.log(`\n▸ Step 2: wait 2.5s for cache to warm`);
    await sleep(2500);
  }

  console.log(`\n▸ Step 3: chat call (cache-only mode — should be fast regardless of step 2)`);
  const chat = await callChat(transcript);
  if (chat.skipped) {
    console.log(`  (chat skipped via SKIP_CHAT=1)`);
  } else {
    console.log(`  HTTP ${chat.status} in ${chat.elapsedMs}ms`);
    if (chat.body.text) {
      const preview = chat.body.text.slice(0, 250).replace(/\n/g, ' ');
      console.log(`  Answer preview: ${preview}${chat.body.text.length > 250 ? '...' : ''}`);
    } else {
      console.log(`  Body: ${JSON.stringify(chat.body).slice(0, 300)}`);
    }
  }

  return { prefetch: pf, chat };
}

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  Fresh-Context End-to-End Smoke Test                      ║`);
  console.log(`║  Server: ${SERVER.padEnd(46)}║`);
  console.log(`║  Skip chat: ${String(SKIP_CHAT).padEnd(43)}║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);

  const results = [];

  // ── TEST 1: Tool + specificity (best case for retrieval) ──
  results.push(['Test 1 — tool+specificity',
    await runTest(
      'TEST 1: Tool + specificity (should fire prefetch)',
      'what tabs do you see in the AWS Glue dashboard?',
      true,
    )]);

  // ── TEST 2: Conceptual (classifier should skip) ──
  results.push(['Test 2 — conceptual',
    await runTest(
      'TEST 2: Conceptual question (classifier should skip)',
      'what is a hashmap and when would you use one?',
      false,
    )]);

  // ── TEST 3: Update signal ──
  results.push(['Test 3 — update signal',
    await runTest(
      "TEST 3: Update signal alone (UPDATE_SIGNALS path)",
      "what's new in Python 3.13?",
      true,
    )]);

  // ── TEST 4: Tool-only conceptual (the new strict classifier rejects this) ──
  results.push(['Test 4 — tool-only conceptual',
    await runTest(
      'TEST 4: Tool-only conceptual (new classifier should skip)',
      'tell me about your Apache Spark experience',
      false,
    )]);

  // ── Summary ──
  bar('SUMMARY');
  for (const [name, r] of results) {
    const pfOk = r.prefetch.status >= 200 && r.prefetch.status < 300;
    const chatOk = r.chat.skipped || (r.chat.status >= 200 && r.chat.status < 300);
    const mark = (pfOk && chatOk) ? '✓' : '✗';
    console.log(`  ${mark} ${name}: prefetch ${r.prefetch.status}, chat ${r.chat.status || 'skipped'}`);
  }

  console.log(`\nNow check the SERVER LOGS for these patterns:`);
  console.log(`  [prefetch] fresh deep=NNNNch authority=...   (test 1, 3 — Brave + page fetch ran)`);
  console.log(`  [prefetch] (no log line)                      (test 2, 4 — classifier skipped)`);
  console.log(`  [fresh-context] cache-hit (N src) for "..."   (chat call hit warm cache)`);
  console.log(`  [search] BRAVE_RATE_LIMITED ...               (acceptable — graceful degrade)`);
  console.log(`  [autotype-agent] planner=sonnet/groq ...      (auto-type, separate)`);
  console.log(``);
  console.log(`If test 1 chat answer mentions specifics like "Data Catalog", "Crawlers", etc.,`);
  console.log(`fresh-context retrieval is working end-to-end.\n`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
