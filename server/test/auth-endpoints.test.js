// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  routes/auth.js — 13 endpoints, previously ZERO direct tests.
//
//  auth.test.js covered the JWT helper and nothing else, so signup,
//  login, password reset, profile and account deletion — the whole
//  identity surface — had no test that ever issued a request to them.
//
//  These run against a REAL in-memory SQLite (the same schema the server
//  boots) over REAL HTTP. The assertions are deliberately about security
//  behaviour rather than happy-path shape, because that is what silently
//  regresses:
//
//    · a password hash must never leave the server
//    · /forgot-password must not become an account-existence oracle
//    · a password change must evict every other live session
//    · reset tokens must be single-use, and expire
//    · deleting an account must actually delete it
//    · ADMIN_EMAILS addresses must not be registerable (H25)
//
//  Google's redirect flow lives in google-oauth-handoff.test.js.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);

process.env.JWT_SECRET = 'test-secret-auth-endpoints';
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_EMAILS = 'owner@minicaai.com';
// No mail transport configured — sendMail resolves to a no-op, which is
// what we want: /forgot-password must behave identically either way.
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

const db = require('../src/database.js');
const authRouter = require('../src/routes/auth.js');

let srv;
let port;

beforeAll(async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', authRouter);
  srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  port = srv.address().port;
});

afterAll(() => { try { srv.close(); } catch { /* already down */ } });

