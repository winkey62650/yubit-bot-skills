import { createHash } from "node:crypto";

export const MARKET_PUBLICATION_VERSION = "market-publication-v1";
const PUBLICATION_KEY_VERSION = "market-editorial-v1";
const PRODUCTS = new Set(["weekly-calendar", "data-update"]);
const STATUSES = new Set(["draft", "rendered", "verified"]);
const DEFAULT_IMAGE_BYTE_CAP = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function plainText(value) {
  return typeof value === "string" ? value : "";
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isoWeekInfo(date) {
  const cursor = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = cursor.getUTCDay() || 7;
  cursor.setUTCDate(cursor.getUTCDate() + 4 - day);
  const year = cursor.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((cursor - yearStart) / 86400000) + 1) / 7);
  return { year, week };
}

function canonicalWeek(value) {
  if (typeof value !== "string" || !/^\d{4}-W\d{2}$/.test(value)) {
    throw new TypeError("Weekly Calendar requires a canonical ISO week slug.");
  }
  const year = Number(value.slice(0, 4));
  const week = Number(value.slice(6));
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (jan4.getUTCDay() || 7) + 1 + ((week - 1) * 7));
  const identity = isoWeekInfo(monday);
  if (week < 1 || week > 53 || identity.year !== year || identity.week !== week) {
    throw new TypeError("Weekly Calendar requires a real canonical ISO week slug.");
  }
  return value;
}

function canonicalDate(value) {
  if (typeof value !== "string" || !validDate(value)) {
    throw new TypeError("Data Update date must be canonical YYYY-MM-DD.");
  }
  return value;
}

function canonicalRelease(value) {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new TypeError("Data Update release slug must be canonical lowercase kebab-case.");
  }
  return value;
}

function canonicalProduct(value) {
  if (!PRODUCTS.has(value)) throw new TypeError("Market publication product must be weekly-calendar or data-update.");
  return value;
}

function publicationIdentity(product, slug) {
  const canonicalProductValue = canonicalProduct(product);
  if (canonicalProductValue === "weekly-calendar") {
    return { product: canonicalProductValue, slug: canonicalWeek(slug) };
  }
  if (typeof slug !== "string") throw new TypeError("Data Update publication slug must be canonical release/date.");
  const match = slug.match(/^([^/]+)\/(\d{4}-\d{2}-\d{2})$/);
  if (!match) throw new TypeError("Data Update publication slug must be canonical release/date.");
  return { product: canonicalProductValue, slug: `${canonicalRelease(match[1])}/${canonicalDate(match[2])}` };
}

export function weeklyCalendarArticlePath(week) {
  return `/market-calendar/${canonicalWeek(week)}`;
}

export function dataUpdateArticlePath(release, date) {
  return `/data-updates/${canonicalRelease(release)}/${canonicalDate(date)}`;
}

export function editorialAssetPath(product, slug) {
  const identity = publicationIdentity(product, slug);
  return `/api/media/editorial/${identity.product}/${encodeURIComponent(identity.slug)}`;
}

export function marketPublicationKey(product, slug) {
  const identity = publicationIdentity(product, slug);
  return `${PUBLICATION_KEY_VERSION}:${identity.product}:${identity.slug.replace("/", ":")}`;
}

function stableValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Publication content must contain finite JSON numbers.");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Publication content cannot contain cycles.");
    seen.add(value);
    const output = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return output;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("Publication content must be plain JSON data.");
  }
  if (seen.has(value)) throw new TypeError("Publication content cannot contain cycles.");
  seen.add(value);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) output[key] = stableValue(value[key], seen);
  }
  seen.delete(value);
  return output;
}

function contentDigest(article, communityDocument, posterModel, sourceManifest) {
  const content = article ?? { communityDocument, posterModel, sourceManifest };
  return createHash("sha256").update(JSON.stringify(stableValue(content))).digest("hex");
}

