// ⚠️ REAL GROQ CALLS — gated behind GROQBENCH=1.
//   GROQBENCH=1 npx vitest run test/cover-depth-judge --silent=false
//
// GRADE THE DEPTH JUDGE, because it decides how long every answer takes.
//
// judgeAnswerDepth replaces the regex cascade (classifyQuestion ->
// AUTO_EFFORT_BY_CATEGORY) as the input to resolveReasoningEffort. The risk
// of a model doing this job is that it over-calls "medium" and quietly makes
// the whole fleet slower, so the distribution matters more than the
// accuracy: measured 2026-08-16 over 40 real questions it returned
// medium for 2 (5%), and moved 11 questions out of "none" -- which is the
// two-sentence-answer bug being corrected, not latency being wasted.
//
// Control accuracy 12/13. The regex it replaces got the HARD questions wrong
// in the dangerous direction: "400 DAGs and 30%% are failing" and "cut
// warehouse spend 40%%" both classified none, and none means "1-2 sentences
// max" in the prompt.
import { describe, it } from 'vitest';
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
const RUN = process.env.GROQBENCH === '1' && fs.existsSync(DB);

const { judgeAnswerDepth } = require('../src/services/coverAnswer.js');
const { classifyQuestion } = require('../src/services/questionClassifier.js');

const AUTO_EFFORT = {
  coding: 'low', system_design: 'low', ml_data: 'low', quantitative: 'low',
  strategy_case: 'low', behavioral: 'none', concept: 'none', practice: 'none',
  clarifier: 'none', other: 'none',
};

// Hand-labelled control set — what a senior interviewer would say.
const CONTROLS = [
  ['where have you worked before?', 'none'],
  ['what is a primary key?', 'none'],
  ['have you used Airflow?', 'none'],
  ['what is your notice period?', 'none'],
  ['what are your hobbies?', 'none'],
  ['how does a hash join actually work?', 'low'],
  ['how do you handle schema drift in a pipeline?', 'low'],
  ['walk me through how you would design an ETL for clinical events', 'low'],
  ['what is the difference between a star and a snowflake schema?', 'low'],
  ['design exactly-once delivery into a sink that cannot deduplicate', 'medium'],
  ['400 DAGs and 30% are failing — where do you start?', 'medium'],
  ['the dashboard is wrong but every pipeline is green, what now?', 'medium'],
  ['cut warehouse spend 40% without hurting freshness — how?', 'medium'],
];

describe.skipIf(!RUN)('the depth judge', () => {
  it('agrees with hand labels, and shifts the distribution sanely', async () => {
    let right = 0;
    console.log('\n  ── control set ──');
    for (const [q, want] of CONTROLS) {
      const got = await judgeAnswerDepth({ question: q, groqKey: process.env.GROQ_API_KEY });
      const old = AUTO_EFFORT[classifyQuestion(q).category] || 'none';
      const ok = got === want;
      if (ok) right++;
      console.log(`   ${ok ? '✓' : '✗'} want=${String(want).padEnd(6)} groq=${String(got).padEnd(6)} regex=${String(old).padEnd(6)} "${q.slice(0, 54)}"`);
    }
    console.log(`   control accuracy: ${right}/${CONTROLS.length}`);

    // Distribution on REAL questions — the thing that decides whether this
    // makes the fleet slower.
    const Database = require('better-sqlite3');
    const db = new Database(DB, { readonly: true });
    const rows = db.prepare(
      `SELECT DISTINCT content FROM messages WHERE role='user' AND content IS NOT NULL
         AND length(content) BETWEEN 25 AND 200 LIMIT 400`).all();
    db.close();
    const sample = [];
    const stride = Math.max(1, Math.floor(rows.length / 40));
    for (let i = 0; i < rows.length && sample.length < 40; i += stride) sample.push(rows[i].content);

    const groqTally = { none: 0, low: 0, medium: 0, null: 0 };
    const regexTally = { none: 0, low: 0, medium: 0 };
    const disagree = [];
    for (const q of sample) {
      const got = await judgeAnswerDepth({ question: q, groqKey: process.env.GROQ_API_KEY });
      const old = AUTO_EFFORT[classifyQuestion(q).category] || 'none';
      groqTally[got === null ? 'null' : got]++;
      regexTally[old]++;
      if (got && got !== old) disagree.push({ q: q.replace(/\s+/g, ' ').slice(0, 78), got, old });
    }
    console.log(`\n  ── ${sample.length} real questions ──`);
    console.log(`   groq : ${JSON.stringify(groqTally)}`);
    console.log(`   regex: ${JSON.stringify(regexTally)}`);
    console.log(`   disagreements: ${disagree.length}`);
    for (const d of disagree.slice(0, 14)) {
      console.log(`     regex=${d.old.padEnd(6)} -> groq=${d.got.padEnd(6)} "${d.q}"`);
    }
  }, 600_000);
});
