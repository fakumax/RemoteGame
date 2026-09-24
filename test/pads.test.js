const { test } = require('node:test');
const assert = require('node:assert/strict');
const pads = require('../public/pads');

test('Pads: local 2P gives P1 and P2 their own keys and a gamepad each', () => {
  const c = pads.ejsControls('snes', 'local');
  assert.equal(c[0][4].value, 'w');
  assert.equal(c[1][4].value, 'up arrow');
  for (const p of [0, 1, 2, 3]) assert.equal(c[p][0].value2, 'BUTTON_1');
  const p1 = Object.values(c[0]).map(x => x.value).filter(Boolean);
  const p2 = Object.values(c[1]).map(x => x.value).filter(Boolean);
  assert.deepEqual(p1.filter(k => p2.includes(k)), [], 'shared keyboard keys must not overlap');
  assert.equal(pads.ejsControls('fbneo', 'online')[1][4].value, '');
  assert.equal(pads.ejsControls('n64', 'local')[0][16].value, 'h');
});

test('Pads: guest keyboard and gamepad become one RetroPad state', () => {
  assert.deepEqual(pads.readGuest({ KeyZ: true, ArrowUp: true, Enter: false }, [], false), { b: 1 | 1 << 4, x: 0, y: 0 });
  const pad = { connected: true, buttons: [{ pressed: false }, { pressed: true }], axes: [-0.9, 0] };
  assert.deepEqual(pads.readGuest({}, [pad], false), { b: 1 << 8 | 1 << 6, x: 0, y: 0 });
  assert.deepEqual(pads.readGuest({}, [pad], true), { b: 1 << 8, x: -114, y: 0 });
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
