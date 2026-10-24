// RemoteGame: a small rotating log and a safety net, so nothing an emulator or the stream window does can take the server
// down without leaving a trace. Everything here is synchronous and swallows its own errors: logging must never throw.
'use strict';
const fs = require('fs');
const path = require('path');

// file: null turns the file off (the console still gets the line). At `max` bytes the file becomes <file>.1 (one old copy is kept).
function createLog(file, { max = 512 * 1024, echo = true } = {}) {
  const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  function write(kind, text) {
    const line = '[' + stamp() + '] ' + kind + ': ' + String(text).replace(/\s+$/, '');
    if (echo) { try { console.log(line.split('\n')[0]); } catch (e) { /* console closed */ } }
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let size = 0;
      try { size = fs.statSync(file).size; } catch (e) { /* first line */ }
      if (size > max) { try { fs.rmSync(file + '.1', { force: true }); fs.renameSync(file, file + '.1'); } catch (e) { /* in use: keep appending */ } }
      fs.appendFileSync(file, line + '\n');
    } catch (e) { /* no disk, no log */ }
  }
  return { file, write, error: (kind, err) => write(kind, err && err.stack ? err.stack : String(err)) };
}

// An error nobody caught (an exception in a callback, a promise rejected with no catch) is logged and the server goes on:
// a broken emulator or stream window is not a reason to drop every guest. proc is `process` (a fake one in tests).
function installCrashGuard(proc, log) {
  proc.on('uncaughtException', err => log.error('uncaughtException', err));
  proc.on('unhandledRejection', reason => log.error('unhandledRejection', reason));
}

module.exports = { createLog, installCrashGuard };
