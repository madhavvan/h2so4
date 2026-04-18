const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const db = require('../database');

const router = express.Router();

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// ── Admin guard ──
function adminOnly(req, res, next) {
  if (!ADMIN_EMAILS.includes(req.user.email)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ── Tier definitions ──
// What a tier *means* in terms of license rows. These are the server's
// opinion of each tier — NOT the pricing model. Pro/Max both get unlimited
// because the client distinguishes Max capability via FEATURE_GATES, not
// via license row state.
const DAY_MS = 24 * 60 * 60 * 1000;
const TIER_LICENSE_DEFAULTS = {
  free:  { expires_at: () => Date.now() + 30 * DAY_MS, sessions_limit: 5 },
  basic: { expires_at: () => Date.now() + 14 * DAY_MS, sessions_limit: 3 },
  pro:   { expires_at: () => -1, sessions_limit: -1 },
  max:   { expires_at: () => -1, sessions_limit: -1 },
};
const VALID_TIERS = Object.keys(TIER_LICENSE_DEFAULTS);

// ── Audit helper ──
// Every write goes through this so admin activity has a trail. Never throws
// — if the audit insert fails we'd rather see the action succeed than block
// the admin on a logging bug.
function writeAudit(req, action, target, details) {
  try {
    db.logAdminAction(
      req.user.email,
      action,
      target?.id || null,
      target?.email || null,
      details || null,
    );
  } catch (err) {
    console.error('[admin] audit insert failed:', err.message);
  }
}

// ── Dashboard stats ──
router.get('/stats', authMiddleware, adminOnly, (req, res) => {
  try {
    res.json(db.getStats());
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── List all users ──
router.get('/users', authMiddleware, adminOnly, (req, res) => {
  try {
    const users = db.getAllUsers();
    const usersWithLicenses = users.map(u => {
      const license = db.getLicenseByUserId(u.id);
      const devices = db.getUserDevices(u.id);
      return { ...u, license, device_count: devices.filter(d => d.is_active).length };
    });
    res.json(usersWithLicenses);
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ── Search user by email (full A-Z data) ──
router.get('/users/search', authMiddleware, adminOnly, (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email query required' });

    const user = db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const license = db.getLicenseByUserId(user.id);
    const devices = db.getUserDevices(user.id);
    const payments = db.getPaymentsByUser(user.id);
    const conversations = db.getConversationsByUser(user.id);

    const loginLogs = db.getDB()
      .prepare('SELECT * FROM login_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(user.id);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        tier: user.tier,
        country_code: user.country_code,
        created_at: user.created_at,
        updated_at: user.updated_at,
        last_login_at: user.last_login_at,
        is_banned: user.is_banned,
        tokens_revoked_after: user.tokens_revoked_after || 0,
        avatar_url: user.avatar_url,
        oauth_provider: user.oauth_provider,
        stripe_customer_id: user.stripe_customer_id,
      },
      license,
      devices,
      payments,
      conversations: conversations.map(c => ({
        id: c.id,
        name: c.name,
        created_at: c.created_at,
        updated_at: c.updated_at,
        message_count: db.getConversationMessages(c.id).length,
      })),
      login_history: loginLogs,
    });
  } catch (err) {
    console.error('Search user error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ── Get full user detail by ID (A-Z view) ──
router.get('/users/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const user = db.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const license = db.getLicenseByUserId(user.id);
    const devices = db.getUserDevices(user.id);
    const payments = db.getPaymentsByUser(user.id);
    const conversations = db.getConversationsByUser(user.id);
    const loginLogs = db.getDB()
      .prepare('SELECT * FROM login_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(user.id);

    const conversationsWithMessages = conversations.map(c => ({
      ...c,
      messages: db.getConversationMessages(c.id),
    }));

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        tier: user.tier,
        country_code: user.country_code,
        created_at: user.created_at,
        updated_at: user.updated_at,
        last_login_at: user.last_login_at,
        is_banned: user.is_banned,
        tokens_revoked_after: user.tokens_revoked_after || 0,
        avatar_url: user.avatar_url,
        oauth_provider: user.oauth_provider,
        stripe_customer_id: user.stripe_customer_id,
      },
      license,
      devices,
      payments,
      conversations: conversationsWithMessages,
      login_history: loginLogs,
    });
  } catch (err) {
    console.error('Get user detail error:', err);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TIER MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Shared handler so the canonical endpoint and the legacy aliases stay in sync.
function handleChangeTier(req, res) {
  try {
    const { email, tier } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    if (!VALID_TIERS.includes(tier)) {
      return res.status(400).json({ error: `tier must be one of: ${VALID_TIERS.join(', ')}` });
    }

    const user = db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const previousTier = user.tier;
    const defaults = TIER_LICENSE_DEFAULTS[tier];

    db.updateUserTier(user.id, tier);
    db.updateLicenseOnPayment(user.id, {
      tier,
      status: 'active',
      expires_at: defaults.expires_at(),
      sessions_limit: defaults.sessions_limit,
    });

    writeAudit(req, 'change-tier', user, { from: previousTier, to: tier });
    res.json({ success: true, message: `${email} moved to ${tier}`, tier });
  } catch (err) {
    console.error('Change tier error:', err);
    res.status(500).json({ error: 'Failed to change tier' });
  }
}

// Canonical — body: { email, tier: 'free'|'basic'|'pro'|'max' }
router.post('/users/change-tier', authMiddleware, adminOnly, handleChangeTier);

// Legacy aliases. Older client builds call these — map them onto change-tier
// by rewriting the body in-place, then delegating to the shared handler.
router.post('/users/upgrade', authMiddleware, adminOnly, (req, res) => {
  req.body = { ...(req.body || {}), tier: req.body?.tier || 'pro' };
  return handleChangeTier(req, res);
});

router.post('/users/downgrade', authMiddleware, adminOnly, (req, res) => {
  req.body = { ...(req.body || {}), tier: 'free' };
  return handleChangeTier(req, res);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CREDITS + EXPIRY
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Body: { email, credits: N (integer, may be negative to revoke) }
// No-op on Pro/Max (unlimited licenses aren't credit-based).
router.post('/users/grant-credits', authMiddleware, adminOnly, (req, res) => {
  try {
    const { email, credits } = req.body || {};
    const n = Number(credits);
    if (!email || !Number.isFinite(n) || n === 0) {
      return res.status(400).json({ error: 'email + non-zero credits required' });
    }

    const user = db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const updated = db.grantCreditSessions(user.id, n);
    if (!updated) return res.status(404).json({ error: 'User has no license' });

    writeAudit(req, 'grant-credits', user, { credits: n, new_limit: updated.sessions_limit });
    res.json({
      success: true,
      message: `${n > 0 ? 'Granted' : 'Revoked'} ${Math.abs(n)} credit(s) for ${email}`,
      license: updated,
    });
  } catch (err) {
    console.error('Grant credits error:', err);
    res.status(500).json({ error: 'Failed to grant credits' });
  }
});

// Body: { email, days: N (integer) }
// No-op on Pro/Max (expires_at=-1 never-expires).
router.post('/users/extend-expiry', authMiddleware, adminOnly, (req, res) => {
  try {
    const { email, days } = req.body || {};
    const n = Number(days);
    if (!email || !Number.isFinite(n) || n === 0) {
      return res.status(400).json({ error: 'email + non-zero days required' });
    }

    const user = db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const updated = db.extendLicenseExpiry(user.id, n);
    if (!updated) return res.status(404).json({ error: 'User has no license' });

    writeAudit(req, 'extend-expiry', user, { days: n, new_expires_at: updated.expires_at });
    res.json({
      success: true,
      message: `${n > 0 ? 'Added' : 'Removed'} ${Math.abs(n)} day(s) for ${email}`,
      license: updated,
    });
  } catch (err) {
    console.error('Extend expiry error:', err);
    res.status(500).json({ error: 'Failed to extend expiry' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DEVICE + SESSION MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Clear all device bindings for a user. Classic support case:
// "I got a new laptop and can't sign in." Forces re-registration on
// next login without touching their license or credits.
router.post('/users/reset-devices', authMiddleware, adminOnly, (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });

    const user = db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const changes = db.resetUserDevices(user.id);
    writeAudit(req, 'reset-devices', user, { devices_cleared: changes });
    res.json({ success: true, message: `Cleared ${changes} device(s) for ${email}` });
  } catch (err) {
    console.error('Reset devices error:', err);
    res.status(500).json({ error: 'Failed to reset devices' });
  }
});

// Invalidate all outstanding JWTs for a user. They stay signed in on the
// current device until the next API call, at which point the auth middleware
// will reject their token and they'll be forced to sign in again.
router.post('/users/force-logout', authMiddleware, adminOnly, (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });

    const user = db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    db.forceLogoutUser(user.id);
    writeAudit(req, 'force-logout', user);
    res.json({ success: true, message: `All sessions invalidated for ${email}` });
  } catch (err) {
    console.error('Force logout error:', err);
    res.status(500).json({ error: 'Failed to force logout' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  BAN / UNBAN / REVOKE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

router.post('/users/ban', authMiddleware, adminOnly, (req, res) => {
  try {
    const { email, reason } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });

    const user = db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    db.banUser(user.id);
    db.forceLogoutUser(user.id); // so they're kicked out of any live session
    const license = db.getLicenseByUserId(user.id);
    if (license) db.revokeKey(license.key, req.user.email, reason || 'User banned by admin');

    writeAudit(req, 'ban', user, { reason: reason || null });
    res.json({ success: true, message: `${email} has been banned` });
  } catch (err) {
    console.error('Ban error:', err);
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

router.post('/users/unban', authMiddleware, adminOnly, (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });

    const user = db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    db.unbanUser(user.id);
    // Un-revoke the license too so they can log back in.
    const license = db.getLicenseByUserId(user.id);
    if (license) db.unrevokeKey(license.key);

    writeAudit(req, 'unban', user);
    res.json({ success: true, message: `${email} has been unbanned` });
  } catch (err) {
    console.error('Unban error:', err);
    res.status(500).json({ error: 'Failed to unban user' });
  }
});

// ── Recent login activity ──
router.get('/logins', authMiddleware, adminOnly, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    res.json(db.getRecentLogins(Math.min(limit, 200)));
  } catch (err) {
    console.error('Logins error:', err);
    res.status(500).json({ error: 'Failed to fetch login logs' });
  }
});

// ── Revoked keys list ──
router.get('/revoked', authMiddleware, adminOnly, (req, res) => {
  try {
    res.json(db.getRevokedKeys());
  } catch (err) {
    console.error('Revoked keys error:', err);
    res.status(500).json({ error: 'Failed to fetch revoked keys' });
  }
});

// ── Payment history (all users) ──
router.get('/payments', authMiddleware, adminOnly, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    res.json({
      payments: db.getAllPayments(Math.min(limit, 500)),
      stats: db.getPaymentStats(),
    });
  } catch (err) {
    console.error('Payments error:', err);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// ── Audit log (paginated by limit) ──
router.get('/audit-log', authMiddleware, adminOnly, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    res.json(db.getAuditLog(limit));
  } catch (err) {
    console.error('Audit log error:', err);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

module.exports = router;
