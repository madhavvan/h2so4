// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PRICING SERVICE — Geo-based subscription pricing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface PricingTier {
  id: 'free' | 'basic' | 'pro' | 'max' | 'ultra';
  name: string;
  price: number;
  currency: string;
  currencySymbol: string;
  period: 'month' | 'year' | 'one-time';
  features: string[];
  popular?: boolean;
  cta: string;
  subtitle?: string; // e.g. "3 interviews · 14-day expiry"
}

export interface RegionPricing {
  country_code: string;
  country_name: string;
  currency: string;
  currencySymbol: string;
  tiers: PricingTier[];
}

// USD exchange rates (approximate, updated periodically by backend in production)
const EXCHANGE_RATES: Record<string, { rate: number; symbol: string; code: string }> = {
  US: { rate: 1, symbol: '$', code: 'USD' },
  IN: { rate: 1, symbol: '₹', code: 'INR' }, // Special pricing for India
  GB: { rate: 0.79, symbol: '£', code: 'GBP' },
  EU: { rate: 0.92, symbol: '€', code: 'EUR' }, // Eurozone fallback
  DE: { rate: 0.92, symbol: '€', code: 'EUR' },
  FR: { rate: 0.92, symbol: '€', code: 'EUR' },
  ES: { rate: 0.92, symbol: '€', code: 'EUR' },
  IT: { rate: 0.92, symbol: '€', code: 'EUR' },
  NL: { rate: 0.92, symbol: '€', code: 'EUR' },
  JP: { rate: 149.5, symbol: '¥', code: 'JPY' },
  KR: { rate: 1340, symbol: '₩', code: 'KRW' },
  CN: { rate: 7.24, symbol: '¥', code: 'CNY' },
  AU: { rate: 1.53, symbol: 'A$', code: 'AUD' },
  CA: { rate: 1.36, symbol: 'C$', code: 'CAD' },
  BR: { rate: 4.97, symbol: 'R$', code: 'BRL' },
  MX: { rate: 17.15, symbol: 'MX$', code: 'MXN' },
  SG: { rate: 1.34, symbol: 'S$', code: 'SGD' },
  AE: { rate: 3.67, symbol: 'د.إ', code: 'AED' },
  SE: { rate: 10.45, symbol: 'kr', code: 'SEK' },
  CH: { rate: 0.88, symbol: 'CHF', code: 'CHF' },
  NO: { rate: 10.6, symbol: 'kr', code: 'NOK' },
  DK: { rate: 6.87, symbol: 'kr', code: 'DKK' },
  PL: { rate: 4.02, symbol: 'zł', code: 'PLN' },
  NZ: { rate: 1.64, symbol: 'NZ$', code: 'NZD' },
  ZA: { rate: 18.2, symbol: 'R', code: 'ZAR' },
  TH: { rate: 34.5, symbol: '฿', code: 'THB' },
  PH: { rate: 56.2, symbol: '₱', code: 'PHP' },
  ID: { rate: 15700, symbol: 'Rp', code: 'IDR' },
  MY: { rate: 4.72, symbol: 'RM', code: 'MYR' },
  NG: { rate: 1550, symbol: '₦', code: 'NGN' },
  EG: { rate: 30.9, symbol: 'E£', code: 'EGP' },
  TR: { rate: 32.4, symbol: '₺', code: 'TRY' },
  PK: { rate: 278, symbol: '₨', code: 'PKR' },
  BD: { rate: 110, symbol: '৳', code: 'BDT' },
  VN: { rate: 24500, symbol: '₫', code: 'VND' },
  IL: { rate: 3.71, symbol: '₪', code: 'ILS' },
  SA: { rate: 3.75, symbol: 'ر.س', code: 'SAR' },
};

