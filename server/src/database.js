// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DATABASE — SQLite user store with full CRUD
//  Tracks: users, licenses, devices, sessions, payments
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

let db = null;

function getDB() {
  if (db) return db;

  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'minicaai.db');

  if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_PATH) {
    console.warn('━'.repeat(70));
    console.warn('⚠  DATABASE_PATH is not set. SQLite will write to the container');
    console.warn('   filesystem, which is EPHEMERAL on Railway. All users, licenses,');
    console.warn('   and conversations will be LOST on every restart/redeploy.');
    console.warn('   Fix: attach a Railway Volume and set DATABASE_PATH=/data/minicaai.db');
    console.warn('━'.repeat(70));
  }
  console.log(`[db] Using SQLite at: ${dbPath}`);

  // Ensure data directory exists
  const fs = require('fs');
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ── Create all tables ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT,
      tier TEXT NOT NULL DEFAULT 'free',
      country_code TEXT NOT NULL DEFAULT 'US',
      stripe_customer_id TEXT,
      google_id TEXT UNIQUE,
      oauth_provider TEXT,
      avatar_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_login_at INTEGER,
      is_banned INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'free',
      status TEXT NOT NULL DEFAULT 'trial',
      country_code TEXT NOT NULL DEFAULT 'US',
      activated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      sessions_used INTEGER DEFAULT 0,
      sessions_limit INTEGER DEFAULT 5,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      is_active INTEGER DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, device_id)
    );

    CREATE TABLE IF NOT EXISTS login_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      email TEXT NOT NULL,
      ip_address TEXT,
      device_id TEXT,
      country_code TEXT,
      success INTEGER NOT NULL,
      error_reason TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS revoked_keys (
      key TEXT PRIMARY KEY,
      revoked_by TEXT NOT NULL,
      reason TEXT,
      revoked_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      is_active INTEGER DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_payment_id TEXT,
      provider_subscription_id TEXT,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL,
      tier_granted TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Index for fast lookups
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_licenses_user ON licenses(user_id);
    CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(key);
    CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
    CREATE INDEX IF NOT EXISTS idx_login_logs_user ON login_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_login_logs_created ON login_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_messages_conv ON conversation_messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);
  `);

  // Set default app config
  const setDefault = db.prepare('INSERT OR IGNORE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)');
  setDefault.run('min_app_version', '2.0.0', Date.now());
  setDefault.run('latest_app_version', '2.0.0', Date.now());
  setDefault.run('max_devices_free', '2', Date.now());
  setDefault.run('max_devices_pro', '3', Date.now());

  return db;
}

// ── Password hashing ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = storedHash.split(':');
  const testHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return hash === testHash;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━
//  USER OPERATIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━

function createUser({ id, email, name, password, tier, country_code, google_id, oauth_provider, avatar_url }) {
  const d = getDB();
  const now = Date.now();
  const passwordHash = password ? hashPassword(password) : null;

  d.prepare(`
    INSERT INTO users (id, email, name, password_hash, tier, country_code, google_id, oauth_provider, avatar_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, email.toLowerCase(), name, passwordHash, tier, country_code, google_id || null, oauth_provider || null, avatar_url || null, now, now);

  return getUserByEmail(email);
}

function getUserByGoogleId(googleId) {
  const d = getDB();
  return d.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId) || null;
}

function linkGoogleAccount(userId, googleId, avatarUrl) {
  const d = getDB();
  d.prepare('UPDATE users SET google_id = ?, oauth_provider = ?, avatar_url = ?, updated_at = ? WHERE id = ?')
    .run(googleId, 'google', avatarUrl || null, Date.now(), userId);
}

function getUserByEmail(email) {
  const d = getDB();
  return d.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) || null;
}

function getUserById(id) {
  const d = getDB();
  return d.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function verifyUserPassword(email, password) {
  const user = getUserByEmail(email);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  // Update last login
  getDB().prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), user.id);
  return user;
}

