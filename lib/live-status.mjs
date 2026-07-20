export const LIVE_STATUS_REFRESH_MS = 30_000;
export const LIVE_STATUS_STALE_MS = 90_000;

export function getFriendlyRefreshError(error) {
  const message = String(error || "").trim();
  if (!message) return "";
  if (/vercel blob|fetch blob|blob credentials|BLOB_READ_WRITE_TOKEN|BLOB_STORE_ID/i.test(message)) {
    return "服务端存储暂不可用";
  }
  if (/failed to fetch|network|ECONN|ENOTFOUND|ETIMEDOUT/i.test(message)) {
    return "网络连接失败";
  }
  if (/\b401\b|unauthorized|登录状态/i.test(message)) {
    return "登录状态已失效，请重新登录";
  }
  if (/\b429\b|too many requests|rate limit/i.test(message)) {
    return "Telegram 请求过于频繁，请稍后重试";
  }
  if (message.length > 80) return "实时核验暂时失败，请稍后重试";
  return message;
}

export function getLiveFreshness(generatedAt, {
  now = Date.now(),
  staleAfterMs = LIVE_STATUS_STALE_MS
} = {}) {
  const checkedAt = Date.parse(generatedAt || "");
  if (!Number.isFinite(checkedAt)) {
    return { state: "unknown", tone: "amber", label: "尚未实时核验", ageMs: null };
  }

  const ageMs = Math.max(0, Number(now) - checkedAt);
  if (ageMs > staleAfterMs) {
    return {
      state: "stale",
      tone: "amber",
      label: `状态已过期 · ${formatAge(ageMs)}`,
      ageMs
    };
  }

  return {
    state: "fresh",
    tone: "green",
    label: ageMs < 10_000 ? "刚刚实时核验" : `${formatAge(ageMs)}前实时核验`,
    ageMs
  };
}

export function getBotOperationalStatus({ bot, group, generatedAt, now = Date.now() }) {
  const freshness = getLiveFreshness(generatedAt, { now });
  if (freshness.state === "stale") {
    return { label: "状态已过期", tone: "amber", detail: freshness.label };
  }
  if (freshness.state === "unknown") {
    return { label: "等待核验", tone: "amber", detail: freshness.label };
  }
  if (!bot || bot.status === "读取中") {
    return { label: "核验中", tone: "amber", detail: "正在读取 Bot API" };
  }
  if (bot.apiAvailable === false || !["在线", "API 可用"].includes(bot.status)) {
    return { label: bot?.status || "API 不可用", tone: "amber", detail: bot?.error || "Bot API 核验未通过" };
  }
  if (bot.identityVerified === false) {
    return { label: "身份不匹配", tone: "amber", detail: "当前 Token 与预期 Bot 不一致" };
  }
  if (!group) {
    return { label: "API 可用", tone: "green", detail: "身份已核验；尚未选择群" };
  }

  const groupBot = (group.bots || []).find((candidate) => {
    return candidate.name === bot.name
      || candidate.roleKey === bot.roleKey
      || normalizeUsername(candidate.username) === normalizeUsername(bot.username || bot.expectedUsername);
  });
  if (!groupBot || ["left", "kicked", "not_found"].includes(groupBot.membership)) {
    return { label: "未在目标群", tone: "amber", detail: "Telegram 未核验到当前 Bot 的有效成员身份" };
  }
  if (!groupBot.isAdmin && !["administrator", "creator"].includes(groupBot.membership)) {
    return { label: "非管理员", tone: "amber", detail: `当前身份：${membershipLabel(groupBot.membership)}` };
  }
  if (!groupBot.canManageTopics) {
    return { label: "Topic 权限不足", tone: "amber", detail: "需要授予管理话题权限" };
  }
  return { label: "群权限正常", tone: "green", detail: "管理员 · 可管理 Topic" };
}

export function buildInitializationChecklist({ groupName, topics = [], group, generatedAt, now = Date.now() }) {
  const configuredTopics = topics.filter((topic) => String(topic?.[2] || "").trim());
  const announcements = configuredTopics.filter((topic) => String(topic?.[4] || "").trim());
  const freshness = getLiveFreshness(generatedAt, { now });
  let permissionValue = "待实时核验";
  if (freshness.state === "stale") permissionValue = "需刷新";
  if (freshness.state === "fresh" && group) permissionValue = group.readyForInitialization ? "已通过" : "未通过";

  return [
    { label: "群资料", value: String(groupName || "").trim() ? "已填写" : "待填写", kind: "configuration" },
    { label: "Topic 配置", value: configuredTopics.length ? `${configuredTopics.length} 个已配置` : "待配置", kind: "configuration" },
    { label: "图文公告", value: announcements.length ? `${announcements.length} 条已配置` : "未配置", kind: "configuration" },
    { label: "置顶信息", value: announcements.length ? `${announcements.length} 条将置顶` : "未配置", kind: "configuration" },
    { label: "群权限（实时）", value: permissionValue, kind: "live" }
  ];
}

function formatAge(ageMs) {
  const seconds = Math.max(1, Math.round(ageMs / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.round(minutes / 60)} 小时`;
}

function normalizeUsername(value) {
  return String(value || "").replace(/^@/, "").toLowerCase();
}

function membershipLabel(value) {
  if (value === "member") return "普通成员";
  if (value === "restricted") return "受限成员";
  return value || "未知";
}
