import { Reactor } from './reactor.js';
import { Microphone, Vad, VoiceOut } from './audio.js';
import { ReplyProcessor, stripTags } from './reply.js';
import { isNoise, wakeCommand, localIntent } from './intents.js';
import { createMockApi } from './mock.js';
import { ClipBank } from './phrases.js';

const api = window.jarvis || createMockApi();
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason?.message || e.reason)));
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CITIES = [
  { name: 'Астана', in: 'Астане', lat: 51.1694, lon: 71.4491 },
  { name: 'Алматы', in: 'Алматы', lat: 43.2389, lon: 76.8897 },
  { name: 'Шымкент', in: 'Шымкенте', lat: 42.3417, lon: 69.5901 },
  { name: 'Караганда', in: 'Караганде', lat: 49.8047, lon: 73.1094 },
  { name: 'Москва', in: 'Москве', lat: 55.7558, lon: 37.6173 },
];

const STATE_TEXT = {
  idle: ['STANDBY', 'Ожидание команды'],
  wake: ['STANDBY', 'Жду обращения «Джарвис»'],
  listening: ['LISTENING', 'Слушаю, сэр…'],
  transcribing: ['PROCESSING', 'Распознаю речь…'],
  thinking: ['THINKING', 'Обрабатываю запрос…'],
  speaking: ['SPEAKING', 'Джарвис говорит'],
  error: ['ALERT', 'Требуется внимание'],
};

const app = {
  settings: null,
  projects: [],
  state: 'idle',
  wake: false,
  wakeBusy: false,
  brainTurn: 0,
  brainBusy: false,
  reply: null,
  gotDelta: false,
  lastSource: 'text',
  loggedIn: null,
  claudePath: null,
  weather: null,
  sttReady: false,
  ttsOk: null,
  cpuHistory: [],
  micCloseTimer: 0,
  macroTurn: 0,
};

// ---------------------------------------------------------------- audio & core
const reactor = new Reactor($('#reactor'));
const voice = new VoiceOut();
const mic = new Microphone();
// pre-recorded JARVIS phrases (src/phrases.js), decoded once and played without any synthesis delay
const clips = new ClipBank(api, (bytes) => voice.decode(bytes));
const vad = new Vad({
  onStart: () => { if (app.state === 'listening') $('#state-text').textContent = 'Слушаю, сэр… говорите'; },
  onEnd: (audio, info) => handleUtterance(audio, info),
  onTimeout: () => {
    if (app.state === 'listening') {
      setState(idleState());
      toast('Не расслышал команду', 'warn', 2500);
    }
  },
});
mic.onFrame = (frame) => vad.push(frame);

function sfx(name) {
  if (app.settings?.sounds !== false) voice.sfx(name);
}

function fallbackSpeak(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    const lang = voiceLang() === 'en' ? 'en' : 'ru';
    const v = speechSynthesis.getVoices().find((x) => x.lang.toLowerCase().startsWith(lang));
    if (v) u.voice = v;
    u.lang = lang === 'en' ? 'en-GB' : 'ru-RU';
    u.pitch = 0.85;
    u.rate = 1.02;
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
    setTimeout(resolve, 4000 + text.length * 90);
  });
}

class Speaker {
  constructor() {
    this.queue = [];
    this.gen = 0;
    this.playing = false;
  }

  get busy() {
    return this.playing || this.queue.length > 0;
  }

  say(text) {
    const item = { text, audio: this.synth(text) };
    this.queue.push(item);
    if (!this.playing) this.pump();
  }

  /** A recorded phrase: already decoded, plays the moment its turn comes. */
  clip(c) {
    this.queue.push({ text: c.text, audio: Promise.resolve(c.buffer), raw: true });
    if (!this.playing) this.pump();
  }

  async synth(text) {
    try {
      const bytes = await api.tts.synth(text);
      if (bytes) {
        const buf = await voice.decode(bytes);
        setTts(true);
        return buf;
      }
    } catch (e) {
      console.warn('TTS failed:', e.message);
      setTts(false);
    }
    return null;
  }

  async pump() {
    const gen = this.gen;
    this.playing = true;
    await Promise.race([voice.resume(), sleep(300)]);
    while (this.queue.length && gen === this.gen) {
      const item = this.queue[0];
      const buf = await item.audio;
      if (gen !== this.gen) return;
      if (app.state !== 'speaking') setState('speaking');
      $('#sub-jarvis').textContent = item.text;
      if (buf) await voice.play(buf, item.raw); else await fallbackSpeak(item.text);
      if (gen !== this.gen) return;
      this.queue.shift();
    }
    this.playing = false;
    onSpeechIdle();
  }

  clear() {
    this.gen++;
    this.queue = [];
    this.playing = false;
    voice.stop();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }
}
const speaker = new Speaker();

function say(text) {
  if (!text) return;
  speaker.say(text);
}

function voiceLang() {
  const v = app.settings?.voices?.find((x) => x.id === app.settings.voice);
  return v?.lang || 'ru';
}

/** A recorded phrase for the reaction, if one is loaded and the voice speaks Russian (the phrases do). */
function pickClip(reaction) {
  return voiceLang() === 'ru' ? clips.pick(reaction) : null;
}

/**
 * Speaks a reaction ('reply', 'ack', 'ok', 'thanks', 'joke', …): the recorded JARVIS phrase when there is one,
 * otherwise `fallback` (or a stock line) through the neural voice. Returns the text that was spoken.
 */
function react(reaction, fallback) {
  const c = pickClip(reaction);
  if (c) { speaker.clip(c); return c.text; }
  const text = fallback ?? ClipBank.fallback(reaction);
  if (text) say(text);
  return text;
}

// ---------------------------------------------------------------- state
function idleState() {
  return app.wake ? 'wake' : 'idle';
}

function setState(state) {
  app.state = state;
  document.body.dataset.state = state;
  reactor.setState(state);
  const [code, text] = STATE_TEXT[state] || STATE_TEXT.idle;
  $('#rc-state').textContent = code;
  $('#state-text').textContent = text;
  if (state === 'speaking') reactor.setAnalyser(voice.analyser);
  else if (mic.analyser) reactor.setAnalyser(mic.analyser);
  else reactor.setAnalyser(null);
  if ((state === 'idle' || state === 'wake') && app.wake && vad.mode !== 'wake') vad.begin('wake');
  chip('#chip-ears', state === 'listening' ? 'busy' : mic.open ? 'ok' : '');
  scheduleMicClose();
}

function onSpeechIdle() {
  if (app.brainBusy) setState('thinking');
  else settle();
}

function settle() {
  if (speaker.busy || app.brainBusy) return;
  if (['listening', 'transcribing'].includes(app.state)) return;
  setState(idleState());
  if (app.settings?.followUp && app.lastSource === 'voice' && app.pendingFollowUp) {
    app.pendingFollowUp = false;
    startListening({ followUp: true });
  }
}

function chip(sel, cls) {
  const el = $(sel);
  el.classList.remove('ok', 'warn', 'bad', 'busy');
  if (cls) el.classList.add(cls);
}

function setTts(ok) {
  if (app.ttsOk === ok) return;
  app.ttsOk = ok;
  chip('#chip-voice', ok ? 'ok' : 'warn');
  if (!ok) toast('Нейроголос недоступен — временно говорю системным голосом Windows', 'warn', 5000);
}

// ---------------------------------------------------------------- microphone
async function ensureMic() {
  clearTimeout(app.micCloseTimer);
  if (mic.open) return true;
  try {
    await mic.start();
    chip('#chip-ears', 'ok');
    return true;
  } catch (e) {
    chip('#chip-ears', 'bad');
    toast('Нет доступа к микрофону: ' + e.message, 'bad', 6000);
    return false;
  }
}

function scheduleMicClose() {
  clearTimeout(app.micCloseTimer);
  if (app.wake || !mic.open || app.state === 'listening') return;
  app.micCloseTimer = setTimeout(() => {
    if (!app.wake && app.state !== 'listening') {
      mic.stop();
      chip('#chip-ears', '');
      if (app.state !== 'speaking') reactor.setAnalyser(null);
    }
  }, 20000);
}

async function startListening({ followUp = false } = {}) {
  speaker.clear();
  if (!(await ensureMic())) return;
  await voice.resume();
  vad.begin('command', { noSpeechMs: followUp ? 5500 : 8000 });
  setState('listening');
  sfx('listen');
  $('#sub-user').textContent = '';
}

