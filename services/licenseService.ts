// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LICENSE SERVICE — Server-validated, device-bound licensing
//
//  SECURITY MODEL:
//  - App is LOCKED until server confirms a valid license
//  - Device fingerprint is bound to the license at activation
//  - Periodic revalidation every 30 minutes
//  - No offline grace period for Pro — forces server check
//
//  TIERS:
//  - Free: 5 sessions, Gemini only, no stealth. NEW: 30-minute
//    full-experience trial on first signup (acts as Basic-level features
//    for that window) — time-gated by trial_remaining_seconds.
//  - Basic: $25 for 3 credits (3 hours of live-session time),
//    14-day expiry, four models (Gemini, GPT, Grok, Llama — NO Claude),
//    stealth, Auto-Solve. No Auto-Type. Renewal $6.99/credit.
//    Time-gated by credits_remaining_seconds.
//  - Pro: unlimited time, four models (same set as Basic — NO Claude),
//    all features except Auto-Type and Claude.
//  - Max: Pro + Claude Sonnet 4.6 + Auto-Type + Train Model — the only
//    tier with all five models.
//
//  CREDITS vs TIME:
//  Credits are a display abstraction — internally we track seconds.
//  3600s = "1 credit". 5400s = "1 credit + 30 min".
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface LicenseData {
  key: string;
  email: string;
  tier: 'free' | 'basic' | 'pro' | 'max';
  // Status values mirror what the server's webhook handlers + license
  // routes write into the licenses table. Keep this union exhaustive — a
  // missing value here would render as 'Unknown' in the billing UI's
  // STATUS_LABEL fallback.
  //   active    — paying customer, sub will renew
  //   canceling — cancel-at-period-end set; still has access until expires_at
  //   trial     — Free user inside the 30-min trial window
  //   expired   — sub ended (cycle close, unpaid, or natural completion)
  //   revoked   — admin revoked or hard ban
  //   paused    — Stripe collection paused (rare; soft revoke)
  //   refunded  — full refund issued; access revoked
  //   disputed  — chargeback opened; access revoked pending dispute outcome
  status: 'active' | 'canceling' | 'trial' | 'expired' | 'revoked' | 'paused' | 'refunded' | 'disputed';
  country_code: string;
  device_id: string;
  activated_at: number;
  expires_at: number;
  sessions_used: number;
  sessions_limit: number; // -1 for unlimited
  last_validated: number;
  // ── Credit tracking (Basic tier + Free trial) ──
  // Authoritative time balance in seconds. Pro/Max ignore these fields.
  credits_remaining_seconds?: number;  // Paid balance (Basic tier)
  credits_expire_at?: number;          // Unix ms — credits void after this
  trial_remaining_seconds?: number;    // One-time 30-min trial for Free users
  // Server-stamped at license creation. Used to compute trial remaining
  // wall-clock seconds without trusting the client. Without this, a Free
  // user could log out + back in to re-seed a fresh trial on every login.
  trial_granted_at?: number;
}

export interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: UserProfile | null;
  license: LicenseData | null;
  error: string | null;
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  avatar_url?: string;
  tier: 'free' | 'basic' | 'pro' | 'max';
  country_code: string;
  created_at: number;
  is_admin?: boolean;
  oauth_provider?: string;
}

// Feature gates — what each tier can access.
// Basic = Pro features minus Auto-Type, gated by credit time balance.
// Max = Pro + Auto-Type.
export const FEATURE_GATES = {
  free: {
    models: ['gemini'] as string[],
    screenCapture: false,
    autoSolve: false,
    autoType: false,
    popout: false,
    contextFiles: 1,     // max files
    sessionsPerMonth: 5,
    exportHistory: false,
    // GPT reasoning_effort is Max-only. Lower tiers are forced to 'none'
    // both client-side (UI bar locked) and server-side (JWT tier check
    // in /chat/openai overrides anything they send).
    reasoningEffortControl: false,
  },
  basic: {
    // Claude is Max-only — its hosted web_search + the per-session "Train
    // Model" pipeline are positioned as the premium differentiator.
    models: ['gemini', 'groq', 'openai', 'xai'] as string[],
    screenCapture: true,
    autoSolve: true,
    autoType: false,     // Auto-Type is Max-exclusive
    popout: true,
    contextFiles: -1,    // unlimited
    sessionsPerMonth: -1, // session count isn't the gate — credit time is
    exportHistory: true,
    reasoningEffortControl: false,
  },
  pro: {
    // Claude is Max-only — see comment in `basic`.
    models: ['gemini', 'groq', 'openai', 'xai'] as string[],
    screenCapture: true,
    autoSolve: true,
    autoType: false,     // Auto-Type is Max-exclusive
    popout: true,
    contextFiles: -1,    // unlimited
    sessionsPerMonth: -1, // unlimited
    exportHistory: true,
    reasoningEffortControl: false,
  },
  max: {
    models: ['gemini', 'groq', 'openai', 'xai', 'claude'] as string[],
    screenCapture: true,
    autoSolve: true,
    autoType: true,      // Max tier unlocks Auto-Type
    popout: true,
    contextFiles: -1,    // unlimited
    sessionsPerMonth: -1, // unlimited
    exportHistory: true,
    // Max users get the full reasoning bar (none/low/medium/high). Pairs
    // with Train Model: a trained Max user on 'none' answers in 1-3s
    // because the cached tech-state card already supplies depth that
    // reasoning would otherwise compute live.
    reasoningEffortControl: true,
  },
} as const;

