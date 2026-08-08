#!/usr/bin/env node
/**
 * verify-release-feed — prove the auto-update feed actually serves, the way
 * a user's installed app sees it.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Between v4.0.11 and v4.0.16 every shipped build carried this in its own
 * resources/app-update.yml:
 *
 *     owner: madhavvan
 *     repo:  interviewcopilot-releases   ← a repo that was never created
 *     provider: github
 *     releaseType: draft                 ← invisible even if it had been
 *
 * electron-updater's very first request is
 * `github.com/<owner>/<repo>/releases.atom`. That 404'd, so the update check
 * threw before it ever compared a version number, and the ENTIRE installed
 * fleet silently stopped receiving updates on 2026-07-18. Cutting new tags on
 * the source repo did nothing — no client was ever looking there. Nothing in
 * the build, the tests, or CI noticed, because every one of them was green:
 * the artifacts built, signed, uploaded and installed perfectly. The only
 * broken thing was a URL nobody ever fetched.
 *
 * So this script fetches it. ANONYMOUSLY — no token, exactly like a user's
 * app — and walks the same four steps electron-updater walks:
 *
 *   1. GET /<owner>/<repo>/releases.atom            → must be 200, >=1 entry
 *   2. GET /<owner>/<repo>/releases/latest (json)   → must yield a tag_name
 *   3. GET /releases/download/<tag>/<channel>.yml   → must be 200 and parse
 *   4. GET each file named inside that yml          → must be fetchable
 *
 * A green run means a shipped app WILL see this release. A red run means it
 * will not, whatever the release page looks like in a browser.
 *
 * Usage:
 *   node scripts/verify-release-feed.mjs              # every publish target
 *   node scripts/verify-release-feed.mjs --tag v4.0.17
 *   node scripts/verify-release-feed.mjs --primary    # only the baked feed
 *   node scripts/verify-release-feed.mjs --quick      # skip per-asset checks
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name) => argv.includes(`--${name}`);
const val = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const WANT_TAG = val('tag');
const PRIMARY_ONLY = opt('primary');
const QUICK = opt('quick');
// ── Retry, for use as a CI gate ──
// Run straight after an upload this is a race, not a verdict: GitHub does
// not publish a release's assets to the anonymous CDN the instant the API
// call returns, so a single immediate check can report a feed as broken
// that is merely seconds young. Without retries a release gate either
// flakes red or gets switched off — and a gate that gets switched off is
// how the 4.0.11–4.0.16 fleet ended up stranded in the first place.
// Interactive runs keep the old single-shot behaviour.
const RETRIES = Number(val('retries') || 0);
const RETRY_WAIT_S = Number(val('retry-wait') || 20);

// The channel file each platform's updater asks for. electron-updater derives
// these from process.platform; we check all three because a release is only
// done when every platform can see it — the 2026-07 v4.0.12 incident lost
// latest-linux.yml alone and Linux went dark while Windows looked fine.
const CHANNELS = [
  { file: 'latest.yml', platform: 'Windows' },
  { file: 'latest-mac.yml', platform: 'macOS' },
  { file: 'latest-linux.yml', platform: 'Linux' },
];

const problems = [];
const notes = [];
const fail = (msg) => { problems.push(msg); console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);
const note = (msg) => { notes.push(msg); console.log(`  · ${msg}`); };

/** Anonymous fetch — no Authorization header, ever. This must mirror what an
 *  installed app can reach, and an installed app has no credentials. Passing a
 *  token here would make a private or deleted repo look healthy. */
async function anon(url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'electron-updater', ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    return { status: res.status, res };
  } catch (err) {
    return { status: 0, error: err.message };
  }
}

/**
 * Minimal parser for electron-builder channel files. Deliberately dependency-
 * free: js-yaml is only a TRANSITIVE dep of electron-builder here, and a check
 * that blocks a release must not break because someone pruned devDependencies.
 * The format is machine-generated and stable — we only need `version` and the
 * `url` of each entry under `files:`.
 */
