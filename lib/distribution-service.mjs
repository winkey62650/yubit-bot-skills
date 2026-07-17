import { timingSafeEqual } from "node:crypto";
import { DistributionEngine } from "./distribution-engine.mjs";
import {
  computeNextRunAt,
  ensureAutomationNextRunAt,
  findDistributionSourceMismatch,
  findDistributionTargetMismatches,
  migrateLegacyDistribution,
  normalizeDistributionRule,
  reconcileDistributionRouting,
  validateDistributionRule
} from "./distribution-domain.mjs";
import { getDistributionRepository } from "./distribution-repository.mjs";
import { readJson, writeJson } from "./json-store.js";
import { runAutomationJob } from "./automation-jobs.mjs";

const DEFAULT_DEMO_CHAT_ID = "-1003710405969";

function distributionDemoOnly(env = process.env) {
  const configured = String(env?.TELEGRAM_DEMO_ONLY ?? "").trim().toLowerCase();
  if (configured) return configured !== "false";
  return String(env?.NODE_ENV || "").trim().toLowerCase() === "production";
}

function isApprovedDemoTarget(target, env = process.env) {
  const demoChatId = String(env?.DEMO_TELEGRAM_CHAT_ID || DEFAULT_DEMO_CHAT_ID).trim();
  return !distributionDemoOnly(env) || String(target?.chatId ?? "") === demoChatId;
}

function allowedDistributionTargets(targets, env = process.env) {
  return (targets ?? []).filter((target) => target.enabled !== false && isApprovedDemoTarget(target, env));
}

function token(name) {
  if (name === "speaker") return process.env.SPEAKER_BOT_TOKEN || process.env.TRADER1_BOT_TOKEN || "";
  if (name === "forward") return process.env.FORWARD_BOT_TOKEN || "";
  return process.env.YUBITADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
}

export async function telegramCall(botToken, method, payload = {}) {
  if (!botToken) throw new Error("Telegram Bot Token 未配置");
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store"
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.description || `${method} HTTP ${response.status}`);
  return body.result;
}

