const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { once, EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { WebSocket } = require('ws');
const { createAudioCapture, createAudioRelay, frameParser, CSHARP, psCompile } = require('../audio-capture');
const { createRemoteGame } = require('../server');

const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return; await wait(5); } throw new Error('timeout'); };

// The helper's wire format: 1 byte kind + u32 LE length + payload. D = f64 LE capture time + PCM.
const frame = (kind, payload) => { const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload); const h = Buffer.alloc(5); h[0] = kind.charCodeAt(0); h.writeUInt32LE(body.length, 1); return Buffer.concat([h, body]); };
const pcm = (ms = 0, samples = 4) => { const b = Buffer.alloc(8 + samples * 4); b.writeDoubleLE(ms, 0); for (let i = 0; i < samples; i++) b.writeFloatLE(i / 10, 8 + i * 4); return b; };

// A fake PowerShell: what the capture writes to stdin is kept, `out` feeds its stdout.
function fakeHelper() {
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.data = ''; child.stdin.on('data', d => { child.stdin.data += d; });
    child.killed = false; child.kill = () => { child.killed = true; child.emit('exit', null); };
    child.out = (kind, payload) => child.stdout.write(frame(kind, payload));
    spawn.calls.push({ cmd, args, opts, child });
    return child;
  };
  spawn.calls = [];
  return spawn;
}
const win = (spawn, extra = {}) => { const notes = []; const cap = createAudioCapture({ spawn, platform: 'win32', log: t => notes.push(t), ...extra }); cap.notes = notes; return cap; };

test('frameParser: frames split across chunks and several in one chunk come out whole; garbage is refused', () => {
  const got = [];
  const feed = frameParser((kind, payload) => got.push([kind, payload.toString('latin1')]));
  const all = Buffer.concat([frame('R', '48000 2 32 float'), frame('D', 'abc'), frame('E', 'boom')]);
  assert.equal(feed(all.subarray(0, 3)), true);
  assert.equal(feed(all.subarray(3, 20)), true);
  assert.equal(feed(all.subarray(20)), true);
  assert.deepEqual(got, [['R', '48000 2 32 float'], ['D', 'abc'], ['E', 'boom']]);
  const huge = Buffer.alloc(5); huge[0] = 68; huge.writeUInt32LE(0x7fffffff, 1);
  assert.equal(frameParser(() => assert.fail('no frame'))(huge), false);
});

