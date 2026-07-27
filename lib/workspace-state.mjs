const supportedSections = new Set(["new-group", "news", "signals", "settings"]);

export function normalizeWorkspaceState(section, value = {}) {
  if (!supportedSections.has(section)) throw new Error(`Unsupported workspace section: ${section}`);

  if (section === "new-group") {
    const topics = (Array.isArray(value.topics) ? value.topics : []).slice(0, 50).map((topic, index) => ({
      id: text(topic?.id || index + 1, 20),
      emoji: text(topic?.emoji, 32),
      name: text(topic?.name, 200),
      attribute: ["关闭话题", "频道禁言", "交流频道"].includes(topic?.attribute) ? topic.attribute : "交流频道",
      announcement: text(topic?.announcement, 30000),
      imageUrl: text(topic?.imageUrl, 2000)
    })).filter((topic) => topic.name);
    const requestedIds = Array.isArray(value.selectedTopicIds)
      ? uniqueStrings(value.selectedTopicIds, 50, 20)
      : topics.map((topic) => topic.id);
    const requestedIdSet = new Set(requestedIds);
    return {
      groupName: text(value.groupName, 200),
      groupDescription: text(value.groupDescription, 4000),
      chatId: text(value.chatId, 40),
      botRole: ["admin", "speaker", "forward"].includes(value.botRole) ? value.botRole : "admin",
      dryRun: value.dryRun !== false,
      topics,
      selectedTopicIds: topics.map((topic) => topic.id).filter((id) => requestedIdSet.has(id))
    };
  }

  if (section === "news") {
    return {
      selected: uniqueStrings(value.selected, 200, 200),
      sourceFilter: ["全部", "RSS", "API"].includes(value.sourceFilter) ? value.sourceFilter : "全部"
    };
  }

  if (section === "signals") {
    return { selected: uniqueStrings(value.selected, 100, 200) };
  }

  return {
    webhook: text(value.webhook, 2000),
    frequency: oneOf(value.frequency, ["每 5 分钟", "每 15 分钟", "每 30 分钟", "每 1 小时"], "每 5 分钟"),
    alertMode: oneOf(value.alertMode, ["异常才推送", "每次检查都推送", "每日汇总"], "异常才推送"),
    failureThreshold: oneOf(value.failureThreshold, ["1 次失败立即告警", "2 次连续失败告警", "3 次连续失败告警"], "2 次连续失败告警"),
    environment: oneOf(value.environment, ["本地控制台", "生产环境", "全部环境"], "生产环境"),
    status: oneOf(value.status, ["启用", "暂停"], "暂停"),
    telegramPublishMode: oneOf(value.telegramPublishMode, ["bot", "user"], "user"),
    telegramForwardMode: oneOf(value.telegramForwardMode, ["bot", "user"], "user")
  };
}

export function isSupportedWorkspaceSection(section) {
  return supportedSections.has(section);
}

function text(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function uniqueStrings(value, maxItems, maxLength) {
  return [...new Set((Array.isArray(value) ? value : []).filter((item) => typeof item === "string").map((item) => text(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function oneOf(value, options, fallback) {
  return options.includes(value) ? value : fallback;
}