function updateUserTier(userId, tier) {
  const d = getDB();
  d.prepare('UPDATE users SET tier = ?, updated_at = ? WHERE id = ?').run(tier, Date.now(), userId);
  // Also update their license
  d.prepare('UPDATE licenses SET tier = ? WHERE user_id = ?').run(tier, userId);
  return getUserById(userId);
}

function banUser(userId) {
  getDB().prepare('UPDATE users SET is_banned = 1, updated_at = ? WHERE id = ?').run(Date.now(), userId);
}

function getAllUsers() {
  return getDB().prepare('SELECT id, email, name, tier, country_code, created_at, last_login_at, is_banned FROM users ORDER BY created_at DESC').all();
}

function getUserCount() {
  return getDB().prepare('SELECT COUNT(*) as count FROM users').get().count;
}

function getProUserCount() {
  return getDB().prepare("SELECT COUNT(*) as count FROM users WHERE tier = 'pro'").get().count;
}

function getActiveToday() {
  const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
  return getDB().prepare('SELECT COUNT(*) as count FROM users WHERE last_login_at > ?').get(dayAgo).count;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━
//  LICENSE OPERATIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━

function createLicense({ key, user_id, email, tier, status, country_code, expires_at, sessions_limit }) {
  const d = getDB();
  d.prepare(`
    INSERT INTO licenses (key, user_id, email, tier, status, country_code, activated_at, expires_at, sessions_used, sessions_limit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(key, user_id, email.toLowerCase(), tier, status, country_code, Date.now(), expires_at, sessions_limit);

  return getLicenseByKey(key);
}

function getLicenseByKey(key) {
  return getDB().prepare('SELECT * FROM licenses WHERE key = ?').get(key) || null;
}

function getLicenseByUserId(userId) {
  return getDB().prepare('SELECT * FROM licenses WHERE user_id = ? ORDER BY activated_at DESC LIMIT 1').get(userId) || null;
}

function incrementSessionCount(licenseKey) {
  getDB().prepare('UPDATE licenses SET sessions_used = sessions_used + 1 WHERE key = ?').run(licenseKey);
}

function updateLicenseStatus(licenseKey, status) {
  getDB().prepare('UPDATE licenses SET status = ? WHERE key = ?').run(status, licenseKey);
}

function updateLicenseOnPayment(userId, { tier, status, expires_at, sessions_limit }) {
  getDB().prepare(`
    UPDATE licenses SET tier = ?, status = ?, expires_at = ?, sessions_limit = ? WHERE user_id = ?
  `).run(tier, status, expires_at, sessions_limit, userId);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━
//  DEVICE OPERATIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━

function registerDevice(userId, deviceId, deviceName) {
  const d = getDB();
  const now = Date.now();

  // Check if device already registered
  const existing = d.prepare('SELECT * FROM devices WHERE user_id = ? AND device_id = ?').get(userId, deviceId);
  if (existing) {
    d.prepare('UPDATE devices SET last_seen_at = ?, is_active = 1 WHERE id = ?').run(now, existing.id);
    return existing;
  }

  // Check device limit — auto-replace oldest if full
  const user = getUserById(userId);
  const maxDevices = user.tier === 'pro' ? getConfig('max_devices_pro', 3) : getConfig('max_devices_free', 2);
  const activeDevices = d.prepare('SELECT * FROM devices WHERE user_id = ? AND is_active = 1 ORDER BY last_seen_at ASC').all(userId);

  if (activeDevices.length >= maxDevices) {
    // Deactivate the oldest device(s) to make room
    const toDeactivate = activeDevices.slice(0, activeDevices.length - maxDevices + 1);
    for (const old of toDeactivate) {
      d.prepare('UPDATE devices SET is_active = 0 WHERE id = ?').run(old.id);
    }
  }

  d.prepare('INSERT INTO devices (user_id, device_id, device_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, deviceId, deviceName || 'Unknown Device', now, now);

  return d.prepare('SELECT * FROM devices WHERE user_id = ? AND device_id = ?').get(userId, deviceId);
}

function getUserDevices(userId) {
  return getDB().prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC').all(userId);
}

function deactivateDevice(userId, deviceId) {
  getDB().prepare('UPDATE devices SET is_active = 0 WHERE user_id = ? AND device_id = ?').run(userId, deviceId);
}

function isDeviceAuthorized(userId, deviceId) {
  const device = getDB().prepare('SELECT * FROM devices WHERE user_id = ? AND device_id = ? AND is_active = 1').get(userId, deviceId);
  return !!device;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━
//  LOGIN LOG
// ━━━━━━━━━━━━━━━━━━━━━━━━━

function logLogin({ user_id, email, ip_address, device_id, country_code, success, error_reason }) {
  getDB().prepare(`
    INSERT INTO login_logs (user_id, email, ip_address, device_id, country_code, success, error_reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(user_id || null, email, ip_address || null, device_id || null, country_code || null, success ? 1 : 0, error_reason || null, Date.now());
}

function getRecentLogins(limit = 50) {
  return getDB().prepare('SELECT * FROM login_logs ORDER BY created_at DESC LIMIT ?').all(limit);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━
//  REVOKED KEYS
// ━━━━━━━━━━━━━━━━━━━━━━━━━

function revokeKey(key, revokedBy, reason) {
  const d = getDB();
  d.prepare('INSERT OR REPLACE INTO revoked_keys (key, revoked_by, reason, revoked_at) VALUES (?, ?, ?, ?)').run(key, revokedBy, reason || '', Date.now());
  d.prepare("UPDATE licenses SET status = 'revoked' WHERE key = ?").run(key);
}

function isKeyRevoked(key) {
  return !!getDB().prepare('SELECT 1 FROM revoked_keys WHERE key = ?').get(key);
}

function getRevokedKeys() {
  return getDB().prepare('SELECT * FROM revoked_keys ORDER BY revoked_at DESC').all();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━
//  APP CONFIG
// ━━━━━━━━━━━━━━━━━━━━━━━━━

function getConfig(key, defaultValue) {
  const row = getDB().prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  if (!row) return defaultValue;
  // Try to parse as number
  const num = Number(row.value);
  return isNaN(num) ? row.value : num;
}

function setConfig(key, value) {
  getDB().prepare('INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)').run(key, String(value), Date.now());
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━
//  CONVERSATION OPERATIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━

function createConversation({ id, user_id, name }) {
  const d = getDB();
  const now = Date.now();
  d.prepare('INSERT INTO conversations (id, user_id, name, created_at, updated_at, is_active) VALUES (?, ?, ?, ?, ?, 1)')
    .run(id, user_id, name, now, now);
  return d.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
}

function getConversationsByUser(userId) {
  return getDB().prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
}

function getConversationById(id) {
  return getDB().prepare('SELECT * FROM conversations WHERE id = ?').get(id) || null;
}

function updateConversation(id, { name, is_active }) {
  const d = getDB();
  const updates = [];
  const values = [];
  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (is_active !== undefined) { updates.push('is_active = ?'); values.push(is_active ? 1 : 0); }
  updates.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);
  d.prepare(`UPDATE conversations SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return getConversationById(id);
}

function deleteConversation(id) {
  const d = getDB();
  d.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(id);
  d.prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━
//  CONVERSATION MESSAGE OPS
// ━━━━━━━━━━━━━━━━━━━━━━━━━

function addConversationMessage({ id, conversation_id, user_id, role, content, timestamp }) {
  const d = getDB();
  d.prepare('INSERT OR REPLACE INTO conversation_messages (id, conversation_id, user_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, conversation_id, user_id, role, content, timestamp);
  // Touch conversation updated_at
  d.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), conversation_id);
}

function addConversationMessages(messages) {
  const d = getDB();
  const insert = d.prepare('INSERT OR REPLACE INTO conversation_messages (id, conversation_id, user_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)');
  const insertMany = d.transaction((msgs) => {
    for (const m of msgs) {
      insert.run(m.id, m.conversation_id, m.user_id, m.role, m.content, m.timestamp);
    }
    // Touch conversation updated_at for the first message's conversation
    if (msgs.length > 0) {
      d.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), msgs[0].conversation_id);
    }
  });
  insertMany(messages);
}

function getConversationMessages(conversationId) {
  return getDB().prepare('SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY timestamp ASC').all(conversationId);
}

function clearConversationMessages(conversationId) {
  getDB().prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(conversationId);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━
//  PAYMENT OPERATIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━

function recordPayment({ user_id, email, provider, provider_payment_id, provider_subscription_id, amount, currency, status, tier_granted, metadata }) {
  const d = getDB();
  d.prepare(`
    INSERT INTO payments (user_id, email, provider, provider_payment_id, provider_subscription_id, amount, currency, status, tier_granted, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(user_id, email, provider, provider_payment_id || null, provider_subscription_id || null, amount, currency || 'USD', status, tier_granted || null, metadata ? JSON.stringify(metadata) : null, Date.now());
}

function getPaymentsByUser(userId) {
  return getDB().prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

function getAllPayments(limit = 100) {
  return getDB().prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT ?').all(limit);
}

function getPaymentStats() {
  const d = getDB();
  const monthAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  return {
    total_payments: d.prepare('SELECT COUNT(*) as c FROM payments WHERE status = ?').get('completed').c,
    revenue_this_month: d.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'completed' AND created_at > ?").get(monthAgo).total,
    total_revenue: d.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'completed'").get().total,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADMIN STATS
// ━━━━━━━━━━━━━━━━━━━━━━━━━

function getStats() {
  const d = getDB();
  const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
  const monthAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

  return {
    total_users: d.prepare('SELECT COUNT(*) as c FROM users').get().c,
    pro_users: d.prepare("SELECT COUNT(*) as c FROM users WHERE tier = 'pro'").get().c,
    free_users: d.prepare("SELECT COUNT(*) as c FROM users WHERE tier = 'free'").get().c,
    active_today: d.prepare('SELECT COUNT(*) as c FROM users WHERE last_login_at > ?').get(dayAgo).c,
    signups_this_month: d.prepare('SELECT COUNT(*) as c FROM users WHERE created_at > ?').get(monthAgo).c,
    total_devices: d.prepare('SELECT COUNT(*) as c FROM devices WHERE is_active = 1').get().c,
    revoked_licenses: d.prepare('SELECT COUNT(*) as c FROM revoked_keys').get().c,
    banned_users: d.prepare('SELECT COUNT(*) as c FROM users WHERE is_banned = 1').get().c,
    logins_today: d.prepare('SELECT COUNT(*) as c FROM login_logs WHERE created_at > ? AND success = 1').get(dayAgo).c,
    failed_logins_today: d.prepare('SELECT COUNT(*) as c FROM login_logs WHERE created_at > ? AND success = 0').get(dayAgo).c,
    total_conversations: d.prepare('SELECT COUNT(*) as c FROM conversations').get().c,
    total_messages: d.prepare('SELECT COUNT(*) as c FROM conversation_messages').get().c,
    ...getPaymentStats(),
  };
}

// ── Cleanup ──
function closeDB() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  getDB,
  // Users
  createUser, getUserByEmail, getUserById, getUserByGoogleId, linkGoogleAccount, verifyUserPassword,
  updateUserTier, banUser, getAllUsers, getUserCount, getProUserCount, getActiveToday,
  // Licenses
  createLicense, getLicenseByKey, getLicenseByUserId,
  incrementSessionCount, updateLicenseStatus, updateLicenseOnPayment,
  // Devices
  registerDevice, getUserDevices, deactivateDevice, isDeviceAuthorized,
  // Conversations
  createConversation, getConversationsByUser, getConversationById, updateConversation, deleteConversation,
  addConversationMessage, addConversationMessages, getConversationMessages, clearConversationMessages,
  // Payments
  recordPayment, getPaymentsByUser, getAllPayments, getPaymentStats,
  // Login logs
  logLogin, getRecentLogins,
  // Revoked keys
  revokeKey, isKeyRevoked, getRevokedKeys,
  // Config
  getConfig, setConfig,
  // Stats
  getStats,
  // Cleanup
  closeDB,
  // Password utils (for testing)
  hashPassword, verifyPassword,
};
