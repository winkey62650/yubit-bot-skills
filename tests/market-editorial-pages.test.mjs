import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "next/dist/build/swc/index.js";
import {
  dataUpdatePublicationKey,
  weeklyCalendarPublicationKey,
} from "../lib/market-editorial-articles.mjs";
import {
  captureEditorialImage,
  createMarketPublication,
  dataUpdateArticlePath,
  marketPublicationKey,
  verifyPublicPublication,
  weeklyCalendarArticlePath,
} from "../lib/market-publication.mjs";

const ROOT = new URL("../", import.meta.url);
const weeklyPagePath = new URL("app/market-calendar/[week]/page.jsx", ROOT);
const dataPagePath = new URL("app/data-updates/[release]/[date]/page.jsx", ROOT);
const NOW = "2026-08-21T00:00:00.000Z";
const ORIGIN = "https://academy.yubit.com";

class MemoryRepository {
  constructor(store = new Map()) { this.store = store; }
  async getMeta(key) { return structuredClone(this.store.get(key) ?? null); }
  async setMeta(key, value) {
    this.store.set(key, structuredClone(value));
    return structuredClone(value);
  }
  async compareAndSetMeta(key, expected, value) {
    const current = this.store.get(key) ?? null;
    if (expected?.absent === true && current !== null) return null;
    this.store.set(key, structuredClone(value));
    return structuredClone(value);
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.byteLength);
  return chunk;
}

function png() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1200, 0);
  header.writeUInt32BE(675, 4);
  header[8] = 1;
  const pixels = Buffer.alloc((Math.ceil(1200 / 8) + 1) * 675);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND"),
  ]);
}

function response(body, { contentType = "image/png", url = "" } = {}) {
  const value = new Response(body, { status: 200, headers: { "content-type": contentType } });
  if (url) Object.defineProperty(value, "url", { value: url });
  return value;
}

function weeklyArticle(overrides = {}) {
  return {
    id: "weekly-calendar:2026-W34",
    type: "weekly-calendar-analysis",
    version: "market-editorial-v1",
    slug: "2026-W34",
    publishedAt: NOW,
    weekStart: "2026-08-17",
    weekEnd: "2026-08-23",
    kicker: "YUBIT ACADEMY / EDITORIAL RESEARCH",
    title: "Weekly Market Risk Playbook | 2026-W34",
    coreView: "Liquidity remains conditional on the week's highest-impact catalyst.",
    marketSetup: { label: "Observed market setup", summary: "Rates and DXY remain the confirmation layer.", observedAt: NOW },
    priorityEvents: [{
      id: "cpi",
      rank: 1,
      title: "US CPI",
      utcTime: "2026-08-19T12:30:00.000Z",
      jurisdiction: "US",
      impactScore: 96,
      whyItMatters: "Inflation reprices the rates path.",
      transmissionPath: "CPI → rates → DXY → crypto liquidity.",
      affectedAssets: ["BTC", "ETH", "DXY"],
      scenarioMap: "Confirm with rates and dollar follow-through.",
    }],
    impactRankedEvents: [{
      id: "cpi",
      rank: 1,
      title: "US CPI",
      utcTime: "2026-08-19T12:30:00.000Z",
      jurisdiction: "US",
      impactScore: 96,
      whyItMatters: "Inflation reprices the rates path.",
      transmissionPath: "CPI → rates → DXY → crypto liquidity.",
      affectedAssets: ["BTC", "ETH", "DXY"],
      scenarioMap: "Confirm with rates and dollar follow-through.",
      values: { forecast: "2.8%", previous: "2.7%" },
    }],
    tierOneAnalysis: [{ id: "cpi", headline: "US CPI", whyItMatters: "It reprices the rates path.", transmissionPath: "Inflation to yields to DXY to crypto.", affectedAssets: ["BTC", "ETH", "DXY"], scenarioMap: "Watch the first liquid-session follow-through." }],
    scenarios: [{ id: "base", label: "Base case", condition: "Data lands near consensus.", implication: "Keep conviction conditional." }],
    dailyWatchlist: [{ date: "2026-08-19", items: ["US CPI (12:30 UTC)"] }],
    sources: [{ label: "Official release", url: "https://example.com/cpi" }],
    limitations: ["Calendar times can change."],
    disclaimer: "For informational purposes only.",
    ...overrides,
  };
}

