const fs = require("node:fs");
const path = require("node:path");
const { request } = require("playwright");
const {
  DEMO_CHAT_ID,
  DEMO_SHOWCASE_CASES,
  assertDemoShowcasePosterUrls,
  assertDemoShowcaseExecution,
  assertDemoShowcasePreview,
  buildDemoShowcaseTemporaryRule,
} = require("../lib/demo-content-acceptance.cjs");
const { authorizeLiveTelegramOperation } = require("../lib/release-gate.cjs");

const MAX_POSTER_BYTES = 5 * 1024 * 1024;
const DEMO_DESTINATION_CTA = [
  "_________________",
  "💎 **YUBIT | TRADE WITHOUT LIMITS**",
  "",
  "**Crypto · TradFi · One Exchange**",
  "",
  "👉 **[START TRADING NOW ↗](https://www.yubit.com/en-US/register?inviteCode=MJOD)**",
].join("\n");

const { baseUrl } = authorizeLiveTelegramOperation(process.env, {
  operation: "Academy DEMO 四种内容海报与正文验收",
});
const username = process.env.TEST_USERNAME;
const password = process.env.TEST_PASSWORD;
const reportPath = path.resolve(process.env.TEST_REPORT_PATH || "artifacts/academy-demo-showcase/report.json");
const validationTag = "validation-20260824-poster-v6";
const acceptanceBatchId = String(process.env.ACADEMY_DEMO_ACCEPTANCE_BATCH_ID || "").trim().toLowerCase();

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

async function preflightPosters(api, preview, showcaseCase) {
  const posters = (preview.deliveryPlans?.[0]?.steps || []).filter((step) => step?.method === "sendPhoto");
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
    evidence.push({ ...identity, status: response.status(), contentType, byteLength: bytes.byteLength });
  }
  return evidence;
}

async function ensureDemoDestinationCta(api) {
  const ctaKey = `telegram:${DEMO_CHAT_ID}`;
  const before = await readJson(await api.get("/api/destination-cta", { timeout: 30_000 }), "destination CTA");
  const existing = before.registry?.[ctaKey];
  if (existing?.ctaEnabled === true && String(existing.ctaContent || "").trim()) {
    return { restored: false, key: ctaKey, source: "destination-registry" };
  }

  const saved = await readJson(await api.post("/api/destination-cta", {
    data: {
      config: {
        platform: "telegram",
        chatId: DEMO_CHAT_ID,
        chatType: "supergroup",
        groupName: "DEMO Academy",
        ctaEnabled: true,
        ctaContent: DEMO_DESTINATION_CTA,
      },
    },
    timeout: 30_000,
  }), "restore DEMO destination CTA");
  const restored = saved.registry?.[ctaKey];
  if (restored?.ctaEnabled !== true || String(restored.ctaContent || "").trim() !== DEMO_DESTINATION_CTA) {
    throw new Error("DEMO destination CTA restore did not persist exactly");
  }
  return { restored: true, key: ctaKey, source: "verified-public-cta-archive" };
}

(async () => {
  const api = await request.newContext({ baseURL: baseUrl });
  const temporaryRuleIds = [];
  const report = {
    ok: false,
    operation: "academy-demo-four-product-poster-showcase",
    historicalReplay: true,
    mediaIncluded: true,
    visualContract: "telegram-editorial-card-v4",
    previewLabel: "DEMO PREVIEW · FORMAT TEST",
    exactTargets: true,
    acceptanceBatchId,
    targets: DEMO_SHOWCASE_CASES.map((item) => ({ chatId: DEMO_CHAT_ID, threadId: item.threadId })),
    products: [],
    previews: [],
    executions: [],
    mediaPreflight: [],
    startedAt: new Date().toISOString(),
  };
  try {
    await readJson(await api.post("/api/auth/login", {
      data: { username, password },
      timeout: 30_000,
    }), "login");
    report.release = await readJson(await api.get("/api/release-info", { timeout: 30_000 }), "release info");
    report.destinationCta = await ensureDemoDestinationCta(api);

    const rules = [];
    for (const showcaseCase of DEMO_SHOWCASE_CASES) {
      const temporaryRule = buildDemoShowcaseTemporaryRule(showcaseCase, {
        ruleId: `academy-demo-showcase-${showcaseCase.key}-${validationTag}-${acceptanceBatchId}-temporary`,
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
          textOnly: false,
          demoShowcase: true,
          demoAcceptanceBatchId: acceptanceBatchId,
        },
        timeout: 90_000,
      }), `${showcaseCase.key} content preview`);
      const preview = previewPayload.result?.preview || {};
      const evidence = assertDemoShowcasePreview(preview, showcaseCase);
      report.previews.push({ key: showcaseCase.key, contentType: showcaseCase.contentType, ...evidence });
      report.mediaPreflight.push(...await preflightPosters(api, preview, showcaseCase));

      const validation = await readJson(await api.post("/api/distribution", {
        data: { action: "validate", id: rule.id },
        timeout: 60_000,
      }), `${showcaseCase.key} rule validation`);
      if (validation.result?.ok !== true) throw new Error(`${showcaseCase.key} Academy DEMO rule validation failed`);
    }

    if (report.mediaPreflight.length !== 4
      || new Set(report.mediaPreflight.map((item) => item.url)).size !== 4
      || new Set(report.mediaPreflight.map((item) => item.templateId)).size !== 4) {
      throw new Error("Academy DEMO batch requires four distinct canonical poster masters before delivery");
    }

    for (let index = 0; index < DEMO_SHOWCASE_CASES.length; index += 1) {
      const showcaseCase = DEMO_SHOWCASE_CASES[index];
      const rule = rules[index];
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
