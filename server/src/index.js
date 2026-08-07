// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MINICO API SERVER
//  Stripe payments, license validation, geo-enforcement, admin
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const database = require('./database');
// Alias used by the support WS persistence handlers below. The
// WebSocket block was written against `db.` while the historical
// import at the top of this file uses `database.` — keeping both
// names live so existing call sites stay readable AND the new
// code reads identically to routes/support.js which also uses `db`.
const db = database;

const authRoutes = require('./routes/auth');
const paymentRoutes = require('./routes/payments');
const licenseRoutes = require('./routes/license');
const usageRoutes = require('./routes/usage');
const webhookRoutes = require('./routes/webhooks');
const adminRoutes = require('./routes/admin');
const aiRoutes = require('./routes/ai');
const conversationRoutes = require('./routes/conversations');
const downloadRoutes = require('./routes/downloads');
const supportRoutes = require('./routes/support');
const geoRoutes = require('./routes/geo');
// Support escalation worker — fires staged ntfy/email/sms alerts when
// no agent claims a customer chat. Lazy-required so missing optional
// deps (twilio) don't break server boot for users not using them.
const supportEscalation = require('./services/supportEscalation');
// Semver compare — extracted to utils/version.js so unit tests can hit
// it without booting Express. Used by /version + /license/validate.
const { compareVersions } = require('./utils/version');

const app = express();
const PORT = process.env.PORT || 4000;

// Behind Railway's reverse proxy — without this, req.protocol returns 'http'
// and breaks the Google OAuth redirect URI match, and req.ip returns the proxy IP.
app.set('trust proxy', 1);

// ── Security ──
app.use(helmet());
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (Electron, curl, server-to-server)
    if (!origin) return callback(null, true);
    // Allow all localhost ports in development
    if (origin.match(/^http:\/\/localhost:\d+$/)) return callback(null, true);
    // Allow Electron
    if (origin === 'app://.') return callback(null, true);
    // Allow configured frontend URL
    const frontendUrl = process.env.FRONTEND_URL;
    if (frontendUrl && origin === frontendUrl) return callback(null, true);
    // Allow the API server's own origin — browsers attach Origin on the
    // same-origin POST from our server-rendered password reset form, and
    // without this the middleware rejects its own form submission.
    const serverUrl = process.env.SERVER_URL;
    if (serverUrl && origin === serverUrl) return callback(null, true);
    const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
    if (railwayDomain && origin === `https://${railwayDomain}`) return callback(null, true);
    // Disallowed origin in production: return false (no CORS headers) rather
    // than throw — throwing surfaces as HTTP 500 to the client and floods
    // logs. The browser still blocks cross-origin reads when headers are
    // absent, which is the correct CORS enforcement path.
    if (process.env.NODE_ENV === 'production') return callback(null, false);
    // Allow all in development
    callback(null, true);
  },
  credentials: true,
}));

// DEV-ONLY: log every incoming request so we can see what the renderer
// is hitting. Skipped entirely in production — req.originalUrl can carry
// sensitive query params (?session_id=…, ?token=… for password reset)
// that we don't want piling up in Railway log retention. Wrapping the
// app.use itself rather than the callback avoids the per-request
// NODE_ENV branch on the hot path.
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    console.log(`[req] ${req.method} ${req.originalUrl}`);
    next();
  });
}

// Stripe webhooks need raw body — must be BEFORE express.json()
app.use('/api/v1/webhooks', webhookRoutes);

app.use(express.json({ limit: '10mb' }));
// Native HTML form submissions (e.g. the server-rendered password reset
// form in /api/v1/auth/reset-password) post application/x-www-form-urlencoded.
// Without this middleware req.body would be undefined and the POST handler
// would treat every form submission as "missing token".
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ── Rate limiting ──
const { RateLimiterMemory } = require('rate-limiter-flexible');

// General rate limiter
const generalLimiter = new RateLimiterMemory({ points: 60, duration: 60 });
// Strict auth rate limiter (prevent brute force on login/signup)
const authLimiter = new RateLimiterMemory({ points: 10, duration: 300 }); // 10 attempts per 5 min
// Very strict forgot-password limiter — prevents mass email spam and
// bill-bombing on transactional mail providers. 5 requests / 15 min / IP.
const forgotPasswordLimiter = new RateLimiterMemory({ points: 5, duration: 900 });
// Checkout creation limiter — every hit creates a real Stripe/Razorpay
// session/order, so a tight window matters. 20 attempts / 5 min / IP
// covers double-click frustration and switch-tier exploration without
// allowing scripted abuse of the provider create-session APIs (which
// also have account-wide rate limits we'd rather not hit).
const checkoutLimiter = new RateLimiterMemory({ points: 20, duration: 300 });

// Admin surface limiters. Two tiers:
//   • adminLimiter — generous cap on read-heavy admin browsing (listing
//     users, paging through audit log, pulling stats). 120/min means an
//     admin can grind through the UI without friction.
//   • adminDestructiveLimiter — tight cap on POST/PATCH/DELETE that mutates
//     state. 30/5min is enough for a burst of support actions but stops
//     a compromised token from doing thousands of refunds in a row.
const adminLimiter = new RateLimiterMemory({ points: 120, duration: 60 });
const adminDestructiveLimiter = new RateLimiterMemory({ points: 30, duration: 300 });

// AI endpoint limiter — keyed by user (when authenticated) or IP (fallback).
// Each AI call is real money to us (Claude w/ web_search ≈ $0.05+, GPT/Gemini
// cheaper but still non-trivial), so a leaked token must not be able to grind
// thousands of dollars in inference. Bumped May 2026 from 60→90/min/user
// after users reported hitting the cap during legitimate interview use:
// model switching, parallel chat-and-fresh-context calls, and Auto-Type
// firing its own AI planner all share this bucket. 90/min ≈ 1.5/sec
// sustained, still tight enough that a leaked token can't grind unbounded
// inference, but breathing room for normal interview pace.
const aiLimiter = new RateLimiterMemory({ points: 90, duration: 60 });

// Support bot limiters — keyed by IP (endpoint is anonymous). Two tiers:
//   • supportChatLimiter — 10 streams / minute / IP, 50 / hour / IP.
//     A single attacker IP costs us at most ~50 × $0.005 ≈ $0.25/hour
//     even on the most expensive question, and the hourly cap dominates.
//   • supportHandoffLimiter — 5 handoffs / hour / IP. Each handoff fires
//     Slack + Resend; this stops a scripted form-spam loop from filling
//     support@minicaai.com or paging the Slack channel.
const supportChatLimiter = new RateLimiterMemory({ points: 10, duration: 60 });
const supportChatHourly = new RateLimiterMemory({ points: 50, duration: 3600 });
const supportHandoffLimiter = new RateLimiterMemory({ points: 5, duration: 3600 });

