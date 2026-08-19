import assert from "node:assert/strict";
import test from "node:test";
import {
  CRYPTO_DAILY_SECTIONS,
  MARKET_CONTENT_TEMPLATE_VERSION,
  RELEASE_INDICATOR_ALLOWLIST,
  buildCryptoDailyDocument,
  buildDataReleaseDocument,
  buildWeeklyCalendarDocument,
  classifyCryptoStory,
  deduplicateCryptoStories,
  evaluateReleaseImpact,
  rankCryptoStories,
  renderDiscordMarketDocument,
  renderTelegramMarketDocument,
} from "../lib/market-content-templates.mjs";

const now = new Date("2026-08-19T08:00:00.000Z");

function story(overrides = {}) {
  return {
    id: "wire:etf-1",
    title: "US spot Bitcoin ETFs report net inflows",
    summary: "Funds recorded verified net inflows.",
    url: "https://industry.example/bitcoin-etf-inflows",
    publishedAt: "2026-08-19T07:00:00.000Z",
    categories: ["BTC ETF / Institutional"],
    source: { id: "industry", label: "Industry Wire", kind: "industry" },
    impact: "Bullish",
    rationale: "Verified net inflows indicate institutional demand.",
    importance: 3,
    ...overrides,
  };
}

test("exports the exact version, section, and release allowlist contracts", () => {
  assert.equal(MARKET_CONTENT_TEMPLATE_VERSION, "market-content-v1");
  assert.deepEqual(CRYPTO_DAILY_SECTIONS, ["btc-etf-institutional", "regulation", "market-project"]);
  assert.deepEqual(RELEASE_INDICATOR_ALLOWLIST, [
    "cpi", "core-cpi", "pce", "core-pce", "nonfarm-payrolls", "unemployment-rate",
    "average-hourly-earnings", "fomc-rate-decision", "fomc-statement", "gdp", "ppi",
    "retail-sales", "initial-jobless-claims",
  ]);
  assert.ok(Object.isFrozen(CRYPTO_DAILY_SECTIONS));
  assert.ok(Object.isFrozen(RELEASE_INDICATOR_ALLOWLIST));
});

test("classifies stories into only the three approved sections", () => {
  assert.equal(classifyCryptoStory(story()), "btc-etf-institutional");
  assert.equal(classifyCryptoStory(story({ categories: ["Regulation"], title: "SEC decides a Bitcoin ETF matter" })), "regulation");
  assert.equal(classifyCryptoStory(story({ categories: [], title: "SEC files crypto enforcement action" })), "regulation");
  assert.equal(classifyCryptoStory(story({ categories: [], title: "Ethereum ships a major network upgrade" })), "market-project");
  assert.equal(classifyCryptoStory(story({ categories: [], title: "Unrelated sports result" })), null);
});

test("Crypto Daily always has exactly three fixed sections and neutral evidence-free empty states", () => {
  const document = buildCryptoDailyDocument({ now, candidates: [] });

  assert.equal(document.version, MARKET_CONTENT_TEMPLATE_VERSION);
  assert.deepEqual(document.sections.map((section) => section.id), CRYPTO_DAILY_SECTIONS);
  assert.equal(document.sections.length, 3);
  for (const section of document.sections) {
    assert.equal(section.impact, "Neutral");
    assert.ok(section.nodes.some((node) => node.type === "paragraph" && node.text === "No material verified update in the last 24 hours."));
    assert.ok(section.nodes.every((node) => ["heading", "paragraph", "link", "metric", "divider"].includes(node.type)));
  }
  assert.doesNotMatch(JSON.stringify(document), /<a\b|\]\(https?:/);
});

test("deduplication collapses the same story and replaces an industry link with its official source", () => {
  const industry = story({ canonicalId: "sec-etf-order-42" });
  const official = story({
    id: "sec:42",
    canonicalId: "sec-etf-order-42",
    url: "https://www.sec.gov/newsroom/order-42",
    source: { id: "sec", label: "SEC", kind: "official" },
    publishedAt: "2026-08-19T06:30:00.000Z",
  });

  const result = deduplicateCryptoStories([industry, official]);
  assert.equal(result.length, 1);
  assert.equal(result[0].url, official.url);
  assert.equal(result[0].source.kind, "official");
});

test("deduplication fingerprints differently worded reports of the same sourced fact", () => {
  const industry = story({
    id: "wire:ibit-flow",
    canonicalId: undefined,
    title: "BlackRock's Bitcoin ETF draws $250M daily inflow",
    summary: "IBIT saw a $250M net inflow on August 18.",
    url: "https://industry.example/ibit-flow",
  });
  const official = story({
    id: "blackrock:fund-flow",
    canonicalId: undefined,
    title: "iShares Bitcoin Trust publishes August 18 fund flows",
    summary: "BlackRock IBIT recorded net inflows of 250 million dollars for the day.",
    url: "https://blackrock.example/ibit/fund-flows",
    source: { id: "blackrock", label: "BlackRock", kind: "official" },
  });

  const result = deduplicateCryptoStories([official, industry]);
  assert.equal(result.length, 1);
  assert.equal(result[0].url, official.url);
  assert.equal(result[0].source.kind, "official");
});

