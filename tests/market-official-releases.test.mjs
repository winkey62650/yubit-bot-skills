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
const BEA_RELEASES_URL_FOR_TEST = "https://www.bea.gov/news/current-releases";
const BEA_PCE_INDEX = `
  <table><tr class="release-row">
    <td headers="view-title-table-column"><a href="/news/2026/personal-income-and-outlays-june-2026" hreflang="en">Personal Income and Outlays, June 2026</a></td>
  </tr></table>`;
const BEA_GDP_INDEX = `
  <table>
    <tr class="release-row"><td headers="view-title-table-column"><a href="/news/2026/gross-domestic-product-county-and-personal-income-county-2024">Gross Domestic Product by County and Personal Income by County, 2024</a></td></tr>
    <tr class="release-row"><td headers="view-title-table-column"><a href="/news/2026/gdp-advance-estimate-2nd-quarter-2026">GDP (Advance Estimate), 2nd Quarter 2026</a></td></tr>
  </table>`;
const FED_RELEASES_INDEX = '<a href="/newsevents/pressreleases/2026-press-fomc.htm">2026 FOMC</a>';
const FED_FOMC_INDEX = `
  <div class="eventlist__event"><p><a href="/newsevents/pressreleases/monetary20260729b.htm"><em>Federal Reserve Board and FOMC release economic projections</em></a></p></div>
  <div class="eventlist__event"><p><a href="/newsevents/pressreleases/monetary20260729a.htm"><em>Federal Reserve issues FOMC statement</em></a></p></div>`;

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

function beaGdpArticle({ path, heading, value = "2.4", date = "August 27, 2026", zone = "EDT" }) {
  return `
    <article about="${path}">
      <div class="field field--name-field-release-date field--type-string field--label-hidden field--item">EMBARGOED UNTIL RELEASE AT 8:30 a.m. ${zone}, Thursday, ${date}</div>
      <h1>${heading}</h1>
      <div class="release-body"><p>Real gross domestic product (GDP) increased at an annual rate of ${value} percent in the second quarter of 2026.</p></div>
    </article>`;
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
    indicator: "cpi-mom", rawValue: "0.1", normalizedValue: 0.1, unit: "%", releasePeriod: "July 2026",
    sourceUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
  });
  assertOfficialRecord(result.records[1], {
    indicator: "cpi", rawValue: "3.4", normalizedValue: 3.4, unit: "%", releasePeriod: "July 2026",
    sourceUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
  });
  assertOfficialRecord(result.records[2], {
    indicator: "core-cpi-mom", rawValue: "0.2", normalizedValue: 0.2, unit: "%", releasePeriod: "July 2026",
    sourceUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
  });
  assertOfficialRecord(result.records[3], {
    indicator: "core-cpi", rawValue: "2.5", normalizedValue: 2.5, unit: "%", releasePeriod: "July 2026",
    sourceUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
  });
});

test("normalizes legal BLS unchanged wording to zero for headline and core CPI", async () => {
  const cases = [
    ["bls-cpi-headline-unchanged-release.html", "cpi-mom"],
    ["bls-cpi-core-unchanged-release.html", "core-cpi-mom"],
  ];

  for (const [fixtureName, indicator] of cases) {
    const result = await fetchBlsOfficialRelease({
      indicator: "cpi",
      fetchImpl: offlineFetch(await fixture(fixtureName)),
      now: () => new Date(RETRIEVED_AT),
      timeoutMs: 100,
    });
    const record = result.records.find((item) => item.indicator === indicator);
    assert.equal(record.rawValue, "0");
    assert.equal(record.normalizedValue, 0);
  }
});

test("parses BLS payroll change and unemployment rate", async () => {
  const html = await fixture("bls-employment-release.html");
  const result = await fetchBlsOfficialRelease({
    indicator: "nonfarm-payrolls", fetchImpl: offlineFetch(html), now: () => new Date(RETRIEVED_AT), timeoutMs: 100,
  });

  assert.deepEqual(result.records.map(({ indicator }) => indicator), ["nonfarm-payrolls", "unemployment-rate"]);
  assertOfficialRecord(result.records[0], {
    indicator: "nonfarm-payrolls", rawValue: "-23", normalizedValue: -23_000, unit: "K", releasePeriod: "July 2026",
    sourceUrl: "https://www.bls.gov/news.release/empsit.nr0.htm",
  });
  assertOfficialRecord(result.records[1], {
    indicator: "unemployment-rate", rawValue: "4.1", normalizedValue: 4.1, unit: "%", releasePeriod: "July 2026",
    sourceUrl: "https://www.bls.gov/news.release/empsit.nr0.htm",
  });
});

