import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCryptoDailyPosterModel,
  buildDataUpdatePosterModel,
  buildWeeklyCalendarPosterModel,
} from "../lib/market-poster-models.mjs";

const VISUAL_TOKENS = {
  canvas: { width: 1200, height: 675 },
  palette: {
    paper: "#E9E5DC",
    ink: "#171717",
    muted: "#6D6A63",
    red: "#A3483F",
    green: "#3F6D57",
  },
  masthead: "YUBIT ACADEMY / EDITORIAL RESEARCH",
};

function assertEditorialTokens(model, { sources, updatedAt }) {
  assert.deepEqual(model.canvas, VISUAL_TOKENS.canvas);
  assert.deepEqual(model.palette, VISUAL_TOKENS.palette);
  assert.equal(model.masthead, VISUAL_TOKENS.masthead);
  assert.deepEqual(model.footer, { sources, timezone: "UTC", updatedAt });
  assert.equal(JSON.stringify(model).includes("jsx"), false);
}

test("every poster model exposes the shared Editorial Research visual tokens", () => {
  const weekly = buildWeeklyCalendarPosterModel({
    weekStart: "2026-08-17",
    generatedAt: "2026-08-16T18:00:00.000Z",
    days: [{
      date: "2026-08-17",
      events: [{ id: "cpi", title: "US CPI", source: { label: "BLS" } }],
    }],
  });
  const data = buildDataUpdatePosterModel({
    generatedAt: "2026-08-21T12:45:00.000Z",
    title: "US CPI Released",
    source: { label: "BLS" },
  });
  const crypto = buildCryptoDailyPosterModel({
    generatedAt: "2026-08-21T08:00:00.000Z",
    selectedStories: [{ title: "Policy decision", source: { label: "SEC" } }],
  });

  assertEditorialTokens(weekly, { sources: ["BLS"], updatedAt: "2026-08-16T18:00:00.000Z" });
  assertEditorialTokens(data, { sources: ["BLS"], updatedAt: "2026-08-21T12:45:00.000Z" });
  assertEditorialTokens(crypto, { sources: ["SEC"], updatedAt: "2026-08-21T08:00:00.000Z" });
});

test("weekly calendar uses five weekday columns and emphasizes exactly the top three events", () => {
  const days = Array.from({ length: 5 }, (_, day) => ({
    date: `2026-08-${17 + day}`,
    events: [{
      id: `event-${day}`,
      title: `Event ${day}`,
      time: `${12 + day}:30`,
      importance: 5 - day,
      whyItMatters: `Event ${day} changes the market path.`,
      source: { label: `Source ${day}` },
    }],
  }));
  const model = buildWeeklyCalendarPosterModel({
    title: "Calendar",
    weekStart: "2026-08-17",
    generatedAt: "2026-08-16T18:00:00.000Z",
    days,
  });

  assert.equal(model.columns.length, 5);
  assert.deepEqual(model.columns.map((column) => column.label), ["MON 17", "TUE 18", "WED 19", "THU 20", "FRI 21"]);
  assert.equal(model.columns.flatMap((column) => column.events).length, 5);
  assert.equal(model.columns.flatMap((column) => column.events).filter((event) => event.isPriority).length, 3);
  assert.deepEqual(model.priorityEventIds, ["event-0", "event-1", "event-2"]);
  assert.equal(model.columns[0].events[0].visualWeight, "primary");
  assert.equal(model.columns[3].events[0].visualWeight, "secondary");
});

test("weekly calendar adds Crypto Weekend only for material weekend events", () => {
  const base = {
    weekStart: "2026-08-17",
    generatedAt: "2026-08-16T18:00:00.000Z",
    days: [{ date: "2026-08-17", events: [{ id: "monday", title: "Monday event", importance: 3 }] }],
  };
  const withoutMaterialWeekend = buildWeeklyCalendarPosterModel({
    ...base,
    days: [...base.days, { date: "2026-08-22", events: [{ id: "minor", title: "Minor meetup", importance: 1 }] }],
  });
  const withMaterialWeekend = buildWeeklyCalendarPosterModel({
    ...base,
    days: [...base.days, {
      date: "2026-08-22",
      events: [{ id: "unlock", title: "Major token unlock", importance: 3, source: { label: "Project filing" } }],
    }],
  });

  assert.equal(Object.hasOwn(withoutMaterialWeekend, "weekend"), false);
  assert.equal(withMaterialWeekend.weekend.label, "CRYPTO WEEKEND");
  assert.equal(withMaterialWeekend.weekend.events[0].id, "unlock");
});

