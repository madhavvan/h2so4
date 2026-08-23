// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE OAuth `state` IS ATTACKER-CONTROLLED. TREAT IT THAT WAY.
//
//  /google/start validates session_id's shape. /google/callback did not —
//  and it does not have to be reached through /google/start. Both client_id
//  and redirect_uri are public (they are in the 302 that /google/start
//  returns), so anyone can hand a victim an authorize link carrying a state
//  of their choosing. Google echoes it back to our callback with a VALID
//  authorization code, and for a returning consented account the whole trip
//  is a redirect chain with no interaction beyond the first click.
//
//  That was survivable only while helmet's CSP kept the success page's
//  inline <script> from running. Giving that script a nonce so the handoff
//  could work turned a dormant injection into a live one:
//
//      var url = 'interview-copilot://…session_id=<STATE>&code=…';
//
//  encodeURIComponent does NOT escape a single quote — it is unreserved —
//  so  state = '-fetch(...)-'  closes the literal and executes under the
//  page's own nonce, on api.minicaai.com. The script can read the printed
//  handoff code out of the DOM and exfiltrate it; the attacker already knows
//  session_id because he chose it, so he redeems the victim's JWT from
//  /google/poll. One click, full account takeover.
//
//  Two independent defences, and this file pins BOTH, because either one
//  alone is one refactor away from being the only one:
//    1. the callback rejects any state that is not UUID-shaped
//    2. the page never interpolates untrusted input into script at all
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);

process.env.JWT_SECRET = 'test-secret-state-injection';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.SERVER_URL = 'http://127.0.0.1:1';
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_EMAILS = '';

const USER = {
  id: 'user_inj', email: 'inj@example.com', name: 'Inj', tier: 'free',
  country_code: 'US', created_at: 1, is_banned: 0, password_hash: null,
};

const googleLibPath = (() => {
  try { return require.resolve('google-auth-library'); } catch { return 'google-auth-library-stub'; }
})();
require.cache[googleLibPath] = {
  id: googleLibPath, filename: googleLibPath, loaded: true,
  exports: {
    OAuth2Client: class {
      async getToken() { return { tokens: { id_token: 'fake' } }; }
      setCredentials() {}
      async verifyIdToken() {
        return { getPayload: () => ({ sub: 'sub-inj', email: USER.email, name: USER.name, picture: '', email_verified: true }) };
      }
    },
  },
};

const dbMod = require('../src/database.js');
dbMod.getUserByGoogleId = () => USER;
dbMod.getUserByEmail = () => USER;
dbMod.getUserById = () => USER;
dbMod.getLicenseByUserId = () => ({ tier: 'free', status: 'trial', key: 'MNC-TEST' });
dbMod.logLogin = () => {};
dbMod.getDB = () => ({ prepare: () => ({ run: () => {} }) });

const authRouter = require('../src/routes/auth.js');

let srv, base;
beforeAll(async () => {
  const express = require('express');
  const helmet = require('helmet');
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use('/api/v1/auth', authRouter);
  srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${srv.address().port}/api/v1/auth`;
});
afterAll(() => { try { srv.close(); } catch {} });

const get = (p) => new Promise((resolve) => {
  http.get(base + p, (res) => {
    let body = ''; res.on('data', (c) => (body += c));
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
});

// Payloads that all break out of a single-quoted JS string literal, and
// survive encodeURIComponent untouched.
const BREAKOUTS = [
  `'-alert(1)-'`,
  `';alert(1);'`,
  `'+alert(1)+'`,
  `'-fetch('.concat(String.fromCharCode(104)))-'`,
  `'};alert(1);var x={'`,
];

describe('defence 1 — the callback refuses a malformed OAuth state', () => {
  for (const payload of BREAKOUTS) {
    it(`rejects ${JSON.stringify(payload.slice(0, 24))}`, async () => {
      const r = await get(`/google/callback?code=valid&state=${encodeURIComponent(payload)}`);
      expect(r.status, 'a non-UUID state must never reach the success page').toBe(400);
      expect(r.body).not.toContain('Signed in');
    });
  }

  it('still accepts a well-formed state', async () => {
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await get(`/google/start?session_id=${sid}`);
    const r = await get(`/google/callback?code=valid&state=${sid}`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('Signed in');
  });
});

describe('defence 2 — the page never interpolates anything into its script', () => {
  it('the inline script contains no server-substituted value', async () => {
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
    await get(`/google/start?session_id=${sid}`);
    const r = await get(`/google/callback?code=valid&state=${sid}`);
    const script = r.body.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)?.[1] || '';
    expect(script, 'the script body still carries the session id — one bad state away from an injection again')
      .not.toContain(sid);
    // and it must not build the deep link from a literal at all
    expect(script).not.toMatch(/'interview-copilot:\/\/[^']*\?/);
  });

  it('the deep link lives in a double-quoted HTML attribute, which the encoding cannot escape', async () => {
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-999999999999';
    await get(`/google/start?session_id=${sid}`);
    const r = await get(`/google/callback?code=valid&state=${sid}`);
    expect(r.body).toMatch(new RegExp(`<a[^>]*id="open-app"[^>]*href="interview-copilot://signin-complete\\?session_id=${sid}`));
  });

  it('encodeURIComponent leaves a single quote intact — the reason defence 2 exists', () => {
    // Pins the premise. If a future refactor reintroduces string-literal
    // interpolation "because the value is encoded", this is the counterexample.
    expect(encodeURIComponent("'")).toBe("'");
    expect(encodeURIComponent('"')).toBe('%22');
  });
});
