import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { JsonDistributionRepository, PostgresDistributionRepository } from "../lib/distribution-repository.mjs";
import {
  captureEditorialImage as capturePublicationImage,
  createMarketPublication,
  dataUpdateArticlePath,
  editorialAssetPath,
  getMarketPublication,
  marketPublicationKey,
  verifyPublicPublication as verifyPublication,
  weeklyCalendarArticlePath,
} from "../lib/market-publication.mjs";

const NOW = "2026-08-21T00:00:00.000Z";
const ORIGIN = "https://academy.yubit.com";
const ALLOWED = [ORIGIN];
const PNG_SIGNATURE_FOR_TEST = Buffer.from("89504e470d0a1a0a", "hex");
const MAX_EDITORIAL_IMAGE_BYTES = 5 * 1024 * 1024;

class MemoryRepository {
  constructor(store = new Map()) { this.store = store; }
  async getMeta(key) { return structuredClone(this.store.get(key) ?? null); }
  async setMeta(key, value) {
    this.store.set(key, structuredClone(value));
    return structuredClone(value);
  }
  async compareAndSetMeta(key, expected, value) {
    const current = this.store.get(key) ?? null;
    if (expected?.absent === true) {
      if (current !== null) return null;
    } else if (Object.entries(expected ?? {}).some(([field, expectedValue]) => field !== "absent" && current?.[field] !== expectedValue)) {
      return null;
    }
    this.store.set(key, structuredClone(value));
    return structuredClone(value);
  }
}

function captureEditorialImage(options) {
  return capturePublicationImage({ allowedOrigins: ALLOWED, ...options });
}

function verifyPublicPublication(options) {
  return verifyPublication({ allowedOrigins: ALLOWED, ...options });
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

function png(width = 1200, height = 675, payloadBytes = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1;
  header[9] = 0;
  const rowBytes = Math.ceil(width / 8);
  const pixels = Buffer.alloc((rowBytes + 1) * height);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    ...(payloadBytes ? [pngChunk("tEXt", Buffer.alloc(payloadBytes, 0x61))] : []),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND"),
  ]);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function response(body, { status = 200, contentType = "image/png", contentLength, url = "" } = {}) {
  const headers = { "content-type": contentType };
  if (contentLength !== undefined) headers["content-length"] = String(contentLength);
  const value = new Response(body, { status, headers });
  if (url) Object.defineProperty(value, "url", { value: url });
  return value;
}

function draftInput(overrides = {}) {
  return {
    product: "weekly-calendar",
    slug: "2026-W34",
    article: { title: "Weekly Market Risk Playbook" },
    communityDocument: { nodes: [{ type: "paragraph", text: "Core view" }] },
    posterModel: { canvas: { width: 1200, height: 675 } },
    sourceManifest: [{ id: "bls-calendar", status: "verified" }],
    ...overrides,
  };
}

test("canonical publication paths reject malformed input instead of cleaning it", () => {
  assert.equal(weeklyCalendarArticlePath("2026-W34"), "/market-calendar/2026-W34");
  assert.equal(dataUpdateArticlePath("us-cpi", "2026-08-12"), "/data-updates/us-cpi/2026-08-12");
  assert.equal(editorialAssetPath("weekly-calendar", "2026-W34"), "/api/media/editorial/weekly-calendar/2026-W34");
  assert.equal(editorialAssetPath("data-update", "us-cpi/2026-08-12"), "/api/media/editorial/data-update/us-cpi%2F2026-08-12");
  assert.throws(() => weeklyCalendarArticlePath(" 2026-W34 "), /canonical|ISO week/i);
  assert.throws(() => weeklyCalendarArticlePath("2021-W53"), /canonical|ISO week/i);
  assert.throws(() => dataUpdateArticlePath("US CPI", "2026-8-12"), /canonical/i);
  assert.throws(() => editorialAssetPath("data-update", "../secret/2026-08-12"), /canonical/i);
});

