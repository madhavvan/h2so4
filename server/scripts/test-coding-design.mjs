// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Focused test — Claude vs OpenAI on 9 coding/design/ML questions.
//  Same system prompt as test-models.mjs (mirrored from production
//  aiProxyService.ts buildUserRulesBlock + senior-instincts upgrade).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = 'http://localhost:4000';
const ADMIN_EMAIL = (process.env.ADMIN_EMAILS || '').split(',')[0].trim();
const JWT_SECRET = process.env.JWT_SECRET;

if (!ADMIN_EMAIL || !JWT_SECRET) {
  console.error('Missing ADMIN_EMAILS or JWT_SECRET');
  process.exit(1);
}

const token = jwt.sign({ id: 'test-admin', email: ADMIN_EMAIL, tier: 'max' }, JWT_SECRET, { expiresIn: '1h' });

// Same system prompt as test-models.mjs (the upgraded version with
// senior-instincts + banned platitudes). Keeps tests apples-to-apples.
const SYSTEM = `You are the candidate in a live interview. You are a real human, not an AI assistant.

CODING (MANDATORY 4-part structure, every code question, no exceptions):
  1. APPROACH (2-4 sentences, candidate voice): What technique/pattern fits? Why? Key insight that makes it work.
  2. COMPLEXITY (1 sentence): O(time), O(space), brief reason.
  3. CODE: function body only — no main, no example calls, no docstrings.
  4. EDGES (optional, only if genuinely worth noting): 1-2 quick edge cases.
Skipping APPROACH and dumping raw code is the most obvious AI tell.

SYSTEM DESIGN: 3-7 sentences depending on complexity. Shape → trade-off with second-order effect → one thing you'd defer.

ML / DATA: clarify problem → data considerations (imbalance, features) → model choice with reason → evaluation strategy → production concerns.

UNIVERSAL CONSTRAINTS:
- BANNED WORDS: robust, leverage, utilize, delve, holistic, in essence, crucial, paramount, foster, streamline, pivotal, ecosystem (metaphor), comprehensive, facilitate.
- BANNED PHRASES: "building a culture of [X]", "drive significant business impact", "scalability, performance, and reliability" (any tricolon), "best-in-class", "world-class", "industry-leading", "next-generation", "thought leadership", "moving the needle", "low-hanging fruit", "deep-dive into".
- BANNED OPENERS: "Great question", "Certainly", "Absolutely", "Of course", "Let me break this down", "Indeed", "Fundamentally".
- Plunge straight into content. No preamble.
- Hedge specific facts: "I think it was Postgres 14", "ballpark 50ms".
- Stop when done.

SENIOR INSTINCTS — at least one in every substantive answer:

1. NAME THE EDGE THAT BREAKS THE OBVIOUS ANSWER.
   - Coding: "The last_seen[char] >= left guard is the key — without it, 'abba' shrinks the window backward."
   - SQL: "If total_amount can be NULL, wrap in COALESCE — silently under-counts otherwise."
   - System design: "Without pre-warming the autoscaling group, first 90s of traffic spike burns p99."
   - ML: "Cold start matters in three distinct cases — new user, new product, new+new — each needs a different fallback."

2. NAME A NON-OBVIOUS TRADE-OFF WITH SECOND-ORDER CONSEQUENCES.
   - "302 over 301, accepting the extra hop on every visit, because we lose all click analytics if we cache permanently."
   - Not "there's a trade-off" — name what it costs you.

3. CALIBRATED CONFIDENCE — hedge specific numbers, commit to recommendation.

4. RULE OUT THE META-QUESTION FIRST when shape calls for it (debugging, investigation).

SILENT CHECKLIST:
- Coding: APPROACH paragraph BEFORE the code block? Not a code-dump-first answer?
- Did I name the edge that breaks the obvious answer?
- Did I name ONE specific trade-off with downstream consequence?
If any check fails, rewrite.`;

const TESTS = [
  {
    id: 'code-missing',
    domain: 'Coding / Missing Number',
    prompt: 'Given an array of consecutive integers from 0 to n with one number missing, find the missing integer.',
  },
  {
    id: 'code-zeros',
    domain: 'Coding / Move Zeros',
    prompt: 'Given an array of integers, write a function that moves all zeros to the end of the array while maintaining the relative order of non-zero elements.',
  },
  {
    id: 'code-anagram',
    domain: 'Coding / Anagram',
    prompt: 'Given two strings, determine if they are anagrams of each other (return True or False).',
  },
  {
    id: 'code-prefix',
    domain: 'Coding / Longest Common Prefix',
    prompt: 'Given a list of strings, find the longest common prefix among them.',
  },
  {
    id: 'code-lis',
    domain: 'Coding / Longest Increasing Subsequence',
    prompt: 'Find the length of the longest increasing subsequence in a list of integers.',
  },
  {
    id: 'design-rideshare',
    domain: 'Design / Rideshare DB Schema',
    prompt: 'Design a database schema for a ride-sharing app (include tables for users, rides, drivers, vehicles).',
  },
  {
    id: 'design-transactions',
    domain: 'Design / Transaction Processing',
    prompt: 'Design a scalable transaction processing system (focus on high-level architecture, consistency, and performance bottlenecks).',
  },
  {
    id: 'design-messaging',
    domain: 'Design / Social Media Messaging',
    prompt: 'Design a messaging system for a social media application (draw diagram and explain components).',
  },
  {
    id: 'ml-fraud',
    domain: 'ML / Fraud Detection',
    prompt: 'Given a dataset of 600,000 credit card transactions, how would you build a fraud detection model?',
  },
];

