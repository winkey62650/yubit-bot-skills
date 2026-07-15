import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { getMediaCardTemplate, normalizePosterMetrics } from "../lib/media-card-template.mjs";

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
  const source = await readFile(new URL("../app/api/media/card/route.js", import.meta.url), "utf8");
  assert.match(source, /morning-market-brief-bg-v2\.png/);

  const middleware = await readFile(new URL("../middleware.js", import.meta.url), "utf8");
  assert.match(middleware, /pathname\.startsWith\("\/templates\/"\)/);
});

test("daily analysis poster uses the approved artwork with dynamic market fields", async () => {
  await access(new URL("../public/templates/daily-market-analysis.png", import.meta.url));
  const source = await readFile(new URL("../app/api/media/card/route.js", import.meta.url), "utf8");
  assert.match(source, /kind === "analysis"/);
  assert.match(source, /daily-market-analysis\.png/);
  assert.match(source, /searchParams\.get\("regime"\)/);
  assert.match(source, /searchParams\.get\("levels"\)/);
  assert.match(source, /searchParams\.get\("catalyst"\)/);
});

test("whale poster uses premium reusable artwork with dynamic order-book fields", async () => {
  await access(new URL("../public/templates/whale-alert-bg-v2.png", import.meta.url));
  const source = await readFile(new URL("../app/api/media/card/route.js", import.meta.url), "utf8");
  assert.match(source, /whale-alert-bg-v2\.png/);
  assert.match(source, /WHALE ALERT/);
  assert.match(source, /SMART MONEY SIGNAL/);
  assert.match(source, /searchParams\.get\("signal"\)/);
  assert.match(source, /searchParams\.get\("pair"\)/);
  assert.match(source, /searchParams\.get\("amount"\)/);
  assert.match(source, /searchParams\.get\("price"\)/);
});
