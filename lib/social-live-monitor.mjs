import { createHash, randomUUID } from 'node:crypto';
import { detectSocialLive, liveProviderStatus } from './social-live-sources.mjs';

export const LIVE_CHECK_INTERVAL_MS = 5 * 60_000;
const PREFIX = 'social-live:';
const keyHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceKey = source => `${PREFIX}source:${keyHash([source.id, source.platform, source.accountUrl])}`;
const broadcastKey = live => [live.platform, live.ownerId, live.id].join(':');
export function liveTargetKey(target) {
  return target.platform === 'discord' || target.guildId
    ? `discord:${target.guildId}:${target.channelId}`
    : `telegram:${target.chatId}:${target.chatType === 'channel' ? 'channel' : Number(target.threadId)}`;
}
export function liveDeliveryKey(live, target) { return `${PREFIX}receipt:${keyHash([broadcastKey(live), liveTargetKey(target)])}`; }
export function renderSocialLiveNotice(source, live, now) {
  const stamp = new Date(now).toISOString().replace('T', ' ').slice(0, 16);
  return `🔴 ${source.agent} · ${live.platform === 'X' ? 'X Spaces' : 'YouTube Live'}\n${live.title}\n检测到直播：${stamp} UTC\n${live.url}`;
}
const active = source => source.status === '已启用' && source.liveMonitoring === true;