const MODELS = [
  { name: 'openai',  endpoint: '/api/v1/ai/chat/openai',  shape: 'messages', model: 'gpt-5.6' },
  { name: 'claude',  endpoint: '/api/v1/ai/chat/claude',  shape: 'claude'   },
];

async function call(model, test) {
  const url = SERVER + model.endpoint;
  let body;
  if (model.shape === 'claude') {
    body = {
      messages: [{ role: 'user', content: test.prompt }],
      systemInstruction: SYSTEM,
      enableWebSearch: false,
    };
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
      return { ok: false, status: res.status, error: text.slice(0, 300), took };
    }
    const data = await res.json();
    const text = data.text || data.content || data.message || '';
    return { ok: true, text, took };
  } catch (err) {
    return { ok: false, error: err.message, took: Date.now() - t0 };
  }
}

async function main() {
  console.log(`Running ${TESTS.length} tests × ${MODELS.length} models = ${TESTS.length * MODELS.length} calls`);
  const results = {};
  for (const test of TESTS) {
    console.log(`\n[${test.id}]`);
    results[test.id] = { domain: test.domain, prompt: test.prompt, models: {} };
    const calls = MODELS.map(m => call(m, test).then(r => [m.name, r]));
    const settled = await Promise.all(calls);
    for (const [name, result] of settled) {
      results[test.id].models[name] = result;
      console.log(`  ${name}: ${result.ok ? `OK (${result.took}ms, ${(result.text || '').length} chars)` : `FAIL ${result.status || ''}`}`);
    }
  }

  // Latency summary
  const latency = {};
  for (const m of MODELS) {
    const samples = [];
    for (const r of Object.values(results)) {
      const x = r.models[m.name];
      if (x.ok && Number.isFinite(x.took)) samples.push(x.took);
    }
    samples.sort((a, b) => a - b);
    const sum = samples.reduce((a, b) => a + b, 0);
    latency[m.name] = {
      n: samples.length,
      min: samples[0],
      p50: samples[Math.floor(samples.length / 2)],
      avg: Math.round(sum / samples.length),
      max: samples[samples.length - 1],
    };
  }

  console.log('\n=== LATENCY ===');
  console.log('model'.padEnd(8), 'n'.padStart(3), 'min'.padStart(7), 'p50'.padStart(7), 'avg'.padStart(7), 'max'.padStart(7));
  for (const [name, l] of Object.entries(latency)) {
    console.log(name.padEnd(8), String(l.n).padStart(3),
      `${l.min}ms`.padStart(7), `${l.p50}ms`.padStart(7),
      `${l.avg}ms`.padStart(7), `${l.max}ms`.padStart(7));
  }

  // Markdown report
  const out = path.join(__dirname, '..', 'test-coding-design-results.md');
  let md = `# Claude vs OpenAI — coding/design/ML — ${new Date().toISOString()}\n\n`;
  md += `## Latency\n\n| model | n | min | p50 | avg | max |\n|---|---|---|---|---|---|\n`;
  for (const [name, l] of Object.entries(latency)) {
    md += `| ${name} | ${l.n} | ${l.min}ms | ${l.p50}ms | ${l.avg}ms | ${l.max}ms |\n`;
  }
  md += `\n---\n\n`;
  for (const [id, r] of Object.entries(results)) {
    md += `## ${r.domain}\n\n**Q**: ${r.prompt}\n\n`;
    for (const m of MODELS) {
      const x = r.models[m.name];
      md += `### ${m.name}\n`;
      if (x.ok) {
        md += `_${x.took}ms · ${(x.text || '').length} chars_\n\n`;
        md += '> ' + (x.text || '').replace(/\n/g, '\n> ') + '\n\n';
      } else {
        md += `**FAIL** ${x.status || ''}: ${x.error}\n\n`;
      }
    }
    md += '---\n\n';
  }
  fs.writeFileSync(out, md);
  console.log(`\nReport: ${out}`);
}

main().catch(err => { console.error(err); process.exit(1); });
