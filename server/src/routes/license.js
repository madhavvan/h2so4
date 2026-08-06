const express = require('express');
const { authMiddleware, generateToken } = require('../middleware/auth');
const { adminOnly, stepUpOnly, writeAudit, ADMIN_EMAILS } = require('../middleware/admin');
// Same identity resolver and the same limiter INSTANCES index.js uses, so the
// admin-only endpoints at the bottom of this file share one budget with
// /api/v1/admin/** instead of being a second, uncounted front door (see
// adminNetworkGuard below).
const { rateLimitIdentity } = require('../middleware/rateLimitKey');
const { adminLimiter, adminDestructiveLimiter } = require('../middleware/rateLimiters');
const db = require('../database');
// Shared access predicate (active | canceling | past_due) — the same one
// middleware/tier.js and regionGate.js use, so /validate's lapse handling
// can never drift from what the gates actually enforce.
const { hasAccess } = require('../services/subscriptionStates');
// The WHOLE tier ruling as a function, extracted out of requireTier so the
// signed entitlement claim below reaches its verdict through the exact code
// path the Auto-Type routes are gated by — not a second copy of the ladder
// that agrees today and drifts next quarter.
const { evaluateTier } = require('../middleware/tier');
const entitlementClaim = require('../services/entitlementClaim');

const router = express.Router();

// Sliding-window token rotation: /validate mints a fresh token when the
// caller's current one is within this window of expiry. With the 14d
// default TTL and the client revalidating every ~30 min, active users keep
// a continuously-renewed token and never see a forced re-login; only users
// offline past the TTL must sign in again (bounding a leaked token's life).
const TOKEN_ROTATE_WHEN_S = 7 * 24 * 60 * 60;

