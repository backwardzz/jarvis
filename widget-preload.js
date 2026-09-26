'use strict';
/**
 * Preload for sandbox widget windows: a small, explicit `window.jarvis` API and the HUD title strip.
 * Widgets never see ipcRenderer or Node; everything goes through the widget:* channels, and the main
 * process answers only to windows it opened itself.
 */
const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('widget:hello') || {};
const BAR = 32;

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const listeners = new Set();

ipcRenderer.on('widget:event', (_e, ev) => {
  for (const l of listeners) {
    if (l.event !== '*' && l.event !== ev.event && l.event !== `${ev.plugin}.${ev.event}`) continue;
    try { l.cb(ev.data, ev); } catch (err) { console.error(err); }
  }
});

// stylesheet-only edits restyle the window in place instead of reloading it
ipcRenderer.on('widget:css', () => {
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const url = new URL(link.href, location.href);
    url.searchParams.set('v', Date.now());
    link.href = url.toString();
  }
});

contextBridge.exposeInMainWorld('jarvis', {
  widget: {
    id: info.id,
    title: info.title,
    close: () => ipcRenderer.invoke('widget:win', 'close'),
    minimize: () => ipcRenderer.invoke('widget:win', 'minimize'),
    setTitle: (title) => ipcRenderer.invoke('widget:win', 'title', [title]),
    resize: (width, height) => ipcRenderer.invoke('widget:win', 'resize', [width, height]),
    setAlwaysOnTop: (on) => ipcRenderer.invoke('widget:win', 'top', [on]),
  },
  /** Speak through JARVIS' voice. */
  say: invoke('widget:say'),
  /** HUD toast; kind: '', 'warn' or 'bad'. */
  notify: invoke('widget:notify'),
  /** Send a request to JARVIS as if the user typed it. */
  ask: invoke('widget:ask'),
  /** Call a sandbox plugin method: jarvis.call('timer', 'start', 300). */
  call: (plugin, method, ...args) => ipcRenderer.invoke('widget:call', plugin, method, args),
  /** Subscribe to plugin events: jarvis.on('tick', cb) or jarvis.on('timer.tick', cb); returns unsubscribe. */
  on: (event, cb) => {
    const l = { event: String(event), cb };
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** Per-window storage that survives edits and restarts. */
  store: { get: invoke('widget:store-get'), set: invoke('widget:store-set'), all: invoke('widget:store-all') },
  system: { stats: invoke('widget:stats'), weather: invoke('widget:weather') },
  projects: invoke('widget:projects'),
  open: invoke('widget:open'),
});

window.addEventListener('DOMContentLoaded', () => {
  const root = document.documentElement;
  root.classList.add('jarvis-widget', `jarvis-chrome-${info.chrome || 'inset'}`);
  if (info.chrome === 'none') return;
  const style = document.createElement('style');
  style.textContent = `
    html.jarvis-chrome-inset { padding-top: ${BAR}px !important; box-sizing: border-box; }
    #jarvis-titlebar {
      position: fixed; top: 0; left: 0; right: 0; height: ${BAR}px; z-index: 2147483647;
      display: flex; align-items: center; gap: 10px; padding: 0 150px 0 12px; box-sizing: border-box;
      -webkit-app-region: drag; user-select: none;
      font: 600 10.5px/1 'Orbitron', 'Exo 2', 'Segoe UI', sans-serif; letter-spacing: .24em; text-transform: uppercase;
      color: #d4f3ff; background: ${info.chrome === 'overlay' ? 'transparent' : '#041320'};
      border-bottom: 1px solid ${info.chrome === 'overlay' ? 'transparent' : 'rgba(67,229,255,.2)'};
    }
    #jarvis-titlebar i { width: 7px; height: 7px; border-radius: 50%; background: #43e5ff; box-shadow: 0 0 8px #43e5ff; flex: none; }
    #jarvis-titlebar span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `;
  const bar = document.createElement('div');
  bar.id = 'jarvis-titlebar';
  bar.innerHTML = '<i></i><span></span>';
  bar.querySelector('span').textContent = info.title || info.id || 'JARVIS';
  document.head.append(style);
  root.append(bar);
});
