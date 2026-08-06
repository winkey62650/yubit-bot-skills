import { telegramMtprotoCall } from "./telegram-mtproto.mjs";

function normalizedId(value) {
  return String(value ?? "").trim();
}

function normalizedThreadId(value) {
  const threadId = Number(value);
  return Number.isInteger(threadId) && threadId > 0 ? threadId : null;
}

function addTopic(map, chatIdValue, threadIdValue) {
  const chatId = normalizedId(chatIdValue);
  const threadId = normalizedThreadId(threadIdValue);
  if (!chatId || threadId === null) return;
  const ids = map.get(chatId) || [];
  if (!ids.includes(threadId)) ids.push(threadId);
  map.set(chatId, ids);
}

export function topicIdsByChatFromConfiguredGroups(groups = []) {
  const result = new Map();
  for (const group of groups) {
    for (const topic of Array.isArray(group?.topics) ? group.topics : []) {
      addTopic(result, group?.chatId, topic?.threadId);
    }
  }
  return result;
}

export function topicIdsByChatFromTargets(targets = []) {
  const result = new Map();
  for (const target of targets) {
    const [chatId, threadId] = normalizedId(target).split(":");
    addTopic(result, chatId, threadId);
  }
  return result;
}

export async function hydrateTelegramTopicAvailability(
  dialogs = [],
  topicIdsByChat = new Map(),
  { userId, call = telegramMtprotoCall } = {}
) {
  return Promise.all(dialogs.map(async (dialog) => {
    const chatId = normalizedId(dialog?.id);
    const threadIds = topicIdsByChat.get(chatId) || [];
    if (threadIds.length === 0) return dialog;

    const checkedAt = new Date().toISOString();
    if (dialog?.isForum !== true || dialog?.canSendMessages !== true) {
      return {
        ...dialog,
        topics: threadIds.map((threadId) => ({
          threadId,
          name: "",
          availabilityStatus: "unknown",
          canSendMessages: false
        })),
        topicStatusCheckedAt: checkedAt,
        topicStatusError: "Forum or chat is not writable"
      };
    }

    try {
      const liveTopics = await call(null, "getForumTopicsById", {
        chat_id: chatId,
        thread_ids: threadIds
      }, { userId });
      const liveById = new Map(
        (Array.isArray(liveTopics) ? liveTopics : []).map((topic) => [Number(topic.threadId), topic])
      );
      return {
        ...dialog,
        topics: threadIds.map((threadId) => {
          const topic = liveById.get(threadId);
          if (!topic) {
            return { threadId, name: "", availabilityStatus: "missing", canSendMessages: false };
          }
          const availabilityStatus = topic.deleted
            ? "deleted"
            : topic.closed
              ? "closed"
              : topic.canSendMessages === true
                ? "available"
                : "unknown";
          return { ...topic, threadId, availabilityStatus, canSendMessages: availabilityStatus === "available" };
        }),
        topicStatusCheckedAt: checkedAt,
        topicStatusError: ""
      };
    } catch (error) {
      return {
        ...dialog,
        topics: threadIds.map((threadId) => ({
          threadId,
          name: "",
          availabilityStatus: "unknown",
          canSendMessages: false
        })),
        topicStatusCheckedAt: checkedAt,
        topicStatusError: error?.message || String(error)
      };
    }
  }));
}