export function verifyTelegramWebhookSecret(actual, expected = process.env.TELEGRAM_WEBHOOK_SECRET) {
  if (!actual || !expected) return false;
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function createDistributionEngine(options = {}) {
  const repository = await getDistributionRepository();
  const forwardToken = token("forward");
  const env = options.env ?? process.env;
  return new DistributionEngine({
    repository,
    forwardBotId: forwardToken.split(":")[0],
    telegram: (method, payload) => telegramCall(forwardToken, method, payload),
    targetFilter: (target) => isApprovedDemoTarget(target, env),
  });
}

export async function processTelegramWebhookUpdate(update, options = {}) {
  const engine = await (options.engineFactory || createDistributionEngine)();
  const result = await engine.receiveUpdate(update);
  const register = options.register || registerWebhookChat;
  const logger = options.logger || console;
  const discover = async () => {
    try {
      await register(update);
    } catch (error) {
      logger.error("Telegram group discovery failed", {
        updateId: update?.update_id,
        message: error?.message || String(error)
      });
    }
  };

  if (typeof options.defer === "function") {
    try {
      options.defer(discover);
    } catch (error) {
      logger.error("Telegram group discovery could not be deferred", {
        updateId: update?.update_id,
        message: error?.message || String(error)
      });
    }
  } else {
    await discover();
  }
  return result;
}

export async function ensureLegacyDistributionMigration(repository) {
  repository ||= await getDistributionRepository();
  const marker = await repository.getMeta("legacy-migration-v1");
  if (marker?.completedAt) return marker;
  const [groupConfig, broadcasts] = await Promise.all([
    readJson("group-config.json", { groups: [], bindings: [] }),
    readJson("broadcast-rules.json", { rules: [] })
  ]);
  const backup = {
    createdAt: new Date().toISOString(),
    groupConfig,
    broadcasts,
    rollbackMarker: "legacy-migration-v1"
  };
  await writeJson("backups/distribution-migration-v1.json", backup);
  const migrated = migrateLegacyDistribution({
    groups: groupConfig.groups,
    bindings: groupConfig.bindings,
    broadcastRules: broadcasts.rules ?? broadcasts
  });
  const all = [...migrated.automaticRules, ...migrated.broadcastRules, ...migrated.pendingRules];
  for (const rule of all) {
    if (!(await repository.getRule(rule.id))) await repository.saveRule(rule);
  }
  const result = {
    completedAt: new Date().toISOString(),
    backupPath: "backups/distribution-migration-v1.json",
    imported: migrated.automaticRules.length + migrated.broadcastRules.length,
    pendingConfirmation: migrated.pendingRules.length + migrated.broadcastRules.filter((rule) => rule.status === "pending-confirmation").length
  };
  await repository.setMeta("legacy-migration-v1", result);
  return result;
}

export async function distributionOverview() {
  const repository = await getDistributionRepository();
  const migration = await ensureLegacyDistributionMigration(repository);
  await repository.cleanupExpired();
  await ensureAutomationSchedules(repository);
  const [storedRules, groupConfig, review, deliveries, database] = await Promise.all([
    repository.listRules(),
    readJson("group-config.json", { groups: [] }),
    repository.listReviewQueue({ status: "pending", limit: 100 }),
    repository.listDeliveries({ limit: 200 }),
    repository.health()
  ]);
  const rules = [];
  for (const storedRule of storedRules) {
    const reconciled = reconcileDistributionRouting(storedRule, groupConfig.groups);
    if (routingSignature(reconciled) !== routingSignature(storedRule)) {
      rules.push(await repository.saveRule(reconciled));
    } else {
      rules.push(storedRule);
    }
  }
  return { rules, review, deliveries, database, migration, limits: { reviewDays: 7, logDays: 30, backfillMessages: 100 } };
}

function routingSignature(rule) {
  return JSON.stringify({
    source: rule?.source ? {
      chatId: rule.source.chatId,
      threadId: rule.source.threadId,
      groupName: rule.source.groupName,
      topicName: rule.source.topicName
    } : null,
    targets: (rule?.targets || []).map((target) => ({
      id: target.id,
      chatId: target.chatId,
      threadId: target.threadId,
      groupName: target.groupName,
      topicName: target.topicName
    }))
  });
}

export async function ensureAutomationSchedules(repository, now = new Date()) {
  const rules = await repository.listRules("automation");
  const missing = rules.filter((rule) => rule.enabled && !rule.runOnce && !rule.nextRunAt);
  await Promise.all(missing.map((rule) => repository.saveRule(ensureAutomationNextRunAt(rule, now))));
  return missing.length;
}

export async function saveDistributionRule(input) {
  const repository = await getDistributionRepository();
  await ensureLegacyDistributionMigration(repository);
  const groupConfig = await readJson("group-config.json", { groups: [] });
  const rule = reconcileDistributionRouting(input, groupConfig.groups);
  const errors = validateDistributionRule(rule);
  if (errors.length) {
    const error = new Error(errors.map((item) => item.message).join("；"));
    error.statusCode = 400;
    error.details = errors;
    throw error;
  }
  return repository.saveRule(rule);
}

export async function validateRuleRuntime(ruleId) {
  const repository = await getDistributionRepository();
  const rule = await repository.getRule(ruleId);
  if (!rule) throw new Error("规则不存在");
  const botName = rule.kind === "broadcast" ? "forward" : "speaker";
  const botToken = token(botName);
  const checks = [];
  const groupConfig = await readJson("group-config.json", { groups: [] });
  const targetMismatches = new Map(findDistributionTargetMismatches(rule, groupConfig.groups)
    .map((mismatch) => [mismatch.targetId, mismatch]));
  const sourceMismatch = findDistributionSourceMismatch(rule, groupConfig.groups);
  let me = null;
  try {
    me = await telegramCall(botToken, "getMe");
    checks.push({ key: "bot", ok: true, message: `@${me.username}` });
  } catch (error) {
    checks.push({ key: "bot", ok: false, message: error.message });
  }
  if (rule.kind === "broadcast") {
    if (sourceMismatch) {
      checks.push({
        key: "source",
        ok: false,
        message: `${rule.source.topicName || "来源 Topic"} 的线程编号已变化：${sourceMismatch.configuredThreadId ?? "未设置"} → ${sourceMismatch.expectedThreadId}，请保存规则后重试`
      });
    }
    try {
      const chat = await telegramCall(botToken, "getChat", { chat_id: rule.source.chatId });
      const member = me ? await telegramCall(botToken, "getChatMember", { chat_id: rule.source.chatId, user_id: me.id }) : null;
      const ok = Boolean(member && ["administrator", "creator"].includes(member.status));
      if (!sourceMismatch) checks.push({ key: "source", ok, message: ok ? `${chat.title || rule.source.chatId} · ${member.status}` : "ForwardBot 必须是来源群或频道管理员" });
    } catch (error) {
      if (!sourceMismatch) checks.push({ key: "source", ok: false, message: error.message });
    }
    try {
      const webhook = await telegramCall(botToken, "getWebhookInfo");
      checks.push({ key: "webhook", ok: Boolean(webhook.url), message: webhook.url ? "已启用" : "尚未启用" });
    } catch (error) {
      checks.push({ key: "webhook", ok: false, message: error.message });
    }
  }
  for (const target of rule.targets) {
    const mismatch = targetMismatches.get(target.id);
    if (mismatch) {
      checks.push({
        key: `target:${target.id}`,
        ok: false,
        message: `${target.topicName || "目标 Topic"} 的线程编号已变化：${mismatch.configuredThreadId ?? "未设置"} → ${mismatch.expectedThreadId}，请保存规则后重试`
      });
      continue;
    }
    try {
      const chat = await telegramCall(botToken, "getChat", { chat_id: target.chatId });
      const member = me ? await telegramCall(botToken, "getChatMember", { chat_id: target.chatId, user_id: me.id }) : null;
      let ok = Boolean(member && ["administrator", "creator"].includes(member.status));
      if (ok && target.threadId) {
        await telegramCall(botToken, "sendChatAction", { chat_id: target.chatId, message_thread_id: target.threadId, action: "typing" });
      }
      checks.push({ key: `target:${target.id}`, ok, message: ok ? `${chat.title || target.chatId}${target.threadId ? ` / Topic ${target.threadId}` : ""} · 可发送` : "Bot 不是目标群管理员" });
    } catch (error) {
      checks.push({ key: `target:${target.id}`, ok: false, message: error.message });
    }
  }
  try {
    checks.push({ key: "database", ...(await repository.health()), message: "数据库可读写" });
  } catch (error) {
    checks.push({ key: "database", ok: false, message: error.message });
  }
  return { ok: checks.every((check) => check.ok), checks };
}

export async function configureForwardWebhook() {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const baseUrl = (process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  if (!secret) throw new Error("TELEGRAM_WEBHOOK_SECRET 未配置");
  if (!/^https:\/\//.test(baseUrl)) throw new Error("APP_BASE_URL 必须是公开 HTTPS 地址");
  const result = await telegramCall(token("forward"), "setWebhook", {
    url: `${baseUrl}/api/telegram/webhook`,
    secret_token: secret,
    allowed_updates: ["message", "channel_post", "edited_message", "edited_channel_post", "my_chat_member", "chat_member"],
    drop_pending_updates: false
  });
  return { configured: Boolean(result), url: `${baseUrl}/api/telegram/webhook` };
}

export async function sendRuleTest(ruleId) {
  const repository = await getDistributionRepository();
  const rule = await repository.getRule(ruleId);
  if (!rule) throw new Error("规则不存在");
  const botToken = token(rule.kind === "broadcast" ? "forward" : "speaker");
  const stamp = new Date().toISOString();
  const results = [];
  const targets = allowedDistributionTargets(rule.targets);
  if (!targets.length) throw new Error("DEMO_ONLY_TEST_POLICY");
  for (const target of targets) {
    try {
      const payload = { chat_id: target.chatId, text: `✅ 内容分发中心测试\n${rule.name}\n${stamp}`, disable_notification: true };
      if (target.threadId) payload.message_thread_id = target.threadId;
      const sent = await telegramCall(botToken, "sendMessage", payload);
      results.push({ targetId: target.id, ok: true, messageId: sent.message_id });
    } catch (error) {
      results.push({ targetId: target.id, ok: false, error: error.message });
    }
  }
  return { ok: results.every((item) => item.ok), results };
}

export function parseBackfillReferences(value) {
  const ids = [];
  for (const raw of String(value ?? "").split(/[\s,;]+/).filter(Boolean)) {
    const linkMessage = raw.match(/^https?:\/\/(?:www\.)?t\.me\/(?:c\/\d+\/)?(?:[^/]+\/)*(\d+)(?:\?.*)?$/i)?.[1];
    const range = raw.match(/^(\d+)-(\d+)$/);
    if (linkMessage) ids.push(Number(linkMessage));
    else if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (end < start) throw new Error(`消息范围无效：${raw}`);
      for (let id = start; id <= end; id += 1) ids.push(id);
    } else if (/^\d+$/.test(raw)) ids.push(Number(raw));
    else throw new Error(`无法识别：${raw}`);
    if (ids.length > 100) throw new Error("单次最多 100 条消息");
  }
  return [...new Set(ids)];
}

export async function backfillRule(ruleId, references, options = {}) {
  const {
    preview = true,
    env = process.env,
    repository: suppliedRepository = null,
    telegram = null
  } = options;
  const repository = suppliedRepository ?? await getDistributionRepository();
  const rule = await repository.getRule(ruleId);
  if (!rule || rule.kind !== "broadcast") throw new Error("广播规则不存在");
  const targets = allowedDistributionTargets(rule.targets, env);
  const messageIds = parseBackfillReferences(references);
  if (!messageIds.length) throw new Error("请输入消息链接或消息编号");
  const captured = await Promise.all(messageIds.map((messageId) => repository.findEventBySource({ ruleId: rule.id, sourceChatId: rule.source.chatId, sourceMessageId: messageId })));
  const items = messageIds.map((messageId, index) => {
    const event = captured[index];
    return { messageId, captured: Boolean(event), text: event?.payload?.text ?? event?.payload?.caption ?? "Bot API 无法读取未捕获的历史正文；确认后可按编号复制" };
  });
  if (preview) return { preview: true, items, targets };
  if (!targets.length) throw new Error("DEMO_ONLY_TEST_POLICY");
  const safeRule = { ...rule, targets };
  const forwardToken = token("forward");
  const engine = new DistributionEngine({
    repository,
    forwardBotId: forwardToken.split(":")[0],
    telegram: telegram ?? ((method, payload) => telegramCall(forwardToken, method, payload)),
    targetFilter: (target) => isApprovedDemoTarget(target, env)
  });
  const results = [];
  for (const [index, messageId] of messageIds.entries()) {
    const existing = captured[index] ?? await repository.findEventBySource({ ruleId: rule.id, sourceChatId: rule.source.chatId, sourceMessageId: messageId });
    const event = existing ?? await repository.createEvent({
      ruleId: rule.id,
      updateId: -messageId,
      sourceChatId: String(rule.source.chatId),
      sourceThreadId: rule.source.threadId ?? null,
      sourceMessageId: messageId,
      mediaGroupId: null,
      eventType: "backfill",
      payload: { backfill: true },
      reviewStatus: "not-required",
      expiresAt: null
    });
    const deliveries = await engine.deliverEvent(safeRule, event);
    results.push({ messageId, deliveries });
  }
  return { preview: false, ok: results.every((row) => row.deliveries.every((delivery) => delivery?.status === "success")), results };
}

export async function retryDistributionDelivery(deliveryId, options = {}) {
  const repository = options.repository ?? await getDistributionRepository();
  const env = options.env ?? process.env;
  const delivery = await repository.getDelivery(deliveryId);
  if (!delivery) throw new Error("投递记录不存在");
  if (delivery.status !== "failed") return delivery;
  if (!isApprovedDemoTarget(delivery.target, env)) throw new Error("DEMO_ONLY_TEST_POLICY");
  const event = await repository.getEvent(delivery.eventId);
  if (!event) throw new Error("投递事件不存在");
  if (event.eventType !== "automation") return (await createDistributionEngine()).retryDelivery(deliveryId);
  const jobId = event.payload?.jobId;
  if (!jobId) throw new Error("自动任务上下文不完整");
  const claimed = await repository.claimDelivery(delivery.id);
  if (!claimed) return repository.getDelivery(delivery.id);
  try {
    const run = await (options.runner ?? runAutomationJob)(jobId, {
      dryRun: false,
      force: true,
      now: new Date(event.payload?.slotAt || event.createdAt),
      targets: [claimed.target],
      stateKey: `distribution-retry:${delivery.id}:${Number(claimed.attempts ?? 0) + 1}`
    });
    const targetResult = run.preview?.targetResults?.[0];
    const success = targetResult ? targetResult.status === "success" : run.status === "success";
    return repository.updateDelivery(delivery.id, {
      status: success ? "success" : "failed",
      attempts: Number(claimed.attempts ?? 0) + 1,
      targetMessageId: targetResult?.messageId ?? claimed.targetMessageId ?? null,
      error: success ? null : targetResult?.error ?? run.message ?? "自动任务重试失败",
      deliveredAt: success ? new Date().toISOString() : claimed.deliveredAt ?? null
    });
  } catch (error) {
    return repository.updateDelivery(delivery.id, {
      status: "failed",
      attempts: Number(claimed.attempts ?? 0) + 1,
      error: error.message
    });
  }
}

export async function registerWebhookChat(update) {
  const message = update.message ?? update.channel_post ?? update.edited_message ?? update.edited_channel_post;
  const membership = update.my_chat_member ?? update.chat_member;
  const chat = message?.chat ?? membership?.chat;
  if (!chat?.id) return;
  const config = await readJson("group-config.json", { schemaVersion: 2, groups: [], bindings: [] });
  const groups = Array.isArray(config.groups) ? config.groups : [];
  const existing = groups.find((group) => String(group.chatId) === String(chat.id)) ?? {};
  const topics = Array.isArray(existing.topics) ? [...existing.topics] : [];
  if (message?.message_thread_id) {
    const topicName = message.forum_topic_created?.name || topics.find((topic) => Number(topic.threadId) === Number(message.message_thread_id))?.name || `Topic ${message.message_thread_id}`;
    if (!topics.some((topic) => Number(topic.threadId) === Number(message.message_thread_id))) {
      topics.push({ id: message.message_thread_id, threadId: message.message_thread_id, name: topicName, source: "webhook", verified: true });
    }
  }
  const next = {
    ...existing,
    chatId: String(chat.id),
    title: chat.title || chat.username || existing.title || String(chat.id),
    type: chat.type || existing.type || "supergroup",
    isForum: chat.is_forum === true || existing.isForum === true,
    canUseTopics: chat.is_forum === true || existing.canUseTopics === true,
    topics,
    source: "webhook",
    lastSeenAt: new Date().toISOString()
  };
  await writeJson("group-config.json", { ...config, schemaVersion: 2, groups: [next, ...groups.filter((group) => String(group.chatId) !== String(chat.id))], updatedAt: new Date().toISOString() });
}

const automationJobIds = {
  news: "news-feed",
  "news-feed": "news-feed",
  "daily-events": "daily-events",
  "daily-analysis": "daily-analysis",
  "whale-signals": "whale-hourly",
  "whale-hourly": "whale-hourly",
  "agent-sync": "agent-sync-4h"
};

function endpointMatches(configured, actual, { wholeSource = false } = {}) {
  if (String(configured?.chatId) !== String(actual?.chatId)) return false;
  const configuredThread = Number(configured?.threadId ?? 0);
  return wholeSource && configuredThread === 0
    ? true
    : configuredThread === Number(actual?.threadId ?? 0);
}

async function saveAutomationBroadcastMappings(repository, targetResults) {
  const successful = (targetResults ?? []).filter((result) => result?.status === "success" && Number(result.messageId));
  if (successful.length < 2) return;
  const broadcastRules = await repository.listRules("broadcast");
  for (const rule of broadcastRules.filter((item) => item.enabled)) {
    const source = successful.find((result) => endpointMatches(rule.source, result.target, { wholeSource: true }));
    if (!source) continue;
    for (const target of (rule.targets ?? []).filter((item) => item.enabled !== false)) {
      const destination = successful.find((result) => endpointMatches(target, result.target));
      if (!destination || destination === source) continue;
      const sourceIds = source.messageIds?.length ? source.messageIds : [source.messageId];
      const destinationIds = destination.messageIds?.length ? destination.messageIds : [destination.messageId];
      for (let index = 0; index < Math.min(sourceIds.length, destinationIds.length); index += 1) {
        await repository.saveMapping({
          ruleId: rule.id,
          sourceChatId: String(source.target.chatId),
          sourceMessageId: Number(sourceIds[index]),
          targetChatId: String(destination.target.chatId),
          targetThreadId: destination.target.threadId ?? null,
          targetMessageId: Number(destinationIds[index])
        });
      }
    }
  }
}

async function executeAutomationRule(rule, {
  repository,
  runner = runAutomationJob,
  now = new Date(),
  trigger = "scheduled",
  env = process.env,
}) {
  const jobId = automationJobIds[rule.contentType];
  if (!jobId) throw new Error(`尚不支持的内容任务：${rule.contentType}`);
  const targets = allowedDistributionTargets(rule.targets, env);
  if (!targets.length) throw new Error("DEMO_ONLY_TEST_POLICY");
  const stamp = new Date(now);
  const event = await repository.createEvent({
    ruleId: rule.id,
    updateId: null,
    sourceChatId: `automation:${rule.id}`,
    sourceThreadId: null,
    sourceMessageId: stamp.getTime(),
    mediaGroupId: null,
    eventType: "automation",
    payload: { jobId, slotAt: stamp.toISOString(), trigger },
    reviewStatus: "not-required",
    expiresAt: null
  });

  try {
    const run = await runner(jobId, {
      dryRun: false,
      force: rule.runOnce === true,
      now: stamp,
      targets,
      stateKey: `distribution:${rule.id}`,
      publicBaseUrl: process.env.APP_BASE_URL
        || process.env.APP_DEPLOYMENT_URL
        || process.env.NEXT_PUBLIC_APP_URL
        || null
    });
    await repository.updateEvent(event.id, { payload: { ...event.payload, preview: run.preview ?? null, outcome: run.status } });
    if (run.status === "duplicate" || run.status === "skipped") {
      return { ruleId: rule.id, status: run.status, run };
    }
    const targetResults = run.preview?.targetResults ?? [];
    for (const target of targets) {
      const targetResult = targetResults.find((row) => row.target?.id === target.id
        || (String(row.target?.chatId) === String(target.chatId)
          && Number(row.target?.threadId) === Number(target.threadId)));
      const success = targetResult ? targetResult.status === "success" : run.status === "success";
      const delivery = await repository.createDelivery({
        eventId: event.id,
        ruleId: rule.id,
        targetId: target.id,
        target,
        status: targetResult?.status ?? run.status,
        attempts: 1
      });
      await repository.updateDelivery(delivery.id, {
        status: success ? "success" : "failed",
        attempts: 1,
        targetMessageId: targetResult?.messageId ?? null,
        targetMessageIds: targetResult?.messageIds ?? (targetResult?.messageId ? [targetResult.messageId] : []),
        error: success ? null : targetResult?.error ?? run.message ?? "自动发布失败",
        deliveredAt: success ? new Date().toISOString() : null
      });
    }
    await saveAutomationBroadcastMappings(repository, targetResults);
    return { ruleId: rule.id, status: run.status, run };
  } catch (error) {
    for (const target of targets) {
      const delivery = await repository.createDelivery({
        eventId: event.id,
        ruleId: rule.id,
        targetId: target.id,
        target,
        status: "failed",
        attempts: 1
      });
      await repository.updateDelivery(delivery.id, {
        status: "failed",
        attempts: 1,
        error: error.message,
        deliveredAt: null
      });
    }
    return { ruleId: rule.id, status: "failed", error: error.message };
  }
}

export async function runDistributionAutomationRule(ruleId, options = {}) {
  const repository = options.repository ?? await getDistributionRepository();
  const rule = await repository.getRule(ruleId);
  if (!rule || rule.kind !== "automation") throw new Error("自动发布规则不存在");
  return executeAutomationRule(rule, {
    repository,
    runner: options.runner,
    now: options.now ?? new Date(),
    trigger: "manual",
    env: options.env ?? process.env,
  });
}

export async function runDueDistributionJobs(now = new Date(), options = {}) {
  const repository = options.repository ?? await getDistributionRepository();
  await repository.cleanupExpired(now);
  await ensureLegacyDistributionMigration(repository);
  const limit = Math.max(1, Number(options.limit) || 1);
  const rules = await repository.claimDueAutomationRules(now, { limit });
  const results = [];
  for (const rule of rules) {
    let result;
    try {
      result = await executeAutomationRule(rule, {
        repository,
        runner: options.runner,
        now,
        trigger: "scheduled",
        env: options.env ?? process.env,
      });
    } catch (error) {
      result = { ruleId: rule.id, status: "failed", error: error.message };
    }
    results.push(result);
    const failed = result.status === "failed"
      || result.status === "partial"
      || (rule.runOnce && result.status === "skipped");
    const retryAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    await repository.saveRule({
      ...rule,
      enabled: rule.runOnce ? failed : rule.enabled,
      status: failed ? "retrying" : (rule.runOnce ? "completed" : "ready"),
      nextRunAt: failed ? retryAt : (rule.runOnce ? null : computeNextRunAt(rule.schedulePreset, now).toISOString()),
      leaseUntil: null
    });
  }
  return { claimed: rules.length, results };
}
