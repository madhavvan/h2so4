// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PRELOAD — runs before any renderer JS, in a context that has
//  Node.js + Electron access. Renderer itself runs in a sandboxed
//  Chromium context (nodeIntegration:false, contextIsolation:true)
//  and only sees the surface we expose here via contextBridge.
//
//  Every IPC channel is allowlisted. If a renderer tries to call
//  a channel not in the lists below, we log + reject — meaning a
//  renderer XSS can't pivot to arbitrary IPC. When you add a new
//  ipcMain.handle/on in main.cjs (or a new webContents.send),
//  also add it here or it'll silently no-op.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Note there's no `shell` here on purpose — this preload runs sandboxed
// (neither window sets sandbox:false), and a sandboxed preload's
// require('electron') only hands back contextBridge, crashReporter,
// ipcRenderer, nativeImage, sharedTexture, webFrame and webUtils. Asking
// for shell would just get you `undefined` and a TypeError at call time.
// Anything that needs shell goes through IPC to main.
const { contextBridge, ipcRenderer } = require('electron');

// Renderer → main, fire-and-forget (ipcRenderer.send)
const SEND_CHANNELS = new Set([
  // Window management
  'open-popout',
  'close-popout',
  'minimize-window',
  'close-window',
  'resize-popout',
  'set-always-on-top',
  'focus-main-window',
  // Toggle popout focusability — used by the popout renderer to make
  // the window focusable on demand when a text input is clicked, and
  // back to non-focusable when the input blurs. See main.cjs popout
  // constructor for why this exists (Ropes.ai-class proctoring).
  'popout:set-focusable',
  // Custom resize for the popout — native OS resize is disabled to
  // prevent the side-edge resize cursor from flashing during a
  // screen-share. Renderer-side JS handles drive these channels to
  // implement resize on top/bottom/corners only.
  'popout:resize-start',
  'popout:resize-move',
  'popout:resize-end',
  // Cross-window relays
  'relay-to-popout',
  'relay-to-main',
  // Session-active flag (drives tray-hide for screen-share invisibility)
  'session-active',
  // Auto-type cancellation
  'auto-type:abort',
  // Updater
  'install-update',
  'check-for-updates',
  // Decision from the in-app update-on-close prompt (replaces the native
  // dialog.showMessageBox response). Payload: { decision: 'install' | 'dismiss' }
  'update-prompt-decision',
  // Support bot inbox alerts (admin only). Renderer's background WS
  // hook in App.tsx forwards customer_joined / message events to main
  // for native OS notifications + tray badge + dock counter. See
  // electron/main.cjs SUPPORT INBOX ALERT BRIDGE block.
  'support:alert',          // payload: { threadId, title, body, kind, customerEmail, customerName }
  'support:clear-unread',   // payload: none — admin opened the inbox, reset badge
  'support:thread-viewed',  // payload: { threadId } — admin opened a specific thread
]);

// Renderer → main, request/response (ipcRenderer.invoke)
const INVOKE_CHANNELS = new Set([
  // Screen capture (auto-solve, voice mode)
  'get-desktop-sources',
  // Auto-type pipeline
  'auto-type:check-permission',
  'auto-type:capabilities',
  'auto-type:send',
  // Accessibility (focused-element OCR helper)
  'a11y:read-focused',
  // Robust external-URL opener with shell.openExternal + child_process
  // fallback. Used by Google sign-in to survive ShellExecute hiccups.
  'open-external-robust',
  // Local SQLite (Electron-side conversation/session/message DB)
  'db:claim-orphan-sessions',
  'db:get-active-session',
  'db:list-sessions',
  'db:known-session-ids',
  'db:import-remote-session',
  'db:new-session',
  'db:switch-session',
  'db:rename-session',
  'db:delete-session',
  'db:get-messages',
  'db:add-message',
  'db:get-context-files',
  'db:add-context-file',
  'db:remove-context-file',
  'db:clear-session',
]);

