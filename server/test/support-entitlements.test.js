// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SUPPORT ENTITLEMENTS — what each plan actually gets
//
//  docs/public/TIERS.md promises:
//    · Free                      — scripted FAQ + handoff
//    · Basic / Pro / Max / Ultra / Enterprise — full AI chat
//    · "Every tier can hand off to a human at any time."
//
//  'ultra' was missing from AI_CHAT_TIERS in BOTH server/src/routes/
//  support.js and SupportBot.tsx, so the highest paid tier — the one with
//  unlimited everything — silently got the Free scripted FAQ instead of
//  the AI chat its plan sells. The two lists are separate copies (server
//  gates the endpoint, client hides the composer), so a tier missing from
//  either one is downgraded; this test pins them together.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function tiersFrom(file) {
  const src = readFileSync(path.join(repoRoot, file), 'utf8');
  const m = /const AI_CHAT_TIERS = new Set\(\[([^\]]*)\]\)/.exec(src);
  if (!m) throw new Error(`AI_CHAT_TIERS not found in ${file}`);
  return new Set(m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
}

// Every tier the billing layer can actually grant (routes/payments.js).
const GRANTABLE = ['free', 'basic', 'pro', 'max', 'ultra', 'enterprise'];
const PAID = ['basic', 'pro', 'max', 'ultra', 'enterprise'];

describe('AI chat entitlement matches the published plans', () => {
  const server = tiersFrom('server/src/routes/support.js');
  const client = tiersFrom('SupportBot.tsx');

  it('grants full AI chat to every PAID tier', () => {
    for (const tier of PAID) {
      expect(server.has(tier), `server denies AI chat to '${tier}'`).toBe(true);
    }
  });

  it("does not grant AI chat to 'free' (scripted FAQ is the plan)", () => {
    expect(server.has('free')).toBe(false);
  });

  it('includes ultra — the regression this test exists for', () => {
    // Ultra is granted by routes/payments.js with sessions_limit -1 and is
    // listed under "Full AI chat" in docs/public/TIERS.md.
    expect(server.has('ultra')).toBe(true);
  });

  it('includes enterprise — the top plan must not fall to the scripted FAQ', () => {
    // Same failure mode the Ultra case above was written for: a tier added
    // to billing but not to this list sells "priority support" and delivers
    // the Free scripted FAQ.
    expect(server.has('enterprise')).toBe(true);
  });

  it('server and client lists are identical', () => {
    // They are two hand-maintained copies. Drift silently downgrades a
    // paying customer on whichever side is missing the tier.
    expect([...server].sort()).toEqual([...client].sort());
  });

  it('contains no tier the billing layer cannot grant', () => {
    for (const tier of server) {
      expect(GRANTABLE, `'${tier}' is entitled but never granted`).toContain(tier);
    }
  });
});

describe('human handoff is available on every tier', () => {
  it('the handoff route carries no tier gate', () => {
    // The published promise is unconditional: "Every tier can hand off to a
    // human at any time." Enforced by absence — if someone later adds a
    // requireTier to this route, this fails and they have to decide
    // deliberately rather than by accident.
    const src = readFileSync(path.join(repoRoot, 'server/src/routes/support.js'), 'utf8');
    const start = src.indexOf("router.post('/handoff'");
    expect(start).toBeGreaterThan(-1);
    const handoff = src.slice(start, start + 2500);
    expect(handoff).not.toMatch(/requireTier|AI_CHAT_TIERS/);
  });
});
