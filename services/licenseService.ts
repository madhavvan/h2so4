// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LICENSE SERVICE — Server-validated, device-bound licensing
//
//  SECURITY MODEL:
//  - App is LOCKED until server confirms a valid license
//  - Device fingerprint is bound to the license at activation
//  - Periodic revalidation every 30 minutes
//  - No offline grace period for Pro — forces server check
//  - Free tier: 5 sessions, Gemini only, no screen capture
//  - Pro tier: unlimited, all models, all features
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface LicenseData {
  key: string;
  email: string;
  tier: 'free' | 'pro';
  status: 'active' | 'expired' | 'revoked' | 'trial';
  country_code: string;
  device_id: string;
  activated_at: number;
  expires_at: number;
  sessions_used: number;
  sessions_limit: number; // -1 for unlimited
  last_validated: number;
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
  tier: 'free' | 'pro';
  country_code: string;
  created_at: number;
  is_admin?: boolean;
  oauth_provider?: string;
}

// Feature gates — what each tier can access
export const FEATURE_GATES = {
  free: {
    models: ['gemini'] as string[],
    screenCapture: false,
    autoSolve: false,
    popout: false,
    contextFiles: 1,     // max files
    sessionsPerMonth: 5,
    exportHistory: false,
  },
  pro: {
    models: ['gemini', 'groq', 'openai', 'xai'] as string[],
    screenCapture: true,
    autoSolve: true,
    popout: true,
    contextFiles: -1,    // unlimited
    sessionsPerMonth: -1, // unlimited
    exportHistory: true,
  },
} as const;

const APP_VERSION = '2.0.0';
const MIN_VERSION = '2.0.0';
const REVALIDATION_INTERVAL = 30 * 60 * 1000; // 30 minutes

// Admin check is done server-side via ADMIN_EMAILS env var.
// Frontend only checks if user was granted 'pro' with is_admin flag from server.
const DEVELOPER_EMAILS: string[] = [];

class LicenseService {
  private readonly STORAGE_KEY = 'minicaai_license';
  private readonly AUTH_KEY = 'minicaai_auth';
  private readonly TOKEN_KEY = 'minicaai_token';
  private revalidationTimer: ReturnType<typeof setInterval> | null = null;

  // Will be set to real server URL when deployed
  private API_BASE = 'http://localhost:4000';

