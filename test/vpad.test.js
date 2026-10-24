const { test } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const zlib = require('node:zlib');
const { createVpad, spawnKeyHelper } = require('../vpad');
const { createRemoteGame } = require('../server');

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Ephemeral port, never the real 26760; no keyboard helper unless a test brings its own.
const newVpad = (extra = {}) => createVpad({ dsuPort: 0, keys: false, ...extra });
const NEUTRAL = { b: 0, x: 0, y: 0, rx: 0, ry: 0 };

// A DSU client written from the protocol text, independent of vpad.js.
function request(type, payload, fix) {
  const buf = Buffer.alloc(20 + payload.length);
  buf.write('DSUC', 0, 'latin1');
  buf.writeUInt16LE(1001, 4);
  buf.writeUInt16LE(payload.length + 4, 6);
  buf.writeUInt32LE(0x12345678, 12);
  buf.writeUInt32LE(type, 16);
  Buffer.from(payload).copy(buf, 20);
  buf.writeUInt32LE(zlib.crc32(buf), 8);
  return fix ? fix(buf) : buf;
}
const versionReq = fix => request(0x100000, [], fix);
const portsReq = slots => { const p = Buffer.alloc(4 + slots.length); p.writeInt32LE(slots.length); slots.forEach((s, i) => { p[4 + i] = s; }); return request(0x100001, p); };
const padReq = (flags, slot, mac = [0, 0, 0, 0, 0, 0]) => request(0x100002, [flags, slot, ...mac]);

async function client(vpad) {
  const sock = dgram.createSocket('udp4');
  sock.packets = [];
  sock.on('message', msg => sock.packets.push(msg));
  sock.bind(0, '127.0.0.1'); await once(sock, 'listening');
  const port = vpad.status().dsu.port;
  sock.ask = buf => sock.send(buf, port, '127.0.0.1');
  // The first packet of this type (and DSU pad) already received or arriving within `ms`.
  sock.next = async (type, pad, ms = 1500) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const i = sock.packets.findIndex(p => p.readUInt32LE(16) === type && (pad === undefined || p[20] === pad));
      if (i >= 0) return sock.packets.splice(i, 1)[0];
      await sleep(3);
    }
    return null;
  };
  return sock;
}
function checkHeader(p, type, payloadLen) {
  assert.equal(p.toString('latin1', 0, 4), 'DSUS');
  assert.equal(p.readUInt16LE(4), 1001);
  assert.equal(p.readUInt16LE(6), payloadLen + 4);
  assert.equal(p.length, 20 + payloadLen);
  assert.equal(p.readUInt32LE(16), type);
  const copy = Buffer.from(p); copy.writeUInt32LE(0, 8);
  assert.equal(zlib.crc32(copy), p.readUInt32LE(8), 'CRC32');
}
// Packet offsets: 20 slot, 21 state, 22 model, 24-29 MAC, 31 connected, 32 counter, 36/37 digital, 40-43 sticks,
// 44-55 analog buttons, 68 motion timestamp, 76-84 accel, 88-96 gyro.
const sticks = p => [p[40], p[41], p[42], p[43]];

test('DSU: version and port info, with header, length and CRC', async () => {
  const v = newVpad(), c = await client(v);
  try {
    assert.equal(v.status().dsu.on, true);
    assert.notEqual(v.status().dsu.port, 26760);
    c.ask(versionReq());
    const ver = await c.next(0x100000);
    checkHeader(ver, 0x100000, 2);
    assert.equal(ver.readUInt16LE(20), 1001);
    v.update(1, NEUTRAL);
    c.ask(portsReq([0, 1, 2, 3]));
    const infos = [];
    for (let i = 0; i < 4; i++) infos.push(await c.next(0x100001, i));
    for (let i = 0; i < 4; i++) {
      checkHeader(infos[i], 0x100001, 12);
      assert.equal(infos[i][20], i, 'slot echoed');
      // DSU pad 0 is the host's own; only seat 1 (P3 = pad 2) is taken.
      assert.equal(infos[i][21], i === 2 ? 2 : 0, 'state of pad ' + i);
      assert.equal(infos[i][31], 0, 'trailing zero byte');
    }
    assert.equal(infos[2][22], 2, 'full gyro model');
    assert.deepEqual([...infos[2].subarray(24, 30)], [0x52, 0x47, 0, 0, 0, 2], 'MAC');
    assert.deepEqual([...infos[0].subarray(21, 31)], new Array(10).fill(0), 'pad 0 is blank');
  } finally { c.close(); await v.close(); }
});

