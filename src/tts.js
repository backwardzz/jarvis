'use strict';
/**
 * Speech synthesis. Three kinds of engines:
 *  - edge:   Microsoft Edge read-aloud neural voices (online, free);
 *  - kokoro / piper: open offline models run locally through sherpa-onnx;
 *  - xtts:   a voice clone — a local XTTS-v2 server (github.com/daswer123/xtts-api-server) speaks with the timbre
 *            of a short sample; by default the sample is stitched from the film JARVIS phrases (src/phrases.js).
 */
const { MsEdgeTTS } = require('msedge-tts');
const path = require('path');
const { PACKS } = require('./voicepacks');

const KOKORO = 'kokoro-multi-lang-v1_0';

const VOICES = [
  { id: 'ru-RU-DmitryNeural', engine: 'edge', label: 'Дмитрий — русский нейроголос', lang: 'ru', group: 'online' },
  { id: 'edge:dmitry-jarvis', engine: 'edge', edgeVoice: 'ru-RU-DmitryNeural', pitchShift: -9, rateShift: -8, label: 'Дмитрий «Джарвис» — ниже и спокойнее', lang: 'ru', group: 'online' },
  { id: 'en-US-AndrewMultilingualNeural', engine: 'edge', label: 'Andrew — мультиязычный (русский с акцентом)', lang: 'ru', group: 'online' },
  { id: 'en-US-BrianMultilingualNeural', engine: 'edge', label: 'Brian — мультиязычный (русский с акцентом)', lang: 'ru', group: 'online' },
  { id: 'en-AU-WilliamMultilingualNeural', engine: 'edge', label: 'William — мультиязычный (русский с акцентом)', lang: 'ru', group: 'online' },
  { id: 'en-GB-RyanNeural', engine: 'edge', label: 'Ryan — британский (ответы по-английски)', lang: 'en', group: 'online' },
  { id: 'en-GB-ThomasNeural', engine: 'edge', label: 'Thomas — британский (ответы по-английски)', lang: 'en', group: 'online' },

  { id: 'kokoro:bm_george', engine: 'kokoro', pack: KOKORO, sid: 26, label: 'George — британский RP, бархатный · ближе всего к Джарвису', lang: 'en', group: 'kokoro', license: 'Apache 2.0' },
  { id: 'kokoro:bm_lewis', engine: 'kokoro', pack: KOKORO, sid: 27, label: 'Lewis — британский, самый низкий', lang: 'en', group: 'kokoro', license: 'Apache 2.0' },
  { id: 'kokoro:bm_daniel', engine: 'kokoro', pack: KOKORO, sid: 24, label: 'Daniel — британский, сдержанный и чёткий', lang: 'en', group: 'kokoro', license: 'Apache 2.0' },
  { id: 'kokoro:bm_fable', engine: 'kokoro', pack: KOKORO, sid: 25, label: 'Fable — британский, выразительный', lang: 'en', group: 'kokoro', license: 'Apache 2.0' },

  { id: 'piper:ru_RU-ruslan', engine: 'piper', pack: 'vits-piper-ru_RU-ruslan-medium', model: 'ru_RU-ruslan-medium.onnx', label: 'Руслан — русский, низкий', lang: 'ru', group: 'piper', license: 'CC BY-NC-SA 4.0 (некоммерческое)' },
  { id: 'piper:ru_RU-dmitri', engine: 'piper', pack: 'vits-piper-ru_RU-dmitri-medium', model: 'ru_RU-dmitri-medium.onnx', label: 'Дмитрий (Piper) — русский, чёткий', lang: 'ru', group: 'piper', license: 'CC0' },

  { id: 'xtts:jarvis', engine: 'xtts', label: 'Джарвис из фильма — клон голоса (свой XTTS-сервер)', lang: 'ru', group: 'clone' },
];

const GROUPS = {
  online: 'Онлайн · Microsoft Neural (нужен интернет)',
  kokoro: 'Офлайн · Kokoro — британские, отвечают по-английски',
  piper: 'Офлайн · Piper — русские',
  clone: 'Клон голоса · XTTS-v2 на вашей видеокарте',
};

