# Песочница JARVIS

Всё в этой папке работает **сразу и без перезапуска**: JARVIS следит за файлами и применяет правки на лету.
Эту инструкцию читает сам Джарвис (Claude), когда его просят сделать новый интерфейс, окно или инструмент.

| Что | Где | Когда применяется |
|---|---|---|
| Окно (виджет) | `widgets\<id>\index.html` + `widget.json` | новое окно открывается само; при правке перезагружается только оно, правка CSS — без перезагрузки |
| Плагин (Node.js) | `plugins\<id>.js` или `plugins\<id>\index.js` | подменяется на лету: `deactivate` старой копии → `activate` новой |
| Мод главного HUD | `hud\hud.css`, `hud\hud.js` | CSS — мгновенно, JS — `unmount` старого и `mount` нового |
| Стили для окон | `kit\jarvis-kit.css` | обновляются во всех открытых окнах |
| Голосовые макросы | `macros\<имя>.json` | перечитываются при каждой правке; срабатывают без обращения к Claude |

`id` — латиница, цифры, `-` и `_`. Состояние (окна, плагины, последние ошибки) — в `.status.json`, его пишет JARVIS.
Ошибки окон (`console.error`, падения загрузки) и плагинов также приходят Джарвису в HUD-контексте.

Команды в ответе Джарвиса: `[[window:id]]` — открыть окно, `[[close:id]]` — закрыть,
`[[call:плагин.метод|JSON]]` — вызвать плагин (JSON-массив = несколько аргументов, иначе один аргумент).

## Окно

`widgets\<id>\widget.json` (всё необязательно):

```json
{
  "title": "Заметки",
  "description": "подсказка в доке HUD",
  "width": 420, "height": 360,
  "alwaysOnTop": false,
  "resizable": true,
  "chrome": "inset",
  "autoOpen": true
}
```

- `chrome`: `inset` — полоса заголовка 32 px сверху, контент под ней (по умолчанию); `overlay` — заголовок прозрачный поверх контента;
  `none` — без заголовка (перетаскивание делайте сами через `-webkit-app-region: drag`). `transparent: true` — прозрачное окно без заголовка.
- Кнопки «свернуть/развернуть/закрыть» рисует Windows справа вверху (≈140 px) — не кладите туда свои элементы.
- Подключите стили HUD: `<link rel="stylesheet" href="/sandbox/kit/jarvis-kit.css">`. Пути от корня: `/sandbox/widgets/<id>/…`.
- Окно — обычная веб-страница (HTML/CSS/JS, `fetch` в интернет работает). Node.js в окне нет — для этого плагины.
- Положение и размер окна запоминаются; открытые окна снова открываются после перезапуска JARVIS.

### API окна: `window.jarvis`

```js
jarvis.say('Готово, сэр.');                 // сказать голосом Джарвиса
jarvis.notify('Сохранено', '');             // всплывашка в HUD; вид: '' | 'warn' | 'bad'
jarvis.ask('Сделай сводку по заметкам');    // отправить запрос Джарвису, как будто его набрали
await jarvis.call('timer', 'start', { seconds: 300, label: 'чай' });  // метод плагина
const off = jarvis.on('timer.state', (data) => {});  // событие плагина ('state' или 'плагин.state'; '*' — все)
await jarvis.store.set('notes', [...]);     // хранилище окна (JSON, до 5 МБ), переживает правки и перезапуски
await jarvis.store.get('notes');  await jarvis.store.all();
await jarvis.system.stats();                // CPU, память, диски, uptime
await jarvis.system.weather();              // погода в городе из настроек
await jarvis.projects();                    // список проектов HUD
await jarvis.open('other-widget');          // открыть другое окно
jarvis.widget.id; jarvis.widget.close(); jarvis.widget.minimize();
jarvis.widget.setTitle('…'); jarvis.widget.resize(500, 400); jarvis.widget.setAlwaysOnTop(true);
```

## Плагин

Модуль CommonJS в отдельном процессе с полным Node.js (fs, сеть, child_process, пакеты из `D:\jarvis\node_modules`).
Если плагин упал или завис, процесс плагинов перезапускается, HUD не страдает.

```js
// plugins\example.js
exports.activate = (ctx) => {
  ctx.handle('hello', (name) => `Привет, ${name}`);      // jarvis.call('example', 'hello', 'сэр')
  ctx.setInterval(() => ctx.emit('tick', Date.now()), 1000); // таймеры снимаются при выгрузке
  ctx.onDispose(() => {});                                  // своя уборка при правке/выгрузке
};
exports.deactivate = () => {};                              // необязательно
```

`ctx`: `handle(method, fn)`, `emit(event, data)`, `say(text)`, `notify(text, kind)`, `ask(text)`,
`openWidget(id)`, `closeWidget(id)`, `log(...)`, `setInterval`, `setTimeout`, `clearTimer`, `onDispose(fn)`,
`storage.get/set/all` (JSON, переживает правки плагина), `dataDir`.
Состояние в переменных модуля при правке теряется — то, что должно пережить правку, храните в `ctx.storage`.

## Мод HUD

- `hud\hud.css` — любые стили главного окна (селекторы как в `D:\jarvis\renderer\styles.css`).
- `hud\hud.js` — ES-модуль:

```js
export function mount(hud) {
  const el = document.createElement('div');   // hud.layer — свободный слой поверх HUD
  hud.layer.append(el);
  const off = hud.on('timer.state', (data) => {});
  return () => off();                           // уборка перед следующей версией мода
}
```

