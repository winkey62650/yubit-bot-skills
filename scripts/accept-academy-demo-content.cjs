const fs = require("node:fs");
const path = require("node:path");
const { request } = require("playwright");
const {
  DEMO_CHAT_ID,
  DEMO_SHOWCASE_CASES,
  assertDemoShowcaseExecution,
  assertDemoShowcasePreview,
  buildDemoShowcaseTemporaryRule,
} = require("../lib/demo-content-acceptance.cjs");
const { authorizeLiveTelegramOperation } = require("../lib/release-gate.cjs");

const { baseUrl } = authorizeLiveTelegramOperation(process.env, {
  operation: "Academy DEMO 四种内容纯文字验收",
});
const username = process.env.TEST_USERNAME;
const password = process.env.TEST_PASSWORD;
const reportPath = path.resolve(process.env.TEST_REPORT_PATH || "artifacts/academy-demo-showcase/report.json");
const validationTag = "validation-20260824-v3";

if (!username || !password) throw new Error("TEST_USERNAME and TEST_PASSWORD are required");

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

(async () => {
  const api = await request.newContext({ baseURL: baseUrl });
  const temporaryRuleIds = [];
  const report = {
    ok: false,
    operation: "academy-demo-four-product-text-showcase",
    historicalReplay: true,
    mediaIncluded: false,
    visualContract: "telegram-editorial-card-v3",
    previewLabel: "DEMO PREVIEW · FORMAT TEST",
    exactTargets: true,
    targets: DEMO_SHOWCASE_CASES.map((item) => ({ chatId: DEMO_CHAT_ID, threadId: item.threadId })),
    products: [],
    previews: [],
    executions: [],
    startedAt: new Date().toISOString(),
  };
  try {
    await readJson(await api.post("/api/auth/login", {
      data: { username, password },
      timeout: 30_000,
    }), "login");
    report.release = await readJson(await api.get("/api/release-info", { timeout: 30_000 }), "release info");

    const rules = [];
    for (const showcaseCase of DEMO_SHOWCASE_CASES) {
      const temporaryRule = buildDemoShowcaseTemporaryRule(showcaseCase, {
        ruleId: `academy-demo-showcase-${showcaseCase.key}-${validationTag}-temporary`,
      });
      const created = await readJson(await api.post("/api/distribution", {
        data: { rule: temporaryRule },
        timeout: 30_000,
      }), `${showcaseCase.key} temporary rule creation`);
      if (created.rule?.id !== temporaryRule.id) throw new Error(`${showcaseCase.key} temporary rule identity changed`);
      rules.push(created.rule);
      temporaryRuleIds.push(created.rule.id);
    }

    // Finish all read-only content and destination checks before the first send.
    // The send loop below deliberately has no retry path.
    for (let index = 0; index < DEMO_SHOWCASE_CASES.length; index += 1) {
      const showcaseCase = DEMO_SHOWCASE_CASES[index];
      const rule = rules[index];
      const previewPayload = await readJson(await api.post("/api/automation-test", {
        data: {
          jobId: showcaseCase.contentType,
          targets: rule.targets,
          textOnly: true,
          demoShowcase: true,
        },
        timeout: 90_000,
      }), `${showcaseCase.key} content preview`);
      const preview = previewPayload.result?.preview || {};
      const evidence = assertDemoShowcasePreview(preview, showcaseCase);
      report.previews.push({ key: showcaseCase.key, contentType: showcaseCase.contentType, ...evidence });

      const validation = await readJson(await api.post("/api/distribution", {
        data: { action: "validate", id: rule.id },
        timeout: 60_000,
      }), `${showcaseCase.key} rule validation`);
      if (validation.result?.ok !== true) throw new Error(`${showcaseCase.key} Academy DEMO rule validation failed`);
    }

    for (let index = 0; index < DEMO_SHOWCASE_CASES.length; index += 1) {
      const showcaseCase = DEMO_SHOWCASE_CASES[index];
      const rule = rules[index];
      const executionPayload = await readJson(await api.post("/api/distribution", {
        data: {
          action: "run-now",
          id: rule.id,
          exactTargets: true,
          textOnly: true,
          demoShowcase: true,
        },
        timeout: 180_000,
      }), `${showcaseCase.key} exact-target delivery`);
      const deliveryPayload = await readJson(await api.get("/api/distribution/logs?limit=100", {
        timeout: 30_000,
      }), `${showcaseCase.key} delivery receipts`);
      const execution = assertDemoShowcaseExecution({
        ruleId: rule.id,
        execution: executionPayload.result || {},
        deliveries: deliveryPayload.items || [],
        showcaseCase,
      });
      report.executions.push(execution);
      report.products.push(...execution.productTypes.map((product, productIndex) => ({
        product,
        productId: execution.productIds[productIndex],
        contentHash: execution.contentHashes[productIndex],
        target: execution.target,
        messageIds: execution.messageIds,
      })));
    }

    report.finishedAt = new Date().toISOString();
    report.ok = report.products.length === 4 && report.executions.length === 3;
  } catch (error) {
    report.finishedAt = new Date().toISOString();
    report.error = error?.message || String(error);
    throw error;
  } finally {
    const cleanup = [];
    for (const id of temporaryRuleIds.reverse()) {
      const response = await api.post("/api/distribution", {
        data: { action: "delete", id },
        timeout: 30_000,
      }).catch(() => null);
      cleanup.push({ id, deleted: Boolean(response?.ok?.()) });
    }
    report.cleanup = cleanup;
    writeReport(report);
    await api.dispose();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
