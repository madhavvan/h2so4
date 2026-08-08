// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  /google/poll MUST NOT HAND A SESSION TO WHOEVER NAMED IT.
//
//  The desktop Google flow is: the app picks a `session_id`, opens the
//  browser at /google/start?session_id=…, and polls /google/poll with the
//  same id until the token appears. `session_id` is therefore chosen by
//  the caller — and for a long time it was the ONLY thing /google/poll
//  asked for. That gives a complete account takeover:
//
//    1. attacker calls /google/start with an id they picked, and stops
//    2. attacker sends the victim that same link ("sign in to continue")
//    3. victim consents with THEIR Google account — the callback files
//       the victim's JWT under the ATTACKER's id
//    4. attacker polls that id and walks off with the victim's session
//
//  Note what does NOT help. Requiring UUID-class entropy in session_id
//  (the server does) defends against guessing an id. Here nobody is
//  guessing: the attacker chose it. Rate limits don't help either — one
//  poll is enough. The missing property was never entropy, it was that
//  nothing tied the redeemer to the human who actually consented.
//
//  So the callback now mints a one-time code AFTER consent — the first
//  moment a secret exists that whoever started the flow could not know —
//  and delivers it only to the browser that consented (deep link + a
//  printed code). /google/poll refuses without it.
//
//  These tests drive the real routes over real HTTP with Google and the
//  database stubbed. No network, no cost.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);

process.env.JWT_SECRET = 'test-secret-google-handoff';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.SERVER_URL = 'http://127.0.0.1:1';
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_EMAILS = '';

const VICTIM = {
  id: 'user_victim',
  email: 'victim@example.com',
  name: 'Victim',
  tier: 'free',
  country_code: 'US',
  created_at: 1,
  is_banned: 0,
  password_hash: null,
};

// ── Stub google-auth-library before the route requires it ──
// The route does `require('google-auth-library')` inside the handler, so
// seeding require.cache is enough and no module-mocking hook is needed.
const googleLibPath = (() => {
  try { return require.resolve('google-auth-library'); }
  catch { return 'google-auth-library-stub'; }
})();
require.cache[googleLibPath] = {
  id: googleLibPath,
  filename: googleLibPath,
  loaded: true,
  exports: {
    OAuth2Client: class {
      async getToken() { return { tokens: { id_token: 'fake-id-token' } }; }
      setCredentials() { /* no-op */ }
      async verifyIdToken() {
        return {
          getPayload: () => ({
            sub: 'google-sub-victim',
            email: VICTIM.email,
            name: VICTIM.name,
            picture: '',
            email_verified: true,
          }),
        };
      }
    },
  },
};

// ── Stub the database surface the callback touches ──
const dbMod = require('../src/database.js');
dbMod.getUserByGoogleId = () => VICTIM;
dbMod.getUserByEmail = () => VICTIM;
dbMod.getUserById = () => VICTIM;
dbMod.getLicenseByUserId = () => ({ tier: 'free', status: 'trial', key: 'MNC-TEST' });
dbMod.logLogin = () => {};
dbMod.getDB = () => ({ prepare: () => ({ run: () => {} }) });

const authRouter = require('../src/routes/auth.js');

let srv;
let base;

