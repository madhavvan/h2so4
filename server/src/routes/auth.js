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
    const { email, name, password, country_code, device_id, platform, app_version } = req.body;

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

    // Register device if provided. `registerDevice` never rejects — it
    // auto-deactivates the oldest device when the tier limit is full. The
    // old `if (deviceResult.error)` branch was dead code.
    if (device_id) {
      db.registerDevice(userId, device_id, req.headers['user-agent'] || 'Unknown', platform);
    }

    // Log successful signup — non-critical, don't crash the signup flow
    // if the audit insert fails.
    try {
      db.logLogin({
        user_id: userId,
        email: email.toLowerCase(),
        ip_address: req.ip || req.connection?.remoteAddress,
        device_id: device_id || '',
        country_code: country_code || 'US',
        success: true,
        platform,
      });
    } catch (logErr) {
      console.warn('Failed to log signup:', logErr.message);
    }

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
    const { email, password, device_id, platform, app_version } = req.body;

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
          platform,
        });
      } catch (logErr) {
        console.warn('Failed to log login attempt:', logErr.message);
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check if banned
    if (user.is_banned) {
      try { db.logLogin({ user_id: user.id, email: user.email, ip_address: req.ip, device_id: device_id || null, success: false, error_reason: 'account_banned', platform }); } catch {}
      return res.status(403).json({ error: 'This account has been suspended. Contact support.' });
    }

    // Register/verify device. `registerDevice` never rejects — it
    // auto-deactivates the oldest device when the tier limit is full.
    // The old `deviceResult.error` branch was dead code.
    if (device_id) {
      db.registerDevice(user.id, device_id, req.headers['user-agent'] || 'Unknown', platform);
    }

    const license = db.getLicenseByUserId(user.id);

    // Log successful login — non-critical, don't fail the login if audit
    // insert throws (disk full, lock contention, etc.).
    try {
      db.logLogin({
        user_id: user.id,
        email: user.email,
        ip_address: req.ip || req.connection?.remoteAddress,
        device_id: device_id || '',
        country_code: user.country_code,
        success: true,
        platform,
      });
    } catch (logErr) {
      console.warn('Failed to log login:', logErr.message);
    }

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
    const { credential, device_id, platform, country_code } = req.body;

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
        // Link Google to existing account — two guards close the silent
        // pre-hijack chain (attacker signs up with the victim's email + a
        // password they know; victim later clicks "Sign in with Google" and
        // silently merges onto the attacker's account, who keeps password
        // access):
        //  1. Only a VERIFIED Google email may absorb an existing account —
        //     otherwise the same attack runs in reverse with an unverified
        //     Google identity for the victim's address.
        //  2. If the account already has a password, revoke every session
        //     from before the link and notify the address owner. A password-
        //     holding attacker loses their live sessions, and the real owner
        //     learns a password exists that they may never have set (the
        //     email tells them to reset it, which evicts the attacker).
        if (payload.email_verified !== true) {
          return res.status(403).json({ error: "This Google account's email address is unverified, so it can't be linked to an existing minicaai account. Verify the email with Google, or sign in with your password." });
        }
        const hadPassword = !!user.password_hash;
        db.linkGoogleAccount(user.id, googleId, picture);
        user = db.getUserById(user.id);
        if (hadPassword) {
          db.revokeOtherSessions(user.id);
          const { subject, html, text } = renderGoogleLinkedEmail({ name: user.name });
          sendMail({ to: user.email, subject, html, text }).catch(() => { /* mail outage non-fatal */ });
        }
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

    // Register device if provided. `registerDevice` never rejects — it
    // auto-deactivates the oldest device when the tier limit is full.
    // The old `deviceResult.error` branch was dead code.
    if (device_id) {
      db.registerDevice(user.id, device_id, req.headers['user-agent'] || 'Unknown', platform);
    }

    // Update last login
    const d = db.getDB();
    d.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), user.id);

    // Log login — non-critical, don't fail the login on audit errors.
    try {
      db.logLogin({
        user_id: user.id,
        email: user.email,
        ip_address: req.ip || req.connection?.remoteAddress,
        device_id: device_id || '',
        country_code: user.country_code,
        success: true,
        platform,
      });
    } catch (logErr) {
      console.warn('Failed to log Google login:', logErr.message);
    }

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

  // session_id is CLIENT-generated and later redeems the signed-in user's
  // JWT at /google/poll — so it must carry real entropy. The app has always
  // sent crypto.randomUUID() (36 chars, since the flow shipped); enforce
  // UUID-class shape so a hand-rolled short/guessable id (poll-hijack,
  // device-flow-class weakness) is refused before a session is created.
  // Cap the pending map so a scripted caller can't balloon server memory
  // with junk ids inside the 5-minute TTL window.
  if (typeof session_id !== 'string' || !/^[A-Za-z0-9_-]{21,64}$/.test(session_id)) {
    return res.status(400).send('Invalid session_id');
  }
  if (pendingGoogleSessions.size >= 5000 && !pendingGoogleSessions.has(session_id)) {
    return res.status(503).send('Sign-in is briefly unavailable. Please try again in a minute.');
  }

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
        // Same link hardening as POST /google above: only a verified Google
        // email may absorb an existing account, and a pre-existing password
        // triggers revoke-all-prior-sessions + a security email to the owner.
        if (payload.email_verified !== true) {
          pendingGoogleSessions.set(session_id, { created_at: Date.now(), status: 'error', error: "This Google account's email is unverified, so it can't be linked to an existing account. Sign in with your password instead." });
          return res.send('<html><body style="background:#050507;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#f87171">Email not verified</h2><p style="color:#9ca3af">This Google account&#39;s email is unverified, so it can&#39;t be linked to an existing minicaai account.</p></div></body></html>');
        }
        const hadPassword = !!user.password_hash;
        db.linkGoogleAccount(user.id, googleId, picture);
        user = db.getUserById(user.id);
        if (hadPassword) {
          db.revokeOtherSessions(user.id);
          const { subject, html, text } = renderGoogleLinkedEmail({ name: user.name });
          sendMail({ to: user.email, subject, html, text }).catch(() => { /* mail outage non-fatal */ });
        }
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

    try {
      db.logLogin({
        user_id: user.id,
        email: user.email,
        ip_address: req.ip || req.connection?.remoteAddress,
        device_id: '',
        country_code: user.country_code,
        success: true,
      });
    } catch (logErr) {
      console.warn('Failed to log Google callback login:', logErr.message);
    }

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

    // Show success page → immediately hand control back to the desktop
    // app via a custom-protocol redirect. The Electron main process
    // registers `interview-copilot://` (see electron/main.cjs:76 single-
    // instance + second-instance + open-url handlers); navigating the
    // browser to that URL causes the OS to focus the running app and
    // — critically — the browser auto-closes the protocol-launch tab.
    // Falls back gracefully to manual close instructions if the user's
    // browser blocks the protocol or the app isn't installed.
    //
    // The poll path still works in parallel: even if the protocol
    // redirect is denied, the renderer's existing /google/poll loop
    // signs the user in.
    const safeSessionId = encodeURIComponent(String(session_id));
    res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signed in</title></head><body style="background:#050507;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center;max-width:420px;padding:0 20px"><div style="width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg,#10b981,#3b82f6);display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:24px;color:#fff">✓</div><h2 style="color:#e5e7eb;margin:0 0 6px;font-weight:600;font-size:18px">Signed in</h2><p style="color:#9ca3af;margin:0;font-size:13px">Returning to Interview Copilot…</p><p id="fallback-msg" style="color:#6b7280;margin:18px 0 0;font-size:11px;opacity:0;transition:opacity 0.3s">You can close this tab now.</p></div><script>
