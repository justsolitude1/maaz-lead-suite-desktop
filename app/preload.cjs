const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('maazUpdates', {
  getStatus: () => ipcRenderer.invoke('updates:get-status'),
  check: () => ipcRenderer.invoke('updates:check'),
  install: () => ipcRenderer.invoke('updates:install'),
  onStatus: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('updates:status', listener);
    return () => ipcRenderer.removeListener('updates:status', listener);
  }
});
