// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  NOTHING SECRET, AND NOTHING SCRATCH, MAY LEAVE IN THE ASAR.
//
//  On 2026-08-08 a Windows build made from the ordinary working tree
//  packed `server/.env` — JWT_SECRET, STRIPE_SECRET_KEY, the webhook
//  secret and every AI provider key — into app.asar. An asar is a plain
//  archive; `npx asar extract app.asar out/` is the whole attack. That
//  build was caught before publishing, but only because somebody looked.
//
//  The same build also carried 253 MB of `.phone-shots` (a full Chrome
//  profile, cookies included), 59 MB of `.signing`, and all of `server/`.
//  587 MB of asar for a 3 MB renderer.
//
//  WHY THIS IS A GUARD AND NOT A `files` PATTERN
//  ─────────────────────────────────────────────
//  It should have been a `files` pattern. It is not, because three
//  separate configurations were tried against this exact tree and the
//  asar came back byte-identical (587,816,278) every time:
//
//    ["dist/**/*", "electron/**/*"]                       -> 587,816,278
//    ["!**/*", "dist/**/*", "electron/**/*", …]           -> 380,935,988  (node_modules lost too)
//    the same plus "node_modules/**/*" and dot-excludes   -> 587,816,278
//
//  The negations do not reach dotfiles the way minimatch's documentation
//  implies, and the correct incantation was not found. Rather than ship a
//  release gated on a glob nobody has proven, the release build is made
//  from a CLEAN CLONE of the tag — where none of this exists to be packed
//  — and this guard is what makes a dirty-tree build impossible to ship
//  silently. If someone later fixes the `files` patterns, this stays: a
//  guard that never fires costs nothing, and it is the only thing standing
//  between a hurried `electron-builder` run and a published secret.
//
//  It THROWS. A failed build is the point — there is no safe way to
//  continue, and a warning in a 200-line build log is not a control.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const fs = require('fs');
const path = require('path');

// Keys whose VALUE is a credential. Matched against the key name in an env
// file, because the filename alone is not enough to judge: the repo's root
// `.env` holds only VITE_GOOGLE_CLIENT_ID — a public OAuth client id that is
// already compiled into the renderer bundle — while `server/.env` holds
// JWT_SECRET and STRIPE_SECRET_KEY. Blocking by filename would either ship
// the second or block the first, and the first is legitimately needed at
// build time for Google sign-in.
const SECRET_KEY_NAME = /(SECRET|_KEY$|_KEY_|APIKEY|API_KEY|PASSWORD|PASSWD|TOKEN|CREDENTIAL|PRIVATE)/i;
// CLIENT_ID is public by design in OAuth — it is in every redirect URL.
const PUBLIC_KEY_NAME = /(CLIENT_ID|PUBLIC|_URL$|^NODE_ENV$|^PORT$)/i;

