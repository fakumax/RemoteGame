// RemoteGame: biblioteca local y netplay NES 2P
// La carpeta de juegos solo se lee: aca nunca se escribe nada. Se escriben ./roms (subidas desde la web),
// ./cache (portadas y listados descargados), ./covers (portadas propias, por consola) y settings.json.
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { WebSocketServer } = require('ws');
const { createVpad } = require('./vpad');
const { createStreamer, findBrowser, system: sysProc } = require('./stream-browser');
const { createLog, installCrashGuard } = require('./crash-log');
const { execFile } = require('child_process');

let cfg = { port: 3000 };
try {
  cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')));
} catch (e) { /* config opcional */ }

// Fingerprint of the code that is running. A newer launch compares it with the one holding the
// port to know whether to replace it. REMOTEGAME_BUILD_SALT lets a test fake a different version.
const BUILD = (() => {
  const hash = crypto.createHash('sha1');
  const files = ['server.js', 'package.json'];
  try { files.push(...fs.readdirSync(path.join(__dirname, 'netplay-node')).filter(f => f.endsWith('.js')).sort().map(f => 'netplay-node/' + f)); } catch (e) {}
  for (const f of files) { try { hash.update(f).update(fs.readFileSync(path.join(__dirname, f))); } catch (e) {} }
  return hash.update(process.env.REMOTEGAME_BUILD_SALT || '').digest('hex').slice(0, 12);
})();

// Switch dumps read "<Title> [<16 hex title id>][v<version>] (size).nsp". The id tells what a file is: ...000 is the base
// game, ...800 its update, any other tail (...001) DLC. An update shares the base's id up to the last 3 digits; a DLC id is
// the base's plus 0x1000 (and a small index), so one block down it points at the base. Without an id (a plain
// "Game.xci"), a file is a base unless tagged [DLC]/[UPD], and extras are matched by the title. Returns only the base
// games, each with its `updates` ([{ file, version }], newest first) and `dlc` count; extras with no base are dropped.
function groupSwitch(files) {
  const nameKey = f => f.replace(/\.[^.]+$/, '').replace(/\s*[\[(][^\])]*[\])]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const info = files.map(x => {
    const idm = x.file.match(/\[([0-9a-f]{16})\]/i), id = idm ? BigInt('0x' + idm[1]) : null;
    const low = id === null ? -1 : Number(id & 0xfffn);
    const kind = id !== null ? (low === 0 ? 'base' : low === 0x800 ? 'update' : 'dlc') : /\[DLC/i.test(x.file) ? 'dlc' : /\[(UPD|Update)/i.test(x.file) ? 'update' : 'base';
    const app = id === null ? null : kind === 'dlc' ? (id >> 12n) - 1n : id >> 12n;
    return { ...x, kind, app, key: nameKey(x.file), version: Number((x.file.match(/\[v(\d+)\]/i) || [])[1]) || 0 };
  });
  const mine = (b, x) => x.app !== null && b.app !== null ? x.app === b.app : x.key === b.key;
  return info.filter(x => x.kind === 'base').map(b => {
    const updates = info.filter(x => x.kind === 'update' && mine(b, x)).sort((p, q) => q.version - p.version).map(x => ({ file: x.file, version: x.version }));
    return { file: b.file, full: b.full, updates, dlc: info.filter(x => x.kind === 'dlc' && mine(b, x)).length };
  });
}

const defaultLog = createLog(path.join(__dirname, 'cache', 'remotegame.log'));
function createRemoteGame(options = {}) {
const PORT = options.port ?? (process.env.PORT ? Number(process.env.PORT) : cfg.port);
// The games folder, in order of priority: option / GAMES_ROOT variable, settings.json (git-ignored,
// written from the library page), then the default. The first two cannot be changed from the page.
const SETTINGS_FILE = path.resolve(options.settingsFile || path.join(__dirname, 'settings.json'));
const readSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}; } catch (e) { return {}; } };
const ROOT_LOCKED = !!(options.gamesRoot || process.env.GAMES_ROOT);
let GAMES_ROOT = path.resolve(options.gamesRoot || process.env.GAMES_ROOT || readSettings().gamesRoot || path.join(os.homedir(), 'Desktop', 'GAMES LAUNCHBOX EMULATOR'));
const LOCAL_ROMS = path.resolve(options.localRoms || path.join(__dirname, 'roms'));
const LAUNCHBOX = path.resolve(options.launchBoxDir || process.env.LAUNCHBOX_DIR || path.join(os.homedir(), 'LaunchBox'));
fs.mkdirSync(LOCAL_ROMS, { recursive: true });
const game = { publicUrl: null };
// Virtual pads for emulators on this PC: DSU server on 127.0.0.1:26760 (Eden) and a keyboard helper (MAME).
// Under `node --test` they stay off the real port and never start PowerShell, whatever a test creates.
const testing = !!process.env.NODE_TEST_CONTEXT;
// cache/remotegame.log (rotated): what the emulators, the stream window and any uncaught error did. Off the disk under `node --test`.
const log = options.log || (testing ? createLog(null, { echo: false }) : defaultLog);
game.vpad = options.vpad || createVpad({ dsuPort: options.dsuPort ?? (testing ? 0 : cfg.dsuPort), keys: options.keys ?? !testing, keyTargets: options.keyTargets || cfg.keyTargets });

// Sistemas. dir de GAMES = lectura. Solo 'subidos' permite escritura.
const SYSTEMS = {
  nes:     { label: 'NES / Family', dir: path.join(GAMES_ROOT, 'NES'), exts: ['.nes', '.zip'], ejs: 'nes', lb: 'Nintendo Entertainment System', lr: ['Nintendo - Nintendo Entertainment System'] },
  genesis: { label: 'Sega Genesis', dir: path.join(GAMES_ROOT, 'Sega Genesis'), exts: ['.bin', '.md', '.smd', '.gen', '.zip'], ejs: 'segaMD', lb: 'Sega Genesis', lr: ['Sega - Mega Drive - Genesis'] },
  arcade:  { label: 'Arcade / Neo Geo', dir: path.join(GAMES_ROOT, 'MAME', 'Roms'), exts: ['.zip'], ejs: 'fbneo', emu: 'mame', lb: 'Arcade', lr: ['FBNeo - Arcade Games', 'MAME'] },
  snes: { label: 'Super Nintendo', dir: path.join(GAMES_ROOT, 'Super Nintendo', 'Roms'), exts: ['.sfc', '.smc', '.zip'], ejs: 'snes', lb: 'Super Nintendo Entertainment System', lr: ['Nintendo - Super Nintendo Entertainment System'] },
  n64: { label: 'Nintendo 64', dir: path.join(GAMES_ROOT, 'Nintendo 64', 'Roms'), exts: ['.z64', '.n64', '.v64', '.zip'], ejs: 'n64', lb: 'Nintendo 64', lr: ['Nintendo - Nintendo 64'] },
  // Switch has no web player: it only opens in Eden on this PC (pcOnly). Its dumps sit in one folder per game (deep).
  switch: { label: 'Nintendo Switch', dir: path.join(GAMES_ROOT, 'Nintendo Switch 1', 'Roms'), exts: ['.nsp', '.xci'], emu: 'eden', pcOnly: true, deep: true, lb: 'Nintendo Switch' },
  subidos: { label: 'Subidos', dir: LOCAL_ROMS, exts: ['.nes', '.zip', '.bin', '.md', '.smd', '.gen'], writable: true }
};
for (const id of Object.keys(SYSTEMS)) SYSTEMS[id].id = id;
// Where each console's folder is looked for under the games folder: by name (up to 3 levels deep),
// and a "Roms" folder inside it wins if it holds more games. Never by extension alone: a PlayStation
// .bin would pass for Genesis.
const FOLDER_NAMES = {
  nes: /^(nes|famicom|familycomputer|nintendones|nintendofamicom|nintendoentertainmentsystem)$/,
  genesis: /^(genesis|megadrive|megadrivegenesis|genesismegadrive|segagenesis|segamegadrive|segamegadrivegenesis)$/,
  arcade: /^(mame|arcade|fbneo|fba|finalburnneo|neogeo|mame2003|mame2003plus)$/,
  snes: /^(snes|supernes|superfamicom|supernintendo|nintendosnes|supernintendoentertainmentsystem)$/,
  n64: /^(n64|nintendo64)$/,
  switch: /^(switch|switch1|nintendoswitch|nintendoswitch1)$/
};
const DEFAULT_DIRS = { nes: ['NES'], genesis: ['Sega Genesis'], arcade: ['MAME', 'Roms'], snes: ['Super Nintendo', 'Roms'], n64: ['Nintendo 64', 'Roms'], switch: ['Nintendo Switch 1', 'Roms'] };
// Every file with one of these extensions under dir, a few folders deep (Switch dumps live in one folder per game).
function walkRoms(dir, exts, depth = 3) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
  const out = [];
  for (const e of entries) {
    if (e.isFile() && exts.some(x => e.name.toLowerCase().endsWith(x))) out.push({ file: e.name, full: path.join(dir, e.name) });
    else if (e.isDirectory() && depth > 0 && !e.name.startsWith('.')) out.push(...walkRoms(path.join(dir, e.name), exts, depth - 1));
  }
  return out;
}
function findConsoleDirs(root) {
  const found = {};
  const queue = [[root, 1]];
  const count = (dir, id) => { if (SYSTEMS[id].deep) return walkRoms(dir, SYSTEMS[id].exts).length; try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && SYSTEMS[id].exts.some(x => e.name.toLowerCase().endsWith(x))).length; } catch (e) { return 0; } };
  for (let i = 0; i < queue.length && i < 1500; i++) {
    const [dir, depth] = queue[i];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || /^(covers|node_modules|\$recycle\.bin|system volume information)$/i.test(e.name)) continue;
      const full = path.join(dir, e.name), key = squash(e.name);
      const id = Object.keys(FOLDER_NAMES).find(k => FOLDER_NAMES[k].test(key));
      if (!id) { if (depth < 3) queue.push([full, depth + 1]); continue; }
      // (a matched folder is read below)
      let best = { dir: full, n: count(full, id), depth };
      try {
        const roms = fs.readdirSync(full, { withFileTypes: true }).find(x => x.isDirectory() && /^roms?$/i.test(x.name));
        if (roms) { const n = count(path.join(full, roms.name), id); if (n >= best.n) best = { dir: path.join(full, roms.name), n, depth }; }
      } catch (err) {}
      const cur = found[id];
      if (!cur || best.n > cur.n || (best.n === cur.n && best.depth < cur.depth)) found[id] = best;
      // A wrapper with no games of its own ("Arcade/FBNeo/..."): look inside.
      if (best.n === 0 && depth < 3) queue.push([full, depth + 1]);
    }
  }
  return found;
}
let consoleDirs = {}, emuCache = null;
// Points every console at its detected folder (or the usual place, which then reads as missing).
function applyRoot() {
  consoleDirs = findConsoleDirs(GAMES_ROOT);
  for (const id of Object.keys(DEFAULT_DIRS)) SYSTEMS[id].dir = consoleDirs[id] ? consoleDirs[id].dir : path.join(GAMES_ROOT, ...DEFAULT_DIRS[id]);
  sysIndex.clear(); coverCache.clear(); localCovers.clear(); emuCache = null;
}

