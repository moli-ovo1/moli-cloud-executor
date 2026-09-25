import { createWakeRequest, createWakeResult } from '../automation/wake-contract.js';

export const CLOUD_SCHEMA = 1;
export const MAX_BYTES = 4096;
export const CORE_VERSION = 'sha256:ff1e483c90408d5e35524724312e5d9a29eb20e8d31a8ccda5cacd3573c4a04e';
export function check(ok, code) { if (!ok) throw new Error(code); }
export function exact(value, keys) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'invalid-object');
  check(Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), 'unexpected-fields');
}
export function identifier(v) { check(typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\x00-\x1f]/.test(v), 'invalid-id'); }
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export async function digest(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : canonical(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}

// This MVP needs no free-form prompt, memory, persona, venue, model config or credential.
export function validateSnapshot(s, { now = Date.now(), fresh = true } = {}) {
  exact(s, ['schemaVersion','storeId','scopeKey','character','sourceRevision','snapshotId','capturedAt','expiresAt','runAt']);
  check(s.schemaVersion === CLOUD_SCHEMA, 'schema-mismatch');
  for (const k of ['storeId','scopeKey','snapshotId']) identifier(s[k]);
  exact(s.character, ['id','name','existenceMode']); identifier(s.character.id);
  check(typeof s.character.name === 'string' && s.character.name.length <= 100, 'invalid-name');
  check(s.character.existenceMode === 'phone_native', 'story-aligned-not-supported');
  check(Number.isSafeInteger(s.sourceRevision) && s.sourceRevision > 0, 'invalid-revision');
  for (const k of ['capturedAt','expiresAt','runAt']) check(Number.isSafeInteger(s[k]) && s[k] > 0, 'invalid-time');
  check(s.runAt >= s.capturedAt && s.runAt < s.expiresAt && s.expiresAt - s.capturedAt <= 86400000, 'invalid-schedule');
  check(new TextEncoder().encode(JSON.stringify(s)).length <= MAX_BYTES, 'snapshot-too-large');
  if (fresh) check(s.capturedAt <= now + 30000 && s.expiresAt > now, 'snapshot-expired');
  return s;
}

export function projectSnapshot({ contact, runtime, storeId, scopeKey, sourceRevision, snapshotId = crypto.randomUUID(), runAt, now = Date.now() }) {
  check(contact && runtime && runtime.existenceMode === 'phone_native', 'story-aligned-not-supported');
  return validateSnapshot({ schemaVersion:1, storeId, scopeKey,
    character:{ id:contact.id, name:String(contact.name || contact.id).slice(0,100), existenceMode:'phone_native' },
    sourceRevision, snapshotId, capturedAt:now, expiresAt:now + 86400000, runAt });
}

export function requestFromSnapshot(s, wakeId) {
  validateSnapshot(s, { fresh:false });
  return createWakeRequest({ wakeId, scopeKey:s.scopeKey, characterId:s.character.id,
    actorName:s.character.name, baseRevision:s.sourceRevision, requestedAt:s.capturedAt,
    characterSnapshot:{ actor:{ id:s.character.id, name:s.character.name } },
    continuitySnapshot:{ characterRuntime:{ existenceMode:'phone_native' } },
    schedule:{ communityWakeEnabled:false, externalWakeEnabled:false },
    capabilities:{ communityDiscovery:false, externalMcp:false } });
}

export async function wakeIdFor(s, tenantId) {
  return 'cloud-skip:' + await digest([tenantId,s.storeId,s.scopeKey,s.character.id,s.snapshotId,s.sourceRevision]);
}

export async function validateDelivery(d, snapshot, wakeId) {
  exact(d, ['schemaVersion','coreVersion','snapshotId','storeId','result','resultHash']);
  check(d.schemaVersion === 1 && d.coreVersion === CORE_VERSION && d.snapshotId === snapshot.snapshotId && d.storeId === snapshot.storeId, 'delivery-mismatch');
  const request = requestFromSnapshot(snapshot, wakeId);
  const r = d.result;
  exact(r, ['contractVersion','identity','wakeId','scopeKey','characterId','baseRevision','status','decision','startedAt','completedAt','events','continuityCandidates','lifeEvents','metadata']);
  check(r.wakeId === wakeId && r.scopeKey === request.scopeKey && r.characterId === request.characterId && r.baseRevision === snapshot.sourceRevision, 'result-identity-mismatch');
  check(canonical(r.identity) === canonical(request.identity), 'result-identity-mismatch');
  check(r.status === 'completed' && r.decision === 'SKIP', 'non-skip-result');
  for (const k of ['events','continuityCandidates','lifeEvents']) check(Array.isArray(r[k]) && !r[k].length, 'unexpected-events');
  check(canonical(r.metadata) === canonical({executor:'shared-headless-character-wake',venue:'SKIP'}), 'unexpected-metadata');
  check(Number.isSafeInteger(r.startedAt) && r.startedAt >= snapshot.capturedAt && Number.isSafeInteger(r.completedAt) && r.completedAt >= r.startedAt, 'invalid-result-time');
  createWakeResult(request, r); // Shared v2 identity/secret validation; preserve the actual shared-Core output.
  check(d.resultHash === await digest(r), 'result-hash-mismatch');
  return d;
}