test("deduplication does not merge similar reports with different amounts or event direction", () => {
  const inflow = story({
    id: "ibit-inflow",
    canonicalId: undefined,
    title: "BlackRock IBIT records $250M net inflow",
    summary: "The Bitcoin ETF posted a $250M net inflow.",
  });
  const outflow = story({
    id: "ibit-outflow",
    canonicalId: undefined,
    title: "BlackRock IBIT records $120M net outflow",
    summary: "The Bitcoin ETF posted a $120M net outflow.",
    url: "https://industry.example/ibit-outflow",
  });

  assert.equal(deduplicateCryptoStories([inflow, outflow]).length, 2);
});

test("deduplication does not merge the same entities and action when the event objects differ", () => {
  const etfFiling = story({
    id: "sec-etf-filing",
    canonicalId: undefined,
    title: "SEC approves BlackRock Bitcoin ETF filing",
    summary: "The regulator approved BlackRock's spot ETF filing.",
  });
  const custodyLicense = story({
    id: "sec-custody-license",
    canonicalId: undefined,
    title: "SEC approves BlackRock crypto custody license",
    summary: "The regulator approved BlackRock's custody license.",
    url: "https://industry.example/blackrock-custody-license",
  });

  assert.equal(deduplicateCryptoStories([etfFiling, custodyLicense]).length, 2);
});

test("ranking is deterministic and independent of candidate input order", () => {
  const official = story({ id: "official", title: "Official ETF filing", url: "https://sec.gov/official", source: { id: "sec", kind: "official", label: "SEC" }, importance: 2 });
  const recent = story({ id: "recent", title: "Recent ETF report", url: "https://wire.example/recent", publishedAt: "2026-08-19T07:59:00Z", importance: 2 });
  const important = story({ id: "important", title: "Large ETF allocation", url: "https://wire.example/important", importance: 5 });
  const left = rankCryptoStories([recent, important, official], now).map((item) => item.id);
  const right = rankCryptoStories([official, recent, important], now).map((item) => item.id);
  assert.deepEqual(left, right);
  assert.deepEqual(left, ["official", "important", "recent"]);
});

test("ranking considers explicit event impact before freshness", () => {
  const lowImpact = story({ id: "low-impact", title: "A low impact ETF update", impactScore: 1, publishedAt: "2026-08-19T07:59:00Z" });
  const highImpact = story({ id: "high-impact", title: "Z high impact ETF update", impactScore: 5, publishedAt: "2026-08-19T07:00:00Z" });

  assert.deepEqual(rankCryptoStories([lowImpact, highImpact], now).map((item) => item.id), ["high-impact", "low-impact"]);
});

test("Crypto Daily selects one traceable story per section and does not reuse another section's story", () => {
  const document = buildCryptoDailyDocument({
    now,
    candidates: [
      story(),
      story({ id: "reg", title: "SEC approves a crypto custody rule", categories: ["Regulation"], url: "https://sec.gov/rule", source: { id: "sec", label: "SEC", kind: "official" }, impact: "Bullish" }),
    ],
  });
  assert.equal(document.sections[0].nodes.filter((node) => node.type === "link").length, 1);
  assert.equal(document.sections[1].nodes.filter((node) => node.type === "link").length, 1);
  assert.equal(document.sections[2].impact, "Neutral");
});

test("Crypto Daily rejects candidates without a valid verifiable publication time", () => {
  for (const publishedAt of [undefined, null, "not-a-date"]) {
    const document = buildCryptoDailyDocument({ now, candidates: [story({ publishedAt })] });
    assert.equal(document.sections[0].impact, "Neutral");
    assert.ok(document.sections[0].nodes.some((node) => node.type === "paragraph" && node.text === "No material verified update in the last 24 hours."));
  }
});

