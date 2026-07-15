const ACTIVE_MEMBER_STATUSES = new Set(["creator", "administrator", "member", "restricted"]);

export function collectTelegramChatCandidates(updates = [], savedGroups = []) {
  const chats = new Map();
  const migrations = new Map();

  for (const update of updates) {
    for (const message of telegramMessages(update)) {
      const chat = message?.chat;
      if (!chat || !["group", "supergroup", "channel"].includes(chat.type)) continue;
      const chatId = String(chat.id);
      const previous = chats.get(chatId) || { topics: [], detectedTopicThreadIds: [] };
      const topicName = message.forum_topic_created?.name || message.forum_topic_edited?.name;
      const topics = [...previous.topics];
      if (topicName && message.message_thread_id) {
        topics.push({ id: message.message_thread_id, threadId: message.message_thread_id, name: topicName, source: "telegram-event", verified: true });
      }
      const detectedTopicThreadIds = normalizeThreadIds([
        ...(previous.detectedTopicThreadIds || []),
        message.message_thread_id
      ]);
      chats.set(chatId, {
        ...previous,
        id: chat.id,
        chatId,
        title: chat.title || chat.username || previous.title || chatId,
        type: chat.type,
        topics: normalizeTopics(topics),
        detectedTopicThreadIds,
        source: previous.source === "saved-config" ? "telegram+saved" : "telegram"
      });

      if (message.migrate_to_chat_id) migrations.set(chatId, String(message.migrate_to_chat_id));
      if (message.migrate_from_chat_id) migrations.set(String(message.migrate_from_chat_id), chatId);
    }
  }

  for (const group of savedGroups) {
    const chatId = String(group?.chatId || group?.id || "").trim();
    if (!chatId || migrations.has(chatId)) continue;
    const previous = chats.get(chatId);
    chats.set(chatId, {
      id: Number(chatId) || chatId,
      chatId,
      title: String(previous?.title || group?.title || chatId),
      type: String(previous?.type || group?.type || "supergroup"),
      topics: normalizeTopics([...(group?.topics || []), ...(previous?.topics || [])]),
      detectedTopicThreadIds: normalizeThreadIds([
        ...(group?.detectedTopicThreadIds || []),
        ...(previous?.detectedTopicThreadIds || [])
      ]),
      source: previous ? "telegram+saved" : "saved-config"
    });
  }

  const active = [...chats.values()]
    .filter((chat) => !migrations.has(chat.chatId))
    .map((chat) => {
      const migratedFrom = [...migrations.entries()].filter(([, target]) => target === chat.chatId).map(([source]) => source);
      return { ...chat, migratedFrom };
    });
  const migrated = [...migrations.entries()].map(([fromChatId, toChatId]) => ({ fromChatId, toChatId }));
  return { active, migrated };
}

export async function discoverTelegramChats({ token, botId, updates = [], savedGroups = [], telegram }) {
  const candidates = collectTelegramChatCandidates(updates, savedGroups);
  const groups = [];

  for (const candidate of candidates.active) {
    try {
      const [chatResponse, memberResponse] = await Promise.all([
        telegram(token, "getChat", { chat_id: candidate.chatId }),
        telegram(token, "getChatMember", { chat_id: candidate.chatId, user_id: botId })
      ]);
      const chat = chatResponse.result || {};
      const member = memberResponse.result || {};
      if (!ACTIVE_MEMBER_STATUSES.has(member.status)) continue;
      const isForum = chat.type === "supergroup" && chat.is_forum === true;
      groups.push({
        ...candidate,
        id: chat.id || candidate.id,
        chatId: String(chat.id || candidate.chatId),
        title: chat.title || candidate.title,
        type: chat.type || candidate.type,
        membership: member.status,
        isForum,
        canUseTopics: isForum,
        canManageTopics: isForum && (member.status === "creator" || member.can_manage_topics === true),
        permissions: {
          canDeleteMessages: member.status === "creator" || member.can_delete_messages === true,
          canPinMessages: member.status === "creator" || member.can_pin_messages === true,
          canChangeInfo: member.status === "creator" || member.can_change_info === true
        }
      });
    } catch (error) {
      groups.push({ ...candidate, membership: "unknown", isForum: false, canUseTopics: false, canManageTopics: false, warning: error.message });
    }
  }

  return { groups, migrated: candidates.migrated };
}

