// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SUPPORT-BOT PRIVILEGE BOUNDARY — 50+ LLM-callable tools, no tests.
//
//  These tools issue refunds, delete accounts, revoke devices, change
//  tiers and read other people's data. What decides whether a caller may
//  invoke one is a single `role` string resolved from their session, and
//  the thing choosing which tool to call is a language model steered by
//  whatever the user typed into a support chat.
//
//  That is an unusual amount of authority to leave untested. The failure
//  mode is invisible in normal use: if the role gate broke, every
//  legitimate conversation would keep working exactly as before, and the
//  only sign would be someone talking the bot into an admin tool.
//
//  What is pinned here:
//    1. the gate is enforced at EXECUTION, not just by hiding schemas —
//       the model can emit any name it likes, including a hallucinated one
//    2. a non-admin cannot reach a single ADMIN_* tool, by name
//    3. anonymous and free callers get no tools at all
//    4. money- and account-destroying tools are flagged destructive, so
//       the step-up path that keys off that flag actually covers them
//    5. no tool name is registered twice under different categories
//
//  Pure registry + gate inspection. No handler is executed, so nothing
//  here can touch a database, a provider or a real account.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

process.env.JWT_SECRET = 'test-secret-bot-tools';
process.env.DATABASE_PATH = ':memory:';

const botTools = require('../src/services/botTools.js');
const { ALL_TOOLS, getToolNamesForRole, getToolMeta, executeTool } = botTools;

const namesIn = (...categories) =>
  Object.values(ALL_TOOLS).filter((t) => categories.includes(t.category)).map((t) => t.name);

const ADMIN_TOOL_NAMES = namesIn('ADMIN_SERVER', 'ADMIN_DESTRUCTIVE');
const USER_TOOL_NAMES = namesIn('USER_CLIENT', 'USER_SERVER');

const ctx = (role) => ({
  role,
  user: role === 'anonymous' ? null : { id: 'u_test', email: 'someone@example.com' },
  tier: role === 'admin' ? 'ultra' : 'pro',
  ip: '127.0.0.1',
  userAgent: 'vitest',
});

describe('the registry is coherent', () => {
  it('registers a meaningful number of tools across all four categories', () => {
    expect(Object.keys(ALL_TOOLS).length).toBeGreaterThan(40);
    for (const cat of ['USER_CLIENT', 'USER_SERVER', 'ADMIN_SERVER', 'ADMIN_DESTRUCTIVE']) {
      expect(namesIn(cat).length, `${cat} is empty`).toBeGreaterThan(0);
    }
  });

  it('gives every tool exactly one category and one name', () => {
    // register() throws on a duplicate name, so a collision would already
    // have exploded at import. This pins the invariant against someone
    // "fixing" that throw into a silent overwrite — where the LAST
    // registration wins and a user-category tool could quietly shadow an
    // admin one, or vice versa.
    const seen = new Set();
    for (const [name, tool] of Object.entries(ALL_TOOLS)) {
      expect(tool.name).toBe(name);
      expect(seen.has(name)).toBe(false);
      seen.add(name);
      expect(['USER_CLIENT', 'USER_SERVER', 'ADMIN_SERVER', 'ADMIN_DESTRUCTIVE']).toContain(tool.category);
      expect(typeof tool.handler).toBe('function');
      expect(typeof tool.description).toBe('string');
    }
  });
});

describe('which tools each role is even shown', () => {
  it('offers nothing to anonymous or free callers', () => {
    expect(getToolNamesForRole('anonymous')).toEqual([]);
    expect(getToolNamesForRole('free')).toEqual([]);
  });

  it('offers a signed-in user their own tools and no admin tool', () => {
    const offered = getToolNamesForRole('user');
    expect(offered.length).toBeGreaterThan(0);
    for (const name of ADMIN_TOOL_NAMES) {
      expect(offered, `admin tool ${name} was offered to a user`).not.toContain(name);
    }
  });

  it('offers an admin everything', () => {
    const offered = getToolNamesForRole('admin');
    for (const name of [...USER_TOOL_NAMES, ...ADMIN_TOOL_NAMES]) {
      expect(offered).toContain(name);
    }
  });

  it('treats an unrecognised role as no-tools rather than as admin', () => {
    // Fail closed. A typo'd or newly-added role string must not default
    // into the permissive branch.
    for (const role of ['', null, undefined, 'ADMIN', 'Admin', 'superuser', 'guest']) {
      expect(getToolNamesForRole(role), `role ${JSON.stringify(role)} was given tools`).toEqual([]);
    }
  });
});

