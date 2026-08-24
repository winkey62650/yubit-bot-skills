import assert from "node:assert/strict";
import test from "node:test";

import { loadMarketPosterArtwork } from "../lib/market-poster-artwork.mjs";
import {
  approvedMarketPosterTemplates,
  marketPosterCanvas,
  selectMarketPosterTemplate,
} from "../lib/market-poster-templates.mjs";

test("the supplied portrait set exposes four automatic and three specialist templates", () => {
  const templates = approvedMarketPosterTemplates();
  assert.equal(templates.length, 7);
  assert.equal(templates.filter(({ auto }) => auto).length, 4);
  assert.equal(templates.filter(({ auto }) => !auto).length, 3);
  assert.equal(templates.every(({ canvas }) => canvas.width === 1080 && canvas.height === 1350), true);
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
    "daily-market-brief-v3",
    "weekly-catalysts-v3",
    "data-flash-v3",
    "market-follow-up-v3",
  ]);
  assert.equal(selectMarketPosterTemplate({ jobId: "data-release-updates", poster: { actual: "2.7%" } }), null);
  assert.deepEqual(marketPosterCanvas({ visualTemplate: daily }), { width: 1080, height: 1350 });
  assert.deepEqual(marketPosterCanvas({}), { width: 1200, height: 675 });
});

test("only exact approved artwork metadata can load the bundled poster", async () => {
  const selected = selectMarketPosterTemplate({
    jobId: "crypto-daily",
    poster: { stories: [{ title: "ETF flows increased", source: "SEC filing" }] },
  });
  const artwork = await loadMarketPosterArtwork({ visualTemplate: selected });
  assert.match(artwork, /^data:image\/png;base64,/);
  await assert.rejects(
    () => loadMarketPosterArtwork({ visualTemplate: { ...selected, file: "../secret.png" } }),
    /not approved/i,
  );
});
