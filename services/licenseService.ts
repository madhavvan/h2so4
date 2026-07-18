// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LICENSE SERVICE — Server-validated, device-bound licensing
//
//  SECURITY MODEL:
//  - App is LOCKED until server confirms a valid license
//  - Device fingerprint is bound to the license at activation
//  - Periodic revalidation every 30 minutes
//  - No offline grace period for Pro — forces server check
//
//  TIERS (2026-07 pricing — dollar/rupee amounts live in services/pricingService.ts):
//  - Free: ONE-TIME 10-minute trial on first signup — every model except
//    Claude (acts as Basic-level features for that window), time-gated by
//    trial_remaining_seconds. Once the trial is exhausted NOTHING is free:
//    the server 402s every model route and the client shows the paywall.
//  - Basic ($30 one-time): ONE 30-min interview, four models (Gemini, GPT-5.5,
//    Grok, Groq — NO Claude), stealth, Auto-Solve. No Auto-Type. Extend +30 min
//    anytime. Time-gated by credits_remaining_seconds.
//  - Pro ($50 one-time): ONE 1-hour interview, all five models incl. Claude
//    Sonnet 5. No Auto-Type. Extend anytime (+30 min $25 / +1 h $45 / +3 h $80 packs).
//  - Max ($89 one-time): THREE 1-hour interviews, all five models, full
//    reasoning control + Train Model. No Auto-Type. Same extension packs as Pro.
//  - Ultra ($159/month): UNLIMITED interviews, all five models, Auto-Type +
//    Train Model — the only recurring subscription.
//  Admins bypass every gate (see isAdmin / getEffectiveTier) — full access,
//  unlimited everything, no purchase required.
//
//  CREDITS vs TIME:
//  Credits are a display abstraction — internally we track seconds.
//  3600s = "1 credit" (1 hour). Basic=1800s, Pro=3600s, Max=3×3600s.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface LicenseData {
  key: string;
  email: string;
  tier: 'free' | 'basic' | 'pro' | 'max' | 'ultra';
  // Status values mirror what the server's webhook handlers + license
  // routes write into the licenses table. Keep this union exhaustive — a
  // missing value here would render as 'Unknown' in the billing UI's
  // STATUS_LABEL fallback.
  //   active    — paying customer, sub will renew
  //   canceling — cancel-at-period-end set; still has access until expires_at
  //   past_due  — payment failed, provider auto-retrying (~7 days); access
  //               RETAINED during the retry window (server ACCESS_STATUSES)
  //   trial     — Free user inside the 10-min trial window
  //   expired   — sub ended (cycle close, unpaid, or natural completion)
  //   revoked   — admin revoked or hard ban
  //   paused    — Stripe collection paused (rare; soft revoke)
  //   refunded  — full refund issued; access revoked
  //   disputed  — chargeback opened; access revoked pending dispute outcome
  status: 'active' | 'canceling' | 'past_due' | 'trial' | 'expired' | 'revoked' | 'paused' | 'refunded' | 'disputed';
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
  trial_remaining_seconds?: number;    // One-time 10-min trial for Free users
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
  tier: 'free' | 'basic' | 'pro' | 'max' | 'ultra';
  country_code: string;
  created_at: number;
  is_admin?: boolean;
  oauth_provider?: string;
}

