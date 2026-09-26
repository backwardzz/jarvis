'use strict';
/**
 * Voice macros: instant commands that never reach Claude. Idea and matching come from Priler/jarvis
 * (phrases + fuzzy score 60 % characters / 40 % words, threshold 75), actions are native to JARVIS.
 * Macros live in sandbox\macros\*.json, so edits apply on the fly and Jarvis can write new ones himself.
 *
 *   { "macros": [ { "id": "mute", "phrases": ["выключи звук"], "do": { "type": "volume", "mute": "on" } } ] }
 *
 * Phrases may carry slots: "громкость {number}", "таймер на {duration}", "найди в ютубе {text}".
 * The format of every action is described in sandbox\README.md.
 */
const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { norm, similarity, parseNumber, parseDuration } = require('./rutext');

const THRESHOLD = 75;
const NAME = /^(?:(?:эй|ну|окей|ok|hey)\s+)?(?:джарви\p{L}*|джерви\p{L}*|жарви\p{L}*|jarvis)\s*/u;
const FILLERS = /^(?:(?:пожалуйста|будь добр[аы]?|слушай|ну|а|сэр)\s+)+|(?:\s+(?:пожалуйста|сэр))+$/u;
const RENDERER_ACTIONS = new Set(['say', 'ask', 'hud', 'quit', 'notify']);

function clean(text) {
  return norm(text).replace(NAME, '').replace(FILLERS, '').trim();
}

function slotKind(name) {
  if (/^(number|percent|volume|n|level)$/.test(name)) return 'number';
  if (/^(duration|time|seconds)$/.test(name)) return 'duration';
  return 'text';
}

function parseSlot(name, raw) {
  const kind = slotKind(name);
  if (kind === 'number') {
    const n = parseNumber(raw);
    return n === null ? null : { value: n, raw };
  }
  if (kind === 'duration') {
    const s = parseDuration(raw);
    return s === null ? null : { value: s, raw };
  }
  return raw.trim() ? { value: raw.trim(), raw: raw.trim() } : null;
}