// Main → renderer broadcasts the renderer can listen to (ipcRenderer.on)
const RECEIVE_CHANNELS = new Set([
  // Window state changes
  'popout-opened',
  'popout-closed',
  // Cross-window relay receivers
  'from-main',
  'from-popout',
  // Auto-type live status
  'auto-type:status',
  // DB change notifications
  'db:messages-updated',
  'db:files-updated',
  'db:session-cleared',
  'db:sessions-updated',
  'db:active-session-changed',
  // Updater status
  'update-status',
  // Window-hidden-to-tray notification (drives first-time tray toast)
  'app-hidden-to-tray',
  // In-app update-on-close prompt (replaces native dialog.showMessageBox)
  'show-update-prompt',
  // Main → renderer deeplink: admin tapped a support notification.
  // Payload: { threadId, customerEmail }. Renderer opens the bot
  // panel + jumps to that specific thread in the inbox.
  'support:open-inbox',
  // Clean-close signal from main → main renderer. Fires when the user
  // hits X (with no popout) or tray Quit. Renderer reacts by stopping
  // the mic (if listening) and turning off Auto mode (if on). Conversation
  // state is handled separately via the existing db:active-session-changed
  // broadcast that endSessionCleanly also emits.
  'cmd-end-session',
]);

function send(channel, data) {
  if (!SEND_CHANNELS.has(channel)) {
    console.warn('[preload] blocked send to non-allowlisted channel:', channel);
    return;
  }
  ipcRenderer.send(channel, data);
}

function invoke(channel, ...args) {
  if (!INVOKE_CHANNELS.has(channel)) {
    console.warn('[preload] blocked invoke to non-allowlisted channel:', channel);
    return Promise.reject(new Error('Channel not allowed: ' + channel));
  }
  return ipcRenderer.invoke(channel, ...args);
}

// on() returns a disposer the caller MUST call to clean up. We never
// expose ipcRenderer.removeListener directly — the wrapped callback we
// register is opaque to the renderer, so reference equality wouldn't
// work even if it could call removeListener.
function on(channel, callback) {
  if (!RECEIVE_CHANNELS.has(channel)) {
    console.warn('[preload] blocked listener on non-allowlisted channel:', channel);
    return () => {};
  }
  const wrapped = (_evt, data) => {
    try { callback(data); }
    catch (e) { console.error('[preload] listener error:', e); }
  };
  ipcRenderer.on(channel, wrapped);
  return () => {
    try { ipcRenderer.removeListener(channel, wrapped); } catch {}
  };
}

// Open external URL — only http/https/mailto. Everything else (file://,
// javascript:, data:) is blocked because shell.openExternal will happily
// execute file:// or weird custom protocols on Windows that can lead to
// command execution. Main re-checks the exact same allowlist before it
// launches anything; we keep the check here as well so a bad protocol
// never even reaches IPC — defence in depth, and the log line tells you
// which renderer tried it.
//
// The actual launch is delegated to main over 'open-external-robust',
// because this preload is sandboxed and therefore has no shell to call
// (see the require at the top of the file). Contract note: the robust
// helper below RESOLVES with { ok:false, ... } when a launch fails, but
// callers of this one expect the older, simpler promise that REJECTS on
// failure so their catch/fallback path runs — so we translate ok:false
// into a rejection here and leave openExternalRobust's shape alone.
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
function openExternal(url) {
  try {
    const u = new URL(url);
    if (!SAFE_PROTOCOLS.has(u.protocol)) {
      console.warn('[preload] blocked openExternal with protocol:', u.protocol);
      return Promise.reject(new Error('Protocol not allowed'));
    }
    return invoke('open-external-robust', url).then((result) => {
      if (result && result.ok) return undefined;
      const detail = (result && result.error) || 'unknown error';
      throw new Error('Failed to open external URL — ' + detail);
    });
  } catch (e) {
    return Promise.reject(e);
  }
}

// Robust opener that goes through main-process IPC and tries multiple OS
// launch paths. Renderer should prefer this over openExternal — the legacy
// helper is kept only for code paths that haven't been migrated yet.
function openExternalRobust(url) {
  if (!INVOKE_CHANNELS.has('open-external-robust')) {
    return Promise.reject(new Error('Channel not allowed: open-external-robust'));
  }
  return ipcRenderer.invoke('open-external-robust', url);
}

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  send,
  on,
  invoke,
  openExternal,
  openExternalRobust,
});
