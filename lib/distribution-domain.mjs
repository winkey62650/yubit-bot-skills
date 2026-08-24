import { createHash } from "node:crypto";

export const DISTRIBUTION_SCHEDULES = Object.freeze({
  "daily-0800-utc": { label: "每日 08:00 UTC", minutes: 24 * 60 },
  "weekly-monday-0030-utc": { label: "每周一 00:30 UTC", kind: "weekly" },
  "event-driven": { label: "事件驱动，每分钟检查", minutes: 1, kind: "monitor" },
  hourly: { label: "每小时", minutes: 60 },
  "every-4-hours": { label: "每 4 小时", minutes: 4 * 60 },
  "every-15-minutes": { label: "每 15 分钟", minutes: 15 },
  "every-5-minutes": { label: "每 5 分钟", minutes: 5 }
});

function stableId(prefix, value) {
  return `${prefix}-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)}`;
}

function stringId(value) {
  if (value === undefined || value === null || value === "") return "";
  return String(value).trim();
}

function threadId(value) {
  if (value === undefined || value === null || value === "" || Number(value) === 0) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeTargetCta(target = {}) {
  const nested = target?.cta && typeof target.cta === "object" ? target.cta : {};
  const ctaText = String(target?.ctaText ?? target?.textCta ?? nested.text ?? "").trim();
  const ctaUrl = String(target?.ctaUrl ?? target?.linkUrl ?? target?.urlCta ?? nested.url ?? "").trim();
  const rawEnabled = target?.ctaEnabled ?? nested.enabled;
  if (rawEnabled === undefined && !ctaText && !ctaUrl) return {};
  const ctaEnabled = rawEnabled === true || (rawEnabled !== false && Boolean(ctaText || ctaUrl));
  return { ctaEnabled, ctaText, ctaUrl };
}

function isAllowedCtaUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function canonicalTopicName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/^[^\p{L}\p{N}]+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function topicSequence(value) {
  const match = canonicalTopicName(value).match(/^(\d+)\s*[.、)]/);
  return match ? Number(match[1]) : null;
}

function semanticTopicSequence(value) {
  const name = canonicalTopicName(value).replace(/^\d+\s*[.、)]\s*/, "");
  if (name === "read first - disclaimer" || name === "community disclaimer") return 1;
  if (name === "cryptoguy trading zone" || name === "xxx's trading zone" || name === "ricky's trading zone" || name === "trading zone") return 2;
  if (name === "market events") return 3;
  if (name === "market analysis - crypto/stocks/tradfi") return 4;
  if (name === "community signal" || name === "7-day pnl challenge") return 5;
  if (name === "smart money tracker") return 6;
  if (name === "yubit updates") return 7;
  return null;
}

function topicMatchesSequence(value, number) {
  const semantic = semanticTopicSequence(value);
  if (semantic !== null) return semantic === number;
  return topicSequence(value) === number;
}

const STANDARD_PRODUCTION_GROUPS = Object.freeze({
  sourceChatId: "-1003710405969",
  targetChatId: "-1004378187866",
});

const STANDARD_TOPIC_NAMES = Object.freeze({
  1: "1. READ FIRST - DISCLAIMER",
  2: "2. CryptoGuy Trading Zone",
  3: "3. Market Events",
  4: "4. Market Analysis - Crypto/Stocks/TradFi",
  5: "5. Community Signal",
  6: "6. Smart Money Tracker",
  7: "7. YUBIT Updates",
});

function standardTopicDisplayName(topic, topicNumberValue = null) {
  const currentName = String(topic?.name ?? topic?.title ?? "").trim();
  const semanticNumber = topicNumberValue ?? semanticTopicSequence(currentName);
  return STANDARD_TOPIC_NAMES[semanticNumber] ?? currentName;
}