`hud`: `layer`, `$(selector)`, `say`, `toast(text, kind)`, `ask`, `activity(name, detail, cls)`,
`openWindow(id)`, `call(plugin, method, ...args)`, `on(event, cb)`, `state()`.

## Макросы

Макрос — фраза и действие. HUD сверяет каждую команду с фразами макросов **до** Claude: если совпало, действие
выполняется за миллисекунды, а Джарвис отвечает записанной фразой («Есть», «Запрос выполнен, сэр»).
Всё, что не совпало, как и раньше уходит в Claude. Сопоставление нечёткое (как в Priler/jarvis: 60 % по буквам,
40 % по словам, порог 75 %), поэтому ошибки распознавания вроде «выключи звуг» не мешают, а длинные просьбы
(«открой калькулятор и посчитай…») макросы не перехватывают.

```json
{
  "title": "Мои команды",
  "platform": "win32",
  "macros": [
    {
      "id": "work",
      "phrases": ["рабочий режим", "начинаем работать"],
      "do": [
        { "type": "open", "target": "code" },
        { "type": "open", "target": "https://mail.google.com" },
        { "type": "volume", "set": 30 }
      ],
      "sound": "done"
    },
    {
      "id": "volume",
      "phrases": ["громкость {number}", "звук на {number}"],
      "do": { "type": "volume", "set": "${number}" },
      "notify": "Громкость ${result}%"
    }
  ]
}
```

Поля макроса: `id`, `phrases` (строка или массив), `do` (действие или массив действий по порядку),
ответ — `sound` (реакция записанным голосом: `ok` по умолчанию, `ack`, `done`, `thanks`, `joke`, `game_mode`, `goodbye`,
`""` — молча), `say` (фраза нейроголосом), `notify` (всплывашка). Необязательно: `threshold` (порог сходства, для опасных
действий ставьте 85–90), `enabled: false`. `"platform": "win32"` на уровне файла — только для Windows.

Слоты во фразах: `{number}` (числа словами и цифрами: «двадцать пять», «70 процентов»), `{duration}` (секунды:
«пять минут», «полчаса», «час двадцать»), любое другое имя — текст. В действиях и ответах: `${имя}` — значение,
`${имя.raw}` — как было сказано, `${имя.url}` — для адресов, `${result}` — результат последнего действия.
Фраза со слотом должна совпасть целиком, иначе команда уйдёт в Claude.

| `type` | Поля | Что делает |
|---|---|---|
| `open` | `target`, `args` | сайт, `steam://…`, `ms-settings:`, файл, папка или программа по имени (`calc`, `notepad`, `code`) |
| `run` | `cmd`, `cwd` | команда `cmd.exe` в фоне |
| `close` | `process` (строка/массив), `force` | закрыть программу (`taskkill /IM`) |
| `keys` | `keys`: `"Win+D"` или `["Ctrl+C", "Alt+Tab"]`, `delay` | нажать сочетание клавиш |
| `volume` | `set` 0–100, `delta` ±N, `mute`: `"on"`/`"off"`/`"toggle"` | громкость Windows; `${result}` — новый уровень |
| `media` | `action`: `play`, `next`, `prev`, `stop` | медиаклавиши |
| `system` | `action`: `lock`, `sleep`, `minimize-all`, `empty-trash`, `screenshot` | `screenshot` сохраняет PNG в «Изображения\JARVIS», путь в `${result}` |
| `paste` | `text` | вставить текст через буфер обмена (надёжно для кириллицы) |
| `powershell` | `script` | выполнить PowerShell, вывод в `${result}` |
| `ahk` | `file` (`.ahk`/`.exe` рядом с json) или `code`, `args`, `version` | AutoHotkey — как в Priler/jarvis; `.exe` работает и без установленного AutoHotkey |
| `window` / `close-window` | `id` | окно песочницы |
| `plugin` | `plugin`, `method`, `args` | метод плагина песочницы |
| `say`, `notify`, `ask`, `hud`, `quit` | `text` / `command`, `arg` | голос, всплывашка, запрос к Claude, команда HUD (`panel`…), выход из JARVIS |
| `wait` | `ms` | пауза между действиями |

Клавиши, громкость, блокировка, скриншоты и PowerShell выполняет один заранее запущенный процесс PowerShell
(`src\winhost.ps1`), поэтому они не тратят секунду-две на запуск. Окна песочницы отзываются на своё название сами:
«открой заметки», «закрой таймер» — макрос для этого писать не нужно. Ошибки в json-файлах видны в `.status.json`
(поле `macros.errors`) и приходят Джарвису в HUD-контексте.

## Примеры в этой папке

- `widgets\notes` — заметки: хранилище окна, озвучка, запрос к Джарвису.
- `plugins\timer.js` + `widgets\timer` — таймеры: плагин считает и говорит «таймер истёк», окно показывает обратный отсчёт.
  Голосом: «Джарвис, поставь таймер на пять минут» — срабатывает макрос `macros\jarvis.json` (мгновенно); из ответа
  Claude то же самое делает `[[call:timer.start|{"seconds":300,"label":"пять минут"}]]`.
- `macros\system.json` — звук и громкость, медиаклавиши, окна, скриншот, блокировка, сон, раскладка (Windows).
- `macros\apps.json` — программы и сайты: калькулятор, блокнот, браузер, поиск в Google и YouTube, Steam и игровой режим.
- `macros\jarvis.json` — «спасибо», шутки, «выключись», таймер.
