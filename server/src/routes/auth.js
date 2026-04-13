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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GOOGLE OAUTH — Server-side redirect flow (for Electron + any client)
//  1. Client opens browser to /auth/google/start?session_id=XXX
//  2. Server redirects to Google consent screen
//  3. Google redirects back to /auth/google/callback
//  4. Server logs user in, stores result keyed by session_id
//  5. Client polls /auth/google/poll?session_id=XXX to get token
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// In-memory store for pending Google auth sessions (TTL: 5 min)
const pendingGoogleSessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of pendingGoogleSessions) {
    if (now - session.created_at > 5 * 60 * 1000) pendingGoogleSessions.delete(id);
  }
}, 60 * 1000);

// Step 1: Start Google OAuth — redirects browser to Google
router.get('/google/start', (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).send('Missing session_id');

  // Both vars are required for the server-side redirect flow used by Electron —
  // CLIENT_SECRET is consumed in /google/callback by oauth2Client.getToken(code).
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!googleClientId || !googleClientSecret) {
    return res.status(503).send('Google Sign-In not configured on server. Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET.');
  }

  // Store pending session
  pendingGoogleSessions.set(session_id, { created_at: Date.now(), status: 'pending' });

  // Build the Google OAuth URL
  const serverUrl = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`;
  const redirectUri = `${serverUrl}/api/v1/auth/google/callback`;

  const params = new URLSearchParams({
    client_id: googleClientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: session_id,
    access_type: 'offline',
    prompt: 'select_account',
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// Step 2: Google redirects here after user consents
router.get('/google/callback', async (req, res) => {
  const { code, state: session_id, error } = req.query;

  if (error || !code || !session_id) {
    if (session_id && pendingGoogleSessions.has(session_id)) {
      pendingGoogleSessions.set(session_id, { created_at: Date.now(), status: 'error', error: error || 'No authorization code received' });
    }
    return res.send('<html><body style="background:#050507;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#f87171">Sign-in failed</h2><p style="color:#9ca3af">You can close this window and try again.</p></div></body></html>');
  }

  try {
    const { OAuth2Client } = require('google-auth-library');
    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!googleClientId || !googleClientSecret) {
      pendingGoogleSessions.set(session_id, {
        created_at: Date.now(),
        status: 'error',
        error: 'Google Sign-In not configured on server (missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET)',
      });
      return res.send('<html><body style="background:#050507;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#f87171">Sign-in not configured</h2><p style="color:#9ca3af">The server is missing Google OAuth credentials. Contact support.</p></div></body></html>');
    }
    const serverUrl = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`;
    const redirectUri = `${serverUrl}/api/v1/auth/google/callback`;

    const oauth2Client = new OAuth2Client(googleClientId, googleClientSecret, redirectUri);

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user info from ID token
    const ticket = await oauth2Client.verifyIdToken({
      idToken: tokens.id_token,
      audience: googleClientId,
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    if (!email) {
      pendingGoogleSessions.set(session_id, { created_at: Date.now(), status: 'error', error: 'Google account has no email' });
      return res.send('<html><body style="background:#050507;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#f87171">No email found</h2><p style="color:#9ca3af">Your Google account needs an email address.</p></div></body></html>');
    }

    const isDev = DEVELOPER_EMAILS.includes(email.toLowerCase());
    let user = db.getUserByGoogleId(googleId);
    let isNewUser = false;

    if (!user) {
      user = db.getUserByEmail(email);
      if (user) {
        db.linkGoogleAccount(user.id, googleId, picture);
        user = db.getUserById(user.id);
      } else {
        isNewUser = true;
        const userId = uuidv4();
        const now = Date.now();

        user = db.createUser({
          id: userId,
          email: email.toLowerCase(),
          name: name || email.split('@')[0],
          password: null,
          tier: isDev ? 'pro' : 'free',
          country_code: 'US',
          google_id: googleId,
          oauth_provider: 'google',
          avatar_url: picture,
        });

        const licenseKey = `MNC-${userId.slice(0, 8).toUpperCase()}-${now.toString(36).toUpperCase()}`;
        db.createLicense({
          key: licenseKey,
          user_id: userId,
          email: email.toLowerCase(),
          tier: isDev ? 'pro' : 'free',
          status: isDev ? 'active' : 'trial',
          country_code: 'US',
          expires_at: isDev ? -1 : now + (30 * 24 * 60 * 60 * 1000),
          sessions_limit: isDev ? -1 : 5,
        });
      }
    }

    if (user.is_banned) {
      pendingGoogleSessions.set(session_id, { created_at: Date.now(), status: 'error', error: 'Account suspended' });
      return res.send('<html><body style="background:#050507;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#f87171">Account Suspended</h2><p style="color:#9ca3af">Contact support for help.</p></div></body></html>');
    }

    // Update last login
    const d = db.getDB();
    d.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), user.id);

    db.logLogin({
      user_id: user.id,
      email: user.email,
      ip_address: req.ip || req.connection?.remoteAddress,
      device_id: '',
      country_code: user.country_code,
      success: true,
    });

    const license = db.getLicenseByUserId(user.id);
    const token = generateToken({ id: user.id, email: user.email, tier: user.tier });

    // Store the result for polling
    pendingGoogleSessions.set(session_id, {
      created_at: Date.now(),
      status: 'success',
      data: {
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
      },
    });

    // Show success page — try to auto-close the tab, fall back to a clear
    // "return to app" message. The Electron renderer polls /google/poll and,
    // on success, sends a 'focus-main-window' IPC so the desktop app jumps
    // to the foreground while this tab fades.
    res.send(`<html><body style="background:#050507;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><div style="width:64px;height:64px;border-radius:16px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);display:flex;align-items:center;justify-content:center;margin:0 auto 24px;font-size:28px">✓</div><h2 style="color:#4ade80;margin:0 0 8px">Signed in successfully!</h2><p style="color:#9ca3af;margin:0">Returning to Interview Copilot…</p><p style="color:#6b7280;margin:16px 0 0;font-size:12px">You can close this tab.</p></div><script>setTimeout(function(){try{window.close();}catch(e){}},600);</script></body></html>`);

  } catch (err) {
    console.error('Google OAuth callback error:', err);
    if (session_id && pendingGoogleSessions.has(session_id)) {
      pendingGoogleSessions.set(session_id, { created_at: Date.now(), status: 'error', error: 'Authentication failed' });
    }
    res.send('<html><body style="background:#050507;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#f87171">Something went wrong</h2><p style="color:#9ca3af">Please close this window and try again.</p></div></body></html>');
  }
});