test("parses BEA headline and core PCE month-over-month and year-over-year values without an API key", async () => {
  const calls = [];
  const result = await fetchBeaOfficialRelease({
    indicator: "pce",
    fetchImpl: offlineFetchSequence([
      BEA_PCE_INDEX,
      await fixture("bea-pce-release.html"),
    ], calls),
    now: () => new Date(RETRIEVED_AT), timeoutMs: 100,
  });

  assert.deepEqual(calls.map(({ url }) => url), [
    "https://www.bea.gov/news/current-releases",
    "https://www.bea.gov/news/2026/personal-income-and-outlays-june-2026",
  ]);
  assert.equal(calls.every(({ options }) => options.headers.authorization === undefined), true);
  assert.deepEqual(result.records.map(({ indicator }) => indicator), ["pce-mom", "pce", "core-pce-mom", "core-pce"]);
  assertOfficialRecord(result.records[0], {
    indicator: "pce-mom", rawValue: "-0.1", normalizedValue: -0.1, unit: "%", releasePeriod: "June 2026",
    sourceUrl: "https://www.bea.gov/news/2026/personal-income-and-outlays-june-2026",
  });
  assertOfficialRecord(result.records[3], {
    indicator: "core-pce", rawValue: "3.3", normalizedValue: 3.3, unit: "%", releasePeriod: "June 2026",
    sourceUrl: "https://www.bea.gov/news/2026/personal-income-and-outlays-june-2026",
  });
});

test("normalizes official BEA PCE unchanged wording to zero", async () => {
  const result = await fetchBeaOfficialRelease({
    indicator: "pce",
    fetchImpl: offlineFetchSequence([BEA_PCE_INDEX, await fixture("bea-pce-unchanged-release.html")]),
    now: () => new Date(RETRIEVED_AT),
    timeoutMs: 100,
  });

  assert.equal(result.records.find(({ indicator }) => indicator === "pce-mom").normalizedValue, 0);
  assert.equal(result.records.find(({ indicator }) => indicator === "core-pce-mom").normalizedValue, 0);
});

test("parses BEA headline real GDP annualized change", async () => {
  const calls = [];
  const result = await fetchBeaOfficialRelease({
    indicator: "gdp",
    fetchImpl: offlineFetchSequence([
      BEA_GDP_INDEX,
      await fixture("bea-gdp-release.html"),
    ], calls),
    now: () => new Date(RETRIEVED_AT), timeoutMs: 100,
  });

  assert.deepEqual(calls.map(({ url }) => url), [
    "https://www.bea.gov/news/current-releases",
    "https://www.bea.gov/news/2026/gdp-advance-estimate-2nd-quarter-2026",
  ]);
  assert.equal(result.records.length, 1);
  assertOfficialRecord(result.records[0], {
    indicator: "gdp", rawValue: "1.5", normalizedValue: 1.5, unit: "% annualized", releasePeriod: "Q2 2026",
    sourceUrl: "https://www.bea.gov/news/2026/gdp-advance-estimate-2nd-quarter-2026",
  });
});

test("normalizes official BEA GDP unchanged wording to zero", async () => {
  const result = await fetchBeaOfficialRelease({
    indicator: "gdp",
    fetchImpl: offlineFetchSequence([BEA_GDP_INDEX, await fixture("bea-gdp-unchanged-release.html")]),
    now: () => new Date(RETRIEVED_AT),
    timeoutMs: 100,
  });

  assert.equal(result.records[0].rawValue, "0");
  assert.equal(result.records[0].normalizedValue, 0);
});

