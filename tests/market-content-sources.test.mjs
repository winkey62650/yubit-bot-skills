import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_SOURCE_TIMEOUT_MS,
  fetchCryptoDailyCandidates,
  fetchFederalReserveCalendar,
  fetchMarketCalendar,
  fetchMarketReaction,
  fetchNasdaqCalendar,
  fetchTradingViewCalendar,
  normalizeCalendarEvents,
  parseFederalReserveCalendar,
  parseRssFeed,
} from "../lib/market-content-sources.mjs";
import {
  buildWeeklyCalendarDocument,
  renderTelegramMarketDocument,
} from "../lib/market-content-templates.mjs";

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

const EMPTY_FED_CALENDAR = `
  <html><body><main><div class="panel-heading"><h4><a id="2026">2026 FOMC Meetings</a></h4></div></main></body></html>
`;
const EMPTY_BEA_SCHEDULE = `
  <html><body><main><table id="release-schedule-table"><thead><tr><th>Year 2026</th><th>Release</th></tr></thead><tbody></tbody></table></main></body></html>
`;

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

test("Nasdaq economic-events adapter preserves benchmarks and a traceable source", async () => {
  const result = await fetchNasdaqCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-21T00:00:00.000Z",
    now: "2026-08-20T10:00:00.000Z",
    fetchImpl: async () => jsonResponse({ data: { rows: [{
      gmt: "08:30",
      country: "United States",
      eventName: "Initial Jobless Claims",
      actual: "225K",
      consensus: "230K",
      previous: "228K",
    }] } }),
  });

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].scheduledAt, "2026-08-20T08:30:00.000Z");
  assert.deepEqual(result.events[0].values, { actual: "225K", forecast: "230K", previous: "228K" });
  assert.equal(result.events[0].source.label, "Nasdaq Economic Calendar");
  assert.match(result.events[0].source.url, /nasdaq\.com\/api\/calendar/);
});

test("Nasdaq economic-events adapter drops HTML and non-breaking-space placeholders", async () => {
  const result = await fetchNasdaqCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-21T00:00:00.000Z",
    now: "2026-08-20T10:00:00.000Z",
    fetchImpl: async () => jsonResponse({ data: { rows: [{
      gmt: "14:00",
      country: "United States",
      eventName: "FOMC Meeting Minutes",
      actual: "&nbsp;",
      consensus: "\u00a0",
      previous: "—",
    }] } }),
  });

  assert.deepEqual(result.events[0].values, { actual: null, forecast: null, previous: null });
});

test("Federal Reserve calendar parser includes upcoming meetings before a statement exists", async () => {
  const html = await textFixture("federal-reserve-fomc-calendar.html");
  const events = parseFederalReserveCalendar(html);

  assert.deepEqual(events.map(({ title, importance, scheduledAt }) => ({ title, importance, scheduledAt })), [{
    title: "FOMC Rate Decision & Statement",
    importance: 3,
    scheduledAt: "2026-07-29T18:00:00.000Z",
  }, {
    title: "FOMC Rate Decision & Statement",
    importance: 3,
    scheduledAt: "2026-09-16T18:00:00.000Z",
  }]);
  assert.match(events[0].source.url, /monetary20260729a1\.pdf$/);
  assert.equal(events[1].source.url, "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm");
});

test("Federal Reserve adapter returns an upcoming meeting from the official schedule", async () => {
  const html = await textFixture("federal-reserve-fomc-calendar.html");
  const result = await fetchFederalReserveCalendar({
    from: "2026-09-01T00:00:00.000Z",
    to: "2026-10-01T00:00:00.000Z",
    now: "2026-08-21T00:00:00.000Z",
    fetchImpl: async () => new Response(html),
  });

  assert.deepEqual(result.events.map((event) => event.scheduledAt), ["2026-09-16T18:00:00.000Z"]);
  assert.equal(result.sources[0].status, "ok");
});

test("Federal Reserve accepts live meeting variants without counting minutes release dates", async () => {
  const html = await textFixture("federal-reserve-fomc-calendar-live-variants.html");
  const result = await fetchFederalReserveCalendar({
    from: "2018-01-01T00:00:00.000Z",
    to: "2027-01-01T00:00:00.000Z",
    now: "2026-08-21T00:00:00.000Z",
    fetchImpl: async () => new Response(html),
  });

  assert.equal(result.sources[0].status, "ok");
  assert.deepEqual(result.events.map((event) => event.scheduledAt), [
    "2018-11-01T18:00:00.000Z",
    "2023-02-01T19:00:00.000Z",
    "2024-05-01T18:00:00.000Z",
    "2025-08-22T18:00:00.000Z",
    "2026-04-29T18:00:00.000Z",
  ]);
});

test("BEA schedule parser reads the live table shape and converts Eastern release times across DST", async () => {
  const html = await textFixture("bea-release-schedule.html");
  const fetchRange = (from, to) => fetchMarketCalendar({
    from,
    to,
    now: "2026-08-21T00:00:00.000Z",
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("tradingview")) return jsonResponse({ result: [] });
      if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [] } });
      if (target.includes("federalreserve.gov")) return new Response(EMPTY_FED_CALENDAR);
      if (target.includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
      if (target.includes("bea.gov")) return new Response(html);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const summer = await fetchRange("2026-08-26T00:00:00.000Z", "2026-08-27T00:00:00.000Z");
  const winter = await fetchRange("2026-12-23T00:00:00.000Z", "2026-12-24T00:00:00.000Z");

  assert.deepEqual(
    summer.events.map((event) => [event.title, event.scheduledAt]),
    [
      ["US GDP", "2026-08-26T12:30:00.000Z"],
      ["US PCE", "2026-08-26T12:30:00.000Z"],
      ["US Core PCE", "2026-08-26T12:30:00.000Z"],
    ],
  );
  assert.deepEqual(
    winter.events.map((event) => [event.title, event.scheduledAt]),
    [
      ["US PCE", "2026-12-23T13:30:00.000Z"],
      ["US Core PCE", "2026-12-23T13:30:00.000Z"],
    ],
  );
  assert.equal(summer.sources.find((source) => source.id === "bea-release-schedule").status, "ok");
});

test("BEA accepts a titled News row whose schedule cell is To Be Announced", async () => {
  const html = await textFixture("bea-release-schedule-live-tba.html");
  const result = await fetchMarketCalendar({
    from: "2026-08-26T00:00:00.000Z",
    to: "2026-08-27T00:00:00.000Z",
    now: "2026-08-21T00:00:00.000Z",
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("tradingview")) return jsonResponse({ result: [] });
      if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [] } });
      if (target.includes("federalreserve.gov")) return new Response(EMPTY_FED_CALENDAR);
      if (target.includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
      if (target.includes("bea.gov")) return new Response(html);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.equal(result.sources.find((source) => source.id === "bea-release-schedule").status, "ok");
  assert.deepEqual(result.events.map((event) => event.title), ["US PCE", "US Core PCE"]);
});

test("official calendar adapters reject generic HTML challenges but accept source-specific empty schedules", async () => {
  const blockedFed = await fetchFederalReserveCalendar({
    fetchImpl: async () => new Response("<html><body><main>Access denied</main></body></html>"),
    timeoutMs: 10,
  });
  const emptyFed = await fetchFederalReserveCalendar({
    fetchImpl: async () => new Response(EMPTY_FED_CALENDAR),
    timeoutMs: 10,
  });
  const fetchBeaStatus = async (html) => {
    const result = await fetchMarketCalendar({
      from: "2026-08-20T00:00:00.000Z",
      to: "2026-08-21T00:00:00.000Z",
      timeoutMs: 10,
      fetchImpl: async (url) => {
        const target = String(url);
        if (target.includes("tradingview")) return jsonResponse({ result: [] });
        if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [] } });
        if (target.includes("federalreserve.gov")) return new Response(EMPTY_FED_CALENDAR);
        if (target.includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
        if (target.includes("bea.gov")) return new Response(html);
        throw new Error(`Unexpected URL: ${url}`);
      },
    });
    return result.sources.find((source) => source.id === "bea-release-schedule");
  };

  assert.equal(blockedFed.sources[0].status, "error");
  assert.equal(emptyFed.sources[0].status, "ok");
  assert.equal((await fetchBeaStatus("<html><body><main>Access denied</main></body></html>")).status, "error");
  assert.equal((await fetchBeaStatus(EMPTY_BEA_SCHEDULE)).status, "ok");
});

