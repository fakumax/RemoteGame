// RemoteGame: end-to-end "Switch with another person", all headless.
// A real server (port 3122, --no-share, NODE_TEST_CONTEXT=1: its DSU takes a free test port, never 26760), a stream page
// with a fake canvas capture as the host, two guests in separate browser contexts (fake pad + keyboard) and a DSU client
// that asks like Eden does. Run: pnpm test:e2e   (one case: pnpm test:e2e <part of its name>)
'use strict';
const { chromium } = require('@playwright/test');
const { spawn, execFileSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const PORT = 3122, BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const filter = process.argv[2] || '';

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(60);
  }
  throw new Error('timeout (' + ms + ' ms): ' + what + (last instanceof Error ? ' [' + last.message + ']' : ''));
}
const json = (p, init) => fetch(BASE + p, init).then(r => r.json());
const owner = (p, word, method) => fetch(BASE + p, { method: method || 'GET', headers: { 'X-RemoteGame': word } }).then(r => r.json());

// ---- The server, a child process we kill by pid.
let server = null, tmp = null;
async function startServer() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remotegame-e2e-'));
  server = spawn(process.execPath, ['server.js', '--no-share'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, PORT: String(PORT), NODE_TEST_CONTEXT: '1', GAMES_ROOT: tmp, SHARE: '0' }
  });
  server.out = '';
  server.stdout.on('data', d => { server.out += d; });
  server.stderr.on('data', d => { server.out += d; });
  await until(() => json('/api/info').then(i => i.port === PORT), 15000, 'server up on ' + PORT);
}
function stopServer() {
  if (server && server.pid) {
    try { execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { try { server.kill(); } catch (e2) { /* gone */ } }
  }
  server = null;
  if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* in use */ } tmp = null; }
}

// ---- A DSU client that asks like Eden: version, ports 0-3, then pad data for every pad, renewed every second.
function dsuRequest(type, payload) {
  const buf = Buffer.alloc(20 + payload.length);
  buf.write('DSUC', 0, 'latin1');
  buf.writeUInt16LE(1001, 4); buf.writeUInt16LE(payload.length + 4, 6); buf.writeUInt32LE(0xe2e0e2e0, 12); buf.writeUInt32LE(type, 16);
  Buffer.from(payload).copy(buf, 20);
  buf.writeUInt32LE(zlib.crc32(buf), 8);
  return buf;
}
async function dsuClient(port, { flags = 0, pad = 0 } = {}) {
  const sock = dgram.createSocket('udp4');
  const pads = {};   // DSU pad number -> latest { connected, set1, set2, lx, ly, rx, ry, counter, at }
  const infos = {};  // DSU pad number -> state byte of the last port info
  let ports = 0;
  sock.on('message', msg => {
    if (msg.length < 20 || msg.toString('latin1', 0, 4) !== 'DSUS') return;
    const type = msg.readUInt32LE(16);
    if (type === 0x100001) { infos[msg[20]] = msg[21]; ports++; }
    else if (type === 0x100002 && msg.length >= 100) {
      pads[msg[20]] = { connected: msg[31] === 1, counter: msg.readUInt32LE(32), set1: msg[36], set2: msg[37], lx: msg[40], ly: msg[41], rx: msg[42], ry: msg[43], at: Date.now() };
    }
  });
  await new Promise(r => sock.bind(0, '127.0.0.1', r));
  const ask = buf => sock.send(buf, port, '127.0.0.1');
  const subscribe = () => ask(dsuRequest(0x100002, [flags, pad, 0, 0, 0, 0, 0, 0]));
  ask(dsuRequest(0x100000, []));
  ask(dsuRequest(0x100001, Buffer.from([4, 0, 0, 0, 0, 1, 2, 3])));
  subscribe();
  const timer = setInterval(subscribe, 1000);
  return {
    pads, infos, get ports() { return ports; },
    // Waits for pad `n` to show exactly these digital sets (a fresh packet, not an old one).
    async expect(n, set1, set2, ms = 6000) {
      await until(() => { const p = pads[n]; return p && p.connected && Date.now() - p.at < 1500 && p.set1 === set1 && p.set2 === set2; }, ms,
        'DSU pad ' + n + ' = ' + set1 + '/' + set2 + ' (has ' + (pads[n] ? pads[n].set1 + '/' + pads[n].set2 + (pads[n].connected ? '' : ' off') : 'nothing') + ')');
    },
    close() { clearInterval(timer); try { sock.close(); } catch (e) { /* closed */ } }
  };
}

