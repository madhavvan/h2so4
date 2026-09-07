// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  IS THIS ADDRESS EVEN REACHABLE?  (signup only)
//
//  The username box takes any string with an @ and a dot in it, and real
//  signups carry domains like "gmail.con" and "gamil.com" — addresses no
//  mail will ever reach, which matters the moment a welcome mail, a receipt
//  or a password reset has to get there. Two cheap checks, both bounded:
//
//    1. A one-character slip on a consumer domain ("gmial.com") is answered
//       with the correction, not a bare rejection: "Did you mean
//       venu@gmail.com?" — the `error` string the client already displays.
//    2. The domain must publish MX records (or, per RFC 5321 §5.1, an A
//       record). Only a DEFINITIVE answer — no such domain, no records —
//       refuses. A slow or broken resolver fails OPEN: DNS trouble on the
//       server must never stop a signup. SIGNUP_DNS_CHECK=off disables the
//       DNS half at runtime without a deploy (=on forces it, even in tests).
//
//  Never applied to Google sign-in (Google verified the address), to
//  login, or to forgot-password (which must not leak whether an address is
//  registered). Accounts created before this check keep logging in.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const dns = require('node:dns');

const DNS_TIMEOUT_MS = 1500;
const POSITIVE_TTL_MS = 60 * 60 * 1000;   // a domain that accepts mail keeps accepting it
const NEGATIVE_TTL_MS = 10 * 60 * 1000;   // a typo domain might be registered tomorrow — recheck sooner

// The domains a one-character slip is measured against. Consumer mail only:
// a corporate domain one letter from another corporate domain is a
// coincidence, not a typo.
const POPULAR = [
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com',
  'aol.com', 'protonmail.com', 'proton.me', 'live.com', 'msn.com', 'yahoo.co.in',
  'rediffmail.com', 'ymail.com', 'mail.com', 'gmx.com', 'me.com', 'zoho.com',
  'yandex.com', 'hotmail.co.uk', 'yahoo.co.uk', 'outlook.in', 'googlemail.com',
];
// The big five are corrected even when the misspelt domain exists: those
// are exactly the domains squatters register to catch misdirected mail
// (gmial.com has MX records; nothing sent there reaches the person).
const TOP_FIVE = new Set(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com']);
// Real domains within one edit of a popular one that must never be
// "corrected": mail.com and ymail.com sit one letter from gmail.com.
const LEGIT = new Set([
  ...POPULAR, 'hey.com', 'pm.me', 'fastmail.com', 'duck.com', 'tuta.com', 'tutanota.com',
  'mail.ru', 'qq.com', '163.com', 'naver.com', 'web.de', 'gmx.de', 'gmx.net',
  'live.in', 'live.co.uk', 'yahoo.in', 'yahoo.fr', 'yahoo.de', 'mac.com', 'msn.co.uk',
]);

/** Optimal-string-alignment distance: Levenshtein plus adjacent transposition. */
function osa(a, b) {
  const m = a.length; const n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

/** The popular domain this one is a single slip away from, or null. */
function suggestDomain(domain) {
  const dom = String(domain || '').toLowerCase();
  if (!dom || LEGIT.has(dom)) return null;
  let best = null;
  for (const p of POPULAR) {
    if (Math.abs(p.length - dom.length) > 1) continue;
    if (osa(dom, p) <= 1) { best = p; break; }
  }
  return best;
}

// ── DNS, bounded and cached ──
let _resolver = {
  resolveMx: (d) => dns.promises.resolveMx(d),
  resolve4: (d) => dns.promises.resolve4(d),
};
let _timeoutMs = DNS_TIMEOUT_MS;
// Set by _test.setResolver. Under the test runner the network is never
// touched unless a test injected a resolver: the auth suites sign up
// made-up domains by the dozen, and a real lookup per signup is both slow
// and a verdict about the machine's DNS, not about the code.
let _injected = false;
function dnsActive() {
  if (process.env.SIGNUP_DNS_CHECK === 'off') return false;
  if (process.env.SIGNUP_DNS_CHECK === 'on') return true;
  if (process.env.VITEST && !_injected) return false;
  return true;
}
const _cache = new Map();
const DEFINITIVE = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('dns timeout'), { code: 'ETIMEOUT' })), ms);
    Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function aRecordFallback(domain) {
  try {
    const a = await withTimeout(_resolver.resolve4(domain), _timeoutMs);
    return Array.isArray(a) && a.length > 0 ? { ok: true, reason: 'a_record' } : { ok: false, reason: 'no_mx' };
  } catch (err) {
    return DEFINITIVE.has(err && err.code) ? { ok: false, reason: 'no_mx' } : { ok: true, reason: 'dns_unavailable' };
  }
}

/** Does this domain publish somewhere to deliver mail? Definitive no → false; DNS trouble → true. */
async function domainAcceptsMail(domain) {
  const hit = _cache.get(domain);
  if (hit && Date.now() - hit.at < (hit.ok ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS)) return hit;
  let verdict;
  try {
    const mx = await withTimeout(_resolver.resolveMx(domain), _timeoutMs);
    // RFC 7505 "null MX" (a single record with an empty exchange) means the
    // domain accepts NO mail at all.
    const real = Array.isArray(mx) ? mx.filter((r) => r && r.exchange && r.exchange !== '.') : [];
    verdict = real.length > 0 ? { ok: true, reason: 'mx' } : await aRecordFallback(domain);
  } catch (err) {
    verdict = DEFINITIVE.has(err && err.code) ? await aRecordFallback(domain) : { ok: true, reason: 'dns_unavailable' };
  }
  // A transient failure is not knowledge — never cache it.
  if (verdict.reason !== 'dns_unavailable') _cache.set(domain, { ...verdict, at: Date.now() });
  return verdict;
}

function typo(local, domain, suggestion) {
  return {
    ok: false,
    reason: 'typo',
    suggestion: `${local}@${suggestion}`,
    message: `Did you mean ${local}@${suggestion}? If ${domain} really is your address, write to support@minicaai.com.`,
  };
}

/**
 * The signup verdict. Always resolves; never throws.
 *   { ok: true,  reason: 'mx' | 'a_record' | 'dns_unavailable' | 'disabled' }
 *   { ok: false, reason: 'typo' | 'no_mx' | 'format', message, suggestion? }
 */
async function checkEmailDeliverable(email) {
  const s = String(email || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return { ok: false, reason: 'format', message: 'Invalid email format' };
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);

  const suggestion = suggestDomain(domain);
  if (suggestion && TOP_FIVE.has(suggestion)) return typo(local, domain, suggestion);

  if (!dnsActive()) {
    return suggestion ? typo(local, domain, suggestion) : { ok: true, reason: 'disabled' };
  }

  const live = await domainAcceptsMail(domain);
  if (suggestion) {
    // Not one of the big five: an existing domain outranks the guess.
    return live.ok ? { ok: true, reason: live.reason } : typo(local, domain, suggestion);
  }
  if (live.ok) return { ok: true, reason: live.reason };
  return {
    ok: false,
    reason: 'no_mx',
    message: `${domain} doesn't accept email — please check the address for typos.`,
  };
}

module.exports = {
  checkEmailDeliverable,
  suggestDomain,
  domainAcceptsMail,
  _test: {
    setResolver(r) {
      _injected = Boolean(r);
      _resolver = r || { resolveMx: (d) => dns.promises.resolveMx(d), resolve4: (d) => dns.promises.resolve4(d) };
    },
    setTimeoutMs(ms) { _timeoutMs = ms || DNS_TIMEOUT_MS; },
    clearCache() { _cache.clear(); },
    osa,
  },
};
