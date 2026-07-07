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

  // Production: refuse to boot if DATABASE_PATH is unset. Previously this
  // was a console.warn that scrolled past in deploy logs — any deploy that
  // forgot to attach a Railway Volume would silently write to the
  // container's ephemeral filesystem, and every user/license/payment row
  // would be lost on the next restart. Fail-closed at boot is the only
  // way to make this misconfiguration impossible to ship by accident.
  if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_PATH) {
    console.error('━'.repeat(70));
    console.error('✖  FATAL: DATABASE_PATH is not set in production.');
    console.error('   SQLite would write to the ephemeral container filesystem,');
    console.error('   losing all users/licenses/payments on the next restart.');
    console.error('   Fix: attach a Railway Volume and set DATABASE_PATH=/data/minicaai.db');
    console.error('   Refusing to start. See server/src/database.js for context.');
    console.error('━'.repeat(70));
    process.exit(1);
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

    -- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    --  SUPPORT BOT — live-chat threads + persistence (2026-05-13)
    --
    --  Up until now, every support conversation lived ONLY in two
    --  ephemeral places: the in-memory supportClients Map on the
    --  server, and React state inside SupportBot.tsx. A server
    --  restart, a customer reload, or the admin closing the bot
    --  panel = total history loss. That made it impossible to:
    --    • show an admin who returns later what's open
    --    • compute SLA timers (no first-response timestamp)
    --    • email a customer a delayed reply
    --    • give the customer their own past conversations
    --  These tables are the foundation for all of that.
    --
    --  support_threads:  one row per "conversation" between a single
    --                    customer and the team. Created on first
    --                    customer message OR on /handoff POST. Lives
    --                    until resolved (or 90 days for cleanup).
    --  support_messages: each message in a thread. Customer, agent,
    --                    bot, or system message — distinguished by
    --                    sender_role.
    --  support_agent_presence: per-admin online/away/offline, plus
    --                    their notification prefs and a private
    --                    ntfy.sh topic for phone push.
    --  support_escalation_queue: cron-style table the timer worker
    --                    scans every 10s; rows are deleted-on-fire
    --                    via fired_at and cleaned up on resolve.
    -- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    CREATE TABLE IF NOT EXISTS support_threads (
      id TEXT PRIMARY KEY,                       -- UUID
      customer_email TEXT NOT NULL,
      customer_name TEXT,
      customer_tier TEXT,                        -- snapshot at thread open
      customer_user_id TEXT,                     -- nullable for anonymous
      status TEXT NOT NULL DEFAULT 'open',       -- open / assigned / resolved / spam
      assigned_agent_email TEXT,                 -- nullable until claimed
      initial_question TEXT,                     -- what they wrote in the handoff form
      channel TEXT NOT NULL DEFAULT 'bot',       -- bot / handoff-form / email-reply
      customer_ip TEXT,
      customer_ua TEXT,
      tags TEXT,                                 -- JSON array, e.g. ["billing","bug"]
      created_at INTEGER NOT NULL,
      first_response_at INTEGER,                 -- ms timestamp, SLA metric
      resolved_at INTEGER,
      satisfaction_rating INTEGER,               -- 1-5, nullable
      satisfaction_comment TEXT,
      -- Last-customer-message timestamp drives the SLA color. We
      -- maintain this on every message insert via the helper rather
      -- than computing it on read — keeps the inbox query cheap even
      -- with thousands of threads.
      last_customer_message_at INTEGER,
      last_agent_message_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      sender_role TEXT NOT NULL,                 -- customer / agent / bot / system
      sender_email TEXT,                         -- nullable for system/bot
      sender_name TEXT,
      text TEXT NOT NULL,
      attachment_url TEXT,                       -- nullable; for v2 file uploads
      attachment_kind TEXT,                      -- image / file / null
      created_at INTEGER NOT NULL,
      read_by_other_at INTEGER,                  -- when the OTHER side last read
      FOREIGN KEY (thread_id) REFERENCES support_threads(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS support_agent_presence (
      agent_email TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'offline',    -- online / away / offline
      last_heartbeat_at INTEGER NOT NULL,
      notification_prefs TEXT,                   -- JSON: { desktop, slack, ntfy, email_after_min }
      ntfy_topic TEXT,                           -- per-agent topic on https://ntfy.sh/<topic>
      twilio_phone TEXT,                         -- E.164, optional, for SMS escalation
      ntfy_topic_visible INTEGER DEFAULT 0       -- has admin already seen + subscribed
    );

    -- Scheduled escalation alerts. The cron-style worker in
    -- server/src/index.js scans this table every 10s. Rows are
    -- INSERTed when a customer joins (4 rows: t+30s ntfy, t+2m email,
    -- t+5m sms, t+24h fallback) and marked fired_at when sent. A row
    -- with fired_at set != NULL is a no-op going forward. Worker
    -- skips rows where the parent thread has been claimed (i.e.
    -- assigned_agent_email IS NOT NULL) — agent picked up before
    -- escalation, no need to spam phone.
    CREATE TABLE IF NOT EXISTS support_escalation_queue (
      thread_id TEXT NOT NULL,
      channel TEXT NOT NULL,                     -- ntfy / email / sms / fallback
      fire_at INTEGER NOT NULL,
      fired_at INTEGER,                          -- nullable; set when sent
      PRIMARY KEY (thread_id, channel),
      FOREIGN KEY (thread_id) REFERENCES support_threads(id) ON DELETE CASCADE
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

    -- Support bot indexes. The inbox query "show me all open threads
    -- ordered by SLA urgency" filters on status and sorts by
    -- last_customer_message_at; this is the hot path for an admin
    -- with hundreds of threads. The customer history query filters
    -- on customer_email; the agent's "my threads" tab filters on
    -- assigned_agent_email.
    CREATE INDEX IF NOT EXISTS idx_support_threads_status   ON support_threads(status, last_customer_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_support_threads_customer ON support_threads(customer_email, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_support_threads_agent    ON support_threads(assigned_agent_email, status);
    CREATE INDEX IF NOT EXISTS idx_support_messages_thread  ON support_messages(thread_id, created_at);
    -- Escalation worker scans for un-fired rows whose fire_at has passed.
    CREATE INDEX IF NOT EXISTS idx_support_escalation_due   ON support_escalation_queue(fire_at) WHERE fired_at IS NULL;
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
  setDefault.run('max_devices_ultra', '10', Date.now());

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

  // Dedicated Razorpay subscription pointer. Pre-2026-05 the Razorpay
  // path was overloaded into `stripe_customer_id` with values like
  // `rzp_<paymentId>` (`rzp_` prefix used as a "this user is on Razorpay"
  // marker). That worked for provider-detection but was misleading
  // (anything calling `stripe.customers.retrieve(rzp_xxx)` would throw)
  // and the value churned with each payment. The new column stores
  // the SUBSCRIPTION id (stable across the lifecycle) directly, no
  // prefix. Backfill: strip `rzp_` from any existing stripe_customer_id
  // that uses the legacy convention.
  if (!userCols.find(c => c.name === 'razorpay_subscription_id')) {
    db.exec('ALTER TABLE users ADD COLUMN razorpay_subscription_id TEXT');
    db.exec("UPDATE users SET razorpay_subscription_id = SUBSTR(stripe_customer_id, 5) WHERE stripe_customer_id LIKE 'rzp_%'");
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

  // ── Server-tracked credits for the Basic tier ──
  // Previously credits_remaining_seconds was a CLIENT-only ledger written to
  // localStorage. That broke the cross-device renewal case: a user who paid
  // for a Basic +1h renewal on one device (or via the system browser opened
  // from Electron) saw the credit land in that device's localStorage only —
  // their Electron app's separate storage never picked it up. Money charged,
  // no time added on the device the user actually wanted to use. Tracking
  // server-side and echoing on /validate fixes the propagation cleanly.
  //
  // For existing Basic users at migration time, we backfill from the
  // session count: 1 unused session ≈ 1h. That's an approximation but
  // matches the original "3 credits = 3 hours" intent. Pro/Max get -1
  // (unlimited sentinel; mirrors sessions_limit/-expires_at convention).
  if (!licenseCols.find(c => c.name === 'credits_remaining_seconds')) {
    db.exec('ALTER TABLE licenses ADD COLUMN credits_remaining_seconds INTEGER DEFAULT 0');
    db.exec("UPDATE licenses SET credits_remaining_seconds = -1 WHERE tier IN ('pro', 'max')");
    db.exec("UPDATE licenses SET credits_remaining_seconds = MAX(0, (sessions_limit - sessions_used)) * 3600 WHERE tier = 'basic' AND credits_remaining_seconds = 0");
  }
  if (!licenseCols.find(c => c.name === 'credits_expire_at')) {
    db.exec('ALTER TABLE licenses ADD COLUMN credits_expire_at INTEGER DEFAULT 0');
    db.exec("UPDATE licenses SET credits_expire_at = -1 WHERE tier IN ('pro', 'max')");
    db.exec("UPDATE licenses SET credits_expire_at = expires_at WHERE tier = 'basic' AND credits_expire_at = 0 AND expires_at > 0");
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

  // ── Support agent presence — ntfy verification timestamps ──
  // 2026-05-13 follow-up: admins were confused whether they had to
  // re-subscribe to ntfy on every alert. Persisting these two
  // timestamps lets the inbox card render an unambiguous "✓ Push
  // active · last alert 3m ago" status instead of the open-ended
  // setup card every time.
  //   ntfy_verified_at  — when the most recent /test-alert returned
  //                       OK; set on the server so it survives a
  //                       client wipe / re-install.
  //   ntfy_last_alert_at — any successful push (test or production).
  //                        Drives the "last alert N ago" label.
  const presenceCols = db.prepare("PRAGMA table_info(support_agent_presence)").all();
  if (presenceCols.length > 0 && !presenceCols.find(c => c.name === 'ntfy_verified_at')) {
    db.exec('ALTER TABLE support_agent_presence ADD COLUMN ntfy_verified_at INTEGER');
  }
  if (presenceCols.length > 0 && !presenceCols.find(c => c.name === 'ntfy_last_alert_at')) {
    db.exec('ALTER TABLE support_agent_presence ADD COLUMN ntfy_last_alert_at INTEGER');
  }

  // ── Webhook event ordering (out-of-order resurrection guard) ──
  // Stripe doesn't guarantee delivery order. The reproducible bug:
  //   t=0  user clicks Cancel → customer.subscription.deleted emitted
  //   t=0  user immediately reactivates → customer.subscription.updated emitted
  //   t+1s .deleted arrives, sets status=canceled
  //   t+5s .updated arrives, blindly overwrites → status=active, tier=pro
  // Net: a user who genuinely canceled gets resurrected. Same hazard on
  // any out-of-order pair where the older event is destructive and the
  // newer one is constructive (or vice-versa, depending on direction of
  // staleness).
  // Fix: persist the highest event.created we've seen per license, and
  // gate every mutating handler on `event.created >= last_provider_event_at`.
  // Stale events fall through silently. Stripe sends event.created in
  // SECONDS — store seconds to match. New rows default to 0 so the very
  // first event is always accepted.
  if (!licenseCols.find(c => c.name === 'last_provider_event_at')) {
    db.exec('ALTER TABLE licenses ADD COLUMN last_provider_event_at INTEGER DEFAULT 0');
  }

  // Per-user daily counter for Gemini calls. Free tier is documented as
  // unlimited Gemini, but in practice an authenticated free user with a
  // forged JWT (the AI rate limiter's pre-pass doesn't verify JWT
  // signatures) could hit /chat/gemini in a hot loop and grind through
  // Google's API quota at our cost. 50 calls/day is generous for honest
  // use and a hard cap on abuse. Reset window stored as YYYY-MM-DD UTC
  // string so we don't have to compute a midnight rollover comparison
  // every request.
  if (!licenseCols.find(c => c.name === 'gemini_calls_today')) {
    db.exec('ALTER TABLE licenses ADD COLUMN gemini_calls_today INTEGER DEFAULT 0');
  }
  if (!licenseCols.find(c => c.name === 'gemini_calls_day')) {
    db.exec("ALTER TABLE licenses ADD COLUMN gemini_calls_day TEXT DEFAULT ''");
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
  // Truncate the revocation cutoff to the current SECOND. authMiddleware
  // compares JWT iat (seconds) against tokens_revoked_after as
  // `iat*1000 < revoked_after`. A caller that re-issues a token for the same
  // session immediately after this (PUT /auth/password, to keep the user
  // logged in) would otherwise have its brand-new token read as revoked —
  // a raw-ms Date.now() sits a few hundred ms past the new token's
  // second-floored iat*1000. Aligning the cutoff to the second boundary
  // lets the replacement token survive while every token issued in a prior
  // second is killed. Harmless for the reset flow, which re-logs in anyway.
  const now = Math.floor(Date.now() / 1000) * 1000;
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

// Updates the license row on payment. Optional credits_remaining_seconds /
// credits_expire_at are server-tracked so renewal grants propagate across
// devices. Callers that don't care about credits (e.g. the cancel-razorpay
// path that just pins expires_at) can omit them and the existing values
// stay in place via COALESCE on the UPDATE side.
function updateLicenseOnPayment(userId, { tier, status, expires_at, sessions_limit, credits_remaining_seconds, credits_expire_at }) {
  // Status validation — refuse to persist an unknown status. Without this
  // a typo at a call site (e.g. 'cancling' or 'past-due') would silently
  // succeed and only manifest later as the renderer's license validity
  // check failing in mysterious ways. See services/subscriptionStates.js
  // for the canonical state machine.
  const { assertValidStatus } = require('./services/subscriptionStates');
  assertValidStatus(status);

  const sets = ['tier = ?', 'status = ?', 'expires_at = ?', 'sessions_limit = ?'];
  const args = [tier, status, expires_at, sessions_limit];
  if (credits_remaining_seconds !== undefined) {
    sets.push('credits_remaining_seconds = ?');
    args.push(credits_remaining_seconds);
  }
  if (credits_expire_at !== undefined) {
    sets.push('credits_expire_at = ?');
    args.push(credits_expire_at);
  }
  args.push(userId);
  getDB().prepare(`UPDATE licenses SET ${sets.join(', ')} WHERE user_id = ?`).run(...args);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━
//  END-OF-CYCLE DOWNGRADE
// ━━━━━━━━━━━━━━━━━━━━━━━━━
// Central transition: paid → free. Called from THREE places so the
// state-machine never depends on a single signal:
//   1. Webhook handler (subscription.deleted / .halted / .completed)
//      — primary path, fastest reaction
//   2. Scheduled sweeper in server/src/index.js — fallback if the
//      webhook gets lost, retries exhaust, or there's a queue lag
//   3. /api/v1/license/validate — opportunistic: any time we observe
//      a 'canceling' license whose expires_at has passed, transition
//      it on the spot
//
// Idempotent: if the user is already on free, no-op + returns false.
// Otherwise updates the row to free-tier defaults (5 sessions/month
// for the free plan, no time credits) and returns true so the caller
// can fire the goodbye email exactly once.
function transitionLicenseToFree(userId, opts = {}) {
  const d = getDB();
  const cur = d.prepare('SELECT tier, status FROM licenses WHERE user_id = ?').get(userId);
  if (!cur) return false;
  if (cur.tier === 'free' && cur.status !== 'canceling') return false;

  const FREE_SESSIONS_LIMIT = 5;
  const FREE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  d.prepare(`
    UPDATE licenses
    SET tier = 'free',
        status = 'active',
        expires_at = ?,
        sessions_limit = ?
    WHERE user_id = ?
  `).run(now + FREE_PERIOD_MS, FREE_SESSIONS_LIMIT, userId);

  // Mirror tier onto the user row so downstream code that reads from
  // users.tier (rather than licenses.tier) stays consistent.
  try {
    d.prepare('UPDATE users SET tier = \'free\', updated_at = ? WHERE id = ?').run(now, userId);
  } catch { /* schema may not have updated_at; ignore */ }

  return {
    transitioned: true,
    from: { tier: cur.tier, status: cur.status },
    reason: opts.reason || 'cycle-end',
  };
}

// Returns user IDs whose licenses are 'canceling' AND past their
// expires_at — these are the rows the cycle-end sweeper should
// transition. Filtered to expires_at > 0 because -1 means "never"
// (lifetime grant — admin tools may set this).
function getExpiredCancelingUserIds(limit = 100) {
  return getDB().prepare(`
    SELECT user_id
    FROM licenses
    WHERE status = 'canceling'
      AND expires_at > 0
      AND expires_at < ?
    LIMIT ?
  `).all(Date.now(), limit).map(r => r.user_id);
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
    ultra: getConfig('max_devices_ultra', 10),
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

// ─── Per-user Gemini daily quota ─────────────────────────────────────
// Atomically increment and check the daily call counter. Returns:
//   { ok: true,  used, limit, day }  — call allowed, counter incremented
//   { ok: false, used, limit, day, reason: 'over_quota' } — over the cap
// `tier` lets us short-circuit for paid users (no cap). Day is UTC.
function incrementAndCheckGeminiQuota(userId, tier) {
  if (tier !== 'free') return { ok: true, unlimited: true };
  if (!userId) return { ok: true };
  const FREE_DAILY_LIMIT = 50;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const d = getDB();
  // Atomic CAS-style: compare day, reset to 1 if changed, else +1, then read.
  // SQLite serializes writes so two concurrent calls don't race past the limit.
  const tx = d.transaction(() => {
    const row = d.prepare('SELECT gemini_calls_today, gemini_calls_day FROM licenses WHERE user_id = ?').get(userId);
    if (!row) {
      // No license row — let the call through; the tier gate would have
      // caught a missing license before it reached this helper.
      return { ok: true, used: 0, limit: FREE_DAILY_LIMIT, day: today };
    }
    const sameDay = row.gemini_calls_day === today;
    const current = sameDay ? (row.gemini_calls_today || 0) : 0;
    if (current >= FREE_DAILY_LIMIT) {
      return { ok: false, used: current, limit: FREE_DAILY_LIMIT, day: today, reason: 'over_quota' };
    }
    const next = current + 1;
    d.prepare('UPDATE licenses SET gemini_calls_today = ?, gemini_calls_day = ? WHERE user_id = ?')
      .run(next, today, userId);
    return { ok: true, used: next, limit: FREE_DAILY_LIMIT, day: today };
  });
  return tx();
}

// ─── Out-of-order delivery gate ────────────────────────────────────────
// Returns:
//   { accept: true }  — caller should run the handler. last_provider_event_at
//                       is updated to max(current, eventCreatedSec).
//   { accept: false, reason, lastSeen } — event is older than the last
//                       processed one for this user. Caller MUST short-
//                       circuit the handler. Webhook still returns 200
//                       (we have already processed a newer state).
//
// `eventCreatedSec` is Stripe's `event.created` (UNIX seconds) or the
// equivalent we synthesize from Razorpay's `created_at` field. If the
// event has no timestamp (rare), we accept defensively (better to risk a
// stale resurrection than to permanently drop an event we have no way to
// order).
function gateAndRecordEventForUser(userId, eventCreatedSec) {
  if (!userId) return { accept: true };
  if (!Number.isFinite(eventCreatedSec) || eventCreatedSec <= 0) {
    return { accept: true };
  }
  const d = getDB();
  // Atomic: read current, compare, conditionally update — under SQLite's
  // single-writer lock + WAL this is consistent without an explicit
  // transaction. Two concurrent webhooks for the same user serialize on
  // the row write.
  const row = d.prepare('SELECT last_provider_event_at FROM licenses WHERE user_id = ?').get(userId);
  if (!row) {
    // No license yet (e.g. checkout.session.completed for a brand-new user
    // before the license row is created in the same transaction). Accept;
    // the handler will create the row with the right timestamp.
    return { accept: true };
  }
  const lastSeen = row.last_provider_event_at || 0;
  if (eventCreatedSec < lastSeen) {
    return { accept: false, reason: 'out_of_order', lastSeen, eventCreatedSec };
  }
  // Equal-or-newer: update and accept. Equal-only events are typically the
  // same delivery seen twice (the dedup table caught the dup but the gate
  // is wrapped around the dedup-first paths too — accept defensively).
  if (eventCreatedSec > lastSeen) {
    d.prepare('UPDATE licenses SET last_provider_event_at = ? WHERE user_id = ?').run(eventCreatedSec, userId);
  }
  return { accept: true };
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

// Basic-tier extension top-up: +1 session credit, +30 minutes. This is
// the 2026-07 "+30 min" extension ($25 / ₹2099 — RENEWAL_* constants in
// payments.js); the grant MUST match the marketed amount. It only adds
// to what's already there — NEVER reset back to a full Basic grant
// (that would be a re-purchase, not an extension).
//
// For unlimited licenses (sessions_limit === -1, expires_at === -1 —
// Ultra or admin comps), the extension product isn't offered in the UI;
// if it somehow triggered server-side, we leave the unlimited values
// intact and only flip status→active. For Free or expired users, we
// reactivate Basic with sessions_limit+1 and expires_at=now+30min —
// paying for a 30-minute session is a valid path.
function grantBasicRenewal(userId) {
  const license = getLicenseByUserId(userId);
  if (!license) return null;

  const ONE_HOUR_MS = 60 * 60 * 1000;
  const ONE_HOUR_S = 3600;
  let newLimit;
  let newExpiresAt;
  let newTier = 'basic';
  let newCreditsRemaining;
  let newCreditsExpireAt;

  if (license.sessions_limit === -1 || license.expires_at === -1) {
    // Pro/Max — leave unlimited values alone, just re-affirm active. This
    // branch is unreachable now that /create-renewal gates by tier='basic'
    // (Pro/Max can't pay for a renewal in the first place), but kept as
    // defense-in-depth so a legacy webhook re-running an old payment can't
    // overwrite an unlimited license with a 1-hour bucket.
    newTier = license.tier;
    newLimit = license.sessions_limit;
    newExpiresAt = license.expires_at;
    newCreditsRemaining = license.credits_remaining_seconds;
    newCreditsExpireAt = license.credits_expire_at;
  } else {
    newLimit = (license.sessions_limit || 0) + 1;
    // Anchor from whichever is later: now, or the existing expiry. Then
    // add 30 min. An already-expired license starts its new 30 min from
    // now; a still-valid one gets its expiry pushed out by 30 min.
    const EXTENSION_MS = ONE_HOUR_MS / 2;
    const EXTENSION_S = ONE_HOUR_S / 2;
    const base = Math.max(Date.now(), license.expires_at || 0);
    newExpiresAt = base + EXTENSION_MS;
    // Credit time top-up. If the previous credit window already expired,
    // start fresh from 0 (don't carry over stale time the user couldn't
    // have used anyway). Otherwise stack on top of the existing balance.
    const creditsValid = (license.credits_expire_at || 0) > Date.now();
    const existingCredits = creditsValid ? (license.credits_remaining_seconds || 0) : 0;
    newCreditsRemaining = existingCredits + EXTENSION_S;
    newCreditsExpireAt = newExpiresAt;
  }

  getDB().prepare(`
    UPDATE licenses SET
      tier = ?, status = 'active',
      expires_at = ?, sessions_limit = ?,
      credits_remaining_seconds = ?, credits_expire_at = ?
    WHERE user_id = ?
  `).run(newTier, newExpiresAt, newLimit, newCreditsRemaining, newCreditsExpireAt, userId);
  return getLicenseByUserId(userId);
}

// Look up a user's most recent Razorpay subscription id from the payments
// history — needed for the customer-initiated cancel flow since we don't
// store the active subscription id on the user row. Orders the query by
// created_at desc and filters to payments that actually carry a sub id
// (one-time Basic purchases won't match).
function getLatestRazorpaySubscriptionId(userId) {
  // Prefer the dedicated `users.razorpay_subscription_id` column (set
  // once per subscription, stable across renewals). Fall back to the
  // payments-table scan for legacy users whose column hasn't been
  // populated yet (e.g. subscription created before the schema
  // migration shipped).
  const u = getDB().prepare('SELECT razorpay_subscription_id FROM users WHERE id = ?').get(userId);
  if (u && u.razorpay_subscription_id) return u.razorpay_subscription_id;

  const row = getDB().prepare(`
    SELECT provider_subscription_id FROM payments
    WHERE user_id = ? AND provider = 'razorpay' AND provider_subscription_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(userId);
  return row ? row.provider_subscription_id : null;
}

// Stamp the user's Razorpay subscription id ONCE per subscription.
// Caller is the webhook (subscription.charged for first/recurring) or
// /verify-razorpay (client-side success handler). We only WRITE if the
// existing column is empty or different — avoids unnecessary churn on
// every renewal payment.
function setRazorpaySubscriptionId(userId, subscriptionId) {
  if (!subscriptionId) return;
  getDB().prepare(`
    UPDATE users
    SET razorpay_subscription_id = ?, updated_at = ?
    WHERE id = ? AND (razorpay_subscription_id IS NULL OR razorpay_subscription_id != ?)
  `).run(subscriptionId, Date.now(), userId, subscriptionId);
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
  // Comp grants are unlimited-until-revoked across every paid tier (2026-07).
  const grantConfig = {
    basic: { sessions_limit: -1, expires_at: -1 },
    pro:   { sessions_limit: -1, expires_at: -1 },
    max:   { sessions_limit: -1, expires_at: -1 },
    ultra: { sessions_limit: -1, expires_at: -1 },
  }[tier];
  if (!grantConfig) return null;
  // Capture the inserted payment row id so the admin audit entry can
  // reference it. Previously this function returned only the license row,
  // so `result.payment_id` in the grant-comp audit was always undefined
  // and the audit log column was blank for comp grants.
  let paymentId = null;
  const tx = d.transaction(() => {
    d.prepare('UPDATE users SET tier = ?, updated_at = ? WHERE id = ?').run(tier, Date.now(), userId);
    d.prepare('UPDATE licenses SET tier = ?, status = ?, expires_at = ?, sessions_limit = ?, credits_remaining_seconds = -1, credits_expire_at = -1 WHERE user_id = ?')
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
  // Was previously fire-and-forget — the caller (refund_payment bot
  // tool) used `const refundRow = db.recordAdminRefund(...)` and
  // serialized refundRow back to the model, which would JSON-stringify
  // to undefined. Return a useful summary so the bot can confirm the
  // refund row exists.
  const result = d.prepare(`
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
  return {
    id: result.lastInsertRowid,
    original_payment_id: originalPayment.id,
    amount: -(Math.abs(amount) || 0),
    currency: originalPayment.currency || 'USD',
    provider: originalPayment.provider,
    provider_refund_id: refundId || null,
  };
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
  const dau = q(1 * DAY_MS_CONST);
  const wau = q(7 * DAY_MS_CONST);
  const mau = q(30 * DAY_MS_CONST);
  return {
    dau, wau, mau,
    // Stickiness ratios (0–1, 2dp). getStats() returns these to the admin
    // dashboard but they were referenced without ever being computed here,
    // so the Overview tab rendered `undefined`. Divide-by-zero guarded for a
    // fresh/empty DB.
    dau_wau_ratio: wau > 0 ? Math.round((dau / wau) * 100) / 100 : 0,
    dau_mau_ratio: mau > 0 ? Math.round((dau / mau) * 100) / 100 : 0,
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
  const tiers = { free: 0, basic: 0, pro: 0, max: 0, ultra: 0 };
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SUPPORT BOT — helpers for thread/message persistence
//  (2026-05-13 — replaces ephemeral in-memory supportClients Map)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Thread create — first time we see a customer or they POST to /handoff.
// Generates a UUID via crypto.randomUUID (Node 14.17+). Status starts
// 'open'; gets flipped to 'assigned' on first agent message via
// claimSupportThread, and 'resolved' on resolveSupportThread.
function createSupportThread({
  customer_email,
  customer_name = null,
  customer_tier = null,
  customer_user_id = null,
  initial_question = null,
  channel = 'bot',
  customer_ip = null,
  customer_ua = null,
}) {
  const { randomUUID } = require('crypto');
  const id = randomUUID();
  const now = Date.now();
  getDB().prepare(`
    INSERT INTO support_threads (
      id, customer_email, customer_name, customer_tier, customer_user_id,
      status, initial_question, channel, customer_ip, customer_ua,
      created_at, last_customer_message_at
    ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    String(customer_email).toLowerCase(),
    customer_name,
    customer_tier,
    customer_user_id,
    initial_question,
    channel,
    customer_ip,
    customer_ua,
    now,
    now,   // last_customer_message_at — they just opened; first SLA tick starts now
  );
  return getSupportThread(id);
}

function getSupportThread(threadId) {
  return getDB().prepare('SELECT * FROM support_threads WHERE id = ?').get(threadId) || null;
}

// "Find the customer's MOST RECENT open or recently-resolved thread
// so we can resume it instead of opening a new one." Window of 7 days
// — older than that, treat as a fresh conversation. Prevents the
// inbox from accumulating one-thread-per-message for chatty users.
function findResumableSupportThread(customerEmail) {
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - SEVEN_DAYS;
  return getDB().prepare(`
    SELECT * FROM support_threads
     WHERE customer_email = ?
       AND status IN ('open', 'assigned')
       AND created_at > ?
     ORDER BY created_at DESC
     LIMIT 1
  `).get(String(customerEmail).toLowerCase(), cutoff) || null;
}

// Inbox query — the hot path for an admin staring at "what's waiting".
// Returns threads with their last message + unread-from-customer
// count so the UI doesn't have to do N+1 queries. `assignedTo` filter
// is optional (omit to see EVERY open thread, including unclaimed).
function listOpenSupportThreads({ assignedTo = null, limit = 100, includeResolved = false } = {}) {
  const statusFilter = includeResolved
    ? "(t.status = 'open' OR t.status = 'assigned' OR t.status = 'resolved')"
    : "(t.status = 'open' OR t.status = 'assigned')";
  const assignFilter = assignedTo ? "AND (t.assigned_agent_email = ? OR t.assigned_agent_email IS NULL)" : "";
  const stmt = getDB().prepare(`
    SELECT
      t.*,
      (SELECT COUNT(*) FROM support_messages m
         WHERE m.thread_id = t.id
           AND m.sender_role = 'customer'
           AND (m.read_by_other_at IS NULL OR m.read_by_other_at = 0))
        AS unread_from_customer,
      (SELECT text FROM support_messages m
         WHERE m.thread_id = t.id
         ORDER BY m.created_at DESC LIMIT 1)
        AS last_message_text,
      (SELECT sender_role FROM support_messages m
         WHERE m.thread_id = t.id
         ORDER BY m.created_at DESC LIMIT 1)
        AS last_message_role
    FROM support_threads t
    WHERE ${statusFilter} ${assignFilter}
    ORDER BY
      CASE t.status WHEN 'open' THEN 0 WHEN 'assigned' THEN 1 ELSE 2 END,
      COALESCE(t.last_customer_message_at, t.created_at) DESC
    LIMIT ?
  `);
  const rows = assignedTo
    ? stmt.all(assignedTo, Math.max(1, Math.min(500, limit | 0)))
    : stmt.all(Math.max(1, Math.min(500, limit | 0)));
  return rows;
}

function listSupportThreadsForCustomer(customerEmail, limit = 20) {
  return getDB().prepare(`
    SELECT * FROM support_threads
     WHERE customer_email = ?
     ORDER BY created_at DESC
     LIMIT ?
  `).all(String(customerEmail).toLowerCase(), Math.max(1, Math.min(100, limit | 0)));
}

// First agent to message a customer claims the thread. If already
// claimed by someone else, return null (caller surfaces a "taken by
// X" message to the second agent). This prevents two admins from
// double-replying when both are in the inbox simultaneously.
function claimSupportThread(threadId, agentEmail) {
  const now = Date.now();
  const existing = getSupportThread(threadId);
  if (!existing) return null;
  if (existing.assigned_agent_email && existing.assigned_agent_email !== agentEmail) {
    return { ok: false, reason: 'already_assigned', currentAgent: existing.assigned_agent_email };
  }
  // first_response_at is the SLA metric. Set only on FIRST claim — a
  // reclaim by the same agent after a customer reply must not reset it.
  const setFirstResponse = existing.first_response_at ? '' : ', first_response_at = ?';
  const args = existing.first_response_at
    ? [agentEmail, now, threadId]
    : [agentEmail, now, now, threadId];
  getDB().prepare(`
    UPDATE support_threads
       SET assigned_agent_email = ?,
           status = 'assigned',
           last_agent_message_at = ?
           ${setFirstResponse}
     WHERE id = ?
  `).run(...args);
  return { ok: true, thread: getSupportThread(threadId) };
}

function resolveSupportThread(threadId, { rating = null, comment = null } = {}) {
  const now = Date.now();
  getDB().prepare(`
    UPDATE support_threads
       SET status = 'resolved',
           resolved_at = ?,
           satisfaction_rating = COALESCE(?, satisfaction_rating),
           satisfaction_comment = COALESCE(?, satisfaction_comment)
     WHERE id = ?
  `).run(now, rating, comment, threadId);
  // Cancel any pending escalations — agent already resolved, don't
  // page their phone in 4 minutes for a closed ticket.
  cancelSupportEscalations(threadId);
  return getSupportThread(threadId);
}

function setSupportThreadTags(threadId, tagsArray) {
  const tags = Array.isArray(tagsArray) ? tagsArray.slice(0, 8).map(String) : [];
  getDB().prepare('UPDATE support_threads SET tags = ? WHERE id = ?')
    .run(JSON.stringify(tags), threadId);
}

// Append a message + bump the thread's recency markers in a single
// transaction. Returns the inserted message row so the WS handler can
// echo back its `created_at` for client-side dedup.
function appendSupportMessage({
  thread_id,
  sender_role,
  sender_email = null,
  sender_name = null,
  text,
  attachment_url = null,
  attachment_kind = null,
}) {
  const d = getDB();
  const now = Date.now();
  let inserted;
  const tx = d.transaction(() => {
    const info = d.prepare(`
      INSERT INTO support_messages (
        thread_id, sender_role, sender_email, sender_name, text,
        attachment_url, attachment_kind, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(thread_id, sender_role, sender_email, sender_name, String(text || ''),
            attachment_url, attachment_kind, now);
    inserted = { id: info.lastInsertRowid, thread_id, sender_role, sender_email, sender_name,
                  text, attachment_url, attachment_kind, created_at: now };

    // Recency markers — used by SLA computation and inbox ordering.
    if (sender_role === 'customer') {
      d.prepare('UPDATE support_threads SET last_customer_message_at = ? WHERE id = ?')
        .run(now, thread_id);
    } else if (sender_role === 'agent') {
      d.prepare(`
        UPDATE support_threads
           SET last_agent_message_at = ?,
               first_response_at = COALESCE(first_response_at, ?)
         WHERE id = ?
      `).run(now, now, thread_id);
    }
  });
  tx();
  return inserted;
}

function getSupportMessages(threadId, { since = null, limit = 500 } = {}) {
  const cap = Math.max(1, Math.min(2000, limit | 0));
  if (since) {
    return getDB().prepare(`
      SELECT * FROM support_messages
       WHERE thread_id = ? AND created_at > ?
       ORDER BY created_at ASC
       LIMIT ?
    `).all(threadId, since, cap);
  }
  return getDB().prepare(`
    SELECT * FROM support_messages
     WHERE thread_id = ?
     ORDER BY created_at ASC
     LIMIT ?
  `).all(threadId, cap);
}

// Mark every message in this thread NOT sent by `readerRole` as
// read by the other side. Caller passes 'agent' to mark all
// customer messages read (admin viewed the thread); 'customer' to
// mark all agent messages read (customer is reading replies).
function markSupportMessagesRead(threadId, readerRole) {
  const now = Date.now();
  getDB().prepare(`
    UPDATE support_messages
       SET read_by_other_at = ?
     WHERE thread_id = ?
       AND sender_role != ?
       AND (read_by_other_at IS NULL OR read_by_other_at = 0)
  `).run(now, threadId, readerRole);
}

// SLA classification. Mirrors the Zendesk/Intercom color scheme:
// green <30s, yellow 30s-2min, red >2min, gray once an agent has
// replied (waiting on customer now). Returns a string for the
// frontend; we don't store this — it's a function of NOW().
function computeSupportSlaState(thread) {
  if (!thread) return 'gray';
  if (thread.status === 'resolved') return 'gray';
  // If the last message was from the agent, the ball is in the
  // customer's court — no SLA pressure on us.
  const lastCust = thread.last_customer_message_at || 0;
  const lastAgent = thread.last_agent_message_at || 0;
  if (lastAgent > lastCust) return 'gray';
  // Customer is waiting. Compute their wait time.
  const waitMs = Date.now() - lastCust;
  if (waitMs < 30_000) return 'green';
  if (waitMs < 120_000) return 'yellow';
  return 'red';
}

// ── Agent presence ──
function getSupportAgentPresence(agentEmail) {
  const row = getDB().prepare('SELECT * FROM support_agent_presence WHERE agent_email = ?')
    .get(String(agentEmail).toLowerCase());
  return row || null;
}

// Upsert. Auto-generates an ntfy.sh topic on first call so each agent
// gets a private subscription URL they can install on their phone.
function setSupportAgentPresence({
  agent_email,
  status = 'offline',
  notification_prefs = null,
  ntfy_topic = null,
  twilio_phone = null,
}) {
  const now = Date.now();
  const email = String(agent_email).toLowerCase();
  const existing = getSupportAgentPresence(email);
  if (!existing) {
    const { randomBytes } = require('crypto');
    // 16 random url-safe bytes — collision probability is astronomical
    // even at 1M users, and the topic stays private (admin scans a
    // QR code or types it into the ntfy app).
    const topic = ntfy_topic || `minicaai-${randomBytes(8).toString('hex')}`;
    const defaultPrefs = JSON.stringify({
      desktop: true,
      slack: true,
      ntfy: true,
      email_after_min: 3,
      sms: false,
    });
    getDB().prepare(`
      INSERT INTO support_agent_presence (
        agent_email, status, last_heartbeat_at, notification_prefs, ntfy_topic, twilio_phone
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(email, status, now, notification_prefs || defaultPrefs, topic, twilio_phone);
    return getSupportAgentPresence(email);
  }
  // UPDATE — but only fields the caller passed. Pattern: build sets
  // dynamically so null arguments don't clobber existing values.
  const sets = ['status = ?', 'last_heartbeat_at = ?'];
  const args = [status, now];
  if (notification_prefs !== null) { sets.push('notification_prefs = ?'); args.push(notification_prefs); }
  if (ntfy_topic !== null)         { sets.push('ntfy_topic = ?'); args.push(ntfy_topic); }
  if (twilio_phone !== null)       { sets.push('twilio_phone = ?'); args.push(twilio_phone); }
  args.push(email);
  getDB().prepare(`UPDATE support_agent_presence SET ${sets.join(', ')} WHERE agent_email = ?`)
    .run(...args);
  return getSupportAgentPresence(email);
}

// Mark this agent's ntfy subscription verified. Called by /inbox/test-
// alert when the upstream POST returns 2xx — the assumption being
// that if our POST landed and they hit Send-test, their phone got
// the notification. (We can't actually CONFIRM the phone received
// it without a round-trip from the phone back to us, which ntfy
// hosted doesn't offer. This is the best signal we have.)
function markNtfyVerified(agentEmail) {
  const email = String(agentEmail).toLowerCase();
  const now = Date.now();
  // INSERT-or-UPDATE pattern: setSupportAgentPresence handles the
  // create-if-missing case, then we patch the verification fields.
  let presence = getSupportAgentPresence(email);
  if (!presence) presence = setSupportAgentPresence({ agent_email: email, status: 'online' });
  getDB().prepare(`
    UPDATE support_agent_presence
       SET ntfy_verified_at = ?, ntfy_last_alert_at = ?
     WHERE agent_email = ?
  `).run(now, now, email);
  return getSupportAgentPresence(email);
}

// Mark "we just sent an alert to this agent's topic" — used by the
// production escalation worker so the inbox card can show "last
// alert 3m ago" without the admin needing to send a test.
function markNtfyAlertSent(agentEmail) {
  const email = String(agentEmail).toLowerCase();
  getDB().prepare(`
    UPDATE support_agent_presence
       SET ntfy_last_alert_at = ?
     WHERE agent_email = ?
  `).run(Date.now(), email);
}

function heartbeatSupportAgent(agentEmail) {
  const now = Date.now();
  const email = String(agentEmail).toLowerCase();
  const existing = getSupportAgentPresence(email);
  if (!existing) {
    return setSupportAgentPresence({ agent_email: email, status: 'online' });
  }
  getDB().prepare('UPDATE support_agent_presence SET last_heartbeat_at = ?, status = ? WHERE agent_email = ?')
    .run(now, existing.status === 'offline' ? 'online' : existing.status, email);
  return getSupportAgentPresence(email);
}

// Online = heartbeat within last 90s. Awareness: agent that closed
// the app without explicit logout still flips to offline naturally.
function listOnlineSupportAgents() {
  const cutoff = Date.now() - 90_000;
  return getDB().prepare(`
    SELECT * FROM support_agent_presence
     WHERE last_heartbeat_at > ? AND status != 'offline'
     ORDER BY agent_email
  `).all(cutoff);
}

// ── Escalation queue ──
// On customer thread open, enqueue 4 escalation rows: ntfy at +30s,
// email at +2min, sms at +5min, fallback at +24h. Worker scans every
// 10s. Cancellation happens on claim or resolve.
function enqueueSupportEscalations(threadId, rows) {
  const stmt = getDB().prepare(`
    INSERT OR IGNORE INTO support_escalation_queue (thread_id, channel, fire_at)
    VALUES (?, ?, ?)
  `);
  for (const r of (rows || [])) {
    stmt.run(threadId, r.channel, r.fire_at);
  }
}

function getDueSupportEscalations(now = Date.now()) {
  return getDB().prepare(`
    SELECT q.*, t.assigned_agent_email, t.status, t.customer_email, t.customer_name, t.initial_question, t.id AS thread_id
      FROM support_escalation_queue q
      JOIN support_threads t ON t.id = q.thread_id
     WHERE q.fired_at IS NULL
       AND q.fire_at <= ?
       AND t.status = 'open'        -- skip if agent already claimed
     ORDER BY q.fire_at ASC
     LIMIT 50
  `).all(now);
}

function markSupportEscalationFired(threadId, channel) {
  getDB().prepare(`
    UPDATE support_escalation_queue
       SET fired_at = ?
     WHERE thread_id = ? AND channel = ? AND fired_at IS NULL
  `).run(Date.now(), threadId, channel);
}

// Called on claim/resolve — wipes any pending alerts for this thread
// so we don't phone-spam the admin after they've already replied.
function cancelSupportEscalations(threadId) {
  getDB().prepare(`
    UPDATE support_escalation_queue
       SET fired_at = ?
     WHERE thread_id = ? AND fired_at IS NULL
  `).run(Date.now(), threadId);
}

// Inbox stats — bottom-of-panel "X open · Y avg response time · Z today".
function getSupportInboxStats() {
  const d = getDB();
  const open = d.prepare("SELECT COUNT(*) AS n FROM support_threads WHERE status = 'open'").get().n;
  const assigned = d.prepare("SELECT COUNT(*) AS n FROM support_threads WHERE status = 'assigned'").get().n;
  const today = d.prepare("SELECT COUNT(*) AS n FROM support_threads WHERE created_at > ?")
    .get(Date.now() - 24 * 60 * 60 * 1000).n;
  // Average first-response time across resolved-with-response threads
  // in the last 7 days. NULL filtered out (no-response threads).
  const sevenDays = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const avg = d.prepare(`
    SELECT AVG(first_response_at - created_at) AS ms
      FROM support_threads
     WHERE first_response_at IS NOT NULL
       AND created_at > ?
  `).get(sevenDays);
  return {
    open,
    assigned,
    today,
    avg_first_response_ms: Math.round(avg?.ms || 0),
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
  setRazorpaySubscriptionId,
  // Cycle-end downgrade (paid → free safety net)
  transitionLicenseToFree, getExpiredCancelingUserIds,
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
  isPaymentAlreadyRecorded, gateAndRecordEventForUser,
  // AI quotas
  incrementAndCheckGeminiQuota,
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
  // Support bot — threads + messages
  createSupportThread, getSupportThread, findResumableSupportThread,
  listOpenSupportThreads, listSupportThreadsForCustomer,
  claimSupportThread, resolveSupportThread, setSupportThreadTags,
  appendSupportMessage, getSupportMessages, markSupportMessagesRead,
  computeSupportSlaState,
  // Support bot — agent presence + escalations
  getSupportAgentPresence, setSupportAgentPresence, heartbeatSupportAgent,
  markNtfyVerified, markNtfyAlertSent,
  listOnlineSupportAgents,
  enqueueSupportEscalations, getDueSupportEscalations,
  markSupportEscalationFired, cancelSupportEscalations,
  getSupportInboxStats,
  // Cleanup
  closeDB,
  // Password utils (for testing)
  hashPassword, verifyPassword,
};
