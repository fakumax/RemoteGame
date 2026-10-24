const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createLog, installCrashGuard } = require('../crash-log');

test('log: appends dated lines, creates its folder, rotates to .1 past the limit, and never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotegame-log-'));
  try {
    const file = path.join(dir, 'cache', 'remotegame.log');
    const log = createLog(file, { max: 200, echo: false });
    log.write('launch', 'MAME kinst2 pid 1');
    assert.match(fs.readFileSync(file, 'utf8'), /^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\] launch: MAME kinst2 pid 1\n$/);
    for (let i = 0; i < 10; i++) log.write('x', 'line ' + i + ' '.repeat(30));
    assert.ok(fs.existsSync(file + '.1'));
    assert.ok(fs.statSync(file).size <= 400);
    log.error('boom', new Error('kaput'));
    assert.match(fs.readFileSync(file, 'utf8'), /boom: Error: kaput\n\s+at /);
    // No file at all, an unwritable one: nothing is thrown.
    createLog(null, { echo: false }).write('a', 'b');
    createLog(path.join(dir, 'cache', 'remotegame.log', 'inside-a-file.log'), { echo: false }).write('a', 'b');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('crash guard: an uncaught exception or a rejected promise is logged and does not end the process', () => {
  const lines = [], log = { error: (kind, err) => lines.push(kind + ': ' + (err && err.message)) };
  const proc = new EventEmitter();
  installCrashGuard(proc, log);
  proc.emit('uncaughtException', new Error('TypeError in a callback'));
  proc.emit('unhandledRejection', new Error('rejected with no catch'));
  assert.deepEqual(lines, ['uncaughtException: TypeError in a callback', 'unhandledRejection: rejected with no catch']);
});
