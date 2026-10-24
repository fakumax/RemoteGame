// RemoteGame: virtual pads for emulators that run on this PC, with no drivers.
// Guests' buttons (RetroPad bitmask, see public/pads.js) reach them two ways:
//   dsu  - a DSU/cemuhook UDP server on 127.0.0.1 (Eden and yuzu forks read it as "UDP Controller N").
//   keys - a persistent PowerShell helper that presses keys with SendInput (MAME and other keyboard-only emulators).
// Slots 0-2 are P2-P4. Nothing here touches the emulators' files or installs anything.
'use strict';
const dgram = require('dgram');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---- DSU / cemuhook (https://github.com/v1993/cemuhook-protocol; checked against Eden's input_common/helpers/udp_protocol.h and drivers/udp_client.cpp)
const DSU_VERSION = 1001;
const T_VERSION = 0x100000, T_PORTS = 0x100001, T_PAD = 0x100002;
const crc32 = buf => zlib.crc32(buf) >>> 0;

// Header (16 bytes): 'DSUS', u16 version, u16 payload length (the 4-byte type counts), u32 CRC32 (computed with this field zeroed), u32 server id.
function packet(id, type, payload) {
  const buf = Buffer.alloc(20 + payload.length);
  buf.write('DSUS', 0, 'latin1');
  buf.writeUInt16LE(DSU_VERSION, 4);
  buf.writeUInt16LE(payload.length + 4, 6);
  buf.writeUInt32LE(id, 12);
  buf.writeUInt32LE(type, 16);
  payload.copy(buf, 20);
  buf.writeUInt32LE(crc32(buf), 8);
  return buf;
}
// A client request ('DSUC') checked and cut to its declared length, or null.
function parseRequest(msg) {
  if (msg.length < 20 || msg.toString('latin1', 0, 4) !== 'DSUC' || msg.readUInt16LE(4) !== DSU_VERSION) return null;
  const len = msg.readUInt16LE(6);
  if (len < 4 || msg.length < 16 + len) return null;
  const buf = Buffer.from(msg.subarray(0, 16 + len));
  const crc = buf.readUInt32LE(8);
  buf.writeUInt32LE(0, 8);
  if (crc32(buf) !== crc) return null;
  return { type: buf.readUInt32LE(16), data: buf.subarray(20) };
}

// The 11-byte slot prefix: slot, state (0 off, 2 connected), model (2 = full gyro), connection (2 = bluetooth), MAC, battery (5 = full).
// Slot 0 stays disconnected: the host plays that one with their own pad. Slot s (P2-P4) is DSU pad s + 1.
const padMac = slot => Buffer.from([0x52, 0x47, 0, 0, 0, slot + 1]);   // "RG" + slot, stable across runs
function slotInfo(pad, slot) {
  const buf = Buffer.alloc(11);
  buf[0] = pad;
  if (slot && slot.connected) { buf[1] = 2; buf[2] = 2; buf[3] = 2; padMac(pad - 1).copy(buf, 4); buf[10] = 5; }
  return buf;
}

// Pad data: payload is 80 bytes (the whole packet 100). Offsets below are in the payload, after the type.
// `stale` repeats a counter on purpose: Eden marks a pad disconnected only when it sees the same counter twice.
function padPacket(id, pad, slot, counter, micros, stale) {
  const p = Buffer.alloc(80);
  slotInfo(pad, stale ? null : slot).copy(p, 0);
  p[11] = stale ? 0 : 1;                       // connected flag
  p.writeUInt32LE(counter >>> 0, 12);          // per-client packet counter
  const s = stale ? { b: 0, x: 0, y: 0, rx: 0, ry: 0 } : slot;
  const b = s.b, on = bit => (b >> bit) & 1;
  // Digital set 1: Left 128, Down 64, Right 32, Up 16, Options 8, R3 4, L3 2, Share 1.
  p[16] = on(6) * 128 | on(5) * 64 | on(7) * 32 | on(4) * 16 | on(3) * 8 | on(15) * 4 | on(14) * 2 | on(2);
  // Digital set 2, positional like pads.js: Y(left)=Square 128, B(down)=Cross 64, A(right)=Circle 32, X(up)=Triangle 16, R1 8, L1 4, R2 2, L2 1.
  p[17] = on(1) * 128 | on(0) * 64 | on(8) * 32 | on(9) * 16 | on(11) * 8 | on(10) * 4 | on(13) * 2 | on(12);
  // Sticks: -127..127 -> 1..255 around 128. DSU Y is 255 = up, ours is positive = down, so it flips.
  const axis = v => 128 + Math.max(-127, Math.min(127, v | 0));
  p[20] = axis(s.x); p[21] = axis(-s.y); p[22] = axis(s.rx); p[23] = axis(-s.ry);
  // Analog buttons 0/255: D-pad left, down, right, up, Y, B, A, X, R1, L1, R2, L2.
  [6, 5, 7, 4, 1, 0, 8, 9, 11, 10, 13, 12].forEach((n, i) => { p[24 + i] = on(n) * 255; });
  // Touch stays empty (36-47). Motion: timestamp in microseconds, then accel (g) and gyro (deg/s).
  p.writeBigUInt64LE(BigInt(Math.floor(micros)), 48);
  // At rest, face up, Eden reads gravity from DSU Y (its accel_z = DSU y, and it re-centers when that is <= -0.9).
  p.writeFloatLE(-1, 60);
  return packet(id, T_PAD, p);
}

function startDsu(options, state) {
  const dsu = { on: false, port: null, error: null };
  const id = crypto.randomBytes(4).readUInt32LE(0);
  const ttl = options.dsuTtl ?? 5000, rate = options.dsuRate ?? 100;
  const host = options.dsuHost || '127.0.0.1', want = options.dsuPort ?? 26760;
  const subs = new Map();   // "ip:port" -> { address, port, flags, pad, mac, expires, counters: [] }
  const t0 = process.hrtime.bigint();
  let socket = null, timer = null, retry = null, closed = false;
  const micros = () => Number((process.hrtime.bigint() - t0) / 1000n);
  const live = () => { const now = Date.now(); for (const [k, s] of subs) if (s.expires <= now) subs.delete(k); return [...subs.values()]; };
  const wants = (sub, i) => sub.flags === 0 || (sub.flags === 1 && sub.pad === i + 1) || (sub.flags === 2 && sub.mac.equals(padMac(i)));
  const out = (buf, sub) => { try { socket.send(buf, sub.port, sub.address, () => {}); } catch (e) { /* socket gone */ } };

  // One data packet per client and slot, each with its own counter that only goes up.
  function sendPad(sub, i) {
    sub.counters[i] = (sub.counters[i] || 0) + 1;
    out(padPacket(id, i + 1, state.slots[i], sub.counters[i], micros(), false), sub);
  }
  function sendTo(sub, i) { if (state.slots[i].connected && wants(sub, i)) sendPad(sub, i); }
  function tick() {
    const subsNow = live();
    if (!subsNow.length || !state.slots.some(s => s.connected)) { clearInterval(timer); timer = null; return; }
    for (const sub of subsNow) for (let i = 0; i < 3; i++) sendTo(sub, i);
  }
  const ensureTimer = () => { if (!timer && socket && dsu.on) { timer = setInterval(tick, Math.max(2, Math.round(1000 / rate))); timer.unref(); } };

  function onMessage(msg, rinfo) {
    const req = parseRequest(msg);
    if (!req) return;
    if (req.type === T_VERSION) {
      const v = Buffer.alloc(2); v.writeUInt16LE(DSU_VERSION);
      out(packet(id, T_VERSION, v), rinfo);
    } else if (req.type === T_PORTS && req.data.length >= 4) {
      // One packet per slot asked: 12 bytes (prefix + a zero), exactly what Eden's validator expects.
      const n = Math.min(req.data.readInt32LE(0), 4, req.data.length - 4);
      for (let k = 0; k < n; k++) {
        const pad = req.data[4 + k];
        if (pad > 3) continue;
        out(packet(id, T_PORTS, Buffer.concat([slotInfo(pad, pad ? state.slots[pad - 1] : null), Buffer.alloc(1)])), rinfo);
      }
    } else if (req.type === T_PAD && req.data.length >= 8) {
      const key = rinfo.address + ':' + rinfo.port;
      if (!subs.has(key) && subs.size >= 16) live();
      if (!subs.has(key) && subs.size >= 16) return;
      const prev = subs.get(key);
      const sub = { address: rinfo.address, port: rinfo.port, flags: req.data[0], pad: req.data[1], mac: Buffer.from(req.data.subarray(2, 8)), expires: Date.now() + ttl, counters: prev ? prev.counters : [] };
      subs.set(key, sub);
      for (let i = 0; i < 3; i++) sendTo(sub, i);
      ensureTimer();
    }
  }

  function bind() {
    if (closed) return;
    const s = dgram.createSocket({ type: 'udp4' });
    s.on('error', err => {
      // Port taken (DS4Windows, another RemoteGame): keep going without it and try again later.
      dsu.on = false; dsu.error = err.code === 'EADDRINUSE' ? 'El puerto ' + want + ' está ocupado por otro programa (¿DS4Windows?)' : err.message;
      try { s.close(); } catch (e) { /* already closed */ }
      if (socket === s) socket = null;
      if (!closed && !retry) { retry = setTimeout(() => { retry = null; bind(); }, options.dsuRetry ?? 10000); retry.unref(); }
    });
    s.on('message', onMessage);
    s.bind(want, host, () => {
      if (closed) { try { s.close(); } catch (e) { /* ignore */ } return; }
      socket = s; dsu.on = true; dsu.error = null; dsu.port = s.address().port;
      s.unref();
    });
  }
  bind();

  return {
    status: () => ({ on: dsu.on, port: dsu.port ?? (dsu.on ? null : want), clients: live().length, error: dsu.error }),
    // A slot changed: tell the subscribers right away (the timer keeps them fed in between).
    changed(i) { if (!socket) return; for (const sub of live()) sendTo(sub, i); ensureTimer(); },
    // A guest left: one stale packet (same counter again) so Eden drops the pad; nothing more is sent for it.
    gone(i) {
      if (!socket) return;
      for (const sub of live()) {
        if (!wants(sub, i) || !sub.counters[i]) continue;
        out(padPacket(id, i + 1, state.slots[i], sub.counters[i], micros(), true), sub);
      }
    },
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      if (retry) clearTimeout(retry);
      timer = retry = null;
      const s = socket; socket = null; dsu.on = false;
      return new Promise(resolve => { if (!s) return resolve(); try { s.close(resolve); } catch (e) { resolve(); } });
    }
  };
}

