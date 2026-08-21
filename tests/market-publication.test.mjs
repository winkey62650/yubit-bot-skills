import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
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
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.alloc(payloadBytes)),
    pngChunk("IEND"),
  ]);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
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
    allowedOrigins: ["https://fca.example"],
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
    fetchImpl: async () => response(png()), now: () => NOW,
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
  await captureEditorialImage({ repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, fetchImpl: async () => response(png()), now: () => NOW });
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
    await captureEditorialImage({ repository: repo, ...identity, publicOrigin: ORIGIN, fetchImpl: async () => response(png()), now: () => NOW });
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
    fetchImpl: async () => { enteredCapture.resolve(); await releaseCapture.promise; return response(oldImage); },
    now: () => "2026-08-21T00:01:00.000Z",
  });
  await enteredCapture.promise;
  await captureEditorialImage({
    repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN,
    fetchImpl: async () => response(newImage), now: () => "2026-08-21T00:02:00.000Z",
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
  await captureEditorialImage({ repository: verifyRepository, product: verifyDraft.product, slug: verifyDraft.slug, publicOrigin: ORIGIN, fetchImpl: async () => response(oldImage), now: () => NOW });
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
  await captureEditorialImage({ repository: verifyRepository, product: verifyDraft.product, slug: verifyDraft.slug, publicOrigin: ORIGIN, fetchImpl: async () => response(newImage), now: () => "2026-08-21T00:02:00.000Z" });
  releaseVerify.resolve();
  await assert.rejects(lateVerify, /concurrent|stale/i);
  const afterVerify = await getMarketPublication({ repository: verifyRepository, product: verifyDraft.product, slug: verifyDraft.slug });
  assert.equal(afterVerify.status, "rendered");
  assert.equal(afterVerify.imageAsset.sha256, createHash("sha256").update(newImage).digest("hex"));
  assert.notEqual(afterVerify.health.page, "failed", "stale failure evidence must not overwrite newer health");

  const failureRepository = new MemoryRepository();
  const failureDraft = await createMarketPublication({ repository: failureRepository, ...draftInput(), now: () => NOW });
  await captureEditorialImage({ repository: failureRepository, product: failureDraft.product, slug: failureDraft.slug, publicOrigin: ORIGIN, fetchImpl: async () => response(oldImage), now: () => NOW });
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
  await captureEditorialImage({ repository: failureRepository, product: failureDraft.product, slug: failureDraft.slug, publicOrigin: ORIGIN, fetchImpl: async () => response(newImage), now: () => "2026-08-21T00:02:00.000Z" });
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
    await captureEditorialImage({ repository, product: draft.product, slug: draft.slug, publicOrigin: ORIGIN, fetchImpl: async () => response(png()), now: () => NOW });
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
      fetchImpl: async () => response(bytes), now: () => NOW,
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
  assert.equal(failed.health.page, "pending");
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
