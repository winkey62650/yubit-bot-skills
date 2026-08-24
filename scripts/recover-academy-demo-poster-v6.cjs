// One-shot governed recovery for the poster-v6 Academy DEMO acceptance batch.
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { request } = require("playwright");
const {
  DEMO_CHAT_ID,
  DEMO_SHOWCASE_CASES,
  assertDemoShowcasePosterUrls,
  assertDemoShowcaseExecution,
  assertDemoShowcasePreview,
  buildDemoShowcaseTemporaryRule,
  messageIdsOf,
  targetMatches,
} = require("../lib/demo-content-acceptance.cjs");
const { authorizeLiveTelegramOperation } = require("../lib/release-gate.cjs");

const MAX_POSTER_BYTES = 5 * 1024 * 1024;

const { baseUrl } = authorizeLiveTelegramOperation(process.env, {
  operation: "Academy DEMO v6 周度催化、数据快讯与市场跟进海报补发",
});
const username = process.env.TEST_USERNAME;
const password = process.env.TEST_PASSWORD;
const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
const reportPath = path.resolve(process.env.TEST_REPORT_PATH || "artifacts/academy-demo-showcase/poster-v6-recovery.json");
const acceptanceBatchId = String(process.env.ACADEMY_DEMO_ACCEPTANCE_BATCH_ID || "").trim().toLowerCase();
const priorDailyRuleId = "academy-demo-showcase-daily-validation-20260824-poster-v5-temporary";
const expectedPriorDailyMessageIds = Object.freeze([1321, 1322]);
const recoveryCases = DEMO_SHOWCASE_CASES.filter((item) => item.key === "weekly" || item.key === "release");
const recoveryRuleIds = Object.freeze({
  weekly: "academy-demo-showcase-weekly-recovery-20260824-poster-v6-temporary",
  release: "academy-demo-showcase-release-recovery-20260824-poster-v6-temporary",
});
const temporaryRulePattern = /^academy-demo-showcase-(daily|weekly|release)(?:-(?:recovery|validation)-[a-z0-9-]+)?-temporary$/;

if (!username || !password) throw new Error("TEST_USERNAME and TEST_PASSWORD are required");
if (!vaultPath) throw new Error("OBSIDIAN_VAULT_PATH is required");
if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(acceptanceBatchId)) {
  throw new Error("ACADEMY_DEMO_ACCEPTANCE_BATCH_ID_INVALID");
}
if (recoveryCases.length !== 2) throw new Error("Academy DEMO v6 recovery cases are unavailable");

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

