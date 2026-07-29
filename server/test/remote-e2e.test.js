// FULL LOOP: the actual RemoteHost and RemoteClient classes the desktop
// and phone ship, talking to the actual server channel.
//
// The unit tests proved the server's rules. This proves the product:
// press Auto-Solve on the phone, the computer runs it, the answer
// appears on the phone — and a phone that was closed for it still ends
// up showing exactly the same thing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import WS from 'ws';
import jwt from 'jsonwebtoken';

// The browser classes reach for a global WebSocket; Node needs it named.
globalThis.WebSocket = WS;

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-remote-e2e';
const { attachRemoteChannel } = await import('../src/services/remoteChannel.js');
const store = await import('../src/services/remoteSessionStore.js');
const { RemoteHost } = await import('../../services/remoteHost.ts');
const { RemoteClient } = await import('../../services/remoteClient.ts');

const USER = 'user-e2e';
const SESSION = 'sess-e2e';
const token = jwt.sign({ id: USER, email: 'e2e@t.com' }, process.env.JWT_SECRET);

let server, wsUrl;
const until = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('timed out waiting for condition');
};

beforeAll(async () => {
  server = http.createServer();
  attachRemoteChannel(server, { locals: {} });
  await new Promise(r => server.listen(0, r));
  wsUrl = `ws://127.0.0.1:${server.address().port}/ws/remote`;
  store.purgeSession(USER, SESSION);
});
afterAll(() => { store.purgeSession(USER, SESSION); server?.close(); });

function makeHost({ onAutoSolve } = {}) {
  let busy = false;
  const host = new RemoteHost({
    wsUrl, token,
    getSessionId: () => SESSION,
    isBusy: () => busy,
  });
  host.on('auto_solve', async () => {
    busy = true;
    host.publish('processing', { busy: true });
    host.publish('answer_start', {});
    host.publish('answer_tokens', { t: 'Kafka for ' });
    host.publish('answer_done', { text: 'Kafka for ingest, Redis for features.' });
    busy = false;
    host.publish('processing', { busy: false });
    onAutoSolve?.();
  });
  host.on('stop', () => { busy = false; host.publish('processing', { busy: false }); });
  return host;
}

function makePhone() {
  const seen = [];
  let presence = 'offline';
  const statuses = [];
  let synced = null;
  const phone = new RemoteClient({
    wsUrl, token, sessionId: SESSION,
    onSync: (events, info) => { synced = { events, info }; seen.push(...events); },
    onEvent: (e) => seen.push(e),
    onPresence: (p) => { presence = p; },
    onCommandStatus: (id, status, detail) => statuses.push({ id, status, detail }),
  });
  return {
    phone, seen, statuses,
    get presence() { return presence; },
    get synced() { return synced; },
  };
}

