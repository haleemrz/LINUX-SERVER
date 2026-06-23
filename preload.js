const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('Haleem', {
  getServerInfo: function () { return ipcRenderer.invoke('get-server-info'); },
  createKey: function (name, phone) { return ipcRenderer.invoke('create-key', { name: name, phone: phone }); },
  deleteKey: function (key) { return ipcRenderer.invoke('delete-key', key); },
  activateKey: function (key) { return ipcRenderer.invoke('activate-key', key); },
  revokeKey: function (key) { return ipcRenderer.invoke('revoke-key', key); },
  reactivateKey: function (key) { return ipcRenderer.invoke('reactivate-key', key); },
  pairDevice: function (fingerprint, name) { return ipcRenderer.invoke('pair-device', { fingerprint: fingerprint, name: name }); },
  unpairDevice: function () { return ipcRenderer.invoke('unpair-device'); },
  refreshState: function () { return ipcRenderer.invoke('refresh-state'); },
  copyText: function (text) { return ipcRenderer.invoke('copy-text', text); },
  exportData: function () { return ipcRenderer.invoke('export-data'); },
  getPublicIP: function () { return ipcRenderer.invoke('get-public-ip'); },
  onServerInfo: function (cb) { ipcRenderer.on('server-info', function (e, d) { cb(d); }); },
  onLog: function (cb) { ipcRenderer.on('log', function (e, d) { cb(d); }); },
  onStateUpdate: function (cb) { ipcRenderer.on('state-update', function (e, d) { cb(d); }); },
  onKeyCreated: function (cb) { ipcRenderer.on('key-created', function (e, d) { cb(d); }); },
  onKeyDeleted: function (cb) { ipcRenderer.on('key-deleted', function (e, d) { cb(d); }); },
  onDevicePaired: function (cb) { ipcRenderer.on('device-paired', function (e, d) { cb(d); }); },
  onDeviceUnpaired: function (cb) { ipcRenderer.on('device-unpaired', function (e) { cb(); }); },
  onTunnelUrl: function (cb) { ipcRenderer.on('tunnel-url', function (e, d) { cb(d); }); }
});
