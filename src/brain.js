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
- Перед долгой задачей коротко сообщи, что приступаешь («Приступаю, сэр.»), а в конце одной-двумя фразами доложи результат.
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
- дополнения к главному HUD = sandbox\\hud\\hud.css и sandbox\\hud\\hud.js.
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

class Brain extends EventEmitter {
  constructor({ personaFile }) {
    super();
    this.personaFile = personaFile;
    fs.mkdirSync(path.dirname(personaFile), { recursive: true });
    fs.writeFileSync(personaFile, PERSONA, 'utf8');
    this.child = null;
    this.sessionId = null;
    this.turn = 0;
  }

  get busy() {
    return !!this.child;
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
    this.sessionId = null;
  }

  stop() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    try {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } catch {
      child.kill();
    }
    this.emit('event', { kind: 'stopped', turn: this.turn });
  }

  ask(prompt, settings, { retried = false } = {}) {
    this.stop();
    const claudePath = findClaude(settings.claudePath);
    const turn = ++this.turn;
    const emit = (ev) => this.emit('event', { ...ev, turn });
    if (!claudePath) {
      emit({ kind: 'error', code: 'missing', message: 'Не найден claude.exe. Укажите путь в настройках.' });
      return turn;
    }

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
    if (this.sessionId) args.push('--resume', this.sessionId);

    let cwd = settings.workDir;
    try { if (!fs.statSync(cwd).isDirectory()) cwd = os.homedir(); } catch { cwd = os.homedir(); }

    const child = spawn(claudePath, args, { cwd, env: cleanEnv(), windowsHide: true });
    this.child = child;
    emit({ kind: 'start', claudePath, cwd });

    let buffer = '';
    let stderr = '';
    let deltasSinceAssistant = 0;
    let finished = false;
    let resumeFailed = false;
    let authErrored = false;

    const handle = (msg) => {
      if (msg.session_id && msg.session_id !== this.sessionId && msg.type !== 'result') {
        this.sessionId = msg.session_id;
        emit({ kind: 'session', sessionId: msg.session_id });
      }
      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') emit({ kind: 'init', model: msg.model, sessionId: msg.session_id });
          break;
        case 'stream_event': {
          const e = msg.event || {};
          if (msg.parent_tool_use_id) break; // subagent chatter is not spoken
          if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
            deltasSinceAssistant++;
            emit({ kind: 'delta', text: e.delta.text });
          } else if (e.type === 'content_block_stop') {
            emit({ kind: 'block-end' });
          }
          break;
        }
        case 'assistant': {
          if (msg.parent_tool_use_id) break;
          const content = msg.message?.content || [];
          if (msg.error === 'authentication_failed') {
            authErrored = true;
            emit({ kind: 'error', code: 'auth', message: 'Claude Code не авторизован. Выполните вход.' });
            break;
          }
          for (const block of content) {
            if (block.type === 'tool_use') {
              emit({ kind: 'tool', name: block.name, detail: summarizeTool(block.name, block.input) });
            } else if (block.type === 'text' && deltasSinceAssistant === 0 && block.text) {
              // No partial chunks arrived for this block (synthetic/API-error messages) — pass it through whole.
              emit({ kind: 'delta', text: block.text });
              emit({ kind: 'block-end' });
            }
          }
          deltasSinceAssistant = 0;
          break;
        }
        case 'user': {
          for (const block of msg.message?.content || []) {
            if (block.type === 'tool_result' && block.is_error) emit({ kind: 'tool-error', text: String(block.content || '').slice(0, 200) });
          }
          break;
        }
        case 'result': {
          finished = true;
          const text = typeof msg.result === 'string' ? msg.result : '';
          if (msg.is_error && /no conversation found|session.*not found/i.test(text) && !retried) {
            resumeFailed = true; // the close handler retries without --resume
            break;
          }
          if (msg.session_id) this.sessionId = msg.session_id;
          if (msg.is_error && !authErrored && /not logged in|\/login|authenticat/i.test(text)) {
            emit({ kind: 'error', code: 'auth', message: 'Claude Code не авторизован. Выполните вход.' });
          }
          const u = msg.usage || {};
          emit({
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

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch { /* non-JSON noise */ }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      if (this.child === child) this.child = null;
      emit({ kind: 'error', code: 'spawn', message: 'Не удалось запустить Claude Code: ' + err.message });
    });

    child.on('close', (code) => {
      const wasCurrent = this.child === child;
      if (wasCurrent) this.child = null;
      if (!wasCurrent) return; // stopped or superseded
      const staleSession = resumeFailed || /no conversation found|session.*not found/i.test(stderr);
      if (staleSession && !retried) {
        this.sessionId = null;
        this.ask(prompt, settings, { retried: true });
        return;
      }
      if (!finished) {
        const reason = stderr.trim().split('\n').slice(-3).join(' ') || `код выхода ${code}`;
        emit({ kind: 'error', code: 'exit', message: 'Claude Code завершился с ошибкой: ' + reason });
      }
      emit({ kind: 'end', code });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(prompt, 'utf8');
    return turn;
  }
}

module.exports = { Brain, findClaude, cleanEnv };
