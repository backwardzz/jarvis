'use strict';
/**
 * Windows side of the macros: keys, volume, lock, sleep, screenshots, PowerShell snippets.
 * One PowerShell process (winhost.ps1) is started ahead of time and kept running, so a macro takes
 * milliseconds instead of the second or two that PowerShell start-up and C# compilation cost every time.
 */
const { spawn } = require('child_process');
const path = require('path');

const VK = {
  BACKSPACE: 0x08, TAB: 0x09, ENTER: 0x0d, SHIFT: 0x10, CTRL: 0x11, ALT: 0x12, PAUSE: 0x13, CAPSLOCK: 0x14, ESC: 0x1b,
  SPACE: 0x20, PAGEUP: 0x21, PAGEDOWN: 0x22, END: 0x23, HOME: 0x24, LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28,
  PRINTSCREEN: 0x2c, INSERT: 0x2d, DELETE: 0x2e, WIN: 0x5b, APPS: 0x5d,
  VOLUME_MUTE: 0xad, VOLUME_DOWN: 0xae, VOLUME_UP: 0xaf,
  MEDIA_NEXT: 0xb0, MEDIA_PREV: 0xb1, MEDIA_STOP: 0xb2, MEDIA_PLAY_PAUSE: 0xb3,
};
const ALIAS = { CONTROL: 'CTRL', RETURN: 'ENTER', ESCAPE: 'ESC', DEL: 'DELETE', INS: 'INSERT', PGUP: 'PAGEUP', PGDN: 'PAGEDOWN', PRTSC: 'PRINTSCREEN', LWIN: 'WIN', CMD: 'WIN', MENU: 'APPS' };

/** "Win+Shift+S" → [0x5B, 0x10, 0x53]. */
function chord(spec) {
  return String(spec).split('+').map((raw) => {
    const k = raw.trim().toUpperCase();
    const name = ALIAS[k] || k;
    if (name in VK) return VK[name];
    if (/^[A-Z0-9]$/.test(name)) return name.charCodeAt(0);
    const f = name.match(/^F([1-9]|1[0-9]|2[0-4])$/);
    if (f) return 0x6f + Number(f[1]);
    throw new Error(`неизвестная клавиша «${raw.trim()}» в «${spec}»`);
  });
}

// Non-ASCII goes as \uXXXX: PowerShell 5.1 reads stdin in the OEM code page, JSON escapes survive any code page.
const asciiJson = (v) => JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

class WinHost {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.script = path.join(__dirname, 'winhost.ps1');
    this.child = null;
    this.ready = null;
    this.pending = new Map();
    this.nextId = 1;
    this.failures = 0;
  }

  get supported() {
    return process.platform === 'win32';
  }

  /** Starts the host (idempotent); resolves when its C# helpers are compiled. */
  start() {
    if (!this.supported) return Promise.reject(new Error('действие доступно только в Windows'));
    if (this.ready) return this.ready;
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script], { windowsHide: true });
    this.child = child;
    let buffer = '';
    let stderr = '';
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('макро-хост PowerShell не запустился за 30 с')), 30000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          let m;
          try { m = JSON.parse(line); } catch { continue; }
          if (m.id === 0) { clearTimeout(timer); this.failures = 0; resolve(true); continue; }
          const p = this.pending.get(m.id);
          if (!p) continue;
          this.pending.delete(m.id);
          if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error || 'ошибка макро-хоста'));
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { stderr += d; });
      const fail = (err) => {
        clearTimeout(timer);
        if (this.child === child) { this.child = null; this.ready = null; }
        const e = new Error(`${err}${stderr.trim() ? ': ' + stderr.trim().split('\n').slice(-3).join(' ') : ''}`);
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
        reject(e);
      };
      child.on('error', (e) => fail('не удалось запустить PowerShell: ' + e.message));
      child.on('exit', (code) => {
        this.failures++;
        this.log('winhost exit', code, stderr.slice(-400));
        fail(`макро-хост PowerShell завершился (код ${code})`);
      });
    });
    this.ready.catch(() => {});
    child.stdin.on('error', () => {});
    return this.ready;
  }

  async call(op, args = {}, timeoutMs = 20000) {
    if (this.failures >= 3) throw new Error('макро-хост PowerShell не работает — подробности в журнале');
    await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`макро-хост не ответил за ${timeoutMs / 1000} с`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.child.stdin.write(asciiJson({ id, op, args }) + '\n');
    });
  }

  /** keys('Win+D') or keys(['Ctrl+C', 'Alt+Tab'], 80) */
  keys(spec, delay = 60) {
    const chords = (Array.isArray(spec) ? spec : [spec]).map(chord);
    return this.call('keys', { chords, delay });
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.ready = null;
    try { child?.stdin.end(); child?.kill(); } catch { /* already gone */ }
  }
}

module.exports = { WinHost, chord, VK };