function dataArticle(overrides = {}) {
  return {
    id: "data-update:us-cpi/2026-08-12",
    type: "data-update-analysis",
    version: "market-editorial-v1",
    slug: "us-cpi/2026-08-12",
    publishedAt: NOW,
    kicker: "YUBIT ACADEMY / EDITORIAL RESEARCH",
    title: "US CPI | Data Update",
    tierDecision: { tier: "tier-one" },
    verdict: "Confirmed",
    facts: { title: "US CPI", jurisdiction: "US", releasedAt: NOW, actual: "2.7%", forecast: "2.8%", previous: "2.9%", surprise: "-0.1pp", surpriseDirection: "Below forecast" },
    dataSignal: { label: "Editorial Inference", summary: "The inflation impulse cooled.", impact: "Bullish" },
    marketConfirmation: { label: "Observed Market Confirmation", summary: "BTC and ETH held the measured move.", observations: [{ symbol: "BTC", beforePrice: 70000, price: 71000, changePercent: 1.43, providerName: "Example", sourceUrl: "https://example.com/btc" }] },
    reactionWindow: { start: "2026-08-21T00:00:00.000Z", end: "2026-08-21T00:05:00.000Z", providers: ["Example"] },
    scenarioAnalysis: [{ id: "base", label: "Base case", condition: "The move remains bounded.", implication: "Wait for persistence." }],
    watchNext: ["Whether BTC holds the measured direction."],
    invalidation: "BTC reverses through its pre-release benchmark.",
    sources: [{ label: "Official release", url: "https://example.com/cpi" }],
    limitations: ["The observation does not establish causality."],
    disclaimer: "For informational purposes only.",
    ...overrides,
  };
}

async function importPage(pageUrl) {
  let source = await readFile(pageUrl, "utf8");
  const fileUrl = (relativePath) => new URL(relativePath, ROOT).href;
  source = `import React from ${JSON.stringify(fileUrl("node_modules/react/index.js"))};\n${source}`
    .replace('from "next/navigation"', `from ${JSON.stringify(fileUrl("node_modules/next/navigation.js"))}`)
    .replace(/from "(?:\.\.\/)+lib\/distribution-repository\.mjs"/, `from ${JSON.stringify(fileUrl("lib/distribution-repository.mjs"))}`)
    .replace(/from "(?:\.\.\/)+lib\/market-editorial-articles\.mjs"/, `from ${JSON.stringify(fileUrl("lib/market-editorial-articles.mjs"))}`)
    .replace(/from "(?:\.\.\/)+lib\/market-publication\.mjs"/, `from ${JSON.stringify(fileUrl("lib/market-publication.mjs"))}`);
  const compiled = await transform(source, {
    filename: pageUrl.pathname,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "classic" } } },
    module: { type: "es6" },
  });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}#${Date.now()}-${Math.random()}`);
}

async function publication({ product, slug, article, status = "rendered" }) {
  const repository = new MemoryRepository();
  const draft = await createMarketPublication({
    repository,
    product,
    slug,
    article,
    communityDocument: {},
    posterModel: { canvas: { width: 1200, height: 675 } },
    sourceManifest: [],
    now: () => NOW,
  });
  if (status === "draft") return { repository, bundle: draft };
  const image = png();
  const rendered = await captureEditorialImage({
    repository,
    product,
    slug,
    publicOrigin: ORIGIN,
    allowedOrigins: [ORIGIN],
    now: () => "2026-08-21T00:00:00.001Z",
    fetchImpl: async (url) => response(image, { url }),
  });
  if (status === "rendered") return { repository, bundle: rendered };
  const verified = await verifyPublicPublication({
    repository,
    product,
    slug,
    publicOrigin: ORIGIN,
    allowedOrigins: [ORIGIN],
    now: () => "2026-08-21T00:00:00.002Z",
    fetchImpl: async (url) => url.includes("/api/media/")
      ? response(image, { url })
      : response(`<article data-content-hash="${draft.contentHash}"></article>`, { contentType: "text/html; charset=utf-8", url }),
  });
  return { repository, bundle: verified };
}

function isNotFound(error) {
  return typeof error?.digest === "string" && error.digest.includes("404");
}

