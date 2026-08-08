// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ABUSE LIMITERS — counting on the right axis
//
//  Login, signup and forgot-password were each protected by a single
//  per-IP bucket. That is one axis, and it was wrong in both directions
//  at once:
//
//    TOO WEAK. There was no per-account counter anywhere in the codebase —
//    no failed_attempts column, no lockout table, nothing. So an attacker
//    renting residential IPs got a FRESH 10-attempt budget per address
//    against one target email, and a distributed brute force on a specific
//    account was effectively unlimited. Same for reset mail: rotating IPs
//    reset the counter, so one inbox could be bombed indefinitely.
//    Measured against the old build: 20 guesses from 20 IPs -> zero
//    blocked; 10 reset mails from 10 IPs -> zero blocked.
//
//    TOO STRICT. One office, campus or VPN is one IP. At 10 attempts per
//    5 minutes, the eleventh colleague to sign in was refused entry to
//    their own account. Measured against the old build: 20 colleagues on
//    one address -> 10 in, 10 refused.
//
//  The fix is two axes. A tight bucket on the ACCOUNT (which an attacker
//  cannot change by renting another address) and a loose one on the IP
//  (which now only has to stop one source spraying many accounts). Both
//  must pass.
//
//  These tests cover the key derivation and the bucket behaviour. The
//  end-to-end HTTP proof of all four scenarios above lives alongside them
//  in the same fix; this file is what keeps the properties from silently
//  regressing.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const require = createRequire(import.meta.url);
const { rateLimitAccountKey } = require('../src/middleware/rateLimitKey.js');
const {
  loginAccountLimiter,
  loginIpLimiter,
  forgotAccountLimiter,
  clearLoginAttempts,
} = require('../src/middleware/rateLimiters.js');

const reqWith = (body) => ({ ip: '203.0.113.7', headers: {}, body });

describe('rateLimitAccountKey — which account is being attacked', () => {
  it('keys on the email being acted on', () => {
    expect(rateLimitAccountKey(reqWith({ email: 'victim@example.com' }))).toBe('a:victim@example.com');
  });

  it('normalises case and surrounding whitespace', () => {
    // Without this an attacker doubles their budget by alternating
    // capitalisation, and the key stops matching how accounts are stored
    // (database.js lowercases on write).
    const keys = [
      rateLimitAccountKey(reqWith({ email: 'Victim@Example.com' })),
      rateLimitAccountKey(reqWith({ email: '  victim@example.com  ' })),
      rateLimitAccountKey(reqWith({ email: 'VICTIM@EXAMPLE.COM' })),
    ];
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('a:victim@example.com');
  });

  it('returns null when there is no usable email', () => {
    // Not a bypass: a login with no email authenticates nobody, and the
    // IP bucket still applies.
    expect(rateLimitAccountKey(reqWith({}))).toBeNull();
    expect(rateLimitAccountKey(reqWith({ email: '' }))).toBeNull();
    expect(rateLimitAccountKey(reqWith({ email: '   ' }))).toBeNull();
    expect(rateLimitAccountKey(reqWith({ email: 12345 }))).toBeNull();
    expect(rateLimitAccountKey({ ip: '1.2.3.4', headers: {} })).toBeNull();
    expect(rateLimitAccountKey({})).toBeNull();
  });

  it('rejects an absurdly long address rather than making it a key', () => {
    expect(rateLimitAccountKey(reqWith({ email: 'a'.repeat(300) + '@x.com' }))).toBeNull();
  });
});

describe('login — the account bucket survives a change of address', () => {
  it('blocks a distributed brute force on one account', async () => {
    const key = rateLimitAccountKey(reqWith({ email: 'target-1@example.com' }));
    // Every one of these is a different source IP. Only the account key
    // is consumed, which is the entire point.
    let blockedAt = null;
    for (let i = 1; i <= 15; i++) {
      try { await loginAccountLimiter.consume(key); }
      catch { blockedAt = i; break; }
    }
    expect(blockedAt).toBe(11); // 10 allowed, 11th refused
  });

  it('does not let one account\'s failures affect another', async () => {
    const a = rateLimitAccountKey(reqWith({ email: 'target-2@example.com' }));
    const b = rateLimitAccountKey(reqWith({ email: 'bystander@example.com' }));
    for (let i = 0; i < 10; i++) await loginAccountLimiter.consume(a);
    await expect(loginAccountLimiter.consume(a)).rejects.toBeDefined();
    await expect(loginAccountLimiter.consume(b)).resolves.toBeDefined();
  });

  it('clears on a successful sign-in, so the right password never locks you out', async () => {
    const email = 'target-3@example.com';
    const key = rateLimitAccountKey(reqWith({ email }));
    for (let i = 0; i < 9; i++) await loginAccountLimiter.consume(key);

    await clearLoginAttempts(email);

    // A full budget again — a user reinstalling or bouncing between the
    // main window and the popout cannot lock themselves out.
    for (let i = 0; i < 10; i++) {
      await expect(loginAccountLimiter.consume(key)).resolves.toBeDefined();
    }
  });

  it('clearLoginAttempts normalises the address and tolerates junk', async () => {
    const key = rateLimitAccountKey(reqWith({ email: 'target-4@example.com' }));
    for (let i = 0; i < 10; i++) await loginAccountLimiter.consume(key);
    await clearLoginAttempts('  Target-4@Example.com  '); // different casing/spacing
    await expect(loginAccountLimiter.consume(key)).resolves.toBeDefined();

    // Never throws on nonsense — this runs inside a successful login and
    // must not be able to fail one.
    await expect(clearLoginAttempts(undefined)).resolves.toBeUndefined();
    await expect(clearLoginAttempts('')).resolves.toBeUndefined();
    await expect(clearLoginAttempts(42)).resolves.toBeUndefined();
  });
});

describe('login — the IP bucket is now anti-spraying, not anti-guessing', () => {
  it('lets a full office sign in from one address', async () => {
    // 20 colleagues behind one NAT. The old cap was 10 per 5 minutes,
    // which refused colleague 11 entry to their own account.
    const officeIp = '198.51.100.77';
    for (let i = 0; i < 20; i++) {
      await expect(loginIpLimiter.consume(officeIp)).resolves.toBeDefined();
    }
  });

  it('still stops one source spraying many accounts', async () => {
    const sprayerIp = '198.51.100.78';
    let blockedAt = null;
    for (let i = 1; i <= 80; i++) {
      try { await loginIpLimiter.consume(sprayerIp); }
      catch { blockedAt = i; break; }
    }
    expect(blockedAt).toBe(61); // 60 allowed per 5 min from one address
  });
});

describe('forgot-password — the inbox is the limit, not the attacker\'s IP budget', () => {
  it('caps reset mail per address regardless of where it comes from', async () => {
    const key = rateLimitAccountKey(reqWith({ email: 'bombed@example.com' }));
    let blockedAt = null;
    for (let i = 1; i <= 10; i++) {
      try { await forgotAccountLimiter.consume(key); }
      catch { blockedAt = i; break; }
    }
    expect(blockedAt).toBe(4); // 3 mails per hour to one inbox
  });

  it('one bombed inbox does not block anyone else\'s reset', async () => {
    const bombed = rateLimitAccountKey(reqWith({ email: 'bombed-2@example.com' }));
    const normal = rateLimitAccountKey(reqWith({ email: 'normal@example.com' }));
    for (let i = 0; i < 3; i++) await forgotAccountLimiter.consume(bombed);
    await expect(forgotAccountLimiter.consume(bombed)).rejects.toBeDefined();
    await expect(forgotAccountLimiter.consume(normal)).resolves.toBeDefined();
  });
});
