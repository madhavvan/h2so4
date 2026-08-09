// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  A DOWNLOAD MUST NEVER HAND THE USER TO github.com.
//
//  What happened: from 2026-07-18 the download routes 302'd to
//  `github.com/<owner>/<repo>/releases/latest/download/<file>` for a repo
//  that had never been created. Every person who clicked Download — on
//  Windows, Mac and Linux — landed on GitHub's own 404 page, which carries
//  GitHub's branding and prints the owner/repo path it could not find.
//
//  So the outage did two things at once: nobody could install the product,
//  and the failure told every visitor which host and which repository it
//  is built out of. The second is the one that survives a fix — a working
//  redirect leaked the same path, just more quietly.
//
//  The rule these tests enforce:
//    1. the browser is never sent to a github.com host — the redirect
//       target is the signed asset CDN, whose URL contains no owner and no
//       repo name;
//    2. when anything fails, WE render the page. A user must never be
//       handed someone else's error screen from a button on our site.
//
//  All stubbed — no network, no cost, deterministic.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const PATHS = ['/windows', '/mac-x64', '/mac-arm64', '/linux'];
const realFetch = globalThis.fetch;

/** Boot the router with a stubbed global fetch, hit `path`, tear down. */
async function hit(path, fetchStub) {
  vi.resetModules();                       // drop the module-level asset cache
  globalThis.fetch = fetchStub;
  const express = require('express');
  // eslint-disable-next-line global-require
  delete require.cache[require.resolve('../src/routes/downloads.js')];
  const router = require('../src/routes/downloads.js');
  const app = express();
  app.use(router);
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  const res = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}${path}`, (r) => {
      let body = '';
      r.on('data', (c) => { body += c; });
      r.on('end', () => resolve({ status: r.statusCode, location: r.headers.location || '', body }));
    });
  });
  srv.close();
  return res;
}

/** GitHub's real shape: two redirects, then the signed asset host. */
const healthyGitHub = () => async (url) => {
  const u = String(url);
  if (u.includes('/releases/latest/download/')) {
    return new Response(null, { status: 302, headers: { location: u.replace('/latest/download/', '/download/v4.0.16/') } });
  }
  if (u.includes('github.com')) {
    return new Response(null, {
      status: 302,
      headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/1135233886/b3b1f510?sig=abc&jwt=xyz' },
    });
  }
  return new Response('', { status: 206 });
};

afterEach(() => { globalThis.fetch = realFetch; });

describe('the browser is never sent to github.com', () => {
  for (const path of PATHS) {
    it(`${path} redirects to the signed asset host, not github`, async () => {
      const res = await hit(path, healthyGitHub());
      expect(res.status).toBe(302);
      const host = new URL(res.location).hostname;
      expect(host, `${path} redirected to ${host}`).not.toMatch(/(^|\.)github\.com$/i);
      expect(res.location).not.toMatch(/madhavvan|h2so4/i);
    });
  }
});

describe('when it breaks, WE render the page', () => {
  const FAILURES = {
    'the release or asset is missing (the 2026-07-18 outage)': () => async () => new Response('Not Found', { status: 404 }),
    'the network is down': () => async () => { throw new Error('getaddrinfo ENOTFOUND github.com'); },
    'the request times out': () => async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; },
    'a redirect arrives with no location': () => async () => new Response(null, { status: 302 }),
  };

  for (const [label, stub] of Object.entries(FAILURES)) {
    it(`${label} → our own page, not GitHub's`, async () => {
      const res = await hit('/windows', stub());
      // 503, not 404: the app exists, this copy is momentarily out of reach.
      expect(res.status).toBe(503);
      expect(res.location, 'must not bounce the user anywhere').toBe('');
      expect(res.body).toContain('Interview Copilot');
      expect(res.body).toMatch(/isn't ready right now/i);
      // The whole point: no host, no repo, no vendor on the error page.
      expect(res.body, 'error page leaks github').not.toMatch(/github/i);
      expect(res.body, 'error page leaks the repo name').not.toMatch(/madhavvan|h2so4/i);
      // …and it still gives the user somewhere to go.
      expect(res.body).toMatch(/support@minicaai\.com/);
    });
  }

  it('a redirect loop terminates instead of hanging the click', async () => {
    const loop = async (url) => new Response(null, { status: 302, headers: { location: String(url) } });
    const res = await hit('/linux', loop);
    expect(res.status).toBe(503);
    expect(res.body).not.toMatch(/github/i);
  });
});

