// RemoteGame: a browser window of its own that captures a native emulator and streams it to the guests, with no picker.
// Chromium flags (checked on Edge 156 and Chrome 155 against the picker's own source, desktop_media_list_controller.cc):
//   --auto-select-window-capture-source-by-title=<text>  picks the first window whose title CONTAINS text (ASCII only, case-sensitive)
//   --auto-select-screen-capture-source                  picks any screen, whatever its (translated) name
//   --system-audio-capture-default_checked               ticks "share system audio" (the picker never does it by itself)
// getDisplayMedia needs no user gesture and shows no picker when one of the first two matches; with no match the picker
// stays open (and the request pending), which is why the window is looked up first and the screen is the fallback.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

// Edge first (always there on Windows 11), then Chrome. Returns { exe, name } or null.
function findBrowser(env = process.env) {
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
  const cands = [['Edge', 'Microsoft\\Edge\\Application\\msedge.exe'], ['Chrome', 'Google\\Chrome\\Application\\chrome.exe']];
  for (const [name, rel] of cands) for (const r of roots) { const exe = path.join(r, rel); try { if (fs.statSync(exe).isFile()) return { exe, name }; } catch (e) { /* next */ } }
  return null;
}

// The longest plain-ASCII stretch of a window title (the switch is ignored when its value has anything else), or null if too short to be safe.
function asciiTitle(title) {
  const best = String(title || '').split(/[^\x20-\x7e]+/).map(s => s.trim()).reduce((a, b) => b.length > a.length ? b : a, '');
  return best.length >= 4 ? best : null;
}

// capture: { title } captures that window, anything else the screen. The window sits off screen: it only has to exist.
function browserArgs({ profile, url, capture }) {
  return [
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
    '--window-position=-32000,-32000', '--window-size=480,320',
    capture && capture.title ? '--auto-select-window-capture-source-by-title=' + capture.title : '--auto-select-screen-capture-source',
    '--system-audio-capture-default_checked',
    // Off screen counts as hidden: without these the page's timers drop to one a second.
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
    '--app=' + url
  ];
}

const ps = (script, timeout = 8000) => new Promise(resolve => {
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout, encoding: 'utf8' }, (err, out) => resolve(err ? '' : String(out).trim()));
});
const quote = s => String(s).replace(/'/g, "''");
// The real process helpers (tests inject fakes). Edge's launcher exits at once and hands over to the browser process, which is
// found by the profile folder in its command line; only the main process (no --type=) with our own profile is ever killed.
const system = {
  windowTitle: async pid => Number.isInteger(pid) ? ps("(Get-Process -Id " + pid + " -ErrorAction SilentlyContinue).MainWindowTitle") : '',
  focus: async pid => { if (Number.isInteger(pid)) await ps("(New-Object -ComObject WScript.Shell).AppActivate(" + pid + ") | Out-Null"); },
  browserPid: async profile => {
    const out = await ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(msedge|chrome)\\.exe$' -and $_.CommandLine -and $_.CommandLine.Contains('" + quote(profile) + "') -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1 -ExpandProperty ProcessId");
    return Number(out) || null;
  },
  kill: pid => new Promise(resolve => { if (!Number.isInteger(pid)) return resolve(); execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()); }),
  alive: pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } },
  spawn
};

