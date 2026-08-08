// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  REMOTE PROTOCOL — the contract between the desktop app (the host),
//  the server (the authority), and the phone (the remote).
//
//  THE MODEL: the computer is the instrument; the phone is its remote.
//  The phone never captures audio, never runs inference, never solves
//  anything. It shows exactly what the computer is doing, and it can
//  press the computer's buttons. Every feature the desktop has appears
//  on the phone — Auto-Solve, Send, Stop, model choice — but pressing
//  one there makes it happen HERE, on the computer.
//
//  WHY A LOG AND NOT A BROADCAST
//  "Stay in sync even if one app is closed" rules out a relay. A relay
//  only reaches devices that are currently listening; close the laptop
//  for an hour and the phone has silently missed everything, with no way
//  to know what it missed.
//
//  So the server does not forward — it RECORDS. Every change becomes an
//  event with a server-assigned sequence number, appended to a durable
//  per-session log. Devices hold a cursor (the last seq they have). On
//  connect they say "I have up to N", the server replays N+1.. and then
//  attaches the live stream.
//
//  The reconnect path and the first-connect path are the same code. A
//  phone that has been shut for a day does exactly what a phone that
//  blipped for 200ms does. That is what makes it reliable rather than
//  usually-reliable.
//
//  WHY SEQUENCES AND NOT TIMESTAMPS
//  Two devices whose clocks differ by 400ms will order messages
//  differently under any timestamp scheme, and the transcript will read
//  wrong on one of them. A single server-assigned counter cannot
//  disagree with itself. Timestamps are carried for display only and are
//  never used for ordering.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PROTOCOL_VERSION = 1;

// WebSocket path. Deliberately separate from /ws/support: different
// auth shape, different lifetime, different failure behaviour. Sharing
// one socket would couple a support-chat bug to the interview mirror.
const REMOTE_WS_PATH = '/ws/remote';

// ── Roles ────────────────────────────────────────────────────────────
// Exactly one host may be authoritative for a session at a time. If a
// second desktop claims the same session (user opened the app on a
// second machine), the newest claim wins and the older host is demoted
// to a viewer — otherwise two hosts would both answer one Auto-Solve.
const ROLE = { HOST: 'host', REMOTE: 'remote' };

// ── Mirror events: host → server → every device ──────────────────────
// The phone renders these; it never invents them.
const EVENT = {
  SESSION_STATE: 'session_state',     // full snapshot — sent once on join
  TRANSCRIPT_DELTA: 'transcript_delta',
  MESSAGE_ADDED: 'message_added',     // a committed user/assistant turn
  ANSWER_START: 'answer_start',
  ANSWER_TOKENS: 'answer_tokens',     // live only — NOT persisted, see below
  ANSWER_DONE: 'answer_done',         // the settled answer IS persisted
  PROCESSING: 'processing',           // busy/idle, drives remote button states
  CONTROL_STATE: 'control_state',     // live control surface — see below
  AUTOTYPE_STATUS: 'autotype_status', // countdown/typing/done phases
  SESSION_LIST: 'session_list',       // the desktop's conversations
  MODEL_CHANGED: 'model_changed',
  SESSION_SWITCHED: 'session_switched',
  ERROR: 'error',
};

// Token-level streaming is delivered live but NOT written to the log.
// A 700-character answer is 700 rows and a very hot write path, to
// reconstruct something the ANSWER_DONE event already carries in full.
// Live viewers watch it type; a device that reconnects mid-answer gets
// the finished text. Both end up identical, which is the only property
// that actually matters.
//
// CONTROL_STATE, AUTOTYPE_STATUS and SESSION_LIST are ephemeral for the
// same reason but a different rhythm: they describe what is true RIGHT
// NOW (mic on, model, busy, "typing in 3…"), and a device that joins
// late gets all of it inside SESSION_STATE anyway. Persisting them would
// write a row every time the user toggles the mic, to replay a truth
// that the snapshot already carries — and a replayed "typing in 3…" from
// yesterday is worse than useless, it is a lie about the present.
const EPHEMERAL_EVENTS = new Set([
  EVENT.ANSWER_TOKENS,
  EVENT.TRANSCRIPT_DELTA,
  EVENT.CONTROL_STATE,
  EVENT.AUTOTYPE_STATUS,
  EVENT.SESSION_LIST,
]);

