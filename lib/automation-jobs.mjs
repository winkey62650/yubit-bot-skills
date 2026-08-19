import { createHash, randomUUID } from "node:crypto";
import { readJson, writeJson } from "./json-store.js";
import { getDistributionRepository } from "./distribution-repository.mjs";
import { createTelegramDelivery } from "./telegram-delivery.mjs";
import { telegramDeliveryEnvironment } from "./telegram-delivery-settings.mjs";
import { telegramMtprotoCall } from "./telegram-mtproto.mjs";
import { sendDiscordMessage } from "./discord-service.mjs";
import { renderTelegramMarkdownHtml } from "./manual-cta.mjs";
import {
  fetchCryptoDailyCandidates,
  fetchMarketReaction,
  fetchTradingViewCalendar
} from "./market-content-sources.mjs";
import {
  MARKET_CONTENT_TEMPLATE_VERSION,
  buildCryptoDailyDocument,
  buildDataReleaseDocument,
  buildWeeklyCalendarDocument,
  renderDiscordMarketDocument,
  renderTelegramMarketDocument
} from "./market-content-templates.mjs";
import {
  acknowledgeDataReleasePublished,
  acknowledgeDataReleaseTarget,
  buildDataReleaseTargetKey,
  cacheWeeklyCalendar,
  clearDataReleaseSend,
  completeDataReleaseSend,
  getDataReleaseSendMarker,
  markDataReleaseTargetPending,
  pollDataReleaseUpdates,
  prepareDataReleaseDelivery,
  prepareDataReleaseSend,
  releaseDataReleaseTargetClaim,
  withDataReleaseRunLease
} from "./data-release-monitor.mjs";
import {
  EDITORIAL_TEMPLATE_VERSION,
  marketStoryIndex,
  renderDailyAnalysisText,
  renderMarketEventsText,
  renderWhaleSignalText
} from "./editorial-template-contract.mjs";
import {
  normalizeSocialPackages,
  parseSocialFeed,
  parseXReaderTimeline,
  parseXSyndicationTimeline,
  parseXProfileTimeline,
  socialContentSnapshot,
  socialFetchPlan,
  socialUsername,
  validateSocialSnapshotOwnership
} from "./social-sources.mjs";

const statePath = "automation-state.json";
const runsPath = "automation-runs.json";
const socialStatePath = "social-crawl-state.json";
const fallbackAppBaseUrl = "https://yubit-bot-skills-academy.vercel.app";
const marketCardTemplateVersion = "market-card-v4";
const MARKET_DOCUMENT_JOBS = new Set(["crypto-daily", "weekly-calendar", "data-release-updates"]);
const FIXED_EDITORIAL_JOBS = new Set(["daily-analysis", "whale-hourly"]);
const DATA_RELEASE_RUN_LOCKED = Symbol("data-release-run-locked");
const DATA_RELEASE_LEASE_GUARD = Symbol("data-release-lease-guard");

