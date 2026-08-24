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
    paper: "#EEF5F8",
    ink: "#071C32",
    muted: "#60798C",
    red: "#D85757",
    green: "#15936E",
    blue: "#0B5C89",
    cyan: "#16B8E7",
    gold: "#F5B83C",
  },
  masthead: "MARKET INTELLIGENCE / VERIFIED RESEARCH",
};

function assertEditorialTokens(model, { sources, updatedAt }) {
  assert.deepEqual(model.canvas, VISUAL_TOKENS.canvas);
  assert.deepEqual(model.palette, VISUAL_TOKENS.palette);
  assert.equal(model.masthead, VISUAL_TOKENS.masthead);
  assert.deepEqual(model.footer, { sources, timezone: "UTC", updatedAt });
  assert.equal(JSON.stringify(model).includes("jsx"), false);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
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

test("poster caps never split a long word or Unicode grapheme", () => {
  const longWord = "Supercalifragilisticexpialidocious".repeat(4);
  const wordModel = buildDataUpdatePosterModel({ title: longWord });
  assert.equal(wordModel.title, "…", "a token larger than the cap fails closed instead of being split");
  assert.ok(wordModel.title.length <= 72);

  const astronaut = "👩🏽‍🚀";
  const emojiModel = buildDataUpdatePosterModel({ title: astronaut.repeat(30) });
  assert.ok(emojiModel.title.length <= 72);
  assert.match(emojiModel.title, /…$/u);
  const visible = emojiModel.title.slice(0, -1);
  const graphemes = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(visible)]
    .map(({ segment }) => segment);
  assert.ok(graphemes.length > 0);
  assert.ok(graphemes.every((grapheme) => grapheme === astronaut));
});

test("overflow numerical facts stay structured while display strings remain strictly capped", () => {
  const percentages = Array.from({ length: 45 }, (_, index) => `${index + 1}.1%`);
  const bps = Array.from({ length: 45 }, (_, index) => `${index + 1} bps`);
  const weekly = buildWeeklyCalendarPosterModel({
    weekStart: "2026-08-17",
    days: [{
      date: "2026-08-17",
      events: [{
        id: "fact-overflow",
        title: "Fact overflow",
        importance: 3,
        whyItMatters: `Verified ladder ${percentages.join(" ")}`,
      }],
    }],
  });
  const event = weekly.columns[0].events[0];
  assert.ok(event.description.length <= 120);
  assert.deepEqual(event.descriptionFacts, percentages);

  const data = buildDataUpdatePosterModel({
    confirmation: `Confirmation ladder ${percentages.join(" ")}`,
    invalidation: `Invalidation ladder ${bps.join(" ")}`,
  });
  assert.ok(data.confirmation.length <= 120);
  assert.ok(data.invalidation.length <= 120);
  assert.deepEqual(data.confirmationFacts, percentages);
  assert.deepEqual(data.invalidationFacts, bps);
});

test("structured numerical facts preserve a Unicode minus sign", () => {
  const model = buildDataUpdatePosterModel({
    confirmation: `${"Verified cross-asset confirmation context ".repeat(5)}requires a −0.2% threshold.`,
  });

  assert.ok(model.confirmation.length <= 120);
  assert.deepEqual(model.confirmationFacts, ["−0.2%"]);
  assert.match(model.confirmation, /−0\.2%/u);
});

test("fact tokens preserve complete times, ranges, signed currencies, and leading decimals", () => {
  const weeklyText = "At 12:29 UTC, range is 2.7%-2.9% and floor is .5%.";
  const dataText = "BTC holds -$71,000 while drawdown is −0.2%.";
  const cryptoText = "BTC guards $-69,500 and spot growth is 3.0%.";
  const weekly = buildWeeklyCalendarPosterModel({
    weekStart: "2026-08-17",
    days: [{
      date: "2026-08-17",
      events: [{ id: "lexer", title: "Lexer", whyItMatters: weeklyText }],
    }],
  });
  const data = buildDataUpdatePosterModel({ confirmation: dataText });
  const crypto = buildCryptoDailyPosterModel({
    selectedStories: [{ title: "Lexer", rationale: cryptoText, source: { label: "SEC" } }],
  });

  assert.equal(weekly.columns[0].events[0].description, weeklyText);
  assert.deepEqual(weekly.columns[0].events[0].descriptionFacts, ["12:29 UTC", "2.7%-2.9%", ".5%"]);
  assert.equal(data.confirmation, dataText);
  assert.deepEqual(data.confirmationFacts, ["-$71,000", "−0.2%"]);
  assert.equal(crypto.stories[0].thesis, cryptoText);
  assert.deepEqual(crypto.stories[0].thesisFacts, ["$-69,500", "3.0%"]);
});

