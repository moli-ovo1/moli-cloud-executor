import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IDBObjectStore} from 'fake-indexeddb';
import {browserGlobals,snapshot} from './cloud-helpers.mjs';
import {createWakeResult} from '../src/automation/wake-contract.js';
import {requestFromSnapshot} from '../src/cloud-wake/contract.mjs';
import {executeSkip} from '../cloud-executor/src/adapter.mjs';
browserGlobals();
const {initLargeStorage,flushLargeStorageWrites}=await import('../src/storage/large-storage.js');await initLargeStorage();
const {commitWakeResult,isWakeResultCommitted}=await import('../src/automation/wake-result-commit.js');
const {applyCanonicalWakeEvent}=await import('../src/automation/canonical-wake-event-adapters.js');
const {listWorldEvents}=await import('../src/storage/world-event-store.js');
const {listLifeLogs}=await import('../src/storage/life-log-store.js');
const {scheduleCloudSkip,recoverCloudSkips,listCloudPlans}=await import('../src/cloud-wake/client.js');
const {isCloudSkipOwned}=await import('../src/cloud-wake/executor-ownership.js');
function fixture() {
  const s=snapshot(),id=crypto.randomUUID(),r=requestFromSnapshot(s,id);
  return createWakeResult(r,{events:[{eventId:id+':world',type:'WORLD_EVENT',payload:{actorId:'alice',content:'Test fixture observation',awareness:'known'}}],
    lifeEvents:[{eventId:id+':life',type:'LIFE_EVENT',payload:{actorId:'alice',summary:'Test fixture only'}}]});
}
test('partial canonical commit resumes after first event and creates one copy each',async()=>{
  const r=fixture();let count=0;
  await assert.rejects(commitWakeResult(r,{applyEvent:async(e,r)=>{if(++count===2)throw new Error('crash');return applyCanonicalWakeEvent(e,r);}}),/crash/);
  assert.equal(isWakeResultCommitted(r.scopeKey,r.wakeId),false);
  await commitWakeResult(r,{applyEvent:applyCanonicalWakeEvent});
  assert.equal(listWorldEvents(r.scopeKey).filter(e=>e.id===r.events[0].eventId).length,1);
  assert.equal(listLifeLogs(r.scopeKey,{autonomousOnly:false}).filter(e=>e.id===r.lifeEvents[0].eventId).length,1);
  assert.equal((await commitWakeResult(r,{applyEvent:applyCanonicalWakeEvent})).status,'duplicate');
});
test('IndexedDB failure cannot record successful commit; retry persists cached event',async()=>{
  const r=fixture(),original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(){throw new Error('injected-idb-failure');};
  try {await assert.rejects(commitWakeResult(r,{applyEvent:applyCanonicalWakeEvent}),/persistence-failed/);}
  finally{IDBObjectStore.prototype.put=original;}
  assert.equal(isWakeResultCommitted(r.scopeKey,r.wakeId),false);
  await commitWakeResult(r,{applyEvent:applyCanonicalWakeEvent});await flushLargeStorageWrites();
  const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('moli-phone-storage-v2');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  const raw=await new Promise(resolve=>{const q=db.transaction('kv').objectStore('kv').get('moli-phone:world-events:v1:'+r.scopeKey);q.onsuccess=()=>resolve(q.result);});
  assert.equal(JSON.parse(raw).events.filter(e=>e.id===r.events[0].eventId).length,1);db.close();
});
test('ledger-write failure after event persistence safely replays original canonical adapter',async()=>{
  const r=fixture();localStorage.fail=k=>k.includes('wake-commit-ledger');
  await assert.rejects(commitWakeResult(r,{applyEvent:applyCanonicalWakeEvent}),/ledger-write/);localStorage.fail=null;
  await commitWakeResult(r,{applyEvent:applyCanonicalWakeEvent});
  assert.equal(listWorldEvents(r.scopeKey).filter(e=>e.id===r.events[0].eventId).length,1);
});
test('unknown canonical event is rejected and never recorded committed',async()=>{
  const r=fixture();r.events=[{eventId:r.wakeId+':bad',type:'ARBITRARY_PATCH',payload:{}}];r.lifeEvents=[];
  await assert.rejects(commitWakeResult(r,{applyEvent:applyCanonicalWakeEvent}),/Unsupported/);
  assert.equal(isWakeResultCommitted(r.scopeKey,r.wakeId),false);
});
test('lost upload response and ACK loss recover same snapshot; ten recoveries commit once',async()=>{
  const session={tenantId:'user-recover',storeId:'store-1'},contact={id:'recover-alice',name:'Alice'};
  let uploaded=null,delivery=null,lostSync=true,lostAck=true,commits=0,acks=0;
  const client={sync:async s=>{uploaded=s;const {wakeIdFor}=await import('../src/cloud-wake/contract.mjs');const wakeId=await wakeIdFor(s,session.tenantId);delivery ||= await executeSkip(s,wakeId);if(lostSync){lostSync=false;throw new Error('lost-upload');}return {wakeId};},
    pull:async()=>({status:'result-ready',delivery}),ack:async()=>{acks++;if(lostAck){lostAck=false;throw new Error('lost-ack');}return {status:'acknowledged'};}};
  await assert.rejects(scheduleCloudSkip({client,session,contact,runtime:{existenceMode:'phone_native'},scopeKey:'global:phone',runAt:Date.now()+50}),/lost-upload/);
  assert.ok(uploaded);assert.equal(isCloudSkipOwned('global:phone',contact.id),true);
  const commit=async(...args)=>{commits++;return commitWakeResult(...args);};
  const first=await recoverCloudSkips({client,session,commit});assert.equal(first[0].status,'pending');
  await Promise.all(Array.from({length:10},()=>recoverCloudSkips({client,session,commit})));
  assert.equal(commits,1);assert.equal(acks,2);assert.equal(listCloudPlans(session)[0].phase,'acknowledged');
  assert.equal(isCloudSkipOwned('global:phone',contact.id),false);
});
test('changed local Character and corrupt ownership fail closed',async()=>{
  const session={tenantId:'blocked-user',storeId:'store-1'},contact={id:'blocked',name:'B'};let delivery,acks=0;
  const client={sync:async s=>{const {wakeIdFor}=await import('../src/cloud-wake/contract.mjs');const id=await wakeIdFor(s,session.tenantId);delivery=await executeSkip(s,id);return {wakeId:id};},pull:async()=>({delivery}),ack:async()=>{acks++;}};
  await scheduleCloudSkip({client,session,contact,runtime:{existenceMode:'phone_native'},scopeKey:'global:phone',runAt:Date.now()+50});
  const result=await recoverCloudSkips({client,session,assertCurrent:()=>{throw new Error('canonical-character-changed');}});
  assert.equal(result[0].status,'pending');assert.equal(acks,0);
  localStorage.setItem('moli-phone:cloud-skip-ownership:v1','{bad');assert.equal(isCloudSkipOwned('global:phone','someone'),true);
  localStorage.removeItem('moli-phone:cloud-skip-ownership:v1');
});

