const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { generateToken, authMiddleware } = require('../middleware/auth');
// Clears an account's failed-login counter once the password is proven
// correct, so the brute-force limiter only ever counts failures.
const { clearLoginAttempts } = require('../middleware/rateLimiters');
// One greppable line per auth request: endpoint, status, duration, reason.
// Mounted first so it wraps every route below, including the ones that
// return early. See middleware/authObservability.js for why this exists.
const { authAccessLog } = require('../middleware/authObservability');
const db = require('../database');
const { checkEmailDeliverable } = require('../services/emailValidity');
const { sendWelcomeMail, verifyUnsubscribeToken } = require('../services/marketingMail');

const router = express.Router();

router.use(authAccessLog);

const DEVELOPER_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADMIN ADDRESSES ARE NOT SELF-SERVE
//
//  Every admin gate in the codebase — middleware/admin.js adminOnly,
//  middleware/tier.js, middleware/regionGate.js, the support-WS agent
//  role — decides by comparing an EMAIL STRING against ADMIN_EMAILS.
//  Nothing consults a flag on the row. So the account that owns an
//  ADMIN_EMAILS address is admin, full stop, however it came to exist.
//
//  Which means: while an ADMIN_EMAILS address has no account yet,
//  whoever registers it first becomes a full administrator. All three
//  creation doors had that property — POST /signup, POST /google, and
//  the /google/callback redirect flow — and each additionally handed out
//  tier 'pro' with a never-expiring licence on the way in.
//
//  Refusing creation is the fix that matches how authorization actually
//  works here. Signing IN is untouched: once the account exists, every
//  path works normally. Provisioning is deliberate and offline —
//  `node server/scripts/provision-admin.mjs` — so an admin account is
//  never something a stranger can race us to.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function isReservedAdminEmail(email) {
  return DEVELOPER_EMAILS.includes(String(email || '').trim().toLowerCase());
}

// Deliberately does not say "that is an admin address". The owner gets a
// route forward; a stranger probing addresses learns as little as the
// refusal allows.
const RESERVED_EMAIL_MESSAGE =
  'This email address cannot be registered from the app. If it is yours, contact support@minicaai.com.';