function getSys(id) {
  id = String(id || '').toLowerCase();
  return Object.hasOwn(SYSTEMS, id) ? SYSTEMS[id] : null;
}
function safeFile(name) {
  const base = path.basename(String(name || ''));
  if (!base || base === '.' || base === '..' || base !== String(name) || /[\\/:\x00-\x1f]/.test(base)) return null;
  return base;
}
// Full titles come from LaunchBox's own lists (read only), keyed by the ROM's full path.
// Reloaded only when an XML changes, so searching stays cheap.
let titles = new Map(), titlesStamp = '';
function xmlText(block, tag) {
  const m = block.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim() : '';
}
function launchBoxTitles() {
  const dir = path.join(LAUNCHBOX, 'Data', 'Platforms');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /\.xml$/i.test(f)); } catch (e) { return titles; }
  const stamp = files.map(f => { try { return f + fs.statSync(path.join(dir, f)).mtimeMs; } catch (e) { return f; } }).join('|');
  if (stamp === titlesStamp) return titles;
  const next = new Map();
  for (const f of files) {
    let xml = '';
    try { xml = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { continue; }
    for (const block of xml.split('<Game>').slice(1)) {
      const app = xmlText(block, 'ApplicationPath'), title = xmlText(block, 'Title');
      if (!app || !title) continue;
      next.set(path.resolve(LAUNCHBOX, app).toLowerCase(), { title, year: xmlText(block, 'ReleaseDate').slice(0, 4), id: Number(xmlText(block, 'DatabaseID')) || 0, platform: xmlText(block, 'Platform') });
    }
  }
  titles = next; titlesStamp = stamp;
  return titles;
}
// Not in LaunchBox: tidy the file name, dropping dump tags like [!] or [T+Spa1.0] and
// region tags like (U); "Addams Family, The - X" reads "The Addams Family - X".
function tidyName(file) {
  const tags = [];
  const name = file.replace(/\.[^.]+$/, '').replace(/\s*\[[^\]]*\]/g, '').replace(/\s*\(([^)]*)\)/g, (m, tag) => { tags.push(tag.trim()); return ''; })
    .replace(/_+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(.+?), (The|A|An)( - .*)?$/i, (m, rest, article, sub) => article + ' ' + rest + (sub || ''));
  return { name, tag: tags.join(' · ') };
}
// Arcade ROMs are named by MAME's short code ("mslug"). LaunchBox's MAME.xml maps it to the title;
// it is 46 MB, so it is read once, the first time an arcade ROM needs it.
let mameTitles = null;
function mameTitle(file) {
  if (!mameTitles) {
    mameTitles = new Map();
    try {
      const xml = fs.readFileSync(path.join(LAUNCHBOX, 'Metadata', 'MAME.xml'), 'utf8');
      const block = /<MameFile>([\s\S]*?)<\/MameFile>/g;
      let m;
      while ((m = block.exec(xml))) {
        const code = xmlText(m[1], 'FileName').toLowerCase(), title = xmlText(m[1], 'Name');
        if (code && title && title.toLowerCase() !== code) mameTitles.set(code, { title, year: xmlText(m[1], 'Year') });
      }
    } catch (e) { /* sin MAME.xml: se queda el nombre corto */ }
  }
  return mameTitles.get(file.replace(/\.zip$/i, '').toLowerCase()) || null;
}
// Arcade romset lists: FinalBurn Neo's and MAME 2003-Plus's public DATs (name -> description, parent, BIOS, CHD,
// every ROM with its CRC). Downloaded once, boiled down and kept in cache/libretro. They give arcade games
// their real titles and tell which core can run each ZIP.
const DATS = {
  fbneo: { url: 'https://raw.githubusercontent.com/libretro/FBNeo/master/dats/' + encodeURIComponent('FinalBurn Neo (ClrMame Pro XML, Arcade only).dat') },
  // MAME 2003 itself is not used: EmulatorJS 4.2.3's build of that core crashes on every game (checked).
  mame2003_plus: { url: 'https://raw.githubusercontent.com/libretro/mame2003-plus-libretro/master/metadata/mame2003-plus.xml' }
};
const xmlDecode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const xmlAttrs = s => { const a = {}; for (const m of s.matchAll(/([\w:]+)="([^"]*)"/g)) a[m[1]] = xmlDecode(m[2]); return a; };
function parseDat(xml) {
  const games = {};
  for (const m of xml.matchAll(/<game\s([^>]*?)>([\s\S]*?)<\/game>/g)) {
    const a = xmlAttrs(m[1]);
    if (!a.name) continue;
    const roms = [];
    for (const r of m[2].matchAll(/<rom\s([^>]*?)\/?>/g)) {
      const x = xmlAttrs(r[1]);
      if (x.name && x.status !== 'nodump') roms.push([x.name, (x.crc || '').toLowerCase(), x.merge ? 1 : 0]);
    }
    const desc = m[2].match(/<description>([^<]*)<\/description>/);
    games[a.name.toLowerCase()] = { d: desc ? xmlDecode(desc[1]) : '', c: (a.cloneof || '').toLowerCase(), r: (a.romof || '').toLowerCase(), b: a.isbios === 'yes' || a.runnable === 'no' ? 1 : 0, k: [...m[2].matchAll(/<disk\s([^>]*?)\/?>/g)].map(d => xmlAttrs(d[1]).name).filter(Boolean), f: roms };
  }
  return games;
}
const dats = new Map();
// A DAT as Map(code -> game), or null while it is not on disk yet (then it is downloaded in the background).
function datFor(which) {
  if (options.libretro === false) return null;
  let d = dats.get(which), stale = false;
  if (d === undefined) {
    d = null; stale = true;
    try { const f = JSON.parse(fs.readFileSync(path.join(LR_DIR, 'dat-' + which + '.json'), 'utf8')); if (f.v !== 3) throw new Error('old'); d = new Map(Object.entries(f.games)); stale = Date.now() - f.at > LR_MAX_AGE; } catch (e) {}
    dats.set(which, d);
    if (!stale) return d;
  } else if (d || lrTried.get('dat-' + which) > Date.now() - 3600000) return d;
  const key = 'dat-' + which;
  if (!lrBusy.has(key) && !(lrTried.get(key) > Date.now() - 3600000)) {
    lrTried.set(key, Date.now());
    lrBusy.set(key, (async () => {
      const games = parseDat((await fetchDat(which)).toString('utf8'));
      fs.mkdirSync(LR_DIR, { recursive: true });
      fs.writeFileSync(path.join(LR_DIR, key + '.json'), JSON.stringify({ v: 3, at: Date.now(), games }));
      dats.set(which, new Map(Object.entries(games)));
      lrEpoch++; coverCache.clear();
    })().catch(() => {}).finally(() => lrBusy.delete(key)));
  }
  return d;
}
function fbneoTitle(file) {
  const code = file.replace(/\.zip$/i, '').toLowerCase();
  const g = (datFor('fbneo') || new Map()).get(code);
  if (!g || !g.d) return null;
  const title = g.d.replace(/ \(.*$/, ''), tags = [...g.d.slice(title.length).matchAll(/\(([^)]*)\)/g)].map(m => m[1]);
  return title && title !== code ? { title, year: '', tag: tags.join(' · ') } : null;
}
// Names (with CRC32) of what a ZIP holds, read from its central directory without unpacking.
const zipDirs = new Map();
function zipEntries(dir, code) {
  const full = path.join(dir, code + '.zip');
  let st;
  try { st = fs.statSync(full); } catch (e) { return null; }
  const hit = zipDirs.get(full);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.entries;
  const entries = { crcs: new Set(), names: new Set() };
  let fd;
  try {
    fd = fs.openSync(full, 'r');
    const tail = Buffer.alloc(Math.min(st.size, 65557));
    fs.readSync(fd, tail, 0, tail.length, st.size - tail.length);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0) throw new Error('no zip');
    const count = tail.readUInt16LE(end + 10), cd = Buffer.alloc(tail.readUInt32LE(end + 12));
    fs.readSync(fd, cd, 0, cd.length, tail.readUInt32LE(end + 16));
    for (let i = 0, p = 0; i < count && p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; i++) {
      const nameLen = cd.readUInt16LE(p + 28), skip = nameLen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
      entries.crcs.add(cd.readUInt32LE(p + 16).toString(16).padStart(8, '0'));
      entries.names.add(cd.toString('utf8', p + 46, p + 46 + nameLen).split('/').pop().toLowerCase());
      p += 46 + skip;
    }
  } catch (e) { entries.broken = true; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) {} }
  zipDirs.set(full, { size: st.size, mtime: st.mtimeMs, entries });
  return entries;
}
// null when `code` runs with this DAT's core, else { rank, reason }: lower ranks are closer to working.
// Games that run from a hard disk image (CHD). The browser emulators read at most version 3 and the page
// does not hand them the file yet, so these never run; the message says what is wrong with the user's file.
function chdProblem(dir, code, g) {
  const name = g.k[0], file = [code, g.c, g.r].filter(Boolean).map(c => path.join(dir, c, name + '.chd')).find(f => fs.existsSync(f));
  if (!file) return { rank: 3, reason: 'Falta el disco CHD (' + code + '\\' + name + '.chd)' };
  let version = 0;
  try { const fd = fs.openSync(file, 'r'), head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd); if (head.toString('latin1', 0, 8) === 'MComprHD') version = head.readUInt32BE(12); } catch (e) {}
  if (version >= 4) return { rank: 3, reason: 'Necesita su disco CHD en versión 3; el tuyo es v' + version + ' (MAME moderno), que el emulador del navegador todavía no lee' };
  return { rank: 3, reason: 'Necesita disco CHD: todavía no soportado' };
}
const PAGE_BIOS = ['neogeo', 'pgm', 'skns'];
function romsetProblem(dat, dir, code) {
  const g = dat.get(code);
  if (!g) return { rank: 9 };
  if (g.k.length) return chdProblem(dir, code, g);
  const own = zipEntries(dir, code);
  const sets = [own], absent = [], chain = [], seen = new Set([code]), todo = [g.r, g.c];
  while (todo.length && chain.length < 8) {
    const p = todo.pop();
    if (!p || seen.has(p)) continue;
    seen.add(p); chain.push(p);
    const pg = dat.get(p);
    if (pg) todo.push(pg.r, pg.c);
  }
  for (const p of chain) { const z = zipEntries(dir, p); if (z && !z.broken) sets.push(z); else absent.push(p); }
  const bios = absent.find(p => dat.get(p) && dat.get(p).b);
  if (bios) return { rank: 1, reason: 'Falta el BIOS ' + bios + '.zip' };
  // ROMs marked as merged come from the parent set; the ones that belong to a BIOS only need its ZIP to be there.
  const parentCrcs = new Set();
  for (const p of chain) { const pg = dat.get(p); if (pg && !pg.b) for (const f of pg.f) parentCrcs.add(f[1]); }
  // The page can hand the emulator one BIOS ZIP (see /api/arcade-bios). A game whose merged ROMs live in any other BIOS
  // set cannot start, even with the file in the folder (unless the ZIP carries those ROMs itself). A lone ROM
  // (a sound or MCU chip such as namcoc76) is not a system BIOS: Tekken starts without it.
  const merged = g.f.filter(f => f[2] && !(own && own.crcs.has(f[1]))).map(f => f[1]);
  const lacking = chain.find(p => dat.get(p) && dat.get(p).b && !PAGE_BIOS.includes(p) && dat.get(p).f.length > 1 && dat.get(p).f.some(f => merged.includes(f[1])));
  if (lacking) return { rank: 2, reason: 'Necesita el BIOS ' + lacking + '.zip, que el emulador todavía no recibe' };
  const found = ([name, crc]) => sets.some(z => crc && crc !== '00000000' ? z.crcs.has(crc) : z.names.has(name.toLowerCase()));
  if (g.f.every(f => (f[2] && !parentCrcs.has(f[1])) || found(f))) return null;
  return absent.length ? { rank: 1, reason: 'Falta el juego padre ' + absent[0] + '.zip' } : { rank: 2, reason: 'Versión de ROMs distinta' };
}
const compatCache = new Map();
// { core } with the best core for an arcade ZIP (FBNeo, else MAME 2003-Plus), { reason } when none can, or null while the DATs are unknown.
function arcadeCompat(dir, file, dirMtime) {
  const code = file.replace(/\.zip$/i, '').toLowerCase();
  let st;
  try { st = fs.statSync(path.join(dir, file)); } catch (e) { return null; }
  const key = dir + '|' + file, stamp = st.size + '|' + st.mtimeMs + '|' + dirMtime + '|' + lrEpoch + '|' + Math.floor(Date.now() / 60000);
  const hit = compatCache.get(key);
  if (hit && hit.stamp === stamp) return hit.value;
  const problems = [], loaded = { fbneo: datFor('fbneo'), mame2003_plus: datFor('mame2003_plus') };   // both start downloading together
  let value;
  for (const core of ['fbneo', 'mame2003_plus']) {
    const dat = loaded[core];
    if (!dat) { value = null; break; }
    const problem = romsetProblem(dat, dir, code);
    if (!problem) { value = { core }; break; }
    problems.push(problem);
  }
  if (value === undefined) {
    const best = problems.reduce((a, b) => b.rank < a.rank ? b : a);
    value = { reason: best.reason || 'No está en FBNeo ni en MAME 2003-Plus' };
  }
  compatCache.set(key, { stamp, value });
  return value;
}
function gameInfo(sys, file) {
  const known = launchBoxTitles().get(path.join(sys.dir, file).toLowerCase());
  const tidy = tidyName(file);
  // LaunchBox's own title first, then (arcade) MAME.xml and FinalBurn Neo's list, then the No-Intro
  // name of the thumbnail that matches the cleaned file name, then the cleaned file name.
  let found = known, tag = tidy.tag;
  if (!found && sys === SYSTEMS.arcade) {
    found = mameTitle(file);
    const dat = fbneoTitle(file);
    if (dat) { found = found || dat; tag = dat.tag || tag; }
  }
  if (!found && sys.lr) {
    const t = lrTitle(sys.id, matchKey(tidy.name));
    if (t) found = { title: t, year: '' };
  }
  return { name: found ? found.title : tidy.name || file, year: found ? found.year : '', tag, named: !!found };
}

