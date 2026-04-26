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
    -- writes happen through logAdminAction() on the server only. Append-only
    -- at the DB level via triggers (below) so a rogue insider with direct DB
    -- access, or a hypothetical SQL-injection bug, can't silently scrub the
    -- trail of admin activity. Compliance teams expect this guarantee.
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
    CREATE INDEX IF NOT EXISTS idx_audit_log_admin ON audit_log(admin_email);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_log_target_email ON audit_log(target_email);

    -- Append-only enforcement. SQLite treats these triggers as part of the
    -- schema, so dropping them requires an explicit DROP TRIGGER — far
    -- louder than a silent DELETE. Any attempt to rewrite history fails
    -- the transaction with a clear error string.
    CREATE TRIGGER IF NOT EXISTS audit_log_block_update
      BEFORE UPDATE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only; UPDATE is not permitted');
      END;
    CREATE TRIGGER IF NOT EXISTS audit_log_block_delete
      BEFORE DELETE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only; DELETE is not permitted');
      END;

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

    -- Idempotency ledger for incoming webhooks. Both Stripe and Razorpay
    -- retry deliveries on any non-2xx and sometimes on network hiccups even
    -- when we return 2xx. Every grant side-effect is gated on a successful
    -- INSERT OR IGNORE here (via recordWebhookEventOnce) — a duplicate
    -- delivery loses the race and is skipped. event_id is Stripe's event.id
    -- or the x-razorpay-event-id header (synthesized from payload fields if
    -- the header is absent on older Razorpay accounts).
    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      event_type TEXT NOT NULL,
      received_at INTEGER NOT NULL
    );

    -- Index for fast lookups
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_licenses_user ON licenses(user_id);
    CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(key);
    CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
    CREATE INDEX IF NOT EXISTS idx_login_logs_user ON login_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_login_logs_created ON login_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_messages_conv ON conversation_messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);
    CREATE INDEX IF NOT EXISTS idx_payments_provider_payment ON payments(provider, provider_payment_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON webhook_events(received_at);
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

  // Coarse OS label per device — used by AdminDashboard to show whether a
  // user is on Mac/Windows/Linux without needing to parse the raw UA on the
  // client side. Captured by the client at signup/login/validate via
  // licenseService.getPlatform() and persisted on the matching device row.
  const deviceCols = db.prepare("PRAGMA table_info(devices)").all();
  if (!deviceCols.find(c => c.name === 'platform')) {
    db.exec('ALTER TABLE devices ADD COLUMN platform TEXT');
  }

  // Server-authoritative trial timestamp. Without this, a Free user could
  // log out and log back in to re-seed a fresh 30-min trial — the client
  // ledger gets wiped on logout and the previous re-seed condition
  // (trial_remaining_seconds === undefined) fired again every login.
  // Backfill existing free users from activated_at so a long-ago signup
  // shows a long-elapsed trial (i.e. zero remaining), not a fresh 30 min.
  const licenseCols = db.prepare("PRAGMA table_info(licenses)").all();
  if (!licenseCols.find(c => c.name === 'trial_granted_at')) {
    db.exec('ALTER TABLE licenses ADD COLUMN trial_granted_at INTEGER DEFAULT 0');
    db.exec("UPDATE licenses SET trial_granted_at = activated_at WHERE tier = 'free' AND trial_granted_at = 0");
  }

  // Defense-in-depth against the /verify-razorpay ↔ payment.captured race:
  // both paths grant the same payment if they both see "no row yet" between
  // their dedup check and their transaction. The in-transaction re-check
  // (added below in payments.js + webhooks.js) closes the window functionally;
  // this UNIQUE index ensures a stray double-INSERT also fails at the DB
  // layer. Partial index on NOT NULL because legitimate cancel/subscription-
  // delete events record null provider_payment_id and shouldn't collide.
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_id ' +
    'ON payments(provider, provider_payment_id) ' +
    'WHERE provider_payment_id IS NOT NULL'
  );

  // Same field on the per-attempt login_logs row so the admin can see
  // platform per login attempt (catches the case where a single device
  // has been re-signed-in across OS reinstalls).
  const loginCols = db.prepare("PRAGMA table_info(login_logs)").all();
  if (!loginCols.find(c => c.name === 'platform')) {
    db.exec('ALTER TABLE login_logs ADD COLUMN platform TEXT');
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
  // NOTE: intentionally do NOT delete prior unused tokens for this user.
  // Previously we did — and it bit users hard: clicking "Forgot password"
  // twice (common when the first email takes a few seconds to arrive)
  // invalidated the earlier token. Resend can also reorder deliveries,
  // so a user might click the email that *arrived* first (older token)
  // thinking it's fresh. Each token is already single-use, 1-hour TTL,
  // and 256-bit random — letting up to a handful coexist has the same
  // effective blast radius as one.

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashResetToken(rawToken);
  const now = Date.now();
  d.prepare(`
    INSERT INTO password_reset_tokens (token_hash, user_id, email, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tokenHash, userId, email.toLowerCase(), now + RESET_TOKEN_TTL_MS, now);

  return rawToken;
}

// Diagnostic lookup — returns the row regardless of used/expired state so
// the route can log WHY a token was rejected. getPasswordResetToken (below)
// does the real "is this usable" check; this one exists for logging only.
function getRawPasswordResetToken(rawToken) {
  if (!rawToken) return null;
  const tokenHash = hashResetToken(rawToken);
  return getDB()
    .prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ?')
    .get(tokenHash) || null;
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

// Called immediately after a successful password reset. Sibling tokens —
// ones issued for the same user but not yet redeemed — stop being useful
// the moment the password changes, and if the reset was triggered by a
// suspected compromise they become pure blast-radius. Mark them used so
// the unhappy twin can't be replayed within the 1-hour TTL window.
function invalidatePendingResetTokensForUser(userId) {
  return getDB()
    .prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
    .run(Date.now(), userId).changes;
}

// Atomic password reset: hashes the new password, updates the user row,
// bumps tokens_revoked_after to invalidate every existing JWT, and marks
// any sibling unused reset tokens used — all in one transaction. The
// previous flow ran these as three separate calls; a SIGKILL between the
// password update and the tokens_revoked_after bump would leave the new
// password live while old sessions still passed authMiddleware. Narrow
// window in practice but a real security gap during the exact case the
// reset is meant to address (suspected compromise). Returns the count
// of sibling tokens marked used, for logging.
function applyPasswordReset(userId, newPassword) {
  const d = getDB();
  const passwordHash = hashPassword(newPassword);
  const now = Date.now();
  let invalidatedSiblings = 0;
  const tx = d.transaction(() => {
    d.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(passwordHash, now, userId);
    d.prepare('UPDATE users SET tokens_revoked_after = ? WHERE id = ?')
      .run(now, userId);
    invalidatedSiblings = d.prepare(
      'UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL'
    ).run(now, userId).changes;
  });
  tx();
  return invalidatedSiblings;
}

function getAllUsers() {
  // Include the columns the admin UI needs to render without a second
  // round-trip per row: updated_at for recency, stripe_customer_id so the
  // Users tab can badge Stripe-vs-Razorpay-vs-none at a glance,
  // oauth_provider so Google-only accounts are visually distinct,
  // tokens_revoked_after so a force-logged-out user renders as such.
  return getDB().prepare(`
    SELECT id, email, name, tier, country_code,
           created_at, updated_at, last_login_at, is_banned,
           stripe_customer_id, oauth_provider, avatar_url,
           tokens_revoked_after
    FROM users ORDER BY created_at DESC
  `).all();
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
  // Stamp trial_granted_at at signup time for free tier so the client
  // can compute remaining trial seconds from the server clock instead
  // of unconditionally seeding 30 min on every login (which let a free
  // user farm infinite trials by logging out + back in). Paid tiers
  // get 0 (the column default) — they don't use the trial bucket.
  const now = Date.now();
  const trialGrantedAt = tier === 'free' ? now : 0;
  d.prepare(`
    INSERT INTO licenses (key, user_id, email, tier, status, country_code, activated_at, expires_at, sessions_used, sessions_limit, trial_granted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(key, user_id, email.toLowerCase(), tier, status, country_code, now, expires_at, sessions_limit, trialGrantedAt);

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

function registerDevice(userId, deviceId, deviceName, platform) {
  const d = getDB();
  const now = Date.now();

  // Check if device already registered
  const existing = d.prepare('SELECT * FROM devices WHERE user_id = ? AND device_id = ?').get(userId, deviceId);
  if (existing) {
    // Update platform if the client now reports one and the row is missing
    // it — handles devices registered before the platform column existed.
    if (platform && !existing.platform) {
      d.prepare('UPDATE devices SET last_seen_at = ?, is_active = 1, platform = ? WHERE id = ?')
        .run(now, platform, existing.id);
    } else {
      d.prepare('UPDATE devices SET last_seen_at = ?, is_active = 1 WHERE id = ?').run(now, existing.id);
    }
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

  d.prepare('INSERT INTO devices (user_id, device_id, device_name, first_seen_at, last_seen_at, platform) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, deviceId, deviceName || 'Unknown Device', now, now, platform || null);

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

function logLogin({ user_id, email, ip_address, device_id, country_code, success, error_reason, platform }) {
  getDB().prepare(`
    INSERT INTO login_logs (user_id, email, ip_address, device_id, country_code, success, error_reason, platform, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    user_id || null,
    email,
    ip_address || null,
    device_id || null,
    country_code || null,
    success ? 1 : 0,
    error_reason || null,
    platform || null,
    Date.now(),
  );
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

// Updateable columns are explicitly whitelisted (with their SQL coercion) to
// prevent SQL-injection if a future caller ever forwards untrusted field
// names from req.body. The current call sites only pass `name` / `is_active`
// but the construction pattern (`SET ${updates.join(', ')}`) is the kind of
// thing that grows dangerous as the codebase evolves — locking it down now.
const CONVERSATION_UPDATE_FIELDS = {
  name:      { sql: 'name = ?',      coerce: (v) => String(v) },
  is_active: { sql: 'is_active = ?', coerce: (v) => v ? 1 : 0 },
};

function updateConversation(id, patch) {
  const d = getDB();
  const updates = [];
  const values = [];
  for (const key of Object.keys(patch || {})) {
    const def = CONVERSATION_UPDATE_FIELDS[key];
    if (!def) continue; // silently drop non-whitelisted fields
    if (patch[key] === undefined) continue;
    updates.push(def.sql);
    values.push(def.coerce(patch[key]));
  }
  // updated_at is server-controlled, always stamped.
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

// Admin-only: recent conversations across ALL users, joined with user identity
// and the latest message preview. Powers the Conversations tab — lets an
// admin spot users who might be stuck/frustrated without having to guess
// which email to search. Orders by conversations.updated_at DESC (the row
// is touched on every new message, see addConversationMessage).
// `q` filters on email or conversation name (LIKE, case-insensitive). The
// last-message correlated subquery uses the (conversation_id, timestamp)
// index via idx_conversation_messages_conv — fine at our scale.
function getRecentConversationsAcrossUsers({ limit = 50, q = null } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
  let where = 'WHERE 1=1';
  const args = [];
  if (q) {
    where += ' AND (LOWER(u.email) LIKE ? OR LOWER(c.name) LIKE ?)';
    const like = `%${String(q).toLowerCase()}%`;
    args.push(like, like);
  }
  const sql = `
    SELECT
      c.id           AS conv_id,
      c.user_id      AS user_id,
      c.name         AS conv_name,
      c.created_at   AS created_at,
      c.updated_at   AS updated_at,
      u.email        AS user_email,
      u.name         AS user_name,
      u.tier         AS user_tier,
      u.is_banned    AS user_is_banned,
      (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = c.id) AS message_count,
      (SELECT m.role    FROM conversation_messages m WHERE m.conversation_id = c.id ORDER BY m.timestamp DESC LIMIT 1) AS last_role,
      (SELECT m.content FROM conversation_messages m WHERE m.conversation_id = c.id ORDER BY m.timestamp DESC LIMIT 1) AS last_content,
      (SELECT m.timestamp FROM conversation_messages m WHERE m.conversation_id = c.id ORDER BY m.timestamp DESC LIMIT 1) AS last_ts
    FROM conversations c
    JOIN users u ON u.id = c.user_id
    ${where}
    ORDER BY c.updated_at DESC
    LIMIT ?
  `;
  const rows = getDB().prepare(sql).all(...args, lim);
  // Truncate message previews so the admin table stays readable and we don't
  // ship huge LLM answers across the wire on every refresh.
  return rows.map(r => ({
    ...r,
    last_preview: r.last_content
      ? (r.last_content.length > 240 ? r.last_content.slice(0, 240) + '…' : r.last_content)
      : null,
    last_content: undefined,
  }));
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
//  WEBHOOK IDEMPOTENCY
// ━━━━━━━━━━━━━━━━━━━━━━━━━

// INSERT OR IGNORE on the PK (event_id). Returns true on first-ever delivery,
// false on any duplicate. Every side-effect-producing webhook handler MUST
// gate on this returning true, otherwise a retried delivery (Stripe retries
// on non-2xx for up to 3 days; Razorpay retries up to 24h) will re-grant
// credits, extend expiry again, or fire a second confirmation email.
function recordWebhookEventOnce(eventId, provider, eventType) {
  if (!eventId) return true; // No id → can't dedup; fall through (caller should log).
  const result = getDB().prepare(`
    INSERT OR IGNORE INTO webhook_events (event_id, provider, event_type, received_at)
    VALUES (?, ?, ?, ?)
  `).run(eventId, provider, eventType || 'unknown', Date.now());
  return result.changes > 0;
}

// Roll back the dedup row so a later retry can reprocess the event. Called
// only when the handler threw AFTER recording the event but BEFORE finishing
// the grant — without this, the retry would silently no-op and the user
// would never get their credits.
function clearWebhookEvent(eventId) {
  if (!eventId) return;
  getDB().prepare('DELETE FROM webhook_events WHERE event_id = ?').run(eventId);
}

// Have we already recorded a completed renewal top-up for this exact
// provider_payment_id? Used to dedup across /verify-razorpay (client
// success callback) and the webhook (server-side), which BOTH fire for
// Razorpay renewals and race each other on fast networks. The LIKE on
// metadata filters to renewal mode so a prior subscription-cycle charge
// with the same order id (shouldn't happen, but defense-in-depth) can't
// mask a legitimate renewal grant.
function isRenewalPaymentProcessed(userId, providerPaymentId) {
  if (!userId || !providerPaymentId) return false;
  const row = getDB().prepare(`
    SELECT id FROM payments
    WHERE user_id = ?
      AND provider_payment_id = ?
      AND status = 'completed'
      AND metadata LIKE '%"mode":"renewal"%'
    LIMIT 1
  `).get(userId, providerPaymentId);
  return !!row;
}

// Have we already recorded ANY completed payment row for this exact
// provider_payment_id? Used to dedup BOTH tier grants and renewals between
// /verify-razorpay (client success callback) and the payment.captured
// webhook, which race on the same razorpay_payment_id. Unlike
// isRenewalPaymentProcessed this does not filter on metadata mode — a
// tier-grant completion from /verify-razorpay must block a second
// tier-grant from the webhook even though they share the same payment id.
// License state is applied idempotently via updateLicenseOnPayment, so
// skipping the second grant is safe — only the payment row is duplicated
// without this guard.
function isPaymentAlreadyRecorded(userId, providerPaymentId) {
  if (!userId || !providerPaymentId) return false;
  const row = getDB().prepare(`
    SELECT id FROM payments
    WHERE user_id = ?
      AND provider_payment_id = ?
      AND status = 'completed'
    LIMIT 1
  `).get(userId, providerPaymentId);
  return !!row;
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADMIN: PROFILE / DEVICE / CONVERSATION MUTATIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Admin edit of a user's profile. Only whitelisted columns — name and
// country_code — are writable here. Email changes are off-limits from
// this helper: they affect auth identity, license email, and payment
// receipts, and must go through a dedicated "change email" flow that
// re-verifies the new address. Country code is normalized to the
// 2-letter uppercase ISO-3166-1 alpha-2 form so downstream geo checks
// stay consistent.
function updateUserProfile(userId, { name, country_code }) {
  const updates = [];
  const values = [];
  if (name !== undefined && name !== null) {
    const n = String(name).trim();
    if (n.length > 0) { updates.push('name = ?'); values.push(n); }
  }
  if (country_code !== undefined && country_code !== null) {
    const cc = String(country_code).trim().toUpperCase().slice(0, 2);
    if (/^[A-Z]{2}$/.test(cc)) { updates.push('country_code = ?'); values.push(cc); }
  }
  if (updates.length === 0) return getUserById(userId);
  updates.push('updated_at = ?'); values.push(Date.now());
  values.push(userId);
  getDB().prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return getUserById(userId);
}

// Deactivate a single device row (not all of them). Validates that the
// device actually belongs to the given user so an admin can't accidentally
// kill a different user's device by typing the wrong device row id. Returns
// the number of rows affected so the caller can 404 on no-match.
function revokeSingleDevice(deviceRowId, userId) {
  const result = getDB()
    .prepare('UPDATE devices SET is_active = 0 WHERE id = ? AND user_id = ? AND is_active = 1')
    .run(deviceRowId, userId);
  return result.changes;
}

// Admin-initiated conversation delete. Requires (convId, userId) so the
// admin can't accidentally wipe a conversation belonging to someone else
// by guessing an id — the conversation must belong to the user the admin
// is currently viewing. Messages cascade-delete via FK, but we do it
// explicitly in a transaction for clarity and to keep both tables in
// lock-step even if the FK pragma is ever disabled.
function deleteConversationByAdmin(convId, userId) {
  const d = getDB();
  const conv = d.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(convId, userId);
  if (!conv) return null;
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(convId);
    d.prepare('DELETE FROM conversations WHERE id = ?').run(convId);
  });
  tx();
  return conv;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADMIN: DSAR EXPORT + ACCOUNT DELETION (GDPR)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Full export of everything we store about a user. Used for a GDPR
// DSAR "right of access" request or as a pre-deletion snapshot so the
// admin can hand the user their data before we wipe it. Intentionally
// strips password_hash — we don't want even the user to receive a
// salted hash of their own password (no value to them, grindable if
// the file leaks).
function getUserDataExport(userId) {
  const d = getDB();
  const user = d.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const { password_hash, ...safeUser } = user; // eslint-disable-line no-unused-vars
  const conversations = d.prepare('SELECT * FROM conversations WHERE user_id = ?').all(userId);
  return {
    exported_at: Date.now(),
    exported_at_iso: new Date().toISOString(),
    user: safeUser,
    licenses: d.prepare('SELECT * FROM licenses WHERE user_id = ?').all(userId),
    devices: d.prepare('SELECT * FROM devices WHERE user_id = ?').all(userId),
    conversations: conversations.map(c => ({
      ...c,
      messages: d.prepare('SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY timestamp ASC').all(c.id),
    })),
    payments: d.prepare('SELECT * FROM payments WHERE user_id = ?').all(userId),
    login_logs: d.prepare('SELECT * FROM login_logs WHERE user_id = ? ORDER BY created_at DESC').all(userId),
    // audit_log rows where this user was the TARGET of an admin action —
    // the user has a right to see the history of moderation decisions
    // taken against their account.
    audit_log_as_target: d.prepare('SELECT * FROM audit_log WHERE target_user_id = ? ORDER BY created_at DESC').all(userId),
  };
}

// Hard-delete a user and all their owned rows. FK ON DELETE CASCADE is
// configured so licenses/devices/conversations/messages/payments/
// reset-tokens clean themselves up when the users row goes away, but:
//   • login_logs.user_id is a nullable reference (no FK), so we wipe
//     those explicitly.
//   • We revoke the license key first so it can't be reused if the
//     same email signs up again after deletion.
// Wrapped in a transaction so a partial failure leaves the user intact
// rather than orphaned (e.g. users row deleted but login_logs still
// reference a gone id).
function deleteUser(userId) {
  const d = getDB();
  const user = d.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return false;
  const tx = d.transaction(() => {
    const licenses = d.prepare('SELECT key FROM licenses WHERE user_id = ?').all(userId);
    for (const lic of licenses) {
      d.prepare('INSERT OR REPLACE INTO revoked_keys (key, revoked_by, reason, revoked_at) VALUES (?, ?, ?, ?)')
        .run(lic.key, 'system', 'user account deleted', Date.now());
    }
    d.prepare('DELETE FROM login_logs WHERE user_id = ?').run(userId);
    d.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });
  tx();
  return true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADMIN: COMP-PAYMENT (zero-dollar tier grant w/ audit row)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Issue a comp (complimentary) license: a $0 payments row tagged
// admin-comp + mode=admin_comp, plus the actual tier flip on the
// user + license rows. Revenue reports filter `amount > 0` so these
// don't inflate MRR/ARR. The payments row survives even after a
// future upgrade, giving admin a clean "why does this user have Pro
// without paying" answer.
const DAY_MS_CONST = 24 * 60 * 60 * 1000;
function recordCompPayment(userId, tier, note) {
  const d = getDB();
  const user = d.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const grantConfig = {
    basic: { sessions_limit: 3, expires_at: Date.now() + 14 * DAY_MS_CONST },
    pro:   { sessions_limit: -1, expires_at: -1 },
    max:   { sessions_limit: -1, expires_at: -1 },
  }[tier];
  if (!grantConfig) return null;
  // Capture the inserted payment row id so the admin audit entry can
  // reference it. Previously this function returned only the license row,
  // so `result.payment_id` in the grant-comp audit was always undefined
  // and the audit log column was blank for comp grants.
  let paymentId = null;
  const tx = d.transaction(() => {
    d.prepare('UPDATE users SET tier = ?, updated_at = ? WHERE id = ?').run(tier, Date.now(), userId);
    d.prepare('UPDATE licenses SET tier = ?, status = ?, expires_at = ?, sessions_limit = ? WHERE user_id = ?')
      .run(tier, 'active', grantConfig.expires_at, grantConfig.sessions_limit, userId);
    const info = d.prepare(`
      INSERT INTO payments (user_id, email, provider, provider_payment_id, provider_subscription_id, amount, currency, status, tier_granted, metadata, created_at)
      VALUES (?, ?, 'admin-comp', ?, NULL, 0, 'USD', 'completed', ?, ?, ?)
    `).run(
      userId,
      user.email,
      `comp_${userId}_${Date.now()}`,
      tier,
      JSON.stringify({ mode: 'admin_comp', note: note || null }),
      Date.now(),
    );
    paymentId = info.lastInsertRowid;
  });
  tx();
  const license = d.prepare('SELECT * FROM licenses WHERE user_id = ?').get(userId);
  // Spread preserves the prior return shape (admin.js uses `...result` in
  // the response body); the new payment_id field is additive.
  return license ? { ...license, payment_id: paymentId } : null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADMIN: PAYMENT LOOKUP + FILTERED QUERIES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function getPaymentById(paymentId) {
  return getDB().prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) || null;
}

// Has this payment been refunded already? We look for a second payments
// row with the same provider_payment_id and status='refunded' (that's the
// shape the webhook handler writes). Lets the admin refund endpoint
// short-circuit a double-refund click.
function hasPaymentBeenRefunded(provider, providerPaymentId) {
  if (!provider || !providerPaymentId) return false;
  const row = getDB().prepare(`
    SELECT id FROM payments
    WHERE provider = ? AND provider_payment_id = ?
      AND status IN ('refunded', 'partially_refunded')
    LIMIT 1
  `).get(provider, providerPaymentId);
  return !!row;
}

// Record a refund row that we initiated from the admin console. Kept
// separate from recordPayment so the shape (negative amount, status,
// metadata.refund_id) is consistent and harder to get wrong inline.
// The provider webhook may fire next with the same refund_id; the
// webhook idempotency gate (webhook_events dedup) protects against
// a double-apply of the license downgrade.
function recordAdminRefund({ originalPayment, refundId, amount, reason, initiatedBy }) {
  if (!originalPayment) return null;
  const d = getDB();
  d.prepare(`
    INSERT INTO payments (user_id, email, provider, provider_payment_id, provider_subscription_id, amount, currency, status, tier_granted, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    originalPayment.user_id,
    originalPayment.email,
    originalPayment.provider,
    originalPayment.provider_payment_id,
    originalPayment.provider_subscription_id,
    -(Math.abs(amount) || 0),
    originalPayment.currency || 'USD',
    'refunded',
    null,
    JSON.stringify({
      mode: 'admin_refund',
      refund_id: refundId || null,
      original_payment_id: originalPayment.id,
      reason: reason || null,
      initiated_by: initiatedBy || null,
    }),
    Date.now(),
  );
}

// Filtered payment query for the admin Payments tab. All filters are
// optional; applied in AND. Returns the payment rows + a matching stats
// snapshot (count, gross, net-after-refunds) so the UI doesn't need a
// second round-trip.
function queryPayments({ provider, status, email, tier, from, to, limit }) {
  const d = getDB();
  let where = 'WHERE 1=1';
  const args = [];
  if (provider) { where += ' AND provider = ?'; args.push(String(provider)); }
  if (status)   { where += ' AND status = ?';   args.push(String(status)); }
  if (tier)     { where += ' AND tier_granted = ?'; args.push(String(tier)); }
  if (email)    { where += ' AND LOWER(email) LIKE ?'; args.push(`%${String(email).toLowerCase()}%`); }
  if (from)     { where += ' AND created_at >= ?'; args.push(Number(from)); }
  if (to)       { where += ' AND created_at <= ?'; args.push(Number(to)); }

  const lim = Math.min(Math.max(Number(limit) || 200, 1), 2000);
  const rows = d.prepare(`SELECT * FROM payments ${where} ORDER BY created_at DESC LIMIT ?`).all(...args, lim);

  const stats = d.prepare(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(CASE WHEN amount > 0 AND status = 'completed' THEN amount ELSE 0 END), 0) as gross,
      COALESCE(SUM(CASE WHEN status IN ('refunded','partially_refunded','disputed') THEN amount ELSE 0 END), 0) as refunded_or_disputed
    FROM payments ${where}
  `).get(...args);

  return { payments: rows, stats };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADMIN: AUDIT LOG — FILTERED QUERY + DISTINCT DROPDOWNS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function queryAuditLog({ admin, action, target, from, to, limit }) {
  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  const args = [];
  if (admin)  { sql += ' AND LOWER(admin_email) = ?'; args.push(String(admin).toLowerCase()); }
  if (action) { sql += ' AND action = ?'; args.push(String(action)); }
  if (target) { sql += ' AND LOWER(target_email) LIKE ?'; args.push(`%${String(target).toLowerCase()}%`); }
  if (from)   { sql += ' AND created_at >= ?'; args.push(Number(from)); }
  if (to)     { sql += ' AND created_at <= ?'; args.push(Number(to)); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  args.push(Math.min(Math.max(Number(limit) || 200, 1), 2000));
  return getDB().prepare(sql).all(...args);
}

function getAuditActions() {
  return getDB().prepare('SELECT DISTINCT action FROM audit_log ORDER BY action ASC')
    .all().map(r => r.action);
}

function getAuditAdmins() {
  return getDB().prepare('SELECT DISTINCT admin_email FROM audit_log ORDER BY admin_email ASC')
    .all().map(r => r.admin_email);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADMIN: ENTERPRISE ANALYTICS (trends, top customers, engagement)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Daily time-series for the last N days, filled with zeros for days
// that had no activity. Returns signups, successful logins, and gross
// revenue (amount > 0 completed payments) per day. Used by the
// Analytics tab's sparkline charts.
//
// SQLite idiom: strftime('%Y-%m-%d', ms/1000, 'unixepoch') converts our
// ms-epoch created_at into a YYYY-MM-DD bucket. We fill the full date
// range on the JS side so a day with zero signups still shows as 0 in
// the chart (otherwise a 7-day sparkline might only have 4 points).
function getTrends(days) {
  const d = getDB();
  const now = Date.now();
  const n = Math.min(Math.max(Number(days) || 30, 1), 365);
  const startMs = now - n * DAY_MS_CONST;

  const signups = d.prepare(`
    SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') as day, COUNT(*) as c
    FROM users WHERE created_at >= ? GROUP BY day
  `).all(startMs);

  const logins = d.prepare(`
    SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') as day, COUNT(*) as c
    FROM login_logs WHERE created_at >= ? AND success = 1 GROUP BY day
  `).all(startMs);

  const revenue = d.prepare(`
    SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') as day,
           COALESCE(SUM(amount), 0) as total
    FROM payments WHERE status = 'completed' AND amount > 0 AND created_at >= ? GROUP BY day
  `).all(startMs);

  const byDay = new Map();
  for (let i = n - 1; i >= 0; i--) {
    const iso = new Date(now - i * DAY_MS_CONST).toISOString().slice(0, 10);
    byDay.set(iso, { day: iso, signups: 0, logins: 0, revenue: 0 });
  }
  for (const r of signups) if (byDay.has(r.day)) byDay.get(r.day).signups = r.c;
  for (const r of logins)  if (byDay.has(r.day)) byDay.get(r.day).logins  = r.c;
  for (const r of revenue) if (byDay.has(r.day)) byDay.get(r.day).revenue = r.total;
  return Array.from(byDay.values());
}

// Top customers by lifetime spend. LEFT JOIN to users so a deleted
// user's payment history still surfaces (with a null email) — useful
// when reconciling a refund against a now-deleted account. Excludes
// admin-comp rows and refunds so the ranking reflects real revenue.
function getTopCustomers(limit) {
  const n = Math.min(Math.max(Number(limit) || 10, 1), 100);
  return getDB().prepare(`
    SELECT p.user_id,
           u.email, u.name, u.tier, u.country_code,
           u.created_at as user_created_at,
           u.last_login_at,
           COUNT(p.id) as payment_count,
           COALESCE(SUM(p.amount), 0) as lifetime_value,
           MAX(p.created_at) as last_payment_at
    FROM payments p
    LEFT JOIN users u ON u.id = p.user_id
    WHERE p.status = 'completed' AND p.amount > 0 AND p.provider != 'admin-comp'
    GROUP BY p.user_id
    ORDER BY lifetime_value DESC
    LIMIT ?
  `).all(n);
}

// Recurring revenue proxy, split by currency (we store amounts in
// provider-native units — cents for Stripe/USD, paise for Razorpay/INR —
// so you can't just SUM them). UI renders the two side-by-side.
//
// MRR proxy = sum of completed payments in the last 30 days. For true
// MRR you'd want a subscription state machine (active plans × plan price);
// that needs more bookkeeping than the current schema supports. This
// proxy is close enough for weekly trend-watching.
function getMRRBreakdown() {
  const monthAgo = Date.now() - 30 * DAY_MS_CONST;
  const rows = getDB().prepare(`
    SELECT currency, COALESCE(SUM(amount), 0) as total, COUNT(*) as c
    FROM payments
    WHERE status = 'completed' AND amount > 0 AND provider != 'admin-comp' AND created_at >= ?
    GROUP BY currency
  `).all(monthAgo);
  const out = { USD: { amount: 0, count: 0 }, INR: { amount: 0, count: 0 } };
  for (const r of rows) {
    const cur = (r.currency || 'USD').toUpperCase();
    if (cur in out) out[cur] = { amount: r.total, count: r.c };
  }
  return out;
}

// ARPU — lifetime revenue divided by the count of distinct paying users.
// Returned per-currency so mixed USD/INR stays honest. A user appears
// in both buckets if they paid on both providers (rare but possible
// after country relocation); that's acceptable approximation.
function getARPUBreakdown() {
  const d = getDB();
  const rows = d.prepare(`
    SELECT currency,
           COALESCE(SUM(amount), 0) as total,
           COUNT(DISTINCT user_id) as payers
    FROM payments
    WHERE status = 'completed' AND amount > 0 AND provider != 'admin-comp'
    GROUP BY currency
  `).all();
  const out = { USD: { arpu: 0, payers: 0 }, INR: { arpu: 0, payers: 0 } };
  for (const r of rows) {
    const cur = (r.currency || 'USD').toUpperCase();
    if (cur in out) {
      const payers = r.payers || 0;
      out[cur] = { arpu: payers > 0 ? Math.round(r.total / payers) : 0, payers };
    }
  }
  return out;
}

// Churn proxy: distinct users with a refund/dispute/cancellation in the
// last 30 days, divided by distinct paying users who paid BEFORE the
// window started. A user who refunded the same month they paid counts
// as churn — the denominator uses the older cohort, which is the
// standard churn-rate shape.
function getChurnRate() {
  const d = getDB();
  const monthAgo = Date.now() - 30 * DAY_MS_CONST;
  const churned = d.prepare(`
    SELECT COUNT(DISTINCT user_id) as c FROM payments
    WHERE status IN ('refunded', 'partially_refunded', 'disputed', 'cancelled')
      AND created_at >= ?
  `).get(monthAgo).c;
  const existing = d.prepare(`
    SELECT COUNT(DISTINCT user_id) as c FROM payments
    WHERE status = 'completed' AND amount > 0
      AND provider != 'admin-comp' AND created_at < ?
  `).get(monthAgo).c;
  if (existing === 0) return 0;
  // Percent, 2 decimal places.
  return Math.round((churned / existing) * 10000) / 100;
}

// DAU / WAU / MAU — distinct user_ids with a successful login in the
// last 24h / 7d / 30d. Login is our best proxy for "active" because
// the API doesn't log every request per user. If a user has a live
// JWT and never re-authenticates (valid for 30d), they won't appear
// here — that's a known limitation of this proxy.
function getEngagement() {
  const d = getDB();
  const now = Date.now();
  const q = (windowMs) => d.prepare(
    'SELECT COUNT(DISTINCT user_id) as c FROM login_logs WHERE success = 1 AND created_at >= ?'
  ).get(now - windowMs).c;
  return {
    dau: q(1 * DAY_MS_CONST),
    wau: q(7 * DAY_MS_CONST),
    mau: q(30 * DAY_MS_CONST),
  };
}

// Simple suspicious-activity digest for the admin dashboard.
// • multi_country_users — users seen logging in from 2+ countries in
//   the last 7 days (potential credential stuffing or account sharing)
// • high_fail_ips — IPs with 10+ failed logins in the last 24h (brute
//   force signals)
// • rapid_signup_ips — IPs that created 5+ accounts in the last 24h
//   (spam/abuse signals)
function getSuspiciousActivity() {
  const d = getDB();
  const now = Date.now();
  const weekAgo = now - 7 * DAY_MS_CONST;
  const dayAgo = now - 1 * DAY_MS_CONST;

  const multiCountry = d.prepare(`
    SELECT user_id, email, GROUP_CONCAT(DISTINCT country_code) as countries, COUNT(DISTINCT country_code) as n
    FROM login_logs
    WHERE user_id IS NOT NULL AND country_code IS NOT NULL AND created_at >= ? AND success = 1
    GROUP BY user_id HAVING n >= 2
    ORDER BY n DESC, email ASC LIMIT 20
  `).all(weekAgo);

  const highFailIps = d.prepare(`
    SELECT ip_address, COUNT(*) as attempts,
           MAX(created_at) as last_seen,
           GROUP_CONCAT(DISTINCT email) as emails_tried
    FROM login_logs
    WHERE ip_address IS NOT NULL AND success = 0 AND created_at >= ?
    GROUP BY ip_address HAVING attempts >= 10
    ORDER BY attempts DESC LIMIT 20
  `).all(dayAgo);

  return { multi_country_users: multiCountry, high_fail_ips: highFailIps };
}

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

  // Enterprise SaaS metrics — computed here so the Overview tab shows a
  // single, consistent snapshot. These helpers each return structured
  // per-currency objects because INR (paise) and USD (cents) cannot be summed.
  const mrr = getMRRBreakdown();
  const arpu = getARPUBreakdown();
  const churn = getChurnRate();
  const engagement = getEngagement();
  const suspicious = getSuspiciousActivity();

  // Quick-look counts for the audit/security surface.
  const pendingRefunds30d = d.prepare(`
    SELECT COUNT(*) as c FROM payments
    WHERE status IN ('refunded','disputed','cancelled') AND created_at > ?
  `).get(monthAgo).c;

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
    // Enterprise metrics — per-currency. Frontend must render separately.
    mrr_by_currency: mrr,
    arpu_by_currency: arpu,
    churn_rate_30d: churn,
    dau: engagement.dau,
    wau: engagement.wau,
    mau: engagement.mau,
    dau_wau_ratio: engagement.dau_wau_ratio,
    dau_mau_ratio: engagement.dau_mau_ratio,
    suspicious_activity: suspicious,
    pending_refunds_30d: pendingRefunds30d,
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
  updateUserProfile, deleteUser, getUserDataExport,
  // Password reset
  createPasswordResetToken, getPasswordResetToken, getRawPasswordResetToken, consumePasswordResetToken, cleanupExpiredResetTokens,
  invalidatePendingResetTokensForUser, applyPasswordReset,
  // Licenses
  createLicense, getLicenseByKey, getLicenseByUserId,
  incrementSessionCount, updateLicenseStatus, updateLicenseOnPayment,
  extendLicenseExpiry, grantCreditSessions, grantBasicRenewal,
  getLatestRazorpaySubscriptionId,
  // Devices
  registerDevice, getUserDevices, deactivateDevice, isDeviceAuthorized, resetUserDevices,
  revokeSingleDevice,
  // Conversations
  createConversation, getConversationsByUser, getConversationById, updateConversation, deleteConversation,
  addConversationMessage, addConversationMessages, getConversationMessages, clearConversationMessages,
  deleteConversationByAdmin, getRecentConversationsAcrossUsers,
  // Payments
  recordPayment, getPaymentsByUser, getAllPayments, getPaymentStats,
  getPaymentById, hasPaymentBeenRefunded, recordAdminRefund, recordCompPayment, queryPayments,
  // Webhook idempotency
  recordWebhookEventOnce, clearWebhookEvent, isRenewalPaymentProcessed,
  isPaymentAlreadyRecorded,
  // Login logs
  logLogin, getRecentLogins,
  // Revoked keys
  revokeKey, unrevokeKey, isKeyRevoked, getRevokedKeys,
  // Config
  getConfig, setConfig,
  // Stats
  getStats,
  getTrends, getTopCustomers, getMRRBreakdown, getARPUBreakdown, getChurnRate, getEngagement, getSuspiciousActivity,
  // Admin actions / audit
  logAdminAction, getAuditLog, forceLogoutUser, getTokensRevokedAfter,
  queryAuditLog, getAuditActions, getAuditAdmins,
  // Cleanup
  closeDB,
  // Password utils (for testing)
  hashPassword, verifyPassword,
};
