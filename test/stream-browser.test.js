const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { findBrowser, browserArgs, asciiTitle, createStreamer } = require('../stream-browser');

const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return; await wait(5); } throw new Error('timeout'); };

test('browserArgs: headless by default (no window, no taskbar entry, no sharing bar), own profile, no picker, no throttling', () => {
  const url = 'http://localhost:3000/stream.html?auto=1&name=kinst2&from=arcade';
  const title = 'Killer Instinct 2 [kinst2] - MAME 0.288 (LLP64)';
  const common = [
    '--auto-select-window-capture-source-by-title=' + title,
    '--system-audio-capture-default_checked',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
    '--app=' + url
  ];
  assert.deepEqual(browserArgs({ profile: 'C:/RG/cache/stream-browser', url, capture: { title } }), [
    '--headless=new', '--user-data-dir=C:/RG/cache/stream-browser', '--no-first-run', '--no-default-browser-check', '--disable-sync', ...common
  ]);
  // headless: false keeps the old window, off screen.
  assert.deepEqual(browserArgs({ profile: 'C:/RG/cache/stream-browser', url, capture: { title }, headless: false }), [
    '--user-data-dir=C:/RG/cache/stream-browser', '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--window-position=-32000,-32000', '--window-size=480,320', ...common
  ]);
  // No window title: any screen, whatever its (translated) name.
  const screen = browserArgs({ profile: 'p', url, capture: { screen: true } });
  assert.ok(screen.includes('--auto-select-screen-capture-source') && !screen.some(a => a.includes('window-capture')));
  assert.ok(screen.includes('--system-audio-capture-default_checked') && screen.includes('--headless=new'));
});

test('asciiTitle: the switch ignores anything that is not plain ASCII, so only the longest plain stretch is used', () => {
  assert.equal(asciiTitle('Killer Instinct 2 [kinst2] - MAME 0.288 (LLP64)'), 'Killer Instinct 2 [kinst2] - MAME 0.288 (LLP64)');
  assert.equal(asciiTitle('Eden | v0.0.3 | MSVC | Super Mario Party\u2122 Jamboree'), 'Eden | v0.0.3 | MSVC | Super Mario Party');
  assert.equal(asciiTitle('\u30de\u30ea\u30aa'), null);
  assert.equal(asciiTitle('ab'), null);
  assert.equal(asciiTitle(''), null);
});