// Eurozone countries
const EUROZONE = ['AT', 'BE', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PT', 'SK', 'SI', 'ES'];

// ── INR checkout kill-switch (2026-07-16) ──────────────────────────────
// The Razorpay merchant account is PENDING approval, so the SERVER routes
// every charge — India included — to Stripe in USD (payments.js
// getPaymentProvider, RAZORPAY_ROUTING_ENABLED env). While that's the case,
// the client must DISPLAY USD for India too: showing ₹2,499 and then
// charging $30 on the Stripe page is exactly the price-mismatch class the
// server-side validators exist to prevent. Flip this to true together with
// RAZORPAY_ROUTING_ENABLED=true on the server when the Razorpay account
// clears — the INR tables below are kept intact for that day.
const INR_CHECKOUT_ENABLED = false;

const BASE_FEATURES_FREE = [
  '10-minute free trial — all models except Claude',
  'Gemini · GPT-5.5 · Grok · Groq during your trial',
  'Screen & transcript capture',
  'Community support',
];

// Feature copy mirrors services/licenseService.ts FEATURE_GATES.models.
// 2026-07 pricing: Basic is the only paid tier without Claude; Auto-Type is
// the Ultra-exclusive feature. Basic/Pro/Max are one-time interview buys;
// Ultra is the monthly unlimited subscription.
const BASE_FEATURES_BASIC = [
  'One 30-minute interview',
  'Extend anytime (+30 min / +1 h / +3 h packs)',
  'Four AI models (Gemini · GPT-5.5 · Grok · Groq)',
  'Pop-out stealth mode',
  'Auto-solve with screen analysis',
  'Resume & JD context upload',
  'Session history & export',
];

// NOTE: extension copy in these arrays stays currency-neutral ("+1 hour"
// not "+1 hour · $45") because the SAME arrays render inside the USD, INR,
// and rest-of-world pricing blocks below — a hardcoded dollar figure would
// misstate the ₹3799 Razorpay charge for Indian users. Price-bearing
// surfaces (low-time toast, exhausted modal, ManageSubscription button)
// resolve the exact figure per-region via getRenewalPrice().
const BASE_FEATURES_PRO = [
  'One 1-hour interview',
  'Extend anytime (+30 min / +1 h / +3 h packs)',
  'All five AI models — incl. Claude Sonnet 5',
  'Pop-out stealth mode',
  'Auto-solve with screen analysis',
  'Resume & JD context upload',
  'Session history & export',
];

const BASE_FEATURES_MAX = [
  'Three 1-hour interviews',
  'Extend anytime (+30 min / +1 h / +3 h packs)',
  'All five AI models — incl. Claude Sonnet 5',
  'Full reasoning-effort control',
  'Train Model — pre-research the role',
  'Everything in Pro',
];

const BASE_FEATURES_ULTRA = [
  'Unlimited interviews, all five models',
  'Auto-Type into any editor (HackerRank, CoderPad, LeetCode)',
  'Human-like typing rhythm & indent handling',
  'Train Model + full reasoning control',
  'No copy-paste detection',
  'Priority support',
];

function roundPrice(price: number, code: string): number {
  // Currencies with no decimal (JPY, KRW, IDR, VND, etc.)
  const noDecimal = ['JPY', 'KRW', 'IDR', 'VND', 'PKR', 'BDT', 'NGN'];
  if (noDecimal.includes(code)) {
    // Round to nearest 100 or 1000 for clean pricing
    if (price > 10000) return Math.round(price / 1000) * 1000;
    if (price > 1000) return Math.round(price / 100) * 100;
    return Math.round(price);
  }
  // Round to .99 for psychological pricing
  return Math.floor(price) + 0.99;
}

// USD base prices (2026-07 pricing overhaul). Basic/Pro/Max are ONE-TIME
// interview purchases; Ultra is the only monthly subscription. India prices are
// the same value converted to INR (see the IN block below), not a discount.
const USD_PRICES = {
  basic: 30,     // one-time · one 30-min interview
  pro: 50,       // one-time · one 1-hour interview
  max: 89,       // one-time · three 1-hour interviews
  ultra: 159,    // per month · unlimited + Auto-Type
} as const;

// ── Mid-interview top-up — client mirror (2026-07) ──
// A flat +30-minute top-up ($25 / ₹2099) for every metered tier
// (Basic/Pro/Max); Ultra is exempt (unlimited). Tier is preserved on the
// grant. Unlimited repeats on the interview day. MUST stay in sync with
// RENEWAL_USD_CENTS / RENEWAL_INR_PAISE in server/src/routes/payments.js
// (the amount charged) and the flat +30-min grantTimeExtension in
// server/src/database.js.
export interface RenewalPricing {
  price: number;
  currency: string;
  currencySymbol: string;
  seconds: number;   // time granted per top-up
  minutes: number;   // seconds / 60, for display copy
  label: string;     // "+30 min" / "+1 hour" — button-sized copy
}
const RENEWAL_BY_TIER: Record<'basic' | 'pro' | 'max', { seconds: number; usd: number; inr: number; label: string }> = {
  basic: { seconds: 30 * 60, usd: 25, inr: 2099, label: '+30 min' },
  pro:   { seconds: 30 * 60, usd: 25, inr: 2099, label: '+30 min' },
  max:   { seconds: 30 * 60, usd: 25, inr: 2099, label: '+30 min' },
};

// ── Graduated top-up packs — 2026-07 ────────────────────────────────
// Three packs the user picks; server re-derives amount+seconds from the id.
// Client uses this for display only — never sends a price to the server.
export interface ExtensionPack {
  id: string;
  seconds: number;
  minutes: number;
  usd: number;
  usd_cents: number;
  inr: number;
  inr_paise: number;
  label: string;
}
export const EXTENSION_PACKS: ExtensionPack[] = [
  { id: 'm30', seconds: 1800,  minutes: 30,  usd: 25, usd_cents: 2500,  inr: 2099, inr_paise: 209900, label: '+30 min' },
  { id: 'h1',  seconds: 3600,  minutes: 60,  usd: 45, usd_cents: 4500,  inr: 3799, inr_paise: 379900, label: '+1 hour' },
  { id: 'h3',  seconds: 10800, minutes: 180, usd: 80, usd_cents: 8000,  inr: 6799, inr_paise: 679900, label: '+3 hours' },
];

export interface ExtensionPackDisplay {
  id: string;
  label: string;
  seconds: number;
  minutes: number;
  price: number;
  currency: string;
  currencySymbol: string;
}

export function getExtensionPacks(countryCode: string): ExtensionPackDisplay[] {
  // INR display only when INR checkout is live — see INR_CHECKOUT_ENABLED.
  const isIN = (countryCode || 'US').toUpperCase() === 'IN' && INR_CHECKOUT_ENABLED;
  return EXTENSION_PACKS.map(p => ({
    id:             p.id,
    label:          p.label,
    seconds:        p.seconds,
    minutes:        p.minutes,
    price:          isIN ? p.inr : p.usd,
    currency:       isIN ? 'INR' : 'USD',
    currencySymbol: isIN ? '₹' : '$',
  }));
}


class PricingService {
  getPricing(countryCode: string): RegionPricing {
    const cc = countryCode.toUpperCase();

    // Special pricing: India (hand-tuned for market). Gated on the INR
    // kill-switch — while Razorpay is pending, India sees the USD table
    // (the currency Stripe will actually charge).
    if (cc === 'IN' && INR_CHECKOUT_ENABLED) {
      return {
        country_code: 'IN',
        country_name: 'India',
        currency: 'INR',
        currencySymbol: '₹',
        tiers: [
          {
            id: 'free', name: 'Starter', price: 0,
            currency: 'INR', currencySymbol: '₹', period: 'month',
            features: BASE_FEATURES_FREE, cta: 'Get Started Free',
          },
          {
            id: 'basic', name: 'Basic', price: 2499,
            currency: 'INR', currencySymbol: '₹', period: 'one-time',
            features: BASE_FEATURES_BASIC, cta: 'Start a 30-min interview',
            subtitle: '30-min interview · extend anytime',
          },
          {
            id: 'pro', name: 'Pro', price: 4199,
            currency: 'INR', currencySymbol: '₹', period: 'one-time',
            features: BASE_FEATURES_PRO, popular: true, cta: 'Start a 1-hour interview',
            subtitle: '1-hour interview · all models',
          },
          {
            id: 'max', name: 'Max', price: 7399,
            currency: 'INR', currencySymbol: '₹', period: 'one-time',
            features: BASE_FEATURES_MAX, cta: 'Get 3 interviews',
            subtitle: '3 × 1-hour interviews',
          },
          {
            id: 'ultra', name: 'Ultra', price: 12999,
            currency: 'INR', currencySymbol: '₹', period: 'month',
            features: BASE_FEATURES_ULTRA, cta: 'Go Ultra',
            subtitle: 'Unlimited + Auto-Type',
          },
        ],
      };
    }

    // Special pricing: USA (source of truth)
    if (cc === 'US') {
      return {
        country_code: 'US',
        country_name: 'United States',
        currency: 'USD',
        currencySymbol: '$',
        tiers: [
          {
            id: 'free', name: 'Starter', price: 0,
            currency: 'USD', currencySymbol: '$', period: 'month',
            features: BASE_FEATURES_FREE, cta: 'Get Started Free',
          },
          {
            id: 'basic', name: 'Basic', price: USD_PRICES.basic,
            currency: 'USD', currencySymbol: '$', period: 'one-time',
            features: BASE_FEATURES_BASIC, cta: 'Start a 30-min interview',
            subtitle: '30-min interview · extend anytime',
          },
          {
            id: 'pro', name: 'Pro', price: USD_PRICES.pro,
            currency: 'USD', currencySymbol: '$', period: 'one-time',
            features: BASE_FEATURES_PRO, popular: true, cta: 'Start a 1-hour interview',
            subtitle: '1-hour interview · all models',
          },
          {
            id: 'max', name: 'Max', price: USD_PRICES.max,
            currency: 'USD', currencySymbol: '$', period: 'one-time',
            features: BASE_FEATURES_MAX, cta: 'Get 3 interviews',
            subtitle: '3 × 1-hour interviews',
          },
          {
            id: 'ultra', name: 'Ultra', price: USD_PRICES.ultra,
            currency: 'USD', currencySymbol: '$', period: 'month',
            features: BASE_FEATURES_ULTRA, cta: 'Go Ultra',
            subtitle: 'Unlimited + Auto-Type',
          },
        ],
      };
    }

    // All other countries: show USD. The server has exactly two charge paths
    // — Stripe (single USD price ID per tier, and a hardcoded `currency:'usd'`
    // on renewals/top-ups) and Razorpay (INR, India only). Converting USD to
    // local currency in the UI would misrepresent the charge: the user would
    // see £22.99 / ¥4,350 / etc. in-app and then get a USD charge on their
    // statement at a different Stripe-computed rate. Showing USD keeps the
    // display honest and matches what Stripe actually bills.
    return {
      country_code: cc,
      country_name: '',
      currency: 'USD',
      currencySymbol: '$',
      tiers: [
        {
          id: 'free', name: 'Starter', price: 0,
          currency: 'USD', currencySymbol: '$', period: 'month',
          features: BASE_FEATURES_FREE, cta: 'Get Started Free',
        },
        {
          id: 'basic', name: 'Basic', price: USD_PRICES.basic,
          currency: 'USD', currencySymbol: '$', period: 'one-time',
          features: BASE_FEATURES_BASIC, cta: 'Start a 30-min interview',
          subtitle: '30-min interview · extend anytime',
        },
        {
          id: 'pro', name: 'Pro', price: USD_PRICES.pro,
          currency: 'USD', currencySymbol: '$', period: 'one-time',
          features: BASE_FEATURES_PRO, popular: true, cta: 'Start a 1-hour interview',
          subtitle: '1-hour interview · all models',
        },
        {
          id: 'max', name: 'Max', price: USD_PRICES.max,
          currency: 'USD', currencySymbol: '$', period: 'one-time',
          features: BASE_FEATURES_MAX, cta: 'Get 3 interviews',
          subtitle: '3 × 1-hour interviews',
        },
        {
          id: 'ultra', name: 'Ultra', price: USD_PRICES.ultra,
          currency: 'USD', currencySymbol: '$', period: 'month',
          features: BASE_FEATURES_ULTRA, cta: 'Go Ultra',
          subtitle: 'Unlimited + Auto-Type',
        },
      ],
    };
  }

  formatPrice(price: number, symbol: string, code: string): string {
    if (price === 0) return 'Free';
    const noDecimal = ['JPY', 'KRW', 'IDR', 'VND', 'PKR', 'BDT', 'NGN', 'INR'];
    if (noDecimal.includes(code)) {
      return `${symbol}${price.toLocaleString()}`;
    }
    return `${symbol}${price.toFixed(2)}`;
  }

  // ── Plan-specific renewal price (2026-07) ──
  // The BASE extension unit for every metered tier is the same flat
  // +30 min · $25/₹2099 (RENEWAL_BY_TIER above — larger +1h/+3h packs are
  // the graduated EXTENSION_PACKS the user picks explicitly). Unknown
  // tiers (free/expired reactivating via a top-up) resolve to the Basic
  // unit — mirrors the server's grantTimeExtension legacy behavior. Ultra
  // never calls this (it is exempt from all top-up UI).
  //
  // India goes through Razorpay in INR. Everywhere else the server
  // creates a Stripe charge with `currency:'usd'` at the tier's usd_cents
  // (see payments.js RENEWAL_BY_TIER), so the UI must show USD to match.
  getRenewalPrice(countryCode: string, tier: string): RenewalPricing {
    const cfg = RENEWAL_BY_TIER[tier as 'basic' | 'pro' | 'max'] || RENEWAL_BY_TIER.basic;
    const cc = (countryCode || 'US').toUpperCase();
    // INR only while INR checkout is live (see INR_CHECKOUT_ENABLED) —
    // otherwise the top-up pill must show the USD amount Stripe charges.
    const base = cc === 'IN' && INR_CHECKOUT_ENABLED
      ? { price: cfg.inr, currency: 'INR', currencySymbol: '₹' }
      : { price: cfg.usd, currency: 'USD', currencySymbol: '$' };
    return { ...base, seconds: cfg.seconds, minutes: Math.round(cfg.seconds / 60), label: cfg.label };
  }

  // Basic-unit price. Kept for the Basic-gated surfaces (SubscriptionGate
  // renew buttons) that predate the plan-specific resolver; delegates to
  // getRenewalPrice so there is exactly ONE price table.
  getBasicRenewalPrice(countryCode: string): { price: number; currency: string; currencySymbol: string } {
    const { price, currency, currencySymbol } = this.getRenewalPrice(countryCode, 'basic');
    return { price, currency, currencySymbol };
  }
}

export const pricingService = new PricingService();
