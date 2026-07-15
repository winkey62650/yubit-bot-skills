const { chromium } = require("playwright");

const baseUrl = String(process.env.TEST_BASE_URL || "https://yubit-bot-skills-academy.vercel.app").replace(/\/$/, "");
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
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    await readJson(await context.request.post(`${baseUrl}/api/auth/login`, {
      data: { username, password }
    }), "登录");

    // Reading the overview also reconciles stale display names from stable chat/thread IDs.
    const initial = await readJson(await context.request.get(`${baseUrl}/api/distribution`), "读取分发配置");
    const requiredRules = (initial.rules || []).filter((rule) => (
      rule.kind === "automation" && requiredContentTypes.has(rule.contentType)
    ));
    const missing = [...requiredContentTypes].filter((contentType) => (
      !requiredRules.some((rule) => rule.contentType === contentType)
    ));
    if (missing.length) throw new Error(`缺少自动发布规则：${missing.join(", ")}`);

    const enabled = [];
    for (const rule of requiredRules) {
      if (rule.enabled) continue;
      await readJson(await context.request.post(`${baseUrl}/api/distribution`, {
        data: { action: "toggle", id: rule.id, enabled: true }
      }), `启用 ${rule.contentType}`);
      enabled.push(rule.contentType);
    }

    const final = await readJson(await context.request.get(`${baseUrl}/api/distribution`), "复核分发配置");
    const summary = (final.rules || [])
      .filter((rule) => rule.kind === "automation" && requiredContentTypes.has(rule.contentType))
      .map((rule) => ({
        contentType: rule.contentType,
        enabled: rule.enabled,
        schedulePreset: rule.schedulePreset,
        targetCount: (rule.targets || []).length
      }));
    console.log(JSON.stringify({ ok: summary.every((rule) => rule.enabled), enabled, rules: summary }, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
