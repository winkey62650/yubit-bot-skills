const fs = require("node:fs");
const path = require("node:path");
const { request } = require("playwright");
const {
  DEMO_CHAT_ID,
  DEMO_SHOWCASE_CASES,
  assertDemoShowcaseExecution,
  assertDemoShowcasePosterUrls,
  assertDemoShowcasePreview,
  buildDemoShowcaseTemporaryRule,
} = require("../lib/demo-content-acceptance.cjs");
const { authorizeLiveTelegramOperation } = require("../lib/release-gate.cjs");

const MAX_POSTER_BYTES = 5 * 1024 * 1024;
const TARGET_THREAD_ID = 8;
const TARGET_TOPIC_NAME = "3. Market Events";
const dailyCase = DEMO_SHOWCASE_CASES.find((item) => item.key === "daily");
const acceptanceBatchId = String(process.env.ACADEMY_DEMO_ACCEPTANCE_BATCH_ID || "").trim().toLowerCase();
const reportPath = path.resolve(process.env.TEST_REPORT_PATH || "artifacts/academy-demo-showcase/daily-topic8-supplement.json");
const username = process.env.TEST_USERNAME;
const password = process.env.TEST_PASSWORD;

const { baseUrl } = authorizeLiveTelegramOperation(process.env, {
  operation: "Academy DEMO Topic 8 补发 Market Brief 海报与正文",
});

if (!dailyCase) throw new Error("Academy DEMO daily showcase case is unavailable");
if (!username || !password) throw new Error("TEST_USERNAME and TEST_PASSWORD are required");
if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(acceptanceBatchId)) {
  throw new Error("ACADEMY_DEMO_ACCEPTANCE_BATCH_ID_INVALID");
}

async function readJson(response, label) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok() || payload.ok === false) {
    throw new Error(`${label}: HTTP ${response.status()} · ${payload.error || "request failed"}`);
  }
  return payload;
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.ACCEPTANCE_QUIET !== "true") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function assertDestinationCta(api) {
  const payload = await readJson(await api.get("/api/destination-cta", { timeout: 30_000 }), "destination CTA");
  const cta = payload.registry?.[`telegram:${DEMO_CHAT_ID}`];
  const content = String(cta?.ctaContent || "").trim();
  if (cta?.ctaEnabled !== true || !content) throw new Error("DEMO destination CTA is unavailable");
  if (/152-32-161-174|sslip\.io|\/admin(?:\/|\b)|\/api(?:\/|\b)/i.test(content)) {
    throw new Error("DEMO destination CTA exposes an application or admin address");
  }
  return { key: `telegram:${DEMO_CHAT_ID}`, enabled: true, source: "destination-registry" };
}

async function preflightPoster(api, preview) {
  const photoSteps = (preview.deliveryPlans?.[0]?.steps || []).filter((step) => step?.method === "sendPhoto");
  const [identity] = assertDemoShowcasePosterUrls(photoSteps.map((step) => step?.payload?.photo), dailyCase);
  const response = await api.get(identity.url, { timeout: 90_000 });
  const contentType = String(response.headers()["content-type"] || "").toLowerCase();
  if (!response.ok() || !contentType.startsWith("image/png")) {
    throw new Error(`daily poster preflight failed: HTTP ${response.status()} · ${contentType || "missing content-type"}`);
  }
  const bytes = await response.body();
  if (bytes.byteLength < 1024 || bytes.byteLength > MAX_POSTER_BYTES) {
    throw new Error(`daily poster preflight failed: invalid PNG size ${bytes.byteLength}`);
  }
  return { ...identity, status: response.status(), contentType, byteLength: bytes.byteLength };
}

(async () => {
  const api = await request.newContext({ baseURL: baseUrl });
  const temporaryRuleId = `academy-demo-showcase-daily-recovery-${acceptanceBatchId}-temporary`;
  const report = {
    ok: false,
    operation: "academy-demo-daily-topic8-supplement",
    historicalReplay: true,
    mediaIncluded: true,
    visualContract: "telegram-editorial-card-v4",
    previewLabel: "DEMO PREVIEW · FORMAT TEST",
    acceptanceBatchId,
    target: { chatId: DEMO_CHAT_ID, threadId: TARGET_THREAD_ID },
    startedAt: new Date().toISOString(),
  };
  let ruleCreated = false;
  try {
    await readJson(await api.post("/api/auth/login", {
      data: { username, password },
      timeout: 30_000,
    }), "login");
    report.release = await readJson(await api.get("/api/release-info", { timeout: 30_000 }), "release info");
    report.destinationCta = await assertDestinationCta(api);

    const rule = buildDemoShowcaseTemporaryRule(dailyCase, {
      ruleId: temporaryRuleId,
      threadId: TARGET_THREAD_ID,
      topicName: TARGET_TOPIC_NAME,
    });
    const created = await readJson(await api.post("/api/distribution", {
      data: { rule },
      timeout: 30_000,
    }), "daily supplement rule creation");
    if (created.rule?.id !== temporaryRuleId) throw new Error("daily supplement rule identity changed");
    ruleCreated = true;

    const previewPayload = await readJson(await api.post("/api/automation-test", {
      data: {
        jobId: dailyCase.contentType,
        targets: rule.targets,
        textOnly: false,
        demoShowcase: true,
        demoAcceptanceBatchId: acceptanceBatchId,
      },
      timeout: 90_000,
    }), "daily supplement preview");
    const preview = previewPayload.result?.preview || {};
    report.preview = assertDemoShowcasePreview(preview, dailyCase, { threadId: TARGET_THREAD_ID });
    report.mediaPreflight = [await preflightPoster(api, preview)];

    const validation = await readJson(await api.post("/api/distribution", {
      data: { action: "validate", id: temporaryRuleId },
      timeout: 60_000,
    }), "daily supplement rule validation");
    if (validation.result?.ok !== true) throw new Error("daily supplement rule validation failed");

    // Authorized one-shot supplement: the send path deliberately has no retry.
    const executionPayload = await readJson(await api.post("/api/distribution", {
      data: {
        action: "run-now",
        id: temporaryRuleId,
        exactTargets: true,
        textOnly: false,
        demoShowcase: true,
        demoAcceptanceBatchId: acceptanceBatchId,
      },
      timeout: 180_000,
    }), "daily Topic 8 supplement delivery");
    const deliveries = await readJson(await api.get("/api/distribution/logs?limit=100", {
      timeout: 30_000,
    }), "daily supplement delivery receipts");
    report.execution = assertDemoShowcaseExecution({
      ruleId: temporaryRuleId,
      execution: executionPayload.result || {},
      deliveries: deliveries.items || [],
      showcaseCase: dailyCase,
      threadId: TARGET_THREAD_ID,
    });
    report.product = report.execution.productTypes[0];
    report.finishedAt = new Date().toISOString();
    report.ok = report.product === "daily-market-brief"
      && report.execution.messageIds.length === 2
      && report.execution.target.threadId === TARGET_THREAD_ID;
  } catch (error) {
    report.finishedAt = new Date().toISOString();
    report.error = error?.message || String(error);
    throw error;
  } finally {
    let deleted = false;
    if (ruleCreated) {
      const response = await api.post("/api/distribution", {
        data: { action: "delete", id: temporaryRuleId },
        timeout: 30_000,
      }).catch(() => null);
      deleted = Boolean(response?.ok?.());
    }
    report.cleanup = { id: temporaryRuleId, deleted };
    if (ruleCreated && !deleted) report.ok = false;
    writeReport(report);
    await api.dispose();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
