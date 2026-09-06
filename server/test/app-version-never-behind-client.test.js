// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  /api/v1/app-version MUST NEVER CALL AN OLDER BUILD "LATEST".
//
//  The release cache lags the fleet by design (15-minute GitHub cache, a
//  literal on cold boot) while auto-update reaches machines within minutes
//  of publish. On 2026-09-06 two releases shipped in one evening; a client
//  on the newer one asking the endpoint during the lag would have been told
//  the older one was latest. Nothing good is built on that sentence.
//
//  The rule lives in utils/version.js so it can be exercised without
//  booting Express; the source pin proves the handler actually uses it.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const { latestForClient, compareVersions } = require('../src/utils/version.js');

describe('latestForClient', () => {
  it('a client ahead of the cache is told its own version is latest', () => {
    expect(latestForClient('4.0.23', '4.0.24')).toBe('4.0.24');
    expect(latestForClient('4.0.23', 'v4.0.24')).toBe('4.0.24');
    expect(latestForClient('4.0.23', '4.1.0')).toBe('4.1.0');
  });

  it('a client behind or equal gets the real latest', () => {
    expect(latestForClient('4.0.24', '4.0.23')).toBe('4.0.24');
    expect(latestForClient('4.0.24', '4.0.24')).toBe('4.0.24');
    expect(latestForClient('4.0.24', '3.4.9')).toBe('4.0.24');
  });

  it('malformed or missing client versions never win', () => {
    for (const junk of ['0.0.0', '', undefined, null, 'dev', '4.0', '99', '4.0.24-beta.1', '<script>']) {
      expect(latestForClient('4.0.24', junk), `client="${junk}"`).toBe('4.0.24');
    }
    // 0.0.0 is well-formed but never ahead, so it also gets the real latest.
    expect(compareVersions('0.0.0', '4.0.24')).toBeLessThan(0);
  });

  it('the handler uses it, and derives isOutdated from the clamped value', () => {
    const src = readFileSync(join(HERE, '..', 'src', 'index.js'), 'utf8')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const handler = src.slice(src.indexOf("app.get('/api/v1/app-version'"));
    expect(handler).toContain('const latestVersion = latestForClient(latest.version, clientVersion);');
    expect(handler).toContain('const isOutdated = compareVersions(clientVersion, latestVersion) < 0;');
    expect(handler).toContain('latest: latestVersion,');
    expect(src).toContain("const { compareVersions, latestForClient } = require('./utils/version');");
  });
});
