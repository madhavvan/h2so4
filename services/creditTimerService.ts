// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CREDIT TIMER SERVICE — server-synced live-session clock (2026-07)
//
//  The SERVER owns the interview clock now (usage_sessions +
//  /api/v1/usage). This service:
//    · start(): opens a server session, then ticks a 1-second DISPLAY
//      countdown locally and heartbeats every 20s. Each heartbeat
//      response is authoritative — the local countdown reconciles to it,
//      so background-tab throttling can no longer freeze or leak time.
//    · stop(): settles the final seconds server-side.
//    · Balance lives on the license row server-side; localStorage is a
//      display cache, not a ledger. Clearing storage resets nothing.
//
//  FAILURE DISCIPLINE (this app runs during live interviews):
//  - A failed heartbeat NEVER interrupts the session. We keep counting
//    locally and reconcile on the next beat that gets through.
//  - If /usage/start itself fails (server down, offline), we fall back
//    to the legacy local ledger (licenseService.consumeTime) so the
//    interview still works; the next successful revalidation converges
//    state. Payload carries `synced:false` so UI can show a quiet hint.
//  - A 410 session_gone (another device/window took over, or the
//    sweeper settled a stale session) stops THIS clock without ending
//    the user's ability to restart.
//
//  EVENTS:
//  - 'started'       — session opened, { remainingSeconds, source, synced }
//  - 'tick'          — every second, { remainingSeconds, source }
//  - 'low-warning'   — T-2 minutes on total balance (fires once). This is
//                      the pre-expiry extension-prompt hook.
//  - 'exhausted'     — balance hit 0 (server-confirmed when synced)
//  - 'stopped'       — stop() was called or the session ended remotely
//  - 'hour-boundary' — LEGACY, never fires under server sync. Kept so
//                      existing App.tsx subscriptions stay type-safe.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { licenseService, TIME_CONSTANTS } from './licenseService';

type EventName = 'tick' | 'hour-boundary' | 'low-warning' | 'exhausted' | 'stopped' | 'started';
type Listener = (payload: any) => void;

const HEARTBEAT_EVERY_MS = 20 * 1000;
// T-2min — mid-interview extension prompt window. Owner spec (2026-07):
// warn "a min or 2 before" expiry. Sourced from TIME_CONSTANTS so this
// stays reconciled with licenseService (both were drifting: 300 here vs
// 120 there — 120 wins per the owner).
const LOW_WARNING_SECONDS = TIME_CONSTANTS.LOW_WARNING_SECONDS;

