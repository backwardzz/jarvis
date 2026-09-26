'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const listen = (ch) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('jarvis', {
  settings: { get: invoke('settings:get'), set: invoke('settings:set'), pickDir: invoke('dialog:pickDir') },
  projects: {
    list: invoke('projects:list'),
    check: invoke('projects:check'),
    add: invoke('projects:add'),
    remove: invoke('projects:remove'),
    capture: invoke('projects:capture'),
    openFolder: invoke('projects:openFolder'),
  },
  brain: {
    ask: invoke('brain:ask'),
    stop: invoke('brain:stop'),
    reset: invoke('brain:reset'),
    status: invoke('brain:status'),
    login: invoke('brain:login'),
    onEvent: listen('brain:event'),
  },
  tts: { synth: invoke('tts:synth'), prepare: invoke('tts:prepare'), onStatus: listen('tts:status') },
  phrases: { load: invoke('phrases:load'), read: invoke('phrases:read'), onStatus: listen('phrases:status') },
  macros: { route: invoke('macros:route'), runId: invoke('macros:runId'), block: invoke('macros:block'), list: invoke('macros:list'), onLoaded: listen('macros:loaded') },
  onNotice: listen('app:notice'),
  stt: { load: invoke('stt:load'), transcribe: invoke('stt:transcribe'), onStatus: listen('stt:status') },
  sys: { stats: invoke('sys:stats'), weather: invoke('sys:weather') },
  shell: { openExternal: invoke('shell:openExternal') },
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    onState: listen('win:state'),
  },
  onHotkey: listen('hotkey'),
  hot: { apply: invoke('hot:apply'), boot: invoke('hot:boot'), onPending: listen('hot:pending'), onCss: listen('hot:css') },
  sandbox: {
    list: invoke('sandbox:list'),
    open: invoke('sandbox:open'),
    close: invoke('sandbox:close'),
    call: invoke('sandbox:call'),
    errors: invoke('sandbox:errors'),
    onWidgets: listen('sandbox:widgets'),
    onCreated: listen('sandbox:created'),
    onUpdated: listen('sandbox:updated'),
    onPlugin: listen('sandbox:plugin'),
    onHud: listen('sandbox:hud'),
    onAction: listen('sandbox:action'),
    onError: listen('sandbox:error'),
    onEvent: listen('sandbox:event'),
  },
});
