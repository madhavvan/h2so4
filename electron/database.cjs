const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

let db = null;

function getDB() {
  if (db) return db;

  const dbPath = path.join(app.getPath('userData'), 'copilot.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      is_active INTEGER DEFAULT 1,
      user_id TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS context_files (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT,
      type TEXT NOT NULL,
      mime_type TEXT,
      base64 TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);

  // Sessions the user deleted here. Without this, anything imported from
  // the account comes straight back on the next pull — you delete a
  // conversation, it reappears, you delete it again. A tombstone is the
  // only way a local delete can outrank a server row we do not own.
  //
  // Every delete is recorded, not just imported ones: "a session you
  // deleted never comes back" is a simpler promise to keep than one with
  // conditions, and the rows are three columns of text.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dismissed_sessions (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      dismissed_at INTEGER NOT NULL,
      PRIMARY KEY (id, user_id)
    );
  `);

  // Migration: add user_id to existing sessions tables (pre-upgrade installs)
  const sessionCols = db.prepare("PRAGMA table_info(sessions)").all();
  if (!sessionCols.find(c => c.name === 'user_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN user_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_active_user ON sessions(is_active, user_id)');

  return db;
}

// ── Session operations ──

// Claim sessions with no owner (one-time migration path: existing user upgrades
// the app, signs in for the first time, and takes ownership of their pre-upgrade
// conversations). Returns the number of rows claimed so the UI can show a toast.
function claimOrphanSessions(userId) {
  if (!userId) return 0;
  const d = getDB();
  const result = d.prepare('UPDATE sessions SET user_id = ? WHERE user_id IS NULL').run(userId);
  return result.changes;
}

function getOrCreateActiveSession(userId) {
  if (!userId) throw new Error('getOrCreateActiveSession: userId is required');
  const d = getDB();
  let session = d
    .prepare('SELECT * FROM sessions WHERE is_active = 1 AND user_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(userId);
  if (!session) {
    const id = Date.now().toString();
    d.prepare('INSERT INTO sessions (id, name, created_at, is_active, user_id) VALUES (?, ?, ?, 1, ?)')
      .run(id, 'Interview ' + new Date().toLocaleDateString(), Date.now(), userId);
    session = d.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  }
  return session;
}

function startNewSession(name, userId) {
  if (!userId) throw new Error('startNewSession: userId is required');
  const d = getDB();
  d.prepare('UPDATE sessions SET is_active = 0 WHERE user_id = ?').run(userId);
  const id = Date.now().toString();
  d.prepare('INSERT INTO sessions (id, name, created_at, is_active, user_id) VALUES (?, ?, ?, 1, ?)')
    .run(id, name || 'Interview ' + new Date().toLocaleDateString(), Date.now(), userId);
  return d.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

// Called from the close/quit path when the user signals "I'm done with this
// session" (X-close with popout not in use, or tray Quit). Two behaviors based
// on whether the active session has any messages:
//
//   - Empty (0 messages) — DELETE the row entirely. The session was opened
//     but nothing was asked, so leaving an "Interview <date>" placeholder
//     would just clutter the sidebar. CASCADE handles context_files and
//     messages tables (both empty by definition for an empty session, but
//     the foreign-key CASCADE is the contract we rely on).
//   - Has messages — DEMOTE to is_active=0. Keep the conversation in history
//     (user can still click into it from the sidebar), but next launch's
//     getOrCreateActiveSession will see no active row and mint a fresh one.
//
// Result shape lets the caller log what happened. action is one of:
//   'noop'    — no active session existed
//   'deleted' — empty session was removed
//   'demoted' — non-empty session was set to is_active=0
function endActiveSession(userId) {
  if (!userId) return { ok: false, action: 'noop' };
  const d = getDB();
  const active = d
    .prepare('SELECT id FROM sessions WHERE is_active = 1 AND user_id = ?')
    .get(userId);
  if (!active) return { ok: true, action: 'noop', sessionId: null };
  const { n: msgCount } = d
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?')
    .get(active.id);
  if (msgCount === 0) {
    d.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(active.id, userId);
    return { ok: true, action: 'deleted', sessionId: active.id };
  }
  d.prepare('UPDATE sessions SET is_active = 0 WHERE id = ? AND user_id = ?').run(active.id, userId);
  return { ok: true, action: 'demoted', sessionId: active.id };
}

// List every session that belongs to this user. Returns a projection the
// sidebar can render directly — id, name, created_at, active flag, message
// count, and the first user message as a preview line.
function listSessionsForUser(userId) {
  if (!userId) return [];
  return getDB().prepare(`
    SELECT
      s.id,
      s.name,
      s.created_at,
      s.is_active,
      (SELECT COUNT(*) FROM messages WHERE session_id = s.id) AS message_count,
      (SELECT content FROM messages WHERE session_id = s.id AND role = 'user' ORDER BY timestamp ASC LIMIT 1) AS preview
    FROM sessions s
    WHERE s.user_id = ?
    ORDER BY s.created_at DESC
  `).all(userId);
}

// Switch to an existing session. Ownership-checked — you cannot target a
// session that belongs to a different user even if you know the id.
function switchToSession(sessionId, userId) {
  if (!userId || !sessionId) return null;
  const d = getDB();
  const session = d.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
  if (!session) return null;
  d.prepare('UPDATE sessions SET is_active = 0 WHERE user_id = ?').run(userId);
  d.prepare('UPDATE sessions SET is_active = 1 WHERE id = ? AND user_id = ?').run(sessionId, userId);
  return d.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
}

function renameSession(sessionId, userId, newName) {
  if (!userId || !sessionId) return false;
  const trimmed = (newName || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!trimmed) return false;
  const result = getDB()
    .prepare('UPDATE sessions SET name = ? WHERE id = ? AND user_id = ?')
    .run(trimmed, sessionId, userId);
  return result.changes > 0;
}

// Delete a session. Messages and context files cascade away via the FK.
// If the deleted session was the active one, the most recent remaining
// session becomes active; if none remain, a fresh empty session is created
// so the caller always has something to display.
function deleteSession(sessionId, userId) {
  if (!userId || !sessionId) return { ok: false };
  const d = getDB();
  const session = d.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
  if (!session) return { ok: false };

  d.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(sessionId, userId);
  // Remember the delete, so an imported session cannot walk back in on
  // the next pull from the account.
  d.prepare('INSERT OR REPLACE INTO dismissed_sessions (id, user_id, dismissed_at) VALUES (?, ?, ?)')
    .run(sessionId, userId, Date.now());

  // If the deleted row wasn't active, nothing else to do.
  if (session.is_active !== 1) {
    return { ok: true, newActiveSession: null };
  }

  // Promote the most recent remaining session to active, or mint a fresh one.
  const mostRecent = d
    .prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(userId);
  if (mostRecent) {
    d.prepare('UPDATE sessions SET is_active = 1 WHERE id = ?').run(mostRecent.id);
    return { ok: true, newActiveSession: mostRecent };
  }
  const newId = Date.now().toString();
  d.prepare('INSERT INTO sessions (id, name, created_at, is_active, user_id) VALUES (?, ?, ?, 1, ?)')
    .run(newId, 'Interview ' + new Date().toLocaleDateString(), Date.now(), userId);
  const fresh = d.prepare('SELECT * FROM sessions WHERE id = ?').get(newId);
  return { ok: true, newActiveSession: fresh };
}

// ── Ownership helpers ──
// Cheap session-ownership check used by every per-session operation that
// accepts userId from the renderer. Until v3.4.10 the message + context-
// file IPC handlers accepted only sessionId, which meant a renderer XSS
// could read or write any session by guessing IDs (they're timestamp-
// based, hence guessable). All affected paths now pass userId and we
// verify ownership at the SQL layer before touching child rows. Returns
// true if the session belongs to the user, false otherwise. A null
// userId fails closed — better to surface a "not signed in" error than
// to grant cross-user access by default.
function _ownsSession(sessionId, userId) {
  if (!sessionId || !userId) return false;
  const row = getDB()
    .prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?')
    .get(sessionId, userId);
  return !!row;
}

// ── Message operations ──

function getMessages(sessionId, userId) {
  if (!_ownsSession(sessionId, userId)) return [];
  return getDB()
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC')
    .all(sessionId);
}

function addMessage(sessionId, message, userId) {
  if (!_ownsSession(sessionId, userId)) return false;
  const d = getDB();
  d.prepare('INSERT OR REPLACE INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)')
    .run(message.id, sessionId, message.role, message.content, message.timestamp);
  return true;

  // Title generation moved to the renderer (generateConversationTitle in
  // aiProxyService.ts) which fires an LLM-backed summary after the first
  // model response and renames via db:rename-session IPC. The previous
  // "first user message → take 60 chars as the title" approach turned
  // every conversation into a verbatim slice of the opening question,
  // not a topic summary. Renderer-side titling keeps the placeholder
  // ("Interview <date>") for the brief window before the first answer
  // lands; the renderer overwrites it once it has the topic.
}

function clearMessages(sessionId, userId) {
  if (!_ownsSession(sessionId, userId)) return false;
  getDB().prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  return true;
}

// ── Context file operations ──

function getContextFiles(sessionId, userId) {
  if (!_ownsSession(sessionId, userId)) return [];
  return getDB()
    .prepare('SELECT * FROM context_files WHERE session_id = ? ORDER BY rowid ASC')
    .all(sessionId)
    .map(row => ({
      id: row.id,
      name: row.name,
      content: row.content,
      type: row.type,
      mimeType: row.mime_type,
      base64: row.base64 || undefined,
    }));
}

function addContextFile(sessionId, file, userId) {
  if (!_ownsSession(sessionId, userId)) return false;
  getDB()
    .prepare('INSERT OR REPLACE INTO context_files (id, session_id, name, content, type, mime_type, base64) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(file.id, sessionId, file.name, file.content, file.type, file.mimeType || null, file.base64 || null);
  return true;
}

function removeContextFile(fileId, userId) {
  // Resolve the file's parent session and check ownership before delete.
  // Without the join, a guessed fileId could delete any user's file.
  if (!fileId || !userId) return false;
  const d = getDB();
  const row = d.prepare(`
    SELECT cf.id
      FROM context_files cf
      JOIN sessions s ON s.id = cf.session_id
     WHERE cf.id = ? AND s.user_id = ?
  `).get(fileId, userId);
  if (!row) return false;
  d.prepare('DELETE FROM context_files WHERE id = ?').run(fileId);
  return true;
}

function clearContextFiles(sessionId, userId) {
  if (!_ownsSession(sessionId, userId)) return false;
  getDB().prepare('DELETE FROM context_files WHERE session_id = ?').run(sessionId);
  return true;
}

// ── Cleanup ──

function closeDB() {
  if (db) {
    db.close();
    db = null;
  }
}

// ── Conversations that were written somewhere else ──────────────────
//
// The phone can answer questions on its own when this machine is off.
// Those land on the account, and this is how they arrive here.
//
// Idempotent from top to bottom: the session INSERT is OR IGNORE and the
// messages are keyed by their own ids, so importing the same
// conversation twice changes nothing. That matters because the pull runs
// on every launch and there is no cursor to get wrong.
//
// Deliberately never marked active. You opened this app to interview,
// not to be dropped into yesterday's phone notes; it appears in the
// sidebar and waits to be clicked.
function importRemoteSession({ id, name, createdAt, userId, messages }) {
  if (!userId || !id) return { ok: false, reason: 'bad_args' };
  const d = getDB();

  const dismissed = d
    .prepare('SELECT 1 FROM dismissed_sessions WHERE id = ? AND user_id = ?')
    .get(id, userId);
  if (dismissed) return { ok: false, reason: 'dismissed' };

  const tx = d.transaction(() => {
    d.prepare(`
      INSERT OR IGNORE INTO sessions (id, name, created_at, is_active, user_id)
      VALUES (?, ?, ?, 0, ?)
    `).run(id, (name || 'From my phone').slice(0, 100), Number(createdAt) || Date.now(), userId);

    // Someone else's row with the same id — refuse rather than write into
    // it. Cannot normally happen (ids are per-account) but the check is
    // one line and the failure it prevents is cross-account leakage.
    const owner = d.prepare('SELECT user_id FROM sessions WHERE id = ?').get(id);
    if (!owner || owner.user_id !== userId) return 0;

    const insert = d.prepare(
      'INSERT OR IGNORE INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)'
    );
    let added = 0;
    for (const m of messages || []) {
      if (!m?.id) continue;
      const r = insert.run(
        String(m.id), id,
        m.role === 'user' || m.role === 'system' ? m.role : 'model',
        String(m.content ?? ''), Number(m.timestamp) || Date.now()
      );
      added += r.changes;
    }
    return added;
  });

  const added = tx();
  return { ok: true, added };
}

/** Which of these ids this machine already has, so the pull can skip
 *  fetching messages for conversations it is not going to import. */
function knownSessionIds(ids, userId) {
  if (!userId || !Array.isArray(ids) || !ids.length) return [];
  const d = getDB();
  const marks = ids.map(() => '?').join(',');
  const have = d.prepare(`SELECT id FROM sessions WHERE user_id = ? AND id IN (${marks})`)
    .all(userId, ...ids).map(r => r.id);
  const gone = d.prepare(`SELECT id FROM dismissed_sessions WHERE user_id = ? AND id IN (${marks})`)
    .all(userId, ...ids).map(r => r.id);
  return [...new Set([...have, ...gone])];
}

module.exports = {
  importRemoteSession,
  knownSessionIds,
  claimOrphanSessions,
  getOrCreateActiveSession,
  startNewSession,
  endActiveSession,
  listSessionsForUser,
  switchToSession,
  renameSession,
  deleteSession,
  getMessages,
  addMessage,
  clearMessages,
  getContextFiles,
  addContextFile,
  removeContextFile,
  clearContextFiles,
  closeDB,
};