// ---- Keyboard (MAME and other emulators that read the keyboard)
// Scancodes (set 1) and the extended flag, "scancode,extended". Defaults of MAME's input.
// Source: https://docs.mamedev.org/usingmame/defaultkeys.html (US layout; P2 has buttons 1-5 only, P3 and P4 have 1-3).
const K = (sc, ext = 0) => sc + ',' + ext;
const KEY_MAP = [
  // P2: R F D G, A S Q W E, 2, coin 6
  { up: K(0x13), down: K(0x21), left: K(0x20), right: K(0x22), b1: K(0x1e), b2: K(0x1f), b3: K(0x10), b4: K(0x11), b5: K(0x12), start: K(0x03), coin: K(0x07) },
  // P3: I K J L, Right Ctrl, Right Shift, Enter, 3, coin 7
  { up: K(0x17), down: K(0x25), left: K(0x24), right: K(0x26), b1: K(0x1d, 1), b2: K(0x36), b3: K(0x1c), start: K(0x04), coin: K(0x08) },
  // P4: keypad 8 2 4 6, keypad 0 . Enter, 4, coin 8 (needs NumLock on)
  { up: K(0x48), down: K(0x50), left: K(0x4b), right: K(0x4d), b1: K(0x52), b2: K(0x53), b3: K(0x1c, 1), start: K(0x05), coin: K(0x09) }
];
// RetroPad bit -> MAME action. Arcade order: B 1, A 2, Y 3, X 4, L 5, R 6 (the same A/B/C/D that pads.js uses); Select = coin.
const BIT_ACTION = { 0: 'b1', 8: 'b2', 1: 'b3', 9: 'b4', 10: 'b5', 11: 'b6', 2: 'coin', 3: 'start', 4: 'up', 5: 'down', 6: 'left', 7: 'right' };
const STICK_THRESHOLD = 64;
function keysFor(slot, st) {
  const map = KEY_MAP[slot], keys = new Set();
  const add = action => { if (map[action]) keys.add(map[action]); };
  for (const bit in BIT_ACTION) if ((st.b >> bit) & 1) add(BIT_ACTION[bit]);
  if (st.x <= -STICK_THRESHOLD) add('left'); else if (st.x >= STICK_THRESHOLD) add('right');
  if (st.y <= -STICK_THRESHOLD) add('up'); else if (st.y >= STICK_THRESHOLD) add('down');
  return keys;
}

