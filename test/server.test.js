const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { io } = require('socket.io-client');
const AdmZip = require('adm-zip');
const { createRemoteGame } = require('../server');
let temp, game, base;
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
  game=createRemoteGame({ gamesRoot:temp,localRoms:path.join(temp,'uploads') });
  game.server.listen(0,'127.0.0.1');await once(game.server,'listening');
  base='http://127.0.0.1:'+game.server.address().port;
});
after(async () => {
  for(const client of clients) client.close();
  await game.close();
  fs.rmSync(temp,{recursive:true,force:true});
});
async function wsClient() {
  const ws=new WebSocket(base.replace('http','ws')+'/ws'); clients.push(ws);
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
  const list=await (await fetch(base+'/api/games?system=arcade')).json();assert.equal(list.total,0);
  assert.equal((await fetch(base+'/api/rom/nes/test.nes')).headers.get('cache-control'),'no-cache');
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
test('Live rooms: any system, guest gets the game info, large SDP relayed, guest can rejoin',async()=>{
  const host=await wsClient(),guest=await wsClient();
  send(host,{t:'create',mode:'live',system:'arcade',rom:'missing.zip',core:'fbneo'});await message(host,'error');
  send(host,{t:'create',mode:'live',system:'nes',rom:'test.nes',core:'../x'});await message(host,'error');
  send(host,{t:'create',mode:'live',system:'nes',rom:'test.nes',core:'nes'});
  const created=await message(host,'created');assert.equal(created.kind,'live');
  send(guest,{t:'join',room:created.room});
  const joined=await message(guest,'joined');assert.deepEqual([joined.kind,joined.core,joined.rom],['live','nes','test.nes']);
  await message(host,'peer');
  const sdp='v=0\r\n'+'a=x\r\n'.repeat(3000);
  send(host,{t:'signal',data:{sdp:{type:'offer',sdp}}});assert.equal((await message(guest,'signal')).data.sdp.sdp,sdp);
  send(host,{t:'start'});await new Promise(r=>setTimeout(r,20));assert.equal(game.rooms.get(created.room).phase,'waiting');
  guest.close();await message(host,'peer-left');
  const again=await wsClient();send(again,{t:'join',room:created.room});await message(again,'joined');await message(host,'peer');
  host.close();await message(again,'ended');
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