  constructor() {
    // Use local server in development
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      this.API_BASE = 'http://localhost:4000';
    }
  }

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
  canUseFeature(license: LicenseData | null, feature: keyof typeof FEATURE_GATES.free): boolean {
    if (!license) return false;
    const tier = license.tier === 'pro' ? 'pro' : 'free';
    const gates = FEATURE_GATES[tier];
    const value = gates[feature];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === -1 || value > 0;
    return true;
  }

  canUseModel(license: LicenseData | null, model: string): boolean {
    if (!license) return false;
    const tier = license.tier === 'pro' ? 'pro' : 'free';
    return FEATURE_GATES[tier].models.includes(model);
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
    this.stopRevalidation();
    localStorage.removeItem(this.AUTH_KEY);
    localStorage.removeItem(this.STORAGE_KEY);
    localStorage.removeItem(this.TOKEN_KEY);
  }

  getToken(): string | null {
    return localStorage.getItem(this.TOKEN_KEY);
  }

  // ── License validation ──
  isLicenseValid(license: LicenseData | null): boolean {
    if (!license) return false;
    if (license.status === 'revoked') return false;
    if (license.status === 'expired') return false;
    if (license.expires_at > 0 && Date.now() > license.expires_at) return false;
    return true;
  }

  needsRevalidation(license: LicenseData | null): boolean {
    if (!license) return true;
    // Pro users MUST revalidate with server
    if (license.tier === 'pro') {
      return Date.now() - license.last_validated > REVALIDATION_INTERVAL;
    }
    // Free users can work offline for longer
    return Date.now() - license.last_validated > (24 * 60 * 60 * 1000);
  }

  canStartSession(license: LicenseData | null): boolean {
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
        app_version: APP_VERSION,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Signup failed' }));
      throw new Error(err.error || 'Signup failed');
    }

    const data = await response.json();
    data.license.last_validated = Date.now();
    this.saveAuth(data.user, data.license, data.token);
    this.startRevalidation();
    return data;
  }

  async login(email: string, password: string): Promise<{ user: UserProfile; license: LicenseData; token: string }> {
    const deviceId = await this.getDeviceId();

    const response = await fetch(`${this.API_BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, device_id: deviceId, app_version: APP_VERSION }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Login failed' }));
      throw new Error(err.error || 'Invalid credentials');
    }

    const data = await response.json();
    data.license.last_validated = Date.now();
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
      body: JSON.stringify({ credential, device_id: deviceId, country_code: countryCode }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Google login failed' }));
      throw new Error(err.error || 'Google authentication failed');
    }

    const data = await response.json();
    if (data.license) data.license.last_validated = Date.now();
    this.saveAuth(data.user, data.license, data.token);
    this.startRevalidation();
    return data;
  }

  // Fallback local auth when server is not yet deployed
  async localSignup(email: string, password: string, name: string, countryCode: string): Promise<{ user: UserProfile; license: LicenseData }> {
    const deviceId = await this.getDeviceId();
    const isDev = this.isDeveloper(email);

    const user: UserProfile = {
      id: crypto.randomUUID(),
      email,
      name: name || email.split('@')[0],
      tier: isDev ? 'pro' : 'free',
      country_code: countryCode,
      created_at: Date.now(),
    };

    const license: LicenseData = {
      key: `MNC-${crypto.randomUUID().slice(0, 8).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`,
      email,
      tier: isDev ? 'pro' : 'free',
      status: isDev ? 'active' : 'trial',
      country_code: countryCode,
      device_id: deviceId,
      activated_at: Date.now(),
      expires_at: isDev ? -1 : Date.now() + (30 * 24 * 60 * 60 * 1000),
      sessions_used: 0,
      sessions_limit: isDev ? -1 : 5,
      last_validated: Date.now(),
    };

    this.saveAuth(user, license);
    return { user, license };
  }

  async validateWithServer(): Promise<LicenseData | null> {
    const { license, token } = this.loadAuth();
    if (!license || !token) return null;

    try {
      const response = await fetch(`${this.API_BASE}/api/v1/license/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          key: license.key,
          device_id: license.device_id,
          app_version: APP_VERSION,
        }),
      });

      if (response.status === 403) {
        // Server says license is revoked/expired — lock the app
        license.status = 'revoked';
        const user = this.loadAuth().user;
        if (user) this.saveAuth(user, license);
        return license;
      }

      if (!response.ok) {
        // Server unreachable — use cached license for free tier only
        if (license.tier === 'free') {
          return license;
        }
        // Pro users must have server validation
        return null;
      }

      const serverData = await response.json();
      const updatedLicense = { ...license, ...serverData, last_validated: Date.now() };
      const user = this.loadAuth().user;
      if (user) this.saveAuth(user, updatedLicense);
      return updatedLicense;
    } catch {
      // Network error — free tier OK offline, pro tier locked
      if (license.tier === 'free') return license;
      return null;
    }
  }

  // ── Periodic revalidation ──
  startRevalidation(): void {
    this.stopRevalidation();
    this.revalidationTimer = setInterval(async () => {
      await this.validateWithServer();
    }, REVALIDATION_INTERVAL);
  }

  stopRevalidation(): void {
    if (this.revalidationTimer) {
      clearInterval(this.revalidationTimer);
      this.revalidationTimer = null;
    }
  }

  getAppVersion(): string {
    return APP_VERSION;
  }

  getApiBase(): string {
    return this.API_BASE;
  }
}

export const licenseService = new LicenseService();
