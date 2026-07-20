import { NextResponse } from "next/server";
import { readJson, writeJson } from "../../../lib/json-store";
import { resolveDiscoveredGroups } from "../../../lib/group-config-policy.mjs";
import {
  mergeExpectedForumTopics,
  orderTopicsByTemplate,
  telegramSystemTopicThreadIds
} from "../../../lib/telegram-discovery.mjs";
import { defaultTopicTemplate, topicDisplayName } from "../../../templates.mjs";

export const dynamic = "force-dynamic";

const groupConfigPath = "group-config.json";
const legacySeedBindingIds = new Set(["news-market-events", "signal-market-analysis", "broadcast-market-events", "ricky-social", "official-updates"]);
const expectedForumTopics = defaultTopicTemplate.map((topic) => ({ id: String(topic.id || ""), name: topicDisplayName(topic) }));

export async function GET() {
  const config = normalizeGroupConfig(await readJson(groupConfigPath, {}));
  return NextResponse.json({ ok: true, ...config });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const existingConfig = normalizeGroupConfig(await readJson(groupConfigPath, {}));

  if (Array.isArray(body.groups)) {
    const incomingGroups = normalizeGroups(body.groups);
    const resolution = body.mode === "telegram-refresh"
      ? resolveDiscoveredGroups(existingConfig.groups, incomingGroups)
      : { groups: incomingGroups, preservedExisting: false };
    const groups = resolution.groups;
    const config = { schemaVersion: 2, groups, bindings: existingConfig.bindings, updatedAt: new Date().toISOString() };
    await writeJson(groupConfigPath, config);
    return NextResponse.json({
      ok: true,
      ...normalizeGroupConfig(config),
      preservedExisting: resolution.preservedExisting,
      warning: resolution.preservedExisting ? "Telegram 本次未返回群；已保留上一次成功保存的群配置。" : ""
    });
  }

  if (Array.isArray(body.bindings)) {
    const config = { schemaVersion: 2, groups: existingConfig.groups, bindings: normalizeBindings(body.bindings), updatedAt: new Date().toISOString() };
    await writeJson(groupConfigPath, config);
    return NextResponse.json({ ok: true, ...normalizeGroupConfig(config) });
  }

  const chatId = String(body.chatId || "").trim();
  if (!chatId) {
    return NextResponse.json({ ok: false, error: "Missing chatId" }, { status: 400 });
  }
  const group = normalizeGroup({
    chatId,
    title: String(body.title || "").trim() || chatId,
    type: String(body.type || "supergroup"),
    username: String(body.username || ""),
    isPrivateChannel: body.isPrivateChannel === true,
    canUseTopics: body.type === "channel" ? false : body.canUseTopics !== false,
    channelPublishingReady: body.channelPublishingReady === true,
    distributionReady: body.distributionReady === true
  });
  const groups = [group, ...existingConfig.groups.filter((item) => item.chatId !== group.chatId)];
  const config = { schemaVersion: 2, groups, bindings: existingConfig.bindings, updatedAt: new Date().toISOString() };
  await writeJson(groupConfigPath, config);
  return NextResponse.json({ ok: true, ...normalizeGroupConfig(config) });
}

function normalizeGroupConfig(config) {
  const groups = normalizeGroups(Array.isArray(config?.groups) ? config.groups : config?.chatId ? [config] : []);
  const storedBindings = Array.isArray(config?.bindings) ? config.bindings : [];
  const bindings = config?.schemaVersion === 2 ? storedBindings : storedBindings.filter((binding) => !legacySeedBindingIds.has(String(binding?.id || "")));
  return {
    schemaVersion: 2,
    groups,
    group: groups[0] || null,
    bindings: normalizeBindings(bindings),
    updatedAt: config?.updatedAt || config?.savedAt || null
  };
}

function normalizeGroups(groups) {
  const unique = new Map();
  for (const group of groups) {
    const normalized = normalizeGroup(group);
    if (normalized.chatId) unique.set(normalized.chatId, normalized);
  }
  return [...unique.values()];
}

