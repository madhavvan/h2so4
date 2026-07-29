// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  REMOTE SESSION STORE — the durable log behind device sync.
//
//  This is the reason a phone that has been closed all day can catch up
//  exactly. The server does not forward events; it appends them, each
//  under a sequence number it alone assigns. A device holds a cursor and
//  asks for everything after it.
//
//  Sequence assignment is per-session and happens inside a transaction:
//  two devices writing at the same instant must not receive the same
//  number, or their two events collapse into one on every client that
//  replays. better-sqlite3 is synchronous, so the read-max/insert pair
//  inside db.transaction() is genuinely atomic — there is no await
//  between them for another write to slip through.
//
//  The table is created here rather than in database.js's init block so
//  that adding sync cannot break account creation on boot.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const { getDB } = require('../database');
const { MAX_REPLAY_EVENTS, shouldPersist } = require('./remoteProtocol');

// Keep the log bounded. A session is one interview; far past this and
// the client should refetch the conversation normally rather than
// replay. Pruning is per-session and only runs when a session crosses
// the cap, so it is not a periodic sweep over the whole table.
const MAX_EVENTS_PER_SESSION = 2_000;

let ready = false;

function ensureTable() {
  if (ready) return;
  const db = getDB();
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL,
      session_id TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      type       TEXT NOT NULL,
      data       TEXT NOT NULL,
      ts         INTEGER NOT NULL
    );
    -- The uniqueness guarantee the whole design rests on: one seq per
    -- session, enforced by the database rather than by our care.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_events_session_seq
      ON remote_events(user_id, session_id, seq);
    -- Replay is always "this session, after this cursor, in order".
    CREATE INDEX IF NOT EXISTS idx_remote_events_replay
      ON remote_events(user_id, session_id, seq ASC);
  `);
  ready = true;
}

/**
 * Append an event and return it with its assigned seq.
 * Ephemeral types (token streams) are rejected — they are delivered
 * live and never stored; see remoteProtocol.
 */
function append(userId, sessionId, type, data = {}) {
  if (!userId || !sessionId) throw new Error('append requires userId and sessionId');
  if (!shouldPersist(type)) return null;
  ensureTable();
  const db = getDB();
  const ts = Date.now();
  const payload = JSON.stringify(data ?? {});

  const tx = db.transaction(() => {
    const row = db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM remote_events WHERE user_id = ? AND session_id = ?'
    ).get(userId, sessionId);
    const seq = (row?.maxSeq || 0) + 1;
    db.prepare(
      'INSERT INTO remote_events (user_id, session_id, seq, type, data, ts) VALUES (?,?,?,?,?,?)'
    ).run(userId, sessionId, seq, type, payload, ts);
    return seq;
  });

  const seq = tx();
  if (seq % 250 === 0) pruneSession(userId, sessionId);
  return { type, sessionId, seq, ts, data };
}

/**
 * Everything after `afterSeq`, oldest first.
 * `truncated` tells the caller the cursor was too far behind to replay,
 * so the client can refetch instead of silently receiving a hole.
 */
function replay(userId, sessionId, afterSeq = 0, limit = MAX_REPLAY_EVENTS) {
  ensureTable();
  const db = getDB();
  const cap = Math.max(1, Math.min(limit, MAX_REPLAY_EVENTS));
  const rows = db.prepare(
    `SELECT seq, type, data, ts FROM remote_events
      WHERE user_id = ? AND session_id = ? AND seq > ?
      ORDER BY seq ASC LIMIT ?`
  ).all(userId, sessionId, Number(afterSeq) || 0, cap + 1);

  const truncated = rows.length > cap;
  const use = truncated ? rows.slice(0, cap) : rows;
  return {
    truncated,
    events: use.map(r => ({
      seq: r.seq,
      type: r.type,
      sessionId,
      ts: r.ts,
      data: safeParse(r.data),
    })),
  };
}

function latestSeq(userId, sessionId) {
  ensureTable();
  const row = getDB().prepare(
    'SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM remote_events WHERE user_id = ? AND session_id = ?'
  ).get(userId, sessionId);
  return row?.maxSeq || 0;
}

/** Drop the oldest events for one session once it exceeds the cap. */
function pruneSession(userId, sessionId) {
  ensureTable();
  const db = getDB();
  const { n } = db.prepare(
    'SELECT COUNT(*) AS n FROM remote_events WHERE user_id = ? AND session_id = ?'
  ).get(userId, sessionId);
  if (n <= MAX_EVENTS_PER_SESSION) return 0;
  const excess = n - MAX_EVENTS_PER_SESSION;
  const info = db.prepare(
    `DELETE FROM remote_events WHERE id IN (
       SELECT id FROM remote_events WHERE user_id = ? AND session_id = ?
       ORDER BY seq ASC LIMIT ?)`
  ).run(userId, sessionId, excess);
  return info.changes;
}

/** Used when a user deletes a conversation — the log must go with it. */
function purgeSession(userId, sessionId) {
  ensureTable();
  return getDB().prepare(
    'DELETE FROM remote_events WHERE user_id = ? AND session_id = ?'
  ).run(userId, sessionId).changes;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

module.exports = {
  append, replay, latestSeq, pruneSession, purgeSession,
  MAX_EVENTS_PER_SESSION,
  _ensureTable: ensureTable,
};
