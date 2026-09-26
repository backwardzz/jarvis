'use strict';
/**
 * `--selftest-sandbox`: exercises the live sandbox end to end and cleans up after itself —
 * widget API and storage, plugin calls and events, a widget created/edited/restyled/deleted on the fly,
 * a plugin hot-swapped, and a HUD mod applied.
 */
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    if (Date.now() > end) return null;
    await sleep(150);
  }
}

async function run({ sandbox, win, root, log, capture }) {
  const results = [];
  const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
  const inWidget = (id, js) => sandbox.windows.get(id).webContents.executeJavaScript(js);
  const liveDir = path.join(root, 'widgets', 'selftest-live');
  const echoFile = path.join(root, 'plugins', 'selftest-echo.js');
  const hudCss = path.join(root, 'hud', 'hud.css');
  const hudCssBefore = fs.readFileSync(hudCss, 'utf8');

  try {
    // 1. an existing widget and its API
    sandbox.open('notes');
    const ready = await waitFor(() => inWidget('notes', 'document.readyState === "complete" && !!window.jarvis && !!document.getElementById("jarvis-titlebar")'));
    check('notes opens with title strip and window.jarvis', !!ready);
    const stored = await inWidget('notes', `(async () => { await jarvis.store.set('selftest', { n: 42 }); return (await jarvis.store.get('selftest')).n; })()`);
    check('widget store round-trip', stored === 42, String(stored));
    await inWidget('notes', `jarvis.store.set('selftest', undefined)`);
    const noNode = await inWidget('notes', 'typeof require === "undefined" && typeof process === "undefined"');
    check('widget has no Node access', noNode === true);

    // 2. plugin call, auto-opened window, events
    const started = await waitFor(() => sandbox.plugins.get('timer')?.ok);
    check('timer plugin loaded', !!started);
    const r = await sandbox.call('timer', 'start', [{ seconds: 4, label: 'самотест' }]);
    check('timer.start returns an id', !!r?.id, JSON.stringify(r));
    const timerWin = await waitFor(() => sandbox.windows.get('timer'));
    check('plugin opened the timer window', !!timerWin);
    const shown = await waitFor(() => inWidget('timer', 'document.querySelector("#timers .left")?.textContent'), 6000);
    check('timer window shows the countdown from plugin events', !!shown, shown || '');

    // 3. a widget born, edited, restyled and removed while running
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(path.join(liveDir, 'widget.json'), JSON.stringify({ title: 'Живой тест', width: 360, height: 240 }));
    fs.writeFileSync(path.join(liveDir, 'style.css'), 'body { color: rgb(1, 2, 3); }');
    fs.writeFileSync(path.join(liveDir, 'index.html'), '<link rel="stylesheet" href="style.css"><h1 id="v">v1</h1><script>window.bornAt = Date.now()</script>');
    const born = await waitFor(() => sandbox.windows.get('selftest-live') && inWidget('selftest-live', 'document.getElementById("v")?.textContent'));
    check('new widget folder opens a window by itself', born === 'v1', String(born));
    const bornAt = await inWidget('selftest-live', 'window.bornAt');
    fs.writeFileSync(path.join(liveDir, 'style.css'), 'body { color: rgb(4, 5, 6); }');
    const restyled = await waitFor(() => inWidget('selftest-live', 'getComputedStyle(document.body).color === "rgb(4, 5, 6)"'));
    const sameLoad = (await inWidget('selftest-live', 'window.bornAt')) === bornAt;
    check('CSS edit restyles without reloading', !!restyled && sameLoad);
    fs.writeFileSync(path.join(liveDir, 'index.html'), '<link rel="stylesheet" href="style.css"><h1 id="v">v2</h1><script>window.bornAt = Date.now()</script>');
    const edited = await waitFor(() => inWidget('selftest-live', 'document.getElementById("v")?.textContent === "v2"'));
    check('HTML edit reloads only that window', !!edited);
    fs.rmSync(liveDir, { recursive: true, force: true });
    const gone = await waitFor(() => !sandbox.windows.has('selftest-live'));
    check('deleting the folder closes the window', !!gone);

    // 4. plugin hot swap
    fs.writeFileSync(echoFile, "exports.activate = (ctx) => { ctx.handle('ping', () => 'v1'); };");
    const v1 = await waitFor(() => sandbox.call('selftest-echo', 'ping', []));
    fs.writeFileSync(echoFile, "exports.activate = (ctx) => { ctx.handle('ping', () => 'v2'); };");
    const v2 = await waitFor(async () => ((await sandbox.call('selftest-echo', 'ping', [])) === 'v2' ? 'v2' : null));
    check('plugin edit swaps it in place', v1 === 'v1' && v2 === 'v2', `${v1} → ${v2}`);
    fs.writeFileSync(echoFile, 'exports.activate = (ctx) => { ctx.handle(');
    const broken = await waitFor(() => sandbox.errors.some((e) => e.source === 'plugins/selftest-echo'));
    check('broken plugin is reported, not loaded', !!broken);
    fs.rmSync(echoFile, { force: true });

    // 5. HUD mod
    fs.writeFileSync(hudCss, hudCssBefore + '\n#state-line { letter-spacing: 7px; }\n');
    const modded = await waitFor(() => win.webContents.executeJavaScript('getComputedStyle(document.getElementById("state-line")).letterSpacing === "7px"'));
    check('hud.css applies to the HUD live', !!modded);
    fs.writeFileSync(hudCss, hudCssBefore);

    await sleep(600);
    if (capture) {
      for (const [id, w] of sandbox.windows) {
        const img = await w.webContents.capturePage();
        fs.writeFileSync(path.join(capture, `widget-${id}.png`), img.toPNG());
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(capture, 'hud.png'), img.toPNG());
    }
  } catch (e) {
    check('selftest crashed', false, e.stack || e.message);
  } finally {
    fs.rmSync(liveDir, { recursive: true, force: true });
    fs.rmSync(echoFile, { force: true });
    fs.writeFileSync(hudCss, hudCssBefore);
  }
  log('sandbox selftest\n  ' + results.join('\n  '));
  return results;
}

module.exports = { run };