const STANDARD_AUTOMATION_SPECS = Object.freeze([
  Object.freeze({
    id: "production-automation-news",
    name: "Crypto Daily · Standard",
    contentType: "crypto-daily",
    schedulePreset: "daily-0800-utc",
    topicNumber: 7,
  }),
  Object.freeze({
    id: "production-automation-daily-events",
    name: "Weekly Calendar · Standard",
    contentType: "weekly-calendar",
    schedulePreset: "weekly-monday-0030-utc",
    topicNumber: 3,
    demoOnly: true,
  }),
  Object.freeze({
    id: "production-automation-daily-events-data-release-updates",
    name: "Data Release Updates · Standard",
    contentType: "data-release-updates",
    schedulePreset: "event-driven",
    topicNumber: 3,
    demoOnly: true,
    forceDisabled: true,
  }),
  Object.freeze({
    id: "production-automation-daily-analysis",
    name: "Daily Analysis · Standard",
    contentType: "daily-analysis",
    schedulePreset: "daily-0800-utc",
    topicNumber: 4,
    demoOnly: true,
  }),
  Object.freeze({
    id: "production-automation-whale-signals",
    name: "Whale Signals · Standard",
    contentType: "whale-signals",
    schedulePreset: "hourly",
    topicNumber: 6,
    demoOnly: true,
  }),
  Object.freeze({
    id: "production-automation-agent-sync",
    name: "Agent Sync · Standard",
    contentType: "agent-sync",
    schedulePreset: "hourly",
    topicNumber: 2,
  }),
]);

function standardGroup(groups, chatId, label) {
  const matches = (Array.isArray(groups) ? groups : []).filter((group) => (
    stringId(group?.chatId ?? group?.id) === chatId
  ));
  if (matches.length !== 1) {
    throw new Error(`${label} 群必须唯一存在，当前找到 ${matches.length} 个（${chatId}）`);
  }
  return matches[0];
}

function standardTopic(group, number, label) {
  const matches = (Array.isArray(group?.topics) ? group.topics : []).filter((topic) => (
    topic?.verified !== false
    && threadId(topic?.threadId ?? topic?.topicId ?? topic?.id)
    && topicMatchesSequence(topic?.name ?? topic?.title, number)
  ));
  if (matches.length !== 1) {
    throw new Error(`${label} 的 ${number} 号 Topic 必须唯一有效，当前找到 ${matches.length} 个`);
  }
  return matches[0];
}

function standardEndpoint(group, topic, topicNumberValue = null) {
  return {
    chatId: stringId(group?.chatId ?? group?.id),
    threadId: threadId(topic?.threadId ?? topic?.topicId ?? topic?.id),
    groupName: String(group?.title ?? group?.name ?? "").trim(),
    topicName: standardTopicDisplayName(topic, topicNumberValue),
  };
}

function currentStandardRule(desired, currentRules, topicNumberValue) {
  const candidates = (Array.isArray(currentRules) ? currentRules : [])
    .map((rule) => normalizeDistributionRule(rule))
    .filter((rule) => {
      if (desired.kind === "automation") {
        return rule.kind === "automation"
          && rule.runOnce !== true
          && rule.contentType === desired.contentType;
      }
      if (rule.kind !== "broadcast" || rule.source?.chatId !== desired.source?.chatId) return false;
      return rule.source?.threadId === desired.source?.threadId
        || topicMatchesSequence(rule.source?.topicName, topicNumberValue);
    });
  if (candidates.length > 1) {
    const identity = desired.kind === "automation"
      ? desired.contentType
      : `${desired.source.chatId} / ${topicNumberValue} 号 Topic`;
    throw new Error(`生产标准规则 ${identity} 存在 ${candidates.length} 条候选，拒绝自动覆盖`);
  }
  return candidates[0] ?? null;
}

