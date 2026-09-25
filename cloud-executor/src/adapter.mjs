import { runCharacterWake } from '../../src/automation/headless-character-wake-core.mjs';
import { CORE_VERSION, digest, requestFromSnapshot, validateDelivery } from '../../src/cloud-wake/contract.mjs';

export async function executeSkip(snapshot, wakeId) {
  const forbidden = () => { throw new Error('mvp-capability-forbidden'); };
  const result = await runCharacterWake(requestFromSnapshot(snapshot, wakeId), {
    venueOverviews: () => [], pendingItems: () => [],
    chooseVenue: forbidden, loadVenueContext: forbidden, actInVenue: forbidden,
  });
  const delivery = { schemaVersion:1, coreVersion:CORE_VERSION, storeId:snapshot.storeId,
    snapshotId:snapshot.snapshotId, result, resultHash:await digest(result) };
  return validateDelivery(delivery, snapshot, wakeId);
}