// Optional IP allowlist for admin endpoints. Comma-separated CIDR-free list
// (single IPs and IPv4/IPv6 exact match). Empty string = no restriction
// (this is the default for dev). In prod we strongly recommend setting
// ADMIN_IP_ALLOWLIST to the office VPN range so a leaked admin JWT alone
// cannot be replayed from the open internet.
const ADMIN_IP_ALLOWLIST = (process.env.ADMIN_IP_ALLOWLIST || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function isAdminIpAllowed(ip) {
  if (ADMIN_IP_ALLOWLIST.length === 0) return true; // disabled → allow all
  if (!ip) return false;
  // Normalize IPv6-mapped IPv4 (::ffff:1.2.3.4 → 1.2.3.4) for easy matches.
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return ADMIN_IP_ALLOWLIST.includes(ip) || ADMIN_IP_ALLOWLIST.includes(normalized);
}

app.use(async (req, res, next) => {
  try {
    const key = req.ip || req.connection?.remoteAddress || 'unknown';
    await generalLimiter.consume(key);

    // Stricter limit on auth endpoints
    if (req.path.startsWith('/api/v1/auth/login') || req.path.startsWith('/api/v1/auth/signup')) {
      try {
        await authLimiter.consume(key);
      } catch {
        return res.status(429).json({ error: 'Too many login attempts. Please wait 5 minutes.' });
      }
    }

    // Even stricter limit on forgot-password to prevent reset-mail spam
    if (req.path === '/api/v1/auth/forgot-password' && req.method === 'POST') {
      try {
        await forgotPasswordLimiter.consume(key);
      } catch {
        return res.status(429).json({ error: 'Too many reset requests. Please wait 15 minutes.' });
      }
    }

    // Tighter limit on the three checkout-creating endpoints. Each request
    // creates a real Stripe/Razorpay artifact (session/order/subscription)
    // so we need to back-pressure scripted abuse before we hit the
    // provider's own account-wide rate ceilings.
    if (
      req.method === 'POST' &&
      (req.path === '/api/v1/payments/create-checkout' ||
       req.path === '/api/v1/payments/create-renewal' ||
       req.path === '/api/v1/payments/upgrade-tier')
    ) {
      try {
        await checkoutLimiter.consume(key);
      } catch {
        return res.status(429).json({ error: 'Too many checkout attempts. Please wait a few minutes and try again.' });
      }
    }

    // Admin surface. Enforce IP allowlist first (if configured), then
    // apply read/write rate limits. Only active for /api/v1/admin/**; all
    // other traffic is unaffected.
    if (req.path.startsWith('/api/v1/admin/')) {
      if (!isAdminIpAllowed(key)) {
        // Audit the attempt before we drop the connection. We don't yet
        // know WHICH admin — no JWT is checked at this layer — but we do
        // know the IP and target path.
        try {
          require('./database').logAdminAction(
            'unknown',
            'admin-ip-blocked',
            null,
            null,
            { path: req.path, method: req.method, ip: key },
          );
        } catch { /* best-effort */ }
        return res.status(403).json({ error: 'Admin access not allowed from this network' });
      }
      try {
        await adminLimiter.consume(key);
      } catch {
        return res.status(429).json({ error: 'Admin rate limit exceeded. Wait a minute and retry.' });
      }
      // Destructive verbs get an extra tighter bucket.
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        try {
          await adminDestructiveLimiter.consume(key);
        } catch {
          return res.status(429).json({ error: 'Too many admin mutations. Wait 5 minutes and retry.' });
        }
      }
    }

    // Support bot rate limits. Anonymous, IP-keyed, two windows: a tight
    // burst cap (10/min) plus a slower drip cap (50/hour) so an attacker
    // can't both spike *and* sustain. Hits BEFORE the route to keep us
    // from spending OpenAI tokens on the abuse traffic.
    if (req.path.startsWith('/api/v1/support/chat')) {
      try {
        await supportChatLimiter.consume(key);
        await supportChatHourly.consume(key);
      } catch {
        return res.status(429).json({
          error: 'Slow down — too many support requests from this address. Wait a minute and try again, or email support@minicaai.com.',
        });
      }
    }
    if (req.path.startsWith('/api/v1/support/handoff')) {
      try {
        await supportHandoffLimiter.consume(key);
      } catch {
        return res.status(429).json({
          error: "You've sent several handoff requests recently. We've already got your earlier message — please wait for a reply.",
        });
      }
    }

    // AI cost control. Authenticated AI endpoints are real money per call —
    // a leaked or compromised JWT must NOT be able to grind unbounded
    // inference. Key by user_id when present (so two users on the same
    // office IP don't share a bucket) else fall back to IP. We can't
    // resolve user_id here without parsing JWT, so we attempt a cheap
    // header sniff: clients send Authorization: Bearer <jwt>. If parse
    // fails, fall back to IP — strictly safe since IP is always present.
    if (req.path.startsWith('/api/v1/ai/')) {
      let aiKey = key;
      try {
        const auth = req.headers.authorization;
        if (auth && auth.startsWith('Bearer ')) {
          // Decode payload only — signature verification happens in
          // authMiddleware later. We just need a stable per-user bucket key.
          const token = auth.slice(7);
          const parts = token.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            // JWT payload carries `id` (see generateToken — {id,email,tier}).
            // The old `payload.user_id` never existed, so every authenticated
            // AI request silently fell back to the IP bucket and corporate-NAT
            // users 429'd each other mid-interview.
            if (payload && payload.id) aiKey = `u:${payload.id}`;
          }
        }
      } catch { /* fall back to IP */ }
      try {
        await aiLimiter.consume(aiKey);
      } catch {
        return res.status(429).json({
          error: 'You are sending requests too fast — pause for a few seconds and try again. (App-level cap: 90/min/user.)',
          code: 'app_rate_limit',
        });
      }
    }

    next();
  } catch {
    res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
});

// ── Version Check Middleware ──
// Detects old app versions and can force updates
// Client sends version via X-App-Version header OR app_version in body
const MIN_SUPPORTED_VERSION = '2.3.0'; // Versions below this get a warning
const FORCE_UPDATE_VERSION = '1.0.0';  // Versions below this are BLOCKED (set low initially)

app.use((req, res, next) => {
  // Check header first, then body (old apps send in body during login/signup)
  const clientVersion = req.headers['x-app-version'] || req.body?.app_version;

  // Skip if no version info
  if (!clientVersion) return next();

  // Check if version is too old and must be blocked
  if (compareVersions(clientVersion, FORCE_UPDATE_VERSION) < 0) {
    const latest = getLatestVersion();
    return res.status(426).json({
      error: 'App update required',
      message: 'Your app version is no longer supported. Please download the latest version from our website.',
      updateRequired: true,
      latestVersion: latest.version,
      downloadUrl: latest.downloadUrl,
    });
  }

  // Add update hint to response for slightly old versions
  if (compareVersions(clientVersion, MIN_SUPPORTED_VERSION) < 0) {
    res.setHeader('X-Update-Available', getLatestVersion().version);
  }

  next();
});

