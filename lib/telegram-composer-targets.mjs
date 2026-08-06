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
      return {
        ...(configured || {}),
        chatId,
        title: dialog?.title || configured?.title || chatId,
        isForum: dialog?.isForum === true || configured?.isForum === true,
        type: dialog?.type || configured?.type || "supergroup",
        username: dialog?.username || configured?.username || "",
        canSendMessages: dialog?.canSendMessages === true,
        topics: configuredTopics.map((topic) => {
          const live = liveTopics.get(Number(topic?.threadId));
          return {
            ...topic,
            liveName: live?.name || topic?.name || "",
            availabilityStatus: live?.availabilityStatus || "unknown",
            canSendMessages: live?.canSendMessages === true
          };
        }),
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
    if (threadId === null) continue;
    const dialog = dialogs.find((item) => normalizedId(item?.id) === chatId);
    const topic = (Array.isArray(dialog?.topics) ? dialog.topics : [])
      .find((item) => Number(item?.threadId) === threadId);
    if (topic?.canSendMessages === true) continue;

    const error = new Error(
      topic?.availabilityStatus === "unknown"
        ? "无法实时确认一个或多个 Topic 的发送状态，请刷新后重试"
        : "一个或多个 Topic 已关闭、删除或不存在，请重新选择目标"
    );
    error.code = topic?.availabilityStatus === "unknown"
      ? "TELEGRAM_TOPIC_STATUS_UNAVAILABLE"
      : "TELEGRAM_TOPIC_NOT_WRITABLE";
    throw error;
  }

  return true;
}