function mergeStandardRule(desired, currentRules, topicNumberValue) {
  const current = currentStandardRule(desired, currentRules, topicNumberValue);
  if (!current) return normalizeDistributionRule(desired);
  const targets = desired.targets.map((target) => {
    const currentTarget = current.targets.find((candidate) => candidate.chatId === target.chatId);
    return currentTarget?.id ? { ...target, id: currentTarget.id } : target;
  });
  return normalizeDistributionRule({
    ...desired,
    id: current.id,
    enabled: desired.forceDisabled === true ? false : current.enabled,
    createdAt: current.createdAt,
    importedFrom: current.importedFrom,
    targets,
  });
}

export function buildStandardProductionDistributionRules(groups = [], {
  currentRules = [],
  sourceChatId = STANDARD_PRODUCTION_GROUPS.sourceChatId,
  targetChatId = STANDARD_PRODUCTION_GROUPS.targetChatId,
} = {}) {
  const migratedCurrentRules = migrateMarketContentRules(
    (Array.isArray(currentRules) ? currentRules : []).filter((rule) => rule?.runOnce !== true),
  ).rules;
  const sourceGroup = standardGroup(groups, stringId(sourceChatId), "DEMO Academy");
  const targetGroup = standardGroup(groups, stringId(targetChatId), "CryptoGuy Academy");
  const sourceTopics = new Map();
  const targetTopics = new Map();
  for (let number = 1; number <= 7; number += 1) {
    sourceTopics.set(number, standardTopic(sourceGroup, number, "DEMO Academy"));
    targetTopics.set(number, standardTopic(targetGroup, number, "CryptoGuy Academy"));
  }

  const automations = STANDARD_AUTOMATION_SPECS.map((spec) => {
    const targets = [standardEndpoint(sourceGroup, sourceTopics.get(spec.topicNumber), spec.topicNumber)];
    if (!spec.demoOnly) {
      targets.push(standardEndpoint(targetGroup, targetTopics.get(spec.topicNumber), spec.topicNumber));
    }
    const desired = {
      id: spec.id,
      kind: "automation",
      name: spec.name,
      contentType: spec.contentType,
      schedulePreset: spec.schedulePreset,
      targets,
      enabled: false,
      status: "ready",
      forceDisabled: spec.forceDisabled,
    };
    return mergeStandardRule(desired, migratedCurrentRules, spec.topicNumber);
  });

  const broadcasts = Array.from({ length: 7 }, (_, index) => {
    const number = index + 1;
    const desired = {
      id: `production-broadcast-topic-${number}`,
      kind: "broadcast",
      name: `Topic ${number} · DEMO → CryptoGuy`,
      mode: "automatic",
      source: standardEndpoint(sourceGroup, sourceTopics.get(number), number),
      targets: [standardEndpoint(targetGroup, targetTopics.get(number), number)],
      enabled: false,
      status: "ready",
    };
    return mergeStandardRule(desired, migratedCurrentRules, number);
  });

  return [...automations, ...broadcasts];
}

function authoritativeTopicForTarget(target, groups) {
  if (!target?.chatId) return null;
  if (target?.chatType === "channel") return null;
  const group = (Array.isArray(groups) ? groups : []).find((item) => String(item?.chatId ?? item?.id ?? "") === String(target.chatId));
  if (!group) return null;
  const resolvedTopics = (Array.isArray(group.topics) ? group.topics : []).filter((topic) => {
    const resolvedThreadId = threadId(topic?.threadId ?? topic?.topicId ?? topic?.id);
    return resolvedThreadId && topic?.verified !== false;
  });
  const configuredThreadId = threadId(target?.threadId);
  let matches = configuredThreadId
    ? resolvedTopics.filter((topic) => threadId(topic?.threadId ?? topic?.topicId ?? topic?.id) === configuredThreadId)
    : [];
  const name = canonicalTopicName(target?.topicName);
  if (!matches.length && name) {
    matches = resolvedTopics.filter((topic) => canonicalTopicName(topic?.name ?? topic?.title) === name);
  }
  if (!matches.length) {
    // Prefer the semantic slot over a stale numeric prefix.  A topic can be
    // renamed/reordered (for example an old `7. CryptoGuy Trading Zone`),
    // while its stable routing identity is still the Trading Zone slot (2).
    const sequence = semanticTopicSequence(target?.topicName) ?? topicSequence(target?.topicName);
    if (sequence) matches = resolvedTopics.filter((topic) => topicMatchesSequence(topic?.name ?? topic?.title, sequence));
  }
  if (matches.length !== 1) return null;
  const expectedThreadId = threadId(matches[0]?.threadId ?? matches[0]?.topicId ?? matches[0]?.id);
  return expectedThreadId ? { group, topic: matches[0], expectedThreadId } : null;
}

