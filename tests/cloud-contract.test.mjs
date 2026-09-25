import {test} from 'node:test';
import assert from 'node:assert/strict';
import {snapshot} from './cloud-helpers.mjs';
import {validateSnapshot,projectSnapshot,requestFromSnapshot,wakeIdFor,validateDelivery,digest} from '../src/cloud-wake/contract.mjs';
import {executeSkip} from '../cloud-executor/src/adapter.mjs';

test('projection excludes all full context and credentials; shared Core returns empty SKIP',async()=>{
  const secret='SECRET_SENTINEL_0123456789';
  const s=projectSnapshot({contact:{id:'alice',name:'Alice',prompt:secret,customWorldBook:secret,apiKey:secret,profileEntries:[secret]},runtime:{existenceMode:'phone_native',memory:secret},storeId:'store-1',scopeKey:'global:phone',sourceRevision:1,runAt:Date.now()+50});
  assert.ok(!JSON.stringify(s).includes(secret));assert.ok(JSON.stringify(s).length<1000);
  const id=await wakeIdFor(s,'user-1'),d=await executeSkip(s,id);
  assert.equal(d.result.decision,'SKIP');assert.deepEqual(d.result.events,[]);
  assert.deepEqual(d.result.lifeEvents,[]);assert.equal(d.result.identity.character.id,'alice');
  assert.equal(d.resultHash,await digest(d.result));
  assert.deepEqual(requestFromSnapshot(s,id).identity.bindings,[]);
});
for(const [name,mutate] of [
  ['unknown patch',s=>s.patch={}],['MCP capability',s=>s.capabilities={externalMcp:true}],
  ['credential',s=>s.apiKey='secret'],['story aligned',s=>s.character.existenceMode='story_aligned'],
  ['expiry',s=>s.expiresAt=s.capturedAt-1],['invalid revision',s=>s.sourceRevision=0],
  ['oversize',s=>s.character.name='a'.repeat(10000)],['future capture',s=>{s.capturedAt+=60000;s.runAt+=60000;}],
])test('snapshot rejects '+name,()=>{const s=snapshot();mutate(s);assert.throws(()=>validateSnapshot(s));});
test('delivery rejects wrong identity, changed result, arbitrary canonical patch and forged facts',async()=>{
  const s=snapshot(),id=await wakeIdFor(s,'user-1'),d=await executeSkip(s,id);
  for(const mutate of [x=>x.result.characterId='bob',x=>x.result.patch={},x=>x.result.events.push({type:'WORLD_EVENT'}),x=>x.resultHash='0'.repeat(64),x=>x.result.identity.bindings.push({})]){
    const bad=structuredClone(d);mutate(bad);await assert.rejects(validateDelivery(bad,s,id));
  }
});
test('wakeId is stable for retries and distinct per tenant, Character and occurrence',async()=>{
  const s=snapshot();assert.equal(await wakeIdFor(s,'u'),await wakeIdFor(structuredClone(s),'u'));
  assert.notEqual(await wakeIdFor(s,'u'),await wakeIdFor(s,'v'));
  assert.notEqual(await wakeIdFor(s,'u'),await wakeIdFor({...s,snapshotId:'another'},'u'));
});