test("selects and parses Advance, Second, and modern combined Third national GDP releases", async () => {
  const cases = [
    {
      path: "/news/2026/gdp-advance-estimate-2nd-quarter-2026",
      heading: "GDP (Advance Estimate), 2nd Quarter 2026",
      value: "1.5",
    },
    {
      path: "/news/2026/gdp-second-estimate-2nd-quarter-2026",
      heading: "GDP (Second Estimate), 2nd Quarter 2026",
      value: "2.1",
    },
    {
      path: "/news/2026/gdp-third-estimate-industries-corporate-profits-state-gdp-and-state-personal-income-2nd-quarter-2026",
      heading: "GDP (Third Estimate), Industries, Corporate Profits, State GDP, and State Personal Income, 2nd Quarter 2026",
      value: "2.4",
    },
  ];

  for (const item of cases) {
    const index = `
      <a href="/news/2026/gross-domestic-product-county-and-personal-income-county-2024">Gross Domestic Product by County and Personal Income by County, 2024</a>
      <a href="${item.path}">${item.heading}</a>`;
    const calls = [];
    const result = await fetchBeaOfficialRelease({
      indicator: "gdp",
      fetchImpl: offlineFetchSequence([index, beaGdpArticle(item)], calls),
      now: () => new Date(RETRIEVED_AT),
      timeoutMs: 100,
    });
    assert.deepEqual(calls.map(({ url }) => url), [BEA_RELEASES_URL_FOR_TEST, `https://www.bea.gov${item.path}`]);
    assert.equal(result.records[0].rawValue, item.value);
    assert.equal(result.records[0].releasePeriod, "Q2 2026");
  }
});

