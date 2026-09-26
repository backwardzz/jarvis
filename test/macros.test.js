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

test('word forms and order still match, one-word phrases need an exact hit', () => {
  const m = shipped();
  assert.equal(m.match('открыть калькулятор')?.macro.id, 'apps.calculator');
  assert.equal(m.match('паузу')?.macro.id, 'system.media-toggle');
  assert.equal(m.match('спасибо джарвис')?.macro.id, 'jarvis.thanks');
  assert.equal(m.match('угол'), null, '"угол" is not "гугл"');
});

test('routing: confident runs, doubtful goes to Claude, confirmed phrases are learned, rejected ones blocked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-route-'));
  const learnedFile = path.join(dir, 'learned.json');
  fs.writeFileSync(path.join(dir, 'm.json'), JSON.stringify({ macros: [
    { id: 'shot', phrases: ['сделай скриншот'], say: 'Готово.' },
    { id: 'vol', phrases: ['громкость {number}'], say: '${number}' },
  ] }));
  const m = new Macros({ dir, learnedFile });
  m.load();

  assert.equal((await m.route('сделай скриншот')).kind, 'macro');
  const doubt = await m.route('сделай скриншот экрана');
  assert.equal(doubt.kind, 'maybe');
  assert.equal(doubt.candidate.id, 'm.shot');
  assert.equal(await m.route('напиши письмо маме'), null);

  // Claude answered [[macro:m.shot]]: it runs, and the phrase now works on its own
  const r = await m.runId('m.shot', 'сделай скриншот экрана');
  assert.equal(r.reply.say, 'Готово.');
  assert.equal((await m.route('сделай скриншот экрана')).kind, 'macro');
  // a phrase with slots is filled, not learned verbatim
  assert.equal((await m.runId('m.vol', 'громкость сорок')).reply.say, '40');
  assert.equal((await m.runId('m.vol', 'громкость как вчера')).error, 'не понял параметры команды');

  // "не то": this phrase never runs this macro again — and it survives a restart
  m.block('сделай скриншот', 'm.shot');
  const again = new Macros({ dir, learnedFile });
  again.load();
  assert.equal(again.match('сделай скриншот'), null);
  assert.equal(again.match('сделай скриншот экрана')?.macro.id, 'm.shot');
  assert.deepEqual([again.summary().learned, again.summary().blocked], [1, 1]);
  fs.rmSync(dir, { recursive: true, force: true });
});
