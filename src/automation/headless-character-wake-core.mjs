import { availableVenues, routerContext, parseVenueChoice, routerMessages } from './wake-router-contract.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const list = value => Array.isArray(value) ? value : [];

/** Shared decision/venue/observation boundary. Schedulers and storage stay in runtime adapters. */
export async function runCharacterWake(request, ports) {
  if (request?.contractVersion !== 2 || !request?.wakeId || !request?.scopeKey || !request?.characterId
      || request.identity?.character?.id !== request.characterId || request.identity?.authorizationId !== request.wakeId) {
    throw new Error('wake-request-identity-invalid');
  }
  if (typeof ports?.chooseVenue !== 'function' || typeof ports?.loadVenueContext !== 'function'
      || typeof ports?.actInVenue !== 'function') throw new Error('wake-core-ports-required');
  const startedAt = Date.now();
  const venues = availableVenues(request, await ports.venueOverviews(request));
  const context = routerContext(request, venues, { pending: await ports.pendingItems?.(request) || [] });
  const choice = venues.length ? parseVenueChoice(await ports.chooseVenue(context, routerMessages(context)), venues) : 'SKIP';
  const action = choice === 'SKIP' ? { decision: 'SKIP' } : await ports.actInVenue({
    request, venue: choice, context: await ports.loadVenueContext(request, choice),
  });
  const observation = action && typeof action === 'object' ? action : {};
  return {
    contractVersion: 2, identity: clone(request.identity), wakeId: request.wakeId,
    scopeKey: request.scopeKey, characterId: request.characterId, baseRevision: Number(request.baseRevision) || 0,
    status: 'completed', decision: String(observation.decision || 'SKIP'), startedAt,
    completedAt: Date.now(), events: clone(list(observation.events)),
    continuityCandidates: clone(list(observation.continuityCandidates)), lifeEvents: clone(list(observation.lifeEvents)),
    metadata: { executor: 'shared-headless-character-wake', venue: choice },
  };
}
