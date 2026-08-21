import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  fetchBeaOfficialRelease,
  fetchBlsOfficialRelease,
  fetchFomcOfficialRelease,
  fetchOfficialActual,
} from "../lib/market-official-releases.mjs";

const FIXTURE_DIR = new URL("./fixtures/market-content/", import.meta.url);
const RETRIEVED_AT = "2026-08-26T12:30:05.000Z";

async function fixture(name) {
  return readFile(new URL(name, FIXTURE_DIR), "utf8");
}

function offlineFetch(html, calls = []) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };
}

function offlineFetchSequence(responses, calls = []) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const response = responses.shift();
    assert.notEqual(response, undefined, `unexpected offline request for ${url}`);
    return response instanceof Response
      ? response
      : new Response(response, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };
}

function assertOfficialRecord(record, { indicator, rawValue, normalizedValue, unit, releasePeriod, sourceUrl }) {
  assert.equal(record.indicator, indicator);
  assert.equal(record.rawValue, rawValue);
  assert.deepEqual(record.normalizedValue, normalizedValue);
  assert.equal(record.value, `${rawValue}${unit === "%" || unit === "K" ? unit : ""}`);
  assert.equal(record.unit, unit);
  assert.equal(record.releasePeriod, releasePeriod);
  assert.equal(record.retrievedAt, RETRIEVED_AT);
  assert.equal(record.source.type, "official");
  assert.equal(record.source.authority, "official");
  assert.equal(record.source.url, sourceUrl);
  assert.equal(record.sourceUrl, sourceUrl);
  assert.match(record.publishedAt, /^2026-/);
}

test("parses BLS CPI headline and core month-over-month and year-over-year actuals", async () => {
  const html = await fixture("bls-cpi-release.html");
  const result = await fetchBlsOfficialRelease({
    indicator: "cpi",
    fetchImpl: offlineFetch(html),
    now: () => new Date(RETRIEVED_AT),
    timeoutMs: 100,
  });

  assert.equal(result.releasePeriod, "July 2026");
  assert.deepEqual(result.records.map(({ indicator }) => indicator), ["cpi-mom", "cpi", "core-cpi-mom", "core-cpi"]);
  assertOfficialRecord(result.records[0], {
    indicator: "cpi-mom", rawValue: "0.2", normalizedValue: 0.2, unit: "%", releasePeriod: "July 2026",
    sourceUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
  });
  assertOfficialRecord(result.records[1], {
    indicator: "cpi", rawValue: "2.7", normalizedValue: 2.7, unit: "%", releasePeriod: "July 2026",
    sourceUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
  });
  assertOfficialRecord(result.records[2], {
    indicator: "core-cpi-mom", rawValue: "0.3", normalizedValue: 0.3, unit: "%", releasePeriod: "July 2026",
    sourceUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
  });
  assertOfficialRecord(result.records[3], {
    indicator: "core-cpi", rawValue: "3.1", normalizedValue: 3.1, unit: "%", releasePeriod: "July 2026",
    sourceUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
  });
});

test("parses BLS payroll change and unemployment rate", async () => {
  const html = await fixture("bls-employment-release.html");
  const result = await fetchBlsOfficialRelease({
    indicator: "nonfarm-payrolls", fetchImpl: offlineFetch(html), now: () => new Date(RETRIEVED_AT), timeoutMs: 100,
  });

  assert.deepEqual(result.records.map(({ indicator }) => indicator), ["nonfarm-payrolls", "unemployment-rate"]);
  assertOfficialRecord(result.records[0], {
    indicator: "nonfarm-payrolls", rawValue: "73", normalizedValue: 73_000, unit: "K", releasePeriod: "July 2026",
    sourceUrl: "https://www.bls.gov/news.release/empsit.nr0.htm",
  });
  assertOfficialRecord(result.records[1], {
    indicator: "unemployment-rate", rawValue: "4.2", normalizedValue: 4.2, unit: "%", releasePeriod: "July 2026",
    sourceUrl: "https://www.bls.gov/news.release/empsit.nr0.htm",
  });
});

test("parses BEA headline and core PCE month-over-month and year-over-year values without an API key", async () => {
  const calls = [];
  const result = await fetchBeaOfficialRelease({
    indicator: "pce",
    fetchImpl: offlineFetchSequence([
      '<a href="/news/2026/personal-income-and-outlays-july-2026">Personal Income and Outlays, July 2026</a>',
      await fixture("bea-pce-release.html"),
    ], calls),
    now: () => new Date(RETRIEVED_AT), timeoutMs: 100,
  });

  assert.deepEqual(calls.map(({ url }) => url), [
    "https://www.bea.gov/news/current-releases",
    "https://www.bea.gov/news/2026/personal-income-and-outlays-july-2026",
  ]);
  assert.equal(calls.every(({ options }) => options.headers.authorization === undefined), true);
  assert.deepEqual(result.records.map(({ indicator }) => indicator), ["pce-mom", "pce", "core-pce-mom", "core-pce"]);
  assertOfficialRecord(result.records[0], {
    indicator: "pce-mom", rawValue: "0.2", normalizedValue: 0.2, unit: "%", releasePeriod: "July 2026",
    sourceUrl: "https://www.bea.gov/news/2026/personal-income-and-outlays-july-2026",
  });
  assertOfficialRecord(result.records[3], {
    indicator: "core-pce", rawValue: "2.9", normalizedValue: 2.9, unit: "%", releasePeriod: "July 2026",
    sourceUrl: "https://www.bea.gov/news/2026/personal-income-and-outlays-july-2026",
  });
});

