import test from "node:test";
import assert from "node:assert/strict";

import {
  ALERT_TYPES,
  buildMarketIntelligenceDemoPreview,
  buildLiquidityAlert,
  multiplyDecimal,
  normalizeWalletClassification,
  renderMarketIntelligenceAlertText,
  shouldPublishLiquidityUpdate,
} from "../lib/market-intelligence-alerts.mjs";

const verifiedSource = {
  provider: "Binance Futures",
  endpoint: "depth",
  sourceTimestamp: "2026-08-26T08:00:00.000Z",
  receivedAt: "2026-08-26T08:00:00.250Z",
};

test("financial multiplication stays exact for decimal market data", () => {
  assert.equal(multiplyDecimal("60000.10", "20.005", 2), "1200302.00");
  assert.equal(multiplyDecimal("0.12345678", "12345.6789", 8), "1524.15776391");
});

test("unverified wallet labels never become Smart Money", () => {
  assert.deepEqual(normalizeWalletClassification({ requestedLabel: "Smart Money", verified: false }), {
    label: "Tracked Wallet",
    verified: false,
  });
  assert.deepEqual(normalizeWalletClassification({ requestedLabel: "Smart Money", verified: true, evidence: "Nansen label" }), {
    label: "Smart Money",
    verified: true,
    evidence: "Nansen label",
  });
});

test("a persistent material wall becomes a scored liquidity alert without whale claims", () => {
  const alert = buildLiquidityAlert({
    asset: "BTC",
    pair: "BTC/USDT",
    observedAt: "2026-08-26T08:00:00.000Z",
    source: verifiedSource,
    markPrice: "60050",
    bids: [["60000", "200"], ["59900", "2"]],
    asks: [["60100", "3"], ["60500", "1"]],
    persistenceSeconds: 25,
    lifecycle: "APPEARED",
    priceReactionConfirmed: true,
  });

  assert.equal(alert.eventType, ALERT_TYPES.LIQUIDITY_ALERT);
  assert.equal(alert.wallet, null);
  assert.equal(alert.side, "BID");
  assert.equal(alert.visibleNotional, "12000000.00");
  assert.equal(alert.publishable, true);
  assert.ok(alert.score >= 80);
  assert.equal(alert.priority, "P1");
  assert.match(alert.interpretation, /visible liquidity/i);
  assert.doesNotMatch(JSON.stringify(alert), /whale|smart money|executed trade/i);
  assert.equal(alert.evidenceSnapshot.provider, "Binance Futures");
  assert.equal(alert.evidenceSnapshot.sourceTimestamp, "2026-08-26T08:00:00.000Z");
  assert.equal(alert.evidenceSnapshot.markPrice, "60050");
  assert.equal(alert.evidenceSnapshot.rows.length, 4);
  assert.equal(alert.evidenceSnapshot.rows.filter((row) => row.isFocus).length, 1);
  assert.deepEqual(alert.evidenceSnapshot.rows.find((row) => row.isFocus), {
    side: "BID",
    price: "60000",
    quantity: "200",
    visibleNotional: "12000000.00",
    visibleNotionalLabel: "$12M",
    isFocus: true,
  });
});

test("snapshot-only liquidity fails closed even when the visible order is large", () => {
  const alert = buildLiquidityAlert({
    asset: "BTC",
    pair: "BTC/USDT",
    observedAt: "2026-08-26T08:00:00.000Z",
    source: verifiedSource,
    markPrice: "60050",
    bids: [["60000", "200"], ["59900", "2"]],
    asks: [["60100", "3"], ["60500", "1"]],
    persistenceSeconds: 0,
    lifecycle: "APPEARED",
  });

  assert.equal(alert.publishable, false);
  assert.equal(alert.publicationGate.reason, "persistence-unverified");
});

