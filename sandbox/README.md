# Песочница JARVIS

Всё в этой папке работает **сразу и без перезапуска**: JARVIS следит за файлами и применяет правки на лету.
Эту инструкцию читает сам Джарвис (Claude), когда его просят сделать новый интерфейс, окно или инструмент.

| Что | Где | Когда применяется |
|---|---|---|
| Окно (виджет) | `widgets\<id>\index.html` + `widget.json` | новое окно открывается само; при правке перезагружается только оно, правка CSS — без перезагрузки |
| Плагин (Node.js) | `plugins\<id>.js` или `plugins\<id>\index.js` | подменяется на лету: `deactivate` старой копии → `activate` новой |
| Мод главного HUD | `hud\hud.css`, `hud\hud.js` | CSS — мгновенно, JS — `unmount` старого и `mount` нового |
| Стили для окон | `kit\jarvis-kit.css` | обновляются во всех открытых окнах |

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

## Примеры в этой папке

- `widgets\notes` — заметки: хранилище окна, озвучка, запрос к Джарвису.
- `plugins\timer.js` + `widgets\timer` — таймеры: плагин считает и говорит «таймер истёк», окно показывает обратный отсчёт.
  Голосом: «Джарвис, поставь таймер на пять минут» → `[[call:timer.start|{"seconds":300,"label":"пять минут"}]]`.
