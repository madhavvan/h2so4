// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE SERVER MUST NOT START SAYING THINGS THE FLEET CANNOT HEAR.
//
//  This server updates in ninety seconds. The installed fleet updates over
//  days, and some of it never does. Every production incident in this repo
//  has been the same bug — a change written as though both halves ship
//  together:
//
//    2026-07-18  a feed URL baked into shipped builds pointed at a repo
//                that did not exist; nobody could download or update
//    2026-07-29  a partial deploy left client and server disagreeing;
//                reverted 14 minutes in
//    2026-08-08  requireActiveSession answered 428 to clients with no
//                handling for it — a dead assistant mid-interview
//    2026-08-08  the cover model ran for clients that render no opener:
//                ~1.2s of measured dead air per question, fleet-wide
//    2026-08-08  /google/poll demanded a handoff code the shipped client
//                does not send — Google sign-in impossible for everyone
//
//  Three of those were caught by hand, on one night, by reading diffs. That
//  does not scale and it does not survive the next change. So this is the
//  tripwire: it does not prove a change is safe — nothing static can — it
//  forces a human to answer one question at the moment the contract moves.
//
//  ── WHEN THIS FAILS, DO NOT JUST ADD THE CODE TO THE LIST ──
//  Ask: can the version of the app people are RUNNING TODAY do anything
//  sensible with this response? If not, one of these is required —
//
//    1. put it on a NEW endpoint (old clients never call it), or
//    2. gate it on req.clientAtLeast(...) so only clients that understand
//       it can receive it, or
//    3. keep the old response and add the new one alongside.
//
//  ...and THEN record it in CLEARED with the reason. The reason is the
//  point. A list of codes with no reasons is a list nobody re-reads.
//
//  ⚠️ Never version-gate a SECURITY control this way. The header is
//  spoofable, so an attacker would simply claim to be old and take the
//  weaker path. Gate availability and cost; never auth. (That is why the
//  OAuth handoff uses an operator flag plus a same-address check instead.)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES = join(HERE, '..', 'src', 'routes');

// ── What the version in the field was built against ──
// Captured from origin/main (== the server v4.0.18 shipped alongside).
// This is the contract with every install currently running. Do not edit it
// to make a test pass — it is a record of the past, not a wish.
const PRODUCTION = {
  'ai.js': ['gemini_quota_exceeded', 'no_time_remaining', 'tier_required', 'voice_unavailable'],
  'license.js': ['account_suspended', 'device_limit', 'license_expired', 'license_mismatch', 'license_revoked', 'version_expired'],
  'payments.js': ['charge_failed', 'no_pass', 'not_interview_day'],
  'usage.js': ['no_time_remaining', 'session_gone', 'tier_required'],
  'admin.js': ['refund_ineligible'],
  'auth.js': [],
  'webhooks.js': [],
  'support.js': [],
  'conversations.js': [],
};

// ── Added since, each with the reason it cannot hurt a v4.0.18 client ──
const CLEARED = {
  'ai.js': {
    session_required:
      'Version-gated. requireActiveSession returns next() unless the caller ' +
      'reports >= MIN_PROTOCOL_CLIENT, so a pre-4.0.19 install is never refused. ' +
      'Pinned behaviourally in session-gate-client-compat.test.js.',
    context_missing:
      'Unreachable without a ⟪CTX:…⟫ placeholder in the body, which only a ' +
      'context-store-aware client sends. Verified empirically: a 740KB plain ' +
      'inline body returns 200, never 409.',
    context_too_large:
      'Same gate as context_missing — the resolver returns the string untouched ' +
      'when it contains no placeholder, so no size check runs for old clients.',
  },
  'auth.js': {
    confirm_email_required: 'Only on DELETE /account, an endpoint that does not exist in production.',
    password_required: 'Only on DELETE /account, an endpoint that does not exist in production.',
    wrong_password: 'Only on DELETE /account, an endpoint that does not exist in production.',
  },
  'license.js': {
    entitlement_signing_not_configured:
      'Only on GET /entitlements, a new endpoint no shipped client calls. ' +
      'Deliberately 501 (not 500) so a future client reads it as "fall back to ' +
      'the older unsigned probe" rather than as an outage to retry forever.',
  },
  'admin.js': {
    refund_target_unresolved:
      'Admin-only (authMiddleware + adminOnly + stepUpOnly) on a manual refund, ' +
      'and it REPLACES a 500 — strictly better than what it supersedes. Worst ' +
      'case an admin sees a raw code on an action they can retry.',
  },
};

/** Machine-readable error codes a route file can emit. */
const CODE_RE = /error:\s*'([a-z][a-z0-9_]{3,})'/g;
function codesIn(file) {
  const src = readFileSync(join(ROUTES, file), 'utf8');
  const out = new Set();
  let m;
  while ((m = CODE_RE.exec(src))) out.add(m[1]);
  CODE_RE.lastIndex = 0;
  return out;
}

describe('every response shape the fleet could receive is accounted for', () => {
  for (const file of Object.keys(PRODUCTION)) {
    it(`routes/${file} says nothing new and unexplained`, () => {
      const known = new Set([...PRODUCTION[file], ...Object.keys(CLEARED[file] || {})]);
      const unexplained = [...codesIn(file)].filter((c) => !known.has(c)).sort();

      expect(
        unexplained,
        unexplained.length
          ? `\n\nroutes/${file} can now answer with ${unexplained.map((c) => `'${c}'`).join(', ')}, ` +
            'which the app people are running today has never seen.\n\n' +
            'Before adding it to CLEARED, make it safe:\n' +
            '  1. put it on a NEW endpoint (old clients never call it), or\n' +
            '  2. gate it on req.clientAtLeast(...) so only clients that can read it get it, or\n' +
            '  3. keep the old response and add the new one alongside.\n\n' +
            'Then record it in CLEARED with the reason it cannot hurt a shipped client.\n'
          : ''
      ).toEqual([]);
    });
  }

  it('the cleared list has a real reason for every entry', () => {
    // A reason of "" or "TODO" is how this decays into a rubber stamp.
    for (const [file, entries] of Object.entries(CLEARED)) {
      for (const [code, reason] of Object.entries(entries)) {
        expect(typeof reason, `${file}:${code} has no reason`).toBe('string');
        expect(reason.trim().length, `${file}:${code} reason is too short to be a reason`).toBeGreaterThan(40);
        expect(/^todo|^tbd|^n\/a/i.test(reason.trim()), `${file}:${code} reason is a placeholder`).toBe(false);
      }
    }
  });

  it('nothing in CLEARED is also claimed as production — that would hide a real change', () => {
    for (const [file, entries] of Object.entries(CLEARED)) {
      for (const code of Object.keys(entries)) {
        expect(
          PRODUCTION[file].includes(code),
          `${file}:${code} is in both lists; if production already emits it, it is not an addition`
        ).toBe(false);
      }
    }
  });

  it('the production baseline still describes something real', () => {
    // Guards against someone "fixing" a failure by emptying PRODUCTION.
    const total = Object.values(PRODUCTION).flat().length;
    expect(total, 'the production contract has been gutted').toBeGreaterThanOrEqual(17);
  });
});