describe('phone as a remote for the computer — full loop', () => {
  it('presses Auto-Solve on the phone and the answer appears on the phone', async () => {
    let ran = 0;
    const host = makeHost({ onAutoSolve: () => { ran++; } });
    host.start();
    await until(() => host.isConnected);

    const p = makePhone();
    p.phone.start();
    await until(() => p.presence === 'online' || p.presence === 'busy');

    const id = p.phone.send('auto_solve');
    expect(id).toBeTruthy();

    // The computer did the work — exactly once.
    await until(() => ran === 1);

    // And the phone shows the answer the computer produced.
    const done = await until(() => p.seen.find(e => e.type === 'answer_done'));
    expect(done.data.text).toBe('Kafka for ingest, Redis for features.');

    // The live token frame arrived too, and carries no seq because it is
    // never replayed.
    const tok = p.seen.find(e => e.type === 'answer_tokens');
    expect(tok?.seq).toBeNull();

    await until(() => p.statuses.some(s => s.id === id && s.status === 'done'));
    p.phone.stop(); host.stop();
  });

  it('a phone that was closed during the answer catches up to the same state', async () => {
    const host = makeHost();
    host.start();
    await until(() => host.isConnected);

    // Nobody is watching — the computer works anyway.
    host.publish('answer_done', { text: 'answer while the phone was shut' });
    await new Promise(r => setTimeout(r, 200));

    const p = makePhone();
    p.phone.start();
    const sync = await until(() => p.synced);
    const texts = sync.events.filter(e => e.type === 'answer_done').map(e => e.data.text);
    expect(texts).toContain('answer while the phone was shut');
    expect(sync.info.truncated).toBe(false);

    p.phone.stop(); host.stop();
  });

  it('greys out the phone when the computer closes, and refuses the tap', async () => {
    const host = makeHost();
    host.start();
    await until(() => host.isConnected);

    const p = makePhone();
    p.phone.start();
    await until(() => p.phone.canControl);

    host.stop();                                   // laptop closed
    await until(() => p.presence === 'offline', 6000);
    expect(p.phone.canControl).toBe(false);

    // The tap is refused locally and instantly — no silent queue.
    const id = p.phone.send('auto_solve');
    expect(id).toBeNull();
    expect(p.statuses.at(-1)).toMatchObject({ status: 'failed', detail: 'host_offline' });

    p.phone.stop();
  });

  it('runs Auto-Solve once even if the same command is delivered twice', async () => {
    let ran = 0;
    const host = makeHost({ onAutoSolve: () => { ran++; } });
    host.start();
    await until(() => host.isConnected);

    const p = makePhone();
    p.phone.start();
    await until(() => p.phone.canControl);

    // Simulate the server redelivering an identical command after a blip
    // by hand-delivering the same envelope to the host twice.
    const dup = {
      v: 1, kind: 'command', id: 'cmd-e2e-dup-1', type: 'auto_solve',
      sessionId: SESSION, payload: {}, issuedAt: Date.now(), ttlMs: 20000,
    };
    host.ws.onmessage({ data: JSON.stringify(dup) });
    host.ws.onmessage({ data: JSON.stringify(dup) });
    await new Promise(r => setTimeout(r, 250));
    expect(ran).toBe(1);                           // screen captured once

    p.phone.stop(); host.stop();
  });

  it('starts and stops THE COMPUTER\'S microphone from the phone', async () => {
    // The one control whose name could be misread. What is being proved
    // here is that the phone's mic button is a request to the desktop —
    // this app never opens the handset's microphone, and there is no
    // command that could.
    const listened = [];
    const host = makeHost();
    host.on('toggle_listening', (p) => { listened.push(!!p.on); });
    host.start();
    await until(() => host.isConnected);

    const p = makePhone();
    p.phone.start();
    await until(() => p.phone.canControl);

    p.phone.send('toggle_listening', { on: true });
    await until(() => listened.length === 1);
    p.phone.send('toggle_listening', { on: false });
    await until(() => listened.length === 2);
    expect(listened).toEqual([true, false]);

    p.phone.stop(); host.stop();
  });

  it('refuses to let the phone capture audio, whatever the UI asks for', async () => {
    const host = makeHost();
    host.start();
    await until(() => host.isConnected);

    const p = makePhone();
    p.phone.start();
    await until(() => p.phone.canControl);

    // A future screen, a rogue build, a hand-crafted frame — the server
    // is the one that says no, so none of those can turn it on.
    const id = p.phone.send('mic_capture', {});
    await until(() => p.statuses.some(s => s.id === id && s.status === 'rejected'));
    expect(p.statuses.find(s => s.id === id).detail).toBe('host_only');

    p.phone.stop(); host.stop();
  });

  it('carries the whole control surface, and the phone can drive it', async () => {
    const calls = [];
    const host = makeHost();
    for (const c of ['set_model', 'set_auto_send', 'new_session', 'switch_session', 'auto_type']) {
      host.on(c, (payload) => { calls.push([c, payload]); });
    }
    host.start();
    await until(() => host.isConnected);

    const p = makePhone();
    p.phone.start();
    await until(() => p.phone.canControl);

    p.phone.send('set_model', { model: 'openai' });
    p.phone.send('set_auto_send', { on: true });
    p.phone.send('auto_type', { index: 1 });
    await until(() => calls.length === 3);
    expect(calls.map(c => c[0])).toEqual(['set_model', 'set_auto_send', 'auto_type']);
    expect(calls[0][1]).toMatchObject({ model: 'openai' });
    expect(calls[2][1]).toMatchObject({ index: 1 });

    p.phone.stop(); host.stop();
  });

  it('tells the phone a control the desktop is too old to run', async () => {
    // Staged rollout: a new phone, a desktop that has not updated. The
    // button must say so, not fail silently or appear to have worked.
    const host = makeHost();          // registers no set_model handler
    host.start();
    await until(() => host.isConnected);

    const p = makePhone();
    p.phone.start();
    await until(() => p.phone.canControl);

    const id = p.phone.send('set_model', { model: 'claude' });
    await until(() => p.statuses.some(s => s.id === id && s.status === 'rejected'));
    expect(p.statuses.find(s => s.id === id && s.status === 'rejected').detail).toBe('unsupported');

    p.phone.stop(); host.stop();
  });

  it('a live control frame is never written to the log', async () => {
    // control_state ticks every time the mic toggles. If it persisted,
    // a week of use would replay thousands of rows to say one thing the
    // snapshot already says — and a stale "typing in 3…" replayed
    // tomorrow would be an outright lie about the present.
    const host = makeHost();
    host.start();
    await until(() => host.isConnected);

    const p = makePhone();
    p.phone.start();
    await until(() => p.phone.canControl);

    host.publish('control_state', { busy: false, listening: true, model: 'openai' });
    host.publish('autotype_status', { phase: 'countdown', countdown: 3 });
    const live = await until(() => p.seen.filter(e => e.type === 'control_state' || e.type === 'autotype_status').length === 2);
    expect(live).toBeTruthy();
    for (const e of p.seen.filter(e => ['control_state', 'autotype_status'].includes(e.type))) {
      expect(e.seq).toBeNull();
    }

    // A phone joining now sees none of it in replay — and does not need
    // to, because the host republishes a snapshot on every connect.
    const late = makePhone();
    late.phone.start();
    const sync = await until(() => late.synced);
    expect(sync.events.some(e => e.type === 'control_state')).toBe(false);
    expect(sync.events.some(e => e.type === 'autotype_status')).toBe(false);

    late.phone.stop(); p.phone.stop(); host.stop();
  });

  it('tells a joining phone which conversation the computer is on', async () => {
    // The phone cannot know the session id before it connects. Without
    // this it would replay an empty log and sit blank beside a desktop
    // that is mid-interview.
    const host = new RemoteHost({
      wsUrl, token,
      getSessionId: () => 'sess-elsewhere',
      isBusy: () => false,
    });
    host.start();
    await until(() => host.isConnected);

    let adopted = null;
    const phone = new RemoteClient({
      wsUrl, token, sessionId: 'live',          // a guess
      onSync: () => {}, onEvent: () => {}, onPresence: () => {},
      onHostSession: (id) => { adopted = id; },
    });
    phone.start();
    await until(() => adopted === 'sess-elsewhere');

    phone.stop(); host.stop();
    store.purgeSession(USER, 'sess-elsewhere');
  });

  it('hands control to a second computer without both answering', async () => {
    let ranA = 0, ranB = 0;
    const a = makeHost({ onAutoSolve: () => { ranA++; } });
    a.start(); await until(() => a.isConnected);

    const b = makeHost({ onAutoSolve: () => { ranB++; } });
    b.start(); await until(() => b.isConnected);

    // The first machine steps down rather than fighting.
    await until(() => a.isConnected === false, 4000);

    const p = makePhone();
    p.phone.start();
    await until(() => p.phone.canControl);
    p.phone.send('auto_solve');

    await until(() => ranB === 1);
    expect(ranA).toBe(0);

    p.phone.stop(); a.stop(); b.stop();
  });
});
