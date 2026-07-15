export const setupTimingDefaults = Object.freeze({
  apiDelayMs: 250,
  messageDelayMs: 3100,
  topicDelayMs: 250,
  maxDurationSeconds: 300
});

export function topicActionPlan(progress, topic) {
  const threadId = Number(progress?.message_thread_id);
  const hasThread = Number.isInteger(threadId) && threadId > 0;
  const desiredName = String(topic?.name || "");
  const desiredIcon = String(topic?.iconCustomEmojiId || "");
  const configurationMatches = progress?.configuredName === desiredName
    && String(progress?.configuredIconCustomEmojiId || "") === desiredIcon;
  const messages = Array.isArray(topic?.messages) ? topic.messages : [];
  const hasStructuredContent = messages.length > 0;
  const desiredContentVersion = String(topic?.contentVersion || "");
  const contentMessageIds = Array.isArray(progress?.contentMessageIds) ? progress.contentMessageIds.filter(Boolean) : [];
  const pinnedContentMessageIds = new Set(Array.isArray(progress?.pinnedContentMessageIds) ? progress.pinnedContentMessageIds : []);
  const requiredPinnedCount = messages.filter((message) => message?.pin !== false).length;
  const structuredContentComplete = hasStructuredContent
    && desiredContentVersion
    && progress?.contentVersion === desiredContentVersion
    && contentMessageIds.length === messages.length
    && contentMessageIds.filter((messageId) => pinnedContentMessageIds.has(messageId)).length >= requiredPinnedCount;

  return {
    create: !hasThread,
    configure: hasThread && !configurationMatches,
    syncContent: hasStructuredContent && !structuredContentComplete,
    sendImage: !hasStructuredContent && Boolean(topic?.imageUrl) && progress?.imageSent !== true,
    sendAnnouncement: !hasStructuredContent && Boolean(topic?.announcement) && progress?.announcementSent !== true,
    pin: !hasStructuredContent && Boolean(topic?.announcement && topic?.pin) && progress?.pinned !== true,
    close: Boolean(topic?.close) && progress?.closed !== true
  };
}

export function resolveTopicProgress(topicStates = {}, topic = {}) {
  const topicKey = String(topic.key || "");
  if (topicKey && topicStates?.[topicKey]) {
    return { topicKey, topicState: topicStates[topicKey], migratedKeys: [] };
  }

  const explicitKeys = Array.isArray(topic.legacyKeys) ? topic.legacyKeys.map(String) : [];
  const prefix = String(topic.legacyKeyPrefix || "");
  const candidateKeys = [...new Set([
    ...explicitKeys.filter((key) => topicStates?.[key]),
    ...Object.keys(topicStates || {}).filter((key) => prefix && key.startsWith(prefix))
  ])].sort((left, right) => threadId(topicStates[left]) - threadId(topicStates[right]));

  const selectedKey = candidateKeys.find((key) => Number.isFinite(threadId(topicStates[key])));
  return {
    topicKey,
    topicState: selectedKey ? topicStates[selectedKey] : {},
    migratedKeys: candidateKeys
  };
}

export function estimateSetupDurationMs({
  topicCount = 0,
  messageCount = 0,
  apiCallCount = 0,
  apiDelayMs = setupTimingDefaults.apiDelayMs,
  messageDelayMs = setupTimingDefaults.messageDelayMs,
  topicDelayMs = setupTimingDefaults.topicDelayMs
} = {}) {
  const nonMessageCalls = Math.max(0, Number(apiCallCount) - Number(messageCount));
  return Number(messageCount) * messageDelayMs
    + nonMessageCalls * apiDelayMs
    + Number(topicCount) * topicDelayMs * 2;
}

function threadId(progress) {
  const value = Number(progress?.message_thread_id);
  return Number.isInteger(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}