function persistedContentMatches(bundle, article, communityDocument, posterModel, sourceManifest) {
  return JSON.stringify(stableValue({
    article: bundle.article,
    communityDocument: bundle.communityDocument,
    posterModel: bundle.posterModel,
    sourceManifest: bundle.sourceManifest,
  })) === JSON.stringify(stableValue({ article, communityDocument, posterModel, sourceManifest }));
}

function timestamp(now) {
  const raw = typeof now === "function" ? now() : (now ?? new Date());
  const date = raw instanceof Date ? new Date(raw.getTime()) : new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Publication clock returned an invalid timestamp.");
  return date.toISOString();
}

function requireRepository(repository) {
  if (!repository || typeof repository.getMeta !== "function" || typeof repository.setMeta !== "function") {
    throw new TypeError("Market publication requires a repository with getMeta/setMeta.");
  }
  return repository;
}

function assertBundle(bundle, identity) {
  if (!bundle || bundle.version !== MARKET_PUBLICATION_VERSION
      || bundle.product !== identity.product || bundle.slug !== identity.slug
      || !STATUSES.has(bundle.status)) {
    throw new Error("Stored market publication bundle is missing or malformed.");
  }
  return bundle;
}

export async function getMarketPublication({ repository, product, slug } = {}) {
  const identity = publicationIdentity(product, slug);
  const stored = await requireRepository(repository).getMeta(marketPublicationKey(identity.product, identity.slug));
  return stored === null ? null : clone(assertBundle(stored, identity));
}

export async function createMarketPublication({
  repository,
  product,
  slug,
  article = null,
  communityDocument = null,
  posterModel = null,
  sourceManifest = [],
  contentHash,
  now,
} = {}) {
  const identity = publicationIdentity(product, slug);
  const repo = requireRepository(repository);
  const key = marketPublicationKey(identity.product, identity.slug);
  const safeArticle = clone(article);
  const safeCommunity = clone(communityDocument);
  const safePoster = clone(posterModel);
  const safeSources = clone(sourceManifest);
  if (!Array.isArray(safeSources)) throw new TypeError("Publication sourceManifest must be an array.");
  const computedHash = contentDigest(safeArticle, safeCommunity, safePoster, safeSources);
  if (contentHash !== undefined && (!/^[a-f0-9]{64}$/.test(contentHash) || contentHash !== computedHash)) {
    throw new TypeError("Publication contentHash must match its canonical content.");
  }
  const existing = await repo.getMeta(key);
  if (existing !== null) {
    const saved = assertBundle(existing, identity);
    if (saved.contentHash !== computedHash
        || !persistedContentMatches(saved, safeArticle, safeCommunity, safePoster, safeSources)) {
      throw new Error("A different market publication already exists for this durable identity.");
    }
    return clone(saved);
  }
  const stamp = timestamp(now);
  const bundle = {
    version: MARKET_PUBLICATION_VERSION,
    product: identity.product,
    slug: identity.slug,
    status: "draft",
    contentHash: computedHash,
    article: safeArticle,
    communityDocument: safeCommunity,
    posterModel: safePoster,
    sourceManifest: safeSources,
    imageAsset: null,
    health: { page: "pending", image: "pending", checkedAt: null },
    createdAt: stamp,
    updatedAt: stamp,
  };
  await repo.setMeta(key, bundle);
  return clone(bundle);
}

export const persistMarketPublication = createMarketPublication;
export const loadMarketPublication = getMarketPublication;

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function isPrivateHostname(hostname) {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv6 = value.includes(":");
  return value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local")
    || value === "::" || value === "::1" || (ipv6 && (value.startsWith("fc") || value.startsWith("fd")
    || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")))
    || isPrivateIpv4(value);
}

function publicOrigin(value, allowlist = []) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError("A valid public HTTPS origin is required."); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || !url.hostname || isPrivateHostname(url.hostname)) {
    throw new TypeError("A credential-free, non-private public HTTPS origin is required.");
  }
  const allowed = Array.isArray(allowlist) ? allowlist : [];
  if (allowed.length) {
    const origins = allowed.map((item) => publicOrigin(item).origin);
    if (!origins.includes(url.origin)) throw new TypeError("Public origin is not in the allowed origin list.");
  }
  return url;
}

