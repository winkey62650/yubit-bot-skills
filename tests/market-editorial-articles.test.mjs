import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDataUpdateArticle,
  buildDataUpdateCommunityDocument,
  buildSecondaryDataUpdateCommunityDocument,
  buildWeeklyCalendarArticle,
  buildWeeklyCalendarCommunityDocument,
  dataUpdatePublicationKey,
  weeklyCalendarPublicationKey,
} from "../lib/market-editorial-articles.mjs";
import {
  buildDataReleaseDocument,
  buildWeeklyCalendarDocument,
  renderTelegramMarketDocument,
} from "../lib/market-content-templates.mjs";

const weekNow = new Date("2026-08-19T08:00:00.000Z");

function provenance(value, sourceId, sourceUrl, overrides = {}) {
  return {
    value,
    rawValue: value,
    unit: value?.endsWith?.("%") ? "%" : null,
    status: "verified",
    authority: "official",
    sourceId,
    sourceUrl,
    retrievedAt: "2026-08-19T07:00:00.000Z",
    publishedAt: "2026-08-19T06:55:00.000Z",
    comparisons: [],
    ...overrides,
  };
}

function calendarEvent(overrides = {}) {
  return {
    id: "us-cpi",
    title: "US CPI YoY",
    indicator: "cpi",
    country: "US",
    importance: 3,
    impactScore: 92,
    scheduledAt: "2026-08-19T12:30:00.000Z",
    schedule: provenance("2026-08-19T12:30:00.000Z", "bls-calendar", "https://www.bls.gov/schedule/news_release/cpi.htm", { unit: null }),
    values: {
      forecast: provenance("2.8%", "tradingview-calendar", "https://www.tradingview.com/economic-calendar/", { authority: "auxiliary" }),
      previous: provenance("2.9%", "bls-cpi", "https://www.bls.gov/news.release/cpi.nr0.htm"),
    },
    source: { id: "bls-calendar", label: "BLS", kind: "official", url: "https://www.bls.gov/schedule/news_release/cpi.htm" },
    ...overrides,
  };
}

function weeklyFixture() {
  const events = [
    calendarEvent(),
    calendarEvent({ id: "fomc", title: "FOMC Rate Decision", indicator: "fomc-rate-decision", impactScore: 99, scheduledAt: "2026-08-21T18:00:00.000Z" }),
    calendarEvent({ id: "nfp", title: "US Nonfarm Payrolls", indicator: "nonfarm-payrolls", impactScore: 95, scheduledAt: "2026-08-17T12:30:00.000Z" }),
    calendarEvent({ id: "gdp", title: "US GDP", indicator: "gdp", impactScore: 81, scheduledAt: "2026-08-20T12:30:00.000Z" }),
    calendarEvent({ id: "claims", title: "US Initial Jobless Claims", indicator: "initial-jobless-claims", impactScore: 72, scheduledAt: "2026-08-20T13:30:00.000Z" }),
  ];
  return {
    events,
    document: buildWeeklyCalendarDocument({ now: weekNow, events }),
  };
}

const sourceManifest = [
  { id: "bls-calendar", label: "BLS", type: "official", url: "https://www.bls.gov/schedule/news_release/cpi.htm", retrievedAt: "2026-08-19T07:00:00.000Z", status: "verified" },
  { id: "tradingview-calendar", label: "TradingView Calendar", type: "auxiliary", url: "https://www.tradingview.com/economic-calendar/", retrievedAt: "2026-08-19T07:01:00.000Z", status: "verified" },
];

test("durable editorial publication keys enforce canonical slugs", () => {
  assert.equal(weeklyCalendarPublicationKey("2026-W34"), "market-editorial-v1:weekly-calendar:2026-W34");
  assert.equal(weeklyCalendarPublicationKey("2020-W53"), "market-editorial-v1:weekly-calendar:2020-W53");
  assert.equal(dataUpdatePublicationKey("us-cpi", "2026-08-12"), "market-editorial-v1:data-update:us-cpi:2026-08-12");
  assert.throws(() => weeklyCalendarPublicationKey("2026-34"), /ISO week/i);
  assert.throws(() => weeklyCalendarPublicationKey("2021-W53"), /ISO week/i);
  assert.throws(() => dataUpdatePublicationKey("US CPI!", "12-08-2026"), /canonical/i);
});