function toggleListening() {
  if (app.state === 'listening') {
    vad.finish();
    if (app.state === 'listening') setState(idleState());
  } else {
    startListening();
  }
}

async function handleUtterance(audio, { mode }) {
  if (mode === 'wake') return handleWakeSegment(audio);
  setState('transcribing');
  sfx('captured');
  try {
    const { text } = await api.stt.transcribe(audio);
    if (app.state !== 'transcribing') return; // cancelled meanwhile
    handleTranscript(text);
  } catch (e) {
    setState(idleState());
    toast('Ошибка распознавания: ' + e.message, 'bad', 5000);
  }
}

function handleTranscript(text) {
  if (isNoise(text)) {
    setState(idleState());
    toast('Не расслышал, повторите, пожалуйста', 'warn', 2500);
    const c = pickClip('not_found');
    if (c) speaker.clip(c);
    return;
  }
  const cmd = wakeCommand(text);
  handleCommand(cmd ? cmd : text, 'voice');
}

async function handleWakeSegment(audio) {
  if (app.wakeBusy || app.state === 'speaking' || app.state === 'listening' || app.state === 'transcribing') return;
  app.wakeBusy = true;
  try {
    const quick = await api.stt.transcribe(audio, 'base');
    const cmd = wakeCommand(quick.text);
    if (cmd === null) return;
    if (!cmd) {
      speaker.clear();
      react('reply', tr('Слушаю, сэр.', 'Yes, sir?'));
      await waitSpeech();
      startListening();
      return;
    }
    let final = cmd;
    if (app.settings.sttModel !== 'base') {
      setState('transcribing');
      const full = await api.stt.transcribe(audio);
      const again = wakeCommand(full.text);
      final = again || (isNoise(full.text) ? cmd : full.text);
    }
    handleCommand(final, 'voice');
  } catch (e) {
    console.warn('wake stt', e.message);
  } finally {
    app.wakeBusy = false;
  }
}

async function waitSpeech() {
  await sleep(150);
  while (speaker.busy) await sleep(100);
}

// ---------------------------------------------------------------- commands
function handleCommand(text, source) {
  text = String(text || '').trim();
  if (!text) return;
  app.lastSource = source;
  app.pendingFollowUp = source === 'voice';
  $('#sub-user').textContent = text;
  $('#sub-jarvis').textContent = '';
  addLog('user', text);
  const intent = localIntent(text, app.projects);
  if (intent) return runIntent(intent);
  runMacroOrAsk(text, source);
}

/**
 * Routing: a confident macro (sandbox\macros) answers instantly; a doubtful one goes to Claude with the
 * candidate attached, and Claude either runs it ([[macro:id]] — then the phrase is learned) or answers itself;
 * everything else is Claude's.
 */
async function runMacroOrAsk(text, source) {
  if (app.settings?.macros !== false && api.macros) {
    const turn = ++app.macroTurn;
    setState('thinking');
    let r = null;
    try {
      r = await api.macros.route(text);
    } catch (e) {
      console.warn('macro', e.message);
    }
    if (turn !== app.macroTurn) return; // a newer command came in meanwhile
    if (r?.kind === 'macro') {
      app.lastMacro = { text, id: r.result.id, source, at: Date.now() };
      return macroDone(r.result);
    }
    if (r?.kind === 'maybe') {
      addActivity('ROUTE', `не уверен: ${r.candidate.id} · ${r.candidate.score}% — решит Claude`, 'info');
      return askBrain(text, source === 'voice', { macroHint: r.candidate });
    }
  }
  askBrain(text, source === 'voice');
}

/** Claude chose a macro for the last request: run it, and the phrase becomes one of the macro's. */
async function claudeMacro(id) {
  const text = app.macroQuestion || '';
  app.macroQuestion = null;
  try {
    const r = await api.macros.runId(id, text);
    app.lastMacro = { text, id, source: app.lastSource, at: Date.now() };
    if (text && !r.error) addActivity('ROUTE', `выучил фразу «${text}» → ${id}`, 'info');
    macroDone(r);
  } catch (e) {
    toast('Макрос не сработал: ' + errText(e), 'bad', 6000);
  }
}

/** "Не то": the last macro misfired — never on this phrase again, and the request goes to Claude. */
function macroWrong(text) {
  const last = app.lastMacro;
  app.lastMacro = null;
  if (!last || Date.now() - last.at > 2 * 60 * 1000) return askBrain(text, app.lastSource === 'voice');
  api.macros.block(last.text, last.id);
  addActivity('ROUTE', `фраза «${last.text}» больше не запускает ${last.id}`, 'info');
  addLog('system', `Макрос ${last.id} сработал по ошибке — запомнил, передаю запрос Claude.`);
  askBrain(last.text, last.source === 'voice', {
    note: `Предыдущую команду «${last.text}» HUD по ошибке принял за макрос ${last.id} и выполнил его; пользователь сказал, что это не то. Этот макрос на эту фразу больше не сработает. Коротко извинись и сделай то, что он просил на самом деле; если смысл неясен — переспроси. Не выдумывай теги: [[call:…]] только для загруженных плагинов песочницы.`,
  });
}

function macroDone(r) {
  speaker.clear();
  if (r.error) {
    addActivity('MACRO', `${r.id}: ${r.error}`, 'err');
    addLog('system', `Макрос ${r.id}: ${r.error}`);
    toast(`Макрос не сработал: ${r.error}`, 'bad', 7000);
    sfx('error');
    say(tr('Не получилось, сэр. Подробности на экране.', 'That did not work, sir. Details are on screen.'));
    return;
  }
  addActivity('MACRO', `${r.id} · ${r.score}%`, 'info');
  const spoken = [];
  if (r.reply.sound) spoken.push(react(r.reply.sound));
  if (r.reply.say) { say(r.reply.say); spoken.push(r.reply.say); }
  if (r.reply.notify) toast(r.reply.notify, '', 5000);
  addLog('jarvis', spoken.filter(Boolean).join(' ') || tr('Готово.', 'Done.'));
  for (const a of r.hud || []) macroHud(a);
  if (!speaker.busy) settle();
}