function expectedPublicUrl(origin, path, allowlist) {
  const base = publicOrigin(origin, allowlist);
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new TypeError("Public URL escaped its allowed origin.");
  return url;
}

function validateResponseBoundary(response, expected) {
  if (!response || typeof response.arrayBuffer !== "function") throw new TypeError("Publication fetch returned an invalid response.");
  if (plainText(response.url)) {
    const actual = new URL(response.url);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.search !== expected.search) {
      throw new Error("Publication response URL crossed the allowed origin or route boundary.");
    }
  }
}

function mediaType(response) {
  return plainText(response.headers?.get?.("content-type")).split(";", 1)[0].trim().toLowerCase();
}

async function responseBytes(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Editorial image exceeds the byte limit.");
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          await reader.cancel("Editorial image exceeds the byte limit.");
          throw new Error("Editorial image exceeds the byte limit.");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("Editorial image exceeds the byte limit.");
  return bytes;
}

function pngDimensions(bytes) {
  if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
      || bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("Editorial image is not a valid PNG with an IHDR header.");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function safeFailure(error) {
  return {
    name: plainText(error?.name) || "Error",
    message: plainText(error?.message).slice(0, 500) || "Publication verification failed.",
  };
}

async function storeFailure(repository, key, bundle, part, error, now, healthPatch = {}) {
  const stamp = timestamp(now);
  const health = {
    ...(bundle.health ?? {}),
    ...healthPatch,
    [part]: "failed",
    checkedAt: stamp,
    error: { stage: part, ...safeFailure(error), at: stamp },
  };
  const failed = { ...bundle, health, updatedAt: stamp };
  await repository.setMeta(key, failed);
  return failed;
}

function fetchOptions(contentType) {
  return { method: "GET", redirect: "manual", headers: { accept: contentType } };
}

export async function captureEditorialImage({
  repository,
  product,
  slug,
  publicOrigin: origin,
  allowedOrigins,
  allowedPublicOrigins,
  fetchImpl = globalThis.fetch,
  maxBytes = DEFAULT_IMAGE_BYTE_CAP,
  now,
} = {}) {
  const identity = publicationIdentity(product, slug);
  const repo = requireRepository(repository);
  const key = marketPublicationKey(identity.product, identity.slug);
  const bundle = assertBundle(await repo.getMeta(key), identity);
  if (bundle.status === "verified") return clone(bundle);
  try {
    if (typeof fetchImpl !== "function") throw new TypeError("captureEditorialImage requires fetch.");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 24) throw new TypeError("Editorial image byte limit is invalid.");
    const url = expectedPublicUrl(origin, editorialAssetPath(identity.product, identity.slug), allowedOrigins ?? allowedPublicOrigins);
    const response = await fetchImpl(url.href, fetchOptions("image/png"));
    validateResponseBoundary(response, url);
    if (response.status !== 200) throw new Error(`Editorial image must return status 200; received ${response.status}.`);
    if (mediaType(response) !== "image/png") throw new Error("Editorial image must return image/png.");
    const bytes = await responseBytes(response, maxBytes);
    const dimensions = pngDimensions(bytes);
    if (dimensions.width !== 1200 || dimensions.height !== 675) {
      throw new Error(`Editorial image must be exactly 1200×675; received ${dimensions.width}×${dimensions.height}.`);
    }
    const stamp = timestamp(now);
    const imageAsset = {
      mimeType: "image/png",
      width: dimensions.width,
      height: dimensions.height,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      base64: bytes.toString("base64"),
      renderedAt: stamp,
    };
    const updated = {
      ...bundle,
      status: "rendered",
      imageAsset,
      health: { ...(bundle.health ?? {}), image: "pending", checkedAt: null },
      updatedAt: stamp,
    };
    delete updated.health.error;
    await repo.setMeta(key, updated);
    return clone(updated);
  } catch (error) {
    await storeFailure(repo, key, bundle, "image", error, now);
    throw error;
  }
}

