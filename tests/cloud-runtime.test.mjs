import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {mkdtemp,readFile} from 'node:fs/promises';
import {snapshot,browserGlobals} from './cloud-helpers.mjs';
import {digest,canonical} from '../src/cloud-wake/contract.mjs';
test('real workerd Alarm executes without a client and durable pending survives process restart',async()=>{
  const storage=await mkdtemp('workerd-test-');
  const token='local-fixture-token-not-a-real-secret';
  const clients=[{id:'test',tenantId:'user-1',storeId:'store-1',origin:'https://moli.test',tokenHash:await digest(token),epoch:1,active:true},
    {id:'other',tenantId:'user-2',storeId:'store-2',origin:'https://moli.test',tokenHash:await digest(token+'other'),epoch:1,active:true}];
  const options={modules:true,script:await readFile('dist/worker.mjs','utf8'),compatibilityDate:'2026-07-30',cf:false,
    durableObjects:{CHARACTERS:{className:'CharacterExecution',useSQLite:true}},durableObjectsPersist:storage,bindings:{CLIENTS_JSON:JSON.stringify(clients)}};
  let mf=new Miniflare(options);
  const call=async(path,body,whichToken=token)=>{
    const r=await mf.dispatchFetch('https://cloud.test/v1/'+path,{method:body?'POST':'GET',headers:{Origin:'https://moli.test',Authorization:'Bearer '+whichToken,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {httpStatus:r.status,...await r.json()};
  };
  try {
    const s=snapshot('runtime-alice',{runAt:Date.now()+800});const accepted=await call('snapshot',s);assert.equal(accepted.httpStatus,200);
    assert.equal((await call('snapshot',s,token+'other')).httpStatus,400);
    assert.equal((await call('result?scopeKey=global%3Aphone&characterId=runtime-alice',undefined,token+'other')).status,'idle');
    assert.equal((await call('result?scopeKey=global%3Aphone&characterId=runtime-alice',undefined,'bad')).httpStatus,403);
    // No foreground polling until after the scheduled time.
    await new Promise(r=>setTimeout(r,1800));
    const first=await call('result?scopeKey=global%3Aphone&characterId=runtime-alice');assert.equal(first.status,'result-ready');
    assert.equal(first.delivery.result.wakeId,accepted.wakeId);
    await mf.dispose();mf=new Miniflare(options);
    const replay=await call('result?scopeKey=global%3Aphone&characterId=runtime-alice');assert.deepEqual(replay.delivery,first.delivery);
    assert.deepEqual(await call('snapshot',s),{httpStatus:200,wakeId:accepted.wakeId,status:'result-ready'});
    // Force a second real Alarm on the same Durable Object; it must not rerun the Core or replace the result.
    const ns=await mf.getDurableObjectNamespace('CHARACTERS');
    const id=ns.idFromName(canonical(['user-1','store-1',s.scopeKey,s.character.id]));
    const durable=await mf.getDurableObjectStorage(id);
    await durable.setAlarm(Date.now()+100);
    const alarmDeadline=Date.now()+5000;
    while(await durable.getAlarm()!==null && Date.now()<alarmDeadline)await new Promise(r=>setTimeout(r,100));
    assert.equal(await durable.getAlarm(),null,'Duplicate real Alarm must be dispatched');
    assert.deepEqual((await call('result?scopeKey=global%3Aphone&characterId=runtime-alice')).delivery,first.delivery);
    // Reopen a Web-side journal against this real workerd instance and ACK only after original commit.
    browserGlobals();
    const {initLargeStorage}=await import('../src/storage/large-storage.js');await initLargeStorage();
    const {createCloudClient,scheduleCloudSkip,recoverCloudSkips,listCloudPlans}=await import('../src/cloud-wake/client.js');
    const {commitWakeResult,isWakeResultCommitted}=await import('../src/automation/wake-result-commit.js');
    const browserClient=createCloudClient({baseUrl:'https://cloud.test/',credential:()=>token,
      fetchImpl:(url,opts)=>mf.dispatchFetch(url,{...opts,headers:{...opts.headers,Origin:'https://moli.test'}})});
    const session=await browserClient.session();
    const plan=await scheduleCloudSkip({client:browserClient,session,contact:{id:'runtime-web',name:'Web'},
      runtime:{existenceMode:'phone_native'},scopeKey:'global:phone',runAt:Date.now()+700});
    // No Web calls until after the real Alarm executes.
    await new Promise(r=>setTimeout(r,1500));
    const pending=await call('result?scopeKey=global%3Aphone&characterId=runtime-web');
    assert.equal(pending.status,'result-ready');assert.equal(pending.delivery.result.wakeId,plan.wakeId);
    let commits=0;const commit=async(...args)=>{commits++;return commitWakeResult(...args);};
    const recovered=await recoverCloudSkips({client:browserClient,session,commit});
    assert.equal(recovered[0].status,'acknowledged');assert.equal(commits,1);
    assert.equal(isWakeResultCommitted('global:phone',plan.wakeId),true);
    assert.equal(listCloudPlans(session)[0].phase,'acknowledged');
    assert.equal((await call('result?scopeKey=global%3Aphone&characterId=runtime-web')).status,'idle');
    for(let i=0;i<10;i++)await recoverCloudSkips({client:browserClient,session,commit});
    assert.equal(commits,1,'Repeated Web recovery must not re-commit');
    for(let i=0;i<10;i++)assert.equal((await call('ack',{scopeKey:s.scopeKey,characterId:s.character.id,wakeId:accepted.wakeId,resultHash:first.delivery.resultHash})).status,'acknowledged');
    assert.equal((await call('result?scopeKey=global%3Aphone&characterId=runtime-alice')).status,'idle');
  }finally{await mf.dispose();}
});
