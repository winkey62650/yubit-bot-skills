const { request } = require("playwright");
const { authorizeProductionConfiguration, buildVercelProtectionHeaders } = require("../lib/release-gate.cjs");

const migrationApply = process.env.MIGRATION_APPLY === "true";
const { baseUrl } = authorizeProductionConfiguration(process.env, {
  operation: "生产市场内容规则迁移",
  apply: migrationApply,
});
const username = process.env.TEST_USERNAME || process.env.AUTH_USERNAME;
const password = process.env.TEST_PASSWORD || process.env.AUTH_PASSWORD;
const protectionHeaders = buildVercelProtectionHeaders(process.env.VERCEL_AUTOMATION_BYPASS_SECRET);

if (!username || !password) throw new Error("TEST_USERNAME/TEST_PASSWORD or AUTH_USERNAME/AUTH_PASSWORD are required");

async function readJson(response, label) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok() || body.ok === false) throw new Error(`${label}: HTTP ${response.status()} · ${body.error || "请求失败"}`);
  return body;
}

function comparableRule(rule) {
  if (!rule) return null;
  return {
    id: rule.id, kind: rule.kind, name: rule.name, contentType: rule.contentType,
    schedulePreset: rule.schedulePreset, enabled: rule.enabled === true,
    targets: rule.targets || [], settings: rule.settings || {},
  };
}

(async () => {
  const { migrateMarketContentRules, validateDistributionRule } = await import("../lib/distribution-domain.mjs");
  const api = await request.newContext({
    baseURL: baseUrl,
    ...(protectionHeaders ? { extraHTTPHeaders: protectionHeaders } : {}),
  });
  try {
    await readJson(await api.post("/api/auth/login", { data: { username, password } }), "登录");
    const currentPayload = await readJson(await api.get("/api/distribution"), "读取分发配置");
    const currentRules = currentPayload.rules || [];
    const migrated = migrateMarketContentRules(currentRules, new Date().toISOString());
    const migratedRules = migrated.rules.map((rule) => (
      rule.kind === "automation" && rule.contentType === "data-release-updates"
        ? { ...rule, enabled: false }
        : rule
    ));
    for (const rule of migratedRules) {
      const errors = validateDistributionRule(rule);
      if (errors.length) throw new Error(`${rule.name}: ${errors.map((item) => item.message).join("；")}`);
    }
    const currentById = new Map(currentRules.map((rule) => [rule.id, rule]));
    const operations = migratedRules
      .filter((rule) => JSON.stringify(comparableRule(currentById.get(rule.id))) !== JSON.stringify(comparableRule(rule)))
      .map((rule) => ({
        action: currentById.has(rule.id) ? "update" : "create",
        id: rule.id,
        contentType: rule.contentType,
        enabled: rule.enabled === true,
      }));
    const changedIds = new Set(operations.map((item) => item.id));
    const saved = [];
    if (migrationApply) {
      for (const rule of migratedRules.filter((item) => changedIds.has(item.id))) {
        const payload = await readJson(await api.post("/api/distribution", { data: { rule } }), `保存 ${rule.name}`);
        saved.push(payload.rule?.id || rule.id);
      }
    }
    console.log(JSON.stringify({
      ok: true,
      dryRun: !migrationApply,
      baseUrl,
      operations,
      before: operations.map(({ id }) => comparableRule(currentById.get(id))),
      after: operations.map(({ id }) => comparableRule(migratedRules.find((rule) => rule.id === id))),
      saved,
      changes: migrated.changes,
      note: migrationApply
        ? "迁移配置已保存；未执行任何自动任务或消息投递。"
        : "当前仅生成迁移计划。设置 MIGRATION_APPLY=true 与 APPLY_PRODUCTION_CONFIGURATION=true 后才会保存。",
    }, null, 2));
  } finally {
    await api.dispose();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
