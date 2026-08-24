const fs = require("node:fs");
const path = require("node:path");
const { request } = require("playwright");
const { authorizeLiveTelegramOperation } = require("../lib/release-gate.cjs");

const DEMO_CHAT_ID = "-1003710405969";
const MAX_POSTER_BYTES = 5 * 1024 * 1024;
const POSTER_TEMPLATES = Object.freeze({
  "daily-market-brief": "daily-market-brief-v4",
  "weekly-catalyst-calendar": "weekly-catalysts-v4",
  "data-flash": "data-flash-v4",
  "market-follow-up": "market-follow-up-v4",
});
const CASES = Object.freeze([
  Object.freeze({
    key: "daily",
    contentType: "crypto-daily",
    products: Object.freeze(["daily-market-brief"]),
    threadId: 10,
    topicName: "4. Market Analysis - Crypto/Stocks/TradFi",
    schedulePreset: "daily-0800-utc",
  }),
  Object.freeze({
    key: "weekly",
    contentType: "weekly-calendar",
    products: Object.freeze(["weekly-catalyst-calendar"]),
    threadId: 8,
    topicName: "3. Market Events",
    schedulePreset: "weekly-monday-0030-utc",
  }),
  Object.freeze({
    key: "release",
    contentType: "data-release-updates",
    products: Object.freeze(["data-flash", "market-follow-up"]),
    threadId: 8,
    topicName: "3. Market Events",
    schedulePreset: "event-driven",
  }),
]);

const { baseUrl } = authorizeLiveTelegramOperation(process.env, {
  operation: "Academy DEMO 实时内容 V4 海报与正文发送",
});
const username = process.env.TEST_USERNAME;
const password = process.env.TEST_PASSWORD;
const reportPath = path.resolve(process.env.TEST_REPORT_PATH || "artifacts/academy-realtime-demo/report.json");
if (!username || !password) throw new Error("TEST_USERNAME and TEST_PASSWORD are required");

async function readJson(response, label) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok() || payload.ok === false) {
    throw new Error(`${label}: HTTP ${response.status()} · ${payload.error || "request failed"}`);
  }
  return payload;
}

function messageIdsOf(value = {}) {
  const ids = value.messageIds?.length
    ? value.messageIds
    : value.targetMessageIds?.length
      ? value.targetMessageIds
      : value.messageId
        ? [value.messageId]
        : value.targetMessageId
          ? [value.targetMessageId]
          : [];
  return ids.map(Number).filter(Number.isFinite);
}

function targetMatches(target, item) {
  return String(target?.chatId || "") === DEMO_CHAT_ID
    && Number(target?.threadId || 0) === item.threadId
    && String(target?.platform || "telegram").toLowerCase() === "telegram"
    && !target?.guildId;
}

