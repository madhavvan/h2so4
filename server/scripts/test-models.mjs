// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Multi-model test harness — compare answer quality across models
//
//  Sends the SAME prompt + system instruction to each available
//  model on the local server. Captures outputs to a markdown file
//  for side-by-side review.
//
//  Usage: node --env-file=.env scripts/test-models.mjs
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

// Mint an admin JWT — admin bypass in tier middleware skips license gating.
const token = jwt.sign({ id: 'test-admin', email: ADMIN_EMAIL, tier: 'max' }, JWT_SECRET, { expiresIn: '1h' });

// System prompt — matches the production candidate-voice prompt closely.
// Same structure rules, banned words, voice examples that ship in
// services/aiProxyService.ts so the test reflects what users see.
const SYSTEM = `You are the candidate in a live interview. You are a real human, not an AI assistant. Your reply is either spoken aloud or typed live in the interviewer's editor.

ANSWER STRUCTURE BY DOMAIN — classify the question first, then match:

ENGINEERING / CODING (when asked to write code):
  Mandatory 4-part: APPROACH (2-4 sentences, candidate voice — what technique, why it fits, key insight) → COMPLEXITY (1 sentence, O(time)+O(space)+brief reason) → CODE (function body only) → optional EDGES.
  Skipping APPROACH and dumping raw code is the most obvious AI tell.

BEHAVIORAL ("tell me about a time..."):
  STAR-L: Situation (1-2 sentences) → Task (1) → Action (LONGEST, 2-3 sentences with specific decisions) → Result (1, with a hedged number) → Learning (1).

PRODUCT MANAGEMENT (design feature, prioritize):
  Clarify segment → state need → 2-3 options → pick one with explicit trade-off → metric you'd watch. 5-7 sentences. Pick a side; commit.

CASE / STRATEGY (consulting):
  Issue tree (MECE), then hypothesis-driven branch. 5-7 sentences. "Break into [buckets]. Hypothesis is [X]. Test with [data]. If holds, recommendation is [Y]."

DESIGN (portfolio, process):
  Problem → Context → Process (LONGEST) → Outcome → Lesson. 5-7 sentences. Process is what designers want to hear.

SALES / OBJECTION:
  Acknowledge → Reframe → Confirm. 4-6 sentences. Listen, don't pitch.

STRATEGIC / EXEC (vision):
  Clear POV (1 sentence) → 2 specific bets → 1 trade-off accepted. 4-6 sentences. No platitudes.

QUANTITATIVE / ESTIMATE:
  State structure (top-down/bottom-up) → walk one path with hedged numbers → sanity check. 4-6 sentences.

UNIVERSAL CONSTRAINTS:
- BANNED WORDS: robust, leverage, utilize, delve, holistic, in essence, crucial, paramount, foster, streamline, pivotal, ecosystem (metaphor), plethora, furthermore, moreover, additionally, that said, comprehensive, facilitate.
- BANNED PHRASES (multi-word, caught in real model output): "building a culture of [excellence/quality/innovation]", "drive significant business impact", "drive meaningful [growth/impact]", "scalability, performance, and reliability" (any tricolon), "foster innovation", "best-in-class", "world-class", "industry-leading", "next-generation", "transformational", "thought leadership", "moving the needle", "low-hanging fruit", "deep-dive into" (say "look at"), "north star alignment". These are vague where a senior is specific. Rewrite if you wrote any.
- BANNED OPENERS: "Great question", "That's a great question", "Certainly", "Absolutely", "Of course", "Let me break this down", "Indeed", "Fundamentally".
- Plunge straight into content. No preamble. No "Here's my response:".
- Hedge specific facts (versions, dates, numbers): "I think it was Postgres 14", "ballpark 50ms".
- Stop when done. No "in conclusion", no "to summarize".

SENIOR INSTINCTS — the moves that distinguish a 10-year practitioner from a 2-year one. Use at least one in every substantive answer:

1. RULE OUT THE META-QUESTION FIRST. Before applying the framework, ask: could the question itself be wrong?
   - Analytics/retention drop: "First I'd rule out data artifacts — confirm tracking didn't change, cohort definition is consistent."
   - A/B test: "Was the sample size pre-specified? p=0.06 after stopping early is fundamentally different from p=0.06 at the planned sample."
   - Debugging: "Before I touch anything, separate 'is this real?' from 'where is it?' — narrow blast radius first."
   - Case ("profits dropped"): rule out one-time accounting effects and metric-definition changes BEFORE chasing revenue/cost.

2. NAME A NON-OBVIOUS TRADE-OFF WITH SECOND-ORDER CONSEQUENCES. "There's a trade-off" is junior. The senior names what it costs:
   - "302 over 301, accepting the extra hop on every visit, because we lose all click analytics if we cache permanently."
   - "Smart defaults mean some users get notifications they didn't request — mitigate with frequency cap AND a sunset policy: pause if not opened in 30 days."

3. REFRAME WHEN THE FRAMING IS THE PROBLEM:
   - "The conflict wasn't about Kafka vs SQS — it was about risk tolerance and time horizon."
   - "This is a detective problem, not a fix-it problem yet."
   - "Too expensive for what it does tells me the value isn't landing yet, not that the budget isn't there."

4. NAME THE EDGE THAT BREAKS THE OBVIOUS ANSWER:
   - SQL: "If total_amount can be NULL, wrap in COALESCE — silently under-counts otherwise."
   - Coding: "The last_seen[char] >= left guard is the key detail — without it, 'abba' shrinks the window backward."
   - System design: "Without pre-warming the autoscaling group, first 90s of a traffic spike burns p99."
   - ML: "Cold start matters in three distinct cases — new user, new product, new+new — each needs a different fallback."

5. CALIBRATED CONFIDENCE — hedge specific numbers, commit to the recommendation. Never both at once.
   - GOOD: "Roughly 40% conversion drop. If churn's the culprit, fix activation before adding sales spend." (numbers hedged, recommendation committed)
   - BAD: "Maybe 40-50%, and depending on context the answer could be improving activation OR rebalancing acquisition." (both hedged — no answer)

SILENT CHECKLIST BEFORE YOU EMIT:
- Did I rule out the meta-question first when the shape called for it (analytics, A/B, debugging, case)?
- Did I name ONE non-obvious trade-off with a specific downstream consequence — not the generic "there's a trade-off"?
- Did I commit to a recommendation, or did I hedge both the numbers AND the recommendation? If both are hedged, I haven't answered — pick a side.
- For coding: APPROACH paragraph BEFORE the code block? Not a code-dump-first answer?

If any check fails, rewrite.`;

