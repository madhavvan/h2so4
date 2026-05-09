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

module.exports = {
  claimOrphanSessions,
  getOrCreateActiveSession,
  startNewSession,
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
