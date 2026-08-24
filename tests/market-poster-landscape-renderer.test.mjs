import assert from "node:assert/strict";
import test from "node:test";

import { renderLandscapeMarketPoster } from "../lib/market-poster-landscape-renderer.mjs";

function e(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined) };
}

function renderedText(model) {
  return JSON.stringify(renderLandscapeMarketPoster(e, model, LOCKED_MASTER));
}

function geometry(model) {
  const output = renderLandscapeMarketPoster(e, model, LOCKED_MASTER);
  return output.children.map((child) => ({
    key: child.props["data-dynamic-field"],
    left: child.props.style.left,
    top: child.props.style.top,
    width: child.props.style.width,
    height: child.props.style.height,
  }));
}

const footer = { sources: ["BLS", "Coinbase Exchange"], updatedAt: "2026-08-24T03:16:33.000Z" };
const LOCKED_MASTER = "data:image/png;base64,AAAA";

test("all four automatic posters render on the landscape canvas with their content-only titles", () => {
  const cases = [
    ["daily-market-brief-v4", "DAILY MARKET BRIEF", { stories: [{ rank: "01", title: "BTC ETF demand remains the structural anchor", score: 83, impact: "BULLISH", source: "SEC", affected: "BTC" }] }],
    ["weekly-catalysts-v4", "WEEKLY CATALYSTS", { columns: [{ label: "TUE 25", events: [{ title: "U.S. CPI", time: "12:30", importance: 3, source: "BLS", sensitivity: "Rates and USD repricing" }] }], highImpactCount: 1, peakDay: "TUE 25" }],
    ["data-flash-v4", "DATA FLASH", { title: "U.S. CPI at 2.7% YoY", actual: "2.7%", forecast: null, previous: null, impact: "Neutral", reactions: [] }],
    ["market-follow-up-v4", "MARKET FOLLOW-UP", { title: "U.S. CPI at 2.7% YoY", impact: "Neutral", reactions: [{ symbol: "BTC", label: "-0.09%", value: -0.09 }], reactionWindow: { label: "12:30–13:00 UTC" } }],
  ];

  for (const [id, title, fields] of cases) {
    const output = renderLandscapeMarketPoster(e, { ...fields, footer, visualTemplate: { id, canvas: { width: 1200, height: 675 } } }, LOCKED_MASTER);
    assert.equal(output.props.style.width, "100%");
    assert.equal(output.props.style.height, "100%");
    assert.match(JSON.stringify(output), new RegExp(title));
    assert.doesNotMatch(JSON.stringify(output), /YUBIT/i);
  }
});

