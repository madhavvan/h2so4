const jwt = require('jsonwebtoken');

// JWT_SECRET must be set explicitly in production. Falling back to a
// hardcoded string at module load would let a deployment mistake ship a
// publicly-known signing key, which is a total auth bypass. Crash at
// boot instead so the mistake shows up in logs immediately.
const JWT_SECRET = process.env.JWT_SECRET
  || (process.env.NODE_ENV === 'production'
        ? null
        : 'minicaai-dev-secret-change-in-production');
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is required in production. Refusing to start.');
  process.exit(1);
}

// Default session-token lifetime. Shorter than the historical 30d so a
// leaked token is useful for days, not a month. Active clients never feel
// it: the app revalidates every ~30 min and /license/validate rotates the
// token when it nears expiry (licenseService saves the rotated value), so
// only users offline longer than this must sign in again. Override with
// JWT_TTL (e.g. '7d'). Callers needing a shorter scoped token (admin
// impersonation, step-up reauth) still pass an explicit expiresIn.
const DEFAULT_TOKEN_TTL = process.env.JWT_TTL || '14d';
function generateToken(payload, expiresIn = DEFAULT_TOKEN_TTL) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = verifyToken(token);

    // Force-logout check. If an admin has bumped `tokens_revoked_after` on
    // this user, every JWT issued before that moment is invalid even if its
    // signature and expiry are still good. `iat` is in seconds, the stored
    // timestamp is in ms — convert before comparing. Required lazily so we
    // don't force a circular import at module load.
    if (decoded && decoded.id) {
      const db = require('../database');
      const revokedAfter = db.getTokensRevokedAfter(decoded.id);
      if (revokedAfter && decoded.iat && decoded.iat * 1000 < revokedAfter) {
        return res.status(401).json({ error: 'Session revoked — please sign in again' });
      }
    }

    // Expose step-up + impersonation metadata on req.user so downstream
    // middleware (stepUpOnly in admin.js) and route handlers can enforce
    // additional constraints. These claims are set by /admin/reauth and
    // /admin/users/:id/impersonate; missing → defaults to false/null.
    req.user = {
      ...decoded,
      stepUp: !!decoded.stepUp,
      stepUpAt: decoded.stepUpAt || 0,
      impersonatedBy: decoded.impersonatedBy || null,
      impersonatedAt: decoded.impersonatedAt || 0,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { generateToken, verifyToken, authMiddleware };