test("weekly calendar covers the current UTC Monday through Sunday, groups by date, and omits missing values", () => {
  const document = buildWeeklyCalendarDocument({
    now,
    events: [
      { id: "cpi", title: "US CPI YoY", indicator: "cpi", country: "US", importance: 3, scheduledAt: "2026-08-19T12:30:00Z", values: { actual: null, forecast: "2.8%", previous: "2.9%" }, source: { label: "BLS", url: "https://bls.gov/cpi" } },
      { id: "date-only", title: "Major policy window", kind: "macro", importance: 3, scheduledAt: null, rawScheduledAt: "2026-08-23", values: { forecast: null }, source: { label: "Agency", url: "https://agency.example/calendar" } },
      { id: "low", title: "Minor survey", importance: 1, scheduledAt: "2026-08-20T10:00:00Z" },
      { id: "outside", title: "US GDP", indicator: "gdp", importance: 3, scheduledAt: "2026-08-24T12:30:00Z" },
    ],
  });

  assert.equal(document.weekStart, "2026-08-17");
  assert.equal(document.weekEnd, "2026-08-23");
  assert.deepEqual(document.days.map((day) => day.date), ["2026-08-19", "2026-08-23"]);
  const timed = document.days[0].events[0];
  assert.equal(timed.time, "12:30");
  assert.ok(timed.nodes.some((node) => node.type === "metric" && node.label === "Forecast"));
  assert.ok(timed.nodes.some((node) => node.type === "metric" && node.label === "Previous"));
  assert.ok(!timed.nodes.some((node) => node.type === "metric" && node.label === "Actual"));
  assert.equal(document.days[1].events[0].time, "TBD");
  assert.doesNotMatch(JSON.stringify(document), /null|undefined/);
});

test("weekly calendar keeps only official crypto events with a source-provided time", () => {
  const document = buildWeeklyCalendarDocument({
    now,
    events: [
      { id: "rumor", title: "Rumored token launch", kind: "crypto", importance: 3, scheduledAt: "2026-08-20T10:00:00Z", source: { label: "Industry Wire", kind: "industry", url: "https://wire.example/rumor" } },
      { id: "date-only", title: "Official protocol date", kind: "crypto", importance: 3, scheduledAt: null, rawScheduledAt: "2026-08-21", source: { label: "Protocol", kind: "official", url: "https://protocol.example/blog" } },
      { id: "official", title: "Official protocol upgrade", kind: "crypto", importance: 3, scheduledAt: "2026-08-22T09:00:00Z", source: { label: "Protocol", kind: "official", url: "https://protocol.example/blog" } },
    ],
  });

  assert.deepEqual(document.days.flatMap((day) => day.events.map((event) => event.id)), ["official"]);
});

test("weekly calendar treats a date-only scheduledAt as TBD while retaining its date group", () => {
  const document = buildWeeklyCalendarDocument({
    now,
    events: [
      { id: "date-only-scheduled", title: "Policy consultation closes", kind: "macro", importance: 3, scheduledAt: "2026-08-20", source: { label: "Agency", url: "https://agency.example/calendar" } },
    ],
  });

  assert.deepEqual(document.days.map((day) => day.date), ["2026-08-20"]);
  assert.equal(document.days[0].events[0].time, "TBD");
  assert.match(document.days[0].events[0].nodes[0].text, /^TBD —/);
  assert.doesNotMatch(renderTelegramMarketDocument(document), /00:00/);
});

test("release impact rules cover inflation, employment, growth, and FOMC deterministically", () => {
  assert.equal(evaluateReleaseImpact({ indicator: "cpi", values: { actual: "2.7%", forecast: "2.8%" } }).impact, "Bullish");
  assert.equal(evaluateReleaseImpact({ indicator: "core-pce", values: { actual: "3.1%", forecast: "3.0%" } }).impact, "Bearish");
  assert.equal(evaluateReleaseImpact({ indicator: "nonfarm-payrolls", values: { actual: "160K", forecast: "200K" } }).impact, "Bullish");
  assert.equal(evaluateReleaseImpact({ indicator: "unemployment-rate", values: { actual: "4.1%", forecast: "4.0%" } }).impact, "Bullish");
  assert.equal(evaluateReleaseImpact({ indicator: "gdp", values: { actual: "2.5%", forecast: "2.1%" } }).impact, "Bullish");
  assert.equal(evaluateReleaseImpact({ indicator: "retail-sales", values: { actual: "-0.2%", forecast: "0.1%" } }).impact, "Bearish");
  assert.equal(evaluateReleaseImpact({ indicator: "fomc-rate-decision", values: { actual: "4.75%", forecast: "5.00%" } }).impact, "Bullish");
  assert.equal(evaluateReleaseImpact({ indicator: "fomc-statement", statementTone: "hawkish" }).impact, "Bearish");
});

test("conflicting employment signals and unknown or incomplete releases fall back to Neutral", () => {
  const conflicting = evaluateReleaseImpact({
    indicator: "nonfarm-payrolls",
    components: [
      { indicator: "nonfarm-payrolls", values: { actual: "250K", forecast: "200K" } },
      { indicator: "unemployment-rate", values: { actual: "4.2%", forecast: "4.0%" } },
    ],
  });
  assert.equal(conflicting.impact, "Neutral");
  assert.equal(evaluateReleaseImpact({ indicator: "cpi", values: { actual: "2.7%" } }).impact, "Neutral");
  assert.equal(evaluateReleaseImpact({ indicator: "bitcoin-dominance", values: { actual: "60", forecast: "59" } }).impact, "Neutral");
});

