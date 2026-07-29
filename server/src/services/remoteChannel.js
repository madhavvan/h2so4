// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  REMOTE CHANNEL — /ws/remote
//
//  Carries two flows over one socket per device:
//    host → devices   mirror events (what the computer is doing)
//    remote → host    commands (buttons pressed on the phone)
//
//  Rules this enforces, each because of a specific way sync breaks:
//
//  • ONE AUTHORITATIVE HOST per user. Open the desktop on a second
//    machine and both would answer the same Auto-Solve — two screen
//    captures, two bills, two divergent transcripts. Newest claim wins;
//    the older host is demoted and told, so it can show "controlled
//    elsewhere" rather than silently fighting.
//
//  • EVERY DEVICE IS SCOPED TO ITS OWN USER. The join is authenticated
//    from the JWT, never from anything the client asserts. A device can
//    only ever see sessions belonging to the token it presented.
//
//  • COMMANDS THAT CANNOT BE DELIVERED FAIL LOUDLY. If the computer is
//    closed, the phone is told immediately — no queue, no silent tap.
//
//  • REPLAY BEFORE LIVE. A joining device receives everything after its
//    cursor and only then joins the live stream, so an event can never
//    arrive twice or out of order across the handover.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const WebSocket = require('ws');
const { verifyToken } = require('../middleware/auth');
const store = require('./remoteSessionStore');
const {
  REMOTE_WS_PATH, ROLE, EVENT, COMMAND_STATUS, HOST_PRESENCE,
  HEARTBEAT_INTERVAL_MS, HOST_OFFLINE_AFTER_MS, MAX_REPLAY_EVENTS,
  COMMAND_DEDUPE_WINDOW_MS, COMMAND_DEDUPE_MAX,
  makeEvent, makeCommandStatus, validateCommand, validateEvent, shouldPersist,
} = require('./remoteProtocol');

const MAX_REMOTES_PER_USER = 4;   // phone + tablet + a spare tab

