// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GRADE THE LOCAL OPENER AGAINST EVERY REAL QUESTION EVER ASKED.
//
//  The instant opener is deterministic — no model, no cost — so its whole
//  behaviour can be replayed over the app's own SQLite: every question a
//  real interviewer asked, against the resume really uploaded in that
//  session. That is the only honest way to change it.
//
//  Tuning it against a hand-written fixture does not work, and cost two
//  rounds of rework: a synthetic resume that listed Kafka only in an
//  experience bullet looked like a coverage gap, and closing it put
//  "...side of things - pipelines", "risk, at Philips mostly" and "in is
//  in there" into the candidate's mouth on the REAL corpus. Grade here
//  first, then write the regression test.
//
//  Reference point, 2026-08-07: 1,030 distinct real questions produced 149
//  spoken openers before the relevance work and ~96 after; `topic` went
//  57 -> 7. The ones that went away are questions no fact could open.
//
//  Skips when the app database is absent — it is one developer's machine,
//  not CI. Set COPILOT_DB to point somewhere else.
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

describe.skipIf(!HAVE_DB)('the opener, graded on every real question', () => {
  it('reports what it would say, by shape', () => {
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
      try { ledgers.set(sid, buildLedger(files)); } catch { /* unreadable upload */ }
    }

    const spoken = [];
    const tally = { speak: 0, defer: 0, suppress: 0, noLedger: 0 };
    const seen = new Set();
    for (const q of questions) {
      const ledger = ledgers.get(q.session_id);
      if (!ledger) { tally.noLedger++; continue; }
      let d;
      try { d = composeOpener(ledger, q.content); } catch { continue; }
      tally[d.kind] = (tally[d.kind] || 0) + 1;
      if (d.kind !== 'speak') continue;
      const key = `${q.content.trim().toLowerCase().slice(0, 55)}|${d.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      spoken.push({ q: q.content.replace(/\s+/g, ' ').trim().slice(0, 150), shape: d.shape, said: d.text });
    }

    const graded = tally.speak + tally.defer + tally.suppress;
    console.log(`\n  questions with a ledger : ${graded}  (skipped, no docs: ${tally.noLedger})`);
    console.log(`     speak ${tally.speak}   defer ${tally.defer}   suppress ${tally.suppress}`);
    console.log(`  distinct spoken openers : ${spoken.length}\n`);

    const byShape = new Map();
    for (const r of spoken) {
      if (!byShape.has(r.shape)) byShape.set(r.shape, []);
      byShape.get(r.shape).push(r);
    }
    for (const [shape, rows] of [...byShape.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`     ${shape.padEnd(12)} ${rows.length}`);
    }

    const show = process.env.OPENER_SHAPE;
    if (show) {
      console.log(`\n  -- every "${show}" opener --\n`);
      for (const r of (byShape.get(show) || [])) {
        console.log(`   Q: ${r.q.slice(0, 105)}`);
        console.log(`   A: "${r.said}"\n`);
      }
    }
  }, 300000);
});
