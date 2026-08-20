import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCryptoDailyPosterModel,
  buildDataUpdatePosterModel,
  buildWeeklyCalendarPosterModel,
} from "../lib/market-poster-models.mjs";

test("weekly calendar poster creates five weekday columns and caps events at eight", () => {
  const days = Array.from({ length: 5 }, (_, day) => ({
    date: `2026-08-${17 + day}`,
    events: Array.from({ length: 2 }, (_, index) => ({
      id: `${day}-${index}`,
      title: `Event ${day}-${index}`,
      time: `${12 + index}:30`,
      importance: index === 0 ? 3 : 2,
    })),
  }));
  const model = buildWeeklyCalendarPosterModel({ title: "Calendar", weekStart: "2026-08-17", days });

  assert.equal(model.columns.length, 5);
  assert.equal(model.columns.flatMap((column) => column.events).length, 8);
  assert.equal(model.columns[0].events[0].accent, "amber");
});

test("data update model preserves official values and keeps forecast optional", () => {
  const withoutForecast = buildDataUpdatePosterModel({
    title: "US CPI",
    impact: "Bullish",
    indicator: "cpi",
    values: { actual: "2.7%", previous: "2.9%" },
    source: { label: "BLS" },
  });
  assert.equal(withoutForecast.actual, "2.7%");
  assert.equal(withoutForecast.previous, "2.9%");
  assert.equal(withoutForecast.forecast, null);

  const withForecast = buildDataUpdatePosterModel({
    title: "US CPI",
    values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%", revised: "3.0%" },
    forecastSource: "TradingView",
  });
  assert.equal(withForecast.forecast, "2.8%");
  assert.equal(withForecast.forecastLabel, "AUXILIARY FORECAST · TRADINGVIEW");
  assert.equal(withForecast.revised, "3.0%");
});

test("crypto poster uses the highest-ranked stories without category quotas", () => {
  const model = buildCryptoDailyPosterModel({
    generatedAt: "2026-08-20T10:00:00.000Z",
    selectedStories: [
      { title: "Policy decision", marketImpact: { score: 94 } },
      { title: "Liquidity shift", marketImpact: { score: 81 } },
      { title: "ETF flow", marketImpact: { score: 73 } },
      { title: "Watch item", marketImpact: { score: 55 } },
    ],
  });

  assert.equal(model.stories.length, 3);
  assert.deepEqual(model.stories.map((story) => story.score), [94, 81, 73]);
});