test("one versioned bundle persists draft, rendered and verified lifecycle across repository restart", async () => {
  const store = new Map();
  const repository = new MemoryRepository(store);
  const draft = await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
  const key = marketPublicationKey("weekly-calendar", "2026-W34");
  assert.equal(key, "market-editorial-v1:weekly-calendar:2026-W34");
  assert.deepEqual(Object.keys(draft), [
    "version", "product", "slug", "status", "contentHash", "article", "communityDocument",
    "posterModel", "sourceManifest", "imageAsset", "health", "createdAt", "updatedAt",
  ]);
  assert.equal(draft.version, "market-publication-v1");
  assert.equal(draft.status, "draft");
  assert.match(draft.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(draft.createdAt, NOW);
  assert.equal((await repository.getMeta(key)).status, "draft");

  const image = png();
  const rendered = await captureEditorialImage({
    repository: new MemoryRepository(store), product: draft.product, slug: draft.slug,
    publicOrigin: ORIGIN, now: () => NOW,
    fetchImpl: async (url, init) => {
      assert.equal(url, `${ORIGIN}${editorialAssetPath(draft.product, draft.slug)}`);
      assert.equal(init.redirect, "manual");
      return response(image, { url });
    },
  });
  assert.equal(rendered.status, "rendered");
  assert.deepEqual(rendered.imageAsset, {
    mimeType: "image/png", width: 1200, height: 675, byteLength: image.byteLength,
    sha256: createHash("sha256").update(image).digest("hex"), base64: image.toString("base64"), renderedAt: NOW,
  });

  const verified = await verifyPublicPublication({
    repository: new MemoryRepository(store), product: draft.product, slug: draft.slug,
    publicOrigin: ORIGIN, now: () => NOW,
    fetchImpl: async (url) => url.includes("/market-calendar/")
      ? response(`<article data-content-hash="${draft.contentHash}">ok</article>`, { contentType: "text/html; charset=utf-8", url })
      : response(image, { url }),
  });
  assert.equal(verified.status, "verified");
  assert.deepEqual(verified.health, { page: "ok", image: "ok", checkedAt: NOW });
  assert.equal((await getMarketPublication({ repository: new MemoryRepository(store), product: draft.product, slug: draft.slug })).status, "verified");
});

test("capture rejects HTTP failures, wrong MIME, wrong dimensions and oversized images without replacing a trusted asset", async () => {
  for (const [name, factory, message, maxBytes] of [
    ["image 500", (url) => response("error", { status: 500, contentType: "text/plain", url }), /status 200/i],
    ["wrong MIME", (url) => response(png(), { contentType: "image/jpeg", url }), /image\/png/i],
    ["wrong dimensions", (url) => response(png(1199, 675), { url }), /1200.*675/i],
    ["byte cap", (url) => response(png(1200, 675, 100), { url }), /byte limit|too large/i, 64],
  ]) {
    const repository = new MemoryRepository();
    await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
    await assert.rejects(
      captureEditorialImage({ repository, product: "weekly-calendar", slug: "2026-W34", publicOrigin: ORIGIN, ...(maxBytes ? { maxBytes } : {}), fetchImpl: async (url) => factory(url), now: () => NOW }),
      message,
      name,
    );
    const failed = await getMarketPublication({ repository, product: "weekly-calendar", slug: "2026-W34" });
    assert.equal(failed.status, "draft");
    assert.equal(failed.imageAsset, null);
    assert.equal(failed.health.image, "failed");
    assert.match(failed.health.error.message, message);
  }

  const repository = new MemoryRepository();
  await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
  await captureEditorialImage({ repository, product: "weekly-calendar", slug: "2026-W34", publicOrigin: ORIGIN, fetchImpl: async (url) => response(png(), { url }), now: () => NOW });
  const trusted = (await getMarketPublication({ repository, product: "weekly-calendar", slug: "2026-W34" })).imageAsset;
  await assert.rejects(captureEditorialImage({ repository, product: "weekly-calendar", slug: "2026-W34", publicOrigin: ORIGIN, fetchImpl: async (url) => response(png(900, 675), { url }), now: () => NOW }), /1200.*675/i);
  assert.deepEqual((await getMarketPublication({ repository, product: "weekly-calendar", slug: "2026-W34" })).imageAsset, trusted);
});

test("tier-one verification persists page and image failure evidence without advancing verified", async () => {
  for (const [name, fetchImpl, message, failedPart] of [
    ["page 404", async (url) => response("missing", { status: 404, contentType: "text/html", url }), /page.*200/i, "page"],
    ["image 500", async (url) => url.includes("market-calendar")
      ? response(`<i data-content-hash="HASH"></i>`, { contentType: "text/html", url })
      : response("error", { status: 500, contentType: "text/plain", url }), /image.*200/i, "image"],
  ]) {
    const repository = new MemoryRepository();
    const draft = await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
    await captureEditorialImage({ repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, fetchImpl: async (url) => response(png(), { url }), now: () => NOW });
    const wrappedFetch = name === "image 500"
      ? async (url) => fetchImpl(url).then(async (item) => {
        if (url.includes("market-calendar")) return response(`<article data-content-hash="${draft.contentHash}"></article>`, { contentType: "text/html", url });
        return item;
      })
      : fetchImpl;
    await assert.rejects(verifyPublicPublication({ repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, fetchImpl: wrappedFetch, now: () => NOW }), message, name);
    const failed = await getMarketPublication({ repository, product: draft.product, slug: draft.slug });
    assert.equal(failed.status, "rendered");
    assert.equal(failed.health[failedPart], "failed");
    assert.equal(failed.imageAsset.width, 1200);
  }
});

test("verification rejects wrong MIME, image hash mismatch and an absent article hash marker", async () => {
  for (const [kind, imageResponse, pageBody, message] of [
    ["wrong MIME", (url) => response(png(), { contentType: "image/jpeg", url }), null, /image\/png/i],
    ["hash mismatch", (url) => response(png(1200, 675, 1), { url }), null, /hash/i],
    ["article marker", (url) => response(png(), { url }), "<article>no marker</article>", /content hash/i],
  ]) {
    const repository = new MemoryRepository();
    const draft = await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
    await captureEditorialImage({ repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, fetchImpl: async (url) => response(png(), { url }), now: () => NOW });
    await assert.rejects(verifyPublicPublication({
      repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, now: () => NOW,
      fetchImpl: async (url) => url.includes("market-calendar")
        ? response(pageBody ?? `<article data-content-hash="${draft.contentHash}"></article>`, { contentType: "text/html", url })
        : imageResponse(url),
    }), message, kind);
    assert.equal((await getMarketPublication({ repository, product: draft.product, slug: draft.slug })).status, "rendered");
  }
});

test("production origin rejects localhost, private IPs, credentials, HTTP and redirect boundary changes", async () => {
  for (const origin of ["http://academy.yubit.com", "https://localhost:3000", "https://127.0.0.1", "https://10.0.0.2", "https://user:pass@academy.yubit.com"]) {
    const repository = new MemoryRepository();
    await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
    await assert.rejects(captureEditorialImage({ repository, product: "weekly-calendar", slug: "2026-W34", publicOrigin: origin, fetchImpl: async () => response(png()), now: () => NOW }), /public HTTPS origin|credentials|private|localhost/i);
  }

  const repository = new MemoryRepository();
  await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
  await assert.rejects(captureEditorialImage({
    repository, product: "weekly-calendar", slug: "2026-W34", publicOrigin: ORIGIN, now: () => NOW,
    fetchImpl: async () => response(png(), { url: "https://evil.example/api/media/editorial/weekly-calendar/2026-W34" }),
  }), /response URL|origin/i);

  const publicRepository = new MemoryRepository();
  await createMarketPublication({ repository: publicRepository, ...draftInput(), now: () => NOW });
  const publicCapture = await captureEditorialImage({
    repository: publicRepository,
    product: "weekly-calendar",
    slug: "2026-W34",
    publicOrigin: "https://fca.example",
    allowedOrigins: ["https://fca.example"],
    fetchImpl: async (url) => response(png(), { url }),
    now: () => NOW,
  });
  assert.equal(publicCapture.status, "rendered", "ordinary hostnames beginning with fc are not IPv6 private addresses");
});

test("secondary Data Update verifies only its image endpoint", async () => {
  const repository = new MemoryRepository();
  const calls = [];
  await createMarketPublication({
    repository,
    ...draftInput({
      product: "data-update",
      slug: "us-retail-sales/2026-08-21",
      article: null,
      communityDocument: { tierDecision: { tier: "secondary" }, nodes: [] },
    }),
    now: () => NOW,
  });
  await captureEditorialImage({ repository, product: "data-update", slug: "us-retail-sales/2026-08-21", publicOrigin: ORIGIN, fetchImpl: async (url) => response(png(), { url }), now: () => NOW });
  const verified = await verifyPublicPublication({
    repository, product: "data-update", slug: "us-retail-sales/2026-08-21", publicOrigin: ORIGIN, now: () => NOW,
    fetchImpl: async (url) => { calls.push(url); return response(png(), { url }); },
  });
  assert.equal(verified.status, "verified");
  assert.deepEqual(verified.health, { page: "not-applicable", image: "ok", checkedAt: NOW });
  assert.deepEqual(calls, [`${ORIGIN}${editorialAssetPath("data-update", "us-retail-sales/2026-08-21")}`]);
});

test("inputs are not mutated and recreating a durable identity cannot regress its lifecycle", async () => {
  const repository = new MemoryRepository();
  const input = draftInput();
  const before = structuredClone(input);
  await createMarketPublication({ repository, ...input, now: () => NOW });
  await captureEditorialImage({ repository, product: input.product, slug: input.slug, publicOrigin: ORIGIN, fetchImpl: async (url) => response(png(), { url }), now: () => NOW });
  const replay = await createMarketPublication({ repository, ...input, now: () => NOW });
  assert.equal(replay.status, "rendered");
  assert.deepEqual(input, before);
  assert.equal((await getMarketPublication({ repository, product: input.product, slug: input.slug })).status, "rendered");

  await assert.rejects(createMarketPublication({
    repository,
    ...input,
    communityDocument: { nodes: [{ type: "paragraph", text: "Changed after persistence" }] },
    now: () => NOW,
  }), /different market publication/i);
});

test("verification precondition failures are durable and verified captures are idempotent", async () => {
  const repository = new MemoryRepository();
  const draft = await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
  await assert.rejects(verifyPublicPublication({
    repository,
    product: draft.product,
    slug: draft.slug,
    publicOrigin: ORIGIN,
    fetchImpl: async () => { throw new Error("must not fetch an unrendered publication"); },
    now: () => NOW,
  }), /stored rendered image/i);
  const failed = await getMarketPublication({ repository, product: draft.product, slug: draft.slug });
  assert.equal(failed.status, "draft");
  assert.equal(failed.health.image, "failed");

  await captureEditorialImage({ repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, fetchImpl: async (url) => response(png(), { url }), now: () => NOW });
  const verified = await verifyPublicPublication({
    repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, now: () => NOW,
    fetchImpl: async (url) => url.includes("market-calendar")
      ? response(`<article data-content-hash="${draft.contentHash}"></article>`, { contentType: "text/html", url })
      : response(png(), { url }),
  });
  let recaptureCalls = 0;
  const replay = await captureEditorialImage({
    repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, now: () => NOW,
    fetchImpl: async () => { recaptureCalls += 1; return response(png(1200, 675, 1)); },
  });
  assert.equal(recaptureCalls, 0);
  assert.deepEqual(replay, verified);
});

test("image byte cap stops reading a streaming response as soon as the limit is crossed", async () => {
  const repository = new MemoryRepository();
  await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(32));
      if (pulls === 10) controller.close();
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(captureEditorialImage({
    repository,
    product: "weekly-calendar",
    slug: "2026-W34",
    publicOrigin: ORIGIN,
    maxBytes: 64,
    fetchImpl: async (url) => response(body, { url }),
    now: () => NOW,
  }), /byte limit/i);
  assert.equal(cancelled, true);
  assert.ok(pulls < 10, `expected early stream cancellation, received ${pulls} chunks`);
});

