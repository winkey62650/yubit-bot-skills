import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  DEMO_SHOWCASE_CASES,
  assertDemoAcceptanceExecution,
  assertDemoAcceptancePreview,
  assertDemoShowcaseExecution,
  assertDemoShowcasePreview,
  assertDemoShowcaseRecoveryState,
  buildDemoAcceptanceTemporaryRule,
  buildDemoShowcaseTemporaryRule,
  selectDemoAcceptanceRule,
} = require("../lib/demo-content-acceptance.cjs");

const expectedTarget = {
  id: "demo-events",
  chatId: "-1003710405969",
  threadId: 8,
  groupName: "DEMO Academy",
  topicName: "3. Market Events",
};

function acceptanceRule(overrides = {}) {
  return {
    id: "crypto-daily-demo",
    kind: "automation",
    contentType: "crypto-daily",
    enabled: true,
    targets: [expectedTarget],
    ...overrides,
  };
}

test("DEMO acceptance selects exactly one recurring Crypto Daily rule with only Topic 8", () => {
  assert.equal(selectDemoAcceptanceRule([
    acceptanceRule({ enabled: false }),
    acceptanceRule({ id: "historical-preview", runOnce: true }),
  ]).id, "crypto-daily-demo");
  assert.throws(
    () => selectDemoAcceptanceRule([acceptanceRule(), acceptanceRule({ id: "duplicate" })]),
    (error) => {
      assert.match(error.message, /exactly one recurring crypto-daily rule/i);
      assert.match(error.message, /crypto-daily-demo/);
      assert.match(error.message, /duplicate/);
      assert.doesNotMatch(error.message, /token|password|secret/i);
      return true;
    },
  );
  assert.throws(
    () => selectDemoAcceptanceRule([acceptanceRule({ targets: [expectedTarget, { ...expectedTarget, threadId: 10 }] })]),
    /exactly one target/i,
  );
  assert.throws(
    () => selectDemoAcceptanceRule([acceptanceRule({ targets: [{ ...expectedTarget, threadId: 10 }] })]),
    /approved DEMO Topic 8/i,
  );
});

test("DEMO acceptance can provision one paused temporary rule for Topic 8", () => {
  const rule = buildDemoAcceptanceTemporaryRule();
  assert.equal(rule.id, "academy-demo-acceptance-temporary");
  assert.equal(rule.contentType, "crypto-daily");
  assert.equal(rule.schedulePreset, "daily-0800-utc");
  assert.equal(rule.enabled, false);
  assert.equal(rule.runOnce, false);
  assert.deepEqual(rule.targets, [expectedTarget]);
});

test("DEMO acceptance blocks non-publishable or source-unhealthy previews", () => {
  assert.deepEqual(assertDemoAcceptancePreview({
    publishable: true,
    sources: [{ name: "primary", status: "ok" }],
  }), { sourceCount: 1, healthySourceCount: 1 });
  assert.throws(
    () => assertDemoAcceptancePreview({ publishable: false, skipReason: "below threshold", sources: [{ status: "ok" }] }),
    /not publishable/i,
  );
  assert.throws(
    () => assertDemoAcceptancePreview({ publishable: true, sources: [{ status: "failed" }] }),
    /healthy source/i,
  );
});