// Step 3: Client polls this endpoint to get the auth result
router.get('/google/poll', (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  const session = pendingGoogleSessions.get(session_id);
  if (!session) return res.json({ status: 'pending' });

  if (session.status === 'success') {
    // Clean up after successful retrieval
    pendingGoogleSessions.delete(session_id);
    return res.json({ status: 'success', ...session.data });
  }

  if (session.status === 'error') {
    pendingGoogleSessions.delete(session_id);
    return res.json({ status: 'error', error: session.error });
  }

  res.json({ status: 'pending' });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PASSWORD RESET
//  1. POST /forgot-password → email the user a reset link
//  2. GET  /reset-password  → server-rendered "choose new password" form
//  3. POST /reset-password  → consume token, update password
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const { sendMail, renderPasswordResetEmail } = require('../email');

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }

    const user = db.getUserByEmail(email);

    // Always respond the same way so an attacker can't enumerate which
    // addresses have accounts. Only send the email when the account
    // exists AND has a password (Google-only accounts can't reset a
    // password they don't have — they should use Google Sign-In).
    if (user && user.password_hash) {
      const rawToken = db.createPasswordResetToken(user.id, user.email);
      const serverUrl = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`;
      const resetUrl = `${serverUrl}/api/v1/auth/reset-password?token=${rawToken}`;
      const { subject, html, text } = renderPasswordResetEmail({ name: user.name, resetUrl });
      const result = await sendMail({ to: user.email, subject, html, text });
      console.log('[forgot-password] sendMail result:', JSON.stringify(result));
      if (!result.ok) {
        console.error('[forgot-password] email NOT sent:', result.reason, result.error || '');
      }
    } else if (user && !user.password_hash) {
      console.log('[forgot-password] user exists but has no password (Google-only account):', email);
    } else {
      console.log('[forgot-password] no account found for:', email);
    }

    res.json({
      ok: true,
      message: 'If an account exists for that email, a password reset link has been sent.',
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to send reset email. Please try again.' });
  }
});

// Server-rendered "choose a new password" form. Keeps the frontend
// simple — the email link lands here in the system browser and the
// user never has to bounce back into the app.
router.get('/reset-password', (req, res) => {
  const { token } = req.query;
  // Tokens are 64-char hex from crypto.randomBytes(32) — reject anything
  // else before it reaches the DB or the rendered HTML.
  const isValidFormat = typeof token === 'string' && /^[a-f0-9]{64}$/i.test(token);
  const row = isValidFormat ? db.getPasswordResetToken(token) : null;

  const baseStyle = 'background:#050507;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px';

  if (!row) {
    return res.status(400).send(`<!doctype html><html><body style="${baseStyle}"><div style="max-width:420px;text-align:center"><div style="width:56px;height:56px;border-radius:14px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:28px">!</div><h2 style="color:#f87171;margin:0 0 8px;font-size:20px">Link expired or invalid</h2><p style="color:#9ca3af;margin:0;font-size:14px;line-height:1.5">This reset link has already been used or has expired. Request a new one from the app and try again.</p></div></body></html>`);
  }

  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reset your password</title></head><body style="${baseStyle}"><div style="max-width:420px;width:100%"><div style="display:flex;align-items:center;gap:10px;margin-bottom:24px"><div style="width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#8b5cf6)"></div><div style="font-weight:700;font-size:15px">minicaai</div></div><div style="border-radius:20px;border:1px solid rgba(255,255,255,0.08);background:linear-gradient(to bottom,rgba(255,255,255,0.06),rgba(255,255,255,0.02));padding:28px;backdrop-filter:blur(12px)"><h2 style="margin:0 0 6px;font-size:20px;font-weight:700">Choose a new password</h2><p style="margin:0 0 20px;font-size:13px;color:#9ca3af">Resetting for <strong style="color:#e5e7eb">${row.email.replace(/</g, '&lt;')}</strong></p><form id="f" onsubmit="return submitForm(event)"><label style="display:block;font-size:11px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.04em">New password</label><input id="p1" type="password" minlength="8" required placeholder="At least 8 characters" style="width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#fff;font-size:14px;outline:none;margin-bottom:12px"/><label style="display:block;font-size:11px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.04em">Confirm password</label><input id="p2" type="password" minlength="8" required placeholder="Re-enter password" style="width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#fff;font-size:14px;outline:none;margin-bottom:16px"/><div id="err" style="display:none;padding:10px 12px;border-radius:8px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;font-size:12px;margin-bottom:12px"></div><button id="btn" type="submit" style="width:100%;padding:13px;border-radius:11px;background:linear-gradient(135deg,#3b82f6,#6366f1);border:none;color:#fff;font-weight:600;font-size:14px;cursor:pointer">Update password</button></form><div id="done" style="display:none;text-align:center;padding:8px 0"><div style="width:48px;height:48px;border-radius:12px;background:rgba(74,222,128,0.12);border:1px solid rgba(74,222,128,0.3);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;color:#4ade80;font-size:24px">&#10003;</div><h3 style="margin:0 0 6px;color:#4ade80;font-size:16px">Password updated</h3><p style="margin:0;font-size:13px;color:#9ca3af">You can now close this tab and sign in with your new password.</p></div></div></div><script>
async function submitForm(e){e.preventDefault();var p1=document.getElementById('p1').value;var p2=document.getElementById('p2').value;var err=document.getElementById('err');var btn=document.getElementById('btn');err.style.display='none';if(p1!==p2){err.textContent='Passwords do not match.';err.style.display='block';return false;}if(p1.length<8){err.textContent='Password must be at least 8 characters.';err.style.display='block';return false;}btn.disabled=true;btn.textContent='Updating...';try{var r=await fetch('/api/v1/auth/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:${JSON.stringify(token)},password:p1})});var d=await r.json();if(!r.ok){throw new Error(d.error||'Reset failed');}document.getElementById('f').style.display='none';document.getElementById('done').style.display='block';}catch(ex){err.textContent=ex.message||'Something went wrong. Try again.';err.style.display='block';btn.disabled=false;btn.textContent='Update password';}return false;}
</script></body></html>`);
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ error: 'Missing token or password' });
    }
    if (!isStrongPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const row = db.consumePasswordResetToken(token);
    if (!row) {
      return res.status(400).json({ error: 'This reset link has expired or already been used. Please request a new one.' });
    }

    db.updateUserPassword(row.user_id, password);
    res.json({ ok: true });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password. Please try again.' });
  }
});

