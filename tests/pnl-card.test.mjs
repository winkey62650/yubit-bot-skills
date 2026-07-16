import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPnlCardModel,
  signPnlCardPayload,
  verifyPnlCardPayload,
} from "../lib/pnl-card.mjs";

const SECRET = "pnl-card-signing-secret-with-enough-entropy";
const NOW = new Date("2026-07-16T08:00:00.000Z");

function payload(overrides = {}) {
  return {
    signalId: "signal-1",
    traderName: "Alice",
    symbol: "BTCUSDT",
    direction: "Long",
    leverage: 5,
    roi: 50,
    realizedPnl: 20,
    entryPrice: 100,
    exitPrice: 110,
    closedAt: "2026-07-16T07:59:00.000Z",
    ...overrides,
  };
}

test("PNL card tokens are signed, expire, and fail closed after tampering", () => {
  const token = signPnlCardPayload(payload(), SECRET, { now: NOW, ttlSeconds: 300 });
  const verified = verifyPnlCardPayload(token, SECRET, { now: new Date("2026-07-16T08:04:59.000Z") });
  assert.equal(verified.signalId, "signal-1");
  assert.equal(JSON.stringify(verified).includes(SECRET), false);

  const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => verifyPnlCardPayload(tampered, SECRET, { now: NOW }), /PNL_CARD_TOKEN_INVALID/);
  assert.throws(
    () => verifyPnlCardPayload(token, SECRET, { now: new Date("2026-07-16T08:05:01.000Z") }),
    /PNL_CARD_TOKEN_EXPIRED/,
  );
  assert.throws(() => signPnlCardPayload(payload(), "short", { now: NOW }), /PNL_CARD_SECRET_INVALID/);
});

test("PNL card tokens keep expiry metadata under server control", () => {
  const token = signPnlCardPayload(payload({
    v: 99,
    iat: 0,
    exp: 4_102_444_800,
  }), SECRET, { now: NOW, ttlSeconds: 60 });

  const verified = verifyPnlCardPayload(token, SECRET, {
    now: new Date("2026-07-16T08:00:30.000Z"),
  });
  assert.equal(verified.signalId, "signal-1");
  assert.equal("v" in verified, false);
  assert.equal("iat" in verified, false);
  assert.equal("exp" in verified, false);
  assert.throws(
    () => verifyPnlCardPayload(token, SECRET, { now: new Date("2026-07-16T08:01:01.000Z") }),
    /PNL_CARD_TOKEN_EXPIRED/,
  );
});

test("PNL card model allows only verified display fields and never fabricates ROI", () => {
  const model = buildPnlCardModel({
    ...payload({ roi: null }),
    apiSecret: "must-not-leak",
    credentialCiphertext: "must-not-leak-either",
    traderName: " Alice <script> ",
  });

  assert.equal(model.traderName, "Alice script");
  assert.equal(model.roi, null);
  assert.equal(model.roiLabel, null);
  assert.equal(model.pnlLabel, "+20.00 USDT");
  assert.equal(model.direction, "Long");
  assert.equal(JSON.stringify(model).includes("must-not-leak"), false);
  assert.deepEqual(Object.keys(model).sort(), [
    "closedAtLabel",
    "direction",
    "entryPriceLabel",
    "exitPriceLabel",
    "leverageLabel",
    "pnlLabel",
    "roi",
    "roiLabel",
    "symbol",
    "traderName",
  ].sort());
});

test("PNL card model rejects non-profit and malformed verified payloads", () => {
  assert.throws(() => buildPnlCardModel(payload({ realizedPnl: 0 })), /PNL_CARD_PROFIT_REQUIRED/);
  assert.throws(() => buildPnlCardModel(payload({ direction: "Sideways" })), /PNL_CARD_PAYLOAD_INVALID/);
  assert.throws(() => buildPnlCardModel(payload({ symbol: "BTC\/USDT" })), /PNL_CARD_PAYLOAD_INVALID/);
});
