import assert from "node:assert/strict";
import test from "node:test";

import { loadMarketPosterArtwork } from "../lib/market-poster-artwork.mjs";
import {
  approvedMarketPosterTemplates,
  marketPosterCanvas,
  selectMarketPosterTemplate,
} from "../lib/market-poster-templates.mjs";

test("the automatic poster set uses Telegram landscape while specialist artwork remains available", () => {
  const templates = approvedMarketPosterTemplates();
  assert.equal(templates.length, 7);
  assert.equal(templates.filter(({ auto }) => auto).length, 4);
  assert.equal(templates.filter(({ auto }) => !auto).length, 3);
  assert.equal(templates.filter(({ auto }) => auto).every(({ canvas }) => canvas.width === 1200 && canvas.height === 675), true);
  assert.equal(templates.filter(({ auto }) => !auto).every(({ canvas }) => canvas.width === 1080 && canvas.height === 1350), true);
  assert.equal(templates.find(({ id }) => id === "weekly-catalysts-v4")?.timeScope, "single-utc-week");
});

test("automatic selection is fail-closed and maps every core product to its own template", () => {
  const daily = selectMarketPosterTemplate({
    jobId: "crypto-daily",
    poster: { stories: [{ title: "ETF flows increased", source: "SEC filing" }] },
  });
  const weekly = selectMarketPosterTemplate({
    jobId: "weekly-calendar",
    poster: { columns: [{ events: [{ title: "US CPI", source: "BLS" }] }] },
  });
  const flash = selectMarketPosterTemplate({
    jobId: "data-release-updates",
    poster: { actual: "2.7%", source: "BLS", reactions: [] },
  });
  const followUp = selectMarketPosterTemplate({
    jobId: "data-release-updates",
    poster: { actual: "2.7%", source: "BLS", reactions: [{ symbol: "BTC", value: 0.5 }], reactionWindow: { start: "a", end: "b" } },
    reaction: { prices: { BTC: { changePercent: 0.5 } } },
  });

  assert.deepEqual([daily?.id, weekly?.id, flash?.id, followUp?.id], [
    "daily-market-brief-v4",
    "weekly-catalysts-v4",
    "data-flash-v4",
    "market-follow-up-v4",
  ]);
  assert.equal(selectMarketPosterTemplate({ jobId: "data-release-updates", poster: { actual: "2.7%" } }), null);
  assert.deepEqual(marketPosterCanvas({ visualTemplate: daily }), { width: 1200, height: 675 });
  assert.deepEqual(marketPosterCanvas({}), { width: 1200, height: 675 });
});

test("landscape automatic templates are generated layouts rather than bundled portrait artwork", async () => {
  const selected = selectMarketPosterTemplate({
    jobId: "crypto-daily",
    poster: { stories: [{ title: "ETF flows increased", source: "SEC filing" }] },
  });
  await assert.rejects(
    () => loadMarketPosterArtwork({ visualTemplate: selected }),
    /generated layout/i,
  );
});
