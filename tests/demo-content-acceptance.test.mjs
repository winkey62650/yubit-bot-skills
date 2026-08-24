import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  DEMO_SHOWCASE_CASES,
  assertDemoShowcasePosterUrls,
  assertDemoAcceptanceExecution,
  assertDemoAcceptancePreview,
  assertDemoShowcaseExecution,
  assertDemoShowcasePreview,
  assertDemoShowcaseRecoveryState,
  buildDemoAcceptanceTemporaryRule,
  buildDemoShowcaseTemporaryRule,
  selectDemoAcceptanceRule,
} = require("../lib/demo-content-acceptance.cjs");

const posterContracts = {
  "daily-market-brief": {
    id: "daily-market-brief-v4",
    file: "01-daily-market-brief-wide-v4.png",
    sha256: "8a378c4a4bcab99b92b005c383eae9fb483f8c6df36c1623f98d97f3b67c38ec",
  },
  "weekly-catalyst-calendar": {
    id: "weekly-catalysts-v4",
    file: "04-weekly-catalysts-wide-v4.png",
    sha256: "bed57b795a96890772c4b27a5c3880d1bf7f360e82921011bc5431c76073b2b4",
  },
  "data-flash": {
    id: "data-flash-v4",
    file: "02-data-flash-wide-v4.png",
    sha256: "85c3a05946f3f1b1b0071d85ad25e97c65c8acaa8198d97f6af09a8b6b6d1d57",
  },
  "market-follow-up": {
    id: "market-follow-up-v4",
    file: "03-market-follow-up-wide-v4.png",
    sha256: "1d78546f6a9d10837550ebe78a938fafe7cdb1f1c7b33def61661550a05dca6e",
  },
};

function posterUrl(product, overrides = {}) {
  const contract = posterContracts[product];
  const visualTemplate = {
    id: contract.id,
    product,
    file: contract.file,
    assetPath: `/templates/market-intelligence/${contract.file}`,
    sha256: contract.sha256,
    composition: "locked-master-fixed-field-overlay",
    version: 4,
    canvas: { width: 1200, height: 675 },
    ...overrides,
  };
  return `https://academy.example/api/media/card?kind=crypto-daily&data=${Buffer.from(JSON.stringify({ visualTemplate })).toString("base64url")}`;
}

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

test("four-product showcase pairs each poster with its text, remains topic-scoped, and is receipt-backed", () => {
  const showcaseCase = DEMO_SHOWCASE_CASES[0];
  const rule = buildDemoShowcaseTemporaryRule(showcaseCase);
  const target = rule.targets[0];
  const product = { id: "daily-market-brief-2026-08-23", product: "daily-market-brief", status: "distribution-ready", contentHash: "sha256:daily" };
  const plan = {
    target,
    contentPolicy: "obsidian-canonical",
    contentProductIds: [product.id],
    contentHashes: [product.contentHash],
    steps: [
      { method: "sendPhoto", payload: { photo: posterUrl("daily-market-brief") } },
      { method: "sendMessage", payload: { text: "<b>📊 MARKET BRIEF</b>\n\n<b>₿ BTC · NEUTRAL</b>" } },
    ],
  };
  assert.deepEqual(assertDemoShowcasePreview({
    publishable: true,
    demoShowcase: true,
    textOnly: false,
    imageUrl: posterUrl("daily-market-brief"),
    mediaDelivery: { byTemplateId: { "daily-market-brief-v4": posterUrl("daily-market-brief") } },
    contentGovernance: { approved: true, products: [product] },
    deliveryPlans: [plan],
  }, showcaseCase), {
    productIds: [product.id],
    stepCount: 2,
    visualTemplateIds: ["daily-market-brief-v4"],
    publisherNeutral: true,
    publicGenericHorizonIncluded: false,
    nativeAssetGlyphs: true,
    posterIdentities: assertDemoShowcasePosterUrls([posterUrl("daily-market-brief")], showcaseCase),
  });

  assert.throws(() => assertDemoShowcasePreview({
    publishable: true,
    demoShowcase: true,
    textOnly: false,
    imageUrl: posterUrl("daily-market-brief"),
    mediaDelivery: { byTemplateId: { "daily-market-brief-v4": posterUrl("daily-market-brief") } },
    contentGovernance: { approved: true, products: [product] },
    deliveryPlans: [{ ...plan, steps: [plan.steps[0], { method: "sendMessage", payload: { text: "<b>YUBIT ACADEMY · MARKET BRIEF</b>\n1–7D\n₿ BTC" } }] }],
  }, showcaseCase), /publisher-neutral/i);

  const published = { ...product, status: "published" };
  const execution = {
    status: "success",
    feedbackPersisted: true,
    feedbackPending: false,
    feedbackResults: [{ deliveryId: "delivery-showcase", receiptId: "feedback-showcase", feedbackPersisted: true, feedbackStatePersisted: true }],
    run: { preview: {
      demoShowcase: true,
      textOnly: false,
      imageUrl: posterUrl("daily-market-brief"),
      mediaDelivery: { byTemplateId: { "daily-market-brief-v4": posterUrl("daily-market-brief") } },
      contentGovernance: { approved: true, products: [published] },
      deliveryPlans: [plan],
      targetResults: [{ target, status: "success", messageIds: [1401, 1402] }],
    } },
  };
  const receipt = { id: "delivery-showcase", ruleId: rule.id, status: "success", target, targetMessageIds: [1401, 1402] };
  assert.deepEqual(assertDemoShowcaseExecution({ ruleId: rule.id, execution, deliveries: [receipt], showcaseCase }).productTypes, ["daily-market-brief"]);
});

