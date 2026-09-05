'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('imager', {
  info: () => ipcRenderer.invoke('app:info'),
  relaunchElevated: () => ipcRenderer.invoke('app:relaunch-elevated'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  latestRelease: () => ipcRenderer.invoke('release:latest'),
  pickImage: () => ipcRenderer.invoke('image:pick'),
  downloadImage: (release) => ipcRenderer.invoke('image:download', release),
  onDownloadProgress: (cb) => ipcRenderer.on('image:progress', (_e, p) => cb(p)),

  buildStatus: () => ipcRenderer.invoke('build:status'),
  startBuild: (opts) => ipcRenderer.invoke('build:start', opts),
  cancelBuild: () => ipcRenderer.invoke('build:cancel'),
  onBuildProgress: (cb) => ipcRenderer.on('build:progress', (_e, p) => cb(p)),

  listDrives: () => ipcRenderer.invoke('drives:list'),

  write: (opts) => ipcRenderer.invoke('write:start', opts),
  onWriteProgress: (cb) => ipcRenderer.on('write:progress', (_e, p) => cb(p)),

  saveImageDialog: (opts) => ipcRenderer.invoke('image:save-dialog', opts),
  exportImage: (opts) => ipcRenderer.invoke('image:export', opts),
  onExportProgress: (cb) => ipcRenderer.on('export:progress', (_e, p) => cb(p)),
  showItemInFolder: (path) => ipcRenderer.invoke('app:show-item', path),
});
