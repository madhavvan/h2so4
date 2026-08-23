// ⚠️ COSTS REAL MODEL CALLS — gated behind COVERDRILL=1.
//   COVERDRILL=1 npx vitest run test/cover-live-corpus --silent=false
//   COVER_PROVIDER=xai COVER_N=12 ... to vary the route and the sample
//
// THE MEASUREMENT THAT ARMED THE LLM COVER.
//
// LLM_COVER_MIN_CLIENT sat one release ahead of the shipped build from
// 2026-08-08 to 2026-08-16 with a documented re-arm condition: "once the
// cover has been measured end-to-end against live traffic (its own TTFT, its
// guard-rejection rate, and the main answer's TTFT behind it)."
//
// Waiting for LIVE traffic is what kept it dormant for four releases, and it
// was never necessary: every input is available offline. The real questions
// are in the app's SQLite, the real resumes are in the same rows, and the
// cover chain and guard are pure server code. This replays the questions
// that get NO local opener — the hole — through the real providers and the
// real guard.
//
// Result 2026-08-16 on groq, 24 real deferred questions:
//   cover TTFT median 1,119ms, total median 1,858ms — inside COVER_FLOOR_MS
//   guard rejection 29.2% BEFORE the guard fixes, 12.5% after
// The rejections were almost all correct sentences discarded over terms of
// the trade; see test/cover-guard-terms.test.js for what that turned into.
//
// Re-run this after ANY change to COVER_SYSTEM, the tier table, the provider
// chain or the guard. It is the only harness that exercises all four at once
// against inputs nobody wrote for it.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The APP's package.json, not the server's. process.cwd() is server/ when
// vitest runs here, and server/package.json is version 1.0.0 — reading that
// silently compared the version gate against the wrong number entirely.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

const DB = process.env.COPILOT_DB
  || path.join(os.homedir(), 'AppData', 'Roaming', 'interview-copilot-ai', 'copilot.db');
const RUN = process.env.COVERDRILL === '1' && fs.existsSync(DB);

const { buildLedger } = await import('../../services/factLedger.ts');
const { composeOpener, ledgerDigest, ledgerVocabulary } = await import('../../services/instantOpener.ts');
const { classifyQuestion } = require('../src/services/questionClassifier.js');
const { streamCoverAnswer, planCoverFor } = require('../src/services/coverAnswer.js');
const { unverifiedProperNouns, hasBannedOpener, unverifiedNumbers } = require('../src/services/groundingGuard.js');

// ── THE ARMED PATH, THROUGH runCover ITSELF ──
//
// Everything else in this file exercises streamCoverAnswer directly, which
// is one layer BELOW the version gate — so it would have gone on passing
// happily for the entire eight days the feature was switched off. This one
// goes through routes/ai.js runCover with a request shaped exactly like a
// real one: the shipping app version in the header, no instantOpener (the
// client deferred), and a real deferred question.
//
// Before 2026-08-16 this returned '' and streamed nothing, for every user,
// on every question the local opener could not answer.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'covertest';
process.env.DATABASE_PATH = ':memory:';
delete process.env.OPENAI_BASE_URL;

const AUTO_EFFORT = {
  coding: 'low', system_design: 'low', ml_data: 'low', quantitative: 'low',
  strategy_case: 'low', behavioral: 'none', concept: 'none', practice: 'none',
  clarifier: 'none', other: 'none',
};
const DEEP = new Set(Object.entries(AUTO_EFFORT).filter(([, v]) => v !== 'none').map(([k]) => k));

const PROVIDER = process.env.COVER_PROVIDER || 'groq';
const LIMIT = Number(process.env.COVER_N || 24);