beforeAll(async () => {
  const express = require('express');
  const app = express();
  app.use('/api/v1/auth', authRouter);
  srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${srv.address().port}/api/v1/auth`;
});

afterAll(() => {
  try { srv.close(); } catch { /* already down */ }
});

function get(path) {
  return new Promise((resolve) => {
    http.get(`${base}${path}`, (r) => {
      let body = '';
      r.on('data', (c) => { body += c; });
      r.on('end', () => resolve({ status: r.statusCode, body, location: r.headers.location || '' }));
    });
  });
}

async function json(path) {
  const res = await get(path);
  try { return JSON.parse(res.body); } catch { return { __unparseable: res.body }; }
}

/**
 * Run start + callback for a caller-chosen session id and return the code
 * the consenting browser was given. This is the attacker's setup in steps
 * 1-3 above: THEY pick the id, the VICTIM completes consent.
 */
async function consentUnder(sessionId) {
  await get(`/google/start?session_id=${sessionId}`);
  const cb = await get(`/google/callback?code=fake-auth-code&state=${sessionId}`);
  expect(cb.status).toBe(200);
  // The deep link the success page hands to the OS on the machine where
  // consent happened. This is the ONLY place the code appears.
  const deepLink = cb.body.match(/interview-copilot:\/\/signin-complete\?session_id=[^&]+&code=([A-Z0-9]+)/);
  const printed = cb.body.match(/([0-9A-Z]{5})-([0-9A-Z]{5})/);
  return {
    html: cb.body,
    deepLinkCode: deepLink ? deepLink[1] : null,
    printedCode: printed ? printed[1] + printed[2] : null,
  };
}

describe('Google sign-in handoff — the takeover', () => {
  it('refuses the session to a caller who has only the session_id', async () => {
    const attackerChosenId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const { deepLinkCode } = await consentUnder(attackerChosenId);
    expect(deepLinkCode).toBeTruthy(); // consent really did succeed

    // The attacker polls with the id they picked and nothing else. This
    // is the exact request that used to return the victim's JWT.
    const polled = await json(`/google/poll?session_id=${attackerChosenId}`);
    expect(polled.status).toBe('awaiting_code');
    expect(polled.token).toBeUndefined();
    expect(polled.user).toBeUndefined();
    expect(polled.license).toBeUndefined();
  });

  it('releases the session to the machine that received the code', async () => {
    const sessionId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
    const { deepLinkCode } = await consentUnder(sessionId);

    const polled = await json(`/google/poll?session_id=${sessionId}&code=${deepLinkCode}`);
    expect(polled.status).toBe('success');
    expect(polled.token).toBeTruthy();
    expect(polled.user.email).toBe(VICTIM.email);
  });

  it('prints the same code for the human when the deep link cannot fire', async () => {
    // The printed fallback and the deep-link code must be one code, not
    // two — otherwise typing what the browser shows would be rejected.
    const sessionId = 'cccccccc-3333-4333-8333-cccccccccccc';
    const { deepLinkCode, printedCode } = await consentUnder(sessionId);
    expect(printedCode).toBe(deepLinkCode);

    const polled = await json(`/google/poll?session_id=${sessionId}&code=${printedCode}`);
    expect(polled.status).toBe('success');
  });

  it('accepts the code as a human retypes it — hyphen, lower case, O for 0', async () => {
    const sessionId = 'dddddddd-4444-4444-8444-dddddddddddd';
    const { deepLinkCode } = await consentUnder(sessionId);
    // Display form, lower-cased, with the substitutions Crockford folds.
    const retyped = `${deepLinkCode.slice(0, 5)}-${deepLinkCode.slice(5)}`
      .toLowerCase()
      .replace(/0/g, 'O')
      .replace(/1/g, 'l');
    const polled = await json(`/google/poll?session_id=${sessionId}&code=${encodeURIComponent(retyped)}`);
    expect(polled.status).toBe('success');
  });

  it('is single-use — a replayed code gets nothing', async () => {
    const sessionId = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
    const { deepLinkCode } = await consentUnder(sessionId);

    const first = await json(`/google/poll?session_id=${sessionId}&code=${deepLinkCode}`);
    expect(first.status).toBe('success');

    const replay = await json(`/google/poll?session_id=${sessionId}&code=${deepLinkCode}`);
    expect(replay.status).toBe('pending');
    expect(replay.token).toBeUndefined();
  });

  it('rejects a wrong code and burns the session after 10 tries', async () => {
    const sessionId = 'ffffffff-6666-4666-8666-ffffffffffff';
    const { deepLinkCode } = await consentUnder(sessionId);

    // 9 wrong guesses: refused, but the session survives so a user who
    // fat-fingers the code is not thrown back to the start.
    for (let i = 0; i < 9; i++) {
      const r = await json(`/google/poll?session_id=${sessionId}&code=ZZZZZZZZZ${i}`);
      expect(r.status).toBe('awaiting_code');
      expect(r.invalid_code).toBe(true);
    }

    // The 10th burns it — an attacker cannot grind a 50-bit code down.
    const burned = await json(`/google/poll?session_id=${sessionId}&code=ZZZZZZZZZX`);
    expect(burned.status).toBe('error');

    // And the real code is worthless afterwards, so burning is not a way
    // to keep the session alive for a later guess.
    const after = await json(`/google/poll?session_id=${sessionId}&code=${deepLinkCode}`);
    expect(after.status).toBe('pending');
    expect(after.token).toBeUndefined();
  });

  it('never puts the code anywhere but the consenting browser', async () => {
    const sessionId = '99999999-7777-4777-8777-999999999999';
    const { html, deepLinkCode } = await consentUnder(sessionId);

    // The code lives in the success page (deep link + printed block) and
    // nowhere a third party can reach. In particular the poll response
    // for a code-less caller must not leak it.
    expect(html).toContain(deepLinkCode);
    const polled = await get(`/google/poll?session_id=${sessionId}`);
    expect(polled.body).not.toContain(deepLinkCode);
  });

  it('still reports a genuinely pending session as pending', async () => {
    // Consent not completed — no behaviour change for the normal wait.
    const sessionId = '88888888-8888-4888-8888-888888888888';
    await get(`/google/start?session_id=${sessionId}`);
    const polled = await json(`/google/poll?session_id=${sessionId}`);
    expect(polled.status).toBe('pending');
  });
});
