// ⚠️ REAL GROQ CALLS — gated behind GROQBENCH=1.
//   GROQBENCH=1 npx vitest run test/cover-model-bench --silent=false
//
// Which Groq model should write the cover? Throughput tables are the wrong
// input: a cover is 40 tokens (opener) to 250 (holding), so TIME TO FIRST
// TOKEN dominates and tokens/sec barely registers until the holding tier.
// And the gpt-oss family THINKS before it speaks, which is paid entirely in
// TTFT. So: run the REAL cover prompt and time the real thing.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const DB = path.join(os.homedir(), 'AppData', 'Roaming', 'interview-copilot-ai', 'copilot.db');
const RUN = process.env.GROQBENCH === '1';

const { buildLedger } = await import('../../services/factLedger.ts');
const { ledgerDigest } = await import('../../services/instantOpener.ts');
const { COVER_SYSTEM, userPrompt, COVER_TIERS } = require('../src/services/coverAnswer.js');

// reasoning: gpt-oss accepts reasoning_effort; llama ignores it entirely.
const CANDIDATES = [
  { model: 'llama-3.3-70b-versatile', label: 'llama-3.3-70b (CURRENT, deprecating)' },
  { model: 'llama-3.1-8b-instant', label: 'llama-3.1-8b-instant (deprecating)' },
  { model: 'openai/gpt-oss-20b', reasoning_effort: 'low', label: 'gpt-oss-20b  reasoning=low' },
  { model: 'openai/gpt-oss-120b', reasoning_effort: 'low', label: 'gpt-oss-120b reasoning=low' },
  { model: 'openai/gpt-oss-20b', reasoning_effort: 'none', label: 'gpt-oss-20b  reasoning=none' },
];

const QUESTIONS = [
  ['what are your hobbies?', 'other'],
  ['Design exactly-once delivery into a sink that cannot deduplicate.', 'system_design'],
  ['400 DAGs and 30% are failing. Where do you start?', 'system_design'],
];

describe.skipIf(!RUN)('which Groq model writes the cover', () => {
  it('TTFT and total on the real cover prompt', async () => {
    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY, maxRetries: 0, timeout: 20000 });

    // Pick the first document that yields a SUBSTANTIAL digest. Taking the
    // longest file gave a 23-char digest — a doc whose ledger extracts
    // nothing — which silently benchmarks the empty-background path.
    let digest = '';
    if (fs.existsSync(DB)) {
      const Database = require('better-sqlite3');
      const db = new Database(DB, { readonly: true });
      const rows = db.prepare(
        `SELECT content FROM context_files WHERE content IS NOT NULL
           AND length(content) BETWEEN 3000 AND 20000 ORDER BY length(content) DESC LIMIT 40`).all();
      db.close();
      for (const r of rows) {
        try {
          const d = ledgerDigest(buildLedger([{ id: 'r', name: 'r.pdf', type: 'custom', content: r.content }]));
          if (d.length > 800) { digest = d; break; }
        } catch { /* unreadable */ }
      }
    }
    console.log(`\n  digest ${digest.length} chars; system prompt ${COVER_SYSTEM.length} chars\n`);

    for (const tierIdx of [0, 2]) {
      const plan = COVER_TIERS[tierIdx];
      console.log(`\n══════ ${plan.name.toUpperCase()} tier (${plan.minWords}-${plan.maxWords} words, max_tokens ${plan.maxTokens}) ══════`);
      console.log('  model                                  TTFT     total    tok/s   words  first words');
      for (const c of CANDIDATES) {
        const ttfts = [];
        const totals = [];
        let sample = '';
        let toks = 0;
        let failed = '';
        for (const [q, cat] of QUESTIONS) {
          const t0 = Date.now();
          let first = 0;
          let text = '';
          let n = 0;
          try {
            const body = {
              model: c.model,
              messages: [
                { role: 'system', content: COVER_SYSTEM },
                { role: 'user', content: userPrompt(q, cat, digest, plan, '') },
              ],
              max_tokens: plan.maxTokens,
              temperature: 0.7,
              stream: true,
            };
            if (c.reasoning_effort) body.reasoning_effort = c.reasoning_effort;
            const stream = await groq.chat.completions.create(body);
            for await (const ch of stream) {
              const t = ch?.choices?.[0]?.delta?.content;
              if (t) { if (!first) first = Date.now() - t0; text += t; n++; }
            }
          } catch (e) {
            failed = String(e && e.message || e).slice(0, 60);
            break;
          }
          if (first) ttfts.push(first);
          totals.push(Date.now() - t0);
          toks += n;
          if (!sample) sample = text.replace(/\s+/g, ' ').trim();
        }
        if (failed) { console.log(`  ${c.label.padEnd(38)} FAILED: ${failed}`); continue; }
        const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
        const mt = med(totals);
        const rate = mt ? Math.round((toks / QUESTIONS.length) / (mt / 1000)) : 0;
        console.log(
          `  ${c.label.padEnd(38)} ${String(med(ttfts) + 'ms').padStart(7)}  ${String(mt + 'ms').padStart(7)}`
          + `  ${String(rate).padStart(5)}  ${String(sample.split(/\s+/).length).padStart(5)}  "${sample.slice(0, 130)}"`
        );
      }
    }
  }, 600_000);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE INVARIANT, ASSERTED WITHOUT SPENDING A CALL.
//
//  The benchmark above needs GROQBENCH=1 and real money, so it does not
//  run in CI or on `npm test`. What MUST hold on every commit is the one
//  setting whose absence is invisible: gpt-oss THINKS before it answers,
//  and thinking is paid in time-to-first-token. Measured on this exact
//  prompt, reasoning_effort 'medium' emitted ZERO content tokens and
//  burned 589-652ms — a cover that fails silently and delays the answer,
//  the one outcome this feature exists to prevent. 'none' is rejected by
//  the API (400: must be one of low/medium/high), so 'low' is the floor.
//
//  Source-asserted rather than executed, for the same reason
//  transcription-latency.test.js asserts the Deepgram query string: a unit
//  test should not open a paid provider connection to prove a constant.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('the Groq cover model is pinned with its reasoning floor', () => {
  const SRC = fs.readFileSync(new URL('../src/services/coverAnswer.js', import.meta.url), 'utf8');
  const start = SRC.indexOf('function groqCoverFactory');
  const factory = SRC.slice(start, SRC.indexOf('\n}', start) + 2);
  // Comments stripped: the block above the call deliberately QUOTES the
  // models it rejected, with their measured numbers, and a naive substring
  // check reads that table as the code still using them.
  const code = factory.replace(/^\s*\/\/.*$/gm, '');

  it('uses gpt-oss-20b, not a model on the deprecation path', () => {
    expect(code).toContain("model: 'openai/gpt-oss-20b'");
    expect(code, 'llama-3.3-70b is deprecating and measured slower').not.toContain('llama-3.3-70b');
    expect(code, 'llama-3.1-8b-instant under-runs the word budget').not.toContain('llama-3.1-8b');
  });

  it("sets reasoning_effort 'low' — without it the cover emits nothing", () => {
    expect(
      factory,
      "gpt-oss without reasoning_effort:'low' spends the whole cover budget thinking and streams no content"
    ).toMatch(/reasoning_effort:\s*'low'/);
  });

  it('reads only delta.content, so reasoning tokens can never be spoken', () => {
    expect(factory).toContain('delta?.content');
    expect(factory, 'a reasoning field must never reach the candidate').not.toContain('delta?.reasoning');
  });
});
