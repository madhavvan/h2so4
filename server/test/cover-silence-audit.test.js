// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  HOW LONG DOES A REAL USER SIT IN SILENCE?
//
//  The companion to opener-corpus.test.js. That one reports WHAT the local
//  opener would say; this one reports what happens to everything it does
//  NOT say — by joining each real question to the answer latency its route
//  is predicted to have. Same method: replay the app's own SQLite, every
//  question a real interviewer asked against the resume really uploaded in
//  that session. No model calls, no cost.
//
//  Reference point, 2026-08-16, with the LLM cover dormant: of 1,730 real
//  questions the local opener spoke on 143. The other 1,587 got nothing at
//  all — and on groq and xai 91.7% of those sat past COVER_FLOOR_MS, with
//  an average predicted gap of 24.8s and 10.8s and a worst case of 50s and
//  20s. Every deep category (ml_data 151, system_design 98, coding 6)
//  deferred, which is the shape that matters: the opener fires on identity
//  questions, which are on the fast routes anyway, and stays quiet on the
//  engineering questions, which are the slow ones.
//
//  That is the measurement that justified arming LLM_COVER_MIN_CLIENT.
//  Re-run it before changing the floor, the tier table, or the opener's
//  defer rules — those three decide the whole number between them.
//
//  Skips when the app database is absent — one developer's machine, not
//  CI. Set COPILOT_DB to point somewhere else.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const DB = process.env.COPILOT_DB
  || path.join(os.homedir(), 'AppData', 'Roaming', 'interview-copilot-ai', 'copilot.db');
const HAVE_DB = fs.existsSync(DB);

const { buildLedger } = await import('../../services/factLedger.ts');
const { composeOpener } = await import('../../services/instantOpener.ts');
const { classifyQuestion } = require('../src/services/questionClassifier.js');
const { planCoverFor } = require('../src/services/coverAnswer.js');

// Mirror of AUTO_EFFORT_BY_CATEGORY in routes/ai.js (importing the route
// needs a live DB; this map is small and pinned by that file's own tests).
const AUTO_EFFORT_BY_CATEGORY = {
  coding: 'low', system_design: 'low', ml_data: 'low', quantitative: 'low',
  strategy_case: 'low', behavioral: 'none', concept: 'none', practice: 'none',
  clarifier: 'none', other: 'none',
};

const DEEP = new Set(Object.entries(AUTO_EFFORT_BY_CATEGORY).filter(([, v]) => v !== 'none').map(([k]) => k));

describe.skipIf(!HAVE_DB)('the hole', () => {
  it('how long do users sit in silence, by whether an opener fired', () => {
    const Database = require('better-sqlite3');
    const db = new Database(DB, { readonly: true, fileMustExist: true });
    const docs = db.prepare(
      `SELECT name, content, session_id FROM context_files
        WHERE content IS NOT NULL AND length(content) > 200`).all();
    const questions = db.prepare(
      `SELECT content, session_id FROM messages
        WHERE role='user' AND content IS NOT NULL AND length(content) BETWEEN 12 AND 240`).all();
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

    // What a real user actually runs on. Default model + the auto effort dial.
    for (const provider of ['openai', 'xai', 'groq', 'gemini', 'claude']) {
      const rows = { covered: [], silent: [] };
      const byCat = new Map();
      for (const q of questions) {
        const ledger = ledgers.get(q.session_id);
        let d = { kind: 'defer', shape: 'no-ledger' };
        if (ledger) { try { d = composeOpener(ledger, q.content); } catch { /* keep defer */ } }
        const { category } = classifyQuestion(q.content);
        const deep = DEEP.has(category);
        const effort = AUTO_EFFORT_BY_CATEGORY[category] || 'none';
        const { gapMs } = planCoverFor({ provider, deep, effort, webSearch: false });
        (d.kind === 'speak' ? rows.covered : rows.silent).push(gapMs);
        if (d.kind !== 'speak') {
          const k = `${category}${deep ? ' (deep)' : ''}`;
          if (!byCat.has(k)) byCat.set(k, { n: 0, gap: gapMs });
          byCat.get(k).n++;
        }
      }
      const avg = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0);
      const worst = (a) => (a.length ? Math.max(...a) : 0);
      const overFloor = rows.silent.filter((g) => g > 2500).length;
      console.log(`\n─── ${provider.toUpperCase()} ───`);
      console.log(`  opener fired : ${rows.covered.length}   avg predicted gap ${avg(rows.covered)}ms`);
      console.log(`  SILENT       : ${rows.silent.length}   avg predicted gap ${avg(rows.silent)}ms  worst ${worst(rows.silent)}ms`);
      console.log(`  silent AND over the 2500ms cover floor: ${overFloor}  (${(overFloor / questions.length * 100).toFixed(1)}% of all questions)`);
      if (provider === 'openai') {
        console.log('  top silent categories:');
        [...byCat.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10)
          .forEach(([k, v]) => console.log(`     ${k.padEnd(28)} ${String(v.n).padStart(4)}   gap ${v.gap}ms`));
      }
    }
  });
});