function normalizeTarget(target, index = 0) {
  const platform = target?.platform === "discord" || target?.guildId || target?.channelId
    ? "discord"
    : "telegram";
  if (platform === "discord") {
    return {
      platform: "discord",
      id: stringId(target?.id),
      guildId: stringId(target?.guildId ?? target?.serverId),
      channelId: stringId(target?.channelId),
      groupName: String(target?.groupName ?? target?.guildName ?? target?.serverName ?? "").trim(),
      topicName: String(target?.topicName ?? target?.channelName ?? target?.channel ?? "").trim(),
      ...normalizeTargetCta(target),
      enabled: target?.enabled !== false,
      order: Number.isFinite(Number(target?.order)) ? Number(target.order) : index
    };
  }
  const chatId = stringId(target?.chatId ?? target?.chat_id);
  const normalizedThreadId = threadId(target?.threadId ?? target?.topicId ?? target?.message_thread_id);
  const chatType = target?.chatType === "channel" || target?.type === "channel" ? "channel" : "supergroup";
  return {
    id: stringId(target?.id),
    chatId,
    chatType,
    threadId: chatType === "channel" ? null : normalizedThreadId,
    groupName: String(target?.groupName ?? target?.group ?? "").trim(),
    topicName: String(target?.topicName ?? target?.topic ?? "").trim(),
    ...normalizeTargetCta(target),
    enabled: target?.enabled !== false,
    order: Number.isFinite(Number(target?.order)) ? Number(target.order) : index
  };
}

