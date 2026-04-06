import React, { useState, useEffect, useRef } from 'react';
import { Shield, Zap, Crown, Check, X, ArrowRight, Globe, Lock, Sparkles, ChevronRight, Eye, EyeOff, AlertTriangle, Loader2, Star, Users, Cpu, Headphones, Bot, BarChart3, Monitor, Download, Play, BookOpen, ChevronDown, LogOut } from 'lucide-react';
import { GoogleOAuthProvider, GoogleLogin } from '@react-oauth/google';
import { geoService, GeoData } from './services/geoService';
import { pricingService, RegionPricing, PricingTier } from './services/pricingService';
import { licenseService, UserProfile, LicenseData } from './services/licenseService';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SUBSCRIPTION GATE — Landing → Auth → Download funnel
//  Website is NOT the app. Users MUST download Electron app.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface SubscriptionGateProps {
  onAuthenticated: (user: UserProfile, license: LicenseData) => void;
}

type View = 'landing' | 'login' | 'signup' | 'pricing' | 'vpn_blocked' | 'download' | 'tutorials' | 'admin';

// ── Detect if running inside Electron ──
const isElectron = typeof window !== 'undefined' && !!(window as any).process?.versions?.electron;

// ── Animated background ──
const AnimatedBackground = () => (
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
);