test("publication tier classification rejects every conflicting article and community combination", async () => {
  const conflicts = [
    {
      article: { tierDecision: { tier: "tier-one" } },
      communityDocument: { templateId: "data-update-secondary-community", tierDecision: { tier: "secondary" } },
    },
    {
      article: null,
      communityDocument: { templateId: "data-update-community", tierDecision: { tier: "tier-one" } },
    },
    {
      article: { tierDecision: { tier: "secondary" } },
      communityDocument: { templateId: "data-update-community", tierDecision: { tier: "tier-one" } },
    },
    {
      article: null,
      communityDocument: { templateId: "weekly-calendar-community", tierDecision: { tier: "secondary" } },
    },
    {
      article: { tierDecision: { tier: "tier-one" } },
      communityDocument: { templateId: "weekly-calendar-community", tierDecision: { tier: "tier-one" } },
    },
  ];
  for (const conflict of conflicts) {
    await assert.rejects(createMarketPublication({
      repository: new MemoryRepository(),
      ...draftInput({ product: "data-update", slug: "us-cpi/2026-08-21", ...conflict }),
      now: () => NOW,
    }), /tier|classification|conflict/i);
  }

  await assert.rejects(createMarketPublication({
    repository: new MemoryRepository(),
    ...draftInput({
      article: { tierDecision: { tier: "secondary" } },
      communityDocument: { templateId: "weekly-calendar-community", tierDecision: { tier: "secondary" } },
    }),
    now: () => NOW,
  }), /tier|classification|conflict/i);

  const repository = new MemoryRepository();
  const article = { title: "CPI", tierDecision: { tier: "tier-one" } };
  const communityDocument = { templateId: "data-update-community", tierDecision: { tier: "tier-one" } };
  const draft = await createMarketPublication({
    repository,
    ...draftInput({ product: "data-update", slug: "us-cpi/2026-08-21", article, communityDocument }),
    now: () => NOW,
  });
  await captureEditorialImage({
    repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN,
    fetchImpl: async (url) => response(png(), { url }), now: () => NOW,
  });
  const calls = [];
  await verifyPublicPublication({
    repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN,
    fetchImpl: async (url) => {
      calls.push(url);
      return url.includes("/data-updates/")
        ? response(`<article data-content-hash="${draft.contentHash}"></article>`, { contentType: "text/html", url })
        : response(png(), { url });
    },
    now: () => NOW,
  });
  assert.equal(calls.length, 2, "a consistent tier-one Data Update must verify both page and asset");
});

test("failed re-verification retracts verified trust while retaining the retryable asset and evidence", async () => {
  const repository = new MemoryRepository();
  const draft = await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
  await captureEditorialImage({ repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, fetchImpl: async (url) => response(png(), { url }), now: () => NOW });
  await verifyPublicPublication({
    repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, now: () => NOW,
    fetchImpl: async (url) => url.includes("market-calendar")
      ? response(`<article data-content-hash="${draft.contentHash}"></article>`, { contentType: "text/html", url })
      : response(png(), { url }),
  });
  await assert.rejects(verifyPublicPublication({
    repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, now: () => "2026-08-21T00:01:00.000Z",
    fetchImpl: async (url) => response("missing", { status: 404, contentType: "text/html", url }),
  }), /page.*200/i);
  const failed = await getMarketPublication({ repository, product: draft.product, slug: draft.slug });
  assert.equal(failed.status, "rendered");
  assert.equal(failed.health.page, "failed");
  assert.equal(failed.imageAsset.sha256, createHash("sha256").update(png()).digest("hex"));

  const recovered = await verifyPublicPublication({
    repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, now: () => "2026-08-21T00:02:00.000Z",
    fetchImpl: async (url) => url.includes("market-calendar")
      ? response(`<article data-content-hash="${draft.contentHash}"></article>`, { contentType: "text/html", url })
      : response(png(), { url }),
  });
  assert.equal(recovered.status, "verified");
});

test("public origin policy rejects mapped IPv6 and alternate non-public IPv4 representations before fetch", async () => {
  const origins = [
    "https://[::ffff:127.0.0.1]",
    "https://[0:0:0:0:0:ffff:7f00:1]",
    "https://[::ffff:10.0.0.1]",
    "https://[::ffff:6440:1]",
    "https://100.64.0.1",
    "https://0177.0.0.1",
    "https://2130706433",
    "https://0x7f000001",
    "https://[fe80::1]",
    "https://localhost.",
    "https://service.local.",
  ];
  for (const origin of origins) {
    const repository = new MemoryRepository();
    await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
    let fetches = 0;
    await assert.rejects(capturePublicationImage({
      repository, product: "weekly-calendar", slug: "2026-W34", publicOrigin: origin,
      allowedOrigins: [origin], fetchImpl: async () => { fetches += 1; return response(png()); }, now: () => NOW,
    }), /public|private|origin|IP/i, origin);
    assert.equal(fetches, 0, `${origin} must be rejected before fetch`);
  }
});