test("alert copy separates fact, interpretation and watch next", () => {
  const alert = buildLiquidityAlert({
    asset: "BTC",
    pair: "BTC/USDT",
    observedAt: "2026-08-26T08:00:00.000Z",
    source: verifiedSource,
    markPrice: "60050",
    bids: [["60000", "200"], ["59900", "2"]],
    asks: [["60100", "3"], ["60500", "1"]],
    persistenceSeconds: 25,
    lifecycle: "APPEARED",
    priceReactionConfirmed: true,
  });
  const copy = renderMarketIntelligenceAlertText(alert, { html: false });

  assert.match(copy, /^🚨 LIQUIDITY ALERT/m);
  assert.match(copy, /FACT/);
  assert.match(copy, /INTERPRETATION/);
  assert.match(copy, /WATCH NEXT/);
  assert.match(copy, /Binance Futures · 2026-08-26 08:00:00 UTC/);
  assert.match(copy, /Visible orders can be changed, moved or cancelled/);
  assert.doesNotMatch(copy, /WHALE ALERT|SMART MONEY|Large bid added|will pump|guaranteed/i);
  assert.ok(copy.length <= 1024);
});

test("liquidity event dedupe allows only material updates inside sixty minutes", () => {
  const previous = {
    eventGroupKey: "LIQUIDITY_ALERT|BTC/USDT|BID|60000",
    visibleNotional: "1000000.00",
    priority: "P3",
    lifecycle: "APPEARED",
    publishedAt: "2026-08-26T08:00:00.000Z",
  };

  assert.equal(shouldPublishLiquidityUpdate(previous, {
    ...previous,
    visibleNotional: "1499999.99",
  }, new Date("2026-08-26T08:30:00.000Z")), false);
  assert.equal(shouldPublishLiquidityUpdate(previous, {
    ...previous,
    visibleNotional: "1500000.00",
  }, new Date("2026-08-26T08:30:00.000Z")), true);
  assert.equal(shouldPublishLiquidityUpdate(previous, {
    ...previous,
    priority: "P2",
  }, new Date("2026-08-26T08:30:00.000Z")), true);
  assert.equal(shouldPublishLiquidityUpdate(previous, {
    ...previous,
    lifecycle: "REMOVED",
  }, new Date("2026-08-26T08:30:00.000Z")), true);
  assert.equal(shouldPublishLiquidityUpdate(previous, previous, new Date("2026-08-26T09:00:00.000Z")), true);
});

test("Demo acceptance keeps current facts but labels an untriggered live gate", () => {
  const preview = buildMarketIntelligenceDemoPreview({
    imageUrl: "https://example.com/api/media/card?kind=whale",
    caption: "<b>🚨 LIQUIDITY ALERT</b>\n\n<b>FACT</b>\nCurrent visible depth.",
    currentData: true,
    historicalReplay: false,
    alert: {
      publicationGate: { passed: false, reason: "score-below-publication-threshold" },
    },
  }, { acceptanceBatchId: "market-intelligence-test-1" });

  const poster = new URL(preview.imageUrl);
  assert.equal(preview.demoAcceptance, true);
  assert.equal(preview.currentData, true);
  assert.equal(preview.historicalReplay, false);
  assert.equal(preview.acceptanceBatchId, "market-intelligence-test-1");
  assert.equal(poster.searchParams.get("demo"), "1");
  assert.equal(poster.searchParams.get("batch"), "market-intelligence-test-1");
  assert.match(preview.caption, /DEMO PREVIEW · FORMAT VALIDATION/);
  assert.match(preview.caption, /Current live order-book snapshot/);
  assert.match(preview.caption, /LIVE GATE: NOT TRIGGERED/);
  assert.match(preview.caption, /SCORE BELOW PUBLICATION THRESHOLD/);
});

test("Demo acceptance rejects an unsafe batch identity or poster URL", () => {
  const preview = {
    imageUrl: "https://example.com/api/media/card?kind=whale",
    caption: "<b>🚨 LIQUIDITY ALERT</b>",
    alert: { publicationGate: { passed: true } },
  };
  assert.throws(() => buildMarketIntelligenceDemoPreview(preview, { acceptanceBatchId: "bad" }), /batch/i);
  assert.throws(() => buildMarketIntelligenceDemoPreview({ ...preview, imageUrl: "http://example.com/poster.png" }, {
    acceptanceBatchId: "market-intelligence-test-2",
  }), /HTTPS/i);
});
