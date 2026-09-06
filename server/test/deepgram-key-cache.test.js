// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ONE DEEPGRAM KEY PER USER PER WINDOW — NOT ONE PER MIC CLICK
//
//  Field report (2026-09-05): "the mic takes 4-5 seconds to show ON". The
//  largest single leg was this route minting a brand-new Deepgram key on
//  EVERY call — p50 623 ms, p90 908 ms, max 1.4 s of upstream round trip in
//  production — and the client asked on every start and every reconnect (21
//  mints for 7 interview starts in one week of logs).
//
//  The route now remembers each user's minted key until it has less than
//  DEEPGRAM_KEY_MIN_REMAINING_S of life left, answers `expires_at` so the
//  client can cache and refresh early too, and honours `?fresh=1` for a key
//  Deepgram rejected. This drives the REAL handler with Deepgram stubbed.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'deepgram-key-cache-test';
process.env.ADMIN_EMAILS = '';
process.env.DEEPGRAM_API_KEY = 'master_key_for_test';
process.env.DEEPGRAM_PROJECT_ID = 'proj_test';
delete process.env.DEEPGRAM_STRICT_NO_MASTER;

const require = createRequire(import.meta.url);
const ai = require('../src/routes/ai.js');
const T = ai._test;

let mintCalls = 0;
let mintBodies = [];
let nextMintStatus = 200;
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  if (String(url).includes('api.deepgram.com/v1/projects/')) {
    mintCalls += 1;
    mintBodies.push(JSON.parse(init.body));
    if (nextMintStatus !== 200) {
      const status = nextMintStatus;
      nextMintStatus = 200;
      return { ok: false, status, text: async () => 'upstream said no' };
    }
    return { ok: true, status: 200, json: async () => ({ api_key_id: `id_${mintCalls}`, key: `dg_minted_${mintCalls}` }) };
  }
  return realFetch(url, init);
};
afterAll(() => { global.fetch = realFetch; });

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const reqFor = (id, query = {}) => ({ user: { id, email: `${id}@minicaai.test` }, ip: '127.0.0.1', query });

async function call(id, query) {
  const res = fakeRes();
  await T.deepgramKeyHandler(reqFor(id, query), res);
  return res;
}

beforeEach(() => {
  T._resetDeepgramKeyCache();
  mintCalls = 0;
  mintBodies = [];
  nextMintStatus = 200;
  process.env.DEEPGRAM_PROJECT_ID = 'proj_test';
});

describe('deepgram-key per-user cache', () => {
  it('mints once for a user and serves the same key, with its expiry, on the next calls', async () => {
    const before = Date.now();
    const first = await call('u_1');
    expect(first.statusCode).toBe(200);
    expect(first.body.key).toBe('dg_minted_1');
    expect(first.body.expires_at).toBeGreaterThanOrEqual(before + T.DEEPGRAM_KEY_TTL_SECONDS * 1000 - 50);
    expect(first.body.cached).toBeUndefined();
    expect(mintBodies[0]).toMatchObject({ scopes: ['usage:write'], time_to_live_in_seconds: T.DEEPGRAM_KEY_TTL_SECONDS });
    expect(mintBodies[0].comment).toContain('user-u_1');

    const second = await call('u_1');
    const third = await call('u_1');
    expect(mintCalls).toBe(1);
    expect(second.body).toMatchObject({ key: 'dg_minted_1', expires_at: first.body.expires_at, cached: true });
    expect(third.body.key).toBe('dg_minted_1');
  });

  it('keys are per user — a second account gets its own mint', async () => {
    await call('u_a');
    await call('u_b');
    await call('u_a');
    expect(mintCalls).toBe(2);
    expect(T._deepgramKeyCache.get('u_a').key).toBe('dg_minted_1');
    expect(T._deepgramKeyCache.get('u_b').key).toBe('dg_minted_2');
  });

  it('a key with less than the minimum remaining life is not re-served — a fresh one is minted', async () => {
    await call('u_old');
    const entry = T._deepgramKeyCache.get('u_old');
    entry.expiresAt = Date.now() + (T.DEEPGRAM_KEY_MIN_REMAINING_S - 60) * 1000; // 74 minutes left
    const res = await call('u_old');
    expect(mintCalls).toBe(2);
    expect(res.body.key).toBe('dg_minted_2');
    expect(res.body.cached).toBeUndefined();
    // …and exactly at the threshold it is still served.
    T._deepgramKeyCache.get('u_old').expiresAt = Date.now() + (T.DEEPGRAM_KEY_MIN_REMAINING_S + 60) * 1000;
    const again = await call('u_old');
    expect(mintCalls).toBe(2);
    expect(again.body.cached).toBe(true);
  });

  it('?fresh=1 bypasses the cache and replaces the stored key (the client sends it after Deepgram rejected a key)', async () => {
    await call('u_f');
    const res = await call('u_f', { fresh: '1' });
    expect(mintCalls).toBe(2);
    expect(res.body.key).toBe('dg_minted_2');
    expect(T._deepgramKeyCache.get('u_f').key).toBe('dg_minted_2');
    const after = await call('u_f');
    expect(after.body).toMatchObject({ key: 'dg_minted_2', cached: true });
    expect(mintCalls).toBe(2);
  });

  it('a transient upstream failure serves the master key for that request only and poisons nothing', async () => {
    nextMintStatus = 503;
    const fallback = await call('u_t');
    expect(fallback.statusCode).toBe(200);
    expect(fallback.body).toEqual({ key: 'master_key_for_test', expires_at: null });
    expect(T._deepgramKeyCache.has('u_t')).toBe(false);
    const ok = await call('u_t');
    expect(ok.body.key).toBe('dg_minted_2');
    expect(ok.body.expires_at).toBeGreaterThan(Date.now());
  });

  it('without DEEPGRAM_PROJECT_ID the master-key fallback answers expires_at: null and never touches Deepgram', async () => {
    delete process.env.DEEPGRAM_PROJECT_ID;
    const res = await call('u_np');
    expect(res.body).toEqual({ key: 'master_key_for_test', expires_at: null });
    expect(mintCalls).toBe(0);
    expect(T._deepgramKeyCache.size).toBe(0);
  });

  it('a caller with no user id (should not happen behind authMiddleware) is minted for but never cached', async () => {
    const res = fakeRes();
    await T.deepgramKeyHandler({ user: null, ip: '9.9.9.9', query: {} }, res);
    expect(res.body.key).toBe('dg_minted_1');
    expect(mintBodies[0].comment).toContain('ip-9.9.9.9');
    expect(T._deepgramKeyCache.size).toBe(0);
  });
});
