// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DEEPGRAM KEY — fetched once, reused for its lifetime, refreshed early
//
//  Why this module exists (2026-09-05, "the mic takes 4-5 s to show ON"):
//  every mic start asked the server for a key, and the server MINTS a
//  brand-new Deepgram key on every call — p50 623 ms, p90 908 ms, max
//  1.4 s server-side in production, plus the round trip to EU-West. The
//  hook then threw the key away on stop and fetched another on every
//  reconnect: 21 mints for 7 interview starts in one week of logs.
//
//  A minted key lives two hours (DEEPGRAM_KEY_TTL_SECONDS on the server)
//  and Deepgram only checks it at the WebSocket handshake. So:
//    · keep it here, at module level, across stops and hook remounts;
//    · hand it out while it has comfortable life left;
//    · refresh it in the background before it runs out;
//    · fetch it BEFORE the user clicks (prefetchDeepgramKey on mount);
//    · drop it only when Deepgram rejects it.
//  The server caches per user too (routes/ai.js), so even the fetch that
//  does happen is usually a few milliseconds instead of a mint.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { licenseService } from './licenseService';

export interface DeepgramKeyInfo {
  key: string;
  /** Epoch ms. null = the server said this key does not expire (master-key fallback). */
  expiresAt: number | null;
}

// Refresh this long before the key expires, so a live interview never
// reconnects onto a dead key.
const REFRESH_LEAD_MS = 10 * 60 * 1000;
// Never hand out a key with less than this left — the handshake would be
// racing the expiry.
const MIN_REMAINING_MS = 3 * 60 * 1000;
// A server build that predates `expires_at` mints two-hour keys; assume the
// conservative 90 minutes so we refresh well inside the real lifetime.
const ASSUMED_LIFETIME_MS = 90 * 60 * 1000;

let cached: DeepgramKeyInfo | null = null;
let inflight: Promise<DeepgramKeyInfo> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function usable(info: DeepgramKeyInfo | null): info is DeepgramKeyInfo {
  if (!info || !info.key) return false;
  if (info.expiresAt === null) return true;
  return info.expiresAt - Date.now() > MIN_REMAINING_MS;
}

/** The cached key if it is still good — no network. */
export function peekDeepgramKey(): string | null {
  return usable(cached) ? cached.key : null;
}

/** Forget the key. Call when Deepgram refuses it (1008 / 4xxx close, or a
 *  close before any data arrived) or when the account signs out. */
export function invalidateDeepgramKey(): void {
  cached = null;
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
}

/** One network call to the key route. Errors carry the user-readable
 *  message the mic surfaces (the old aiProxyService mapping, kept verbatim). */
export async function fetchDeepgramKeyInfo(opts: { fresh?: boolean } = {}): Promise<DeepgramKeyInfo> {
  const token = licenseService.getToken();
  if (!token) throw new Error('You are not signed in. Please sign in and try again.');

  const url = `${licenseService.getApiBase()}/api/v1/ai/deepgram-key${opts.fresh ? '?fresh=1' : ''}`;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'X-App-Version': licenseService.getAppVersion() },
  });

  if (!response.ok) {
    let serverErr = '';
    let serverMsg = '';
    try {
      const body = await response.json();
      serverErr = String(body?.error || '');
      serverMsg = String(body?.message || '');
    } catch { /* response had no JSON body */ }
    console.error('[deepgram-key] HTTP', response.status, { serverErr, serverMsg });

    if (response.status === 401) {
      throw new Error('Your session has expired. Please sign out and sign back in to continue using voice mode.');
    }
    if (response.status === 403) {
      if (serverErr === 'subscription_required') {
        throw new Error(serverMsg || 'Voice mode requires an active paid subscription in your region.');
      }
      throw new Error(serverMsg || 'Voice mode is not available on this account.');
    }
    if (response.status === 503) {
      throw new Error('Voice service is temporarily unavailable. Please try again in a few seconds.');
    }
    if (response.status === 429) {
      throw new Error('Too many voice-mode start attempts. Wait a moment, then try again.');
    }
    throw new Error(serverMsg || serverErr || `Voice service error (HTTP ${response.status}). Please try again.`);
  }

  const data = await response.json();
  if (!data || typeof data.key !== 'string' || !data.key) {
    throw new Error('Voice service returned no key. Please try again.');
  }
  let expiresAt: number | null;
  if (typeof data.expires_at === 'number' && data.expires_at > 0) expiresAt = data.expires_at;
  else if (data.expires_at === null) expiresAt = null; // master-key fallback: never expires
  else expiresAt = Date.now() + ASSUMED_LIFETIME_MS;   // older server: assume the conservative lifetime
  return { key: data.key, expiresAt };
}

/** The key to open a Deepgram socket with. Cached when possible; one fetch
 *  is shared by concurrent callers. `force` skips the cache (and asks the
 *  server to skip its own) — used after Deepgram rejected the current key. */
export async function getDeepgramKeyCached(opts: { force?: boolean } = {}): Promise<string> {
  if (!opts.force && usable(cached)) return cached.key;
  if (opts.force) {
    cached = null;
    // Let a plain fetch that is already running finish, then go fresh.
    if (inflight) { try { await inflight; } catch { /* the fresh fetch below reports */ } }
  }
  if (!inflight) {
    inflight = fetchDeepgramKeyInfo({ fresh: !!opts.force })
      .then((info) => { cached = info; scheduleRefresh(info); return info; })
      .finally(() => { inflight = null; });
  }
  const info = await inflight;
  return info.key;
}

function scheduleRefresh(info: DeepgramKeyInfo): void {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  if (info.expiresAt === null) return;
  const inMs = Math.max(60 * 1000, info.expiresAt - Date.now() - REFRESH_LEAD_MS);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (!licenseService.getToken()) return; // signed out meanwhile
    getDeepgramKeyCached({ force: true }).catch((e) => {
      console.warn('[deepgram-key] background refresh failed (the next start will fetch):', e?.message || e);
    });
  }, inMs);
}

/** Fire-and-forget warm-up. Call when the interview screen mounts, so the
 *  first click never waits for a key. No-op when a good key is cached, a
 *  fetch is in flight, or nobody is signed in. */
export function prefetchDeepgramKey(): void {
  if (usable(cached) || inflight) return;
  if (!licenseService.getToken()) return;
  getDeepgramKeyCached().catch((e) => {
    console.warn('[deepgram-key] prefetch failed (will retry on mic start):', e?.message || e);
  });
}
