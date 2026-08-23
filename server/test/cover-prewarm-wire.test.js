// ⚠️ REAL GROQ CALLS — gated behind GROQBENCH=1.
//   GROQBENCH=1 npx vitest run test/cover-prewarm-wire --silent=false
//
// THE PREWARM RAIL, END TO END THROUGH THE REAL ROUTER.
//
// The cover used to be AWAITED in front of the main provider call, which is
// the single reason the whole feature sat frozen for four releases: a cover
// that failed, or that the guard rejected, bought the candidate nothing and
// delayed the answer by up to 4.5s.
//
// It now runs during the silence timer instead — dead time the app already
// spends waiting to auto-send. This proves the two halves actually meet:
//   1. /cover/prewarm writes a guarded line and judges the answer's depth
//   2. that line rides back as `instantOpener` and reaches the wire at 0ms,
//      while `coverEffort` sets the main model's reasoning dial.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';

const require = createRequire(import.meta.url);
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
process.env.JWT_SECRET = 'prewarm-secret';
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_EMAILS = 'pw@example.invalid';
process.env.OPENAI_API_KEY = 'sk-probe';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const RUN = process.env.GROQBENCH === '1';

const { buildLedger } = await import('../../services/factLedger.ts');
const { ledgerDigest, ledgerVocabulary } = await import('../../services/instantOpener.ts');

const RESUME = [
  'VENU MADHAV  Data Engineer | AWS Warehousing, Spark Pipelines',
  'TECHNICAL SKILLS',
  '●   AWS Data Platform:   S3, Glue, Redshift, EMR, Lambda, Athena, Kafka, Airflow, Snowflake',
  'PROFESSIONAL EXPERIENCE  Data Engineer   |   Siemens, Dallas, TX   |   April 2026 – Present',
  '●   Rebuilt the lakehouse ETL path and cut query latency ~40%.',
  'Data Engineer   |   Apollo Hospitals, Hyderabad, India   |   Sep 2022 – December 2023',
  '●   Owned Kafka and Python pipelines at 3M records a day.',
].join('  ');

const ledger = buildLedger([{ id: 'r', name: 'r.pdf', type: 'custom', content: RESUME }]);
let upstream, appServer, base, token, outbound = null;

function post(path, body) {
  const raw = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const frames = [];
    const rq = http.request(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(raw),
        'x-app-version': '4.0.22',
        Authorization: 'Bearer ' + token,
      },
    }, (res) => {
      res.on('data', (c) => frames.push(String(c)));
      res.on('end', () => resolve({ status: res.statusCode, body: frames.join(''), ms: Date.now() - started }));
    });
    rq.on('error', reject);
    rq.end(raw);
  });
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { outbound = JSON.parse(raw); } catch { outbound = { _raw: raw }; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'MAIN-ANSWER' } }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:' + upstream.address().port + '/v1';

  const express = require('express');
  const jwt = require('jsonwebtoken');
  const db = require('../src/database.js');
  const aiRouter = require('../src/routes/ai.js');
  const u = db.createUser({ id: 'pw-u', email: 'pw@example.invalid', name: 'P', password: 'x', tier: 'ultra', country_code: 'US' });
  db.createLicense({ key: 'K-PW', user_id: u.id, email: u.email, tier: 'ultra', status: 'active', country_code: 'US', expires_at: Date.now() + 8.64e7, sessions_limit: 9 });
  token = jwt.sign({ id: u.id, email: 'pw@example.invalid', tier: 'ultra' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/v1/ai', aiRouter);
  await new Promise((r) => { appServer = app.listen(0, r); });
  base = 'http://127.0.0.1:' + appServer.address().port;
});

afterAll(() => { try { upstream.close(); appServer.close(); } catch { /* ignore */ } });

const prewarmBody = (question, provider = 'openai') => ({
  question,
  provider,
  coverContext: ledgerDigest(ledger),
  coverVocabulary: ledgerVocabulary(ledger),
  recentTurns: '',
});