test('DSU: a subscriber gets pad data with the right bits and sticks; pad 0 never; release disconnects', async () => {
  const v = newVpad(), c = await client(v);
  try {
    c.ask(padReq(0, 0));
    await sleep(60);
    assert.equal(c.packets.filter(p => p.readUInt32LE(16) === 0x100002).length, 0, 'nothing to send while no guest is in');
    assert.equal(v.status().dsu.clients, 1);
    // Every RetroPad button and the four D-pad directions: B(down) A(right) Y(left) X(up) Select Start L R L2 R2 L3 R3
    const all = (1 << 0) | (1 << 8) | (1 << 1) | (1 << 9) | (1 << 3) | (1 << 2) | (1 << 10) | (1 << 11) | (1 << 12) | (1 << 13) | (1 << 14) | (1 << 15) | (0xf << 4);
    v.update(0, { b: all, x: -127, y: 127, rx: 127, ry: -127 });
    const p = await c.next(0x100002, 1);
    assert.ok(p, 'seat 0 (P2) is DSU pad 1');
    checkHeader(p, 0x100002, 80);
    assert.equal(p.length, 100);
    assert.equal(p[21], 2, 'state connected');
    assert.equal(p[31], 1, 'connected flag');
    assert.equal(p[36], 0xff, 'dpad, options, r3, l3, share');
    assert.equal(p[37], 0xff, 'square, cross, circle, triangle, r1, l1, r2, l2');
    // Left stick left+down, right stick right+up. DSU Y is 255 = up, so down reads 1.
    assert.deepEqual(sticks(p), [1, 1, 255, 255]);
    assert.deepEqual([...p.subarray(44, 56)], new Array(12).fill(255), 'analog buttons');
    assert.ok(p.readBigUInt64LE(68) >= 0n, 'timestamp');
    // No movement, gravity on Y (Eden reads its own accel Z from it, and "face up" is -1)
    assert.deepEqual([76, 80, 84, 88, 92, 96].map(o => p.readFloatLE(o)), [0, -1, 0, 0, 0, 0]);

    // Only A (right) + Start + up, sticks back to the middle
    v.update(0, { b: (1 << 8) | (1 << 3) | (1 << 4), x: 0, y: 0, rx: 0, ry: 0 });
    await sleep(40);
    c.packets.length = 0;
    const q = await c.next(0x100002, 1);
    assert.equal(q[36], 0x08 | 0x10, 'options + dpad up');
    assert.equal(q[37], 0x20, 'circle only');
    assert.deepEqual(sticks(q), [128, 128, 128, 128]);
    assert.deepEqual([...q.subarray(44, 56)], [0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 0], 'analog: dpad up and circle');
    // Counters only go up
    await sleep(40);
    const counters = c.packets.filter(x => x[20] === 1).map(x => x.readUInt32LE(32));
    assert.ok(counters.length >= 2);
    for (let i = 1; i < counters.length; i++) assert.ok(counters[i] > counters[i - 1], 'counter rises');
    assert.equal(c.packets.filter(x => x[20] === 0).length, 0, 'pad 0 stays silent');
    assert.equal(v.status().slots[0].connected, true);

    // Release: one stale packet (same counter, flagged disconnected), then silence
    await sleep(30);
    c.packets.length = 0;
    await sleep(40);
    v.release(0);
    await sleep(80);
    const after = c.packets.filter(x => x[20] === 1);
    const last = after[after.length - 1];
    assert.equal(last[31], 0, 'connected flag cleared');
    assert.equal(last[21], 0, 'state disconnected');
    assert.equal(last.readUInt32LE(32), after[after.length - 2].readUInt32LE(32), 'counter repeated so Eden drops the pad');
    c.packets.length = 0;
    await sleep(80);
    assert.equal(c.packets.length, 0, 'nothing more once it is gone');
    assert.equal(v.status().slots[0].connected, false);
  } finally { c.close(); await v.close(); }
});

test('DSU: subscribe by slot and by MAC', async () => {
  const v = newVpad(), a = await client(v), b = await client(v);
  try {
    a.ask(padReq(1, 2));                               // slot 2 = seat 1
    b.ask(padReq(2, 0, [0x52, 0x47, 0, 0, 0, 3]));     // MAC of pad 3 = seat 2
    await sleep(40);
    v.update(0, { ...NEUTRAL, b: 1 }); v.update(1, { ...NEUTRAL, b: 1 }); v.update(2, { ...NEUTRAL, b: 1 });
    await sleep(80);
    assert.deepEqual([...new Set(a.packets.map(p => p[20]))], [2]);
    assert.deepEqual([...new Set(b.packets.map(p => p[20]))], [3]);
  } finally { a.close(); b.close(); await v.close(); }
});