export function normalizeDistributionRule(input = {}) {
  const kind = input.kind === "broadcast" ? "broadcast" : "automation";
  const sourceChatType = input.source?.chatType === "channel" || input.source?.type === "channel" ? "channel" : "supergroup";
  const source = kind === "broadcast" ? {
    chatId: stringId(input.source?.chatId ?? input.sourceChatId),
    chatType: sourceChatType,
    threadId: sourceChatType === "channel" ? null : threadId(input.source?.threadId ?? input.sourceThreadId),
    groupName: String(input.source?.groupName ?? "").trim(),
    topicName: String(input.source?.topicName ?? "").trim()
  } : null;
  const targetMap = new Map();
  for (const [index, target] of (Array.isArray(input.targets) ? input.targets : []).entries()) {
    const normalized = normalizeTarget(target, index);
    if (kind === "broadcast" && normalized.platform === "discord") continue;
    if (normalized.platform === "discord" && (!normalized.guildId || !normalized.channelId)) continue;
    if (normalized.platform !== "discord" && !normalized.chatId) continue;
    const key = normalized.platform === "discord"
      ? `discord:${normalized.guildId}:${normalized.channelId}`
      : normalized.chatType === "channel"
        ? `${normalized.chatId}:channel`
        : `${normalized.chatId}:${normalized.threadId ?? 0}`;
    if (!targetMap.has(key)) targetMap.set(key, normalized);
  }
  const normalizedTargets = [...targetMap.values()];
  const identity = {
    kind,
    name: String(input.name ?? "").trim(),
    source,
    targets: normalizedTargets.map((target) => target.platform === "discord"
      ? { platform: "discord", guildId: target.guildId, channelId: target.channelId }
      : {
          chatId: target.chatId,
          threadId: target.threadId,
          ...(target.chatType === "channel" ? { chatType: target.chatType } : {})
        })
  };
  const id = stringId(input.id) || stableId("rule", identity);
  const targets = normalizedTargets.map((target) => {
    const targetIdentity = target.platform === "discord"
      ? { platform: "discord", guildId: target.guildId, channelId: target.channelId }
      : {
          chatId: target.chatId,
          threadId: target.threadId,
          ...(target.chatType === "channel" ? { chatType: "channel" } : {})
        };
    const legacyId = stableId("target", targetIdentity);
    return {
      ...target,
      id: target.id && target.id !== legacyId
        ? target.id
        : stableId("target", { ruleId: id, ...targetIdentity })
    };
  });
  return {
    id,
    kind,
    name: identity.name,
    contentType: kind === "automation" ? String(input.contentType ?? "").trim() : null,
    schedulePreset: kind === "automation"
      ? (String(input.contentType ?? "").trim() === "whale-signals" ? "hourly" : String(input.schedulePreset ?? "").trim())
      : null,
    mode: kind === "broadcast" && input.mode === "review" ? "review" : "automatic",
    source,
    targets,
    enabled: input.enabled !== false,
    runOnce: kind === "automation" && input.runOnce === true,
    status: String(input.status ?? "ready"),
    nextRunAt: input.nextRunAt ? new Date(input.nextRunAt).toISOString() : null,
    leaseUntil: input.leaseUntil ? new Date(input.leaseUntil).toISOString() : null,
    importedFrom: input.importedFrom ?? null,
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

export function findDistributionTargetMismatches(ruleInput, groups = []) {
  const rule = normalizeDistributionRule(ruleInput);
  return rule.targets.flatMap((target) => {
    const match = authoritativeTopicForTarget(target, groups);
    if (!match || target.threadId === match.expectedThreadId) return [];
    return [{
      targetId: target.id,
      chatId: target.chatId,
      topicName: target.topicName,
      configuredThreadId: target.threadId,
      expectedThreadId: match.expectedThreadId
    }];
  });
}

export function reconcileDistributionTargets(ruleInput, groups = []) {
  const rule = normalizeDistributionRule(ruleInput);
  return normalizeDistributionRule({
    ...rule,
    targets: rule.targets.map((target) => {
      const match = authoritativeTopicForTarget(target, groups);
      if (!match) return target;
      return {
        ...target,
        threadId: match.expectedThreadId,
        groupName: String(match.group?.title ?? match.group?.name ?? target.groupName ?? "").trim(),
        topicName: standardTopicDisplayName(match.topic) || target.topicName
      };
    })
  });
}

export function findDistributionSourceMismatch(ruleInput, groups = []) {
  const rule = normalizeDistributionRule(ruleInput);
  if (rule.kind !== "broadcast" || !rule.source) return null;
  const match = authoritativeTopicForTarget({
    chatId: rule.source.chatId,
    chatType: rule.source.chatType,
    threadId: rule.source.threadId,
    topicName: rule.source.topicName
  }, groups);
  if (!match || rule.source.threadId === match.expectedThreadId) return null;
  return {
    chatId: rule.source.chatId,
    topicName: rule.source.topicName,
    configuredThreadId: rule.source.threadId,
    expectedThreadId: match.expectedThreadId
  };
}

export function reconcileDistributionRouting(ruleInput, groups = []) {
  const rule = reconcileDistributionTargets(ruleInput, groups);
  if (rule.kind !== "broadcast" || !rule.source) return rule;
  const match = authoritativeTopicForTarget(rule.source, groups);
  if (!match) return rule;
  return normalizeDistributionRule({
    ...rule,
    source: {
      ...rule.source,
      threadId: match.expectedThreadId,
      groupName: String(match.group?.title ?? match.group?.name ?? rule.source.groupName ?? "").trim(),
      topicName: standardTopicDisplayName(match.topic) || rule.source.topicName
    }
  });
}

export function validateDistributionRule(ruleInput) {
  const rule = normalizeDistributionRule(ruleInput);
  const errors = [];
  if (!rule.name) errors.push({ field: "name", message: "请输入规则名称" });
  if (rule.kind === "automation") {
    if (!rule.contentType) errors.push({ field: "contentType", message: "请选择内容任务" });
    if (!DISTRIBUTION_SCHEDULES[rule.schedulePreset]) errors.push({ field: "schedulePreset", message: "请选择有效频率" });
    if (rule.runOnce && !rule.nextRunAt) errors.push({ field: "nextRunAt", message: "一次性任务必须设置执行时间" });
  }
  if (rule.kind === "broadcast" && !rule.source?.chatId) {
    errors.push({ field: "source.chatId", message: "请选择来源群或频道" });
  }
  if (rule.kind === "broadcast"
    && rule.source?.chatId
    && rule.source.chatType !== "channel"
    && !rule.source.threadId) {
    errors.push({ field: "source.threadId", message: "来源群必须选择 Topic" });
  }
  if (!rule.targets.length) errors.push({ field: "targets", message: "至少选择一个目标群 Topic 或频道" });
  for (const target of rule.targets) {
    if (target.ctaEnabled && !target.ctaText && !target.ctaUrl) {
      errors.push({ field: "targets.ctaText", message: "已开启 CTA 的目标需要填写 CTA 文案或链接" });
    }
    if (target.ctaUrl && !isAllowedCtaUrl(target.ctaUrl)) {
      errors.push({ field: "targets.ctaUrl", message: "CTA 链接必须使用 http 或 https" });
    }
    if (target.platform === "discord") {
      if (!target.guildId || !target.channelId) {
        errors.push({ field: "targets", message: "Discord 目标服务器或频道无效" });
      }
      continue;
    }
    if (!target.chatId) errors.push({ field: "targets", message: "目标群 ID 无效" });
    if (target.chatType !== "channel" && !target.threadId) {
      errors.push({ field: "targets", message: "目标群必须选择 Topic" });
    }
    if (rule.kind === "broadcast"
      && target.chatId === rule.source?.chatId) {
      errors.push({ field: "targets", message: "来源群不能同时作为目标群，请选择其他群的 Topic" });
    }
  }
  return errors;
}

export function computeNextRunAt(preset, nowValue = new Date()) {
  const now = new Date(nowValue);
  if (Number.isNaN(now.getTime())) throw new TypeError("Invalid current time");
  if (!DISTRIBUTION_SCHEDULES[preset]) throw new TypeError(`Unknown schedule preset: ${preset}`);

  if (preset === "daily-0800-utc") {
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }

  if (preset === "weekly-monday-0030-utc") {
    const daysUntilMonday = (8 - now.getUTCDay()) % 7;
    const next = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + daysUntilMonday,
      0,
      30,
    ));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 7);
    return next;
  }

  const intervalMs = DISTRIBUTION_SCHEDULES[preset].minutes * 60 * 1000;
  return new Date((Math.floor(now.getTime() / intervalMs) + 1) * intervalMs);
}