// The helper: a PowerShell that compiles a tiny C# class once and then obeys one-line orders on stdin.
// It only presses keys while the foreground window belongs to an allowed program, so a host who switches to
// another program never gets keys typed into it. It keeps the keys it should hold and re-applies them on
// every order ("p" = look again), pressing them when the emulator comes to the front and releasing them when it leaves.
const CSHARP = `
using System; using System.Collections.Generic; using System.Diagnostics; using System.Runtime.InteropServices;
public static class RG {
  [StructLayout(LayoutKind.Sequential)] struct MI { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KI { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct U { [FieldOffset(0)] public MI mi; [FieldOffset(0)] public KI ki; }
  [StructLayout(LayoutKind.Sequential)] struct IN { public uint type; public U u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, IN[] i, int size);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  static HashSet<string> targets = new HashSet<string>(StringComparer.OrdinalIgnoreCase), want = new HashSet<string>(), held = new HashSet<string>();
  static string Fg() {
    try { uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid); if (pid == 0) return ""; using (Process p = Process.GetProcessById((int)pid)) return p.ProcessName.ToLowerInvariant(); }
    catch (Exception) { return ""; }
  }
  static void Key(string k, bool down) {
    string[] a = k.Split(',');
    IN[] i = new IN[1]; i[0].type = 1;
    i[0].u.ki.scan = ushort.Parse(a[0]);
    i[0].u.ki.flags = 8u | (down ? 0u : 2u) | (a[1] == "1" ? 1u : 0u);
    SendInput(1, i, Marshal.SizeOf(typeof(IN)));
  }
  static void Apply() {
    if (want.Count == 0 && held.Count == 0) return;
    bool ok = want.Count > 0 && targets.Contains(Fg());
    foreach (string k in new List<string>(held)) if (!ok || !want.Contains(k)) { Key(k, false); held.Remove(k); }
    if (ok) foreach (string k in want) if (!held.Contains(k)) { Key(k, true); held.Add(k); }
  }
  public static string Cmd(string line) {
    string[] a = line.Trim().Split(' ');
    switch (a[0]) {
      case "t": targets.Clear(); if (a.Length > 1) foreach (string t in a[1].Split(',')) targets.Add(t.ToLowerInvariant()); break;
      case "d": want.Add(a[1] + "," + a[2]); Apply(); break;
      case "u": want.Remove(a[1] + "," + a[2]); Apply(); break;
      case "p": Apply(); break;
      case "r": want.Clear(); Apply(); break;
      case "s": return "status fg=" + Fg() + " allowed=" + (targets.Contains(Fg()) ? 1 : 0) + " want=" + want.Count + " held=" + held.Count;
      case "q": want.Clear(); Apply(); return "bye";
    }
    return null;
  }
}`;
// Two lines on stdin: the compile, which also sets the allowed programs (answers "ready" or "err ..."), and the loop. Lines, not one block,
// so the PowerShell reader never waits for more. Later lines are read by the loop (anything sent along with these two would be swallowed by the host).
const psCompile = names => "try { Add-Type -TypeDefinition '" + CSHARP.replace(/\s*\n\s*/g, ' ').replace(/'/g, "''") + "'; [RG]::Cmd('t " + names + "') | Out-Null; [Console]::Out.WriteLine('ready') } catch { [Console]::Out.WriteLine('err ' + ($_.Exception.Message -replace '\\s+', ' ')); exit 1 }";
const PS_LOOP = "while (($l = [Console]::In.ReadLine()) -ne $null) { $r = [RG]::Cmd($l); if ($r) { [Console]::Out.WriteLine($r) }; if ($l -eq 'q') { break } }; exit 0";

