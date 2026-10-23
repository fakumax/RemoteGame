// RemoteGame: biblioteca local de solo lectura y netplay NES 2P
// La carpeta GAMES LAUNCHBOX EMULATOR se usa SIEMPRE en modo SOLO LECTURA.
// Lo unico que se escribe es ./roms (subidas desde la web).
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { WebSocketServer } = require('ws');

let cfg = { port: 3000 };
try {
  cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')));
} catch (e) { /* config opcional */ }

function createRemoteGame(options = {}) {
const PORT = options.port ?? (process.env.PORT ? Number(process.env.PORT) : cfg.port);
const GAMES_ROOT = path.resolve(options.gamesRoot || process.env.GAMES_ROOT || path.join(os.homedir(), 'Desktop', 'GAMES LAUNCHBOX EMULATOR'));
const LOCAL_ROMS = path.resolve(options.localRoms || path.join(__dirname, 'roms'));
const LAUNCHBOX = path.resolve(options.launchBoxDir || process.env.LAUNCHBOX_DIR || path.join(os.homedir(), 'LaunchBox'));
fs.mkdirSync(LOCAL_ROMS, { recursive: true });
const game = { publicUrl: null };

// Sistemas. dir de GAMES = lectura. Solo 'subidos' permite escritura.
const SYSTEMS = {
  nes:     { label: 'NES / Family', dir: path.join(GAMES_ROOT, 'NES'), exts: ['.nes', '.zip'], ejs: 'nes', lb: 'Nintendo Entertainment System' },
  genesis: { label: 'Sega Genesis', dir: path.join(GAMES_ROOT, 'Sega Genesis'), exts: ['.bin', '.md', '.smd', '.gen', '.zip'], ejs: 'segaMD', lb: 'Sega Genesis' },
  arcade:  { label: 'Arcade / Neo Geo', dir: path.join(GAMES_ROOT, 'MAME', 'Roms'), exts: ['.zip'], ejs: 'fbneo', lb: 'Arcade' },
  snes: { label: 'Super Nintendo', dir: path.join(GAMES_ROOT, 'Super Nintendo', 'Roms'), exts: ['.sfc', '.smc', '.zip'], ejs: 'snes', lb: 'Super Nintendo Entertainment System' },
  n64: { label: 'Nintendo 64', dir: path.join(GAMES_ROOT, 'Nintendo 64', 'Roms'), exts: ['.z64', '.n64', '.v64', '.zip'], ejs: 'n64', lb: 'Nintendo 64' },
  subidos: { label: 'Subidos', dir: LOCAL_ROMS, exts: ['.nes', '.zip', '.bin', '.md', '.smd', '.gen'], writable: true }
};

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
function gameInfo(sys, file) {
  const known = launchBoxTitles().get(path.join(sys.dir, file).toLowerCase());
  const tidy = tidyName(file);
  return { name: known ? known.title : tidy.name || file, year: known ? known.year : '', tag: tidy.tag };
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
  if (hit && hit.mtime === dirStat.mtimeMs && hit.titles === known && Date.now() - hit.at < 60000) return hit;
  let files = [];
  try { files = fs.readdirSync(sys.dir); } catch (e) { sysIndex.delete(id); return null; }
  const items = [];
  for (const f of files) {
    const low = f.toLowerCase();
    // BIOS and sound/CPU device sets: needed by some games, not playable on their own.
    if (id === 'arcade' && /^(neogeo|pgm|skns|stvbios|qsound|qsound_hle|m68705p5|namcoc76|tms320c32|ym2413|sys246|sys256|coh1002m)\.zip$/i.test(f)) continue;
    if (!sys.exts.some(e => low.endsWith(e))) continue;
    let size = 0;
    try { const stat = fs.statSync(path.join(sys.dir, f)); if (!stat.isFile()) continue; size = stat.size; } catch (e) { continue; }
    const { name, year, tag } = gameInfo(sys, f);
    // Search the full title and the file name: "metal slug" and "mslug" both work.
    items.push({ file: f, name, year, size, tag, hay: squash(name) + ' ' + squash(f), system: id });
  }
  items.sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.file, b.file));
  // Same title twice in one console (US and Europe dumps): tell them apart by region tag.
  const seen = new Map();
  for (const it of items) seen.set(it.name, (seen.get(it.name) || 0) + 1);
  for (const it of items) if (seen.get(it.name) > 1 && it.tag) it.variant = it.tag;
  const next = { mtime: dirStat.mtimeMs, titles: known, at: Date.now(), items, byFile: new Map(items.map(it => [it.file, it])) };
  sysIndex.set(id, next);
  return next;
}
function gameJson(it) {
  const sys = SYSTEMS[it.system];
  const core = it.system === 'nes' || (it.system === 'subidos' && /\.nes$/i.test(it.file)) ? '&core=nes' : '';
  const cover = coverName(it.system, it.file);
  const out = {
    file: it.file, name: it.name, year: it.year, size: it.size, system: it.system, systemLabel: sys.label,
    play: '/play-ejs.html?system=' + it.system + '&file=' + encodeURIComponent(it.file) + core,
    cover: cover ? '/api/cover/' + it.system + '/' + encodeURIComponent(it.file) + '?v=' + cover.replace(/\.\w+$/, '') + '-' + COVER_WIDTH : null
  };
  if (it.variant) out.variant = it.variant;
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

// Covers: LaunchBox's metadata (read only SQLite) says which image belongs to a game; the
// image itself is downloaded once from LaunchBox's CDN into ./cache/covers and served from there.
const COVER_CACHE = path.resolve(options.coverCacheDir || path.join(__dirname, 'cache', 'covers'));
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
// File name of the cover image for a ROM, or null (no database, no safe match, no image).
function coverName(sysId, file) {
  if (!SYSTEMS[sysId].lb || !coverDb()) return null;
  const known = launchBoxTitles();
  if (known !== coverStamp) { coverCache.clear(); coverStamp = known; }
  const key = sysId + '/' + file;
  if (coverCache.has(key)) return coverCache.get(key);
  let name = null;
  try {
    const entry = known.get(path.join(SYSTEMS[sysId].dir, file).toLowerCase());
    // In a LaunchBox list: its id is exact. Otherwise only an exact title match counts (arcade names are MAME codes).
    const ids = entry && entry.id ? [entry.id] : [];
    if (sysId !== 'arcade') {
      const list = platformNames(SYSTEMS[sysId].lb).get(matchKey(tidyName(file).name)) || [];
      ids.push(...list.slice().sort((a, b) => a.r - b.r || a.id - b.id).map(c => c.id));
    }
    for (const id of ids) { name = bestImage(id); if (name) break; }
  } catch (e) { name = null; }
  coverCache.set(key, name);
  return name;
}
// Downloads one image from LaunchBox's CDN (the default `fetchCover`), refusing anything that is not a small image.
async function downloadCover(name) {
  const r = await fetch('https://images.launchbox-app.com/' + name, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (!/^image\//i.test(r.headers.get('content-type') || '')) throw new Error('no es una imagen');
  const chunks = []; let size = 0;
  for await (const chunk of r.body) {
    size += chunk.length;
    if (size > COVER_MAX) throw new Error('imagen demasiado grande');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const fetchCover = options.fetchCover || downloadCover;
const coverJobs = new Map(), coverFails = new Map();
let coverBusy = 0;
const coverQueue = [];
// A few downloads at a time; the same image asked twice shares one download.
function ensureCover(name) {
  const full = path.join(COVER_CACHE, coverFile(name));
  if (fs.existsSync(full)) return Promise.resolve(full);
  if (coverFails.get(name) > Date.now()) return Promise.reject(new Error('reintento pendiente'));
  if (coverJobs.has(name)) return coverJobs.get(name);
  const job = new Promise((resolve, reject) => coverQueue.push({ name, full, resolve, reject }));
  coverJobs.set(name, job);
  job.catch(() => {}).finally(() => coverJobs.delete(name));
  pumpCovers();
  return job;
}
function pumpCovers() {
  while (coverBusy < 4 && coverQueue.length) {
    const { name, full, resolve, reject } = coverQueue.shift();
    coverBusy++;
    (async () => {
      fs.mkdirSync(COVER_CACHE, { recursive: true });
      const tmp = full + '.' + process.pid + '.tmp';
      try {
        let data = await fetchCover(name);
        if (coverSharp()) data = await coverSharp()(data).resize({ width: COVER_WIDTH, withoutEnlargement: true, fit: 'inside' }).webp({ quality: 80 }).toBuffer();
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, full);
        resolve(full);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        coverFails.set(name, Date.now() + 60000);
        reject(e);
      } finally { coverBusy--; pumpCovers(); }
    })();
  }
}

const app = express();
app.use(express.json());
// The guest link is just the address: visitors land on the room, the library is for this PC.
app.get('/', (req, res, next) => fromThisPc(req) ? next() : res.redirect(302, '/sala'));
app.get('/sala', (req, res) => res.sendFile(path.join(__dirname, 'public', 'live.html')));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

// Ambos protocolos comparten el servidor HTTP, sin un proxy ni otro proceso.

app.get('/api/systems', (req, res) => {
  res.json({
    gamesRoot: GAMES_ROOT,
    systems: Object.keys(SYSTEMS).map(id => {
      const index = systemItems(id);
      return { id, label: SYSTEMS[id].label, count: index ? index.items.length : 0, writable: !!SYSTEMS[id].writable, core: SYSTEMS[id].ejs || null, onlinePlayers: 2, onlineExperimental: id !== 'nes', missing: index ? null : SYSTEMS[id].dir };
    })
  });
});

app.get('/api/games', (req, res) => {
  const sysId = String(req.query.system || 'nes').toLowerCase();
  // system=all searches every console; not=<id> leaves one out (the "other consoles" section).
  const sys = sysId === 'all' ? { label: 'Todas' } : getSys(sysId);
  if (!sys) return res.status(400).json({ error: 'sistema invalido' });
  const limit = Math.min(Number(req.query.limit) || 200, 2000), offset = Math.max(Number(req.query.offset) || 0, 0);
  const r = listGames(sysId, String(req.query.q || ''), limit, offset, String(req.query.not || '').toLowerCase());
  res.json({ system: sysId, label: sys.label, dir: sys.writable ? sys.dir : '(solo lectura)', total: r.total, offset, games: r.games, missing: r.missing || null });
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
// too), but only images LaunchBox lists for games that exist here are ever downloaded.
app.get('/api/cover/:system/:file', async (req, res) => {
  const sys = getSys(req.params.system);
  const f = safeFile(req.params.file);
  if (!sys || !f) return res.status(400).send('sistema o archivo invalido');
  const index = systemItems(req.params.system.toLowerCase());
  const name = index && index.byFile.has(f) ? coverName(req.params.system.toLowerCase(), f) : null;
  if (!name) return res.status(404).send('sin portada');
  try {
    const full = await ensureCover(name);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(full, { cacheControl: false });
  } catch (e) {
    res.status(502).send('no se pudo bajar la portada');
  }
});

// Sirve ROM en modo lectura. NES .zip -> extrae el .nes en memoria (para jsnes).
app.get('/api/rom/:system/:file', (req, res) => {
  const sys = getSys(req.params.system);
  if (!sys) return res.status(400).send('sistema invalido');
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
app.get('/api/info', (req, res) => {
  const port = server.address()?.port || PORT;
  res.json({ port, gamesRoot: GAMES_ROOT, version: '0.5.0', lanUrls: lanUrls(), publicUrl: game.publicUrl || null });
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
      const system = String(m.system || '');
      const sys = getSys(system);
      const rom = safeFile(m.rom);
      const core = String(m.core || '');
      if (!sys || !rom || !/^[a-z0-9]{1,20}$/.test(core) || !sys.exts.includes(path.extname(rom).toLowerCase()) || !fs.existsSync(path.join(sys.dir, rom))) return send(ws, { t: 'error', msg: 'Juego inválido o inexistente' });
      // Opening another game (or reloading) replaces the previous host page.
      if (party.host && party.host !== ws) { party.host.partyRole = null; send(party.host, { t: 'replaced' }); }
      party.host = ws; ws.partyRole = 'host';
      party.game = { system, rom, core, name: gameInfo(sys, rom).name };
      send(ws, { t: 'hosting', guest: !!party.guest, name: party.game.name });
      send(party.guest, { t: 'game', game: party.game });
      if (party.guest) send(ws, { t: 'peer' });
      return;
    }
    if (m.t === 'guest') {
      // One guest: a new tab (or a reload) takes the place of the old one.
      if (party.guest && party.guest !== ws) { party.guest.partyRole = null; send(party.guest, { t: 'replaced' }); }
      party.guest = ws; ws.partyRole = 'guest';
      send(ws, { t: 'game', game: party.host ? party.game : null });
      if (party.host) send(party.host, { t: 'peer' });
      return;
    }
    if (ws.partyRole && m.t === 'signal' && m.data) {
      return send(ws.partyRole === 'host' ? party.guest : party.host, { t: 'signal', data: m.data });
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
// The party: one permanent link for the guest, whatever game the host opens.
const party = { host: null, guest: null, game: null };
function leaveParty(ws) {
  if (ws.partyRole === 'host' && party.host === ws) {
    party.host = null;
    send(party.guest, { t: 'host-left' });
  } else if (ws.partyRole === 'guest' && party.guest === ws) {
    party.guest = null;
    send(party.host, { t: 'peer-left' });
  }
  ws.partyRole = null;
}
app.get('/api/party', (req, res) => {
  res.json({ publicUrl: game.publicUrl || null, lanUrls: lanUrls(), guest: !!party.guest, hosting: !!party.host, game: party.host ? party.game : null });
});
async function close() {
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  await new Promise(resolve => netplay.io.close(resolve));
  if (server.listening) await new Promise(resolve => server.close(resolve));
  try { if (lbDb) lbDb.close(); } catch (e) {}
  lbDb = null;
}
const lanUrls = () => lanAddresses().map(ip => 'http://' + ip + ':' + (server.address()?.port || PORT));
return Object.assign(game, { app, server, wss, rooms, netplay, close, lanUrls });
}
// Opens an ngrok tunnel (unless --no-share) so guests outside the home network can join.
// Only pages and signaling go through it; video and controls travel over WebRTC.
function startTunnel(game, port) {
  const { spawn } = require('child_process');
  const ngrok = spawn('ngrok', ['http', String(port), '--log', 'stdout', '--log-format', 'json'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  ngrok.on('error', () => console.log('No se encontró ngrok. Instalalo (winget install ngrok.ngrok) y configurá tu authtoken.'));
  const onLine = line => {
    let entry; try { entry = JSON.parse(line); } catch { return; }
    if (entry.url && /^https:/.test(entry.url) && !game.publicUrl) {
      game.publicUrl = entry.url;
      console.log('\n  Link para tu amigo:  ' + entry.url + '\n  (es siempre el mismo; pasáselo una sola vez)\n');
    } else if (entry.lvl === 'eror' || (entry.err && entry.err !== '<nil>')) console.log('ngrok: ' + (entry.err || entry.msg));
  };
  let buffer = '';
  ngrok.stdout.on('data', chunk => { buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop(); lines.forEach(onLine); });
  ngrok.stderr.on('data', chunk => console.log('ngrok: ' + String(chunk).trim()));
  const stop = () => { try { ngrok.kill(); } catch {} };
  process.on('exit', stop);
  // SIGHUP: the console window was closed with its X button.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { stop(); process.exit(0); });
}
function openBrowser(url) {
  require('child_process').spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
}
if (require.main === module) {
  const game = createRemoteGame();
  const port = Number(process.env.PORT || cfg.port);
  // --open (desktop shortcut, pnpm start): show the library in the browser.
  const open = process.argv.includes('--open');
  if (open) process.title = 'RemoteGame';
  game.server.on('error', err => {
    if (err.code !== 'EADDRINUSE') throw err;
    // Double-clicked twice: the first one is already serving, just show it.
    console.log('RemoteGame ya está abierto. Abriendo el navegador…');
    if (open) openBrowser('http://localhost:' + port);
    setTimeout(() => process.exit(0), 3000);
  });
  game.server.listen(port, () => {
    console.log('RemoteGame v0.5.0 en http://localhost:' + port);
    for (const ip of game.lanUrls()) console.log('Misma red:  ' + ip);
    if (!process.argv.includes('--no-share') && process.env.SHARE !== '0') startTunnel(game, port);
    if (open) openBrowser('http://localhost:' + port);
    if (open) console.log('Cerrá esta ventana para apagar RemoteGame.');
  });
}
module.exports = { createRemoteGame };