test("weekly calendar caps priority descriptions on word boundaries without hiding numerical facts", () => {
  const description = `${"A prolonged explanation of cross-asset transmission ".repeat(5)}with CPI at 2.7% versus 2.9% and a 25 bps policy repricing.`;
  const model = buildWeeklyCalendarPosterModel({
    weekStart: "2026-08-17",
    days: [{
      date: "2026-08-17",
      events: [{ id: "cpi", title: "US CPI", importance: 3, whyItMatters: description }],
    }],
  });
  const event = model.columns[0].events[0];

  assert.ok(event.description.length <= 120);
  assert.match(event.description, /…/u);
  assert.match(event.description, /2\.7%/u);
  assert.match(event.description, /2\.9%/u);
  assert.match(event.description, /25 bps/u);
  assert.doesNotMatch(event.description, /\p{L}…\p{L}/u);
});

test("weekly calendar footer reports sources, UTC, update time, and stale-source labels", () => {
  const model = buildWeeklyCalendarPosterModel({
    weekStart: "2026-08-17",
    generatedAt: "2026-08-16T18:00:00.000Z",
    days: [{
      date: "2026-08-17",
      events: [{ id: "cpi", title: "US CPI", importance: 3, source: { label: "BLS cache", freshness: "stale" } }],
    }],
  });

  assert.deepEqual(model.footer, {
    sources: ["BLS cache · STALE SOURCE"],
    timezone: "UTC",
    updatedAt: "2026-08-16T18:00:00.000Z",
  });
  assert.equal(model.columns[0].events[0].sourceStatus, "STALE SOURCE");
});

test("data update handles a long title, negative values, missing forecast, and official source", () => {
  const model = buildDataUpdatePosterModel({
    generatedAt: "2026-08-21T12:45:00.000Z",
    title: "United States Consumer Price Index headline and underlying inflation release with an intentionally long official title",
    indicator: "cpi",
    values: { actual: "-0.2%", previous: "0.1%" },
    source: { label: "U.S. Bureau of Labor Statistics", type: "official" },
  });

  assert.ok(model.title.length <= 72);
  assert.match(model.title, /…$/u);
  assert.equal(model.actual, "-0.2%");
  assert.equal(model.previous, "0.1%");
  assert.equal(model.forecast, null);
  assert.equal(model.surprise, null);
  assert.equal(model.officialSource, "U.S. BUREAU OF LABOR STATISTICS");
  assert.equal(model.forecastLabel, null);
});