// Per-folder listing cache: one readdir + stat per file, redone only when the folder
// (or LaunchBox's lists) change, so searching every console on each keystroke stays cheap.
const collator = new Intl.Collator();
const sysIndex = new Map();
// Lowercase, no accents or punctuation: "Pac-Man" and "pacman" look the same.
const squash = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
function systemItems(id) {
  const sys = SYSTEMS[id];
  let dirStat;
  try { dirStat = fs.statSync(sys.dir); } catch (e) { sysIndex.delete(id); return null; }
  const known = launchBoxTitles();
  const hit = sysIndex.get(id);
  if (hit && hit.mtime === dirStat.mtimeMs && hit.titles === known && hit.epoch === lrEpoch && Date.now() - hit.at < 60000) return hit;
  let files = [];
  try { files = fs.readdirSync(sys.dir); } catch (e) { sysIndex.delete(id); return null; }
  const items = [];
  // Switch: only base games are listed; their updates and DLC hang off them (groupSwitch).
  const deep = sys.deep ? groupSwitch(walkRoms(sys.dir, sys.exts)) : null;
  if (deep) files = deep.map(d => d.file);
  const deepBy = deep ? new Map(deep.map(d => [d.file, d])) : null;
  for (const f of files) {
    const low = f.toLowerCase();
    // BIOS and sound/CPU device sets: needed by some games, not playable on their own.
    if (id === 'arcade' && /^(neogeo|pgm|skns|stvbios|qsound|qsound_hle|m68705p5|namcoc76|tms320c32|ym2413|sys246|sys256|coh1002m)\.zip$/i.test(f)) continue;
    if (!sys.exts.some(e => low.endsWith(e))) continue;
    let size = 0;
    const part = deepBy && deepBy.get(f);
    try { const stat = fs.statSync(part ? part.full : path.join(sys.dir, f)); if (!stat.isFile()) continue; size = stat.size; } catch (e) { continue; }
    const { name, year, tag } = gameInfo(sys, f);
    // Search the full title and the file name: "metal slug" and "mslug" both work. The title also
    // goes in Spanish spelling (-tion -> -cion), so "internacional" finds "International Superstar Soccer".
    const title = squash(name);
    items.push({ file: f, name, year, size, tag, hay: title + ' ' + title.replace(/tion/g, 'cion') + ' ' + squash(f), system: id, compat: id === 'arcade' ? arcadeCompat(sys.dir, f, dirStat.mtimeMs) : null, full: part ? part.full : path.join(sys.dir, f), updates: part ? part.updates : [], dlc: part ? part.dlc : 0 });
  }
  items.sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.file, b.file));
  // Same title twice in one console (US and Europe dumps): tell them apart by region tag.
  const seen = new Map();
  for (const it of items) seen.set(it.name, (seen.get(it.name) || 0) + 1);
  for (const it of items) if (seen.get(it.name) > 1 && it.tag) it.variant = it.tag;
  const next = { mtime: dirStat.mtimeMs, titles: known, epoch: lrEpoch, at: Date.now(), items, byFile: new Map(items.map(it => [it.file, it])) };
  sysIndex.set(id, next);
  return next;
}
function gameJson(it) {
  const sys = SYSTEMS[it.system];
  // Arcade: the core that can run the ZIP (FBNeo, else MAME 2003); when none can, the player still tries FBNeo.
  const core = it.system === 'nes' || (it.system === 'subidos' && /\.nes$/i.test(it.file)) ? '&core=nes' : it.compat && it.compat.core ? '&core=' + it.compat.core : '';
  // The user's own image (./covers), else the first source that knows this game.
  const local = localCover(it.system, it.file), cover = local ? { id: 'l' + local.v } : coverList(it.system, it.file)[0];
  const out = {
    file: it.file, name: it.name, year: it.year, size: it.size, system: it.system, systemLabel: sys.label,
    play: sys.pcOnly ? null : '/play-ejs.html?system=' + it.system + '&file=' + encodeURIComponent(it.file) + core,
    cover: cover ? '/api/cover/' + it.system + '/' + encodeURIComponent(it.file) + '?v=' + cover.id + '-' + COVER_WIDTH : null
  };
  if (it.variant) out.variant = it.variant;
  // Opens in a native emulator on this PC (POST /api/launch); pcOnly: there is no web player at all.
  if (sys.emu) out.pc = true;
  // The user's own MAME checked the set (see mameVerdict): when it cannot open it, there is no button and the card says why.
  const native = sys.emu === 'mame' ? mameVerdict(it.file) : null;
  if (native && !native.ok) out.pc = false;
  if (sys.pcOnly) out.pcOnly = true;
  if (it.updates && (it.updates.length || it.dlc)) out.extra = [it.updates.length ? 'Actualización' + (it.updates[0].version ? ' v' + it.updates[0].version : '') : '', it.dlc ? it.dlc + ' DLC' : ''].filter(Boolean).join(' · ');
  if (it.compat && it.compat.reason) { out.compat = false; out.reason = it.compat.reason; }
  if (native && !native.ok && out.compat === false) { out.reason = native.reason; }   // nowhere to play it: say the more precise reason
  return out;
}
// sysId 'all' joins every console (minus `not`), same title in two consoles shows twice.
function listGames(sysId, q, limit, offset, not) {
  const ids = sysId === 'all' ? Object.keys(SYSTEMS).filter(id => id !== not) : getSys(sysId) ? [sysId] : [];
  if (!ids.length) return { total: 0, games: [] };
  let out = [], missing = null;
  for (const id of ids) {
    const index = systemItems(id);
    if (!index) { missing = SYSTEMS[id].dir; continue; }
    out = out.length ? out.concat(index.items) : index.items;
  }
  if (sysId !== 'all' && missing) return { total: 0, games: [], missing };
  const terms = String(q || '').split(/\s+/).map(squash).filter(Boolean);
  if (terms.length) out = out.filter(it => terms.every(t => it.hay.includes(t)));
  if (ids.length > 1) out = out.slice().sort((a, b) => collator.compare(a.name, b.name) || collator.compare(SYSTEMS[a.system].label, SYSTEMS[b.system].label) || collator.compare(a.file, b.file));
  const total = out.length;
  out = out.slice(offset || 0, limit ? (offset || 0) + limit : undefined);
  return { total, games: out.map(gameJson) };
}

