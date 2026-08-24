import assert from "node:assert/strict";
import test from "node:test";

import { renderLandscapeMarketPoster } from "../lib/market-poster-landscape-renderer.mjs";

function e(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined) };
}

function renderedText(model) {
  return JSON.stringify(renderLandscapeMarketPoster(e, model));
}

const footer = { sources: ["BLS", "Coinbase Exchange"], updatedAt: "2026-08-24T03:16:33.000Z" };

test("all four automatic posters render on the landscape canvas with their content-only titles", () => {
  const cases = [
    ["daily-market-brief-v4", "DAILY MARKET BRIEF", { stories: [{ rank: "01", title: "BTC ETF demand remains the structural anchor", score: 83, impact: "BULLISH", source: "SEC", affected: "BTC" }] }],
    ["weekly-catalysts-v4", "WEEKLY CATALYSTS", { columns: [{ label: "TUE 25", events: [{ title: "U.S. CPI", time: "12:30", importance: 3, source: "BLS", sensitivity: "Rates and USD repricing" }] }], highImpactCount: 1, peakDay: "TUE 25" }],
    ["data-flash-v4", "DATA FLASH", { title: "U.S. CPI at 2.7% YoY", actual: "2.7%", forecast: null, previous: null, impact: "Neutral", reactions: [] }],
    ["market-follow-up-v4", "MARKET FOLLOW-UP", { title: "U.S. CPI at 2.7% YoY", impact: "Neutral", reactions: [{ symbol: "BTC", label: "-0.09%", value: -0.09 }], reactionWindow: { label: "12:30–13:00 UTC" } }],
  ];

  for (const [id, title, fields] of cases) {
    const output = renderLandscapeMarketPoster(e, { ...fields, footer, visualTemplate: { id, canvas: { width: 1200, height: 675 } } });
    assert.equal(output.props.style.width, "100%");
    assert.equal(output.props.style.height, "100%");
    assert.match(JSON.stringify(output), new RegExp(title));
    assert.doesNotMatch(JSON.stringify(output), /YUBIT/i);
  }
});

test("sparse weekly data renders only verified event cards and never five empty weekday slots", () => {
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
  assert.match(text, /NO FILLER EVENTS/i);
  assert.doesNotMatch(text, /MON 24/);
  assert.doesNotMatch(text, /WED 26/);
  assert.doesNotMatch(text, /TBD|N\/A|NOT AVAILABLE/);
});

test("weekly catalysts is a single Monday-to-Sunday UTC view and never pulls an eighth-day event", () => {
  const text = renderedText({
    visualTemplate: { id: "weekly-catalysts-v4" },
    weekStart: "2026-08-24",
    columns: [
      ...Array.from({ length: 7 }, (_, index) => ({ label: `DAY ${index + 1}`, events: index === 0 ? [{ title: "This-week CPI", time: "12:30", importance: 3, source: "BLS" }] : [] })),
      { label: "DAY 8", events: [{ title: "Next-week event must not appear", time: "09:00", importance: 3, source: "Official source" }] },
    ],
    footer,
  });

  assert.match(text, /24–30 AUG 2026 · UTC/);
  assert.match(text, /This-week CPI/);
  assert.doesNotMatch(text, /Next-week event must not appear/);
});

test("missing flash comparisons collapse into verified context instead of dash-filled metric boxes", () => {
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
  assert.match(text, /OFFICIAL PRINT/);
  assert.doesNotMatch(text, /CONSENSUS[^}]*—|PREVIOUS[^}]*—|>—</);
});
