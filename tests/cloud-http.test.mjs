import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTestHost} from './cloud-host.mjs';
import {snapshot} from './cloud-helpers.mjs';
import {digest} from '../src/cloud-wake/contract.mjs';
test('Worker HTTP validates tenant, origin, credential rotation and strict transport schema',async()=>{
  const a={id:'a',tenantId:'a',storeId:'store-1',origin:'https://moli.test',epoch:1,active:true,tokenHash:await digest('fixture-token-one')};
  const b={...a,id:'b',tenantId:'b',storeId:'store-2',tokenHash:await digest('fixture-token-two')};
  const host=createTestHost([a,b]);
  const call=async(route,body,token='fixture-token-one',origin='https://moli.test')=>{
    const r=await host.fetch(new Request('https://cloud.test/v1/'+route,{method:body?'POST':'GET',headers:{Origin:origin,Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}));return {status:r.status,value:await r.json()};
  };
  try {
    const s=snapshot();assert.equal((await call('snapshot',s)).status,200);
    assert.equal((await call('snapshot',s,'fixture-token-two')).value.error,'store-denied');
    assert.equal((await call('result?scopeKey=global%3Aphone&characterId=alice',null,'fixture-token-two')).value.status,'idle');
    assert.equal((await call('snapshot',s,'bad')).status,403);
    assert.equal((await call('snapshot',s,'fixture-token-one','https://evil.test')).status,403);
    assert.equal((await call('snapshot',{...s,headers:{Authorization:'SECRET'}})).status,400);
    assert.equal((await call('result?scopeKey=global%3Aphone&characterId=alice&tenantId=b')).status,400);
    host.env.CLIENTS_JSON=JSON.stringify([{...a,epoch:2,tokenHash:await digest('fixture-token-rotated')},b]);
    assert.equal((await call('session')).status,403);
    assert.equal((await call('session',null,'fixture-token-rotated')).status,200);
  }finally{host.stop();}
});
