const PRODUCTION_RELEASE_PAGES = Object.freeze([
  "/distribution",
  "/trading",
  "/bots",
  "/group-config",
  "/new-group",
  "/discord",
  "/settings",
]);

const REQUIRED_TOPIC_NUMBERS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
const REQUIRED_RELEASE_SCHEMA_VERSION = "2026-07-16.trading-center.v1";
const REQUIRED_RELEASE_CAPABILITIES = Object.freeze([
  "content-distribution",
  "telegram-broadcast",
  "multi-trader-trading-center",
]);
const DEFAULT_SCHEDULER_MAX_AGE_MS = 15 * 60 * 1000;
const RELEASE_STAGES = Object.freeze(["preview", "production"]);
const RELEASE_AUDIT_MODES = Object.freeze(["read-only", "validation"]);

function normalizeReleaseStage(value = "production") {
  const stage = String(value || "production").trim().toLowerCase();
  if (!RELEASE_STAGES.includes(stage)) {
    throw new Error(`RELEASE_STAGE 必须是 ${RELEASE_STAGES.join(" 或 ")}`);
  }
  return stage;
}

function normalizeReleaseAuditMode(value = "read-only") {
  const mode = String(value || "read-only").trim().toLowerCase();
  if (!RELEASE_AUDIT_MODES.includes(mode)) {
    throw new Error(`RELEASE_AUDIT_MODE 必须是 ${RELEASE_AUDIT_MODES.join(" 或 ")}`);
  }
  return mode;
}

function authorizeReleaseAuditMode(env = process.env) {
  const stage = normalizeReleaseStage(env.RELEASE_STAGE);
  const mode = normalizeReleaseAuditMode(env.RELEASE_AUDIT_MODE);
  const allowActiveValidation = mode === "validation";
  if (
    stage === "production"
    && allowActiveValidation
    && String(env.ALLOW_PRODUCTION_AUDIT_WRITES || "").trim().toLowerCase() !== "true"
  ) {
    throw new Error(
      "生产主动验收会写入 dry-run 运行记录，请显式设置 ALLOW_PRODUCTION_AUDIT_WRITES=true",
    );
  }
  return { stage, mode, allowActiveValidation };
}

