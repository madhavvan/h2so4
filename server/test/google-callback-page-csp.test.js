// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE SUCCESS PAGE MUST ACTUALLY WORK IN A BROWSER.
//
//  Every other test in this directory builds a bare `express()` and mounts
//  the auth router on it. Production does not: `server/src/index.js:71` is
//  `app.use(helmet())`, whose default policy is `script-src 'self'`. That
//  one line silently disabled the ENTIRE Google handoff:
//
//    • the inline <script> at the bottom of /google/callback's page is the
//      only thing that navigates to interview-copilot://…&code=…, so no
//      client on any platform ever received a handoff code; and
//    • the same script is the only thing that reveals the printed fallback
//      code, which ships as opacity:0 — so no human could read it either.
//
//  Both failed in complete silence. The endpoint answered 200. The suite
//  stayed green for the entire life of the bug, because the guard that was
//  breaking it was not present in any test.
//
//  So this file mounts the production middleware stack and asserts the page
//  is USABLE, not merely that it renders. If someone removes the nonce,
//  re-hides the code, or drops the script-free link, these go red.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);

process.env.JWT_SECRET = 'test-secret-callback-csp';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.SERVER_URL = 'http://127.0.0.1:1';
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_EMAILS = '';
// Deliberately NOT set: this file also pins the version-gated default that
// replaced the old global on/off switch.
delete process.env.GOOGLE_POLL_REQUIRE_CODE;

const USER = {
  id: 'user_csp', email: 'csp@example.com', name: 'CSP User', tier: 'free',
  country_code: 'US', created_at: 1, is_banned: 0, password_hash: null,
};