describe('the gate is enforced at execution, not by hiding schemas', () => {
  // This is the property that matters. The model emits a tool NAME; it is
  // perfectly capable of emitting one it was never shown, either because
  // it hallucinated it or because a user described it. Filtering the
  // schema list is presentation. executeTool is the boundary.

  it('refuses every admin tool called with role=user', async () => {
    for (const name of ADMIN_TOOL_NAMES) {
      const res = await executeTool(name, {}, ctx('user'));
      expect(res.ok, `${name} executed for a plain user`).toBe(false);
      expect(res.reason).toMatch(/not available on your plan/i);
    }
  });

  it('refuses every admin tool called with role=free or anonymous', async () => {
    for (const role of ['free', 'anonymous']) {
      for (const name of ADMIN_TOOL_NAMES) {
        const res = await executeTool(name, {}, ctx(role));
        expect(res.ok, `${name} executed for ${role}`).toBe(false);
      }
    }
  });

  it('refuses even USER tools to anonymous and free callers', async () => {
    for (const role of ['free', 'anonymous']) {
      for (const name of USER_TOOL_NAMES) {
        const res = await executeTool(name, {}, ctx(role));
        expect(res.ok, `${name} executed for ${role}`).toBe(false);
      }
    }
  });

  it('refuses an unknown tool name without throwing', async () => {
    for (const bogus of ['definitely_not_a_tool', 'admin_delete_everything', '__proto__', 'constructor']) {
      const res = await executeTool(bogus, {}, ctx('admin'));
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/unknown tool/i);
    }
  });

  it('does not let a role of the wrong type slip past the gate', async () => {
    // `role === 'admin'` is an equality check; anything truthy-but-not-
    // equal must land in the closed branch, not the open one.
    for (const role of [true, 1, ['admin'], { role: 'admin' }, 'admin ']) {
      const res = await executeTool(ADMIN_TOOL_NAMES[0], {}, { ...ctx('user'), role });
      expect(res.ok, `role ${JSON.stringify(role)} reached an admin tool`).toBe(false);
    }
  });

  it('rejects unparseable arguments rather than passing them to a handler', async () => {
    const res = await executeTool(USER_TOOL_NAMES[0], '{not json', ctx('user'));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not valid JSON/i);
  });
});

describe('destructive tools are labelled as such', () => {
  // The step-up (password reauth) path keys off `destructive`. A tool
  // that moves money or ends an account and is NOT flagged skips that
  // check entirely — which is exactly how request_refund and
  // delete_my_account came to run on a model-attested confirmation.
  const MUST_BE_DESTRUCTIVE = [
    'request_refund',
    'delete_my_account',
  ];

  for (const name of MUST_BE_DESTRUCTIVE) {
    it(`${name} is flagged destructive`, () => {
      const meta = getToolMeta(name);
      expect(meta, `${name} is not registered`).toBeTruthy();
      expect(meta.destructive, `${name} is not flagged destructive`).toBe(true);
    });
  }

  it('flags every tool in the ADMIN_DESTRUCTIVE category', () => {
    const unflagged = namesIn('ADMIN_DESTRUCTIVE').filter((n) => !getToolMeta(n).destructive);
    expect(unflagged, `ADMIN_DESTRUCTIVE tools missing the flag: ${unflagged.join(', ')}`).toEqual([]);
  });

  it('flags anything whose name says it deletes, refunds or revokes', () => {
    // Catches a new tool added to a non-destructive category by habit.
    // Listed as an allowlist of known-safe reads so the assertion stays
    // meaningful rather than being weakened whenever it fires.
    // Each exception is a DECISION, recorded with its reason. The rule
    // for adding one: the tool's name matches the pattern but it either
    // mutates nothing, or admin.js deliberately does not stepUpOnly-gate
    // its REST equivalent — and the bot must not be stricter than the
    // console for the same action.
    const READ_ONLY_EXCEPTIONS = new Set([
      'preview_tier_change',      // pure projection, mutates nothing
      'check_refund_eligibility', // evaluates the policy, issues nothing
      'get_revoked_keys',         // a list; matches on "revoked" in the name only
      'send_password_reset',      // emails a link; admin.js does not stepUpOnly it
      'revoke_user_device',       // one device binding; admin.js does not stepUpOnly it
    ]);
    const suspicious = Object.values(ALL_TOOLS)
      .filter((t) => /(^|_)(delete|refund|revoke|cancel|reset|wipe|purge)/.test(t.name))
      .filter((t) => !READ_ONLY_EXCEPTIONS.has(t.name))
      .filter((t) => !t.destructive)
      .map((t) => `${t.name} [${t.category}]`);
    expect(
      suspicious,
      `these look destructive but are not flagged (add the flag, or add to READ_ONLY_EXCEPTIONS with a reason):\n  ${suspicious.join('\n  ')}`,
    ).toEqual([]);
  });
});

describe('getToolMeta does not leak beyond the boundary', () => {
  it('returns null for an unknown name instead of undefined-shaped junk', () => {
    expect(getToolMeta('no_such_tool')).toBeNull();
  });

  it('never hands back the handler itself', () => {
    // /reauth-execute consults this metadata to decide whether a captured
    // intent may run. Returning the live handler would let a caller with
    // a reference invoke it around the gate.
    for (const name of Object.keys(ALL_TOOLS)) {
      expect(Object.keys(getToolMeta(name))).toEqual(['name', 'category', 'description', 'destructive']);
    }
  });
});