export async function runSocialLiveMonitor(options = {}) {
  const env = options.env ?? process.env;
  const repository = options.repository ?? await (await import('./distribution-repository.mjs')).getDistributionRepository();
  const loadSources = options.loadSources ?? (async () => {
    const { readJson } = await import('./json-store.js');
    const { normalizeSocialPackages } = await import('./social-sources.mjs');
    const saved = await readJson('social-packages.json', { packages: [] });
    return normalizeSocialPackages(saved.packages || saved);
  });
  const detect = options.detect ?? detectSocialLive;
  const dryRun = options.dryRun === true;
  const now = new Date(options.now ?? Date.now());
  const rows = [];
  const allSources = await loadSources();
  const sources = allSources.filter(active);
  if (!dryRun) {
    for (const { key, value } of await repository.listMetaByPrefix(`${PREFIX}receipt:`)) {
      if (value.status !== "queued") continue;
      const delivery = await repository.getDelivery?.(value.deliveryId);
      if (delivery && ["success", "failed", "expired", "manual-reconciliation"].includes(delivery.status)) {
        await repository.setMeta(key, { ...value, status: delivery.status, messageId: delivery.targetMessageId || null });
        continue;
      }
      const current = allSources.find(item => item.id === value.sourceId);
      if (current && active(current) && current.targets?.some(target => liveTargetKey(target) === value.targetKey)) continue;
      const cancel = options.cancelQueued ?? (await import("./social-live-delivery.mjs")).cancelSocialLiveDelivery;
      if (await cancel(value.deliveryId, { repository }) !== false) await repository.setMeta(key, { ...value, status: "expired", updatedAt: now.toISOString() });
    }
  }
  const deadline = Date.now() + 50_000;
  for (const source of sources) {
    if (Date.now() > deadline) { rows.push({ id: source.id, state: 'deferred', error: '本轮检查达到时间上限，下轮继续' }); continue; }
    const stateKey = sourceKey(source);
    const previous = await repository.getMeta(stateKey);
    if (!dryRun && previous?.nextCheckAt && Date.parse(previous.nextCheckAt) > now.getTime()) continue;
    const leaseKey = `${stateKey}:lease`;
    const lease = { leaseId: randomUUID(), leaseUntil: new Date(Date.now() + 120_000).toISOString() };
    if (!dryRun && !await repository.acquireMetaLease(leaseKey, lease, new Date())) continue;
    const row = { id: source.id, sourceName: source.name, platform: source.platform, checkedAt: now.toISOString(), nextCheckAt: new Date(now.getTime() + LIVE_CHECK_INTERVAL_MS).toISOString(), state: 'unknown', broadcasts: [], notifications: [] };
    try {
      const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      const observation = await detect(source, { env, fetchImpl: options.fetchImpl ?? fetch, signal });
      if (!Array.isArray(observation.broadcasts) || observation.broadcasts.some(live => live.state !== 'live' || !live.ownerId || !live.id || !live.url)) throw new Error('直播状态未得到完整确认');
      row.state = observation.broadcasts.length ? 'live' : 'offline';
      row.broadcasts = observation.broadcasts;
      row.provider = observation.provider;
      row.scheduledCount = observation.scheduledCount || 0;
      if (!dryRun) {
        const current = (await loadSources()).find(item => item.id === source.id);
        if (!current || !active(current) || current.accountUrl !== source.accountUrl || JSON.stringify(current.targets) !== JSON.stringify(source.targets)) { row.state = 'paused'; rows.push(row); continue; }
        // A queued notice remains time-sensitive. Confirmed offline is distinct
        // from a failed lookup and can expire notices still awaiting the desktop.
        const liveKeys = new Set(observation.broadcasts.map(broadcastKey));
        for (const { key, value } of await repository.listMetaByPrefix(`${PREFIX}receipt:`)) {
          if (value.sourceId !== source.id || value.status !== 'queued' || liveKeys.has(value.broadcastKey)) continue;
          const cancel = options.cancelQueued ?? (await import('./social-live-delivery.mjs')).cancelSocialLiveDelivery;
          const canceled = await cancel(value.deliveryId, { repository });
          if (canceled !== false) await repository.setMeta(key, { ...value, status: 'expired', updatedAt: now.toISOString() });
        }
        if (!source.targets?.length && observation.broadcasts.length) throw new Error('直播来源尚未绑定发送目标');
        for (const live of observation.broadcasts) {
          for (const target of source.targets || []) {
            signal.throwIfAborted();
            const receiptKey = liveDeliveryKey(live, target);
            const stored = await repository.getMeta(receiptKey);
            if (stored) {
              row.notifications.push({ target: liveTargetKey(target), status: stored.status, deliveryId: stored.deliveryId || null });
              continue;
            }
            const attemptId = randomUUID();
            const fenced = { sourceId: source.id, targetKey: liveTargetKey(target), broadcastKey: broadcastKey(live), status: 'dispatching', attemptId, updatedAt: now.toISOString() };
            if (!await repository.compareAndSetMeta(receiptKey, { absent: true }, fenced)) continue;
            try {
              const deliver = options.deliver ?? (await import('./social-live-delivery.mjs')).deliverSocialLiveNotice;
              const result = await deliver({ source, live, target, text: renderSocialLiveNotice(source, live, now), receiptKey, now, repository, env, signal });
              if (!['success', 'queued'].includes(result?.status) || (result.status === 'success' && !/^[1-9][0-9]*$/.test(String(result.messageId || '')))) throw new Error('直播提醒投递结果不明确');
              const finished = { ...fenced, ...result, updatedAt: now.toISOString() };
              if (!await repository.compareAndSetMeta(receiptKey, { attemptId, status: 'dispatching' }, finished)) throw new Error('直播提醒回执保存失败');
              row.notifications.push({ target: liveTargetKey(target), status: result.status, deliveryId: result.deliveryId || null });
            } catch (error) {
              const failed = { ...fenced, status: 'manual-reconciliation', error: '投递未完成或结果不明，请在发布记录中核对；不会自动重发', updatedAt: now.toISOString() };
              // Even if this write fails, the durable dispatching fence prevents retry.
              try { await repository.compareAndSetMeta(receiptKey, { attemptId, status: 'dispatching' }, failed); } catch { /* original fence remains */ }
              row.notifications.push({ target: liveTargetKey(target), status: failed.status, error: failed.error });
            }
          }
        }
      }
    } catch (error) {
      row.state = 'error';
      row.error = String(error.message || '直播检查失败').slice(0, 250);
    } finally {
      if (!dryRun) {
        try { await repository.setMeta(stateKey, row); }
        finally { await repository.releaseMetaLease(leaseKey, lease.leaseId); }
      }
    }
    rows.push(row);
  }
  const issues = rows.filter(row => ['error', 'deferred'].includes(row.state) || row.notifications?.some(n => ['manual-reconciliation', 'dispatching', 'failed'].includes(n.status))).length;
  const healthy = rows.some(row => !['error', 'deferred'].includes(row.state) && (!row.notifications.length || row.notifications.some(n => ['success', 'queued'].includes(n.status))));
  return { status: issues ? healthy ? 'partial' : 'failed' : 'success', checkedAt: now.toISOString(), dryRun, sources: rows };
}

export async function getSocialLiveStatus(sources, options = {}) {
  const repository = options.repository ?? await (await import('./distribution-repository.mjs')).getDistributionRepository();
  const env = options.env ?? process.env;
  return Promise.all(sources.map(async source => ({ id: source.id, enabled: active(source), ...liveProviderStatus(source, env), lastCheck: await repository.getMeta(sourceKey(source)) })));
}