test('DSU: a client that stops asking expires', async () => {
  const v = newVpad({ dsuTtl: 250 }), c = await client(v);
  try {
    c.ask(padReq(0, 0));
    await sleep(30);
    v.update(0, NEUTRAL);
    assert.ok(await c.next(0x100002, 1), 'gets data while subscribed');
    await sleep(350);
    assert.equal(v.status().dsu.clients, 0);
    c.packets.length = 0;
    v.update(0, { ...NEUTRAL, b: 1 });
    await sleep(80);
    assert.equal(c.packets.length, 0, 'no data after the timeout');
    c.ask(padReq(0, 0));                               // asking again brings it back
    assert.ok(await c.next(0x100002, 1));
    assert.equal(v.status().dsu.clients, 1);
  } finally { c.close(); await v.close(); }
});

test('DSU: packets with a bad CRC, magic or version are ignored', async () => {
  const v = newVpad(), c = await client(v);
  try {
    c.ask(versionReq(buf => { buf[8] ^= 0xff; return buf; }));
    c.ask(versionReq(buf => { buf.write('DSUS', 0, 'latin1'); buf.writeUInt32LE(0, 8); buf.writeUInt32LE(zlib.crc32(buf), 8); return buf; }));
    c.ask(versionReq(buf => { buf.writeUInt16LE(1002, 4); buf.writeUInt32LE(0, 8); buf.writeUInt32LE(zlib.crc32(buf), 8); return buf; }));
    c.ask(Buffer.from('DSUC'));
    c.ask(padReq(0, 0, [0, 0, 0, 0, 0, 0]).subarray(0, 24));   // cut short
    await sleep(100);
    assert.equal(c.packets.length, 0);
    assert.equal(v.status().dsu.clients, 0);
    c.ask(versionReq());
    assert.ok(await c.next(0x100000), 'a good one still works');
  } finally { c.close(); await v.close(); }
});

test('DSU: a taken port is reported and nothing breaks; the port is freed on close', async () => {
  const first = newVpad();
  for (let i = 0; i < 100 && !first.status().dsu.on; i++) await sleep(5);
  const port = first.status().dsu.port;
  assert.ok(port > 0 && port !== 26760);
  const second = createVpad({ dsuPort: port, keys: false, dsuRetry: 100 });
  try {
    for (let i = 0; i < 100 && !second.status().dsu.error; i++) await sleep(10);
    const st = second.status();
    assert.equal(st.dsu.on, false);
    assert.match(st.dsu.error, /ocupado/);
    second.update(0, NEUTRAL); second.release(0);      // still safe to call
    await first.close();                               // frees the port: the retry then takes it
    for (let i = 0; i < 100 && !second.status().dsu.on; i++) await sleep(20);
    assert.equal(second.status().dsu.on, true);
    assert.equal(second.status().dsu.error, null);
  } finally { await first.close(); await second.close(); }
  const again = createVpad({ dsuPort: port, keys: false });   // free after close
  for (let i = 0; i < 100 && !again.status().dsu.on; i++) await sleep(10);
  assert.equal(again.status().dsu.on, true);
  await again.close();
});

// A fake keyboard helper: records the orders instead of running PowerShell.
function fakeHelper() {
  const f = { launches: 0, lines: [], closed: 0, targets: null };
  f.make = (targets, onLine, onExit) => { f.launches++; f.targets = targets; f.onLine = onLine; f.onExit = onExit; return { send: l => f.lines.push(l), close: () => { f.closed++; return Promise.resolve(); } }; };
  f.orders = () => f.lines.filter(l => l !== 'p');      // "p" is the helper's periodic look
  f.take = () => { const o = f.orders(); f.lines.length = 0; return o; };
  return f;
}
const bit = (...n) => n.reduce((m, i) => m | 1 << i, 0);

test('keys: the helper starts with the first update, not before', async () => {
  const h = fakeHelper();
  const v = createVpad({ dsuPort: 0, keyHelper: h.make, keyTargets: ['mame.exe', 'Flycast.exe'] });
  try {
    assert.equal(h.launches, 0);
    assert.deepEqual(v.status().keys, { on: true, targets: ['mame.exe', 'flycast.exe'], error: null });
    v.update(0, NEUTRAL);
    assert.equal(h.launches, 1);
    assert.deepEqual(h.targets, ['mame.exe', 'flycast.exe']);
    v.update(1, NEUTRAL);
    assert.equal(h.launches, 1);
  } finally { await v.close(); }
});

