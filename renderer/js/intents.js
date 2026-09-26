// Wake word, speech-recognition noise filtering and instant local commands.

// Whisper tends to "hear" these on silence or noise.
const HALLUCINATIONS = [
  /продолжение следует/i, /субтитр/i, /dimatorzok/i, /спасибо за просмотр/i, /подпис(ывайтесь|ка)/i,
  /редактор субтитров/i, /корректор/i, /thank you for watching/i, /^\W*(you|bye)\W*$/i, /amara\.org/i,
  /^[\s.,!?…-]*$/, /^(\s*(м+|а+|э+|угу|хм+)[.,!?…]*)+$/i,
];

const NAME = '(?:джарви\\p{L}*|джерви\\p{L}*|жарви\\p{L}*|дарвис\\p{L}*|джаврис\\p{L}*|ярвис\\p{L}*|чарвис\\p{L}*|шарвис\\p{L}*|j[ae]r?vi\\p{L}*)';
const TRAIL = `[\\s,.!?:;—»"'-]*`;
const WAKE = new RegExp(`^(?:(?:эй|хэй|ну|о|окей|ok|hey)[\\s,]+)?${NAME}${TRAIL}`, 'iu');
const WAKE_INNER = new RegExp(`^(?:\\S+\\s+){1,2}?${NAME}${TRAIL}`, 'iu');

export function isNoise(text) {
  const t = (text || '').trim();
  return t.length < 2 || HALLUCINATIONS.some((re) => re.test(t));
}

/** Returns null if the utterance is not addressed to JARVIS, otherwise the command after the name ('' if only the name). */
export function wakeCommand(text) {
  const t = (text || '').trim().replace(/^[«"'(\s]+/, '');
  const m = t.match(WAKE);
  if (!m) {
    // name in the first few words: "слушай, джарвис, ..."
    const inner = t.match(WAKE_INNER);
    if (!inner) return null;
    return t.slice(inner[0].length).trim();
  }
  return t.slice(m[0].length).trim();
}

const norm = (s) => (s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya', ь: '', ъ: '' };
const translit = (s) => norm(s).split('').map((c) => TRANSLIT[c] ?? c).join('').replace(/\s+/g, '');

export function findProject(query, projects) {
  const q = norm(query);
  const qt = translit(query);
  if (!q) return null;
  let best = null;
  for (const p of projects) {
    const keys = [p.name, p.id, ...(p.aliases || [])];
    try { if (p.url) keys.push(new URL(p.url).hostname.split('.')[0]); } catch { /* bad url */ }
    for (const k of keys) {
      const kn = norm(k);
      const kt = translit(k);
      if (!kn) continue;
      let score = 0;
      if (q === kn || qt === kt) score = 3;
      else if (q.includes(kn) || kt.length > 3 && qt.includes(kt)) score = 2;
      else if (kn.includes(q) && q.length > 3) score = 1;
      if (score > (best?.score || 0)) best = { project: p, score };
    }
  }
  return best?.project || null;
}

/**
 * Commands handled instantly without calling Claude.
 * Returns { action, ... } or null.
 */
export function localIntent(text, projects) {
  const t = norm(text);
  if (!t) return null;
  if (/^(стоп|хватит|замолчи|помолчи|тише|отмена|отмени|прекрати|достаточно)( пожалуйста)?$/.test(t)) return { action: 'stop' };
  if (/(нов(ый|ая|ое) (разговор|сесси|диалог|чат)|сбрось (контекст|разговор|диалог)|забудь (всё|все|разговор)|начн(и|ем) (сначала|заново))/.test(t)) return { action: 'reset' };
  if (/^(который час|сколько (сейчас )?времени|какое (сейчас )?время)/.test(t)) return { action: 'time' };
  if (/(какие|список|перечисли|назови|покажи все|сколько) .*проект/.test(t) && !/(сделай|создай|напиши|добавь)/.test(t)) return { action: 'list-projects' };
  const open = t.match(/^(?:открой|покажи|запусти|выведи|открыть|показать)(?: мне)?(?: (?:проект|сайт|страницу))? (.+)$/);
  // only short "open X" requests; "open X and tell me…" goes to Claude as a whole
  if (open && open[1].split(' ').length <= 4 && !/ (и|а также|потом|затем) /.test(` ${open[1]} `)) {
    const project = findProject(open[1], projects);
    if (project) return { action: 'open-project', project };
  }
  if (/^(открой|покажи)( мне)? (настройки|параметры)$/.test(t)) return { action: 'settings' };
  return null;
}