test("official calendar adapters reject nonempty schedule rows when every candidate drifts from the schema", async () => {
  const malformedFed = await fetchFederalReserveCalendar({
    fetchImpl: async () => new Response(`
      <a>2026 FOMC Meetings</a>
      <div class="row fomc-meeting">
        <div class="fomc-meeting__month">Septembruary</div>
        <div class="fomc-meeting__date">TBA</div>
      </div>
    `),
    timeoutMs: 10,
  });
  const result = await fetchMarketCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-21T00:00:00.000Z",
    timeoutMs: 10,
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("tradingview")) return jsonResponse({ result: [] });
      if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [] } });
      if (target.includes("federalreserve.gov")) return new Response(EMPTY_FED_CALENDAR);
      if (target.includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
      if (target.includes("bea.gov")) return new Response(`
        <table id="release-schedule-table">
          <thead><tr><th>Year 2026</th><th>Release</th></tr></thead>
          <tbody><tr>
            <td class="release-date">August XX <span class="text-muted">8:30 A.M.</span></td>
            <td class="release-title">Gross Domestic Product</td>
          </tr></tbody>
        </table>
      `);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const bea = result.sources.find((source) => source.id === "bea-release-schedule");

  assert.equal(malformedFed.sources[0].status, "error");
  assert.match(malformedFed.warnings.join("\n"), /schema/i);
  assert.equal(bea.status, "error");
  assert.match(result.warnings.join("\n"), /BEA.*schema/i);
});

test("official calendar adapters reject nonempty schedules when source classes drift", async () => {
  const [fedHtml, beaHtml] = await Promise.all([
    textFixture("federal-reserve-fomc-calendar-class-drift.html"),
    textFixture("bea-release-schedule-class-drift.html"),
  ]);
  const fed = await fetchFederalReserveCalendar({
    fetchImpl: async () => new Response(fedHtml),
    timeoutMs: 10,
  });
  const result = await fetchMarketCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-21T00:00:00.000Z",
    timeoutMs: 10,
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("tradingview")) return jsonResponse({ result: [] });
      if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [] } });
      if (target.includes("federalreserve.gov")) return new Response(EMPTY_FED_CALENDAR);
      if (target.includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
      if (target.includes("bea.gov")) return new Response(beaHtml);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const bea = result.sources.find((source) => source.id === "bea-release-schedule");

  assert.deepEqual([fed.sources[0].status, bea.status], ["error", "error"]);
  assert.match(fed.warnings.join("\n"), /schema/i);
  assert.match(result.warnings.join("\n"), /BEA.*schema/i);
});

test("official calendar adapters reject mixed valid and drifted schedule rows", async () => {
  const [fedHtml, beaHtml] = await Promise.all([
    textFixture("federal-reserve-fomc-calendar-mixed-drift.html"),
    textFixture("bea-release-schedule-mixed-drift.html"),
  ]);
  const fed = await fetchFederalReserveCalendar({
    fetchImpl: async () => new Response(fedHtml),
    timeoutMs: 10,
  });
  const result = await fetchMarketCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-10-01T00:00:00.000Z",
    timeoutMs: 10,
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("tradingview")) return jsonResponse({ result: [] });
      if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [] } });
      if (target.includes("federalreserve.gov")) return new Response(EMPTY_FED_CALENDAR);
      if (target.includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
      if (target.includes("bea.gov")) return new Response(beaHtml);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const bea = result.sources.find((source) => source.id === "bea-release-schedule");

  assert.deepEqual([fed.sources[0].status, bea.status], ["error", "error"]);
  assert.match(fed.warnings.join("\n"), /schema/i);
  assert.match(result.warnings.join("\n"), /BEA.*schema/i);
});

test("market calendar deduplicates US country aliases before reconciliation", async () => {
  const result = await fetchMarketCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-21T00:00:00.000Z",
    now: "2026-08-20T10:00:00.000Z",
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("tradingview")) return jsonResponse({ result: [{
        title: "US CPI", country: "United States", date: "2026-08-20T12:30:00Z",
      }] });
      if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [{
        gmt: "12:30", country: "US", eventName: "Consumer Price Index",
      }] } });
      if (target.includes("federalreserve.gov")) return new Response(EMPTY_FED_CALENDAR);
      if (target.includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
      if (target.includes("bea.gov")) return new Response(EMPTY_BEA_SCHEDULE);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].id, "cpi:US:2026-08-20");
  assert.deepEqual([
    result.events[0].schedule.sourceId,
    ...result.events[0].schedule.comparisons.map((source) => source.sourceId),
  ].sort(), [
    "nasdaq-economic-calendar",
    "tradingview-calendar",
  ]);
});

test("market calendar fails over from TradingView to Nasdaq without an API key", async () => {
  const calls = [];
  const result = await fetchMarketCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-21T00:00:00.000Z",
    now: "2026-08-20T10:00:00.000Z",
    timeoutMs: 10,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("tradingview")) return jsonResponse({ error: "offline" }, 503);
      if (String(url).includes("nasdaq")) return jsonResponse({ data: { rows: [{
        gmt: "08:30", country: "United States", eventName: "US GDP", consensus: "2.1%", previous: "2.0%",
      }] } });
      if (String(url).includes("federalreserve.gov")) return new Response(`<a href="/monetarypolicy/files/monetary20260916a1.pdf">PDF</a>`);
      if (String(url).includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
      if (String(url).includes("bea.gov")) return new Response(EMPTY_BEA_SCHEDULE);
      throw new Error(`unexpected calendar source: ${url}`);
    },
  });

  assert.equal(result.events.length, 1);
  assert.deepEqual(result.sources.map((source) => source.id), [
    "tradingview-calendar",
    "nasdaq-economic-calendar",
    "federal-reserve-calendar",
    "bls-release-calendar",
    "bea-release-schedule",
  ]);
  assert.ok(calls.some((url) => url.includes("nasdaq.com")));
});

test("market calendar collects all healthy routes, deduplicates events, and keeps source comparisons", async () => {
  const result = await fetchMarketCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-21T00:00:00.000Z",
    now: "2026-08-20T10:00:00.000Z",
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("tradingview")) return jsonResponse({ result: [{
        id: "tv-cpi", title: "US CPI YoY", country: "US", importance: 3, date: "2026-08-20T12:30:00.000Z",
      }] });
      if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [{
        gmt: "12:30", country: "United States", eventName: "Consumer Price Index YoY", consensus: "3.0%",
      }] } });
      if (target.includes("federalreserve.gov")) return new Response(`<a href="/monetarypolicy/files/monetary20260820a1.pdf">PDF</a>`);
      if (target.includes("bls.gov")) return new Response([
        "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:bls-cpi", "DTSTAMP:20260819T130000Z",
        "DTSTART:20260820T123000Z", "SUMMARY:Consumer Price Index", "END:VEVENT", "END:VCALENDAR",
      ].join("\r\n"));
      if (target.includes("bea.gov")) return new Response(EMPTY_BEA_SCHEDULE);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const cpi = result.events.find((event) => event.id.includes("cpi") && !event.id.includes("core"));
  assert.ok(cpi);
  assert.equal(result.events.filter((event) => event.id === cpi.id).length, 1);
  assert.deepEqual(cpi.schedule.comparisons.map((source) => source.sourceId).sort(), [
    "nasdaq-economic-calendar",
    "tradingview-calendar",
  ]);
  assert.equal(cpi.schedule.sourceId, "bls-release-calendar");
  assert.deepEqual(result.sources.slice(0, 3).map((source) => source.id), [
    "tradingview-calendar", "nasdaq-economic-calendar", "federal-reserve-calendar",
  ]);
  assert.equal(result.sources.every((source) => source.status === "ok"), true);
  assert.deepEqual(Object.keys(result).sort(), ["checkedAt", "data", "events", "reconciliation", "sources", "warnings"]);
});