test("parses the FOMC target range and canonical statement and implementation-note URLs", async () => {
  const calls = [];
  const result = await fetchFomcOfficialRelease({
    fetchImpl: offlineFetchSequence([
      FED_RELEASES_INDEX,
      FED_FOMC_INDEX,
      await fixture("fomc-statement-release.html"),
    ], calls),
    now: () => new Date(RETRIEVED_AT), timeoutMs: 100,
  });

  assert.deepEqual(calls.map(({ url }) => url), [
    "https://www.federalreserve.gov/newsevents/pressreleases.htm",
    "https://www.federalreserve.gov/newsevents/pressreleases/2026-press-fomc.htm",
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
  assert.equal(record.value, "2.5%");
  assert.equal(record.source.type, "official");
});

test("fetchOfficialActual accepts only missing or explicit US country aliases", async () => {
  const html = await fixture("bls-cpi-release.html");
  for (const country of [undefined, "US", "USA", "United States", "U.S."]) {
    const event = { indicator: "cpi" };
    if (country !== undefined) event.country = country;
    const record = await fetchOfficialActual({
      event,
      fetchImpl: offlineFetch(html),
      now: () => new Date(RETRIEVED_AT),
      timeoutMs: 100,
    });
    assert.equal(record.indicator, "cpi");
  }
});

test("fetchOfficialActual rejects explicit non-US CPI, GDP, and PCE events before fetching", async () => {
  const calls = [];
  for (const indicator of ["cpi", "gdp", "pce"]) {
    await assert.rejects(
      fetchOfficialActual({
        event: { indicator, country: "Japan" },
        fetchImpl: offlineFetch("should not be fetched", calls),
        now: () => new Date(RETRIEVED_AT),
        timeoutMs: 100,
      }),
      (error) => error?.code === "OFFICIAL_RELEASE_UNSUPPORTED",
    );
  }
  assert.equal(calls.length, 0);
});

test("Eastern timestamps honor explicit zones and exact US DST transition dates", async () => {
  const base = await fixture("bls-cpi-release.html");
  const cases = [
    ["8:30 a.m. (ET) Saturday, March 7, 2026", "2026-03-07T13:30:00.000Z"],
    ["8:30 a.m. (ET) Sunday, March 8, 2026", "2026-03-08T12:30:00.000Z"],
    ["8:30 a.m. (ET) Saturday, October 31, 2026", "2026-10-31T12:30:00.000Z"],
    ["8:30 a.m. (ET) Sunday, November 1, 2026", "2026-11-01T13:30:00.000Z"],
    ["8:30 a.m. EST Sunday, March 8, 2026", "2026-03-08T13:30:00.000Z"],
    ["8:30 a.m. EDT Sunday, November 1, 2026", "2026-11-01T12:30:00.000Z"],
  ];

  for (const [stamp, expected] of cases) {
    const html = base.replace(/8:30 a\.m\. \(ET\) Wednesday, August 12, 2026/, stamp);
    const result = await fetchBlsOfficialRelease({
      indicator: "cpi",
      fetchImpl: offlineFetch(html),
      now: () => new Date(RETRIEVED_AT),
      timeoutMs: 100,
    });
    assert.equal(result.publishedAt, expected);
  }
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
  const calls = [];
  const cases = [
    () => fetchBlsOfficialRelease({ indicator: "cpi", fetchImpl: offlineFetch("<h1>Consumer Price Index - July 2026</h1><p>All items increased 2.7 percent.</p>"), now: () => new Date(RETRIEVED_AT), timeoutMs: 100 }),
    () => fetchBlsOfficialRelease({ indicator: "nonfarm-payrolls", fetchImpl: offlineFetch("<h1>The Employment Situation - July 2026</h1><p>Payrolls increased.</p>"), now: () => new Date(RETRIEVED_AT), timeoutMs: 100 }),
    () => fetchBeaOfficialRelease({ indicator: "pce", fetchImpl: offlineFetchSequence([BEA_PCE_INDEX, "<article><h1>Personal Income and Outlays, June 2026</h1><p>PCE changed.</p></article>"], calls), now: () => new Date(RETRIEVED_AT), timeoutMs: 100 }),
    () => fetchBeaOfficialRelease({ indicator: "gdp", fetchImpl: offlineFetchSequence([BEA_GDP_INDEX, "<article><h1>GDP (Advance Estimate), 2nd Quarter 2026</h1><p>GDP changed.</p></article>"], calls), now: () => new Date(RETRIEVED_AT), timeoutMs: 100 }),
    () => fetchFomcOfficialRelease({ fetchImpl: offlineFetchSequence([FED_RELEASES_INDEX, FED_FOMC_INDEX, "<div id=\"article\"><h3 class=\"title\">Federal Reserve issues FOMC statement</h3><p>The target range was maintained.</p></div>"], calls), now: () => new Date(RETRIEVED_AT), timeoutMs: 100 }),
  ];

  for (const action of cases) {
    await assert.rejects(action, (error) => error?.code === "OFFICIAL_RELEASE_SCHEMA_INVALID");
  }
  assert.equal(calls.length, 7, "BEA and FOMC malformed cases must reach their release parsers");
});

test("BEA GDP lookup rejects county and state releases when no national quarterly release exists", async () => {
  const countyOnly = '<a href="/news/2026/gross-domestic-product-county-and-personal-income-county-2024">Gross Domestic Product by County and Personal Income by County, 2024</a>';
  const calls = [];
  await assert.rejects(
    fetchBeaOfficialRelease({ indicator: "gdp", fetchImpl: offlineFetch(countyOnly, calls), now: () => new Date(RETRIEVED_AT), timeoutMs: 100 }),
    (error) => error?.code === "OFFICIAL_RELEASE_SCHEMA_INVALID",
  );
  assert.equal(calls.length, 1, "a county-only index must be rejected before any release request");
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
        return new Response(BEA_GDP_INDEX, { status: 200 });
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

test("final network, body-read, and timeout failures use OFFICIAL_RELEASE_FETCH_FAILED and preserve cause", async () => {
  const networkCause = new Error("network offline");
  await assert.rejects(
    fetchBlsOfficialRelease({
      indicator: "cpi",
      fetchImpl: async () => { throw networkCause; },
      now: () => new Date(RETRIEVED_AT),
      timeoutMs: 100,
      retry: { attempts: 1 },
    }),
    (error) => error?.code === "OFFICIAL_RELEASE_FETCH_FAILED" && error.cause === networkCause,
  );

  const bodyCause = new Error("body stream failed");
  await assert.rejects(
    fetchBlsOfficialRelease({
      indicator: "cpi",
      fetchImpl: async () => ({ ok: true, text: async () => { throw bodyCause; } }),
      now: () => new Date(RETRIEVED_AT),
      timeoutMs: 100,
      retry: { attempts: 1 },
    }),
    (error) => error?.code === "OFFICIAL_RELEASE_FETCH_FAILED" && error.cause === bodyCause,
  );

  await assert.rejects(
    fetchBlsOfficialRelease({
      indicator: "cpi",
      fetchImpl: async () => new Promise(() => {}),
      now: () => new Date(RETRIEVED_AT),
      timeoutMs: 5,
      retry: { attempts: 1 },
    }),
    (error) => error?.code === "OFFICIAL_RELEASE_FETCH_FAILED" && error.cause?.code === "OFFICIAL_RELEASE_TIMEOUT",
  );
});