// ---- Browsers and pages.
let browser = null;
const contexts = [];
async function openBrowser() {
  const args = ['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
  for (const channel of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel, headless: true, args }); return; } catch (e) { /* try the next */ }
  }
  browser = await chromium.launch({ headless: true, args });
}
async function newContext() {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  contexts.push(ctx);
  return ctx;
}
// The host captures an animated canvas instead of a window (no picker, no screen).
const FAKE_CAPTURE = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 360;
  const g = canvas.getContext('2d');
  let n = 0;
  setInterval(() => { n++; g.fillStyle = 'hsl(' + (n * 3 % 360) + ',70%,40%)'; g.fillRect(0, 0, 640, 360); g.fillStyle = '#fff'; g.font = '40px sans-serif'; g.fillText('frame ' + n, 40, 180); }, 33);
  const stream = canvas.captureStream(30);
  navigator.mediaDevices.getDisplayMedia = async () => stream.clone();
};
// A guest's pad: navigator.getGamepads() answers with whatever window.__pressed lists (standard mapping, Xbox).
const FAKE_PAD = () => {
  window.__pressed = null;   // null: no pad plugged; otherwise a list of standard button indexes
  const make = list => {
    const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: list.includes(i), touched: list.includes(i), value: list.includes(i) ? 1 : 0 }));
    return { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard', timestamp: performance.now(), axes: [0, 0, 0, 0], buttons, vibrationActuator: null };
  };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => window.__pressed ? [make(window.__pressed), null, null, null] : [null, null, null, null] });
};
// E2E_DEBUG=1 prints what the pages say.
function trace(page, who) {
  if (!process.env.E2E_DEBUG) return;
  page.on('console', m => console.log('[' + who + '] ' + m.text()));
  page.on('pageerror', e => console.log('[' + who + '] ERROR ' + e.message));
}
// Sabotage for the cases, injected before the page's own scripts run (the page code is not touched).
// Every WebSocket and RTCPeerConnection the page makes is kept in window.__socks / window.__pcs.
const SPY = () => {
  window.__socks = []; window.__pcs = [];
  const WS = window.WebSocket;
  window.WebSocket = class extends WS { constructor(...a) { super(...a); window.__socks.push(this); } };
  const PC = window.RTCPeerConnection;
  window.RTCPeerConnection = function(...a) {
    const pc = new PC(...a);
    window.__pcs.push(pc);
    // __blockChannel: this many calls never hand their DataChannel to the page (it "never opens").
    if (window.__blockChannel > 0) { window.__blockChannel--; Object.defineProperty(pc, 'ondatachannel', { set() {}, get() { return null; } }); }
    return pc;
  };
  window.RTCPeerConnection.prototype = PC.prototype;
  // __mute: the pad messages never leave this page (a channel that is open but dead).
  const send = RTCDataChannel.prototype.send;
  // __bump: the pad sequence numbers jump far ahead (the host then remembers a number the guest is no longer at).
  RTCDataChannel.prototype.send = function(data) {
    const pad = typeof data === 'string' && data.includes('"pad"');
    if (pad && window.__mute) return;
    if (pad && window.__bump) { const m = JSON.parse(data); m.s += window.__bump; data = JSON.stringify(m); }
    return send.call(this, data);
  };
  // __fz: the video stats report a freeze (what a real stutter looks like to getStats).
  const stats = PC.prototype.getStats;
  PC.prototype.getStats = async function(...a) {
    const r = await stats.apply(this, a), m = new Map();
    r.forEach((v, k) => m.set(k, v));
    if (window.__fz) for (const [k, v] of m) if (v.type === 'inbound-rtp' && v.kind === 'video') m.set(k, { ...v, freezeCount: (v.freezeCount || 0) + window.__fz.count, totalFreezesDuration: (v.totalFreezesDuration || 0) + window.__fz.sec, packetsLost: (v.packetsLost || 0) + window.__fz.lost, jitter: 0.022 });
    return m;
  };
};
async function hostPage(ctx, init) {
  const page = await ctx.newPage();
  page.on('pageerror', e => { page.errors = (page.errors || []).concat(e.message); });
  await page.addInitScript(FAKE_CAPTURE);
  await page.addInitScript(SPY);
  if (init) await page.addInitScript(init);
  trace(page, 'host');
  await page.goto(BASE + '/stream.html?auto=1&name=Switch%20de%20prueba', { waitUntil: 'domcontentloaded' });
  return page;
}
async function guestPage(ctx, init) {
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.addInitScript(FAKE_PAD);
  await page.addInitScript(SPY);
  if (init) await page.addInitScript(init);
  trace(page, 'guest');
  await page.goto(BASE + '/sala', { waitUntil: 'domcontentloaded' });
  return page;
}
const pressPad = (page, list) => page.evaluate(l => { window.__pressed = l; }, list);
const text = (page, sel) => page.locator(sel).first().innerText().catch(() => '');
const connected = page => page.waitForFunction(() => /Conectado/.test(document.getElementById('status').textContent), null, { timeout: 25000 });
const seats = () => json('/api/party');