class CreditTimerService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = 0;
  private lastBeatAt = 0;
  private listeners = new Map<EventName, Set<Listener>>();
  private lowWarningFired = false;
  // Server session state. sessionId null while in legacy-local fallback.
  private sessionId: string | null = null;
  private synced = false;
  // Local display balance in seconds. Authoritative only in legacy mode;
  // under server sync it's reconciled to every heartbeat response.
  private displaySeconds = 0;
  private source: 'trial' | 'credits' | 'unlimited' | 'none' = 'none';
  private beatInFlight = false;
  // Generation counter: stop() (or a newer start()) bumps it, so an
  // in-flight async start() that awakes after being superseded discards
  // itself instead of resurrecting a clock the caller already stopped.
  private startGen = 0;

  on(event: EventName, cb: Listener): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
    return () => { this.listeners.get(event)?.delete(cb); };
  }

  private emit(event: EventName, payload?: any): void {
    this.listeners.get(event)?.forEach(cb => {
      try { cb(payload); } catch (e) { console.warn('[creditTimer] listener threw:', e); }
    });
  }

  isActive(): boolean {
    return this.intervalId !== null;
  }

  // Legacy API kept for App.tsx compatibility — hour boundaries no longer
  // pause the clock under server sync (session count is gated separately
  // by /license/session; time is gated by the server ledger).
  isAwaitingAck(): boolean { return false; }
  acknowledgeHourBoundary(_decision: 'continue' | 'stop'): void { /* legacy no-op */ }

  getRemainingSeconds(): number {
    if (this.isActive()) return this.displaySeconds;
    const { license } = licenseService.loadAuth();
    return licenseService.getLiveTimeBalance(license).seconds;
  }

  getSource(): 'trial' | 'credits' | 'unlimited' | 'none' {
    if (this.isActive()) return this.source;
    const { license } = licenseService.loadAuth();
    return licenseService.getLiveTimeBalance(license).source;
  }

  isSynced(): boolean { return this.synced; }
  getSessionId(): string | null { return this.sessionId; }

  // Starts the clock. Opens a server session; falls back to the legacy
  // local ledger if the server can't be reached. If balance is 0, fires
  // 'exhausted' and no-ops. Unlimited tiers get a session (analytics +
  // supersede semantics) but no countdown.
  async start(): Promise<void> {
    if (this.intervalId) return;
    const gen = ++this.startGen;
    const { license, token } = licenseService.loadAuth();
    if (!license) return;

    const localBal = licenseService.getLiveTimeBalance(license);
    this.lowWarningFired = false;
    this.sessionId = null;
    this.synced = false;

    // ── Try to open the server session ──
    if (token) {
      try {
        const resp = await fetch(`${licenseService.getApiBase()}/api/v1/usage/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ device_id: await licenseService.getDeviceId() }),
        });
        if (gen !== this.startGen) {
          // stop() (or a newer start) ran while we awaited — abandon, and
          // settle the just-created session if the server opened one.
          if (resp.ok) {
            const data = await resp.json().catch(() => null);
            if (data?.session_id) void this.settleStop(data.session_id);
          }
          return;
        }
        if (resp.status === 402) {
          // Server says: no time left. Authoritative — mirror locally so
          // the paywall UI agrees with the server.
          this.mirrorBalanceToLicense(0);
          this.emit('exhausted', { source: localBal.source });
          return;
        }
        if (resp.ok) {
          const data = await resp.json();
          this.sessionId = data.session_id;
          this.synced = true;
          this.source = data.source;
          this.displaySeconds = data.remaining === -1 ? Infinity : data.remaining;
          this.mirrorBalanceToLicense(data.remaining);
        }
      } catch { /* offline / server down — legacy fallback below */ }
    }

    // ── Legacy fallback (no server session) ──
    if (!this.synced) {
      if (localBal.source === 'unlimited') return; // nothing to count
      if (localBal.seconds <= 0) {
        this.emit('exhausted', { source: localBal.source });
        return;
      }
      this.source = localBal.source;
      this.displaySeconds = localBal.seconds;
    }

    if (this.source === 'unlimited') {
      // Session open for supersede/analytics, but no countdown to run.
      this.emit('started', { remainingSeconds: Infinity, source: 'unlimited', synced: this.synced });
      return;
    }

    this.lastTickAt = Date.now();
    this.lastBeatAt = Date.now();
    this.intervalId = setInterval(() => this.tick(), 1000);
    this.emit('started', { remainingSeconds: this.displaySeconds, source: this.source, synced: this.synced });
  }

  stop(): void {
    this.startGen++; // invalidate any in-flight async start()
    const hadInterval = !!this.intervalId;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    // Settle the server session (also for unlimited sessions, which have
    // no interval). Fire-and-forget with one retry — a lost stop is
    // settled by the server's stale sweeper at the last heartbeat anyway.
    const sid = this.sessionId;
    this.sessionId = null;
    if (sid) this.settleStop(sid);
    if (hadInterval || sid) this.emit('stopped');
  }

  private async settleStop(sessionId: string): Promise<void> {
    const { token } = licenseService.loadAuth();
    if (!token) return;
    const call = () => fetch(`${licenseService.getApiBase()}/api/v1/usage/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ session_id: sessionId }),
    });
    try {
      const r = await call();
      if (r.ok) {
        const data = await r.json().catch(() => null);
        if (data && typeof data.remaining === 'number') this.mirrorBalanceToLicense(data.remaining);
      }
    } catch {
      try { await call(); } catch { /* sweeper settles it */ }
    }
  }

  // Mirror the server's authoritative balance into the cached license so
  // every consumer of licenseService (tier gates, paywalls, Billing Hub)
  // sees the same number without a second fetch. -1 = unlimited: skip.
  private mirrorBalanceToLicense(remaining: number): void {
    if (remaining === -1) return;
    const { user, license } = licenseService.loadAuth();
    if (!user || !license) return;
    const updated = { ...license } as any;
    if (['basic', 'pro', 'max'].includes(license.tier)) {
      updated.credits_remaining_seconds = remaining;
    } else if (license.tier === 'free') {
      updated.trial_remaining_seconds = remaining;
    }
    licenseService.saveAuth(user, updated);
  }

  private tick(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastTickAt) / 1000;
    this.lastTickAt = now;
    if (elapsedSec <= 0) return;

    if (this.synced) {
      // Display countdown between beats; server reconciles on each beat.
      this.displaySeconds = Math.max(0, this.displaySeconds - elapsedSec);
    } else {
      // Legacy local ledger — persist consumption like the old model.
      const { license } = licenseService.loadAuth();
      if (!license) { this.stop(); return; }
      const updated = licenseService.consumeTime(license, elapsedSec);
      this.displaySeconds = licenseService.getLiveTimeBalance(updated).seconds;
    }

    // Heartbeat on cadence (synced mode only).
    if (this.synced && !this.beatInFlight && now - this.lastBeatAt >= HEARTBEAT_EVERY_MS) {
      this.lastBeatAt = now;
      void this.heartbeat();
    }

    if (
      !this.lowWarningFired &&
      this.displaySeconds > 0 &&
      this.displaySeconds <= LOW_WARNING_SECONDS
    ) {
      this.lowWarningFired = true;
      this.emit('low-warning', { remainingSeconds: this.displaySeconds, source: this.source });
    }

    if (this.displaySeconds <= 0) {
      if (this.synced) {
        // Don't kill the interview on the local estimate alone — confirm
        // with the server first, and let the beat handler stop us if the
        // server agrees. Rate-limit to ~1 confirm/5s so a display stuck at
        // zero (server still says positive, or heartbeats 401ing) doesn't
        // fire a beat on every single tick.
        if (!this.beatInFlight && now - this.lastBeatAt >= 5000) {
          this.lastBeatAt = now;
          void this.heartbeat();
        }
        return;
      }
      this.stop();
      this.emit('exhausted', { source: this.source });
      return;
    }

    this.emit('tick', { remainingSeconds: this.displaySeconds, source: this.source });
  }

  private async heartbeat(): Promise<void> {
    if (!this.sessionId) return;
    this.beatInFlight = true;
    try {
      const { token } = licenseService.loadAuth();
      if (!token) return;
      const resp = await fetch(`${licenseService.getApiBase()}/api/v1/usage/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ session_id: this.sessionId }),
      });
      if (resp.status === 410) {
        // Superseded (other device/window) or settled stale. Stop this
        // clock; the interview surface decides whether to restart.
        this.sessionId = null;
        this.stopLocalOnly();
        this.emit('stopped');
        return;
      }
      if (!resp.ok) return; // transient — keep counting locally, retry next beat
      const data = await resp.json();
      if (typeof data.remaining === 'number' && data.remaining !== -1) {
        this.displaySeconds = data.remaining; // authoritative reconcile
        this.mirrorBalanceToLicense(data.remaining);
      }
      if (data.exhausted) {
        const src = this.source;
        this.sessionId = null; // server already closed the session
        this.stopLocalOnly();
        this.emit('stopped');
        this.emit('exhausted', { source: src });
      }
    } catch {
      // Offline blip — the local countdown carries the UI; next beat syncs.
    } finally {
      this.beatInFlight = false;
    }
  }

  private stopLocalOnly(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

export const creditTimerService = new CreditTimerService();
// Re-export for callers that referenced the constant through this module.
export { TIME_CONSTANTS };