/** Macro actions that belong to the HUD rather than to Windows. */
function macroHud(a) {
  if (a.type === 'say') say(String(a.text || ''));
  else if (a.type === 'notify') toast(String(a.text || ''), a.kind || '', 5000);
  else if (a.type === 'ask') askBrain(String(a.text || ''), false);
  else if (a.type === 'hud') hudCommand(String(a.command || ''), String(a.arg ?? ''));
  else if (a.type === 'quit') waitSpeech().then(() => api.win.close());
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/** Picks the phrase in the language the current voice speaks. */
function tr(ru, en) {
  return voiceLang() === 'en' ? en : ru;
}

function runIntent(intent) {
  speaker.clear();
  const reply = (text) => { addLog('jarvis', text); say(text); };
  switch (intent.action) {
    case 'stop':
      stopAll(false);
      addLog('jarvis', react('ack', tr('Как скажете, сэр.', 'As you wish, sir.')));
      break;
    case 'reset':
      api.brain.reset();
      $('#core-session').textContent = 'новая';
      reply(tr('Контекст очищен, сэр. Начинаем с чистого листа.', 'Context cleared, sir. A clean slate.'));
      break;
    case 'time': {
      const d = new Date();
      const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
      reply(tr(`Сейчас ${hm}, сэр.`, `It's ${hm}, sir.`));
      break;
    }
    case 'list-projects': {
      const n = app.projects.length;
      if (!n) { reply(tr('Список проектов пока пуст, сэр.', 'The project list is empty, sir.')); break; }
      const names = app.projects.map((p) => p.name).join(', ');
      reply(tr(`В базе ${n} ${plural(n, 'проект', 'проекта', 'проектов')}, сэр: ${names}.`, `${n} ${n === 1 ? 'project' : 'projects'} on file, sir: ${names}.`));
      break;
    }
    case 'open-project': {
      const p = intent.project;
      const local = p.status?.state === 'protected' && p.localPath;
      openViewer(p, local ? 'local' : 'live');
      reply(local
        ? tr(`Открываю ${p.name}, сэр. Сайт сейчас закрыт доступом Netlify, поэтому показываю локальную копию.`, `Opening ${p.name}, sir. The live site is behind Netlify access control, so here is the local copy.`)
        : tr(`Открываю ${p.name}, сэр.`, `Opening ${p.name}, sir.`));
      break;
    }
    case 'wrong':
      speaker.clear();
      macroWrong(intent.text);
      break;
    case 'settings':
      openSettings();
      reply(tr('Настройки на экране, сэр.', 'Settings are on screen, sir.'));
      break;
    default:
      break;
  }
}

function askBrain(text, fromVoice, extra = {}) {
  speaker.clear();
  app.macroQuestion = extra.macroHint ? text : null; // learned as the macro's phrase if Claude picks it
  if (app.loggedIn === false) {
    const msg = 'Сэр, ядро Claude не авторизовано. Нажмите «Авторизовать Claude» на панели ядра — откроется окно входа.';
    addLog('system', msg);
    say(tr(msg, 'Sir, the Claude core is not authorised. Press Authorise on the core panel to sign in.'));
    $('#btn-login').classList.remove('hidden');
    return;
  }
  app.reply = new ReplyProcessor({
    onSentence: (s) => say(s),
    onCommand: (kind, arg) => hudCommand(kind, arg),
    notice: tr('Подробности вывел на экран, сэр.', 'The details are on screen, sir.'),
    codeNotice: tr('Код вывел на экран.', 'The code is on screen.'),
  });
  app.gotDelta = false;
  app.errorSpoken = false;
  app.logEntry = addLog('jarvis', '');
  app.logText = '';
  app.brainBusy = true;
  app.brainTurn += 1; // the main process numbers turns sequentially; ignore the previous turn's "stopped"
  if (fromVoice && app.settings?.phraseAck !== false) {
    const c = pickClip('thinking');
    if (c) speaker.clip(c);
  }
  setState('thinking');
  chip('#chip-core', 'busy');
  api.brain.ask(text, { voice: fromVoice, ...extra }).then((turn) => {
    if (turn > app.brainTurn) app.brainTurn = turn;
  });
}

function stopAll(announce = true) {
  speaker.clear();
  api.brain.stop();
  if (vad.mode === 'command') vad.cancel();
  app.brainBusy = false;
  app.reply = null;
  app.pendingFollowUp = false;
  finalizeLog();
  chip('#chip-core', app.loggedIn ? 'ok' : 'warn');
  setState(idleState());
  if (announce) sfx('tick');
}

async function hudCommand(kind, arg) {
  if (kind === 'open') {
    const url = arg.trim();
    const same = (a, b) => a && b && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
    const project = app.projects.find((p) => same(p.url, url));
    if (project) openViewer(project, project.status?.state === 'protected' && project.localPath ? 'local' : 'live');
    else if (/^https?:\/\//i.test(url)) openViewer({ id: null, name: new URL(url).hostname, url }, 'live');
  } else if (kind === 'project') {
    const [name, url, description] = arg.split('|').map((s) => (s || '').trim());
    try {
      app.projects = await api.projects.add({ name, url, description });
      renderProjects();
      toast(`Проект «${name}» добавлен в базу`, '', 4000);
      addActivity('HUD', `новый проект: ${name}`, 'info');
    } catch (e) {
      toast('Не удалось добавить проект: ' + e.message, 'bad');
    }
  } else if (kind === 'window') {
    openWidget(arg.trim());
  } else if (kind === 'close') {
    api.sandbox?.close(arg.trim());
  } else if (kind === 'call') {
    callPlugin(arg);
  } else if (kind === 'macro') {
    claudeMacro(arg.trim());
  } else if (kind === 'panel') {
    const id = arg.trim().toLowerCase();
    expandPanel(id === 'close' ? null : id);
  } else if (kind === 'voice') {
    const id = arg.trim();
    const v = app.settings.voices?.find((x) => x.id === id);
    if (!v) return toast('Неизвестный голос: ' + id, 'bad');
    app.settings = await api.settings.set({ voice: id });
    toast(`Голос: ${v.label}`, '', 4000);
    prepareVoice();
    addActivity('HUD', `голос: ${v.label}`, 'info');
  }
}

// ---------------------------------------------------------------- brain events
api.brain.onEvent((ev) => {
  if (ev.turn < app.brainTurn) return;
  switch (ev.kind) {
    case 'start':
      app.brainTurn = ev.turn;
      app.brainBusy = true;
      if (app.state !== 'speaking') setState('thinking');
      addActivity('CORE', 'запрос отправлен в Claude Code', 'info');
      break;
    case 'init':
      if (ev.model) $('#core-model').textContent = ev.model;
      break;
    case 'session':
      $('#core-session').textContent = ev.sessionId.slice(0, 8);
      break;
    case 'delta':
      app.gotDelta = true;
      app.reply?.push(ev.text);
      app.logText += ev.text;
      updateLog();
      break;
    case 'block-end':
      app.reply?.flush();
      if (app.logText && !app.logText.endsWith('\n')) app.logText += '\n\n';
      break;
    case 'tool':
      addActivity(ev.name, ev.detail);
      if (app.state !== 'speaking') setState('thinking');
      break;
    case 'tool-error':
      addActivity('ERR', ev.text, 'err');
      break;
    case 'error':
      brainError(ev);
      break;
    case 'done': {
      if (!app.gotDelta && ev.text && !ev.isError) {
        app.reply?.push(ev.text);
        app.logText += ev.text;
      }
      app.reply?.flush();
      finalizeLog();
      const parts = [];
      if (ev.durationMs) parts.push((ev.durationMs / 1000).toFixed(1) + ' с');
      const k = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
      if (ev.tokensIn || ev.tokensOut) parts.push(`${k(ev.tokensIn)} вх · ${k(ev.tokensOut)} вых`);
      if (ev.turns > 1) parts.push(ev.turns + ' шаг.');
      $('#core-last').textContent = parts.join(' · ') || '—';
      if (ev.denials) addActivity('PERM', `отклонено действий: ${ev.denials} (см. «Права на действия» в настройках)`, 'err');
      break;
    }
    case 'end':
    case 'stopped':
      app.brainBusy = false;
      chip('#chip-core', app.loggedIn === false ? 'warn' : 'ok');
      if (!speaker.busy) settle();
      break;
    default:
      break;
  }
});

function brainError(ev) {
  addActivity('ERR', ev.message, 'err');
  if (app.errorSpoken) return;
  app.errorSpoken = true;
  let speech = tr('Связь с ядром прервалась, сэр. Подробности в журнале.', 'I have lost the link to the core, sir. Details are in the log.');
  if (ev.code === 'auth') {
    app.loggedIn = false;
    renderCore();
    speech = tr('Сэр, ядро Claude не авторизовано. Нажмите «Авторизовать Claude» на панели ядра.', 'Sir, the Claude core is not authorised. Press Authorise on the core panel.');
  } else if (ev.code === 'missing') {
    speech = tr('Не нахожу Claude Code на этом компьютере, сэр. Укажите путь в настройках.', 'I cannot find Claude Code on this machine, sir. Please set its path in the settings.');
  }
  addLog('system', ev.message);
  sfx('error');
  say(speech);
}

// ---------------------------------------------------------------- log & activity
function now() {
  return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function addLog(who, text) {
  const log = $('#log');
  log.querySelector('.log-empty')?.remove();
  const el = document.createElement('div');
  el.className = 'msg ' + who;
  const label = { user: 'ВЫ', jarvis: 'JARVIS', system: 'SYSTEM' }[who];
  el.innerHTML = `<div class="who"><b>${label}</b><time>${now()}</time></div><div class="text"></div>`;
  el.querySelector('.text').textContent = text;
  log.appendChild(el);
  while (log.children.length > 120) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
  return el;
}

let logRaf = 0;
function updateLog() {
  if (logRaf) return;
  logRaf = requestAnimationFrame(() => {
    logRaf = 0;
    if (!app.logEntry) return;
    app.logEntry.querySelector('.text').textContent = stripTags(app.logText);
    const log = $('#log');
    log.scrollTop = log.scrollHeight;
  });
}

function finalizeLog() {
  const entry = app.logEntry;
  if (!entry) return;
  app.logEntry = null;
  const text = stripTags(app.logText || '');
  if (!text) { entry.remove(); return; }
  const html = text.split(/```[^\n]*\n?/).map((chunk, i) => (i % 2 ? `<pre>${esc(chunk.replace(/\n$/, ''))}</pre>` : esc(chunk))).join('');
  entry.querySelector('.text').innerHTML = html;
  $('#log').scrollTop = $('#log').scrollHeight;
}

function addActivity(name, detail, cls = '') {
  const box = $('#activity');
  const el = document.createElement('div');
  el.className = 'act ' + cls;
  el.innerHTML = `<time>${now()}</time><b>${esc(name)}</b><span title="${esc(detail)}">${esc(detail)}</span>`;
  box.appendChild(el);
  while (box.children.length > 80) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}

function toast(text, kind = '', ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---------------------------------------------------------------- panels
function fmtBytes(n) {
  const gb = n / 1024 ** 3;
  return gb >= 100 ? Math.round(gb) + ' ГБ' : gb.toFixed(1) + ' ГБ';
}

function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}д ${h}ч ${m}м` : `${h}ч ${m}м`;
}

function setGauge(id, v) {
  const el = $(id);
  const pct = Math.round(v * 100);
  el.querySelector('.g-fill').style.strokeDashoffset = String(314.16 * (1 - v));
  el.querySelector('b').textContent = pct;
  el.classList.toggle('hot', v > 0.85);
}

function drawSpark() {
  const cv = $('#cpu-spark');
  const w = cv.clientWidth, h = cv.clientHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  c.strokeStyle = 'rgba(67,229,255,.12)';
  c.lineWidth = 1;
  for (let y = 0; y <= 2; y++) { c.beginPath(); c.moveTo(0, 0.5 + (y * (h - 1)) / 2); c.lineTo(w, 0.5 + (y * (h - 1)) / 2); c.stroke(); }
  const pts = app.cpuHistory;
  if (pts.length < 2) return;
  const step = w / 59;
  const path = new Path2D();
  pts.forEach((v, i) => {
    const x = w - (pts.length - 1 - i) * step;
    const y = h - 2 - v * (h - 4);
    i ? path.lineTo(x, y) : path.moveTo(x, y);
  });
  const fill = new Path2D(path);
  fill.lineTo(w, h);
  fill.lineTo(w - (pts.length - 1) * step, h);
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(67,229,255,.35)');
  g.addColorStop(1, 'rgba(67,229,255,0)');
  c.fillStyle = g;
  c.fill(fill);
  c.strokeStyle = '#43e5ff';
  c.lineWidth = 1.5;
  c.shadowColor = '#43e5ff';
  c.shadowBlur = 6;
  c.stroke(path);
  c.shadowBlur = 0;
  c.font = '9px "JetBrains Mono"';
  c.fillStyle = 'rgba(122,168,188,.9)';
  c.fillText('CPU · 2 мин', 2, 10);
}

async function refreshStats() {
  try {
    const s = await api.sys.stats();
    setGauge('#g-cpu', s.cpu);
    setGauge('#g-ram', 1 - s.memFree / s.memTotal);
    app.cpuHistory.push(s.cpu);
    if (app.cpuHistory.length > 60) app.cpuHistory.shift();
    drawSpark();
    $('#kv-host').textContent = `${s.host} · ${s.user}`;
    $('#kv-cpu').textContent = `${s.cpuModel} · ${s.cores} потоков`;
    $('#kv-uptime').textContent = fmtUptime(s.uptime);
    $('#disks').innerHTML = s.disks.map((d) => {
      const used = 1 - d.free / d.total;
      return `<div class="disk"><span>${esc(d.name)}</span><div class="bar"><i class="${used > 0.9 ? 'hot' : ''}" style="width:${(used * 100).toFixed(1)}%"></i></div><span>${fmtBytes(d.free)} своб.</span></div>`;
    }).join('');
  } catch (e) {
    console.warn('stats', e.message);
  }
}

async function refreshPower() {
  try {
    if (!navigator.getBattery) throw new Error('n/a');
    const b = await navigator.getBattery();
    const show = () => {
      $('#kv-power').textContent = `${Math.round(b.level * 100)}% · ${b.charging ? 'сеть' : 'батарея'}`;
    };
    show();
    b.onlevelchange = b.onchargingchange = show;
  } catch {
    $('#kv-power').textContent = 'сеть';
  }
}

async function refreshWeather() {
  try {
    const w = await api.sys.weather();
    app.weather = w;
    const t = Math.round(w.temp);
    $('#w-temp').textContent = `${t > 0 ? '+' : ''}${t}°`;
    $('#w-city').textContent = w.city;
    $('#w-text').textContent = w.text;
    $('#w-feels').textContent = `${Math.round(w.feels)}°C`;
    $('#w-hum').textContent = `${w.humidity}%`;
    $('#w-wind').textContent = `${w.wind.toFixed(1)} м/с`;
    $('#w-range').textContent = w.min != null ? `${Math.round(w.min)}° / ${Math.round(w.max)}°` : '—';
    chip('#chip-net', 'ok');
  } catch (e) {
    $('#w-text').textContent = 'нет данных';
    chip('#chip-net', navigator.onLine ? 'warn' : 'bad');
  }
}

function tickClock() {
  const d = new Date();
  $('#clock-time').textContent = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('#clock-date').textContent = d.toLocaleDateString('ru-RU', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).replace(/\./g, '').replace(/,/g, ' ·');
}

function renderCore() {
  const st = $('#core-status');
  st.className = '';
  if (!app.claudePath) { st.textContent = 'claude.exe не найден'; st.classList.add('bad'); }
  else if (app.loggedIn) { st.textContent = 'ONLINE'; st.classList.add('ok'); }
  else if (app.loggedIn === false) { st.textContent = 'НЕ АВТОРИЗОВАН'; st.classList.add('warn'); }
  else st.textContent = 'проверка…';
  $('#btn-login').classList.toggle('hidden', app.loggedIn !== false || !app.claudePath);
  chip('#chip-core', app.loggedIn ? 'ok' : app.claudePath ? 'warn' : 'bad');
  if (!app.brainBusy) $('#core-model').textContent = app.settings?.model || 'по умолчанию';
}

async function checkBrain() {
  try {
    const s = await api.brain.status();
    app.claudePath = s.claudePath;
    app.loggedIn = s.loggedIn;
    if (s.sessionId) $('#core-session').textContent = s.sessionId.slice(0, 8);
  } catch (e) {
    app.loggedIn = false;
  }
  renderCore();
  return app.loggedIn;
}

// ---------------------------------------------------------------- projects
const STATUS_LABEL = { online: 'ONLINE', protected: 'PROTECTED', offline: 'OFFLINE', error: 'ERROR' };
const STATUS_HINT = {
  online: 'Сайт доступен',
  protected: 'Сайт закрыт доступом Netlify (HTTP 401): посетители видят страницу входа',
  offline: 'Сайт не отвечает',
  error: 'Сайт отвечает ошибкой',
};

function host(url) {
  try { return new URL(url).hostname; } catch { return url || 'локальный проект'; }
}

function renderProjects() {
  const box = $('#projects');
  $('#proj-count').textContent = String(app.projects.length).padStart(2, '0');
  if (!app.projects.length) {
    box.innerHTML = '<div class="projects-empty">Проектов пока нет. Нажмите «+», чтобы добавить.</div>';
    return;
  }
  box.innerHTML = app.projects.map((p) => {
    const st = p.status?.state;
    const status = st
      ? `<span class="p-status ${st}" title="${esc(STATUS_HINT[st])}"><i></i>${STATUS_LABEL[st]}${p.status.ms ? ' · ' + p.status.ms + 'ms' : ''}</span>`
      : '<span class="p-status"><i></i>SCAN…</span>';
    return `<article class="project" data-id="${esc(p.id)}" title="Открыть в HUD">
      <div class="p-thumb">
        ${p.thumb ? `<img src="${esc(p.thumb)}" alt="">` : '<div class="p-empty">NO SIGNAL</div>'}
        ${status}
        <div class="p-title"><b>${esc(p.name)}</b><span>${esc(host(p.url))}</span></div>
      </div>
      <div class="p-body">
        <div class="p-desc">${esc(p.description)}</div>
        <div class="p-foot">
          <span class="p-stack">${esc(p.stack || '')}</span>
          ${p.url ? '<button class="icon-btn" data-act="external" title="Открыть в браузере"><svg><use href="#i-globe"/></svg></button>' : ''}
          ${p.localPath ? '<button class="icon-btn" data-act="folder" title="Открыть папку проекта"><svg><use href="#i-folder"/></svg></button>' : ''}
          <button class="icon-btn danger" data-act="remove" title="Убрать из списка"><svg><use href="#i-close"/></svg></button>
        </div>
      </div>
    </article>`;
  }).join('');
}

$('#projects').addEventListener('click', async (e) => {
  const card = e.target.closest('.project');
  if (!card) return;
  const p = app.projects.find((x) => x.id === card.dataset.id);
  if (!p) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'external') return api.shell.openExternal(p.url);
  if (act === 'folder') return api.projects.openFolder(p.id);
  if (act === 'remove') {
    if (!confirm(`Убрать «${p.name}» из списка проектов? Сам сайт и файлы не удаляются.`)) return;
    app.projects = await api.projects.remove(p.id);
    renderProjects();
    return;
  }
  openViewer(p, p.status?.state === 'protected' && p.localPath ? 'local' : 'live');
});

async function refreshProjects(check = false) {
  try {
    app.projects = check ? await api.projects.check() : await api.projects.list();
    renderProjects();
  } catch (e) {
    console.warn('projects', e.message);
  }
}

// ---------------------------------------------------------------- viewer
let viewerProject = null;

function openViewer(project, mode = 'live') {
  viewerProject = project;
  $('#viewer').classList.remove('hidden');
  $('#viewer-title').textContent = project.name.toUpperCase();
  const localBtn = $('#viewer-mode [data-mode="local"]');
  localBtn.disabled = !project.localPath || !project.id;
  $('#viewer-mode [data-mode="live"]').disabled = !project.url;
  $('#viewer-folder').classList.toggle('hidden', !project.localPath);
  if (mode === 'local' && localBtn.disabled) mode = 'live';
  setViewerMode(mode);
}

function setViewerMode(mode) {
  const p = viewerProject;
  if (!p) return;
  document.querySelectorAll('#viewer-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  const src = mode === 'local' ? `app://local/${encodeURIComponent(p.id)}/index.html` : p.url;
  $('#viewer-url').textContent = mode === 'local' ? `${p.localPath}\\index.html` : p.url;
  const body = $('#viewer-body');
  body.innerHTML = '';
  const view = document.createElement(api.mock ? 'iframe' : 'webview');
  view.setAttribute('src', src);
  if (!api.mock) view.setAttribute('partition', 'persist:projects');
  view.style.border = '0';
  body.appendChild(view);
}

function closeViewer() {
  $('#viewer').classList.add('hidden');
  $('#viewer-body').innerHTML = '';
  viewerProject = null;
}

$('#viewer-mode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && !b.disabled) setViewerMode(b.dataset.mode);
});
$('#viewer-close').addEventListener('click', closeViewer);
$('#viewer-external').addEventListener('click', () => viewerProject?.url && api.shell.openExternal(viewerProject.url));
$('#viewer-folder').addEventListener('click', () => viewerProject?.id && api.projects.openFolder(viewerProject.id));

// ---------------------------------------------------------------- add project
$('#btn-add-project').addEventListener('click', () => {
  $('#add-form').reset();
  $('#add-project').classList.remove('hidden');
  $('#add-form [name=name]').focus();
});
$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  try {
    app.projects = await api.projects.add(data);
    renderProjects();
    $('#add-project').classList.add('hidden');
    toast(`Проект «${data.name}» добавлен`);
  } catch (err) {
    toast('Не удалось добавить: ' + err.message, 'bad');
  }
});

// ---------------------------------------------------------------- settings
function fillSettings() {
  const s = app.settings;
  const f = $('#settings-form');
  const groups = [];
  for (const v of s.voices || []) {
    let g = groups.find((x) => x.key === v.group);
    if (!g) groups.push((g = { key: v.group, label: v.groupLabel || v.group, voices: [] }));
    g.voices.push(v);
  }
  $('#set-voice').innerHTML = groups.map((g) => `<optgroup label="${esc(g.label)}">${g.voices
    .map((v) => `<option value="${esc(v.id)}">${esc(v.label)}${v.offline && !v.ready ? ` · скачается ${v.mb} МБ` : ''}</option>`).join('')}</optgroup>`).join('');
  $('#set-city').innerHTML = CITIES.map((c, i) => `<option value="${i}">${esc(c.name)}</option>`).join('');
  $('#set-phrases').innerHTML = '<option value="">Выключены — всё говорит нейроголос</option>' + (s.phrasePacks || [])
    .map((p) => `<option value="${esc(p.id)}">${esc(p.title)} — ${esc(p.note)}${p.ready ? '' : ` · скачается ${(p.kb / 1024).toFixed(1)} МБ`}</option>`).join('');
  for (const el of f.elements) {
    if (!el.name || !(el.name in s)) continue;
    if (el.name === 'city') el.value = String(Math.max(0, CITIES.findIndex((c) => c.name === s.city?.name)));
    else if (el.type === 'checkbox') el.checked = !!s[el.name];
    else el.value = s[el.name] ?? '';
  }
  updateOutputs();
}

function updateOutputs() {
  const f = $('#settings-form');
  const pct = (v) => `${v > 0 ? '+' : ''}${v}%`;
  $('#out-pitch').textContent = pct(Number(f.pitch.value));
  $('#out-rate').textContent = pct(Number(f.rate.value));
  $('#out-volume').textContent = Math.round(Number(f.volume.value) * 100) + '%';
  const v = app.settings.voices?.find((x) => x.id === f.voice.value);
  if (!v) return;
  const parts = [];
  if (v.offline) parts.push(`Офлайн, работает без интернета. ${v.ready ? 'Модель уже на диске.' : `При первом выборе скачается ≈${v.mb} МБ.`}`);
  else parts.push('Онлайн-голос Microsoft, нужен интернет.');
  if (v.lang === 'en') parts.push('Отвечает по-английски; русские фразы озвучит запасной голос Дмитрий.');
  if (v.license) parts.push(`Лицензия: ${v.license}.`);
  if (v.offline) parts.push('Тон для офлайн-голосов не меняется — только скорость.');
  if (v.engine === 'xtts') {
    parts.length = 0;
    parts.push('Клон голоса Джарвиса из фильма: нужен запущенный xtts-api-server (Python, лучше с видеокартой NVIDIA), адрес ниже.',
      'Образец голоса JARVIS склеит сам из фраз «Оригинал из фильма». Если сервер не отвечает, говорит Дмитрий «Джарвис».');
  }
  $('#voice-hint').textContent = parts.join(' ');
  f.pitch.disabled = !!v.offline || v.engine === 'xtts';
}

function readSettings() {
  const f = $('#settings-form');
  const out = {};
  for (const el of f.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'range') out[el.name] = Number(el.value);
    else if (el.name === 'city') out.city = CITIES[Number(el.value)] || CITIES[0];
    else out[el.name] = el.value.trim();
  }
  return out;
}