test("Weekly Calendar validates a canonical Monday-to-Sunday publication identity", () => {
  const { document, events } = weeklyFixture();
  const build = (overrides) => buildWeeklyCalendarArticle({
    document: { ...document, ...overrides },
    rankedEvents: events,
    sourceManifest,
    marketSetup: { summary: "Liquidity remains selective.", observedAt: "2026-08-19T07:30:00.000Z" },
  });

  assert.throws(() => build({ weekStart: "2026-08-18" }), /Monday/i);
  assert.throws(() => build({ weekEnd: "2026-08-24" }), /Sunday|seven-day/i);
  assert.throws(() => build({ weekEnd: "2026-08-30" }), /seven-day/i);
  assert.throws(() => build({ slug: "2026-W35" }), /slug.*range|identity/i);
  assert.throws(() => build({ slug: "" }), /slug.*canonical|ISO week/i);
});

test("Weekly Calendar impact ranking ignores blank scores, is deterministic, and does not mutate input", () => {
  const { document } = weeklyFixture();
  const tied = [
    calendarEvent({ id: "same", title: "Zulu decision", jurisdiction: "US", marketImpact: { score: null }, impactScore: 120 }),
    calendarEvent({ id: "same", title: "Alpha decision", jurisdiction: "UK", marketImpact: { score: "" }, impactScore: 110 }),
    calendarEvent({ id: "same", title: "Alpha decision", jurisdiction: "CA", marketImpact: { score: 90 }, impactScore: 10 }),
    calendarEvent({ id: "same", title: "Zulu decision", jurisdiction: "US", marketImpact: { score: 90 }, impactScore: 10 }),
    calendarEvent({ id: "same", title: "Middle decision", jurisdiction: "US", marketImpact: { score: 90 }, impactScore: 10 }),
  ];
  const before = structuredClone(tied);
  const build = (rankedEvents) => buildWeeklyCalendarArticle({
    document,
    rankedEvents,
    sourceManifest,
    marketSetup: { summary: "Liquidity remains selective.", observedAt: "2026-08-19T07:30:00.000Z" },
  });

  const forward = build(tied);
  const reverse = build([...tied].reverse());
  assert.deepEqual(tied, before);
  assert.deepEqual(forward.impactRankedEvents, reverse.impactRankedEvents);
  assert.deepEqual(forward.impactRankedEvents.slice(0, 2).map((event) => event.impactScore), [120, 110]);
  assert.deepEqual(
    forward.impactRankedEvents.slice(2).map(({ title, jurisdiction }) => [title, jurisdiction]),
    [["Alpha decision", "CA"], ["Middle decision", "US"], ["Zulu decision", "US"]],
  );
});

test("Weekly Calendar preserves provenance for a numeric zero forecast", () => {
  const { document, events } = weeklyFixture();
  events[0].values.forecast = 0;
  events[0].provenance = {
    forecast: provenance(0, "tradingview-calendar", "https://www.tradingview.com/economic-calendar/", { authority: "auxiliary" }),
  };
  const article = buildWeeklyCalendarArticle({ document, rankedEvents: events, sourceManifest });
  const cpi = article.impactRankedEvents.find((event) => event.id === "us-cpi");

  assert.equal(cpi.values.forecast, 0);
  assert.equal(cpi.fieldProvenance.forecast.sourceId, "tradingview-calendar");
});