function resolveReleaseAuditBaseUrl(env = process.env, { stage } = {}) {
  const releaseStage = normalizeReleaseStage(stage ?? env.RELEASE_STAGE);
  const rawBaseUrl = String(env.TEST_BASE_URL || "").trim();
  if (!rawBaseUrl) {
    throw new Error(`${releaseStage === "production" ? "生产" : "预览"}验收必须显式设置 TEST_BASE_URL`);
  }

  let url;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new Error("TEST_BASE_URL 不是有效网址");
  }
  if (url.protocol !== "https:") {
    throw new Error("TEST_BASE_URL 必须使用 HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

function authorizeLiveTelegramOperation(env = process.env, { operation = "真实 Telegram 操作" } = {}) {
  const failures = [];
  let stage = null;
  try {
    stage = normalizeReleaseStage(env.RELEASE_STAGE);
  } catch (error) {
    failures.push(error.message);
  }
  if (String(env.RELEASE_STAGE || "").trim().toLowerCase() !== "production") {
    failures.push(`${operation} 只能在 production 阶段运行，请显式设置 RELEASE_STAGE=production`);
  }
  if (String(env.ALLOW_LIVE_TELEGRAM || "").trim().toLowerCase() !== "true") {
    failures.push(`${operation} 会改动真实群，请显式设置 ALLOW_LIVE_TELEGRAM=true`);
  }

  const rawBaseUrl = String(env.TEST_BASE_URL || "").trim();
  let baseUrl = "";
  if (!rawBaseUrl) {
    failures.push(`${operation} 必须显式设置 TEST_BASE_URL`);
  } else {
    try {
      const url = new URL(rawBaseUrl);
      if (url.protocol !== "https:") failures.push(`${operation} 的 TEST_BASE_URL 必须使用 HTTPS`);
      baseUrl = url.toString().replace(/\/$/, "");
    } catch {
      failures.push(`${operation} 的 TEST_BASE_URL 不是有效网址`);
    }
  }

  if (failures.length) throw new Error(failures.join("\n"));
  return { stage, baseUrl };
}

function authorizeProductionConfiguration(env = process.env, {
  operation = "生产配置操作",
  apply = false,
} = {}) {
  const failures = [];
  let stage = null;
  try {
    stage = normalizeReleaseStage(env.RELEASE_STAGE);
  } catch (error) {
    failures.push(error.message);
  }
  if (String(env.RELEASE_STAGE || "").trim().toLowerCase() !== "production") {
    failures.push(`${operation} 只能面向 production，请显式设置 RELEASE_STAGE=production`);
  }
  if (apply && String(env.APPLY_PRODUCTION_CONFIGURATION || "").trim().toLowerCase() !== "true") {
    failures.push(`${operation} 会保存生产配置，请显式设置 APPLY_PRODUCTION_CONFIGURATION=true`);
  }

  const rawBaseUrl = String(env.TEST_BASE_URL || "").trim();
  let baseUrl = "";
  if (!rawBaseUrl) {
    failures.push(`${operation} 必须显式设置 TEST_BASE_URL`);
  } else {
    try {
      const url = new URL(rawBaseUrl);
      if (url.protocol !== "https:") failures.push(`${operation} 的 TEST_BASE_URL 必须使用 HTTPS`);
      baseUrl = url.toString().replace(/\/$/, "");
    } catch {
      failures.push(`${operation} 的 TEST_BASE_URL 不是有效网址`);
    }
  }

  if (failures.length) throw new Error(failures.join("\n"));
  return { stage, baseUrl, apply: Boolean(apply) };
}

function buildVercelProtectionHeaders(secret) {
  const normalized = String(secret ?? "").trim();
  if (!normalized) return undefined;
  return {
    "x-vercel-protection-bypass": normalized,
    "x-vercel-set-bypass-cookie": "true",
  };
}

async function withAsyncCleanup(createResource, useResource, cleanupResource) {
  const resource = await createResource();
  try {
    return await useResource(resource);
  } finally {
    await cleanupResource(resource);
  }
}

async function collectAuditEvidence(loaders = {}) {
  const data = {};
  const failures = [];
  await Promise.all(Object.entries(loaders).map(async ([key, load]) => {
    try {
      data[key] = await load();
    } catch (error) {
      data[key] = {};
      failures.push(`${key}: ${error?.message || "检查失败"}`);
    }
  }));
  return { data, failures };
}

function evaluateReleasePage({ route = "页面", status, textLength = 0 } = {}) {
  const failures = [];
  const normalizedStatus = Number(status);
  if (!Number.isInteger(normalizedStatus) || normalizedStatus < 200 || normalizedStatus >= 400) {
    failures.push(`${route}: HTTP ${Number.isInteger(normalizedStatus) ? normalizedStatus : "无响应"}`);
  }
  if (normalizedStatus >= 200 && normalizedStatus < 400 && Number(textLength) <= 0) {
    failures.push(`${route}: 页面没有可见内容`);
  }
  return failures;
}

function evaluateReleaseFingerprint(info = {}, { expectedCommitSha = "" } = {}) {
  const failures = [];
  if (info.schemaVersion !== REQUIRED_RELEASE_SCHEMA_VERSION) {
    failures.push("线上发布指纹版本不匹配");
  }

  const actualCapabilities = new Set(
    Array.isArray(info.capabilities) ? info.capabilities : [],
  );
  const missingCapabilities = REQUIRED_RELEASE_CAPABILITIES.filter(
    (capability) => !actualCapabilities.has(capability),
  );
  if (missingCapabilities.length > 0) {
    failures.push(`线上发布指纹缺少能力：${missingCapabilities.join("、")}`);
  }

  const actualCommitSha = String(info.commitSha || "").trim().toLowerCase();
  const normalizedExpectedCommitSha = String(expectedCommitSha || "").trim().toLowerCase();
  if (!actualCommitSha) {
    failures.push("线上发布指纹缺少提交编号");
  } else if (
    normalizedExpectedCommitSha
    && !actualCommitSha.startsWith(normalizedExpectedCommitSha)
    && !normalizedExpectedCommitSha.startsWith(actualCommitSha)
  ) {
    failures.push("线上提交与预期提交不一致");
  }

  return failures;
}

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
    rule?.kind === "automation"
      && rule?.runOnce !== true
      && rule?.contentType === contentType
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

function evaluatePreviewTradingIsolation(trading) {
  const failures = [];
  const database = trading?.health?.database ?? {};
  const speakerBot = trading?.health?.speakerBot ?? {};

  if (!database.ok || database.driver !== "postgres" || database.durable !== true) {
    failures.push("Preview 交易中心数据库不是健康的持久化 Postgres");
  }
  if (
    speakerBot.environment !== "preview"
    || speakerBot.configured !== false
    || speakerBot.configurationAllowed !== false
    || speakerBot.errorCode !== "SPEAKER_PREVIEW_WEBHOOK_DISABLED"
  ) {
    failures.push("Preview SpeakerBot Webhook 未保持隔离禁用状态");
  }
  return failures;
}

module.exports = {
  authorizeReleaseAuditMode,
  resolveReleaseAuditBaseUrl,
  authorizeLiveTelegramOperation,
  authorizeProductionConfiguration,
  buildVercelProtectionHeaders,
  collectAuditEvidence,
  DEFAULT_SCHEDULER_MAX_AGE_MS,
  PRODUCTION_RELEASE_PAGES,
  REQUIRED_RELEASE_CAPABILITIES,
  REQUIRED_RELEASE_SCHEMA_VERSION,
  REQUIRED_TOPIC_NUMBERS,
  RELEASE_AUDIT_MODES,
  RELEASE_STAGES,
  evaluateConfiguredGroup,
  evaluatePreviewTradingIsolation,
  evaluateReleaseFingerprint,
  evaluateReleasePage,
  evaluateRequiredAutomationRule,
  evaluateTradingRelease,
  normalizeReleaseAuditMode,
  normalizeReleaseStage,
  selectAutomationRuleForReconciliation,
  withAsyncCleanup,
};
