const { test } = require('node:test');
const assert = require('node:assert/strict');
const pads = require('../public/pads');

// Gamepad-like object: pressed = list of button indexes, axes = array.
const pad = (id, pressed = [], axes = [0, 0, 0, 0], extra = {}) => ({
  id, index: 0, connected: true, mapping: 'standard', axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })), ...extra
});
const DUALSENSE = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';

test('Pads: EmulatorJS gets blank bindings, we read keyboard and pads ourselves', () => {
  const c = pads.ejsControls();
  for (const p of [0, 1, 2, 3]) for (const i in pads.PAD) assert.deepEqual(c[p][i], { value: '', value2: '' });
});

test('Pads: key layouts translate to KeyboardEvent.code and never overlap in 2P', () => {
  const m = pads.codeMap(pads.KEYS_SOLO);
  assert.deepEqual([m.KeyZ, m.ArrowUp, m.ShiftLeft, m.ShiftRight, m.Enter], [[0], [4], [2], [2], [3]]);
  assert.deepEqual(pads.codeMap(pads.KEYS_P1_SHARED).Digit2, [3]);
  const p1 = Object.keys(pads.codeMap(pads.KEYS_P1_SHARED)), p2 = Object.keys(pads.codeMap(pads.KEYS_P2_SHARED));
  assert.deepEqual(p1.filter(k => p2.includes(k)), [], 'shared keyboard keys must not overlap');
  assert.equal(pads.codeMap(pads.KEYS_N64).KeyH[0], 16);
});

test('Pads: guest keyboard and gamepad become one RetroPad state', () => {
  assert.deepEqual(pads.readGuest({ KeyZ: true, ArrowUp: true, Enter: false }, [], false), { b: 1 | 1 << 4, x: 0, y: 0, rx: 0, ry: 0 });
  const p = { connected: true, buttons: [{ pressed: false }, { pressed: true }], axes: [-0.9, 0] };
  assert.deepEqual(pads.readGuest({}, [p], false), { b: 1 << 8 | 1 << 6, x: 0, y: 0, rx: 0, ry: 0 });
  assert.deepEqual(pads.readGuest({}, [p], true), { b: 1 << 8, x: -114, y: 0, rx: 0, ry: 0 });
});

test('Pads: guest reads both sticks when the game is analog, and the right one is ignored otherwise', () => {
  // Xbox-style standard mapping: axes 0/1 left stick, 2/3 right stick.
  const two = pad('Xbox 360 Controller (XInput STANDARD GAMEPAD)', [0], [0.5, -1, -1, 0.9]);
  assert.deepEqual(pads.readGuest({}, [two], true), { b: 1, x: 64, y: -127, rx: -127, ry: 114 });
  // Without analog the left stick becomes the D-pad and the right one does nothing.
  assert.deepEqual(pads.readGuest({}, [two], false), { b: 1 | 1 << 4, x: 0, y: 0, rx: 0, ry: 0 });
  // The dead zone cleans the drift of both sticks.
  assert.deepEqual(pads.readGuest({}, [pad(DUALSENSE, [], [0.1, -0.1, 0.12, 0.14])], true), { b: 0, x: 0, y: 0, rx: 0, ry: 0 });
  // A second pad adds to the first; each axis keeps the one that moves.
  const idle = pad(DUALSENSE, [], [0, 0, 0, 0], { index: 0 }), moving = pad(DUALSENSE, [], [0, 0, 1, 0], { index: 1 });
  assert.equal(pads.readGuest({}, [idle, moving], true).rx, 127);
  // The state it produces goes through applyGuest to the right stick inputs (20-23).
  const calls = [];
  pads.applyGuest(pads.EMPTY, { b: 0, x: 0, y: 0, rx: 127, ry: -127 }, (i, v) => calls.push([i, v]));
  assert.deepEqual(calls, [[20, 0x7fff], [21, 0], [22, 0], [23, 0x7fff]]);
});

test('Pads: an idle pad in front does not hide the real one', () => {
  const ghost = pad('vJoy Device', [], [0, 0]), real = pad(DUALSENSE, [0], [0, 0], { index: 1 });
  assert.equal(pads.readGuest({}, [ghost, real], false).b, 1);
});

