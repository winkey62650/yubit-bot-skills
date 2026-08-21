import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

export const MARKET_PUBLICATION_VERSION = "market-publication-v1";
const PUBLICATION_KEY_VERSION = "market-editorial-v1";
const PRODUCTS = new Set(["weekly-calendar", "data-update"]);
const STATUSES = new Set(["draft", "rendered", "verified"]);
export const MAX_EDITORIAL_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_IMAGE_BYTE_CAP = MAX_EDITORIAL_IMAGE_BYTES;
const MAX_EDITORIAL_PIXELS = 1200 * 675;
const MAX_ARTICLE_HTML_BYTES = 2 * 1024 * 1024;
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

function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Publication content must contain finite JSON numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Publication content cannot contain cycles.");
    const ownNames = Object.getOwnPropertyNames(value);
    if (ownNames.length !== value.length + 1 || ownNames.at(-1) !== "length"
        || Object.getOwnPropertySymbols(value).length
        || Array.from({ length: value.length }, (_, index) => String(index)).some((key, index) => ownNames[index] !== key)) {
      throw new TypeError("Publication arrays must contain every index and no extra own keys.");
    }
    seen.add(value);
    const output = `[${Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || descriptor.value === undefined) {
        throw new TypeError("Publication arrays must contain defined JSON data properties.");
      }
      return canonicalJson(descriptor.value, seen);
    }).join(",")}]`;
    seen.delete(value);
    return output;
  }
  if (typeof value !== "object"
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Object.getOwnPropertySymbols(value).length) {
    throw new TypeError("Publication content must be plain JSON data.");
  }
  if (seen.has(value)) throw new TypeError("Publication content cannot contain cycles.");
  seen.add(value);
  const keys = Object.keys(value);
  if (Object.getOwnPropertyNames(value).length !== keys.length) {
    throw new TypeError("Publication objects may only contain enumerable JSON data properties.");
  }
  const output = `{${keys.sort().map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.value === undefined) {
      throw new TypeError("Publication objects must contain defined JSON data properties.");
    }
    return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, seen)}`;
  }).join(",")}}`;
  seen.delete(value);
  return output;
}

function contentDigest(identity, article, communityDocument, posterModel, sourceManifest) {
  const content = {
    version: MARKET_PUBLICATION_VERSION,
    product: identity.product,
    slug: identity.slug,
    article,
    communityDocument,
    posterModel,
    sourceManifest,
  };
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

function persistedContentMatches(bundle, article, communityDocument, posterModel, sourceManifest) {
  return canonicalJson({
    article: bundle.article,
    communityDocument: bundle.communityDocument,
    posterModel: bundle.posterModel,
    sourceManifest: bundle.sourceManifest,
  }) === canonicalJson({ article, communityDocument, posterModel, sourceManifest });
}

function timestamp(now) {
  const raw = typeof now === "function" ? now() : (now ?? new Date());
  const date = raw instanceof Date ? new Date(raw.getTime()) : new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Publication clock returned an invalid timestamp.");
  return date.toISOString();
}

function laterTimestamp(now, previous) {
  const requested = timestamp(now);
  const previousTime = new Date(previous).getTime();
  const requestedTime = new Date(requested).getTime();
  return requestedTime > previousTime ? requested : new Date(previousTime + 1).toISOString();
}

function requireRepository(repository) {
  if (!repository || typeof repository.getMeta !== "function" || typeof repository.setMeta !== "function") {
    throw new TypeError("Market publication requires a repository with getMeta/setMeta.");
  }
  return repository;
}

function validInstant(value) {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object"
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function assertSourceManifest(value) {
  if (!Array.isArray(value) || value.some((entry) => !isPlainObject(entry))) {
    throw new TypeError("Publication sourceManifest must be an array of plain source objects.");
  }
  canonicalJson(value);
}

function tierValue(value) {
  const tier = value?.tierDecision?.tier;
  if (tier === undefined) return null;
  if (tier !== "tier-one" && tier !== "secondary") {
    throw new Error("Publication tier classification is malformed.");
  }
  return tier;
}

function publicationTier(bundle) {
  const articleTier = tierValue(bundle.article);
  const communityTier = tierValue(bundle.communityDocument);
  const templateId = bundle.communityDocument?.templateId ?? null;
  const weeklyTemplate = templateId === "weekly-calendar-community";
  const tierOneTemplate = templateId === "data-update-community";
  const secondaryTemplate = templateId === "data-update-secondary-community";
  if (bundle.product === "weekly-calendar") {
    if (bundle.article === null || articleTier === "secondary" || communityTier === "secondary"
        || (templateId !== null && !weeklyTemplate)) {
      throw new Error("Weekly Calendar publication has a conflicting tier classification.");
    }
    return "tier-one";
  }
  if (bundle.article === null) {
    if (articleTier !== null || communityTier === "tier-one" || tierOneTemplate
        || (templateId !== null && !secondaryTemplate)
        || (communityTier !== "secondary" && !secondaryTemplate)) {
      throw new Error("Data Update publication has a conflicting secondary tier classification.");
    }
    return "secondary";
  }
  if (articleTier === "secondary" || communityTier === "secondary"
      || (templateId !== null && !tierOneTemplate)) {
    throw new Error("Data Update publication has a conflicting tier-one classification.");
  }
  return "tier-one";
}

function assertImageAsset(asset) {
  const fields = ["mimeType", "width", "height", "byteLength", "sha256", "base64", "renderedAt"];
  if (!isPlainObject(asset) || Object.keys(asset).length !== fields.length || fields.some((field) => !Object.hasOwn(asset, field))
      || asset.mimeType !== "image/png" || asset.width !== 1200 || asset.height !== 675
      || !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 45 || asset.byteLength > MAX_EDITORIAL_IMAGE_BYTES
      || !/^[a-f0-9]{64}$/.test(asset.sha256) || typeof asset.base64 !== "string"
      || !validInstant(asset.renderedAt)) {
    throw new Error("Stored market publication image asset violates its contract.");
  }
  if (asset.base64.length > Math.ceil(MAX_EDITORIAL_IMAGE_BYTES / 3) * 4) {
    throw new Error("Stored market publication image asset exceeds its hard ceiling.");
  }
  const bytes = Buffer.from(asset.base64, "base64");
  if (bytes.toString("base64") !== asset.base64 || bytes.byteLength !== asset.byteLength
      || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    throw new Error("Stored market publication image asset hash or byte length is malformed.");
  }
  const dimensions = pngDimensions(bytes);
  if (dimensions.width !== asset.width || dimensions.height !== asset.height) {
    throw new Error("Stored market publication image asset dimensions are malformed.");
  }
}

function assertHealth(bundle, tier) {
  const health = bundle.health;
  const pageStates = new Set(["pending", "ok", "failed", "not-applicable"]);
  const imageStates = new Set(["pending", "ok", "failed"]);
  const expectedHealthFields = health?.error === undefined
    ? ["page", "image", "checkedAt"]
    : ["page", "image", "checkedAt", "error"];
  if (!isPlainObject(health) || Object.keys(health).length !== expectedHealthFields.length
      || expectedHealthFields.some((field) => !Object.hasOwn(health, field))
      || !pageStates.has(health.page) || !imageStates.has(health.image)
      || !(health.checkedAt === null || validInstant(health.checkedAt))) {
    throw new Error("Stored market publication health violates its contract.");
  }
  const expectedPage = tier === "secondary" ? "not-applicable" : null;
  if ((tier === "secondary" && health.page !== expectedPage)
      || (tier === "tier-one" && health.page === "not-applicable")) {
    throw new Error("Market publication page health conflicts with its tier.");
  }
  const failedParts = ["page", "image"].filter((part) => health[part] === "failed");
  if (health.error === undefined) {
    if (failedParts.length || (bundle.status !== "verified" && health.checkedAt !== null)) {
      throw new Error("Market publication failure health requires matching error evidence.");
    }
  } else {
    const errorFields = ["stage", "name", "message", "at"];
    if (!isPlainObject(health.error) || Object.keys(health.error).length !== errorFields.length
        || errorFields.some((field) => !Object.hasOwn(health.error, field))
        || failedParts.length !== 1 || failedParts[0] !== health.error.stage
        || (tier === "secondary" && health.error.stage === "page")
        || typeof health.error.name !== "string" || !health.error.name
        || typeof health.error.message !== "string" || !health.error.message
        || !validInstant(health.error.at) || health.checkedAt !== health.error.at) {
      throw new Error("Stored market publication failure evidence is malformed.");
    }
  }
  if (bundle.status === "verified") {
    const verifiedPage = tier === "secondary" ? "not-applicable" : "ok";
    if (health.page !== verifiedPage || health.image !== "ok" || !validInstant(health.checkedAt) || health.error !== undefined) {
      throw new Error("Verified market publication health violates its status invariant.");
    }
  }
  if (bundle.status === "draft") {
    const draftPage = tier === "secondary" ? "not-applicable" : "pending";
    if (health.page !== draftPage || !["pending", "failed"].includes(health.image)
        || (health.image === "failed") !== (health.error?.stage === "image")) {
      throw new Error("Draft market publication health violates its status invariant.");
    }
  }
  if (bundle.status === "rendered" && health.error === undefined) {
    const renderedPage = tier === "secondary" ? "not-applicable" : "pending";
    if (health.page !== renderedPage || health.image !== "pending" || health.checkedAt !== null) {
      throw new Error("Rendered market publication health violates its status invariant.");
    }
  }
}

function assertBundle(bundle, identity) {
  const fields = [
    "version", "product", "slug", "status", "contentHash", "article", "communityDocument",
    "posterModel", "sourceManifest", "imageAsset", "health", "createdAt", "updatedAt",
  ];
  if (!isPlainObject(bundle) || Object.keys(bundle).length !== fields.length
      || fields.some((field) => !Object.hasOwn(bundle, field))
      || bundle.version !== MARKET_PUBLICATION_VERSION
      || bundle.product !== identity.product || bundle.slug !== identity.slug
      || !STATUSES.has(bundle.status) || !Array.isArray(bundle.sourceManifest)
      || !/^[a-f0-9]{64}$/.test(bundle.contentHash)
      || !validInstant(bundle.createdAt) || !validInstant(bundle.updatedAt)
      || new Date(bundle.updatedAt) < new Date(bundle.createdAt)) {
    throw new Error("Stored market publication bundle is missing or malformed.");
  }
  if (!(bundle.article === null || isPlainObject(bundle.article))
      || !isPlainObject(bundle.communityDocument) || !isPlainObject(bundle.posterModel)) {
    throw new Error("Publication article, community document and poster model must follow their plain-object contract.");
  }
  canonicalJson(bundle.article);
  canonicalJson(bundle.communityDocument);
  canonicalJson(bundle.posterModel);
  assertSourceManifest(bundle.sourceManifest);
  if (contentDigest(identity, bundle.article, bundle.communityDocument, bundle.posterModel, bundle.sourceManifest) !== bundle.contentHash) {
    throw new Error("Stored market publication content hash violates its contract.");
  }
  const tier = publicationTier(bundle);
  if (bundle.status === "draft") {
    if (bundle.imageAsset !== null) throw new Error("Draft market publication cannot contain a trusted image asset.");
  } else {
    assertImageAsset(bundle.imageAsset);
  }
  assertHealth(bundle, tier);
  const createdTime = Date.parse(bundle.createdAt);
  const updatedTime = Date.parse(bundle.updatedAt);
  const renderedTime = bundle.imageAsset === null ? null : Date.parse(bundle.imageAsset.renderedAt);
  const checkedTime = bundle.health.checkedAt === null ? null : Date.parse(bundle.health.checkedAt);
  if ((renderedTime !== null && (renderedTime < createdTime || renderedTime > updatedTime))
      || (checkedTime !== null && (checkedTime < createdTime || checkedTime > updatedTime))
      || (bundle.status === "verified" && checkedTime < renderedTime)) {
    throw new Error("Stored market publication timestamps violate lifecycle ordering.");
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
  canonicalJson(article);
  canonicalJson(communityDocument);
  canonicalJson(posterModel);
  assertSourceManifest(sourceManifest);
  const safeArticle = clone(article);
  const safeCommunity = clone(communityDocument);
  const safePoster = clone(posterModel);
  const safeSources = clone(sourceManifest);
  const computedHash = contentDigest(identity, safeArticle, safeCommunity, safePoster, safeSources);
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
    health: { page: publicationTier({ product: identity.product, article: safeArticle, communityDocument: safeCommunity }) === "secondary" ? "not-applicable" : "pending", image: "pending", checkedAt: null },
    createdAt: stamp,
    updatedAt: stamp,
  };
  assertBundle(bundle, identity);
  if (typeof repo.compareAndSetMeta === "function") {
    const stored = await repo.compareAndSetMeta(key, { absent: true }, bundle);
    if (stored === null) {
      const winner = assertBundle(await repo.getMeta(key), identity);
      if (winner.contentHash !== computedHash
          || !persistedContentMatches(winner, safeArticle, safeCommunity, safePoster, safeSources)) {
        throw new Error("A different market publication already exists for this durable identity.");
      }
      return clone(winner);
    }
  } else {
    await repo.setMeta(key, bundle);
  }
  return clone(bundle);
}

export const persistMarketPublication = createMarketPublication;
export const loadMarketPublication = getMarketPublication;

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) return false;
  const value = parts.map(Number).reduce((number, part) => ((number * 256) + part) >>> 0, 0);
  const inCidr = (base, bits) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
  };
  return [
    [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
    [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
    [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
    [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
  ].some(([base, bits]) => inCidr(base, bits));
}

function ipv6Parts(hostname) {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!value.includes(":")) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half) => half ? half.split(":").map((part) => {
    if (!/^[a-f0-9]{1,4}$/.test(part)) throw new Error("invalid IPv6");
    return Number.parseInt(part, 16);
  }) : [];
  try {
    const left = parseHalf(halves[0]);
    const right = parseHalf(halves[1] ?? "");
    const zeroCount = halves.length === 2 ? 8 - left.length - right.length : 0;
    if (zeroCount < (halves.length === 2 ? 1 : 0) || left.length + zeroCount + right.length !== 8) return null;
    return [...left, ...Array(zeroCount).fill(0), ...right];
  } catch {
    return null;
  }
}

function isPrivateHostname(hostname) {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local") || isPrivateIpv4(value)) return true;
  const parts = ipv6Parts(value);
  if (!parts) return false;
  const allZeroPrefix = parts.slice(0, 6).every((part) => part === 0);
  const mapped = parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;
  const first = parts[0];
  const second = parts[1];
  return parts.every((part) => part === 0) || (allZeroPrefix && parts[7] === 1)
    || mapped || allZeroPrefix || (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0
    || (first === 0x2001 && second === 0x0db8) || (first === 0x3fff && (second & 0xf000) === 0)
    || first === 0x2002 || (first & 0xff00) === 0xff00;
}

function parsePublicOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError("A valid public HTTPS origin is required."); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || !url.hostname || isPrivateHostname(url.hostname)) {
    throw new TypeError("A credential-free, non-private public HTTPS origin is required.");
  }
  return url;
}

function allowedOriginSet(allowedOrigins, allowedPublicOrigins) {
  const allowlist = allowedOrigins !== undefined ? allowedOrigins : allowedPublicOrigins;
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    throw new TypeError("A non-empty allowed public HTTPS origin list is required.");
  }
  return new Set(allowlist.map((item) => parsePublicOrigin(item).origin));
}

function expectedPublicUrl(origin, path, allowlist) {
  const base = parsePublicOrigin(origin);
  if (!allowlist.has(base.origin)) throw new TypeError("Public origin is not in the allowed origin list.");
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new TypeError("Public URL escaped its allowed origin.");
  return url;
}

function validateResponseBoundary(response, expected, allowlist) {
  if (!response || typeof response.arrayBuffer !== "function") throw new TypeError("Publication fetch returned an invalid response.");
  const finalUrl = plainText(response.url);
  if (!finalUrl) throw new Error("Publication response URL is required to verify the final network boundary.");
  let actual;
  try { actual = new URL(finalUrl); } catch { throw new Error("Publication response URL is invalid."); }
  if (actual.href !== finalUrl || actual.username || actual.password || actual.protocol !== "https:"
      || isPrivateHostname(actual.hostname) || !allowlist.has(actual.origin) || actual.origin !== expected.origin
      || actual.pathname !== expected.pathname || actual.search !== expected.search || actual.hash) {
    throw new Error("Publication response URL crossed the allowed origin or route boundary.");
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

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngDimensions(bytes) {
  if (bytes.byteLength < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Editorial image is not a complete PNG.");
  }
  let offset = 8;
  let dimensions = null;
  let ihdr = null;
  let paletteEntries = null;
  const idatChunks = [];
  let idatEnded = false;
  let sawIend = false;
  let chunkIndex = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 12) throw new Error("Editorial PNG is truncated before a complete chunk.");
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.byteLength - offset - 12) throw new Error("Editorial PNG chunk length is truncated or invalid.");
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error("Editorial PNG contains an invalid chunk type.");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    const actualCrc = crc32(bytes.subarray(offset + 4, dataEnd));
    if (expectedCrc !== actualCrc) throw new Error(`Editorial PNG ${type} chunk has an invalid CRC.`);
    if (chunkIndex === 0) {
      if (type !== "IHDR" || length !== 13) throw new Error("Editorial PNG must begin with a complete 13-byte IHDR chunk.");
      dimensions = { width: bytes.readUInt32BE(dataStart), height: bytes.readUInt32BE(dataStart + 4) };
      ihdr = {
        ...dimensions,
        bitDepth: bytes[dataStart + 8],
        colorType: bytes[dataStart + 9],
        compression: bytes[dataStart + 10],
        filter: bytes[dataStart + 11],
        interlace: bytes[dataStart + 12],
      };
    } else if (type === "IHDR") {
      throw new Error("Editorial PNG contains more than one IHDR chunk.");
    }
    if (type === "PLTE") {
      if (paletteEntries !== null || idatChunks.length || length === 0 || length % 3 !== 0 || length > 768) {
        throw new Error("Editorial PNG contains an invalid PLTE chunk.");
      }
      paletteEntries = length / 3;
    }
    if (type === "IDAT") {
      if (idatEnded) throw new Error("Editorial PNG IDAT chunks must be consecutive.");
      idatChunks.push(bytes.subarray(dataStart, dataEnd));
    } else if (idatChunks.length && type !== "IEND") {
      idatEnded = true;
    }
    if (type === "IEND") {
      if (length !== 0 || dataEnd + 4 !== bytes.byteLength) throw new Error("Editorial PNG IEND must be empty and final.");
      sawIend = true;
    }
    offset = dataEnd + 4;
    chunkIndex += 1;
  }
  if (!dimensions || !idatChunks.length || !sawIend) throw new Error("Editorial PNG is incomplete and requires IHDR, IDAT and IEND chunks.");
  const legalDepths = new Map([
    [0, new Set([1, 2, 4, 8, 16])],
    [2, new Set([8, 16])],
    [3, new Set([1, 2, 4, 8])],
    [4, new Set([8, 16])],
    [6, new Set([8, 16])],
  ]);
  if (!ihdr.width || !ihdr.height || ihdr.width * ihdr.height > MAX_EDITORIAL_PIXELS
      || !legalDepths.get(ihdr.colorType)?.has(ihdr.bitDepth)
      || ihdr.compression !== 0 || ihdr.filter !== 0 || ![0, 1].includes(ihdr.interlace)
      || ([0, 4].includes(ihdr.colorType) && paletteEntries !== null)
      || (ihdr.colorType === 3 && (!paletteEntries || paletteEntries > 2 ** ihdr.bitDepth))) {
    throw new Error("Editorial PNG IHDR does not describe a legal decodable image.");
  }
  const channels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(ihdr.colorType);
  const bitsPerPixel = channels * ihdr.bitDepth;
  const passRows = [];
  const addPass = (xStart, yStart, xStep, yStep) => {
    const width = ihdr.width <= xStart ? 0 : Math.ceil((ihdr.width - xStart) / xStep);
    const height = ihdr.height <= yStart ? 0 : Math.ceil((ihdr.height - yStart) / yStep);
    if (width && height) passRows.push({ height, bytesPerRow: Math.ceil((width * bitsPerPixel) / 8) });
  };
  if (ihdr.interlace === 0) {
    addPass(0, 0, 1, 1);
  } else {
    [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
      .forEach((pass) => addPass(...pass));
  }
  const expandedLength = passRows.reduce((total, pass) => total + ((pass.bytesPerRow + 1) * pass.height), 0);
  if (!Number.isSafeInteger(expandedLength) || expandedLength > (MAX_EDITORIAL_PIXELS * 8 + ihdr.height * 7)) {
    throw new Error("Editorial PNG expanded pixel data exceeds its safety limit.");
  }
  let pixels;
  try {
    pixels = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: expandedLength + 1 });
  } catch {
    throw new Error("Editorial PNG IDAT does not contain a valid bounded zlib pixel stream.");
  }
  if (pixels.byteLength !== expandedLength) throw new Error("Editorial PNG scanline length does not match its IHDR.");
  let pixelOffset = 0;
  for (const pass of passRows) {
    for (let row = 0; row < pass.height; row += 1) {
      if (pixels[pixelOffset] > 4) throw new Error("Editorial PNG contains an invalid scanline filter.");
      pixelOffset += pass.bytesPerRow + 1;
    }
  }
  return dimensions;
}

function safeFailure(error) {
  return {
    name: plainText(error?.name) || "Error",
    message: plainText(error?.message).slice(0, 500) || "Publication verification failed.",
  };
}

class ConcurrentPublicationUpdateError extends Error {
  constructor() {
    super("A concurrent publication update made this network result stale.");
    this.name = "ConcurrentPublicationUpdateError";
  }
}

function bundleFingerprint(bundle) {
  return canonicalJson(bundle);
}

function compareFields(bundle) {
  return {
    version: bundle.version,
    product: bundle.product,
    slug: bundle.slug,
    status: bundle.status,
    contentHash: bundle.contentHash,
    updatedAt: bundle.updatedAt,
  };
}

async function writeIfCurrent(repository, key, identity, expected, next) {
  const current = assertBundle(await repository.getMeta(key), identity);
  if (bundleFingerprint(current) !== bundleFingerprint(expected)) throw new ConcurrentPublicationUpdateError();
  assertBundle(next, identity);
  if (typeof repository.compareAndSetMeta === "function") {
    const stored = await repository.compareAndSetMeta(key, compareFields(expected), next);
    if (stored === null) throw new ConcurrentPublicationUpdateError();
  } else {
    const confirmed = assertBundle(await repository.getMeta(key), identity);
    if (bundleFingerprint(confirmed) !== bundleFingerprint(expected)) throw new ConcurrentPublicationUpdateError();
    await repository.setMeta(key, next);
  }
  return next;
}

async function storeFailure(repository, key, identity, bundle, part, error, now, healthPatch = {}, operation = "capture") {
  const checkedAt = timestamp(now);
  const tier = publicationTier(bundle);
  const otherPart = part === "page" ? "image" : "page";
  const resetOther = otherPart === "page"
    ? (tier === "secondary" ? "not-applicable" : "pending")
    : "pending";
  const health = {
    ...(bundle.health ?? {}),
    ...healthPatch,
    ...(bundle.health?.[otherPart] === "failed" ? { [otherPart]: resetOther } : {}),
    [part]: "failed",
    checkedAt,
    error: { stage: part, ...safeFailure(error), at: checkedAt },
  };
  const failed = {
    ...bundle,
    status: operation === "verify" && bundle.imageAsset ? "rendered" : bundle.status,
    health,
    updatedAt: laterTimestamp(now, bundle.updatedAt),
  };
  await writeIfCurrent(repository, key, identity, bundle, failed);
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
  try {
    if (typeof fetchImpl !== "function") throw new TypeError("captureEditorialImage requires fetch.");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 45) throw new TypeError("Editorial image byte limit is invalid.");
    const allowlist = allowedOriginSet(allowedOrigins, allowedPublicOrigins);
    const url = expectedPublicUrl(origin, editorialAssetPath(identity.product, identity.slug), allowlist);
    if (bundle.status === "verified") return clone(bundle);
    const response = await fetchImpl(url.href, fetchOptions("image/png"));
    validateResponseBoundary(response, url, allowlist);
    if (response.status !== 200) throw new Error(`Editorial image must return status 200; received ${response.status}.`);
    if (mediaType(response) !== "image/png") throw new Error("Editorial image must return image/png.");
    const bytes = await responseBytes(response, Math.min(maxBytes, MAX_EDITORIAL_IMAGE_BYTES));
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
      health: { page: publicationTier(bundle) === "secondary" ? "not-applicable" : "pending", image: "pending", checkedAt: null },
      updatedAt: laterTimestamp(now, bundle.updatedAt),
    };
    await writeIfCurrent(repo, key, identity, bundle, updated);
    return clone(updated);
  } catch (error) {
    if (error instanceof ConcurrentPublicationUpdateError) throw error;
    try {
      await storeFailure(repo, key, identity, bundle, "image", error, now);
    } catch (writeError) {
      if (writeError instanceof ConcurrentPublicationUpdateError) throw writeError;
      throw writeError;
    }
    throw error;
  }
}

function dataPathFromSlug(slug) {
  const [release, date] = slug.split("/");
  return dataUpdateArticlePath(release, date);
}

function readHtmlTag(html, start) {
  let cursor = start + 1;
  let closing = false;
  if (html[cursor] === "/") { closing = true; cursor += 1; }
  const nameStart = cursor;
  while (/[A-Za-z0-9:-]/.test(html[cursor] ?? "")) cursor += 1;
  if (cursor === nameStart || !/[A-Za-z]/.test(html[nameStart])) return null;
  const name = html.slice(nameStart, cursor).toLowerCase();
  const attributes = [];
  let selfClosing = false;
  while (cursor < html.length) {
    while (/\s/.test(html[cursor] ?? "")) cursor += 1;
    if (html[cursor] === ">") return { name, closing, selfClosing, attributes, end: cursor + 1 };
    if (!closing && html[cursor] === "/" && html[cursor + 1] === ">") {
      selfClosing = true;
      return { name, closing, selfClosing, attributes, end: cursor + 2 };
    }
    if (closing) return { malformed: true };
    const attributeStart = cursor;
    while (cursor < html.length && !/[\s/='"<>`]/.test(html[cursor])) cursor += 1;
    if (cursor === attributeStart) return { malformed: true };
    const attributeName = html.slice(attributeStart, cursor).toLowerCase();
    while (/\s/.test(html[cursor] ?? "")) cursor += 1;
    let value = null;
    let quote = null;
    if (html[cursor] === "=") {
      cursor += 1;
      while (/\s/.test(html[cursor] ?? "")) cursor += 1;
      if (html[cursor] === '"' || html[cursor] === "'") {
        quote = html[cursor];
        cursor += 1;
        const valueStart = cursor;
        while (cursor < html.length && html[cursor] !== quote) cursor += 1;
        if (cursor >= html.length) return { malformed: true };
        value = html.slice(valueStart, cursor);
        cursor += 1;
      } else {
        const valueStart = cursor;
        while (cursor < html.length && !/[\s<>`]/.test(html[cursor])) cursor += 1;
        if (cursor === valueStart) return { malformed: true };
        value = html.slice(valueStart, cursor);
      }
    }
    attributes.push({ name: attributeName, value, quote });
  }
  return { malformed: true };
}

function hashMarkerMatches(html, hash) {
  if (typeof html !== "string" || Buffer.byteLength(html, "utf8") > MAX_ARTICLE_HTML_BYTES) return false;
  const rawElements = new Set(["script", "style", "textarea", "title", "template", "noscript", "xmp", "iframe", "noembed"]);
  const voidElements = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  let cursor = 0;
  const openElements = [];
  let articleDepth = 0;
  let markedDepth = null;
  let markerAttributes = 0;
  let markerClosed = false;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) break;
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      if (end < 0) return false;
      cursor = end + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", start)) {
      const end = html.indexOf("]]>", start + 9);
      if (end < 0) return false;
      cursor = end + 3;
      continue;
    }
    if (html[start + 1] === "!" || html[start + 1] === "?") {
      const end = html.indexOf(">", start + 2);
      if (end < 0) return false;
      cursor = end + 1;
      continue;
    }
    const tag = readHtmlTag(html, start);
    if (!tag) { cursor = start + 1; continue; }
    if (tag.malformed) return false;
    cursor = tag.end;
    if (!tag.closing && rawElements.has(tag.name) && !tag.selfClosing) {
      const lower = html.toLowerCase();
      let closeStart = lower.indexOf(`</${tag.name}`, cursor);
      let closeTag = null;
      while (closeStart >= 0) {
        closeTag = readHtmlTag(html, closeStart);
        if (closeTag && !closeTag.malformed && closeTag.closing && closeTag.name === tag.name) break;
        closeStart = lower.indexOf(`</${tag.name}`, closeStart + 2);
      }
      if (closeStart < 0 || !closeTag) return false;
      cursor = closeTag.end;
      continue;
    }
    if (tag.closing) {
      if (voidElements.has(tag.name) || openElements.at(-1) !== tag.name) return false;
      openElements.pop();
      if (tag.name !== "article") continue;
      if (articleDepth === 0) return false;
      if (markedDepth === articleDepth) markerClosed = true;
      articleDepth -= 1;
      continue;
    }
    if (!tag.selfClosing && !voidElements.has(tag.name)) openElements.push(tag.name);
    if (tag.name !== "article") continue;
    articleDepth += 1;
    const markers = tag.attributes.filter((attribute) => attribute.name === "data-content-hash");
    markerAttributes += markers.length;
    if (markers.length > 1 || markerAttributes > 1) return false;
    if (markers.length === 1) {
      if (tag.selfClosing || markers[0].quote !== '"' || markers[0].value !== hash) return false;
      markedDepth = articleDepth;
    }
    if (tag.selfClosing) articleDepth -= 1;
  }
  return openElements.length === 0 && articleDepth === 0 && markerAttributes === 1 && markedDepth !== null && markerClosed;
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
  const tier = publicationTier(bundle);
  let pageHealth = tier === "secondary" ? "not-applicable" : "pending";
  try {
    const allowlist = allowedOriginSet(allowedOrigins, allowedPublicOrigins);
    if (!bundle.imageAsset || bundle.status === "draft") {
      throw Object.assign(new Error("Publication must have a stored rendered image before verification."), { publicationStage: "image" });
    }
    if (typeof fetchImpl !== "function") throw new TypeError("verifyPublicPublication requires fetch.");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 45) throw new TypeError("Editorial image byte limit is invalid.");
    if (tier !== "secondary") {
      const pagePath = identity.product === "weekly-calendar"
        ? weeklyCalendarArticlePath(identity.slug)
        : dataPathFromSlug(identity.slug);
      const pageUrl = expectedPublicUrl(origin, pagePath, allowlist);
      const pageResponse = await fetchImpl(pageUrl.href, fetchOptions("text/html"));
      validateResponseBoundary(pageResponse, pageUrl, allowlist);
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
    validateResponseBoundary(imageResponse, imageUrl, allowlist);
    if (imageResponse.status !== 200) throw Object.assign(new Error(`Publication image must return status 200; received ${imageResponse.status}.`), { publicationStage: "image" });
    if (mediaType(imageResponse) !== "image/png") throw Object.assign(new Error("Publication image must return image/png."), { publicationStage: "image" });
    const bytes = await responseBytes(imageResponse, Math.min(maxBytes, MAX_EDITORIAL_IMAGE_BYTES));
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== bundle.imageAsset.sha256) throw Object.assign(new Error("Publication image hash does not match the stored asset."), { publicationStage: "image" });
    const stamp = timestamp(now);
    const verified = {
      ...bundle,
      status: "verified",
      health: { page: pageHealth, image: "ok", checkedAt: stamp },
      updatedAt: laterTimestamp(now, bundle.updatedAt),
    };
    await writeIfCurrent(repo, key, identity, bundle, verified);
    return clone(verified);
  } catch (error) {
    if (error instanceof ConcurrentPublicationUpdateError) throw error;
    const part = error.publicationStage ?? (pageHealth === "ok" || pageHealth === "not-applicable" ? "image" : "page");
    const failurePageHealth = bundle.status === "draft" ? bundle.health.page : pageHealth;
    try {
      await storeFailure(repo, key, identity, bundle, part, error, now, { page: failurePageHealth }, "verify");
    } catch (writeError) {
      if (writeError instanceof ConcurrentPublicationUpdateError) throw writeError;
      throw writeError;
    }
    throw error;
  }
}