const NoiseOverlay = () => (
  <div className="fixed inset-0 pointer-events-none opacity-[0.015]" style={{ zIndex: 1, backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")` }} />
);

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

// ── Pricing Card (Free + Pro only) ──
const PricingCard = ({ tier, onSelect, isLoading }: { tier: PricingTier; onSelect: (tier: PricingTier) => void; isLoading: boolean }) => {
  const isPro = tier.popular;
  const isFree = tier.id === 'free';

  return (
    <div className={`relative rounded-2xl border transition-all duration-300 hover:scale-[1.02] ${
      isPro
        ? 'border-blue-500/40 bg-gradient-to-b from-blue-500/[0.08] to-transparent shadow-xl shadow-blue-500/10'
        : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.15]'
    }`}>
      {isPro && (
        <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
          <div className="px-4 py-1 rounded-full bg-gradient-to-r from-blue-500 to-purple-500 text-white text-[10px] font-bold tracking-wider uppercase shadow-lg">
            Recommended
          </div>
        </div>
      )}

      <div className="p-6 pt-8">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-4 ${
          isFree ? 'bg-gray-500/10' : 'bg-blue-500/15'
        }`}>
          {isFree ? <Zap size={20} className="text-gray-400" /> : <Crown size={20} className="text-blue-400" />}
        </div>

        <h3 className="text-lg font-bold text-white mb-1">{tier.name}</h3>

        <div className="flex items-baseline gap-1 mb-6">
          {tier.price === 0 ? (
            <span className="text-3xl font-bold text-white">Free</span>
          ) : (
            <>
              <span className="text-3xl font-bold text-white">
                {pricingService.formatPrice(tier.price, tier.currencySymbol, tier.currency)}
              </span>
              <span className="text-sm text-gray-500">/{tier.period}</span>
            </>
          )}
        </div>

        <button
          onClick={() => onSelect(tier)}
          disabled={isLoading}
          className={`w-full py-3 px-4 rounded-xl font-semibold text-sm transition-all duration-200 flex items-center justify-center gap-2 ${
            isPro
              ? 'bg-gradient-to-r from-blue-500 to-blue-600 text-white hover:from-blue-400 hover:to-blue-500 shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40'
              : 'bg-white/[0.06] text-white hover:bg-white/[0.1] border border-white/[0.1]'
          }`}
        >
          {isLoading ? <Loader2 size={16} className="animate-spin" /> : null}
          {tier.cta}
          {!isLoading && <ArrowRight size={14} />}
        </button>

        <div className="mt-6 space-y-3">
          {tier.features.map((feature, i) => (
            <div key={i} className="flex items-start gap-2.5">
              <div className={`w-4 h-4 rounded-full flex items-center justify-center mt-0.5 shrink-0 ${
                isPro ? 'bg-blue-500/20' : 'bg-white/[0.06]'
              }`}>
                <Check size={10} className={isPro ? 'text-blue-400' : 'text-gray-400'} strokeWidth={3} />
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

const AdminDashboard = ({ onBack, currentUser }: { onBack: () => void; currentUser: UserProfile }) => {
  const [stats, setStats] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [logins, setLogins] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [adminTab, setAdminTab] = useState<'overview' | 'users' | 'logins'>('overview');

  // Action form state
  const [revokeKey, setRevokeKey] = useState('');
  const [killVersion, setKillVersion] = useState('');
  const [searchEmail, setSearchEmail] = useState('');
  const [searchResult, setSearchResult] = useState<any>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const token = licenseService.getToken();
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

  const showMsg = (msg: string) => { setActionMsg(msg); setTimeout(() => setActionMsg(null), 4000); };

  // Fetch all data on mount
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

  // ── Actions ──
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
    } catch (err: any) { showMsg(`Error: ${err.message}`); }
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
    } catch (err: any) { showMsg(`Error: ${err.message}`); }
    finally { setActionLoading(false); }
  };

  const handleSearch = async () => {
    if (!searchEmail.trim()) return;
    setActionLoading(true);
    setSearchResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/users/search?email=${encodeURIComponent(searchEmail.trim())}`, { headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSearchResult(data);
    } catch (err: any) { showMsg(`Error: ${err.message}`); setSearchResult(null); }
    finally { setActionLoading(false); }
  };

  const handleBan = async (email: string) => {
    if (!confirm(`Ban ${email}? This will revoke their license.`)) return;
    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/users/ban`, {
        method: 'POST', headers, body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showMsg(`${email} banned`);
      setUsers(prev => prev.map(u => u.email === email ? { ...u, is_banned: 1, tier: 'free' } : u));
    } catch (err: any) { showMsg(`Error: ${err.message}`); }
  };

  const handleUpgrade = async (email: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/users/upgrade`, {
        method: 'POST', headers, body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showMsg(`${email} upgraded to Pro`);
      setUsers(prev => prev.map(u => u.email === email ? { ...u, tier: 'pro' } : u));
    } catch (err: any) { showMsg(`Error: ${err.message}`); }
  };

  const fmtDate = (ts: number) => ts ? new Date(ts).toLocaleString() : '—';

  return (
    <div className="fixed inset-0 bg-[#050507] text-white overflow-y-auto">
      <AnimatedBackground />
      <NoiseOverlay />
      <nav className="relative z-10 flex items-center justify-between px-6 py-4 max-w-7xl mx-auto">
        <Logo size="md" />
        <div className="flex items-center gap-3">
          <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-red-500/20 text-red-400">Admin</span>
          {/* Tab switcher */}
          {['overview', 'users', 'logins'].map(tab => (
            <button key={tab} onClick={() => setAdminTab(tab as any)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${adminTab === tab ? 'bg-white/[0.1] text-white border border-white/[0.15]' : 'text-gray-500 hover:text-gray-300'}`}>
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
          <button onClick={onBack} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-400 hover:text-white transition-colors flex items-center gap-1.5">
            <ArrowRight size={14} className="rotate-180" /> Back
          </button>
        </div>
      </nav>

      <div className="relative z-10 max-w-7xl mx-auto px-6 pt-6 pb-20">
        {/* Action message toast */}
        {actionMsg && (
          <div className="fixed top-4 right-4 z-50 px-4 py-3 rounded-xl bg-blue-500/20 border border-blue-500/30 text-blue-300 text-sm font-medium shadow-xl backdrop-blur-sm animate-pulse">
            {actionMsg}
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
                <div>
                  <h1 className="text-2xl font-bold mb-1">Dashboard</h1>
                  <p className="text-gray-500 text-sm">Live data from minicaai.com server</p>
                </div>

                {/* Stats grid */}
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  {[
                    { label: 'Total Users', value: stats?.total_users ?? 0, color: 'text-white' },
                    { label: 'Pro Users', value: stats?.pro_users ?? 0, color: 'text-blue-400' },
                    { label: 'Free Users', value: stats?.free_users ?? 0, color: 'text-gray-400' },
                    { label: 'Active Today', value: stats?.active_today ?? 0, color: 'text-green-400' },
                    { label: 'Signups (30d)', value: stats?.signups_this_month ?? 0, color: 'text-purple-400' },
                    { label: 'Logins Today', value: stats?.logins_today ?? 0, color: 'text-cyan-400' },
                    { label: 'Failed Logins', value: stats?.failed_logins_today ?? 0, color: 'text-red-400' },
                    { label: 'Devices', value: stats?.total_devices ?? 0, color: 'text-amber-400' },
                    { label: 'Banned', value: stats?.banned_users ?? 0, color: 'text-red-400' },
                    { label: 'Revoked Keys', value: stats?.revoked_licenses ?? 0, color: 'text-orange-400' },
                  ].map(({ label, value, color }, i) => (
                    <div key={i} className="p-3 rounded-xl border border-white/[0.06] bg-white/[0.02]">
                      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{label}</p>
                      <p className={`text-xl font-bold ${color}`}>{value}</p>
                    </div>
                  ))}
                </div>

                {/* Quick Actions */}
                <div className="grid md:grid-cols-3 gap-4">
                  {/* Revoke License */}
                  <div className="p-5 rounded-xl border border-white/[0.06] bg-white/[0.02]">
                    <h4 className="text-sm font-semibold text-white mb-2">Revoke License</h4>
                    <p className="text-xs text-gray-500 mb-3">Invalidate a license key</p>
                    <div className="flex gap-2">
                      <input value={revokeKey} onChange={e => setRevokeKey(e.target.value)} placeholder="MNC-..." className="flex-1 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none focus:border-red-500/50" />
                      <button onClick={handleRevoke} disabled={actionLoading} className="px-4 py-2 rounded-lg bg-red-500/20 text-red-400 text-xs font-semibold hover:bg-red-500/30 transition-all border border-red-500/20 disabled:opacity-50">
                        Revoke
                      </button>
                    </div>
                  </div>

                  {/* Kill Version */}
                  <div className="p-5 rounded-xl border border-white/[0.06] bg-white/[0.02]">
                    <h4 className="text-sm font-semibold text-white mb-2">Kill App Version</h4>
                    <p className="text-xs text-gray-500 mb-3">Force-expire old app versions</p>
                    <div className="flex gap-2">
                      <input value={killVersion} onChange={e => setKillVersion(e.target.value)} placeholder="e.g. 2.1.0" className="flex-1 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none focus:border-amber-500/50" />
                      <button onClick={handleKillVersion} disabled={actionLoading} className="px-4 py-2 rounded-lg bg-amber-500/20 text-amber-400 text-xs font-semibold hover:bg-amber-500/30 transition-all border border-amber-500/20 disabled:opacity-50">
                        Set
                      </button>
                    </div>
                  </div>

                  {/* User Search */}
                  <div className="p-5 rounded-xl border border-white/[0.06] bg-white/[0.02]">
                    <h4 className="text-sm font-semibold text-white mb-2">User Lookup</h4>
                    <p className="text-xs text-gray-500 mb-3">Search by email</p>
                    <div className="flex gap-2">
                      <input value={searchEmail} onChange={e => setSearchEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()} placeholder="user@email.com" className="flex-1 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-xs focus:outline-none focus:border-blue-500/50" />
                      <button onClick={handleSearch} disabled={actionLoading} className="px-4 py-2 rounded-lg bg-blue-500/20 text-blue-400 text-xs font-semibold hover:bg-blue-500/30 transition-all border border-blue-500/20 disabled:opacity-50">
                        Search
                      </button>
                    </div>
                  </div>
                </div>

                {/* Search Result */}
                {searchResult && (
                  <div className="p-5 rounded-xl border border-blue-500/20 bg-blue-500/[0.04]">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-sm font-bold text-white">User Found</h4>
                      <button onClick={() => setSearchResult(null)} className="text-gray-500 hover:text-white"><X size={14} /></button>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                      <div><span className="text-gray-500">Email:</span> <span className="text-white font-medium">{searchResult.user.email}</span></div>
                      <div><span className="text-gray-500">Name:</span> <span className="text-white">{searchResult.user.name}</span></div>
                      <div><span className="text-gray-500">Tier:</span> <span className={searchResult.user.tier === 'pro' ? 'text-blue-400 font-bold' : 'text-gray-400'}>{searchResult.user.tier.toUpperCase()}</span></div>
                      <div><span className="text-gray-500">Country:</span> <span className="text-white">{searchResult.user.country_code}</span></div>
                      <div><span className="text-gray-500">Created:</span> <span className="text-white">{fmtDate(searchResult.user.created_at)}</span></div>
                      <div><span className="text-gray-500">Last Login:</span> <span className="text-white">{fmtDate(searchResult.user.last_login_at)}</span></div>
                      <div><span className="text-gray-500">License:</span> <span className="text-white font-mono text-[10px]">{searchResult.license?.key || '—'}</span></div>
                      <div><span className="text-gray-500">Devices:</span> <span className="text-white">{searchResult.devices?.length || 0}</span></div>
                      <div><span className="text-gray-500">Sessions:</span> <span className="text-white">{searchResult.license?.sessions_used ?? 0}/{searchResult.license?.sessions_limit === -1 ? '∞' : searchResult.license?.sessions_limit}</span></div>
                      <div><span className="text-gray-500">Status:</span> <span className={`font-medium ${searchResult.license?.status === 'active' ? 'text-green-400' : searchResult.license?.status === 'revoked' ? 'text-red-400' : 'text-amber-400'}`}>{searchResult.license?.status || '—'}</span></div>
                      <div><span className="text-gray-500">Banned:</span> <span className={searchResult.user.is_banned ? 'text-red-400 font-bold' : 'text-green-400'}>{searchResult.user.is_banned ? 'YES' : 'No'}</span></div>
                    </div>
                    <div className="flex gap-2 mt-4">
                      {!searchResult.user.is_banned && (
                        <button onClick={() => handleBan(searchResult.user.email)} className="px-3 py-1.5 rounded-lg bg-red-500/20 text-red-400 text-xs font-semibold hover:bg-red-500/30 border border-red-500/20">Ban User</button>
                      )}
                      {searchResult.user.tier !== 'pro' && (
                        <button onClick={() => handleUpgrade(searchResult.user.email)} className="px-3 py-1.5 rounded-lg bg-blue-500/20 text-blue-400 text-xs font-semibold hover:bg-blue-500/30 border border-blue-500/20">Upgrade to Pro</button>
                      )}
                    </div>
                  </div>
                )}

                {/* Server status */}
                <div className="p-4 rounded-xl border border-white/[0.06] bg-white/[0.02]">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                      <span className="text-xs text-gray-400">Server Online</span>
                    </div>
                    <span className="text-[10px] text-gray-600">minicaai.com &middot; v{licenseService.getAppVersion()}</span>
                  </div>
                </div>
              </div>
            )}

            {/* ── USERS TAB ── */}
            {adminTab === 'users' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-2xl font-bold mb-1">All Users</h1>
                    <p className="text-gray-500 text-sm">{users.length} registered users</p>
                  </div>
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
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">License</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Sessions</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Devices</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Created</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Status</th>
                          <th className="text-left px-4 py-3 text-gray-500 font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {users.map((u: any, i: number) => (
                          <tr key={u.id || i} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                            <td className="px-4 py-3 text-white font-medium">{u.email}</td>
                            <td className="px-4 py-3 text-gray-400">{u.name || '—'}</td>
                            <td className="px-4 py-3">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${u.tier === 'pro' ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-500/20 text-gray-400'}`}>
                                {u.tier}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-gray-400">{u.country_code || '—'}</td>
                            <td className="px-4 py-3 font-mono text-[10px] text-gray-500">{u.license?.key?.slice(0, 12) || '—'}...</td>
                            <td className="px-4 py-3 text-gray-400">{u.license?.sessions_used ?? 0}/{u.license?.sessions_limit === -1 ? '∞' : u.license?.sessions_limit ?? 5}</td>
                            <td className="px-4 py-3 text-gray-400">{u.device_count ?? 0}</td>
                            <td className="px-4 py-3 text-gray-500">{fmtDate(u.created_at)}</td>
                            <td className="px-4 py-3">
                              {u.is_banned ? (
                                <span className="text-red-400 font-bold text-[10px]">BANNED</span>
                              ) : (
                                <span className={`text-[10px] font-medium ${u.license?.status === 'active' ? 'text-green-400' : u.license?.status === 'trial' ? 'text-amber-400' : 'text-gray-500'}`}>
                                  {u.license?.status?.toUpperCase() || 'NONE'}
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex gap-1">
                                {!u.is_banned && (
                                  <button onClick={() => handleBan(u.email)} className="px-2 py-1 rounded text-[10px] bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all" title="Ban">Ban</button>
                                )}
                                {u.tier !== 'pro' && !u.is_banned && (
                                  <button onClick={() => handleUpgrade(u.email)} className="px-2 py-1 rounded text-[10px] bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-all" title="Upgrade">Pro</button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {users.length === 0 && (
                    <div className="text-center py-12 text-gray-600 text-sm">No users yet</div>
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
                            <td className="px-4 py-3 text-gray-500 font-mono text-[10px] max-w-[120px] truncate">{log.device_id?.slice(0, 10) || '—'}</td>
                            <td className="px-4 py-3">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${log.success ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
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
          </>
        )}
      </div>
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

  // Authenticated user (for download/dashboard views)
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [currentLicense, setCurrentLicense] = useState<LicenseData | null>(null);

  // Payment state
  const [selectedProUpgrade, setSelectedProUpgrade] = useState(false);
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);

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
            } else if (saved.license.tier === 'pro') {
              // Pro users must validate — lock them out
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

      // Check for Stripe success redirect
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('payment') === 'success') {
        const saved = licenseService.loadAuth();
        if (saved.user) {
          // Revalidate with server to get updated tier
          const validated = await licenseService.validateWithServer();
          if (validated) {
            setCurrentUser(saved.user);
            setCurrentLicense(validated);
            licenseService.saveAuth({ ...saved.user, tier: validated.tier as any }, validated);
          } else {
            setCurrentUser(saved.user);
            setCurrentLicense(saved.license!);
          }
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
      // Try server first, fall back to local
      let user: UserProfile, license: LicenseData;
      try {
        const result = await licenseService.signup(email.trim(), password, name.trim(), geo?.country_code || 'US');
        user = result.user;
        license = result.license;
      } catch {
        const result = await licenseService.localSignup(email.trim(), password, name.trim(), geo?.country_code || 'US');
        user = result.user;
        license = result.license;
      }

      setCurrentUser(user);
      setCurrentLicense(license);

      if (isElectron) {
        // In Electron, go straight to app
        onAuthenticated(user, license);
      } else if (selectedProUpgrade) {
        // User selected Pro plan — go to checkout
        setSelectedProUpgrade(false);
        // Small delay to let state settle, then initiate checkout
        setTimeout(() => initiateCheckout(), 300);
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
      let user: UserProfile, license: LicenseData;
      try {
        const result = await licenseService.login(email.trim(), password);
        user = result.user;
        license = result.license;
      } catch {
        // Fallback: check local
        const saved = licenseService.loadAuth();
        if (saved.user && saved.user.email === email.trim()) {
          user = saved.user;
          license = saved.license!;
        } else {
          throw new Error('Invalid credentials. Please check your email and password.');
        }
      }

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

  // ── Tier selection ──
  const handleTierSelect = (tier: PricingTier) => {
    if (tier.id === 'free') {
      setSelectedProUpgrade(false);
      setView('signup');
    } else {
      // Pro — if already logged in, go straight to checkout
      if (currentUser) {
        initiateCheckout();
      } else {
        setSelectedProUpgrade(true);
        setView('signup');
      }
    }
  };

  // ── Initiate payment checkout (Stripe or Razorpay based on geo) ──
  const initiateCheckout = async () => {
    setPaymentLoading(true);
    setPaymentError(null);

    try {
      // Retry token fetch — it may not be in localStorage yet after signup
      let token = licenseService.getToken();
      if (!token) {
        await new Promise(r => setTimeout(r, 500));
        token = licenseService.getToken();
      }
      if (!token) throw new Error('Please sign in first to upgrade to Pro');

      const countryCode = geo?.country_code || 'US';
      const response = await fetch('https://h2so4-production.up.railway.app/api/v1/payments/create-checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ country_code: countryCode }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to create checkout');
      }

      const data = await response.json();

      if (data.provider === 'stripe') {
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

  // ── Razorpay inline checkout ──
  const openRazorpayCheckout = async (checkoutData: any) => {
    return new Promise<void>((resolve, reject) => {
      // Load Razorpay script if not already loaded
      const loadScript = (): Promise<void> => {
        if ((window as any).Razorpay) return Promise.resolve();
        return new Promise((res, rej) => {
          const script = document.createElement('script');
          script.src = 'https://checkout.razorpay.com/v1/checkout.js';
          script.onload = () => res();
          script.onerror = () => rej(new Error('Failed to load Razorpay SDK'));
          document.body.appendChild(script);
        });
      };

      loadScript().then(() => {
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

              // Update local state
              if (currentUser) {
                const updatedUser = { ...currentUser, tier: 'pro' as const };
                setCurrentUser(updatedUser);
                if (verifyData.license) {
                  setCurrentLicense(verifyData.license);
                }
                licenseService.saveAuth(updatedUser, verifyData.license || currentLicense!);
              }

              setPaymentError(null);
              alert('Payment successful! Your account has been upgraded to Pro.');
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
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${currentLicense?.tier === 'pro' ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-500/20 text-gray-400'}`}>
                  {currentLicense?.tier || 'free'}
                </span>
                {licenseService.isDeveloper(currentUser.email) && (
                  <button onClick={() => setView('admin')} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-all">
                    Admin
                  </button>
                )}
                <button onClick={handleLogout} className="p-2 text-gray-500 hover:text-red-400 transition-colors" title="Logout">
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

          <div className="flex items-center justify-center gap-4">
            <button onClick={() => setView('tutorials')} className="px-6 py-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-sm font-medium transition-all flex items-center gap-2">
              <BookOpen size={14} /> View Tutorials
            </button>
            {currentLicense?.tier !== 'pro' ? (
              <button
                onClick={initiateCheckout}
                disabled={paymentLoading}
                className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-400 hover:to-purple-400 text-white text-sm font-semibold transition-all shadow-lg shadow-blue-500/20 flex items-center gap-2 disabled:opacity-50"
              >
                {paymentLoading ? <Loader2 size={14} className="animate-spin" /> : <Crown size={14} />}
                Upgrade to Pro
              </button>
            ) : (
              <div className="px-6 py-2.5 rounded-xl bg-green-500/10 border border-green-500/20 text-green-400 text-sm font-semibold flex items-center gap-2">
                <Check size={14} /> Pro Active
              </div>
            )}
          </div>
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
            <div className="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto">
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
              <span>Privacy</span><span>Terms</span><span>Support</span>
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
        <div className="relative z-10 w-full max-w-sm">
          <button onClick={() => setView('landing')} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-300 transition-colors mb-8">
            <ArrowRight size={14} className="rotate-180" /> Back
          </button>
          <Logo size="lg" />
          <h2 className="text-xl font-bold text-white mt-8 mb-2">Welcome back</h2>
          <p className="text-sm text-gray-500 mb-8">Sign in to your minicaai account</p>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
                className="w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white placeholder-gray-600 text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all" required autoFocus />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Password</label>
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
            </>
          )}

          <div className="mt-6 text-center">
            <span className="text-xs text-gray-600">Don't have an account? </span>
            <button onClick={() => setView('signup')} className="text-xs text-blue-400 hover:text-blue-300 font-medium transition-colors">Create one</button>
          </div>
          {geo && (
            <div className="mt-8 flex items-center justify-center gap-2 text-[10px] text-gray-600">
              <Lock size={10} /> Secure connection from {geo.country_name}
            </div>
          )}
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
        <div className="relative z-10 w-full max-w-sm">
          <button onClick={() => setView('landing')} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-300 transition-colors mb-8">
            <ArrowRight size={14} className="rotate-180" /> Back
          </button>
          <Logo size="lg" />
          <h2 className="text-xl font-bold text-white mt-8 mb-2">Create your account</h2>
          <p className="text-sm text-gray-500 mb-8">Start with 5 free interview sessions</p>

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
            </>
          )}

          <div className="mt-6 text-center">
            <span className="text-xs text-gray-600">Already have an account? </span>
            <button onClick={() => setView('login')} className="text-xs text-blue-400 hover:text-blue-300 font-medium transition-colors">Sign in</button>
          </div>
          {geo && (
            <div className="mt-8 flex items-center justify-center gap-2 text-[10px] text-gray-600">
              <Globe size={10} /> {geo.country_name} &middot; {pricing?.currencySymbol} {pricing?.currency}
            </div>
          )}
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
            <div className="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto">
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
                { q: 'What if I change devices?', a: 'Contact support to transfer your license. Each Pro account supports up to 2 devices.' },
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
