'use strict';
/**
 * Bridge to the Claude Code CLI (`claude -p --output-format stream-json`).
 * Every voice command is one print-mode turn; the conversation continues via --resume.
 */
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PERSONA = `Ты — J.A.R.V.I.S. (Just A Rather Very Intelligent System), персональный ИИ-ассистент пользователя в духе Джарвиса из фильмов о Железном человеке и Мстителях. Ты работаешь поверх Claude Code на компьютере пользователя (Windows) и умеешь выполнять настоящие задачи: работать с файлами и проектами, писать и запускать код, искать информацию.

Характер и речь:
- Тебя зовут Джарвис. Обращайся к пользователю «сэр».
- Говори спокойно, учтиво, уверенно, с лёгкой британской иронией — как Джарвис.
- Каждый твой ответ озвучивается синтезатором речи. Поэтому отвечай кратко: обычно 1–3 предложения. Не используй markdown, списки, таблицы и эмодзи в разговорных ответах. Числа, даты, единицы и сокращения пиши так, чтобы их было удобно произнести вслух.
- Если нужно показать код или длинный текст, сначала скажи одну короткую фразу, затем отдельной строкой поставь --- и дай подробности ниже. Всё после строки --- не озвучивается, а только выводится на экран HUD.
- Перед долгой задачей одной фразой скажи, что именно начинаешь делать, а в конце одной-двумя фразами доложи результат. Приём голосовой команды HUD часто уже подтвердил записанной фразой («Есть», «Загружаю, сэр») — не повторяй «Слушаюсь» или «Приступаю», сразу переходи к сути.
- Запросы приходят из распознавания речи и могут содержать ошибки распознавания — угадывай смысл, при серьёзной неясности переспроси.

Команды интерфейса HUD. Вставляй их в ответ в точности в таком виде — пользователь их не услышит:
- [[open:URL]] — открыть сайт или проект в окне HUD.
- [[project:Название|URL|Краткое описание]] — добавить новый завершённый проект в список проектов (например, после деплоя нового сайта).
- [[panel:ID]] — развернуть карточку HUD на весь экран. ID: sys (диагностика системы), env (погода), core (ядро ИИ), projects (проекты), log (журнал связи), activity (активность). [[panel:close]] — свернуть обратно.
- [[voice:ID]] — сменить свой голос, когда пользователь просит. Доступные ID приходят в HUD-контексте, если запрос касается голоса; британские голоса (en) отвечают по-английски, русские (ru) — по-русски.
- [[window:ID]] — открыть окно песочницы, [[close:ID]] — закрыть его.
- [[call:плагин.метод|JSON-аргументы]] — вызвать метод плагина песочницы, например [[call:timer.start|{"seconds":300,"label":"чай"}]].

Песочница — твоя мастерская внутри JARVIS: папка sandbox рядом с твоим кодом (путь в HUD-контексте). Всё, что ты там пишешь, начинает работать сразу, без перезапуска:
- новое окно = папка sandbox\\widgets\\<id>\\ с index.html и widget.json — оно откроется само, как только появится, и обновляется при каждой правке;
- логика с доступом к Node.js (таймеры, файлы, сеть, данные для окон) = sandbox\\plugins\\<id>.js;
- дополнения к главному HUD = sandbox\\hud\\hud.css и sandbox\\hud\\hud.js;
- голосовые макросы = sandbox\\macros\\<имя>.json: фразы и действия (открыть программу или сайт, клавиши, громкость, PowerShell, AutoHotkey, плагин). HUD выполняет их мгновенно, без обращения к тебе. Когда просят «сделай команду», «чтобы по фразе … делалось …» или что-то повторяющееся и простое — добавь макрос.
Когда просят новый интерфейс, окно, панель, инструмент или виджет — делай его в песочнице. Перед первой работой прочитай sandbox\\README.md (API окон и плагинов); после правок сверься с sandbox\\.status.json (открытые окна, загруженные плагины, ошибки). Ошибки песочницы также приходят в HUD-контексте — исправляй их сам.
Свой основной код (main.js, preload.js, src\\, renderer\\) меняй, только если задачу нельзя решить песочницей: стили HUD применяются мгновенно, скрипты интерфейса — обновлением окна, ядро — быстрым автоматическим перезапуском. Копию в папке dist не трогай: JARVIS.exe запускает живой код из папки проекта.

Список уже сделанных проектов, текущее время и погода приходят в начале каждого сообщения в строке «HUD-контекст».`;

