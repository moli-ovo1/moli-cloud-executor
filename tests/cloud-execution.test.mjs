import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CharacterExecution} from '../cloud-executor/src/worker.mjs';
import {snapshot,context,MemoryStorage} from './cloud-helpers.mjs';
const actor={id:'client-1',tenantId:'user-1',storeId:'store-1',epoch:1};
const env=()=>({CLIENTS_JSON:JSON.stringify([{...actor,origin:'https://moli.test',tokenHash:'a'.repeat(64),active:true}])});
const call=async(d,op,body)=>{const r=await d.fetch(new Request('https://internal/v1/'+op,{method:'POST',body:JSON.stringify({actor,body})}));return {httpStatus:r.status,...await r.json()};};
test('ten duplicate triggers and pulls preserve one result and ACK is repeatable',async()=>{
  const ctx=context(),d=new CharacterExecution(ctx,env()),s=snapshot('alice',{runAt:Date.now()});
  const ids=await Promise.all(Array.from({length:10},()=>call(d,'snapshot',s)));assert.equal(new Set(ids.map(x=>x.wakeId)).size,1);
  await Promise.all(Array.from({length:10},()=>d.alarm()));
  const results=await Promise.all(Array.from({length:10},()=>call(d,'result',{})));
  assert.equal(new Set(results.map(x=>x.delivery.resultHash)).size,1);
  const job=(await ctx.storage.get('slot')).jobs[0];assert.equal(job.attempts,1);
  for(let i=0;i<10;i++)assert.equal((await call(d,'ack',{wakeId:job.wakeId,resultHash:job.delivery.resultHash})).httpStatus,200);
  assert.equal((await call(d,'result',{})).status,'idle');
});
test('stale and conflicting snapshots, pending overwrite, incorrect ACK are rejected',async()=>{
  const d=new CharacterExecution(context(),env()),s=snapshot();await call(d,'snapshot',s);
  assert.equal((await call(d,'snapshot',{...s,character:{...s.character,name:'changed'}})).error,'snapshot-conflict');
  assert.equal((await call(d,'snapshot',{...s,snapshotId:'old',sourceRevision:1})).error,'stale-revision');
  assert.equal((await call(d,'snapshot',{...s,snapshotId:'new',sourceRevision:2})).error,'pending-result');
  assert.equal((await call(d,'ack',{wakeId:'bad',resultHash:'a'})).error,'ack-mismatch');
});
test('restart with durable running state recovers without changing wakeId',async()=>{
  const store=new MemoryStorage(),d=new CharacterExecution(context(store),env()),s=snapshot('alice',{runAt:Date.now()});
  const accepted=await call(d,'snapshot',s);const slot=await store.get('slot');slot.jobs[0].status='running';slot.jobs[0].attempts=1;await store.put('slot',slot);
  const restarted=new CharacterExecution(context(store),env());await restarted.alarm();
  assert.equal((await call(restarted,'result',{})).delivery.result.wakeId,accepted.wakeId);
});
test('revocation/rotation before alarm cancels old authority and expired snapshot blocks',async()=>{
  for(const mode of ['revoke','rotate','expire']){
    const e=env(),ctx=context(),d=new CharacterExecution(ctx,e),s=snapshot('alice',{runAt:Date.now()});await call(d,'snapshot',s);
    if(mode==='expire'){const slot=await ctx.storage.get('slot');slot.jobs[0].snapshot.expiresAt=Date.now()-1;await ctx.storage.put('slot',slot);}
    else {const rows=JSON.parse(e.CLIENTS_JSON);if(mode==='rotate')rows[0].epoch++;else rows[0].active=false;e.CLIENTS_JSON=JSON.stringify(rows);}
    await d.alarm();assert.equal((await ctx.storage.get('slot')).jobs[0].status,mode==='expire'?'blocked-expired':'cancelled');
  }
});
test('two Character slots execute independently',async()=>{
  const a=new CharacterExecution(context(),env()),b=new CharacterExecution(context(),env());
  await Promise.all([call(a,'snapshot',snapshot('alice',{runAt:Date.now()})),call(b,'snapshot',snapshot('bob',{runAt:Date.now()}))]);
  await Promise.all([a.alarm(),b.alarm()]);
  const ra=(await call(a,'result',{})).delivery,rb=(await call(b,'result',{})).delivery;
  assert.equal(ra.result.characterId,'alice');assert.equal(rb.result.characterId,'bob');assert.notEqual(ra.result.wakeId,rb.result.wakeId);
});