const MARKET_CONTENT_MIGRATIONS = Object.freeze({
  news: Object.freeze({ contentType: "crypto-daily", schedulePreset: "daily-0800-utc" }),
  "daily-events": Object.freeze({ contentType: "weekly-calendar", schedulePreset: "weekly-monday-0030-utc" }),
});

function migratedNextRunAt(rule, schedulePreset, now) {
  if (rule.runOnce || rule.enabled === false) return rule.nextRunAt;
  return computeNextRunAt(schedulePreset, now).toISOString();
}

function releaseRuleId(calendarRuleId) {
  return `${calendarRuleId}-data-release-updates`;
}

export function migrateMarketContentRules(rules = [], nowValue = new Date()) {
  const now = new Date(nowValue);
  if (Number.isNaN(now.getTime())) throw new TypeError("Invalid current time");
  const normalized = (Array.isArray(rules) ? rules : []).map((rule) => normalizeDistributionRule(rule));
  const inputIds = new Set();
  for (const rule of normalized) {
    if (inputIds.has(rule.id)) throw new Error(`Duplicate rule id in market content migration: ${rule.id}`);
    inputIds.add(rule.id);
  }
  const changes = [];
  const migrated = normalized.map((rule) => {
    if (rule.kind !== "automation") return rule;
    const migration = MARKET_CONTENT_MIGRATIONS[rule.contentType];
    if (!migration) return rule;
    const updated = normalizeDistributionRule({
      ...rule,
      ...migration,
      nextRunAt: migratedNextRunAt(rule, migration.schedulePreset, now),
    });
    changes.push({
      action: "update",
      id: rule.id,
      fromContentType: rule.contentType,
      toContentType: migration.contentType,
    });
    return updated;
  });

  const calendars = migrated.filter((rule) => rule.kind === "automation" && rule.contentType === "weekly-calendar");
  const calendarIds = new Set(calendars.map((calendar) => calendar.id));
  const rulesById = new Map(migrated.map((rule) => [rule.id, rule]));
  const associatedReleaseIds = new Map();

  for (const calendar of calendars) {
    const id = releaseRuleId(calendar.id);
    const occupied = rulesById.get(id);
    if (!occupied) continue;
    if (occupied.kind !== "automation" || occupied.contentType !== "data-release-updates") {
      throw new Error(`Market content migration conflict: ${id} is occupied by an unrelated rule`);
    }
    if (occupied.importedFrom && occupied.importedFrom !== calendar.id) {
      throw new Error(`Market content migration conflict: ${id} links to ${occupied.importedFrom}, not ${calendar.id}`);
    }
  }

  for (const release of migrated.filter((rule) => rule.kind === "automation" && rule.contentType === "data-release-updates")) {
    if (release.importedFrom && !calendarIds.has(release.importedFrom)) {
      throw new Error(`Market content migration conflict: ${release.id} links to missing calendar ${release.importedFrom}`);
    }
    const derivedCalendar = calendars.find((calendar) => release.id === releaseRuleId(calendar.id));
    const parentId = release.importedFrom && calendarIds.has(release.importedFrom)
      ? release.importedFrom
      : derivedCalendar?.id;
    if (!parentId) continue;
    const previous = associatedReleaseIds.get(parentId);
    if (previous && previous !== release.id) {
      throw new Error(`Market content migration conflict: calendar ${parentId} has multiple data-release-updates siblings`);
    }
    associatedReleaseIds.set(parentId, release.id);
  }

  for (const calendar of calendars) {
    if (associatedReleaseIds.has(calendar.id)) continue;
    const id = releaseRuleId(calendar.id);
    const release = normalizeDistributionRule({
      ...calendar,
      id,
      name: `${calendar.name || "Weekly Calendar"} · Data Release Updates`,
      contentType: "data-release-updates",
      schedulePreset: "event-driven",
      targets: calendar.targets.map(({ id: _targetId, ...target }) => target),
      enabled: false,
      runOnce: false,
      nextRunAt: null,
      leaseUntil: null,
      status: calendar.targets.length ? "ready" : "pending-confirmation",
      importedFrom: calendar.id,
      createdAt: null,
      updatedAt: null,
    });
    migrated.push(release);
    rulesById.set(id, release);
    associatedReleaseIds.set(calendar.id, id);
    changes.push({ action: "create", id, sourceRuleId: calendar.id, contentType: "data-release-updates" });
  }

  return { rules: migrated, changes };
}

