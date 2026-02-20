const { ipcRenderer } = require('electron');
window.ipcRenderer = ipcRenderer;
console.log('[AudioPreload] IPC Exposed');
