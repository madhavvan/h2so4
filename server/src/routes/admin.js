// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADMIN API — enterprise-level admin surface
//
//  Ownership model:
//    • authMiddleware verifies the JWT and loads the user (global)
//    • adminOnly verifies the caller's email is in ADMIN_EMAILS
//    • stepUpOnly additionally verifies the JWT carries a recent
//      stepUp=true claim (see /reauth). Destructive/high-blast-radius
//      actions require step-up — refunds, tier grants, delete user,
//      impersonate, comp payment, config writes.
//
//  Every write goes through writeAudit() which inserts a row into
//  audit_log. That table is protected by SQLite triggers that RAISE
//  ABORT on UPDATE/DELETE — even the admin's own DB role cannot tamper
//  with history from SQL. Rotate/archive by inserting compensating rows.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const express = require('express');
const jwt = require('jsonwebtoken');
const { authMiddleware, generateToken } = require('../middleware/auth');
const { adminOnly, stepUpOnly, writeAudit, ADMIN_EMAILS, STEP_UP_TTL_MS } = require('../middleware/admin');
const db = require('../database');

const router = express.Router();

// ── Payment providers (loaded lazily for refund/cancel) ──
let stripe = null;
let razorpay = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  const Razorpay = require('razorpay');
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

// ── Tier definitions ──
const DAY_MS = 24 * 60 * 60 * 1000;
const TIER_LICENSE_DEFAULTS = {
  free:  { expires_at: () => Date.now() + 30 * DAY_MS, sessions_limit: 5 },
  basic: { expires_at: () => Date.now() + 14 * DAY_MS, sessions_limit: 3 },
  pro:   { expires_at: () => -1, sessions_limit: -1 },
  max:   { expires_at: () => -1, sessions_limit: -1 },
};
const VALID_TIERS = Object.keys(TIER_LICENSE_DEFAULTS);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  STEP-UP REAUTH
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// POST /reauth — { password } → { token } (same-user, stepUp=true, 15-min)
router.post('/reauth', authMiddleware, adminOnly, (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Password required' });

    const verified = db.verifyUserPassword(req.user.email, password);
    if (!verified) {
      writeAudit(req, 'reauth-failed', { email: req.user.email });
      return res.status(401).json({ error: 'Invalid password' });
    }

    const now = Date.now();
    const token = generateToken({
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      tier: req.user.tier,
      stepUp: true,
      stepUpAt: now,
    });

    writeAudit(req, 'reauth-success', { id: req.user.id, email: req.user.email });
    res.json({
      token,
      step_up_expires_at: now + STEP_UP_TTL_MS,
    });
  } catch (err) {
    console.error('Reauth error:', err);
    res.status(500).json({ error: 'Reauth failed' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  STATS + OVERVIEW
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

router.get('/stats', authMiddleware, adminOnly, (req, res) => {
  try {
    res.json(db.getStats());
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Daily time-series for Analytics tab. `days` defaults to 30, clamped to 180.
router.get('/trends', authMiddleware, adminOnly, (req, res) => {
  try {
    const days = Math.max(1, Math.min(180, parseInt(req.query.days) || 30));
    res.json(db.getTrends(days));
  } catch (err) {
    console.error('Trends error:', err);
    res.status(500).json({ error: 'Failed to fetch trends' });
  }
});

// Leaderboard of highest-revenue paying users. `limit` defaults to 10.
router.get('/top-customers', authMiddleware, adminOnly, (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 10));
    res.json(db.getTopCustomers(limit));
  } catch (err) {
    console.error('Top customers error:', err);
    res.status(500).json({ error: 'Failed to fetch top customers' });
  }
});

// Suspicious-activity surface (multi-country usage, brute-force candidates).
router.get('/suspicious', authMiddleware, adminOnly, (req, res) => {
  try {
    res.json(db.getSuspiciousActivity());
  } catch (err) {
    console.error('Suspicious error:', err);
    res.status(500).json({ error: 'Failed to fetch suspicious activity' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  USERS — list / search / detail / edit / delete / DSAR / impersonate
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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
      user: serializeUserRow(user),
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

    // Audit-log every full user-detail fetch. The conversation messages
    // are sensitive (interview answers, sometimes PII), so we want a
    // record of which admin pulled which user's data and when.
    writeAudit(req, 'view-user-detail', user, {
      conversation_count: conversations.length,
      message_count: conversationsWithMessages.reduce((sum, c) => sum + (c.messages?.length || 0), 0),
    });

    res.json({
      user: serializeUserRow(user),
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

// DSAR export — GDPR Article 15 data subject access request. Returns a
// complete bundle of everything we have on a single user, with sensitive
// server-only fields (password_hash) stripped. Intended for download as JSON.
// DSAR export downloads everything we have on a user — emails, payment
// data, full conversation history. That's a strict GDPR record + a real
// privacy concern if a stolen admin session triggered it. Step-up gates it.
router.get('/users/:id/export', authMiddleware, adminOnly, stepUpOnly, (req, res) => {
  try {
    const bundle = db.getUserDataExport(req.params.id);
    if (!bundle) return res.status(404).json({ error: 'User not found' });

    writeAudit(req, 'dsar-export', { id: bundle.user.id, email: bundle.user.email }, {
      payment_count: bundle.payments?.length || 0,
      conversation_count: bundle.conversations?.length || 0,
    });

    // Download-friendly filename. Safe fallback if email is missing.
    const fname = `minicaai-dsar-${(bundle.user.email || bundle.user.id).replace(/[^a-z0-9@._-]+/gi, '_')}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(bundle, null, 2));
  } catch (err) {
    console.error('DSAR export error:', err);
    res.status(500).json({ error: 'Failed to export user data' });
  }
});

// PATCH /users/:id — update name and/or country_code. Whitelisted columns
// only. Country is normalized to uppercase ISO-2 by the DB helper.
router.patch('/users/:id', authMiddleware, adminOnly, stepUpOnly, (req, res) => {
  try {
    const user = db.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { name, country_code } = req.body || {};
    if (name === undefined && country_code === undefined) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const updated = db.updateUserProfile(user.id, { name, country_code });
    if (!updated) return res.status(500).json({ error: 'Update failed' });

    writeAudit(req, 'edit-profile', user, {
      before: { name: user.name, country_code: user.country_code },
      after: { name: updated.name, country_code: updated.country_code },
    });
    res.json({ success: true, user: serializeUserRow(updated) });
  } catch (err) {
    console.error('Edit profile error:', err);
    res.status(500).json({ error: err.message || 'Failed to update profile' });
  }
});

// DELETE /users/:id — hard delete, transactional. Use with extreme care:
// all conversations, payments, login logs, devices, and licenses are
// permanently removed. Audit log rows that target this user by id remain
// (audit_log stores target_user_id as a plain column, no FK), so the
// paper trail survives.
router.delete('/users/:id', authMiddleware, adminOnly, stepUpOnly, (req, res) => {
  try {
    const user = db.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Self-delete guard — prevents an admin from locking themselves out by
    // accident. If you truly need to remove an admin account, temporarily
    // drop them from ADMIN_EMAILS in env first.
    if (user.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    if (ADMIN_EMAILS.includes((user.email || '').toLowerCase())) {
      return res.status(400).json({ error: 'Cannot delete another admin account — remove from ADMIN_EMAILS first' });
    }

    // Write audit row BEFORE the delete. Once the user is gone, any attempt
    // to log by user_id would tombstone with a null FK (we keep the target
    // as a plain column, but log-before-delete makes intent clearer).
    writeAudit(req, 'delete-user', user, {
      reason: req.body?.reason || null,
      conversation_count: db.getConversationsByUser(user.id).length,
      payment_count: db.getPaymentsByUser(user.id).length,
    });

    db.deleteUser(user.id);
    res.json({ success: true, message: `User ${user.email} permanently deleted` });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: err.message || 'Failed to delete user' });
  }
});

// POST /users/:id/impersonate — issue a scoped JWT that logs in AS the
// target user. The issued token is marked impersonatedBy=admin_email,
// impersonatedAt=ms so downstream writes can be audited. Expires in 30 min.
router.post('/users/:id/impersonate', authMiddleware, adminOnly, stepUpOnly, (req, res) => {
  try {
    const user = db.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.is_banned) return res.status(400).json({ error: 'Cannot impersonate a banned user' });

    const token = generateToken({
      id: user.id,
      email: user.email,
      name: user.name,
      tier: user.tier,
      impersonatedBy: req.user.email,
      impersonatedAt: Date.now(),
    }, '30m');

    writeAudit(req, 'impersonate', user, { reason: req.body?.reason || null });
    res.json({
      token,
      user: serializeUserRow(user),
      expires_in_seconds: 30 * 60, // 30m — scoped token, short-lived
      warning: 'All actions taken under this token will be attributed to the target user AND audit-logged against the admin.',
    });
  } catch (err) {
    console.error('Impersonate error:', err);
    res.status(500).json({ error: 'Failed to impersonate' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TIER MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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

router.post('/users/change-tier', authMiddleware, adminOnly, stepUpOnly, handleChangeTier);

router.post('/users/upgrade', authMiddleware, adminOnly, stepUpOnly, (req, res) => {
  req.body = { ...(req.body || {}), tier: req.body?.tier || 'pro' };
  return handleChangeTier(req, res);
});

router.post('/users/downgrade', authMiddleware, adminOnly, stepUpOnly, (req, res) => {
  req.body = { ...(req.body || {}), tier: 'free' };
  return handleChangeTier(req, res);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CREDITS + EXPIRY
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Mutates a user's session/credit balance — money-equivalent operation
// (admin can grant unlimited paid time). Step-up required.
router.post('/users/grant-credits', authMiddleware, adminOnly, stepUpOnly, (req, res) => {
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

// Pushes a user's license expiry — money-equivalent (admin can grant
// indefinite access). Step-up required.
router.post('/users/extend-expiry', authMiddleware, adminOnly, stepUpOnly, (req, res) => {
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

// Comp payment — grants a tier at zero cost. Creates a payment row with
// provider='admin-comp', amount=0, metadata.mode='admin_comp' so analytics
// exclude it from revenue. Use for support make-goods, influencer comps, etc.
router.post('/users/:id/grant-comp', authMiddleware, adminOnly, stepUpOnly, (req, res) => {
  try {
    const user = db.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { tier, note } = req.body || {};
    const targetTier = VALID_TIERS.includes(tier) ? tier : 'pro';
    if (targetTier === 'free') {
      return res.status(400).json({ error: 'Use change-tier to move a user to free; comp is for paid tiers' });
    }

    const result = db.recordCompPayment(user.id, targetTier, note || null);

    writeAudit(req, 'grant-comp', user, {
      tier: targetTier,
      note: note || null,
      payment_id: result.payment_id,
    });
    res.json({
      success: true,
      message: `${user.email} granted ${targetTier} as comp`,
      ...result,
    });
  } catch (err) {
    console.error('Grant comp error:', err);
    res.status(500).json({ error: err.message || 'Failed to grant comp' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DEVICE + SESSION MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Wipes ALL device bindings for a user — kicks them off every machine.
// High-impact (locks legitimate user out until they re-bind) so step-up.
router.post('/users/reset-devices', authMiddleware, adminOnly, stepUpOnly, (req, res) => {
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

// Revoke a SINGLE device by its row id. More surgical than reset-devices —
// lets support deactivate the lost/stolen laptop without kicking the user
// off their phone.
router.post('/users/:id/devices/:deviceRowId/revoke', authMiddleware, adminOnly, (req, res) => {
  try {
    const user = db.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const deviceRowId = parseInt(req.params.deviceRowId, 10);
    if (!Number.isFinite(deviceRowId)) return res.status(400).json({ error: 'Invalid device id' });

    const changed = db.revokeSingleDevice(deviceRowId, user.id);
    if (!changed) return res.status(404).json({ error: 'Device not found for this user' });

    writeAudit(req, 'revoke-device', user, { device_row_id: deviceRowId });
    res.json({ success: true, message: 'Device revoked' });
  } catch (err) {
    console.error('Revoke device error:', err);
    res.status(500).json({ error: 'Failed to revoke device' });
  }
});

// Invalidates all sessions for a user — they'll be logged out everywhere.
// Less destructive than reset-devices (re-bind not required) but still
// disruptive mid-interview, so step-up gates it.
router.post('/users/force-logout', authMiddleware, adminOnly, stepUpOnly, (req, res) => {
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
//  CONVERSATIONS (admin delete + recent cross-user feed)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /conversations/recent — latest N conversations across every user.
// Powers the admin Conversations tab. Previews contain interview content,
// so we write an audit row on every fetch for traceability.
router.get('/conversations/recent', authMiddleware, adminOnly, (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 50));
    const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : null;
    const rows = db.getRecentConversationsAcrossUsers({ limit, q });
    writeAudit(req, 'view-recent-conversations', null, { limit, q, count: rows.length });
    res.json(rows);
  } catch (err) {
    console.error('Recent conversations error:', err);
    res.status(500).json({ error: 'Failed to fetch recent conversations' });
  }
});

router.delete('/users/:id/conversations/:convId', authMiddleware, adminOnly, stepUpOnly, (req, res) => {
  try {
    const user = db.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const conv = db.getConversationById(req.params.convId);
    if (!conv || conv.user_id !== user.id) {
      return res.status(404).json({ error: 'Conversation not found for this user' });
    }

    const messageCount = db.getConversationMessages(conv.id).length;
    db.deleteConversationByAdmin(conv.id, user.id);

    writeAudit(req, 'delete-conversation', user, {
      conversation_id: conv.id,
      conversation_name: conv.name,
      message_count: messageCount,
    });
    res.json({ success: true, message: `Conversation deleted (${messageCount} messages)` });
  } catch (err) {
    console.error('Delete conversation error:', err);
    res.status(500).json({ error: err.message || 'Failed to delete conversation' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  BAN / UNBAN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Bans a user — revokes license, force-logs-out, blocks sign-in. Hard
// destructive action; admin password re-confirmation gates it.
router.post('/users/ban', authMiddleware, adminOnly, stepUpOnly, (req, res) => {
  try {
    const { email, reason } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });

    const user = db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    db.banUser(user.id);
    db.forceLogoutUser(user.id);
    const license = db.getLicenseByUserId(user.id);
    if (license) db.revokeKey(license.key, req.user.email, reason || 'User banned by admin');

    writeAudit(req, 'ban', user, { reason: reason || null });
    res.json({ success: true, message: `${email} has been banned` });
  } catch (err) {
    console.error('Ban error:', err);
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

// Unban — restoring access also matters; gate with step-up so a stolen
// admin token can't quietly re-enable a banned account.
router.post('/users/unban', authMiddleware, adminOnly, stepUpOnly, (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });

    const user = db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    db.unbanUser(user.id);
    const license = db.getLicenseByUserId(user.id);
    if (license) db.unrevokeKey(license.key);

    writeAudit(req, 'unban', user);
    res.json({ success: true, message: `${email} has been unbanned` });
  } catch (err) {
    console.error('Unban error:', err);
    res.status(500).json({ error: 'Failed to unban user' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PASSWORD RESET (admin-triggered)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// POST /users/:id/send-password-reset — issues a reset token and emails
// it to the user. Same token format as /auth/forgot-password — we simply
// skip the "does this email exist" gate because an admin has already
// picked a concrete user.
router.post('/users/:id/send-password-reset', authMiddleware, adminOnly, async (req, res) => {
  try {
    const user = db.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.email) {
      return res.status(400).json({ error: 'User has no email — cannot send reset link' });
    }

    const rawToken = db.createPasswordResetToken(user.id, user.email);
    const serverUrl = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`;
    const resetUrl = `${serverUrl}/api/v1/auth/reset-password?token=${rawToken}`;

    const { sendMail, renderPasswordResetEmail } = require('../email');
    const { subject, html, text } = renderPasswordResetEmail({ name: user.name, resetUrl });

    // AWAIT the send so we can surface the actual delivery result to the
    // admin instead of always reporting "success" while silently failing.
    // The token is already created either way; if email fails, the admin
    // can copy the URL from logs or retry.
    let mailResult;
    try {
      mailResult = await sendMail({ to: user.email, subject, html, text });
    } catch (err) {
      mailResult = { ok: false, reason: (err && err.message) || 'sendMail threw' };
    }

    writeAudit(req, 'send-password-reset', user, {
      mail_ok: !!mailResult?.ok,
      mail_reason: mailResult?.reason || null,
    });

    if (!mailResult?.ok) {
      // Still 200 — the reset TOKEN was created (admin can hand-copy if
      // needed). But surface the email failure so admin knows the link
      // didn't reach the user's inbox.
      return res.json({
        success: true,
        delivered: false,
        message: `Reset link generated, but EMAIL DELIVERY FAILED (${mailResult?.reason || 'unknown'}). Copy the URL manually if needed.`,
      });
    }

    res.json({ success: true, delivered: true, message: `Password reset email sent to ${user.email}` });
  } catch (err) {
    console.error('Send password reset error:', err);
    res.status(500).json({ error: 'Failed to send password reset' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SUBSCRIPTION CANCEL (admin-initiated)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// POST /users/:id/cancel-subscription — calls the appropriate provider
// (Stripe/Razorpay) to cancel at period end. Final tier downgrade lands
// via the subscription.cancelled / customer.subscription.deleted webhook.
router.post('/users/:id/cancel-subscription', authMiddleware, adminOnly, stepUpOnly, async (req, res) => {
  try {
    const user = db.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const customerId = user.stripe_customer_id || '';
    const isRazorpay = customerId.startsWith('rzp_');

    if (isRazorpay) {
      if (!razorpay) return res.status(503).json({ error: 'Razorpay not configured' });
      const subId = db.getLatestRazorpaySubscriptionId(user.id);
      if (!subId) return res.status(404).json({ error: 'No Razorpay subscription found for user' });
      // cancel_at_cycle_end=false → Razorpay keeps access until period end
      // (counter-intuitive naming in their API).
      await razorpay.subscriptions.cancel(subId, false);
      writeAudit(req, 'cancel-subscription', user, { provider: 'razorpay', subscription_id: subId });
      return res.json({
        success: true,
        message: 'Razorpay subscription will cancel at end of current billing period',
        provider: 'razorpay',
        subscription_id: subId,
      });
    }

    // Stripe path — user must have a stripe_customer_id (non-rzp).
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
    if (!customerId) return res.status(404).json({ error: 'No Stripe customer id on user' });

    const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 3 });
    if (!subs.data.length) {
      return res.status(404).json({ error: 'No active Stripe subscription found' });
    }

    const results = [];
    for (const sub of subs.data) {
      const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
      results.push({ id: sub.id, cancel_at: updated.cancel_at });
    }

    writeAudit(req, 'cancel-subscription', user, { provider: 'stripe', subscriptions: results });
    res.json({
      success: true,
      message: `${results.length} Stripe subscription(s) scheduled to cancel at period end`,
      provider: 'stripe',
      subscriptions: results,
    });
  } catch (err) {
    console.error('Admin cancel subscription error:', err);
    res.status(500).json({ error: err.message || 'Failed to cancel subscription' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  REFUNDS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// POST /payments/:id/refund — body { amount?, reason? }
// Calls Stripe/Razorpay refunds API. The webhook handlers (charge.refunded,
// refund.processed) will record the negative-amount row and downgrade the
// user. Here we only idempotency-check and call the provider; we also write
// a local compensating row IMMEDIATELY so the UI shows the state change
// without waiting for a webhook round-trip. The webhook is idempotent (uses
// event_id in webhook_events), so it won't double-record.
router.post('/payments/:id/refund', authMiddleware, adminOnly, stepUpOnly, async (req, res) => {
  try {
    const payment = db.getPaymentById(parseInt(req.params.id, 10));
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (payment.status !== 'completed') {
      return res.status(400).json({ error: `Cannot refund payment in status=${payment.status}` });
    }
    if (payment.amount <= 0 || payment.provider === 'admin-comp') {
      return res.status(400).json({ error: 'Cannot refund a zero-amount or comp payment' });
    }
    if (db.hasPaymentBeenRefunded(payment.provider, payment.provider_payment_id)) {
      return res.status(400).json({ error: 'Payment already refunded' });
    }
    if (!payment.provider_payment_id) {
      return res.status(400).json({ error: 'Payment has no provider_payment_id — cannot refund' });
    }

    const { amount, reason } = req.body || {};
    // Provider-side refund amount. If the admin didn't specify, refund the
    // full charge. Keep in the provider's smallest unit (cents/paise) — our
    // DB already stores it that way.
    const refundAmount = amount !== undefined ? Number(amount) : payment.amount;
    if (!Number.isFinite(refundAmount) || refundAmount <= 0 || refundAmount > payment.amount) {
      return res.status(400).json({ error: 'Invalid refund amount' });
    }

    let providerRefundId = null;
    if (payment.provider === 'stripe') {
      if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
      // Stripe reason must be one of: duplicate, fraudulent, requested_by_customer.
      // Anything else → pass as metadata.
      const validReasons = ['duplicate', 'fraudulent', 'requested_by_customer'];
      const stripeReason = validReasons.includes(reason) ? reason : 'requested_by_customer';
      const refund = await stripe.refunds.create({
        payment_intent: payment.provider_payment_id.startsWith('pi_') ? payment.provider_payment_id : undefined,
        charge: payment.provider_payment_id.startsWith('ch_') ? payment.provider_payment_id : undefined,
        amount: refundAmount,
        reason: stripeReason,
        metadata: {
          admin_initiated: 'true',
          admin_email: req.user.email,
          admin_reason: reason || '',
        },
      });
      providerRefundId = refund.id;
    } else if (payment.provider === 'razorpay') {
      if (!razorpay) return res.status(503).json({ error: 'Razorpay not configured' });
      const refund = await razorpay.payments.refund(payment.provider_payment_id, {
        amount: refundAmount,
        notes: {
          admin_initiated: 'true',
          admin_email: req.user.email,
          admin_reason: reason || '',
        },
      });
      providerRefundId = refund.id;
    } else {
      return res.status(400).json({ error: `Cannot refund payments from provider=${payment.provider}` });
    }

    // Write the compensating local row NOW (webhook will skip via
    // webhook_events dedup if it fires the same event_id twice).
    const refundRow = db.recordAdminRefund({
      originalPayment: payment,
      refundId: providerRefundId,
      amount: refundAmount,
      reason: reason || null,
      initiatedBy: req.user.email,
    });

    writeAudit(req, 'refund-payment', { id: payment.user_id, email: payment.email }, {
      payment_id: payment.id,
      provider: payment.provider,
      refund_amount: refundAmount,
      currency: payment.currency,
      provider_refund_id: providerRefundId,
      reason: reason || null,
    });

    res.json({
      success: true,
      message: `Refund of ${refundAmount} ${payment.currency} issued`,
      provider: payment.provider,
      provider_refund_id: providerRefundId,
      refund_row: refundRow,
    });
  } catch (err) {
    console.error('Refund error:', err);
    res.status(500).json({ error: err.message || 'Failed to refund payment' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LOGS + PAYMENTS + AUDIT — with filters
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

router.get('/logins', authMiddleware, adminOnly, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    res.json(db.getRecentLogins(Math.min(limit, 200)));
  } catch (err) {
    console.error('Logins error:', err);
    res.status(500).json({ error: 'Failed to fetch login logs' });
  }
});

router.get('/revoked', authMiddleware, adminOnly, (req, res) => {
  try {
    res.json(db.getRevokedKeys());
  } catch (err) {
    console.error('Revoked keys error:', err);
    res.status(500).json({ error: 'Failed to fetch revoked keys' });
  }
});

// Enhanced payments list — filters: provider, status, email, tier, from, to
router.get('/payments', authMiddleware, adminOnly, (req, res) => {
  try {
    const filters = {
      provider: req.query.provider || null,
      status: req.query.status || null,
      email: req.query.email || null,
      tier: req.query.tier || null,
      from: req.query.from ? parseInt(req.query.from, 10) : null,
      to: req.query.to ? parseInt(req.query.to, 10) : null,
      limit: Math.min(parseInt(req.query.limit) || 100, 1000),
    };
    const result = db.queryPayments(filters);
    res.json(result);
  } catch (err) {
    console.error('Payments filter error:', err);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// Enhanced audit log — filters: admin, action, target, from, to
router.get('/audit-log', authMiddleware, adminOnly, (req, res) => {
  try {
    const filters = {
      admin: req.query.admin || null,
      action: req.query.action || null,
      target: req.query.target || null,
      from: req.query.from ? parseInt(req.query.from, 10) : null,
      to: req.query.to ? parseInt(req.query.to, 10) : null,
      limit: Math.min(parseInt(req.query.limit) || 200, 2000),
    };
    res.json(db.queryAuditLog(filters));
  } catch (err) {
    console.error('Audit log error:', err);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// Audit-log facets for filter UI (distinct actions, distinct admins).
router.get('/audit-log/facets', authMiddleware, adminOnly, (req, res) => {
  try {
    res.json({
      actions: db.getAuditActions(),
      admins: db.getAuditAdmins(),
    });
  } catch (err) {
    console.error('Audit facets error:', err);
    res.status(500).json({ error: 'Failed to fetch facets' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CONFIG (runtime knobs — min_app_version, device limits, etc.)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /config — dumps all keys (bounded, these are admin-editable flags).
router.get('/config', authMiddleware, adminOnly, (req, res) => {
  try {
    const rows = db.getDB().prepare('SELECT key, value, updated_at FROM app_config ORDER BY key').all();
    res.json(rows);
  } catch (err) {
    console.error('Config list error:', err);
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

// PUT /config/:key — body { value }
router.put('/config/:key', authMiddleware, adminOnly, stepUpOnly, (req, res) => {
  try {
    const key = req.params.key;
    const { value } = req.body || {};
    if (value === undefined) return res.status(400).json({ error: 'value required' });
    if (typeof key !== 'string' || key.length === 0 || key.length > 64) {
      return res.status(400).json({ error: 'Invalid config key' });
    }

    const prev = db.getConfig(key, null);
    db.setConfig(key, String(value));
    writeAudit(req, 'config-update', null, { key, from: prev, to: String(value) });
    res.json({ success: true, key, value: String(value) });
  } catch (err) {
    console.error('Config update error:', err);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// ── Row serialization helper ──
// Ensures no sensitive columns (password_hash, google access token, etc.)
// leak out of the admin API. Add columns here when the schema grows.
function serializeUserRow(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    tier: u.tier,
    country_code: u.country_code,
    created_at: u.created_at,
    updated_at: u.updated_at,
    last_login_at: u.last_login_at,
    is_banned: u.is_banned,
    tokens_revoked_after: u.tokens_revoked_after || 0,
    avatar_url: u.avatar_url,
    oauth_provider: u.oauth_provider,
    stripe_customer_id: u.stripe_customer_id,
  };
}

module.exports = router;