// Covers: libretro-thumbnails (free, matched by exact title) is the main source; if LaunchBox is
// installed, its metadata (read only SQLite) is one more. An image is downloaded once, shrunk, and
// kept in ./cache/covers. Your own picture wins over those: ./covers/<system>/<rom name>.(png|jpg|jpeg|webp),
// in this project's folder. The games folder is only read, nothing is ever written there.
const COVER_CACHE = path.resolve(options.coverCacheDir || path.join(__dirname, 'cache', 'covers'));
const CUSTOM_COVERS = path.resolve(options.customCoversDir || path.join(__dirname, 'covers'));
const COVER_MAX = 24 * 1024 * 1024;
// Covers are stored small: WebP, 400 px wide at most (a card is ~190 px, sharp on 2x screens).
const COVER_WIDTH = 400;
let sharpLib;
function coverSharp() {
  if (sharpLib === undefined) { try { sharpLib = require('sharp'); } catch (e) { sharpLib = null; } }
  return sharpLib;
}
// Without sharp the original image is kept as is.
const coverFile = name => coverSharp() ? name.replace(/\.\w+$/, '.webp') : name;
// Own images per console (./covers/<console>/), found by the ROM's name without extension. The user's own
// .png/.jpg beat our .webp. The folder is read again every 10 s.
const COVER_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
const localCovers = new Map();
function localCover(sysId, file) {
  const dir = path.join(CUSTOM_COVERS, sysId);
  let hit = localCovers.get(sysId);
  if (!hit || hit.dir !== dir || Date.now() - hit.at > 10000) {
    const files = new Map();
    try {
      for (const name of fs.readdirSync(dir)) {
        const ext = path.extname(name).toLowerCase(), rank = COVER_EXTS.indexOf(ext), stem = name.slice(0, -ext.length).toLowerCase();
        if (rank >= 0 && (!files.has(stem) || rank < files.get(stem).rank)) files.set(stem, { name, rank });
      }
    } catch (e) { /* sin carpeta todavia */ }
    hit = { at: Date.now(), dir, files };
    localCovers.set(sysId, hit);
  }
  const found = hit.files.get(file.replace(/\.[^.]+$/, '').toLowerCase());
  if (!found) return null;
  const full = path.join(dir, found.name);
  try { return { full, v: Math.floor(fs.statSync(full).mtimeMs) }; } catch (e) { return null; }
}
// First match wins: box art, then a fan box, then a flyer, then a title or gameplay shot, marquee last.
const COVER_TYPES = ['Box - Front', 'Box - Front - Reconstructed', 'Fanart - Box - Front', 'Advertisement Flyer - Front', 'Screenshot - Game Title', 'Screenshot - Gameplay', 'Arcade - Marquee'];
const COVER_REGIONS = ['North America', 'United States', 'World'];
const COVER_FILE = /^[\w-]+\.(png|jpe?g|webp)$/i;
const articles = new Set(['the', 'a', 'an']);
const roman = { ii: '2', iii: '3', iv: '4', vi: '6', vii: '7', viii: '8', ix: '9' };
// "The Legend of Zelda: A Link to the Past" and "Legend of Zelda, The - Link to the Past (U)" match.
function matchKey(title) {
  return title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => !articles.has(w)).map(w => roman[w] || w).join(' ');
}
let lbDb;
let lbStmts = null;
const lbNames = new Map();
function coverDb() {
  if (lbDb) return lbDb;
  const file = path.join(LAUNCHBOX, 'Metadata', 'LaunchBox.Metadata.db');
  if (!fs.existsSync(file)) return null;
  try {
    // The one-time "SQLite is an experimental feature" notice is noise for the user; other warnings stay.
    const emit = process.emitWarning;
    process.emitWarning = (w, ...rest) => /SQLite is an experimental/.test(String(w)) || emit.call(process, w, ...rest);
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); } finally { process.emitWarning = emit; }
    lbDb = new DatabaseSync(file, { readOnly: true });
    lbStmts = {
      images: lbDb.prepare('SELECT FileName, Type, Region FROM GameImages WHERE DatabaseId = ?'),
      games: lbDb.prepare('SELECT DatabaseID AS id, Name AS name, ReleaseType AS type FROM Games WHERE Platform = ?'),
      alts: lbDb.prepare('SELECT a.AlternateName AS name, a.DatabaseID AS id FROM GameAlternateTitles a JOIN Games g ON g.DatabaseID = a.DatabaseID WHERE g.Platform = ?')
    };
  } catch (e) { lbDb = null; return null; }
  return lbDb;
}
// Best image for a LaunchBox game id: type order above, then the preferred regions.
function bestImage(id) {
  const rows = lbStmts.images.all(id).filter(r => COVER_FILE.test(r.FileName) && COVER_TYPES.includes(r.Type));
  let best = null, bestRank = Infinity;
  for (const r of rows) {
    const region = COVER_REGIONS.indexOf(r.Region);
    const rank = COVER_TYPES.indexOf(r.Type) * 10 + (region < 0 ? 5 : region);
    if (rank < bestRank) { best = r.FileName; bestRank = rank; }
  }
  return best;
}
// Games of one LaunchBox platform by normalized title (alternate titles too), ROM hacks last.
function platformNames(platform) {
  if (lbNames.has(platform)) return lbNames.get(platform);
  const rank = { Released: 0, Unlicensed: 1, Unreleased: 1, DLC: 2, Homebrew: 2, 'ROM Hack': 3 };
  const map = new Map();
  const add = (key, id, r) => { if (!key) return; const list = map.get(key) || []; list.push({ id, r }); map.set(key, list); };
  for (const g of lbStmts.games.all(platform)) add(matchKey(g.name), g.id, rank[g.type] ?? 1);
  for (const a of lbStmts.alts.all(platform)) add(matchKey(a.name), a.id, 4);
  lbNames.set(platform, map);
  return map;
}
const coverCache = new Map();
let coverStamp = null;
// libretro-thumbnails: free box art named after the No-Intro / MAME title, the main source of covers
// and of tidy names. Each console's directory listing is downloaded once into cache/libretro
// (renewed monthly); a ROM only gets a thumbnail whose title is exactly the same once normalized.
// lrEpoch changes whenever a new listing arrives, so cached names and covers are worked out again.
let lrEpoch = 0;
const LR_HOST = 'https://thumbnails.libretro.com/';
const LR_TYPES = ['Named_Boxarts', 'Named_Titles', 'Named_Snaps'];
const LR_DIR = path.resolve(options.libretroCacheDir || path.join(__dirname, 'cache', 'libretro'));
const LR_MAX_AGE = 30 * 24 * 3600 * 1000;
const lrIndex = new Map(), lrBusy = new Map(), lrTried = new Map();
const lrAbort = new AbortController();
// Names in the listing are percent-encoded; "[...]" marks dumps with hacks or bad dumps: skipped.
function lrStems(html) {
  const out = [];
  for (const m of html.matchAll(/<a href="([^"?\/][^"]*)\.png"/g)) {
    let stem;
    try { stem = decodeURIComponent(m[1].replace(/&amp;/g, '&')); } catch (e) { continue; }
    if (!stem.includes('[')) out.push(stem);
  }
  return out;
}
// Lower is better: USA/World, then Europe; betas, prototypes and the like last.
function lrRank(tags) {
  const region = /\b(USA|US|World)\b/.test(tags) ? 0 : /\bEurope\b/.test(tags) ? 1 : /\b(Japan|JP|Korea|China|Taiwan|Asia|Brazil|Hong Kong)\b/.test(tags) ? 3 : 2;
  return region + (/\b(Beta|Proto|Prototype|Demo|Sample|Unl|Pirate|Hack|Kiosk|Bootleg|Alt)\b/i.test(tags) ? 10 : 0);
}
// Match key -> best thumbnail: box art before title screen before snap, then region.
function lrBuild(sysId, libs) {
  const map = new Map();
  SYSTEMS[sysId].lr.forEach((lib, l) => LR_TYPES.forEach((type, t) => {
    for (const stem of (libs[lib] && libs[lib][type]) || []) {
      const title = stem.replace(/ \(.*$/, '');
      const rank = t * 100 + l * 50 + lrRank(stem.slice(title.length));
      // The file names swap "&" for "_" ("Rock _ Roll Racing").
      for (const k of new Set([matchKey(title), matchKey(title.replace(/_/g, ' and '))])) {
        const cur = k && map.get(k);
        if (k && (!cur || rank < cur.rank || (rank === cur.rank && stem.length < cur.stem.length))) map.set(k, { lib, type, stem, title, rank });
      }
    }
  }));
  return map;
}
function lrRefresh(sysId) {
  lrTried.set(sysId, Date.now());
  const job = (async () => {
    const libs = {};
    for (const lib of SYSTEMS[sysId].lr) {
      libs[lib] = {};
      for (const type of LR_TYPES) {
        try { libs[lib][type] = lrStems((await fetchLibretro(encodeURIComponent(lib) + '/' + type + '/')).toString('utf8')); }
        catch (e) { if (e.message !== 'HTTP 404') throw e; libs[lib][type] = []; }
      }
    }
    const at = Date.now(), file = path.join(LR_DIR, sysId + '.json');
    fs.mkdirSync(LR_DIR, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ at, libs }));
    fs.renameSync(file + '.tmp', file);
    lrIndex.set(sysId, { at, map: lrBuild(sysId, libs) });
    lrEpoch++; coverCache.clear();   // names and covers worked out before the listing arrived may improve now
  })().catch(() => {}).finally(() => lrBusy.delete(sysId));
  lrBusy.set(sysId, job);
}
// The listing comes from disk; a missing or old one is downloaded in the background (retried hourly).
function lrIndexFor(sysId) {
  let idx = lrIndex.get(sysId);
  if (idx === undefined) {
    idx = null;
    try { const d = JSON.parse(fs.readFileSync(path.join(LR_DIR, sysId + '.json'), 'utf8')); idx = { at: d.at, map: lrBuild(sysId, d.libs) }; } catch (e) {}
    lrIndex.set(sysId, idx);
  }
  if ((!idx || Date.now() - idx.at > LR_MAX_AGE) && !lrBusy.has(sysId) && !(lrTried.get(sysId) > Date.now() - 3600000)) lrRefresh(sysId);
  return idx;
}
// The No-Intro title of the thumbnail with this match key, for tidier names ("Rock _ Roll" is ambiguous: skipped).
function lrTitle(sysId, key) {
  if (!key || options.libretro === false) return null;
  const idx = lrIndexFor(sysId), c = idx && idx.map.get(key);
  if (!c || c.title.includes('_')) return null;
  return c.title.replace(/^(.+?), (The|A|An)( - .*)?$/i, (m, rest, article, sub) => article + ' ' + rest + (sub || ''));
}
function libretroCover(sysId, keys) {
  if (!SYSTEMS[sysId].lr || options.libretro === false) return null;
  const idx = lrIndexFor(sysId);
  for (const k of keys) {
    const c = idx && idx.map.get(k);
    // The name comes from a listing we downloaded, but it still must be a plain file name before it goes into a URL.
    if (c && /^[^\\/:*?"<>|\x00-\x1f]{1,200}$/.test(c.stem)) {
      const id = 'lr-' + crypto.createHash('sha1').update(c.lib + '/' + c.type + '/' + c.stem).digest('hex').slice(0, 16);
      return { id, file: id + '.png', lr: encodeURIComponent(c.lib) + '/' + c.type + '/' + encodeURIComponent(c.stem + '.png') };
    }
  }
  return null;
}
// Covers for a ROM, best first, each { id, file, lr? }: libretro's (exact title), then LaunchBox's if it
// is installed (by id, or by exact title). Empty when nothing is known for sure.
function coverList(sysId, file) {
  const sys = SYSTEMS[sysId];
  if (!sys.lb) return [];
  const known = launchBoxTitles();
  if (known !== coverStamp) { coverCache.clear(); coverStamp = known; }
  const key = sysId + '/' + file;
  if (coverCache.has(key)) return coverCache.get(key);
  const list = [];
  // Titles to match by name. Arcade file names are MAME codes: only a real title (LaunchBox, MAME.xml) counts.
  const info = gameInfo(sys, file), keys = [];
  for (const title of sysId === 'arcade' ? (info.named ? [info.name] : []) : [tidyName(file).name, info.name]) {
    const k = matchKey(title);
    if (k && !keys.includes(k)) keys.push(k);
  }
  const lr = libretroCover(sysId, keys);
  if (lr) list.push(lr);
  try {
    if (coverDb()) {
      const entry = known.get(path.join(sys.dir, file).toLowerCase());
      // In a LaunchBox list: its id is exact. Otherwise only an exact title match counts.
      const ids = entry && entry.id ? [entry.id] : [];
      for (const k of keys) ids.push(...(platformNames(sys.lb).get(k) || []).slice().sort((a, b) => a.r - b.r || a.id - b.id).map(c => c.id));
      for (const id of ids) {
        const name = bestImage(id);
        if (name) { list.push({ id: name.replace(/\.\w+$/, ''), file: name }); break; }
      }
    }
  } catch (e) { /* LaunchBox es opcional */ }
  coverCache.set(key, list);
  return list;
}
// Reads a response body, refusing anything bigger than `max`.
async function readBody(r, max) {
  const chunks = []; let size = 0;
  for await (const chunk of r.body) {
    size += chunk.length;
    if (size > max) throw new Error('respuesta demasiado grande');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
// Downloads one image from LaunchBox's CDN (the default `fetchCover`), refusing anything that is not a small image.
async function downloadCover(name) {
  const r = await fetch('https://images.launchbox-app.com/' + name, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (!/^image\//i.test(r.headers.get('content-type') || '')) throw new Error('no es una imagen');
  return readBody(r, COVER_MAX);
}
// A path under thumbnails.libretro.com (the default `fetchLibretro`): an image, or a directory listing when it ends in "/".
async function downloadLibretro(pathname) {
  const listing = pathname.endsWith('/');
  const r = await fetch(LR_HOST + pathname, { signal: AbortSignal.any([AbortSignal.timeout(listing ? 90000 : 20000), lrAbort.signal]) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (!new RegExp(listing ? '^text/html' : '^image/', 'i').test(r.headers.get('content-type') || '')) throw new Error('respuesta inesperada');
  return readBody(r, COVER_MAX);
}
// A romset list, "fbneo" or "mame2003_plus" (the default `fetchDat`).
async function downloadDat(which) {
  const r = await fetch(DATS[which].url, { signal: AbortSignal.any([AbortSignal.timeout(90000), lrAbort.signal]) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return readBody(r, 40 * 1024 * 1024);
}
const fetchCover = options.fetchCover || downloadCover;
const fetchLibretro = options.fetchLibretro || downloadLibretro;
const fetchDat = options.fetchDat || downloadDat;
const coverJobs = new Map(), coverFails = new Map();
let coverBusy = 0;
const coverQueue = [];
// A few downloads at a time (LaunchBox and libretro share the limit); the same ROM asked twice shares one download.
// Resolves to the image to serve: the one in ./cache/covers.
function ensureCover(sysId, file, cover) {
  const fallback = path.join(COVER_CACHE, coverFile(cover.file));
  if (fs.existsSync(fallback)) return Promise.resolve(fallback);
  const key = sysId + '/' + file;
  if (coverFails.get(cover.id) > Date.now()) return Promise.reject(new Error('reintento pendiente'));
  if (coverJobs.has(key)) return coverJobs.get(key);
  const job = new Promise((resolve, reject) => coverQueue.push({ cover, fallback, resolve, reject }));
  coverJobs.set(key, job);
  job.catch(() => {}).finally(() => coverJobs.delete(key));
  pumpCovers();
  return job;
}
// Writes through a temporary file so a half-written image is never served.
function saveCover(full, data) {
  const tmp = full + '.' + process.pid + '.tmp';
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, full);
  } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) {} throw e; }
}
function pumpCovers() {
  while (coverBusy < 4 && coverQueue.length) {
    const { cover, fallback, resolve, reject } = coverQueue.shift();
    coverBusy++;
    (async () => {
      try {
        let data = cover.lr ? await fetchLibretro(cover.lr) : await fetchCover(cover.file);
        if (coverSharp()) data = await coverSharp()(data).resize({ width: COVER_WIDTH, withoutEnlargement: true, fit: 'inside' }).webp({ quality: 80 }).toBuffer();
        saveCover(fallback, data);
        resolve(fallback);
      } catch (e) {
        coverFails.set(cover.id, Date.now() + 60000);
        reject(e);
      } finally { coverBusy--; pumpCovers(); }
    })();
  }
}

applyRoot();

const app = express();
app.use(express.json());
// The guest link is just the address: visitors land on the room, the library is for this PC.
app.get('/', (req, res, next) => fromThisPc(req) ? next() : res.redirect(302, '/sala'));
app.get('/sala', (req, res) => res.sendFile(path.join(__dirname, 'public', 'live.html')));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

// Ambos protocolos comparten el servidor HTTP, sin un proxy ni otro proceso.

// Folder paths are for this PC only: whoever comes through the tunnel just sees counts.
app.get('/api/systems', (req, res) => {
  const local = fromThisPc(req);
  res.json({
    gamesRoot: local ? GAMES_ROOT : undefined,
    owner: local && hostOk(req),   // may the page offer "Jugar en la PC" (the same test /api/launch applies)
    systems: Object.keys(SYSTEMS).map(id => {
      const index = systemItems(id);
      return { id, label: SYSTEMS[id].label, count: index ? index.items.length : 0, writable: !!SYSTEMS[id].writable, core: SYSTEMS[id].ejs || null, pc: !!SYSTEMS[id].emu, pcOnly: !!SYSTEMS[id].pcOnly, onlinePlayers: 2, onlineExperimental: id !== 'nes', missing: index ? null : local ? SYSTEMS[id].dir : true };
    })
  });
});

// Games folder settings: only this PC, only with the page's own header (a web page open in the same
// browser cannot send it cross-origin), and the Host must be this PC (no DNS rebinding).
const hostOk = req => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '');
const ownerOnly = word => (req, res, next) => fromThisPc(req) && hostOk(req) && req.get('x-remotegame') === word ? next() : res.status(403).json({ ok: false, msg: 'no permitido' });
function describeRoot() {
  return {
    ok: true, gamesRoot: GAMES_ROOT, locked: ROOT_LOCKED, exists: isDir(GAMES_ROOT),
    consoles: Object.keys(DEFAULT_DIRS).map(id => ({ id, label: SYSTEMS[id].label, dir: consoleDirs[id] ? consoleDirs[id].dir : null, count: consoleDirs[id] ? consoleDirs[id].n : 0 }))
  };
}
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }
// A path typed or pasted by the user: surrounding quotes (Windows' "Copy as path") are dropped.
function cleanDir(value) {
  const p = String(value || '').trim().replace(/^"(.*)"$/, '$1');
  return p && p.length < 1000 && !/[\x00-\x1f]/.test(p) ? path.resolve(p) : null;
}
app.get('/api/settings', ownerOnly('settings'), (req, res) => res.json(describeRoot()));
// What would be found in a folder, without saving it.
app.post('/api/settings/scan', ownerOnly('settings'), (req, res) => {
  const dir = cleanDir(req.body && req.body.gamesRoot);
  if (!dir || !isDir(dir)) return res.status(400).json({ ok: false, msg: 'Esa carpeta no existe.' });
  const found = findConsoleDirs(dir);
  res.json({ ok: true, gamesRoot: dir, consoles: Object.keys(DEFAULT_DIRS).map(id => ({ id, label: SYSTEMS[id].label, dir: found[id] ? found[id].dir : null, count: found[id] ? found[id].n : 0 })) });
});
app.post('/api/settings', ownerOnly('settings'), (req, res) => {
  const dir = cleanDir(req.body && req.body.gamesRoot);
  if (!dir || !isDir(dir)) return res.status(400).json({ ok: false, msg: 'Esa carpeta no existe.' });
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...readSettings(), gamesRoot: dir }, null, 2)); }
  catch (e) { return res.status(500).json({ ok: false, msg: 'No pude guardar los ajustes.' }); }
  if (!ROOT_LOCKED) { GAMES_ROOT = dir; applyRoot(); }
  res.json(describeRoot());
});
// The native folder dialog of Windows, opened by the server (the page cannot read a real path).
let picking = false;
app.post('/api/settings/pick', ownerOnly('settings'), async (req, res) => {
  if (picking) return res.status(409).json({ ok: false, msg: 'Ya hay un selector abierto.' });
  picking = true;
  try { res.json({ ok: true, path: await pickFolder() }); }
  catch (e) { res.status(501).json({ ok: false, msg: e.message }); }
  finally { picking = false; }
});
const pickFolder = options.pickFolder || (() => new Promise((resolve, reject) => {
  if (process.platform !== 'win32') return reject(new Error('El selector solo existe en Windows: escribí la ruta.'));
  // The owner form keeps the dialog in front of the browser; the output is UTF-8 for accented paths.
  const script = "Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
    "$o = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0; StartPosition = 'CenterScreen' }; $o.Show(); " +
    "$f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Elegí la carpeta donde están tus juegos'; $f.ShowNewFolderButton = $false; " +
    "if ($f.ShowDialog($o) -eq 'OK') { Write-Output $f.SelectedPath }; $o.Close()";
  require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-Command', script],
    { windowsHide: true, timeout: 180000, encoding: 'utf8' }, (err, out) => err ? reject(new Error('No pude abrir el selector de carpetas.')) : resolve(out.trim() || null));
}));

