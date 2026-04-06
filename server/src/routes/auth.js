const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { generateToken, authMiddleware } = require('../middleware/auth');
const db = require('../database');

const router = express.Router();

const DEVELOPER_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// Email format validation
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Password strength check
function isStrongPassword(password) {
  return password && password.length >= 8;
}

// ── Sign Up ──
router.post('/signup', async (req, res) => {
  try {
    const { email, name, password, country_code, device_id, app_version } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (!isStrongPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check duplicate
    const existing = db.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const isDev = DEVELOPER_EMAILS.includes(email.toLowerCase());
    const userId = uuidv4();
    const now = Date.now();

    // Create user with hashed password
    const user = db.createUser({
      id: userId,
      email: email.toLowerCase(),
      name: name || email.split('@')[0],
      password,
      tier: isDev ? 'pro' : 'free',
      country_code: country_code || 'US',
    });

    // Create license
    const licenseKey = `MNC-${uuidv4().slice(0, 8).toUpperCase()}-${now.toString(36).toUpperCase()}`;
    const license = db.createLicense({
      key: licenseKey,
      user_id: userId,
      email: email.toLowerCase(),
      tier: isDev ? 'pro' : 'free',
      status: isDev ? 'active' : 'trial',
      country_code: country_code || 'US',
      expires_at: isDev ? -1 : now + (30 * 24 * 60 * 60 * 1000),
      sessions_limit: isDev ? -1 : 5,
    });

    // Register device if provided
    if (device_id) {
      const deviceResult = db.registerDevice(userId, device_id, req.headers['user-agent'] || 'Unknown');
      if (deviceResult.error) {
        return res.status(403).json({ error: deviceResult.error });
      }
    }

    // Log successful signup
    db.logLogin({
      user_id: userId,
      email: email.toLowerCase(),
      ip_address: req.ip || req.connection?.remoteAddress,
      device_id: device_id || '',
      country_code: country_code || 'US',
      success: true,
    });

    const token = generateToken({ id: userId, email: user.email, tier: user.tier });

    res.status(201).json({
      user: { id: user.id, email: user.email, name: user.name, tier: user.tier, country_code: user.country_code, created_at: user.created_at, is_admin: DEVELOPER_EMAILS.includes(user.email) },
      license: { ...license, last_validated: now },
      token,
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// ── Login ──
router.post('/login', async (req, res) => {
  try {
    const { email, password, device_id, app_version } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Verify credentials (password is hashed inside)
    const user = db.verifyUserPassword(email, password);
    if (!user) {
      // Log failed login (non-critical — don't crash login flow)
      try {
        db.logLogin({
          user_id: null,
          email: email.toLowerCase(),
          ip_address: req.ip || req.connection?.remoteAddress,
          device_id: device_id || null,
          success: false,
          error_reason: 'invalid_credentials',
        });
      } catch (logErr) {
        console.warn('Failed to log login attempt:', logErr.message);
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check if banned
    if (user.is_banned) {
      try { db.logLogin({ user_id: user.id, email: user.email, ip_address: req.ip, device_id: device_id || null, success: false, error_reason: 'account_banned' }); } catch {}
      return res.status(403).json({ error: 'This account has been suspended. Contact support.' });
    }

    // Register/verify device
    if (device_id) {
      const deviceResult = db.registerDevice(user.id, device_id, req.headers['user-agent'] || 'Unknown');
      if (deviceResult.error) {
        try { db.logLogin({ user_id: user.id, email: user.email, ip_address: req.ip, device_id, success: false, error_reason: 'device_limit' }); } catch {}
        return res.status(403).json({ error: deviceResult.error });
      }
    }

    const license = db.getLicenseByUserId(user.id);

    // Log successful login
    db.logLogin({
      user_id: user.id,
      email: user.email,
      ip_address: req.ip || req.connection?.remoteAddress,
      device_id: device_id || '',
      country_code: user.country_code,
      success: true,
    });

    const token = generateToken({ id: user.id, email: user.email, tier: user.tier });

    res.json({
      user: { id: user.id, email: user.email, name: user.name, tier: user.tier, country_code: user.country_code, created_at: user.created_at, is_admin: DEVELOPER_EMAILS.includes(user.email) },
      license: license ? { ...license, last_validated: Date.now() } : null,
      token,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ── Google OAuth ──
router.post('/google', async (req, res) => {
  try {
    const { credential, device_id, country_code } = req.body;

    if (!credential) {
      return res.status(400).json({ error: 'Google credential required' });
    }

    // Verify Google ID token
    const { OAuth2Client } = require('google-auth-library');
    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    if (!googleClientId) {
      return res.status(503).json({ error: 'Google Sign-In not configured. Contact support.' });
    }

    const client = new OAuth2Client(googleClientId);
    let payload;
    try {
      const ticket = await client.verifyIdToken({
        idToken: credential,
        audience: googleClientId,
      });
      payload = ticket.getPayload();
    } catch (verifyErr) {
      console.error('Google token verification failed:', verifyErr.message);
      return res.status(401).json({ error: 'Invalid Google credential. Please try again.' });
    }

    const { sub: googleId, email, name, picture } = payload;
    if (!email) {
      return res.status(400).json({ error: 'Google account has no email address' });
    }

    const isDev = DEVELOPER_EMAILS.includes(email.toLowerCase());
    let user = db.getUserByGoogleId(googleId);
    let isNewUser = false;

    if (!user) {
      // Check if email already exists (signed up with password before)
      user = db.getUserByEmail(email);
      if (user) {
        // Link Google to existing account
        db.linkGoogleAccount(user.id, googleId, picture);
        user = db.getUserById(user.id);
      } else {
        // Create new user via Google
        isNewUser = true;
        const userId = require('uuid').v4();
        const now = Date.now();

        user = db.createUser({
          id: userId,
          email: email.toLowerCase(),
          name: name || email.split('@')[0],
          password: null,
          tier: isDev ? 'pro' : 'free',
          country_code: country_code || 'US',
          google_id: googleId,
          oauth_provider: 'google',
          avatar_url: picture,
        });

        // Create license
        const licenseKey = `MNC-${userId.slice(0, 8).toUpperCase()}-${now.toString(36).toUpperCase()}`;
        db.createLicense({
          key: licenseKey,
          user_id: userId,
          email: email.toLowerCase(),
          tier: isDev ? 'pro' : 'free',
          status: isDev ? 'active' : 'trial',
          country_code: country_code || 'US',
          expires_at: isDev ? -1 : now + (30 * 24 * 60 * 60 * 1000),
          sessions_limit: isDev ? -1 : 5,
        });
      }
    }

    // Check if banned
    if (user.is_banned) {
      return res.status(403).json({ error: 'This account has been suspended. Contact support.' });
    }

    // Register device if provided
    if (device_id) {
      const deviceResult = db.registerDevice(user.id, device_id, req.headers['user-agent'] || 'Unknown');
      if (deviceResult.error) {
        return res.status(403).json({ error: deviceResult.error });
      }
    }

    // Update last login
    const d = db.getDB();
    d.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), user.id);

    // Log login
    db.logLogin({
      user_id: user.id,
      email: user.email,
      ip_address: req.ip || req.connection?.remoteAddress,
      device_id: device_id || '',
      country_code: user.country_code,
      success: true,
    });

    const license = db.getLicenseByUserId(user.id);
    const token = generateToken({ id: user.id, email: user.email, tier: user.tier });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        tier: user.tier,
        country_code: user.country_code,
        created_at: user.created_at,
        is_admin: DEVELOPER_EMAILS.includes(user.email),
        avatar_url: user.avatar_url || picture,
        oauth_provider: user.oauth_provider || 'google',
      },
      license: license ? { ...license, last_validated: Date.now() } : null,
      token,
      is_new_user: isNewUser,
    });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).json({ error: 'Google authentication failed. Please try again.' });
  }
});

// ── Get current user ──
router.get('/me', authMiddleware, (req, res) => {
  try {
    const user = db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const license = db.getLicenseByUserId(user.id);
    const devices = db.getUserDevices(user.id);

    res.json({
      user: { id: user.id, email: user.email, name: user.name, tier: user.tier, country_code: user.country_code, created_at: user.created_at },
      license,
      devices,
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

module.exports = router;