test("parses BEA headline real GDP annualized change", async () => {
  const calls = [];
  const result = await fetchBeaOfficialRelease({
    indicator: "gdp",
    fetchImpl: offlineFetchSequence([
      '<a href="/news/2026/gross-domestic-product-second-quarter-2026-advance-estimate">Gross Domestic Product, Second Quarter 2026</a>',
      await fixture("bea-gdp-release.html"),
    ], calls),
    now: () => new Date(RETRIEVED_AT), timeoutMs: 100,
  });

  assert.deepEqual(calls.map(({ url }) => url), [
    "https://www.bea.gov/news/current-releases",
    "https://www.bea.gov/news/2026/gross-domestic-product-second-quarter-2026-advance-estimate",
  ]);
  assert.equal(result.records.length, 1);
  assertOfficialRecord(result.records[0], {
    indicator: "gdp", rawValue: "1.5", normalizedValue: 1.5, unit: "% annualized", releasePeriod: "Q2 2026",
    sourceUrl: "https://www.bea.gov/news/2026/gross-domestic-product-second-quarter-2026-advance-estimate",
  });
});

test("parses the FOMC target range and canonical statement and implementation-note URLs", async () => {
  const calls = [];
  const result = await fetchFomcOfficialRelease({
    fetchImpl: offlineFetchSequence([
      '<a href="/newsevents/pressreleases/monetary20260729a.htm">FOMC statement, July 29, 2026</a>',
      await fixture("fomc-statement-release.html"),
    ], calls),
    now: () => new Date(RETRIEVED_AT), timeoutMs: 100,
  });

  assert.deepEqual(calls.map(({ url }) => url), [
    "https://www.federalreserve.gov/newsevents/pressreleases/monetary.htm",
    "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm",
  ]);
  assert.equal(result.statementUrl, "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm");
  assert.equal(result.implementationNoteUrl, "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a1.htm");
  assertOfficialRecord(result.records[0], {
    indicator: "fomc-rate-decision", rawValue: "3.5-3.75", normalizedValue: { lower: 3.5, upper: 3.75 },
    unit: "% range", releasePeriod: "2026-07-29",
    sourceUrl: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm",
  });
});

test("fetchOfficialActual routes supported events and selects the requested release component", async () => {
  const record = await fetchOfficialActual({
    event: { indicator: "core-cpi", title: "US Core CPI YoY" },
    fetchImpl: offlineFetch(await fixture("bls-cpi-release.html")),
    now: () => new Date(RETRIEVED_AT), timeoutMs: 100,
  });

  assert.equal(record.indicator, "core-cpi");
  assert.equal(record.value, "3.1%");
  assert.equal(record.source.type, "official");
});

test("BLS API data is not requested or substituted during immediate release ingestion", async () => {
  const calls = [];
  await fetchBlsOfficialRelease({
    indicator: "cpi", fetchImpl: offlineFetch(await fixture("bls-cpi-release.html"), calls),
    now: () => new Date(RETRIEVED_AT), timeoutMs: 100,
  });

  assert.equal(calls.some(({ url }) => url.includes("api.bls.gov/publicAPI")), false);
});

test("changed official page shapes fail closed instead of returning partial guessed values", async () => {
  const cases = [
    () => fetchBlsOfficialRelease({ indicator: "cpi", fetchImpl: offlineFetch("<h1>Consumer Price Index - July 2026</h1><p>All items increased 2.7 percent.</p>"), now: () => new Date(RETRIEVED_AT), timeoutMs: 100 }),
    () => fetchBlsOfficialRelease({ indicator: "nonfarm-payrolls", fetchImpl: offlineFetch("<h1>The Employment Situation - July 2026</h1><p>Payrolls increased.</p>"), now: () => new Date(RETRIEVED_AT), timeoutMs: 100 }),
    () => fetchBeaOfficialRelease({ indicator: "pce", fetchImpl: offlineFetch("<h1>Personal Income and Outlays, July 2026</h1><p>PCE changed.</p>"), now: () => new Date(RETRIEVED_AT), timeoutMs: 100 }),
    () => fetchBeaOfficialRelease({ indicator: "gdp", fetchImpl: offlineFetch("<h1>Gross Domestic Product, Second Quarter 2026</h1><p>GDP changed.</p>"), now: () => new Date(RETRIEVED_AT), timeoutMs: 100 }),
    () => fetchFomcOfficialRelease({ fetchImpl: offlineFetch("<h3>Federal Reserve issues FOMC statement</h3><p>The target range was maintained.</p>"), now: () => new Date(RETRIEVED_AT), timeoutMs: 100 }),
  ];

  for (const action of cases) {
    await assert.rejects(action, (error) => error?.code === "OFFICIAL_RELEASE_SCHEMA_INVALID");
  }
});

test("fetch settings are injected: retries are bounded, offline, and abort signals are supplied", async () => {
  let attempts = 0;
  const signals = [];
  const result = await fetchBeaOfficialRelease({
    indicator: "gdp",
    fetchImpl: async (_url, options) => {
      attempts += 1;
      signals.push(options.signal);
      if (attempts < 2) return new Response("unavailable", { status: 503 });
      if (attempts === 2) {
        return new Response('<a href="/news/2026/gross-domestic-product-second-quarter-2026-advance-estimate">GDP release</a>', { status: 200 });
      }
      return new Response(await fixture("bea-gdp-release.html"), { status: 200 });
    },
    now: () => new Date(RETRIEVED_AT),
    timeoutMs: 100,
    retry: { attempts: 2, delayMs: 0 },
  });

  assert.equal(result.records[0].value, "1.5");
  assert.equal(attempts, 3);
  assert.equal(signals.every((signal) => signal instanceof AbortSignal), true);
});