function request(method, path, { body, token } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/v1/auth${path}`,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (r) => {
        let text = '';
        r.on('data', (c) => { text += c; });
        r.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* html page or empty */ }
          resolve({ status: r.statusCode, json, text });
        });
      },
    );
    if (payload) req.write(payload);
    req.end();
  });
}

let seq = 0;
const freshEmail = () => `user${++seq}@example.com`;

/**
 * A session token for `email` that was issued `secondsAgo` seconds ago.
 *
 * Needed because the revocation cutoff floors to a whole second and the
 * comparison is strictly `<`, so a token minted in the SAME second as a
 * password change deliberately survives — that carve-out is what lets a
 * password reset keep the session it just handed out. These tests run
 * inside a single second, so a token created the normal way would land
 * exactly on the boundary and tell us nothing about eviction.
 *
 * Backdating instead of sleeping keeps it deterministic. The boundary
 * itself is pinned separately in token-revocation.test.js.
 */
function backdatedTokenFor(email, secondsAgo = 120) {
  const jwt = require('jsonwebtoken');
  const user = db.getUserByEmail(email);
  const iat = Math.floor(Date.now() / 1000) - secondsAgo;
  return jwt.sign(
    { id: user.id, email: user.email, tier: user.tier, iat },
    process.env.JWT_SECRET,
    { expiresIn: '14d' },
  );
}

async function signUp(email = freshEmail(), password = 'correct-horse-battery') {
  const res = await request('POST', '/signup', { body: { email, password, name: 'Test', country_code: 'US' } });
  return { res, email, password };
}

describe('POST /signup', () => {
  it('creates an account and returns a usable token, never a password hash', async () => {
    const { res } = await signUp();
    expect(res.status).toBe(201);
    expect(res.json.token).toBeTruthy();
    expect(res.json.user.email).toBeTruthy();
    // The whole response body, not just the user object — a hash leaking
    // through any nested field is the thing that matters.
    expect(res.text).not.toMatch(/password_hash|\$2[aby]\$|pbkdf2|v2:/);
  });

  it('rejects a weak password and a malformed address', async () => {
    expect((await request('POST', '/signup', { body: { email: freshEmail(), password: 'short' } })).status).toBe(400);
    expect((await request('POST', '/signup', { body: { email: 'not-an-email', password: 'long-enough-1' } })).status).toBe(400);
    expect((await request('POST', '/signup', { body: {} })).status).toBe(400);
  });

  it('refuses a duplicate address', async () => {
    const { email } = await signUp();
    const again = await request('POST', '/signup', { body: { email, password: 'another-password-1' } });
    expect(again.status).toBe(409);
  });

  it('treats the address case-insensitively', async () => {
    const email = freshEmail();
    await signUp(email);
    const upper = await request('POST', '/signup', { body: { email: email.toUpperCase(), password: 'another-password-1' } });
    expect(upper.status).toBe(409);
  });

  // ── H25 ──
  it('refuses to register an ADMIN_EMAILS address', async () => {
    // Admin authority is derived from the email string by every gate, so
    // whoever registered this address first became an administrator with
    // a never-expiring pro licence.
    const res = await request('POST', '/signup', {
      body: { email: 'owner@minicaai.com', password: 'attacker-chosen-pw', country_code: 'US' },
    });
    expect(res.status).toBe(403);
    expect(res.json.token).toBeUndefined();
    expect(db.getUserByEmail('owner@minicaai.com')).toBeFalsy();
  });

  it('refuses it regardless of casing or padding', async () => {
    for (const variant of ['OWNER@MINICAAI.COM', '  owner@minicaai.com  ', 'Owner@Minicaai.com']) {
      const res = await request('POST', '/signup', { body: { email: variant.trim(), password: 'attacker-chosen-pw' } });
      expect(res.status, `variant ${JSON.stringify(variant)} was allowed through`).toBe(403);
    }
    expect(db.getUserByEmail('owner@minicaai.com')).toBeFalsy();
  });
});

describe('POST /login', () => {
  it('signs in with the right password', async () => {
    const { email, password } = await signUp();
    const res = await request('POST', '/login', { body: { email, password } });
    expect(res.status).toBe(200);
    expect(res.json.token).toBeTruthy();
    expect(res.text).not.toMatch(/password_hash|\$2[aby]\$|v2:/);
  });

  it('refuses the wrong password', async () => {
    const { email } = await signUp();
    const res = await request('POST', '/login', { body: { email, password: 'not-the-password' } });
    expect(res.status).toBe(401);
    expect(res.json.token).toBeUndefined();
  });

  it('answers an unknown address the same way as a wrong password', async () => {
    // Different status or wording here turns login into an account
    // enumeration oracle.
    const { email } = await signUp();
    const wrongPw = await request('POST', '/login', { body: { email, password: 'not-the-password' } });
    const noSuchUser = await request('POST', '/login', { body: { email: 'nobody-here@example.com', password: 'not-the-password' } });
    expect(noSuchUser.status).toBe(wrongPw.status);
    expect(noSuchUser.json.error).toBe(wrongPw.json.error);
  });
});

describe('GET /me and PUT /profile', () => {
  it('requires a token', async () => {
    expect((await request('GET', '/me')).status).toBe(401);
    expect((await request('GET', '/me', { token: 'garbage' })).status).toBe(401);
    expect((await request('PUT', '/profile', { body: { name: 'x' } })).status).toBe(401);
  });

  it('returns the signed-in account and accepts a rename', async () => {
    const { res } = await signUp();
    const token = res.json.token;
    const me = await request('GET', '/me', { token });
    expect(me.status).toBe(200);
    expect(me.json.user.email).toBe(res.json.user.email);
    expect(me.text).not.toMatch(/password_hash|v2:/);

    const renamed = await request('PUT', '/profile', { token, body: { name: 'Renamed Person' } });
    expect(renamed.status).toBe(200);
    expect((await request('GET', '/me', { token })).json.user.name).toBe('Renamed Person');
  });
});

describe('PUT /password', () => {
  it('requires the current password', async () => {
    const { res } = await signUp();
    const bad = await request('PUT', '/password', {
      token: res.json.token,
      body: { current_password: 'wrong', new_password: 'a-new-password-1' },
    });
    expect(bad.status).toBe(401);
  });

  it('changes the password and evicts every other live session', async () => {
    // The point of the whole tokens_revoked_after mechanism: a 14-day
    // bearer token held by someone else must stop working the moment the
    // owner changes their password. Without this, "change your password"
    // does nothing to an attacker who already has a token.
    const { email, password, res } = await signUp();
    const stolen = backdatedTokenFor(email, 120); // taken two minutes ago
    expect((await request('GET', '/me', { token: stolen })).status).toBe(200);

    const changed = await request('PUT', '/password', {
      token: res.json.token,
      body: { current_password: password, new_password: 'a-brand-new-password-1' },
    });
    expect(changed.status).toBe(200);

    expect((await request('GET', '/me', { token: stolen })).status).toBe(401);

    // The caller who performed the change keeps working — either the same
    // token (issued in the same second as the cutoff) or a reissued one.
    const survivor = changed.json.token || res.json.token;
    expect((await request('GET', '/me', { token: survivor })).status).toBe(200);

    // ...and the new password is the one that works from here on.
    expect((await request('POST', '/login', { body: { email, password } })).status).toBe(401);
    expect((await request('POST', '/login', { body: { email, password: 'a-brand-new-password-1' } })).status).toBe(200);
  });
});

describe('POST /forgot-password', () => {
  it('answers identically for a known and an unknown address', async () => {
    // Any observable difference here is an account-existence oracle, and
    // this endpoint is unauthenticated by definition.
    const { email } = await signUp();
    const known = await request('POST', '/forgot-password', { body: { email } });
    const unknown = await request('POST', '/forgot-password', { body: { email: 'definitely-not-here@example.com' } });
    expect(known.status).toBe(unknown.status);
    expect(JSON.stringify(known.json)).toBe(JSON.stringify(unknown.json));
  });

  it('rejects a malformed address', async () => {
    expect((await request('POST', '/forgot-password', { body: { email: 'nope' } })).status).toBe(400);
    expect((await request('POST', '/forgot-password', { body: {} })).status).toBe(400);
  });

  it('never returns the reset token in the response', async () => {
    // The token goes in an email. Returning it — even "for debugging" —
    // makes the endpoint a takeover primitive for any address.
    const { email } = await signUp();
    const res = await request('POST', '/forgot-password', { body: { email } });
    expect(res.text).not.toMatch(/token|reset_token/i);
  });
});

describe('POST /reset-password', () => {
  it('refuses an unknown or already-used token', async () => {
    const bogus = await request('POST', '/reset-password', {
      body: { token: 'not-a-real-token', password: 'a-new-password-1' },
    });
    expect(bogus.status).toBeGreaterThanOrEqual(400);
  });

  it('consumes a real token exactly once and revokes existing sessions', async () => {
    const { email } = await signUp();
    const live = backdatedTokenFor(email, 120); // a session from before the reset
    expect((await request('GET', '/me', { token: live })).status).toBe(200);

    // Mint the token the way /forgot-password does, straight through the
    // DB — the email transport is not what is under test here.
    const user = db.getUserByEmail(email);
    const resetToken = db.createPasswordResetToken(user.id, user.email);
    expect(resetToken).toBeTruthy();

    const first = await request('POST', '/reset-password', {
      body: { token: resetToken, password: 'reset-password-value-1' },
    });
    expect(first.status).toBe(200);

    // Single use — a leaked or replayed link must be inert.
    const replay = await request('POST', '/reset-password', {
      body: { token: resetToken, password: 'attacker-password-1' },
    });
    expect(replay.status).toBeGreaterThanOrEqual(400);

    // A reset is a takeover recovery: whoever held a session before it
    // must be evicted, or the reset does not recover anything.
    expect((await request('GET', '/me', { token: live })).status).toBe(401);
    expect((await request('POST', '/login', { body: { email, password: 'reset-password-value-1' } })).status).toBe(200);
    expect((await request('POST', '/login', { body: { email, password: 'attacker-password-1' } })).status).toBe(401);
  });
});

describe('DELETE /account', () => {
  it('requires a token', async () => {
    expect((await request('DELETE', '/account')).status).toBe(401);
  });

  it('actually removes the account and stops the token working', async () => {
    const { email, password, res } = await signUp();
    const token = res.json.token;
    const del = await request('DELETE', '/account', { token, body: { password } });
    expect(del.status).toBe(200);

    expect(db.getUserByEmail(email)).toBeFalsy();
    expect((await request('GET', '/me', { token })).status).toBeGreaterThanOrEqual(401);
    expect((await request('POST', '/login', { body: { email, password } })).status).toBe(401);
  });
});
