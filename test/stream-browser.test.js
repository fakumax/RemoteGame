const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { findBrowser, browserArgs, asciiTitle, createStreamer } = require('../stream-browser');

const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return; await wait(5); } throw new Error('timeout'); };

test('browserArgs: own profile, app window, no picker, no throttling, off screen', () => {
  const url = 'http://localhost:3000/stream.html?auto=1&name=kinst2&from=arcade';
  const win = browserArgs({ profile: 'C:\\RG\\cache\\stream-browser', url, capture: { title: 'Killer Instinct 2 [kinst2] - MAME 0.288 (LLP64)' } });
  assert.deepEqual(win, [
    '--user-data-dir=C:\\RG\\cache\\stream-browser', '--no-first-run', '--no-default-browser-check',
    '--window-position=-32000,-32000', '--window-size=480,320',
    '--auto-select-window-capture-source-by-title=Killer Instinct 2 [kinst2] - MAME 0.288 (LLP64)',
    '--system-audio-capture-default_checked',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
    '--app=' + url
  ]);
  // No window title: any screen, whatever its (translated) name.
  const screen = browserArgs({ profile: 'p', url, capture: { screen: true } });
  assert.ok(screen.includes('--auto-select-screen-capture-source') && !screen.some(a => a.includes('window-capture')));
  assert.ok(screen.includes('--system-audio-capture-default_checked'));
});

test('asciiTitle: the switch ignores anything that is not plain ASCII, so only the longest plain stretch is used', () => {
  assert.equal(asciiTitle('Killer Instinct 2 [kinst2] - MAME 0.288 (LLP64)'), 'Killer Instinct 2 [kinst2] - MAME 0.288 (LLP64)');
  assert.equal(asciiTitle('Eden | v0.0.3 | MSVC | Super Mario Party\u2122 Jamboree'), 'Eden | v0.0.3 | MSVC | Super Mario Party');
  assert.equal(asciiTitle('\u30de\u30ea\u30aa'), null);
  assert.equal(asciiTitle('ab'), null);
  assert.equal(asciiTitle(''), null);
});

test('findBrowser: Edge before Chrome, nothing when neither exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remotegame-br-'));
  try {
    const put = rel => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); return f; };
    const env = { ProgramFiles: path.join(root, 'pf'), 'ProgramFiles(x86)': path.join(root, 'pf86') };
    assert.equal(findBrowser(env), null);
    const chrome = put('pf/Google/Chrome/Application/chrome.exe');
    assert.deepEqual(findBrowser(env), { exe: chrome, name: 'Chrome' });
    const edge = put('pf86/Microsoft/Edge/Application/msedge.exe');
    assert.deepEqual(findBrowser(env), { exe: edge, name: 'Edge' });
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
