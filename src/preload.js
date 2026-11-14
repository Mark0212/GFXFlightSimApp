'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fl', {
  state: () => ipcRenderer.invoke('state'),
  link: () => ipcRenderer.invoke('link'),
  cancelLink: () => ipcRenderer.invoke('cancelLink'),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  setDemo: on => ipcRenderer.invoke('setDemo', !!on),
  setRate: r => ipcRenderer.invoke('setRate', r),
  setRemote: r => ipcRenderer.invoke('setRemote', r),
  open: which => ipcRenderer.invoke('open', which),
  copy: text => ipcRenderer.invoke('copy', text),
});
