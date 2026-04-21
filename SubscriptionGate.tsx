import React, { useState, useEffect, useRef } from 'react';
import { Shield, Zap, Crown, Check, X, ArrowRight, ArrowLeft, Globe, Lock, Sparkles, ChevronRight, Eye, EyeOff, AlertTriangle, Loader2, Star, Users, Cpu, Headphones, Bot, BarChart3, Monitor, Download, Play, BookOpen, ChevronDown, LogOut, MessageCircle, Send, Mail, Settings, ExternalLink, XCircle, Clock, DollarSign, RefreshCw, Trash2, Edit2, Key, UserCheck, Activity, FileDown, Filter, Ban, TrendingUp, Gift, Database, Search } from 'lucide-react';
import { GoogleOAuthProvider, GoogleLogin } from '@react-oauth/google';
import { geoService, GeoData } from './services/geoService';
import { pricingService, RegionPricing, PricingTier } from './services/pricingService';
import { licenseService, UserProfile, LicenseData } from './services/licenseService';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '179380214544-5r338sqpqr6ke6tnsf165ic7qi9th0ht.apps.googleusercontent.com';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SUBSCRIPTION GATE — Landing → Auth → Download funnel
//  Website is NOT the app. Users MUST download Electron app.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface SubscriptionGateProps {
  onAuthenticated: (user: UserProfile, license: LicenseData) => void;
}

type View = 'landing' | 'login' | 'signup' | 'forgot_password' | 'pricing' | 'vpn_blocked' | 'download' | 'tutorials' | 'admin' | 'support';

// ── Detect if running inside Electron ──
const isElectron = typeof window !== 'undefined' && !!(window as any).process?.versions?.electron;

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

