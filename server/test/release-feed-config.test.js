// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE UPDATE FEED MUST NAME A REPO THAT ACTUALLY RECEIVES RELEASES.
//
//  What happened: v4.0.11 through v4.0.16 each shipped with this baked
//  into their own resources/app-update.yml —
//
//      owner: madhavvan
//      repo:  interviewcopilot-releases
//      provider: github
//      releaseType: draft
//
//  — because build.publish listed that repo FIRST, and electron-builder
//  bakes entry [0] into every artifact. The repo had never been created.
//  electron-updater's first request is `/<owner>/<repo>/releases.atom`,
//  which 404'd, so the update check threw before it compared a single
//  version number. From 2026-07-18 the entire installed fleet silently
//  stopped receiving updates, and every release cut on the source repo
//  reached nobody. Worse, it self-propagated: a healthy <=v4.0.9 client
//  would update once to v4.0.16 and become stranded too.
//
//  Nothing caught it. The build was green, the artifacts signed, the
//  release page looked perfect, the installer worked. The only broken
//  thing was a URL that no test and no human ever fetched.
//
//  These tests are the cheap, offline half of the guard — they pin the
//  CONFIG so the three copies of "which repo" cannot drift apart again.
//  The other half is `npm run release:verify`, which fetches the feed
//  anonymously and is the only thing that can prove a repo exists.
//
//  Offline and deterministic — no network, no cost.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const downloadsSrc = readFileSync(join(ROOT, 'server', 'src', 'routes', 'downloads.js'), 'utf8');
const indexSrc = readFileSync(join(ROOT, 'server', 'src', 'index.js'), 'utf8');

const publish = Array.isArray(pkg.build.publish) ? pkg.build.publish : [pkg.build.publish];
const repoNames = publish.map((t) => `${t.owner}/${t.repo}`);

describe('build.publish — the feed baked into every shipped build', () => {
  it('has at least one target, and entry [0] is a complete github target', () => {
    expect(publish.length).toBeGreaterThan(0);
    const primary = publish[0];
    expect(primary.provider).toBe('github');
    expect(primary.owner).toBeTruthy();
    expect(primary.repo).toBeTruthy();
  });

  // The bug had TWO independent causes and fixing either alone still leaves
  // the fleet dark. This is the second one: a draft release appears in
  // neither releases.atom nor /releases/latest, so even once the repo exists,
  // publishing drafts into it produces a feed that looks populated in a
  // browser and is invisible to every updater on the default channel.
  it('publishes real releases, never drafts or prereleases', () => {
    for (const t of publish) {
      expect(
        t.releaseType === undefined || t.releaseType === 'release',
        `${t.owner}/${t.repo} has releaseType "${t.releaseType}" — drafts and prereleases are invisible to the updater's default channel`
      ).toBe(true);
    }
  });

  it('names no target twice', () => {
    expect(new Set(repoNames).size).toBe(repoNames.length);
  });
});

describe('the three copies of "which repo" agree', () => {
  // downloads.js REPO, index.js GITHUB_RELEASES_URL and build.publish are
  // three independent literals naming the same thing. They drifted once and
  // it cost three weeks of broken downloads. Neither server constant has to
  // equal publish[0] — every publish target receives every artifact, so any
  // of them serves — but a server constant naming a repo that is NOT a
  // publish target names a repo nothing uploads to.
  it('downloads.js REPO is a repo that releases are published to', () => {
    const m = /const REPO = '([^']+)'/.exec(downloadsSrc);
    expect(m, 'could not find `const REPO` in downloads.js').toBeTruthy();
    expect(repoNames, `downloads.js serves binaries from ${m[1]}, which no publish target writes to`).toContain(m[1]);
  });

  it('index.js GITHUB_RELEASES_URL is a repo that releases are published to', () => {
    const m = /GITHUB_RELEASES_URL = '([^']+)'/.exec(indexSrc);
    expect(m, 'could not find GITHUB_RELEASES_URL in index.js').toBeTruthy();
    const repo = /api\.github\.com\/repos\/([^/]+\/[^/]+)\//.exec(m[1]);
    expect(repo, `GITHUB_RELEASES_URL is not a /repos/<owner>/<repo>/ URL: ${m[1]}`).toBeTruthy();
    expect(repoNames, `index.js reads versions from ${repo[1]}, which no publish target writes to`).toContain(repo[1]);
  });
});

describe('download filenames match what electron-builder actually produces', () => {
  // v4.0.9 retired the Universal Mac build for per-arch DMGs but left the old
  // `InterviewCopilot-Mac.dmg` in this map. Every Mac download 302'd to a
  // GitHub 404 — which shows logged-out visitors a sign-in page. Same class
  // of bug as the feed outage: a filename literal that nothing verified.
  const artifactPatterns = [
    pkg.build.win?.artifactName,
    pkg.build.mac?.artifactName,
    pkg.build.linux?.artifactName,
  ].filter(Boolean);

  /** `InterviewCopilot-Mac-${arch}.${ext}` → /^InterviewCopilot-Mac-.+\..+$/ */
  const toRegExp = (pattern) =>
    new RegExp('^' + pattern.replace(/[.]/g, '\\.').replace(/\$\{\w+\}/g, '.+') + '$');

  const filesBlock = /const FILES = \{([\s\S]*?)\n\};/.exec(downloadsSrc);

  it('finds the FILES map', () => {
    expect(filesBlock, 'could not find `const FILES = {...}` in downloads.js').toBeTruthy();
  });

  it('every served filename matches an artifactName pattern', () => {
    const names = [...filesBlock[1].matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => ({ key: m[1], file: m[2] }));
    expect(names.length).toBeGreaterThan(0);
    const matchers = artifactPatterns.map(toRegExp);
    for (const { key, file } of names) {
      expect(
        matchers.some((re) => re.test(file)),
        `downloads.js serves "${file}" for /${key}, which matches none of the build artifactName patterns: ${artifactPatterns.join(', ')}`
      ).toBe(true);
    }
  });
});