test("canonical editorial page routes and repository keys share strict parameter validation", () => {
  assert.equal(weeklyCalendarArticlePath("2026-W34"), "/market-calendar/2026-W34");
  assert.equal(weeklyCalendarPublicationKey("2026-W34"), "market-editorial-v1:weekly-calendar:2026-W34");
  assert.equal(dataUpdateArticlePath("us-cpi", "2026-08-12"), "/data-updates/us-cpi/2026-08-12");
  assert.equal(dataUpdatePublicationKey("us-cpi", "2026-08-12"), "market-editorial-v1:data-update:us-cpi:2026-08-12");

  for (const invalidWeek of ["2026-34", "2021-W53", "2026-W00", " 2026-W34 "]) {
    assert.throws(() => weeklyCalendarArticlePath(invalidWeek), /canonical|ISO week/i);
    if (invalidWeek === invalidWeek.trim()) assert.throws(() => weeklyCalendarPublicationKey(invalidWeek), /canonical|ISO week/i);
  }
  for (const [release, date] of [["US CPI", "2026-08-12"], ["us-cpi", "2026-8-12"], ["../cpi", "2026-08-12"], ["us-cpi", "2026-02-30"]]) {
    assert.throws(() => dataUpdateArticlePath(release, date), /canonical/i);
    assert.throws(() => dataUpdatePublicationKey(release, date), /canonical/i);
  }
});

test("server renderers propagate repository failures instead of converting them to 404", async () => {
  const [{ default: WeeklyPage }, { default: DataPage }] = await Promise.all([importPage(weeklyPagePath), importPage(dataPagePath)]);
  const outage = new Error("postgres unavailable");
  const repository = { async getMeta() { throw outage; }, async setMeta() { throw outage; } };
  await assert.rejects(WeeklyPage({ params: { week: "2026-W34" }, repository }), (error) => error === outage);
  await assert.rejects(DataPage({ params: { release: "us-cpi", date: "2026-08-12" }, repository }), (error) => error === outage);
});

test("server renderers reject draft and corrupted publication identities or hashes", async () => {
  const [{ default: WeeklyPage }, { default: DataPage }] = await Promise.all([importPage(weeklyPagePath), importPage(dataPagePath)]);
  const weeklyDraft = await publication({ product: "weekly-calendar", slug: "2026-W34", article: weeklyArticle(), status: "draft" });
  await assert.rejects(WeeklyPage({ params: { week: "2026-W34" }, repository: weeklyDraft.repository }), isNotFound);
  const dataDraft = await publication({ product: "data-update", slug: "us-cpi/2026-08-12", article: dataArticle(), status: "draft" });
  await assert.rejects(DataPage({ params: { release: "us-cpi", date: "2026-08-12" }, repository: dataDraft.repository }), isNotFound);

  const original = await weeklyDraft.repository.getMeta(marketPublicationKey("weekly-calendar", "2026-W34"));
  for (const [field, value, message] of [
    ["product", "data-update", /missing or malformed/i],
    ["slug", "2026-W35", /missing or malformed/i],
    ["contentHash", createHash("sha256").update("forged").digest("hex"), /content hash/i],
  ]) {
    const forged = structuredClone(original);
    forged[field] = value;
    const repository = { async getMeta() { return forged; }, async setMeta() {} };
    await assert.rejects(WeeklyPage({ params: { week: "2026-W34" }, repository }), message);
  }
});

test("weekly rendered and data verified publications render through React SSR with one trusted hash marker", async () => {
  const [{ default: WeeklyPage }, { default: DataPage }] = await Promise.all([importPage(weeklyPagePath), importPage(dataPagePath)]);
  const weekly = await publication({ product: "weekly-calendar", slug: "2026-W34", article: weeklyArticle(), status: "rendered" });
  const weeklyHtml = renderToStaticMarkup(await WeeklyPage({ params: { week: "2026-W34" }, repository: weekly.repository }));
  assert.equal(weeklyHtml.match(/data-content-hash=/g)?.length, 1);
  assert.match(weeklyHtml, new RegExp(`data-content-hash="${weekly.bundle.contentHash}"`));
  for (const heading of ["Core view", "Impact-ranked event table", "Tier-one analysis", "Scenario framework", "Daily watchlist", "Primary sources", "Limitations"]) assert.match(weeklyHtml, new RegExp(heading, "i"));

  const data = await publication({ product: "data-update", slug: "us-cpi/2026-08-12", article: dataArticle(), status: "verified" });
  const dataHtml = renderToStaticMarkup(await DataPage({ params: { release: "us-cpi", date: "2026-08-12" }, repository: data.repository }));
  assert.equal(dataHtml.match(/data-content-hash=/g)?.length, 1);
  assert.match(dataHtml, new RegExp(`data-content-hash="${data.bundle.contentHash}"`));
  for (const heading of ["Verified fact table", "Data Signal", "Market Confirmation", "Bounded reaction table", "Scenario analysis", "Watch next", "Primary sources", "Limitations"]) assert.match(dataHtml, new RegExp(heading, "i"));
});

