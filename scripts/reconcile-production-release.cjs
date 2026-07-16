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
const requiredContentTypes = new Set(["daily-events", "daily-analysis", "whale-signals"]);

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
    const requiredRules = [...requiredContentTypes].map((contentType) => (
      selectAutomationRuleForReconciliation(initial.rules || [], contentType)
    ));

    const enabled = [];
    for (const rule of requiredRules) {
      if (rule.enabled) continue;
      await readJson(await api.post("/api/distribution", {
        data: { action: "toggle", id: rule.id, enabled: true }
      }), `启用 ${rule.contentType}`);
      enabled.push(rule.contentType);
    }

    const final = await readJson(await api.get("/api/distribution"), "复核分发配置");
    const reconciledRules = [...requiredContentTypes].map((contentType) => (
      selectAutomationRuleForReconciliation(final.rules || [], contentType)
    ));
    const summary = reconciledRules.map((rule) => ({
        contentType: rule.contentType,
        enabled: rule.enabled,
        schedulePreset: rule.schedulePreset,
        targetCount: (rule.targets || []).length
      }));
    const ok = summary.length === requiredContentTypes.size && summary.every((rule) => rule.enabled);
    if (!ok) throw new Error("自动发布规则对账后仍未全部启用");
    console.log(JSON.stringify({ ok, enabled, rules: summary }, null, 2));
  } finally {
    await api.dispose();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