test("Weekly Calendar article is a complete impact-ranked risk playbook", () => {
  const { document, events } = weeklyFixture();
  const article = buildWeeklyCalendarArticle({
    document,
    rankedEvents: events,
    sourceManifest,
    marketSetup: { summary: "BTC enters the week above its six-week range.", observedAt: "2026-08-19T07:30:00.000Z" },
  });

  assert.equal(article.slug, "2026-W34");
  assert.equal(article.coreView.split(/[.!?](?:\s|$)/).filter(Boolean).length, 1);
  assert.deepEqual(article.priorityEvents.map((event) => event.id), ["fomc", "nfp", "us-cpi"]);
  assert.equal(article.priorityEvents.length, 3);
  assert.equal(article.impactRankedEvents.length, 5, "the article keeps the full eligible event table");
  for (const event of article.priorityEvents) {
    assert.match(event.utcTime, /Z$/);
    assert.ok(event.jurisdiction);
    assert.ok(event.whyItMatters);
    assert.ok(event.transmissionPath);
    assert.ok(event.affectedAssets.length >= 1);
    assert.ok(event.fieldProvenance.schedule.sourceId);
    assert.ok(event.fieldProvenance.schedule.sourceUrl.startsWith("https://"));
  }
  assert.ok(article.marketSetup.summary && article.marketSetup.observedAt);
  assert.ok(article.tierOneAnalysis.length >= 3);
  assert.deepEqual(article.scenarios.map((scenario) => scenario.id), ["base", "strengthening", "invalidation"]);
  assert.ok(article.dailyWatchlist.length >= 1);
  assert.ok(article.sources.every((source) => source.url.startsWith("https://")));
  assert.ok(article.limitations.length >= 1);
  assert.match(article.disclaimer, /informational|not investment advice/i);
});

test("Weekly Calendar rejects a multi-sentence core view instead of rewriting editorial facts", () => {
  const { document, events } = weeklyFixture();
  document.coreView = "Liquidity remains selective. Confirmation still depends on rates and DXY.";

  assert.throws(
    () => buildWeeklyCalendarArticle({
      document,
      rankedEvents: events,
      sourceManifest,
      marketSetup: { summary: "Liquidity remains selective.", observedAt: "2026-08-19T07:30:00.000Z" },
    }),
    /core view.*one sentence/i,
  );

  document.coreView = "Liquidity remains selective!Confirmation still depends on rates and DXY.";
  assert.throws(
    () => buildWeeklyCalendarArticle({
      document,
      rankedEvents: events,
      sourceManifest,
      marketSetup: { summary: "Liquidity remains selective.", observedAt: "2026-08-19T07:30:00.000Z" },
    }),
    /core view.*one sentence/i,
  );

  for (const coreView of [
    "The catalyst is in the U.S. Confirmation still depends on rates.",
    "The catalyst is in the U.K.Confirmation still depends on rates.",
    "Risk is concentrated around the U.S. BTC confirms the move.",
  ]) {
    document.coreView = coreView;
    assert.throws(
      () => buildWeeklyCalendarArticle({
        document,
        rankedEvents: events,
        sourceManifest,
        marketSetup: { summary: "Liquidity remains selective.", observedAt: "2026-08-19T07:30:00.000Z" },
      }),
      /core view.*one sentence/i,
    );
  }
});

test("Weekly Calendar preserves common dotted abbreviations inside a single-sentence core view", () => {
  const examples = [
    "U.S. CPI is the central catalyst while confirmation depends on rates.",
    "U.K. labour data is the central catalyst while confirmation depends on sterling.",
    "Real yields remain restrictive, e.g. when inflation expectations lag nominal rates.",
    "U.S. Treasury yields remain the central confirmation signal.",
    "U.S. 10-year yields remain the central confirmation signal.",
    "The U.S. Treasury curve remains the central confirmation signal.",
    "U.S. dollar liquidity remains the central confirmation signal.",
    "Inflation at 3.2% remains the central catalyst while BTC holds $71.5K vs. its prior range.",
    "The actual was 3.2% vs. a 3.0% forecast while BTC held $71.5K.",
  ];

  for (const coreView of examples) {
    const { document, events } = weeklyFixture();
    document.coreView = coreView;
    const article = buildWeeklyCalendarArticle({
      document,
      rankedEvents: events,
      sourceManifest,
      marketSetup: { summary: "Liquidity remains selective.", observedAt: "2026-08-19T07:30:00.000Z" },
    });

    assert.equal(article.coreView, coreView);
  }
});

