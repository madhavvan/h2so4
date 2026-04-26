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

const { contextBridge, ipcRenderer, shell } = require('electron');

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
  // Local SQLite (Electron-side conversation/session/message DB)
  'db:claim-orphan-sessions',
  'db:get-active-session',
  'db:list-sessions',
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
// command execution.
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
function openExternal(url) {
  try {
    const u = new URL(url);
    if (!SAFE_PROTOCOLS.has(u.protocol)) {
      console.warn('[preload] blocked openExternal with protocol:', u.protocol);
      return Promise.reject(new Error('Protocol not allowed'));
    }
    return shell.openExternal(url);
  } catch (e) {
    return Promise.reject(e);
  }
}

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  send,
  on,
  invoke,
  openExternal,
});
