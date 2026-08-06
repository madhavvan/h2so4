// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADMIN DASHBOARD WIRING (2026-07-29)
//
//  These tests pin the CONTRACT between the admin read helpers in
//  database.js and the field names AdminDashboard actually renders.
//  Every case here corresponds to a defect that shipped silently
//  because nothing asserted the shape:
//
//   · Revenue was returned as a single cross-currency SUM of minor units
//     and rendered with a bare `$` and no divide — one $129 sale showed
//     as "$12,900", with INR paise added on top.
//   · `ultra` (the $159/mo flagship) was missing from every per-tier
//     revenue/payment/signup map, so the highest-grossing plan reported
//     zero revenue.
//   · getTrends emitted `day`/`revenue`; the table renders `date` and
//     `revenue_by_currency` → blank Date column, both revenue columns
//     permanently "—", revenue sparkline flat at zero.
//   · getTopCustomers emitted `lifetime_value` with no `currency`; the
//     table renders `total_amount`+`currency` → "Total Paid" was "—"
//     for every customer on the leaderboard.
//   · getSuspiciousActivity emitted `n`/`attempts`; the Risk panel
//     renders `country_count`/`fail_count` → "undefined countries".
//
//  If a future change renames one of these fields, these tests fail
//  instead of the dashboard quietly rendering a dash.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const require = createRequire(import.meta.url);
const db = require('../src/database.js');

// Real prices from routes/payments.js TIER_PRICES / TIER_PRICES_INR.
const USD_ULTRA = 15900;   // $159.00
const USD_PRO = 4900;      // $49.00
const INR_ULTRA = 1299900; // ₹12,999.00

function seedUser(id, tier, country) {
  const email = `${id}@test.example`;
  db.createUser({ id, email, name: id, password: 'pw-123456', tier, country_code: country });
  return email;
}

beforeAll(() => {
  // Two paying customers in different currencies + one on Pro, so the
  // per-currency and per-tier splits both have something to separate.
  const ultraUsd = seedUser('adm_ultra_usd', 'ultra', 'US');
  const ultraInr = seedUser('adm_ultra_inr', 'ultra', 'IN');
  const proUsd = seedUser('adm_pro_usd', 'pro', 'US');

  db.recordPayment({
    user_id: 'adm_ultra_usd', email: ultraUsd, provider: 'stripe',
    provider_payment_id: 'pi_adm_1', amount: USD_ULTRA, currency: 'USD',
    status: 'completed', tier_granted: 'ultra',
  });
  db.recordPayment({
    user_id: 'adm_ultra_inr', email: ultraInr, provider: 'razorpay',
    provider_payment_id: 'pay_adm_1', amount: INR_ULTRA, currency: 'INR',
    status: 'completed', tier_granted: 'ultra',
  });
  db.recordPayment({
    user_id: 'adm_pro_usd', email: proUsd, provider: 'stripe',
    provider_payment_id: 'pi_adm_2', amount: USD_PRO, currency: 'USD',
    status: 'completed', tier_granted: 'pro',
  });

  // A comp payment must never count as revenue.
  db.recordPayment({
    user_id: 'adm_pro_usd', email: proUsd, provider: 'admin-comp',
    provider_payment_id: null, amount: 0, currency: 'USD',
    status: 'completed', tier_granted: 'pro',
  });

  // Multi-country logins for one user (2 distinct countries) and 10 failed
  // logins from one IP — the two thresholds getSuspiciousActivity checks.
  db.logLogin({ user_id: 'adm_ultra_usd', email: ultraUsd, ip_address: '1.1.1.1', country_code: 'US', success: true });
  db.logLogin({ user_id: 'adm_ultra_usd', email: ultraUsd, ip_address: '2.2.2.2', country_code: 'DE', success: true });
  for (let i = 0; i < 11; i++) {
    db.logLogin({ email: 'attacker@test.example', ip_address: '9.9.9.9', country_code: 'RU', success: false, error_reason: 'bad password' });
  }
});

