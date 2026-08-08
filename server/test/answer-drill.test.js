// ⚠️ COSTS REAL MODEL CALLS — gated behind DRILL=1, so it never runs in
// the normal suite. Run it with:  DRILL=1 npx vitest run test/answer-drill
//
// The multi-turn drill. Replays the exact three-turn
// hallucination exchange through the REAL rules block and the REAL model,
// with history accumulating exactly as it does in the app.
//
// The defect only appears on turns 2 and 3, so a single-answer test cannot
// see it. That is the whole point of this harness.
import { describe, it, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
// The suite below is gated on DRILL=1, but THIS runs at module scope — so
// it ran even when the drill did not. `.env` is gitignored, so on any
// machine without one (every CI runner, every fresh clone) the readFileSync
// threw during collection and took the whole `npm test` step down with it:
// a real-API harness nobody asked to run failed the build for everyone.
// Missing keys are fine here — without DRILL=1 nothing reads them, and
// with DRILL=1 the absence surfaces as an auth error from the provider,
// which is a far clearer signal than ENOENT on a file you did not know
// this test wanted.
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
process.env.JWT_SECRET = 'drill';
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_EMAILS = 'd@example.invalid';
delete process.env.OPENAI_BASE_URL;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const { buildLedger } = await import('../../services/factLedger.ts');
const { ledgerDigest } = await import('../../services/instantOpener.ts');
const { buildUserRulesBlock } = await import('../../services/aiProxyService.ts');

let appServer, base, token, digest;

beforeAll(async () => {
  const Database = require('better-sqlite3');
  const rdb = new Database('C:/Users/penta/AppData/Roaming/interview-copilot-ai/copilot.db', { readonly: true });
  const row = rdb.prepare(`SELECT name,content FROM context_files WHERE length(content) BETWEEN 6000 AND 12000 AND content LIKE '%PROFESSIONAL EXPERIENCE%' ORDER BY length(content) DESC LIMIT 1`).get();
  rdb.close();
  digest = ledgerDigest(buildLedger([{ id: 'r', name: row.name, type: 'custom', content: row.content }]));

  const express = require('express');
  const jwt = require('jsonwebtoken');
  const db = require('../src/database.js');
  const aiRouter = require('../src/routes/ai.js');
  const u = db.createUser({ id: 'd-u', email: 'd@example.invalid', name: 'D', password: 'x', tier: 'ultra', country_code: 'US' });
  db.createLicense({ key: 'KD', user_id: u.id, email: u.email, tier: 'ultra', status: 'active', country_code: 'US', expires_at: Date.now() + 8.64e7, sessions_limit: 9 });
  token = jwt.sign({ id: u.id, email: u.email, tier: 'ultra' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/v1/ai', aiRouter);
  await new Promise((r) => { appServer = app.listen(0, r); });
  base = 'http://127.0.0.1:' + appServer.address().port;
}, 180000);
afterAll(() => { try { appServer.close(); } catch { /* ignore */ } });

const SYS = 'You are the candidate in a live job interview.\n\nCANDIDATE BACKGROUND:\n';

function ask(question, history) {
  const rules = buildUserRulesBlock();
  const messages = [{ role: 'system', content: SYS + digest }];
  for (const h of history) {
    messages.push({ role: 'user', content: [{ type: 'text', text: h.q }] });
    messages.push({ role: 'assistant', content: h.a });
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: `${rules}\n\n---\n\n${question}` }] });
  const body = JSON.stringify({ messages, reasoning_effort: 'none', coverPolicy: 'defer', instantOpener: '', coverContext: digest, coverVocabulary: '' });
  return new Promise((resolve) => {
    const frames = [];
    const rq = http.request(base + '/api/v1/ai/stream/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: 'Bearer ' + token, 'x-cover-disabled': '1' },
    }, (res) => {
      res.on('data', (c) => frames.push(String(c)));
      res.on('end', () => resolve(frames.join('').split('\n')
        .filter((l) => l.startsWith('data:') && !l.includes('[DONE]'))
        .map((l) => { try { return JSON.parse(l.slice(5)).t || ''; } catch { return ''; } }).join('')));
    });
    rq.on('error', () => resolve(''));
    rq.setTimeout(120000, () => { try { rq.destroy(); } catch { /* ignore */ } });
    rq.write(body); rq.end();
  });
}