// Feature gates — what each tier can access.
// 2026-07 gate map. Basic = the four base models (no Claude), time-gated.
// Pro/Max = all five models incl. Claude; Max adds reasoning-effort control.
// Auto-Type is Ultra-exclusive (the only recurring, unlimited tier).
export const FEATURE_GATES = {
  free: {
    // POST-TRIAL state (2026-07 policy). A free user with trial seconds
    // left resolves to 'basic' via getEffectiveTier and never reads this
    // row — during the one-time 10-minute trial they get the four
    // non-Claude models from the basic gate. Once the trial hits 0
    // NOTHING is free (the server 402s every model route, Gemini
    // included), so no models are listed here: the pickers render fully
    // locked and executeSend shows the trial-used-up paywall message
    // instead of letting a send fail server-side mid-interview.
    models: [] as string[],
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
    trainModel: false,
  },
  basic: {
    // Basic is the only paid tier WITHOUT Claude — Claude (hosted web_search)
    // unlocks at Pro as the premium step-up.
    models: ['gemini', 'groq', 'openai', 'xai'] as string[],
    screenCapture: true,
    autoSolve: true,
    autoType: false,     // Auto-Type is Ultra-exclusive (2026-07 pricing)
    popout: true,
    contextFiles: -1,    // unlimited
    sessionsPerMonth: -1, // session count isn't the gate — credit time is
    exportHistory: true,
    reasoningEffortControl: false,
    trainModel: false,
  },
  pro: {
    // Pro unlocks Claude Sonnet 5 (all five models). Basic is the only paid
    // tier without Claude. Pro = one 1-hour interview (time-gated).
    // Train Model stays Max+ — it's the Max upsell alongside the
    // reasoning dial; Pro gets Claude + its web search, not the trainer.
    models: ['gemini', 'groq', 'openai', 'xai', 'claude'] as string[],
    screenCapture: true,
    autoSolve: true,
    autoType: false,     // Auto-Type is Ultra-exclusive
    popout: true,
    contextFiles: -1,    // unlimited
    sessionsPerMonth: -1, // session count isn't the gate — credit time is
    exportHistory: true,
    reasoningEffortControl: false,
    trainModel: false,
  },
  max: {
    // Max = three 1-hour interviews, all five models. No Auto-Type (Ultra-only).
    models: ['gemini', 'groq', 'openai', 'xai', 'claude'] as string[],
    screenCapture: true,
    autoSolve: true,
    autoType: false,     // Auto-Type moved to Ultra (2026-07 pricing)
    popout: true,
    contextFiles: -1,    // unlimited
    sessionsPerMonth: -1, // 3 interviews enforced via sessions_limit + per-session cap
    exportHistory: true,
    // Full reasoning bar (none/low/medium/high) on Max and Ultra.
    reasoningEffortControl: true,
    trainModel: true,    // the Max differentiator (with the reasoning dial)
  },
  ultra: {
    // Ultra = unlimited interviews, all five models, + Auto-Type. Monthly sub.
    models: ['gemini', 'groq', 'openai', 'xai', 'claude'] as string[],
    screenCapture: true,
    autoSolve: true,
    autoType: true,      // Ultra unlocks Auto-Type
    popout: true,
    contextFiles: -1,    // unlimited
    sessionsPerMonth: -1, // unlimited
    exportHistory: true,
    reasoningEffortControl: true,
    trainModel: true,
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
  // Basic's extension unit. Kept for back-compat with older call sites;
  // tier-aware code must use EXTENSION_SECONDS_BY_TIER below instead.
  EXTENSION_SECONDS: 30 * 60,
  TRIAL_SECONDS: 10 * 60,           // Free signup = one-time 10 minutes of Basic experience
  BASIC_EXPIRY_DAYS: 14,            // Credits void 14 days after purchase
  LOW_WARNING_SECONDS: 120,         // Fire the "2 min left" pre-expiry warning here (owner: "a min or 2 before")
} as const;

// ── Extension unit (2026-07) ──
// A flat +30-minute top-up for every metered tier (Basic/Pro/Max); Ultra
// is unlimited and exempt. Optimistic client mirror of the server grant —
// MUST stay in sync with the flat +30-min grantTimeExtension in
// server/src/database.js and RENEWAL_* in services/pricingService.ts.
export const EXTENSION_SECONDS_BY_TIER: Record<'basic' | 'pro' | 'max', number> = {
  basic: 30 * 60,
  pro: 30 * 60,
  max: 30 * 60,
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
  // Gate answer is based on EFFECTIVE tier: Free users with an active 10-min
  // trial are treated as Basic for this window so they can experience the
  // full product before the wall comes up.
  //
  // Admins resolve to Ultra (see getEffectiveTier) so every feature + model is
  // unlocked — the owner's policy that an admin account has unlimited everything.
  // An admin who wants to test a lower tier's gating can set the
  // 'minicaai_admin_test_tier' localStorage override; clearing it restores full
  // access. The admin-tools surface (dashboard, bot tools) remains gated
  // independently on the server-side ADMIN_EMAILS check.
  canUseFeature(license: LicenseData | null, feature: keyof typeof FEATURE_GATES.free): boolean {
    if (!license) return false;
    const tier = this.getEffectiveTier(license);
    const gates = FEATURE_GATES[tier];
    const value = gates[feature];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === -1 || value > 0;
    return true;
  }

  canUseModel(license: LicenseData | null, model: string): boolean {
    if (!license) return false;
    const tier = this.getEffectiveTier(license);
    return FEATURE_GATES[tier].models.includes(model);
  }

  // ── Plan-lapse check (paid tiers) ──
  // The client mirror of the SERVER's tier gate (server/src/middleware/tier.js:
  // hasAccess(status) + expires_at, per services/subscriptionStates.js
  // ACCESS_STATUSES = active | canceling | past_due). A paid plan keeps its
  // FEATURES while the status retains access AND expires_at hasn't passed
  // (-1 sentinel = never expires; 0 = no expiry recorded).
  //
  // Time exhaustion is deliberately NOT lapse: a Pro user whose interview
  // clock hit 0 is still Pro — models and Pop-out stay unlocked; only live
  // use is blocked (server requireTimeRemaining → 402 "top up") until they
  // buy an extension pack. What lapses a plan is the calendar/status side:
  // expires_at passing, cancel completing, refund, revoke, pause, dispute —
  // exactly the cases where the server's requireTier starts returning 403
  // "renew". Keeping the two sides identical is what guarantees the client
  // never shows a feature the server would deny, and vice versa.
  isPlanLapsed(license: LicenseData | null): boolean {
    if (!license) return false;
    if (license.tier === 'free') return false; // no plan to lapse — the trial bucket governs Free
    const s = license.status as string;
    const accessOk = s === 'active' || s === 'canceling' || s === 'past_due';
    if (!accessOk) return true;
    if (license.expires_at > 0 && Date.now() > license.expires_at) return true;
    return false;
  }

  // ── Plan state for messaging (top-up vs renew vs trial-over) ──
  //   'ok'             — plan usable right now (or unlimited/admin).
  //   'time_exhausted' — plan VALID but the live balance is 0. Paid tiers
  //                      keep every feature and get a TOP-UP prompt (never
  //                      "upgrade" — they already own the tier). Free tier
  //                      here means the one-time trial is used up → plans.
  //   'lapsed'         — plan calendar-expired / canceled / refunded /
  //                      revoked. Features revert to Free and the prompt is
  //                      RENEW — distinct from the top-up prompt, and never
  //                      mislabeling a (former) paying customer as Free.
  getPlanState(license: LicenseData | null): 'ok' | 'time_exhausted' | 'lapsed' {
    if (this.isAdmin()) return 'ok';
    if (!license) return 'ok';
    if (this.isPlanLapsed(license)) return 'lapsed';
    const bal = this.getLiveTimeBalance(license);
    if (bal.source !== 'unlimited' && bal.seconds <= 0) return 'time_exhausted';
    return 'ok';
  }

  // ── Effective tier resolution ──
  // Admins resolve to Ultra (full access) unless they opt into a lower tier via
  // the 'minicaai_admin_test_tier' localStorage override.
  // Free user inside their one-time 10-min trial window gets Basic features.
  // Paid tiers (Basic/Pro/Max/Ultra) keep their tier until the PLAN lapses
  // (calendar expiry / cancel / refund / revoke — see isPlanLapsed). Time
  // exhaustion alone never demotes a paying user.
  getEffectiveTier(license: LicenseData | null): 'free' | 'basic' | 'pro' | 'max' | 'ultra' {
    // ── Admin full access ──
    // Admins resolve to the top tier (Ultra) for EVERY feature + model gate,
    // matching the server-side ADMIN_EMAILS bypass in middleware/tier.js. This is
    // the owner's explicit policy: an admin account has unlimited everything with
    // no purchase and no license row required. To deliberately test a LOWER tier's
    // gating as an admin, set localStorage 'minicaai_admin_test_tier' to one of
    // free|basic|pro|max|ultra (clear it to restore full access).
    if (this.isAdmin()) {
      try {
        const t = typeof localStorage !== 'undefined'
          ? localStorage.getItem('minicaai_admin_test_tier')
          : null;
        if (t === 'free' || t === 'basic' || t === 'pro' || t === 'max' || t === 'ultra') return t;
      } catch { /* localStorage unavailable — fall through to full access */ }
      return 'ultra';
    }
    if (!license) return 'free';
    // ── Paid tiers: features follow the PLAN, not the clock (2026-07 fix) ──
    // Mirrors the server exactly: requireTier grants tier features on
    // tier + access-status + expires_at and NEVER looks at the seconds
    // balance — time is a separate gate (requireTimeRemaining → 402 with
    // "extend/top-up" copy). The old client behavior collapsed Basic/Pro/
    // Max to 'free' the moment credits hit 0, which stripped Pop-out and
    // every model from PAYING users and told a Pro user to "Upgrade to
    // Pro" — the reported bug. Now: a time-exhausted paid user keeps the
    // tier (models selectable, Pop-out opens); executeSend / the usage
    // session gate block live use with a top-up prompt instead.
    // Ultra is the monthly sub: same rule, minus the (nonexistent) meter.
    if (license.tier === 'ultra') {
      return this.isPlanLapsed(license) ? 'free' : 'ultra';
    }
    if (license.tier === 'basic' || license.tier === 'pro' || license.tier === 'max') {
      return this.isPlanLapsed(license) ? 'free' : license.tier;
    }
    // Free tier: the one-time 10-min signup trial grants Basic-level features
    // for its window. After it, 'free' = the post-trial paywall state (no models).
    if (this.isTrialActive(license)) return 'basic';
    return 'free';
  }

  // ── Auth persistence ──
  saveAuth(user: UserProfile, license: LicenseData, token?: string): void {
    localStorage.setItem(this.AUTH_KEY, JSON.stringify(user));
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(license));
    if (token) localStorage.setItem(this.TOKEN_KEY, token);
    // Notify in-tab listeners (e.g. floating SupportBot, Documentation
    // admin-docs panel) that auth state changed. The 'storage' event
    // only fires for OTHER tabs, so for same-tab login/logout we
    // dispatch a custom event explicitly.
    this.emitAuthChange('save');
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
    this.emitAuthChange('logout');
  }

  getToken(): string | null {
    return localStorage.getItem(this.TOKEN_KEY);
  }

  // Notify in-tab listeners that auth state changed. Used by floating
  // SupportBot, Documentation admin-docs section, and any other
  // component that mounts outside the auth-state-owning component
  // and so doesn't naturally re-render on login/logout.
  // Wrapped in try/catch because CustomEvent isn't available in older
  // jsdom test environments and we don't want test infra to crash auth.
  private emitAuthChange(reason: 'save' | 'logout'): void {
    if (typeof window === 'undefined') return;
    try {
      window.dispatchEvent(new CustomEvent('minicaai-auth-changed', { detail: { reason } }));
    } catch { /* CustomEvent unavailable */ }
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
    // One-time passes (Basic/Pro/Max) END in 'expired' BY DESIGN — every
    // pass reaches it 30 days after purchase. That's the plan's normal
    // terminal state, not an auth problem: restore the session and let the
    // gates resolve the user to Free footing with renew/re-buy prompts
    // (getEffectiveTier + isPlanLapsed already do; the server enforces
    // regardless). Bouncing these users to the sign-in screen on every
    // launch punished exactly the proven buyers most likely to purchase
    // again. Anomalous terminal states (revoked above, refunded/disputed/
    // paused below) still bounce — those aren't a pass's natural lifecycle.
    const isPass = license.tier === 'basic' || license.tier === 'pro' || license.tier === 'max';
    if (license.status === 'expired') return isPass;
    if (license.status === 'paused') return false;
    if (license.status === 'refunded') return false;
    if (license.status === 'disputed') return false;
    // Free carve-out — mirrors the server exactly (license.js /validate +
    // middleware/tier.js, pinned by test/free-trial-gate-chain.test.js):
    // a free license's 30-day expires_at is UI bookkeeping, NOT an access
    // boundary — the one-time trial bucket is the free tier's real wall.
    // Without this, every saved free session went "invalid" 30 days after
    // signup and the user was bounced to the sign-in screen on EVERY app
    // launch forever — maximum friction on exactly the audience we want
    // frictionlessly returning to the paywall.
    if (license.tier === 'free') return true;
    // Calendar-lapsed pass (expires_at passed but the status flip hasn't
    // landed yet — /validate stamps 'expired' on its next touch): same
    // reasoning as the 'expired' branch above.
    if (license.expires_at > 0 && Date.now() > license.expires_at) return isPass;
    return true;
  }

  needsRevalidation(license: LicenseData | null): boolean {
    if (!license) return true;
    // All paid tiers MUST revalidate with server (Basic/Pro/Max)
    if (license.tier === 'basic' || license.tier === 'pro' || license.tier === 'max' || license.tier === 'ultra') {
      return Date.now() - license.last_validated > REVALIDATION_INTERVAL;
    }
    // Free users can work offline for longer
    return Date.now() - license.last_validated > (24 * 60 * 60 * 1000);
  }

  // ── Credit / trial balance helpers ──
  // Returns 0 if credits are expired or absent. Basic users only.
  getCreditsRemainingSeconds(license: LicenseData | null): number {
    if (!license) return 0;
    // Basic/Pro/Max all draw from the credit-seconds bucket now (time-limited
    // interviews). Ultra is unlimited; Free uses the trial bucket instead.
    if (!['basic', 'pro', 'max'].includes(license.tier)) return 0;
    // Admin-granted / comp licenses are unlimited-until-revoked: the grant path
    // seeds -1 credits and a -1 (never-expires) window. Treat that as Infinity
    // so an admin-comped user never hits the interview time cap.
    if ((license.credits_remaining_seconds ?? 0) === -1
        || license.expires_at === -1
        || license.credits_expire_at === -1) {
      return Infinity;
    }
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
    // Ultra is the only unlimited paid tier now.
    if (license.tier === 'ultra') {
      return { seconds: Infinity, source: 'unlimited' };
    }
    // Basic (30m) / Pro (1h) / Max (3×1h) all draw from the credit-seconds bucket.
    // An admin-granted unlimited license reports Infinity here → 'unlimited'.
    if (license.tier === 'basic' || license.tier === 'pro' || license.tier === 'max') {
      const secs = this.getCreditsRemainingSeconds(license);
      return secs === Infinity
        ? { seconds: Infinity, source: 'unlimited' }
        : { seconds: secs, source: 'credits' };
    }
    // Free
    const trial = this.getTrialRemainingSeconds(license);
    return trial > 0 ? { seconds: trial, source: 'trial' } : { seconds: 0, source: 'none' };
  }

  // Deduct `seconds` from the appropriate bucket. Returns the updated license.
  // Saves to storage. No-op for unlimited tiers.
  consumeTime(license: LicenseData, seconds: number): LicenseData {
    if (seconds <= 0) return license;
    if (license.tier === 'ultra') return license; // unlimited — nothing to deduct
    // Admin-granted unlimited (-1 sentinel) — never deduct, never expire.
    if ((license.credits_remaining_seconds ?? 0) === -1 || license.expires_at === -1) return license;
    let updated = { ...license };
    if (license.tier === 'basic' || license.tier === 'pro' || license.tier === 'max') {
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

  // ── Fresh interview-time seed (2026-07 pricing) ──
  // A new purchase seeds the tier's interview clock — Basic 30 min,
  // Pro 1 hour, Max 3 hours — valid until the server-set license.expires_at.
  // Called on first-time purchase, NOT on the +30-min extension.
  // Kept private because only normalizeLicenseCredits should decide when to
  // seed — direct callers would mis-overwrite an in-flight balance.
  private freshBasicCreditSeed(license: LicenseData): { credits_remaining_seconds: number; credits_expire_at: number } {
    const fallback = Date.now() + TIME_CONSTANTS.BASIC_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
    // Per-tier interview time (2026-07 pricing):
    //   Basic = one 30-min interview · Pro = one 1-hour · Max = three 1-hour.
    const seconds =
      license.tier === 'pro' ? 60 * 60 :
      license.tier === 'max' ? 3 * 60 * 60 :
      /* basic */              30 * 60;
    return {
      credits_remaining_seconds: seconds,
      credits_expire_at: license.expires_at > 0 ? license.expires_at : fallback,
    };
  }

  // ── Trial-state normalizer ──
  // Server stamps `trial_granted_at` at signup. We use that to compute
  // the remaining wall-clock seconds when there is no in-session local
  // ledger to preserve (e.g., logout → re-login on the same device).
  // Without this, the old code defaulted any login with
  // trial_remaining_seconds === undefined to a fresh trial, which let
  // a free user reset their trial by logging out and back in. With this,
  // the trial is authoritatively bounded by `trial_granted_at +
  // TRIAL_SECONDS` wall-clock, regardless of how many auth events the
  // user triggers.
  //
  // We still PREFER the in-session local ledger when present so a
  // legitimate session-tab refresh or background revalidation doesn't
  // reset what the timer already consumed.
  private normalizeTrialState(
    license: LicenseData,
    priorLicense: LicenseData | null,
    opts?: { freshSignup?: boolean },
  ): LicenseData {
    if (license.tier !== 'free') {
      // Paid tiers don't use the trial bucket — strip for cleanliness so
      // getEffectiveTier never reads a stale free-tier trial value.
      const clean: any = { ...license };
      delete clean.trial_remaining_seconds;
      return clean as LicenseData;
    }
    // Server-authoritative (2026-07): auth responses now carry the real
    // consumption-based trial balance — trust it. The trial burns only
    // while interviewing, never by wall-clock, so "signed up Monday,
    // returned Wednesday, trial gone" can't happen anymore.
    if (typeof license.trial_remaining_seconds === 'number') {
      return license;
    }
    if (
      priorLicense?.tier === 'free' &&
      typeof priorLicense.trial_remaining_seconds === 'number'
    ) {
      // Older server, in-session preserve: keep the local ledger.
      return { ...license, trial_remaining_seconds: priorLicense.trial_remaining_seconds };
    }
    // Brand-new SIGNUP against a server that echoed neither the
    // consumption balance nor a usable grant timestamp (pre-trial-ledger
    // deploy): seed the full one-time grant locally so a fresh trial user
    // never boots into the post-trial paywall (getEffectiveTier would
    // otherwise resolve 'free' → every model locked on day zero). This
    // cannot re-open the logout/login trial-farm hole — it runs ONLY on
    // the signup path (account creation), never on login/google/validate,
    // and the next successful revalidation against a current server
    // replaces it with the server-metered balance.
    if (opts?.freshSignup && !(license.trial_granted_at && license.trial_granted_at > 0)) {
      return { ...license, trial_remaining_seconds: TIME_CONSTANTS.TRIAL_SECONDS };
    }
    // Older server, fresh login: derive from the grant timestamp
    // (legacy wall-clock semantics — fail-closed).
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
  // undefined, which reads as a 0 balance — the interview clock (and the
  // send preflight) would tell a fresh purchaser their time is already
  // used up. (Features no longer collapse on a 0 balance — getEffectiveTier
  // follows the plan window — but the BALANCE itself must still be right.)
  private normalizeLicenseCredits(license: LicenseData, priorLicense: LicenseData | null): LicenseData {
    // Only the time-limited tiers carry a credit bucket. Free (trial) and
    // Ultra (unlimited) strip the fields for cleanliness.
    if (!['basic', 'pro', 'max'].includes(license.tier)) {
      const clean: any = { ...license };
      delete clean.credits_remaining_seconds;
      delete clean.credits_expire_at;
      return clean as LicenseData;
    }
    // Server-authoritative (2026-07): when the server echoes a real credit
    // balance (it meters consumption now), trust it verbatim — no local
    // preservation or re-seeding needed.
    if (
      typeof license.credits_remaining_seconds === 'number' &&
      typeof license.credits_expire_at === 'number'
    ) {
      return license;
    }
    // Carry the running balance only when the prior state is the SAME
    // time-limited tier (a Pro→Pro tab refresh keeps its clock; a tier change
    // re-seeds from the new tier's grant).
    const prior = priorLicense && priorLicense.tier === license.tier ? priorLicense : null;
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

  // Credit the plan-specific extension (top-up flow, 2026-07): Basic
  // +30 min, Pro/Max +1 hour — the tier is PRESERVED (a Pro top-up must
  // never relabel the user Basic). Free/expired tiers reactivate as Basic
  // with Basic's unit, mirroring the server's grantTimeExtension.
  //
  // Base off effective balance, NOT the raw field: if the prior credits
  // already expired (credits_expire_at < now), effective balance is 0 and
  // stale seconds should not carry over. Otherwise a user whose credits
  // expired with time unused would pay for the extension and silently get
  // the stale remainder back on top — a free partial credit.
  //
  // Anchor the new expiry from max(now, license.expires_at) + the unit,
  // mirroring the server's grantTimeExtension in database.js.
  // /create-renewal does NOT pre-bump expires_at — the payment.captured
  // webhook does — so when this runs from the success URL,
  // license.expires_at is still the pre-extension value (often already
  // past for a user who just hit the expiry wall). Using it verbatim
  // would place credits_expire_at in the past and void the time the user
  // just paid for. The next successful revalidation picks up the
  // server-bumped expires_at and reconverges.
  grantRenewalCredit(license: LicenseData, packSeconds?: number): LicenseData {
    const effectiveRemaining = this.getCreditsRemainingSeconds(license);
    const tier: 'basic' | 'pro' | 'max' =
      license.tier === 'pro' || license.tier === 'max' ? license.tier : 'basic';
    const extensionSeconds = (typeof packSeconds === 'number' && packSeconds > 0)
      ? packSeconds
      : EXTENSION_SECONDS_BY_TIER[tier];
    const extensionMs = extensionSeconds * 1000;
    const anchor = Math.max(Date.now(), license.expires_at > 0 ? license.expires_at : 0);
    const updated: LicenseData = {
      ...license,
      tier,
      credits_remaining_seconds: effectiveRemaining + extensionSeconds,
      credits_expire_at: anchor + extensionMs,
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
    // wall-clock time and never resets the trial. freshSignup additionally
    // covers a legacy server that echoes NO trial fields at all — a
    // brand-new account still gets its full local seed instead of booting
    // straight into the post-trial paywall (see normalizeTrialState).
    data.license = this.normalizeTrialState(data.license, null, { freshSignup: true });
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
    // a 0 balance, and the send preflight would wrongly report their
    // interview time as used up.
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
      // the 'basic' tier needs them or the balance reads 0 and the send
      // preflight wrongly reports the interview time as used up.
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

      // ── Server-authoritative balance merge (2026-07) ──
      // The server now meters consumption itself (usage_sessions +
      // /api/v1/usage heartbeats), so the credits/trial fields it echoes
      // ARE the truth — we take them verbatim. This replaces the old
      // "Option A" client-ledger guard that stripped these fields and the
      // fragile expires_at-delta heuristic that inferred cross-device
      // extension payments: extensions now land server-side and arrive
      // here (and on every heartbeat) as a plain bigger number.
      // is_admin is broken out — it lives on the user, not the license.
      const tierChanged = serverData.tier && serverData.tier !== license.tier;
      const { is_admin: serverIsAdmin, ...serverFields } = serverData;

      let updatedLicense: LicenseData = {
        ...license,
        ...serverFields,
        last_validated: Date.now(),
      };

      // An OLDER server (pre-usage-ledger) omits the balance fields —
      // keep the local values rather than clobbering them to undefined.
      if (typeof serverData.credits_remaining_seconds !== 'number') {
        updatedLicense.credits_remaining_seconds = license.credits_remaining_seconds;
        updatedLicense.credits_expire_at = license.credits_expire_at;
      }
      if (typeof serverData.trial_remaining_seconds !== 'number') {
        updatedLicense.trial_remaining_seconds = license.trial_remaining_seconds;
      }

      if (tierChanged) {
        // Cleanliness on tier transitions: paid tiers don't read the trial
        // bucket; free/ultra don't read the credit bucket. (With server
        // echo these are cosmetic strips, not ledger re-seeds.)
        if (updatedLicense.tier !== 'free') {
          delete (updatedLicense as any).trial_remaining_seconds;
        }
        if (!['basic', 'pro', 'max'].includes(updatedLicense.tier)) {
          delete (updatedLicense as any).credits_remaining_seconds;
          delete (updatedLicense as any).credits_expire_at;
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
      // Only write the token back when the server ACTUALLY rotated it.
      // Previously: `newToken = serverData.token || token` — if no
      // rotation, the captured-at-start `token` got written back. That
      // raced with SupportBot's invalid-token cleanup (which removes the
      // token from localStorage on tier probe) — the stale value got
      // restored and the bot kept getting 401s. saveAuth's `if (token)`
      // guard means an undefined newToken simply leaves the existing
      // localStorage value alone.
      const newToken = serverData.token ? String(serverData.token) : undefined;
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

// ── Usage summary (Settings → Usage card) ──
// Read-only mirror of GET /api/v1/usage/summary — the server computes
// used/granted from the SAME ledger the interview clock charges against
// (resolveTimeBucket + usage_sessions), so this can never disagree with
// the in-interview timer. `unlimited: true` (admin/ultra) carries no
// fraction fields; metered tiers always satisfy granted >= remaining,
// so used >= 0 and the bar caps at 100%.
export interface UsageSummary {
  unlimited: boolean;
  source: 'trial' | 'credits' | 'unlimited' | 'none';
  tier: string;
  /** Seconds left in the current plan window. Absent when unlimited. */
  remaining_seconds?: number;
  /** Total seconds seeded into the current window (purchase + top-ups). */
  granted_seconds?: number;
  /** granted - remaining, clamped >= 0. Absent when unlimited. */
  used_seconds?: number;
  /** used / granted * 100, one decimal. Absent when unlimited. */
  used_percent?: number;
  lifetime_used_seconds: number;
  session_count: number;
  credits_expire_at?: number;
}

// Fail-soft by contract: returns null on ANY failure (no auth, network
// down, non-2xx, malformed body) and never throws — this runs while real
// interviews are live, so the Usage card quietly shows nothing rather
// than ever surfacing an error.
export async function fetchUsageSummary(): Promise<UsageSummary | null> {
  try {
    const { token } = licenseService.loadAuth();
    if (!token) return null;
    const resp = await fetch(`${licenseService.getApiBase()}/api/v1/usage/summary`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    if (!data || typeof data !== 'object' || typeof (data as any).unlimited !== 'boolean') return null;
    return data as UsageSummary;
  } catch {
    return null;
  }
}
