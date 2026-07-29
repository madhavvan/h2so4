// End-to-end tests for device sync over a REAL WebSocket server.
// The cases here are the ones that actually break sync in the field:
// a phone reconnecting several answers behind, two desktops claiming one
// session, a host vanishing mid-answer, and a command redelivered after
// a blip. Each has a specific way of corrupting what the user sees.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-remote';
const { attachRemoteChannel } = await import('../src/services/remoteChannel.js');
const store = (await import('../src/services/remoteSessionStore.js')).default
  || await import('../src/services/remoteSessionStore.js');
const P = await import('../src/services/remoteProtocol.js');

const USER = 'user-remote-test';
const SESSION = 'sess-remote-test';
const token = jwt.sign({ id: USER, email: 'r@t.com' }, process.env.JWT_SECRET);
const otherToken = jwt.sign({ id: 'someone-else', email: 'x@t.com' }, process.env.JWT_SECRET);

let server, url;

beforeAll(async () => {
  server = http.createServer();
  attachRemoteChannel(server, { locals: {} });
  await new Promise(r => server.listen(0, r));
  url = `ws://127.0.0.1:${server.address().port}${P.REMOTE_WS_PATH}`;
  store.purgeSession(USER, SESSION);
});
afterAll(() => { store.purgeSession(USER, SESSION); server?.close(); });

// ── helpers ──
function open() {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(m)) { waiters[i].resolve(m); waiters.splice(i, 1); }
    }
  });
  return {
    ws, inbox,
    ready: new Promise(r => ws.on('open', r)),
    send: (o) => ws.send(JSON.stringify(o)),
    next: (match, ms = 2500) => new Promise((resolve, reject) => {
      const hit = inbox.find(match);
      if (hit) return resolve(hit);
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error('timeout waiting for message')), ms);
    }),
    close: () => new Promise(r => { ws.on('close', r); ws.close(); }),
  };
}
const join = async (c, role, cursor = 0, tok = token) => {
  await c.ready;
  c.send({ kind: 'join', token: tok, role, sessionId: SESSION, cursor });
  return c.next(m => m.kind === 'joined' || m.kind === 'join_error');
};
const evt = (type, data = {}) => ({ v: P.PROTOCOL_VERSION, kind: 'event', type, sessionId: SESSION, data });
const cmd = (type, id) => P.makeCommand({ id, type, sessionId: SESSION, issuedAt: Date.now() });

describe('device sync — the phone mirrors the computer', () => {
  it('rejects a join with a bad token, and never leaks another user a session', async () => {
    const c = open();
    await c.ready;
    c.send({ kind: 'join', token: 'garbage', role: P.ROLE.REMOTE, sessionId: SESSION });
    const r = await c.next(m => m.kind === 'join_error');
    expect(r.reason).toBe('bad_token');
    await c.close();

    // A valid token for a DIFFERENT user must not see this session's log.
    const host = open(); await join(host, P.ROLE.HOST);
    host.send(evt(P.EVENT.MESSAGE_ADDED, { text: 'private' }));
    await new Promise(r => setTimeout(r, 120));
    const stranger = open();
    const j = await join(stranger, P.ROLE.REMOTE, 0, otherToken);
    expect(j.replay).toEqual([]);
    await host.close(); await stranger.close();
  });

  it('mirrors a live answer to the phone', async () => {
    const host = open(); await join(host, P.ROLE.HOST);
    const phone = open(); await join(phone, P.ROLE.REMOTE);

    host.send(evt(P.EVENT.ANSWER_START, {}));
    host.send(evt(P.EVENT.ANSWER_TOKENS, { t: 'Kafka' }));
    host.send(evt(P.EVENT.ANSWER_DONE, { text: 'Kafka for ingest.' }));

    const done = await phone.next(m => m.type === P.EVENT.ANSWER_DONE);
    expect(done.data.text).toBe('Kafka for ingest.');
    expect(done.seq).toBeGreaterThan(0);

    // Token streams are live-only: delivered, but carrying no seq,
    // because they are never replayed.
    const tok = phone.inbox.find(m => m.type === P.EVENT.ANSWER_TOKENS);
    expect(tok.seq).toBeNull();
    await host.close(); await phone.close();
  });

  it('catches a phone up that was closed for three answers', async () => {
    const host = open(); await join(host, P.ROLE.HOST);
    const phone = open(); const first = await join(phone, P.ROLE.REMOTE);
    const cursor = first.cursor;
    await phone.close();                       // phone goes away

    for (const text of ['one', 'two', 'three']) host.send(evt(P.EVENT.ANSWER_DONE, { text }));
    await new Promise(r => setTimeout(r, 200));

    const back = open();
    const j = await join(back, P.ROLE.REMOTE, cursor);
    const texts = j.replay.filter(e => e.type === P.EVENT.ANSWER_DONE).map(e => e.data.text);
    expect(texts).toEqual(['one', 'two', 'three']);          // nothing missed
    const seqs = j.replay.map(e => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));   // and in order
    await host.close(); await back.close();
  });

  it('gives the newest desktop control and demotes the old one', async () => {
    const a = open(); await join(a, P.ROLE.HOST);
    const b = open(); await join(b, P.ROLE.HOST);
    const demoted = await a.next(m => m.kind === 'demoted');
    expect(demoted.reason).toBe('another_host_claimed');

    // The demoted desktop must no longer be able to write the session.
    const phone = open(); await join(phone, P.ROLE.REMOTE);
    a.send(evt(P.EVENT.ANSWER_DONE, { text: 'from the stale host' }));
    b.send(evt(P.EVENT.ANSWER_DONE, { text: 'from the real host' }));
    const got = await phone.next(m => m.type === P.EVENT.ANSWER_DONE);
    expect(got.data.text).toBe('from the real host');
    await a.close(); await b.close(); await phone.close();
  });
});

