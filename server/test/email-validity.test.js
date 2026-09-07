// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  IS THIS ADDRESS EVEN REACHABLE? — services/emailValidity.js
//
//  The rules, each pinned: a one-letter slip on a consumer domain is
//  corrected; a real domain one letter from a popular one is never
//  "corrected"; a domain with no MX and no A record is refused; DNS
//  trouble fails OPEN; verdicts are cached; the kill switch works.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ev = require('../src/services/emailValidity.js');

const notFound = (code = 'ENOTFOUND') => Object.assign(new Error(code), { code });
const fake = ({ mx = {}, a = {} } = {}) => {
  const calls = { mx: 0, a: 0 };
  const pick = (table, d) => {
    const v = table[d];
    if (v instanceof Error) return Promise.reject(v);
    if (typeof v === 'function') return v();
    return Promise.resolve(v === undefined ? [] : v);
  };
  return {
    calls,
    resolveMx: (d) => { calls.mx++; return pick(mx, d); },
    resolve4: (d) => { calls.a++; return pick(a, d); },
  };
};

beforeEach(() => { ev._test.clearCache(); ev._test.setTimeoutMs(200); delete process.env.SIGNUP_DNS_CHECK; });
afterEach(() => { ev._test.setResolver(null); ev._test.setTimeoutMs(null); delete process.env.SIGNUP_DNS_CHECK; });

describe('the typo table', () => {
  it('corrects a single slip on a popular domain, including a transposition', () => {
    expect(ev.suggestDomain('gmial.com')).toBe('gmail.com');
    expect(ev.suggestDomain('gmail.con')).toBe('gmail.com');
    expect(ev.suggestDomain('gmail.co')).toBe('gmail.com');
    expect(ev.suggestDomain('gamil.com')).toBe('gmail.com');
    expect(ev.suggestDomain('yaho.com')).toBe('yahoo.com');
    expect(ev.suggestDomain('hotmal.com')).toBe('hotmail.com');
    expect(ev.suggestDomain('outlok.com')).toBe('outlook.com');
    expect(ev.suggestDomain('iclod.com')).toBe('icloud.com');
  });
  it('never "corrects" a real domain that happens to sit one letter away', () => {
    for (const d of ['ymail.com', 'mail.com', 'me.com', 'mac.com', 'gmail.com', 'yahoo.com', 'pm.me']) {
      expect(ev.suggestDomain(d), d).toBeNull();
    }
  });
  it('leaves corporate and unusual domains alone', () => {
    for (const d of ['company.io', 'iu.edu', 'lilly.com', 'anaxis.ai', 'x.co']) {
      expect(ev.suggestDomain(d), d).toBeNull();
    }
  });
});

