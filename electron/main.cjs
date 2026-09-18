const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { detectRouter } = require('./services/detection.cjs');
const { runAction, openFolder, oemPackageStatus, ensureFolders } = require('./services/actions.cjs');

let mainWindow = null;

function createWindow() {
  const smokeShot = process.argv.includes('--smoke-shot');
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    backgroundColor: '#f4f8f9',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => { if (!smokeShot) mainWindow.show(); });
  if (smokeShot) {
    mainWindow.webContents.once('did-finish-load', async () => {
      await new Promise((resolve) => setTimeout(resolve, 15000));
      const image = await mainWindow.webContents.capturePage();
      require('fs').writeFileSync(path.join(app.getPath('temp'), 'AX3600Assistant-smoke-shot.png'), image.toPNG());
      app.quit();
    });
  }
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

app.whenReady().then(() => {
  ensureFolders();
  ipcMain.handle('app:get-info', () => ({ version: app.getVersion(), name: app.getName(), platform: process.platform }));
  ipcMain.handle('router:detect', async () => {
    const device = await detectRouter();
    if (device.state !== 'stock-downgrade') return device;
    const oem = await oemPackageStatus();
    if (!oem.ready) return device;
    return {
      ...device,
      state: 'stock-downgrade-ready',
      label: '原厂包已准备',
      headline: '下一步：安装官方 1.0.17',
      next: '固件已经下载并校验完成。点击主按钮，软件会打开小米后台和正确的 BIN 文件位置。',
    };
  });
  ipcMain.handle('action:run', (event, request) => {
    const resourceDir = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'resources')
      : path.join(__dirname, '..', 'resources');
    return runAction(event.sender, request.action, request.payload || {}, resourceDir);
  });
  ipcMain.handle('folder:open', (_event, kind) => openFolder(kind));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
