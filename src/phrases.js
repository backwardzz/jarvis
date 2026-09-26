'use strict';
/**
 * Pre-recorded JARVIS phrases ("Да, сэр.", "Запрос выполнен, сэр.") from the open Russian voice assistant
 * Priler/jarvis (https://github.com/Priler/jarvis, CC BY-NC-SA 4.0, author Abraham Tugalov).
 * A clip plays the instant it is needed — no synthesis round trip — so wake-word replies, macro
 * confirmations and greetings are both faster and in the film voice. Packs are downloaded on first use
 * into %APPDATA%\JARVIS\phrases (like the offline TTS voices) and are not part of this repository.
 *
 * Reactions: greet_morning | greet_day | greet_evening | greet_night | greet | ready — start-up;
 * reply — the name alone was heard; ack — a command was accepted; loading — Claude is working on it;
 * done — a command finished;
 * not_found, thanks, stupid, joke, goodbye, game_mode.
 */
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// pinned to a commit, so a change upstream can never swap the clips under the texts below
const SOURCE = 'https://raw.githubusercontent.com/Priler/jarvis/520b98143fdcf72bad855f722e7b32932d61cd46/resources/sound/voices/';

const PACKS = {
  'jarvis-og': {
    title: 'Оригинал из фильма',
    note: 'фразы Джарвиса из русского дубляжа «Железного человека»',
    kb: 3400,
    clips: [
      ['run.wav', 'Доброе утро.', 'greet_morning'],
      ['reply1.wav', 'Да, сэр.', 'reply'],
      ['reply2.wav', 'К вашим услугам.', 'reply'],
      ['reply3.wav', 'Да, сэр.', 'reply'],
      ['ok1.wav', 'Есть.', 'ack'],
      ['ok2.wav', 'Загружаю, сэр.', 'loading'],
      ['ok3.wav', 'Запрос выполнен, сэр.', 'done'],
      ['not_found.wav', 'Чего вы пытаетесь добиться, сэр?', 'not_found'],
      ['stupid.wav', 'Очень тонкое замечание, сэр.', 'stupid'],
      ['thanks.wav', 'Всегда к вашим услугам, сэр.', 'thanks'],
      ['off.wav', 'Отключаюсь.', 'goodbye'],
      ['game_mode.wav', 'В этот вечер — игры.', 'game_mode'],
    ],
    // ≈10 s of clean speech: the sample a voice-cloning server (XTTS) copies the timbre from
    reference: ['reply2.wav', 'ok3.wav', 'not_found.wav', 'stupid.wav', 'thanks.wav'],
  },
  'jarvis-remaster': {
    title: 'Ремастер',
    note: 'перезаписанные фразы: приветствия на любое время суток и шутки',
    kb: 900,
    clips: [
      ['greet1.mp3', 'Приветствую, сэр.', 'greet'],
      ['greet_morning.mp3', 'Доброе утро, сэр. Чем я могу вам сегодня помочь?', 'greet_morning'],
      ['greet_day.mp3', 'Добрый день, сэр. Чем я могу вам сегодня помочь?', 'greet_day'],
      ['greet_evening.mp3', 'Добрый вечер, сэр.', 'greet_evening'],
      ['greet_night.mp3', 'Доброй ночи, сэр. Чем я могу вам помочь?', 'greet_night'],
      ['reply1.mp3', 'Да, сэр.', 'reply'],
      ['reply2.mp3', 'Да, сэр.', 'reply'],
      ['reply3.mp3', 'Да, сэр.', 'reply'],
      ['reply5.mp3', 'К вашим услугам, сэр.', 'reply'],
      ['reply6.mp3', 'Слушаю.', 'reply'],
      ['ok1.mp3', 'Загружаю, сэр.', 'loading'],
      ['ok2.mp3', 'Как скажете, сэр.', 'ack'],
      ['ok3.mp3', 'Слушаюсь, сэр.', 'ack'],
      ['stupid.mp3', 'Очень тонкое замечание, сэр.', 'stupid'],
      ['thanks.mp3', 'Всегда к вашим услугам, сэр.', 'thanks'],
      ['joke1.mp3', 'Я бы пошутил про химию, но боюсь, реакции не будет, сэр.', 'joke'],
      ['joke2.mp3', 'Сэр, вы когда-нибудь задумывались, почему в Монголии живут монголы, а в Чехии не чехлы?', 'joke'],
      ['joke3.mp3', 'Как называют три целых четырнадцать сотых моряков? Пи-раты.', 'joke'],
      ['joke4.mp3', 'Что треугольник сказал кругу? Катись отсюда.', 'joke'],
      ['joke5.mp3', 'Знаете, за что огородному пугалу дали награду? За успехи в его поле деятельности.', 'joke'],
      ['joke6.mp3', 'Почему книга всегда спокойна? Потому что у неё всё по полочкам.', 'joke'],
      ['joke7.mp3', 'Почему компьютер пошёл к врачу? Подхватил вирус.', 'joke'],
    ],
  },
  'jarvis-howdy': {
    title: 'Howdy',
    note: 'та же манера, больше реплик и шутки',
    kb: 7300,
    clips: [
      ['run.wav', 'Добрый день, сэр.', 'greet_day'],
      ['ready.wav', 'Мы подключены и готовы.', 'ready'],
      ['reply1.wav', 'Слушаю, сэр.', 'reply'],
      ['reply2.wav', 'К вашим услугам, сэр.', 'reply'],
      ['ok1.wav', 'Есть.', 'ack'],
      ['ok2.wav', 'Загружаю, сэр.', 'loading'],
      ['ok4.wav', 'Как пожелаете.', 'ack'],
      ['ok3.wav', 'Запрос выполнен, сэр.', 'done'],
      ['not_found.wav', 'Чего вы пытаетесь добиться, сэр?', 'not_found'],
      ['stupid.wav', 'Очень тонкое замечание, сэр.', 'stupid'],
      ['thanks.wav', 'Всегда к вашим услугам, сэр.', 'thanks'],
      ['game_mode.wav', 'Мы перешли в игровой режим. Приятной игры, сэр.', 'game_mode'],
      ['joke1.wav', 'Я бы пошутил про химию, но боюсь, реакции не будет, сэр.', 'joke'],
      ['joke2.wav', 'А вы когда-нибудь задавались вопросом, почему в Монголии живут монголы, а в Чехии не чехлы?', 'joke'],
      ['joke3.wav', 'Три целых четырнадцать сотых процента моряков — пи-раты.', 'joke'],
      ['joke4.wav', 'Что треугольник сказал кругу? Катись отсюда.', 'joke'],
      ['joke5.wav', 'За что пугалу дали награду? За успехи в его поле деятельности.', 'joke'],
    ],
  },
};

