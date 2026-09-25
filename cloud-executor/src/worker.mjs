import { check, exact, identifier, digest, canonical, validateSnapshot, wakeIdFor, MAX_BYTES } from '../../src/cloud-wake/contract.mjs';
import { executeSkip } from './adapter.mjs';

const json = (body, status = 200) => Response.json(body, {status, headers:{'Cache-Control':'no-store'}});
function clients(env) {
  const rows = JSON.parse(env.CLIENTS_JSON || '[]');
  check(Array.isArray(rows), 'auth-config');
  for (const r of rows) {
    for (const k of ['id','tenantId','storeId','origin']) identifier(r[k]);
    check(/^[a-f0-9]{64}$/.test(r.tokenHash) && Number.isSafeInteger(r.epoch) && r.epoch > 0, 'auth-config');
  }
  check(new Set(rows.map(r=>r.id)).size === rows.length, 'auth-config');
  return rows;
}
async function readBody(request) {
  check(request.headers.get('content-type')?.startsWith('application/json'), 'content-type');
  const reader = request.body?.getReader(); check(reader, 'body-required');
  let bytes = 0; const chunks=[];
  while(true) { const {done,value}=await reader.read(); if(done) break; bytes+=value.length;
    if(bytes>MAX_BYTES){await reader.cancel();throw new Error('body-too-large');} chunks.push(value); }
  const all = new Uint8Array(bytes); let offset=0; for(const c of chunks){all.set(c,offset);offset+=c.length;}
  return JSON.parse(new TextDecoder().decode(all));
}
function scopeBody(body) { identifier(body.scopeKey); identifier(body.characterId); }

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin'); let allowed = false;
    try {
      const registry = clients(env);
      allowed = registry.some(c=>c.active === true && c.origin === origin);
      check(allowed, 'origin-denied');
      if(request.method === 'OPTIONS') return new Response(null,{status:204,headers:{
        'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers':'Authorization,Content-Type','Vary':'Origin'}});
      const header = request.headers.get('Authorization') || '';
      check(header.startsWith('Bearer ') && header.length <= 1024, 'unauthorized');
      const tokenHash = await digest(header.slice(7));
      const actor = registry.find(c=>c.active === true && c.tokenHash === tokenHash && c.origin === origin);
      check(actor, 'unauthorized');
      const url = new URL(request.url); const op = url.pathname;
      if(op === '/v1/session' && request.method === 'GET') return new Response(JSON.stringify({id:actor.id,tenantId:actor.tenantId,storeId:actor.storeId,epoch:actor.epoch}),{
        headers:{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':origin,'Vary':'Origin'}});
      let body;
      if(op === '/v1/snapshot' && request.method === 'POST') {
        body = await readBody(request); validateSnapshot(body);
        check(body.storeId === actor.storeId, 'store-denied');
      } else if(op === '/v1/result' && request.method === 'GET') {
        check([...url.searchParams.keys()].length === 2, 'unexpected-query');
        body = Object.fromEntries(url.searchParams); exact(body,['scopeKey','characterId']); scopeBody(body);
      } else if(op === '/v1/ack' && request.method === 'POST') {
        body=await readBody(request); exact(body,['scopeKey','characterId','wakeId','resultHash']); scopeBody(body);
        identifier(body.wakeId); check(/^[a-f0-9]{64}$/.test(body.resultHash),'invalid-hash');
      } else throw new Error('route-not-found');
      const charId = body.character?.id || body.characterId;
      const name = canonical([actor.tenantId,actor.storeId,body.scopeKey,charId]);
      const stub = env.CHARACTERS.get(env.CHARACTERS.idFromName(name));
      const response = await stub.fetch('https://internal'+op,{method:'POST',body:JSON.stringify({actor:{id:actor.id,tenantId:actor.tenantId,storeId:actor.storeId,epoch:actor.epoch},body})});
      const headers = new Headers(response.headers); headers.set('Access-Control-Allow-Origin',origin); headers.set('Vary','Origin');
      return new Response(response.body,{status:response.status,headers});
    } catch(error) {
      const code = /^[a-z-]+$/.test(error.message) ? error.message : 'invalid-request';
      return new Response(JSON.stringify({error:code}), {status:['unauthorized','origin-denied'].includes(code)?403:400,
        headers:{'Content-Type':'application/json','Cache-Control':'no-store',...(allowed?{'Access-Control-Allow-Origin':origin,'Vary':'Origin'}:{})}});
    }
  }
};

export class CharacterExecution {
  constructor(ctx, env) { this.ctx=ctx; this.env=env; }
  fetch(request) { return this.ctx.blockConcurrencyWhile(async () => {
    try {
      const {actor,body} = await request.json(); const op=new URL(request.url).pathname;
      const slot=await this.ctx.storage.get('slot') || {revision:0, jobs:[], active:null};
      if(op === '/v1/snapshot') {
        validateSnapshot(body);
        const hash=await digest(body);
        const existing=slot.jobs.find(j=>j.snapshot.snapshotId===body.snapshotId);
        if(existing){check(existing.snapshotHash===hash,'snapshot-conflict');return json({wakeId:existing.wakeId,status:existing.status});}
        check(body.sourceRevision>slot.revision,'stale-revision');
        check(!slot.active,'pending-result'); check(slot.jobs.length<100,'receipt-capacity');
        const job={snapshot:body,snapshotHash:hash,wakeId:await wakeIdFor(body,actor.tenantId),actor,
          status:'scheduled',attempts:0,delivery:null};
        slot.jobs.push(job);slot.active=job.wakeId;slot.revision=body.sourceRevision;
        await this.ctx.storage.transaction(async tx=>{await tx.put('slot',slot);await tx.setAlarm(Math.max(Date.now()+1,body.runAt));});
        return json({wakeId:job.wakeId,status:job.status});
      }
      if(op === '/v1/result') {
        const job=slot.jobs.find(j=>j.wakeId===slot.active);
        return json({status:job?.status || 'idle',delivery:job?.delivery || null});
      }
      if(op === '/v1/ack') {
        const job=slot.jobs.find(j=>j.wakeId===body.wakeId);
        check(job && job.delivery?.resultHash===body.resultHash,'ack-mismatch');
        check(['result-ready','acknowledged'].includes(job.status),'ack-not-ready');
        job.status='acknowledged'; if(slot.active===job.wakeId) slot.active=null;
        await this.ctx.storage.put('slot',slot);
        return json({status:'acknowledged',wakeId:job.wakeId});
      }
      throw new Error('route-not-found');
    } catch(error){return json({error:/^[a-z-]+$/.test(error.message)?error.message:'invalid-request'},409);}
  }); }
  alarm() { return this.ctx.blockConcurrencyWhile(async () => {
    const slot=await this.ctx.storage.get('slot');
    const job=slot?.jobs.find(j=>j.wakeId===slot.active);
    if(!job || !['scheduled','running','retryable-failed'].includes(job.status)) return;
    if(Date.now()<job.snapshot.runAt){await this.ctx.storage.setAlarm(job.snapshot.runAt);return;}
    const current=clients(this.env).find(c=>c.id===job.actor.id);
    if(!current || !current.active || current.epoch!==job.actor.epoch || current.tenantId!==job.actor.tenantId || current.storeId!==job.actor.storeId) {
      job.status='cancelled';await this.ctx.storage.put('slot',slot);return;
    }
    if(Date.now()>=job.snapshot.expiresAt){job.status='blocked-expired';await this.ctx.storage.put('slot',slot);return;}
    if(job.attempts>=3){job.status='terminal-failed';await this.ctx.storage.put('slot',slot);return;}
    job.status='running';job.attempts++;job.startedAt=Date.now();
    // Durable watchdog survives process death; repeating this no-effect Core is safe.
    await this.ctx.storage.transaction(async tx=>{await tx.put('slot',slot);await tx.setAlarm(Date.now()+30000);});
    try {
      job.delivery=await executeSkip(job.snapshot,job.wakeId);job.status='result-ready';
      await this.ctx.storage.transaction(async tx=>{await tx.put('slot',slot);await tx.deleteAlarm();});
    } catch {
      job.status=job.attempts>=3?'terminal-failed':'retryable-failed';job.delivery=null;
      await this.ctx.storage.transaction(async tx=>{await tx.put('slot',slot);
        if(job.status==='terminal-failed') await tx.deleteAlarm();else await tx.setAlarm(Date.now()+1000*2**job.attempts);});
    }
  }); }
}
