const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { io } = require('socket.io-client');
const AdmZip = require('adm-zip');
const { DatabaseSync } = require('node:sqlite');
const { createRemoteGame, groupSwitch } = require('../server');
let temp, game, base, quits = 0;
// Covers: the download is simulated, so these tests never touch the Internet.
const downloads = [];
// A real 1000x1400 PNG (cover art is big), so the resize to a small WebP is exercised too.
const sharp = require('sharp');
const fakeCover = async name => { downloads.push(name); await new Promise(r => setTimeout(r, 20)); return sharp({ create: { width: 1000, height: 1400, channels: 3, background: '#c33' } }).png().toBuffer(); };
// libretro-thumbnails, also simulated: `lists` maps "<library>/<type>" to the file names of its directory listing.
const lrLog = [];
const fakeLibretro = lists => async pathname => {
  lrLog.push(pathname);
  if (pathname.endsWith('/')) {
    const [lib, type] = pathname.split('/').map(decodeURIComponent);
    return Buffer.from((lists[lib + '/' + type] || []).map(s => '<tr><td><a href="' + encodeURIComponent(s).replace(/'/g, '%27') + '.png">' + s.replace(/&/g, '&amp;') + '.png</a></td></tr>').join('\n'));
  }
  await new Promise(r => setTimeout(r, 20));
  return sharp({ create: { width: 600, height: 800, channels: 3, background: '#36c' } }).png().toBuffer();
};
const SNES_LIB = 'Nintendo - Super Nintendo Entertainment System';
const sharedLists = {
  [SNES_LIB + '/Named_Boxarts']: ['No Cover (Japan)', 'No Cover (USA)', 'No Cover (Europe)', 'No Cover (USA) (Beta)', 'Super Metroid (USA)', 'Bad Dump (USA) [b]', 'Dr. Mario - Hack (USA)'],
  [SNES_LIB + '/Named_Titles']: ['Only Title (USA)'],
  'FBNeo - Arcade Games/Named_Boxarts': ['Metal Slug - Super Vehicle-001']
};
const fakeDat = async which => which === 'fbneo' ? '<datafile><game name="mslug" sourcefile="x.cpp"><description>Metal Slug - Super Vehicle-001 (World)</description></game><game isbios="yes" name="neogeo"><description>Neo Geo</description></game></datafile>' : '<mame></mame>';
// Another server on its own folders, for the tests that change what is on disk.
async function instance(options) {
  const g = createRemoteGame({ libretro: false, localRoms: path.join(temp, 'uploads'), launchBoxDir: path.join(temp, 'nothing-here'), customCoversDir: path.join(temp, 'propias'), ...options });
  g.server.listen(0, '127.0.0.1'); await once(g.server, 'listening');
  return { g, url: 'http://127.0.0.1:' + g.server.address().port };
}
const clients = [];
before(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'remotegame-test-'));
  fs.mkdirSync(path.join(temp,'NES'),{recursive:true});
  fs.mkdirSync(path.join(temp,'MAME','Roms'),{recursive:true});
  fs.mkdirSync(path.join(temp,'uploads'),{recursive:true});
  fs.writeFileSync(path.join(temp,'NES','test.nes'), Buffer.from('NES\x1a'));
  const zip = new AdmZip(); zip.addFile('demo.bin',Buffer.from('genesis'));
  zip.writeZip(path.join(temp,'uploads','genesis.zip'));
  zip.writeZip(path.join(temp,'MAME','Roms','neogeo.zip'));
  fs.writeFileSync(path.join(temp,'NES','secret.txt'),'not a rom');
  fs.writeFileSync(path.join(temp,'NES','Other_Game (U) [!].nes'), Buffer.from('NES\x1a'));
  // The same title in two consoles, plus SNES games that LaunchBox's metadata knows by name only.
  fs.mkdirSync(path.join(temp,'Super Nintendo','Roms'),{recursive:true});
  for(const f of ['Other Game (E).smc','Addams Family, The (U).smc','No Cover (U).smc','Nothing Here (U).smc','super metroid (u).smc','Only Title (U).smc','International Superstar Soccer (U).smc'])fs.writeFileSync(path.join(temp,'Super Nintendo','Roms',f), Buffer.from('smc'));
  // A LaunchBox list with the full title for test.nes, path relative to the LaunchBox folder.
  fs.mkdirSync(path.join(temp,'LaunchBox','Data','Platforms'),{recursive:true});
  fs.writeFileSync(path.join(temp,'LaunchBox','Data','Platforms','NES.xml'),
    '<?xml version="1.0"?><LaunchBox><Game><ApplicationPath>..\\NES\\test.nes</ApplicationPath><Title>Rock &amp; Roll Racing</Title><ReleaseDate>1993-06-01T00:00:00</ReleaseDate><DatabaseID>2</DatabaseID><Platform>Nintendo Entertainment System</Platform></Game></LaunchBox>');
  // A tiny copy of LaunchBox's metadata database.
  fs.mkdirSync(path.join(temp,'LaunchBox','Metadata'),{recursive:true});
  const db=new DatabaseSync(path.join(temp,'LaunchBox','Metadata','LaunchBox.Metadata.db'));
  db.exec('CREATE TABLE Games (DatabaseID INTEGER PRIMARY KEY, Name TEXT, ReleaseType TEXT, Platform TEXT);'+
    'CREATE TABLE GameImages (FileName TEXT PRIMARY KEY, DatabaseId INTEGER, Type TEXT, Region TEXT);'+
    'CREATE TABLE GameAlternateTitles (AlternateName TEXT, DatabaseID INTEGER, Region TEXT);'+
    "INSERT INTO Games VALUES (1,'Other Game','Released','Super Nintendo Entertainment System'),(2,'Rock n Roll Racing','Released','Nintendo Entertainment System'),(3,'The Addams Family','Released','Super Nintendo Entertainment System'),(4,'Other Game','ROM Hack','Super Nintendo Entertainment System');"+
    "INSERT INTO GameImages VALUES ('aaaa-1.png',1,'Box - Front','Japan'),('bbbb-1.jpg',1,'Box - Front','North America'),('cccc-1.jpg',1,'Screenshot - Gameplay','World'),('dddd-2.jpg',2,'Box - Front','World'),('eeee-3.png',3,'Box - Front - Reconstructed',''),('ffff-4.jpg',4,'Box - Front','World'),('../evil.jpg',3,'Box - Front','World');"+
    "INSERT INTO GameAlternateTitles VALUES ('Addams Family Values Old',3,'');");
  db.close();
  fs.writeFileSync(path.join(temp,'MAME','Roms','mslug.zip'), zip.toBuffer());
  game=createRemoteGame({ gamesRoot:temp,localRoms:path.join(temp,'uploads'),launchBoxDir:path.join(temp,'LaunchBox'),coverCacheDir:path.join(temp,'covers'),fetchCover:fakeCover,
    libretroCacheDir:path.join(temp,'lr'),fetchLibretro:fakeLibretro(sharedLists),fetchDat:fakeDat,settingsFile:path.join(temp,'settings.json'),onQuit:()=>quits++,customCoversDir:path.join(temp,'propias') });
  game.server.listen(0,'127.0.0.1');await once(game.server,'listening');
  base='http://127.0.0.1:'+game.server.address().port;
  // The first listing starts the download of the thumbnail listings; wait for them so every test sees the same names.
  await fetch(base+'/api/games?system=all&limit=1');await game.coversReady();
});
after(async () => {
  for(const client of clients) client.close();
  await game.close();
  fs.rmSync(temp,{recursive:true,force:true});
});
// remote: simulates a visitor arriving through the tunnel (ngrok adds X-Forwarded-For).
async function wsClient(remote) {
  const ws=new WebSocket(base.replace('http','ws')+'/ws',remote?{headers:{'X-Forwarded-For':'203.0.113.9'}}:undefined); clients.push(ws);
  ws.queue=[];ws.on('message',data=>ws.queue.push(JSON.parse(data)));
  await once(ws,'open');return ws;
}
async function message(ws,type) {
  const end=Date.now()+3000;
  while(Date.now()<end){const i=ws.queue.findIndex(m=>m.t===type);if(i>=0)return ws.queue.splice(i,1)[0];await new Promise(r=>setTimeout(r,2));}
  throw Error('Timeout '+type+' '+JSON.stringify(ws.queue));
}
const send=(ws,data)=>ws.send(JSON.stringify(data));
async function sio() {
  const client=io(base,{transports:['websocket'],reconnection:false,timeout:2000});clients.push(client);
  await Promise.race([once(client,'connect'),once(client,'connect_error').then(([e])=>Promise.reject(e))]);return client;
}
const request=(client,event,data)=>new Promise(resolve=>client.timeout(2000).emit(event,data,(err,...args)=>{assert.ifError(err);resolve(args)}));
const data=(session,user,max=2)=>({ extra:{domain:'test',game_id:1,sessionid:session,userid:user,player_name:user,room_name:session},maxPlayers:max,password:'' });

