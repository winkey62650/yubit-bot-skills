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
import { hydrateDestinationCtas } from "./destination-cta.mjs";
import { createTelegramDelivery, telegramUserPublisherStatus } from "./telegram-delivery.mjs";
import { telegramDeliveryEnvironment } from "./telegram-delivery-settings.mjs";
import { telegramMtprotoCall } from "./telegram-mtproto.mjs";
import { telegramUserPublisherHealth } from "./telegram-user-session.mjs";
import { EDITORIAL_TEMPLATE_VERSION } from "./editorial-template-contract.mjs";
import { createContentFeedbackLoop } from "./content-feedback-loop.mjs";
import {
  acknowledgeDataReleasePublished,
  acknowledgeDataReleaseTarget,
  releaseDataReleaseTargetClaim,
} from "./data-release-monitor.mjs";

const DEFAULT_DEMO_CHAT_ID = "-1003710405969";
const DEFAULT_JENNAX_CHAT_ID = "-1003332783916";
const DESKTOP_PUBLISHER_META_KEY = "desktop-publisher-v1";
const DESKTOP_PUBLISHER_LOCK_KEY = "desktop-publisher-lock-v1";
const DESKTOP_PUBLISHER_HEARTBEAT_TTL_MS = 15 * 60_000;
const DESKTOP_PUBLISHER_LEASE_TTL_MS = 10 * 60_000;
const DESKTOP_PUBLISHER_PREFLIGHT_TTL_MS = 2 * 60_000;
const DESKTOP_PUBLISHER_DELIVERY_MAX_AGE_MS = 24 * 60 * 60_000;
const AUTOMATION_TARGET_RECEIPTS_META_PREFIX = "automation-target-receipts-v2:";
const AUTOMATION_EXECUTION_STATE_META_PREFIX = "automation-execution-state-v1:";
const AUTOMATION_EXECUTION_LEASE_META_PREFIX = "automation-execution-lease-v1:";
const AUTOMATION_TELEMETRY_META_PREFIX = "automation-telemetry-pending-v1:";
const AUTOMATION_EXECUTION_TTL_MS = 30 * 24 * 60 * 60_000;
const AUTOMATION_EXECUTION_LEASE_TTL_MS = 10 * 60_000;
const AUTOMATION_EXECUTION_LEASE_HEARTBEAT_MS = 30_000;
// Last-resort, process-local safety fence for the case where an external send
// succeeded but every durable receipt/reconciliation write failed. Repository
// objects are often short-lived facades, so object identity is unsafe here.
// Callers may provide a stable, non-secret automationCircuitNamespace; it is
// hashed before use. Without one we intentionally fail closed across all
// facades by rule id. This still cannot provide cross-process exactly-once.
const AUTOMATION_PERSISTENCE_CIRCUITS = new Map();

function automationPersistenceCircuitScope(repository, ruleId) {
  const namespace = String(repository?.automationCircuitNamespace ?? "").trim();
  const scoped = Boolean(namespace);
  const scope = namespace
    ? `namespace:${createHash("sha256").update(namespace).digest("hex")}`
    : "global";
  return { key: JSON.stringify([scope, String(ruleId)]), scoped };
}

function openAutomationPersistenceCircuit(repository, ruleId, diagnostic) {
  const { key, scoped } = automationPersistenceCircuitScope(repository, ruleId);
  AUTOMATION_PERSISTENCE_CIRCUITS.set(
    key,
    {
      ...diagnostic,
      circuitBreakerOpen: true,
      circuitScoped: scoped,
      ...(!scoped ? { circuitRequiresRestart: true } : {})
    }
  );
}

function clearAutomationPersistenceCircuit(repository, ruleId) {
  const { key, scoped } = automationPersistenceCircuitScope(repository, ruleId);
  // A fallback-global fence has no trustworthy repository identity. Clearing
  // it from any facade could release another backing store that happens to use
  // the same rule id, so it deliberately survives until process restart.
  if (!scoped) return false;
  return AUTOMATION_PERSISTENCE_CIRCUITS.delete(key);
}

function getAutomationPersistenceCircuit(repository, ruleId) {
  const { key } = automationPersistenceCircuitScope(repository, ruleId);
  return AUTOMATION_PERSISTENCE_CIRCUITS.get(key) ?? null;
}

function desktopPublisherDeliveryMaxAgeMs(env = process.env) {
  const configured = Number.parseInt(
    String(env?.TELEGRAM_DESKTOP_DELIVERY_MAX_AGE_MS || ""),
    10
  );
  return Number.isFinite(configured) && configured >= DESKTOP_PUBLISHER_LEASE_TTL_MS
    ? configured
    : DESKTOP_PUBLISHER_DELIVERY_MAX_AGE_MS;
}

function shouldArchiveExpiredDesktopDelivery(delivery, now, env = process.env) {
  if (Array.isArray(delivery?.publisherProgress) && delivery.publisherProgress.length > 0) {
    return false;
  }
  const createdAt = Date.parse(delivery?.createdAt || delivery?.updatedAt || "");
  return Number.isFinite(createdAt)
    && now.getTime() - createdAt >= desktopPublisherDeliveryMaxAgeMs(env);
}

const AUTOMATION_JOB_BY_CONTENT_TYPE = new Map([
  ["crypto-daily", "crypto-daily"],
  ["weekly-calendar", "weekly-calendar"],
  ["data-release-updates", "data-release-updates"],
  ["news", "crypto-daily"],
  ["daily-events", "weekly-calendar"],
  ["daily-analysis", "daily-analysis"],
  ["whale-signals", "whale-hourly"],
  ["agent-sync", "agent-sync-4h"]
]);

const STANDARD_BROADCAST_TOPIC_NAMES = Object.freeze({
  1: "1. READ FIRST - DISCLAIMER",
  2: "2. CryptoGuy Trading Zone",
  3: "3. Market Events",
  4: "4. Market Analysis - Crypto/Stocks/TradFi",
  5: "5. Community Signal",
  6: "6. Smart Money Tracker",
  7: "7. YUBIT Updates"
});

function distributionDemoOnly(env = process.env) {
  const configured = String(env?.TELEGRAM_DEMO_ONLY ?? "").trim().toLowerCase();
  if (configured) return configured !== "false";
  return String(env?.NODE_ENV || "").trim().toLowerCase() === "production";
}

function distributionTargetKey(target) {
  if (target?.platform === "discord" || (target?.guildId && target?.channelId)) {
    const guildId = String(target?.guildId ?? "").trim();
    const channelId = String(target?.channelId ?? "").trim();
    return guildId && channelId ? `discord:${guildId}:${channelId}` : "";
  }
  const chatId = String(target?.chatId ?? "").trim();
  if (chatId && target?.chatType === "channel") return `${chatId}:channel`;
  const threadId = Number(target?.threadId);
  if (!chatId || !Number.isInteger(threadId) || threadId <= 0) return "";
  return `${chatId}:${threadId}`;
}

function automationTargetReceiptKey(target) {
  return distributionTargetKey(target);
}

function normalizeAutomationMessageId(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^[0-9]+$/.test(normalized)) return null;
  const canonical = normalized.replace(/^0+(?=\d)/, "");
  return /^0+$/.test(canonical) ? null : canonical;
}

function automationReceiptMessageIds(receipt) {
  const candidates = [
    ...(Array.isArray(receipt?.messageIds) ? receipt.messageIds : []),
    receipt?.messageId
  ];
  return [...new Set(candidates.map(normalizeAutomationMessageId).filter((value) => value !== null))];
}

function automationHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function automationTargetRevision(target) {
  return automationHash({
    endpoint: distributionTargetKey(target),
    ctaEnabled: target?.ctaEnabled ?? null,
    ctaText: target?.ctaText ?? target?.ctaContent ?? null,
    ctaUrl: target?.ctaUrl ?? null,
    parseMode: target?.parseMode ?? null
  });
}

function automationContentRevision(rule) {
  const ignored = new Set(["id", "kind", "enabled", "status", "nextRunAt", "leaseUntil", "createdAt", "updatedAt", "targets"]);
  return Object.fromEntries(Object.entries(rule).filter(([key]) => !ignored.has(key)).sort(([a], [b]) => a.localeCompare(b)));
}

function automationExecutionFingerprint(rule, targets) {
  return automationHash({
    contentType: rule.contentType,
    schedulePreset: rule.schedulePreset ?? null,
    runOnce: rule.runOnce === true,
    revision: automationContentRevision(rule),
    targets: targets.map((target) => ({ key: distributionTargetKey(target), revision: automationTargetRevision(target) }))
      .sort((a, b) => a.key.localeCompare(b.key))
  });
}

function automationExecutionAnchor(rule, now, trigger) {
  const nextRunAt = Date.parse(rule.nextRunAt || "");
  if (Number.isFinite(nextRunAt) && nextRunAt <= now.getTime()) {
    return new Date(nextRunAt).toISOString();
  }
  if (trigger === "scheduled" && Number.isFinite(nextRunAt)) {
    return new Date(nextRunAt).toISOString();
  }
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
}

