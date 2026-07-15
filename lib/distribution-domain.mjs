import { createHash } from "node:crypto";

export const DISTRIBUTION_SCHEDULES = Object.freeze({
  "daily-0800-utc": { label: "每日 08:00 UTC", minutes: 24 * 60 },
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

function authoritativeTopicForTarget(target, groups) {
  if (!target?.chatId) return null;
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
    const sequence = topicSequence(target?.topicName);
    if (sequence) matches = resolvedTopics.filter((topic) => topicSequence(topic?.name ?? topic?.title) === sequence);
  }
  if (matches.length !== 1) return null;
  const expectedThreadId = threadId(matches[0]?.threadId ?? matches[0]?.topicId ?? matches[0]?.id);
  return expectedThreadId ? { group, topic: matches[0], expectedThreadId } : null;
}

function normalizeTarget(target, index = 0) {
  const chatId = stringId(target?.chatId ?? target?.chat_id);
  const normalizedThreadId = threadId(target?.threadId ?? target?.topicId ?? target?.message_thread_id);
  return {
    id: stringId(target?.id),
    chatId,
    threadId: normalizedThreadId,
    groupName: String(target?.groupName ?? target?.group ?? "").trim(),
    topicName: String(target?.topicName ?? target?.topic ?? "").trim(),
    enabled: target?.enabled !== false,
    order: Number.isFinite(Number(target?.order)) ? Number(target.order) : index
  };
}

export function normalizeDistributionRule(input = {}) {
  const kind = input.kind === "broadcast" ? "broadcast" : "automation";
  const source = kind === "broadcast" ? {
    chatId: stringId(input.source?.chatId ?? input.sourceChatId),
    threadId: threadId(input.source?.threadId ?? input.sourceThreadId),
    groupName: String(input.source?.groupName ?? "").trim(),
    topicName: String(input.source?.topicName ?? "").trim()
  } : null;
  const targetMap = new Map();
  for (const [index, target] of (Array.isArray(input.targets) ? input.targets : []).entries()) {
    const normalized = normalizeTarget(target, index);
    if (!normalized.chatId) continue;
    const key = `${normalized.chatId}:${normalized.threadId ?? 0}`;
    if (!targetMap.has(key)) targetMap.set(key, normalized);
  }
  const normalizedTargets = [...targetMap.values()];
  const identity = {
    kind,
    name: String(input.name ?? "").trim(),
    source,
    targets: normalizedTargets.map(({ chatId, threadId: topic }) => ({ chatId, threadId: topic }))
  };
  const id = stringId(input.id) || stableId("rule", identity);
  const targets = normalizedTargets.map((target) => {
    const legacyId = stableId("target", { chatId: target.chatId, threadId: target.threadId });
    return {
      ...target,
      id: target.id && target.id !== legacyId
        ? target.id
        : stableId("target", { ruleId: id, chatId: target.chatId, threadId: target.threadId })
    };
  });
  return {
    id,
    kind,
    name: identity.name,
    contentType: kind === "automation" ? String(input.contentType ?? "").trim() : null,
    schedulePreset: kind === "automation"
      ? (String(input.contentType ?? "").trim() === "whale-signals" ? "daily-0800-utc" : String(input.schedulePreset ?? "").trim())
      : null,
    mode: kind === "broadcast" && input.mode === "review" ? "review" : "automatic",
    source,
    targets,
    enabled: input.enabled !== false,
    status: String(input.status ?? "ready"),
    nextRunAt: input.nextRunAt ? new Date(input.nextRunAt).toISOString() : null,
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
        topicName: String(match.topic?.name ?? match.topic?.title ?? target.topicName ?? "").trim()
      };
    })
  });
}

export function findDistributionSourceMismatch(ruleInput, groups = []) {
  const rule = normalizeDistributionRule(ruleInput);
  if (rule.kind !== "broadcast" || !rule.source) return null;
  const match = authoritativeTopicForTarget({
    chatId: rule.source.chatId,
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
      topicName: String(match.topic?.name ?? match.topic?.title ?? rule.source.topicName ?? "").trim()
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
  }
  if (rule.kind === "broadcast" && !rule.source?.chatId) {
    errors.push({ field: "source.chatId", message: "请选择来源群或频道" });
  }
  if (!rule.targets.length) errors.push({ field: "targets", message: "至少选择一个目标 Topic" });
  for (const target of rule.targets) {
    if (!target.chatId) errors.push({ field: "targets", message: "目标群 ID 无效" });
    if (rule.kind === "broadcast"
      && target.chatId === rule.source?.chatId
      && target.threadId === rule.source?.threadId) {
      errors.push({ field: "targets", message: "来源 Topic 不能同时作为目标，请检查群和 Topic 绑定" });
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

  const intervalMs = DISTRIBUTION_SCHEDULES[preset].minutes * 60 * 1000;
  return new Date((Math.floor(now.getTime() / intervalMs) + 1) * intervalMs);
}

export function ensureAutomationNextRunAt(rule, nowValue = new Date()) {
  if (rule?.kind !== "automation" || rule.enabled === false || rule.nextRunAt || !DISTRIBUTION_SCHEDULES[rule.schedulePreset]) {
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
    return { contentType: "whale-signals", schedulePreset: "daily-0800-utc" };
  }
  if (normalized.includes("agent") || normalized.includes("代理")) {
    return { contentType: "agent-sync", schedulePreset: "every-4-hours" };
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
