const { request } = require("playwright");
const {
  authorizeProductionConfiguration,
  buildVercelProtectionHeaders,
} = require("../lib/release-gate.cjs");

const provisionApply = String(process.env.PROVISION_APPLY || "").trim().toLowerCase() === "true";
const { baseUrl } = authorizeProductionConfiguration(process.env, {
  operation: "生产标准分发规则初始化",
  apply: provisionApply,
});
const username = process.env.TEST_USERNAME || process.env.AUTH_USERNAME;
const password = process.env.TEST_PASSWORD || process.env.AUTH_PASSWORD;
const protectionHeaders = buildVercelProtectionHeaders(process.env.VERCEL_AUTOMATION_BYPASS_SECRET);

if (!username || !password) throw new Error("TEST_USERNAME/TEST_PASSWORD or AUTH_USERNAME/AUTH_PASSWORD are required");

async function readJson(response, label) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok() || body.ok === false) {
    throw new Error(`${label}: HTTP ${response.status()} · ${body.error || "请求失败"}`);
  }
  return body;
}

function comparableRule(rule) {
  return {
    id: rule.id,
    kind: rule.kind,
    name: rule.name,
    contentType: rule.contentType ?? null,
    schedulePreset: rule.schedulePreset ?? null,
    mode: rule.mode ?? null,
    source: rule.source ? {
      chatId: rule.source.chatId,
      threadId: rule.source.threadId,
      groupName: rule.source.groupName,
      topicName: rule.source.topicName,
    } : null,
    targets: (rule.targets || []).map((target) => ({
      id: target.id,
      chatId: target.chatId,
      threadId: target.threadId,
      groupName: target.groupName,
      topicName: target.topicName,
      enabled: target.enabled !== false,
      order: target.order,
    })),
    enabled: rule.enabled === true,
    status: rule.status,
  };
}

function sameRule(left, right) {
  return JSON.stringify(comparableRule(left)) === JSON.stringify(comparableRule(right));
}

(async () => {
  const {
    buildStandardProductionDistributionRules,
    validateDistributionRule,
  } = await import("../lib/distribution-domain.mjs");
  const api = await request.newContext({
    baseURL: baseUrl,
    ...(protectionHeaders ? { extraHTTPHeaders: protectionHeaders } : {}),
  });
  try {
    await readJson(await api.post("/api/auth/login", {
      data: { username, password },
    }), "登录");
    const [groupConfig, distribution] = await Promise.all([
      readJson(await api.get("/api/group-config"), "读取群配置"),
      readJson(await api.get("/api/distribution"), "读取分发配置"),
    ]);
    const currentRules = distribution.rules || [];
    const desiredRules = buildStandardProductionDistributionRules(groupConfig.groups || [], { currentRules });
    for (const rule of desiredRules) {
      const errors = validateDistributionRule(rule);
      if (errors.length) throw new Error(`${rule.name}: ${errors.map((item) => item.message).join("；")}`);
    }

    const currentById = new Map(currentRules.map((rule) => [rule.id, rule]));
    const operations = desiredRules.map((rule) => {
      const current = currentById.get(rule.id);
      return {
        action: current ? (sameRule(current, rule) ? "unchanged" : "update") : "create",
        id: rule.id,
        name: rule.name,
        kind: rule.kind,
        contentType: rule.contentType,
        enabled: rule.enabled,
        targetCount: rule.targets.length,
      };
    });

    const changedIds = new Set(operations.filter((item) => item.action !== "unchanged").map((item) => item.id));
    const saved = [];
    if (provisionApply) {
      for (const rule of desiredRules.filter((item) => changedIds.has(item.id))) {
        const payload = await readJson(await api.post("/api/distribution", {
          data: { rule },
        }), `保存 ${rule.name}`);
        saved.push(payload.rule?.id || rule.id);
      }
    }

    console.log(JSON.stringify({
      ok: true,
      dryRun: !provisionApply,
      baseUrl,
      summary: {
        total: operations.length,
        create: operations.filter((item) => item.action === "create").length,
        update: operations.filter((item) => item.action === "update").length,
        unchanged: operations.filter((item) => item.action === "unchanged").length,
        enabled: desiredRules.filter((rule) => rule.enabled).length,
        disabled: desiredRules.filter((rule) => !rule.enabled).length,
      },
      operations,
      saved,
      note: provisionApply
        ? "标准规则已保存；本命令没有配置 Webhook、启用新规则或发送 Telegram 消息。"
        : "当前仅生成计划。设置 PROVISION_APPLY=true 与 APPLY_PRODUCTION_CONFIGURATION=true 后才会保存。",
    }, null, 2));
  } finally {
    await api.dispose();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
