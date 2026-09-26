'use strict';
/**
 * Sandbox mode: watches the app's own sources and applies edits without a manual restart.
 * Renderer files reload the window; main-process files (main.js, preload.js, src/) relaunch the app.
 * Nothing is applied mid-conversation: the renderer asks for it once Jarvis is idle.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const WATCH = [
  { rel: 'renderer', kind: 'renderer' },
  { rel: 'main.js', kind: 'main' },
  { rel: 'preload.js', kind: 'main' },
  { rel: 'src', kind: 'main' },
];

/** Returns a syntax error message for a CommonJS file, or null if it parses. */
function syntaxError(file) {
  try {
    const src = fs.readFileSync(file, 'utf8');
    new vm.Script(`(function (exports, require, module, __filename, __dirname) {${src}\n})`, { filename: file });
    return null;
  } catch (e) {
    return `${path.basename(file)}: ${e.message}`;
  }
}

class HotReload extends EventEmitter {
  constructor(root) {
    super();
    this.root = root;
    this.pending = null; // 'renderer' | 'main'
    this.files = new Set(); // renderer files touched since the last apply
    this.timer = 0;
    this.watchers = [];
  }

  start() {
    for (const { rel, kind } of WATCH) {
      const target = path.join(this.root, rel);
      if (!fs.existsSync(target)) continue;
      try {
        const w = fs.watch(target, { recursive: fs.statSync(target).isDirectory() }, (_ev, name) => {
          if (name && /(^|[\\/])\.|~$|\.tmp$/.test(String(name))) return; // editor temp files
          this.mark(kind, name ? String(name) : '');
        });
        this.watchers.push(w);
      } catch { /* watching is best-effort */ }
    }
  }

  stop() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  mark(kind, name = '') {
    if (this.pending !== 'main') this.pending = kind;
    if (kind === 'renderer') this.files.add(name);
    clearTimeout(this.timer);
    // editors write in bursts; wait for the dust to settle
    this.timer = setTimeout(() => this.emit('pending', this.check()), 600);
  }

  /** Current pending change plus any syntax errors that would make a relaunch fatal. */
  check() {
    if (this.pending === 'renderer' && this.files.size && [...this.files].every((f) => /\.css$/i.test(f))) {
      return { kind: 'css', files: [...this.files], error: null };
    }
    if (this.pending !== 'main') return { kind: this.pending, error: null };
    const files = [path.join(this.root, 'main.js'), path.join(this.root, 'preload.js')];
    const src = path.join(this.root, 'src');
    for (const f of fs.readdirSync(src)) if (f.endsWith('.js')) files.push(path.join(src, f));
    const error = files.map(syntaxError).find(Boolean) || null;
    return { kind: this.pending, error };
  }

  take() {
    const p = this.check();
    if (!p.error) { this.pending = null; this.files.clear(); }
    return p;
  }
}

module.exports = { HotReload };