function normalizeGroup(group) {
  const chatId = String(group?.chatId || group?.id || "").trim();
  const bots = Array.isArray(group?.bots) ? group.bots.map((bot) => ({
    name: String(bot?.name || ""),
    role: String(bot?.role || ""),
    username: String(bot?.username || ""),
    status: String(bot?.status || ""),
    membership: String(bot?.membership || "unknown"),
    isAdmin: bot?.isAdmin === true,
    canManageTopics: bot?.canManageTopics === true,
    identityVerified: bot?.identityVerified !== false,
    permissions: bot?.permissions && typeof bot.permissions === "object" ? {
      canDeleteMessages: bot.permissions.canDeleteMessages === true,
      canPinMessages: bot.permissions.canPinMessages === true,
      canChangeInfo: bot.permissions.canChangeInfo === true,
      canPostMessages: bot.permissions.canPostMessages === true,
      canEditMessages: bot.permissions.canEditMessages === true
    } : null,
    warning: String(bot?.warning || "")
  })).filter((bot) => bot.name) : [];
  const adminBotCount = bots.filter((bot) => bot.isAdmin).length;
  const storedTopics = normalizeTopics(group?.topics || []);
  const systemThreadIds = telegramSystemTopicThreadIds(storedTopics);
  const canUseTopics = group?.isForum === true || group?.canUseTopics === true;
  const topics = canUseTopics
    ? orderTopicsByTemplate(mergeExpectedForumTopics(storedTopics, expectedForumTopics), expectedForumTopics)
    : storedTopics;
  const detectedTopicThreadIds = normalizeThreadIds([
    ...(Array.isArray(group?.detectedTopicThreadIds) ? group.detectedTopicThreadIds : [])
      .filter((threadId) => !systemThreadIds.has(Number(threadId))),
    ...topics.map((topic) => topic.threadId)
  ]);
  const resolvedTopicCount = topics.filter((topic) => topic.threadId).length;
  return {
    chatId,
    title: String(group?.title || chatId).trim(),
    type: String(group?.type || "supergroup"),
    username: String(group?.username || ""),
    isPrivateChannel: group?.type === "channel" && (group?.isPrivateChannel === true || !group?.username),
    isForum: group?.isForum === true,
    canUseTopics,
    topics,
    detectedTopicThreadIds,
    topicCoverage: {
      knownCount: topics.length,
      resolvedCount: resolvedTopicCount,
      detectedThreadCount: detectedTopicThreadIds.length,
      complete: topics.length > 0 && resolvedTopicCount === topics.length
    },
    bots,
    botCount: Number(group?.botCount || bots.filter((bot) => bot.membership !== "unknown" && bot.membership !== "not_found").length),
    adminBotCount: Number(group?.adminBotCount ?? adminBotCount),
    allBotsAdmin: group?.allBotsAdmin === true,
    allBotIdentitiesVerified: group?.allBotIdentitiesVerified !== false,
    channelPublishingReady: group?.channelPublishingReady === true,
    distributionReady: group?.distributionReady === true,
    readyForInitialization: group?.readyForInitialization === true,
    initializationBlockReason: String(group?.initializationBlockReason || ""),
    source: String(group?.source || ""),
    lastSeenAt: group?.lastSeenAt || null,
    savedAt: group?.savedAt || new Date().toISOString()
  };
}

function normalizeBindings(bindings) {
  return bindings.map((binding, index) => ({
    id: String(binding?.id || `binding-${index + 1}`),
    group: String(binding?.group || ""),
    topic: String(binding?.topic || ""),
    topicId: binding?.topicId ? Number(binding.topicId) : null,
    type: String(binding?.type || ""),
    config: String(binding?.config || ""),
    bot: String(binding?.bot || ""),
    frequency: String(binding?.frequency || ""),
    status: String(binding?.status || "已启用")
  })).filter((binding) => binding.group && binding.topic && binding.config);
}

function normalizeTopics(topics) {
  const unique = new Map();
  for (const topic of Array.isArray(topics) ? topics : []) {
    const name = String(topic?.name || topic?.title || "").trim();
    const threadId = Number(topic?.threadId || topic?.message_thread_id || topic?.id || 0);
    if (!name) continue;
    const key = threadId ? String(threadId) : name;
    unique.set(key, {
      id: threadId || name,
      threadId: threadId || null,
      name,
      source: String(topic?.source || (threadId ? "telegram" : "template")),
      verified: topic?.verified === true || Boolean(threadId)
    });
  }
  return [...unique.values()].sort((a, b) => Number(a.threadId || 999999) - Number(b.threadId || 999999));
}

function normalizeThreadIds(threadIds) {
  return [...new Set((Array.isArray(threadIds) ? threadIds : [])
    .map((threadId) => Number(threadId || 0))
    .filter((threadId) => Number.isInteger(threadId) && threadId > 0))]
    .sort((a, b) => a - b);
}