// ── Commands: remote → server → host ─────────────────────────────────
// Intents, not state. The phone asks; the computer does it; the result
// comes back as ordinary mirror events, so there is exactly one path by
// which anything ever appears on screen.
const COMMAND = {
  AUTO_SOLVE: 'auto_solve',
  SEND: 'send',
  STOP: 'stop',
  NEW_SESSION: 'new_session',
  SWITCH_SESSION: 'switch_session',
  SET_MODEL: 'set_model',
  AUTO_TYPE: 'auto_type',
  // Turns THE COMPUTER'S microphone on and off. Read the name carefully:
  // this is a remote control for the host's capture, and it is the one
  // place someone could confuse "the phone starts listening" with "the
  // computer starts listening". It is always the computer. The phone's
  // own microphone is never opened by any code path in this product —
  // see HOST_ONLY_CAPABILITIES below.
  TOGGLE_LISTENING: 'toggle_listening',
  SET_AUTO_SEND: 'set_auto_send',
  // Hand a document the phone read to the computer, so the computer's
  // answers are grounded in it too. Carries the EXTRACTED TEXT, never the
  // file: the phone already turned the PDF into text on the handset, and
  // shipping bytes would mean a storage bucket, a retention policy and a
  // privacy surface to explain — for something the computer only needs
  // as characters anyway.
  ADD_CONTEXT_FILE: 'add_context_file',
};

// Commands the phone must never be able to issue, however the UI is
// built. Mic capture belongs to the computer, permanently — the phone
// physically cannot hear a call it is not part of, and pretending
// otherwise is how someone ends up trusting it in a live interview.
//
// These names are BLOCKED, not unimplemented. If a future UI ever asks
// for one, validateCommand rejects it with `host_only` rather than
// falling through to "unknown command" — the difference matters, because
// an unknown command reads like something we forgot to build, and this
// is something we decided never to build.
const HOST_ONLY_CAPABILITIES = new Set(['mic_capture', 'audio_device_select']);

// ── Command lifecycle ────────────────────────────────────────────────
const COMMAND_STATUS = {
  QUEUED: 'queued',       // server has it, host not yet reached
  DELIVERED: 'delivered', // host acknowledged receipt
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  EXPIRED: 'expired',     // TTL elapsed before the host took it
  REJECTED: 'rejected',   // host refused (wrong session, not permitted)
};

// A command that could not be delivered promptly must DIE, not wait.
// Tapping Auto-Solve, giving up, and closing the laptop must not fire a
// screen capture when the machine wakes twenty minutes later. Twenty
// seconds is past any plausible network hiccup and short of "I have
// moved on".
const COMMAND_TTL_MS = 20_000;

// Auto-Solve captures the screen and costs money. Redelivery after a
// reconnect must not double-fire it, so hosts keep a seen-set of command
// ids and drop repeats. This bounds that set.
const COMMAND_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const COMMAND_DEDUPE_MAX = 500;

// ── Presence ─────────────────────────────────────────────────────────
// The remote must always be able to answer "is my computer actually
// there?" — a dead button is honest, a button that silently does
// nothing is not.
const HOST_PRESENCE = { ONLINE: 'online', BUSY: 'busy', OFFLINE: 'offline' };
const HEARTBEAT_INTERVAL_MS = 15_000;
// Two missed heartbeats plus slack. Long enough to survive a phone
// switching Wi-Fi → LTE, short enough that a shut laptop shows offline
// before the user taps a button expecting it to work.
const HOST_OFFLINE_AFTER_MS = 40_000;

// Replay is bounded so a phone that has been closed for a month cannot
// ask the server to stream a year of history through a socket. Past
// this, the client is told to refetch the session normally and reset
// its cursor.
const MAX_REPLAY_EVENTS = 500;

// ── Envelopes ────────────────────────────────────────────────────────

