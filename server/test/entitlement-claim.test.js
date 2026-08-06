// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SIGNED ENTITLEMENT CLAIM — GET /api/v1/license/entitlements
//
//  Auto-Type is the Ultra-only feature at $159/mo, and it has to keep
//  working offline, so the Electron main process caches its entitlement for
//  seven days. That cache used to be {ok:true, at:...} in a JSON file under
//  userData — i.e. anyone with a text editor could grant themselves the
//  most expensive feature in the product for a week at a time, forever, by
//  refreshing the timestamp. This endpoint replaces that note with a proof:
//  an Ed25519 claim the app can VERIFY with an embedded public key and
//  cannot MINT, because the private half never leaves the server.
//
//  What the suite pins, in the order the security argument runs:
//    1. the signature actually protects the bytes — a tampered payload
//       (autoType flipped, sub swapped to another account) fails, and a
//       claim signed by any other key fails;
//    2. the verdict inside the claim is the SAME verdict requireTier('ultra')
//       reaches — every fixture is asserted against both, because drift
//       between them is the failure mode that makes a signed claim worse
//       than no claim at all (confidently wrong);
//    3. a server without ENTITLEMENT_PRIVATE_KEY answers 501, not 500, and
//       does not throw — the desktop app reads 501 as "fall back to the
//       older unsigned probe", so shipping the code before the key is set
//       must not brick a paying customer's Auto-Type.
//
//  Real router, real authMiddleware, real SQLite, real socket — same shape
//  as admin-stepup-e2e.test.js. The 501 path needs a module instance that
//  never saw the env var, so the router is loaded twice out of a purged
//  require cache and mounted at two prefixes on one app.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import crypto from 'node:crypto';

process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
// tier.js and admin.js both read ADMIN_EMAILS at require() time, so it has
// to be set before anything below is loaded.
process.env.ADMIN_EMAILS = 'ent.admin@minicaai.test';

const require = createRequire(import.meta.url);
const express = require('express');
const db = require('../src/database.js');
const { generateToken } = require('../src/middleware/auth.js');
// The gate itself, for the parity assertions.
const { requireTier } = require('../src/middleware/tier.js');

const SERVICE_PATH = '../src/services/entitlementClaim.js';
const ROUTER_PATH = '../src/routes/license.js';

// The public key literal that ships inside the desktop binary. Kept here as
// a wire-format canary: if the recipe the app uses to rebuild it ever stops
// working, this file says so before a release does.
const SHIPPED_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEA1I54O1cf6oxYxxuRVrFORRb0NZzchmPtodRI4Llqc/Y=';

// Throwaway pair, generated per run. A real private key must never sit in
// the repo — the entire premise of this endpoint is that only the server
// holds one.
const { publicKey: testPublicKey, privateKey: testPrivateKey } = crypto.generateKeyPairSync('ed25519');
const TEST_PRIVATE_KEY_B64 = testPrivateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

// Rebuild the verifying key exactly the way the desktop app does — from
// base64 SPKI DER, with no PEM in between.
const verifyKey = crypto.createPublicKey({
  key: testPublicKey.export({ format: 'der', type: 'spki' }),
  format: 'der',
  type: 'spki',
});

// THE verification. Note what is NOT here: any re-serialization of the
// decoded object. The signature covers the payload STRING as transmitted,
// so a verifier must check the characters it received and only afterwards
// decode them. Re-encoding a parsed object would depend on JSON key order
// and fail at random.
function verifyClaim(claim, pub = verifyKey) {
  return crypto.verify(
    null,
    Buffer.from(claim.payload, 'ascii'),
    pub,
    Buffer.from(claim.sig, 'base64url'),
  );
}

function decodeClaim(claim) {
  return JSON.parse(Buffer.from(claim.payload, 'base64url').toString('utf8'));
}

// Loads a FRESH router bound to a fresh copy of the signing service, and
// forces the service's lazy env parse immediately — while process.env is
// still in the state this router is supposed to have been deployed with.
// Without that nudge the unconfigured instance would parse lazily at
// request time, by which point the configured instance has already set the
// variable, and the 501 case would quietly become a 200.
function loadRouter() {
  delete require.cache[require.resolve(SERVICE_PATH)];
  delete require.cache[require.resolve(ROUTER_PATH)];
  const service = require(SERVICE_PATH);
  const router = require(ROUTER_PATH);
  return { router, service, configured: service.isConfigured() };
}