// Starts the PowerShell helper. onLine gets each line it prints, onExit(error) fires when it ends. Returns { send(line), close() }.
function spawnKeyHelper(targets, onLine, onExit) {
  let child;
  const names = targets.map(t => String(t).toLowerCase().replace(/\.exe$/, '').replace(/[^\w.\- ]/g, '')).join(',');
  try { child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
  catch (e) { setImmediate(() => onExit(e.message)); return { send() {}, close() {} }; }
  // Orders wait for "ready": the host would swallow any line written before the loop is reading.
  let buffer = '', done = false, ready = false;
  const pending = [];
  const finish = err => { if (!done) { done = true; onExit(err); } };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { buffer += chunk; const lines = buffer.split(/\r?\n/); buffer = lines.pop(); lines.forEach(l => { if (!l) return; if (l === 'ready' && !ready) { ready = true; pending.splice(0).forEach(p => child.stdin.write(p + '\n')); } onLine(l); }); });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.on('error', err => finish(err.code === 'ENOENT' ? 'No encontré PowerShell' : err.message));
  child.on('exit', code => finish(code ? 'PowerShell terminó con código ' + code : null));
  child.stdin.write(psCompile(names) + '\n' + PS_LOOP + '\n');
  const helper = {
    send(line) { if (done) return; if (ready) child.stdin.write(line + '\n'); else pending.push(line); },
    close() {
      return new Promise(resolve => {
        if (done) return resolve();
        const kill = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } }, 1500);
        child.once('exit', () => { clearTimeout(kill); resolve(); });
        try { child.stdin.write('q\n'); child.stdin.end(); } catch (e) { try { child.kill(); } catch (e2) { /* gone */ } }
      });
    }
  };
  return helper;
}

