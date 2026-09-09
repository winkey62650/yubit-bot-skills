// YouTube can give one show separate horizontal/vertical video IDs. Only merge
// explicit format variants with matching titles and nearby actual start times.
export const SIMULCAST_START_WINDOW_MS = 5 * 60_000;
const FORMAT_SUFFIX = /(?:\s+|[|:–—-]\s*|\s*[\[(]\s*)(portrait|vertical|landscape|horizontal)(?:\s+(?:stream|version|mode))?\s*[\])]?\s*$/i;

export function simulcastIdentity(live) {
  if (live?.platform !== 'YouTube' || !live.ownerId || !Number.isFinite(Date.parse(live.startedAt))) return null;
  const title = String(live.title || '').normalize('NFKC').trim();
  const format = title.match(FORMAT_SUFFIX)?.[1]?.toLowerCase() || '';
  const topic = title.replace(FORMAT_SUFFIX, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!topic) return null;
  return { platform: live.platform, ownerId: live.ownerId, id: live.id, topic, format, startedAt: live.startedAt };
}

export function sameSimulcast(a, b) {
  return Boolean(a && b && a.platform === b.platform && a.ownerId === b.ownerId && a.topic === b.topic
    && (a.format || b.format) && Math.abs(Date.parse(a.startedAt) - Date.parse(b.startedAt)) <= SIMULCAST_START_WINDOW_MS);
}

export function preferMainBroadcasts(broadcasts) {
  const portrait = live => ['portrait', 'vertical'].includes(simulcastIdentity(live)?.format) ? 1 : 0;
  return [...broadcasts].sort((a, b) => portrait(a) - portrait(b));
}

export async function findSimulcastReceipt(repository, live, targetKey) {
  const identity = simulcastIdentity(live);
  if (!identity) return null;
  for (const receipt of await repository.listMetaByPrefix('social-live:receipt:')) {
    const value = receipt.value;
    if (value.targetKey !== targetKey || value.status === 'suppressed'
      || !value.broadcastKey?.startsWith(`YouTube:${live.ownerId}:`)) continue;
    let prior = value.simulcast;
    // Existing releases stored the original live metadata in the event. Read it
    // without rewriting the historical receipt or creating a new delivery.
    if (!prior && value.deliveryId) {
      const delivery = await repository.getDelivery?.(value.deliveryId);
      const event = delivery?.eventId ? await repository.getEvent?.(delivery.eventId) : null;
      prior = simulcastIdentity(event?.payload?.live);
    }
    if (sameSimulcast(identity, prior)) return receipt;
  }
  return null;
}
