'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const on = (ch, fn) => ipcRenderer.on(ch, (_, ...a) => fn(...a));
contextBridge.exposeInMainWorld('api', {
  getCfg: () => ipcRenderer.invoke('cfg:get'),
  setCfg: (c) => ipcRenderer.invoke('cfg:set', c),
  info: () => ipcRenderer.invoke('info'),
  ask: (t, q) => ipcRenderer.invoke('ask', t, q),
  shot: () => ipcRenderer.invoke('shot'),
  manual: () => ipcRenderer.invoke('manual'),
  listen: (on_) => ipcRenderer.invoke('listen', on_),
  clear: () => ipcRenderer.invoke('clear'),
  exportMd: () => ipcRenderer.invoke('export'),
  quit: () => ipcRenderer.send('quit'),
  // thu âm phía renderer (Windows/macOS)
  sendSegment: (buf, who) => ipcRenderer.send('audio:segment', buf, who),
  sendManual: (o) => ipcRenderer.send('audio:manual', o),
  onCap: (fn) => { on('cap:auto', (v, cfg) => fn('auto', v, cfg)); on('cap:manual-start', (cfg) => fn('manual-start', true, cfg)); on('cap:manual-stop', () => fn('manual-stop')); },
  onResult: (fn) => on('result', fn),
  onClickthrough: (fn) => on('clickthrough', fn),
  onOpenSettings: (fn) => on('open-settings', fn),
});
