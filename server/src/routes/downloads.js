// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DOWNLOADS — public 302 redirects to the GitHub release CDN
//
//  Lives behind get.minicaai.com (and is also reachable via the API
//  subdomain, harmless). Each route 302-redirects to the right binary
//  on the GitHub releases CDN. We redirect rather than proxy because
//  GitHub already serves these with proper CDN edges; proxying through
//  Railway would add bandwidth cost on every download and slow the
//  user's first connection.
//
//  ── WHICH REPO SERVES THE BINARIES ──
//  4.0.10 pointed this at `madhavvan/interviewcopilot-releases`, a public
//  releases-only repo meant to let the source repo go private. That repo
//  was never actually created: from 2026-07-18 until 2026-08-06 every one
//  of these redirects 302'd into a GitHub 404 and NOBODY COULD DOWNLOAD
//  THE APP. Pointed back at h2so4, which is public and carries the real
//  releases (v4.0.16 has all four artifacts below).
//
//  This constant is NOT the only copy — `GITHUB_RELEASES_URL` in
//  server/src/index.js reads the same repo for /license/version, and
//  package.json → build.publish decides which repo gets baked into each
//  build's app-update.yml. Changing the release repo means changing all
//  THREE, and the third one only takes effect for future installs.
//
//  ── AS OF 2026-08-07: RELEASES GO TO BOTH REPOS ──
//  build.publish now lists TWO targets, and every release is published to
//  both:
//    [0] madhavvan/interviewcopilot-releases — baked into app-update.yml,
//        so it is the feed every NEW build phones home to. It is also the
//        feed the stranded v4.0.11-v4.0.16 fleet already points at, which
//        is why creating it (rather than repointing them, which is
//        impossible — the URL is baked into their installed resources) is
//        what brings them back.
//    [1] madhavvan/h2so4 — the legacy feed still read by <=v4.0.9 installs.
//
//  Because BOTH receive every artifact, this constant is correct pointing
//  at either one. It stays on h2so4 until the releases repo has a release
//  carrying all four artifacts below; repointing it before that would
//  re-break downloads, which is the exact failure this file's header
//  documents above. Flip it (and GITHUB_RELEASES_URL) as the LAST step of
//  making h2so4 private — at that moment h2so4 stops being publicly
//  fetchable and this must already point elsewhere.
//
//  `npm run release:verify` walks the real anonymous HTTP steps against
//  both targets and fails if either cannot serve.
//
//  Routes are explicit (one handler per platform) instead of /:platform
//  with a lookup table — this keeps the router from swallowing every
//  unmatched root path, which would shadow the 404 handler in index.js.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const express = require('express');
const router = express.Router();

const REPO = 'madhavvan/h2so4';

