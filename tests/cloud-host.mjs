import worker,{CharacterExecution} from '../cloud-executor/src/worker.mjs';
import {context,MemoryStorage} from './cloud-helpers.mjs';
import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

// TEST ONLY: Node host for HTTP/browser contract tests, not a replacement Worker runtime.
export function createTestHost(registry,{directory}={}) {
  const objects=new Map();const env={CLIENTS_JSON:JSON.stringify(registry)};
  env.CHARACTERS={idFromName:name=>name,get:name=>{
    if(!objects.has(name)){
      const store=new MemoryStorage();
      const filename=directory && path.join(directory,createHash('sha256').update(name).digest('hex')+'.json');
      if(filename && existsSync(filename))store.map=new Map(JSON.parse(readFileSync(filename,'utf8')));
      const put=store.put.bind(store);store.put=async(k,v)=>{await put(k,v);if(filename){mkdirSync(directory,{recursive:true});writeFileSync(filename+'.tmp',JSON.stringify([...store.map]));renameSync(filename+'.tmp',filename);}};
      objects.set(name,{store,object:new CharacterExecution(context(store),env)});
    }
    return {fetch:(url,init)=>objects.get(name).object.fetch(new Request(url,init))};
  }};
  let active=true;
  const pump=async()=>{if(!active)return;for(const row of objects.values())if(row.store.alarmAt && row.store.alarmAt<=Date.now()){row.store.alarmAt=null;await row.object.alarm();}};
  const timer=setInterval(()=>void pump(),20);timer.unref();
  return {env,objects,fetch:req=>worker.fetch(req,env),stop(){active=false;clearInterval(timer);}};
}
