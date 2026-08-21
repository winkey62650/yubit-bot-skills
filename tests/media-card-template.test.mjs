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
});