test('findBrowser: Chrome before Edge (Edge signs its profile in by itself), nothing when neither exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remotegame-br-'));
  try {
    const put = rel => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); return f; };
    const env = { ProgramFiles: path.join(root, 'pf'), 'ProgramFiles(x86)': path.join(root, 'pf86') };
    assert.equal(findBrowser(env), null);
    const edge = put('pf86/Microsoft/Edge/Application/msedge.exe');
    assert.deepEqual(findBrowser(env), { exe: edge, name: 'Edge' });
    const chrome = put('pf/Google/Chrome/Application/chrome.exe');
    assert.deepEqual(findBrowser(env), { exe: chrome, name: 'Chrome' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// A streamer with every process helper replaced: nothing real is ever started or killed.
function rig(extra = {}) {
  const r = { spawns: [], kills: [], focus: [], connected: false, title: 'Killer Instinct 2 [kinst2] - MAME', dead: new Set(), mainPid: 5151 };
  const spawn = (exe, args, opts) => { const c = new EventEmitter(); c.pid = 9000 + r.spawns.length; c.unref = () => {}; r.dead.add(c.pid); /* Edge's launcher exits at once */ r.spawns.push({ exe, args, opts, child: c }); return c; };
  r.streamer = createStreamer({
    browser: { exe: 'C:\\Edge\\msedge.exe', name: 'Edge' }, profile: 'C:\\RG\\cache\\stream-browser', port: () => 3108, isConnected: () => r.connected,
    spawn, windowTitle: async () => r.title, browserPid: async () => r.mainPid, kill: async pid => { r.kills.push(pid); r.dead.add(pid); if (pid === r.mainPid) r.mainPid++; }, alive: pid => !r.dead.has(pid) && pid !== 4242 + 1e6, focus: async pid => r.focus.push(pid),
    timing: { poll: 5, windowWait: 300, connectWait: 150, watch: 10 }, ...extra
  });
  return r;
}

test('streamer: the window is looked up first, then the stream window opens on it; it ends with the emulator', async () => {
  const r = rig();
  await r.streamer.start({ pid: 4242, name: 'kinst2', system: 'arcade' });
  assert.equal(r.spawns.length, 1);
  assert.equal(r.spawns[0].exe, 'C:\\Edge\\msedge.exe');
  assert.ok(r.spawns[0].args.includes('--auto-select-window-capture-source-by-title=Killer Instinct 2 [kinst2] - MAME'));
  assert.equal(r.spawns[0].args.at(-1), '--app=http://localhost:3108/stream.html?auto=1&name=kinst2&from=arcade');
  assert.equal(r.streamer.state(), 'starting');
  r.connected = true;
  await until(() => r.streamer.state() === 'on');
  await until(() => r.focus.length > 0);
  assert.deepEqual([...new Set(r.focus)], [4242]);   // the emulator gets the focus back from the new window
  r.connected = false;
  await r.streamer.stop();
  assert.deepEqual(r.kills, [5151]);   // only the browser process of our profile
  assert.equal(r.streamer.state(), 'off');
  await r.streamer.close();
});

test('streamer: a title that does not match, or no window at all, falls back to the screen', async () => {
  // Window found but the stream never arrives: after connectWait the window is closed and reopened on the screen.
  let r = rig();
  await r.streamer.start({ pid: 4242, name: 'x', system: 'arcade' });
  await until(() => r.spawns.length === 2);
  assert.ok(r.spawns[0].args.some(a => a.startsWith('--auto-select-window-capture-source-by-title=')));
  assert.ok(r.spawns[1].args.includes('--auto-select-screen-capture-source'));
  assert.ok(r.kills.includes(5151));
  r.connected = true;
  await until(() => r.streamer.state() === 'on');
  await r.streamer.close();
  // No window within windowWait: the screen straight away.
  r = rig({ windowTitle: async () => '', timing: { poll: 5, windowWait: 40, connectWait: 150, watch: 10 } });
  await r.streamer.start({ pid: 4242, name: 'x', system: 'switch' });
  assert.equal(r.spawns.length, 1);
  assert.ok(r.spawns[0].args.includes('--auto-select-screen-capture-source'));
  await r.streamer.close();
  // A title that is not plain ASCII (or too short) is not trusted either.
  r = rig({ windowTitle: async () => '\u30de\u30ea\u30aa' });
  await r.streamer.start({ pid: 4242, name: 'x', system: 'switch' });
  assert.ok(r.spawns[0].args.includes('--auto-select-screen-capture-source'));
  await r.streamer.close();
});

test('streamer: a window that is still changing its title is not captured yet', async () => {
  let n = 0;
  const r = rig({ windowTitle: async () => (n++ < 3 ? 'Loading ' + n : 'Eden | v1 | Game') });
  await r.streamer.start({ pid: 4242, name: 'x', system: 'switch' });
  assert.ok(r.spawns[0].args.includes('--auto-select-window-capture-source-by-title=Eden | v1 | Game'));
  await r.streamer.close();
});

test('streamer: the user closing the stream window is "cut"; starting again opens another; no browser is "nobrowser"', async () => {
  const r = rig();
  await r.streamer.start({ pid: 4242, name: 'x', system: 'arcade' });
  r.connected = true;
  await until(() => r.streamer.state() === 'on');
  // The window goes away (the process of our profile ends) and the page with it.
  r.dead.add(5151); r.connected = false;
  await until(() => r.streamer.state() === 'cut');
  r.dead.clear(); r.kills.length = 0;
  await r.streamer.start({ pid: 4242, name: 'x', system: 'arcade' });
  assert.equal(r.spawns.length, 2);
  assert.equal(r.streamer.state(), 'starting');
  await r.streamer.close();
  const none = rig({ browser: null });
  await none.streamer.start({ pid: 4242, name: 'x', system: 'arcade' });
  assert.equal(none.streamer.state(), 'nobrowser'); assert.equal(none.spawns.length, 0);
  await none.streamer.close();
});

test('streamer: stop kills nothing when there is no stream window, and never a PID it did not find', async () => {
  const r = rig({ browserPid: async () => null });
  await r.streamer.stop();
  assert.deepEqual(r.kills, []);
  await r.streamer.start({ pid: 4242, name: 'x', system: 'arcade' });
  await r.streamer.stop();
  // Neither the profile lookup nor the launcher PID is a live process of ours: the launcher (9000) is the only candidate, and only if alive.
  assert.ok(r.kills.every(pid => pid >= 9000 && pid < 9100));
  await r.streamer.close();
});

// ---- Nothing the browser or its helpers do may reject out of the streamer (an unhandled rejection ends Node)
function noRejections() {
  const seen = [], on = e => seen.push(e);
  process.on('unhandledRejection', on); process.on('uncaughtException', on);
  return { seen, stop() { process.off('unhandledRejection', on); process.off('uncaughtException', on); } };
}

test('streamer: the emulator ending while the screen fallback looks for the browser does not reject (the crash)', async () => {
  const rej = noRejections();
  try {
    // First open finds its process at once; the reopen on the screen never does, and the session ends meanwhile.
    let calls = 0;
    const r = rig({ browserPid: async () => { calls++; if (calls <= 2) return 777; await wait(40); return null; }, alive: () => true, timing: { poll: 5, windowWait: 300, connectWait: 40, watch: 5 } });
    await r.streamer.start({ pid: 4242, name: 'x', system: 'arcade' });
    await until(() => r.spawns.length === 2);   // the watcher is reopening on the screen
    await r.streamer.stop();
    await wait(200);
    assert.equal(r.streamer.state(), 'off');
    await r.streamer.close();
    // Never found and never connected: the watcher gives up ("cut") instead of throwing, whatever the overlap of its passes.
    const lost = rig({ browserPid: async () => { await wait(10); return null; }, alive: () => true, timing: { poll: 5, windowWait: 300, connectWait: 30, watch: 3 } });
    await lost.streamer.start({ pid: 4242, name: 'x', system: 'arcade' });
    await until(() => lost.streamer.state() === 'cut', 3000);
    await lost.streamer.close();
  } finally { rej.stop(); }
  assert.deepEqual(rej.seen, []);
});

test('streamer: a browser that cannot be launched, fails later, or helpers that throw leave the state "cut" and reject nothing', async () => {
  const rej = noRejections(), notes = [];
  try {
    let r = rig({ spawn: () => { throw new Error('spawn EACCES'); }, log: t => notes.push(t) });
    await r.streamer.start({ pid: 4242, name: 'x', system: 'arcade' });
    assert.equal(r.streamer.state(), 'cut');
    assert.ok(notes.some(t => /EACCES/.test(t)));
    await r.streamer.close();
    // An "error" event after the spawn (EACCES, UNKNOWN...) on a browser that was not found at all.
    r = rig({ browserPid: async () => null, timing: { poll: 5, windowWait: 300, connectWait: 5000, watch: 10 } });
    await r.streamer.start({ pid: 4242, name: 'x', system: 'arcade' });
    r.spawns[0].child.emit('error', new Error('spawn UNKNOWN'));
    assert.equal(r.streamer.state(), 'cut');
    await r.streamer.close();
    // Every helper throwing: start and stop still resolve.
    const boom = async () => { throw new Error('powershell'); };
    r = rig({ windowTitle: boom, browserPid: boom, kill: boom, focus: boom, log: () => { throw new Error('the log itself fails'); } });
    await r.streamer.start({ pid: 4242, name: 'x', system: 'arcade' });
    await r.streamer.stop();
    await r.streamer.close();
    // The launcher process that already exited is never killed by its old PID (Windows reuses PIDs at once).
    r = rig({ browserPid: async () => null, alive: () => true, timing: { poll: 5, windowWait: 300, connectWait: 5000, watch: 10 } });
    await r.streamer.start({ pid: 4242, name: 'x', system: 'arcade' });
    r.spawns[0].child.emit('exit', 0);
    await r.streamer.stop();
    assert.deepEqual(r.kills, []);
    await r.streamer.close();
  } finally { rej.stop(); }
  assert.deepEqual(rej.seen, []);
});

test('streamer: the browser starts headless unless told otherwise', async () => {
  let r = rig();
  await r.streamer.start({ pid: 4242, name: 'x', system: 'arcade' });
  assert.equal(r.spawns[0].args[0], '--headless=new');
  await r.streamer.close();
  r = rig({ headless: false });
  await r.streamer.start({ pid: 4242, name: 'x', system: 'arcade' });
  assert.ok(!r.spawns[0].args.includes('--headless=new') && r.spawns[0].args.includes('--window-position=-32000,-32000'));
  await r.streamer.close();
});