test("one calendar timeout does not erase two healthy routes", async () => {
  const result = await fetchMarketCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-21T00:00:00.000Z",
    now: "2026-08-20T10:00:00.000Z",
    timeoutMs: 5,
    deadlineMs: 20,
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("tradingview")) return jsonResponse({ result: [{ title: "Retail Sales", country: "US", date: "2026-08-20T12:30:00Z" }] });
      if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [{ gmt: "14:00", country: "US", eventName: "Existing Home Sales" }] } });
      if (target.includes("federalreserve.gov")) return new Promise(() => {});
      if (target.includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
      if (target.includes("bea.gov")) return new Response(EMPTY_BEA_SCHEDULE);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.equal(result.events.length, 2);
  assert.equal(result.sources.find((source) => source.id === "federal-reserve-calendar").status, "timeout");
  assert.equal(result.sources.filter((source) => source.status === "ok").length, 4);
});

test("official calendar schedule overrides auxiliary time", async () => {
  const result = await fetchMarketCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-21T00:00:00.000Z",
    now: "2026-08-20T10:00:00.000Z",
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("tradingview")) return jsonResponse({ result: [{ title: "US CPI", country: "US", date: "2026-08-20T13:30:00Z" }] });
      if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [{ gmt: "13:30", country: "US", eventName: "Consumer Price Index" }] } });
      if (target.includes("federalreserve.gov")) return new Response(`<a href="/monetarypolicy/files/monetary20260916a1.pdf">PDF</a>`);
      if (target.includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260820T123000Z\r\nSUMMARY:Consumer Price Index\r\nEND:VEVENT\r\nEND:VCALENDAR");
      if (target.includes("bea.gov")) return new Response(EMPTY_BEA_SCHEDULE);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const cpi = result.events.find((event) => event.id === "cpi:US:2026-08-20");
  assert.equal(cpi.scheduledAt, "2026-08-20T12:30:00.000Z");
  assert.equal(cpi.schedule.authority, "official");
  assert.equal(cpi.schedule.comparisons.length, 2);
});

test("conflicting auxiliary times stay under verification and out of publication", async () => {
  const result = await fetchMarketCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-21T00:00:00.000Z",
    now: "2026-08-20T10:00:00.000Z",
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("tradingview")) return jsonResponse({ result: [{ title: "US CPI", country: "US", date: "2026-08-20T12:30:00Z" }] });
      if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [{ gmt: "13:30", country: "US", eventName: "Consumer Price Index" }] } });
      if (target.includes("federalreserve.gov")) return new Response(`<a href="/monetarypolicy/files/monetary20260916a1.pdf">PDF</a>`);
      if (target.includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
      if (target.includes("bea.gov")) return new Response(EMPTY_BEA_SCHEDULE);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const cpi = result.events.find((event) => event.id === "cpi:US:2026-08-20");
  assert.equal(cpi.timeLabel, "Time under verification");
  assert.equal(cpi.schedule.status, "conflicting");
  assert.equal(cpi.publishable, false);
  assert.equal(result.reconciliation.excluded, 1);
});

test("calendar source health distinguishes an empty success from a failed request", async () => {
  const result = await fetchMarketCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-21T00:00:00.000Z",
    now: "2026-08-20T10:00:00.000Z",
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("tradingview")) return jsonResponse({ result: [] });
      if (target.includes("nasdaq")) return jsonResponse({ error: "failed" }, 503);
      if (target.includes("federalreserve.gov")) return new Response(`<a href="/monetarypolicy/files/monetary20260916a1.pdf">PDF</a>`);
      if (target.includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
      if (target.includes("bea.gov")) return new Response(EMPTY_BEA_SCHEDULE);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.equal(result.sources.find((source) => source.id === "tradingview-calendar").status, "ok");
  assert.equal(result.sources.find((source) => source.id === "nasdaq-economic-calendar").status, "error");
  assert.equal(result.sources.find((source) => source.id === "bls-release-calendar").status, "ok");
  assert.match(result.warnings.join("\n"), /Nasdaq/);
});

test("official schedules merge a cross-day auxiliary release and override its disputed time", async () => {
  const result = await fetchMarketCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-22T00:00:00.000Z",
    now: "2026-08-20T10:00:00.000Z",
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("tradingview")) return jsonResponse({ result: [{
        title: "US CPI", country: "US", date: "2026-08-20T23:30:00Z",
      }] });
      if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [] } });
      if (target.includes("federalreserve.gov")) return new Response(EMPTY_FED_CALENDAR);
      if (target.includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260821T123000Z\r\nSUMMARY:Consumer Price Index\r\nEND:VEVENT\r\nEND:VCALENDAR");
      if (target.includes("bea.gov")) return new Response(EMPTY_BEA_SCHEDULE);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const headline = result.events.filter((event) => event.id.startsWith("cpi:"));
  assert.equal(headline.length, 1);
  assert.equal(headline[0].scheduledAt, "2026-08-21T12:30:00.000Z");
  assert.equal(headline[0].schedule.sourceId, "bls-release-calendar");
  assert.deepEqual(headline[0].schedule.comparisons.map((candidate) => candidate.sourceId), ["tradingview-calendar"]);
});

test("official schedules augment a TBD auxiliary release by its statistical period", async () => {
  const bea = await textFixture("bea-release-schedule.html");
  const result = await fetchMarketCalendar({
    from: "2026-08-25T00:00:00.000Z",
    to: "2026-08-27T00:00:00.000Z",
    now: "2026-08-21T00:00:00.000Z",
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("tradingview")) return jsonResponse({ result: [{
        title: "US PCE YoY", country: "US", date: "2026-08-25", referencePeriod: "July 2026", forecast: "2.7%",
      }] });
      if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [] } });
      if (target.includes("federalreserve.gov")) return new Response(EMPTY_FED_CALENDAR);
      if (target.includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
      if (target.includes("bea.gov")) return new Response(bea);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const pceYoy = result.events.filter((event) => event.id.startsWith("pce-yoy:"));
  assert.equal(pceYoy.length, 1);
  assert.equal(pceYoy[0].scheduledAt, "2026-08-26T12:30:00.000Z");
  assert.equal(pceYoy[0].schedule.sourceId, "bea-release-schedule");
  assert.equal(pceYoy[0].values.forecast.value, "2.7%");
  assert.equal(pceYoy[0].values.forecast.sourceId, "tradingview-calendar");
});

