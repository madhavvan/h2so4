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
    // Block everything else in production
    if (process.env.NODE_ENV === 'production') return callback(new Error('CORS blocked'));
    // Allow all in development
    callback(null, true);
  },
  credentials: true,
}));

// Stripe webhooks need raw body — must be BEFORE express.json()
app.use('/api/v1/webhooks', webhookRoutes);

app.use(express.json({ limit: '10mb' }));

// ── Rate limiting ──
const { RateLimiterMemory } = require('rate-limiter-flexible');

// General rate limiter
const generalLimiter = new RateLimiterMemory({ points: 60, duration: 60 });
// Strict auth rate limiter (prevent brute force on login/signup)
const authLimiter = new RateLimiterMemory({ points: 10, duration: 300 }); // 10 attempts per 5 min
// Very strict forgot-password limiter — prevents mass email spam and
// bill-bombing on transactional mail providers. 5 requests / 15 min / IP.
const forgotPasswordLimiter = new RateLimiterMemory({ points: 5, duration: 900 });

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

const FALLBACK_VERSION = {
  version: '3.3.5',
  minVersion: '2.0.0',
  releaseDate: '2026-04-14',
  releaseNotes: 'Performance improvements and bug fixes',
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LIVE SUPPORT CHAT (WebSocket)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server, path: '/ws/support' });

// Track connected clients: customers and agents
const supportClients = new Map(); // sessionId -> { ws, type: 'customer'|'agent', email, name }

wss.on('connection', (ws) => {
  let clientId = null;

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);

      if (data.type === 'join') {
        clientId = `${data.role || 'customer'}_${data.user || Date.now()}`;
        supportClients.set(clientId, {
          ws,
          type: data.role || 'customer',
          email: data.user,
          name: data.name || 'User'
        });
        console.log(`Support chat: ${data.name || data.user} connected as ${data.role || 'customer'}`);

        // Notify agents of new customer
        if (data.role !== 'agent') {
          for (const [, client] of supportClients) {
            if (client.type === 'agent' && client.ws.readyState === WebSocket.OPEN) {
              client.ws.send(JSON.stringify({ type: 'customer_joined', email: data.user, name: data.name }));
            }
          }
        }
      }

      if (data.type === 'message') {
        const sender = supportClients.get(clientId);
        if (!sender) return;

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
