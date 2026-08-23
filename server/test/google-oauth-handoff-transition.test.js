// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE MODE THAT ACTUALLY SHIPS FIRST.
//
//  google-oauth-handoff.test.js pins the END state: a code is mandatory.
//  That is the right destination and the wrong thing to deploy today,
//  because the client in the field does not send one. v4.0.18's
//  SubscriptionGate.tsx polls
//
//      /google/poll?session_id=${sessionId}
//
//  and that is the entire request — one query parameter. Require a code and
//  that poll returns `awaiting_code` forever, so Google sign-in never
//  completes for ANY installed user. Not slower. Impossible.
//
//  So GOOGLE_POLL_REQUIRE_CODE defaults OFF, and this file pins what that
//  actually means — because "off" must not be read as "unprotected":
//
//    · a presented code is STILL verified; turning the switch off must
//      never turn a wrong code into an accepted one
//    · a code-less redemption must come from the SAME address that
//      consented, which is the remote-phish takeover the whole mechanism
//      exists to stop
//
//  What an old client loses is only the defence against an attacker who is
//  already on the same address. What it keeps is the ability to log in.
//
//  Flip the flag to 'true' once the LEGACY warnings stop appearing in the
//  server log — that is the fleet telling you it has finished updating.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);

process.env.JWT_SECRET = 'test-secret-google-transition';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.SERVER_URL = 'http://127.0.0.1:1';
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_EMAILS = '';
// Explicitly the DEFAULT (off). Set here rather than relied upon so this
// file keeps testing transition mode even if the default is later flipped.
process.env.GOOGLE_POLL_REQUIRE_CODE = 'false';

const VICTIM = {
  id: 'user_victim_t',
  email: 'victim-transition@example.com',
  name: 'Victim',
  tier: 'free',
  country_code: 'US',
  created_at: 1,
  is_banned: 0,
  password_hash: null,
};

const googleLibPath = (() => {
  try { return require.resolve('google-auth-library'); }
  catch { return 'google-auth-library-stub-transition'; }
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
            sub: 'google-sub-victim-t',
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
  // `trust proxy` so an X-Forwarded-For can stand in for a different source
  // address — that is how the different-address case is exercised without
  // needing a second network interface.
  app.set('trust proxy', true);
  app.use('/api/v1/auth', authRouter);
  srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${srv.address().port}/api/v1/auth`;
});

afterAll(() => {
  try { srv.close(); } catch { /* already down */ }
});

function get(path, headers = {}) {
  return new Promise((resolve) => {
    http.get(`${base}${path}`, { headers }, (r) => {
      let body = '';
      r.on('data', (c) => { body += c; });
      r.on('end', () => resolve({ status: r.statusCode, body }));
    });
  });
}

async function json(path, headers) {
  const res = await get(path, headers);
  try { return JSON.parse(res.body); } catch { return { __unparseable: res.body }; }
}

async function consentUnder(sessionId, headers) {
  await get(`/google/start?session_id=${sessionId}`, headers);
  const cb = await get(`/google/callback?code=fake-auth-code&state=${sessionId}`, headers);
  expect(cb.status).toBe(200);
  // The deep link moved from the inline script into an <a href>, so the
  // ampersand is HTML-escaped. See google-callback-state-injection.test.js.
  const deepLink = cb.body.match(/interview-copilot:\/\/signin-complete\?session_id=[^&"]+&(?:amp;)?code=([A-Z0-9]+)/);
  return { deepLinkCode: deepLink ? deepLink[1] : null };
}

describe('transition mode — the shipped client can still sign in', () => {
  it('a code-less poll from the SAME address succeeds', async () => {
    // This is verbatim what v4.0.18 sends: session_id and nothing else.
    const sid = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
    const { deepLinkCode } = await consentUnder(sid);
    expect(deepLinkCode).toBeTruthy();

    const polled = await json(`/google/poll?session_id=${sid}`);
    expect(
      polled.status,
      'the installed fleet polls without a code — refusing here is a total login outage'
    ).toBe('success');
  });

  it('a session is single-use even on the legacy path', async () => {
    const sid = 'cccccccc-3333-4333-8333-cccccccccccc';
    await consentUnder(sid);
    const first = await json(`/google/poll?session_id=${sid}`);
    expect(first.status).toBe('success');
    const second = await json(`/google/poll?session_id=${sid}`);
    expect(second.status, 'a redeemed session must not be redeemable twice').not.toBe('success');
  });
});

describe('transition mode is NOT unprotected', () => {
  it('refuses a code-less redemption from a DIFFERENT address', async () => {
    // The remote phish: attacker picks the id, victim consents from their
    // own network, attacker polls from theirs.
    const sid = 'dddddddd-4444-4444-8444-dddddddddddd';
    await consentUnder(sid, { 'X-Forwarded-For': '203.0.113.7' });

    const polled = await json(`/google/poll?session_id=${sid}`, { 'X-Forwarded-For': '198.51.100.42' });
    expect(
      polled.status,
      'a different address with no code is exactly the takeover this mechanism exists to stop'
    ).not.toBe('success');
  });

  it('still rejects a WRONG code even with the switch off', async () => {
    // Turning enforcement off must not turn a bad code into a good one.
    const sid = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
    const { deepLinkCode } = await consentUnder(sid);
    expect(deepLinkCode).toBeTruthy();

    const polled = await json(`/google/poll?session_id=${sid}&code=ZZZZZZZZZZ`);
    expect(polled.status).not.toBe('success');
    expect(polled.invalid_code).toBe(true);
  });

  it('accepts the RIGHT code, so an updated client gets the full guarantee immediately', async () => {
    const sid = 'ffffffff-6666-4666-8666-ffffffffffff';
    const { deepLinkCode } = await consentUnder(sid);
    const polled = await json(`/google/poll?session_id=${sid}&code=${deepLinkCode}`);
    expect(polled.status).toBe('success');
  });
});