function openSettings() {
  fillSettings();
  $('#settings').classList.remove('hidden');
}

function currentVoice() {
  return app.settings?.voices?.find((x) => x.id === app.settings.voice) || null;
}

/** Downloads and loads an offline voice model if the chosen voice needs one; resolves true when it is ready. */
async function prepareVoice() {
  const v = currentVoice();
  if (!v?.offline) return true;
  if (!v.ready) toast(`Скачиваю голос «${v.label.split(' — ')[0]}» (≈${v.mb} МБ). Пока говорю запасным голосом.`, '', 6000);
  try {
    const voices = await api.tts.prepare(v.id);
    if (voices) app.settings = { ...app.settings, voices };
    if (!v.ready) toast(`Голос «${v.label.split(' — ')[0]}» готов`, '', 4000);
    return true;
  } catch (e) {
    toast('Не удалось подготовить голос: ' + e.message, 'bad', 6000);
    return false;
  }
}

async function applySettings(prev) {
  const s = app.settings;
  if (prev && prev.voice !== s.voice) prepareVoice();
  if (prev && prev.phrasePack !== s.phrasePack) app.clipsLoading = loadClips();
  voice.setFx(!!s.voiceFx);
  voice.setVolume(Number(s.volume));
  if (prev && (prev.sttModel !== s.sttModel || prev.sttGroqKey !== s.sttGroqKey || prev.sttOpenaiKey !== s.sttOpenaiKey)) api.stt.load(s.sttModel);
  if (!prev || prev.wakeWord !== s.wakeWord) await setWake(!!s.wakeWord, false);
  if (prev && prev.city?.name !== s.city?.name) refreshWeather();
  renderCore();
}

