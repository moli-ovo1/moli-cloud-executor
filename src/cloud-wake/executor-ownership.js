const KEY='moli-phone:cloud-skip-ownership:v1';
function read() { const raw=localStorage.getItem(KEY); if(!raw) return {}; const v=JSON.parse(raw); if(!v || Array.isArray(v) || typeof v!=='object') throw new Error('cloud-ownership-corrupt');return v; }
const key=(scope,character)=>JSON.stringify([scope,character]);
export function isCloudSkipOwned(scope,character) {
  try { return Boolean(read()[key(scope,character)]); } catch { return true; }
}
export function setCloudSkipOwner(scope,character,snapshotId) {
  const state=read();const k=key(scope,character);
  if(snapshotId && state[k] && state[k]!==snapshotId) throw new Error('cloud-character-busy');
  if(snapshotId) state[k]=snapshotId;else delete state[k];
  localStorage.setItem(KEY,JSON.stringify(state));
}
export function releaseCloudSkipOwner(scope,character,snapshotId) {
  const state=read(),k=key(scope,character);
  if(state[k]===snapshotId){delete state[k];localStorage.setItem(KEY,JSON.stringify(state));}
}
export function withLocalWakeSchedulerLock(fn) {
  return globalThis.navigator?.locks?.request ? navigator.locks.request('moli-executor-handoff',fn) : fn();
}
