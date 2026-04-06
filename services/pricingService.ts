// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PRICING SERVICE — Geo-based subscription pricing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface PricingTier {
  id: 'free' | 'pro';
  name: string;
  price: number;
  currency: string;
  currencySymbol: string;
  period: 'month';
  features: string[];
  popular?: boolean;
  cta: string;
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
  '5 interview sessions per month',
  'Gemini Flash model only',
  'Basic transcript capture',
  'Community support',
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

class PricingService {
  getPricing(countryCode: string): RegionPricing {
    const cc = countryCode.toUpperCase();

    // Special pricing: India
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
            id: 'pro', name: 'Pro', price: 3999,
            currency: 'INR', currencySymbol: '₹', period: 'month',
            features: BASE_FEATURES_PRO, popular: true, cta: 'Start Pro Trial',
          },
        ],
      };
    }

    // Special pricing: USA
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
            id: 'pro', name: 'Pro', price: 50,
            currency: 'USD', currencySymbol: '$', period: 'month',
            features: BASE_FEATURES_PRO, popular: true, cta: 'Start Pro Trial',
          },
        ],
      };
    }

    // All other countries: $50 USD converted to local currency
    let exchange = EXCHANGE_RATES[cc];

    // Eurozone fallback
    if (!exchange && EUROZONE.includes(cc)) {
      exchange = EXCHANGE_RATES['EU'];
    }

    // Default to USD if country not in rate table
    if (!exchange) {
      exchange = { rate: 1, symbol: '$', code: 'USD' };
    }

    const proPrice = roundPrice(50 * exchange.rate, exchange.code);

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
          id: 'pro', name: 'Pro', price: proPrice,
          currency: exchange.code, currencySymbol: exchange.symbol, period: 'month',
          features: BASE_FEATURES_PRO, popular: true, cta: 'Start Pro Trial',
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
}

export const pricingService = new PricingService();
