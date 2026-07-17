import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  YubitReadonlyClient,
  createYubitSignature,
} from "../lib/yubit-readonly-client.mjs";

const API_KEY = "public-test-api-key";
const API_SECRET = "private-test-api-secret";
const NOW = 1_720_000_000_000;

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

test("creates the official sorted query signature", () => {
  const result = createYubitSignature({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    timestamp: NOW,
    recvWindow: 5000,
    method: "GET",
    path: "/oapi/contract/trade/private/v1/orders",
    params: { symbol: "BTCUSDT", limit: 20, orderId: "order_1234" },
  });
  const payload = "limit=20&orderId=order_1234&symbol=BTCUSDT";
  const expected = createHmac("sha256", API_SECRET)
    .update(`GET/oapi/contract/trade/private/v1/orders${NOW}${API_KEY}5000${payload}`)
    .digest("hex");

  assert.equal(result.payload, payload);
  assert.equal(result.signature, expected);
});

test("order history uses a signed GET request and official headers", async () => {
  const calls = [];
  const client = new YubitReadonlyClient({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    now: () => NOW,
    fetchImpl: async (...args) => {
      calls.push(args);
      return jsonResponse({ code: 0, data: { list: [{ orderId: "order_1234" }] } });
    },
  });

  const result = await client.getOrderHistory({ symbol: "btcusdt", orderId: "order_1234", limit: 20 });
  assert.deepEqual(result, { list: [{ orderId: "order_1234" }] });
  assert.equal(
    calls[0][0],
    "https://openapi.yubit.com/oapi/contract/trade/private/v1/orders?limit=20&orderId=order_1234&symbol=BTCUSDT",
  );
  assert.equal(calls[0][1].method, "GET");
  assert.equal(calls[0][1].headers["MF-ACCESS-API-KEY"], API_KEY);
  assert.equal(calls[0][1].headers["MF-ACCESS-TIMESTAMP"], String(NOW));
  assert.equal(calls[0][1].headers["MF-ACCESS-RECV-WINDOW"], "5000");
  assert.equal(calls[0][1].headers["MF-ACCESS-SIGN-VERSION"], "2");
  assert.match(calls[0][1].headers["MF-ACCESS-SIGN"], /^[a-f0-9]{64}$/);
  assert.equal("body" in calls[0][1], false);
});

test("the client exposes only the three approved read-only operations", () => {
  assert.deepEqual(
    Object.getOwnPropertyNames(YubitReadonlyClient.prototype).sort(),
    ["constructor", "getClosedPnl", "getExecutions", "getOrderHistory"],
  );
});

test("executions and closed PNL call the approved endpoints with bounded parameters", async () => {
  const urls = [];
  const client = new YubitReadonlyClient({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    now: () => NOW,
    fetchImpl: async (url) => {
      urls.push(url);
      return jsonResponse({ code: 0, data: { list: [] } });
    },
  });

  await client.getExecutions({ symbol: "ETHUSDT", orderId: "order-5678", limit: 10 });
  await client.getClosedPnl({ symbol: "ETHUSDT", startTime: NOW - 10_000, endTime: NOW, limit: 50 });

  assert.match(urls[0], /\/oapi\/contract\/trade\/private\/v1\/executions\?/);
  assert.match(urls[0], /orderId=order-5678/);
  assert.equal(
    urls[1],
    `https://openapi.yubit.com/oapi/contract/trade/private/v1/closed-pnl?endTime=${NOW}&limit=50&startTime=${NOW - 10_000}&symbol=ETHUSDT`,
  );
});

test("validation prevents malformed identifiers and unsafe limits before networking", async () => {
  const client = new YubitReadonlyClient({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    fetchImpl: async () => assert.fail("fetch must not run"),
  });

  await assert.rejects(() => client.getOrderHistory({ symbol: "BTC/USDT", orderId: "1234" }), /YUBIT_INVALID_SYMBOL/);
  await assert.rejects(() => client.getExecutions({ symbol: "BTCUSDT", orderId: "bad.id" }), /YUBIT_INVALID_ORDER_ID/);
  await assert.rejects(() => client.getClosedPnl({ symbol: "BTCUSDT", limit: 101 }), /YUBIT_INVALID_LIMIT/);
});

test("transport and API failures use secret-safe error codes", async (t) => {
  const cases = [
    {
      name: "HTTP failure",
      fetchImpl: async () => jsonResponse({}, { ok: false, status: 503 }),
      expected: /YUBIT_HTTP_ERROR:503/,
    },
    {
      name: "non-zero API code",
      fetchImpl: async () => jsonResponse({ code: 10001, message: `bad ${API_SECRET}` }),
      expected: /YUBIT_API_ERROR:10001/,
    },
    {
      name: "malformed JSON",
      fetchImpl: async () => ({ ok: true, status: 200, async text() { return "not-json"; } }),
      expected: /YUBIT_INVALID_RESPONSE/,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const client = new YubitReadonlyClient({ apiKey: API_KEY, apiSecret: API_SECRET, fetchImpl: item.fetchImpl });
      await assert.rejects(
        () => client.getOrderHistory({ symbol: "BTCUSDT", orderId: "1234" }),
        (error) => item.expected.test(error.message) && !error.message.includes(API_KEY) && !error.message.includes(API_SECRET),
      );
    });
  }
});

test("requests abort after the configured timeout", async () => {
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const client = new YubitReadonlyClient({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    fetchImpl,
    timeoutMs: 5,
  });

  await assert.rejects(
    () => client.getOrderHistory({ symbol: "BTCUSDT", orderId: "1234" }),
    /YUBIT_TIMEOUT/,
  );
});
