// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE "SIGNED IN" PAGE MUST NOT DESTROY THE CODE IT IS SHOWING.
//
//  Production, 2026-09-06: a user whose browser and app left through
//  different VPN exits polled `awaiting_code:address_different_network`
//  73 times in a minute. The app was asking for the code; the only copy of
//  it was on a browser tab that had closed itself 1.2 s after landing.
//  Eight consents in three minutes, three sign-ins — the three where both
//  connections happened to share a /24.
//
//  What this pins:
//    • the page carries no unconditional close timer — it polls
//      /google/handoff-status and closes only on `redeemed`
//    • /google/handoff-status reports ready → redeemed → (later) gone, and
//      never the token
//    • a loopback port registered at /google/start reaches the page as a
//      127.0.0.1 hand-off and is admitted by that response's CSP; a bad
//      port is ignored and nothing loopback-shaped appears
//    • the same-address fallback still works, and a repeated awaiting_code
//      poll is logged once, not once per tick
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);

process.env.JWT_SECRET = 'test-secret-google-handoff-page';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.SERVER_URL = 'http://127.0.0.1:1';
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_EMAILS = '';
// The fleet's setting: the code is verified when presented, and a code-less
// poll falls back to the same-address check.
process.env.GOOGLE_POLL_REQUIRE_CODE = 'false';

const USER = {
  id: 'user_page',
  email: 'page@example.com',
  name: 'Page',
  tier: 'free',
  country_code: 'US',
  created_at: 1,
  is_banned: 0,
  password_hash: null,
};

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
            sub: 'google-sub-page',
            email: USER.email,
            name: USER.name,
            picture: '',
            email_verified: true,
          }),
        };
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

// The router applies the auth access log itself (routes/auth.js
// `router.use(authAccessLog)`), which is what the quiet-repeat assertion
// below exercises — mounting it again here would print every line twice.
const authRouter = require('../src/routes/auth.js');

let srv;
let base;

beforeAll(async () => {
  const express = require('express');
  const app = express();
  // So a test can put the consent and the poll on different networks.
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
      r.on('end', () => resolve({ status: r.statusCode, body, headers: r.headers }));
    });
  });
}
async function json(path, headers) {
  const res = await get(path, headers);
  try { return JSON.parse(res.body); } catch { return { __unparseable: res.body }; }
}

const sid = (tag) => `${tag}-0123456789abcdef-${Math.random().toString(36).slice(2, 10)}`;

// ── what the page's script may and may not do ──
function scriptOf(html) {
  const m = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}

describe('/google/handoff-status — what the page waits on', () => {
  it('reports ready after consent, redeemed after the app collects the token, and never the token', async () => {
    const id = sid('status');
    expect(await json(`/google/handoff-status?session_id=${id}`)).toEqual({ state: 'gone' });

    await get(`/google/start?session_id=${id}`);
    expect(await json(`/google/handoff-status?session_id=${id}`)).toEqual({ state: 'pending' });

    const cb = await get(`/google/callback?code=fake&state=${id}`);
    expect(cb.status).toBe(200);
    const ready = await get(`/google/handoff-status?session_id=${id}`);
    expect(JSON.parse(ready.body)).toEqual({ state: 'ready' });
    expect(ready.headers['cache-control']).toBe('no-store');
    expect(ready.body).not.toMatch(/token|MNC-/);

    // Same address consented and polls → the fleet's legacy path releases it.
    const polled = await json(`/google/poll?session_id=${id}`);
    expect(polled.status).toBe('success');
    expect(await json(`/google/handoff-status?session_id=${id}`)).toEqual({ state: 'redeemed' });
  });

  it('refuses a malformed session id', async () => {
    const r = await get('/google/handoff-status?session_id=short');
    expect(r.status).toBe(400);
  });
});