test("restart rejects incomplete bundles and every invalid lifecycle invariant", async () => {
  const identity = { product: "weekly-calendar", slug: "2026-W34" };
  const key = marketPublicationKey(identity.product, identity.slug);
  const repository = new MemoryRepository();
  await repository.setMeta(key, { version: "market-publication-v1", ...identity, status: "verified" });
  await assert.rejects(getMarketPublication({ repository, ...identity }), /malformed|contract|bundle/i);

  const cases = [
    (bundle) => ({ ...bundle, status: "rendered", imageAsset: null }),
    (bundle) => ({ ...bundle, contentHash: "0".repeat(64) }),
    (bundle) => ({ ...bundle, status: "verified", health: { page: "pending", image: "ok", checkedAt: NOW } }),
    (bundle) => ({ ...bundle, status: "rendered", imageAsset: { ...bundle.imageAsset, byteLength: bundle.imageAsset.byteLength + 1 } }),
  ];
  for (const corrupt of cases) {
    const store = new Map();
    const repo = new MemoryRepository(store);
    await createMarketPublication({ repository: repo, ...draftInput(), now: () => NOW });
    await captureEditorialImage({ repository: repo, ...identity, publicOrigin: ORIGIN, fetchImpl: async (url) => response(png(), { url }), now: () => NOW });
    const stored = await repo.getMeta(key);
    await repo.setMeta(key, corrupt(stored));
    await assert.rejects(getMarketPublication({ repository: new MemoryRepository(store), ...identity }), /malformed|contract|invariant|hash|asset/i);
  }
});

test("late capture and verification results cannot overwrite a newer durable publication state", async () => {
  const repository = new MemoryRepository();
  const draft = await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
  const enteredCapture = deferred();
  const releaseCapture = deferred();
  const oldImage = png(1200, 675, 1);
  const newImage = png(1200, 675, 2);
  const lateCapture = captureEditorialImage({
    repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN,
    fetchImpl: async (url) => { enteredCapture.resolve(); await releaseCapture.promise; return response(oldImage, { url }); },
    now: () => "2026-08-21T00:01:00.000Z",
  });
  await enteredCapture.promise;
  await captureEditorialImage({
    repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN,
    fetchImpl: async (url) => response(newImage, { url }), now: () => "2026-08-21T00:02:00.000Z",
  });
  await verifyPublicPublication({
    repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN,
    fetchImpl: async (url) => url.includes("market-calendar")
      ? response(`<article data-content-hash="${draft.contentHash}"></article>`, { contentType: "text/html", url })
      : response(newImage, { url }),
    now: () => "2026-08-21T00:03:00.000Z",
  });
  releaseCapture.resolve();
  await assert.rejects(lateCapture, /concurrent|stale/i);
  const afterCapture = await getMarketPublication({ repository, product: draft.product, slug: draft.slug });
  assert.equal(afterCapture.status, "verified");
  assert.equal(afterCapture.imageAsset.sha256, createHash("sha256").update(newImage).digest("hex"));

  const verifyRepository = new MemoryRepository();
  const verifyDraft = await createMarketPublication({ repository: verifyRepository, ...draftInput(), now: () => NOW });
  await captureEditorialImage({ repository: verifyRepository, product: verifyDraft.product, slug: verifyDraft.slug, publicOrigin: ORIGIN, fetchImpl: async (url) => response(oldImage, { url }), now: () => NOW });
  const enteredVerify = deferred();
  const releaseVerify = deferred();
  const lateVerify = verifyPublicPublication({
    repository: verifyRepository, product: verifyDraft.product, slug: verifyDraft.slug, publicOrigin: ORIGIN,
    fetchImpl: async (url) => {
      if (url.includes("market-calendar")) {
        enteredVerify.resolve();
        await releaseVerify.promise;
        return response(`<article data-content-hash="${verifyDraft.contentHash}"></article>`, { contentType: "text/html", url });
      }
      return response(oldImage, { url });
    },
    now: () => "2026-08-21T00:01:00.000Z",
  });
  await enteredVerify.promise;
  await captureEditorialImage({ repository: verifyRepository, product: verifyDraft.product, slug: verifyDraft.slug, publicOrigin: ORIGIN, fetchImpl: async (url) => response(newImage, { url }), now: () => "2026-08-21T00:02:00.000Z" });
  releaseVerify.resolve();
  await assert.rejects(lateVerify, /concurrent|stale/i);
  const afterVerify = await getMarketPublication({ repository: verifyRepository, product: verifyDraft.product, slug: verifyDraft.slug });
  assert.equal(afterVerify.status, "rendered");
  assert.equal(afterVerify.imageAsset.sha256, createHash("sha256").update(newImage).digest("hex"));
  assert.notEqual(afterVerify.health.page, "failed", "stale failure evidence must not overwrite newer health");

  const failureRepository = new MemoryRepository();
  const failureDraft = await createMarketPublication({ repository: failureRepository, ...draftInput(), now: () => NOW });
  await captureEditorialImage({ repository: failureRepository, product: failureDraft.product, slug: failureDraft.slug, publicOrigin: ORIGIN, fetchImpl: async (url) => response(oldImage, { url }), now: () => NOW });
  const enteredFailure = deferred();
  const releaseFailure = deferred();
  const lateFailure = verifyPublicPublication({
    repository: failureRepository, product: failureDraft.product, slug: failureDraft.slug, publicOrigin: ORIGIN,
    fetchImpl: async (url) => {
      enteredFailure.resolve();
      await releaseFailure.promise;
      return response("missing", { status: 404, contentType: "text/html", url });
    },
    now: () => "2026-08-21T00:01:00.000Z",
  });
  await enteredFailure.promise;
  await captureEditorialImage({ repository: failureRepository, product: failureDraft.product, slug: failureDraft.slug, publicOrigin: ORIGIN, fetchImpl: async (url) => response(newImage, { url }), now: () => "2026-08-21T00:02:00.000Z" });
  releaseFailure.resolve();
  await assert.rejects(lateFailure, /concurrent|stale/i);
  const afterFailure = await getMarketPublication({ repository: failureRepository, product: failureDraft.product, slug: failureDraft.slug });
  assert.equal(afterFailure.imageAsset.sha256, createHash("sha256").update(newImage).digest("hex"));
  assert.deepEqual(afterFailure.health, { page: "pending", image: "pending", checkedAt: null });
});