test("official schedules preserve series-aware titles through weekly Telegram rendering", async () => {
  const result = await fetchMarketCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-21T00:00:00.000Z",
    now: "2026-08-20T10:00:00.000Z",
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("tradingview")) return jsonResponse({ result: [
        { title: "US CPI YoY", country: "US", date: "2026-08-20T12:30:00Z" },
        { title: "US CPI MoM", country: "US", date: "2026-08-20T12:30:00Z" },
        { title: "US GDP Annualized QoQ", country: "US", date: "2026-08-20T12:30:00Z" },
        { title: "US PCE YoY", country: "US", date: "2026-08-20T12:30:00Z" },
      ] });
      if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [] } });
      if (target.includes("federalreserve.gov")) return new Response(EMPTY_FED_CALENDAR);
      if (target.includes("bls.gov")) return new Response([
        "BEGIN:VCALENDAR", "BEGIN:VEVENT", "DTSTART:20260820T123000Z",
        "SUMMARY:Consumer Price Index", "END:VEVENT", "END:VCALENDAR",
      ].join("\r\n"));
      if (target.includes("bea.gov")) return new Response(`
        <table id="release-schedule-table">
          <thead><tr><th>Year 2026</th><th>Release</th></tr></thead>
          <tbody>
            <tr><td class="release-date">August 20 <span class="text-muted">8:30 A.M.</span></td><td class="release-title">Gross Domestic Product, 2nd Quarter 2026</td></tr>
            <tr><td class="release-date">August 20 <span class="text-muted">8:30 A.M.</span></td><td class="release-title">Personal Income and Outlays, July 2026</td></tr>
          </tbody>
        </table>
      `);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const titlesBySeries = Object.fromEntries(result.events.map((event) => [event.id.split(":")[0], event.title]));
  const rendered = renderTelegramMarketDocument(buildWeeklyCalendarDocument({
    now: new Date("2026-08-20T10:00:00.000Z"),
    events: result.events,
  }));

  assert.equal(titlesBySeries["cpi-yoy"], "US CPI YoY");
  assert.equal(titlesBySeries["cpi-mom"], "US CPI MoM");
  assert.equal(titlesBySeries["gdp-annualized-qoq"], "US GDP Annualized QoQ");
  assert.equal(titlesBySeries["pce-yoy"], "US PCE YoY");
  assert.match(rendered, /US CPI YoY/);
  assert.match(rendered, /US GDP Annualized QoQ/);
  assert.match(rendered, /US PCE YoY/);
});

test("TradingView and Nasdaq date-only TBD rows deduplicate on their structured date", async () => {
  const result = await fetchMarketCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-21T00:00:00.000Z",
    now: "2026-08-20T10:00:00.000Z",
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("tradingview")) return jsonResponse({ result: [{
        title: "US CPI YoY", country: "United States", date: "2026-08-20",
      }] });
      if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [{
        gmt: "TBD", country: "US", eventName: "Consumer Price Index YoY",
      }] } });
      if (target.includes("federalreserve.gov")) return new Response(EMPTY_FED_CALENDAR);
      if (target.includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
      if (target.includes("bea.gov")) return new Response(EMPTY_BEA_SCHEDULE);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].id, "cpi-yoy:US:2026-08-20");
});

test("date-only and timed rows on the same day merge before an official schedule wins", async () => {
  const result = await fetchMarketCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-21T00:00:00.000Z",
    now: "2026-08-20T10:00:00.000Z",
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("tradingview")) return jsonResponse({ result: [{
        title: "US CPI YoY", country: "US", date: "2026-08-20", period: "July 2026", forecast: "2.8%",
      }] });
      if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [{
        gmt: "12:30", country: "United States", eventName: "Consumer Price Index YoY", previous: "2.7%",
      }] } });
      if (target.includes("federalreserve.gov")) return new Response(EMPTY_FED_CALENDAR);
      if (target.includes("bls.gov")) return new Response([
        "BEGIN:VCALENDAR", "BEGIN:VEVENT", "DTSTART:20260820T123000Z",
        "SUMMARY:Consumer Price Index", "END:VEVENT", "END:VCALENDAR",
      ].join("\r\n"));
      if (target.includes("bea.gov")) return new Response(EMPTY_BEA_SCHEDULE);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const cpi = result.events.filter((event) => event.id === "cpi-yoy:US:2026-08-20");

  assert.equal(cpi.length, 1);
  assert.equal(cpi[0].scheduledAt, "2026-08-20T12:30:00.000Z");
  assert.equal(cpi[0].schedule.authority, "official");
  assert.equal(cpi[0].schedule.comparisons[0].sourceId, "nasdaq-economic-calendar");
  assert.equal(cpi[0].values.forecast.sourceId, "tradingview-calendar");
  assert.equal(cpi[0].values.previous.sourceId, "nasdaq-economic-calendar");
});

test("truly dateless event identities stay stable when source input order changes", async () => {
  const collectIds = async (rows) => {
    const result = await fetchMarketCalendar({
      from: "2026-08-20T00:00:00.000Z",
      to: "2026-08-21T00:00:00.000Z",
      now: "2026-08-20T10:00:00.000Z",
      fetchImpl: async (url) => {
        const target = String(url);
        if (target.includes("tradingview")) return jsonResponse({ result: rows });
        if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [] } });
        if (target.includes("federalreserve.gov")) return new Response(EMPTY_FED_CALENDAR);
        if (target.includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
        if (target.includes("bea.gov")) return new Response(EMPTY_BEA_SCHEDULE);
        throw new Error(`Unexpected URL: ${url}`);
      },
    });
    return Object.fromEntries(result.events.map((event) => [event.title, event.id]));
  };
  const first = { title: "Retail Sales", country: "US" };
  const second = { title: "Existing Home Sales", country: "US" };

  const forward = await collectIds([first, second]);
  const reverse = await collectIds([second, first]);

  assert.deepEqual(forward, reverse);
  assert.equal(Object.values(forward).some((id) => /unknown-\d+$/.test(id)), false);
});

test("truly dateless event identities do not change when reported values update", async () => {
  const collectId = async (values) => {
    const result = await fetchMarketCalendar({
      from: "2026-08-20T00:00:00.000Z",
      to: "2026-08-21T00:00:00.000Z",
      now: "2026-08-20T10:00:00.000Z",
      fetchImpl: async (url) => {
        const target = String(url);
        if (target.includes("tradingview")) return jsonResponse({ result: [{
          title: "Retail Sales", country: "US", ...values,
        }] });
        if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [] } });
        if (target.includes("federalreserve.gov")) return new Response(EMPTY_FED_CALENDAR);
        if (target.includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
        if (target.includes("bea.gov")) return new Response(EMPTY_BEA_SCHEDULE);
        throw new Error(`Unexpected URL: ${url}`);
      },
    });
    return result.events[0].id;
  };

  const before = await collectId({ actual: null, forecast: "0.2%", previous: "0.1%" });
  const after = await collectId({ actual: "0.4%", forecast: "0.3%", previous: "0.2%" });

  assert.equal(after, before);
});

test("Nasdaq TBD events on separate dates keep distinct safe identities", async () => {
  const result = await fetchMarketCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-22T00:00:00.000Z",
    now: "2026-08-20T10:00:00.000Z",
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("tradingview")) return jsonResponse({ result: [] });
      if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [{
        gmt: "TBD", country: "US", eventName: "US GDP",
      }] } });
      if (target.includes("federalreserve.gov")) return new Response(EMPTY_FED_CALENDAR);
      if (target.includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
      if (target.includes("bea.gov")) return new Response(EMPTY_BEA_SCHEDULE);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const gdp = result.events.filter((event) => event.id.startsWith("gdp:"));
  assert.equal(gdp.length, 2);
  assert.equal(new Set(gdp.map((event) => event.id)).size, 2);
  assert.equal(gdp.every((event) => !event.id.includes("[object")), true);
  assert.equal(gdp.every((event) => event.timeLabel === "Time under verification"), true);
});

