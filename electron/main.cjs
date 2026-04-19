const { app, BrowserWindow, ipcMain, screen, session, desktopCapturer, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const database = require('./database.cjs');

// ─── Single-instance lock ─────────────────────────────────────────────────
// Without this, every desktop launch spawns a fresh copy of the OLD binary
// — so any update sitting cached in %AppData%\Interview Copilot\pending\
// never gets a chance to install, and the user sees the same "ready to
// install" prompt every launch. With it, a second launch focuses the
// existing window instead, and pending updates install at the next quit.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    } else {
      createMainWindow();
    }
  });
}

let mainWindow = null;
let popoutWindow = null;
let tray = null;

// Updater state shared between the auto-update block (set when a download
// finishes) and the close / before-quit handlers (which install the pending
// update instead of leaving it stranded in the cache).
let pendingUpdate = null;          // { version, info } | null
let installPendingUpdate = null;   // (() => void) | null

const isDev = !app.isPackaged;

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
    backgroundColor: '#09090b', // Dark zinc background
    skipTaskbar: true,  // Hidden from taskbar — access via system tray
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // DevTools windows are NOT covered by setContentProtection — they
      // open as a separate HWND. Disable in packaged builds so a curious
      // keystroke (Ctrl+Shift+I) can't pop an unprotected inspector up
      // during an interview screen-share.
      devTools: isDev,
    },
    icon: path.join(__dirname, '../dist/favicon.ico'),
    title: 'Interview Copilot',
    show: false,
  });

  // INVISIBLE TO SCREEN SHARE
  mainWindow.setContentProtection(true);

  // Hide instead of close — app stays in tray. EXCEPTION: if a downloaded
  // update is sitting in the cache, give the user the choice to install it
  // now instead of silently hiding (and never installing on next launch,
  // since X-close doesn't trigger autoInstallOnAppQuit).
  mainWindow.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    if (!pendingUpdate || !installPendingUpdate) {
      mainWindow.hide();
      return;
    }
    dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Install update & quit', 'Stay in tray'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Interview Copilot ${pendingUpdate.version} is ready to install.`,
      detail: 'Install now to upgrade — the app will quit and relaunch on the new version. Or stay in the tray and install later.',
      noLink: true,
    }).then(({ response }) => {
      if (response === 0) {
        installPendingUpdate();
      } else {
        mainWindow.hide();
      }
    }).catch(() => mainWindow.hide());
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Load the full app
  if (isDev) {
    mainWindow.loadURL('http://localhost:3005');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
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
  }
}

function createPopoutWindow(options = {}) {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.focus();
    enforceAlwaysOnTop();
    return;
  }

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const popW = options.width || 450;
  const popH = options.height || 700;

  popoutWindow = new BrowserWindow({
    width: popW,
    height: popH,
    x: screenW - popW - 30,
    y: screenH - popH - 30,
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
    resizable: true,
    skipTaskbar: true,     // ← HIDDEN from taskbar
    focusable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // Same rationale as main window — unprotected DevTools HWND would
      // bypass setContentProtection on the popout during screen-share.
      devTools: isDev,
    },
    title: 'Interview Copilot — Pop-out',
    show: false,
  });

  // INVISIBLE TO SCREEN SHARE
  popoutWindow.setContentProtection(true);

  // Set highest always-on-top level immediately
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

// Desktop capturer — renderer can't access this directly in Electron 17+
ipcMain.handle('get-desktop-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 150, height: 150 }
  });
  // Return serializable data (thumbnails are NativeImage, can't be sent directly)
  return sources.map(s => ({ id: s.id, name: s.name }));
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