/** Mirror event, host → devices. `seq` is assigned by the server ONLY. */
function makeEvent({ type, sessionId, data, seq = null, ts = null }) {
  return { v: PROTOCOL_VERSION, kind: 'event', type, sessionId, seq, ts, data: data ?? {} };
}

/** Command, remote → host. `id` is the idempotency key. */
function makeCommand({ id, type, sessionId, payload, issuedAt, ttlMs = COMMAND_TTL_MS }) {
  return { v: PROTOCOL_VERSION, kind: 'command', id, type, sessionId, payload: payload ?? {}, issuedAt, ttlMs };
}

/** Status of a command, server/host → the remote that issued it. */
function makeCommandStatus({ id, status, detail = null }) {
  return { v: PROTOCOL_VERSION, kind: 'command_status', id, status, detail };
}

// ── Validation ───────────────────────────────────────────────────────
// Anything arriving over a socket is untrusted, including from our own
// desktop build — an old client on a new server is the normal case
// during a staged rollout, not an exotic one.

const VALID_EVENTS = new Set(Object.values(EVENT));
const VALID_COMMANDS = new Set(Object.values(COMMAND));

function isExpired(cmd, now = Date.now()) {
  const ttl = Number.isFinite(cmd?.ttlMs) ? cmd.ttlMs : COMMAND_TTL_MS;
  const issued = Number(cmd?.issuedAt);
  if (!Number.isFinite(issued)) return true;   // undatable = untrustworthy
  return now - issued > ttl;
}

/** Returns { ok } or { ok:false, reason } — never throws on bad input. */
function validateCommand(cmd, { now = Date.now() } = {}) {
  if (!cmd || typeof cmd !== 'object') return { ok: false, reason: 'not_an_object' };
  if (cmd.kind !== 'command') return { ok: false, reason: 'wrong_kind' };
  if (cmd.v !== PROTOCOL_VERSION) return { ok: false, reason: `version_${cmd.v}` };
  if (typeof cmd.id !== 'string' || cmd.id.length < 8) return { ok: false, reason: 'bad_id' };
  // Checked BEFORE the vocabulary. These names are not missing, they are
  // forbidden, and the two answers mean opposite things: "unknown" reads
  // like something we forgot to build and invites someone to add it.
  if (HOST_ONLY_CAPABILITIES.has(cmd.type)) return { ok: false, reason: 'host_only' };
  if (!VALID_COMMANDS.has(cmd.type)) return { ok: false, reason: 'unknown_command' };
  if (typeof cmd.sessionId !== 'string' || !cmd.sessionId) return { ok: false, reason: 'bad_session' };
  if (isExpired(cmd, now)) return { ok: false, reason: 'expired' };
  return { ok: true };
}

function validateEvent(evt) {
  if (!evt || typeof evt !== 'object') return { ok: false, reason: 'not_an_object' };
  if (evt.kind !== 'event') return { ok: false, reason: 'wrong_kind' };
  if (evt.v !== PROTOCOL_VERSION) return { ok: false, reason: `version_${evt.v}` };
  if (!VALID_EVENTS.has(evt.type)) return { ok: false, reason: 'unknown_event' };
  if (typeof evt.sessionId !== 'string' || !evt.sessionId) return { ok: false, reason: 'bad_session' };
  return { ok: true };
}

function shouldPersist(eventType) {
  return VALID_EVENTS.has(eventType) && !EPHEMERAL_EVENTS.has(eventType);
}

module.exports = {
  PROTOCOL_VERSION,
  REMOTE_WS_PATH,
  ROLE,
  EVENT,
  EPHEMERAL_EVENTS,
  COMMAND,
  COMMAND_STATUS,
  COMMAND_TTL_MS,
  COMMAND_DEDUPE_WINDOW_MS,
  COMMAND_DEDUPE_MAX,
  HOST_ONLY_CAPABILITIES,
  HOST_PRESENCE,
  HEARTBEAT_INTERVAL_MS,
  HOST_OFFLINE_AFTER_MS,
  MAX_REPLAY_EVENTS,
  makeEvent,
  makeCommand,
  makeCommandStatus,
  validateCommand,
  validateEvent,
  isExpired,
  shouldPersist,
};