describe('the "Signed in" page', () => {
  it('has no close-on-a-timer; it polls handoff-status and closes only on redeemed', async () => {
    const id = sid('page');
    await get(`/google/start?session_id=${id}`);
    const cb = await get(`/google/callback?code=fake&state=${id}`);
    const script = scriptOf(cb.body);
    expect(script.length).toBeGreaterThan(0);

    // The old page: setTimeout(function(){ … window.close() … }, 1200).
    expect(script).not.toMatch(/setTimeout\([\s\S]{0,400}window\.close\(\)[\s\S]{0,200}\},\s*1200\)/);
    // window.close() appears exactly once, inside the redeemed branch.
    expect(script.match(/window\.close\(\)/g)).toHaveLength(1);
    const closeAt = script.indexOf('window.close()');
    const redeemedBranchAt = script.indexOf("if (state === 'redeemed')");
    expect(redeemedBranchAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(redeemedBranchAt);
    // The status poll is wired through an anchor the script reads at runtime.
    expect(cb.body).toContain(`id="status-url" href="/api/v1/auth/google/handoff-status?session_id=${encodeURIComponent(id)}"`);
    expect(script).toContain("var statusUrl = href('status-url');");
    // The code stays on screen and is promoted, not removed, while waiting.
    expect(cb.body).toMatch(/[0-9A-Z]{5}-[0-9A-Z]{5}/);
    expect(script).toContain("text('headline', 'One more step');");
    // Nothing server-side is interpolated into the script itself.
    expect(script).not.toContain(id);
    // The page's own CSP admits the status poll.
    expect(cb.headers['content-security-policy']).toMatch(/connect-src 'self';/);
    expect(cb.headers['cache-control']).toBe('no-store');
  });

  it('hands the code to a registered loopback port, and that port only', async () => {
    const id = sid('loop');
    await get(`/google/start?session_id=${id}&lp=48213`);
    const cb = await get(`/google/callback?code=fake&state=${id}`);
    const code = cb.body.match(/interview-copilot:\/\/signin-complete\?session_id=[^&"]+&(?:amp;)?code=([A-Z0-9]+)/)[1];
    expect(cb.body).toContain(`id="loopback-url" href="http://127.0.0.1:48213/google-handoff?session_id=${encodeURIComponent(id)}&amp;code=${code}"`);
    expect(cb.headers['content-security-policy']).toMatch(/connect-src 'self' http:\/\/127\.0\.0\.1:48213;/);
    expect(scriptOf(cb.body)).toContain("mode: 'no-cors'");
  });

  it('ignores a port it would not trust and then has nothing loopback-shaped on the page', async () => {
    for (const bad of ['80', 'abc', '70000', '0', '1023', '3000x']) {
      const id = sid('badlp');
      await get(`/google/start?session_id=${id}&lp=${bad}`);
      const cb = await get(`/google/callback?code=fake&state=${id}`);
      expect(cb.body).not.toContain('127.0.0.1');
      expect(cb.headers['content-security-policy']).toMatch(/connect-src 'self';/);
    }
  });
});

describe('the fleet path: no code, different networks', () => {
  it('asks for the code, logs the verdict once, and releases the moment the code is typed', async () => {
    const id = sid('vpn');
    await get(`/google/start?session_id=${id}`, { 'x-forwarded-for': '84.17.44.9' });
    const cb = await get(`/google/callback?code=fake&state=${id}`, { 'x-forwarded-for': '84.17.44.9' });
    const code = cb.body.match(/([0-9A-Z]{5})-([0-9A-Z]{5})/);
    const printed = code[1] + code[2];

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // The app polls from the other VPN exit, over and over.
      for (let i = 0; i < 5; i++) {
        const r = await json(`/google/poll?session_id=${id}`, { 'x-forwarded-for': '169.150.224.3' });
        expect(r).toEqual({ status: 'awaiting_code', reason: 'address_different_network' });
      }
      const verdictLines = warn.mock.calls.filter((c) => /\[google\/poll\] awaiting_code reason=address_different_network/.test(String(c[0])));
      expect(verdictLines).toHaveLength(1);
      // The access log printed the first awaiting poll and stayed quiet on the four repeats.
      const accessLines = warn.mock.calls.filter((c) => /\[auth\] GET \/api\/v1\/auth\/google\/poll.*awaiting_code:address_different_network/.test(String(c[0])));
      expect(accessLines).toHaveLength(1);

      // The page is still open, the human types what it shows.
      const done = await json(`/google/poll?session_id=${id}&code=${printed.slice(0, 5)}-${printed.slice(5).toLowerCase()}`, { 'x-forwarded-for': '169.150.224.3' });
      expect(done.status).toBe('success');
      expect(await json(`/google/handoff-status?session_id=${id}`)).toEqual({ state: 'redeemed' });
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
