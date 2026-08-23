import assert from "node:assert/strict";
import test from "node:test";
import { createContentFeedbackLoop } from "../lib/content-feedback-loop.mjs";
import {
  retryDistributionDeliveryFeedback,
  runDistributionAutomationRule,
} from "../lib/distribution-service.mjs";

function createRecordingStore({ feedbackFailures = 0, initializationFailures = 0 } = {}) {
  const distributions = new Map();
  const feedback = new Map();
  let remainingFeedbackFailures = feedbackFailures;
  let remainingInitializationFailures = initializationFailures;
  return {
    distributions,
    feedback,
    allowFeedbackWrites() {
      remainingFeedbackFailures = 0;
    },
    async initialize() {
      if (remainingInitializationFailures > 0) {
        remainingInitializationFailures -= 1;
        throw new Error("VAULT_TEMPORARILY_UNAVAILABLE");
      }
    },
    async writeDistribution(record) {
      const existing = distributions.get(record.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error(`immutable conflict: ${record.id}`);
      }
      distributions.set(record.id, structuredClone(record));
      return { id: record.id, unchanged: Boolean(existing) };
    },
    async writeFeedback(record) {
      if (remainingFeedbackFailures > 0) {
        remainingFeedbackFailures -= 1;
        throw new Error("FEEDBACK_STORE_UNAVAILABLE");
      }
      feedback.set(record.id, structuredClone(record));
      return { id: record.id, unchanged: false };
    },
  };
}

function telegramReceipt(overrides = {}) {
  return {
    deliveryId: "delivery-tg-1",
    eventId: "event-market-1",
    ruleId: "rule-daily-1",
    targetId: "telegram-daily",
    target: { chatId: "-100200", threadId: 8 },
    status: "success",
    attempt: 1,
    messageIds: [101],
    occurredAt: "2026-08-23T03:00:00.000Z",
    ...overrides,
  };
}

test("Telegram success writes one immutable snapshot and one aggregate feedback note", async () => {
  const store = createRecordingStore();
  const loop = createContentFeedbackLoop({
    store,
    now: () => new Date("2026-08-23T03:01:00.000Z"),
  });

  const result = await loop.recordReceipt(telegramReceipt());

  assert.equal(result.status, "synced");
  assert.equal(store.distributions.size, 1);
  assert.equal(store.feedback.size, 1);
  assert.equal(result.snapshot.platform, "telegram");
  assert.deepEqual(result.snapshot.messageIds, ["101"]);
  assert.equal(result.aggregate.status, "success");
  assert.equal(result.aggregate.receiptCount, 1);
  assert.equal(result.aggregate.successfulReceipts, 1);
});

test("a transient initialization failure is retried instead of being memoized forever", async () => {
  const store = createRecordingStore({ initializationFailures: 1 });
  const loop = createContentFeedbackLoop({ store });

  const pending = await loop.recordReceipt(telegramReceipt());
  assert.equal(pending.status, "pending");
  assert.equal(pending.phase, "distribution");
  assert.equal(pending.error, "VAULT_TEMPORARILY_UNAVAILABLE");

  const retried = await loop.recordReceipt(pending.receipt, { aggregate: pending.aggregate });
  assert.equal(retried.status, "synced");
  assert.equal(retried.aggregate.receiptCount, 1);
});

test("feedback records retain the governed content product identity and hash", async () => {
  const store = createRecordingStore();
  const loop = createContentFeedbackLoop({ store });
  const result = await loop.recordReceipt(telegramReceipt({
    contentProductId: "product-daily-market-brief-event-market-1",
    contentHash: "a".repeat(64),
  }));

  assert.equal(result.snapshot.contentProductId, "product-daily-market-brief-event-market-1");
  assert.equal(result.snapshot.contentHash, "a".repeat(64));
  assert.equal(result.aggregate.contentProductId, "product-daily-market-brief-event-market-1");
  assert.equal(result.aggregate.contentHash, "a".repeat(64));
});

test("Discord failure records the exact snowflake endpoint and retryable error outcome", async () => {
  const store = createRecordingStore();
  const loop = createContentFeedbackLoop({ store });

  const result = await loop.recordReceipt({
    deliveryId: "delivery-dc-1",
    eventId: "event-market-1",
    ruleId: "rule-daily-1",
    targetId: "discord-daily",
    target: {
      platform: "discord",
      guildId: "987654321098765432",
      channelId: "123456789012345678",
    },
    status: "failed",
    attempt: 1,
    messageIds: [],
    error: "DISCORD_RATE_LIMITED",
    occurredAt: "2026-08-23T03:00:00.000Z",
  });

  assert.equal(result.status, "synced");
  assert.equal(result.snapshot.platform, "discord");
  assert.deepEqual(result.snapshot.endpoint, {
    guildId: "987654321098765432",
    channelId: "123456789012345678",
  });
  assert.equal(result.aggregate.status, "failed");
  assert.equal(result.aggregate.failedReceipts, 1);
  assert.equal(result.aggregate.lastError, "DISCORD_RATE_LIMITED");
});

test("a failed delivery retry creates a new immutable snapshot and updates the same aggregate", async () => {
  const store = createRecordingStore();
  const loop = createContentFeedbackLoop({ store });
  const failed = await loop.recordReceipt(telegramReceipt({
    status: "failed",
    messageIds: [],
    error: "TELEGRAM_TIMEOUT",
  }));

  const succeeded = await loop.recordReceipt(telegramReceipt({
    attempt: 2,
    messageIds: [102],
    occurredAt: "2026-08-23T03:05:00.000Z",
  }), { aggregate: failed.aggregate });

  assert.notEqual(failed.snapshot.id, succeeded.snapshot.id);
  assert.equal(failed.aggregate.id, succeeded.aggregate.id);
  assert.equal(store.distributions.size, 2);
  assert.equal(store.feedback.size, 1);
  assert.equal(succeeded.aggregate.status, "success");
  assert.equal(succeeded.aggregate.receiptCount, 2);
  assert.equal(succeeded.aggregate.failedReceipts, 1);
  assert.equal(succeeded.aggregate.successfulReceipts, 1);
  assert.equal(succeeded.aggregate.attempts, 2);
});