test("article marker must exist on canonical article markup, never comments scripts or plain text", async () => {
  const invalidMarkup = (hash) => [
    `<!-- <article data-content-hash="${hash}">hidden</article> -->`,
    `<script>const fake = '<article data-content-hash="${hash}">'</script>`,
    `<p>data-content-hash="${hash}"</p>`,
    `<div data-content-hash="${hash}"></div>`,
    `<article title='data-content-hash="${hash}"'></article>`,
    `<script><article data-content-hash="${hash}"></article>`,
    `<!-- <article data-content-hash="${hash}"></article>`,
  ];
  for (const htmlFactory of invalidMarkup("HASH")) {
    const repository = new MemoryRepository();
    const draft = await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
    await captureEditorialImage({ repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, fetchImpl: async (url) => response(png(), { url }), now: () => NOW });
    const html = htmlFactory.replace("HASH", draft.contentHash);
    await assert.rejects(verifyPublicPublication({
      repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN,
      fetchImpl: async (url) => url.includes("market-calendar")
        ? response(html, { contentType: "text/html", url })
        : response(png(), { url }),
      now: () => NOW,
    }), /content hash marker/i);
  }
});

test("PNG parser rejects bad CRC, truncated IHDR, missing IEND and oversized chunk declarations", async () => {
  const valid = png();
  const badCrc = Buffer.from(valid);
  badCrc[29] ^= 0xff;
  const hugeChunk = Buffer.concat([valid.subarray(0, 33), Buffer.from("7fffffff49444154", "hex"), Buffer.alloc(4)]);
  const corruptions = [
    [badCrc, /CRC/i],
    [valid.subarray(0, 24), /truncated|PNG|IHDR/i],
    [valid.subarray(0, -12), /IEND|truncated/i],
    [hugeChunk, /chunk|truncated|length/i],
  ];
  for (const [bytes, message] of corruptions) {
    const repository = new MemoryRepository();
    await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
    await assert.rejects(captureEditorialImage({
      repository, product: "weekly-calendar", slug: "2026-W34", publicOrigin: ORIGIN,
      fetchImpl: async (url) => response(bytes, { url }), now: () => NOW,
    }), message);
  }
});

test("canonical content hashing includes dangerous own property names without prototype collisions", async () => {
  const articles = [
    JSON.parse('{"title":"x"}'),
    JSON.parse('{"title":"x","__proto__":{"polluted":true}}'),
    JSON.parse('{"title":"x","constructor":{"polluted":true}}'),
    JSON.parse('{"title":"x","prototype":{"polluted":true}}'),
  ];
  const hashes = [];
  for (const article of articles) {
    const created = await createMarketPublication({ repository: new MemoryRepository(), ...draftInput({ article }), now: () => NOW });
    hashes.push(created.contentHash);
  }
  assert.equal(new Set(hashes).size, articles.length, "every own JSON key must affect the deterministic hash");
  assert.equal({}.polluted, undefined);

  const sparseWithExtra = [];
  sparseWithExtra.length = 1;
  sparseWithExtra.extra = "must-not-be-ignored";
  await assert.rejects(createMarketPublication({
    repository: new MemoryRepository(),
    ...draftInput({ article: { title: "x", values: sparseWithExtra } }),
    now: () => NOW,
  }), /array|own keys|JSON/i);

  const hiddenContent = { title: "x" };
  Object.defineProperty(hiddenContent, "hidden", { value: "must-not-disappear", enumerable: false });
  await assert.rejects(createMarketPublication({
    repository: new MemoryRepository(),
    ...draftInput({ article: hiddenContent }),
    now: () => NOW,
  }), /enumerable|JSON|data|content/i);

  const accessorContent = { title: "x" };
  Object.defineProperty(accessorContent, "derived", { enumerable: true, get: () => "must-not-be-evaluated" });
  await assert.rejects(createMarketPublication({
    repository: new MemoryRepository(),
    ...draftInput({ article: accessorContent }),
    now: () => NOW,
  }), /JSON|data|content/i);
});

test("secondary draft verification failure persists retryable image-stage evidence", async () => {
  const repository = new MemoryRepository();
  const input = draftInput({
    product: "data-update",
    slug: "us-cpi/2026-08-21",
    article: null,
    communityDocument: { templateId: "data-update-secondary-community", tierDecision: { tier: "secondary" } },
  });
  await createMarketPublication({ repository, ...input, now: () => NOW });
  await assert.rejects(verifyPublicPublication({
    repository,
    product: input.product,
    slug: input.slug,
    publicOrigin: ORIGIN,
    fetchImpl: async () => response("never"),
    now: () => NOW,
  }), /stored rendered image/i);
  const failed = await getMarketPublication({ repository, product: input.product, slug: input.slug });
  assert.equal(failed.status, "draft");
  assert.equal(failed.health.page, "not-applicable");
  assert.equal(failed.health.image, "failed");
  assert.equal(failed.health.error.stage, "image");
});

test("allowed origin set is mandatory, non-empty, canonical HTTPS and enforced before any fetch", async () => {
  for (const allowedOrigins of [undefined, [], ORIGIN, { origin: ORIGIN }, ["http://academy.yubit.com"], ["https://user@academy.yubit.com"], ["https://127.0.0.1"]]) {
    const repository = new MemoryRepository();
    await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
    let fetches = 0;
    await assert.rejects(capturePublicationImage({
      repository, product: "weekly-calendar", slug: "2026-W34", publicOrigin: ORIGIN,
      ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
      fetchImpl: async () => { fetches += 1; return response(png()); }, now: () => NOW,
    }), /allowed|allowlist|public HTTPS origin/i);
    assert.equal(fetches, 0);
  }

  const repository = new MemoryRepository();
  await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
  let fetchedUrl;
  const captured = await capturePublicationImage({
    repository, product: "weekly-calendar", slug: "2026-W34",
    publicOrigin: "https://ACADEMY.YUBIT.COM:443", allowedOrigins: ["https://academy.yubit.com"],
    fetchImpl: async (url) => { fetchedUrl = url; return response(png(), { url }); }, now: () => NOW,
  });
  assert.equal(captured.status, "rendered");
  assert.equal(fetchedUrl, `${ORIGIN}${editorialAssetPath("weekly-calendar", "2026-W34")}`);

  let verifyFetches = 0;
  await assert.rejects(verifyPublication({
    repository, product: "weekly-calendar", slug: "2026-W34", publicOrigin: ORIGIN,
    fetchImpl: async () => { verifyFetches += 1; return response("never"); }, now: () => NOW,
  }), /allowed|allowlist/i);
  assert.equal(verifyFetches, 0);
});

test("publication payload contract rejects every non-plain editorial document on create and restart", async () => {
  const invalidDocuments = [null, "text", [], new Date(NOW)];
  for (const field of ["article", "communityDocument", "posterModel"]) {
    for (const value of invalidDocuments) {
      if (field === "article" && value === null) continue;
      await assert.rejects(createMarketPublication({
        repository: new MemoryRepository(),
        ...draftInput({ [field]: value }),
        now: () => NOW,
      }), /plain|object|contract|article|community|poster/i, `${field}: ${String(value)}`);
    }
  }

  await assert.rejects(createMarketPublication({
    repository: new MemoryRepository(),
    ...draftInput({
      product: "data-update",
      slug: "us-cpi/2026-08-21",
      article: "not-null-secondary-article",
      communityDocument: { templateId: "data-update-secondary-community", tierDecision: { tier: "secondary" } },
    }),
    now: () => NOW,
  }), /article|secondary|plain|classification/i);

  const repository = new MemoryRepository();
  const draft = await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
  const key = marketPublicationKey(draft.product, draft.slug);
  const stored = await repository.getMeta(key);
  await repository.setMeta(key, { ...stored, posterModel: [] });
  await assert.rejects(getMarketPublication({ repository, product: draft.product, slug: draft.slug }), /plain|object|contract|poster/i);

  for (const entry of [null, "source-id", [], new Date(NOW)]) {
    await assert.rejects(createMarketPublication({
      repository: new MemoryRepository(),
      ...draftInput({ sourceManifest: [entry] }),
      now: () => NOW,
    }), /source|manifest|plain|object|contract/i);
  }
});