const googleLibPath = (() => {
  try { return require.resolve('google-auth-library'); } catch { return 'google-auth-library-stub'; }
})();
require.cache[googleLibPath] = {
  id: googleLibPath, filename: googleLibPath, loaded: true,
  exports: {
    OAuth2Client: class {
      async getToken() { return { tokens: { id_token: 'fake-id-token' } }; }
      setCredentials() {}
      async verifyIdToken() {
        return { getPayload: () => ({ sub: 'google-sub-csp', email: USER.email, name: USER.name, picture: '', email_verified: true }) };
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
const { clientVersion } = require('../src/middleware/clientVersion.js');

let srv, base;

beforeAll(async () => {
  const express = require('express');
  const helmet = require('helmet');
  const app = express();
  // ── THE POINT OF THIS FILE ──
  // Production's stack, in production's order. Without helmet() here the
  // regression this guards cannot be observed at all.
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(clientVersion);
  app.use('/api/v1/auth', authRouter);
  srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${srv.address().port}/api/v1/auth`;
});

afterAll(() => { try { srv.close(); } catch {} });

function get(path, headers = {}) {
  return new Promise((resolve) => {
    http.get(base + path, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
  });
}

const newSession = () => 'sess-' + Math.random().toString(36).slice(2) + '-' + Date.now();

async function consented(sessionId) {
  await get(`/google/start?session_id=${sessionId}`);
  return get(`/google/callback?code=fake&state=${sessionId}`);
}

describe('the /google/callback page is usable under the production CSP', () => {
  it('serves a CSP that permits its own inline script via a nonce', async () => {
    const r = await consented(newSession());
    expect(r.status).toBe(200);
    const csp = r.headers['content-security-policy'] || '';
    const nonceInHeader = csp.match(/'nonce-([A-Za-z0-9+/=]+)'/);
    expect(nonceInHeader, `CSP had no nonce — helmet's script-src 'self' would block the page's script. CSP was: ${csp}`).toBeTruthy();
    // and it must NOT have been "fixed" by simply allowing all inline script
    expect(csp).not.toMatch(/unsafe-inline[^;]*script/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it('every inline <script> on the page carries that exact nonce', async () => {
    const r = await consented(newSession());
    const nonce = (r.headers['content-security-policy'] || '').match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1];
    const opens = [...r.body.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
    expect(opens.length, 'expected at least one inline script on the success page').toBeGreaterThan(0);
    for (const attrs of opens) {
      expect(attrs, `a <script> tag had no nonce, so the browser will refuse to run it: <script${attrs}>`).toContain(`nonce="${nonce}"`);
    }
  });

  it('shows the handoff code on first paint instead of hiding it behind script', async () => {
    const r = await consented(newSession());
    expect(r.body, 'the code box is transparent again — a user cannot read the code it asks them to type')
      .not.toMatch(/id="fallback-box"[^>]*opacity:\s*0/);
    expect(r.body).toMatch(/\b[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}\b/);
  });

  it('offers a deep link that needs no JavaScript at all', async () => {
    const r = await consented(newSession());
    // Strip every script block first: a link that only exists inside one is
    // exactly the failure this whole file is about.
    const withoutScripts = r.body.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    expect(withoutScripts, 'no script-free interview-copilot:// link — if script is ever blocked again the page is a dead end')
      .toMatch(/<a\s[^>]*href="interview-copilot:\/\/signin-complete\?[^"]*"/);
  });

  it('never puts the handoff code in a redirect header or leaks the JWT into the page', async () => {
    const r = await consented(newSession());
    expect(r.headers.location).toBeUndefined();
    expect(r.body).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);   // a JWT
  });
});

describe('/google/start account picker', () => {
  it('does not force the account chooser by default (so the tab can close itself)', async () => {
    const r = await get(`/google/start?session_id=${newSession()}`);
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain('accounts.google.com');
    expect(r.headers.location, 'prompt=select_account forces a click, which makes history.length 2 and blocks window.close()')
      .not.toContain('prompt=select_account');
  });

  it('still offers the chooser on demand for multi-account users', async () => {
    const r = await get(`/google/start?session_id=${newSession()}&switch_account=1`);
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain('prompt=select_account');
  });
});

describe('the handoff code requirement must NOT depend on the client version', () => {
  // middleware/clientVersion.js states the rule outright: "It must NEVER gate
  // a security control. Version-gating the OAuth handoff code, for instance,
  // would let an attacker downgrade themselves to the weaker path by omitting
  // a header." That is exactly what a version gate here did — and worse, it
  // protected nobody even when honoured: /google/start is opened in the
  // user's system BROWSER, which never sends x-app-version, so the flag was
  // false for every real session and the decision fell entirely to the poll
  // request's own header. These cases exist so that gate cannot come back.
  const versions = ['4.0.18', '4.0.22', '4.0.23', '9.9.9', undefined];

  for (const v of versions) {
    it(`treats a client claiming ${v || 'no version'} identically`, async () => {
      const sid = newSession();
      await consented(sid);
      const headers = v ? { 'x-app-version': v } : {};
      const r = await get(`/google/poll?session_id=${sid}`, headers);
      const json = JSON.parse(r.body);
      // Flag unset => code not required => the same-address check decides,
      // and it is the SAME answer whatever the caller claims to be.
      expect(json.status, `claiming ${v} changed the outcome — the version gate is back`).toBe('success');
    });
  }

  it('accepts the printed code when one is presented', async () => {
    const sid = newSession();
    const page = await consented(sid);
    const code = page.body.match(/\b([0-9A-HJKMNP-TV-Z]{5})-([0-9A-HJKMNP-TV-Z]{5})\b/);
    const r = await get(`/google/poll?session_id=${sid}&code=${code[1]}${code[2]}`);
    const json = JSON.parse(r.body);
    expect(json.status).toBe('success');
    expect(json.token).toBeTruthy();
    expect(json.user.email).toBe(USER.email);
  });

  it('still rejects a WRONG code even though the flag is off', async () => {
    const sid = newSession();
    await consented(sid);
    const r = await get(`/google/poll?session_id=${sid}&code=WRONGCODE1`);
    const json = JSON.parse(r.body);
    expect(json.status).toBe('awaiting_code');
    expect(json.invalid_code).toBe(true);
  });
});
