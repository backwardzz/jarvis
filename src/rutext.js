'use strict';
/** Russian speech text helpers for macros: normalisation, fuzzy similarity, spoken numbers and durations. */

function norm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s%]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Similarity in percent, 2·LCS / (|a| + |b|) · 100 — the same measure as difflib's / seqdiff's ratio,
 * which Priler's jarvis uses to match spoken phrases.
 */
function ratio(a, b) {
  if (!a.length && !b.length) return 100;
  if (!a.length || !b.length) return 0;
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return (200 * prev[b.length]) / (a.length + b.length);
}

// Russian endings, longest first: enough to tell "открыть", "открой" and "откройте" are one word.
const ENDING = /(ться|тесь|ться|ешь|ете|ите|ать|ять|ить|еть|ыть|оть|уть|ого|его|ому|ему|ыми|ими|ой|ей|ий|ый|ая|яя|ое|ее|ые|ие|ую|юю|ом|ем|ам|ям|ах|ях|ов|ев|ью|ия|а|я|о|е|ы|и|у|ю|ь|й)$/;

function stem(word) {
  const s = word.replace(ENDING, '');
  return s.length >= 3 ? s : word;
}

/** Closeness of two words in percent; the same stem counts as the same word. */
function wordRatio(a, b) {
  return a === b || stem(a) === stem(b) ? 100 : ratio(a, b);
}

/** Share of words that have a close counterpart (>70 %), weighted by how close — Priler's word score. */
function wordScore(inputWords, phraseWords) {
  if (!inputWords.length || !phraseWords.length) return 0;
  let matched = 0;
  for (const w of inputWords) {
    let best = 0;
    for (const p of phraseWords) best = Math.max(best, wordRatio(w, p));
    if (best > 70) matched += best / 100;
  }
  return (matched / Math.max(inputWords.length, phraseWords.length)) * 100;
}

/**
 * Combined phrase similarity: 60 % characters, 40 % words (as in Priler/jarvis commands.rs).
 * The same words in other forms or order ("паузу", "ютуб открой") count as a near-exact match.
 */
function similarity(input, phrase) {
  const a = input.split(' ').map(stem).sort().join(' ');
  const b = phrase.split(' ').map(stem).sort().join(' ');
  if (a === b) return 98;
  return ratio(input, phrase) * 0.6 + wordScore(input.split(' '), phrase.split(' ')) * 0.4;
}

// ---------------------------------------------------------------- numbers
const UNITS = {
  ноль: 0, нуль: 0, один: 1, одна: 1, одну: 1, одно: 1, раз: 1, два: 2, две: 2, пару: 2, пара: 2, три: 3, четыре: 4, пять: 5,
  шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13,
  четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
  двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90,
  сто: 100, двести: 200, триста: 300, четыреста: 400, пятьсот: 500, шестьсот: 600, семьсот: 700, восемьсот: 800, девятьсот: 900,
  полтора: 1.5, полторы: 1.5,
};
const THOUSAND = /^тысяч[аиу]?$/;
const PERCENT = /^(%|процент(а|ов)?)$/;

/** "двадцать пять" → 25, "50" → 50, "сто процентов" → 100; null if anything else is in the way. */
function parseNumber(text) {
  const words = norm(text).replace(/(\d)\s*%/g, '$1 %').split(' ').filter(Boolean);
  if (!words.length) return null;
  let total = 0;
  let group = 0;
  let seen = false;
  for (const w of words) {
    if (PERCENT.test(w)) continue;
    if (/^\d+([.,]\d+)?$/.test(w)) { group += Number(w.replace(',', '.')); seen = true; continue; }
    if (w in UNITS) { group += UNITS[w]; seen = true; continue; }
    if (THOUSAND.test(w)) { total += (group || 1) * 1000; group = 0; seen = true; continue; }
    return null;
  }
  return seen ? total + group : null;
}

// ---------------------------------------------------------------- durations
const DURATION_UNITS = [
  [/^(с|сек|секунд[аыу]?)$/, 1],
  [/^(м|мин|минут[аыу]?)$/, 60],
  [/^(ч|час(а|ов)?)$/, 3600],
];
const HALVES = { полчаса: 1800, полминуты: 30, полчасика: 1800 };

/** "пять минут" → 300, "полтора часа" → 5400, "час двадцать минут" → 4800; null if not a pure duration. */
function parseDuration(text) {
  const words = norm(text).split(' ').filter(Boolean);
  let seconds = 0;
  let pending = [];
  let units = 0;
  for (const w of words) {
    if (w === 'и' || w === 'на') continue;
    if (w in HALVES) { if (pending.length) return null; seconds += HALVES[w]; units++; continue; }
    const unit = DURATION_UNITS.find(([re]) => re.test(w));
    if (unit) {
      const n = pending.length ? parseNumber(pending.join(' ')) : 1;
      if (n === null) return null;
      seconds += n * unit[1];
      pending = [];
      units++;
      continue;
    }
    pending.push(w);
  }
  if (pending.length || !units) return null;
  return Math.round(seconds);
}

module.exports = { norm, ratio, stem, wordRatio, wordScore, similarity, parseNumber, parseDuration };
