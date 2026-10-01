/** Only the verification window can request completion or cancellation. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panedoraVerification', {
    complete: () => ipcRenderer.send('PANDORA:VERIFICATION_COMPLETE'),
    cancel: () => ipcRenderer.send('PANDORA:VERIFICATION_CANCEL')
});
