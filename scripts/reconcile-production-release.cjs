const { request } = require("playwright");
const {
  authorizeLiveTelegramOperation,
  selectAutomationRuleForReconciliation,
} = require("../lib/release-gate.cjs");

const { baseUrl } = authorizeLiveTelegramOperation(process.env, {
  operation: "生产自动发布规则对账",
});
const username = process.env.TEST_USERNAME;
const password = process.env.TEST_PASSWORD;
const requiredDefinitions = [
  { contentType: "crypto-daily", enabled: true },
  { contentType: "weekly-calendar", enabled: true },
  { contentType: "data-release-updates", enabled: false },
  { contentType: "daily-analysis", enabled: true },
  { contentType: "whale-signals", enabled: true },
  { contentType: "agent-sync", enabled: true },
];

if (!username || !password) throw new Error("TEST_USERNAME and TEST_PASSWORD are required");

async function readJson(response, label) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok() || body.ok === false) {
    throw new Error(`${label}: HTTP ${response.status()} · ${body.error || "请求失败"}`);
  }
  return body;
}

(async () => {
  const api = await request.newContext({ baseURL: baseUrl });
  try {
    await readJson(await api.post("/api/auth/login", {
      data: { username, password }
    }), "登录");

    // Reading the overview also reconciles stale display names from stable chat/thread IDs.
    const initial = await readJson(await api.get("/api/distribution"), "读取分发配置");
    const requiredRules = requiredDefinitions.map((definition) => ({
      definition,
      rule: selectAutomationRuleForReconciliation(initial.rules || [], definition.contentType),
    }));

    const enabled = [];
    for (const { definition, rule } of requiredRules) {
      if (rule.enabled === definition.enabled) continue;
      await readJson(await api.post("/api/distribution", {
        data: { action: "toggle", id: rule.id, enabled: definition.enabled }
      }), `${definition.enabled ? "启用" : "禁用"} ${rule.contentType}`);
      enabled.push(`${rule.contentType}:${definition.enabled}`);
    }

    const final = await readJson(await api.get("/api/distribution"), "复核分发配置");
    const reconciledRules = requiredDefinitions.map((definition) => ({
      definition,
      rule: selectAutomationRuleForReconciliation(final.rules || [], definition.contentType),
    }));
    const summary = reconciledRules.map(({ definition, rule }) => ({
        contentType: rule.contentType,
        enabled: rule.enabled,
        expectedEnabled: definition.enabled,
        schedulePreset: rule.schedulePreset,
        targetCount: (rule.targets || []).length
      }));
    const ok = summary.length === requiredDefinitions.length
      && summary.every((rule) => rule.enabled === rule.expectedEnabled);
    if (!ok) throw new Error("自动发布规则对账后仍未达到预期启用状态");
    console.log(JSON.stringify({ ok, enabled, rules: summary }, null, 2));
  } finally {
    await api.dispose();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