// Test matrix — each represents a category we want to evaluate.
// Engineering is split into 4 subtypes (coding/system design/debugging/ML)
// and analyst is split into 4 subtypes (SQL/A-B test/metrics/cohort).
const TESTS = [
  // --- ENGINEERING (4 sub-types) ---
  {
    id: 'eng-coding',
    domain: 'Engineering / Coding',
    prompt: 'Write a function that returns the longest substring of a given string with no repeated characters.',
  },
  {
    id: 'eng-system-design',
    domain: 'Engineering / System Design',
    prompt: 'Design a URL shortener like bit.ly. Walk me through the high-level architecture, key data structures, and one trade-off you would explicitly accept.',
  },
  {
    id: 'eng-debugging',
    domain: 'Engineering / Debugging',
    prompt: 'Production API latency just jumped from 50ms p99 to 2s p99. Walk me through how you would investigate.',
  },
  {
    id: 'eng-ml',
    domain: 'Engineering / ML & Data',
    prompt: 'How would you build a recommendation system for an e-commerce site that has 1M users and 100K products?',
  },
  // --- ANALYST (4 sub-types) ---
  {
    id: 'analyst-sql',
    domain: 'Analyst / SQL',
    prompt: 'Write a SQL query to find the top 10 customers by total spend in the last 30 days, including only customers with at least 3 orders. Tables: customers(id, name), orders(id, customer_id, created_at, total_amount).',
  },
  {
    id: 'analyst-abtest',
    domain: 'Analyst / A/B Test interpretation',
    prompt: 'We ran an A/B test for 2 weeks. Variant B is up 5% on conversion with p=0.06 and 50K users per arm. The PM wants to ship it. What do you recommend?',
  },
  {
    id: 'analyst-metrics',
    domain: 'Analyst / Metric Selection',
    prompt: 'Our team is launching a new search feature. What metrics would you propose tracking, and how would you tier them (north-star vs guardrail vs diagnostic)?',
  },
  {
    id: 'analyst-cohort',
    domain: 'Analyst / Cohort Investigation',
    prompt: 'Our 30-day retention dropped from 35% to 28% over the last quarter. How would you analyze the data to find what is driving it?',
  },
  // --- BEHAVIORAL + DOMAIN (kept from previous) ---
  {
    id: 'behavioral',
    domain: 'Behavioral / STAR-L',
    prompt: 'Tell me about a time you had a conflict with a teammate over a technical decision.',
  },
  {
    id: 'pm',
    domain: 'Product Management',
    prompt: 'How would you design a notifications feature for a mobile e-commerce app?',
  },
  {
    id: 'case',
    domain: 'Case / Strategy',
    prompt: 'A SaaS company has seen profits drop 20% in the last quarter. How would you investigate?',
  },
  {
    id: 'design',
    domain: 'Design / UX',
    prompt: 'Walk me through a hard design problem you solved recently.',
  },
  {
    id: 'sales',
    domain: 'Sales / Objection',
    prompt: 'A prospect says: "Your product is too expensive for what it does." How do you handle that objection?',
  },
  {
    id: 'exec',
    domain: 'Strategic / Executive',
    prompt: 'Where do you see your role/team in 3 years, and what would you optimize for?',
  },
  {
    id: 'estimate',
    domain: 'Quantitative / Estimate',
    prompt: 'Estimate how many ride-share rides happen in San Francisco on a typical weekday.',
  },
  // --- NEW CATEGORIES (not previously covered) ---
  {
    id: 'growth-marketing',
    domain: 'Marketing / Growth (AARRR)',
    prompt: 'Walk me through how you would investigate a sudden 30% drop in paid acquisition conversion rate, and what attribution method you would use to isolate the cause.',
  },
  {
    id: 'finance-dcf',
    domain: 'Finance / DCF',
    prompt: 'Walk me through a discounted cash flow valuation. Be ready to explain the terminal value, discount rate, and which assumption you would push back on hardest if a banker presented this to you.',
  },
  {
    id: 'people-mgmt',
    domain: 'People Management / Leadership',
    prompt: 'You have a senior engineer on your team who is technically excellent but consistently dismissive of junior engineers in code review. How do you handle this?',
  },
  {
    id: 'sre-incident',
    domain: 'SRE / Incident Response',
    prompt: 'You are on-call. You get paged: SLO is breached on the checkout service, error budget is 80% consumed for the month, and a feature ship is scheduled for tomorrow. Walk me through your decisions over the next hour.',
  },
  {
    id: 'cs-churn',
    domain: 'Customer Success / Churn',
    prompt: 'A $200K ARR account just told their CSM they are evaluating a competitor and considering not renewing in 90 days. What is your playbook?',
  },
];

