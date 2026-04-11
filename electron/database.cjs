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

// ── Message operations ──

function getMessages(sessionId) {
  return getDB()
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC')
    .all(sessionId);
}

function addMessage(sessionId, message) {
  const d = getDB();
  d.prepare('INSERT OR REPLACE INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)')
    .run(message.id, sessionId, message.role, message.content, message.timestamp);

  // Auto-name: when the user sends their first message in a session that
  // still carries the default "Interview <date>" name, derive a name from
  // the message so the sidebar is scannable. Skip if the session has
  // already been renamed (manually or automatically).
  if (message.role === 'user' && message.content) {
    const row = d.prepare('SELECT name FROM sessions WHERE id = ?').get(sessionId);
    if (row && /^Interview\s/.test(row.name)) {
      const userMsgCount = d
        .prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND role = 'user'")
        .get(sessionId).c;
      if (userMsgCount === 1) {
        const derived = String(message.content).replace(/\s+/g, ' ').trim().slice(0, 60);
        if (derived) {
          d.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(derived, sessionId);
        }
      }
    }
  }
}

function clearMessages(sessionId) {
  getDB().prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
}

// ── Context file operations ──

function getContextFiles(sessionId) {
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

function addContextFile(sessionId, file) {
  getDB()
    .prepare('INSERT OR REPLACE INTO context_files (id, session_id, name, content, type, mime_type, base64) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(file.id, sessionId, file.name, file.content, file.type, file.mimeType || null, file.base64 || null);
}

function removeContextFile(fileId) {
  getDB().prepare('DELETE FROM context_files WHERE id = ?').run(fileId);
}

function clearContextFiles(sessionId) {
  getDB().prepare('DELETE FROM context_files WHERE session_id = ?').run(sessionId);
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
