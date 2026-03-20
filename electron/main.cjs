const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 450,
    height: 700,
    alwaysOnTop: true,
    // --- TRANSPARENCY ---
    transparent: true,
    frame: false,               
    hasShadow: false,           
    backgroundColor: '#00000000', 
    // --- END TRANSPARENCY ---
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    roundedCorners: true,
    resizable: true,
    minWidth: 380,
    minHeight: 500,
  });

  
  mainWindow.setContentProtection(true);

  // IPC: Allow renderer to toggle click-through on transparent areas
  ipcMain.on('set-ignore-mouse', (_event, ignore) => {
    if (mainWindow) {
      mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
    }
  });

  // IPC: Allow renderer to set always-on-top level
  ipcMain.on('set-always-on-top', (_event, flag) => {
    if (mainWindow) {
      mainWindow.setAlwaysOnTop(flag, 'floating');
    }
  });

  // Load the app
  const isDev = !app.isPackaged;

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
