function normalizedId(value) {
  return String(value ?? "").trim();
}

function targetChatId(target) {
  return normalizedId(target).split(":", 1)[0];
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
      return {
        ...(configured || {}),
        chatId,
        title: dialog?.title || configured?.title || chatId,
        isForum: dialog?.isForum === true || configured?.isForum === true,
        type: dialog?.type || configured?.type || "supergroup",
        username: dialog?.username || configured?.username || "",
        topics: Array.isArray(configured?.topics) ? configured.topics : []
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
  const forbiddenTargets = targets.filter(
    (target) => !writableChatIds.has(targetChatId(target))
  );

  if (forbiddenTargets.length > 0) {
    const error = new Error("所选账号无权向一个或多个目标发送消息，请重新选择目标");
    error.code = "TELEGRAM_ACCOUNT_TARGET_FORBIDDEN";
    throw error;
  }

  return true;
}
