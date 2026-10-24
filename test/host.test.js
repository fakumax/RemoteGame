const { test } = require('node:test');
const assert = require('node:assert/strict');
const RemoteHost = require('../public/host');

test('Host: a pad message becomes a clamped state; rx/ry are optional', () => {
  assert.deepEqual(RemoteHost.parsePad({ t: 'pad', s: 1, b: 0x1ffff, x: 500, y: -500 }, -1), { b: 0xffff, x: 127, y: -127, rx: 0, ry: 0 });
  assert.deepEqual(RemoteHost.parsePad({ t: 'pad', s: 2, b: 1, x: 10, y: -20, rx: 300, ry: -300 }, 1), { b: 1, x: 10, y: -20, rx: 127, ry: -127 });
  assert.deepEqual(RemoteHost.parsePad({ t: 'pad', s: 0, b: 'x', x: 'y', y: null, rx: {}, ry: 1.9 }, -1), { b: 0, x: 0, y: 0, rx: 0, ry: 1 });
});

test('Host: old, repeated or malformed pad messages are dropped', () => {
  for (const [m, last] of [[{ t: 'pad', s: 5, b: 1 }, 5], [{ t: 'pad', s: 4, b: 1 }, 5], [{ t: 'pad', s: 1.5, b: 1 }, 0], [{ t: 'pad', b: 1 }, 0],
    [{ t: 'pad', s: '3' }, 0], [{ t: 'other', s: 9 }, 0], [null, 0], [undefined, 0], ['pad', 0]]) {
    assert.equal(RemoteHost.parsePad(m, last), null, JSON.stringify(m));
  }
  assert.notEqual(RemoteHost.parsePad({ t: 'pad', s: 0, b: 0 }, -1), null);
});