(function(){
  // Hand off to the desktop app via the custom protocol. Browsers will
  // close (or blank) this tab automatically when the OS protocol
  // handler claims the navigation. If the OS doesn't recognize the
  // protocol (older install, sandboxed browser), the redirect is a
  // no-op and the fallback message after ~1.6s tells the user to close
  // the tab manually.
  var url = 'interview-copilot://signin-complete?session_id=${safeSessionId}';
  try { window.location.href = url; } catch (e) { /* CSP or sandbox */ }
  setTimeout(function(){
    // Try the explicit window.close() as a second attempt (works when
    // the original tab was opened via window.open from our app).
    try { window.close(); } catch (e) {}
    // Show the manual-close hint if we're still alive after the
    // protocol attempt failed and window.close() was blocked.
    setTimeout(function(){
      var m = document.getElementById('fallback-msg');
      if (m) m.style.opacity = '1';
    }, 400);
  }, 1200);
})();
</script></body></html>`);

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

const { sendMail, renderPasswordResetEmail, renderGoogleLinkedEmail } = require('../email');

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
      // Log first 8 chars so we can correlate issued → clicked in Railway
      // logs (e.g. diagnose "did the user click the same link we emailed?").
      // Full token stays secret — 8 hex chars is 32 bits, not enough to brute.
      console.log(`[forgot-password] token issued user_id=${user.id} token=${rawToken.slice(0, 8)}...`);
      const serverUrl = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`;
      const resetUrl = `${serverUrl}/api/v1/auth/reset-password?token=${rawToken}`;
      const { subject, html, text } = renderPasswordResetEmail({ name: user.name, resetUrl });
      // Fire-and-forget. The HTTP response must not block on SMTP —
      // if Gmail is slow the user shouldn't stare at a spinner. Failures
      // are logged for admin review; the user always sees the same
      // "link sent" message (anti-enumeration, see res.json below).
      sendMail({ to: user.email, subject, html, text })
        .then(result => {
          console.log('[forgot-password] sendMail result:', JSON.stringify(result));
          if (!result.ok) {
            console.error('[forgot-password] email NOT sent:', result.reason, result.error || '');
          }
        })
        .catch(err => console.error('[forgot-password] sendMail threw:', err && err.message));
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

