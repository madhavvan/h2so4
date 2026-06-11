// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Daily SQLite backup + rotation
//
//  SQLite has no native replication. The Railway Volume is durable
//  but a single point of failure: a corrupted page (rare with WAL
//  but possible), a misconfigured deploy that detaches the volume,
//  or a manual delete in the dashboard would erase every paying
//  customer with no recovery path. This module runs a daily
//  `VACUUM INTO` snapshot and keeps the last 7 days. Snapshots
//  live alongside the live DB on the same volume by default; for
//  off-box redundancy, set BACKUP_PATH to a second mount.
//
//  VACUUM INTO is the right primitive here:
//    - Atomic (snapshot is consistent even with active writers)
//    - Compacts the file (no fragmentation buildup over time)
//    - No external tools needed (better-sqlite3 supports it natively)
//
//  Cost: depends on DB size. ~50MB DB takes ~1s to snapshot.
//  Runs at server-internal interval (no cron daemon required).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const fs = require('fs');
const path = require('path');
const db = require('./database');

const RETENTION_DAYS = 7;

function getBackupDir() {
  // Default: <volume_root>/backups, sibling of the live DB. Configurable
  // via BACKUP_PATH for users who attach a second Railway Volume to a
  // different mount path for off-primary-volume redundancy.
  if (process.env.BACKUP_PATH) return process.env.BACKUP_PATH;
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'minicaai.db');
  return path.join(path.dirname(dbPath), 'backups');
}

function dailyBackupFilename() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `minicaai-${yyyy}-${mm}-${dd}.db`;
}

function rotateOld(backupDir) {
  // Delete backups older than RETENTION_DAYS. Look for our own naming
  // pattern only (so we don't nuke unrelated files an operator may have
  // dropped in this directory by mistake).
  let entries;
  try { entries = fs.readdirSync(backupDir); }
  catch (err) {
    if (err.code === 'ENOENT') return; // no backups dir yet, nothing to rotate
    throw err;
  }
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const name of entries) {
    if (!/^minicaai-\d{4}-\d{2}-\d{2}\.db$/.test(name)) continue;
    const full = path.join(backupDir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        console.log(`[backup] rotated out: ${name}`);
      }
    } catch (err) {
      console.warn(`[backup] rotate stat/unlink failed for ${name}:`, err.message);
    }
  }
}

function runBackup() {
  const backupDir = getBackupDir();
  try {
    fs.mkdirSync(backupDir, { recursive: true });
  } catch (err) {
    console.error('[backup] failed to create backup dir:', err.message);
    return;
  }

  const target = path.join(backupDir, dailyBackupFilename());
  const startedAt = Date.now();
  try {
    // VACUUM INTO is atomic and safe with concurrent readers/writers.
    // It produces a fresh, defragmented SQLite file at `target`.
    // If today's snapshot already exists, overwrite it (re-running on
    // restart should be a no-op, not an error).
    if (fs.existsSync(target)) fs.unlinkSync(target);
    const sqlite = db.getDB();
    // Parameterized SQL is not allowed for VACUUM INTO; we hand-build the
    // path. Sanitize so a hostile BACKUP_PATH can't escape — must be an
    // absolute path with no quotes/semicolons. (Defense-in-depth — env
    // is operator-controlled, not user-controlled.)
    if (target.includes("'") || target.includes(';') || target.includes('"')) {
      throw new Error('Refusing to VACUUM INTO a path containing quote/semicolon');
    }
    sqlite.exec(`VACUUM INTO '${target.replace(/\\/g, '/')}'`);
    const took = Date.now() - startedAt;
    let sizeMb = 0;
    try { sizeMb = fs.statSync(target).size / (1024 * 1024); } catch (_) {}
    console.log(`[backup] snapshot ok: ${target} (${sizeMb.toFixed(1)}MB in ${took}ms)`);
    rotateOld(backupDir);

    // Off-site copy (S3 / R2 / B2) — gated on BACKUP_S3_* env, no-op + zero
    // overhead when unconfigured. Fire-and-forget: a failed upload must never
    // break the local snapshot or the daily interval. See backupOffsite.js.
    try {
      const offsite = require('./backupOffsite');
      if (offsite.isConfigured()) {
        offsite.uploadBackup(target)
          .then(r => { if (r && !r.skipped) console.log(`[backup] off-site upload ok: ${r.key} (${(r.bytes / 1048576).toFixed(1)}MB)`); })
          .catch(err => console.error('[backup] off-site upload FAILED:', err.message));
      }
    } catch (offErr) {
      console.warn('[backup] off-site module load failed:', offErr.message);
    }
  } catch (err) {
    console.error('[backup] snapshot FAILED:', err.message);
  }
}

let _intervalHandle = null;
function startDailyBackups() {
  // Run once on boot (avoids waiting 24h after a fresh deploy for the
  // first snapshot). Then every 24h.
  runBackup();
  _intervalHandle = setInterval(runBackup, 24 * 60 * 60 * 1000);
  // Don't keep the event loop alive on quit — process exit can wait
  // for in-flight HTTP requests but shouldn't be held open by an idle
  // interval.
  if (_intervalHandle.unref) _intervalHandle.unref();

  // Off-site self-test at boot — verifies credentials + bucket reachability
  // with a tiny probe upload+readback, so a misconfiguration is loud in logs
  // now rather than discovered during a real disaster. No-op when off-site
  // backups are not configured.
  try {
    const offsite = require('./backupOffsite');
    if (offsite.isConfigured()) {
      offsite.selfTest()
        .then(r => { if (r && !r.skipped) console.log('[backup] off-site self-test PASSED — credentials + bucket reachable'); })
        .catch(err => console.error('[backup] off-site self-test FAILED — backups are NOT going off-site:', err.message));
    }
  } catch (e) {
    console.warn('[backup] off-site self-test load failed:', e.message);
  }
}

function stopDailyBackups() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}

module.exports = { startDailyBackups, stopDailyBackups, runBackup };