test("DEMO acceptance requires one successful Topic 8 result and a matching durable receipt", () => {
  const execution = {
    status: "success",
    feedbackPersisted: true,
    feedbackPending: false,
    feedbackResults: [{
      deliveryId: "receipt-1",
      receiptId: "feedback-receipt-1",
      feedbackPersisted: true,
      feedbackPending: false,
      feedbackStatePersisted: true,
      feedbackError: null,
    }],
    run: {
      preview: {
        generatedAt: "2026-08-23T03:00:00.000Z",
        contentGovernance: {
          approved: true,
          products: [{ id: "product-1", status: "published", contentHash: "content-hash-1" }],
        },
        deliveryPlans: [{
          target: expectedTarget,
          contentPolicy: "obsidian-canonical",
          contentProductId: "product-1",
          contentHash: "content-hash-1",
          steps: [{ method: "sendMessage", payload: { text: "governed copy" } }],
        }],
        targetResults: [{ target: expectedTarget, status: "success", messageIds: [101, 102] }],
      },
    },
  };
  const receipts = [{
    id: "receipt-1",
    ruleId: "crypto-daily-demo",
    status: "success",
    target: expectedTarget,
    targetMessageIds: [101, 102],
    deliveredAt: "2026-08-23T03:00:01.000Z",
  }];

  assert.deepEqual(assertDemoAcceptanceExecution({
    ruleId: "crypto-daily-demo",
    execution,
    deliveries: receipts,
  }), {
    messageIds: [101, 102],
    deliveryId: "receipt-1",
    feedbackReceiptId: "feedback-receipt-1",
    productId: "product-1",
    contentHash: "content-hash-1",
    deliveredAt: "2026-08-23T03:00:01.000Z",
    generatedAt: "2026-08-23T03:00:00.000Z",
  });

  assert.throws(() => assertDemoAcceptanceExecution({
    ruleId: "crypto-daily-demo",
    execution: { ...execution, run: { preview: { targetResults: [{ target: { ...expectedTarget, threadId: 10 }, status: "success", messageIds: [101] }] } } },
    deliveries: receipts,
  }), /approved DEMO Topic 8/i);
  assert.throws(() => assertDemoAcceptanceExecution({
    ruleId: "crypto-daily-demo",
    execution,
    deliveries: [],
  }), /matching durable receipt/i);
  assert.throws(() => assertDemoAcceptanceExecution({
    ruleId: "crypto-daily-demo",
    execution: { ...execution, feedbackPersisted: false, feedbackPending: true },
    deliveries: receipts,
  }), /feedback closure/i);
});

test("four-product showcase is text-only, topic-scoped, and receipt-backed", () => {
  const showcaseCase = DEMO_SHOWCASE_CASES[0];
  const rule = buildDemoShowcaseTemporaryRule(showcaseCase);
  const target = rule.targets[0];
  const product = { id: "daily-market-brief-2026-08-23", product: "daily-market-brief", status: "distribution-ready", contentHash: "sha256:daily" };
  const plan = {
    target,
    contentPolicy: "obsidian-canonical",
    contentProductIds: [product.id],
    contentHashes: [product.contentHash],
    steps: [{ method: "sendMessage", payload: { text: "<b>YUBIT ACADEMY · DAILY MARKET BRIEF</b>" } }],
  };
  assert.deepEqual(assertDemoShowcasePreview({
    publishable: true,
    demoShowcase: true,
    textOnly: true,
    imageUrl: null,
    contentGovernance: { approved: true, products: [product] },
    deliveryPlans: [plan],
  }, showcaseCase), { productIds: [product.id], stepCount: 1 });

  const published = { ...product, status: "published" };
  const execution = {
    status: "success",
    feedbackPersisted: true,
    feedbackPending: false,
    feedbackResults: [{ deliveryId: "delivery-showcase", receiptId: "feedback-showcase", feedbackPersisted: true, feedbackStatePersisted: true }],
    run: { preview: {
      demoShowcase: true,
      textOnly: true,
      imageUrl: null,
      contentGovernance: { approved: true, products: [published] },
      deliveryPlans: [plan],
      targetResults: [{ target, status: "success", messageIds: [1401] }],
    } },
  };
  const receipt = { id: "delivery-showcase", ruleId: rule.id, status: "success", target, targetMessageIds: [1401] };
  assert.deepEqual(assertDemoShowcaseExecution({ ruleId: rule.id, execution, deliveries: [receipt], showcaseCase }).productTypes, ["daily-market-brief"]);
});

