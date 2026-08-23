const fs = require("node:fs");
const path = require("node:path");
const { request } = require("playwright");
const {
  CONTENT_TYPE,
  DEMO_CHAT_ID,
  DEMO_THREAD_ID,
  assertDemoAcceptanceExecution,
  assertDemoAcceptancePreview,
  selectDemoAcceptanceRule,
} = require("../lib/demo-content-acceptance.cjs");
const { authorizeLiveTelegramOperation } = require("../lib/release-gate.cjs");

const { baseUrl } = authorizeLiveTelegramOperation(process.env, {
  operation: "Academy DEMO 内容单次验收",
});
const username = process.env.TEST_USERNAME;
const password = process.env.TEST_PASSWORD;
const contentType = String(process.env.TEST_CONTENT_TYPE || "").trim();
const expectedChatId = String(process.env.TEST_EXPECTED_CHAT_ID || "").trim();
const expectedThreadId = Number(process.env.TEST_EXPECTED_THREAD_ID || 0);
const reportPath = path.resolve(process.env.TEST_REPORT_PATH || "artifacts/academy-demo-acceptance/report.json");

if (!username || !password) throw new Error("TEST_USERNAME and TEST_PASSWORD are required");
if (contentType !== CONTENT_TYPE) throw new Error(`TEST_CONTENT_TYPE must be ${CONTENT_TYPE}`);
if (expectedChatId !== DEMO_CHAT_ID || expectedThreadId !== DEMO_THREAD_ID) {
  throw new Error("Academy DEMO acceptance is fixed to chat -1003710405969, Topic 8");
}

async function readJson(response, label) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok() || payload.ok === false) {
    throw new Error(`${label}: HTTP ${response.status()} · ${payload.error || "request failed"}`);
  }
  return payload;
}

(async () => {
  const api = await request.newContext({ baseURL: baseUrl });
  const report = {
    ok: false,
    operation: "academy-demo-content-acceptance",
    contentType,
    target: { chatId: expectedChatId, threadId: expectedThreadId },
    exactTargets: true,
    startedAt: new Date().toISOString(),
  };
  try {
    await readJson(await api.post("/api/auth/login", {
      data: { username, password },
      timeout: 30_000,
    }), "login");

    const release = await readJson(await api.get("/api/release-info", { timeout: 30_000 }), "release info");
    const overview = await readJson(await api.get("/api/distribution", { timeout: 30_000 }), "distribution overview");
    const rule = selectDemoAcceptanceRule(overview.rules || [], {
      contentType,
      chatId: expectedChatId,
      threadId: expectedThreadId,
    });
    report.release = release;
    report.rule = { id: rule.id, name: rule.name || null, enabled: rule.enabled === true };

    const previewPayload = await readJson(await api.post("/api/automation-test", {
      data: { jobId: contentType },
      timeout: 90_000,
    }), "content preview");
    const preview = previewPayload.result?.preview || {};
    const previewEvidence = assertDemoAcceptancePreview(preview);
    report.preview = {
      ...previewEvidence,
      warnings: preview.warnings || preview.diagnostics?.warnings || [],
      generatedAt: preview.generatedAt || preview.document?.generatedAt || null,
      productId: preview.document?.id || preview.document?.productId || null,
    };

    const validationPayload = await readJson(await api.post("/api/distribution", {
      data: { action: "validate", id: rule.id },
      timeout: 60_000,
    }), "rule validation");
    if (validationPayload.result?.ok !== true) {
      throw new Error("Academy DEMO rule validation failed");
    }
    report.validation = {
      ok: true,
      checks: (validationPayload.result.checks || []).map(({ key, ok, message }) => ({ key, ok, message })),
    };

    const executionPayload = await readJson(await api.post("/api/distribution", {
      data: { action: "run-now", id: rule.id, exactTargets: true },
      timeout: 180_000,
    }), "exact-target delivery");
    const deliveryPayload = await readJson(await api.get("/api/distribution/logs?limit=100", {
      timeout: 30_000,
    }), "delivery receipts");
    report.receipt = assertDemoAcceptanceExecution({
      ruleId: rule.id,
      execution: executionPayload.result || {},
      deliveries: deliveryPayload.items || [],
      chatId: expectedChatId,
      threadId: expectedThreadId,
    });
    report.finishedAt = new Date().toISOString();
    report.ok = true;
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    if (process.env.ACCEPTANCE_QUIET !== "true") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await api.dispose();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
