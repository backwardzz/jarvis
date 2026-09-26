'use strict';
const { app, BrowserWindow, ipcMain, protocol, net, shell, globalShortcut, session, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

// JARVIS.exe carries a copy of the code in resources\app. When the project folder with the live sources
// sits around it (…\jarvis\dist\win-unpacked), run those instead: Jarvis edits itself there, and a stale
// second copy would silently ignore every such edit. `--bundled` forces the packaged copy.
const liveRoot = (() => {
  if (!app.isPackaged || process.argv.includes('--bundled')) return null;
  if (!__dirname.split(path.sep).includes('resources')) return null;
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    dir = path.dirname(dir);
    const looksLive = ['main.js', path.join('renderer', 'index.html'), path.join('node_modules', 'electron')].every((f) => fs.existsSync(path.join(dir, f)));
    if (looksLive) return dir;
  }
  return null;
})();
if (liveRoot) {
  require(path.join(liveRoot, 'main.js'));
  return; // a top-level return is legal in CommonJS: the live main.js has taken over
}

const { JsonStore } = require('./src/store');
const { Brain } = require('./src/brain');
const tts = require('./src/tts');
const { VoicePacks } = require('./src/voicepacks');
const { SpeechRecognizer } = require('./src/stt');
const system = require('./src/system');
const { Projects } = require('./src/projects');
const { HotReload } = require('./src/hotreload');
const { Sandbox, PARTITION: SANDBOX_PARTITION } = require('./src/sandbox');
const { PhrasePacks } = require('./src/phrases');
const { Macros } = require('./src/macros');
const { WinHost } = require('./src/winhost');

const RENDERER_DIR = path.join(__dirname, 'renderer');
const ASSETS_DIR = path.join(__dirname, 'assets');
const SANDBOX_DIR = path.join(__dirname, 'sandbox');
// --profile=<dir> runs a separate instance with its own settings and lock (diagnostics next to a running JARVIS)
const profileArg = process.argv.find((a) => a.startsWith('--profile='));
if (profileArg) app.setPath('userData', path.resolve(profileArg.slice('--profile='.length)));
const USER = app.getPath('userData');
const HOTKEY = 'CommandOrControl+Shift+Space';
app.setAppUserModelId('local.danny.jarvis');

const argv = process.argv.slice(1);
const flag = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};

// A second launch only hands focus to the running window, so it must not touch the shared log.
const primaryInstance = app.requestSingleInstanceLock();

// ---------- logging ----------
fs.mkdirSync(path.join(USER, 'logs'), { recursive: true });
const LOG_FILE = path.join(USER, 'logs', 'jarvis.log');
if (primaryInstance) {
  try { fs.writeFileSync(LOG_FILE, `--- J.A.R.V.I.S. ${new Date().toISOString()} ---\n`); } catch { /* read-only */ }
}
function log(...parts) {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
  if (process.env.JARVIS_DEBUG) process.stdout.write(line);
}
if (primaryInstance) log('start', { code: __dirname, packaged: app.isPackaged, exe: process.execPath });
process.on('unhandledRejection', (e) => log('unhandledRejection', String(e?.stack || e)));
process.on('uncaughtException', (e) => log('uncaughtException', String(e?.stack || e)));

