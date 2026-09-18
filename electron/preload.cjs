const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ax3600', {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  detect: () => ipcRenderer.invoke('router:detect'),
  runAction: (action, payload = {}) => ipcRenderer.invoke('action:run', { action, payload }),
  openFolder: (kind) => ipcRenderer.invoke('folder:open', kind),
  onProgress: (listener) => {
    const handler = (_event, data) => listener(data);
    ipcRenderer.on('action:progress', handler);
    return () => ipcRenderer.removeListener('action:progress', handler);
  },
});
