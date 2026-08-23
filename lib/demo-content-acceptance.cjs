const DEMO_CHAT_ID = "-1003710405969";
const DEMO_THREAD_ID = 8;
const CONTENT_TYPE = "crypto-daily";

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

module.exports = {
  CONTENT_TYPE,
  DEMO_CHAT_ID,
  DEMO_THREAD_ID,
  assertDemoAcceptanceExecution,
  assertDemoAcceptancePreview,
  buildDemoAcceptanceTemporaryRule,
  messageIdsOf,
  selectDemoAcceptanceRule,
  targetMatches,
};