/** "${number}" → 50 (typed), "Громкость ${number}%" → "Громкость 50%", "${text.url}" → encoded. */
function fill(value, vars) {
  if (typeof value === 'string') {
    const whole = value.match(/^\$\{([\w-]+)\}$/);
    if (whole && whole[1] in vars) return vars[whole[1]];
    return value.replace(/\$\{([\w-]+)(?:\.(raw|url))?\}/g, (m, key, mod) => {
      if (!(key in vars)) return m;
      if (mod === 'url') return encodeURIComponent(String(vars[`${key}.raw`] ?? vars[key]));
      if (mod === 'raw') return String(vars[`${key}.raw`] ?? vars[key]);
      return String(vars[key]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

function compilePhrase(phrase) {
  const text = clean(phrase.replace(/\{(\w+)\}/g, ' slotmark$1 '));
  const slots = [];
  if (!/slotmark/.test(text)) return { text, slots };
  const source = text.split(' ').map((w) => {
    const m = w.match(/^slotmark(\w+)$/);
    if (!m) return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    slots.push(m[1]);
    return '(.+?)';
  }).join(' ');
  return { text, slots, re: new RegExp(`^${source}$`, 'u') };
}

const quote = (a) => (/[\s"&|<>^()]/.test(a) || !a ? `"${String(a).replace(/"/g, '""')}"` : a);

class Macros extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dir          folder with *.json macro files
   * @param {object} [o.host]       WinHost for keys/volume/system actions
   * @param {object} [o.sandbox]    Sandbox for window/plugin actions and window names
   * @param {object} [o.shell]      electron.shell
   * @param {object} [o.clipboard]  electron.clipboard
   * @param {string} [o.dataDir]    scratch folder (inline AutoHotkey scripts)
   * @param {string} [o.picturesDir]
   */
  constructor({ dir, host, sandbox, shell, clipboard, dataDir, picturesDir, log = () => {} }) {
    super();
    Object.assign(this, { dir, host, sandbox, shell, clipboard, dataDir, picturesDir, log });
    this.list = [];
    this.errors = [];
  }

  // ------------------------------------------------------------ loading
  load() {
    const list = [];
    const errors = [];
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort(); } catch { /* no folder yet */ }
    for (const file of files) {
      const source = `macros/${file}`;
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8'));
      } catch (e) {
        errors.push({ source, message: e.message });
        continue;
      }
      if (data.platform && data.platform !== process.platform) continue;
      const macros = Array.isArray(data) ? data : data.macros;
      if (!Array.isArray(macros)) { errors.push({ source, message: 'нужен массив "macros"' }); continue; }
      macros.forEach((m, i) => {
        const id = `${file.replace(/\.json$/, '')}.${m.id || i + 1}`;
        if (m.enabled === false) return;
        const phrases = (Array.isArray(m.phrases) ? m.phrases : [m.phrases]).filter((p) => typeof p === 'string' && p.trim());
        if (!phrases.length) { errors.push({ source, message: `${id}: нет фраз ("phrases")` }); return; }
        if (!m.do && !m.say && m.sound === undefined) { errors.push({ source, message: `${id}: нечего делать (нужны "do", "say" или "sound")` }); return; }
        list.push({ ...m, id, file, phrases, compiled: phrases.map(compilePhrase), threshold: Number(m.threshold) || THRESHOLD });
      });
    }
    this.list = list;
    this.errors = errors;
    for (const e of errors) this.emit('problem', e);
    this.emit('loaded', this.summary());
    return this.list.length;
  }

  summary() {
    return { count: this.list.length, files: [...new Set(this.list.map((m) => m.file))], errors: this.errors };
  }

  /** Windows of the sandbox as ready-made macros: "открой заметки", "закрой таймер". */
  widgetMacros() {
    const out = [];
    for (const w of this.sandbox?.list?.() || []) {
      const title = norm(w.title);
      if (!title) continue;
      const names = [...new Set([title, norm(w.id)])];
      out.push({
        id: `sandbox.open-${w.id}`, sound: 'ok', do: { type: 'window', id: w.id }, threshold: 85,
        compiled: names.flatMap((n) => [`открой ${n}`, `покажи ${n}`, `открой окно ${n}`]).map(compilePhrase),
      });
      out.push({
        id: `sandbox.close-${w.id}`, sound: 'ok', do: { type: 'close-window', id: w.id }, threshold: 85,
        compiled: names.flatMap((n) => [`закрой ${n}`, `убери ${n}`, `закрой окно ${n}`]).map(compilePhrase),
      });
    }
    return out;
  }

  // ------------------------------------------------------------ matching
  /** Best macro for an utterance, or null. Long free-form requests are left to Claude. */
  match(text) {
    const input = clean(text);
    if (!input) return null;
    const words = input.split(' ').length;
    let best = null;
    for (const macro of [...this.list, ...this.widgetMacros()]) {
      for (const p of macro.compiled) {
        if (p.re) {
          const m = input.match(p.re);
          if (!m) continue;
          const slots = {};
          let ok = true;
          p.slots.forEach((name, i) => {
            const v = parseSlot(name, m[i + 1]);
            if (!v) ok = false; else slots[name] = v;
          });
          // an exact template beats any fuzzy hit; among templates the one with more fixed words wins
          const score = 100 + (p.text.split(' ').length - p.slots.length);
          if (ok && score > (best?.score || 0)) best = { macro, slots, score };
          continue;
        }
        if (words > p.text.split(' ').length + 3) continue;
        const score = input === p.text ? 100 : similarity(input, p.text);
        if (score >= macro.threshold && score > (best?.score || 0)) best = { macro, slots: {}, score };
      }
    }
    return best;
  }

  // ------------------------------------------------------------ running
  /**
   * Matches and runs a macro. Returns null when nothing matched, otherwise
   * { id, score, value, reply: { sound, say, notify }, hud: [renderer actions], error }.
   */
  async run(text) {
    const hit = this.match(text);
    if (!hit) return null;
    const { macro, slots, score } = hit;
    const vars = {};
    for (const [k, v] of Object.entries(slots)) { vars[k] = v.value; vars[`${k}.raw`] = v.raw; }
    const actions = [].concat(macro.do || []).map((a) => fill(a, vars));
    const hud = [];
    let value = null;
    let error = null;
    this.log('macro', macro.id, Math.round(score), JSON.stringify(slots));
    try {
      for (const a of actions) {
        if (RENDERER_ACTIONS.has(a.type)) { hud.push(a); continue; }
        value = await this.exec(a, macro);
      }
    } catch (e) {
      error = e.message;
    }
    vars.result = value ?? '';
    const reply = {
      sound: macro.say ? (macro.sound || '') : (macro.sound ?? 'ok'),
      say: macro.say ? fill(macro.say, vars) : '',
      notify: macro.notify ? fill(macro.notify, vars) : '',
    };
    return { id: macro.id, score: Math.round(score), value, reply, hud, error };
  }

  async exec(a, macro) {
    switch (a.type) {
      case 'open': return this.open(String(a.target || ''), [].concat(a.args || []).map(String));
      case 'run': return this.runCommand(String(a.cmd || ''), a.cwd);
      case 'close': return this.closeProcess([].concat(a.process || []), !!a.force);
      case 'keys': return this.needHost().keys(a.keys, Number(a.delay) || 60);
      case 'volume': {
        const args = {};
        if (a.set !== undefined) args.set = Math.round(Number(a.set));
        if (a.delta !== undefined) args.delta = Math.round(Number(a.delta));
        if (a.mute !== undefined) args.mute = a.mute === true ? 'on' : a.mute === false ? 'off' : String(a.mute);
        if (Object.values(args).some((v) => typeof v === 'number' && !Number.isFinite(v))) throw new Error('громкость должна быть числом');
        return this.needHost().call('volume', args);
      }
      case 'media': {
        const key = { play: 'MEDIA_PLAY_PAUSE', pause: 'MEDIA_PLAY_PAUSE', toggle: 'MEDIA_PLAY_PAUSE', next: 'MEDIA_NEXT', prev: 'MEDIA_PREV', stop: 'MEDIA_STOP' }[a.action];
        if (!key) throw new Error(`media: неизвестное действие ${a.action}`);
        return this.needHost().keys(key);
      }
      case 'system': {
        const op = String(a.action || '');
        if (!['lock', 'sleep', 'minimize-all', 'empty-trash', 'screenshot'].includes(op)) throw new Error(`system: неизвестное действие ${op}`);
        const dir = a.dir || path.join(this.picturesDir || os.homedir(), 'JARVIS');
        return this.needHost().call(op, op === 'screenshot' ? { dir } : {});
      }
      case 'powershell': return this.needHost().call('script', { script: String(a.script || '') }, 60000);
      case 'paste': {
        if (!this.clipboard) throw new Error('буфер обмена недоступен');
        this.clipboard.writeText(String(a.text ?? ''));
        await new Promise((r) => setTimeout(r, 80));
        return this.needHost().keys('Ctrl+V');
      }
      case 'ahk': return this.ahk(a, macro);
      case 'window': return this.sandbox.open(String(a.id));
      case 'close-window': return this.sandbox.close(String(a.id));
      case 'plugin': return this.sandbox.call(String(a.plugin), String(a.method), [].concat(a.args ?? []));
      case 'wait': return new Promise((r) => setTimeout(() => r(true), Math.min(10000, Number(a.ms) || 0)));
      default: throw new Error(`неизвестный тип действия «${a.type}»`);
    }
  }

  needHost() {
    if (!this.host?.supported) throw new Error('это действие работает только в Windows');
    return this.host;
  }

  /** URL, protocol link, file, folder or an app name Windows knows ("calc", "notepad", "chrome"). */
  async open(target, args = []) {
    if (!target) throw new Error('open: не указано, что открыть');
    if (/^[a-z][a-z0-9+.-]+:/i.test(target) && !args.length) {
      await this.shell.openExternal(target);
      return true;
    }
    if (path.isAbsolute(target) && fs.existsSync(target) && !args.length) {
      const err = await this.shell.openPath(target);
      if (err) throw new Error(err);
      return true;
    }
    if (process.platform !== 'win32') {
      spawn(target, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      return true;
    }
    return this.runCommand(`start "" ${[target, ...args].map(quote).join(' ')}`);
  }

  runCommand(cmd, cwd) {
    if (!cmd) throw new Error('run: пустая команда');
    const opts = { detached: true, stdio: 'ignore', windowsHide: true, cwd: cwd || os.homedir() };
    const child = process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { ...opts, windowsVerbatimArguments: true })
      : spawn('sh', ['-c', cmd], opts);
    return new Promise((resolve, reject) => {
      child.once('error', (e) => reject(new Error('не удалось запустить: ' + e.message)));
      child.once('spawn', () => { child.unref(); resolve(true); });
    });
  }

  closeProcess(names, force) {
    if (!names.length) throw new Error('close: не указан процесс');
    if (process.platform !== 'win32') throw new Error('это действие работает только в Windows');
    const args = names.flatMap((n) => ['/IM', /\.exe$/i.test(n) ? n : `${n}.exe`]);
    args.push('/T');
    if (force) args.push('/F');
    return new Promise((resolve) => {
      execFile('taskkill', args, { windowsHide: true, timeout: 8000 }, (err) => resolve(!err));
    });
  }

  /** AutoHotkey: a compiled .exe, an .ahk file next to the macro, or inline "code". */
  async ahk(a, macro) {
    let file = a.file ? String(a.file) : '';
    if (!file && a.code) {
      const dir = path.join(this.dataDir || os.tmpdir(), 'ahk');
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, `${macro.id.replace(/[^\w.-]/g, '_')}.ahk`);
      fs.writeFileSync(file, '﻿' + String(a.code), 'utf8');
    }
    if (!file) throw new Error('ahk: нужен "file" или "code"');
    if (!path.isAbsolute(file)) file = path.join(this.dir, file);
    if (!fs.existsSync(file)) throw new Error(`ahk: нет файла ${file}`);
    const args = [].concat(a.args || []).map(String);
    if (/\.exe$/i.test(file)) return this.spawnDetached(file, args);
    const exe = findAutoHotkey(a.version);
    if (!exe) throw new Error('не найден AutoHotkey — установите его с autohotkey.com или используйте скомпилированный .exe');
    return this.spawnDetached(exe, [file, ...args]);
  }

  spawnDetached(exe, args) {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
    return new Promise((resolve, reject) => {
      child.once('error', (e) => reject(new Error('не удалось запустить: ' + e.message)));
      child.once('spawn', () => { child.unref(); resolve(true); });
    });
  }
}

function findAutoHotkey(version) {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]
    .filter(Boolean).map((r) => path.join(r, 'AutoHotkey'));
  const v2 = ['v2\\AutoHotkey64.exe', 'v2\\AutoHotkey32.exe', 'v2\\AutoHotkey.exe'];
  const v1 = ['AutoHotkeyU64.exe', 'AutoHotkey.exe', 'AutoHotkeyU32.exe', 'v1.1\\AutoHotkeyU64.exe'];
  const order = String(version) === '1' ? [...v1, ...v2] : [...v2, ...v1];
  for (const root of roots) {
    for (const rel of order) {
      const f = path.join(root, rel);
      if (fs.existsSync(f)) return f;
    }
  }
  return null;
}

module.exports = { Macros, clean, compilePhrase, fill };