test("overflow fact lanes stay exact, capped, and immutable in every poster model", () => {
  const facts = ["12:29 UTC", "2.7%-2.9%", ".5%", "-$71,000", "$-69,500", "−0.2%"];
  const expectedDisplay = facts.join(" · ");
  const overflow = `${"UnbreakableContext".repeat(20)} ${facts.join(" ")}`;
  const weeklyInput = deepFreeze({
    weekStart: "2026-08-17",
    days: [{
      date: "2026-08-17",
      events: [{ id: "overflow-lexer", title: "Overflow lexer", whyItMatters: overflow }],
    }],
  });
  const dataInput = deepFreeze({ confirmation: overflow });
  const cryptoInput = deepFreeze({
    selectedStories: [{ title: "Overflow lexer", rationale: overflow, source: { label: "SEC" } }],
  });

  const weekly = buildWeeklyCalendarPosterModel(weeklyInput).columns[0].events[0];
  const data = buildDataUpdatePosterModel(dataInput);
  const crypto = buildCryptoDailyPosterModel(cryptoInput).stories[0];

  assert.equal(weekly.description, expectedDisplay);
  assert.deepEqual(weekly.descriptionFacts, facts);
  assert.ok(weekly.description.length <= 120);
  assert.equal(data.confirmation, expectedDisplay);
  assert.deepEqual(data.confirmationFacts, facts);
  assert.ok(data.confirmation.length <= 120);
  assert.equal(crypto.thesis, expectedDisplay);
  assert.deepEqual(crypto.thesisFacts, facts);
  assert.ok(crypto.thesis.length <= 118);
  assert.match(weeklyInput.days[0].events[0].whyItMatters, /^UnbreakableContext/u);
  assert.match(dataInput.confirmation, /^UnbreakableContext/u);
  assert.match(cryptoInput.selectedStories[0].rationale, /^UnbreakableContext/u);
});

test("weekly priority selection ignores ghosts and highlights three stable event occurrences", () => {
  const model = buildWeeklyCalendarPosterModel({
    weekStart: "2026-08-17",
    priorityEvents: [{ eventId: "ghost" }, { eventId: "duplicate" }],
    days: [{
      date: "2026-08-17",
      events: [
        { id: "duplicate", title: "Duplicate A", time: "12:00", importance: 4 },
        { id: "duplicate", title: "Duplicate B", time: "12:01", importance: 3 },
        { id: "duplicate", title: "Duplicate C", time: "12:02", importance: 2 },
        { id: "visible", title: "Visible", time: "12:03", importance: 1 },
      ],
    }],
  });
  const events = model.columns.flatMap((column) => column.events);
  const highlighted = events.filter((event) => event.isPriority);

  assert.equal(highlighted.length, 3);
  assert.equal(model.priorityEventKeys.length, 3);
  assert.equal(new Set(model.priorityEventKeys).size, 3);
  assert.equal(model.priorityEventIds.includes("ghost"), false);
  assert.equal(new Set(highlighted.map((event) => event.eventKey)).size, 3);
});

test("weekly priorities match Task 5 ids when Task 3 display metadata differs", () => {
  const model = buildWeeklyCalendarPosterModel({
    weekStart: "2026-08-17",
    priorityEvents: [{
      id: "low-priority",
      title: "Task 5 normalized headline",
      utcTime: "2026-08-17T19:30:00.000Z",
    }],
    days: [{
      date: "2026-08-17",
      events: [
        { id: "high-1", title: "High 1", time: "10:00", importance: 5 },
        { id: "high-2", title: "High 2", time: "11:00", importance: 4 },
        { id: "high-3", title: "High 3", time: "12:00", importance: 3 },
        { id: "low-priority", title: "Task 3 display headline", time: "19:30 UTC", importance: 1 },
      ],
    }],
  });

  const highlightedIds = model.columns.flatMap((column) => column.events)
    .filter((event) => event.isPriority)
    .map((event) => event.id);
  assert.deepEqual(highlightedIds, ["high-1", "high-2", "low-priority"]);
});

