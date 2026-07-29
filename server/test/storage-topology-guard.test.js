// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  STORAGE TOPOLOGY GUARD — is the database actually on the volume?
//
//  There was already a boot guard refusing to start in production when
//  DATABASE_PATH is unset, because SQLite would otherwise write to the
//  container's ephemeral filesystem and lose every user, license and
//  payment on the next redeploy.
//
//  It only asked whether the variable was SET. DATABASE_PATH=/app/data/db
//  passes it cleanly and produces exactly the outcome the guard exists to
//  prevent. Railway publishes the mount point as RAILWAY_VOLUME_MOUNT_PATH,
//  so "is it set" can be "is it in the right place".
//
//  The volume carries a second, less obvious guarantee. Railway's docs say
//  "Replicas cannot be used with volumes", so the attached volume is also
//  what pins this service to a single instance — which the six background
//  sweeps, the WebSocket registries and the in-memory rate limiters all
//  depend on. Nothing in the app enforces that (RAILWAY_REPLICA_ID is an
//  opaque id with no ordinal, so a process cannot tell it is replica #2),
//  which is why losing the volume warns rather than passing silently.
//
//  These run the real module in a child process, because the behaviour
//  under test is process.exit().
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');

let volume;
beforeAll(() => { volume = mkdtempSync(path.join(tmpdir(), 'vol-')); });
afterAll(() => { try { rmSync(volume, { recursive: true, force: true }); } catch {} });

/**
 * Boot database.js in a child process with the given env.
 *
 * spawnSync rather than execFileSync specifically because the no-volume
 * case warns via console.warn, which lands on stderr — execFileSync returns
 * stdout only, so that warning was invisible and the test failed against
 * correct code.
 */
function boot(env) {
  const r = spawnSync(
    process.execPath,
    ['-e', "require('./src/database.js').getDB(); console.log('BOOTED');"],
    { cwd: serverRoot, env: { ...process.env, ...env }, encoding: 'utf8' },
  );
  return { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// Each case gets its own DB filename so a passing run never reuses another's.
const dbOnVolume = () => path.join(volume, `ok-${Math.random().toString(36).slice(2)}.db`);

describe('production — database must live on the attached volume', () => {
  it('starts when DATABASE_PATH is on the volume', () => {
    const r = boot({
      NODE_ENV: 'production',
      RAILWAY_VOLUME_MOUNT_PATH: volume,
      DATABASE_PATH: dbOnVolume(),
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('BOOTED');
    expect(r.out).toContain('(on volume)');
  });

  it('REFUSES to start when a volume is attached but the database is not on it', () => {
    // The gap the original guard missed: set, but ephemeral.
    const r = boot({
      NODE_ENV: 'production',
      RAILWAY_VOLUME_MOUNT_PATH: volume,
      DATABASE_PATH: path.join(tmpdir(), 'not-on-the-volume.db'),
    });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('BOOTED');
    expect(r.out).toContain('not on the attached Railway Volume');
  });

  it('still refuses to start when DATABASE_PATH is unset (original guard intact)', () => {
    const r = boot({ NODE_ENV: 'production', DATABASE_PATH: '', RAILWAY_VOLUME_MOUNT_PATH: '' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('DATABASE_PATH is not set in production');
  });

  it('treats the mount path itself as on-volume', () => {
    // Defensive: a DATABASE_PATH equal to the mount point is odd but is not
    // the ephemeral-storage mistake this guard is looking for, so it must
    // not be a false positive.
    const r = boot({
      NODE_ENV: 'production',
      RAILWAY_VOLUME_MOUNT_PATH: volume,
      DATABASE_PATH: volume,
    });
    expect(r.out).not.toContain('not on the attached Railway Volume');
  });

  it('is not fooled by a sibling directory that shares a prefix', () => {
    // "/data-old/db.sqlite" must not count as living under "/data".
    const r = boot({
      NODE_ENV: 'production',
      RAILWAY_VOLUME_MOUNT_PATH: volume,
      DATABASE_PATH: `${volume}-old${path.sep}db.sqlite`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('not on the attached Railway Volume');
  });
});

describe('production — no volume at all', () => {
  it('warns loudly but still starts', () => {
    // Not fatal: the deploy may legitimately not be on Railway. But both the
    // storage guarantee and the implicit replica block are gone, so it must
    // not pass in silence.
    const r = boot({
      NODE_ENV: 'production',
      RAILWAY_VOLUME_MOUNT_PATH: '',
      DATABASE_PATH: path.join(volume, 'novolume.db'),
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('BOOTED');
    expect(r.out).toContain('No RAILWAY_VOLUME_MOUNT_PATH in production');
    expect(r.out).toContain('scaled to >1 replica');
  });
});

describe('development — untouched', () => {
  it('starts with no volume variables and says nothing about topology', () => {
    const r = boot({ NODE_ENV: '', RAILWAY_VOLUME_MOUNT_PATH: '', DATABASE_PATH: ':memory:' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('BOOTED');
    expect(r.out).not.toContain('No RAILWAY_VOLUME_MOUNT_PATH');
    expect(r.out).not.toContain('not on the attached Railway Volume');
  });
});