test("missing countries remain UNKNOWN and cannot donate forecasts to official US releases", async () => {
  const result = await fetchMarketCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-21T00:00:00.000Z",
    now: "2026-08-20T10:00:00.000Z",
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("tradingview")) return jsonResponse({ result: [{
        title: "CPI", date: "2026-08-20T12:30:00Z", forecast: "3.4%",
      }] });
      if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [] } });
      if (target.includes("federalreserve.gov")) return new Response(EMPTY_FED_CALENDAR);
      if (target.includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260820T123000Z\r\nSUMMARY:Consumer Price Index\r\nEND:VEVENT\r\nEND:VCALENDAR");
      if (target.includes("bea.gov")) return new Response(EMPTY_BEA_SCHEDULE);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const headline = result.events.filter((event) => event.id.startsWith("cpi:"));
  assert.deepEqual(headline.map((event) => event.country).sort(), ["UNKNOWN", "US"]);
  assert.equal(headline.find((event) => event.country === "US").values.forecast, null);
  assert.equal(headline.find((event) => event.country === "UNKNOWN").values.forecast.value, "3.4%");
});

test("Nasdaq fetches multi-day ranges concurrently and applies the exact offset-aware interval", async () => {
  let active = 0;
  let maxActive = 0;
  const result = await fetchNasdaqCalendar({
    from: "2026-03-07T23:30:00-05:00",
    to: "2026-03-09T00:30:00-04:00",
    now: "2026-03-08T00:00:00.000Z",
    fetchImpl: async (url) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      const date = new URL(String(url)).searchParams.get("date");
      return jsonResponse({ data: { rows: date === "2026-03-08" ? [
        { gmt: "04:00", country: "US", eventName: "Before range" },
        { gmt: "05:00", country: "US", eventName: "Inside first day" },
      ] : [
        { gmt: "04:29", country: "US", eventName: "Inside last day" },
        { gmt: "04:30", country: "US", eventName: "At exclusive end" },
      ] } });
    },
  });

  assert.deepEqual(result.events.map((event) => event.title).sort(), ["Inside first day", "Inside last day"]);
  assert.ok(maxActive >= 2);
});

test("Nasdaq reports timeout health when every daily request times out", async () => {
  const result = await settleWithin(fetchNasdaqCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-21T00:00:00.000Z",
    now: "2026-08-20T10:00:00.000Z",
    timeoutMs: 3,
    deadlineMs: 10,
    fetchImpl: async () => new Promise(() => {}),
  }), 300, "Nasdaq timeout health did not settle");

  assert.equal(result.sources[0].status, "timeout");
  assert.match(result.warnings.join("\n"), /timeout/i);
});

test("calendar reconciliation keeps headline, core, YoY, MoM, and annualized series distinct", async () => {
  const result = await fetchMarketCalendar({
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-21T00:00:00.000Z",
    now: "2026-08-20T10:00:00.000Z",
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("tradingview")) return jsonResponse({ result: [
        { title: "US CPI YoY", country: "US", date: "2026-08-20T12:30:00Z" },
        { title: "US CPI MoM", country: "US", date: "2026-08-20T12:30:00Z" },
        { title: "US Core CPI YoY", country: "US", date: "2026-08-20T12:30:00Z" },
        { title: "US GDP Annualized QoQ", country: "US", date: "2026-08-20T12:30:00Z" },
      ] });
      if (target.includes("nasdaq")) return jsonResponse({ data: { rows: [] } });
      if (target.includes("federalreserve.gov")) return new Response(EMPTY_FED_CALENDAR);
      if (target.includes("bls.gov")) return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
      if (target.includes("bea.gov")) return new Response(EMPTY_BEA_SCHEDULE);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.deepEqual(result.events.map((event) => event.id.split(":")[0]).sort(), [
    "core-cpi-yoy", "cpi-mom", "cpi-yoy", "gdp-annualized-qoq",
  ]);
});

test("default Crypto Daily stack has three official and three industry fallbacks", async () => {
  const feed = `<?xml version="1.0"?><rss><channel><item><guid>one</guid><title>Bitcoin market update</title><link>https://example.test/one</link><pubDate>Thu, 20 Aug 2026 08:00:00 GMT</pubDate></item></channel></rss>`;
  const result = await fetchCryptoDailyCandidates({
    now: "2026-08-20T12:00:00.000Z",
    fetchImpl: async () => new Response(feed, { status: 200 }),
  });

  assert.deepEqual(result.sources.map((source) => source.id), ["sec", "cftc", "federal-reserve", "coindesk", "decrypt", "cointelegraph"]);
  assert.equal(result.sources.every((source) => source.status === "ok"), true);
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
    rawScheduledAt: "2026-08-12T12:30:00.000Z",
    unit: "%",
    values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" },
    rawValues: { actual: "2.7", forecast: "2.8", previous: "2.9", unit: "%" },
  });
  assert.equal(events[1].scheduledAt, null);
  assert.equal(events[1].timeLabel, "TBD");
  assert.deepEqual(events[1].values, { actual: null, forecast: null, previous: null });
  assert.deepEqual(events[1].rawValues, { actual: null, forecast: "", previous: "TBD", unit: "%" });
});

