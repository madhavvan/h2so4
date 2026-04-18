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

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
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

    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { generateToken, verifyToken, authMiddleware };