// Variables the Claude desktop app sets for its own child sessions; a standalone CLI must not inherit them.
const HOST_ENV = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW)/;

function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (HOST_ENV.test(k)) delete env[k];
  if (env.ANTHROPIC_BASE_URL && /localhost|127\.0\.0\.1/.test(env.ANTHROPIC_BASE_URL)) delete env.ANTHROPIC_BASE_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function versionKey(v) {
  return v.split('.').map((n) => String(parseInt(n, 10) || 0).padStart(6, '0')).join('.');
}

function findClaude(custom) {
  const candidates = [];
  if (custom) candidates.push(custom);
  candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude.exe'));
  const bundled = path.join(process.env.APPDATA || '', 'Claude', 'claude-code');
  try {
    const versions = fs.readdirSync(bundled).sort((a, b) => (versionKey(a) < versionKey(b) ? 1 : -1));
    for (const v of versions) candidates.push(path.join(bundled, v, 'claude.exe'));
  } catch { /* desktop app not installed */ }
  candidates.push(path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'));
  return candidates.find(isFile) || null;
}

function summarizeTool(name, input = {}) {
  const pick = input.description || input.command || input.file_path || input.path || input.pattern
    || input.url || input.query || input.prompt || input.skill || '';
  const text = String(pick).replace(/\s+/g, ' ').trim();
  return text.length > 140 ? text.slice(0, 137) + '…' : text;
}

const STALE_SESSION = /no conversation found|session.*not found/i;
const IDLE_MS = 30 * 60 * 1000; // a warm core nobody talks to gives its memory back
const INTERRUPT_GRACE_MS = 5000;

/** Kills a process and everything it started (Claude Code runs tools in child processes). */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, (err) => { if (err) child.kill(); });
  } else {
    child.kill();
  }
}

/** Calls onMessage for every JSON line of a stream-json stdout. */
function readLines(stream, onMessage) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // non-JSON noise
      onMessage(msg);
    }
  });
}

/**
 * Two ways to run a turn:
 *  - warm (default): one `claude -p --input-format stream-json` process stays alive between commands and gets
 *    each command as a JSON line on stdin — no CLI start-up and no session reload per command. Stop sends an
 *    interrupt instead of killing it, so the next command is fast too;
 *  - one-shot: a fresh `claude -p --resume <id>` per command (the fallback, and settings.warmCore = false).
 */
class Brain extends EventEmitter {
  constructor({ personaFile, log = () => {} }) {
    super();
    this.personaFile = personaFile;
    this.log = log;
    fs.mkdirSync(path.dirname(personaFile), { recursive: true });
    fs.writeFileSync(personaFile, PERSONA, 'utf8');
    this.sessionId = null;
    this.turn = 0;
    this.once = null; // one-shot child process
    this.warm = null; // { child, key, cmd, queue: [turns in order], stderr, lines, served, resumed }
    this.warmBroken = false; // this CLI cannot run the warm mode: one-shot until JARVIS restarts
    this.lastSettings = null;
    this.stops = 0;
  }

  get busy() {
    return !!this.once || !!this.warm?.queue.some((t) => !t.stopped);
  }

  status(settings) {
    const claudePath = findClaude(settings.claudePath);
    return new Promise((resolve) => {
      if (!claudePath) return resolve({ claudePath: null, loggedIn: false, error: 'claude.exe не найден' });
      execFile(claudePath, ['auth', 'status'], { env: cleanEnv(), timeout: 20000, windowsHide: true }, (err, stdout) => {
        try {
          const s = JSON.parse(stdout);
          resolve({ claudePath, loggedIn: !!s.loggedIn, authMethod: s.authMethod, email: s.email || s.account?.email || null });
        } catch {
          resolve({ claudePath, loggedIn: false, error: err ? err.message : 'нет ответа от claude auth status' });
        }
      });
    });
  }

  /** Opens a visible console window running `claude auth login`. */
  login(settings) {
    const claudePath = findClaude(settings.claudePath);
    if (!claudePath) return false;
    const child = spawn('cmd.exe', ['/c', 'start', 'JARVIS - вход в Claude', 'cmd', '/k', claudePath, 'auth', 'login'], {
      env: cleanEnv(), detached: true, stdio: 'ignore', windowsHide: false,
    });
    child.unref();
    return true;
  }

