const { app, BrowserWindow, ipcMain, screen, session } = require('electron');
const path = require('path');

let mainWindow = null;
let popoutWindow = null;

const isDev = !app.isPackaged;

// Grant all media permissions (screen capture, audio, etc.)
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    // Allow all media-related permissions
    const allowedPermissions = ['media', 'mediaKeySystem', 'display-capture', 'audioCapture', 'videoCapture'];
    if (allowedPermissions.includes(permission)) {
      callback(true);
    } else {
      callback(true); // Allow everything for simplicity in a desktop app
    }
  });

  // Also handle permission checks
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return true;
  });
});

function getAppURL(params = '') {
  if (isDev) {
    return `http://localhost:3000${params ? '?' + params : ''}`;
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
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    icon: path.join(__dirname, '../dist/favicon.ico'),
    title: 'Interview Copilot',
    show: false, // Show after ready-to-show for smooth startup
  });

  // INVISIBLE TO SCREEN SHARE
  mainWindow.setContentProtection(true);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Load the full app
  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
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
// ───────────────────────────────────────────────
function createPopoutWindow(options = {}) {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.focus();
    return;
  }

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const popW = options.width || 450;
  const popH = options.height || 700;

  popoutWindow = new BrowserWindow({
    width: popW,
    height: popH,
    x: screenW - popW - 30,   // Bottom-right corner
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
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    title: 'Interview Copilot — Pop-out',
    show: false,
  });

  // INVISIBLE TO SCREEN SHARE
  popoutWindow.setContentProtection(true);

  // Keep floating above all windows
  popoutWindow.setAlwaysOnTop(true, 'floating');

  popoutWindow.once('ready-to-show', () => {
    popoutWindow.show();
  });

  // Load the app in popout mode
  if (isDev) {
    popoutWindow.loadURL('http://localhost:3000?mode=popout');
  } else {
    // For file:// URLs with query params
    popoutWindow.loadURL(`file://${path.join(__dirname, '../dist/index.html')}?mode=popout`);
  }

  popoutWindow.on('closed', () => {
    popoutWindow = null;
    // Notify main window that popout closed
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('popout-closed');
    }
  });
}

// ───────────────────────────────────────────────
//  IPC HANDLERS
// ───────────────────────────────────────────────

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
  }
});

// Toggle always-on-top for pop-out
ipcMain.on('set-always-on-top', (_event, flag) => {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.setAlwaysOnTop(flag, 'floating');
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
//  APP LIFECYCLE
// ───────────────────────────────────────────────
app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