test('ROMs: validates files, preserves uploaded ZIPs and exposes BIOS without listing them as games',async()=>{
  assert.equal((await fetch(base+'/api/rom/nes/secret.txt')).status,400);
  assert.equal((await fetch(base+'/api/rom/constructor/test.nes')).status,400);
  assert.equal((await fetch(base+'/api/rom/nes/foo%5Cbar.nes')).status,400);
  assert.equal((await fetch(base+'/api/rom/subidos/genesis.zip')).status,415);
  const raw=Buffer.from(await (await fetch(base+'/api/rom/subidos/genesis.zip?raw=1')).arrayBuffer());
  assert.deepEqual(raw,fs.readFileSync(path.join(temp,'uploads','genesis.zip')));
  const bios=await (await fetch(base+'/api/arcade-bios')).json();assert.equal(bios['/neogeo.zip'],'neogeo.zip');
  const biosZip=Buffer.from(await (await fetch(base+'/'+bios['/neogeo.zip'])).arrayBuffer());
  assert.deepEqual(biosZip,fs.readFileSync(path.join(temp,'MAME','Roms','neogeo.zip')));
  assert.equal((await fetch(base+'/pgm.zip')).status,404);
  const list=await (await fetch(base+'/api/games?system=arcade')).json();assert.deepEqual(list.games.map(g=>g.file),['mslug.zip']);
  assert.equal((await fetch(base+'/api/rom/nes/test.nes')).headers.get('cache-control'),'no-cache');
});
test('Names: full titles from LaunchBox, searchable by title or file; others tidied',async()=>{
  const all=await (await fetch(base+'/api/games?system=nes')).json();
  const byFile=Object.fromEntries(all.games.map(g=>[g.file,g]));
  assert.equal(byFile['test.nes'].name,'Rock & Roll Racing');assert.equal(byFile['test.nes'].year,'1993');
  assert.equal(byFile['Other_Game (U) [!].nes'].name,'Other Game');
  for(const q of ['roll racing','test'])assert.deepEqual((await (await fetch(base+'/api/games?system=nes&q='+encodeURIComponent(q))).json()).games.map(g=>g.file),['test.nes']);
});
test('NES: waits for both ROMs, rejects P3, enforces host and reset generation',async()=>{
  const host=await wsClient(),guest=await wsClient(),third=await wsClient();
  send(host,{t:'create',rom:'test.nes'});const created=await message(host,'created');
  send(guest,{t:'join',room:created.room});await message(guest,'joined');
  send(host,{t:'signal',data:{sdp:'offer-test'}});
  assert.equal((await message(guest,'signal')).data.sdp,'offer-test');
  send(host,null);send(host,{t:'start',delay:2});const reset=await message(host,'reset');await message(guest,'reset');
  send(host,{t:'ready',epoch:reset.epoch});
  await new Promise(r=>setTimeout(r,20));assert.equal(game.rooms.get(created.room).phase,'loading');
  send(guest,{t:'ready',epoch:reset.epoch});assert.equal((await message(host,'start')).delay,2);await message(guest,'start');
  send(guest,{t:'resync'});send(guest,{t:'input',epoch:reset.epoch,frame:2,pad:9});
  assert.equal((await message(host,'input')).pad,9);assert.equal(game.rooms.get(created.room).epoch,reset.epoch);
  send(guest,{t:'input',epoch:reset.epoch-1,frame:3,pad:7});
  send(guest,{t:'input',epoch:reset.epoch,frame:3,pad:999});
  send(guest,{t:'input',epoch:reset.epoch,frame:3,pad:8});
  assert.equal((await message(host,'input')).pad,8);
  host.close();assert.match((await message(guest,'ended')).msg,/anfitrión/);assert.equal(game.rooms.has(created.room),false);
});
test('Party: one permanent link, the guest follows every game the host opens',async()=>{
  const host=await wsClient(),guest=await wsClient(true);
  send(host,{t:'host',system:'arcade',rom:'missing.zip',core:'fbneo'});await message(host,'error');
  send(host,{t:'host',system:'nes',rom:'test.nes',core:'../x'});await message(host,'error');
  send(host,{t:'host',system:'nes',rom:'test.nes',core:'nes'});assert.equal((await message(host,'hosting')).guest,false);
  send(guest,{t:'guest',id:'ana'});const joined=await message(guest,'game');
  assert.deepEqual(joined.game,{system:'nes',rom:'test.nes',core:'nes',name:'Rock & Roll Racing'});assert.equal(joined.player,2);
  assert.equal((await message(host,'peer')).slot,0);
  assert.equal((await (await fetch(base+'/api/party')).json()).guest,true);
  // Someone through the tunnel cannot take the host role.
  send(guest,{t:'host',system:'nes',rom:'test.nes',core:'nes'});assert.match((await message(guest,'error')).msg,/anfitriona/);
  const sdp='v=0\r\n'+'a=x\r\n'.repeat(3000);
  send(host,{t:'signal',to:0,data:{sdp:{type:'offer',sdp}}});assert.equal((await message(guest,'signal')).data.sdp.sdp,sdp);
  send(guest,{t:'signal',data:{candidate:'c'}});const back=await message(host,'signal');assert.equal(back.data.candidate,'c');assert.equal(back.from,0);
  // Opening another game: the old page is replaced and the guest switches without a new link.
  const host2=await wsClient();
  send(host2,{t:'host',system:'nes',rom:'test.nes',core:'nes'});
  await message(host,'replaced');await message(guest,'game');assert.equal((await message(host2,'peer')).slot,0);
  host.close();await new Promise(r=>setTimeout(r,30));assert.equal(guest.queue.some(m=>m.t==='host-left'),false);
  host2.close();await message(guest,'host-left');
  assert.equal((await (await fetch(base+'/api/party')).json()).hosting,false);
  // A reload of the guest replaces the old tab; closing it tells the host.
  const host3=await wsClient();send(host3,{t:'host',system:'nes',rom:'test.nes',core:'nes'});await message(host3,'peer');
  const guest2=await wsClient(true);send(guest2,{t:'guest',id:'ana'});await message(guest,'replaced');await message(host3,'peer');
  guest2.close();assert.equal((await message(host3,'peer-left')).slot,0);
  host3.close();
});
// A dropped seat is kept for its owner for a few seconds; tests start from a clean room.
const freshParty=async()=>{await new Promise(r=>setTimeout(r,60));game.party.held.fill(null);};
const joinParty=async(id,remote=true)=>{const ws=await wsClient(remote);send(ws,{t:'guest',id});return ws;};
const startHosting=async()=>{const host=await wsClient();send(host,{t:'host',system:'nes',rom:'test.nes',core:'nes'});await message(host,'hosting');return host;};
test('Party: up to 3 guests take P2, P3 and P4; a 4th gets "full"; the same id keeps its seat',async()=>{
  await freshParty();
  const host=await startHosting();
  const a=await joinParty('seat-a'),b=await joinParty('seat-b');
  assert.equal((await message(a,'game')).player,2);assert.equal((await message(b,'game')).player,3);
  assert.deepEqual([(await message(host,'peer')).slot,(await message(host,'peer')).slot],[0,1]);
  const info=await (await fetch(base+'/api/party')).json();
  assert.deepEqual([info.guest,info.guests,info.slots,info.players],[true,2,[0,1],[2,3]]);
  const c=await joinParty('seat-c');assert.equal((await message(c,'game')).player,4);assert.equal((await message(host,'peer')).slot,2);
  // Full: the 4th one is told so, gets no seat and the host does not hear of it.
  const d=await joinParty('seat-d');await message(d,'full');
  await new Promise(r=>setTimeout(r,30));
  assert.equal(host.queue.some(m=>m.t==='peer'),false);assert.equal(d.queue.some(m=>m.t==='game'),false);
  // A reload or a network switch: the same id gets the same seat back and the old socket is told.
  const b2=await joinParty('seat-b');await message(b,'replaced');
  assert.equal((await message(b2,'game')).player,3);assert.equal((await message(host,'peer')).slot,1);
  // The old socket closing afterwards must not free the seat its replacement holds.
  b.close();await new Promise(r=>setTimeout(r,30));
  assert.equal(host.queue.some(m=>m.t==='peer-left'),false);
  assert.equal((await (await fetch(base+'/api/party')).json()).guests,3);
  // An id with odd characters is refused.
  const bad=await joinParty('no/slash!');assert.match((await message(bad,'error')).msg,/inválido/);
  // A new game reaches everyone with their own number, and the new host hears of every guest.
  const host2=await wsClient();send(host2,{t:'host',system:'nes',rom:'test.nes',core:'nes'});
  assert.deepEqual((await message(host2,'hosting')).slots,[0,1,2]);
  assert.deepEqual([(await message(a,'game')).player,(await message(b2,'game')).player,(await message(c,'game')).player],[2,3,4]);
  const seats=[];for(let i=0;i<3;i++)seats.push((await message(host2,'peer')).slot);
  assert.deepEqual(seats.sort(),[0,1,2]);
  for(const ws of [a,b2,c,d,bad,host,host2])ws.close();
});
test('Party: signals go by seat and the sender is the socket, never what the message claims',async()=>{
  await freshParty();
  const host=await startHosting();
  const a=await joinParty('sig-a'),b=await joinParty('sig-b');
  await message(a,'game');await message(b,'game');
  // To a seat: only that guest hears it. A missing, bogus or empty seat reaches nobody.
  send(host,{t:'signal',to:1,data:{n:1}});assert.equal((await message(b,'signal')).data.n,1);
  for(const to of [undefined,-1,3,'0',1.5,2])send(host,{t:'signal',to,data:{n:2}});
  // A guest cannot write to another guest, and the "from"/"to" it sends are ignored.
  send(a,{t:'signal',from:1,to:1,data:{n:4}});send(b,{t:'signal',from:0,to:0,data:{n:5}});
  const first=await message(host,'signal'),second=await message(host,'signal');
  assert.deepEqual([first.from,first.data.n,second.from,second.data.n],[0,4,1,5]);
  await new Promise(r=>setTimeout(r,30));
  assert.deepEqual(a.queue.filter(m=>m.t==='signal'),[]);assert.deepEqual(b.queue.filter(m=>m.t==='signal'),[]);
  // A guest that sends "host" is refused and stays a guest.
  send(a,{t:'host',system:'nes',rom:'test.nes',core:'nes'});await message(a,'error');
  assert.equal(game.party.host.partyRole,'host');assert.equal(game.party.guests[0].guestId,'sig-a');
  for(const ws of [host,a,b])ws.close();
});
test('Party: a guest that leaves frees the seat and the host hears which one',async()=>{
  await freshParty();
  const host=await startHosting();
  const a=await joinParty('leave-a'),b=await joinParty('leave-b');
  await message(host,'peer');await message(host,'peer');
  a.close();assert.equal((await message(host,'peer-left')).slot,0);
  assert.deepEqual((await (await fetch(base+'/api/party')).json()).players,[3]);
  // A newcomer does not take the seat just dropped (its owner may be switching networks)...
  const c=await joinParty('leave-c');assert.equal((await message(c,'game')).player,4);
  // ...unless nothing else is free; then the old owner finds the room full.
  const d=await joinParty('leave-d');assert.equal((await message(d,'game')).player,2);
  const a2=await joinParty('leave-a');await message(a2,'full');
  // The host leaving tells every guest.
  host.close();for(const ws of [b,c,d])await message(ws,'host-left');
  assert.equal((await (await fetch(base+'/api/party')).json()).hosting,false);
  assert.equal((await (await fetch(base+'/api/party')).json()).guest,true);
  for(const ws of [a2,b,c,d])ws.close();
});
test('Party: the seat dropped by a network switch comes back to its id even if others joined meanwhile',async()=>{
  await freshParty();
  // Guests can arrive before any host: they get a seat and no game yet.
  const a=await joinParty('back-a');const first=await message(a,'game');assert.deepEqual([first.player,first.game],[2,null]);
  a.close();await new Promise(r=>setTimeout(r,30));
  const b=await joinParty('back-b');assert.equal((await message(b,'game')).player,3);
  const a2=await joinParty('back-a');assert.equal((await message(a2,'game')).player,2);
  for(const ws of [a2,b])ws.close();
});
test('Party: visitors through the tunnel land on the room, this PC sees the library',async()=>{
  const remote=await fetch(base+'/',{redirect:'manual',headers:{'X-Forwarded-For':'203.0.113.9'}});
  assert.equal(remote.status,302);assert.equal(remote.headers.get('location'),'/sala');
  assert.equal((await fetch(base+'/')).status,200);
  assert.match(await (await fetch(base+'/sala')).text(),/invitado/);
  const upload=await fetch(base+'/api/upload',{method:'POST',headers:{'X-Forwarded-For':'203.0.113.9'}});assert.equal(upload.status,403);
});
// Stream mode: the host captures a native emulator; the guests' pads reach a virtual pad (here a fake that records calls).
const fakeVpad=()=>{const calls=[];return {calls,update:(slot,state)=>calls.push(['update',slot,state]),release:slot=>calls.push(['release',slot]),releaseAll:()=>calls.push(['releaseAll']),status:()=>({}),close(){}};};
async function streamParty(){
  const vpad=fakeVpad();
  const {g,url}=await instance({gamesRoot:temp,vpad,settingsFile:path.join(temp,'stream-settings.json')});
  g.vpad=vpad;   // what the server does itself with options.vpad
  const connect=async remote=>{
    const ws=new WebSocket(url.replace('http','ws')+'/ws',remote?{headers:{'X-Forwarded-For':'203.0.113.9'}}:undefined);clients.push(ws);
    ws.queue=[];ws.on('message',d=>ws.queue.push(JSON.parse(d)));await once(ws,'open');return ws;
  };
  return {g,url,vpad,connect,pause:()=>new Promise(r=>setTimeout(r,40))};
}
test('Stream: only this PC hosts a stream, without a ROM, and the guests are told it is analog',async()=>{
  const {g,url,connect}=await streamParty();
  try {
    const tunnel=await connect(true);
    send(tunnel,{t:'host',mode:'stream',name:'Eden'});assert.match((await message(tunnel,'error')).msg,/anfitriona/);
    assert.equal(g.party.host,null);
    const host=await connect(),guest=await connect(true);
    // The name is a short, tidy string; anything else becomes the default.
    send(host,{t:'host',mode:'stream',name:'  Mario\u0007 Kart \n  en Eden '+'x'.repeat(100)});
    const hosting=await message(host,'hosting');
    assert.equal(hosting.name.length<=60,true);assert.match(hosting.name,/^Mario Kart en Eden x+$/);
    assert.deepEqual(g.party.game,{mode:'stream',core:'native',analog:true,name:hosting.name});
    send(guest,{t:'guest',id:'stream-a'});
    const joined=await message(guest,'game');
    assert.deepEqual(joined.game,{mode:'stream',core:'native',analog:true,name:hosting.name});assert.equal(joined.player,2);
    assert.equal((await message(host,'peer')).slot,0);
    assert.equal((await (await fetch(url+'/api/party')).json()).game.mode,'stream');
    for(const name of [undefined,123,{a:1},'   '])send(host,{t:'host',mode:'stream',name});
    for(const name of [undefined,123,{a:1},'   '])assert.equal((await message(host,'hosting')).name,'Juego de la PC');
    // A ROM-less normal host stays refused: only mode "stream" skips the ROM.
    send(host,{t:'host',system:'nes',core:'nes'});assert.match((await message(host,'error')).msg,/inválido/);
  } finally { await g.close(); }
});
test('Stream: vpad only from the stream host, with a seat and clamped values',async()=>{
  const {g,vpad,connect,pause}=await streamParty();
  try {
    const host=await connect();send(host,{t:'host',mode:'stream',name:'Eden'});await message(host,'hosting');
    const a=await connect(true);send(a,{t:'guest',id:'vp-a'});await message(a,'game');await message(host,'peer');
    send(host,{t:'vpad',slot:0,b:0x1ffff,x:999,y:-999,rx:'abc',ry:3.6});
    await waitFor(()=>vpad.calls.length===1);
    assert.deepEqual(vpad.calls[0],['update',0,{b:0xffff,x:127,y:-127,rx:0,ry:4}]);
    // Bad seats, a seat nobody holds, and anyone but the host: nothing reaches the pad.
    for(const slot of [-1,3,1.5,'0',null,undefined])send(host,{t:'vpad',slot,b:1});
    send(host,{t:'vpad',slot:1,b:1});
    send(a,{t:'vpad',slot:0,b:1});send(a,{t:'vpad',slot:0,release:true});
    const tunnel=await connect(true);send(tunnel,{t:'vpad',slot:0,b:1});
    await pause();assert.equal(vpad.calls.length,1);
    // The host lets go of a seat explicitly.
    send(host,{t:'vpad',slot:0,release:true});await waitFor(()=>vpad.calls.length===2);
    assert.deepEqual(vpad.calls[1],['release',0]);
    // A guest that leaves, or is replaced by its own reload, is released by the server itself.
    vpad.calls.length=0;
    const a2=await connect(true);send(a2,{t:'guest',id:'vp-a'});await message(a,'replaced');
    await waitFor(()=>vpad.calls.some(c=>c[0]==='release'&&c[1]===0));
    vpad.calls.length=0;
    a2.close();await message(host,'peer-left');
    assert.deepEqual(vpad.calls,[['release',0]]);
    send(host,{t:'vpad',slot:0,b:1});await pause();assert.equal(vpad.calls.length,1,'a late packet of a guest that left is dropped');
    // A new host replaces the old one: everything is released. Closing the last host does too.
    vpad.calls.length=0;
    const host2=await connect();send(host2,{t:'host',mode:'stream',name:'Otro'});await message(host,'replaced');
    assert.deepEqual(vpad.calls,[['releaseAll']]);
    send(host,{t:'vpad',slot:0,b:1});await pause();assert.equal(vpad.calls.length,1,'the replaced host cannot send any more');
    vpad.calls.length=0;
    host2.close();await waitFor(()=>vpad.calls.length===1);
    assert.deepEqual(vpad.calls,[['releaseAll']]);
  } finally { await g.close(); }
});
test('Stream: an EmulatorJS host never reaches the virtual pads',async()=>{
  const {g,vpad,connect,pause}=await streamParty();
  try {
    const host=await connect();send(host,{t:'host',system:'nes',rom:'test.nes',core:'nes'});await message(host,'hosting');
    const a=await connect(true);send(a,{t:'guest',id:'ejs-a'});assert.equal((await message(a,'game')).game.analog,undefined);await message(host,'peer');
    send(host,{t:'vpad',slot:0,b:1,x:5});send(host,{t:'vpad',slot:0,release:true});
    await pause();assert.deepEqual(vpad.calls,[]);
    // Going from a stream to EmulatorJS releases what the stream held.
    send(host,{t:'host',mode:'stream',name:'X'});await message(host,'hosting');
    send(host,{t:'host',system:'nes',rom:'test.nes',core:'nes'});await message(host,'hosting');
    assert.deepEqual(vpad.calls.map(c=>c[0]),['releaseAll','releaseAll']);
    vpad.calls.length=0;send(host,{t:'vpad',slot:0,b:1});await pause();assert.deepEqual(vpad.calls,[]);
  } finally { await g.close(); }
});
test('Both websocket protocols coexist; EJS rejection/disconnect cannot remove another room',async()=>{
  const a=await sio(),b=await sio(),c=await sio(),d=await sio(),rejected=await sio();
  assert.deepEqual(await request(a,'open-room',data('one','a')),[false]);
  assert.deepEqual(await request(b,'open-room',data('two','b')),[false]);
  assert.equal((await request(c,'join-room',data('one','c')))[0],false);
  assert.equal((await request(d,'join-room',data('two','d')))[0],false);
  assert.deepEqual(await request(rejected,'join-room',data('one','e')),[true,'ROOM_FULL']);
  rejected.close();a.close();await once(c,'disconnect');
  const list=await (await fetch(base+'/list?domain=test&game_id=1')).json();
  assert.equal(list.one,undefined);assert.equal(list.two.current,2);assert.equal(list.two.owner_name,'b');
  const sigReceived=once(d,'signal');b.emit('signal',{sdp:'answer-test'});assert.deepEqual((await sigReceived)[0],{sdp:'answer-test'});
  const received=once(d,'data-message');b.emit('data-message',{hello:1});assert.deepEqual((await received)[0],{hello:1});
  const legacy=await wsClient();send(legacy,{t:'latency',ts:42});assert.equal((await message(legacy,'latency')).ts,42);
});
test('EJS refuses unsupported player counts, malformed data and unsupported passwords',async()=>{
  const c=await sio();
  assert.deepEqual(await request(c,'open-room',null),[true,'INVALID_ROOM']);
  for(const max of [0,3,4,100])assert.deepEqual(await request(c,'open-room',data('limits','u',max)),[true,'INVALID_ROOM']);
  assert.deepEqual(await request(c,'open-room',{...data('password','u'),password:'secret'}),[true,'PASSWORD_UNSUPPORTED']);
});
test('Local transport latency: 100 actual round trips (not Internet or input-to-photon latency)',async t=>{
  const c=await sio();const samples=[];
  for(let i=0;i<100;i++){const start=performance.now();await request(c,'latency',{});samples.push(performance.now()-start);}
  samples.sort((a,b)=>a-b);
  t.diagnostic('Socket.IO loopback RTT median='+samples[50].toFixed(2)+'ms p95='+samples[95].toFixed(2)+'ms');
  assert.equal(samples.length,100);
});
test('Search: every console at once, the same title shows once per console, pages with offset',async()=>{
  const get=async url=>(await fetch(base+url)).json();
  const all=await get('/api/games?system=all&q=other%20game');
  assert.equal(all.total,2);assert.deepEqual(all.games.map(g=>g.system).sort(),['nes','snes']);
  const bySystem=Object.fromEntries(all.games.map(g=>[g.system,g]));
  assert.equal(bySystem.snes.systemLabel,'Super Nintendo');assert.equal(bySystem.nes.systemLabel,'NES / Family');
  assert.equal(bySystem.nes.play,'/play-ejs.html?system=nes&file='+encodeURIComponent('Other_Game (U) [!].nes')+'&core=nes');
  assert.equal(bySystem.snes.play,'/play-ejs.html?system=snes&file='+encodeURIComponent('Other Game (E).smc'));
  // "not" leaves a console out (the "other consoles" section); one console still works as before.
  assert.deepEqual((await get('/api/games?system=all&q=other%20game&not=snes')).games.map(g=>g.system),['nes']);
  assert.equal((await get('/api/games?system=snes&q=other%20game')).total,1);
  // Several words in any order, no accents or punctuation needed.
  assert.equal((await get('/api/games?system=all&q=racing%20ROLL')).total,1);
  assert.equal((await get('/api/games?system=all&q=zzzz')).total,0);
  // Pages: offset moves through the sorted list without repeating or skipping.
  const full=(await get('/api/games?system=all&limit=100')).games.map(g=>g.system+'/'+g.file);
  assert.ok(full.length>=5);
  const paged=[];
  for(let offset=0;offset<full.length;offset+=2){const r=await get('/api/games?system=all&limit=2&offset='+offset);assert.equal(r.total,full.length);assert.equal(r.offset,offset);paged.push(...r.games.map(g=>g.system+'/'+g.file));}
  assert.deepEqual(paged,full);
  assert.equal((await get('/api/games?system=nes&limit=1&offset=99')).games.length,0);
  assert.equal((await fetch(base+'/api/games?system=nope')).status,400);
  const systems=(await get('/api/systems')).systems;assert.equal(systems.find(s=>s.id==='snes').count,7);assert.notEqual(systems.find(s=>s.id==='n64').missing,null);
});
test('One game by system and file: same JSON as the list, 404 when missing, 400 when invalid',async()=>{
  const listed=(await (await fetch(base+'/api/games?system=snes&q=other%20game')).json()).games[0];
  const one=await fetch(base+'/api/game/snes/'+encodeURIComponent(listed.file));
  assert.equal(one.status,200);assert.deepEqual(await one.json(),listed);
  assert.equal((await fetch(base+'/api/game/snes/nope.smc')).status,404);
  assert.equal((await fetch(base+'/api/game/snes/'+'a%3Ab')).status,400);
  assert.equal((await fetch(base+'/api/game/nope/x.nes')).status,400);
});
test('Covers: libretro first, LaunchBox as extra; saved in the cache, downloaded once',async()=>{
  const get=async url=>(await fetch(base+url)).json();
  const nes=(await get('/api/games?system=nes&q=rock')).games[0];
  // Not in libretro: LaunchBox's image, by the id of its list.
  assert.match(nes.cover,/^\/api\/cover\/nes\/.+\?v=dddd-2-400$/);
  const snes=Object.fromEntries((await get('/api/games?system=snes')).games.map(g=>[g.file,g]));
  // LaunchBox: box art from North America over Japan, over any screenshot; the ROM hack with the same title never wins.
  assert.match(snes['Other Game (E).smc'].cover,/\?v=bbbb-1-400$/);
  // "Addams Family, The" matches "The Addams Family" by name.
  assert.match(snes['Addams Family, The (U).smc'].cover,/\?v=eeee-3-400$/);
  // libretro: exact title only, USA over Europe and Japan, no betas, no bracketed dumps; a title screen if there is no box.
  assert.match(snes['No Cover (U).smc'].cover,/\?v=lr-[0-9a-f]{16}-400$/);
  assert.match(snes['Only Title (U).smc'].cover,/\?v=lr-[0-9a-f]{16}-400$/);
  assert.equal(snes['Nothing Here (U).smc'].cover,null);
  // The name of the matching thumbnail tidies the file name.
  assert.equal(snes['super metroid (u).smc'].name,'Super Metroid');
  const beforeLb=downloads.length,beforeLr=lrLog.length;
  const [a,b]=await Promise.all([fetch(base+nes.cover),fetch(base+nes.cover)]);
  assert.equal(a.status,200);assert.equal(b.status,200);
  assert.match(a.headers.get('content-type'),/^image\/webp/);
  assert.match(a.headers.get('cache-control'),/immutable/);
  // Stored small: WebP, 400 px wide, proportions kept; the original is not kept.
  const meta=await sharp(Buffer.from(await a.arrayBuffer())).metadata();
  assert.deepEqual([meta.format,meta.width,meta.height],['webp',400,560]);
  assert.equal(downloads.at(-1),'dddd-2.jpg');assert.equal(downloads.length-beforeLb,1);
  assert.equal((await fetch(base+nes.cover)).status,200);assert.equal(downloads.length-beforeLb,1);
  // Saved in the project cache (covers under temp), never in the games folder.
  assert.equal(fs.existsSync(path.join(temp,'covers','dddd-2.webp')),true);
  assert.equal(fs.existsSync(path.join(temp,'NES','covers')),false);
  const nc=await fetch(base+snes['No Cover (U).smc'].cover);
  assert.equal(nc.status,200);
  assert.equal(lrLog.at(-1),encodeURIComponent(SNES_LIB)+'/Named_Boxarts/No%20Cover%20(USA).png');assert.equal(lrLog.length-beforeLr,1);
  assert.equal((await sharp(Buffer.from(await nc.arrayBuffer())).metadata()).width,400);
  assert.equal(fs.existsSync(path.join(temp,'Super Nintendo','Roms','covers')),false);
  assert.equal(fs.readFileSync(path.join(temp,'Super Nintendo','Roms','No Cover (U).smc'),'utf8'),'smc');
  assert.equal(fs.readdirSync(path.join(temp,'covers')).some(f=>/^lr-.*\.webp$/.test(f)),true);
  // Next listing: the cached image is promised again under its libretro name, nothing is downloaded again.
  const again=(await get('/api/games?system=snes')).games;
  assert.match(again.find(g=>g.file==='No Cover (U).smc').cover,/\?v=lr-[0-9a-f]{16}-400$/);
  assert.equal(again.some(g=>/covers/i.test(g.file)),false);
  assert.equal((await fetch(base+again.find(g=>g.file==='No Cover (U).smc').cover)).status,200);assert.equal(lrLog.length-beforeLr,1);
  // Rejected: unknown console, bad names, files not in the collection, games without a cover anywhere.
  for(const url of ['/api/cover/constructor/test.nes','/api/cover/nes/foo%5Cbar.nes','/api/cover/nes/..%2Fx.nes'])assert.equal((await fetch(base+url)).status,400,url);
  for(const url of ['/api/cover/nes/missing.nes','/api/cover/subidos/genesis.zip','/api/cover/snes/Nothing%20Here%20(U).smc','/api/cover/nes/secret.txt'])assert.equal((await fetch(base+url)).status,404,url);
  // A name from the database that is not a plain image file name is never used.
  assert.equal(downloads.every(n=>/^[\w-]+\.(png|jpe?g|webp)$/.test(n)),true);
  assert.equal(lrLog.every(p=>/^[\w%.()-]+\/(Named_\w+\/([\w%.()'-]+\.png)?)?$/.test(p)),true);
});
test('Arcade: the short MAME name becomes the real title (FinalBurn Neo list) and finds its thumbnail',async()=>{
  const [g]=(await (await fetch(base+'/api/games?system=arcade')).json()).games;
  assert.equal(g.file,'mslug.zip');assert.equal(g.name,'Metal Slug - Super Vehicle-001');
  assert.match(g.cover,/\?v=lr-/);
  assert.equal((await (await fetch(base+'/api/games?system=all&q=metal%20slug')).json()).total,1);
  assert.equal((await (await fetch(base+'/api/games?system=all&q=mslug')).json()).total,1);
});
test('Covers: without LaunchBox nor libretro everything works, with no covers',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remotegame-bare-'));
  fs.mkdirSync(path.join(root,'NES'));for(const f of ['x (U).nes','test.nes'])fs.writeFileSync(path.join(root,'NES',f),'NES');
  const {g,url}=await instance({ gamesRoot:root,coverCacheDir:path.join(root,'cache'),fetchCover:fakeCover,settingsFile:path.join(root,'s2.json') });
  try{
    const list=await (await fetch(url+'/api/games?system=all')).json();
    assert.equal(list.games.filter(g=>g.system==='nes').length,2);assert.equal(list.games.every(g=>g.cover===null),true);
    assert.equal((await fetch(url+'/api/cover/nes/test.nes')).status,404);
  }finally{await g.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('Covers: your own image in RemoteGame\'s covers folder wins; the games folder is never read for them',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remotegame-covers-'));
  const own=fs.mkdtempSync(path.join(os.tmpdir(),'remotegame-propias-'));
  try{
    fs.mkdirSync(path.join(root,'NES'),{recursive:true});
    for(const f of ['a (U).nes','b (U).nes'])fs.writeFileSync(path.join(root,'NES',f),'NES\x1a');
    const mine=await sharp({create:{width:120,height:90,channels:3,background:'#0a0'}}).png().toBuffer();
    fs.mkdirSync(path.join(own,'nes'));fs.writeFileSync(path.join(own,'nes','a (U).png'),mine);
    // The old place, next to the games: not used any more, and left alone.
    fs.mkdirSync(path.join(root,'NES','covers'));fs.writeFileSync(path.join(root,'NES','covers','b (U).png'),mine);
    fs.mkdirSync(path.join(root,'SNES'),{recursive:true});fs.writeFileSync(path.join(root,'SNES','c (U).smc'),'smc');
    const lists={'Nintendo - Nintendo Entertainment System/Named_Boxarts':['a (USA)','b (USA)'],[SNES_LIB+'/Named_Boxarts']:['c (USA)']};
    const {g,url}=await instance({ gamesRoot:root,libretro:true,customCoversDir:own,coverCacheDir:path.join(root,'cache'),libretroCacheDir:path.join(root,'lr'),fetchLibretro:fakeLibretro(lists),fetchDat:fakeDat,settingsFile:path.join(root,'s.json') });
    try{
      await fetch(url+'/api/games?system=all');await g.coversReady();
      const games=Object.fromEntries((await (await fetch(url+'/api/games?system=all')).json()).games.map(x=>[x.file,x]));
      assert.deepEqual(Object.keys(games).filter(f=>games[f].system!=='subidos').sort(),['a (U).nes','b (U).nes','c (U).smc']);
      assert.match(games['a (U).nes'].cover,/\?v=l\d+-400$/);
      const before=lrLog.length;
      const picked=await fetch(url+games['a (U).nes'].cover);
      assert.equal(picked.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await picked.arrayBuffer()),mine);assert.equal(lrLog.length,before);
      // b ignores the copy in the games folder: it gets the downloaded image, and that folder is left as it was.
      const b=await fetch(url+games['b (U).nes'].cover);
      assert.equal(b.status,200);assert.match(b.headers.get('content-type'),/^image\/webp/);
      assert.deepEqual(fs.readdirSync(path.join(root,'NES','covers')),['b (U).png']);
      assert.equal((await fetch(url+games['c (U).smc'].cover)).status,200);
      assert.equal(fs.readdirSync(path.join(root,'cache')).filter(f=>/^lr-.*\.webp$/.test(f)).length,2);
    }finally{await g.close();}
  }finally{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(own,{recursive:true,force:true});}
});
test('Covers: by default nothing is written in the games folder; they go to the project cache',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remotegame-nowrite-'));
  try{
    fs.mkdirSync(path.join(root,'NES'));fs.writeFileSync(path.join(root,'NES','zed (U).nes'),'NES\x1a');
    const {g,url}=await instance({ gamesRoot:root,libretro:true,coverCacheDir:path.join(root,'cache'),libretroCacheDir:path.join(root,'lr'),fetchLibretro:fakeLibretro({'Nintendo - Nintendo Entertainment System/Named_Boxarts':['zed (USA)']}),fetchDat:fakeDat,settingsFile:path.join(root,'s.json') });
    try{
      await fetch(url+'/api/games?system=nes');await g.coversReady();
      const a=(await (await fetch(url+'/api/games?system=nes')).json()).games[0];
      assert.equal((await fetch(url+a.cover)).status,200);
      assert.deepEqual(fs.readdirSync(path.join(root,'NES')),['zed (U).nes']);
      assert.equal(fs.readdirSync(path.join(root,'cache')).filter(f=>/^lr-.*\.webp$/.test(f)).length,1);
      assert.equal((await fetch(url+a.cover)).status,200);
    }finally{await g.close();}
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Covers: serving and caching them creates nothing inside the games folder',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remotegame-readonly-'));
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'remotegame-outside-'));
  try{
    fs.mkdirSync(path.join(root,'NES'));fs.writeFileSync(path.join(root,'NES','mario (U).nes'),'NES\x1a');
    fs.mkdirSync(path.join(root,'Super Nintendo','Roms'),{recursive:true});fs.writeFileSync(path.join(root,'Super Nintendo','Roms','zelda (U).smc'),'smc');
    const before=fs.readdirSync(root,{recursive:true}).sort();
    const {g,url}=await instance({ gamesRoot:root,libretro:true,customCoversDir:path.join(outside,'propias'),coverCacheDir:path.join(outside,'cache'),libretroCacheDir:path.join(outside,'lr'),fetchLibretro:fakeLibretro({'Nintendo - Nintendo Entertainment System/Named_Boxarts':['mario (USA)']}),fetchDat:fakeDat,settingsFile:path.join(outside,'s.json') });
    try{
      await fetch(url+'/api/games?system=all');await g.coversReady();
      const withCover=(await (await fetch(url+'/api/games?system=all')).json()).games.filter(x=>x.cover);
      assert.deepEqual(withCover.map(x=>x.file),['mario (U).nes']);
      for(const x of withCover)assert.equal((await fetch(url+x.cover)).status,200);
      assert.equal(fs.readdirSync(path.join(outside,'cache')).filter(f=>/^lr-.*\.webp$/.test(f)).length,1);
      assert.deepEqual(fs.readdirSync(root,{recursive:true}).sort(),before);
    }finally{await g.close();}
  }finally{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});}
});
test('Settings: finds each console by folder name, saves the choice, and only this PC with the header may touch it',async()=>{
  delete process.env.GAMES_ROOT;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remotegame-settings-'));
  const put=(rel,names)=>{fs.mkdirSync(path.join(root,rel),{recursive:true});for(const n of names)fs.writeFileSync(path.join(root,rel,n),'x');};
  put('Consolas/Nintendo Entertainment System/Roms',['a.nes','b.nes','c.zip']);put('Consolas/Nintendo Entertainment System',['readme.txt']);
  put('Consolas/Super Famicom',['x.sfc']);put('Sega/Mega Drive',['g.md','h.bin']);
  put('PlayStation/Games',['p.bin','q.bin','r.bin']);          // by extension alone this would look like Genesis
  put('Arcade/FBNeo',['pang.zip']);put('Arcade/FBNeo/covers',['pang.png']);
  const settingsFile=path.join(root,'settings.json'),other=fs.mkdtempSync(path.join(os.tmpdir(),'remotegame-empty-'));
  fs.writeFileSync(settingsFile,JSON.stringify({gamesRoot:other}));
  const {g,url}=await instance({ settingsFile });
  const call=(p,body,headers={'X-RemoteGame':'settings'})=>fetch(url+p,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});
  try{
    // Starts from settings.json: an empty folder has nothing.
    let s=await (await call('/api/settings')).json();
    assert.equal(s.gamesRoot,other);assert.deepEqual(s.consoles.filter(c=>c.dir),[]);
    // Scanning shows what would be found, without saving.
    const scan=await (await call('/api/settings/scan',{gamesRoot:'"'+root+'"'})).json();
    const by=Object.fromEntries(scan.consoles.map(c=>[c.id,c]));
    assert.equal(by.nes.dir,path.join(root,'Consolas','Nintendo Entertainment System','Roms'));assert.equal(by.nes.count,3);
    assert.equal(by.snes.dir,path.join(root,'Consolas','Super Famicom'));
    assert.equal(by.genesis.dir,path.join(root,'Sega','Mega Drive'));assert.equal(by.genesis.count,2);
    assert.equal(by.arcade.dir,path.join(root,'Arcade','FBNeo'));assert.equal(by.n64.dir,null);
    assert.equal(JSON.parse(fs.readFileSync(settingsFile,'utf8')).gamesRoot,other);
    // Saving applies it right away and survives in settings.json.
    s=await (await call('/api/settings',{gamesRoot:root})).json();assert.equal(s.gamesRoot,root);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile,'utf8')),{gamesRoot:root});
    const systems=Object.fromEntries((await (await fetch(url+'/api/systems')).json()).systems.map(x=>[x.id,x]));
    assert.equal(systems.nes.count,3);assert.equal(systems.genesis.count,2);assert.equal(systems.arcade.count,1);assert.notEqual(systems.n64.missing,null);
    assert.deepEqual((await (await fetch(url+'/api/games?system=arcade')).json()).games.map(x=>x.file),['pang.zip']);
    // Rejected: no header, wrong header, from outside the PC, folders that do not exist or are files.
    for(const [p,body] of [['/api/settings'],['/api/settings/scan',{gamesRoot:root}],['/api/settings',{gamesRoot:other}],['/api/settings/pick',{}]]){
      assert.equal((await call(p,body,{})).status,403,p);
      assert.equal((await call(p,body,{'X-RemoteGame':'quit'})).status,403,p);
      assert.equal((await call(p,body,{'X-RemoteGame':'settings','X-Forwarded-For':'203.0.113.9'})).status,403,p);
    }
    for(const bad of [path.join(root,'nope'),path.join(root,'Sega','Mega Drive','g.md'),'',null,'a\0b'])assert.equal((await call('/api/settings',{gamesRoot:bad})).status,400);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile,'utf8')),{gamesRoot:root});
    // Visitors from the tunnel never see a path.
    const remote=await (await fetch(url+'/api/systems',{headers:{'X-Forwarded-For':'203.0.113.9'}})).json();
    assert.equal(remote.gamesRoot,undefined);assert.equal(JSON.stringify(remote).includes(root.replace(/\\/g,'\\\\')),false);
    const info=await (await fetch(url+'/api/info',{headers:{'X-Forwarded-For':'203.0.113.9'}})).json();assert.equal(info.gamesRoot,undefined);
  }finally{await g.close();fs.rmSync(root,{recursive:true,force:true});fs.rmSync(other,{recursive:true,force:true});}
});
test('Settings: the folder picker answers with the chosen path; the GAMES_ROOT option has priority over settings.json',async()=>{
  const {g,url}=await instance({ gamesRoot:temp,pickFolder:async()=>'C:\\Juegos',settingsFile:path.join(temp,'s3.json') });
  try{
    const r=await fetch(url+'/api/settings/pick',{method:'POST',headers:{'X-RemoteGame':'settings'}});
    assert.deepEqual(await r.json(),{ok:true,path:'C:\\Juegos'});
    const saved=await (await fetch(url+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json','X-RemoteGame':'settings'},body:JSON.stringify({gamesRoot:os.tmpdir()})})).json();
    assert.equal(saved.locked,true);assert.equal(saved.gamesRoot,temp);
  }finally{await g.close();}
});
test('Version: /api/info has a build; /api/quit needs this PC, the header and a local Host, then calls onQuit',async()=>{
  const info=await (await fetch(base+'/api/info')).json();
  assert.match(info.build,/^[0-9a-f]{12}$/);
  const post=headers=>fetch(base+'/api/quit',{method:'POST',headers});
  assert.equal((await post({})).status,403);
  assert.equal((await post({'X-RemoteGame':'nope'})).status,403);
  assert.equal((await post({'X-RemoteGame':'quit','X-Forwarded-For':'203.0.113.9'})).status,403);
  // A page cannot preflight its way in: there is no CORS.
  const pre=await fetch(base+'/api/quit',{method:'OPTIONS',headers:{Origin:'https://evil.example','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'x-remotegame'}});
  assert.equal(pre.headers.get('access-control-allow-origin'),null);
  await new Promise(r=>setTimeout(r,120));assert.equal(quits,0);
  const ok=await post({'X-RemoteGame':'quit'});assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{ok:true});
  await new Promise(r=>setTimeout(r,200));assert.equal(quits,1);
});
test('Arcade: each ZIP is checked against the FBNeo and MAME 2003-Plus lists and gets the core that can run it, or the reason',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remotegame-arcade-'));
  const crc=c=>zlib.crc32(Buffer.from(c)).toString(16).padStart(8,'0');
  const rom=(n,c,extra='')=>'<rom name="'+n+'" size="1" crc="'+crc(c)+'"'+extra+'/>';
  const fbneo='<datafile>'
    +'<game name="okfb"><description>Ok Game (World)</description>'+rom('a.bin','A')+rom('b.bin','B')+'</game>'
    +'<game isbios="yes" name="mybios"><description>My BIOS</description>'+rom('bios.rom','S')+'</game>'
    +'<game name="needbios" romof="mybios"><description>Needs BIOS</description>'+rom('n.bin','N')+'</game>'
    +'<game name="par"><description>Parent</description>'+rom('p.bin','P')+'</game>'
    +'<game name="kid" cloneof="par" romof="par"><description>Kid</description>'+rom('p.bin','P',' merge="p.bin"')+rom('k.bin','K')+'</game>'
    +'<game name="badver"><description>Other dump</description>'+rom('x.bin','X')+'</game>'
    +'</datafile>';
  const mame='<mame><game name="okmame"><description>Only MAME</description>'+rom('m.bin','M')+'</game>'
    +'<game name="chdg"><description>Disc game</description>'+rom('c.bin','C')+'<disk name="chdg" sha1="00"/></game>'
    +'<game name="chd5"><description>Disc v5</description>'+rom('c.bin','C')+'<disk name="chd5" sha1="00"/></game>'
    +'<game name="chd3"><description>Disc v3</description>'+rom('c.bin','C')+'<disk name="chd3" sha1="00"/></game></mame>';
  const zipTo=(name,files)=>{const z=new AdmZip();for(const [n,c] of Object.entries(files))z.addFile(n,Buffer.from(c));z.writeZip(path.join(root,'MAME',name+'.zip'));};
  fs.mkdirSync(path.join(root,'MAME'),{recursive:true});
  zipTo('okfb',{'a.bin':'A','b.bin':'B'});zipTo('okmame',{'m.bin':'M'});zipTo('chdg',{'c.bin':'C'});zipTo('chd5',{'c.bin':'C'});zipTo('chd3',{'c.bin':'C'});
  // CHD files: only the header matters (magic and big-endian version at byte 12)
  for(const [name,version] of [['chd5',5],['chd3',3]]){const head=Buffer.alloc(124);head.write('MComprHD',0,'latin1');head.writeUInt32BE(version,12);fs.mkdirSync(path.join(root,'MAME',name));fs.writeFileSync(path.join(root,'MAME',name,name+'.chd'),head);}zipTo('needbios',{'n.bin':'N'});
  zipTo('kid',{'k.bin':'K'});zipTo('badver',{'x.bin':'Y'});zipTo('unknown',{'z.bin':'Z'});
  const {g,url}=await instance({ gamesRoot:root,libretro:true,libretroCacheDir:path.join(root,'lr'),coverCacheDir:path.join(root,'cache'),fetchLibretro:fakeLibretro({}),fetchDat:async which=>which==='fbneo'?fbneo:mame,settingsFile:path.join(root,'s.json') });
  try{
    const list=async()=>Object.fromEntries((await (await fetch(url+'/api/games?system=arcade')).json()).games.map(x=>[x.file,x]));
    await list();await g.coversReady();
    let games=await list();
    assert.equal(games['okfb.zip'].play,'/play-ejs.html?system=arcade&file=okfb.zip&core=fbneo');assert.equal(games['okfb.zip'].compat,undefined);
    assert.match(games['okmame.zip'].play,/&core=mame2003_plus$/);
    const bad=f=>{assert.equal(games[f].compat,false,f);assert.doesNotMatch(games[f].play,/core=/);return games[f].reason;};
    assert.equal(bad('chdg.zip'),'Falta el disco CHD (chdg\\chdg.chd)');
    assert.equal(bad('chd5.zip'),'Necesita su disco CHD en versión 3; el tuyo es v5 (MAME moderno), que el emulador del navegador todavía no lee');
    assert.equal(bad('chd3.zip'),'Necesita disco CHD: todavía no soportado');
    assert.equal(bad('needbios.zip'),'Falta el BIOS mybios.zip');
    assert.equal(bad('kid.zip'),'Falta el juego padre par.zip');
    assert.equal(bad('badver.zip'),'Versión de ROMs distinta');
    assert.equal(bad('unknown.zip'),'No está en FBNeo ni en MAME 2003-Plus');
    // Names still come from the list; the same JSON is behind /api/game (the player page shows the reason).
    assert.equal(games['okfb.zip'].name,'Ok Game');
    const one=await (await fetch(url+'/api/game/arcade/kid.zip')).json();assert.deepEqual([one.compat,one.reason],[false,'Falta el juego padre par.zip']);
    // The parent shows up: the clone now runs, without restarting.
    zipTo('par',{'p.bin':'P'});
    games=await list();
    assert.match(games['kid.zip'].play,/&core=fbneo$/);assert.equal(games['kid.zip'].compat,undefined);
  }finally{await g.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('Search: Spanish spelling finds the English title; no result says so',async()=>{
  const get=async url=>(await fetch(base+url)).json();
  for(const q of ['internacional','internac','internationa','internacional soccer','INTERNACIONAL super'])assert.deepEqual((await get('/api/games?system=snes&q='+encodeURIComponent(q))).games.map(g=>g.name),['International Superstar Soccer'],q);
  assert.equal((await get('/api/games?system=all&q=internacional')).total,1);
  // No stray hits: -cion only appears for a real "-tion" word.
  for(const q of ['internacionales','mundial'])assert.equal((await get('/api/games?system=all&q='+q)).total,0,q);
  assert.equal((await get('/api/games?system=snes&q=zzzz')).total,0);
});
// The tunnel runs ngrok: these tests inject a fake process that writes ngrok's JSON lines, so the real ngrok never starts.
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const fakeNgrok = () => { const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', null)); return true; }; return c; };
const ngrokLine = entry => JSON.stringify(entry) + '\n';
const waitFor = async cond => { for (let i = 0; i < 300 && !cond(); i++) await new Promise(r => setTimeout(r, 10)); assert.ok(cond(), 'no llegó a tiempo'); };
test('Tunnel: starting, then on with the https link; one ngrok at a time; stop turns it off and drops the link',async()=>{
  const spawned=[];const spawnTunnel=(cmd,args)=>{const c=fakeNgrok();c.cmd=cmd;c.args=args;spawned.push(c);return c;};
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remotegame-tunnel-'));
  const {g,url}=await instance({ spawnTunnel,settingsFile:path.join(root,'settings.json') });
  try{
    assert.deepEqual(g.tunnel.state(),{state:'off',url:null,error:null});
    assert.equal(g.tunnel.wanted(),true);   // no settings.json yet: the tunnel starts on
    assert.equal(g.tunnel.start().state,'starting');
    assert.equal(g.tunnel.start().state,'starting');   // a second start does not spawn another ngrok
    assert.equal(spawned.length,1);
    assert.equal(spawned[0].cmd,'ngrok');
    assert.deepEqual(spawned[0].args,['http',String(g.server.address().port),'--log','stdout','--log-format','json']);
    spawned[0].stdout.write(ngrokLine({lvl:'info',msg:'started tunnel',url:'https://demo.ngrok-free.app'}));
    await waitFor(()=>g.tunnel.state().state==='on');
    assert.deepEqual(g.tunnel.state(),{state:'on',url:'https://demo.ngrok-free.app',error:null});
    const party=await (await fetch(url+'/api/party')).json();
    assert.equal(party.publicUrl,'https://demo.ngrok-free.app');assert.equal(party.tunnel.state,'on');
    assert.deepEqual(g.tunnel.stop(),{state:'off',url:null,error:null});
    assert.equal(spawned[0].killed,true);
    assert.equal((await (await fetch(url+'/api/party')).json()).publicUrl,null);
    assert.equal(g.tunnel.stop().state,'off');   // stopping twice is harmless
  }finally{await g.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('Tunnel: a dead ngrok leaves an error and no link; a missing authtoken or ngrok is explained',async()=>{
  const spawned=[];let mode='ok';
  const spawnTunnel=()=>{const c=fakeNgrok();spawned.push(c);if(mode==='missing')setImmediate(()=>c.emit('error',Object.assign(new Error('spawn ngrok ENOENT'),{code:'ENOENT'})));return c;};
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remotegame-tunnel-'));
  const {g,url}=await instance({ spawnTunnel,settingsFile:path.join(root,'settings.json') });
  try{
    g.tunnel.start();
    spawned[0].stdout.write(ngrokLine({lvl:'info',url:'https://demo.ngrok-free.app'}));
    await waitFor(()=>g.tunnel.state().state==='on');
    spawned[0].emit('exit',1);
    assert.deepEqual(g.tunnel.state(),{state:'error',url:null,error:'ngrok se cerró (código 1)'});
    assert.equal((await (await fetch(url+'/api/party')).json()).publicUrl,null);
    // Without an authtoken ngrok logs it, then exits.
    g.tunnel.start();
    spawned[1].stdout.write(ngrokLine({lvl:'crit',msg:'command failed',err:'authentication failed: Usage of ngrok requires a verified account and authtoken.'}));
    await waitFor(()=>g.tunnel.state().error);
    spawned[1].emit('exit',1);
    assert.deepEqual(g.tunnel.state(),{state:'error',url:null,error:'Falta configurar el authtoken de ngrok'});
    // Without ngrok on the PATH the spawn itself fails with ENOENT.
    mode='missing';
    g.tunnel.start();
    await waitFor(()=>g.tunnel.state().state==='error');
    assert.deepEqual(g.tunnel.state(),{state:'error',url:null,error:'ngrok no está instalado (winget install ngrok.ngrok)'});
    assert.deepEqual(g.tunnel.stop(),{state:'off',url:null,error:null});
  }finally{await g.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('Tunnel switch: only this PC with its header; the choice is saved in settings.json beside the other keys',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remotegame-switch-'));
  const settingsFile=path.join(root,'settings.json');
  fs.writeFileSync(settingsFile,JSON.stringify({gamesRoot:root}));
  const spawned=[];
  const {g,url}=await instance({ spawnTunnel:()=>{const c=fakeNgrok();spawned.push(c);return c;},settingsFile });
  const saved=()=>JSON.parse(fs.readFileSync(settingsFile,'utf8'));
  const call=(method,body,headers={'X-RemoteGame':'tunnel'})=>fetch(url+'/api/tunnel',{method,headers:{'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});
  try{
    // No header, another header, or a request that came through the tunnel: 403, nothing starts, nothing is saved.
    for(const [method,body,headers] of [['GET',undefined,{}],['POST',{on:true},{}],['POST',{on:true},{'X-RemoteGame':'settings'}],['POST',{on:true},{'X-RemoteGame':'tunnel','X-Forwarded-For':'203.0.113.9'}],['GET',undefined,{'X-RemoteGame':'tunnel','X-Forwarded-For':'203.0.113.9'}]])
      assert.equal((await call(method,body,headers)).status,403,method+' '+JSON.stringify(headers));
    assert.equal(spawned.length,0);assert.deepEqual(saved(),{gamesRoot:root});
    // This PC: the owner's GET answers; POST on starts ngrok and saves share: true.
    assert.equal((await (await call('GET')).json()).tunnel.state,'off');
    let r=await call('POST',{on:true});assert.equal(r.status,200);
    assert.equal((await r.json()).tunnel.state,'starting');
    assert.equal(spawned.length,1);
    spawned[0].stdout.write(ngrokLine({lvl:'info',url:'https://demo.ngrok-free.app'}));
    await waitFor(()=>g.tunnel.state().state==='on');
    assert.equal((await (await call('GET')).json()).tunnel.url,'https://demo.ngrok-free.app');
    assert.equal((await (await fetch(url+'/api/party')).json()).tunnel.state,'on');
    assert.deepEqual(saved(),{gamesRoot:root,share:true});
    // POST off stops ngrok and saves share: false, so the next start keeps it off.
    r=await call('POST',{on:false});assert.deepEqual(await r.json(),{ok:true,tunnel:{state:'off',url:null,error:null}});
    assert.equal(spawned[0].killed,true);
    assert.deepEqual(saved(),{gamesRoot:root,share:false});
    assert.equal(g.tunnel.wanted(),false);
    // Anything but true or false is refused and changes nothing.
    for(const bad of [{},{on:'yes'},{on:1}])assert.equal((await call('POST',bad)).status,400);
    assert.deepEqual(saved(),{gamesRoot:root,share:false});
  }finally{await g.close();fs.rmSync(root,{recursive:true,force:true});}
});

// ---- Native emulators: Switch library, detection and POST /api/launch (the real programs are never started)
const SWITCH_FILES = [
  'Mario Kart 8 Deluxe/Mario Kart 8 Deluxe [0100152000022000][v0] (6.77 GB).nsp',
  'Mario Kart 8 Deluxe/Mario Kart 8 Deluxe [0100152000022800][v1441792] (4.52 GB).nsp',
  'Mario Kart 8 Deluxe/Mario Kart 8 Deluxe [DLC Booster Course Pass] [0100152000023001][v65536].nsp',
  'Super Mario Galaxy 1-2/Super Mario Galaxy/Super Mario Galaxy [010099C022B96000][v0] (3.30 GB).nsp',
  'Super Mario Galaxy 1-2/Super Mario Galaxy/Super Mario Galaxy [010099C022B96800][v327680] (0.32 GB).nsp',
  'Super Mario Galaxy 1-2/Super Mario Galaxy 2/Super Mario Galaxy 2 [0100FD8022DAA000][v0] (2.62 GB).nsp',
  'Super Mario Galaxy 1-2/Super Mario Galaxy 2/Super Mario Galaxy 2 [0100FD8022DAA800][v393216] (0.23 GB).nsp',
  'Super Mario Party Jamboree/Super Mario Party Jamboree [0100965017338000][v0].nsp',
  'Super Mario Party Jamboree/Super Mario Party Jamboree [0100965017338800][v458752].nsp'
];
// A games folder with MAME, Eden and a decoy MAME outside the "Emulador" folders.
function emuRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remotegame-emu-'));
  const put = rel => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); return f; };
  const exes = { mame: put('MAME/Emulador/MAME/mame.exe'), eden: put('Nintendo Switch 1/Emulador/Eden/eden.exe'), flycast: put('Naomi-Naomi2-Atomiswave/Emulador/Flycast/flycast.exe') };
  put('Nintendo Switch 1/Emulador/Eden/eden-cli.exe'); put('Stuff/mame.exe');
  put('MAME/Roms/kinst2.zip'); put('MAME/Roms/mslug.zip'); put('MAME/Roms/-evil.zip');
  for (const f of SWITCH_FILES) put('Nintendo Switch 1/Roms/' + f);
  return { root, exes };
}
const fakeSpawner = mode => {
  const spawn = (exe, args, opts) => {
    const child = new EventEmitter(); child.pid = 4242; child.unref = () => {};
    if (mode === 'enoent') { child.pid = undefined; process.nextTick(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))); }
    spawn.calls.push({ exe, args, opts, child });
    return child;
  };
  spawn.calls = [];
  return spawn;
};
const launchCall = (url, body, headers = { 'X-RemoteGame': 'launch' }) => fetch(url + '/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('Switch: base games only, updates and DLC grouped by title id; without ids, by title', () => {
  const files = SWITCH_FILES.map(f => ({ file: path.basename(f), full: '/x/' + f }));
  const games = groupSwitch(files);
  assert.deepEqual(games.map(g => g.file), [
    'Mario Kart 8 Deluxe [0100152000022000][v0] (6.77 GB).nsp',
    'Super Mario Galaxy [010099C022B96000][v0] (3.30 GB).nsp',
    'Super Mario Galaxy 2 [0100FD8022DAA000][v0] (2.62 GB).nsp',
    'Super Mario Party Jamboree [0100965017338000][v0].nsp'
  ]);
  const by = Object.fromEntries(games.map(g => [g.file.split(' [')[0], g]));
  assert.deepEqual(by['Mario Kart 8 Deluxe'].updates, [{ file: 'Mario Kart 8 Deluxe [0100152000022800][v1441792] (4.52 GB).nsp', version: 1441792 }]);
  assert.equal(by['Mario Kart 8 Deluxe'].dlc, 1);
  // Galaxy 1 and 2 have their own ids: neither takes the other's update.
  assert.equal(by['Super Mario Galaxy'].updates[0].version, 327680);
  assert.equal(by['Super Mario Galaxy 2'].updates[0].version, 393216);
  assert.equal(by['Super Mario Galaxy'].dlc + by['Super Mario Galaxy 2'].dlc + by['Super Mario Party Jamboree'].dlc, 0);
  // Several updates: newest first. An update or DLC with no base game is not listed.
  const more = groupSwitch([
    { file: 'A [0100000000001000][v0].nsp' }, { file: 'A [0100000000001800][v65536].nsp' }, { file: 'A [0100000000001800][v131072].nsp' },
    { file: 'A DLC [0100000000002001][v1].nsp' }, { file: 'A DLC 2 [0100000000002002][v1].nsp' },
    { file: 'Orphan [0100000000009800][v1].nsp' }, { file: 'Orphan DLC [0100000000010001][v1].nsp' }
  ]);
  assert.equal(more.length, 1); assert.deepEqual(more[0].updates.map(u => u.version), [131072, 65536]); assert.equal(more[0].dlc, 2);
  // No ids (plain dumps): a base unless tagged, extras found by title.
  const plain = groupSwitch([{ file: 'Cool Game.xci' }, { file: 'Cool Game [UPD][v2].nsp' }, { file: 'Cool Game [DLC Pack].nsp' }, { file: 'Other Game.nsp' }]);
  assert.deepEqual(plain.map(g => [g.file, g.updates.length, g.dlc]), [['Cool Game.xci', 1, 1], ['Other Game.nsp', 0, 0]]);
});

test('Switch: the library lists the base games with clean titles; there is no web player for them', async () => {
  const { root } = emuRoot();
  const { g, url } = await instance({ gamesRoot: root, settingsFile: path.join(root, 'settings.json') });
  try {
    const list = await (await fetch(url + '/api/games?system=switch')).json();
    assert.equal(list.total, 4);   // Mario Kart 8, Galaxy 1, Galaxy 2, Party Jamboree
    assert.deepEqual(list.games.map(x => x.name), ['Mario Kart 8 Deluxe', 'Super Mario Galaxy', 'Super Mario Galaxy 2', 'Super Mario Party Jamboree']);
    const mk = list.games[0];
    assert.equal(mk.extra, 'Actualización v1441792 · 1 DLC');
    assert.equal(mk.file, 'Mario Kart 8 Deluxe [0100152000022000][v0] (6.77 GB).nsp');
    assert.equal(mk.play, null); assert.equal(mk.pcOnly, true); assert.equal(mk.pc, true); assert.equal(mk.systemLabel, 'Nintendo Switch');
    assert.equal((await fetch(url + '/api/rom/switch/' + encodeURIComponent(mk.file))).status, 404);
    assert.equal((await fetch(url + '/api/cover/switch/' + encodeURIComponent(mk.file))).status, 404);   // no source knows it: the card shows the placeholder
    const sys = await (await fetch(url + '/api/systems')).json();
    const s = sys.systems.find(x => x.id === 'switch');
    assert.equal(s.count, 4); assert.equal(s.pcOnly, true); assert.equal(sys.owner, true);
    assert.equal(sys.systems.find(x => x.id === 'arcade').pc, true); assert.equal(sys.systems.find(x => x.id === 'nes').pc, false);
    assert.equal((await (await fetch(url + '/api/systems', { headers: { 'X-Forwarded-For': '203.0.113.9' } })).json()).owner, false);
    // The settings scan finds the folder by its name ("Nintendo Switch 1") and counts the games inside the nested folders.
    const scan = await (await fetch(url + '/api/settings/scan', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RemoteGame': 'settings' }, body: JSON.stringify({ gamesRoot: root }) })).json();
    const found = scan.consoles.find(c => c.id === 'switch');
    assert.equal(found.dir, path.join(root, 'Nintendo Switch 1', 'Roms')); assert.equal(found.count, 9);
  } finally { await g.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Emulators: found inside the games folder ("Emulador" first); the options and settings.json can override', async () => {
  const { root, exes } = emuRoot();
  const settingsFile = path.join(root, 'settings.json');
  const custom = path.join(root, 'Stuff', 'mame.exe'), eden2 = path.join(root, 'Stuff', 'eden.exe');
  fs.writeFileSync(eden2, 'x');
  let a = await instance({ gamesRoot: root, settingsFile });
  try {
    assert.deepEqual(a.g.emulators(), exes);   // the decoy mame.exe (shallower, but outside "Emulador") loses
    // 5 levels down is not looked at, and nothing is invented when nothing is there.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'remotegame-noemu-'));
    fs.mkdirSync(path.join(empty, 'a', 'b', 'c', 'd', 'e'), { recursive: true }); fs.writeFileSync(path.join(empty, 'a', 'b', 'c', 'd', 'e', 'mame.exe'), 'x');
    const b = await instance({ gamesRoot: empty, settingsFile: path.join(empty, 's.json') });
    try { assert.deepEqual(b.g.emulators(), { mame: null, eden: null, flycast: null }); } finally { await b.g.close(); fs.rmSync(empty, { recursive: true, force: true }); }
  } finally { await a.g.close(); }
  // settings.json wins over the search (read on every launch); the options win over settings.json.
  fs.writeFileSync(settingsFile, JSON.stringify({ emulators: { mame: custom, eden: '"' + eden2 + '"' } }));
  a = await instance({ gamesRoot: root, settingsFile });
  try { assert.deepEqual(a.g.emulators(), { ...exes, mame: custom, eden: eden2 }); } finally { await a.g.close(); }
  a = await instance({ gamesRoot: root, settingsFile, emulators: { mame: exes.mame } });
  try { assert.equal(a.g.emulators().mame, exes.mame); assert.equal(a.g.emulators().eden, eden2); } finally { await a.g.close(); }
  // A configured path that does not exist is an error, not a silent fallback.
  fs.writeFileSync(settingsFile, JSON.stringify({ emulators: { mame: path.join(root, 'nope.exe') } }));
  const spawn = fakeSpawner();
  a = await instance({ gamesRoot: root, settingsFile, spawnEmulator: spawn });
  try {
    const r = await launchCall(a.url, { system: 'arcade', file: 'kinst2.zip' });
    assert.equal(r.status, 404); assert.equal((await r.json()).msg, 'La ruta de MAME en los ajustes no existe.');
    assert.equal(spawn.calls.length, 0);
  } finally { await a.g.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Launch: exact MAME and Eden command lines, detached, in the emulator folder; one at a time', async () => {
  const { root, exes } = emuRoot();
  const spawn = fakeSpawner();
  const { g, url } = await instance({ gamesRoot: root, settingsFile: path.join(root, 'settings.json'), spawnEmulator: spawn });
  try {
    // Arcade: the set name, MAME's own folder as cwd, the arcade folder first in the ROM path.
    let r = await launchCall(url, { system: 'arcade', file: 'kinst2.zip' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, emulator: 'MAME', name: 'kinst2' });
    assert.equal(spawn.calls.length, 1);
    assert.equal(spawn.calls[0].exe, exes.mame);
    assert.deepEqual(spawn.calls[0].args, ['kinst2', '-keyboardprovider', 'win32', '-window', '-maximize', '-rompath', path.join(root, 'MAME', 'Roms') + ';roms']);
    assert.deepEqual(spawn.calls[0].opts, { cwd: path.dirname(exes.mame), detached: true, stdio: 'ignore', windowsHide: false });
    // A second one while the first is alive: told so, nothing starts, and where to continue.
    r = await launchCall(url, { system: 'arcade', file: 'mslug.zip' });
    assert.equal(r.status, 409);
    const busy = await r.json();
    assert.equal(busy.busy, true); assert.equal(busy.emulator, 'MAME'); assert.equal(busy.name, 'kinst2'); assert.equal(busy.system, 'arcade'); assert.match(busy.msg, /Ya abrí MAME/);
    assert.equal(spawn.calls.length, 1);
    // Closed by the player: the next one opens. Switch: Eden with the base game's real path (inside its own folders).
    spawn.calls[0].child.emit('exit', 0);
    const mk = (await (await fetch(url + '/api/games?system=switch')).json()).games[0];
    r = await launchCall(url, { system: 'switch', file: mk.file });
    assert.deepEqual(await r.json(), { ok: true, emulator: 'Eden', name: 'Mario Kart 8 Deluxe' });
    assert.equal(spawn.calls[1].exe, exes.eden);
    assert.deepEqual(spawn.calls[1].args, ['-g', path.join(root, 'Nintendo Switch 1', 'Roms', 'Mario Kart 8 Deluxe', mk.file)]);
    assert.equal(spawn.calls[1].opts.cwd, path.dirname(exes.eden)); assert.equal(spawn.calls[1].opts.detached, true);
    // A name that MAME would read as an option never reaches it.
    spawn.calls[1].child.emit('exit', 0);
    r = await launchCall(url, { system: 'arcade', file: '-evil.zip' });
    assert.equal(r.status, 500); assert.equal(spawn.calls.length, 2);
  } finally { await g.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Launch: only this PC with its header, only library games; clear errors when the emulator is missing or fails', async () => {
  const { root } = emuRoot();
  const spawn = fakeSpawner();
  const { g, url } = await instance({ gamesRoot: root, settingsFile: path.join(root, 'settings.json'), spawnEmulator: spawn });
  const body = { system: 'arcade', file: 'kinst2.zip' };
  const hostCall = host => new Promise((resolve, reject) => {
    const u = new URL(url + '/api/launch');
    const req = require('node:http').request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { Host: host, 'Content-Type': 'application/json', 'X-RemoteGame': 'launch' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  try {
    // No header, another header, through the tunnel, or a foreign Host (DNS rebinding): 403.
    for (const headers of [{}, { 'X-RemoteGame': 'settings' }, { 'X-RemoteGame': 'launch', 'X-Forwarded-For': '203.0.113.9' }]) assert.equal((await launchCall(url, body, headers)).status, 403, JSON.stringify(headers));
    assert.equal(await hostCall('evil.example'), 403);
    assert.equal((await fetch(url + '/api/launch', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } })).headers.get('access-control-allow-origin'), null);
    assert.equal(spawn.calls.length, 0);
    // Not a game of the library, a bad name, a system with no native emulator, an empty body.
    for (const [b, status] of [[{ system: 'arcade', file: 'nope.zip' }, 404], [{ system: 'switch', file: 'Nope.nsp' }, 404], [{ system: 'arcade', file: '..\\kinst2.zip' }, 400], [{ system: 'arcade', file: '../x.zip' }, 400],
      [{ system: 'nes', file: 'test.nes' }, 400], [{ system: 'nope', file: 'a.zip' }, 400], [{}, 400]]) assert.equal((await launchCall(url, b)).status, status, JSON.stringify(b));
    assert.equal(spawn.calls.length, 0);
    // A program that cannot start (blocked, deleted) says so and frees the slot.
    const bad = fakeSpawner('enoent');
    const other = await instance({ gamesRoot: root, settingsFile: path.join(root, 's2.json'), spawnEmulator: bad });
    try {
      const r = await launchCall(other.url, body);
      assert.equal(r.status, 500); assert.equal((await r.json()).msg, 'No pude abrir MAME: el programa no existe.');
      assert.equal((await launchCall(other.url, body)).status, 500);   // not "busy": the failed one is not kept
      assert.equal(bad.calls.length, 2);
    } finally { await other.g.close(); }
    // No emulator in the games folder.
    fs.rmSync(path.join(root, 'MAME', 'Emulador'), { recursive: true });
    fs.rmSync(path.join(root, 'Stuff'), { recursive: true });
    const none = await instance({ gamesRoot: root, settingsFile: path.join(root, 's3.json'), spawnEmulator: spawn });
    try {
      const r = await launchCall(none.url, body);
      assert.equal(r.status, 404); assert.equal((await r.json()).msg, 'No encontré MAME en tu carpeta de juegos.');
    } finally { await none.g.close(); }
    assert.equal(spawn.calls.length, 0);
  } finally { await g.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