async function acknowledgeReleaseTargetWithRetry(options) {
  const { assertLeaseOwned, ...receiptOptions } = options;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await assertLeaseOwned?.();
      return await acknowledgeDataReleaseTarget(receiptOptions);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function ctaFields(target = {}) {
  const hasUnifiedContent = Object.prototype.hasOwnProperty.call(target, "ctaContent");
  const ctaContent = hasUnifiedContent ? String(target.ctaContent || "").trim() : "";
  const ctaText = String(target?.ctaText || "").trim();
  const ctaUrl = String(target?.ctaUrl || "").trim();
  const rawEnabled = target?.ctaEnabled;
  const ctaEnabled = rawEnabled === true || (rawEnabled !== false && Boolean(ctaContent || ctaText || ctaUrl));
  return hasUnifiedContent ? { ctaEnabled, ctaContent } : { ctaEnabled, ctaText, ctaUrl };
}

function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function targetCtaBlock(target, { html = false } = {}) {
  if (!target?.ctaEnabled) return "";
  if (Object.prototype.hasOwnProperty.call(target, "ctaContent")) {
    const content = String(target.ctaContent || "").trim();
    return html ? renderTelegramMarkdownHtml(content) : content;
  }
  const text = String(target.ctaText || "").trim();
  const url = String(target.ctaUrl || "").trim();
  if (!text && !url) return "";
  const lines = [];
  if (text) lines.push(html ? `<b>${htmlEscape(text)}</b>` : `**${text}**`);
  if (url) lines.push(html ? htmlEscape(url) : url);
  return lines.join("\n");
}

function truncateContentBody(value, limit) {
  const text = String(value || "").trim();
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text;
  if (limit === 1) return "…";
  const prefix = text.slice(0, limit - 1);
  const paragraphBoundary = prefix.lastIndexOf("\n\n");
  const lineBoundary = prefix.lastIndexOf("\n");
  const boundary = paragraphBoundary >= Math.floor(limit * 0.35)
    ? paragraphBoundary
    : lineBoundary >= Math.floor(limit * 0.7)
      ? lineBoundary
      : prefix.length;
  return `${prefix.slice(0, boundary).trimEnd()}…`;
}

function appendTargetCta(value, target, options = {}) {
  const text = String(value || "").trim();
  const cta = targetCtaBlock(target, options);
  const limit = Number(options.limit);
  if (!cta) return truncateContentBody(text, limit);
  if (!Number.isFinite(limit) || limit <= 0) return text ? `${text}\n\n${cta}` : cta;
  if (cta.length >= limit) return cta.slice(0, limit);
  const bodyLimit = limit - cta.length - 2;
  const body = truncateContentBody(text, bodyLimit);
  return body ? `${body}\n\n${cta}` : cta;
}

export const AUTOMATION_JOBS = [
  { id: "crypto-daily", name: "Crypto Daily", schedule: "每日 08:00 UTC", cron: "0 8 * * *", topic: "7. YUBIT Updates", bot: "SpeakerBot", content: "每日三条重点新闻" },
  { id: "weekly-calendar", name: "Crypto & Macro Calendar", schedule: "每周一 00:30 UTC", cron: "30 0 * * 1", topic: "3. Market Events", bot: "SpeakerBot", content: "每周数据日历" },
  { id: "data-release-updates", name: "Data Release Updates", schedule: "每分钟检查重点数据发布", cron: "* * * * *", topic: "3. Market Events", bot: "SpeakerBot", content: "Actual / Forecast / Previous 与市场影响" },
  { id: "daily-analysis", name: "Daily Analysis", schedule: "每日 08:00 UTC", cron: "0 8 * * *", topic: "4. Market Analysis - Crypto/Stocks/TradFi", bot: "SpeakerBot", content: "图文分析" },
  { id: "whale-hourly", name: "大户挂单 & 巨鲸数据", schedule: "每小时检查，重大异动才发布", cron: "0 * * * *", topic: "6. Smart Money Tracker", bot: "SpeakerBot", content: "英文异动图文" },
  { id: "agent-sync-4h", name: "代理群信息更新", schedule: "每小时", cron: "15 * * * *", topic: "2. CryptoGuy Trading Zone", bot: "SpeakerBot", content: "有更新时发布" }
];

export function automationSlot(jobId, date = new Date()) {
  const iso = date.toISOString();
  if (jobId === "weekly-calendar") return isoWeekSlot(date);
  if (jobId === "data-release-updates") return iso.slice(0, 16);
  if (jobId === "crypto-daily" || jobId === "daily-analysis") return iso.slice(0, 10);
  if (jobId === "whale-hourly") return iso.slice(0, 13);
  if (jobId === "agent-sync-4h") return iso.slice(0, 13);
  const hour = Math.floor(date.getUTCHours() / 4) * 4;
  return `${iso.slice(0, 10)}T${String(hour).padStart(2, "0")}`;
}

function isoWeekSlot(date) {
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((thursday - yearStart) / 86_400_000) + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export async function getAutomationStatus() {
  const [state, runs, rules] = await Promise.all([
    readJson(statePath, {}),
    readJson(runsPath, []),
    getDistributionRepository().then((repository) => repository.listRules("automation")).catch(() => [])
  ]);
  const targets = await Promise.all(AUTOMATION_JOBS.map(async (job) => {
    const current = distributionTargetsForJob(job, rules);
    return current.configured ? current : resolveTarget(job);
  }));
  return AUTOMATION_JOBS.map((job, index) => ({
    ...job,
    target: targets[index],
    lastRun: state[job.id] || null,
    recentRuns: runs.filter((run) => run.jobId === job.id).slice(0, 5)
  }));
}

const JOB_CONTENT_TYPES = Object.freeze({
  "crypto-daily": "crypto-daily",
  "weekly-calendar": "weekly-calendar",
  "data-release-updates": "data-release-updates",
  "daily-analysis": "daily-analysis",
  "whale-hourly": "whale-signals",
  "agent-sync-4h": "agent-sync"
});

export function distributionTargetsForJob(job, rules = []) {
  const contentType = JOB_CONTENT_TYPES[job?.id];
  const matchingRules = (Array.isArray(rules) ? rules : [])
    .filter((rule) => rule?.kind === "automation" && rule?.contentType === contentType);
  const seen = new Set();
  const targets = matchingRules.flatMap((rule) => (rule.targets || []).map((target) => {
    const discord = target.platform === "discord" || (target.guildId && target.channelId);
    return discord ? {
      platform: "discord",
      guildId: String(target.guildId || ""),
      channelId: String(target.channelId || ""),
      group: target.groupName || target.group || target.guildId,
      topic: target.topicName || target.topic || target.channelId,
      ruleId: rule.id,
      enabled: rule.enabled !== false,
      ...ctaFields(target)
    } : {
      platform: "telegram",
      chatId: target.chatId,
      chatType: target.chatType === "channel" ? "channel" : "supergroup",
      threadId: target.threadId,
      group: target.groupName || target.group || target.chatId,
      topic: target.topicName || target.topic || job?.topic,
      ruleId: rule.id,
      enabled: rule.enabled !== false,
      ...ctaFields(target)
    };
  })).filter((target) => {
    const key = automationDestinationKey(target);
    if (!isAutomationDestination(target) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const first = targets[0] || {};
  return {
    platform: first.platform || null,
    chatId: first.chatId || null,
    chatType: first.chatType || null,
    threadId: first.threadId ?? null,
    guildId: first.guildId || null,
    channelId: first.channelId || null,
    group: first.group || null,
    topic: first.topic || job?.topic,
    configured: targets.length > 0,
    enabled: matchingRules.some((rule) => rule.enabled !== false),
    count: targets.length,
    targets,
    source: targets.length ? "distribution-database" : null
  };
}

export function isAutomationDestination(target) {
  return isDiscordDestination(target) || isTelegramDestination(target);
}

export function isDiscordDestination(target) {
  return target?.platform === "discord"
    && Boolean(String(target?.guildId || "").trim())
    && Boolean(String(target?.channelId || "").trim());
}

export function isTelegramDestination(target) {
  if (target?.platform === "discord") return false;
  if (!target?.chatId) return false;
  if (target.chatType === "channel") return true;
  const resolvedThreadId = Number(target.threadId);
  return Number.isInteger(resolvedThreadId) && resolvedThreadId > 0;
}

export function telegramDestinationPayload(target) {
  const payload = { chat_id: target.chatId };
  const resolvedThreadId = Number(target.threadId);
  if (Number.isInteger(resolvedThreadId) && resolvedThreadId > 0) {
    payload.message_thread_id = resolvedThreadId;
  }
  return payload;
}

export async function runAutomationJob(jobId, options = {}) {
  options.signal?.throwIfAborted?.();
  const job = AUTOMATION_JOBS.find((item) => item.id === jobId);
  if (!job) throw new Error(`Unknown automation job: ${jobId}`);
  if (jobId === "data-release-updates" && !options[DATA_RELEASE_RUN_LOCKED]) {
    const lockRepository = options.repository || await getDistributionRepository();
    return withDataReleaseRunLease({
      repository: lockRepository,
      now: options.now,
      leaseTtlMs: options.releaseLeaseTtlMs,
      heartbeatMs: options.releaseLeaseHeartbeatMs,
      clock: options.releaseLeaseClock,
      operation: ({ assertOwned }) => runAutomationJob(jobId, {
        ...options,
        repository: lockRepository,
        [DATA_RELEASE_RUN_LOCKED]: true,
        [DATA_RELEASE_LEASE_GUARD]: assertOwned,
      })
    });
  }
  const dryRun = options.dryRun !== false;
  const force = options.force === true;
  const now = options.now ? new Date(options.now) : new Date();
  const slot = automationSlot(jobId, now);
  const stateKey = options.stateKey || jobId;
  const state = await readJson(statePath, {});

  if (!dryRun && !force && state[stateKey]?.slot === slot) {
    return logRun({ job, slot, dryRun, status: "duplicate", message: "当前时间窗口已执行，已阻止重复发送。", target: state[stateKey].target || null });
  }

  try {
    const targets = Array.isArray(options.targets) && options.targets.length
      ? options.targets
      : [await resolveTarget(job)].filter(Boolean);
    const target = targets[0] || null;
    const generated = await buildContent(jobId, now, {
      persist: !dryRun,
      repository: options.repository,
      fetchImpl: options.fetchImpl,
      fetchReaction: options.fetchReaction
    });
    const imageUrl = generated.imageKind
      ? buildCardUrl(generated.imageKind, generated.metrics, generated.poster, {
        baseUrl: options.publicBaseUrl,
        cacheKey: generated.contentHash,
      })
      : null;
    const preview = { ...generated, ...automationTemplateMetadata(jobId), imageUrl, target };

    if (MARKET_DOCUMENT_JOBS.has(jobId) && generated.publishable !== true) {
      return logRun({
        job,
        slot,
        dryRun,
        status: "skipped",
        message: `未发布：${generated.skipReason}`,
        target,
        preview
      });
    }

    if (dryRun) {
      return logRun({ job, slot, dryRun, status: "success", message: "Dry-run 通过：数据、文案、图片与目标解析正常，未向外部平台发送。", target, preview });
    }

    if (jobId === "whale-hourly" && shouldSuppressWhaleSignal(generated, { force })) {
      return logRun({ job, slot, dryRun, status: "skipped", message: generated.suppressionReason || "本轮没有达到发布标准的巨鲸或大户挂单异动。", target, preview });
    }

    if (jobId === "whale-hourly" && generated.contentHash && state[stateKey]?.contentHash === generated.contentHash) {
      const previousAt = Date.parse(state[stateKey]?.at || "");
      const cooldownMs = Math.max(1, Number(process.env.WHALE_COOLDOWN_HOURS || 6)) * 60 * 60 * 1000;
      if (Number.isFinite(previousAt) && now.getTime() - previousAt < cooldownMs) {
        return logRun({ job, slot, dryRun, status: "duplicate", message: "同一巨鲸信号仍在冷却期内，已阻止重复发布。", target, preview });
      }
    }

    if (jobId === "agent-sync-4h") {
      const sourceHealth = evaluateAgentSyncHealth(generated.items || [], (generated.updates || []).length);
      const sendResult = await sendAgentUpdates(generated.updates || [], options.targets, {
        deferDelivery: options.deferDelivery === true,
        now,
        signal: options.signal,
        telegramSender: options.telegramSender,
        discordSender: options.discordSender,
        fetchImpl: options.fetchImpl,
        env: options.env
      });
      const status = sendResult.status === "queued"
        ? "queued"
        : sendResult.status === "partial" || sourceHealth.status === "partial"
          ? "partial"
          : sourceHealth.status === "failed"
            ? "failed"
            : sendResult.status;
      const next = {
        slot,
        at: now.toISOString(),
        status,
        target: sendResult.targets,
        sent: sendResult.sent,
        targetResults: sendResult.targetResults,
        sourceHealth,
        checks: generated.items || []
      };
      state[stateKey] = next;
      await writeJson(statePath, state);
      const message = status === "queued"
        ? `代理更新已排队，等待发布账号发送至 ${sendResult.targets.length} 个目标。`
        : sendResult.sent
          ? sourceHealth.status === "success"
            ? `已发送 ${sendResult.sent} 条代理更新。`
            : `已发送 ${sendResult.sent} 条代理更新，但部分来源检查失败。`
          : sourceHealth.message;
      return logRun({ job, slot, dryRun, status, message, target: sendResult.targets, preview: { ...preview, deliveryPlans: sendResult.deliveryPlans, targetResults: sendResult.targetResults, sourceHealth, checks: generated.items || [] } });
    }

    const configuredTargets = targets.filter(isAutomationDestination);
    if (!configuredTargets.length) {
      return logRun({ job, slot, dryRun, status: "skipped", message: `未找到 ${job.topic} 的群/Topic 绑定，未发送。`, target, preview });
    }
    let telegramTargets = configuredTargets.filter(isTelegramDestination);
    let discordTargets = configuredTargets.filter(isDiscordDestination);
    let releaseReceipt = null;
    const uncertainTargetKeys = new Set();
    const assertReleaseLeaseOwned = options[DATA_RELEASE_LEASE_GUARD] ?? (async () => true);
    if (jobId === "data-release-updates") {
      releaseReceipt = await prepareDataReleaseDelivery({
        repository: options.repository,
        deduplicationKey: generated.deduplicationKey,
        event: generated.event,
        targetKeys: configuredTargets.map(buildDataReleaseTargetKey),
        now
      });
      for (const item of configuredTargets) {
        const targetKey = buildDataReleaseTargetKey(item);
        const marker = await getDataReleaseSendMarker({
          repository: options.repository,
          deduplicationKey: generated.deduplicationKey,
          targetKey,
          now,
        });
        if (!marker) continue;
        if (marker.status !== "sent") {
          uncertainTargetKeys.add(targetKey);
          continue;
        }
        try {
          await acknowledgeReleaseTargetWithRetry({
            repository: options.repository,
            deduplicationKey: generated.deduplicationKey,
            targetKey,
            event: generated.event,
            now,
            assertLeaseOwned: assertReleaseLeaseOwned,
          });
          await clearDataReleaseSend({ repository: options.repository, deduplicationKey: generated.deduplicationKey, targetKey, now });
        } catch (error) {
          // The external send has already happened. Keep the durable send marker so a
          // later run can finalize the receipt without sending the target again.
          if (String(error?.message || "").startsWith("DATA_RELEASE_LEASE_LOST:")) throw error;
        }
      }
      releaseReceipt = await prepareDataReleaseDelivery({
        repository: options.repository,
        deduplicationKey: generated.deduplicationKey,
        event: generated.event,
        targetKeys: configuredTargets.map(buildDataReleaseTargetKey),
        now
      });
      const ready = new Set(releaseReceipt.readyTargetKeys);
      telegramTargets = telegramTargets.filter((item) => ready.has(buildDataReleaseTargetKey(item)));
      discordTargets = discordTargets.filter((item) => ready.has(buildDataReleaseTargetKey(item)));
    }
    const deliveryPlans = [
      ...buildAutomationTelegramPlans(jobId, generated, telegramTargets, imageUrl),
      ...buildAutomationDiscordPlans(jobId, generated, discordTargets, imageUrl)
    ];
    const targetResults = [];
    if (jobId === "data-release-updates") {
      for (const item of configuredTargets) {
        const releaseTargetKey = buildDataReleaseTargetKey(item);
        if (!uncertainTargetKeys.has(releaseTargetKey)) continue;
        targetResults.push({
          target: item,
          status: "pending",
          messageId: null,
          messageIds: [],
          receiptExisting: true,
          releaseTargetKey,
          deliveryState: "uncertain-delivery",
          manualReconciliationRequired: true,
          error: "uncertain-delivery: manual-reconciliation required",
        });
      }
    }
    const token = tokenForBot(job.bot);
    for (const item of telegramTargets) {
      if (options.deferDelivery === true) {
        const releaseClaimToken = jobId === "data-release-updates" ? randomUUID() : null;
        if (jobId === "data-release-updates") await markDataReleaseTargetPending({ repository: options.repository, deduplicationKey: generated.deduplicationKey, targetKey: buildDataReleaseTargetKey(item), event: generated.event, claimToken: releaseClaimToken, now });
        targetResults.push({ target: item, status: "pending", messageId: null, messageIds: [], releaseTargetKey: buildDataReleaseTargetKey(item), ...(releaseClaimToken ? { releaseClaimToken } : {}) });
        continue;
      }
      if (!token && !options.telegramSender) {
        targetResults.push({ target: item, status: "failed", messageId: null, messageIds: [], error: `${job.bot} Token 未配置` });
        continue;
      }
      const messageIds = [];
      const releaseTargetKey = buildDataReleaseTargetKey(item);
      if (jobId === "data-release-updates") {
        await assertReleaseLeaseOwned();
        await markDataReleaseTargetPending({ repository: options.repository, deduplicationKey: generated.deduplicationKey, targetKey: releaseTargetKey, event: generated.event, now });
        await prepareDataReleaseSend({ repository: options.repository, deduplicationKey: generated.deduplicationKey, targetKey: releaseTargetKey, now });
      }
      let durableSendCompleted = false;
      let attemptStarted = false;
      try {
        const plan = deliveryPlans.find((entry) => entry.target === item)?.steps ?? [];
        for (const step of plan) {
          if (jobId === "data-release-updates") await assertReleaseLeaseOwned();
          const sender = options.telegramSender || telegramCall;
          attemptStarted = true;
          options.signal?.throwIfAborted?.();
          const sent = options.telegramSender
            ? await sender(token, step.method, step.payload, { signal: options.signal })
            : await telegramCall(token, step.method, step.payload, fetch, { signal: options.signal });
          if (sent.message_id) messageIds.push(sent.message_id);
        }
        if (jobId === "data-release-updates") {
          await completeDataReleaseSend({ repository: options.repository, deduplicationKey: generated.deduplicationKey, targetKey: releaseTargetKey, messageIds, now });
          durableSendCompleted = true;
          await acknowledgeReleaseTargetWithRetry({ repository: options.repository, deduplicationKey: generated.deduplicationKey, targetKey: releaseTargetKey, event: generated.event, now, assertLeaseOwned: assertReleaseLeaseOwned });
          await clearDataReleaseSend({ repository: options.repository, deduplicationKey: generated.deduplicationKey, targetKey: releaseTargetKey, now });
        }
        targetResults.push({ target: item, status: "success", messageId: messageIds[0] || null, messageIds, releaseTargetKey });
      } catch (error) {
        if (jobId === "data-release-updates" && !attemptStarted && messageIds.length === 0) {
          await clearDataReleaseSend({ repository: options.repository, deduplicationKey: generated.deduplicationKey, targetKey: releaseTargetKey, now });
          await releaseDataReleaseTargetClaim({ repository: options.repository, deduplicationKey: generated.deduplicationKey, targetKey: releaseTargetKey, event: generated.event, now });
        }
        const uncertainDelivery = jobId === "data-release-updates" && attemptStarted && !durableSendCompleted;
        targetResults.push({
          target: item,
          status: jobId === "data-release-updates" && (attemptStarted || messageIds.length) ? "pending" : "failed",
          messageId: messageIds[0] || null,
          messageIds,
          error: error.message,
          ...(jobId === "data-release-updates" && durableSendCompleted
            ? { receiptFinalizationPending: true, releaseTargetKey }
            : uncertainDelivery
              ? { receiptExisting: true, releaseTargetKey, deliveryState: "uncertain-delivery", manualReconciliationRequired: true }
              : {})
        });
      }
    }
    for (const item of discordTargets) {
      const messageIds = [];
      const releaseTargetKey = buildDataReleaseTargetKey(item);
      if (jobId === "data-release-updates") {
        await assertReleaseLeaseOwned();
        await markDataReleaseTargetPending({ repository: options.repository, deduplicationKey: generated.deduplicationKey, targetKey: releaseTargetKey, event: generated.event, now });
        await prepareDataReleaseSend({ repository: options.repository, deduplicationKey: generated.deduplicationKey, targetKey: releaseTargetKey, now });
      }
      let durableSendCompleted = false;
      let attemptStarted = false;
      try {
        const plan = deliveryPlans.find((entry) => entry.target === item)?.steps ?? [];
        for (const step of plan) {
          if (jobId === "data-release-updates") await assertReleaseLeaseOwned();
          const sender = options.discordSender || sendDiscordMessage;
          attemptStarted = true;
          options.signal?.throwIfAborted?.();
          const sent = await sender(item.channelId, step.payload, { signal: options.signal });
          if (sent?.id) messageIds.push(sent.id);
        }
        if (jobId === "data-release-updates") {
          await completeDataReleaseSend({ repository: options.repository, deduplicationKey: generated.deduplicationKey, targetKey: releaseTargetKey, messageIds, now });
          durableSendCompleted = true;
          await acknowledgeReleaseTargetWithRetry({ repository: options.repository, deduplicationKey: generated.deduplicationKey, targetKey: releaseTargetKey, event: generated.event, now, assertLeaseOwned: assertReleaseLeaseOwned });
          await clearDataReleaseSend({ repository: options.repository, deduplicationKey: generated.deduplicationKey, targetKey: releaseTargetKey, now });
        }
        targetResults.push({ target: item, status: "success", messageId: messageIds[0] || null, messageIds, releaseTargetKey });
      } catch (error) {
        if (jobId === "data-release-updates" && !attemptStarted && messageIds.length === 0) {
          await clearDataReleaseSend({ repository: options.repository, deduplicationKey: generated.deduplicationKey, targetKey: releaseTargetKey, now });
          await releaseDataReleaseTargetClaim({ repository: options.repository, deduplicationKey: generated.deduplicationKey, targetKey: releaseTargetKey, event: generated.event, now });
        }
        const uncertainDelivery = jobId === "data-release-updates" && attemptStarted && !durableSendCompleted;
        targetResults.push({
          target: item,
          status: jobId === "data-release-updates" && (attemptStarted || messageIds.length) ? "pending" : "failed",
          messageId: messageIds[0] || null,
          messageIds,
          error: error.message,
          ...(jobId === "data-release-updates" && durableSendCompleted
            ? { receiptFinalizationPending: true, releaseTargetKey }
            : uncertainDelivery
              ? { receiptExisting: true, releaseTargetKey, deliveryState: "uncertain-delivery", manualReconciliationRequired: true }
              : {})
        });
      }
    }
    if (jobId === "data-release-updates") {
      releaseReceipt = await prepareDataReleaseDelivery({ repository: options.repository, deduplicationKey: generated.deduplicationKey, event: generated.event, targetKeys: configuredTargets.map(buildDataReleaseTargetKey), now });
      for (const item of configuredTargets) {
        const key = buildDataReleaseTargetKey(item);
        if (!targetResults.some((row) => buildDataReleaseTargetKey(row.target) === key)) {
          const existingStatus = releaseReceipt.successfulTargetKeys.includes(key) ? "success" : "pending";
          targetResults.push({ target: item, status: existingStatus, messageId: null, messageIds: [], receiptExisting: true, releaseTargetKey: key });
        }
      }
    }
    const succeeded = targetResults.filter((item) => item.status === "success").length;
    const pending = targetResults.filter((item) => item.status === "pending").length;
    const failed = targetResults.filter((item) => item.status === "failed").length;
    const uncertain = targetResults.some((item) => item.deliveryState === "uncertain-delivery");
    const status = uncertain ? "manual-reconciliation" : failed ? (succeeded || pending ? "partial" : "failed") : pending ? "queued" : "success";
    if (jobId === "data-release-updates" && releaseReceipt?.complete) {
      await assertReleaseLeaseOwned();
      await acknowledgeDataReleasePublished({
        repository: options.repository,
        deduplicationKey: generated.deduplicationKey,
        event: releaseReceipt.event ?? generated.event,
        now
      });
    }
    state[stateKey] = { slot, at: now.toISOString(), contentHash: generated.contentHash || null, status, targets: configuredTargets, targetResults };
    await writeJson(statePath, state);
    const message = uncertain
      ? "uncertain-delivery: 已停止自动重试，需要 manual-reconciliation 核对外部平台投递结果。"
      : `内容已发送至 ${succeeded}/${targetResults.length} 个目标${pending ? `，${pending} 个 Telegram 目标等待本机发布桥` : ""}。`;
    return logRun({ job, slot, dryRun, status, message, target: configuredTargets, preview: { ...preview, deliveryPlans, targetResults, ...(releaseReceipt ? { deliveryReceipt: releaseReceipt } : {}) } });
  } catch (error) {
    await logRun({ job, slot, dryRun, status: "failed", message: error.message });
    throw error;
  }
}

export async function buildContent(jobId, now, options = {}) {
  if (jobId === "crypto-daily") return buildCryptoDailyContent(now, options);
  if (jobId === "weekly-calendar") return buildWeeklyCalendarContent(now, options);
  if (jobId === "data-release-updates") return buildDataReleaseContent(now, options);
  if (jobId === "daily-analysis") return buildDailyAnalysis(now);
  if (jobId === "whale-hourly") return buildWhaleHourly(now);
  return buildAgentUpdates(now, options);
}

function marketDiagnostics(templateId, document, result, now) {
  const sources = Array.isArray(result.sources) ? result.sources : [];
  const conflicts = Array.isArray(result.conflicts)
    ? result.conflicts
    : result.conflict ? [result.conflict] : [];
  if (templateId === "crypto-daily") {
    const sections = Array.isArray(document?.sections) ? document.sections : [];
    return {
      candidates: Array.isArray(result.candidates) ? result.candidates : [],
      selected: sections.filter((section) => Boolean(String(section?.storyId || "").trim())),
      missing: sections.filter((section) => !String(section?.storyId || "").trim()),
      conflicts,
      nextMonitoredEvent: result.nextMonitoredEvent ?? null,
      sources
    };
  }
  if (templateId === "weekly-calendar") {
    const candidates = Array.isArray(result.events) ? result.events : [];
    const selected = (Array.isArray(document?.days) ? document.days : [])
      .flatMap((day) => (Array.isArray(day?.events) ? day.events : []).map((event) => ({
        ...event,
        date: day?.date ?? null,
        scheduledAt: /^\d{2}:\d{2}$/.test(String(event?.time || "")) && day?.date
          ? `${day.date}T${event.time}:00.000Z`
          : null
      })));
    return {
      candidates,
      selected,
      missing: [],
      conflicts,
      nextMonitoredEvent: selected.find((event) => {
        const scheduledAt = Date.parse(event?.scheduledAt || "");
        return Number.isFinite(scheduledAt) && scheduledAt >= now.getTime();
      }) ?? null,
      sources
    };
  }
  const event = result.event ?? null;
  const nextMonitoredEvent = result.nextMonitoredEvent ?? null;
  const conflictCandidates = conflicts.flatMap((conflict) => (
    Array.isArray(conflict?.events) ? conflict.events : []
  ));
  const candidates = result.publishable === true && event
    ? [event]
    : conflictCandidates.length ? conflictCandidates : nextMonitoredEvent ? [nextMonitoredEvent] : event ? [event] : [];
  return {
    candidates,
    selected: result.publishable === true && event ? [event] : [],
    missing: result.publishable !== true && !conflicts.length && candidates.length ? candidates : [],
    conflicts,
    nextMonitoredEvent,
    sources
  };
}

function marketDocumentSelectionCount(templateId, document) {
  if (templateId === "crypto-daily") {
    return (Array.isArray(document?.sections) ? document.sections : [])
      .filter((section) => Boolean(String(section?.storyId || "").trim())).length;
  }
  if (templateId === "weekly-calendar") {
    return (Array.isArray(document?.days) ? document.days : [])
      .reduce((count, day) => count + (Array.isArray(day?.events) ? day.events.length : 0), 0);
  }
  return 0;
}

function marketPublishability(templateId, document, result) {
  if (marketDocumentSelectionCount(templateId, document) > 0) return { publishable: true };
  const sources = Array.isArray(result?.sources) ? result.sources : [];
  const candidates = templateId === "weekly-calendar" ? result?.events : result?.candidates;
  const noReliableCandidates = !Array.isArray(candidates) || candidates.length === 0;
  const sourcesUnavailable = sources.length === 0 || sources.every((source) => {
    const status = String(source?.status || "").trim().toLowerCase();
    return status === "error" || status === "timeout";
  });
  return {
    publishable: false,
    skipReason: sourcesUnavailable && noReliableCandidates
      ? "sources-unavailable"
      : "no-publishable-content"
  };
}

function marketEnvelope(templateId, document, now, result = {}) {
  const diagnostics = marketDiagnostics(templateId, document, result, now);
  return {
    templateId,
    document: document || null,
    sources: Array.isArray(result.sources) ? result.sources : [],
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    deduplicationKey: result.deduplicationKey ?? null,
    publishable: result.publishable === true,
    generatedAt: now.toISOString(),
    diagnostics,
    ...(result.event ? { event: result.event } : {}),
    ...(result.conflict ? { conflict: result.conflict } : {}),
    ...(result.nextMonitoredEvent !== undefined ? { nextMonitoredEvent: result.nextMonitoredEvent } : {}),
    ...(result.skipReason ? { skipReason: result.skipReason } : {})
  };
}

async function buildCryptoDailyContent(now, { fetchImpl = fetch } = {}) {
  const result = await fetchCryptoDailyCandidates({ now, fetchImpl });
  const document = buildCryptoDailyDocument({ now, candidates: result.candidates });
  const publishability = marketPublishability("crypto-daily", document, result);
  return marketEnvelope("crypto-daily", document, now, {
    ...result,
    ...publishability,
    deduplicationKey: JSON.stringify(["crypto-daily", now.toISOString().slice(0, 10)])
  });
}

function utcWeekRange(now) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() === 0 ? 6 : start.getUTCDay() - 1));
  return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
}

function hasReliableMarketSource(result) {
  return (Array.isArray(result?.sources) ? result.sources : [])
    .some((source) => String(source?.status || "").trim().toLowerCase() === "ok");
}

async function buildWeeklyCalendarContent(now, {
  fetchImpl = fetch,
  fetchCalendar = fetchTradingViewCalendar,
  repository,
  persist = false
} = {}) {
  const range = utcWeekRange(now);
  const result = await fetchCalendar({ from: range.start, to: range.end, now, fetchImpl });
  const document = buildWeeklyCalendarDocument({ now, events: result.events });
  if (persist === true && hasReliableMarketSource(result)) {
    const resolvedRepository = repository || await getDistributionRepository();
    await cacheWeeklyCalendar(resolvedRepository, {
      calendarWeek: document.weekStart,
      events: result.events,
      sources: result.sources,
      updatedAt: now.toISOString()
    }, { persist: true });
  }
  const publishability = marketPublishability("weekly-calendar", document, result);
  return marketEnvelope("weekly-calendar", document, now, {
    ...result,
    ...publishability,
    deduplicationKey: JSON.stringify(["weekly-calendar", document.weekStart])
  });
}

async function buildDataReleaseContent(now, {
  fetchImpl = fetch,
  fetchReaction: fetchReactionImpl = fetchMarketReaction,
  repository,
  persist = false
} = {}) {
  const resolvedRepository = repository || await getDistributionRepository();
  const result = await pollDataReleaseUpdates({
    now,
    repository: resolvedRepository,
    persist: persist === true,
    fetchCalendar: ({ from, to, now: checkedAt }) => fetchTradingViewCalendar({ from, to, now: checkedAt, fetchImpl }),
    fetchReaction: ({ event, now: checkedAt }) => fetchReactionImpl({
      beforeAt: event.scheduledAt,
      now: checkedAt,
      fetchImpl,
      event
    })
  });
  const document = result.publishable
    ? buildDataReleaseDocument({ event: result.event, reaction: result.reaction })
    : null;
  const reactionSources = Array.isArray(result.reaction?.sources) ? result.reaction.sources : [];
  const reactionWarnings = Array.isArray(result.reaction?.warnings) ? result.reaction.warnings : [];
  return marketEnvelope("data-release-updates", document, now, {
    ...result,
    sources: [...(result.sources || []), ...reactionSources],
    warnings: [...(result.warnings || []), ...reactionWarnings]
  });
}

async function buildNewsFeed(now) {
  const sourceUrl = process.env.NEWS_RSS_URL || "https://cointelegraph.com/rss";
  const response = await fetchWithTimeout(sourceUrl, { headers: { "user-agent": "YUBITBot/1.0" } });
  if (!response.ok) throw new Error(`News feed returned HTTP ${response.status}`);
  const xml = await response.text();
  const items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].slice(0, Number(process.env.NEWS_LIMIT || 4)).map((match) => {
    const block = match[0];
    return {
      title: decodeXml(readXmlTag(block, "title")),
      link: decodeXml(readXmlTag(block, "link")).trim(),
      publishedAt: decodeXml(readXmlTag(block, "pubDate"))
    };
  }).filter((item) => item.title && item.link);
  if (!items.length) throw new Error("News feed did not return readable items");
  const contentHash = createHash("sha256").update(items.map((item) => `${item.link}\n${item.title}`).join("\n")).digest("hex");
  const lines = items.map((item, index) => `${index + 1}. <a href="${escapeHtml(item.link)}">${escapeHtml(item.title)}</a>`);
  return {
    imageKind: "news",
    metrics: ["MARKET HEADLINES", "SOURCE-LINKED"],
    caption: `<b>📰 Crypto News Update</b>\n\n${lines.join("\n\n")}\n\n<i>Source feed · Links and content hash are deduplicated.</i>`,
    items,
    contentHash
  };
}

function readXmlTag(block, tag) {
  return block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1]?.replace(/^<!\[CDATA\[|\]\]>$/g, "") || "";
}