test("status health and failure evidence reject every impossible durable lifecycle state", async () => {
  const secondaryRepository = new MemoryRepository();
  const secondary = await createMarketPublication({
    repository: secondaryRepository,
    ...draftInput({
      product: "data-update",
      slug: "us-cpi/2026-08-21",
      article: null,
      communityDocument: { templateId: "data-update-secondary-community", tierDecision: { tier: "secondary" } },
    }),
    now: () => NOW,
  });
  assert.equal(secondary.health.page, "not-applicable");

  const baseRepository = new MemoryRepository();
  const draft = await createMarketPublication({ repository: baseRepository, ...draftInput(), now: () => NOW });
  const key = marketPublicationKey(draft.product, draft.slug);
  const cases = [
    { health: { page: "not-applicable", image: "pending", checkedAt: null } },
    { health: { page: "failed", image: "pending", checkedAt: NOW } },
    { health: { page: "pending", image: "pending", checkedAt: NOW, error: { stage: "page", name: "Error", message: "x", at: NOW } } },
    { health: { page: "pending", image: "failed", checkedAt: NOW, error: { stage: "page", name: "Error", message: "x", at: NOW } } },
    { health: { page: "pending", image: "pending", checkedAt: NOW } },
    { health: { page: "failed", image: "failed", checkedAt: NOW, error: { stage: "image", name: "Error", message: "x", at: NOW } } },
  ];
  for (const patch of cases) {
    const repository = new MemoryRepository();
    await repository.setMeta(key, { ...draft, ...patch });
    await assert.rejects(getMarketPublication({ repository, product: draft.product, slug: draft.slug }), /health|status|error|failure|invariant/i);
  }

  const secondaryKey = marketPublicationKey(secondary.product, secondary.slug);
  await secondaryRepository.setMeta(secondaryKey, { ...secondary, health: { page: "pending", image: "pending", checkedAt: null } });
  await assert.rejects(getMarketPublication({ repository: secondaryRepository, product: secondary.product, slug: secondary.slug }), /health|status|invariant/i);

  for (const renderedAt of ["2026-08-20T23:59:59.999Z", "2026-08-21T00:00:00.002Z"]) {
    const repository = new MemoryRepository();
    const created = await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
    await captureEditorialImage({
      repository, product: created.product, slug: created.slug, publicOrigin: ORIGIN,
      fetchImpl: async (url) => response(png(), { url }), now: () => NOW,
    });
    const rendered = await repository.getMeta(key);
    await repository.setMeta(key, { ...rendered, imageAsset: { ...rendered.imageAsset, renderedAt } });
    await assert.rejects(getMarketPublication({ repository, product: created.product, slug: created.slug }), /time|timestamp|asset|lifecycle|invariant/i);
  }

  const failedRepository = new MemoryRepository();
  const failedDraft = await createMarketPublication({ repository: failedRepository, ...draftInput(), now: () => NOW });
  await failedRepository.setMeta(key, {
    ...failedDraft,
    health: {
      page: "pending", image: "failed", checkedAt: "2026-08-20T23:59:59.999Z",
      error: { stage: "image", name: "Error", message: "x", at: "2026-08-20T23:59:59.999Z" },
    },
  });
  await assert.rejects(getMarketPublication({ repository: failedRepository, product: failedDraft.product, slug: failedDraft.slug }), /time|timestamp|health|lifecycle|invariant/i);

  const verifiedRepository = new MemoryRepository();
  const verifiedDraft = await createMarketPublication({ repository: verifiedRepository, ...draftInput(), now: () => NOW });
  const image = png();
  await captureEditorialImage({
    repository: verifiedRepository, product: verifiedDraft.product, slug: verifiedDraft.slug,
    publicOrigin: ORIGIN, fetchImpl: async (url) => response(image, { url }), now: () => NOW,
  });
  const verified = await verifyPublicPublication({
    repository: verifiedRepository, product: verifiedDraft.product, slug: verifiedDraft.slug,
    publicOrigin: ORIGIN,
    fetchImpl: async (url) => url.includes("market-calendar")
      ? response(`<article data-content-hash="${verifiedDraft.contentHash}"></article>`, { contentType: "text/html", url })
      : response(image, { url }),
    now: () => "2026-08-21T00:00:01.000Z",
  });
  await verifiedRepository.setMeta(key, {
    ...verified,
    imageAsset: { ...verified.imageAsset, renderedAt: "2026-08-21T00:00:02.000Z" },
    updatedAt: "2026-08-21T00:00:03.000Z",
  });
  await assert.rejects(getMarketPublication({ repository: verifiedRepository, product: verified.product, slug: verified.slug }), /time|timestamp|health|asset|lifecycle|invariant/i);
});

test("bounded HTML parsing accepts one real article marker and rejects raw text duplicates and broken tags", async () => {
  const invalidMarkup = (hash) => [
    `<textarea><article data-content-hash="${hash}"></article></textarea>`,
    `<style>.x{content:'<article data-content-hash="${hash}">'}</style>`,
    `<article data-content-hash="wrong" data-content-hash="${hash}"></article>`,
    `<article data-content-hash="${hash}" data-content-hash="${hash}"></article>`,
    `<article data-note='data-content-hash="${hash}"'></article>`,
    `<article data-content-hash="${hash}"`,
    `<article data-content-hash="${hash}"></article><article>`,
    `<article data-content-hash="${hash}"><div></article>`,
    `<article data-content-hash="${hash}"></article><div>`,
  ];
  for (const html of invalidMarkup("HASH")) {
    const repository = new MemoryRepository();
    const draft = await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
    const image = png();
    await captureEditorialImage({ repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, fetchImpl: async (url) => response(image, { url }), now: () => NOW });
    await assert.rejects(verifyPublicPublication({
      repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN,
      fetchImpl: async (url) => url.includes("market-calendar")
        ? response(html.replaceAll("HASH", draft.contentHash), { contentType: "text/html", url })
        : response(image, { url }),
      now: () => NOW,
    }), /content hash marker|HTML|markup/i);
  }
});