// One emulator + one stream window at a time. o: { browser: { exe, name } | null, profile, port(), isConnected(), onFocus?(pid) } plus
// any of the `system` helpers and `timing` ({ poll, windowWait, connectWait, watch }) to replace.
function createStreamer(o) {
  const sys = { ...system, ...o };
  const t = { poll: 1000, windowWait: 40000, connectWait: 20000, watch: 1500, ...o.timing };
  let cur = null, n = 0;   // cur: { pid, name, system, state, browser: { pid, child }, capture, openedAt, tries, focused }
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const live = id => cur && id === n;

  async function killBrowser() {
    const b = cur && cur.browser;
    if (!b) return;
    cur.browser = null;
    // The main process by our profile (it may differ from the launcher we started); the remembered PID only if that is still ours.
    const pid = (await sys.browserPid(o.profile).catch(() => null)) || (b.pid && sys.alive(b.pid) ? b.pid : null);
    if (pid) await sys.kill(pid);
    if (b.child && b.child.pid && sys.alive(b.child.pid)) await sys.kill(b.child.pid);
  }
  async function open(id, capture) {
    if (!live(id)) return;
    cur.capture = capture; cur.state = 'starting'; cur.openedAt = Date.now();
    const url = 'http://localhost:' + sys.port() + '/stream.html?auto=1&name=' + encodeURIComponent(cur.name) + '&from=' + encodeURIComponent(cur.system);
    let child;
    try {
      child = sys.spawn(o.browser.exe, browserArgs({ profile: o.profile, url, capture }), { detached: true, stdio: 'ignore' });
      child.on('error', () => { if (live(id) && cur.browser && cur.browser.child === child) { cur.browser = null; cur.state = 'cut'; } });
      if (child.unref) child.unref();
    } catch (e) { cur.state = 'cut'; return; }
    cur.browser = { child, pid: null };
    for (let i = 0; i < 20 && live(id) && cur.browser && !cur.browser.pid; i++) {
      cur.browser.pid = await sys.browserPid(o.profile).catch(() => null);
      if (!cur.browser.pid) await wait(Math.min(500, t.poll));
    }
  }
  // Waits for the emulator's window (the title can take a while to appear and to settle), then opens the stream window on it.
  async function launch(id) {
    cur.state = 'starting';
    if (!o.browser) { cur.state = 'nobrowser'; return; }
    let last = null, title = null;
    for (const end = Date.now() + t.windowWait; live(id) && Date.now() < end;) {
      const now = String(await sys.windowTitle(cur.pid).catch(() => '') || '').trim();
      if (now && now === last) { title = asciiTitle(now); break; }
      last = now;
      await wait(t.poll);
    }
    if (!live(id)) return;
    await open(id, title ? { title } : { screen: true });
    if (live(id) && sys.focus) setTimeout(() => { if (live(id)) sys.focus(cur.pid); }, 2500);
  }
  // Every so often: is the window still there, did the stream arrive, and if a window title did not match, fall back to the screen.
  const timer = setInterval(async () => {
    if (!cur || !cur.browser || cur.state === 'nobrowser') return;
    const id = n, b = cur.browser;
    if (b.pid && !sys.alive(b.pid)) { cur.browser = null; cur.state = 'cut'; return; }
    if (sys.isConnected()) {
      if (cur.state === 'starting') { cur.state = 'on'; if (sys.focus && !cur.focused) { cur.focused = true; sys.focus(cur.pid); } }
      return;
    }
    if (cur.state === 'on') { cur.state = 'cut'; await killBrowser(); return; }   // the page is gone but the process lingers
    if (cur.state === 'starting' && cur.openedAt && Date.now() - cur.openedAt > t.connectWait) {
      if (cur.capture && cur.capture.title) { await killBrowser(); await open(id, { screen: true }); }
      else { cur.state = 'cut'; await killBrowser(); }
    }
  }, t.watch);
  timer.unref();

  return {
    // Starts (or restarts) the stream for an emulator process. entry: { pid, name, system }
    start(entry) { const id = ++n; const prev = killBrowser(); cur = { ...entry, state: 'starting', browser: null }; return prev.then(() => launch(id)); },
    state: () => cur ? cur.state : 'off',
    capture: () => cur && cur.capture || null,
    // Closes the stream window (only ours) and forgets the session.
    async stop() { n++; const had = cur; await killBrowser(); if (had) had.state = 'off'; cur = null; },
    close() { clearInterval(timer); return this.stop(); },
    // Synchronous last resort for process exit: kills the main browser of our profile with taskkill.
    killNowSync() {
      const b = cur && cur.browser; if (!b) return;
      try { const pid = b.pid || null; if (pid) require('child_process').spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch (e) { /* nothing */ }
    }
  };
}

module.exports = { findBrowser, browserArgs, asciiTitle, createStreamer, system };
