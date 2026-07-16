const PRODUCTION_RELEASE_PAGES = Object.freeze([
  "/distribution",
  "/trading",
  "/bots",
  "/group-config",
  "/new-group",
  "/settings",
]);

const REQUIRED_TOPIC_NUMBERS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
const DEFAULT_SCHEDULER_MAX_AGE_MS = 15 * 60 * 1000;

function topicNumber(topic) {
  const match = String(topic?.name ?? topic?.title ?? "").match(/\b([1-7])\s*[.)]/u);
  return match ? Number(match[1]) : null;
}

function validThreadId(topic) {
  const value = Number(topic?.threadId ?? topic?.topicId ?? topic?.id);
  return Number.isInteger(value) && value > 0;
}

function evaluateConfiguredGroup(group, { expectedTitle } = {}) {
  const topics = Array.isArray(group?.topics) ? group.topics : [];
  const availableTopicNumbers = new Set(
    topics
      .filter(validThreadId)
      .map(topicNumber)
      .filter((value) => REQUIRED_TOPIC_NUMBERS.includes(value)),
  );
  const missingTopicNumbers = REQUIRED_TOPIC_NUMBERS.filter((value) => !availableTopicNumbers.has(value));
  const titleMatches = !expectedTitle || group?.title === expectedTitle;
  return {
    ok: Boolean(group?.chatId) && titleMatches && missingTopicNumbers.length === 0,
    titleMatches,
    topicCount: topics.length,
    missingTopicNumbers,
  };
}

function automationCandidates(rules, contentType) {
  return (Array.isArray(rules) ? rules : []).filter((rule) => (
    rule?.kind === "automation" && rule?.contentType === contentType
  ));
}

function evaluateRequiredAutomationRule(rules, {
  contentType,
  schedulePreset,
  minTargets = 2,
} = {}) {
  const candidates = automationCandidates(rules, contentType);
  const enabled = candidates.filter((rule) => rule.enabled === true);
  const failures = [];
  if (enabled.length === 0) {
    failures.push(`自动发布规则未启用：${contentType}`);
  } else if (enabled.length > 1) {
    failures.push(`自动发布规则重复：${contentType} 同时启用 ${enabled.length} 条`);
  }
  const rule = enabled.length === 1 ? enabled[0] : null;
  if (rule && schedulePreset && rule.schedulePreset !== schedulePreset) {
    failures.push(`自动发布频率异常：${contentType}`);
  }
  if (rule && (rule.targets || []).length < minTargets) {
    failures.push(`自动发布目标不足：${contentType}`);
  }
  return {
    ok: failures.length === 0,
    rule,
    candidateCount: candidates.length,
    enabledCount: enabled.length,
    failures,
  };
}

function selectAutomationRuleForReconciliation(rules, contentType) {
  const candidates = automationCandidates(rules, contentType);
  const enabled = candidates.filter((rule) => rule.enabled === true);
  if (enabled.length > 1) {
    throw new Error(`${contentType} 同时启用 ${enabled.length} 条规则，为避免重复发布已停止对账`);
  }
  if (enabled.length === 1) return enabled[0];
  if (candidates.length === 0) throw new Error(`缺少自动发布规则：${contentType}`);
  if (candidates.length > 1) {
    throw new Error(`${contentType} 存在 ${candidates.length} 条待选规则，请手动确认唯一规则`);
  }
  return candidates[0];
}

function evaluateTradingRelease(trading, {
  now = new Date(),
  schedulerMaxAgeMs = DEFAULT_SCHEDULER_MAX_AGE_MS,
} = {}) {
  const failures = [];
  const metrics = trading?.metrics ?? {};
  const health = trading?.health ?? {};
  const database = health.database ?? {};
  const speakerBot = health.speakerBot ?? {};
  const scheduler = health.scheduler ?? {};

  if (!database.ok || database.driver !== "postgres" || database.durable !== true) {
    failures.push("交易中心数据库不是健康的持久化 Postgres");
  }
  if (!speakerBot.ok || !speakerBot.configured || !speakerBot.webhookMatchesDeployment) {
    failures.push("SpeakerBot Webhook 未正确指向当前生产环境");
  }

  const nowMs = new Date(now).getTime();
  const lastRunMs = Date.parse(scheduler.lastRunAt ?? "");
  if (!scheduler.configured) {
    failures.push("交易订单核对调度未配置 CRON_SECRET");
  } else if (!Number.isFinite(lastRunMs)) {
    failures.push("交易订单核对调度尚未成功运行");
  } else if (nowMs - lastRunMs > schedulerMaxAgeMs || lastRunMs - nowMs > 5 * 60 * 1000) {
    failures.push("交易订单核对调度超过 15 分钟未成功运行");
  } else if (!scheduler.ok) {
    failures.push("交易订单核对调度状态异常");
  }

  if (Number(metrics.enabledTraders ?? 0) < 1) failures.push("尚未启用 Trader");
  if (Number(metrics.verifiedAccounts ?? 0) < 1) failures.push("尚未配置并验证 YUBIT 只读账户");
  if (Number(metrics.enabledDestinations ?? 0) < 2) failures.push("交易信号发布目标少于 2 个");
  return failures;
}

module.exports = {
  DEFAULT_SCHEDULER_MAX_AGE_MS,
  PRODUCTION_RELEASE_PAGES,
  REQUIRED_TOPIC_NUMBERS,
  evaluateConfiguredGroup,
  evaluateRequiredAutomationRule,
  evaluateTradingRelease,
  selectAutomationRuleForReconciliation,
};
