'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNumber, parseDuration, similarity, norm } = require('../src/rutext');

test('spoken numbers', () => {
  assert.equal(parseNumber('пятьдесят'), 50);
  assert.equal(parseNumber('двадцать пять процентов'), 25);
  assert.equal(parseNumber('сто'), 100);
  assert.equal(parseNumber('70'), 70);
  assert.equal(parseNumber('две тысячи двадцать шесть'), 2026);
  assert.equal(parseNumber('полтора'), 1.5);
  assert.equal(parseNumber('пять минут'), null);
  assert.equal(parseNumber(''), null);
});

test('spoken durations', () => {
  assert.equal(parseDuration('пять минут'), 300);
  assert.equal(parseDuration('десять секунд'), 10);
  assert.equal(parseDuration('минуту'), 60);
  assert.equal(parseDuration('полчаса'), 1800);
  assert.equal(parseDuration('полтора часа'), 5400);
  assert.equal(parseDuration('час двадцать минут'), 4800);
  assert.equal(parseDuration('2 часа и 15 минут'), 8100);
  assert.equal(parseDuration('пять'), null);
  assert.equal(parseDuration('пять минут и напомни про чай'), null);
});

test('similarity tolerates recognition slips but not different commands', () => {
  assert.ok(similarity(norm('выключи звуг'), norm('выключи звук')) > 75);
  assert.ok(similarity(norm('выключи свет'), norm('выключи звук')) < 75);
  assert.ok(similarity(norm('открой калькулятор и посчитай'), norm('открой калькулятор')) < 75);
});

test('word forms share a stem', () => {
  const { stem } = require('../src/rutext');
  assert.equal(stem('открыть'), stem('открой'));
  assert.equal(stem('паузу'), stem('пауза'));
  assert.notEqual(stem('звук'), stem('свет'));
});
