// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  END TO END, OVER REAL HTTP, THROUGH THE REAL ROUTER
//
//  Renderer body -> /api/v1/ai/stream/openai -> the real OpenAI SDK -> a
//  local stand-in for api.openai.com that records the outbound request.
//  Nothing is stubbed inside the app: the middleware chain, the context
//  store, the cover path and the continuation are all the shipping code.
//
//  Four claims are asserted here, and each one is a defect from the
//  2026-07-29 session:
//    1. the locally composed opener reaches the user, and no cover model is
//       called, so the main answer is not delayed by the 1,200-3,000ms the
//       cover chain used to add
//    2. the opener is handed to the main model as a continuation, so the
//       answer reads as one piece
//    3. `coverPolicy: 'suppress'` produces NO opener from anyone — the fix
//       for "then why did you answer IBM?" -> "…at Accenture"
//    4. a client disconnect actually aborts the upstream stream
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_EMAILS = 'wire@example.invalid';
process.env.OPENAI_API_KEY = 'sk-probe';
delete process.env.BRAVE_API_KEY;
// No cover-provider keys: if the route ever tried to call one, the chain
// would find zero providers and return '' — so any opener that shows up in
// the stream provably came from the client, not from a model.
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const require = createRequire(import.meta.url);
const { buildLedger } = await import('../../services/factLedger.ts');
const { composeOpener, ledgerDigest, ledgerVocabulary } = await import('../../services/instantOpener.ts');

const RESUME = [
  'VENU MADHAV  Data Engineer | AWS Warehousing, Spark Pipelines',
  'TECHNICAL SKILLS',
  '●   AWS Data Platform:   S3, Glue, Redshift, EMR, Lambda, Athena',
  'PROFESSIONAL EXPERIENCE  Data Engineer   |   Siemens, Dallas, TX   |   April 2026 – Present',
  '●   Rebuilt the lakehouse ETL path and cut query latency ~40%.',
  'Data Engineer   |   Apollo Hospitals, Hyderabad, India   |   Sep 2022 – December 2023',
  '●   Owned Kafka and Python pipelines at 3M records a day.',
  'Data Engineer   |   KIMS Hospitals, Hyderabad, India   |   June 2016 – August 2017',
].join('  ');

const ledger = buildLedger([{ id: 'r', name: 'r.pdf', type: 'custom', content: RESUME }]);

function payloadFor(question) {
  const d = composeOpener(ledger, question);
  return {
    instantOpener: d.kind === 'speak' ? d.text : '',
    coverPolicy: d.kind === 'speak' ? 'open' : d.kind,
    coverShape: d.shape,
    coverContext: ledgerDigest(ledger),
    coverVocabulary: ledgerVocabulary(ledger),
  };
}

let outbound = null;
let upstreamTokensSent = 0;
let upstreamDrip = 0;
let upstream, appServer, base, token;

function request(question, extra = {}, onFirstFrame) {
  const p = payloadFor(question);
  const body = JSON.stringify({
    messages: [
      { role: 'system', content: 'You are the candidate.' },
      { role: 'user', content: [{ type: 'text', text: `RULES <<<END RESPONSE RULES>>>\n\n---\n\n${question}` }] },
    ],
    reasoning_effort: 'auto',
    ...p,
    ...extra,
  });
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const frames = [];
    const rq = http.request(base + '/api/v1/ai/stream/openai', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: 'Bearer ' + token,
      },
    }, (res) => {
      res.on('data', (c) => {
        if (frames.length === 0 && onFirstFrame) onFirstFrame(rq, Date.now() - started);
        frames.push(String(c));
      });
      res.on('end', () => resolve({ status: res.statusCode, frames, ms: Date.now() - started, sent: p }));
    });
    rq.on('error', () => resolve({ status: 0, frames, ms: Date.now() - started, sent: p, aborted: true }));
    rq.write(body);
    rq.end();
  });
}