test("release-only recovery requires exactly one prior daily and weekly receipt and no release receipt", () => {
  const receipts = [
    {
      receiptId: "feedback-daily",
      deliveryId: "delivery-daily",
      contentProductId: "daily-market-brief-2026-08-23",
      ruleId: "academy-demo-showcase-daily-temporary",
      status: "success",
      endpoint: { chatId: "-1003710405969", threadId: 10 },
      messageIds: [1290],
    },
    {
      receiptId: "feedback-weekly",
      deliveryId: "delivery-weekly",
      contentProductId: "weekly-catalyst-calendar-2025-07-14",
      ruleId: "academy-demo-showcase-weekly-temporary",
      status: "success",
      endpoint: { chatId: "-1003710405969", threadId: 8 },
      messageIds: [1291],
    },
  ];

  assert.deepEqual(assertDemoShowcaseRecoveryState({ receipts, rules: [] }), [
    {
      key: "daily",
      productTypes: ["daily-market-brief"],
      productIds: ["daily-market-brief-2026-08-23"],
      target: { chatId: "-1003710405969", threadId: 10 },
      messageIds: [1290],
      deliveryId: "delivery-daily",
      feedbackReceiptId: "feedback-daily",
    },
    {
      key: "weekly",
      productTypes: ["weekly-catalyst-calendar"],
      productIds: ["weekly-catalyst-calendar-2025-07-14"],
      target: { chatId: "-1003710405969", threadId: 8 },
      messageIds: [1291],
      deliveryId: "delivery-weekly",
      feedbackReceiptId: "feedback-weekly",
    },
  ]);

  assert.throws(() => assertDemoShowcaseRecoveryState({ receipts: receipts.slice(1), rules: [] }), /exactly one immutable daily receipt/i);
  assert.throws(() => assertDemoShowcaseRecoveryState({ receipts: [...receipts, receipts[0]], rules: [] }), /exactly one immutable daily receipt/i);
  assert.throws(() => assertDemoShowcaseRecoveryState({
    receipts: [...receipts, { ...receipts[1], ruleId: "academy-demo-showcase-release-temporary" }],
    rules: [],
  }), /no prior release receipt/i);
  assert.throws(() => assertDemoShowcaseRecoveryState({
    receipts: [...receipts, { ...receipts[1], ruleId: "academy-demo-showcase-release-recovery-20260823-v2-temporary" }],
    rules: [],
  }), /no prior release receipt/i);
  assert.throws(() => assertDemoShowcaseRecoveryState({
    receipts,
    rules: [{ id: "academy-demo-showcase-release-temporary" }],
  }), /no temporary showcase rules/i);
  assert.throws(() => assertDemoShowcaseRecoveryState({
    receipts,
    rules: [{ id: "academy-demo-showcase-release-recovery-20260823-v2-temporary" }],
  }), /no temporary showcase rules/i);
});

test("release recovery can use a new approved rule identity without inheriting stale execution state", () => {
  const showcaseCase = DEMO_SHOWCASE_CASES.find((item) => item.key === "release");
  const rule = buildDemoShowcaseTemporaryRule(showcaseCase, {
    ruleId: "academy-demo-showcase-release-recovery-20260823-v2-temporary",
  });

  assert.equal(rule.id, "academy-demo-showcase-release-recovery-20260823-v2-temporary");
  assert.throws(() => buildDemoShowcaseTemporaryRule(showcaseCase, {
    ruleId: "academy-demo-showcase-daily-recovery-20260823-v2-temporary",
  }), /rule identity/i);
});

test("format validation can use a new approved rule identity without inheriting stale execution state", () => {
  const showcaseCase = DEMO_SHOWCASE_CASES.find((item) => item.key === "daily");
  const rule = buildDemoShowcaseTemporaryRule(showcaseCase, {
    ruleId: "academy-demo-showcase-daily-validation-20260824-v3-temporary",
  });

  assert.equal(rule.id, "academy-demo-showcase-daily-validation-20260824-v3-temporary");
  assert.throws(() => buildDemoShowcaseTemporaryRule(showcaseCase, {
    ruleId: "academy-demo-showcase-release-validation-20260824-v3-temporary",
  }), /rule identity/i);
});

test("v3 residual recovery identities are scoped to the missing content cases", () => {
  const weekly = DEMO_SHOWCASE_CASES.find((item) => item.key === "weekly");
  const release = DEMO_SHOWCASE_CASES.find((item) => item.key === "release");

  assert.equal(buildDemoShowcaseTemporaryRule(weekly, {
    ruleId: "academy-demo-showcase-weekly-recovery-20260824-v3-temporary",
  }).id, "academy-demo-showcase-weekly-recovery-20260824-v3-temporary");
  assert.equal(buildDemoShowcaseTemporaryRule(release, {
    ruleId: "academy-demo-showcase-release-recovery-20260824-v3-temporary",
  }).id, "academy-demo-showcase-release-recovery-20260824-v3-temporary");
});
