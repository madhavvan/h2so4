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

/**
 * The "latest" version to REPORT to a client, given what the release cache
 * knows and what the client says it is running.
 *
 * The cache can lag the fleet: it is refreshed from GitHub every 15 minutes
 * and starts from a literal on a cold boot, while auto-update reaches a
 * machine within minutes of publish. In that window a client asks "am I
 * outdated?" while running a version the cache has not heard of — and the
 * honest answer is "no", not "the latest is the older one". Reporting the
 * cache's older number is what a downgrade offer would be built on, and
 * nothing good is built on it. So: never report a latest BELOW a well-formed
 * client version; a client that is ahead is told its own version is latest
 * until the cache catches up. Malformed or missing client versions ("0.0.0",
 * "dev", "") never win — they are exactly the callers that must be told the
 * real latest.
 */
function latestForClient(latestKnown, clientVersion) {
  const known = String(latestKnown || '');
  const client = String(clientVersion || '').trim();
  if (!/^v?\d+\.\d+\.\d+$/.test(client)) return known;
  return compareVersions(client, known) > 0 ? client.replace(/^v/i, '') : known;
}

module.exports = { compareVersions, latestForClient };
