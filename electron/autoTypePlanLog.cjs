// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  autoTypePlanLog.cjs — persistent per-run trace of every auto-type call
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
//  Why: previously the rich planner output (reasoning + ops with text +
//  before/after editor state) went to console.log only → wiped on every
//  Electron restart. "Show me what the planner thought" was unanswerable
//  the moment the app cycled. This file persists one line per run to a
//  JSONL file so "tail -1" answers it instantly, across restarts.
//
//  One write per run. Newest at bottom. Fields capped (huge editors can
//  produce 1MB+ snapshots — we trim each text field to MAX_FIELD_CHARS
//  before write). Rolling cap by line-count to bound disk usage.
//
//  Output location:
//    dev   — <project>/.autotype-plans.jsonl  (tail in terminal)
//    prod  — <userData>/autotype-plans.jsonl  (per-user data dir)
//
//  Reader contract (one JSON object per line, all fields optional):
//    {
//      ts:              ISO timestamp
//      runId:           crypto-random short id for cross-process correlation
//      language:        detected editor language (python/java/js/…)
//      plannerSource:   'vision' | 'sonnet-agent' | 'haiku' | 'uia' | 'multi-op-vision'
//      confidence:      0..1
//      reasoning:       planner's chain-of-thought string (trimmed)
//      beforeText:      UIA snapshot of editor BEFORE typing (trimmed)
//      intendedCode:    the CODE_TO_TYPE sent to the planner (trimmed)
//      operations:      array of {op,start_line,end_line,text,reason} (text trimmed per op)
//      executionTrace:  array of per-op {opIndex,kind,charsTyped,durationMs,notes}
//      afterText:       UIA snapshot AFTER typing finished (trimmed)
//      verify:          {ok, missingOps?, repairs?} from the verify pass
//      errors:          array of error messages caught during the run
//    }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FIELD_CHARS = 50_000;  // per text field (beforeText, afterText, intendedCode, op.text)
const MAX_LINES = 200;           // rolling cap — older runs evicted when exceeded

// State for a single in-flight run. The lifecycle is:
//   begin() → record() called several times → commit() (one JSONL line emitted)
// Begin/commit pairing is the caller's responsibility.
const _pending = new Map(); // runId -> {fields, startMs}

function _trim(s) {
  if (typeof s !== 'string') return s;
  if (s.length <= MAX_FIELD_CHARS) return s;
  return s.slice(0, MAX_FIELD_CHARS) + `\n…[truncated ${s.length - MAX_FIELD_CHARS} chars]`;
}

function _sanitizeOp(op) {
  if (!op || typeof op !== 'object') return op;
  return {
    op: op.op,
    start_line: op.start_line,
    end_line: op.end_line,
    text: typeof op.text === 'string' ? _trim(op.text) : op.text,
    reason: typeof op.reason === 'string' ? _trim(op.reason) : op.reason,
  };
}

function _resolveLogPath(app) {
  // Dev mode: write to project root so user can tail it easily.
  // Prod: write to userData so it doesn't pollute Program Files.
  // We detect dev by the presence of electron.app.isPackaged === false.
  const isPackaged = app && typeof app.isPackaged === 'boolean' ? app.isPackaged : true;
  if (!isPackaged) {
    // Walk up from __dirname (electron/) to project root
    return path.join(__dirname, '..', '.autotype-plans.jsonl');
  }
  try {
    const dir = app.getPath('userData');
    return path.join(dir, 'autotype-plans.jsonl');
  } catch {
    return path.join(__dirname, '..', '.autotype-plans.jsonl');
  }
}

function newRunId() {
  try { return crypto.randomBytes(6).toString('hex'); }
  catch { return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
}

function begin(runId) {
  _pending.set(runId, {
    fields: {
      ts: new Date().toISOString(),
      runId,
    },
    startMs: Date.now(),
  });
  return runId;
}

function record(runId, patch) {
  const entry = _pending.get(runId);
  if (!entry || !patch || typeof patch !== 'object') return;
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'beforeText' || k === 'afterText' || k === 'intendedCode' || k === 'reasoning') {
      entry.fields[k] = _trim(v);
    } else if (k === 'operations' && Array.isArray(v)) {
      entry.fields[k] = v.map(_sanitizeOp);
    } else {
      entry.fields[k] = v;
    }
  }
}

