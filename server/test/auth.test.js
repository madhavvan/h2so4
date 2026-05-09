// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  JWT sign + verify roundtrip
//
//  A regression in this path = silent auth bypass. Specifically,
//  swapping crypto.timingSafeEqual for === in any future "fast
//  path" introduces a timing oracle the attacker can use to derive
//  the signing secret one bit at a time.
//
//  We can't easily test timing safety from a unit test (it would
//  flake), but we CAN pin: (a) the roundtrip works, (b) tampered
//  tokens are rejected, (c) wrong-secret tokens are rejected,
//  (d) expired tokens are rejected.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeAll } from 'vitest';

// Set JWT_SECRET BEFORE requiring the module — the module reads it at
// import time and process.exit(1)'s if absent in production.
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
});

const { generateToken, verifyToken } = await import('../src/middleware/auth.js');

describe('JWT auth', () => {
  it('round-trips a payload', () => {
    const payload = { id: 'user_123', email: 'test@example.com' };
    const token = generateToken(payload);
    const decoded = verifyToken(token);
    expect(decoded.id).toBe('user_123');
    expect(decoded.email).toBe('test@example.com');
  });

  it('rejects a tampered token', () => {
    const token = generateToken({ id: 'user_123' });
    // Flip a byte in the middle (the payload section)
    const parts = token.split('.');
    const tampered = parts[0] + '.' + parts[1].replace(/[A-Za-z]/, 'x') + '.' + parts[2];
    expect(() => verifyToken(tampered)).toThrow();
  });

  it('rejects a token signed with a different secret', () => {
    const jwt = require('jsonwebtoken');
    const otherToken = jwt.sign({ id: 'attacker' }, 'wrong-secret');
    expect(() => verifyToken(otherToken)).toThrow();
  });

  it('rejects an expired token', () => {
    const token = generateToken({ id: 'user_123' }, '1ms');
    return new Promise(r => setTimeout(r, 50)).then(() => {
      expect(() => verifyToken(token)).toThrow();
    });
  });

  it('respects expiresIn parameter', () => {
    // 10s token still valid — shouldn't throw
    const token = generateToken({ id: 'u' }, '10s');
    const decoded = verifyToken(token);
    expect(decoded.id).toBe('u');
    expect(decoded.exp).toBeGreaterThan(Date.now() / 1000);
    expect(decoded.exp).toBeLessThan(Date.now() / 1000 + 11);
  });
});