const SAMPLE_RATE = 22050; // what XTTS expects of a speaker sample

/** Decodes 16-bit PCM WAV into mono float samples. */
function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('не WAV');
  let fmt = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) throw new Error('нужен 16-битный PCM');
      const frames = Math.floor(Math.min(size, buf.length - body) / (2 * fmt.channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < fmt.channels; c++) s += buf.readInt16LE(body + (i * fmt.channels + c) * 2);
        out[i] = s / fmt.channels / 32768;
      }
      return { samples: out, rate: fmt.rate };
    }
    off = body + size + (size & 1);
  }
  throw new Error('в WAV нет данных');
}

/** Resamples with a box pre-filter (enough against aliasing for a speech sample). */
function resample(input, from, to) {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  const half = Math.max(0.5, ratio / 2);
  for (let i = 0; i < out.length; i++) {
    const center = i * ratio;
    const a = Math.max(0, Math.ceil(center - half));
    const b = Math.min(input.length - 1, Math.floor(center + half));
    let sum = 0;
    for (let j = a; j <= b; j++) sum += input[j];
    out[i] = b >= a ? sum / (b - a + 1) : 0;
  }
  return out;
}

function trimSilence(s, threshold = 0.01) {
  let a = 0;
  let b = s.length;
  while (a < b && Math.abs(s[a]) < threshold) a++;
  while (b > a && Math.abs(s[b - 1]) < threshold) b--;
  return s.subarray(a, b);
}