// Native emulators on this PC. Each is found inside the games folder (up to 4 levels, a folder called "Emulador"
// first) unless a path says otherwise; in order of priority: options.emulators, the MAME_EXE / EDEN_EXE / FLYCAST_EXE
// variables, settings.json -> emulators: { mame, eden, flycast }, then the search. RemoteGame only starts them: their
// own config and saves are theirs. Flycast is found but no console uses it yet.
const EMULATORS = {
  mame: {
    name: 'MAME',
    // The keyboard provider makes MAME see the keys vpad.js injects; -nowindow is full screen even if the ini says window; the games folder goes first in the ROM path (the ini is left alone).
    args: (exe, sys, it) => {
      const code = it.file.replace(/\.zip$/i, '');
      if (!/^\w+$/.test(code)) throw new Error('Nombre de juego inválido');
      return [code, '-keyboardprovider', 'win32', '-nowindow', '-rompath', sys.dir + ';roms'];
    }
  },
  // Eden is a yuzu fork: -g <file> boots a game and -f starts it full screen (src/core/launch_params.cpp: --game, --fullscreen).
  eden: { name: 'Eden', args: (exe, sys, it) => ['-f', '-g', it.full] },
  flycast: { name: 'Flycast', args: (exe, sys, it) => [it.full] }
};
const isFile = p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
function scanEmulators(root) {
  const want = new Map(Object.keys(EMULATORS).map(id => [id + '.exe', id]));
  const skip = /^(roms?|covers|node_modules|artwork|bios|firmware|keys|\$recycle\.bin|system volume information)$/i;
  const found = {}, rank = {};
  const queue = [[root, 0, false]];
  for (let i = 0; i < queue.length && i < 3000; i++) {
    const [dir, depth, inEmu] = queue[i];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      const id = e.isFile() ? want.get(e.name.toLowerCase()) : null;
      const r = (inEmu ? 0 : 10) + depth;
      if (id && (!found[id] || r < rank[id])) { found[id] = path.join(dir, e.name); rank[id] = r; }
      else if (e.isDirectory() && depth < 4 && !e.name.startsWith('.') && !skip.test(e.name)) queue.push([path.join(dir, e.name), depth + 1, inEmu || /emulad|emulator/i.test(e.name)]);
    }
  }
  return found;
}
// { exe, configured }: exe is null when not found (or the configured path is not a file). The search is cached;
// a miss is searched again at most every 5 s, so an emulator copied in meanwhile shows up.
function findEmulator(id) {
  const set = (options.emulators || {})[id] || process.env[id.toUpperCase() + '_EXE'] || (readSettings().emulators || {})[id];
  if (set) { const p = cleanDir(set); return { exe: p && isFile(p) ? p : null, configured: true }; }
  if (!emuCache || emuCache.root !== GAMES_ROOT || (!isFile(emuCache.found[id] || '') && Date.now() - emuCache.at > 5000)) emuCache = { root: GAMES_ROOT, at: Date.now(), found: scanEmulators(GAMES_ROOT) };
  return { exe: emuCache.found[id] || null, configured: false };
}
// Which arcade sets the user's own MAME can open. `mame -verifyroms <sets>` reads the whole folder in about 2 s, so it runs once in
// the background (never before the server answers), and its verdict is kept in cache/mame-compat.json by MAME version and folder
// stamp. It only reads: MAME is never given a window. Nothing known yet (or no MAME) means "assume it opens".
const MAME_CACHE = path.resolve(options.mameCacheFile || path.join(__dirname, 'cache', 'mame-compat.json'));
const runMame = options.runMame || ((exe, args) => new Promise(resolve => {
  // MAME exits with 5 when some set is bad: the output is what counts, not the code.
  execFile(exe, args, { cwd: path.dirname(exe), windowsHide: true, timeout: 120000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, out, errOut) => resolve(err && !out ? '' : String(out || '') + '\n' + String(errOut || '')));
}));
const mameCompat = { map: null, stamp: null, version: '', busy: false, checkedAt: 0 };
// Output of `mame -verifyroms a b c` -> Map(set -> { ok: true } | { ok: false, reason }).
function parseVerify(text, version) {
  const out = new Map(), detail = new Map();
  const mame = 'MAME' + (version ? ' ' + version : '');
  for (const raw of String(text).split(/\r?\n/)) {
    let m;
    if ((m = raw.match(/^romset (\S+)(?: \[\S+\])? is (good|best available|bad)\s*$/))) {
      if (m[2] !== 'bad') { out.set(m[1].toLowerCase(), { ok: true }); continue; }
      const lines = detail.get(m[1]) || [], line = lines.find(l => /NOT FOUND/.test(l) && !/NO GOOD DUMP/.test(l)) || lines[0] || '';
      const file = line.replace(/\s*\(.*$/, ''), dev = (line.match(/NOT FOUND \(([^)]+)\)/) || [])[1];
      out.set(m[1].toLowerCase(), { ok: false, reason: mame + ' lo tiene, pero ' + (file ? 'le falta ' + file + (dev ? ' (de ' + dev + ')' : '') : 'sus archivos están incompletos o no coinciden') });
    } else if ((m = raw.match(/^No matching systems found for '(.+)'\s*$/))) {
      out.set(m[1].replace(/\.zip$/i, '').toLowerCase(), { ok: false, reason: mame + ' no conoce este juego' });
    } else if ((m = raw.match(/^(\S+)\s+: (.+?)\s*$/))) {
      if (!detail.has(m[1])) detail.set(m[1], []);
      detail.get(m[1]).push(m[2]);
    }
  }
  return out;
}
// What identifies the folder as it is now: its ZIPs with their sizes and times.
function arcadeStamp(dir, exe, version) {
  const hash = crypto.createHash('sha1').update(exe + '|' + version);
  let names;
  try { names = fs.readdirSync(dir).filter(f => /\.zip$/i.test(f)).sort(); } catch (e) { return null; }
  for (const f of names) { try { const st = fs.statSync(path.join(dir, f)); hash.update(f + st.size + ':' + st.mtimeMs + ';'); } catch (e) { /* gone */ } }
  return { stamp: hash.digest('hex'), names };
}
async function refreshMameCompat() {
  if (mameCompat.busy) return;
  mameCompat.busy = true;
  try {
    const exe = findEmulator('mame').exe, dir = SYSTEMS.arcade.dir;
    if (!exe) return;
    const version = String(await runMame(exe, ['-version'])).trim().split(/\s+/)[0] || '';
    const cur = arcadeStamp(dir, exe, version);
    if (!cur || cur.stamp === mameCompat.stamp) return;
    let map = null;
    try { const c = JSON.parse(fs.readFileSync(MAME_CACHE, 'utf8')); if (c.stamp === cur.stamp) map = new Map(Object.entries(c.results)); } catch (e) { /* no cache yet */ }
    if (!map) {
      const t0 = Date.now(), text = [];
      const sets = cur.names.map(f => f.replace(/\.zip$/i, '')).filter(c => /^\w+$/.test(c));
      for (let i = 0; i < sets.length; i += 300) text.push(await runMame(exe, ['-verifyroms', ...sets.slice(i, i + 300), '-rompath', dir + ';roms']));
      map = parseVerify(text.join('\n'), version);
      if (!map.size) return;   // MAME did not answer: stay optimistic
      try { fs.mkdirSync(path.dirname(MAME_CACHE), { recursive: true }); fs.writeFileSync(MAME_CACHE, JSON.stringify({ stamp: cur.stamp, version, results: Object.fromEntries(map) })); } catch (e) { /* the cache is optional */ }
      log.write('mame', 'verificados ' + sets.length + ' sets en ' + (Date.now() - t0) + ' ms: ' + [...map.values()].filter(v => !v.ok).length + ' no se pueden abrir');
    }
    Object.assign(mameCompat, { map, stamp: cur.stamp, version });
  } catch (e) { log.error('mame', e); } finally { mameCompat.busy = false; }
}
const mameNative = !testing || !!options.runMame;
// { ok, reason } for an arcade ZIP, or null while unknown. Looks at the folder again every 15 s (a ROM copied in meanwhile).
function mameVerdict(file) {
  if (!mameNative) return null;
  if (Date.now() - mameCompat.checkedAt > 15000) { mameCompat.checkedAt = Date.now(); refreshMameCompat(); }
  return mameCompat.map && mameCompat.map.get(file.replace(/\.zip$/i, '').toLowerCase()) || null;
}
if (mameNative) setTimeout(() => { mameCompat.checkedAt = Date.now(); refreshMameCompat(); }, 0).unref();

