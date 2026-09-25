import { check, projectSnapshot, wakeIdFor, validateDelivery, canonical } from './contract.mjs';
import { setCloudSkipOwner, releaseCloudSkipOwner, withLocalWakeSchedulerLock } from './executor-ownership.js';
import { rememberWakeAuthorization, assertWakeAuthorization } from '../companion/wake-authorization.js';
import { commitWakeResult } from '../automation/wake-result-commit.js';
import { applyCanonicalWakeEvent } from '../automation/canonical-wake-event-adapters.js';

export function createCloudClient({baseUrl, credential, fetchImpl=fetch}) {
  const url=new URL(baseUrl);
  check(url.protocol==='https:' || (url.protocol==='http:' && ['127.0.0.1','localhost'].includes(url.hostname)), 'https-required');
  check(!url.username && !url.password && !url.search && !url.hash && url.pathname==='/', 'invalid-cloud-url');
  async function call(path,body) {
    const token=await credential();check(typeof token==='string' && token.length>=16,'cloud-login-required');
    const response=await fetchImpl(url.origin+path,{method:body===undefined?'GET':'POST',cache:'no-store',
      headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
    const value=await response.json();
    if(!response.ok) throw new Error(/^[a-z-]+$/.test(value.error)?value.error:'cloud-request-failed');
    return value;
  }
  return { session:()=>call('/v1/session'),sync:s=>call('/v1/snapshot',s),
    pull:(scopeKey,characterId)=>call('/v1/result?'+new URLSearchParams({scopeKey,characterId})),
    ack:body=>call('/v1/ack',body) };
}

const journalKey=session=>'moli-phone:cloud-skip-journal:v1:'+JSON.stringify([session.tenantId,session.storeId]);
function readJournal(session) {
  const raw=localStorage.getItem(journalKey(session)); if(!raw)return {entries:[]};
  const value=JSON.parse(raw);check(value && Array.isArray(value.entries) && value.entries.length<=100,'cloud-journal-corrupt');return value;
}
function save(session,journal) { localStorage.setItem(journalKey(session),JSON.stringify(journal)); }
async function locked(session,fn) {
  check(globalThis.navigator?.locks?.request,'web-locks-required');
  return navigator.locks.request(journalKey(session),fn);
}
export function listCloudPlans(session) { return structuredClone(readJournal(session).entries); }

export async function scheduleCloudSkip({client,session,contact,runtime,scopeKey,runAt,assertEligible=()=>{}}) {
  return locked(session,()=>withLocalWakeSchedulerLock(async()=>{
    const journal=readJournal(session);check(journal.entries.length<100,'receipt-capacity');
    check(!journal.entries.some(e=>e.snapshot.scopeKey===scopeKey && e.snapshot.character.id===contact.id && e.phase!=='acknowledged'),'cloud-character-busy');
    const revision=1+Math.max(0,...journal.entries.filter(e=>e.snapshot.scopeKey===scopeKey && e.snapshot.character.id===contact.id).map(e=>e.snapshot.sourceRevision));
    const snapshot=projectSnapshot({contact,runtime,scopeKey,storeId:session.storeId,sourceRevision:revision,runAt});
    const entry={snapshot,wakeId:await wakeIdFor(snapshot,session.tenantId),phase:'checking',delivery:null};
    // Journal first: a lost HTTP response never loses the plan identity.
    journal.entries.push(entry);save(session,journal);
    setCloudSkipOwner(scopeKey,contact.id,snapshot.snapshotId);
    try { await assertEligible(); } catch(error) {
      journal.entries.pop();save(session,journal);releaseCloudSkipOwner(scopeKey,contact.id,snapshot.snapshotId);throw error;
    }
    entry.phase='prepared';save(session,journal);
    const response=await client.sync(snapshot);check(response.wakeId===entry.wakeId,'wake-id-mismatch');
    entry.phase='scheduled';save(session,journal);return structuredClone(entry);
  }));
}

export async function recoverCloudSkips({client,session,assertCurrent=()=>{},commit=commitWakeResult}) {
  return locked(session,async()=>{
    const journal=readJournal(session);const outcomes=[];
    for(const entry of journal.entries) {
      const s=entry.snapshot;
      if(entry.phase==='acknowledged') {releaseCloudSkipOwner(s.scopeKey,s.character.id,s.snapshotId);continue;}
      setCloudSkipOwner(s.scopeKey,s.character.id,s.snapshotId);
      try {
        if(entry.phase==='checking'){outcomes.push({wakeId:entry.wakeId,status:'handoff-unconfirmed'});continue;}
        // Repeat the original upload if its response was lost. Never create another wakeId.
        if(entry.phase==='prepared' && Date.now()<s.expiresAt) {
          const accepted=await client.sync(s);check(accepted.wakeId===entry.wakeId,'wake-id-mismatch');
          entry.phase='scheduled';save(session,journal);
        }
        const remote=await client.pull(s.scopeKey,s.character.id);
        if(!entry.delivery && !remote.delivery) {outcomes.push({wakeId:entry.wakeId,status:remote.status});continue;}
        if(remote.delivery && entry.delivery) check(canonical(remote.delivery)===canonical(entry.delivery),'delivery-conflict');
        const delivery=entry.delivery || remote.delivery;
        await validateDelivery(delivery,s,entry.wakeId);
        if(!entry.delivery){entry.delivery=delivery;entry.phase='received';save(session,journal);}
        // Canonical identity must still exist; revision is this projection's sequence, not a world-wide revision.
        await assertCurrent(s);
        if(entry.phase!=='committed') {
          const {requestFromSnapshot}=await import('./contract.mjs');
          rememberWakeAuthorization(requestFromSnapshot(s,entry.wakeId));
          assertWakeAuthorization(delivery.result);
          await commit(delivery.result,{applyEvent:applyCanonicalWakeEvent});
          entry.phase='committed';save(session,journal);
        }
        await client.ack({scopeKey:s.scopeKey,characterId:s.character.id,wakeId:entry.wakeId,resultHash:delivery.resultHash});
        entry.phase='acknowledged';save(session,journal);
        releaseCloudSkipOwner(s.scopeKey,s.character.id,s.snapshotId);
        outcomes.push({wakeId:entry.wakeId,status:'acknowledged'});
      } catch(error) {
        outcomes.push({wakeId:entry.wakeId,status:'pending',error:/^[a-z-]+$/.test(error.message)?error.message:'recovery-failed'});
      }
    }
    return outcomes;
  });
}
