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

// ── Search user by email ──
router.get('/users/search', authMiddleware, adminOnly, (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email query required' });

    const user = db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const license = db.getLicenseByUserId(user.id);
    const devices = db.getUserDevices(user.id);

    res.json({
      user: { id: user.id, email: user.email, name: user.name, tier: user.tier, country_code: user.country_code, created_at: user.created_at, last_login_at: user.last_login_at, is_banned: user.is_banned },
      license,
      devices,
    });
  } catch (err) {
    console.error('Search user error:', err);
    res.status(500).json({ error: 'Search failed' });
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

module.exports = router;
