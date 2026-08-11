const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const {
  authorizeReleaseAuditMode,
  buildVercelProtectionHeaders,
  collectAuditEvidence,
  PRODUCTION_RELEASE_PAGES,
  evaluateConfiguredGroup,
  evaluatePreviewTradingIsolation,
  evaluateReleaseFingerprint,
  evaluateReleasePage,
  evaluateRequiredAutomationRule,
  evaluateTradingRelease,
  resolveReleaseAuditBaseUrl,
  withAsyncCleanup,
} = require("../lib/release-gate.cjs");

const auditPolicy = authorizeReleaseAuditMode(process.env);
const releaseStage = auditPolicy.stage;
const baseUrl = resolveReleaseAuditBaseUrl(process.env, { stage: releaseStage });
const username = process.env.TEST_USERNAME;
const password = process.env.TEST_PASSWORD;
const browserChannel = String(process.env.TEST_BROWSER_CHANNEL ?? "chrome").trim();
const artifactDir = path.resolve(process.env.TEST_ARTIFACT_DIR || `artifacts/release-gate-${releaseStage}`);
const protectionHeaders = buildVercelProtectionHeaders(process.env.VERCEL_AUTOMATION_BYPASS_SECRET);

if (!username || !password) throw new Error("TEST_USERNAME and TEST_PASSWORD are required");

const pages = PRODUCTION_RELEASE_PAGES;

async function jsonRequest(response, label) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok()) throw new Error(`${label}: HTTP ${response.status()} · ${body.error || "请求失败"}`);
  if (body.ok === false) throw new Error(`${label}: ${body.error || "接口返回失败"}`);
  return body;
}