function decodeXml(value) {
  return decodeEntities(String(value).replaceAll("&#8211;", "–").replaceAll("&#8212;", "—").replaceAll("&#039;", "'"));
}

async function buildDailyEvents(now) {
  const day = now.toISOString().slice(0, 10);
  let payload;
  if (process.env.DAILY_EVENTS_API_URL) {
    const headers = { accept: "application/json" };
    if (process.env.DAILY_EVENTS_API_TOKEN) {
      headers.authorization = `Bearer ${process.env.DAILY_EVENTS_API_TOKEN}`;
      headers["x-api-key"] = process.env.DAILY_EVENTS_API_TOKEN;
    }
    payload = await fetchJson(process.env.DAILY_EVENTS_API_URL, { headers });
  } else {
    const from = `${day}T00:00:00.000Z`;
    const to = `${day}T23:59:59.999Z`;
    const url = `https://economic-calendar.tradingview.com/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&countries=US,CN,GB,JP,EU`;
    const [calendarResult, newsResult] = await Promise.allSettled([
      fetchJson(url, { headers: { "user-agent": "Mozilla/5.0", origin: "https://www.tradingview.com", referer: "https://www.tradingview.com/" } }),
      fetchMarketNews(now)
    ]);
    const calendar = calendarResult.status === "fulfilled" ? calendarResult.value : {};
    const calendarStories = (calendar.result || calendar.events || [])
      .filter((event) => Number(event.importance ?? event.impact ?? 0) >= 1)
      .sort((a, b) => Number(b.importance ?? b.impact ?? 0) - Number(a.importance ?? a.impact ?? 0))
      .slice(0, 4)
      .map((event) => ({
        title: event.title || event.name || "Market catalyst",
        summary: `${event.country || event.currency || "Global"} catalyst${event.date || event.time ? ` scheduled for ${new Date(event.date || event.time).toISOString().slice(11, 16)} UTC` : ""}. Watch the release versus consensus and the immediate rates, equity and crypto response.`,
        source: "TradingView Economic Calendar",
        url: "https://www.tradingview.com/economic-calendar/",
        category: "Macro"
      }));
    const newsStories = newsResult.status === "fulfilled" ? newsResult.value : [];
    const stories = [...newsStories.slice(0, 6), ...calendarStories].slice(0, 8);
    if (!stories.length) throw new Error("No verified market-event source returned readable stories");
    payload = {
      date: day,
      stories,
      summary: buildMarketEventsExecutiveSummary(stories),
      subline: `${newsStories.length ? "CRYPTO" : "MARKETS"} · ${calendarStories.length ? "MACRO" : "CATALYSTS"} · VERIFIED SOURCES`
    };
  }
  return buildDailyMarketBrief(payload, now);
}