function logReservedEmailAttempt(email, route, req) {
  const addr = String(email || '').trim().toLowerCase();
  console.warn(`[auth] REFUSED account creation for a reserved admin address via ${route} — ip=${req?.ip || 'unknown'} email=${addr}`);
  try {
    db.logAdminAction(addr, 'reserved-admin-email-signup-attempt', null, addr, {
      route,
      ip: req?.ip || null,
      user_agent: req?.headers?.['user-agent'] || null,
    });
  } catch { /* audit is best-effort; the refusal above is the control */ }
}

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
    // Reachability (services/emailValidity.js): a one-letter slip on a
    // consumer domain gets the correction back, a domain with no mail
    // records is refused, and DNS trouble on our side fails open. Signup
    // only — login and forgot-password are untouched.
    const reach = await checkEmailDeliverable(email);
    if (!reach.ok) {
      res.locals.authOutcome = `signup:unreachable_email:${reach.reason}`;
      return res.status(400).json({ error: reach.message, ...(reach.suggestion ? { suggestion: reach.suggestion } : {}) });
    }
    if (!isStrongPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check duplicate
    const existing = db.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // Creation door 1 of 3 — see isReservedAdminEmail. Ordered after the
    // duplicate check so an already-provisioned admin address reports the
    // ordinary 409 rather than advertising itself.
    if (isReservedAdminEmail(email)) {
      logReservedEmailAttempt(email, 'POST /signup', req);
      return res.status(403).json({ error: RESERVED_EMAIL_MESSAGE });
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

    // Welcome mail — fire and forget; a mail outage never fails a signup.
    sendWelcomeMail({ user, req, via: 'signup' });

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

// ── Marketing unsubscribe ──
// The signed link in the welcome mail (and every promotional mail after
// it). GET, so it works from any mail client; the token is an HMAC of the
// user id under JWT_SECRET (services/marketingMail.js) — stateless, no
// expiry. Only marketing mail is affected; receipts, password resets and
// security notices still go out.
router.get('/unsubscribe', (req, res) => {
  const u = typeof req.query.u === 'string' ? req.query.u : '';
  const t = typeof req.query.t === 'string' ? req.query.t : '';
  const page = (title, body, color) => `<html><body style="background:#050507;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center;max-width:380px;padding:0 20px"><h2 style="color:${color}">${title}</h2><p style="color:#9ca3af;font-size:13px">${body}</p></div></body></html>`;
  if (!u || !verifyUnsubscribeToken(u, t)) {
    res.locals.authOutcome = 'unsubscribe:bad_token';
    return res.status(400).send(page("This link isn't valid", 'Use the unsubscribe link from a mail we sent you, or write to support@minicaai.com and we will do it for you.', '#f87171'));
  }
  const changed = db.setMarketingOptOut(u, true);
  if (!changed) {
    res.locals.authOutcome = 'unsubscribe:no_such_user';
    return res.status(404).send(page('No such account', 'This account no longer exists, so there is nothing to unsubscribe.', '#f87171'));
  }
  res.locals.authOutcome = 'unsubscribe:ok';
  console.log(`[unsubscribe] user=${u} marketing_opt_out=1`);
  return res.send(page("You're unsubscribed", "No more product updates or offers from minicaai. You'll still get receipts, password resets and security notices for your account.", '#34d399'));
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

    // Credentials were correct — forget this account's failed attempts.
    // The per-account limiter (10 / 15 min, see middleware/rateLimiters.js)
    // is what stops a distributed brute force that IP limiting never
    // could. Counting successes as well as failures would mean a user who
    // legitimately signs in ten times in a quarter hour — reinstalling,
    // moving between the main window and the popout, testing a build —
    // locks themselves out with the RIGHT password. Clearing here keeps
    // the bucket a record of failures only.
    //
    // Deliberately after verifyUserPassword and before the ban check, so a
    // suspended user with correct credentials still gets their counter
    // cleared: they are not the attacker this limiter exists to stop, and
    // their 403 is not something retrying can get around anyway.
    await clearLoginAttempts(user.email);

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
        // Creation door 2 of 3. Holding the Google account for an admin
        // address is not authorization to become an administrator here —
        // and closing only /signup would leave this one wide open.
        if (isReservedAdminEmail(email)) {
          logReservedEmailAttempt(email, 'POST /google', req);
          return res.status(403).json({ error: RESERVED_EMAIL_MESSAGE });
        }
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
        sendWelcomeMail({ user, req, via: 'google' });
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
// ── Redeemed sessions, remembered briefly ──
// The success page keeps the typed code on screen until the app has actually
// collected the token, and it learns that from /google/handoff-status. A
// redeemed session is deleted from pendingGoogleSessions (single-use), so
// without this the page could not tell "the app has it" from "this expired"
// — and would tell a user whose sign-in had timed out that they were signed
// in. Ten minutes outlives the 5-minute pending TTL with room to spare.
const redeemedGoogleSessions = new Map();
const REDEEMED_TTL_MS = 10 * 60 * 1000;
function noteRedeemed(id) {
  if (redeemedGoogleSessions.size >= 5000) {
    const oldest = redeemedGoogleSessions.keys().next().value;
    if (oldest !== undefined) redeemedGoogleSessions.delete(oldest);
  }
  redeemedGoogleSessions.set(id, Date.now());
}
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of pendingGoogleSessions) {
    if (now - session.created_at > 5 * 60 * 1000) pendingGoogleSessions.delete(id);
  }
  for (const [id, at] of redeemedGoogleSessions) {
    if (now - at > REDEEMED_TTL_MS) redeemedGoogleSessions.delete(id);
  }
}, 60 * 1000);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  HANDOFF CODE — the thing that makes /google/poll safe
//
//  The flow above has a hole that entropy alone cannot close. `session_id`
//  is chosen by whoever calls /google/start, and /google/poll hands the
//  minted JWT to whoever presents that id. So:
//
//    1. Attacker calls /google/start?session_id=THEIRS (never finishes it)
//    2. Attacker sends the victim that same /google/start link
//    3. Victim consents with THEIR Google account; the callback files the
//       victim's token under THEIRS
//    4. Attacker polls with THEIRS and collects the victim's session
//
//  Requiring UUID-class entropy in session_id (below) defends against
//  GUESSING an id. It does nothing here, because the attacker isn't
//  guessing — they picked it. Nothing in the old flow ever tied the
//  redeemer to the human who actually consented.
//
//  The fix is a secret that does not exist until AFTER consent, so an
//  attacker who set the session up beforehand cannot know it:
//
//    • /google/callback mints a one-time code and stores only its hash.
//    • The code is delivered ONLY to the browser that completed consent —
//      in the `interview-copilot://` deep link (which the OS routes to the
//      app on THAT machine) and printed on the success page for the human.
//    • /google/poll refuses to release the token without it.
//
//  In the attack the deep link fires on the victim's machine and the code
//  is printed in the victim's browser. The attacker holds session_id and
//  nothing else, so the poll returns `awaiting_code` forever.
//
//  Kept human-typeable (Crockford base32, ambiguous letters removed) so
//  the printed code is a real fallback when the OS protocol handler is
//  unavailable — see the note at setAsDefaultProtocolClient in
//  electron/main.cjs, which fails open by design on sandboxed installs.
//  50 bits behind a 10-try cap and a 5-minute TTL is far past brute force.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const crypto = require('crypto');

// ── DEFAULTS OFF UNTIL THE FLEET HAS UPDATED. READ BEFORE FLIPPING. ──
//
// This defaulted to ON, which is the secure setting and also, on the day
// this merges, a total login outage: the shipped client polls
// `/google/poll?session_id=…` and sends NO code (grep v4.0.18's
// SubscriptionGate.tsx — the request has exactly one query parameter). With
// the code required, that poll returns `awaiting_code` forever, so Google
// sign-in never completes for ANY installed user. Not degraded — impossible.
//
// Off is not "unprotected". The code-less path below still refuses any
// redemption coming from a different address than the one that consented,
// which is the remote-phish takeover this whole mechanism was built for. A
// presented code is still verified, so an updated client gets the full
// guarantee immediately; what an old client loses is only the defence
// against an attacker on the SAME address — a far narrower threat than
// locking every customer out of their account.
//
// It self-reports: every code-less redemption logs a LEGACY warning with
// the account. When those stop appearing, the fleet has updated and this
// can be flipped to 'true' (or the default restored) with no user impact.
// Flipping it before then re-creates the outage.
// ── WHEN IS THE HANDOFF CODE REQUIRED? AN OPERATOR FLAG. NOT A VERSION. ──
//
// This was briefly version-gated: require the code from clients new enough
// to receive one, fall back to the address check for older ones. That is
// UNSOUND and middleware/clientVersion.js says so by name:
//
//   "It must NEVER gate a security control. Version-gating the OAuth handoff
//    code, for instance, would let an attacker downgrade themselves to the
//    weaker path by omitting a header."
//
// Exactly right, and worse than it first looks here: /google/start is opened
// in the user's SYSTEM BROWSER (SubscriptionGate handleGoogleElectron ->
// shell.openExternal), and a browser never sends x-app-version. So a flag
// recorded at start time is false for 100% of real sessions, and the whole
// decision collapses onto the poll request's own header — which the attacker
// simply omits. It protected nobody while reading as though it did.
//
// So: an operator flag, plus the same-address check as the standing floor.
//
//   GOOGLE_POLL_REQUIRE_CODE=true    require the code from everyone
//   GOOGLE_POLL_REQUIRE_CODE=false   never require it (incident escape hatch)
//   unset                            same as false — today's default
//
// ── WHEN IS IT SAFE TO TURN ON? THIS IS NOW ANSWERABLE. ──
//
// The old guidance was "flip it once the fleet has updated", and following it
// would have caused an outage, because the warnings it told you to wait on
// could never stop: macOS/Linux had no CFBundleURLTypes or x-scheme-handler
// (build.protocols was missing from package.json entirely) and helmet's CSP
// blocked the page script that delivers the code on every platform. No amount
// of updating fixed either. Both are fixed as of 2026-08-14.
//
// The real precondition is fleet composition, and every auth request now logs
// `client=<version>` (middleware/authObservability.js). Turn this on when
// that field shows the fleet at or above the first release carrying BOTH
// fixes, and when `outcome=success:legacy_address_match` has gone quiet.
// Until then the address check is doing the work, and it is doing it for
// everyone — including the clients a version gate would have exempted.
const REQUIRE_HANDOFF_CODE =
  String(process.env.GOOGLE_POLL_REQUIRE_CODE || 'false').toLowerCase() === 'true';
const MAX_HANDOFF_ATTEMPTS = 10;
const HANDOFF_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I, L, O, U

function mintHandoffCode() {
  // rejection-free: 32 symbols divides 256 evenly, so a byte maps to a
  // symbol with no modulo bias.
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (const b of bytes) out += HANDOFF_ALPHABET[b % 32];
  return out;
}

// Accepts what a human retypes: any case, with or without the display
// hyphen, and with the shapes Crockford folds (I/L → 1, O → 0).
function normalizeHandoffCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

function hashHandoffCode(raw) {
  return crypto.createHash('sha256').update(normalizeHandoffCode(raw), 'utf8').digest();
}

function handoffCodeMatches(session, presented) {
  if (!session || !session.handoff_hash) return false;
  const normalized = normalizeHandoffCode(presented);
  if (normalized.length !== 10) return false;
  const expected = session.handoff_hash;
  const actual = hashHandoffCode(normalized);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Display form for the human-readable fallback: XXXXX-XXXXX.
function formatHandoffCode(code) {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

// Coarse address identity for the legacy (no-code) path only. Compared at
// /24 for IPv4 and /64 for IPv6 so a NAT pool or a dual-address host does
// not fail a legitimate redemption, while an attacker elsewhere on the
// internet still cannot match. Never used when a code is required.
//
// ── Two bugs this replaces, both of which REFUSED REAL USERS ──
//
// 1. The old code did `raw.split(':').slice(0,4)` on a raw IPv6 string.
//    That is not a /64 when the address is compressed. Measured:
//      2601:249:8000::5          -> "2601:249:8000:"
//      2601:249:8000:0:1:2:3:4   -> "2601:249:8000:0"
//    Same /64, two different answers, redemption refused. Addresses are now
//    fully expanded to eight hextets BEFORE the first four are taken, so
//    every spelling of one address produces one prefix.
//
// 2. An IPv4 prefix and an IPv6 prefix could never be equal, so a dual-stack
//    user whose browser reached us over IPv6 while the app polled over IPv4
//    (or the reverse) was refused 100% of the time — and the old code logged
//    that as "this is what an account-takeover attempt looks like". It is
//    not: it is one laptop on one network. The family is now part of the
//    return value so the caller can tell "different network" (suspicious)
//    apart from "not comparable" (routine), and say so in the log.
function expandIpv6(addr) {
  let a = String(addr).toLowerCase().replace(/^\[|\]$/g, '');
  const pct = a.indexOf('%');            // strip zone id: fe80::1%en0
  if (pct !== -1) a = a.slice(0, pct);

  // A trailing dotted-quad (::ffff:1.2.3.4, 64:ff9b::203.0.113.7) is two
  // hextets written in IPv4 notation. Convert before splitting.
  const dotted = a.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const [, b1, b2, b3, b4] = dotted.map(Number);
    if ([b1, b2, b3, b4].some(n => n > 255)) return null;
    const hi = ((b1 << 8) | b2).toString(16);
    const lo = ((b3 << 8) | b4).toString(16);
    a = a.slice(0, dotted.index) + hi + ':' + lo;
  }

  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  if (halves.length === 1 && head.length !== 8) return null;

  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const full = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (full.length !== 8) return null;
  if (!full.every(h => /^[0-9a-f]{1,4}$/.test(h))) return null;
  return full.map(h => h.replace(/^0+(?=.)/, ''));   // canonical, no leading zeros
}

function addressPrefix(ip) {
  const raw = String(ip || '').trim().toLowerCase();
  if (!raw) return null;

  // An IPv4-mapped IPv6 address is an IPv4 address wearing a costume —
  // compare it as IPv4 so ::ffff:73.102.55.10 and 73.102.55.10 agree.
  const mapped = raw.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const candidate = mapped ? mapped[1] : raw;

  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(candidate)) {
    const octets = candidate.split('.');
    if (octets.some(o => Number(o) > 255)) return null;
    return { family: 'v4', prefix: octets.slice(0, 3).join('.') };   // /24
  }

  if (raw.includes(':')) {
    const hextets = expandIpv6(raw);
    return hextets ? { family: 'v6', prefix: hextets.slice(0, 4).join(':') } : null;
  }

  return null;
}

// 'match'            — same family, same network. Safe to release.
// 'different-family' — one side v4, one side v6. NOT evidence of anything;
//                      a routine dual-stack laptop. Ask for the code.
// 'different-network'— same family, different network. This is the shape an
//                      actual remote-phish takeover has.
// 'unknown'          — an address we could not parse at all.
function compareAddresses(consent, poll) {
  if (!consent || !poll) return 'unknown';
  if (consent.family !== poll.family) return 'different-family';
  return consent.prefix === poll.prefix ? 'match' : 'different-network';
}

// Step 1: Start Google OAuth — redirects browser to Google
router.get('/google/start', (req, res) => {
  const { session_id } = req.query;
  if (!session_id) { res.locals.authOutcome = 'start:missing_session_id'; return res.status(400).send('Missing session_id'); }

  // session_id is CLIENT-generated and later redeems the signed-in user's
  // JWT at /google/poll — so it must carry real entropy. The app has always
  // sent crypto.randomUUID() (36 chars, since the flow shipped); enforce
  // UUID-class shape so a hand-rolled short/guessable id (poll-hijack,
  // device-flow-class weakness) is refused before a session is created.
  // Cap the pending map so a scripted caller can't balloon server memory
  // with junk ids inside the 5-minute TTL window.
  if (typeof session_id !== 'string' || !/^[A-Za-z0-9_-]{21,64}$/.test(session_id)) {
    res.locals.authOutcome = 'start:invalid_session_id';
    return res.status(400).send('Invalid session_id');
  }
  if (pendingGoogleSessions.size >= 5000 && !pendingGoogleSessions.has(session_id)) {
    res.locals.authOutcome = 'start:pending_map_full';
    return res.status(503).send('Sign-in is briefly unavailable. Please try again in a minute.');
  }

  // Both vars are required for the server-side redirect flow used by Electron —
  // CLIENT_SECRET is consumed in /google/callback by oauth2Client.getToken(code).
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!googleClientId || !googleClientSecret) {
    res.locals.authOutcome = 'start:not_configured';
    return res.status(503).send('Google Sign-In not configured on server. Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET.');
  }

  // Store pending session. country_code rides along from the client (which
  // geo-detects before opening the browser) so the callback can create the
  // user/license with their REAL region instead of the old hardcoded 'US'
  // — that hardcode gave every Google-signup the US pricing/trial policy
  // regardless of where they actually are. Strictly validated; anything
  // else falls back to US at consumption time.
  const rawCountry = String(req.query.country_code || '').toUpperCase();
  const countryCode = /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : null;
  // `lp` is the port of the app's loopback listener (4.0.23+) — see THE
  // LOOPBACK HAND-OFF in /google/callback. Strictly an unprivileged port
  // number; anything else is ignored and the flow behaves as it always has.
  const rawLp = String(req.query.lp || '');
  const loopbackPort = /^\d{4,5}$/.test(rawLp) && Number(rawLp) >= 1024 && Number(rawLp) <= 65535
    ? Number(rawLp)
    : null;
  pendingGoogleSessions.set(session_id, {
    created_at: Date.now(),
    status: 'pending',
    country_code: countryCode,
    loopback_port: loopbackPort,
  });

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
  });

  // ── Why prompt=select_account is no longer unconditional ──
  // It forced Google to render an account chooser on EVERY sign-in, which
  // means a user click, which means the success tab's history length is 2 —
  // and Chromium refuses window.close() on any tab with history > 1 that it
  // did not open itself. So the "Signed in" tab could never clean itself up.
  // Without the param, a returning user who has already consented is a pure
  // 302 chain: history length 1, and the tab closes on its own the moment
  // the handoff fires (measured, both ways).
  //
  // The chooser is not gone, it is on demand: the client asks for it with
  // `switch_account=1` behind a "Use a different account" affordance, so a
  // multi-account user is never stuck on whichever session Google picks.
  if (String(req.query.switch_account || '') === '1') {
    params.set('prompt', 'select_account');
  }

  res.locals.authOutcome = params.has('prompt') ? 'start:redirected_with_picker' : 'start:redirected';
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// Step 2: Google redirects here after user consents
router.get('/google/callback', async (req, res) => {
  const { code, state: session_id, error } = req.query;

  // ⚠️ `state` is ATTACKER-CONTROLLED. Google echoes back whatever was put
  // in the authorize URL, and both client_id and redirect_uri are public
  // (they are visible in the 302 from /google/start), so anyone can build a
  // link that sends a victim through a real, valid consent and lands here
  // with a state of their choosing.
  //
  // /google/start validates the shape; this route never did. That was
  // survivable only while the success page's script was dead — helmet's CSP
  // blocked it. The moment that script was given a nonce so it could run,
  // an unvalidated `state` interpolated into a JS string literal became a
  // live XSS on api.minicaai.com, executing under our own nonce: read the
  // printed handoff code out of the DOM, exfiltrate it, then redeem the
  // victim's JWT from /google/poll with the session_id the attacker chose.
  // Full account takeover from one click.
  //
  // Same regex as /google/start. The charset excludes the quote that made
  // the break-out possible, so this alone closes it — and the page below
  // no longer interpolates into script at all, which closes it again.
  if (typeof session_id !== 'string' || !/^[A-Za-z0-9_-]{21,64}$/.test(session_id)) {
    res.locals.authOutcome = 'callback:invalid_state_rejected';
    console.warn(`[google/callback] REFUSED — malformed state (len=${String(session_id || '').length}). This is what a forged authorize link looks like.`);
    return res.status(400).send('<html><body style="background:#050507;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#f87171">Sign-in failed</h2><p style="color:#9ca3af">Please close this window and start sign-in from the app again.</p></div></body></html>');
  }

  if (error || !code || !session_id) {
    if (session_id && pendingGoogleSessions.has(session_id)) {
      pendingGoogleSessions.set(session_id, { created_at: Date.now(), status: 'error', error: error || 'No authorization code received' });
    }
    // `error` comes from the query string, so it is attacker-controlled even
    // though Google is the only party that should ever set it. Constrain it
    // to the charset Google actually uses (access_denied, invalid_request,
    // …) rather than trusting it — anything else becomes 'other'. The access
    // log sanitises control characters too, but a value that can never carry
    // them is better than one that has to be cleaned up downstream.
    const rawErr = String(error || '');
    const safeErr = /^[a-z_]{1,30}$/.test(rawErr) ? rawErr : (rawErr ? 'other' : '');
    res.locals.authOutcome = 'callback:no_code_or_google_error' + (safeErr ? ':' + safeErr : '');
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
      res.locals.authOutcome = 'callback:not_configured';
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
      res.locals.authOutcome = 'callback:google_account_has_no_email';
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
        // Creation door 3 of 3 — the desktop redirect flow. Reports
        // through the pending-session channel because this handler
        // answers to a browser, not to the app.
        if (isReservedAdminEmail(email)) {
          logReservedEmailAttempt(email, 'GET /google/callback', req);
          pendingGoogleSessions.set(session_id, { created_at: Date.now(), status: 'error', error: RESERVED_EMAIL_MESSAGE });
          return res.send('<html><body style="background:#050507;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center;max-width:380px;padding:0 20px"><h2 style="color:#f87171">Can\'t create that account</h2><p style="color:#9ca3af;font-size:13px">This email address cannot be registered from the app. If it is yours, contact support@minicaai.com.</p></div></body></html>');
        }
        isNewUser = true;
        const userId = uuidv4();
        const now = Date.now();
        // Real region from the client's geo-detect, stashed on the pending
        // session at /google/start. Falls back to US only when the client
        // sent nothing (older app builds). The old hardcoded 'US' gave
        // every Google signup US pricing + the free trial and skipped the
        // India paid-only region policy.
        const signupCountry = pendingGoogleSessions.get(session_id)?.country_code || 'US';

        user = db.createUser({
          id: userId,
          email: email.toLowerCase(),
          name: name || email.split('@')[0],
          password: null,
          tier: isDev ? 'pro' : 'free',
          country_code: signupCountry,
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
          country_code: signupCountry,
          expires_at: isDev ? -1 : now + (30 * 24 * 60 * 60 * 1000),
          sessions_limit: isDev ? -1 : 5,
        });
        sendWelcomeMail({ user, req, via: 'google-callback' });
      }
    }

    if (user.is_banned) {
      pendingGoogleSessions.set(session_id, { created_at: Date.now(), status: 'error', error: 'Account suspended' });
      res.locals.authOutcome = 'callback:account_banned';
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

    // Mint the redemption code. This is the first moment in the flow at
    // which a secret exists that the initiator of /google/start could not
    // have known, which is exactly why the binding has to happen here and
    // not at start time. Only the hash is retained.
    const handoffCode = mintHandoffCode();
    // Read before the entry is replaced below: the port the app registered
    // at /google/start lives on the pending entry, and the success entry
    // that follows is built fresh.
    const loopbackPort = pendingGoogleSessions.get(session_id)?.loopback_port || null;

    // Store the result for polling
    pendingGoogleSessions.set(session_id, {
      created_at: Date.now(),
      status: 'success',
      handoff_hash: hashHandoffCode(handoffCode),
      handoff_attempts: 0,
      loopback_port: loopbackPort,
      // Consulted only on the legacy no-code path (GOOGLE_POLL_REQUIRE_CODE
      // =false). The consenting browser and the app that polls run on the
      // same machine in every legitimate sign-in. Now {family, prefix}, so
      // "we cannot compare these" is distinguishable from "these differ".
      consent_ip_prefix: addressPrefix(req.ip || req.connection?.remoteAddress),
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
    const safeHandoff = encodeURIComponent(handoffCode);
    const displayCode = formatHandoffCode(handoffCode);
    // ── THE LOOPBACK HAND-OFF (clients from 4.0.23) ──
    //
    // The deep link and the printed code each assume something about the
    // machine: that the OS routes interview-copilot:// to the app (4.0.22 on
    // macOS shipped without CFBundleURLTypes, so it never did), or that a
    // human will carry ten characters across two windows. Neither held, and
    // every sign-in from a legacy client depended instead on the browser and
    // the app leaving the network through the same /24 — which a VPN with
    // more than one exit breaks on a coin flip. Measured 2026-09-06: eight
    // consents in three minutes for one account, three sign-ins.
    //
    // The app now opens an HTTP listener on 127.0.0.1 for the duration of a
    // sign-in and registers its port at /google/start. This page hands the
    // code to it directly: a fetch to the loopback address, which only the
    // machine running this browser can reach — the same property the deep
    // link relies on, without the OS registration. The attacker in the
    // takeover scenario is on another machine; a fetch to THEIR port on the
    // VICTIM's 127.0.0.1 goes nowhere. Browsers exempt loopback from
    // mixed-content blocking, so an https page may call it.
    //
    // Nothing here is required. No port → no fetch, and the printed code
    // stays the fallback for everyone.
    const loopbackOrigin = loopbackPort ? `http://127.0.0.1:${loopbackPort}` : '';
    const loopbackHref = loopbackOrigin
      ? `${loopbackOrigin}/google-handoff?session_id=${safeSessionId}&amp;code=${safeHandoff}`
      : '';
    // ── CSP: this page's inline script was never running ──
    // helmet() (index.js:71) ships `script-src 'self'` on every response,
    // which blocks an un-nonced inline <script>. This page's ENTIRE handoff
    // lives in one — the `interview-copilot://` navigation AND the reveal of
    // the printed fallback code. Both silently did nothing, on every OS, for
    // every user: the browser logged "Executing inline script violates the
    // following Content Security Policy directive 'script-src 'self''" and
    // moved on. Every sign-in that worked did so through the code-less
    // same-address branch in /google/poll, which is why nobody noticed.
    //
    // Scope a CSP to THIS response with a one-time nonce instead of
    // loosening the global helmet policy — this page is the only one in the
    // service that needs to run script, and it needs to run exactly its own.
    // connect-src covers the two calls the script makes: the status poll on
    // this origin, and — only when the app registered one — its loopback port.
    res.locals.authOutcome = 'callback:success:' + (isNewUser ? 'new_user' : 'returning_user');
    const cspNonce = crypto.randomBytes(16).toString('base64');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${cspNonce}'; ` +
      `connect-src 'self'${loopbackOrigin ? ' ' + loopbackOrigin : ''}; ` +
      `base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    );
    res.setHeader('Cache-Control', 'no-store');
    // ── THE PAGE NO LONGER CLOSES ITSELF ON A TIMER ──
    // It used to call window.close() 1.2 s after landing, on the theory that
    // the deep link had already handed the code over. When the deep link
    // could not fire, that timer destroyed the only copy of the code the
    // app was — at that very moment — asking the user to type. The page now
    // asks /google/handoff-status whether the app has collected the token
    // and closes only then; until then the code stays on screen, and after
    // a couple of seconds it becomes the headline rather than a footnote.
    res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signed in</title></head><body style="background:#050507;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center;max-width:420px;padding:32px 20px"><div id="mark" style="width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg,#10b981,#3b82f6);display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:24px;color:#fff">✓</div><h2 id="headline" style="color:#e5e7eb;margin:0 0 6px;font-weight:600;font-size:18px">Signed in</h2><p id="sub" style="color:#9ca3af;margin:0;font-size:13px">Returning to Interview Copilot…</p><p id="open-row" style="margin:16px 0 0"><a id="open-app" href="interview-copilot://signin-complete?session_id=${safeSessionId}&amp;code=${safeHandoff}" style="color:#60a5fa;font-size:13px;text-decoration:none;border:1px solid rgba(96,165,250,0.4);border-radius:999px;padding:7px 16px;display:inline-block">Open Interview Copilot</a></p><div id="fallback-box" style="margin:22px 0 0"><p id="fallback-lead" style="color:#9ca3af;margin:0 0 10px;font-size:12px">Still waiting? Enter this code in the app:</p><div id="code" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:22px;letter-spacing:2px;color:#e5e7eb;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:12px 16px;display:inline-block">${displayCode}</div><p id="fallback-note" style="color:#6b7280;margin:12px 0 0;font-size:11px">It expires in 5 minutes and works once. Keep this tab open until the app shows you signed in.</p></div><a id="status-url" href="/api/v1/auth/google/handoff-status?session_id=${safeSessionId}" hidden></a>${loopbackHref ? `<a id="loopback-url" href="${loopbackHref}" hidden></a>` : ''}<script nonce="${cspNonce}">
(function(){
  // NOTHING SERVER-SIDE IS INTERPOLATED INTO THIS SCRIPT.
  // It used to build the deep link by substituting safeSessionId into a
  // single-quoted JS string. encodeURIComponent does NOT escape a single
  // quote (it is an unreserved character, verified), so an attacker-chosen
  // OAuth state closed that string literal and ran arbitrary JS under this
  // page's own nonce. Every URL is now read back off an anchor's href at
  // runtime: encodeURIComponent DOES escape the double quote as %22, so a
  // double-quoted HTML attribute cannot be broken out of.
  var byId = function (id) { return document.getElementById(id); };
  var text = function (id, s) { var el = byId(id); if (el) el.textContent = s; };
  var hide = function (id) { var el = byId(id); if (el) el.style.display = 'none'; };
  var href = function (id) { var el = byId(id); return el ? (el.getAttribute('href') || '') : ''; };
  var appUrl = href('open-app');
  var loopbackUrl = href('loopback-url');
  var statusUrl = href('status-url');
  // 1. The app on this machine, through its loopback listener (4.0.23+).
  if (loopbackUrl) {
    try { fetch(loopbackUrl, { mode: 'no-cors', cache: 'no-store', keepalive: true }).catch(function () {}); } catch (e) {}
  }
  // 2. The OS protocol handler. Browsers close (or blank) this tab when the
  //    OS claims the navigation; if nothing is registered it is a no-op.
  try { if (appUrl) window.location.href = appUrl; } catch (e) {}
  // 3. Never close while the code may still be needed. When either hand-off
  //    above worked the app collects the token within a second or two; if it
  //    has not by then, the code becomes the headline and stays until it does.
  var startedAt = Date.now();
  var settled = false;
  var revealTimer = setTimeout(function () {
    if (settled) return;
    text('headline', 'One more step');
    text('sub', 'Enter this code in Interview Copilot to finish signing in.');
    hide('fallback-lead');
  }, 2500);
  function finish(state) {
    if (settled) return;
    settled = true;
    clearTimeout(revealTimer);
    if (state === 'redeemed') {
      text('headline', 'Signed in');
      text('sub', 'You can close this tab.');
      hide('fallback-box');
      hide('open-row');
      // Chromium refuses a scripted close unless the tab was script-opened OR
      // its history length is 1. A pure 302 chain (returning user, already
      // consented) lands at length 1 and the tab closes itself; one click
      // on Google's account picker makes it 2 and the close is refused —
      // which is why /google/start no longer forces prompt=select_account,
      // and why the line above tells the user the tab may be closed.
      try { window.close(); } catch (e) {}
      return;
    }
    var mark = byId('mark');
    if (mark) { mark.textContent = '!'; mark.style.background = '#7f1d1d'; }
    text('headline', 'This sign-in link has expired');
    text('sub', 'Go back to Interview Copilot and start Google sign-in again.');
    hide('fallback-box');
    hide('open-row');
  }
  function tick() {
    if (settled) return;
    if (Date.now() - startedAt > 6 * 60 * 1000) { finish('gone'); return; }
    if (!statusUrl) return;
    fetch(statusUrl, { cache: 'no-store', credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var s = j && j.state;
        if (s === 'redeemed') finish('redeemed');
        else if (s === 'gone' || s === 'error') finish('gone');
        else setTimeout(tick, 2000);
      })
      .catch(function () { setTimeout(tick, 4000); });
  }
  setTimeout(tick, 700);
})();
</script></body></html>`);

  } catch (err) {
    console.error('Google OAuth callback error:', err);
    if (session_id && pendingGoogleSessions.has(session_id)) {
      pendingGoogleSessions.set(session_id, { created_at: Date.now(), status: 'error', error: 'Authentication failed' });
    }
    res.locals.authOutcome = 'callback:exception:' + String((err && err.message) || 'unknown').slice(0, 60).replace(/\s+/g, '_');
    res.send('<html><body style="background:#050507;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#f87171">Something went wrong</h2><p style="color:#9ca3af">Please close this window and try again.</p></div></body></html>');
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  /google/handoff-status — what the "Signed in" page waits on
//
//  The success page used to close itself 1.2 s after landing. Measured in
//  production (2026-09-06): a user on a VPN whose browser and app left
//  through different exits polled `awaiting_code:address_different_network`
//  73 times in a minute — the app was asking for the code, and the only
//  place the code had ever existed was a tab that had already closed. Eight
//  consents in three minutes, three sign-ins, and those three succeeded only
//  because both connections happened to share a /24 that time.
//
//  So the page now asks THIS endpoint whether the app has collected the
//  token, and closes only then. It answers with a state and nothing else:
//    pending   consent not finished (the page is never shown in this state)
//    ready     token minted, not yet collected — keep the code on screen
//    redeemed  the app has it — the tab can go
//    gone      expired, restarted, or never existed — say so, do not say
//              "signed in"
//  Holding a session_id already lets a caller learn all of this from
//  /google/poll, so nothing new is exposed here; the token itself is never
//  in this response.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/google/handoff-status', (req, res) => {
  const { session_id } = req.query;
  if (typeof session_id !== 'string' || !/^[A-Za-z0-9_-]{21,64}$/.test(session_id)) {
    res.locals.authOutcome = 'handoff_status:invalid_session_id';
    return res.status(400).json({ error: 'Invalid session_id' });
  }
  res.setHeader('Cache-Control', 'no-store');
  if (redeemedGoogleSessions.has(session_id)) {
    res.locals.authOutcome = 'handoff_status:redeemed';
    return res.json({ state: 'redeemed' });
  }
  const session = pendingGoogleSessions.get(session_id);
  if (!session) {
    res.locals.authOutcome = 'handoff_status:gone';
    return res.json({ state: 'gone' });
  }
  const state = session.status === 'success' ? 'ready' : session.status === 'error' ? 'error' : 'pending';
  // The page asks every couple of seconds for as long as the code is on
  // screen; the waiting states are not worth a log line each.
  if (state === 'ready' || state === 'pending') res.locals.authQuiet = true;
  res.locals.authOutcome = `handoff_status:${state}`;
  return res.json({ state });
});

// Step 3: Client polls this endpoint to get the auth result
router.get('/google/poll', (req, res) => {
  const { session_id } = req.query;
  if (!session_id) { res.locals.authOutcome = 'poll:missing_session_id'; return res.status(400).json({ error: 'Missing session_id' }); }

  const session = pendingGoogleSessions.get(session_id);
  if (!session) {
    // A session that never existed, or one lost to a server restart —
    // pendingGoogleSessions is in-memory. The client cannot tell these
    // apart from "not finished yet", so it polls until it times out.
    res.locals.authOutcome = 'poll:no_such_session';
    return res.json({ status: 'pending' });
  }

  if (session.status === 'success') {
    // ── Redemption gate ──
    // Holding session_id is not proof of anything: the caller chose it.
    // Proof is the code minted after consent and delivered only to the
    // browser that consented. See the block above mintHandoffCode.
    const presented = req.query.code;

    // ── ONE place decides what a wrong code costs ──
    // The counter used to live inside the require-code branch only, so the
    // legacy branch accepted UNLIMITED wrong guesses: present any `code=` and
    // you skipped the address check and got a free oracle against the session
    // for its whole 5-minute life, while ten wrong guesses on the other
    // branch burned it. 32^10 keeps that impractical, but the branch an
    // attacker can steer into must not be the lenient one. Shared closure so
    // neither path can forget it again.
    const rejectWrongCode = (tag) => {
      session.handoff_attempts = (session.handoff_attempts || 0) + 1;
      if (session.handoff_attempts >= MAX_HANDOFF_ATTEMPTS) {
        // Burn the session rather than let it be ground down. The user
        // signs in again; an attacker gets nothing either way.
        pendingGoogleSessions.delete(session_id);
        console.warn(`[google/poll] handoff code exhausted after ${MAX_HANDOFF_ATTEMPTS} attempts — session burned, ip=${req.ip || 'unknown'}`);
        res.locals.authOutcome = 'error:handoff_attempts_exhausted';
        return res.json({ status: 'error', error: 'Too many incorrect codes. Please sign in again.' });
      }
      res.locals.authOutcome = tag;
      return res.json({ status: 'awaiting_code', invalid_code: true });
    };

    if (REQUIRE_HANDOFF_CODE) {
      if (!presented) {
        // Not an error — the normal state while the deep link is still in
        // flight, and the signal the client uses to show the manual code
        // entry. Deliberately does NOT release anything.
        res.locals.authOutcome = 'awaiting_code:no_code_presented';
        return res.json({ status: 'awaiting_code' });
      }
      if (!handoffCodeMatches(session, presented)) {
        return rejectWrongCode('awaiting_code:wrong_code');
      }
    } else {
      // ── Legacy path (GOOGLE_POLL_REQUIRE_CODE=false) ──
      // Only for a fleet-transition window. A code, if presented, still
      // has to be right — turning the switch off must not turn a wrong
      // code into an accepted one. With no code we fall back to the
      // weaker same-address check, which still stops the remote phish
      // that motivated all of this.
      if (presented) {
        if (!handoffCodeMatches(session, presented)) {
          return rejectWrongCode('awaiting_code:wrong_code_legacy_path');
        }
      } else {
        const pollPrefix = addressPrefix(req.ip || req.connection?.remoteAddress);
        const verdict = compareAddresses(session.consent_ip_prefix, pollPrefix);
        const shownConsent = session.consent_ip_prefix ? `${session.consent_ip_prefix.family}:${session.consent_ip_prefix.prefix}` : 'unparsed';
        const shownPoll = pollPrefix ? `${pollPrefix.family}:${pollPrefix.prefix}` : 'unparsed';

        if (verdict !== 'match') {
          // Three very different situations, logged as three different
          // things. Only 'different-network' resembles an attack; the other
          // two are a dual-stack laptop or an address we could not read, and
          // calling those an attack is what made this undiagnosable before.
          const why = {
            'different-family': `dual-stack client — consent arrived over ${shownConsent.split(':')[0]}, poll over ${shownPoll.split(':')[0]}. Not an attack; the code is required because the two cannot be compared.`,
            'different-network': `consent and poll came from different networks. THIS is the shape of a remote account-takeover attempt.`,
            'unknown': `could not parse one or both addresses.`,
          }[verdict];
          const reasonKey = `address_${verdict.replace('-', '_')}`;
          // Once per session per reason. The app polls every two seconds for
          // up to five minutes while the user reads the code off the browser
          // page, and one verdict repeated 150 times is how a real takeover
          // attempt would hide in plain sight. The access log stays quiet on
          // the repeats for the same reason; the first one is logged in full.
          if (!session.awaiting_logged) session.awaiting_logged = new Set();
          if (session.awaiting_logged.has(reasonKey)) {
            res.locals.authQuiet = true;
          } else {
            session.awaiting_logged.add(reasonKey);
            console.warn(
              `[google/poll] awaiting_code reason=${reasonKey} ` +
              `consent=${shownConsent} poll=${shownPoll} email=${session.data?.user?.email || 'unknown'} — ${why}`
            );
          }
          res.locals.authOutcome = `awaiting_code:${reasonKey}`;
          return res.json({ status: 'awaiting_code', reason: reasonKey });
        }
        console.warn(`[google/poll] LEGACY code-less redemption allowed for ${session.data?.user?.email || 'unknown'} at ${shownPoll} — no handoff code was presented, and the address check is what let it through. See REQUIRE_HANDOFF_CODE for when this path can be closed.`);
        res.locals.authOutcome = 'success:legacy_address_match';
      }
    }

    // Clean up after successful retrieval. Single-use by construction.
    pendingGoogleSessions.delete(session_id);
    noteRedeemed(session_id);
    if (!res.locals.authOutcome) res.locals.authOutcome = 'success:handoff_code_verified';
    return res.json({ status: 'success', ...session.data });
  }

  if (session.status === 'error') {
    pendingGoogleSessions.delete(session_id);
    res.locals.authOutcome = 'error:' + String(session.error || 'unknown').slice(0, 40).replace(/\s+/g, '_');
    return res.json({ status: 'error', error: session.error });
  }

  res.locals.authOutcome = 'poll:pending_consent';
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DELETE MY ACCOUNT
//
//  App Store Review Guideline 5.1.1(v): an app that lets you create an
//  account must let you delete it FROM INSIDE THE APP. "Email support"
//  and "ask the assistant to do it" are both explicitly not enough —
//  and until this route existed, those were the only two ways, because
//  db.deleteUser() was reachable only from the admin surface and the
//  support bot. Play's User Data policy asks for the same thing.
//
//  Password-confirmed, for the obvious reason: a JWT sitting in a
//  browser's localStorage on an unlocked phone should not be one tap
//  away from destroying an account and its interview history.
//
//  Google accounts have no password to confirm with, so they confirm by
//  typing their own email address instead. Refusing to delete them at
//  all would be the wrong trade — an account you cannot delete is the
//  exact thing the guideline exists to prevent.
//
//  Deliberately NOT soft-delete. The point of the guideline is that the
//  data goes, and a `deleted_at` column that keeps every transcript is
//  the thing users are being protected from. See db.deleteUser() for
//  what it reaches — including the device-sync log, which holds the
//  mirrored interview transcripts and has no foreign key to hide behind.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.delete('/account', authMiddleware, (req, res) => {
  try {
    const user = db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { password, confirm_email } = req.body || {};

    if (user.password_hash) {
      if (!password) {
        return res.status(400).json({
          error: 'password_required',
          message: 'Enter your password to delete your account.',
        });
      }
      if (!db.verifyPassword(password, user.password_hash)) {
        return res.status(401).json({
          error: 'wrong_password',
          message: 'That password is not right.',
        });
      }
    } else {
      // OAuth-only account: confirm by typing the address instead.
      const typed = String(confirm_email || '').trim().toLowerCase();
      if (typed !== String(user.email).toLowerCase()) {
        return res.status(400).json({
          error: 'confirm_email_required',
          message: 'Type your email address to confirm.',
        });
      }
    }

    // audit_log deliberately has no FK to users, so this row outlives the
    // account — which is the point. Carrying the email as target_email
    // matters for the same reason: after the delete, target_user_id
    // points at nothing and the address is the only way to answer "did
    // we delete this person when they asked?".
    try {
      db.logAdminAction('self', 'account-deleted', user.id, user.email, {
        tier: user.tier,
        via: 'self-service',
      });
    } catch { /* the deletion matters more than the note about it */ }

    const gone = db.deleteUser(user.id);
    if (!gone) return res.status(404).json({ error: 'User not found' });

    // 200 with a body rather than 204: the client shows a confirmation
    // screen, and an empty response gives it nothing to be sure about.
    res.json({
      success: true,
      message: 'Your account and its data have been deleted.',
    });
  } catch (err) {
    console.error('Account deletion error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

module.exports = router;

// Exported so middleware/authObservability.js can log the SAME prefix this
// file decides with, rather than keeping a second copy that drifts. Attached
// to the router (which is a function) so the module's default export stays
// exactly what every `app.use()` call already expects.
module.exports.addressPrefix = addressPrefix;
module.exports.compareAddresses = compareAddresses;
module.exports.expandIpv6 = expandIpv6;