$('#settings-form').addEventListener('input', updateOutputs);
$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prev = app.settings;
  app.settings = await api.settings.set(readSettings());
  $('#settings').classList.add('hidden');
  await applySettings(prev);
  toast('Настройки сохранены');
});
$('#btn-pick-dir').addEventListener('click', async () => {
  const dir = await api.settings.pickDir();
  if (dir) $('#settings-form').workDir.value = dir;
});
$('#btn-test-voice').addEventListener('click', async () => {
  const f = readSettings();
  app.settings = await api.settings.set({ voice: f.voice, pitch: f.pitch, rate: f.rate, volume: f.volume, voiceFx: f.voiceFx });
  voice.setFx(!!f.voiceFx);
  voice.setVolume(Number(f.volume));
  speaker.clear();
  const v = currentVoice();
  if (v?.offline && !v.ready && !(await prepareVoice())) return;
  say(voiceLang() === 'en' ? 'Good evening, sir. JARVIS at your service. All systems are online.' : 'Добрый день, сэр. Так звучит мой голос.');
});

document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('.overlay').classList.add('hidden')));
document.querySelectorAll('.overlay').forEach((o) => o.addEventListener('mousedown', (e) => {
  if (e.target === o) (o.id === 'viewer' ? closeViewer() : o.classList.add('hidden'));
}));