// Artifact filenames must match the patterns in package.json's
// build.{win,mac,linux}.artifactName — keep them in sync.
//
// Mac ships as PER-ARCH DMGs (InterviewCopilot-Mac-${arch}.dmg) since
// commit 7353088 retired the Universal build. v4.0.9 was the first
// release without InterviewCopilot-Mac.dmg, and this file still
// redirected /mac to that name — every Mac download 404'd on GitHub,
// which shows logged-out users a sign-in page (the 2026-07-14 incident).
//
// /mac can NOT auto-pick the right arch: Safari's UA reports Intel even
// on Apple Silicon, so UA sniffing is useless for arm64-vs-x64. /mac
// therefore serves a two-button picker; /mac-arm64 and /mac-x64 redirect
// straight to their DMGs for links that already know the arch.
const FILES = {
  'windows':    'InterviewCopilot-Setup.exe',
  'mac-x64':    'InterviewCopilot-Mac-x64.dmg',
  'mac-arm64':  'InterviewCopilot-Mac-arm64.dmg',
  'linux':      'InterviewCopilot-Linux.AppImage',
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE BROWSER MUST NEVER REACH github.com.
//
//  This used to 302 straight to
//  `github.com/<owner>/<repo>/releases/latest/download/<file>` and let the
//  browser follow GitHub's own redirects. Two problems, and the second is
//  the one that actually bit:
//
//   1. The hop is VISIBLE. `github.com/<owner>/<repo>` sits in the address
//      bar on the way past, so the download quietly tells every user which
//      host and which repository the product is built out of.
//   2. WHEN IT BREAKS, GITHUB RENDERS THE ERROR. From 2026-07-18 the feed
//      pointed at a repo that did not exist, so every download landed on
//      GitHub's 404 — GitHub's branding, GitHub's chrome, and the missing
//      repo path printed on it. The outage leaked the thing the redirect
//      was already leaking, only louder and to everyone who clicked.
//
//  So the hops are followed HERE instead. GitHub's last redirect points at
//  release-assets.githubusercontent.com with a signed, opaque asset id —
//  no owner, no repo name anywhere in it — and that is what the browser is
//  sent to. If any of it fails, the user gets OUR page (see
//  unavailablePage) and never GitHub's.
//
//  This is still a REDIRECT, not a proxy: the 150-195MB never crosses this
//  server, so the original bandwidth rationale holds. The only cost is one
//  small HEAD-ish request per click, cached below.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Signed asset URLs last about an hour; five minutes is well inside that
// and keeps a burst of downloads from re-resolving on every click.
const ASSET_TTL_MS = 5 * 60 * 1000;
const assetCache = new Map();   // file -> { url, at }

/**
 * Follow GitHub's redirect chain until it leaves github.com, and return the
 * signed CDN URL. Returns '' when the asset cannot be resolved for any
 * reason — a missing release, a renamed file, GitHub being down, a network
 * timeout. Never throws: the caller's job is to show a human a page, not to
 * handle an exception on a download click.
 */
/**
 * Walk GitHub's redirects from `startUrl` until we leave github.com, and
 * return the signed CDN URL. '' on anything that is not a live asset.
 */
async function followToCdn(startUrl) {
  let url = startUrl;
  // Four hops is generous — GitHub uses two — and bounds a redirect loop.
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'minicaai-downloads', Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(6000),
    });
    // Left github.com, or arrived at the bytes: this is the URL to hand out.
    if (res.status === 200 || res.status === 206) return url;
    if (res.status < 300 || res.status >= 400) return '';   // 404 and friends
    const next = res.headers.get('location');
    if (!next) return '';
    url = new URL(next, url).toString();
    // The moment the host is no longer GitHub's own site, we have the
    // signed asset URL — hand it over without spending another request.
    if (!/(^|\.)github\.com$/i.test(new URL(url).hostname)) return url;
  }
  return '';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  "LATEST" IS NOT A PROMISE THAT THE FILE IS THERE.
//
//  On 2026-08-09 the v4.0.22 release was created before its Windows
//  installer existed. GitHub makes a release `latest` the moment it is
//  published, assets or not — so for two hours every Windows visitor got
//  the unavailable page below while a perfectly good 4.0.21 installer sat
//  one release back.
//
//  The ordering mistake that caused it is worth fixing separately (and is),
//  but it is not the only way to arrive here: a failed CI job, an asset
//  deleted by hand, an upload still in flight, or a release published in
//  pieces all produce the same shape — newest release, missing file.
//
//  So this no longer treats the newest release as the only answer. It falls
//  back to the most recent PUBLISHED release that actually carries the file.
//  Serving a user last week's installer is a non-event — the in-app updater
//  brings them current on first launch. Serving them an error page is the
//  thing they remember.
//
//  Bounded on purpose: ten releases back, one extra API call, and only ever
//  on the path that was already about to fail.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const FALLBACK_SCAN_RELEASES = 10;

async function resolveFromRecentReleases(file) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/releases?per_page=${FALLBACK_SCAN_RELEASES}`,
    {
      headers: { 'User-Agent': 'minicaai-downloads', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(6000),
    },
  );
  if (!res.ok) return { url: '', tag: '' };
  const releases = await res.json();
  if (!Array.isArray(releases)) return { url: '', tag: '' };
  for (const rel of releases) {
    // Drafts are invisible to users and prereleases are deliberately not
    // "latest" — neither is a thing to hand a stranger who clicked Download.
    if (rel.draft || rel.prerelease) continue;
    const asset = (rel.assets || []).find(a => a.name === file);
    if (!asset || !asset.browser_download_url) continue;
    const url = await followToCdn(asset.browser_download_url);
    if (url) return { url, tag: rel.tag_name || '' };
  }
  return { url: '', tag: '' };
}

async function resolveAssetUrl(file) {
  const cached = assetCache.get(file);
  if (cached && Date.now() - cached.at < ASSET_TTL_MS) return cached.url;

  try {
    const url = await followToCdn(`https://github.com/${REPO}/releases/latest/download/${file}`);
    if (url) {
      assetCache.set(file, { url, at: Date.now() });
      return url;
    }
  } catch { /* timeout, DNS, TLS — fall through to the scan */ }

  try {
    const { url, tag } = await resolveFromRecentReleases(file);
    if (url) {
      // LOUD: the newest release is incomplete and users are being served an
      // older build. Nothing is broken for them, but somebody has to know.
      console.error(
        `[downloads] ${file} is MISSING from the latest release — serving ${tag || 'an older release'} instead. ` +
        'Publish the missing asset, or the next release will inherit this.'
      );
      // Deliberately cached for the normal TTL: a five-minute window of an
      // older installer is better than an API call on every click while the
      // release is being repaired.
      assetCache.set(file, { url, at: Date.now() });
      return url;
    }
  } catch { /* fall through to our own page */ }

  return '';
}