export function ensureAutomationNextRunAt(rule, nowValue = new Date()) {
  if (rule?.kind !== "automation" || rule.enabled === false || rule.runOnce || rule.nextRunAt || !DISTRIBUTION_SCHEDULES[rule.schedulePreset]) {
    return rule;
  }
  return { ...rule, nextRunAt: computeNextRunAt(rule.schedulePreset, nowValue).toISOString() };
}

function automationSpec(name = "") {
  const normalized = name.toLowerCase();
  if (normalized.includes("daily events") || normalized.includes("market event")) {
    return { contentType: "daily-events", schedulePreset: "daily-0800-utc" };
  }
  if (normalized.includes("daily analysis") || normalized.includes("market analysis")) {
    return { contentType: "daily-analysis", schedulePreset: "daily-0800-utc" };
  }
  if (normalized.includes("whale") || normalized.includes("巨鲸") || normalized.includes("大户")) {
    return { contentType: "whale-signals", schedulePreset: "hourly" };
  }
  if (normalized.includes("agent") || normalized.includes("代理")) {
    return { contentType: "agent-sync", schedulePreset: "hourly" };
  }
  return { contentType: "news", schedulePreset: "every-15-minutes" };
}

function findLegacyTarget(binding, groups) {
  const group = groups.find((item) => item.title === binding.group || item.name === binding.group);
  if (!group?.chatId) return null;
  const topics = Array.isArray(group.topics) ? group.topics : [];
  const topic = topics.find((item) => item.name === binding.topic || item.title === binding.topic);
  const topicValue = topic?.threadId ?? topic?.topicId;
  if (!topic || !threadId(topicValue)) return null;
  return {
    chatId: String(group.chatId),
    threadId: threadId(topicValue),
    groupName: String(group.title ?? group.name ?? ""),
    topicName: String(topic.name ?? topic.title ?? "")
  };
}