test('keys: RetroPad buttons and sticks become each player\'s MAME keys, sent only when they change', async () => {
  const h = fakeHelper();
  const v = createVpad({ dsuPort: 0, keyHelper: h.make });
  try {
    // P2 (seat 0): B -> button 1 (A key = scancode 30), A -> 2 (S = 31), up (R = 19), Start (2 = 3), Select -> coin (6 = 7)
    v.update(0, { ...NEUTRAL, b: bit(0, 8, 4, 3, 2) });
    assert.deepEqual(h.take().sort(), ['d 3 0', 'd 7 0', 'd 19 0', 'd 30 0', 'd 31 0'].sort());
    v.update(0, { ...NEUTRAL, b: bit(0, 8, 4, 3, 2) });
    assert.deepEqual(h.take(), [], 'same state sends nothing');
    // Drop A and Select, add Y (3 = Q 16), X (4 = W 17), L (5 = E 18); R has no default key on P2
    v.update(0, { ...NEUTRAL, b: bit(0, 1, 9, 10, 11, 4, 3) });
    assert.deepEqual(h.take().sort(), ['d 16 0', 'd 17 0', 'd 18 0', 'u 31 0', 'u 7 0'].sort());
    // Left stick past +-64 is the direction; D-pad up is still held, so it only adds
    v.update(0, { ...NEUTRAL, b: bit(0, 1, 9, 10, 11, 4, 3), x: -70, y: 63 });
    assert.deepEqual(h.take(), ['d 32 0'], 'left = D (32); y 63 is below the threshold');
    v.update(0, { ...NEUTRAL, b: bit(0, 1, 9, 10, 11, 4, 3), x: 64, y: 100 });
    assert.deepEqual(h.take().sort(), ['d 34 0', 'd 33 0', 'u 32 0'].sort(), 'right = G (34), down = F (33)');
    // P3 (seat 1): Right Ctrl is extended, Enter is not; I K J L
    v.update(1, { ...NEUTRAL, b: bit(0, 8, 1, 6, 7, 3, 2) });
    assert.deepEqual(h.take().sort(), ['d 29 1', 'd 54 0', 'd 28 0', 'd 36 0', 'd 38 0', 'd 4 0', 'd 8 0'].sort());
    // P4 (seat 2): keypad 8 2 4 6, keypad 0 . Enter (extended), 4, coin 8
    v.update(2, { ...NEUTRAL, b: bit(0, 8, 1, 4, 5, 6, 7, 3, 2) });
    assert.deepEqual(h.take().sort(), ['d 82 0', 'd 83 0', 'd 28 1', 'd 72 0', 'd 80 0', 'd 75 0', 'd 77 0', 'd 5 0', 'd 9 0'].sort());
    // Buttons with no default key (L2, R2, L3, R3, and L/R on P3) press nothing
    v.update(1, { ...NEUTRAL, b: bit(12, 13, 14, 15, 10, 11) });
    assert.deepEqual(h.take().sort(), ['u 29 1', 'u 54 0', 'u 28 0', 'u 36 0', 'u 38 0', 'u 4 0', 'u 8 0'].sort());
  } finally { await v.close(); }
});

test('keys: release lets go of one seat, releaseAll and close of everything', async () => {
  const h = fakeHelper();
  const v = createVpad({ dsuPort: 0, keyHelper: h.make });
  try {
    v.update(0, { ...NEUTRAL, b: bit(0, 4) });
    v.update(1, { ...NEUTRAL, b: bit(0) });
    h.take();
    v.release(0);
    assert.deepEqual(h.take().sort(), ['u 19 0', 'u 30 0']);
    v.release(0);
    assert.deepEqual(h.take(), [], 'nothing left to release');
    v.update(0, { ...NEUTRAL, b: bit(8) });
    h.take();
    v.releaseAll();
    assert.deepEqual(h.take().sort(), ['u 29 1', 'u 31 0'].sort());
    assert.equal(v.status().slots.every(s => !s.connected), true);
    v.update(2, { ...NEUTRAL, b: bit(0) });
    h.take();
  } finally { await v.close(); }
  assert.deepEqual(h.take(), ['u 82 0'], 'close lets go of what was down');
  assert.equal(h.closed, 1);
});