let server;
let base;
let unsigned;   // router loaded with no ENTITLEMENT_PRIVATE_KEY
let signed;     // router loaded with the throwaway key

const USERS = {
  ultra:   { id: 'ent_ultra',   email: 'ent.ultra@minicaai.test',   tier: 'ultra', status: 'active', expires_at: -1 },
  free:    { id: 'ent_free',    email: 'ent.free@minicaai.test',    tier: 'free',  status: 'trial',  expires_at: Date.now() + 30 * 86400000 },
  pro:     { id: 'ent_pro',     email: 'ent.pro@minicaai.test',     tier: 'pro',   status: 'active', expires_at: -1 },
  max:     { id: 'ent_max',     email: 'ent.max@minicaai.test',     tier: 'max',   status: 'active', expires_at: -1 },
  // Ultra row that outlived its cycle — a lost webhook leaves exactly this
  // shape, and requireTier calls it 'lapsed'.
  lapsed:  { id: 'ent_lapsed',  email: 'ent.lapsed@minicaai.test',  tier: 'ultra', status: 'active', expires_at: Date.now() - 86400000 },
  // Ultra row whose STATUS says the subscription ended.
  ended:   { id: 'ent_ended',   email: 'ent.ended@minicaai.test',   tier: 'ultra', status: 'expired', expires_at: Date.now() + 86400000 },
  // Admin, holding a deliberately worthless license, to prove the bypass.
  admin:   { id: 'ent_admin',   email: 'ent.admin@minicaai.test',   tier: 'free',  status: 'trial',  expires_at: Date.now() + 30 * 86400000 },
};

const tokens = {};

function url(path) { return `${base}${path}`; }

async function call(path, { token } = {}) {
  const res = await fetch(url(path), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, body: json, raw: text };
}

async function claimFor(who) {
  const r = await call('/api/v1/license/entitlements', { token: tokens[who] });
  expect(r.status).toBe(200);
  return r.body;
}

// What requireTier('ultra') — the gate actually mounted on /autotype-plan,
// /autotype-agent and /autotype-vision — would decide for this user, right
// now, driven through the real middleware with a stub res.
function gateSaysAllowed(user) {
  const req = { user: { id: user.id, email: user.email } };
  let allowed = false;
  const res = { status() { return this; }, json() { return this; } };
  requireTier('ultra')(req, res, () => { allowed = true; });
  return allowed;
}

beforeAll(async () => {
  // Order matters: the unconfigured instance must be built and pinned
  // BEFORE the env var exists anywhere in this process.
  delete process.env.ENTITLEMENT_PRIVATE_KEY;
  unsigned = loadRouter();

  process.env.ENTITLEMENT_PRIVATE_KEY = TEST_PRIVATE_KEY_B64;
  signed = loadRouter();

  const app = express();
  app.use(express.json());
  app.use('/api/v1/license', signed.router);
  app.use('/unsigned/api/v1/license', unsigned.router);
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  for (const [name, u] of Object.entries(USERS)) {
    db.createUser({
      id: u.id, email: u.email, name: `Ent ${name}`,
      password: 'entitlement-test-password', tier: u.tier, country_code: 'US',
    });
    db.createLicense({
      key: `LIC-${u.id}`, user_id: u.id, email: u.email,
      tier: u.tier, status: u.status, country_code: 'US',
      expires_at: u.expires_at, sessions_limit: -1,
    });
    tokens[name] = generateToken({ id: u.id, email: u.email, name: `Ent ${name}`, tier: u.tier });
  }

  // A signed-in account with no license row at all — the state a user is in
  // between an OAuth signup and the license write, and the one that must
  // report tier 'none' rather than crashing.
  db.createUser({
    id: 'ent_nolicense', email: 'ent.nolicense@minicaai.test', name: 'Ent Nolicense',
    password: 'entitlement-test-password', tier: 'free', country_code: 'US',
  });
  tokens.nolicense = generateToken({
    id: 'ent_nolicense', email: 'ent.nolicense@minicaai.test', name: 'Ent Nolicense', tier: 'free',
  });
});

afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

describe('the claim is a signature, not a decoration', () => {
  it('an Ultra claim verifies against the public key', async () => {
    const claim = await claimFor('ultra');
    expect(claim.alg).toBe('ed25519');
    expect(claim.v).toBe(1);
    expect(typeof claim.payload).toBe('string');
    expect(typeof claim.sig).toBe('string');
    // base64url on the wire — no '+', '/' or '=' to be mangled by a header,
    // a URL, or a shell that touches this on the way to disk.
    expect(claim.payload + claim.sig).not.toMatch(/[+/=]/);
    expect(verifyClaim(claim)).toBe(true);
  });

  it('a TAMPERED payload does not verify — the exact forgery this exists to stop', async () => {
    const claim = await claimFor('free');
    const original = decodeClaim(claim);
    expect(original.autoType).toBe(false);

    // The attack: take your own signed denial, flip it to a grant, keep the
    // signature. This is precisely what editing the old JSON cache did.
    const forged = { ...original, autoType: true, tier: 'ultra' };
    const forgedPayload = Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url');
    expect(verifyClaim({ payload: forgedPayload, sig: claim.sig })).toBe(false);

    // And the replay: someone else's Ultra claim, re-pointed at your id.
    const ultra = await claimFor('ultra');
    const stolen = { ...decodeClaim(ultra), sub: USERS.free.id };
    const stolenPayload = Buffer.from(JSON.stringify(stolen), 'utf8').toString('base64url');
    expect(verifyClaim({ payload: stolenPayload, sig: ultra.sig })).toBe(false);
  });

  it('a single flipped character breaks verification', async () => {
    const claim = await claimFor('ultra');
    const last = claim.payload.slice(-1);
    const mutated = claim.payload.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect(mutated).not.toBe(claim.payload);
    expect(verifyClaim({ payload: mutated, sig: claim.sig })).toBe(false);
  });

  it('a claim signed by a different key is worthless (the point of asymmetry)', async () => {
    const claim = await claimFor('ultra');
    const attacker = crypto.generateKeyPairSync('ed25519');
    const attackerSig = crypto
      .sign(null, Buffer.from(claim.payload, 'ascii'), attacker.privateKey)
      .toString('base64url');
    // The attacker holds the PUBLIC key (it is compiled into the binary they
    // own) and can sign anything they like with a key of their own. Neither
    // helps: verification is against OUR public key.
    expect(verifyClaim({ payload: claim.payload, sig: attackerSig })).toBe(false);
  });

  it('the public key literal shipped in the desktop binary rebuilds as ed25519', () => {
    // Pins the exact recipe main.cjs uses. If this ever throws, the client
    // cannot verify anything and Auto-Type dies silently in the field.
    const shipped = crypto.createPublicKey({
      key: Buffer.from(SHIPPED_PUBLIC_KEY_B64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    expect(shipped.asymmetricKeyType).toBe('ed25519');
  });

  it('claims from a test key do not verify under the shipped public key', async () => {
    // Belt to the braces above: the constant is a real, distinct key, not a
    // copy of whatever this process happens to be signing with.
    const shipped = crypto.createPublicKey({
      key: Buffer.from(SHIPPED_PUBLIC_KEY_B64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const claim = await claimFor('ultra');
    expect(verifyClaim(claim, shipped)).toBe(false);
  });
});

describe('the verdict inside the claim', () => {
  it('an active Ultra license grants Auto-Type', async () => {
    const p = decodeClaim(await claimFor('ultra'));
    expect(p.autoType).toBe(true);
    expect(p.tier).toBe('ultra');
  });

  it.each(['free', 'pro', 'max'])('a %s license does NOT grant Auto-Type', async (who) => {
    const claim = await claimFor(who);
    // A DENIAL IS STILL SIGNED AND STILL 200. That is what lets the client
    // positively drop a stale grant when a subscription ends, instead of
    // guessing whether a 403 meant "downgraded" or "token expired".
    expect(verifyClaim(claim)).toBe(true);
    const p = decodeClaim(claim);
    expect(p.autoType).toBe(false);
    expect(p.tier).toBe(USERS[who].tier);
  });

  it('an admin email grants Auto-Type regardless of their license row', async () => {
    const p = decodeClaim(await claimFor('admin'));
    expect(p.autoType).toBe(true);
    // The bypass does not rewrite the tier — the claim reports the live row
    // (free) alongside the grant, exactly as requireTier sees it.
    expect(p.tier).toBe('free');
  });

  it('a LAPSED ultra license does not grant Auto-Type', async () => {
    // tier still says ultra; expires_at is in the past. This is the shape a
    // lost cancellation webhook leaves behind, and the reason requireTier
    // checks expiry on top of tier.
    const p = decodeClaim(await claimFor('lapsed'));
    expect(p.autoType).toBe(false);
    expect(p.tier).toBe('ultra');
  });

  it('an ultra license whose status ended does not grant Auto-Type', async () => {
    const p = decodeClaim(await claimFor('ended'));
    expect(p.autoType).toBe(false);
    expect(p.tier).toBe('ultra');
  });

  it("a user with no license row reports tier 'none' and no Auto-Type", async () => {
    const claim = await claimFor('nolicense');
    expect(verifyClaim(claim)).toBe(true);
    const p = decodeClaim(claim);
    expect(p.autoType).toBe(false);
    expect(p.tier).toBe('none');
  });
});

describe('the claim cannot drift from the gate it speaks for', () => {
  // If these two ever disagree, one of them is lying to a paying customer.
  it.each(Object.keys(USERS))('%s: claim.autoType === requireTier("ultra") verdict', async (who) => {
    const p = decodeClaim(await claimFor(who));
    expect(p.autoType).toBe(gateSaysAllowed(USERS[who]));
  });

  it('no-license user: claim.autoType === requireTier("ultra") verdict', async () => {
    const p = decodeClaim(await claimFor('nolicense'));
    expect(p.autoType).toBe(gateSaysAllowed({ id: 'ent_nolicense', email: 'ent.nolicense@minicaai.test' }));
  });
});

describe('claim binding and lifetime', () => {
  it('sub is the CALLER user id — a claim for A cannot be replayed on B', async () => {
    const ultra = decodeClaim(await claimFor('ultra'));
    const pro = decodeClaim(await claimFor('pro'));
    expect(ultra.sub).toBe(USERS.ultra.id);
    expect(pro.sub).toBe(USERS.pro.id);
    expect(ultra.sub).not.toBe(pro.sub);
  });

  it('exp is in the future, seven days past iat', async () => {
    const before = Date.now();
    const p = decodeClaim(await claimFor('ultra'));
    expect(p.iat).toBeGreaterThanOrEqual(before - 1000);
    expect(p.exp).toBeGreaterThan(Date.now());
    expect(p.exp - p.iat).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('carries a version inside the signed payload', async () => {
    const p = decodeClaim(await claimFor('ultra'));
    expect(p.v).toBe(1);
  });

  it('requires authentication', async () => {
    const r = await call('/api/v1/license/entitlements');
    expect(r.status).toBe(401);
  });
});

describe('a server with no signing key degrades instead of breaking', () => {
  it('the unconfigured instance really is unconfigured', () => {
    expect(unsigned.configured).toBe(false);
    expect(signed.configured).toBe(true);
  });

  it('answers 501 (not 500) and does not throw', async () => {
    const r = await call('/unsigned/api/v1/license/entitlements', { token: tokens.ultra });
    // 501 is load-bearing: the desktop app treats it as "this server does
    // not do signed claims yet" and falls back to the older unsigned probe.
    // A 500 would look like an outage and Auto-Type would retry into it.
    expect(r.status).toBe(501);
    expect(r.body).toEqual({ error: 'entitlement_signing_not_configured' });
  });

  it('501 even for an Ultra user — never a partial or unsigned grant', async () => {
    const r = await call('/unsigned/api/v1/license/entitlements', { token: tokens.ultra });
    expect(r.status).toBe(501);
    expect(r.body.payload).toBeUndefined();
    expect(r.body.sig).toBeUndefined();
  });

  it('the signing service itself never throws at load with the var unset', () => {
    // The reason isConfigured() exists at all: an unset env var must degrade
    // a feature, not take the server down on boot.
    expect(() => unsigned.service.isConfigured()).not.toThrow();
    expect(unsigned.service.isConfigured()).toBe(false);
  });
});