const APP_VERSION = __APP_VERSION__;
const MIN_VERSION = '2.0.0';
const REVALIDATION_INTERVAL = 30 * 60 * 1000; // 30 minutes

// ── Time constants ──
// Display-facing prices live in services/pricingService.ts (single source
// of truth for regional/currency pricing). This file owns only the
// client-side credit-math knobs.
export const TIME_CONSTANTS = {
  SECONDS_PER_CREDIT: 3600,         // 1 credit = 1 hour of session time
  TRIAL_SECONDS: 30 * 60,           // Free signup = 30 minutes of Basic experience
  BASIC_EXPIRY_DAYS: 14,            // Credits void 14 days after purchase
  LOW_WARNING_SECONDS: 120,         // Fire "2 min left" warning here
} as const;

// Admin check is done server-side via ADMIN_EMAILS env var.
// Frontend only checks if user was granted 'pro' with is_admin flag from server.
const DEVELOPER_EMAILS: string[] = [];

class LicenseService {
  private readonly STORAGE_KEY = 'minicaai_license';
  private readonly AUTH_KEY = 'minicaai_auth';
  private readonly TOKEN_KEY = 'minicaai_token';

  // Server base URL.
  //
  // Prod build: HARDCODED to api.minicaai.com regardless of any
  // VITE_SERVER_URL env var. v4.0.0–v4.0.2 shipped with localhost:4000
  // baked in because the build ran with .env.local active, and every
  // user got 401s on every auth call (their stored JWTs were signed
  // by prod's JWT_SECRET but the app was sending them to a dead local
  // server). The PROD guard here makes that impossible — even if the
  // dev forgets to clean their .env.local, a prod build always points
  // at prod.
  //
  // Dev build (`npm run dev`): honors VITE_SERVER_URL if set, lets
  // you point the renderer at a local server for testing.
  //
  // Vite inlines `import.meta.env.PROD` (= true for `vite build`,
  // false for `vite dev`) at compile time, so the resulting bundle
  // has a single static URL — no runtime branching, no surprises.
  private API_BASE = (import.meta as any).env?.PROD
    ? 'https://api.minicaai.com'
    : ((import.meta as any).env?.VITE_SERVER_URL || 'https://api.minicaai.com');