test('keys: a helper that fails is reported and nothing else stops', async () => {
  const h = fakeHelper();
  const v = createVpad({ dsuPort: 0, keyHelper: h.make });
  try {
    v.update(0, { ...NEUTRAL, b: bit(0) });
    h.onLine('err Add-Type: no se pudo compilar');
    assert.deepEqual(v.status().keys, { on: false, targets: ['mame.exe'], error: 'Add-Type: no se pudo compilar' });
    v.update(0, { ...NEUTRAL, b: bit(0, 8) });          // keeps working (DSU) without throwing
    assert.equal(h.launches, 1, 'not relaunched right away');
    assert.equal(v.status().slots[0].b, bit(0, 8));
  } finally { await v.close(); }
  const missing = createVpad({ dsuPort: 0, keyHelper: (t, onLine, onExit) => { setImmediate(() => onExit('No encontré PowerShell')); return { send() {}, close: async () => {} }; } });
  try {
    missing.update(0, NEUTRAL);
    await sleep(20);
    assert.equal(missing.status().keys.on, false);
    assert.equal(missing.status().keys.error, 'No encontré PowerShell');
  } finally { await missing.close(); }
});

test('keys: off without a helper to run (not Windows, or keys: false)', async () => {
  const v = createVpad({ dsuPort: 0, keys: false });
  try {
    v.update(0, { ...NEUTRAL, b: 1 });
    assert.equal(v.status().keys.on, false);
    assert.equal(v.status().keys.error, null);
  } finally { await v.close(); }
});

test('input is validated: bad seats and garbage values are ignored or clamped', async () => {
  const v = newVpad();
  try {
    for (const s of [-1, 3, 1.5, '0', null, undefined]) v.update(s, { ...NEUTRAL, b: 1 });
    v.update(0, null); v.release(7); v.release('x');
    assert.equal(v.status().slots.some(s => s.connected), false);
    v.update(0, { b: 0x1ffff, x: 9999, y: -9999, rx: 'a', ry: NaN });
    assert.deepEqual(v.status().slots[0], { slot: 0, connected: true, b: 0xffff, x: 127, y: -127, rx: 0, ry: 0 });
  } finally { await v.close(); }
});

test('GET /api/vpad: status for this PC, 403 from the tunnel; the server closes its vpad', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'remotegame-vpad-'));
  const vpad = newVpad();
  const game = createRemoteGame({ libretro: false, gamesRoot: temp, localRoms: path.join(temp, 'uploads'), launchBoxDir: path.join(temp, 'none'), settingsFile: path.join(temp, 'settings.json'), vpad });
  try {
    assert.equal(game.vpad, vpad);
    game.server.listen(0, '127.0.0.1'); await once(game.server, 'listening');
    const url = 'http://127.0.0.1:' + game.server.address().port + '/api/vpad';
    const ok = await fetch(url);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.dsu.on, true);
    assert.equal(body.dsu.port, vpad.status().dsu.port);
    assert.equal(body.slots.length, 3);
    assert.deepEqual(Object.keys(body.keys).sort(), ['error', 'on', 'targets']);
    assert.equal((await fetch(url, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 403);
  } finally {
    await game.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  assert.equal(vpad.status().dsu.on, false, 'close() closed the socket');
});

test('server: without an injected vpad it builds its own, off the real port under tests', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'remotegame-vpad-'));
  const game = createRemoteGame({ libretro: false, gamesRoot: temp, localRoms: path.join(temp, 'uploads'), launchBoxDir: path.join(temp, 'none'), settingsFile: path.join(temp, 'settings.json') });
  try {
    await sleep(50);
    const st = game.vpad.status();
    assert.equal(st.dsu.on, true);
    assert.notEqual(st.dsu.port, 26760);
    assert.equal(st.keys.on, false, 'no PowerShell under tests');
  } finally {
    await game.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('keys helper: the real PowerShell compiles SendInput and answers "status" without pressing anything', { skip: process.platform !== 'win32' && 'solo Windows', timeout: 60000 }, async () => {
  const lines = [], waiters = [];
  const onLine = l => { lines.push(l); waiters.splice(0).forEach(w => w()); };
  const waitFor = async re => { const end = Date.now() + 30000; while (Date.now() < end) { const l = lines.find(x => re.test(x)); if (l) return l; await new Promise(r => { waiters.push(r); setTimeout(r, 100); }); } throw new Error('sin respuesta: ' + lines.join(' | ')); };
  let exit;
  // A target that does not exist: even if "d" arrives, nothing may be pressed.
  const helper = spawnKeyHelper(['rg-no-such-program.exe'], onLine, err => { exit = err; });
  try {
    helper.send('d 30 0');                              // sent before it is ready: held back, not lost
    helper.send('d 28 1');
    assert.equal(await waitFor(/^(ready|err )/), 'ready');
    helper.send('s');
    const st = await waitFor(/^status /);
    assert.match(st, /allowed=0 want=2 held=0$/, st);
    helper.send('r');
    helper.send('s');
    await waitFor(/^status .* want=0 held=0$/);
  } finally {
    await helper.close();
  }
  assert.ok(lines.includes('bye'));
  assert.equal(exit ?? null, null);
});
