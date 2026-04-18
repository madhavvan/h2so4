// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PRICING SERVICE — Geo-based subscription pricing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface PricingTier {
  id: 'free' | 'basic' | 'pro' | 'max';
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
  'Gemini Flash model only (after trial)',
  'Basic transcript capture',
  'Community support',
];

const BASE_FEATURES_BASIC = [
  '3 interview credits (3 hours total)',
  'All AI models (Gemini, GPT, Groq, Grok)',
  'Pop-out stealth mode',
  'Auto-solve with screen analysis',
  'Resume & JD context upload',
  'Session history & export',
  'Renewable: +1h for $6.99',
  '14-day credit expiry',
];

const BASE_FEATURES_PRO = [
  'Unlimited interview sessions',
  'All AI models (Gemini, GPT, Groq, Grok)',
  'System audio capture',
  'Auto-solve with screen analysis',
  'Resume & JD context upload',
  'Pop-out stealth mode',
  'Session history & export',
  'Priority support',
];

const BASE_FEATURES_MAX = [
  'Everything in Pro',
  'Auto-Type into any editor (HackerRank, CoderPad, etc.)',
  'Human-like typing rhythm & indent handling',
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

// USD base prices — single source of truth. Non-USD regions scale via exchange rate.
const USD_PRICES = {
  basic: 25,     // one-time, 3 credits, 14-day expiry
  pro: 29,       // monthly subscription
  max: 69,       // monthly subscription
} as const;

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
            id: 'basic', name: 'Basic', price: 1999,
            currency: 'INR', currencySymbol: '₹', period: 'one-time',
            features: BASE_FEATURES_BASIC, popular: true, cta: 'Get 3 Interviews',
            subtitle: '3 credits · 14-day expiry',
          },
          {
            id: 'pro', name: 'Pro', price: 2499,
            currency: 'INR', currencySymbol: '₹', period: 'month',
            features: BASE_FEATURES_PRO, cta: 'Start Pro',
          },
          {
            id: 'max', name: 'Max', price: 5999,
            currency: 'INR', currencySymbol: '₹', period: 'month',
            features: BASE_FEATURES_MAX, cta: 'Start Max',
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
            features: BASE_FEATURES_BASIC, popular: true, cta: 'Get 3 Interviews',
            subtitle: '3 credits · 14-day expiry',
          },
          {
            id: 'pro', name: 'Pro', price: USD_PRICES.pro,
            currency: 'USD', currencySymbol: '$', period: 'month',
            features: BASE_FEATURES_PRO, cta: 'Start Pro',
          },
          {
            id: 'max', name: 'Max', price: USD_PRICES.max,
            currency: 'USD', currencySymbol: '$', period: 'month',
            features: BASE_FEATURES_MAX, cta: 'Start Max',
          },
        ],
      };
    }

    // All other countries: USD base × exchange rate, rounded
    let exchange = EXCHANGE_RATES[cc];
    if (!exchange && EUROZONE.includes(cc)) exchange = EXCHANGE_RATES['EU'];
    if (!exchange) exchange = { rate: 1, symbol: '$', code: 'USD' };

    const basicPrice = roundPrice(USD_PRICES.basic * exchange.rate, exchange.code);
    const proPrice = roundPrice(USD_PRICES.pro * exchange.rate, exchange.code);
    const maxPrice = roundPrice(USD_PRICES.max * exchange.rate, exchange.code);

    return {
      country_code: cc,
      country_name: '',
      currency: exchange.code,
      currencySymbol: exchange.symbol,
      tiers: [
        {
          id: 'free', name: 'Starter', price: 0,
          currency: exchange.code, currencySymbol: exchange.symbol, period: 'month',
          features: BASE_FEATURES_FREE, cta: 'Get Started Free',
        },
        {
          id: 'basic', name: 'Basic', price: basicPrice,
          currency: exchange.code, currencySymbol: exchange.symbol, period: 'one-time',
          features: BASE_FEATURES_BASIC, popular: true, cta: 'Get 3 Interviews',
          subtitle: '3 credits · 14-day expiry',
        },
        {
          id: 'pro', name: 'Pro', price: proPrice,
          currency: exchange.code, currencySymbol: exchange.symbol, period: 'month',
          features: BASE_FEATURES_PRO, cta: 'Start Pro',
        },
        {
          id: 'max', name: 'Max', price: maxPrice,
          currency: exchange.code, currencySymbol: exchange.symbol, period: 'month',
          features: BASE_FEATURES_MAX, cta: 'Start Max',
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

  // Basic-tier renewal: +1 credit (1 hour). Only offered to Basic users.
  // Returns { price, currency, currencySymbol } in the user's region.
  getBasicRenewalPrice(countryCode: string): { price: number; currency: string; currencySymbol: string } {
    const cc = countryCode.toUpperCase();
    if (cc === 'US') return { price: 6.99, currency: 'USD', currencySymbol: '$' };
    if (cc === 'IN') return { price: 599, currency: 'INR', currencySymbol: '₹' };
    let exchange = EXCHANGE_RATES[cc];
    if (!exchange && EUROZONE.includes(cc)) exchange = EXCHANGE_RATES['EU'];
    if (!exchange) exchange = { rate: 1, symbol: '$', code: 'USD' };
    return {
      price: roundPrice(6.99 * exchange.rate, exchange.code),
      currency: exchange.code,
      currencySymbol: exchange.symbol,
    };
  }
}

export const pricingService = new PricingService();
