import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  dataUpdatePublicationKey,
  weeklyCalendarPublicationKey,
} from "../lib/market-editorial-articles.mjs";
import {
  dataUpdateArticlePath,
  weeklyCalendarArticlePath,
} from "../lib/market-publication.mjs";

const weeklyPagePath = new URL("../app/market-calendar/[week]/page.jsx", import.meta.url);
const dataPagePath = new URL("../app/data-updates/[release]/[date]/page.jsx", import.meta.url);

test("canonical editorial page routes and repository keys share strict parameter validation", () => {
  assert.equal(weeklyCalendarArticlePath("2026-W34"), "/market-calendar/2026-W34");
  assert.equal(weeklyCalendarPublicationKey("2026-W34"), "market-editorial-v1:weekly-calendar:2026-W34");
  assert.equal(dataUpdateArticlePath("us-cpi", "2026-08-12"), "/data-updates/us-cpi/2026-08-12");
  assert.equal(dataUpdatePublicationKey("us-cpi", "2026-08-12"), "market-editorial-v1:data-update:us-cpi:2026-08-12");

  for (const invalidWeek of ["2026-34", "2021-W53", "2026-W00"]) {
    assert.throws(() => weeklyCalendarArticlePath(invalidWeek), /canonical|ISO week/i);
    assert.throws(() => weeklyCalendarPublicationKey(invalidWeek), /canonical|ISO week/i);
  }
  assert.throws(() => weeklyCalendarArticlePath(" 2026-W34 "), /canonical|ISO week/i);
  for (const [release, date] of [["US CPI", "2026-08-12"], ["us-cpi", "2026-8-12"], ["../cpi", "2026-08-12"], ["us-cpi", "2026-02-30"]]) {
    assert.throws(() => dataUpdateArticlePath(release, date), /canonical/i);
    assert.throws(() => dataUpdatePublicationKey(release, date), /canonical/i);
  }
});

test("Weekly Calendar page loads the durable bundle and exposes every commercial article section", async () => {
  const source = await readFile(weeklyPagePath, "utf8");

  assert.match(source, /weeklyCalendarArticlePath\(week\)/);
  assert.match(source, /weeklyCalendarPublicationKey\(week\)/);
  assert.match(source, /getDistributionRepository\(\)/);
  assert.match(source, /repository\.getMeta\(key\)/);
  assert.match(source, /if \(!bundle\?\.article\) notFound\(\)/);
  assert.equal(source.match(/data-content-hash=/g)?.length, 1);
  assert.match(source, /<article[^>]*data-content-hash=\{bundle\.contentHash\}/s);
  for (const field of [
    "coreView",
    "marketSetup",
    "impactRankedEvents",
    "tierOneAnalysis",
    "scenarios",
    "dailyWatchlist",
    "sources",
    "limitations",
    "disclaimer",
  ]) assert.match(source, new RegExp(`article\\.${field}`), `renders ${field}`);
});

test("Data Update page rejects secondary bundles and renders facts separately from inference and observation", async () => {
  const source = await readFile(dataPagePath, "utf8");

  assert.match(source, /dataUpdateArticlePath\(release, date\)/);
  assert.match(source, /dataUpdatePublicationKey\(release, date\)/);
  assert.match(source, /getDistributionRepository\(\)/);
  assert.match(source, /repository\.getMeta\(key\)/);
  assert.match(source, /if \(!bundle\?\.article\) notFound\(\)/);
  assert.match(source, /tierDecision\?\.tier\s*!==\s*["']tier-one["']/);
  assert.equal(source.match(/data-content-hash=/g)?.length, 1);
  assert.match(source, /<article[^>]*data-content-hash=\{bundle\.contentHash\}/s);
  for (const field of [
    "facts",
    "dataSignal",
    "marketConfirmation",
    "reactionWindow",
    "scenarioAnalysis",
    "watchNext",
    "sources",
    "limitations",
    "disclaimer",
  ]) assert.match(source, new RegExp(`article\\.${field}`), `renders ${field}`);
});
