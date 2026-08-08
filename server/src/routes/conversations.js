// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CONVERSATIONS — Server-side chat history storage
//  Syncs from Electron/web client so data persists across devices
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const db = require('../database');

const router = express.Router();

// All conversation routes require auth
router.use(authMiddleware);

// ── A client-chosen message id is not proof of ownership ──
//
// conversation_messages.id is a GLOBAL primary key and its value comes from
// the CLIENT: both App.tsx and electron/database.cjs mint plain
// `Date.now().toString()`, so ids are guessable AND can collide between two
// users by accident. Every write below goes through INSERT OR REPLACE, so an
// id that already exists is overwritten in place — content, role,
// conversation_id and user_id all replaced. That means a caller who owns the
// CONVERSATION can still destroy a message belonging to somebody else, simply
// by naming their id. Owning the conversation says nothing about who owns the
// id, so the id has to be resolved separately before any write.
//
// Returns the subset of `ids` that already name a row this caller may not
// write: another user's message, or one of the caller's own messages sitting
// in a different conversation (re-parenting it would make it disappear from
// that conversation's history — the same data loss, self-inflicted). Every
// lookup is a primary-key hit, one statement per chunk.
const MESSAGE_ID_LOOKUP_CHUNK = 400; // SQLite's default variable cap is 999

function findUnwritableMessageIds(ids, userId, conversationId) {
  const blocked = new Set();
  const unique = [...new Set((ids || []).map(v => String(v)))];
  if (unique.length === 0) return blocked;

  const d = db.getDB();
  for (let i = 0; i < unique.length; i += MESSAGE_ID_LOOKUP_CHUNK) {
    const chunk = unique.slice(i, i + MESSAGE_ID_LOOKUP_CHUNK);
    const rows = d.prepare(
      `SELECT id FROM conversation_messages
        WHERE id IN (${chunk.map(() => '?').join(',')})
          AND NOT (user_id = ? AND conversation_id = ?)`,
    ).all(...chunk, userId, conversationId);
    for (const row of rows) blocked.add(String(row.id));
  }
  return blocked;
}

// ── List all conversations for current user ──
router.get('/', (req, res) => {
  try {
    const conversations = db.getConversationsByUser(req.user.id);
    res.json(conversations);
  } catch (err) {
    console.error('List conversations error:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// ── Get a single conversation with all messages ──
router.get('/:id', (req, res) => {
  try {
    const conv = db.getConversationById(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (conv.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const messages = db.getConversationMessages(req.params.id);
    res.json({ ...conv, messages });
  } catch (err) {
    console.error('Get conversation error:', err);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// ── Create a new conversation ──
router.post('/', (req, res) => {
  try {
    const { id, name } = req.body;
    if (!id) return res.status(400).json({ error: 'Conversation ID required' });

    const conv = db.createConversation({
      id,
      user_id: req.user.id,
      name: name || 'Interview ' + new Date().toLocaleDateString(),
    });

    // createConversation is idempotent (INSERT OR IGNORE), so a duplicate
    // id returns the EXISTING row rather than throwing. Ids are client-
    // chosen timestamps and therefore guessable, so that row may belong to
    // someone else — returning it unchecked would leak another user's
    // conversation name. Verify the owner before echoing anything back.
    if (!conv || conv.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.status(201).json(conv);
  } catch (err) {
    console.error('Create conversation error:', err);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

// ── Update conversation (rename, archive) ──
router.put('/:id', (req, res) => {
  try {
    const conv = db.getConversationById(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (conv.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const updated = db.updateConversation(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    console.error('Update conversation error:', err);
    res.status(500).json({ error: 'Failed to update conversation' });
  }
});

// ── Delete a conversation ──
router.delete('/:id', (req, res) => {
  try {
    const conv = db.getConversationById(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (conv.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    db.deleteConversation(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete conversation error:', err);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

// ── Add a single message to a conversation ──
router.post('/:id/messages', (req, res) => {
  try {
    const conv = db.getConversationById(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (conv.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const { id, role, content, timestamp } = req.body;
    if (!id || !role || !content) {
      return res.status(400).json({ error: 'Message id, role, and content are required' });
    }

    // The insert below is INSERT OR REPLACE on a client-chosen global id —
    // see findUnwritableMessageIds. Refuse rather than clobber a row that
    // isn't ours. 409, not 403: the request is well formed and the caller
    // does own the conversation; it is the id that is already taken.
    if (findUnwritableMessageIds([id], req.user.id, req.params.id).size > 0) {
      return res.status(409).json({ error: 'Message id already in use' });
    }

    db.addConversationMessage({
      id,
      conversation_id: req.params.id,
      user_id: req.user.id,
      role,
      content,
      timestamp: timestamp || Date.now(),
    });

    res.status(201).json({ success: true });
  } catch (err) {
    console.error('Add message error:', err);
    res.status(500).json({ error: 'Failed to add message' });
  }
});

// ── Bulk sync messages (batch upload from client) ──
router.post('/:id/sync', (req, res) => {
  try {
    let conv = db.getConversationById(req.params.id);
    if (!conv) {
      // Auto-create if missing. createConversation is idempotent — see the
      // comment on it in database.js for why (defence against a future
      // async refactor or multi-process deploy opening a create race here;
      // it is provably not racy today).
      conv = db.createConversation({
        id: req.params.id,
        user_id: req.user.id,
        name: req.body.name || 'Interview ' + new Date().toLocaleDateString(),
      });
    }
    // Single owner check covering both paths — a row we just lost the race
    // to create may belong to another user, since ids are client-supplied.
    if (!conv || conv.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array required' });
    }

    // Same client-chosen-id hazard as POST /:id/messages, except a batch can
    // carry a whole conversation (the one-shot history backfill posts every
    // message of a session at once). Rejecting the request would lose the
    // ENTIRE batch — attemptSync in services/aiProxyService.ts treats any
    // non-429 4xx as permanent and drops the payload — so drop only the ids
    // we are not allowed to write and store everything else.
    const unwritable = findUnwritableMessageIds(
      messages.filter(m => m && m.id != null).map(m => m.id),
      req.user.id,
      req.params.id,
    );

    const formattedMessages = messages
      .filter(m => !(m && m.id != null && unwritable.has(String(m.id))))
      .map(m => ({
        id: m.id,
        conversation_id: req.params.id,
        user_id: req.user.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp || Date.now(),
      }));

    db.addConversationMessages(formattedMessages);

    const dropped = messages.length - formattedMessages.length;
    if (dropped > 0) {
      console.warn(
        `Sync dropped ${dropped} message(s) whose id belongs elsewhere ` +
        `(user ${req.user.id}, conversation ${req.params.id})`,
      );
    }

    res.json({ success: true, synced: formattedMessages.length });
  } catch (err) {
    console.error('Sync messages error:', err);
    res.status(500).json({ error: 'Failed to sync messages' });
  }
});

// ── Get messages for a conversation ──
router.get('/:id/messages', (req, res) => {
  try {
    const conv = db.getConversationById(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (conv.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const messages = db.getConversationMessages(req.params.id);
    res.json(messages);
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ── Clear all messages in a conversation ──
router.delete('/:id/messages', (req, res) => {
  try {
    const conv = db.getConversationById(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (conv.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    db.clearConversationMessages(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Clear messages error:', err);
    res.status(500).json({ error: 'Failed to clear messages' });
  }
});

module.exports = router;
