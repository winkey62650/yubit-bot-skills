import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  assertDemoAcceptanceExecution,
  assertDemoAcceptancePreview,
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

test("DEMO acceptance selects exactly one enabled Crypto Daily rule with only Topic 8", () => {
  assert.equal(selectDemoAcceptanceRule([
    acceptanceRule(),
    acceptanceRule({ id: "historical-preview", runOnce: true }),
  ]).id, "crypto-daily-demo");
  assert.throws(
    () => selectDemoAcceptanceRule([acceptanceRule(), acceptanceRule({ id: "duplicate" })]),
    /exactly one enabled crypto-daily rule/i,
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