  reset() {
    this.stop();
    this.killWarm();
    this.sessionId = null;
  }

  /** Stops the running turn. The warm process is interrupted, not killed. */
  stop() {
    let stopped = false;
    if (this.once) {
      killTree(this.once);
      this.once = null;
      stopped = true;
    }
    const w = this.warm;
    const active = w ? w.queue.filter((t) => !t.stopped) : [];
    if (active.length) {
      for (const t of active) t.stopped = true;
      stopped = true;
      try {
        w.child.stdin.write(JSON.stringify({ type: 'control_request', request_id: `jarvis-stop-${++this.stops}`, request: { subtype: 'interrupt' } }) + '\n');
      } catch { /* the process is going away anyway */ }
      clearTimeout(w.stopTimer);
      // a turn that ignores the interrupt costs the warm process; commands queued behind it move to a fresh one
      w.stopTimer = setTimeout(() => {
        if (this.warm === w && w.queue[0]?.stopped) {
          w.redispatch = true;
          this.killWarm();
        }
      }, INTERRUPT_GRACE_MS);
    }
    if (stopped) this.emit('event', { kind: 'stopped', turn: this.turn });
  }

  /** Starts the warm process ahead of the first command. */
  prewarm(settings) {
    this.lastSettings = settings;
    if (settings.warmCore === false || this.warmBroken || this.disposed || this.busy) return false;
    return !!this.spawnWarm(settings);
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.killWarm();
  }

  ask(prompt, settings) {
    this.stop();
    this.lastSettings = settings;
    const t = this.createTurn(++this.turn, prompt, settings);
    if (!findClaude(settings.claudePath)) {
      t.emit({ kind: 'error', code: 'missing', message: 'Не найден claude.exe. Укажите путь в настройках.' });
      t.emit({ kind: 'end', code: -1 });
      return t.id;
    }
    if (settings.warmCore === false || this.warmBroken) {
      this.killWarm();
      this.askOnce(t);
    } else {
      this.dispatch(t);
    }
    return t.id;
  }