export function buildMarketEventsExecutiveSummary(stories = []) {
  const labels = [...new Set(stories.map((story) => String(story?.category || "").trim().toLowerCase()).filter(Boolean))]
    .slice(0, 3);
  const coverage = labels.length === 0
    ? "cross-asset developments"
    : labels.length === 1
      ? `${labels[0]} developments`
      : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)} developments`;
  return `Today's desk brief distills the most consequential ${coverage}, prioritizing market impact over volume. Each selected item includes a source link for verification before distribution.`;
}

async function fetchMarketNews(now) {
  const sourceUrl = process.env.MARKET_EVENTS_RSS_URL || "https://cointelegraph.com/rss";
  const response = await fetchWithTimeout(sourceUrl, { headers: { accept: "application/rss+xml, text/xml", "user-agent": "YubitCommunityBot/2.0" } });
  if (!response.ok) throw new Error(`Market events feed returned HTTP ${response.status}`);
  const xml = await response.text();
  const cutoff = now.getTime() - 48 * 60 * 60 * 1000;
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => {
    const block = match[0];
    const publishedAt = decodeXml(readXmlTag(block, "pubDate"));
    const description = cleanFeedText(decodeXml(readXmlTag(block, "description")));
    return {
      title: cleanFeedText(decodeXml(readXmlTag(block, "title"))),
      summary: description.slice(0, 320),
      url: decodeXml(readXmlTag(block, "link")).trim(),
      source: new URL(sourceUrl).hostname.includes("cointelegraph") ? "Cointelegraph" : new URL(sourceUrl).hostname,
      category: "Crypto",
      publishedAt
    };
  }).filter((item) => item.title && item.url && (!Date.parse(item.publishedAt) || Date.parse(item.publishedAt) >= cutoff));
}

