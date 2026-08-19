import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_SOURCE_TIMEOUT_MS,
  fetchCryptoDailyCandidates,
  fetchMarketReaction,
  fetchTradingViewCalendar,
  normalizeCalendarEvents,
  parseRssFeed,
} from "../lib/market-content-sources.mjs";

const fixtureDirectory = new URL("./fixtures/market-content/", import.meta.url);

async function jsonFixture(name) {
  return JSON.parse(await readFile(new URL(name, fixtureDirectory), "utf8"));
}

async function textFixture(name) {
  return readFile(new URL(name, fixtureDirectory), "utf8");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function settleWithin(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("exports the eight-second default source timeout", () => {
  assert.equal(DEFAULT_SOURCE_TIMEOUT_MS, 8_000);
});

test("normalizes TradingView fields and units without inventing missing values", async () => {
  const fixture = await jsonFixture("tradingview-calendar.json");
  const events = normalizeCalendarEvents(fixture.result);

  assert.deepEqual(events[0], {
    id: "us-cpi-yoy-2026-08",
    sourceId: "us-cpi-yoy-2026-08",
    title: "US CPI YoY",
    country: "US",
    importance: 3,
    scheduledAt: "2026-08-12T12:30:00.000Z",
    timeLabel: "2026-08-12T12:30:00.000Z",
    unit: "%",
    values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" },
    rawValues: { actual: "2.7", forecast: "2.8", previous: "2.9", unit: "%" },
  });
  assert.equal(events[1].scheduledAt, null);
  assert.equal(events[1].timeLabel, "TBD");
  assert.deepEqual(events[1].values, { actual: null, forecast: null, previous: null });
  assert.deepEqual(events[1].rawValues, { actual: null, forecast: "", previous: "TBD", unit: "%" });
});

test("keeps blank and absent importance missing", () => {
  const [event, withoutImportance] = normalizeCalendarEvents([
    { title: "Rate decision", importance: "   " },
    { title: "Unrated event" },
  ]);

  assert.equal(event.importance, null);
  assert.equal(withoutImportance.importance, null);
});

test("preserves numeric source ids while exposing a normalized string id", () => {
  const [event] = normalizeCalendarEvents([{ id: 42, title: "Rate decision" }]);

  assert.equal(event.id, "42");
  assert.equal(event.sourceId, 42);
});

test("parses RSS and Atom XML entities while retaining source labels and raw ids", async () => {
  const [industry, official] = await Promise.all([
    textFixture("industry-feed.xml"),
    textFixture("official-feed.xml"),
  ]);
  const industryItems = parseRssFeed(industry, { id: "industry", label: "Industry Wire", url: "https://industry.example/rss" });
  const officialItems = parseRssFeed(official, { id: "sec", label: "SEC", url: "https://www.sec.gov/rss" });

  assert.deepEqual(industryItems[0], {
    id: "industry:industry-42",
    sourceId: "industry-42",
    title: "Bitcoin & Ether gain after ETF update",
    url: "https://industry.example/news/etf-update?ref=rss&day=1",
    summary: "Funds report $250M of net inflows & higher volume.",
    publishedAt: "2026-08-18T08:00:00.000Z",
    categories: ["BTC ETF / Institutional"],
    source: { id: "industry", label: "Industry Wire", url: "https://industry.example/rss" },
  });
  assert.equal(officialItems[0].sourceId, "tag:sec.gov,2026:release-17");
  assert.equal(officialItems[0].source.label, "SEC");
  assert.equal(officialItems[0].url, "https://www.sec.gov/newsroom/press-releases/2026-17?utm_source=rss&mode=full");
  assert.equal(officialItems[0].summary, "Guidance covers advisers' safeguarding obligations.");
  assert.deepEqual(officialItems[0].categories, ["Regulation"]);
});

test("calendar fetch retries failed GET requests at most twice and returns source health", async () => {
  const fixture = await jsonFixture("tradingview-calendar.json");
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return calls.length < 3 ? jsonResponse({ error: "temporary" }, 503) : jsonResponse(fixture);
  };

  const result = await fetchTradingViewCalendar({
    from: "2026-08-17T00:00:00.000Z",
    to: "2026-08-24T00:00:00.000Z",
    fetchImpl,
    timeoutMs: 50,
  });

  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.options.method === "GET"));
  assert.match(calls[0].url, /from=2026-08-17T00%3A00%3A00\.000Z/);
  assert.equal(result.data.length, 2);
  assert.equal(result.events, result.data);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.sources[0].id, "tradingview-calendar");
  assert.equal(result.sources[0].status, "ok");
  assert.equal(result.sources[0].freshnessSeconds, 0);
  assert.match(result.sources[0].checkedAt, /^2026-|^20\d\d-/);
  assert.equal(result.sources[0].lastSuccessAt, result.sources[0].checkedAt);
});

test("calendar fetch stops after three total attempts", async () => {
  let calls = 0;
  const result = await fetchTradingViewCalendar({
    fetchImpl: async () => {
      calls += 1;
      throw new Error("offline");
    },
    timeoutMs: 20,
  });

  assert.equal(calls, 3);
  assert.deepEqual(result.data, []);
  assert.equal(result.sources[0].status, "error");
  assert.match(result.warnings[0], /TradingView|offline/i);
});