// The exact exchange, verbatim.
const TURNS = [
  'how do you handle the hallucinations?',
  'how do you handle the contextual handling? when the model is getting hallucinated? and for the last question, did you understand the question I asked? I asked how do you handle the hallucinations?',
  'so by this you are saying that human in the loop is needed, right? But my question is, even without validating through schema and without the human, how can you actually control the model hallucinations? let it be a conversation.',
];

// The mechanisms the FIRST answer establishes. Repeating them on later
// turns is the defect; naming something new is the fix.
const ESTABLISHED = [
  [/ground(ing|ed)?\b.*evidence|retriev/i, 'grounding/retrieval'],
  [/schema/i, 'schema validation'],
  [/human|engineer checks|in the loop/i, 'human in the loop'],
  [/citation/i, 'citations'],
];
// The tier that answers "without schema, without a human".
const ADVANCED = [
  [/self-?consisten|sample.*(twice|multiple|n times)|disagree.*sample/i, 'self-consistency'],
  [/entail|nli|faithful/i, 'entailment/faithfulness check'],
  [/judge/i, 'LLM-as-judge'],
  [/temperature|greedy|constrained decod|logprob|log-?prob|entropy|calibrat/i, 'decoding/uncertainty control'],
  [/verifier|second model|cross-?check/i, 'verifier model'],
];

const hits = (text, table) => table.filter(([re]) => re.test(text)).map(([, n]) => n);
const firstSentence = (s) => (String(s).replace(/\s+/g, ' ').match(/^.{0,240}?[.?!](\s|$)/) || [String(s).slice(0, 240)])[0].trim();

describe.skipIf(!process.env.DRILL)('THE MULTI-TURN DRILL', () => {
  it('does each turn advance, or restate?', async () => {
    const history = [];
    const answers = [];
    for (let i = 0; i < TURNS.length; i++) {
      const a = await ask(TURNS[i], history);
      history.push({ q: TURNS[i], a });
      answers.push(a);
      console.log(`\n${'═'.repeat(74)}\nTURN ${i + 1}: ${TURNS[i].slice(0, 90)}\n${'═'.repeat(74)}`);
      console.log(`  FIRST SENTENCE: "${firstSentence(a)}"`);
      console.log(`  established-tier mentions : ${hits(a, ESTABLISHED).join(', ') || '(none)'}`);
      console.log(`  ADVANCED-tier mentions    : ${hits(a, ADVANCED).join(', ') || '(NONE)'}`);
      console.log(`  full: ${a.replace(/\s+/g, ' ').slice(0, 460)}`);
    }

    console.log(`\n${'═'.repeat(74)}\nSCORECARD\n${'═'.repeat(74)}`);
    const t3 = answers[2] || '';
    const t3first = firstSentence(t3);
    // "Without schema checks or a person, I'd do Y" is the CORRECT move —
    // it names the constraint and then answers inside it. The defect is
    // OFFERING the excluded mechanism as the answer. So strip any
    // without/absent/aside clause before looking.
    const t3offered = t3first
      .replace(/\b(?:even\s+)?(?:without|absent|lacking|no)\b[^,.;]*[,.;]?/gi, ' ')
      .replace(/\bsetting\s+\w+\s+aside\b/gi, ' ')
      .replace(/\bcan'?t\s+(?:use|rely on|guarantee)\b[^,.;]*/gi, ' ');
    const excluded = /schema/i.test(t3offered) || /\bhuman\b|\bperson\b/i.test(t3offered);
    console.log(`  T3 OFFERS an excluded mechanism as the answer: ${excluded ? 'YES  <- the defect' : 'no'}`);
    console.log(`     (after stripping the "without …" clause: "${t3offered.replace(/\s+/g, ' ').trim().slice(0, 110)}")`);
    const newInT3 = hits(t3, ADVANCED);
    console.log(`  T3 reaches the advanced tier: ${newInT3.length ? 'YES — ' + newInT3.join(', ') : 'NO  <- the defect'}`);
    const repeated = hits(t3, ESTABLISHED);
    console.log(`  T3 still repeats established tier: ${repeated.join(', ') || '(none)'}`);
  }, 900000);
});