export function mergeBotGroupDiscoveries(bots = [], options = {}) {
  const chats = new Map();
  const expectedForumTopics = normalizeTopics(options.expectedForumTopics || []).map((topic) => ({
    ...topic,
    threadId: null,
    id: topic.name,
    source: "template",
    verified: false
  }));

  for (const bot of bots) {
    for (const group of bot.groups || []) {
      const chatId = String(group?.chatId || group?.id || "").trim();
      if (!chatId) continue;
      const previous = chats.get(chatId) || { chatId, topics: [], detectedTopicThreadIds: [], memberships: new Map() };
      previous.title = group.title || previous.title || chatId;
      previous.type = group.type || previous.type || "supergroup";
      previous.isForum = group.isForum === true || previous.isForum === true;
      previous.canUseTopics = group.canUseTopics === true || previous.canUseTopics === true;
      previous.topics = normalizeTopics([...(previous.topics || []), ...(group.topics || [])]);
      previous.detectedTopicThreadIds = normalizeThreadIds([
        ...(previous.detectedTopicThreadIds || []),
        ...(group.detectedTopicThreadIds || [])
      ]);
      previous.source = group.source?.includes("telegram") ? "telegram-live" : previous.source || group.source || "saved-config";
      previous.memberships.set(bot.name, group);
      chats.set(chatId, previous);
    }
  }

  return [...chats.values()].map((chat) => {
    const memberships = bots.map((bot) => {
      const group = chat.memberships.get(bot.name);
      const membership = group?.membership || "not_found";
      const isAdmin = membership === "creator" || membership === "administrator";
      return {
        name: bot.name,
        role: bot.role || "",
        username: bot.username || bot.expectedUsername || "",
        status: bot.status || "需检查",
        identityVerified: !bot.status || bot.status === "在线",
        membership,
        isAdmin,
        canManageTopics: group?.canManageTopics === true,
        permissions: group?.permissions || null,
        warning: group?.warning || bot.error || bot.updateWarning || ""
      };
    });
    const adminBotCount = memberships.filter((bot) => bot.isAdmin).length;
    const allBotsAdmin = bots.length > 0 && adminBotCount === bots.length;
    const allBotIdentitiesVerified = bots.length > 0 && memberships.every((bot) => bot.identityVerified);
    const forumReady = chat.isForum === true || chat.canUseTopics === true;
    const adminBot = memberships.find((bot) => bot.name === "AdminBot") || memberships[0];
    const adminBotCanManageTopics = adminBot?.canManageTopics === true;
    const adminBotCanPinMessages = adminBot?.membership === "creator" || adminBot?.permissions?.canPinMessages === true;
    const adminBotCanChangeInfo = adminBot?.membership === "creator" || adminBot?.permissions?.canChangeInfo === true;
    const readyForInitialization = allBotsAdmin && allBotIdentitiesVerified && forumReady && adminBotCanManageTopics && adminBotCanPinMessages && adminBotCanChangeInfo;
    const initializationBlockReason = !allBotsAdmin
      ? `三个 Bot 必须全部是管理员（当前 ${adminBotCount}/${bots.length}）`
      : !allBotIdentitiesVerified
        ? "Bot Token 身份与当前三个 Bot 配置不一致"
        : !forumReady
        ? "请先在 Telegram 群设置中开启 Topics，再刷新后初始化"
        : !adminBotCanManageTopics
          ? "AdminBot 缺少 Manage Topics 权限"
          : !adminBotCanPinMessages
            ? "AdminBot 缺少 Pin Messages 权限"
            : !adminBotCanChangeInfo
              ? "AdminBot 缺少 Change Group Info 权限"
              : "";
    const topics = chat.isForum === true
      ? mergeExpectedForumTopics(chat.topics, expectedForumTopics)
      : normalizeTopics(chat.topics);
    const detectedTopicThreadIds = normalizeThreadIds([
      ...(chat.detectedTopicThreadIds || []),
      ...topics.map((topic) => topic.threadId)
    ]);
    const resolvedCount = topics.filter((topic) => topic.threadId).length;
    const topicCoverage = {
      knownCount: topics.length,
      resolvedCount,
      detectedThreadCount: detectedTopicThreadIds.length,
      complete: topics.length > 0 && resolvedCount === topics.length
    };
    return {
      chatId: chat.chatId,
      id: Number(chat.chatId) || chat.chatId,
      title: chat.title,
      type: chat.type,
      isForum: chat.isForum === true,
      canUseTopics: chat.canUseTopics === true,
      topics,
      detectedTopicThreadIds,
      topicCoverage,
      source: chat.source,
      bots: memberships,
      botCount: memberships.filter((bot) => bot.membership !== "not_found" && bot.membership !== "unknown").length,
      adminBotCount,
      allBotsAdmin,
      allBotIdentitiesVerified,
      readyForInitialization,
      initializationBlockReason
    };
  }).sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
}

export function selectPreferredInitializationGroup(groups = [], preferredChatId = "") {
  const normalizedPreferredChatId = String(preferredChatId || "").trim();
  if (normalizedPreferredChatId) {
    return groups.find((group) => String(group.chatId) === normalizedPreferredChatId) || null;
  }
  return groups.find((group) => group.readyForInitialization) || groups[0] || null;
}

export function normalizeTopics(topics = []) {
  const unique = new Map();
  for (const topic of Array.isArray(topics) ? topics : []) {
    const name = String(topic?.name || topic?.title || "").trim();
    const threadId = Number(topic?.threadId || topic?.message_thread_id || topic?.id || 0);
    if (!name) continue;
    unique.set(threadId ? String(threadId) : name, {
      id: threadId || name,
      threadId: threadId || null,
      name,
      source: String(topic?.source || (threadId ? "telegram" : "saved-config")),
      verified: topic?.verified === true || Boolean(threadId)
    });
  }
  return [...unique.values()].sort((a, b) => Number(a.threadId || 999999) - Number(b.threadId || 999999));
}

