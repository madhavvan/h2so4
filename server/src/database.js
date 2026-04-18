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

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Every admin mutation is recorded here. Read-only from the API surface;
    -- writes happen through logAdminAction() on the server only.
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_email TEXT NOT NULL,
      action TEXT NOT NULL,
      target_user_id TEXT,
      target_email TEXT,
      details_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);

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
    CREATE INDEX IF NOT EXISTS idx_reset_tokens_user ON password_reset_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_reset_tokens_expires ON password_reset_tokens(expires_at);
  `);

  // Set default app config. Per-tier device limits — admin can tune each via
  // app_config without a code deploy. Max is highest to support users who
  // legitimately work from multiple machines.
  const setDefault = db.prepare('INSERT OR IGNORE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)');
  setDefault.run('min_app_version', '2.0.0', Date.now());
  setDefault.run('latest_app_version', '2.0.0', Date.now());
  setDefault.run('max_devices_free', '2', Date.now());
  setDefault.run('max_devices_basic', '2', Date.now());
  setDefault.run('max_devices_pro', '3', Date.now());
  setDefault.run('max_devices_max', '5', Date.now());

  // ── Idempotent migrations ──
  // SQLite has no "ADD COLUMN IF NOT EXISTS", so we check PRAGMA table_info.
  // Any column added AFTER initial deploy must be handled this way.
  const userCols = db.prepare("PRAGMA table_info(users)").all();
  if (!userCols.find(c => c.name === 'tokens_revoked_after')) {
    // Every token signed BEFORE this timestamp is rejected by authMiddleware.
    // Used to force-logout a user without banning them — bump this value and
    // all of their existing sessions die on the next request.
    db.exec('ALTER TABLE users ADD COLUMN tokens_revoked_after INTEGER DEFAULT 0');
  }

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
  // Google-only accounts have no password_hash. Treat as "wrong password"
  // rather than letting verifyPassword crash on null.split(':') — same 401
  // the caller returns for a real mismatch, no information leak.
  if (!user.password_hash) return null;
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

function updateUserPassword(userId, newPassword) {
  const d = getDB();
  const passwordHash = hashPassword(newPassword);
  d.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(passwordHash, Date.now(), userId);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━
//  PASSWORD RESET TOKENS
// ━━━━━━━━━━━━━━━━━━━━━━━━━
// The raw token is only ever returned to the caller once — the database
// stores the SHA-256 hash so a DB dump doesn't yield reusable reset links.

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashResetToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function createPasswordResetToken(userId, email) {
  const d = getDB();
  // Invalidate any prior unused tokens for this user.
  d.prepare('DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL').run(userId);

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashResetToken(rawToken);
  const now = Date.now();
  d.prepare(`
    INSERT INTO password_reset_tokens (token_hash, user_id, email, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tokenHash, userId, email.toLowerCase(), now + RESET_TOKEN_TTL_MS, now);

  return rawToken;
}

// Look up a reset token without consuming it — used by the GET form page
// so we can show "expired" before the user types a new password.
function getPasswordResetToken(rawToken) {
  if (!rawToken) return null;
  const tokenHash = hashResetToken(rawToken);
  const row = getDB()
    .prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ?')
    .get(tokenHash);
  if (!row) return null;
  if (row.used_at) return null;
  if (row.expires_at < Date.now()) return null;
  return row;
}

// Validate and mark used in one transaction so a token can never be
// replayed even if two requests land at the same millisecond.
function consumePasswordResetToken(rawToken) {
  if (!rawToken) return null;
  const tokenHash = hashResetToken(rawToken);
  const d = getDB();
  const row = d.prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ?').get(tokenHash);
  if (!row) return null;
  if (row.used_at) return null;
  if (row.expires_at < Date.now()) return null;
  const result = d
    .prepare('UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL')
    .run(Date.now(), tokenHash);
  if (result.changes === 0) return null;
  return row;
}

