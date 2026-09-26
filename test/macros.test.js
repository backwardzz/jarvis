'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Macros, fill } = require('../src/macros');

const DIR = path.join(__dirname, '..', 'sandbox', 'macros');
const sandbox = {
  opened: [],
  calls: [],
  list: () => [{ id: 'notes', title: 'Заметки' }, { id: 'timer', title: 'Таймер' }],
  open(id) { this.opened.push(id); return true; },
  close: () => true,
  call(plugin, method, args) { this.calls.push({ plugin, method, args }); return { id: 1 }; },
};

/** The shipped macros, including the Windows-only file, whatever this machine runs. */
function shipped() {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const m = new Macros({ dir: DIR, sandbox });
    m.load();
    return m;
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
}

test('shipped macro files load without errors', () => {
  const m = shipped();
  assert.deepEqual(m.errors, []);
  assert.ok(m.list.length > 30, `only ${m.list.length} macros`);
});

test('short commands match a macro, free-form requests go to Claude', () => {
  const m = shipped();
  const cases = {
    'Джарвис, выключи звук': 'system.mute',
    'включи звук': 'system.unmute',
    'громкость пятьдесят': 'system.volume-set',
    'выключи звуг': 'system.mute',
    'сделай скриншот пожалуйста': 'system.screenshot',
    'открой калькулятор': 'apps.calculator',
    'найди в гугле рецепт борща': 'apps.google-search',
    'поставь таймер на пять минут': 'jarvis.timer',
    'спасибо большое': 'jarvis.thanks',
    'выключись': 'jarvis.goodbye',
    'открой заметки': 'sandbox.open-notes',
    'закрой таймер': 'sandbox.close-timer',
    'выключи': null, // must not quit JARVIS
    'продолжи': null,
    'выключи свет': null,
    'открой калькулятор и посчитай двадцать на пять': null,
    'поставь таймер на пять минут и напомни про чай': null,
    'сделай мне сайт для кофейни': null,
  };
  for (const [text, id] of Object.entries(cases)) {
    assert.equal(m.match(text)?.macro.id ?? null, id, text);
  }
});

test('slots are parsed and filled into actions and replies', async () => {
  const m = shipped();
  const hit = m.match('громкость двадцать пять процентов');
  assert.equal(hit.slots.number.value, 25);
  sandbox.calls.length = 0;
  const r = await m.run('поставь таймер на полторы минуты');
  assert.equal(r.error, null);
  assert.deepEqual(sandbox.calls[0], { plugin: 'timer', method: 'start', args: [{ seconds: 90, label: 'полторы минуты' }] });
  assert.equal(r.reply.say, 'Таймер на полторы минуты, сэр.');
  assert.equal(fill('https://x/?q=${text.url}', { text: 'рецепт борща', 'text.raw': 'рецепт борща' }), 'https://x/?q=%D1%80%D0%B5%D1%86%D0%B5%D0%BF%D1%82%20%D0%B1%D0%BE%D1%80%D1%89%D0%B0');
});

test('HUD actions are handed back to the renderer, sounds default to "ok"', async () => {
  const m = shipped();
  const bye = await m.run('выключись');
  assert.deepEqual(bye.hud, [{ type: 'quit' }]);
  assert.equal(bye.reply.sound, 'goodbye');
  const win = await m.run('открой заметки');
  assert.equal(win.reply.sound, 'ok');
  assert.ok(sandbox.opened.includes('notes'));
});

test('a broken macro file is reported, the others keep working', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-macros-'));
  fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({ macros: [{ id: 'hi', phrases: ['привет'], say: 'Здравствуйте, сэр.' }] }));
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ "macros": [ oops ] }');
  fs.writeFileSync(path.join(dir, 'empty.json'), JSON.stringify({ macros: [{ id: 'x', phrases: [] }] }));
  const m = new Macros({ dir });
  const problems = [];
  m.on('problem', (e) => problems.push(e.source));
  m.load();
  assert.deepEqual(problems.sort(), ['macros/bad.json', 'macros/empty.json']);
  assert.equal(m.match('привет')?.macro.id, 'good.hi');
  fs.rmSync(dir, { recursive: true, force: true });
});