test("Weekly Calendar community document follows the approved English gateway and one HTTPS link", () => {
  const { document, events } = weeklyFixture();
  const article = buildWeeklyCalendarArticle({ document, rankedEvents: events, sourceManifest, marketSetup: { summary: "Liquidity remains selective.", observedAt: "2026-08-19T07:30:00.000Z" } });
  const url = "https://academy.yubit.com/market-calendar/2026-W34";
  const community = buildWeeklyCalendarCommunityDocument(article, { articleUrl: url });
  const telegram = renderTelegramMarketDocument(community);

  assert.equal(community.articleUrl, url);
  assert.equal(community.nodes.filter((node) => node.type === "link").length, 1);
  assert.match(telegram, /Weekly Market Calendar/);
  assert.match(community.title, /Aug 17, 2026 – Aug 23, 2026/);
  assert.doesNotMatch(community.title, /2026-W34/);
  assert.match(community.nodes[0].text, /Aug 17, 2026 – Aug 23, 2026/);
  assert.match(telegram, /Core view:/);
  assert.match(telegram, /The three events that matter most/);
  assert.equal(community.nodes.filter((node) => node.type === "paragraph" && /^\d\. /.test(node.text)).length, 3);
  assert.match(telegram, /Confirmation:/);
  assert.match(telegram, /Invalidation:/);
  assert.match(telegram, /https:\/\/academy\.yubit\.com\/market-calendar\/2026-W34/);
  assert.throws(() => buildWeeklyCalendarCommunityDocument(article, { articleUrl: "/market-calendar/2026-W34" }), /absolute HTTPS/i);
});

function releaseEvent({ forecast = "2.9%" } = {}) {
  return {
    id: "us-cpi",
    slug: "us-cpi",
    title: "US CPI",
    jurisdiction: "US",
    indicator: "cpi",
    releasedAt: "2026-08-12T12:30:00.000Z",
    values: { actual: "3.0%", ...(forecast === null ? {} : { forecast }), previous: "2.8%" },
    provenance: {
      actual: provenance("3.0%", "bls-cpi", "https://www.bls.gov/news.release/cpi.nr0.htm"),
      ...(forecast === null ? {} : { forecast: provenance(forecast, "nasdaq-calendar", "https://www.nasdaq.com/market-activity/economic-calendar", { authority: "auxiliary" }) }),
      previous: provenance("2.8%", "bls-cpi", "https://www.bls.gov/news.release/cpi.nr0.htm"),
    },
    source: { id: "bls-cpi", label: "BLS", kind: "official", url: "https://www.bls.gov/news.release/cpi.nr0.htm" },
  };
}

function reaction() {
  return {
    window: { start: "2026-08-12T12:29:00.000Z", end: "2026-08-12T12:45:00.000Z" },
    prices: {
      BTC: { changePercent: -1.2, provider: "binance", source: "Binance", sourceUrl: "https://api.binance.com/api/v3/ticker/24hr" },
      ETH: { changePercent: -1.6, provider: "okx", source: "OKX", sourceUrl: "https://www.okx.com/api/v5/market/ticker" },
      DXY: { changePercent: 0.35, provider: "dxy-yahoo-finance", source: "Yahoo Finance", sourceUrl: "https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB" },
    },
  };
}

