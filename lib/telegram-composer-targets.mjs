function normalizedId(value) {
  return String(value ?? "").trim();
}

function parseTarget(target) {
  const [chatId, threadIdValue] = normalizedId(target).split(":");
  const threadId = Number(threadIdValue);
  return { chatId, threadId: Number.isInteger(threadId) && threadId > 0 ? threadId : null };
}

export function buildAccountTargetGroups(configuredGroups = [], dialogs = []) {
  const configuredById = new Map(
    configuredGroups.map((group) => [normalizedId(group?.chatId), group])
  );
  const seen = new Set();

  return dialogs
    .filter((dialog) => dialog?.canSendMessages === true)
    .map((dialog) => {
      const chatId = normalizedId(dialog?.id);
      if (!chatId || seen.has(chatId)) return null;
      seen.add(chatId);

      const configured = configuredById.get(chatId);
      const liveTopics = new Map(
        (Array.isArray(dialog?.topics) ? dialog.topics : []).map((topic) => [Number(topic?.threadId), topic])
      );
      const configuredTopics = Array.isArray(configured?.topics) ? configured.topics : [];
      const configuredTopicIds = new Set(configuredTopics.map((topic) => Number(topic?.threadId)));
      const mergedTopics = [
        ...configuredTopics.map((topic) => {
          const live = liveTopics.get(Number(topic?.threadId));
          return {
            ...topic,
            liveName: live?.name || topic?.name || "",
            availabilityStatus: live?.availabilityStatus || "unknown",
            canSendMessages: live?.canSendMessages === true,
            ...(live?.requiresTemporaryReopen === true ? { requiresTemporaryReopen: true } : {})
          };
        }),
        ...[...liveTopics.values()]
          .filter((topic) => !configuredTopicIds.has(Number(topic?.threadId)))
          .map((topic) => ({
            threadId: Number(topic?.threadId),
            name: topic?.name || "",
            liveName: topic?.name || "",
            availabilityStatus: topic?.availabilityStatus || "unknown",
            canSendMessages: topic?.canSendMessages === true,
            ...(topic?.requiresTemporaryReopen === true ? { requiresTemporaryReopen: true } : {})
          }))
      ];
      return {
        ...(configured || {}),
        chatId,
        title: dialog?.title || configured?.title || chatId,
        isForum: dialog?.isForum === true || configured?.isForum === true,
        type: dialog?.type || configured?.type || "supergroup",
        username: dialog?.username || configured?.username || "",
        canSendMessages: dialog?.canSendMessages === true,
        topics: mergedTopics,
        topicStatusCheckedAt: dialog?.topicStatusCheckedAt || "",
        topicStatusError: dialog?.topicStatusError || ""
      };
    })
    .filter(Boolean);
}

export function assertAccountCanSendToTargets(dialogs = [], targets = []) {
  const writableChatIds = new Set(
    dialogs
      .filter((dialog) => dialog?.canSendMessages === true)
      .map((dialog) => normalizedId(dialog?.id))
      .filter(Boolean)
  );
  const forbiddenTargets = targets.filter((target) => !writableChatIds.has(parseTarget(target).chatId));

  if (forbiddenTargets.length > 0) {
    const error = new Error("所选账号无权向一个或多个目标发送消息，请重新选择目标");
    error.code = "TELEGRAM_ACCOUNT_TARGET_FORBIDDEN";
    throw error;
  }

  for (const target of targets) {
    const { chatId, threadId } = parseTarget(target);
    const dialog = dialogs.find((item) => normalizedId(item?.id) === chatId);
    if (threadId === null) {
      if (dialog?.isForum === true) {
        const error = new Error("论坛群必须选择一个已实时验证且可发送的 Topic");
        error.code = "TELEGRAM_FORUM_TOPIC_REQUIRED";
        throw error;
      }
      continue;
    }
    const topic = (Array.isArray(dialog?.topics) ? dialog.topics : [])
      .find((item) => Number(item?.threadId) === threadId);
    if (topic?.canSendMessages === true) continue;

    const error = new Error(
      topic?.availabilityStatus === "unknown"
        ? "无法实时确认一个或多个 Topic 的发送状态，请刷新后重试"
        : "一个或多个 Topic 已删除、不存在或账号没有管理权限，请重新选择目标"
    );
    error.code = topic?.availabilityStatus === "unknown"
      ? "TELEGRAM_TOPIC_STATUS_UNAVAILABLE"
      : "TELEGRAM_TOPIC_NOT_WRITABLE";
    throw error;
  }

  return true;
}
