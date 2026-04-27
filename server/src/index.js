// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MINICO API SERVER
//  Stripe payments, license validation, geo-enforcement, admin
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const database = require('./database');

const authRoutes = require('./routes/auth');
const paymentRoutes = require('./routes/payments');
const licenseRoutes = require('./routes/license');
const webhookRoutes = require('./routes/webhooks');
const adminRoutes = require('./routes/admin');
const aiRoutes = require('./routes/ai');
const conversationRoutes = require('./routes/conversations');

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
// is hitting. Remove or guard before production.
app.use((req, res, next) => {
  console.log(`[req] ${req.method} ${req.originalUrl}`);
  next();
});

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
// thousands of dollars in inference. 60/min/user covers heavy interview use
// (≈1 call/sec sustained) without exposing the cost ceiling.
const aiLimiter = new RateLimiterMemory({ points: 60, duration: 60 });

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
            if (payload && payload.user_id) aiKey = `u:${payload.user_id}`;
          }
        }
      } catch { /* fall back to IP */ }
      try {
        await aiLimiter.consume(aiKey);
      } catch {
        return res.status(429).json({ error: 'AI rate limit reached. Slow down and try again in a minute.' });
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
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/ai', aiRoutes);
app.use('/api/v1/conversations', conversationRoutes);

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', service: 'minicaai-api' });
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
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/madhavvan/h2so4/releases/latest';
const VERSION_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Bump this on every release. If GitHub is unreachable AND the in-memory
// cache is cold (server just restarted), every running 3.4.3 client would
// otherwise get told "latest is 3.3.5" and see a misleading downgrade prompt.
// MUST match the package.json version that's currently being released —
// pointing at a version that doesn't have a GitHub release yet would make
// every client see an "update available" prompt for a phantom release.
const FALLBACK_VERSION = {
  version: '3.4.3',
  minVersion: '2.0.0',
  releaseDate: '2026-04-26',
  releaseNotes: 'Admin portal polish, conversation sync retry queue, voice/auto-type stability fixes, support WebSocket hardening',
  downloadUrl: {
    windows: 'https://github.com/madhavvan/h2so4/releases/latest/download/InterviewCopilot-Setup.exe',
    // x64 DMG works on all Macs (Apple Silicon runs it under Rosetta). When
    // we add per-arch detection client-side we can offer arm64 directly.
    mac: 'https://github.com/madhavvan/h2so4/releases/latest/download/InterviewCopilot-Mac-x64.dmg',
    linux: 'https://github.com/madhavvan/h2so4/releases/latest/download/InterviewCopilot-Linux.AppImage',
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

// Simple semver comparison: returns -1 if a < b, 0 if equal, 1 if a > b
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LIVE SUPPORT CHAT (WebSocket)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server, path: '/ws/support' });

// Track connected clients: customers and agents.
// `lastSeen` powers the idle sweeper; `pingPending` lets the heartbeat
// detect dead-but-not-closed sockets (firewall NAT timeout, broken Wi-Fi
// where TCP FIN never lands) that would otherwise leak forever.
const supportClients = new Map(); // sessionId -> { ws, type, email, name, lastSeen, pingPending }

// Tunables. 30-min idle close matches typical support-chat patience; ping
// every 60s is well under common 2-min NAT timeouts. MAX_PER_USER prevents
// a flapping client from inflating the map without bound.
const SUPPORT_IDLE_MS = 30 * 60 * 1000;
const SUPPORT_PING_INTERVAL_MS = 60 * 1000;
const SUPPORT_MAX_PER_USER = 1; // one active connection per email

// Helper: find any existing connection for the same logical user (same
// role + email). Used to evict the older session when a new one joins, so
// reconnect storms don't accumulate stale entries.
function findExistingClientId(role, email) {
  if (!email) return null;
  for (const [id, c] of supportClients) {
    if (c.type === role && c.email === email) return id;
  }
  return null;
}

wss.on('connection', (ws) => {
  let clientId = null;

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);

      if (data.type === 'join') {
        const role = data.role || 'customer';
        const email = data.user || `anon_${Date.now()}`;

        // Per-user cap: if this user already has an active connection, evict
        // the older one. Mirrors how mobile apps handle reconnect — newest
        // wins, the orphan socket gets a clean close instead of lingering.
        if (SUPPORT_MAX_PER_USER === 1) {
          const existing = findExistingClientId(role, email);
          if (existing) {
            const prev = supportClients.get(existing);
            try { prev.ws.close(4000, 'Replaced by newer connection'); } catch {}
            supportClients.delete(existing);
          }
        }

        clientId = `${role}_${email}`;
        supportClients.set(clientId, {
          ws,
          type: role,
          email,
          name: data.name || 'User',
          lastSeen: Date.now(),
          pingPending: false,
        });
        console.log(`Support chat: ${data.name || email} connected as ${role}`);

        // Notify agents of new customer
        if (role !== 'agent') {
          for (const [, client] of supportClients) {
            if (client.type === 'agent' && client.ws.readyState === WebSocket.OPEN) {
              client.ws.send(JSON.stringify({ type: 'customer_joined', email, name: data.name }));
            }
          }
        }
      }

      if (data.type === 'message') {
        const sender = supportClients.get(clientId);
        if (!sender) return;
        sender.lastSeen = Date.now();

        // Route message: customer->agents, agent->specific customer
        if (sender.type === 'customer') {
          // Send to all agents
          for (const [, client] of supportClients) {
            if (client.type === 'agent' && client.ws.readyState === WebSocket.OPEN) {
              client.ws.send(JSON.stringify({ type: 'message', text: data.text, from: sender.email, name: sender.name }));
            }
          }
        } else if (sender.type === 'agent' && data.to) {
          // Send to specific customer
          for (const [, client] of supportClients) {
            if (client.type === 'customer' && client.email === data.to && client.ws.readyState === WebSocket.OPEN) {
              client.ws.send(JSON.stringify({ type: 'message', text: data.text }));
            }
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