// What every open page says, to understand a failure.
async function dump() {
  if (!process.env.E2E_DEBUG) return;
  for (const ctx of contexts) for (const page of ctx.pages()) {
    console.log('  page ' + page.url().replace(BASE, '') + ': ' + (await page.evaluate(() => (document.getElementById('status') || {}).textContent + ' | ' + ((document.getElementById('me') || {}).textContent || '') + ' | ' + ((document.getElementById('pad') || {}).textContent || '') + ' pressed=' + JSON.stringify(window.__pressed)).catch(() => '?')).replace(/\s+/g, ' '));
  }
  console.log('  vpad: ' + JSON.stringify((await json('/api/vpad').catch(() => ({}))).slots) + ' | party: ' + JSON.stringify(await seats().catch(() => ({}))));
}

// ---- The cases. Each one starts from a clean room (the contexts are closed in between).
const cases = [];
const add = (name, fn) => cases.push({ name, fn });

add('mandos: dos invitados llegan a los pads 1 y 2 de Eden', async () => {
  const dsu = await dsuClient((await json('/api/vpad')).dsu.port);
  try {
    const host = await hostPage(await newContext());
    const a = await guestPage(await newContext()), b = await guestPage(await newContext());
    await Promise.all([connected(a), connected(b)]);
    const ids = await Promise.all([text(a, '#me'), text(b, '#me')]);
    if (!/Sos P2/.test(ids[0]) || !/Sos P3/.test(ids[1])) throw new Error('seats: ' + ids.join(' / '));
    // Each guest is told by the host that its controls arrive.
    await Promise.all([a, b].map(p => until(async () => /✓ Tus controles llegan al juego/.test(await text(p, '#ctl')), 8000, 'guest sees "controls arrive"')));
    // P2 at the keyboard: Up + Z (B). P3 on a pad: D-pad left + button 1 (Xbox B = RetroPad A).
    await a.keyboard.down('ArrowUp'); await a.keyboard.down('KeyZ');
    await pressPad(b, [14, 1]);
    await dsu.expect(1, 16, 64);
    await dsu.expect(2, 128, 32);
    await a.keyboard.up('ArrowUp'); await a.keyboard.up('KeyZ'); await pressPad(b, []);
    await dsu.expect(1, 0, 0); await dsu.expect(2, 0, 0);
    if (dsu.pads[0] && dsu.pads[0].connected) throw new Error('pad 0 must stay disconnected');
    // The host page lights up what each guest presses, and says Eden reads the pads.
    await a.keyboard.down('ArrowUp'); await a.keyboard.down('KeyZ');
    await until(async () => /P2[\s\S]*↑ A/.test(await text(host, '#lights')), 5000, 'host lights show P2 up + A: ' + await text(host, '#lights'));
    await until(async () => /Eden conectado a los mandos/.test(await text(host, '#eden')), 8000, 'host says Eden is connected: ' + await text(host, '#eden'));
    await a.keyboard.up('ArrowUp'); await a.keyboard.up('KeyZ');
    // P2 types on the keyboard, P3 has a pad (the guest tells the server once its page has seen it).
    const who = async () => (await seats()).who.map(w => 'P' + w.player + ' ' + w.label + ' ' + w.pad).join(' | ');
    await until(async () => /^P2 PC · \w+\s+\| P3 PC · \w+ mando de Xbox$/.test(await who()), 5000, 'who is who: ' + await who());
  } finally { dsu.close(); }
});