export function buildDailyMarketBrief(payload, now = new Date()) {
  const body = Array.isArray(payload) ? { stories: payload } : (payload?.data && !Array.isArray(payload.data) ? { ...payload.data, ...payload } : payload || {});
  const rawStories = body.stories || body.items || body.events || (Array.isArray(body.data) ? body.data : []);
  const normalized = rawStories.map((story) => {
    if (typeof story === "string") return { text: story.trim(), source: "", url: "", category: "" };
    const title = String(story?.title || story?.headline || story?.name || "").trim();
    const summary = String(story?.summary || story?.description || story?.detail || story?.content || "").trim();
    const text = title && summary && !summary.toLowerCase().startsWith(title.toLowerCase()) ? `${title}: ${summary}` : summary || title;
    return { text, source: String(story?.source || story?.publisher || "").trim(), url: safeExternalUrl(story?.url || story?.link), category: String(story?.category || "").trim() };
  }).filter((item) => item.text);
  const items = [];
  let used = 0;
  for (const item of normalized) {
    const next = `${formatMarketStoryIndex(items.length + 1)} ${item.text}`;
    if (used + next.length > 3400 && items.length) break;
    items.push(item);
    used += next.length + 2;
  }
  if (!items.length) items.push({ text: "No material market event was available from the configured source at publication time.", source: "", url: "", category: "" });
  const sourceDate = body.date ? new Date(`${String(body.date).slice(0, 10)}T00:00:00.000Z`) : new Date(now);
  const validDate = Number.isNaN(sourceDate.getTime()) ? new Date(now) : sourceDate;
  const dateLabel = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric" }).format(validDate).toUpperCase();
  const headline = `MORNING MARKET BRIEF · ${dateLabel}`;
  const summary = String(body.summary || body.overview || body.dek || items.slice(0, 3).map((item) => item.text).join(" ")).trim();
  const subline = String(body.subline || body.tagline || "GLOBAL MARKETS · CRYPTO · COMPANIES").trim().toUpperCase();
  const caption = buildMarketBriefPhotoCaption(headline, items);
  const fullText = renderMarketEventsText({
    headline,
    stories: items.map((item) => ({ ...item, url: compactSourceUrl(item.url) })),
    html: true
  });
  const contentHash = createHash("sha256").update(JSON.stringify({
    dateLabel,
    subline,
    stories: items.map((item) => ({ text: item.text, source: item.source, url: item.url, category: item.category })),
  })).digest("hex");
  return {
    imageKind: "events",
    metrics: [],
    poster: { dateLabel, subline },
    headline,
    dateLabel,
    subline,
    summary,
    caption,
    fullText,
    items: items.map((item) => item.text),
    stories: items,
    contentHash,
  };
}

export function buildDailyMarketBriefTelegramPlan(generated, target, imageUrl) {
  return [
    { method: "sendPhoto", payload: {
      ...telegramDestinationPayload(target),
      photo: imageUrl
    } },
    { method: "sendMessage", payload: {
      ...telegramDestinationPayload(target),
      text: appendTargetCta(generated.fullText, target, { html: true, limit: 4096 }),
      parse_mode: "HTML",
      disable_web_page_preview: true
    } }
  ];
}

export function buildAutomationTelegramPlans(jobId, generated, targets, imageUrl) {
  return (Array.isArray(targets) ? targets : []).filter(isTelegramDestination).map((target) => ({
    target,
    templateVersion: MARKET_DOCUMENT_JOBS.has(jobId) ? MARKET_CONTENT_TEMPLATE_VERSION : EDITORIAL_TEMPLATE_VERSION,
    contentPolicy: "fixed-template",
    steps: MARKET_DOCUMENT_JOBS.has(jobId)
      ? paragraphChunksWithFinalCta(renderTelegramMarketDocument(generated.document), target, 4096, { html: true })
        .map((text) => ({ method: "sendMessage", payload: {
          ...telegramDestinationPayload(target),
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true
        } }))
      : jobId === "daily-events"
      ? buildDailyMarketBriefTelegramPlan(generated, target, imageUrl)
      : [{ method: "sendPhoto", payload: {
        ...telegramDestinationPayload(target),
        photo: imageUrl,
        caption: appendTargetCta(generated?.caption, target, { html: true, limit: 1024 }),
        parse_mode: "HTML"
      } }]
  }));
}

function paragraphChunks(value, limit) {
  const paragraphs = String(value || "").trim().split(/\n{2,}/).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > limit) {
      throw new RangeError(`A paragraph exceeds the ${limit} character platform limit.`);
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > limit) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function paragraphChunksWithFinalCta(value, target, limit, options = {}) {
  const cta = targetCtaBlock(target, options);
  if (cta.length > limit) {
    throw new RangeError(`CTA block exceeds the ${limit} character platform limit.`);
  }
  const chunks = paragraphChunks(value, limit);
  if (!cta) return chunks;
  if (!chunks.length) return [cta];
  const finalChunk = `${chunks.at(-1)}\n\n${cta}`;
  if (finalChunk.length <= limit) chunks[chunks.length - 1] = finalChunk;
  else chunks.push(cta);
  return chunks;
}

function discordText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<b>([\s\S]*?)<\/b>/gi, "**$1**")
    .replace(/<strong>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<i>([\s\S]*?)<\/i>/gi, "*$1*")
    .replace(/<em>([\s\S]*?)<\/em>/gi, "*$1*")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function splitDiscordText(value, limit = 2000) {
  const text = discordText(value);
  if (!text) return [];
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    const newline = remaining.lastIndexOf("\n", limit);
    const boundary = newline > Math.floor(limit * 0.5) ? newline : limit;
    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function buildAutomationDiscordPlans(jobId, generated, targets, imageUrl) {
  return (Array.isArray(targets) ? targets : []).filter(isDiscordDestination).map((target) => {
    if (MARKET_DOCUMENT_JOBS.has(jobId)) {
      return {
        target,
        templateVersion: MARKET_CONTENT_TEMPLATE_VERSION,
        contentPolicy: "fixed-template",
        steps: paragraphChunksWithFinalCta(renderDiscordMarketDocument(generated.document), target, 2000)
          .map((content) => ({ method: "sendMessage", payload: { content } }))
      };
    }
    const text = appendTargetCta(jobId === "daily-events" ? generated?.fullText : generated?.caption, target);
    const chunks = splitDiscordText(text);
    const steps = jobId === "daily-events"
      ? [
        ...(imageUrl ? [{ method: "sendMessage", payload: { imageUrl } }] : []),
        ...chunks.map((content) => ({ method: "sendMessage", payload: { content } }))
      ]
      : chunks.length
        ? chunks.map((content, index) => ({ method: "sendMessage", payload: { content, ...(index === 0 && imageUrl ? { imageUrl } : {}) } }))
        : imageUrl ? [{ method: "sendMessage", payload: { imageUrl } }] : [];
    return { target, templateVersion: EDITORIAL_TEMPLATE_VERSION, contentPolicy: "fixed-template", steps };
  });
}

export function renderAgentUpdateText(update, now = new Date()) {
  const platformValue = String(update?.platform || update?.package?.platform || "").toLowerCase();
  const platform = platformValue.includes("youtube") ? "YouTube" : "X";
  const publishedAt = new Date(update?.publishedAt || now);
  const resolvedDate = Number.isFinite(publishedAt.getTime()) ? publishedAt : new Date(now);
  return `${platform} Updated + ${resolvedDate.toISOString().slice(0, 10)}\n${String(update?.url || "").trim()}`;
}

export function buildAgentUpdateTelegramPlans(updates, targets, now = new Date()) {
  const validUpdates = (Array.isArray(updates) ? updates : []).filter((update) => String(update?.url || "").trim());
  return (Array.isArray(targets) ? targets : []).filter(isTelegramDestination).map((target) => ({
    target,
    contentPolicy: "fixed-template",
    steps: validUpdates.map((update) => ({
      method: "sendMessage",
      payload: {
        ...telegramDestinationPayload(target),
        text: renderAgentUpdateText(update, now),
        disable_web_page_preview: false
      }
    }))
  }));
}

export function buildAgentUpdateDiscordPlans(updates, targets, now = new Date()) {
  const validUpdates = (Array.isArray(updates) ? updates : []).filter((update) => String(update?.url || "").trim());
  return (Array.isArray(targets) ? targets : []).filter(isDiscordDestination).map((target) => ({
    target,
    contentPolicy: "fixed-template",
    steps: validUpdates.map((update) => ({ method: "sendMessage", payload: { content: renderAgentUpdateText(update, now) } }))
  }));
}

export function automationTemplateMetadata(jobId) {
  if (MARKET_DOCUMENT_JOBS.has(String(jobId || ""))) {
    return { templateVersion: MARKET_CONTENT_TEMPLATE_VERSION, contentPolicy: "fixed-template" };
  }
  return FIXED_EDITORIAL_JOBS.has(String(jobId || ""))
    ? { templateVersion: EDITORIAL_TEMPLATE_VERSION, contentPolicy: "fixed-template" }
    : {};
}

function buildMarketBriefPhotoCaption(headline, items) {
  const limit = 1024;
  const footer = "<i>Market commentary only.</i>";
  let caption = `<b>🌅 ${escapeHtml(headline)}</b>`;
  let included = 0;

  for (const item of items) {
    const separator = "\n\n";
    const available = limit - caption.length - separator.length - separator.length - footer.length;
    if (available < 80) break;

    let maxText = 180;
    let block = formatMarketBriefCaptionItem(item, included + 1, maxText, true);
    if (block.length > available) {
      maxText = Math.max(80, maxText - (block.length - available));
      block = formatMarketBriefCaptionItem(item, included + 1, maxText, true);
    }
    if (block.length > available) {
      block = formatMarketBriefCaptionItem(item, included + 1, maxText, false);
    }
    if (block.length > available) {
      maxText = Math.max(40, maxText - (block.length - available));
      block = formatMarketBriefCaptionItem(item, included + 1, maxText, false, false);
    }
    if (block.length > available) break;

    caption += `${separator}${block}`;
    included += 1;
  }

  if (!included) {
    const fallback = truncateAtWord(items[0]?.text || "No material market event was available.", 320);
    caption += `\n\n${formatMarketStoryIndex(1)} ${escapeHtml(fallback)}`;
  }
  return `${caption}\n\n${footer}`;
}

function formatMarketBriefCaptionItem(item, index, maxText, includeLink, includeSource = true) {
  const category = item.category ? `<b>${escapeHtml(item.category.toUpperCase())}</b> · ` : "";
  const text = escapeHtml(truncateAtWord(item.text, maxText));
  let source = "";
  if (includeSource && item.source) {
    const compactUrl = compactSourceUrl(item.url);
    source = includeLink && compactUrl
      ? `\n<i>Source: <a href="${escapeHtml(compactUrl)}">${escapeHtml(item.source)}</a></i>`
      : `\n<i>Source: ${escapeHtml(item.source)}</i>`;
  }
  return `${formatMarketStoryIndex(index)} ${category}${text}${source}`;
}

function formatMarketStoryIndex(index) {
  return marketStoryIndex(index);
}

function truncateAtWord(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, Math.max(1, maxLength - 1)).trimEnd();
  const wordBoundary = slice.lastIndexOf(" ");
  const shortened = wordBoundary >= Math.floor(maxLength * 0.6) ? slice.slice(0, wordBoundary) : slice;
  return `${shortened.trimEnd()}…`;
}