test("PNG validation requires a legal decodable pixel stream", async () => {
  const valid = png();
  const invalidColor = Buffer.from(valid);
  invalidColor[25] = 9;
  invalidColor.writeUInt32BE(crc32(invalidColor.subarray(12, 29)), 29);
  const header = valid.subarray(16, 29);
  const corruptions = [
    invalidColor,
    Buffer.concat([
      PNG_SIGNATURE_FOR_TEST, pngChunk("IHDR", header), pngChunk("PLTE", Buffer.from([0, 0, 0])),
      pngChunk("IDAT", deflateSync(Buffer.alloc((Math.ceil(1200 / 8) + 1) * 675))), pngChunk("IEND"),
    ]),
    Buffer.concat([PNG_SIGNATURE_FOR_TEST, pngChunk("IHDR", header), pngChunk("IDAT"), pngChunk("IEND")]),
    Buffer.concat([PNG_SIGNATURE_FOR_TEST, pngChunk("IHDR", header), pngChunk("IDAT", Buffer.from("garbage")), pngChunk("IEND")]),
    Buffer.concat([PNG_SIGNATURE_FOR_TEST, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(Buffer.from([0]))), pngChunk("IEND")]),
  ];
  for (const bytes of corruptions) {
    const repository = new MemoryRepository();
    await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
    await assert.rejects(captureEditorialImage({
      repository, product: "weekly-calendar", slug: "2026-W34", publicOrigin: ORIGIN,
      fetchImpl: async (url) => response(bytes, { url }), now: () => NOW,
    }), /PNG|IHDR|color|IDAT|inflate|pixel|scanline|zlib/i);
  }
});

test("fetch responses without a canonical final URL fail closed", async () => {
  const repository = new MemoryRepository();
  await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
  await assert.rejects(captureEditorialImage({
    repository, product: "weekly-calendar", slug: "2026-W34", publicOrigin: ORIGIN,
    fetchImpl: async () => response(png()), now: () => NOW,
  }), /response URL|final URL|boundary/i);
});

test("public origin policy rejects IPv6 site-local and documentation networks before fetch", async () => {
  for (const origin of ["https://[fec0::1]", "https://[feff::1]", "https://[2001:db8::1]", "https://192.88.99.1"]) {
    const repository = new MemoryRepository();
    await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
    let fetches = 0;
    await assert.rejects(capturePublicationImage({
      repository, product: "weekly-calendar", slug: "2026-W34", publicOrigin: origin,
      allowedOrigins: [origin], fetchImpl: async () => { fetches += 1; return response(png(), { url: origin }); }, now: () => NOW,
    }), /public|private|origin|IP/i);
    assert.equal(fetches, 0, `${origin} must fail before fetch`);
  }
});

test("content hash covers every durable editorial payload component", async () => {
  const repositories = [];
  const hashes = [];
  for (const override of [
    {},
    { communityDocument: { nodes: [{ type: "paragraph", text: "changed" }] } },
    { posterModel: { canvas: { width: 1200, height: 675 }, changed: true } },
    { sourceManifest: [{ id: "changed", status: "verified" }] },
  ]) {
    const repository = new MemoryRepository();
    repositories.push(repository);
    hashes.push((await createMarketPublication({ repository, ...draftInput(override), now: () => NOW })).contentHash);
  }
  assert.equal(new Set(hashes).size, hashes.length);

  for (const field of ["communityDocument", "posterModel", "sourceManifest"]) {
    const repository = new MemoryRepository();
    const draft = await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
    const key = marketPublicationKey(draft.product, draft.slug);
    const stored = await repository.getMeta(key);
    const replacement = field === "sourceManifest" ? [{ id: "tampered", status: "verified" }] : { tampered: true };
    await repository.setMeta(key, { ...stored, [field]: replacement });
    await assert.rejects(getMarketPublication({ repository, product: draft.product, slug: draft.slug }), /content hash|contract/i);
  }
});

test("durable image assets and capture limits cannot exceed the absolute hard ceiling", async () => {
  const repository = new MemoryRepository();
  const draft = await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
  let fetches = 0;
  await assert.rejects(captureEditorialImage({
    repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN,
    maxBytes: MAX_EDITORIAL_IMAGE_BYTES * 2,
    fetchImpl: async (url) => {
      fetches += 1;
      return response(Buffer.alloc(0), { url, contentLength: MAX_EDITORIAL_IMAGE_BYTES + 1 });
    },
    now: () => NOW,
  }), /byte limit|hard ceiling|too large/i);
  assert.equal(fetches, 1);

  const image = png();
  await captureEditorialImage({ repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, fetchImpl: async (url) => response(image, { url }), now: () => NOW });
  const key = marketPublicationKey(draft.product, draft.slug);
  const stored = await repository.getMeta(key);
  await repository.setMeta(key, { ...stored, imageAsset: { ...stored.imageAsset, byteLength: MAX_EDITORIAL_IMAGE_BYTES + 1 } });
  await assert.rejects(getMarketPublication({ repository, product: draft.product, slug: draft.slug }), /asset|byte|ceiling|contract/i);
});

test("both durable repository implementations allow only one interleaved metadata compare-and-set", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-publication-cas-"));
  const previousDirectory = process.env.JSON_STORE_DIRECTORY;
  const previousBackend = process.env.JSON_STORE_BACKEND;
  process.env.JSON_STORE_DIRECTORY = directory;
  process.env.JSON_STORE_BACKEND = "local";
  try {
    const jsonA = new JsonDistributionRepository();
    const jsonB = new JsonDistributionRepository();
    await jsonA.setMeta("publication-cas", { status: "draft", updatedAt: NOW });
    const jsonResults = await Promise.all([
      jsonA.compareAndSetMeta("publication-cas", { status: "draft", updatedAt: NOW }, { status: "rendered", updatedAt: "2026-08-21T00:00:01.000Z" }),
      jsonB.compareAndSetMeta("publication-cas", { status: "draft", updatedAt: NOW }, { status: "verified", updatedAt: "2026-08-21T00:00:02.000Z" }),
    ]);
    assert.equal(jsonResults.filter(Boolean).length, 1);
  } finally {
    if (previousDirectory === undefined) delete process.env.JSON_STORE_DIRECTORY;
    else process.env.JSON_STORE_DIRECTORY = previousDirectory;
    if (previousBackend === undefined) delete process.env.JSON_STORE_BACKEND;
    else process.env.JSON_STORE_BACKEND = previousBackend;
    await rm(directory, { recursive: true, force: true });
  }

  let postgresValue = { status: "draft", updatedAt: NOW };
  const sql = {
    async query(statement, parameters) {
      assert.match(statement, /^UPDATE distribution_meta/);
      const expected = JSON.parse(parameters[2]);
      if (Object.entries(expected).some(([field, value]) => postgresValue?.[field] !== value)) return [];
      postgresValue = JSON.parse(parameters[1]);
      return [{ value: structuredClone(postgresValue) }];
    },
  };
  const postgresA = Object.assign(Object.create(PostgresDistributionRepository.prototype), { sql });
  const postgresB = Object.assign(Object.create(PostgresDistributionRepository.prototype), { sql });
  const postgresResults = await Promise.all([
    postgresA.compareAndSetMeta("publication-cas", { status: "draft", updatedAt: NOW }, { status: "rendered", updatedAt: "2026-08-21T00:00:01.000Z" }),
    postgresB.compareAndSetMeta("publication-cas", { status: "draft", updatedAt: NOW }, { status: "verified", updatedAt: "2026-08-21T00:00:02.000Z" }),
  ]);
  assert.equal(postgresResults.filter(Boolean).length, 1);
});

