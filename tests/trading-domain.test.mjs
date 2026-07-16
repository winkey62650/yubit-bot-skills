import test from "node:test";
import assert from "node:assert/strict";

import {
  computeVerifiedRoi,
  deriveVerifiedOrder,
  formatPnlCaption,
  formatVerifiedSignal,
  matchClosedPnl,
  parseTraderMessage,
} from "../lib/trading-domain.mjs";

test("parses a Trader order submission and preserves optional annotations", () => {
  assert.deepEqual(
    parseTraderMessage(`btcusdt 1234567890
TP: 70100
SL: 66500
Rationale: Breakout retest confirmed`),
    {
      ok: true,
      type: "submit",
      symbol: "BTCUSDT",
      orderId: "1234567890",
      annotations: {
        takeProfit: "70100",
        stopLoss: "66500",
        rationale: "Breakout retest confirmed",
      },
    },
  );
});

test("parses status and refresh commands only with a valid symbol and order id", () => {
  assert.deepEqual(parseTraderMessage("/status ethusdt order_9876"), {
    ok: true,
    type: "status",
    symbol: "ETHUSDT",
    orderId: "order_9876",
    annotations: {},
  });
  assert.equal(parseTraderMessage("/refresh BTCUSDT").type, "help");
  assert.equal(parseTraderMessage("/status BTC/USDT 1234").type, "help");
  assert.equal(parseTraderMessage("BTCUSDT abc").type, "help");
  assert.match(parseTraderMessage("").help, /BTCUSDT/);
});

test("rejects symbols and order ids outside the public command contract", () => {
  assert.equal(parseTraderMessage("B 1234").ok, false);
  assert.equal(parseTraderMessage(`${"A".repeat(31)} 1234`).ok, false);
  assert.equal(parseTraderMessage("BTCUSDT bad.order").ok, false);
  assert.equal(parseTraderMessage(`BTCUSDT ${"x".repeat(129)}`).ok, false);
});

test("derives a verified filled order from executions using weighted average entry", () => {
  const verified = deriveVerifiedOrder(
    {
      orderId: "1234567890",
      symbol: "BTCUSDT",
      orderStatus: "Filled",
      side: "Buy",
      leverage: "5",
      createdTime: "1720000000000",
    },
    [
      { execId: "a", execQty: "0.1", execPrice: "60000", execTime: "1720000001000" },
      { execId: "b", execQty: "0.2", execPrice: "63000", execTime: "1720000002000" },
    ],
  );

  assert.equal(verified.symbol, "BTCUSDT");
  assert.equal(verified.orderId, "1234567890");
  assert.equal(verified.direction, "Long");
  assert.equal(verified.filledQty, 0.3);
  assert.equal(verified.entryPrice, 62000);
  assert.equal(verified.leverage, 5);
  assert.equal(verified.openedAt, 1720000001000);
  assert.deepEqual(verified.executionIds, ["a", "b"]);
});

test("verified order derivation fails closed for unverifiable inputs", () => {
  assert.throws(() => deriveVerifiedOrder(null, []), /ORDER_NOT_FOUND/);
  assert.throws(
    () => deriveVerifiedOrder({ orderStatus: "New", side: "Buy" }, [{ execQty: 1, execPrice: 2 }]),
    /ORDER_NOT_FILLED/,
  );
  assert.throws(
    () => deriveVerifiedOrder({ orderStatus: "Filled", side: "Buy" }, []),
    /EXECUTIONS_NOT_FOUND/,
  );
  assert.equal(
    deriveVerifiedOrder(
      { orderId: "abcd", symbol: "ETHUSDT", orderStatus: "Filled", side: "Sell", leverage: "NaN" },
      [{ execQty: "2", execPrice: "3200" }],
    ).leverage,
    null,
  );
});

test("closed PNL matching prefers one direct order-id match", () => {
  const signal = {
    orderId: "open-1234",
    direction: "Long",
    filledQty: 2,
    openedAt: 1_000,
  };
  const result = matchClosedPnl(signal, [
    { orderId: "other", qty: 2, side: "Sell", updatedTime: 2_000, closedPnl: 1 },
    { orderId: "open-1234", qty: 1, side: "Sell", updatedTime: 2_100, closedPnl: 4 },
  ]);

  assert.equal(result.status, "matched");
  assert.equal(result.method, "order_id");
  assert.equal(result.record.closedPnl, 4);
});

test("closed PNL matching uses a unique size, direction and time-window candidate", () => {
  const signal = {
    orderId: "open-1234",
    direction: "Long",
    filledQty: 2,
    openedAt: 10_000,
    matchUntil: 30_000,
  };
  const result = matchClosedPnl(signal, [
    { qty: 1, side: "Sell", updatedTime: 20_000, closedPnl: 2 },
    { qty: 2, side: "Buy", updatedTime: 20_000, closedPnl: 3 },
    { qty: 2, side: "Sell", updatedTime: 20_000, closedPnl: 6 },
  ]);

  assert.equal(result.status, "matched");
  assert.equal(result.method, "size_direction_time");
  assert.equal(result.record.closedPnl, 6);
  assert.equal(matchClosedPnl(signal, []).status, "pending");
  assert.equal(
    matchClosedPnl(signal, [
      { qty: 2, side: "Sell", updatedTime: 20_000 },
      { qty: 2, side: "Sell", updatedTime: 21_000 },
    ]).status,
    "ambiguous",
  );
});

test("computes ROI only from complete auditable verified inputs", () => {
  assert.equal(
    computeVerifiedRoi(
      { entryPrice: 100, filledQty: 2, leverage: 5 },
      { closedPnl: 20 },
    ),
    50,
  );
  assert.equal(computeVerifiedRoi({ entryPrice: 100, filledQty: 2, leverage: null }, { closedPnl: 20 }), null);
  assert.equal(computeVerifiedRoi({ entryPrice: 0, filledQty: 2, leverage: 5 }, { closedPnl: 20 }), null);
  assert.equal(computeVerifiedRoi({ entryPrice: 100, filledQty: 2, leverage: 5 }, {}), null);
});

test("formats verified facts separately from Trader annotations", () => {
  const signal = {
    symbol: "BTCUSDT",
    direction: "Long",
    leverage: 5,
    filledQty: 0.3,
    entryPrice: 62000,
    orderId: "1234567890",
    annotations: {
      takeProfit: "70100",
      stopLoss: "66500",
      rationale: "Breakout retest confirmed",
    },
    realizedPnl: 186,
    roi: 5,
  };
  const trader = { displayName: "Alice" };
  const signalCopy = formatVerifiedSignal(signal, trader);
  const pnlCopy = formatPnlCaption(signal, trader);

  assert.match(signalCopy, /Verified by YUBIT/);
  assert.match(signalCopy, /Trader notes \(not exchange-verified\)/);
  assert.match(signalCopy, /Alice/);
  assert.match(signalCopy, /Order ID: 1234\*\*\*\*7890/);
  assert.match(pnlCopy, /Realized PNL: \+186 USDT/);
  assert.match(pnlCopy, /ROI: \+5%/);
  assert.doesNotMatch(pnlCopy, /Rationale/);
});