async function buildDailyAnalysis(now) {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  const rows = await Promise.all(symbols.map(fetchDailyMarketRow));
  return buildDailyAnalysisSnapshot(rows, now);
}

export function buildDailyAnalysisSnapshot(rows, now = new Date()) {
  const bullish = rows.filter((row) => row.trend === "Bullish").length;
  const regime = bullish >= 2 ? "RISK ON" : bullish === 1 ? "NEUTRAL" : "RISK OFF";
  const btc = rows[0];
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric"
  }).format(now).toUpperCase();
  const breadth = bullish === rows.length
    ? "All tracked assets are trading above their 20-day average."
    : `${bullish} of ${rows.length} tracked assets are trading above their 20-day average.`;
  const momentum = `BTC 24-hour momentum is ${signed(btc.change)}%, with the dashboard classified as ${regime.toLowerCase()}.`;
  const levels = `BTC spot $${formatNumber(btc.price)} · SMA20 $${formatNumber(btc.sma20)}`;
  const catalyst = "24H momentum and cross-asset flow";
  return {
    imageKind: "analysis",
    metrics: [`${bullish}/3 above SMA20`, `BTC ${signed(rows[0].change)}% 24h`],
    poster: {
      regime,
      levels,
      catalyst: "24H MOMENTUM · CROSS-ASSET FLOW"
    },
    caption: renderDailyAnalysisText({
      dateLabel,
      regime,
      rows: rows.map((row) => ({
        symbol: row.symbol,
        price: formatNumber(row.price),
        change: signed(row.change),
        trend: row.trend
      })),
      keyRead: `${breadth} ${momentum}`,
      levels,
      catalyst,
      html: true
    }),
    items: rows
  };
}

async function buildWhaleHourly(now) {
  return buildWhaleAlert(await fetchWhaleMarketData(), now);
}

export function buildWhaleAlert(market, now = new Date()) {
  const bids = market.bids.map(([price, qty]) => ({ price: Number(price), qty: Number(qty), notional: Number(price) * Number(qty) }));
  const asks = market.asks.map(([price, qty]) => ({ price: Number(price), qty: Number(qty), notional: Number(price) * Number(qty) }));
  const bidTotal = sum(bids.map((item) => item.notional));
  const askTotal = sum(asks.map((item) => item.notional));
  const imbalance = ((bidTotal - askTotal) / Math.max(bidTotal + askTotal, 1)) * 100;
  const largestBid = bids.sort((a, b) => b.notional - a.notional)[0];
  const largestAsk = asks.sort((a, b) => b.notional - a.notional)[0];
  const rows = { bidTotal, askTotal, imbalance, largestBid, largestAsk, openInterest: market.openInterest, funding: market.funding, markPrice: market.markPrice, source: market.source };
  const isBid = largestBid.notional >= largestAsk.notional;
  const order = isBid ? largestBid : largestAsk;
  const sourceName = String(market.source || "Market data").replace(/\s+fallback$/i, "");
  const timestamp = new Date(now).toISOString().replace("T", " ").slice(0, 16);
  const minNotional = Math.max(1, Number(process.env.WHALE_MIN_NOTIONAL_USD || 1_000_000));
  const minImbalance = Math.max(0, Number(process.env.WHALE_MIN_IMBALANCE_PCT || 15));
  const opposite = isBid ? largestAsk : largestBid;
  const publishable = order.notional >= minNotional && (Math.abs(imbalance) >= minImbalance || order.notional >= opposite.notional * 2);
  const action = isBid ? "Large bid added" : "Large ask added";
  const state = isBid ? "Buy-wall support" : "Sell-wall pressure";
  const directionRead = isBid
    ? "If the bid remains and grows, near-term support may strengthen. A rapid fill or cancellation would weaken that read and could signal a reversal."
    : "If the ask remains and grows, near-term selling pressure may intensify. Fast absorption or cancellation would weaken that read and could signal a reversal.";
  const concentrationRead = publishable
    ? "showed a material liquidity concentration"
    : "showed the largest visible liquidity concentration in the current snapshot";
  const caption = renderWhaleSignalText({
    timestamp,
    pair: "BTC/USDT",
    concentrationRead,
    quantity: formatQuantity(order.qty),
    asset: "BTC",
    notional: formatCompact(order.notional),
    action,
    price: formatNumber(order.price),
    state,
    imbalance: signed(imbalance),
    directionRead,
    watchNext: `Whether liquidity near $${formatNumber(order.price)} is filled, increased or cancelled.`,
    html: true
  });
  const contentHash = createHash("sha256").update(JSON.stringify({
    sourceName,
    side: isBid ? "bid" : "ask",
    priceBucket: Math.round(order.price / 100) * 100,
    notionalBucket: Math.round(order.notional / 250000) * 250000,
    imbalanceBucket: Math.round(imbalance / 5) * 5
  })).digest("hex");
  return {
    imageKind: "whale",
    metrics: [`Orderbook ${signed(imbalance)}%`, `OI ${formatCompact(rows.openInterest)} BTC`],
    poster: {
      pair: "BTC / USDT",
      signal: isBid ? "LARGE BID" : "LARGE ASK",
      amount: `$${formatCompact(order.notional)}`,
      price: `$${formatNumber(order.price)}`,
      status: isBid ? "BUY WALL SUPPORT" : "SELL WALL PRESSURE"
    },
    caption,
    items: rows,
    publishable,
    suppressionReason: publishable ? null : `Signal below publication threshold: minimum $${formatCompact(minNotional)} visible notional and ${minImbalance}% depth imbalance (or 2x opposing order).`,
    contentHash
  };
}

async function fetchDailyMarketRow(symbol) {
  try {
    const [ticker, candles] = await Promise.all([
      fetchJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`),
      fetchJson(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=21`)
    ]);
    const closes = candles.map((item) => Number(item[4]));
    const sma20 = average(closes.slice(-20));
    const price = Number(ticker.lastPrice);
    return { symbol: symbol.replace("USDT", ""), price, change: Number(ticker.priceChangePercent), sma20, trend: price >= sma20 ? "Bullish" : "Bearish", source: "Binance" };
  } catch {
    const asset = symbol.replace("USDT", "");
    const instId = `${asset}-USDT`;
    const [tickerBody, candlesBody] = await Promise.all([
      fetchJson(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`),
      fetchJson(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=1Dutc&limit=21`)
    ]);
    const ticker = tickerBody.data?.[0];
    const candles = candlesBody.data || [];
    if (!ticker || candles.length < 20) throw new Error(`OKX market data unavailable for ${instId}`);
    const closes = candles.map((item) => Number(item[4])).reverse();
    const price = Number(ticker.last);
    const open24h = Number(ticker.open24h);
    const change = open24h ? ((price - open24h) / open24h) * 100 : 0;
    const sma20 = average(closes.slice(-20));
    return { symbol: asset, price, change, sma20, trend: price >= sma20 ? "Bullish" : "Bearish", source: "OKX fallback" };
  }
}

async function fetchWhaleMarketData() {
  try {
    const [depth, openInterest, premium] = await Promise.all([
      fetchJson("https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=100"),
      fetchJson("https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT"),
      fetchJson("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT")
    ]);
    return {
      bids: depth.bids,
      asks: depth.asks,
      openInterest: Number(openInterest.openInterest),
      funding: Number(premium.lastFundingRate) * 100,
      markPrice: Number(premium.markPrice),
      source: "Binance"
    };
  } catch {
    const instId = "BTC-USDT-SWAP";
    const [booksBody, oiBody, fundingBody, markBody] = await Promise.all([
      fetchJson(`https://www.okx.com/api/v5/market/books?instId=${instId}&sz=100`),
      fetchJson(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${instId}`),
      fetchJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`),
      fetchJson(`https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=${instId}`)
    ]);
    const book = booksBody.data?.[0];
    const oi = oiBody.data?.[0];
    const funding = fundingBody.data?.[0];
    const mark = markBody.data?.[0];
    if (!book?.bids?.length || !book?.asks?.length || !mark) throw new Error("OKX whale data unavailable");
    const contractBtc = 0.01;
    return {
      bids: book.bids.map(([price, contracts]) => [price, Number(contracts) * contractBtc]),
      asks: book.asks.map(([price, contracts]) => [price, Number(contracts) * contractBtc]),
      openInterest: Number(oi?.oiCcy || Number(oi?.oi || 0) * contractBtc),
      funding: Number(funding?.fundingRate || 0) * 100,
      markPrice: Number(mark.markPx),
      source: "OKX fallback"
    };
  }
}

async function buildAgentUpdates(now, { persist = true } = {}) {
  const stored = await readJson("social-packages.json", { packages: [] });
  const packages = normalizeSocialPackages(Array.isArray(stored) ? stored : stored.packages || []);
  const previous = await readJson(socialStatePath, {});
  const next = { ...previous };
  const updates = [];
  const checks = [];

  for (const item of packages.filter((pkg) => pkg.status === "已启用")) {
    const urls = extractUrls(item.accountUrl);
    if (!urls.length && item.feedUrl) urls.push(item.feedUrl);
    if (!urls.length) {
      checks.push({ agent: item.agent, status: "skipped", reason: "未配置有效 URL" });
      continue;
    }
    for (const url of urls) {
      try {
        const snapshot = await fetchSocialSource({ ...item, accountUrl: url });
        const key = `${item.id || item.agent}:${url}`;
        const changed = Boolean(previous[key]?.hash && previous[key].hash !== snapshot.hash);
        next[key] = { ...snapshot, checkedAt: now.toISOString() };
        checks.push({ agent: item.agent, platform: item.platform, url, contentUrl: snapshot.url, reliability: snapshot.reliability, status: changed ? "updated" : previous[key] ? "unchanged" : "baseline", title: snapshot.title });
        if (changed) updates.push({ ...snapshot, agent: item.agent, package: item, accountUrl: url });
      } catch (error) {
        checks.push({ agent: item.agent, url, status: "failed", reason: error.message });
      }
    }
  }
  if (persist) await writeJson(socialStatePath, next);
  return {
    imageKind: null,
    metrics: [`${checks.length} sources`, `${updates.length} updates`],
    caption: `Agent sync checked ${checks.length} source(s); ${updates.length} update(s).`,
    items: checks,
    updates
  };
}

