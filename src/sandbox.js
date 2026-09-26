'use strict';
/**
 * JARVIS sandbox: live windows, Node plugins and HUD mods that Claude writes into one folder.
 * Nothing here needs a restart:
 *   widgets/<id>/index.html (+ widget.json) -> a frameless HUD window, reloaded on every edit
 *   plugins/<id>.js                          -> Node logic in a utility process, hot-swapped on every edit
 *   hud/hud.css, hud/hud.js                  -> live additions to the main HUD (applied by the renderer)
 * Status and recent errors are mirrored to <root>/.status.json so Claude can check its own work.
 */
const { BrowserWindow, utilityProcess, shell } = require('electron');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PARTITION = 'persist:sandbox';
const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/i;
const BAR = 32; // height of the widget title strip, see widget-preload.js

const clamp = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : dflt);

/** Parses a CommonJS file without running it; returns an error message or null. */
function syntaxError(file) {
  try {
    const src = fs.readFileSync(file, 'utf8');
    new vm.Script(`(function (exports, require, module, __filename, __dirname) {${src}\n})`, { filename: file });
    return null;
  } catch (e) {
    return e.message;
  }
}

class Sandbox extends EventEmitter {
  constructor({ root, dataDir, preload, hostScript, icon, log }) {
    super();
    Object.assign(this, { root, dataDir, preload, hostScript, icon, log });
    this.windows = new Map(); // id -> BrowserWindow
    this.owners = new Map(); // webContents.id -> id
    this.known = new Set();
    this.plugins = new Map(); // name -> { ok, error }
    this.errors = [];
    this.reported = 0;
    this.pending = new Map(); // host call id -> { resolve, reject }
    this.nextCall = 1;
    this.timers = new Map();
    this.stateFile = path.join(dataDir, 'state.json');
    try { this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { this.state = {}; }
    this.state.bounds ||= {};
    this.state.open ||= [];
  }

  // ------------------------------------------------------------ lifecycle
  start() {
    for (const d of ['widgets', 'plugins', 'hud']) fs.mkdirSync(path.join(this.root, d), { recursive: true });
    fs.mkdirSync(path.join(this.dataDir, 'widgets'), { recursive: true });
    fs.mkdirSync(path.join(this.dataDir, 'plugins'), { recursive: true });
    for (const w of this.list()) this.known.add(w.id);
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_ev, name) => name && this.changed(String(name)));
    } catch (e) {
      this.error('sandbox', 'не удалось следить за папкой: ' + e.message);
    }
    this.startHost();
    for (const name of this.pluginNames()) this.loadPlugin(name);
    this.writeStatus();
  }

  /** Reopens the windows that were open when JARVIS last closed or relaunched. */
  restore() {
    for (const id of this.state.open) {
      try { this.open(id, { focus: false }); } catch { /* the widget is gone */ }
    }
  }

  stop() {
    this.stopping = true;
    this.watcher?.close();
    this.state.open = [...this.windows.keys()];
    this.saveState(true);
    this.host?.kill();
  }

  // ------------------------------------------------------------ widgets
  manifest(id) {
    if (!ID.test(id)) return null;
    const dir = path.join(this.root, 'widgets', id);
    if (!fs.existsSync(path.join(dir, 'index.html'))) return null;
    let m = {};
    const file = path.join(dir, 'widget.json');
    if (fs.existsSync(file)) {
      try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { this.error(`widgets/${id}/widget.json`, e.message); }
    }
    return {
      id,
      title: String(m.title || id).slice(0, 80),
      description: String(m.description || '').slice(0, 200),
      width: clamp(m.width, 220, 3000, 440),
      height: clamp(m.height, 140, 2000, 340),
      alwaysOnTop: !!m.alwaysOnTop,
      transparent: !!m.transparent,
      resizable: m.resizable !== false,
      chrome: m.transparent ? 'none' : ['inset', 'overlay', 'none'].includes(m.chrome) ? m.chrome : 'inset',
      autoOpen: m.autoOpen !== false,
    };
  }

  list() {
    let ids = [];
    try { ids = fs.readdirSync(path.join(this.root, 'widgets')); } catch { /* no folder yet */ }
    return ids.map((id) => this.manifest(id)).filter(Boolean).map((m) => ({ ...m, open: this.windows.has(m.id) }));
  }

  widgetOf(webContents) {
    return this.owners.get(webContents.id) || null;
  }

  open(id, { focus = true } = {}) {
    const m = this.manifest(id);
    if (!m) throw new Error(`окно «${id}» не найдено: нужен файл sandbox\\widgets\\${id}\\index.html`);
    const existing = this.windows.get(id);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      if (focus) existing.focus();
      return true;
    }
    const b = this.state.bounds[id] || {};
    const w = new BrowserWindow({
      width: b.width || m.width,
      height: b.height || m.height,
      x: b.x,
      y: b.y,
      minWidth: 220,
      minHeight: 140,
      frame: false,
      titleBarStyle: m.chrome === 'none' ? undefined : 'hidden',
      titleBarOverlay: m.chrome === 'none' ? false : { color: '#041320', symbolColor: '#43e5ff', height: BAR },
      transparent: m.transparent,
      backgroundColor: m.transparent ? '#00000000' : '#02070d',
      alwaysOnTop: m.alwaysOnTop,
      resizable: m.resizable,
      title: `${m.title} — JARVIS`,
      icon: this.icon,
      show: false,
      webPreferences: {
        preload: this.preload,
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    const contentsId = w.webContents.id;
    this.windows.set(id, w);
    this.owners.set(contentsId, id);
    const base = `app://jarvis/sandbox/widgets/${id}/`;

    w.once('ready-to-show', () => { w.showInactive(); if (focus) w.focus(); });
    const remember = () => {
      if (w.isDestroyed() || w.isMinimized() || w.isMaximized()) return;
      this.state.bounds[id] = w.getBounds();
      this.saveState();
    };
    w.on('moved', remember);
    w.on('resized', remember);
    w.on('closed', () => {
      this.windows.delete(id);
      this.owners.delete(contentsId);
      if (!this.stopping) {
        this.state.open = [...this.windows.keys()];
        this.saveState();
        this.emitList();
      }
    });
    w.webContents.on('console-message', (e) => {
      if (e.level === 'error') this.error(`widgets/${id}`, `${e.message}${e.sourceId ? ` (${path.basename(e.sourceId)}:${e.lineNumber})` : ''}`);
    });
    w.webContents.on('did-fail-load', (_e, code, desc, url) => { if (code !== -3) this.error(`widgets/${id}`, `не загрузилось ${url}: ${desc}`); });
    w.webContents.on('render-process-gone', (_e, d) => this.error(`widgets/${id}`, `окно упало: ${d.reason}`));
    w.webContents.on('will-navigate', (e, url) => {
      if (url.startsWith(base)) return;
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    });
    w.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    w.loadURL(base + 'index.html');
    this.state.open = [...this.windows.keys()];
    this.saveState();
    this.emitList();
    this.log('sandbox open', id);
    return true;
  }

  close(id) {
    const w = this.windows.get(id);
    if (w && !w.isDestroyed()) w.close();
    return !!w;
  }

  winOp(id, op, args = []) {
    const w = this.windows.get(id);
    if (!w || w.isDestroyed()) return false;
    if (op === 'close') w.close();
    else if (op === 'minimize') w.minimize();
    else if (op === 'focus') { w.show(); w.focus(); }
    else if (op === 'title') w.setTitle(`${String(args[0] || id).slice(0, 80)} — JARVIS`);
    else if (op === 'resize') w.setSize(clamp(args[0], 220, 3000, 440), clamp(args[1], 140, 2000, 340));
    else if (op === 'top') w.setAlwaysOnTop(!!args[0]);
    return true;
  }

  send(id, channel, payload) {
    const w = this.windows.get(id);
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }

  broadcast(channel, payload) {
    for (const id of this.windows.keys()) this.send(id, channel, payload);
  }

  // per-widget storage in the user profile, so it survives edits to the widget itself
  storeFile(id) {
    return path.join(this.dataDir, 'widgets', id + '.json');
  }

  storeAll(id) {
    try { return JSON.parse(fs.readFileSync(this.storeFile(id), 'utf8')); } catch { return {}; }
  }

  storeSet(id, key, value) {
    const all = this.storeAll(id);
    if (value === undefined) delete all[key]; else all[key] = value;
    const json = JSON.stringify(all);
    if (json.length > 5 * 1024 * 1024) throw new Error('хранилище окна больше 5 МБ');
    fs.writeFileSync(this.storeFile(id), json, 'utf8');
    return true;
  }

  // ------------------------------------------------------------ file watching
  changed(rel) {
    const parts = rel.split(/[\\/]/);
    if (parts.some((p) => p.startsWith('.') || p === 'node_modules') || /~$|\.tmp$|\.swp$/.test(rel)) return;
    const [area, second] = parts;
    const key = area === 'widgets' || area === 'plugins' ? `${area}/${(second || '').replace(/\.js$/, '')}` : area;
    const files = this.timers.get(key)?.files || new Set();
    files.add(rel);
    clearTimeout(this.timers.get(key)?.timer);
    // editors write in bursts; act once the dust settles
    this.timers.set(key, { files, timer: setTimeout(() => { this.timers.delete(key); this.apply(area, second, [...files]); }, 250) });
  }

  apply(area, name, files) {
    if (area === 'widgets' && name) {
      const id = name;
      const m = this.manifest(id);
      if (!m) {
        if (this.known.delete(id)) { this.close(id); this.emitList(); }
        return;
      }
      if (!this.known.has(id)) {
        this.known.add(id);
        this.emit('created', m);
        if (m.autoOpen) this.open(id);
        else this.emitList();
        return;
      }
      const w = this.windows.get(id);
      if (w && !w.isDestroyed()) {
        if (files.every((f) => f.endsWith('.css'))) this.send(id, 'widget:css');
        else {
          w.setTitle(`${m.title} — JARVIS`);
          w.setAlwaysOnTop(m.alwaysOnTop);
          w.webContents.reloadIgnoringCache();
        }
        this.emit('updated', m);
      }
      if (files.some((f) => f.endsWith('widget.json'))) this.emitList();
    } else if (area === 'plugins' && name) {
      this.loadPlugin(name.replace(/\.js$/, ''));
    } else if (area === 'hud') {
      this.emit('hud', { css: files.some((f) => f.endsWith('.css')), js: files.some((f) => f.endsWith('.js')), v: Date.now() });
    } else if (area === 'kit') {
      this.broadcast('widget:css');
    }
    this.writeStatus();
  }

  emitList() {
    this.emit('widgets', this.list());
    this.writeStatus();
  }

  // ------------------------------------------------------------ plugins (utility process)
  pluginNames() {
    let entries = [];
    try { entries = fs.readdirSync(path.join(this.root, 'plugins'), { withFileTypes: true }); } catch { /* none */ }
    return entries
      .filter((e) => (e.isFile() && e.name.endsWith('.js')) || (e.isDirectory() && fs.existsSync(path.join(this.root, 'plugins', e.name, 'index.js'))))
      .map((e) => e.name.replace(/\.js$/, ''))
      .filter((n) => ID.test(n));
  }

  pluginFile(name) {
    const flat = path.join(this.root, 'plugins', name + '.js');
    if (fs.existsSync(flat)) return flat;
    const nested = path.join(this.root, 'plugins', name, 'index.js');
    return fs.existsSync(nested) ? nested : null;
  }

  startHost() {
    const host = utilityProcess.fork(this.hostScript, [], { serviceName: 'JARVIS sandbox plugins', stdio: 'pipe' });
    host.stdout?.on('data', (d) => this.log('plugin', String(d).trim()));
    host.stderr?.on('data', (d) => this.error('plugins', String(d).trim().slice(0, 400)));
    host.on('message', (m) => this.fromHost(m));
    host.on('exit', (code) => {
      for (const p of this.pending.values()) p.reject(new Error('процесс плагинов завершился'));
      this.pending.clear();
      if (this.host === host) this.host = null;
      if (this.stopping) return;
      this.error('plugins', `процесс плагинов завершился (код ${code}), перезапускаю`);
      this.restarts = (this.restarts || 0) + 1;
      setTimeout(() => {
        this.startHost();
        for (const name of this.pluginNames()) this.loadPlugin(name);
      }, Math.min(10000, 500 * this.restarts));
    });
    this.host = host;
    host.postMessage({ type: 'init', dataDir: path.join(this.dataDir, 'plugins') });
  }

  hostCall(msg, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.host) return reject(new Error('процесс плагинов не запущен'));
      const id = this.nextCall++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('плагин не ответил за ' + timeoutMs / 1000 + ' с')); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.host.postMessage({ ...msg, id });
    });
  }

  async loadPlugin(name) {
    const file = this.pluginFile(name);
    if (!file) {
      if (this.plugins.delete(name)) await this.hostCall({ type: 'unload', name }).catch(() => {});
      this.writeStatus();
      return;
    }
    const bad = syntaxError(file);
    if (bad) {
      this.plugins.set(name, { ok: false, error: bad });
      this.error(`plugins/${name}`, bad);
      return;
    }
    try {
      await this.hostCall({ type: 'load', name, file, dir: path.join(this.root, 'plugins') });
      this.plugins.set(name, { ok: true, error: null });
      this.log('sandbox plugin loaded', name);
      this.emit('plugin', { name, ok: true });
    } catch (e) {
      this.plugins.set(name, { ok: false, error: e.message });
      this.error(`plugins/${name}`, e.message);
    }
    this.writeStatus();
  }

  call(plugin, method, args = []) {
    if (!this.plugins.get(plugin)?.ok) return Promise.reject(new Error(`плагин «${plugin}» не загружен`));
    return this.hostCall({ type: 'call', name: plugin, method, args });
  }

  fromHost(m) {
    if (m.type === 'result') {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (p) (m.error ? p.reject(new Error(m.error)) : p.resolve(m.value));
    } else if (m.type === 'emit') {
      this.broadcast('widget:event', { plugin: m.name, event: m.event, data: m.data });
      this.emit('event', { plugin: m.name, event: m.event, data: m.data });
    } else if (m.type === 'error') {
      this.error(`plugins/${m.name || '?'}`, m.message);
    } else if (m.type === 'log') {
      this.log(`plugin ${m.name}`, m.message);
    } else if (['say', 'notify', 'ask', 'open', 'close'].includes(m.type)) {
      if (m.type === 'open') { try { this.open(String(m.widget)); } catch (e) { this.error(`plugins/${m.name}`, e.message); } return; }
      if (m.type === 'close') { this.close(String(m.widget)); return; }
      this.emit('action', { type: m.type, text: String(m.text || '').slice(0, 2000), kind: m.kind, source: `plugins/${m.name}` });
    }
  }

  // ------------------------------------------------------------ status & errors
  error(source, message) {
    const entry = { source, message: String(message).slice(0, 600), at: new Date().toISOString() };
    const last = this.errors[this.errors.length - 1];
    if (last && last.source === entry.source && last.message === entry.message) return; // console spam
    this.errors.push(entry);
    if (this.errors.length > 30) { this.errors.shift(); this.reported = Math.max(0, this.reported - 1); }
    this.log('sandbox error', entry);
    this.emit('error', entry);
    this.writeStatus();
  }

  /** Errors Claude has not been told about yet (goes into the next HUD context line). */
  takeNewErrors() {
    const fresh = this.errors.slice(this.reported);
    this.reported = this.errors.length;
    return fresh;
  }

  summary() {
    const widgets = this.list();
    const open = widgets.filter((w) => w.open).map((w) => w.id);
    const plugins = [...this.plugins].map(([n, p]) => (p.ok ? n : `${n} (ошибка)`));
    return { widgets: widgets.map((w) => w.id), open, plugins };
  }

  writeStatus() {
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => {
      const status = {
        updatedAt: new Date().toISOString(),
        note: 'Состояние песочницы JARVIS (обновляется автоматически, не редактируйте).',
        widgets: this.list(),
        plugins: Object.fromEntries(this.plugins),
        errors: this.errors,
      };
      try { fs.writeFileSync(path.join(this.root, '.status.json'), JSON.stringify(status, null, 2), 'utf8'); } catch { /* read-only */ }
    }, 200);
  }

  saveState(now = false) {
    clearTimeout(this.saveTimer);
    const write = () => { try { fs.writeFileSync(this.stateFile, JSON.stringify(this.state), 'utf8'); } catch { /* ignore */ } };
    if (now) write(); else this.saveTimer = setTimeout(write, 400);
  }
}

module.exports = { Sandbox, PARTITION, syntaxError };