// `noServer` is deliberate. Passing `server` to a second WebSocket.Server
// looks right and silently breaks BOTH: ws installs its own 'upgrade'
// listener per instance, and any instance whose path does not match
// aborts the handshake with a 400 — so whichever was registered first
// kills the other's connections. Both sockets are created with noServer
// and index.js routes upgrades by pathname.
function attachRemoteChannel(server, app, { path = REMOTE_WS_PATH } = {}) {
  const wss = new WebSocket.Server({ noServer: true });
  wss.remotePath = path;

  // Own our path, and ONLY our path. Critically this does not abort
  // paths it doesn't recognise — that is exactly what ws's built-in
  // handler does, and it is why two `server`-attached sockets kill each
  // other. Anything not ours is left for another listener to claim.
  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* keep default */ }
    if (pathname !== path) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // userId -> { host: client|null, remotes: Set<client> }
  const users = new Map();
  // commandId -> { at, remote } so status can be routed back to the
  // device that pressed the button, and repeats can be dropped.
  const commands = new Map();

  const bucket = (userId) => {
    if (!users.has(userId)) users.set(userId, { host: null, remotes: new Set() });
    return users.get(userId);
  };
  const send = (client, obj) => {
    try { if (client?.ws?.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(obj)); }
    catch { /* a dead socket is cleaned up by close/heartbeat */ }
  };

  function hostPresence(b) {
    if (!b?.host) return HOST_PRESENCE.OFFLINE;
    if (Date.now() - b.host.lastSeen > HOST_OFFLINE_AFTER_MS) return HOST_PRESENCE.OFFLINE;
    return b.host.busy ? HOST_PRESENCE.BUSY : HOST_PRESENCE.ONLINE;
  }
  function broadcastPresence(userId) {
    const b = users.get(userId);
    if (!b) return;
    const presence = hostPresence(b);
    for (const r of b.remotes) send(r, { kind: 'presence', presence, sessionId: b.host?.sessionId ?? null });
  }

  wss.on('connection', (ws) => {
    /** @type {{ws:WebSocket,userId:string|null,role:string|null,sessionId:string|null,lastSeen:number,busy:boolean,seen:Map<string,number>}} */
    const client = { ws, userId: null, role: null, sessionId: null, lastSeen: Date.now(), busy: false, seen: new Map() };

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      client.lastSeen = Date.now();

      // ── join: the only message accepted before authentication ──
      if (msg.kind === 'join') {
        let payload;
        try { payload = verifyToken(String(msg.token || '')); }
        catch { send(client, { kind: 'join_error', reason: 'bad_token' }); return ws.close(); }

        client.userId = payload.id;
        client.role = msg.role === ROLE.HOST ? ROLE.HOST : ROLE.REMOTE;
        client.sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
        const b = bucket(client.userId);

        if (client.role === ROLE.HOST) {
          // Newest host wins; demote the previous one explicitly.
          if (b.host && b.host !== client) {
            send(b.host, { kind: 'demoted', reason: 'another_host_claimed' });
            b.host.role = ROLE.REMOTE;
            b.remotes.add(b.host);
          }
          b.host = client;
        } else {
          // Oldest remote is evicted past the cap so a reconnect loop
          // cannot exhaust a user's slots.
          if (b.remotes.size >= MAX_REMOTES_PER_USER) {
            const oldest = [...b.remotes][0];
            send(oldest, { kind: 'evicted', reason: 'too_many_devices' });
            try { oldest.ws.close(); } catch {}
            b.remotes.delete(oldest);
          }
          b.remotes.add(client);
        }

        // Replay strictly before live, so the handover cannot duplicate
        // or reorder anything.
        let replayed = { events: [], truncated: false };
        if (client.sessionId) {
          replayed = store.replay(client.userId, client.sessionId, Number(msg.cursor) || 0, MAX_REPLAY_EVENTS);
        }
        send(client, {
          kind: 'joined',
          role: client.role,
          sessionId: client.sessionId,
          // Which conversation the computer is actually on. A phone has
          // no way to know this before it connects — it can only guess,
          // and a wrong guess means replaying an empty log and showing a
          // blank screen next to a desktop that is mid-interview. Told
          // here, the phone re-joins the right session immediately.
          hostSessionId: b.host?.sessionId ?? null,
          presence: hostPresence(b),
          cursor: client.sessionId ? store.latestSeq(client.userId, client.sessionId) : 0,
          replay: replayed.events,
          // The client must refetch rather than assume continuity.
          truncated: replayed.truncated,
        });
        broadcastPresence(client.userId);
        return;
      }

      if (!client.userId) return;                       // nothing else before join
      const b = bucket(client.userId);

      // ── heartbeat / busy state from the host ──
      if (msg.kind === 'heartbeat') {
        if (client.role === ROLE.HOST) {
          client.busy = !!msg.busy;
          if (typeof msg.sessionId === 'string') client.sessionId = msg.sessionId;
          broadcastPresence(client.userId);
        }
        return send(client, { kind: 'heartbeat_ack', t: Date.now() });
      }

      // ── mirror events: hosts only ──
      if (msg.kind === 'event') {
        if (client.role !== ROLE.HOST || b.host !== client) return;
        const v = validateEvent(msg);
        if (!v.ok) return send(client, { kind: 'event_rejected', reason: v.reason });

        let out;
        if (shouldPersist(msg.type)) {
          const rec = store.append(client.userId, msg.sessionId, msg.type, msg.data);
          out = makeEvent({ type: rec.type, sessionId: rec.sessionId, data: rec.data, seq: rec.seq, ts: rec.ts });
        } else {
          // Live-only: no seq, because it is never replayed and a number
          // would imply a durability we are not providing.
          out = makeEvent({ type: msg.type, sessionId: msg.sessionId, data: msg.data, seq: null, ts: Date.now() });
        }
        for (const r of b.remotes) send(r, out);
        return;
      }

      // ── commands: remotes only, routed to the one host ──
      if (msg.kind === 'command') {
        if (client.role === ROLE.HOST) return;
        const v = validateCommand(msg);
        if (!v.ok) return send(client, makeCommandStatus({ id: msg.id, status: COMMAND_STATUS.REJECTED, detail: v.reason }));

        if (hostPresence(b) === HOST_PRESENCE.OFFLINE) {
          // Fail now, loudly. A queued command that fires when the
          // laptop wakes is worse than a button that says no.
          return send(client, makeCommandStatus({ id: msg.id, status: COMMAND_STATUS.FAILED, detail: 'host_offline' }));
        }
        if (commands.has(msg.id)) {
          return send(client, makeCommandStatus({ id: msg.id, status: COMMAND_STATUS.REJECTED, detail: 'duplicate' }));
        }
        commands.set(msg.id, { at: Date.now(), remote: client });
        sweepCommands();
        send(b.host, msg);
        return send(client, makeCommandStatus({ id: msg.id, status: COMMAND_STATUS.QUEUED }));
      }

      // ── command status from the host, back to the issuing remote ──
      if (msg.kind === 'command_status') {
        if (client.role !== ROLE.HOST) return;
        const rec = commands.get(msg.id);
        if (rec) send(rec.remote, msg);
        return;
      }
    });

    ws.on('close', () => {
      if (!client.userId) return;
      const b = users.get(client.userId);
      if (!b) return;
      if (b.host === client) b.host = null;
      b.remotes.delete(client);
      broadcastPresence(client.userId);
      if (!b.host && b.remotes.size === 0) users.delete(client.userId);
    });
    ws.on('error', () => { try { ws.close(); } catch {} });
  });

  // Commands are short-lived; this keeps the routing map from growing.
  function sweepCommands() {
    if (commands.size < COMMAND_DEDUPE_MAX) return;
    const cutoff = Date.now() - COMMAND_DEDUPE_WINDOW_MS;
    for (const [id, rec] of commands) if (rec.at < cutoff) commands.delete(id);
  }

  // A host that dies without closing its socket (laptop lid, NAT
  // timeout) would otherwise read as online forever, and the phone would
  // offer buttons that quietly do nothing.
  const timer = setInterval(() => {
    for (const [userId, b] of users) {
      if (b.host && Date.now() - b.host.lastSeen > HOST_OFFLINE_AFTER_MS) {
        try { b.host.ws.terminate(); } catch {}
        b.host = null;
        broadcastPresence(userId);
      }
    }
    sweepCommands();
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  wss.on('close', () => clearInterval(timer));
  if (app?.locals) app.locals.remoteUsers = users;
  return { wss, users, commands, _hostPresence: hostPresence };
}

module.exports = { attachRemoteChannel, MAX_REMOTES_PER_USER };
