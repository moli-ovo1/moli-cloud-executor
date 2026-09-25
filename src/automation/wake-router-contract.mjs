const clip = (value, limit) => String(value ?? '').trim().slice(0, limit);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function availableVenues(request, overviews = []) {
  const enabled = new Set();
  if (request?.schedule?.communityWakeEnabled === true && request?.capabilities?.communityDiscovery === true) enabled.add('COMMUNITY');
  if (request?.schedule?.externalWakeEnabled === true && request?.capabilities?.externalMcp === true) enabled.add('MCP');
  return (Array.isArray(overviews) ? overviews : []).filter(item => enabled.has(item?.id))
    .map(item => ({ id: item.id, name: clip(item.name, 80), overview: clip(item.overview, 500),
      availableActions: (Array.isArray(item.availableActions) ? item.availableActions : []).slice(0, 8).map(x => clip(x, 100)) }));
}

/** Only this projection may enter the first model decision. Venue details stay behind loadVenueContext. */
export function routerContext(request, venues, { pending = [] } = {}) {
  const actor = object(request?.characterSnapshot?.actor);
  const runtime = object(request?.continuitySnapshot?.characterRuntime);
  return {
    character: { id: clip(request?.characterId, 200), name: clip(actor.name || request?.actorName, 100),
      identity: clip(actor.intro || actor.remark, 500), personality: clip(actor.roleFidelity?.personality, 600) },
    runtime: { existenceMode: clip(runtime.existenceMode, 80), storyTime: clip(runtime.storyTime, 160),
      lastAttentionReason: clip(runtime.lastAttentionReason, 160) },
    venues,
    pending: (Array.isArray(pending) ? pending : []).slice(0, 6).map(x => clip(x, 200)),
  };
}

export function parseVenueChoice(choice, venues) {
  const selected = clip(choice?.venue || choice?.action || choice, 100).toUpperCase();
  if (selected === 'SKIP') return 'SKIP';
  if (!venues.some(item => item.id === selected)) throw new Error('wake-venue-not-available');
  return selected;
}

export function routerMessages(context) {
  return {
    system: '你是给定 Character 本人的自主生活决策。只根据所给身份、当前处境和简短场所概览决定去哪里；可以连续去同一处，也始终可以休息。不要按访问次数轮换，不要为了测试选择任何场所。只输出 JSON：{"venue":"场所ID或SKIP"}。',
    user: JSON.stringify(context),
  };
}