describe('the verdict', () => {
  it('a big-five slip is refused with the corrected address, even without asking DNS', async () => {
    const r = fake();
    ev._test.setResolver(r);
    const v = await ev.checkEmailDeliverable('Venu.Madhav@gmail.con');
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('typo');
    expect(v.suggestion).toBe('venu.madhav@gmail.com');
    expect(v.message).toContain('Did you mean venu.madhav@gmail.com?');
    expect(r.calls.mx + r.calls.a).toBe(0);
  });

  it('a slip on a smaller popular domain is refused only when the typo domain has no mail records', async () => {
    ev._test.setResolver(fake({ mx: { 'zoho.co': [{ exchange: 'mx.real', priority: 10 }] } }));
    expect((await ev.checkEmailDeliverable('a@zoho.co')).ok).toBe(true);
    ev._test.clearCache();
    ev._test.setResolver(fake({ mx: { 'zoho.co': notFound() }, a: { 'zoho.co': notFound() } }));
    const v = await ev.checkEmailDeliverable('a@zoho.co');
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('typo');
    expect(v.suggestion).toBe('a@zoho.com');
  });

  it('a domain with MX records is fine; a null MX plus no A record is not', async () => {
    ev._test.setResolver(fake({ mx: { 'lilly.com': [{ exchange: 'mx1.lilly.com', priority: 10 }] } }));
    expect(await ev.checkEmailDeliverable('x@lilly.com')).toEqual({ ok: true, reason: 'mx' });
    ev._test.setResolver(fake({ mx: { 'nomail.example': [{ exchange: '', priority: 0 }] }, a: { 'nomail.example': notFound('ENODATA') } }));
    const v = await ev.checkEmailDeliverable('x@nomail.example');
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('no_mx');
    expect(v.message).toContain("nomail.example doesn't accept email");
  });

  it('no MX but an A record still passes (RFC 5321 fallback); nothing at all is refused', async () => {
    ev._test.setResolver(fake({ mx: { 'tiny.example': notFound('ENODATA') }, a: { 'tiny.example': ['203.0.113.7'] } }));
    expect(await ev.checkEmailDeliverable('x@tiny.example')).toEqual({ ok: true, reason: 'a_record' });
    ev._test.setResolver(fake({ mx: { 'gmail.cmo': notFound() }, a: { 'gmail.cmo': notFound() } }));
    // "gmail.cmo" is a big-five slip → typo, not no_mx: the correction is the more useful answer.
    expect((await ev.checkEmailDeliverable('x@gmail.cmo')).reason).toBe('typo');
    ev._test.setResolver(fake({ mx: { 'venu-typo.con': notFound() }, a: { 'venu-typo.con': notFound() } }));
    expect((await ev.checkEmailDeliverable('x@venu-typo.con')).reason).toBe('no_mx');
  });

  it('a resolver that times out or errors transiently FAILS OPEN and is not cached', async () => {
    const hang = () => new Promise(() => {});
    const r = fake({ mx: { 'slow.example': hang }, a: { 'slow.example': hang } });
    ev._test.setResolver(r);
    const t0 = Date.now();
    const v = await ev.checkEmailDeliverable('x@slow.example');
    expect(v).toEqual({ ok: true, reason: 'dns_unavailable' });
    expect(Date.now() - t0).toBeLessThan(1500);
    // SERVFAIL-style errors are transient too.
    ev._test.setResolver(fake({ mx: { 'flaky.example': Object.assign(new Error('x'), { code: 'ESERVFAIL' }) } }));
    expect((await ev.checkEmailDeliverable('x@flaky.example')).ok).toBe(true);
    // Not cached: the next call asks again.
    const again = fake({ mx: { 'flaky.example': [{ exchange: 'mx', priority: 1 }] } });
    ev._test.setResolver(again);
    expect(await ev.checkEmailDeliverable('x@flaky.example')).toEqual({ ok: true, reason: 'mx' });
    expect(again.calls.mx).toBe(1);
  });

  it('a definitive verdict is cached per domain', async () => {
    const r = fake({ mx: { 'iu.edu': [{ exchange: 'mx.iu.edu', priority: 5 }] } });
    ev._test.setResolver(r);
    await ev.checkEmailDeliverable('a@iu.edu');
    await ev.checkEmailDeliverable('b@iu.edu');
    await ev.checkEmailDeliverable('c@IU.EDU');
    expect(r.calls.mx).toBe(1);
  });

  it('SIGNUP_DNS_CHECK=off skips DNS but keeps the big-five correction', async () => {
    process.env.SIGNUP_DNS_CHECK = 'off';
    const r = fake();
    ev._test.setResolver(r);
    expect(await ev.checkEmailDeliverable('x@whatever.example')).toEqual({ ok: true, reason: 'disabled' });
    expect((await ev.checkEmailDeliverable('x@gmial.com')).reason).toBe('typo');
    expect(r.calls.mx + r.calls.a).toBe(0);
  });

  it('never throws on garbage', async () => {
    for (const bad of ['', null, undefined, 'nope', '@x.com', 'x@']) {
      const v = await ev.checkEmailDeliverable(bad);
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('format');
    }
  });
});