test("tier-one Data Update separates facts, observation and labelled inference", () => {
  const event = releaseEvent();
  const marketReaction = reaction();
  const document = buildDataReleaseDocument({ event, reaction: marketReaction });
  const article = buildDataUpdateArticle({
    document,
    event,
    reaction: marketReaction,
    tierDecision: { tier: "tier-one", decision: "tier-one", score: 94, reasons: ["policySystemic"] },
    sourceManifest,
  });

  assert.equal(article.slug, "us-cpi/2026-08-12");
  assert.equal(article.verdict, "Confirmed");
  assert.ok(article.facts.actual);
  assert.ok(article.facts.forecast);
  assert.ok(article.facts.previous);
  assert.equal(article.facts.provenance.actual.authority, "official");
  assert.ok(article.facts.provenance.actual.sourceUrl.startsWith("https://"));
  assert.ok(article.facts.provenance.forecast.sourceUrl.startsWith("https://"));
  assert.match(article.dataSignal.label, /Inference/i);
  assert.match(article.marketConfirmation.label, /Observed/i);
  assert.doesNotMatch(article.marketConfirmation.summary, /caused|because of/i);
  assert.deepEqual(article.reactionWindow, {
    start: "2026-08-12T12:29:00.000Z",
    end: "2026-08-12T12:45:00.000Z",
    providers: ["Binance", "OKX", "Yahoo Finance"],
  });
  assert.ok(article.scenarioAnalysis.length >= 3);
  assert.ok(article.watchNext.length >= 1);
  assert.ok(article.invalidation);
  assert.ok(article.sources.length >= 1);
  assert.ok(article.limitations.length >= 1);
  assert.match(article.disclaimer, /informational|not investment advice/i);
});

test("Data Update excludes anonymous observations from providers and tape confirmation", () => {
  const event = releaseEvent();
  const marketReaction = {
    window: reaction().window,
    prices: {
      BTC: { changePercent: -1.2, provider: "binance", source: "Binance", sourceUrl: "https://api.binance.com/api/v3/ticker/24hr" },
      ETH: { changePercent: -1.6 },
      DXY: { changePercent: 0.35 },
    },
  };
  const document = buildDataReleaseDocument({ event, reaction: marketReaction });
  const article = buildDataUpdateArticle({
    document,
    event,
    reaction: marketReaction,
    tierDecision: { tier: "tier-one", decision: "tier-one", score: 90, reasons: [] },
    sourceManifest,
  });

  assert.equal(article.verdict, "Awaiting Confirmation");
  assert.deepEqual(article.reactionWindow.providers, ["Binance"]);
  assert.deepEqual(article.marketConfirmation.observations.map(({ symbol }) => symbol), ["BTC"]);
  assert.doesNotMatch(article.marketConfirmation.summary, /ETH|DXY/);
});

test("Data Update excludes observations without an HTTPS provider source and normalizes provider names", () => {
  const event = releaseEvent();
  const marketReaction = {
    window: reaction().window,
    prices: {
      BTC: { changePercent: -1.2, provider: "binance", source: "BINANCE", sourceUrl: "https://api.binance.com/api/v3/ticker/24hr" },
      ETH: { changePercent: -1.6, provider: "binance", source: " binance ", sourceUrl: "https://api.binance.com/api/v3/ticker/price" },
      DXY: { changePercent: 0.35, provider: "yahoo", source: "Yahoo Finance", sourceUrl: "http://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB" },
    },
  };
  const document = buildDataReleaseDocument({ event, reaction: marketReaction });
  const article = buildDataUpdateArticle({
    document,
    event,
    reaction: marketReaction,
    tierDecision: { tier: "tier-one", decision: "tier-one", score: 90, reasons: [] },
    sourceManifest,
  });

  assert.equal(article.verdict, "Confirmed");
  assert.deepEqual(article.reactionWindow.providers, ["Binance"]);
  assert.deepEqual(article.marketConfirmation.observations.map(({ symbol }) => symbol), ["BTC", "ETH"]);
  assert.ok(article.marketConfirmation.observations.every((record) => record.sourceUrl.startsWith("https://")));
  assert.doesNotMatch(article.marketConfirmation.summary, /DXY/);
});

test("Data Update rejects a reaction window with no named market provider", () => {
  const event = releaseEvent();
  const marketReaction = {
    window: reaction().window,
    prices: {
      BTC: { changePercent: -1.2 },
      ETH: { changePercent: -1.6 },
    },
  };
  const document = buildDataReleaseDocument({ event, reaction: marketReaction });

  assert.throws(
    () => buildDataUpdateArticle({
      document,
      event,
      reaction: marketReaction,
      tierDecision: { tier: "tier-one", decision: "tier-one", score: 90, reasons: [] },
      sourceManifest,
    }),
    /named market provider/i,
  );
});