describe('the phone as a remote control', () => {
  it('routes Auto-Solve to the computer and reports status back', async () => {
    const host = open(); await join(host, P.ROLE.HOST);
    host.send({ kind: 'heartbeat', busy: false, sessionId: SESSION });
    const phone = open(); await join(phone, P.ROLE.REMOTE);

    phone.send(cmd(P.COMMAND.AUTO_SOLVE, 'cmd-autosolve-001'));
    const landed = await host.next(m => m.kind === 'command');
    expect(landed.type).toBe(P.COMMAND.AUTO_SOLVE);

    const queued = await phone.next(m => m.kind === 'command_status' && m.status === P.COMMAND_STATUS.QUEUED);
    expect(queued.id).toBe('cmd-autosolve-001');

    host.send(P.makeCommandStatus({ id: 'cmd-autosolve-001', status: P.COMMAND_STATUS.DONE }));
    const done = await phone.next(m => m.kind === 'command_status' && m.status === P.COMMAND_STATUS.DONE);
    expect(done.id).toBe('cmd-autosolve-001');
    await host.close(); await phone.close();
  });

  it('will not fire Auto-Solve twice when a command is redelivered', async () => {
    const host = open(); await join(host, P.ROLE.HOST);
    const phone = open(); await join(phone, P.ROLE.REMOTE);

    phone.send(cmd(P.COMMAND.AUTO_SOLVE, 'cmd-dupe-777'));
    await host.next(m => m.kind === 'command');
    phone.send(cmd(P.COMMAND.AUTO_SOLVE, 'cmd-dupe-777'));   // the retry
    const rejected = await phone.next(m => m.kind === 'command_status' && m.status === P.COMMAND_STATUS.REJECTED);
    expect(rejected.detail).toBe('duplicate');

    const delivered = host.inbox.filter(m => m.kind === 'command' && m.id === 'cmd-dupe-777');
    expect(delivered.length).toBe(1);          // the screen is captured once
    await host.close(); await phone.close();
  });

  it('tells the phone immediately when the computer is closed', async () => {
    const host = open(); await join(host, P.ROLE.HOST);
    const phone = open(); await join(phone, P.ROLE.REMOTE);
    await host.close();
    await phone.next(m => m.kind === 'presence' && m.presence === P.HOST_PRESENCE.OFFLINE);

    phone.send(cmd(P.COMMAND.AUTO_SOLVE, 'cmd-while-offline-1'));
    const status = await phone.next(m => m.kind === 'command_status');
    expect(status.status).toBe(P.COMMAND_STATUS.FAILED);
    expect(status.detail).toBe('host_offline');   // fails loudly, never queues
    await phone.close();
  });

  it('drops a stale tap rather than firing it later', async () => {
    const host = open(); await join(host, P.ROLE.HOST);
    const phone = open(); await join(phone, P.ROLE.REMOTE);

    const old = P.makeCommand({
      id: 'cmd-stale-abc', type: P.COMMAND.AUTO_SOLVE, sessionId: SESSION,
      issuedAt: Date.now() - (P.COMMAND_TTL_MS + 5_000),
    });
    phone.send(old);
    const status = await phone.next(m => m.kind === 'command_status');
    expect(status.status).toBe(P.COMMAND_STATUS.REJECTED);
    expect(status.detail).toBe('expired');
    expect(host.inbox.some(m => m.kind === 'command')).toBe(false);
    await host.close(); await phone.close();
  });

  it('refuses to let the phone claim the microphone', async () => {
    // Enforced in the contract, so no future UI can re-enable it.
    expect(P.HOST_ONLY_CAPABILITIES.has('mic_capture')).toBe(true);
    expect(Object.values(P.COMMAND)).not.toContain('mic_capture');
  });
});