describe.skipIf(!RUN)('the LLM cover, measured against the real corpus', () => {
  it(`TTFT + guard-rejection rate on ${PROVIDER}`, async () => {
    const Database = require('better-sqlite3');
    const db = new Database(DB, { readonly: true, fileMustExist: true });
    const docs = db.prepare(
      `SELECT name, content, session_id FROM context_files
        WHERE content IS NOT NULL AND length(content) > 200`).all();
    const questions = db.prepare(
      `SELECT content, session_id FROM messages
        WHERE role='user' AND content IS NOT NULL AND length(content) BETWEEN 20 AND 240`).all();
    db.close();

    const bySession = new Map();
    for (const d of docs) {
      if (!bySession.has(d.session_id)) bySession.set(d.session_id, []);
      bySession.get(d.session_id).push({ id: d.name, name: d.name, type: 'custom', content: d.content });
    }
    const ledgers = new Map();
    for (const [sid, files] of bySession) {
      try { ledgers.set(sid, buildLedger(files)); } catch { /* unreadable */ }
    }

    // The hole: real questions, with a real resume, that get NO local opener.
    const pool = [];
    const seen = new Set();
    for (const q of questions) {
      const ledger = ledgers.get(q.session_id);
      if (!ledger) continue;
      let d;
      try { d = composeOpener(ledger, q.content); } catch { continue; }
      if (d.kind !== 'defer') continue;
      const text = q.content.replace(/\s+/g, ' ').trim();
      const key = text.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      const { category } = classifyQuestion(text);
      pool.push({ text, category, ledger, deep: DEEP.has(category) });
    }
    // Weight toward the deep questions — that is where the silence is.
    pool.sort((a, b) => (b.deep ? 1 : 0) - (a.deep ? 1 : 0));
    const sample = [];
    for (let i = 0; i < pool.length && sample.length < LIMIT; i += Math.max(1, Math.floor(pool.length / LIMIT))) {
      sample.push(pool[i]);
    }

    console.log(`\n  deferred questions available: ${pool.length}   sampling ${sample.length} on ${PROVIDER}\n`);

    const res = { ok: 0, rejected: 0, none: 0, ttft: [], total: [], reasons: [] };
    for (const q of sample) {
      const effort = AUTO_EFFORT[q.category] || 'none';
      const { gapMs, plan } = planCoverFor({ provider: PROVIDER, deep: q.deep, effort, webSearch: false });
      if (!plan) { res.none++; continue; }
      const digest = ledgerDigest(q.ledger);
      const vocab = ledgerVocabulary(q.ledger);
      const t0 = Date.now();
      let firstAt = 0;
      let cover = '';
      try {
        cover = await streamCoverAnswer({
          question: q.text,
          category: q.category,
          candidateContext: digest,
          recentTurns: '',
          plan,
          groqKey: process.env.GROQ_API_KEY,
          geminiKey: process.env.GEMINI_API_KEY,
          anthropicKey: process.env.ANTHROPIC_API_KEY,
          onToken: () => { if (!firstAt) firstAt = Date.now() - t0; },
          signal: undefined,
        });
      } catch (e) {
        res.none++;
        res.reasons.push(`THREW: ${String(e && e.message).slice(0, 80)}`);
        continue;
      }
      const total = Date.now() - t0;
      if (!cover) {
        res.none++;
        console.log(`  ✗ NO COVER  (${total}ms)  tier=${plan.name} gap=${gapMs}  q="${q.text.slice(0, 70)}"`);
        continue;
      }
      const allowed = q.text;
      const banned = hasBannedOpener(cover);
      const invented = unverifiedProperNouns(vocab.trim() ? vocab : allowed, cover, allowed);
      const nums = unverifiedNumbers(digest, cover, allowed);
      const verdict = banned ? `banned:${banned}`
        : invented.length ? `invented:[${invented.join(', ')}]`
        : nums.length ? `numbers:[${nums.join(', ')}]` : '';
      res.ttft.push(firstAt); res.total.push(total);
      if (verdict) {
        res.rejected++; res.reasons.push(verdict);
        console.log(`  ⛔ REJECT  ttft=${firstAt}ms total=${total}ms tier=${plan.name} ${verdict}`);
        console.log(`             q="${q.text.slice(0, 80)}"`);
        console.log(`             said="${cover.slice(0, 150)}"`);
      } else {
        res.ok++;
        console.log(`  ✓ SPEAK   ttft=${firstAt}ms total=${total}ms tier=${plan.name} words=${cover.split(/\s+/).length}`);
        console.log(`             q="${q.text.slice(0, 80)}"`);
        console.log(`             said="${cover.slice(0, 150)}"`);
      }
    }

    const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
    const fired = res.ok + res.rejected;
    console.log(`\n  ══ ${PROVIDER.toUpperCase()} ══`);
    console.log(`  spoken            : ${res.ok}`);
    console.log(`  GUARD-REJECTED    : ${res.rejected}  (${fired ? (res.rejected / fired * 100).toFixed(1) : 0}% of covers that generated)`);
    console.log(`  no cover produced : ${res.none}`);
    console.log(`  cover TTFT        : median ${med(res.ttft)}ms   max ${Math.max(0, ...res.ttft)}ms`);
    console.log(`  cover TOTAL       : median ${med(res.total)}ms  max ${Math.max(0, ...res.total)}ms`);
    if (res.reasons.length) {
      const tally = {};
      for (const r of res.reasons) { const k = r.split(':')[0]; tally[k] = (tally[k] || 0) + 1; }
      console.log(`  rejection reasons : ${JSON.stringify(tally)}`);
    }
  }, 600_000);
});

describe.skipIf(!RUN)('the armed path, end to end through runCover', () => {
  it('a shipping client with no local opener now gets a spoken cover', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const { _test } = require('../src/routes/ai.js');

    // A real ledger, so coverContext/coverVocabulary look like a real request.
    const Database = require('better-sqlite3');
    const db = new Database(DB, { readonly: true, fileMustExist: true });
    const row = db.prepare(
      `SELECT content FROM context_files WHERE content IS NOT NULL
         AND length(content) > 2000 ORDER BY length(content) DESC LIMIT 1`).get();
    db.close();
    const ledger = buildLedger([{ id: 'r', name: 'resume.pdf', type: 'custom', content: row.content }]);

    const question = 'Design exactly-once delivery into a sink that cannot deduplicate.';
    const sent = [];
    const req = {
      user: { id: 'armed-1', email: 'user@example.invalid' },
      headers: { 'x-app-version': pkg.version },
      body: {
        instantOpener: '',              // the client deferred — this IS the hole
        coverPolicy: 'defer',
        coverShape: 'unknown',
        coverContext: ledgerDigest(ledger),
        coverVocabulary: ledgerVocabulary(ledger),
        recentTurns: '',
      },
    };
    const out = await _test.runCover({
      sse: { send: (t) => sent.push(t), signal: undefined },
      req,
      question,
      provider: 'groq',
    });

    console.log(`\n  client version : ${pkg.version}`);
    console.log(`  gate open      : ${_test.clientAtLeastLlmCover(req)}`);
    console.log(`  cover returned : ${out ? `${out.split(/\s+/).length} words` : 'NOTHING'}`);
    console.log(`  streamed       : ${sent.length} frame(s)`);
    if (out) console.log(`  said           : "${out.slice(0, 220)}"`);

    expect(_test.clientAtLeastLlmCover(req), 'the shipping build must be past the gate').toBe(true);
    expect(out, 'the armed cover must produce spoken words for a deferred question').not.toBe('');
    expect(sent.join('').length, 'the cover must actually reach the wire').toBeGreaterThan(0);
  }, 60_000);
});
