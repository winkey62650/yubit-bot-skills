import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
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
import { AUTOMATION_JOBS, runAutomationJob } from "./automation-jobs.mjs";
import { createTelegramDelivery, telegramUserPublisherStatus } from "./telegram-delivery.mjs";
import { telegramMtprotoCall } from "./telegram-mtproto.mjs";
import { telegramUserPublisherHealth } from "./telegram-user-session.mjs";
import { EDITORIAL_TEMPLATE_VERSION } from "./editorial-template-contract.mjs";

const DEFAULT_DEMO_CHAT_ID = "-1003710405969";
const DESKTOP_PUBLISHER_META_KEY = "desktop-publisher-v1";
const DESKTOP_PUBLISHER_LOCK_KEY = "desktop-publisher-lock-v1";
const DESKTOP_PUBLISHER_HEARTBEAT_TTL_MS = 15 * 60_000;
const DESKTOP_PUBLISHER_LEASE_TTL_MS = 10 * 60_000;
const DESKTOP_PUBLISHER_PREFLIGHT_TTL_MS = 2 * 60_000;

const AUTOMATION_JOB_BY_CONTENT_TYPE = new Map([
  ["news", "news-feed"],
  ["daily-events", "daily-events"],
  ["daily-analysis", "daily-analysis"],
  ["whale-signals", "whale-hourly"],
  ["agent-sync", "agent-sync-4h"]
]);

function distributionDemoOnly(env = process.env) {
  const configured = String(env?.TELEGRAM_DEMO_ONLY ?? "").trim().toLowerCase();
  if (configured) return configured !== "false";
  return String(env?.NODE_ENV || "").trim().toLowerCase() === "production";
}

function distributionTargetKey(target) {
  const chatId = String(target?.chatId ?? "").trim();
  if (chatId && target?.chatType === "channel") return `${chatId}:channel`;
  const threadId = Number(target?.threadId);
  if (!chatId || !Number.isInteger(threadId) || threadId <= 0) return "";
  return `${chatId}:${threadId}`;
}

function approvedDistributionTargetKeys(env = process.env) {
  return new Set(String(env?.TELEGRAM_DISTRIBUTION_APPROVED_TARGETS || "")
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter((value) => /^-?\d+:(?:[1-9]\d*|channel)$/.test(value)));
}

export function canPublishToDistributionTarget(chat, member) {
  if (!member) return false;
  if (member.status === "creator") return true;
  if (member.status !== "administrator") return false;
  return chat?.type === "channel" ? member.can_post_messages === true : true;
}

function isApprovedDistributionTarget(target, env = process.env) {
  const demoChatId = String(env?.DEMO_TELEGRAM_CHAT_ID || DEFAULT_DEMO_CHAT_ID).trim();
  const targetChatId = String(target?.chatId ?? "").trim();
  if (!distributionDemoOnly(env) || targetChatId === demoChatId) return true;
  if (telegramUserPublisherStatus(env).approvedTargetIds.includes(targetChatId)) return true;
  const key = distributionTargetKey(target);
  return Boolean(key && approvedDistributionTargetKeys(env).has(key));
}

function allowedDistributionTargets(targets, env = process.env) {
  return (targets ?? []).filter((target) => target.enabled !== false && isApprovedDistributionTarget(target, env));
}

function desktopPublisherRequired(env = process.env) {
  return String(env?.TELEGRAM_DESKTOP_PUBLISHER_REQUIRED ?? "").trim().toLowerCase() === "true";
}

function isDesktopPublisherTarget(target, env = process.env) {
  const configuredTargetIds = telegramUserPublisherStatus(env).approvedTargetIds;
  const approvedTargetIds = configuredTargetIds.length
    ? configuredTargetIds
    : [String(env?.DEMO_TELEGRAM_CHAT_ID || DEFAULT_DEMO_CHAT_ID).trim()];
  const threadId = Number(target?.threadId);
  return approvedTargetIds.includes(String(target?.chatId ?? "").trim())
    && target?.chatType !== "channel"
    && Number.isInteger(threadId)
    && threadId > 0;
}

function desktopMediaUrl(fileId, env = process.env) {
  const baseUrl = String(env.APP_BASE_URL || env.APP_DEPLOYMENT_URL || env.NEXT_PUBLIC_APP_URL || "")
    .trim()
    .replace(/\/$/, "");
  const secret = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  if (!baseUrl || !secret || !fileId) return "";
  const signature = createHmac("sha256", secret).update(String(fileId)).digest("hex");
  return `${baseUrl}/api/media/telegram?fileId=${encodeURIComponent(fileId)}&sig=${signature}`;
}