// ── Admin network guard for the admin-only endpoints in THIS file ────────
// /revoke and /set-min-version are admin surfaces that live OUTSIDE the
// /api/v1/admin/ prefix, so the guard block in index.js — which only fires
// for `/api/v1/admin` and `/api/v1/admin/**` — never sees them. Both of the
// controls it applies were therefore missing here: the ADMIN_IP_ALLOWLIST
// network check (so a leaked admin JWT was replayable from the open
// internet, defeating the whole point of the allowlist) and the
// destructive-mutation bucket (so nothing capped a burst of revokes, or a
// fleet-wide forced-update flip that locks every running client out on its
// next /validate poll). This applies the SAME two controls locally, in
// FRONT of adminOnly/stepUpOnly — it adds to those guards, never replaces
// them.
//
// The allowlist is parsed per call rather than cached at module load so it
// reads the live env var; the parse and the IPv6-mapped-IPv4 normalization
// are otherwise identical to isAdminIpAllowed() in index.js. (Companion
// cleanup, not done here: hoist that helper into middleware/admin.js and
// have both callers import it so the two copies cannot drift.)
function adminIpAllowed(ip) {
  const allowlist = (process.env.ADMIN_IP_ALLOWLIST || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (allowlist.length === 0) return true; // disabled → allow all
  if (!ip) return false;
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return allowlist.includes(ip) || allowlist.includes(normalized);
}

async function adminNetworkGuard(req, res, next) {
  const identity = rateLimitIdentity(req);
  if (!adminIpAllowed(identity.ip)) {
    // Same action name index.js writes, so one audit query covers both
    // doors. Unlike index.js we run after authMiddleware, so we can name
    // the actor instead of logging 'unknown'.
    try {
      db.logAdminAction(
        (req.user && req.user.email) || 'unknown',
        'admin-ip-blocked',
        null,
        null,
        { path: req.path, method: req.method, ip: identity.ip },
      );
    } catch { /* best-effort */ }
    return res.status(403).json({ error: 'Admin access not allowed from this network' });
  }
  try {
    // Per admin (identity.key is `u:<id>` for a signed-in caller), matching
    // index.js — two admins behind one office VPN do not share a budget.
    await adminLimiter.consume(identity.key);
  } catch {
    return res.status(429).json({ error: 'Admin rate limit exceeded. Wait a minute and retry.' });
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    try {
      await adminDestructiveLimiter.consume(identity.key);
    } catch {
      return res.status(429).json({ error: 'Too many admin mutations. Wait 5 minutes and retry.' });
    }
  }
  next();
}

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

    // ── Repair: a 'canceling' license with no real cycle-end date ──
    // The three cancel writers now guarantee a positive expires_at
    // (subscriptionStates.resolveCancelPeriodEnd), but rows written BEFORE
    // that fix — a canceled Ultra pinned at the -1 unlimited sentinel —
    // terminate through no path at all: the cycle-end sweeper filters
    // expires_at > 0, the auto-transition below does too, and requireTier
    // reads -1 as "never expires". Left alone they serve unlimited Ultra
    // forever on a subscription that is canceled at the provider.
    //
    // Bounding the window is safe in both directions: a monthly cycle end
    // is at most ~31 days out so it can never cut a paying customer short,
    // and no comp/lifetime grant can land here (recordCompPayment writes
    // status='active', never 'canceling' — the only three writers of this
    // status are the two cancel routes and the cancel-at-period-end
    // webhook). Repairing on validate means the next time the user's app
    // checks in, the row rejoins the normal lifecycle.
    if (license.status === 'canceling' && !(license.expires_at > 0)) {
      const repaired = db.repairCancelWindow(license.user_id);
      if (repaired) {
        console.warn(`[license/validate] repaired canceling license with no cycle end: user=${license.user_id} tier=${license.tier} expires_at=${license.expires_at} → +31d`);
        license = db.getLicenseByKey(key);
      }
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

    // ── Lapse handling: answer 200 with the FREE row, never 403 ──────────
    // Two states used to fall into one blanket 403 here, and the 403 was
    // the problem in both:
    //
    //   (a) A paid plan past its expires_at. For the one-time passes this
    //       is the moment the product PROMISES ("then your tier drops to
    //       Free automatically" — ManageSubscription + TIERS.md §9), and
    //       nothing implemented the drop: the cycle-end sweeper only scans
    //       status='canceling', so the row sat at tier='pro' indefinitely
    //       and only requireTier's expiry check kept the user out.
    //
    //   (b) A license the terminal webhooks ALREADY downgraded to free.
    //       customer.subscription.deleted, subscription.updated(canceled|
    //       unpaid), and the Razorpay cancelled/halted/completed handlers
    //       all write tier='free', status='expired' — so EVERY completed
    //       cancellation landed here. That one was the damaging case:
    //       licenseService.validateWithServer deliberately never degrades
    //       on a non-OK response (a failed revalidation must not disrupt a
    //       live interview), so the client kept serving the STALE PAID
    //       tier out of cache. Cancel Ultra and the header badge still
    //       said Ultra — forever, until the user happened to log out —
    //       while Manage Subscription (which reads /payments/subscription)
    //       correctly said free. The client can only learn about a
    //       downgrade from a 200.
    //
    // Revoked/suspended licenses are unaffected — they return 403 above.
    //
    // Deliberately NOT transitioned: 'paused'. Both pause handlers pin
    // expires_at to Date.now() while PRESERVING the tier on the license
    // precisely so customer.subscription.resumed can restore from the same
    // row — a "past its expires_at" test alone would read a paused sub as
    // lapsed and burn the tier the resume path needs. Same reasoning keeps
    // 'refunded' and 'disputed' out: those are already tier='free' and
    // their status carries accounting/fraud meaning worth preserving. So
    // the predicate is "terminal, or an ACCESS status whose clock ran out".
    const lapsedPaidPlan = license.tier !== 'free'
      && (license.status === 'expired'
        || (hasAccess(license.status) && license.expires_at > 0 && Date.now() > license.expires_at));
    if (lapsedPaidPlan) {
      try {
        const transitioned = db.transitionLicenseToFree(license.user_id, { reason: 'validate-lapsed' });
        if (transitioned && transitioned.transitioned) {
          console.log(`[license/validate] lapsed-plan transition: user=${license.user_id} ${transitioned.from.tier} → free`);
          // Same once-only email as the sweeper — transitionLicenseToFree is
          // synchronous and idempotent, so whichever path catches the lapse
          // first is the only one that reports transitioned:true.
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
        }
      } catch (lapseErr) {
        console.warn('[license/validate] lapsed-plan transition failed:', lapseErr.message);
      }
      license = db.getLicenseByKey(key);
    } else if (license.tier === 'free' && license.status === 'expired') {
      // Case (b) once the tier is already free — the exact row every
      // terminal cancellation webhook writes. Purely a status/window
      // normalize: no entitlement changes hands, so no access-ended email
      // is owed here (the cancel path sends its own confirmation, and the
      // paid→free transition above owns the goodbye). Kept OUT of
      // transitionLicenseToFree so that function's `transitioned` flag —
      // which gates that email — keeps meaning "a paid plan just ended".
      // Scoped to 'expired' only: a fresh free signup sits at 'trial' and
      // must stay there, and 'refunded'/'disputed' are meaningful states
      // that already answer 200.
      db.normalizeFreeLicenseRow(license.user_id);
      license = db.getLicenseByKey(key);
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
    //
    // ── A SCOPED token must never be laundered into an ordinary session ──
    // An admin impersonation JWT (routes/admin.js issues it with an explicit
    // '30m' plus impersonatedBy/impersonatedAt) carries the TARGET user's
    // email, so callerIsAdmin is false for it, and its ~1800s of remaining
    // life is always inside the 7-day rotation window. Every impersonated
    // /validate call therefore used to hand back a fresh 14-day token for
    // the victim with the impersonation claims stripped — turning a short,
    // audited, attributable session into an indefinite unattributable one.
    // Step-up tokens (stepUp/stepUpAt) have the same laundering shape.
    //
    // So for a scoped token we (a) carry the markers forward so downstream
    // guards and audit still see them, and (b) cap the new token at the
    // ORIGINAL token's absolute expiry: rotation may refresh the tier claim,
    // it may never extend the deadline the issuer set. Ordinary sessions are
    // untouched and still rotate to the default 14d TTL.
    let rotatedToken;
    try {
      const nowS = Math.floor(Date.now() / 1000);
      if (!callerIsAdmin && req.user.exp && (req.user.exp - nowS) < TOKEN_ROTATE_WHEN_S) {
        const claims = { id: user.id, email: user.email, tier: license.tier };
        // Left undefined for an ordinary session token → generateToken's
        // DEFAULT_TOKEN_TTL, exactly as before.
        let scopedTtlS;
        if (req.user.impersonatedBy) {
          claims.impersonatedBy = req.user.impersonatedBy;
          claims.impersonatedAt = req.user.impersonatedAt || 0;
          scopedTtlS = req.user.exp - nowS;
        }
        if (req.user.stepUp) {
          // stepUpOnly re-checks stepUpAt against STEP_UP_TTL_MS, so carrying
          // the ORIGINAL timestamp preserves that guard rather than silently
          // restarting the 15-minute reauth window.
          claims.stepUp = true;
          claims.stepUpAt = req.user.stepUpAt || 0;
          scopedTtlS = req.user.exp - nowS;
        }
        if (scopedTtlS === undefined) {
          rotatedToken = generateToken(claims);
        } else if (scopedTtlS > 0) {
          rotatedToken = generateToken(claims, scopedTtlS);
        }
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

// ── Signed entitlement claim (called by the Electron main process) ──
//
// The desktop app caches Auto-Type entitlement for a week so the feature
// survives hotel wifi and Local-Only mode (see AT_ENTITLEMENT_GRACE_MS in
// electron/main.cjs). Until now that cache was a plain {ok:true, at:...}
// file under userData — a grant the user can write for themselves with a
// text editor, which made the seven-day window a seven-day hole. This
// endpoint hands back the same verdict as an Ed25519-signed claim: the app
// verifies it with a public key compiled into the binary and cannot forge a
// replacement, because the private half never leaves the server.
//
// Deliberately NOT a gate. It answers 200 for everyone, including a claim
// that says autoType:false — a SIGNED denial is the thing that lets the
// client positively drop a stale grant when a subscription ends, instead of
// guessing from a 403 that could equally mean "expired token" or "we're
// down". Returning 403 to a Basic user here would throw that away.
const ENTITLEMENT_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Mirrors ULTRA_ONLY in routes/ai.js (the list behind /autotype-plan,
// /autotype-agent and /autotype-vision). Written out as a literal rather
// than imported because routes must not depend on other routes — ai.js
// pulls in every model SDK, and requiring it from here to read one array
// would drag all of that into this module's load path. The shared thing
// that actually enforces the answer is evaluateTier, and that IS imported.
const AUTO_TYPE_TIERS = ['ultra'];

router.get('/entitlements', authMiddleware, (req, res) => {
  try {
    if (!entitlementClaim.isConfigured()) {
      // 501, never 500. The desktop app reads "not implemented on this
      // server" as "fall back to the older unsigned probe", so a deploy
      // that ships this code before ENTITLEMENT_PRIVATE_KEY is set keeps
      // working for paying customers instead of silently disabling the
      // feature they bought. A 500 here would look like an outage and get
      // retried forever.
      return res.status(501).json({ error: 'entitlement_signing_not_configured' });
    }

    const decision = evaluateTier(req.user, AUTO_TYPE_TIERS);
    // The live tier, reported for display and diagnostics only — `autoType`
    // is the authoritative field and the two are independent on purpose.
    // An admin bypass, for instance, yields autoType:true over whatever
    // tier their row actually holds; that is exactly what requireTier does
    // on the Auto-Type routes, so the claim tells the same story the API
    // will. Denials carry the tier in `current` ('none' when there is no
    // license row at all).
    const tier = decision.ok
      ? ((decision.license && decision.license.tier) || 'none')
      : ((decision.body && decision.body.current) || 'none');

    const iat = Date.now();
    const claim = entitlementClaim.signClaim({
      v: 1,                       // payload version — inside the signature,
                                  // unlike the envelope's own `v`
      sub: req.user.id,           // binds the claim to ONE account: a grant
                                  // minted for A is worthless on B, so a
                                  // cached Ultra claim cannot be passed
                                  // around between installs
      autoType: decision.ok === true,
      tier,
      iat,
      exp: iat + ENTITLEMENT_CLAIM_TTL_MS,
    });

    res.json(claim);
  } catch (err) {
    // Only a genuine failure reaches here (the database threw). That is not
    // an entitlement answer and must not be signed as one — the client
    // treats a 5xx as "learned nothing" and keeps whatever valid claim it
    // already holds.
    console.error('Entitlement claim error:', err);
    res.status(500).json({ error: 'Failed to issue entitlement claim' });
  }
});

// ── Revoke a license (admin only, step-up required) ──
// Pre-v3.4.7 used a bare `ADMIN_EMAILS.includes` check with no step-up
// reauth and no audit log — i.e. a compromised admin token could revoke
// any license without leaving a trace. Now uses the same guard chain as
// the destructive endpoints in admin.js (refunds, delete user) and
// writes an audit row that the SQLite triggers protect from tampering.
router.post('/revoke', authMiddleware, adminNetworkGuard, adminOnly, stepUpOnly, async (req, res) => {
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
router.post('/set-min-version', authMiddleware, adminNetworkGuard, adminOnly, stepUpOnly, async (req, res) => {
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
