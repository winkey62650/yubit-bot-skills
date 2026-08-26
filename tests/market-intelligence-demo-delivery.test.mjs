import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import {
  assertMarketIntelligenceDemoDelivery,
  marketIntelligenceDemoClaimKey,
} from "../lib/market-intelligence-demo-delivery.mjs";

const require = createRequire(import.meta.url);
const { signCtaPreviewPlans } = require("../lib/cta-preview-evidence.cjs");

const batchId = "market-intelligence-test-1001";
const challenge = randomBytes(32).toString("base64url");
const secret = randomBytes(32).toString("hex");
const cta = '<a href="https://example.com/community">Discuss with the community</a>';
const caption = [
  "DEMO PREVIEW · FORMAT VALIDATION",
  "Current live order-book snapshot",
  "LIQUIDITY ALERT",
  "FACT · BTC liquidity is asymmetric.",
  "INTERPRETATION · Treat the imbalance as context, not causation.",
  "WATCH NEXT · Monitor whether the wall persists.",
  "SOURCE · Binance Futures public order book",
  cta,
].join("\n\n");

function environment(overrides = {}) {
  return {
    TELEGRAM_DEMO_ONLY: "true",
    TRADING_DEMO_ONLY: "true",
    ALLOW_LIVE_TELEGRAM: "false",
    TELEGRAM_DISTRIBUTION_APPROVED_TARGETS: "-1003710405969:16",
    CTA_PREVIEW_EVIDENCE_SECRET: secret,
    ...overrides,
  };
}

function signedPlan() {
  const start = caption.lastIndexOf(cta);
  const [plan] = signCtaPreviewPlans([{
    templateVersion: "market-intelligence-alert-v1",
    target: {
      platform: "telegram",
      chatId: "-1003710405969",
      threadId: 16,
      ctaSource: "destination-registry",
      ctaEnabled: true,
      ctaContent: cta,
    },
    steps: [{
      method: "sendPhoto",
      payload: {
        chat_id: "-1003710405969",
        message_thread_id: 16,
        photo: `https://example.com/poster.png?demo=1&batch=${batchId}`,
        caption,
        parse_mode: "HTML",
      },
      ctaBoundary: {
        kind: "destination-cta",
        placement: "suffix",
        platform: "telegram",
        method: "sendPhoto",
        field: "caption",
        start,
        end: caption.length,
        stepIndex: 0,
        stepCount: 1,
      },
    }],
  }], { secret, challenge });
  return plan;
}

test("Market Intelligence Demo gate accepts only the signed exact topic, poster and batch", () => {
  const result = assertMarketIntelligenceDemoDelivery({
    plan: signedPlan(),
    previewChallenge: challenge,
    acceptanceBatchId: batchId,
    env: environment(),
  });
  assert.equal(result.batchId, batchId);
  assert.equal(result.payload.message_thread_id, 16);

  for (const mutate of [
    (plan) => { plan.target.threadId = 8; },
    (plan) => { plan.steps[0].payload.message_thread_id = 8; },
    (plan) => { plan.steps[0].payload.photo = "https://example.com/poster.png?demo=1&batch=another-batch"; },
    (plan) => { plan.steps[0].payload.caption += " forged"; },
  ]) {
    const plan = structuredClone(signedPlan());
    mutate(plan);
    assert.throws(() => assertMarketIntelligenceDemoDelivery({
      plan,
      previewChallenge: challenge,
      acceptanceBatchId: batchId,
      env: environment(),
    }));
  }
});

test("Market Intelligence Demo gate fails closed when production safety policy is relaxed", () => {
  for (const env of [
    environment({ TELEGRAM_DEMO_ONLY: "false" }),
    environment({ TRADING_DEMO_ONLY: "false" }),
    environment({ ALLOW_LIVE_TELEGRAM: "true" }),
    environment({ TELEGRAM_DISTRIBUTION_APPROVED_TARGETS: "-1003710405969:8" }),
  ]) {
    assert.throws(() => assertMarketIntelligenceDemoDelivery({
      plan: signedPlan(),
      previewChallenge: challenge,
      acceptanceBatchId: batchId,
      env,
    }));
  }
});

test("Market Intelligence Demo claim key is stable per batch and unique across batches", () => {
  assert.equal(marketIntelligenceDemoClaimKey(batchId), marketIntelligenceDemoClaimKey(batchId));
  assert.notEqual(marketIntelligenceDemoClaimKey(batchId), marketIntelligenceDemoClaimKey("market-intelligence-test-1002"));
});