function parseChannelYml(text) {
  const version = (/^version:\s*(.+)$/m.exec(text) || [])[1]?.trim().replace(/^['"]|['"]$/g, '');
  const files = [];
  let inFiles = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^files:\s*$/.test(raw)) { inFiles = true; continue; }
    // Any non-indented key ends the files block (path:, sha512:, releaseDate:)
    if (inFiles && /^\S/.test(raw)) inFiles = false;
    if (!inFiles) continue;
    const m = /^\s*-?\s*url:\s*(.+)$/.exec(raw);
    if (m) files.push(m[1].trim().replace(/^['"]|['"]$/g, ''));
  }
  return { version, files: [...new Set(files)] };
}

async function checkTarget(target, label) {
  const { owner, repo, releaseType } = target;
  const base = `https://github.com/${owner}/${repo}`;
  console.log(`\n━━━ ${label}: ${owner}/${repo} ━━━`);

  // ── Config invariants (cheap, and they caught the real bug) ──
  if (target.provider !== 'github') {
    note(`provider is "${target.provider}" — this script only walks the github provider`);
    return;
  }
  if (releaseType && releaseType !== 'release') {
    fail(`releaseType is "${releaseType}" — drafts and prereleases appear in NEITHER releases.atom NOR /releases/latest, so this feed is dead to the default update channel. Use "release".`);
  } else {
    ok('releaseType is "release"');
  }

  // ── Step 1: the atom feed. This is the exact request that 404'd. ──
  const atom = await anon(`${base}/releases.atom`, {
    accept: 'application/xml, application/atom+xml, text/xml, */*',
  });
  if (atom.status !== 200) {
    fail(`releases.atom → ${atom.status || atom.error}. electron-updater fails HERE, before it reads any version. No installed client pointed at this repo can ever see a release.`);
    return; // everything downstream is meaningless
  }
  const atomText = await atom.res.text();
  const entries = (atomText.match(/<entry>/g) || []).length;
  if (entries === 0) {
    fail('releases.atom is 200 but contains zero <entry> elements — the updater throws "No published versions on GitHub". A repo with only DRAFT releases looks exactly like this.');
    return;
  }
  ok(`releases.atom → 200, ${entries} published release${entries === 1 ? '' : 's'}`);

  // ── Step 2: resolve the tag the updater would pick ──
  let tag = WANT_TAG;
  if (!tag) {
    const latest = await anon(`${base}/releases/latest`, { Accept: 'application/json' });
    if (latest.status !== 200) {
      fail(`/releases/latest → ${latest.status || latest.error}`);
      return;
    }
    try {
      tag = JSON.parse(await latest.res.text()).tag_name;
    } catch {
      fail('/releases/latest did not return JSON with a tag_name');
      return;
    }
  }
  if (!tag) { fail('could not resolve a release tag'); return; }
  ok(`latest tag → ${tag}`);

  // Drift check against what this working tree would build.
  const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const tagVersion = String(tag).replace(/^v/, '');
  if (tagVersion !== pkgVersion) {
    note(`feed serves ${tagVersion}, package.json is ${pkgVersion} — expected mid-release, but if this persists AFTER publishing, the upload did not land`);
  } else {
    ok(`feed version matches package.json (${pkgVersion})`);
  }

  // ── Steps 3 + 4: every platform's channel file, and its assets ──
  for (const { file, platform } of CHANNELS) {
    const url = `${base}/releases/download/${tag}/${file}`;
    const r = await anon(url);
    if (r.status !== 200) {
      fail(`${platform}: ${file} → ${r.status || r.error}. That platform's updater throws ERR_UPDATER_CHANNEL_FILE_NOT_FOUND and those users get nothing.`);
      continue;
    }
    const { version, files } = parseChannelYml(await r.res.text());
    if (version !== tagVersion) {
      fail(`${platform}: ${file} declares version ${version} but the tag is ${tag}. A mismatch here makes clients download, install, relaunch on the old version, and check again — the update loop.`);
      continue;
    }
    if (!files.length) {
      fail(`${platform}: ${file} lists no files`);
      continue;
    }
    if (QUICK) { ok(`${platform}: ${file} → 200, v${version}, ${files.length} asset(s) [--quick: not fetched]`); continue; }

    // Ranged GET rather than HEAD: GitHub's release-download redirect chain
    // is not reliably HEAD-able, and a 1-byte range proves the bytes are
    // really there without pulling 150-200MB per asset.
    let bad = 0;
    for (const f of files) {
      const a = await anon(`${base}/releases/download/${tag}/${f}`, { Range: 'bytes=0-0' });
      if (a.status !== 206 && a.status !== 200) { fail(`${platform}: asset ${f} → ${a.status || a.error}`); bad++; }
    }
    if (!bad) ok(`${platform}: ${file} → 200, v${version}, all ${files.length} asset(s) fetchable`);
  }
}

// ── main ──
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const publish = pkg.build?.publish;
const targets = Array.isArray(publish) ? publish : publish ? [publish] : [];

if (!targets.length) {
  console.error('package.json has no build.publish — nothing to verify.');
  process.exit(1);
}

console.log('Verifying the update feed ANONYMOUSLY, as a shipped app sees it.');
console.log(`Tag: ${WANT_TAG || '(latest)'}${QUICK ? '  [--quick]' : ''}${RETRIES ? `  [up to ${RETRIES} retr${RETRIES === 1 ? 'y' : 'ies'}, ${RETRY_WAIT_S}s apart]` : ''}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The FIRST publish entry is what electron-builder writes into every
// artifact's app-update.yml — it is the only feed shipped clients read.
// Later entries are mirrors for older fleets and are checked, but a failure
// on entry #1 is what strands users.
//
// Retried as a whole rather than per-request: propagation is per-release,
// so if one asset is not visible yet the others are worth re-checking too,
// and a clean re-run is what we actually want to assert.
for (let attempt = 0; ; attempt++) {
  problems.length = 0;
  notes.length = 0;
  for (const [i, t] of targets.entries()) {
    if (PRIMARY_ONLY && i > 0) break;
    await checkTarget(t, i === 0 ? 'PRIMARY (baked into app-update.yml)' : `mirror #${i}`);
  }
  if (!problems.length || attempt >= RETRIES) break;
  console.log(`\n  … ${problems.length} problem(s) — GitHub may still be propagating this release.`);
  console.log(`  … retry ${attempt + 1}/${RETRIES} in ${RETRY_WAIT_S}s\n`);
  await sleep(RETRY_WAIT_S * 1000);
}

// ── Cross-check the built artifact, when there is one ──
const builtYml = join(ROOT, 'dist-electron', 'win-unpacked', 'resources', 'app-update.yml');
if (existsSync(builtYml)) {
  console.log('\n━━━ built artifact ━━━');
  const text = readFileSync(builtYml, 'utf8');
  const got = {
    owner: (/^owner:\s*(.+)$/m.exec(text) || [])[1]?.trim(),
    repo: (/^repo:\s*(.+)$/m.exec(text) || [])[1]?.trim(),
    releaseType: (/^releaseType:\s*(.+)$/m.exec(text) || [])[1]?.trim(),
  };
  const want = targets[0];
  if (got.owner === want.owner && got.repo === want.repo) {
    ok(`dist-electron app-update.yml points at ${got.owner}/${got.repo}`);
  } else {
    fail(`dist-electron app-update.yml points at ${got.owner}/${got.repo} but publish[0] is ${want.owner}/${want.repo} — this build is STALE. Rebuild before publishing.`);
  }
  if (got.releaseType && got.releaseType !== 'release') {
    fail(`dist-electron app-update.yml carries releaseType: ${got.releaseType}`);
  }
} else {
  note('no dist-electron build present to cross-check (fine before a build)');
}

console.log('\n' + '─'.repeat(66));
if (problems.length) {
  console.log(`FAIL — ${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
  problems.forEach((p) => console.log(`  • ${p}`));
  console.log('\nDo not ship. A green build with a red feed reaches nobody.');
  process.exit(1);
}
console.log('PASS — a shipped app pointed at the primary feed will see this release.');
if (notes.length) notes.forEach((n) => console.log(`  (note) ${n}`));
