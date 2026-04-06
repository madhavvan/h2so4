const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const db = require('../database');

const router = express.Router();

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// Admin guard middleware
function adminOnly(req, res, next) {
  if (!ADMIN_EMAILS.includes(req.user.email)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ── Dashboard stats ──
router.get('/stats', authMiddleware, adminOnly, (req, res) => {
  try {
    const stats = db.getStats();
    res.json(stats);
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── List all users ──
router.get('/users', authMiddleware, adminOnly, (req, res) => {
  try {
    const users = db.getAllUsers();
    // Attach license info to each user
    const usersWithLicenses = users.map(u => {
      const license = db.getLicenseByUserId(u.id);
      const devices = db.getUserDevices(u.id);
      return { ...u, license, device_count: devices.length };
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

    // Get login history for this user
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

    // Include conversation messages for full detail
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

// ── Ban a user ──
router.post('/users/ban', authMiddleware, adminOnly, (req, res) => {
  try {
    const { email } = req.body;
    const user = db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    db.banUser(user.id);
    // Also revoke their license
    const license = db.getLicenseByUserId(user.id);
    if (license) db.revokeKey(license.key, req.user.email, 'User banned by admin');

    res.json({ success: true, message: `${email} has been banned` });
  } catch (err) {
    console.error('Ban error:', err);
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

// ── Upgrade user to Pro ──
router.post('/users/upgrade', authMiddleware, adminOnly, (req, res) => {
  try {
    const { email } = req.body;
    const user = db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    db.updateUserTier(user.id, 'pro');
    db.updateLicenseOnPayment(user.id, {
      tier: 'pro',
      status: 'active',
      expires_at: -1,
      sessions_limit: -1,
    });

    res.json({ success: true, message: `${email} upgraded to Pro` });
  } catch (err) {
    console.error('Upgrade error:', err);
    res.status(500).json({ error: 'Failed to upgrade user' });
  }
});

// ── Recent login activity ──
router.get('/logins', authMiddleware, adminOnly, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const logs = db.getRecentLogins(Math.min(limit, 200));
    res.json(logs);
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
    const payments = db.getAllPayments(Math.min(limit, 500));
    const stats = db.getPaymentStats();
    res.json({ payments, stats });
  } catch (err) {
    console.error('Payments error:', err);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// ── Unban a user ──
router.post('/users/unban', authMiddleware, adminOnly, (req, res) => {
  try {
    const { email } = req.body;
    const user = db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    db.getDB().prepare('UPDATE users SET is_banned = 0, updated_at = ? WHERE id = ?').run(Date.now(), user.id);
    res.json({ success: true, message: `${email} has been unbanned` });
  } catch (err) {
    console.error('Unban error:', err);
    res.status(500).json({ error: 'Failed to unban user' });
  }
});

// ── Downgrade user to free ──
router.post('/users/downgrade', authMiddleware, adminOnly, (req, res) => {
  try {
    const { email } = req.body;
    const user = db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    db.updateUserTier(user.id, 'free');
    db.updateLicenseOnPayment(user.id, {
      tier: 'free',
      status: 'active',
      expires_at: Date.now() + (30 * 24 * 60 * 60 * 1000),
      sessions_limit: 5,
    });

    res.json({ success: true, message: `${email} downgraded to free` });
  } catch (err) {
    console.error('Downgrade error:', err);
    res.status(500).json({ error: 'Failed to downgrade user' });
  }
});

module.exports = router;
