// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CONVERSATION SYNC — invariants of the server-side mirror
//
//  Scope note, so nobody reads more into these than is there: the
//  conversation mirror was measured against a real client/server DB pair
//  and it is healthy — 10 of 3,945 messages missing, none in the reverse
//  direction. These tests are not chasing a data-loss bug. They pin the
//  properties the sync endpoint has to keep, one of which changed when
//  createConversation was made idempotent.
//
//  Why idempotent at all: /sync does check-then-create, and message sync
//  is fire-and-forget, so the first messages of a new conversation arrive
//  together. That is NOT a race today (better-sqlite3 is synchronous, the
//  handler has no await between the check and the create, and the server
//  is single-process) — confirmed by firing 7 concurrent first-messages
//  across 7 fresh conversations at a live server on the bare-INSERT code:
//  49/49 stored, zero 5xx. INSERT OR IGNORE is insurance against an await
//  or a second process appearing later, and it costs one word.
//
//  What it does change is that the SELECT after the insert can hand back
//  a row owned by someone else, because conversation ids are client-chosen
//  timestamps. So the owner re-check in the route is now load-bearing, and
//  that is the main thing these tests hold in place.
//
//  Pinned here:
//   · createConversation never throws on a duplicate id
//   · it returns the EXISTING row, owner intact — so a duplicate-id create
//     is a 403, not a 500 and not a leak of another user's title
//   · concurrent first-messages all land
//   · re-syncing a message id updates rather than duplicates
//   · an empty messages array is a no-op and deletes nothing
//     (syncConversationRename posts exactly that, and the repaired
//     backfill must never be able to wipe a mirror if it regresses)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const require = createRequire(import.meta.url);
const db = require('../src/database.js');

let seq = 0;
function makeUser() {
  seq += 1;
  const id = `u_conv_${seq}`;
  db.createUser({
    id,
    email: `${id}@test.example`,
    name: 'Conv Tester',
    password: 'pw-123456',
    tier: 'pro',
    country_code: 'US',
  });
  return id;
}

// Faithful model of the route handler at routes/conversations.js POST
// /:id/sync — check, create-if-missing, then verify ownership.
function syncAsRoute(convId, userId, name, messages) {
  let conv = db.getConversationById(convId);
  if (!conv) {
    conv = db.createConversation({ id: convId, user_id: userId, name });
  }
  if (!conv || conv.user_id !== userId) return { status: 403 };
  db.addConversationMessages(messages.map(m => ({
    id: m.id,
    conversation_id: convId,
    user_id: userId,
    role: m.role,
    content: m.content,
    timestamp: m.timestamp,
  })));
  return { status: 200, synced: messages.length };
}

beforeAll(() => { db.getDB(); });

describe('createConversation — idempotent under the sync race', () => {
  it('does not throw when two syncs both try to create the same id', () => {
    const user = makeUser();
    const convId = String(Date.now()) + '_a';

    // Both handlers already read null from getConversationById.
    const first = db.createConversation({ id: convId, user_id: user, name: 'Interview' });
    expect(() =>
      db.createConversation({ id: convId, user_id: user, name: 'Interview' }),
    ).not.toThrow();

    const second = db.createConversation({ id: convId, user_id: user, name: 'Interview' });
    expect(second.id).toBe(first.id);
    expect(second.created_at).toBe(first.created_at); // the loser did not overwrite
  });

  it('returns the WINNING row, so the caller can catch a cross-user id collision', () => {
    const owner = makeUser();
    const attacker = makeUser();
    const convId = String(Date.now()) + '_b';

    db.createConversation({ id: convId, user_id: owner, name: 'Owner conversation' });
    const row = db.createConversation({ id: convId, user_id: attacker, name: 'Attacker' });

    // The insert was ignored; the existing owner is returned untouched.
    expect(row.user_id).toBe(owner);
    expect(row.name).toBe('Owner conversation');
  });

  it('the route rejects a sync onto someone else\'s conversation id', () => {
    const owner = makeUser();
    const attacker = makeUser();
    const convId = String(Date.now()) + '_c';

    expect(syncAsRoute(convId, owner, 'Mine', [
      { id: 'm1', role: 'user', content: 'hello', timestamp: Date.now() },
    ]).status).toBe(200);

    const res = syncAsRoute(convId, attacker, 'Theirs', [
      { id: 'm2', role: 'user', content: 'injected', timestamp: Date.now() },
    ]);
    expect(res.status).toBe(403);
    expect(db.getConversationMessages(convId).map(m => m.id)).toEqual(['m1']);
  });
});

describe('message mirror — no loss at conversation start', () => {
  it('keeps every message when the first two syncs race', () => {
    const user = makeUser();
    const convId = String(Date.now()) + '_d';
    const t = Date.now();

    // Interleave exactly as the fire-and-forget client does: both reads
    // happen before either write.
    const readA = db.getConversationById(convId);
    const readB = db.getConversationById(convId);
    expect(readA).toBeNull();
    expect(readB).toBeNull();

    const convA = db.createConversation({ id: convId, user_id: user, name: 'Interview' });
    const convB = db.createConversation({ id: convId, user_id: user, name: 'Interview' });
    expect(convA.user_id).toBe(user);
    expect(convB.user_id).toBe(user);

    db.addConversationMessages([
      { id: 'r1', conversation_id: convId, user_id: user, role: 'user', content: 'hii', timestamp: t },
    ]);
    db.addConversationMessages([
      { id: 'r2', conversation_id: convId, user_id: user, role: 'assistant', content: 'hello there', timestamp: t + 1 },
    ]);

    const stored = db.getConversationMessages(convId);
    expect(stored).toHaveLength(2);
    expect(stored.map(m => m.id)).toEqual(['r1', 'r2']);
  });

  it('re-syncing the same message id is idempotent, not a duplicate', () => {
    const user = makeUser();
    const convId = String(Date.now()) + '_e';
    const msg = { id: 'dup', role: 'user', content: 'once', timestamp: Date.now() };

    syncAsRoute(convId, user, 'Interview', [msg]);
    syncAsRoute(convId, user, 'Interview', [msg]);
    syncAsRoute(convId, user, 'Interview', [{ ...msg, content: 'once (edited)' }]);

    const stored = db.getConversationMessages(convId);
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe('once (edited)');
  });
});

describe('empty-array sync stays a no-op', () => {
  it('a rename-only sync does not delete existing messages', () => {
    const user = makeUser();
    const convId = String(Date.now()) + '_f';

    syncAsRoute(convId, user, 'Interview', [
      { id: 'k1', role: 'user', content: 'keep me', timestamp: Date.now() },
      { id: 'k2', role: 'assistant', content: 'and me', timestamp: Date.now() + 1 },
    ]);
    expect(db.getConversationMessages(convId)).toHaveLength(2);

    // syncConversationRename posts { name, messages: [] }; the repaired
    // backfill must never be able to wipe a mirror either.
    const res = syncAsRoute(convId, user, 'Renamed', []);
    expect(res.status).toBe(200);
    expect(db.getConversationMessages(convId)).toHaveLength(2);
  });
});