const Logo = ({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) => {
  const sizes = { sm: 'w-8 h-8', md: 'w-10 h-10', lg: 'w-14 h-14' };
  const textSizes = { sm: 'text-lg', md: 'text-xl', lg: 'text-3xl' };
  return (
    <div className="flex items-center gap-3">
      <div className={`${sizes[size]} rounded-2xl bg-gradient-to-br from-blue-500 via-blue-600 to-purple-600 flex items-center justify-center shadow-lg shadow-blue-500/25`}>
        <Bot className="text-white" size={size === 'lg' ? 28 : size === 'md' ? 20 : 16} strokeWidth={1.5} />
      </div>
      <div>
        <h1 className={`${textSizes[size]} font-bold tracking-tight text-white`}>
          minica<span className="text-blue-400">ai</span>
        </h1>
        {size === 'lg' && <p className="text-[11px] text-gray-500 font-medium tracking-widest uppercase mt-0.5">Interview Intelligence</p>}
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
const PricingCard = ({ tier, onSelect, isLoading }: { tier: PricingTier; onSelect: (tier: PricingTier) => void; isLoading: boolean }) => {
  const isPopular = !!tier.popular;

  // Per-tier visual theme. Popular tier gets the highlighted "Recommended" card frame.
  const theme =
    tier.id === 'max'   ? { accent: 'amber',   iconBg: 'bg-amber-500/15',   icon: <Crown size={20} className="text-amber-400" /> } :
    tier.id === 'pro'   ? { accent: 'blue',    iconBg: 'bg-blue-500/15',    icon: <Crown size={20} className="text-blue-400" /> } :
    tier.id === 'basic' ? { accent: 'emerald', iconBg: 'bg-emerald-500/15', icon: <Sparkles size={20} className="text-emerald-400" /> } :
                          { accent: 'gray',    iconBg: 'bg-gray-500/10',    icon: <Zap size={20} className="text-gray-400" /> };

  const periodLabel = tier.period === 'month' ? '/mo' : tier.period === 'year' ? '/yr' : '';

  const ctaClass = isPopular
    ? 'bg-gradient-to-r from-emerald-500 to-emerald-600 text-white hover:from-emerald-400 hover:to-emerald-500 shadow-lg shadow-emerald-500/25'
    : tier.id === 'max'
      ? 'bg-gradient-to-r from-amber-500 to-purple-500 text-white hover:from-amber-400 hover:to-purple-400 shadow-lg shadow-amber-500/20'
      : tier.id === 'pro'
        ? 'bg-gradient-to-r from-blue-500 to-blue-600 text-white hover:from-blue-400 hover:to-blue-500 shadow-lg shadow-blue-500/25'
        : 'bg-white/[0.06] text-white hover:bg-white/[0.1] border border-white/[0.1]';

  const frameClass = isPopular
    ? 'border-emerald-500/40 bg-gradient-to-b from-emerald-500/[0.08] to-transparent shadow-xl shadow-emerald-500/10'
    : tier.id === 'max'
      ? 'border-amber-500/30 bg-gradient-to-b from-amber-500/[0.05] to-transparent'
      : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.15]';

  return (
    <div className={`relative rounded-2xl border transition-all duration-300 hover:scale-[1.02] ${frameClass}`}>
      {isPopular && (
        <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
          <div className="px-4 py-1 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600 text-white text-[10px] font-bold tracking-wider uppercase shadow-lg">
            Best Deal
          </div>
        </div>
      )}

      <div className="p-6 pt-8">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-4 ${theme.iconBg}`}>
          {theme.icon}
        </div>

        <h3 className="text-lg font-bold text-white mb-1">{tier.name}</h3>
        {tier.subtitle && <p className="text-[11px] text-gray-500 mb-3">{tier.subtitle}</p>}

        <div className="flex items-baseline gap-1 mb-6">
          {tier.price === 0 ? (
            <span className="text-3xl font-bold text-white">Free</span>
          ) : (
            <>
              <span className="text-3xl font-bold text-white">
                {pricingService.formatPrice(tier.price, tier.currencySymbol, tier.currency)}
              </span>
              {periodLabel && <span className="text-sm text-gray-500">{periodLabel}</span>}
            </>
          )}
        </div>

        <button
          onClick={() => onSelect(tier)}
          disabled={isLoading}
          className={`w-full py-3 px-4 rounded-xl font-semibold text-sm transition-all duration-200 flex items-center justify-center gap-2 ${ctaClass}`}
        >
          {isLoading ? <Loader2 size={16} className="animate-spin" /> : null}
          {tier.cta}
          {!isLoading && <ArrowRight size={14} />}
        </button>

        <div className="mt-6 space-y-3">
          {tier.features.map((feature, i) => (
            <div key={i} className="flex items-start gap-2.5">
              <div className={`w-4 h-4 rounded-full flex items-center justify-center mt-0.5 shrink-0 ${
                isPopular ? 'bg-emerald-500/20' : tier.id === 'max' ? 'bg-amber-500/20' : 'bg-white/[0.06]'
              }`}>
                <Check size={10} className={
                  isPopular ? 'text-emerald-400' : tier.id === 'max' ? 'text-amber-400' : 'text-gray-400'
                } strokeWidth={3} />
              </div>
              <span className="text-sm text-gray-400">{feature}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ── Tutorial Card ──
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
const API_BASE = 'https://h2so4-production.up.railway.app';

type Tier = 'free' | 'basic' | 'pro' | 'max';
const TIERS: Tier[] = ['free', 'basic', 'pro', 'max'];

// Single source of truth for tier color-coding. Any place that shows a tier
// pulls its Tailwind classes from here so Free/Basic/Pro/Max always look the
// same across badges, cards, tables, and the action panel.
const TIER_THEME: Record<Tier, { bg: string; text: string; border: string; bar: string; dot: string; Icon: any }> = {
  free:  { bg: 'bg-slate-500/10',   text: 'text-slate-300',   border: 'border-slate-500/25',   bar: 'bg-slate-400',    dot: 'bg-slate-400',    Icon: Zap },
  basic: { bg: 'bg-emerald-500/10', text: 'text-emerald-300', border: 'border-emerald-500/25', bar: 'bg-emerald-400',  dot: 'bg-emerald-400',  Icon: Sparkles },
  pro:   { bg: 'bg-indigo-500/10',  text: 'text-indigo-300',  border: 'border-indigo-500/25',  bar: 'bg-indigo-400',   dot: 'bg-indigo-400',   Icon: Crown },
  max:   { bg: 'bg-amber-500/10',   text: 'text-amber-300',   border: 'border-amber-500/25',   bar: 'bg-amber-400',    dot: 'bg-amber-400',    Icon: Crown },
};
const tierOf = (t?: string): (typeof TIER_THEME)[Tier] => (TIER_THEME as any)[t || ''] || TIER_THEME.free;

const TierBadge = ({ tier }: { tier?: string }) => {
  const th = tierOf(tier);
  const label = (tier || 'free').toUpperCase();
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${th.bg} ${th.text} ${th.border}`}>
      {label === 'MAX' && <Crown size={9} />}
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

  const userId = searchResult?.user?.id;
  const stubCount = (searchResult?.conversations || []).length;
  const fmt = (ts: number) => (ts ? new Date(ts).toLocaleString() : '—');

  const loadFull = async () => {
    if (!userId || !token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/users/${userId}`, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load conversations');
      setConversations(Array.isArray(data.conversations) ? data.conversations : []);
    } catch (err: any) {
      setError(err.message || 'Failed to load conversations');
    } finally {
      setLoading(false);
    }
  };

  // Reset view when the searched user changes. Auto-expand for users with
  // few conversations (<=3) — the previous collapsed-by-default UX was
  // frequently missed, which was the reported "admin can't see conversations"
  // issue. For heavy users we still collapse to keep the panel manageable.
  useEffect(() => {
    setConversations(null);
    setOpenConvId(null);
    setError(null);
    const shouldAutoExpand = stubCount > 0 && stubCount <= 3;
    setExpanded(shouldAutoExpand);
    if (shouldAutoExpand) loadFull();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, stubCount]);

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
type AdminTab = 'overview' | 'users' | 'payments' | 'revoked' | 'logins' | 'audit' | 'analytics' | 'settings';
const ADMIN_TABS: AdminTab[] = ['overview', 'users', 'payments', 'revoked', 'logins', 'audit', 'analytics', 'settings'];

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
  const [editProfileFor, setEditProfileFor] = useState<{ id: string; email: string; name: string; country_code: string } | null>(null);
  const [compGrantFor, setCompGrantFor] = useState<{ id: string; email: string } | null>(null);
  const [refundFor, setRefundFor] = useState<{ payment: any } | null>(null);

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
    setConfirmDialog({
      title: `Ban ${email}?`,
      body: `Their license will be revoked and all active sessions invalidated. This action is logged in the audit trail.`,
      confirmLabel: 'Ban user',
      danger: true,
      onConfirm: async () => {
        const data = await callMutation('/api/v1/admin/users/ban', { email }, `${email} banned`);
        if (!data) return;
        patchUserEverywhere(email, u => ({ ...u, is_banned: 1 }));
      },
    });
  };

  const handleUnban = async (email: string) => {
    const data = await callMutation('/api/v1/admin/users/unban', { email }, `${email} unbanned`);
    if (!data) return;
    patchUserEverywhere(email, u => ({ ...u, is_banned: 0 }));
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
        // Drop the token into a quick prompt modal for copy.
        setConfirmDialog({
          title: 'Impersonation token',
          body: `Expires in 30 days. DO NOT replace your own session.\n\n${data.token}`,
          confirmLabel: 'Copy to clipboard',
          onConfirm: async () => {
            try {
              await navigator.clipboard.writeText(data.token);
              showMsg('Token copied — handle with care', 'success');
            } catch {
              showMsg('Failed to copy — select and copy manually', 'error');
            }
          },
        });
      },
    });
  };

  const handleEditProfile = (user: any) => {
    setEditProfileFor({
      id: user.id,
      email: user.email,
      name: user.name || '',
      country_code: user.country_code || '',
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

  // Tab-triggered lazy loads. Each tab loads its data the first time it
  // opens and on subsequent opens if the data is stale (we keep it simple
  // and only reload on first entry — user can hit a manual refresh button).
  useEffect(() => {
    if (adminTab === 'payments' && payments.length === 0) loadPayments();
    if (adminTab === 'revoked' && revokedKeys.length === 0) loadRevoked();
    if (adminTab === 'audit' && auditFacets.actions.length === 0) loadAuditFacets();
    if (adminTab === 'analytics' && trends.length === 0) loadAnalytics();
    if (adminTab === 'settings' && configRows.length === 0) loadConfig();
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
                <div>
                  <h1 className="text-2xl font-bold mb-1">Login Activity</h1>
                  <p className="text-gray-500 text-sm">Last 100 login attempts</p>
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
                          let details = '';
                          if (row.details_json) {
                            try { details = JSON.stringify(JSON.parse(row.details_json)); }
                            catch { details = row.details_json; }
                          }
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
                          return (
                            <tr key={row.id || i} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                              <td className="px-4 py-3 text-gray-400 whitespace-nowrap">{fmtDate(row.created_at)}</td>
                              <td className="px-4 py-3 text-white font-medium">{row.admin_email}</td>
                              <td className="px-4 py-3">
                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${actionColor}`}>{row.action}</span>
                              </td>
                              <td className="px-4 py-3 text-gray-300">{row.target_email || '—'}</td>
                              <td className="px-4 py-3 text-gray-500 font-mono text-[10px] max-w-[420px] truncate" title={details}>{details || '—'}</td>
                            </tr>
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

                {/* Daily trends sparkline (text table — enough signal for now) */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-xs text-gray-500 uppercase tracking-widest font-semibold">30-Day Trends</h2>
                    <p className="text-[10px] text-gray-600">Signups · Logins · Revenue (all currencies summed in their native minor units — see tooltip for breakdown)</p>
                  </div>
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

                <div className="p-4 rounded-xl border border-amber-500/20 bg-amber-500/[0.04] text-amber-200 text-xs">
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <div>
                      Known keys: <span className="font-mono">min_app_version</span>, <span className="font-mono">latest_app_version</span>.
                      Other keys can be introduced by the server — they'll appear here automatically.
                    </div>
                  </div>
                </div>
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
            <div className="mt-5 flex items-center justify-end gap-2">
              <button onClick={() => setEditProfileFor(null)} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] transition-all">Cancel</button>
              <button onClick={submitEditProfile} className="px-4 py-2 rounded-lg text-sm font-semibold bg-blue-500/20 text-blue-200 hover:bg-blue-500/30 border border-blue-500/30 transition-all">Save</button>
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

      {/* ── REFUND MODAL ── */}
      {refundFor && (() => {
        const p = refundFor.payment;
        let amount = p.amount;
        let reason = 'requested_by_customer';
        return (
          <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/70 backdrop-blur-sm" role="dialog" aria-modal="true" onClick={() => setRefundFor(null)}>
            <div className="relative w-full max-w-md mx-4 rounded-2xl bg-[#0b0b0f] border border-pink-500/20 shadow-2xl p-6" onClick={e => e.stopPropagation()}>
              <div className="flex items-start gap-3 mb-4">
                <div className="shrink-0 p-2 rounded-lg bg-pink-500/15 text-pink-400"><RefreshCw size={18} /></div>
                <div>
                  <h3 className="text-base font-semibold text-white">Issue Refund</h3>
                  <p className="text-xs text-gray-500">{p.email} · {p.provider.toUpperCase()} · {fmtAmount(p.amount, p.currency)}</p>
                </div>
              </div>
              <p className="text-xs text-gray-400 mb-4 p-3 rounded-lg bg-amber-500/[0.04] border border-amber-500/20">
                Refund hits the provider immediately. A webhook will downgrade this user's tier shortly after. Partial refunds are supported — enter a smaller amount to refund less than the full charge. Requires step-up password.
              </p>
              <label className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold block mb-1">Amount ({p.currency.toUpperCase()} · minor units, e.g. cents/paise)</label>
              <input
                type="number"
                defaultValue={p.amount}
                onChange={e => { amount = parseInt(e.target.value, 10) || 0; }}
                className="w-full px-3 py-2 mb-3 rounded-lg bg-white/[0.04] border border-white/[0.1] text-white text-sm focus:outline-none focus:border-pink-500/50 font-mono"
              />
              <label className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold block mb-1">Reason</label>
              <select
                defaultValue="requested_by_customer"
                onChange={e => { reason = e.target.value; }}
                className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.1] text-white text-sm focus:outline-none focus:border-pink-500/50"
              >
                <option value="requested_by_customer">Requested by customer</option>
                <option value="duplicate">Duplicate charge</option>
                <option value="fraudulent">Fraudulent</option>
              </select>
              <div className="mt-5 flex items-center justify-end gap-2">
                <button onClick={() => setRefundFor(null)} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] transition-all">Cancel</button>
                <button onClick={() => submitRefund(amount, reason)} className="px-4 py-2 rounded-lg text-sm font-semibold bg-pink-500/20 text-pink-200 hover:bg-pink-500/30 border border-pink-500/30 transition-all">Issue refund</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MAIN GATE COMPONENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const SubscriptionGateInner: React.FC<SubscriptionGateProps> = ({ onAuthenticated }) => {
  const [view, setView] = useState<View>('landing');
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
  const [authError, setAuthError] = useState<string | null>(null);
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
        return 'Payment successful — Pro activated. Unlimited sessions and all models unlocked.';
      case 'max':
        return 'Payment successful — Max activated. Auto-Type plus everything in Pro is now live.';
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

      if (urlParams.get('payment') === 'success') {
        const saved = licenseService.loadAuth();
        if (saved.user) {
          // Revalidate with server to get updated tier. The webhook may not
          // have landed yet when the user returns from Stripe — fall back to
          // the tier hint we stamped in the success_url so the banner copy
          // still matches what they paid for.
          const validated = await licenseService.validateWithServer();
          const urlTierHint = urlParams.get('tier');
          // `mode=renewal` is stamped on the success URL by /create-renewal.
          // Renewal banners don't advertise "3 credits / 14 days" — they
          // say "1 extra interview / 1 hour" instead.
          const isRenewal = urlParams.get('mode') === 'renewal';
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
      const serverUrl = 'https://h2so4-production.up.railway.app';
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

  // ── Initiate payment checkout (Stripe or Razorpay based on geo) ──
  const initiateCheckout = async (tier: 'basic' | 'pro' | 'max' = pendingCheckoutTier) => {
    setPaymentLoading(true);
    setPaymentError(null);

    try {
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
        response = await fetch(`https://h2so4-production.up.railway.app${endpointPath}`, {
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
          const updatedLicense: LicenseData = data.license
            ? { ...(data.license as LicenseData), last_validated: Date.now() }
            : { ...(saved.license || currentLicense)!, tier: grantedTier as LicenseData['tier'], last_validated: Date.now() };
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
        // Stripe — redirect to hosted checkout
        window.location.href = data.checkout_url;
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
        response = await fetch('https://h2so4-production.up.railway.app/api/v1/payments/create-renewal', {
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
        window.location.href = data.checkout_url;
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
      const res = await fetch('https://h2so4-production.up.railway.app/api/v1/payments/portal', {
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
      const res = await fetch('https://h2so4-production.up.railway.app/api/v1/payments/cancel-razorpay', {
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
              const verifyRes = await fetch('https://h2so4-production.up.railway.app/api/v1/payments/verify-razorpay', {
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
                const newLicense = verifyData.license
                  || (currentLicense
                        ? { ...currentLicense, tier: grantedTier, status: 'active' as const }
                        : null);
                if (newLicense) {
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
  const handleGoogleElectron = async () => {
    setIsSubmitting(true);
    setAuthError(null);

    const sessionId = crypto.randomUUID();
    const serverUrl = 'https://h2so4-production.up.railway.app';
    const authUrl = `${serverUrl}/api/v1/auth/google/start?session_id=${sessionId}`;

    try {
      // Open Google sign-in in system browser
      if (isElectron) {
        (window as any).require('electron').shell.openExternal(authUrl);
      } else {
        window.open(authUrl, '_blank');
      }

      // Poll for result
      let attempts = 0;
      const maxAttempts = 60; // 60 * 2s = 2 minutes
      const pollInterval = 2000;

      const poll = async (): Promise<void> => {
        // Abort if the gate unmounted between polls (user navigated away
        // or auth completed on another code path). Saved auth from the
        // server is already persisted by /poll handler's saveAuth above,
        // so dropping this poll does not lose data.
        if (!mountedRef.current) return;
        attempts++;
        try {
          const res = await fetch(`${serverUrl}/api/v1/auth/google/poll?session_id=${sessionId}`);
          const data = await res.json();
          if (!mountedRef.current) return;

          if (data.status === 'success') {
            // Save auth data
            if (data.license) data.license.last_validated = Date.now();
            licenseService.saveAuth(data.user, data.license, data.token);

            setCurrentUser(data.user);
            setCurrentLicense(data.license);
            setIsSubmitting(false);

            if (isElectron) {
              // Pull the Electron window back to the foreground — the browser
              // "you can close this tab" page leaves the desktop app hidden
              // behind it otherwise.
              try {
                (window as any).require('electron').ipcRenderer.send('focus-main-window');
              } catch {}
              onAuthenticated(data.user, data.license);
            } else {
              setView('download');
            }
            return;
          }

          if (data.status === 'error') {
            setAuthError(data.error || 'Google sign-in failed');
            setIsSubmitting(false);
            return;
          }

          // Still pending
          if (attempts < maxAttempts) {
            await new Promise(r => setTimeout(r, pollInterval));
            if (!mountedRef.current) return;
            return poll();
          } else {
            setAuthError('Sign-in timed out. Please try again.');
            setIsSubmitting(false);
          }
        } catch {
          if (!mountedRef.current) return;
          if (attempts < maxAttempts) {
            await new Promise(r => setTimeout(r, pollInterval));
            if (!mountedRef.current) return;
            return poll();
          }
          setAuthError('Connection error. Please try again.');
          setIsSubmitting(false);
        }
      };

      await poll();
    } catch (err: any) {
      setAuthError(err.message || 'Google sign-in failed');
      setIsSubmitting(false);
    }
  };

  // ── Logout ──
  const handleLogout = () => {
    licenseService.logout();
    setCurrentUser(null);
    setCurrentLicense(null);
    setView('landing');
    setEmail('');
    setPassword('');
    setName('');
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
          <a href="https://github.com/madhavvan/h2so4/releases/latest" className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold text-sm transition-all shadow-lg shadow-blue-500/25">
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

  // ── TUTORIALS VIEW ──
  if (view === 'tutorials') {
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
    return (
      <div className="fixed inset-0 bg-[#050507] text-white overflow-y-auto">
        <AnimatedBackground />
        <NoiseOverlay />

        <nav className="relative z-10 flex items-center justify-between px-6 py-4 max-w-6xl mx-auto">
          <Logo size="md" />
          <div className="flex items-center gap-3">
            {currentUser && (
              <>
                <span className="text-xs text-gray-500">{currentUser.email}</span>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${currentLicense?.tier === 'max' ? 'bg-amber-500/20 text-amber-400' : currentLicense?.tier === 'pro' ? 'bg-blue-500/20 text-blue-400' : currentLicense?.tier === 'basic' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-gray-500/20 text-gray-400'}`}>
                  {currentLicense?.tier || 'free'}
                </span>
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
            <a href="https://github.com/madhavvan/h2so4/releases/latest/download/InterviewCopilot-Setup.exe"
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

            <a href="https://github.com/madhavvan/h2so4/releases/latest/download/InterviewCopilot-Mac.dmg"
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

            <a href="https://github.com/madhavvan/h2so4/releases/latest/download/InterviewCopilot-Linux.AppImage"
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
                        <Crown size={14} /> {isAdminUser ? 'Admin · Max Active' : 'Max Active'}
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

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  LANDING PAGE
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (view === 'landing') {
    return (
      <div className="fixed inset-0 bg-[#050507] text-white overflow-y-auto">
        <AnimatedBackground />
        <NoiseOverlay />

        {/* Nav */}
        <nav className="relative z-10 flex items-center justify-between px-6 py-4 max-w-6xl mx-auto">
          <Logo size="md" />
          <div className="flex items-center gap-3">
            <button onClick={() => setView('tutorials')} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-400 hover:text-white transition-colors">
              Tutorials
            </button>
            <button onClick={() => setView('login')} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-400 hover:text-white transition-colors">
              Sign In
            </button>
            <button onClick={() => setView('signup')} className="px-4 py-2 rounded-lg text-sm font-medium bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] transition-all">
              Get Started
            </button>
          </div>
        </nav>

        {/* Hero */}
        <div className="relative z-10 max-w-4xl mx-auto px-6 pt-20 pb-16 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-blue-500/20 bg-blue-500/[0.06] mb-8">
            <Sparkles size={12} className="text-blue-400" />
            <span className="text-xs font-medium text-blue-300">Powered by GPT-5 & Gemini 3</span>
          </div>

          <h1 className="text-5xl md:text-7xl font-bold tracking-tight leading-[1.1] mb-6">
            Ace every interview
            <br />
            <span className="bg-gradient-to-r from-blue-400 via-purple-400 to-cyan-400 bg-clip-text text-transparent">
              with AI by your side
            </span>
          </h1>

          <p className="text-lg md:text-xl text-gray-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            Real-time AI copilot that listens to your interview, understands context from your resume,
            and crafts perfect answers instantly. Invisible. Intelligent. Unstoppable.
          </p>

          <div className="flex items-center justify-center gap-4 mb-12">
            <button onClick={() => setView('signup')} className="px-8 py-3.5 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold text-sm hover:from-blue-400 hover:to-blue-500 transition-all shadow-xl shadow-blue-500/25 hover:shadow-blue-500/40 flex items-center gap-2">
              Download Free <Download size={16} />
            </button>
            <button onClick={() => setView('pricing')} className="px-8 py-3.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.1] text-white font-semibold text-sm transition-all flex items-center gap-2">
              View Pricing <ChevronRight size={16} />
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2">
            <FeaturePill icon={Headphones} text="System Audio Capture" />
            <FeaturePill icon={Monitor} text="Screen Analysis" />
            <FeaturePill icon={Cpu} text="Multi-Model AI" />
            <FeaturePill icon={Shield} text="Invisible Mode" />
            <FeaturePill icon={BarChart3} text="Smart Context" />
          </div>
        </div>

        {/* Social proof */}
        <div className="flex items-center justify-center gap-8 py-6 opacity-40">
          <div className="flex items-center gap-2"><Users size={14} /><span className="text-xs font-medium">10,000+ users</span></div>
          <div className="w-1 h-1 rounded-full bg-gray-600" />
          <div className="flex items-center gap-2"><Star size={14} className="fill-current" /><span className="text-xs font-medium">4.9/5 rating</span></div>
          <div className="w-1 h-1 rounded-full bg-gray-600" />
          <div className="flex items-center gap-2"><Globe size={14} /><span className="text-xs font-medium">50+ countries</span></div>
        </div>

        {/* How it works */}
        <div className="relative z-10 max-w-5xl mx-auto px-6 py-20">
          <h2 className="text-2xl md:text-3xl font-bold text-center mb-4">How it works</h2>
          <p className="text-gray-500 text-center mb-14 text-sm">Three steps to interview mastery</p>
          <div className="grid md:grid-cols-3 gap-6">
            {[
              { step: '01', title: 'Download & Sign In', desc: 'Download the desktop app, create an account, and your license activates on your device.', icon: Download },
              { step: '02', title: 'AI Listens', desc: 'Share your interview audio. minicaai transcribes and analyzes questions against your resume.', icon: Bot },
              { step: '03', title: 'Get Answers', desc: 'Receive crafted responses instantly. Copy, adapt, and deliver with confidence.', icon: Zap },
            ].map(({ step, title, desc, icon: Icon }) => (
              <div key={step} className="p-6 rounded-2xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] transition-all group">
                <div className="flex items-center gap-3 mb-4">
                  <span className="text-xs font-bold text-blue-500 bg-blue-500/10 px-2.5 py-1 rounded-md">{step}</span>
                  <Icon size={18} className="text-gray-500 group-hover:text-blue-400 transition-colors" />
                </div>
                <h3 className="text-base font-semibold text-white mb-2">{title}</h3>
                <p className="text-sm text-gray-500 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Pricing (Free + Pro only) */}
        <div className="relative z-10 max-w-4xl mx-auto px-6 py-20" id="pricing">
          <h2 className="text-2xl md:text-3xl font-bold text-center mb-4">Simple pricing</h2>
          <p className="text-gray-500 text-center mb-4 text-sm">Start free, upgrade when you're ready</p>
          {geo && (
            <div className="flex items-center justify-center mb-10">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/[0.03] border border-white/[0.06] text-gray-500 text-xs">
                <Globe size={12} /> Prices for {geo.country_name}
              </div>
            </div>
          )}
          {pricing && (
            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-6xl mx-auto">
              {pricing.tiers.map((tier) => (
                <PricingCard key={tier.id} tier={tier} onSelect={handleTierSelect} isLoading={isSubmitting} />
              ))}
            </div>
          )}
        </div>

        {/* Security badges */}
        <div className="relative z-10 max-w-3xl mx-auto px-6 py-16">
          <div className="grid grid-cols-3 gap-4 text-center">
            {[
              { icon: Shield, label: 'Device-Bound License', desc: 'Your license is tied to your device. Cannot be shared.' },
              { icon: Lock, label: 'Server Validated', desc: 'Every session verified with our secure servers.' },
              { icon: Globe, label: 'Geo-Enforced', desc: 'Regional pricing enforced. VPN/proxy detected & blocked.' },
            ].map(({ icon: Icon, label, desc }, i) => (
              <div key={i} className="p-4">
                <Icon size={20} className="text-blue-400 mx-auto mb-2" />
                <p className="text-xs font-semibold text-white mb-1">{label}</p>
                <p className="text-[10px] text-gray-600 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <footer className="relative z-10 border-t border-white/[0.06] mt-10">
          <div className="max-w-5xl mx-auto px-6 py-8 flex items-center justify-between">
            <div className="flex items-center gap-2 text-gray-600 text-xs">
              <Bot size={14} /><span>minicaai.com</span>
            </div>
            <div className="flex items-center gap-6 text-xs text-gray-600">
              <span>Privacy</span><span>Terms</span><button onClick={() => { if (currentUser) { setView('support'); } else { setView('login'); setAuthError('Please sign in to access support'); } }} className="hover:text-white transition-colors">Support</button>
            </div>
          </div>
        </footer>
      </div>
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  LOGIN
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (view === 'login') {
    return (
      <div className="fixed inset-0 bg-[#050507] flex items-center justify-center p-6">
        <AnimatedBackground />
        <NoiseOverlay />
        <div className="relative z-10 w-full max-w-md">
          <div className="relative rounded-3xl border border-white/[0.08] bg-gradient-to-b from-white/[0.06] to-white/[0.02] backdrop-blur-xl shadow-2xl shadow-black/40 p-8 pt-6">
            {/* Close button */}
            <button onClick={() => setView('landing')} className="absolute top-4 right-4 w-8 h-8 rounded-full bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] flex items-center justify-center text-gray-500 hover:text-white transition-all">
              <X size={16} />
            </button>

            <Logo size="md" />
            <h2 className="text-xl font-bold text-white mt-6 mb-1">Welcome back</h2>
            <p className="text-sm text-gray-500 mb-6">Sign in to your minicaai account</p>

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5">Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
                  className="w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white placeholder-gray-600 text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all" required autoFocus />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-medium text-gray-400">Password</label>
                  <button
                    type="button"
                    onClick={() => { setAuthError(null); setForgotSent(false); setView('forgot_password'); }}
                    className="text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password"
                    className="w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white placeholder-gray-600 text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all pr-10" required />
                  <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors">
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              {authError && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
                  <AlertTriangle size={12} /> {authError}
                </div>
              )}
              <button type="submit" disabled={isSubmitting}
                className="w-full py-3 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold text-sm hover:from-blue-400 hover:to-blue-500 transition-all shadow-lg shadow-blue-500/25 flex items-center justify-center gap-2 disabled:opacity-50">
                {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : null} Sign In
              </button>
            </form>

            {/* Google Sign-In */}
            {GOOGLE_CLIENT_ID && (
              <>
                <div className="mt-6 flex items-center gap-3">
                  <div className="flex-1 h-px bg-white/[0.08]" />
                  <span className="text-[10px] text-gray-600 uppercase tracking-wider">or</span>
                  <div className="flex-1 h-px bg-white/[0.08]" />
                </div>
                {isElectron ? (
                  <button
                    onClick={handleGoogleElectron}
                    disabled={isSubmitting}
                    className="mt-4 w-full py-3 px-4 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.1] text-white text-sm font-medium transition-all flex items-center justify-center gap-3 disabled:opacity-50"
                  >
                    {isSubmitting ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                    )}
                    {isSubmitting ? 'Waiting for sign-in...' : 'Continue with Google'}
                  </button>
                ) : (
                  <div className="mt-4 flex justify-center [&_iframe]:rounded-xl">
                    <GoogleLogin
                      onSuccess={handleGoogleSuccess}
                      onError={handleGoogleError}
                      theme="filled_black"
                      size="large"
                      width="350"
                      text="signin_with"
                      shape="pill"
                    />
                  </div>
                )}
              </>
            )}

            <div className="mt-6 text-center">
              <span className="text-xs text-gray-600">Don't have an account? </span>
              <button onClick={() => setView('signup')} className="text-xs text-blue-400 hover:text-blue-300 font-medium transition-colors">Create one</button>
            </div>
            {geo && (
              <div className="mt-6 flex items-center justify-center gap-2 text-[10px] text-gray-600">
                <Lock size={10} /> Secure connection from {geo.country_name}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  FORGOT PASSWORD
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (view === 'forgot_password') {
    return (
      <div className="fixed inset-0 bg-[#050507] flex items-center justify-center p-6">
        <AnimatedBackground />
        <NoiseOverlay />
        <div className="relative z-10 w-full max-w-md">
          <div className="relative rounded-3xl border border-white/[0.08] bg-gradient-to-b from-white/[0.06] to-white/[0.02] backdrop-blur-xl shadow-2xl shadow-black/40 p-8 pt-6">
            <button
              onClick={() => { setAuthError(null); setForgotSent(false); setView('login'); }}
              className="absolute top-4 left-4 w-8 h-8 rounded-full bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] flex items-center justify-center text-gray-500 hover:text-white transition-all"
              aria-label="Back to login"
            >
              <ArrowLeft size={16} />
            </button>
            <button
              onClick={() => { setAuthError(null); setForgotSent(false); setView('landing'); }}
              className="absolute top-4 right-4 w-8 h-8 rounded-full bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] flex items-center justify-center text-gray-500 hover:text-white transition-all"
              aria-label="Close"
            >
              <X size={16} />
            </button>

            <div className="flex flex-col items-center mt-4 mb-6">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-white/[0.08] flex items-center justify-center mb-4">
                {forgotSent ? <Check size={24} className="text-emerald-400" /> : <Mail size={22} className="text-blue-400" />}
              </div>
              <h2 className="text-xl font-bold text-white mb-1">
                {forgotSent ? 'Check your email' : 'Forgot your password?'}
              </h2>
              <p className="text-sm text-gray-500 text-center max-w-xs">
                {forgotSent
                  ? `If an account exists for ${email}, a reset link is on its way. The link expires in 1 hour.`
                  : "Enter the email you signed up with and we'll send you a link to reset your password."}
              </p>
            </div>

            {!forgotSent ? (
              <form onSubmit={handleForgotPassword} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1.5">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white placeholder-gray-600 text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all"
                    required
                    autoFocus
                  />
                </div>
                {authError && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
                    <AlertTriangle size={12} /> {authError}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full py-3 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold text-sm hover:from-blue-400 hover:to-blue-500 transition-all shadow-lg shadow-blue-500/25 flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : null}
                  Send reset link
                </button>
              </form>
            ) : (
              <button
                onClick={() => { setForgotSent(false); setAuthError(null); setView('login'); }}
                className="w-full py-3 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-white text-sm font-medium transition-all"
              >
                Back to sign in
              </button>
            )}

            <div className="mt-6 text-center">
              <span className="text-xs text-gray-600">Remembered it? </span>
              <button
                onClick={() => { setAuthError(null); setForgotSent(false); setView('login'); }}
                className="text-xs text-blue-400 hover:text-blue-300 font-medium transition-colors"
              >
                Sign in
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  SIGNUP
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (view === 'signup') {
    return (
      <div className="fixed inset-0 bg-[#050507] flex items-center justify-center p-6">
        <AnimatedBackground />
        <NoiseOverlay />
        <div className="relative z-10 w-full max-w-md">
          <div className="relative rounded-3xl border border-white/[0.08] bg-gradient-to-b from-white/[0.06] to-white/[0.02] backdrop-blur-xl shadow-2xl shadow-black/40 p-8 pt-6">
            {/* Close button */}
            <button onClick={() => setView('landing')} className="absolute top-4 right-4 w-8 h-8 rounded-full bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] flex items-center justify-center text-gray-500 hover:text-white transition-all">
              <X size={16} />
            </button>

            <Logo size="md" />
            <h2 className="text-xl font-bold text-white mt-6 mb-1">Create your account</h2>
            <p className="text-sm text-gray-500 mb-6">Start with 5 free interview sessions</p>

            <form onSubmit={handleSignup} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5">Name</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name"
                  className="w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white placeholder-gray-600 text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all" autoFocus />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5">Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
                  className="w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white placeholder-gray-600 text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all" required />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5">Password</label>
                <div className="relative">
                  <input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Create a password (min 8 chars)"
                    className="w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white placeholder-gray-600 text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all pr-10" required minLength={8} />
                  <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors">
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              {authError && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
                  <AlertTriangle size={12} /> {authError}
                </div>
              )}
              <button type="submit" disabled={isSubmitting}
                className="w-full py-3 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold text-sm hover:from-blue-400 hover:to-blue-500 transition-all shadow-lg shadow-blue-500/25 flex items-center justify-center gap-2 disabled:opacity-50">
                {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : null} Create Account
              </button>
              <p className="text-[10px] text-gray-600 text-center leading-relaxed">
                By creating an account, you agree to our Terms of Service and Privacy Policy
              </p>
            </form>

            {/* Google Sign-Up */}
            {GOOGLE_CLIENT_ID && (
              <>
                <div className="mt-6 flex items-center gap-3">
                  <div className="flex-1 h-px bg-white/[0.08]" />
                  <span className="text-[10px] text-gray-600 uppercase tracking-wider">or</span>
                  <div className="flex-1 h-px bg-white/[0.08]" />
                </div>
                {isElectron ? (
                  <button
                    onClick={handleGoogleElectron}
                    disabled={isSubmitting}
                    className="mt-4 w-full py-3 px-4 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.1] text-white text-sm font-medium transition-all flex items-center justify-center gap-3 disabled:opacity-50"
                  >
                    {isSubmitting ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                    )}
                    {isSubmitting ? 'Waiting for sign-up...' : 'Continue with Google'}
                  </button>
                ) : (
                  <div className="mt-4 flex justify-center [&_iframe]:rounded-xl">
                    <GoogleLogin
                      onSuccess={handleGoogleSuccess}
                      onError={handleGoogleError}
                      theme="filled_black"
                      size="large"
                      width="350"
                      text="signup_with"
                      shape="pill"
                    />
                  </div>
                )}
              </>
            )}

            <div className="mt-6 text-center">
              <span className="text-xs text-gray-600">Already have an account? </span>
              <button onClick={() => setView('login')} className="text-xs text-blue-400 hover:text-blue-300 font-medium transition-colors">Sign in</button>
            </div>
            {geo && (
              <div className="mt-6 flex items-center justify-center gap-2 text-[10px] text-gray-600">
                <Globe size={10} /> {geo.country_name} &middot; {pricing?.currencySymbol} {pricing?.currency}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  LIVE SUPPORT CHAT
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (view === 'support') {
    // If not logged in, redirect to login
    if (!currentUser) {
      setView('login');
      setAuthError('Please sign in to access support');
      return null;
    }

    const sendChatMessage = () => {
      const text = chatInput.trim();
      if (!text) return;
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      setChatMessages(prev => [...prev, { from: 'user', text, time }]);
      setChatInput('');

      // Send via WebSocket if connected
      if (chatWsRef.current?.readyState === WebSocket.OPEN) {
        chatWsRef.current.send(JSON.stringify({ type: 'message', text, user: currentUser.email }));
      }

      // Auto-scroll
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    };

    // Initialize chat with welcome message if empty
    if (chatMessages.length === 0) {
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      setChatMessages([{
        from: 'agent',
        text: `Hi ${currentUser.name || 'there'}! I'm Hari, your support agent. How can I help you today?`,
        time
      }]);

      // Connect WebSocket for live chat
      const serverUrl = import.meta.env.VITE_SERVER_URL || 'https://h2so4-production.up.railway.app';
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
              setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
            }
          } catch {}
        };
        ws.onerror = () => {};
        ws.onclose = () => {};
        chatWsRef.current = ws;
      } catch {}
    }

    return (
      <div className="fixed inset-0 bg-[#050507] flex items-center justify-center p-6">
        <AnimatedBackground />
        <NoiseOverlay />
        <div className="relative z-10 w-full max-w-lg h-[600px] max-h-[85vh] flex flex-col">
          <div className="rounded-3xl border border-white/[0.08] bg-gradient-to-b from-white/[0.06] to-white/[0.02] backdrop-blur-xl shadow-2xl shadow-black/40 flex flex-col h-full overflow-hidden">
            {/* Chat header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.08]">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-green-400 to-emerald-600 flex items-center justify-center shadow-lg shadow-green-500/20">
                  <Headphones size={18} className="text-white" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">Hari</h3>
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                    <span className="text-[10px] text-green-400 font-medium">Live Support Agent</span>
                  </div>
                </div>
              </div>
              <button onClick={() => { setView('landing'); if (chatWsRef.current) { chatWsRef.current.close(); chatWsRef.current = null; } setChatMessages([]); }}
                className="w-8 h-8 rounded-full bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] flex items-center justify-center text-gray-500 hover:text-white transition-all">
                <X size={16} />
              </button>
            </div>

            {/* Chat messages */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {chatMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.from === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                    msg.from === 'user'
                      ? 'bg-gradient-to-r from-blue-500 to-blue-600 text-white rounded-br-md'
                      : 'bg-white/[0.06] border border-white/[0.08] text-gray-200 rounded-bl-md'
                  }`}>
                    <p>{msg.text}</p>
                    <p className={`text-[9px] mt-1 ${msg.from === 'user' ? 'text-blue-200' : 'text-gray-600'}`}>{msg.time}</p>
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            {/* Chat input */}
            <div className="px-4 py-3 border-t border-white/[0.08]">
              <form onSubmit={(e) => { e.preventDefault(); sendChatMessage(); }} className="flex items-center gap-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Type your message..."
                  className="flex-1 px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white placeholder-gray-600 text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all"
                  autoFocus
                />
                <button type="submit"
                  className="w-11 h-11 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 text-white flex items-center justify-center hover:from-blue-400 hover:to-blue-500 transition-all shadow-lg shadow-blue-500/25 flex-shrink-0">
                  <Send size={16} />
                </button>
              </form>
              <p className="text-[10px] text-gray-600 text-center mt-2">Live chat with our support team</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  PRICING PAGE (Free + Pro only)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (view === 'pricing') {
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

          {/* Comparison table */}
          <div className="mt-16 max-w-2xl mx-auto">
            <h3 className="text-lg font-bold text-center mb-8">Feature comparison</h3>
            <div className="border border-white/[0.06] rounded-xl overflow-hidden">
              {[
                { feature: 'Interview sessions', free: '5/month', pro: 'Unlimited' },
                { feature: 'AI Models', free: 'Gemini only', pro: 'All 4 models' },
                { feature: 'Screen capture', free: '—', pro: 'Yes' },
                { feature: 'Auto-solve', free: '—', pro: 'Yes' },
                { feature: 'Pop-out overlay', free: '—', pro: 'Yes' },
                { feature: 'Context files', free: '1 file', pro: 'Unlimited' },
                { feature: 'Session history', free: '—', pro: 'Yes' },
                { feature: 'Support', free: 'Community', pro: 'Priority' },
                { feature: 'Device binding', free: '1 device', pro: '2 devices' },
              ].map(({ feature, free, pro }, i) => (
                <div key={i} className={`grid grid-cols-3 text-sm ${i > 0 ? 'border-t border-white/[0.04]' : ''}`}>
                  <div className="px-4 py-3 text-gray-400 font-medium">{feature}</div>
                  <div className="px-4 py-3 text-gray-500 text-center">{free}</div>
                  <div className="px-4 py-3 text-blue-400 text-center font-medium">{pro}</div>
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

// Wrap with Google OAuth Provider
export const SubscriptionGate: React.FC<SubscriptionGateProps> = (props) => {
  if (GOOGLE_CLIENT_ID) {
    return (
      <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
        <SubscriptionGateInner {...props} />
      </GoogleOAuthProvider>
    );
  }
  return <SubscriptionGateInner {...props} />;
};
