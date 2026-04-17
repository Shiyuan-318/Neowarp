const {contextBridge, ipcRenderer} = require('electron');

let frameCallback = null;
let closeCallback = null;

contextBridge.exposeInMainWorld('DetachedStagePreload', {
  onFrame: (callback) => {
    frameCallback = callback;
  },
  onClose: (callback) => {
    closeCallback = callback;
  },
  sendInput: (inputData) => {
    ipcRenderer.send('detached-stage-input', inputData);
  },
  ready: () => {
    ipcRenderer.send('detached-stage-ready');
  }
});

ipcRenderer.on('stage-frame', (event, dataURL) => {
  if (frameCallback) {
    frameCallback(dataURL);
  }
});

ipcRenderer.on('close-detached-stage', () => {
  if (closeCallback) {
    closeCallback();
  }
});
