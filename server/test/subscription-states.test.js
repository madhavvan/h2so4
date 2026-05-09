// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  subscriptionStates — license state machine canonical
//
//  Pins the state machine. Renaming or removing a status is a
//  load-bearing change (renderer + every webhook handler reads
//  these values) — these tests catch accidental drift.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  LICENSE_STATUSES, ALL_STATUSES, ACCESS_STATUSES, TERMINAL_STATUSES,
  isValidStatus, hasAccess, isTerminal, assertValidStatus,
} = require('../src/services/subscriptionStates.js');

describe('LICENSE_STATUSES — canonical set', () => {
  it('exports every documented status', () => {
    expect(LICENSE_STATUSES.TRIAL).toBe('trial');
    expect(LICENSE_STATUSES.ACTIVE).toBe('active');
    expect(LICENSE_STATUSES.CANCELING).toBe('canceling');
    expect(LICENSE_STATUSES.PAST_DUE).toBe('past_due');
    expect(LICENSE_STATUSES.EXPIRED).toBe('expired');
    expect(LICENSE_STATUSES.REFUNDED).toBe('refunded');
    expect(LICENSE_STATUSES.PAUSED).toBe('paused');
    expect(LICENSE_STATUSES.REVOKED).toBe('revoked');
    expect(LICENSE_STATUSES.DISPUTED).toBe('disputed');
  });

  it('is frozen so accidental writes throw', () => {
    expect(() => { LICENSE_STATUSES.ACTIVE = 'mutated'; }).toThrow();
  });

  it('ALL_STATUSES has 9 entries (count drift = explicit decision)', () => {
    expect(ALL_STATUSES.size).toBe(9);
  });
});

describe('isValidStatus', () => {
  it('accepts every canonical status', () => {
    for (const s of ALL_STATUSES) expect(isValidStatus(s)).toBe(true);
  });
  it('rejects typos / unknown', () => {
    expect(isValidStatus('cancling')).toBe(false);  // typo
    expect(isValidStatus('past-due')).toBe(false);  // wrong separator
    expect(isValidStatus('PAID')).toBe(false);       // case
    expect(isValidStatus('')).toBe(false);
    expect(isValidStatus(null)).toBe(false);
    expect(isValidStatus(undefined)).toBe(false);
  });
});

describe('hasAccess — license retains AI access', () => {
  it('active / canceling / past_due → access', () => {
    expect(hasAccess('active')).toBe(true);
    expect(hasAccess('canceling')).toBe(true);
    expect(hasAccess('past_due')).toBe(true);
  });
  it('trial does NOT have AI access (free-tier with quota only)', () => {
    expect(hasAccess('trial')).toBe(false);
  });
  it('terminal states deny access', () => {
    expect(hasAccess('expired')).toBe(false);
    expect(hasAccess('refunded')).toBe(false);
    expect(hasAccess('revoked')).toBe(false);
    expect(hasAccess('paused')).toBe(false);
    expect(hasAccess('disputed')).toBe(false);
  });
});

describe('isTerminal', () => {
  it('expired / refunded / revoked → terminal', () => {
    expect(isTerminal('expired')).toBe(true);
    expect(isTerminal('refunded')).toBe(true);
    expect(isTerminal('revoked')).toBe(true);
  });
  it('canceling is NOT terminal (still in cycle)', () => {
    expect(isTerminal('canceling')).toBe(false);
  });
  it('past_due / paused / disputed are NOT terminal (recoverable)', () => {
    expect(isTerminal('past_due')).toBe(false);
    expect(isTerminal('paused')).toBe(false);
    expect(isTerminal('disputed')).toBe(false);
  });
});

describe('assertValidStatus — write-time validation', () => {
  it('passes for valid statuses', () => {
    expect(() => assertValidStatus('active')).not.toThrow();
    expect(() => assertValidStatus('past_due')).not.toThrow();
  });
  it('throws INVALID_LICENSE_STATUS on typo', () => {
    expect(() => assertValidStatus('cancling')).toThrow(/Invalid license\.status/);
    try {
      assertValidStatus('cancling');
    } catch (err) {
      expect(err.code).toBe('INVALID_LICENSE_STATUS');
    }
  });
  it('throws on null / undefined / non-string', () => {
    expect(() => assertValidStatus(null)).toThrow();
    expect(() => assertValidStatus(undefined)).toThrow();
    expect(() => assertValidStatus(42)).toThrow();
  });
});

describe('partition exhaustiveness — every status is access or denied', () => {
  // Sanity: ACCESS_STATUSES + non-access statuses = ALL_STATUSES with no overlap.
  it('access + denied union equals all statuses', () => {
    const denied = [...ALL_STATUSES].filter(s => !ACCESS_STATUSES.has(s));
    const union = new Set([...ACCESS_STATUSES, ...denied]);
    expect(union.size).toBe(ALL_STATUSES.size);
  });
});
