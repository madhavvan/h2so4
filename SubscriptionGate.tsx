import React, { useState, useEffect, useRef, useCallback, useMemo, Suspense, lazy } from 'react';
import SupportBot from './SupportBot';
import { Shield, Zap, Crown, Check, X, ArrowRight, ArrowLeft, Globe, Lock, Sparkles, ChevronRight, Eye, EyeOff, AlertTriangle, Loader2, Star, Users, Cpu, Headphones, Bot, BarChart3, Monitor, Download, Play, BookOpen, ChevronDown, LogOut, MessageCircle, Send, Mail, Settings, ExternalLink, XCircle, Clock, DollarSign, RefreshCw, Trash2, Edit2, Key, UserCheck, Activity, FileDown, Filter, Ban, TrendingUp, Gift, Database, Search, Copy, ChevronUp, FileText } from 'lucide-react';
import { WizardHat } from './WizardHat';
// Phosphor duotone — used on the public landing + auth surfaces for the
// editorial, premium feel that lucide's flat strokes can't quite reach.
// In-app utility icons stay on lucide so dense toolbars don't get heavy.
import {
  Sparkle as PhSparkle,
  Headphones as PhHeadphones,
  Monitor as PhMonitor,
  Cpu as PhCpu,
  Shield as PhShield,
  ChartBar as PhChart,
  Lock as PhLock,
  Globe as PhGlobe,
  Lightning as PhBolt,
  DownloadSimple as PhDownload,
  ArrowRight as PhArrowRight,
  Star as PhStar,
  Users as PhUsers,
  Quotes as PhQuote,
  CheckCircle as PhCheck,
} from '@phosphor-icons/react';
import { GoogleOAuthProvider, GoogleLogin } from '@react-oauth/google';
import { geoService, GeoData } from './services/geoService';
import { pricingService, RegionPricing, PricingTier } from './services/pricingService';
import { licenseService, UserProfile, LicenseData } from './services/licenseService';
// Same component the Electron desktop chat-header uses. On the web post-
// auth download surface we render it as a modal so paid users have full
// parity with the desktop billing UI (cancel/reactivate/tier-swap, plan
// comparison, refund-policy, profile-edit) instead of being forced to
// either bounce out to the Stripe portal or wait until they install
// the desktop binary.
import { ManageSubscription as ManageSubscriptionModal } from './ManageSubscription';
// Public docs surface — same component the landing nav links to.
// Renders the contents of /docs (markdown bundled at build via Vite ?raw)
// in a Stripe-style three-column layout. Theme-aware so it adopts the
// landing page's cream palette by default; URL is synced to /docs/<slug>
// so links are shareable and SEO-indexable.
//
// Lazy-loaded so the marketing landing's initial bundle doesn't carry
// react-markdown + remark-gfm + react-syntax-highlighter + ~80 KB of
// markdown that 90 %+ of visitors will never look at. Deep-links to
// /docs trigger the chunk fetch immediately on mount; the fallback
// matches the docs chrome so the swap is visually quiet.
const Documentation = lazy(() => import('./Documentation'));

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '179380214544-5r338sqpqr6ke6tnsf165ic7qi9th0ht.apps.googleusercontent.com';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SUBSCRIPTION GATE — Landing → Auth → Download funnel
//  Website is NOT the app. Users MUST download Electron app.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface SubscriptionGateProps {
  onAuthenticated: (user: UserProfile, license: LicenseData) => void;
}

type View = 'landing' | 'login' | 'signup' | 'forgot_password' | 'pricing' | 'vpn_blocked' | 'download' | 'tutorials' | 'admin' | 'support' | 'docs';

// ── Detect if running inside Electron ──
// Reads window.electronAPI (set by electron/preload.cjs) — works under
// the new contextIsolation:true + nodeIntegration:false config.
const isElectron = typeof window !== 'undefined' && !!window.electronAPI?.isElectron;

// Single-flight Razorpay SDK loader. Without this, a user who clicks
// "Upgrade" twice before the first checkout modal renders would append
// two <script> tags, both of which race to define window.Razorpay and
// can wire the second modal's handler to the first instance's state.
let razorpayScriptPromise: Promise<void> | null = null;
const loadRazorpayScript = (): Promise<void> => {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'));
  if ((window as any).Razorpay) return Promise.resolve();
  if (razorpayScriptPromise) return razorpayScriptPromise;
  razorpayScriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      razorpayScriptPromise = null;
      reject(new Error('Failed to load Razorpay SDK'));
    };
    document.body.appendChild(script);
  });
  return razorpayScriptPromise;
};

// ── useIsMobile ──
// Drives the iPhone-feel landing surface. 767px is Tailwind's md/sm boundary —
// anything below md falls into the LandingMobile layout. We listen for media-
// query changes so a desktop window dragged narrow flips in real time, and
// an iPad rotated to portrait gets the mobile treatment too. SSR-guarded for
// parity with the rest of the file (we never run server-rendered today, but
// a future static-export of the marketing surface would otherwise crash).
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 767px)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // matchMedia listener API is unified since iOS 14 / Chrome 39 — but
    // Electron renderers can pre-date this on long-lived installs, so keep
    // the legacy addListener path as a fallback.
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else (mq as any).addListener?.(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else (mq as any).removeListener?.(onChange);
    };
  }, []);
  return isMobile;
}

// ── Animated background ──
// Memoized: mounted ~13× across views; re-evaluates 3 infinite CSS keyframes
// on every parent render if not memoized. No props → never needs to re-render.
const AnimatedBackground = React.memo(() => (
  <div className="fixed inset-0 overflow-hidden pointer-events-none" style={{ zIndex: 0 }}>
    <div className="absolute -top-40 -right-40 w-[500px] h-[500px] rounded-full opacity-[0.07]"
      style={{ background: 'radial-gradient(circle, #3b82f6 0%, transparent 70%)', animation: 'float1 20s ease-in-out infinite' }} />
    <div className="absolute -bottom-60 -left-40 w-[600px] h-[600px] rounded-full opacity-[0.05]"
      style={{ background: 'radial-gradient(circle, #8b5cf6 0%, transparent 70%)', animation: 'float2 25s ease-in-out infinite' }} />
    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] rounded-full opacity-[0.03]"
      style={{ background: 'radial-gradient(circle, #06b6d4 0%, transparent 70%)', animation: 'float3 30s ease-in-out infinite' }} />
    <style>{`
      @keyframes float1 { 0%, 100% { transform: translate(0, 0) scale(1); } 50% { transform: translate(-80px, 60px) scale(1.1); } }
      @keyframes float2 { 0%, 100% { transform: translate(0, 0) scale(1); } 50% { transform: translate(60px, -80px) scale(1.15); } }
      @keyframes float3 { 0%, 100% { transform: translate(-50%, -50%) scale(1); } 50% { transform: translate(-50%, -50%) scale(1.2); } }
    `}</style>
  </div>
));

const NoiseOverlay = React.memo(() => (
  <div className="fixed inset-0 pointer-events-none opacity-[0.015]" style={{ zIndex: 1, backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")` }} />
));

// Refined wordmark. Replaces the gradient-cube + Bot icon with a hand-set
// editorial mark: a single ink glyph mark in a circle (more dignified than
// a generic Bot face) and the wordmark in our display serif so the brand
// reads as an Anthropic-class product, not a generic SaaS dashboard.
//
// Two variants:
//   theme='light' — cream surface (landing, auth modals).
//   theme='dark'  — dark surface (in-app shell, popout, admin).
//
// The glyph is a stylized "m" in a thin-stroke circle, small enough to
// pair with text without dominating it.
const Logo = ({
  size = 'md',
  theme = 'dark',
}: { size?: 'sm' | 'md' | 'lg'; theme?: 'light' | 'dark' }) => {
  const dot = { sm: 28, md: 34, lg: 44 }[size];
  const text = { sm: 'text-base', md: 'text-lg', lg: 'text-2xl' }[size];
  const sub = size === 'lg';
  const isLight = theme === 'light';
  const inkColor = isLight ? 'var(--ink)' : '#f5f4ef';
  const subColor = isLight ? 'var(--ink-muted)' : 'rgba(245,244,239,0.55)';
  const ringColor = isLight ? 'var(--ink)' : '#f5f4ef';
  return (
    <div className="flex items-center gap-3" style={{ fontFamily: 'var(--sans)' }}>
      <span
        aria-hidden
        className="inline-flex items-center justify-center shrink-0 rounded-full"
        style={{
          width: dot,
          height: dot,
          border: `1.25px solid ${ringColor}`,
          color: inkColor,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--serif)',
            fontWeight: 500,
            fontStyle: 'italic',
            fontSize: dot * 0.58,
            lineHeight: 1,
            transform: 'translateY(-0.04em)',
            letterSpacing: '-0.02em',
          }}
        >
          m
        </span>
      </span>
      <div className="leading-none">
        <span
          className={`${text} font-medium`}
          style={{
            fontFamily: 'var(--serif)',
            color: inkColor,
            letterSpacing: '-0.02em',
          }}
        >
          minicaai
        </span>
        {sub && (
          <div
            className="text-[10px] font-medium tracking-[0.18em] uppercase mt-1.5"
            style={{ color: subColor }}
          >
            Interview Intelligence
          </div>
        )}
      </div>
    </div>
  );
};

const FeaturePill = ({ icon: Icon, text }: { icon: any; text: string }) => (
  <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/[0.06] bg-white/[0.02]">
    <Icon size={13} className="text-blue-400" strokeWidth={2} />
    <span className="text-[11px] text-gray-400 font-medium">{text}</span>
  </div>
);

// ── Pricing Card (Free / Basic / Pro / Max) ──
// Editorial cream-theme card. The "popular" tier is signalled by an
// inverted ink-on-cream tile rather than a saturated gradient — louder
// in restraint than in ornament. Period label is set in tabular numerals
// so the price row aligns optically across cards.
const PricingCard = ({ tier, onSelect, isLoading }: { tier: PricingTier; onSelect: (tier: PricingTier) => void; isLoading: boolean }) => {
  const isPopular = !!tier.popular;
  const periodLabel = tier.period === 'month' ? '/mo' : tier.period === 'year' ? '/yr' : '';

  const frameStyle: React.CSSProperties = isPopular
    ? { background: 'var(--ink)', color: 'var(--cream)', border: '1px solid var(--ink)' }
    : { background: 'transparent', color: 'var(--ink)', border: '1px solid var(--cream-line)' };

  const subColor = isPopular ? 'rgba(245,244,239,0.65)' : 'var(--ink-muted)';
  const featureColor = isPopular ? 'rgba(245,244,239,0.85)' : 'var(--ink-soft)';

  const ctaStyle: React.CSSProperties = isPopular
    ? { background: 'var(--cream)', color: 'var(--ink)' }
    : { background: 'var(--ink)', color: 'var(--cream)' };

  return (
    <div
      className="relative rounded-2xl flex flex-col p-7 transition-all duration-300"
      style={frameStyle}
    >
      {isPopular && (
        <div
          className="absolute -top-2.5 left-7 px-2.5 py-1 rounded-full text-[10px] font-medium uppercase tracking-[0.16em]"
          style={{ background: 'var(--accent)', color: 'var(--cream)' }}
        >
          Most chosen
        </div>
      )}

      <h3
        className="text-[22px]"
        style={{ fontFamily: 'var(--serif)', fontWeight: 500, letterSpacing: '-0.015em' }}
      >
        {tier.name}
      </h3>
      {tier.subtitle && (
        <p className="mt-1 text-[12.5px]" style={{ color: subColor }}>
          {tier.subtitle}
        </p>
      )}

      <div className="flex items-baseline gap-1 mt-6 mb-6 tabular-nums">
        {tier.price === 0 ? (
          <span
            className="text-[40px]"
            style={{ fontFamily: 'var(--serif)', fontWeight: 400, letterSpacing: '-0.025em' }}
          >
            Free
          </span>
        ) : (
          <>
            <span
              className="text-[40px]"
              style={{ fontFamily: 'var(--serif)', fontWeight: 400, letterSpacing: '-0.025em' }}
            >
              {pricingService.formatPrice(tier.price, tier.currencySymbol, tier.currency)}
            </span>
            {periodLabel && (
              <span className="text-[14px]" style={{ color: subColor }}>
                {periodLabel}
              </span>
            )}
          </>
        )}
      </div>

      <button
        onClick={() => onSelect(tier)}
        disabled={isLoading}
        className="w-full py-3 px-4 rounded-full text-[14px] font-medium transition-all duration-200 inline-flex items-center justify-center gap-2 hover:opacity-90"
        style={ctaStyle}
      >
        {isLoading ? <Loader2 size={14} className="animate-spin" /> : null}
        {tier.cta}
        {!isLoading && <PhArrowRight size={14} weight="bold" />}
      </button>

      <ul className="mt-7 space-y-3.5">
        {tier.features.map((feature, i) => (
          <li key={i} className="flex items-start gap-2.5 text-[13.5px]" style={{ color: featureColor }}>
            <PhCheck
              size={16}
              weight="duotone"
              style={{ color: isPopular ? 'var(--accent-soft)' : 'var(--accent)', flexShrink: 0, marginTop: 1 }}
            />
            <span style={{ lineHeight: 1.5 }}>{feature}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

// ── Tutorial Card ──
// Two-step refund modal — collect amount/reason, then show confirmation
// summary BEFORE the step-up password prompt fires. Replaces the older
// inline IIFE that used closure variables (which retained stale values
// across modal cycles, risking wrong-amount refunds).
const RefundModal = ({
  payment,
  fmtAmount,
  onCancel,
  onSubmit,
}: {
  payment: any;
  fmtAmount: (amt: number, ccy: string) => string;
  onCancel: () => void;
  onSubmit: (amount: number, reason: string) => void;
}) => {
  const [amount, setAmount] = useState<number>(payment.amount || 0);
  const [reason, setReason] = useState<string>('requested_by_customer');
  const [confirming, setConfirming] = useState(false);

  // Esc closes; Enter advances on the confirm step.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
      if (e.key === 'Enter' && confirming) { e.preventDefault(); onSubmit(amount, reason); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirming, amount, reason, onCancel, onSubmit]);

  const isPartial = amount > 0 && amount < payment.amount;
  const isFull = amount === payment.amount;
  const isOverRefund = amount > payment.amount;
  const isZeroOrNeg = !amount || amount <= 0;
  const isInvalid = isZeroOrNeg || isOverRefund;
  // Validation messages — surfaced inline so the admin understands WHY Save is
  // disabled. Provider-side rejections (e.g. Stripe "amount > original") are
  // still possible if the payment was already partially refunded; that case is
  // handled by callMutation's error toast.
  const validationMsg = isOverRefund
    ? `Refund cannot exceed the original ${fmtAmount(payment.amount, payment.currency)} charge.`
    : isZeroOrNeg
      ? 'Amount must be greater than zero.'
      : null;

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/70 backdrop-blur-sm" role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="relative w-full max-w-md mx-4 rounded-2xl bg-[#0b0b0f] border border-pink-500/20 shadow-2xl p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-4">
          <div className="shrink-0 p-2 rounded-lg bg-pink-500/15 text-pink-400"><RefreshCw size={18} /></div>
          <div>
            <h3 className="text-base font-semibold text-white">{confirming ? 'Confirm refund' : 'Issue Refund'}</h3>
            <p className="text-xs text-gray-500">{payment.email} · {payment.provider.toUpperCase()} · original {fmtAmount(payment.amount, payment.currency)}</p>
          </div>
        </div>

        {!confirming ? (
          <>
            <p className="text-xs text-gray-400 mb-4 p-3 rounded-lg bg-amber-500/[0.04] border border-amber-500/20">
              Refund hits the provider immediately. A webhook will downgrade this user's tier shortly after. Partial refunds are supported — enter a smaller amount to refund less than the full charge.
            </p>
            <label className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold block mb-1">
              Amount ({payment.currency.toUpperCase()} · minor units, e.g. cents/paise)
            </label>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(parseInt(e.target.value, 10) || 0)}
              className="w-full px-3 py-2 mb-1 rounded-lg bg-white/[0.04] border border-white/[0.1] text-white text-sm focus:outline-none focus:border-pink-500/50 font-mono"
            />
            <p className={`text-[10px] mb-1 ${isOverRefund ? 'text-red-400' : 'text-gray-500'}`}>
              ≈ {fmtAmount(amount, payment.currency)} {isPartial ? '(partial)' : isFull ? '(full)' : ''}
            </p>
            {validationMsg && (
              <p className="text-[11px] text-red-400 mb-2 flex items-center gap-1">
                <AlertTriangle size={10} /> {validationMsg}
              </p>
            )}
            {!validationMsg && <div className="mb-2" />}
            <label className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold block mb-1">Reason</label>
            <select
              value={reason}
              onChange={e => setReason(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.1] text-white text-sm focus:outline-none focus:border-pink-500/50"
            >
              <option value="requested_by_customer">Requested by customer</option>
              <option value="duplicate">Duplicate charge</option>
              <option value="fraudulent">Fraudulent</option>
            </select>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] transition-all">Cancel</button>
              <button
                onClick={() => setConfirming(true)}
                disabled={isInvalid}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-pink-500/20 text-pink-200 hover:bg-pink-500/30 border border-pink-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Review refund
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="p-4 rounded-lg bg-red-500/[0.06] border border-red-500/30 space-y-3">
              <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="text-red-400 shrink-0 mt-0.5" />
                <div className="text-sm text-red-200 font-semibold">This refunds money to the customer immediately.</div>
              </div>
              <div className="text-xs space-y-1.5 text-gray-300">
                <div><span className="text-gray-500">User:</span> <span className="text-white">{payment.email}</span></div>
                <div><span className="text-gray-500">Provider:</span> <span className="text-white">{payment.provider.toUpperCase()}</span></div>
                <div><span className="text-gray-500">Original charge:</span> <span className="text-white">{fmtAmount(payment.amount, payment.currency)}</span></div>
                <div className="pt-1 mt-1 border-t border-red-500/20">
                  <span className="text-gray-500">Refund amount:</span>{' '}
                  <span className="text-red-300 font-bold">{fmtAmount(amount, payment.currency)} {isPartial ? '(partial)' : '(full)'}</span>
                </div>
                <div><span className="text-gray-500">Reason:</span> <span className="text-white">{reason}</span></div>
              </div>
            </div>
            <p className="text-[11px] text-gray-500 mt-3">After confirming, you'll be asked for your step-up admin password.</p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button onClick={() => setConfirming(false)} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] transition-all">Back</button>
              <button onClick={() => onSubmit(amount, reason)} className="px-4 py-2 rounded-lg text-sm font-semibold bg-red-500 text-white hover:bg-red-600 transition-all">Refund {fmtAmount(amount, payment.currency)}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// Reference list of every runtime knob the server reads from app_config. The
// table shows description + default and lets the admin seed a row if it's not
// in the DB yet (server seeds min_app_version / latest_app_version on boot,
// but device-limit overrides only appear once explicitly set).
const KNOWN_CONFIG_KEYS: { key: string; description: string; defaultValue: string; group: string }[] = [
  { group: 'App version', key: 'min_app_version', defaultValue: '2.0.0', description: 'Minimum app version that can authenticate. Older builds are forced to upgrade on next launch.' },
  { group: 'App version', key: 'latest_app_version', defaultValue: '2.0.0', description: 'Latest released version — drives the in-app "update available" prompt.' },
  { group: 'Device limits', key: 'max_devices_free', defaultValue: '2', description: 'Concurrent device slots for the free tier.' },
  { group: 'Device limits', key: 'max_devices_basic', defaultValue: '2', description: 'Concurrent device slots for Basic.' },
  { group: 'Device limits', key: 'max_devices_pro', defaultValue: '3', description: 'Concurrent device slots for Pro.' },
  { group: 'Device limits', key: 'max_devices_max', defaultValue: '5', description: 'Concurrent device slots for Max.' },
];

const KnownConfigKeysHint = ({ configRows, onSeed, busy }: { configRows: any[]; onSeed: (key: string, defaultValue: string) => Promise<void>; busy: boolean }) => {
  const present = new Set(configRows.map(r => r.key));
  const groups = Array.from(new Set(KNOWN_CONFIG_KEYS.map(k => k.group)));
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.06] bg-white/[0.02] flex items-center gap-2">
        <BookOpen size={12} className="text-blue-400" />
        <span className="text-[11px] uppercase tracking-wider text-gray-400 font-semibold">Known config keys</span>
        <span className="text-[10px] text-gray-600">— server-recognized knobs. Custom keys you add via PUT also appear in the table above.</span>
      </div>
      <div className="divide-y divide-white/[0.04]">
        {groups.map(group => (
          <div key={group} className="px-4 py-3">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2">{group}</div>
            <div className="space-y-1.5">
              {KNOWN_CONFIG_KEYS.filter(k => k.group === group).map(k => {
                const isSet = present.has(k.key);
                return (
                  <div key={k.key} className="flex items-start gap-3 text-[11px]">
                    <span className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${isSet ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/20' : 'bg-white/[0.04] text-gray-500 border border-white/[0.06]'}`}>{isSet ? 'Set' : 'Default'}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-white text-[11px]">{k.key}</span>
                        <span className="text-gray-600 text-[10px]">default: <span className="font-mono text-gray-400">{k.defaultValue}</span></span>
                      </div>
                      <p className="text-gray-500 text-[10px] mt-0.5 leading-relaxed">{k.description}</p>
                    </div>
                    {!isSet && (
                      <button
                        onClick={() => onSeed(k.key, k.defaultValue)}
                        disabled={busy}
                        className="shrink-0 px-2 py-1 rounded text-[10px] font-semibold bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 border border-blue-500/20 transition-all disabled:opacity-40"
                      >
                        Seed default
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="px-4 py-2.5 border-t border-white/[0.06] bg-white/[0.01] text-[10px] text-gray-600 flex items-start gap-2">
        <AlertTriangle size={11} className="shrink-0 mt-0.5 text-amber-400/60" />
        <div>Saving any value triggers step-up reauth. Wrong values can lock users out — e.g. setting <span className="font-mono">min_app_version</span> above the latest published build.</div>
      </div>
    </div>
  );
};

// 3-series sparkline grid for the analytics 30-day trends. Each card shows one
// metric with min/max/last + a smoothed line. Uses raw SVG so we don't pull in
// a chart library for what is essentially three poly-lines. Trends array is
// already in chronological order (oldest → newest) from /admin/trends.
const TrendsSparklines = ({ trends }: { trends: any[] }) => {
  // We only chart USD revenue here — INR shows in the table. Charting both on
  // the same axis would be misleading because USD/INR are different scales.
  const series = [
    { key: 'signups', label: 'Signups', color: '#c084fc', accent: 'text-purple-300', values: trends.map(t => Number(t.signups || 0)) },
    { key: 'logins', label: 'Logins', color: '#67e8f9', accent: 'text-cyan-300', values: trends.map(t => Number(t.logins || 0)) },
    { key: 'revenue_usd', label: 'USD Revenue', color: '#6ee7b7', accent: 'text-emerald-300', values: trends.map(t => Number(t.revenue_by_currency?.USD || 0)) },
  ];
  return (
    <div className="grid sm:grid-cols-3 gap-3 mb-3">
      {series.map(s => {
        const max = Math.max(...s.values, 1);
        const min = Math.min(...s.values, 0);
        const range = max - min || 1;
        const w = 240;
        const h = 56;
        const stepX = s.values.length > 1 ? w / (s.values.length - 1) : w;
        const points = s.values.map((v, i) => {
          const x = i * stepX;
          const y = h - ((v - min) / range) * (h - 4) - 2;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');
        const areaPoints = `0,${h} ${points} ${(w).toFixed(1)},${h}`;
        const last = s.values[s.values.length - 1] ?? 0;
        const fmtVal = s.key === 'revenue_usd' ? `$${(last / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : last.toLocaleString();
        const fmtMax = s.key === 'revenue_usd' ? `$${(max / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : max.toLocaleString();
        return (
          <div key={s.key} className="p-3 rounded-xl border border-white/[0.06] bg-white/[0.02]">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">{s.label}</span>
              <span className={`text-xs font-bold tabular-nums ${s.accent}`}>{fmtVal}</span>
            </div>
            <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-12">
              <defs>
                <linearGradient id={`spark-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity="0.35" />
                  <stop offset="100%" stopColor={s.color} stopOpacity="0" />
                </linearGradient>
              </defs>
              <polygon points={areaPoints} fill={`url(#spark-${s.key})`} />
              <polyline points={points} fill="none" stroke={s.color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div className="flex items-center justify-between text-[9px] text-gray-600 mt-1">
              <span>30d ago</span>
              <span>peak {fmtMax}</span>
              <span>today</span>
            </div>
          </div>
        );
      })}
    </div>
  );
};

const TutorialCard = ({ step, title, desc, duration }: { step: string; title: string; desc: string; duration: string }) => (
  <div className="p-5 rounded-2xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] transition-all group cursor-pointer">
    <div className="flex items-center justify-between mb-3">
      <span className="text-xs font-bold text-blue-500 bg-blue-500/10 px-2.5 py-1 rounded-md">{step}</span>
      <span className="text-[10px] text-gray-600">{duration}</span>
    </div>
    <h3 className="text-sm font-semibold text-white mb-1.5 group-hover:text-blue-400 transition-colors">{title}</h3>
    <p className="text-xs text-gray-500 leading-relaxed">{desc}</p>
    <div className="mt-3 flex items-center gap-1.5 text-blue-400 text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity">
      <Play size={10} /> Watch tutorial
    </div>
  </div>
);


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADMIN DASHBOARD — Live data from server
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Same env-aware pattern licenseService / SupportBot / ManageSubscription
// use — admin actions in a local dev session need to hit local, not prod.
const API_BASE = (import.meta as any).env?.PROD
  ? 'https://api.minicaai.com'
  : ((import.meta as any).env?.VITE_SERVER_URL || 'https://api.minicaai.com');

type Tier = 'free' | 'basic' | 'pro' | 'max';
const TIERS: Tier[] = ['free', 'basic', 'pro', 'max'];

// Single source of truth for tier color-coding. Any place that shows a tier
// pulls its Tailwind classes from here so Free/Basic/Pro/Max always look the
// same across badges, cards, tables, and the action panel.
const TIER_THEME: Record<Tier, { bg: string; text: string; border: string; bar: string; dot: string; Icon: any }> = {
  free:  { bg: 'bg-slate-500/10',   text: 'text-slate-300',   border: 'border-slate-500/25',   bar: 'bg-slate-400',    dot: 'bg-slate-400',    Icon: Zap },
  basic: { bg: 'bg-emerald-500/10', text: 'text-emerald-300', border: 'border-emerald-500/25', bar: 'bg-emerald-400',  dot: 'bg-emerald-400',  Icon: Sparkles },
  pro:   { bg: 'bg-indigo-500/10',  text: 'text-indigo-300',  border: 'border-indigo-500/25',  bar: 'bg-indigo-400',   dot: 'bg-indigo-400',   Icon: Crown },
  max:   { bg: 'bg-amber-500/10',   text: 'text-amber-300',   border: 'border-amber-500/25',   bar: 'bg-amber-400',    dot: 'bg-amber-400',    Icon: WizardHat },
};
const tierOf = (t?: string): (typeof TIER_THEME)[Tier] => (TIER_THEME as any)[t || ''] || TIER_THEME.free;

const TierBadge = ({ tier }: { tier?: string }) => {
  const th = tierOf(tier);
  const label = (tier || 'free').toUpperCase();
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${th.bg} ${th.text} ${th.border}`}>
      {label === 'MAX' && <WizardHat size={9} />}
      {label}
    </span>
  );
};

// ── Per-user conversation viewer (admin only) ──
// Lazy-loads /admin/users/:id when first expanded. The /users/search
// payload only carries message_count per conversation; the full message
// thread requires the heavier endpoint (which also writes an audit log
// entry on the server side, so we don't fire it eagerly).
const ConversationsViewer = ({
  searchResult,
  token,
  onDeleteConversation,
}: {
  searchResult: any;
  token: string | null;
  onDeleteConversation?: (userId: string, convId: string, convName: string, messageCount: number) => void;
}) => {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<any[] | null>(null);
  const [openConvId, setOpenConvId] = useState<string | null>(null);
  // Tracks the conversation id we've already auto-opened for this user,
  // so the auto-open effect below runs exactly once per (user, list) —
  // without this, the admin clicking the header to close the thread
  // would immediately be undone by the effect re-firing on the null
  // openConvId state change. Cleared on user-swap below.
  const autoOpenedForRef = useRef<string | null>(null);
  // Monotonic request id. Each loadFull() stamps its invocation; responses
  // that arrive after a newer request started (or after the component
  // moved on to a different user) are discarded. Without this, a slow
  // fetch for user A could resolve after the admin switched to user B
  // and overwrite B's conversations list with A's — the stale-rows bug.
  const requestIdRef = useRef(0);

  const userId = searchResult?.user?.id;
  const stubCount = (searchResult?.conversations || []).length;
  const fmt = (ts: number) => (ts ? new Date(ts).toLocaleString() : '—');

  const loadFull = async () => {
    if (!userId || !token) return;
    const myRequestId = ++requestIdRef.current;
    const myUserId = userId;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/users/${myUserId}`, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      // Superseded — another loadFull fired after this one, or the admin
      // switched users. Either way, this response no longer represents
      // the current view. Drop it silently.
      if (myRequestId !== requestIdRef.current) return;
      if (!res.ok) throw new Error(data.error || 'Failed to load conversations');
      setConversations(Array.isArray(data.conversations) ? data.conversations : []);
    } catch (err: any) {
      if (myRequestId !== requestIdRef.current) return;
      setError(err.message || 'Failed to load conversations');
    } finally {
      if (myRequestId === requestIdRef.current) setLoading(false);
    }
  };

  // Reset view when the searched user changes. Always auto-expand AND
  // auto-load — even when stubCount is 0, so the admin sees a clear
  // "No conversations on record" instead of a closed accordion that
  // looks like data is hidden behind a button. Without this, after the
  // we-shipped client→server sync, an admin viewing a user with zero
  // synced conversations would get no signal at all.
  useEffect(() => {
    requestIdRef.current++;
    setConversations(null);
    setOpenConvId(null);
    autoOpenedForRef.current = null;
    setError(null);
    setExpanded(true);
    loadFull();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // When the full thread finishes loading and there's exactly one conversation,
  // open it automatically — saves the admin an extra click for the common
  // "one user, one session" case. Guard via the ref so that once the admin
  // manually collapses it, we don't re-open on the next render pass.
  useEffect(() => {
    if (
      expanded &&
      conversations &&
      conversations.length === 1 &&
      autoOpenedForRef.current !== conversations[0].id
    ) {
      autoOpenedForRef.current = conversations[0].id;
      setOpenConvId(conversations[0].id);
    }
  }, [expanded, conversations]);

  // Sync local list if the parent mutates the conversations array (e.g.
  // after an admin deletes one). Guard against empty arrays overwriting
  // a valid full-load on every parent re-render.
  useEffect(() => {
    const parentConvs = searchResult?.conversations;
    if (!Array.isArray(parentConvs) || !conversations) return;
    const parentIds = new Set(parentConvs.map((c: any) => c.id));
    const currentIds = new Set(conversations.map(c => c.id));
    const removed = [...currentIds].filter(id => !parentIds.has(id));
    if (removed.length > 0) {
      setConversations(cs => (cs || []).filter(c => parentIds.has(c.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchResult?.conversations]);

  const handleToggle = () => {
    if (!expanded && !conversations) loadFull();
    setExpanded(!expanded);
  };

  if (stubCount === 0) {
    return (
      <div className="mt-5 pt-4 border-t border-white/10">
        <p className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold mb-2">Conversations</p>
        <p className="text-[11px] text-gray-500 italic">No conversations on record.</p>
      </div>
    );
  }

  return (
    <div className="mt-5 pt-4 border-t border-white/10">
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between gap-2 mb-2 text-left"
        aria-expanded={expanded}
      >
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">
          Conversations ({stubCount})
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-gray-400 hover:text-white transition-colors">
          {loading ? <Loader2 size={11} className="animate-spin" /> : <ChevronDown size={11} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />}
          {expanded ? 'Hide' : 'View messages'}
        </span>
      </button>

      {error && (
        <div className="text-[11px] text-red-400 mb-2 px-2 py-1.5 bg-red-500/10 rounded border border-red-500/20">
          {error}
        </div>
      )}

      {expanded && conversations && (
        <div className="space-y-1.5 max-h-96 overflow-y-auto">
          {conversations.length === 0 && (
            <p className="text-[11px] text-gray-500 italic px-2">No messages found.</p>
          )}
          {conversations.map((conv: any) => {
            const isOpen = openConvId === conv.id;
            const msgs = Array.isArray(conv.messages) ? conv.messages : [];
            return (
              <div key={conv.id} className="rounded-lg border border-white/[0.06] bg-black/20 overflow-hidden">
                <div className="flex items-stretch">
                  <button
                    onClick={() => setOpenConvId(isOpen ? null : conv.id)}
                    className="flex-1 flex items-center justify-between gap-2 p-2.5 hover:bg-white/[0.03] text-left min-w-0"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <MessageCircle size={11} className="text-blue-400 shrink-0" />
                      <span className="text-[11px] font-semibold text-gray-200 truncate" title={conv.name}>
                        {conv.name || '(untitled)'}
                      </span>
                      <span className="text-[10px] text-gray-500 shrink-0">· {msgs.length} msg</span>
                    </div>
                    <span className="text-[10px] text-gray-500 whitespace-nowrap">{fmt(conv.updated_at || conv.created_at)}</span>
                    <ChevronDown size={10} className={`text-gray-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {onDeleteConversation && userId && (
                    <button
                      onClick={() => onDeleteConversation(userId, conv.id, conv.name || '(untitled)', msgs.length)}
                      className="px-2 text-gray-500 hover:text-red-300 hover:bg-red-500/10 border-l border-white/[0.06] transition-all"
                      title="Delete this conversation (admin)"
                      aria-label="Delete conversation"
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
                {isOpen && (
                  <div className="px-2.5 pb-2.5 space-y-1.5 border-t border-white/[0.04] pt-2 max-h-72 overflow-y-auto">
                    {msgs.length === 0 && (
                      <p className="text-[11px] text-gray-500 italic">(empty conversation)</p>
                    )}
                    {msgs.map((m: any) => {
                      const isUser = m.role === 'user';
                      return (
                        <div key={m.id} className={`flex flex-col gap-0.5 ${isUser ? 'items-end' : 'items-start'}`}>
                          <div className="flex items-center gap-2 text-[9px] uppercase tracking-wider text-gray-500">
                            <span className={isUser ? 'text-blue-400 font-semibold' : 'text-purple-400 font-semibold'}>
                              {m.role || 'unknown'}
                            </span>
                            <span>{fmt(m.timestamp)}</span>
                          </div>
                          <div className={`max-w-[85%] px-2.5 py-1.5 rounded-lg text-[11px] whitespace-pre-wrap break-words ${
                            isUser
                              ? 'bg-blue-500/10 border border-blue-500/20 text-blue-100'
                              : 'bg-white/[0.04] border border-white/[0.06] text-gray-200'
                          }`}>
                            {m.content}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// Admin tabs. Ordered to match the nav bar layout. "overview" is the
// command center, then user-focused (users), then money (payments, revoked),
// then security (logins, audit, analytics), then platform (settings).
type AdminTab = 'overview' | 'users' | 'conversations' | 'payments' | 'revoked' | 'logins' | 'audit' | 'analytics' | 'settings';
const ADMIN_TABS: AdminTab[] = ['overview', 'users', 'conversations', 'payments', 'revoked', 'logins', 'audit', 'analytics', 'settings'];

// CSV encoder — escapes cells per RFC 4180. Arrays/objects become JSON strings
// so they survive the round-trip; Excel and Google Sheets import this fine.
function toCsv(headers: string[], rows: any[][]): string {
  const esc = (v: any) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const head = headers.map(esc).join(',');
  const body = rows.map(r => r.map(esc).join(',')).join('\n');
  return `${head}\n${body}`;
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const AdminDashboard = ({ onBack, currentUser }: { onBack: () => void; currentUser: UserProfile }) => {
  const [stats, setStats] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [logins, setLogins] = useState<any[]>([]);
  const [loginsLoading, setLoginsLoading] = useState(false);
  // Audit-log row expansion — id of the currently-open row, or null. Stored
  // as a Set so multiple rows can be inspected at once when triaging.
  const [expandedAuditIds, setExpandedAuditIds] = useState<Set<string | number>>(new Set());
  const [auditLog, setAuditLog] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [adminTab, setAdminTab] = useState<AdminTab>('overview');

  // Quick-action form state
  const [revokeKey, setRevokeKey] = useState('');
  const [killVersion, setKillVersion] = useState('');
  const [searchEmail, setSearchEmail] = useState('');
  const [searchResult, setSearchResult] = useState<any>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Action-panel state — only active when there's a searchResult.
  const [panelTier, setPanelTier] = useState<Tier>('pro');
  const [panelCredits, setPanelCredits] = useState('');
  const [panelDays, setPanelDays] = useState('');
  const [panelBusy, setPanelBusy] = useState<string | null>(null);

  // Users tab filter state
  const [userFilterTier, setUserFilterTier] = useState<'all' | Tier>('all');
  const [userFilterStatus, setUserFilterStatus] = useState<'all' | 'active' | 'banned'>('all');
  const [userSearch, setUserSearch] = useState('');

  // Payments tab
  const [payments, setPayments] = useState<any[]>([]);
  const [paymentStats, setPaymentStats] = useState<any>(null);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [paymentFilters, setPaymentFilters] = useState<{
    provider: string;
    status: string;
    email: string;
    tier: string;
    from: string;
    to: string;
  }>({ provider: '', status: '', email: '', tier: '', from: '', to: '' });

  // Revoked keys tab
  const [revokedKeys, setRevokedKeys] = useState<any[]>([]);

  // Audit tab — filters
  const [auditFilters, setAuditFilters] = useState<{
    admin: string;
    action: string;
    target: string;
    from: string;
    to: string;
  }>({ admin: '', action: '', target: '', from: '', to: '' });
  const [auditFacets, setAuditFacets] = useState<{ actions: string[]; admins: string[] }>({ actions: [], admins: [] });
  const [auditLoading, setAuditLoading] = useState(false);

  // Analytics tab
  const [trends, setTrends] = useState<any[]>([]);
  const [topCustomers, setTopCustomers] = useState<any[]>([]);
  const [suspicious, setSuspicious] = useState<{ multi_country_users: any[]; high_fail_ips: any[] } | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);

  // Settings / config tab
  const [configRows, setConfigRows] = useState<any[]>([]);
  const [configDraft, setConfigDraft] = useState<Record<string, string>>({});
  const [configLoading, setConfigLoading] = useState(false);

  // Conversations tab — cross-user recent-activity feed. `q` is a client-held
  // filter (email or conv name) applied server-side on refresh. The admin
  // uses this tab to triage which users might need help without having to
  // guess an email first.
  const [recentConvs, setRecentConvs] = useState<any[]>([]);
  const [recentConvsLoading, setRecentConvsLoading] = useState(false);
  const [recentConvsQuery, setRecentConvsQuery] = useState('');

  // Step-up reauth state. stepUpToken takes precedence over the base token
  // for destructive admin calls. stepUpExpiresAt is a client-side clock we
  // use to hide the "reauth" badge — the backend enforces the real TTL.
  const [stepUpToken, setStepUpToken] = useState<string | null>(null);
  const [stepUpExpiresAt, setStepUpExpiresAt] = useState<number>(0);
  const [reauthPrompt, setReauthPrompt] = useState<{
    password: string;
    busy: boolean;
    error: string;
    pending: (() => void) | null;
  } | null>(null);

  // Reusable confirm modal for destructive admin actions. We can't use the
  // native confirm() — it paints outside Electron's setContentProtection and
  // leaks the target email during a screen-shared interview.
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => void;
  } | null>(null);

  // Per-user action modals (edit profile, delete user, comp grant, refund).
  // `original_country_code` is captured at open time so the modal can detect
  // when the admin actually changes the country (vs. opens-and-saves with the
  // current value). Drives the billing-region warning.
  const [editProfileFor, setEditProfileFor] = useState<{ id: string; email: string; name: string; country_code: string; original_country_code: string } | null>(null);
  const [compGrantFor, setCompGrantFor] = useState<{ id: string; email: string } | null>(null);
  const [refundFor, setRefundFor] = useState<{ payment: any } | null>(null);
  const [banFor, setBanFor] = useState<{ email: string } | null>(null);
  // Impersonation token modal — separate from the confirm dialog because the
  // token is long, must be selectable, and the copy action must succeed even
  // if the user just wants to read it before pasting elsewhere.
  const [impersonateToken, setImpersonateToken] = useState<{ email: string; token: string } | null>(null);

  const baseToken = licenseService.getToken();
  // `activeToken` picks the step-up token when it's still valid, otherwise the
  // base token. Pushed into a helper so every fetch uses the latest.
  const activeToken = () => {
    if (stepUpToken && Date.now() < stepUpExpiresAt) return stepUpToken;
    return baseToken;
  };
  const authHeaders = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${activeToken()}`,
  });
  // Stable header object for the initial fetch useEffect — avoids linter
  // complaints about headers changing identity.
  const token = baseToken;
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

  const showMsg = (text: string, type: 'success' | 'error' = 'success') => {
    setActionMsg({ text, type });
    setTimeout(() => setActionMsg(null), 4000);
  };

  // Fetch core data on mount. Audit log is lazy (fetched only when that tab
  // opens) because it can be large and most sessions won't touch it.
  useEffect(() => {
    async function loadAdmin() {
      setLoading(true);
      setAdminError(null);
      try {
        const [statsRes, usersRes, loginsRes] = await Promise.all([
          fetch(`${API_BASE}/api/v1/admin/stats`, { headers }),
          fetch(`${API_BASE}/api/v1/admin/users`, { headers }),
          fetch(`${API_BASE}/api/v1/admin/logins?limit=100`, { headers }),
        ]);
        if (!statsRes.ok) throw new Error('Failed to load admin data. Are you authorized?');
        setStats(await statsRes.json());
        setUsers(await usersRes.json());
        setLogins(await loginsRes.json());
      } catch (err: any) {
        setAdminError(err.message);
      } finally {
        setLoading(false);
      }
    }
    loadAdmin();
  }, []);

  // Legacy audit lazy-load — now superseded by loadAudit() which also
  // supplies filter support. Kept for the initial open of the tab so
  // the table has something to render before the user touches filters.
  useEffect(() => {
    if (adminTab !== 'audit' || auditLog.length > 0) return;
    fetch(`${API_BASE}/api/v1/admin/audit-log?limit=200`, { headers })
      .then(r => r.ok ? r.json() : [])
      .then(data => setAuditLog(Array.isArray(data) ? data : []))
      .catch(() => {/* non-fatal — tab will just show empty */});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminTab]);

  // Step-up reauth helper. Returns a promise that resolves once the admin
  // has re-entered their password (or rejects on cancel). Used by any action
  // guarded by stepUpOnly on the server. Keeps a single password prompt in
  // flight at a time — callers wait on `pending`.
  const requireStepUp = (): Promise<void> => {
    if (stepUpToken && Date.now() < stepUpExpiresAt) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      setReauthPrompt({
        password: '',
        busy: false,
        error: '',
        pending: () => resolve(),
      });
      // Reject if the modal is dismissed. We detect dismissal by a null
      // pending in a later setter. The cancel button calls reject directly
      // via its onClick; no leak.
      (reauthPrompt as any)?.reject?.(); // no-op; retained for clarity
      // We stash reject on the window so the cancel button can invoke it.
      (window as any).__reauthReject = () => reject(new Error('Reauth cancelled'));
    });
  };

  // Shared POST-mutation path. Handles fetch, JSON parse, error toast,
  // busy-state, and returns the parsed body (or null on error) so callers
  // can update local state only on success. Retries once after a fresh
  // step-up if the server responds with step_up_required / step_up_expired.
  async function callMutation(path: string, body: any, successMsg: string, opts: { method?: string } = {}) {
    const method = opts.method || 'POST';
    setPanelBusy(`${method}:${path}`);
    try {
      const attempt = async () => {
        const res = await fetch(`${API_BASE}${path}`, {
          method, headers: authHeaders(), body: method === 'GET' ? undefined : JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        return { res, data };
      };

      let { res, data } = await attempt();
      if (!res.ok && (data?.error === 'step_up_required' || data?.error === 'step_up_expired')) {
        try {
          await requireStepUp();
        } catch {
          showMsg('Reauth cancelled', 'error');
          return null;
        }
        ({ res, data } = await attempt());
      }
      if (!res.ok) throw new Error(data?.error || data?.message || 'Request failed');
      if (successMsg) showMsg(successMsg);
      return data;
    } catch (err: any) {
      showMsg(`Error: ${err.message}`, 'error');
      return null;
    } finally {
      setPanelBusy(null);
    }
  }

  async function callGet(path: string): Promise<any | null> {
    try {
      const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err: any) {
      showMsg(`Error: ${err.message}`, 'error');
      return null;
    }
  }

  // POST to /admin/reauth. Called by the step-up modal.
  async function submitReauth(password: string): Promise<boolean> {
    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/reauth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${baseToken}` },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Reauth failed');
      setStepUpToken(data.token);
      setStepUpExpiresAt(data.step_up_expires_at);
      return true;
    } catch (err: any) {
      showMsg(`Reauth failed: ${err.message}`, 'error');
      return false;
    }
  }

  // ── Quick actions (unchanged) ──
  const handleRevoke = async () => {
    if (!revokeKey.trim()) return;
    setActionLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/license/revoke`, {
        method: 'POST', headers, body: JSON.stringify({ key: revokeKey.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showMsg(`License ${revokeKey} revoked`);
      setRevokeKey('');
    } catch (err: any) { showMsg(`Error: ${err.message}`, 'error'); }
    finally { setActionLoading(false); }
  };

  const handleKillVersion = async () => {
    if (!killVersion.trim()) return;
    setActionLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/license/set-min-version`, {
        method: 'POST', headers, body: JSON.stringify({ version: killVersion.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showMsg(`Min version set to ${killVersion}`);
      setKillVersion('');
    } catch (err: any) { showMsg(`Error: ${err.message}`, 'error'); }
    finally { setActionLoading(false); }
  };

  const handleSearch = async (emailOverride?: string) => {
    const target = (emailOverride ?? searchEmail).trim();
    if (!target) return;
    setSearchEmail(target);
    setActionLoading(true);
    setSearchResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/users/search?email=${encodeURIComponent(target)}`, { headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSearchResult(data);
      setPanelTier((data.user?.tier as Tier) || 'pro');
    } catch (err: any) { showMsg(`Error: ${err.message}`, 'error'); setSearchResult(null); }
    finally { setActionLoading(false); }
  };

  // Patch the already-loaded user list so UI reflects the mutation without
  // a full refetch. Search result is patched the same way if it matches.
  const patchUserEverywhere = (email: string, patch: (u: any) => any) => {
    setUsers(prev => prev.map(u => u.email === email ? patch(u) : u));
    setSearchResult((sr: any) => sr && sr.user?.email === email ? { ...sr, user: patch(sr.user) } : sr);
  };

  const handleChangeTier = async (email: string, tier: Tier) => {
    const currentUserRow = searchResult?.user?.email === email
      ? searchResult.user
      : users.find(u => u.email === email);
    const fromTier = currentUserRow?.tier || '?';

    // Always confirm — tier change resets license state (sessions + expiry),
    // so accidental downgrades during a live interview would kick a paying
    // user out. Include from→to in the body so the admin can double-check.
    setConfirmDialog({
      title: `Change tier for ${email}?`,
      body: `Move ${email} from ${String(fromTier).toUpperCase()} → ${tier.toUpperCase()}. This resets sessions_limit and expires_at to the new tier's defaults. A step-up password prompt will appear.`,
      confirmLabel: `Move to ${tier.toUpperCase()}`,
      danger: tier === 'free',
      onConfirm: async () => {
        const data = await callMutation('/api/v1/admin/users/change-tier', { email, tier }, `${email} → ${tier.toUpperCase()}`);
        if (!data) return;
        patchUserEverywhere(email, u => ({ ...u, tier }));
        if (searchResult?.user.email === email) {
          setSearchResult((sr: any) => ({ ...sr, license: { ...sr.license, tier, status: 'active' } }));
        }
      },
    });
  };

  const handleGrantCredits = async (email: string) => {
    const n = parseInt(panelCredits, 10);
    if (!Number.isFinite(n) || n === 0) return showMsg('Enter non-zero credits', 'error');
    const data = await callMutation('/api/v1/admin/users/grant-credits', { email, credits: n }, `${n > 0 ? 'Granted' : 'Revoked'} ${Math.abs(n)} credit(s)`);
    if (!data) return;
    setPanelCredits('');
    if (data.license && searchResult?.user.email === email) {
      setSearchResult((sr: any) => ({ ...sr, license: data.license }));
    }
  };

  const handleExtendExpiry = async (email: string) => {
    const n = parseInt(panelDays, 10);
    if (!Number.isFinite(n) || n === 0) return showMsg('Enter non-zero days', 'error');
    const data = await callMutation('/api/v1/admin/users/extend-expiry', { email, days: n }, `${n > 0 ? 'Added' : 'Removed'} ${Math.abs(n)} day(s)`);
    if (!data) return;
    setPanelDays('');
    if (data.license && searchResult?.user.email === email) {
      setSearchResult((sr: any) => ({ ...sr, license: data.license }));
    }
  };

  const handleResetDevices = (email: string) => {
    setConfirmDialog({
      title: 'Clear device bindings?',
      body: `All device bindings for ${email} will be cleared. They'll need to re-bind on next sign-in.`,
      confirmLabel: 'Clear devices',
      onConfirm: async () => {
        const data = await callMutation('/api/v1/admin/users/reset-devices', { email }, 'Devices cleared');
        if (!data) return;
        if (searchResult?.user.email === email) {
          setSearchResult((sr: any) => ({ ...sr, devices: (sr.devices || []).map((d: any) => ({ ...d, is_active: 0 })) }));
        }
        patchUserEverywhere(email, u => ({ ...u, device_count: 0 }));
      },
    });
  };

  const handleForceLogout = (email: string) => {
    setConfirmDialog({
      title: 'Invalidate all sessions?',
      body: `All active sessions for ${email} will be revoked. They'll need to sign in again on every device.`,
      confirmLabel: 'Force logout',
      onConfirm: async () => {
        await callMutation('/api/v1/admin/users/force-logout', { email }, `${email} logged out everywhere`);
      },
    });
  };

  const handleBan = (email: string) => {
    // Open the dedicated ban modal so the admin can record a reason. The reason
    // is propagated to the audit log AND to the underlying license-revoke row,
    // so support can later explain to the user why they were locked out.
    setBanFor({ email });
  };

  const submitBan = async (email: string, reason: string) => {
    const data = await callMutation('/api/v1/admin/users/ban', { email, reason }, `${email} banned`);
    if (!data) return;
    patchUserEverywhere(email, u => ({ ...u, is_banned: 1 }));
    setBanFor(null);
  };

  const handleUnban = (email: string) => {
    setConfirmDialog({
      title: `Unban ${email}?`,
      body: `Their license will be reinstated and they'll be able to sign in again. This action is logged in the audit trail.`,
      confirmLabel: 'Unban user',
      onConfirm: async () => {
        const data = await callMutation('/api/v1/admin/users/unban', { email }, `${email} unbanned`);
        if (!data) return;
        patchUserEverywhere(email, u => ({ ...u, is_banned: 0 }));
      },
    });
  };

  // ── Enterprise actions — all route through callMutation and reload local state. ──

  const handleSendPasswordReset = (userId: string, email: string) => {
    setConfirmDialog({
      title: `Send password reset to ${email}?`,
      body: `A reset link will be emailed to ${email}. The link expires in 1 hour. Existing sessions stay active until they actually change the password.`,
      confirmLabel: 'Send reset email',
      onConfirm: async () => {
        await callMutation(`/api/v1/admin/users/${userId}/send-password-reset`, {}, `Password reset sent to ${email}`);
      },
    });
  };

  const handleCancelSubscription = (userId: string, email: string) => {
    setConfirmDialog({
      title: `Cancel subscription for ${email}?`,
      body: `Stripe/Razorpay will stop billing at end of the current period. The user keeps access until then. Requires step-up password.`,
      confirmLabel: 'Cancel at period end',
      onConfirm: async () => {
        await callMutation(`/api/v1/admin/users/${userId}/cancel-subscription`, {}, `Subscription cancellation scheduled for ${email}`);
      },
    });
  };

  const handleRevokeDevice = (userId: string, deviceRowId: number, deviceName: string) => {
    setConfirmDialog({
      title: `Revoke device?`,
      body: `Device "${deviceName || 'unnamed'}" will be deactivated. The user can re-bind on next login (subject to device limit).`,
      confirmLabel: 'Revoke this device',
      onConfirm: async () => {
        const data = await callMutation(`/api/v1/admin/users/${userId}/devices/${deviceRowId}/revoke`, {}, 'Device revoked');
        if (!data) return;
        // Mark inactive locally so the UI updates without a full reload.
        setSearchResult((sr: any) => sr && sr.user?.id === userId
          ? { ...sr, devices: (sr.devices || []).map((d: any) => d.id === deviceRowId ? { ...d, is_active: 0 } : d) }
          : sr);
      },
    });
  };

  const handleDeleteConversation = (userId: string, convId: string, convName: string, messageCount: number) => {
    setConfirmDialog({
      title: `Delete conversation?`,
      body: `"${convName || 'Untitled'}" (${messageCount} messages) will be permanently deleted for this user. This cannot be undone. Requires step-up.`,
      confirmLabel: 'Delete conversation',
      danger: true,
      onConfirm: async () => {
        const data = await callMutation(`/api/v1/admin/users/${userId}/conversations/${convId}`, {}, 'Conversation deleted', { method: 'DELETE' });
        if (!data) return;
        setSearchResult((sr: any) => sr && sr.user?.id === userId
          ? { ...sr, conversations: (sr.conversations || []).filter((c: any) => c.id !== convId) }
          : sr);
      },
    });
  };

  const handleDeleteUser = (userId: string, email: string) => {
    setConfirmDialog({
      title: `Permanently delete ${email}?`,
      body: `ALL data for ${email} will be wiped: conversations, payments, licenses, devices, login history. This CANNOT be undone. The audit log row stays. Requires step-up password.`,
      confirmLabel: 'Delete user forever',
      danger: true,
      onConfirm: async () => {
        const data = await callMutation(`/api/v1/admin/users/${userId}`, {}, `${email} deleted`, { method: 'DELETE' });
        if (!data) return;
        setUsers(prev => prev.filter(u => u.id !== userId));
        if (searchResult?.user?.id === userId) setSearchResult(null);
      },
    });
  };

  const handleImpersonate = (userId: string, email: string) => {
    setConfirmDialog({
      title: `Impersonate ${email}?`,
      body: `A scoped JWT for ${email} will be shown. All actions taken under this token are attributed to the target user AND audit-logged against you. Copy and paste into a separate client — DO NOT replace your own admin token.`,
      confirmLabel: 'Generate impersonation token',
      danger: true,
      onConfirm: async () => {
        const data = await callMutation(`/api/v1/admin/users/${userId}/impersonate`, {}, 'Impersonation token generated');
        if (!data) return;
        // Show the token in a dedicated modal — readonly text input so the
        // admin can select-all + copy manually if the clipboard write fails
        // (e.g. inside a sandboxed Electron renderer without permissions).
        setImpersonateToken({ email, token: data.token });
      },
    });
  };

  const handleEditProfile = (user: any) => {
    const cc = (user.country_code || '').toUpperCase();
    setEditProfileFor({
      id: user.id,
      email: user.email,
      name: user.name || '',
      country_code: cc,
      original_country_code: cc,
    });
  };

  const submitEditProfile = async () => {
    if (!editProfileFor) return;
    const data = await callMutation(
      `/api/v1/admin/users/${editProfileFor.id}`,
      { name: editProfileFor.name, country_code: editProfileFor.country_code },
      'Profile updated',
      { method: 'PATCH' },
    );
    if (!data) return;
    patchUserEverywhere(editProfileFor.email, u => ({
      ...u,
      name: editProfileFor.name,
      country_code: (editProfileFor.country_code || '').toUpperCase(),
    }));
    setEditProfileFor(null);
  };

  const handleGrantComp = (user: any) => {
    setCompGrantFor({ id: user.id, email: user.email });
  };

  const submitGrantComp = async (tier: Tier, note: string) => {
    if (!compGrantFor) return;
    const data = await callMutation(
      `/api/v1/admin/users/${compGrantFor.id}/grant-comp`,
      { tier, note },
      `${compGrantFor.email} granted ${tier.toUpperCase()} (comp)`,
    );
    if (!data) return;
    patchUserEverywhere(compGrantFor.email, u => ({ ...u, tier }));
    setCompGrantFor(null);
  };

  const handleRefund = (payment: any) => {
    setRefundFor({ payment });
  };

  const submitRefund = async (amount: number, reason: string) => {
    if (!refundFor) return;
    const data = await callMutation(
      `/api/v1/admin/payments/${refundFor.payment.id}/refund`,
      { amount, reason },
      `Refund of ${amount} ${refundFor.payment.currency} issued`,
    );
    if (!data) return;
    // Reload payments so the refund row appears. Keep user context untouched
    // — webhook will land the downgrade momentarily.
    setRefundFor(null);
    loadPayments();
  };

  const handleDsarExport = async (userId: string, email: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/users/${userId}/export`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `minicaai-dsar-${email.replace(/[^a-z0-9@._-]+/gi, '_')}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showMsg(`DSAR export downloaded for ${email}`);
    } catch (err: any) {
      showMsg(`Export failed: ${err.message}`, 'error');
    }
  };

  // ── Loaders for new tabs ──

  async function loadPayments() {
    setPaymentsLoading(true);
    const qs = new URLSearchParams();
    if (paymentFilters.provider) qs.set('provider', paymentFilters.provider);
    if (paymentFilters.status) qs.set('status', paymentFilters.status);
    if (paymentFilters.email) qs.set('email', paymentFilters.email);
    if (paymentFilters.tier) qs.set('tier', paymentFilters.tier);
    if (paymentFilters.from) {
      const ms = new Date(paymentFilters.from).getTime();
      if (Number.isFinite(ms)) qs.set('from', String(ms));
    }
    if (paymentFilters.to) {
      const ms = new Date(paymentFilters.to).getTime();
      if (Number.isFinite(ms)) qs.set('to', String(ms + 86_400_000 - 1)); // end of day
    }
    qs.set('limit', '500');
    const data = await callGet(`/api/v1/admin/payments?${qs.toString()}`);
    if (data) {
      setPayments(data.payments || []);
      setPaymentStats(data.stats || null);
    }
    setPaymentsLoading(false);
  }

  async function loadRevoked() {
    const data = await callGet('/api/v1/admin/revoked');
    if (data) setRevokedKeys(Array.isArray(data) ? data : []);
  }

  async function loadLogins() {
    setLoginsLoading(true);
    const data = await callGet('/api/v1/admin/logins?limit=100');
    if (Array.isArray(data)) setLogins(data);
    setLoginsLoading(false);
  }

  async function loadAudit() {
    setAuditLoading(true);
    const qs = new URLSearchParams();
    if (auditFilters.admin) qs.set('admin', auditFilters.admin);
    if (auditFilters.action) qs.set('action', auditFilters.action);
    if (auditFilters.target) qs.set('target', auditFilters.target);
    if (auditFilters.from) {
      const ms = new Date(auditFilters.from).getTime();
      if (Number.isFinite(ms)) qs.set('from', String(ms));
    }
    if (auditFilters.to) {
      const ms = new Date(auditFilters.to).getTime();
      if (Number.isFinite(ms)) qs.set('to', String(ms + 86_400_000 - 1));
    }
    qs.set('limit', '500');
    const data = await callGet(`/api/v1/admin/audit-log?${qs.toString()}`);
    if (Array.isArray(data)) setAuditLog(data);
    setAuditLoading(false);
  }

  async function loadAuditFacets() {
    const data = await callGet('/api/v1/admin/audit-log/facets');
    if (data) setAuditFacets({ actions: data.actions || [], admins: data.admins || [] });
  }

  async function loadAnalytics() {
    setAnalyticsLoading(true);
    const [tr, top, sus] = await Promise.all([
      callGet('/api/v1/admin/trends?days=30'),
      callGet('/api/v1/admin/top-customers?limit=20'),
      callGet('/api/v1/admin/suspicious'),
    ]);
    if (Array.isArray(tr)) setTrends(tr);
    if (Array.isArray(top)) setTopCustomers(top);
    if (sus) setSuspicious(sus);
    setAnalyticsLoading(false);
  }

  async function loadConfig() {
    setConfigLoading(true);
    const data = await callGet('/api/v1/admin/config');
    if (Array.isArray(data)) {
      setConfigRows(data);
      const draft: Record<string, string> = {};
      for (const row of data) draft[row.key] = row.value;
      setConfigDraft(draft);
    }
    setConfigLoading(false);
  }

  // Cross-user recent conversations. Pulls latest 50 by default; optional
  // server-side filter on email or conversation name. Safe to re-run on
  // every refresh — limit is capped server-side.
  async function loadRecentConversations() {
    setRecentConvsLoading(true);
    const qs = new URLSearchParams();
    qs.set('limit', '50');
    if (recentConvsQuery.trim()) qs.set('q', recentConvsQuery.trim());
    const data = await callGet(`/api/v1/admin/conversations/recent?${qs.toString()}`);
    if (Array.isArray(data)) setRecentConvs(data);
    setRecentConvsLoading(false);
  }

  // Tab-triggered lazy loads. Each tab loads its data the first time it
  // opens and on subsequent opens if the data is stale (we keep it simple
  // and only reload on first entry — user can hit a manual refresh button).
  useEffect(() => {
    if (adminTab === 'payments' && payments.length === 0) loadPayments();
    if (adminTab === 'revoked' && revokedKeys.length === 0) loadRevoked();
    if (adminTab === 'audit' && auditFacets.actions.length === 0) loadAuditFacets();
    if (adminTab === 'analytics' && trends.length === 0) loadAnalytics();
    if (adminTab === 'settings' && configRows.length === 0) loadConfig();
    if (adminTab === 'conversations' && recentConvs.length === 0) loadRecentConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminTab]);

  const fmtDate = (ts: number) => ts ? new Date(ts).toLocaleString() : '—';
  const fmtMoney = (n: number | null | undefined) => n == null ? '$0' : `$${Math.round(n).toLocaleString()}`;
  // Currency-aware formatter. Stripe stores USD in cents (divide by 100);
  // Razorpay stores INR in paise (divide by 100). Other currencies follow
  // ISO 4217 minor-unit convention, so /100 works for the common cases.
  const fmtAmount = (amount: number | null | undefined, currency: string | null | undefined) => {
    if (amount == null) return '—';
    const sign = amount < 0 ? '-' : '';
    const abs = Math.abs(amount);
    const major = abs / 100;
    const c = (currency || 'USD').toUpperCase();
    const symbol = c === 'INR' ? '₹' : c === 'USD' ? '$' : c === 'EUR' ? '€' : c === 'GBP' ? '£' : '';
    return `${sign}${symbol}${major.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${symbol ? '' : ' ' + c}`;
  };
  const openUserInPanel = (email: string) => { setAdminTab('overview'); handleSearch(email); };

  // Filtered users for the Users tab — applied at render time so tier/status
  // filters don't refetch. Avoids a roundtrip for a trivial client-side filter.
  const filteredUsers = users.filter(u => {
    if (userFilterTier !== 'all' && u.tier !== userFilterTier) return false;
    if (userFilterStatus === 'banned' && !u.is_banned) return false;
    if (userFilterStatus === 'active' && u.is_banned) return false;
    if (userSearch) {
      const q = userSearch.toLowerCase();
      if (!(u.email || '').toLowerCase().includes(q) && !(u.name || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // CSV exporters. Delegates to toCsv + downloadCsv defined above. All three
  // follow the same column order as the admin tables.
  const exportUsersCsv = () => {
    const headers = ['email', 'name', 'tier', 'country', 'sessions_used', 'sessions_limit', 'devices', 'created_at', 'last_login_at', 'status', 'stripe_customer_id'];
    const rows = filteredUsers.map(u => [
      u.email,
      u.name || '',
      u.tier,
      u.country_code || '',
      u.license?.sessions_used ?? 0,
      u.license?.sessions_limit ?? 0,
      u.device_count ?? 0,
      u.created_at ? new Date(u.created_at).toISOString() : '',
      u.last_login_at ? new Date(u.last_login_at).toISOString() : '',
      u.is_banned ? 'banned' : (u.license?.status || 'none'),
      u.stripe_customer_id || '',
    ]);
    downloadCsv(`minicaai-users-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(headers, rows));
  };

  const exportPaymentsCsv = () => {
    const headers = ['id', 'created_at', 'email', 'provider', 'provider_payment_id', 'amount', 'currency', 'status', 'tier_granted'];
    const rows = payments.map(p => [
      p.id,
      p.created_at ? new Date(p.created_at).toISOString() : '',
      p.email || '',
      p.provider,
      p.provider_payment_id || '',
      p.amount,
      p.currency,
      p.status,
      p.tier_granted || '',
    ]);
    downloadCsv(`minicaai-payments-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(headers, rows));
  };

  const exportAuditCsv = () => {
    const headers = ['id', 'created_at', 'admin_email', 'action', 'target_user_id', 'target_email', 'details'];
    const rows = auditLog.map(r => [
      r.id,
      r.created_at ? new Date(r.created_at).toISOString() : '',
      r.admin_email,
      r.action,
      r.target_user_id || '',
      r.target_email || '',
      r.details_json || '',
    ]);
    downloadCsv(`minicaai-audit-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(headers, rows));
  };

  return (
    <div className="fixed inset-0 bg-[#050507] text-white overflow-y-auto">
      <AnimatedBackground />
      <NoiseOverlay />
      <nav className="relative z-10 flex items-center justify-between px-6 py-4 max-w-7xl mx-auto">
        <Logo size="md" />
        <div className="flex items-center gap-2">
          <span className="px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-gradient-to-r from-red-500/20 to-purple-500/20 text-red-300 border border-red-500/30 flex items-center gap-1.5">
            <Shield size={10} /> Admin Console
          </span>
          {ADMIN_TABS.map(tab => (
            <button key={tab} onClick={() => setAdminTab(tab)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${adminTab === tab ? 'bg-white/[0.1] text-white border border-white/[0.15]' : 'text-gray-500 hover:text-gray-300 border border-transparent'}`}>
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
          {stepUpToken && Date.now() < stepUpExpiresAt && (
            <span className="px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1" title={`Step-up active until ${new Date(stepUpExpiresAt).toLocaleTimeString()}`}>
              <UserCheck size={10} /> Step-up
            </span>
          )}
          <button onClick={onBack} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-400 hover:text-white transition-colors flex items-center gap-1.5">
            <ArrowLeft size={14} /> Back
          </button>
        </div>
      </nav>

      <div className="relative z-10 max-w-7xl mx-auto px-6 pt-6 pb-20">
        {actionMsg && (
          <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-sm font-medium shadow-xl backdrop-blur-sm ${actionMsg.type === 'success' ? 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-300' : 'bg-red-500/20 border border-red-500/30 text-red-300'}`}>
            {actionMsg.text}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={24} className="text-blue-400 animate-spin" />
            <span className="ml-3 text-gray-400">Loading admin data...</span>
          </div>
        ) : adminError ? (
          <div className="text-center py-20">
            <AlertTriangle size={32} className="text-red-400 mx-auto mb-4" />
            <p className="text-red-400 text-sm">{adminError}</p>
            <p className="text-gray-600 text-xs mt-2">Make sure the server is running and you're authorized as admin.</p>
          </div>
        ) : (
          <>
            {/* ── OVERVIEW TAB ── */}
            {adminTab === 'overview' && (
              <div className="space-y-8">
                {/* Hero header */}
                <div className="flex items-end justify-between flex-wrap gap-4">
                  <div>
                    <h1 className="text-3xl font-bold tracking-tight mb-1 bg-gradient-to-r from-white via-white to-blue-200 bg-clip-text text-transparent">Command Center</h1>
                    <p className="text-gray-500 text-sm">Live intelligence · {currentUser.email}</p>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <p className="text-[10px] text-gray-600 uppercase tracking-widest">Monthly Revenue</p>
                      <p className="text-3xl font-bold text-emerald-400 tracking-tight">{fmtMoney(stats?.revenue_this_month)}</p>
                    </div>
                    <div className="h-10 w-px bg-white/10" />
                    <div className="text-right">
                      <p className="text-[10px] text-gray-600 uppercase tracking-widest">All Time</p>
                      <p className="text-2xl font-bold text-white tracking-tight">{fmtMoney(stats?.total_revenue)}</p>
                    </div>
                  </div>
                </div>

                {/* Primary search bar */}
                <div className="p-5 rounded-2xl border border-blue-500/20 bg-gradient-to-br from-blue-500/[0.08] via-indigo-500/[0.04] to-transparent shadow-lg shadow-blue-500/5">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="p-1.5 rounded-lg bg-blue-500/20"><Users size={14} className="text-blue-400" /></div>
                    <h4 className="text-sm font-semibold text-white">User Lookup &amp; Control</h4>
                    <span className="ml-auto text-[10px] text-gray-500 uppercase tracking-widest">Search · Modify · Audit</span>
                  </div>
                  <div className="flex gap-2">
                    <input value={searchEmail} onChange={e => setSearchEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()} placeholder="user@email.com" className="flex-1 px-4 py-2.5 rounded-lg bg-white/[0.04] border border-white/[0.1] text-white text-sm focus:outline-none focus:border-blue-500/60 transition-colors" />
                    <button onClick={() => handleSearch()} disabled={actionLoading} className="px-5 py-2.5 rounded-lg bg-blue-500 text-white text-sm font-semibold hover:bg-blue-400 transition-all shadow-md shadow-blue-500/20 disabled:opacity-50">
                      {actionLoading ? 'Searching…' : 'Search'}
                    </button>
                  </div>
                </div>

                {/* 4-Tier distribution */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-xs text-gray-500 uppercase tracking-widest font-semibold">Tier Distribution</h2>
                    <p className="text-[10px] text-gray-600">{stats?.total_users ?? 0} total users</p>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {TIERS.map(tier => {
                      const th = TIER_THEME[tier];
                      const Icon = th.Icon;
                      const count = stats?.tiers?.[tier] ?? 0;
                      const total = stats?.total_users || 1;
                      const pct = Math.round((count / total) * 100);
                      const revenue = stats?.revenue_by_tier?.[tier];
                      const signups = stats?.signups_by_tier?.[tier] ?? 0;
                      return (
                        <div key={tier} className={`p-4 rounded-2xl border ${th.border} ${th.bg} relative overflow-hidden hover:scale-[1.02] transition-transform`}>
                          <div className="flex items-start justify-between mb-3">
                            <div className="p-2 rounded-lg bg-white/[0.06]"><Icon size={16} className={th.text} /></div>
                            <span className={`text-[10px] font-bold uppercase tracking-widest ${th.text}`}>{tier}</span>
                          </div>
                          <p className="text-3xl font-bold text-white tracking-tight">{count.toLocaleString()}</p>
                          <div className="flex items-baseline justify-between mt-1 mb-2">
                            <p className="text-[10px] text-gray-500">{pct}% · +{signups} this month</p>
                            {revenue != null && revenue > 0 && (
                              <p className={`text-[11px] font-bold ${th.text}`}>{fmtMoney(revenue)}</p>
                            )}
                          </div>
                          <div className="h-1 bg-white/[0.05] rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${th.bar} transition-all duration-500`} style={{ width: `${Math.max(pct, 2)}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Search result — full action panel */}
                {searchResult && (() => {
                  const u = searchResult.user;
                  const lic = searchResult.license;
                  const devs = searchResult.devices || [];
                  const activeDevs = devs.filter((d: any) => d.is_active).length;
                  const loginHist = searchResult.login_history || [];
                  const th = tierOf(u.tier);
                  return (
                    <div className={`p-6 rounded-2xl border ${th.border} ${th.bg} shadow-xl shadow-black/20`}>
                      {/* Header */}
                      <div className="flex items-start justify-between gap-3 mb-5 pb-4 border-b border-white/10">
                        <div className="flex items-center gap-3">
                          {u.avatar_url ? (
                            <img src={u.avatar_url} alt="" className={`w-12 h-12 rounded-full border-2 ${th.border}`} />
                          ) : (
                            <div className={`w-12 h-12 rounded-full flex items-center justify-center text-lg font-bold ${th.text} border ${th.border} bg-black/30`}>
                              {(u.name || u.email || '?').charAt(0).toUpperCase()}
                            </div>
                          )}
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <h4 className="text-base font-bold text-white">{u.name || u.email}</h4>
                              <TierBadge tier={u.tier} />
                              {u.is_banned ? <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-red-500/20 text-red-400 border border-red-500/30">Banned</span> : null}
                            </div>
                            <p className="text-xs text-gray-400">{u.email} · {u.country_code || '—'} · joined {fmtDate(u.created_at)}</p>
                          </div>
                        </div>
                        <button onClick={() => setSearchResult(null)} className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/[0.05] transition-all"><X size={16} /></button>
                      </div>

                      {/* Data grid */}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs mb-6">
                        <div><span className="text-gray-500 uppercase text-[9px] tracking-wider block mb-0.5">License</span><span className="text-white font-mono text-[11px]">{lic?.key || '—'}</span></div>
                        <div><span className="text-gray-500 uppercase text-[9px] tracking-wider block mb-0.5">Status</span><span className={`font-bold ${lic?.status === 'active' ? 'text-emerald-400' : lic?.status === 'revoked' ? 'text-red-400' : 'text-amber-400'}`}>{(lic?.status || 'none').toUpperCase()}</span></div>
                        <div><span className="text-gray-500 uppercase text-[9px] tracking-wider block mb-0.5">Sessions</span><span className="text-white font-semibold">{lic?.sessions_used ?? 0} / {lic?.sessions_limit === -1 ? '∞' : (lic?.sessions_limit ?? 0)}</span></div>
                        <div><span className="text-gray-500 uppercase text-[9px] tracking-wider block mb-0.5">Expires</span><span className="text-white">{lic?.expires_at === -1 ? 'Never' : fmtDate(lic?.expires_at)}</span></div>
                        <div><span className="text-gray-500 uppercase text-[9px] tracking-wider block mb-0.5">Devices</span><span className="text-white font-semibold">{activeDevs} active · {devs.length} total</span></div>
                        <div><span className="text-gray-500 uppercase text-[9px] tracking-wider block mb-0.5">Last login</span><span className="text-white">{fmtDate(u.last_login_at)}</span></div>
                        <div><span className="text-gray-500 uppercase text-[9px] tracking-wider block mb-0.5">Payments</span><span className="text-white font-semibold">{searchResult.payments?.length ?? 0}</span></div>
                        <div><span className="text-gray-500 uppercase text-[9px] tracking-wider block mb-0.5">Conversations</span><span className="text-white font-semibold">{searchResult.conversations?.length ?? 0}</span></div>
                      </div>

                      {/* Action panel */}
                      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
                        <div className="p-3 rounded-xl border border-white/10 bg-black/30">
                          <label className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold block mb-2">Change tier</label>
                          <div className="flex gap-2">
                            <select value={panelTier} onChange={e => setPanelTier(e.target.value as Tier)} className="flex-1 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.1] text-white text-xs focus:outline-none focus:border-blue-500/50">
                              {TIERS.map(t => <option key={t} value={t}>{t.toUpperCase()}</option>)}
                            </select>
                            <button onClick={() => handleChangeTier(u.email, panelTier)} disabled={!!panelBusy || panelTier === u.tier} className="px-3 py-2 rounded-lg bg-indigo-500/20 text-indigo-300 text-xs font-semibold hover:bg-indigo-500/30 border border-indigo-500/30 disabled:opacity-40 transition-all">
                              Apply
                            </button>
                          </div>
                        </div>

                        <div className="p-3 rounded-xl border border-white/10 bg-black/30">
                          <label className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold block mb-2">Grant credits (+/−)</label>
                          <div className="flex gap-2">
                            <input type="number" value={panelCredits} onChange={e => setPanelCredits(e.target.value)} placeholder="e.g. 10" className="flex-1 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.1] text-white text-xs focus:outline-none focus:border-emerald-500/50" />
                            <button onClick={() => handleGrantCredits(u.email)} disabled={!!panelBusy} className="px-3 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 text-xs font-semibold hover:bg-emerald-500/30 border border-emerald-500/30 disabled:opacity-40 transition-all">
                              Grant
                            </button>
                          </div>
                        </div>

                        <div className="p-3 rounded-xl border border-white/10 bg-black/30">
                          <label className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold block mb-2">Extend expiry (days)</label>
                          <div className="flex gap-2">
                            <input type="number" value={panelDays} onChange={e => setPanelDays(e.target.value)} placeholder="e.g. 30" className="flex-1 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.1] text-white text-xs focus:outline-none focus:border-cyan-500/50" />
                            <button onClick={() => handleExtendExpiry(u.email)} disabled={!!panelBusy} className="px-3 py-2 rounded-lg bg-cyan-500/20 text-cyan-300 text-xs font-semibold hover:bg-cyan-500/30 border border-cyan-500/30 disabled:opacity-40 transition-all">
                              Extend
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Session & access controls — reversible operations
                          that bring a user back to a clean state without
                          destroying their account. Grouped separately from
                          the account-lifecycle actions below so the admin
                          can't accidentally confuse "reset their devices"
                          with "delete their account". */}
                      <div className="flex flex-wrap gap-2 pt-3 border-t border-white/10">
                        <button onClick={() => handleResetDevices(u.email)} disabled={!!panelBusy} className="px-3 py-2 rounded-lg bg-amber-500/10 text-amber-300 text-xs font-semibold hover:bg-amber-500/20 border border-amber-500/20 disabled:opacity-40 transition-all flex items-center gap-1.5">
                          <Monitor size={12} /> Reset Devices ({activeDevs})
                        </button>
                        <button onClick={() => handleForceLogout(u.email)} disabled={!!panelBusy} className="px-3 py-2 rounded-lg bg-orange-500/10 text-orange-300 text-xs font-semibold hover:bg-orange-500/20 border border-orange-500/20 disabled:opacity-40 transition-all flex items-center gap-1.5">
                          <LogOut size={12} /> Force Logout
                        </button>
                        {u.is_banned ? (
                          <button onClick={() => handleUnban(u.email)} disabled={!!panelBusy} className="px-3 py-2 rounded-lg bg-emerald-500/10 text-emerald-300 text-xs font-semibold hover:bg-emerald-500/20 border border-emerald-500/20 disabled:opacity-40 transition-all flex items-center gap-1.5">
                            <Check size={12} /> Unban
                          </button>
                        ) : (
                          <button onClick={() => handleBan(u.email)} disabled={!!panelBusy} className="px-3 py-2 rounded-lg bg-red-500/10 text-red-300 text-xs font-semibold hover:bg-red-500/20 border border-red-500/20 disabled:opacity-40 transition-all flex items-center gap-1.5">
                            <X size={12} /> Ban User
                          </button>
                        )}
                        {lic?.key && (
                          <button onClick={() => { setRevokeKey(lic.key); showMsg('License key loaded into Revoke field'); }} className="ml-auto px-3 py-2 rounded-lg bg-white/[0.04] text-gray-400 text-xs font-semibold hover:text-white hover:bg-white/[0.08] border border-white/[0.08] transition-all">
                            Stage for Revoke
                          </button>
                        )}
                      </div>

                      {/* Account lifecycle & support actions. All of these
                          hit /api/v1/admin/users/:id/* endpoints that
                          require step-up reauth on the backend — the UI
                          layer will transparently prompt for password on
                          first click via callMutation's retry loop. The
                          Delete button is last + red for muscle-memory
                          safety. Impersonate opens a modal with the scoped
                          JWT and a copy-to-clipboard button; DO NOT
                          replace your own token in this session. */}
                      <div className="flex flex-wrap gap-2 pt-3 border-t border-white/10">
                        <button onClick={() => handleEditProfile(u)} disabled={!!panelBusy} className="px-3 py-2 rounded-lg bg-white/[0.04] text-gray-300 text-xs font-semibold hover:bg-white/[0.08] border border-white/[0.08] disabled:opacity-40 transition-all flex items-center gap-1.5" title="Edit name / country_code">
                          <Edit2 size={12} /> Edit Profile
                        </button>
                        <button onClick={() => handleSendPasswordReset(u.id, u.email)} disabled={!!panelBusy} className="px-3 py-2 rounded-lg bg-blue-500/10 text-blue-300 text-xs font-semibold hover:bg-blue-500/20 border border-blue-500/20 disabled:opacity-40 transition-all flex items-center gap-1.5" title="Email a reset link to the user">
                          <Key size={12} /> Send Password Reset
                        </button>
                        {u.stripe_customer_id ? (
                          <button onClick={() => handleCancelSubscription(u.id, u.email)} disabled={!!panelBusy} className="px-3 py-2 rounded-lg bg-rose-500/10 text-rose-300 text-xs font-semibold hover:bg-rose-500/20 border border-rose-500/20 disabled:opacity-40 transition-all flex items-center gap-1.5" title="Cancel active subscription with payment provider">
                            <XCircle size={12} /> Cancel Subscription
                          </button>
                        ) : null}
                        <button onClick={() => handleGrantComp(u)} disabled={!!panelBusy} className="px-3 py-2 rounded-lg bg-emerald-500/10 text-emerald-300 text-xs font-semibold hover:bg-emerald-500/20 border border-emerald-500/20 disabled:opacity-40 transition-all flex items-center gap-1.5" title="Grant complimentary tier (zero-cost)">
                          <Gift size={12} /> Grant Comp
                        </button>
                        <button onClick={() => handleDsarExport(u.id, u.email)} disabled={!!panelBusy} className="px-3 py-2 rounded-lg bg-cyan-500/10 text-cyan-300 text-xs font-semibold hover:bg-cyan-500/20 border border-cyan-500/20 disabled:opacity-40 transition-all flex items-center gap-1.5" title="Download GDPR data subject access export (JSON)">
                          <Database size={12} /> DSAR Export
                        </button>
                        <button onClick={() => handleImpersonate(u.id, u.email)} disabled={!!panelBusy} className="px-3 py-2 rounded-lg bg-yellow-500/10 text-yellow-300 text-xs font-semibold hover:bg-yellow-500/20 border border-yellow-500/20 disabled:opacity-40 transition-all flex items-center gap-1.5" title="Generate a scoped JWT to debug as this user (DO NOT paste into your own tab)">
                          <UserCheck size={12} /> Impersonate
                        </button>
                        <button onClick={() => handleDeleteUser(u.id, u.email)} disabled={!!panelBusy} className="ml-auto px-3 py-2 rounded-lg bg-red-500/20 text-red-300 text-xs font-semibold hover:bg-red-500/30 border border-red-500/40 disabled:opacity-40 transition-all flex items-center gap-1.5" title="Permanently delete user + all data (irreversible)">
                          <Trash2 size={12} /> Delete User
                        </button>
                      </div>

                      {/* Devices — per-device platform/OS so the admin can
                          tell whether the user is on Mac, Windows, or Linux
                          without having to ask them. Platform may be null
                          for rows registered before the platform-tracking
                          migration shipped — those render as "Unknown". */}
                      {devs.length > 0 && (
                        <div className="mt-5 pt-4 border-t border-white/10">
                          <p className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold mb-2">
                            Devices ({activeDevs} active · {devs.length} total)
                          </p>
                          <div className="space-y-1 max-h-48 overflow-y-auto">
                            {devs.map((dev: any, i: number) => (
                              <div key={i} className={`flex items-center justify-between gap-3 text-[11px] py-1.5 px-2 rounded ${dev.is_active ? 'bg-white/[0.02]' : 'opacity-50'}`}>
                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                  <Monitor size={11} className={dev.is_active ? 'text-emerald-400' : 'text-gray-600'} />
                                  <span className="px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 text-blue-300 text-[10px] font-semibold uppercase tracking-wider shrink-0">
                                    {dev.platform || 'Unknown'}
                                  </span>
                                  <span className="text-gray-400 truncate font-mono text-[10px]" title={dev.device_name}>
                                    {dev.device_name || '—'}
                                  </span>
                                </div>
                                <span className="text-gray-500 whitespace-nowrap text-[10px]">{fmtDate(dev.last_seen_at)}</span>
                                <span className={`font-bold text-[10px] ${dev.is_active ? 'text-emerald-400' : 'text-gray-500'}`}>
                                  {dev.is_active ? 'ACTIVE' : 'INACTIVE'}
                                </span>
                                {/* Per-device revoke. Only meaningful for
                                    rows still marked ACTIVE — revoking an
                                    already-inactive device is a no-op on
                                    the backend, so hide the button entirely
                                    to keep the row uncluttered. Confirms
                                    via handleRevokeDevice so the admin can
                                    back out if they clicked the wrong row. */}
                                {dev.is_active && dev.id ? (
                                  <button
                                    onClick={() => handleRevokeDevice(u.id, dev.id, dev.device_name || dev.platform || 'device')}
                                    disabled={!!panelBusy}
                                    className="px-2 py-0.5 rounded bg-red-500/10 text-red-300 text-[10px] font-bold uppercase tracking-wider hover:bg-red-500/20 border border-red-500/20 disabled:opacity-40 transition-all flex items-center gap-1"
                                    title="Revoke this device only — other devices keep their sessions"
                                    aria-label="Revoke this device"
                                  >
                                    <Ban size={10} /> Revoke
                                  </button>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Recent login history — now includes platform */}
                      {loginHist.length > 0 && (
                        <div className="mt-5 pt-4 border-t border-white/10">
                          <p className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold mb-2">Recent logins</p>
                          <div className="space-y-1 max-h-48 overflow-y-auto">
                            {loginHist.slice(0, 10).map((log: any, i: number) => (
                              <div key={i} className="flex items-center justify-between gap-3 text-[11px] py-1 px-2 rounded hover:bg-white/[0.03]">
                                <span className="text-gray-400 whitespace-nowrap">{fmtDate(log.created_at)}</span>
                                <span className="px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 text-blue-300 text-[10px] font-semibold uppercase tracking-wider shrink-0">
                                  {log.platform || '—'}
                                </span>
                                <span className="text-gray-500 font-mono truncate">{log.ip_address || '—'} · {log.country_code || '—'}</span>
                                <span className={`font-bold ${log.success ? 'text-emerald-400' : 'text-red-400'}`}>{log.success ? 'OK' : 'FAIL'}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Conversations + messages viewer. The /admin/users/:id
                          endpoint already returns conversationsWithMessages
                          (full role/content/timestamp). Each conversation
                          collapses by default; click to expand and read the
                          message thread. Admin delete is wired via
                          onDeleteConversation — handleDeleteConversation
                          shows a confirm dialog with the message count so
                          the admin doesn't nuke someone's thread by
                          accident. */}
                      <ConversationsViewer
                        searchResult={searchResult}
                        token={token}
                        onDeleteConversation={handleDeleteConversation}
                      />
                    </div>
                  );
                })()}

                {/* Activity metrics */}
                <div>
                  <h2 className="text-xs text-gray-500 uppercase tracking-widest font-semibold mb-3">Activity</h2>
                  <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                    {[
                      { label: 'Total Users', value: stats?.total_users ?? 0, color: 'text-white', Icon: Users },
                      { label: 'Active Today', value: stats?.active_today ?? 0, color: 'text-emerald-400', Icon: Zap },
                      { label: 'Logins Today', value: stats?.logins_today ?? 0, color: 'text-cyan-400', Icon: LogOut },
                      { label: 'Signups 30d', value: stats?.signups_this_month ?? 0, color: 'text-purple-400', Icon: Sparkles },
                      { label: 'Conversations', value: stats?.total_conversations ?? 0, color: 'text-indigo-400', Icon: MessageCircle },
                      { label: 'Messages', value: stats?.total_messages ?? 0, color: 'text-blue-400', Icon: Send },
                    ].map(({ label, value, color, Icon }, i) => (
                      <div key={i} className="p-3 rounded-xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] transition-colors">
                        <div className="flex items-center gap-1.5 mb-1">
                          <Icon size={10} className="text-gray-600" />
                          <p className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</p>
                        </div>
                        <p className={`text-2xl font-bold tracking-tight ${color}`}>{Number(value).toLocaleString()}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Risk signals */}
                <div>
                  <h2 className="text-xs text-gray-500 uppercase tracking-widest font-semibold mb-3">Risk &amp; Trust</h2>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                      { label: 'Banned Users', value: stats?.banned_users ?? 0, color: 'text-red-400', Icon: AlertTriangle },
                      { label: 'Revoked Keys', value: stats?.revoked_licenses ?? 0, color: 'text-orange-400', Icon: Lock },
                      { label: 'Failed Logins (24h)', value: stats?.failed_logins_today ?? 0, color: 'text-pink-400', Icon: Shield },
                      { label: 'Active Devices', value: stats?.total_devices ?? 0, color: 'text-amber-400', Icon: Monitor },
                    ].map(({ label, value, color, Icon }, i) => (
                      <div key={i} className="p-3 rounded-xl border border-white/[0.06] bg-white/[0.02]">
                        <div className="flex items-center gap-1.5 mb-1">
                          <Icon size={10} className="text-gray-600" />
                          <p className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</p>
                        </div>
                        <p className={`text-2xl font-bold tracking-tight ${color}`}>{Number(value).toLocaleString()}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Secondary quick actions */}
                <div className="grid md:grid-cols-3 gap-4">
                  <div className="p-5 rounded-xl border border-white/[0.06] bg-white/[0.02]">
                    <div className="flex items-center gap-2 mb-2"><Lock size={14} className="text-red-400" /><h4 className="text-sm font-semibold text-white">Revoke License</h4></div>
                    <p className="text-xs text-gray-500 mb-3">Invalidate a license key</p>
                    <div className="flex gap-2">
                      <input value={revokeKey} onChange={e => setRevokeKey(e.target.value)} placeholder="MNC-..." className="flex-1 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none focus:border-red-500/50" />
                      <button onClick={handleRevoke} disabled={actionLoading} className="px-4 py-2 rounded-lg bg-red-500/20 text-red-400 text-xs font-semibold hover:bg-red-500/30 transition-all border border-red-500/20 disabled:opacity-50">Revoke</button>
                    </div>
                  </div>
                  <div className="p-5 rounded-xl border border-white/[0.06] bg-white/[0.02]">
                    <div className="flex items-center gap-2 mb-2"><AlertTriangle size={14} className="text-amber-400" /><h4 className="text-sm font-semibold text-white">Kill App Version</h4></div>
                    <p className="text-xs text-gray-500 mb-3">Force-expire old app versions</p>
                    <div className="flex gap-2">
                      <input value={killVersion} onChange={e => setKillVersion(e.target.value)} placeholder="e.g. 2.1.0" className="flex-1 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none focus:border-amber-500/50" />
                      <button onClick={handleKillVersion} disabled={actionLoading} className="px-4 py-2 rounded-lg bg-amber-500/20 text-amber-400 text-xs font-semibold hover:bg-amber-500/30 transition-all border border-amber-500/20 disabled:opacity-50">Set</button>
                    </div>
                  </div>
                  <div className="p-5 rounded-xl border border-white/[0.06] bg-white/[0.02]">
                    <div className="flex items-center gap-2 mb-2"><div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /><h4 className="text-sm font-semibold text-white">Server</h4></div>
                    <p className="text-xs text-emerald-400 font-medium mb-0.5">Online</p>
                    <p className="text-[10px] text-gray-600">minicaai.com · v{licenseService.getAppVersion()}</p>
                  </div>
                </div>
              </div>
            )}

            {/* ── USERS TAB ── */}
            {adminTab === 'users' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <h1 className="text-2xl font-bold mb-1">All Users</h1>
                    <p className="text-gray-500 text-sm">
                      Showing {filteredUsers.length.toLocaleString()} of {users.length.toLocaleString()} users
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-[10px]">
                    {TIERS.map(t => {
                      const c = users.filter(u => u.tier === t).length;
                      const th = TIER_THEME[t];
                      return (
                        <span key={t} className={`px-2 py-1 rounded border ${th.border} ${th.bg} ${th.text} font-semibold`}>
                          {t.toUpperCase()} · {c}
                        </span>
                      );
                    })}
                    <button onClick={exportUsersCsv} className="ml-2 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-gray-300 hover:bg-white/[0.08] border border-white/[0.08] flex items-center gap-1.5 transition-all">
                      <FileDown size={11} /> Export CSV
                    </button>
                  </div>
                </div>

                {/* Filters bar */}
                <div className="flex flex-wrap items-center gap-2 p-3 rounded-xl border border-white/[0.06] bg-white/[0.02]">
                  <Filter size={12} className="text-gray-500" />
                  <input
                    value={userSearch}
                    onChange={e => setUserSearch(e.target.value)}
                    placeholder="Search email or name…"
                    className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none focus:border-blue-500/50 w-56"
                  />
                  <select value={userFilterTier} onChange={e => setUserFilterTier(e.target.value as any)} className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none">
                    <option value="all">All tiers</option>
                    {TIERS.map(t => <option key={t} value={t}>{t.toUpperCase()}</option>)}
                  </select>
                  <select value={userFilterStatus} onChange={e => setUserFilterStatus(e.target.value as any)} className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none">
                    <option value="all">All status</option>
                    <option value="active">Active only</option>
                    <option value="banned">Banned only</option>
                  </select>
                  {(userSearch || userFilterTier !== 'all' || userFilterStatus !== 'all') && (
                    <button onClick={() => { setUserSearch(''); setUserFilterTier('all'); setUserFilterStatus('all'); }} className="px-2 py-1 rounded text-[10px] text-gray-400 hover:text-white hover:bg-white/[0.04] transition-all">
                      Clear
                    </button>
                  )}
                </div>

                <div className="border border-white/[0.06] rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Email</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Name</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Tier</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Country</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Sessions</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Devices</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Created</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Last Login</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Status</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Provider</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredUsers.map((u: any, i: number) => {
                          // Sessions display: show the real backing license state
                          // when there is one, or an honest "no license" label
                          // when there isn't. The prior `?? 5` fallback made
                          // license-less users look like they had free-tier
                          // credits, which was misleading.
                          const lic = u.license;
                          const sessionsDisplay = !lic
                            ? '— / —'
                            : `${lic.sessions_used ?? 0} / ${lic.sessions_limit === -1 ? '∞' : lic.sessions_limit}`;
                          const providerBadge = u.stripe_customer_id
                            ? (u.stripe_customer_id.startsWith('rzp_') ? 'Razorpay' : 'Stripe')
                            : (u.oauth_provider ? 'Google' : '—');
                          return (
                            <tr key={u.id || i} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                              <td className="px-4 py-3 text-white font-medium">{u.email}</td>
                              <td className="px-4 py-3 text-gray-400">{u.name || '—'}</td>
                              <td className="px-4 py-3"><TierBadge tier={u.tier} /></td>
                              <td className="px-4 py-3 text-gray-400">{u.country_code || '—'}</td>
                              <td className="px-4 py-3 text-gray-400 whitespace-nowrap">{sessionsDisplay}</td>
                              <td className="px-4 py-3 text-gray-400">{u.device_count ?? 0}</td>
                              <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(u.created_at)}</td>
                              <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(u.last_login_at)}</td>
                              <td className="px-4 py-3">
                                {u.is_banned ? (
                                  <span className="text-red-400 font-bold text-[10px]">BANNED</span>
                                ) : (
                                  <span className={`text-[10px] font-medium ${u.license?.status === 'active' ? 'text-emerald-400' : u.license?.status === 'expired' ? 'text-gray-500' : u.license?.status === 'revoked' ? 'text-red-400' : 'text-gray-500'}`}>
                                    {u.license?.status?.toUpperCase() || 'NONE'}
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-gray-400 text-[10px]">{providerBadge}</td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-1 flex-wrap">
                                  <button onClick={() => openUserInPanel(u.email)} className="px-2 py-1 rounded text-[10px] font-semibold bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/20 transition-all" title="Manage user">
                                    Manage
                                  </button>
                                  <button onClick={() => handleEditProfile(u)} className="p-1 rounded text-[10px] text-gray-400 hover:text-white hover:bg-white/[0.05] transition-all" title="Edit profile">
                                    <Edit2 size={11} />
                                  </button>
                                  <button onClick={() => handleSendPasswordReset(u.id, u.email)} className="p-1 rounded text-[10px] text-gray-400 hover:text-blue-300 hover:bg-white/[0.05] transition-all" title="Send password reset">
                                    <Key size={11} />
                                  </button>
                                  <button onClick={() => handleGrantComp(u)} className="p-1 rounded text-[10px] text-gray-400 hover:text-emerald-300 hover:bg-white/[0.05] transition-all" title="Grant comp tier">
                                    <Gift size={11} />
                                  </button>
                                  <button onClick={() => handleDsarExport(u.id, u.email)} className="p-1 rounded text-[10px] text-gray-400 hover:text-cyan-300 hover:bg-white/[0.05] transition-all" title="DSAR data export (JSON)">
                                    <Database size={11} />
                                  </button>
                                  <button onClick={() => handleImpersonate(u.id, u.email)} className="p-1 rounded text-[10px] text-gray-400 hover:text-amber-300 hover:bg-white/[0.05] transition-all" title="Impersonate user">
                                    <UserCheck size={11} />
                                  </button>
                                  <button onClick={() => handleDeleteUser(u.id, u.email)} className="p-1 rounded text-[10px] text-gray-400 hover:text-red-300 hover:bg-red-500/10 transition-all" title="Permanently delete user">
                                    <Trash2 size={11} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {filteredUsers.length === 0 && (
                    <div className="text-center py-12 text-gray-600 text-sm">
                      {users.length === 0 ? 'No users yet' : 'No users match current filters'}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── LOGINS TAB ── */}
            {adminTab === 'logins' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <h1 className="text-2xl font-bold mb-1">Login Activity</h1>
                    <p className="text-gray-500 text-sm">Last 100 login attempts {logins.length > 0 && `· showing ${logins.length}`}</p>
                  </div>
                  <button
                    onClick={loadLogins}
                    disabled={loginsLoading}
                    className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-gray-300 hover:bg-white/[0.08] border border-white/[0.08] flex items-center gap-1.5 transition-all disabled:opacity-50"
                  >
                    <RefreshCw size={11} className={loginsLoading ? 'animate-spin' : ''} /> {loginsLoading ? 'Refreshing…' : 'Refresh'}
                  </button>
                </div>

                <div className="border border-white/[0.06] rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Time</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Email</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">IP</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Country</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Platform</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Device</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Status</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {logins.map((log: any, i: number) => (
                          <tr key={log.id || i} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                            <td className="px-4 py-3 text-gray-400 whitespace-nowrap">{fmtDate(log.created_at)}</td>
                            <td className="px-4 py-3 text-white font-medium">{log.email || '—'}</td>
                            <td className="px-4 py-3 text-gray-500 font-mono text-[10px]">{log.ip_address || '—'}</td>
                            <td className="px-4 py-3 text-gray-400">{log.country_code || '—'}</td>
                            <td className="px-4 py-3">
                              {log.platform ? (
                                <span className="px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 text-blue-300 text-[10px] font-semibold uppercase tracking-wider">
                                  {log.platform}
                                </span>
                              ) : (
                                <span className="text-gray-600 text-[10px]">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-gray-500 font-mono text-[10px] max-w-[120px] truncate">{log.device_id?.slice(0, 10) || '—'}</td>
                            <td className="px-4 py-3">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${log.success ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                                {log.success ? 'OK' : 'FAIL'}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-gray-500 text-[10px]">{log.error_reason || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {logins.length === 0 && (
                    <div className="text-center py-12 text-gray-600 text-sm">No login activity yet</div>
                  )}
                </div>
              </div>
            )}

            {/* ── AUDIT TAB ── */}
            {adminTab === 'audit' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <h1 className="text-2xl font-bold mb-1">Audit Log</h1>
                    <p className="text-gray-500 text-sm">
                      Every admin mutation, timestamped. Append-only (enforced by DB triggers). Showing {auditLog.length.toLocaleString()} entries.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={loadAudit} disabled={auditLoading} className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-gray-300 hover:bg-white/[0.08] border border-white/[0.08] flex items-center gap-1.5 transition-all disabled:opacity-50">
                      <RefreshCw size={11} className={auditLoading ? 'animate-spin' : ''} /> Refresh
                    </button>
                    <button onClick={exportAuditCsv} className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-gray-300 hover:bg-white/[0.08] border border-white/[0.08] flex items-center gap-1.5 transition-all">
                      <FileDown size={11} /> Export CSV
                    </button>
                  </div>
                </div>

                {/* Filters */}
                <div className="p-3 rounded-xl border border-white/[0.06] bg-white/[0.02] flex flex-wrap items-center gap-2">
                  <Filter size={12} className="text-gray-500" />
                  <select value={auditFilters.admin} onChange={e => setAuditFilters(f => ({ ...f, admin: e.target.value }))} className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none">
                    <option value="">All admins</option>
                    {auditFacets.admins.map(a => <option key={a} value={a}>{a}</option>)}
                  </select>
                  <select value={auditFilters.action} onChange={e => setAuditFilters(f => ({ ...f, action: e.target.value }))} className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none">
                    <option value="">All actions</option>
                    {auditFacets.actions.map(a => <option key={a} value={a}>{a}</option>)}
                  </select>
                  <input
                    value={auditFilters.target}
                    onChange={e => setAuditFilters(f => ({ ...f, target: e.target.value }))}
                    placeholder="Target email contains…"
                    className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none focus:border-blue-500/50 w-52"
                  />
                  <input
                    type="date"
                    value={auditFilters.from}
                    onChange={e => setAuditFilters(f => ({ ...f, from: e.target.value }))}
                    className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none"
                  />
                  <span className="text-gray-500 text-xs">→</span>
                  <input
                    type="date"
                    value={auditFilters.to}
                    onChange={e => setAuditFilters(f => ({ ...f, to: e.target.value }))}
                    className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none"
                  />
                  <button onClick={loadAudit} disabled={auditLoading} className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 border border-blue-500/30 transition-all disabled:opacity-50">
                    Apply
                  </button>
                  {(auditFilters.admin || auditFilters.action || auditFilters.target || auditFilters.from || auditFilters.to) && (
                    <button onClick={() => { setAuditFilters({ admin: '', action: '', target: '', from: '', to: '' }); setTimeout(loadAudit, 0); }} className="px-2 py-1 rounded text-[10px] text-gray-400 hover:text-white hover:bg-white/[0.04] transition-all">
                      Clear
                    </button>
                  )}
                </div>

                <div className="border border-white/[0.06] rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Time</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Admin</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Action</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Target</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {auditLog.map((row: any, i: number) => {
                          const rowKey = row.id ?? i;
                          // Pretty-print so the expanded view is human-readable. Keep the
                          // single-line variant for the collapsed cell.
                          let detailsCompact = '';
                          let detailsPretty = '';
                          if (row.details_json) {
                            try {
                              const parsed = JSON.parse(row.details_json);
                              detailsCompact = JSON.stringify(parsed);
                              detailsPretty = JSON.stringify(parsed, null, 2);
                            } catch {
                              detailsCompact = row.details_json;
                              detailsPretty = row.details_json;
                            }
                          }
                          const expanded = expandedAuditIds.has(rowKey);
                          const hasDetails = detailsCompact.length > 0;
                          const actionColor =
                            row.action === 'ban' ? 'bg-red-500/20 text-red-400' :
                            row.action === 'unban' ? 'bg-emerald-500/20 text-emerald-400' :
                            row.action === 'change-tier' ? 'bg-indigo-500/20 text-indigo-400' :
                            row.action === 'grant-credits' ? 'bg-cyan-500/20 text-cyan-400' :
                            row.action === 'extend-expiry' ? 'bg-blue-500/20 text-blue-400' :
                            row.action === 'reset-devices' ? 'bg-amber-500/20 text-amber-400' :
                            row.action === 'force-logout' ? 'bg-orange-500/20 text-orange-400' :
                            row.action === 'refund-payment' ? 'bg-pink-500/20 text-pink-400' :
                            row.action === 'delete-user' ? 'bg-red-500/20 text-red-400' :
                            row.action === 'impersonate' ? 'bg-yellow-500/20 text-yellow-400' :
                            row.action === 'grant-comp' ? 'bg-emerald-500/20 text-emerald-400' :
                            row.action === 'dsar-export' ? 'bg-cyan-500/20 text-cyan-400' :
                            row.action === 'reauth-success' || row.action === 'reauth-failed' ? 'bg-purple-500/20 text-purple-400' :
                            'bg-white/[0.06] text-gray-400';
                          const toggle = () => {
                            if (!hasDetails) return;
                            setExpandedAuditIds(prev => {
                              const next = new Set(prev);
                              if (next.has(rowKey)) next.delete(rowKey);
                              else next.add(rowKey);
                              return next;
                            });
                          };
                          return (
                            <React.Fragment key={rowKey}>
                              <tr className={`border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors ${hasDetails ? 'cursor-pointer' : ''}`} onClick={toggle}>
                                <td className="px-4 py-3 text-gray-400 whitespace-nowrap">{fmtDate(row.created_at)}</td>
                                <td className="px-4 py-3 text-white font-medium">{row.admin_email}</td>
                                <td className="px-4 py-3">
                                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${actionColor}`}>{row.action}</span>
                                </td>
                                <td className="px-4 py-3 text-gray-300">{row.target_email || '—'}</td>
                                <td className="px-4 py-3 text-gray-500 font-mono text-[10px]">
                                  <div className="flex items-center gap-2">
                                    {hasDetails && (
                                      <button onClick={e => { e.stopPropagation(); toggle(); }} className="shrink-0 text-gray-500 hover:text-white transition-colors" aria-label={expanded ? 'Collapse' : 'Expand'}>
                                        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                                      </button>
                                    )}
                                    <span className={`truncate max-w-[380px] ${!hasDetails ? 'text-gray-600' : ''}`} title={detailsCompact}>{detailsCompact || '—'}</span>
                                  </div>
                                </td>
                              </tr>
                              {expanded && hasDetails && (
                                <tr className="border-b border-white/[0.03] bg-black/40">
                                  <td colSpan={5} className="px-6 py-3">
                                    <div className="flex items-start justify-between gap-3 mb-2">
                                      <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Details payload</span>
                                      <button
                                        onClick={async (e) => {
                                          e.stopPropagation();
                                          try { await navigator.clipboard.writeText(detailsPretty); showMsg('Details copied'); }
                                          catch { showMsg('Copy failed', 'error'); }
                                        }}
                                        className="text-[10px] text-gray-400 hover:text-white flex items-center gap-1 transition-colors"
                                      >
                                        <Copy size={10} /> Copy JSON
                                      </button>
                                    </div>
                                    <pre className="text-[10px] font-mono text-gray-300 whitespace-pre-wrap break-all bg-white/[0.02] border border-white/[0.06] rounded-lg p-3 max-h-72 overflow-y-auto">{detailsPretty}</pre>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {auditLog.length === 0 && (
                    <div className="text-center py-12 text-gray-600 text-sm">No audit entries match your filters</div>
                  )}
                </div>
              </div>
            )}

            {/* ── CONVERSATIONS TAB ── */}
            {/* Cross-user recent-activity feed. Clicking a row jumps to
                Overview → searches that user, which auto-expands the thread
                via ConversationsViewer (with full messages). This is the
                support-triage entry point. */}
            {adminTab === 'conversations' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <h1 className="text-2xl font-bold mb-1">Conversations</h1>
                    <p className="text-gray-500 text-sm">
                      Latest activity across every user. Click a row to open the full thread.
                      {recentConvs.length > 0 && ` Showing ${recentConvs.length}.`}
                    </p>
                  </div>
                  <button onClick={loadRecentConversations} disabled={recentConvsLoading} className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-gray-300 hover:bg-white/[0.08] border border-white/[0.08] flex items-center gap-1.5 transition-all disabled:opacity-50">
                    <RefreshCw size={11} className={recentConvsLoading ? 'animate-spin' : ''} /> Refresh
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex-1 relative">
                    <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
                    <input
                      value={recentConvsQuery}
                      onChange={e => setRecentConvsQuery(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') loadRecentConversations(); }}
                      placeholder="Filter by email or conversation name…"
                      className="w-full pl-8 pr-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none focus:border-blue-500/50"
                    />
                  </div>
                  <button onClick={loadRecentConversations} disabled={recentConvsLoading} className="px-3 py-2 rounded-lg text-[11px] font-semibold bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 border border-blue-500/30 transition-all disabled:opacity-50">
                    Apply
                  </button>
                  {recentConvsQuery && (
                    <button onClick={() => { setRecentConvsQuery(''); setTimeout(loadRecentConversations, 0); }} className="px-2 py-1 rounded text-[10px] text-gray-400 hover:text-white hover:bg-white/[0.04] transition-all">
                      Clear
                    </button>
                  )}
                </div>

                <div className="border border-white/[0.06] rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">User</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Conversation</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Msgs</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Last activity</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Last message</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recentConvs.map((row: any) => (
                          <tr
                            key={row.conv_id}
                            onClick={() => row.user_email && openUserInPanel(row.user_email)}
                            className="border-b border-white/[0.03] hover:bg-white/[0.03] cursor-pointer transition-colors"
                            title="Open this user's full thread"
                          >
                            <td className="px-4 py-3 align-top">
                              <div className="flex flex-col gap-0.5 min-w-[180px]">
                                <span className="text-white font-medium truncate">{row.user_email || '—'}</span>
                                <span className="text-[10px] text-gray-500 flex items-center gap-1.5">
                                  <span className="uppercase tracking-wider">{row.user_tier || 'free'}</span>
                                  {row.user_is_banned ? <span className="text-red-400 font-semibold">· banned</span> : null}
                                </span>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-gray-200 align-top">
                              <div className="flex items-center gap-2 max-w-[260px]">
                                <MessageCircle size={11} className="text-blue-400 shrink-0" />
                                <span className="truncate" title={row.conv_name}>{row.conv_name || '(untitled)'}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3 align-top">
                              <span className="inline-flex items-center justify-center min-w-[24px] px-1.5 py-0.5 rounded bg-white/[0.04] border border-white/[0.08] text-[10px] text-gray-300 font-mono">
                                {row.message_count ?? 0}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-gray-400 whitespace-nowrap align-top">{fmtDate(row.updated_at)}</td>
                            <td className="px-4 py-3 text-gray-400 max-w-[420px] align-top">
                              {row.last_preview ? (
                                <div className="flex items-start gap-2">
                                  <span className={`text-[9px] uppercase tracking-wider font-semibold shrink-0 mt-0.5 ${row.last_role === 'user' ? 'text-blue-400' : 'text-purple-400'}`}>
                                    {row.last_role || '—'}
                                  </span>
                                  <span className="truncate" title={row.last_preview}>{row.last_preview}</span>
                                </div>
                              ) : <span className="text-gray-600 italic">(no messages yet)</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {recentConvs.length === 0 && (
                    <div className="text-center py-12 text-gray-600 text-sm">
                      {recentConvsLoading ? 'Loading…' : 'No conversations match your filter'}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── PAYMENTS TAB ── */}
            {adminTab === 'payments' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <h1 className="text-2xl font-bold mb-1">Payments</h1>
                    <p className="text-gray-500 text-sm">
                      {paymentStats ? `${(paymentStats.count ?? 0).toLocaleString()} rows · gross ${(paymentStats.gross / 100).toFixed(2)} · refunded/disputed ${(paymentStats.refunded_or_disputed / 100).toFixed(2)}` : 'Filter, inspect, refund.'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={loadPayments} disabled={paymentsLoading} className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-gray-300 hover:bg-white/[0.08] border border-white/[0.08] flex items-center gap-1.5 transition-all disabled:opacity-50">
                      <RefreshCw size={11} className={paymentsLoading ? 'animate-spin' : ''} /> Refresh
                    </button>
                    <button onClick={exportPaymentsCsv} className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-gray-300 hover:bg-white/[0.08] border border-white/[0.08] flex items-center gap-1.5 transition-all">
                      <FileDown size={11} /> Export CSV
                    </button>
                  </div>
                </div>

                {/* Filters */}
                <div className="p-3 rounded-xl border border-white/[0.06] bg-white/[0.02] flex flex-wrap items-center gap-2">
                  <Filter size={12} className="text-gray-500" />
                  <select value={paymentFilters.provider} onChange={e => setPaymentFilters(f => ({ ...f, provider: e.target.value }))} className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none">
                    <option value="">All providers</option>
                    <option value="stripe">Stripe</option>
                    <option value="razorpay">Razorpay</option>
                    <option value="admin-comp">Admin Comp</option>
                  </select>
                  <select value={paymentFilters.status} onChange={e => setPaymentFilters(f => ({ ...f, status: e.target.value }))} className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none">
                    <option value="">All statuses</option>
                    <option value="completed">Completed</option>
                    <option value="refunded">Refunded</option>
                    <option value="disputed">Disputed</option>
                    <option value="cancelled">Cancelled</option>
                    <option value="pending">Pending</option>
                    <option value="failed">Failed</option>
                  </select>
                  <select value={paymentFilters.tier} onChange={e => setPaymentFilters(f => ({ ...f, tier: e.target.value }))} className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none">
                    <option value="">All tiers</option>
                    {TIERS.map(t => <option key={t} value={t}>{t.toUpperCase()}</option>)}
                  </select>
                  <input
                    value={paymentFilters.email}
                    onChange={e => setPaymentFilters(f => ({ ...f, email: e.target.value }))}
                    placeholder="Email contains…"
                    className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none focus:border-blue-500/50 w-48"
                  />
                  <input type="date" value={paymentFilters.from} onChange={e => setPaymentFilters(f => ({ ...f, from: e.target.value }))} className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none" />
                  <span className="text-gray-500 text-xs">→</span>
                  <input type="date" value={paymentFilters.to} onChange={e => setPaymentFilters(f => ({ ...f, to: e.target.value }))} className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none" />
                  <button onClick={loadPayments} disabled={paymentsLoading} className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 border border-blue-500/30 transition-all disabled:opacity-50">
                    Apply
                  </button>
                  {(paymentFilters.provider || paymentFilters.status || paymentFilters.email || paymentFilters.tier || paymentFilters.from || paymentFilters.to) && (
                    <button onClick={() => { setPaymentFilters({ provider: '', status: '', email: '', tier: '', from: '', to: '' }); setTimeout(loadPayments, 0); }} className="px-2 py-1 rounded text-[10px] text-gray-400 hover:text-white hover:bg-white/[0.04] transition-all">
                      Clear
                    </button>
                  )}
                </div>

                <div className="border border-white/[0.06] rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">When</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Email</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Provider</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Amount</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Status</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Tier</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Provider ID</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {payments.map(p => {
                          const statusColor =
                            p.status === 'completed' ? 'text-emerald-400' :
                            p.status === 'refunded' ? 'text-pink-400' :
                            p.status === 'disputed' ? 'text-red-400' :
                            p.status === 'cancelled' ? 'text-gray-500' :
                            p.status === 'pending' ? 'text-amber-400' :
                            p.status === 'failed' ? 'text-red-400' :
                            'text-gray-400';
                          const canRefund = p.status === 'completed' && p.amount > 0 && p.provider !== 'admin-comp';
                          return (
                            <tr key={p.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                              <td className="px-4 py-3 text-gray-400 whitespace-nowrap">{fmtDate(p.created_at)}</td>
                              <td className="px-4 py-3 text-white font-medium">
                                <button onClick={() => openUserInPanel(p.email)} className="hover:text-blue-300 transition-colors">{p.email}</button>
                              </td>
                              <td className="px-4 py-3 text-gray-400">
                                <span className="px-1.5 py-0.5 rounded bg-white/[0.04] border border-white/[0.08] text-[10px] font-semibold uppercase tracking-wider">{p.provider}</span>
                              </td>
                              <td className={`px-4 py-3 font-mono whitespace-nowrap ${p.amount < 0 ? 'text-pink-400' : 'text-white'}`}>{fmtAmount(p.amount, p.currency)}</td>
                              <td className={`px-4 py-3 font-bold uppercase text-[10px] ${statusColor}`}>{p.status}</td>
                              <td className="px-4 py-3"><TierBadge tier={p.tier_granted} /></td>
                              <td className="px-4 py-3 text-gray-500 font-mono text-[10px] truncate max-w-[220px]" title={p.provider_payment_id}>{p.provider_payment_id || '—'}</td>
                              <td className="px-4 py-3">
                                {canRefund ? (
                                  <button onClick={() => handleRefund(p)} className="px-2 py-1 rounded text-[10px] font-semibold bg-pink-500/10 text-pink-300 hover:bg-pink-500/20 border border-pink-500/20 transition-all flex items-center gap-1">
                                    <RefreshCw size={10} /> Refund
                                  </button>
                                ) : (
                                  <span className="text-gray-600 text-[10px]">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {payments.length === 0 && !paymentsLoading && (
                    <div className="text-center py-12 text-gray-600 text-sm">No payments match your filters</div>
                  )}
                  {paymentsLoading && (
                    <div className="text-center py-12 text-gray-600 text-sm flex items-center justify-center gap-2">
                      <Loader2 size={14} className="animate-spin" /> Loading payments…
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── REVOKED KEYS TAB ── */}
            {adminTab === 'revoked' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <h1 className="text-2xl font-bold mb-1">Revoked Licenses</h1>
                    <p className="text-gray-500 text-sm">{revokedKeys.length} revoked keys on file.</p>
                  </div>
                  <button onClick={loadRevoked} className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-gray-300 hover:bg-white/[0.08] border border-white/[0.08] flex items-center gap-1.5 transition-all">
                    <RefreshCw size={11} /> Refresh
                  </button>
                </div>

                <div className="border border-white/[0.06] rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Key</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Revoked by</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Reason</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">When</th>
                        </tr>
                      </thead>
                      <tbody>
                        {revokedKeys.map((row, i) => (
                          <tr key={row.key || i} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                            <td className="px-4 py-3 text-white font-mono text-[11px]">{row.key}</td>
                            <td className="px-4 py-3 text-gray-400">{row.revoked_by || '—'}</td>
                            <td className="px-4 py-3 text-gray-500">{row.reason || '—'}</td>
                            <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(row.revoked_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {revokedKeys.length === 0 && (
                    <div className="text-center py-12 text-gray-600 text-sm">No revoked keys</div>
                  )}
                </div>
              </div>
            )}

            {/* ── ANALYTICS TAB ── */}
            {adminTab === 'analytics' && (
              <div className="space-y-8">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <h1 className="text-2xl font-bold mb-1">Analytics</h1>
                    <p className="text-gray-500 text-sm">MRR · churn · engagement · trends · top customers · risk</p>
                  </div>
                  <button onClick={loadAnalytics} disabled={analyticsLoading} className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-gray-300 hover:bg-white/[0.08] border border-white/[0.08] flex items-center gap-1.5 transition-all disabled:opacity-50">
                    <RefreshCw size={11} className={analyticsLoading ? 'animate-spin' : ''} /> Refresh
                  </button>
                </div>

                {/* Enterprise metrics — MRR, ARPU, churn, engagement */}
                <div>
                  <h2 className="text-xs text-gray-500 uppercase tracking-widest font-semibold mb-3">Recurring Revenue</h2>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {Object.entries(stats?.mrr_by_currency || {}).map(([cur, mrr]: any) => (
                      <div key={cur} className="p-4 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04]">
                        <p className="text-[10px] text-emerald-400 uppercase tracking-wider font-semibold mb-1">MRR · {cur}</p>
                        <p className="text-2xl font-bold text-white tracking-tight">{fmtAmount(mrr, cur)}</p>
                        <p className="text-[10px] text-gray-500 mt-1">ARR: {fmtAmount((mrr as number) * 12, cur)}</p>
                      </div>
                    ))}
                    {Object.entries(stats?.arpu_by_currency || {}).map(([cur, arpu]: any) => (
                      <div key={`arpu-${cur}`} className="p-4 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.04]">
                        <p className="text-[10px] text-cyan-400 uppercase tracking-wider font-semibold mb-1">ARPU · {cur}</p>
                        <p className="text-2xl font-bold text-white tracking-tight">{fmtAmount(arpu, cur)}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <h2 className="text-xs text-gray-500 uppercase tracking-widest font-semibold mb-3">Engagement &amp; Churn</h2>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    <div className="p-4 rounded-xl border border-white/[0.06] bg-white/[0.02]">
                      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">DAU</p>
                      <p className="text-2xl font-bold text-cyan-400 tracking-tight">{(stats?.dau ?? 0).toLocaleString()}</p>
                    </div>
                    <div className="p-4 rounded-xl border border-white/[0.06] bg-white/[0.02]">
                      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">WAU</p>
                      <p className="text-2xl font-bold text-blue-400 tracking-tight">{(stats?.wau ?? 0).toLocaleString()}</p>
                    </div>
                    <div className="p-4 rounded-xl border border-white/[0.06] bg-white/[0.02]">
                      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">MAU</p>
                      <p className="text-2xl font-bold text-indigo-400 tracking-tight">{(stats?.mau ?? 0).toLocaleString()}</p>
                    </div>
                    <div className="p-4 rounded-xl border border-white/[0.06] bg-white/[0.02]">
                      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">DAU/MAU</p>
                      <p className="text-2xl font-bold text-purple-400 tracking-tight">{stats?.dau_mau_ratio != null ? `${(stats.dau_mau_ratio * 100).toFixed(1)}%` : '—'}</p>
                      <p className="text-[10px] text-gray-500 mt-0.5">stickiness</p>
                    </div>
                    <div className="p-4 rounded-xl border border-red-500/20 bg-red-500/[0.04]">
                      <p className="text-[10px] text-red-400 uppercase tracking-wider mb-1">30d Churn</p>
                      <p className="text-2xl font-bold text-red-400 tracking-tight">{stats?.churn_rate_30d != null ? `${(stats.churn_rate_30d * 100).toFixed(1)}%` : '—'}</p>
                    </div>
                  </div>
                </div>

                {/* Daily trends — SVG sparklines first (visual signal), then text table (precision). */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-xs text-gray-500 uppercase tracking-widest font-semibold">30-Day Trends</h2>
                    <p className="text-[10px] text-gray-600">Signups · Logins · Revenue (USD only in chart — multi-currency totals below)</p>
                  </div>
                  {trends.length >= 2 && (
                    <TrendsSparklines trends={trends} />
                  )}
                  <div className="border border-white/[0.06] rounded-xl overflow-hidden">
                    <div className="overflow-x-auto max-h-[420px]">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-[#0b0b0f]">
                          <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                            <th className="text-left px-4 py-3 text-gray-500 font-medium">Date</th>
                            <th className="text-right px-4 py-3 text-gray-500 font-medium">Signups</th>
                            <th className="text-right px-4 py-3 text-gray-500 font-medium">Logins</th>
                            <th className="text-right px-4 py-3 text-gray-500 font-medium">USD Revenue</th>
                            <th className="text-right px-4 py-3 text-gray-500 font-medium">INR Revenue</th>
                          </tr>
                        </thead>
                        <tbody>
                          {trends.map((day: any) => (
                            <tr key={day.date} className="border-b border-white/[0.03]">
                              <td className="px-4 py-2 text-gray-400 whitespace-nowrap">{day.date}</td>
                              <td className="px-4 py-2 text-right text-purple-300 font-semibold">{(day.signups ?? 0).toLocaleString()}</td>
                              <td className="px-4 py-2 text-right text-cyan-300 font-semibold">{(day.logins ?? 0).toLocaleString()}</td>
                              <td className="px-4 py-2 text-right text-emerald-300 font-semibold">{day.revenue_by_currency?.USD ? fmtAmount(day.revenue_by_currency.USD, 'USD') : '—'}</td>
                              <td className="px-4 py-2 text-right text-emerald-300 font-semibold">{day.revenue_by_currency?.INR ? fmtAmount(day.revenue_by_currency.INR, 'INR') : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {trends.length === 0 && !analyticsLoading && (
                      <div className="text-center py-10 text-gray-600 text-sm">No trend data yet</div>
                    )}
                  </div>
                </div>

                {/* Top customers */}
                <div>
                  <h2 className="text-xs text-gray-500 uppercase tracking-widest font-semibold mb-3">Top Customers (all-time revenue)</h2>
                  <div className="border border-white/[0.06] rounded-xl overflow-hidden">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">#</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Email</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Tier</th>
                          <th className="text-right px-4 py-3 text-gray-500 font-medium">Total Paid</th>
                          <th className="text-right px-4 py-3 text-gray-500 font-medium">Payments</th>
                        </tr>
                      </thead>
                      <tbody>
                        {topCustomers.map((c: any, i: number) => (
                          <tr key={c.email + i} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                            <td className="px-4 py-3 text-gray-500">{i + 1}</td>
                            <td className="px-4 py-3 text-white font-medium">
                              <button onClick={() => openUserInPanel(c.email)} className="hover:text-blue-300 transition-colors">{c.email}</button>
                            </td>
                            <td className="px-4 py-3"><TierBadge tier={c.tier} /></td>
                            <td className="px-4 py-3 text-right text-emerald-400 font-semibold font-mono">{fmtAmount(c.total_amount, c.currency)}</td>
                            <td className="px-4 py-3 text-right text-gray-400">{c.payment_count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {topCustomers.length === 0 && !analyticsLoading && (
                      <div className="text-center py-10 text-gray-600 text-sm">No paying customers yet</div>
                    )}
                  </div>
                </div>

                {/* Suspicious activity */}
                {suspicious && (suspicious.multi_country_users.length > 0 || suspicious.high_fail_ips.length > 0) && (
                  <div>
                    <h2 className="text-xs text-red-400 uppercase tracking-widest font-semibold mb-3">Suspicious Activity</h2>
                    <div className="grid md:grid-cols-2 gap-4">
                      <div className="p-4 rounded-xl border border-red-500/20 bg-red-500/[0.04]">
                        <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-2"><Globe size={14} className="text-red-400" /> Multi-country logins (7d)</h3>
                        {suspicious.multi_country_users.length === 0 ? (
                          <p className="text-gray-500 text-xs">None</p>
                        ) : (
                          <div className="space-y-1 max-h-48 overflow-y-auto">
                            {suspicious.multi_country_users.map((u: any, i: number) => (
                              <div key={i} className="flex items-center justify-between text-[11px] py-1">
                                <button onClick={() => openUserInPanel(u.email)} className="text-white font-medium hover:text-blue-300 truncate">{u.email}</button>
                                <span className="text-red-300 font-mono">{u.country_count} countries</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="p-4 rounded-xl border border-orange-500/20 bg-orange-500/[0.04]">
                        <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-2"><Shield size={14} className="text-orange-400" /> High-fail-login IPs (24h)</h3>
                        {suspicious.high_fail_ips.length === 0 ? (
                          <p className="text-gray-500 text-xs">None</p>
                        ) : (
                          <div className="space-y-1 max-h-48 overflow-y-auto">
                            {suspicious.high_fail_ips.map((x: any, i: number) => (
                              <div key={i} className="flex items-center justify-between text-[11px] py-1">
                                <span className="text-white font-mono">{x.ip_address}</span>
                                <span className="text-orange-300 font-mono">{x.fail_count} fails</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── SETTINGS TAB ── */}
            {adminTab === 'settings' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <h1 className="text-2xl font-bold mb-1">Runtime Configuration</h1>
                    <p className="text-gray-500 text-sm">Admin-editable knobs. Changes apply immediately. Requires step-up password.</p>
                  </div>
                  <button onClick={loadConfig} disabled={configLoading} className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-gray-300 hover:bg-white/[0.08] border border-white/[0.08] flex items-center gap-1.5 transition-all disabled:opacity-50">
                    <RefreshCw size={11} className={configLoading ? 'animate-spin' : ''} /> Refresh
                  </button>
                </div>

                <div className="border border-white/[0.06] rounded-xl overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                        <th className="text-left px-4 py-3 text-gray-500 font-medium">Key</th>
                        <th className="text-left px-4 py-3 text-gray-500 font-medium">Value</th>
                        <th className="text-left px-4 py-3 text-gray-500 font-medium">Last Updated</th>
                        <th className="text-left px-4 py-3 text-gray-500 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {configRows.map(row => {
                        const draft = configDraft[row.key] ?? row.value;
                        const dirty = draft !== row.value;
                        return (
                          <tr key={row.key} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                            <td className="px-4 py-3 text-white font-mono text-[11px]">{row.key}</td>
                            <td className="px-4 py-3">
                              <input
                                value={draft}
                                onChange={e => setConfigDraft(d => ({ ...d, [row.key]: e.target.value }))}
                                className="w-full px-2 py-1 rounded bg-white/[0.04] border border-white/[0.08] text-white text-[11px] focus:outline-none focus:border-blue-500/50 font-mono"
                              />
                            </td>
                            <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-[10px]">{fmtDate(row.updated_at)}</td>
                            <td className="px-4 py-3">
                              <button
                                disabled={!dirty || !!panelBusy}
                                onClick={async () => {
                                  const updated = await callMutation(`/api/v1/admin/config/${encodeURIComponent(row.key)}`, { value: draft }, `${row.key} updated`, { method: 'PUT' });
                                  if (updated) loadConfig();
                                }}
                                className="px-3 py-1 rounded text-[10px] font-semibold bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 border border-blue-500/30 disabled:opacity-40 transition-all"
                              >
                                Save
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {configRows.length === 0 && (
                    <div className="text-center py-12 text-gray-600 text-sm">
                      {configLoading ? 'Loading…' : 'No config keys set. Use /license/set-min-version or other admin endpoints to seed values.'}
                    </div>
                  )}
                </div>

                {/* Known-key reference. Each entry has a description + default,
                    so an admin coming here cold can tell which knobs exist
                    without reading source. Server still owns the truth — keys
                    not yet seeded show a "Seed default" button. */}
                <KnownConfigKeysHint
                  configRows={configRows}
                  onSeed={async (key, defaultValue) => {
                    const updated = await callMutation(`/api/v1/admin/config/${encodeURIComponent(key)}`, { value: defaultValue }, `${key} seeded`, { method: 'PUT' });
                    if (updated) loadConfig();
                  }}
                  busy={!!panelBusy}
                />
              </div>
            )}
          </>
        )}
      </div>

      {confirmDialog && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-dialog-title"
          onClick={() => setConfirmDialog(null)}
        >
          <div
            className="relative w-full max-w-md mx-4 rounded-2xl bg-[#0b0b0f] border border-white/[0.08] shadow-2xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className={`shrink-0 p-2 rounded-lg ${confirmDialog.danger ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-400'}`}>
                <AlertTriangle size={18} />
              </div>
              <div className="flex-1">
                <h3 id="confirm-dialog-title" className="text-base font-semibold text-white">{confirmDialog.title}</h3>
                <p className="mt-1.5 text-sm text-gray-400 leading-relaxed whitespace-pre-wrap break-all">{confirmDialog.body}</p>
              </div>
              <button
                onClick={() => setConfirmDialog(null)}
                aria-label="Cancel"
                className="shrink-0 p-1 rounded-md text-gray-500 hover:text-white hover:bg-white/[0.06] transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmDialog(null)}
                className="px-4 py-2 rounded-lg text-sm font-medium text-gray-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] transition-all"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const d = confirmDialog;
                  setConfirmDialog(null);
                  d.onConfirm();
                }}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                  confirmDialog.danger
                    ? 'bg-red-500/20 text-red-200 hover:bg-red-500/30 border border-red-500/30'
                    : 'bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 border border-amber-500/30'
                }`}
              >
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── STEP-UP REAUTH MODAL ── */}
      {reauthPrompt && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm" role="dialog" aria-modal="true">
          <div className="relative w-full max-w-md mx-4 rounded-2xl bg-[#0b0b0f] border border-purple-500/30 shadow-2xl p-6">
            <div className="flex items-start gap-3 mb-4">
              <div className="shrink-0 p-2 rounded-lg bg-purple-500/15 text-purple-300">
                <Shield size={18} />
              </div>
              <div className="flex-1">
                <h3 className="text-base font-semibold text-white">Confirm your password</h3>
                <p className="mt-1 text-sm text-gray-400">
                  This action requires step-up verification. Your session stays elevated for 15 minutes.
                </p>
              </div>
            </div>
            <input
              type="password"
              autoFocus
              value={reauthPrompt.password}
              onChange={e => setReauthPrompt(p => p ? { ...p, password: e.target.value, error: '' } : null)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter' && !reauthPrompt.busy) {
                  setReauthPrompt(p => p ? { ...p, busy: true } : null);
                  const ok = await submitReauth(reauthPrompt.password);
                  if (ok && reauthPrompt.pending) {
                    reauthPrompt.pending();
                    setReauthPrompt(null);
                  } else {
                    setReauthPrompt(p => p ? { ...p, busy: false, error: 'Invalid password' } : null);
                  }
                }
              }}
              placeholder={`Password for ${currentUser.email}`}
              className="w-full px-4 py-2.5 rounded-lg bg-white/[0.04] border border-white/[0.1] text-white text-sm focus:outline-none focus:border-purple-500/60"
            />
            {reauthPrompt.error && (
              <p className="mt-2 text-xs text-red-400">{reauthPrompt.error}</p>
            )}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => {
                  (window as any).__reauthReject?.();
                  setReauthPrompt(null);
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium text-gray-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] transition-all"
              >
                Cancel
              </button>
              <button
                disabled={!reauthPrompt.password || reauthPrompt.busy}
                onClick={async () => {
                  setReauthPrompt(p => p ? { ...p, busy: true } : null);
                  const ok = await submitReauth(reauthPrompt.password);
                  if (ok && reauthPrompt.pending) {
                    reauthPrompt.pending();
                    setReauthPrompt(null);
                  } else {
                    setReauthPrompt(p => p ? { ...p, busy: false, error: 'Invalid password' } : null);
                  }
                }}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-purple-500/20 text-purple-200 hover:bg-purple-500/30 border border-purple-500/30 disabled:opacity-40 transition-all flex items-center gap-2"
              >
                {reauthPrompt.busy && <Loader2 size={14} className="animate-spin" />}
                Verify
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── EDIT PROFILE MODAL ── */}
      {editProfileFor && (
        <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/70 backdrop-blur-sm" role="dialog" aria-modal="true" onClick={() => setEditProfileFor(null)}>
          <div className="relative w-full max-w-md mx-4 rounded-2xl bg-[#0b0b0f] border border-white/[0.08] shadow-2xl p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-white mb-1">Edit Profile</h3>
            <p className="text-xs text-gray-500 mb-4">{editProfileFor.email}</p>
            <label className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold block mb-1">Name</label>
            <input
              value={editProfileFor.name}
              onChange={e => setEditProfileFor(p => p ? { ...p, name: e.target.value } : null)}
              className="w-full px-3 py-2 mb-3 rounded-lg bg-white/[0.04] border border-white/[0.1] text-white text-sm focus:outline-none focus:border-blue-500/50"
            />
            <label className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold block mb-1">Country (ISO-2)</label>
            <input
              value={editProfileFor.country_code}
              onChange={e => setEditProfileFor(p => p ? { ...p, country_code: e.target.value.toUpperCase().slice(0, 2) } : null)}
              maxLength={2}
              placeholder="US"
              className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.1] text-white text-sm focus:outline-none focus:border-blue-500/50 uppercase font-mono"
            />
            {editProfileFor.country_code !== editProfileFor.original_country_code && editProfileFor.country_code.length === 2 && (
              // Country drives provider routing (Razorpay for IN, Stripe elsewhere) and pricing tables. Changing it here only updates the user record — it does NOT migrate active subscriptions, retroactively re-price past payments, or update what the user sees in their billing portal until their next renewal cycle.
              <div className="mt-2 p-2.5 rounded-lg bg-amber-500/[0.06] border border-amber-500/20 text-amber-200 text-[11px] flex items-start gap-2">
                <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                <div>
                  Changing <span className="font-mono font-semibold">{editProfileFor.original_country_code || '—'}</span> → <span className="font-mono font-semibold">{editProfileFor.country_code}</span> affects which payment provider (Stripe vs. Razorpay) and pricing region the user sees on their <strong>next</strong> checkout. It does not retroactively re-bill or migrate an active subscription.
                </div>
              </div>
            )}
            {editProfileFor.country_code.length === 1 && (
              <p className="mt-1 text-[10px] text-red-400">ISO-2 must be exactly 2 letters.</p>
            )}
            <div className="mt-5 flex items-center justify-end gap-2">
              <button onClick={() => setEditProfileFor(null)} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] transition-all">Cancel</button>
              <button
                onClick={submitEditProfile}
                disabled={editProfileFor.country_code.length === 1}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-blue-500/20 text-blue-200 hover:bg-blue-500/30 border border-blue-500/30 transition-all disabled:opacity-40"
              >Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ── GRANT COMP MODAL ── */}
      {compGrantFor && (() => {
        let localTier: Tier = 'pro';
        let localNote = '';
        return (
          <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/70 backdrop-blur-sm" role="dialog" aria-modal="true" onClick={() => setCompGrantFor(null)}>
            <div className="relative w-full max-w-md mx-4 rounded-2xl bg-[#0b0b0f] border border-emerald-500/20 shadow-2xl p-6" onClick={e => e.stopPropagation()}>
              <div className="flex items-start gap-3 mb-4">
                <div className="shrink-0 p-2 rounded-lg bg-emerald-500/15 text-emerald-400"><Gift size={18} /></div>
                <div>
                  <h3 className="text-base font-semibold text-white">Grant Comp Tier</h3>
                  <p className="text-xs text-gray-500">{compGrantFor.email} · $0 payment, excluded from revenue metrics</p>
                </div>
              </div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold block mb-1">Tier</label>
              <select
                defaultValue="pro"
                onChange={e => { localTier = e.target.value as Tier; }}
                className="w-full px-3 py-2 mb-3 rounded-lg bg-white/[0.04] border border-white/[0.1] text-white text-sm focus:outline-none focus:border-emerald-500/50"
              >
                <option value="basic">Basic</option>
                <option value="pro">Pro</option>
                <option value="max">Max</option>
              </select>
              <label className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold block mb-1">Reason / note (audit trail)</label>
              <textarea
                onChange={e => { localNote = e.target.value; }}
                placeholder="e.g. refund for outage; influencer comp; support make-good"
                rows={3}
                className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.1] text-white text-sm focus:outline-none focus:border-emerald-500/50 resize-none"
              />
              <div className="mt-5 flex items-center justify-end gap-2">
                <button onClick={() => setCompGrantFor(null)} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] transition-all">Cancel</button>
                <button onClick={() => submitGrantComp(localTier, localNote)} className="px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30 border border-emerald-500/30 transition-all">Grant</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── REFUND MODAL ──
          Uses React state (was using closure variables, which silently
          carried stale values across modal open/close cycles — admin could
          accidentally refund the wrong amount on a second refund attempt). */}
      {refundFor && (
        <RefundModal
          payment={refundFor.payment}
          fmtAmount={fmtAmount}
          onCancel={() => setRefundFor(null)}
          onSubmit={(amount, reason) => submitRefund(amount, reason)}
        />
      )}

      {/* ── BAN MODAL ──
          Captures a free-text reason that gets stamped on both the audit log
          and the license-revoke row, so support can later explain to the user
          why they're locked out. */}
      {banFor && (
        <BanModal
          email={banFor.email}
          onCancel={() => setBanFor(null)}
          onSubmit={(reason) => submitBan(banFor.email, reason)}
        />
      )}

      {/* ── IMPERSONATION TOKEN MODAL ──
          Token must be select-all-able so admin can paste it into a separate
          tool. Auto-copy on open is a convenience; manual copy is the fallback
          path when clipboard write throws (sandboxed renderer, focus loss). */}
      {impersonateToken && (
        <ImpersonationTokenModal
          email={impersonateToken.email}
          token={impersonateToken.token}
          onClose={() => setImpersonateToken(null)}
          onMessage={showMsg}
        />
      )}
    </div>
  );
};

// Ban modal — prompts for an audit-trail reason. Server stamps this on the
// audit row + the license-revoke row, so a support agent can later answer
// "why am I banned?" without having to dig through DB tables.
const BanModal = ({ email, onCancel, onSubmit }: { email: string; onCancel: () => void; onSubmit: (reason: string) => void }) => {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // Server accepts any string; we just gate Submit on non-empty so the audit
  // log isn't littered with blank-reason bans (which are useless to support).
  const ok = reason.trim().length > 0;
  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/70 backdrop-blur-sm" role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="relative w-full max-w-md mx-4 rounded-2xl bg-[#0b0b0f] border border-red-500/30 shadow-2xl p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-4">
          <div className="shrink-0 p-2 rounded-lg bg-red-500/15 text-red-400"><Ban size={18} /></div>
          <div>
            <h3 className="text-base font-semibold text-white">Ban {email}</h3>
            <p className="text-xs text-gray-500">Their license is revoked and active sessions are invalidated. Audit-logged.</p>
          </div>
        </div>
        <label className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold block mb-1">Reason (required — appears in audit log)</label>
        <textarea
          autoFocus
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="e.g. payment fraud confirmed by Stripe; abusive support behavior; chargeback recovery"
          rows={4}
          className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.1] text-white text-sm focus:outline-none focus:border-red-500/50 resize-none"
        />
        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={onCancel} disabled={busy} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] transition-all disabled:opacity-50">Cancel</button>
          <button
            disabled={!ok || busy}
            onClick={async () => { setBusy(true); try { await onSubmit(reason.trim()); } finally { setBusy(false); } }}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-red-500/20 text-red-200 hover:bg-red-500/30 border border-red-500/30 transition-all disabled:opacity-40 flex items-center gap-2"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            Ban user
          </button>
        </div>
      </div>
    </div>
  );
};

// Impersonation token modal — readonly text input + copy button. The token is
// long (JWT), so a confirm-dialog body would line-wrap it ugly and admins
// might not realize they need to scroll. Auto-copy on mount is a convenience;
// the input stays for manual-select fallback.
const ImpersonationTokenModal = ({ email, token, onClose, onMessage }: { email: string; token: string; onClose: () => void; onMessage: (msg: string, type?: 'success' | 'error') => void }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  // Auto-copy + select-all on open. clipboard.writeText can reject in
  // sandboxed contexts, so the manual-select path stays available regardless.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await navigator.clipboard.writeText(token);
        if (!cancelled) {
          setCopied(true);
          onMessage('Token copied — handle with care', 'success');
        }
      } catch {
        // Clipboard blocked — let the user select+copy manually.
        inputRef.current?.select();
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      onMessage('Token copied — handle with care', 'success');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      inputRef.current?.select();
      onMessage('Clipboard blocked — token is selected, press Ctrl+C', 'error');
    }
  };
  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/70 backdrop-blur-sm" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="relative w-full max-w-2xl mx-4 rounded-2xl bg-[#0b0b0f] border border-yellow-500/30 shadow-2xl p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-4">
          <div className="shrink-0 p-2 rounded-lg bg-yellow-500/15 text-yellow-400"><Key size={18} /></div>
          <div className="flex-1">
            <h3 className="text-base font-semibold text-white">Impersonation token for {email}</h3>
            <p className="text-xs text-gray-500 mt-0.5">Expires in 30 minutes. Every action under this token is audit-logged against you.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="shrink-0 p-1 rounded-md text-gray-500 hover:text-white hover:bg-white/[0.06] transition-colors"><X size={16} /></button>
        </div>
        <div className="p-3 rounded-lg bg-amber-500/[0.06] border border-amber-500/20 text-amber-200 text-[11px] mb-4 flex items-start gap-2">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <div><span className="font-semibold">Do not paste into your own admin tab.</span> Use a separate browser/profile so you don't lock yourself out.</div>
        </div>
        <label className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold block mb-1">JWT</label>
        <div className="flex items-stretch gap-2">
          <input
            ref={inputRef}
            readOnly
            value={token}
            onFocus={e => e.currentTarget.select()}
            className="flex-1 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.1] text-white text-[11px] font-mono focus:outline-none focus:border-yellow-500/50"
          />
          <button
            onClick={doCopy}
            className="px-4 rounded-lg text-xs font-semibold bg-yellow-500/20 text-yellow-200 hover:bg-yellow-500/30 border border-yellow-500/30 transition-all flex items-center gap-1.5 whitespace-nowrap"
          >
            {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
          </button>
        </div>
        <div className="mt-5 flex items-center justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] transition-all">Done</button>
        </div>
      </div>
    </div>
  );
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LANDING — MOBILE (iPhone-feel)
//
//  Same content + same routing actions as the desktop landing in
//  SubscriptionGateInner's view === 'landing' branch, but every interaction
//  is mobile-native:
//    • Slim translucent app-bar with safe-area-inset-top
//    • Hamburger → bottom sheet (drag-to-dismiss, springy slide)
//    • Hero CTAs stacked vertically in the thumb-zone
//    • Capabilities: 2-col app-icon grid with rise-in stagger as cards
//      enter the viewport (IntersectionObserver)
//    • How-it-works + Pricing: horizontal paged swipers with dot indicators
//    • Sticky bottom CTA past the hero — blurred translucent, iOS toolbar
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface LandingMobileProps {
  setView: (v: View) => void;
  geo: GeoData | null;
  pricing: RegionPricing | null;
  handleTierSelect: (tier: PricingTier) => Promise<void> | void;
  isSubmitting: boolean;
  currentUser: UserProfile | null;
  setAuthError: (err: string | null) => void;
}

// Static content. Lifted out of the component so the [data-rise]
// IntersectionObserver doesn't re-run when an unrelated state update
// re-renders the parent.
const MOBILE_CAPABILITIES = [
  { Icon: PhHeadphones, title: 'Hears the interviewer', body: 'System-audio capture transcribes every question with sub-second latency.' },
  { Icon: PhCpu,        title: 'Reasons in your voice', body: 'Picks the right model and shapes the answer to your résumé and the role.' },
  { Icon: PhShield,     title: 'Invisible on the call', body: 'Window content is excluded from screen-share at the OS level.' },
  { Icon: PhMonitor,    title: 'Reads the screen',      body: 'Auto-Solve captures the editor and types the answer on demand.' },
  { Icon: PhChart,      title: 'Holds your context',    body: 'Resume, JD, notes stay in working memory across the whole interview.' },
  { Icon: PhBolt,       title: 'Pop-out + PiP',         body: 'A glanceable window that floats over Zoom, Meet, or Teams.' },
] as const;

const MOBILE_STEPS = [
  { n: '01', title: 'Install the desktop app',          body: 'Download for macOS, Windows, or Linux. Sign in once. Your license binds to this device.' },
  { n: '02', title: 'Drop in your résumé and the JD',   body: 'A single drag. The copilot extracts your story and the role in one preflight call.' },
  { n: '03', title: 'Open your interview',              body: 'Start the mic. Answers stream as the interviewer speaks. Glance at the popout, deliver in your voice.' },
] as const;

const MOBILE_TRUST = [
  { Icon: PhShield, label: 'Device-bound licenses',      body: 'A license activates on the device that bought it. No silent sharing.' },
  { Icon: PhLock,   label: 'Server-validated sessions',  body: 'Every active interview is checked against our backend in real time.' },
  { Icon: PhGlobe,  label: 'Regional pricing, enforced', body: 'No VPN-shopping for cheaper tiers. Your country, your fair price.' },
] as const;

const LandingMobile: React.FC<LandingMobileProps> = ({
  setView, geo, pricing, handleTierSelect, isSubmitting, currentUser, setAuthError,
}) => {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetClosing, setSheetClosing] = useState(false);
  const [showStickyCTA, setShowStickyCTA] = useState(false);
  const heroSentinelRef = useRef<HTMLDivElement>(null);

  const stepsScrollRef = useRef<HTMLDivElement>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const pricingScrollRef = useRef<HTMLDivElement>(null);
  const [pricingIdx, setPricingIdx] = useState(0);

  // Sheet drag-to-dismiss state. Refs rather than state because we mutate
  // every move event — re-rendering the entire mobile landing on every
  // pixel of finger travel would jank the drag.
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragStartYRef = useRef<number | null>(null);
  const dragOffsetRef = useRef<number>(0);

  // Sticky bottom CTA appears once the hero CTAs have scrolled past. Using
  // an IntersectionObserver with a small negative top margin so the sticky
  // CTA appears just before the hero CTAs leave the screen — feels like
  // "the CTA followed me down" rather than "a new bar appeared."
  useEffect(() => {
    const sentinel = heroSentinelRef.current;
    if (!sentinel) return;
    const io = new IntersectionObserver(
      ([entry]) => setShowStickyCTA(!entry.isIntersecting),
      { rootMargin: '-60px 0px 0px 0px' }
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, []);

  // Stagger entrance for [data-rise] elements as they enter the viewport.
  // Threshold 0.05 + small bottom margin so cards animate JUST before they
  // appear — feels organic, not "popcorn-on-scroll." We unobserve once
  // animated so a fast scroll-back-up doesn't replay the entrance.
  useEffect(() => {
    const cards = document.querySelectorAll('[data-rise]:not(.ios-rise-active)');
    if (cards.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach(e => {
          if (e.isIntersecting) {
            (e.target as HTMLElement).classList.add('ios-rise-active');
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.05 }
    );
    cards.forEach(c => io.observe(c));
    return () => io.disconnect();
  }, []);

  // Track the steps pager via raw scrollLeft. rAF-throttled so a fast
  // momentum scroll doesn't fire the state setter on every frame and
  // re-render the whole landing.
  useEffect(() => {
    const el = stepsScrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (el.clientWidth > 0) setStepIdx(Math.round(el.scrollLeft / el.clientWidth));
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Same pattern for the pricing pager. Re-runs when `pricing` changes
  // (initial load), since the pager DOM only exists once tiers are present.
  useEffect(() => {
    const el = pricingScrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (el.clientWidth > 0) setPricingIdx(Math.round(el.scrollLeft / el.clientWidth));
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [pricing]);

  // Two-stage close so the sheet can play its exit animation before the
  // node unmounts. 300ms matches .ios-sheet-exit's duration in index.html
  // (var(--dur-dismiss) = 380ms) minus a small head-start for the backdrop
  // fade — that mismatched timing is the iOS "world re-emerges first" detail.
  const closeSheet = useCallback(() => {
    if (sheetClosing) return;
    setSheetClosing(true);
    window.setTimeout(() => {
      setSheetOpen(false);
      setSheetClosing(false);
    }, 300);
  }, [sheetClosing]);

  // Lock body scroll while sheet is open. iOS specifically: position:fixed
  // on body without saving/restoring scrollY would jump the page back to
  // top on close — preserve via the inset hack. We deliberately use the
  // body element (not the scrolling container) because the landing is the
  // top-level fixed/inset-0 div; document.body still receives the touch
  // chain in browsers that haven't adopted overscroll-behavior fully.
  useEffect(() => {
    if (!sheetOpen) return;
    const y = window.scrollY;
    const prevPos = document.body.style.position;
    const prevTop = document.body.style.top;
    const prevWidth = document.body.style.width;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${y}px`;
    document.body.style.width = '100%';
    return () => {
      document.body.style.position = prevPos;
      document.body.style.top = prevTop;
      document.body.style.width = prevWidth;
      window.scrollTo(0, y);
    };
  }, [sheetOpen]);

  // Esc closes the sheet — mostly for desktop dev-tools testing of the
  // mobile layout, but harmless on phones (no Esc key in iOS keyboards).
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSheet(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheetOpen, closeSheet]);

  // Drag-to-dismiss the sheet. Y-axis only; clamp at 0 so an upward drag
  // doesn't pull the sheet above its rest position (feels stuck — iOS
  // does the same). 80px commit threshold matches iOS Maps / Apple Music.
  const onSheetTouchStart = (e: React.TouchEvent) => {
    if (sheetClosing) return;
    dragStartYRef.current = e.touches[0].clientY;
    dragOffsetRef.current = 0;
    if (sheetRef.current) sheetRef.current.style.transition = 'none';
  };
  const onSheetTouchMove = (e: React.TouchEvent) => {
    if (dragStartYRef.current === null) return;
    const dy = e.touches[0].clientY - dragStartYRef.current;
    dragOffsetRef.current = Math.max(0, dy);
    if (sheetRef.current) {
      sheetRef.current.style.transform = `translateY(${dragOffsetRef.current}px)`;
    }
  };
  const onSheetTouchEnd = () => {
    if (dragStartYRef.current === null) return;
    dragStartYRef.current = null;
    const offset = dragOffsetRef.current;
    dragOffsetRef.current = 0;
    if (!sheetRef.current) return;
    sheetRef.current.style.transition = 'transform 280ms var(--spring-summon)';
    if (offset > 80) {
      sheetRef.current.style.transform = 'translateY(100%)';
      window.setTimeout(() => {
        setSheetOpen(false);
        if (sheetRef.current) {
          sheetRef.current.style.transform = '';
          sheetRef.current.style.transition = '';
        }
      }, 280);
    } else {
      // Snap back via spring.
      sheetRef.current.style.transform = 'translateY(0)';
      window.setTimeout(() => {
        if (sheetRef.current) sheetRef.current.style.transition = '';
      }, 280);
    }
  };

  const scrollPagerTo = (ref: React.RefObject<HTMLDivElement | null>, idx: number) => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ left: idx * el.clientWidth, behavior: 'smooth' });
  };

  const handleSupport = () => {
    if (currentUser) setView('support');
    else { setAuthError('Please sign in to access support'); setView('login'); }
  };

  const dotStyle = (active: boolean): React.CSSProperties => ({
    width: active ? 22 : 6,
    height: 6,
    borderRadius: 999,
    background: active ? 'var(--ink)' : 'var(--cream-line)',
    transition: 'width 280ms var(--ease-ios), background 280ms var(--ease-ios)',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
  });

  return (
    <div
      className="fixed inset-0 overflow-y-auto"
      style={{
        background: 'var(--cream)',
        color: 'var(--ink)',
        fontFamily: 'var(--sans)',
        WebkitOverflowScrolling: 'touch' as any,
      }}
    >
      {/* ── App-bar — slim, safe-area-respectful, blurred translucent ── */}
      <header
        className="sticky top-0 z-30 backdrop-blur-md pt-safe"
        style={{
          background: 'color-mix(in oklab, var(--cream) 88%, transparent)',
          borderBottom: '1px solid var(--cream-line)',
        }}
      >
        <div className="flex items-center justify-between px-5" style={{ height: 56 }}>
          <Logo size="sm" theme="light" />
          <button
            onClick={() => setSheetOpen(true)}
            className="ios-press w-11 h-11 -mr-2 flex flex-col items-center justify-center gap-1.5"
            aria-label="Open menu"
            style={{ color: 'var(--ink)' }}
          >
            <span className="block w-5 h-[1.5px] rounded-full" style={{ background: 'currentColor' }} />
            <span className="block w-5 h-[1.5px] rounded-full" style={{ background: 'currentColor' }} />
          </button>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="px-5 pt-9 pb-10">
        <div className="inline-flex items-center gap-1.5 mb-7" style={{ color: 'var(--ink-muted)' }}>
          <PhSparkle size={12} weight="duotone" style={{ color: 'var(--accent)' }} />
          <span className="text-[11px] font-medium uppercase tracking-[0.18em]">
            Real-time interview intelligence
          </span>
        </div>
        <h1
          className="text-[40px] leading-[1.04] mb-6"
          style={{ fontFamily: 'var(--serif)', fontWeight: 400, letterSpacing: '-0.025em' }}
        >
          Walk into every interview <em style={{ fontStyle: 'italic', fontWeight: 400 }}>already prepared</em>.
        </h1>
        <p
          className="text-[16px] mb-8"
          style={{ color: 'var(--ink-soft)', lineHeight: 1.55, letterSpacing: '-0.005em' }}
        >
          A quiet copilot that listens to your interview, holds your résumé and the role in mind, and shapes an answer in your voice — character-by-character, in real time.
        </p>
        <div className="flex flex-col gap-2.5">
          <button
            onClick={() => setView('signup')}
            className="ios-press w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-[15px] font-medium"
            style={{ background: 'var(--ink)', color: 'var(--cream)', letterSpacing: '-0.005em' }}
          >
            Start free
            <PhArrowRight size={15} weight="bold" />
          </button>
          <button
            onClick={() => setView('tutorials')}
            className="ios-press w-full px-6 py-3.5 rounded-full text-[15px] font-medium"
            style={{ background: 'transparent', color: 'var(--ink)', border: '1px solid var(--cream-line)' }}
          >
            See how it works
          </button>
        </div>
        {/* Sentinel — sticky CTA appears once this scrolls past the top. */}
        <div ref={heroSentinelRef} aria-hidden className="h-px mt-8" />
        {/* Trust strip — horizontal scroll on extra-narrow screens so the
            three chips never wrap into vertical stack. */}
        <div
          className="flex items-center gap-5 pt-7 mt-3 text-[12.5px] font-medium overflow-x-auto"
          style={{
            borderTop: '1px solid var(--cream-line)',
            color: 'var(--ink-muted)',
            scrollbarWidth: 'none' as any,
          }}
        >
          <span className="flex items-center gap-1.5 shrink-0">
            <PhUsers size={14} weight="duotone" />10,000+ candidates
          </span>
          <span className="flex items-center gap-1.5 shrink-0">
            <PhStar size={14} weight="duotone" />4.9 / 5 rating
          </span>
          <span className="flex items-center gap-1.5 shrink-0">
            <PhGlobe size={14} weight="duotone" />50+ countries
          </span>
        </div>
      </section>

      {/* ── Capabilities — 2-col app-icon grid with rise-in stagger ── */}
      <section className="px-5 py-12" style={{ borderTop: '1px solid var(--cream-line)' }}>
        <span className="text-[11px] font-medium uppercase tracking-[0.18em]" style={{ color: 'var(--ink-muted)' }}>
          Capabilities
        </span>
        <h2
          className="text-[28px] leading-[1.1] mt-3 mb-7"
          style={{ fontFamily: 'var(--serif)', fontWeight: 400, letterSpacing: '-0.02em' }}
        >
          Built for the moment that decides the offer.
        </h2>
        <div className="grid grid-cols-2 gap-3">
          {MOBILE_CAPABILITIES.map((c, i) => {
            const Icon = c.Icon;
            return (
              <div
                key={c.title}
                data-rise
                style={{
                  animationDelay: `${i * 60}ms`,
                  background: 'var(--cream-soft)',
                  border: '1px solid var(--cream-line)',
                  minHeight: 160,
                }}
                className="ios-press rounded-3xl p-4"
              >
                <Icon size={24} weight="duotone" style={{ color: 'var(--accent)' }} />
                <h3
                  className="mt-3 text-[15px]"
                  style={{ fontFamily: 'var(--serif)', fontWeight: 500, letterSpacing: '-0.01em', color: 'var(--ink)' }}
                >
                  {c.title}
                </h3>
                <p className="mt-1.5 text-[12.5px]" style={{ color: 'var(--ink-soft)', lineHeight: 1.5 }}>
                  {c.body}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── How it works — paged swiper ── */}
      <section className="py-12" style={{ borderTop: '1px solid var(--cream-line)' }}>
        <div className="px-5">
          <span className="text-[11px] font-medium uppercase tracking-[0.18em]" style={{ color: 'var(--ink-muted)' }}>
            How it works
          </span>
          <h2
            className="text-[28px] leading-[1.1] mt-3 mb-6"
            style={{ fontFamily: 'var(--serif)', fontWeight: 400, letterSpacing: '-0.02em' }}
          >
            Three steps. Then you forget it's there.
          </h2>
        </div>
        <div ref={stepsScrollRef} className="ios-pager pb-1">
          {MOBILE_STEPS.map((s) => (
            <div
              key={s.n}
              className="ios-pager-item rounded-3xl p-7"
              style={{ background: 'var(--cream-soft)', border: '1px solid var(--cream-line)', minHeight: 240 }}
            >
              <div
                className="text-[13px] font-medium tabular-nums tracking-[0.06em] mb-5"
                style={{ color: 'var(--ink-muted)' }}
              >
                {s.n}
              </div>
              <h3
                className="text-[22px] leading-[1.15] mb-3"
                style={{ fontFamily: 'var(--serif)', fontWeight: 500, letterSpacing: '-0.015em' }}
              >
                {s.title}
              </h3>
              <p className="text-[14.5px]" style={{ color: 'var(--ink-soft)', lineHeight: 1.6 }}>
                {s.body}
              </p>
            </div>
          ))}
        </div>
        <div className="flex justify-center gap-1.5 mt-5">
          {MOBILE_STEPS.map((_, i) => (
            <button
              key={i}
              onClick={() => scrollPagerTo(stepsScrollRef, i)}
              aria-label={`Step ${i + 1}`}
              className="ios-press"
              style={dotStyle(i === stepIdx)}
            />
          ))}
        </div>
      </section>

      {/* ── Pricing — paged swiper ── */}
      <section id="pricing" className="py-12" style={{ borderTop: '1px solid var(--cream-line)' }}>
        <div className="px-5">
          <span className="text-[11px] font-medium uppercase tracking-[0.18em]" style={{ color: 'var(--ink-muted)' }}>
            Pricing
          </span>
          <h2
            className="text-[28px] leading-[1.1] mt-3 mb-3"
            style={{ fontFamily: 'var(--serif)', fontWeight: 400, letterSpacing: '-0.02em' }}
          >
            Pay for the interviews you take.
          </h2>
          {geo && (
            <p className="text-[13px] mb-6" style={{ color: 'var(--ink-muted)' }}>
              Pricing for {geo.country_name}. We adjust regionally so the offer is always fair.
            </p>
          )}
        </div>
        {pricing && (
          <>
            <div ref={pricingScrollRef} className="ios-pager pb-1">
              {pricing.tiers.map((tier) => (
                <div key={tier.id} className="ios-pager-item">
                  <PricingCard tier={tier} onSelect={handleTierSelect} isLoading={isSubmitting} />
                </div>
              ))}
            </div>
            <div className="flex justify-center gap-1.5 mt-5">
              {pricing.tiers.map((_, i) => (
                <button
                  key={i}
                  onClick={() => scrollPagerTo(pricingScrollRef, i)}
                  aria-label={`Tier ${i + 1}`}
                  className="ios-press"
                  style={dotStyle(i === pricingIdx)}
                />
              ))}
            </div>
          </>
        )}
      </section>

      {/* ── Trust ── */}
      <section className="px-5 py-12" style={{ borderTop: '1px solid var(--cream-line)' }}>
        <div>
          {MOBILE_TRUST.map(({ Icon, label, body }, i) => (
            <div
              key={label}
              className="flex items-start gap-4 pt-7 pb-7"
              style={i < MOBILE_TRUST.length - 1 ? { borderBottom: '1px solid var(--cream-line)' } : undefined}
            >
              <Icon size={22} weight="duotone" style={{ color: 'var(--ink)', flexShrink: 0, marginTop: 2 }} />
              <div>
                <h4
                  className="text-[15px] font-medium"
                  style={{ color: 'var(--ink)', letterSpacing: '-0.005em' }}
                >
                  {label}
                </h4>
                <p
                  className="mt-1 text-[13.5px]"
                  style={{ color: 'var(--ink-muted)', lineHeight: 1.55 }}
                >
                  {body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Closing CTA ── */}
      <section className="px-5 py-14 text-center" style={{ borderTop: '1px solid var(--cream-line)' }}>
        <h2
          className="text-[34px] leading-[1.08] mb-7"
          style={{ fontFamily: 'var(--serif)', fontWeight: 400, letterSpacing: '-0.02em' }}
        >
          Your next interview is on Tuesday.<br />
          <em style={{ fontStyle: 'italic' }}>Be ready by Monday.</em>
        </h2>
        <button
          onClick={() => setView('signup')}
          className="ios-press w-full inline-flex items-center justify-center gap-2 px-7 py-4 rounded-full text-[15px] font-medium"
          style={{ background: 'var(--ink)', color: 'var(--cream)' }}
        >
          Start free
          <PhArrowRight size={15} weight="bold" />
        </button>
        <p className="mt-5 text-[12.5px]" style={{ color: 'var(--ink-muted)' }}>
          No card. 30-minute trial. Upgrade only if it earned the offer.
        </p>
      </section>

      {/* ── Footer — minimal, centered, with sticky-CTA spacer at the bottom ── */}
      <footer
        className="px-5 py-9 flex flex-col items-center gap-4 text-[12.5px]"
        style={{ borderTop: '1px solid var(--cream-line)', color: 'var(--ink-muted)' }}
      >
        <Logo size="sm" theme="light" />
        <div className="flex items-center gap-3">
          <span>© {new Date().getFullYear()} minicaai</span>
          <span aria-hidden>·</span>
          <span>Privacy</span>
          <span aria-hidden>·</span>
          <span>Terms</span>
        </div>
        <button
          onClick={handleSupport}
          className="ios-press"
          style={{ color: 'var(--ink-muted)' }}
        >
          Support
        </button>
        {/* Spacer so the sticky bottom CTA never covers the last footer line. */}
        <div style={{ height: 96 }} />
      </footer>

      {/* ── Sticky bottom CTA — fades in once hero scrolled past, blurred ── */}
      <div
        aria-hidden={!showStickyCTA}
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 20,
          paddingBottom: 'max(env(safe-area-inset-bottom), 16px)',
          paddingTop: 12,
          paddingLeft: 20,
          paddingRight: 20,
          background: 'color-mix(in oklab, var(--cream) 85%, transparent)',
          backdropFilter: 'blur(14px)',
          WebkitBackdropFilter: 'blur(14px)',
          borderTop: '1px solid var(--cream-line)',
          opacity: showStickyCTA ? 1 : 0,
          pointerEvents: showStickyCTA ? 'auto' : 'none',
          transform: showStickyCTA ? 'translateY(0)' : 'translateY(12px)',
          transition: 'opacity 240ms var(--ease-ios), transform 280ms var(--spring-summon)',
        }}
      >
        <button
          onClick={() => setView('signup')}
          className="ios-press w-full inline-flex items-center justify-center gap-2 py-3.5 rounded-full text-[15px] font-medium"
          style={{ background: 'var(--ink)', color: 'var(--cream)' }}
        >
          Start free
          <PhArrowRight size={15} weight="bold" />
        </button>
      </div>

      {/* ── Sheet menu (mounted only when open; two-stage close before unmount) ── */}
      {sheetOpen && (
        <>
          <div
            className={sheetClosing ? 'ios-fade-exit' : 'ios-fade-enter'}
            onClick={closeSheet}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 40,
              background: 'rgba(20, 20, 19, 0.42)',
              backdropFilter: 'blur(2px)',
              WebkitBackdropFilter: 'blur(2px)',
            }}
          />
          <div
            ref={sheetRef}
            className={sheetClosing ? 'ios-sheet-exit' : 'ios-sheet-enter'}
            style={{
              position: 'fixed',
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 41,
              background: 'var(--cream)',
              borderTopLeftRadius: 22,
              borderTopRightRadius: 22,
              paddingBottom: 'max(env(safe-area-inset-bottom), 18px)',
              boxShadow: '0 -10px 40px rgba(20, 20, 19, 0.08)',
              borderTop: '1px solid var(--cream-line)',
            }}
            onTouchStart={onSheetTouchStart}
            onTouchMove={onSheetTouchMove}
            onTouchEnd={onSheetTouchEnd}
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-3 pb-2">
              <div style={{ width: 38, height: 5, borderRadius: 999, background: 'var(--cream-line)' }} />
            </div>
            <div className="px-2 pt-3 pb-4">
              <button
                onClick={() => { closeSheet(); setView('tutorials'); }}
                className="ios-press w-full text-left px-5 py-4 rounded-2xl text-[16px] font-medium"
                style={{ color: 'var(--ink)' }}
              >
                How it works
              </button>
              <button
                onClick={() => {
                  closeSheet();
                  // Defer the scroll until the sheet is gone — otherwise the
                  // body-scroll-lock cleanup fights the smooth scroll-into-view.
                  window.setTimeout(() => {
                    document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }, 320);
                }}
                className="ios-press w-full text-left px-5 py-4 rounded-2xl text-[16px] font-medium"
                style={{ color: 'var(--ink)' }}
              >
                Pricing
              </button>
              <button
                onClick={() => { closeSheet(); setView('docs'); }}
                className="ios-press w-full text-left px-5 py-4 rounded-2xl text-[16px] font-medium"
                style={{ color: 'var(--ink)' }}
              >
                Docs
              </button>
              <button
                onClick={() => { closeSheet(); setView('login'); }}
                className="ios-press w-full text-left px-5 py-4 rounded-2xl text-[16px] font-medium"
                style={{ color: 'var(--ink)' }}
              >
                Sign in
              </button>
              <button
                onClick={() => { closeSheet(); setView('signup'); }}
                className="ios-press w-full inline-flex items-center justify-center gap-2 mt-2 px-6 py-3.5 rounded-full text-[15px] font-medium"
                style={{ background: 'var(--ink)', color: 'var(--cream)' }}
              >
                Get started
                <PhArrowRight size={15} weight="bold" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AUTH — MOBILE (login / signup / forgot_password)
//
//  Single component, mode-switched. Stays mounted across login ↔ signup ↔
//  forgot_password transitions so the entrance spring plays once and mode
//  changes feel instant, not "every tap reslides up." Cancel triggers a
//  two-stage close (.ios-sheet-exit) before setView('landing') unmounts.
//
//  All form handlers + the Google flows are passed in from
//  SubscriptionGateInner — this component owns nothing about auth state,
//  just the chrome and motion. That keeps validation + Stripe-checkout-
//  on-success paths in one place and lets us swap UI without touching
//  auth logic.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type AuthMode = 'login' | 'signup' | 'forgot_password';

interface AuthMobileProps {
  mode: AuthMode;
  email: string; setEmail: (s: string) => void;
  password: string; setPassword: (s: string) => void;
  name: string; setName: (s: string) => void;
  showPassword: boolean; setShowPassword: (b: boolean) => void;
  handleLogin: (e: React.FormEvent) => void | Promise<void>;
  handleSignup: (e: React.FormEvent) => void | Promise<void>;
  handleForgotPassword: (e: React.FormEvent) => void | Promise<void>;
  handleGoogleSuccess: (cred: any) => void | Promise<void>;
  handleGoogleError: () => void;
  handleGoogleElectron: () => void | Promise<void>;
  renderGoogleFallback: () => React.ReactNode;
  isSubmitting: boolean;
  googleSubmitting: boolean;
  authError: string | null;
  setAuthError: (e: string | null) => void;
  forgotSent: boolean;
  setForgotSent: (b: boolean) => void;
  geo: GeoData | null;
  pricing: RegionPricing | null;
  setView: (v: View) => void;
}

const AuthMobile: React.FC<AuthMobileProps> = ({
  mode, email, setEmail, password, setPassword, name, setName,
  showPassword, setShowPassword,
  handleLogin, handleSignup, handleForgotPassword,
  handleGoogleSuccess, handleGoogleError, handleGoogleElectron, renderGoogleFallback,
  isSubmitting, googleSubmitting, authError, setAuthError,
  forgotSent, setForgotSent, geo, pricing, setView,
}) => {
  const [isClosing, setIsClosing] = useState(false);

  // Cancel/back to landing — two-stage so the .ios-sheet-exit animation lands
  // before React unmounts. 320ms matches --dur-dismiss (380) minus a small
  // head-start so the cream peek behind feels like it's already there when
  // the sheet finishes leaving.
  const dismissToLanding = useCallback(() => {
    if (isClosing) return;
    setIsClosing(true);
    window.setTimeout(() => {
      setAuthError(null);
      setForgotSent(false);
      setView('landing');
    }, 320);
  }, [isClosing, setAuthError, setForgotSent, setView]);

  // Within-auth navigation (login → signup → forgot_password and back).
  // No exit animation — AuthMobile stays mounted, only the mode prop and the
  // visible fields change. Feels like an iOS segmented switch, not a sheet.
  const switchMode = (next: AuthMode) => {
    setAuthError(null);
    setForgotSent(false);
    setView(next);
  };

  // Esc → cancel. Mostly for desktop dev-tools mobile emulation; harmless on
  // phones (iOS soft keyboard has no Esc key).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismissToLanding(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismissToLanding]);

  const headline =
    mode === 'login' ? 'Welcome back.' :
    mode === 'signup' ? 'Create your account.' :
    forgotSent ? 'Check your email.' :
    'Forgot your password?';

  const subhead =
    mode === 'login' ? 'Sign in to continue with your interview copilot.' :
    mode === 'signup' ? 'Free 30-minute trial. No card. Upgrade only if it earned the offer.' :
    forgotSent ? `If an account exists for ${email}, a reset link is on its way. The link expires in one hour.` :
    "Enter the email you signed up with and we'll send you a link to reset your password.";

  const onSubmit =
    mode === 'login' ? handleLogin :
    mode === 'signup' ? handleSignup :
    handleForgotPassword;

  const showCells = mode === 'login' || mode === 'signup' || (mode === 'forgot_password' && !forgotSent);

  return (
    <div
      className={isClosing ? 'fixed inset-0 ios-sheet-exit' : 'fixed inset-0 ios-sheet-enter'}
      style={{
        background: 'var(--cream)',
        color: 'var(--ink)',
        fontFamily: 'var(--sans)',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch' as any,
      }}
    >
      {/* ── Top bar ── slim, blurred translucent, safe-area-respectful.
          Cancel on the left for login/signup (iOS pattern); on
          forgot_password we swap to a "Sign in" back chevron. The X icon
          on the right is redundant with Cancel for iOS users but covers
          web users and Android users who pattern-match X-top-right as
          the universal close affordance. Both buttons fire the same
          dismissToLanding callback. */}
      <div
        className="sticky top-0 z-10 backdrop-blur-md pt-safe"
        style={{
          background: 'color-mix(in oklab, var(--cream) 88%, transparent)',
        }}
      >
        <div className="flex items-center justify-between px-2" style={{ height: 48 }}>
          <button
            onClick={mode === 'forgot_password' ? () => switchMode('login') : dismissToLanding}
            className="ios-press inline-flex items-center gap-1 px-3 py-2 text-[15px]"
            style={{ color: 'var(--ink)' }}
          >
            {mode === 'forgot_password' && <ArrowLeft size={17} />}
            {mode === 'forgot_password' ? 'Sign in' : 'Cancel'}
          </button>
          {/* Hide the X on forgot_password — Cancel/back-chevron carries
              that flow alone, and an X here would race with the back
              chevron meaning. */}
          {mode !== 'forgot_password' && (
            <button
              onClick={dismissToLanding}
              aria-label="Close"
              className="ios-press w-9 h-9 mr-1 flex items-center justify-center rounded-full"
              style={{ color: 'var(--ink-muted)' }}
            >
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {/* ── Headline + subhead ── */}
      <div className="px-5 pt-2 pb-7">
        <Logo size="md" theme="light" />
        <h2
          className="mt-5 text-[22px]"
          style={{ fontFamily: 'var(--serif)', fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.15 }}
        >
          {headline}
        </h2>
        <p className="mt-2 text-[14.5px]" style={{ color: 'var(--ink-muted)', lineHeight: 1.55 }}>
          {subhead}
        </p>
      </div>

      {mode === 'forgot_password' && forgotSent ? (
        // ── Forgot-password success — no form, single CTA back to sign in. ──
        <div className="px-5">
          <button
            type="button"
            onClick={() => switchMode('login')}
            className="ios-press w-full py-3.5 rounded-full text-[15px] font-medium"
            style={{ background: 'var(--ink)', color: 'var(--cream)' }}
          >
            Back to sign in
          </button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="px-5 space-y-4">
          {/* ── iOS grouped-cells: rounded card with hairline dividers between
              rows. Pattern matches Settings.app — labels above values, every
              cell tappable, dividers indented from the card edge. ── */}
          {showCells && (
            <div
              style={{
                background: 'var(--cream-soft)',
                border: '1px solid var(--cream-line)',
                borderRadius: 16,
                overflow: 'hidden',
              }}
            >
              {mode === 'signup' && (
                <>
                  <div className="px-4 pt-3 pb-3">
                    <label className="text-[10.5px] uppercase tracking-[0.18em] block mb-0.5" style={{ color: 'var(--ink-muted)' }}>NAME</label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Your name"
                      className="block w-full text-[16px] bg-transparent outline-none"
                      style={{ color: 'var(--ink)', minHeight: 24 }}
                      autoFocus
                      autoComplete="name"
                    />
                  </div>
                  <div className="h-px mx-4" style={{ background: 'var(--cream-line)' }} />
                </>
              )}
              <div className="px-4 pt-3 pb-3">
                <label className="text-[10.5px] uppercase tracking-[0.18em] block mb-0.5" style={{ color: 'var(--ink-muted)' }}>EMAIL</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="block w-full text-[16px] bg-transparent outline-none"
                  style={{ color: 'var(--ink)', minHeight: 24 }}
                  autoFocus={mode !== 'signup'}
                  autoComplete="email"
                  inputMode="email"
                  required
                />
              </div>
              {(mode === 'login' || mode === 'signup') && (
                <>
                  <div className="h-px mx-4" style={{ background: 'var(--cream-line)' }} />
                  <div className="px-4 pt-3 pb-3 relative">
                    <label className="text-[10.5px] uppercase tracking-[0.18em] block mb-0.5" style={{ color: 'var(--ink-muted)' }}>PASSWORD</label>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={mode === 'login' ? 'Enter your password' : 'At least 8 characters'}
                      className="block w-full text-[16px] bg-transparent outline-none pr-7"
                      style={{ color: 'var(--ink)', minHeight: 24 }}
                      autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                      required
                      minLength={mode === 'signup' ? 8 : undefined}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 ios-press"
                      style={{ color: 'var(--ink-muted)', bottom: 14 }}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Inline error ── iOS-style alert pill, accent-tinted. */}
          {authError && (
            <div
              className="flex items-start gap-2 px-3 py-2.5 rounded-xl text-[13px]"
              style={{
                background: 'color-mix(in oklab, var(--accent) 10%, transparent)',
                border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)',
                color: 'var(--accent)',
              }}
            >
              <AlertTriangle size={14} style={{ marginTop: 1, flexShrink: 0 }} />
              <span style={{ lineHeight: 1.45 }}>{authError}</span>
            </div>
          )}

          {/* ── Forgot-password row (login only) ── */}
          {mode === 'login' && (
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={() => switchMode('forgot_password')}
                className="ios-press text-[13px] font-medium"
                style={{ color: 'var(--accent)' }}
              >
                Forgot password?
              </button>
            </div>
          )}

          {/* ── Primary CTA ── */}
          <button
            type="submit"
            disabled={isSubmitting || googleSubmitting}
            className="ios-press w-full inline-flex items-center justify-center gap-2 py-3.5 rounded-full text-[15px] font-medium disabled:opacity-60"
            style={{ background: 'var(--ink)', color: 'var(--cream)', letterSpacing: '-0.005em' }}
          >
            {isSubmitting && <Loader2 size={16} className="animate-spin" />}
            {mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
            {!isSubmitting && <PhArrowRight size={14} weight="bold" />}
          </button>

          {mode === 'signup' && (
            <p className="text-[11px] text-center leading-relaxed pt-1" style={{ color: 'var(--ink-faint)' }}>
              By creating an account, you agree to our Terms and Privacy Policy.
            </p>
          )}
        </form>
      )}

      {/* ── Google sign-in (login + signup only; not on forgot_password) ── */}
      {GOOGLE_CLIENT_ID && (mode === 'login' || mode === 'signup') && (
        <div className="px-5 mt-7">
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px" style={{ background: 'var(--cream-line)' }} />
            <span className="text-[10px] uppercase tracking-[0.18em]" style={{ color: 'var(--ink-faint)' }}>or</span>
            <div className="flex-1 h-px" style={{ background: 'var(--cream-line)' }} />
          </div>
          {isElectron ? (
            <button
              type="button"
              onClick={handleGoogleElectron}
              disabled={isSubmitting || googleSubmitting}
              className="ios-press mt-5 w-full py-3.5 px-4 rounded-full text-[14px] font-medium flex items-center justify-center gap-3 disabled:opacity-60"
              style={{ background: 'var(--cream-soft)', border: '1px solid var(--cream-line)', color: 'var(--ink)' }}
            >
              {googleSubmitting ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
              )}
              {googleSubmitting
                ? (mode === 'login' ? 'Waiting for sign-in...' : 'Waiting for sign-up...')
                : 'Continue with Google'}
            </button>
          ) : (
            <div className="mt-5 flex justify-center [&_iframe]:rounded-full">
              <GoogleLogin
                onSuccess={handleGoogleSuccess}
                onError={handleGoogleError}
                theme="outline"
                size="large"
                width="320"
                text={mode === 'login' ? 'signin_with' : 'signup_with'}
                shape="pill"
              />
            </div>
          )}
          {isElectron && renderGoogleFallback()}
        </div>
      )}

      {/* ── Mode switcher ── */}
      <div className="px-5 mt-8 text-center text-[13.5px]" style={{ color: 'var(--ink-muted)' }}>
        {mode === 'login' ? (
          <>
            No account?{' '}
            <button onClick={() => switchMode('signup')} className="ios-press font-medium" style={{ color: 'var(--ink)' }}>
              Create one
            </button>
          </>
        ) : mode === 'signup' ? (
          <>
            Already have an account?{' '}
            <button onClick={() => switchMode('login')} className="ios-press font-medium" style={{ color: 'var(--ink)' }}>
              Sign in
            </button>
          </>
        ) : (
          <>
            Remembered it?{' '}
            <button onClick={() => switchMode('login')} className="ios-press font-medium" style={{ color: 'var(--ink)' }}>
              Sign in
            </button>
          </>
        )}
      </div>

      {/* ── Geo footer ── safe-area pad so the home indicator stays clear. */}
      {geo && (
        <div
          className="px-5 mt-7 flex items-center justify-center gap-1.5 text-[11px]"
          style={{
            color: 'var(--ink-faint)',
            paddingBottom: 'max(env(safe-area-inset-bottom), 32px)',
          }}
        >
          {mode === 'signup' ? (
            <>
              <PhGlobe size={11} weight="duotone" />
              {geo.country_name}
              {pricing && <> &middot; {pricing.currencySymbol} {pricing.currency}</>}
            </>
          ) : (
            <>
              <PhLock size={11} weight="duotone" />
              Secure connection from {geo.country_name}
            </>
          )}
        </div>
      )}
    </div>
  );
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TUTORIALS — MOBILE
//
//  iPhone-feel rebuild of the tutorials view. Cream surface (matches
//  mobile landing/auth) instead of the desktop dark theme — keeps the
//  whole mobile funnel visually coherent. Vertical list of 8 step-cards
//  with stagger-rise entrance, sheet-up entry, sheet-down dismiss back
//  to landing or download depending on auth state.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface TutorialsMobileProps {
  setView: (v: View) => void;
  currentUser: UserProfile | null;
}

const TUTORIAL_STEPS = [
  { step: '01', title: 'Download & Install',  desc: 'Install minicaai on Windows, macOS, or Linux and launch it.', duration: '1 min' },
  { step: '02', title: 'Create Your Account', desc: 'Sign up, verify your email, and activate your license key.',   duration: '1 min' },
  { step: '03', title: 'Upload Resume & JD',  desc: 'Add your résumé and job description for contextual AI answers.', duration: '1 min' },
  { step: '04', title: 'Start an Interview',  desc: 'Share system audio, enable auto-mode, and let minicaai listen.', duration: '2 min' },
  { step: '05', title: 'Pop-out Mode',        desc: 'Launch the invisible overlay that floats over Zoom, Meet, Teams. (Pro)', duration: '1 min' },
  { step: '06', title: 'Auto-Solve',          desc: 'Capture the editor and let AI solve coding problems on demand. (Pro)', duration: '2 min' },
  { step: '07', title: 'Switch AI Models',    desc: 'Pick between Gemini, GPT, Claude, Grok, Llama for different strengths.', duration: '1 min' },
  { step: '08', title: 'Manage Subscription', desc: 'Upgrade, manage billing, and view usage stats.', duration: '1 min' },
] as const;

const TutorialsMobile: React.FC<TutorialsMobileProps> = ({ setView, currentUser }) => {
  const [isClosing, setIsClosing] = useState(false);

  const dismiss = useCallback(() => {
    if (isClosing) return;
    setIsClosing(true);
    window.setTimeout(() => setView(currentUser ? 'download' : 'landing'), 320);
  }, [isClosing, setView, currentUser]);

  // Stagger entrance for cards as they enter the viewport.
  useEffect(() => {
    const cards = document.querySelectorAll('[data-rise]:not(.ios-rise-active)');
    if (cards.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach(e => {
          if (e.isIntersecting) {
            (e.target as HTMLElement).classList.add('ios-rise-active');
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.05 }
    );
    cards.forEach(c => io.observe(c));
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismiss]);

  return (
    <div
      className={isClosing ? 'fixed inset-0 ios-sheet-exit' : 'fixed inset-0 ios-sheet-enter'}
      style={{
        background: 'var(--cream)',
        color: 'var(--ink)',
        fontFamily: 'var(--sans)',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch' as any,
      }}
    >
      {/* Top bar */}
      <div
        className="sticky top-0 z-10 backdrop-blur-md pt-safe"
        style={{ background: 'color-mix(in oklab, var(--cream) 88%, transparent)' }}
      >
        <div className="flex items-center justify-between px-2" style={{ height: 48 }}>
          <button
            onClick={dismiss}
            className="ios-press inline-flex items-center gap-1 px-3 py-2 text-[15px]"
            style={{ color: 'var(--ink)' }}
          >
            <ArrowLeft size={17} />
            {currentUser ? 'Download' : 'Home'}
          </button>
          <Logo size="sm" theme="light" />
          <div style={{ width: 88 }} />
        </div>
      </div>

      {/* Hero */}
      <section className="px-5 pt-8 pb-8">
        <div className="inline-flex items-center gap-1.5 mb-5" style={{ color: 'var(--ink-muted)' }}>
          <PhSparkle size={12} weight="duotone" style={{ color: 'var(--accent)' }} />
          <span className="text-[11px] font-medium uppercase tracking-[0.18em]">Getting Started</span>
        </div>
        <h1
          className="text-[34px] leading-[1.05] mb-4"
          style={{ fontFamily: 'var(--serif)', fontWeight: 400, letterSpacing: '-0.025em' }}
        >
          Learn minicaai in <em style={{ fontStyle: 'italic', fontWeight: 400 }}>5 minutes</em>.
        </h1>
        <p className="text-[15.5px]" style={{ color: 'var(--ink-soft)', lineHeight: 1.55 }}>
          Eight short tutorials that walk you through every feature, end to end.
        </p>
      </section>

      {/* Tutorial cards */}
      <section className="px-5 pb-10">
        <div className="space-y-3">
          {TUTORIAL_STEPS.map((s, i) => (
            <div
              key={s.step}
              data-rise
              style={{
                animationDelay: `${i * 50}ms`,
                background: 'var(--cream-soft)',
                border: '1px solid var(--cream-line)',
              }}
              className="ios-press rounded-3xl p-5"
            >
              <div className="flex items-start justify-between mb-2">
                <span className="text-[12px] font-medium tabular-nums tracking-[0.1em]" style={{ color: 'var(--ink-muted)' }}>
                  {s.step}
                </span>
                <span className="inline-flex items-center gap-1 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                  <Clock size={10} /> {s.duration}
                </span>
              </div>
              <h3
                className="text-[18px] mb-1.5"
                style={{ fontFamily: 'var(--serif)', fontWeight: 500, letterSpacing: '-0.015em' }}
              >
                {s.title}
              </h3>
              <p className="text-[13.5px]" style={{ color: 'var(--ink-soft)', lineHeight: 1.55 }}>
                {s.desc}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="px-5" style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 40px)' }}>
        <button
          onClick={() => setView(currentUser ? 'download' : 'signup')}
          className="ios-press w-full inline-flex items-center justify-center gap-2 px-7 py-4 rounded-full text-[15px] font-medium"
          style={{ background: 'var(--ink)', color: 'var(--cream)' }}
        >
          {currentUser ? 'Go to Download' : 'Get Started'}
          <PhArrowRight size={15} weight="bold" />
        </button>
      </section>
    </div>
  );
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PRICING — MOBILE
//
//  Re-uses the existing PricingCard component (same tier visuals, "Most
//  chosen" pill, regional formatting) inside a horizontal paged swiper —
//  same pattern as the landing's pricing section. Drops the desktop
//  feature-comparison table (info redundant with PricingCard) and replaces
//  it with an iOS-style accordion FAQ. Skips comparison on purpose.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface PricingMobileProps {
  setView: (v: View) => void;
  geo: GeoData | null;
  pricing: RegionPricing | null;
  handleTierSelect: (tier: PricingTier) => Promise<void> | void;
  isSubmitting: boolean;
  currentUser: UserProfile | null;
}

const PRICING_FAQ = [
  { q: 'Can I share the app with others?',  a: 'No. Each license is bound to a specific device. Shared copies will not authenticate and will be locked.' },
  { q: 'What happens if I use a VPN?',      a: 'VPN and proxy connections are detected and blocked. You must use a direct connection from your registered country.' },
  { q: 'Can I cancel anytime?',             a: 'Yes. Cancel from your account settings. Access continues until the end of your billing period.' },
  { q: 'What if I change devices?',         a: 'Contact our live support to transfer your license. Each Pro account supports up to 3 devices.' },
] as const;

const PricingMobile: React.FC<PricingMobileProps> = ({
  setView, geo, pricing, handleTierSelect, isSubmitting, currentUser,
}) => {
  const [isClosing, setIsClosing] = useState(false);
  const [pricingIdx, setPricingIdx] = useState(0);
  const [openFaqIdx, setOpenFaqIdx] = useState<number | null>(null);
  const pricingScrollRef = useRef<HTMLDivElement>(null);

  const dismiss = useCallback(() => {
    if (isClosing) return;
    setIsClosing(true);
    window.setTimeout(() => setView(currentUser ? 'download' : 'landing'), 320);
  }, [isClosing, setView, currentUser]);

  useEffect(() => {
    const el = pricingScrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (el.clientWidth > 0) setPricingIdx(Math.round(el.scrollLeft / el.clientWidth));
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [pricing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismiss]);

  const dotStyle = (active: boolean): React.CSSProperties => ({
    width: active ? 22 : 6,
    height: 6,
    borderRadius: 999,
    background: active ? 'var(--ink)' : 'var(--cream-line)',
    transition: 'width 280ms var(--ease-ios), background 280ms var(--ease-ios)',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
  });

  const scrollPagerTo = (idx: number) => {
    const el = pricingScrollRef.current;
    if (!el) return;
    el.scrollTo({ left: idx * el.clientWidth, behavior: 'smooth' });
  };

  return (
    <div
      className={isClosing ? 'fixed inset-0 ios-sheet-exit' : 'fixed inset-0 ios-sheet-enter'}
      style={{
        background: 'var(--cream)',
        color: 'var(--ink)',
        fontFamily: 'var(--sans)',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch' as any,
      }}
    >
      {/* Top bar */}
      <div
        className="sticky top-0 z-10 backdrop-blur-md pt-safe"
        style={{ background: 'color-mix(in oklab, var(--cream) 88%, transparent)' }}
      >
        <div className="flex items-center justify-between px-2" style={{ height: 48 }}>
          <button
            onClick={dismiss}
            className="ios-press inline-flex items-center gap-1 px-3 py-2 text-[15px]"
            style={{ color: 'var(--ink)' }}
          >
            <ArrowLeft size={17} />
            {currentUser ? 'Download' : 'Home'}
          </button>
          <Logo size="sm" theme="light" />
          {!currentUser ? (
            <button
              onClick={() => setView('login')}
              className="ios-press px-3 py-2 text-[14px] font-medium"
              style={{ color: 'var(--ink)' }}
            >
              Sign in
            </button>
          ) : (
            <div style={{ width: 64 }} />
          )}
        </div>
      </div>

      {/* Hero */}
      <section className="px-5 pt-8 pb-7">
        <div className="inline-flex items-center gap-1.5 mb-5" style={{ color: 'var(--ink-muted)' }}>
          <PhSparkle size={12} weight="duotone" style={{ color: 'var(--accent)' }} />
          <span className="text-[11px] font-medium uppercase tracking-[0.18em]">Pricing</span>
        </div>
        <h1
          className="text-[34px] leading-[1.05] mb-4"
          style={{ fontFamily: 'var(--serif)', fontWeight: 400, letterSpacing: '-0.025em' }}
        >
          Choose your plan.
        </h1>
        <p className="text-[15.5px]" style={{ color: 'var(--ink-soft)', lineHeight: 1.55 }}>
          Start free, upgrade when you're ready. Cancel anytime.
        </p>
        {geo && (
          <p className="mt-3 text-[12.5px]" style={{ color: 'var(--ink-muted)' }}>
            Pricing for {geo.country_name}
            {pricing ? <> &middot; {pricing.currencySymbol} {pricing.currency}</> : null}
          </p>
        )}
      </section>

      {/* Pricing pager */}
      {pricing && (
        <section className="pb-10">
          <div ref={pricingScrollRef} className="ios-pager pb-1">
            {pricing.tiers.map((tier) => (
              <div key={tier.id} className="ios-pager-item">
                <PricingCard tier={tier} onSelect={handleTierSelect} isLoading={isSubmitting} />
              </div>
            ))}
          </div>
          <div className="flex justify-center gap-1.5 mt-5">
            {pricing.tiers.map((_, i) => (
              <button
                key={i}
                onClick={() => scrollPagerTo(i)}
                aria-label={`Tier ${i + 1}`}
                className="ios-press"
                style={dotStyle(i === pricingIdx)}
              />
            ))}
          </div>
        </section>
      )}

      {/* FAQ accordion */}
      <section className="px-5 pb-10" style={{ borderTop: '1px solid var(--cream-line)' }}>
        <h2
          className="text-[26px] leading-[1.1] pt-10 mb-6"
          style={{ fontFamily: 'var(--serif)', fontWeight: 400, letterSpacing: '-0.02em' }}
        >
          Frequently asked.
        </h2>
        <div
          style={{
            background: 'var(--cream-soft)',
            border: '1px solid var(--cream-line)',
            borderRadius: 16,
            overflow: 'hidden',
          }}
        >
          {PRICING_FAQ.map((item, i) => {
            const open = openFaqIdx === i;
            return (
              <React.Fragment key={i}>
                {i > 0 && <div className="h-px mx-4" style={{ background: 'var(--cream-line)' }} />}
                <button
                  onClick={() => setOpenFaqIdx(open ? null : i)}
                  className="ios-press w-full text-left px-4 py-4 flex items-start justify-between gap-3"
                  aria-expanded={open}
                >
                  <span className="text-[14.5px] font-medium" style={{ color: 'var(--ink)' }}>
                    {item.q}
                  </span>
                  <ChevronDown
                    size={16}
                    style={{
                      color: 'var(--ink-muted)',
                      transition: 'transform 280ms var(--ease-ios)',
                      transform: open ? 'rotate(180deg)' : 'rotate(0)',
                      flexShrink: 0,
                      marginTop: 2,
                    }}
                  />
                </button>
                {open && (
                  <div className="px-4 pb-4 -mt-1">
                    <p className="text-[13.5px]" style={{ color: 'var(--ink-soft)', lineHeight: 1.6 }}>
                      {item.a}
                    </p>
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </section>

      <div style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 32px)' }} />
    </div>
  );
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DOWNLOAD — MOBILE (post-auth dashboard for browser users)
//
//  Cream surface (matches the rest of the mobile funnel; desktop stays
//  dark). Top app-bar shows tier badge + avatar that opens an account
//  bottom-sheet (Tutorials / Admin / Sign out — moves the desktop's
//  inline icons into a tappable sheet). Tier-aware action: Pro/Max
//  active chip, Basic with renew CTA, free with Upgrade. Cancel-
//  subscription confirm renders as a bottom sheet (native iOS
//  destructive-action pattern) instead of a centered dialog.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface DownloadMobileProps {
  setView: (v: View) => void;
  currentUser: UserProfile | null;
  setCurrentUser: (user: UserProfile | null) => void;
  currentLicense: LicenseData | null;
  handleLogout: () => void;
  justSignedUp: boolean;
  setJustSignedUp: (b: boolean) => void;
  paymentError: string | null;
  paymentSuccess: string | null;
  paymentLoading: boolean;
  geo: GeoData | null;
  // Regional pricing payload — feeds PlanSheetMobile's per-tier price labels.
  pricing: RegionPricing | null;
  lastSuccessfulTier: string | null;
  cancelConfirm: boolean;
  setCancelConfirm: (b: boolean) => void;
  handleManageSubscription: () => Promise<void> | void;
  handleCancelSubscription: () => Promise<void> | void;
  initiateRenewal: () => Promise<void> | void;
  initiateCheckout: (tier?: 'basic' | 'pro' | 'max') => Promise<void> | void;
  basicExpiryLabel: (expiresAt: number | undefined | null) => string | null;
  // Opens Documentation as a modal layer OVER the mobile profile sheet
  // so closing docs returns to the still-open profile. Lifted to
  // SubscriptionGateInner so its single <Documentation> instance covers
  // both desktop /download nav and the mobile DownloadMobile flow.
  onOpenDocs?: () => void;
}

const DOWNLOAD_PLATFORMS = [
  { name: 'Windows', sub: 'Windows 10+ (.exe)',     href: 'https://get.minicaai.com/windows', Icon: Monitor    },
  { name: 'macOS',   sub: 'macOS 10.15+ (.dmg)',    href: 'https://get.minicaai.com/mac',   Icon: Cpu        },
  { name: 'Linux',   sub: 'Any distro (.AppImage)', href: 'https://get.minicaai.com/linux', Icon: Headphones },
] as const;

const POST_DOWNLOAD_STEPS = [
  'Install and open the app',
  'Sign in with the same email you just registered',
  'Your license activates automatically on this device',
  'Upload your résumé and start your first session',
];

const DownloadMobile: React.FC<DownloadMobileProps> = (props) => {
  const {
    setView, currentUser, setCurrentUser, currentLicense, handleLogout, justSignedUp, setJustSignedUp,
    paymentError, paymentSuccess, paymentLoading, geo, pricing, lastSuccessfulTier,
    cancelConfirm, setCancelConfirm, handleManageSubscription, handleCancelSubscription,
    initiateRenewal, initiateCheckout, basicExpiryLabel, onOpenDocs,
  } = props;

  const [showAccountSheet, setShowAccountSheet] = useState(false);
  // Plan & billing sheet — opens from "Change plan" pill, the account-sheet
  // entry, or any inline upgrade affordance. Single sheet handles every
  // possible switch path; see PlanSheetMobile for the action-routing logic.
  const [planSheetOpen, setPlanSheetOpen] = useState(false);
  // Profile sheet — opens from the account sheet's "Profile" item or the
  // avatar tap in the top bar. Owns its own draft state internally so name
  // edits survive the user briefly closing/re-opening the sheet within a
  // single intent.
  const [profileSheetOpen, setProfileSheetOpen] = useState(false);

  // Effective-tier resolution — mirrors the desktop's IIFE logic. Admin always
  // renders as Max; otherwise prefer the live license tier; fall back to the
  // tier the user just paid for (covers the post-payment window where the
  // webhook hasn't landed and currentLicense.tier is still 'free').
  const isAdminUser = !!currentUser && licenseService.isDeveloper(currentUser.email);
  const licenseTier = currentLicense?.tier;
  const paidLicense =
    licenseTier === 'max' || licenseTier === 'pro' || licenseTier === 'basic'
      ? licenseTier : null;
  const fallbackTier = paidLicense
    ? paidLicense
    : (lastSuccessfulTier === 'max' || lastSuccessfulTier === 'pro' || lastSuccessfulTier === 'basic'
        ? lastSuccessfulTier
        : null);
  const effectiveTier = isAdminUser ? 'max' : fallbackTier;

  const tierBadge = (() => {
    if (!currentLicense) return null;
    const t = currentLicense.tier;
    const labelMap: Record<string, string> = { max: 'MAX', pro: 'PRO', basic: 'BASIC', free: 'FREE' };
    const colorMap: Record<string, { bg: string; color: string }> = {
      max:   { bg: 'rgba(245, 158, 11, 0.15)', color: '#b45309' },
      pro:   { bg: 'rgba(59, 130, 246, 0.15)', color: '#1d4ed8' },
      basic: { bg: 'rgba(16, 185, 129, 0.15)', color: '#047857' },
      free:  { bg: 'var(--cream-soft)',        color: 'var(--ink-muted)' },
    };
    return { label: labelMap[t] || 'FREE', ...(colorMap[t] || colorMap.free) };
  })();

  return (
    <div
      className="fixed inset-0 ios-sheet-enter overflow-y-auto"
      style={{
        background: 'var(--cream)',
        color: 'var(--ink)',
        fontFamily: 'var(--sans)',
        WebkitOverflowScrolling: 'touch' as any,
      }}
    >
      {/* Top bar */}
      <div
        className="sticky top-0 z-30 backdrop-blur-md pt-safe"
        style={{
          background: 'color-mix(in oklab, var(--cream) 88%, transparent)',
          borderBottom: '1px solid var(--cream-line)',
        }}
      >
        <div className="flex items-center justify-between px-5" style={{ height: 56 }}>
          <Logo size="sm" theme="light" />
          {currentUser && (
            <button
              onClick={() => setShowAccountSheet(true)}
              className="ios-press flex items-center gap-2"
              aria-label="Account menu"
            >
              {tierBadge && (
                <span
                  className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
                  style={{ background: tierBadge.bg, color: tierBadge.color }}
                >
                  {tierBadge.label}
                </span>
              )}
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center"
                style={{ background: 'var(--cream-soft)', border: '1px solid var(--cream-line)' }}
              >
                <span className="text-[12px] font-medium" style={{ color: 'var(--ink)' }}>
                  {currentUser.name?.[0]?.toUpperCase() || currentUser.email[0].toUpperCase()}
                </span>
              </div>
            </button>
          )}
        </div>
      </div>

      {/* Hero — big icon */}
      <section className="px-5 pt-9 pb-6 text-center">
        <div
          className="w-20 h-20 mx-auto rounded-3xl flex items-center justify-center mb-6"
          style={{
            background: 'var(--ink)',
            boxShadow: '0 12px 28px rgba(20, 20, 19, 0.16)',
          }}
        >
          <Download size={32} style={{ color: 'var(--cream)' }} />
        </div>
        <h1
          className="text-[30px] leading-[1.08] mb-3"
          style={{ fontFamily: 'var(--serif)', fontWeight: 400, letterSpacing: '-0.025em' }}
        >
          Download minicaai.
        </h1>
        <p
          className="text-[14.5px] mx-auto"
          style={{ color: 'var(--ink-soft)', lineHeight: 1.55, maxWidth: '92%' }}
        >
          Runs as a desktop app — invisible to screen sharing, system audio capture, always-on-top overlay.
        </p>
      </section>

      {/* Web-not-available chip */}
      <section className="px-5 pb-5 flex justify-center">
        <div
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px]"
          style={{
            background: 'color-mix(in oklab, var(--accent) 8%, transparent)',
            border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)',
            color: 'var(--accent)',
          }}
        >
          <AlertTriangle size={11} />
          The web version is not available
        </div>
      </section>

      {/* Welcome banner for fresh signups still on free */}
      {justSignedUp && (!currentLicense || currentLicense.tier === 'free') && (
        <section className="px-5 pb-5">
          <div
            role="status"
            aria-live="polite"
            className="flex items-start gap-3 px-4 py-3 rounded-2xl"
            style={{
              background: 'color-mix(in oklab, var(--accent) 8%, transparent)',
              border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)',
            }}
          >
            <Sparkles size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
            <div className="flex-1">
              <div className="text-[14px] font-medium" style={{ color: 'var(--ink)' }}>Welcome to minicaai.</div>
              <div className="text-[12.5px] mt-0.5" style={{ color: 'var(--ink-muted)', lineHeight: 1.5 }}>
                Your 30-minute free trial is running. Download below to start your first session.
              </div>
            </div>
            <button
              onClick={() => setJustSignedUp(false)}
              aria-label="Dismiss"
              className="ios-press shrink-0"
              style={{ color: 'var(--ink-faint)' }}
            >
              <X size={14} />
            </button>
          </div>
        </section>
      )}

      {/* Payment error / success banners */}
      {paymentError && (
        <section className="px-5 pb-3">
          <div
            className="flex items-center gap-2 px-4 py-3 rounded-2xl text-[13px]"
            style={{
              background: 'color-mix(in oklab, var(--accent) 10%, transparent)',
              border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)',
              color: 'var(--accent)',
            }}
          >
            <AlertTriangle size={14} /> {paymentError}
          </div>
        </section>
      )}
      {paymentSuccess && (
        <section className="px-5 pb-3">
          <div
            role="status"
            aria-live="polite"
            className="flex items-start gap-2 px-4 py-3 rounded-2xl text-[13px]"
            style={{
              background: 'rgba(16, 185, 129, 0.1)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              color: '#047857',
            }}
          >
            <Check size={14} style={{ marginTop: 1 }} /> {paymentSuccess}
          </div>
        </section>
      )}

      {/* Download cards */}
      <section className="px-5 pt-4 pb-8">
        <div className="space-y-3">
          {DOWNLOAD_PLATFORMS.map(({ name, sub, href, Icon }) => (
            <a
              key={name}
              href={href}
              className="ios-press flex items-center justify-between gap-4 px-4 py-4 rounded-3xl"
              style={{
                background: 'var(--cream-soft)',
                border: '1px solid var(--cream-line)',
                color: 'var(--ink)',
                textDecoration: 'none',
              }}
            >
              <div className="flex items-center gap-4 min-w-0">
                <div
                  className="shrink-0 w-11 h-11 rounded-2xl flex items-center justify-center"
                  style={{ background: 'var(--cream)', border: '1px solid var(--cream-line)' }}
                >
                  <Icon size={20} style={{ color: 'var(--ink)' }} />
                </div>
                <div className="min-w-0">
                  <div className="text-[15px] font-medium truncate" style={{ color: 'var(--ink)' }}>{name}</div>
                  <div className="text-[12px] mt-0.5" style={{ color: 'var(--ink-muted)' }}>{sub}</div>
                </div>
              </div>
              <Download size={18} className="shrink-0" style={{ color: 'var(--ink-muted)' }} />
            </a>
          ))}
        </div>
      </section>

      {/* Tier-aware action */}
      <section className="px-5 pb-10">
        {(() => {
          if (effectiveTier === 'max' || effectiveTier === 'pro') {
            const isMax = effectiveTier === 'max';
            return (
              <div className="space-y-3">
                <div
                  className="px-5 py-3.5 rounded-full text-center text-[14px] font-medium inline-flex items-center justify-center gap-2 w-full"
                  style={{
                    background: isMax ? 'rgba(245, 158, 11, 0.12)' : 'rgba(59, 130, 246, 0.12)',
                    border: '1px solid ' + (isMax ? 'rgba(245, 158, 11, 0.35)' : 'rgba(59, 130, 246, 0.35)'),
                    color: isMax ? '#b45309' : '#1d4ed8',
                  }}
                >
                  {isMax ? <WizardHat size={14} /> : <Check size={14} />}
                  {isAdminUser ? 'Admin · Max Active' : (isMax ? 'Max Active' : 'Pro Active')}
                </div>
                {/* Inline Pro→Max upgrade — one-tap path to the highest tier
                    without leaving the page. Routes through initiateCheckout
                    which detects the existing Pro sub and posts to
                    /upgrade-tier instead of creating a second subscription. */}
                {!isAdminUser && !isMax && (
                  <button
                    onClick={() => initiateCheckout('max')}
                    disabled={paymentLoading}
                    className="ios-press w-full inline-flex items-center justify-center gap-2 px-4 py-3.5 rounded-full text-[14px] font-medium disabled:opacity-50"
                    style={{
                      background: 'rgba(245, 158, 11, 0.12)',
                      border: '1px solid rgba(245, 158, 11, 0.35)',
                      color: '#b45309',
                    }}
                  >
                    {paymentLoading ? <Loader2 size={14} className="animate-spin" /> : <WizardHat size={14} />}
                    Upgrade to Max
                  </button>
                )}
                {!isAdminUser && geo?.country_code !== 'IN' && (
                  <button
                    onClick={handleManageSubscription}
                    disabled={paymentLoading}
                    className="ios-press w-full inline-flex items-center justify-center gap-2 px-4 py-3.5 rounded-full text-[14px] font-medium disabled:opacity-50"
                    style={{ background: 'var(--cream-soft)', border: '1px solid var(--cream-line)', color: 'var(--ink)' }}
                  >
                    {paymentLoading ? <Loader2 size={14} className="animate-spin" /> : <Settings size={14} />}
                    Manage subscription
                    <ExternalLink size={12} className="opacity-60" />
                  </button>
                )}
                {!isAdminUser && geo?.country_code === 'IN' && (
                  <button
                    onClick={() => setCancelConfirm(true)}
                    disabled={paymentLoading}
                    className="ios-press w-full inline-flex items-center justify-center gap-2 px-4 py-3.5 rounded-full text-[14px] font-medium disabled:opacity-50"
                    style={{ background: 'transparent', border: '1px solid var(--cream-line)', color: 'var(--ink-muted)' }}
                  >
                    {paymentLoading ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
                    Cancel subscription
                  </button>
                )}
              </div>
            );
          }
          if (effectiveTier === 'basic') {
            // Renew is gated STRICTLY on the live license tier — not on
            // effectiveTier, which falls back to lastSuccessfulTier from
            // localStorage during the post-Stripe webhook-lag window. In
            // that window the user just bought Basic; offering Renew is
            // both confusing UX and would be rejected server-side by the
            // /create-renewal tier gate. We still render the "Basic Active"
            // chip optimistically (effectiveTier covers the lag), just
            // without the renew button until the license confirms Basic.
            const isConfirmedBasic = currentLicense?.tier === 'basic';
            const r = pricingService.getBasicRenewalPrice(geo?.country_code || 'US');
            return (
              <div className="space-y-3">
                <div
                  className="px-5 py-3.5 rounded-full text-center text-[14px] font-medium inline-flex items-center justify-center gap-2 w-full"
                  style={{
                    background: 'rgba(16, 185, 129, 0.1)',
                    border: '1px solid rgba(16, 185, 129, 0.3)',
                    color: '#047857',
                  }}
                >
                  <Sparkles size={14} /> Basic Active
                </div>
                {currentLicense && basicExpiryLabel(currentLicense.expires_at) && (
                  <div className="flex items-center justify-center gap-1 text-[12px]" style={{ color: 'var(--ink-muted)' }}>
                    <Clock size={11} />
                    {basicExpiryLabel(currentLicense.expires_at)}
                  </div>
                )}
                {isConfirmedBasic && (
                  <button
                    onClick={initiateRenewal}
                    disabled={paymentLoading}
                    className="ios-press w-full inline-flex items-center justify-center gap-2 py-3.5 rounded-full text-[14px] font-medium disabled:opacity-50"
                    style={{ background: 'var(--ink)', color: 'var(--cream)' }}
                  >
                    {paymentLoading ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                    {`Renew +1h · ${pricingService.formatPrice(r.price, r.currencySymbol, r.currency)}`}
                  </button>
                )}
              </div>
            );
          }
          return (
            <button
              onClick={() => initiateCheckout('pro')}
              disabled={paymentLoading}
              className="ios-press w-full inline-flex items-center justify-center gap-2 py-4 rounded-full text-[15px] font-medium disabled:opacity-50"
              style={{ background: 'var(--ink)', color: 'var(--cream)' }}
            >
              {paymentLoading ? <Loader2 size={14} className="animate-spin" /> : <Crown size={14} />}
              Upgrade to Pro
            </button>
          );
        })()}
      </section>

      {/* Manage subscription — universal entry to PlanSheetMobile. Visible
          to every tier and every state (no justSignedUp gate — even brand
          new users need an obvious path to switch/cancel). Styled as a real
          button (cream-soft background + hairline border) so it reads as an
          action, not a label. The label is "Manage subscription" instead of
          "Change plan" to match what users search for when they want to
          cancel — that's the word every billing flow on the internet uses. */}
      <section className="px-5 pb-10 -mt-4">
        <button
          onClick={() => setPlanSheetOpen(true)}
          className="ios-press w-full inline-flex items-center justify-between gap-2 py-3.5 px-5 rounded-full text-[14px] font-medium"
          style={{
            background: 'var(--cream-soft)',
            border: '1px solid var(--cream-line)',
            color: 'var(--ink)',
          }}
          aria-label="Manage subscription"
        >
          <span className="inline-flex items-center gap-2">
            <Settings size={14} style={{ color: 'var(--ink-muted)' }} />
            Manage subscription
          </span>
          <ChevronRight size={14} style={{ color: 'var(--ink-muted)' }} />
        </button>
      </section>

      {/* Post-download steps */}
      <section className="px-5 pb-10" style={{ borderTop: '1px solid var(--cream-line)' }}>
        <h3 className="pt-8 text-[16px] font-medium mb-4 flex items-center gap-2" style={{ color: 'var(--ink)' }}>
          <BookOpen size={14} style={{ color: 'var(--accent)' }} /> After downloading
        </h3>
        <ol className="space-y-3">
          {POST_DOWNLOAD_STEPS.map((step, i) => (
            <li key={i} className="flex items-start gap-3 text-[13.5px]" style={{ color: 'var(--ink-soft)' }}>
              <span
                className="text-[10px] font-bold tabular-nums px-1.5 py-0.5 rounded shrink-0 mt-0.5"
                style={{ background: 'var(--cream-soft)', color: 'var(--accent)' }}
              >
                {i + 1}
              </span>
              <span style={{ lineHeight: 1.6 }}>{step}</span>
            </li>
          ))}
        </ol>
      </section>

      {/* Tutorials secondary action */}
      <section className="px-5 pb-10">
        <button
          onClick={() => setView('tutorials')}
          className="ios-press w-full inline-flex items-center justify-center gap-2 py-3.5 rounded-full text-[14px] font-medium"
          style={{ background: 'var(--cream-soft)', border: '1px solid var(--cream-line)', color: 'var(--ink)' }}
        >
          <BookOpen size={14} /> View tutorials
        </button>
      </section>

      <div style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 24px)' }} />

      {/* Account bottom-sheet */}
      {showAccountSheet && (
        <>
          <div
            className="ios-fade-enter"
            onClick={() => setShowAccountSheet(false)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 40,
              background: 'rgba(20, 20, 19, 0.42)',
              backdropFilter: 'blur(2px)',
              WebkitBackdropFilter: 'blur(2px)',
            }}
          />
          <div
            className="ios-sheet-enter"
            style={{
              position: 'fixed',
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 41,
              background: 'var(--cream)',
              borderTopLeftRadius: 22,
              borderTopRightRadius: 22,
              paddingBottom: 'max(env(safe-area-inset-bottom), 18px)',
              boxShadow: '0 -10px 40px rgba(20, 20, 19, 0.08)',
              borderTop: '1px solid var(--cream-line)',
            }}
          >
            <div className="flex justify-center pt-3 pb-2">
              <div style={{ width: 38, height: 5, borderRadius: 999, background: 'var(--cream-line)' }} />
            </div>
            <div className="px-2 pt-2 pb-4">
              {currentUser && (
                <div className="px-4 py-3 mb-2">
                  <div className="text-[12px]" style={{ color: 'var(--ink-muted)' }}>Signed in as</div>
                  <div className="text-[15px] font-medium mt-0.5 truncate" style={{ color: 'var(--ink)' }}>
                    {currentUser.email}
                  </div>
                </div>
              )}
              <button
                onClick={() => {
                  setShowAccountSheet(false);
                  // Defer to let the account sheet's exit animation land
                  // before the profile sheet's entrance starts — without
                  // this stagger the two animations interrupt each other.
                  window.setTimeout(() => setProfileSheetOpen(true), 360);
                }}
                className="ios-press w-full text-left px-5 py-4 rounded-2xl text-[15px] font-medium"
                style={{ color: 'var(--ink)' }}
              >
                Profile
              </button>
              {currentUser && licenseService.isDeveloper(currentUser.email) && (
                <button
                  onClick={() => { setShowAccountSheet(false); setView('admin'); }}
                  className="ios-press w-full text-left px-5 py-4 rounded-2xl text-[15px] font-medium"
                  style={{ color: 'var(--ink)' }}
                >
                  Admin
                </button>
              )}
              <button
                onClick={() => {
                  setShowAccountSheet(false);
                  // Defer the plan-sheet open until the account sheet's exit
                  // animation has settled — overlapping sheet animations
                  // cause one to interrupt the other and produce a visible
                  // jank. 360ms is .ios-fade-exit (220) + a small buffer.
                  window.setTimeout(() => setPlanSheetOpen(true), 360);
                }}
                className="ios-press w-full text-left px-5 py-4 rounded-2xl text-[15px] font-medium"
                style={{ color: 'var(--ink)' }}
              >
                Plan &amp; billing
              </button>
              <button
                onClick={() => { setShowAccountSheet(false); setView('tutorials'); }}
                className="ios-press w-full text-left px-5 py-4 rounded-2xl text-[15px] font-medium"
                style={{ color: 'var(--ink)' }}
              >
                Tutorials
              </button>
              <button
                onClick={() => { setShowAccountSheet(false); setView('docs'); }}
                className="ios-press w-full text-left px-5 py-4 rounded-2xl text-[15px] font-medium"
                style={{ color: 'var(--ink)' }}
              >
                Documentation
              </button>
              <button
                onClick={() => { setShowAccountSheet(false); handleLogout(); }}
                className="ios-press w-full text-left px-5 py-4 rounded-2xl text-[15px] font-medium"
                style={{ color: 'var(--accent)' }}
              >
                Sign out
              </button>
            </div>
          </div>
        </>
      )}

      {/* Profile sheet — identity surface (display name, email, sign-in
          method, country, member since). Editable name flows through
          licenseService.updateProfile which mirrors into localStorage; we
          surface the new user via setCurrentUser so tier badges, account
          sheets, and AI prompts all see the change immediately. */}
      <ProfileSheetMobile
        open={profileSheetOpen}
        onClose={() => setProfileSheetOpen(false)}
        currentUser={currentUser}
        setCurrentUser={setCurrentUser}
        currentLicense={currentLicense}
        geo={geo}
        onLogout={handleLogout}
        onOpenPlanSheet={() => setPlanSheetOpen(true)}
        onOpenDocs={onOpenDocs}
      />

      {/* Plan & billing sheet — every switch path lives here. Opening it
          closes the account sheet first (see the Account Plan&billing
          handler above) so we never have two sheets stacked. Cancel from
          inside this sheet bridges to the Razorpay confirm sheet below via
          onRequestCancel. */}
      <PlanSheetMobile
        open={planSheetOpen}
        onClose={() => setPlanSheetOpen(false)}
        currentUser={currentUser}
        currentLicense={currentLicense}
        geo={geo}
        pricing={pricing}
        paymentLoading={paymentLoading}
        paymentError={paymentError}
        paymentSuccess={paymentSuccess}
        initiateCheckout={initiateCheckout}
        initiateRenewal={initiateRenewal}
        handleManageSubscription={handleManageSubscription}
        onRequestCancel={() => setCancelConfirm(true)}
        basicExpiryLabel={basicExpiryLabel}
      />

      {/* Cancel-subscription confirm bottom sheet (Razorpay/India only) */}
      {cancelConfirm && (
        <>
          <div
            className="ios-fade-enter"
            onClick={() => setCancelConfirm(false)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 50,
              background: 'rgba(20, 20, 19, 0.42)',
              backdropFilter: 'blur(2px)',
              WebkitBackdropFilter: 'blur(2px)',
            }}
          />
          <div
            className="ios-sheet-enter"
            style={{
              position: 'fixed',
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 51,
              background: 'var(--cream)',
              borderTopLeftRadius: 22,
              borderTopRightRadius: 22,
              paddingBottom: 'max(env(safe-area-inset-bottom), 18px)',
              boxShadow: '0 -10px 40px rgba(20, 20, 19, 0.08)',
              borderTop: '1px solid var(--cream-line)',
            }}
          >
            <div className="flex justify-center pt-3 pb-2">
              <div style={{ width: 38, height: 5, borderRadius: 999, background: 'var(--cream-line)' }} />
            </div>
            <div className="px-5 pt-4 pb-4">
              <h3
                className="text-[20px] mb-2"
                style={{ fontFamily: 'var(--serif)', fontWeight: 500, letterSpacing: '-0.02em', color: 'var(--ink)' }}
              >
                Cancel subscription?
              </h3>
              <p className="text-[13.5px] mb-5" style={{ color: 'var(--ink-soft)', lineHeight: 1.55 }}>
                Your plan stays active until the end of the current billing cycle. You won't be charged again after that, and you can resubscribe any time.
              </p>
              <div className="flex flex-col gap-2.5">
                <button
                  onClick={handleCancelSubscription}
                  className="ios-press w-full py-3.5 rounded-full text-[14.5px] font-medium"
                  style={{ background: 'var(--accent)', color: 'var(--cream)' }}
                >
                  Cancel at cycle end
                </button>
                <button
                  onClick={() => setCancelConfirm(false)}
                  className="ios-press w-full py-3.5 rounded-full text-[14.5px] font-medium"
                  style={{ background: 'var(--cream-soft)', border: '1px solid var(--cream-line)', color: 'var(--ink)' }}
                >
                  Keep subscription
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PROFILE — MOBILE
//
//  iPhone-feel user-profile sheet. Top-tier-app pattern (Anthropic / xAI /
//  Apple ID): hero card with avatar + name + email, iOS Settings cells for
//  details, single "Save" affordance that only appears when dirty, sign-out
//  at the bottom. Editable fields go through licenseService.updateProfile
//  which posts to PUT /api/v1/auth/profile and mirrors the response into
//  localStorage so every consumer sees the new name immediately — tier
//  badges, account sheet, AI prompts that interpolate the candidate name.
//
//  Read-only fields show context the user CAN'T change here for a reason:
//  email is the primary identifier (changing requires support); country
//  drives billing region (UI-changeable would be a price-arbitrage vector
//  flagged in the server payments.js comment); sign-in method shows whether
//  they came in via Google or password.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface ProfileSheetMobileProps {
  open: boolean;
  onClose: () => void;
  currentUser: UserProfile | null;
  setCurrentUser: (user: UserProfile | null) => void;
  currentLicense: LicenseData | null;
  geo: GeoData | null;
  onLogout: () => void;
  onOpenPlanSheet: () => void;
  // Optional: open the documentation surface ON TOP of this profile
  // sheet (rather than navigating away). Passed by SubscriptionGateInner
  // so signed-in users can read product + (for admins) engineering docs
  // without leaving their profile context. If not provided, the
  // documentation card is hidden.
  onOpenDocs?: () => void;
}

// Coarse country-code → display-name map. Covers the top markets we see in
// telemetry. Falls through to the raw code for anything else (rather than
// "Unknown") so the user always sees something meaningful.
const COUNTRY_NAME: Record<string, string> = {
  US: 'United States', IN: 'India', GB: 'United Kingdom', CA: 'Canada',
  AU: 'Australia', DE: 'Germany', FR: 'France', NL: 'Netherlands',
  SG: 'Singapore', AE: 'United Arab Emirates', BR: 'Brazil', MX: 'Mexico',
  JP: 'Japan', KR: 'South Korea', IE: 'Ireland', ES: 'Spain', IT: 'Italy',
  SE: 'Sweden', NO: 'Norway', DK: 'Denmark', FI: 'Finland', NZ: 'New Zealand',
  CH: 'Switzerland', AT: 'Austria', BE: 'Belgium', PL: 'Poland', PT: 'Portugal',
  IL: 'Israel', ZA: 'South Africa', PH: 'Philippines', ID: 'Indonesia',
  TH: 'Thailand', VN: 'Vietnam', TR: 'Turkey', AR: 'Argentina', CL: 'Chile',
};

// Stable color hash for the initials avatar — same email always renders in
// the same color so users recognize their own avatar across sessions.
const AVATAR_COLORS = [
  { bg: 'rgba(245, 158, 11, 0.18)', fg: '#b45309' }, // amber
  { bg: 'rgba(59, 130, 246, 0.18)', fg: '#1d4ed8' }, // blue
  { bg: 'rgba(16, 185, 129, 0.18)', fg: '#047857' }, // emerald
  { bg: 'rgba(168, 85, 247, 0.18)', fg: '#7c3aed' }, // purple
  { bg: 'rgba(236, 72, 153, 0.18)', fg: '#be185d' }, // pink
  { bg: 'rgba(20, 184, 166, 0.18)', fg: '#0f766e' }, // teal
];

function avatarColorFor(seed: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

const ProfileSheetMobile: React.FC<ProfileSheetMobileProps> = ({
  open, onClose, currentUser, setCurrentUser, currentLicense, geo,
  onLogout, onOpenPlanSheet, onOpenDocs,
}) => {
  // Sheet open/close state machine — same pattern as PlanSheetMobile so the
  // exit animation lands before the node unmounts.
  const [shouldRender, setShouldRender] = useState(open);
  const [isClosing, setIsClosing] = useState(false);
  const [draftName, setDraftName] = useState(currentUser?.name || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [signOutConfirm, setSignOutConfirm] = useState(false);

  // Open/close state machine. Crucially does NOT depend on currentUser.name —
  // when name updates after a successful save, this effect must NOT re-run
  // and reset saveSuccess to false; otherwise the "Profile saved" emerald
  // banner vanishes the instant the new name lands in parent state.
  useEffect(() => {
    if (open) {
      setShouldRender(true);
      setIsClosing(false);
      // Re-seed the draft from current state every time we transition from
      // closed → open. Without this, a user who edits → cancels → re-opens
      // would see their abandoned edit. We use a ref-style read of the name
      // via a separate effect below so this dep stays stable.
      setError(null);
      setSaveSuccess(false);
    } else if (shouldRender) {
      setIsClosing(true);
      const t = window.setTimeout(() => {
        setShouldRender(false);
        setIsClosing(false);
      }, 320);
      return () => window.clearTimeout(t);
    }
  }, [open, shouldRender]);

  // Re-seed draftName ONLY on the closed → open transition. Tracking the
  // previous open value via ref prevents the seed from re-firing when
  // currentUser.name updates (post-save) while the sheet is still open.
  const prevOpenRef = useRef(open);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setDraftName(currentUser?.name || '');
    }
    prevOpenRef.current = open;
  }, [open, currentUser?.name]);

  // Defensive close if somehow open was set without a current user. Done
  // inside an effect (not during render) so we don't trigger React's
  // "setState during render" warning. Real-world this should never happen
  // — every open call site checks currentUser first — but the guard is
  // cheap insurance.
  useEffect(() => {
    if (open && !currentUser) onClose();
  }, [open, currentUser, onClose]);

  useEffect(() => {
    if (!shouldRender) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shouldRender, onClose]);

  if (!shouldRender) return null;
  if (!currentUser) return null;

  const trimmedDraft = draftName.trim();
  const isDirty = trimmedDraft !== (currentUser.name || '').trim();
  const isValid = trimmedDraft.length > 0 && trimmedDraft.length <= 100;
  const canSave = isDirty && isValid && !saving;

  const initials = (() => {
    const source = currentUser.name || currentUser.email || '?';
    const parts = source.trim().split(/\s+/).slice(0, 2);
    return parts.map(p => p[0]?.toUpperCase()).filter(Boolean).join('') || '?';
  })();
  const palette = avatarColorFor(currentUser.email || currentUser.id || 'x');
  const hasGooglePhoto = currentUser.oauth_provider === 'google' && !!currentUser.avatar_url;

  const memberSince = currentUser.created_at
    ? new Date(currentUser.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : '—';
  const signInMethod = currentUser.oauth_provider === 'google' ? 'Google' : 'Email & password';
  const countryDisplay = (() => {
    const code = currentUser.country_code || geo?.country_code || '';
    if (!code) return '—';
    return COUNTRY_NAME[code] ? `${COUNTRY_NAME[code]} (${code})` : code;
  })();

  const tierMeta = tierMetaForPlanSheet(currentLicense?.tier || 'free');

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setSaveSuccess(false);
    try {
      const updated = await licenseService.updateProfile({ name: trimmedDraft });
      setCurrentUser(updated);
      setSaveSuccess(true);
      // Self-clear the success affordance after a moment so it doesn't stick
      // around once the user has registered the change.
      window.setTimeout(() => setSaveSuccess(false), 2400);
    } catch (e: any) {
      setError(e?.message || 'Could not save profile');
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setDraftName(currentUser.name || '');
    setError(null);
  };

  return (
    <>
      <div
        className={isClosing ? 'ios-fade-exit' : 'ios-fade-enter'}
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 70,
          background: 'rgba(20, 20, 19, 0.32)',
        }}
      />
      <div
        className={isClosing ? 'ios-sheet-exit' : 'ios-sheet-enter'}
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          top: 0,
          zIndex: 71,
          background: 'var(--cream)',
          color: 'var(--ink)',
          fontFamily: 'var(--sans)',
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch' as any,
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Profile"
      >
        {/* Top bar */}
        <div
          className="sticky top-0 z-10 backdrop-blur-md pt-safe"
          style={{
            background: 'color-mix(in oklab, var(--cream) 92%, transparent)',
            borderBottom: '1px solid var(--cream-line)',
          }}
        >
          <div className="flex items-center justify-between px-3" style={{ height: 56 }}>
            <button
              onClick={isDirty ? handleDiscard : onClose}
              className="ios-press inline-flex items-center px-3 py-2 text-[15px]"
              style={{ color: 'var(--ink)' }}
            >
              {isDirty ? 'Discard' : 'Done'}
            </button>
            <div className="text-[15px] font-medium" style={{ color: 'var(--ink)' }}>
              Profile
            </div>
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="ios-press inline-flex items-center justify-center px-3 py-2 text-[15px] font-semibold disabled:opacity-40"
              style={{ color: canSave ? 'var(--accent)' : 'var(--ink-faint)', minWidth: 64 }}
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : 'Save'}
            </button>
          </div>
        </div>

        {/* Hero — avatar + name + email + tier */}
        <section className="px-5 pt-9 pb-4 text-center">
          <div className="flex justify-center mb-4">
            {hasGooglePhoto ? (
              <img
                src={currentUser.avatar_url}
                alt=""
                referrerPolicy="no-referrer"
                style={{
                  width: 88,
                  height: 88,
                  borderRadius: 999,
                  border: '1px solid var(--cream-line)',
                  background: 'var(--cream-soft)',
                  objectFit: 'cover',
                }}
              />
            ) : (
              <div
                className="flex items-center justify-center"
                style={{
                  width: 88,
                  height: 88,
                  borderRadius: 999,
                  background: palette.bg,
                  color: palette.fg,
                  border: '1px solid var(--cream-line)',
                  fontFamily: 'var(--serif)',
                  fontSize: 32,
                  fontWeight: 500,
                  letterSpacing: '-0.01em',
                }}
              >
                {initials}
              </div>
            )}
          </div>
          <h2
            className="text-[26px] leading-[1.1] mb-1"
            style={{ fontFamily: 'var(--serif)', fontWeight: 500, letterSpacing: '-0.02em' }}
          >
            {currentUser.name || 'Your profile'}
          </h2>
          <p className="text-[13.5px]" style={{ color: 'var(--ink-muted)' }}>
            {currentUser.email}
          </p>
          {/* Tier chip — tappable, opens Plan sheet so the user can switch.
              Same chip-for-chip relationship as Apple's "Apple ID → iCloud +
              Subscriptions" pattern, where the upper-level identity surface
              hands off to the billing surface. */}
          <button
            onClick={onOpenPlanSheet}
            className="ios-press inline-flex items-center gap-2 mt-4 px-3 py-1.5 rounded-full text-[12.5px] font-medium"
            style={{
              background: tierMeta.bg,
              color: tierMeta.color,
              border: tierMeta.label === 'Free' ? '1px solid var(--cream-line)' : 'none',
            }}
          >
            {tierMeta.label === 'Free' ? <Sparkles size={11} /> : tierMeta.label === 'Max' ? <WizardHat size={11} /> : <Crown size={11} />}
            {tierMeta.label} plan
            <ChevronRight size={11} style={{ opacity: 0.7 }} />
          </button>
        </section>

        {/* Inline banners */}
        {error && (
          <section className="px-5 pt-3">
            <div
              className="flex items-start gap-2 px-4 py-3 rounded-2xl text-[13px]"
              style={{
                background: 'color-mix(in oklab, var(--accent) 10%, transparent)',
                border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)',
                color: 'var(--accent)',
              }}
            >
              <AlertTriangle size={14} style={{ marginTop: 1, flexShrink: 0 }} /> {error}
            </div>
          </section>
        )}
        {saveSuccess && !error && (
          <section className="px-5 pt-3">
            <div
              role="status"
              aria-live="polite"
              className="flex items-start gap-2 px-4 py-3 rounded-2xl text-[13px]"
              style={{
                background: 'rgba(16, 185, 129, 0.12)',
                border: '1px solid rgba(16, 185, 129, 0.35)',
                color: '#047857',
              }}
            >
              <Check size={14} style={{ marginTop: 1, flexShrink: 0 }} /> Profile saved
            </div>
          </section>
        )}

        {/* Editable details — iOS grouped cells */}
        <section className="px-5 pt-7">
          <div className="px-1 mb-3 text-[11px] font-medium uppercase tracking-[0.18em]" style={{ color: 'var(--ink-muted)' }}>
            Account
          </div>
          <div
            style={{
              background: 'var(--cream-soft)',
              border: '1px solid var(--cream-line)',
              borderRadius: 16,
              overflow: 'hidden',
            }}
          >
            {/* Display name — editable */}
            <div className="px-4 pt-3 pb-3">
              <label className="text-[10.5px] uppercase tracking-[0.18em] block mb-0.5" style={{ color: 'var(--ink-muted)' }}>
                Display name
              </label>
              <input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="Your name"
                className="block w-full text-[16px] bg-transparent outline-none"
                style={{ color: 'var(--ink)', minHeight: 24 }}
                maxLength={100}
                autoComplete="name"
              />
              <div className="flex items-center justify-between mt-1.5">
                <p className="text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                  Used in your interview answers and our support chat.
                </p>
                <span className="text-[10.5px] tabular-nums" style={{ color: trimmedDraft.length > 100 ? 'var(--accent)' : 'var(--ink-faint)' }}>
                  {trimmedDraft.length}/100
                </span>
              </div>
            </div>

            {/* Email — readonly */}
            <div className="h-px mx-4" style={{ background: 'var(--cream-line)' }} />
            <div className="px-4 pt-3 pb-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <label className="text-[10.5px] uppercase tracking-[0.18em] block mb-0.5" style={{ color: 'var(--ink-muted)' }}>
                  Email
                </label>
                <div className="text-[15px] truncate" style={{ color: 'var(--ink)' }}>{currentUser.email}</div>
              </div>
              <span className="text-[11px] shrink-0" style={{ color: 'var(--ink-faint)' }}>Contact support to change</span>
            </div>

            {/* Sign-in method — readonly */}
            <div className="h-px mx-4" style={{ background: 'var(--cream-line)' }} />
            <div className="px-4 pt-3 pb-3">
              <label className="text-[10.5px] uppercase tracking-[0.18em] block mb-0.5" style={{ color: 'var(--ink-muted)' }}>
                Sign-in method
              </label>
              <div className="flex items-center gap-2 text-[15px]" style={{ color: 'var(--ink)' }}>
                {currentUser.oauth_provider === 'google' && (
                  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                  </svg>
                )}
                {signInMethod}
              </div>
            </div>

            {/* Country (region) — readonly */}
            <div className="h-px mx-4" style={{ background: 'var(--cream-line)' }} />
            <div className="px-4 pt-3 pb-3">
              <label className="text-[10.5px] uppercase tracking-[0.18em] block mb-0.5" style={{ color: 'var(--ink-muted)' }}>
                Region · billing
              </label>
              <div className="text-[15px]" style={{ color: 'var(--ink)' }}>{countryDisplay}</div>
              <p className="text-[11px] mt-1" style={{ color: 'var(--ink-faint)' }}>
                Drives your local pricing. Contact support to change.
              </p>
            </div>

            {/* Member since — readonly */}
            <div className="h-px mx-4" style={{ background: 'var(--cream-line)' }} />
            <div className="px-4 pt-3 pb-3">
              <label className="text-[10.5px] uppercase tracking-[0.18em] block mb-0.5" style={{ color: 'var(--ink-muted)' }}>
                Member since
              </label>
              <div className="text-[15px]" style={{ color: 'var(--ink)' }}>{memberSince}</div>
            </div>
          </div>
        </section>

        {/* Plan link */}
        <section className="px-5 pt-7">
          <div className="px-1 mb-3 text-[11px] font-medium uppercase tracking-[0.18em]" style={{ color: 'var(--ink-muted)' }}>
            Subscription
          </div>
          <button
            onClick={onOpenPlanSheet}
            className="ios-press w-full text-left flex items-center gap-3 px-4 py-3.5 rounded-2xl"
            style={{
              background: 'var(--cream-soft)',
              border: '1px solid var(--cream-line)',
            }}
          >
            <div
              className="shrink-0 w-11 h-11 rounded-2xl flex items-center justify-center"
              style={{ background: tierMeta.bg }}
            >
              {currentLicense?.tier === 'max'
                ? <WizardHat size={20} style={{ color: tierMeta.color }} />
                : currentLicense?.tier === 'pro'
                ? <Crown size={20} style={{ color: tierMeta.color }} />
                : <Zap size={20} style={{ color: tierMeta.color }} />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[15px] font-medium" style={{ color: 'var(--ink)' }}>
                Plan &amp; billing
              </div>
              <div className="text-[12.5px] mt-0.5" style={{ color: 'var(--ink-muted)' }}>
                Currently on {tierMeta.label}. Switch, upgrade, or cancel.
              </div>
            </div>
            <ChevronRight size={16} style={{ color: 'var(--ink-muted)' }} />
          </button>
        </section>

        {/* Documentation link — opens docs ON TOP of the profile sheet
            (when onOpenDocs is provided) so closing returns the user to
            their profile instead of dumping them on the marketing
            landing. Public docs visible to everyone; engineering docs
            section auto-appears for admins (server gates per-request
            via detectSession role check). */}
        {onOpenDocs && (
          <section className="px-5 pt-5">
            <div className="px-1 mb-3 text-[11px] font-medium uppercase tracking-[0.18em]" style={{ color: 'var(--ink-muted)' }}>
              Documentation
            </div>
            <button
              onClick={onOpenDocs}
              className="ios-press w-full text-left flex items-center gap-3 px-4 py-3.5 rounded-2xl"
              style={{
                background: 'var(--cream-soft)',
                border: '1px solid var(--cream-line)',
              }}
            >
              <div
                className="shrink-0 w-11 h-11 rounded-2xl flex items-center justify-center"
                style={{ background: 'rgba(168, 85, 247, 0.14)' }}
              >
                <FileText size={20} style={{ color: '#7c3aed' }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[15px] font-medium" style={{ color: 'var(--ink)' }}>
                  Docs &amp; guides
                </div>
                <div className="text-[12.5px] mt-0.5" style={{ color: 'var(--ink-muted)' }}>
                  Getting started, features, FAQ, troubleshooting, privacy{currentUser?.email && licenseService.isDeveloper(currentUser.email) ? ' — and admin/internal docs' : ''}.
                </div>
              </div>
              <ChevronRight size={16} style={{ color: 'var(--ink-muted)' }} />
            </button>
          </section>
        )}

        {/* Sign out */}
        <section className="px-5 pt-7 pb-2">
          {!signOutConfirm ? (
            <button
              onClick={() => setSignOutConfirm(true)}
              className="ios-press w-full text-center px-5 py-3.5 rounded-2xl text-[15px] font-medium"
              style={{
                background: 'var(--cream-soft)',
                border: '1px solid var(--cream-line)',
                color: 'var(--accent)',
              }}
            >
              Sign out
            </button>
          ) : (
            <div
              className="rounded-2xl p-4"
              style={{
                background: 'color-mix(in oklab, var(--accent) 8%, transparent)',
                border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)',
              }}
            >
              <p className="text-[13.5px] mb-3" style={{ color: 'var(--ink)', lineHeight: 1.5 }}>
                Sign out of this device? You can sign back in any time with the same email.
              </p>
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => { onLogout(); onClose(); }}
                  className="ios-press w-full py-3 rounded-full text-[14.5px] font-medium"
                  style={{ background: 'var(--accent)', color: 'var(--cream)' }}
                >
                  Yes, sign out
                </button>
                <button
                  onClick={() => setSignOutConfirm(false)}
                  className="ios-press w-full py-3 rounded-full text-[14.5px] font-medium"
                  style={{ background: 'var(--cream)', border: '1px solid var(--cream-line)', color: 'var(--ink)' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>

        <div style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 32px)' }} />
      </div>
    </>
  );
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PLAN & BILLING — MOBILE
//
//  Browser-mobile equivalent of ManageSubscription.tsx (which is
//  Electron-only). Users get a single, friction-free surface to:
//    • see their current plan + status + provider + expiry
//    • upgrade / switch / downgrade across all valid paths
//    • renew Basic +1h
//    • open Stripe Customer Portal (Stripe users)
//    • cancel via Razorpay self-cancel (Indian users)
//
//  Routing rules — every action goes through the same handlers
//  SubscriptionGate already uses, so server endpoints stay untouched:
//    Free → Basic / Pro / Max     → initiateCheckout(tier)  [/create-checkout]
//    Basic → Renew                → initiateRenewal()       [/create-renewal]
//    Basic → Pro / Max            → initiateCheckout(tier)  [/create-checkout — new sub]
//    Pro → Max (in-place)         → initiateCheckout('max') [/upgrade-tier — detected]
//    Max → Pro (downgrade)        → initiateCheckout('pro') [/upgrade-tier — detected]
//    Stripe paid → "Manage"       → handleManageSubscription() [Stripe Portal]
//    Razorpay paid → "Cancel"     → onRequestCancel() — opens existing cancel sheet
//
//  Provider detection: fetches /subscription on open (authoritative — the
//  server reads it from stripe_customer_id prefix). Falls back to geo
//  while loading (geo.country_code === 'IN' → razorpay).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Env-aware: dev (vite) → localhost:4000, prod build → api.minicaai.com.
// Was hardcoded to prod, which caused every plan-sheet fetch in dev to
// hit production with a local JWT and silently fail.
const API_BASE_PLAN = (import.meta as any).env?.PROD
  ? 'https://api.minicaai.com'
  : ((import.meta as any).env?.VITE_SERVER_URL || 'https://api.minicaai.com');

interface PlanSheetMobileProps {
  open: boolean;
  onClose: () => void;
  currentUser: UserProfile | null;
  currentLicense: LicenseData | null;
  geo: GeoData | null;
  pricing: RegionPricing | null;
  paymentLoading: boolean;
  paymentError: string | null;
  paymentSuccess: string | null;
  initiateCheckout: (tier?: 'basic' | 'pro' | 'max') => Promise<void> | void;
  initiateRenewal: () => Promise<void> | void;
  handleManageSubscription: () => Promise<void> | void;
  onRequestCancel: () => void;
  basicExpiryLabel: (expiresAt: number | undefined | null) => string | null;
}

interface PlanRow {
  key: string;
  Icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  iconBg: string;
  iconColor: string;
  title: string;
  subtitle: string;
  price?: string;
  effective?: string;
  variant?: 'default' | 'primary';
  onClick: () => Promise<void> | void;
}

function tierMetaForPlanSheet(tier: string) {
  switch (tier) {
    case 'max':   return { label: 'Max',   bg: 'rgba(245, 158, 11, 0.12)', color: '#b45309', accent: '#d97706' };
    case 'pro':   return { label: 'Pro',   bg: 'rgba(59, 130, 246, 0.12)', color: '#1d4ed8', accent: '#2563eb' };
    case 'basic': return { label: 'Basic', bg: 'rgba(16, 185, 129, 0.12)', color: '#047857', accent: '#059669' };
    default:      return { label: 'Free',  bg: 'var(--cream-soft)',         color: 'var(--ink-muted)', accent: 'var(--ink-muted)' };
  }
}

const PlanSheetMobile: React.FC<PlanSheetMobileProps> = ({
  open, onClose, currentUser, currentLicense, geo, pricing,
  paymentLoading, paymentError, paymentSuccess,
  initiateCheckout, initiateRenewal, handleManageSubscription,
  onRequestCancel, basicExpiryLabel,
}) => {
  // Shouldn't-render-but-still-animate dance: when `open` flips false we
  // hold the node in the tree just long enough for .ios-sheet-exit to play,
  // then drop it.
  const [shouldRender, setShouldRender] = useState(open);
  const [isClosing, setIsClosing] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<{
    provider?: 'stripe' | 'razorpay' | null;
    tier?: string;
    status?: string;
    expires_at?: number;
  } | null>(null);

  useEffect(() => {
    if (open) {
      setShouldRender(true);
      setIsClosing(false);
    } else if (shouldRender) {
      setIsClosing(true);
      const t = window.setTimeout(() => {
        setShouldRender(false);
        setIsClosing(false);
      }, 320);
      return () => window.clearTimeout(t);
    }
  }, [open, shouldRender]);

  // Fetch live status when opening — provider is the load-bearing field
  // (drives Stripe-Portal vs Razorpay-Cancel choice). We tolerate failure
  // (network/auth blip) by falling through to geo-based inference below.
  useEffect(() => {
    if (!open || !currentUser) return;
    let cancelled = false;
    (async () => {
      try {
        const token = licenseService.getToken();
        if (!token) return;
        const res = await fetch(`${API_BASE_PLAN}/api/v1/payments/subscription`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setServerStatus(data);
      } catch { /* fall through */ }
    })();
    return () => { cancelled = true; };
  }, [open, currentUser]);

  useEffect(() => {
    if (!shouldRender) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shouldRender, onClose]);

  if (!shouldRender) return null;

  // Effective tier resolution — admin always renders as Max so the sheet
  // shows the same buttons / state ManageSubscription does for admins.
  const isAdminUser = !!currentUser && licenseService.isDeveloper(currentUser.email);
  const tier = (isAdminUser ? 'max' : (currentLicense?.tier || 'free')) as 'free' | 'basic' | 'pro' | 'max';
  const status = currentLicense?.status || 'none';

  // Provider — server is authoritative; geo is a fallback during the brief
  // window before /subscription resolves.
  const provider: 'stripe' | 'razorpay' | null =
    (serverStatus?.provider as any) ||
    (geo?.country_code === 'IN' ? 'razorpay' : 'stripe');
  const isStripe = provider === 'stripe';
  const isRazorpay = provider === 'razorpay';

  const tierMeta = tierMetaForPlanSheet(tier);

  // Resolve display price for a given tier from the regional pricing payload.
  // Returns null if pricing hasn't loaded — rows guard against null below.
  const findTierPrice = (id: 'basic' | 'pro' | 'max'): string | null => {
    const t = pricing?.tiers.find(x => x.id === id);
    if (!t) return null;
    const period = t.period === 'month' ? '/mo' : t.period === 'year' ? '/yr' : '';
    return pricingService.formatPrice(t.price, t.currencySymbol, t.currency) + period;
  };

  const renewalPriceLabel = (() => {
    if (!geo) return null;
    const r = pricingService.getBasicRenewalPrice(geo.country_code || 'US');
    return pricingService.formatPrice(r.price, r.currencySymbol, r.currency);
  })();

  const wrapAction = (key: string, fn: () => Promise<void> | void) => async () => {
    if (paymentLoading || pendingAction) return;
    setPendingAction(key);
    try {
      await fn();
    } finally {
      setPendingAction(null);
    }
  };

  // Build the action list per current tier. Order: most-likely-target first
  // (matches Anthropic / xAI ergonomics — primary action up top).
  const actions: PlanRow[] = [];

  if (tier === 'free') {
    const proPrice = findTierPrice('pro');
    const maxPrice = findTierPrice('max');
    const basicTier = pricing?.tiers.find(t => t.id === 'basic');
    const basicPrice = basicTier ? pricingService.formatPrice(basicTier.price, basicTier.currencySymbol, basicTier.currency) : null;

    actions.push({
      key: 'upgrade-pro',
      Icon: Crown, iconBg: 'rgba(59, 130, 246, 0.12)', iconColor: '#2563eb',
      title: 'Upgrade to Pro',
      subtitle: 'Unlimited time · 4 AI models · Pop-out · Auto-Solve',
      price: proPrice || undefined,
      variant: 'primary',
      onClick: wrapAction('upgrade-pro', () => initiateCheckout('pro')),
    });
    actions.push({
      key: 'upgrade-max',
      Icon: WizardHat, iconBg: 'rgba(245, 158, 11, 0.12)', iconColor: '#b45309',
      title: 'Upgrade to Max',
      subtitle: 'Pro + Claude Sonnet 4.6 + Auto-Type + Train Model',
      price: maxPrice || undefined,
      onClick: wrapAction('upgrade-max', () => initiateCheckout('max')),
    });
    if (basicTier) {
      actions.push({
        key: 'upgrade-basic',
        Icon: Zap, iconBg: 'rgba(16, 185, 129, 0.12)', iconColor: '#047857',
        title: 'Get Basic',
        subtitle: '3 hours · 14-day window · GPT, Grok, Llama (no Claude)',
        price: basicPrice || undefined,
        onClick: wrapAction('upgrade-basic', () => initiateCheckout('basic')),
      });
    }
  }

  if (tier === 'basic') {
    actions.push({
      key: 'renew',
      Icon: Zap, iconBg: 'rgba(16, 185, 129, 0.12)', iconColor: '#047857',
      title: 'Renew · +1 hour',
      subtitle: 'Adds another hour of session time',
      price: renewalPriceLabel || undefined,
      variant: 'primary',
      onClick: wrapAction('renew', () => initiateRenewal()),
    });
    actions.push({
      key: 'upgrade-pro',
      Icon: Crown, iconBg: 'rgba(59, 130, 246, 0.12)', iconColor: '#2563eb',
      title: 'Upgrade to Pro',
      subtitle: 'Unlimited time, no expiry · keep your remaining Basic hours',
      price: findTierPrice('pro') || undefined,
      onClick: wrapAction('upgrade-pro', () => initiateCheckout('pro')),
    });
    actions.push({
      key: 'upgrade-max',
      Icon: WizardHat, iconBg: 'rgba(245, 158, 11, 0.12)', iconColor: '#b45309',
      title: 'Upgrade to Max',
      subtitle: 'Adds Claude, Auto-Type, Train Model',
      price: findTierPrice('max') || undefined,
      onClick: wrapAction('upgrade-max', () => initiateCheckout('max')),
    });
  }

  if (tier === 'pro' && !isAdminUser) {
    actions.push({
      key: 'upgrade-max',
      Icon: WizardHat, iconBg: 'rgba(245, 158, 11, 0.12)', iconColor: '#b45309',
      title: 'Upgrade to Max',
      subtitle: 'Adds Claude + Auto-Type + Train Model',
      price: findTierPrice('max') || undefined,
      effective: 'Effective immediately · prorated diff next invoice',
      variant: 'primary',
      onClick: wrapAction('upgrade-max', () => initiateCheckout('max')),
    });
  }

  if (tier === 'max' && !isAdminUser) {
    actions.push({
      key: 'downgrade-pro',
      Icon: Crown, iconBg: 'rgba(59, 130, 246, 0.12)', iconColor: '#2563eb',
      title: 'Switch to Pro',
      subtitle: 'Removes Claude + Auto-Type + Train Model',
      price: findTierPrice('pro') || undefined,
      effective: 'Effective at next renewal · keep Max access until then',
      onClick: wrapAction('downgrade-pro', () => initiateCheckout('pro')),
    });
  }

  // Admin actions — admin users can instant-grant themselves any tier
  // via /upgrade-tier (server short-circuits to grantAdminTier for
  // ADMIN_EMAILS callers, bypassing Stripe/Razorpay payment). Without
  // these rows the plan sheet shows only the hero card for admin —
  // perceived as a near-empty / "marketing-landing-ish" surface.
  //
  // We call /upgrade-tier directly here (not initiateCheckout) because
  // for free/basic targets the in-place-vs-checkout branching in
  // initiateCheckout falls through to /create-checkout, which doesn't
  // accept those targets. /upgrade-tier with admin bypass handles all
  // four targets in one round-trip.
  const adminGrant = async (target: 'pro' | 'max' | 'basic' | 'free') => {
    const token = licenseService.getToken();
    if (!token) return;
    try {
      const r = await fetch(`${API_BASE_PLAN}/api/v1/payments/upgrade-tier`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: target }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.license) {
        // Mirror new license into client state via licenseService so the
        // tier badge + plan sheet refresh immediately.
        const saved = licenseService.loadAuth();
        if (saved.user) {
          licenseService.saveAuth(
            { ...saved.user, tier: (data.tier || target) as any },
            { ...data.license, last_validated: Date.now() },
          );
        }
        // Re-fetch live status in this sheet too so the hero card flips.
        try {
          const sub = await fetch(`${API_BASE_PLAN}/api/v1/payments/subscription`, {
            headers: { 'Authorization': `Bearer ${token}` },
          });
          if (sub.ok) {
            const sd = await sub.json();
            setServerStatus(sd);
          }
        } catch { /* refresh failure is OK; reload picks it up */ }
      }
    } catch { /* network error — surface via paymentError eventually */ }
  };

  if (isAdminUser) {
    const adminTargets: Array<{ key: 'pro' | 'max' | 'basic' | 'free'; title: string; subtitle: string; Icon: any; iconBg: string; iconColor: string }> = [
      { key: 'max',   title: 'Switch to Max (admin)',   subtitle: 'Claude + Auto-Type + Train Model. Instant grant, no checkout.',                       Icon: WizardHat, iconBg: 'rgba(245, 158, 11, 0.12)', iconColor: '#b45309' },
      { key: 'pro',   title: 'Switch to Pro (admin)',   subtitle: 'Unlimited time + 4 models (no Claude). Instant grant, no checkout.',                 Icon: Crown,     iconBg: 'rgba(59, 130, 246, 0.12)', iconColor: '#2563eb' },
      { key: 'basic', title: 'Switch to Basic (admin)', subtitle: '3 sessions / 14 days. Instant grant, no checkout — admin override.',                  Icon: Zap,       iconBg: 'rgba(16, 185, 129, 0.12)', iconColor: '#047857' },
      { key: 'free',  title: 'Switch to Free (admin)',  subtitle: 'Drop to Free with 5 sessions/month default. Instant grant, no checkout.',             Icon: Sparkles,  iconBg: 'var(--cream-soft)',        iconColor: 'var(--ink-muted)' },
    ];
    for (const a of adminTargets) {
      actions.push({
        key: `admin-grant-${a.key}`,
        Icon: a.Icon, iconBg: a.iconBg, iconColor: a.iconColor,
        title: a.title,
        subtitle: a.subtitle,
        onClick: wrapAction(`admin-grant-${a.key}`, () => adminGrant(a.key)),
      });
    }
  }

  // Manage section — Stripe portal vs Razorpay cancel.
  const showStripeManage = (tier === 'pro' || tier === 'max') && !isAdminUser && isStripe;
  const showRazorpayCancel = (tier === 'pro' || tier === 'max') && !isAdminUser && isRazorpay;

  return (
    <>
      <div
        className={isClosing ? 'ios-fade-exit' : 'ios-fade-enter'}
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 60,
          background: 'rgba(20, 20, 19, 0.32)',
        }}
      />
      <div
        className={isClosing ? 'ios-sheet-exit' : 'ios-sheet-enter'}
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          top: 0,
          zIndex: 61,
          background: 'var(--cream)',
          color: 'var(--ink)',
          fontFamily: 'var(--sans)',
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch' as any,
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Plan and billing"
      >
        {/* Top bar */}
        <div
          className="sticky top-0 z-10 backdrop-blur-md pt-safe"
          style={{
            background: 'color-mix(in oklab, var(--cream) 92%, transparent)',
            borderBottom: '1px solid var(--cream-line)',
          }}
        >
          <div className="flex items-center justify-between px-3" style={{ height: 56 }}>
            <div style={{ width: 36 }} />
            <div className="text-[15px] font-medium" style={{ color: 'var(--ink)' }}>
              Plan &amp; billing
            </div>
            <button
              onClick={onClose}
              className="ios-press w-9 h-9 -mr-1 flex items-center justify-center"
              aria-label="Close"
              style={{ color: 'var(--ink)' }}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Hero — current plan card */}
        <section className="px-5 pt-6 pb-2">
          <div
            className="rounded-3xl p-5"
            style={{
              background: tierMeta.bg,
              border: `1px solid ${tier === 'free' ? 'var(--cream-line)' : 'transparent'}`,
              color: 'var(--ink)',
            }}
          >
            <div className="flex items-start gap-4">
              <div
                className="shrink-0 w-12 h-12 rounded-2xl flex items-center justify-center"
                style={{ background: 'var(--cream)', border: '1px solid var(--cream-line)' }}
              >
                {tier === 'max' ? (
                  <WizardHat size={22} style={{ color: tierMeta.color }} />
                ) : tier === 'pro' ? (
                  <Crown size={22} style={{ color: tierMeta.color }} />
                ) : tier === 'basic' ? (
                  <Zap size={22} style={{ color: tierMeta.color }} />
                ) : (
                  <Sparkles size={22} style={{ color: tierMeta.color }} />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3
                    className="text-[20px]"
                    style={{
                      fontFamily: 'var(--serif)',
                      fontWeight: 500,
                      letterSpacing: '-0.015em',
                      color: tierMeta.color,
                    }}
                  >
                    {isAdminUser ? 'Admin · Max' : tierMeta.label}
                  </h3>
                  <span
                    className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded"
                    style={{
                      background: 'var(--cream)',
                      color: 'var(--ink-muted)',
                      border: '1px solid var(--cream-line)',
                    }}
                  >
                    {status === 'active' ? 'Active' : status === 'trial' ? 'Trial' : status === 'expired' ? 'Expired' : status === 'revoked' ? 'Revoked' : 'Free'}
                  </span>
                  {provider && tier !== 'free' && !isAdminUser && (
                    <span
                      className="text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded"
                      style={{
                        background: 'var(--cream)',
                        color: 'var(--ink-muted)',
                        border: '1px solid var(--cream-line)',
                      }}
                    >
                      {provider === 'stripe' ? 'Stripe' : 'Razorpay'}
                    </span>
                  )}
                </div>
                {tier === 'basic' && currentLicense && basicExpiryLabel(currentLicense.expires_at) && (
                  <div className="flex items-center gap-1 text-[12.5px] mt-2" style={{ color: 'var(--ink-soft)' }}>
                    <Clock size={11} />
                    {basicExpiryLabel(currentLicense.expires_at)}
                  </div>
                )}
                {(tier === 'pro' || tier === 'max') && currentLicense?.expires_at && currentLicense.expires_at > 0 && !isAdminUser && (
                  <div className="text-[12.5px] mt-2" style={{ color: 'var(--ink-soft)' }}>
                    Renews {new Date(currentLicense.expires_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  </div>
                )}
                {tier === 'free' && (
                  <p className="text-[13px] mt-1.5" style={{ color: 'var(--ink-soft)', lineHeight: 1.5 }}>
                    5 sessions / month · Gemini only.
                  </p>
                )}
                {currentUser && (
                  <p className="text-[12px] mt-2 truncate" style={{ color: 'var(--ink-faint)' }}>
                    {currentUser.email}
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Banners */}
        {paymentError && (
          <section className="px-5 pt-3">
            <div
              className="flex items-start gap-2 px-4 py-3 rounded-2xl text-[13px]"
              style={{
                background: 'color-mix(in oklab, var(--accent) 10%, transparent)',
                border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)',
                color: 'var(--accent)',
              }}
            >
              <AlertTriangle size={14} style={{ marginTop: 1, flexShrink: 0 }} /> {paymentError}
            </div>
          </section>
        )}
        {paymentSuccess && (
          <section className="px-5 pt-3">
            <div
              className="flex items-start gap-2 px-4 py-3 rounded-2xl text-[13px]"
              style={{
                background: 'rgba(16, 185, 129, 0.12)',
                border: '1px solid rgba(16, 185, 129, 0.35)',
                color: '#047857',
              }}
            >
              <Check size={14} style={{ marginTop: 1, flexShrink: 0 }} /> {paymentSuccess}
            </div>
          </section>
        )}

        {/* Available plans / actions */}
        {actions.length > 0 && (
          <section className="px-5 pt-7">
            <div className="px-1 mb-3 text-[11px] font-medium uppercase tracking-[0.18em]" style={{ color: 'var(--ink-muted)' }}>
              Available plans
            </div>
            <div
              style={{
                background: 'var(--cream-soft)',
                border: '1px solid var(--cream-line)',
                borderRadius: 18,
                overflow: 'hidden',
              }}
            >
              {actions.map((a, i) => {
                const Icon = a.Icon;
                const inFlight = pendingAction === a.key;
                const dimmed = (paymentLoading || !!pendingAction) && !inFlight;
                return (
                  <React.Fragment key={a.key}>
                    {i > 0 && <div className="h-px ml-16" style={{ background: 'var(--cream-line)' }} />}
                    <button
                      onClick={a.onClick}
                      disabled={paymentLoading || !!pendingAction}
                      className="ios-press w-full text-left flex items-center gap-3 px-4 py-3.5"
                      style={{
                        opacity: dimmed ? 0.5 : 1,
                        background: a.variant === 'primary' ? 'rgba(20, 20, 19, 0.025)' : 'transparent',
                      }}
                    >
                      <div
                        className="shrink-0 w-11 h-11 rounded-2xl flex items-center justify-center"
                        style={{ background: a.iconBg }}
                      >
                        <Icon size={20} style={{ color: a.iconColor }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[15px] font-medium truncate" style={{ color: 'var(--ink)' }}>
                            {a.title}
                          </span>
                          {a.price && (
                            <span className="text-[13px] tabular-nums shrink-0" style={{ color: 'var(--ink-soft)' }}>
                              {a.price}
                            </span>
                          )}
                        </div>
                        <div className="text-[12.5px] mt-0.5" style={{ color: 'var(--ink-muted)', lineHeight: 1.45 }}>
                          {a.subtitle}
                        </div>
                        {a.effective && (
                          <div className="text-[11.5px] mt-1" style={{ color: 'var(--ink-faint)' }}>
                            {a.effective}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 flex items-center justify-center" style={{ width: 18, color: 'var(--ink-muted)' }}>
                        {inFlight ? <Loader2 size={16} className="animate-spin" /> : <ChevronRight size={16} />}
                      </div>
                    </button>
                  </React.Fragment>
                );
              })}
            </div>
          </section>
        )}

        {/* Manage section */}
        {(showStripeManage || showRazorpayCancel) && (
          <section className="px-5 pt-7">
            <div className="px-1 mb-3 text-[11px] font-medium uppercase tracking-[0.18em]" style={{ color: 'var(--ink-muted)' }}>
              Manage
            </div>
            <div
              style={{
                background: 'var(--cream-soft)',
                border: '1px solid var(--cream-line)',
                borderRadius: 18,
                overflow: 'hidden',
              }}
            >
              {showStripeManage && (
                <button
                  onClick={wrapAction('manage', () => handleManageSubscription())}
                  disabled={paymentLoading || !!pendingAction}
                  className="ios-press w-full text-left flex items-center gap-3 px-4 py-3.5"
                  style={{ opacity: (paymentLoading || pendingAction) && pendingAction !== 'manage' ? 0.5 : 1 }}
                >
                  <div
                    className="shrink-0 w-11 h-11 rounded-2xl flex items-center justify-center"
                    style={{ background: 'var(--cream)', border: '1px solid var(--cream-line)' }}
                  >
                    <ExternalLink size={18} style={{ color: 'var(--ink)' }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[15px] font-medium" style={{ color: 'var(--ink)' }}>
                      Manage in Stripe
                    </div>
                    <div className="text-[12.5px] mt-0.5" style={{ color: 'var(--ink-muted)', lineHeight: 1.45 }}>
                      Update card, view invoices, change billing cycle, cancel
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center justify-center" style={{ width: 18, color: 'var(--ink-muted)' }}>
                    {pendingAction === 'manage' ? <Loader2 size={16} className="animate-spin" /> : <ChevronRight size={16} />}
                  </div>
                </button>
              )}
              {showRazorpayCancel && (
                <>
                  {showStripeManage && <div className="h-px ml-16" style={{ background: 'var(--cream-line)' }} />}
                  <button
                    onClick={() => { onClose(); window.setTimeout(() => onRequestCancel(), 360); }}
                    disabled={paymentLoading || !!pendingAction}
                    className="ios-press w-full text-left flex items-center gap-3 px-4 py-3.5"
                  >
                    <div
                      className="shrink-0 w-11 h-11 rounded-2xl flex items-center justify-center"
                      style={{ background: 'color-mix(in oklab, var(--accent) 10%, transparent)' }}
                    >
                      <XCircle size={18} style={{ color: 'var(--accent)' }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[15px] font-medium" style={{ color: 'var(--accent)' }}>
                        Cancel subscription
                      </div>
                      <div className="text-[12.5px] mt-0.5" style={{ color: 'var(--ink-muted)', lineHeight: 1.45 }}>
                        Keep access through your current cycle, then stop
                      </div>
                    </div>
                    <ChevronRight size={16} style={{ color: 'var(--ink-muted)' }} />
                  </button>
                </>
              )}
            </div>
          </section>
        )}

        {/* Footer */}
        <section className="px-5 pt-8 pb-2 text-center">
          <div className="flex items-center justify-center gap-3 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
            <PhLock size={11} weight="duotone" />
            <span>
              Payments secured by {isStripe ? 'Stripe' : isRazorpay ? 'Razorpay' : 'our payment partners'}
            </span>
          </div>
          <div className="flex items-center justify-center gap-3 text-[12px] mt-2" style={{ color: 'var(--ink-muted)' }}>
            <a
              href="mailto:support@minicaai.com"
              className="ios-press"
              style={{ color: 'var(--ink-muted)' }}
            >
              Contact support
            </a>
            <span aria-hidden style={{ color: 'var(--ink-faint)' }}>·</span>
            <a
              href="https://minicaai.com/refund-policy"
              target="_blank"
              rel="noopener noreferrer"
              className="ios-press"
              style={{ color: 'var(--ink-muted)' }}
            >
              Refund policy
            </a>
          </div>
        </section>

        <div style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 32px)' }} />
      </div>
    </>
  );
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SUPPORT — MOBILE (live WebSocket chat)
//
//  Full-screen iPhone-feel chat. Cream surface, iOS-Messages-style bubbles
//  (squared tail-corner toward sender, rounded everywhere else), bottom-
//  anchored input bar that respects safe-area-inset-bottom, and proper
//  iOS soft-keyboard handling via VisualViewport API — when the keyboard
//  slides up, the chat container's height shrinks to match the visible
//  area so the input bar lifts above the keyboard instead of being
//  covered by it.
//
//  Mirrors the desktop view's WebSocket lifecycle exactly: welcome agent
//  message + ws connect on first mount (guarded by chatMessages.length
//  === 0); send appends + ws.send if connected; close clears messages +
//  closes ws + navigates back to landing.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface SupportMobileProps {
  setView: (v: View) => void;
  currentUser: UserProfile;  // dispatch ensures non-null before mount
  chatMessages: Array<{ from: 'user' | 'agent'; text: string; time: string }>;
  setChatMessages: React.Dispatch<React.SetStateAction<Array<{ from: 'user' | 'agent'; text: string; time: string }>>>;
  chatInput: string;
  setChatInput: (s: string) => void;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
  chatWsRef: React.MutableRefObject<WebSocket | null>;
}

const SupportMobile: React.FC<SupportMobileProps> = ({
  setView, currentUser, chatMessages, setChatMessages,
  chatInput, setChatInput, chatEndRef, chatWsRef,
}) => {
  const [isClosing, setIsClosing] = useState(false);
  // visualViewport.height — shrinks when soft keyboard opens. We pin the
  // chat container height to this so the bottom input bar lifts above the
  // keyboard. Falls back to 100vh on browsers without VisualViewport
  // (Safari < 13, very old Android Chrome) — those users get the desktop-
  // ish experience where the input bar can be obscured by the keyboard.
  const [vvHeight, setVvHeight] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const update = () => setVvHeight(window.visualViewport!.height);
    update();
    window.visualViewport.addEventListener('resize', update);
    window.visualViewport.addEventListener('scroll', update);
    return () => {
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, []);

  // When the keyboard opens, scroll the latest message into view so it isn't
  // hidden behind the now-shorter messages region.
  useEffect(() => {
    if (vvHeight === null) return;
    const t = window.setTimeout(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 80);
    return () => window.clearTimeout(t);
  }, [vvHeight, chatEndRef]);

  // First-mount init: welcome message + ws connect. Same guard the desktop
  // uses (chatMessages.length === 0) so re-mounts within the same parent
  // session don't re-greet or open a duplicate ws. The cleanup-on-unmount
  // is handled by dismiss() and the re-open guard, mirroring desktop.
  useEffect(() => {
    if (chatMessages.length > 0) return;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setChatMessages([{
      from: 'agent',
      text: `Hi ${currentUser.name || 'there'}! I'm Minica, your support agent. How can I help you today?`,
      time,
    }]);
    const serverUrl = import.meta.env.PROD ? 'https://api.minicaai.com' : (import.meta.env.VITE_SERVER_URL || 'https://api.minicaai.com');
    const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws/support';
    try {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join', user: currentUser.email, name: currentUser.name }));
      };
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'message') {
            const msgTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            setChatMessages(prev => [...prev, { from: 'agent', text: data.text, time: msgTime }]);
            window.setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
          }
        } catch { /* ignore malformed frames */ }
      };
      ws.onerror = () => { /* swallow — onclose will follow */ };
      ws.onclose = () => { /* no auto-reconnect (matches desktop behavior) */ };
      chatWsRef.current = ws;
    } catch {
      // ws constructor threw — likely blocked by CSP or invalid URL.
      // We still leave the welcome message; user just can't send messages
      // until they reload.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendMessage = () => {
    const text = chatInput.trim();
    if (!text) return;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setChatMessages(prev => [...prev, { from: 'user', text, time }]);
    setChatInput('');
    if (chatWsRef.current?.readyState === WebSocket.OPEN) {
      chatWsRef.current.send(JSON.stringify({ type: 'message', text, user: currentUser.email }));
    }
    window.setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  };

  const dismiss = useCallback(() => {
    if (isClosing) return;
    setIsClosing(true);
    window.setTimeout(() => {
      if (chatWsRef.current) {
        try { chatWsRef.current.close(); } catch { /* already closed */ }
        chatWsRef.current = null;
      }
      setChatMessages([]);
      setView('landing');
    }, 320);
  }, [isClosing, chatWsRef, setChatMessages, setView]);

  // Esc to close — desktop dev-tools mobile emulation aid.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismiss]);

  return (
    <div
      className={isClosing ? 'ios-sheet-exit' : 'ios-sheet-enter'}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: vvHeight ? `${vvHeight}px` : '100vh',
        background: 'var(--cream)',
        color: 'var(--ink)',
        fontFamily: 'var(--sans)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* App-bar — back button left, agent identity centered. iOS Messages
          puts the contact info center-aligned in the title; we mirror that. */}
      <div
        className="pt-safe shrink-0"
        style={{
          background: 'color-mix(in oklab, var(--cream) 92%, transparent)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderBottom: '1px solid var(--cream-line)',
        }}
      >
        <div className="flex items-center px-3" style={{ height: 56 }}>
          <button
            onClick={dismiss}
            className="ios-press w-9 h-9 -ml-1 flex items-center justify-center"
            aria-label="Close support"
            style={{ color: 'var(--ink)' }}
          >
            <ArrowLeft size={19} />
          </button>
          <div className="flex-1 flex items-center justify-center gap-2.5">
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
              style={{
                background: 'linear-gradient(135deg, #34d399, #059669)',
                boxShadow: '0 2px 8px rgba(5, 150, 105, 0.18)',
              }}
            >
              <Headphones size={16} className="text-white" />
            </div>
            <div className="flex flex-col items-start">
              <div className="text-[14.5px] font-medium leading-tight" style={{ color: 'var(--ink)' }}>Minica</div>
              <div className="flex items-center gap-1 text-[10.5px] leading-none mt-0.5" style={{ color: '#059669' }}>
                <span
                  className="w-1.5 h-1.5 rounded-full animate-pulse"
                  style={{ background: '#10b981' }}
                />
                Live · Support
              </div>
            </div>
          </div>
          {/* Right-side spacer matches the back button's width so the agent
              identity stays optically centered. */}
          <div style={{ width: 36 }} />
        </div>
      </div>

      {/* Messages — flex-1 so it absorbs all leftover height. Chat scrolls
          here, not the outer container, so the input bar stays anchored. */}
      <div
        className="flex-1 overflow-y-auto px-4 py-4"
        style={{ WebkitOverflowScrolling: 'touch' as any }}
      >
        <div className="max-w-3xl mx-auto" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {chatMessages.map((msg, i) => {
            const prev = chatMessages[i - 1];
            const showTime = !prev || prev.from !== msg.from || prev.time !== msg.time;
            const isUser = msg.from === 'user';
            return (
              <div key={i} className="animate-in" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                  <div
                    style={{
                      maxWidth: '80%',
                      padding: '9px 14px',
                      borderRadius: 22,
                      // iOS bubble tail: corner toward sender slightly squared.
                      borderBottomRightRadius: isUser ? 6 : 22,
                      borderBottomLeftRadius:  isUser ? 22 : 6,
                      background: isUser ? 'var(--ink)' : 'var(--cream-soft)',
                      color: isUser ? 'var(--cream)' : 'var(--ink)',
                      border: isUser ? 'none' : '1px solid var(--cream-line)',
                    }}
                  >
                    <p className="text-[14.5px]" style={{ lineHeight: 1.4, margin: 0 }}>{msg.text}</p>
                  </div>
                </div>
                {showTime && (
                  <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} px-2`}>
                    <span className="text-[10px]" style={{ color: 'var(--ink-faint)' }}>{msg.time}</span>
                  </div>
                )}
              </div>
            );
          })}
          <div ref={chatEndRef} />
        </div>
      </div>

      {/* Input bar — anchored to bottom of the flex container. Bottom padding
          uses safe-area-inset so the home indicator never sits on the input.
          font-size: 16px on the input is critical — anything below triggers
          iOS Safari's auto-zoom-on-focus, which jumps the layout. */}
      <div
        className="shrink-0"
        style={{
          background: 'color-mix(in oklab, var(--cream) 96%, transparent)',
          borderTop: '1px solid var(--cream-line)',
          paddingBottom: 'max(env(safe-area-inset-bottom), 12px)',
          paddingTop: 12,
          paddingLeft: 12,
          paddingRight: 12,
        }}
      >
        <form
          onSubmit={(e) => { e.preventDefault(); sendMessage(); }}
          className="flex items-center gap-2 max-w-3xl mx-auto"
        >
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder="Message"
            className="flex-1 px-4 py-3 rounded-full text-[16px] outline-none"
            style={{
              background: 'var(--cream-soft)',
              border: '1px solid var(--cream-line)',
              color: 'var(--ink)',
            }}
            inputMode="text"
            enterKeyHint="send"
          />
          <button
            type="submit"
            disabled={!chatInput.trim()}
            className="ios-press w-11 h-11 rounded-full flex items-center justify-center disabled:opacity-40 shrink-0"
            style={{ background: 'var(--ink)', color: 'var(--cream)' }}
            aria-label="Send message"
          >
            <Send size={16} />
          </button>
        </form>
      </div>
    </div>
  );
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MAIN GATE COMPONENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const SubscriptionGateInner: React.FC<SubscriptionGateProps> = ({ onAuthenticated }) => {
  // Initial view: respect the URL on first paint so a deep-link to
  // /docs (or /docs/<slug>) doesn't briefly flash the landing page.
  // We only honor /docs paths — the rest of the app is single-route at
  // / so we don't try to URL-sync views like /login, /pricing, etc.
  const initialView: View = useMemo(() => {
    if (typeof window === 'undefined') return 'landing';
    const p = window.location.pathname;
    if (p === '/docs' || p.startsWith('/docs/')) return 'docs';
    return 'landing';
  }, []);
  const [view, setView] = useState<View>(initialView);

  // ── URL ↔ view sync for /docs ─────────────────────────────────
  // Only the docs surface gets a real URL; everything else stays at /.
  // pushState on enter/leave so the browser back button takes the user
  // from /docs back to /. Documentation itself manages /docs/<slug>
  // refinement via replaceState so doc switches don't pollute history.
  useEffect(() => {
    const onPop = () => {
      const p = window.location.pathname;
      if (p === '/docs' || p.startsWith('/docs/')) {
        setView('docs');
      } else if (p === '/' || p === '') {
        // Only override if we were on /docs — don't stomp on
        // auth-flow transitions that share the / URL.
        setView((prev) => (prev === 'docs' ? 'landing' : prev));
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    const path = window.location.pathname;
    const onDocs = path === '/docs' || path.startsWith('/docs/');
    if (view === 'docs' && !onDocs) {
      window.history.pushState(null, '', '/docs');
    } else if (view !== 'docs' && onDocs) {
      window.history.pushState(null, '', '/');
    }
  }, [view]);

  // iPhone-feel landing on phones; desktop landing unchanged. Flips live on
  // window resize / orientation change so DevTools mobile-emulation toggles
  // and tablet rotations Just Work.
  const isMobile = useIsMobile();
  // Desktop profile sheet — opened from the /download nav's email click.
  // Mobile uses its own copy inside DownloadMobile; desktop drives this
  // top-level state so the cream-themed full-screen sheet can present over
  // the dark /download page like a proper iOS modal.
  const [desktopProfileOpen, setDesktopProfileOpen] = useState(false);
  // Web Manage Subscription modal — opens the same in-app billing UI
  // (cancel / reactivate / tier-swap / refund policy / profile) used by
  // the Electron desktop chat-header. Without this, web users had no
  // path to manage their subscription besides the Stripe Customer Portal,
  // which doesn't surface the cancel-pending state or expose Reactivate.
  const [webManageSubOpen, setWebManageSubOpen] = useState(false);
  // Web Documentation modal — opens the same Documentation component
  // used as a /docs view, but as an OVERLAY on top of the profile
  // sheet. Without this, the docs link inside the profile would have
  // to navigate the view to 'docs' which closes the profile and dumps
  // the user on the docs page; closing docs then drops them on landing
  // (because that view's onClose is setView('landing')). User reported:
  // "to read them I have to come out of my profile they are not inside
  // my profile". Rendering Documentation as a z-200 modal lets us keep
  // the profile sheet mounted underneath, so closing the docs returns
  // to the still-open profile cleanly. Documentation already uses
  // createPortal with z-[200] (modals at z-[210]) so it sits above the
  // profile sheet's zIndex 41 without any extra wrapper.
  const [webDocsOpen, setWebDocsOpen] = useState(false);
  const [geo, setGeo] = useState<GeoData | null>(null);
  const [pricing, setPricing] = useState<RegionPricing | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Auth form
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Google sign-in lives on its own loading flag so clicking "Continue with
  // Google" doesn't make the regular email/password Sign-in button also
  // appear to be loading. The shared isSubmitting was the source of the
  // "both buttons are loading at the same time" confusion in v3.4.4.
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  // When the system browser fails to open (shell.openExternal rejects/hangs),
  // we surface the auth URL so the user can copy it and finish sign-in
  // manually. Cleared when sign-in resolves or is cancelled.
  const [googleManualUrl, setGoogleManualUrl] = useState<string | null>(null);
  const [googleUrlCopied, setGoogleUrlCopied] = useState(false);
  // Aborts the in-flight Google poll without unmounting (mountedRef would
  // also need a remount to recover). Set to true by the Cancel button; the
  // poll loop checks it on every tick.
  const googlePollAbortRef = useRef(false);
  const [forgotSent, setForgotSent] = useState(false);

  // Authenticated user (for download/dashboard views)
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [currentLicense, setCurrentLicense] = useState<LicenseData | null>(null);

  // Payment state
  const [selectedProUpgrade, setSelectedProUpgrade] = useState(false);
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  // Which tier the user clicked on the pricing card. Persisted across
  // signup → checkout transitions (otherwise a non-authenticated user
  // clicking Max would sign up and then get routed through a Pro checkout).
  const [pendingCheckoutTier, setPendingCheckoutTier] = useState<'basic' | 'pro' | 'max'>('pro');
  // What the user just paid for / was just granted. Survives webhook lag:
  // when the Stripe webhook hasn't landed by the time we render /download,
  // currentLicense.tier may still be 'free' — we'd otherwise drop the user
  // onto the generic "Upgrade to Pro" card immediately after they bought
  // Max. Hydrated at boot from localStorage('justPurchasedTier') so a
  // refresh of the success page also lands on the right card.
  const [lastSuccessfulTier, setLastSuccessfulTier] = useState<string | null>(() => {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem('justPurchasedTier') : null; } catch { return null; }
  });
  // If a webhook downgrades the user mid-session (refund, cancel processed
  // immediately, comp revoked) the success banner would otherwise still claim
  // "Pro Active" until next reload. Compare ranks: when the live license tier
  // drops below what we cached as "just purchased", clear the cache so the UI
  // catches up. We only clear on a strict downgrade — webhook lag in the
  // upgrade direction is handled elsewhere by displaying the cached tier.
  useEffect(() => {
    if (!lastSuccessfulTier) return;
    if (!currentLicense) return;
    const rank: Record<string, number> = { free: 0, basic: 1, pro: 2, max: 3 };
    const liveRank = rank[String(currentLicense.tier).toLowerCase()] ?? 0;
    const cachedRank = rank[String(lastSuccessfulTier).toLowerCase()] ?? 0;
    if (liveRank < cachedRank) {
      try { localStorage.removeItem('justPurchasedTier'); } catch {}
      setLastSuccessfulTier(null);
      // Clear the success banner too — it's misleading when the tier just
      // got pulled out from under us. Tier chip will reflect the new state
      // independently via currentLicense.
      setPaymentSuccess(null);
    }
  }, [currentLicense?.tier, lastSuccessfulTier]);
  // Flips true after handleSignup resolves so the /download view can show
  // a first-time welcome banner to Starter users. Cleared when the banner
  // is dismissed or a successful payment replaces it.
  const [justSignedUp, setJustSignedUp] = useState(false);
  // Success banner — replaces native alert() after Razorpay verify. Native
  // alerts paint outside Electron's setContentProtection and leak on screen
  // share. Self-clears after 6s; tier chip flips to <Tier> Active independently.
  const [paymentSuccess, setPaymentSuccess] = useState<string | null>(null);
  const paymentSuccessTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (paymentSuccessTimerRef.current !== null) {
      window.clearTimeout(paymentSuccessTimerRef.current);
    }
  }, []);
  const surfacePaymentSuccess = (msg: string) => {
    setPaymentSuccess(msg);
    if (paymentSuccessTimerRef.current !== null) window.clearTimeout(paymentSuccessTimerRef.current);
    paymentSuccessTimerRef.current = window.setTimeout(() => {
      paymentSuccessTimerRef.current = null;
      setPaymentSuccess(null);
    }, 6000);
  };

  // Tier-aware welcome copy. Called from both providers so the message
  // matches the tier the user actually paid for, not a hardcoded "Pro".
  const welcomeForTier = (tier: string | undefined | null): string => {
    switch (tier) {
      case 'basic':
        return 'Payment successful — 3 interview credits unlocked (valid 14 days).';
      case 'pro':
        // Pro does NOT include Claude (that's Max-exclusive). Saying "all
        // models" was a long-running copy bug that promised something
        // Pro doesn't deliver. The honest line lists what's actually new
        // vs. Free / Basic without naming Claude.
        return 'Payment successful — Pro activated. Unlimited sessions, GPT-5.5, Grok, and Llama unlocked.';
      case 'max':
        return 'Payment successful — Max activated. Claude Sonnet 4.6, Auto-Type, and everything in Pro is now live.';
      default:
        return 'Payment successful — your plan is active.';
    }
  };

  // Renewal (Basic +1 credit / +1 hour) gets its own banner — saying
  // "3 credits unlocked (14 days)" after a $6.99 renewal would be a lie.
  const welcomeForRenewal = (): string =>
    'Renewal successful — 1 extra interview unlocked (1 hour added to your plan).';

  // "Expires in N days" / "Expires today" / "Expired" subtitle for the
  // Basic tier chip. Returns null for unlimited (Pro/Max, expires_at=-1)
  // or missing values.
  const basicExpiryLabel = (expiresAt: number | undefined | null): string | null => {
    if (!expiresAt || expiresAt === -1) return null;
    const msLeft = expiresAt - Date.now();
    if (msLeft <= 0) return 'Expired — renew to continue';
    const daysLeft = Math.floor(msLeft / (24 * 60 * 60 * 1000));
    const hoursLeft = Math.floor(msLeft / (60 * 60 * 1000));
    if (daysLeft >= 2) return `Expires in ${daysLeft} days`;
    if (daysLeft === 1) return 'Expires in 1 day';
    if (hoursLeft >= 2) return `Expires in ${hoursLeft} hours`;
    if (hoursLeft === 1) return 'Expires in 1 hour';
    return 'Expires in under 1 hour';
  };

  // Support chat state
  const [chatMessages, setChatMessages] = useState<Array<{ from: 'user' | 'agent'; text: string; time: string }>>([]);
  const [chatInput, setChatInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatWsRef = useRef<WebSocket | null>(null);

  // Tracks whether the gate is still mounted. Guards async callbacks (the
  // Google-OAuth poll in particular) from calling setState after unmount,
  // which leaks React warnings and — more importantly — would let a stale
  // poll write user/license state into a torn-down component.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Initialize ──
  useEffect(() => {
    async function init() {
      setIsLoading(true);

      // If inside Electron, check saved auth and go straight to app
      if (isElectron) {
        const saved = licenseService.loadAuth();
        if (saved.user && saved.license && licenseService.isLicenseValid(saved.license)) {
          // Validate with server (non-blocking for free, blocking for pro)
          if (licenseService.needsRevalidation(saved.license)) {
            const validated = await licenseService.validateWithServer();
            if (validated && licenseService.isLicenseValid(validated)) {
              onAuthenticated(saved.user, validated);
              return;
            } else if (saved.license.tier === 'pro' || saved.license.tier === 'max') {
              // Paid users must validate — lock them out
              licenseService.logout();
              setIsLoading(false);
              return;
            }
          }
          onAuthenticated(saved.user, saved.license);
          return;
        }
        // Not authenticated in Electron — show login
        setIsLoading(false);
        setView('login');

        // Still load geo for pricing
        try {
          const security = await geoService.performSecurityCheck();
          setGeo(security.geo);
          setPricing(pricingService.getPricing(security.country_code));
        } catch { setPricing(pricingService.getPricing('US')); }
        return;
      }

      // Browser: version check
      if (!licenseService.isVersionValid()) {
        setError('This version of minicaai is no longer supported. Please download the latest version');
        setIsLoading(false);
        return;
      }

      // Geo detection + security
      try {
        const security = await geoService.performSecurityCheck();
        setGeo(security.geo);
        if (!security.allowed) {
          setView('vpn_blocked');
          setError(security.reason || 'Access denied');
          setIsLoading(false);
          return;
        }
        setPricing(pricingService.getPricing(security.country_code));
      } catch {
        setPricing(pricingService.getPricing('US'));
      }

      // Restore saved session so refresh stays on the download page instead of login.
      const savedAuth = licenseService.loadAuth();
      if (savedAuth.user && savedAuth.license && licenseService.isLicenseValid(savedAuth.license)) {
        setCurrentUser(savedAuth.user);
        setCurrentLicense(savedAuth.license);
        setView('download');
      }

      // URL-based overrides for incoming deep-links.
      const urlParams = new URLSearchParams(window.location.search);

      // Deep-link from the server-rendered reset-password "Link expired" page:
      // clicking "Request a new reset link" lands here with ?view=forgot_password
      // so the user can re-request without re-navigating through login.
      if (urlParams.get('view') === 'forgot_password') {
        setView('forgot_password');
      }

      // Deep-link from the reset-password success page. The server has
      // already revoked every existing JWT for this user (forceLogoutUser),
      // so any saved auth in this tab's localStorage is now a zombie token.
      // Clear it before we render the login form, otherwise the effect
      // above would leave the user on /download with a dead token until
      // the next API call 401s. `?email=` pre-fills the field so the user
      // just types their new password.
      if (urlParams.get('view') === 'login') {
        licenseService.logout();
        setCurrentUser(null);
        setCurrentLicense(null);
        const prefillEmail = urlParams.get('email');
        if (prefillEmail) setEmail(prefillEmail);
        setView('login');
        // Strip ?view=login&email=… from the address bar. Without this,
        // the email stays visible in the URL (privacy/shareable-link
        // leak), and a refresh re-triggers this block — clobbering any
        // login-in-progress with a fresh logout.
        try {
          window.history.replaceState({}, '', window.location.pathname);
        } catch {}
      }

      if (urlParams.get('payment') === 'success') {
        const saved = licenseService.loadAuth();
        if (saved.user) {
          // Revalidate with server to get updated tier. The webhook may not
          // have landed yet when the user returns from Stripe — fall back to
          // the tier hint we stamped in the success_url so the banner copy
          // still matches what they paid for.
          let validated = await licenseService.validateWithServer();
          const urlTierHint = urlParams.get('tier');
          // `mode=renewal` is stamped on the success URL by /create-renewal.
          // Renewal banners don't advertise "3 credits / 14 days" — they
          // say "1 extra interview / 1 hour" instead.
          const isRenewal = urlParams.get('mode') === 'renewal';
          // Client-side renewal credit grant. Keyed by Stripe session_id so
          // a refresh of the success URL can't grant the same credit twice.
          // Has to happen AFTER validateWithServer (which picks up the
          // server-bumped license.expires_at) so credits_expire_at lines up
          // with the new license window.
          if (isRenewal && validated) {
            const sessionId = urlParams.get('session_id') || '';
            const appliedKey = sessionId ? `mc_renewal_applied_${sessionId}` : '';
            let alreadyApplied = false;
            try { alreadyApplied = !!appliedKey && !!localStorage.getItem(appliedKey); } catch {}
            if (!alreadyApplied) {
              validated = licenseService.grantRenewalCredit(validated);
              if (appliedKey) {
                try { localStorage.setItem(appliedKey, String(Date.now())); } catch {}
              }
            }
          }
          let bannerTier: string | undefined;
          if (validated) {
            setCurrentUser(saved.user);
            setCurrentLicense(validated);
            licenseService.saveAuth({ ...saved.user, tier: validated.tier as any }, validated);
            // Prefer the server tier; if it's still 'free' (webhook lag),
            // optimistically use the URL hint.
            bannerTier = (validated.tier && validated.tier !== 'free')
              ? validated.tier
              : (urlTierHint || validated.tier);
          } else {
            setCurrentUser(saved.user);
            setCurrentLicense(saved.license!);
            bannerTier = urlTierHint || saved.license?.tier;
          }
          setJustSignedUp(false);
          // Persist the tier the user just paid for BEFORE we strip the URL.
          // Without this, a refresh after the URL clean-up loses the hint
          // and the download view falls back to currentLicense.tier — which
          // is still 'free' until the webhook lands, so the user sees
          // "Upgrade to Pro" right after buying Max. Cleared by the user
          // closing the success banner or by a tier-change being confirmed.
          if (!isRenewal && bannerTier && bannerTier !== 'free') {
            try { localStorage.setItem('justPurchasedTier', bannerTier); } catch {}
            setLastSuccessfulTier(bannerTier);
          }
          surfacePaymentSuccess(isRenewal ? welcomeForRenewal() : welcomeForTier(bannerTier));
          setView('download');
          // Clean up URL
          window.history.replaceState({}, '', window.location.pathname);
        }
      }

      setIsLoading(false);
    }
    init();
  }, []);

  // ── Signup handler ──
  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;
    setIsSubmitting(true);
    setAuthError(null);

    try {
      let user: UserProfile, license: LicenseData;
      const result = await licenseService.signup(email.trim(), password, name.trim(), geo?.country_code || 'US');
      user = result.user;
      license = result.license;

      setCurrentUser(user);
      setCurrentLicense(license);
      setJustSignedUp(true);

      if (isElectron) {
        // In Electron, go straight to app
        onAuthenticated(user, license);
      } else if (selectedProUpgrade) {
        // User selected a paid plan on the pricing page — go to checkout
        // with the tier they chose (Basic/Pro/Max). Falls back to Pro if
        // no selection was persisted (shouldn't happen in practice).
        setSelectedProUpgrade(false);
        const tier = pendingCheckoutTier;
        // Small delay to let state settle, then initiate checkout
        setTimeout(() => initiateCheckout(tier), 300);
        setView('download');
      } else {
        // In browser, show download page
        setView('download');
      }
    } catch (err: any) {
      setAuthError(err.message || 'Signup failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Login handler ──
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;
    setIsSubmitting(true);
    setAuthError(null);

    try {
      const result = await licenseService.login(email.trim(), password);
      const user = result.user;
      const license = result.license;

      setCurrentUser(user);
      setCurrentLicense(license);

      if (isElectron) {
        onAuthenticated(user, license);
      } else if (selectedProUpgrade) {
        // Plan-aware redirect: existing user clicked a paid plan on the
        // landing page, hit the auth wall, switched to Login (because they
        // already had an account), and just logged in. Honor their original
        // plan choice and route them straight to checkout — same path
        // signup and Google-OAuth take. Without this branch, returning users
        // got dumped on the download page after login and had to click the
        // plan a second time, which made the funnel feel broken.
        setSelectedProUpgrade(false);
        const tier = pendingCheckoutTier;
        setTimeout(() => initiateCheckout(tier), 300);
        setView('download');
      } else {
        setView('download');
      }
    } catch (err: any) {
      setAuthError(err.message || 'Login failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Forgot password handler ──
  // Server responds the same way whether or not the email is on file, so we
  // always show a generic success message — no account enumeration.
  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setIsSubmitting(true);
    setAuthError(null);

    try {
      // Env-aware so dev hits localhost:4000, prod hits the public URL.
      const viteEnvFp = (import.meta as any).env || {};
      const serverUrl = viteEnvFp.PROD
        ? 'https://api.minicaai.com'
        : (viteEnvFp.VITE_SERVER_URL || 'https://api.minicaai.com');
      const res = await fetch(`${serverUrl}/api/v1/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to send reset email');
      setForgotSent(true);
    } catch (err: any) {
      setAuthError(err.message || 'Failed to send reset email');
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Tier selection ──
  const handleTierSelect = (tier: PricingTier) => {
    if (tier.id === 'free') {
      setSelectedProUpgrade(false);
      setView('signup');
    } else {
      // Paid plan — remember the choice so it survives the signup detour
      // for not-yet-authenticated users. If already logged in, checkout
      // immediately with the chosen tier.
      setPendingCheckoutTier(tier.id);
      if (currentUser) {
        initiateCheckout(tier.id);
      } else {
        setSelectedProUpgrade(true);
        setView('signup');
      }
    }
  };

  // ── Post-checkout polling (Electron desktop flow) ───────────────────
  // When we open Stripe checkout in the system browser instead of taking
  // over the renderer, the renderer never receives Stripe's success_url
  // redirect — that URL loads in the user's browser, not the app. So the
  // app learns about the upgrade through the server: we poll license
  // validation (cheap, already used by the periodic revalidation tick)
  // until the server reflects the new tier, then mirror the SYNC_GRANT
  // path's local-state update so the in-app UI flips without a relaunch.
  //
  // 10-minute cap because most webhooks land in <30s. After that either
  // the user abandoned the browser flow, the webhook stalled, or there's
  // a routing mismatch (rare). We surface a clear "still waiting" message
  // instead of spinning forever — relaunching the app picks up the new
  // license on the next validateWithServer tick regardless.
  const pollForUpgrade = async (targetTier: 'basic' | 'pro' | 'max'): Promise<void> => {
    const POLL_INTERVAL_MS = 4000;
    const POLL_TIMEOUT_MS = 10 * 60 * 1000;
    const startedAt = Date.now();
    return new Promise<void>((resolve) => {
      const tick = async () => {
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          setPaymentError('Still waiting for payment confirmation. If you finished checkout, restart the app to sync your plan.');
          resolve();
          return;
        }
        try {
          const updated = await licenseService.validateWithServer();
          if (updated && updated.tier === targetTier && updated.status === 'active') {
            const baseUser = currentUser || licenseService.loadAuth().user;
            if (baseUser) {
              const updatedUser: UserProfile = { ...baseUser, tier: updated.tier as UserProfile['tier'] };
              setCurrentUser(updatedUser);
              setCurrentLicense(updated);
              licenseService.saveAuth(updatedUser, updated);
              try { localStorage.setItem('justPurchasedTier', updated.tier); } catch {}
              setLastSuccessfulTier(updated.tier);
            }
            surfacePaymentSuccess(welcomeForTier(updated.tier));
            setPendingCheckoutTier('pro');
            setSelectedProUpgrade(false);
            setView('download');
            resolve();
            return;
          }
        } catch { /* network blip — keep polling */ }
        window.setTimeout(tick, POLL_INTERVAL_MS);
      };
      // Initial wait — Stripe's webhook needs a moment after payment.
      window.setTimeout(tick, POLL_INTERVAL_MS);
    });
  };

  // Renewals don't change `tier` — they extend `expires_at` by ~1h via
  // grantBasicRenewal on the server. We watch for a forward delta on the
  // license's expires_at; validateWithServer's renewal-credit propagation
  // path (services/licenseService.ts) lands the +3600s credit locally as
  // soon as the matching delta is detected, so we just refresh React
  // state when it does. 30-min lower bound on the delta absorbs clock
  // skew but stays well above any non-renewal noise.
  const pollForRenewal = async (): Promise<void> => {
    const POLL_INTERVAL_MS = 4000;
    const POLL_TIMEOUT_MS = 10 * 60 * 1000;
    const RENEWAL_THRESHOLD_MS = 30 * 60 * 1000;
    const startedAt = Date.now();
    const baselineExpires = currentLicense?.expires_at || 0;
    return new Promise<void>((resolve) => {
      const tick = async () => {
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          setPaymentError('Still waiting for renewal confirmation. If you finished checkout, restart the app to sync your credits.');
          resolve();
          return;
        }
        try {
          const updated = await licenseService.validateWithServer();
          if (updated && (updated.expires_at || 0) >= baselineExpires + RENEWAL_THRESHOLD_MS) {
            setCurrentLicense(updated);
            surfacePaymentSuccess(welcomeForRenewal());
            resolve();
            return;
          }
        } catch { /* network blip */ }
        window.setTimeout(tick, POLL_INTERVAL_MS);
      };
      window.setTimeout(tick, POLL_INTERVAL_MS);
    });
  };

  // ── Initiate payment checkout (Stripe or Razorpay based on geo) ──
  const initiateCheckout = async (tier: 'basic' | 'pro' | 'max' = pendingCheckoutTier) => {
    setPaymentLoading(true);
    setPaymentError(null);

    try {
      // Region detection must complete before checkout. Without this guard a
      // click before /geo resolves defaults country_code to 'US' below, which
      // routes Indian users to Stripe USD ($29) instead of Razorpay INR
      // (₹2499) — they see ₹2499 in-app, click, then land on Stripe at $29
      // with no INR option. Source of the "wrong currency" bug reports.
      if (!geo) {
        throw new Error('Detecting your region — please try again in a moment.');
      }

      // Retry token fetch — it may not be in localStorage yet after signup
      let token = licenseService.getToken();
      if (!token) {
        await new Promise(r => setTimeout(r, 500));
        token = licenseService.getToken();
      }
      if (!token) throw new Error('Please sign in first to continue checkout');

      const countryCode = geo?.country_code || 'US';

      // ── In-place tier swap on an existing recurring subscription ──
      // If the user is already actively subscribed to Pro or Max and is
      // switching to the OTHER recurring tier, we must update the existing
      // subscription instead of creating a second one. Without this branch
      // a Pro→Max click would spin up a new Stripe sub alongside the old
      // one and the user would be billed twice until support intervened.
      // Anything else (free→paid, expired→paid, basic→paid, same tier)
      // falls through to /create-checkout's normal new-subscription flow.
      const liveTier = currentLicense?.tier;
      const isLiveActive = currentLicense?.status === 'active';
      const isRecurringTier = (t: string | undefined | null): boolean =>
        t === 'pro' || t === 'max';
      const isInPlaceUpgrade =
        isLiveActive &&
        isRecurringTier(liveTier) &&
        isRecurringTier(tier) &&
        liveTier !== tier;

      const endpointPath = isInPlaceUpgrade
        ? '/api/v1/payments/upgrade-tier'
        : '/api/v1/payments/create-checkout';
      // /upgrade-tier doesn't need country_code (provider is determined
      // from the existing subscription's customer record). Sending it
      // anyway is harmless but cleaner to omit.
      const requestBody = isInPlaceUpgrade
        ? { tier }
        : { country_code: countryCode, tier };

      // 30s abort — Railway cold-starts can take 10-15s; past that the user
      // has typically already given up and clicked again. Without this the
      // button spins forever on a stalled socket and users report the app
      // as "stuck".
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 30000);
      let response: Response;
      try {
        response = await fetch(`https://api.minicaai.com${endpointPath}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
      } catch (fetchErr: any) {
        if (fetchErr?.name === 'AbortError') {
          throw new Error('Request timed out. Please check your connection and try again.');
        }
        throw fetchErr;
      } finally {
        window.clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || (isInPlaceUpgrade ? 'Failed to change plan' : 'Failed to create checkout'));
      }

      const data = await response.json();

      // Server-completed grant (no provider redirect needed). Three flavors
      // share this local-state update path: admin self-grant (bypass), and
      // the two in-place plan swaps which already mutated the subscription
      // server-side and updated the license row optimistically.
      const SYNC_GRANT_PROVIDERS = ['admin-grant', 'stripe-upgrade', 'razorpay-upgrade'];
      if (SYNC_GRANT_PROVIDERS.includes(data.provider)) {
        const grantedTier = data.tier || 'pro';
        const saved = licenseService.loadAuth();
        const baseUser = currentUser || saved.user;
        if (baseUser) {
          const updatedUser: UserProfile = { ...baseUser, tier: grantedTier as UserProfile['tier'] };
          let updatedLicense: LicenseData = data.license
            ? { ...(data.license as LicenseData), last_validated: Date.now() }
            : { ...(saved.license || currentLicense)!, tier: grantedTier as LicenseData['tier'], last_validated: Date.now() };
          // Admin-grant + in-place upgrades DO flip tier to 'basic' in some
          // flows (admin self-test, legacy downgrade paths). The server
          // doesn't echo credit fields (Option A ledger), so seed them via
          // validateWithServer's normalize path. Without this, an admin
          // granting themselves Basic would see 0 credits and immediately
          // fall through to Free gating even though tier='basic'.
          if (grantedTier === 'basic' && updatedLicense.credits_remaining_seconds == null) {
            const revalidated = await licenseService.validateWithServer();
            if (revalidated && revalidated.tier === 'basic') {
              updatedLicense = revalidated;
            } else {
              const fallbackExpiry = Date.now() + 14 * 24 * 60 * 60 * 1000;
              updatedLicense = {
                ...updatedLicense,
                credits_remaining_seconds: 3 * 3600,
                credits_expire_at: updatedLicense.expires_at > 0 ? updatedLicense.expires_at : fallbackExpiry,
              };
            }
          }
          setCurrentUser(updatedUser);
          setCurrentLicense(updatedLicense);
          licenseService.saveAuth(updatedUser, updatedLicense);
          // Mirror the post-payment redirect path so the user lands on
          // the tier-specific "X Active" card instead of the "Upgrade" CTA.
          try { localStorage.setItem('justPurchasedTier', grantedTier); } catch {}
          setLastSuccessfulTier(grantedTier);
        }
        // Server provides a tailored message for upgrades (mentions
        // proration / cycle-end timing). Fall back to the generic
        // welcome copy for admin-grant and any future sync provider.
        surfacePaymentSuccess(data.message || welcomeForTier(grantedTier));
        setPendingCheckoutTier('pro');
        setSelectedProUpgrade(false);
        setView('download');
      } else if (data.provider === 'stripe') {
        // Stripe — open hosted checkout. The flow forks on Electron vs web
        // because navigating the renderer (window.location.href) inside a
        // packaged desktop app strands the user on Stripe's success URL
        // when payment completes — that URL is the marketing website, which
        // doesn't share auth state with the Electron app. The user would
        // see "Pro Active" only after relaunching. Instead, on Electron we
        // hand the URL to the system browser and poll the server for the
        // upgrade so the in-app UI updates without a relaunch.
        if (isElectron && window.electronAPI) {
          // Use openExternalRobust — it has shell.openExternal with a 6s
          // timeout race and a child_process `cmd /c start` fallback for
          // when ShellExecuteW silently fails (corrupt default-browser
          // registration, AV interference, OS shell process busy). The
          // legacy openExternal can claim success and yet not actually
          // surface a window — users would see "checkout opened in your
          // browser" with nothing actually opening.
          let opened: { ok: boolean; method?: string } = { ok: false };
          try {
            opened = window.electronAPI.openExternalRobust
              ? await window.electronAPI.openExternalRobust(data.checkout_url)
              : (await window.electronAPI.openExternal(data.checkout_url), { ok: true, method: 'shell.openExternal-legacy' });
          } catch (e) {
            opened = { ok: false };
          }
          if (opened.ok) {
            surfacePaymentSuccess(`Complete payment in your browser (${opened.method}) — your plan will update automatically once it lands. Keep this window open.`);
          } else {
            // Surface the URL on the error path so the user can copy &
            // paste manually instead of being stranded.
            setPaymentError(`Couldn't open the browser automatically. Open this URL to pay: ${data.checkout_url}`);
          }
          await pollForUpgrade(tier);
        } else {
          window.location.href = data.checkout_url;
        }
      } else if (data.provider === 'razorpay') {
        // Razorpay — open inline checkout modal
        await openRazorpayCheckout(data);
      }
    } catch (err: any) {
      setPaymentError(err.message || 'Payment failed');
    } finally {
      setPaymentLoading(false);
    }
  };

  // ── Basic-tier renewal (+1 interview, +1 hour) ──────────────────────
  // Separate from initiateCheckout because the backend routes it to
  // /create-renewal and grants only a top-up (not a fresh 3/14-day
  // Basic grant). openRazorpayCheckout reads checkoutData.mode and
  // /verify-razorpay reads the stamped notes.mode to pick the right
  // success copy on both ends.
  const initiateRenewal = async () => {
    setPaymentLoading(true);
    setPaymentError(null);
    try {
      // Same region-required guard as initiateCheckout — see the comment
      // there for the rationale (geo race → wrong-currency charge).
      if (!geo) {
        throw new Error('Detecting your region — please try again in a moment.');
      }
      let token = licenseService.getToken();
      if (!token) {
        await new Promise(r => setTimeout(r, 500));
        token = licenseService.getToken();
      }
      if (!token) throw new Error('Please sign in first to continue renewal');

      const countryCode = geo?.country_code || 'US';
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 30000);
      let response: Response;
      try {
        response = await fetch(`${API_BASE_PLAN}/api/v1/payments/create-renewal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ country_code: countryCode }),
          signal: controller.signal,
        });
      } catch (fetchErr: any) {
        if (fetchErr?.name === 'AbortError') {
          throw new Error('Request timed out. Please check your connection and try again.');
        }
        throw fetchErr;
      } finally {
        window.clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to start renewal');
      }
      const data = await response.json();

      if (data.provider === 'stripe') {
        // Same Electron-vs-web fork as the subscription flow — see the
        // long comment at the matching block in initiateCheckout. Without
        // this, a desktop user clicking Renew gets stranded on the website
        // after Stripe's redirect. pollForRenewal watches expires_at on
        // the cached license — when validateWithServer detects the +1h
        // delta from grantBasicRenewal, the +3600s credit lands locally.
        if (isElectron && window.electronAPI) {
          // Same robust opener path as initiateCheckout — see the comment
          // there for the rationale.
          let opened: { ok: boolean; method?: string } = { ok: false };
          try {
            opened = window.electronAPI.openExternalRobust
              ? await window.electronAPI.openExternalRobust(data.checkout_url)
              : (await window.electronAPI.openExternal(data.checkout_url), { ok: true, method: 'shell.openExternal-legacy' });
          } catch (e) {
            opened = { ok: false };
          }
          if (opened.ok) {
            surfacePaymentSuccess(`Complete payment in your browser (${opened.method}) — your renewal credit will land here automatically once it does. Keep this window open.`);
          } else {
            setPaymentError(`Couldn't open the browser automatically. Open this URL to pay: ${data.checkout_url}`);
          }
          await pollForRenewal();
        } else {
          window.location.href = data.checkout_url;
        }
      } else if (data.provider === 'razorpay') {
        await openRazorpayCheckout(data);
      }
    } catch (err: any) {
      setPaymentError(err.message || 'Renewal failed');
    } finally {
      setPaymentLoading(false);
    }
  };

  // ── Stripe Customer Portal (manage/cancel for Pro/Max) ──────────────
  // Opens Stripe's hosted billing portal in a new tab. If the user has
  // no Stripe customer on file (e.g. paid via Razorpay, or the webhook
  // hasn't reconciled yet) the server returns 404 and we surface a
  // clear message instead of an opaque spinner.
  const handleManageSubscription = async () => {
    setPaymentLoading(true);
    setPaymentError(null);
    try {
      const token = licenseService.getToken();
      if (!token) throw new Error('Please sign in first');
      const res = await fetch(`${API_BASE_PLAN}/api/v1/payments/portal`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Could not open the billing portal');
      }
      const { portal_url } = await res.json();
      if (portal_url) window.open(portal_url, '_blank', 'noopener');
      else throw new Error('Billing portal URL missing from server response');
    } catch (err: any) {
      setPaymentError(err.message || 'Failed to open billing portal');
    } finally {
      setPaymentLoading(false);
    }
  };

  // ── Razorpay self-cancel (for India Pro/Max users) ──────────────────
  // Razorpay has no Customer Portal equivalent. This endpoint looks up
  // the user's most recent Razorpay subscription and cancels it at the
  // end of the current billing cycle (user keeps full access until then).
  // Wrapped in a confirm so a misclick doesn't kill an active sub.
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const handleCancelSubscription = async () => {
    setCancelConfirm(false);
    setPaymentLoading(true);
    setPaymentError(null);
    try {
      const token = licenseService.getToken();
      if (!token) throw new Error('Please sign in first');
      const res = await fetch(`${API_BASE_PLAN}/api/v1/payments/cancel-razorpay`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Could not cancel subscription');
      }
      const data = await res.json();
      surfacePaymentSuccess(data.message || 'Subscription cancellation scheduled for end of cycle.');
    } catch (err: any) {
      setPaymentError(err.message || 'Failed to cancel subscription');
    } finally {
      setPaymentLoading(false);
    }
  };

  // ── Razorpay inline checkout ──
  const openRazorpayCheckout = async (checkoutData: any) => {
    return new Promise<void>((resolve, reject) => {
      loadRazorpayScript().then(() => {
        const options: any = {
          key: checkoutData.key_id,
          amount: checkoutData.amount,
          currency: checkoutData.currency,
          name: checkoutData.name,
          description: checkoutData.description,
          prefill: {
            email: checkoutData.user_email,
            name: checkoutData.user_name,
          },
          theme: { color: '#3b82f6' },
          handler: async (response: any) => {
            // Payment successful — verify on server
            try {
              const token = licenseService.getToken();
              const verifyRes = await fetch(`${API_BASE_PLAN}/api/v1/payments/verify-razorpay`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify({
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_order_id: response.razorpay_order_id,
                  razorpay_signature: response.razorpay_signature,
                  razorpay_subscription_id: response.razorpay_subscription_id,
                }),
              });

              if (!verifyRes.ok) {
                const err = await verifyRes.json();
                throw new Error(err.error || 'Verification failed');
              }

              const verifyData = await verifyRes.json();

              // Resolve the tier the server actually granted. Prefer the
              // server's authoritative response (verifyData.tier) over the
              // tier the user clicked — they might differ if the server
              // fell back to a default, and the UI must reflect reality.
              const grantedTier = (verifyData.tier
                || verifyData.license?.tier
                || checkoutData.tier
                || 'pro') as 'basic' | 'pro' | 'max';

              // Renewal (+1/+1h) vs. fresh tier grant. Server stamps mode
              // on both /create-renewal (checkoutData.mode) and the verify
              // response (verifyData.mode) so either can flag it — prefer
              // the verify response since it's the authoritative record
              // of what was actually granted.
              const isRenewal = (verifyData.mode || checkoutData.mode) === 'renewal';

              // Update local state
              if (currentUser) {
                const updatedUser = { ...currentUser, tier: grantedTier };
                setCurrentUser(updatedUser);
                // Prefer the server's authoritative license. If the server
                // didn't echo one back, patch the cached license with the
                // new tier so getEffectiveTier() doesn't snap the user back
                // to Free on next app load (it reads license.tier, not
                // user.tier — a stale 'free' there would silently undo the
                // upgrade the moment the app restarts).
                let newLicense = verifyData.license
                  || (currentLicense
                        ? { ...currentLicense, tier: grantedTier, status: 'active' as const }
                        : null);
                if (newLicense) {
                  // Basic-tier needs the client-side credit ledger seeded
                  // (first purchase) or topped up (renewal). The server
                  // updates tier + expires_at + sessions_limit but has no
                  // credits_remaining_seconds column (Option A), so the
                  // client handles credits here before saving.
                  if (isRenewal) {
                    // Idempotency: keyed by razorpay_payment_id so a retried
                    // verify call (double-click, webhook race) doesn't grant
                    // two credits for one payment.
                    const paymentId = response?.razorpay_payment_id || '';
                    const appliedKey = paymentId ? `mc_renewal_applied_${paymentId}` : '';
                    let alreadyApplied = false;
                    try { alreadyApplied = !!appliedKey && !!localStorage.getItem(appliedKey); } catch {}
                    if (!alreadyApplied) {
                      newLicense = licenseService.grantRenewalCredit(newLicense as LicenseData);
                      if (appliedKey) {
                        try { localStorage.setItem(appliedKey, String(Date.now())); } catch {}
                      }
                    }
                  } else if (grantedTier === 'basic') {
                    // First-time Basic purchase — saveAuth + reload of state
                    // below needs credit fields populated. grantRenewalCredit
                    // adds exactly one credit (1h) which would shortchange a
                    // first-time buyer expecting 3h. Call validateWithServer
                    // to re-run the normalize path which seeds 3 credits on
                    // tierChanged (the server-side webhook may have flipped
                    // the tier already, or the local tier swap we're doing
                    // now is the trigger). Fall back to manual seed if
                    // validateWithServer came back null (offline/unreachable).
                    const revalidated = await licenseService.validateWithServer();
                    if (revalidated && revalidated.tier === 'basic') {
                      newLicense = revalidated;
                    } else if ((newLicense as LicenseData).credits_remaining_seconds == null) {
                      // Local fallback seed — same shape as freshBasicCreditSeed.
                      const base = newLicense as LicenseData;
                      const fallbackExpiry = Date.now() + 14 * 24 * 60 * 60 * 1000;
                      newLicense = {
                        ...base,
                        credits_remaining_seconds: 3 * 3600,
                        credits_expire_at: base.expires_at > 0 ? base.expires_at : fallbackExpiry,
                      } as LicenseData;
                    }
                  }
                  setCurrentLicense(newLicense);
                  licenseService.saveAuth(updatedUser, newLicense);
                }
              }

              setPaymentError(null);
              setJustSignedUp(false);
              // Same persistence as the Stripe success-redirect path: stash
              // the granted tier so a refresh of /download doesn't fall back
              // to "Upgrade to Pro" while the webhook catches up.
              if (!isRenewal && grantedTier && grantedTier !== ('free' as any)) {
                try { localStorage.setItem('justPurchasedTier', grantedTier); } catch {}
                setLastSuccessfulTier(grantedTier);
              }
              surfacePaymentSuccess(isRenewal ? welcomeForRenewal() : welcomeForTier(grantedTier));
              resolve();
            } catch (err: any) {
              setPaymentError(err.message);
              reject(err);
            }
          },
          modal: {
            ondismiss: () => {
              setPaymentLoading(false);
              resolve();
            },
          },
        };

        // Use subscription_id if available, otherwise order_id
        if (checkoutData.subscription_id) {
          options.subscription_id = checkoutData.subscription_id;
        } else if (checkoutData.order_id) {
          options.order_id = checkoutData.order_id;
        }

        const rzp = new (window as any).Razorpay(options);
        rzp.open();
      }).catch(reject);
    });
  };

  // ── Google Auth ──
  const handleGoogleSuccess = async (credentialResponse: any) => {
    if (!credentialResponse?.credential) return;
    setIsSubmitting(true);
    setAuthError(null);

    try {
      const data = await licenseService.googleAuth(
        credentialResponse.credential,
        geo?.country_code || 'US'
      );

      setCurrentUser(data.user);
      setCurrentLicense(data.license);

      if (isElectron) {
        onAuthenticated(data.user, data.license);
      } else if (selectedProUpgrade) {
        setSelectedProUpgrade(false);
        setTimeout(() => initiateCheckout(), 300);
        setView('download');
      } else {
        setView('download');
      }
    } catch (err: any) {
      setAuthError(err.message || 'Google sign-in failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGoogleError = () => {
    setAuthError('Google sign-in was cancelled or failed. Please try again.');
  };

  // ── Google OAuth via system browser (for Electron) ──
  // Cancel any in-flight Google sign-in. Wired to a Cancel button that
  // shows during the polling phase — without it, a botched openExternal
  // (browser doesn't open) traps the user with a spinner for 2 full
  // minutes until poll timeout. Also called by the manual-fallback flow.
  const cancelGoogleElectron = () => {
    googlePollAbortRef.current = true;
    setGoogleSubmitting(false);
    setGoogleManualUrl(null);
    setGoogleUrlCopied(false);
    setAuthError(null);
  };

  const handleGoogleElectron = async () => {
    setGoogleSubmitting(true);
    setAuthError(null);
    setGoogleManualUrl(null);
    setGoogleUrlCopied(false);
    googlePollAbortRef.current = false;

    const sessionId = crypto.randomUUID();
    // Env-aware: in dev (vite serves on :3005) we point at VITE_SERVER_URL
    // so Google OAuth lands on the local server's /auth/google/callback,
    // not on prod. PROD short-circuit guards against a stray env var
    // leaking into a production installer (same defense-in-depth pattern
    // as licenseService.API_BASE and SupportBot's DEFAULT_API_BASE).
    // Note: for local Google OAuth to actually work you also need
    // http://localhost:4000/api/v1/auth/google/callback registered in the
    // Google Cloud Console OAuth client's Authorized redirect URIs.
    const viteEnv = (import.meta as any).env || {};
    const serverUrl = viteEnv.PROD
      ? 'https://api.minicaai.com'
      : (viteEnv.VITE_SERVER_URL || 'https://api.minicaai.com');
    const authUrl = `${serverUrl}/api/v1/auth/google/start?session_id=${sessionId}`;

    // Open Google sign-in in system browser. We MUST await + catch here —
    // the original fire-and-forget pattern silently swallowed shell errors
    // (default-browser misconfigured, ShellExecuteEx failure, etc.) and the
    // spinner ran for 2 minutes with no diagnostic.
    //
    // The robust opener (added in v3.4.6) runs in the main process and
    // tries shell.openExternal first, then falls back to a child_process
    // spawn (cmd /c start on Windows, open on Mac, xdg-open on Linux).
    // That bypasses the most common Windows ShellExecute breakage. We
    // still keep the legacy openExternal path for any older preload that
    // somehow ships without the new method.
    //
    // Track failure state in a LOCAL variable, not React state — calling
    // setGoogleManualUrl + then reading googleManualUrl in the same
    // function execution reads the stale closure value, which was the
    // cause of the v3.4.5 "no error reason" UI bug where a generic
    // message overwrote the specific one.
    let openedOk = false;
    let openErrorMsg: string | null = null;
    let openAttempts: Array<{ method: string; ok: boolean; error?: string }> = [];

    try {
      if (window.electronAPI?.openExternalRobust) {
        const result = await window.electronAPI.openExternalRobust(authUrl);
        openAttempts = result.attempts || [];
        openedOk = !!result.ok;
        if (!openedOk) {
          // Prefer building the message from every failed attempt so the
          // user sees BOTH what shell.openExternal said AND what the
          // spawn fallback said. result.error from the IPC is just the
          // last attempt's error — useful for code, but the user (and
          // we, when triaging support tickets) want the full picture.
          const failedErrs = openAttempts
            .filter(a => !a.ok)
            .map(a => a.error)
            .filter(Boolean) as string[];
          openErrorMsg = failedErrs.length > 0
            ? failedErrs.join(' / ')
            : (result.error || 'all browser-launch methods failed');
        }
      } else if (window.electronAPI?.openExternal) {
        // Older preload — legacy single-path opener with our own timeout.
        const openPromise = window.electronAPI.openExternal(authUrl);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Browser launch timed out (6s)')), 6000)
        );
        await Promise.race([openPromise, timeoutPromise]);
        openedOk = true;
      } else {
        // Browser fallback (non-Electron path — should not hit here in
        // practice since this handler is gated on isElectron). window.open
        // can be popup-blocked; we still surface the URL so the user can
        // open it manually if the popup is suppressed.
        const opened = window.open(authUrl, '_blank');
        if (opened) {
          openedOk = true;
        } else {
          openErrorMsg = 'browser popup was blocked';
        }
      }
    } catch (openErr: any) {
      console.error('[google-auth] open external failed:', openErr);
      openErrorMsg = openErr?.message || 'unknown error';
    }

    if (!openedOk) {
      // Single source of truth for the failure UI — driven by openedOk +
      // openErrorMsg locals so we don't race React state. attempts is
      // logged for our diagnostics; we show only the summary to the user.
      if (openAttempts.length > 0) {
        console.warn('[google-auth] open attempts:', openAttempts);
      }
      setGoogleManualUrl(authUrl);
      setAuthError(
        `Couldn't open your browser automatically${openErrorMsg ? ` (${openErrorMsg})` : ''}. Copy the link below and open it in any browser to continue.`
      );
    }

    // Poll for result regardless of whether openExternal succeeded — if the
    // user opens the URL manually, polling still picks up the success.
    let attempts = 0;
    const maxAttempts = 60; // 60 * 2s = 2 minutes
    const pollInterval = 2000;

    const poll = async (): Promise<void> => {
      // Three abort conditions:
      //  1. User clicked Cancel (googlePollAbortRef.current = true)
      //  2. Component unmounted (mountedRef.current = false)
      //  3. Max attempts reached (handled below)
      if (googlePollAbortRef.current) return;
      if (!mountedRef.current) return;
      attempts++;
      try {
        const res = await fetch(`${serverUrl}/api/v1/auth/google/poll?session_id=${sessionId}`);
        const data = await res.json();
        if (googlePollAbortRef.current) return;
        if (!mountedRef.current) return;

        if (data.status === 'success') {
          // Defensive: server should always return a license on success,
          // but if for any reason it's missing we'd otherwise authenticate
          // the user and then immediately crash downstream code that reads
          // license.tier. Surface the issue clearly instead.
          if (!data.user || !data.license || !data.token) {
            console.error('[google-auth] success response missing fields:', {
              hasUser: !!data.user,
              hasLicense: !!data.license,
              hasToken: !!data.token,
            });
            setAuthError('Sign-in succeeded but server returned incomplete data. Please try again.');
            setGoogleSubmitting(false);
            setGoogleManualUrl(null);
            return;
          }
          // Save auth data
          data.license.last_validated = Date.now();
          try {
            licenseService.saveAuth(data.user, data.license, data.token);
          } catch (saveErr: any) {
            // localStorage quota / disabled / corrupt JSON. Without this
            // try-catch, a saveAuth throw silently aborts the success path
            // and the spinner runs forever — the "loading there itself"
            // symptom from logout→re-login.
            console.error('[google-auth] saveAuth threw:', saveErr);
            setAuthError('Could not save sign-in (storage error). Please try again.');
            setGoogleSubmitting(false);
            setGoogleManualUrl(null);
            return;
          }

          setCurrentUser(data.user);
          setCurrentLicense(data.license);
          setGoogleSubmitting(false);
          setGoogleManualUrl(null);

          if (window.electronAPI?.send) {
            // Pull the Electron window back to the foreground — the browser
            // "you can close this tab" page leaves the desktop app hidden
            // behind it otherwise.
            try { window.electronAPI.send('focus-main-window'); } catch {}
            onAuthenticated(data.user, data.license);
          } else {
            setView('download');
          }
          return;
        }

        if (data.status === 'error') {
          setAuthError(data.error || 'Google sign-in failed');
          setGoogleSubmitting(false);
          setGoogleManualUrl(null);
          return;
        }

        // Still pending
        if (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, pollInterval));
          if (googlePollAbortRef.current) return;
          if (!mountedRef.current) return;
          return poll();
        } else {
          setAuthError('Sign-in timed out. Please try again.');
          setGoogleSubmitting(false);
          setGoogleManualUrl(null);
        }
      } catch (pollErr) {
        // Log so we can see WHAT failed if the user reports it again.
        // Previously this catch was silent + retried, masking real bugs
        // (e.g., CORS, DNS, certificate errors) as "still pending".
        console.warn('[google-auth] poll attempt failed:', pollErr);
        if (googlePollAbortRef.current) return;
        if (!mountedRef.current) return;
        if (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, pollInterval));
          if (googlePollAbortRef.current) return;
          if (!mountedRef.current) return;
          return poll();
        }
        setAuthError('Connection error. Please try again.');
        setGoogleSubmitting(false);
        setGoogleManualUrl(null);
      }
    };

    try {
      await poll();
    } catch (err: any) {
      console.error('[google-auth] poll loop threw:', err);
      setAuthError(err?.message || 'Google sign-in failed');
      setGoogleSubmitting(false);
      setGoogleManualUrl(null);
    }
  };

  // Reusable fallback panel shown when shell.openExternal fails (or hangs)
  // and during the polling phase. Without this the user is trapped: spinner
  // running, browser never opened, no way out for 2 full minutes. Defined
  // here so it captures the latest state via closure and renders identically
  // in both the login and signup views.
  const renderGoogleFallback = () => {
    if (!googleSubmitting && !googleManualUrl) return null;
    return (
      <div className="mt-3 space-y-2">
        {googleManualUrl && (
          <div
            className="rounded-xl px-3 py-2.5 text-[12px] break-all"
            style={{ background: 'var(--cream)', border: '1px solid var(--cream-line)', color: 'var(--ink-muted)' }}
          >
            <div className="font-mono text-[11px] mb-2" style={{ color: 'var(--ink)' }}>
              {googleManualUrl}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(googleManualUrl);
                    setGoogleUrlCopied(true);
                    setTimeout(() => setGoogleUrlCopied(false), 2000);
                  } catch {
                    setGoogleUrlCopied(false);
                  }
                }}
                className="px-3 py-1.5 rounded-full text-[11.5px] font-medium transition-all hover:opacity-90"
                style={{ background: 'var(--ink)', color: 'var(--cream)' }}
              >
                {googleUrlCopied ? 'Copied!' : 'Copy link'}
              </button>
              <button
                type="button"
                onClick={async () => {
                  // Last-ditch: try the robust opener one more time. If it
                  // works, polling that's already running picks up the
                  // success. We log the result either way so we can see
                  // whether retries help (sometimes Windows shell wakes up
                  // after the first attempt primes the protocol handler).
                  if (!googleManualUrl) return;
                  try {
                    if (window.electronAPI?.openExternalRobust) {
                      const r = await window.electronAPI.openExternalRobust(googleManualUrl);
                      console.log('[google-auth] retry openExternalRobust:', r);
                    } else if (window.electronAPI?.openExternal) {
                      await window.electronAPI.openExternal(googleManualUrl);
                    }
                  } catch (e: any) {
                    console.warn('[google-auth] retry open failed:', e);
                  }
                }}
                className="px-3 py-1.5 rounded-full text-[11.5px] font-medium transition-all hover:opacity-90"
                style={{ background: 'var(--cream-soft)', border: '1px solid var(--cream-line)', color: 'var(--ink)' }}
              >
                Try again
              </button>
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={cancelGoogleElectron}
          className="w-full py-2 text-[12px] font-medium transition-all hover:opacity-100"
          style={{ color: 'var(--ink-muted)' }}
        >
          Cancel sign-in
        </button>
      </div>
    );
  };

  // ── Logout ──
  // Resets auth-related transient state too, not just user/license/view.
  // Without these resets, a logout that happens while isSubmitting=true
  // (e.g., user gives up mid-Google-poll and clicks logout) leaves the
  // next sign-in button stuck in "Waiting for sign-in..." with the spinner
  // running and the button disabled — root cause of the v3.4.2 logout→
  // re-login regression.
  const handleLogout = () => {
    licenseService.logout();
    setCurrentUser(null);
    setCurrentLicense(null);
    setIsSubmitting(false);
    setAuthError(null);
    setForgotSent(false);
    setView('landing');
    setEmail('');
    setPassword('');
    setName('');
    // Cancel any in-flight Google sign-in and clear its UI state so a
    // re-login attempt starts fully fresh — without these, a stale
    // googleManualUrl or polled-out abort flag would block the next
    // openExternal from running cleanly.
    googlePollAbortRef.current = true;
    setGoogleSubmitting(false);
    setGoogleManualUrl(null);
    setGoogleUrlCopied(false);
  };

  // ── Loading ──
  if (isLoading) {
    return (
      <div className="fixed inset-0 bg-[#050507] flex items-center justify-center">
        <AnimatedBackground />
        <div className="relative z-10 flex flex-col items-center gap-6">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 via-blue-600 to-purple-600 flex items-center justify-center shadow-2xl shadow-blue-500/30 animate-pulse">
            <Bot size={32} className="text-white" strokeWidth={1.5} />
          </div>
          <div className="flex items-center gap-3">
            <Loader2 size={16} className="text-blue-400 animate-spin" />
            <span className="text-sm text-gray-500 font-medium">Initializing secure session...</span>
          </div>
        </div>
      </div>
    );
  }

  // ── Version expired ──
  if (error && !geo) {
    return (
      <div className="fixed inset-0 bg-[#050507] flex items-center justify-center p-6">
        <AnimatedBackground />
        <div className="relative z-10 max-w-md w-full text-center">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-red-500/10 flex items-center justify-center mb-6">
            <AlertTriangle size={32} className="text-red-400" />
          </div>
          <h2 className="text-xl font-bold text-white mb-3">Update Required</h2>
          <p className="text-gray-400 text-sm mb-8 leading-relaxed">{error}</p>
          <a href="https://get.minicaai.com" className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold text-sm transition-all shadow-lg shadow-blue-500/25">
            Download Latest Version <ArrowRight size={14} />
          </a>
        </div>
      </div>
    );
  }

  // ── VPN Blocked ──
  if (view === 'vpn_blocked') {
    return (
      <div className="fixed inset-0 bg-[#050507] flex items-center justify-center p-6">
        <AnimatedBackground />
        <div className="relative z-10 max-w-md w-full text-center">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-amber-500/10 flex items-center justify-center mb-6">
            <Shield size={32} className="text-amber-400" />
          </div>
          <h2 className="text-xl font-bold text-white mb-3">VPN/Proxy Detected</h2>
          <p className="text-gray-400 text-sm mb-4 leading-relaxed">
            For security and regional compliance, minicaai requires a direct internet connection.
            Please disable your VPN or proxy and try again.
          </p>
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-gray-500 text-xs mb-8">
            <Globe size={12} /> Detected: {geo?.country_name || 'Unknown'}
          </div>
          <br />
          <button onClick={() => window.location.reload()} className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold text-sm transition-all">
            Retry Connection <ArrowRight size={14} />
          </button>
        </div>
      </div>
    );
  }

  // ── DOCS VIEW ──
  // Public-facing technical reference. Linked from the landing nav and
  // deep-linkable via /docs/<slug>. The component owns its own scroll,
  // keyboard shortcuts (⌘K), and URL sync. Closing returns the user to
  // the landing page (matches the back-button convention used by the
  // tutorials/pricing branches below). Lazy-loaded behind Suspense so
  // the initial landing bundle stays lean.
  if (view === 'docs') {
    return (
      <Suspense
        fallback={
          <div
            className="fixed inset-0 flex items-center justify-center"
            style={{ background: 'var(--cream, #faf8f5)', color: 'var(--ink-muted, #6b7280)' }}
          >
            <div className="flex items-center gap-2.5 text-sm">
              <Loader2 size={16} className="animate-spin" />
              <span>Loading documentation…</span>
            </div>
          </div>
        }
      >
        <Documentation
          open
          onClose={() => setView('landing')}
          appVersion={typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''}
          isDark={false}
          authToken={licenseService.getToken() || null}
        />
      </Suspense>
    );
  }

  // ── TUTORIALS VIEW ──
  if (view === 'tutorials') {
    if (isMobile) {
      return <TutorialsMobile setView={setView} currentUser={currentUser} />;
    }
    return (
      <div className="fixed inset-0 bg-[#050507] text-white overflow-y-auto">
        <AnimatedBackground />
        <NoiseOverlay />
        <nav className="relative z-10 flex items-center justify-between px-6 py-4 max-w-6xl mx-auto">
          <Logo size="md" />
          <button onClick={() => setView(currentUser ? 'download' : 'landing')} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-400 hover:text-white transition-colors flex items-center gap-1.5">
            <ArrowRight size={14} className="rotate-180" /> Back
          </button>
        </nav>

        <div className="relative z-10 max-w-4xl mx-auto px-6 pt-12 pb-20">
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-blue-500/20 bg-blue-500/[0.06] mb-6">
              <BookOpen size={12} className="text-blue-400" />
              <span className="text-xs font-medium text-blue-300">Getting Started Guide</span>
            </div>
            <h1 className="text-3xl font-bold mb-3">Learn minicaai in 5 minutes</h1>
            <p className="text-gray-500 max-w-lg mx-auto text-sm">Follow these tutorials to master every feature. Required for all new users.</p>
          </div>

          <div className="grid md:grid-cols-2 gap-4 mb-12">
            <TutorialCard step="01" title="Download & Install" desc="How to download, install, and launch minicaai on Windows, Mac, or Linux." duration="1 min" />
            <TutorialCard step="02" title="Create Your Account" desc="Sign up, verify your email, and activate your license key." duration="1 min" />
            <TutorialCard step="03" title="Upload Resume & JD" desc="Add your resume and job description for contextual AI answers." duration="1 min" />
            <TutorialCard step="04" title="Start an Interview Session" desc="Share system audio, enable auto-mode, and let minicaai listen." duration="2 min" />
            <TutorialCard step="05" title="Using Pop-out Mode" desc="Launch the invisible overlay that stays on top during calls. (Pro)" duration="1 min" />
            <TutorialCard step="06" title="Auto-Solve with Screen Capture" desc="Capture your screen and let AI solve coding problems. (Pro)" duration="2 min" />
            <TutorialCard step="07" title="Switch AI Models" desc="Choose between Gemini, GPT, Groq, and Grok for different strengths." duration="1 min" />
            <TutorialCard step="08" title="Manage Your Subscription" desc="Upgrade to Pro, manage billing, and view usage stats." duration="1 min" />
          </div>

          <div className="text-center">
            <button onClick={() => setView(currentUser ? 'download' : 'signup')} className="px-8 py-3 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold text-sm hover:from-blue-400 hover:to-blue-500 transition-all shadow-lg shadow-blue-500/25 flex items-center gap-2 mx-auto">
              {currentUser ? 'Go to Download' : 'Get Started'} <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── DOWNLOAD VIEW (after auth — browser only) ──
  if (view === 'download' && !isElectron) {
    if (isMobile) {
      return (
        <>
          <DownloadMobile
            setView={setView}
            currentUser={currentUser}
            setCurrentUser={setCurrentUser}
            currentLicense={currentLicense}
            handleLogout={handleLogout}
            justSignedUp={justSignedUp}
            setJustSignedUp={setJustSignedUp}
            paymentError={paymentError}
            paymentSuccess={paymentSuccess}
            paymentLoading={paymentLoading}
            geo={geo}
            pricing={pricing}
            lastSuccessfulTier={lastSuccessfulTier}
            cancelConfirm={cancelConfirm}
            setCancelConfirm={setCancelConfirm}
            handleManageSubscription={handleManageSubscription}
            handleCancelSubscription={handleCancelSubscription}
            initiateRenewal={initiateRenewal}
            initiateCheckout={initiateCheckout}
            basicExpiryLabel={basicExpiryLabel}
            onOpenDocs={() => setWebDocsOpen(true)}
          />
          {/* Documentation overlay sibling — mobile branch early-returns
              here so the desktop branch's Documentation mount wouldn't be
              reached. Render it adjacent to DownloadMobile so the mobile
              profile sheet's "Docs & guides" row has a real modal to open. */}
          {webDocsOpen && (
            <Suspense
              fallback={
                <div
                  className="fixed inset-0 flex items-center justify-center"
                  style={{ background: 'var(--cream, #faf8f5)', color: 'var(--ink-muted, #6b7280)', zIndex: 200 }}
                >
                  <div className="flex items-center gap-2.5 text-sm">
                    <Loader2 size={16} className="animate-spin" />
                    <span>Loading documentation…</span>
                  </div>
                </div>
              }
            >
              <Documentation
                open
                onClose={() => setWebDocsOpen(false)}
                appVersion={typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''}
                isDark={false}
                authToken={licenseService.getToken() || null}
              />
            </Suspense>
          )}
        </>
      );
    }
    return (
      <div className="fixed inset-0 bg-[#050507] text-white overflow-y-auto">
        <AnimatedBackground />
        <NoiseOverlay />

        <nav className="relative z-10 flex items-center justify-between px-6 py-4 max-w-6xl mx-auto">
          <Logo size="md" />
          <div className="flex items-center gap-3">
            {currentUser && (
              <>
                {/* Email tappable — opens the profile sheet. The button
                    style stays subtle (text-only with hover lift) so the
                    nav doesn't read like an action bar; the email is still
                    primarily a status indicator, just a discoverable one. */}
                <button
                  onClick={() => setDesktopProfileOpen(true)}
                  className="text-xs text-gray-500 hover:text-white transition-colors flex items-center gap-1.5"
                  aria-label="Open profile"
                  title="Open profile"
                >
                  {currentUser.avatar_url && currentUser.oauth_provider === 'google' ? (
                    <img
                      src={currentUser.avatar_url}
                      alt=""
                      referrerPolicy="no-referrer"
                      style={{ width: 18, height: 18, borderRadius: 999, border: '1px solid rgba(255,255,255,0.1)' }}
                    />
                  ) : (
                    <span
                      className="inline-flex items-center justify-center font-medium"
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 999,
                        background: 'rgba(255,255,255,0.08)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        fontSize: 9,
                        color: 'rgba(255,255,255,0.7)',
                      }}
                    >
                      {(currentUser.name?.[0] || currentUser.email[0]).toUpperCase()}
                    </span>
                  )}
                  {currentUser.email}
                </button>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${currentLicense?.tier === 'max' ? 'bg-amber-500/20 text-amber-400' : currentLicense?.tier === 'pro' ? 'bg-blue-500/20 text-blue-400' : currentLicense?.tier === 'basic' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-gray-500/20 text-gray-400'}`}>
                  {currentLicense?.tier || 'free'}
                </span>
                {/* Explicit "Subscription" link in the nav — labeled, not
                    hidden behind an icon. This is the single discoverable
                    path to upgrade / downgrade / cancel that every user
                    can find. Routes to /pricing which now shows the full
                    4-tier comparison + per-tier checkout buttons that pipe
                    through the same handlers as the cards. Cancel + manage
                    are also reachable from the desktop profile sheet's
                    "Plan & billing" row, but this is the obvious nav-level
                    one. */}
                <button
                  onClick={() => setWebManageSubOpen(true)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-gray-300 hover:text-white transition-all flex items-center gap-1.5"
                  aria-label="Manage subscription"
                  title="Manage subscription"
                >
                  <Settings size={12} /> Subscription
                </button>
                {licenseService.isDeveloper(currentUser.email) && (
                  <button onClick={() => setView('admin')} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-all">
                    Admin
                  </button>
                )}
                <button onClick={handleLogout} className="p-2 text-gray-500 hover:text-red-400 transition-colors" aria-label="Logout">
                  <LogOut size={16} />
                </button>
              </>
            )}
          </div>
        </nav>

        {/* Web Manage Subscription — same component the Electron chat-
            header opens. Gives web users full parity: cancel + reactivate
            + tier swaps + refund policy + profile edit + status banners.
            onUpgradeRequested closes the modal and routes through the
            existing initiateCheckout path so the post-checkout polling
            and Stripe-vs-Razorpay forks still work. */}
        <ManageSubscriptionModal
          isOpen={webManageSubOpen}
          onClose={() => setWebManageSubOpen(false)}
          userProfile={currentUser}
          userLicense={currentLicense}
          onUpgradeRequested={(targetTier) => {
            setWebManageSubOpen(false);
            // Small defer so the modal exit animation lands before
            // checkout takes the renderer over via Stripe redirect.
            window.setTimeout(() => initiateCheckout(targetTier), 200);
          }}
          onProfileUpdated={(updated) => setCurrentUser(updated)}
          onLicenseUpdated={(updated) => setCurrentLicense(updated)}
          onRenewRequested={() => {
            setWebManageSubOpen(false);
            window.setTimeout(() => initiateRenewal(), 200);
          }}
        />

        {/* Desktop profile sheet — same component used by DownloadMobile
            but parented to SubscriptionGateInner so the cream surface
            covers the dark /download page like a proper iOS-style modal. */}
        <ProfileSheetMobile
          open={desktopProfileOpen}
          onClose={() => setDesktopProfileOpen(false)}
          currentUser={currentUser}
          setCurrentUser={setCurrentUser}
          currentLicense={currentLicense}
          geo={geo}
          onLogout={handleLogout}
          onOpenPlanSheet={() => {
            // Open the proper ManageSubscription modal (in-app billing
            // surface with current plan + upgrade/downgrade/cancel/
            // reactivate flows). Previously this called setView('pricing')
            // which navigated to the unauthenticated marketing "Choose
            // your plan" page (the one with Back + Sign In in the nav) —
            // exactly the wrong UX for a signed-in user who clicked
            // "Plan & billing" from their profile. Keep the profile sheet
            // open behind so closing ManageSubscription returns to it.
            setWebManageSubOpen(true);
          }}
          onOpenDocs={() => setWebDocsOpen(true)}
        />

        {/* Web Documentation overlay — opens ABOVE the profile sheet
            so closing it returns the user to the still-open profile
            instead of dumping them on the landing page. Lazy-loaded
            (same Suspense fallback pattern as the standalone /docs
            view above). z-[200] inside Documentation guarantees it
            covers the profile sheet's zIndex 41. */}
        {webDocsOpen && (
          <Suspense
            fallback={
              <div
                className="fixed inset-0 flex items-center justify-center"
                style={{ background: 'var(--cream, #faf8f5)', color: 'var(--ink-muted, #6b7280)', zIndex: 200 }}
              >
                <div className="flex items-center gap-2.5 text-sm">
                  <Loader2 size={16} className="animate-spin" />
                  <span>Loading documentation…</span>
                </div>
              </div>
            }
          >
            <Documentation
              open
              onClose={() => setWebDocsOpen(false)}
              appVersion={typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''}
              isDark={false}
              authToken={licenseService.getToken() || null}
            />
          </Suspense>
        )}

        <div className="relative z-10 max-w-3xl mx-auto px-6 pt-16 pb-20 text-center">
          <div className="w-20 h-20 mx-auto rounded-3xl bg-gradient-to-br from-blue-500 via-blue-600 to-purple-600 flex items-center justify-center mb-8 shadow-2xl shadow-blue-500/30">
            <Download size={36} className="text-white" />
          </div>

          <h1 className="text-3xl font-bold mb-3">Download minicaai Desktop</h1>
          <p className="text-gray-400 max-w-md mx-auto mb-4 text-sm leading-relaxed">
            minicaai runs as a desktop app for the best experience — invisible to screen sharing, system audio capture, and always-on-top overlay.
          </p>

          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-amber-500/[0.08] border border-amber-500/20 text-amber-400 text-xs mb-10">
            <AlertTriangle size={12} />
            The web version is not available. Please download the desktop app.
          </div>

          {/* First-time welcome for Starter/Free users. Cleared as soon as
              the user upgrades — a paid success banner replaces it. */}
          {justSignedUp && (!currentLicense || currentLicense.tier === 'free') && (
            <div
              role="status"
              aria-live="polite"
              className="max-w-md mx-auto mb-6 flex items-start gap-3 px-4 py-3 rounded-xl bg-blue-500/10 border border-blue-500/30 text-blue-200 text-sm text-left"
            >
              <Sparkles size={14} className="mt-0.5 shrink-0 text-blue-400" />
              <div className="flex-1">
                <div className="font-semibold">Welcome to minicaai.</div>
                <div className="text-xs text-blue-300/80 mt-0.5 leading-relaxed">
                  Your 30-minute free trial is running. Download the desktop app to start your first session.
                </div>
              </div>
              <button
                onClick={() => setJustSignedUp(false)}
                aria-label="Dismiss"
                className="shrink-0 text-blue-400/60 hover:text-blue-200 transition-colors"
              >
                <X size={14} />
              </button>
            </div>
          )}

          {/* Download buttons */}
          <div className="space-y-3 max-w-md mx-auto mb-12">
            <a href="https://get.minicaai.com/windows"
              className="flex items-center justify-between p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:border-blue-500/40 hover:bg-blue-500/[0.04] transition-all group">
              <div className="flex items-center gap-4">
                <div className="p-2.5 bg-blue-500/10 rounded-xl group-hover:bg-blue-500/20 transition-colors">
                  <Monitor size={22} className="text-blue-400" />
                </div>
                <div className="text-left">
                  <div className="font-semibold text-white text-sm">Windows</div>
                  <div className="text-[11px] text-gray-500">Windows 10+ (.exe)</div>
                </div>
              </div>
              <Download size={16} className="text-gray-600 group-hover:text-blue-400 transition-colors" />
            </a>

            <a href="https://get.minicaai.com/mac"
              className="flex items-center justify-between p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:border-purple-500/40 hover:bg-purple-500/[0.04] transition-all group">
              <div className="flex items-center gap-4">
                <div className="p-2.5 bg-purple-500/10 rounded-xl group-hover:bg-purple-500/20 transition-colors">
                  <Cpu size={22} className="text-purple-400" />
                </div>
                <div className="text-left">
                  <div className="font-semibold text-white text-sm">macOS</div>
                  <div className="text-[11px] text-gray-500">macOS 10.15+ (.dmg)</div>
                </div>
              </div>
              <Download size={16} className="text-gray-600 group-hover:text-purple-400 transition-colors" />
            </a>

            <a href="https://get.minicaai.com/linux"
              className="flex items-center justify-between p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:border-orange-500/40 hover:bg-orange-500/[0.04] transition-all group">
              <div className="flex items-center gap-4">
                <div className="p-2.5 bg-orange-500/10 rounded-xl group-hover:bg-orange-500/20 transition-colors">
                  <Headphones size={22} className="text-orange-400" />
                </div>
                <div className="text-left">
                  <div className="font-semibold text-white text-sm">Linux</div>
                  <div className="text-[11px] text-gray-500">Any distro (.AppImage)</div>
                </div>
              </div>
              <Download size={16} className="text-gray-600 group-hover:text-orange-400 transition-colors" />
            </a>
          </div>

          {/* After download instructions */}
          <div className="max-w-md mx-auto text-left space-y-4 mb-12">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <BookOpen size={14} className="text-blue-400" /> After downloading:
            </h3>
            <div className="space-y-2">
              {[
                'Install and open the app',
                'Sign in with the same email you just registered',
                'Your license will activate automatically on this device',
                'Upload your resume and start your first session',
              ].map((step, i) => (
                <div key={i} className="flex items-start gap-3 text-sm text-gray-400">
                  <span className="text-[10px] font-bold text-blue-500 bg-blue-500/10 px-1.5 py-0.5 rounded mt-0.5 shrink-0">{i + 1}</span>
                  {step}
                </div>
              ))}
            </div>
          </div>

          {paymentError && (
            <div className="max-w-md mx-auto mb-6 flex items-center gap-2 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              <AlertTriangle size={14} /> {paymentError}
            </div>
          )}

          {paymentSuccess && (
            <div
              role="status"
              aria-live="polite"
              className="max-w-md mx-auto mb-6 flex items-center gap-2 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm"
            >
              <Check size={14} /> {paymentSuccess}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-center gap-4">
            <button onClick={() => setView('tutorials')} className="px-6 py-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-sm font-medium transition-all flex items-center gap-2">
              <BookOpen size={14} /> View Tutorials
            </button>
            {(() => {
              // Resolve which "X Active" / "Upgrade" CTA to render. Priority:
              // 1) Admin → always Max (server bypasses Stripe; UI mirrors that).
              // 2) Server-confirmed paid tier on the license itself.
              // 3) Tier the user just paid for (lastSuccessfulTier) — covers
              //    the post-payment window where the webhook hasn't landed
              //    yet and currentLicense.tier is still 'free'.
              // 4) Fall through to "Upgrade to Pro" only when none of the
              //    above identify a paid tier.
              const isAdminUser = !!currentUser && licenseService.isDeveloper(currentUser.email);
              const licenseTier = currentLicense?.tier;
              const paidLicense =
                licenseTier === 'max' || licenseTier === 'pro' || licenseTier === 'basic'
                  ? licenseTier
                  : null;
              const fallbackTier = paidLicense
                ? paidLicense
                : (lastSuccessfulTier === 'max' || lastSuccessfulTier === 'pro' || lastSuccessfulTier === 'basic'
                    ? lastSuccessfulTier
                    : null);
              const effectiveTier = isAdminUser ? 'max' : fallbackTier;

              if (effectiveTier === 'max' || effectiveTier === 'pro') {
                return (
                  <>
                    {effectiveTier === 'max' ? (
                      <div className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-amber-500/10 to-purple-500/10 border border-amber-500/30 text-amber-400 text-sm font-semibold flex items-center gap-2">
                        <WizardHat size={14} /> {isAdminUser ? 'Admin · Max Active' : 'Max Active'}
                      </div>
                    ) : (
                      <div className="px-6 py-2.5 rounded-xl bg-green-500/10 border border-green-500/20 text-green-400 text-sm font-semibold flex items-center gap-2">
                        <Check size={14} /> Pro Active
                      </div>
                    )}
                    {/* Hide subscription-management buttons for admins — there
                        is no real Stripe/Razorpay subscription to manage when
                        the tier was self-granted via /create-checkout. */}
                    {!isAdminUser && geo?.country_code !== 'IN' && (
                      <button
                        onClick={handleManageSubscription}
                        disabled={paymentLoading}
                        className="px-4 py-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-sm font-medium transition-all flex items-center gap-2 disabled:opacity-50"
                        aria-label="Manage subscription (opens billing portal)"
                      >
                        {paymentLoading ? <Loader2 size={14} className="animate-spin" /> : <Settings size={14} />}
                        Manage subscription <ExternalLink size={12} className="opacity-60" />
                      </button>
                    )}
                    {!isAdminUser && geo?.country_code === 'IN' && (
                      <button
                        onClick={() => setCancelConfirm(true)}
                        disabled={paymentLoading}
                        className="px-4 py-2.5 rounded-xl bg-white/[0.04] hover:bg-red-500/10 hover:border-red-500/30 border border-white/[0.08] text-sm font-medium transition-all flex items-center gap-2 disabled:opacity-50 text-gray-400 hover:text-red-300"
                        aria-label="Cancel subscription"
                      >
                        {paymentLoading ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
                        Cancel subscription
                      </button>
                    )}
                  </>
                );
              }

              if (effectiveTier === 'basic') {
                // Same gating rationale as DownloadMobile: Renew is only
                // shown when the LIVE license confirms Basic, not via the
                // optimistic lastSuccessfulTier fallback during webhook
                // lag. Server's /create-renewal would reject in that
                // window anyway; hiding the button avoids a click→error
                // round trip.
                const isConfirmedBasic = currentLicense?.tier === 'basic';
                return (
                  <>
                    <div className="flex flex-col items-center gap-1.5">
                      <div className="px-6 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm font-semibold flex items-center gap-2">
                        <Sparkles size={14} /> Basic Active
                      </div>
                      {currentLicense && basicExpiryLabel(currentLicense.expires_at) && (
                        <div className={`flex items-center gap-1 text-[11px] ${
                          (currentLicense.expires_at ?? 0) - Date.now() <= 0
                            ? 'text-red-400'
                            : (currentLicense.expires_at ?? 0) - Date.now() < 2 * 24 * 60 * 60 * 1000
                              ? 'text-amber-400'
                              : 'text-gray-400'
                        }`}>
                          <Clock size={10} />
                          {basicExpiryLabel(currentLicense.expires_at)}
                        </div>
                      )}
                    </div>
                    {isConfirmedBasic && (
                      <button
                        onClick={initiateRenewal}
                        disabled={paymentLoading}
                        className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 text-white text-sm font-semibold transition-all shadow-lg shadow-emerald-500/20 flex items-center gap-2 disabled:opacity-50"
                        aria-label="Renew +1 interview (1 hour)"
                      >
                        {paymentLoading ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                        {(() => {
                          const r = pricingService.getBasicRenewalPrice(geo?.country_code || 'US');
                          return `Renew +1h · ${pricingService.formatPrice(r.price, r.currencySymbol, r.currency)}`;
                        })()}
                      </button>
                    )}
                  </>
                );
              }

              return (
                <button
                  onClick={() => initiateCheckout('pro')}
                  disabled={paymentLoading}
                  className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-400 hover:to-purple-400 text-white text-sm font-semibold transition-all shadow-lg shadow-blue-500/20 flex items-center gap-2 disabled:opacity-50"
                >
                  {paymentLoading ? <Loader2 size={14} className="animate-spin" /> : <Crown size={14} />}
                  Upgrade to Pro
                </button>
              );
            })()}
          </div>

          {/* Cancel-subscription confirm (Razorpay/India only) */}
          {cancelConfirm && (
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="cancel-sub-title"
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
              onClick={() => setCancelConfirm(false)}
            >
              <div
                className="w-full max-w-md rounded-2xl bg-[#0a0a0f] border border-white/[0.08] shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="p-6 border-b border-white/[0.06] flex items-start justify-between gap-4">
                  <div>
                    <h3 id="cancel-sub-title" className="text-base font-semibold text-white">Cancel subscription?</h3>
                    <p className="text-xs text-gray-400 mt-1.5 leading-relaxed">
                      Your plan stays active until the end of the current billing cycle. You won't be charged again after that, and you can resubscribe any time.
                    </p>
                  </div>
                  <button
                    onClick={() => setCancelConfirm(false)}
                    className="p-1 text-gray-500 hover:text-white transition-colors"
                    aria-label="Close"
                  >
                    <X size={16} />
                  </button>
                </div>
                <div className="p-4 flex items-center justify-end gap-2">
                  <button
                    onClick={() => setCancelConfirm(false)}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-gray-300 transition-all"
                  >
                    Keep subscription
                  </button>
                  <button
                    onClick={handleCancelSubscription}
                    className="px-4 py-2 rounded-lg text-sm font-semibold bg-red-500/90 hover:bg-red-500 text-white transition-all"
                  >
                    Cancel at cycle end
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── ADMIN VIEW (developer only) ──
  if (view === 'admin' && currentUser && licenseService.isDeveloper(currentUser.email)) {
    return <AdminDashboard
      onBack={() => setView('download')}
      currentUser={currentUser}
    />;
  }

  // Mobile auth dispatch helper — common props bag for the three view
  // branches (login / signup / forgot_password). Defined once so the three
  // branches stay tidy. The closure captures handlers by name (resolved at
  // INVOCATION time), so it's safe to declare here even though the actual
  // handler `const`s like renderGoogleFallback are declared in source-order.
  const renderAuthMobile = (m: AuthMode) => (
    <AuthMobile
      mode={m}
      email={email} setEmail={setEmail}
      password={password} setPassword={setPassword}
      name={name} setName={setName}
      showPassword={showPassword} setShowPassword={setShowPassword}
      handleLogin={handleLogin}
      handleSignup={handleSignup}
      handleForgotPassword={handleForgotPassword}
      handleGoogleSuccess={handleGoogleSuccess}
      handleGoogleError={handleGoogleError}
      handleGoogleElectron={handleGoogleElectron}
      renderGoogleFallback={renderGoogleFallback}
      isSubmitting={isSubmitting}
      googleSubmitting={googleSubmitting}
      authError={authError} setAuthError={setAuthError}
      forgotSent={forgotSent} setForgotSent={setForgotSent}
      geo={geo}
      pricing={pricing}
      setView={setView}
    />
  );

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  LANDING PAGE
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (view === 'landing') {
    if (isMobile) {
      return (
        <LandingMobile
          setView={setView}
          geo={geo}
          pricing={pricing}
          handleTierSelect={handleTierSelect}
          isSubmitting={isSubmitting}
          currentUser={currentUser}
          setAuthError={setAuthError}
        />
      );
    }
    return (
      <div
        className="fixed inset-0 overflow-y-auto"
        style={{
          background: 'var(--cream)',
          color: 'var(--ink)',
          fontFamily: 'var(--sans)',
        }}
      >
        {/* Nav — hairline border, no glass, generous breathing */}
        <nav
          className="sticky top-0 z-20 backdrop-blur-md"
          style={{
            background: 'color-mix(in oklab, var(--cream) 92%, transparent)',
            borderBottom: '1px solid var(--cream-line)',
          }}
        >
          <div className="max-w-6xl mx-auto flex items-center justify-between px-8 py-5">
            <Logo size="md" theme="light" />
            <div className="flex items-center gap-1">
              <button
                onClick={() => setView('tutorials')}
                className="px-4 py-2 text-sm font-medium hover:opacity-100 transition-opacity"
                style={{ color: 'var(--ink-muted)' }}
              >
                How it works
              </button>
              <button
                onClick={() => { document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth' }); }}
                className="px-4 py-2 text-sm font-medium hover:opacity-100 transition-opacity"
                style={{ color: 'var(--ink-muted)' }}
              >
                Pricing
              </button>
              <button
                onClick={() => setView('docs')}
                className="px-4 py-2 text-sm font-medium hover:opacity-100 transition-opacity"
                style={{ color: 'var(--ink-muted)' }}
              >
                Docs
              </button>
              <button
                onClick={() => setView('login')}
                className="px-4 py-2 text-sm font-medium hover:opacity-100 transition-opacity"
                style={{ color: 'var(--ink-muted)' }}
              >
                Sign in
              </button>
              <button
                onClick={() => setView('signup')}
                className="ml-3 inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-medium transition-all"
                style={{
                  background: 'var(--ink)',
                  color: 'var(--cream)',
                  letterSpacing: '-0.005em',
                }}
              >
                Get started
                <PhArrowRight size={14} weight="bold" />
              </button>
            </div>
          </div>
        </nav>

        {/* Hero — editorial, restrained, serif display */}
        <section className="max-w-5xl mx-auto px-8 pt-24 pb-20">
          <div className="inline-flex items-center gap-2 mb-10" style={{ color: 'var(--ink-muted)' }}>
            <PhSparkle size={14} weight="duotone" style={{ color: 'var(--accent)' }} />
            <span className="text-[12px] font-medium uppercase tracking-[0.18em]">
              Real-time interview intelligence
            </span>
          </div>
          <h1
            className="text-[56px] md:text-[80px] leading-[1.02] mb-8"
            style={{
              fontFamily: 'var(--serif)',
              fontWeight: 400,
              letterSpacing: '-0.025em',
              color: 'var(--ink)',
            }}
          >
            Walk into every<br />
            interview <em style={{ fontStyle: 'italic', fontWeight: 400 }}>already prepared</em>.
          </h1>
          <p
            className="text-[19px] md:text-[21px] max-w-2xl mb-12"
            style={{
              color: 'var(--ink-soft)',
              lineHeight: 1.55,
              letterSpacing: '-0.005em',
            }}
          >
            A quiet copilot that listens to your interview, holds your résumé and the role in
            mind, and shapes an answer in your voice — character-by-character, in real time.
            Invisible to the interviewer. Tuned to you.
          </p>
          <div className="flex items-center gap-3 mb-14">
            <button
              onClick={() => setView('signup')}
              className="inline-flex items-center gap-2 px-7 py-3.5 rounded-full text-[15px] font-medium transition-all hover:opacity-90"
              style={{
                background: 'var(--ink)',
                color: 'var(--cream)',
                letterSpacing: '-0.005em',
              }}
            >
              Start free
              <PhArrowRight size={15} weight="bold" />
            </button>
            <button
              onClick={() => setView('tutorials')}
              className="inline-flex items-center gap-2 px-7 py-3.5 rounded-full text-[15px] font-medium transition-all"
              style={{
                background: 'transparent',
                color: 'var(--ink)',
                border: '1px solid var(--cream-line)',
              }}
            >
              See how it works
            </button>
          </div>
          <div
            className="flex flex-wrap items-center gap-x-8 gap-y-3 pt-10"
            style={{ borderTop: '1px solid var(--cream-line)', color: 'var(--ink-muted)' }}
          >
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <PhUsers size={16} weight="duotone" />
              10,000+ candidates
            </div>
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <PhStar size={16} weight="duotone" />
              4.9 / 5 rating
            </div>
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <PhGlobe size={16} weight="duotone" />
              Available in 50+ countries
            </div>
          </div>
        </section>

        {/* What it does — editorial three-column */}
        <section
          className="max-w-6xl mx-auto px-8 py-24"
          style={{ borderTop: '1px solid var(--cream-line)' }}
        >
          <div className="mb-16">
            <span
              className="text-[12px] font-medium uppercase tracking-[0.18em]"
              style={{ color: 'var(--ink-muted)' }}
            >
              Capabilities
            </span>
            <h2
              className="text-[40px] md:text-[52px] leading-[1.05] mt-4 max-w-3xl"
              style={{ fontFamily: 'var(--serif)', fontWeight: 400, letterSpacing: '-0.02em', color: 'var(--ink)' }}
            >
              Built for the moment that decides the offer.
            </h2>
          </div>
          <div className="grid md:grid-cols-3 gap-x-12 gap-y-14">
            {[
              {
                Icon: PhHeadphones,
                title: 'Hears the interviewer',
                body: 'System-audio capture transcribes every question with sub-second latency. Word-level streaming, no upload, no waiting.',
              },
              {
                Icon: PhCpu,
                title: 'Reasons in your voice',
                body: 'Picks the model that fits the question — GPT, Claude Sonnet 4.6, Gemini, Grok, Llama — and shapes the answer to your résumé and the role.',
              },
              {
                Icon: PhShield,
                title: 'Invisible on the call',
                body: 'Window content is excluded from screen-share at the OS level. Your interviewer sees you. They never see the copilot.',
              },
              {
                Icon: PhMonitor,
                title: 'Reads the screen',
                body: 'Auto-Solve captures the coding-platform screenshot and types the answer into the editor on demand. CoderPad, HackerRank, LeetCode.',
              },
              {
                Icon: PhChart,
                title: 'Holds your context',
                body: 'Resume, JD, and notes stay in working memory across the whole interview. Answers reference projects you actually shipped, not generic ones.',
              },
              {
                Icon: PhBolt,
                title: 'Pop-out + PiP',
                body: 'A glanceable window that floats over Zoom, Meet, or Teams. Resize, dim, or hide it without breaking the interview.',
              },
            ].map(({ Icon, title, body }) => (
              <div key={title}>
                <Icon size={28} weight="duotone" style={{ color: 'var(--accent)' }} />
                <h3
                  className="mt-5 text-[20px]"
                  style={{
                    fontFamily: 'var(--serif)',
                    fontWeight: 500,
                    letterSpacing: '-0.015em',
                    color: 'var(--ink)',
                  }}
                >
                  {title}
                </h3>
                <p
                  className="mt-2 text-[15px]"
                  style={{ color: 'var(--ink-soft)', lineHeight: 1.6 }}
                >
                  {body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* How it works — three numbered steps, no card chrome */}
        <section
          className="max-w-5xl mx-auto px-8 py-24"
          style={{ borderTop: '1px solid var(--cream-line)' }}
        >
          <div className="mb-16">
            <span
              className="text-[12px] font-medium uppercase tracking-[0.18em]"
              style={{ color: 'var(--ink-muted)' }}
            >
              How it works
            </span>
            <h2
              className="text-[40px] md:text-[52px] leading-[1.05] mt-4 max-w-3xl"
              style={{ fontFamily: 'var(--serif)', fontWeight: 400, letterSpacing: '-0.02em', color: 'var(--ink)' }}
            >
              Three steps. Then you forget it's there.
            </h2>
          </div>
          <ol className="space-y-12">
            {[
              {
                n: '01',
                title: 'Install the desktop app',
                body: 'Download for macOS, Windows, or Linux. Sign in once. Your license binds to this device.',
              },
              {
                n: '02',
                title: 'Drop in your résumé and the JD',
                body: 'A single drag. The copilot extracts your story and the role in one preflight call so the first answer arrives instantly.',
              },
              {
                n: '03',
                title: 'Open your interview',
                body: 'Start the mic. Answers stream as the interviewer speaks. Glance at the popout, deliver in your own voice.',
              },
            ].map((s) => (
              <li
                key={s.n}
                className="grid md:grid-cols-[120px_1fr] gap-x-10 pb-12"
                style={{ borderBottom: '1px solid var(--cream-line)' }}
              >
                <div
                  className="text-[15px] font-medium tabular-nums tracking-[0.06em]"
                  style={{ color: 'var(--ink-muted)' }}
                >
                  {s.n}
                </div>
                <div>
                  <h3
                    className="text-[26px]"
                    style={{ fontFamily: 'var(--serif)', fontWeight: 500, letterSpacing: '-0.015em' }}
                  >
                    {s.title}
                  </h3>
                  <p
                    className="mt-3 text-[16px] max-w-2xl"
                    style={{ color: 'var(--ink-soft)', lineHeight: 1.65 }}
                  >
                    {s.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* Pricing */}
        <section
          id="pricing"
          className="max-w-6xl mx-auto px-8 py-24"
          style={{ borderTop: '1px solid var(--cream-line)' }}
        >
          <div className="mb-16">
            <span
              className="text-[12px] font-medium uppercase tracking-[0.18em]"
              style={{ color: 'var(--ink-muted)' }}
            >
              Pricing
            </span>
            <h2
              className="text-[40px] md:text-[52px] leading-[1.05] mt-4 max-w-3xl"
              style={{ fontFamily: 'var(--serif)', fontWeight: 400, letterSpacing: '-0.02em', color: 'var(--ink)' }}
            >
              Pay for the interviews you take.
            </h2>
            {geo && (
              <p
                className="mt-4 text-[14px]"
                style={{ color: 'var(--ink-muted)' }}
              >
                Pricing for {geo.country_name}. We adjust regionally so the offer is always fair.
              </p>
            )}
          </div>
          {pricing && (
            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
              {pricing.tiers.map((tier) => (
                <PricingCard key={tier.id} tier={tier} onSelect={handleTierSelect} isLoading={isSubmitting} />
              ))}
            </div>
          )}
        </section>

        {/* Trust strip */}
        <section
          className="max-w-5xl mx-auto px-8 py-20"
          style={{ borderTop: '1px solid var(--cream-line)' }}
        >
          <div className="grid md:grid-cols-3 gap-x-12 gap-y-10">
            {[
              { Icon: PhShield, label: 'Device-bound licenses', body: 'A license activates on the device that bought it. No silent sharing.' },
              { Icon: PhLock, label: 'Server-validated sessions', body: 'Every active interview is checked against our backend in real time.' },
              { Icon: PhGlobe, label: 'Regional pricing, enforced', body: 'No VPN-shopping for cheaper tiers. Your country, your fair price.' },
            ].map(({ Icon, label, body }) => (
              <div key={label}>
                <Icon size={22} weight="duotone" style={{ color: 'var(--ink)' }} />
                <h4
                  className="mt-4 text-[15px] font-medium"
                  style={{ color: 'var(--ink)', letterSpacing: '-0.005em' }}
                >
                  {label}
                </h4>
                <p
                  className="mt-1.5 text-[13.5px]"
                  style={{ color: 'var(--ink-muted)', lineHeight: 1.6 }}
                >
                  {body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Closing CTA */}
        <section className="max-w-5xl mx-auto px-8 py-24 text-center">
          <h2
            className="text-[44px] md:text-[60px] leading-[1.05] mb-8"
            style={{ fontFamily: 'var(--serif)', fontWeight: 400, letterSpacing: '-0.02em', color: 'var(--ink)' }}
          >
            Your next interview is on Tuesday.<br />
            <em style={{ fontStyle: 'italic' }}>Be ready by Monday.</em>
          </h2>
          <button
            onClick={() => setView('signup')}
            className="inline-flex items-center gap-2 px-8 py-4 rounded-full text-[15px] font-medium transition-all hover:opacity-90"
            style={{ background: 'var(--ink)', color: 'var(--cream)' }}
          >
            Start free
            <PhArrowRight size={15} weight="bold" />
          </button>
          <p className="mt-6 text-[13px]" style={{ color: 'var(--ink-muted)' }}>
            No card. 30-minute trial. Upgrade only if it earned the offer.
          </p>
        </section>

        {/* Footer */}
        <footer style={{ borderTop: '1px solid var(--cream-line)' }}>
          <div className="max-w-6xl mx-auto px-8 py-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <Logo size="sm" theme="light" />
            <div
              className="flex items-center gap-7 text-[13px]"
              style={{ color: 'var(--ink-muted)' }}
            >
              <span>© {new Date().getFullYear()} minicaai</span>
              <span>Privacy</span>
              <span>Terms</span>
              <button
                onClick={() => { if (currentUser) { setView('support'); } else { setView('login'); setAuthError('Please sign in to access support'); } }}
                className="transition-colors hover:opacity-100"
                style={{ color: 'var(--ink-muted)' }}
              >
                Support
              </button>
            </div>
          </div>
        </footer>
      </div>
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  LOGIN — cream-on-ink, editorial typography
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (view === 'login') {
    if (isMobile) return renderAuthMobile('login');
    return (
      <div
        className="fixed inset-0 overflow-y-auto"
        style={{ background: 'var(--cream)', color: 'var(--ink)', fontFamily: 'var(--sans)' }}
      >
        <div className="min-h-full flex items-center justify-center px-4 py-8">
        <div className="w-full max-w-[400px]">
          <div
            className="auth-card relative rounded-2xl p-7 pt-6"
            style={{ background: 'var(--cream-soft)', border: '1px solid var(--cream-line)' }}
          >
            <button
              onClick={() => setView('landing')}
              className="auth-close absolute top-4 right-4 w-8 h-8 rounded-full flex items-center justify-center"
              style={{ color: 'var(--ink-muted)' }}
              aria-label="Close"
            >
              <X size={16} />
            </button>

            <Logo size="md" theme="light" />
            <h2
              className="mt-5 text-[22px]"
              style={{ fontFamily: 'var(--serif)', fontWeight: 500, letterSpacing: '-0.02em' }}
            >
              Welcome back.
            </h2>
            <p className="mt-1 text-[13px] mb-5" style={{ color: 'var(--ink-muted)' }}>
              Sign in to continue with your interview copilot.
            </p>

            <form onSubmit={handleLogin} className="space-y-3">
              <div>
                <label className="block text-[10.5px] font-semibold mb-1" style={{ color: 'var(--ink-muted)', letterSpacing: '0.02em' }}>EMAIL</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="auth-input w-full px-3.5 py-2.5 rounded-lg text-[13.5px]"
                  style={{ background: 'var(--cream)', border: '1px solid var(--cream-line)', color: 'var(--ink)' }}
                  required
                  autoFocus
                  autoComplete="email"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-[11.5px] font-medium" style={{ color: 'var(--ink-muted)', letterSpacing: '0.02em' }}>PASSWORD</label>
                  <button
                    type="button"
                    onClick={() => { setAuthError(null); setForgotSent(false); setView('forgot_password'); }}
                    className="auth-link text-[12px] font-medium"
                    style={{ color: 'var(--accent)' }}
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="auth-input w-full px-3.5 py-2.5 pr-10 rounded-lg text-[13.5px]"
                    style={{ background: 'var(--cream)', border: '1px solid var(--cream-line)', color: 'var(--ink)' }}
                    required
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="auth-close absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full flex items-center justify-center"
                    style={{ color: 'var(--ink-muted)' }}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              {authError && (
                <div
                  className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-[12.5px]"
                  role="alert"
                  style={{ background: 'color-mix(in oklab, var(--accent) 10%, transparent)', border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)', color: 'var(--accent)' }}
                >
                  <AlertTriangle size={13} style={{ marginTop: 1, flexShrink: 0 }} />
                  <span style={{ lineHeight: 1.45 }}>{authError}</span>
                </div>
              )}
              <button
                type="submit"
                disabled={isSubmitting || googleSubmitting || !email.trim() || !password.trim()}
                className="auth-submit w-full py-2.5 rounded-full text-[13.5px] font-medium inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: 'var(--ink)', color: 'var(--cream)' }}
              >
                {/* Always render an icon slot (spinner during submit, arrow
                    otherwise) so the button width and text position stay
                    fixed across states — no layout shift on click. */}
                {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : null}
                <span>Sign in</span>
                {!isSubmitting ? <PhArrowRight size={14} weight="bold" /> : null}
              </button>
            </form>

            {/* Google Sign-In */}
            {GOOGLE_CLIENT_ID && (
              <>
                <div className="mt-5 flex items-center gap-3">
                  <div className="flex-1 h-px" style={{ background: 'var(--cream-line)' }} />
                  <span className="text-[10px] uppercase tracking-[0.18em]" style={{ color: 'var(--ink-faint)' }}>or</span>
                  <div className="flex-1 h-px" style={{ background: 'var(--cream-line)' }} />
                </div>
                {isElectron ? (
                  <button
                    onClick={handleGoogleElectron}
                    disabled={isSubmitting || googleSubmitting}
                    className="auth-submit mt-3 w-full py-2.5 px-4 rounded-full text-[13.5px] font-medium flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ background: 'var(--cream)', border: '1px solid var(--cream-line)', color: 'var(--ink)' }}
                  >
                    {googleSubmitting ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                    )}
                    {googleSubmitting ? 'Waiting for sign-in…' : 'Continue with Google'}
                  </button>
                ) : (
                  <div className="mt-3 flex justify-center [&_iframe]:rounded-full">
                    <GoogleLogin
                      onSuccess={handleGoogleSuccess}
                      onError={handleGoogleError}
                      theme="outline"
                      size="large"
                      width="340"
                      text="signin_with"
                      shape="pill"
                    />
                  </div>
                )}
                {isElectron && renderGoogleFallback()}
              </>
            )}

            <div className="mt-5 text-center text-[12.5px]" style={{ color: 'var(--ink-muted)' }}>
              No account?{' '}
              <button
                onClick={() => setView('signup')}
                className="auth-link font-medium"
                style={{ color: 'var(--ink)' }}
              >
                Create one
              </button>
            </div>
            {geo && (
              <div className="mt-4 flex items-center justify-center gap-1.5 text-[10.5px]" style={{ color: 'var(--ink-faint)' }}>
                <PhLock size={11} weight="duotone" /> Secure connection from {geo.country_name}
              </div>
            )}
          </div>
        </div>
        </div>
      </div>
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  FORGOT PASSWORD — cream theme, restrained
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (view === 'forgot_password') {
    if (isMobile) return renderAuthMobile('forgot_password');
    return (
      <div
        className="fixed inset-0 overflow-y-auto"
        style={{ background: 'var(--cream)', color: 'var(--ink)', fontFamily: 'var(--sans)' }}
      >
        <div className="min-h-full flex items-center justify-center px-4 py-8">
        <div className="w-full max-w-[400px]">
          <div
            className="auth-card relative rounded-2xl p-7 pt-6"
            style={{ background: 'var(--cream-soft)', border: '1px solid var(--cream-line)' }}
          >
            <button
              onClick={() => { setAuthError(null); setForgotSent(false); setView('login'); }}
              className="auth-close absolute top-4 left-4 w-8 h-8 rounded-full flex items-center justify-center"
              style={{ color: 'var(--ink-muted)' }}
              aria-label="Back to sign in"
            >
              <ArrowLeft size={16} />
            </button>
            <button
              onClick={() => { setAuthError(null); setForgotSent(false); setView('landing'); }}
              className="auth-close absolute top-4 right-4 w-8 h-8 rounded-full flex items-center justify-center"
              style={{ color: 'var(--ink-muted)' }}
              aria-label="Close"
            >
              <X size={16} />
            </button>

            <div className="mt-7 mb-6">
              <span
                className="text-[12px] font-medium uppercase tracking-[0.18em]"
                style={{ color: 'var(--ink-muted)' }}
              >
                Reset password
              </span>
              <h2
                className="mt-3 text-[28px]"
                style={{ fontFamily: 'var(--serif)', fontWeight: 500, letterSpacing: '-0.02em' }}
              >
                {forgotSent ? 'Check your email.' : 'Forgot your password?'}
              </h2>
              <p className="mt-2 text-[14px]" style={{ color: 'var(--ink-muted)', lineHeight: 1.6 }}>
                {forgotSent
                  ? `If an account exists for ${email}, a reset link is on its way. The link expires in one hour.`
                  : 'Enter the email you signed up with and we’ll send you a link to reset your password.'}
              </p>
            </div>

            {!forgotSent ? (
              <form onSubmit={handleForgotPassword} className="space-y-3">
                <div>
                  <label className="block text-[10.5px] font-semibold mb-1" style={{ color: 'var(--ink-muted)', letterSpacing: '0.02em' }}>EMAIL</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="auth-input w-full px-3.5 py-2.5 rounded-lg text-[13.5px]"
                    style={{ background: 'var(--cream)', border: '1px solid var(--cream-line)', color: 'var(--ink)' }}
                    required
                    autoFocus
                    autoComplete="email"
                  />
                </div>
                {authError && (
                  <div
                    className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-[12.5px]"
                    role="alert"
                    style={{ background: 'color-mix(in oklab, var(--accent) 10%, transparent)', border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)', color: 'var(--accent)' }}
                  >
                    <AlertTriangle size={13} style={{ marginTop: 1, flexShrink: 0 }} />
                    <span style={{ lineHeight: 1.45 }}>{authError}</span>
                  </div>
                )}
                <button
                  type="submit"
                  disabled={isSubmitting || !email.trim()}
                  className="auth-submit w-full py-2.5 rounded-full text-[13.5px] font-medium inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ background: 'var(--ink)', color: 'var(--cream)' }}
                >
                  {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : null}
                  <span>Send reset link</span>
                </button>
              </form>
            ) : (
              <button
                onClick={() => { setForgotSent(false); setAuthError(null); setView('login'); }}
                className="auth-submit w-full py-2.5 rounded-full text-[13.5px] font-medium"
                style={{ background: 'var(--ink)', color: 'var(--cream)' }}
              >
                Back to sign in
              </button>
            )}

            <div className="mt-5 text-center text-[12.5px]" style={{ color: 'var(--ink-muted)' }}>
              Remembered it?{' '}
              <button
                onClick={() => { setAuthError(null); setForgotSent(false); setView('login'); }}
                className="auth-link font-medium"
                style={{ color: 'var(--ink)' }}
              >
                Sign in
              </button>
            </div>
          </div>
        </div>
        </div>
      </div>
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  SIGNUP — cream-on-ink, editorial typography
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (view === 'signup') {
    if (isMobile) return renderAuthMobile('signup');
    return (
      <div
        className="fixed inset-0 overflow-y-auto"
        style={{ background: 'var(--cream)', color: 'var(--ink)', fontFamily: 'var(--sans)' }}
      >
        <div className="min-h-full flex items-center justify-center px-4 py-8">
        <div className="w-full max-w-[400px]">
          <div
            className="auth-card relative rounded-2xl p-7 pt-6"
            style={{ background: 'var(--cream-soft)', border: '1px solid var(--cream-line)' }}
          >
            <button
              onClick={() => setView('landing')}
              className="auth-close absolute top-4 right-4 w-8 h-8 rounded-full flex items-center justify-center"
              style={{ color: 'var(--ink-muted)' }}
              aria-label="Close"
            >
              <X size={16} />
            </button>

            <Logo size="md" theme="light" />
            <h2
              className="mt-5 text-[22px]"
              style={{ fontFamily: 'var(--serif)', fontWeight: 500, letterSpacing: '-0.02em' }}
            >
              Create your account.
            </h2>
            <p className="mt-1 text-[13px] mb-5" style={{ color: 'var(--ink-muted)' }}>
              Free 30-minute trial. No card. Upgrade only if it earned the offer.
            </p>

            <form onSubmit={handleSignup} className="space-y-3">
              <div>
                <label className="block text-[10.5px] font-semibold mb-1" style={{ color: 'var(--ink-muted)', letterSpacing: '0.02em' }}>NAME</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  className="auth-input w-full px-3.5 py-2.5 rounded-lg text-[13.5px]"
                  style={{ background: 'var(--cream)', border: '1px solid var(--cream-line)', color: 'var(--ink)' }}
                  autoFocus
                  autoComplete="name"
                />
              </div>
              <div>
                <label className="block text-[10.5px] font-semibold mb-1" style={{ color: 'var(--ink-muted)', letterSpacing: '0.02em' }}>EMAIL</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="auth-input w-full px-3.5 py-2.5 rounded-lg text-[13.5px]"
                  style={{ background: 'var(--cream)', border: '1px solid var(--cream-line)', color: 'var(--ink)' }}
                  required
                  autoComplete="email"
                />
              </div>
              <div>
                <label className="block text-[10.5px] font-semibold mb-1" style={{ color: 'var(--ink-muted)', letterSpacing: '0.02em' }}>PASSWORD</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Create a password (min 8 chars)"
                    className="auth-input w-full px-3.5 py-2.5 pr-10 rounded-lg text-[13.5px]"
                    style={{ background: 'var(--cream)', border: '1px solid var(--cream-line)', color: 'var(--ink)' }}
                    required
                    minLength={8}
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="auth-close absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full flex items-center justify-center"
                    style={{ color: 'var(--ink-muted)' }}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              {authError && (
                <div
                  className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-[12.5px]"
                  role="alert"
                  style={{ background: 'color-mix(in oklab, var(--accent) 10%, transparent)', border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)', color: 'var(--accent)' }}
                >
                  <AlertTriangle size={13} style={{ marginTop: 1, flexShrink: 0 }} />
                  <span style={{ lineHeight: 1.45 }}>{authError}</span>
                </div>
              )}
              <button
                type="submit"
                disabled={isSubmitting || googleSubmitting || !email.trim() || !password.trim()}
                className="auth-submit w-full py-2.5 rounded-full text-[13.5px] font-medium inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: 'var(--ink)', color: 'var(--cream)' }}
              >
                {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : null}
                <span>Create account</span>
                {!isSubmitting ? <PhArrowRight size={14} weight="bold" /> : null}
              </button>
              <p className="text-[11px] text-center leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
                By creating an account, you agree to our Terms and Privacy Policy.
              </p>
            </form>

            {/* Google Sign-Up */}
            {GOOGLE_CLIENT_ID && (
              <>
                <div className="mt-5 flex items-center gap-3">
                  <div className="flex-1 h-px" style={{ background: 'var(--cream-line)' }} />
                  <span className="text-[10px] uppercase tracking-[0.18em]" style={{ color: 'var(--ink-faint)' }}>or</span>
                  <div className="flex-1 h-px" style={{ background: 'var(--cream-line)' }} />
                </div>
                {isElectron ? (
                  <button
                    onClick={handleGoogleElectron}
                    disabled={isSubmitting || googleSubmitting}
                    className="auth-submit mt-3 w-full py-2.5 px-4 rounded-full text-[13.5px] font-medium flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ background: 'var(--cream)', border: '1px solid var(--cream-line)', color: 'var(--ink)' }}
                  >
                    {googleSubmitting ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                    )}
                    {googleSubmitting ? 'Waiting for sign-up…' : 'Continue with Google'}
                  </button>
                ) : (
                  <div className="mt-3 flex justify-center [&_iframe]:rounded-full">
                    <GoogleLogin
                      onSuccess={handleGoogleSuccess}
                      onError={handleGoogleError}
                      theme="outline"
                      size="large"
                      width="340"
                      text="signup_with"
                      shape="pill"
                    />
                  </div>
                )}
                {isElectron && renderGoogleFallback()}
              </>
            )}

            <div className="mt-5 text-center text-[12.5px]" style={{ color: 'var(--ink-muted)' }}>
              Already have an account?{' '}
              <button
                onClick={() => setView('login')}
                className="auth-link font-medium"
                style={{ color: 'var(--ink)' }}
              >
                Sign in
              </button>
            </div>
            {geo && (
              <div className="mt-4 flex items-center justify-center gap-1.5 text-[10.5px]" style={{ color: 'var(--ink-faint)' }}>
                <PhGlobe size={11} weight="duotone" /> {geo.country_name} &middot; {pricing?.currencySymbol} {pricing?.currency}
              </div>
            )}
          </div>
        </div>
        </div>
      </div>
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  LIVE SUPPORT CHAT — full-screen "Minica" view
  //  Backed by the universal SupportBot component (AI-first, with Slack +
  //  email handoff to a real human). Anonymous OK — we no longer require
  //  login here, so prospects can talk to Minica before signing up.
  //  The legacy WebSocket-based /ws/support backbone (server/src/index.js)
  //  remains intact as future scaffolding for a real agent dashboard.
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (view === 'support') {
    return (
      <SupportBot
        mode="view"
        currentUser={currentUser ? { email: currentUser.email, name: currentUser.name, id: (currentUser as any).id } : null}
        tier={currentLicense?.tier ?? null}
        authToken={licenseService.getToken() || null}
        onClose={() => setView(currentUser ? 'download' : 'landing')}
      />
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  PRICING PAGE (Free + Pro only)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (view === 'pricing') {
    if (isMobile) {
      return (
        <PricingMobile
          setView={setView}
          geo={geo}
          pricing={pricing}
          handleTierSelect={handleTierSelect}
          isSubmitting={isSubmitting}
          currentUser={currentUser}
        />
      );
    }
    return (
      <div className="fixed inset-0 bg-[#050507] text-white overflow-y-auto">
        <AnimatedBackground />
        <NoiseOverlay />
        <nav className="relative z-10 flex items-center justify-between px-6 py-4 max-w-6xl mx-auto">
          <Logo size="md" />
          <div className="flex items-center gap-3">
            <button onClick={() => setView('landing')} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-400 hover:text-white transition-colors">Back</button>
            <button onClick={() => setView('login')} className="px-4 py-2 rounded-lg text-sm font-medium bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] transition-all">Sign In</button>
          </div>
        </nav>

        <div className="relative z-10 max-w-4xl mx-auto px-6 pt-16 pb-20">
          <div className="text-center mb-14">
            <h1 className="text-3xl md:text-4xl font-bold mb-4">Choose your plan</h1>
            <p className="text-gray-500 max-w-lg mx-auto">Start free, upgrade when you're ready. Cancel anytime.</p>
            {geo && (
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/[0.03] border border-white/[0.06] text-gray-500 text-xs mt-6">
                <Globe size={12} /> Pricing for {geo.country_name} ({pricing?.currencySymbol} {pricing?.currency})
              </div>
            )}
          </div>

          {pricing && (
            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-6xl mx-auto">
              {pricing.tiers.map((tier) => (
                <PricingCard key={tier.id} tier={tier} onSelect={handleTierSelect} isLoading={isSubmitting} />
              ))}
            </div>
          )}

          {/* Comparison table — all four tiers. The previous Free-vs-Pro
              two-column layout dated from when the product only had two
              paid tiers, and silently hid Basic + Max. That made "All 4
              models" on Pro read like "all models" to a user who hadn't
              seen Max — exactly the source of the long-running "Subscribe
              to Pro for all models" confusion. */}
          <div className="mt-16 max-w-3xl mx-auto">
            <h3 className="text-lg font-bold text-center mb-8">Feature comparison</h3>
            <div className="border border-white/[0.06] rounded-xl overflow-hidden">
              <div className="grid grid-cols-5 text-xs bg-white/[0.03]">
                <div className="px-3 py-3 text-gray-500 font-medium">Feature</div>
                <div className="px-3 py-3 text-gray-400 text-center font-bold uppercase tracking-wider">Free</div>
                <div className="px-3 py-3 text-emerald-400 text-center font-bold uppercase tracking-wider">Basic</div>
                <div className="px-3 py-3 text-blue-400 text-center font-bold uppercase tracking-wider">Pro</div>
                <div className="px-3 py-3 text-amber-400 text-center font-bold uppercase tracking-wider">Max</div>
              </div>
              {[
                { feature: 'Interview sessions', free: '5/mo', basic: '3 (14d)', pro: 'Unlimited', max: 'Unlimited' },
                { feature: 'AI Models',          free: 'Gemini', basic: '4 models', pro: '4 models', max: '5 incl. Claude' },
                { feature: 'Auto-Type',          free: '—',      basic: '—',         pro: '—',        max: 'Yes' },
                { feature: 'Train Model',        free: '—',      basic: '—',         pro: '—',        max: 'Yes' },
                { feature: 'Screen capture',     free: '—',      basic: 'Yes',       pro: 'Yes',      max: 'Yes' },
                { feature: 'Auto-solve',         free: '—',      basic: 'Yes',       pro: 'Yes',      max: 'Yes' },
                { feature: 'Pop-out overlay',    free: '—',      basic: 'Yes',       pro: 'Yes',      max: 'Yes' },
                { feature: 'Context files',      free: '1',      basic: 'Unlimited', pro: 'Unlimited', max: 'Unlimited' },
                { feature: 'Session history',    free: '—',      basic: 'Yes',       pro: 'Yes',      max: 'Yes' },
                { feature: 'Support',            free: 'Community', basic: 'Email',  pro: 'Priority', max: 'Priority' },
              ].map(({ feature, free, basic, pro, max }, i) => (
                <div key={i} className="grid grid-cols-5 text-xs border-t border-white/[0.04]">
                  <div className="px-3 py-2.5 text-gray-300 font-medium">{feature}</div>
                  <div className="px-3 py-2.5 text-gray-500 text-center">{free}</div>
                  <div className="px-3 py-2.5 text-emerald-300/80 text-center">{basic}</div>
                  <div className="px-3 py-2.5 text-blue-300/80 text-center">{pro}</div>
                  <div className="px-3 py-2.5 text-amber-300 text-center font-medium">{max}</div>
                </div>
              ))}
            </div>
          </div>

          {/* FAQ */}
          <div className="mt-16 max-w-2xl mx-auto">
            <h3 className="text-lg font-bold text-center mb-8">FAQ</h3>
            <div className="space-y-4">
              {[
                { q: 'Can I share the app with others?', a: 'No. Each license is bound to a specific device. Shared copies will not be able to authenticate and will be locked.' },
                { q: 'What happens if I use a VPN?', a: 'VPN and proxy connections are detected and blocked. You must use a direct connection from your registered country.' },
                { q: 'Can I cancel anytime?', a: 'Yes. Cancel from your account settings. Access continues until the end of your billing period.' },
                { q: 'What if I change devices?', a: 'Contact our live support to transfer your license. Each Pro account supports up to 3 devices.' },
              ].map(({ q, a }, i) => (
                <div key={i} className="p-5 rounded-xl border border-white/[0.06] bg-white/[0.02]">
                  <h4 className="text-sm font-semibold text-white mb-2">{q}</h4>
                  <p className="text-sm text-gray-500 leading-relaxed">{a}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
};

// Wrap with Google OAuth Provider + mount the floating "Minica" bubble
// alongside the page content. The bubble sits at z-[60], so any z-[100]
// full-screen takeover (e.g., the view==='support' takeover) naturally
// covers it — no double-rendering of chat surfaces.
//
// The floating bubble lives OUTSIDE SubscriptionGateInner so it isn't
// affected by the inner's many early-return view branches. It pulls the
// auth token (if any) from licenseService directly; the server resolves
// the tier from the JWT in /api/v1/support/tier, so anonymous and
// authenticated users both work without prop drilling.
export const SubscriptionGate: React.FC<SubscriptionGateProps> = (props) => {
  const inner = GOOGLE_CLIENT_ID ? (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <SubscriptionGateInner {...props} />
    </GoogleOAuthProvider>
  ) : (
    <SubscriptionGateInner {...props} />
  );
  return (
    <>
      {inner}
      <SupportBot mode="floating" authToken={licenseService.getToken() || null} />
    </>
  );
};
