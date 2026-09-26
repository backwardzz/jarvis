'use strict';
/** Offline voice packs from the sherpa-onnx model releases: downloaded on first use into %APPDATA%\JARVIS\voices. */
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const fs = require('fs');
const path = require('path');

const BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/';
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

const PACKS = {
  'kokoro-multi-lang-v1_0': { mb: 350, title: 'Kokoro v1.0' },
  'vits-piper-ru_RU-ruslan-medium': { mb: 67, title: 'Piper Ruslan' },
  'vits-piper-ru_RU-dmitri-medium': { mb: 67, title: 'Piper Dmitri' },
};

class VoicePacks extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.jobs = new Map();
  }

  path(pack) {
    return path.join(this.dir, pack);
  }

  ready(pack) {
    return fs.existsSync(path.join(this.dir, pack, 'tokens.txt'));
  }

  ensure(pack) {
    if (this.ready(pack)) return Promise.resolve(this.path(pack));
    if (!PACKS[pack]) return Promise.reject(new Error('неизвестный пакет голоса ' + pack));
    if (!this.jobs.has(pack)) {
      const job = this.install(pack).finally(() => this.jobs.delete(pack));
      this.jobs.set(pack, job);
    }
    return this.jobs.get(pack);
  }

  async install(pack) {
    const info = PACKS[pack];
    const status = (state, extra = {}) => this.emit('status', { pack, title: info.title, mb: info.mb, state, ...extra });
    fs.mkdirSync(this.dir, { recursive: true });
    const archive = path.join(this.dir, pack + '.tar.bz2');
    const partial = archive + '.part';
    try {
      status('downloading', { progress: 0 });
      const res = await fetch(BASE + pack + '.tar.bz2', { signal: AbortSignal.timeout(30 * 60 * 1000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const total = Number(res.headers.get('content-length')) || info.mb * 1e6;
      let loaded = 0;
      let lastTick = 0;
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        loaded += chunk.length;
        if (Date.now() - lastTick > 400) {
          lastTick = Date.now();
          status('downloading', { progress: loaded / total });
        }
      });
      await pipeline(body, fs.createWriteStream(partial));
      fs.renameSync(partial, archive);
      status('extracting');
      await new Promise((resolve, reject) => {
        execFile(TAR, ['-xjf', archive, '-C', this.dir], { windowsHide: true, timeout: 15 * 60 * 1000 }, (err) => (err ? reject(err) : resolve()));
      });
      if (!this.ready(pack)) throw new Error('архив распакован, но модель не найдена');
      status('ready');
      return this.path(pack);
    } catch (e) {
      status('error', { message: e.message });
      throw e;
    } finally {
      for (const f of [archive, partial]) fs.rm(f, { force: true }, () => {});
    }
  }
}

module.exports = { VoicePacks, PACKS };
