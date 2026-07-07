// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ManageSubscription — full-screen in-app billing center.
//
//  Pulled together so the user has ONE place to see plan + status +
//  payment provider + actions, instead of scattering tier badges,
//  upgrade buttons, cancel flows across Settings + chat header +
//  popout. Entry point: the tier badge in the chat header.
//
//  All actions piggyback on existing server endpoints:
//    GET  /api/v1/payments/subscription   — live status snapshot
//    POST /api/v1/payments/portal         — Stripe Customer Portal URL
//    POST /api/v1/payments/cancel-razorpay — Razorpay self-cancel
//    POST /api/v1/payments/upgrade-tier   — Pro ↔ Max swap (existing sub)
//    POST /api/v1/payments/create-checkout — start a new Stripe sub
//    (Razorpay equivalents handled by the existing inline checkout flow
//    on the SubscriptionGate side; we link out for a fresh checkout.)
//
//  Visual: matches the in-app dark surface (rgba(20,20,28,0.92) etc.)
//  rather than the cream landing aesthetic — this is an *inside* page.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  X, Crown, Zap, Sparkles, Check, Loader2, ExternalLink, AlertTriangle,
  Cpu, ChevronRight, Info, ShieldCheck, UploadCloud,
} from 'lucide-react';
import { WizardHat } from './WizardHat';
import { UltraMark } from './UltraMark';
// Precious-material marks for the pricing rows: Basic→bronze, Pro→platinum,
// Max→gold — a value ladder that tops out at Ultra's amethyst gem. See
// TierMarks.tsx. (The identity chips above keep their semantic Zap/Crown/
// WizardHat marks on currentColor.)
import { BasicMark, ProMark, MaxMark } from './TierMarks';
import { licenseService, UserProfile, LicenseData } from './services/licenseService';
import { backfillAllConversations, BackfillProgress } from './services/aiProxyService';
import { RefundPolicy } from './RefundPolicy';
import { useAnimatedModal } from './hooks/useAnimatedModal';

// Vite inlines import.meta.env.PROD at build time. In dev, fall through to
// VITE_SERVER_URL so a local-server setup actually reaches the local API
// instead of silently hitting prod (which returns 401 on local JWTs).
const API_BASE = (import.meta as any).env?.PROD
  ? 'https://api.minicaai.com'
  : ((import.meta as any).env?.VITE_SERVER_URL || 'https://api.minicaai.com');

interface SubscriptionStatus {
  status: 'active' | 'canceling' | 'trial' | 'expired' | 'revoked' | 'paused' | 'refunded' | 'disputed' | 'none';
  tier: 'free' | 'basic' | 'pro' | 'max' | 'ultra';
  provider: 'stripe' | 'razorpay' | null;
  expires_at: number;
  sessions_used: number;
  sessions_limit: number;
  // Surfaced by the server when a Stripe sub has cancel_at_period_end=true
  // AND we're still inside the paid window. Lets the UI render an explicit
  // "Cancellation scheduled — keep access until <date>" banner with a
  // Reactivate CTA so users don't lose retention to a confused mis-read of
  // an "Active" badge that's actually scheduled to end.
  cancel_at_period_end?: boolean;
  cancels_at?: number | null;
}

interface ManageSubscriptionProps {
  isOpen: boolean;
  onClose: () => void;
  userProfile: UserProfile | null;
  userLicense: LicenseData | null;
  // Triggers the existing upgrade flow (re-uses SubscriptionGate's checkout
  // path so we don't duplicate Razorpay/Stripe SDK plumbing).
  onUpgradeRequested: (targetTier: 'basic' | 'pro' | 'max' | 'ultra') => void;
  // Optional callback fired after the user successfully edits their
  // profile here (display name) so MainApp can keep its userProfile state
  // in sync without a separate fetch. licenseService already mirrors the
  // change into localStorage; this just lets the in-memory React state
  // catch up immediately so tier badges and AI prompts pick up the new
  // name without a relaunch.
  onProfileUpdated?: (user: UserProfile) => void;
  // Optional callback fired after an in-place tier swap or self-cancel
  // here. The server returns the new license inline; without surfacing it
  // to the parent, the chat-header tier badge would keep showing the old
  // tier until next reload. Pairs with onProfileUpdated.
  onLicenseUpdated?: (license: LicenseData) => void;
  // Basic +1h top-up. Optional so older callers don't break — when not
  // provided, the Renew row is hidden and Basic users are pointed at the
  // credit-exhausted modal's renew button instead.
  onRenewRequested?: () => void;
  // Externally-tracked upgrade-in-flight signal (Free → paid). Lets the
  // upgrade buttons here render their own loading state while the parent
  // (App.tsx) is mid-fetch on /create-checkout and waiting for the
  // browser to open. Without this, the button click felt unresponsive
  // — modal closed instantly with no feedback. Now button shows spinner
  // until the parent decides to close us, smoothly.
  upgradePending?: 'basic' | 'pro' | 'max' | 'ultra' | null;
  // Same pattern but for the +1h Basic top-up — separate flag so the
  // renewal spinner doesn't accidentally light up the upgrade rows.
  renewPending?: boolean;
}