export function migrateLegacyDistribution(input = {}) {
  const groups = Array.isArray(input.groups) ? input.groups : [];
  const bindings = Array.isArray(input.bindings) ? input.bindings : [];
  const automaticRules = [];
  const pendingRules = [];

  for (const binding of bindings) {
    if (String(binding.type).includes("广播")) {
      pendingRules.push(normalizeDistributionRule({
        id: stableId("legacy", binding),
        kind: "broadcast",
        name: binding.config || "待确认广播规则",
        enabled: false,
        status: "pending-confirmation",
        source: {},
        targets: [],
        importedFrom: "group-config.json"
      }));
      continue;
    }
    const target = findLegacyTarget(binding, groups);
    const spec = automationSpec(binding.config);
    const rule = normalizeDistributionRule({
      id: stableId("legacy", binding),
      kind: "automation",
      name: binding.config || binding.type || "自动任务",
      ...spec,
      targets: target ? [target] : [],
      enabled: Boolean(target) && String(binding.status ?? "").includes("启用"),
      status: target ? "ready" : "pending-confirmation",
      importedFrom: "group-config.json"
    });
    // Keep the migrated document compatible with the old binding shape. The
    // repository normalizes and assigns stable target IDs when it imports it.
    rule.targets = rule.targets.map(({ chatId, threadId: migratedThreadId, groupName, topicName }) => ({
      chatId,
      threadId: migratedThreadId,
      groupName,
      topicName
    }));
    (target ? automaticRules : pendingRules).push(rule);
  }

  const broadcastRules = (Array.isArray(input.broadcastRules) ? input.broadcastRules : []).map((legacy) => normalizeDistributionRule({
    id: stableId("legacy-broadcast", legacy),
    kind: "broadcast",
    name: legacy.name || "Telegram 广播",
    source: {
      chatId: legacy.chatId,
      threadId: legacy.topicId,
      groupName: legacy.groupName,
      topicName: legacy.topic
    },
    targets: [],
    enabled: false,
    status: "pending-confirmation",
    importedFrom: "broadcast-rules.json"
  }));

  return { automaticRules, broadcastRules, pendingRules };
}