test("HTML marker parsing respects plaintext and foreign-content namespace boundaries", async () => {
  const invalidMarkup = (hash) => [
    `<plaintext></plaintext><article data-content-hash="${hash}"></article>`,
    `<svg><article data-content-hash="${hash}"></article></svg>`,
    `<math><article data-content-hash="${hash}"></article></math>`,
  ];
  for (const html of invalidMarkup("HASH")) {
    const repository = new MemoryRepository();
    const draft = await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
    const image = png();
    await captureEditorialImage({
      repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN,
      fetchImpl: async (url) => response(image, { url }), now: () => NOW,
    });
    await assert.rejects(verifyPublicPublication({
      repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN,
      fetchImpl: async (url) => url.includes("market-calendar")
        ? response(html.replaceAll("HASH", draft.contentHash), { contentType: "text/html", url })
        : response(image, { url }),
      now: () => NOW,
    }), /content hash marker|HTML|markup/i);
  }

  for (const html of [
    `<svg><g></g></svg><article data-content-hash="HASH"></article>`,
    `<svg><foreignObject><article data-content-hash="HASH"></article></foreignObject></svg>`,
    `<math><mtext><article data-content-hash="HASH"></article></mtext></math>`,
  ]) {
    const repository = new MemoryRepository();
    const draft = await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
    const image = png();
    await captureEditorialImage({
      repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN,
      fetchImpl: async (url) => response(image, { url }), now: () => NOW,
    });
    const verified = await verifyPublicPublication({
      repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN,
      fetchImpl: async (url) => url.includes("market-calendar")
        ? response(html.replaceAll("HASH", draft.contentHash), { contentType: "text/html", url })
        : response(image, { url }),
      now: () => NOW,
    });
    assert.equal(verified.status, "verified");
  }
});

test("PNG chunk parser rejects unknown critical and invalid reserved-bit chunks", async () => {
  const header = png().subarray(16, 29);
  const compressed = deflateSync(Buffer.alloc((Math.ceil(1200 / 8) + 1) * 675));
  const assemble = (chunks) => Buffer.concat([PNG_SIGNATURE_FOR_TEST, pngChunk("IHDR", header), ...chunks, pngChunk("IEND")]);
  for (const bytes of [
    assemble([pngChunk("ABCD"), pngChunk("IDAT", compressed)]),
    assemble([pngChunk("text", Buffer.from("invalid reserved bit")), pngChunk("IDAT", compressed)]),
    assemble([pngChunk("IDAT", compressed.subarray(0, 2)), pngChunk("tEXt"), pngChunk("IDAT", compressed.subarray(2))]),
  ]) {
    const repository = new MemoryRepository();
    await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
    await assert.rejects(captureEditorialImage({
      repository, product: "weekly-calendar", slug: "2026-W34", publicOrigin: ORIGIN,
      fetchImpl: async (url) => response(bytes, { url }), now: () => NOW,
    }), /PNG|chunk|critical|reserved|IDAT/i);
  }

  const repository = new MemoryRepository();
  await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
  const split = Math.floor(compressed.byteLength / 2);
  const captured = await captureEditorialImage({
    repository, product: "weekly-calendar", slug: "2026-W34", publicOrigin: ORIGIN,
    fetchImpl: async (url) => response(assemble([
      pngChunk("IDAT", compressed.subarray(0, split)),
      pngChunk("IDAT", compressed.subarray(split)),
    ]), { url }),
    now: () => NOW,
  });
  assert.equal(captured.status, "rendered");
});

test("public origin policy rejects the IANA non-global IPv6 table while allowing global unicast", async () => {
  const nonGlobalOrigins = [
    "https://[64:ff9b:1::1]", "https://[100::1]", "https://[100:0:0:1::1]",
    "https://[2001:2::1]", "https://[2001:5::1]", "https://[2001:10::1]", "https://[2001:20::1]",
    "https://[2001:db8::1]", "https://[5f00::1]",
  ];
  for (const origin of nonGlobalOrigins) {
    const repository = new MemoryRepository();
    await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
    let fetches = 0;
    await assert.rejects(capturePublicationImage({
      repository, product: "weekly-calendar", slug: "2026-W34", publicOrigin: origin,
      allowedOrigins: [origin], fetchImpl: async () => { fetches += 1; return response(png(), { url: origin }); }, now: () => NOW,
    }), /public|private|origin|IP/i);
    assert.equal(fetches, 0, `${origin} must fail before fetch`);
  }

  const globalOrigin = "https://[2606:4700:4700::1111]";
  const repository = new MemoryRepository();
  await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
  const captured = await capturePublicationImage({
    repository, product: "weekly-calendar", slug: "2026-W34", publicOrigin: globalOrigin,
    allowedOrigins: [globalOrigin], fetchImpl: async (url) => response(png(), { url }), now: () => NOW,
  });
  assert.equal(captured.status, "rendered");
});

test("every persisted health check must be at or after its rendered image", async () => {
  const createdAt = "2026-08-20T23:59:58.000Z";
  const checkedAt = "2026-08-20T23:59:59.000Z";
  for (const stage of ["page", "image"]) {
    const repository = new MemoryRepository();
    const draft = await createMarketPublication({ repository, ...draftInput(), now: () => createdAt });
    await captureEditorialImage({
      repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN,
      fetchImpl: async (url) => response(png(), { url }), now: () => NOW,
    });
    const key = marketPublicationKey(draft.product, draft.slug);
    const rendered = await repository.getMeta(key);
    await repository.setMeta(key, {
      ...rendered,
      health: {
        page: stage === "page" ? "failed" : "pending",
        image: stage === "image" ? "failed" : "pending",
        checkedAt,
        error: { stage, name: "Error", message: "failed check", at: checkedAt },
      },
    });
    await assert.rejects(getMarketPublication({
      repository, product: draft.product, slug: draft.slug,
    }), /time|timestamp|health|rendered|lifecycle|invariant/i);
  }
});

test("public origin policy rejects IPv4-translatable IPv6 before fetch", async () => {
  const origin = "https://[::ffff:0:7f00:1]";
  const repository = new MemoryRepository();
  await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
  let fetches = 0;
  await assert.rejects(capturePublicationImage({
    repository,
    product: "weekly-calendar",
    slug: "2026-W34",
    publicOrigin: origin,
    allowedOrigins: [origin],
    fetchImpl: async (url) => {
      fetches += 1;
      return response(png(), { url });
    },
    now: () => NOW,
  }), /public|private|origin|IP/i);
  assert.equal(fetches, 0);
});