// ---------- state ----------
const DEFAULTS = {
  voice: 'ru-RU-DmitryNeural',
  pitch: -6,
  rate: 4,
  voiceFx: true,
  volume: 0.9,
  phrasePack: 'jarvis-og', // pre-recorded JARVIS phrases, '' = off (src/phrases.js)
  phraseAck: true, // confirm a voice command with a phrase while Claude is thinking
  xttsUrl: 'http://127.0.0.1:8020',
  xttsSpeaker: '', // speaker sample for the clone voice; '' = stitched from the film phrases
  sttModel: 'groq',
  sttGroqKey: '',
  sttOpenaiKey: '',
  sttLanguage: 'russian',
  wakeWord: false,
  followUp: false,
  greeting: true,
  sounds: true,
  claudePath: '',
  workDir: fs.existsSync('D:\\') ? 'D:\\' : os.homedir(),
  model: '',
  effort: '',
  permissionMode: 'acceptEdits',
  warmCore: true, // keep Claude Code running between commands (src/brain.js)
  macros: true, // instant voice macros from sandbox/macros (src/macros.js)
  loadMcp: false,
  allowedTools: 'WebSearch,WebFetch',
  city: { name: 'Астана', in: 'Астане', lat: 51.1694, lon: 71.4491 },
  sessionId: null,
  windowState: null,
};
const settings = new JsonStore(path.join(USER, 'settings.json'), DEFAULTS);
const projects = new Projects(path.join(USER, 'projects.json'), path.join(USER, 'thumbs'), path.join(ASSETS_DIR, 'thumbs'));
const brain = new Brain({ personaFile: path.join(USER, 'persona.md'), log: (...a) => log(...a) });
brain.sessionId = flag('claude') ? null : settings.data.sessionId || null;
const stt = new SpeechRecognizer(path.join(USER, 'models'), (k) => settings.data[k]);
const packs = new VoicePacks(path.join(USER, 'voices'));
const phrases = new PhrasePacks(path.join(USER, 'phrases'));
const hot = new HotReload(__dirname);
let hotBoot = !!flag('hot'); // this start was a sandbox reload, not a cold start
const sandbox = new Sandbox({
  root: SANDBOX_DIR,
  dataDir: path.join(USER, 'sandbox'),
  preload: path.join(__dirname, 'widget-preload.js'),
  hostScript: path.join(__dirname, 'src', 'plugin-host.js'),
  icon: path.join(ASSETS_DIR, 'icon.ico'),
  log: (...a) => log(...a),
});
const winhost = new WinHost({ log: (...a) => log(...a) });
const macros = new Macros({
  dir: path.join(SANDBOX_DIR, 'macros'),
  host: winhost,
  sandbox,
  shell,
  clipboard,
  dataDir: path.join(USER, 'sandbox'),
  log: (...a) => log(...a),
});
sandbox.statusExtra = () => ({ macros: macros.summary() });

let win = null;
const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

sandbox.on('widgets', (list) => send('sandbox:widgets', list));
sandbox.on('created', (m) => send('sandbox:created', m));
sandbox.on('updated', (m) => send('sandbox:updated', m));
sandbox.on('plugin', (p) => send('sandbox:plugin', p));
sandbox.on('hud', (h) => send('sandbox:hud', h));
sandbox.on('action', (a) => send('sandbox:action', a));
sandbox.on('error', (e) => send('sandbox:error', e));
sandbox.on('event', (e) => send('sandbox:event', e));
sandbox.on('macros', () => macros.load());
macros.on('problem', (e) => sandbox.error(e.source, e.message));
macros.on('loaded', (m) => { log('macros', { count: m.count, files: m.files }); send('macros:loaded', m); });

function saveWindowState() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  settings.set({ windowState: { ...win.getNormalBounds(), maximized: win.isMaximized() } });
}

// --claude=<path> swaps the CLI (used with a test double); such sessions are not remembered
const brainSettings = () => ({
  ...settings.data,
  ...(flag('claude') ? { claudePath: String(flag('claude')) } : {}),
  addDirs: [__dirname, SANDBOX_DIR], // Jarvis may edit itself and its sandbox whatever the working folder is
});

brain.on('event', (ev) => {
  if (ev.kind === 'session' && !flag('claude') && ev.sessionId !== settings.data.sessionId) settings.set({ sessionId: ev.sessionId });
  if (ev.kind !== 'delta') log('brain', ev);
  send('brain:event', ev);
});
stt.on('status', (s) => { if (s.state !== 'loading') log('stt', s); send('stt:status', s); });
packs.on('status', (s) => { if (s.state !== 'downloading') log('voice pack', s); send('tts:status', s); });
phrases.on('status', (s) => { if (s.state !== 'downloading') log('phrases', s); send('phrases:status', s); });

// ---------- helpers ----------
function voiceLang() {
  return tts.findVoice(voiceId()).lang;
}

