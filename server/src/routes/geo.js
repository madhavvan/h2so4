// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GEO PROXY — server-side IP-geolocation for the web client
//
//  Why this exists
//  ───────────────
//  The frontend's geoService.detectLocation() used to hit
//  https://ipapi.co/json/ directly from the browser. That breaks two
//  ways in production:
//
//    1. CORS. ipapi.co claims to allow CORS on the free tier, but
//       once they rate-limit the caller they return 429s WITHOUT
//       Access-Control-Allow-Origin, so the browser swallows the
//       response and surfaces a noisy red CORS error in devtools.
//       User saw: "Access to fetch at 'https://ipapi.co/json/' from
//       origin 'http://localhost:3005' has been blocked by CORS policy"
//       repeatedly across every page load and tier-switch.
//
//    2. Rate-limit thrashing. Free-tier ipapi.co is 1k req/day per
//       IP. Multiple users behind the same NAT (school, office,
//       coffee shop) collectively burn this quota in minutes, after
//       which everyone on that IP falls back to timezone-only geo.
//
//  Routing the lookup through the server fixes both:
//    • Same-origin call (the frontend hits our own /api/v1/geo) so
//      no CORS contortions.
//    • The server caches per-client-IP for 10 minutes, so even
//      heavy SPA renders coalesce into one upstream call per IP.
//    • If ipapi.co fails, we degrade silently with timezone-only
//      data; the frontend never sees a 5xx.
//
//  Shape
//  ─────
//  Returns the same fields geoService.detectLocation expects (proxy
//  + hosting flags so the VPN detection heuristic still works). The
//  client side does its own threat_level computation, so we just
//  pass through the raw ipapi.co response (filtered to the keys we
//  actually use).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

'use strict';

const express = require('express');
const router = express.Router();

// Per-IP cache. Map<ip, { data, expiresAt }>. ipapi.co's data for a
// given IP doesn't change on a sub-day timescale, so 10 minutes is a
// generous freshness window that still amortises cost across a typical
// user session.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

// Hard cap on cache size — prevents an attacker from poisoning memory
// by spraying spoofed X-Forwarded-For headers (we trust Railway's
// proxy so req.ip is sanitised, but defence-in-depth). When we hit
// MAX_CACHE_ENTRIES we just bail out the oldest entry.
const MAX_CACHE_ENTRIES = 5000;

function cacheGet(ip) {
  const entry = cache.get(ip);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(ip);
    return null;
  }
  return entry.data;
}

function cacheSet(ip, data) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // Drop the oldest entry. Map preserves insertion order so .keys().next()
    // gives us the oldest key without scanning.
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(ip, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Quiet fallback when upstream fails — we never want the frontend to
// see a 5xx that bubbles up as a red error in the UI. Returns the
// shape geoService.detectLocation can consume; `country_code` defaults
// to US so the pricing service falls back to US pricing rather than
// crashing on undefined.
function fallbackResponse(ip) {
  return {
    ip: ip || 'unknown',
    country_code: 'US',
    country_name: 'Unknown',
    region: '',
    city: '',
    timezone: '',
    currency: 'USD',
    proxy: false,
    hosting: false,
    // Signal that this came from the fallback path so the client can
    // optionally trust browser-timezone-derived data over our defaults.
    _fallback: true,
  };
}

router.get('/', async (req, res) => {
  // Resolve the caller's IP. We trust the X-Forwarded-For chain because
  // Railway's edge proxy strips spoofed entries (app.set('trust proxy', 1)
  // in index.js); on localhost we just get 127.0.0.1.
  let ip = req.ip || req.connection?.remoteAddress || '';
  // Strip IPv6-mapped IPv4 prefix so cache keys collapse v4 + v6 forms.
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);

  // ipapi.co serves localhost requests back as their own IP, which
  // gives confusing dev-mode data. In non-prod we just return a safe
  // default rather than punching upstream for noise.
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.');
  if (isLocalhost && process.env.NODE_ENV !== 'production') {
    return res.json({
      ip,
      country_code: process.env.DEV_GEO_COUNTRY || 'US',
      country_name: process.env.DEV_GEO_COUNTRY === 'IN' ? 'India' : 'United States',
      region: '',
      city: '',
      timezone: process.env.DEV_GEO_COUNTRY === 'IN' ? 'Asia/Kolkata' : 'America/New_York',
      currency: process.env.DEV_GEO_COUNTRY === 'IN' ? 'INR' : 'USD',
      proxy: false,
      hosting: false,
      _dev: true,
    });
  }

  // Cache lookup.
  const cached = cacheGet(ip);
  if (cached) return res.json(cached);

  // Upstream call — ipapi.co. Honour the IP we want geolocated by
  // using the /<ip>/json/ form, which avoids ipapi inferring our
  // server's IP instead of the caller's. 3-second timeout so a
  // hanging upstream doesn't tie up the request.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);
  try {
    const url = `https://ipapi.co/${encodeURIComponent(ip)}/json/`;
    const upstream = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        // ipapi.co's free tier is rate-limited per source IP. Setting
        // a UA helps them not classify us as a generic bot scraper
        // and tarpit our requests.
        'User-Agent': 'minicaai-server/1.0 (+https://minicaai.com)',
      },
    });

    if (!upstream.ok) {
      // 429 / 5xx — fall back quietly rather than propagating the
      // error to the client.
      const fallback = fallbackResponse(ip);
      // Cache the fallback for a short window so we don't hammer
      // ipapi during a sustained outage. 60 seconds is enough to
      // shield the upstream without locking us into bad data too long.
      cache.set(ip, { data: fallback, expiresAt: Date.now() + 60_000 });
      return res.json(fallback);
    }

    const data = await upstream.json();
    // Only pass through the keys we actually use — keeps the wire
    // shape stable even if ipapi adds new fields, and avoids leaking
    // arbitrary upstream payloads (org names, asn, etc) back to the
    // browser.
    const filtered = {
      ip: data.ip || ip,
      country_code: data.country_code || 'US',
      country_name: data.country_name || 'Unknown',
      region: data.region || '',
      city: data.city || '',
      timezone: data.timezone || '',
      currency: data.currency || 'USD',
      proxy: data.proxy === true,
      hosting: data.hosting === true,
    };
    cacheSet(ip, filtered);
    return res.json(filtered);
  } catch (err) {
    // Network error / abort / parse error — all silent fallback.
    // Logged at warn level (not error) because this is a third-party
    // outage we can survive, not a server bug.
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[geo] upstream lookup failed:', err && err.message);
    }
    const fallback = fallbackResponse(ip);
    cache.set(ip, { data: fallback, expiresAt: Date.now() + 60_000 });
    return res.json(fallback);
  } finally {
    clearTimeout(timeoutId);
  }
});

module.exports = router;