async function runAudit(browser) {
  fs.mkdirSync(artifactDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    ...(protectionHeaders ? { extraHTTPHeaders: protectionHeaders } : {}),
  });
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
    try {
      const response = await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle", timeout: 30_000 });
      const result = {
        route,
        status: response?.status() ?? null,
        title: await page.title(),
        textLength: (await page.locator("body").innerText()).length
      };
      result.failures = evaluateReleasePage(result);
      await page.screenshot({ path: path.join(artifactDir, `${route.slice(1).replaceAll("/", "-")}.png`), fullPage: true });
      pageResults.push(result);
    } catch (error) {
      pageResults.push({
        route,
        status: null,
        title: "",
        textLength: 0,
        failures: [`${route}: ${error.message}`]
      });
    }
  }

  const evidence = await collectAuditEvidence({
    releaseInfo: async () => jsonRequest(await context.request.get(`${baseUrl}/api/release-info`), "发布指纹"),
    automation: async () => jsonRequest(await context.request.get(`${baseUrl}/api/automation-status`), "自动任务状态"),
    bots: async () => jsonRequest(await context.request.get(`${baseUrl}/api/bot-groups`), "Bot 状态"),
    groups: async () => jsonRequest(await context.request.get(`${baseUrl}/api/group-config`), "群配置"),
    distribution: async () => jsonRequest(await context.request.get(`${baseUrl}/api/distribution`), "内容分发"),
    social: async () => jsonRequest(await context.request.get(`${baseUrl}/api/social-packages`), "社交来源"),
    trading: async () => jsonRequest(await context.request.get(`${baseUrl}/api/trading`), "交易中心")
  });
  const {
    releaseInfo = {},
    automation = {},
    bots = {},
    groups = {},
    distribution = {},
    social = {},
    trading = {},
  } = evidence.data;

  const validations = [];
  if (auditPolicy.allowActiveValidation) {
    for (const rule of (distribution.rules || []).filter((item) => (
      releaseStage === "production" && item.enabled === true
    ))) {
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
  }

  const templateExpectations = {
    "daily-events": { kind: "events", marker: /MORNING MARKET BRIEF/i },
    "daily-analysis": { kind: "analysis", marker: /DAILY MARKET ANALYSIS/i },
    "whale-hourly": { kind: "whale", marker: /WHALE ALERT · SMART MONEY SIGNAL/i }
  };
  const templatePreviews = [];
  if (auditPolicy.allowActiveValidation) {
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
  }

  const report = {
    stage: releaseStage,
    auditMode: auditPolicy.mode,
    remoteMutationsPerformed: auditPolicy.allowActiveValidation,
    baseUrl,
    checkedAt: new Date().toISOString(),
    releaseInfo,
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
      topicCount: Array.isArray(group.topics) ? group.topics.length : 0,
      topics: (group.topics || []).map((topic) => ({
        name: topic.name || topic.title,
        threadId: topic.threadId ?? topic.topicId ?? topic.id ?? null
      }))
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
    trading: {
      metrics: trading.metrics || {},
      health: trading.health || {}
    },
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
  const enabledBroadcastRules = broadcastRules.filter((rule) => rule.enabled);
  const requiredAutomations = [
    { contentType: "daily-events", schedulePreset: "daily-0800-utc" },
    { contentType: "daily-analysis", schedulePreset: "daily-0800-utc" },
    { contentType: "whale-signals", schedulePreset: "hourly" }
  ].map((definition) => evaluateRequiredAutomationRule(currentRules, definition));
  const commonFailures = [
    ...pageResults.flatMap((item) => item.failures || []),
    ...evidence.failures.map((message) => `接口异常：${message}`),
    ...evaluateReleaseFingerprint(releaseInfo, {
      expectedCommitSha: process.env.EXPECTED_COMMIT_SHA,
    }),
    ...consoleErrors.map((item) => `浏览器控制台：${item.message}`),
    ...pageErrors.map((item) => `页面异常：${item.message}`),
    ...expectedBots.filter((username) => !actualBots.has(username)).map((username) => `Bot 不在线：@${username}`),
    ...[...expectedGroups].flatMap(([chatId, title]) => {
      const discovered = report.discoveredGroups.find((group) => group.chatId === chatId);
      const configured = report.configuredGroups.find((group) => group.chatId === chatId);
      const configuredResult = evaluateConfiguredGroup(configured, { expectedTitle: title });
      return [
        ...(!discovered || discovered.title !== title || discovered.type !== "supergroup" || discovered.botCount !== 3
          ? [`群实时识别异常：${title}`] : []),
        ...(!configuredResult.ok
          ? [`群配置异常：${title} 缺少有效的标准 Topic ${configuredResult.missingTopicNumbers.join("、") || "或群名称不匹配"}`] : [])
      ];
    }),
    ...(!report.database?.ok || report.database?.driver !== "postgres" || report.database?.durable !== true
      ? ["内容分发数据库不是健康的持久化 Postgres"] : []),
    ...templatePreviews.filter((item) => !item.imageOk || !item.copyOk || !item.kindOk).map((item) => `线上模板预览异常：${item.jobId}`),
  ];
  const productionFailures = [
    ...(!auditPolicy.allowActiveValidation
      ? ["生产规则与模板的主动验收尚未执行（当前为严格只读审计）"] : []),
    ...validations.filter((item) => !item.ok).map((item) => `规则验证失败：${item.name}`),
    ...(enabledBroadcastRules.length < 7
      ? ["Telegram 广播规则至少需要 7 条已启用规则"] : []),
    ...requiredAutomations.flatMap((result) => result.failures),
    ...["daily-events", "daily-analysis", "whale-hourly"].flatMap((jobId) => {
      const job = (automation.jobs || []).find((item) => item.id === jobId);
      return !job?.target?.configured || job.target.count < 2 ? [`自动任务状态未读取到数据库目标：${jobId}`] : [];
    }),
    ...evaluateTradingRelease(trading)
  ];
  const previewFailures = evaluatePreviewTradingIsolation(trading);
  const failures = [
    ...commonFailures,
    ...(releaseStage === "preview" ? previewFailures : productionFailures),
  ];
  report.warnings = [];
  if (!auditPolicy.allowActiveValidation) {
    report.warnings.push("严格只读模式已跳过会写入 dry-run 运行记录的规则验证与模板预览。若需主动验收，必须单独启用 validation 模式；生产环境还需额外确认写入授权。");
  }
  if (!(social.packages || []).some((item) => item.enabled !== false || item.status === "已启用")) {
    report.warnings.push("尚未配置代理 X / YouTube 来源；入口和抓取能力已上线，但不会产生代理更新。");
  }
  if (releaseStage === "preview" && productionFailures.length) {
    report.warnings.push("Preview 已通过安全验收；下列生产依赖仍需在正式发布前完成。上线前不会自动启用规则或发送真实 Telegram 消息。");
  }
  report.ok = failures.length === 0;
  report.failures = failures;
  report.productionReady = [...commonFailures, ...productionFailures].length === 0;
  report.productionBlockers = productionFailures;
  fs.writeFileSync(path.join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

withAsyncCleanup(
  () => chromium.launch({
    headless: true,
    ...(browserChannel ? { channel: browserChannel } : {})
  }),
  runAudit,
  (browser) => browser.close(),
).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