export function evaluateAgentSyncHealth(checks, updateCount = 0) {
  const items = Array.isArray(checks) ? checks : [];
  const failedCount = items.filter((item) => item?.status === "failed").length;
  const skippedCount = items.filter((item) => item?.status === "skipped").length;
  const healthyCount = items.filter((item) => ["updated", "unchanged", "baseline"].includes(item?.status)).length;
  const issueCount = failedCount + skippedCount;
  const status = issueCount === 0 ? "success" : healthyCount > 0 ? "partial" : "failed";
  const message = status === "success"
    ? Number(updateCount) > 0
      ? `已检测到 ${Number(updateCount)} 条代理更新。`
      : "已完成抓取，本轮没有新内容。"
    : status === "partial"
      ? `部分来源检查失败：${issueCount} 个异常，${healthyCount} 个正常。`
      : `代理来源检查失败：${issueCount} 个来源不可用或未配置。`;
  return {
    status,
    sourceCount: items.length,
    healthyCount,
    failedCount,
    skippedCount,
    updateCount: Number(updateCount) || 0,
    message
  };
}

export async function previewSocialSource(source) {
  const [normalized] = normalizeSocialPackages([source]);
  if (!normalized) throw new Error("请填写代理名称和来源名称");
  if (!normalized.accountUrl && !normalized.feedUrl) throw new Error("请填写账号主页或 Feed 地址");
  const snapshot = await fetchSocialSource(normalized);
  return {
    agent: normalized.agent,
    platform: normalized.platform,
    title: snapshot.title,
    description: snapshot.description,
    url: snapshot.url,
    publishedAt: snapshot.publishedAt,
    reliability: snapshot.reliability,
    strategy: snapshot.strategy
  };
}

function automationDestinationKey(target) {
  if (isDiscordDestination(target)) return `discord:${target.guildId}:${target.channelId}`;
  return target?.chatType === "channel"
    ? `${target.chatId}:channel`
    : `${target.chatId}:${Number(target.threadId)}`;
}

function uniqueAutomationDestinations(targets) {
  const seen = new Set();
  return (Array.isArray(targets) ? targets : []).filter((target) => {
    const key = automationDestinationKey(target);
    if (!isAutomationDestination(target) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildAgentUpdateAssignments(updates, configuredTargets) {
  const validUpdates = (Array.isArray(updates) ? updates : []).filter((update) => String(update?.url || "").trim());
  const configured = uniqueAutomationDestinations(configuredTargets);
  const assignmentMap = new Map();
  const unresolved = [];

  for (const update of validUpdates) {
    const sourceTargets = uniqueAutomationDestinations(update?.package?.targets);
    const destinations = sourceTargets.length ? sourceTargets : configured;
    if (!destinations.length) {
      unresolved.push(update);
      continue;
    }
    for (const target of destinations) {
      const key = automationDestinationKey(target);
      const existing = assignmentMap.get(key);
      if (existing) existing.updates.push(update);
      else assignmentMap.set(key, { key, target, updates: [update] });
    }
  }
  return { assignments: [...assignmentMap.values()], unresolved };
}

async function sendAgentUpdates(updates, configuredTargets, options = {}) {
  const signal = options.signal;
  signal?.throwIfAborted?.();
  let sent = 0;
  const validUpdates = (Array.isArray(updates) ? updates : []).filter((update) => String(update?.url || "").trim());
  const configured = uniqueAutomationDestinations(configuredTargets);
  const routing = buildAgentUpdateAssignments(validUpdates, configured);
  const assignments = routing.assignments;
  for (const update of routing.unresolved) {
    signal?.throwIfAborted?.();
    const target = await resolveAgentTarget(update.agent);
    if (!isAutomationDestination(target)) continue;
    const key = automationDestinationKey(target);
    const existing = assignments.find((item) => item.key === key);
    if (existing) existing.updates.push(update);
    else assignments.push({ key, target, updates: [update] });
  }
  const targets = assignments.map((item) => item.target);
  const deliveryPlans = assignments.flatMap((item) => [
    ...buildAgentUpdateTelegramPlans(item.updates, [item.target], options.now),
    ...buildAgentUpdateDiscordPlans(item.updates, [item.target], options.now)
  ]);
  if (!validUpdates.length) {
    return { sent, targets: configured, targetResults: configured.map((target) => ({ target, status: "success", messageId: null, messageIds: [] })), deliveryPlans: [], status: "success" };
  }
  const targetKey = automationDestinationKey;
  const resultMap = new Map(targets.map((target) => [targetKey(target), {
    target,
    status: options.deferDelivery && isTelegramDestination(target) ? "pending" : "success",
    messageIds: []
  }]));
  const token = tokenForBot("SpeakerBot");
  for (const plan of deliveryPlans) {
    signal?.throwIfAborted?.();
    const key = targetKey(plan.target);
    if (options.deferDelivery && isTelegramDestination(plan.target)) continue;
    if (isTelegramDestination(plan.target) && !token) {
      resultMap.set(key, { ...resultMap.get(key), status: "failed", error: "SpeakerBot Token 未配置" });
      continue;
    }
    for (const step of plan.steps) {
      signal?.throwIfAborted?.();
      try {
        const message = isDiscordDestination(plan.target)
          ? await (options.discordSender ?? sendDiscordMessage)(plan.target.channelId, step.payload, { signal })
          : options.telegramSender
            ? await options.telegramSender(token, step.method, step.payload, { signal })
            : await telegramCall(token, step.method, step.payload, options.fetchImpl ?? fetch, { signal, env: options.env });
        signal?.throwIfAborted?.();
        resultMap.get(key).messageIds.push(message.id || message.message_id || null);
        sent += 1;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        resultMap.set(key, { ...resultMap.get(key), status: "failed", error: error.message });
      }
    }
  }
  const targetResults = [...resultMap.values()].map((item) => ({ ...item, messageId: item.messageIds.at(-1) || null }));
  const hasFailed = targetResults.some((item) => item.status === "failed");
  const hasPending = targetResults.some((item) => item.status === "pending");
  const status = hasFailed ? "partial" : hasPending ? "queued" : "success";
  return { sent, targets, targetResults, deliveryPlans, status };
}

async function resolveTarget(job) {
  const envPrefix = job.id.replaceAll("-", "_").toUpperCase();
  const envChatId = process.env[`${envPrefix}_CHAT_ID`];
  const envThreadId = Number(process.env[`${envPrefix}_THREAD_ID`] || 0);
  if (envChatId && envThreadId) return { chatId: envChatId, threadId: envThreadId, group: "Environment override", topic: job.topic, configured: true };

  const config = await readJson("group-config.json", {});
  const groups = Array.isArray(config.groups) ? config.groups : [];
  const bindings = Array.isArray(config.bindings) ? config.bindings : [];
  const binding = bindings.find((item) => item.status !== "暂停" && automationTopicMatches(item.topic, job.topic));
  if (!binding) return { configured: false, topic: job.topic };
  const group = groups.find((item) => item.title === binding.group);
  const topic = group?.topics?.find((item) => automationTopicMatches(item.name, binding.topic));
  const threadId = Number(binding.topicId || topic?.threadId || 0) || null;
  return { chatId: group?.chatId || null, threadId, group: binding.group, topic: binding.topic, configured: Boolean(group?.chatId && threadId) };
}

async function resolveAgentTarget(agent) {
  const config = await readJson("group-config.json", {});
  const groups = Array.isArray(config.groups) ? config.groups : [];
  const bindings = Array.isArray(config.bindings) ? config.bindings : [];
  const binding = bindings.find((item) => item.type === "代理社媒" && item.status !== "暂停" && (String(item.config).toLowerCase().includes(String(agent).toLowerCase()) || String(item.topic).toLowerCase().includes(String(agent).toLowerCase())));
  if (!binding) return { configured: false, agent };
  const group = groups.find((item) => item.title === binding.group);
  const topic = group?.topics?.find((item) => automationTopicMatches(item.name, binding.topic));
  const threadId = Number(binding.topicId || topic?.threadId || 0) || null;
  return { chatId: group?.chatId || null, threadId, group: binding.group, topic: binding.topic, configured: Boolean(group?.chatId && threadId), agent };
}

function comparableTopicName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/^[^\p{Letter}\p{Number}]+/u, "")
    .replace(/^\d+\s*[.、)]\s*/, "")
    .trim()
    .toLowerCase();
}

export function automationTopicMatches(value, expected) {
  const normalized = comparableTopicName(value);
  const wanted = comparableTopicName(expected);
  return Boolean(normalized && wanted && (
    normalized === wanted || normalized.includes(wanted) || wanted.includes(normalized)
  ));
}

async function logRun({ job, slot, dryRun, status, message, target = null, preview = null }) {
  const entry = { id: `${job.id}-${Date.now()}`, jobId: job.id, jobName: job.name, slot, dryRun, status, message, target, preview, createdAt: new Date().toISOString() };
  const runs = await readJson(runsPath, []);
  await writeJson(runsPath, [entry, ...(Array.isArray(runs) ? runs : [])].slice(0, 100));
  return entry;
}

export function buildCardUrl(kind, metrics = [], poster = {}, options = {}) {
  const query = new URLSearchParams({ kind, v: marketCardTemplateVersion });
  const cacheKey = String(options.cacheKey || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  if (cacheKey) query.set("rev", cacheKey);
  metrics.slice(0, 3).forEach((metric, index) => query.set(`m${index + 1}`, String(metric)));
  if (poster?.dateLabel) query.set("date", String(poster.dateLabel));
  if (poster?.subline) query.set("subline", String(poster.subline));
  for (const key of ["regime", "levels", "catalyst", "pair", "signal", "amount", "price", "status"]) {
    if (poster?.[key]) query.set(key, String(poster[key]));
  }
  return `${resolveAppBaseUrl(options.baseUrl)}/api/media/card?${query}`;
}

function resolveAppBaseUrl(explicitBaseUrl) {
  const candidates = [
    explicitBaseUrl,
    process.env.APP_BASE_URL,
    process.env.APP_DEPLOYMENT_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    fallbackAppBaseUrl
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(String(candidate));
      if (!/^https?:$/.test(url.protocol)) continue;
      url.username = "";
      url.password = "";
      url.pathname = "";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/, "");
    } catch {
      // Continue to the next trusted deployment URL.
    }
  }
  return fallbackAppBaseUrl;
}

export function resolveAutomationPreviewBaseUrl(requestUrl, env = process.env) {
  const publicBaseUrl = env.APP_BASE_URL || env.APP_DEPLOYMENT_URL || env.NEXT_PUBLIC_APP_URL;
  return resolveAppBaseUrl(publicBaseUrl || requestUrl);
}

export function shouldSuppressWhaleSignal(generated, options = {}) {
  return generated?.publishable === false && options.force !== true;
}