test("multi-component employment releases stay Neutral when any required component lacks evidence", () => {
  const missingUnemploymentForecast = evaluateReleaseImpact({
    components: [
      { indicator: "nonfarm-payrolls", values: { actual: "160K", forecast: "200K" } },
      { indicator: "unemployment-rate", values: { actual: "4.1%" } },
    ],
  });
  const missingPayrollForecast = evaluateReleaseImpact({
    components: [
      { indicator: "nonfarm-payrolls", values: { actual: "160K" } },
      { indicator: "unemployment-rate", values: { actual: "4.1%", forecast: "4.0%" } },
    ],
  });
  const unknownComponent = evaluateReleaseImpact({
    components: [
      { indicator: "nonfarm-payrolls", values: { actual: "160K", forecast: "200K" } },
      { indicator: "labor-force-participation", values: { actual: "62.8%", forecast: "62.7%" } },
    ],
  });

  assert.equal(missingUnemploymentForecast.impact, "Neutral");
  assert.equal(missingPayrollForecast.impact, "Neutral");
  assert.equal(unknownComponent.impact, "Neutral");
});

test("data release documents enforce the allowlist and omit absent values and reactions", () => {
  const document = buildDataReleaseDocument({
    event: { indicator: "cpi", title: "US CPI", values: { actual: "2.7%", forecast: "2.8%", previous: null }, source: { label: "BLS", url: "https://bls.gov/cpi" } },
    reaction: { BTC: { changePercent: 1.2 }, DXY: { changePercent: -0.4 } },
  });
  assert.equal(document.impact, "Bullish");
  assert.ok(document.nodes.some((node) => node.type === "metric" && node.label === "Actual" && node.value === "2.7%"));
  assert.ok(!document.nodes.some((node) => node.type === "metric" && node.label === "Previous"));
  assert.deepEqual(document.nodes.filter((node) => node.type === "metric" && ["BTC", "ETH", "DXY"].includes(node.label)).map((node) => node.label), ["BTC", "DXY"]);
  assert.throws(() => buildDataReleaseDocument({ event: { indicator: "bitcoin-dominance" } }), /allowlist/i);
});

test("data release documents evaluate unknown raw components but do not render them", () => {
  const document = buildDataReleaseDocument({
    event: {
      title: "US Employment Report",
      components: [
        { indicator: "nonfarm-payrolls", title: "Nonfarm Payrolls", values: { actual: "160K", forecast: "200K" } },
        { indicator: "labor-force-participation", title: "Labor Force Participation", values: { actual: "62.8%", forecast: "62.7%" } },
      ],
      source: { label: "BLS", url: "https://bls.gov/jobs-report" },
    },
  });

  assert.equal(document.impact, "Neutral");
  assert.ok(document.nodes.some((node) => node.type === "heading" && node.text === "Nonfarm Payrolls"));
  assert.doesNotMatch(JSON.stringify(document), /labor force participation|62\.8%|62\.7%/i);
});

test("Telegram renders Bot API HTML with escaped text and attributes and no Markdown links", () => {
  const document = buildCryptoDailyDocument({
    now,
    candidates: [story({
      title: "BTC <ETF> & \"funds\" [alert](bad)",
      summary: "A&B > C <script>alert(1)</script>",
      url: "https://example.test/a?x=1&quote=\"<bad>",
      rationale: "Flow _signal_ **verified**.",
    })],
  });
  const output = renderTelegramMarketDocument(document);
  assert.match(output, /<b>\ud83d\udcf0 Crypto Daily/);
  assert.match(output, /BTC &lt;ETF&gt; &amp; &quot;funds&quot; \[alert\]\(bad\)/);
  assert.match(output, /<a href="https:\/\/example\.test\/a\?x=1&amp;quote=&quot;&lt;bad&gt;">/);
  assert.doesNotMatch(output, /\]\(https?:|<script>|undefined|null/);
});

test("Discord renders escaped Markdown text and URL with no Telegram HTML leakage", () => {
  const document = buildCryptoDailyDocument({
    now,
    candidates: [story({
      title: "BTC *ETF* [fund](bad) \\ test",
      summary: "Under_score ~ move > now",
      url: "https://example.test/a_(b)?q=hello world",
      rationale: "Reason **not markup**.",
    })],
  });
  const output = renderDiscordMarketDocument(document);
  assert.match(output, /\*\*\ud83d\udcf0 Crypto Daily/);
  assert.match(output, /BTC \\\*ETF\\\* \\\[fund\\\]\\\(bad\\\)/);
  assert.match(output, /\[Source: Industry Wire\]\(https:\/\/example\.test\/a_%28b%29\?q=hello%20world\)/);
  assert.doesNotMatch(output, /<a href=|<b>|<script>|undefined|null/);
});