const textOf = (frames) => frames.join('')
  .split('\n')
  .filter((l) => l.startsWith('data:') && !l.includes('[DONE]'))
  .map((l) => { try { return JSON.parse(l.slice(5)).t || ''; } catch { return ''; } })
  .join('');

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { outbound = JSON.parse(raw); } catch { outbound = { _raw: raw }; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (upstreamDrip > 0) {
        // Slow stream, for the disconnect test.
        let i = 0;
        upstreamTokensSent = 0;
        const t = setInterval(() => {
          if (res.writableEnded || res.destroyed) { clearInterval(t); return; }
          i++; upstreamTokensSent = i;
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'tok' + i + ' ' } }] }) + '\n\n');
          if (i >= upstreamDrip) { clearInterval(t); res.write('data: [DONE]\n\n'); res.end(); }
        }, 250);
        res.on('close', () => clearInterval(t));
        return;
      }
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

  const u = db.createUser({ id: 'wire-u', email: 'wire@example.invalid', name: 'W', password: 'x', tier: 'ultra', country_code: 'US' });
  db.createLicense({ key: 'K-WIRE', user_id: u.id, email: u.email, tier: 'ultra', status: 'active', country_code: 'US', expires_at: Date.now() + 8.64e7, sessions_limit: 9 });
  token = jwt.sign({ id: u.id, email: 'wire@example.invalid', tier: 'ultra' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  // NOTE: deliberately NO async middleware here. The old req.on('close')
  // wiring self-aborted every stream in exactly this arrangement; res 'close'
  // means the suite no longer depends on middleware ordering to pass.
  app.use('/api/v1/ai', aiRouter);
  await new Promise((r) => { appServer = app.listen(0, r); });
  base = 'http://127.0.0.1:' + appServer.address().port;
});

afterAll(() => { try { upstream.close(); appServer.close(); } catch { /* ignore */ } });

describe('the opener the client composed is what the candidate hears', () => {
  it('"have you worked for IBM?" — spoken instantly, with no model called', async () => {
    outbound = null;
    const r = await request('have you worked for IBM?');
    const spoken = textOf(r.frames);
    console.log(`   sent:   instantOpener="${r.sent.instantOpener}" policy=${r.sent.coverPolicy}`);
    console.log(`   stream: ${JSON.stringify(spoken)}`);
    console.log(`   whole request took ${r.ms}ms end to end (no cover provider keys are set)`);
    expect(r.status).toBe(200);
    expect(spoken).toContain("No, I haven't");
    expect(spoken).toContain('Siemens');
    expect(spoken).toContain('MAIN-ANSWER');
    expect(spoken).not.toMatch(/IBM|Accenture/);
    // The opener came first, then the main answer.
    expect(spoken.indexOf('Siemens')).toBeLessThan(spoken.indexOf('MAIN-ANSWER'));
  });

  it('the main model receives the opener as a continuation instruction', () => {
    const lastUser = [...(outbound.messages || [])].reverse().find((m) => m.role === 'user');
    const parts = Array.isArray(lastUser.content)
      ? lastUser.content.map((p) => p.text || '').join('\n') : String(lastUser.content);
    console.log(`   continuation block present: ${parts.includes('LIVE CONTINUATION')}`);
    expect(parts).toContain('LIVE CONTINUATION');
    expect(parts).toContain("No, I haven't");
    // The system prompt is untouched — prompt-cache stability.
    const sys = (outbound.messages || []).find((m) => m.role === 'system').content;
    expect(sys).toBe('You are the candidate.');
  });

  it('a challenge is SUPPRESSED — nobody opens it', async () => {
    outbound = null;
    const r = await request('then why did you answer IBM?');
    const spoken = textOf(r.frames);
    console.log(`   sent:   policy=${r.sent.coverPolicy} shape=${r.sent.coverShape} opener="${r.sent.instantOpener}"`);
    console.log(`   stream: ${JSON.stringify(spoken)}`);
    expect(r.sent.coverPolicy).toBe('suppress');
    expect(spoken).toBe('MAIN-ANSWER');
    const lastUser = [...(outbound.messages || [])].reverse().find((m) => m.role === 'user');
    const parts = Array.isArray(lastUser.content)
      ? lastUser.content.map((p) => p.text || '').join('\n') : String(lastUser.content);
    expect(parts).not.toContain('LIVE CONTINUATION');
  });

  it('a problem question defers, and with no provider keys that means no opener', async () => {
    outbound = null;
    const r = await request('how would you design exactly-once delivery into a non-idempotent sink?');
    const spoken = textOf(r.frames);
    console.log(`   sent: policy=${r.sent.coverPolicy} shape=${r.sent.coverShape}`);
    console.log(`   stream: ${JSON.stringify(spoken)}`);
    expect(r.sent.coverPolicy).toBe('defer');
    expect(spoken).toBe('MAIN-ANSWER');
  });

  it('a tampered / oversized opener is refused rather than spoken', async () => {
    outbound = null;
    const r = await request('have you worked for IBM?', { instantOpener: 'x'.repeat(5000) });
    const spoken = textOf(r.frames);
    console.log(`   5000-char opener -> stream ${JSON.stringify(spoken.slice(0, 40))}`);
    expect(spoken).toBe('MAIN-ANSWER');
  });

  it('the request body is smaller than the prose block it replaced', () => {
    const p = payloadFor('have you worked for IBM?');
    const total = p.coverContext.length + p.coverVocabulary.length + p.instantOpener.length;
    console.log(`   digest ${p.coverContext.length} + vocabulary ${p.coverVocabulary.length} + opener ${p.instantOpener.length} = ${total} chars`);
    console.log(`   the old coverContext alone was capped at 9000 and held ONE file`);
    expect(total).toBeLessThan(9000);
  });
});