function cleanupExpiredResetTokens() {
  getDB().prepare('DELETE FROM password_reset_tokens WHERE expires_at < ?').run(Date.now());
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

  // Check device limit — auto-replace oldest if full. Each tier has its own
  // configurable limit (see app_config defaults). Falls back to the free-tier
  // limit if the user's tier string is something unexpected.
  const user = getUserById(userId);
  if (!user) {
    // Caller passed a userId that no longer exists (deleted user, stale
    // license row, race with account deletion). Fail loud rather than
    // crash on `user.tier` below.
    throw new Error(`registerDevice: user ${userId} not found`);
  }
  const tierDeviceLimits = {
    free: getConfig('max_devices_free', 2),
    basic: getConfig('max_devices_basic', 2),
    pro: getConfig('max_devices_pro', 3),
    max: getConfig('max_devices_max', 5),
  };
  const maxDevices = tierDeviceLimits[user.tier] ?? tierDeviceLimits.free;
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
//  ADMIN ACTIONS (audit-logged mutations)
// ━━━━━━━━━━━━━━━━━━━━━━━━━

// Writes a single row into audit_log. Caller is responsible for providing
// the admin's identity — the function doesn't know who's calling it.
function logAdminAction(adminEmail, action, targetUserId, targetEmail, details) {
  getDB().prepare(`
    INSERT INTO audit_log (admin_email, action, target_user_id, target_email, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    adminEmail,
    action,
    targetUserId || null,
    targetEmail || null,
    details ? JSON.stringify(details) : null,
    Date.now()
  );
}

function getAuditLog(limit = 100) {
  return getDB()
    .prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?')
    .all(Math.min(Math.max(limit, 1), 500));
}

// Force-logout: set a timestamp; authMiddleware rejects any token issued
// before this. Bumping invalidates every existing session for this user.
function forceLogoutUser(userId) {
  getDB().prepare('UPDATE users SET tokens_revoked_after = ?, updated_at = ? WHERE id = ?')
    .run(Date.now(), Date.now(), userId);
}

// Hot path — called on every authenticated request. Returns 0 if never set.
function getTokensRevokedAfter(userId) {
  const row = getDB().prepare('SELECT tokens_revoked_after FROM users WHERE id = ?').get(userId);
  return row ? (row.tokens_revoked_after || 0) : 0;
}

// Mark every device for a user inactive. Device rows are preserved so
// historical device-usage data stays intact; the user just has to re-bind
// on next login.
function resetUserDevices(userId) {
  const d = getDB();
  const result = d.prepare('UPDATE devices SET is_active = 0 WHERE user_id = ? AND is_active = 1').run(userId);
  return result.changes;
}

// Grant N credit-sessions (Basic tier). If the license is unlimited
// (sessions_limit === -1), this is a no-op — Pro/Max don't use credits.
// Returns the updated license (or null if user has none).
function grantCreditSessions(userId, n) {
  const license = getLicenseByUserId(userId);
  if (!license) return null;
  if (license.sessions_limit === -1) return license;
  const newLimit = Math.max(0, (license.sessions_limit || 0) + n);
  getDB().prepare('UPDATE licenses SET sessions_limit = ? WHERE user_id = ?')
    .run(newLimit, userId);
  return getLicenseByUserId(userId);
}

// Push the license expiry out by N days from whichever is later: now, or the
// current expiry. -1 (never-expires, for Pro/Max) is preserved.
function extendLicenseExpiry(userId, days) {
  const license = getLicenseByUserId(userId);
  if (!license) return null;
  if (license.expires_at === -1) return license;
  const base = Math.max(Date.now(), license.expires_at);
  const newExpiry = base + days * 24 * 60 * 60 * 1000;
  getDB().prepare('UPDATE licenses SET expires_at = ? WHERE user_id = ?')
    .run(newExpiry, userId);
  return getLicenseByUserId(userId);
}

// Basic-tier renewal top-up: +1 session credit, +1 hour wall-clock. The
// renewal button charges a fraction of the full Basic price and must
// only add to what's already there — NEVER reset back to 3 sessions /
// 14 days (that would be a full re-purchase, not a renewal).
//
// For Pro/Max (sessions_limit === -1, expires_at === -1), the renewal
// product isn't offered in the UI; if it somehow triggered server-side,
// we leave the unlimited values intact and only flip status→active.
// For Free or expired users, we reactivate Basic with sessions_limit=1
// and expires_at=now+1h — paying for a 1-hour session is a valid path.
function grantBasicRenewal(userId) {
  const license = getLicenseByUserId(userId);
  if (!license) return null;

  const ONE_HOUR_MS = 60 * 60 * 1000;
  let newLimit;
  let newExpiresAt;
  let newTier = 'basic';

  if (license.sessions_limit === -1 || license.expires_at === -1) {
    // Pro/Max — leave unlimited values alone, just re-affirm active.
    newTier = license.tier;
    newLimit = license.sessions_limit;
    newExpiresAt = license.expires_at;
  } else {
    newLimit = (license.sessions_limit || 0) + 1;
    // Anchor from whichever is later: now, or the existing expiry. Then
    // add 1h. An already-expired license starts its new 1h from now;
    // a still-valid one gets its expiry pushed out by 1h.
    const base = Math.max(Date.now(), license.expires_at || 0);
    newExpiresAt = base + ONE_HOUR_MS;
  }

  getDB().prepare(`
    UPDATE licenses SET tier = ?, status = 'active', expires_at = ?, sessions_limit = ? WHERE user_id = ?
  `).run(newTier, newExpiresAt, newLimit, userId);
  return getLicenseByUserId(userId);
}

// Look up a user's most recent Razorpay subscription id from the payments
// history — needed for the customer-initiated cancel flow since we don't
// store the active subscription id on the user row. Orders the query by
// created_at desc and filters to payments that actually carry a sub id
// (one-time Basic purchases won't match).
function getLatestRazorpaySubscriptionId(userId) {
  const row = getDB().prepare(`
    SELECT provider_subscription_id FROM payments
    WHERE user_id = ? AND provider = 'razorpay' AND provider_subscription_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(userId);
  return row ? row.provider_subscription_id : null;
}

// Undo a revocation. Removes the revoked_keys row and flips the license
// status back to 'active'. Paired with revokeKey().
function unrevokeKey(key) {
  const d = getDB();
  d.prepare('DELETE FROM revoked_keys WHERE key = ?').run(key);
  d.prepare("UPDATE licenses SET status = 'active' WHERE key = ?").run(key);
}

function unbanUser(userId) {
  getDB().prepare('UPDATE users SET is_banned = 0, updated_at = ? WHERE id = ?').run(Date.now(), userId);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADMIN STATS
// ━━━━━━━━━━━━━━━━━━━━━━━━━

function getStats() {
  const d = getDB();
  const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
  const monthAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

  // Full per-tier user count — single GROUP BY scan instead of four COUNTs.
  const tierRows = d.prepare('SELECT tier, COUNT(*) as c FROM users GROUP BY tier').all();
  const tiers = { free: 0, basic: 0, pro: 0, max: 0 };
  for (const row of tierRows) {
    if (row.tier in tiers) tiers[row.tier] = row.c;
  }

  // Month-to-date revenue split by the tier that each payment granted.
  // NB: this groups payments by `tier_granted` which is set at checkout time,
  // so if a user upgraded from Basic→Pro within the month, the Basic payment
  // still appears in the basic row. That's the right behaviour.
  const revenueRows = d.prepare(`
    SELECT tier_granted, COALESCE(SUM(amount), 0) as total, COUNT(*) as c
    FROM payments
    WHERE status = 'completed' AND created_at > ?
    GROUP BY tier_granted
  `).all(monthAgo);
  const revenueByTier = { basic: 0, pro: 0, max: 0 };
  const paymentsByTier = { basic: 0, pro: 0, max: 0 };
  for (const row of revenueRows) {
    if (row.tier_granted && row.tier_granted in revenueByTier) {
      revenueByTier[row.tier_granted] = row.total;
      paymentsByTier[row.tier_granted] = row.c;
    }
  }

  // Signups broken down by tier — lets admin see whether marketing is
  // driving Pro/Max or mostly free-tier sign-ups.
  const signupRows = d.prepare(`
    SELECT tier, COUNT(*) as c FROM users WHERE created_at > ? GROUP BY tier
  `).all(monthAgo);
  const signupsByTier = { free: 0, basic: 0, pro: 0, max: 0 };
  for (const row of signupRows) {
    if (row.tier in signupsByTier) signupsByTier[row.tier] = row.c;
  }

  return {
    total_users: d.prepare('SELECT COUNT(*) as c FROM users').get().c,
    // Legacy flat fields — kept so older client builds keep working.
    pro_users: tiers.pro,
    free_users: tiers.free,
    // New 4-tier breakdown.
    tiers,
    basic_users: tiers.basic,
    max_users: tiers.max,
    revenue_by_tier: revenueByTier,
    payments_by_tier: paymentsByTier,
    signups_by_tier: signupsByTier,
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
  updateUserTier, updateUserPassword, banUser, unbanUser, getAllUsers, getUserCount, getProUserCount, getActiveToday,
  // Password reset
  createPasswordResetToken, getPasswordResetToken, consumePasswordResetToken, cleanupExpiredResetTokens,
  // Licenses
  createLicense, getLicenseByKey, getLicenseByUserId,
  incrementSessionCount, updateLicenseStatus, updateLicenseOnPayment,
  extendLicenseExpiry, grantCreditSessions, grantBasicRenewal,
  getLatestRazorpaySubscriptionId,
  // Devices
  registerDevice, getUserDevices, deactivateDevice, isDeviceAuthorized, resetUserDevices,
  // Conversations
  createConversation, getConversationsByUser, getConversationById, updateConversation, deleteConversation,
  addConversationMessage, addConversationMessages, getConversationMessages, clearConversationMessages,
  // Payments
  recordPayment, getPaymentsByUser, getAllPayments, getPaymentStats,
  // Login logs
  logLogin, getRecentLogins,
  // Revoked keys
  revokeKey, unrevokeKey, isKeyRevoked, getRevokedKeys,
  // Config
  getConfig, setConfig,
  // Stats
  getStats,
  // Admin actions / audit
  logAdminAction, getAuditLog, forceLogoutUser, getTokensRevokedAfter,
  // Cleanup
  closeDB,
  // Password utils (for testing)
  hashPassword, verifyPassword,
};
