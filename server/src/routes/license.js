const express = require('express');
const { authMiddleware, generateToken } = require('../middleware/auth');
const { adminOnly, stepUpOnly, writeAudit, ADMIN_EMAILS } = require('../middleware/admin');
const db = require('../database');

const router = express.Router();

// Sliding-window token rotation: /validate mints a fresh token when the
// caller's current one is within this window of expiry. With the 14d
// default TTL and the client revalidating every ~30 min, active users keep
// a continuously-renewed token and never see a forced re-login; only users
// offline past the TTL must sign in again (bounding a leaked token's life).
const TOKEN_ROTATE_WHEN_S = 7 * 24 * 60 * 60;

// ── Validate license (called by Electron app on startup + every 30 min) ──
// authMiddleware: /validate mutates (registers the caller's device,
// transitions canceling→free) and discloses tier/credits, so it must be
// tied to a verified identity — previously ANY unauthenticated caller could
// present ANY key to squat a device slot or read someone's subscription
// state. The Electron client already sends Authorization: Bearer here.
router.post('/validate', authMiddleware, async (req, res) => {
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
        download_url: 'https://get.minicaai.com',
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
    let license = db.getLicenseByKey(key);
    if (!license) {
      return res.status(404).json({ error: 'License not found' });
    }

    // The key must belong to the authenticated caller. Admins are exempt so
    // support/impersonation tooling can validate any account. Without this,
    // an authenticated user could present someone else's key to register a
    // device onto it (evicting the owner's devices) or read its tier/credits.
    const callerIsAdmin = ADMIN_EMAILS.includes((req.user.email || '').toLowerCase());
    if (license.user_id !== req.user.id && !callerIsAdmin) {
      return res.status(403).json({ error: 'license_mismatch', message: 'This license does not belong to your account.' });
    }

    // Check license status
    if (license.status === 'revoked') {
      return res.status(403).json({ error: 'license_revoked', message: 'License revoked.' });
    }

    // ── Auto-transition: 'canceling' past its expires_at → 'free' ──
    // The cycle-end sweeper (server/src/index.js) and webhook handlers
    // are the primary paths for this transition. /validate is the
    // third defensive layer — any time the client re-validates (on
    // app boot, on focus, every 30 min) and we observe an expired
    // canceling license, we transition NOW so the response reflects
    // the new state instead of saying "still Pro" for hours/days
    // until the next sweep tick lands.
    if (license.status === 'canceling' && license.expires_at > 0 && Date.now() > license.expires_at) {
      try {
        const transitioned = db.transitionLicenseToFree(license.user_id, { reason: 'validate-fallback' });
        if (transitioned && transitioned.transitioned) {
          console.log(`[license/validate] cycle-end transition: user=${license.user_id} ${transitioned.from.tier} → free (sweep missed)`);
          // Fire the goodbye email here too — same shape as the sweeper.
          // Dedup IS handled: transitionLicenseToFree is atomic and
          // idempotent (better-sqlite3 is synchronous), so only the FIRST
          // path to catch an expired 'canceling' license gets
          // transitioned:true. Both the sweeper and this validate-fallback
          // gate the email on that flag, so the user gets exactly one
          // access-ended email. (The cancel webhook sends a separate
          // cancellation-confirmation email — a different template, not this
          // one — so there is no triple-fire of the access-ended message.)
          try {
            const { sendMail, renderAccessEndedEmail } = require('../email');
            const u = db.getUserById(license.user_id);
            if (u && typeof renderAccessEndedEmail === 'function') {
              const buyBasicUrl = (process.env.FRONTEND_URL || 'https://minicaai.com') + '/#pricing';
              const signInUrl = process.env.FRONTEND_URL || 'https://minicaai.com';
              const { subject, html, text } = renderAccessEndedEmail({
                name: u.name, previousTier: transitioned.from.tier, buyBasicUrl, signInUrl,
              });
              sendMail({ to: u.email, subject, html, text }).catch(() => { /* mail outage non-fatal */ });
            }
          } catch { /* email module unavailable */ }
          // Re-read the row so the response below reflects the new state.
          license = db.getLicenseByKey(key);
        }
      } catch (transErr) {
        console.warn('[license/validate] transition-to-free failed:', transErr.message);
      }
    }

    if (license.status === 'expired' || (license.expires_at > 0 && Date.now() > license.expires_at && license.tier !== 'free')) {
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

    // Echo the live admin flag so the client can refresh its cached
    // user.is_admin on every revalidation. Without this, removing an
    // admin's email from ADMIN_EMAILS leaves them with admin powers
    // until they manually log out — a stale-flag insider risk.
    const isAdmin = ADMIN_EMAILS.includes((user.email || '').toLowerCase());

    // Rotate the caller's token if it's nearing expiry (TOKEN_ROTATE_WHEN_S).
    // Best-effort: licenseService saves serverData.token when present and
    // ignores it otherwise, so this seamlessly keeps active sessions alive
    // under the shorter TTL. Only rotate for the token's real owner, never
    // when an admin is validating another account's key.
    let rotatedToken;
    try {
      const nowS = Math.floor(Date.now() / 1000);
      if (!callerIsAdmin && req.user.exp && (req.user.exp - nowS) < TOKEN_ROTATE_WHEN_S) {
        rotatedToken = generateToken({ id: user.id, email: user.email, tier: license.tier });
      }
    } catch { /* rotation is non-critical */ }

    res.json({
      valid: true,
      key: license.key,
      tier: license.tier,
      status: license.status,
      expires_at: license.expires_at,
      sessions_used: license.sessions_used,
      sessions_limit: license.sessions_limit,
      sessions_exhausted: false,
      is_admin: isAdmin,
      // Credits — server-tracked so renewal payments propagate across
      // devices. Pro/Max return -1 sentinels (the client treats those as
      // "unlimited" and ignores the bucket entirely).
      credits_remaining_seconds: license.credits_remaining_seconds,
      credits_expire_at: license.credits_expire_at,
      trial_remaining_seconds: license.trial_remaining_seconds,
      trial_granted_at: license.trial_granted_at,
      // Present only when rotated (see above); omitted on most calls.
      token: rotatedToken,
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

// ── Revoke a license (admin only, step-up required) ──
// Pre-v3.4.7 used a bare `ADMIN_EMAILS.includes` check with no step-up
// reauth and no audit log — i.e. a compromised admin token could revoke
// any license without leaving a trace. Now uses the same guard chain as
// the destructive endpoints in admin.js (refunds, delete user) and
// writes an audit row that the SQLite triggers protect from tampering.
router.post('/revoke', authMiddleware, adminOnly, stepUpOnly, async (req, res) => {
  try {
    const { key, reason } = req.body;
    if (!key) return res.status(400).json({ error: 'License key required' });

    const license = db.getLicenseByKey(key);
    if (!license) return res.status(404).json({ error: 'License not found' });

    db.revokeKey(key, req.user.email, reason);

    writeAudit(req, 'license-revoke', { id: license.user_id, email: license.email }, {
      key,
      reason: reason || null,
    });

    res.json({ success: true, message: `License ${key} revoked`, email: license.email });
  } catch (err) {
    console.error('Revoke error:', err);
    res.status(500).json({ error: 'Failed to revoke license' });
  }
});

// ── Set minimum app version (admin only, step-up required) ──
// Same hardening rationale as /revoke. Bumping min_app_version is a
// fleet-wide forced-update — every running client below the new floor
// is locked out on the next /validate poll. Step-up + audit prevents
// a compromised admin token from triggering an outage silently.
router.post('/set-min-version', authMiddleware, adminOnly, stepUpOnly, async (req, res) => {
  try {
    const { version } = req.body;
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      return res.status(400).json({ error: 'Invalid version format. Use X.Y.Z' });
    }

    const previousVersion = db.getConfig('min_app_version', '2.0.0');
    db.setConfig('min_app_version', version);

    writeAudit(req, 'set-min-version', null, {
      previous_version: previousVersion,
      new_version: version,
    });

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
    download_url: 'https://get.minicaai.com',
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