function writeWav(samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buf;
}

class PhrasePacks extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.jobs = new Map();
  }

  path(pack) {
    return path.join(this.dir, pack);
  }

  ready(pack) {
    return !!PACKS[pack] && fs.existsSync(path.join(this.dir, pack, '.complete'));
  }

  ensure(pack) {
    if (!PACKS[pack]) return Promise.reject(new Error('неизвестный пакет фраз ' + pack));
    if (this.ready(pack)) return Promise.resolve(this.path(pack));
    if (!this.jobs.has(pack)) {
      const job = this.install(pack).finally(() => this.jobs.delete(pack));
      this.jobs.set(pack, job);
    }
    return this.jobs.get(pack);
  }

  async install(pack) {
    const info = PACKS[pack];
    const status = (state, extra = {}) => this.emit('status', { pack, title: info.title, state, ...extra });
    const dir = this.path(pack);
    fs.mkdirSync(dir, { recursive: true });
    const files = info.clips.map(([file]) => file);
    let done = 0;
    status('downloading', { progress: 0 });
    try {
      // a few at a time: the clips are small, the latency is what adds up
      const queue = [...files];
      const worker = async () => {
        for (let file = queue.shift(); file; file = queue.shift()) {
          const target = path.join(dir, file);
          if (!fs.existsSync(target)) {
            const res = await fetch(`${SOURCE}${pack}/ru/${file}`, { signal: AbortSignal.timeout(60000) });
            if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
            fs.writeFileSync(target + '.part', Buffer.from(await res.arrayBuffer()));
            fs.renameSync(target + '.part', target);
          }
          done++;
          status('downloading', { progress: done / files.length });
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      fs.writeFileSync(path.join(dir, '.complete'), new Date().toISOString());
      status('ready');
      return dir;
    } catch (e) {
      status('error', { message: e.message });
      throw e;
    }
  }

  /** Clips of a downloaded pack: [{ file, text, reaction }]. */
  manifest(pack) {
    const info = PACKS[pack];
    if (!info) return null;
    return info.clips.map(([file, text, reaction]) => ({ file, text, reaction }));
  }

  read(pack, file) {
    if (!this.manifest(pack)?.some((c) => c.file === file)) throw new Error('нет такой фразы');
    return fs.readFileSync(path.join(this.path(pack), file));
  }

  /**
   * A mono 22 kHz speaker sample stitched from the film clips, for voice cloning (XTTS).
   * @returns {Promise<string>} absolute path of the WAV
   */
  async reference(pack = 'jarvis-og') {
    const info = PACKS[pack];
    if (!info?.reference) throw new Error(`у пакета ${pack} нет образца голоса`);
    const target = path.join(this.path(pack), 'reference.wav');
    if (fs.existsSync(target)) return target;
    await this.ensure(pack);
    const gap = new Float32Array(Math.round(SAMPLE_RATE * 0.35));
    const parts = [];
    for (const file of info.reference) {
      const { samples, rate } = readWav(fs.readFileSync(path.join(this.path(pack), file)));
      parts.push(trimSilence(resample(samples, rate, SAMPLE_RATE)), gap);
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const all = new Float32Array(total);
    let off = 0;
    for (const p of parts) { all.set(p, off); off += p.length; }
    fs.writeFileSync(target, writeWav(all, SAMPLE_RATE));
    return target;
  }

  catalog() {
    return Object.entries(PACKS).map(([id, p]) => ({ id, title: p.title, note: p.note, kb: p.kb, ready: this.ready(id) }));
  }
}

module.exports = { PhrasePacks, PACKS, readWav, resample };