/** Does this env file body actually carry a credential? */
function envCarriesSecret(body) {
  for (const line of String(body).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawVal] = m;
    const val = rawVal.trim().replace(/^["']|["']$/g, '');
    if (!val) continue;
    if (/^(changeme|your_|xxx+|<|placeholder|todo)/i.test(val)) continue;
    if (PUBLIC_KEY_NAME.test(key) && !SECRET_KEY_NAME.test(key)) continue;
    if (SECRET_KEY_NAME.test(key)) return key;
  }
  return null;
}

// Anything matching these must never be in a shipped asar. `server/` source
// itself is NOT here: it is public on GitHub and already shipped in v4.0.17
// and v4.0.18, so failing on it would block a release over dead weight rather
// than over a risk. It is reported as bloat instead (see BLOAT below).
const FORBIDDEN = [
  {
    label: 'env file carrying a live credential',
    test: (f) => /(^|\/)\.env(\.|$)/.test(f) && !/\.env\.example$/.test(f),
    // content-checked at audit time; see auditAsar
    contentCheck: envCarriesSecret,
  },
  { label: 'signing toolchain', test: (f) => f.startsWith('.signing/') },
  { label: 'browser profile / screenshots', test: (f) => f.startsWith('.phone-shots/') || f.startsWith('.autotype-screenshots/') },
  { label: 'test render output', test: (f) => f.startsWith('globe-parity-out/') },
  { label: 'log file', test: (f) => f.endsWith('.log') },
  { label: 'private docs', test: (f) => f.startsWith('docs/private/') },
  { label: 'database file (may contain user data)', test: (f) => /\.(db|sqlite3?)$/.test(f) },
  { label: 'key or certificate', test: (f) => /\.(pem|pfx|p12|key)$/.test(f) },
];

// Reported loudly, but does not fail the build.
const BLOAT = [
  { label: 'server source tree', test: (f) => f.startsWith('server/') },
  { label: 'build scripts', test: (f) => f.startsWith('scripts/') },
];

// The app is broken without these, so a guard that only removes things
// could hide a packaging mistake in the other direction.
const REQUIRED = [
  { label: 'renderer (dist/)', test: (f) => f.startsWith('dist/') },
  { label: 'main process (electron/)', test: (f) => f.startsWith('electron/') },
  { label: 'package.json', test: (f) => f === 'package.json' },
  { label: 'better-sqlite3', test: (f) => f.includes('better-sqlite3/') },
];

function loadAsar() {
  for (const m of ['@electron/asar', 'asar']) {
    try { return require(m); } catch {}
  }
  return null;
}

/** @param {string} asarPath */
function auditAsar(asarPath) {
  const asar = loadAsar();
  if (!asar) {
    throw new Error('[asar-guard] cannot load @electron/asar — refusing to ship an unaudited asar');
  }

  const files = asar
    .listPackage(asarPath, { isPack: false })
    .map((f) => f.replace(/^[\\/]/, '').split('\\').join('/'));

  const violations = new Map();
  for (const f of files) {
    for (const rule of FORBIDDEN) {
      if (!rule.test(f)) continue;
      let detail = f;
      if (rule.contentCheck) {
        // Only a credential-bearing env file is a violation. Reading it out
        // of the asar is the only way to tell — see SECRET_KEY_NAME.
        let body;
        try { body = asar.extractFile(asarPath, f).toString('utf8'); } catch { body = ''; }
        const offendingKey = rule.contentCheck(body);
        if (!offendingKey) continue;
        detail = `${f}   (carries ${offendingKey})`;
      }
      if (!violations.has(rule.label)) violations.set(rule.label, []);
      violations.get(rule.label).push(detail);
    }
  }

  const missing = REQUIRED.filter((r) => !files.some(r.test)).map((r) => r.label);

  console.log(`[asar-guard] ${files.length} entries in ${path.basename(asarPath)}`);

  // Bloat is reported, never fatal — it is waste, not risk.
  for (const rule of BLOAT) {
    const n = files.filter(rule.test).length;
    if (n) console.log(`[asar-guard] note: ${n} ${rule.label} entries are being shipped (dead weight, not a risk)`);
  }

  if (missing.length) {
    throw new Error(
      `[asar-guard] the asar is MISSING required content: ${missing.join(', ')}. ` +
        'The app would not run. Check build.files.'
    );
  }

  if (violations.size) {
    const lines = [];
    let total = 0;
    for (const [label, hits] of violations) {
      total += hits.length;
      lines.push(`  ${label} — ${hits.length} entr${hits.length === 1 ? 'y' : 'ies'}`);
      for (const h of hits.slice(0, 5)) lines.push(`      ${h}`);
      if (hits.length > 5) lines.push(`      … +${hits.length - 5} more`);
    }
    throw new Error(
      '\n[asar-guard] REFUSING TO BUILD — this asar contains content that must never ship.\n' +
        lines.join('\n') +
        `\n\n  ${total} forbidden entr${total === 1 ? 'y' : 'ies'} total.\n\n` +
        '  This is what a build from a dirty working tree looks like. An asar is a\n' +
        '  plain archive — anything in here is readable by anyone who downloads the\n' +
        '  installer.\n\n' +
        '  Build a release from a clean clone of the tag instead:\n' +
        '      git clone --branch <tag> --depth 1 <repo> /tmp/rel && cd /tmp/rel\n' +
        '      cp <path>/.env .env        # the PUBLIC client id only\n' +
        '      npm ci && npm run electron:publish\n'
    );
  }

  console.log('[asar-guard] clean — no secrets, no scratch, all required content present');
  return files.length;
}

/** afterPack hook: locate this platform's app.asar and audit it. */
async function guardAfterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const appName = packager.appInfo.productFilename;
  const asarPath =
    electronPlatformName === 'darwin'
      ? path.join(appOutDir, `${appName}.app`, 'Contents', 'Resources', 'app.asar')
      : path.join(appOutDir, 'resources', 'app.asar');

  if (!fs.existsSync(asarPath)) {
    // asar:false builds are a deliberate debugging mode, not a release.
    console.log('[asar-guard] no app.asar (asar disabled?) — skipping');
    return;
  }
  auditAsar(asarPath);
}

module.exports = { auditAsar, guardAfterPack, FORBIDDEN, REQUIRED };

// Allow `node scripts/asar-guard.cjs <path-to-app.asar>` for ad-hoc checks.
if (require.main === module) {
  const p = process.argv[2];
  if (!p) {
    console.error('usage: node scripts/asar-guard.cjs <path-to-app.asar>');
    process.exit(2);
  }
  try {
    auditAsar(p);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