// ── Routes ──
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/license', licenseRoutes);
// Server-authoritative interview clock (start/heartbeat/stop/balance).
app.use('/api/v1/usage', usageRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/ai', aiRoutes);
app.use('/api/v1/conversations', conversationRoutes);
// Support bot — anonymous-allowed (no auth middleware), rate-limited
// above per IP. Chat = SSE stream to OpenAI; handoff = Slack + email.
app.use('/api/v1/support', supportRoutes);
// Geo lookup proxy — replaces direct browser → ipapi.co call which
// kept tripping CORS + free-tier rate limits. Caches per-IP for 10min
// so the SPA doesn't burn upstream quota on every render. Silent
// fallback on upstream failure (never surfaces a 5xx to the client).
app.use('/api/v1/geo', geoRoutes);
// Public download redirects mounted at root — explicit per-platform paths
// inside the router (no /:platform catch-all) so unmatched paths still
// fall through to the 404 handler below. Reachable on get.minicaai.com.
app.use(downloadRoutes);

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', service: 'minicaai-api' });
});

// ── Crash report intake ──
// Receives Crashpad/Breakpad minidumps from the Electron crashReporter
// running on user devices. The body is multipart/form-data with the
// dump itself + extra metadata (app_version, platform, arch). We don't
// parse the dump — Crashpad's minidump format requires breakpad's
// minidump_stackwalk to symbolize, which is offline analyst work. Here
// we just persist the metadata so the dashboard can show "N crashes
// today, version X, platform Y" and surface affected users.
//
// No auth required: the reporter has no JWT. Rate-limited at the
// Express layer to keep an attacker from filling the disk with junk.
// Body size capped at 5MB (typical minidump is 100-500KB).
const crashUpload = express.raw({ type: '*/*', limit: '5mb' });
app.post('/api/v1/crash', crashUpload, (req, res) => {
  try {
    const meta = {
      ip: req.ip,
      ua: req.headers['user-agent'] || '',
      app_version: req.query.app_version || '',
      platform: req.query.platform || '',
      arch: req.query.arch || '',
      bytes: Buffer.isBuffer(req.body) ? req.body.length : 0,
      received_at: Date.now(),
    };
    // Best-effort log only for now — the dashboard table can come later.
    // Even just having the count visible in the logs is a step up from
    // "we have no idea how often the app crashes."
    console.log('[crash]', JSON.stringify(meta));
    res.json({ ok: true });
  } catch (err) {
    console.warn('[crash] receipt failed:', err && err.message);
    res.status(500).json({ error: 'crash receipt failed' });
  }
});

// ── Stealth verification page ──
// Standalone HTML page that exposes the same browser focus events
// proctoring stacks listen to (window.onblur / onfocus / visibilitychange)
// + a typing speed measurement textarea. Lets the user verify in 30
// seconds that:
//   1. Popout button clicks don't trigger focus loss in the browser
//      (focusable:false fix is applied)
//   2. Auto-Type rhythm hits realistic human-coder chars/sec
// Public route — no auth needed; the page is a diagnostic tool, not
// an attack surface. Cache-Control public so a Railway dyno cold start
// doesn't slow down the test page.
const path = require('path');
app.get('/stealth-test', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(__dirname, 'stealth-test.html'));
});

// ── App Version Check ──
// Returns the latest app version info. All clients (including old versions)
// can call this to check if they need to update. This works even when the
// built-in Electron auto-updater fails.
//
// Source of truth is the GitHub Releases API — we cache the response in
// memory for VERSION_CACHE_TTL_MS so cutting a release auto-propagates
// without a server deploy. Falls back to FALLBACK_VERSION when GitHub is
// unreachable, so clients never get a broken response.
//
// Download filenames MUST match electron-builder's artifactName entries
// in package.json → build → {win,mac,linux}.
// Must name the SAME repo as REPO in routes/downloads.js. It pointed at
// `interviewcopilot-releases` from 2026-07-18 to 2026-08-06 — a repo that
// was never created — so this fetch 404'd on every refresh and the endpoint
// silently served FALLBACK_VERSION to every client for three weeks.
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/madhavvan/h2so4/releases/latest';
const VERSION_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Offline fallback ONLY — the GitHub Releases fetch above is the live
// source of truth. Used when GitHub is unreachable AND the in-memory cache
// is cold (server just restarted). Override at deploy with LATEST_APP_VERSION
// so it can't silently drift behind the shipped release: the previous
// hardcoded 3.4.9 sat four releases behind shipped 4.0.8, which on a cold
// start would tell every client "latest is 3.4.9" and show a misleading
// downgrade prompt. Whatever value is used MUST point at a version that
// actually has a GitHub release.
const FALLBACK_VERSION = {
  // Bumped 4.0.8 → 4.0.16 on 2026-08-06. While GITHUB_RELEASES_URL pointed
  // at a repo that did not exist, the fetch failed on every refresh and this
  // fallback WAS the live answer — so production told every client the
  // latest version was 4.0.8 while 4.0.16 was the shipped build.
  //
  // Bumped 4.0.16 → 4.0.17 on 2026-08-07 with that release. This value is
  // what every client is told when GitHub is unreachable AND the in-memory
  // cache is cold, so leaving it behind the shipped build means a restarted
  // server quietly tells the fleet it is up to date when it is not — and
  // this endpoint is the ONLY update channel that still reaches the
  // v4.0.11-v4.0.16 installs whose baked update feed 404s. Bump it in the
  // same commit as every version bump.
  version: process.env.LATEST_APP_VERSION || '4.0.17',
  minVersion: '2.0.0',
  releaseDate: '2026-08-07',
  releaseNotes: 'Latest stable release.',
  downloadUrl: {
    // Routed through get.minicaai.com → 302 → GitHub release CDN. Keeps the
    // codename out of any URL the client receives and surfaces in browser
    // address bars / notifications. The /dl handler at routes/downloads.js
    // owns the actual GitHub release URL.
    windows: 'https://get.minicaai.com/windows',
    mac: 'https://get.minicaai.com/mac',
    linux: 'https://get.minicaai.com/linux',
  },
};

const versionCache = {
  value: FALLBACK_VERSION,
  fetchedAt: 0,
  refreshing: false,
};

