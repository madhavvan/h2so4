// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE LOGGER RUNS ON 100% OF AUTH REQUESTS, SO IT MUST NOT
//  BE ABLE TO BREAK ANYTHING.
//
//  It was shipped with no tests at all, which is a straight repeat of the
//  root cause it was written to prevent — the original bug survived because
//  the thing that broke it (helmet) was absent from every test.
//
//  The failure that motivated most of these: safePath called
//  decodeURIComponent on a raw query value. `?session_id=%ZZ` threw URIError
//  from inside a res 'finish' listener — OUTSIDE Express's dispatch stack, so
//  no error handler could ever see it — and killed the process. Express's own
//  query parser swallows bad escapes, so the request itself answered 200 and
//  only the logger died. One unauthenticated request, whole service down,
//  every in-flight sign-in in pendingGoogleSessions lost with it.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-observability';

const { authAccessLog, coarseIp } = require('../src/middleware/authObservability.js');

let srv, base, lines;

beforeAll(async () => {
  const express = require('express');
  const app = express();
  app.set('trust proxy', 1);
  app.use(authAccessLog);
  app.get('/api/v1/auth/ok', (_q, r) => r.json({ ok: true }));
  app.get('/api/v1/auth/tagged', (_q, r) => { r.locals.authOutcome = 'awaiting_code:test'; r.json({ ok: true }); });
  app.get('/api/v1/auth/boom', (_q, r) => r.status(500).json({ e: 1 }));
  srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
afterAll(() => { try { srv.close(); } catch {} });

// Capture what the middleware writes.
beforeEach(() => {
  lines = [];
  for (const m of ['log', 'warn', 'error']) {
    const orig = console[m];
    console[m] = (...a) => { const s = a.join(' '); if (s.startsWith('[auth]')) lines.push({ level: m, s }); else orig(...a); };
  }
});

const get = (p) => new Promise((resolve, reject) => {
  const r = http.get(base + p, (res) => { res.resume(); res.on('end', () => setTimeout(() => resolve(res.statusCode), 30)); });
  r.on('error', reject);
  r.setTimeout(4000, () => { r.destroy(new Error('timeout')); });
});

describe('the logger cannot take the process down', () => {
  it('survives a malformed percent-escape in session_id', async () => {
    const status = await get('/api/v1/auth/ok?session_id=%ZZ');
    expect(status).toBe(200);
    expect(lines.length, 'nothing was logged — did emit() throw?').toBe(1);
  });

  it('survives a malformed percent-escape in state', async () => {
    expect(await get('/api/v1/auth/ok?state=%E0%A4%A')).toBe(200);
    expect(lines.length).toBe(1);
  });

  it('survives a lone percent and a truncated escape', async () => {
    expect(await get('/api/v1/auth/ok?session_id=%')).toBe(200);
    expect(await get('/api/v1/auth/ok?state=abc%2')).toBe(200);
  });
});

describe('the log line cannot be forged or bloated', () => {
  it('strips CR/LF so a value cannot inject a second log entry', async () => {
    await get('/api/v1/auth/ok?session_id=' + encodeURIComponent('aaa\r\n[auth] GET /fake 200 0ms outcome=ok'));
    expect(lines).toHaveLength(1);
    expect(lines[0].s.split('\n')).toHaveLength(1);
    expect(lines[0].s.match(/\[auth\]/g)).toHaveLength(1);
  });

  it('caps the line so one request cannot emit kilobytes of log', async () => {
    const many = Array.from({ length: 300 }, (_, i) => `k${i}=v`).join('&');
    await get('/api/v1/auth/ok?' + many + '&' + 'z'.repeat(3000) + '=1');
    expect(lines[0].s.length, `log line was ${lines[0].s.length} chars`).toBeLessThan(1200);
  });
});

describe('secrets never reach the log', () => {
  it('redacts the handoff code and any token', async () => {
    await get('/api/v1/auth/ok?session_id=abcdefghijkl&code=SECRETCODE&token=SECRETTOKEN');
    expect(lines[0].s).not.toContain('SECRETCODE');
    expect(lines[0].s).not.toContain('SECRETTOKEN');
    expect(lines[0].s).toContain('code=<redacted>');
  });

  it('truncates the session id rather than printing it whole', async () => {
    await get('/api/v1/auth/ok?session_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(lines[0].s).not.toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(lines[0].s).toContain('aaaaaaaa');
  });
});

describe('level and outcome', () => {
  it('logs a 500 at error', async () => {
    await get('/api/v1/auth/boom');
    expect(lines[0].level).toBe('error');
  });

  it('promotes a failure-shaped 200 to warn, because that is what hid the original bug', async () => {
    await get('/api/v1/auth/tagged');
    expect(lines[0].level).toBe('warn');
    expect(lines[0].s).toContain('outcome=awaiting_code:test');
  });

  it('logs a plain success at info', async () => {
    await get('/api/v1/auth/ok');
    expect(lines[0].level).toBe('log');
  });
});

describe('coarseIp agrees with the address logic the server decides with', () => {
  it('uses the SAME implementation as routes/auth.js, compressed IPv6 included', () => {
    // The first version of this middleware carried its own copy, which still
    // had the split(':').slice(0,4) bug: these two are one /64 and must not
    // be reported differently from how addressPrefix judges them.
    expect(coarseIp('2601:249:8000::5')).toBe(coarseIp('2601:249:8000:0:1:2:3:4'));
    expect(coarseIp('::ffff:73.102.55.10')).toBe(coarseIp('73.102.55.200'));
    expect(coarseIp('73.102.55.10')).not.toBe(coarseIp('198.51.100.7'));
  });

  it('never returns a bare address', () => {
    expect(coarseIp('73.102.55.10')).toBe('v4:73.102.55');
    expect(coarseIp('')).toBe('-');
    expect(coarseIp(undefined)).toBe('-');
    expect(coarseIp('not-an-ip')).toBe('-');
  });
});