test("page article-shape checks fail closed before malformed nested fields reach SSR", async () => {
  const [{ default: WeeklyPage }, { default: DataPage }] = await Promise.all([importPage(weeklyPagePath), importPage(dataPagePath)]);
  const weekly = await publication({ product: "weekly-calendar", slug: "2026-W34", article: weeklyArticle({ marketSetup: null }) });
  await assert.rejects(WeeklyPage({ params: { week: "2026-W34" }, repository: weekly.repository }), isNotFound);
  const data = await publication({ product: "data-update", slug: "us-cpi/2026-08-12", article: dataArticle({ marketConfirmation: { label: "Observed", summary: "Missing observations" } }) });
  await assert.rejects(DataPage({ params: { release: "us-cpi", date: "2026-08-12" }, repository: data.repository }), isNotFound);

  const malformedPriority = weeklyArticle();
  delete malformedPriority.priorityEvents[0].transmissionPath;
  const weeklyNested = await publication({ product: "weekly-calendar", slug: "2026-W34", article: malformedPriority });
  await assert.rejects(WeeklyPage({ params: { week: "2026-W34" }, repository: weeklyNested.repository }), isNotFound);

  const malformedObservation = dataArticle();
  delete malformedObservation.marketConfirmation.observations[0].changePercent;
  const dataNested = await publication({ product: "data-update", slug: "us-cpi/2026-08-12", article: malformedObservation });
  await assert.rejects(DataPage({ params: { release: "us-cpi", date: "2026-08-12" }, repository: dataNested.repository }), isNotFound);
});

test("unsafe source URLs remain visible as labels but never become SSR links", async () => {
  const [{ default: WeeklyPage }, { default: DataPage }] = await Promise.all([importPage(weeklyPagePath), importPage(dataPagePath)]);
  const weekly = await publication({ product: "weekly-calendar", slug: "2026-W34", article: weeklyArticle({ sources: [{ label: "Unsafe weekly source", url: "javascript:alert(1)" }] }) });
  const weeklyHtml = renderToStaticMarkup(await WeeklyPage({ params: { week: "2026-W34" }, repository: weekly.repository }));
  assert.match(weeklyHtml, /Unsafe weekly source/);
  assert.doesNotMatch(weeklyHtml, /javascript:/i);

  const article = dataArticle({
    marketConfirmation: { label: "Observed Market Confirmation", summary: "Measured move.", observations: [{ symbol: "BTC", changePercent: 1, providerName: "Unsafe provider", sourceUrl: "data:text/html,bad" }] },
    sources: [{ label: "Unsafe data source", url: "javascript:alert(1)" }],
  });
  const data = await publication({ product: "data-update", slug: "us-cpi/2026-08-12", article });
  const dataHtml = renderToStaticMarkup(await DataPage({ params: { release: "us-cpi", date: "2026-08-12" }, repository: data.repository }));
  assert.match(dataHtml, /Unsafe provider/);
  assert.match(dataHtml, /Unsafe data source/);
  assert.doesNotMatch(dataHtml, /(?:javascript|data):/i);
});

test("optional source and limitation arrays default safely during SSR", async () => {
  const [{ default: WeeklyPage }, { default: DataPage }] = await Promise.all([importPage(weeklyPagePath), importPage(dataPagePath)]);
  const weeklyPayload = weeklyArticle();
  delete weeklyPayload.sources;
  delete weeklyPayload.limitations;
  const dataPayload = dataArticle();
  delete dataPayload.sources;
  delete dataPayload.limitations;
  const weekly = await publication({ product: "weekly-calendar", slug: "2026-W34", article: weeklyPayload });
  const data = await publication({ product: "data-update", slug: "us-cpi/2026-08-12", article: dataPayload });
  assert.match(renderToStaticMarkup(await WeeklyPage({ params: { week: "2026-W34" }, repository: weekly.repository })), /Primary sources/);
  assert.match(renderToStaticMarkup(await DataPage({ params: { release: "us-cpi", date: "2026-08-12" }, repository: data.repository })), /Primary sources/);
});

test("page sources use the validated publication loader and a unique trusted hash marker", async () => {
  for (const pagePath of [weeklyPagePath, dataPagePath]) {
    const source = await readFile(pagePath, "utf8");
    assert.match(source, /getMarketPublication\s*\(/);
    assert.doesNotMatch(source, /repository\.getMeta\s*\(/);
    assert.equal(source.match(/data-content-hash=/g)?.length, 1);
    assert.match(source, /<article[^>]*data-content-hash=\{bundle\.contentHash\}/s);
  }
});
