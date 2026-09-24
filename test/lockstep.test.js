const test=require('node:test');
const assert=require('node:assert/strict');
const Lockstep=require('../public/lockstep');
test('Two peers consume identical input frames despite jitter and a long pause',()=>{
  const a=new Lockstep(2),b=new Lockstep(2),queue=[],left=[],right=[];
  for(let time=0;time<1500;time++){
    for(let i=queue.length-1;i>=0;i--){if(queue[i].at<=time){const m=queue.splice(i,1)[0];m.target.receive(m.frame,m.pad);}}
    a.tick(time%256,(frame,pad)=>queue.push({target:b,frame,pad,at:time+time%7}), (p1,p2)=>left.push([p1,p2]));
    if(time<100||time>600)b.tick((time*3)%256,(frame,pad)=>queue.push({target:a,frame,pad,at:time+time%5}),(p2,p1)=>right.push([p1,p2]));
    assert.ok(a.local.size<=3);assert.ok(b.local.size<=3);
  }
  const count=Math.min(left.length,right.length);
  assert.ok(count>100);assert.deepEqual(left.slice(0,count),right.slice(0,count));
});
test('A stalled peer cannot accumulate a backlog or fast-forward the emulator',()=>{
  const a=new Lockstep(2);let sent=0,frames=0;
  for(let i=0;i<10000;i++)a.tick(i%256,()=>sent++,()=>frames++);
  assert.equal(frames,2);assert.equal(sent,3);assert.equal(a.local.size,3);
  assert.equal(a.receive(10000,1),false);assert.equal(a.receive(2,999),false);
  a.receive(2,1);a.tick(3,()=>sent++,()=>frames++);assert.equal(frames,3);
});
test('Reset clears old inputs and applies a common delay',()=>{
  const a=new Lockstep(6);a.receive(8,99);a.reset(1);
  assert.equal(a.remote.has(8),false);assert.equal(a.next,1);assert.equal(a.remote.get(0),0);
});