// --voice=<id> tries a voice without touching the saved settings (diagnostics)
const voiceId = () => (flag('voice') ? String(flag('voice')) : settings.data.voice);
const publicSettings = () => ({
  ...settings.data, voice: voiceId(), voices: tts.catalog(packs), phrasePacks: phrases.catalog(), hotkey: HOTKEY, version: app.getVersion(),
});

async function hudContext(fromVoice, text) {
  const now = new Date();
  const when = now.toLocaleString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  let wx = '';
  try {
    const w = await Promise.race([system.weather(settings.data.city), new Promise((_, r) => setTimeout(() => r(new Error('slow')), 1500))]);
    wx = ` | ${w.city}: ${Math.round(w.temp)}°C, ${w.text}, ветер ${Math.round(w.wind)} м/с`;
  } catch { /* weather is optional */ }
  const list = projects.list().map((p) => `${p.name} (${p.url || 'без URL'}${p.localPath ? ', папка ' + p.localPath : ''})`).join('; ') || 'пока нет';
  const lang = voiceLang() === 'en' ? 'английский' : 'русский';
  // the voice catalogue is long, so it rides along only when the request is about the voice
  const voices = /голос|voice|говори|звуч|тембр|акцент|произнош/i.test(text || '') ? ` | Голоса для [[voice:ID]]: ${tts.voiceList()}` : '';
  const sb = sandbox.summary();
  const sandboxLine = ` | Песочница ${SANDBOX_DIR} (правила: sandbox\\README.md): окна ${sb.widgets.join(', ') || 'нет'}`
    + `${sb.open.length ? ` (открыты: ${sb.open.join(', ')})` : ''}, плагины ${sb.plugins.join(', ') || 'нет'}`;
  const mc = macros.summary();
  // the macro ids ride along only when the request is about commands or macros
  const macroIds = /макрос|команд|фраз/i.test(text || '') ? `: ${macros.list.map((m) => m.id).join(', ')}` : '';
  const macroLine = ` | Макросы (sandbox\\macros, выполняются без тебя): ${mc.count}${macroIds}`;
  const fresh = sandbox.takeNewErrors();
  const errors = fresh.length ? ` | Ошибки песочницы с прошлого запроса: ${fresh.map((e) => `[${e.source}] ${e.message}`).join('; ').slice(0, 1500)}` : '';
  return `[HUD-контекст | ${when}${wx} | Язык ответа: ${lang} | Голос: ${tts.findVoice(voiceId()).label}${voices} | Проекты: ${list}${sandboxLine}${macroLine}${errors}]\n`
    + (fromVoice ? 'Голосовая команда (распознана автоматически, возможны ошибки): ' : 'Текстовая команда: ');
}

async function captureThumb(project) {
  if (!project?.url) return false;
  const shot = new BrowserWindow({
    show: false, width: 1440, height: 900, paintWhenInitiallyHidden: true,
    webPreferences: { partition: 'thumbs', offscreen: false, sandbox: true },
  });
  shot.webContents.setAudioMuted(true);
  try {
    await Promise.race([shot.loadURL(project.url), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 20000))]);
    const title = shot.webContents.getTitle();
    if (/login redirect|log in|sign in/i.test(title) || /netlify\.com\/edge-access/.test(shot.webContents.getURL())) return false;
    await new Promise((r) => setTimeout(r, 2500));
    const img = await shot.webContents.capturePage();
    fs.writeFileSync(path.join(USER, 'thumbs', project.id + '.jpg'), img.resize({ width: 720 }).toJPEG(82));
    return true;
  } catch (e) {
    log('thumb failed', project.url, e.message);
    return false;
  } finally {
    shot.destroy();
  }
}

// ---------- protocol ----------
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function serveFile(base, rel) {
  const file = path.normalize(path.join(base, rel));
  if (file !== base && !file.startsWith(base.endsWith(path.sep) ? base : base + path.sep)) return new Response('forbidden', { status: 403 });
  let isFile = false;
  try { isFile = fs.statSync(file).isFile(); } catch { /* missing */ }
  if (!isFile) return new Response('not found', { status: 404 });
  return net.fetch(pathToFileURL(file).toString());
}