function broadcastDesktopDeliveryPlan(event, target, env = process.env) {
  const payload = event?.payload || {};
  const text = String(payload.text ?? payload.caption ?? "");
  const hasText = text.trim().length > 0;
  const photo = Array.isArray(payload.photo) ? payload.photo.at(-1) : null;
  const photoUrl = desktopMediaUrl(photo?.file_id, env);
  if (photoUrl) {
    return {
      target,
      steps: [{
        method: "sendPhoto",
        payload: {
          chat_id: String(target.chatId),
          message_thread_id: Number(target.threadId),
          photo: photoUrl,
          ...(hasText ? { caption: text } : {})
        }
      }]
    };
  }
  if (hasText) {
    return {
      target,
      steps: [{
        method: "sendMessage",
        payload: {
          chat_id: String(target.chatId),
          message_thread_id: Number(target.threadId),
          text
        }
      }]
    };
  }
  throw new Error("本机发布桥暂不支持该 Telegram 消息类型");
}

function decodeTelegramHtml(value) {
  return String(value ?? "")
    .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, label) => `${label} (${href})`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'");
}

function desktopStepsFromTelegramPlan(steps) {
  return (Array.isArray(steps) ? steps : []).flatMap((step, index) => {
    let output;
    if (step?.method === "sendPhoto" && step.payload?.photo) {
      output = {
        kind: "photo",
        imageUrl: String(step.payload.photo),
        caption: decodeTelegramHtml(step.payload.caption)
      };
    } else if (step?.method === "sendMessage" && step.payload?.text) {
      output = { kind: "text", text: decodeTelegramHtml(step.payload.text) };
    }
    if (!output) return [];
    const checksum = createHash("sha256").update(JSON.stringify(output)).digest("hex");
    return [{ ...output, stepId: `${index + 1}-${output.kind}-${checksum.slice(0, 12)}`, checksum }];
  });
}

async function acquireDesktopPublisherLease(repository, now) {
  const lease = {
    leaseId: randomUUID(),
    acquiredAt: now.toISOString(),
    leaseUntil: new Date(now.getTime() + DESKTOP_PUBLISHER_LEASE_TTL_MS).toISOString()
  };
  if (typeof repository?.acquireMetaLease === "function") {
    return repository.acquireMetaLease(DESKTOP_PUBLISHER_LOCK_KEY, lease, now);
  }
  if (typeof repository?.getMeta === "function" && typeof repository?.setMeta === "function") {
    const current = await repository.getMeta(DESKTOP_PUBLISHER_LOCK_KEY);
    if (current?.leaseUntil && Date.parse(current.leaseUntil) > now.getTime()) return null;
    await repository.setMeta(DESKTOP_PUBLISHER_LOCK_KEY, lease);
  }
  return lease;
}

async function ownsDesktopPublisherLease(repository, leaseId, now) {
  if (!leaseId) return false;
  const lease = typeof repository?.getMetaLease === "function"
    ? await repository.getMetaLease(DESKTOP_PUBLISHER_LOCK_KEY)
    : typeof repository?.getMeta === "function"
      ? await repository.getMeta(DESKTOP_PUBLISHER_LOCK_KEY)
      : null;
  if (!lease) return false;
  return lease.leaseId === leaseId && (!lease.leaseUntil || Date.parse(lease.leaseUntil) > now.getTime());
}

async function renewDesktopPublisherLease(repository, leaseId, now) {
  if (!await ownsDesktopPublisherLease(repository, leaseId, now)) return null;
  const leaseUntil = new Date(now.getTime() + DESKTOP_PUBLISHER_LEASE_TTL_MS).toISOString();
  if (typeof repository?.renewMetaLease === "function") {
    return repository.renewMetaLease(DESKTOP_PUBLISHER_LOCK_KEY, leaseId, leaseUntil);
  }
  const current = typeof repository?.getMeta === "function"
    ? await repository.getMeta(DESKTOP_PUBLISHER_LOCK_KEY)
    : null;
  if (current?.leaseId !== leaseId || typeof repository?.setMeta !== "function") return null;
  const renewed = { ...current, leaseUntil };
  await repository.setMeta(DESKTOP_PUBLISHER_LOCK_KEY, renewed);
  return renewed;
}

async function releaseDesktopPublisherLease(repository, leaseId) {
  if (!leaseId) return false;
  if (typeof repository?.releaseMetaLease === "function") {
    return repository.releaseMetaLease(DESKTOP_PUBLISHER_LOCK_KEY, leaseId);
  }
  const current = typeof repository?.getMeta === "function" ? await repository.getMeta(DESKTOP_PUBLISHER_LOCK_KEY) : null;
  if (current && current.leaseId !== leaseId) return false;
  if (typeof repository?.setMeta === "function") await repository.setMeta(DESKTOP_PUBLISHER_LOCK_KEY, null);
  return true;
}

