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

const BASE_FEATURES_FREE = [
  '30-minute full-experience trial on signup',
  'Gemini Flash model after the trial',
  'Screen & transcript capture',
  'Community support',
];

// Feature copy mirrors services/licenseService.ts FEATURE_GATES.models.
// 2026-07 pricing: Basic is the only paid tier without Claude; Auto-Type is
// the Ultra-exclusive feature. Basic/Pro/Max are one-time interview buys;
// Ultra is the monthly unlimited subscription.
const BASE_FEATURES_BASIC = [
  'One 30-minute interview',
  'Extend +30 min anytime',
  'Four AI models (Gemini · GPT-5.5 · Grok · Groq)',
  'Pop-out stealth mode',
  'Auto-solve with screen analysis',
  'Resume & JD context upload',
  'Session history & export',
];

const BASE_FEATURES_PRO = [
  'One 1-hour interview',
  'All five AI models — incl. Claude Sonnet 5',
  'Pop-out stealth mode',
  'Auto-solve with screen analysis',
  'Resume & JD context upload',
  'Session history & export',
];

const BASE_FEATURES_MAX = [
  'Three 1-hour interviews',
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

// Basic 30-min interview extension (+30 min). One-time top-up.
const EXTENSION_USD = 25;
const EXTENSION_INR = 2099;

class PricingService {
  getPricing(countryCode: string): RegionPricing {
    const cc = countryCode.toUpperCase();

    // Special pricing: India (hand-tuned for market)
    if (cc === 'IN') {
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
    // on Basic renewal) and Razorpay (INR, India only). Converting USD to
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

  // Basic 30-min interview extension (+30 min). Only offered to Basic users.
  // Returns { price, currency, currencySymbol } in the actual charge currency.
  //
  // India goes through Razorpay in INR. Everywhere else the server creates a
  // Stripe checkout with hardcoded `currency:'usd'` + RENEWAL_USD_CENTS
  // (see payments.js createStripeRenewal), so the UI must show USD to match.
  // (Method name kept for call-site compatibility; it now prices the extension.)
  getBasicRenewalPrice(countryCode: string): { price: number; currency: string; currencySymbol: string } {
    const cc = countryCode.toUpperCase();
    if (cc === 'IN') return { price: EXTENSION_INR, currency: 'INR', currencySymbol: '₹' };
    return { price: EXTENSION_USD, currency: 'USD', currencySymbol: '$' };
  }
}

export const pricingService = new PricingService();