// One guest presses Up + Z on the keyboard; the DSU client must see it on `pad`.
async function pressAndSee(dsu, page, pad, ms) {
  await page.keyboard.down('ArrowUp'); await page.keyboard.down('KeyZ');
  try { await dsu.expect(pad, 16, 64, ms); }
  finally { await page.keyboard.up('ArrowUp'); await page.keyboard.up('KeyZ'); }
}
const dsuNow = async opts => dsuClient((await json('/api/vpad')).dsu.port, opts);

add('invitado entra antes que el anfitrión', async () => {
  const dsu = await dsuNow();
  try {
    const guest = await guestPage(await newContext());
    await until(async () => /Esperando/.test(await text(guest, '#status')), 10000, 'waiting message');
    await sleep(1500);
    await hostPage(await newContext());
    await connected(guest);
    await pressAndSee(dsu, guest, 1);
  } finally { dsu.close(); }
});

add('anfitrión se reinicia: el invitado sigue jugando sin recargar', async () => {
  const dsu = await dsuNow();
  try {
    const hostCtx = await newContext();
    const host = await hostPage(hostCtx);
    const guest = await guestPage(await newContext());
    await connected(guest);
    await pressAndSee(dsu, guest, 1);
    await host.close();
    await until(async () => !/Conectado/.test(await text(guest, '#status')), 8000, 'guest notices the host left');
    await hostPage(hostCtx);
    await connected(guest);
    await pressAndSee(dsu, guest, 1, 8000);
  } finally { dsu.close(); }
});

add('anfitrión reemplazado por otra pestaña de transmisión', async () => {
  const dsu = await dsuNow();
  try {
    const hostCtx = await newContext();
    await hostPage(hostCtx);
    const guest = await guestPage(await newContext());
    await connected(guest);
    await sleep(1500);
    await hostPage(hostCtx);   // a second stream page takes over; the first is told to close
    await sleep(2500);
    await connected(guest);
    await pressAndSee(dsu, guest, 1, 8000);
  } finally { dsu.close(); }
});

add('invitado con dos pestañas en el mismo navegador', async () => {
  const dsu = await dsuNow();
  try {
    await hostPage(await newContext());
    const ctx = await newContext();
    const a = await guestPage(ctx);
    await connected(a);
    const b = await guestPage(ctx);
    await connected(b);
    await pressAndSee(dsu, b, 1);
    // The tab opened first must be silent: whatever it presses never reaches the game.
    await a.bringToFront();
    await pressAndSee(dsu, a, 1, 3000).then(() => { throw new Error('the old tab still controls the game'); }, e => { if (!/timeout/.test(e.message)) throw e; });
    if (!/otra pesta/.test(await text(a, '#status'))) throw new Error('the old tab does not say why: ' + await text(a, '#status'));
  } finally { dsu.close(); }
});

add('invitado con el link abierto en dos navegadores (P2 y P3)', async () => {
  const dsu = await dsuNow();
  try {
    await hostPage(await newContext());
    const a = await guestPage(await newContext()), b = await guestPage(await newContext());
    await Promise.all([connected(a), connected(b)]);
    await pressAndSee(dsu, a, 1);
    await pressAndSee(dsu, b, 2);
    const party = await seats();
    if (party.guests !== 2) throw new Error('the room should count 2 players, it counts ' + party.guests);
  } finally { dsu.close(); }
});

add('cambio de red del invitado (online) sin recargar', async () => {
  const dsu = await dsuNow();
  try {
    await hostPage(await newContext());
    const guest = await guestPage(await newContext());
    await connected(guest);
    await guest.evaluate(() => dispatchEvent(new Event('online')));
    await sleep(500);
    await connected(guest);
    await pressAndSee(dsu, guest, 1, 8000);
  } finally { dsu.close(); }
});