async function desktopDeliveryPlan(repository, delivery) {
  const event = await repository.getEvent(delivery.eventId);
  const plan = (event?.payload?.deliveryPlans ?? []).find((entry) => endpointMatches(entry?.target, delivery.target));
  return { event, plan, steps: desktopStepsFromTelegramPlan(plan?.steps) };
}

function desktopTopicName(event, target) {
  const job = AUTOMATION_JOBS.find((item) => item.id === event?.payload?.jobId);
  return job?.topic || target?.topicName || "";
}

function desktopPublisherDisplayValue(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
}

function desktopPublisherTargetFingerprint(delivery, event) {
  const target = delivery?.target || {};
  return createHash("sha256").update(JSON.stringify({
    chatId: String(target.chatId ?? "").trim(),
    threadId: Number(target.threadId),
    groupName: desktopPublisherDisplayValue(target.groupName || "DEMO Academy"),
    topicName: desktopPublisherDisplayValue(desktopTopicName(event, target))
  })).digest("hex");
}

function assertDesktopPublisherObservedValue(actual, expected, code) {
  if (!actual || actual !== expected) throw new Error(code);
}

export function repairAutomationTargetLabels(rule) {
  if (rule?.kind !== "automation") return rule;
  const jobId = AUTOMATION_JOB_BY_CONTENT_TYPE.get(rule.contentType);
  const topicName = AUTOMATION_JOBS.find((job) => job.id === jobId)?.topic;
  if (!topicName) return rule;
  let changed = false;
  const targets = (rule.targets || []).map((target) => {
    const current = String(target?.topicName || "").trim();
    if (current && !/^Topic\s+\d+$/i.test(current)) return target;
    changed = true;
    return { ...target, topicName };
  });
  return changed ? { ...rule, targets } : rule;
}

async function recordDesktopPublisherHeartbeat(repository, patch = {}, now = new Date()) {
  if (typeof repository?.getMeta !== "function" || typeof repository?.setMeta !== "function") return null;
  const previous = await repository.getMeta(DESKTOP_PUBLISHER_META_KEY) || {};
  const next = {
    ...previous,
    lastSeenAt: new Date(now).toISOString(),
    ...patch
  };
  await repository.setMeta(DESKTOP_PUBLISHER_META_KEY, next);
  return next;
}

export async function desktopPublisherHealth(options = {}) {
  const repository = options.repository;
  const env = options.env ?? process.env;
  const now = new Date(options.now ?? Date.now());
  const routing = telegramUserPublisherStatus(env);
  const heartbeat = typeof repository?.getMeta === "function"
    ? await repository.getMeta(DESKTOP_PUBLISHER_META_KEY) || {}
    : {};
  const lastSeenMs = Date.parse(heartbeat.lastSeenAt || "");
  const active = Number.isFinite(lastSeenMs)
    && now.getTime() - lastSeenMs <= DESKTOP_PUBLISHER_HEARTBEAT_TTL_MS
    && lastSeenMs <= now.getTime() + 60_000;
  const credentialsReady = Boolean(String(env.DESKTOP_PUBLISHER_SECRET || "").trim());
  const routingReady = routing.approvedTargetIds.length > 0;
  const sending = typeof repository?.listDeliveries === "function"
    ? await repository.listDeliveries({ status: "sending", limit: 20 })
    : [];
  const activeDelivery = [...sending]
    .sort((left, right) => Date.parse(left.createdAt || 0) - Date.parse(right.createdAt || 0))[0] || null;
  const activeStamp = Date.parse(activeDelivery?.updatedAt || activeDelivery?.createdAt || "");
  const stalled = Boolean(activeDelivery)
    && Number.isFinite(activeStamp)
    && now.getTime() - activeStamp >= DESKTOP_PUBLISHER_LEASE_TTL_MS;
  const ready = credentialsReady && routingReady && active;
  const operationalStatus = !ready
    ? "offline"
    : stalled
      ? "stalled"
      : activeDelivery
        ? "publishing"
        : "online";
  const operationalReady = ["online", "publishing"].includes(operationalStatus);
  const operationalError = stalled
    ? `投递 ${activeDelivery.id} 超过 10 分钟没有写入检查点，发布任务已卡住并等待安全重领`
    : null;
  const lastDeliveryError = String(heartbeat.lastError || "").trim();
  const expectedUsername = routing.username || "@Serenity_Crypto";
  const obsoleteWindowTitleIdentityError = heartbeat.lastDeliveryStatus === "failed"
    && lastDeliveryError.startsWith("Telegram Desktop 当前显示 @")
    && lastDeliveryError.includes(`无法可靠确认 ${expectedUsername} 正以 DEMO Academy 群身份发送`)
    && lastDeliveryError.includes("未粘贴、未选图、未发送");
  return {
    ...routing,
    mode: "desktop",
    required: true,
    credentialsReady,
    encryptionReady: true,
    routingReady,
    targetAuthorizationReady: routingReady,
    bridgeActive: active,
    ready,
    operationalReady,
    operationalStatus,
    operationalError,
    activeDelivery: activeDelivery ? {
      id: activeDelivery.id,
      ruleId: activeDelivery.ruleId || null,
      status: activeDelivery.status,
      createdAt: activeDelivery.createdAt || null,
      updatedAt: activeDelivery.updatedAt || null,
      completedSteps: Array.isArray(activeDelivery.publisherProgress) ? activeDelivery.publisherProgress.length : 0
    } : null,
    configured: credentialsReady,
    authorized: active,
    username: expectedUsername,
    userId: null,
    firstName: "本机 Telegram",
    authorizedAt: heartbeat.authorizedAt || heartbeat.lastVerifiedAt || null,
    lastSeenAt: heartbeat.lastSeenAt || null,
    lastVerifiedAt: heartbeat.lastVerifiedAt || heartbeat.lastSeenAt || null,
    lastDeliveryAt: obsoleteWindowTitleIdentityError ? null : heartbeat.lastDeliveryAt || null,
    lastDeliveryStatus: obsoleteWindowTitleIdentityError ? null : heartbeat.lastDeliveryStatus || null,
    lastError: obsoleteWindowTitleIdentityError ? null : heartbeat.lastError || null
  };
}