// Resize pop-out — keeps window on-screen and animates
ipcMain.on('resize-popout', (_event, { width, height }) => {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    const [currentX, currentY] = popoutWindow.getPosition();
    
    // Calculate new position so window doesn't go off-screen
    const newW = Math.min(width, screenW - 20);
    const newH = Math.min(height, screenH - 20);
    let newX = currentX;
    let newY = currentY;

    // Push back on-screen if needed
    if (newX + newW > screenW) newX = screenW - newW - 10;
    if (newY + newH > screenH) newY = screenH - newH - 10;
    if (newX < 0) newX = 10;
    if (newY < 0) newY = 10;

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

// After a browser-based Google Sign-In completes, the renderer polls the
// server and then asks Electron to surface the main window so the user
// doesn't have to alt-tab back from the browser "close tab" page.
ipcMain.on('focus-main-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
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

function autoTypeSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Gaussian random via Box-Muller.
function autoTypeGauss(mean, stdDev) {
  const u1 = Math.max(1e-9, Math.random());
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stdDev;
}

// Cadence mode machine — a real typist drifts between bursts of fluent
// typing, steady flow, and spells of hesitation. Modes persist for 5–35
// chars before flipping, so pauses cluster naturally (start, middle, end —
// wherever the mode lands) instead of being uniformly sprinkled.
let _atMode = 'flow';
let _atModeCharsLeft = 0;

function autoTypeResetCadence() {
  _atMode = 'flow';
  _atModeCharsLeft = 10 + Math.floor(Math.random() * 25);
}

function autoTypeAdvanceMode() {
  if (_atModeCharsLeft > 0) { _atModeCharsLeft--; return; }
  const r = Math.random();
  if (_atMode === 'flow') {
    _atMode = r < 0.40 ? 'burst' : r < 0.80 ? 'flow' : 'hesitation';
  } else if (_atMode === 'burst') {
    _atMode = r < 0.55 ? 'flow' : r < 0.85 ? 'burst' : 'hesitation';
  } else {
    _atMode = r < 0.65 ? 'flow' : r < 0.90 ? 'hesitation' : 'burst';
  }
  _atModeCharsLeft = 5 + Math.floor(Math.random() * 30);
}

// Per-character delay. Mode sets the base, then physical factors adjust:
//   • Shifted chars (caps, brackets, symbols) cost more (shift reach)
//   • Punctuation pauses longer (end-of-thought)
//   • Spaces add a small word-boundary pause
//   • Double letters fire faster (finger already on key)
//   • ~1.2% chance of an unscheduled 2–6s "stuck" pause — lands anywhere,
//     which is what makes pauses feel unpredictable.
function autoTypeHumanDelay(ch, prevCh) {
  autoTypeAdvanceMode();

  let d;
  if (_atMode === 'burst') {
    d = autoTypeGauss(85, 20);
    d = Math.max(40, Math.min(180, d));
  } else if (_atMode === 'hesitation') {
    d = autoTypeGauss(300, 80);
    d = Math.max(160, Math.min(500, d));
  } else {
    d = autoTypeGauss(150, 50);
    d = Math.max(55, Math.min(380, d));
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

  if (prevCh && prevCh === ch && /[a-zA-Z]/.test(ch)) d *= 0.55;

  if (Math.random() < 0.012) d += 2000 + Math.random() * 4000;

  return Math.round(d);
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

let _atLastWasTypo = false;

// Type a single char, sometimes mis-typing + backspacing first.
// ~0.8% per eligible char. Skipped if the previous char was also a typo
// (avoid stacked mistakes) or if prevCh is an auto-close trigger (IDEs
// may intercept the backspace to re-open a closed bracket/quote).
// Kill-switch: DISABLE_AUTO_TYPE_MISTAKES=1 bypasses injection entirely.
async function autoTypeCharWithTypo(keyboard, Key, ch, prevCh) {
  if (process.env.DISABLE_AUTO_TYPE_MISTAKES === '1') {
    _atLastWasTypo = false;
    await keyboard.type(ch);
    return;
  }
  const isLetter = /^[a-zA-Z]$/.test(ch);
  const prevIsAutoClose = prevCh && /[([{<"'`]/.test(prevCh);
  if (isLetter && !_atLastWasTypo && !prevIsAutoClose && Math.random() < 0.008) {
    const wrong = autoTypePickTypoChar(ch);
    if (wrong) {
      let wrongTyped = false;
      try { await keyboard.type(wrong); wrongTyped = true; }
      catch (e) { console.warn('[auto-type] typo wrong-char failed:', e.message); }
      if (wrongTyped) {
        await autoTypeSleep(250 + Math.random() * 500);
        // Backspace runs even if abort fires mid-sleep, so the wrong char
        // never stays behind. Outer loop's abort check will exit after.
        try {
          await keyboard.pressKey(Key.Backspace);
          await keyboard.releaseKey(Key.Backspace);
        } catch (e) { console.warn('[auto-type] typo backspace failed:', e.message); }
        await autoTypeSleep(100 + Math.random() * 120);
      }
      _atLastWasTypo = true;
    }
  } else {
    _atLastWasTypo = false;
  }
  await keyboard.type(ch);
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

  // Best-effort cleanup: backspace `n` chars. If backspace itself fails,
  // log and stop — nothing further we can do, caller's char-by-char path
  // will also fail and be logged by the outer catch.
  const reverse = async (n) => {
    for (let k = 0; k < n; k++) {
      try {
        await keyboard.pressKey(Key.Backspace);
        await keyboard.releaseKey(Key.Backspace);
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
    try { await keyboard.type(ch); wrongTyped++; }
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

  // Phase 2: backspace wrong word. On abort/error, clean up whatever remains
  // and return false. Caller's char-by-char path will retype the correct word
  // on top of any residue (visual mess, but not a silent skip).
  let backspaced = 0;
  for (let i = 0; i < wrong.length; i++) {
    if (autoTypeAbort) { await reverse(wrongTyped - backspaced); return false; }
    try {
      await keyboard.pressKey(Key.Backspace);
      await keyboard.releaseKey(Key.Backspace);
      backspaced++;
    } catch (e) {
      console.warn('[auto-type] backtrack backspace failed:', e.message);
      await reverse(wrongTyped - backspaced);
      return false;
    }
    await autoTypeSleep(32 + Math.random() * 38);
  }

  // Phase 3: type correct word. On abort/error, back out partial correct
  // so caller retypes from scratch.
  await autoTypeSleep(110 + Math.random() * 180);
  let cp = null;
  let correctTyped = 0;
  for (const ch of word) {
    if (autoTypeAbort) { await reverse(correctTyped); return false; }
    try { await keyboard.type(ch); correctTyped++; }
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
        await keyboard.pressKey(Key.Backspace);
        await keyboard.releaseKey(Key.Backspace);
      } catch (e) {
        console.warn('[auto-type] indent reverse failed:', e.message);
        return;
      }
      await autoTypeSleep(22);
    }
  };

  // Phase 1: type short indent. Abort/error = reverse + return false.
  let typed = 0;
  for (let i = 0; i < wrongCount; i++) {
    if (autoTypeAbort) { await reverse(typed); return false; }
    try { await keyboard.type(' '); typed++; }
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
      await keyboard.pressKey(Key.Backspace);
      await keyboard.releaseKey(Key.Backspace);
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

// Broadcast progress so the clicked CodeBlock can update its button label.
function autoTypeBroadcast(data) {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) win.webContents.send('auto-type:status', data);
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
  if (autoTypeInFlight) autoTypeAbort = true;
});

ipcMain.handle('auto-type:send', async (_event, payload) => {
  const code = payload && typeof payload.code === 'string' ? payload.code : '';
  // skipLines lets the renderer (which ran OCR on the target editor) tell us
  // how many leading lines of `code` are already present on screen, so we
  // start typing from where the new content actually begins instead of
  // duplicating boilerplate.
  const rawSkip = payload && typeof payload.skipLines === 'number' ? payload.skipLines : 0;
  const skipLines = Number.isInteger(rawSkip) && rawSkip > 0 ? rawSkip : 0;
  if (autoTypeInFlight) return { error: 'Auto-Type already in progress.' };
  if (!code.length) return { error: 'Nothing to type.' };

  autoTypeInFlight = true;
  autoTypeAbort = false;
  autoTypeResetCadence();
  _atLastWasTypo = false;

  let keyboard, Key;
  try {
    ({ keyboard, Key } = loadNut());
  } catch (e) {
    autoTypeInFlight = false;
    console.error('[auto-type] native module load failed:', e && e.message);
    return { error: 'Native input module failed to load: ' + (e && e.message) };
  }

  // Phase 1: countdown. Windows stay visible so the user can see the
  // timer and alt-tab to the target editor (or click to cancel).
  for (let n = 3; n > 0 && !autoTypeAbort; n--) {
    autoTypeBroadcast({ phase: 'countdown', n });
    await autoTypeSleep(1000);
  }
  if (autoTypeAbort) {
    autoTypeInFlight = false;
    autoTypeBroadcast({ phase: 'done', aborted: true });
    return { aborted: true };
  }

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
    restore.push(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); });
    mainWindow.hide();
  }
  // If the popout itself is focused (user just clicked Auto-Type inside it),
  // blur it so typing doesn't go back into the popout's own input.
  if (popoutWindow && !popoutWindow.isDestroyed() && popoutWindow.isFocused()) {
    popoutWindow.blur();
  }
  // Small delay for the OS to settle focus on the editor underneath.
  await autoTypeSleep(150);

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
    if (uia && uia.ok) {
      uiaSnapshotBefore = uia;
      const plan = planAutoTypeFromUIA({
        code,
        editorText: uia.text || '',
        cursorOffset: uia.cursorOffset || 0,
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
        effectiveSkipLines = plan.skipLines;
        effectiveSkipTrailing = plan.skipTrailingLines || 0;
        wipeFirstLine = !!plan.wipeFirstLine;
        usedUIA = true;
      } else {
        console.log(`[auto-type] UIA plan rejected (conf < 0.85) — using skipLines=${skipLines} from caller`);
      }
    } else if (uia) {
      console.log(`[auto-type] UIA unavailable: ${uia.error || 'unknown'}`);
    }
  } catch (uiaErr) {
    console.warn('[auto-type] UIA read threw:', uiaErr && uiaErr.message);
  }

  // UIA read can block up to 3.5s. If the user clicked cancel during that
  // wait, honor it now — don't broadcast 'typing' and don't start keystrokes.
  if (autoTypeAbort) {
    restore.forEach(fn => { try { fn(); } catch (_) {} });
    autoTypeBroadcast({ phase: 'done', aborted: true });
    autoTypeInFlight = false;
    return { aborted: true };
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

    // First-line wipe: when leading skip > 0 the cursor sits on a whitespace
    // line whose content would stack with the typed line's own indent. Home
    // → Shift+End → Delete neutralizes the line before the first char lands.
    // Sequential key events (not a combo) because nut-js's combo form trips
    // libnut's "Invalid key flag" on some Windows builds.
    if (wipeFirstLine) {
      try {
        await keyboard.pressKey(Key.Home);
        await keyboard.releaseKey(Key.Home);
        await autoTypeSleep(20);
        await keyboard.pressKey(Key.LeftShift);
        await autoTypeSleep(8);
        await keyboard.pressKey(Key.End);
        await autoTypeSleep(8);
        await keyboard.releaseKey(Key.End);
        await autoTypeSleep(8);
        await keyboard.releaseKey(Key.LeftShift);
        await autoTypeSleep(20);
        await keyboard.pressKey(Key.Delete);
        await keyboard.releaseKey(Key.Delete);
        await autoTypeSleep(30);
      } catch (kErr) {
        // If the wipe fails, continue — worst case is visible double-indent
        // on the first typed line, not a broken type run.
        console.warn('[auto-type] first-line wipe failed:', kErr && kErr.message);
      }
    }

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

        // Newline → editor will auto-indent. Wipe the auto-indent so
        // the AI's own leading whitespace (typed on next iter) stands alone.
        // Keep these internal-navigation keys snappy — they're not part
        // of the "human typing" rhythm the user sees in the editor.
        try {
          await keyboard.pressKey(Key.Enter);
          await keyboard.releaseKey(Key.Enter);
          await autoTypeSleep(50);

          await keyboard.pressKey(Key.Home);
          await keyboard.releaseKey(Key.Home);
          await autoTypeSleep(20);

          // Shift+End as sequential hold rather than pressKey(a, b) combo.
          // The combo form triggers libnut's "Invalid key flag specified"
          // on some Windows builds (the native SendInput layer rejects the
          // combined key-event flags). Sequential press/press/release/release
          // uses one SendInput per key and works reliably.
          await keyboard.pressKey(Key.LeftShift);
          await autoTypeSleep(8);
          await keyboard.pressKey(Key.End);
          await autoTypeSleep(8);
          await keyboard.releaseKey(Key.End);
          await autoTypeSleep(8);
          await keyboard.releaseKey(Key.LeftShift);
          await autoTypeSleep(20);

          await keyboard.pressKey(Key.Delete);
          await keyboard.releaseKey(Key.Delete);
          await autoTypeSleep(20);
        } catch (kErr) {
          // If the indent-reset fails, continue — worst case is
          // visible double-indent, not a broken type run.
          console.warn('[auto-type] indent-reset failed:', kErr && kErr.message);
        }

        // Reset prevCh at line boundaries so the first char of the new
        // line doesn't get "double letter" speed-up with the last char
        // of the previous line (which is visually a separate word).
        prevCh = null;
      }

      prevLineTextForBlockCheck = line;
    }

    // ── Post-type verify ──
    // Only run when UIA gave us the pre-type snapshot (so we have "before"
    // context) AND the type completed without abort. Best-effort: on any
    // error or inconclusive result we don't alert, because false positives
    // during an interview are worse than missed detections.
    if (!autoTypeAbort && usedUIA && uiaSnapshotBefore) {
      try {
        // Short settle: some editors debounce their accessibility tree updates.
        await autoTypeSleep(180);
        const uiaAfter = await readFocusedViaUIA(1200);
        if (uiaAfter && uiaAfter.ok) {
          const verdict = verifyTypedContent(typedContent, uiaAfter.text || '');
          if (!verdict.ok) {
            console.warn(`[auto-type] verify: mismatch (ratio=${(verdict.ratio || 0).toFixed(2)}, reason=${verdict.reason})`);
            autoTypeBroadcast({
              phase: 'verify-mismatch',
              ratio: verdict.ratio,
              reason: verdict.reason,
            });
          } else {
            console.log(`[auto-type] verify: ok (${verdict.reason})`);
            autoTypeBroadcast({ phase: 'verify-ok', reason: verdict.reason });
          }
        } else if (uiaAfter) {
          console.log(`[auto-type] verify: skipped (uia after unavailable: ${uiaAfter.error})`);
        }
      } catch (vErr) {
        console.warn('[auto-type] verify error (non-fatal):', vErr && vErr.message);
      }
    }
  } catch (err) {
    console.error('[auto-type] typing loop error:', err);
  } finally {
    restore.forEach(fn => { try { fn(); } catch (_) {} });
    autoTypeBroadcast({ phase: 'done', aborted: autoTypeAbort });
    autoTypeInFlight = false;
  }

  return { ok: !autoTypeAbort, aborted: autoTypeAbort };
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
      $obj = [PSCustomObject]@{ ok = $true; text = $fullText; cursorOffset = $cursorOffset; source = 'text_pattern' }
      return ($obj | ConvertTo-Json -Compress -Depth 3)
    }

    $vp = $null
    $hasVp = $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)
    if ($hasVp -and $vp) {
      $value = $vp.Current.Value
      if ($null -eq $value) { $value = '' }
      $obj = [PSCustomObject]@{ ok = $true; text = $value; cursorOffset = $value.Length; source = 'value_pattern' }
      return ($obj | ConvertTo-Json -Compress -Depth 3)
    }

    return '{"ok":false,"error":"no_pattern"}'
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
  const p = _pathMod.join(_os.tmpdir(), 'interview-copilot-uia-helper.ps1');
  // Always overwrite. The file lives in the shared tmp dir and persists
  // across app runs, so if we evolve UIA_PS_SCRIPT between versions we
  // MUST NOT reuse a stale cached copy — otherwise fixes ship but the
  // running bridge still executes yesterday's script.
  _fs.writeFileSync(p, UIA_PS_SCRIPT, 'utf8');
  _uiaScriptPath = p;
  return p;
}

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
        queueEntry.done = true;
        const idx = _uiaQueue.indexOf(queueEntry);
        if (idx !== -1) _uiaQueue.splice(idx, 1);
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
function planAutoTypeFromUIA(params) {
  const code = typeof params.code === 'string' ? params.code : '';
  const editorText = typeof params.editorText === 'string' ? params.editorText : '';
  const cursorOffsetRaw = typeof params.cursorOffset === 'number' ? params.cursorOffset : 0;
  const cursorOffset = Math.max(0, Math.min(cursorOffsetRaw, editorText.length));

  const codeLines = code.split('\n');

  if (!editorText || editorText.trim().length === 0) {
    return { skipLines: 0, skipTrailingLines: 0, wipeFirstLine: false, confidence: 1.0, reason: 'empty_editor' };
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
  return database.getOrCreateActiveSession(userId);
});

ipcMain.handle('db:list-sessions', (_event, userId) => {
  return database.listSessionsForUser(userId);
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

ipcMain.handle('db:get-messages', (_event, sessionId) => {
  return database.getMessages(sessionId);
});

ipcMain.handle('db:add-message', (_event, sessionId, message) => {
  database.addMessage(sessionId, message);
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
});

ipcMain.handle('db:get-context-files', (_event, sessionId) => {
  return database.getContextFiles(sessionId);
});

ipcMain.handle('db:add-context-file', (_event, sessionId, file) => {
  database.addContextFile(sessionId, file);
  BrowserWindow.getAllWindows().forEach(win => {
    if (win.webContents.id !== _event.sender.id && !win.isDestroyed()) {
      win.webContents.send('db:files-updated', sessionId);
    }
  });
});

ipcMain.handle('db:remove-context-file', (_event, fileId) => {
  database.removeContextFile(fileId);
  BrowserWindow.getAllWindows().forEach(win => {
    if (win.webContents.id !== _event.sender.id && !win.isDestroyed()) {
      win.webContents.send('db:files-updated');
    }
  });
});

ipcMain.handle('db:clear-session', (_event, sessionId) => {
  database.clearMessages(sessionId);
  database.clearContextFiles(sessionId);
  broadcastToAllWindows('db:session-cleared', sessionId);
  broadcastToAllWindows('db:sessions-updated');
});

// ───────────────────────────────────────────────
//  SYSTEM TRAY
// ───────────────────────────────────────────────
function createTray() {
  // Create a simple 16x16 blue square icon for the tray
  // On Windows: .ico works best. On Mac/Linux: PNG.
  // nativeImage can create from a data URL
  const size = 16;
  const icon = nativeImage.createEmpty();
  
  // Try to load from app resources first, fall back to generated icon
  let trayIcon;
  try {
    const iconPath = isDev 
      ? path.join(__dirname, '../public/tray-icon.png')
      : path.join(__dirname, '../dist/tray-icon.png');
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) throw new Error('Icon file not found');
  } catch (e) {
    // Generate a simple 16x16 blue square as fallback
    // This is a minimal 16x16 blue PNG as base64
    const bluePng = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVQ4T2P8z8BQz0BHwMgwasCoAQyjYcAwGgYMo2HAMKINAIZ/DAz1dAyDUQNGwwAALNYIEdLptSAAAAAASUVORK5CYII=';
    trayIcon = nativeImage.createFromBuffer(Buffer.from(bluePng, 'base64'));
  }
  
  // Resize for tray
  trayIcon = trayIcon.resize({ width: 16, height: 16 });

  tray = new Tray(trayIcon);
  // Native tray tooltip is rendered by the OS shell — it is NOT covered by
  // setContentProtection and shows on screen-share when the cursor crosses
  // the system tray. Empty string suppresses the leak; the context menu
  // (opened deliberately via right-click) is kept for access.
  tray.setToolTip('');

  function updateTrayMenu() {
    const isMainVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
    const isPopoutOpen = popoutWindow && !popoutWindow.isDestroyed();

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Interview Copilot',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: isMainVisible ? 'Hide Main Window' : 'Show Main Window',
        click: () => {
          if (!mainWindow || mainWindow.isDestroyed()) {
            createMainWindow();
          } else if (mainWindow.isVisible()) {
            mainWindow.hide();
          } else {
            mainWindow.show();
            mainWindow.focus();
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
          // Don't pre-set isQuitting — let before-quit decide whether to
          // install a pending update first or proceed with cleanup.
          app.quit();
        }
      }
    ]);

    tray.setContextMenu(contextMenu);
  }

  // Left-click on tray: toggle main window
  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
    } else if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
    updateTrayMenu();
  });

  // Update menu whenever windows change
  updateTrayMenu();
  
  // Re-build menu periodically to reflect window state changes
  setInterval(updateTrayMenu, 3000);
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

  // Grant all media permissions (screen capture, audio, etc.)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler(() => true);

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

  createMainWindow();
  createTray();

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
      const electronLog = require('electron-log');
      const { autoUpdater } = require('electron-updater');

      // File log under %AppData%\Interview Copilot\logs\main.log (Windows)
      // or ~/Library/Logs/Interview Copilot/main.log (macOS). Future updater
      // failures leave a trail here instead of disappearing into stdout.
      electronLog.transports.file.level = 'info';
      autoUpdater.logger = electronLog;

      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;

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
        try {
          electronLog.info(`[updater] installing ${target && target.version} silent=${isSilent}`);
          autoUpdater.quitAndInstall(isSilent, true);
        } catch (err) {
          electronLog.error('[updater] quitAndInstall threw:', err && err.message);
          app.quit();
        }
      }

      // The 6s launch-install window. If `update-downloaded` fires while
      // this is still active, it's a cached update from a prior session
      // → install silently. If it fires later (a fresh download finished
      // mid-session), we let the renderer prompt the user instead.
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
      });

      autoUpdater.on('download-progress', (progress) => {
        sendUpdateStatus('downloading', {
          percent: Math.round(progress.percent),
          transferred: progress.transferred,
          total: progress.total,
        });
      });

      autoUpdater.on('update-downloaded', (info) => {
        pendingUpdate = { version: info.version, info };
        installPendingUpdate = () => performInstall(true);
        sendUpdateStatus('ready', { version: info.version });

        if (launchInstallActive) {
          launchInstallActive = false;
          clearTimeout(launchInstallTimer);
          electronLog.info(`[updater] cached update ${info.version} found at launch — installing silently`);
          // Tiny defer so the renderer can flush the 'ready' status; not
          // strictly necessary but avoids a hard-cut transition for users
          // who happen to see the brief flash before relaunch.
          setTimeout(() => performInstall(true), 200);
        }
      });

      autoUpdater.on('error', (err) => {
        electronLog.error('[updater] error:', err && err.message);
        sendUpdateStatus('error', { message: err && err.message });
        launchInstallActive = false;
        clearTimeout(launchInstallTimer);
      });

      // User clicks "Restart & Update" in Settings — show the installer
      // UI (non-silent) so they get visual feedback during the swap. If
      // no download is ready yet, kick a check; the renderer prompt will
      // fire again once update-downloaded comes through.
      ipcMain.on('install-update', () => {
        if (pendingUpdate) {
          performInstall(false);
        } else {
          autoUpdater.checkForUpdatesAndNotify().catch((e) => {
            electronLog.error('[updater] install-update check failed:', e && e.message);
          });
        }
      });

      ipcMain.on('check-for-updates', () => {
        autoUpdater.checkForUpdatesAndNotify().catch((e) => {
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
      setInterval(() => {
        autoUpdater.checkForUpdatesAndNotify().catch(() => {});
      }, 30 * 60 * 1000);
    } catch (err) {
      console.error('[updater] unavailable:', err && err.message);
    }
  }

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
    } else {
      mainWindow.show();
    }
  });
});

// Don't quit when all windows closed — tray keeps app alive
app.on('window-all-closed', () => {
  // Do nothing — app stays in tray
});

app.on('before-quit', (e) => {
  // If a download is sitting ready, install it now instead of letting
  // it rot in the cache. autoInstallOnAppQuit is supposed to handle this
  // automatically but has been observed to silently no-op in some Windows
  // configs — doing it explicitly is the safe path. performInstall sets
  // isQuitting=true and re-enters this handler once the installer takes
  // over, so the cleanup branch below still runs.
  if (pendingUpdate && installPendingUpdate && !app.isQuitting) {
    e.preventDefault();
    installPendingUpdate();
    return;
  }
  app.isQuitting = true;
  try { killUIABridge(); } catch (_) {}
  database.closeDB();
});
