const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const db = require('../database');

const router = express.Router();

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// ── Validate license (called by Electron app on startup + every 30 min) ──
router.post('/validate', async (req, res) => {
  try {
    const { key, device_id, app_version } = req.body;

    if (!key || !device_id) {
      return res.status(400).json({ error: 'License key and device ID required' });
    }

    // Version check
    const minVersion = db.getConfig('min_app_version', '2.0.0');
    if (app_version && !isVersionValid(app_version, minVersion)) {
      return res.status(403).json({
        error: 'version_expired',
        message: 'This version is no longer supported. Please update.',
        min_version: minVersion,
        download_url: 'https://github.com/madhavvan/h2so4/releases/latest',
      });
    }

    // Check if key is revoked
    if (db.isKeyRevoked(key)) {
      return res.status(403).json({
        error: 'license_revoked',
        message: 'This license has been revoked. Contact support.',
      });
    }

    // Look up license in database
    const license = db.getLicenseByKey(key);
    if (!license) {
      return res.status(404).json({ error: 'License not found' });
    }

    // Check license status
    if (license.status === 'revoked') {
      return res.status(403).json({ error: 'license_revoked', message: 'License revoked.' });
    }
    if (license.status === 'expired' || (license.expires_at > 0 && Date.now() > license.expires_at)) {
      db.updateLicenseStatus(key, 'expired');
      return res.status(403).json({ error: 'license_expired', message: 'License expired. Please renew.' });
    }

    // Check user is not banned
    const user = db.getUserById(license.user_id);
    if (!user || user.is_banned) {
      return res.status(403).json({ error: 'account_suspended', message: 'Account suspended.' });
    }

    // Verify device is authorized for this user
    if (!db.isDeviceAuthorized(license.user_id, device_id)) {
      // Try to register (might hit device limit)
      const deviceResult = db.registerDevice(license.user_id, device_id);
      if (deviceResult.error) {
        return res.status(403).json({
          error: 'device_limit',
          message: deviceResult.error,
        });
      }
    }

    // Check session limits for free tier
    if (license.tier === 'free' && license.sessions_limit > 0 && license.sessions_used >= license.sessions_limit) {
      return res.json({
        valid: true,
        key: license.key,
        tier: license.tier,
        status: license.status,
        sessions_used: license.sessions_used,
        sessions_limit: license.sessions_limit,
        sessions_exhausted: true,
        message: 'Session limit reached. Upgrade your plan for more interviews.',
      });
    }

    res.json({
      valid: true,
      key: license.key,
      tier: license.tier,
      status: license.status,
      expires_at: license.expires_at,
      sessions_used: license.sessions_used,
      sessions_limit: license.sessions_limit,
      sessions_exhausted: false,
    });
  } catch (err) {
    console.error('License validation error:', err);
    res.status(500).json({ error: 'Validation failed' });
  }
});

// ── Increment session (called when user starts an interview) ──
router.post('/session', authMiddleware, async (req, res) => {
  try {
    const license = db.getLicenseByUserId(req.user.id);
    if (!license) return res.status(404).json({ error: 'No license found' });

    const isAdmin = ADMIN_EMAILS.includes((req.user.email || '').toLowerCase());

    if (!isAdmin && license.sessions_limit > 0 && license.sessions_used >= license.sessions_limit) {
      return res.status(403).json({ error: 'Session limit reached. Upgrade your plan to continue.' });
    }

    db.incrementSessionCount(license.key);
    const updated = db.getLicenseByKey(license.key);

    res.json({
      sessions_used: updated.sessions_used,
      sessions_limit: isAdmin ? -1 : updated.sessions_limit,
      remaining: (isAdmin || updated.sessions_limit === -1) ? -1 : updated.sessions_limit - updated.sessions_used,
    });
  } catch (err) {
    console.error('Session increment error:', err);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// ── Revoke a license (admin only) ──
router.post('/revoke', authMiddleware, async (req, res) => {
  try {
    if (!ADMIN_EMAILS.includes(req.user.email)) {
      return res.status(403).json({ error: 'Unauthorized — admin only' });
    }

    const { key, reason } = req.body;
    if (!key) return res.status(400).json({ error: 'License key required' });

    const license = db.getLicenseByKey(key);
    if (!license) return res.status(404).json({ error: 'License not found' });

    db.revokeKey(key, req.user.email, reason);

    res.json({ success: true, message: `License ${key} revoked`, email: license.email });
  } catch (err) {
    console.error('Revoke error:', err);
    res.status(500).json({ error: 'Failed to revoke license' });
  }
});

// ── Set minimum app version (admin only) ──
router.post('/set-min-version', authMiddleware, async (req, res) => {
  try {
    if (!ADMIN_EMAILS.includes(req.user.email)) {
      return res.status(403).json({ error: 'Unauthorized — admin only' });
    }

    const { version } = req.body;
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      return res.status(400).json({ error: 'Invalid version format. Use X.Y.Z' });
    }

    db.setConfig('min_app_version', version);
    res.json({ success: true, min_version: version });
  } catch (err) {
    console.error('Set version error:', err);
    res.status(500).json({ error: 'Failed to update version' });
  }
});

// ── Check minimum version (public) ──
router.get('/version', (req, res) => {
  res.json({
    min_version: db.getConfig('min_app_version', '2.0.0'),
    latest_version: db.getConfig('latest_app_version', '2.0.0'),
    download_url: 'https://github.com/madhavvan/h2so4/releases/latest',
  });
});

function isVersionValid(version, minVersion) {
  const [minMaj, minMin, minPatch] = minVersion.split('.').map(Number);
  const [curMaj, curMin, curPatch] = version.split('.').map(Number);
  if (curMaj > minMaj) return true;
  if (curMaj < minMaj) return false;
  if (curMin > minMin) return true;
  if (curMin < minMin) return false;
  return curPatch >= minPatch;
}

module.exports = router;