test("strict numeric parsing rejects placeholders and preserves Unicode minus, zero, and percentages", () => {
  const model = buildDataUpdatePosterModel({
    values: { actual: "−0.2%", forecast: "0%", previous: "N/A" },
    reactions: [
      { symbol: "BTC-USD", changePercent: "−0.4%" },
      { symbol: "ETH", changePercent: "0%" },
      { symbol: "DXY", changePercent: "N/A" },
      { symbol: "SOL", changePercent: "" },
    ],
  });

  assert.equal(model.surprise, "-0.2pp");
  assert.deepEqual(model.reactions, [
    { symbol: "BTC", value: -0.4, label: "−0.4%" },
    { symbol: "ETH", value: 0, label: "0%" },
  ]);
});

test("footer timestamps are canonical UTC instants and invalid timestamps fail closed", () => {
  const canonical = buildDataUpdatePosterModel({ generatedAt: "2026-08-21T20:45:00+08:00" });
  const invalid = buildWeeklyCalendarPosterModel({
    weekStart: "2026-08-17",
    generatedAt: "not-a-timestamp",
  });

  assert.equal(canonical.footer.updatedAt, "2026-08-21T12:45:00.000Z");
  assert.equal(invalid.footer.updatedAt, "");
  assert.equal(invalid.footer.timezone, "UTC");
});

test("reaction windows require two valid ordered UTC instants", () => {
  const partial = buildDataUpdatePosterModel({
    reactionWindow: { start: "2026-08-21T12:29:00.000Z", providers: ["Coinbase"] },
  });
  const invalid = buildDataUpdatePosterModel({
    reactionWindow: { start: "invalid", end: "2026-08-21T12:45:00.000Z" },
  });
  const reversed = buildDataUpdatePosterModel({
    reactionWindow: {
      start: "2026-08-21T12:46:00.000Z",
      end: "2026-08-21T12:45:00.000Z",
    },
  });

  assert.equal(partial.reactionWindow, null);
  assert.equal(invalid.reactionWindow, null);
  assert.equal(reversed.reactionWindow, null);
});

test("weekly models are canonical under same-day input reordering", () => {
  const events = [
    { id: "same", title: "Beta", time: "12:00", importance: 3, source: { label: "Zulu" } },
    { id: "same", title: "Alpha", time: "12:00", importance: 3, source: { label: "Alpha" } },
    { id: "third", title: "Gamma", time: "12:00", importance: 3, source: { label: "Mike" } },
  ];
  const input = {
    weekStart: "2026-08-17",
    generatedAt: "2026-08-16T18:00:00.000Z",
    days: [{ date: "2026-08-17", events }],
  };

  const forward = buildWeeklyCalendarPosterModel(input);
  const reverse = buildWeeklyCalendarPosterModel({
    ...input,
    days: [{ date: "2026-08-17", events: [...events].reverse() }],
  });

  assert.deepEqual(reverse, forward);
  assert.deepEqual(forward.footer.sources, ["Alpha", "Mike", "Zulu"]);
});

test("missing official source never creates false provenance", () => {
  const model = buildDataUpdatePosterModel({ title: "Release without provenance" });

  assert.equal(model.source, "");
  assert.equal(model.officialSource, "");
  assert.deepEqual(model.footer.sources, []);
});

test("crypto stories never fabricate missing provenance and retain stale source labels", () => {
  const model = buildCryptoDailyPosterModel({
    selectedStories: [
      { title: "Unattributed market development" },
      { title: "Archived filing", source: { label: "SEC archive", freshness: "stale" } },
    ],
  });

  assert.equal(model.stories[0].source, "");
  assert.equal(model.stories[0].sourceFooterLabel, "");
  assert.equal(model.stories[0].sourceStatus, "");
  assert.equal(model.stories[1].source, "SEC ARCHIVE");
  assert.equal(model.stories[1].sourceFooterLabel, "SEC archive · STALE SOURCE");
  assert.equal(model.stories[1].sourceStatus, "STALE SOURCE");
  assert.deepEqual(model.footer.sources, ["SEC archive · STALE SOURCE"]);
});

test("poster builders preserve frozen inputs and return isolated JSON-serializable tokens", () => {
  const input = deepFreeze({
    weekStart: "2026-08-17",
    generatedAt: "2026-08-16T18:00:00.000Z",
    days: [{
      date: "2026-08-17",
      events: [{ id: "cpi", title: "US CPI", importance: 3, source: { label: "BLS" } }],
    }],
  });
  const first = buildWeeklyCalendarPosterModel(input);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);

  first.palette.paper = "#000000";
  const second = buildWeeklyCalendarPosterModel(input);
  assert.equal(second.palette.paper, "#EEF5F8");
  assert.equal(input.days[0].events[0].title, "US CPI");
});
