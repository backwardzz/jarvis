// Pre-recorded JARVIS phrases (see src/phrases.js): decoded once, played instantly.

// Spoken by the neural voice when no clip is loaded (phrases off, English voice, still downloading).
const FALLBACK = {
  reply: ['Слушаю, сэр.'],
  ack: ['Есть, сэр.'],
  done: ['Готово, сэр.'],
  ok: ['Готово, сэр.'],
  thanks: ['Всегда к вашим услугам, сэр.'],
  stupid: ['Очень тонкое замечание, сэр.'],
  goodbye: ['До связи, сэр.'],
  game_mode: ['Игровой режим, сэр. Приятной игры.'],
  joke: [
    'Я бы пошутил про химию, но боюсь, реакции не будет, сэр.',
    'Что треугольник сказал кругу? Катись отсюда.',
    'Почему компьютер пошёл к врачу? Подхватил вирус.',
    'Почему книга всегда спокойна? Потому что у неё всё по полочкам.',
  ],
};

// A macro asks for "ok": an acknowledgement or a report that it is done — never "Загружаю, сэр".
// While Claude works on a request: an acknowledgement or "Загружаю, сэр".
const ALIASES = { ok: ['ack', 'done'], thinking: ['ack', 'loading'] };

export function dayPart(hour = new Date().getHours()) {
  return hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'day' : hour < 23 ? 'evening' : 'night';
}

export class ClipBank {
  constructor(api, decode) {
    this.api = api;
    this.decode = decode;
    this.pack = '';
    this.clips = [];
    this.last = new Map(); // reaction -> the clip played last time, so it is not repeated back to back
    this.loading = null;
  }

  /** Loads a pack (downloading it on first use); '' unloads. Resolves to the number of clips. */
  load(pack) {
    if (pack === this.pack && this.loading) return this.loading;
    this.pack = pack || '';
    this.clips = [];
    const run = (async () => {
      if (!pack || !this.api.phrases) return 0;
      const manifest = await this.api.phrases.load(pack);
      const clips = [];
      for (const c of manifest || []) {
        try {
          const bytes = await this.api.phrases.read(pack, c.file);
          clips.push({ ...c, buffer: await this.decode(bytes) });
        } catch (e) {
          console.warn('phrase', c.file, e.message);
        }
      }
      if (this.pack === pack) this.clips = clips;
      return clips.length;
    })();
    this.loading = run;
    run.catch(() => { if (this.loading === run) this.loading = null; }); // a failed download is retried next time
    return run;
  }

  has(reaction) {
    return this.candidates(reaction).length > 0;
  }

  candidates(reaction) {
    const names = ALIASES[reaction] || [reaction];
    return this.clips.filter((c) => names.includes(c.reaction));
  }

  pick(reaction) {
    const list = this.candidates(reaction);
    if (!list.length) return null;
    const prev = this.last.get(reaction);
    const pool = list.length > 1 ? list.filter((c) => c !== prev) : list;
    const clip = pool[Math.floor(Math.random() * pool.length)];
    this.last.set(reaction, clip);
    return clip;
  }

  /** Start-up greeting for the time of day: greet_evening, then the generic greet. */
  greeting(hour) {
    return this.pick(`greet_${dayPart(hour)}`) || this.pick('greet');
  }

  static fallback(reaction) {
    const list = FALLBACK[reaction] || [];
    return list.length ? list[Math.floor(Math.random() * list.length)] : '';
  }
}
