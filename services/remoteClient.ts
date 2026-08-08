// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  REMOTE CLIENT — the phone side of device sync.
//
//  Mirrors the computer's session and sends button presses back to it.
//  It renders only what the host published; it never invents a message,
//  never transcribes, never calls a model. If the computer is closed,
//  this shows that plainly rather than offering buttons that quietly do
//  nothing.
//
//  THE CURSOR IS THE WHOLE TRICK. Every persisted event carries a
//  server-assigned seq. We keep the highest one we have seen and hand it
//  back on every reconnect, so the server replays exactly what we missed
//  — whether we were gone for 200ms or since yesterday.
//
//  ⚠️  THIS FILE IS MIRRORED, BYTE FOR BYTE, into the phone app at
//  interview-copilot-mobile/src/remote/RemoteClient.ts. The two projects
//  deploy separately (Railway and Vercel) and share no build, so a
//  workspace package is not available to them; the copy is guarded
//  instead — `remote-client-parity.test.js` fails this suite the moment
//  the two files differ. Edit here, copy there, run the tests.
//
//  It is deliberately dependency-free for the same reason: it has to
//  drop unchanged into an Electron renderer, a Vite PWA, or a React
//  Native bundle.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PROTOCOL_VERSION = 1;

export type Presence = 'online' | 'busy' | 'offline';
export type CommandStatus =
  | 'queued' | 'delivered' | 'running' | 'done'
  | 'failed' | 'expired' | 'rejected';

export interface MirrorEvent {
  v?: number;
  type: string;
  sessionId: string;
  seq: number | null;
  ts: number;
  data: any;
}

interface ClientOptions {
  wsUrl: string;
  token: string;
  sessionId: string;
  /** Replayed history on (re)connect. `truncated` means we were too far
   *  behind to replay — refetch the conversation rather than assume the
   *  list is continuous. */
  onSync: (events: MirrorEvent[], info: { truncated: boolean; cursor: number }) => void;
  onEvent: (e: MirrorEvent) => void;
  onPresence: (p: Presence) => void;
  onCommandStatus?: (id: string, status: CommandStatus, detail?: string | null) => void;
  onFatal?: (reason: string) => void;
  /** The connection came up. Lets the UI clear "reconnecting…" the
   *  instant it stops being true, rather than on the next event. */
  onConnected?: () => void;
  /** The computer is on a different conversation than the one we joined.
   *  A phone cannot know the session id before it connects, so it
   *  guesses, is corrected here, and re-joins. */
  onHostSession?: (sessionId: string) => void;
}

export class RemoteClient {
  private ws: WebSocket | null = null;
  private opts: ClientOptions;
  private cursor = 0;
  private retry = 0;
  private closedByUs = false;
  private presence: Presence = 'offline';

  constructor(opts: ClientOptions) { this.opts = opts; }

  start() { this.closedByUs = false; this.connect(); }
  stop() {
    this.closedByUs = true;
    try { this.ws?.close(); } catch { /* already gone */ }
    this.ws = null;
    this.setPresence('offline');
  }

  get hostPresence() { return this.presence; }
  /** A button should be pressable only when the computer can act on it. */
  get canControl() { return this.presence === 'online' || this.presence === 'busy'; }

  /** Follow the computer onto a different conversation. The cursor is
   *  per-session, so it resets — carrying one over would make the server
   *  skip the new session's history as "already seen". */
  setSession(sessionId: string) {
    if (!sessionId || sessionId === this.opts.sessionId) return;
    this.opts.sessionId = sessionId;
    this.cursor = 0;
    try { this.ws?.close(); } catch { /* the reconnect re-joins */ }
  }

  /**
   * Press one of the computer's buttons. Returns the command id so the
   * UI can follow its status. Refuses locally when the host is offline
   * so the user gets an answer instantly instead of a silent tap.
   */
  send(type: string, payload: Record<string, any> = {}): string | null {
    if (!this.canControl || this.ws?.readyState !== WebSocket.OPEN) {
      this.opts.onCommandStatus?.(`local-${Date.now()}`, 'failed', 'host_offline');
      return null;
    }
    const id = newCommandId();
    this.raw({
      v: PROTOCOL_VERSION, kind: 'command', id, type,
      sessionId: this.opts.sessionId, payload,
      issuedAt: Date.now(), ttlMs: 20_000,
    });
    return id;
  }