// HTML escape for safe interpolation into both text content and
// attribute values. Used by the server-rendered password reset pages.
// helmet's default CSP blocks inline <script> blocks AND inline event
// handlers (script-src 'self'; script-src-attr 'none'), so the form
// must work without any JavaScript at all — that means real action+
// method+name attrs and rock-solid HTML escaping on everything we
// interpolate into the page.
function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Shared brand shell: gradient background + minicaai header. Inline CSS
// only — the reset link opens in whatever browser the user has (possibly
// mobile webmail), so nothing from /dist is reachable here. Inline
// styles are allowed by helmet's default CSP (style-src 'unsafe-inline').
function resetPagePageShell(body, title) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title></head><body style="margin:0;padding:24px;min-height:100vh;background:radial-gradient(circle at 50% 0%,#0a0a12 0%,#050507 70%);color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;box-sizing:border-box"><div style="max-width:440px;width:100%"><div style="display:flex;align-items:center;gap:10px;margin-bottom:24px;justify-content:center"><div style="width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);box-shadow:0 4px 16px rgba(59,130,246,0.3)"></div><div style="font-weight:700;font-size:15px;letter-spacing:-0.01em">minicaai</div></div>${body}</div></body></html>`;
}

function renderResetExpiredPage(frontendUrl) {
  const safeFrontend = htmlEscape(frontendUrl);
  const body = `<div style="border-radius:20px;border:1px solid rgba(255,255,255,0.08);background:linear-gradient(to bottom,rgba(255,255,255,0.06),rgba(255,255,255,0.02));padding:36px 28px;backdrop-filter:blur(12px);text-align:center"><div style="width:64px;height:64px;border-radius:16px;background:linear-gradient(135deg,rgba(239,68,68,0.15),rgba(239,68,68,0.05));border:1px solid rgba(239,68,68,0.25);display:flex;align-items:center;justify-content:center;margin:0 auto 20px"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div><h2 style="margin:0 0 10px;font-size:22px;font-weight:700">Link expired</h2><p style="margin:0 0 28px;font-size:14px;line-height:1.6;color:#9ca3af">This reset link has already been used or has expired. Links are valid for 1 hour — request a fresh one below.</p><a href="${safeFrontend}/?view=forgot_password" style="display:block;width:100%;box-sizing:border-box;padding:13px 20px;border-radius:11px;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;font-weight:600;font-size:14px;text-decoration:none;text-align:center;box-shadow:0 4px 16px rgba(59,130,246,0.25)">Request a new reset link</a></div>`;
  return resetPagePageShell(body, 'Link expired — minicaai');
}

function renderResetSuccessPage(frontendUrl, email) {
  const safeFrontend = htmlEscape(frontendUrl);
  // Pass the email back on the query string so the login form can prefill
  // it — the user just types their new password and signs in. ?view=login
  // also tells the frontend to clear any stale localStorage auth so the
  // revoked-session from this reset doesn't ghost-sign-in the returning tab.
  const loginHref = email
    ? `${safeFrontend}/?view=login&email=${encodeURIComponent(email)}`
    : `${safeFrontend}/?view=login`;
  const body = `<div style="border-radius:20px;border:1px solid rgba(255,255,255,0.08);background:linear-gradient(to bottom,rgba(255,255,255,0.06),rgba(255,255,255,0.02));padding:36px 28px;backdrop-filter:blur(12px);text-align:center"><div style="width:64px;height:64px;border-radius:16px;background:linear-gradient(135deg,rgba(74,222,128,0.15),rgba(74,222,128,0.05));border:1px solid rgba(74,222,128,0.3);display:flex;align-items:center;justify-content:center;margin:0 auto 20px"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div><h2 style="margin:0 0 10px;color:#4ade80;font-size:22px;font-weight:700">Password updated</h2><p style="margin:0 0 28px;font-size:14px;line-height:1.6;color:#9ca3af">Your password has been changed and any other sessions on your account have been signed out. You can sign in with your new password now.</p><a href="${htmlEscape(loginHref)}" style="display:block;width:100%;box-sizing:border-box;padding:13px 20px;border-radius:11px;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;font-weight:600;font-size:14px;text-decoration:none;text-align:center;box-shadow:0 4px 16px rgba(59,130,246,0.25)">Continue to sign in</a></div>`;
  return resetPagePageShell(body, 'Password updated — minicaai');
}

// Server-rendered "choose a new password" form. The email link lands
// here and the user never has to bounce back into the app.
//
// CSP-SAFE: NO inline <script> blocks, NO inline event handlers. The
// form submits as a real HTML POST (action+method+hidden token+named
// password fields) so it works in every browser — including in-app
// email browsers and any environment where helmet's CSP blocks JS.
router.get('/reset-password', (req, res) => {
  const { token, error } = req.query;
  // Tokens are 64-char hex from crypto.randomBytes(32) — reject anything
  // else before it reaches the DB or the rendered HTML.
  const isValidFormat = typeof token === 'string' && /^[a-f0-9]{64}$/i.test(token);

  // Look the row up raw (used/expired tokens included) so we can log the
  // *specific* rejection reason when the page ends up showing "Link expired".
  let row = null;
  let rejectReason = null;
  if (!isValidFormat) {
    rejectReason = 'invalid_format';
  } else {
    const raw = db.getRawPasswordResetToken(token);
    if (!raw) {
      rejectReason = 'not_found';
    } else if (raw.used_at) {
      rejectReason = `used_at=${new Date(raw.used_at).toISOString()}`;
    } else if (raw.expires_at < Date.now()) {
      rejectReason = `expired_${Math.round((Date.now() - raw.expires_at) / 1000)}s_ago`;
    } else {
      row = raw;
    }
  }
  if (!row) {
    const prefix = typeof token === 'string' ? token.slice(0, 8) : '(missing)';
    console.log(`[reset-password] GET rejected token=${prefix}... reason=${rejectReason}`);
  }

  const frontendUrl = process.env.FRONTEND_URL || 'https://minicaai.com';

  if (!row) {
    return res.status(400).send(renderResetExpiredPage(frontendUrl));
  }

  const safeEmail = htmlEscape(row.email);
  const safeToken = htmlEscape(token);

  // Banner shown when a previous POST attempt was bounced back here
  // with a validation error. The form re-renders with the SAME token
  // so the user can retry without re-clicking the email link.
  let errorBanner = '';
  if (error === 'mismatch') {
    errorBanner = `<div style="padding:10px 12px;border-radius:8px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;font-size:12px;margin-bottom:14px">Passwords do not match. Please try again.</div>`;
  } else if (error === 'short') {
    errorBanner = `<div style="padding:10px 12px;border-radius:8px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;font-size:12px;margin-bottom:14px">Password must be at least 8 characters.</div>`;
  } else if (error === 'missing') {
    errorBanner = `<div style="padding:10px 12px;border-radius:8px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;font-size:12px;margin-bottom:14px">Please fill in both password fields.</div>`;
  }

  const body = `<div style="border-radius:20px;border:1px solid rgba(255,255,255,0.08);background:linear-gradient(to bottom,rgba(255,255,255,0.06),rgba(255,255,255,0.02));padding:32px 28px;backdrop-filter:blur(12px)"><h2 style="margin:0 0 6px;font-size:22px;font-weight:700">Choose a new password</h2><p style="margin:0 0 24px;font-size:13px;color:#9ca3af">Resetting for <strong style="color:#e5e7eb;font-weight:500">${safeEmail}</strong></p>${errorBanner}<form action="/api/v1/auth/reset-password" method="POST"><input type="hidden" name="token" value="${safeToken}"/><label style="display:block;font-size:11px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;font-weight:500">New password</label><input name="password" type="password" minlength="8" required autocomplete="new-password" placeholder="At least 8 characters" style="width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#fff;font-size:14px;outline:none;margin-bottom:16px"/><label style="display:block;font-size:11px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;font-weight:500">Confirm password</label><input name="password_confirm" type="password" minlength="8" required autocomplete="new-password" placeholder="Re-enter password" style="width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#fff;font-size:14px;outline:none;margin-bottom:18px"/><button type="submit" style="width:100%;padding:13px;border-radius:11px;background:linear-gradient(135deg,#3b82f6,#6366f1);border:none;color:#fff;font-weight:600;font-size:14px;cursor:pointer;box-shadow:0 4px 16px rgba(59,130,246,0.25)">Update password</button></form></div>`;
  res.send(resetPagePageShell(body, 'Reset your password — minicaai'));
});

router.post('/reset-password', async (req, res) => {
  // Content-negotiate: native HTML form submissions arrive with
  // Accept: text/html and Content-Type: x-www-form-urlencoded;
  // programmatic callers send Accept: application/json. Same endpoint,
  // two response shapes — HTML pages for browsers, JSON for AJAX.
  const accept = req.headers.accept || '';
  const wantsHtml = accept.includes('text/html') && !accept.startsWith('application/json');
  const frontendUrl = process.env.FRONTEND_URL || 'https://minicaai.com';

  // Bounce a failed validation back to the GET form (re-renders with
  // the same token + an error banner). 303 forces the browser to GET
  // even if it just POST'd here.
  const bounceToForm = (errKey, tok) => {
    const t = encodeURIComponent(tok || '');
    return res.redirect(303, `/api/v1/auth/reset-password?token=${t}&error=${errKey}`);
  };

  try {
    const { token, password, password_confirm } = req.body || {};

    if (!token || !password) {
      if (wantsHtml) return bounceToForm('missing', token);
      return res.status(400).json({ error: 'Missing token or password' });
    }
    if (!isStrongPassword(password)) {
      if (wantsHtml) return bounceToForm('short', token);
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    // Server-side match check. The HTML form sends both fields and the
    // browser does no live matching (no JS allowed by CSP). JSON callers
    // can omit password_confirm and we trust the single password field.
    if (typeof password_confirm === 'string' && password !== password_confirm) {
      if (wantsHtml) return bounceToForm('mismatch', token);
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    const row = db.consumePasswordResetToken(token);
    if (!row) {
      // Mirror the GET-side logging so the server log tells us which of
      // the three real reasons ("already used", "expired", "never existed")
      // fired — otherwise support has to guess from the user's side alone.
      const raw = db.getRawPasswordResetToken(token);
      let reason;
      if (!raw) reason = 'not_found';
      else if (raw.used_at) reason = `used_at=${new Date(raw.used_at).toISOString()}`;
      else if (raw.expires_at < Date.now()) reason = `expired_${Math.round((Date.now() - raw.expires_at) / 1000)}s_ago`;
      else reason = 'consume_race';
      const prefix = typeof token === 'string' ? token.slice(0, 8) : '(missing)';
      console.log(`[reset-password] POST rejected token=${prefix}... reason=${reason}`);
      if (wantsHtml) return res.status(400).send(renderResetExpiredPage(frontendUrl));
      return res.status(400).json({ error: 'This reset link has expired or already been used. Please request a new one.' });
    }

    // Single atomic write: hashes + updates password, bumps
    // tokens_revoked_after to invalidate every existing JWT (the most
    // common reason for a reset is suspected compromise — old sessions
    // staying live would let an attacker keep access on devices they
    // already have), and marks any sibling unused reset tokens used so
    // a spare from "Forgot password" clicked twice can't be replayed
    // within the 1-hour TTL. Wrapping the three writes in one transaction
    // closes the SIGKILL race window between password-changed and
    // sessions-revoked.
    const killed = db.applyPasswordReset(row.user_id, password);
    console.log(`[reset-password] POST success user_id=${row.user_id} siblings_invalidated=${killed}`);

    if (wantsHtml) return res.send(renderResetSuccessPage(frontendUrl, row.email));
    res.json({ ok: true });
  } catch (err) {
    console.error('Reset password error:', err);
    if (wantsHtml) return res.status(500).send(renderResetExpiredPage(frontendUrl));
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

    // country_code is intentionally NOT destructured/updatable here — it
    // drives billing region (India = paid-only via regionGate) and the
    // payment provider (Razorpay vs Stripe in routes/payments.js). A
    // self-service edit would let a user flip regions to dodge the paywall
    // or arbitrage INR pricing, so it's set once at signup and only an
    // admin/support action can change it afterward. Any country_code in the
    // request body is silently ignored.
    const { name } = req.body;
    const d = db.getDB();
    const updates = [];
    const values = [];

    if (name && name.trim().length > 0 && name.trim().length <= 100) {
      updates.push('name = ?');
      values.push(name.trim());
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

    // Atomic: hash + revoke ALL existing sessions (tokens_revoked_after) +
    // invalidate any outstanding reset links — the same transaction the
    // reset flow uses. Changing a password must kill other live sessions
    // (the whole point when a device is compromised); previously this route
    // updated only the hash, leaving every long-lived JWT valid. We then
    // re-issue a token for THIS session so the user who just changed their
    // password isn't bounced to the login screen. The client saves the
    // returned token; an older client that ignores it simply re-logs in,
    // which is safe.
    db.applyPasswordReset(user.id, new_password);
    const token = generateToken({ id: user.id, email: user.email, tier: user.tier });

    res.json({ success: true, message: 'Password updated', token });
  } catch (err) {
    console.error('Password change error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = router;
