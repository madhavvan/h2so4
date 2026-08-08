// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  "IMMEDIATE AND PERMANENT" HAS TO INCLUDE THE COPY IN MEMORY.
//
//  services/contextStore.js holds the uploaded knowledge base — résumé,
//  job description, notes — in memory for up to 3 hours so the client can
//  send a hash instead of 400KB on every question. deleteUser() emptied
//  the SQLite rows and left that copy sitting there, so an account
//  deleted under a policy promising immediate deletion kept its résumé
//  readable server-side for the rest of the TTL.
//
//  The purge lives inside deleteUser rather than at the four call sites
//  (routes/auth.js delete-account, routes/admin.js, and both botTools.js
//  paths) precisely so a fifth caller cannot forget it — so that is the
//  property under test, not "some route happens to call forgetUser".
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

process.env.JWT_SECRET = 'test-secret-deletion-purge';
process.env.DATABASE_PATH = ':memory:';

const db = require('../src/database.js');
const contextStore = require('../src/services/contextStore.js');

const RESUME = 'Venu Madhav — Senior Data Engineer. Meridian Health, 41-billion-row Postgres → Aurora migration.';

let seq = 0;
function makeUser() {
  const email = `deleteme${++seq}@example.com`;
  const id = `u_del_${seq}`;
  db.createUser({ id, email, name: 'Delete Me', password: 'a-password-long-enough', tier: 'free', country_code: 'US' });
  return { id, email };
}

beforeEach(() => { contextStore._test._reset(); });

describe('deleteUser purges the in-memory context cache', () => {
  it('drops the deleted account’s knowledge base', () => {
    const user = makeUser();
    const hash = contextStore.sha256(RESUME);
    contextStore.put(user.id, RESUME, hash);
    expect(contextStore.get(user.id, hash)).toBe(RESUME);

    expect(db.deleteUser(user.id)).toBe(true);

    // The whole point: not "expires eventually", gone now.
    expect(contextStore.get(user.id, hash)).toBeFalsy();
  });

  it('leaves every other account’s cache alone', () => {
    const doomed = makeUser();
    const bystander = makeUser();
    const hash = contextStore.sha256(RESUME);
    contextStore.put(doomed.id, RESUME, hash);
    contextStore.put(bystander.id, RESUME, hash);

    db.deleteUser(doomed.id);

    expect(contextStore.get(doomed.id, hash)).toBeFalsy();
    expect(contextStore.get(bystander.id, hash)).toBe(RESUME);
  });

  it('returns the byte budget, not just the entry', () => {
    // A purge that unlinked the key but left `totalBytes` charged would
    // leak capacity on every deletion until the process restarted.
    const user = makeUser();
    contextStore.put(user.id, RESUME, contextStore.sha256(RESUME));
    const before = contextStore.stats();
    expect(before.entries).toBe(1);
    expect(before.users).toBe(1);
    expect(before.totalBytes).toBeGreaterThan(0);

    db.deleteUser(user.id);

    const after = contextStore.stats();
    expect(after.entries).toBe(0);
    expect(after.users).toBe(0);   // the per-user counter is released too
    expect(after.totalBytes).toBe(0);
  });

  it('deletes the account even if the purge itself fails', () => {
    // Cache eviction must never be able to block a deletion. The account
    // is already gone from SQLite by the time the purge runs; throwing
    // here would report a completed deletion as a failure.
    const user = makeUser();
    const realForget = contextStore.forgetUser;
    contextStore.forgetUser = () => { throw new Error('simulated cache failure'); };
    try {
      expect(() => db.deleteUser(user.id)).not.toThrow();
      expect(db.getUserByEmail(user.email)).toBeFalsy();
    } finally {
      contextStore.forgetUser = realForget;
    }
  });

  it('is a no-op for a user who never uploaded anything', () => {
    const user = makeUser();
    expect(() => db.deleteUser(user.id)).not.toThrow();
    expect(db.getUserByEmail(user.email)).toBeFalsy();
  });

  it('does nothing at all when the account does not exist', () => {
    const user = makeUser();
    const hash = contextStore.sha256(RESUME);
    contextStore.put(user.id, RESUME, hash);

    // deleteUser returns false without touching anything for an unknown
    // id — a purge that ran before that check could evict a live user's
    // cache on a typo'd admin call.
    expect(db.deleteUser('u_does_not_exist')).toBe(false);
    expect(contextStore.get(user.id, hash)).toBe(RESUME);
  });
});