  private raw(o: any) { try { this.ws?.send(JSON.stringify(o)); } catch { /* socket died mid-send */ } }

  /** Ignores null (host offline) so a laptop closing does not drag the
   *  phone off the session it is happily showing. */
  private adoptHostSession(id: unknown) {
    if (typeof id !== 'string' || !id || id === this.opts.sessionId) return;
    this.opts.onHostSession?.(id);
    this.setSession(id);
  }

  private setPresence(p: Presence) {
    if (p === this.presence) return;
    this.presence = p;
    this.opts.onPresence(p);
  }

  private connect() {
    if (this.closedByUs) return;
    try { this.ws = new WebSocket(this.opts.wsUrl); }
    catch { return this.scheduleReconnect(); }

    this.ws.onopen = () => {
      this.retry = 0;
      this.raw({
        kind: 'join',
        token: this.opts.token,
        role: 'remote',
        sessionId: this.opts.sessionId,
        cursor: this.cursor,          // "I have up to here — send the rest"
      });
    };

    this.ws.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }

      switch (msg.kind) {
        case 'join_error':
          this.closedByUs = true;                 // a bad token will not fix itself
          this.opts.onFatal?.(msg.reason || 'join_error');
          return;

        case 'joined': {
          const events: MirrorEvent[] = msg.replay || [];
          for (const e of events) if (typeof e.seq === 'number' && e.seq > this.cursor) this.cursor = e.seq;
          if (typeof msg.cursor === 'number' && msg.cursor > this.cursor) this.cursor = msg.cursor;
          this.setPresence(msg.presence || 'offline');
          this.opts.onConnected?.();
          this.opts.onSync(events, { truncated: !!msg.truncated, cursor: this.cursor });
          this.adoptHostSession(msg.hostSessionId);
          return;
        }

        case 'evicted':
          this.closedByUs = true;
          this.opts.onFatal?.('too_many_devices');
          return;

        case 'presence':
          this.setPresence(msg.presence || 'offline');
          this.adoptHostSession(msg.sessionId);
          return;

        case 'command_status':
          this.opts.onCommandStatus?.(msg.id, msg.status, msg.detail);
          return;

        case 'event': {
          // A desktop newer than this app speaks a protocol we do not
          // know. Applying the parts we recognise and dropping the rest
          // is how a mirror ends up quietly wrong — which is worse than
          // being visibly broken. Stop, and say so.
          if (typeof msg.v === 'number' && msg.v !== PROTOCOL_VERSION) {
            this.closedByUs = true;
            try { this.ws?.close(); } catch { /* already going */ }
            this.opts.onFatal?.('version_mismatch');
            return;
          }
          // Live token frames carry seq:null and are not replayable —
          // only advance the cursor on persisted events, or a reconnect
          // would skip real history.
          if (typeof msg.seq === 'number') {
            if (msg.seq <= this.cursor) return;    // already have it
            this.cursor = msg.seq;
          }
          this.opts.onEvent(msg as MirrorEvent);
          return;
        }
      }
    };

    this.ws.onclose = () => { this.setPresence('offline'); this.scheduleReconnect(); };
    this.ws.onerror = () => { try { this.ws?.close(); } catch { /* onclose handles it */ } };
  }

  private scheduleReconnect() {
    if (this.closedByUs) return;
    const base = Math.min(1000 * Math.pow(2, this.retry++), 15_000);
    const wait = base * (0.7 + Math.random() * 0.6);
    setTimeout(() => this.connect(), wait);
  }
}

function newCommandId(): string {
  try {
    const c: any = globalThis.crypto;
    if (c?.randomUUID) return `cmd-${c.randomUUID()}`;
  } catch { /* fall through */ }
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function remoteWsUrl(apiBase: string): string {
  return apiBase.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws/remote';
}
