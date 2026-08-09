// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  A SERVER-SIDE GATE MUST NOT REFUSE A CLIENT THAT CANNOT READ IT.
//
//  `requireActiveSession` guards every /chat/* and /stream/* route: no live
//  usage session -> 428 session_required. Correct policy — it closes a real
//  free ride, where a user with the mic off was answered but never charged.
//
//  It is also, deployed naively, an outage. Grep v4.0.18's
//  services/aiProxyService.ts and App.tsx for "428" or "session_required"
//  and you find NEITHER. To every install in the field on the day this
//  ships, the gate is not "start your session" — it is the assistant going
//  dead in the middle of an interview.
//
//  The same reasoning applies to the LLM cover: runCover is AWAITED before
//  the main model, so firing it for a client that renders no opener is
//  measured dead air (1198ms on a system_design question) in front of an
//  answer that was already ready — the "sometimes taking time to give the
//  answer" complaint, re-created by the change meant to fix it.
//
//  ── THESE TESTS CALL THE GATE. THEY DO NOT GREP FOR IT. ──
//  The first version of this file asserted the regex of an inline version
//  check, and broke the instant that check moved into shared middleware —
//  with behaviour byte-for-byte identical. A test that fails on a refactor
//  it should not notice teaches people to edit the test, and that is how a
//  real regression eventually gets waved through. So the server half is
//  exercised by invoking the real middleware; only the CLIENT half is
//  source-asserted, because a renderer bundle cannot be imported here.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'session-gate-test';
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_EMAILS = 'admin@example.invalid';

const db = require('../src/database.js');
const { _test } = require('../src/routes/ai.js');
const { MIN_PROTOCOL_CLIENT, versionRank } = require('../src/middleware/clientVersion.js');

/** Drive the real middleware with a fake request; report what it decided. */
function runGate({ version, hasSession, email = 'user@example.invalid', id = 'u1' }) {
  const original = db.hasLiveUsageSession;
  db.hasLiveUsageSession = () => hasSession;
  try {
    const req = {
      user: { id, email },
      headers: version ? { 'x-app-version': version } : {},
    };
    let decided = null;
    const res = {
      status(code) { decided = { status: code }; return this; },
      json(body) { if (decided) decided.body = body; return this; },
    };
    let passed = false;
    _test.requireActiveSession(req, res, () => { passed = true; });
    return { passed, refusal: decided };
  } finally {
    db.hasLiveUsageSession = original;
  }
}

describe('the gate lets through clients that could not understand it', () => {
  it('a v4.0.18 client with no session is NOT refused', () => {
    const r = runGate({ version: '4.0.18', hasSession: false });
    expect(r.refusal, 'v4.0.18 cannot render a 428 — refusing it is a dead assistant').toBeNull();
    expect(r.passed).toBe(true);
  });

  it('a client sending NO version header is NOT refused', () => {
    // Nothing before the protocol existed sends one, so absent == old.
    const r = runGate({ version: null, hasSession: false });
    expect(r.refusal).toBeNull();
    expect(r.passed).toBe(true);
  });

  it('a malformed version is treated as old, not as modern', () => {
    // Failing the other way turns a bad header into an outage.
    for (const junk of ['', 'latest', 'v', 'abc', '4']) {
      const r = runGate({ version: junk, hasSession: false });
      expect(r.refusal, `"${junk}" must not be read as a modern client`).toBeNull();
    }
  });
});

// ── The gate is HELD BEHIND the cover on purpose (2026-08-08) ──
// Shipping 4.0.19 armed both at once and a user hit the consequence within
// the hour: the popout showed "Turn the mic on to start your session" while
// the mic WAS on, because the popout and the main window are two renderers
// fighting over one server-side session row. So SESSION_GATE_MIN_CLIENT is a
// release AHEAD of what ships, and these tests assert against IT, not against
// MIN_PROTOCOL_CLIENT — otherwise they would go green describing a gate that
// is not the one running.
const GATE_MIN = _test.SESSION_GATE_MIN_CLIENT;

describe('the gate is dormant for every client that currently exists', () => {
  it('is held at a version no shipped build reports', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(
      versionRank(GATE_MIN),
      `the session gate (${GATE_MIN}) must stay ahead of the shipped release ` +
        `(${pkg.version}) until the popout can no longer settle the main window's session`
    ).toBeGreaterThan(versionRank(pkg.version));
  });

  it('the current release is NOT refused, even with no live session', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const r = runGate({ version: pkg.version, hasSession: false });
    expect(r.passed, 'this is the regression a user reported mid-interview').toBe(true);
    expect(r.refusal).toBeNull();
  });
});

describe('the gate still does its job once a client reaches its threshold', () => {
  it(`a ${GATE_MIN} client with no session IS refused, with 428`, () => {
    const r = runGate({ version: GATE_MIN, hasSession: false });
    expect(r.passed).toBe(false);
    expect(r.refusal?.status).toBe(428);
    expect(r.refusal?.body?.error).toBe('session_required');
  });

  it('a newer client is also refused — the threshold is a floor, not a match', () => {
    const r = runGate({ version: '5.2.0', hasSession: false });
    expect(r.refusal?.status).toBe(428);
  });

  it('the same client WITH a live session passes', () => {
    const r = runGate({ version: GATE_MIN, hasSession: true });
    expect(r.passed).toBe(true);
    expect(r.refusal).toBeNull();
  });

  it('an admin is never gated, whatever they are running', () => {
    const r = runGate({ version: GATE_MIN, hasSession: false, email: 'admin@example.invalid' });
    expect(r.passed).toBe(true);
  });
});