async function refreshVersionCache() {
  if (versionCache.refreshing) return;
  versionCache.refreshing = true;
  try {
    const res = await fetch(GITHUB_RELEASES_URL, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'minicaai-server',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = await res.json();
    const tag = (data.tag_name || '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(tag)) throw new Error(`Bad tag: ${data.tag_name}`);
    versionCache.value = {
      version: tag,
      minVersion: FALLBACK_VERSION.minVersion,
      releaseDate: data.published_at || FALLBACK_VERSION.releaseDate,
      releaseNotes: data.body || FALLBACK_VERSION.releaseNotes,
      // "/releases/latest/download/<asset>" always resolves to current latest,
      // so the same URLs work after every release.
      downloadUrl: FALLBACK_VERSION.downloadUrl,
    };
    versionCache.fetchedAt = Date.now();
  } catch (err) {
    // Keep the last good cached value. On a cold start where GitHub was
    // never reachable, this stays at FALLBACK_VERSION — clients still get
    // a sane (if slightly stale) answer rather than a 500.
    console.warn('[version-check] GitHub fetch failed:', err.message);
  } finally {
    versionCache.refreshing = false;
  }
}

function getLatestVersion() {
  // Sync getter. If the cache is stale, kick off a background refresh for
  // the next caller — never blocks this request.
  if (Date.now() - versionCache.fetchedAt > VERSION_CACHE_TTL_MS) {
    refreshVersionCache();
  }
  return versionCache.value;
}

// Warm the cache at boot so the first request after restart isn't served
// the cold-start fallback.
refreshVersionCache();

app.get('/api/v1/app-version', (req, res) => {
  const latest = getLatestVersion();
  const clientVersion = req.query.v || '0.0.0';
  const isOutdated = compareVersions(clientVersion, latest.version) < 0;
  const mustUpdate = compareVersions(clientVersion, latest.minVersion) < 0;

  res.json({
    latest: latest.version,
    current: clientVersion,
    isOutdated,
    mustUpdate,
    releaseNotes: latest.releaseNotes,
    downloadUrl: latest.downloadUrl,
  });
});

// (compareVersions imported at top of file from ./utils/version)

// ── 404 ──
app.use((req, res) => {
  console.warn(`[404] ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'Not found' });
});

// ── Error handler ──
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Graceful shutdown ──
process.on('SIGINT', () => {
  console.log('Shutting down...');
  database.closeDB();
  process.exit(0);
});

process.on('SIGTERM', () => {
  database.closeDB();
  process.exit(0);
});

const server = app.listen(PORT, () => {
  console.log(`minicaai API running on port ${PORT}`);
  console.log(`Database initialized`);
  // Support escalation worker — scans support_escalation_queue every
  // 10s, fires staged ntfy/email/sms/fallback rungs. Started AFTER
  // listen() so route registration completes first.
  try { supportEscalation.start(); }
  catch (e) { console.warn('[support/escalation] failed to start:', e.message); }
  // Loud warning: in production, SERVER_URL controls the OAuth
  // redirect_uri Google sees. If it's unset on Railway, Express's
  // req.host returns the internal Railway hostname (e.g. 5ejjp94w.up.
  // railway.app) and the consent screen shows that ugly URL instead of
  // api.minicaai.com. The code has a fallback to req.host, but the
  // fallback is wrong on Railway — keep this warning so the next deploy
  // notices.
  if (process.env.NODE_ENV === 'production' && !process.env.SERVER_URL) {
    console.warn('');
    console.warn('================================================================');
    console.warn('  WARNING: SERVER_URL is not set.');
    console.warn('  Google OAuth redirect_uri will be built from req.host, which');
    console.warn('  on Railway returns the internal hostname. The consent screen');
    console.warn('  will show the Railway URL instead of your subdomain.');
    console.warn('  Fix: set SERVER_URL=https://api.minicaai.com in Railway env');
    console.warn('  AND add that exact callback URI to Google Cloud Console.');
    console.warn('================================================================');
    console.warn('');
  }
});

// ── Periodic chores ──
// Reset tokens expire after 1 hour but the row sticks around indefinitely
// until something cleans it up. We were leaking thousands of stale rows
// per month. Run once at boot then every 24h. Wrapped in try/catch so a
// transient DB blip can't kill the interval.
const RESET_TOKEN_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
function runResetTokenCleanup() {
  try {
    database.cleanupExpiredResetTokens();
  } catch (err) {
    console.warn('[cleanup] reset-token sweep failed:', err && err.message);
  }
}
runResetTokenCleanup();
setInterval(runResetTokenCleanup, RESET_TOKEN_CLEANUP_INTERVAL_MS).unref();

// ── Cycle-end downgrade sweeper ──
// Belt-and-suspenders for the subscription lifecycle. Webhooks
// (Stripe customer.subscription.deleted, Razorpay subscription.halted)
// are the primary signal that a paid cycle has ended and the user
// should drop to Free. But webhooks can be delayed, lost, or
// duplicated. This sweep runs every 5 min and catches any license in
// 'canceling' state whose expires_at has passed and the webhook never
// landed — transitions them to Free with the standard free-tier
// defaults (5 sessions, gemini-only, 30-day rolling window) and
// fires the "your access has ended" email with a "Get Basic now"
// CTA. Idempotent via transitionLicenseToFree which no-ops when the
// user is already on free.
const CYCLE_END_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
async function runCycleEndSweep() {
  try {
    const userIds = database.getExpiredCancelingUserIds(100);
    if (!userIds || userIds.length === 0) return;
    const { sendMail, renderAccessEndedEmail } = require('./email');
    for (const userId of userIds) {
      try {
        const user = database.getUserById(userId);
        if (!user) continue;
        const prevTier = database.getLicenseByUserId(userId)?.tier || 'paid';
        const result = database.transitionLicenseToFree(userId, { reason: 'sweep' });
        if (!result || !result.transitioned) continue;
        console.log(`[cycle-end-sweep] transitioned user ${userId} (${user.email}) from ${prevTier} to free`);

        // Goodbye email — fire-and-forget. Suppressed silently if no
        // email transport is configured (Resend + SMTP both unset in
        // dev) so the sweep loop never throws on mail.
        try {
          if (typeof renderAccessEndedEmail === 'function') {
            const buyBasicUrl = (process.env.FRONTEND_URL || 'https://minicaai.com') + '/#pricing';
            const signInUrl = process.env.FRONTEND_URL || 'https://minicaai.com';
            const { subject, html, text } = renderAccessEndedEmail({
              name: user.name, previousTier: prevTier, buyBasicUrl, signInUrl,
            });
            sendMail({ to: user.email, subject, html, text }).catch(() => { /* mail outage */ });
          }
        } catch (mailErr) {
          console.warn('[cycle-end-sweep] mail render/send failed:', mailErr && mailErr.message);
        }
      } catch (perUserErr) {
        console.warn('[cycle-end-sweep] per-user transition failed for', userId, ':', perUserErr.message);
      }
    }
  } catch (err) {
    console.warn('[cycle-end-sweep] outer error:', err && err.message);
  }
}
// Run once at boot to catch anything that expired while the server
// was down. After that, every 5 min via interval.
runCycleEndSweep();
setInterval(runCycleEndSweep, CYCLE_END_SWEEP_INTERVAL_MS).unref();

// ── Login-log retention sweeper ──
// The published privacy policy (docs/public/PRIVACY.md §6) promises
// login logs are kept 12 months. That promise had no enforcement —
// rows accumulated forever. Purge anything older than 365 days, at
// boot and daily after. login_logs has no dependents (deleteUser
// already removes a user's rows outright), and the admin UI reads
// only recent entries, so this is purely the compliance trim.
const LOGIN_LOG_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
function runLoginLogRetentionSweep() {
  try {
    const cutoff = Date.now() - LOGIN_LOG_RETENTION_MS;
    const info = database.getDB()
      .prepare('DELETE FROM login_logs WHERE created_at < ?')
      .run(cutoff);
    if (info.changes > 0) {
      console.log(`[retention-sweep] purged ${info.changes} login-log rows older than 12 months`);
    }
  } catch (err) {
    console.warn('[retention-sweep] login-log purge failed:', err && err.message);
  }
}
runLoginLogRetentionSweep();
setInterval(runLoginLogRetentionSweep, 24 * 60 * 60 * 1000).unref();

// ── Stale usage-session sweeper ──
// A client that crashed (or lost network) mid-interview stops
// heartbeating; its open usage_session would otherwise dangle forever.
// Settle any session silent past the stale threshold AT its last
// heartbeat — the user is never charged for time after their client
// died. Runs at boot (catch sessions orphaned by a server restart) and
// every 60s after.
function runUsageSessionSweep() {
  try {
    const closed = database.sweepStaleUsageSessions();
    if (closed > 0) console.log(`[usage-sweep] settled ${closed} stale session(s) at last heartbeat`);
  } catch (err) {
    console.warn('[usage-sweep] error:', err && err.message);
  }
}
runUsageSessionSweep();
setInterval(runUsageSessionSweep, 60 * 1000).unref();

// ── Pass-expiry reminder sweep ──
// Basic/Pro/Max passes expire 30 days after purchase; paid-but-unused
// time evaporating silently is a guaranteed support complaint. When a
// license still holds >1 min and its window closes within 3 days, send
// one reminder — markLifecycleEmailOnce keys on the exact expiry
// timestamp, so re-runs (and extensions creating a NEW window) behave
// correctly: one email per window, ever.
const PASS_EXPIRY_LOOKAHEAD_MS = 3 * 24 * 60 * 60 * 1000;
function runPassExpirySweep() {
  try {
    const expiring = database.getExpiringPassLicenses(PASS_EXPIRY_LOOKAHEAD_MS);
    for (const row of expiring) {
      try {
        if (!database.markLifecycleEmailOnce(row.user_id, 'pass-expiry', row.credits_expire_at)) continue;
        const { sendMail, renderPassExpiryEmail } = require('./email');
        if (typeof renderPassExpiryEmail !== 'function') continue;
        const { subject, html, text } = renderPassExpiryEmail({
          name: row.name,
          tier: row.tier,
          minutesLeft: Math.floor((row.credits_remaining_seconds || 0) / 60),
          expiresDate: new Date(row.credits_expire_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          signInUrl: process.env.FRONTEND_URL || 'https://minicaai.com',
        });
        sendMail({ to: row.email, subject, html, text }).catch(() => { /* mail outage — row is claimed; acceptable */ });
        console.log(`[pass-expiry-sweep] reminder sent to ${row.email} (${row.tier}, ${Math.floor((row.credits_remaining_seconds || 0) / 60)}m left)`);
      } catch (perUserErr) {
        console.warn('[pass-expiry-sweep] per-user failure:', row.user_id, perUserErr.message);
      }
    }
  } catch (err) {
    console.warn('[pass-expiry-sweep] outer error:', err && err.message);
  }
}
runPassExpirySweep();
setInterval(runPassExpirySweep, 6 * 60 * 60 * 1000).unref();

// Daily SQLite VACUUM INTO snapshot. Single-file SQLite has no replication;
// this is the one defense against volume corruption / accidental delete /
// detach. Keeps 7 most recent. Skipped in test mode (':memory:' DB).
if (process.env.NODE_ENV !== 'test' && process.env.DATABASE_PATH !== ':memory:') {
  try {
    const backup = require('./backup');
    backup.startDailyBackups();
  } catch (err) {
    console.warn('[backup] failed to start daily backups:', err && err.message);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LIVE SUPPORT CHAT (WebSocket)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const WebSocket = require('ws');
// Support-WS join authentication. verifyToken uses the same JWT secret as
// the REST middleware; SUPPORT_ADMIN_EMAILS (env list every other gate
// reads) decides who may connect as a support agent. See the join handler:
// agent role is admin-only and customer identity comes from the verified
// token, never the frame.
const { verifyToken } = require('./middleware/auth');
const SUPPORT_ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const wss = new WebSocket.Server({ server, path: '/ws/support' });

// Track connected clients: customers and agents.
// `lastSeen` powers the idle sweeper; `pingPending` lets the heartbeat
// detect dead-but-not-closed sockets (firewall NAT timeout, broken Wi-Fi
// where TCP FIN never lands) that would otherwise leak forever.
const supportClients = new Map(); // sessionId -> { ws, type, email, name, lastSeen, pingPending }
// Expose the live-socket map to routes so the resolve handler can
// push csat_request to a connected customer without needing its own
// WebSocket plumbing. routes/support.js reads req.app.locals.supportClients.
app.locals.supportClients = supportClients;
app.locals.WebSocketState = WebSocket;   // for OPEN constant

// Tunables. 30-min idle close matches typical support-chat patience; ping
// every 60s is well under common 2-min NAT timeouts.
//
// Connection caps — per role, not a single global. (2026-05-13 fix: a
// universal `1 per email` was evicting an admin's browser-tab WS the
// moment Electron also opened one, causing a flap loop where ZERO of
// the admin's sockets stayed alive long enough to receive a real
// customer message.) Customers stay at 1 — the most-recent click of
// Talk to a human wins, prior tabs disconnect cleanly. Agents go to
// 4: admin might run main + popout in Electron AND have a browser
// tab open, plus the test/staging admin probe; all should coexist.
const SUPPORT_IDLE_MS = 30 * 60 * 1000;
const SUPPORT_PING_INTERVAL_MS = 60 * 1000;
const SUPPORT_MAX_PER_USER = { customer: 1, agent: 4 };

// Helper: list connections for the same logical user (same role +
// email). When count >= cap we evict the OLDEST so the newest tab
// always wins and an in-flight reconnect doesn't get itself kicked.
function listClientsForRoleEmail(role, email) {
  if (!email) return [];
  const out = [];
  for (const [id, c] of supportClients) {
    if (c.type === role && c.email === email) out.push({ id, c });
  }
  return out;
}

wss.on('connection', (ws, req) => {
  let clientId = null;

  // Best-effort capture of the customer's IP / UA so support_threads
  // can store provenance. The WS upgrade carries these in the same
  // headers as a normal HTTP request — req.socket.remoteAddress is
  // overridden by trust-proxy upstream when behind Railway.
  const remoteIp = req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || req?.socket?.remoteAddress || '';
  const remoteUa = String(req?.headers?.['user-agent'] || '').slice(0, 200);

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);

      if (data.type === 'join') {
        const role = data.role || 'customer';

        // ── AUTHENTICATE THE JOIN ──────────────────────────────────
        // Until this hardening pass the handler trusted data.role and
        // data.user outright, so anyone could:
        //   • {role:'agent'}              → receive inbox_snapshot (every
        //     open thread's email/name/tier/question) AND reply to
        //     customers AS support;
        //   • {role:'customer', user:<x>} → replay x's chat history.
        // Identity now comes from a verified JWT carried IN THE JOIN FRAME
        // (data.token — deliberately not the URL, so it never lands in
        // access logs). Agents must present an admin token; customers may
        // stay anonymous, but an unauthenticated socket can never bind to a
        // registered account's email or read another thread's history.
        let authedUser = null;
        if (data.token && typeof data.token === 'string') {
          try {
            authedUser = verifyToken(data.token);
            // Honor force-logout: password change/reset bumps
            // tokens_revoked_after, killing pre-revocation tokens even when
            // the signature is still valid. Same check as authMiddleware.
            if (authedUser && authedUser.id) {
              const revokedAfter = db.getTokensRevokedAfter(authedUser.id);
              if (revokedAfter && authedUser.iat && authedUser.iat * 1000 < revokedAfter) {
                authedUser = null;
              }
            }
          } catch { authedUser = null; }
        }
        const authedEmail = authedUser ? String(authedUser.email || '').toLowerCase() : null;
        const isAdminConn = !!authedEmail && SUPPORT_ADMIN_EMAILS.includes(authedEmail);

        if (role === 'agent' && !isAdminConn) {
          // Agent role gates the whole inbox + impersonation surface — admin
          // token required, no exceptions. Close the socket so a rejected
          // client can't sit idle holding a connection slot.
          try { ws.send(JSON.stringify({ type: 'auth_error', scope: 'agent', message: 'Support agent access requires admin authentication.' })); } catch {}
          try { ws.close(4401, 'agent auth required'); } catch {}
          return;
        }

        // Resolve this socket's logical identity. Lowercased because the DB
        // stores customer_email lowercased and the agent's `to` field (from
        // the REST inbox) is matched case-insensitively against
        // supportClients[c].email — a mixed-case mismatch silently drops the
        // agent's reply (reported 2026-05-13 "messages not reflecting in
        // user portal").
        //   • agent           → verified admin email
        //   • customer+token  → verified account email + bound user id
        //   • customer (anon) → fresh anon_* id; a frame email belonging to
        //                       a real account is NOT honored (replay vector)
        let email;
        let boundUserId = null;
        let isAuthedCustomer = false;
        if (role === 'agent') {
          email = authedEmail;
        } else if (authedUser) {
          email = authedEmail;
          boundUserId = authedUser.id;
          isAuthedCustomer = true;
        } else {
          const claimed = String(data.user || '').trim().toLowerCase();
          const claimsRegistered = !!claimed && !!db.getUserByEmail(claimed);
          email = (claimed && !claimsRegistered) ? claimed : `anon_${Date.now()}`;
        }

        // Per-role connection cap. Customers default to 1 — most-recent
        // click of Talk to a human wins. Agents default to 4 — admin can
        // run Electron + browser + popout simultaneously without sockets
        // evicting each other in a flap loop.
        //
        // CRITICAL: clientId must be UNIQUE PER CONNECTION, not just
        // role+email. The earlier `${role}_${email}` clientId caused
        // every new connection from the same email to OVERWRITE the
        // prior entry in the supportClients Map (which keys on
        // clientId). Result: even with cap=4, the map only ever held
        // 1 entry per email, and broadcasts iterated 1 entry instead
        // of 4. Symptom: Electron admin and browser admin both signed
        // in as nippu, only the last-to-connect ever received
        // customer_joined / message frames. Fixed by appending a
        // monotonic counter so each socket gets a stable, unique
        // map key.
        const cap = SUPPORT_MAX_PER_USER[role] || 1;
        const existing = listClientsForRoleEmail(role, email);
        if (existing.length >= cap) {
          // Sort by lastSeen ASC — oldest first — and evict until we're
          // under cap. The newest connection (this one) always survives.
          existing.sort((a, b) => (a.c.lastSeen || 0) - (b.c.lastSeen || 0));
          const toEvict = existing.slice(0, existing.length - cap + 1);
          for (const { id, c } of toEvict) {
            try { c.ws.close(4000, 'Replaced by newer connection'); } catch {}
            supportClients.delete(id);
          }
        }

        // ── DB-backed thread lifecycle ──
        // Customer: find a resumable thread (open or assigned, <7 days
        // old) or create one. Agent: register presence, no thread
        // creation. Per-customer-message persistence happens below in
        // the 'message' handler — we don't double-insert on join.
        let threadId = null;
        if (role === 'customer') {
          // Only authenticated customers resume a prior thread by identity.
          // Anonymous sockets always start fresh — otherwise a guessed email
          // would resurface someone else's conversation.
          let thread = isAuthedCustomer ? db.findResumableSupportThread(email) : null;
          if (!thread) {
            thread = db.createSupportThread({
              customer_email: email,
              customer_name: data.name || null,
              customer_tier: data.tier || null,
              customer_user_id: boundUserId || null,
              initial_question: data.initialQuestion || null,
              channel: 'bot',
              customer_ip: remoteIp,
              customer_ua: remoteUa,
            });
            // Enqueue the staged escalation alerts. Worker picks them up
            // and fires as each deadline passes UNLESS an agent claims.
            try {
              db.enqueueSupportEscalations(
                thread.id,
                supportEscalation.buildEscalationsFor(thread)
              );
            } catch (e) {
              console.warn('[support/ws] failed to enqueue escalations:', e.message);
            }

            // INSTANT ntfy push — user wanted phone buzz the moment a
            // customer clicks Talk to a human, not 30 seconds later.
            // The escalation queue stays as a follow-up safety net
            // (admin who missed the instant push gets another buzz at
            // t+2min via email + t+5min via SMS if configured).
            // Fire-and-forget; failures are logged in the ntfy module.
            (async () => {
              try {
                const { sendNewCustomerAlert } = require('./services/ntfy');
                const agents = db.listOnlineSupportAgents();
                const targets = agents.filter(a => a.ntfy_topic && a.ntfy_topic.length > 0);
                if (targets.length === 0) {
                  console.log('[support/ws] instant ntfy SKIP — no online agents with topic');
                  return;
                }
                console.log(`[support/ws] instant ntfy fanout to ${targets.length} agent(s) for thread=${thread.id}`);
                await Promise.all(targets.map(a =>
                  sendNewCustomerAlert(a.ntfy_topic, {
                    customerName: thread.customer_name,
                    customerEmail: thread.customer_email,
                    question: thread.initial_question,
                    threadId: thread.id,
                  }).then(r => {
                    if (r.ok) {
                      try { db.markNtfyAlertSent(a.agent_email); } catch {}
                    }
                  })
                ));
              } catch (e) {
                console.warn('[support/ws] instant ntfy failed:', e.message);
              }
            })();
          }
          threadId = thread.id;
        } else if (role === 'agent') {
          try { db.heartbeatSupportAgent(email); }
          catch (e) { console.warn('[support/ws] presence upsert failed:', e.message); }
        }

        // Unique per-socket clientId. role + email alone collides when
        // the same email opens N tabs/devices — the Map's set()
        // silently replaces the prior entry, which is why broadcasts
        // ended up reaching only the most-recent admin. Counter
        // increments per connection; survives until server restart.
        if (typeof global.__supportConnSeq === 'undefined') global.__supportConnSeq = 0;
        global.__supportConnSeq += 1;
        clientId = `${role}_${email}_${global.__supportConnSeq}`;
        supportClients.set(clientId, {
          ws,
          type: role,
          email,
          name: data.name || 'User',
          threadId,         // null for agents, set for customers
          lastSeen: Date.now(),
          pingPending: false,
        });
        console.log(`Support chat: ${data.name || email} connected as ${role} thread=${threadId || '-'}`);

        // Notify the OTHER side of this join.
        if (role !== 'agent') {
          // 1. Send the customer their resumed conversation history so the
          //    bot panel doesn't open blank. The client renders these in
          //    order before any new live message. Authed customers only —
          //    an anonymous socket never replays stored history.
          if (threadId && isAuthedCustomer) {
            try {
              const history = db.getSupportMessages(threadId, { limit: 200 });
              if (history.length > 0) {
                ws.send(JSON.stringify({
                  type: 'history',
                  threadId,
                  messages: history.map(m => ({
                    id: m.id,
                    role: m.sender_role,
                    name: m.sender_name,
                    text: m.text,
                    at: m.created_at,
                    readAt: m.read_by_other_at,
                  })),
                }));
              }
            } catch (e) {
              console.warn('[support/ws] history snapshot failed:', e.message);
            }
          }
          // 2. If any agent is ALREADY online (live socket OR
          //    presence-fresh in last 90s), tell the customer "agent
          //    is here" right now. Without this, a customer who joins
          //    AFTER the admin's WS connects sits on "finding agent…"
          //    forever, because the agent_joined-on-agent-join handler
          //    below only fires when the AGENT is the new joiner.
          //    Resume path: if the thread already has an
          //    assigned_agent_email, use that name so the customer
          //    sees the SAME agent they had before, not a generic
          //    "an agent is here".
          try {
            const thread = threadId ? db.getSupportThread(threadId) : null;
            let agentNameForCustomer = null;
            if (thread?.assigned_agent_email) {
              agentNameForCustomer = thread.assigned_agent_email.split('@')[0];
            } else {
              // No assignment yet — any live agent will do.
              for (const [, c] of supportClients) {
                if (c.type === 'agent' && c.ws.readyState === WebSocket.OPEN) {
                  agentNameForCustomer = c.name || (c.email || '').split('@')[0] || 'support';
                  break;
                }
              }
              if (!agentNameForCustomer) {
                // No live agent socket — but maybe one is just heartbeat-
                // fresh (between WS reconnects). Check presence rows.
                try {
                  const online = db.listOnlineSupportAgents();
                  if (online && online.length > 0) {
                    agentNameForCustomer = (online[0].agent_email || '').split('@')[0] || 'support';
                  }
                } catch { /* non-critical */ }
              }
            }
            if (agentNameForCustomer) {
              ws.send(JSON.stringify({ type: 'agent_joined', name: agentNameForCustomer }));
            }
          } catch (e) {
            console.warn('[support/ws] agent_joined-on-customer-join failed:', e.message);
          }
          // 3. Notify all agents (live sockets) that a new/resumed
          //    customer joined. Persistence-driven inbox state is
          //    fetched via REST; this live event is just a "ping the
          //    UI to refresh now" signal.
          for (const [, client] of supportClients) {
            if (client.type === 'agent' && client.ws.readyState === WebSocket.OPEN) {
              client.ws.send(JSON.stringify({
                type: 'customer_joined', email, name: data.name, threadId,
              }));
            }
          }
        } else {
          // New agent → snapshot ALL open threads from DB (not just live
          // customers). Persistence means an admin returning hours
          // later sees every unresolved chat, not just ones still in
          // someone's tab. Also broadcast agent_joined to every
          // currently-connected customer.
          try {
            const openThreads = db.listOpenSupportThreads({ limit: 200 });
            ws.send(JSON.stringify({
              type: 'inbox_snapshot',
              threads: openThreads.map(t => ({
                id: t.id,
                email: t.customer_email,
                name: t.customer_name,
                tier: t.customer_tier,
                status: t.status,
                assignedAgent: t.assigned_agent_email,
                unread: t.unread_from_customer,
                lastText: t.last_message_text,
                lastRole: t.last_message_role,
                createdAt: t.created_at,
                lastCustomerAt: t.last_customer_message_at,
                lastAgentAt: t.last_agent_message_at,
                sla: db.computeSupportSlaState(t),
                initialQuestion: t.initial_question,
              })),
            }));
          } catch (e) {
            console.warn('[support/ws] inbox snapshot failed:', e.message);
          }
          for (const [, client] of supportClients) {
            if (client.type === 'customer' && client.ws.readyState === WebSocket.OPEN) {
              client.ws.send(JSON.stringify({ type: 'agent_joined', name: data.name || 'A support agent' }));
            }
          }
        }
      }

      if (data.type === 'message') {
        const sender = supportClients.get(clientId);
        if (!sender) {
          console.warn(`[support/ws/msg] DROPPED — no sender for clientId=${clientId} (incoming data.to=${data.to}, text="${String(data.text||'').slice(0,40)}")`);
          return;
        }
        sender.lastSeen = Date.now();
        const text = String(data.text || '').trim();
        if (!text) {
          console.warn(`[support/ws/msg] DROPPED — empty text from ${sender.type}=${sender.email}`);
          return;
        }
        console.log(`[support/ws/msg] IN  type=${sender.type} from=${sender.email} to=${data.to || '(broadcast)'} text="${text.slice(0,60)}"`);

        // ── Persist BEFORE live-broadcast ──
        // Order matters: if the broadcast fires and the recipient ACKs
        // before the DB write commits, we have a window where a refresh
        // would show no message. Persist first; broadcast carries the
        // DB id back so clients can dedup against optimistic UI.
        let inserted = null;
        try {
          if (sender.type === 'customer' && sender.threadId) {
            inserted = db.appendSupportMessage({
              thread_id: sender.threadId,
              sender_role: 'customer',
              sender_email: sender.email,
              sender_name: sender.name,
              text,
            });
          } else if (sender.type === 'agent' && data.to) {
            // Find the recipient's thread. We trust the agent client to
            // pass `to` as the customer email; resolve to thread id via
            // the live socket OR via findResumable (if the customer is
            // currently offline, they may not have an open WS but the
            // thread is still in the DB). Email matching is
            // case-INsensitive: supportClients now stores email lower-
            // cased on join, and we lowercase data.to here too, so a
            // Mixed-Case email from the admin's inbox matches the
            // canonical lowercase stored on the WS join.
            const toEmail = String(data.to).toLowerCase();
            let targetThreadId = null;
            for (const [, c] of supportClients) {
              if (c.type === 'customer' && c.email === toEmail && c.threadId) {
                targetThreadId = c.threadId; break;
              }
            }
            if (!targetThreadId) {
              const offlineThread = db.findResumableSupportThread(toEmail);
              if (offlineThread) targetThreadId = offlineThread.id;
            }
            if (targetThreadId) {
              inserted = db.appendSupportMessage({
                thread_id: targetThreadId,
                sender_role: 'agent',
                sender_email: sender.email,
                sender_name: sender.name,
                text,
              });
              // First agent reply auto-claims the thread + cancels the
              // escalation ladder. claimSupportThread is idempotent: a
              // second agent message by the same email is a no-op on
              // status, but a different agent's message returns
              // already_assigned (we still let the message through —
              // the customer hears them, the DB just remembers the
              // ORIGINAL claimer for routing).
              const claim = db.claimSupportThread(targetThreadId, sender.email);
              if (claim && claim.ok) {
                db.cancelSupportEscalations(targetThreadId);
              }
            }
          }
        } catch (e) {
          console.warn('[support/ws] persist failed:', e.message);
        }

        // ── Live route to opposite side ──
        if (sender.type === 'customer') {
          let agentCount = 0;
          for (const [, client] of supportClients) {
            if (client.type === 'agent' && client.ws.readyState === WebSocket.OPEN) {
              client.ws.send(JSON.stringify({
                type: 'message',
                id: inserted?.id || null,
                text,
                from: sender.email,
                name: sender.name,
                threadId: sender.threadId,
                at: inserted?.created_at || Date.now(),
              }));
              agentCount++;
            }
          }
          console.log(`[support/ws/msg] OUT customer→${agentCount} agents (persisted_id=${inserted?.id || 'NONE'})`);
        } else if (sender.type === 'agent' && data.to) {
          // Same lowercase-match rule as the persist branch above.
          const toEmail = String(data.to).toLowerCase();
          // Frame for the CUSTOMER — no `from` field; the renderer
          // assumes agent-side and the `name` is what the customer sees.
          const customerFrame = JSON.stringify({
            type: 'message',
            id: inserted?.id || null,
            text,
            name: sender.name,
            at: inserted?.created_at || Date.now(),
          });
          // Frame for OTHER AGENTS — carries `from` (customer email
          // the message is destined to) plus `threadId` so co-admin
          // tabs route it to the correct conversation in their inbox.
          // Without this, two admin tabs viewing the same thread would
          // diverge: only the sender's tab sees the message until they
          // refetch. The sender's OWN socket is skipped (it already
          // shows the message optimistically — re-broadcasting would
          // double-render).
          const agentFanoutFrame = JSON.stringify({
            type: 'message',
            id: inserted?.id || null,
            text,
            from: toEmail,
            agentFrom: sender.email,
            name: sender.name,
            threadId: inserted?.thread_id || null,
            at: inserted?.created_at || Date.now(),
            outbound: true,
          });
          let customerDelivered = 0;
          let agentFanout = 0;
          const sawCustomerEmails = [];
          const sawAgentEmails = [];
          for (const [id, client] of supportClients) {
            if (client.type === 'customer') sawCustomerEmails.push(`${client.email}(${client.ws.readyState})`);
            if (client.type === 'agent') sawAgentEmails.push(`${client.email}(${id===clientId?'SENDER':'other'},rs=${client.ws.readyState})`);
            if (client.ws.readyState !== WebSocket.OPEN) continue;
            if (client.type === 'customer' && client.email === toEmail) {
              client.ws.send(customerFrame);
              customerDelivered++;
            } else if (client.type === 'agent' && id !== clientId) {
              client.ws.send(agentFanoutFrame);
              agentFanout++;
            }
          }
          console.log(`[support/ws/msg] OUT agent→customer:${customerDelivered}, agent-fanout:${agentFanout}, persisted_id=${inserted?.id || 'NONE'}, target=${toEmail}, customers_in_map=[${sawCustomerEmails.join(', ')}], agents_in_map=[${sawAgentEmails.join(', ')}]`);
          if (customerDelivered === 0) {
            console.warn(`[support/ws/msg] ⚠ agent→customer delivered 0! target="${toEmail}". DB persist did${inserted ? '' : ' NOT'} succeed (thread_id=${inserted?.thread_id || 'n/a'}). Customer will only see this on their next reconnect via history replay.`);
          }
        }
      }

      // Mark-read signal: client viewed messages, server records the
      // read receipt so the OTHER side can show "Read 3:24 PM".
      if (data.type === 'mark_read') {
        const sender = supportClients.get(clientId);
        if (!sender) return;
        let targetThreadId = sender.threadId;
        if (!targetThreadId && sender.type === 'agent' && data.threadId) {
          // Agents don't have a per-connection threadId; they pass it
          // explicitly when viewing a specific customer's thread.
          targetThreadId = String(data.threadId);
        }
        if (targetThreadId) {
          try { db.markSupportMessagesRead(targetThreadId, sender.type); }
          catch (e) { console.warn('[support/ws] mark_read failed:', e.message); }
        }
      }

      // Heartbeat from agent client — refreshes presence so the
      // online-agents list stays accurate even on long-lived sockets.
      if (data.type === 'heartbeat') {
        const sender = supportClients.get(clientId);
        if (sender?.type === 'agent') {
          try { db.heartbeatSupportAgent(sender.email); } catch { /* non-fatal */ }
        }
      }

      // Typing indicator — ephemeral, NOT persisted. Server just relays
      // {type:'typing', isTyping:bool} to the opposite side. Debouncing
      // is the client's job.
      if (data.type === 'typing') {
        const sender = supportClients.get(clientId);
        if (!sender) return;
        const payload = { type: 'typing', isTyping: !!data.isTyping, from: sender.email, name: sender.name };
        if (sender.type === 'customer') {
          for (const [, c] of supportClients) {
            if (c.type === 'agent' && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(payload));
          }
        } else if (sender.type === 'agent' && data.to) {
          const toEmail = String(data.to).toLowerCase();
          for (const [, c] of supportClients) {
            if (c.type === 'customer' && c.email === toEmail && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(payload));
          }
        }
      }
    } catch {}
  });

  // Heartbeat ack — clears the pingPending flag so the sweeper knows this
  // socket is alive. ws library fires 'pong' for both server-initiated pings
  // and client-initiated ones.
  ws.on('pong', () => {
    if (!clientId) return;
    const c = supportClients.get(clientId);
    if (c) { c.pingPending = false; c.lastSeen = Date.now(); }
  });

  ws.on('close', () => {
    if (clientId) {
      const client = supportClients.get(clientId);
      if (client) {
        // Notify agents when customer disconnects
        if (client.type === 'customer') {
          for (const [, c] of supportClients) {
            if (c.type === 'agent' && c.ws.readyState === WebSocket.OPEN) {
              c.ws.send(JSON.stringify({ type: 'customer_left', email: client.email }));
            }
          }
        }
      }
      supportClients.delete(clientId);
    }
  });
});

// Sweeper: every PING_INTERVAL we ping every open socket and evict anything
// that (a) didn't pong from the previous tick or (b) crossed the idle
// threshold. Without this, half-open sockets (firewall dropped, no FIN/RST
// reaches us) sit in supportClients forever, waste memory, and broadcast to
// dead recipients. Single setInterval, cleaned up on server close.
const supportSweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, c] of supportClients) {
    if (!c.ws || c.ws.readyState !== WebSocket.OPEN) {
      supportClients.delete(id);
      continue;
    }
    // Idle close — user walked away, conversation effectively over.
    if (now - c.lastSeen > SUPPORT_IDLE_MS) {
      try { c.ws.close(4001, 'Idle timeout'); } catch {}
      supportClients.delete(id);
      continue;
    }
    // Heartbeat — last ping was never answered. Treat as dead.
    if (c.pingPending) {
      try { c.ws.terminate(); } catch {}
      supportClients.delete(id);
      continue;
    }
    // Issue a fresh ping. ws.ping() sends an opcode 0x9 frame and the client
    // library handles the pong automatically; no app-level support needed.
    c.pingPending = true;
    try { c.ws.ping(); } catch {
      supportClients.delete(id);
    }
  }
}, SUPPORT_PING_INTERVAL_MS);

// Stop the sweeper on server shutdown so test suites and graceful restarts
// don't leak the interval into the next process.
wss.on('close', () => {
  clearInterval(supportSweeper);
});