/** Our own "not right now" page. Names no host, no repository, no vendor. */
function unavailablePage(platform) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Download — Interview Copilot</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#0a0a0d;color:#fff;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{max-width:460px;width:100%;text-align:center}
  h1{font-size:21px;margin:0 0 10px;font-weight:700}
  p{color:#9d968a;font-size:14px;line-height:1.6;margin:0 0 22px}
  a.btn{display:inline-block;padding:13px 22px;border-radius:12px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:#fff;text-decoration:none;font-weight:600;font-size:14px}
  .sub{margin-top:20px;font-size:12px;color:#6a6355}
  .sub a{color:#d3ac63;text-decoration:none}
</style></head><body><div class="card">
  <h1>That download isn't ready right now</h1>
  <p>The ${platform} build is briefly unavailable. This is on us, not on you — it usually clears within a few minutes.</p>
  <a class="btn" href="/">Try another platform</a>
  <p class="sub">Still stuck? <a href="mailto:support@minicaai.com">support@minicaai.com</a> — tell us which platform and we'll send you a link.</p>
</div></body></html>`;
}

const PLATFORM_LABEL = {
  'InterviewCopilot-Setup.exe': 'Windows',
  'InterviewCopilot-Mac-x64.dmg': 'Intel Mac',
  'InterviewCopilot-Mac-arm64.dmg': 'Apple Silicon',
  'InterviewCopilot-Linux.AppImage': 'Linux',
};

function redirectTo(file) {
  return async (_req, res) => {
    const url = await resolveAssetUrl(file);
    if (!url) {
      // 503, not 404: the app exists, this copy of it is momentarily out of
      // reach. And it is OUR page — a user must never be handed someone
      // else's error screen from a button on our site.
      console.warn(`[downloads] could not resolve ${file} — served the unavailable page instead`);
      return res.status(503).set('Content-Type', 'text/html; charset=utf-8')
        .send(unavailablePage(PLATFORM_LABEL[file] || 'requested'));
    }
    res.redirect(302, url);
  };
}

// Smart-default root — auto-detects platform from User-Agent and redirects
// to the right per-platform path. Used as a single URL we can hand back
// from the license/version-expired error responses without having to
// teach those endpoints about the user's platform. Falls back to a small
// HTML picker for mobile / unknown UAs (kindle, embedded browsers, curl)
// — those clients can still pick a download manually.
router.get('/', (req, res) => {
  const ua = req.get('User-Agent') || '';
  if (/Windows|Win64|WOW64/i.test(ua)) return res.redirect(302, '/windows');
  if (/Macintosh|Mac OS X/i.test(ua)) return res.redirect(302, '/mac');
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) return res.redirect(302, '/linux');
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Download Interview Copilot</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#0a0a0d;color:#fff;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{max-width:480px;width:100%;text-align:center}
  h1{font-size:22px;margin:0 0 8px;font-weight:700}
  p{color:#888;font-size:14px;margin:0 0 24px}
  .row{display:flex;flex-direction:column;gap:10px}
  a{display:block;padding:14px 20px;border-radius:12px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:#fff;text-decoration:none;font-weight:600;font-size:14px}
  a:hover{filter:brightness(1.1)}
  .guide{margin-top:26px;text-align:left;border:1px solid rgba(211,172,99,.28);background:linear-gradient(180deg,rgba(211,172,99,.06),rgba(255,255,255,.015));border-radius:14px;padding:14px 16px}
  .guide h2{font-size:13px;margin:0 0 6px;color:#fff}
  .guide p{font-size:11.5px;color:#9d968a;margin:0 0 10px;line-height:1.55}
  .guide ul{margin:0;padding:0;list-style:none;font-size:11.5px;color:#c9c2b4;line-height:1.6}
  .guide li{margin:0 0 7px}
  .k{display:inline-block;padding:1px 6px;border-radius:6px;background:rgba(211,172,99,.16);border:1px solid rgba(211,172,99,.3);color:#f0d78a;font-weight:700;font-size:10.5px;white-space:nowrap}
</style></head><body><div class="card">
  <h1>Download Interview Copilot</h1>
  <p>Pick the build for your operating system.</p>
  <div class="row">
    <a href="/windows">Windows · Setup.exe</a>
    <a href="/mac">macOS · DMG (Apple Silicon + Intel)</a>
    <a href="/linux">Linux · AppImage</a>
  </div>
  <div class="guide">
    <h2>Your browser may double-check the download — that's normal</h2>
    <p>The installer is code-signed (Azure Trusted Signing on Windows; Apple-notarized on macOS). Newer apps just get a one-time reputation prompt. Here's exactly what to click:</p>
    <ul>
      <li><strong style="color:#fff">Windows SmartScreen</strong> (blue "Windows protected your PC" screen): click <span class="k">More info</span>, then <span class="k">Run anyway</span>.</li>
      <li><strong style="color:#fff">Edge</strong> ("isn't commonly downloaded"): hover the download → click the <span class="k">⋯ three dots</span> → <span class="k">Keep</span> → <span class="k">Show more</span> → <span class="k">Keep anyway</span>.</li>
      <li><strong style="color:#fff">Chrome</strong>: open the downloads bubble → <span class="k">⋯</span> on the file → <span class="k">Keep</span> (then <span class="k">Keep anyway</span> if asked). Already dismissed it? Press <span class="k">Ctrl + J</span>, find the file, <span class="k">⋯</span> → Keep.</li>
      <li><strong style="color:#fff">Firefox</strong>: downloads arrow → right-click the file → <span class="k">Allow download</span>.</li>
      <li><strong style="color:#fff">macOS</strong>: notarized — just drag to Applications and click <span class="k">Open</span>.</li>
    </ul>
  </div>
</div></body></html>`);
});

// Mac arch picker — served at /mac because the UA can't tell us the arch.
// "Apple Silicon" first: every Mac sold since ~2021, i.e. most users.
router.get('/mac', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Download Interview Copilot for Mac</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#0a0a0d;color:#fff;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{max-width:480px;width:100%;text-align:center}
  h1{font-size:22px;margin:0 0 8px;font-weight:700}
  p{color:#888;font-size:14px;margin:0 0 24px}
  .row{display:flex;flex-direction:column;gap:10px}
  a{display:block;padding:14px 20px;border-radius:12px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:#fff;text-decoration:none;font-weight:600;font-size:14px}
  a:hover{filter:brightness(1.1)}
  .hint{color:#666;font-size:12px;margin-top:18px;line-height:1.5}
</style></head><body><div class="card">
  <h1>Download for Mac</h1>
  <p>Pick your Mac's chip. Not sure? Apple menu &#8594; About This Mac.</p>
  <div class="row">
    <a href="/mac-arm64">Apple Silicon &middot; M1 / M2 / M3 / M4</a>
    <a href="/mac-x64">Intel</a>
  </div>
  <p class="hint">Macs sold since 2021 are almost always Apple Silicon.<br>The Intel build also runs on Apple Silicon via Rosetta.</p>
  <p class="hint" style="border:1px solid rgba(211,172,99,.28);border-radius:12px;padding:10px 14px;background:rgba(211,172,99,.05);color:#9d968a">
    <strong style="color:#fff">Installing:</strong> open the DMG, drag Interview Copilot into <strong style="color:#f0d78a">Applications</strong>, then click <strong style="color:#f0d78a">Open</strong> on the standard "downloaded from the internet" note.
    The builds are Apple-notarized, so Gatekeeper opens them without warnings.
  </p>
</div></body></html>`);
});

router.get('/windows',    redirectTo(FILES['windows']));
router.get('/mac-x64',    redirectTo(FILES['mac-x64']));
router.get('/mac-arm64',  redirectTo(FILES['mac-arm64']));
router.get('/linux',      redirectTo(FILES['linux']));

module.exports = router;