// Used when the chosen voice cannot speak the text (Russian text for an English voice) or its pack is still downloading.
const FALLBACK = { ru: 'ru-RU-DmitryNeural', en: 'en-GB-RyanNeural' };

function findVoice(id) {
  return VOICES.find((v) => v.id === id) || VOICES[0];
}

function isMostlyCyrillic(text) {
  const letters = text.match(/\p{L}/gu) || [];
  const cyr = text.match(/[Ѐ-ӿ]/g) || [];
  return letters.length > 0 && cyr.length / letters.length > 0.3;
}

// ---------------------------------------------------------------- edge
function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function edgeOnce(text, voice, prosody, timeoutMs) {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice, 'audio-24khz-96kbitrate-mono-mp3');
    const { audioStream } = tts.toStream(escapeXml(text), prosody);
    return await new Promise((resolve, reject) => {
      const chunks = [];
      const timer = setTimeout(() => reject(new Error('TTS timeout')), timeoutMs);
      audioStream.on('data', (c) => chunks.push(c));
      audioStream.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      audioStream.on('error', (e) => {
        clearTimeout(timer);
        // The service sometimes drops the socket right after the last chunk; keep what arrived.
        if (chunks.length) resolve(Buffer.concat(chunks)); else reject(e);
      });
    });
  } finally {
    try { tts.close(); } catch { /* already closed */ }
  }
}

async function edgeSynth(text, voice, pitch, rate) {
  const pct = (n) => `${n >= 0 ? '+' : ''}${Math.round(n)}%`;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const buf = await edgeOnce(text, voice, { pitch: pct(pitch), rate: pct(rate) }, 15000 + text.length * 40);
      if (buf && buf.length > 400) return buf;
      lastErr = new Error('пустой ответ синтезатора');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- offline (sherpa-onnx, separate process)
let host = null;
let nextId = 1;
const pending = new Map();
const loaded = new Map(); // pack -> Promise, model loaded in the host

function ensureHost() {
  if (host) return host;
  const { utilityProcess } = require('electron');
  const child = utilityProcess.fork(path.join(__dirname, 'tts-offline-host.js'), [], { serviceName: 'JARVIS offline voice', stdio: 'ignore' });
  child.on('message', (m) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
  });
  child.on('exit', (code) => {
    for (const p of pending.values()) p.reject(new Error('процесс офлайн-голоса завершился (' + code + ')'));
    pending.clear();
    loaded.clear();
    if (host === child) host = null;
  });
  host = child;
  return child;
}

function call(msg) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ensureHost().postMessage({ id, ...msg });
  });
}

function engineConfig(v, dir) {
  const threads = 4;
  if (v.engine === 'kokoro') {
    return {
      model: {
        kokoro: {
          model: path.join(dir, 'model.onnx'),
          voices: path.join(dir, 'voices.bin'),
          tokens: path.join(dir, 'tokens.txt'),
          dataDir: path.join(dir, 'espeak-ng-data'),
          lexicon: [path.join(dir, 'lexicon-gb-en.txt'), path.join(dir, 'lexicon-zh.txt')].join(','),
          lang: 'en', // espeak-ng "en" is British English
        },
        numThreads: threads,
        provider: 'cpu',
      },
      maxNumSentences: 1,
    };
  }
  return {
    model: {
      vits: { model: path.join(dir, v.model), tokens: path.join(dir, 'tokens.txt'), dataDir: path.join(dir, 'espeak-ng-data') },
      numThreads: threads,
      provider: 'cpu',
    },
    maxNumSentences: 1,
  };
}

function engineFor(v, dir) {
  if (!loaded.has(v.pack)) {
    const p = call({ type: 'load', key: v.pack, config: engineConfig(v, dir) });
    p.catch(() => loaded.delete(v.pack));
    loaded.set(v.pack, p);
  }
  return loaded.get(v.pack);
}