test("a duplicate receipt reuses its immutable snapshot without double-counting feedback", async () => {
  const store = createRecordingStore();
  const loop = createContentFeedbackLoop({ store });
  const first = await loop.recordReceipt(telegramReceipt());
  const duplicate = await loop.recordReceipt(telegramReceipt(), { aggregate: first.aggregate });

  assert.equal(duplicate.snapshot.id, first.snapshot.id);
  assert.equal(store.distributions.size, 1);
  assert.equal(duplicate.distribution.unchanged, true);
  assert.equal(duplicate.aggregate.receiptCount, 1);
  assert.equal(duplicate.aggregate.successfulReceipts, 1);
});

test("partial multi-step receipts preserve both snapshots and converge the aggregate to complete", async () => {
  const store = createRecordingStore();
  const loop = createContentFeedbackLoop({ store });
  const partial = await loop.recordReceipt(telegramReceipt({
    status: "partial",
    messageIds: [201],
    steps: { completed: ["body"], total: 2 },
  }));
  const complete = await loop.recordReceipt(telegramReceipt({
    status: "success",
    messageIds: [201, 202],
    steps: { completed: ["body", "footer"], total: 2 },
    occurredAt: "2026-08-23T03:02:00.000Z",
  }), { aggregate: partial.aggregate });

  assert.equal(store.distributions.size, 2);
  assert.equal(partial.aggregate.status, "partial");
  assert.equal(complete.aggregate.status, "success");
  assert.equal(complete.aggregate.partialReceipts, 1);
  assert.equal(complete.aggregate.successfulReceipts, 1);
  assert.deepEqual(complete.aggregate.completedSteps, ["body", "footer"]);
  assert.equal(complete.aggregate.totalSteps, 2);
  assert.equal(complete.aggregate.complete, true);
});

test("feedback-note failure is visible and retrying the same receipt does not duplicate its snapshot", async () => {
  const store = createRecordingStore({ feedbackFailures: 1 });
  const loop = createContentFeedbackLoop({ store });
  const pending = await loop.recordReceipt(telegramReceipt());

  assert.equal(pending.status, "pending");
  assert.equal(pending.retryable, true);
  assert.equal(pending.phase, "feedback");
  assert.equal(pending.error, "FEEDBACK_STORE_UNAVAILABLE");
  assert.equal(store.distributions.size, 1);
  assert.equal(store.feedback.size, 0);

  const retried = await loop.recordReceipt(pending.receipt, { aggregate: pending.aggregate });

  assert.equal(retried.status, "synced");
  assert.equal(retried.snapshot.id, pending.snapshot.id);
  assert.equal(retried.aggregate.receiptCount, 1);
  assert.equal(store.distributions.size, 1);
  assert.equal(store.feedback.size, 1);
});

test("distribution integration keeps external success when feedback fails and exposes a retry", async () => {
  const target = { id: "telegram-feedback", chatId: "-100200", threadId: 8 };
  const rule = {
    id: "rule-feedback-integration",
    kind: "automation",
    contentType: "crypto-daily",
    targets: [target],
  };
  const deliveries = [];
  const repository = {
    async getRule(id) { return id === rule.id ? rule : null; },
    async listRules() { return []; },
    async createEvent(event) { return { id: "event-feedback-integration", ...event }; },
    async updateEvent() {},
    async createDelivery(delivery) {
      const saved = { id: "delivery-feedback-integration", payload: {}, ...structuredClone(delivery) };
      deliveries.push(saved);
      return structuredClone(saved);
    },
    async getDelivery(id) {
      return structuredClone(deliveries.find((delivery) => delivery.id === id) ?? null);
    },
    async updateDelivery(id, patch) {
      const delivery = deliveries.find((entry) => entry.id === id);
      Object.assign(delivery, structuredClone(patch));
      return structuredClone(delivery);
    },
    async saveMapping() {},
  };
  const store = createRecordingStore({ feedbackFailures: 1 });
  const feedbackLoop = createContentFeedbackLoop({ store });

  const result = await runDistributionAutomationRule(rule.id, {
    repository,
    feedbackLoop,
    now: new Date("2026-08-23T03:00:00.000Z"),
    runner: async () => ({
      status: "success",
      preview: { targetResults: [{ target, status: "success", messageId: 301 }] },
    }),
  });

  assert.equal(result.status, "success");
  assert.equal(result.feedbackPersisted, false);
  assert.equal(result.feedbackPending, true);
  assert.equal(deliveries[0].status, "success");
  assert.equal(deliveries[0].targetMessageId, 301);
  assert.equal(deliveries[0].payload.contentFeedback.status, "pending");
  assert.equal(deliveries[0].payload.contentFeedback.pendingReceipts.length, 1);

  store.allowFeedbackWrites();
  const retried = await retryDistributionDeliveryFeedback(deliveries[0].id, {
    repository,
    feedbackLoop,
  });

  assert.equal(retried.feedbackPersisted, true);
  assert.equal(retried.feedbackPending, false);
  assert.equal(retried.delivery.status, "success");
  assert.equal(deliveries[0].status, "success");
  assert.equal(deliveries[0].payload.contentFeedback.status, "synced");
  assert.deepEqual(deliveries[0].payload.contentFeedback.pendingReceipts, []);
  assert.equal(store.distributions.size, 1);
});