test("keeps date-only calendar values unscheduled while preserving the source value", () => {
  const [dateOnly, fullyScheduled] = normalizeCalendarEvents([
    { id: "date-only", title: "Policy window", date: "2026-08-19" },
    { id: "timed", title: "Policy decision", date: "2026-08-19T12:30:00Z" },
  ]);

  assert.equal(dateOnly.scheduledAt, null);
  assert.equal(dateOnly.timeLabel, "TBD");
  assert.equal(dateOnly.rawScheduledAt, "2026-08-19");
  assert.equal(fullyScheduled.scheduledAt, "2026-08-19T12:30:00.000Z");
  assert.equal(fullyScheduled.timeLabel, "2026-08-19T12:30:00.000Z");
  assert.equal(fullyScheduled.rawScheduledAt, "2026-08-19T12:30:00Z");
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

test("Atom links prefer alternate, fall back to no-rel, and exclude self or enclosure", async () => {
  const official = await textFixture("official-feed.xml");
  const [preferred] = parseRssFeed(official, { id: "sec", label: "SEC" });
  const [fallback] = parseRssFeed(`
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <id>fallback-link</id><title>Fallback</title>
        <link rel="self" href="https://example.test/self" />
        <link rel="enclosure" href="https://example.test/file.pdf" />
        <link href="https://example.test/story" />
      </entry>
    </feed>
  `, { id: "official" });

  assert.match(preferred.url, /press-releases\/2026-17\?utm_source=rss/);
  assert.equal(fallback.url, "https://example.test/story");
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

test("GET retry policy skips permanent 4xx and delays retryable 429 responses", async () => {
  let permanentCalls = 0;
  const permanent = await fetchTradingViewCalendar({
    fetchImpl: async () => {
      permanentCalls += 1;
      return jsonResponse({ error: "forbidden" }, 403);
    },
    timeoutMs: 20,
  });
  const delays = [];
  let retryableCalls = 0;
  const retryable = await fetchTradingViewCalendar({
    fetchImpl: async () => {
      retryableCalls += 1;
      return jsonResponse({ error: "rate limited" }, 429);
    },
    timeoutMs: 20,
    retryDelayMs: 7,
    delayImpl: async (milliseconds) => delays.push(milliseconds),
  });

  assert.equal(permanentCalls, 1);
  assert.equal(permanent.sources[0].status, "error");
  assert.equal(retryableCalls, 3);
  assert.deepEqual(delays, [7, 7]);
  assert.equal(retryable.sources[0].status, "error");
});

test("calendar rejects a successful HTTP response with an unrecognized schema", async () => {
  let calls = 0;
  const result = await fetchTradingViewCalendar({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: "upstream challenge" });
    },
    timeoutMs: 20,
  });

  assert.equal(calls, 3);
  assert.deepEqual(result.data, []);
  assert.equal(result.sources[0].status, "error");
  assert.equal(result.sources[0].lastSuccessAt, null);
  assert.match(result.warnings[0], /schema|payload/i);
});

test("calendar accepts an explicitly valid empty event array", async () => {
  const result = await fetchTradingViewCalendar({
    fetchImpl: async () => jsonResponse({ result: [] }),
    timeoutMs: 20,
  });

  assert.deepEqual(result.data, []);
  assert.equal(result.sources[0].status, "ok");
  assert.equal(result.sources[0].lastSuccessAt, result.sources[0].checkedAt);
  assert.deepEqual(result.warnings, []);
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

test("RSS validation rejects HTML and malformed XML but accepts a valid empty feed", async () => {
  assert.throws(
    () => parseRssFeed("<html><body>Access denied</body></html>", { id: "blocked" }),
    /feed|XML|root/i,
  );
  assert.throws(
    () => parseRssFeed("<rss><channel><item></channel></rss>", { id: "broken" }),
    /feed|XML|malformed/i,
  );

  let blockedCalls = 0;
  let malformedCalls = 0;
  const invalid = await fetchCryptoDailyCandidates({
    now: "2026-08-19T08:00:00.000Z",
    feeds: [
      { id: "blocked", label: "Blocked", url: "https://example.test/feed" },
      { id: "malformed", label: "Malformed", url: "https://example.test/broken.xml" },
    ],
    fetchImpl: async (url) => {
      if (String(url).endsWith("broken.xml")) {
        malformedCalls += 1;
        return new Response("<rss><channel><item></channel></rss>", { status: 200 });
      }
      blockedCalls += 1;
      return new Response("<html><body>Access denied</body></html>", { status: 200 });
    },
    timeoutMs: 20,
  });
  const empty = await fetchCryptoDailyCandidates({
    now: "2026-08-19T08:00:00.000Z",
    feeds: [{ id: "empty", label: "Empty", url: "https://example.test/empty.xml" }],
    fetchImpl: async () => new Response("<rss version=\"2.0\"><channel><title>Empty</title></channel></rss>", { status: 200 }),
    timeoutMs: 20,
  });

  assert.equal(blockedCalls, 3);
  assert.equal(malformedCalls, 3);
  assert.deepEqual(invalid.sources.map((source) => source.status), ["error", "error"]);
  assert.ok(invalid.sources.every((source) => source.lastSuccessAt === null));
  assert.equal(invalid.warnings.length, 2);
  assert.match(invalid.warnings.join("\n"), /feed|XML|root|malformed/i);
  assert.deepEqual(empty.data, []);
  assert.equal(empty.sources[0].status, "ok");
  assert.deepEqual(empty.warnings, []);
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

test("market reaction parses Coinbase BTC-USD and ETH-USD candles after deterministic fallbacks", async () => {
  const target = Date.parse("2026-08-18T12:00:30.000Z");
  const completedMinute = Date.parse("2026-08-18T11:59:00.000Z");
  const requested = [];
  const prices = {
    "BTC-USD": { before: 65000, latest: 65650 },
    "ETH-USD": { before: 3000, latest: 2970 },
  };
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    requested.push(parsed);
    if (parsed.hostname.includes("binance") || parsed.hostname.includes("okx")) {
      return jsonResponse({ message: "unavailable" }, 404);
    }
    if (parsed.hostname.includes("coinbase.com")) {
      const product = parsed.pathname.match(/\/products\/([^/]+)\//)?.[1];
      if (parsed.pathname.endsWith("/candles")) {
        return jsonResponse([
          [target / 1000, 1, 1, 1, 99999, 1],
          [completedMinute / 1000, 1, 1, 1, prices[product].before, "0"],
        ]);
      }
      return jsonResponse({ price: String(prices[product].latest) });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await fetchMarketReaction({
    beforeAt: target,
    now: target + 15 * 60_000,
    fetchImpl,
    symbols: ["BTC", "ETH", "DXY"],
  });

  assert.equal(result.data.BTC.source, "Coinbase");
  assert.equal(result.data.BTC.beforePrice, 65000);
  assert.equal(result.data.BTC.beforePriceAt, new Date(completedMinute).toISOString());
  assert.equal(result.data.BTC.price, 65650);
  assert.equal(result.data.BTC.changePercent, 1);
  assert.equal(result.data.ETH.source, "Coinbase");
  assert.equal(result.data.ETH.changePercent, -1);
  assert.equal(result.data.DXY, undefined);
  assert.match(result.warnings.join("\n"), /DXY optional data unavailable/);

  const coinbaseUrls = requested.filter((url) => url.hostname.includes("coinbase.com"));
  assert.deepEqual(
    [...new Set(coinbaseUrls.map((url) => url.pathname.match(/\/products\/([^/]+)\//)?.[1]))].sort(),
    ["BTC-USD", "ETH-USD"],
  );
  assert.ok(coinbaseUrls.filter((url) => url.pathname.endsWith("/candles")).every((url) => url.searchParams.get("granularity") === "60"));
  for (const symbol of ["BTC", "ETH"]) {
    const sequence = requested
      .filter((url) => url.searchParams.get("symbol")?.startsWith(symbol)
        || url.searchParams.get("instId")?.startsWith(symbol)
        || url.pathname.includes(`/products/${symbol}-USD/`))
      .map((url) => url.hostname.includes("binance") ? "binance" : url.hostname.includes("okx") ? "okx" : "coinbase");
    assert.deepEqual([...new Set(sequence)], ["binance", "okx", "coinbase"]);
  }
  assert.deepEqual(result.sources.map((source) => source.id), ["binance", "okx", "coinbase-exchange", "dxy-yahoo-finance"]);
  assert.equal(result.sources.find((source) => source.id === "coinbase-exchange").fallbackFrom, "okx");
});

test("market reaction reports all three attempted crypto providers when every route fails", async () => {
  const result = await fetchMarketReaction({
    beforeAt: "2026-08-18T12:00:00.000Z",
    now: "2026-08-18T12:15:00.000Z",
    fetchImpl: async () => jsonResponse({ message: "unavailable" }, 404),
    symbols: ["BTC"],
  });

  assert.deepEqual(result.data, {});
  assert.deepEqual(result.sources.map((source) => [source.id, source.status, source.fallbackFrom ?? null]), [
    ["binance", "error", null],
    ["okx", "error", "binance"],
    ["coinbase-exchange", "error", "okx"],
  ]);
  assert.match(result.warnings.join("\n"), /BTC.*Binance.*OKX.*Coinbase/i);
});

test("market reaction omits fallback health when the shared deadline expires before their first request", async () => {
  const requestedHosts = [];
  const result = await settleWithin(fetchMarketReaction({
    beforeAt: "2026-08-18T12:00:00.000Z",
    now: "2026-08-18T12:15:00.000Z",
    timeoutMs: 50,
    deadlineMs: 10,
    symbols: ["BTC"],
    fetchImpl: async (url) => {
      requestedHosts.push(new URL(url).hostname);
      return new Promise((resolve) => {
        setTimeout(() => resolve(jsonResponse({ message: "unavailable" }, 404)), 30);
      });
    },
  }), 200, "market reaction did not respect the shared deadline");

  assert.deepEqual(requestedHosts, ["api.binance.com"]);
  assert.deepEqual(result.sources.map((source) => source.id), ["binance"]);
  assert.equal(result.sources[0].status, "timeout");
  assert.match(result.warnings.join("\n"), /OKX.*Coinbase.*skipped|skipped.*OKX.*Coinbase/i);
});

test("market reaction keeps one Coinbase symbol when another symbol exhausts all fallbacks", async () => {
  const target = Date.parse("2026-08-18T12:00:00.000Z");
  const completedMinute = target - 60_000;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname.includes("binance") || parsed.hostname.includes("okx")) {
      return jsonResponse({ message: "unavailable" }, 404);
    }
    if (parsed.pathname.includes("/products/ETH-USD/")) {
      return jsonResponse({ message: "unavailable" }, 404);
    }
    if (parsed.pathname.endsWith("/candles")) {
      return jsonResponse([[completedMinute / 1000, 64000, 66000, 64500, 65000, 12]]);
    }
    return jsonResponse({ price: "65650" });
  };

  const result = await fetchMarketReaction({
    beforeAt: target,
    now: target + 15 * 60_000,
    fetchImpl,
    symbols: ["BTC", "ETH"],
  });

  assert.equal(result.data.BTC.source, "Coinbase");
  assert.equal(result.data.ETH, undefined);
  assert.equal(result.sources.find((source) => source.id === "coinbase-exchange").status, "degraded");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /ETH.*Coinbase/i);
});

test("Coinbase fallback rejects non-positive candle and ticker prices", async () => {
  const target = Date.parse("2026-08-18T12:00:00.000Z");
  for (const invalidField of ["candle", "ticker"]) {
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes("binance") || parsed.hostname.includes("okx")) {
        return jsonResponse({ message: "unavailable" }, 404);
      }
      if (parsed.pathname.endsWith("/candles")) {
        return jsonResponse([[(target - 60_000) / 1000, 1, 1, 1, invalidField === "candle" ? 0 : 65000, 1]]);
      }
      return jsonResponse({ price: invalidField === "ticker" ? "0" : "65650" });
    };

    const result = await fetchMarketReaction({
      beforeAt: target,
      now: target + 15 * 60_000,
      fetchImpl,
      symbols: ["BTC"],
    });

    assert.equal(result.data.BTC, undefined);
    assert.match(result.warnings.join("\n"), /Invalid BTC Coinbase (?:before|latest) price/);
  }
});

test("Coinbase fallback fails closed on tuple shape drift and non-canonical price fields", async () => {
  const target = Date.parse("2026-08-18T12:00:00.000Z");
  const completedSecond = (target - 60_000) / 1000;
  const validCandle = [completedSecond, 64000, 66000, 64500, "65000.25", 12];
  const invalidCases = [
    { label: "short candle", candle: validCandle.slice(0, 5), ticker: "65650" },
    { label: "boolean timestamp", candle: [true, ...validCandle.slice(1)], ticker: "65650" },
    { label: "NaN timestamp", candle: [Number.NaN, ...validCandle.slice(1)], ticker: "65650" },
    { label: "boolean close", candle: [...validCandle.slice(0, 4), true, validCandle[5]], ticker: "65650" },
    { label: "non-canonical close", candle: [...validCandle.slice(0, 4), " +65000 ", validCandle[5]], ticker: "65650" },
    { label: "infinite close", candle: [...validCandle.slice(0, 4), Number.POSITIVE_INFINITY, validCandle[5]], ticker: "65650" },
    { label: "negative close", candle: [...validCandle.slice(0, 4), -1, validCandle[5]], ticker: "65650" },
    { label: "boolean ticker", candle: validCandle, ticker: true },
    { label: "NaN ticker", candle: validCandle, ticker: Number.NaN },
    { label: "infinite ticker", candle: validCandle, ticker: Number.POSITIVE_INFINITY },
    { label: "non-canonical ticker", candle: validCandle, ticker: " 65650 " },
    { label: "negative ticker", candle: validCandle, ticker: -1 },
  ];

  for (const invalidCase of invalidCases) {
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes("binance") || parsed.hostname.includes("okx")) {
        return jsonResponse({ message: "unavailable" }, 404);
      }
      const body = parsed.pathname.endsWith("/candles")
        ? [invalidCase.candle]
        : { price: invalidCase.ticker };
      return { ok: true, status: 200, json: async () => body };
    };

    const result = await fetchMarketReaction({
      beforeAt: target,
      now: target + 15 * 60_000,
      fetchImpl,
      symbols: ["BTC"],
    });

    assert.equal(result.data.BTC, undefined, invalidCase.label);
    assert.match(result.warnings.join("\n"), /Coinbase.*(?:schema|invalid)|(?:schema|invalid).*Coinbase/i, invalidCase.label);
  }
});

test("Coinbase fallback strictly validates low, high, open, and volume candle fields", async (t) => {
  const target = Date.parse("2026-08-18T12:00:00.000Z");
  const validCandle = [(target - 60_000) / 1000, "64000", "66000", "64500", "65000", "12.5"];
  const invalidCases = [
    { label: "boolean low", index: 1, value: true },
    { label: "zero low", index: 1, value: 0 },
    { label: "object high", index: 2, value: {} },
    { label: "infinite high", index: 2, value: Number.POSITIVE_INFINITY },
    { label: "NaN open", index: 3, value: Number.NaN },
    { label: "non-canonical open", index: 3, value: " 64500 " },
    { label: "negative open", index: 3, value: -1 },
    { label: "boolean volume", index: 5, value: false },
    { label: "object volume", index: 5, value: {} },
    { label: "NaN volume", index: 5, value: Number.NaN },
    { label: "infinite volume", index: 5, value: Number.POSITIVE_INFINITY },
    { label: "non-canonical volume", index: 5, value: " 12.5 " },
    { label: "negative volume", index: 5, value: -1 },
  ];

  for (const invalidCase of invalidCases) {
    await t.test(invalidCase.label, async () => {
      const candle = [...validCandle];
      candle[invalidCase.index] = invalidCase.value;
      const result = await fetchMarketReaction({
        beforeAt: target,
        now: target + 15 * 60_000,
        symbols: ["BTC"],
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          if (parsed.hostname.includes("binance") || parsed.hostname.includes("okx")) {
            return jsonResponse({ message: "unavailable" }, 404);
          }
          const body = parsed.pathname.endsWith("/candles") ? [candle] : { price: "65650" };
          return { ok: true, status: 200, json: async () => body };
        },
      });

      assert.equal(result.data.BTC, undefined);
      assert.match(result.warnings.join("\n"), /Invalid BTC Coinbase (?:low|high|open|volume)/);
    });
  }
});

test("Coinbase fallback deduplicates identical candles and rejects conflicting duplicates in either order", async () => {
  const target = Date.parse("2026-08-18T12:00:00.000Z");
  const candleTime = (target - 60_000) / 1000;
  const original = [candleTime, 64000, 66000, 64500, 65000, 12];
  const conflict = [candleTime, 64000, 66000, 64500, 65100, 12];
  const run = async (candles) => fetchMarketReaction({
    beforeAt: target,
    now: target + 15 * 60_000,
    symbols: ["BTC"],
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes("binance") || parsed.hostname.includes("okx")) {
        return jsonResponse({ message: "unavailable" }, 404);
      }
      return jsonResponse(parsed.pathname.endsWith("/candles") ? candles : { price: "65650" });
    },
  });

  const deduplicated = await run([original, [...original]]);
  assert.equal(deduplicated.data.BTC.beforePrice, 65000);

  for (const candles of [[original, conflict], [conflict, original]]) {
    const rejected = await run(candles);
    assert.equal(rejected.data.BTC, undefined);
    assert.match(rejected.warnings.join("\n"), /Coinbase.*duplicate.*conflict|conflict.*duplicate.*Coinbase/i);
  }
});

test("Coinbase fallback rejects a stale candle when the final completed minute has a gap", async () => {
  const target = Date.parse("2026-08-18T12:00:30.000Z");
  const targetMinute = Date.parse("2026-08-18T12:00:00.000Z");
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname.includes("binance") || parsed.hostname.includes("okx")) {
      return jsonResponse({ message: "unavailable" }, 404);
    }
    if (parsed.pathname.endsWith("/candles")) {
      return jsonResponse([
        [targetMinute / 1000, 1, 1, 1, 70000, 1],
        [(targetMinute - 2 * 60_000) / 1000, 1, 1, 1, 65000, 1],
      ]);
    }
    return jsonResponse({ price: "65650" });
  };

  const result = await fetchMarketReaction({
    beforeAt: target,
    now: target + 15 * 60_000,
    fetchImpl,
    symbols: ["BTC"],
  });

  assert.equal(result.data.BTC, undefined);
  assert.equal(result.sources.find((source) => source.id === "coinbase-exchange").status, "error");
  assert.match(result.warnings.join("\n"), /Coinbase.*gap|gap.*Coinbase/i);
});