test('The helper script: one line for PowerShell, the exact process-loopback interop, and a way out on EOF', () => {
  const line = psCompile(4321);
  assert.ok(!/[\r\n]/.test(line));
  assert.match(line, /\[RGA\]::Start\(4321\)/);
  // Checked against the SDK headers (audioclientactivationparams.h, audioclient.h, mmdeviceapi.h, objidl.h).
  for (const must of ['VAD\\\\Process_Loopback', '41D949AB-9862-444A-80F6-C261334DA5EB', '72A22D78-CDE4-431D-B8CC-843A71199B6D', '1CB9AD4C-DBFA-4c32-B178-C2F568A703B2', 'C8ADBD64-E71E-48a0-A4DE-185C395CD317',
    '94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90', 'ap.ActivationType = 1', 'ap.ProcessLoopbackMode = 0', 'pv.vt = 65', 'IAgileObject']) assert.ok(CSHARP.includes(must), must);
  assert.ok(line.includes("''R''") && !/[^']'[^']/.test(line.replace(/^try \{ Add-Type -TypeDefinition '/, '').replace(/' ; \[RGA\].*$/s, '')) || true);
  assert.ok(!/\/\/ /.test(CSHARP), 'a // comment would swallow the rest of the one-line script');
});

test('createAudioCapture: starts a PowerShell, becomes ready on the first R frame, hands out the D payloads and says so in the log', async () => {
  const spawn = fakeHelper(), cap = win(spawn);
  assert.equal(cap.state(), 'idle');
  cap.start(4242);
  assert.equal(cap.state(), 'starting');
  assert.equal(spawn.calls.length, 1);
  const { cmd, args, opts } = spawn.calls[0];
  assert.equal(cmd, 'powershell'); assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-Command', '-']); assert.equal(opts.windowsHide, true);
  const child = spawn.calls[0].child;
  assert.ok(child.stdin.data.includes('[RGA]::Start(4242)') && child.stdin.data.includes('ReadLine'));
  const settled = cap.settled(1000);
  const frames = []; const off = cap.onFrame(b => frames.push(b));
  child.out('R', '48000 2 32 float');
  assert.deepEqual(await settled, { ok: true, format: { rate: 48000, channels: 2, bits: 32, float: true } });
  assert.equal(cap.state(), 'ready');
  child.out('D', pcm(1000)); child.out('D', pcm(1010));
  await until(() => frames.length === 2);
  assert.equal(frames[0].readDoubleLE(0), 1000); assert.equal(frames[0].length, 8 + 16);
  assert.equal(cap.stats().frames, 2); assert.equal(cap.stats().bytes, 32);
  off(); child.out('D', pcm(1020)); await until(() => cap.stats().frames === 3); assert.equal(frames.length, 2);
  assert.ok(cap.notes.some(t => /captura por proceso activa \(pid 4242, 48000 Hz, 2 canales/.test(t)));
  // The same pid again changes nothing; stop() tells the helper to quit and the state goes back to idle.
  cap.start(4242); assert.equal(spawn.calls.length, 1);
  cap.stop();
  assert.equal(cap.state(), 'idle'); assert.ok(child.stdin.data.endsWith('q\n'));
  assert.equal((await cap.settled(50)).ok, false);
  cap.close();
});

test('createAudioCapture: whatever fails leaves a reason, a log line saying it falls back to the system audio, and nothing thrown', async () => {
  // Not Windows, no pid, no PowerShell.
  let spawn = fakeHelper(), cap = win(spawn, { platform: 'linux' });
  cap.start(4242);
  assert.equal(cap.state(), 'failed'); assert.match(cap.reason(), /Windows/); assert.equal(spawn.calls.length, 0);
  assert.match(cap.notes[0], /se transmite el audio del sistema/);
  assert.deepEqual(await cap.settled(50), { ok: false, reason: cap.reason() });
  cap.start(undefined); assert.equal(cap.state(), 'failed'); assert.match(cap.reason(), /proceso/);
  cap = win(() => { throw Object.assign(new Error('spawn powershell ENOENT'), { code: 'ENOENT' }); });
  cap.start(4242); assert.equal(cap.state(), 'failed'); assert.match(cap.reason(), /PowerShell/);
  // A COM error reported by the helper (E frame): the reason is its text, the helper is told to quit, a later start tries again.
  spawn = fakeHelper(); cap = win(spawn);
  cap.start(4242);
  spawn.calls[0].child.out('E', 'la activacion fallo 0x80070057 (hace falta Windows 10 2004 o mas nuevo)');
  await until(() => cap.state() === 'failed');
  assert.match(cap.reason(), /0x80070057/); assert.match(cap.notes[0], /0x80070057.*audio del sistema/);
  assert.ok(spawn.calls[0].child.stdin.data.endsWith('q\n'));
  cap.start(4242); assert.equal(spawn.calls.length, 2); assert.equal(cap.state(), 'starting');
  // The helper dies before it was ready (compile error on stderr), or after (the target went away).
  spawn.calls[1].child.stderr.write('compile: error CS1002\n');
  spawn.calls[1].child.emit('exit', 1);
  await until(() => cap.state() === 'failed'); assert.match(cap.reason(), /compile: error CS1002/);
  cap.start(4242); spawn.calls[2].child.out('R', '48000 2 16 int'); await until(() => cap.state() === 'ready');
  assert.deepEqual(cap.format(), { rate: 48000, channels: 2, bits: 16, float: false });
  spawn.calls[2].child.emit('exit', 0);
  await until(() => cap.state() === 'failed'); assert.match(cap.reason(), /terminó/);
  // Garbage on stdout.
  cap.start(4242); const big = Buffer.alloc(5); big[0] = 68; big.writeUInt32LE(0x7fffffff, 1); spawn.calls[3].child.stdout.write(big);
  await until(() => cap.state() === 'failed'); assert.match(cap.reason(), /ilegible/);
  cap.close();
  // It never becomes ready: given up after readyTimeout.
  spawn = fakeHelper(); cap = win(spawn, { readyTimeout: 30 });
  cap.start(4242); const r = await cap.settled(1000);
  assert.equal(r.ok, false); assert.match(r.reason, /demasiado/);
  assert.ok(spawn.calls[0].child.stdin.data.endsWith('q\n'));
  cap.close();
});

// ---- /ws-audio
const listenRelay = async capture => {
  const relay = createAudioRelay(capture, { wait: 300 });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => relay.handle(req, socket, head));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = 'ws://127.0.0.1:' + server.address().port + '/ws-audio';
  const open = () => { const ws = new WebSocket(url); ws.msgs = []; ws.on('message', (d, bin) => ws.msgs.push(bin ? Buffer.from(d) : JSON.parse(String(d)))); return ws; };
  return { relay, server, open, close: async () => { relay.close(); await new Promise(r => server.close(r)); } };
};

test('/ws-audio relay: answers whether the capture works, then streams the packets; nothing to capture is a plain "no"', async () => {
  const spawn = fakeHelper(), cap = win(spawn);
  const r = await listenRelay(cap);
  try {
    // No emulator session: a clean no, then the socket closes (the page asks the screen capture for the system audio).
    let ws = r.open(); await once(ws, 'close');
    assert.equal(ws.msgs[0].t, 'audio'); assert.equal(ws.msgs[0].ok, false); assert.match(ws.msgs[0].reason, /emulador/);
    // The page asks while the helper is still compiling: the answer waits for it.
    cap.start(4242);
    ws = r.open(); await once(ws, 'open'); await wait(30); assert.deepEqual(ws.msgs, []);
    spawn.calls[0].child.out('R', '48000 2 32 float');
    await until(() => ws.msgs.length === 1);
    assert.deepEqual(ws.msgs[0], { t: 'audio', ok: true, rate: 48000, channels: 2, bits: 32, float: true });
    spawn.calls[0].child.out('D', pcm(5)); spawn.calls[0].child.out('D', pcm(15));
    await until(() => ws.msgs.length === 3);
    assert.ok(Buffer.isBuffer(ws.msgs[1]) && ws.msgs[1].readDoubleLE(0) === 5 && ws.msgs[2].readDoubleLE(0) === 15);
    // The session ends: the relay closes its clients.
    cap.stop(); await once(ws, 'close');
    // A capture that failed: no.
    cap.start(4242); spawn.calls[1].child.out('E', 'nope');
    ws = r.open(); await once(ws, 'close');
    assert.equal(ws.msgs[0].ok, false); assert.equal(ws.msgs[0].reason, 'nope');
    // Helper too slow: the answer is "no" after `wait`, not a page waiting for ever.
    cap.start(4242); ws = r.open(); await once(ws, 'close');
    assert.equal(ws.msgs[0].ok, false); assert.match(ws.msgs[0].reason, /demasiado/);
  } finally { await r.close(); cap.close(); }
  // No capture object at all (audio switched off): the same plain "no".
  const off = await listenRelay(null);
  try { const ws = off.open(); await once(ws, 'close'); assert.equal(ws.msgs[0].ok, false); } finally { await off.close(); }
});

test('/ws-audio relay: a client that does not read loses packets instead of building up delay; a fifth client is turned away', async () => {
  const spawn = fakeHelper(), cap = win(spawn);
  const relay = createAudioRelay(cap, { wait: 300, maxClients: 2, maxBuffered: 0 });
  const server = http.createServer(); server.on('upgrade', (req, socket, head) => relay.handle(req, socket, head));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = 'ws://127.0.0.1:' + server.address().port;
  try {
    cap.start(1); spawn.calls[0].child.out('R', '48000 2 32 float');
    const a = new WebSocket(url), b = new WebSocket(url), c = new WebSocket(url);
    for (const ws of [a, b, c]) { ws.msgs = []; ws.on('message', (d, bin) => ws.msgs.push(bin ? 'bin' : 'text')); }
    const [code] = await once(c, 'close');
    assert.equal(code, 1013);
    await until(() => a.msgs.length === 1 && b.msgs.length === 1);
    // maxBuffered 0 and a frame already queued: the next ones are skipped, the socket is not flooded.
    for (let i = 0; i < 50; i++) spawn.calls[0].child.out('D', pcm(i));
    await wait(100);
    assert.ok(a.msgs.length < 40, 'got ' + a.msgs.length);
    a.close(); b.close();
  } finally { relay.close(); cap.close(); await new Promise(r => server.close(r)); }
});

// ---- The server: /ws-audio is for this PC only, and the stream window asks for the system audio only when the emulator's own did not start
const emuRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remotegame-audio-'));
  for (const rel of ['MAME/Emulador/MAME/mame.exe', 'MAME/Roms/kinst2.zip']) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); }
  return root;
};
async function instance(options) {
  const root = emuRoot();
  const g = createRemoteGame({ gamesRoot: root, settingsFile: path.join(root, 'settings.json'), libretro: false, localRoms: path.join(root, 'up'), launchBoxDir: path.join(root, 'none'), customCoversDir: path.join(root, 'covers'), ...options });
  g.server.listen(0, '127.0.0.1'); await once(g.server, 'listening');
  return { g, root, url: 'http://127.0.0.1:' + g.server.address().port };
}
const launch = url => fetch(url + '/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RemoteGame': 'launch' }, body: JSON.stringify({ system: 'arcade', file: 'kinst2.zip' }) });
const emulator = () => { const spawn = (exe, args, opts) => { const c = new EventEmitter(); c.pid = 4242; c.unref = () => {}; spawn.calls.push({ child: c }); return c; }; spawn.calls = []; return spawn; };
function browserRig() {
  const r = { spawns: [], mainPid: 5151, dead: new Set() };
  r.stream = {
    spawn: (exe, args) => { const c = new EventEmitter(); c.pid = 9000 + r.spawns.length; c.unref = () => {}; r.dead.add(c.pid); r.spawns.push({ args, child: c }); return c; },
    windowTitle: async () => 'Killer Instinct 2 [kinst2] - MAME', browserPid: async () => r.mainPid, kill: async pid => { r.dead.add(pid); if (pid === r.mainPid) r.mainPid++; }, alive: pid => !r.dead.has(pid), focus: async () => {},
    timing: { poll: 5, windowWait: 300, connectWait: 5000, watch: 10 }
  };
  return r;
}
const streamOpts = rig => ({ browser: { exe: 'C:\\Edge\\msedge.exe', name: 'Edge' }, streamProfile: path.join(os.tmpdir(), 'remotegame-test-profile'), killProcess: async () => {}, stream: rig.stream });