// ---------------------------------------------------------------- wake mode
async function setWake(on, persist = true) {
  if (on && !(await ensureMic())) on = false;
  app.wake = on;
  $('#btn-wake').classList.toggle('on', on);
  if (on) {
    api.stt.load('base');
    if (app.state === 'idle') setState('wake');
    else if (vad.mode !== 'command') vad.begin('wake');
  } else {
    if (vad.mode === 'wake') vad.cancel();
    if (app.state === 'wake') setState('idle');
    scheduleMicClose();
  }
  if (persist && app.settings.wakeWord !== on) app.settings = await api.settings.set({ wakeWord: on });
}

// ---------------------------------------------------------------- controls
$('#btn-mic').addEventListener('click', toggleListening);
$('#reactor-wrap').addEventListener('click', toggleListening);
$('#btn-stop').addEventListener('click', () => stopAll());
$('#btn-wake').addEventListener('click', async () => {
  await setWake(!app.wake);
  toast(app.wake ? 'Режим «Джарвис»: скажите «Джарвис» и команду' : 'Режим «Джарвис» выключен', '', 3000);
});
$('#btn-settings').addEventListener('click', openSettings);
$('#btn-reset').addEventListener('click', () => runIntent({ action: 'reset' }));
$('#btn-login').addEventListener('click', async () => {
  const ok = await api.brain.login();
  if (!ok) return toast('Не найден claude.exe — укажите путь в настройках', 'bad');
  toast('Открыл окно входа в Claude. Завершите вход в браузере — я подожду.', '', 7000);
  for (let i = 0; i < 90; i++) {
    await sleep(3000);
    if (await checkBrain()) {
      say(tr('Авторизация прошла успешно, сэр. Ядро онлайн.', 'Authorisation complete, sir. The core is online.'));
      addLog('system', 'Claude Code авторизован. Ядро онлайн.');
      return;
    }
  }
});

$('#command-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#command-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  voice.resume();
  handleCommand(text, 'text');
});

$('#win-min').addEventListener('click', () => api.win.minimize());
$('#win-max').addEventListener('click', () => api.win.maximize());
$('#win-close').addEventListener('click', () => api.win.close());
api.onHotkey(() => startListening());

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  const overlay = document.querySelector('.overlay:not(.hidden)');
  if (e.key === 'Escape') {
    if (overlay) { overlay.id === 'viewer' ? closeViewer() : overlay.classList.add('hidden'); return; }
    if (document.querySelector('.panel.expanded')) { expandPanel(null); return; }
    stopAll();
    return;
  }
  if (e.ctrlKey && e.key === ',') { e.preventDefault(); openSettings(); return; }
  if (e.code === 'Space' && !typing && !overlay && !e.repeat) {
    e.preventDefault();
    if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur(); // no second "click" on keyup
    toggleListening();
  }
});

window.addEventListener('focus', () => { if (app.loggedIn === false) checkBrain(); });
window.addEventListener('online', refreshWeather);
window.addEventListener('offline', () => chip('#chip-net', 'bad'));

api.tts.onStatus?.((s) => {
  const el = $('#status-voice');
  if (s.state === 'downloading') {
    el.textContent = `VOICE · загрузка ${s.title} ${Math.round((s.progress || 0) * 100)}%`;
    chip('#chip-voice', 'busy');
  } else if (s.state === 'extracting') {
    el.textContent = `VOICE · распаковка ${s.title}`;
  } else if (s.state === 'ready') {
    el.textContent = '';
    chip('#chip-voice', 'ok');
  } else if (s.state === 'error') {
    el.textContent = 'VOICE · ошибка загрузки';
    chip('#chip-voice', 'warn');
    toast(`Не удалось скачать голос ${s.title}: ${s.message}`, 'bad', 7000);
  }
});

api.phrases?.onStatus((s) => {
  const el = $('#status-voice');
  if (s.state === 'downloading') el.textContent = `PHRASES · загрузка ${s.title} ${Math.round((s.progress || 0) * 100)}%`;
  else if (s.state === 'ready') { el.textContent = ''; addActivity('VOICE', `фразы Джарвиса загружены: ${s.title}`, 'info'); }
  else if (s.state === 'error') { el.textContent = 'PHRASES · ошибка загрузки'; toast(`Не удалось скачать фразы «${s.title}»: ${s.message}`, 'bad', 7000); }
});

let lastFallbackToast = 0;
api.tts.onStatus?.((s) => {
  if (s.state !== 'fallback' || Date.now() - lastFallbackToast < 60000) return;
  lastFallbackToast = Date.now();
  toast('XTTS-сервер не отвечает — говорю голосом Дмитрий «Джарвис»', 'warn', 6000);
  addActivity('VOICE', `клон голоса недоступен: ${s.message}`, 'err');
});

api.macros?.onLoaded((m) => {
  addActivity('MACRO', `макросы загружены: ${m.count}${m.errors.length ? `, ошибок ${m.errors.length}` : ''}`, m.errors.length ? 'err' : 'info');
});

api.onNotice?.((n) => toast(n.text, n.kind || '', 5000));

api.stt.onStatus((s) => {
  const cloudSel = ['groq', 'openai'].includes(app.settings?.sttModel);
  if (s.state === 'fallback') {
    toast('Облачное распознавание недоступно, слушаю локально: ' + (s.message || ''), 'warn', 5000);
    return;
  }
  if (cloudSel && s.state === 'error' && s.size === app.settings.sttModel) {
    toast('Для облачного распознавания нужен API-ключ (Настройки → Слух). Пока слушаю локально.', 'warn', 7000);
    return;
  }
  // the small "base" helper for wake-word spotting is not what the EARS row reports (the cloud fallback is)
  const shown = cloudSel && s.size === 'small' ? 'small' : app.settings?.sttModel;
  if (s.size && app.settings && s.size !== shown && s.state !== 'error') return;
  const label = s.cloud ? { groq: 'groq · whisper-large-v3', openai: 'openai · gpt-4o-transcribe' }[s.size] : `whisper-${s.size || app.settings?.sttModel}`;
  if (s.state === 'loading') {
    const pct = Math.round((s.progress || 0) * 100);
    $('#status-stt').textContent = `STT · загрузка ${label} ${pct}%`;
    $('#core-stt').textContent = `загрузка ${pct}%`;
  } else if (s.state === 'ready') {
    app.sttReady = true;
    $('#status-stt').textContent = `STT · ${label} ✓`;
    $('#core-stt').textContent = `${label} · ${s.cloud ? 'CLOUD' : 'CPU'}`;
  } else if (s.state === 'error') {
    $('#status-stt').textContent = 'STT · ошибка';
    $('#core-stt').textContent = 'ошибка модели';
    toast('Модуль распознавания речи: ' + (s.message || 'ошибка'), 'bad', 6000);
  }
});

