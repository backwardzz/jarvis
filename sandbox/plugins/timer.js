// Countdown timers. From a window: jarvis.call('timer', 'start', { seconds: 300, label: 'чай' });
// from Jarvis: [[call:timer.start|{"seconds":300,"label":"чай"}]]. Timers live in ctx.storage, so they
// survive edits to this very file and restarts of JARVIS.
exports.activate = (ctx) => {
  let timers = (ctx.storage.get('timers') || []).filter((t) => t.end > Date.now());
  let nextId = Math.max(0, ...timers.map((t) => t.id)) + 1;

  const persist = () => ctx.storage.set('timers', timers);
  const view = () => timers.map((t) => ({ ...t, left: Math.max(0, Math.ceil((t.end - Date.now()) / 1000)) }));
  const publish = () => ctx.emit('state', view());

  ctx.handle('start', (arg = {}) => {
    const opts = typeof arg === 'object' && arg !== null ? arg : { seconds: Number(arg) };
    const seconds = Math.max(1, Math.round(Number(opts.seconds) || Number(opts.minutes) * 60 || 60));
    const t = { id: nextId++, label: String(opts.label || `${Math.round(seconds / 60) || seconds} ${seconds >= 60 ? 'мин' : 'сек'}`), total: seconds, end: Date.now() + seconds * 1000 };
    timers.push(t);
    persist();
    publish();
    ctx.openWidget('timer');
    return { id: t.id, seconds };
  });

  ctx.handle('cancel', (id) => {
    timers = timers.filter((t) => t.id !== Number(id));
    persist();
    publish();
    return true;
  });

  ctx.handle('list', () => view());

  ctx.setInterval(() => {
    const now = Date.now();
    for (const t of timers.filter((x) => x.end <= now)) {
      ctx.say(`Сэр, таймер «${t.label}» истёк.`);
      ctx.notify(`Таймер «${t.label}» истёк`);
    }
    const before = timers.length;
    timers = timers.filter((t) => t.end > now);
    if (timers.length !== before) persist();
    publish();
  }, 1000);
};
