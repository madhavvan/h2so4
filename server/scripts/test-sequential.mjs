// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Sequential latency test — one call at a time, no parallelism.
//  Each call's latency is measured in isolation: nothing else is
//  hitting the server concurrently. This gives a clean per-call
//  reading that mirrors what a single user actually experiences.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = 'http://localhost:4000';
const ADMIN_EMAIL = (process.env.ADMIN_EMAILS || '').split(',')[0].trim();
const JWT_SECRET = process.env.JWT_SECRET;
const token = jwt.sign({ id: 'test-admin', email: ADMIN_EMAIL, tier: 'max' }, JWT_SECRET, { expiresIn: '1h' });

// Same upgraded production prompt — keep this aligned with the test-models.mjs
// SYSTEM constant so timing comparisons are like-for-like.
const SYSTEM = `You are the candidate in a live interview. You are a real human, not an AI assistant.

CODING (mandatory): APPROACH (2-4 sentences, candidate voice) → COMPLEXITY (1 sentence) → CODE (function body only) → optional EDGES.

SYSTEM DESIGN: 3-7 sentences. Shape → trade-off with second-order effect → one thing you'd defer.

ML / DATA: clarify problem → data considerations → model with reason → evaluation → production concerns.

UNIVERSAL CONSTRAINTS:
- BANNED WORDS: robust, leverage, utilize, delve, holistic, in essence, crucial, paramount, foster, streamline, pivotal, comprehensive, facilitate.
- BANNED PHRASES: "building a culture of [X]", "drive significant business impact", "scalability, performance, and reliability" tricolon, "best-in-class", "world-class", "industry-leading", "next-generation", "thought leadership", "moving the needle", "low-hanging fruit".
- BANNED OPENERS: "Great question", "Certainly", "Absolutely", "Of course", "Indeed", "Fundamentally".
- Plunge straight into content. Hedge specific facts. Stop when done.

SENIOR INSTINCTS — at least one in every substantive answer:
1. NAME THE EDGE THAT BREAKS THE OBVIOUS ANSWER ("the last_seen[char] >= left guard is the key — without it, 'abba' shrinks the window backward").
2. NAME A NON-OBVIOUS TRADE-OFF WITH SECOND-ORDER CONSEQUENCES (not "there's a trade-off" — name what it costs).
3. CALIBRATED CONFIDENCE — hedge specific numbers, commit to recommendation. Never both at once.
4. RULE OUT THE META-QUESTION FIRST when shape calls for it (debugging, investigation, A/B test).

If coding: APPROACH paragraph BEFORE the code block. Code-dump-first is an automatic fail.`;

// Mix of short / medium / long expected outputs so we can see how
// latency tracks output length under sequential conditions.
const TESTS = [
  { id: 'short-clarifier', domain: 'Short — Clarifier',
    prompt: 'What is a hashmap and when would you use one?' },
  { id: 'short-concept', domain: 'Short — Concept',
    prompt: 'What is the difference between a process and a thread?' },
  { id: 'medium-coding', domain: 'Medium — Coding',
    prompt: 'Write a function that reverses a singly linked list iteratively.' },
  { id: 'medium-debug', domain: 'Medium — Debug',
    prompt: 'My SQL query that worked yesterday is now returning duplicate rows. How do I figure out why?' },
  { id: 'medium-behavioral', domain: 'Medium — Behavioral',
    prompt: 'Tell me about a time you had to push back on a deadline.' },
  { id: 'long-system-design', domain: 'Long — System Design',
    prompt: 'Design a rate limiter that supports per-user quotas across multiple regions.' },
  { id: 'long-ml', domain: 'Long — ML',
    prompt: 'How would you build a search ranking system for an e-commerce product catalog?' },
  { id: 'long-cs', domain: 'Long — CS Strategy',
    prompt: 'A $500K ARR enterprise customer is at risk of churn. Walk me through your save plan.' },
];

const MODELS = [
  { name: 'openai', endpoint: '/api/v1/ai/chat/openai', shape: 'messages', model: 'gpt-5.6' },
  { name: 'claude', endpoint: '/api/v1/ai/chat/claude', shape: 'claude' },
];

async function call(model, test) {
  const url = SERVER + model.endpoint;
  let body;
  if (model.shape === 'claude') {
    body = { messages: [{ role: 'user', content: test.prompt }],
             systemInstruction: SYSTEM, enableWebSearch: false };
  } else {
    body = { messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: test.prompt },
    ] };
    if (model.model) body.model = model.model;
  }
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const took = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, status: res.status, error: text.slice(0, 200), took };
    }
    const data = await res.json();
    const text = data.text || data.content || '';
    return { ok: true, text, took, chars: text.length };
  } catch (err) {
    return { ok: false, error: err.message, took: Date.now() - t0 };
  }
}