test("data update preserves CPI and Core CPI components as separate fact rows", () => {
  const model = buildDataUpdatePosterModel({
    generatedAt: "2026-08-21T12:45:00.000Z",
    title: "US CPI Released",
    components: [
      { title: "CPI", indicator: "cpi", values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" } },
      { title: "Core CPI", indicator: "core-cpi", values: { actual: "3.0%", forecast: "3.1%", previous: "3.2%" } },
    ],
    source: { label: "BLS" },
  });

  assert.deepEqual(model.components, [
    { title: "CPI", indicator: "CPI", actual: "2.7%", forecast: "2.8%", previous: "2.9%", surprise: "-0.1pp" },
    { title: "Core CPI", indicator: "CORE CPI", actual: "3.0%", forecast: "3.1%", previous: "3.2%", surprise: "-0.1pp" },
  ]);
});

test("data update preserves partial reactions and a bounded reaction window", () => {
  const model = buildDataUpdatePosterModel({
    generatedAt: "2026-08-21T12:45:00.000Z",
    nodes: [
      { type: "metric", label: "BTC", value: "+1.2%" },
      { type: "metric", label: "DXY", value: "-0.3%" },
    ],
    reactionWindow: {
      start: "2026-08-21T12:29:00.000Z",
      end: "2026-08-21T12:45:00.000Z",
      providers: ["Coinbase Exchange"],
    },
    source: { label: "BLS" },
    reactionSources: ["Coinbase Exchange"],
  });

  assert.deepEqual(model.reactions, [
    { symbol: "BTC", value: 1.2, label: "+1.2%" },
    { symbol: "DXY", value: -0.3, label: "-0.3%" },
  ]);
  assert.deepEqual(model.reactionWindow, {
    start: "2026-08-21T12:29:00.000Z",
    end: "2026-08-21T12:45:00.000Z",
    label: "12:29–12:45 UTC",
    providers: ["Coinbase Exchange"],
  });
  assert.deepEqual(model.footer.sources, ["BLS", "Coinbase Exchange"]);
});

test("data update normalizes all three explicit tape verdicts", () => {
  assert.equal(buildDataUpdatePosterModel({ tapeStatus: "confirmed" }).verdictStatus, "CONFIRMED");
  assert.equal(buildDataUpdatePosterModel({ tapeStatus: "divergent" }).verdictStatus, "DIVERGENT");
  assert.equal(buildDataUpdatePosterModel({ tapeStatus: "awaiting confirmation" }).verdictStatus, "AWAITING CONFIRMATION");
  assert.equal(buildDataUpdatePosterModel({ tapeStatus: "unsupported" }).verdictStatus, "AWAITING CONFIRMATION");
});

test("data update caps confirmation and invalidation without hiding numerical conditions", () => {
  const model = buildDataUpdatePosterModel({
    confirmation: `${"Confirmation requires sustained cross-asset breadth and liquid-session follow-through ".repeat(4)}while BTC holds $71,000 and DXY remains below 103.5.`,
    invalidation: `${"Invalidation requires a decisive reversal through the measured pre-release range ".repeat(4)}if BTC loses $69,500 or yields rise 25 bps.`,
  });

  assert.ok(model.confirmation.length <= 120);
  assert.ok(model.invalidation.length <= 120);
  assert.match(model.confirmation, /\$71,000/u);
  assert.match(model.confirmation, /103\.5/u);
  assert.match(model.invalidation, /\$69,500/u);
  assert.match(model.invalidation, /25 bps/u);
  assert.doesNotMatch(model.confirmation, /\p{L}…\p{L}/u);
  assert.doesNotMatch(model.invalidation, /\p{L}…\p{L}/u);
});

test("crypto poster keeps the highest-ranked stories and shared footer metadata", () => {
  const model = buildCryptoDailyPosterModel({
    generatedAt: "2026-08-20T10:00:00.000Z",
    selectedStories: [
      { title: "Policy decision", marketImpact: { score: 94 }, source: { label: "SEC" } },
      { title: "Liquidity shift", marketImpact: { score: 81 }, source: { label: "Coinbase" } },
      { title: "ETF flow", marketImpact: { score: 73 }, source: { label: "Farside" } },
      { title: "Watch item", marketImpact: { score: 55 }, source: { label: "Other" } },
    ],
  });

  assert.equal(model.stories.length, 3);
  assert.deepEqual(model.stories.map((story) => story.score), [94, 81, 73]);
  assert.deepEqual(model.footer.sources, ["SEC", "Coinbase", "Farside"]);
});

test("crypto poster retains concise trading headlines and decision-ready lanes", () => {
  const model = buildCryptoDailyPosterModel({
    selectedStories: [
      {
        title: "Bitcoin breaks out of six-week range, tops $71,000 as $3 billion in shorts get wiped out",
        impact: "Bearish",
        rationale: "The ruling raises the cost of market access.",
        affectedAssets: ["BTC", "ETH"],
        source: { label: "SEC" },
        marketImpact: { score: 94 },
      },
      { title: "Banking Regulator Races to Finalize GENIUS Act Stablecoin Rules" },
      { title: "Live updates: Bitcoin jumps above $72,000, ETFs draw $700 million" },
    ],
  });

  assert.deepEqual(model.stories.map((story) => story.title), [
    "BTC clears $71K; $3B shorts liquidated",
    "GENIUS Act stablecoin rules near finalization",
    "BTC holds above $72K; ETF inflows reach $700M",
  ]);
  assert.equal(model.primaryBias, "BEARISH");
  assert.equal(model.stories[0].source, "SEC");
  assert.equal(model.stories[0].affected, "BTC · ETH");
  assert.equal(model.stories[0].thesis, "The ruling raises the cost of market access.");
});
