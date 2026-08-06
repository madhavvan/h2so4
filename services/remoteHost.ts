// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  REMOTE HOST — the desktop side of device sync.
//
//  This machine is the instrument. It publishes what it is doing so a
//  phone can mirror it, and it executes the buttons the phone presses.
//  The phone never runs inference and never captures audio; everything
//  that appears there originated here.
//
//  Deliberately dumb about the app's internals: App.tsx registers a
//  handler per command and calls publish() when something changes. That
//  keeps the socket, the reconnect logic and the idempotency bookkeeping
//  in one testable place instead of smeared through the UI.
//
//  Reconnect policy: exponential backoff with jitter, forever. A laptop
//  that closes its lid for an hour must come back and resume hosting
//  without the user doing anything — that is the whole promise.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PROTOCOL_VERSION = 1;

export type RemoteCommandType =
  | 'auto_solve' | 'send' | 'stop' | 'new_session'
  | 'switch_session' | 'set_model' | 'auto_type'
  | 'toggle_listening' | 'set_auto_send' | 'add_context_file';

export type RemoteEventType =
  | 'session_state' | 'transcript_delta' | 'message_added'
  | 'answer_start' | 'answer_tokens' | 'answer_done'
  | 'processing' | 'control_state' | 'autotype_status' | 'session_list'
  | 'model_changed' | 'session_switched' | 'error';

type CommandHandler = (payload: any, id: string) => Promise<void> | void;

interface HostOptions {
  wsUrl: string;
  token: string;
  getSessionId: () => string | null;
  isBusy: () => boolean;
  /**
   * Everything a phone needs to render the current session from nothing.
   * Published the instant we are accepted as host, because a phone that
   * connected first is otherwise looking at an empty screen until the
   * user happens to do something.
   *
   * This is also the moment the snapshot becomes the phone's baseline,
   * so the caller uses it to mark those messages as already-sent — the
   * one place where "what we sent" and "what we consider sent" can be
   * decided together instead of drifting.
   */
  getSnapshot?: () => Record<string, any>;
  /** `error` is set only when hosting stopped for a reason a reconnect
   *  cannot fix, so a status view can say "device sync is off because your
   *  session expired" instead of "reconnecting…" forever. */
  onStatus?: (s: { connected: boolean; remotes: number; error?: string }) => void;
  /**
   * Hosting is over and retrying is pointless — the token is expired,
   * revoked, or signed with a rotated secret. Separate from onStatus
   * because a status is a level and this is an edge: it fires once, and
   * the close that follows cannot overwrite it. Mirrors RemoteClient's
   * onFatal so both ends of device sync report a refused join the same way.
   */
  onFatal?: (reason: string) => void;
}

// Auto-Solve captures the screen and costs money. If the socket blips
// and the server redelivers, we must not run it twice. The server
// dedupes too — this is the second lock, because the consequence of
// getting it wrong is visible and billable.
const SEEN_MAX = 500;

export class RemoteHost {
  private ws: WebSocket | null = null;
  private opts: HostOptions;
  private handlers = new Map<RemoteCommandType, CommandHandler>();
  private seen = new Map<string, number>();
  private heartbeat: any = null;
  private retry = 0;
  private closedByUs = false;
  private connected = false;
  // Sticky so the close that follows a refused join can still name the
  // reason — the frame arrives first, the close a moment later.
  private fatalReason: string | null = null;

  constructor(opts: HostOptions) { this.opts = opts; }

  on(type: RemoteCommandType, fn: CommandHandler) { this.handlers.set(type, fn); return this; }

  start() { this.closedByUs = false; this.fatalReason = null; this.connect(); }

  stop() {
    this.closedByUs = true;
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    try { this.ws?.close(); } catch { /* already gone */ }
    this.ws = null;
    this.connected = false;
  }

  /** Publish a mirror event. Safe to call when disconnected — the phone
   *  will catch up from the log on reconnect, so dropping a live frame
   *  costs nothing. */
  publish(type: RemoteEventType, data: Record<string, any> = {}) {
    const sessionId = this.opts.getSessionId();
    if (!sessionId || !this.isOpen()) return;
    this.sendRaw({ v: PROTOCOL_VERSION, kind: 'event', type, sessionId, data });
  }

  /**
   * Live answer text for the phone, rate-limited.
   * The desktop repaints per token; pushing every one of those over a
   * cellular link is bandwidth and battery for motion no eye resolves.
   * ~12/sec still reads as typing. `force` is for the final frame, which
   * must never be dropped by the throttle.
   */
  publishTokens(full: string, force = false) {
    this.lastFull = full;
    const now = Date.now();
    if (!force && now - this.lastTokenAt < 80) return;
    this.lastTokenAt = now;
    this.publish('answer_tokens', { full });
  }
  private lastTokenAt = 0;
  private lastFull = '';

  /**
   * The answer has settled. THIS is the frame that persists, so a phone
   * that reconnects later gets the finished text — the throttled token
   * frames above are live-only and are never replayed.
   *
   * The host keeps the text itself rather than making every call site
   * carry it: the streaming loop already hands us every chunk, and
   * there are four places a stream can end (normal and error, on two
   * different paths). Threading a variable through all four is how one
   * of them ends up publishing an empty answer.
   */
  finishAnswer(id?: string) {
    const text = this.lastFull;
    this.lastFull = '';
    this.lastTokenAt = 0;
    if (!text) return;                     // aborted before any token
    this.publish('answer_done', { id, text });
  }

  /**
   * Publish the full picture: conversation tail, control surface,
   * session list. Called on connect and after a session switch — the
   * two moments when everything the phone believes could be wrong.
   *
   * Persisted, unlike the live control frames, so a phone that opens
   * tomorrow morning replays this and is immediately correct.
   */
  publishSnapshot() {
    const snap = this.opts.getSnapshot?.()
      ?? { sessionId: this.opts.getSessionId(), busy: this.opts.isBusy() };
    this.publish('session_state', snap);
  }