test("poster gate locks every product to its distinct 1200x675 V4 master", () => {
  const release = DEMO_SHOWCASE_CASES.find((item) => item.key === "release");
  const urls = [posterUrl("data-flash"), posterUrl("market-follow-up")];
  assert.deepEqual(
    assertDemoShowcasePosterUrls(urls, release).map(({ product, templateId, canvas }) => ({ product, templateId, canvas })),
    [
      { product: "data-flash", templateId: "data-flash-v4", canvas: { width: 1200, height: 675 } },
      { product: "market-follow-up", templateId: "market-follow-up-v4", canvas: { width: 1200, height: 675 } },
    ],
  );
  assert.throws(() => assertDemoShowcasePosterUrls([urls[0], urls[0]], release), /duplicate poster URLs/i);
  assert.throws(() => assertDemoShowcasePosterUrls([
    posterUrl("data-flash"),
    posterUrl("market-follow-up", { id: "data-flash-v4" }),
  ], release), /non-canonical V4 master/i);
  assert.throws(() => assertDemoShowcasePosterUrls([
    posterUrl("data-flash"),
    posterUrl("market-follow-up", { canvas: { width: 1080, height: 1350 } }),
  ], release), /non-canonical V4 master/i);
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

test("v4 format validation can use a new approved rule identity without inheriting stale execution state", () => {
  const showcaseCase = DEMO_SHOWCASE_CASES.find((item) => item.key === "daily");
  const rule = buildDemoShowcaseTemporaryRule(showcaseCase, {
    ruleId: "academy-demo-showcase-daily-validation-20260824-v4-temporary",
  });

  assert.equal(rule.id, "academy-demo-showcase-daily-validation-20260824-v4-temporary");
  assert.throws(() => buildDemoShowcaseTemporaryRule(showcaseCase, {
    ruleId: "academy-demo-showcase-release-validation-20260824-v4-temporary",
  }), /rule identity/i);
});

test("versioned residual recovery identities are scoped to the missing content cases", () => {
  const weekly = DEMO_SHOWCASE_CASES.find((item) => item.key === "weekly");
  const release = DEMO_SHOWCASE_CASES.find((item) => item.key === "release");

  assert.equal(buildDemoShowcaseTemporaryRule(weekly, {
    ruleId: "academy-demo-showcase-weekly-recovery-20260824-v3-temporary",
  }).id, "academy-demo-showcase-weekly-recovery-20260824-v3-temporary");
  assert.equal(buildDemoShowcaseTemporaryRule(release, {
    ruleId: "academy-demo-showcase-release-recovery-20260824-v3-temporary",
  }).id, "academy-demo-showcase-release-recovery-20260824-v3-temporary");
});