// Opens a game in its native emulator and a browser window of its own that streams it (stream-browser.js). Only this PC with its
// header; one emulator started by RemoteGame at a time. When the emulator closes, its stream window closes and the pads are let go.
// The emulator's output goes to a file (not a pipe: it must never block, nor break if RemoteGame restarts) and is read if it exits at once.
const spawnEmulator = options.spawnEmulator || require('child_process').spawn;
const killProcess = options.killProcess || sysProc.kill;
const EMU_LOG = path.resolve(options.emulatorLogFile || (testing ? path.join(os.tmpdir(), 'remotegame-test-emulator.log') : path.join(__dirname, 'cache', 'emulator-output.log')));
const EARLY_EXIT = options.earlyExit ?? 5000;   // an exit with an error before this many ms is a failed start (state.failed tells the page why)
// Under `node --test` the stream window (real browser, PowerShell) stays off unless a test passes options.stream (fakes).
const streamer = options.stream === false || (testing && !options.stream) ? null : createStreamer({
  browser: options.browser === undefined ? findBrowser() : options.browser,
  profile: path.resolve(options.streamProfile || path.join(__dirname, 'cache', 'stream-browser')),
  port: () => server.address()?.port || PORT,
  isConnected: () => !!party.host && party.game?.mode === 'stream',
  log: text => log.write('stream', text),
  headless: options.streamHeadless ?? readSettings().streamHeadless !== false,   // settings.json -> "streamHeadless": false brings the (off screen) window back
  ...options.stream
});
let running = null, lastFailure = null;   // lastFailure: { name, emulator, msg } of the latest start that did not work, until the next click
function endSession(entry) {
  if (entry.ended) return;
  entry.ended = entry.done = true;
  if (streamer) streamer.stop().catch(e => log.error('stream', e));
  vpadDo(v => v.releaseAll());
}
// The first line of the emulator's output that says what went wrong (MAME: "spc700.rom NOT FOUND (...)").
function usefulLine(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.replace(/[\u0000-\u001f]/g, ' ').trim()).filter(Boolean);
  const hit = lines.find(l => /not found|missing|failed|cannot|can't|unable|invalid|error|fatal/i.test(l)) || lines[0] || '';
  return hit.length > 200 ? hit.slice(0, 197) + '…' : hit;
}
function readEmulatorOutput() { try { return fs.readFileSync(EMU_LOG, 'utf8').slice(0, 65536); } catch (e) { return ''; } }
// What is wrong with the virtual pads, in words, for the emulator being played (none: for both).
function padWarnings(system) {
  let st;
  try { st = game.vpad.status(); } catch (e) { return []; }
  const out = [];
  if (st.dsu && st.dsu.error && (!system || system === 'switch')) out.push(/ocupado/.test(st.dsu.error) ? '⚠️ Otro programa usa el puerto ' + st.dsu.port + ': los mandos de tus amigos no van a llegar a Eden' : '⚠️ No se pudo abrir el puerto ' + st.dsu.port + ' de los mandos para Eden');
  if (st.keys && st.keys.error && (!system || system === 'arcade')) out.push('⚠️ No se pudo activar el teclado simulado para MAME');
  return out;
}
app.post('/api/launch', ownerOnly('launch'), async (req, res) => {
  try {
    const body = req.body || {};
    const sys = getSys(body.system), file = safeFile(body.file);
    if (!sys || !file) return res.status(400).json({ ok: false, msg: 'Sistema o archivo inválido.' });
    const emu = EMULATORS[sys.emu];
    if (!emu) return res.status(400).json({ ok: false, msg: 'Ese sistema no se abre en un emulador de la PC.' });
    const index = systemItems(sys.id), it = index && index.byFile.get(file);
    if (!it) return res.status(404).json({ ok: false, msg: 'Ese juego no está en la biblioteca.' });
    if (running && !running.done) return res.status(409).json({ ok: false, busy: true, emulator: running.emulator, name: running.name, system: running.system, msg: 'Ya abrí ' + running.emulator + ' para ' + running.name + '. Tocá Terminar para abrir otro juego.' });
    const found = findEmulator(sys.emu);
    if (!found.exe) return res.status(404).json({ ok: false, msg: found.configured ? 'La ruta de ' + emu.name + ' en los ajustes no existe.' : 'No encontré ' + emu.name + ' en tu carpeta de juegos.' });
    lastFailure = null;
    const native = sys.emu === 'mame' ? mameVerdict(file) : null;
    if (native && !native.ok) return res.status(409).json({ ok: false, msg: emu.name + ' no pudo abrir ' + it.name + ': ' + native.reason + '.' });
    const entry = running = { emulator: emu.name, name: it.name, system: sys.id, done: false, pid: null };   // taken before awaiting: two clicks cannot both launch
    const startedAt = Date.now();
    let failure = null, outFd = null;
    try {
      try { fs.mkdirSync(path.dirname(EMU_LOG), { recursive: true }); outFd = fs.openSync(EMU_LOG, 'w'); } catch (e) { outFd = null; }
      const child = spawnEmulator(found.exe, emu.args(found.exe, sys, it), { cwd: path.dirname(found.exe), detached: true, stdio: outFd === null ? 'ignore' : ['ignore', outFd, outFd], windowsHide: false });
      entry.pid = child.pid;
      log.write('launch', emu.name + ' ' + it.name + ' (' + file + ') pid ' + child.pid);
      // A missing or blocked program reports its error on the next tick; one that starts and dies reports it on exit.
      child.on('error', e => { failure = failure || e; log.write('launch', emu.name + ' error: ' + e.message); endSession(entry); });
      child.on('exit', (code, signal) => {
        const lived = Date.now() - startedAt;
        log.write('launch', emu.name + ' ' + it.name + ' terminó (código ' + code + (signal ? ', señal ' + signal : '') + ') tras ' + lived + ' ms');
        if (lived < EARLY_EXIT && (code || signal) && !entry.ended && !entry.stopping) {
          const line = usefulLine(readEmulatorOutput());
          entry.failure = lastFailure = { name: it.name, emulator: emu.name, msg: emu.name + ' no pudo abrir ' + it.name + ': ' + (line || 'se cerró enseguida (código ' + (code ?? signal) + ')') };
          log.write('launch', entry.failure.msg);
        }
        endSession(entry);
      });
      if (child.unref) child.unref();
      await new Promise(resolve => setImmediate(resolve));
    } catch (e) { failure = e; log.error('launch', e); }
    finally { if (outFd !== null) try { fs.closeSync(outFd); } catch (e) { /* closed */ } }
    if (failure) { endSession(entry); if (running === entry) running = null; return res.status(500).json({ ok: false, msg: 'No pude abrir ' + emu.name + ': ' + (failure.code === 'ENOENT' ? 'el programa no existe.' : failure.message) }); }
    if (streamer && !entry.ended) streamer.start({ pid: entry.pid, name: entry.name, system: entry.system }).catch(e => log.error('stream', e));
    if (entry.failure) return res.status(500).json({ ok: false, msg: entry.failure.msg });
    res.json({ ok: true, emulator: emu.name, name: it.name });
  } catch (e) {
    log.error('launch', e);
    if (!res.headersSent) res.status(500).json({ ok: false, msg: 'No pude abrir el emulador: ' + e.message });
  }
});
// What the library shows while a game from RemoteGame is open: stream is starting | on | cut | nobrowser | off.
// failed: why the latest start did not work (the emulator closed at once), until the next click.
app.get('/api/launch/state', ownerOnly('launch'), (req, res) => {
  const e = running && !running.done ? running : null;
  res.json({ ok: true, running: !!e, emulator: e ? e.emulator : null, name: e ? e.name : null, system: e ? e.system : null, stream: e && streamer ? streamer.state() : 'off', warnings: padWarnings(e && e.system), failed: e ? null : lastFailure });
});
// "Terminar": closes the emulator RemoteGame opened (only that process) and, with it, the stream window.
app.post('/api/launch/stop', ownerOnly('launch'), async (req, res) => {
  const e = running;
  try { if (e && !e.done) { e.stopping = true; await killProcess(e.pid); endSession(e); } } catch (err) { log.error('launch', err); if (e) endSession(e); }
  res.json({ ok: true });
});
// "Volver a transmitir": the stream window was closed but the emulator is still there.
app.post('/api/launch/stream', ownerOnly('launch'), (req, res) => {
  const e = running;
  if (!e || e.done || !streamer) return res.status(409).json({ ok: false, msg: 'No hay un juego abierto desde RemoteGame.' });
  streamer.start({ pid: e.pid, name: e.name, system: e.system }).catch(err => log.error('stream', err));
  res.json({ ok: true });
});

app.get('/api/games', (req, res) => {
  const sysId = String(req.query.system || 'nes').toLowerCase();
  // system=all searches every console; not=<id> leaves one out (the "other consoles" section).
  const sys = sysId === 'all' ? { label: 'Todas' } : getSys(sysId);
  if (!sys) return res.status(400).json({ error: 'sistema invalido' });
  const limit = Math.min(Number(req.query.limit) || 200, 2000), offset = Math.max(Number(req.query.offset) || 0, 0);
  const r = listGames(sysId, String(req.query.q || ''), limit, offset, String(req.query.not || '').toLowerCase());
  res.json({ system: sysId, label: sys.label, total: r.total, offset, games: r.games, missing: r.missing ? (fromThisPc(req) ? r.missing : true) : null });
});

// One game, same JSON as the list (the player page shows its title instead of the file name).
app.get('/api/game/:system/:file', (req, res) => {
  const sys = getSys(req.params.system);
  const f = safeFile(req.params.file);
  if (!sys || !f) return res.status(400).json({ error: 'sistema o archivo invalido' });
  const index = systemItems(req.params.system.toLowerCase());
  const it = index && index.byFile.get(f);
  if (!it) return res.status(404).json({ error: 'juego no encontrado' });
  res.json(gameJson(it));
});

// Cover image of a game in the collection. Public on purpose (the page shows it to guests
// too), but only images that LaunchBox or libretro list for games that exist here are ever downloaded.
app.get('/api/cover/:system/:file', async (req, res) => {
  const sys = getSys(req.params.system);
  const f = safeFile(req.params.file);
  if (!sys || !f) return res.status(400).send('sistema o archivo invalido');
  const id = req.params.system.toLowerCase();
  const index = systemItems(id);
  if (!index || !index.byFile.has(f)) return res.status(404).send('sin portada');
  const send = full => { res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); res.sendFile(full, { cacheControl: false, dotfiles: 'allow' }); };
  const local = localCover(id, f);
  if (local) return send(local.full);
  const covers = coverList(id, f);
  if (!covers.length) return res.status(404).send('sin portada');
  // If one source's image cannot be downloaded, the next gets its turn.
  for (const cover of covers) {
    try { return send(await ensureCover(id, f, cover)); } catch (e) { /* siguiente fuente */ }
  }
  res.status(502).send('no se pudo bajar la portada');
});