async function fetchSocialSource(source) {
  const snapshot = await fetchSocialSourceUnchecked(source);
  const ownership = validateSocialSnapshotOwnership(source, snapshot);
  if (ownership.ok) return snapshot;

  if (String(source?.feedUrl || "").trim()) {
    try {
      const fallback = await fetchSocialSourceUnchecked({ ...source, feedUrl: "" });
      const fallbackOwnership = validateSocialSnapshotOwnership(source, fallback);
      if (fallbackOwnership.ok) return fallback;
    } catch {
      // Fail closed below: a broken fallback must never publish another account's content.
    }
  }

  const observed = ownership.observedHandle ? `@${ownership.observedHandle}` : "未知账号";
  throw new Error(
    `来源归属校验失败：配置为 @${ownership.expectedHandle}，但最新内容属于 ${observed}，已阻止发布`
  );
}

async function fetchSocialSourceUnchecked(source) {
  const plan = socialFetchPlan(source);
  if (plan.kind === "feed" || plan.kind === "youtube-feed") {
    return fetchSocialFeed(plan.url, plan);
  }
  if (plan.kind === "youtube-page") {
    const response = await fetchWithTimeout(plan.url, { headers: browserHeaders() });
    if (!response.ok) throw new Error(`YouTube 主页返回 HTTP ${response.status}`);
    const html = (await response.text()).slice(0, 1000000);
    const channelId = html.match(/"channelId":"([^"]+)"/i)?.[1]
      || html.match(/channel_id=([^&"']+)/i)?.[1]
      || html.match(/youtube\.com\/channel\/([^/?#"']+)/i)?.[1];
    if (!channelId) throw new Error("无法从 YouTube 主页解析频道 ID，请填写 /channel/UC… 地址或自定义 Feed");
    return fetchSocialFeed(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, { kind: "youtube-feed", reliability: "stable" });
  }
  if (plan.kind === "x-api") return fetchLatestXPost(source);
  if (plan.kind === "x-profile") {
    let profileError;
    try {
      const response = await fetchWithTimeout(plan.url, { headers: browserHeaders() });
      if (!response.ok) throw new Error(`X 公开主页返回 HTTP ${response.status}`);
      const html = (await response.text()).slice(0, 3000000);
      const item = parseXProfileTimeline(html, plan.username);
      return socialContentSnapshot(item, { reliability: plan.reliability, strategy: plan.kind });
    } catch (error) {
      profileError = error;
    }

    const readerTargets = [
      `https://x.com/${encodeURIComponent(plan.username)}`,
      `https://mobile.twitter.com/${encodeURIComponent(plan.username)}`
    ];
    const readerErrors = [];
    for (const target of readerTargets) {
      try {
        const readerResponse = await fetchWithTimeout(`https://r.jina.ai/${target}`, { headers: browserHeaders() });
        if (!readerResponse.ok) throw new Error(`HTTP ${readerResponse.status}`);
        const markdown = (await readerResponse.text()).slice(0, 2000000);
        const item = parseXReaderTimeline(markdown, plan.username);
        return socialContentSnapshot(item, { reliability: "degraded", strategy: "x-reader-fallback" });
      } catch (error) {
        readerErrors.push(error?.message || "未知错误");
      }
    }
    throw new Error(`${profileError?.message || "X 公开主页不可读"}；Reader 不可用（${readerErrors.join("；")}）`);
  }
  if (plan.kind === "x-syndication") {
    const response = await fetchWithTimeout(plan.url, { headers: browserHeaders() });
    if (!response.ok) throw new Error(`X 公开时间线返回 HTTP ${response.status}`);
    const html = (await response.text()).slice(0, 2000000);
    const item = parseXSyndicationTimeline(html, plan.username);
    return socialContentSnapshot(item, { reliability: plan.reliability, strategy: plan.kind });
  }
  return fetchSocialPage(plan.url, plan);
}

async function fetchSocialFeed(url, plan) {
  const response = await fetchWithTimeout(url, { headers: { accept: "application/atom+xml, application/rss+xml, application/json, text/xml;q=0.9", "user-agent": "YubitCommunityBot/2.0" } });
  if (!response.ok) throw new Error(`内容 Feed 返回 HTTP ${response.status}`);
  const raw = await response.text();
  let item;
  try {
    const json = JSON.parse(raw);
    const values = Array.isArray(json) ? json : json.items || json.data?.items || json.data || [];
    const first = Array.isArray(values) ? values[0] : values;
    item = {
      externalId: first?.id || first?.guid || first?.url || first?.link,
      title: first?.title || first?.text || first?.content,
      description: first?.description || first?.summary || first?.text || "",
      url: first?.url || first?.link,
      publishedAt: first?.publishedAt || first?.published_at || first?.date || ""
    };
  } catch {
    item = parseSocialFeed(raw);
  }
  if (!item?.externalId || !item?.title || !item?.url) throw new Error("内容 Feed 最新项目缺少标题、链接或唯一编号");
  return socialContentSnapshot(item, { reliability: plan.reliability, strategy: plan.kind });
}

async function fetchLatestXPost(source) {
  const username = socialUsername(source);
  if (!username) throw new Error("无法识别 X 用户名，请填写完整的 x.com 主页地址");
  const headers = { accept: "application/json", authorization: `Bearer ${process.env.X_BEARER_TOKEN}`, "user-agent": "YubitCommunityBot/2.0" };
  const profile = await fetchJson(`https://api.x.com/2/users/by/username/${encodeURIComponent(username)}`, { headers });
  const userId = profile.data?.id;
  if (!userId) throw new Error(`X API 未找到 @${username}`);
  const timeline = await fetchJson(`https://api.x.com/2/users/${encodeURIComponent(userId)}/tweets?max_results=5&exclude=retweets,replies&tweet.fields=created_at`, { headers });
  const post = timeline.data?.[0];
  if (!post?.id || !post?.text) throw new Error(`X API 没有返回 @${username} 的新内容`);
  const url = `https://x.com/${username}/status/${post.id}`;
  return socialContentSnapshot({ externalId: post.id, title: post.text.slice(0, 180), description: post.text, url, publishedAt: post.created_at || "" }, { reliability: "stable", strategy: "x-api" });
}

async function fetchSocialPage(url, plan) {
  if (!url) throw new Error("账号主页地址未配置");
  const response = await fetchWithTimeout(url, { headers: browserHeaders() });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = (await response.text()).slice(0, 500000);
  const title = decodeEntities(matchMeta(html, "og:title") || matchTag(html, "title") || url);
  const description = decodeEntities(matchMeta(html, "og:description") || matchMeta(html, "description") || "").slice(0, 400);
  return socialContentSnapshot({ externalId: `${url}:${title}:${description}`, title, description, url, publishedAt: "" }, { reliability: plan.reliability, strategy: plan.kind });
}

function browserHeaders() {
  return { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0 (compatible; YubitCommunityBot/2.0)" };
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${response.status}`);
  return response.json();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    return await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

async function telegramBotApiCall(token, method, payload, fetchImpl = fetch, options = {}) {
  options.signal?.throwIfAborted?.();
  const endpoint = `https://api.telegram.org/bot${token}/${method}`;
  const response = await fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: options.signal });
  options.signal?.throwIfAborted?.();
  const body = await response.json().catch(() => ({}));
  if ((!response.ok || !body.ok)
    && method === "sendPhoto"
    && /^https?:\/\//i.test(String(payload?.photo || ""))
    && /(failed to get HTTP URL content|wrong type of the web page content)/i.test(String(body.description || ""))) {
    options.signal?.throwIfAborted?.();
    const imageResponse = await fetchImpl(payload.photo, { cache: "no-store", signal: options.signal });
    options.signal?.throwIfAborted?.();
    if (!imageResponse.ok) throw new Error(`${method} failed: ${body.description}; poster download HTTP ${imageResponse.status}`);
    const form = new FormData();
    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined || value === null) continue;
      if (key === "photo") {
        const contentType = imageResponse.headers.get("content-type") || "image/png";
        options.signal?.throwIfAborted?.();
        form.set("photo", new Blob([await imageResponse.arrayBuffer()], { type: contentType }), `poster.${contentType.includes("jpeg") ? "jpg" : "png"}`);
      } else {
        form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
    }
    options.signal?.throwIfAborted?.();
    const uploadResponse = await fetchImpl(endpoint, { method: "POST", body: form, signal: options.signal });
    options.signal?.throwIfAborted?.();
    const uploadBody = await uploadResponse.json().catch(() => ({}));
    if (!uploadResponse.ok || !uploadBody.ok) throw new Error(`${method} failed: ${uploadBody.description || `HTTP ${uploadResponse.status}`}`);
    return uploadBody.result || {};
  }
  if (!response.ok || !body.ok) throw new Error(`${method} failed: ${body.description || `HTTP ${response.status}`}`);
  return body.result || {};
}

export async function telegramCall(token, method, payload, fetchImpl = fetch, options = {}) {
  const env = await telegramDeliveryEnvironment("publish", options.env ?? process.env);
  const deliver = createTelegramDelivery({
    env,
    botApiCall: (botToken, botMethod, botPayload, deliveryOptions = {}) => telegramBotApiCall(
      botToken,
      botMethod,
      botPayload,
      fetchImpl,
      { ...options, ...deliveryOptions, signal: deliveryOptions.signal ?? options.signal }
    ),
    userPublisherCall: options.userPublisherCall ?? options.groupIdentityCall ?? telegramMtprotoCall
  });
  return deliver(token, method, payload, { signal: options.signal });
}

function tokenForBot(bot) {
  if (bot === "SpeakerBot") return process.env.SPEAKER_BOT_TOKEN || process.env.TRADER1_BOT_TOKEN;
  if (bot === "ForwardBot") return process.env.FORWARD_BOT_TOKEN;
  return process.env.YUBITADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
}

function extractUrls(value) {
  return String(value || "").match(/https?:\/\/[^\s,;]+/g) || [];
}

function matchMeta(html, key) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`, "i")
  ];
  return patterns.map((pattern) => html.match(pattern)?.[1]).find(Boolean) || "";
}

function matchTag(html, tag) {
  return html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, "i"))?.[1]?.replace(/<[^>]+>/g, "").trim() || "";
}

function decodeEntities(value) {
  return String(value).replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function cleanFeedText(value) {
  return decodeEntities(String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function compactSourceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
    }
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function average(values) { return sum(values) / Math.max(values.length, 1); }
function sum(values) { return values.reduce((total, value) => total + Number(value || 0), 0); }
function formatNumber(value) { return Number(value).toLocaleString("en-US", { maximumFractionDigits: Number(value) < 10 ? 3 : 0 }); }
function formatCompact(value) { return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(Number(value)); }
function formatQuantity(value) { return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(Number(value)); }
function signed(value, digits = 2) { const number = Number(value); return `${number >= 0 ? "+" : ""}${number.toFixed(digits)}`; }
