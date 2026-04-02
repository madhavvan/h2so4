const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

let db = null;

function getDB() {
  if (db) return db;

  const dbPath = path.join(app.getPath('userData'), 'copilot.db');
  db = new Database(dbPath);

  // Performance settings
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      is_active INTEGER DEFAULT 1
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

  return db;
}

// ── Session operations ──

function getOrCreateActiveSession() {
  const d = getDB();
  let session = d.prepare('SELECT * FROM sessions WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1').get();
  if (!session) {
    const id = Date.now().toString();
    d.prepare('INSERT INTO sessions (id, name, created_at, is_active) VALUES (?, ?, ?, 1)')
      .run(id, 'Interview ' + new Date().toLocaleDateString(), Date.now());
    session = d.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  }
  return session;
}

function startNewSession(name) {
  const d = getDB();
  // Deactivate all current sessions
  d.prepare('UPDATE sessions SET is_active = 0').run();
  const id = Date.now().toString();
  d.prepare('INSERT INTO sessions (id, name, created_at, is_active) VALUES (?, ?, ?, 1)')
    .run(id, name || 'Interview ' + new Date().toLocaleDateString(), Date.now());
  return d.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

// ── Message operations ──

function getMessages(sessionId) {
  return getDB()
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC')
    .all(sessionId);
}

function addMessage(sessionId, message) {
  getDB()
    .prepare('INSERT OR REPLACE INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)')
    .run(message.id, sessionId, message.role, message.content, message.timestamp);
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
  getOrCreateActiveSession,
  startNewSession,
  getMessages,
  addMessage,
  clearMessages,
  getContextFiles,
  addContextFile,
  removeContextFile,
  clearContextFiles,
  closeDB,
};