function serveLocalProject(u) {
  // app://local/<project-id>/<path> — the project's own folder, for the offline preview
  const [, id, ...rest] = decodeURIComponent(u.pathname).split('/');
  const p = projects.get(id);
  if (!p?.localPath) return new Response('', { status: 404 });
  return serveFile(path.normalize(p.localPath), rest.join('/') || 'index.html');
}

// app://jarvis/sandbox/… is the sandbox folder, served on the HUD's own origin so hud.js/hud.css load as 'self'
function serveSandbox(u) {
  const rel = decodeURIComponent(u.pathname).slice('/sandbox/'.length);
  if (rel.split('/').some((p) => p.startsWith('.'))) return new Response('', { status: 404 });
  return serveFile(SANDBOX_DIR, rel);
}

function registerProtocol() {
  // project previews run in their own session and may only see project folders
  session.fromPartition('persist:projects').protocol.handle('app', (req) => {
    const u = new URL(req.url);
    return u.host === 'local' ? serveLocalProject(u) : new Response('', { status: 404 });
  });
  // sandbox widgets see the sandbox folder and the HUD fonts, nothing else of the app
  session.fromPartition(SANDBOX_PARTITION).protocol.handle('app', (req) => {
    const u = new URL(req.url);
    if (u.host !== 'jarvis') return new Response('', { status: 404 });
    if (u.pathname.startsWith('/sandbox/')) return serveSandbox(u);
    if (u.pathname.startsWith('/fonts/')) return serveFile(RENDERER_DIR, decodeURIComponent(u.pathname));
    return new Response('', { status: 404 });
  });
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    if (u.host === 'thumbs') {
      const file = projects.thumbFile(decodeURIComponent(u.pathname.slice(1)));
      return file ? net.fetch(pathToFileURL(file).toString()) : new Response('', { status: 404 });
    }
    if (u.host === 'local') return serveLocalProject(u);
    if (u.pathname.startsWith('/sandbox/')) return serveSandbox(u);
    return serveFile(RENDERER_DIR, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
  });
}