async function main() {
  console.log(`Sequential test: ${TESTS.length} questions × ${MODELS.length} models = ${TESTS.length * MODELS.length} calls`);
  console.log(`Each call awaits the previous one — no concurrent traffic to the server.\n`);

  const results = {};
  for (const test of TESTS) {
    console.log(`────────────────────────────────────────────────────────────`);
    console.log(`[${test.id}] ${test.domain}`);
    console.log(`Q: ${test.prompt}`);
    results[test.id] = { domain: test.domain, prompt: test.prompt, models: {} };
    for (const model of MODELS) {
      // SEQUENTIAL: await each call before issuing the next.
      const r = await call(model, test);
      results[test.id].models[model.name] = r;
      if (r.ok) {
        const tokRate = r.chars > 0 && r.took > 0 ? Math.round((r.chars / 4) / (r.took / 1000)) : 0;
        console.log(`  ${model.name.padEnd(7)}  ${String(r.took).padStart(6)}ms  ${String(r.chars).padStart(5)} chars  ~${tokRate} tok/s`);
      } else {
        console.log(`  ${model.name.padEnd(7)}  FAIL ${r.status || ''} (${r.took}ms)  ${r.error || ''}`);
      }
    }
  }

  // Aggregate per model
  const agg = {};
  for (const m of MODELS) {
    const samples = [];
    for (const r of Object.values(results)) {
      const x = r.models[m.name];
      if (x.ok && Number.isFinite(x.took)) samples.push({ took: x.took, chars: x.chars });
    }
    samples.sort((a, b) => a.took - b.took);
    const totalChars = samples.reduce((a, s) => a + s.chars, 0);
    const totalMs = samples.reduce((a, s) => a + s.took, 0);
    agg[m.name] = {
      n: samples.length,
      min: samples[0]?.took ?? 0,
      p50: samples[Math.floor(samples.length / 2)]?.took ?? 0,
      avg: Math.round(totalMs / Math.max(1, samples.length)),
      max: samples[samples.length - 1]?.took ?? 0,
      avgChars: Math.round(totalChars / Math.max(1, samples.length)),
      tokPerSec: totalMs > 0 ? Math.round((totalChars / 4) / (totalMs / 1000)) : 0,
    };
  }

  console.log(`\n────────────────────────────────────────────────────────────`);
  console.log(`SEQUENTIAL LATENCY SUMMARY\n`);
  console.log('model'.padEnd(10), 'n'.padStart(3), 'min'.padStart(8), 'p50'.padStart(8), 'avg'.padStart(8), 'max'.padStart(8), 'avgChars'.padStart(10), 'tok/s'.padStart(7));
  for (const [name, l] of Object.entries(agg)) {
    console.log(name.padEnd(10), String(l.n).padStart(3),
      `${l.min}ms`.padStart(8), `${l.p50}ms`.padStart(8),
      `${l.avg}ms`.padStart(8), `${l.max}ms`.padStart(8),
      String(l.avgChars).padStart(10), String(l.tokPerSec).padStart(7));
  }

  // Markdown report
  const out = path.join(__dirname, '..', 'test-sequential-results.md');
  let md = `# Sequential latency test — ${new Date().toISOString()}\n\n`;
  md += `Each call awaits the previous; no concurrent traffic.\n\n## Summary\n\n`;
  md += `| model | n | min | p50 | avg | max | avg chars | tok/s |\n|---|---|---|---|---|---|---|---|\n`;
  for (const [name, l] of Object.entries(agg)) {
    md += `| ${name} | ${l.n} | ${l.min}ms | ${l.p50}ms | ${l.avg}ms | ${l.max}ms | ${l.avgChars} | ${l.tokPerSec} |\n`;
  }
  md += `\n## Per-question timing\n\n| Question | openai | claude |\n|---|---|---|\n`;
  for (const [id, r] of Object.entries(results)) {
    const o = r.models.openai;
    const c = r.models.claude;
    md += `| **${r.domain}** | ${o?.ok ? `${o.took}ms · ${o.chars}c` : 'FAIL'} | ${c?.ok ? `${c.took}ms · ${c.chars}c` : 'FAIL'} |\n`;
  }
  md += `\n---\n\n`;
  for (const [id, r] of Object.entries(results)) {
    md += `## ${r.domain}\n\n**Q**: ${r.prompt}\n\n`;
    for (const m of MODELS) {
      const x = r.models[m.name];
      md += `### ${m.name} — ${x?.ok ? `${x.took}ms · ${x.chars} chars` : 'FAIL'}\n\n`;
      if (x.ok) md += '> ' + (x.text || '').replace(/\n/g, '\n> ') + '\n\n';
      else md += `**FAIL** ${x.status || ''}: ${x.error}\n\n`;
    }
    md += '---\n\n';
  }
  fs.writeFileSync(out, md);
  console.log(`\nReport: ${out}`);
}

main().catch(err => { console.error(err); process.exit(1); });
