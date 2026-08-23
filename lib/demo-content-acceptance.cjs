const DEMO_CHAT_ID = "-1003710405969";
const DEMO_THREAD_ID = 8;
const CONTENT_TYPE = "crypto-daily";
const DEMO_SHOWCASE_CASES = Object.freeze([
  Object.freeze({
    key: "daily",
    contentType: "crypto-daily",
    productTypes: Object.freeze(["daily-market-brief"]),
    threadId: 10,
    topicName: "4. Market Analysis - Crypto/Stocks/TradFi",
    schedulePreset: "daily-0800-utc",
  }),
  Object.freeze({
    key: "weekly",
    contentType: "weekly-calendar",
    productTypes: Object.freeze(["weekly-catalyst-calendar"]),
    threadId: 8,
    topicName: "3. Market Events",
    schedulePreset: "weekly-monday-0030-utc",
  }),
  Object.freeze({
    key: "release",
    contentType: "data-release-updates",
    productTypes: Object.freeze(["data-flash", "market-follow-up"]),
    threadId: 8,
    topicName: "3. Market Events",
    schedulePreset: "event-driven",
  }),
]);

function targetMatches(target, {
  chatId = DEMO_CHAT_ID,
  threadId = DEMO_THREAD_ID,
} = {}) {
  return String(target?.chatId || "") === String(chatId)
    && Number(target?.threadId || 0) === Number(threadId)
    && target?.platform !== "discord"
    && !target?.guildId;
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

function buildDemoAcceptanceTemporaryRule({
  chatId = DEMO_CHAT_ID,
  threadId = DEMO_THREAD_ID,
} = {}) {
  return {
    id: "academy-demo-acceptance-temporary",
    kind: "automation",
    name: "Academy DEMO · Temporary Acceptance",
    contentType: CONTENT_TYPE,
    schedulePreset: "daily-0800-utc",
    enabled: false,
    runOnce: false,
    status: "ready",
    targets: [{
      id: "demo-events",
      chatId: String(chatId),
      threadId: Number(threadId),
      groupName: "DEMO Academy",
      topicName: "3. Market Events",
    }],
  };
}

function demoShowcaseRuleKey(ruleId) {
  const match = /^academy-demo-showcase-(daily|weekly|release)(?:-(?:recovery|validation)-[a-z0-9-]+)?-temporary$/
    .exec(String(ruleId || ""));
  return match?.[1] || null;
}

function buildDemoShowcaseTemporaryRule(showcaseCase, {
  chatId = DEMO_CHAT_ID,
  ruleId = `academy-demo-showcase-${showcaseCase?.key}-temporary`,
} = {}) {
  if (!DEMO_SHOWCASE_CASES.includes(showcaseCase)) throw new Error("Unknown Academy DEMO showcase case");
  if (demoShowcaseRuleKey(ruleId) !== showcaseCase.key) {
    throw new Error("Academy DEMO showcase rule identity does not match its content case");
  }
  return {
    id: ruleId,
    kind: "automation",
    name: `Academy DEMO · ${showcaseCase.productTypes.join(" + ")}`,
    contentType: showcaseCase.contentType,
    schedulePreset: showcaseCase.schedulePreset,
    enabled: false,
    runOnce: false,
    status: "ready",
    targets: [{
      id: `demo-showcase-${showcaseCase.key}`,
      platform: "telegram",
      chatId: String(chatId),
      threadId: showcaseCase.threadId,
      groupName: "DEMO Academy",
      topicName: showcaseCase.topicName,
    }],
  };
}

function selectDemoAcceptanceRule(rules = [], {
  contentType = CONTENT_TYPE,
  chatId = DEMO_CHAT_ID,
  threadId = DEMO_THREAD_ID,
} = {}) {
  if (contentType !== CONTENT_TYPE) {
    throw new Error(`DEMO acceptance only permits ${CONTENT_TYPE}`);
  }
  const candidates = rules.filter((rule) => rule?.kind === "automation"
    && rule?.contentType === contentType
    && rule?.runOnce !== true);
  if (candidates.length !== 1) {
    const summary = candidates.map((rule) => ({
      id: rule.id || null,
      name: rule.name || null,
      schedulePreset: rule.schedulePreset || null,
      targets: (Array.isArray(rule.targets) ? rule.targets : []).map((target) => ({
        platform: target.platform || "telegram",
        chatId: target.chatId || null,
        threadId: Number(target.threadId || 0) || null,
        enabled: target.enabled !== false,
      })),
    }));
    throw new Error(`DEMO acceptance requires exactly one recurring ${contentType} rule; candidates=${JSON.stringify(summary)}`);
  }
  const rule = candidates[0];
  const targets = (rule.targets || []).filter((target) => target?.enabled !== false);
  if (targets.length !== 1) {
    throw new Error("DEMO acceptance requires exactly one target");
  }
  if (!targetMatches(targets[0], { chatId, threadId })) {
    throw new Error("DEMO acceptance target must be the approved DEMO Topic 8");
  }
  return rule;
}

function previewSources(preview = {}) {
  return [preview.sources, preview.diagnostics?.sources, preview.document?.diagnostics?.sources]
    .find((items) => Array.isArray(items) && items.length > 0) || [];
}

function assertDemoAcceptancePreview(preview = {}) {
  const publishable = preview.publishable ?? preview.document?.publishable ?? false;
  if (!publishable) {
    const reason = preview.skipReason || preview.document?.skipReason || "unspecified";
    throw new Error(`DEMO acceptance preview is not publishable: ${reason}`);
  }
  const sources = previewSources(preview);
  const healthySources = sources.filter((source) => (
    ["ok", "healthy", "success"].includes(String(source?.status || "").trim().toLowerCase())
  ));
  if (healthySources.length === 0) {
    throw new Error("DEMO acceptance preview requires at least one healthy source");
  }
  return { sourceCount: sources.length, healthySourceCount: healthySources.length };
}

function assertDemoAcceptanceExecution({
  ruleId,
  execution = {},
  deliveries = [],
  chatId = DEMO_CHAT_ID,
  threadId = DEMO_THREAD_ID,
} = {}) {
  if (execution.status !== "success") {
    throw new Error(`DEMO acceptance execution failed: ${execution.error || execution.status || "unknown"}`);
  }
  const results = execution.run?.preview?.targetResults || [];
  if (results.length !== 1) {
    throw new Error("DEMO acceptance execution must return exactly one target result");
  }
  const result = results[0];
  if (!targetMatches(result.target, { chatId, threadId })) {
    throw new Error("DEMO acceptance execution left the approved DEMO Topic 8");
  }
  const messageIds = messageIdsOf(result);
  if (result.status !== "success" || messageIds.length === 0) {
    throw new Error("DEMO acceptance did not return successful Telegram message IDs");
  }
  const governance = execution.run?.preview?.contentGovernance || {};
  const products = Array.isArray(governance.products) ? governance.products : [];
  const plans = Array.isArray(execution.run?.preview?.deliveryPlans)
    ? execution.run.preview.deliveryPlans
    : [];
  if (governance.approved !== true || products.length !== 1 || products[0]?.status !== "published") {
    throw new Error("DEMO acceptance requires one published Obsidian content product");
  }
  const plan = plans.find((entry) => targetMatches(entry?.target, { chatId, threadId }));
  if (plans.length !== 1
    || plan?.contentPolicy !== "obsidian-canonical"
    || plan?.contentProductId !== products[0].id
    || !plan?.contentHash
    || plan.contentHash !== products[0].contentHash) {
    throw new Error("DEMO acceptance requires one canonical Obsidian delivery plan");
  }
  const matching = deliveries.filter((delivery) => delivery?.ruleId === ruleId
    && delivery?.status === "success"
    && targetMatches(delivery.target, { chatId, threadId })
    && messageIds.every((id) => messageIdsOf(delivery).includes(id)));
  if (matching.length !== 1) {
    throw new Error("DEMO acceptance requires exactly one matching durable receipt");
  }
  const feedbackResults = Array.isArray(execution.feedbackResults) ? execution.feedbackResults : [];
  const feedback = feedbackResults.find((entry) => entry?.deliveryId === matching[0].id);
  if (execution.feedbackPersisted !== true
    || execution.feedbackPending === true
    || feedback?.feedbackPersisted !== true
    || feedback?.feedbackStatePersisted !== true
    || !feedback?.receiptId) {
    throw new Error("DEMO acceptance requires a persisted Obsidian feedback closure");
  }
  return {
    messageIds,
    deliveryId: matching[0].id,
    feedbackReceiptId: feedback.receiptId,
    productId: products[0].id,
    contentHash: products[0].contentHash,
    deliveredAt: matching[0].deliveredAt || null,
    generatedAt: execution.run?.preview?.generatedAt || null,
  };
}

function assertDemoShowcasePreview(preview = {}, showcaseCase) {
  if (!DEMO_SHOWCASE_CASES.includes(showcaseCase)) throw new Error("Unknown Academy DEMO showcase case");
  if (preview.demoShowcase !== true || preview.textOnly !== true || preview.imageUrl !== null) {
    throw new Error("Academy DEMO showcase preview must be explicit, text-only, and media-free");
  }
  if (preview.publishable !== true) throw new Error(`Academy DEMO showcase preview is not publishable: ${preview.skipReason || "unknown"}`);
  const governance = preview.contentGovernance || {};
  const products = Array.isArray(governance.products) ? governance.products : [];
  if (governance.approved !== true
    || products.some((product) => product?.status !== "distribution-ready")
    || JSON.stringify(products.map((product) => product.product)) !== JSON.stringify(showcaseCase.productTypes)) {
    throw new Error("Academy DEMO showcase preview failed content governance");
  }
  const plans = Array.isArray(preview.deliveryPlans) ? preview.deliveryPlans : [];
  if (plans.length !== 1 || !targetMatches(plans[0]?.target, { threadId: showcaseCase.threadId })) {
    throw new Error("Academy DEMO showcase preview must resolve to exactly one approved Topic");
  }
  const steps = Array.isArray(plans[0].steps) ? plans[0].steps : [];
  if (steps.length < showcaseCase.productTypes.length
    || steps.some((step) => step?.method !== "sendMessage" || step?.payload?.photo || step?.payload?.imageUrl)) {
    throw new Error("Academy DEMO showcase preview contains media or missing text products");
  }
  return { productIds: products.map((product) => product.id), stepCount: steps.length };
}

function assertDemoShowcaseExecution({ ruleId, execution = {}, deliveries = [], showcaseCase } = {}) {
  if (!DEMO_SHOWCASE_CASES.includes(showcaseCase)) throw new Error("Unknown Academy DEMO showcase case");
  if (execution.status !== "success") throw new Error(`Academy DEMO showcase execution failed: ${execution.error || execution.status || "unknown"}`);
  const preview = execution.run?.preview || {};
  if (preview.demoShowcase !== true || preview.textOnly !== true || preview.imageUrl !== null) {
    throw new Error("Academy DEMO showcase execution lost its text-only safety flags");
  }
  const results = Array.isArray(preview.targetResults) ? preview.targetResults : [];
  if (results.length !== 1 || !targetMatches(results[0]?.target, { threadId: showcaseCase.threadId })) {
    throw new Error("Academy DEMO showcase execution left its approved Topic");
  }
  const messageIds = messageIdsOf(results[0]);
  if (results[0]?.status !== "success" || messageIds.length < showcaseCase.productTypes.length) {
    throw new Error("Academy DEMO showcase execution did not return every text message ID");
  }
  const governance = preview.contentGovernance || {};
  const products = Array.isArray(governance.products) ? governance.products : [];
  if (governance.approved !== true
    || products.some((product) => product?.status !== "published")
    || JSON.stringify(products.map((product) => product.product)) !== JSON.stringify(showcaseCase.productTypes)) {
    throw new Error("Academy DEMO showcase requires every Obsidian product to be published");
  }
  const plans = Array.isArray(preview.deliveryPlans) ? preview.deliveryPlans : [];
  const plan = plans[0];
  if (plans.length !== 1
    || plan?.contentPolicy !== "obsidian-canonical"
    || JSON.stringify(plan?.contentProductIds) !== JSON.stringify(products.map((product) => product.id))
    || JSON.stringify(plan?.contentHashes) !== JSON.stringify(products.map((product) => product.contentHash))
    || plan.steps?.some((step) => step?.method !== "sendMessage" || step?.payload?.photo || step?.payload?.imageUrl)) {
    throw new Error("Academy DEMO showcase requires one media-free canonical Obsidian delivery plan");
  }
  const matching = deliveries.filter((delivery) => delivery?.ruleId === ruleId
    && delivery?.status === "success"
    && targetMatches(delivery.target, { threadId: showcaseCase.threadId })
    && messageIds.every((id) => messageIdsOf(delivery).includes(id)));
  if (matching.length !== 1) throw new Error("Academy DEMO showcase requires exactly one matching durable receipt");
  const feedbackResults = Array.isArray(execution.feedbackResults) ? execution.feedbackResults : [];
  const feedback = feedbackResults.find((entry) => entry?.deliveryId === matching[0].id);
  if (execution.feedbackPersisted !== true || execution.feedbackPending === true
    || feedback?.feedbackPersisted !== true || feedback?.feedbackStatePersisted !== true || !feedback?.receiptId) {
    throw new Error("Academy DEMO showcase requires a persisted Obsidian feedback closure");
  }
  return {
    contentType: showcaseCase.contentType,
    productTypes: showcaseCase.productTypes,
    productIds: products.map((product) => product.id),
    contentHashes: products.map((product) => product.contentHash),
    target: { chatId: DEMO_CHAT_ID, threadId: showcaseCase.threadId },
    messageIds,
    deliveryId: matching[0].id,
    feedbackReceiptId: feedback.receiptId,
    deliveredAt: matching[0].deliveredAt || null,
  };
}

function assertDemoShowcaseRecoveryState({ receipts = [], rules = [] } = {}) {
  const temporaryRules = rules.filter((rule) => demoShowcaseRuleKey(rule?.id));
  if (temporaryRules.length !== 0) {
    throw new Error("Academy DEMO recovery requires no temporary showcase rules");
  }

  const byKey = (key) => receipts.filter((receipt) => demoShowcaseRuleKey(receipt?.ruleId) === key);
  const releaseReceipts = byKey("release");
  if (releaseReceipts.length !== 0) {
    throw new Error("Academy DEMO recovery requires no prior release receipt");
  }

  return DEMO_SHOWCASE_CASES.slice(0, 2).map((showcaseCase) => {
    const matching = byKey(showcaseCase.key);
    if (matching.length !== 1) {
      throw new Error(`Academy DEMO recovery requires exactly one immutable ${showcaseCase.key} receipt`);
    }
    const receipt = matching[0];
    const target = receipt.endpoint || receipt.target;
    const messageIds = messageIdsOf(receipt);
    if (receipt.status !== "success"
      || !targetMatches(target, { threadId: showcaseCase.threadId })
      || messageIds.length !== showcaseCase.productTypes.length
      || !receipt.contentProductId
      || !receipt.deliveryId
      || !receipt.receiptId) {
      throw new Error(`Academy DEMO recovery found an invalid immutable ${showcaseCase.key} receipt`);
    }
    return {
      key: showcaseCase.key,
      productTypes: [...showcaseCase.productTypes],
      productIds: [receipt.contentProductId],
      target: { chatId: DEMO_CHAT_ID, threadId: showcaseCase.threadId },
      messageIds,
      deliveryId: receipt.deliveryId,
      feedbackReceiptId: receipt.receiptId,
    };
  });
}

module.exports = {
  CONTENT_TYPE,
  DEMO_CHAT_ID,
  DEMO_THREAD_ID,
  DEMO_SHOWCASE_CASES,
  assertDemoAcceptanceExecution,
  assertDemoAcceptancePreview,
  assertDemoShowcaseExecution,
  assertDemoShowcasePreview,
  assertDemoShowcaseRecoveryState,
  buildDemoAcceptanceTemporaryRule,
  buildDemoShowcaseTemporaryRule,
  messageIdsOf,
  selectDemoAcceptanceRule,
  targetMatches,
};
