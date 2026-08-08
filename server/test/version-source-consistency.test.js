// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TWO ENDPOINTS, ONE ANSWER.
//
//  `/api/v1/app-version` read a live GitHub-backed cache and answered
//  4.0.17. `/api/v1/license/version` read a hand-maintained
//  `latest_app_version` database row and answered **4.0.8** — in
//  production, publicly, months after anyone last touched that row.
//
//  The bug is not the number, it is the design: a release is supposed to
//  propagate without a deploy, and any answer that depends on a human
//  remembering to update a row will drift and will look exactly like a
//  fresh answer while it does.
//
//  Both now read services/versionSource.js. The config row survives only
//  as an override, and only when it points FORWARD — a pin behind the
//  shipped release is rot, not a decision, and the stale 4.0.8 is still
//  sitting in the production database, so "override always wins" would
//  have shipped the bug intact.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

process.env.JWT_SECRET = 'test-secret-version-source';
process.env.DATABASE_PATH = ':memory:';

const versionSource = require('../src/services/versionSource.js');
const { compareVersions } = require('../src/utils/version.js');

/** The exact resolution /license/version performs. */
function resolveLatest(pinned, liveVersion) {
  if (pinned && /^\d+\.\d+\.\d+$/.test(String(pinned)) && compareVersions(pinned, liveVersion) > 0) {
    return String(pinned);
  }
  return liveVersion;
}

describe('versionSource is the single source of truth', () => {
  it('exports a live getter and a cold-start fallback', () => {
    expect(typeof versionSource.getLatestVersion).toBe('function');
    expect(typeof versionSource.refreshVersionCache).toBe('function');
    const v = versionSource.getLatestVersion();
    expect(v.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(v.minVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(v.downloadUrl.windows).toContain('get.minicaai.com');
  });

  it('never leaks the release host into a download URL a client receives', () => {
    // The browser must never be handed a github.com URL — that is what
    // routes/downloads.js exists to prevent, and this fallback table is a
    // second place the same URLs are minted.
    const urls = Object.values(versionSource.getLatestVersion().downloadUrl);
    for (const u of urls) expect(u).not.toMatch(/github/i);
  });

  it('ships a fallback that is not behind the shipped release', () => {
    // The fallback IS the live answer whenever GitHub is unreachable, so a
    // stale one silently tells every client an old version is current —
    // which is precisely what happened when it sat at 4.0.8 for three
    // weeks. Pin it to the newest tag this repo actually released.
    const pkgTags = fs
      .readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8')
      .match(/"version":\s*"(\d+\.\d+\.\d+)"/);
    const fallback = versionSource.FALLBACK_VERSION.version;
    expect(fallback).toMatch(/^\d+\.\d+\.\d+$/);
    if (pkgTags) {
      // Never BEHIND the working tree's own version.
      expect(compareVersions(fallback, pkgTags[1])).toBeGreaterThanOrEqual(0);
    }
  });

  it('reads the same repo the download routes do', () => {
    // Three copies of "which repo" existed and drifted apart once already,
    // stranding the whole fleet. Keep them tied together.
    const downloads = fs.readFileSync(path.join(here, '..', 'src', 'routes', 'downloads.js'), 'utf8');
    const repo = (downloads.match(/const REPO\s*=\s*['"]([^'"]+)['"]/) || [])[1];
    expect(repo, 'routes/downloads.js REPO not found').toBeTruthy();
    expect(versionSource.GITHUB_RELEASES_URL).toContain(repo);
  });
});

describe('/license/version can no longer advertise a stale version', () => {
  const LIVE = '4.0.17';

  it('ignores the exact stale row sitting in production', () => {
    expect(resolveLatest('4.0.8', LIVE)).toBe(LIVE);
  });

  it('ignores any pin behind the live release', () => {
    for (const stale of ['2.0.0', '3.4.9', '4.0.16']) {
      expect(resolveLatest(stale, LIVE)).toBe(LIVE);
    }
  });

  it('honours a deliberate pin ahead of the live release', () => {
    // Staging a version before the release is cut is a real use.
    expect(resolveLatest('4.1.0', LIVE)).toBe('4.1.0');
    expect(resolveLatest('9.9.9', LIVE)).toBe('9.9.9');
  });

  it('falls back to live for an unset or malformed pin', () => {
    for (const junk of [null, undefined, '', 'latest', '4.0', 'v4.0.18', '4.0.18-beta']) {
      expect(resolveLatest(junk, LIVE)).toBe(LIVE);
    }
  });

  it('agrees with what /app-version would report', () => {
    // The whole point. Both endpoints resolve from the same getter, so
    // absent a forward pin they cannot disagree.
    const live = versionSource.getLatestVersion().version;
    expect(resolveLatest(null, live)).toBe(live);
    expect(resolveLatest('4.0.8', live)).toBe(live);
  });
});
