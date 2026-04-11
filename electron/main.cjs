const { app, BrowserWindow, ipcMain, screen, session, desktopCapturer, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const database = require('./database.cjs');

let mainWindow = null;
let popoutWindow = null;
let tray = null;

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
    },
    icon: path.join(__dirname, '../dist/favicon.ico'),
    title: 'Interview Copilot',
    show: false,
  });

  // INVISIBLE TO SCREEN SHARE
  mainWindow.setContentProtection(true);

  // Hide instead of close — app stays in tray
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
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
  tray.setToolTip('Interview Copilot');

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
          app.isQuitting = true;
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
  // Grant all media permissions (screen capture, audio, etc.)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler(() => true);

  createMainWindow();
  createTray();

  // Auto-update: check GitHub Releases for a newer build. Skipped in dev
  // (unpackaged) and guarded so a missing module or network failure can
  // never keep the app from starting. The user is notified natively when
  // an update has been downloaded and will be installed on next quit.
  if (!isDev) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = true;
      autoUpdater.on('error', (err) => console.error('[updater] error:', err && err.message));
      autoUpdater.on('update-available', (info) => console.log('[updater] update available:', info && info.version));
      autoUpdater.on('update-not-available', () => console.log('[updater] up to date'));
      autoUpdater.on('update-downloaded', (info) => console.log('[updater] downloaded:', info && info.version));
      setTimeout(() => {
        autoUpdater.checkForUpdatesAndNotify().catch((e) => console.error('[updater] check failed:', e && e.message));
      }, 3000);
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

app.on('before-quit', () => {
  app.isQuitting = true;
  database.closeDB();
});
