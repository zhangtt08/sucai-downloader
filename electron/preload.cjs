const { contextBridge, ipcRenderer } = require('electron');

// 只暴露白名单方法，不把 ipcRenderer 本体交给渲染层。
contextBridge.exposeInMainWorld('electron', {
  search: (params) => ipcRenderer.invoke('search', params),
  onSearchSource: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('search-source', h);
    return () => ipcRenderer.removeListener('search-source', h);
  },
  probeSource: (name) => ipcRenderer.invoke('probe-source', { name }),
  assetDetail: (source, sourceId) => ipcRenderer.invoke('asset-detail', { source, sourceId }),

  downloadStart: (items, destDir, query) => ipcRenderer.invoke('download-start', { items, destDir, query }),
  downloadPause: (batchId) => ipcRenderer.invoke('download-pause', batchId),
  downloadResume: (batchId) => ipcRenderer.invoke('download-resume', batchId),
  downloadCancel: (batchId) => ipcRenderer.invoke('download-cancel', batchId),
  onDownloadEvent: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('download-event', h);
    return () => ipcRenderer.removeListener('download-event', h);
  },
  downloadLog: (params) => ipcRenderer.invoke('download-log', params),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  validateTemplate: (kind, value) => ipcRenderer.invoke('validate-template', { kind, value }),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  getPlugins: () => ipcRenderer.invoke('get-plugins'),
  openInFolder: (fp) => ipcRenderer.invoke('open-in-folder', fp),
  openDirectory: (dir) => ipcRenderer.invoke('open-directory', dir),
  diskInfo: (dir) => ipcRenderer.invoke('disk-info', dir),
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: (cb) => {
      const h = (_e, v) => cb(v);
      ipcRenderer.on('window:maximized', h);
      return () => ipcRenderer.removeListener('window:maximized', h);
    },
  },
});
