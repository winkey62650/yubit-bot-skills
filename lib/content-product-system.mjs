import { createHash } from "node:crypto";

export const CONTENT_PRODUCT_TYPES = Object.freeze([
  "daily-market-brief",
  "weekly-catalyst-calendar",
  "data-flash",
  "market-follow-up",
]);

export const CONTENT_PRODUCT_LIFECYCLE = Object.freeze([
  "draft",
  "evidence-verified",
  "quality-approved",
  "distribution-ready",
  "published",
  "blocked",
]);

const PRODUCT_SET = new Set(CONTENT_PRODUCT_TYPES);
const LANGUAGE_SET = new Set(["en", "zh", "zh-CN"]);
const SOURCE_TIERS = new Set(["official", "primary", "secondary"]);
const TERMINAL_STATES = new Set(["published", "blocked"]);
const NEXT_STATE = Object.freeze({
  draft: "evidence-verified",
  "evidence-verified": "quality-approved",
  "quality-approved": "distribution-ready",
  "distribution-ready": "published",
});

function clone(value) {
  return structuredClone(value);
}

function canonicalValue(value, location = "content") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry, index) => canonicalValue(entry, `${location}[${index}]`));
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError(`${location}.${key} is undefined`);
      output[key] = canonicalValue(value[key], `${location}.${key}`);
    }
    return output;
  }
  throw new TypeError(`${location} must contain finite JSON-compatible values`);
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function textDigest(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function validInstant(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stableIdPart(value) {
  const normalized = String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || digest(String(value ?? "")).slice(7, 23);
}

export function contentProductId(product, eventId) {
  return `${product}-${stableIdPart(eventId)}`;
}

function productIdentity(input) {
  return contentProductId(input.product, input.event?.id);
}

function sourceMap(sources) {
  return new Map((Array.isArray(sources) ? sources : []).map((source) => [source?.id, source]));
}

function validateEvidence(input) {
  const reasons = [];
  const sources = Array.isArray(input.sources) ? input.sources : [];
  const byId = sourceMap(sources);
  if (sources.length === 0) reasons.push("At least one named source is required.");
  for (const source of sources) {
    if (!nonEmpty(source?.id) || !nonEmpty(source?.title)) reasons.push("Every source requires an id and title.");
    if (!nonEmpty(source?.url) || !source.url.startsWith("https://")) reasons.push(`Source ${source?.id ?? "unknown"} requires an HTTPS URL.`);
    if (!SOURCE_TIERS.has(source?.tier)) reasons.push(`Source ${source?.id ?? "unknown"} has an unsupported evidence tier.`);
    if (!validInstant(source?.observedAt)) reasons.push(`Source ${source?.id ?? "unknown"} requires a canonical observedAt timestamp.`);
  }
  const facts = Array.isArray(input.facts) ? input.facts : [];
  if (facts.length === 0) reasons.push("At least one separately identified fact is required.");
  for (const fact of facts) {
    if (!nonEmpty(fact?.text)) reasons.push("Every fact requires text.");
    if (!Array.isArray(fact?.sourceRefs) || fact.sourceRefs.length === 0) {
      reasons.push("Every fact requires at least one source reference.");
      continue;
    }
    const evidence = fact.sourceRefs.map((id) => byId.get(id));
    if (evidence.some((source) => !source)) reasons.push("A fact references unknown evidence.");
    if ((fact.actual === true || input.product === "data-flash") && !evidence.some((source) => source && ["official", "primary"].includes(source.tier))) {
      reasons.push("Actual data claims require official or primary evidence.");
    }
  }
  if (input.product === "data-flash" && !nonEmpty(input.event?.actual)) {
    reasons.push("Data Flash requires a non-conflicting official actual value.");
  }
  const actualValues = Array.isArray(input.event?.actualValues)
    ? input.event.actualValues.filter(nonEmpty).map((value) => value.trim())
    : [];
  if (input.product === "data-flash" && (input.event?.actualConflict === true || new Set(actualValues).size > 1)) {
    reasons.push("Data Flash actual value conflicts across official evidence.");
  }
  return reasons;
}

function validateQuality(input) {
  const reasons = [];
  if (!PRODUCT_SET.has(input?.product)) reasons.push("Unsupported content product.");
  if (!nonEmpty(input?.event?.id) || !nonEmpty(input?.event?.title)) reasons.push("A governed event id and title are required.");
  if (!validInstant(input?.event?.occurredAt)) reasons.push("The event requires a canonical occurredAt timestamp.");
  if (!nonEmpty(input?.title)) reasons.push("A title is required.");
  if (!LANGUAGE_SET.has(input?.language)) reasons.push("Language must be en, zh, or zh-CN.");
  if (!Array.isArray(input?.inferences) || input.inferences.length === 0 || input.inferences.some((entry) => !nonEmpty(entry?.text))) {
    reasons.push("At least one separately identified inference is required.");
  }
  if (!nonEmpty(input?.risk)) reasons.push("A risk statement is required.");
  if (!nonEmpty(input?.invalidation)) reasons.push("An invalidation condition is required.");
  if (!nonEmpty(input?.cta?.label) || !nonEmpty(input?.cta?.url) || !input.cta.url.startsWith("https://")) {
    reasons.push("CTA requires a label and HTTPS URL.");
  }
  if (/guaranteed|risk[- ]?free|稳赚|保本|必赚/i.test(input?.cta?.label ?? "")) {
    reasons.push("CTA cannot promise returns or remove risk.");
  }
  if (input?.product === "market-follow-up") {
    if (!nonEmpty(input.originatingDataFlashId)) reasons.push("Market follow-up requires an originating Data Flash id.");
    const start = input.observationWindow?.start;
    const end = input.observationWindow?.end;
    if (!validInstant(start) || !validInstant(end) || new Date(start) >= new Date(end)) {
      reasons.push("Market follow-up requires a bounded canonical observation window.");
    }
    if (!nonEmpty(input.correlationStatement)) {
      reasons.push("Market follow-up requires a correlation statement.");
    } else if (/\bcaused?\b|\bled to\b|\bbecause of\b|导致|引发|由于.{0,12}(上涨|下跌|波动)/i.test(input.correlationStatement)) {
      reasons.push("Market follow-up cannot make a causal claim.");
    }
  }
  return reasons;
}

function canonicalDocument(input) {
  const lines = [input.title, "", "Facts"];
  for (const fact of input.facts ?? []) lines.push(`- ${fact.text}`);
  lines.push("", "Inferences");
  for (const inference of input.inferences ?? []) lines.push(`- ${inference.text}`);
  if (input.product === "market-follow-up") {
    lines.push(
      "",
      `Originating Data Flash: ${input.originatingDataFlashId}`,
      `Observation window: ${input.observationWindow?.start} — ${input.observationWindow?.end}`,
      `Observed correlation: ${input.correlationStatement}`,
    );
  }
  lines.push("", `Risk: ${input.risk}`, `Invalidation: ${input.invalidation}`, `${input.cta.label}: ${input.cta.url}`);
  return lines.join("\n");
}

function escapedChunks(text, limit, escapeCharacter) {
  const chunks = [];
  let chunk = "";
  for (const character of text) {
    const escaped = escapeCharacter(character);
    if (escaped.length > limit) throw new Error("A rendered character exceeds the channel limit.");
    if (chunk.length + escaped.length > limit) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += escaped;
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

function escapeTelegramCharacter(character) {
  if (character === "&") return "&amp;";
  if (character === "<") return "&lt;";
  if (character === ">") return "&gt;";
  if (character === "\"") return "&quot;";
  return character;
}

function escapeDiscordCharacter(character) {
  return "\\`*_{}[]()#+-.!|>~".includes(character) ? `\\${character}` : character;
}

const TELEGRAM_PRODUCT_KICKERS = Object.freeze({
  "daily-market-brief": "DAILY MARKET BRIEF",
  "weekly-catalyst-calendar": "WEEKLY CATALYSTS",
  "data-flash": "DATA FLASH",
  "market-follow-up": "MARKET FOLLOW-UP",
});

function escapedTelegramText(value) {
  return [...String(value ?? "")].map(escapeTelegramCharacter).join("");
}

function wrappedTelegramBlocks(value, { prefix = "", suffix = "", limit = 4096 } = {}) {
  const available = limit - prefix.length - suffix.length;
  if (available < 1) throw new RangeError("Telegram wrapper exceeds the platform limit.");
  return escapedChunks(String(value ?? ""), available, escapeTelegramCharacter)
    .map((chunk) => `${prefix}${chunk}${suffix}`);
}

function packTelegramBlocks(blocks, limit = 4096) {
  const chunks = [];
  let current = "";
  for (const block of blocks.filter(Boolean)) {
    if (block.length > limit) throw new RangeError("A Telegram editorial block exceeds the platform limit.");
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length > limit) {
      chunks.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function telegramEditorialChunks(record) {
  const kicker = TELEGRAM_PRODUCT_KICKERS[record.product] ?? "MARKET INTELLIGENCE";
  const blocks = [
    `<b>YUBIT ACADEMY · ${kicker}</b>\n<i>Evidence-led · Signal over noise</i>`,
    ...wrappedTelegramBlocks(record.title, { prefix: "<b>◆ ", suffix: "</b>" }),
    "<b>01 · VERIFIED FACTS</b>",
  ];
  for (const fact of record.facts ?? []) {
    blocks.push(...wrappedTelegramBlocks(fact.text, { prefix: "<b>•</b> " }));
  }
  blocks.push("<b>02 · MARKET READ</b>");
  for (const inference of record.inferences ?? []) {
    blocks.push(...wrappedTelegramBlocks(inference.text, { prefix: "<b>◆</b> " }));
  }
  if (record.product === "market-follow-up") {
    blocks.push(
      "<b>OBSERVATION WINDOW</b>",
      ...wrappedTelegramBlocks(`${record.observationWindow?.start} — ${record.observationWindow?.end}`, { prefix: "⏱ " }),
      ...wrappedTelegramBlocks(record.correlationStatement, { prefix: "↔ " }),
    );
  }
  blocks.push(
    "<b>03 · RISK BOUNDARY</b>",
    ...wrappedTelegramBlocks(record.risk, { prefix: "<b>⚠ RISK</b>\n" }),
    ...wrappedTelegramBlocks(record.invalidation, { prefix: "<b>⊘ INVALIDATION</b>\n" }),
    "<b>04 · NEXT STEP</b>",
  );
  const ctaUrl = escapedTelegramText(record.cta?.url);
  const ctaLabel = escapedTelegramText(record.cta?.label);
  const linkedCta = `<a href="${ctaUrl}">${ctaLabel}</a>`;
  blocks.push(linkedCta.length <= 4096
    ? linkedCta
    : wrappedTelegramBlocks(`${record.cta?.label}: ${record.cta?.url}`));
  return packTelegramBlocks(blocks);
}

function requireStore(store) {
  for (const method of ["writeSource", "writeEvent", "writeProduct", "readProduct"]) {
    if (typeof store?.[method] !== "function") throw new TypeError(`Content product store requires ${method}()`);
  }
  return store;
}

export function createContentProductSystem({ store, now = () => new Date() } = {}) {
  const governedStore = requireStore(store);
  if (typeof now !== "function") throw new TypeError("now must be a function");

  function timestamp() {
    const value = now();
    const parsed = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(parsed.getTime())) throw new TypeError("Content product clock returned an invalid timestamp.");
    return parsed.toISOString();
  }

  function transition(record, status, reason) {
    if (!record || !CONTENT_PRODUCT_LIFECYCLE.includes(record.status)) throw new TypeError("A governed lifecycle record is required.");
    if (!CONTENT_PRODUCT_LIFECYCLE.includes(status)) throw new Error(`Unsupported lifecycle transition target: ${status}`);
    if (TERMINAL_STATES.has(record.status)) throw new Error(`Invalid lifecycle transition from terminal state ${record.status}.`);
    if (status !== "blocked" && NEXT_STATE[record.status] !== status) {
      throw new Error(`Invalid lifecycle transition from ${record.status} to ${status}.`);
    }
    const changedAt = timestamp();
    return {
      ...clone(record),
      status,
      lifecycle: [...record.lifecycle, { status, changedAt, reason: nonEmpty(reason) ? reason : "gate-approved" }],
    };
  }

  async function persistBlocked(input, base, reasons) {
    let blocked = transition(base, "blocked", reasons.join(" "));
    blocked = { ...blocked, gate: { approved: false, reasons: [...reasons], checkedAt: timestamp() } };
    try {
      for (const source of Array.isArray(input.sources) ? input.sources : []) {
        if (nonEmpty(source?.id)) await governedStore.writeSource(canonicalValue(source));
      }
      if (nonEmpty(input.event?.id)) {
        await governedStore.writeEvent(canonicalValue({ ...input.event, sourceRefs: (input.sources ?? []).map(({ id }) => id) }));
      }
      await governedStore.writeProduct(blocked);
    } catch (error) {
      blocked.gate.reasons.push(`Obsidian persistence failed: ${error?.message ?? String(error)}`);
    }
    return blocked;
  }

  async function prepare(rawInput) {
    let input;
    try {
      input = canonicalValue(rawInput, "product input");
    } catch (error) {
      throw new TypeError(`Invalid content product input: ${error?.message ?? String(error)}`);
    }
    const createdAt = timestamp();
    const id = productIdentity(input);
    const canonicalText = canonicalDocument(input);
    let record = {
      id,
      product: input.product,
      eventId: input.event?.id ?? "invalid-event",
      title: input.title ?? id,
      language: input.language ?? "unknown",
      sourceRefs: (input.sources ?? []).map(({ id: sourceId }) => sourceId),
      facts: input.facts ?? [],
      inferences: input.inferences ?? [],
      risk: input.risk ?? "",
      invalidation: input.invalidation ?? "",
      cta: input.cta ?? null,
      canonicalText,
      contentHash: textDigest(canonicalText),
      status: "draft",
      lifecycle: [{ status: "draft", changedAt: createdAt, reason: "content-created" }],
      gate: { approved: false, reasons: [], checkedAt: createdAt },
      ...(input.product === "market-follow-up" ? {
        originatingDataFlashId: input.originatingDataFlashId ?? "",
        observationWindow: input.observationWindow ?? null,
        correlationStatement: input.correlationStatement ?? "",
      } : {}),
    };

    const evidenceReasons = validateEvidence(input);
    if (evidenceReasons.length) return persistBlocked(input, record, evidenceReasons);
    record = transition(record, "evidence-verified", "source-evidence-complete");

    const qualityReasons = validateQuality(input);
    if (qualityReasons.length) return persistBlocked(input, record, qualityReasons);
    record = transition(record, "quality-approved", "editorial-contract-approved");

    try {
      for (const source of input.sources) await governedStore.writeSource(source);
      await governedStore.writeEvent({ ...input.event, sourceRefs: input.sources.map(({ id: sourceId }) => sourceId) });
      record = transition(record, "distribution-ready", "obsidian-write-through-complete");
      record.gate = { approved: true, reasons: [], checkedAt: timestamp() };
      await governedStore.writeProduct(record);
      const persisted = await governedStore.readProduct({ product: record.product, id: record.id });
      if (!persisted || persisted.canonicalText !== record.canonicalText
          || persisted.contentHash !== record.contentHash
          || textDigest(persisted.canonicalText) !== record.contentHash) {
        throw new Error("Obsidian product readback does not match the exact canonical payload and hash.");
      }
      return record;
    } catch (error) {
      return persistBlocked(input, record, [`Obsidian persistence failed: ${error?.message ?? String(error)}`]);
    }
  }

  function renderChannels(record) {
    if (!record || !["distribution-ready", "published"].includes(record.status)) {
      throw new Error("Content must be distribution-ready before channel rendering.");
    }
    return {
      canonicalText: record.canonicalText,
      contentHash: record.contentHash,
      telegram: {
        parseMode: "HTML",
        chunks: telegramEditorialChunks(record),
      },
      discord: {
        format: "markdown",
        chunks: escapedChunks(record.canonicalText, 2000, escapeDiscordCharacter),
      },
    };
  }

  async function publish(record, receipt = {}) {
    const published = transition(record, "published", "external-delivery-receipt-recorded");
    published.publication = { ...canonicalValue(receipt, "publication receipt"), publishedAt: timestamp() };
    await governedStore.writeProduct(published);
    const persisted = await governedStore.readProduct({ product: published.product, id: published.id });
    if (persisted?.status !== "published" || persisted?.contentHash !== published.contentHash) {
      throw new Error("Obsidian published lifecycle readback failed.");
    }
    return persisted;
  }

  return Object.freeze({ prepare, publish, renderChannels, transition });
}
