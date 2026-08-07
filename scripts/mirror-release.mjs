#!/usr/bin/env node
/**
 * mirror-release — copy a release's assets from the source repo to the
 * update-feed repo.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Windows is built and published from a workstation, so electron-builder's
 * multi-target publish puts it on both repos by itself. macOS and Linux are
 * built by GitHub Actions, and `secrets.GITHUB_TOKEN` is scoped to the repo
 * that fired the workflow — it physically cannot write to the feed repo. If
 * the RELEASES_REPO_TOKEN secret is not set on the source repo, CI's upload
 * lands only on the source release and latest-mac.yml / latest-linux.yml
 * never reach the feed every shipped app-update.yml points at. Mac and Linux
 * users then stay stranded while Windows looks perfectly healthy — which is
 * exactly the shape of the 2026-07 outage, just narrower.
 *
 * This script closes that gap from a workstation with no new secrets: it
 * reads the PAT out of Git Credential Manager (the `gh` CLI is not installed
 * on this machine) and streams each missing asset across.
 *
 * Safe to re-run: an asset already present on the target with a matching byte
 * size is skipped, so an interrupted mirror resumes rather than duplicating.
 *
 * Usage:
 *   node scripts/mirror-release.mjs v4.0.17
 *   node scripts/mirror-release.mjs v4.0.17 --dry-run
 */

import { spawnSync } from 'node:child_process';
import { createWriteStream, createReadStream, statSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const TAG = argv.find((a) => !a.startsWith('--'));
const DRY = argv.includes('--dry-run');

if (!TAG) {
  console.error('usage: node scripts/mirror-release.mjs <tag> [--dry-run]');
  process.exit(1);
}

// Source = last publish entry (the source repo), target = first (the baked
// feed). Read from package.json so this can never drift from what actually
// ships — the whole class of bug this guards against was a config drift.
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const targets = pkg.build.publish;
const FEED = targets[0];
const SOURCE = targets[targets.length - 1];

if (FEED.repo === SOURCE.repo) {
  console.log(`publish[0] and publish[last] are both ${FEED.owner}/${FEED.repo} — nothing to mirror.`);
  process.exit(0);
}

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const m = /^password=(.*)$/m.exec(r.stdout || '');
  if (!m) {
    console.error('Could not read a GitHub token from Git Credential Manager, and GH_TOKEN is unset.');
    process.exit(1);
  }
  return m[1].trim();
}
const TOKEN = token();

async function api(path, init = {}) {
  const res = await fetch(path.startsWith('http') ? path : `https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'minicaai-mirror-release',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

// ── Resolve the source release ──
const src = await api(`/repos/${SOURCE.owner}/${SOURCE.repo}/releases/tags/${TAG}`);
if (src.status !== 200) {
  console.error(`Source release ${SOURCE.owner}/${SOURCE.repo}@${TAG} → ${src.status}`);
  process.exit(1);
}
console.log(`source: ${SOURCE.owner}/${SOURCE.repo}@${TAG} — ${src.body.assets.length} asset(s)`);

// ── Resolve or create the target release ──
let dst = await api(`/repos/${FEED.owner}/${FEED.repo}/releases/tags/${TAG}`);
if (dst.status === 404) {
  if (DRY) {
    console.log(`[dry-run] would create ${FEED.owner}/${FEED.repo}@${TAG}`);
    process.exit(0);
  }
  // draft:false is not optional — a draft release is absent from both
  // releases.atom and /releases/latest, so mirroring into a draft produces a
  // feed that looks populated on the web and is invisible to every updater.
  const created = await api(`/repos/${FEED.owner}/${FEED.repo}/releases`, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: TAG,
      name: src.body.name || TAG,
      body: src.body.body || '',
      draft: false,
      prerelease: false,
    }),
  });
  if (created.status !== 201) {
    console.error(`Could not create target release → ${created.status}`, JSON.stringify(created.body).slice(0, 300));
    process.exit(1);
  }
  dst = { status: 200, body: created.body };
  console.log(`target: created ${FEED.owner}/${FEED.repo}@${TAG}`);
} else if (dst.status !== 200) {
  console.error(`Target release lookup → ${dst.status}`);
  process.exit(1);
} else {
  console.log(`target: ${FEED.owner}/${FEED.repo}@${TAG} — ${dst.body.assets.length} asset(s) already there`);
  if (dst.body.draft) {
    console.error('Target release is a DRAFT. Drafts are invisible to releases.atom and /releases/latest — publish it before mirroring, or the feed stays dead.');
    process.exit(1);
  }
}

const already = new Map(dst.body.assets.map((a) => [a.name, a.size]));

// builder-debug.yml is a build diagnostic, not something a client fetches.
const SKIP = new Set(['builder-debug.yml']);

const scratch = join(tmpdir(), 'minicaai-mirror');
if (!existsSync(scratch)) mkdirSync(scratch, { recursive: true });

let copied = 0, skipped = 0, failed = 0;

for (const asset of src.body.assets) {
  if (SKIP.has(asset.name)) { skipped++; continue; }
  if (already.get(asset.name) === asset.size) {
    console.log(`  = ${asset.name} (already present, ${asset.size} B)`);
    skipped++;
    continue;
  }
  if (already.has(asset.name)) {
    console.log(`  ! ${asset.name} present but ${already.get(asset.name)} B != source ${asset.size} B — re-uploading`);
    if (!DRY) {
      const existing = dst.body.assets.find((a) => a.name === asset.name);
      await api(`/repos/${FEED.owner}/${FEED.repo}/releases/assets/${existing.id}`, { method: 'DELETE' });
    }
  }
  if (DRY) { console.log(`  [dry-run] would copy ${asset.name} (${asset.size} B)`); copied++; continue; }

  const tmp = join(scratch, asset.name);
  try {
    // Download through the API's octet-stream accept so we get the bytes
    // rather than the JSON metadata.
    const dl = await fetch(asset.url, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/octet-stream',
        'User-Agent': 'minicaai-mirror-release',
      },
      redirect: 'follow',
    });
    if (!dl.ok) throw new Error(`download → ${dl.status}`);
    await pipeline(Readable.fromWeb(dl.body), createWriteStream(tmp));

    const size = statSync(tmp).size;
    if (size !== asset.size) throw new Error(`downloaded ${size} B, expected ${asset.size} B`);

    // Stream the upload straight off disk so peak memory stays flat rather
    // than holding a 200MB installer in a Buffer.
    const up = await fetch(
      `https://uploads.github.com/repos/${FEED.owner}/${FEED.repo}/releases/${dst.body.id}/assets?name=${encodeURIComponent(asset.name)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': asset.content_type || 'application/octet-stream',
          'Content-Length': String(size),
          'User-Agent': 'minicaai-mirror-release',
        },
        body: Readable.toWeb(createReadStream(tmp)),
        duplex: 'half',
      }
    );
    if (up.status !== 201) throw new Error(`upload → ${up.status} ${(await up.text()).slice(0, 200)}`);
    console.log(`  + ${asset.name} (${size} B)`);
    copied++;
  } catch (err) {
    console.log(`  ✗ ${asset.name}: ${err.message}`);
    failed++;
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

console.log(`\ncopied ${copied}, skipped ${skipped}, failed ${failed}`);
if (failed) {
  console.log('Re-run to retry — assets already copied are skipped by size.');
  process.exit(1);
}
console.log(`\nNow prove it serves:  node scripts/verify-release-feed.mjs --tag ${TAG}`);