function inspectPosterSteps(steps, products, item) {
  const photos = steps.filter((step) => step?.method === "sendPhoto");
  if (photos.length !== products.length
    || photos.some((step) => !/^https:\/\//i.test(String(step?.payload?.photo || "")) || step?.payload?.caption)
    || steps[0]?.method !== "sendPhoto"
    || steps.some((step, index) => step?.method === "sendPhoto" && steps[index + 1]?.method !== "sendMessage")
    || steps.some((step) => !["sendPhoto", "sendMessage"].includes(step?.method))
    || steps.filter((step) => step?.method === "sendMessage").some((step) => !step?.payload?.text)) {
    throw new Error(`${item.key} must place one caption-free V4 poster immediately before each product text`);
  }
}

function inspectMediaDelivery(preview, products, item) {
  if (preview.textOnly === true || !preview.imageUrl) throw new Error(`${item.key} preview is missing poster media`);
  const byTemplateId = preview.mediaDelivery?.byTemplateId || {};
  const posterUrls = [];
  for (const product of products) {
    const templateId = POSTER_TEMPLATES[product.product];
    const posterUrl = String(byTemplateId[templateId] || "");
    if (!templateId || !/^https:\/\//i.test(posterUrl)) {
      throw new Error(`${item.key} is missing its approved V4 poster ${templateId || "template"}`);
    }
    posterUrls.push({ product: product.product, templateId, url: posterUrl });
  }
  return posterUrls;
}

async function preflightPoster(api, poster, item) {
  const response = await api.get(poster.url, { timeout: 90_000 });
  const contentType = String(response.headers()["content-type"] || "").toLowerCase();
  if (!response.ok() || !contentType.startsWith("image/png")) {
    throw new Error(`${item.key} poster preflight failed: HTTP ${response.status()} · ${contentType || "missing content-type"} · ${poster.url}`);
  }
  const bytes = await response.body();
  if (bytes.byteLength < 1024 || bytes.byteLength > MAX_POSTER_BYTES) {
    throw new Error(`${item.key} poster preflight failed: invalid PNG size ${bytes.byteLength} · ${poster.url}`);
  }
  return {
    product: poster.product,
    templateId: poster.templateId,
    url: poster.url,
    status: response.status(),
    contentType,
    byteLength: bytes.byteLength,
  };
}

function buildRule(item, nonce) {
  return {
    id: `academy-realtime-demo-${item.key}-${nonce}-temporary`,
    kind: "automation",
    name: `Academy DEMO · realtime · ${item.key}`,
    contentType: item.contentType,
    schedulePreset: item.schedulePreset,
    enabled: false,
    runOnce: false,
    status: "ready",
    targets: [{
      id: `academy-realtime-demo-${item.key}`,
      platform: "telegram",
      chatId: DEMO_CHAT_ID,
      threadId: item.threadId,
      groupName: "DEMO Academy",
      topicName: item.topicName,
    }],
  };
}

function inspectPreview(preview, item) {
  if (preview.demoShowcase === true) throw new Error(`${item.key} preview unexpectedly used historical replay`);
  const publishable = preview.publishable ?? preview.document?.publishable ?? false;
  const skipReason = preview.skipReason || preview.document?.skipReason || null;
  if (!publishable) return { publishable: false, skipReason };

  const governance = preview.contentGovernance || {};
  const products = Array.isArray(governance.products) ? governance.products : [];
  if (governance.approved !== true || products.length === 0
    || products.some((product) => product?.status !== "distribution-ready" || !item.products.includes(product?.product))) {
    throw new Error(`${item.key} preview failed content governance`);
  }
  const posterUrls = inspectMediaDelivery(preview, products, item);
  const plans = Array.isArray(preview.deliveryPlans) ? preview.deliveryPlans : [];
  if (plans.length !== 1 || !targetMatches(plans[0]?.target, item)) throw new Error(`${item.key} preview left its demo Topic`);
  const steps = Array.isArray(plans[0]?.steps) ? plans[0].steps : [];
  inspectPosterSteps(steps, products, item);
  return {
    publishable: true,
    productTypes: products.map((product) => product.product),
    productIds: products.map((product) => product.id),
    contentHashes: products.map((product) => product.contentHash),
    posterUrls,
    generatedAt: preview.generatedAt || null,
  };
}

function inspectExecution(execution, deliveries, rule, item) {
  if (execution.status !== "success") throw new Error(`${item.key} delivery failed: ${execution.error || execution.status || "unknown"}`);
  const preview = execution.run?.preview || {};
  if (preview.demoShowcase === true) {
    throw new Error(`${item.key} delivery unexpectedly used historical replay`);
  }
  const results = Array.isArray(preview.targetResults) ? preview.targetResults : [];
  if (results.length !== 1 || results[0]?.status !== "success" || !targetMatches(results[0]?.target, item)) {
    throw new Error(`${item.key} delivery did not remain on the demo Topic`);
  }
  const messageIds = messageIdsOf(results[0]);
  if (messageIds.length === 0) throw new Error(`${item.key} delivery returned no Telegram message id`);

  const governance = preview.contentGovernance || {};
  const products = Array.isArray(governance.products) ? governance.products : [];
  if (governance.approved !== true || products.length === 0
    || products.some((product) => product?.status !== "published" || !item.products.includes(product?.product))) {
    throw new Error(`${item.key} delivery did not publish canonical Obsidian products`);
  }
  inspectMediaDelivery(preview, products, item);
  const plans = Array.isArray(preview.deliveryPlans) ? preview.deliveryPlans : [];
  const plan = plans[0];
  if (plans.length !== 1 || plan?.contentPolicy !== "obsidian-canonical" || !targetMatches(plan?.target, item)) {
    throw new Error(`${item.key} delivery was not the canonical V4 poster plan`);
  }
  inspectPosterSteps(Array.isArray(plan?.steps) ? plan.steps : [], products, item);
  const matching = deliveries.filter((delivery) => delivery?.ruleId === rule.id
    && delivery?.status === "success" && targetMatches(delivery?.target, item)
    && messageIds.every((id) => messageIdsOf(delivery).includes(id)));
  if (matching.length !== 1) throw new Error(`${item.key} requires exactly one durable receipt`);
  const feedbackResults = Array.isArray(execution.feedbackResults) ? execution.feedbackResults : [];
  const feedback = feedbackResults.find((entry) => entry?.deliveryId === matching[0].id);
  if (execution.feedbackPersisted !== true || execution.feedbackPending === true
    || feedback?.feedbackPersisted !== true || feedback?.feedbackStatePersisted !== true || !feedback?.receiptId) {
    throw new Error(`${item.key} feedback closure was not persisted`);
  }
  return {
    status: "sent",
    productTypes: products.map((product) => product.product),
    productIds: products.map((product) => product.id),
    contentHashes: products.map((product) => product.contentHash),
    target: { chatId: DEMO_CHAT_ID, threadId: item.threadId },
    messageIds,
    deliveryId: matching[0].id,
    feedbackReceiptId: feedback.receiptId,
    deliveredAt: matching[0].deliveredAt || null,
  };
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.ACCEPTANCE_QUIET !== "true") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

(async () => {
  const api = await request.newContext({ baseURL: baseUrl });
  const temporaryRuleIds = [];
  const nonce = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const report = {
    ok: false,
    operation: "academy-realtime-demo-poster-delivery",
    historicalReplay: false,
    mediaIncluded: true,
    exactTargets: true,
    startedAt: new Date().toISOString(),
    previews: [],
    mediaPreflight: [],
    results: [],
  };
  try {
    await readJson(await api.post("/api/auth/login", {
      data: { username, password }, timeout: 30_000,
    }), "login");
    report.release = await readJson(await api.get("/api/release-info", { timeout: 30_000 }), "release info");

    // Complete every read-only eligibility and destination check before the first external send.
    const approved = [];
    for (const item of CASES) {
      const rule = buildRule(item, nonce);
      const created = await readJson(await api.post("/api/distribution", {
        data: { rule }, timeout: 30_000,
      }), `${item.key} temporary rule creation`);
      if (created.rule?.id !== rule.id) throw new Error(`${item.key} temporary rule identity changed`);
      temporaryRuleIds.push(rule.id);

      const previewPayload = await readJson(await api.post("/api/automation-test", {
        data: { jobId: item.contentType, targets: created.rule.targets, textOnly: false }, timeout: 90_000,
      }), `${item.key} realtime preview`);
      const evidence = inspectPreview(previewPayload.result?.preview || {}, item);
      report.previews.push({ key: item.key, contentType: item.contentType, ...evidence });
      if (!evidence.publishable) {
        report.results.push({ key: item.key, contentType: item.contentType, status: "skipped", skipReason: evidence.skipReason });
        continue;
      }
      const validation = await readJson(await api.post("/api/distribution", {
        data: { action: "validate", id: rule.id }, timeout: 60_000,
      }), `${item.key} rule validation`);
      if (validation.result?.ok !== true) throw new Error(`${item.key} runtime validation failed`);
      approved.push({ item, rule, posterUrls: evidence.posterUrls });
    }

    // Probe every exact server-rendered poster before any Telegram mutation.
    for (const { item, posterUrls } of approved) {
      for (const poster of posterUrls) report.mediaPreflight.push(await preflightPoster(api, poster, item));
    }

    // One authorized call per eligible product family. Deliberately no retry path.
    for (const { item, rule } of approved) {
      const executionPayload = await readJson(await api.post("/api/distribution", {
        data: { action: "run-now", id: rule.id, exactTargets: true, textOnly: false }, timeout: 180_000,
      }), `${item.key} exact-target delivery`);
      const deliveryPayload = await readJson(await api.get("/api/distribution/logs?limit=100", {
        timeout: 30_000,
      }), `${item.key} delivery receipts`);
      report.results.push({
        key: item.key,
        contentType: item.contentType,
        ...inspectExecution(executionPayload.result || {}, deliveryPayload.items || [], rule, item),
      });
    }
    report.finishedAt = new Date().toISOString();
    report.ok = report.results.length === CASES.length
      && report.results.every((result) => result.status === "sent" || result.status === "skipped");
  } catch (error) {
    report.finishedAt = new Date().toISOString();
    report.error = error?.message || String(error);
    throw error;
  } finally {
    const cleanup = [];
    for (const id of temporaryRuleIds.reverse()) {
      const response = await api.post("/api/distribution", {
        data: { action: "delete", id }, timeout: 30_000,
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