// Sirve ROM en modo lectura. NES .zip -> extrae el .nes en memoria (para jsnes).
app.get('/api/rom/:system/:file', (req, res) => {
  const sys = getSys(req.params.system);
  if (!sys) return res.status(400).send('sistema invalido');
  if (sys.pcOnly) return res.status(404).send('este sistema solo corre en un emulador de la PC');
  const f = safeFile(req.params.file);
  if (!f || !sys.exts.includes(path.extname(f).toLowerCase())) return res.status(400).send('nombre o formato invalido');
  const full = path.join(sys.dir, f);
  if (!full.startsWith(sys.dir) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return res.status(404).send('no existe');

  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/octet-stream');

  if (req.query.raw !== '1' && (req.params.system === 'nes' || req.params.system === 'subidos') && /\.zip$/i.test(f)) {
    try {
      const zip = new AdmZip(full);
      const entries = zip.getEntries().filter(e => !e.isDirectory && /\.nes$/i.test(e.entryName));
      if (!entries.length) return res.status(415).send('el zip no contiene .nes');
      if (entries[0].header.size > 16 * 1024 * 1024) return res.status(413).send('ROM NES descomprimida demasiado grande');
      res.attachment(path.basename(entries[0].entryName));
      return res.send(Buffer.from(entries[0].getData()));
    } catch (e) {
      return res.status(500).send('no se pudo abrir el zip');
    }
  }
  res.attachment(f);
  return res.sendFile(full);
});

// Compat v0.1: /api/rom/:file buscaba en NES y Subidos
app.get('/api/rom/:file', (req, res) => {
  const f = safeFile(req.params.file);
  if (!f) return res.status(400).send('nombre invalido');
  for (const id of ['nes', 'subidos']) {
    const full = path.join(SYSTEMS[id].dir, f);
    if (full.startsWith(SYSTEMS[id].dir) && fs.existsSync(full)) {
      return res.redirect(302, '/api/rom/' + id + '/' + encodeURIComponent(f));
    }
  }
  return res.status(404).send('no existe');
});

// Subidas: SOLO a ./roms local, nunca a GAMES.
const upload = multer({
  dest: LOCAL_ROMS,
  limits: { fileSize: 128 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(nes|zip|bin|md|smd|gen)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('formato no soportado'));
  }
});
// With a tunnel up anyone holding the link reaches this server: only this PC may write.
// Tunnels (ngrok) connect from localhost too, but always add X-Forwarded-For.
function fromThisPc(req) {
  return /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '') && !req.headers['x-forwarded-for'];
}
app.post('/api/upload', (req, res, next) => fromThisPc(req) ? next() : res.status(403).json({ ok: false, msg: 'Solo se puede subir desde la PC anfitriona' }), upload.single('rom'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, msg: 'sin archivo' });
  const name = safeFile(req.file.originalname);
  if (!name || name.startsWith('.')) { fs.unlinkSync(req.file.path); return res.status(400).json({ ok: false, msg: 'nombre invalido' }); }
  const target = path.join(LOCAL_ROMS, name);
  try {
    if (!target.startsWith(LOCAL_ROMS)) throw new Error('ruta invalida');
    if (fs.existsSync(target)) fs.unlinkSync(target);
    fs.renameSync(req.file.path, target);
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch (e2) {}
    return res.status(500).json({ ok: false, msg: 'no se pudo guardar' });
  }
  sysIndex.delete('subidos');
  res.json({ ok: true, file: path.basename(target) });
});

// STUN alone fails behind CGNAT/symmetric NAT; a TURN relay can be set via environment.
app.get('/api/ice', (req, res) => {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URLS) {
    servers.push({ urls: process.env.TURN_URLS.split(',').map(s => s.trim()).filter(Boolean), username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' });
  }
  res.json(servers);
});

// Addresses a guest can open: this PC on the home network, and the tunnel if one is up.
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|WSL|VirtualBox|VMware|Hyper-V|Loopback|Tailscale|ZeroTier/i.test(name)) continue;
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
  }
  return out;
}
// What the virtual pads are doing (DSU port and clients, keyboard helper, seats). Only this PC.
app.get('/api/vpad', (req, res) => fromThisPc(req) ? res.json(game.vpad.status()) : res.status(403).json({ ok: false, msg: 'no permitido' }));
app.get('/api/info', (req, res) => {
  const port = server.address()?.port || PORT;
  res.json({ port, gamesRoot: fromThisPc(req) ? GAMES_ROOT : undefined, version: '0.5.0', build: BUILD, lanUrls: lanUrls(), publicUrl: game.publicUrl || null });
});
// A newer launch asks this instance to step aside (see the startup block). Only this PC may ask, and
// only with a custom header: a web page cannot send one cross-origin without a CORS preflight, which
// is never granted. The Host check also stops a page that rebinds its domain to 127.0.0.1.
const onQuit = options.onQuit || (() => process.exit(0));
app.post('/api/quit', ownerOnly('quit'), (req, res) => {
  res.json({ ok: true });
  res.on('finish', () => setTimeout(onQuit, 50));
});