const MODELS = [
  { name: 'gemini',  endpoint: '/api/v1/ai/chat/gemini',  shape: 'gemini'  },
  { name: 'openai',  endpoint: '/api/v1/ai/chat/openai',  shape: 'messages', model: 'gpt-5.5' },
  { name: 'xai',     endpoint: '/api/v1/ai/chat/xai',     shape: 'messages' },
  { name: 'groq',    endpoint: '/api/v1/ai/chat/groq',    shape: 'messages' },
  { name: 'claude',  endpoint: '/api/v1/ai/chat/claude',  shape: 'claude'   },
];

async function call(model, test) {
  const url = SERVER + model.endpoint;
  let body;
  if (model.shape === 'gemini') {
    body = { prompt: test.prompt, systemInstruction: SYSTEM, history: [], fileParts: [] };
  } else if (model.shape === 'claude') {
    body = {
      messages: [{ role: 'user', content: test.prompt }],
      systemInstruction: SYSTEM,
      enableWebSearch: false,  // disable for fair comparison vs other models
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
    const text = data.text || data.content || data.message || JSON.stringify(data).slice(0, 200);
    return { ok: true, text, took };
  } catch (err) {
    return { ok: false, error: err.message, took: Date.now() - t0 };
  }
}

async function main() {
  console.log(`Running ${TESTS.length} tests × ${MODELS.length} models = ${TESTS.length * MODELS.length} calls`);
  const results = {};
  for (const test of TESTS) {
    console.log(`\n[${test.id}] ${test.prompt}`);
    results[test.id] = { domain: test.domain, prompt: test.prompt, models: {} };
    // Run all 4 models in parallel for this question
    const calls = MODELS.map(m => call(m, test).then(r => [m.name, r]));
    const settled = await Promise.all(calls);
    for (const [name, result] of settled) {
      results[test.id].models[name] = result;
      console.log(`  ${name}: ${result.ok ? `OK (${result.took}ms, ${(result.text || '').length} chars)` : `FAIL ${result.status || ''} ${result.error?.slice(0, 100)}`}`);
    }
  }

  // ── Latency report — per-model + per-category breakdown ──
  // Computes min/avg/max so we can tell whether the new prompt rules
  // changed speed (the user's explicit constraint). Anything slower than
  // a 10% hit on average should trigger investigation.
  const latency = {};
  for (const m of MODELS) {
    const samples = [];
    for (const r of Object.values(results)) {
      const x = r.models[m.name];
      if (x.ok && Number.isFinite(x.took)) samples.push(x.took);
    }
    if (samples.length === 0) {
      latency[m.name] = { samples: 0 };
      continue;
    }
    samples.sort((a, b) => a - b);
    const sum = samples.reduce((a, b) => a + b, 0);
    latency[m.name] = {
      samples: samples.length,
      min: samples[0],
      p50: samples[Math.floor(samples.length / 2)],
      avg: Math.round(sum / samples.length),
      p95: samples[Math.floor(samples.length * 0.95)],
      max: samples[samples.length - 1],
    };
  }

  console.log('\n=== LATENCY SUMMARY ===');
  console.log('model'.padEnd(10), 'n'.padStart(4), 'min'.padStart(7), 'p50'.padStart(7), 'avg'.padStart(7), 'p95'.padStart(7), 'max'.padStart(7));
  for (const [name, l] of Object.entries(latency)) {
    if (l.samples === 0) { console.log(name.padEnd(10), '   0  (no samples)'); continue; }
    console.log(name.padEnd(10), String(l.samples).padStart(4),
      `${l.min}ms`.padStart(7), `${l.p50}ms`.padStart(7),
      `${l.avg}ms`.padStart(7), `${l.p95}ms`.padStart(7),
      `${l.max}ms`.padStart(7));
  }

  // Write markdown report
  const out = path.join(__dirname, '..', 'test-results.md');
  let md = `# Model comparison — ${new Date().toISOString()}\n\n`;

  // Latency table at top so it's easy to scan.
  md += `## Latency summary (per model, across all ${Object.keys(results).length} questions)\n\n`;
  md += `| model | samples | min | p50 | avg | p95 | max |\n`;
  md += `|---|---|---|---|---|---|---|\n`;
  for (const [name, l] of Object.entries(latency)) {
    if (l.samples === 0) { md += `| ${name} | 0 | — | — | — | — | — |\n`; continue; }
    md += `| ${name} | ${l.samples} | ${l.min}ms | ${l.p50}ms | ${l.avg}ms | ${l.p95}ms | ${l.max}ms |\n`;
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
  console.log(`\nReport written: ${out}`);
}

main().catch(err => { console.error(err); process.exit(1); });