describe('the gate fails OPEN', () => {
  it('a database error lets the request through rather than silencing the app', () => {
    // Worst case is a few unbilled answers. The alternative is an assistant
    // that dies mid-interview because a lookup hiccuped.
    const original = db.hasLiveUsageSession;
    db.hasLiveUsageSession = () => { throw new Error('db exploded'); };
    try {
      const req = { user: { id: 'u1', email: 'user@example.invalid' }, headers: { 'x-app-version': MIN_PROTOCOL_CLIENT } };
      let passed = false;
      const res = { status() { return this; }, json() { return this; } };
      _test.requireActiveSession(req, res, () => { passed = true; });
      expect(passed).toBe(true);
    } finally {
      db.hasLiveUsageSession = original;
    }
  });
});

describe('version ranking', () => {
  it('orders the releases that matter here', () => {
    expect(versionRank('4.0.18')).toBeLessThan(versionRank('4.0.19'));
    expect(versionRank('4.0.9')).toBeLessThan(versionRank('4.0.18')); // not string order
    expect(versionRank('4.0.19')).toBeLessThan(versionRank('4.1.0'));
    expect(versionRank('3.4.9')).toBeLessThan(versionRank('4.0.0'));
  });

  it('rejects junk rather than ranking it', () => {
    for (const junk of [undefined, null, '', 'latest', 'v', 'abc', '4']) {
      expect(versionRank(junk), `${JSON.stringify(junk)} must not rank`).toBeNull();
    }
  });

  it('tolerates a leading v and a missing patch', () => {
    // "4.1" once produced NaN, and NaN ranks as neither old nor new — it
    // slipped past the guard and was treated as MODERN.
    expect(versionRank('v4.0.19')).toBe(versionRank('4.0.19'));
    expect(versionRank('4.1')).toBe(versionRank('4.1.0'));
    expect(Number.isFinite(versionRank('4.1'))).toBe(true);
  });
});

describe('the client actually sends the version', () => {
  // Source-asserted of necessity: a renderer bundle cannot be imported into
  // a node test. A gate nobody triggers is invisible — if the header stops
  // being sent, every client looks old forever and enforcement silently
  // stops, which is the failure mode that looks most like success.
  const rendererBootstrap = readFileSync(join(ROOT, 'index.tsx'), 'utf8');
  const mainProcess = readFileSync(join(ROOT, 'electron', 'main.cjs'), 'utf8');

  it('the renderer stamps every /api/v1/ request from one place', () => {
    expect(rendererBootstrap).toMatch(/X-App-Version/);
    expect(rendererBootstrap).toMatch(/__APP_VERSION__/);
    expect(rendererBootstrap, 'scoping is what keeps the version out of Stripe/Google requests').toMatch(/\/api\/v1\//);
  });

  it('the main process stamps its own direct API calls', () => {
    // It uses Node's fetch (undici), which never touches Electron's session,
    // so neither the renderer patch nor a webRequest handler would cover it.
    expect(mainProcess).toMatch(/X-App-Version/);
    expect(mainProcess).toMatch(/app\.getVersion\(\)/);
  });

  it('neither patch overwrites a header a caller set deliberately', () => {
    for (const src of [rendererBootstrap, mainProcess]) {
      expect(src).toMatch(/has\('X-App-Version'\)/);
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE THRESHOLD MUST BE REACHABLE BY A BUILD THAT ACTUALLY SHIPS.
//
//  Every test above proves the gate behaves correctly ON EITHER SIDE of
//  MIN_PROTOCOL_CLIENT. None of them notice if NOTHING can ever be on the
//  modern side of it.
//
//  That is not hypothetical. Between 2026-08-08 06:42 and 14:05 the server
//  ran MIN_PROTOCOL_CLIENT='4.0.19' while the newest release, and
//  package.json, were 4.0.18. Every install in the world was therefore
//  classified "old", `requireActiveSession` called next() for everyone, and
//  runCover returned '' on every request — so the session gate AND the
//  entire cover engine were dormant fleet-wide while every test here passed
//  and the deploy looked healthy. clientVersion.js warns about exactly this
//  in its own comments ("Ship 4.0.18 with this set to 4.0.19 and every gate
//  stays dormant forever — silently, because 'not enforcing' looks exactly
//  like 'working'"), and the warning was not enough, because a comment
//  cannot fail a build.
//
//  So: the threshold is a promise that some shippable build can keep.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('the protocol threshold is reachable', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const { MIN_PROTOCOL_CLIENT, versionRank } = require('../src/middleware/clientVersion');

  it('this repo builds a client new enough to participate', () => {
    const shipped = versionRank(pkg.version);
    const required = versionRank(MIN_PROTOCOL_CLIENT);
    expect(shipped, `package.json version ${pkg.version} is unparseable`).not.toBeNull();
    expect(required, `MIN_PROTOCOL_CLIENT ${MIN_PROTOCOL_CLIENT} is unparseable`).not.toBeNull();
    expect(
      shipped,
      `package.json is ${pkg.version} but MIN_PROTOCOL_CLIENT is ${MIN_PROTOCOL_CLIENT}. ` +
        'A build cut from this tree would be classified "old" by the server, so the session ' +
        'gate and the LLM cover would BOTH stay dormant for every user — silently. Either ' +
        'bump the version before releasing, or lower MIN_PROTOCOL_CLIENT to the release that ' +
        'first sends x-app-version.'
    ).toBeGreaterThanOrEqual(required);
  });

  it('a client built from this tree is on the modern side of the gate', () => {
    // The end the gate actually reads: participatesInProtocol against the
    // version this repo would stamp into the header.
    const { participatesInProtocol } = require('../src/middleware/clientVersion');
    expect(participatesInProtocol({ headers: { 'x-app-version': pkg.version } })).toBe(true);
  });
});