describe('the picker pages name no vendor either', () => {
  for (const path of ['/', '/mac']) {
    it(`${path} mentions neither github nor the repo`, async () => {
      const res = await hit(path, healthyGitHub());
      // These are HTML pickers (or a UA redirect), never a github hop.
      if (res.status === 302) {
        expect(new URL(res.location, 'http://x').hostname).not.toMatch(/github/i);
      } else {
        expect(res.body).not.toMatch(/github/i);
        expect(res.body).not.toMatch(/madhavvan|h2so4/i);
      }
    });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  "LATEST" IS NOT A PROMISE THAT THE FILE IS THERE.
//
//  2026-08-09: v4.0.22 was published before its Windows installer existed.
//  GitHub makes a release `latest` the instant it is published, assets or
//  not — so for two hours every Windows visitor got the unavailable page
//  while a perfectly good 4.0.21 installer sat one release back.
//
//  The ordering mistake is fixed separately. This is the part that makes
//  the whole CLASS of it invisible to users: a failed CI job, an asset
//  deleted by hand, an upload still in flight all produce the same shape.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('a release missing an asset falls back to one that has it', () => {
  const CDN = 'https://release-assets.githubusercontent.com/github-production-release-asset/1135233886/older?sig=abc';

  /** latest/download 404s; the API lists an older release that carries it. */
  const partialRelease = (releases) => async (url) => {
    const u = String(url);
    if (u.includes('/releases/latest/download/')) return new Response('Not Found', { status: 404 });
    if (u.includes('api.github.com')) {
      return new Response(JSON.stringify(releases), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/releases/download/')) {
      return new Response(null, { status: 302, headers: { location: CDN } });
    }
    return new Response('', { status: 206 });
  };

  const withAsset = (tag, extra = {}) => ({
    tag_name: tag, draft: false, prerelease: false, ...extra,
    assets: [{ name: 'InterviewCopilot-Setup.exe', browser_download_url: `https://github.com/o/r/releases/download/${tag}/InterviewCopilot-Setup.exe` }],
  });

  it('serves the older installer instead of an error page', async () => {
    const res = await hit('/windows', partialRelease([
      { tag_name: 'v4.0.22', draft: false, prerelease: false, assets: [] },  // the incomplete one
      withAsset('v4.0.21'),
    ]));
    expect(res.status, 'a missing asset in the newest release must not reach the user').toBe(302);
    expect(new URL(res.location).hostname).not.toMatch(/(^|\.)github\.com$/i);
  });

  it('still never hands the browser to github', async () => {
    const res = await hit('/windows', partialRelease([
      { tag_name: 'v4.0.22', draft: false, prerelease: false, assets: [] },
      withAsset('v4.0.21'),
    ]));
    expect(res.location).toBe(CDN);
    expect(res.location).not.toMatch(/madhavvan|h2so4/i);
  });

  it('skips drafts and prereleases — neither is a thing to hand a stranger', async () => {
    const res = await hit('/windows', partialRelease([
      { tag_name: 'v4.0.22', draft: false, prerelease: false, assets: [] },
      withAsset('v4.0.23-rc', { prerelease: true }),
      withAsset('v4.0.24-draft', { draft: true }),
      withAsset('v4.0.21'),
    ]));
    expect(res.status).toBe(302);
    expect(res.location).toBe(CDN);
  });

  it('falls back to OUR page when no release has the file at all', async () => {
    const res = await hit('/windows', partialRelease([
      { tag_name: 'v4.0.22', draft: false, prerelease: false, assets: [] },
    ]));
    expect(res.status).toBe(503);
    expect(res.body).not.toMatch(/github/i);
  });
});