const TIER_INFO: Record<string, {
  label: string;
  color: string;
  gradient: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  blurb: string;
}> = {
  free: {
    label: 'Free',
    color: 'text-gray-300',
    gradient: 'from-slate-700 to-slate-800',
    icon: Sparkles,
    blurb: '5 sessions/month, Gemini only.',
  },
  basic: {
    label: 'Basic',
    color: 'text-emerald-400',
    gradient: 'from-emerald-600/40 to-emerald-800/40',
    icon: Zap,
    blurb: 'One 30-min interview · Gemini, GPT-5.5, Grok, Groq (no Claude). Extendable +30 min.',
  },
  pro: {
    label: 'Pro',
    color: 'text-blue-400',
    gradient: 'from-blue-600/50 to-purple-700/50',
    icon: Crown,
    blurb: 'One 1-hour interview · all five models incl. Claude Sonnet 5. Pop-out + Auto-Solve.',
  },
  max: {
    // WizardHat is the dedicated Max-tier identity icon (custom SVG at
    // /WizardHat.tsx) — the "god-tier" mark that distinguishes Max from
    // Pro's Crown. Both stay in the existing amber-orange-purple gradient
    // language so the in-app surface stays consistent with the chat-header
    // Max chip and the popout Max chip. The cream/gold dialect from the
    // marketing surface (SubscriptionGate) stays out of the in-app surfaces
    // — see the comment block at the top of index.html for the rationale.
    label: 'Max',
    color: 'text-amber-400',
    gradient: 'from-amber-600/40 via-orange-600/40 to-purple-700/40',
    icon: WizardHat,
    blurb: 'Three 1-hour interviews · all five models incl. Claude Sonnet 5 · Train Model.',
  },
  ultra: {
    // Amethyst flagship — the only unlimited, monthly-subscription tier.
    label: 'Ultra',
    color: 'text-violet-300',
    gradient: 'from-violet-600/45 to-fuchsia-700/40',
    icon: UltraMark,
    blurb: 'Unlimited interviews · Auto-Type · all five models. The monthly flagship.',
  },
};

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  active:    { text: 'Active',                color: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  trial:     { text: 'Trial',                 color: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' },
  // Cancel-at-period-end set on Stripe; user still inside paid window.
  // Amber instead of green/red to read as "scheduled to end" — neither
  // healthy nor dead — and to draw the eye to the Reactivate CTA below.
  canceling: { text: 'Cancellation scheduled', color: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  expired:   { text: 'Expired',               color: 'bg-red-500/15 text-red-300 border-red-500/30' },
  revoked:   { text: 'Revoked',               color: 'bg-red-500/15 text-red-300 border-red-500/30' },
  // Stripe collection paused — soft revoke, can be resumed.
  paused:    { text: 'Paused',                color: 'bg-gray-500/15 text-gray-300 border-gray-500/30' },
  // Webhook from charge.refunded (full refund) — terminal until resub.
  refunded:  { text: 'Refunded',              color: 'bg-red-500/15 text-red-300 border-red-500/30' },
  // Webhook from charge.dispute.created — pending dispute outcome.
  disputed:  { text: 'Disputed',              color: 'bg-red-500/15 text-red-300 border-red-500/30' },
  none:      { text: 'No subscription',       color: 'bg-gray-500/15 text-gray-300 border-gray-500/30' },
};

function formatExpiry(expiresAt: number): string {
  if (!expiresAt || expiresAt < 0) return 'Never';
  const d = new Date(expiresAt);
  const now = Date.now();
  const days = Math.round((expiresAt - now) / 86400000);
  const dateStr = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  if (days < 0) return `${dateStr} (expired ${-days}d ago)`;
  if (days === 0) return `${dateStr} (today)`;
  if (days === 1) return `${dateStr} (tomorrow)`;
  return `${dateStr} (in ${days} days)`;
}

function formatCredits(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || seconds <= 0) return '0 minutes';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m} minutes`;
}

// Trial budgets are at most 30 minutes (TIME_CONSTANTS.TRIAL_SECONDS), so
// hours are never relevant — we want a "Xm Ys" readout that lets a Free
// user feel the clock running. Differs from formatCredits which is built
// for hour-granularity Basic balances.
function formatTrialTime(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || seconds <= 0) return '0s';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

// Plan comparison rows. Keep this short — long tables intimidate users
// scanning for the right plan at decision time.
// 2026-07 model. Basic/Pro/Max are one-time interviews (time-gated); Ultra is
// the unlimited monthly subscription. Auto-Type is Ultra-only; Claude unlocks
// at Pro.
const FEATURE_ROWS: Array<{ label: string; values: Record<string, string | boolean> }> = [
  { label: 'Interview time',      values: { free: '30-min trial', basic: 'One 30-min',  pro: 'One 1-hour', max: 'Three 1-hour', ultra: 'Unlimited' } },
  { label: 'AI models',           values: { free: 'Gemini',       basic: '4 (no Claude)', pro: 'All 5',    max: 'All 5',        ultra: 'All 5' } },
  { label: 'Pop-out window',      values: { free: false,          basic: true,          pro: true,         max: true,           ultra: true } },
  { label: 'Auto-Solve (screen)', values: { free: false,          basic: true,          pro: true,         max: true,           ultra: true } },
  { label: 'Train Model',         values: { free: false,          basic: false,         pro: false,        max: true,           ultra: true } },
  { label: 'Auto-Type (typing)',  values: { free: false,          basic: false,         pro: false,        max: false,          ultra: true } },
  { label: 'Context files',       values: { free: '1',            basic: 'Unlimited',   pro: 'Unlimited',  max: 'Unlimited',    ultra: 'Unlimited' } },
];

const TIER_ORDER = ['free', 'basic', 'pro', 'max', 'ultra'] as const;

// ── Purchasable plans (2026-07 model) ──
// Basic/Pro/Max are one-time interview buys; Ultra is the monthly subscription.
// EVERY option is a fresh checkout via onUpgradeRequested → /create-checkout —
// there's no in-place sub swap anymore (the old /upgrade-tier Pro↔Max path 404s
// without a live subscription). Each row wears its tier's precious material:
// Basic bronze → Pro platinum → Max gold → Ultra amethyst-gold gem. The marks
// self-colour (they ignore the span tint below); `accent` now only drives the
// row chrome — gold hairline for the metals, violet glow for the Ultra jewel.
type BuyTier = 'basic' | 'pro' | 'max' | 'ultra';
const PLAN_ROW_META: Record<BuyTier, { title: string; blurb: string; Icon: React.ComponentType<{ size?: number }>; accent: 'gold' | 'violet' }> = {
  basic: { title: 'Get Basic', Icon: BasicMark, accent: 'gold',   blurb: 'One 30-min interview · Gemini, GPT-5.5, Grok, Groq (no Claude)' },
  pro:   { title: 'Get Pro',   Icon: ProMark,   accent: 'gold',   blurb: 'One 1-hour interview · all 5 models incl. Claude Sonnet 5' },
  max:   { title: 'Get Max',   Icon: MaxMark,   accent: 'gold',   blurb: 'Three 1-hour interviews · all 5 models · Train Model' },
  ultra: { title: 'Go Ultra',  Icon: UltraMark,  accent: 'violet', blurb: 'Unlimited interviews · Auto-Type · all 5 models · billed monthly' },
};
const UPGRADE_TARGETS: Record<string, BuyTier[]> = {
  free:  ['basic', 'pro', 'max', 'ultra'],
  basic: ['pro', 'max', 'ultra'],
  pro:   ['max', 'ultra'],
  max:   ['ultra'],
  ultra: [],
};

// Themed purchase row — dark with a SLIGHT gold hairline; Basic is the plainest.
// Ultra stays in the core dark+gold theme but a rich purple glow bleeds in from
// the RIGHT edge — a hint, not a violet row. Colors are inline hex so they
// survive the html.dark blue/purple→gold remap in index.css and read on both
// the light and dark surfaces. Icon color rides on the span's `color`.
const UpgradeRow: React.FC<{ target: BuyTier; pending: boolean; disabled: boolean; onClick: () => void }> = ({ target, pending, disabled, onClick }) => {
  const m = PLAN_ROW_META[target];
  const Icon = m.Icon;
  const isUltra = m.accent === 'violet';
  const goldLine = target === 'basic' ? 0.14 : 0.22; // Basic = plainest hairline
  const fg = isUltra ? '#c4b5fd' : '#d3ac63';
  const style: React.CSSProperties = {
    border: `1px solid rgba(211,172,99,${goldLine})`,
    backgroundColor: 'rgba(255,255,255,0.015)',
    ...(isUltra ? {
      // background-image clips to the rounded border-box, so the purple stays
      // inside the row's radius.
      backgroundImage: 'radial-gradient(55% 130% at 100% 50%, rgba(139,92,246,0.20) 0%, rgba(124,58,237,0.06) 30%, transparent 62%)',
      boxShadow: 'inset -1px 0 0 rgba(167,139,250,0.35)',
    } : {}),
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center justify-between gap-3 p-4 rounded-xl transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
      style={style}
    >
      <div className="flex items-center gap-3">
        <span style={{ color: fg, display: 'inline-flex' }}><Icon size={18} /></span>
        <div className="text-left">
          <div className="font-semibold text-zinc-900 dark:text-white text-sm">{pending ? 'Preparing checkout…' : m.title}</div>
          <div className="text-xs text-zinc-600 dark:text-white/60">{m.blurb}</div>
        </div>
      </div>
      {pending
        ? <Loader2 size={16} className="animate-spin" style={{ color: fg }} />
        : <ChevronRight size={16} className="text-zinc-400 dark:text-white/40" />}
    </button>
  );
};

export function ManageSubscription({
  isOpen,
  onClose,
  userProfile,
  userLicense,
  onUpgradeRequested,
  onProfileUpdated,
  onLicenseUpdated,
  onRenewRequested,
  upgradePending = null,
  renewPending = false,
}: ManageSubscriptionProps) {
  // Smooth enter/exit — fades the backdrop and slides the content into
  // place rather than instant-popping. 220ms matches the smoothShow
  // duration in electron/main.cjs so window-level and modal-level
  // animations stay perceptually in sync if both fire close together
  // (e.g., a checkout flow that closes this modal AND surfaces the
  // tray's first-time toast at the same moment).
  const { isMounted, isVisible } = useAnimatedModal(isOpen, 220);
  const [sub, setSub] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null); // tracks which button is in-flight
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  // Cancel-flow reason capture — feeds the audit_log on the server side
  // so churn analytics can attribute lost users to fixable causes (price
  // too high vs feature gap vs competitor switch). Reason picker is
  // OPTIONAL (server doesn't gate cancel on it), but every enterprise
  // billing portal — Stripe, Notion, Linear, Vercel — asks before they
  // let you out the door.
  const [cancelReason, setCancelReason] = useState<string>('');
  const [cancelReasonDetail, setCancelReasonDetail] = useState<string>('');
  // Refund-policy modal state. Surfaced as an in-app overlay instead of
  // an external link to minicaai.com so the policy a user reads matches
  // the version of the app they're on, and works offline.
  const [refundPolicyOpen, setRefundPolicyOpen] = useState(false);
  // Backfill state — for the "Sync chat history to cloud" action.
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<BackfillProgress | null>(null);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);
  // Display-name edit state. We keep the input collapsed by default — the
  // overwhelming majority of users won't touch it on any given visit, so
  // showing a pencil icon and letting them click to edit keeps the section
  // visually quiet (matches the iCloud → Apple ID pattern: read-only fields
  // with a Edit affordance, not always-on inputs).
  const [nameEditing, setNameEditing] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Live snapshot from the server every time the page opens — local
  // userLicense can lag (e.g., webhook landed mid-session, expires_at
  // ticked over). The server is authoritative for billing-critical state.
  const fetchSubscription = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = licenseService.getToken();
      if (!token) throw new Error('Not signed in');
      const res = await fetch(`${API_BASE}/api/v1/payments/subscription`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Could not fetch subscription');
      const data = await res.json();
      if (!mountedRef.current) return;
      setSub(data);
    } catch (e: any) {
      if (!mountedRef.current) return;
      setError(e?.message || 'Failed to load subscription');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    fetchSubscription();
    setError(null);
    setSuccess(null);
    setCancelConfirm(false);
  }, [isOpen, fetchSubscription]);

  // If the parent's license updates while the modal is open (a refund webhook
  // landed, the user got upgraded from another tab, comp tier was revoked,
  // expires_at ticked over), the cached `sub` snapshot is stale. Refetch so
  // the UI doesn't keep offering "Cancel subscription" on a tier they no
  // longer have, or "Upgrade to Max" when they already are Max. We only
  // refetch when the modal is open AND the tier or status actually changed —
  // re-renders that don't change billing state shouldn't burn API calls.
  const lastLicenseSigRef = useRef<string>('');
  useEffect(() => {
    if (!isOpen) return;
    const sig = `${userLicense?.tier || 'none'}:${userLicense?.status || 'none'}:${userLicense?.expires_at || 0}`;
    if (lastLicenseSigRef.current && lastLicenseSigRef.current !== sig) {
      fetchSubscription();
    }
    lastLicenseSigRef.current = sig;
  }, [isOpen, userLicense?.tier, userLicense?.status, userLicense?.expires_at, fetchSubscription]);

  // Escape closes (modal a11y).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // Reactivate a Stripe subscription that's scheduled to cancel at period
  // end. Server flips cancel_at_period_end=false on Stripe AND mirrors the
  // local license back to status='active'. Inline so the user gets visible
  // confirmation without bouncing out to the Stripe portal — that round
  // trip is what made canceled-then-regretted users churn for good.
  const handleReactivate = useCallback(async () => {
    setActionLoading('reactivate');
    setError(null);
    setSuccess(null);
    try {
      const token = licenseService.getToken();
      if (!token) throw new Error('Not signed in');
      const res = await fetch(`${API_BASE}/api/v1/payments/reactivate-subscription`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Could not reactivate subscription');
      }
      const data = await res.json();
      // Mirror the in-place upgrade pattern — propagate the server's new
      // license to the parent so the chat-header tier badge flips from
      // "Cancellation scheduled" back to "Active" without waiting for
      // the next /subscription poll.
      if (data.license) {
        const merged: LicenseData = { ...data.license, last_validated: Date.now() };
        const saved = licenseService.loadAuth();
        if (saved.user) licenseService.saveAuth(saved.user, merged);
        onLicenseUpdated?.(merged);
      }
      setSuccess(data.message || 'Subscription reactivated — your plan will continue to renew normally.');
      fetchSubscription();
    } catch (e: any) {
      setError(e?.message || 'Failed to reactivate');
    } finally {
      if (mountedRef.current) setActionLoading(null);
    }
  }, [fetchSubscription, onLicenseUpdated]);

  const handleStripePortal = useCallback(async () => {
    setActionLoading('portal');
    setError(null);
    setSuccess(null);
    try {
      const token = licenseService.getToken();
      if (!token) throw new Error('Not signed in');
      const res = await fetch(`${API_BASE}/api/v1/payments/portal`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Could not open billing portal');
      }
      const { portal_url } = await res.json();
      if (!portal_url) throw new Error('Portal URL missing');
      // Open in system browser via Electron, fall back to window.open.
      if (window.electronAPI?.openExternal) {
        window.electronAPI.openExternal(portal_url);
      } else {
        window.open(portal_url, '_blank', 'noopener');
      }
      setSuccess('Opened billing portal in your browser.');
    } catch (e: any) {
      setError(e?.message || 'Failed to open billing portal');
    } finally {
      if (mountedRef.current) setActionLoading(null);
    }
  }, []);

  // Unified cancel — works for both Stripe and Razorpay subscriptions.
  // Server auto-detects the provider from the user's stripe_customer_id
  // prefix and either flips Stripe's cancel_at_period_end=true or calls
  // Razorpay's subscriptions.cancel(_, false). Either way the local
  // license flips to status='canceling' so the Reactivate UI appears
  // immediately. Replaces the old Stripe-users-go-to-portal flow per
  // 2026 SaaS norms (Claude/Cursor/Spotify all do in-app cancel — only
  // ~30% of users return after going through an external portal cancel,
  // vs higher recovery rates with in-app Reactivate prompts).
  const handleCancel = useCallback(async () => {
    setCancelConfirm(false);
    setActionLoading('cancel');
    setError(null);
    setSuccess(null);
    try {
      const token = licenseService.getToken();
      if (!token) throw new Error('Not signed in');
      const res = await fetch(`${API_BASE}/api/v1/payments/cancel-subscription`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reason: cancelReason || null,
          reason_detail: cancelReasonDetail || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Could not cancel subscription');
      }
      const data = await res.json();
      // Prefer the server-returned cycle-end timestamp over the generic
      // message — telling the user the exact date their access ends ("until
      // Jul 15, 2026") is far more reassuring than "scheduled for end of
      // billing cycle." Falls back to the server's message if the server
      // didn't surface cancels_at (best-effort field).
      const cycleEndMs: number | undefined = data?.cancels_at;
      // Resolve tier label inside the handler (not via the render-scoped
      // tierMeta closure) — tierMeta is computed per-render after this
      // useCallback is defined, and capturing it would either require it
      // in deps or risk staleness. Server tier on the response is the
      // freshest source we have.
      const tierFromServer = (data?.license?.tier || userLicense?.tier || 'your') as string;
      const tierLabel = tierFromServer.charAt(0).toUpperCase() + tierFromServer.slice(1);
      if (typeof cycleEndMs === 'number' && cycleEndMs > Date.now()) {
        setSuccess(`Cancellation scheduled. You keep ${tierLabel} access until ${formatExpiry(cycleEndMs)}.`);
      } else {
        setSuccess(data.message || 'Cancellation scheduled for end of billing cycle.');
      }
      // Propagate the new license (with cycle-end expires_at) to parent so
      // the chat-header tier badge + popout state catch up immediately. The
      // server pins expires_at to the actual cycle end on cancel; without
      // this, the in-app UI shows an indefinite "Pro Active" badge until
      // the next 30-min revalidation tick.
      if (data.license) {
        const merged: LicenseData = { ...data.license, last_validated: Date.now() };
        const saved = licenseService.loadAuth();
        if (saved.user) licenseService.saveAuth(saved.user, merged);
        onLicenseUpdated?.(merged);
      }
      // Refetch to update status.
      fetchSubscription();
    } catch (e: any) {
      setError(e?.message || 'Failed to cancel');
    } finally {
      if (mountedRef.current) setActionLoading(null);
    }
  }, [fetchSubscription, onLicenseUpdated, cancelReason, cancelReasonDetail]);

  const handleBackfillHistory = useCallback(async () => {
    if (!userProfile?.id) return;
    setBackfillRunning(true);
    setBackfillResult(null);
    setBackfillProgress({ done: 0, total: 0, current: '', synced: 0, failed: 0 });
    try {
      const result = await backfillAllConversations(userProfile.id, (p) => {
        if (mountedRef.current) setBackfillProgress(p);
      });
      if (mountedRef.current) {
        setBackfillResult(result.message);
      }
    } catch (e: any) {
      if (mountedRef.current) {
        setBackfillResult(e?.message || 'Backfill failed');
      }
    } finally {
      if (mountedRef.current) setBackfillRunning(false);
    }
  }, [userProfile?.id]);

  // ── Profile name save ──
  // Only `name` is editable here — country and email are intentionally
  // read-only (region drives billing routing; email is the primary
  // identifier). licenseService.updateProfile mirrors the new user record
  // into localStorage; we also fire onProfileUpdated so MainApp's React
  // state catches up without waiting for a re-validation tick.
  const handleSaveName = useCallback(async () => {
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === (userProfile?.name || '').trim()) {
      setNameEditing(false);
      return;
    }
    setNameSaving(true);
    setNameError(null);
    setNameSaved(false);
    try {
      const updated = await licenseService.updateProfile({ name: trimmed });
      if (!mountedRef.current) return;
      onProfileUpdated?.(updated);
      setNameEditing(false);
      setNameSaved(true);
      window.setTimeout(() => {
        if (mountedRef.current) setNameSaved(false);
      }, 2400);
    } catch (e: any) {
      if (!mountedRef.current) return;
      setNameError(e?.message || 'Could not save name');
    } finally {
      if (mountedRef.current) setNameSaving(false);
    }
  }, [draftName, userProfile?.name, onProfileUpdated]);

  const handleUpgradeTier = useCallback(async (targetTier: 'pro' | 'max') => {
    setActionLoading(`upgrade-${targetTier}`);
    setError(null);
    setSuccess(null);
    try {
      const token = licenseService.getToken();
      if (!token) throw new Error('Not signed in');
      // Bug fix: server's /upgrade-tier expects body `{ tier }` (matches
      // /create-checkout's contract); the previous `targetTier` key was a
      // typo that worked only because normalizeTier defaulted to the
      // current tier on missing field — making the upgrade a silent no-op.
      const res = await fetch(`${API_BASE}/api/v1/payments/upgrade-tier`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: targetTier }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Could not switch to ${targetTier}`);
      }
      const data = await res.json();

      // ── Fallback path: server fell through to a fresh checkout ──
      // Triggers when the user has tier=pro/max but no stripe_customer_id
      // on file (admin-granted, webhook miss, migrated legacy account).
      // /upgrade-tier returns a checkout response shape instead of the
      // sync-grant shape, and the client opens the appropriate flow.
      if (data.checkout_url) {
        // Stripe path — open hosted checkout in default browser
        if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
          window.electronAPI.openExternal(data.checkout_url);
        } else {
          window.open(data.checkout_url, '_blank');
        }
        setSuccess(`Setting up payment for ${targetTier.toUpperCase()}. Complete checkout in the browser; your tier will update automatically once payment lands.`);
        return;
      }
      if (data.provider === 'razorpay' && data.order_id) {
        // Razorpay needs inline SDK checkout — that lives in SubscriptionGate.
        // Hand off to the parent so its existing openRazorpayCheckout flow
        // handles it. Close this modal first so we're not stacking surfaces.
        setSuccess('Opening checkout…');
        onClose();
        window.setTimeout(() => onUpgradeRequested(targetTier), 200);
        return;
      }

      // ── Sync-grant path (the common case): server already updated the
      //    subscription in place and returned the new license. ──
      // Use the server's tailored message (mentions proration for Stripe,
      // cycle-end timing for Razorpay downgrades) instead of the generic
      // "active immediately" — that string is wrong on Max→Pro.
      setSuccess(data.message || `Switched to ${targetTier.toUpperCase()}.`);
      // Propagate the new license to parent so the chat-header tier badge
      // and any other consumer of userLicense flips immediately. Without
      // this, only ManageSubscription's local sub state updates; the rest
      // of the app stays on the old tier until next revalidation tick.
      if (data.license) {
        const merged: LicenseData = { ...data.license, last_validated: Date.now() };
        const saved = licenseService.loadAuth();
        if (saved.user) {
          // Mirror the new tier onto the user record too — UserProfile.tier
          // drives several gate checks (canUseFeature) that read from the
          // user, not the license, so both must agree.
          const updatedUser = data.tier && saved.user.tier !== data.tier
            ? { ...saved.user, tier: data.tier as UserProfile['tier'] }
            : saved.user;
          licenseService.saveAuth(updatedUser, merged);
          if (updatedUser !== saved.user) onProfileUpdated?.(updatedUser);
        }
        onLicenseUpdated?.(merged);
      }
      fetchSubscription();
    } catch (e: any) {
      setError(e?.message || 'Failed to change plan');
    } finally {
      if (mountedRef.current) setActionLoading(null);
    }
  }, [fetchSubscription, onLicenseUpdated, onProfileUpdated]);

  if (!isMounted) return null;

  // Reconcile server snapshot (sub) with live license (userLicense) — the
  // license updates immediately on webhook events, while sub is the snapshot
  // from the last fetch. Prefer the more conservative (lower-rank) tier so a
  // downgrade is reflected before the in-flight refetch completes; otherwise
  // we'd show "Cancel subscription" on a tier the user no longer has.
  const tierRank: Record<string, number> = { free: 0, basic: 1, pro: 2, max: 3 };
  const subTier = sub?.tier;
  const licTier = userLicense?.tier;
  const tier = (subTier && licTier)
    ? ((tierRank[String(licTier).toLowerCase()] ?? 0) < (tierRank[String(subTier).toLowerCase()] ?? 0) ? licTier : subTier)
    : (subTier || licTier || 'free');
  const status = sub?.status || userLicense?.status || 'none';
  const provider = sub?.provider;
  const expiresAt = sub?.expires_at ?? userLicense?.expires_at ?? 0;
  const tierMeta = TIER_INFO[tier] || TIER_INFO.free;
  const TierIcon = tierMeta.icon;

  const isPaidProvider = provider === 'stripe' || provider === 'razorpay';
  const isStripe = provider === 'stripe';
  const isRazorpay = provider === 'razorpay';

  // Free-on-trial: light up the hero strip with a countdown so the user
  // feels the 30-min taste-test clock running. Without this, a Free user
  // sees no signal that the picker badges they encounter are tied to a
  // wall-clock window.
  const trialActive = tier === 'free' && licenseService.isTrialActive(userLicense);
  const trialRemaining = trialActive ? licenseService.getTrialRemainingSeconds(userLicense) : 0;

  return (
    <div
      // Backdrop: fade in/out the dim overlay. We avoid scaling the
      // entire surface (it's full-screen scrollable; a 2% scale on a
      // 1080p surface looks weirder than no scale at all) and instead
      // get the "lifted" feel from the inner content's translate-y.
      // Light-mode wired 2026-05-13: backdrop stays translucent-dark (the
      // "dim what's behind" semantic works in both modes), but the modal
      // surface itself gets a solid bg via the sheet wrapper below so the
      // content reads cleanly. Default text color is set on the surface
      // wrapper so individual nodes don't need to repeat text-zinc-900.
      className={`fixed inset-0 z-[99999] overflow-y-auto custom-scrollbar transition-opacity duration-200 ease-out ${
        isVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      } bg-slate-50/95 dark:bg-black/85 text-zinc-900 dark:text-white`}
      style={{ WebkitAppRegion: 'no-drag' } as any}
      role="dialog"
      aria-modal="true"
      aria-label="Manage subscription"
    >
      {/* Top bar — sticks to the top of the scroll container. We do NOT
          wrap the body in a transform-gpu element because position:sticky
          attaches to the nearest scroll ancestor and a transformed
          ancestor would create a new containing block that breaks it. */}
      <div className="sticky top-0 z-10 bg-white/95 dark:bg-[#0a0a0d]/95 backdrop-blur-md border-b border-zinc-200 dark:border-zinc-200 dark:border-white/[0.06] px-6 py-3 flex items-center justify-between">
        <h2 className="text-lg font-bold text-zinc-900 dark:text-white">Manage subscription</h2>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-lg hover:bg-zinc-100 dark:hover:bg-white/[0.08] flex items-center justify-center text-zinc-500 dark:text-gray-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </div>

      {/* Body — gets the subtle lift-up animation. translate + opacity is
          fine here (no sticky inside) and gives the modal contents a
          "rises into place" feel rather than just blinking on. */}
      <div
        className={`max-w-3xl mx-auto p-6 space-y-6 transition-all duration-200 ease-out ${
          isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'
        }`}
      >
        {/* Hero card */}
        <div className={`relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br ${tierMeta.gradient} p-6`}>
          <div className="flex items-start justify-between gap-6 flex-wrap">
            <div className="flex items-center gap-4 min-w-0">
              <div className="w-14 h-14 rounded-2xl bg-white/10 flex items-center justify-center shrink-0">
                <TierIcon size={26} className={tierMeta.color} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <h3 className={`text-2xl font-bold ${tierMeta.color}`}>{tierMeta.label}</h3>
                  <span className={`text-[10px] font-bold tracking-wider uppercase px-2 py-0.5 rounded border ${STATUS_LABEL[status]?.color || STATUS_LABEL.none.color}`}>
                    {STATUS_LABEL[status]?.text || 'Unknown'}
                  </span>
                  {provider && (
                    <span className="text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded border border-white/15 text-white/70">
                      {provider === 'stripe' ? 'Stripe' : 'Razorpay'}
                    </span>
                  )}
                  {trialActive && (
                    <span className="text-[10px] font-bold tracking-wider uppercase px-2 py-0.5 rounded border bg-cyan-500/15 text-cyan-300 border-cyan-500/30">
                      Trial
                    </span>
                  )}
                </div>
                <p className="text-sm text-white/70 leading-relaxed">{tierMeta.blurb}</p>
              </div>
            </div>
          </div>

          {/* Plan-specific detail strip — Basic shows credit balance, Pro/Max
              show renewal date, Free-on-trial shows the 30-min countdown. */}
          {(tier !== 'free' || trialActive) && (
            <div className="mt-5 pt-4 border-t border-white/10 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              {trialActive ? (
                <>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-white/50 mb-0.5">Trial time left</div>
                    <div className="font-semibold text-white">{formatTrialTime(trialRemaining)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-white/50 mb-0.5">After trial</div>
                    <div className="font-semibold text-white">Free plan · Gemini only · 5 sessions/mo</div>
                  </div>
                </>
              ) : tier === 'basic' ? (
                <>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-white/50 mb-0.5">Time remaining</div>
                    <div className="font-semibold text-white">{formatCredits(userLicense?.credits_remaining_seconds)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-white/50 mb-0.5">Credits expire</div>
                    <div className="font-semibold text-white">{userLicense?.credits_expire_at ? formatExpiry(userLicense.credits_expire_at) : '—'}</div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-white/50 mb-0.5">Renews</div>
                    <div className="font-semibold text-white">{formatExpiry(expiresAt)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-white/50 mb-0.5">Account email</div>
                    <div className="font-semibold text-white truncate">{userProfile?.email || '—'}</div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Loading / error / success banners */}
        {loading && (
          <div className="flex items-center justify-center py-6 text-sm text-gray-400">
            <Loader2 size={16} className="animate-spin mr-2" />
            Loading subscription details…
          </div>
        )}
        {error && (
          <div className="flex items-start gap-3 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-300">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        {success && (
          <div className="flex items-start gap-3 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-sm text-emerald-300">
            <Check size={16} className="shrink-0 mt-0.5" />
            <span>{success}</span>
          </div>
        )}

        {/* ── Available plans (tier-driven, every user sees their valid switches) ──
            Previously this section was provider-driven: Stripe paid users
            saw only "Manage billing" (a Stripe Portal link), with no inline
            upgrade/downgrade buttons. Razorpay paid users got the inline
            menu but Stripe paid users were forced through the external
            portal — confusing because most upgrade copy says "Upgrade to
            Max" but the only button visible was a generic "Manage billing".
            Now every tier shows its valid transitions as labeled buttons,
            and the provider-specific Stripe-Portal/Razorpay-Cancel actions
            live in a separate "Billing" section below. /upgrade-tier
            handles both Stripe and Razorpay in-place server-side, so the
            same handleUpgradeTier call works for either provider. */}
        <div className="space-y-3">
          <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-500 dark:text-white/50">Available plans</h4>

          {/* Basic-tier renewal top-up (+30 min) — Basic only */}
          {tier === 'basic' && onRenewRequested && (
            <button
              onClick={onRenewRequested}
              disabled={renewPending || upgradePending != null}
              className="w-full flex items-center justify-between gap-3 p-4 rounded-xl transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ border: '1px solid rgba(211,172,99,0.38)', background: 'rgba(211,172,99,0.09)' }}
            >
              <div className="flex items-center gap-3">
                <span style={{ color: '#d3ac63', display: 'inline-flex' }}><Zap size={18} /></span>
                <div className="text-left">
                  <div className="font-semibold text-zinc-900 dark:text-white text-sm">{renewPending ? 'Preparing checkout…' : 'Renew · +30 min'}</div>
                  <div className="text-xs text-zinc-600 dark:text-white/60">Add another 30 minutes of interview time to your Basic plan.</div>
                </div>
              </div>
              {renewPending ? <Loader2 size={16} className="animate-spin" style={{ color: '#d3ac63' }} /> : <ChevronRight size={16} className="text-zinc-400 dark:text-white/40" />}
            </button>
          )}
          {/* Purchase / upgrade — every option is a fresh checkout (2026-07 model):
              Basic/Pro/Max are one-time, Ultra is the monthly subscription.
              Ultra renders in amethyst; the rest in gold (see UpgradeRow). */}
          {(UPGRADE_TARGETS[tier] || []).map(t => (
            <UpgradeRow
              key={t}
              target={t}
              pending={upgradePending === t}
              disabled={upgradePending != null}
              onClick={() => onUpgradeRequested(t)}
            />
          ))}

          {/* Basic renew + Pro/Max/Ultra purchase options are all handled by the
              tier-driven block above (UPGRADE_TARGETS). The old per-tier branches
              here assumed the pre-2026-07 subscription model (in-place Pro↔Max
              swap via /upgrade-tier, which 404s now that Pro/Max are one-time). */}

          {/* === Max tier → switch back to Pro (downgrade in-place) ===
              On Razorpay this schedules at cycle_end (server keeps Max
              active until then). On Stripe it prorates next invoice. */}
          {tier === 'max' && (
            <button
              onClick={() => handleUpgradeTier('pro')}
              disabled={actionLoading === 'upgrade-pro'}
              className="w-full flex items-center justify-between gap-3 p-4 rounded-xl border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/15 transition-colors disabled:opacity-50"
            >
              <div className="flex items-center gap-3">
                <Crown size={18} className="text-blue-400" />
                <div className="text-left">
                  <div className="font-semibold text-zinc-900 dark:text-white text-sm">Switch to Pro</div>
                  <div className="text-xs text-zinc-600 dark:text-white/60">Removes Claude + Auto-Type + Train Model. {isRazorpay ? 'Effective at next renewal — keep Max access until then.' : 'Effective immediately, prorated credit next invoice.'}</div>
                </div>
              </div>
              {actionLoading === 'upgrade-pro' ? <Loader2 size={16} className="animate-spin text-blue-400" /> : <ChevronRight size={16} className="text-zinc-400 dark:text-white/40" />}
            </button>
          )}

          {/* === Pro/Max → Switch to Basic (deep downgrade) ===
              Provider-aware: real users with a Stripe/Razorpay sub go
              through the cancel modal (with reason capture + the
              save-attempt UX); admin grants (no payment provider on
              file) call /upgrade-tier directly because there's no
              subscription to cancel — server's grantAdminTier path
              handles the DB-only tier flip in one round-trip.
              Without this branch, admins clicked the button and
              nothing visible happened (the cancel modal is gated on
              `isPaidProvider` further down). */}
          {(tier === 'pro' || tier === 'max') && (
            <button
              onClick={() => {
                if (isPaidProvider) {
                  setCancelReason('switching_to_basic');
                  setCancelReasonDetail('I want to downgrade to Basic ($25 one-time / 3 sessions). Please cancel my recurring subscription so I can purchase Basic after the current cycle ends.');
                  setCancelConfirm(true);
                } else {
                  // No payment provider → admin-grant path. Hits
                  // /upgrade-tier which short-circuits to grantAdminTier
                  // for ADMIN_EMAILS callers. For non-admin users
                  // without a provider (which shouldn't happen — every
                  // paid tier requires a checkout that sets the
                  // provider), the server will return a polite error
                  // and we surface it in the existing error toast.
                  handleUpgradeTier('basic' as any);
                }
              }}
              disabled={!!actionLoading}
              className="w-full flex items-center justify-between gap-3 p-4 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
            >
              <div className="flex items-center gap-3">
                <Zap size={18} className="text-emerald-400" />
                <div className="text-left">
                  <div className="font-semibold text-zinc-900 dark:text-white text-sm">Switch to Basic{!isPaidProvider && ' (admin)'}</div>
                  <div className="text-xs text-zinc-600 dark:text-white/60">{isPaidProvider
                    ? '$25 one-time, 3 sessions, 14-day window. Basic isn\'t a subscription — your current sub cancels at cycle end, then you re-purchase Basic. Keeps your account intact.'
                    : 'No payment provider on file — instant tier flip (admin grant).'
                  }</div>
                </div>
              </div>
              <ChevronRight size={16} className="text-zinc-400 dark:text-white/40" />
            </button>
          )}

          {/* === Pro/Max → Switch to Free (cancel subscription) ===
              Same provider-aware branch as Switch to Basic: real users
              go through cancel modal; admin grants flip the tier
              instantly. */}
          {(tier === 'pro' || tier === 'max') && (
            <button
              onClick={() => {
                if (isPaidProvider) {
                  setCancelConfirm(true);
                } else {
                  handleUpgradeTier('free' as any);
                }
              }}
              disabled={!!actionLoading}
              className="w-full flex items-center justify-between gap-3 p-4 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-zinc-100 dark:bg-white/[0.06] transition-colors disabled:opacity-50"
            >
              <div className="flex items-center gap-3">
                <X size={18} className="text-white/60" />
                <div className="text-left">
                  <div className="font-semibold text-zinc-900 dark:text-white text-sm">Switch to Free{!isPaidProvider && ' (admin)'}</div>
                  <div className="text-xs text-zinc-600 dark:text-white/60">{isPaidProvider
                    ? `Stop paying. You keep ${tierMeta.label} access until ${formatExpiry(expiresAt)}, then drop to Free (5 sessions/month, Gemini only).`
                    : 'No payment provider on file — instant tier flip to Free (admin grant).'
                  }</div>
                </div>
              </div>
              <ChevronRight size={16} className="text-zinc-400 dark:text-white/40" />
            </button>
          )}

          {/* === Basic → switch to Free (let it expire) ===
              Basic auto-expires after 14 days or 3 sessions, so there's
              no recurring sub to cancel. This button is informational
              — clicking it shows the expiry date and a note that no
              cancellation is needed. */}
          {tier === 'basic' && (
            <button
              onClick={() => {
                setSuccess(`Basic doesn't auto-renew — your current credits expire on ${formatExpiry(expiresAt)} and your tier will drop to Free automatically. No cancellation needed.`);
              }}
              disabled={!!actionLoading}
              className="w-full flex items-center justify-between gap-3 p-4 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-zinc-100 dark:bg-white/[0.06] transition-colors disabled:opacity-50"
            >
              <div className="flex items-center gap-3">
                <X size={18} className="text-white/60" />
                <div className="text-left">
                  <div className="font-semibold text-zinc-900 dark:text-white text-sm">Stay on Basic / let it expire to Free</div>
                  <div className="text-xs text-zinc-600 dark:text-white/60">Basic is a one-time purchase — it doesn't renew. Your access ends on {formatExpiry(expiresAt)}.</div>
                </div>
              </div>
              <ChevronRight size={16} className="text-zinc-400 dark:text-white/40" />
            </button>
          )}
        </div>

        {/* ── Billing section — provider-specific actions ──
            Stripe paid users get the Customer Portal link (card / invoices /
            cancel are all there). Razorpay paid users get an inline cancel
            with confirm because Razorpay has no self-serve portal. Free
            users see nothing here — there's no billing relationship yet. */}
        {(tier === 'pro' || tier === 'max') && (
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-500 dark:text-white/50">Billing</h4>

            {/* Cancel-pending state: surface explicit "scheduled to end"
                copy + a one-click Reactivate CTA. The Stripe Portal can do
                the same thing but it's an off-app round trip and most
                users won't bother. Inline reactivation is the retention
                lever — it converts canceled-then-regretted users back to
                active without losing them to the Portal's friction. */}
            {status === 'canceling' && (
              <div className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] space-y-3">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
                  <div className="text-sm text-amber-100/90 leading-relaxed">
                    <div className="font-semibold mb-0.5">Cancellation scheduled</div>
                    <div className="text-amber-200/70 text-[13px]">
                      You'll keep {tierMeta.label} access until {formatExpiry(expiresAt)}. After that the subscription stops renewing and your tier drops to Free. You can reverse this any time before then.
                    </div>
                  </div>
                </div>
                <button
                  onClick={handleReactivate}
                  disabled={actionLoading === 'reactivate'}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-sm font-bold transition-colors disabled:opacity-50"
                >
                  {actionLoading === 'reactivate' ? <><Loader2 size={14} className="animate-spin" /> Reactivating…</> : <>Resume — keep my subscription</>}
                </button>
              </div>
            )}

            {isStripe && (
              <button
                onClick={handleStripePortal}
                disabled={actionLoading === 'portal'}
                className="w-full flex items-center justify-between gap-3 p-4 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-zinc-100 dark:bg-white/[0.06] transition-colors disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <ExternalLink size={18} className="text-white/70" />
                  <div className="text-left">
                    <div className="font-semibold text-zinc-900 dark:text-white text-sm">Manage billing in Stripe</div>
                    <div className="text-xs text-zinc-600 dark:text-white/60">{status === 'canceling' ? 'Update card, view invoices, change billing cycle.' : 'Update card, view invoices, change billing cycle, or cancel subscription.'}</div>
                  </div>
                </div>
                {actionLoading === 'portal' ? <Loader2 size={16} className="animate-spin text-white/70" /> : <ChevronRight size={16} className="text-zinc-400 dark:text-white/40" />}
              </button>
            )}

            {/* Cancel — available to BOTH Stripe and Razorpay subscribers
                while the sub is still active (status='active'). Suppressed
                when status='canceling' because the Reactivate banner above
                already shows the cancel state and offers the inverse CTA.
                The unified server endpoint auto-detects provider, so the
                same UI works for everyone. */}
            {isPaidProvider && status === 'active' && (
              <>
                {!cancelConfirm ? (
                  <button
                    onClick={() => setCancelConfirm(true)}
                    className="w-full flex items-center justify-between gap-3 p-4 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-zinc-100 dark:bg-white/[0.06] transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <X size={18} className="text-red-400" />
                      <div className="text-left">
                        <div className="font-semibold text-zinc-900 dark:text-white text-sm">Cancel subscription</div>
                        <div className="text-xs text-zinc-600 dark:text-white/60">You'll keep access until the end of your current billing cycle. You can reactivate any time before then.</div>
                      </div>
                    </div>
                    <ChevronRight size={16} className="text-zinc-400 dark:text-white/40" />
                  </button>
                ) : (
                  <div className="p-4 rounded-xl border border-red-500/30 bg-red-500/10 space-y-4">
                    <div className="flex items-start gap-3">
                      <AlertTriangle size={18} className="text-red-400 shrink-0 mt-0.5" />
                      <div>
                        <div className="font-semibold text-red-200 text-sm">Cancel your {tierMeta.label} subscription?</div>
                        <div className="text-xs text-red-200/80 mt-1">
                          You'll keep full {tierMeta.label} access until <strong>{formatExpiry(expiresAt)}</strong>, then drop to Free. No partial-period refund. Reactivate any time before then to keep going.
                        </div>
                      </div>
                    </div>

                    {/* Save attempt: offer a cheaper plan instead of full
                        cancellation. Standard enterprise pattern (Notion,
                        Linear, Vercel all do this) — many users churn
                        because they need less, not because they're done. */}
                    {(tier === 'max' || tier === 'pro') && (
                      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
                        <div className="flex items-center gap-2 text-amber-200">
                          <Sparkles size={13} />
                          <span className="text-[12px] font-bold uppercase tracking-wider">Before you go — would a cheaper plan work?</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {tier === 'max' && (
                            <button
                              type="button"
                              onClick={() => { setCancelConfirm(false); handleUpgradeTier('pro'); }}
                              disabled={!!actionLoading}
                              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-500/20 text-indigo-200 hover:bg-indigo-500/30 border border-indigo-500/40 transition-colors disabled:opacity-50"
                            >
                              Switch to Pro instead
                            </button>
                          )}
                          {(tier === 'max' || tier === 'pro') && isStripe && (
                            <button
                              type="button"
                              onClick={() => { setCancelConfirm(false); window.open(`${API_BASE}/api/v1/payments/portal-redirect?token=${licenseService.getToken() || ''}`, '_blank'); }}
                              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/10 text-white/80 hover:bg-white/15 border border-white/15 transition-colors"
                            >
                              Pause via billing portal
                            </button>
                          )}
                        </div>
                        <div className="text-[10.5px] text-amber-200/70 leading-relaxed">
                          Pro is half the price and keeps all five models, Claude Sonnet 5 included — you'd just go from three interviews down to one.
                        </div>
                      </div>
                    )}

                    {/* What you'll lose — feature-loss preview computed
                        from the FEATURE_GATES table (mirrored in the
                        bot's preview_tier_change tool). Pulled inline
                        so we don't fetch the bot endpoint just for
                        labels. */}
                    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-1.5">
                      <div className="text-[11px] font-bold uppercase tracking-wider text-white/60">What you'll lose at {formatExpiry(expiresAt)}</div>
                      <ul className="text-[12px] text-white/80 space-y-1 ml-2 list-disc list-inside">
                        {/* Gate-accurate under 2026-07 pricing (mirrors FEATURE_GATES).
                            This cancel panel only renders for Pro/Max — both include
                            Claude + the four base models; Max alone adds reasoning-effort
                            control. Auto-Type is Ultra-only, so it's never lost here. */}
                        <li>Claude Sonnet 5 access</li>
                        {tier === 'max' && <li>Reasoning effort control</li>}
                        <li>Gemini, Groq, GPT, and Grok models</li>
                        <li>Auto-Solve (screen-capture problem solving)</li>
                        <li>Pop-out window (screen-share invisible)</li>
                        <li>Unlimited context files + export history</li>
                        <li>Five sessions/month limit (Free)</li>
                      </ul>
                    </div>

                    {/* Reason capture — for churn analytics. Optional,
                        but defaults to encouraging the user to tell us
                        why. We record this in the audit log on the
                        server side. */}
                    <div className="space-y-2">
                      <div className="text-[11px] font-bold uppercase tracking-wider text-white/60">Why are you canceling? <span className="text-white/40 font-normal normal-case tracking-normal">(optional, helps us improve)</span></div>
                      <div className="grid grid-cols-2 gap-1.5">
                        {[
                          { v: 'too_expensive', l: 'Too expensive' },
                          { v: 'not_using', l: 'Not using it enough' },
                          { v: 'switching', l: 'Switching to another tool' },
                          { v: 'missing_feature', l: 'Missing a feature I need' },
                          { v: 'bug_or_bad_quality', l: 'Quality / bugs' },
                          { v: 'other', l: 'Other' },
                        ].map(opt => (
                          <button
                            key={opt.v}
                            type="button"
                            onClick={() => setCancelReason(opt.v)}
                            className={`px-2.5 py-1.5 rounded-md text-[12px] text-left transition-colors border ${
                              cancelReason === opt.v
                                ? 'bg-blue-500/20 border-blue-500/50 text-blue-100'
                                : 'bg-white/[0.03] border-white/10 text-white/75 hover:bg-zinc-100 dark:bg-white/[0.06]'
                            }`}
                          >
                            {opt.l}
                          </button>
                        ))}
                      </div>
                      {cancelReason && (
                        <textarea
                          value={cancelReasonDetail}
                          onChange={(e) => setCancelReasonDetail(e.target.value.slice(0, 500))}
                          rows={2}
                          placeholder="Tell us more (optional, 500 char max)…"
                          className="w-full px-2.5 py-2 rounded-md text-[12px] bg-white/[0.03] border border-white/10 text-white placeholder-white/40 resize-none focus:outline-none focus:border-white/30"
                        />
                      )}
                    </div>

                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        onClick={() => { setCancelConfirm(false); setCancelReason(''); setCancelReasonDetail(''); }}
                        className="px-4 py-2 rounded-lg text-sm font-medium bg-white/10 text-white hover:bg-white/15 transition-colors"
                      >
                        Keep subscription
                      </button>
                      <button
                        onClick={handleCancel}
                        disabled={actionLoading === 'cancel'}
                        className="px-4 py-2 rounded-lg text-sm font-bold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors"
                      >
                        {actionLoading === 'cancel' ? 'Canceling…' : 'Yes, cancel'}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Plan comparison */}
        <div className="space-y-3">
          <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-500 dark:text-white/50">Compare plans</h4>
          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-white/[0.03]">
                  <th className="text-left text-xs font-medium text-white/60 px-4 py-3"></th>
                  {TIER_ORDER.map(t => {
                    const meta = TIER_INFO[t];
                    const isCurrent = t === tier;
                    return (
                      <th key={t} className={`text-center text-xs font-bold uppercase tracking-wider px-3 py-3 ${isCurrent ? meta.color : 'text-white/60'}`}>
                        {meta.label}
                        {isCurrent && <div className="text-[9px] font-medium normal-case tracking-normal mt-0.5 text-white/50">Current</div>}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {FEATURE_ROWS.map((row, idx) => (
                  <tr key={row.label} className={idx % 2 === 0 ? '' : 'bg-white/[0.02]'}>
                    <td className="text-xs text-white/70 px-4 py-2.5 whitespace-nowrap">{row.label}</td>
                    {TIER_ORDER.map(t => {
                      const v = row.values[t];
                      const isCurrent = t === tier;
                      return (
                        <td key={t} className={`text-center text-xs px-3 py-2.5 ${isCurrent ? 'font-semibold text-white' : 'text-white/65'}`}>
                          {typeof v === 'boolean'
                            ? (v ? <Check size={14} className="inline text-emerald-400" /> : <span className="text-white/30">—</span>)
                            : v}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-white/40 leading-relaxed">
            Pricing varies by region. India: Razorpay (INR). Everywhere else: Stripe (USD). Click an Upgrade button above to see current pricing for your region.
          </p>
        </div>

        {/* Account section */}
        <div className="space-y-3">
          <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-500 dark:text-white/50">Account</h4>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] divide-y divide-white/5">
            {/* Display name — read-only by default, click to edit. We keep
                the row visually quiet (no always-on input) so the section
                doesn't shout "edit me"; the pencil affordance is enough. */}
            <div className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] uppercase tracking-wider text-white/50 mb-0.5">Display name</div>
                  {nameEditing ? (
                    <input
                      type="text"
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      autoFocus
                      maxLength={100}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); handleSaveName(); }
                        else if (e.key === 'Escape') { e.preventDefault(); setNameEditing(false); setNameError(null); }
                      }}
                      className="w-full bg-zinc-100 dark:bg-white/[0.04] border border-white/10 rounded-lg px-2.5 py-1.5 text-sm text-white outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20"
                      placeholder="Your name"
                    />
                  ) : (
                    <div className="text-sm text-white truncate">{userProfile?.name || '—'}</div>
                  )}
                  <div className="text-[11px] text-white/40 mt-1">
                    Used in your interview answers and our support chat.
                  </div>
                  {nameError && (
                    <div className="text-[11px] text-red-400 mt-1.5 flex items-center gap-1">
                      <AlertTriangle size={11} /> {nameError}
                    </div>
                  )}
                  {nameSaved && !nameError && (
                    <div className="text-[11px] text-emerald-300 mt-1.5 flex items-center gap-1">
                      <Check size={11} /> Saved
                    </div>
                  )}
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  {nameEditing ? (
                    <>
                      <button
                        onClick={() => { setNameEditing(false); setNameError(null); }}
                        disabled={nameSaving}
                        className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-zinc-100 dark:bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-white/70 hover:text-white disabled:opacity-50 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleSaveName}
                        disabled={nameSaving || !draftName.trim() || draftName.trim() === (userProfile?.name || '').trim()}
                        className="px-3 py-1 rounded-md text-[11px] font-bold bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/30 text-blue-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                      >
                        {nameSaving && <Loader2 size={11} className="animate-spin" />}
                        Save
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => { setDraftName(userProfile?.name || ''); setNameError(null); setNameEditing(true); }}
                      className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-zinc-100 dark:bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-white/70 hover:text-white transition-colors"
                    >
                      Edit
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-white/50 mb-0.5">Email</div>
                <div className="text-sm text-white truncate">{userProfile?.email || '—'}</div>
              </div>
              {userProfile?.oauth_provider === 'google' && (
                <span className="text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded border border-white/15 text-white/70 shrink-0">
                  Google
                </span>
              )}
            </div>
            {(userProfile?.created_at ?? 0) > 0 && (
              <div className="px-4 py-3">
                <div className="text-[10px] uppercase tracking-wider text-white/50 mb-0.5">Member since</div>
                <div className="text-sm text-white">
                  {new Date(userProfile!.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
                </div>
              </div>
            )}
            {userProfile?.country_code && (
              <div className="px-4 py-3">
                <div className="text-[10px] uppercase tracking-wider text-white/50 mb-0.5">Region (for billing)</div>
                <div className="text-sm text-white">{userProfile.country_code}</div>
              </div>
            )}
            {/* Backfill chat history — uploads existing local conversations
                to the cloud so admin support can see them. Idempotent (safe
                to re-run). Only available in the desktop app since browser
                doesn't have local SQLite. */}
            {window.electronAPI?.isElectron && (
              <div className="px-4 py-3 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-white">Sync chat history to cloud</div>
                    <div className="text-[11px] text-white/50 mt-0.5">
                      Uploads conversations stored locally on this device so you can access them from elsewhere and our support team can help you. New messages sync automatically; this is a one-shot for older history.
                    </div>
                  </div>
                  <button
                    onClick={handleBackfillHistory}
                    disabled={backfillRunning}
                    className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 border border-blue-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5 whitespace-nowrap"
                  >
                    {backfillRunning ? <Loader2 size={12} className="animate-spin" /> : <UploadCloud size={12} />}
                    {backfillRunning ? 'Syncing…' : 'Sync history'}
                  </button>
                </div>
                {backfillRunning && backfillProgress && backfillProgress.total > 0 && (
                  <div className="space-y-1">
                    <div className="h-1.5 rounded-full bg-blue-950/50 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-blue-400 to-blue-500 transition-all duration-200"
                        style={{ width: `${Math.round((backfillProgress.done / backfillProgress.total) * 100)}%` }}
                      />
                    </div>
                    <div className="text-[10px] text-blue-300/70 truncate">
                      {backfillProgress.done} / {backfillProgress.total}{backfillProgress.current ? ` — ${backfillProgress.current}` : ''}
                    </div>
                  </div>
                )}
                {!backfillRunning && backfillResult && (
                  <div className="text-[11px] text-emerald-300/80">{backfillResult}</div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Help footer */}
        <div className="pt-4 pb-8 border-t border-white/5 flex items-center justify-between gap-4 flex-wrap text-xs text-white/50">
          <div className="flex items-center gap-2">
            <ShieldCheck size={12} />
            <span>Payments processed securely by {isStripe ? 'Stripe' : isRazorpay ? 'Razorpay' : 'our payment partners'}.</span>
          </div>
          <div className="flex items-center gap-3">
            <a href="mailto:support@minicaai.com" className="hover:text-white transition-colors">Contact support</a>
            <span className="text-white/20">·</span>
            <button
              type="button"
              onClick={() => setRefundPolicyOpen(true)}
              className="hover:text-white transition-colors"
            >
              Refund policy
            </button>
          </div>
        </div>
      </div>

      {/* Refund-policy overlay — z-index higher than this surface's
          z-[99999] so it cleanly stacks on top of the billing page. */}
      <RefundPolicy isOpen={refundPolicyOpen} onClose={() => setRefundPolicyOpen(false)} />
    </div>
  );
}
