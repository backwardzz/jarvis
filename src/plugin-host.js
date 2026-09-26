'use strict';
/**
 * Sandbox plugins run here, in a utility process: a plugin that hangs or crashes cannot take the HUD with it.
 * Each plugin is a CommonJS module with activate(ctx) and optional deactivate(); editing its file
 * swaps it in place — deactivate the old copy, drop it from the require cache, activate the new one.
 */
const fs = require('fs');
const path = require('path');

let dataDir = '';
const plugins = new Map(); // name -> { mod, handlers, timers, disposers, root }

const post = (msg) => process.parentPort.postMessage(msg);

function dataFile(name) {
  return path.join(dataDir, name + '.json');
}

function makeContext(name, record) {
  const guard = (fn) => (...args) => {
    try {
      const r = fn(...args);
      if (r && typeof r.catch === 'function') r.catch((e) => post({ type: 'error', name, message: String(e?.stack || e) }));
    } catch (e) {
      post({ type: 'error', name, message: String(e?.stack || e) });
    }
  };
  return {
    name,
    /** Registers a method callable from widgets (jarvis.call) and from Jarvis ([[call:plugin.method|args]]). */
    handle(method, fn) { record.handlers.set(String(method), fn); },
    /** Sends an event to every open widget (jarvis.on(event, cb)). */
    emit(event, data) { post({ type: 'emit', name, event: String(event), data }); },
    say(text) { post({ type: 'say', name, text: String(text) }); },
    notify(text, kind = '') { post({ type: 'notify', name, text: String(text), kind }); },
    ask(text) { post({ type: 'ask', name, text: String(text) }); },
    openWidget(id) { post({ type: 'open', name, widget: String(id) }); },
    closeWidget(id) { post({ type: 'close', name, widget: String(id) }); },
    log(...parts) { post({ type: 'log', name, message: parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ') }); },
    setInterval(fn, ms) { const t = setInterval(guard(fn), ms); record.timers.add(t); return t; },
    setTimeout(fn, ms) { const t = setTimeout(guard(fn), ms); record.timers.add(t); return t; },
    clearTimer(t) { clearInterval(t); clearTimeout(t); record.timers.delete(t); },
    onDispose(fn) { record.disposers.push(fn); },
    storage: {
      all() { try { return JSON.parse(fs.readFileSync(dataFile(name), 'utf8')); } catch { return {}; } },
      get(key) { return this.all()[key]; },
      set(key, value) {
        const all = this.all();
        if (value === undefined) delete all[key]; else all[key] = value;
        fs.writeFileSync(dataFile(name), JSON.stringify(all), 'utf8');
      },
    },
    dataDir,
  };
}

async function unload(name) {
  const rec = plugins.get(name);
  if (!rec) return;
  plugins.delete(name);
  for (const t of rec.timers) { clearInterval(t); clearTimeout(t); }
  try { await rec.mod?.deactivate?.(); } catch (e) { post({ type: 'error', name, message: 'deactivate: ' + e.message }); }
  for (const fn of rec.disposers.reverse()) { try { await fn(); } catch { /* best effort */ } }
  // forget every module the plugin pulled in from its own folder, so edits to helpers apply too
  for (const key of Object.keys(require.cache)) if (key.startsWith(rec.root)) delete require.cache[key];
}

async function load(name, file, dir) {
  await unload(name);
  const root = path.dirname(file) === dir ? file : path.dirname(file) + path.sep;
  const rec = { mod: null, handlers: new Map(), timers: new Set(), disposers: [], root };
  plugins.set(name, rec);
  delete require.cache[require.resolve(file)];
  try {
    rec.mod = require(file);
    if (typeof rec.mod.activate !== 'function') throw new Error('плагин должен экспортировать activate(ctx)');
    const ret = await rec.mod.activate(makeContext(name, rec));
    if (typeof ret === 'function') rec.disposers.push(ret);
  } catch (e) {
    await unload(name);
    throw e;
  }
}

async function call(name, method, args) {
  const rec = plugins.get(name);
  if (!rec) throw new Error(`плагин «${name}» не загружен`);
  const fn = rec.handlers.get(method);
  if (!fn) throw new Error(`у плагина «${name}» нет метода «${method}»; есть: ${[...rec.handlers.keys()].join(', ') || 'ничего'}`);
  return fn(...(Array.isArray(args) ? args : [args]));
}

process.parentPort.on('message', async ({ data: m }) => {
  if (m.type === 'init') {
    dataDir = m.dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    return;
  }
  const reply = (payload) => post({ type: 'result', id: m.id, ...payload });
  try {
    if (m.type === 'load') { await load(m.name, m.file, m.dir); reply({ value: true }); }
    else if (m.type === 'unload') { await unload(m.name); reply({ value: true }); }
    else if (m.type === 'call') {
      const value = await call(m.name, m.method, m.args);
      reply({ value: value === undefined ? null : JSON.parse(JSON.stringify(value)) });
    }
  } catch (e) {
    reply({ error: String(e?.message || e) });
  }
});

process.on('uncaughtException', (e) => post({ type: 'error', name: 'host', message: String(e?.stack || e) }));
process.on('unhandledRejection', (e) => post({ type: 'error', name: 'host', message: String(e?.stack || e) }));
