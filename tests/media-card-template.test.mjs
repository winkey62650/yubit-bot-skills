import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { getMediaCardTemplate, normalizePosterMetrics } from "../lib/media-card-template.mjs";
import { loadMediaCardArtwork } from "../lib/media-card-artwork.mjs";
import {
  captureEditorialImage,
  createMarketPublication,
  marketPublicationKey,
} from "../lib/market-publication.mjs";
import {
  buildDataUpdatePosterModel,
  buildWeeklyCalendarPosterModel,
} from "../lib/market-poster-models.mjs";
import { selectMarketPosterTemplate } from "../lib/market-poster-templates.mjs";

const EDITORIAL_ORIGIN = "https://academy.yubit.com";

class EditorialMemoryRepository {
  constructor() {
    this.store = new Map();
    this.lookups = [];
  }

  async getMeta(key) {
    this.lookups.push(key);
    return structuredClone(this.store.get(key) ?? null);
  }

  async setMeta(key, value) {
    this.store.set(key, structuredClone(value));
    return structuredClone(value);
  }

  async compareAndSetMeta(key, expected, value) {
    const current = this.store.get(key) ?? null;
    if (expected?.absent === true ? current !== null : Object.entries(expected ?? {})
      .some(([field, expectedValue]) => field !== "absent" && current?.[field] !== expectedValue)) {
      return null;
    }
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

function editorialPng() {
  const width = 1200;
  const height = 675;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1;
  const pixels = Buffer.alloc((Math.ceil(width / 8) + 1) * height);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND"),
  ]);
}

function editorialDraft(product = "weekly-calendar") {
  if (product === "weekly-calendar") {
    return {
      product,
      slug: "2026-W34",
      article: { title: "Weekly risk playbook" },
      communityDocument: { nodes: [] },
      posterModel: buildWeeklyCalendarPosterModel({
        weekStart: "2026-08-17",
        generatedAt: "2026-08-16T18:00:00.000Z",
        days: [{
          date: "2026-08-17",
          events: [{ id: "cpi", title: "US CPI", time: "12:30", importance: 3, source: { label: "BLS" } }],
        }],
      }),
      sourceManifest: [{ id: "bls", status: "verified" }],
    };
  }
  return {
    product,
    slug: "us-cpi/2026-08-21",
    article: { title: "US CPI", tierDecision: { tier: "tier-one" } },
    communityDocument: { templateId: "data-update-community", tierDecision: { tier: "tier-one" }, nodes: [] },
    posterModel: buildDataUpdatePosterModel({
      generatedAt: "2026-08-21T12:45:00.000Z",
      title: "US CPI Released",
      values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" },
      source: { label: "BLS" },
    }),
    sourceManifest: [{ id: "bls", status: "verified" }],
  };
}