// FBNeo searches BIOS ZIPs alongside the ROM, at the virtual filesystem root.
app.get('/api/arcade-bios', (req, res) => {
  const files = {};
  for (const name of ['neogeo.zip', 'pgm.zip', 'skns.zip']) {
    if (fs.existsSync(path.join(SYSTEMS.arcade.dir, name))) {
      files['/' + name] = name;
    }
  }
  res.json(files);
});
// With EJS_dontExtractBIOS, EmulatorJS writes the BIOS to its virtual FS using the
// URL itself as the path, so it must be a bare file name next to the ROM.
app.get(/^\/(neogeo|pgm|skns)\.zip$/, (req, res) => {
  const full = path.join(SYSTEMS.arcade.dir, req.params[0] + '.zip');
  if (!fs.existsSync(full)) return res.status(404).send('no existe');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(full);
});
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ ok: false, msg: err.message });
});
const server = http.createServer(app);
const netplay = require('./netplay-node/functions').attach(server, app);
// Video offers carry several KB of SDP; inputs stay tiny.
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/ws') wss.handleUpgrade(req, socket, head, ws => { ws.local = fromThisPc(req); wss.emit('connection', ws); });
  else if (!pathname.startsWith('/socket.io/')) socket.destroy();
});
const rooms = new Map();
function send(ws, value) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(value));
}
function broadcast(room, value) { for (const ws of room.players) send(ws, value); }
function leave(ws) {
  const room = rooms.get(ws.room);
  ws.room = null;
  if (!room) return;
  // Closing the host ends the session; promoting without transferring state desyncs.
  if (room.players[0] === ws) {
    rooms.delete(room.id);
    for (const peer of room.players.slice(1)) {
      peer.room = null;
      send(peer, { t: 'ended', msg: 'El anfitrión cerró la sala. Creá una nueva partida.' });
    }
  } else {
    room.players = room.players.filter(peer => peer !== ws);
    room.phase = 'waiting';
    room.ready.clear();
    broadcast(room, { t: 'peer-left', count: 1 });
  }
}
wss.on('connection', ws => {
  ws._socket.setNoDelay(true);
  ws.on('error', () => {});
  ws.on('message', buffer => {
    let m;
    try { m = JSON.parse(buffer); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'latency') return send(ws, { t: 'latency', ts: m.ts });
    if (m.t === 'host') {
      // Only a page opened on this PC can host: the tunnel must not let anyone take over.
      if (!ws.local) return send(ws, { t: 'error', msg: 'Solo la PC anfitriona puede abrir juegos' });
      let info;
      if (m.mode === 'stream') {
        // A native emulator on this PC, captured as video: no ROM; the guests' pads go to the virtual pads (vpad).
        const name = typeof m.name === 'string' ? m.name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
        info = { mode: 'stream', core: 'native', analog: true, name: name || 'Juego de la PC' };
      } else {
        const system = String(m.system || '');
        const sys = getSys(system);
        const rom = safeFile(m.rom);
        const core = String(m.core || '');
        if (!sys || !rom || !/^[a-z0-9]{1,20}$/.test(core) || !sys.exts.includes(path.extname(rom).toLowerCase()) || !fs.existsSync(path.join(sys.dir, rom))) return send(ws, { t: 'error', msg: 'Juego inválido o inexistente' });
        info = { system, rom, core, name: gameInfo(sys, rom).name };
      }
      // Opening another game (or reloading) replaces the previous host page.
      if (party.host && party.host !== ws) { party.host.partyRole = null; send(party.host, { t: 'replaced' }); }
      // A different host or game: nothing the guests held on the virtual pads may stay pressed.
      if (party.host) vpadDo(v => v.releaseAll());
      party.host = ws; ws.partyRole = 'host';
      party.game = info;
      send(ws, { t: 'hosting', guest: guestSlots().length > 0, slots: guestSlots(), name: party.game.name });
      party.guests.forEach((guest, slot) => {
        if (!guest) return;
        send(guest, { t: 'game', game: party.game, player: slot + 2 });
        send(ws, { t: 'peer', slot });
      });
      return;
    }
    if (m.t === 'guest') {
      if (ws.partyRole === 'host') return;
      // The id is the seat: a reload or a network switch comes back as the same player.
      // Absent (an old page): a fresh one every time, so it just takes a free seat.
      if (m.id !== undefined && !(typeof m.id === 'string' && /^[\w-]{1,64}$/.test(m.id))) return send(ws, { t: 'error', msg: 'Identificador inválido' });
      const id = m.id || crypto.randomUUID();
      if (ws.partyRole === 'guest' && ws.guestId !== id) leaveParty(ws);
      let slot = party.guests.findIndex(g => g?.guestId === id);
      if (slot < 0) slot = party.held.findIndex((h, i) => h && h.id === id && !party.guests[i]);
      if (slot < 0) {
        // A seat someone just dropped from is kept for them a few seconds (4G switch): used last.
        const now = Date.now();
        slot = party.guests.findIndex((g, i) => !g && !(party.held[i] && party.held[i].until > now));
        if (slot < 0) slot = party.guests.findIndex(g => !g);
        if (slot < 0) return send(ws, { t: 'full' });
      }
      const old = party.guests[slot];
      if (old && old !== ws) { old.partyRole = null; send(old, { t: 'replaced' }); vpadDo(v => v.release(slot)); }
      party.guests[slot] = ws; party.held[slot] = null;
      ws.partyRole = 'guest'; ws.guestId = id; ws.slot = slot;
      send(ws, { t: 'game', game: party.host ? party.game : null, player: slot + 2 });
      send(party.host, { t: 'peer', slot });
      return;
    }
    // Signals are routed by seat and the sender is filled in here, never taken from the message:
    // a guest only talks to the host and cannot pose as another seat.
    if (ws.partyRole && m.t === 'signal' && m.data) {
      if (ws.partyRole === 'guest') return send(party.host, { t: 'signal', from: ws.slot, data: m.data });
      return send(Number.isInteger(m.to) ? party.guests[m.to] : null, { t: 'signal', data: m.data });
    }
    // Stream mode only: the host page relays a guest's pad to its virtual pad. Nobody else may, and an
    // EmulatorJS host never does (its guests are read inside the page).
    if (m.t === 'vpad') {
      if (ws !== party.host || party.game?.mode !== 'stream') return;
      const slot = m.slot;
      if (!Number.isInteger(slot) || slot < 0 || slot > 2) return;
      if (m.release) return vpadDo(v => v.release(slot));
      if (!party.guests[slot]) return;   // the guest is gone: a late packet must not bring its pad back
      const axis = v => Math.max(-127, Math.min(127, Math.round(Number(v)) || 0));
      const state = { b: (Number(m.b) | 0) & 0xffff, x: axis(m.x), y: axis(m.y), rx: axis(m.rx), ry: axis(m.ry) };
      return vpadDo(v => v.update(slot, state));
    }
    if (m.t === 'create') {
      if (ws.room) return send(ws, { t: 'error', msg: 'Ya estás en una sala' });
      const system = String(m.system || 'nes');
      const sys = getSys(system);
      const rom = safeFile(m.rom);
      if (!['nes', 'subidos'].includes(system) || !sys || !rom || !/\.(nes|zip)$/i.test(rom) || !fs.existsSync(path.join(sys.dir, rom))) return send(ws, { t: 'error', msg: 'ROM NES inválida o inexistente' });
      let id;
      do { id = crypto.randomBytes(6).toString('hex').toUpperCase(); } while (rooms.has(id));
      const room = { id, system, rom, players: [ws], epoch: 0, ready: new Set(), phase: 'waiting' };
      rooms.set(id, room);
      ws.room = id;
      return send(ws, { t: 'created', room: id, system, rom, role: 'p1' });
    }
    if (m.t === 'join') {
      if (ws.room) return send(ws, { t: 'error', msg: 'Ya estás en una sala' });
      const room = rooms.get(String(m.room || '').trim().toUpperCase());
      if (!room) return send(ws, { t: 'error', msg: 'Sala inexistente' });
      if (room.players.length >= 2) return send(ws, { t: 'error', msg: 'Sala llena: este modo admite 2 jugadores' });
      room.players.push(ws);
      ws.room = room.id;
      send(ws, { t: 'joined', room: room.id, kind: room.kind || 'nes', system: room.system, rom: room.rom, core: room.core, role: 'p2' });
      return broadcast(room, { t: 'peer', count: 2 });
    }
    const room = rooms.get(ws.room);
    if (!room) return;
    if ((m.t === 'start' || m.t === 'resync') && room.kind !== 'live') {
      if (room.players[0] !== ws) return;
      if (room.players.length !== 2) return send(ws, { t: 'error', msg: 'Esperá a que entre P2' });
      room.epoch++;
      room.delay = Math.max(1, Math.min(6, Number(m.delay) || 2)) | 0;
      room.ready.clear();
      room.phase = 'loading';
      return broadcast(room, { t: 'reset', epoch: room.epoch });
    }
    if (m.t === 'ready' && room.phase === 'loading' && m.epoch === room.epoch) {
      room.ready.add(ws);
      if (room.ready.size === 2) {
        room.phase = 'running';
        broadcast(room, { t: 'start', epoch: room.epoch, delay: room.delay });
      }
      return;
    }
    if (m.t === 'input' && room.phase === 'running' && m.epoch === room.epoch && Number.isInteger(m.frame) && m.frame >= 0 && m.frame <= 1e9 && Number.isInteger(m.pad) && m.pad >= 0 && m.pad <= 255) {
      return send(room.players.find(peer => peer !== ws), { t: 'input', epoch: room.epoch, frame: m.frame, pad: m.pad });
    }
    if (m.t === 'signal' && m.data && room.players.length === 2) {
      return send(room.players.find(peer => peer !== ws), { t: 'signal', data: m.data });
    }
    if (m.t === 'ping' || m.t === 'pong') send(room.players.find(peer => peer !== ws), { t: m.t, ts: m.ts });
  });
  ws.on('close', () => { leaveParty(ws); leave(ws); });
});
// The party: one permanent link, up to 3 guests (P2-P4, seats 0-2), whatever game the host opens.
const party = { host: null, guests: [null, null, null], held: [null, null, null], game: null };
const guestSlots = () => party.guests.flatMap((g, slot) => g ? [slot] : []);
// The virtual pads (game.vpad, from vpad.js or options.vpad) may be missing or fail: the party goes on.
const vpadDo = fn => { try { if (game.vpad) fn(game.vpad); } catch (e) { console.log('vpad: ' + e.message); } };
function leaveParty(ws) {
  if (ws.partyRole === 'host' && party.host === ws) {
    party.host = null;
    vpadDo(v => v.releaseAll());
    for (const guest of party.guests) send(guest, { t: 'host-left' });
  } else if (ws.partyRole === 'guest' && party.guests[ws.slot] === ws) {
    party.guests[ws.slot] = null;
    party.held[ws.slot] = { id: ws.guestId, until: Date.now() + 15000 };
    vpadDo(v => v.release(ws.slot));
    send(party.host, { t: 'peer-left', slot: ws.slot });
  }
  ws.partyRole = null;
}
app.get('/api/party', (req, res) => {
  const slots = guestSlots();
  res.json({ publicUrl: game.publicUrl || null, lanUrls: lanUrls(), guest: slots.length > 0, guests: slots.length, slots, players: slots.map(s => s + 2), hosting: !!party.host, game: party.host ? party.game : null, tunnel: tunnel.state() });
});
// The switch of the banner. Only this PC: a guest's page gets 403. The choice is kept in settings.json
// (share) and read at startup, so it survives restarts.
app.get('/api/tunnel', ownerOnly('tunnel'), (req, res) => res.json({ ok: true, tunnel: tunnel.state() }));
app.post('/api/tunnel', ownerOnly('tunnel'), (req, res) => {
  const on = req.body && req.body.on;
  if (typeof on !== 'boolean') return res.status(400).json({ ok: false, msg: 'Falta on (true o false).' });
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...readSettings(), share: on }, null, 2)); }
  catch (e) { return res.status(500).json({ ok: false, msg: 'No pude guardar los ajustes.' }); }
  res.json({ ok: true, tunnel: on ? tunnel.start() : tunnel.stop() });
});
// The ngrok tunnel: guests outside the home network reach this server through it. Only pages and
// signaling go through it; video and controls travel over WebRTC. One ngrok at a time (free plan: one session).
const tun = { state: 'off', error: null, proc: null };
const spawnTunnel = options.spawnTunnel || require('child_process').spawn;
let hooked = false;
const tunnel = {
  state: () => ({ state: tun.state, url: game.publicUrl, error: tun.error }),
  // Only a saved "off" keeps it down: a new install starts with the tunnel on.
  wanted: () => readSettings().share !== false,
  start() {
    if (tun.proc) return tunnel.state();
    const child = spawnTunnel('ngrok', ['http', String(server.address()?.port || PORT), '--log', 'stdout', '--log-format', 'json'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    Object.assign(tun, { state: 'starting', error: null, proc: child });
    game.publicUrl = null;
    // Errors count only while starting: a tunnel that is up keeps running through ngrok's own reconnects.
    const note = text => {
      console.log('ngrok: ' + text);
      if (tun.state === 'starting') tun.error = /authtoken|authentication failed|ERR_NGROK_4018/i.test(text) ? 'Falta configurar el authtoken de ngrok' : text.split('\n')[0].slice(0, 200);
    };
    const onLine = line => {
      let entry; try { entry = JSON.parse(line); } catch { return; }
      if (child !== tun.proc) return;
      if (entry.url && /^https:/.test(entry.url) && tun.state === 'starting') {
        tun.state = 'on';
        game.publicUrl = entry.url;
        console.log('\n  Link para tu amigo:  ' + entry.url + '\n  (es siempre el mismo; pasáselo una sola vez)\n');
      } else if (entry.lvl === 'eror' || (entry.err && entry.err !== '<nil>')) note(String(entry.err && entry.err !== '<nil>' ? entry.err : entry.msg));
    };
    let buffer = '';
    child.stdout.on('data', chunk => { buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop(); lines.forEach(onLine); });
    child.stderr.on('data', chunk => { if (child === tun.proc) note(String(chunk).trim()); });
    // ENOENT: ngrok is not on the PATH. Clearing tun.proc turns the exit that may follow into a no-op.
    child.on('error', err => {
      if (child !== tun.proc) return;
      Object.assign(tun, { state: 'error', error: err.code === 'ENOENT' ? 'ngrok no está instalado (winget install ngrok.ngrok)' : err.message, proc: null });
      game.publicUrl = null;
    });
    child.on('exit', code => {
      if (child !== tun.proc) return;   // stopped on purpose, or already reported
      Object.assign(tun, { state: 'error', error: tun.error || 'ngrok se cerró (código ' + code + ')', proc: null });
      game.publicUrl = null;
    });
    if (!hooked) {
      hooked = true;
      // Ctrl+C, closing the console (SIGHUP) or quitting must not leave ngrok running.
      process.on('exit', () => tunnel.stop());
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { tunnel.stop(); process.exit(0); });
    }
    return tunnel.state();
  },
  stop() {
    const child = tun.proc;
    Object.assign(tun, { state: 'off', error: null, proc: null });
    game.publicUrl = null;
    if (child) try { child.kill(); } catch {}
    return tunnel.state();
  }
};
async function close() {
  tunnel.stop();
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  await new Promise(resolve => netplay.io.close(resolve));
  if (server.listening) await new Promise(resolve => server.close(resolve));
  lrAbort.abort();
  if (streamer) await streamer.close();
  await game.vpad.close?.();
  await Promise.all([...lrBusy.values()]);
  try { if (lbDb) lbDb.close(); } catch (e) {}
  lbDb = null;
}
const lanUrls = () => lanAddresses().map(ip => 'http://' + ip + ':' + (server.address()?.port || PORT));
return Object.assign(game, { log, app, server, wss, rooms, party, netplay, vpad: game.vpad, close, lanUrls, tunnel, coversReady: () => Promise.all([...lrBusy.values()]), killStream: () => streamer && streamer.killNowSync(), emulators: () => Object.fromEntries(Object.keys(EMULATORS).map(id => [id, findEmulator(id).exe])) });
}
function openBrowser(url) {
  require('child_process').spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
}
// The RemoteGame answering on this port (its /api/info), or null if it is some other program.
async function runningInstance(port) {
  try {
    const info = await (await fetch('http://127.0.0.1:' + port + '/api/info', { signal: AbortSignal.timeout(2000) })).json();
    return info && info.version && Array.isArray(info.lanUrls) ? info : null;
  } catch (e) { return null; }
}
async function askToQuit(port) {
  try { return (await fetch('http://127.0.0.1:' + port + '/api/quit', { method: 'POST', headers: { 'X-RemoteGame': 'quit' }, signal: AbortSignal.timeout(3000) })).status; } catch (e) { return 0; }
}
if (require.main === module) {
  // Whatever an emulator, the stream window or a dependency throws without a catch is logged (cache/remotegame.log), not fatal.
  installCrashGuard(process, defaultLog);
  const game = createRemoteGame({ log: defaultLog });
  const port = Number(process.env.PORT || cfg.port);
  // --open (desktop shortcut, pnpm start): show the library in the browser.
  const open = process.argv.includes('--open');
  if (open) process.title = 'RemoteGame';
  const show = () => { if (open) openBrowser('http://localhost:' + port); setTimeout(() => process.exit(0), 3000); };
  let replaced = false, deadline = 0;
  const listen = () => game.server.listen(port);
  // The stream window is ours: it never outlives RemoteGame (Ctrl+C, closing the console, quitting).
  process.on('exit', () => game.killStream());
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0));
  // The port is taken. Another RemoteGame with different code (an update) is asked to quit and this one
  // takes its place; one with the same code keeps serving (a game in progress is not cut off).
  game.server.on('error', async err => {
    if (err.code !== 'EADDRINUSE') { defaultLog.error('listen', err); return void setTimeout(() => process.exit(1), 3000); }   // not an uncaught error: there is nothing to serve
    if (deadline) {   // waiting for the old one to let go of the port
      if (Date.now() < deadline) return void setTimeout(listen, 250);
      console.log('La versión anterior de RemoteGame no se cerró: cerrá su ventana y volvé a abrir el acceso directo.');
      return show();
    }
    const old = await runningInstance(port);
    if (!old) { console.log('El puerto ' + port + ' lo usa otro programa: cerralo o elegí otro con PORT.'); return void setTimeout(() => process.exit(1), 3000); }
    if (old.build === BUILD) { console.log('RemoteGame ya está abierto. Abriendo el navegador…'); return show(); }
    console.log('Hay una versión anterior de RemoteGame abierta. Reemplazándola…');
    if (await askToQuit(port) !== 200) {
      // Versions before this one cannot be asked (no /api/quit): only their own window can close them.
      console.log('Hay una versión vieja de RemoteGame abierta: cerrá su ventana y volvé a abrir el acceso directo.');
      return show();
    }
    replaced = true; deadline = Date.now() + 10000;
    setTimeout(listen, 300);
  });
  game.server.once('listening', () => {
    console.log('RemoteGame v0.5.0 en http://localhost:' + port);
    defaultLog.write('server', 'arrancó en el puerto ' + port + ' (pid ' + process.pid + ', node ' + process.version + ')');
    for (const ip of game.lanUrls()) console.log('Misma red:  ' + ip);
    // --no-share and SHARE=0 start it off for this run only; otherwise the saved switch (settings.json) decides.
    // After a replacement, give ngrok a moment to notice the old tunnel is gone (the free plan allows one).
    if (!process.argv.includes('--no-share') && process.env.SHARE !== '0' && game.tunnel.wanted()) setTimeout(() => game.tunnel.start(), replaced ? 2500 : 0);
    if (open) openBrowser('http://localhost:' + port);
    if (open) console.log('Cerrá esta ventana para apagar RemoteGame.');
  });
  listen();
}
module.exports = { createRemoteGame, groupSwitch };
