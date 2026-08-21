import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  captureEditorialImage,
  createMarketPublication,
  dataUpdateArticlePath,
  editorialAssetPath,
  getMarketPublication,
  marketPublicationKey,
  verifyPublicPublication,
  weeklyCalendarArticlePath,
} from "../lib/market-publication.mjs";

const NOW = "2026-08-21T00:00:00.000Z";
const ORIGIN = "https://academy.yubit.com";

class MemoryRepository {
  constructor(store = new Map()) { this.store = store; }
  async getMeta(key) { return structuredClone(this.store.get(key) ?? null); }
  async setMeta(key, value) {
    this.store.set(key, structuredClone(value));
    return structuredClone(value);
  }
}

function png(width = 1200, height = 675, payloadBytes = 0) {
  const bytes = Buffer.alloc(33 + payloadBytes);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function response(body, { status = 200, contentType = "image/png", url = "" } = {}) {
  const value = new Response(body, { status, headers: { "content-type": contentType } });
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
  for (const [name, factory, message] of [
    ["image 500", () => response("error", { status: 500, contentType: "text/plain" }), /status 200/i],
    ["wrong MIME", () => response(png(), { contentType: "image/jpeg" }), /image\/png/i],
    ["wrong dimensions", () => response(png(1199, 675)), /1200.*675/i],
    ["byte cap", () => response(png(1200, 675, 100)), /byte limit|too large/i],
  ]) {
    const repository = new MemoryRepository();
    await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
    await assert.rejects(
      captureEditorialImage({ repository, product: "weekly-calendar", slug: "2026-W34", publicOrigin: ORIGIN, maxBytes: 64, fetchImpl: async () => factory(), now: () => NOW }),
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
  await captureEditorialImage({ repository, product: "weekly-calendar", slug: "2026-W34", publicOrigin: ORIGIN, fetchImpl: async () => response(png()), now: () => NOW });
  const trusted = (await getMarketPublication({ repository, product: "weekly-calendar", slug: "2026-W34" })).imageAsset;
  await assert.rejects(captureEditorialImage({ repository, product: "weekly-calendar", slug: "2026-W34", publicOrigin: ORIGIN, fetchImpl: async () => response(png(900, 675)), now: () => NOW }), /1200.*675/i);
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
    await captureEditorialImage({ repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, fetchImpl: async () => response(png()), now: () => NOW });
    const wrappedFetch = name === "image 500"
      ? async (url) => fetchImpl(url).then(async (item) => {
        if (url.includes("market-calendar")) return response(`<i data-content-hash="${draft.contentHash}"></i>`, { contentType: "text/html", url });
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
    ["wrong MIME", () => response(png(), { contentType: "image/jpeg" }), null, /image\/png/i],
    ["hash mismatch", () => response(png(1200, 675, 1)), null, /hash/i],
    ["article marker", () => response(png()), "<article>no marker</article>", /content hash/i],
  ]) {
    const repository = new MemoryRepository();
    const draft = await createMarketPublication({ repository, ...draftInput(), now: () => NOW });
    await captureEditorialImage({ repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, fetchImpl: async () => response(png()), now: () => NOW });
    await assert.rejects(verifyPublicPublication({
      repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, now: () => NOW,
      fetchImpl: async (url) => url.includes("market-calendar")
        ? response(pageBody ?? `<article data-content-hash="${draft.contentHash}"></article>`, { contentType: "text/html", url })
        : imageResponse(),
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
    fetchImpl: async () => response(png()),
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
  await captureEditorialImage({ repository, product: "data-update", slug: "us-retail-sales/2026-08-21", publicOrigin: ORIGIN, fetchImpl: async () => response(png()), now: () => NOW });
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
  await captureEditorialImage({ repository, product: input.product, slug: input.slug, publicOrigin: ORIGIN, fetchImpl: async () => response(png()), now: () => NOW });
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

  await captureEditorialImage({ repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, fetchImpl: async () => response(png()), now: () => NOW });
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
    fetchImpl: async () => response(body),
    now: () => NOW,
  }), /byte limit/i);
  assert.equal(cancelled, true);
  assert.ok(pulls < 10, `expected early stream cancellation, received ${pulls} chunks`);
});