export function mergeExpectedForumTopics(actualTopics, expectedTopics) {
  const actual = normalizeTopics(actualTopics);
  const expected = normalizeTopics(expectedTopics).map((topic) => ({
    ...topic,
    id: topic.name,
    threadId: null,
    source: "template",
    verified: false
  }));
  if (!expected.length) return actual;
  const matchedActual = new Set();
  const merged = expected.map((expectedTopic) => {
    const index = actual.findIndex((topic, candidateIndex) => (
      !matchedActual.has(candidateIndex) && sameManagedTopic(topic.name, expectedTopic.name)
    ));
    if (index < 0) return expectedTopic;
    matchedActual.add(index);
    return {
      ...actual[index],
      name: actual[index].threadId ? actual[index].name : expectedTopic.name
    };
  });
  actual.forEach((topic, index) => {
    const belongsToManagedSlot = expected.some((expectedTopic) => sameManagedTopic(topic.name, expectedTopic.name));
    if (!matchedActual.has(index) && !belongsToManagedSlot) merged.push(topic);
  });
  return merged;
}

export function reconcileGroupWithSetupState(group = {}, setupState = {}, expectedTopics = []) {
  const groupChatId = String(group?.chatId || group?.id || "");
  const stateChatId = String(setupState?.chatId || "");
  const stateTopics = setupState?.topics;
  if (!groupChatId || !stateChatId || groupChatId !== stateChatId || !stateTopics || typeof stateTopics !== "object") {
    return group;
  }

  const expected = normalizeTopics(expectedTopics);
  const actual = normalizeTopics(group?.topics || []);
  const managed = [];

  expected.forEach((expectedTopic, index) => {
    const sequence = topicSequence(expectedTopic.name) || String(index + 1);
    const progress = stateTopics[`topic_${sequence}`];
    const threadId = Number(progress?.message_thread_id || 0);
    if (!Number.isInteger(threadId) || threadId <= 0) return;
    const observed = actual.find((topic) => topic.threadId === threadId);
    managed.push({
      id: threadId,
      threadId,
      name: String(observed?.name || progress?.configuredName || expectedTopic.name).trim(),
      source: "setup-state",
      verified: true
    });
  });

  if (!managed.length) return group;

  const managedThreadIds = new Set(managed.map((topic) => topic.threadId));
  const managedSequences = new Set(managed.map((topic) => topicSequence(topic.name)).filter(Boolean));
  const managedCanonicalNames = new Set([
    ...managed.map((topic) => canonicalTopicName(topic.name)),
    ...expected.map((topic) => canonicalTopicName(topic.name))
  ].filter(Boolean));
  const suppressedThreadIds = new Set();
  const extras = actual.filter((topic) => {
    if (managedThreadIds.has(topic.threadId)) return false;
    const sequence = topicSequence(topic.name);
    const managedDuplicate = (sequence && managedSequences.has(sequence))
      || managedCanonicalNames.has(canonicalTopicName(topic.name));
    if (managedDuplicate && topic.threadId) suppressedThreadIds.add(topic.threadId);
    return !managedDuplicate;
  });
  const topics = normalizeTopics([...managed, ...extras]);
  const setupStateIsComplete = expected.length > 0 && managed.length === expected.length;
  const detectedTopicThreadIds = normalizeThreadIds([
    ...(setupStateIsComplete
      ? []
      : (group?.detectedTopicThreadIds || []).filter((threadId) => !suppressedThreadIds.has(Number(threadId)))),
    ...topics.map((topic) => topic.threadId)
  ]);
  const resolvedCount = topics.filter((topic) => topic.threadId).length;

  return {
    ...group,
    topics,
    detectedTopicThreadIds,
    topicCoverage: {
      knownCount: topics.length,
      resolvedCount,
      detectedThreadCount: detectedTopicThreadIds.length,
      complete: topics.length > 0 && resolvedCount === topics.length
    }
  };
}

function canonicalTopicName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/^[^\p{Letter}\p{Number}]+/u, "")
    .replace(/^\d+\.\s*/, "")
    .trim()
    .toLowerCase();
}

function topicSequence(value) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/^[^\p{Letter}\p{Number}]+/u, "")
    .trim();
  return normalized.match(/^(\d+)\.\s*/)?.[1] || "";
}

function sameManagedTopic(left, right) {
  const leftSequence = topicSequence(left);
  const rightSequence = topicSequence(right);
  if (leftSequence && rightSequence && leftSequence === rightSequence) return true;
  return canonicalTopicName(left) === canonicalTopicName(right);
}

function normalizeThreadIds(values = []) {
  return [...new Set(values.map((value) => Number(value || 0)).filter((value) => Number.isInteger(value) && value > 0))]
    .sort((a, b) => a - b);
}

function telegramMessages(update) {
  return [update?.message, update?.channel_post, update?.edited_message, update?.edited_channel_post, update?.my_chat_member].filter(Boolean);
}
