// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CUT THE RELEASE AS A DRAFT, BEFORE ANYTHING IS BUILT.
//
//  A published GitHub release is "latest" the instant it exists, assets or
//  not — and both routes/downloads.js and electron-updater follow "latest".
//  On 2026-08-09 v4.0.22 was published before its Windows installer had
//  been built, and for two hours every Windows visitor got the unavailable
//  page while a perfectly good 4.0.21 installer sat one release back.
//
//  Every release before it survived by accident: electron-builder CREATED
//  the release as part of the Windows publish, so the installer and the
//  release appeared in the same operation. v4.0.18 through v4.0.21 all show
//  Setup.exe landing within one second of published_at. Cutting the release
//  by hand decoupled those two things for the first time.
//
//  A draft is invisible to `releases/latest`, to releases.atom and to the
//  updater. So the window between "the release exists" and "the release is
//  installable" stops being a window users can fall into.
//
//  THE ORDER:
//    1. npm run release:draft -- v4.0.23
//    2. npm run electron:publish          (builds + signs Windows into it)
//    3. publish the draft                 (this is what triggers CI)
//    4. CI builds mac + linux, mirrors, verifies
//
//  ⚠️ NOT the same as publish[].releaseType: "draft" — that value is also
//  written into app-update.yml inside the shipped app, and a client
//  configured for drafts cannot see any release anonymously. It would break
//  auto-update for every user. This script changes only how the release is
//  CREATED; the shipped config stays "release".
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REPOS = ['madhavvan/h2so4', 'madhavvan/interviewcopilot-releases'];

const tag = process.argv[2];
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error('usage: npm run release:draft -- v4.0.23');
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (`v${pkg.version}` !== tag) {
  console.error(
    `refusing: package.json is ${pkg.version} but you asked for ${tag}.\n` +
    'Bump the version first — a release whose tag and package.json disagree is the\n' +
    'bug that left MIN_PROTOCOL_CLIENT above the shipped build.',
  );
  process.exit(1);
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

for (const repo of REPOS) {
  let existing = '';
  try {
    existing = gh(['release', 'view', tag, '--repo', repo, '--json', 'isDraft', '--jq', '.isDraft']);
  } catch { /* no such release — the normal case */ }

  if (existing === 'true') {
    console.log(`· ${repo}: draft ${tag} already exists — leaving it alone`);
    continue;
  }
  if (existing === 'false') {
    console.error(
      `✗ ${repo}: ${tag} is ALREADY PUBLISHED. It is GitHub's "latest" right now.\n` +
      '  If it has no installer attached, demote it before doing anything else:\n' +
      `      gh release edit ${tag} --repo ${repo} --prerelease`,
    );
    process.exit(1);
  }

  gh(['release', 'create', tag, '--repo', repo, '--draft', '--title', tag.replace(/^v/, ''),
      '--notes', 'Draft — notes are written before publishing.']);
  console.log(`✓ ${repo}: draft ${tag} created (invisible to users)`);
}

console.log(
  '\nNext:\n' +
  '  npm run electron:publish     # builds + signs Windows into these drafts\n' +
  `  gh release edit ${tag} --repo madhavvan/h2so4 --draft=false --latest\n` +
  `  gh release edit ${tag} --repo madhavvan/interviewcopilot-releases --draft=false --latest\n` +
  '  # publishing is what fires CI for mac + linux',
);