// ---------------------------------------------------------------- boot
/** { hello, rest }: the greeting proper and what follows it (weather, warnings). */
function greeting() {
  const h = new Date().getHours();
  const en = voiceLang() === 'en';
  if (en) {
    const part = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const rest = app.loggedIn === false ? 'The Claude core is not authorised yet — press Authorise on the core panel.' : '';
    return { hello: `${part}, sir. JARVIS online, all systems nominal.`, rest };
  }
  const part = h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
  const rest = [];
  const w = app.weather;
  if (w && Number.isFinite(w.temp)) {
    const t = Math.round(w.temp);
    const city = CITIES.find((c) => c.name === w.city);
    rest.push(`В ${city ? city.in : w.city} сейчас ${t < 0 ? 'минус ' + -t : t} ${plural(t, 'градус', 'градуса', 'градусов')}, ${w.text}.`);
  }
  if (app.loggedIn === false) rest.push('Однако ядро Claude пока не авторизовано — нажмите «Авторизовать» на панели ядра.');
  return { hello: `${part}, сэр. Джарвис на связи, все системы в норме.`, rest: rest.join(' ') };
}

function speakGreeting() {
  const { hello, rest } = greeting();
  const c = voiceLang() === 'ru' ? clips.greeting() : null;
  $('#sub-jarvis').textContent = '';
  if (c) {
    speaker.clip(c);
    if (rest) say(rest);
    addLog('jarvis', [c.text, rest].filter(Boolean).join(' '));
  } else {
    const text = [hello, rest].filter(Boolean).join(' ');
    say(text);
    addLog('jarvis', text);
  }
}

/** Loads the chosen phrase pack; the first time it is downloaded (a few MB). */
function loadClips() {
  const pack = app.settings?.phrasePack || '';
  return clips.load(pack).then((n) => {
    if (pack) $('#core-phrases').textContent = n ? `${phrasePackTitle(pack)} · ${n}` : 'нет';
    else $('#core-phrases').textContent = 'выкл.';
    return n;
  }).catch((e) => {
    $('#core-phrases').textContent = 'ошибка';
    toast('Фразы Джарвиса не загрузились: ' + e.message, 'warn', 6000);
    return 0;
  });
}

function phrasePackTitle(id) {
  return app.settings?.phrasePacks?.find((p) => p.id === id)?.title || id;
}

async function boot() {
  if (app.hotBoot) {
    // back from a live update: no boot sequence, no greeting — the same screen, one quiet notice
    $('#boot').classList.add('done');
    checkBrain();
    refreshWeather();
    api.stt.load(app.settings.sttModel);
    setState(idleState());
    const restored = restoreSnapshot();
    addActivity('SANDBOX', restored ? 'обновление применено, журнал сохранён' : 'обновление применено', 'info');
    toast(tr('Обновление применено', 'Update applied'), '', 2500);
    sfx('tick');
    return;
  }
  const logEl = $('#boot-log');
  const bar = $('#boot-bar');
  let lines = [];
  const print = (text) => { lines.push(text); logEl.textContent = lines.slice(-7).join('\n'); };
  const progress = (v) => { bar.style.width = `${Math.round(v * 100)}%`; };
  const dots = (label, status) => `> ${label} ${'.'.repeat(Math.max(3, 44 - label.length))} ${status}`;

  sfx('boot');
  print('> J.A.R.V.I.S. — холодный старт');
  progress(0.08);
  const brainCheck = checkBrain();
  const weatherLoad = refreshWeather();
  await sleep(260);
  print(dots('Голографический интерфейс', 'OK'));
  progress(0.22);
  await sleep(220);
  print(dots('Нейроголос', 'OK'));
  progress(0.36);
  await sleep(220);
  api.stt.load(app.settings.sttModel);
  print(dots(`Слух: ${['groq', 'openai'].includes(app.settings.sttModel) ? 'облако ' + app.settings.sttModel : 'Whisper ' + app.settings.sttModel}`, 'ЗАГРУЗКА'));
  progress(0.5);
  if (app.settings.phrasePack) {
    const n = await Promise.race([app.clipsLoading, sleep(2500).then(() => null)]);
    print(dots(`Фразы Джарвиса: ${phrasePackTitle(app.settings.phrasePack)}`, n ? `${n} ЗАПИСЕЙ` : n === 0 ? 'НЕТ' : 'ЗАГРУЗКА'));
  }
  const mc = await api.macros?.list().catch(() => null);
  if (mc) print(dots(`Макросы: ${mc.count}`, mc.errors.length ? `ОШИБОК ${mc.errors.length}` : 'OK'));
  const logged = await Promise.race([brainCheck, sleep(6000).then(() => null)]);
  print(dots('Ядро Claude Code', logged ? 'ONLINE' : logged === false ? 'НЕ АВТОРИЗОВАНО' : 'ПРОВЕРКА'));
  progress(0.7);
  await sleep(200);
  const n = app.projects.length;
  print(dots(`База проектов: ${n} ${plural(n, 'запись', 'записи', 'записей')}`, 'OK'));
  progress(0.86);
  await Promise.race([weatherLoad, sleep(1500)]);
  await sleep(200);
  print('> Все системы в норме. Добро пожаловать, сэр.');
  progress(1);
  await sleep(450);
  $('#boot').classList.add('done');
  setState(idleState());
  $('#state-text').textContent = STATE_TEXT[idleState()][1];
  if (app.settings.greeting) speakGreeting();
}

async function init() {
  app.settings = await api.settings.get();
  app.hotBoot = !!(await api.hot?.boot());
  $('#status-version').textContent = 'v' + (app.settings.version || '1.0');
  voice.setFx(!!app.settings.voiceFx);
  voice.setVolume(Number(app.settings.volume ?? 0.9));
  app.clipsLoading = loadClips();
  $('#log').innerHTML = '<div class="log-empty">Журнал связи пуст. Скажите что-нибудь, сэр.</div>';
  tickClock();
  setInterval(tickClock, 1000);
  await refreshProjects(false);
  refreshProjects(true);
  setInterval(() => refreshProjects(true), 5 * 60 * 1000);
  refreshStats();
  setInterval(refreshStats, 2000);
  refreshPower();
  setInterval(refreshWeather, 10 * 60 * 1000);
  chip('#chip-voice', 'ok');
  if (api.mock) addActivity('DEMO', 'браузерный режим: ядро и голос эмулируются', 'info');
  await boot();
  if (app.settings.wakeWord) setWake(true, false);
  loadHudMods();
}

// ---------------------------------------------------------------- full-screen cards
/** Expands the card `panel-<id>` over the HUD; null collapses whatever is expanded. */
function expandPanel(id) {
  const open = document.querySelector('.panel.expanded');
  const target = id ? document.getElementById('panel-' + id) : null;
  if (open) {
    open.classList.remove('expanded');
    open.querySelector('.expand-btn use').setAttribute('href', '#i-expand');
  }
  $('.panel-backdrop')?.remove();
  if (!target || target === open) return;
  target.classList.add('expanded');
  target.querySelector('.expand-btn use').setAttribute('href', '#i-collapse');
  const backdrop = document.createElement('div');
  backdrop.className = 'panel-backdrop';
  backdrop.addEventListener('click', () => expandPanel(null));
  // .hud is its own stacking context: a backdrop on <body> would sit above the card and blur it
  $('.hud').append(backdrop);
  if (id === 'log') $('#log').scrollTop = $('#log').scrollHeight;
}

document.querySelectorAll('.hud .panel').forEach((panel) => {
  const btn = document.createElement('button');
  btn.className = 'icon-btn expand-btn';
  btn.title = 'На весь экран';
  btn.innerHTML = '<svg><use href="#i-expand"/></svg>';
  btn.addEventListener('click', () => expandPanel(panel.id.replace(/^panel-/, '')));
  const head = panel.querySelector('.panel-head');
  head.insertBefore(btn, head.querySelector('.icon-btn'));
});

// ---------------------------------------------------------------- sandbox: live windows, plugins, HUD mods
const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
let widgets = [];

function renderDock(list) {
  widgets = Array.isArray(list) ? list : widgets;
  $('#dock').classList.toggle('hidden', !widgets.length);
  $('#dock-items').innerHTML = widgets.map((w) => `<button class="dock-item${w.open ? ' open' : ''}" data-id="${esc(w.id)}" title="${esc(w.description || w.title)}"><i></i>${esc(w.title)}</button>`).join('');
}

function flashDock(id) {
  setTimeout(() => $(`#dock-items [data-id="${CSS.escape(id)}"]`)?.classList.add('flash'), 150);
}

async function openWidget(id) {
  try {
    await api.sandbox.open(id);
  } catch (e) {
    toast(errText(e), 'bad', 6000);
    addActivity('SANDBOX', errText(e), 'err');
  }
}

