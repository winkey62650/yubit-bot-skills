import { createHash, randomUUID } from 'node:crypto';
import { fetchSocialPosts, renderPostNotice } from './social-post-sources.mjs';
import { liveTargetKey } from './social-live-monitor.mjs';

const PREFIX = 'social-post:';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stateKey = source => `${PREFIX}source:${hash([source.id, source.platform, source.accountUrl])}`;
export const POST_CHECK_INTERVAL_MS = 5 * 60_000;
export const verifiedPostSource = source => source.postSyncMode === 'verified' && source.postMonitoring === true && source.status === '已启用';
async function loadConfiguredSources() {
  const { readJson } = await import('./json-store.js');
  const { normalizeSocialPackages } = await import('./social-sources.mjs');
  const saved = await readJson('social-packages.json', { packages: [] });
  return normalizeSocialPackages(saved.packages || saved);
}

export async function runSocialPostMonitor(options = {}) {
  const repository = options.repository ?? await (await import('./distribution-repository.mjs')).getDistributionRepository();
  const loadSources = options.loadSources ?? loadConfiguredSources;
  const now = new Date(options.now ?? Date.now());
  const dryRun = options.dryRun === true, rows = [];
  const deadline = Date.now() + 50_000;
  for (const source of (await loadSources()).filter(verifiedPostSource)) {
    const key = stateKey(source), previous = await repository.getMeta(key);
    if (!dryRun && Date.parse(previous?.checkedAt) + POST_CHECK_INTERVAL_MS > now.getTime()) continue;
    if (Date.now() >= deadline) { rows.push({ id: source.id, state: 'error', error: '本轮时间不足，下轮继续' }); continue; }
    const lease = { leaseId: randomUUID(), leaseUntil: new Date(Date.now() + 120_000).toISOString() };
    if (!dryRun && !await repository.acquireMetaLease(`${key}:lease`, lease, new Date())) continue;
    const row = { id: source.id, checkedAt: now.toISOString(), nextCheckAt: new Date(now.getTime() + POST_CHECK_INTERVAL_MS).toISOString(), state: 'ready', notifications: [] };
    try {
      const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      if (!source.targets?.length || source.targets.some(t => t.platform !== 'discord' || !t.guildId || !t.channelId)) throw new Error('普通内容逐条同步需要绑定精确的 Discord 频道');
      const result = await (options.fetchPosts ?? fetchSocialPosts)(source, { env: options.env ?? process.env, fetchImpl: options.fetchImpl ?? fetch, signal });
      if (!result.ownerId || !Array.isArray(result.posts) || result.posts.some(p => p.ownerId !== result.ownerId || p.platform !== source.platform || !p.id || !p.url || !Number.isFinite(Date.parse(p.publishedAt)))) throw new Error('普通更新归属或发布时间未确认');
      row.strategy = result.strategy; row.warning = result.warning || ''; row.visibleCount = result.posts.length; row.excludedLiveCount = result.excludedLiveCount || 0;
      if (!dryRun) {
        const current = (await loadSources()).find(s => s.id === source.id);
        if (!current || !verifiedPostSource(current) || current.accountUrl !== source.accountUrl || JSON.stringify(current.targets) !== JSON.stringify(source.targets)) { row.state = 'paused'; continue; }
        for (const target of source.targets) {
          const targetKey = liveTargetKey(target);
          const subscriptionKey = `${PREFIX}subscription:${hash([source.platform, result.ownerId, targetKey])}`;
          let subscription = await repository.getMeta(subscriptionKey);
          if (!subscription) {
            await repository.compareAndSetMeta(subscriptionKey, { absent: true }, { startedAt: now.toISOString() });
            subscription = await repository.getMeta(subscriptionKey);
          }
          if (!Number.isFinite(Date.parse(subscription?.startedAt))) throw new Error('同步起点未确认，已停止发布');
          row.startedAt = subscription.startedAt;
          for (const post of [...result.posts].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))) {
            if (Date.parse(post.publishedAt) <= Date.parse(subscription.startedAt) || Date.parse(post.publishedAt) > now.getTime()) continue;
            signal.throwIfAborted();
            const receiptKey = `${PREFIX}receipt:${hash([post.platform, post.ownerId, post.id, targetKey])}`;
            const existing = await repository.getMeta(receiptKey);
            if (existing) { row.notifications.push({ postId: post.id, target: targetKey, status: existing.status }); continue; }
            const attemptId = randomUUID();
            const fence = { sourceId: source.id, postId: post.id, ownerId: post.ownerId, targetKey, status: 'dispatching', attemptId, updatedAt: now.toISOString() };
            if (!await repository.compareAndSetMeta(receiptKey, { absent: true }, fence)) continue;
            try {
              const deliver = options.deliver ?? deliverSocialPost;
              const delivery = await deliver({ source, post, target, receiptKey, now, repository, signal, env: options.env ?? process.env });
              if (delivery.status !== 'success' || !/^[1-9][0-9]*$/.test(String(delivery.messageId))) throw new Error('未取得平台回执');
              if (!await repository.compareAndSetMeta(receiptKey, { attemptId, status: 'dispatching' }, { ...fence, ...delivery })) throw new Error('回执保存未确认');
              row.notifications.push({ postId: post.id, target: targetKey, ...delivery });
            } catch {
              try { await repository.compareAndSetMeta(receiptKey, { attemptId, status: 'dispatching' }, { ...fence, status: 'manual-reconciliation' }); } catch { /* durable fence prevents resending */ }
              row.notifications.push({ postId: post.id, target: targetKey, status: 'manual-reconciliation' });
            }
          }
        }
      }
    } catch (error) { row.state = 'error'; row.error = String(error.message).slice(0, 250); }
    finally {
      if (!dryRun) { try { await repository.setMeta(key, row); } finally { await repository.releaseMetaLease(`${key}:lease`, lease.leaseId); } }
      rows.push(row);
    }
  }
  const failed = rows.some(r => r.state === 'error' || r.notifications?.some(n => n.status !== 'success'));
  const healthy = rows.some(r => r.state !== 'error' && (!r.notifications?.length || r.notifications.some(n => n.status === 'success')));
  return { status: failed ? healthy ? 'partial' : 'failed' : 'success', sources: rows, dryRun };
}

