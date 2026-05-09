// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Semver comparison
//
//  Used by the auto-update gate (index.js /version endpoint) to decide
//  whether a client is outdated, must-update, or current. A bug here is
//  a 20k-user blast: invert the sign and either nobody updates (stale
//  clients forever, security patches stuck) or everyone gets pushed to
//  a possibly-broken release. Extracted from index.js so unit tests can
//  exercise the matrix (major/minor/patch/equal) without booting Express.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Treats missing components as 0 (e.g. "3.4" → "3.4.0").
 * Strips a leading 'v' if present and ignores prerelease suffixes
 * after the first '-' (treats "3.4.9-beta.1" as "3.4.9").
 */
function compareVersions(a, b) {
  const norm = (v) => String(v || '').replace(/^v/i, '').split('-')[0];
  const pa = norm(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = norm(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

module.exports = { compareVersions };