test('interrupted handoff never uploads an unconfirmed reservation',async()=>{
  const session={tenantId:'interrupted',storeId:'store-1'};let uploads=0;
  const client={sync:async()=>{uploads++;throw new Error('unexpected-upload');}};
  localStorage.fail=(k,v)=>k.includes('cloud-skip-journal') && v.includes('"phase":"prepared"');
  try { await assert.rejects(scheduleCloudSkip({client,session,contact:{id:'interrupted',name:'A'},runtime:{existenceMode:'phone_native'},scopeKey:'global:phone',runAt:Date.now()+50}),/ledger-write/); }
  finally { localStorage.fail=null; }
  assert.equal(listCloudPlans(session)[0].phase,'checking');
  const outcome=await recoverCloudSkips({client,session});
  assert.equal(outcome[0].status,'handoff-unconfirmed');assert.equal(uploads,0);
  assert.equal(isCloudSkipOwned('global:phone','interrupted'),true);
});

test('Cloud handoff waits for the local scheduler and old receipt cannot clear new ownership',async()=>{
  const {withLocalWakeSchedulerLock,setCloudSkipOwner,releaseCloudSkipOwner}=await import('../src/cloud-wake/executor-ownership.js');
  let release,entered=false;
  const running=withLocalWakeSchedulerLock(()=>new Promise(resolve=>{release=resolve;}));
  await new Promise(r=>setTimeout(r,0));
  const next=withLocalWakeSchedulerLock(()=>{entered=true;});
  await new Promise(r=>setTimeout(r,0));assert.equal(entered,false);
  release();await Promise.all([running,next]);assert.equal(entered,true);
  setCloudSkipOwner('scope','char','new-plan');releaseCloudSkipOwner('scope','char','old-plan');
  assert.equal(isCloudSkipOwned('scope','char'),true);
  releaseCloudSkipOwner('scope','char','new-plan');assert.equal(isCloudSkipOwned('scope','char'),false);
});