// ---------- window ----------
function createWindow() {
  const ws = settings.data.windowState || {};
  win = new BrowserWindow({
    width: ws.width || 1500,
    height: ws.height || 930,
    x: ws.x,
    y: ws.y,
    minWidth: 1180,
    minHeight: 720,
    frame: false,
    backgroundColor: '#02070d',
    show: false,
    title: 'J.A.R.V.I.S.',
    icon: path.join(ASSETS_DIR, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  win.once('ready-to-show', () => {
    if (ws.maximized) win.maximize();
    if (!flag('hidden')) { win.show(); win.focus(); }
  });
  win.on('maximize', () => send('win:state', { maximized: true }));
  win.on('unmaximize', () => send('win:state', { maximized: false }));
  win.on('close', saveWindowState);
  // the HUD is the app: closing it closes the sandbox windows too
  win.on('closed', () => { win = null; app.quit(); });

  win.webContents.on('console-message', (e) => {
    const { level, message, lineNumber, sourceId } = e;
    log(`renderer[${level}]`, message, sourceId ? `(${path.basename(sourceId)}:${lineNumber})` : '');
  });
  win.webContents.on('render-process-gone', (_e, d) => log('renderer gone', d));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-attach-webview', (_e, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    params.partition = 'persist:projects';
  });

  win.loadURL('app://jarvis/index.html');

  const selftest = flag('selftest') || flag('selftest-text');
  if (selftest) {
    // End-to-end checks without a microphone.
    //   --selftest[=phrase]     neural TTS -> 16 kHz -> Whisper -> command handling
    //   --selftest-text=phrase  typed command -> Claude Code bridge -> speech queue
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const voice = !!flag('selftest');
      const phrase = String(selftest === true ? 'Джарвис, открой проект юзтайм' : selftest);
      try {
        const r = await win.webContents.executeJavaScript(`(async () => {
          const d = window.__jarvisDebug;
          const wait = (ms) => new Promise((res) => setTimeout(res, ms));
          const out = {};
          if (${voice}) {
            const bytes = await d.api.tts.synth(${JSON.stringify(phrase)});
            const buf = await d.voice.decode(bytes);
            const off = new OfflineAudioContext(1, Math.ceil(buf.duration * 16000), 16000);
            const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
            const audio = (await off.startRendering()).getChannelData(0);
            const t0 = performance.now();
            const r = await d.api.stt.transcribe(audio);
            Object.assign(out, { seconds: +buf.duration.toFixed(2), heard: r.text, sttMs: Math.round(performance.now() - t0) });
            d.handleTranscript(r.text);
          } else {
            d.handleCommand(${JSON.stringify(phrase)}, 'text');
          }
          const subs = new Set();
          for (let i = 0; i < 40; i++) { await wait(300); const s = document.querySelector('#sub-jarvis').textContent; if (s) subs.add(s); }
          const text = (sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent.replace(/\\s+/g, ' ').trim());
          return Object.assign(out, {
            state: d.app.state, spoken: [...subs], log: text('#log .msg').slice(-3), activity: text('#activity .act'),
            core: text('#panel-core dd'), viewerOpen: !document.querySelector('#viewer').classList.contains('hidden'),
            overlays: [...document.querySelectorAll('.overlay')].map((o) => o.id + ':' + (o.classList.contains('hidden') ? 'hidden' : 'open')), errors: window.__errors || [],
            viewerSrc: document.querySelector('#viewer-body webview')?.getAttribute('src') || null,
          });
        })()`);
        log('selftest', r);
      } catch (e) { log('selftest failed', e.message); }
    }, Number(flag('selftest-delay')) || 12000));
  }

  const capture = flag('capture');
  if (capture) {
    const delay = Number(flag('capture-delay')) || 7000;
    setTimeout(async () => {
      try {
        win.webContents.invalidate();
        await new Promise((r) => setTimeout(r, 300));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(String(capture), img.toPNG());
        log('captured', capture);
      } catch (e) { log('capture failed', e.message); }
      if (flag('quit-after-capture')) app.quit();
    }, delay);
  }
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('settings:get', () => publicSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    const allowed = Object.keys(DEFAULTS);
    const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k)));
    settings.set(clean);
    if (clean.voice) tts.prepare(clean.voice, packs).catch((e) => log('voice prepare failed', e.message));
    if (settings.data.warmCore === false) brain.killWarm();
    else setTimeout(() => brain.prewarm(brainSettings()), 300); // restarts the warm core if its flags changed
    return publicSettings();
  });
  ipcMain.handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: settings.data.workDir });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('projects:list', () => projects.list());
  ipcMain.handle('projects:check', () => projects.checkAll());
  ipcMain.handle('projects:add', async (_e, p) => {
    const project = projects.add(p);
    const st = await projects.check(project);
    if (st?.state === 'online' && !projects.thumbFile(project.id)) await captureThumb(project);
    return projects.list();
  });
  ipcMain.handle('projects:remove', (_e, id) => { projects.remove(id); return projects.list(); });
  ipcMain.handle('projects:capture', async (_e, id) => { await captureThumb(projects.get(id)); return projects.list(); });
  ipcMain.handle('projects:openFolder', (_e, id) => {
    const p = projects.get(id);
    return p?.localPath ? shell.openPath(p.localPath) : 'нет локальной папки';
  });

  ipcMain.handle('brain:ask', async (_e, text, opts = {}) => {
    const prompt = (await hudContext(!!opts.voice, text)) + String(text || '');
    return brain.ask(prompt, brainSettings());
  });
  ipcMain.handle('brain:stop', () => brain.stop());
  ipcMain.handle('brain:reset', () => {
    brain.reset();
    settings.set({ sessionId: null });
    setTimeout(() => brain.prewarm(brainSettings()), 300);
  });
  ipcMain.handle('brain:status', async () => ({ ...(await brain.status(brainSettings())), sessionId: brain.sessionId, busy: brain.busy }));
  ipcMain.handle('brain:login', () => brain.login(brainSettings()));

  ipcMain.handle('tts:synth', async (_e, text) => {
    const s = settings.data;
    const buf = await tts.synthesize(text, {
      voice: voiceId(),
      pitch: s.pitch,
      rate: s.rate,
      xtts: { url: s.xttsUrl, speaker: () => s.xttsSpeaker || phrases.reference() },
      onFallback: (e) => { log('xtts fallback', e.message); send('tts:status', { state: 'fallback', message: e.message }); },
    }, packs);
    return buf ? new Uint8Array(buf) : null;
  });
  ipcMain.handle('tts:prepare', async (_e, id) => {
    await tts.prepare(id || voiceId(), packs);
    return tts.catalog(packs);
  });

  // pre-recorded JARVIS phrases: downloaded on first use, then read clip by clip by the renderer
  ipcMain.handle('phrases:load', async (_e, pack) => {
    await phrases.ensure(String(pack));
    return phrases.manifest(String(pack));
  });
  ipcMain.handle('phrases:read', (_e, pack, file) => new Uint8Array(phrases.read(String(pack), String(file))));

  // voice macros: matched and run here, the renderer only speaks the reply and does HUD actions
  ipcMain.handle('macros:run', (_e, text) => (settings.data.macros === false ? null : macros.run(String(text || ''))));
  ipcMain.handle('macros:list', () => macros.summary());

  ipcMain.handle('stt:load', (_e, size) => stt.load(size || settings.data.sttModel));
  ipcMain.handle('stt:transcribe', (_e, audio, size) => {
    const lang = settings.data.sttLanguage === 'auto' ? null : settings.data.sttLanguage;
    return stt.transcribe(audio, { size: size || settings.data.sttModel, language: lang });
  });

  ipcMain.handle('sys:stats', () => system.stats());
  ipcMain.handle('sys:weather', () => system.weather(settings.data.city));
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:\/\//i.test(String(url))) return shell.openExternal(url);
    return false;
  });

  // ---- sandbox, as seen from the HUD
  ipcMain.handle('sandbox:list', () => sandbox.list());
  ipcMain.handle('sandbox:open', (_e, id) => sandbox.open(String(id)));
  ipcMain.handle('sandbox:close', (_e, id) => sandbox.close(String(id)));
  ipcMain.handle('sandbox:call', (_e, plugin, method, args) => sandbox.call(String(plugin), String(method), args));
  ipcMain.handle('sandbox:errors', () => sandbox.errors);

  // ---- sandbox, as seen from a widget window: every call names the widget by its sender
  const widget = (e) => {
    const id = sandbox.widgetOf(e.sender);
    if (!id) throw new Error('not a sandbox window');
    return id;
  };
  ipcMain.on('widget:hello', (e) => {
    const id = sandbox.widgetOf(e.sender);
    const m = id && sandbox.manifest(id);
    e.returnValue = m ? { id, title: m.title, chrome: m.chrome } : null;
  });
  ipcMain.handle('widget:say', (e, text) => { widget(e); send('sandbox:action', { type: 'say', text: String(text).slice(0, 2000) }); return true; });
  ipcMain.handle('widget:notify', (e, text, kind) => { const id = widget(e); send('sandbox:action', { type: 'notify', text: String(text).slice(0, 500), kind, source: `widgets/${id}` }); return true; });
  ipcMain.handle('widget:ask', (e, text) => { const id = widget(e); send('sandbox:action', { type: 'ask', text: String(text).slice(0, 4000), source: `widgets/${id}` }); return true; });
  ipcMain.handle('widget:call', (e, plugin, method, args) => { widget(e); return sandbox.call(String(plugin), String(method), args); });
  ipcMain.handle('widget:store-get', (e, key) => sandbox.storeAll(widget(e))[String(key)] ?? null);
  ipcMain.handle('widget:store-set', (e, key, value) => sandbox.storeSet(widget(e), String(key), value));
  ipcMain.handle('widget:store-all', (e) => sandbox.storeAll(widget(e)));
  ipcMain.handle('widget:win', (e, op, args) => sandbox.winOp(widget(e), String(op), args));
  ipcMain.handle('widget:open', (e, id) => { widget(e); return sandbox.open(String(id)); });
  ipcMain.handle('widget:stats', (e) => { widget(e); return system.stats(); });
  ipcMain.handle('widget:weather', (e) => { widget(e); return system.weather(settings.data.city); });
  ipcMain.handle('widget:projects', (e) => { widget(e); return projects.list(); });

  // sandbox mode: the renderer calls this once Jarvis has finished speaking
  ipcMain.handle('hot:apply', () => {
    const p = hot.take();
    if (p.error || !p.kind) return p;
    log('hot reload', p.kind);
    if (p.kind === 'renderer') {
      hotBoot = true;
      win?.webContents.reload();
    } else {
      // the core itself changed: a quick relaunch into the same window position and the same open widgets
      saveWindowState();
      app.relaunch({ args: [...process.argv.slice(1).filter((a) => a !== '--hot'), '--hot'] });
      app.quit();
    }
    return p;
  });
  ipcMain.handle('hot:boot', () => { const b = hotBoot; hotBoot = false; return b; });

  ipcMain.on('win:minimize', () => win?.minimize());
  ipcMain.on('win:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
  ipcMain.on('win:close', () => win?.close());
}