async function resolveAutomationExecutionScope(repository, rule, targets, now, trigger) {
  const fingerprint = automationExecutionFingerprint(rule, targets);
  const targetRevisions = Object.fromEntries(targets.map((target) => [distributionTargetKey(target), automationTargetRevision(target)]));
  const contentFingerprint = automationHash(automationContentRevision(rule));
  const stateKey = `${AUTOMATION_EXECUTION_STATE_META_PREFIX}${rule.id}`;
  const stored = typeof repository?.getMeta === "function" ? await repository.getMeta(stateKey) : null;
  const active = stored?.generation && ["running", "partial", "failed", "manual-reconciliation"].includes(stored.status);
  const sameRevision = stored?.fingerprint === fingerprint;
  const anchor = automationExecutionAnchor(rule, now, trigger);
  const retryContinuation = active && sameRevision && (
    rule.status === "retrying" || (stored.retryAnchor && stored.retryAnchor === anchor)
  );
  if ((stored?.status === "manual-reconciliation" && active) || retryContinuation) {
    return { generation: stored.generation, fingerprint, targetRevisions, contentFingerprint, stateKey, state: stored, anchor: stored.anchor };
  }
  const generation = automationHash({ ruleId: rule.id, fingerprint, anchor }).slice(0, 24);
  const storedTargetKeys = Object.keys(stored?.targetRevisions ?? {}).sort();
  const currentTargetKeys = Object.keys(targetRevisions).sort();
  const targetSetChanged = JSON.stringify(storedTargetKeys) !== JSON.stringify(currentTargetKeys);
  const migratableState = active
    && rule.status !== "retrying"
    && targetSetChanged
    && stored?.contentFingerprint === contentFingerprint
    && Object.keys(stored?.targetRevisions ?? {}).some((key) => targetRevisions[key] === stored.targetRevisions[key]);
  return {
    generation,
    fingerprint,
    targetRevisions,
    contentFingerprint,
    anchor,
    stateKey,
    state: sameRevision && stored?.generation === generation ? stored : null,
    previousState: migratableState ? stored : null
  };
}

async function persistAutomationExecutionState(repository, scope, status, now, patch = {}, expected = null) {
  if (typeof repository?.setMeta !== "function") return false;
  const value = {
    generation: scope.generation,
    fingerprint: scope.fingerprint,
    contentFingerprint: scope.contentFingerprint,
    targetRevisions: scope.targetRevisions,
    anchor: scope.anchor ?? scope.state?.anchor ?? null,
    status,
    updatedAt: new Date(now).toISOString(),
    expiresAt: status === "success"
      ? new Date(new Date(now).getTime() + AUTOMATION_EXECUTION_TTL_MS).toISOString()
      : null,
    ...patch
  };
  if (expected && typeof repository.compareAndSetMeta === "function") {
    return Boolean(await repository.compareAndSetMeta(scope.stateKey, expected, value));
  }
  await repository.setMeta(scope.stateKey, value);
  return true;
}

async function acquireAutomationExecutionLease(repository, ruleId, generation, now) {
  if (typeof repository?.acquireMetaLease !== "function") return { supported: false, lease: null };
  const key = `${AUTOMATION_EXECUTION_LEASE_META_PREFIX}${ruleId}`;
  const lease = {
    leaseId: randomUUID(),
    generation,
    acquiredAt: now.toISOString(),
    leaseUntil: new Date(now.getTime() + AUTOMATION_EXECUTION_LEASE_TTL_MS).toISOString()
  };
  return { supported: true, key, lease: await repository.acquireMetaLease(key, lease, now) };
}

async function releaseAutomationExecutionLease(repository, leaseState) {
  if (!leaseState?.supported || !leaseState.lease) return;
  if (typeof repository?.releaseMetaLease === "function") {
    await repository.releaseMetaLease(leaseState.key, leaseState.lease.leaseId);
  }
}

function automationExecutionHeartbeatMs(env) {
  const configured = Number.parseInt(String(env?.AUTOMATION_EXECUTION_LEASE_HEARTBEAT_MS ?? ""), 10);
  return Number.isFinite(configured) && configured >= 5 ? configured : AUTOMATION_EXECUTION_LEASE_HEARTBEAT_MS;
}

function automationExecutionRenewTimeoutMs(env) {
  const configured = Number.parseInt(String(env?.AUTOMATION_EXECUTION_LEASE_RENEW_TIMEOUT_MS ?? ""), 10);
  return Number.isFinite(configured) && configured >= 5 ? configured : 10_000;
}

async function renewAutomationExecutionLease(repository, leaseState, now = new Date(), env = process.env) {
  if (!leaseState?.supported || !leaseState.lease || typeof repository?.renewMetaLease !== "function") return true;
  if (leaseState.renewPromise) return leaseState.renewPromise;
  leaseState.renewPromise = (async () => {
    let timeout;
    try {
      const leaseUntil = new Date(now.getTime() + AUTOMATION_EXECUTION_LEASE_TTL_MS).toISOString();
      const renewal = Promise.resolve().then(() => repository.renewMetaLease(
        leaseState.key,
        leaseState.lease.leaseId,
        leaseUntil
      ));
      // A repository/network stall must not pin the scheduler or heartbeat stop.
      // Keep the losing promise observed so a late rejection cannot become unhandled.
      renewal.catch(() => {});
      const renewed = await Promise.race([
        renewal,
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(null), automationExecutionRenewTimeoutMs(env));
          timeout.unref?.();
        })
      ]);
      if (!renewed) leaseState.lost = true;
      else leaseState.lease = renewed;
    } catch {
      leaseState.lost = true;
    } finally {
      clearTimeout(timeout);
    }
    return leaseState.lost !== true;
  })();
  try {
    return await leaseState.renewPromise;
  } finally {
    leaseState.renewPromise = null;
  }
}

function startAutomationExecutionHeartbeat(repository, leaseState, env) {
  if (!leaseState?.supported || !leaseState.lease || typeof repository?.renewMetaLease !== "function") return null;
  const timer = setInterval(() => {
    if (leaseState.renewPromise || leaseState.lost) return;
    void renewAutomationExecutionLease(repository, leaseState, new Date(), env);
  }, automationExecutionHeartbeatMs(env));
  timer.unref?.();
  return {
    async stop() {
      clearInterval(timer);
      try { await leaseState.renewPromise; } catch { /* Renewal already records lease loss. */ }
    }
  };
}

async function loadAutomationTargetReceipts(repository, ruleId, scope, now) {
  const receipts = {};
  if (typeof repository?.getMeta === "function") {
    let stored = await repository.getMeta(`${AUTOMATION_TARGET_RECEIPTS_META_PREFIX}${ruleId}:${scope.generation}`);
    let migrating = false;
    if ((!stored || stored?.generation !== scope.generation) && scope.previousState?.generation) {
      stored = await repository.getMeta(`${AUTOMATION_TARGET_RECEIPTS_META_PREFIX}${ruleId}:${scope.previousState.generation}`);
      migrating = true;
    }
    if (!stored || (!migrating && (stored.generation !== scope.generation || stored.fingerprint !== scope.fingerprint))) return receipts;
    for (const [key, receipt] of Object.entries(stored?.targets ?? {})) {
      const messageIds = automationReceiptMessageIds(receipt);
      if (!key || !messageIds.length || (migrating && receipt.targetRevision !== scope.targetRevisions?.[key])) continue;
      receipts[key] = { ...receipt, messageId: messageIds[0], messageIds };
    }
  }
  return receipts;
}

async function persistAutomationTargetReceipts(repository, ruleId, scope, receipts, now, terminal = false) {
  if (typeof repository?.setMeta !== "function") return false;
  await repository.setMeta(`${AUTOMATION_TARGET_RECEIPTS_META_PREFIX}${ruleId}:${scope.generation}`, {
    ruleId,
    generation: scope.generation,
    fingerprint: scope.fingerprint,
    contentFingerprint: scope.contentFingerprint,
    updatedAt: new Date(now).toISOString(),
    expiresAt: terminal ? new Date(new Date(now).getTime() + AUTOMATION_EXECUTION_TTL_MS).toISOString() : null,
    targets: receipts
  });
  return true;
}

async function queueAutomationTelemetry(repository, ruleId, eventId, patch, generation, error, now) {
  if (typeof repository?.setMeta !== "function") return false;
  const ruleScope = createHash("sha256").update(String(ruleId)).digest("hex");
  const key = `${AUTOMATION_TELEMETRY_META_PREFIX}${ruleScope}:${generation}:${eventId}`;
  await repository.setMeta(key, {
    kind: "automation-telemetry-pending", ruleId, updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(new Date(now).getTime() + AUTOMATION_EXECUTION_TTL_MS).toISOString(),
    eventId, patch, generation, error
  });
  return true;
}

async function flushAutomationTelemetry(repository, ruleId) {
  if (typeof repository?.updateEvent !== "function") return false;
  const ruleScope = createHash("sha256").update(String(ruleId)).digest("hex");
  const prefix = `${AUTOMATION_TELEMETRY_META_PREFIX}${ruleScope}:`;
  const queued = typeof repository?.listMetaByPrefix === "function"
    ? await repository.listMetaByPrefix(prefix)
    : [];
  let flushed = false;
  for (const { key, value } of queued) {
    if (value?.kind !== "automation-telemetry-pending" || value.ruleId !== ruleId || !value.eventId) continue;
    try {
      await repository.updateEvent(value.eventId, value.patch);
      if (typeof repository?.deleteMeta === "function") await repository.deleteMeta(key);
      flushed = true;
    } catch {
      // Each event is an independent durable item; one poison record must not
      // prevent later telemetry from being restored.
    }
  }
  return flushed;
}

function automationRunnerTimeoutMs(env = process.env) {
  const configured = Number.parseInt(String(env?.AUTOMATION_RUNNER_TIMEOUT_MS ?? ""), 10);
  return Number.isFinite(configured) && configured >= 10 ? configured : 5 * 60_000;
}