describe('the client can tell the server to forget its documents', () => {
  it('POST /context/forget drops this user\'s blobs and only theirs', async () => {
    const store = require('../src/services/contextStore.js');
    store._test._reset();

    const body = JSON.stringify({ text: RESUME });
    const upload = () => new Promise((resolve) => {
      const rq = http.request(base + '/api/v1/ai/context', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: 'Bearer ' + token,
        },
      }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve(JSON.parse(d)));
      });
      rq.write(body); rq.end();
    });

    const up = await upload();
    expect(up.ok).toBe(true);
    // A stranger's blob, to prove the scope of the forget.
    store.put('someone-else', 'a different document entirely');
    expect(store.stats().users).toBe(2);

    const forget = await new Promise((resolve) => {
      const rq = http.request(base + '/api/v1/ai/context/forget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': 2, Authorization: 'Bearer ' + token },
      }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
      });
      rq.write('{}'); rq.end();
    });

    console.log(`   forget -> HTTP ${forget.status} ${JSON.stringify(forget.body)}`);
    expect(forget.status).toBe(200);
    expect(forget.body.dropped).toBe(1);
    // Mine is gone…
    expect(store.get('wire-u', up.hash)).toBeNull();
    // …theirs is untouched.
    expect(store.stats().users).toBe(1);
    // And calling it again is a no-op rather than an error.
    expect(store.forgetUser('wire-u')).toBe(0);
  });
});

describe('a client disconnect stops the upstream stream', () => {
  it('hanging up mid-answer aborts the provider', async () => {
    upstreamDrip = 20;      // 20 tokens, 250ms apart = 5s of streaming
    upstreamTokensSent = 0;
    // Deliberately NOT awaited: a destroyed request never emits 'end', so
    // the helper's promise is not the thing to wait on here. The signal is
    // what the UPSTREAM did after the peer went away.
    const inFlight = request('have you worked for IBM?', {}, (rq) => {
      setTimeout(() => { try { rq.destroy(); } catch { /* ignore */ } }, 500);
    });
    inFlight.catch(() => { /* the disconnect is the point */ });
    // Long enough that all 20 tokens WOULD have been delivered (5s) if the
    // abort had not fired.
    await new Promise((res) => setTimeout(res, 6000));
    const delivered = upstreamTokensSent;
    upstreamDrip = 0;
    console.log(`   client left after ~500ms; upstream delivered ${delivered} of 20 tokens`);
    console.log(`   (before the res-'close' fix this was 20/20 — generated and billed for nobody)`);
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(20);
  }, 30000);
});