function dataPathFromSlug(slug) {
  const [release, date] = slug.split("/");
  return dataUpdateArticlePath(release, date);
}

function isSecondary(bundle) {
  return bundle.product === "data-update" && (bundle.article === null
    || bundle.article?.tierDecision?.tier === "secondary"
    || bundle.communityDocument?.tierDecision?.tier === "secondary"
    || bundle.communityDocument?.templateId === "data-update-secondary-community");
}

function hashMarkerMatches(html, hash) {
  const escaped = hash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`data-content-hash\\s*=\\s*(["'])${escaped}\\1`, "i").test(html);
}

export async function verifyPublicPublication({
  repository,
  product,
  slug,
  publicOrigin: origin,
  allowedOrigins,
  allowedPublicOrigins,
  fetchImpl = globalThis.fetch,
  maxBytes = DEFAULT_IMAGE_BYTE_CAP,
  now,
} = {}) {
  const identity = publicationIdentity(product, slug);
  const repo = requireRepository(repository);
  const key = marketPublicationKey(identity.product, identity.slug);
  const bundle = assertBundle(await repo.getMeta(key), identity);
  const allowlist = allowedOrigins ?? allowedPublicOrigins;
  let pageHealth = isSecondary(bundle) ? "not-applicable" : "pending";
  try {
    if (!bundle.imageAsset || bundle.status === "draft") {
      throw Object.assign(new Error("Publication must have a stored rendered image before verification."), { publicationStage: "image" });
    }
    if (typeof fetchImpl !== "function") throw new TypeError("verifyPublicPublication requires fetch.");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 24) throw new TypeError("Editorial image byte limit is invalid.");
    if (!isSecondary(bundle)) {
      const pagePath = identity.product === "weekly-calendar"
        ? weeklyCalendarArticlePath(identity.slug)
        : dataPathFromSlug(identity.slug);
      const pageUrl = expectedPublicUrl(origin, pagePath, allowlist);
      const pageResponse = await fetchImpl(pageUrl.href, fetchOptions("text/html"));
      validateResponseBoundary(pageResponse, pageUrl);
      if (pageResponse.status !== 200) throw Object.assign(new Error(`Publication page must return status 200; received ${pageResponse.status}.`), { publicationStage: "page" });
      if (mediaType(pageResponse) !== "text/html") throw Object.assign(new Error("Publication page must return text/html."), { publicationStage: "page" });
      const html = await pageResponse.text();
      if (!hashMarkerMatches(html, bundle.contentHash)) {
        throw Object.assign(new Error("Publication page is missing the matching content hash marker."), { publicationStage: "page" });
      }
      pageHealth = "ok";
    }

    const imageUrl = expectedPublicUrl(origin, editorialAssetPath(identity.product, identity.slug), allowlist);
    const imageResponse = await fetchImpl(imageUrl.href, fetchOptions("image/png"));
    validateResponseBoundary(imageResponse, imageUrl);
    if (imageResponse.status !== 200) throw Object.assign(new Error(`Publication image must return status 200; received ${imageResponse.status}.`), { publicationStage: "image" });
    if (mediaType(imageResponse) !== "image/png") throw Object.assign(new Error("Publication image must return image/png."), { publicationStage: "image" });
    const bytes = await responseBytes(imageResponse, maxBytes);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== bundle.imageAsset.sha256) throw Object.assign(new Error("Publication image hash does not match the stored asset."), { publicationStage: "image" });
    const stamp = timestamp(now);
    const verified = {
      ...bundle,
      status: "verified",
      health: { page: pageHealth, image: "ok", checkedAt: stamp },
      updatedAt: stamp,
    };
    await repo.setMeta(key, verified);
    return clone(verified);
  } catch (error) {
    const part = error.publicationStage ?? (pageHealth === "ok" || pageHealth === "not-applicable" ? "image" : "page");
    await storeFailure(repo, key, bundle, part, error, now, { page: pageHealth });
    throw error;
  }
}