add('Eden sin leer los mandos UDP: el anfitrión lo dice con palabras', async () => {
  const host = await hostPage(await newContext());
  const guest = await guestPage(await newContext());
  await connected(guest);
  await until(async () => /no está leyendo los mandos UDP \(configurá P2–P4\)/.test(await text(host, '#eden')), 8000, 'host warns Eden is not reading: ' + await text(host, '#eden'));
  const dsu = await dsuNow();
  try {
    await until(async () => /Eden conectado a los mandos/.test(await text(host, '#eden')), 8000, 'host says Eden is connected: ' + await text(host, '#eden'));
    const st = await json('/api/vpad');
    if (st.dsu.clients < 1 || !st.dsu.watching[0]) throw new Error('vpad status: ' + JSON.stringify(st.dsu));
  } finally { dsu.close(); }
});

add('watchdog: canal de controles que nunca abre, se arma solo', async () => {
  const dsu = await dsuNow();
  try {
    await hostPage(await newContext());
    // The first call of this guest never hands its DataChannel to the page.
    const guest = await guestPage(await newContext(), () => { window.__blockChannel = 1; });
    await until(async () => (await guest.evaluate(() => window.__pcs.length)) >= 2, 20000, 'the guest builds the call again by itself');
    await connected(guest);
    await pressAndSee(dsu, guest, 1, 8000);
  } finally { dsu.close(); }
});

add('watchdog: canal abierto pero mudo, el invitado avisa y se rearma', async () => {
  const dsu = await dsuNow();
  try {
    await hostPage(await newContext());
    const guest = await guestPage(await newContext());
    await connected(guest);
    await until(async () => /✓ Tus controles llegan/.test(await text(guest, '#ctl')), 8000, 'controls arrive first');
    await guest.evaluate(() => { window.__mute = true; });
    await until(async () => /⚠️ Tus controles no están llegando, reconectando/.test(await text(guest, '#ctl')), 8000, 'guest warns: ' + await text(guest, '#ctl'));
    await until(async () => (await guest.evaluate(() => window.__pcs.length)) >= 2, 10000, 'the guest builds the call again');
    await guest.evaluate(() => { window.__mute = false; });   // the network is back
    await connected(guest);
    await until(async () => /✓ Tus controles llegan/.test(await text(guest, '#ctl')), 8000, 'controls arrive again: ' + await text(guest, '#ctl'));
    await pressAndSee(dsu, guest, 1, 8000);
  } finally { dsu.close(); }
});

add('número de secuencia atrasado: el host ignoraría todo, el invitado salta solo', async () => {
  const dsu = await dsuNow();
  try {
    await hostPage(await newContext());
    const guest = await guestPage(await newContext());
    await connected(guest);
    await pressAndSee(dsu, guest, 1);
    await guest.evaluate(() => { window.__bump = 1000000; });
    await sleep(1500);
    await guest.evaluate(() => { window.__bump = 0; });   // the numbers fall back below what the host last saw
    await pressAndSee(dsu, guest, 1, 8000);
  } finally { dsu.close(); }
});

add('el anfitrión pierde su conexión con el servidor y se reconecta solo', async () => {
  const dsu = await dsuNow();
  try {
    const host = await hostPage(await newContext());
    const guest = await guestPage(await newContext());
    await connected(guest);
    await pressAndSee(dsu, guest, 1);
    await host.evaluate(() => window.__socks.forEach(s => s.close()));
    await until(async () => /Reconectando/.test(await text(host, '#status')) || !/Conectado/.test(await text(guest, '#status')), 6000, 'the drop is noticed');
    await connected(guest);
    await pressAndSee(dsu, guest, 1, 8000);
  } finally { dsu.close(); }
});

add('pestaña vieja en silencio (BroadcastChannel) y vuelta con el botón', async () => {
  const dsu = await dsuNow();
  try {
    await hostPage(await newContext());
    const ctx = await newContext();
    const a = await guestPage(ctx);
    await connected(a);
    const b = await guestPage(ctx);
    // At once, from the other tab (not after a round trip to the server): picture, sound and controls off.
    await until(() => a.evaluate(() => document.getElementById('quiet').classList.contains('on') && document.getElementById('screen').paused), 1500, 'old tab goes quiet');
    if (await a.evaluate(() => !!(document.getElementById('screen').srcObject && document.getElementById('screen').srcObject.getTracks().length))) throw new Error('the old tab still holds the video');
    if (!/Abriste la sala en otra pestaña/.test(await text(a, '#quiet'))) throw new Error('no reason shown: ' + await text(a, '#quiet'));
    await connected(b);
    await pressAndSee(dsu, b, 1);
    // The way back: the old tab takes over, the new one steps aside.
    await a.locator('#takeover').click();
    await connected(a);
    await until(() => b.evaluate(() => document.getElementById('quiet').classList.contains('on')), 3000, 'new tab goes quiet');
    await a.bringToFront();
    await pressAndSee(dsu, a, 1, 8000);
  } finally { dsu.close(); }
});