test("tier-one Data Update omits forecast and surprise claims when forecast is unavailable", () => {
  const event = releaseEvent({ forecast: null });
  const marketReaction = reaction();
  const document = buildDataReleaseDocument({ event, reaction: marketReaction });
  const article = buildDataUpdateArticle({
    document,
    event,
    reaction: marketReaction,
    tierDecision: { tier: "tier-one", decision: "tier-one", score: 90, reasons: [] },
    sourceManifest,
  });
  const community = buildDataUpdateCommunityDocument(article, { articleUrl: "https://academy.yubit.com/data-updates/us-cpi/2026-08-12" });
  const serialized = JSON.stringify({ article, community });

  assert.equal(article.facts.forecast, undefined);
  assert.equal(article.facts.surprise, undefined);
  assert.equal(article.facts.provenance.forecast, undefined);
  assert.doesNotMatch(serialized, /forecast|expected|surprise/i);
  assert.ok(community.nodes.some((node) => node.type === "metric" && node.label === "Actual" && node.value === "3.0%"));
  assert.ok(community.nodes.some((node) => node.type === "metric" && node.label === "Previous" && node.value === "2.8%"));
  assert.ok(community.nodes.some((node) => node.type === "paragraph" && node.text.startsWith("Time-bounded market reaction:")));
});

test("Data Update community separates facts, surprise direction and the bounded market reaction", () => {
  const event = releaseEvent();
  const marketReaction = reaction();
  const document = buildDataReleaseDocument({ event, reaction: marketReaction });
  const article = buildDataUpdateArticle({
    document,
    event,
    reaction: marketReaction,
    tierDecision: { tier: "tier-one", decision: "tier-one", score: 94, reasons: [] },
    sourceManifest,
  });
  const community = buildDataUpdateCommunityDocument(article, { articleUrl: "https://academy.yubit.com/data-updates/us-cpi/2026-08-12" });
  const whatChanged = community.nodes.slice(
    community.nodes.findIndex((node) => node.type === "heading" && node.text === "What changed") + 1,
    community.nodes.findIndex((node) => node.type === "paragraph" && node.text.startsWith("Confirmation:")),
  );

  assert.deepEqual(
    whatChanged.map((node) => node.label ?? node.text.split(":", 1)[0]),
    ["Actual vs forecast", "Previous", "Surprise", "Time-bounded market reaction"],
  );
  assert.equal(whatChanged[0].value, "3.0% vs 2.9%");
  assert.equal(whatChanged[1].value, "2.8%");
  assert.match(whatChanged[2].value, /^\+0\.1pp · Above forecast$/);
  assert.match(whatChanged[3].text, /2026-08-12T12:29:00\.000Z to 2026-08-12T12:45:00\.000Z/);
});

test("Data Update computes unit-aware surprises without comparing incompatible magnitudes", () => {
  const cases = [
    { actual: "300K", forecast: "250K", expected: "+50K", direction: "Above forecast" },
    { actual: "300K", forecast: "0.25M", expected: "+50K", direction: "Above forecast" },
    { actual: "3.0%", forecast: "2.9%", expected: "+0.1pp", direction: "Above forecast" },
  ];

  for (const example of cases) {
    const event = releaseEvent({ forecast: example.forecast });
    event.indicator = "nonfarm-payrolls";
    event.title = "US Nonfarm Payrolls";
    event.values.actual = example.actual;
    event.provenance.actual = provenance(example.actual, "bls-nfp", "https://www.bls.gov/news.release/empsit.nr0.htm");
    const marketReaction = reaction();
    const document = buildDataReleaseDocument({ event, reaction: marketReaction });
    const article = buildDataUpdateArticle({ document, event, reaction: marketReaction, tierDecision: { tier: "tier-one" }, sourceManifest });
    const community = buildDataUpdateCommunityDocument(article, { articleUrl: "https://academy.yubit.com/data-updates/us-nfp/2026-08-12" });
    const surprise = community.nodes.find((node) => node.type === "metric" && node.label === "Surprise");

    assert.equal(article.facts.surprise, example.expected);
    assert.equal(surprise.value, `${example.expected} · ${example.direction}`);
  }

  const incompatible = releaseEvent({ forecast: "2.9%" });
  incompatible.values.actual = "300K";
  incompatible.provenance.actual = provenance("300K", "bls-nfp", "https://www.bls.gov/news.release/empsit.nr0.htm");
  const marketReaction = reaction();
  const document = buildDataReleaseDocument({ event: incompatible, reaction: marketReaction });
  const article = buildDataUpdateArticle({ document, event: incompatible, reaction: marketReaction, tierDecision: { tier: "tier-one" }, sourceManifest });
  const community = buildDataUpdateCommunityDocument(article, { articleUrl: "https://academy.yubit.com/data-updates/us-cpi/2026-08-12" });

  assert.equal(article.facts.surprise, undefined);
  assert.equal(community.nodes.some((node) => node.type === "metric" && node.label === "Surprise"), false);
});