/** [[call:plugin.method|JSON]] — a JSON array spreads into several arguments, anything else is one argument. */
async function callPlugin(arg) {
  const [target, ...rest] = String(arg).split('|');
  const [plugin, method] = target.trim().split('.');
  const raw = rest.join('|').trim();
  let args = [];
  if (raw) {
    try { const v = JSON.parse(raw); args = Array.isArray(v) ? v : [v]; } catch { args = [raw]; }
  }
  try {
    const r = await api.sandbox.call(plugin, method, args);
    addActivity('PLUGIN', `${plugin}.${method} → ${r === null ? 'ok' : JSON.stringify(r).slice(0, 120)}`, 'info');
  } catch (e) {
    toast(`Плагин ${plugin}: ${errText(e)}`, 'bad', 6000);
    addActivity('PLUGIN', `${plugin}.${method}: ${errText(e)}`, 'err');
  }
}

$('#dock-items').addEventListener('click', (e) => {
  const b = e.target.closest('.dock-item');
  if (b) openWidget(b.dataset.id);
});
$('#dock-items').addEventListener('contextmenu', (e) => {
  const b = e.target.closest('.dock-item');
  if (!b) return;
  e.preventDefault();
  api.sandbox.close(b.dataset.id);
});

// sandbox\hud\hud.css and hud.js: live additions to this window, swapped on every edit
const hudMod = { module: null, cleanup: null, listeners: new Set() };

async function exists(url) {
  try { return (await fetch(url, { method: 'HEAD', cache: 'no-store' })).ok; } catch { return false; }
}

function hudApi() {
  return {
    layer: $('#sandbox-layer'),
    $: (sel) => document.querySelector(sel),
    say: (t) => { addLog('jarvis', String(t)); say(String(t)); },
    toast: (t, kind = '') => toast(String(t), kind, 4000),
    ask: (t) => handleCommand(String(t), 'text'),
    activity: (name, detail, cls = '') => addActivity(String(name), String(detail), cls),
    openWindow: (id) => openWidget(String(id)),
    call: (plugin, method, ...args) => api.sandbox.call(plugin, method, args),
    on: (event, cb) => { const l = { event: String(event), cb }; hudMod.listeners.add(l); return () => hudMod.listeners.delete(l); },
    state: () => app.state,
  };
}

async function loadHudMods({ css = true, js = true, v = Date.now() } = {}) {
  if (!api.sandbox) return;
  if (css) {
    let link = document.getElementById('sandbox-hud-css');
    if (!(await exists('/sandbox/hud/hud.css'))) link?.remove();
    else {
      if (!link) {
        link = Object.assign(document.createElement('link'), { id: 'sandbox-hud-css', rel: 'stylesheet' });
        document.head.append(link);
      }
      link.href = `/sandbox/hud/hud.css?v=${v}`;
    }
  }
  if (!js) return;
  try { await hudMod.cleanup?.(); } catch (e) { console.error('hud.js cleanup', e); }
  try { await hudMod.module?.unmount?.(); } catch (e) { console.error('hud.js unmount', e); }
  hudMod.module = null;
  hudMod.cleanup = null;
  hudMod.listeners.clear();
  $('#sandbox-layer').replaceChildren();
  if (!(await exists('/sandbox/hud/hud.js'))) return;
  try {
    const mod = await import(`/sandbox/hud/hud.js?v=${v}`);
    hudMod.module = mod;
    const ret = await mod.mount?.(hudApi());
    if (typeof ret === 'function') hudMod.cleanup = ret;
  } catch (e) {
    addActivity('SANDBOX', `hud.js: ${e.message}`, 'err');
    toast('Мод HUD с ошибкой: ' + e.message, 'bad', 7000);
  }
}

if (api.sandbox) {
  api.sandbox.list().then(renderDock).catch(() => {});
  api.sandbox.onWidgets(renderDock);
  api.sandbox.onCreated((m) => {
    addActivity('SANDBOX', `новое окно: ${m.title}`, 'info');
    toast(tr(`Новое окно: ${m.title}`, `New window: ${m.title}`), '', 3500);
    flashDock(m.id);
  });
  api.sandbox.onUpdated((m) => addActivity('SANDBOX', `окно обновлено: ${m.title}`));
  api.sandbox.onPlugin((p) => addActivity('SANDBOX', `плагин загружен: ${p.name}`, 'info'));
  let lastErrorToast = 0;
  api.sandbox.onError((e) => {
    addActivity('SANDBOX', `[${e.source}] ${e.message}`, 'err');
    if (Date.now() - lastErrorToast > 5000) {
      lastErrorToast = Date.now();
      toast(`Песочница: [${e.source}] ${e.message}`, 'bad', 6000);
    }
  });
  api.sandbox.onAction((a) => {
    if (a.type === 'say') { addLog('jarvis', a.text); say(a.text); }
    else if (a.type === 'notify') toast(a.text, a.kind || '', 5000);
    else if (a.type === 'ask') handleCommand(a.text, 'text');
  });
  api.sandbox.onHud((h) => loadHudMods(h));
  api.sandbox.onEvent((ev) => {
    for (const l of hudMod.listeners) {
      if (l.event !== '*' && l.event !== ev.event && l.event !== `${ev.plugin}.${ev.event}`) continue;
      try { l.cb(ev.data, ev); } catch (err) { console.error('hud.js listener', err); }
    }
  });
}

// core stylesheet edits restyle the HUD in place: no reload, nothing lost
api.hot?.onCss?.(() => {
  for (const link of document.querySelectorAll('link[rel="stylesheet"]:not(#sandbox-hud-css)')) {
    const url = new URL(link.href);
    url.searchParams.set('v', Date.now());
    link.href = url.toString();
  }
  addActivity('SANDBOX', 'стили HUD обновлены на лету', 'info');
});

// A reload of this window (after an edit to its scripts) keeps the conversation on screen.
const SNAPSHOT = 'jarvis:hot-snapshot';
function saveSnapshot() {
  try {
    localStorage.setItem(SNAPSHOT, JSON.stringify({
      at: Date.now(),
      log: $('#log').innerHTML,
      activity: $('#activity').innerHTML,
      sub: [$('#sub-user').textContent, $('#sub-jarvis').textContent],
      expanded: document.querySelector('.panel.expanded')?.id?.replace(/^panel-/, '') || null,
    }));
  } catch { /* storage unavailable */ }
}

function restoreSnapshot() {
  let s = null;
  try {
    s = JSON.parse(localStorage.getItem(SNAPSHOT) || 'null');
    localStorage.removeItem(SNAPSHOT);
  } catch { /* storage unavailable */ }
  if (!s || Date.now() - s.at > 3 * 60 * 1000) return false;
  $('#log').innerHTML = s.log;
  $('#activity').innerHTML = s.activity;
  [$('#sub-user').textContent, $('#sub-jarvis').textContent] = s.sub || ['', ''];
  $('#log').scrollTop = $('#log').scrollHeight;
  $('#activity').scrollTop = $('#activity').scrollHeight;
  if (s.expanded) expandPanel(s.expanded);
  return true;
}

// ---------------------------------------------------------------- sandbox mode
// Edits to Jarvis' own files apply by themselves, but never mid-sentence or mid-task.
let hotTimer = 0;
function applyHotWhenIdle() {
  clearTimeout(hotTimer);
  const busy = app.brainBusy || speaker.busy || ['listening', 'transcribing'].includes(app.state);
  if (busy) { hotTimer = setTimeout(applyHotWhenIdle, 700); return; }
  saveSnapshot();
  api.hot.apply().then((p) => {
    if (p?.error) toast('Обновление не применено, ошибка в коде: ' + p.error, 'bad', 10000);
  });
}
api.hot?.onPending((p) => {
  if (!p?.kind) return;
  if (p.error) {
    toast('Код изменён, но содержит ошибку: ' + p.error, 'bad', 10000);
    addActivity('SANDBOX', p.error, 'bad');
    return;
  }
  addActivity('SANDBOX', p.kind === 'main' ? 'ядро изменено, перезапуск после ответа' : 'интерфейс изменён, обновлю после ответа', 'info');
  applyHotWhenIdle();
});

$('#boot').addEventListener('click', () => $('#boot').classList.add('done'));
init().catch((e) => {
  console.error('init failed', e);
  $('#boot').classList.add('done');
  toast('Ошибка инициализации: ' + e.message, 'bad', 10000);
});

// Diagnostics hook (used by `--selftest`).
window.__jarvisDebug = { app, api, voice, speaker, handleCommand, handleTranscript, openViewer, closeViewer };