export async function getSocialPostStatus(sources, options = {}) {
  const repository = options.repository ?? await (await import('./distribution-repository.mjs')).getDistributionRepository();
  return Promise.all(sources.filter(s => s.postSyncMode === 'verified').map(async s => ({ id: s.id, enabled: verifiedPostSource(s), intervalMinutes: 5, lastCheck: await repository.getMeta(stateKey(s)) })));
}

export async function deliverSocialPost({ source, post, target, receiptKey, now, repository, signal, env = process.env, discordSender }) {
  const { isApprovedDistributionTarget } = await import('./distribution-service.mjs');
  if (target.platform !== 'discord' || !isApprovedDistributionTarget(target, env)) throw new Error('普通更新目标不符合发布策略');
  const ruleId = 'system-social-post-notices-v1';
  const eventId = `social-post-${hash(receiptKey)}`, deliveryId = `${eventId}-delivery`;
  const old = await repository.getDelivery(deliveryId);
  if (old?.status === 'success') return { status: 'success', deliveryId, messageId: old.targetMessageId };
  if (old) throw new Error('已有需核对的普通更新记录');
  const payload = renderPostNotice(source, post);
  if (!await repository.getRule(ruleId)) await repository.saveRule({ id: ruleId, name: '普通社媒更新记录', kind: 'automation', contentType: 'social-post', enabled: false, targets: [], status: 'paused', importedFrom: 'social-post-monitor' });
  if (!await repository.getEvent(eventId)) await repository.createEvent({ id: eventId, ruleId, sourceChatId: `social-post:${post.platform}:${post.ownerId}`, eventType: 'automation', reviewStatus: 'not-required', payload: { jobId: 'social-post', sourceId: source.id, post, deliveryPlans: [{ target, contentPolicy: 'fixed-template', steps: [{ method: 'sendMessage', payload }] }] } });
  await repository.createDelivery({ id: deliveryId, eventId, ruleId, targetId: liveTargetKey(target), target, status: 'dispatching', payload: { socialPostSourceId: source.id } });
  try {
    signal?.throwIfAborted();
    const send = discordSender ?? (await import('./discord-service.mjs')).sendDiscordMessage;
    const result = await send(target.channelId, payload, { signal });
    const messageId = String(result?.id || '');
    if (!/^[1-9][0-9]*$/.test(messageId)) throw new Error('未取得平台回执');
    await repository.updateDelivery(deliveryId, { status: 'success', attempts: 1, targetMessageId: messageId, targetMessageIds: [messageId], deliveredAt: new Date().toISOString() });
    return { status: 'success', deliveryId, messageId };
  } catch {
    try { await repository.updateDelivery(deliveryId, { status: 'manual-reconciliation', attempts: 1, error: '普通社媒更新发送结果未确认，已停止自动重发' }); } catch { /* original fence remains */ }
    throw new Error('普通社媒更新发送结果未确认');
  }
}