function token(name, env = process.env) {
  if (name === "speaker") return env.SPEAKER_BOT_TOKEN || env.TRADER1_BOT_TOKEN || "";
  if (name === "forward") return env.FORWARD_BOT_TOKEN || "";
  return env.YUBITADMIN_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || "";
}

async function telegramBotApiCall(botToken, method, payload = {}, fetchImpl = fetch) {
  if (!botToken) throw new Error("Telegram Bot Token 未配置");
  const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store"
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.description || `${method} HTTP ${response.status}`);
  return body.result;
}

export async function telegramCall(botToken, method, payload = {}, options = {}) {
  const deliver = createTelegramDelivery({
    env: options.env ?? process.env,
    botApiCall: (token, botMethod, botPayload) => telegramBotApiCall(
      token,
      botMethod,
      botPayload,
      options.fetchImpl ?? fetch
    ),
    userPublisherCall: options.userPublisherCall ?? options.groupIdentityCall ?? telegramMtprotoCall
  });
  return deliver(botToken, method, payload);
}

export function verifyTelegramWebhookSecret(actual, expected = process.env.TELEGRAM_WEBHOOK_SECRET) {
  if (!actual || !expected) return false;
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function createDistributionEngine(options = {}) {
  const env = options.env ?? process.env;
  const repository = options.repository ?? await getDistributionRepository();
  const forwardToken = token("forward", env);
  return new DistributionEngine({
    repository,
    forwardBotId: forwardToken.split(":")[0],
    telegram: options.telegram ?? ((method, payload) => telegramCall(forwardToken, method, payload, {
      env,
      userPublisherCall: options.userPublisherCall ?? options.groupIdentityCall
    })),
    targetFilter: (target) => isApprovedDistributionTarget(target, env),
    deferDelivery: desktopPublisherRequired(env),
    deliveryPlanBuilder: (event, target) => broadcastDesktopDeliveryPlan(event, target, env)
  });
}

export async function processTelegramWebhookUpdate(update, options = {}) {
  const engine = await (options.engineFactory || createDistributionEngine)(options);
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
  const env = process.env;
  const migration = await ensureLegacyDistributionMigration(repository);
  await repository.cleanupExpired();
  await ensureAutomationSchedules(repository);
  const [storedRules, groupConfig, review, deliveries, database, publisher] = await Promise.all([
    repository.listRules(),
    readJson("group-config.json", { groups: [] }),
    repository.listReviewQueue({ status: "pending", limit: 100 }),
    repository.listDeliveries({ limit: 200 }),
    repository.health(),
    desktopPublisherRequired(env)
      ? desktopPublisherHealth({ repository, env })
      : telegramUserPublisherHealth({ repository, env })
  ]);
  const rules = [];
  for (const storedRule of storedRules) {
    const reconciled = repairAutomationTargetLabels(
      reconcileDistributionRouting(storedRule, groupConfig.groups)
    );
    if (routingSignature(reconciled) !== routingSignature(storedRule)) {
      rules.push(await repository.saveRule(reconciled));
    } else {
      rules.push(storedRule);
    }
  }
  return { rules, review, deliveries, database, publisher, migration, limits: { reviewDays: 7, logDays: 30, backfillMessages: 100 } };
}

function routingSignature(rule) {
  return JSON.stringify({
    source: rule?.source ? {
      chatId: rule.source.chatId,
      chatType: rule.source.chatType,
      threadId: rule.source.threadId,
      groupName: rule.source.groupName,
      topicName: rule.source.topicName
    } : null,
    targets: (rule?.targets || []).map((target) => ({
      id: target.id,
      chatId: target.chatId,
      chatType: target.chatType,
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

export async function validateRuleRuntime(ruleId, options = {}) {
  const env = options.env ?? process.env;
  const repository = options.repository ?? await getDistributionRepository();
  const rule = await repository.getRule(ruleId);
  if (!rule) throw new Error("规则不存在");
  const botName = rule.kind === "broadcast" ? "forward" : "speaker";
  const botToken = token(botName, env);
  const callTelegram = options.telegram ?? telegramCall;
  const checks = [];
  const groupConfig = options.groupConfig ?? await readJson("group-config.json", { groups: [] });
  const targetMismatches = new Map(findDistributionTargetMismatches(rule, groupConfig.groups)
    .map((mismatch) => [mismatch.targetId, mismatch]));
  const sourceMismatch = findDistributionSourceMismatch(rule, groupConfig.groups);
  const desktopTargetMode = rule.kind === "broadcast" && desktopPublisherRequired(env);
  const publisherHealth = desktopTargetMode
    ? options.publisherHealth ?? await desktopPublisherHealth({ repository, env })
    : null;
  let me = null;
  try {
    me = await callTelegram(botToken, "getMe", {}, { env });
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
      const chat = await callTelegram(botToken, "getChat", { chat_id: rule.source.chatId }, { env });
      const member = me ? await callTelegram(botToken, "getChatMember", { chat_id: rule.source.chatId, user_id: me.id }, { env }) : null;
      const ok = Boolean(member && ["administrator", "creator"].includes(member.status));
      if (!sourceMismatch) checks.push({ key: "source", ok, message: ok ? `${chat.title || rule.source.chatId} · ${member.status}` : "ForwardBot 必须是来源群或频道管理员" });
    } catch (error) {
      if (!sourceMismatch) checks.push({ key: "source", ok: false, message: error.message });
    }
    try {
      const webhook = await callTelegram(botToken, "getWebhookInfo", {}, { env });
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
    if (desktopTargetMode) {
      const approved = isDesktopPublisherTarget(target, env);
      const bridgeReady = publisherHealth?.operationalReady === true;
      const username = publisherHealth?.username || telegramUserPublisherStatus(env).username || "@Serenity_Crypto";
      const topic = target.topicName || (target.threadId ? `Topic ${target.threadId}` : "目标 Topic");
      checks.push({
        key: `target:${target.id}`,
        ok: approved && bridgeReady,
        message: !approved
          ? `${topic} 未纳入真人发布桥授权目标`
          : !bridgeReady
            ? `${username} · 本机发布桥${publisherHealth?.operationalStatus === "stalled" ? "卡住" : "离线"}`
            : `${username} · 本机发布桥在线 · ${topic} 已纳入授权（最终权限由实发验证）`
      });
      continue;
    }
    try {
      const chat = await callTelegram(botToken, "getChat", { chat_id: target.chatId }, { env });
      const member = me ? await callTelegram(botToken, "getChatMember", { chat_id: target.chatId, user_id: me.id }, { env }) : null;
      const ok = canPublishToDistributionTarget(chat, member);
      if (ok && target.threadId) {
        await callTelegram(botToken, "sendChatAction", { chat_id: target.chatId, message_thread_id: target.threadId, action: "typing" }, { env });
      }
      const destination = chat.type === "channel" ? "频道" : "群";
      checks.push({ key: `target:${target.id}`, ok, message: ok ? `${chat.title || target.chatId}${target.threadId ? ` / Topic ${target.threadId}` : ""} · 可发送` : `Bot 缺少目标${destination}的${chat.type === "channel" ? "发帖" : "管理员"}权限` });
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
  const forwardToken = token("forward", env);
  const engine = new DistributionEngine({
    repository,
    forwardBotId: forwardToken.split(":")[0],
    telegram: telegram ?? ((method, payload) => telegramCall(forwardToken, method, payload, { env })),
    targetFilter: (target) => isApprovedDistributionTarget(target, env)
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
  if (!isApprovedDistributionTarget(delivery.target, env)) throw new Error("DEMO_ONLY_TEST_POLICY");
  const event = await repository.getEvent(delivery.eventId);
  if (!event) throw new Error("投递事件不存在");
  if (desktopPublisherRequired(env)) {
    if (!isDesktopPublisherTarget(delivery.target, env)) throw new Error("DESKTOP_PUBLISHER_TARGET_NOT_APPROVED");
    const plan = (event.payload?.deliveryPlans ?? []).find((entry) => endpointMatches(entry?.target, delivery.target));
    if (!plan) throw new Error("管理员发布计划不完整，无法重试");
    return repository.updateDelivery(delivery.id, {
      status: "pending",
      error: null,
      targetMessageId: null,
      targetMessageIds: [],
      deliveredAt: null
    });
  }
  if (event.eventType !== "automation") {
    return (await createDistributionEngine({ env, repository, telegram: options.telegram })).retryDelivery(deliveryId);
  }
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
  if (!chat?.id || !["group", "supergroup", "channel"].includes(chat.type)) return;
  const config = await readJson("group-config.json", { schemaVersion: 2, groups: [], bindings: [] });
  const groups = Array.isArray(config.groups) ? config.groups : [];
  const existing = groups.find((group) => String(group.chatId) === String(chat.id)) ?? {};
  const type = chat.type || existing.type || "supergroup";
  const isChannel = type === "channel";
  const topics = Array.isArray(existing.topics) ? [...existing.topics] : [];
  if (!isChannel && message?.message_thread_id) {
    const topicName = message.forum_topic_created?.name || topics.find((topic) => Number(topic.threadId) === Number(message.message_thread_id))?.name || `Topic ${message.message_thread_id}`;
    if (!topics.some((topic) => Number(topic.threadId) === Number(message.message_thread_id))) {
      topics.push({ id: message.message_thread_id, threadId: message.message_thread_id, name: topicName, source: "webhook", verified: true });
    }
  }
  const next = {
    ...existing,
    chatId: String(chat.id),
    title: chat.title || chat.username || existing.title || String(chat.id),
    type,
    username: chat.username || existing.username || "",
    isPrivateChannel: isChannel ? !(chat.username || existing.username) : false,
    isForum: isChannel ? false : chat.is_forum === true || existing.isForum === true,
    canUseTopics: isChannel ? false : chat.is_forum === true || existing.canUseTopics === true,
    topics: isChannel ? [] : topics,
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
      force: rule.runOnce === true || trigger === "manual",
      now: stamp,
      targets,
      deferDelivery: desktopPublisherRequired(env),
      stateKey: `distribution:${rule.id}`,
      publicBaseUrl: env.APP_BASE_URL
        || env.APP_DEPLOYMENT_URL
        || env.NEXT_PUBLIC_APP_URL
        || null
    });
    const deliveryPlans = run.preview?.deliveryPlans ?? [];
    await repository.updateEvent(event.id, {
      payload: { ...event.payload, preview: run.preview ?? null, deliveryPlans, outcome: run.status }
    });
    if (run.status === "duplicate" || run.status === "skipped") {
      return { ruleId: rule.id, status: run.status, run };
    }
    const targetResults = run.preview?.targetResults ?? [];
    if (run.status === "queued") {
      for (const target of targets) {
        await repository.createDelivery({
          eventId: event.id,
          ruleId: rule.id,
          targetId: target.id,
          target,
          status: "pending",
          attempts: 0
        });
      }
      return { ruleId: rule.id, status: "queued", run };
    }
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

export async function claimDesktopPublisherDelivery(options = {}) {
  const repository = options.repository ?? await getDistributionRepository();
  const env = options.env ?? process.env;
  const now = new Date(options.now ?? Date.now());
  await recordDesktopPublisherHeartbeat(repository, {}, now);
  const lease = await acquireDesktopPublisherLease(repository, now);
  if (!lease) return null;
  try {
    const limit = Math.max(1, Number(options.limit) || 200);
    const [sending, pending] = await Promise.all([
      repository.listDeliveries({ status: "sending", limit }),
      repository.listDeliveries({ status: "pending", limit })
    ]);
    const eligible = await Promise.all(
      [...sending, ...pending]
        .filter((delivery) => isDesktopPublisherTarget(delivery.target, env))
        .map(async (delivery) => {
          let ruleKind = "";
          if (delivery.status !== "sending" && typeof repository.getRule === "function") {
            try {
              ruleKind = String((await repository.getRule(delivery.ruleId))?.kind || "");
            } catch {
              ruleKind = "";
            }
          }
          const broadcast = ruleKind === "broadcast"
            || String(delivery.ruleId || "").startsWith("production-broadcast-");
          return {
            delivery,
            priority: delivery.status === "sending" ? 0 : (broadcast ? 1 : 2)
          };
        })
    );
    eligible.sort((left, right) => left.priority - right.priority
      || new Date(left.delivery.createdAt || 0).getTime() - new Date(right.delivery.createdAt || 0).getTime());

    for (const { delivery } of eligible) {
      const claimed = delivery.status === "sending" ? delivery : await repository.claimDelivery(delivery.id);
      if (!claimed) continue;
      const { event, plan, steps } = await desktopDeliveryPlan(repository, claimed);
      if (!event || !plan || !steps.length) {
        await repository.updateDelivery(claimed.id, {
          status: "failed",
          attempts: Number(claimed.attempts ?? 0) + 1,
          error: "管理员发布计划不完整",
          deliveredAt: null
        });
        await recordDesktopPublisherHeartbeat(repository, {
          lastDeliveryAt: now.toISOString(),
          lastDeliveryStatus: "failed",
          lastError: "管理员发布计划不完整"
        }, now);
        continue;
      }
      return {
        contractVersion: "telegram-template-v2",
        templateVersion: plan.templateVersion || (event?.payload?.jobId
          ? EDITORIAL_TEMPLATE_VERSION
          : "source-verbatim-v1"),
        contentPolicy: "verbatim",
        identityPolicy: "group-official",
        inputPolicy: "clipboard-paste",
        newlinePolicy: "preserve",
        preflightTtlMs: DESKTOP_PUBLISHER_PREFLIGHT_TTL_MS,
        leaseId: lease.leaseId,
        leaseUntil: lease.leaseUntil,
        deliveryId: claimed.id,
        eventId: claimed.eventId,
        ruleId: claimed.ruleId,
        attempt: Number(claimed.attempts ?? 0) + 1,
        chatId: String(claimed.target.chatId),
        threadId: Number(claimed.target.threadId),
        groupName: claimed.target.groupName || "DEMO Academy",
        topicName: desktopTopicName(event, claimed.target),
        steps,
        completedSteps: Array.isArray(claimed.publisherProgress) ? claimed.publisherProgress : [],
        createdAt: claimed.createdAt ?? event.createdAt ?? null
      };
    }
    await releaseDesktopPublisherLease(repository, lease.leaseId);
    return null;
  } catch (error) {
    await releaseDesktopPublisherLease(repository, lease.leaseId);
    throw error;
  }
}

export async function completeDesktopPublisherDelivery(deliveryId, input = {}, options = {}) {
  const repository = options.repository ?? await getDistributionRepository();
  const env = options.env ?? process.env;
  const now = new Date(options.now ?? Date.now());
  const delivery = await repository.getDelivery(deliveryId);
  if (!delivery) throw new Error("投递记录不存在");
  if (!isDesktopPublisherTarget(delivery.target, env)) throw new Error("DESKTOP_PUBLISHER_TARGET_NOT_APPROVED");
  if (delivery.status === "success") {
    await recordDesktopPublisherHeartbeat(repository, {
      lastVerifiedAt: now.toISOString(),
      lastDeliveryAt: delivery.deliveredAt || now.toISOString(),
      lastDeliveryStatus: "success",
      lastError: null
    }, now);
    return delivery;
  }
  if (delivery.status !== "sending") throw new Error("投递记录未被当前发布器领取");
  const leaseId = String(input.leaseId || "").trim();
  const status = ["heartbeat", "prepared", "progress", "success", "failed"].includes(input.status) ? input.status : "";
  if (!status) throw new Error("回写状态必须是 heartbeat、prepared、progress、success 或 failed");
  const ownedLease = ["heartbeat", "prepared", "progress"].includes(status)
    ? await renewDesktopPublisherLease(repository, leaseId, now)
    : await ownsDesktopPublisherLease(repository, leaseId, now);
  if (!ownedLease) throw new Error("DESKTOP_PUBLISHER_LEASE_INVALID");
  const { event, steps } = await desktopDeliveryPlan(repository, delivery);
  if (!steps.length) throw new Error("管理员发布计划不完整");
  const progress = Array.isArray(delivery.publisherProgress) ? [...delivery.publisherProgress] : [];
  if (status === "heartbeat") {
    await recordDesktopPublisherHeartbeat(repository, {}, now);
    return repository.updateDelivery(delivery.id, { status: "sending" });
  }
  if (status === "prepared") {
    const step = steps.find((entry) => entry.stepId === input.stepId);
    if (!step || progress.some((entry) => entry.stepId === step.stepId)) {
      throw new Error("DESKTOP_PUBLISHER_STEP_INVALID");
    }
    const expectedGroupName = desktopPublisherDisplayValue(delivery.target?.groupName || "DEMO Academy");
    const expectedTopicName = desktopPublisherDisplayValue(desktopTopicName(event, delivery.target));
    const observedGroupName = desktopPublisherDisplayValue(input.observedGroupName);
    const observedTopicName = desktopPublisherDisplayValue(input.observedTopicName);
    const observedSenderName = desktopPublisherDisplayValue(input.observedSenderName);
    assertDesktopPublisherObservedValue(observedGroupName, expectedGroupName, "DESKTOP_PUBLISHER_GROUP_MISMATCH");
    assertDesktopPublisherObservedValue(observedTopicName, expectedTopicName, "DESKTOP_PUBLISHER_TOPIC_MISMATCH");
    assertDesktopPublisherObservedValue(observedSenderName, expectedGroupName, "DESKTOP_PUBLISHER_SENDER_MISMATCH");
    const publisherVerification = {
      leaseId,
      stepId: step.stepId,
      checksum: step.checksum,
      targetFingerprint: desktopPublisherTargetFingerprint(delivery, event),
      observedGroupName,
      observedTopicName,
      observedSenderName,
      verifiedAt: now.toISOString()
    };
    await recordDesktopPublisherHeartbeat(repository, { lastVerifiedAt: now.toISOString() }, now);
    return repository.updateDelivery(delivery.id, {
      status: "sending",
      publisherVerification
    });
  }
  if (status === "progress") {
    const step = steps.find((entry) => entry.stepId === input.stepId);
    if (!step) throw new Error("DESKTOP_PUBLISHER_STEP_INVALID");
    const verification = delivery.publisherVerification;
    const verifiedAt = Date.parse(verification?.verifiedAt || "");
    const verificationFresh = Number.isFinite(verifiedAt)
      && verifiedAt <= now.getTime() + 5_000
      && now.getTime() - verifiedAt <= DESKTOP_PUBLISHER_PREFLIGHT_TTL_MS;
    const verificationMatches = verification?.leaseId === leaseId
      && verification?.stepId === step.stepId
      && verification?.checksum === step.checksum
      && verification?.targetFingerprint === desktopPublisherTargetFingerprint(delivery, event);
    if (!verificationFresh || !verificationMatches) {
      throw new Error("DESKTOP_PUBLISHER_PREFLIGHT_REQUIRED");
    }
    if (!progress.some((entry) => entry.stepId === step.stepId)) {
      const targetMessageId = Number(input.targetMessageId);
      progress.push({
        stepId: step.stepId,
        checksum: step.checksum,
        targetMessageId: Number.isFinite(targetMessageId) ? targetMessageId : null,
        completedAt: now.toISOString()
      });
    }
    return repository.updateDelivery(delivery.id, {
      status: "sending",
      publisherProgress: progress,
      publisherVerification: null
    });
  }
  if (status === "success") {
    const completedIds = new Set(progress.map((entry) => entry.stepId));
    if (!steps.every((step) => completedIds.has(step.stepId))) {
      throw new Error("all template steps must be acknowledged before success");
    }
  }
  const targetMessageIds = progress
    .flatMap((entry) => entry.targetMessageId == null ? [] : [Number(entry.targetMessageId)])
    .filter(Number.isFinite);
  const finalStatus = status;
  const updated = await repository.updateDelivery(delivery.id, {
    status: finalStatus,
    attempts: Number(delivery.attempts ?? 0) + 1,
    publisherProgress: progress,
    publisherVerification: null,
    targetMessageId: targetMessageIds[0] ?? null,
    targetMessageIds,
    error: finalStatus === "success" ? null : String(input.error || "本机管理员发布失败"),
    deliveredAt: finalStatus === "success" ? now.toISOString() : null
  });
  const heartbeatPatch = {
    lastDeliveryAt: now.toISOString(),
    lastDeliveryStatus: finalStatus,
    lastError: finalStatus === "success" ? null : String(input.error || "本机管理员发布失败")
  };
  if (finalStatus === "success") heartbeatPatch.lastVerifiedAt = now.toISOString();
  await recordDesktopPublisherHeartbeat(repository, heartbeatPatch, now);
  await releaseDesktopPublisherLease(repository, leaseId);
  return updated;
}
