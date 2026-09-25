import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { projectSnapshot } from '../src/cloud-wake/contract.mjs';
export function snapshot(characterId='alice', patch={}) {
  return {...projectSnapshot({contact:{id:characterId,name:characterId},runtime:{existenceMode:'phone_native'},storeId:'store-1',scopeKey:'global:phone',sourceRevision:1,now:Date.now()-100,runAt:Date.now()+50}),...patch};
}
export class LocalStorage {
  values=new Map(); fail=null;
  get length(){return this.values.size;} key(i){return [...this.values.keys()][i] || null;}
  getItem(k){return this.values.get(k) ?? null;}
  setItem(k,v){if(this.fail?.(k,v))throw new Error('ledger-write-failed');this.values.set(k,String(v));}
  removeItem(k){this.values.delete(k);} clear(){this.values.clear();}
}
export function browserGlobals() {
  globalThis.localStorage=new LocalStorage();globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
  const queues=new Map();
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(k,fn)=>{
    const before=queues.get(k)||Promise.resolve();let release;const next=new Promise(r=>release=r);queues.set(k,next);
    await before;try{return await fn();}finally{release();}
  }},storage:{persist:async()=>true}}});
  globalThis.window={dispatchEvent(){},SillyTavern:{getContext:()=>({})}};
}

export class MemoryStorage {
  map=new Map(); alarmAt=null; fail=null;
  async get(k){return structuredClone(this.map.get(k));}
  async put(k,v){if(this.fail?.(k,v))throw new Error('injected-storage');this.map.set(k,structuredClone(v));}
  async setAlarm(at){this.alarmAt=at;}async deleteAlarm(){this.alarmAt=null;}
  async transaction(fn){const copy=new Map(this.map),alarm=this.alarmAt;try{return await fn(this);}catch(e){this.map=copy;this.alarmAt=alarm;throw e;}}
}
export function context(storage=new MemoryStorage()){let last=Promise.resolve();return {storage,blockConcurrencyWhile(fn){const p=last.then(fn);last=p.catch(()=>{});return p;}};}