test("source timeout is controlled by timeoutMs and does not wait for the injected fetch", async () => {
  let attempts = 0;
  const startedAt = Date.now();
  const result = await fetchTradingViewCalendar({
    fetchImpl: () => {
      attempts += 1;
      return new Promise(() => {});
    },
    timeoutMs: 5,
  });

  assert.equal(attempts, 3);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(result.sources[0].status, "timeout");
  assert.match(result.warnings[0], /timeout/i);
});

test("source timeout covers JSON and text response bodies through the retry limit", async () => {
  let jsonAttempts = 0;
  const calendar = await settleWithin(
    fetchTradingViewCalendar({
      fetchImpl: async () => {
        jsonAttempts += 1;
        return { ok: true, status: 200, json: () => new Promise(() => {}) };
      },
      timeoutMs: 5,
    }),
    300,
    "calendar body timeout did not settle",
  );

  let textAttempts = 0;
  const daily = await settleWithin(
    fetchCryptoDailyCandidates({
      now: new Date("2026-08-19T08:00:00.000Z"),
      feeds: [{ id: "industry", label: "Industry Wire", url: "https://industry.example/rss" }],
      fetchImpl: async () => {
        textAttempts += 1;
        return { ok: true, status: 200, text: () => new Promise(() => {}) };
      },
      timeoutMs: 5,
    }),
    300,
    "RSS body timeout did not settle",
  );

  assert.equal(jsonAttempts, 3);
  assert.equal(calendar.sources[0].status, "timeout");
  assert.equal(textAttempts, 3);
  assert.equal(daily.sources[0].status, "timeout");
});

test("daily candidates fetch configured official and industry RSS without network access", async () => {
  const [industry, official] = await Promise.all([
    textFixture("industry-feed.xml"),
    textFixture("official-feed.xml"),
  ]);
  const feeds = [
    { id: "industry", label: "Industry Wire", url: "https://industry.example/rss" },
    { id: "sec", label: "SEC", url: "https://www.sec.gov/rss" },
  ];
  const fetchImpl = async (url) => new Response(String(url).includes("sec.gov") ? official : industry, { status: 200 });
  const result = await fetchCryptoDailyCandidates({
    now: new Date("2026-08-19T08:00:00.000Z"),
    feeds,
    fetchImpl,
    timeoutMs: 50,
  });

  assert.equal(result.data.length, 2);
  assert.equal(result.candidates, result.data);
  assert.deepEqual(result.data.map((item) => item.source.label), ["Industry Wire", "SEC"]);
  assert.deepEqual(result.sources.map((source) => source.status), ["ok", "ok"]);
  assert.deepEqual(result.warnings, []);
});

test("market reaction falls back from Binance to OKX and treats DXY as optional", async () => {
  const okx = await jsonFixture("okx-tickers.json");
  let binanceCalls = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname.includes("binance")) {
      binanceCalls += 1;
      return jsonResponse({ code: -1000 }, 503);
    }
    if (parsed.hostname.includes("okx")) {
      const asset = parsed.searchParams.get("instId").split("-")[0];
      return jsonResponse(parsed.pathname.includes("candles") ? okx[asset].before : okx[asset].latest);
    }
    if (parsed.hostname.includes("query1.finance.yahoo.com")) return jsonResponse({ chart: { result: null, error: { description: "Not Found" } } }, 404);
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await fetchMarketReaction({
    beforeAt: new Date("2026-08-18T12:00:00.000Z"),
    now: new Date("2026-08-18T12:15:00.000Z"),
    fetchImpl,
    symbols: ["BTC", "ETH", "DXY"],
  });

  assert.equal(binanceCalls, 6);
  assert.equal(result.data.BTC.source, "OKX");
  assert.equal(result.data.BTC.beforePrice, 65000);
  assert.equal(result.data.BTC.price, 65650);
  assert.equal(result.data.BTC.changePercent, 1);
  assert.equal(result.data.ETH.changePercent, -1);
  assert.equal(result.prices, result.data);
  assert.equal(result.data.DXY, undefined);
  assert.ok(result.sources.some((source) => source.id === "binance" && source.status === "error"));
  assert.ok(result.sources.some((source) => source.id === "okx" && source.status === "ok" && source.fallbackFrom === "binance"));
  assert.match(result.warnings.join("\n"), /DXY/);
});

test("market reaction uses Binance when primary prices are available", async () => {
  const binance = await jsonFixture("binance-tickers.json");
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    assert.ok(parsed.hostname.includes("binance"));
    const asset = parsed.searchParams.get("symbol").replace("USDT", "");
    return jsonResponse(parsed.pathname.includes("klines") ? binance[asset].before : binance[asset].latest);
  };

  const result = await fetchMarketReaction({
    beforeAt: "2026-08-18T12:00:00.000Z",
    now: "2026-08-18T12:15:00.000Z",
    fetchImpl,
    symbols: ["BTC", "ETH"],
  });

  assert.equal(result.data.BTC.source, "Binance");
  assert.equal(result.data.ETH.source, "Binance");
  assert.deepEqual(result.warnings, []);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].status, "ok");
});