test("DXY skips the target-minute bar when it closes after a mid-minute event", async () => {
  const target = Date.parse("2026-08-18T12:00:30.000Z");
  const targetMinute = Date.parse("2026-08-18T12:00:00.000Z");
  const previousMinute = targetMinute - 60_000;
  const olderMinute = previousMinute - 60_000;
  const latestMinute = targetMinute + 14 * 60_000;
  const fetchImpl = async () => jsonResponse({
    chart: {
      result: [{
        timestamp: [previousMinute / 1000, targetMinute / 1000, olderMinute / 1000, latestMinute / 1000],
        indicators: { quote: [{ close: [100, 999, 90, 101] }] },
      }],
      error: null,
    },
  });

  const result = await fetchMarketReaction({
    beforeAt: target,
    now: target + 15 * 60_000,
    fetchImpl,
    symbols: ["DXY"],
  });

  assert.equal(result.data.DXY.beforePrice, 100);
  assert.equal(result.data.DXY.beforePriceAt, new Date(previousMinute).toISOString());
});

test("OKX fallback requests candles before the target and selects only completed non-future candles", async () => {
  const target = Date.parse("2026-08-18T12:00:00.000Z");
  const urls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    urls.push(parsed);
    if (parsed.hostname.includes("binance")) return jsonResponse({ code: -1121 }, 404);
    if (parsed.pathname.includes("candles")) {
      return jsonResponse({ code: "0", data: [
        [String(target + 60_000), "0", "0", "0", "99999", "0", "0", "0", "1"],
        [String(target), "0", "0", "0", "88888", "0", "0", "0", "0"],
        [String(target - 60_000), "0", "0", "0", "65000", "0", "0", "0", "1"],
      ] });
    }
    return jsonResponse({ code: "0", data: [{ last: "65650", ts: String(target + 15 * 60_000) }] });
  };

  const result = await fetchMarketReaction({
    beforeAt: target,
    now: target + 15 * 60_000,
    fetchImpl,
    symbols: ["BTC"],
  });
  const candleUrl = urls.find((url) => url.pathname.includes("candles"));

  assert.equal(urls.filter((url) => url.hostname.includes("binance")).length, 1);
  assert.equal(candleUrl.searchParams.get("after"), String(target));
  assert.equal(candleUrl.searchParams.get("before"), null);
  assert.equal(candleUrl.searchParams.get("bar"), "1m");
  assert.equal(result.data.BTC.beforePrice, 65000);
  assert.equal(result.data.BTC.beforePriceAt, new Date(target - 60_000).toISOString());
});