test("Data Update community routes tier-one to one HTTPS article and secondary to no article", () => {
  const event = releaseEvent();
  const marketReaction = reaction();
  const document = buildDataReleaseDocument({ event, reaction: marketReaction });
  const tierDecision = { tier: "tier-one", decision: "tier-one", score: 94, reasons: ["policySystemic"] };
  const article = buildDataUpdateArticle({ document, event, reaction: marketReaction, tierDecision, sourceManifest });
  const articleUrl = "https://academy.yubit.com/data-updates/us-cpi/2026-08-12";
  const tierOne = buildDataUpdateCommunityDocument(article, { articleUrl });
  const secondary = buildSecondaryDataUpdateCommunityDocument({
    document,
    event,
    reaction: marketReaction,
    tierDecision: { tier: "secondary", decision: "not-promoted", score: 48, reasons: [] },
  });

  assert.equal(tierOne.articleUrl, articleUrl);
  assert.equal(tierOne.nodes.filter((node) => node.type === "link").length, 1);
  assert.equal(secondary.articleUrl, undefined);
  assert.equal(secondary.nodes.filter((node) => node.type === "link").length, 0);
  assert.doesNotMatch(JSON.stringify(secondary), /Read (?:more|the full analysis)|https:\/\/academy/i);
  assert.throws(() => buildDataUpdateCommunityDocument(article, { articleUrl: "http://academy.yubit.com/data-updates/us-cpi/2026-08-12" }), /absolute HTTPS/i);
  assert.throws(
    () => buildDataUpdateCommunityDocument({ ...article, tierDecision: { tier: "secondary" } }, { articleUrl }),
    /tier-one/i,
  );
  assert.throws(
    () => buildDataUpdateCommunityDocument({ ...article, tierDecision: {} }, { articleUrl }),
    /tier-one/i,
  );
  assert.throws(
    () => buildSecondaryDataUpdateCommunityDocument({ document, event, reaction: marketReaction, tierDecision: { tier: "tier-one" } }),
    /secondary/i,
  );
  assert.throws(
    () => buildSecondaryDataUpdateCommunityDocument({ document, event, reaction: marketReaction }),
    /secondary/i,
  );
});

