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

const app = express();
const PORT = process.env.PORT || 4000;

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
// Strict auth rate limiter (prevent brute force)
const authLimiter = new RateLimiterMemory({ points: 10, duration: 300 }); // 10 attempts per 5 min

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

    next();
  } catch {
    res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
});

// ── Routes ──
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/license', licenseRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/ai', aiRoutes);

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', service: 'minicaai-api' });
});

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

app.listen(PORT, () => {
  console.log(`minicaai API running on port ${PORT}`);
  console.log(`Database initialized`);
});
