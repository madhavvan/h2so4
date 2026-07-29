// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RATE LIMIT KEYING — a person, or an address?
//
//  The general limiter counted every request against the client IP. An IP
//  is not a person: an office, campus, coworking space or corporate VPN
//  puts everyone behind one address, so colleagues shared one 60/min
//  bucket and starved each other. Measured, a live interview costs ~4
//  requests per question plus a heartbeat every 20s — ~27 req/min at a
//  normal pace, ~51 rapid-fire. Two users on one router sat at the
//  ceiling; a third pushed everyone over. What gets refused is whatever
//  arrives next, and that includes the answer request in a live interview.
//
//  rateLimitIdentity keys signed-in traffic by verified user id and leaves
//  anonymous traffic on the IP.
//
//  The security property these tests exist for: the user id is trusted
//  ONLY after jwt.verify. This limiter fronts every endpoint including the
//  unauthenticated ones, so if it trusted an unverified JWT payload then
//  rotating a made-up `id` would mint unlimited buckets and dissolve the
//  brute-force cap on login, the reset-mail cap, and every other IP-scoped
//  protection behind it. Forged, tampered, expired and malformed tokens
//  must all fall back to the IP.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');
const { rateLimitIdentity } = require('../src/middleware/rateLimitKey.js');

const SECRET = process.env.JWT_SECRET;
const IP = '203.0.113.7';

function reqWith(authorization, ip = IP) {
  return { ip, headers: authorization ? { authorization } : {} };
}
function bearerFor(payload, opts = {}, secret = SECRET) {
  return `Bearer ${jwt.sign(payload, secret, { expiresIn: '14d', ...opts })}`;
}

describe('rateLimitIdentity — signed-in traffic is keyed by user', () => {
  it('keys a valid token by user id, not by address', () => {
    const id = rateLimitIdentity(reqWith(bearerFor({ id: 'user-abc', email: 'a@b.c', tier: 'pro' })));
    expect(id.key).toBe('u:user-abc');
    expect(id.authenticated).toBe(true);
    expect(id.ip).toBe(IP); // still exposed for the IP-scoped limiters
  });

  it('gives two users behind ONE address two separate buckets', () => {
    const a = rateLimitIdentity(reqWith(bearerFor({ id: 'colleague-a' }), IP));
    const b = rateLimitIdentity(reqWith(bearerFor({ id: 'colleague-b' }), IP));
    expect(a.key).not.toBe(b.key);
    expect(a.ip).toBe(b.ip); // same router, different buckets — the whole point
  });

  it('follows one user across addresses (laptop -> phone tether)', () => {
    const home = rateLimitIdentity(reqWith(bearerFor({ id: 'same-person' }), '198.51.100.4'));
    const cafe = rateLimitIdentity(reqWith(bearerFor({ id: 'same-person' }), '192.0.2.99'));
    expect(home.key).toBe(cafe.key);
  });
});

describe('rateLimitIdentity — anonymous traffic stays on the IP', () => {
  it('falls back to the IP with no Authorization header', () => {
    const id = rateLimitIdentity(reqWith(null));
    expect(id.key).toBe(IP);
    expect(id.authenticated).toBe(false);
  });

  it('falls back for a non-Bearer scheme', () => {
    expect(rateLimitIdentity(reqWith('Basic dXNlcjpwYXNz')).key).toBe(IP);
  });

  it('falls back for an empty Bearer', () => {
    expect(rateLimitIdentity(reqWith('Bearer ')).key).toBe(IP);
    expect(rateLimitIdentity(reqWith('Bearer    ')).authenticated).toBe(false);
  });

  it('never returns undefined when the address is unavailable', () => {
    expect(rateLimitIdentity({ headers: {} }).key).toBe('unknown');
    expect(rateLimitIdentity({}).key).toBe('unknown');
  });
});

describe('rateLimitIdentity — a token is only trusted once verified', () => {
  it('REJECTS a forged token whose payload claims any id it likes', () => {
    // The attack the signature check exists to stop: hand-assemble a JWT
    // with a junk signature, rotate `id`, and mint a fresh bucket per
    // request — which would defeat the limiter on every endpoint.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    for (const fakeId of ['attacker-1', 'attacker-2', 'attacker-3']) {
      const payload = Buffer.from(JSON.stringify({ id: fakeId })).toString('base64url');
      const forged = `Bearer ${header}.${payload}.not-a-real-signature`;
      const id = rateLimitIdentity(reqWith(forged));
      expect(id.key).toBe(IP);          // all three land in the SAME bucket
      expect(id.authenticated).toBe(false);
    }
  });

  it('rejects a token signed with the wrong secret', () => {
    const id = rateLimitIdentity(reqWith(bearerFor({ id: 'user-abc' }, {}, 'wrong-secret')));
    expect(id.key).toBe(IP);
    expect(id.authenticated).toBe(false);
  });

  it('rejects a tampered payload on an otherwise real token', () => {
    const real = jwt.sign({ id: 'real-user' }, SECRET, { expiresIn: '14d' });
    const [h, , s] = real.split('.');
    const swapped = Buffer.from(JSON.stringify({ id: 'someone-else' })).toString('base64url');
    const id = rateLimitIdentity(reqWith(`Bearer ${h}.${swapped}.${s}`));
    expect(id.key).toBe(IP);
  });

  it('rejects an expired token (no private bucket after sign-out)', () => {
    const id = rateLimitIdentity(reqWith(bearerFor({ id: 'user-abc' }, { expiresIn: '-1s' })));
    expect(id.key).toBe(IP);
    expect(id.authenticated).toBe(false);
  });

  it('rejects structurally malformed tokens without throwing', () => {
    for (const junk of ['Bearer abc', 'Bearer a.b', 'Bearer a.b.c.d', 'Bearer ...', 'Bearer {}']) {
      expect(() => rateLimitIdentity(reqWith(junk))).not.toThrow();
      expect(rateLimitIdentity(reqWith(junk)).key).toBe(IP);
    }
  });

  it('rejects a validly-signed token that carries no id claim', () => {
    const id = rateLimitIdentity(reqWith(bearerFor({ email: 'a@b.c', tier: 'pro' })));
    expect(id.key).toBe(IP);
    expect(id.authenticated).toBe(false);
  });
});
