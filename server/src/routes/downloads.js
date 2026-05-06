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
// build.{win,mac,linux}.artifactName — keep them in sync. Mac builds two
// variants because Apple Silicon (arm64) and Intel (x64) need different
// binaries; /mac defaults to x64 because Rosetta runs x64 on Apple
// Silicon (slightly slower but always works), while arm64 won't run at
// all on Intel Macs. Apple Silicon users who want native performance
// can hit /mac-arm64 directly.
const FILES = {
  'windows':    'InterviewCopilot-Setup.exe',
  'mac':        'InterviewCopilot-Mac-x64.dmg',
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
</style></head><body><div class="card">
  <h1>Download Interview Copilot</h1>
  <p>Pick the build for your operating system.</p>
  <div class="row">
    <a href="/windows">Windows · Setup.exe</a>
    <a href="/mac">macOS · DMG (Universal via Rosetta)</a>
    <a href="/mac-arm64">macOS · DMG (Apple Silicon native)</a>
    <a href="/linux">Linux · AppImage</a>
  </div>
</div></body></html>`);
});

router.get('/windows',    redirectTo(FILES['windows']));
router.get('/mac',        redirectTo(FILES['mac']));
router.get('/mac-x64',    redirectTo(FILES['mac-x64']));
router.get('/mac-arm64',  redirectTo(FILES['mac-arm64']));
router.get('/linux',      redirectTo(FILES['linux']));

module.exports = router;