// options: dsu (false = off), dsuPort (default 26760, 0 = any free one), dsuHost, dsuTtl, dsuRate;
// keys (false = off), keyTargets (default ['mame.exe']), keyHelper(targets, onLine, onExit) -> { send, close } (tests inject a fake).
function createVpad(options = {}) {
  const slots = [0, 1, 2].map(() => ({ connected: false, b: 0, x: 0, y: 0, rx: 0, ry: 0 }));
  const dsu = options.dsu === false ? null : startDsu(options, { slots });
  const targets = (options.keyTargets || ['mame.exe']).map(t => String(t).toLowerCase());
  const makeHelper = options.keyHelper || (process.platform === 'win32' ? spawnKeyHelper : null);
  const keys = { enabled: options.keys !== false && !!makeHelper, error: null, failedAt: 0 };
  const held = [new Set(), new Set(), new Set()];   // keys each slot has down
  const downCount = () => held.reduce((n, s) => n + s.size, 0);
  let helper = null, poll = null, closed = false;

  function fail(err) {
    if (helper === null) return;
    helper = null; keys.error = err || 'El ayudante de teclado se cerró'; keys.failedAt = Date.now();
    if (poll) { clearInterval(poll); poll = null; }
  }
  // Lazy: the helper starts with the first update, and again (at most every 30 s) after a failure.
  function ensureHelper() {
    if (helper || closed || !keys.enabled) return helper;
    if (keys.failedAt && Date.now() - keys.failedAt < 30000) return null;
    const mine = {};
    try {
      mine.h = makeHelper(targets, line => { if (helper === mine.h && /^err /.test(line)) { const msg = line.slice(4); try { mine.h.close(); } catch (e) { /* ignore */ } fail(msg); } else if (helper === mine.h && line === 'ready') keys.error = null; },
        err => { if (helper === mine.h) fail(err); });
    } catch (e) { keys.failedAt = Date.now(); keys.error = e.message; return null; }
    helper = mine.h;
    keys.failedAt = 0;
    // Whatever is held by now goes first, so a restart does not lose keys.
    for (const set of held) for (const k of set) helper.send('d ' + k.replace(',', ' '));
    return helper;
  }
  // While keys are held the helper is told to look again, so a key waits for the emulator to come to the front.
  function ensurePoll() {
    if (poll || !helper || !downCount()) return;
    poll = setInterval(() => { if (!helper || !downCount()) { clearInterval(poll); poll = null; } else helper.send('p'); }, 250);
    poll.unref();
  }
  function setKeys(i, next) {
    if (!keys.enabled) return;
    const h = ensureHelper();
    const cur = held[i];
    const downs = [...next].filter(k => !cur.has(k)), ups = [...cur].filter(k => !next.has(k));
    held[i] = next;
    if (!h) return;
    for (const k of ups) h.send('u ' + k.replace(',', ' '));
    for (const k of downs) h.send('d ' + k.replace(',', ' '));
    ensurePoll();
  }
  const valid = slot => Number.isInteger(slot) && slot >= 0 && slot < 3;
  const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.trunc(Number(v)) || 0));

  const api = {
    // st: { b: RetroPad bits 0-15, x, y: left stick, rx, ry: right stick (-127..127, Y positive = down) }
    update(slot, st) {
      if (closed || !valid(slot) || !st || typeof st !== 'object') return;
      const s = slots[slot];
      const next = { b: int(st.b, 0, 0xffff), x: int(st.x, -127, 127), y: int(st.y, -127, 127), rx: int(st.rx, -127, 127), ry: int(st.ry, -127, 127) };
      const changed = !s.connected || next.b !== s.b || next.x !== s.x || next.y !== s.y || next.rx !== s.rx || next.ry !== s.ry;
      Object.assign(s, next, { connected: true });
      if (changed && dsu) dsu.changed(slot);
      setKeys(slot, keysFor(slot, s));
    },
    release(slot) {
      if (!valid(slot) || !slots[slot].connected) return;
      const s = slots[slot];
      Object.assign(s, { connected: false, b: 0, x: 0, y: 0, rx: 0, ry: 0 });
      if (dsu) dsu.gone(slot);
      setKeys(slot, new Set());
    },
    releaseAll() { for (let i = 0; i < 3; i++) api.release(i); },
    status: () => ({
      dsu: dsu ? dsu.status() : { on: false, port: null, clients: 0, error: null },
      keys: { on: keys.enabled && !keys.error, targets, error: keys.error },
      slots: slots.map((s, slot) => ({ slot, ...s }))
    }),
    async close() {
      if (closed) return;
      api.releaseAll();
      closed = true;
      if (poll) clearInterval(poll);
      poll = null;
      const h = helper; helper = null;
      await Promise.all([dsu && dsu.close(), h && h.close()]);
    }
  };
  return api;
}

module.exports = { createVpad, spawnKeyHelper, keysFor, KEY_MAP };
