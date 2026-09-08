import { createHash } from 'node:crypto';
import { isApprovedDistributionTarget, telegramCall } from './distribution-service.mjs';
import { telegramDeliveryEnvironment } from './telegram-delivery-settings.mjs';
import { sendDiscordMessage } from './discord-service.mjs';
import { liveTargetKey } from './social-live-monitor.mjs';
import { renderDiscordLiveNotice } from './social-live-notice.mjs';

const RULE_ID = 'system-social-live-notices-v1';
export const LIVE_NOTICE_TTL_MS = 10 * 60_000;

export async function deliverSocialLiveNotice({ source, live, target, text, receiptKey, now, repository, env = process.env, signal, telegramSender = telegramCall, discordSender = sendDiscordMessage }) {
  const deliveryEnv = await telegramDeliveryEnvironment('publish', env);
  if (!isApprovedDistributionTarget(target, deliveryEnv)) throw new Error('直播提醒目标不符合现有发布策略');
  signal?.throwIfAborted();
  const hash = createHash('sha256').update(receiptKey).digest('hex');
  const eventId = `social-live-${hash}`;
  const deliveryId = `${eventId}-delivery`;
  const discord = target.platform === 'discord' || Boolean(target.guildId);
  const deferred = !discord && deliveryEnv.TELEGRAM_DESKTOP_PUBLISHER_REQUIRED === 'true';
  const step = discord
    ? { method: 'sendMessage', payload: renderDiscordLiveNotice(source, live, now) }
    : { method: 'sendMessage', payload: { chat_id: target.chatId, ...(target.chatType !== 'channel' ? { message_thread_id: Number(target.threadId) } : {}), text, disable_web_page_preview: false } };
  // This disabled rule is an audit/foreign-key container, never a scheduler rule.
  if (!await repository.getRule(RULE_ID)) await repository.saveRule({ id: RULE_ID, name: '直播提醒记录（由社媒来源管理）', kind: 'automation', contentType: 'social-live', enabled: false, targets: [], status: 'paused', importedFrom: 'social-live-monitor' });
  const existing = await repository.getDelivery(deliveryId);
  if (existing) {
    if (existing.status === 'success') return { status: 'success', deliveryId, messageId: existing.targetMessageId };
    if (existing.status === 'pending') return { status: 'queued', deliveryId };
    throw new Error('直播提醒已有待核对的投递记录');
  }
  if (!await repository.getEvent(eventId)) await repository.createEvent({ id: eventId, ruleId: RULE_ID, updateId: null, sourceChatId: `social-live:${live.platform}:${live.ownerId}`, sourceThreadId: null, sourceMessageId: null, mediaGroupId: null, eventType: 'automation', reviewStatus: 'not-required', expiresAt: new Date(new Date(now).getTime() + LIVE_NOTICE_TTL_MS).toISOString(), payload: { jobId: 'social-live', sourceId: source.id, live, deliveryPlans: [{ target, contentPolicy: 'fixed-template', steps: [step] }] } });
  await repository.createDelivery({ id: deliveryId, ruleId: RULE_ID, eventId, targetId: liveTargetKey(target), target, status: deferred ? 'pending' : 'dispatching', payload: { socialLiveSourceId: source.id, socialLiveExpiresAt: new Date(new Date(now).getTime() + LIVE_NOTICE_TTL_MS).toISOString() } });
  if (deferred) return { status: 'queued', deliveryId };
  try {
    signal?.throwIfAborted();
    const result = discord
      ? await discordSender(target.channelId, step.payload, { signal })
      : await telegramSender(deliveryEnv.SPEAKER_BOT_TOKEN || deliveryEnv.TRADER1_BOT_TOKEN, step.method, step.payload, { purpose: 'publish', env: deliveryEnv, signal });
    const messageId = String(result?.message_id || result?.id || '');
    if (!/^[1-9][0-9]*$/.test(messageId)) throw new Error('未取得平台消息回执');
    await repository.updateDelivery(deliveryId, { status: 'success', attempts: 1, targetMessageId: messageId, targetMessageIds: [messageId], deliveredAt: new Date().toISOString() });
    return { status: 'success', deliveryId, messageId };
  } catch {
    try { await repository.updateDelivery(deliveryId, { status: 'manual-reconciliation', attempts: 1, error: '直播提醒发送结果不明，请核对平台记录，不能自动重发' }); } catch { /* dispatching fence remains durable */ }
    throw new Error('直播提醒发送结果不明');
  }
}

export async function cancelSocialLiveDelivery(deliveryId, { repository }) {
  const current = await repository.getDelivery(deliveryId);
  if (current?.status !== 'pending') return false;
  const claimed = await repository.claimDelivery(deliveryId);
  if (!claimed) return false;
  await repository.updateDelivery(deliveryId, { status: 'expired', error: '直播已结束、来源已暂停或目标已变更，取消过期提醒' });
  return true;
}
