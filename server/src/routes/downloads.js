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
//  The repo name lives ONLY in this file — it's the codename we don't
//  want leaking into the user-facing React app or into any URL the user
//  might paste into a browser. If the repo is ever renamed, this is the
//  one constant to update.
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

function redirectTo(file) {
  return (_req, res) => {
    const url = `https://github.com/${REPO}/releases/latest/download/${file}`;
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