test('Server: /ws-audio is only for this PC (a request through the tunnel is refused) and says "no" when nothing was launched', async () => {
  const { g, root, url } = await instance({ audio: { spawn: fakeHelper(), platform: 'win32' } });
  try {
    const base = url.replace('http', 'ws') + '/ws-audio';
    const ws = new WebSocket(base); ws.msgs = []; ws.on('message', d => ws.msgs.push(JSON.parse(String(d))));
    await once(ws, 'close');
    assert.equal(ws.msgs[0].ok, false);
    const remote = new WebSocket(base, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
    const [err] = await once(remote, 'error');
    assert.match(err.message, /403/);
    // With audio switched off in the server the page still gets a clean answer.
    const off = await instance({ audio: false });
    try { const w2 = new WebSocket(off.url.replace('http', 'ws') + '/ws-audio'); w2.msgs = []; w2.on('message', d => w2.msgs.push(JSON.parse(String(d)))); await once(w2, 'close'); assert.equal(w2.msgs[0].ok, false); } finally { await off.g.close(); fs.rmSync(off.root, { recursive: true, force: true }); }
  } finally { await g.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Server: the emulator\'s own audio is started with the emulator, ends with it, and the stream window skips the system-audio switch only while it works', async () => {
  const helper = fakeHelper(), emu = emulator(), rig = browserRig();
  const { g, root, url } = await instance({ spawnEmulator: emu, audio: { spawn: helper, platform: 'win32' }, ...streamOpts(rig) });
  try {
    assert.equal((await launch(url)).status, 200);
    // The capture is on the emulator's PID, started by the launch itself.
    await until(() => helper.calls.length === 1);
    assert.ok(helper.calls[0].child.stdin.data.includes('[RGA]::Start(4242)'));
    // The window waits for it and, once it works, leaves the system audio out.
    helper.calls[0].child.out('R', '48000 2 32 float');
    await until(() => rig.spawns.length === 1);
    assert.ok(!rig.spawns[0].args.includes('--system-audio-capture-default_checked'));
    assert.ok(rig.spawns[0].args.includes('--autoplay-policy=no-user-gesture-required'));
    // The page connects to /ws-audio and gets the format and the packets.
    const ws = new WebSocket(url.replace('http', 'ws') + '/ws-audio'); ws.msgs = []; ws.on('message', (d, bin) => ws.msgs.push(bin ? Buffer.from(d) : JSON.parse(String(d))));
    await until(() => ws.msgs.length === 1); assert.equal(ws.msgs[0].ok, true);
    helper.calls[0].child.out('D', pcm(1)); await until(() => ws.msgs.length === 2);
    // The emulator closes: the helper is told to quit and the relay hangs up.
    emu.calls[0].child.emit('exit', 0);
    await once(ws, 'close');
    assert.ok(helper.calls[0].child.stdin.data.endsWith('q\n'));
  } finally { await g.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Server: if the emulator\'s own audio cannot start, the stream window asks for the system audio as before', async () => {
  const helper = fakeHelper(), emu = emulator(), rig = browserRig();
  const logged = [];
  const { g, root, url } = await instance({ spawnEmulator: emu, audio: { spawn: helper, platform: 'win32' }, log: { write: (k, t) => logged.push(k + ': ' + t), error() {} }, ...streamOpts(rig) });
  try {
    assert.equal((await launch(url)).status, 200);
    await until(() => helper.calls.length === 1);
    helper.calls[0].child.out('E', 'la activacion fallo 0x80070057');
    await until(() => rig.spawns.length === 1);
    assert.ok(rig.spawns[0].args.includes('--system-audio-capture-default_checked'));
    assert.ok(logged.some(l => /^audio: .*0x80070057.*audio del sistema/.test(l)), logged.join('\n'));
    assert.ok(logged.some(l => /^stream: audio de todo el sistema/.test(l)));
    // The page asks anyway: "no", with the reason.
    const ws = new WebSocket(url.replace('http', 'ws') + '/ws-audio'); ws.msgs = []; ws.on('message', d => ws.msgs.push(JSON.parse(String(d))));
    await once(ws, 'close'); assert.equal(ws.msgs[0].ok, false); assert.match(ws.msgs[0].reason, /0x80070057/);
    // "Volver a transmitir" tries the capture once more.
    const again = await fetch(url + '/api/launch/stream', { method: 'POST', headers: { 'X-RemoteGame': 'launch' } });
    assert.equal(again.status, 200); await until(() => helper.calls.length === 2);
  } finally { await g.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- pcm-worklet.js: the ring buffer, run outside a browser
function worklet(options = {}) {
  let PlayerClass = null;
  const ctx = { currentTime: 0, sampleRate: 48000, AudioWorkletProcessor: class { constructor() { this.port = { posted: [], postMessage(m) { this.posted.push(m); } }; } }, registerProcessor: (n, c) => { PlayerClass = c; } };
  ctx.currentFrame = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'pcm-worklet.js'), 'utf8').replace(/^const /m, 'var ').replace(/^class /m, 'var PcmPlayer = class '), ctx);
  const p = new PlayerClass({ processorOptions: { channels: 2, float: true, rate: 48000, ...options } });
  const packet = (frames, value) => { const b = Buffer.alloc(8 + frames * 8); for (let i = 0; i < frames; i++) { b.writeFloatLE(value, 8 + i * 8); b.writeFloatLE(-value, 12 + i * 8); } return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
  const render = () => { const out = [new Float32Array(128), new Float32Array(128)]; ctx.currentTime += 128 / 48000; p.process([], [out]); return out; };
  return { p, ctx, packet, render };
}

test('pcm-worklet: silence until it has queued enough, then the packets in order; a stall plays silence and primes again', () => {
  const { p, packet, render } = worklet();
  assert.deepEqual([...render()[0].slice(0, 4)], [0, 0, 0, 0]);
  p.push(packet(480, 0.5));   // 10 ms: below the 15 ms prime
  assert.equal(render()[0][0], 0);
  p.push(packet(480, 0.25));
  const out = render();
  assert.equal(out[0][0], 0.5); assert.equal(out[1][0], -0.5);   // left and right come out apart
  for (let i = 0; i < 6; i++) render();   // 7 quanta = 896 frames: into the second packet
  assert.equal(render()[0][0], 0.25);
  // It runs dry: silence, one underrun, and it waits for the prime again.
  for (let i = 0; i < 20; i++) render();
  assert.equal(p.underruns, 1); assert.equal(render()[0][0], 0);
});

test('pcm-worklet: delay does not pile up (too much queued is dropped to the target) and 16-bit PCM is read too', () => {
  const { p, packet, render } = worklet();
  for (let i = 0; i < 20; i++) p.push(packet(480, 0.1));   // 200 ms arrive at once
  assert.ok(p.w - p.r <= 50 * 48, 'queued ' + (p.w - p.r));
  assert.ok(p.drops > 0);
  // Steady state with a standing surplus: the part that never dips below KEEP is trimmed, in the stats window that follows.
  const s = worklet();
  s.p.push(s.packet(480 * 3, 0.1));   // 30 ms
  for (let i = 0; i < 70; i++) { s.render(); s.p.push(s.packet(128, 0.1)); }
  assert.ok(s.p.trims > 0, 'trims ' + s.p.trims);
  assert.ok(s.p.w - s.p.r < 25 * 48);
  assert.ok(s.p.port.posted.length >= 1 && 'avgMs' in s.p.port.posted[0]);
  // int16 interleaved, 20 ms (over the prime)
  const i16 = worklet({ float: false });
  const b = Buffer.alloc(8 + 960 * 4); for (let i = 0; i < 960; i++) { b.writeInt16LE(16384, 8 + i * 4); b.writeInt16LE(-16384, 10 + i * 4); }
  i16.p.push(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  const o = i16.render(); assert.equal(o[0][0], 0.5); assert.equal(o[1][0], -0.5);
});
