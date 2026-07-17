import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { getMediaCardTemplate, normalizePosterMetrics } from "../lib/media-card-template.mjs";
import { loadMediaCardArtwork } from "../lib/media-card-artwork.mjs";

test("editorial automation cards use neutral branding", () => {
  for (const kind of ["events", "analysis", "whale"]) {
    const card = getMediaCardTemplate(kind);
    assert.equal(card.brandLabel, "MARKET INTELLIGENCE");
    assert.match(card.note, /not investment advice|verify before publishing/i);
    assert.doesNotMatch(JSON.stringify(card), /yubit/i);
  }
});

test("poster artwork never exposes quotas, clock times or publishing frequency", () => {
  for (const kind of ["events", "analysis", "whale"]) {
    assert.doesNotMatch(getMediaCardTemplate(kind).eyebrow, /\d{1,2}:\d{2}|utc|hourly|每小时|\d+\s*条/i);
  }

  assert.deepEqual(
    normalizePosterMetrics(["11 key events", "08:00 UTC", "Updates hourly", "Orderbook +12.4%"]),
    ["Orderbook +12.4%"]
  );
});

test("daily events poster uses the premium reusable market artwork", async () => {
  await access(new URL("../public/templates/morning-market-brief-bg-v2.png", import.meta.url));
  const artworkSource = await readFile(new URL("../lib/media-card-artwork.mjs", import.meta.url), "utf8");
  assert.match(artworkSource, /morning-market-brief-bg-v2\.png/);

  const middleware = await readFile(new URL("../middleware.js", import.meta.url), "utf8");
  assert.match(middleware, /pathname\.startsWith\("\/templates\/"\)/);
});

test("daily analysis poster uses the approved artwork with dynamic market fields", async () => {
  await access(new URL("../public/templates/daily-market-analysis.png", import.meta.url));
  const source = await readFile(new URL("../app/api/media/card/route.js", import.meta.url), "utf8");
  const artworkSource = await readFile(new URL("../lib/media-card-artwork.mjs", import.meta.url), "utf8");
  assert.match(source, /kind === "analysis"/);
  assert.match(artworkSource, /daily-market-analysis\.png/);
  assert.match(source, /searchParams\.get\("regime"\)/);
  assert.match(source, /searchParams\.get\("levels"\)/);
  assert.match(source, /searchParams\.get\("catalyst"\)/);
});

test("whale poster uses premium reusable artwork with dynamic order-book fields", async () => {
  await access(new URL("../public/templates/whale-alert-bg-v2.png", import.meta.url));
  const source = await readFile(new URL("../app/api/media/card/route.js", import.meta.url), "utf8");
  const artworkSource = await readFile(new URL("../lib/media-card-artwork.mjs", import.meta.url), "utf8");
  assert.match(artworkSource, /whale-alert-bg-v2\.png/);
  assert.match(source, /WHALE ALERT/);
  assert.match(source, /SMART MONEY SIGNAL/);
  assert.match(source, /searchParams\.get\("signal"\)/);
  assert.match(source, /searchParams\.get\("pair"\)/);
  assert.match(source, /searchParams\.get\("amount"\)/);
  assert.match(source, /searchParams\.get\("price"\)/);
});

test("poster artwork is embedded into the generated image instead of fetched back over HTTP", async () => {
  const expectedFiles = {
    events: "morning-market-brief-bg-v2.png",
    analysis: "daily-market-analysis.png",
    whale: "whale-alert-bg-v2.png"
  };

  for (const [kind, expectedFile] of Object.entries(expectedFiles)) {
    let requestedFile = "";
    const artwork = await loadMediaCardArtwork(kind, {
      templatesDir: "/tmp/templates",
      readFileImpl: async (file) => {
        requestedFile = file;
        return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      }
    });
    assert.equal(requestedFile, `/tmp/templates/${expectedFile}`);
    assert.equal(artwork, "data:image/png;base64,iVBORw==");
  }

  const source = await readFile(new URL("../app/api/media/card/route.js", import.meta.url), "utf8");
  assert.match(source, /runtime = "nodejs"/);
  assert.match(source, /await loadMediaCardArtwork\(kind\)/);
  assert.doesNotMatch(source, /new URL\("\/templates\//);
});
