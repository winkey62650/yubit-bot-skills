import { readJson } from './json-store.js';
import { normalizeSocialPackages } from './social-sources.mjs';
import { getDistributionRepository } from './distribution-repository.mjs';
import { editDiscordLiveNotice } from './discord-service.mjs';
import { liveTargetKey } from './social-live-monitor.mjs';
import { renderDiscordLiveNotice } from './social-live-notice.mjs';

export async function refreshSocialLiveNotice(deliveryId, options = {}) {
  const repository = options.repository ?? await getDistributionRepository();
  const delivery = await repository.getDelivery(String(deliveryId || ''));
  if (delivery?.ruleId !== 'system-social-live-notices-v1' || delivery.status !== 'success' || delivery.target?.platform !== 'discord' || !delivery.targetMessageId) throw new Error('Only a confirmed Discord livestream notice can be reformatted.');
  const event = await repository.getEvent(delivery.eventId);
  const saved = options.sources ?? normalizeSocialPackages((await readJson('social-packages.json', { packages: [] })).packages);
  const source = saved.find(item => item.id === event?.payload?.sourceId && item.id === delivery.payload?.socialLiveSourceId);
  if (!source || !event?.payload?.live || !source.targets?.some(target => liveTargetKey(target) === liveTargetKey(delivery.target))) throw new Error('The source or exact destination is no longer configured.');
  // A historical message is not proof the stream is still live at edit time.
  const payload = renderDiscordLiveNotice(source, event.payload.live, event.createdAt, { historical: true });
  if (options.previewOnly) return { deliveryId, channelId: delivery.target.channelId, messageId: delivery.targetMessageId, payload };
  const result = await (options.editor ?? editDiscordLiveNotice)(delivery.target.channelId, delivery.targetMessageId, payload.embeds[0].url, payload, { signal: AbortSignal.timeout(25_000) });
  await repository.updateDelivery(delivery.id, { payload: { ...delivery.payload, socialLiveNoticeVersion: 'english-card-v1', noticeUpdatedAt: new Date().toISOString() } });
  return { deliveryId, ...result, messageUrl: `https://discord.com/channels/${delivery.target.guildId}/${delivery.target.channelId}/${delivery.targetMessageId}` };
}