test('Pads: names are readable', () => {
  assert.equal(pads.padName(DUALSENSE), 'DualSense');
  assert.equal(pads.padName('054c-0ce6-DualSense Wireless Controller'), 'DualSense');
  assert.equal(pads.padName('DualSense Edge Wireless Controller (Vendor: 054c Product: 0df2)'), 'DualSense');
  assert.equal(pads.padName('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)'), 'DualShock 4');
  assert.equal(pads.padName('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), 'mando de Xbox');
  assert.equal(pads.padName('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)'), 'mando de Switch');
  assert.equal(pads.padName('USB Gamepad (Vendor: 0810 Product: 0001)'), 'USB Gamepad');
  assert.equal(pads.padName(''), 'mando genérico');
});

test('Pads: DualSense without the standard mapping is remapped (cross = B, hat = D-pad)', () => {
  // Raw HID order: 0 square, 1 cross, 2 circle, 3 triangle; hat on axis 9, right stick Y on axis 5.
  const axes = (hatValue, extra = {}) => { const a = new Array(10).fill(0); a[9] = hatValue; return Object.assign(a, extra); };
  const raw = (pressed, hatValue, extra) => pad(DUALSENSE.replace('STANDARD GAMEPAD ', ''), pressed, axes(hatValue, extra), { mapping: '' });
  assert.equal(pads.padState(raw([1], 1.29), false).b, 1 << 0, 'cross -> B');
  assert.equal(pads.padState(raw([2], 1.29), false).b, 1 << 8, 'circle -> A');
  assert.equal(pads.padState(raw([0], 1.29), false).b, 1 << 1, 'square -> Y');
  assert.equal(pads.padState(raw([3], 1.29), false).b, 1 << 9, 'triangle -> X');
  assert.equal(pads.padState(raw([9], 1.29), false).b, 1 << 3, 'options -> Start');
  assert.equal(pads.padState(raw([], -1), false).b, 1 << 4, 'hat up');
  assert.equal(pads.padState(raw([], -0.428), false).b, 1 << 7, 'hat right');
  assert.equal(pads.padState(raw([], -0.714), false).b, 1 << 4 | 1 << 7, 'hat up-right');
  assert.equal(pads.padState(raw([], 0.714), false).b, 1 << 6, 'hat left');
  assert.equal(pads.padState(raw([], 1.29), false).b, 0, 'released hat');
  assert.equal(pads.padState(raw([], 0), false).b, 0, 'no data is not a press');
  assert.equal(pads.padState(raw([], 1.29, { 2: 1, 5: -1 }), true).rx, 127, 'right stick X');
  assert.equal(pads.padState(raw([], 1.29, { 5: -1 }), true).ry, -127, 'right stick Y is axis 5');
  // Same pad with the standard mapping is read as is.
  assert.equal(pads.padState(pad(DUALSENSE, [0, 12]), false).b, 1 << 0 | 1 << 4);
});

test('Pads: only pads that show activity count (virtual drivers stay out)', () => {
  const track = pads.padTracker();
  const ghost = pad('Steam Virtual Gamepad', [], [0, 0, 0, -1], { index: 0 });
  const real = (pressed, axes) => pad(DUALSENSE, pressed, axes, { index: 1 });
  assert.deepEqual(track([ghost, real([], [0, 0, 0, 0])]), []);
  assert.deepEqual(track([ghost, real([0], [0, 0, 0, 0])]).map(g => g.index), [1]);
  assert.deepEqual(track([ghost, real([], [0, 0, 0, 0])]).map(g => g.index), [1], 'stays live after release');
  assert.deepEqual(track([ghost, real([], [0, 0, 0, 0]), null]).length, 1);
  // A trigger axis that rests at -1 is not activity; pushing it is.
  const t = pads.padTracker();
  assert.deepEqual(t([ghost]), []);
  assert.equal(t([pad('Steam Virtual Gamepad', [], [0, 0, 0, 0.9], { index: 0 })]).length, 1);
});

test('Pads: status line says what is going on', () => {
  const live = [pad(DUALSENSE)];
  assert.equal(pads.padStatus(live, live, false), '🎮 DualSense conectado');
  assert.equal(pads.padStatus(live, live, true), '🎮 P1: DualSense conectado');
  const two = [pad(DUALSENSE), pad('Xbox 360 Controller (XInput STANDARD GAMEPAD)')];
  assert.equal(pads.padStatus(two, two, false), '🎮 DualSense + mando de Xbox conectados');
  assert.equal(pads.padStatus(two, two, true), '🎮 P1: DualSense · P2: mando de Xbox conectados');
  assert.match(pads.padStatus([pad('x')], [], false), /Mando detectado/);
  assert.match(pads.padStatus([], [], false), /Ningún mando/);
  assert.match(pads.padStatus([null, null], [], false), /Ningún mando/);
});

test('Pads: host applies only what changed and releases everything', () => {
  const calls = [];
  const simulate = (i, v) => calls.push([i, v]);
  pads.applyGuest(pads.EMPTY, { b: 1 | 1 << 3, x: 127, y: 0 }, simulate);
  assert.deepEqual(calls, [[0, 1], [3, 1], [16, 0x7fff], [17, 0]]);
  calls.length = 0;
  pads.applyGuest({ b: 1 | 1 << 3, x: 127, y: 0 }, pads.EMPTY, simulate);
  assert.deepEqual(calls, [[0, 0], [3, 0], [16, 0], [17, 0]]);
});

test('Pads: host input online sends P1 keyboard and pad once, ignoring other keys', () => {
  const calls = [];
  const input = pads.hostInput('nes', true, (p, i, v) => calls.push([p, i, v]));
  assert.equal(input.key('KeyF', true), false, 'F is not a game key online');
  assert.equal(input.key('ArrowLeft', true), true);
  input.key('ArrowLeft', true);
  assert.deepEqual(calls, [[0, 6, 1]], 'repeats do not resend');
  input.key('ArrowLeft', false);
  input.pads([pad(DUALSENSE, [0, 12])]);
  assert.deepEqual(calls.slice(1), [[0, 6, 0], [0, 0, 1], [0, 4, 1]]);
  calls.length = 0;
  // Keyboard and pad on the same button: it stays down until both let go.
  input.key('KeyZ', true);
  input.key('KeyZ', false);
  assert.deepEqual(calls, []);
  input.pads([]);
  assert.deepEqual(calls, [[0, 0, 0], [0, 4, 0]]);
  calls.length = 0;
  input.key('Enter', true);
  input.release();
  assert.deepEqual(calls, [[0, 3, 1], [0, 3, 0]]);
});

test('Pads: host input in local 2P gives each live pad its own player and keyboard halves', () => {
  const calls = [];
  const input = pads.hostInput('snes', false, (p, i, v) => calls.push([p, i, v]));
  input.key('KeyD', true);
  input.key('ArrowRight', true);
  assert.deepEqual(calls, [[0, 7, 1], [1, 7, 1]]);
  calls.length = 0;
  const a = pad(DUALSENSE, [1], [0, 0], { index: 0 }), b = pad('Xbox 360 Controller (XInput STANDARD GAMEPAD)', [0], [0, 0], { index: 1 });
  input.pads([a, b]);
  assert.deepEqual(calls.sort(), [[0, 8, 1], [1, 0, 1]].sort());
});

test('Pads: host input in local mode takes up to 4 pads, one per player', () => {
  const calls = [];
  const input = pads.hostInput('fbneo', false, (p, i, v) => calls.push([p, i, v]));
  const four = [0, 1, 2, 3].map(n => pad('Xbox 360 Controller (XInput STANDARD GAMEPAD)', [0], [0, 0], { index: n }));
  input.pads(four);
  assert.deepEqual(calls.sort(), [[0, 0, 1], [1, 0, 1], [2, 0, 1], [3, 0, 1]]);
});

test('Pads: host input maps the N64 keyboard stick and C buttons', () => {
  const calls = [];
  const input = pads.hostInput('n64', true, (p, i, v) => calls.push([p, i, v]));
  input.key('KeyH', true);
  input.key('KeyI', true);
  assert.deepEqual(calls, [[0, 16, 0x7fff], [0, 17, 0], [0, 22, 0], [0, 23, 0x7fff]]);
  calls.length = 0;
  input.pads([pad(DUALSENSE, [], [0, 0, 0, 0])]);
  input.pads([pad(DUALSENSE, [], [0, -1, 0, 0])]);
  assert.ok(calls.some(([, i, v]) => i === 19 && v === 0x7fff), 'left stick up');
});

test('Pads: describe names what a guest holds, Xbox style', () => {
  assert.deepEqual(pads.describe({ b: 0, x: 0, y: 0, rx: 0, ry: 0 }), []);
  assert.deepEqual(pads.describe({ b: (1 << 4) | 1 | (1 << 11), x: 0, y: 0, rx: 0, ry: 0 }), ['↑', 'A', 'RB']);
  assert.deepEqual(pads.describe({ b: 1 << 3, x: -100, y: 10, rx: 0, ry: 90 }), ['MENÚ', 'stick ←', 'stick der. ↓']);
  assert.deepEqual(pads.describe({ b: 0, x: 20, y: -30, rx: 0, ry: 0 }), [], 'a small stick move is nothing');
  assert.deepEqual(pads.describe(null), []);
});

test('Pads: the host is told in words whether Eden reads the UDP pads', () => {
  const on = { on: true, clients: 1, watching: [true, true, true], error: null };
  assert.equal(pads.edenLine(on, []), '', 'nobody playing: nothing to say');
  assert.equal(pads.edenLine(on, [0, 1]), '✓ Eden conectado a los mandos');
  assert.equal(pads.edenLine({ ...on, clients: 0, watching: [false, false, false] }, [0]), '⚠️ Eden no está leyendo los mandos UDP (configurá P2–P4)');
  assert.match(pads.edenLine({ ...on, watching: [true, false, true] }, [0, 1]), /no está pidiendo los datos de P3/);
  assert.match(pads.edenLine({ on: false, clients: 0, error: 'El puerto 26760 está ocupado' }, [0]), /no están disponibles \(El puerto 26760 está ocupado\)/);
  assert.match(pads.padStatus([], [], false), /apretá un botón del mando para que el navegador lo vea/);
});