test("OKX skips a confirmed target-minute candle that closes after a mid-minute event", async () => {
  const target = Date.parse("2026-08-18T12:00:30.000Z");
  const targetMinute = Date.parse("2026-08-18T12:00:00.000Z");
  const previousMinute = targetMinute - 60_000;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname.includes("binance")) return jsonResponse({ code: -1121 }, 404);
    if (parsed.pathname.includes("candles")) {
      return jsonResponse({ code: "0", data: [
        [String(targetMinute), "0", "0", "0", "70000", "0", "0", "0", "1"],
        [String(previousMinute), "0", "0", "0", "65000", "0", "0", "0", "1"],
      ] });
    }
    return jsonResponse({ code: "0", data: [{ last: "65650", ts: String(target + 15 * 60_000) }] });
  };

  const result = await fetchMarketReaction({
    beforeAt: target,
    now: target + 15 * 60_000,
    fetchImpl,
    symbols: ["BTC"],
  });

  assert.equal(result.data.BTC.beforePrice, 65000);
  assert.equal(result.data.BTC.beforePriceAt, new Date(previousMinute).toISOString());
});

test("Binance skips a candle closing after the event and selects the nearest fully closed candle", async () => {
  const target = Date.parse("2026-08-18T12:00:30.000Z");
  const targetMinute = Date.parse("2026-08-18T12:00:00.000Z");
  const previousMinute = targetMinute - 60_000;
  const urls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    urls.push(parsed);
    if (parsed.pathname.includes("klines")) {
      return jsonResponse([
        [targetMinute, "0", "0", "0", "70000", "0", targetMinute + 60_000 - 1],
        [previousMinute, "0", "0", "0", "65000", "0", targetMinute - 1],
      ]);
    }
    return jsonResponse({ symbol: "BTCUSDT", price: "65650" });
  };

  const result = await fetchMarketReaction({
    beforeAt: target,
    now: target + 15 * 60_000,
    fetchImpl,
    symbols: ["BTC"],
  });
  const candleUrl = urls.find((url) => url.pathname.includes("klines"));

  assert.equal(candleUrl.searchParams.get("endTime"), String(targetMinute - 1));
  assert.equal(result.data.BTC.beforePrice, 65000);
  assert.equal(result.data.BTC.beforePriceAt, new Date(previousMinute).toISOString());
});

test("market reaction runs independent symbols within one shared deadline", async () => {
  const startedAt = Date.now();
  const result = await settleWithin(fetchMarketReaction({
    beforeAt: "2026-08-18T12:00:00.000Z",
    now: "2026-08-18T12:15:00.000Z",
    symbols: ["BTC", "ETH"],
    timeoutMs: 15,
    deadlineMs: 60,
    fetchImpl: async () => new Promise((resolve) => {
      setTimeout(() => resolve(jsonResponse({ price: "65000" })), 40);
    }),
  }), 500, "market reaction exceeded its overall deadline");

  assert.ok(Date.now() - startedAt < 140);
  assert.deepEqual(result.data, {});
  assert.equal(result.warnings.length, 2);
});

test("market reaction assembles concurrent data and warnings in normalized symbol order", async () => {
  const target = Date.parse("2026-08-18T12:00:00.000Z");
  const now = target + 15 * 60_000;
  const successful = await fetchMarketReaction({
    beforeAt: target,
    now,
    symbols: ["btc", "ETH", "DXY", "BTC"],
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes("binance")) {
        const asset = parsed.searchParams.get("symbol").replace("USDT", "");
        if (asset === "BTC") await new Promise((resolve) => setTimeout(resolve, 20));
        return jsonResponse(parsed.pathname.includes("klines")
          ? [[target - 60_000, "0", "0", "0", asset === "BTC" ? "65000" : "3000", "0", target - 1]]
          : { price: asset === "BTC" ? "65650" : "2970" });
      }
      return jsonResponse({
        chart: {
          result: [{
            timestamp: [(target - 60_000) / 1000, (now - 60_000) / 1000],
            indicators: { quote: [{ close: [100, 101] }] },
          }],
          error: null,
        },
      });
    },
  });

  assert.deepEqual(Object.keys(successful.data), ["BTC", "ETH", "DXY"]);
  assert.deepEqual(successful.sources.map((source) => source.id), ["binance", "dxy-yahoo-finance"]);

  const failed = await fetchMarketReaction({
    beforeAt: target,
    now,
    symbols: ["BTC", "ETH", "DXY"],
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.href.includes("BTC")) await new Promise((resolve) => setTimeout(resolve, 8));
      if (parsed.hostname.includes("yahoo")) await new Promise((resolve) => setTimeout(resolve, 4));
      return jsonResponse({ message: "unavailable" }, 404);
    },
  });

  assert.deepEqual(failed.warnings.map((warning) => warning.match(/^(BTC|ETH|DXY)/)?.[1]), ["BTC", "ETH", "DXY"]);
  assert.deepEqual(failed.sources.map((source) => source.id), ["binance", "okx", "coinbase-exchange", "dxy-yahoo-finance"]);
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
