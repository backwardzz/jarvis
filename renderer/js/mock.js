// Stand-in for the Electron preload API so the HUD can be previewed in a plain browser.
export function createMockApi() {
  const listeners = { brain: [], stt: [], hotkey: [], win: [] };
  const emit = (k, v) => listeners[k].forEach((cb) => cb(v));
  let settings = {
    voice: 'ru-RU-DmitryNeural', pitch: -6, rate: 4, voiceFx: true, volume: 0.9, sttModel: 'small', sttLanguage: 'russian',
    wakeWord: false, followUp: false, greeting: false, sounds: true, claudePath: '', workDir: 'D:\\', model: '', effort: '',
    permissionMode: 'acceptEdits', loadMcp: false, city: { name: 'Астана', lat: 51.1694, lon: 71.4491 }, sessionId: null,
    phrasePack: '', phraseAck: true, xttsUrl: 'http://127.0.0.1:8020', warmCore: true, macros: true,
    phrasePacks: [{ id: 'jarvis-og', title: 'Оригинал из фильма', note: 'фразы Джарвиса из русского дубляжа', kb: 3400, ready: false }],
    voices: [
      { id: 'ru-RU-DmitryNeural', label: 'Дмитрий — русский нейроголос', lang: 'ru', group: 'online', groupLabel: 'Онлайн · Microsoft Neural (нужен интернет)', offline: false, ready: true },
      { id: 'edge:dmitry-jarvis', label: 'Дмитрий «Джарвис» — ниже и спокойнее', lang: 'ru', group: 'online', groupLabel: 'Онлайн · Microsoft Neural (нужен интернет)', offline: false, ready: true },
      { id: 'kokoro:bm_george', label: 'George — британский RP, бархатный · ближе всего к Джарвису', lang: 'en', group: 'kokoro', groupLabel: 'Офлайн · Kokoro — британские, отвечают по-английски', offline: true, ready: false, mb: 350, license: 'Apache 2.0' },
      { id: 'piper:ru_RU-ruslan', label: 'Руслан — русский, низкий', lang: 'ru', group: 'piper', groupLabel: 'Офлайн · Piper — русские', offline: true, ready: true, mb: 67, license: 'CC BY-NC-SA 4.0 (некоммерческое)' },
    ], hotkey: 'Ctrl+Shift+Space', version: '1.0.0',
  };
  const projects = [{
    id: 'usetime-astana', name: 'Usetime Astana', url: 'https://usetime-astana.netlify.app/',
    description: 'Сайт антикафе Usetime в Астане: цены, каталог развлечений (караоке, кинозал, PS5, Xbox, бильярд), правила, три адреса и отзывы.',
    stack: 'HTML · CSS · JS · Netlify', localPath: 'D:\\usetime-site', aliases: ['юзтайм'], addedAt: '2026-09-26',
    thumb: '../assets/thumbs/usetime-astana.png', status: { state: 'protected', code: 401, ms: 184 },
  }];
  let turn = 0;
  const off = (k) => (cb) => { listeners[k].push(cb); return () => {}; };
  return {
    mock: true,
    settings: { get: async () => settings, set: async (p) => (settings = { ...settings, ...p }), pickDir: async () => null },
    projects: {
      list: async () => projects, check: async () => projects, add: async () => projects, remove: async () => projects,
      capture: async () => projects, openFolder: async () => '',
    },
    brain: {
      ask: async (text) => {
        const id = ++turn;
        const reply = `Разумеется, сэр. Вы сказали: «${text}». В демо-режиме браузера ядро Claude не подключено, но интерфейс работает.`;
        setTimeout(() => emit('brain', { kind: 'start', turn: id }), 50);
        setTimeout(() => emit('brain', { kind: 'init', model: 'claude-opus-5-5', turn: id }), 300);
        setTimeout(() => emit('brain', { kind: 'tool', name: 'Read', detail: 'D:\\usetime-site\\index.html', turn: id }), 700);
        reply.split(/(?<=\s)/).forEach((w, i) => setTimeout(() => emit('brain', { kind: 'delta', text: w, turn: id }), 1000 + i * 45));
        const endAt = 1000 + reply.split(/(?<=\s)/).length * 45 + 100;
        setTimeout(() => emit('brain', { kind: 'block-end', turn: id }), endAt);
        setTimeout(() => emit('brain', { kind: 'done', text: reply, costUsd: 0.0123, durationMs: 4200, turn: id }), endAt + 50);
        setTimeout(() => emit('brain', { kind: 'end', turn: id }), endAt + 80);
        return id;
      },
      stop: async () => {}, reset: async () => {}, login: async () => true,
      status: async () => ({ claudePath: 'C:\\Users\\Danny\\.local\\bin\\claude.exe', loggedIn: true, sessionId: null }),
      onEvent: off('brain'),
    },
    tts: { synth: async () => null, prepare: async () => settings.voices, onStatus: off('win') },
    stt: { load: async () => emit('stt', { state: 'ready', size: 'small' }), transcribe: async () => ({ text: 'Джарвис, открой проект юзтайм', ms: 900 }), onStatus: off('stt') },
    sys: {
      stats: async () => ({
        cpu: 0.18 + Math.random() * 0.2, cpuModel: 'Intel Core i5-9300H', cores: 8, memTotal: 25.6e9, memFree: 12.1e9 - Math.random() * 1e9,
        uptime: 38211, host: 'DANNY-PC', user: 'Danny', platform: 'Windows 10.0.26200',
        disks: [{ name: 'C:', total: 512e9, free: 141e9 }, { name: 'D:', total: 1000e9, free: 402e9 }],
      }),
      weather: async () => ({ city: 'Астана', temp: 11.4, feels: 8.9, humidity: 54, wind: 4.2, code: 2, text: 'переменная облачность', max: 14, min: 5 }),
    },
    macros: { run: async () => null, list: async () => ({ count: 0, files: [], errors: [] }), onLoaded: off('win') },
    shell: { openExternal: async (u) => window.open(u, '_blank') },
    win: { minimize() {}, maximize() {}, close() {}, onState: off('win') },
    onHotkey: off('hotkey'),
  };
}