// _rotateIfNeeded keeps the JSONL file bounded to MAX_LINES rows. We
// re-read the whole file, drop the oldest excess lines, and rewrite —
// fine for MAX_LINES=200, would need a proper rolling-buffer impl if
// scaled to millions of runs.
function _rotateIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    // Cheap line-count proxy: if file is small enough not to bother, skip.
    if (stat.size < 200_000) return;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    const kept = lines.slice(lines.length - MAX_LINES);
    fs.writeFileSync(filePath, kept.join('\n') + '\n', 'utf8');
  } catch (err) {
    // Rotation failure is non-fatal — just keep appending.
    console.warn('[autotype-plan-log] rotate failed:', err && err.message);
  }
}

function commit(runId, appRef) {
  const entry = _pending.get(runId);
  if (!entry) return;
  _pending.delete(runId);
  entry.fields.totalDurationMs = Date.now() - entry.startMs;
  const filePath = _resolveLogPath(appRef);
  const line = JSON.stringify(entry.fields) + '\n';
  try {
    _rotateIfNeeded(filePath);
    fs.appendFileSync(filePath, line, 'utf8');
  } catch (err) {
    console.warn('[autotype-plan-log] write failed:', err && err.message);
  }
  return filePath;
}

// abandon() drops the in-flight record without writing. Used when the run
// short-circuits before we've gathered enough to be useful (e.g. local-only
// mode, no planner called, abort before plan accepted).
function abandon(runId) {
  _pending.delete(runId);
}

// saveScreenshot(runId, base64, mediaType, app) — persist the vision
// planner's screenshot to disk so we have the OTHER source of truth
// alongside the UIA text + plan. Without this, debugging "why did the
// planner choose those line numbers?" is half-blind: the planner sees
// a screenshot AND an editor text; we only logged the text. Returns the
// saved file path on success, null on failure (non-fatal — the run log
// still commits even if the screenshot save fails).
//
// Naming: <runId>.png so the screenshot correlates 1:1 with its JSONL
// entry. Location: <project>/.autotype-screenshots/ in dev, <userData>
// /autotype-screenshots/ in prod. Rolling cap = MAX_SCREENSHOTS (default
// 50) — older PNGs deleted on each save when over cap, to bound disk use.
const MAX_SCREENSHOTS = 50;

function _resolveScreenshotDir(app) {
  const isPackaged = app && typeof app.isPackaged === 'boolean' ? app.isPackaged : true;
  const base = !isPackaged
    ? path.join(__dirname, '..', '.autotype-screenshots')
    : (() => {
        try { return path.join(app.getPath('userData'), 'autotype-screenshots'); }
        catch { return path.join(__dirname, '..', '.autotype-screenshots'); }
      })();
  try { fs.mkdirSync(base, { recursive: true }); } catch (_) { /* exists or fails — saveScreenshot handles */ }
  return base;
}

function _rotateScreenshotsIfNeeded(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.png'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime); // oldest first
    if (files.length <= MAX_SCREENSHOTS) return;
    const toDelete = files.slice(0, files.length - MAX_SCREENSHOTS);
    for (const f of toDelete) {
      try { fs.unlinkSync(path.join(dir, f.name)); } catch (_) {}
    }
  } catch (_) { /* rotation is best-effort */ }
}

function saveScreenshot(runId, base64, mediaType, app) {
  if (!runId || !base64 || typeof base64 !== 'string') return null;
  try {
    const dir = _resolveScreenshotDir(app);
    const ext = (mediaType && mediaType.includes('jpeg')) ? 'jpg' : 'png';
    const filePath = path.join(dir, `${runId}.${ext}`);
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    _rotateScreenshotsIfNeeded(dir);
    return filePath;
  } catch (err) {
    console.warn('[autotype-plan-log] saveScreenshot failed:', err && err.message);
    return null;
  }
}

module.exports = { begin, record, commit, abandon, newRunId, saveScreenshot };
