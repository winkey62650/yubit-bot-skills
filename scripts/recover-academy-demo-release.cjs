const fs = require("node:fs");
const path = require("node:path");
const { request } = require("playwright");
const {
  DEMO_CHAT_ID,
  DEMO_SHOWCASE_CASES,
  assertDemoShowcaseExecution,
  assertDemoShowcasePreview,
  assertDemoShowcaseRecoveryState,
  buildDemoShowcaseTemporaryRule,
} = require("../lib/demo-content-acceptance.cjs");
const { authorizeLiveTelegramOperation } = require("../lib/release-gate.cjs");

const { baseUrl } = authorizeLiveTelegramOperation(process.env, {
  operation: "Academy DEMO 数据快讯与市场跟进补发",
});
const username = process.env.TEST_USERNAME;
const password = process.env.TEST_PASSWORD;
const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
const reportPath = path.resolve(process.env.TEST_REPORT_PATH || "artifacts/academy-demo-showcase/recovery.json");
const releaseCase = DEMO_SHOWCASE_CASES.find((item) => item.key === "release");
const expectedPrior = Object.freeze({ daily: 1290, weekly: 1291 });
const temporaryRulePattern = /^academy-demo-showcase-(daily|weekly|release)-temporary$/;

if (!username || !password) throw new Error("TEST_USERNAME and TEST_PASSWORD are required");
if (!vaultPath) throw new Error("OBSIDIAN_VAULT_PATH is required");
if (!releaseCase) throw new Error("Academy DEMO release showcase case is unavailable");

async function readJson(response, label) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok() || payload.ok === false) {
    throw new Error(`${label}: HTTP ${response.status()} · ${payload.error || "request failed"}`);
  }
  return payload;
}

function canonicalPayload(markdown) {
  const marker = "<!-- yubit-canonical-payload:v1 -->\n\n```json\n";
  const start = markdown.lastIndexOf(marker);
  if (start < 0 || !markdown.endsWith("\n```\n")) return null;
  return JSON.parse(markdown.slice(start + marker.length, -5));
}

function readImmutableDemoReceipts() {
  const directory = path.join(vaultPath, "40 Distribution");
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "INDEX.md")
    .map((entry) => canonicalPayload(fs.readFileSync(path.join(directory, entry.name), "utf8")))
    .filter((payload) => payload && temporaryRulePattern.test(String(payload.ruleId || "")));
}

function assertKnownPriorMessages(priorExecutions) {
  for (const execution of priorExecutions) {
    if (execution.messageIds.length !== 1 || execution.messageIds[0] !== expectedPrior[execution.key]) {
      throw new Error(`Academy DEMO recovery prior ${execution.key} message identity changed`);
    }
  }
}

function productEvidence(execution) {
  return execution.productTypes.map((product, index) => ({
    product,
    productId: execution.productIds[index],
    contentHash: execution.contentHashes?.[index] || null,
    target: execution.target,
    messageIds: execution.messageIds,
  }));
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.ACCEPTANCE_QUIET !== "true") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

(async () => {
  const api = await request.newContext({ baseURL: baseUrl });
  let temporaryRuleId = null;
  const report = {
    ok: false,
    operation: "academy-demo-release-only-recovery",
    historicalReplay: true,
    mediaIncluded: false,
    exactTargets: true,
    targets: [{ chatId: DEMO_CHAT_ID, threadId: releaseCase.threadId }],
    priorExecutions: [],
    recoveryExecution: null,
    products: [],
    startedAt: new Date().toISOString(),
  };
  try {
    await readJson(await api.post("/api/auth/login", {
      data: { username, password },
      timeout: 30_000,
    }), "login");
    report.release = await readJson(await api.get("/api/release-info", { timeout: 30_000 }), "release info");

    const overview = await readJson(await api.get("/api/distribution", { timeout: 30_000 }), "distribution overview");
    report.priorExecutions = assertDemoShowcaseRecoveryState({
      receipts: readImmutableDemoReceipts(),
      rules: overview.rules || [],
    });
    assertKnownPriorMessages(report.priorExecutions);

    const temporaryRule = buildDemoShowcaseTemporaryRule(releaseCase);
    const created = await readJson(await api.post("/api/distribution", {
      data: { rule: temporaryRule },
      timeout: 30_000,
    }), "release temporary rule creation");
    if (created.rule?.id !== temporaryRule.id) throw new Error("release temporary rule identity changed");
    temporaryRuleId = created.rule.id;

    const previewPayload = await readJson(await api.post("/api/automation-test", {
      data: {
        jobId: releaseCase.contentType,
        targets: created.rule.targets,
        textOnly: true,
        demoShowcase: true,
      },
      timeout: 90_000,
    }), "release content preview");
    report.preview = assertDemoShowcasePreview(previewPayload.result?.preview || {}, releaseCase);

    const validation = await readJson(await api.post("/api/distribution", {
      data: { action: "validate", id: created.rule.id },
      timeout: 60_000,
    }), "release rule validation");
    if (validation.result?.ok !== true) throw new Error("release Academy DEMO rule validation failed");

    // Authorized one-shot recovery: exactly one live call, deliberately without retry.
    const executionPayload = await readJson(await api.post("/api/distribution", {
      data: {
        action: "run-now",
        id: created.rule.id,
        exactTargets: true,
        textOnly: true,
        demoShowcase: true,
      },
      timeout: 180_000,
    }), "release exact-target delivery");
    const deliveryPayload = await readJson(await api.get("/api/distribution/logs?limit=100", {
      timeout: 30_000,
    }), "release delivery receipts");
    report.recoveryExecution = assertDemoShowcaseExecution({
      ruleId: created.rule.id,
      execution: executionPayload.result || {},
      deliveries: deliveryPayload.items || [],
      showcaseCase: releaseCase,
    });
    report.products = [
      ...report.priorExecutions.flatMap(productEvidence),
      ...productEvidence(report.recoveryExecution),
    ];
    report.finishedAt = new Date().toISOString();
    report.ok = report.priorExecutions.length === 2
      && report.recoveryExecution.productTypes.length === 2
      && report.products.length === 4;
  } catch (error) {
    report.finishedAt = new Date().toISOString();
    report.error = error?.message || String(error);
    throw error;
  } finally {
    if (temporaryRuleId) {
      const response = await api.post("/api/distribution", {
        data: { action: "delete", id: temporaryRuleId },
        timeout: 30_000,
      }).catch(() => null);
      report.cleanup = [{ id: temporaryRuleId, deleted: Boolean(response?.ok?.()) }];
    } else {
      report.cleanup = [];
    }
    writeReport(report);
    await api.dispose();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
