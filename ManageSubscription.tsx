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
  X, Crown, Zap, Check, Loader2, ExternalLink, AlertTriangle,
  Cpu, ChevronRight, Info, LogOut, ShieldCheck, UploadCloud,
} from 'lucide-react';
import { licenseService, UserProfile, LicenseData } from './services/licenseService';
import { backfillAllConversations, BackfillProgress } from './services/aiProxyService';

const API_BASE = 'https://h2so4-production.up.railway.app';

interface SubscriptionStatus {
  status: 'active' | 'trial' | 'expired' | 'revoked' | 'none';
  tier: 'free' | 'basic' | 'pro' | 'max';
  provider: 'stripe' | 'razorpay' | null;
  expires_at: number;
  sessions_used: number;
  sessions_limit: number;
}

interface ManageSubscriptionProps {
  isOpen: boolean;
  onClose: () => void;
  userProfile: UserProfile | null;
  userLicense: LicenseData | null;
  onLogout: () => void;
  // Triggers the existing upgrade flow (re-uses SubscriptionGate's checkout
  // path so we don't duplicate Razorpay/Stripe SDK plumbing).
  onUpgradeRequested: (targetTier: 'basic' | 'pro' | 'max') => void;
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
    icon: Cpu,
    blurb: '5 sessions/month, Gemini only.',
  },
  basic: {
    label: 'Basic',
    color: 'text-emerald-400',
    gradient: 'from-emerald-600/40 to-emerald-800/40',
    icon: Zap,
    blurb: 'Time-credited access to all models except Claude.',
  },
  pro: {
    label: 'Pro',
    color: 'text-blue-400',
    gradient: 'from-blue-600/50 to-purple-700/50',
    icon: Crown,
    blurb: 'Unlimited time, all models except Claude. Pop-out + Auto-Solve.',
  },
  max: {
    label: 'Max',
    color: 'text-amber-400',
    gradient: 'from-amber-600/40 via-orange-600/40 to-purple-700/40',
    icon: Crown,
    blurb: 'Everything + Claude Sonnet 4.6 + Auto-Type + Train Model.',
  },
};

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  active:  { text: 'Active',          color: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  trial:   { text: 'Trial',           color: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' },
  expired: { text: 'Expired',         color: 'bg-red-500/15 text-red-300 border-red-500/30' },
  revoked: { text: 'Revoked',         color: 'bg-red-500/15 text-red-300 border-red-500/30' },
  none:    { text: 'No subscription', color: 'bg-gray-500/15 text-gray-300 border-gray-500/30' },
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

// Plan comparison rows. Keep this short — long tables intimidate users
// scanning for the right plan at decision time.
const FEATURE_ROWS: Array<{ label: string; values: Record<string, string | boolean> }> = [
  { label: 'AI models',           values: { free: 'Gemini',       basic: '4 models',  pro: '4 models',          max: '5 models (incl. Claude)' } },
  { label: 'Sessions per month',  values: { free: '5',            basic: 'Unlimited', pro: 'Unlimited',         max: 'Unlimited' } },
  { label: 'Time per session',    values: { free: 'Credit-gated', basic: 'Credit-gated (renewable)', pro: 'Unlimited', max: 'Unlimited' } },
  { label: 'Pop-out window',      values: { free: false,          basic: true,        pro: true,                max: true } },
  { label: 'Auto-Solve (camera)', values: { free: false,          basic: true,        pro: true,                max: true } },
  { label: 'Auto-Type (typing)',  values: { free: false,          basic: false,       pro: false,               max: true } },
  { label: 'Train Model (Claude)', values: { free: false,         basic: false,       pro: false,               max: true } },
  { label: 'Context files',       values: { free: '1',            basic: 'Unlimited', pro: 'Unlimited',         max: 'Unlimited' } },
];

const TIER_ORDER = ['free', 'basic', 'pro', 'max'] as const;

export function ManageSubscription({
  isOpen,
  onClose,
  userProfile,
  userLicense,
  onLogout,
  onUpgradeRequested,
}: ManageSubscriptionProps) {
  const [sub, setSub] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null); // tracks which button is in-flight
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  // Backfill state — for the "Sync chat history to cloud" action.
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<BackfillProgress | null>(null);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);
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

  const handleCancelRazorpay = useCallback(async () => {
    setCancelConfirm(false);
    setActionLoading('cancel');
    setError(null);
    setSuccess(null);
    try {
      const token = licenseService.getToken();
      if (!token) throw new Error('Not signed in');
      const res = await fetch(`${API_BASE}/api/v1/payments/cancel-razorpay`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Could not cancel subscription');
      }
      const data = await res.json();
      setSuccess(data.message || 'Cancellation scheduled for end of billing cycle.');
      // Refetch to update status.
      fetchSubscription();
    } catch (e: any) {
      setError(e?.message || 'Failed to cancel');
    } finally {
      if (mountedRef.current) setActionLoading(null);
    }
  }, [fetchSubscription]);

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

  const handleUpgradeTier = useCallback(async (targetTier: 'pro' | 'max') => {
    setActionLoading(`upgrade-${targetTier}`);
    setError(null);
    setSuccess(null);
    try {
      const token = licenseService.getToken();
      if (!token) throw new Error('Not signed in');
      const res = await fetch(`${API_BASE}/api/v1/payments/upgrade-tier`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetTier }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Could not switch to ${targetTier}`);
      }
      setSuccess(`Switched to ${targetTier.toUpperCase()}. New tier active immediately.`);
      fetchSubscription();
    } catch (e: any) {
      setError(e?.message || 'Failed to change plan');
    } finally {
      if (mountedRef.current) setActionLoading(null);
    }
  }, [fetchSubscription]);

  if (!isOpen) return null;

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

  return (
    <div
      className="fixed inset-0 z-[99999] bg-black/85 overflow-y-auto custom-scrollbar"
      style={{ WebkitAppRegion: 'no-drag' } as any}
      role="dialog"
      aria-modal="true"
      aria-label="Manage subscription"
    >
      {/* Top bar */}
      <div className="sticky top-0 z-10 bg-[#0a0a0d]/95 border-b border-white/[0.06] px-6 py-3 flex items-center justify-between">
        <h2 className="text-lg font-bold text-white">Manage subscription</h2>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-lg hover:bg-white/[0.08] flex items-center justify-center text-gray-400 hover:text-white transition-colors"
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </div>

      <div className="max-w-3xl mx-auto p-6 space-y-6">
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
                </div>
                <p className="text-sm text-white/70 leading-relaxed">{tierMeta.blurb}</p>
              </div>
            </div>
          </div>

          {/* Plan-specific detail strip */}
          {tier !== 'free' && (
            <div className="mt-5 pt-4 border-t border-white/10 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              {tier === 'basic' ? (
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

        {/* Primary actions */}
        <div className="space-y-3">
          <h4 className="text-xs font-bold uppercase tracking-wider text-white/50">Actions</h4>

          {isStripe && (
            <button
              onClick={handleStripePortal}
              disabled={actionLoading === 'portal'}
              className="w-full flex items-center justify-between gap-3 p-4 rounded-xl border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/15 transition-colors disabled:opacity-50"
            >
              <div className="flex items-center gap-3">
                <ExternalLink size={18} className="text-blue-400" />
                <div className="text-left">
                  <div className="font-semibold text-white text-sm">Manage billing & payment methods</div>
                  <div className="text-xs text-white/60">Update card, view invoices, change billing cycle, cancel — all in Stripe's hosted portal.</div>
                </div>
              </div>
              {actionLoading === 'portal' ? <Loader2 size={16} className="animate-spin text-blue-400" /> : <ChevronRight size={16} className="text-white/40" />}
            </button>
          )}

          {isRazorpay && tier !== 'free' && status === 'active' && (
            <>
              <div className="flex items-start gap-3 p-3 rounded-lg bg-blue-500/10 border border-blue-500/30 text-xs text-blue-200/80">
                <Info size={14} className="shrink-0 mt-0.5" />
                <span>
                  Razorpay subscriptions don't have a self-serve portal. Use the buttons below to switch tiers or cancel. For card / payment-method changes, contact support — your subscription may need to be re-created.
                </span>
              </div>
              {tier !== 'pro' && (
                <button
                  onClick={() => handleUpgradeTier('pro')}
                  disabled={actionLoading === 'upgrade-pro'}
                  className="w-full flex items-center justify-between gap-3 p-4 rounded-xl border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/15 transition-colors disabled:opacity-50"
                >
                  <div className="flex items-center gap-3">
                    <Crown size={18} className="text-blue-400" />
                    <div className="text-left">
                      <div className="font-semibold text-white text-sm">{tier === 'max' ? 'Downgrade to Pro' : 'Switch to Pro'}</div>
                      <div className="text-xs text-white/60">{tier === 'max' ? 'Effective at next renewal.' : 'Effective immediately.'}</div>
                    </div>
                  </div>
                  {actionLoading === 'upgrade-pro' ? <Loader2 size={16} className="animate-spin text-blue-400" /> : <ChevronRight size={16} className="text-white/40" />}
                </button>
              )}
              {tier !== 'max' && (
                <button
                  onClick={() => handleUpgradeTier('max')}
                  disabled={actionLoading === 'upgrade-max'}
                  className="w-full flex items-center justify-between gap-3 p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/15 transition-colors disabled:opacity-50"
                >
                  <div className="flex items-center gap-3">
                    <Crown size={18} className="text-amber-400" />
                    <div className="text-left">
                      <div className="font-semibold text-white text-sm">Upgrade to Max</div>
                      <div className="text-xs text-white/60">Adds Claude + Auto-Type + Train Model. Effective immediately.</div>
                    </div>
                  </div>
                  {actionLoading === 'upgrade-max' ? <Loader2 size={16} className="animate-spin text-amber-400" /> : <ChevronRight size={16} className="text-white/40" />}
                </button>
              )}
              {!cancelConfirm ? (
                <button
                  onClick={() => setCancelConfirm(true)}
                  className="w-full flex items-center justify-between gap-3 p-4 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <X size={18} className="text-red-400" />
                    <div className="text-left">
                      <div className="font-semibold text-white text-sm">Cancel subscription</div>
                      <div className="text-xs text-white/60">You'll keep access until the end of your current billing cycle.</div>
                    </div>
                  </div>
                  <ChevronRight size={16} className="text-white/40" />
                </button>
              ) : (
                <div className="p-4 rounded-xl border border-red-500/30 bg-red-500/10 space-y-3">
                  <div className="flex items-start gap-3">
                    <AlertTriangle size={18} className="text-red-400 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold text-red-200 text-sm">Cancel your {tierMeta.label} subscription?</div>
                      <div className="text-xs text-red-200/80 mt-1">Your subscription will be canceled at the end of the current billing cycle. You'll keep full access until {formatExpiry(expiresAt)}. No refund for the partial period.</div>
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setCancelConfirm(false)}
                      className="px-4 py-2 rounded-lg text-sm font-medium bg-white/10 text-white hover:bg-white/15 transition-colors"
                    >
                      Keep subscription
                    </button>
                    <button
                      onClick={handleCancelRazorpay}
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

          {!isPaidProvider && tier === 'free' && (
            <>
              <button
                onClick={() => onUpgradeRequested('pro')}
                className="w-full flex items-center justify-between gap-3 p-4 rounded-xl border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/15 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Crown size={18} className="text-blue-400" />
                  <div className="text-left">
                    <div className="font-semibold text-white text-sm">Upgrade to Pro</div>
                    <div className="text-xs text-white/60">Unlimited time + 4 AI models + Pop-out + Auto-Solve.</div>
                  </div>
                </div>
                <ChevronRight size={16} className="text-white/40" />
              </button>
              <button
                onClick={() => onUpgradeRequested('max')}
                className="w-full flex items-center justify-between gap-3 p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/15 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Crown size={18} className="text-amber-400" />
                  <div className="text-left">
                    <div className="font-semibold text-white text-sm">Upgrade to Max</div>
                    <div className="text-xs text-white/60">Pro + Claude Sonnet 4.6 + Auto-Type + Train Model pipeline.</div>
                  </div>
                </div>
                <ChevronRight size={16} className="text-white/40" />
              </button>
            </>
          )}
        </div>

        {/* Plan comparison */}
        <div className="space-y-3">
          <h4 className="text-xs font-bold uppercase tracking-wider text-white/50">Compare plans</h4>
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
          <h4 className="text-xs font-bold uppercase tracking-wider text-white/50">Account</h4>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] divide-y divide-white/5">
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-white/50 mb-0.5">Email</div>
                <div className="text-sm text-white">{userProfile?.email || '—'}</div>
              </div>
              {userProfile?.oauth_provider === 'google' && (
                <span className="text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded border border-white/15 text-white/70">
                  Google
                </span>
              )}
            </div>
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
            <button
              onClick={() => { onClose(); onLogout(); }}
              className="w-full flex items-center gap-3 px-4 py-3 text-sm text-red-400 hover:bg-red-500/5 transition-colors text-left"
            >
              <LogOut size={14} />
              Sign out
            </button>
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
            <a
              href="https://minicaai.com/refund-policy"
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                if (window.electronAPI?.openExternal) {
                  e.preventDefault();
                  window.electronAPI.openExternal('https://minicaai.com/refund-policy');
                }
              }}
              className="hover:text-white transition-colors"
            >
              Refund policy
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
