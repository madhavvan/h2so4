// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CREDIT TIMER SERVICE — live-session time tracker for Basic tier
//  + Free 30-minute trial. Pro/Max = no-op (unlimited).
//
//  Ticks once per second while `start()` is running. Each tick deducts
//  elapsed real-time (handles tab throttling) from the appropriate bucket
//  via licenseService.consumeTime() — which persists to localStorage so
//  a crash loses at most 1 second.
//
//  EVENTS:
//  - 'started'         — session timer began
//  - 'tick'            — every second, { remainingSeconds, source }
//  - 'hour-boundary'   — 60 min of continuous consumption AND balance > 0
//                        (i.e. about to dip into the next credit). Timer
//                        PAUSES until UI calls acknowledgeHourBoundary().
//  - 'low-warning'     — 120s of TOTAL balance remaining (fires once)
//  - 'exhausted'       — balance hit 0 (timer auto-stops)
//  - 'stopped'         — stop() was called
//
//  NOTE: server-side sync and anti-abuse validation are deferred (Option A).
//  A determined user can reset credits by clearing localStorage today.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { licenseService, TIME_CONSTANTS } from './licenseService';

type EventName = 'tick' | 'hour-boundary' | 'low-warning' | 'exhausted' | 'stopped' | 'started';
type Listener = (payload: any) => void;

class CreditTimerService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = 0;
  private listeners = new Map<EventName, Set<Listener>>();
  // Seconds consumed since the last hour-boundary ack (or session start).
  // Triggers the boundary prompt when it crosses SECONDS_PER_CREDIT.
  private secondsSinceLastBoundary = 0;
  private lowWarningFired = false;
  // While true, ticks don't consume. Set when hour-boundary fires; cleared by ack.
  private awaitingAck = false;

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

  isAwaitingAck(): boolean {
    return this.awaitingAck;
  }

  getRemainingSeconds(): number {
    const { license } = licenseService.loadAuth();
    return licenseService.getLiveTimeBalance(license).seconds;
  }

  getSource(): 'trial' | 'credits' | 'unlimited' | 'none' {
    const { license } = licenseService.loadAuth();
    return licenseService.getLiveTimeBalance(license).source;
  }

  // Starts ticking. If balance is 0, fires exhausted and no-ops.
  // If Pro/Max (unlimited) or no license, silently no-ops.
  start(): void {
    if (this.intervalId) return;
    const { license } = licenseService.loadAuth();
    if (!license) return;
    const balance = licenseService.getLiveTimeBalance(license);
    if (balance.source === 'unlimited') return;
    if (balance.seconds <= 0) {
      this.emit('exhausted', { source: balance.source });
      return;
    }
    this.secondsSinceLastBoundary = 0;
    this.lowWarningFired = false;
    this.awaitingAck = false;
    this.lastTickAt = Date.now();
    this.intervalId = setInterval(() => this.tick(), 1000);
    this.emit('started', { remainingSeconds: balance.seconds, source: balance.source });
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.awaitingAck = false;
      this.emit('stopped');
    }
  }

  // Call after the hour-boundary modal resolves.
  // 'continue' → resume ticking. 'stop' → halt session, preserve balance.
  acknowledgeHourBoundary(decision: 'continue' | 'stop'): void {
    if (!this.awaitingAck) return;
    this.awaitingAck = false;
    if (decision === 'stop') {
      this.stop();
    } else {
      this.secondsSinceLastBoundary = 0;
      this.lastTickAt = Date.now();
    }
  }

  private tick(): void {
    if (this.awaitingAck) return;
    const now = Date.now();
    const elapsedSec = (now - this.lastTickAt) / 1000;
    this.lastTickAt = now;
    if (elapsedSec <= 0) return;

    const { license, user } = licenseService.loadAuth();
    if (!license || !user) { this.stop(); return; }

    const before = licenseService.getLiveTimeBalance(license);
    if (before.source === 'unlimited') { this.stop(); return; }
    if (before.seconds <= 0) {
      this.stop();
      this.emit('exhausted', { source: before.source });
      return;
    }

    // Deduct via licenseService (persists to localStorage).
    const updated = licenseService.consumeTime(license, elapsedSec);
    const after = licenseService.getLiveTimeBalance(updated);
    this.secondsSinceLastBoundary += elapsedSec;

    // ── Hour-boundary: 60 min of continuous consumption AND balance still positive ──
    // Only fires for Basic credits — trial users (Free) max 30 min so never cross.
    if (
      after.source === 'credits' &&
      this.secondsSinceLastBoundary >= TIME_CONSTANTS.SECONDS_PER_CREDIT &&
      after.seconds > 0
    ) {
      this.awaitingAck = true;
      this.emit('hour-boundary', { remainingSeconds: after.seconds, source: after.source });
      return;
    }

    // ── Low-warning: 2 minutes left on TOTAL balance (fires once per session) ──
    if (
      !this.lowWarningFired &&
      after.seconds > 0 &&
      after.seconds <= TIME_CONSTANTS.LOW_WARNING_SECONDS
    ) {
      this.lowWarningFired = true;
      this.emit('low-warning', { remainingSeconds: after.seconds, source: after.source });
    }

    // ── Exhausted ──
    if (after.seconds <= 0) {
      this.stop();
      this.emit('exhausted', { source: after.source });
      return;
    }

    this.emit('tick', { remainingSeconds: after.seconds, source: after.source });
  }
}

export const creditTimerService = new CreditTimerService();