async function runAutomationWithTimeout(runner, jobId, input, env) {
  const controller = new AbortController();
  const timeoutMs = automationRunnerTimeoutMs(env);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error("AUTOMATION_RUNNER_TIMEOUT"));
      reject(new Error("AUTOMATION_RUNNER_TIMEOUT"));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([runner(jobId, { ...input, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function blockAutomationRuleForReconciliation(repository, rule) {
  if (typeof repository?.saveRule !== "function") return false;
  await repository.saveRule({
    ...rule,
    enabled: false,
    status: "manual-reconciliation",
    nextRunAt: null,
    leaseUntil: null
  });
  return true;
}

async function enforceAutomationPersistenceCircuit(repository, rule) {
  const circuit = getAutomationPersistenceCircuit(repository, rule.id);
  if (!circuit) return null;
  if (circuit.circuitScoped === false || circuit.circuitRequiresRestart === true) {
    return {
      ...circuit,
      ruleId: rule.id,
      status: "manual-reconciliation-unpersisted",
      error: "AUTOMATION_RECONCILIATION_PERSISTENCE_UNAVAILABLE",
      circuitBreakerOpen: true,
      circuitRequiresRestart: true,
      ruleReconciliationPersisted: false
    };
  }
  if (rule.status === "manual-reconciliation" && rule.enabled === false) {
    clearAutomationPersistenceCircuit(repository, rule.id);
    return {
      ...circuit,
      ruleId: rule.id,
      status: "manual-reconciliation",
      error: "AUTOMATION_OPERATOR_ACKNOWLEDGEMENT_REQUIRED",
      circuitBreakerOpen: false,
      ruleReconciliationPersisted: true
    };
  }
  try {
    const persisted = await blockAutomationRuleForReconciliation(repository, rule);
    if (!persisted) throw new Error("AUTOMATION_RULE_RECONCILIATION_NOT_SUPPORTED");
    clearAutomationPersistenceCircuit(repository, rule.id);
    return {
      ...circuit,
      ruleId: rule.id,
      status: "manual-reconciliation",
      error: "AUTOMATION_OPERATOR_ACKNOWLEDGEMENT_REQUIRED",
      circuitBreakerOpen: false,
      ruleReconciliationPersisted: true,
      rulePersistenceError: null
    };
  } catch (error) {
    const blocked = {
      ...circuit,
      ruleId: rule.id,
      status: "manual-reconciliation-unpersisted",
      error: "AUTOMATION_RECONCILIATION_PERSISTENCE_UNAVAILABLE",
      circuitBreakerOpen: true,
      ruleReconciliationPersisted: false,
      rulePersistenceError: error.message
    };
    openAutomationPersistenceCircuit(repository, rule.id, blocked);
    return blocked;
  }
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

export function isApprovedDistributionTarget(target, env = process.env) {
  if (target?.platform === "discord" || (target?.guildId && target?.channelId)) {
    return Boolean(distributionTargetKey(target));
  }
  const demoChatId = String(env?.DEMO_TELEGRAM_CHAT_ID || DEFAULT_DEMO_CHAT_ID).trim();
  const targetChatId = String(target?.chatId ?? "").trim();
  if (!distributionDemoOnly(env)) return true;
  const key = distributionTargetKey(target);
  const explicitlyApprovedKeys = approvedDistributionTargetKeys(env);
  if (explicitlyApprovedKeys.size > 0) {
    return Boolean(key && explicitlyApprovedKeys.has(key));
  }
  if (targetChatId === demoChatId) return true;
  if (telegramUserPublisherStatus(env).approvedTargetIds.includes(targetChatId)) return true;
  return false;
}

function allowedDistributionTargets(targets, env = process.env) {
  return (targets ?? []).filter((target) => target.enabled !== false && isApprovedDistributionTarget(target, env));
}

function desktopPublisherRequired(env = process.env) {
  return String(env?.TELEGRAM_DESKTOP_PUBLISHER_REQUIRED ?? "").trim().toLowerCase() === "true";
}

function isDesktopPublisherTarget(target, env = process.env) {
  if (target?.platform === "discord" || target?.guildId || target?.channelId) return false;
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

function desktopTopicName(event, target, ruleId = "") {
  const eventJobId = event?.payload?.jobId;
  const job = AUTOMATION_JOBS.find((item) => item.id === (automationJobIds[eventJobId] ?? eventJobId));
  if (job?.topic) return job.topic;
  const standardBroadcast = String(ruleId).match(/^production-broadcast-topic-([1-7])$/);
  if (standardBroadcast) return STANDARD_BROADCAST_TOPIC_NAMES[Number(standardBroadcast[1])];
  return target?.topicName || "";
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
    topicName: desktopPublisherDisplayValue(desktopTopicName(event, target, delivery?.ruleId))
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

export function repairDemoToJennaXDirection(rule) {
  if (rule?.kind !== "broadcast" || !/^Demo to JennaX\b/i.test(String(rule?.name || "").trim())) return rule;
  if (String(rule?.source?.chatId || "") !== DEFAULT_JENNAX_CHAT_ID) return rule;
  if (!Array.isArray(rule?.targets) || rule.targets.length !== 1) return rule;
  const target = rule.targets[0];
  if (String(target?.chatId || "") !== DEFAULT_DEMO_CHAT_ID) return rule;

  return {
    ...rule,
    source: {
      ...rule.source,
      chatId: target.chatId,
      chatType: target.chatType || "supergroup",
      threadId: target.threadId,
      groupName: target.groupName || "DEMO Academy",
      topicName: target.topicName
    },
    targets: [{
      ...target,
      chatId: rule.source.chatId,
      chatType: rule.source.chatType || "supergroup",
      threadId: rule.source.threadId,
      groupName: rule.source.groupName || "JennaX Trading Academy",
      topicName: rule.source.topicName
    }]
  };
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

async function telegramBotApiCall(botToken, method, payload = {}, fetchImpl = fetch, options = {}) {
  options.signal?.throwIfAborted?.();
  if (!botToken) throw new Error("Telegram Bot Token 未配置");
  const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
    signal: options.signal
  });
  options.signal?.throwIfAborted?.();
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.description || `${method} HTTP ${response.status}`);
  return body.result;
}

export async function telegramCall(botToken, method, payload = {}, options = {}) {
  const env = await telegramDeliveryEnvironment(options.purpose || "forward", options.env ?? process.env);
  const deliver = createTelegramDelivery({
    env,
    botApiCall: (token, botMethod, botPayload, deliveryOptions = {}) => telegramBotApiCall(
      token,
      botMethod,
      botPayload,
      options.fetchImpl ?? fetch,
      { ...options, ...deliveryOptions, signal: deliveryOptions.signal ?? options.signal }
    ),
    userPublisherCall: options.userPublisherCall ?? options.groupIdentityCall ?? telegramMtprotoCall
  });
  return deliver(botToken, method, payload, { signal: options.signal });
}

export function verifyTelegramWebhookSecret(actual, expected = process.env.TELEGRAM_WEBHOOK_SECRET) {
  if (!actual || !expected) return false;
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function createDistributionEngine(options = {}) {
  const env = await telegramDeliveryEnvironment("forward", options.env ?? process.env);
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
  const [forwardEnv, automationEnv] = await Promise.all([
    telegramDeliveryEnvironment("forward", process.env),
    telegramDeliveryEnvironment("publish", process.env)
  ]);
  const migration = await ensureLegacyDistributionMigration(repository);
  await repository.cleanupExpired();
  await ensureAutomationSchedules(repository);
  const [storedRules, groupConfig, review, deliveries, database, publisher, automationPublisher] = await Promise.all([
    repository.listRules(),
    readJson("group-config.json", { groups: [] }),
    repository.listReviewQueue({ status: "pending", limit: 100 }),
    repository.listDeliveries({ limit: 200 }),
    repository.health(),
    desktopPublisherRequired(forwardEnv)
      ? desktopPublisherHealth({ repository, env: forwardEnv })
      : telegramUserPublisherHealth({ repository, env: forwardEnv }),
    desktopPublisherRequired(automationEnv)
      ? desktopPublisherHealth({ repository, env: automationEnv })
      : telegramUserPublisherHealth({ repository, env: automationEnv })
  ]);
  const rules = [];
  for (const storedRule of storedRules) {
    const reconciled = repairDemoToJennaXDirection(
      repairAutomationTargetLabels(
        reconcileDistributionRouting(storedRule, groupConfig.groups)
      )
    );
    if (routingSignature(reconciled) !== routingSignature(storedRule)) {
      rules.push(await repository.saveRule(reconciled));
    } else {
      rules.push(storedRule);
    }
  }
  return { rules, review, deliveries, database, publisher, automationPublisher, migration, limits: { reviewDays: 7, logDays: 30, backfillMessages: 100 } };
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
  const repository = options.repository ?? await getDistributionRepository();
  const rule = await repository.getRule(ruleId);
  if (!rule) throw new Error("规则不存在");
  const env = await telegramDeliveryEnvironment(rule.kind === "broadcast" ? "forward" : "publish", options.env ?? process.env);
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
    env: baseEnv = process.env,
    repository: suppliedRepository = null,
    telegram = null
  } = options;
  const env = await telegramDeliveryEnvironment("forward", baseEnv);
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

function resolveContentFeedbackLoop(feedbackLoop, env = process.env) {
  if (feedbackLoop === false) return null;
  if (feedbackLoop) {
    if (typeof feedbackLoop.recordReceipt !== "function") throw new TypeError("feedbackLoop.recordReceipt is required");
    return feedbackLoop;
  }
  const vaultPath = String(env?.OBSIDIAN_VAULT_PATH ?? "").trim();
  return vaultPath ? createContentFeedbackLoop({ vaultPath }) : null;
}

function contentFeedbackReceipt(delivery) {
  if (!delivery || !["success", "failed"].includes(delivery.status)) return null;
  const messageIds = Array.isArray(delivery.targetMessageIds) && delivery.targetMessageIds.length
    ? delivery.targetMessageIds
    : (delivery.targetMessageId == null ? [] : [delivery.targetMessageId]);
  const occurredAt = delivery.deliveredAt ?? delivery.updatedAt ?? delivery.createdAt ?? null;
  return {
    deliveryId: delivery.id,
    eventId: delivery.eventId,
    ruleId: delivery.ruleId,
    targetId: delivery.targetId,
    target: delivery.target,
    status: delivery.status,
    attempt: Math.max(1, Number(delivery.attempts ?? 1)),
    messageIds,
    ...(delivery.payload?.contentProductId ? { contentProductId: delivery.payload.contentProductId } : {}),
    ...(delivery.payload?.contentHash ? { contentHash: delivery.payload.contentHash } : {}),
    ...(delivery.error ? { error: String(delivery.error) } : {}),
    ...(occurredAt ? { occurredAt } : {}),
  };
}

function feedbackResultSummary(results) {
  const recorded = results.filter(Boolean);
  if (!recorded.length) return {};
  const pending = recorded.filter((entry) => entry.feedbackPending);
  return {
    feedbackPersisted: pending.length === 0,
    feedbackPending: pending.length > 0,
    feedbackResults: recorded.map(({ delivery, ...entry }) => entry),
    ...(pending.length ? {
      feedbackErrors: pending.map((entry) => ({
        deliveryId: entry.deliveryId,
        error: entry.feedbackError,
        statePersisted: entry.feedbackStatePersisted,
      })),
    } : {}),
  };
}

async function persistContentFeedbackReceipt({ repository, delivery, feedbackLoop, receipt = null }) {
  if (!feedbackLoop) return null;
  const input = receipt ?? contentFeedbackReceipt(delivery);
  if (!input) return null;
  const priorState = delivery.payload?.contentFeedback && typeof delivery.payload.contentFeedback === "object"
    ? delivery.payload.contentFeedback
    : {};
  let result;
  try {
    result = await feedbackLoop.recordReceipt(input, { aggregate: priorState.aggregate ?? null });
  } catch (error) {
    result = {
      status: "pending",
      retryable: true,
      error: error instanceof Error ? error.message : String(error),
      receipt: input,
      aggregate: priorState.aggregate ?? null,
      snapshot: null,
    };
  }
  const receiptId = result.snapshot?.receiptId ?? input.receiptId ?? null;
  const pendingReceipts = (Array.isArray(priorState.pendingReceipts) ? priorState.pendingReceipts : [])
    .filter((entry) => !receiptId || entry.receiptId !== receiptId);
  if (result.status !== "synced") {
    pendingReceipts.push({ ...result.receipt, ...(receiptId ? { receiptId } : {}) });
  }
  const feedbackState = {
    status: result.status === "synced" && pendingReceipts.length === 0 ? "synced" : "pending",
    retryable: result.status !== "synced" || pendingReceipts.length > 0,
    aggregate: result.aggregate ?? priorState.aggregate ?? null,
    pendingReceipts,
    lastError: result.status === "synced" ? null : result.error,
  };
  let persistedDelivery = delivery;
  let statePersisted = false;
  let stateError = null;
  try {
    const updated = await repository.updateDelivery(delivery.id, {
      payload: { ...(delivery.payload ?? {}), contentFeedback: feedbackState },
    });
    persistedDelivery = updated ?? { ...delivery, payload: { ...(delivery.payload ?? {}), contentFeedback: feedbackState } };
    statePersisted = true;
  } catch (error) {
    stateError = error instanceof Error ? error.message : String(error);
  }
  const feedbackPending = feedbackState.status !== "synced" || !statePersisted;
  return {
    deliveryId: delivery.id,
    feedbackPersisted: !feedbackPending,
    feedbackPending,
    feedbackStatePersisted: statePersisted,
    feedbackError: stateError ?? (feedbackPending ? result.error : null),
    receiptId,
    delivery: persistedDelivery,
  };
}

export async function retryDistributionDeliveryFeedback(deliveryId, options = {}) {
  const repository = options.repository ?? await getDistributionRepository();
  const feedbackLoop = resolveContentFeedbackLoop(options.feedbackLoop, options.env ?? process.env);
  if (!feedbackLoop) throw new Error("CONTENT_FEEDBACK_LOOP_NOT_CONFIGURED");
  let delivery = await repository.getDelivery(deliveryId);
  if (!delivery) throw new Error("投递记录不存在");
  const state = delivery.payload?.contentFeedback;
  const pendingReceipts = Array.isArray(state?.pendingReceipts) && state.pendingReceipts.length
    ? state.pendingReceipts
    : (state?.status === "pending" ? [contentFeedbackReceipt(delivery)].filter(Boolean) : []);
  const results = [];
  for (const receipt of pendingReceipts) {
    const recorded = await persistContentFeedbackReceipt({ repository, delivery, feedbackLoop, receipt });
    if (recorded) {
      results.push(recorded);
      delivery = recorded.delivery;
    }
  }
  return { delivery, ...feedbackResultSummary(results) };
}

export async function retryDistributionDelivery(deliveryId, options = {}) {
  const repository = options.repository ?? await getDistributionRepository();
  const delivery = await repository.getDelivery(deliveryId);
  if (!delivery) throw new Error("投递记录不存在");
  if (delivery.status !== "failed") return delivery;
  let env = await telegramDeliveryEnvironment("forward", options.env ?? process.env);
  if (!isApprovedDistributionTarget(delivery.target, env)) throw new Error("DEMO_ONLY_TEST_POLICY");
  const event = await repository.getEvent(delivery.eventId);
  if (!event) throw new Error("投递事件不存在");
  if (event.eventType === "automation") {
    env = await telegramDeliveryEnvironment("publish", options.env ?? process.env);
  }
  const feedbackLoop = resolveContentFeedbackLoop(options.feedbackLoop, env);
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
      repository,
      targets: [claimed.target],
      stateKey: `distribution-retry:${delivery.id}:${Number(claimed.attempts ?? 0) + 1}`
    });
    const targetResult = run.preview?.targetResults?.[0];
    const success = targetResult ? targetResult.status === "success" : run.status === "success";
    const updated = await repository.updateDelivery(delivery.id, {
      status: success ? "success" : "failed",
      attempts: Number(claimed.attempts ?? 0) + 1,
      targetMessageId: targetResult?.messageId ?? claimed.targetMessageId ?? null,
      error: success ? null : targetResult?.error ?? run.message ?? "自动任务重试失败",
      deliveredAt: success ? new Date().toISOString() : claimed.deliveredAt ?? null
    });
    const settled = updated ?? { ...claimed, status: success ? "success" : "failed" };
    const feedback = await persistContentFeedbackReceipt({ repository, delivery: settled, feedbackLoop });
    return feedback?.delivery ?? settled;
  } catch (error) {
    const updated = await repository.updateDelivery(delivery.id, {
      status: "failed",
      attempts: Number(claimed.attempts ?? 0) + 1,
      error: error.message
    });
    const settled = updated ?? { ...claimed, status: "failed", error: error.message };
    const feedback = await persistContentFeedbackReceipt({ repository, delivery: settled, feedbackLoop });
    return feedback?.delivery ?? settled;
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
  "crypto-daily": "crypto-daily",
  "weekly-calendar": "weekly-calendar",
  "data-release-updates": "data-release-updates",
  news: "crypto-daily",
  "news-feed": "crypto-daily",
  "daily-events": "weekly-calendar",
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

export async function expandAutomaticBroadcastTargets(repository, targets) {
  const requested = (targets ?? []).filter((target) => target?.enabled !== false);
  const expanded = [];
  const seen = new Set();

  const append = (target, fallbackId = "") => {
    const key = distributionTargetKey(target);
    if (!key || seen.has(key)) return;
    seen.add(key);
    const id = target.id || fallbackId || `distribution-target:${key}`;
    expanded.push(target.id ? { ...target } : { ...target, id });
  };

  requested.forEach((target) => append(target));
  if (!repository?.listRules || requested.length === 0) return expanded;

  const broadcastRules = await repository.listRules("broadcast");
  for (const rule of broadcastRules ?? []) {
    if (rule?.kind && rule.kind !== "broadcast") continue;
    if (rule?.enabled === false || rule?.mode === "review") continue;
    const sourceSelected = requested.some((target) => endpointMatches(
      rule.source,
      target,
      { wholeSource: true }
    ));
    if (!sourceSelected) continue;
    for (const target of rule.targets ?? []) {
      if (target?.enabled === false) continue;
      const key = distributionTargetKey(target);
      append(target, `broadcast:${rule.id}:${key}`);
    }
  }

  return expanded;
}

async function saveAutomationBroadcastMappings(repository, targetResults) {
  const successful = (targetResults ?? []).filter((result) => result?.target?.platform !== "discord"
    && result?.status === "success" && normalizeAutomationMessageId(result.messageId));
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
          sourceMessageId: normalizeAutomationMessageId(sourceIds[index]),
          targetChatId: String(destination.target.chatId),
          targetThreadId: destination.target.threadId ?? null,
          targetMessageId: normalizeAutomationMessageId(destinationIds[index])
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
  exactTargets = false,
  textOnly = false,
  demoShowcase = false,
  feedbackLoop = null,
}) {
  // Claims and callers may hold a stale rule snapshot. The persisted rule is
  // the authoritative safety fence, especially after an uncertain send has
  // disabled the rule for operator reconciliation.
  if (typeof repository?.getRule === "function") {
    const latestRule = await repository.getRule(rule.id);
    if (latestRule?.kind === "automation") rule = latestRule;
  }
  // An unscoped fallback circuit cannot be attributed to a durable repository
  // identity. It therefore outranks terminal/reset state from any facade with
  // the same rule id and remains a hard process-lifetime fence.
  const existingCircuit = getAutomationPersistenceCircuit(repository, rule.id);
  if (existingCircuit?.circuitScoped === false || existingCircuit?.circuitRequiresRestart === true) {
    return enforceAutomationPersistenceCircuit(repository, rule);
  }
  if (rule.runOnce === true && rule.enabled === false && rule.status === "completed") {
    clearAutomationPersistenceCircuit(repository, rule.id);
    return { ruleId: rule.id, status: "success", run: null, alreadyDelivered: true };
  }
  const persistenceCircuit = await enforceAutomationPersistenceCircuit(repository, rule);
  if (persistenceCircuit) return persistenceCircuit;
  if (rule.status === "manual-reconciliation") {
    return { ruleId: rule.id, status: "manual-reconciliation", error: "AUTOMATION_OPERATOR_ACKNOWLEDGEMENT_REQUIRED" };
  }
  env = await telegramDeliveryEnvironment("publish", env);
  const activeFeedbackLoop = resolveContentFeedbackLoop(feedbackLoop, env);
  const feedbackResults = [];
  const jobId = automationJobIds[rule.contentType];
  if (!jobId) throw new Error(`尚不支持的内容任务：${rule.contentType}`);
  const expandedTargets = exactTargets
    ? (rule.targets ?? []).filter((target) => target?.enabled !== false)
    : await expandAutomaticBroadcastTargets(repository, rule.targets);
  const configuredTargets = await hydrateDestinationCtas(repository, allowedDistributionTargets(expandedTargets, env));
  if (!configuredTargets.length) throw new Error("DEMO_ONLY_TEST_POLICY");
  if (demoShowcase === true) {
    const approvedDemoTopics = new Set([8, 10, 16]);
    const onlyApprovedDemoTargets = configuredTargets.every((target) => {
      const platform = String(target?.platform ?? "telegram").toLowerCase();
      return platform === "telegram"
        && String(target?.chatId ?? "") === "-1003710405969"
        && approvedDemoTopics.has(Number(target?.threadId));
    });
    if (trigger !== "manual" || exactTargets !== true || textOnly === true
      || env.TELEGRAM_DEMO_ONLY !== "true" || !onlyApprovedDemoTargets) {
      throw new Error("ACADEMY_DEMO_SHOWCASE_POLICY");
    }
  }
  const targetIds = new Map();
  for (const target of configuredTargets) {
    const targetKey = distributionTargetKey(target);
    if (!targetKey) return { ruleId: rule.id, status: "failed", error: "AUTOMATION_TARGET_ENDPOINT_INVALID" };
    const targetId = String(target.id ?? "").trim();
    if (targetId && targetIds.has(targetId) && targetIds.get(targetId) !== targetKey) {
      return { ruleId: rule.id, status: "failed", error: "AUTOMATION_TARGET_ID_CONFLICT" };
    }
    if (targetId) targetIds.set(targetId, targetKey);
  }
  const stamp = new Date(now);
  const executionScope = await resolveAutomationExecutionScope(repository, rule, configuredTargets, stamp, trigger);
  if (executionScope.state?.status === "manual-reconciliation") {
    return { ruleId: rule.id, status: "manual-reconciliation", error: "AUTOMATION_OPERATOR_ACKNOWLEDGEMENT_REQUIRED", generation: executionScope.generation };
  }
  const leaseState = await acquireAutomationExecutionLease(repository, rule.id, executionScope.generation, stamp);
  if (leaseState.supported && !leaseState.lease) {
    return { ruleId: rule.id, status: "busy", generation: executionScope.generation };
  }
  const leaseHeartbeat = startAutomationExecutionHeartbeat(repository, leaseState, env);
  const attemptToken = randomUUID();
  try {
    try { await flushAutomationTelemetry(repository, rule.id); } catch { /* Keep queued telemetry for a later attempt. */ }
    const fencedState = typeof repository?.getMeta === "function"
      ? await repository.getMeta(executionScope.stateKey)
      : null;
    if (fencedState?.status === "manual-reconciliation") {
      return { ruleId: rule.id, status: "manual-reconciliation", error: "AUTOMATION_OPERATOR_ACKNOWLEDGEMENT_REQUIRED", generation: fencedState.generation };
    }
    if (fencedState?.phase === "sending" && fencedState?.status === "running") {
      const manual = { ...fencedState, status: "manual-reconciliation", phase: "uncertain", reconciliationError: "AUTOMATION_UNCONFIRMED_SEND", updatedAt: stamp.toISOString(), expiresAt: null };
      let transitioned = true;
      if (typeof repository?.compareAndSetMeta === "function") {
        transitioned = Boolean(await repository.compareAndSetMeta(executionScope.stateKey, {
          generation: fencedState.generation, attemptToken: fencedState.attemptToken, status: "running"
        }, manual));
      } else if (typeof repository?.setMeta === "function") {
        await repository.setMeta(executionScope.stateKey, manual);
      }
      if (!transitioned) return { ruleId: rule.id, status: "busy", error: "AUTOMATION_EXECUTION_FENCE_SUPERSEDED", generation: fencedState.generation };
      try { await blockAutomationRuleForReconciliation(repository, rule); } catch { /* Meta is the primary durable fence. */ }
      return { ruleId: rule.id, status: "manual-reconciliation", error: "AUTOMATION_UNCONFIRMED_SEND", generation: fencedState.generation };
    }
    if (executionScope.state?.generation === executionScope.generation
      && executionScope.state?.status === "success") {
      return {
        ruleId: rule.id,
        status: "success",
        run: null,
        alreadyDelivered: true,
        generation: executionScope.generation
      };
    }
    if (!(await renewAutomationExecutionLease(repository, leaseState, stamp, env))) {
      return { ruleId: rule.id, status: "failed", error: "AUTOMATION_EXECUTION_LEASE_LOST", generation: executionScope.generation };
    }
    if (typeof repository?.setMeta === "function") {
      const preparingExpected = fencedState
        ? {
            generation: fencedState.generation,
            status: fencedState.status,
            ...(fencedState.attemptToken ? { attemptToken: fencedState.attemptToken } : {}),
            ...(fencedState.phase ? { phase: fencedState.phase } : {})
          }
        : { absent: true };
      const preparingMarked = await persistAutomationExecutionState(
        repository, executionScope, "running", stamp, { phase: "preparing", attemptToken }, preparingExpected
      );
      if (!preparingMarked) {
        return { ruleId: rule.id, status: "busy", error: "AUTOMATION_EXECUTION_FENCE_SUPERSEDED", generation: executionScope.generation };
      }
    }
  const previousTargetReceipts = rule.runOnce
    ? await loadAutomationTargetReceipts(repository, rule.id, executionScope, stamp)
    : {};
  const targets = rule.runOnce
    ? configuredTargets.filter((target) => !previousTargetReceipts[automationTargetReceiptKey(target)])
    : configuredTargets;
  if (!targets.length) {
    return {
      ruleId: rule.id,
      status: "success",
      run: null,
      alreadyDelivered: true,
      generation: executionScope.generation,
      targetReceipts: previousTargetReceipts
    };
  }
  const event = await repository.createEvent({
    ruleId: rule.id,
    updateId: null,
    sourceChatId: `automation:${rule.id}`,
    sourceThreadId: null,
    sourceMessageId: stamp.getTime(),
    mediaGroupId: null,
    eventType: "automation",
    payload: { jobId, slotAt: stamp.toISOString(), trigger, generation: executionScope.generation },
    reviewStatus: "not-required",
    expiresAt: null
  });
  let releaseReceipt = null;
  let targetResults = [];
  const persistedReleaseTargets = new Map();
  let runnerStarted = false;
  let runnerCompleted = false;

  try {
    if (!(await renewAutomationExecutionLease(repository, leaseState, new Date(), env))) {
      return { ruleId: rule.id, status: "failed", error: "AUTOMATION_EXECUTION_LEASE_LOST", generation: executionScope.generation };
    }
    if (typeof repository?.setMeta === "function") {
      let sendingMarked;
      try {
        sendingMarked = await persistAutomationExecutionState(repository, executionScope, "running", stamp, {
          phase: "sending", attemptToken, runnerStartedAt: stamp.toISOString()
        }, { generation: executionScope.generation, attemptToken, status: "running" });
      } catch (error) {
        const committed = typeof repository?.getMeta === "function"
          ? await repository.getMeta(executionScope.stateKey).catch(() => null)
          : null;
        if (committed?.phase === "sending" && committed?.attemptToken === attemptToken) {
          try {
            await persistAutomationExecutionState(repository, executionScope, "manual-reconciliation", stamp, {
              phase: "uncertain", attemptToken, reconciliationError: "AUTOMATION_SENDING_FENCE_COMMIT_UNCERTAIN"
            }, { generation: executionScope.generation, attemptToken, status: "running" });
          } catch { /* The committed sending fence already blocks retries. */ }
          try { await blockAutomationRuleForReconciliation(repository, rule); } catch { /* Meta remains fail closed. */ }
          return { ruleId: rule.id, status: "manual-reconciliation", error: "AUTOMATION_SENDING_FENCE_COMMIT_UNCERTAIN", generation: executionScope.generation };
        }
        throw error;
      }
      if (!sendingMarked) {
        return { ruleId: rule.id, status: "failed", error: "AUTOMATION_EXECUTION_FENCE_WRITE_FAILED", generation: executionScope.generation };
      }
    }
    runnerStarted = true;
    const rawRun = await runAutomationWithTimeout(runner, jobId, {
      dryRun: false,
      force: rule.runOnce === true || trigger === "manual",
      now: stamp,
      repository,
      targets,
      deferDelivery: desktopPublisherRequired(env),
      stateKey: `distribution:${rule.id}`,
      textOnly: textOnly === true,
      demoShowcase: demoShowcase === true,
      publicBaseUrl: env.APP_BASE_URL
        || env.APP_DEPLOYMENT_URL
        || env.NEXT_PUBLIC_APP_URL
        || null
    }, env);
    runnerCompleted = true;
    if (!(await renewAutomationExecutionLease(repository, leaseState, new Date(), env))) {
      let uncertaintyPersisted = typeof repository?.setMeta !== "function";
      try {
        uncertaintyPersisted = await persistAutomationExecutionState(repository, executionScope, "manual-reconciliation", stamp, {
          phase: "uncertain", attemptToken, reconciliationError: "AUTOMATION_EXECUTION_LEASE_LOST_AFTER_SEND"
        }, { generation: executionScope.generation, attemptToken, status: "running" });
      } catch { /* The returned state remains fail-closed. */ }
      if (!uncertaintyPersisted) return { ruleId: rule.id, status: "busy", error: "AUTOMATION_EXECUTION_FENCE_SUPERSEDED", generation: executionScope.generation };
      try { await blockAutomationRuleForReconciliation(repository, rule); } catch { /* Best effort secondary durability. */ }
      return { ruleId: rule.id, status: "manual-reconciliation", error: "AUTOMATION_EXECUTION_LEASE_LOST_AFTER_SEND", generation: executionScope.generation };
    }
    const run = rawRun && typeof rawRun === "object" ? rawRun : {};
    const deliveryPlans = run.preview?.deliveryPlans ?? [];
    releaseReceipt = run.preview?.deliveryReceipt ?? null;
    const validRunStatus = ["success", "partial", "failed", "queued", "skipped", "duplicate"].includes(run.status);
    const nonPublishable = validRunStatus && (run.status === "duplicate" || run.status === "skipped");
    targetResults = Array.isArray(run.preview?.targetResults) ? run.preview.targetResults : [];
    const targetOutcomes = targets.map((target) => {
      const targetKey = distributionTargetKey(target);
      const matchingResults = targetResults.filter((row) => distributionTargetKey(row.target) === targetKey);
      const targetResult = matchingResults.length === 1 ? matchingResults[0] : null;
      const successClaimed = targetResult?.receiptFinalizationPending === true || targetResult?.status === "success";
      const messageIds = automationReceiptMessageIds(targetResult);
      const success = successClaimed && messageIds.length > 0;
      const pending = !successClaimed && ["pending", "queued"].includes(targetResult?.status);
      return {
        target,
        targetResult,
        ambiguousTargetResult: matchingResults.length > 1,
        success,
        pending,
        messageIds,
        invalidSuccessReceipt: successClaimed && messageIds.length === 0,
        reliableSuccess: success
      };
    });
    const currentTargetReceipts = { ...previousTargetReceipts };
    for (const outcome of targetOutcomes) {
      if (!outcome.reliableSuccess) continue;
      const targetKey = automationTargetReceiptKey(outcome.target);
      if (!targetKey) continue;
      currentTargetReceipts[targetKey] = {
        targetKey,
        targetId: outcome.target.id ?? null,
        messageId: outcome.messageIds[0],
        messageIds: outcome.messageIds,
        deliveredAt: new Date().toISOString(),
        sourceEventId: event.id,
        targetRevision: executionScope.targetRevisions?.[targetKey] ?? null
      };
    }
    let receiptStatePersisted = false;
    let receiptStateError = null;
    if (rule.runOnce && targetOutcomes.some((outcome) => outcome.reliableSuccess)) {
      try {
        receiptStatePersisted = await persistAutomationTargetReceipts(
          repository,
          rule.id,
          executionScope,
          currentTargetReceipts,
          stamp,
          Object.keys(currentTargetReceipts).length === configuredTargets.length
        );
      } catch (error) {
        receiptStateError = error.message;
      }
    }
    const successfulTargets = targetOutcomes.filter((outcome) => outcome.success).length;
    const missingTargetResults = targetOutcomes.filter((outcome) => !outcome.targetResult);
    const invalidSuccessReceipts = targetOutcomes.filter((outcome) => outcome.invalidSuccessReceipt);
    const ambiguousTargetResults = targetOutcomes.filter((outcome) => outcome.ambiguousTargetResult);
    const allTargetsPending = targetOutcomes.length > 0 && targetOutcomes.every((outcome) => outcome.pending);
    let resultStatus;
    let resultError = null;
    let resultDiagnostic = null;
    if (!validRunStatus) {
      if (successfulTargets === targets.length) {
        resultStatus = "success";
        resultDiagnostic = "AUTOMATION_RUN_STATUS_INVALID";
      } else if (successfulTargets > 0) {
        resultStatus = "partial";
        resultDiagnostic = "AUTOMATION_RUN_STATUS_INVALID";
      } else {
        resultStatus = "failed";
        resultError = "AUTOMATION_RUN_STATUS_INVALID";
      }
    } else if (nonPublishable) {
      resultStatus = run.status;
    } else if (successfulTargets === targets.length) {
      resultStatus = "success";
    } else if (successfulTargets > 0) {
      resultStatus = "partial";
      if (invalidSuccessReceipts.length) resultError = "AUTOMATION_SUCCESS_RECEIPT_INVALID";
      else if (ambiguousTargetResults.length) resultError = "AUTOMATION_TARGET_RESULT_AMBIGUOUS";
      else if (missingTargetResults.length) resultError = "AUTOMATION_TARGET_RESULT_MISSING";
    } else if (run.status === "queued" && allTargetsPending) {
      resultStatus = "queued";
    } else {
      resultStatus = "failed";
      if (invalidSuccessReceipts.length) resultError = "AUTOMATION_SUCCESS_RECEIPT_INVALID";
      else if (ambiguousTargetResults.length) resultError = "AUTOMATION_TARGET_RESULT_AMBIGUOUS";
      else if (missingTargetResults.length) resultError = "AUTOMATION_TARGET_RESULT_MISSING";
    }
    const requiresManualReconciliation = rule.runOnce
      && successfulTargets > 0
      && successfulTargets < targets.length
      && typeof repository?.setMeta === "function"
      && !receiptStatePersisted;
    if (requiresManualReconciliation) {
      resultStatus = "manual-reconciliation";
      resultError = "AUTOMATION_RECEIPT_PERSISTENCE_UNAVAILABLE";
      try { await blockAutomationRuleForReconciliation(repository, rule); } catch { /* Execution state remains the primary durable block. */ }
    }
    let executionStatePersisted = false;
    let executionStateError = null;
    if (typeof repository?.setMeta === "function") {
      try {
        executionStatePersisted = await persistAutomationExecutionState(
          repository,
          executionScope,
          resultStatus,
          stamp,
          {
            phase: "confirmed",
            attemptToken,
            successfulTargetKeys: Object.keys(currentTargetReceipts),
            retryAnchor: ["partial", "failed"].includes(resultStatus)
              ? new Date(stamp.getTime() + 5 * 60_000).toISOString()
              : null
          },
          { generation: executionScope.generation, attemptToken, status: "running" }
        );
      } catch (error) {
        executionStateError = error.message;
      }
    }
    const telemetryPatch = {
      payload: {
        ...event.payload,
        generation: executionScope.generation,
        templateId: run.preview?.templateId ?? null,
        templateVersion: run.preview?.templateVersion ?? null,
        sources: run.preview?.sources ?? [],
        warnings: run.preview?.warnings ?? [],
        deduplicationKey: run.preview?.deduplicationKey ?? null,
        skipReason: run.preview?.skipReason ?? null,
        preview: run.preview ?? null,
        deliveryPlans,
        outcome: resultStatus,
        ...(resultError ? { outcomeError: resultError } : {}),
        ...(resultDiagnostic ? { outcomeDiagnostic: resultDiagnostic } : {}),
        ...(!nonPublishable ? {
          targetReceipts: currentTargetReceipts,
          previousSuccessfulTargetKeys: Object.keys(previousTargetReceipts),
          attemptTargetKeys: targets.map(automationTargetReceiptKey),
          receiptStatePersisted,
          ...(receiptStateError ? { receiptStateError } : {}),
          executionStatePersisted,
          ...(executionStateError ? { executionStateError } : {}),
        } : {}),
        ...(releaseReceipt ? {
          releaseDeduplicationKey: releaseReceipt.deduplicationKey,
          releaseExpectedTargetKeys: releaseReceipt.expectedTargetKeys,
          releaseEvent: releaseReceipt.event ?? run.preview?.event ?? null,
        } : {})
      }
    };
    const persistTelemetry = async () => {
      try {
        await repository.updateEvent(event.id, telemetryPatch);
        return { telemetryPersisted: true, telemetryQueued: false };
      } catch (error) {
        let telemetryQueued = false;
        try {
          telemetryQueued = await queueAutomationTelemetry(
            repository, rule.id, event.id, telemetryPatch, executionScope.generation, error.message, stamp
          );
        } catch { telemetryQueued = false; }
        return { telemetryPersisted: false, telemetryQueued, telemetryError: error.message };
      }
    };
    if (nonPublishable) {
      return { ruleId: rule.id, status: resultStatus, run, generation: executionScope.generation, ...(await persistTelemetry()) };
    }
    if (!(await renewAutomationExecutionLease(repository, leaseState, new Date(), env))) {
      let uncertaintyPersisted = typeof repository?.setMeta !== "function";
      try {
        uncertaintyPersisted = await persistAutomationExecutionState(repository, executionScope, "manual-reconciliation", stamp, {
          phase: "uncertain", attemptToken, reconciliationError: "AUTOMATION_EXECUTION_LEASE_LOST_BEFORE_RECEIPT_PERSISTENCE"
        }, { generation: executionScope.generation, attemptToken, status: "running" });
      } catch { /* The returned state remains fail-closed. */ }
      if (!uncertaintyPersisted) return { ruleId: rule.id, status: "busy", error: "AUTOMATION_EXECUTION_FENCE_SUPERSEDED", generation: executionScope.generation };
      try { await blockAutomationRuleForReconciliation(repository, rule); } catch { /* Best effort secondary durability. */ }
      return {
        ruleId: rule.id,
        status: "manual-reconciliation",
        run,
        error: "AUTOMATION_EXECUTION_LEASE_LOST_BEFORE_RECEIPT_PERSISTENCE",
        generation: executionScope.generation,
        ...(await persistTelemetry())
      };
    }
    try {
      for (const { target, targetResult, success, pending, messageIds, invalidSuccessReceipt } of targetOutcomes) {
        const missingTargetResult = !targetResult;
        const resolvedStatus = missingTargetResult
          ? "failed"
          : success ? "success" : pending ? "pending" : "failed";
        if (pending && targetResult?.receiptExisting === true) continue;
        const releaseTargetKey = targetResult?.releaseTargetKey ?? null;
        const contentPlan = deliveryPlans.find((plan) => endpointMatches(plan?.target, target));
        const delivery = await repository.createDelivery({
          eventId: event.id,
          ruleId: rule.id,
          targetId: target.id,
          target,
          status: resolvedStatus,
          attempts: pending ? 0 : 1,
          payload: {
            executionGeneration: executionScope.generation,
          ...(contentPlan?.contentProductId ? { contentProductId: contentPlan.contentProductId } : {}),
          ...(contentPlan?.contentHash ? { contentHash: contentPlan.contentHash } : {}),
          ...(releaseReceipt && releaseTargetKey ? {
            releaseDeduplicationKey: releaseReceipt.deduplicationKey,
            releaseExpectedTargetKeys: releaseReceipt.expectedTargetKeys,
            releaseTargetKey,
            ...(targetResult?.releaseClaimToken ? { releaseClaimToken: targetResult.releaseClaimToken } : {}),
            releaseEvent: releaseReceipt.event ?? run.preview?.event ?? null,
          } : {})
          }
        });
        if (releaseTargetKey) persistedReleaseTargets.set(releaseTargetKey, delivery);
        if (pending) continue;
        const deliveryError = invalidSuccessReceipt
          ? "AUTOMATION_SUCCESS_RECEIPT_INVALID"
          : resultError === "AUTOMATION_RUN_STATUS_INVALID"
          ? resultError
          : missingTargetResult
            ? "AUTOMATION_TARGET_RESULT_MISSING"
            : targetResult?.error ?? run.message ?? "自动发布失败";
        const operationalPatch = {
          status: success ? "success" : "failed",
          attempts: 1,
          targetMessageId: success ? messageIds[0] : null,
          targetMessageIds: success ? messageIds : [],
          error: success ? null : deliveryError,
          deliveredAt: success ? new Date().toISOString() : null
        };
        const updated = await repository.updateDelivery(delivery.id, operationalPatch);
        const settled = updated ?? { ...delivery, ...operationalPatch };
        const feedback = await persistContentFeedbackReceipt({
          repository,
          delivery: settled,
          feedbackLoop: activeFeedbackLoop,
        });
        if (feedback) feedbackResults.push(feedback);
      }
      await saveAutomationBroadcastMappings(repository, targetResults);
    } catch (error) {
      const reliableExternalSuccess = targetOutcomes.some((outcome) => outcome.reliableSuccess);
      if (!reliableExternalSuccess) throw error;
      let deliveryFailureTelemetry = null;
      let ruleReconciliationPersisted = false;
      let rulePersistenceError = null;
      if (!receiptStatePersisted) {
        const priorResultStatus = resultStatus;
        resultStatus = "manual-reconciliation";
        resultError = "AUTOMATION_DELIVERY_PERSISTENCE_UNAVAILABLE";
        telemetryPatch.payload.outcome = resultStatus;
        telemetryPatch.payload.outcomeError = resultError;
        executionStatePersisted = false;
        try {
          executionStatePersisted = await persistAutomationExecutionState(
            repository,
            executionScope,
            resultStatus,
            stamp,
            {
              phase: "uncertain",
              attemptToken,
              reconciliationError: resultError,
              expiresAt: null
            },
            { generation: executionScope.generation, attemptToken, status: priorResultStatus }
          );
        } catch (stateError) {
          executionStateError = stateError.message;
        }
        // Event telemetry is audit data, not a delivery receipt. Even when it
        // persists successfully, losing both receipt stores leaves the send
        // uncertain and must durably disable the rule instead of reporting
        // success or permitting another process to retry it.
        try {
          ruleReconciliationPersisted = await blockAutomationRuleForReconciliation(repository, rule);
          if (!ruleReconciliationPersisted) {
            rulePersistenceError = "AUTOMATION_RULE_RECONCILIATION_NOT_SUPPORTED";
          }
        } catch (ruleError) {
          rulePersistenceError = ruleError.message;
        }
        if (!executionStatePersisted && !ruleReconciliationPersisted) {
          resultStatus = "manual-reconciliation-unpersisted";
          resultError = "AUTOMATION_RECONCILIATION_PERSISTENCE_UNAVAILABLE";
          executionStateError ||= "AUTOMATION_EXECUTION_STATE_NOT_PERSISTED";
          telemetryPatch.payload.outcome = resultStatus;
          telemetryPatch.payload.outcomeError = resultError;
          telemetryPatch.payload.executionStatePersisted = false;
          telemetryPatch.payload.executionStateError = executionStateError;
          telemetryPatch.payload.ruleReconciliationPersisted = false;
          telemetryPatch.payload.rulePersistenceError = rulePersistenceError;
          openAutomationPersistenceCircuit(repository, rule.id, {
            generation: executionScope.generation,
            deliveryPersisted: false,
            deliveryError: error.message,
            receiptStatePersisted: false,
            ...(receiptStateError ? { receiptStateError } : {}),
            executionStatePersisted: false,
            executionStateError,
            ruleReconciliationPersisted: false,
            rulePersistenceError
          });
        }
        deliveryFailureTelemetry = await persistTelemetry();
      }
      return {
          ruleId: rule.id,
          status: resultStatus,
          ...(resultError ? { error: resultError } : {}),
          generation: executionScope.generation,
          run,
          deliveryPersisted: false,
          deliveryError: error.message,
          receiptStatePersisted,
          executionStatePersisted,
          ruleReconciliationPersisted,
          circuitBreakerOpen: resultStatus === "manual-reconciliation-unpersisted",
          ...(resultStatus === "manual-reconciliation-unpersisted"
            && !automationPersistenceCircuitScope(repository, rule.id).scoped
            ? { circuitRequiresRestart: true }
            : {}),
          ...(receiptStateError ? { receiptStateError } : {}),
          ...(executionStateError ? { executionStateError } : {}),
          ...(rulePersistenceError ? { rulePersistenceError } : {}),
          ...(deliveryFailureTelemetry ?? await persistTelemetry())
        };
    }
    const telemetry = await persistTelemetry();
    if (!telemetry.telemetryPersisted) {
      return {
        ruleId: rule.id,
        status: resultStatus,
        generation: executionScope.generation,
        run,
        ...(resultError ? { error: resultError } : {}),
        ...(resultDiagnostic ? { diagnostic: resultDiagnostic } : {}),
        deliveryPersisted: true,
        receiptStatePersisted,
        executionStatePersisted,
        ...(receiptStateError ? { receiptStateError } : {}),
        ...feedbackResultSummary(feedbackResults),
        ...telemetry
      };
    }
    return {
      ruleId: rule.id,
      status: resultStatus,
      generation: executionScope.generation,
      run,
      ...(resultError ? { error: resultError } : {}),
      ...(resultDiagnostic ? { diagnostic: resultDiagnostic } : {}),
      deliveryPersisted: true,
      receiptStatePersisted,
      executionStatePersisted,
      ...(receiptStateError ? { receiptStateError } : {}),
      ...feedbackResultSummary(feedbackResults),
      telemetryPersisted: true
    };
  } catch (error) {
    if (runnerStarted && !runnerCompleted) {
      let uncertaintyPersisted = typeof repository?.setMeta !== "function";
      try {
        uncertaintyPersisted = await persistAutomationExecutionState(repository, executionScope, "manual-reconciliation", stamp, {
          phase: "uncertain", attemptToken, reconciliationError: error.message
        }, { generation: executionScope.generation, attemptToken, status: "running" });
      } catch { /* Preserve the already-written sending fence. */ }
      if (!uncertaintyPersisted) return { ruleId: rule.id, status: "busy", error: "AUTOMATION_EXECUTION_FENCE_SUPERSEDED", generation: executionScope.generation };
      try { await blockAutomationRuleForReconciliation(repository, rule); } catch { /* The sending fence remains durable. */ }
      return { ruleId: rule.id, status: "manual-reconciliation", error: error.message, generation: executionScope.generation };
    }
    for (const targetResult of targetResults) {
      const releaseTargetKey = targetResult?.releaseTargetKey;
      if (targetResult?.status !== "pending" || targetResult?.receiptFinalizationPending || !releaseTargetKey) continue;
      try {
        const persisted = persistedReleaseTargets.get(releaseTargetKey);
        if (persisted) {
          await repository.updateDelivery(persisted.id, {
            status: "failed",
            attempts: Math.max(1, Number(persisted.attempts ?? 0)),
            error: error.message,
            deliveredAt: null,
          });
        }
        await releaseDataReleaseTargetClaim({
          repository,
          deduplicationKey: releaseReceipt?.deduplicationKey,
          targetKey: releaseTargetKey,
          event: releaseReceipt?.event ?? null,
          now: stamp,
          claimToken: targetResult?.releaseClaimToken
        });
      } catch {
        // Preserve the original persistence failure; the claim lease remains fail-closed.
      }
    }
    for (const target of targets) {
      const targetResult = targetResults.find((row) => distributionTargetKey(row.target) === distributionTargetKey(target));
      const releaseTargetKey = targetResult?.releaseTargetKey ?? null;
      if (releaseTargetKey && persistedReleaseTargets.has(releaseTargetKey)) continue;
      const delivery = await repository.createDelivery({
        eventId: event.id,
        ruleId: rule.id,
        targetId: target.id,
        target,
        status: "failed",
        attempts: 1,
        payload: {
          executionGeneration: executionScope.generation,
        ...(releaseReceipt && releaseTargetKey ? {
          releaseDeduplicationKey: releaseReceipt.deduplicationKey,
          releaseExpectedTargetKeys: releaseReceipt.expectedTargetKeys,
          releaseTargetKey,
          ...(targetResult?.releaseClaimToken ? { releaseClaimToken: targetResult.releaseClaimToken } : {}),
          releaseEvent: releaseReceipt.event ?? null,
        } : {})
        }
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
  } finally {
    if (leaseHeartbeat) await leaseHeartbeat.stop();
    try { await releaseAutomationExecutionLease(repository, leaseState); } catch { /* Best effort only. */ }
  }
}

async function settleDesktopReleaseReceipt(repository, delivery, now, succeeded) {
  const receipt = delivery?.payload;
  const deduplicationKey = receipt?.releaseDeduplicationKey;
  const targetKey = receipt?.releaseTargetKey;
  const event = receipt?.releaseEvent;
  const claimToken = receipt?.releaseClaimToken;
  if (!deduplicationKey || !targetKey) return null;
  if (!succeeded) {
    return releaseDataReleaseTargetClaim({ repository, deduplicationKey, targetKey, event, claimToken, now });
  }
  const aggregate = await acknowledgeDataReleaseTarget({ repository, deduplicationKey, targetKey, event, claimToken, now });
  if (aggregate.complete) {
    await acknowledgeDataReleasePublished({ repository, deduplicationKey, event: aggregate.event ?? event, now });
  }
  return aggregate;
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
    exactTargets: options.exactTargets === true,
    textOnly: options.textOnly === true,
    demoShowcase: options.demoShowcase === true,
    feedbackLoop: options.feedbackLoop,
  });
}

export async function resetAutomationManualReconciliation(ruleId, options = {}) {
  const actor = String(options.actor ?? "").trim();
  const expectedGeneration = String(options.expectedGeneration ?? "").trim();
  if (!actor) throw new Error("AUTOMATION_RECONCILIATION_ACTOR_REQUIRED");
  if (!expectedGeneration) throw new Error("AUTOMATION_RECONCILIATION_GENERATION_REQUIRED");
  if (options.resolution !== "acknowledge-sent") throw new Error("AUTOMATION_RECONCILIATION_RESOLUTION_INVALID");
  // This helper deliberately defaults to deny. A future authenticated server
  // route must provide the authorization closure; caller-supplied identity
  // fields alone never grant reconciliation authority.
  if (typeof options.authorize !== "function"
    || await options.authorize({ actor, ruleId, expectedGeneration, resolution: options.resolution }) !== true) {
    throw new Error("AUTOMATION_RECONCILIATION_AUTHORIZATION_REQUIRED");
  }
  const repository = options.repository ?? await getDistributionRepository();
  const rule = await repository.getRule(ruleId);
  if (!rule || rule.kind !== "automation") throw new Error("自动发布规则不存在");
  const now = new Date(options.now ?? Date.now());
  const stateKey = `${AUTOMATION_EXECUTION_STATE_META_PREFIX}${rule.id}`;
  let state = typeof repository?.getMeta === "function" ? await repository.getMeta(stateKey) : null;
  if (rule.status !== "manual-reconciliation" && state?.status !== "manual-reconciliation") {
    throw new Error("AUTOMATION_RULE_NOT_AWAITING_RECONCILIATION");
  }
  if (state?.generation !== expectedGeneration) throw new Error("AUTOMATION_RECONCILIATION_GENERATION_MISMATCH");
  const leaseState = await acquireAutomationExecutionLease(repository, rule.id, expectedGeneration, now);
  if (leaseState.supported && !leaseState.lease) throw new Error("AUTOMATION_RECONCILIATION_RESET_BUSY");
  try {
    state = typeof repository?.getMeta === "function" ? await repository.getMeta(stateKey) : state;
    if (state?.generation !== expectedGeneration) throw new Error("AUTOMATION_RECONCILIATION_GENERATION_MISMATCH");
    const resetState = {
      ...(state ?? {}),
      status: "success",
      phase: "operator-acknowledged-sent",
      operatorAcknowledgedBy: actor,
      operatorAcknowledgedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + AUTOMATION_EXECUTION_TTL_MS).toISOString()
    };
    if (typeof repository?.compareAndSetMeta === "function") {
      const saved = await repository.compareAndSetMeta(stateKey, {
        generation: expectedGeneration,
        ...(state?.attemptToken ? { attemptToken: state.attemptToken } : {})
      }, resetState);
      if (!saved) throw new Error("AUTOMATION_RECONCILIATION_STATE_CHANGED");
    } else if (typeof repository?.setMeta === "function") {
      await repository.setMeta(stateKey, resetState);
    }
    const recurring = rule.runOnce !== true;
    const savedRule = await repository.saveRule({
      ...rule,
      enabled: recurring,
      status: recurring ? "ready" : "completed",
      nextRunAt: recurring ? computeNextRunAt(rule.schedulePreset, now).toISOString() : null,
      leaseUntil: null
    });
    clearAutomationPersistenceCircuit(repository, rule.id);
    return savedRule;
  } finally {
    try { await releaseAutomationExecutionLease(repository, leaseState); } catch { /* Best effort only. */ }
  }
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
        feedbackLoop: options.feedbackLoop,
      });
    } catch (error) {
      result = { ruleId: rule.id, status: "failed", error: error.message };
    }
    const manualReconciliation = result.status === "manual-reconciliation"
      || result.status === "manual-reconciliation-unpersisted";
    const failed = result.status === "failed"
      || result.status === "partial"
      || result.status === "busy"
      || (rule.runOnce && result.status === "skipped");
    const retryAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    try {
      await repository.saveRule({
        ...rule,
        enabled: manualReconciliation ? false : (rule.runOnce ? failed : rule.enabled),
        status: manualReconciliation ? "manual-reconciliation" : (failed ? "retrying" : (rule.runOnce ? "completed" : "ready")),
        nextRunAt: manualReconciliation ? null : (failed ? retryAt : (rule.runOnce ? null : computeNextRunAt(rule.schedulePreset, now).toISOString())),
        leaseUntil: null
      });
      if (result.status === "manual-reconciliation-unpersisted") {
        if (clearAutomationPersistenceCircuit(repository, rule.id)) {
          result = {
            ...result,
            status: "manual-reconciliation",
            circuitBreakerOpen: false,
            ruleReconciliationPersisted: true,
            rulePersistenceError: null
          };
        }
      }
    } catch (error) {
      result = {
        ...result,
        rulePersistenceError: result.rulePersistenceError ?? error.message,
        schedulerRulePersistenceError: error.message
      };
    }
    results.push(result);
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
    const [sending, pending, failed] = await Promise.all([
      repository.listDeliveries({ status: "sending", limit }),
      repository.listDeliveries({ status: "pending", limit }),
      repository.listDeliveries({ status: "failed", limit })
    ]);
    for (const delivery of failed) {
      if (!isDesktopPublisherTarget(delivery.target, env)) continue;
      await settleDesktopReleaseReceipt(repository, delivery, now, false);
    }
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
    const activeEligible = [];
    for (const candidate of eligible) {
      if (shouldArchiveExpiredDesktopDelivery(candidate.delivery, now, env)) {
        await repository.updateDelivery(candidate.delivery.id, {
          status: "failed",
          attempts: Number(candidate.delivery.attempts ?? 0) + 1,
          error: "发布桥任务已超过安全保留期且没有已完成步骤，已安全归档，避免恢复后补发历史内容。",
          deliveredAt: null,
          publisherVerification: null
        });
        await settleDesktopReleaseReceipt(repository, candidate.delivery, now, false);
        continue;
      }
      activeEligible.push(candidate);
    }
    activeEligible.sort((left, right) => left.priority - right.priority
      || new Date(left.delivery.createdAt || 0).getTime() - new Date(right.delivery.createdAt || 0).getTime());

    for (const { delivery } of activeEligible) {
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
        await settleDesktopReleaseReceipt(repository, claimed, now, false);
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
        topicName: desktopTopicName(event, claimed.target, claimed.ruleId),
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
    await settleDesktopReleaseReceipt(repository, delivery, now, true);
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
    const expectedTopicName = desktopPublisherDisplayValue(desktopTopicName(event, delivery.target, delivery.ruleId));
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
  await settleDesktopReleaseReceipt(repository, { ...delivery, ...updated }, now, finalStatus === "success");
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