async function offlineSynth(v, text, rate, packs) {
  const dir = packs.path(v.pack);
  const r = await call({ type: 'synth', key: v.pack, config: engineConfig(v, dir), text, sid: v.sid || 0, speed: 1 + rate / 100 });
  return wav(r.samples, r.sampleRate);
}

function wav(samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

// ---------------------------------------------------------------- xtts (voice clone on a local server)
let xttsDownUntil = 0; // a server that is not running is not asked again for a while

async function xttsSynth(text, { url, speaker } = {}) {
  if (Date.now() < xttsDownUntil) throw new Error('XTTS-сервер недоступен');
  const base = String(url || 'http://127.0.0.1:8020').replace(/\/+$/, '');
  try {
    const speakerWav = typeof speaker === 'function' ? await speaker() : speaker;
    const res = await fetch(`${base}/tts_to_audio/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, speaker_wav: speakerWav, language: isMostlyCyrillic(text) ? 'ru' : 'en' }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`XTTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 400) throw new Error('XTTS вернул пустой звук');
    return buf;
  } catch (e) {
    xttsDownUntil = Date.now() + 30000;
    throw e;
  }
}

// ---------------------------------------------------------------- public
// Short phrases repeat a lot ("Как скажете, сэр."): keep their audio instead of synthesising them again.
const cache = new Map();
const CACHE_MAX = 80;
const CACHE_TEXT = 200;

/**
 * @param {object} [o]
 * @param {{url: string, speaker: string|(() => Promise<string>)}} [o.xtts] XTTS server and speaker sample
 * @param {(e: Error) => void} [o.onFallback] the chosen voice failed and a stand-in spoke instead
 * @returns {Promise<Buffer|null>} mp3 or wav bytes
 */
async function synthesize(text, { voice: id, pitch = 0, rate = 0, xtts, onFallback } = {}, packs) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  const key = `${id}|${pitch}|${rate}|${clean}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // most recently used goes last
    cache.set(key, hit);
    return hit;
  }
  let cacheable = clean.length <= CACHE_TEXT;
  let v = findVoice(id);
  if (v.lang === 'en' && isMostlyCyrillic(clean)) v = findVoice(FALLBACK.ru);
  if (v.pack && !packs.ready(v.pack)) {
    packs.ensure(v.pack).catch(() => {}); // download in the background, speak with an online voice meanwhile
    v = findVoice(FALLBACK[v.lang] || FALLBACK.ru);
    cacheable = false;
  }
  let buf;
  if (v.engine === 'xtts') {
    try {
      buf = await xttsSynth(clean, xtts);
    } catch (e) {
      onFallback?.(e);
      v = findVoice('edge:dmitry-jarvis');
      cacheable = false;
    }
  }
  if (!buf && v.engine === 'edge') buf = await edgeSynth(clean, v.edgeVoice || v.id, pitch + (v.pitchShift || 0), rate + (v.rateShift || 0));
  else if (!buf) buf = await offlineSynth(v, clean, rate, packs);
  if (cacheable && buf) {
    cache.set(key, buf);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return buf;
}

/** Loads the offline model ahead of the first phrase (download included). */
async function prepare(id, packs) {
  const v = findVoice(id);
  if (!v.pack) return true;
  const dir = await packs.ensure(v.pack);
  await engineFor(v, dir);
  return true;
}

function catalog(packs) {
  return VOICES.map((v) => ({
    id: v.id, label: v.label, lang: v.lang, engine: v.engine, group: v.group, groupLabel: GROUPS[v.group],
    license: v.license || null, offline: !!v.pack, ready: v.pack ? packs.ready(v.pack) : true, mb: v.pack ? PACKS[v.pack].mb : 0,
  }));
}

/** One line for the persona / HUD context: how JARVIS can switch its own voice. */
function voiceList() {
  return VOICES.map((v) => `${v.id} (${v.label})`).join('; ');
}

module.exports = { synthesize, prepare, catalog, findVoice, voiceList, VOICES };
