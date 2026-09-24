const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  fs.mkdirSync('test-results',{recursive:true});
  const browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']});
  const base=process.env.TEST_URL||'http://localhost:3000';
  const result=[];
  try {
    const context=await browser.newContext();const host=await context.newPage();
    await host.goto(base);await host.getByRole('button',{name:/Arcade \/ Neo Geo/}).waitFor();
    const games=await fetch(base+'/api/games?system=nes&q=contra&limit=1').then(r=>r.json());
    const file=games.games[0]?.file;if(!file)throw Error('Falta ROM NES de prueba');
    await host.goto(base+'/play.html?system=nes&create='+encodeURIComponent(file));
    await host.waitForFunction(()=>window.nes&&window.room,{},{timeout:30000});
    const room=await host.evaluate(()=>window.room);
    const guestContext=await browser.newContext();const guest=await guestContext.newPage();
    await guest.goto(base+'/play.html?room='+room);
    await guest.waitForFunction(()=>window.nes,{},{timeout:30000});
    await host.locator('#btnStart').click();
    await Promise.all([host,guest].map(p=>p.waitForFunction(()=>running&&sync.frame>10,{},{timeout:15000})));
    await guest.keyboard.down('Enter');await guest.waitForTimeout(100);await guest.keyboard.up('Enter');
    await Promise.all([host,guest].map(p=>p.evaluate(()=>{
      const original=nes.frame.bind(nes);
      nes.frame=function(){original();if(sync.frame===180){window.savedSnapshot=JSON.stringify(nes.toJSON());running=false;}};
    })));
    await Promise.all([host,guest].map(p=>p.waitForFunction(()=>window.savedSnapshot,{},{timeout:20000})));
    assert.equal(await host.evaluate(()=>savedSnapshot),await guest.evaluate(()=>savedSnapshot));
    result.push({system:'NES',file,status:'2 browsers: identical emulated state at frame 180 with remote input'});
    await host.screenshot({path:'test-results/nes.png'});await context.close();await guestContext.close();
    for(const item of [
      {system:'arcade',q:'mslug',core:'fbneo'},
      {system:'genesis',q:'sonic',core:'segaMD'},
      {system:'snes',q:'bomberman',core:'snes'},
      {system:'n64',q:'mario kart',core:'n64'}
    ]) {
      const ctx=await browser.newContext();const page=await ctx.newPage();const errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      page.on('response',response=>{if(response.status()>=400&&!response.url().endsWith('/favicon.ico'))errors.push(response.status()+' '+response.url());});
      let file;
      try {
        const list=await fetch(base+'/api/games?system='+item.system+'&q='+encodeURIComponent(item.q)+'&limit=1').then(r=>r.json());
        file=list.games[0]?.file;if(!file)throw Error('Sin ROM de prueba');
        await page.goto(base+'/play-ejs.html?system='+item.system+'&file='+encodeURIComponent(file)+'&core='+item.core);
        await page.getByText('Start Game',{exact:true}).click({timeout:60000});
        await page.waitForFunction(()=>window.EJS_emulator?.gameManager?.getFrameNum()>600,{},{timeout:120000});
        await page.waitForTimeout(5000);
        const before=await page.evaluate(()=>EJS_emulator.gameManager.getFrameNum());await page.waitForTimeout(1000);
        const after=await page.evaluate(()=>EJS_emulator.gameManager.getFrameNum());
        const details={...item,file,status:'core advances; screenshot requires visual verification',framesPerWallSecond:after-before,errors};result.push(details);console.log(JSON.stringify(details));
      }catch(e){const details={...item,file,status:'failed',reason:e.message,errors};result.push(details);console.log(JSON.stringify(details));}
      await page.screenshot({path:'test-results/'+item.system+'.png'});await ctx.close();
      fs.writeFileSync('test-results/browser.json',JSON.stringify(result,null,2));
    }
    if(result.some(item=>item.status==='failed'))process.exitCode=1;
  } finally { fs.writeFileSync('test-results/browser.json',JSON.stringify(result,null,2));await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