  /**
   * Tell the server we moved to a different conversation, now.
   *
   * The heartbeat already carries the session id, but it fires every 15
   * seconds — and the phone only learns which session to mirror from
   * the server's presence frame. Without this, starting a new session on
   * the desktop leaves the phone showing the previous conversation for
   * up to fifteen seconds, with no indication anything has changed.
   * Fifteen seconds is a very long time in the middle of an interview.
   */
  announceSession() {
    if (!this.isOpen()) return;
    this.sendRaw({ kind: 'heartbeat', busy: this.opts.isBusy(), sessionId: this.opts.getSessionId() });
  }

  private isOpen() { return this.ws?.readyState === WebSocket.OPEN; }
  private sendRaw(o: any) { try { this.ws?.send(JSON.stringify(o)); } catch { /* socket died mid-send */ } }

  private connect() {
    if (this.closedByUs) return;
    try { this.ws = new WebSocket(this.opts.wsUrl); }
    catch { return this.scheduleReconnect(); }

    this.ws.onopen = () => {
      this.sendRaw({
        kind: 'join',
        token: this.opts.token,
        role: 'host',
        sessionId: this.opts.getSessionId(),
        cursor: 0,
      });
    };

    this.ws.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }

      // The socket opened but the server refused the join: an expired JWT,
      // a rotated signing secret, or an admin force-logout. It closes
      // immediately behind this frame, so with no branch here onclose just
      // reconnects — handshake, refusal, close, repeat, about once a
      // second for as long as the app is open, and across restarts, since
      // the dead token is still in localStorage. A bad token does not fix
      // itself by being retried. Stop, and say why; signing in again
      // re-creates the host with a live token.
      if (msg.kind === 'join_error') {
        const reason = String(msg.reason || 'join_error');
        this.fatalReason = reason;
        this.connected = false;
        this.opts.onStatus?.({ connected: false, remotes: 0, error: reason });
        this.opts.onFatal?.(reason);
        this.stop();
        return;
      }

      if (msg.kind === 'joined') {
        this.connected = true;
        // The backoff resets HERE and not in onopen — a refused join opens
        // a perfectly good socket every time, so resetting on the handshake
        // pins the wait at the 1s floor no matter how long the failure
        // lasts. Only a join the server accepted counts as working.
        this.retry = 0;
        this.opts.onStatus?.({ connected: true, remotes: 0 });
        this.startHeartbeat();
        // Announce current state immediately so a phone that joined
        // first is not staring at an empty screen until the next event.
        this.publishSnapshot();
        return;
      }

      if (msg.kind === 'demoted') {
        // Another desktop took control. Stop hosting rather than fight
        // it — two hosts answering one Auto-Solve is the worst outcome.
        this.connected = false;
        this.opts.onStatus?.({ connected: false, remotes: 0 });
        this.stop();
        return;
      }

      if (msg.kind === 'command') { void this.runCommand(msg); return; }
    };

    this.ws.onclose = () => {
      this.connected = false;
      if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
      // Repeats the fatal reason when there is one. This close lands after
      // the join_error frame, so a UI holding the last status would
      // otherwise have "session expired" overwritten by an ordinary
      // disconnect and sit on "reconnecting…" for a reconnect that is
      // never coming — scheduleReconnect below is already a no-op by then.
      this.opts.onStatus?.({ connected: false, remotes: 0, error: this.fatalReason ?? undefined });
      this.scheduleReconnect();
    };
    this.ws.onerror = () => { try { this.ws?.close(); } catch { /* onclose handles it */ } };
  }

  private async runCommand(msg: any) {
    const id = String(msg.id || '');
    const type = msg.type as RemoteCommandType;

    if (this.seen.has(id)) {                       // redelivery after a blip
      this.status(id, 'rejected', 'duplicate');
      return;
    }
    this.seen.set(id, Date.now());
    if (this.seen.size > SEEN_MAX) {
      const oldest = [...this.seen.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) this.seen.delete(oldest[0]);
    }

    const fn = this.handlers.get(type);
    if (!fn) { this.status(id, 'rejected', 'unsupported'); return; }

    this.status(id, 'delivered');
    try {
      this.status(id, 'running');
      await fn(msg.payload ?? {}, id);
      this.status(id, 'done');
    } catch (e: any) {
      this.status(id, 'failed', String(e?.message || e).slice(0, 200));
    }
  }

  private status(id: string, status: string, detail: string | null = null) {
    this.sendRaw({ v: PROTOCOL_VERSION, kind: 'command_status', id, status, detail });
  }

  private startHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    // Must be well under the server's offline threshold, or a working
    // host reads as dead and the phone greys out its buttons.
    this.heartbeat = setInterval(() => {
      if (!this.isOpen()) return;
      this.sendRaw({ kind: 'heartbeat', busy: this.opts.isBusy(), sessionId: this.opts.getSessionId() });
    }, 15_000);
  }

  private scheduleReconnect() {
    if (this.closedByUs) return;
    // Jittered backoff to 15s. Without jitter, every client that dropped
    // during a server restart reconnects in the same millisecond.
    const base = Math.min(1000 * Math.pow(2, this.retry++), 15_000);
    const wait = base * (0.7 + Math.random() * 0.6);
    setTimeout(() => this.connect(), wait);
  }

  get isConnected() { return this.connected; }
}

/** Derive the ws:// URL from the API base — same host, same auth. */
export function remoteWsUrl(apiBase: string): string {
  return apiBase.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws/remote';
}