describe.skipIf(!RUN)('the prewarm rail', () => {
  it('writes a guarded line INSIDE the 1,200ms silence window', async () => {
    const q = 'Design exactly-once delivery into a sink that cannot deduplicate.';
    const r = await post('/api/v1/ai/cover/prewarm', prewarmBody(q));
    const out = JSON.parse(r.body);
    console.log(`\n   ready in ${r.ms}ms   depth=${out.effort}   words=${out.cover ? out.cover.split(/\s+/).length : 0}`);
    console.log(`   line: "${String(out.cover).slice(0, 190)}"`);
    expect(r.status).toBe(200);
    expect(out.cover, 'the prewarm must produce a line').not.toBe('');
    expect(r.ms, 'it has to be ready before the 1,200ms auto-send timer fires').toBeLessThan(1200);
  }, 60_000);

  it('judges a deep question deeper than a recall question', async () => {
    const deep = JSON.parse((await post('/api/v1/ai/cover/prewarm',
      prewarmBody('400 DAGs and 30% are failing. Where do you start?'))).body);
    const shallow = JSON.parse((await post('/api/v1/ai/cover/prewarm',
      prewarmBody('Which companies have you worked for so far?'))).body);
    console.log(`   deep=${deep.effort}  shallow=${shallow.effort}`);
    expect(['low', 'medium']).toContain(deep.effort);
    expect(shallow.effort).toBe('none');
  }, 60_000);

  it('sizes the SAME question by the route that will answer it', async () => {
    const q = 'Design exactly-once delivery into a sink that cannot deduplicate.';
    const onClaude = JSON.parse((await post('/api/v1/ai/cover/prewarm', prewarmBody(q, 'claude'))).body);
    const onGroq = JSON.parse((await post('/api/v1/ai/cover/prewarm', prewarmBody(q, 'groq'))).body);
    const w = (s) => (s ? s.split(/\s+/).filter(Boolean).length : 0);
    console.log(`   claude ${w(onClaude.cover)}w (fast route)   groq ${w(onGroq.cover)}w (10-50s route)`);
    // A 1.8s wait needs one line; a 25s wait needs a paragraph. Depth alone
    // cannot know that — the route is what decides how much to say.
    expect(w(onGroq.cover)).toBeGreaterThan(w(onClaude.cover));
  }, 60_000);

  it('the prewarmed line reaches the wire at 0ms and sets the effort dial', async () => {
    const q = 'Design exactly-once delivery into a sink that cannot deduplicate.';
    const pre = JSON.parse((await post('/api/v1/ai/cover/prewarm', prewarmBody(q))).body);
    outbound = null;
    const r = await post('/api/v1/ai/stream/openai', {
      messages: [
        { role: 'system', content: 'You are the candidate.' },
        { role: 'user', content: [{ type: 'text', text: `RULES <<<END RESPONSE RULES>>>\n\n---\n\n${q}` }] },
      ],
      reasoning_effort: 'auto',
      instantOpener: pre.cover,      // the prewarmed line rides the trusted rail
      coverEffort: pre.effort,       // and the depth verdict sets the dial
      coverPolicy: 'open',
      coverShape: 'prewarm',
      coverContext: ledgerDigest(ledger),
      coverVocabulary: ledgerVocabulary(ledger),
    });
    const sent = String(outbound && JSON.stringify(outbound));
    console.log(`   streamed head: "${r.body.slice(0, 120).replace(/\n/g, ' ')}"`);
    console.log(`   main model reasoning_effort = ${outbound && outbound.reasoning_effort}`);
    expect(r.body, 'the prewarmed line must be the first thing on the wire')
      .toContain(pre.cover.slice(0, 40));
    expect(r.body).toContain('MAIN-ANSWER');
    // The main model is told to CONTINUE from it rather than restate it.
    expect(sent, 'the chosen model must receive the opening it is continuing')
      .toContain(pre.cover.slice(0, 30));
    expect(outbound.reasoning_effort).toBe(pre.effort);
  }, 60_000);
});
