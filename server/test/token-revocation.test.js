// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  FORCE-LOGOUT (tokens_revoked_after) — the control with no tests.
//
//  This is what makes "change your password" mean anything. A JWT here
//  lives 14 days and is a bearer token: nothing about changing a
//  password invalidates a copy an attacker already holds. The ONLY thing
//  that does is `tokens_revoked_after` — a per-user timestamp that every
//  auth surface compares against the token's `iat`.
//
//  It had zero test coverage, which is a bad property for a control
//  whose failure mode is silent: if the comparison broke, every surface
//  would keep working perfectly and password resets would simply stop
//  evicting anyone. Nobody finds that by using the product.
//
//  There is also a subtle invariant worth pinning. The cutoff floors to
//  a whole second, and `iat` is in whole seconds. A password reset that
//  revokes AND reissues in the same request produces a token whose
//  iat*1000 EQUALS the cutoff — so the comparison has to be strictly
//  `<`. Change it to `<=` and password reset signs the user out of the
//  session it just gave them.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

process.env.JWT_SECRET = 'test-secret-revocation';
process.env.DATABASE_PATH = ':memory:';

const dbMod = require('../src/database.js');
let revokedAfter = 0;
dbMod.getTokensRevokedAfter = () => revokedAfter;

const { generateToken, authMiddleware } = require('../src/middleware/auth.js');

function run(token) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
  const res = {
    statusCode: 0,
    payload: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; return this; },
  };
  const next = vi.fn();
  authMiddleware(req, res, next);
  return { req, res, passed: next.mock.calls.length === 1 };
}

beforeEach(() => { revokedAfter = 0; });

describe('tokens_revoked_after — force logout', () => {
  it('lets a token through when nothing has been revoked', () => {
    const { passed } = run(generateToken({ id: 'u1', email: 'a@b.com' }));
    expect(passed).toBe(true);
  });

  it('rejects a token issued BEFORE the revocation point', () => {
    const token = generateToken({ id: 'u1', email: 'a@b.com' });
    // Revoke one hour into the future relative to this token's iat.
    revokedAfter = Date.now() + 3600_000;
    const { passed, res } = run(token);
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.payload.error).toMatch(/revoked/i);
  });

  it('lets a token issued AFTER the revocation point through', () => {
    revokedAfter = Date.now() - 3600_000;
    const { passed } = run(generateToken({ id: 'u1', email: 'a@b.com' }));
    expect(passed).toBe(true);
  });

  it('survives a token reissued in the same second as the revocation', () => {
    // The applyPasswordReset shape: revoke, then immediately mint the
    // replacement session. Both land in the same whole second, so
    // iat*1000 === cutoff. A `<=` comparison would sign the user out of
    // the session the reset just handed them, on every password reset.
    const now = Date.now();
    revokedAfter = Math.floor(now / 1000) * 1000;
    const token = generateToken({ id: 'u1', email: 'a@b.com' });
    const decoded = require('jsonwebtoken').decode(token);
    expect(decoded.iat * 1000).toBe(revokedAfter); // the boundary really is exercised
    expect(run(token).passed).toBe(true);
  });

  it('still rejects an unsigned or tampered token before revocation is consulted', () => {
    expect(run('not-a-jwt').passed).toBe(false);
    expect(run(undefined).passed).toBe(false);
  });

  it('does not break for a token with no id claim', () => {
    // The revocation lookup is keyed on decoded.id. A token without one
    // must not throw its way into a 500 — it simply cannot be revoked
    // per-user, and the signature check already vouched for it.
    revokedAfter = Date.now() + 3600_000;
    const token = generateToken({ email: 'a@b.com' });
    expect(run(token).passed).toBe(true);
  });
});

describe('revokeOtherSessions writes a cutoff the check can use', () => {
  it('floors to a whole second so a same-request reissue survives', () => {
    // Read the implementation rather than executing it against a real DB:
    // the property under test is the flooring, and it is expressed in one
    // line that a refactor could quietly drop.
    const src = fs.readFileSync(path.join(here, '..', 'src', 'database.js'), 'utf8');
    const fn = src.slice(src.indexOf('function revokeOtherSessions'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/Math\.floor\(Date\.now\(\)\s*\/\s*1000\)\s*\*\s*1000/);
  });
});

describe('every auth surface consults the revocation list', () => {
  // The gap this catches is a new authenticated entry point that verifies
  // the signature and stops there. That surface would keep honouring
  // tokens every other path has already evicted — which is precisely how
  // the WS remote-join hole (H45) existed.
  const surfaces = [
    ['REST authMiddleware', 'src/middleware/auth.js'],
    ['support WebSocket join', 'src/index.js'],
    ['phone remote-channel join', 'src/services/remoteChannel.js'],
  ];

  for (const [label, rel] of surfaces) {
    it(`${label} checks tokens_revoked_after`, () => {
      const text = fs.readFileSync(path.join(here, '..', rel), 'utf8');
      expect(text).toMatch(/getTokensRevokedAfter/);
      // and actually compares it against the token's issue time
      expect(text).toMatch(/iat\s*\*\s*1000\s*<\s*revokedAfter/);
    });
  }
});
