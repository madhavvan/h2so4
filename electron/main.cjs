const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 450,
    height: 700,
    alwaysOnTop: true, // Keeps it above other windows
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // THIS IS THE MAGIC LINE TO HIDE FROM SCREEN SHARE
  // It prevents the window content from being captured by screen recording apps
  // like Zoom, Google Meet, Teams, etc.
  win.setContentProtection(true);

  // Load the app
  const isDev = !app.isPackaged;
  
  if (isDev) {
    win.loadURL('http://localhost:3000');
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
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