// ---------- lifecycle ----------
if (!primaryInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    // JARVIS.exe and JARVIS-sandbox.cmd share one instance: a second launch only raises this window
    send('app:notice', { text: 'JARVIS уже запущен — повторный запуск просто поднимает это окно', kind: '' });
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    const allowMedia = (permission) => ['media', 'audioCapture', 'clipboard-sanitized-write'].includes(permission);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));
    session.fromPartition('persist:projects').setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    session.fromPartition(SANDBOX_PARTITION).setPermissionRequestHandler((_wc, p, cb) => cb(p === 'clipboard-sanitized-write'));

    registerProtocol();
    registerIpc();
    createWindow();
    hot.on('pending', (p) => {
      log('hot pending', p);
      // stylesheet edits restyle the HUD in place, right away — nothing to wait for
      if (p.kind === 'css' && !p.error) { hot.take(); send('hot:css', p); return; }
      send('hot:pending', p);
    });
    hot.start();
    sandbox.start();
    macros.picturesDir = app.getPath('pictures');
    macros.load();
    win.webContents.once('did-finish-load', () => {
      sandbox.restore();
      // after the boot animation: the first command then finds Claude Code and the macro host already running
      setTimeout(() => {
        if (flag('selftest-sandbox')) return;
        brain.prewarm(brainSettings());
        if (winhost.supported && settings.data.macros !== false) winhost.start().catch((e) => log('winhost', e.message));
      }, 3500);
      if (flag('selftest-sandbox')) {
        setTimeout(async () => {
          const { run } = require('./src/selftest-sandbox');
          await run({ sandbox, macros, win, root: SANDBOX_DIR, log, capture: flag('capture-dir') ? String(flag('capture-dir')) : null });
          if (flag('quit-after-capture')) app.quit();
        }, Number(flag('selftest-delay')) || 6000);
      }
    });
    // warm up an offline voice model that is already on disk
    const v = tts.findVoice(voiceId());
    if (v.pack && packs.ready(v.pack)) tts.prepare(v.id, packs).catch((e) => log('voice prepare failed', e.message));

    const ok = globalShortcut.register(HOTKEY, () => {
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      send('hotkey', 'listen');
    });
    log('hotkey', HOTKEY, ok ? 'registered' : 'FAILED');
  });

  // before the windows close, so the sandbox remembers which widgets were open
  app.on('before-quit', () => sandbox.stop());
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    hot.stop();
    brain.dispose();
    winhost.stop();
    stt.dispose();
  });
  app.on('window-all-closed', () => app.quit());
}