// ── Get current user (full profile) ──
router.get('/me', authMiddleware, (req, res) => {
  try {
    const user = db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const license = db.getLicenseByUserId(user.id);
    const devices = db.getUserDevices(user.id);
    const payments = db.getPaymentsByUser(user.id);
    const conversations = db.getConversationsByUser(user.id);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        tier: user.tier,
        country_code: user.country_code,
        created_at: user.created_at,
        last_login_at: user.last_login_at,
        avatar_url: user.avatar_url,
        oauth_provider: user.oauth_provider,
        is_admin: DEVELOPER_EMAILS.includes(user.email),
      },
      license,
      devices,
      payments,
      conversations: conversations.map(c => ({ id: c.id, name: c.name, created_at: c.created_at, updated_at: c.updated_at })),
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

// ── Update user profile ──
router.put('/profile', authMiddleware, (req, res) => {
  try {
    const user = db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { name, country_code } = req.body;
    const d = db.getDB();
    const updates = [];
    const values = [];

    if (name && name.trim().length > 0 && name.trim().length <= 100) {
      updates.push('name = ?');
      values.push(name.trim());
    }
    if (country_code && /^[A-Z]{2}$/.test(country_code)) {
      updates.push('country_code = ?');
      values.push(country_code);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push('updated_at = ?');
    values.push(Date.now());
    values.push(user.id);

    d.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.getUserById(user.id);
    res.json({
      user: {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        tier: updated.tier,
        country_code: updated.country_code,
        avatar_url: updated.avatar_url,
      },
    });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ── Change password ──
router.put('/password', authMiddleware, (req, res) => {
  try {
    const user = db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.password_hash) {
      return res.status(400).json({ error: 'Account uses Google sign-in. Password cannot be changed.' });
    }

    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current and new password required' });
    }
    if (!isStrongPassword(new_password)) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    if (!db.verifyPassword(current_password, user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const d = db.getDB();
    const newHash = db.hashPassword(new_password);
    d.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(newHash, Date.now(), user.id);

    res.json({ success: true, message: 'Password updated' });
  } catch (err) {
    console.error('Password change error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = router;
