'use strict';
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');
const path = require('path');

// Cloud recognizers (OpenAI-compatible /audio/transcriptions). Local Whisper stays as the offline fallback.
const CLOUD = {
  groq: { url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3', keyName: 'sttGroqKey' },
  openai: { url: 'https://api.openai.com/v1/audio/transcriptions', model: 'gpt-4o-transcribe', keyName: 'sttOpenaiKey' },
};
const LANG = { russian: 'ru', english: 'en' };
const FALLBACK = 'small';

function wav(samples, rate = 16000) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buf;
}

class SpeechRecognizer extends EventEmitter {
  constructor(cacheDir, getKey = () => '') {
    super();
    this.getKey = getKey;
    this.cacheDir = cacheDir;
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = new Set();
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const file = path.join(__dirname, 'stt-worker.mjs');
    const worker = new Worker(file, { workerData: { cacheDir: this.cacheDir } });
    worker.on('message', (m) => {
      if (m.type === 'result') {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (p) (m.error ? p.reject(new Error(m.error)) : p.resolve({ text: m.text, ms: m.ms }));
      } else if (m.type === 'ready') {
        this.ready.add(m.size);
        this.emit('status', { state: 'ready', size: m.size });
      } else if (m.type === 'progress') {
        this.emit('status', { state: 'loading', size: m.size, progress: m.total ? m.loaded / m.total : 0 });
      } else if (m.type === 'load-error') {
        this.emit('status', { state: 'error', size: m.size, message: m.message });
      }
    });
    const fail = (err) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.ready.clear();
      this.worker = null;
      this.emit('status', { state: 'error', message: err.message });
    };
    worker.on('error', fail);
    worker.on('exit', (code) => { if (this.worker === worker) fail(new Error('STT worker exited: ' + code)); });
    this.worker = worker;
    return worker;
  }

  load(size) {
    const cloud = CLOUD[size];
    if (cloud) {
      if (this.getKey(cloud.keyName)) this.emit('status', { state: 'ready', size, cloud: true });
      else {
        this.emit('status', { state: 'error', size, message: 'нет API-ключа' });
        this.load(FALLBACK);
      }
      return;
    }
    if (this.ready.has(size)) {
      this.emit('status', { state: 'ready', size });
      return;
    }
    this.emit('status', { state: 'loading', size, progress: 0 });
    this.ensureWorker().postMessage({ type: 'load', size });
  }

  async transcribe(audio, { size = 'small', language = 'russian' } = {}) {
    const cloud = CLOUD[size];
    if (!cloud) return this.local(audio, size, language);
    const key = this.getKey(cloud.keyName);
    if (key) {
      try {
        return await this.cloud(cloud, key, audio, language);
      } catch (e) {
        this.emit('status', { state: 'fallback', size, message: e.message });
      }
    }
    return this.local(audio, FALLBACK, language);
  }

  async cloud({ url, model }, key, audio, language) {
    const t0 = Date.now();
    const form = new FormData();
    form.append('file', new Blob([wav(audio)], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', model);
    form.append('temperature', '0');
    if (LANG[language]) form.append('language', LANG[language]);
    const res = await fetch(url, {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return { text: String(data.text || '').trim(), ms: Date.now() - t0, cloud: true };
  }

  local(audio, size, language) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ensureWorker().postMessage({ type: 'transcribe', id, audio, size, language });
    });
  }

  dispose() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }
}

module.exports = { SpeechRecognizer };
