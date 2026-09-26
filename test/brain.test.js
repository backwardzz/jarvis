'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { Brain } = require('../src/brain');

const skip = process.platform === 'win32' && 'the CLI test doubles are shebang scripts';
const WARM = path.join(__dirname, 'fixtures', 'warm-claude.js');
const OLD = path.join(__dirname, 'fixtures', 'old-claude.js');
const settings = (claudePath) => ({ claudePath, workDir: os.tmpdir(), addDirs: [] });

function harness() {
  const brain = new Brain({ personaFile: path.join(os.tmpdir(), `jarvis-persona-${process.pid}.md`) });
  const turns = new Map();
  brain.on('event', (ev) => {
    const t = turns.get(ev.turn) || { kinds: [], text: '' };
    t.kinds.push(ev.kind);
    if (ev.kind === 'delta') t.text += ev.text;
    if (ev.kind === 'start') t.warm = ev.warm;
    turns.set(ev.turn, t);
  });
  const ended = (turn) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`turn ${turn} did not end`)), 5000);
    const check = () => (turns.get(turn)?.kinds.includes('end') ? (clearTimeout(timer), resolve(turns.get(turn))) : setTimeout(check, 10));
    check();
  });
  return { brain, turns, ended };
}

test('warm core: one process answers turn after turn', { skip }, async () => {
  const { brain, ended } = harness();
  const a = await ended(brain.ask('первый', settings(WARM)));
  const b = await ended(brain.ask('второй', settings(WARM)));
  assert.equal(a.warm, true);
  assert.equal(a.text.split(':')[0], b.text.split(':')[0], 'both answers come from the same pid');
  brain.dispose();
});

test('warm core: a new command interrupts the running one without losing the process', { skip }, async () => {
  const { brain, turns, ended } = harness();
  const first = await ended(brain.ask('раз', settings(WARM)));
  const long = brain.ask('отвечай долго', settings(WARM));
  await new Promise((r) => setTimeout(r, 100));
  const next = await ended(brain.ask('следующий', settings(WARM)));
  assert.ok(!turns.get(long).kinds.includes('end'), 'the interrupted turn is not reported as finished');
  assert.equal(first.text.split(':')[0], next.text.split(':')[0], 'same process after the interrupt');
  assert.equal(brain.busy, false);
  brain.dispose();
});

test('warm core: a forgotten session is replaced and the command still answered', { skip }, async () => {
  const { brain, ended } = harness();
  brain.sessionId = 'stale';
  const t = await ended(brain.ask('привет', settings(WARM)));
  assert.match(t.text, /привет/);
  assert.ok(t.kinds.includes('done') && !t.kinds.includes('error'));
  assert.notEqual(brain.sessionId, 'stale');
  brain.dispose();
});

test('a CLI without stream-json input falls back to one process per command', { skip }, async () => {
  const { brain, ended } = harness();
  const a = await ended(brain.ask('раз', settings(OLD)));
  assert.match(a.text, /Эхо: раз/);
  assert.equal(brain.warmBroken, true);
  const b = await ended(brain.ask('два', settings(OLD)));
  assert.equal(b.warm, false);
  assert.match(b.text, /Эхо: два/);
  brain.dispose();
});