describe('getStats — revenue is per-currency, never a mixed minor-unit sum', () => {
  it('splits month revenue by currency instead of adding cents to paise', () => {
    const s = db.getStats();
    expect(s.revenue_this_month_by_currency).toEqual({
      USD: USD_ULTRA + USD_PRO,
      INR: INR_ULTRA,
    });
    // The legacy flat field is still the (meaningless) cross-currency sum.
    // It exists only for older clients — assert it so nobody "fixes" it in
    // place and breaks a build that still reads it.
    expect(s.revenue_this_month).toBe(USD_ULTRA + USD_PRO + INR_ULTRA);
  });

  it('splits all-time revenue by currency', () => {
    const s = db.getStats();
    expect(s.total_revenue_by_currency).toEqual({
      USD: USD_ULTRA + USD_PRO,
      INR: INR_ULTRA,
    });
  });
});

describe('getStats — ultra is a first-class tier everywhere', () => {
  it('counts ultra users', () => {
    const s = db.getStats();
    expect(s.tiers.ultra).toBe(2);
    expect(s.ultra_users).toBe(2);
  });

  it('attributes ultra revenue per currency (was silently dropped)', () => {
    const s = db.getStats();
    expect(s.revenue_by_tier_by_currency.ultra).toEqual({
      USD: USD_ULTRA,
      INR: INR_ULTRA,
    });
    expect(s.revenue_by_tier_by_currency.pro).toEqual({ USD: USD_PRO });
  });

  it('counts ultra payments and signups', () => {
    const s = db.getStats();
    expect(s.payments_by_tier.ultra).toBe(2);
    expect(s.signups_by_tier).toHaveProperty('ultra');
    expect(s.signups_by_tier.ultra).toBe(2);
  });
});

describe('getTrends — field names the Analytics table renders', () => {
  it('emits `date` (row key + Date column) alongside legacy `day`', () => {
    const rows = db.getTrends(7);
    expect(rows.length).toBe(7);
    for (const r of rows) {
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.day).toBe(r.date);
    }
  });

  it('emits revenue_by_currency so USD and INR chart separately', () => {
    const rows = db.getTrends(7);
    const today = rows[rows.length - 1];
    expect(today.revenue_by_currency).toEqual({
      USD: USD_ULTRA + USD_PRO,
      INR: INR_ULTRA,
    });
  });
});

describe('getTopCustomers — one exact row per (user, currency)', () => {
  it('emits total_amount + currency, not a mixed lifetime_value', () => {
    const rows = db.getTopCustomers(10);
    expect(rows.length).toBe(3); // 3 real payers; the $0 comp row is excluded
    for (const r of rows) {
      expect(r.total_amount).toBeGreaterThan(0);
      expect(r.currency).toMatch(/^[A-Z]{3}$/);
      expect(r.payment_count).toBeGreaterThan(0);
    }
    // Ordered by amount within the row set; the ₹12,999 row leads on raw
    // minor units, which is why the UI must print the currency symbol.
    expect(rows[0].currency).toBe('INR');
    const usdUltra = rows.find(r => r.email === 'adm_ultra_usd@test.example');
    expect(usdUltra.total_amount).toBe(USD_ULTRA);
    expect(usdUltra.currency).toBe('USD');
  });

  it('excludes admin-comp rows from the revenue leaderboard', () => {
    const rows = db.getTopCustomers(10);
    const pro = rows.filter(r => r.email === 'adm_pro_usd@test.example');
    expect(pro.length).toBe(1);
    expect(pro[0].total_amount).toBe(USD_PRO);
    expect(pro[0].payment_count).toBe(1);
  });
});

describe('getSuspiciousActivity — field names the Risk panel renders', () => {
  it('emits country_count (was rendering "undefined countries")', () => {
    const { multi_country_users } = db.getSuspiciousActivity();
    expect(multi_country_users.length).toBeGreaterThan(0);
    const row = multi_country_users[0];
    expect(row.country_count).toBe(2);
    expect(row.n).toBe(row.country_count);
  });

  it('emits fail_count (was rendering "undefined fails")', () => {
    const { high_fail_ips } = db.getSuspiciousActivity();
    expect(high_fail_ips.length).toBeGreaterThan(0);
    const row = high_fail_ips[0];
    expect(row.fail_count).toBe(11);
    expect(row.attempts).toBe(row.fail_count);
    expect(row.ip_address).toBe('9.9.9.9');
  });
});