add('diagnóstico: el congelamiento del invitado queda en el log del anfitrión', async () => {
  await hostPage(await newContext());
  const guest = await guestPage(await newContext());
  await connected(guest);
  await sleep(2500);   // a couple of readings of the stats first
  await guest.evaluate(() => { window.__fz = { count: 1, sec: 0.32, lost: 14 }; });
  const lines = async () => (await owner('/api/diag', 'diag')).lines.map(l => l.line);
  const line = await until(async () => (await lines()).find(l => /^freeze P2 /.test(l)), 12000, 'a freeze line in the log: ' + JSON.stringify(await lines()));
  if (!/^freeze P2 3\d\dms · lost 14 · jitter 22ms/.test(line) || !/ · limit \w+$/.test(line)) throw new Error('line: ' + line);
  if (!(await lines()).some(l => /^enc P2 /.test(l))) throw new Error('no encoder line: ' + JSON.stringify(await lines()));
  console.log('  log: ' + line);
});

add('biblioteca: la barra de "jugando en la PC" muestra qué aprieta cada amigo y si Eden lee los mandos', async () => {
  await hostPage(await newContext());
  const guest = await guestPage(await newContext());
  await connected(guest);
  // The library thinks a Switch game was opened from RemoteGame (no real emulator here).
  const lib = await (await newContext()).newPage();
  await lib.route('**/api/launch/state', route => route.fulfill({ json: { ok: true, running: true, emulator: 'Eden', name: 'Juego de prueba', system: 'switch', stream: 'on', warnings: [], failed: null } }));
  await lib.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await until(async () => /Jugando Juego de prueba en la PC/.test(await text(lib, '#plTitle')), 8000, 'the bar shows up');
  await until(async () => /no está leyendo los mandos UDP \(configurá P2–P4\)/.test(await text(lib, '#plEden')), 8000, 'bar warns Eden is not reading: ' + await text(lib, '#plEden'));
  const dsu = await dsuNow();
  try {
    await until(async () => /Eden conectado a los mandos/.test(await text(lib, '#plEden')), 8000, 'bar says Eden is connected: ' + await text(lib, '#plEden'));
    await guest.keyboard.down('ArrowUp'); await guest.keyboard.down('KeyZ');
    await until(async () => /P2[\s\S]*↑ A/.test(await text(lib, '#plLights')), 5000, 'P2 lights up with its buttons: ' + await text(lib, '#plLights'));
    await guest.keyboard.up('ArrowUp'); await guest.keyboard.up('KeyZ');
  } finally { dsu.close(); }
});

// ---- Runner.
async function main() {
  await openBrowser();
  for (const c of cases) {
    if (filter && !c.name.includes(filter)) continue;
    const t0 = Date.now();
    await startServer();   // a fresh room each time: seats a closed guest left are held for 15 s
    try { await c.fn(); results.push([c.name, true, Date.now() - t0]); }
    catch (e) { results.push([c.name, false, Date.now() - t0, e.message]); await dump(); }
    for (const ctx of contexts.splice(0)) await ctx.close().catch(() => {});
    stopServer();
    await sleep(300);
  }
}
main().catch(e => { console.error(e); results.push(['e2e', false, 0, e.message]); })
  .finally(async () => {
    for (const ctx of contexts.splice(0)) await ctx.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    stopServer();
    console.log('\nResumen e2e');
    for (const [name, ok, ms, why] of results) console.log((ok ? 'OK    ' : 'FALLA ') + name + ' (' + (ms / 1000).toFixed(1) + ' s)' + (ok ? '' : '\n        ' + why));
    process.exit(results.length && results.every(r => r[1]) ? 0 : 1);
  });