function encodedPoster(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

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

test("market intelligence poster renders the verified order-book snapshot as its evidence", async () => {
  const source = await readFile(new URL("../app/api/media/card/route.js", import.meta.url), "utf8");
  assert.match(source, /DEMO PREVIEW/);
  assert.match(source, /ORDER BOOK SNAPSHOT/);
  assert.match(source, /VISIBLE LIQUIDITY · VERIFIABLE MARKET EVIDENCE/);
  assert.match(source, /VISIBLE ORDERS · NOT EXECUTED TRADES · CAN MOVE OR CANCEL/);
  assert.match(source, /EVIDENCE SNAPSHOT UNAVAILABLE/);
  assert.match(source, /poster\.evidenceSnapshot/);
  assert.doesNotMatch(source, /SMART MONEY SIGNAL/);
});

test("market intelligence evidence poster completes a landscape PNG render", async () => {
  const { GET } = await import("../app/api/media/card/route.js");
  const poster = {
    pair: "BTC / USDT",
    signal: "VISIBLE BID",
    amount: "$12M",
    price: "$60,000",
    status: "P1 · POSITIVE · SCORE 88",
    interpretation: "Visible buy-side liquidity may reinforce nearby support while it remains.",
    evidenceSnapshot: {
      provider: "Binance Futures",
      sourceTimestamp: "2026-08-26T08:00:00.000Z",
      markPrice: "60050",
      rows: [
        { side: "ASK", price: "60130", quantity: "2", visibleNotional: "120260", visibleNotionalLabel: "$120.3K" },
        { side: "ASK", price: "60120", quantity: "3", visibleNotional: "180360", visibleNotionalLabel: "$180.4K" },
        { side: "ASK", price: "60110", quantity: "4", visibleNotional: "240440", visibleNotionalLabel: "$240.4K" },
        { side: "ASK", price: "60100", quantity: "5", visibleNotional: "300500", visibleNotionalLabel: "$300.5K" },
        { side: "BID", price: "60000", quantity: "200", visibleNotional: "12000000", visibleNotionalLabel: "$12M", isFocus: true },
        { side: "BID", price: "59990", quantity: "6", visibleNotional: "359940", visibleNotionalLabel: "$359.9K" },
        { side: "BID", price: "59980", quantity: "7", visibleNotional: "419860", visibleNotionalLabel: "$419.9K" },
        { side: "BID", price: "59970", quantity: "8", visibleNotional: "479760", visibleNotionalLabel: "$479.8K" },
      ],
    },
  };
  const response = await GET(new Request(`${EDITORIAL_ORIGIN}/api/media/card?kind=whale&demo=1&data=${encodedPoster(poster)}`));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^image\/png/);
  const png = Buffer.from(await response.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 675);
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

test("weekly and data previews use the warm editorial research system", async () => {
  const source = await readFile(new URL("../app/api/media/card/route.js", import.meta.url), "utf8");
  const weeklyStart = source.indexOf('if (kind === "weekly-calendar")');
  const dataStart = source.indexOf('if (kind === "data-update")');
  const nextKind = source.indexOf('if (kind === "events")');
  assert.ok(weeklyStart > -1 && dataStart > weeklyStart && nextKind > dataStart);

  const weeklyBranch = source.slice(weeklyStart, dataStart);
  const dataBranch = source.slice(dataStart, nextKind);
  for (const branch of [weeklyBranch, dataBranch]) {
    assert.match(branch, /editorialCanvas\(\)/);
    assert.match(branch, /editorialResearchHeader/);
    assert.match(branch, /editorialResearchFooter/);
    assert.doesNotMatch(branch, /terminal(?:Canvas|Grid|Header|Footer|Stat|Value|MiniMetric)/);
  }
  assert.match(weeklyBranch, /priority/i);
  assert.match(weeklyBranch, /sources/i);
  assert.match(dataBranch, /ACTUAL/);
  assert.match(dataBranch, /SURPRISE/);
  assert.match(dataBranch, /CROSS-ASSET REACTION/);
});

test("V4 media previews preserve the locked master approval fields", async () => {
  const source = await readFile(new URL("../app/api/media/card/route.js", import.meta.url), "utf8");
  assert.match(source, /sha256:\s*approved\.sha256/);
  assert.match(source, /composition:\s*approved\.composition/);

  const { GET } = await import("../app/api/media/card/route.js");
  const poster = {
    kind: "crypto-daily",
    date: "2026-08-24",
    stories: [{ rank: "01", title: "BTC holds above verified session support", source: "CoinGecko", score: 82 }],
  };
  poster.visualTemplate = selectMarketPosterTemplate({ jobId: "crypto-daily", poster });
  const response = await GET(new Request(`${EDITORIAL_ORIGIN}/api/media/card?kind=crypto-daily&data=${encodedPoster(poster)}`));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^image\/png/);
  const png = Buffer.from(await response.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 675);
});

test("weekly and data preview handlers safely render hostile poster JSON", async () => {
  const { GET } = await import("../app/api/media/card/route.js");
  const cases = [
    ["weekly-calendar", { columns: { length: 5 }, footer: { sources: null } }],
    ["weekly-calendar", {
      columns: [null, 7, { date: {}, label: [], events: null }, {
        date: "2026-08-21",
        label: "FRI 21",
        events: [null, 9, { title: {}, source: [], isPriority: "yes" }],
      }],
      footer: { sources: [{ label: "hostile" }], updatedAt: {} },
    }],
    ["data-update", { title: "CPI", indicator: "CPI", reactions: { map: "not callable" } }],
    ["data-update", {
      title: "CPI",
      indicator: { unsafe: true },
      reactions: [null, 4, { symbol: {}, label: [], value: { unsafe: true } }],
      footer: { sources: null, updatedAt: [] },
    }],
  ];

  for (const [kind, poster] of cases) {
    const url = `${EDITORIAL_ORIGIN}/api/media/card?kind=${kind}&data=${encodedPoster(poster)}`;
    const response = await GET(new Request(url));
    assert.equal(response.status, 200, kind);
    const body = Buffer.from(await response.arrayBuffer());
    assert.ok(body.byteLength > 100, `${kind} must finish streaming a PNG response`);
    assert.match(response.headers.get("content-type") ?? "", /^image\/png/);
  }
});

test("durable editorial media route accepts only canonical weekly and data publication identities", async () => {
  const { GET } = await import("../app/api/media/editorial/[product]/[slug]/route.js");
  const repository = new EditorialMemoryRepository();

  for (const [product, slug, expectedStatus] of [
    ["crypto-daily", "2026-08-21", 404],
    ["weekly-calendar", "2026-W00", 400],
    ["data-update", "US%20CPI%2F2026-08-21", 400],
  ]) {
    const response = await GET(new Request(`${EDITORIAL_ORIGIN}/api/media/editorial/${product}/${slug}`), {
      params: Promise.resolve({ product, slug }),
      repository,
    });
    assert.equal(response.status, expectedStatus);
    assert.deepEqual(repository.lookups, [], `${product}/${slug} must fail before repository access`);
  }

  for (const [product, slug, expectedKey] of [
    ["weekly-calendar", "2026-W34", marketPublicationKey("weekly-calendar", "2026-W34")],
    ["data-update", "us-cpi%2F2026-08-21", marketPublicationKey("data-update", "us-cpi/2026-08-21")],
  ]) {
    repository.lookups = [];
    const response = await GET(new Request(`${EDITORIAL_ORIGIN}/api/media/editorial/${product}/${slug}`), {
      params: Promise.resolve({ product, slug }),
      repository,
    });
    assert.equal(response.status, 404);
    assert.deepEqual(repository.lookups, [expectedKey]);
  }

  const malformed = editorialDraft();
  malformed.posterModel = {};
  await createMarketPublication({ repository, ...malformed, now: () => "2026-08-21T00:00:00.000Z" });
  const malformedResponse = await GET(new Request(`${EDITORIAL_ORIGIN}/api/media/editorial/weekly-calendar/2026-W34`), {
    params: Promise.resolve({ product: malformed.product, slug: malformed.slug }),
    repository,
  });
  assert.equal(malformedResponse.status, 422);
});

test("durable editorial media rejects nested render hazards before opening a PNG stream", async () => {
  const { GET } = await import("../app/api/media/editorial/[product]/[slug]/route.js");
  const cases = [
    ["weekly-calendar", (model) => { model.title = { unsafe: true }; }],
    ["weekly-calendar", (model) => { model.columns[0].events = [null]; }],
    ["weekly-calendar", (model) => { model.columns[0].events[0].source = ["BLS"]; }],
    ["data-update", (model) => { model.title = { unsafe: true }; }],
    ["data-update", (model) => { model.reactions = [null]; }],
    ["data-update", (model) => {
      model.reactions = [{ symbol: "BTC", label: "+0.4%", value: "0.4" }];
    }],
  ];

  for (const [product, mutate] of cases) {
    const repository = new EditorialMemoryRepository();
    const draft = editorialDraft(product);
    mutate(draft.posterModel);
    await createMarketPublication({ repository, ...draft, now: () => "2026-08-21T00:00:00.000Z" });
    const encodedSlug = draft.slug.replace("/", "%2F");
    const response = await GET(new Request(`${EDITORIAL_ORIGIN}/api/media/editorial/${product}/${encodedSlug}`), {
      params: Promise.resolve({ product, slug: encodedSlug }),
      repository,
    });
    assert.equal(response.status, 422, `${product} malformed poster must fail before streaming`);
    assert.match(await response.text(), /cannot be rendered/i);
  }
});

test("durable editorial media accepts canonical nullable data leaves", async () => {
  const { GET } = await import("../app/api/media/editorial/[product]/[slug]/route.js");
  const repository = new EditorialMemoryRepository();
  const draft = editorialDraft("data-update");
  draft.posterModel = buildDataUpdatePosterModel({
    generatedAt: "2026-08-21T12:45:00.000Z",
    title: "US CPI Released",
    values: { actual: "2.7%" },
    source: { label: "BLS" },
  });
  await createMarketPublication({ repository, ...draft, now: () => "2026-08-21T00:00:00.000Z" });
  const response = await GET(new Request(`${EDITORIAL_ORIGIN}/api/media/editorial/data-update/us-cpi%2F2026-08-21`), {
    params: Promise.resolve({ product: draft.product, slug: "us-cpi%2F2026-08-21" }),
    repository,
  });
  assert.equal(response.status, 200);
  assert.ok((await response.arrayBuffer()).byteLength > 100);
});

test("durable editorial media renders V4 publications on the landscape canvas", async () => {
  const { GET } = await import("../app/api/media/editorial/[product]/[slug]/route.js");
  const repository = new EditorialMemoryRepository();
  const draft = editorialDraft("data-update");
  draft.posterModel.visualTemplate = selectMarketPosterTemplate({
    jobId: "data-release-updates",
    poster: draft.posterModel,
  });
  await createMarketPublication({ repository, ...draft, now: () => "2026-08-21T00:00:00.000Z" });
  const response = await GET(new Request(`${EDITORIAL_ORIGIN}/api/media/editorial/data-update/us-cpi%2F2026-08-21`), {
    params: Promise.resolve({ product: draft.product, slug: "us-cpi%2F2026-08-21" }),
    repository,
  });
  assert.equal(response.status, 200);
  const png = Buffer.from(await response.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 675);
});

test("durable editorial media route renders only drafts and serves persisted PNG bytes immutably", async () => {
  const { GET } = await import("../app/api/media/editorial/[product]/[slug]/route.js");
  const weeklyRepository = new EditorialMemoryRepository();
  const weekly = editorialDraft();
  await createMarketPublication({ repository: weeklyRepository, ...weekly, now: () => "2026-08-21T00:00:00.000Z" });
  weeklyRepository.lookups = [];
  const draftResponse = await GET(new Request(`${EDITORIAL_ORIGIN}/api/media/editorial/weekly-calendar/2026-W34`), {
    params: Promise.resolve({ product: weekly.product, slug: weekly.slug }),
    repository: weeklyRepository,
  });
  assert.equal(draftResponse.status, 200);
  assert.match(draftResponse.headers.get("content-type") ?? "", /^image\/png/);
  assert.equal(draftResponse.headers.get("cache-control"), "no-store");

  const dataRepository = new EditorialMemoryRepository();
  const data = editorialDraft("data-update");
  const image = editorialPng();
  await createMarketPublication({ repository: dataRepository, ...data, now: () => "2026-08-21T00:00:00.000Z" });
  await captureEditorialImage({
    repository: dataRepository,
    product: data.product,
    slug: data.slug,
    publicOrigin: EDITORIAL_ORIGIN,
    allowedOrigins: [EDITORIAL_ORIGIN],
    now: () => "2026-08-21T00:00:01.000Z",
    fetchImpl: async (url) => {
      const response = new Response(image, { headers: { "content-type": "image/png" } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    },
  });
  dataRepository.lookups = [];
  const storedResponse = await GET(new Request(`${EDITORIAL_ORIGIN}/api/media/editorial/data-update/us-cpi%2F2026-08-21`), {
    params: Promise.resolve({ product: data.product, slug: "us-cpi%2F2026-08-21" }),
    repository: dataRepository,
  });
  assert.equal(storedResponse.status, 200);
  assert.equal(storedResponse.headers.get("content-type"), "image/png");
  assert.equal(storedResponse.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(storedResponse.headers.get("etag"), `"${createHash("sha256").update(image).digest("hex")}"`);
  assert.deepEqual(Buffer.from(await storedResponse.arrayBuffer()), image);
  assert.deepEqual(dataRepository.lookups, [marketPublicationKey(data.product, data.slug)]);

  const notModified = await GET(new Request(`${EDITORIAL_ORIGIN}/api/media/editorial/data-update/us-cpi%2F2026-08-21`, {
    headers: { "If-None-Match": storedResponse.headers.get("etag") },
  }), {
    params: Promise.resolve({ product: data.product, slug: "us-cpi%2F2026-08-21" }),
    repository: dataRepository,
  });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get("cache-control"), "public, max-age=31536000, immutable");

  for (const method of ["GET", "HEAD"]) {
    const weakMatch = await GET(new Request(`${EDITORIAL_ORIGIN}/api/media/editorial/data-update/us-cpi%2F2026-08-21`, {
      method,
      headers: { "If-None-Match": `"not-this-one", W/${storedResponse.headers.get("etag")}` },
    }), {
      params: Promise.resolve({ product: data.product, slug: "us-cpi%2F2026-08-21" }),
      repository: dataRepository,
    });
    assert.equal(weakMatch.status, 304, `${method} must use weak If-None-Match comparison`);
    assert.equal(weakMatch.headers.get("etag"), storedResponse.headers.get("etag"));
    assert.equal(await weakMatch.text(), "");
  }
});