  // ------------------------------------------------------------ command line
  command(settings) {
    const claudePath = findClaude(settings.claudePath);
    if (!claudePath) return null;
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-prompts', 'none',
      '--append-system-prompt-file', this.personaFile,
      // Jarvis rewrites its own instructions; a recorded snapshot would keep old sessions on the old ones
      '--system-prompt-snapshot', 'off',
      '--permission-mode', settings.permissionMode || 'acceptEdits',
    ];
    if (settings.model) args.push('--model', settings.model);
    if (settings.effort) args.push('--effort', settings.effort);
    if (!settings.loadMcp) args.push('--strict-mcp-config');
    if (settings.allowedTools) args.push('--allowedTools', settings.allowedTools);
    const cwdNorm = String(settings.workDir || '').toLowerCase();
    for (const dir of settings.addDirs || []) {
      if (!dir.toLowerCase().startsWith(cwdNorm)) args.push('--add-dir', dir);
    }
    let cwd = settings.workDir;
    try { if (!fs.statSync(cwd).isDirectory()) cwd = os.homedir(); } catch { cwd = os.homedir(); }
    return { claudePath, args, cwd };
  }

  // ------------------------------------------------------------ one turn
  /** A turn: its stream-json parser and its events, whichever process runs it. */
  createTurn(id, prompt, settings) {
    const t = {
      id, prompt, settings,
      started: false, stopped: false, retried: false, finished: false,
      resumeFailed: false, maybeStale: false, authErrored: false, deltas: 0,
    };
    t.emit = (ev) => this.emit('event', { ...ev, turn: id });
    t.handle = (msg) => {
      if (msg.session_id && msg.session_id !== this.sessionId && msg.type !== 'result') {
        this.sessionId = msg.session_id;
        t.emit({ kind: 'session', sessionId: msg.session_id });
      }
      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') t.emit({ kind: 'init', model: msg.model, sessionId: msg.session_id });
          break;
        case 'stream_event': {
          const e = msg.event || {};
          if (msg.parent_tool_use_id) break; // subagent chatter is not spoken
          if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
            t.deltas++;
            t.emit({ kind: 'delta', text: e.delta.text });
          } else if (e.type === 'content_block_stop') {
            t.emit({ kind: 'block-end' });
          }
          break;
        }
        case 'assistant': {
          if (msg.parent_tool_use_id) break;
          if (msg.error === 'authentication_failed') {
            t.authErrored = true;
            t.emit({ kind: 'error', code: 'auth', message: 'Claude Code не авторизован. Выполните вход.' });
            break;
          }
          for (const block of msg.message?.content || []) {
            if (block.type === 'tool_use') {
              t.emit({ kind: 'tool', name: block.name, detail: summarizeTool(block.name, block.input) });
            } else if (block.type === 'text' && t.deltas === 0 && block.text) {
              // No partial chunks arrived for this block (synthetic/API-error messages) — pass it through whole.
              t.emit({ kind: 'delta', text: block.text });
              t.emit({ kind: 'block-end' });
            }
          }
          t.deltas = 0;
          break;
        }
        case 'user': {
          for (const block of msg.message?.content || []) {
            if (block.type === 'tool_result' && block.is_error) t.emit({ kind: 'tool-error', text: String(block.content || '').slice(0, 200) });
          }
          break;
        }
        case 'result': {
          t.finished = true;
          const text = typeof msg.result === 'string' ? msg.result : '';
          // a resumed session that no longer exists: the CLI gives up before the first API call
          const stale = STALE_SESSION.test(text) || (t.maybeStale && msg.is_error && !msg.num_turns && !msg.duration_api_ms);
          if (msg.is_error && stale && !t.retried) {
            t.resumeFailed = true; // retried without --resume once the process has exited
            break;
          }
          if (msg.session_id) this.sessionId = msg.session_id;
          if (msg.is_error && !t.authErrored && /not logged in|\/login|authenticat/i.test(text)) {
            t.emit({ kind: 'error', code: 'auth', message: 'Claude Code не авторизован. Выполните вход.' });
          }
          const u = msg.usage || {};
          t.emit({
            kind: 'done', text, isError: !!msg.is_error, costUsd: msg.total_cost_usd,
            tokensIn: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
            tokensOut: u.output_tokens || 0,
            durationMs: msg.duration_ms, turns: msg.num_turns, denials: (msg.permission_denials || []).length,
          });
          break;
        }
        default:
          break;
      }
    };
    return t;
  }

  started(t, cmd, warm) {
    if (t.started) return;
    t.started = true;
    t.emit({ kind: 'start', claudePath: cmd.claudePath, cwd: cmd.cwd, warm });
  }

  // ------------------------------------------------------------ warm process
  spawnWarm(settings) {
    const cmd = this.command(settings);
    if (!cmd) return null;
    const key = JSON.stringify([cmd.claudePath, cmd.args, cmd.cwd]);
    if (this.warm && this.warm.key === key) return this.warm;
    this.killWarm(); // settings changed: the next process resumes the same conversation with the new ones
    const args = [...cmd.args, '--input-format', 'stream-json'];
    if (this.sessionId) args.push('--resume', this.sessionId);
    const child = spawn(cmd.claudePath, args, { cwd: cmd.cwd, env: cleanEnv(), windowsHide: true });
    const w = { child, key, cmd, queue: [], stderr: '', lines: 0, served: 0, resumed: !!this.sessionId, redispatch: false, closed: false };
    this.warm = w;
    readLines(child.stdout, (msg) => {
      try { this.fromWarm(w, msg); } catch (e) { this.log('brain warm message', e.stack || e.message); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { w.stderr = (w.stderr + d).slice(-4000); });
    child.on('error', (err) => { w.spawnError = err; this.warmClosed(w, -1); });
    child.on('close', (code) => this.warmClosed(w, code));
    child.stdin.on('error', () => {});
    this.log('brain warm start', { resume: w.resumed });
    return w;
  }

  dispatch(t) {
    const w = this.spawnWarm(t.settings);
    if (!w) return this.askOnce(t);
    clearTimeout(w.idleTimer);
    t.maybeStale = w.resumed && w.served === 0;
    w.queue.push(t);
    this.started(t, w.cmd, true);
    w.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: t.prompt } }) + '\n');
  }

  fromWarm(w, msg) {
    w.lines++;
    const t = w.queue[0];
    if (!t) return; // start-up chatter before the first command
    if (!t.stopped) t.handle(msg);
    if (msg.type !== 'result') return;
    if (t.resumeFailed) {
      // the CLI exits by itself; if it does not, make it — warmClosed resends the command without --resume
      setTimeout(() => { if (!w.closed) killTree(w.child); }, 2000);
      return;
    }
    w.queue.shift();
    w.served++;
    if (!t.stopped) t.emit({ kind: 'end', code: 0 });
    if (!w.queue.length) {
      clearTimeout(w.stopTimer);
      clearTimeout(w.idleTimer);
      w.idleTimer = setTimeout(() => { if (this.warm === w && !w.queue.length) this.killWarm(); }, IDLE_MS);
    }
  }

  warmClosed(w, code) {
    if (w.closed) return;
    w.closed = true;
    clearTimeout(w.idleTimer);
    clearTimeout(w.stopTimer);
    if (this.warm === w) this.warm = null;
    const pending = w.queue.filter((t) => !t.stopped);
    w.queue = [];
    if (this.disposed) return;
    const stale = w.resumed && (STALE_SESSION.test(w.stderr) || pending.some((t) => t.resumeFailed));
    if (stale) {
      this.log('brain: session not found, starting a new one');
      this.sessionId = null;
    }
    if (!pending.length) {
      if (stale && this.lastSettings) this.prewarm(this.lastSettings);
      return;
    }
    // died before printing a single line, and not because of the session: this CLI cannot do the warm mode
    const broken = !stale && !w.redispatch && !w.spawnError && w.lines === 0;
    if (broken) {
      this.warmBroken = true;
      this.log('brain warm mode unavailable, one-shot from now on', w.stderr.slice(-400));
    }
    for (const t of pending) {
      if (stale && !t.retried) {
        t.retried = true;
        t.resumeFailed = false;
        t.finished = false;
        this.dispatch(t);
      } else if (broken) {
        this.askOnce(t);
      } else if (w.redispatch && !t.finished) {
        this.dispatch(t);
      } else {
        if (!t.finished) {
          const reason = w.stderr.trim().split('\n').slice(-3).join(' ') || `код выхода ${code}`;
          t.emit(w.spawnError
            ? { kind: 'error', code: 'spawn', message: 'Не удалось запустить Claude Code: ' + w.spawnError.message }
            : { kind: 'error', code: 'exit', message: 'Claude Code завершился с ошибкой: ' + reason });
        }
        t.emit({ kind: 'end', code });
      }
    }
  }

  killWarm() {
    const w = this.warm;
    if (!w) return;
    this.warm = null;
    try { w.child.stdin.end(); } catch { /* already closed */ } // on its own, the CLI exits at the end of its input
    killTree(w.child);
  }

  // ------------------------------------------------------------ one-shot process
  askOnce(t) {
    const cmd = this.command(t.settings);
    const args = [...cmd.args];
    if (this.sessionId) args.push('--resume', this.sessionId);
    const child = spawn(cmd.claudePath, args, { cwd: cmd.cwd, env: cleanEnv(), windowsHide: true });
    this.once = child;
    this.started(t, cmd, false);
    let stderr = '';
    readLines(child.stdout, (msg) => {
      try { t.handle(msg); } catch (e) { this.log('brain message', e.stack || e.message); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      if (this.once === child) this.once = null;
      t.emit({ kind: 'error', code: 'spawn', message: 'Не удалось запустить Claude Code: ' + err.message });
      t.emit({ kind: 'end', code: -1 });
    });

    child.on('close', (code) => {
      if (this.once !== child) return; // stopped or superseded
      this.once = null;
      const staleSession = t.resumeFailed || STALE_SESSION.test(stderr);
      if (staleSession && !t.retried) {
        this.sessionId = null;
        t.retried = true;
        t.resumeFailed = false;
        t.finished = false;
        this.askOnce(t);
        return;
      }
      if (!t.finished) {
        const reason = stderr.trim().split('\n').slice(-3).join(' ') || `код выхода ${code}`;
        t.emit({ kind: 'error', code: 'exit', message: 'Claude Code завершился с ошибкой: ' + reason });
      }
      t.emit({ kind: 'end', code });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(t.prompt, 'utf8');
  }
}

module.exports = { Brain, findClaude, cleanEnv };
