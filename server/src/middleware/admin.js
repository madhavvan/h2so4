// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADMIN GUARDS — shared between routes/admin.js and routes/license.js
//
//  Extracted into a middleware module so both files use the SAME
//  authorization logic. Without this shared module, routes/license.js's
//  /revoke and /set-min-version were doing a bare `ADMIN_EMAILS.includes`
//  check with no step-up, no audit log, and no unauthorized-attempt
//  logging — i.e. a compromised admin token could revoke any license
//  without leaving a trace. Centralizing fixes that across the codebase.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const db = require('../database');

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// Step-up reauth TTL. Once an admin reauths with their password we issue
// a short-lived token with stepUp=true. 15 minutes is long enough to work
// through a batch of refunds without constant password prompts, short
// enough that a walked-away laptop can't be used to delete users
// indefinitely.
const STEP_UP_TTL_MS = 15 * 60 * 1000;

function adminOnly(req, res, next) {
  const email = (req.user?.email || '').toLowerCase();
  if (!ADMIN_EMAILS.includes(email)) {
    // Audit the attempt. Someone with a valid user JWT trying to call
    // admin endpoints is the signal we most want to see in logs.
    try {
      db.logAdminAction(
        email || 'unknown',
        'unauthorized-admin-attempt',
        req.user?.id || null,
        email || null,
        { path: req.path, method: req.method, ip: req.ip },
      );
    } catch { /* best-effort */ }
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Step-up guard — the JWT must carry stepUp=true AND a stepUpAt claim
// that is within STEP_UP_TTL_MS of now. We re-verify the timestamp rather
// than trusting the token's expiry, so an old admin token can't be
// replayed without another password prompt.
function stepUpOnly(req, res, next) {
  const u = req.user || {};
  if (!u.stepUp || !u.stepUpAt) {
    return res.status(403).json({
      error: 'step_up_required',
      message: 'This action requires password re-verification. Please reauth.',
    });
  }
  if (Date.now() - u.stepUpAt > STEP_UP_TTL_MS) {
    return res.status(403).json({
      error: 'step_up_expired',
      message: 'Step-up session expired. Please reauth.',
    });
  }
  next();
}

// Audit helper — wraps db.logAdminAction with consistent payload shape
// (ip, user_agent) so every admin write produces the same row schema.
// Imported by both admin.js and license.js so a /revoke call leaves the
// same kind of evidence as a /users/:id PATCH.
function writeAudit(req, action, target, details) {
  try {
    db.logAdminAction(
      req.user.email,
      action,
      target?.id || null,
      target?.email || null,
      { ...(details || {}), ip: req.ip, user_agent: req.get('user-agent') || null },
    );
  } catch (err) {
    console.error('[admin] audit insert failed:', err.message);
  }
}

module.exports = {
  adminOnly,
  stepUpOnly,
  writeAudit,
  ADMIN_EMAILS,
  STEP_UP_TTL_MS,
};