test("Task5 community builders fit Telegram's 4096-character limit without losing the link or disclaimer", () => {
  const { document: weeklyDocument, events } = weeklyFixture();
  const weeklyArticle = buildWeeklyCalendarArticle({ document: weeklyDocument, rankedEvents: events, sourceManifest });
  weeklyArticle.coreView = `A ${"high-conviction ".repeat(400)}weekly view.`;
  weeklyArticle.priorityEvents = weeklyArticle.priorityEvents.map((event) => ({
    ...event,
    whyItMatters: `${event.whyItMatters} ${"context ".repeat(400)}`,
    transmissionPath: `${event.transmissionPath} ${"transmission ".repeat(400)}`,
  }));
  const weeklyCommunity = buildWeeklyCalendarCommunityDocument(weeklyArticle, { articleUrl: "https://academy.yubit.com/market-calendar/2026-W34" });
  const weeklyTelegram = renderTelegramMarketDocument(weeklyCommunity);

  assert.ok(weeklyTelegram.length <= 4096);
  assert.equal(weeklyCommunity.nodes.filter((node) => node.type === "link").length, 1);
  assert.equal((weeklyTelegram.match(/<a href=/g) ?? []).length, 1);
  assert.match(weeklyTelegram, /FOMC Rate Decision/);
  assert.match(weeklyTelegram, /not investment advice/i);
  assert.match(weeklyTelegram, /<a href="https:\/\/academy\.yubit\.com\/market-calendar\/2026-W34">[^<]+<\/a>/);

  const event = releaseEvent();
  const marketReaction = reaction();
  const dataDocument = buildDataReleaseDocument({ event, reaction: marketReaction });
  const dataArticle = buildDataUpdateArticle({ document: dataDocument, event, reaction: marketReaction, tierDecision: { tier: "tier-one" }, sourceManifest });
  dataArticle.dataSignal.summary = `Inference: ${"macro context ".repeat(500)}`;
  dataArticle.marketConfirmation.summary = `Observed: ${"bounded reaction ".repeat(500)}`;
  dataArticle.invalidation = `Invalidation: ${"cross-asset reversal ".repeat(500)}`;
  const dataCommunity = buildDataUpdateCommunityDocument(dataArticle, { articleUrl: "https://academy.yubit.com/data-updates/us-cpi/2026-08-12" });
  const dataTelegram = renderTelegramMarketDocument(dataCommunity);

  assert.ok(dataTelegram.length <= 4096);
  assert.equal(dataCommunity.nodes.filter((node) => node.type === "link").length, 1);
  assert.equal((dataTelegram.match(/<a href=/g) ?? []).length, 1);
  assert.match(dataTelegram, /<b>Actual vs forecast:<\/b> 3\.0% vs 2\.9%/);
  assert.match(dataTelegram, /not investment advice/i);
  assert.match(dataTelegram, /<a href="https:\/\/academy\.yubit\.com\/data-updates\/us-cpi\/2026-08-12">[^<]+<\/a>/);
});

test("Data Update article rejects non-canonical release identity instead of silently normalizing it", () => {
  const event = releaseEvent();
  event.slug = "US CPI";
  const marketReaction = reaction();
  const document = buildDataReleaseDocument({ event, reaction: marketReaction });

  assert.throws(
    () => buildDataUpdateArticle({ document, event, reaction: marketReaction, tierDecision: { tier: "tier-one" }, sourceManifest }),
    /release slug.*canonical/i,
  );

  event.slug = "";
  assert.throws(
    () => buildDataUpdateArticle({ document, event, reaction: marketReaction, tierDecision: { tier: "tier-one" }, sourceManifest }),
    /release slug.*canonical/i,
  );

  delete event.slug;
  event.indicator = "US CPI";
  assert.throws(
    () => buildDataUpdateArticle({ document, event, reaction: marketReaction, tierDecision: { tier: "tier-one" }, sourceManifest }),
    /release slug.*canonical/i,
  );
});

test("Data Update verdicts use only the approved vocabulary", () => {
  const event = releaseEvent();
  const cases = [
    [reaction(), "Confirmed"],
    [{ ...reaction(), prices: { BTC: { changePercent: 1.2, source: "Binance", sourceUrl: "https://api.binance.com/api/v3/ticker/24hr" }, ETH: { changePercent: 1.6, source: "OKX", sourceUrl: "https://www.okx.com/api/v5/market/ticker" }, DXY: { changePercent: -0.35, source: "Yahoo Finance", sourceUrl: "https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB" } } }, "Divergent"],
    [{ window: reaction().window, prices: { BTC: { changePercent: -0.2, source: "Binance", sourceUrl: "https://api.binance.com/api/v3/ticker/24hr" } } }, "Awaiting Confirmation"],
  ];
  for (const [marketReaction, expected] of cases) {
    const document = buildDataReleaseDocument({ event, reaction: marketReaction });
    const article = buildDataUpdateArticle({ document, event, reaction: marketReaction, tierDecision: { tier: "tier-one", decision: "tier-one", score: 90, reasons: [] }, sourceManifest });
    assert.equal(article.verdict, expected);
  }
});