  // ── Device Fingerprint ──
  async getDeviceId(): Promise<string> {
    const components = [
      navigator.userAgent,
      navigator.language,
      screen.width + 'x' + screen.height,
      screen.colorDepth.toString(),
      new Date().getTimezoneOffset().toString(),
      navigator.hardwareConcurrency?.toString() || '0',
      (navigator as any).deviceMemory?.toString() || '0',
      // Additional entropy
      navigator.platform || '',
      (navigator as any).maxTouchPoints?.toString() || '0',
    ];

    const raw = components.join('|');
    const encoder = new TextEncoder();
    const data = encoder.encode(raw);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hash));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  isDeveloper(email: string): boolean {
    // Check is_admin flag from saved auth (set by server during login/signup)
    const { user } = this.loadAuth();
    if (user?.is_admin) return true;
    // Fallback to local list (empty by default — configured server-side via ADMIN_EMAILS env)
    return DEVELOPER_EMAILS.includes(email.toLowerCase());
  }

  // ── Admin short-circuit gate ──
  // Used by every feature/tier/balance check below to grant Max-equivalent
  // access to admins regardless of what tier is stored on their license.
  // Source of truth is the server-set `user.is_admin` flag (computed at
  // login/signup from the ADMIN_EMAILS env var). Self-managed `is_admin`
  // is impossible because the field is overwritten on every /me, login,
  // and signup response.
  private isAdmin(): boolean {
    const { user } = this.loadAuth();
    return !!user?.is_admin;
  }

  // ── Coarse OS detection from the UA ──
  // Used by AdminDashboard to display per-device platform. Sent alongside
  // device_id on signup/login/google/validate so the server can populate
  // devices.platform and login_logs.platform. Returns one of:
  // 'macOS' | 'Windows' | 'Linux' | 'iOS' | 'Android' | 'Unknown'.
  getPlatform(): string {
    if (typeof navigator === 'undefined') return 'Unknown';
    const ua = (navigator.userAgent || '').toLowerCase();
    const platform = (navigator.platform || '').toLowerCase();
    if (/iphone|ipad|ipod/.test(ua)) return 'iOS';
    if (/android/.test(ua)) return 'Android';
    if (/mac/.test(platform) || /mac os x/.test(ua)) return 'macOS';
    if (/win/.test(platform) || /windows/.test(ua)) return 'Windows';
    if (/linux/.test(platform) || /linux/.test(ua)) return 'Linux';
    return 'Unknown';
  }

  isVersionValid(): boolean {
    const [minMaj, minMin, minPatch] = MIN_VERSION.split('.').map(Number);
    const [curMaj, curMin, curPatch] = APP_VERSION.split('.').map(Number);
    if (curMaj > minMaj) return true;
    if (curMaj < minMaj) return false;
    if (curMin > minMin) return true;
    if (curMin < minMin) return false;
    return curPatch >= minPatch;
  }

  // ── Feature gate check ──
  // Gate answer is based on EFFECTIVE tier: Free users with an active 30-min
  // trial are treated as Basic for this window so they can experience the
  // full product before the wall comes up.
  canUseFeature(license: LicenseData | null, feature: keyof typeof FEATURE_GATES.free): boolean {
    // Admin gets every gate (incl. Max-only Auto-Type) regardless of stored tier.
    if (this.isAdmin()) return true;
    if (!license) return false;
    const tier = this.getEffectiveTier(license);
    const gates = FEATURE_GATES[tier];
    const value = gates[feature];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === -1 || value > 0;
    return true;
  }

  canUseModel(license: LicenseData | null, model: string): boolean {
    // Admin can use any model (mirrors Max's `models` whitelist).
    if (this.isAdmin()) return true;
    if (!license) return false;
    const tier = this.getEffectiveTier(license);
    return FEATURE_GATES[tier].models.includes(model);
  }

  // ── Effective tier resolution (4-way) ──
  // Free user inside their 30-min trial window gets Basic features.
  // Basic user with expired credits falls back to Free features.
  getEffectiveTier(license: LicenseData | null): 'free' | 'basic' | 'pro' | 'max' {
    // Admin always renders + gates as Max so the UI shows "Max Active" and
    // Auto-Type is unlocked even if the stored tier is 'free' (e.g. before
    // any /create-checkout self-grant fires).
    if (this.isAdmin()) return 'max';
    if (!license) return 'free';
    if (license.tier === 'max') return 'max';
    if (license.tier === 'pro') return 'pro';
    if (license.tier === 'basic') {
      // Basic with zero balance = locked out of Basic-only features
      if (this.getCreditsRemainingSeconds(license) > 0) return 'basic';
      return 'free';
    }
    // Free tier: check trial
    if (this.isTrialActive(license)) return 'basic';
    return 'free';
  }

  // ── Auth persistence ──
  saveAuth(user: UserProfile, license: LicenseData, token?: string): void {
    localStorage.setItem(this.AUTH_KEY, JSON.stringify(user));
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(license));
    if (token) localStorage.setItem(this.TOKEN_KEY, token);
  }

  loadAuth(): { user: UserProfile | null; license: LicenseData | null; token: string | null } {
    try {
      const userStr = localStorage.getItem(this.AUTH_KEY);
      const licenseStr = localStorage.getItem(this.STORAGE_KEY);
      const token = localStorage.getItem(this.TOKEN_KEY);
      return {
        user: userStr ? JSON.parse(userStr) : null,
        license: licenseStr ? JSON.parse(licenseStr) : null,
        token,
      };
    } catch {
      return { user: null, license: null, token: null };
    }
  }

  logout(): void {
    localStorage.removeItem(this.AUTH_KEY);
    localStorage.removeItem(this.STORAGE_KEY);
    localStorage.removeItem(this.TOKEN_KEY);
    // Per-account UX flags (tutorial completion, first-close toast shown)
    // are scoped by user_id. Clear them on logout so a different user
    // signing in on the same machine sees them fresh — and so a returning
    // user gets the toast/tutorial again if they explicitly logged out.
    try {
      const toRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (k.startsWith('tutorial_v1_completed_') ||
            k.startsWith('tray_hide_toast_shown_')) {
          toRemove.push(k);
        }
      }
      toRemove.forEach(k => localStorage.removeItem(k));
    } catch {
      // localStorage unavailable / quota — non-fatal.
    }
  }

  getToken(): string | null {
    return localStorage.getItem(this.TOKEN_KEY);
  }

  // ── License validation ──
  // 'canceling' is INTENTIONALLY treated as valid here — the user clicked
  // Cancel but still has access until expires_at. The expires_at check
  // below catches the moment access actually ends. Without this carve-out
  // the client would lock the user out the instant they hit Cancel,
  // which contradicts the explicit "you keep access until <date>" copy
  // shown in ManageSubscription.
  isLicenseValid(license: LicenseData | null): boolean {
    if (!license) return false;
    if (license.status === 'revoked') return false;
    if (license.status === 'expired') return false;
    if (license.status === 'paused') return false;
    if (license.status === 'refunded') return false;
    if (license.status === 'disputed') return false;
    if (license.expires_at > 0 && Date.now() > license.expires_at) return false;
    return true;
  }

  needsRevalidation(license: LicenseData | null): boolean {
    if (!license) return true;
    // All paid tiers MUST revalidate with server (Basic/Pro/Max)
    if (license.tier === 'basic' || license.tier === 'pro' || license.tier === 'max') {
      return Date.now() - license.last_validated > REVALIDATION_INTERVAL;
    }
    // Free users can work offline for longer
    return Date.now() - license.last_validated > (24 * 60 * 60 * 1000);
  }

  // ── Credit / trial balance helpers ──
  // Returns 0 if credits are expired or absent. Basic users only.
  getCreditsRemainingSeconds(license: LicenseData | null): number {
    if (!license) return 0;
    if (license.tier !== 'basic') return 0;
    const expireAt = license.credits_expire_at ?? 0;
    if (expireAt > 0 && Date.now() > expireAt) return 0;
    return Math.max(0, license.credits_remaining_seconds ?? 0);
  }

  // Returns 0 if trial was never granted or is exhausted. Free users only.
  getTrialRemainingSeconds(license: LicenseData | null): number {
    if (!license) return 0;
    if (license.tier !== 'free') return 0;
    return Math.max(0, license.trial_remaining_seconds ?? 0);
  }

  isTrialActive(license: LicenseData | null): boolean {
    return this.getTrialRemainingSeconds(license) > 0;
  }

  // Unified "how much live-session time does this user have left?"
  // Used by the timer service to pick which bucket to consume.
  // Returns { seconds, source } where source indicates which bucket.
  getLiveTimeBalance(license: LicenseData | null): { seconds: number; source: 'trial' | 'credits' | 'unlimited' | 'none' } {
    // Admin always has unlimited live-session time. Mirrors Pro/Max so the
    // timer service never blocks an admin mid-interview, even if the
    // stored tier hasn't been upgraded yet.
    if (this.isAdmin()) return { seconds: Infinity, source: 'unlimited' };
    if (!license) return { seconds: 0, source: 'none' };
    if (license.tier === 'pro' || license.tier === 'max') {
      return { seconds: Infinity, source: 'unlimited' };
    }
    if (license.tier === 'basic') {
      return { seconds: this.getCreditsRemainingSeconds(license), source: 'credits' };
    }
    // Free
    const trial = this.getTrialRemainingSeconds(license);
    return trial > 0 ? { seconds: trial, source: 'trial' } : { seconds: 0, source: 'none' };
  }

  // Deduct `seconds` from the appropriate bucket. Returns the updated license.
  // Saves to storage. No-op for unlimited tiers.
  consumeTime(license: LicenseData, seconds: number): LicenseData {
    if (seconds <= 0) return license;
    if (license.tier === 'pro' || license.tier === 'max') return license;
    let updated = { ...license };
    if (license.tier === 'basic') {
      const remaining = Math.max(0, (license.credits_remaining_seconds ?? 0) - seconds);
      updated.credits_remaining_seconds = remaining;
    } else if (license.tier === 'free') {
      const remaining = Math.max(0, (license.trial_remaining_seconds ?? 0) - seconds);
      updated.trial_remaining_seconds = remaining;
    }
    const user = this.loadAuth().user;
    if (user) this.saveAuth(user, updated);
    return updated;
  }

  // ── Fresh Basic credit seed ──
  // A new Basic grant = 3 credits (3 hours) valid until the server-set
  // license.expires_at. Called on first-time Basic purchase, NOT on renewal.
  // Kept private because only normalizeLicenseCredits should decide when to
  // seed — direct callers would mis-overwrite an in-flight balance.
  private freshBasicCreditSeed(license: LicenseData): { credits_remaining_seconds: number; credits_expire_at: number } {
    const fallback = Date.now() + TIME_CONSTANTS.BASIC_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
    return {
      credits_remaining_seconds: 3 * TIME_CONSTANTS.SECONDS_PER_CREDIT,
      credits_expire_at: license.expires_at > 0 ? license.expires_at : fallback,
    };
  }

  // ── Trial-state normalizer ──
  // Server stamps `trial_granted_at` at signup. We use that to compute
  // the remaining wall-clock seconds when there is no in-session local
  // ledger to preserve (e.g., logout → re-login on the same device).
  // Without this, the old code defaulted any login with
  // trial_remaining_seconds === undefined to a fresh 30 min, which let
  // a free user reset their trial by logging out and back in. With this,
  // the trial is authoritatively bounded by `trial_granted_at + 30 min`
  // wall-clock, regardless of how many auth events the user triggers.
  //
  // We still PREFER the in-session local ledger when present so a
  // legitimate session-tab refresh or background revalidation doesn't
  // reset what the timer already consumed.
  private normalizeTrialState(license: LicenseData, priorLicense: LicenseData | null): LicenseData {
    if (license.tier !== 'free') {
      // Paid tiers don't use the trial bucket — strip for cleanliness so
      // getEffectiveTier never reads a stale free-tier trial value.
      const clean: any = { ...license };
      delete clean.trial_remaining_seconds;
      return clean as LicenseData;
    }
    if (
      priorLicense?.tier === 'free' &&
      typeof priorLicense.trial_remaining_seconds === 'number'
    ) {
      // In-session preserve: the timer service is mid-tick and trusts
      // its own balance. Server revalidation lands here too.
      return { ...license, trial_remaining_seconds: priorLicense.trial_remaining_seconds };
    }
    // Fresh login (no local ledger): derive from the server timestamp.
    return { ...license, trial_remaining_seconds: this.computeTrialRemainingFromServer(license) };
  }

  private computeTrialRemainingFromServer(license: LicenseData): number {
    const grantedAt = license.trial_granted_at || 0;
    // grantedAt = 0 → server hasn't recorded a grant (legacy row that
    // somehow missed the migration backfill). Fail closed at 0 — better
    // to under-grant than re-open the unbounded-trial window.
    if (grantedAt <= 0) return 0;
    const elapsedSec = Math.max(0, Math.floor((Date.now() - grantedAt) / 1000));
    return Math.max(0, TIME_CONSTANTS.TRIAL_SECONDS - elapsedSec);
  }

  // ── Credit-state normalizer ──
  // Server today does NOT echo credit fields (Option A: client-side ledger).
  // So every path that merges a server license into local state has to decide
  // whether the credit balance survives, gets seeded fresh, or gets wiped:
  //
  //   · Basic + no prior Basic state    → seed 3 credits (new purchase).
  //   · Basic + coherent prior Basic    → carry the running balance over.
  //   · Non-Basic tier                  → strip Basic-only fields (cleanliness).
  //
  // Without this, tierChanged: 'free'→'basic' left credits_remaining_seconds
  // undefined, which getEffectiveTier treats as 0 and silently downgrades
  // the paying user back to 'free' features.
  private normalizeLicenseCredits(license: LicenseData, priorLicense: LicenseData | null): LicenseData {
    if (license.tier !== 'basic') {
      const clean: any = { ...license };
      delete clean.credits_remaining_seconds;
      delete clean.credits_expire_at;
      return clean as LicenseData;
    }
    const prior = priorLicense && priorLicense.tier === 'basic' ? priorLicense : null;
    const hasCoherentPrior =
      !!prior &&
      typeof prior.credits_remaining_seconds === 'number' &&
      typeof prior.credits_expire_at === 'number' &&
      prior.credits_expire_at > 0;
    if (hasCoherentPrior) {
      return {
        ...license,
        credits_remaining_seconds: prior!.credits_remaining_seconds,
        credits_expire_at: prior!.credits_expire_at,
      };
    }
    return { ...license, ...this.freshBasicCreditSeed(license) };
  }

  // Credit one additional hour (Basic renewal flow).
  //
  // Base off effective balance, NOT the raw field: if the prior credits
  // already expired (credits_expire_at < now), effective balance is 0 and
  // stale seconds should not carry over. Otherwise a user whose credits
  // expired with 1800s unused would pay for renewal and silently get
  // 3600 + 1800 = 5400s — effectively a free half-credit.
  //
  // Anchor the new expiry from max(now, license.expires_at) + 1h, mirroring
  // the server's grantBasicRenewal in database.js. /create-renewal does NOT
  // pre-bump expires_at — the payment.captured webhook does — so when this
  // runs from the success URL, license.expires_at is still the pre-renewal
  // value (often already past for a user who just hit the 14-day wall).
  // Using it verbatim would place credits_expire_at in the past and void
  // the credit the user just paid for. The next successful revalidation
  // picks up the server-bumped expires_at and the two ledgers reconverge.
  grantRenewalCredit(license: LicenseData): LicenseData {
    const effectiveRemaining = this.getCreditsRemainingSeconds(license);
    const ONE_HOUR_MS = TIME_CONSTANTS.SECONDS_PER_CREDIT * 1000;
    const anchor = Math.max(Date.now(), license.expires_at > 0 ? license.expires_at : 0);
    const updated: LicenseData = {
      ...license,
      tier: 'basic', // grantBasicRenewal also reactivates from free/expired → basic
      credits_remaining_seconds: effectiveRemaining + TIME_CONSTANTS.SECONDS_PER_CREDIT,
      credits_expire_at: anchor + ONE_HOUR_MS,
    };
    const user = this.loadAuth().user;
    if (user) this.saveAuth(user, updated);
    return updated;
  }

  canStartSession(license: LicenseData | null): boolean {
    // Admin can always start a new session regardless of sessions_used.
    if (this.isAdmin()) return true;
    if (!license) return false;
    if (license.sessions_limit === -1) return true;
    return license.sessions_used < license.sessions_limit;
  }

  incrementSession(license: LicenseData): LicenseData {
    const updated = { ...license, sessions_used: license.sessions_used + 1 };
    const user = this.loadAuth().user;
    if (user) this.saveAuth(user, updated);
    return updated;
  }

  // ── Server communication ──
  async signup(email: string, password: string, name: string, countryCode: string): Promise<{ user: UserProfile; license: LicenseData; token: string }> {
    const deviceId = await this.getDeviceId();

    const response = await fetch(`${this.API_BASE}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email, password, name,
        country_code: countryCode,
        device_id: deviceId,
        platform: this.getPlatform(),
        app_version: APP_VERSION,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Signup failed' }));
      throw new Error(err.error || 'Signup failed');
    }

    const data = await response.json();
    data.license.last_validated = Date.now();
    // Trial seed is now derived from the server's trial_granted_at timestamp
    // rather than unconditionally defaulted to 30 min. On a brand-new signup
    // grantedAt ≈ Date.now(), so the computed remaining is ≈ TRIAL_SECONDS;
    // on subsequent re-auths the same code path correctly subtracts elapsed
    // wall-clock time and never resets the trial.
    data.license = this.normalizeTrialState(data.license, null);
    this.saveAuth(data.user, data.license, data.token);
    this.startRevalidation();
    return data;
  }

  async login(email: string, password: string): Promise<{ user: UserProfile; license: LicenseData; token: string }> {
    const deviceId = await this.getDeviceId();

    const response = await fetch(`${this.API_BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, device_id: deviceId, platform: this.getPlatform(), app_version: APP_VERSION }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Login failed' }));
      throw new Error(err.error || 'Invalid credentials');
    }

    const data = await response.json();
    data.license.last_validated = Date.now();
    // Server doesn't echo client-ledger credit fields. Preserve any prior
    // balance (same user, new tab) or seed a fresh one when the server
    // says tier='basic' and we have no local state yet. Without this,
    // a Basic user re-logging in would land with credits undefined →
    // getEffectiveTier() downgrades them to Free.
    const { license: priorLicense } = this.loadAuth();
    data.license = this.normalizeTrialState(data.license, priorLicense);
    data.license = this.normalizeLicenseCredits(data.license, priorLicense);
    this.saveAuth(data.user, data.license, data.token);
    this.startRevalidation();
    return data;
  }

  // Google OAuth login
  async googleAuth(credential: string, countryCode: string = 'US'): Promise<{ user: UserProfile; license: LicenseData; token: string; is_new_user: boolean }> {
    const deviceId = await this.getDeviceId();

    const response = await fetch(`${this.API_BASE}/api/v1/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential, device_id: deviceId, platform: this.getPlatform(), country_code: countryCode }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Google login failed' }));
      throw new Error(err.error || 'Google authentication failed');
    }

    const data = await response.json();
    if (data.license) {
      data.license.last_validated = Date.now();
      // Trial: derived from server's trial_granted_at, preserving the
      // in-session balance when one exists (same as login()). The old
      // `is_new_user === true` guard is no longer needed — the server
      // timestamp already encodes whether this is a fresh grant or an
      // already-elapsed one.
      const { license: priorLicense } = this.loadAuth();
      data.license = this.normalizeTrialState(data.license, priorLicense);
      // Basic-tier users returning via Google: preserve or seed the
      // client-side credit ledger. Server doesn't echo these fields and
      // the 'basic' tier needs them or getEffectiveTier() falls through
      // to Free.
      data.license = this.normalizeLicenseCredits(data.license, priorLicense);
    }
    this.saveAuth(data.user, data.license, data.token);
    this.startRevalidation();
    return data;
  }

  async validateWithServer(): Promise<LicenseData | null> {
    const { license, token } = this.loadAuth();
    if (!license || !token) return null;

    // license.device_id loaded from localStorage is always undefined —
    // the server's licenses table has no device_id column, so it's never
    // populated on auth responses. Compute a fresh fingerprint each call
    // (same as signup/login/google) or the server rejects with 400 and
    // revalidation silently noops forever.
    const deviceId = await this.getDeviceId();

    try {
      const response = await fetch(`${this.API_BASE}/api/v1/license/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          key: license.key,
          device_id: deviceId,
          platform: this.getPlatform(),
          app_version: APP_VERSION,
        }),
      });

      // ── NEVER REVOKE CLIENT-SIDE ──
      // A failed revalidation must NEVER disrupt an active interview.
      // If the server rejects the token (401/403) or is unreachable,
      // we keep using the cached license as-is. Any forced re-login
      // path here would be catastrophic mid-interview — the user
      // cannot pause an interviewer to re-authenticate.
      // Revalidation is best-effort: it can UPGRADE the cached state
      // (tier change, token rotation) but never DEGRADE it.
      if (!response.ok) {
        return license;
      }

      const serverData = await response.json();

      // ── Credit-field merge guard ──
      // The client tick is authoritative for credits/trial seconds today
      // (Option A, client-side ledger). A naive spread would let a stale
      // server value overwrite the locally-consumed field — so on every
      // focus/revalidation during a session the user would get their
      // time refunded. Strip those fields from the merge so the in-memory
      // ticker is never clobbered; tier transitions (e.g. Free → Basic
      // after a webhook lands) are re-seeded deterministically below via
      // normalizeLicenseCredits, which does NOT read from serverData —
      // the server never echoes these fields in the first place (Option A).
      const tierChanged = serverData.tier && serverData.tier !== license.tier;
      // Fields that must NOT clobber the client ledger on revalidation.
      // is_admin is also broken out — it lives on the user, not the license,
      // so we strip it from the license merge and apply it to the user
      // separately below.
      const {
        credits_remaining_seconds: _crs,
        credits_expire_at: _cea,
        trial_remaining_seconds: _trs,
        trial_started_at: _tsa,
        is_admin: serverIsAdmin,
        ...serverSafe
      } = serverData;

      let updatedLicense: LicenseData = {
        ...license,
        ...serverSafe,
        last_validated: Date.now(),
      };

      if (tierChanged) {
        // Fresh tier grant — re-seed the client ledger for the NEW tier.
        // Pass the prior license so a Basic→Basic no-op (shouldn't happen
        // here since tierChanged is true, but defensive) would still
        // preserve balance. For Free→Basic this seeds 3 credits. For
        // Basic→Pro/Max it strips the Basic-only credit fields.
        updatedLicense = this.normalizeLicenseCredits(updatedLicense, license);
        // If the user just left Free, clear the trial remnants so the
        // Pro/Max timer service doesn't read a stale trial balance.
        if (updatedLicense.tier !== 'free') {
          delete (updatedLicense as any).trial_remaining_seconds;
        }
      } else if (license.tier === 'basic' && serverData.tier === 'basic') {
        // ── Cross-device renewal-credit propagation ──
        // The server's grantBasicRenewal extends the license's expires_at
        // by exactly 1h on each renewal payment. We use that delta as a
        // change-detection signal: when the server's expires_at moves
        // forward by ~1h since our last sync, a renewal payment landed
        // somewhere (browser, another device, even the system browser
        // launched from Electron). Apply +3600s to the local ledger so
        // the renewal credits land regardless of which device/window
        // handled the payment-success URL.
        //
        // Idempotent: after we apply the credit, we save the new
        // expires_at into local state. The NEXT validate compares the
        // already-synced value with the server's same value → delta=0
        // → no re-grant. Without consumption tracking this is the
        // cleanest event-based propagation we can do.
        const oldExpires = license.expires_at || 0;
        const newExpires = serverData.expires_at || 0;
        const ONE_HOUR_MS = 60 * 60 * 1000;
        const deltaMs = newExpires - oldExpires;
        if (deltaMs >= 0.5 * ONE_HOUR_MS && deltaMs <= 1.5 * ONE_HOUR_MS) {
          // Renewal-shaped delta. Add 1h of credit time + extend the
          // credit window. We only treat 30-90min deltas as renewals;
          // bigger deltas are full Basic grants (handled by tierChanged
          // when applicable) or unusual states we leave alone.
          const ONE_HOUR_S = 3600;
          const existingCredits = updatedLicense.credits_remaining_seconds ?? 0;
          updatedLicense = {
            ...updatedLicense,
            credits_remaining_seconds: existingCredits + ONE_HOUR_S,
            credits_expire_at: newExpires,
          };
        }
      }

      const user = this.loadAuth().user;
      // Pick up an admin-flag flip from the server. Without this, a user
      // whose email was removed from ADMIN_EMAILS would keep admin
      // powers (self-grant tiers, Recent Conversations, force-logout)
      // until they happened to log out manually. Mirror flag-on too so
      // a freshly-promoted admin doesn't have to log out and back in.
      const updatedUser = (user && typeof serverIsAdmin === 'boolean' && user.is_admin !== serverIsAdmin)
        ? { ...user, is_admin: serverIsAdmin }
        : user;
      // If server rotated the token, save the new one so the next
      // request doesn't hit 401. Falls back to existing token otherwise.
      const newToken = serverData.token || token;
      if (updatedUser) this.saveAuth(updatedUser, updatedLicense, newToken);
      return updatedLicense;
    } catch {
      // Network hiccup — keep the cached license, do not lock anything.
      return license;
    }
  }

  // ── Startup revalidation ──
  // Fires exactly once when the app boots / logs in — no periodic timer.
  //
  // Rationale: this app is used during live job interviews. Any auth
  // disruption mid-session is catastrophic (the user cannot pause an
  // interviewer to re-login), so we do not poll. The one-shot call on
  // startup is enough to pick up a server-rotated token or a tier change
  // that happened between sessions. Errors are swallowed so a transient
  // network issue at launch never surfaces to the user.
  startRevalidation(): void {
    this.validateWithServer().catch(() => {});
  }

  getAppVersion(): string {
    return APP_VERSION;
  }

  getApiBase(): string {
    return this.API_BASE;
  }

  // ── Profile update ──
  // Wraps PUT /api/v1/auth/profile. Server validates name (1-100 chars) and
  // country_code (/^[A-Z]{2}$/). On success, mirrors the new user record into
  // localStorage so every consumer (tier badge, account sheet, AI prompts
  // that interpolate the name) sees the change without a round-trip through
  // /me. Throws on network/validation failure so the caller can surface the
  // error inline instead of a silent no-op.
  //
  // We deliberately don't accept country_code here — the existing /profile
  // endpoint allows it, but exposing it client-side would let users swap
  // their billing region to whichever currency is cheapest. The server's
  // /create-checkout already ignores body.country_code in favor of the JWT
  // value (see payments.js comment), so the abuse vector is contained, but
  // we don't open the door on this surface either.
  async updateProfile(updates: { name?: string }): Promise<UserProfile> {
    const token = this.getToken();
    if (!token) throw new Error('Not signed in');

    const body: Record<string, string> = {};
    if (typeof updates.name === 'string') {
      const trimmed = updates.name.trim();
      if (trimmed.length === 0) throw new Error('Name cannot be empty');
      if (trimmed.length > 100) throw new Error('Name must be 100 characters or fewer');
      body.name = trimmed;
    }
    if (Object.keys(body).length === 0) {
      throw new Error('No changes to save');
    }

    const response = await fetch(`${this.API_BASE}/api/v1/auth/profile`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Profile update failed' }));
      throw new Error(err.error || 'Profile update failed');
    }
    const data = await response.json();
    if (!data.user) throw new Error('Profile update returned no user');

    // Merge into local state. Preserve fields the server doesn't echo
    // (is_admin is computed server-side at /me time, not on /profile).
    const { user: prevUser, license: prevLicense } = this.loadAuth();
    const mergedUser: UserProfile = {
      ...(prevUser || {} as UserProfile),
      ...data.user,
    };
    if (prevLicense) {
      this.saveAuth(mergedUser, prevLicense);
    } else {
      // No license yet (shouldn't happen post-auth but defensive). Persist
      // the user portion only by writing through saveAuth's user key
      // directly via a synthetic call — the AUTH_KEY/STORAGE_KEY pair is
      // intended to be written together, but a missing license is a
      // recoverable state the next /validate call will repair.
      try { localStorage.setItem('minicaai_auth', JSON.stringify(mergedUser)); } catch {}
    }
    return mergedUser;
  }
}

export const licenseService = new LicenseService();
