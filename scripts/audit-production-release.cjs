const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const baseUrl = String(process.env.TEST_BASE_URL || "https://yubit-bot-skills-academy.vercel.app").replace(/\/$/, "");
const username = process.env.TEST_USERNAME;
const password = process.env.TEST_PASSWORD;
const artifactDir = path.resolve(process.env.TEST_ARTIFACT_DIR || "artifacts/release-gate-production");

if (!username || !password) throw new Error("TEST_USERNAME and TEST_PASSWORD are required");

const pages = [
  "/distribution",
  "/bots",
  "/group-config",
  "/new-group",
  "/settings"
];

async function jsonRequest(response, label) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok()) throw new Error(`${label}: HTTP ${response.status()} · ${body.error || "请求失败"}`);
  if (body.ok === false) throw new Error(`${label}: ${body.error || "接口返回失败"}`);
  return body;
}

(async () => {
  fs.mkdirSync(artifactDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push({ url: page.url(), message: message.text() });
  });
  page.on("pageerror", (error) => pageErrors.push({ url: page.url(), message: error.message }));

  const login = await context.request.post(`${baseUrl}/api/auth/login`, { data: { username, password } });
  await jsonRequest(login, "登录");

  const pageResults = [];
  for (const route of pages) {
    const response = await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle", timeout: 30_000 });
    if (!response || !response.ok()) throw new Error(`${route}: HTTP ${response?.status() || "无响应"}`);
    const result = {
      route,
      status: response.status(),
      title: await page.title(),
      textLength: (await page.locator("body").innerText()).length
    };
    if (!result.textLength) throw new Error(`${route}: 页面没有可见内容`);
    await page.screenshot({ path: path.join(artifactDir, `${route.slice(1).replaceAll("/", "-")}.png`), fullPage: true });
    pageResults.push(result);
  }

  const [automation, bots, groups, distribution, social] = await Promise.all([
    jsonRequest(await context.request.get(`${baseUrl}/api/automation-status`), "自动任务状态"),
    jsonRequest(await context.request.get(`${baseUrl}/api/bot-groups`), "Bot 状态"),
    jsonRequest(await context.request.get(`${baseUrl}/api/group-config`), "群配置"),
    jsonRequest(await context.request.get(`${baseUrl}/api/distribution`), "内容分发"),
    jsonRequest(await context.request.get(`${baseUrl}/api/social-packages`), "社交来源")
  ]);

  const validations = [];
  for (const rule of distribution.rules || []) {
    const response = await context.request.post(`${baseUrl}/api/distribution`, {
      data: { action: "validate", id: rule.id },
      timeout: 30_000
    });
    const payload = await jsonRequest(response, `验证规则 ${rule.name}`);
    validations.push({
      id: rule.id,
      name: rule.name,
      kind: rule.kind,
      enabled: rule.enabled,
      ok: payload.result?.ok === true,
      checks: (payload.result?.checks || []).map(({ key, ok, message }) => ({ key, ok, message }))
    });
  }

  const templateExpectations = {
    "daily-events": { kind: "events", marker: /MORNING MARKET BRIEF/i },
    "daily-analysis": { kind: "analysis", marker: /DAILY MARKET ANALYSIS/i },
    "whale-hourly": { kind: "whale", marker: /WHALE ALERT · SMART MONEY SIGNAL/i }
  };
  const templatePreviews = [];
  for (const [jobId, expected] of Object.entries(templateExpectations)) {
    const payload = await jsonRequest(await context.request.post(`${baseUrl}/api/automation-test`, {
      data: { jobId },
      timeout: 30_000
    }), `预览模板 ${jobId}`);
    const preview = payload.result?.preview || {};
    const copy = `${preview.headline || ""}\n${preview.caption || ""}\n${preview.fullText || ""}`;
    const imageUrl = preview.imageUrl;
    let imageOk = false;
    let imageContentType = null;
    if (imageUrl) {
      const imageResponse = await context.request.get(imageUrl, { timeout: 30_000 });
      imageContentType = imageResponse.headers()["content-type"] || null;
      const bytes = await imageResponse.body();
      imageOk = imageResponse.ok() && imageContentType?.includes("image/png") && bytes.subarray(1, 4).toString("ascii") === "PNG";
    }
    templatePreviews.push({
      jobId,
      imageUrl,
      imageOk,
      imageContentType,
      copyOk: expected.marker.test(copy),
      kindOk: Boolean(imageUrl && new URL(imageUrl).searchParams.get("kind") === expected.kind)
    });
  }

  const report = {
    baseUrl,
    checkedAt: new Date().toISOString(),
    pages: pageResults,
    consoleErrors,
    pageErrors,
    bots: (bots.bots || []).map((bot) => ({
      role: bot.role,
      username: bot.username,
      configured: bot.configured,
      webhook: bot.webhook,
      error: bot.error || null
    })),
    discoveredGroups: (bots.groups || []).map((group) => ({
      title: group.title,
      chatId: group.chatId,
      type: group.type,
      ready: group.ready,
      botCount: Array.isArray(group.bots) ? group.bots.length : undefined
    })),
    configuredGroups: (groups.groups || []).map((group) => ({
      title: group.title,
      chatId: group.chatId,
      topicCount: Array.isArray(group.topics) ? group.topics.length : 0
    })),
    automationJobs: automation.jobs,
    rules: (distribution.rules || []).map((rule) => ({
      id: rule.id,
      name: rule.name,
      kind: rule.kind,
      contentType: rule.contentType,
      enabled: rule.enabled,
      schedulePreset: rule.schedulePreset,
      targetCount: (rule.targets || []).length
    })),
    database: distribution.database,
    socialPackages: (social.packages || []).map((item) => ({
      id: item.id,
      name: item.name,
      enabled: item.enabled,
      sourceCount: (item.sources || []).length,
      xCount: (item.sources || []).filter((source) => source.platform === "x").length,
      youtubeCount: (item.sources || []).filter((source) => source.platform === "youtube").length
    })),
    validations,
    templatePreviews
  };

  const expectedBots = ["Bonnie_geniustrader_bot", "Satoshi_geniustrader_bot", "Biupa_geniustrader_bot"];
  const actualBots = new Set(report.bots.filter((bot) => !bot.error).map((bot) => bot.username));
  const expectedGroups = new Map([
    ["-1004378187866", "CryptoGuy Academy"],
    ["-1003710405969", "DEMO Academy"]
  ]);
  const currentRules = distribution.rules || [];
  const broadcastRules = currentRules.filter((rule) => rule.kind === "broadcast");
  const requiredAutomations = [
    { contentType: "daily-events", schedulePreset: "daily-0800-utc" },
    { contentType: "daily-analysis", schedulePreset: "daily-0800-utc" },
    { contentType: "whale-signals", schedulePreset: "hourly" }
  ].map(({ contentType, schedulePreset }) => ({
    contentType, schedulePreset,
    rule: currentRules.find((rule) => rule.kind === "automation" && rule.contentType === contentType)
  }));
  const failures = [
    ...consoleErrors.map((item) => `浏览器控制台：${item.message}`),
    ...pageErrors.map((item) => `页面异常：${item.message}`),
    ...validations.filter((item) => !item.ok).map((item) => `规则验证失败：${item.name}`),
    ...expectedBots.filter((username) => !actualBots.has(username)).map((username) => `Bot 不在线：@${username}`),
    ...[...expectedGroups].flatMap(([chatId, title]) => {
      const discovered = report.discoveredGroups.find((group) => group.chatId === chatId);
      const configured = report.configuredGroups.find((group) => group.chatId === chatId);
      return [
        ...(!discovered || discovered.title !== title || discovered.type !== "supergroup" || discovered.botCount !== 3
          ? [`群实时识别异常：${title}`] : []),
        ...(!configured || configured.title !== title || configured.topicCount !== 7
          ? [`群配置异常：${title} 应有 7 个 Topic`] : [])
      ];
    }),
    ...(!report.database?.ok || report.database?.driver !== "postgres" || report.database?.durable !== true
      ? ["生产数据库不是健康的持久化 Postgres"] : []),
    ...(broadcastRules.length !== 7 || broadcastRules.some((rule) => !rule.enabled)
      ? ["Telegram 广播规则必须是 7 条且全部启用"] : []),
    ...requiredAutomations.flatMap(({ contentType, schedulePreset, rule }) => (!rule || !rule.enabled || rule.schedulePreset !== schedulePreset || (rule.targets || []).length < 2
      ? [`自动发布规则异常：${contentType}`] : [])),
    ...templatePreviews.filter((item) => !item.imageOk || !item.copyOk || !item.kindOk).map((item) => `线上模板预览异常：${item.jobId}`),
    ...["daily-events", "daily-analysis", "whale-hourly"].flatMap((jobId) => {
      const job = (automation.jobs || []).find((item) => item.id === jobId);
      return !job?.target?.configured || job.target.count < 2 ? [`自动任务状态未读取到数据库目标：${jobId}`] : [];
    })
  ];
  report.warnings = [];
  if (!(social.packages || []).some((item) => item.enabled !== false || item.status === "已启用")) {
    report.warnings.push("尚未配置代理 X / YouTube 来源；入口和抓取能力已上线，但不会产生代理更新。");
  }
  report.ok = failures.length === 0;
  report.failures = failures;
  fs.writeFileSync(path.join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  if (!report.ok) process.exitCode = 1;
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