test("the supplied VIP Wide Dense V4 template remains the visual source of truth", () => {
  const text = renderedText({
    visualTemplate: { id: "daily-market-brief-v4" },
    stories: [{ rank: "01", title: "Verified market development", score: 80, affected: "BTC" }],
    footer,
  });

  assert.match(text, /data:image\/png;base64,AAAA/);
  assert.match(text, /DAILY MARKET BRIEF/);
  assert.match(text, /data-dynamic-field/);
  assert.doesNotMatch(text, /linear-gradient|boxShadow/);
  assert.doesNotMatch(text, /#F4F0E7|YUBIT/i);
});

test("daily content can change without changing any field count or geometry", () => {
  const base = { visualTemplate: { id: "daily-market-brief-v4" }, footer };
  const sparse = geometry({ ...base, stories: [{ title: "BTC update", source: "SEC", affected: "BTC" }] });
  const dense = geometry({ ...base, stories: Array.from({ length: 3 }, (_, index) => ({
    title: `Story ${index + 1} with a much longer verified headline`,
    source: "Verified source",
    affected: index === 0 ? "BTC" : "ETH",
    thesis: "Different daily content must remain inside the exact same fixed slot.",
  })) });

  assert.deepEqual(dense, sparse);
  assert.equal(new Set(sparse.map(({ key }) => key)).size, sparse.length);
  assert.equal(sparse.every(({ key }) => Boolean(key)), true);
});

test("all four V4 products keep identical dynamic-field geometry for sparse and dense input", () => {
  const cases = [
    ["daily-market-brief-v4",
      { stories: [] },
      { stories: Array.from({ length: 3 }, (_, index) => ({ title: `Verified story ${index + 1}`, source: "Official source", affected: "BTC", thesis: "Dense daily content stays in the same slot.", impact: "Positive", score: 82 })) }],
    ["weekly-catalysts-v4",
      { weekStart: "2026-08-24", columns: [] },
      { weekStart: "2026-08-24", columns: Array.from({ length: 5 }, (_, index) => ({ label: `${["MON", "TUE", "WED", "THU", "FRI"][index]} ${24 + index}`, events: [{ title: `Verified event ${index + 1}`, time: "12:30", importance: 3, affected: "BTC", sensitivity: "Cross-asset repricing risk." }] })) }],
    ["data-flash-v4",
      { indicator: "CPI", reactions: [] },
      { indicator: "CPI", actual: "2.7%", forecast: "2.8%", previous: "2.9%", reactions: Array.from({ length: 4 }, (_, index) => ({ symbol: ["BTC", "DXY", "NASDAQ", "US 2Y"][index], label: "+0.10%", status: "Observed" })) }],
    ["market-follow-up-v4",
      { reactions: [] },
      { reactionWindow: { label: "12:30–13:00 UTC · 30 MIN" }, reactions: Array.from({ length: 4 }, (_, index) => ({ symbol: ["BTC", "ETH", "DXY", "NASDAQ"][index], label: "+0.10%", status: "Observed" })) }],
  ];

  for (const [id, sparseFields, denseFields] of cases) {
    const base = { visualTemplate: { id }, footer };
    const sparse = geometry({ ...base, ...sparseFields });
    const dense = geometry({ ...base, ...denseFields });
    assert.deepEqual(dense, sparse, `${id} must never reflow`);
    assert.equal(new Set(sparse.map(({ key }) => key)).size, sparse.length, `${id} fields must be uniquely addressable`);
  }
});

test("automatic posters fail closed when the locked V4 master is missing", () => {
  assert.throws(
    () => renderLandscapeMarketPoster(e, { visualTemplate: { id: "daily-market-brief-v4" }, stories: [] }),
    /locked VIP Wide Dense V4 master artwork is required/i,
  );
});

test("sparse weekly data preserves all five fixed weekday slots without inventing events", () => {
  const text = renderedText({
    visualTemplate: { id: "weekly-catalysts-v4" },
    weekStart: "2026-08-24",
    columns: [
      { label: "MON 24", events: [] },
      { label: "TUE 25", events: [{ title: "U.S. CPI", time: "12:30", importance: 3, source: "BLS", sensitivity: "Rates and USD repricing" }] },
      { label: "WED 26", events: [] },
      { label: "THU 27", events: [] },
      { label: "FRI 28", events: [] },
    ],
    highImpactCount: 1,
    peakDay: "TUE 25",
    footer,
  });

  assert.match(text, /U\.S\. CPI/);
  assert.match(text, /NO MATERIAL VERIFIED UPDATE/i);
  assert.match(text, /weekly-1-day/);
  assert.match(text, /weekly-5-day/);
  assert.doesNotMatch(text, /TBD|N\/A|NOT AVAILABLE/);
});

test("weekly catalysts keeps the V4 Monday-to-Friday frame and never pulls a later event", () => {
  const text = renderedText({
    visualTemplate: { id: "weekly-catalysts-v4" },
    weekStart: "2026-08-24",
    columns: [
      ...Array.from({ length: 7 }, (_, index) => ({ label: `DAY ${index + 1}`, events: index === 0 ? [{ title: "This-week CPI", time: "12:30", importance: 3, source: "BLS" }] : [] })),
      { label: "DAY 8", events: [{ title: "Next-week event must not appear", time: "09:00", importance: 3, source: "Official source" }] },
    ],
    footer,
  });

  assert.match(text, /24–28 AUG 2026/);
  assert.match(text, /This-week CPI/);
  assert.doesNotMatch(text, /Next-week event must not appear/);
});

test("missing flash comparisons stay in their original fixed fields and are marked unpublished", () => {
  const text = renderedText({
    visualTemplate: { id: "data-flash-v4" },
    title: "U.S. CPI at 2.7% YoY",
    indicator: "CPI",
    actual: "2.7% YoY",
    forecast: null,
    previous: null,
    impact: "Neutral",
    verdict: "The official print is verified; wait for cross-asset confirmation.",
    reactions: [],
    footer,
  });

  assert.match(text, /2\.7% YoY/);
  assert.match(text, /NOT PUBLISHED/);
  assert.match(text, /flash-forecast/);
  assert.match(text, /flash-previous/);
});