function assertRecoveryState({ receipts, rules }) {
  const temporaryRules = rules.filter((rule) => temporaryRulePattern.test(String(rule?.id || "")));
  if (temporaryRules.length !== 0) throw new Error("Academy DEMO v6 recovery requires no temporary showcase rules");

  for (const ruleId of Object.values(recoveryRuleIds)) {
    if (receipts.some((receipt) => receipt.ruleId === ruleId)) {
      throw new Error(`Academy DEMO v6 recovery already has an immutable receipt for ${ruleId}`);
    }
  }

  // Historical acceptance attempts may legitimately share the same temporary
  // rule id. Lock recovery to the explicitly audited Telegram message pair
  // instead of rejecting the batch merely because older receipts coexist.
  const matching = receipts.filter((receipt) => (
    receipt.ruleId === priorDailyRuleId
    && JSON.stringify(messageIdsOf(receipt)) === JSON.stringify(expectedPriorDailyMessageIds)
  ));
  if (matching.length !== 1) throw new Error("Academy DEMO v6 recovery requires exactly one immutable poster-v5 daily receipt for messages 1321 and 1322");
  const receipt = matching[0];
  const messageIds = messageIdsOf(receipt);
  if (receipt.status !== "success"
    || !targetMatches(receipt.endpoint || receipt.target, { threadId: 10 })
    || JSON.stringify(messageIds) !== JSON.stringify(expectedPriorDailyMessageIds)
    || !receipt.contentProductId
    || !receipt.deliveryId
    || !receipt.receiptId) {
    throw new Error("Academy DEMO v6 recovery found an invalid immutable poster-v5 daily receipt");
  }
  return {
    key: "daily",
    productTypes: ["daily-market-brief"],
    productIds: [receipt.contentProductId],
    contentHashes: [receipt.contentHash],
    target: { chatId: DEMO_CHAT_ID, threadId: 10 },
    messageIds,
    deliveryId: receipt.deliveryId,
    feedbackReceiptId: receipt.receiptId,
  };
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

async function preflightPosters(api, preview, showcaseCase) {
  const steps = preview.deliveryPlans?.[0]?.steps || [];
  const posters = steps.filter((step) => step?.method === "sendPhoto");
  const identities = assertDemoShowcasePosterUrls(posters.map((step) => step?.payload?.photo), showcaseCase);
  const evidence = [];
  for (const identity of identities) {
    const response = await api.get(identity.url, { timeout: 90_000 });
    const contentType = String(response.headers()["content-type"] || "").toLowerCase();
    if (!response.ok() || !contentType.startsWith("image/png")) {
      throw new Error(`${showcaseCase.key} poster preflight failed: HTTP ${response.status()} · ${contentType || "missing content-type"}`);
    }
    const bytes = await response.body();
    if (bytes.byteLength < 1024 || bytes.byteLength > MAX_POSTER_BYTES) {
      throw new Error(`${showcaseCase.key} poster preflight failed: invalid PNG size ${bytes.byteLength}`);
    }
    evidence.push({
      ...identity,
      status: response.status(),
      contentType,
      byteLength: bytes.byteLength,
    });
  }
  return evidence;
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.ACCEPTANCE_QUIET !== "true") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

(async () => {
  const api = await request.newContext({ baseURL: baseUrl });
  const createdRuleIds = [];
  const report = {
    ok: false,
    operation: "academy-demo-poster-v6-residual-recovery",
    visualContract: "telegram-editorial-card-v4",
    historicalReplay: true,
    mediaIncluded: true,
    previewLabel: "DEMO PREVIEW · FORMAT TEST",
    exactTargets: true,
    acceptanceBatchId,
    targets: recoveryCases.map((item) => ({ chatId: DEMO_CHAT_ID, threadId: item.threadId })),
    priorExecution: null,
    executions: [],
    products: [],
    mediaPreflight: [],
    startedAt: new Date().toISOString(),
  };
  try {
    await readJson(await api.post("/api/auth/login", {
      data: { username, password },
      timeout: 30_000,
    }), "login");
    report.release = await readJson(await api.get("/api/release-info", { timeout: 30_000 }), "release info");

    const overview = await readJson(await api.get("/api/distribution", { timeout: 30_000 }), "distribution overview");
    report.priorExecution = assertRecoveryState({
      receipts: readImmutableDemoReceipts(),
      rules: overview.rules || [],
    });

    const fixtureUrl = pathToFileURL(path.resolve(__dirname, "../lib/academy-demo-showcase.mjs")).href;
    const { buildAcademyDemoShowcaseContent } = await import(fixtureUrl);
    const expectedIdentities = Object.fromEntries(recoveryCases.map((showcaseCase) => {
      const fixture = buildAcademyDemoShowcaseContent(showcaseCase.contentType, {
        now: new Date(),
        acceptanceBatchId,
      });
      return [showcaseCase.key, fixture.deduplicationKey];
    }));

    const prepared = [];
    // Preview and validate every residual product before the first live send.
    for (const showcaseCase of recoveryCases) {
      const rule = buildDemoShowcaseTemporaryRule(showcaseCase, { ruleId: recoveryRuleIds[showcaseCase.key] });
      const created = await readJson(await api.post("/api/distribution", {
        data: { rule },
        timeout: 30_000,
      }), `${showcaseCase.key} temporary rule creation`);
      if (created.rule?.id !== rule.id) throw new Error(`${showcaseCase.key} temporary rule identity changed`);
      createdRuleIds.push(created.rule.id);

      const previewPayload = await readJson(await api.post("/api/automation-test", {
        data: {
          jobId: showcaseCase.contentType,
          targets: created.rule.targets,
          textOnly: false,
          demoShowcase: true,
          demoAcceptanceBatchId: acceptanceBatchId,
        },
        timeout: 90_000,
      }), `${showcaseCase.key} content preview`);
      const preview = previewPayload.result?.preview || {};
      const previewEvidence = assertDemoShowcasePreview(preview, showcaseCase);
      report.mediaPreflight.push(...await preflightPosters(api, preview, showcaseCase));
      if (preview.deduplicationKey !== expectedIdentities[showcaseCase.key]) {
        throw new Error(`${showcaseCase.key} v6 durable delivery identity changed`);
      }

      const validation = await readJson(await api.post("/api/distribution", {
        data: { action: "validate", id: created.rule.id },
        timeout: 60_000,
      }), `${showcaseCase.key} rule validation`);
      if (validation.result?.ok !== true) throw new Error(`${showcaseCase.key} Academy DEMO rule validation failed`);
      prepared.push({ showcaseCase, rule: created.rule, preview: previewEvidence, deduplicationKey: preview.deduplicationKey });
    }
    report.previews = prepared.map(({ showcaseCase, preview, deduplicationKey }) => ({ key: showcaseCase.key, ...preview, deduplicationKey }));

    if (report.mediaPreflight.length !== 3
      || new Set(report.mediaPreflight.map((item) => item.url)).size !== 3
      || new Set(report.mediaPreflight.map((item) => item.templateId)).size !== 3) {
      throw new Error("Academy DEMO recovery requires three distinct canonical poster masters before delivery");
    }

    for (const { showcaseCase, rule } of prepared) {
      // Authorized one-shot recovery: one live call per case, deliberately without retry.
      const executionPayload = await readJson(await api.post("/api/distribution", {
        data: {
          action: "run-now",
          id: rule.id,
          exactTargets: true,
          textOnly: false,
          demoShowcase: true,
          demoAcceptanceBatchId: acceptanceBatchId,
        },
        timeout: 180_000,
      }), `${showcaseCase.key} exact-target delivery`);
      const deliveryPayload = await readJson(await api.get("/api/distribution/logs?limit=100", {
        timeout: 30_000,
      }), `${showcaseCase.key} delivery receipts`);
      report.executions.push(assertDemoShowcaseExecution({
        ruleId: rule.id,
        execution: executionPayload.result || {},
        deliveries: deliveryPayload.items || [],
        showcaseCase,
      }));
    }

    report.products = [
      ...productEvidence(report.priorExecution),
      ...report.executions.flatMap(productEvidence),
    ];
    report.finishedAt = new Date().toISOString();
    report.ok = report.executions.length === 2
      && report.executions.flatMap((item) => item.messageIds).length === 6
      && JSON.stringify(report.products.map((item) => item.product)) === JSON.stringify([
        "daily-market-brief",
        "weekly-catalyst-calendar",
        "data-flash",
        "market-follow-up",
      ]);
  } catch (error) {
    report.finishedAt = new Date().toISOString();
    report.error = error?.message || String(error);
    throw error;
  } finally {
    report.cleanup = [];
    for (const ruleId of [...createdRuleIds].reverse()) {
      const response = await api.post("/api/distribution", {
        data: { action: "delete", id: ruleId },
        timeout: 30_000,
      }).catch(() => null);
      report.cleanup.unshift({ id: ruleId, deleted: Boolean(response?.ok?.()) });
    }
    writeReport(report);
    await api.dispose();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
