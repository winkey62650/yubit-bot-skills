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
const CONFIDENCE_SET = new Set(["Low", "Medium", "High"]);
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

function validateQuality(input, checkedAt) {
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
  const intelligence = input?.intelligence;
  if (!intelligence || typeof intelligence !== "object") {
    reasons.push("A structured market-intelligence payload is required.");
  } else {
    if (!validInstant(intelligence.updatedAt)) reasons.push("Market intelligence requires a canonical updatedAt timestamp.");
    if (!Number.isInteger(intelligence.importance) || intelligence.importance < 1 || intelligence.importance > 5) reasons.push("Importance must be an integer from 1 to 5.");
    if (!nonEmpty(intelligence.horizon)) reasons.push("A market horizon is required.");
    if (!CONFIDENCE_SET.has(intelligence.confidence)) reasons.push("Confidence must be Low, Medium, or High.");
    if (!nonEmpty(intelligence.bias?.asset) || !nonEmpty(intelligence.bias?.direction)) reasons.push("Bias requires both asset and direction.");
    if (!Array.isArray(intelligence.affectedAssets) || intelligence.affectedAssets.length === 0) reasons.push("At least one affected asset is required.");
    if (!nonEmpty(intelligence.whyItMatters)) reasons.push("Why it matters is required.");
    if (!Array.isArray(intelligence.whatToWatch) || intelligence.whatToWatch.length === 0 || intelligence.whatToWatch.some((item) => !nonEmpty(item))) reasons.push("What to watch requires at least one concrete condition.");
    const age = Date.parse(checkedAt) - Date.parse(intelligence.updatedAt);
    const maxAge = {
      "daily-market-brief": 36 * 60 * 60_000,
      "weekly-catalyst-calendar": 7 * 24 * 60 * 60_000,
      "data-flash": 4 * 60 * 60_000,
      "market-follow-up": 2 * 60 * 60_000,
    }[input.product];
    if (intelligence.mode !== "historical-replay" && Number.isFinite(age) && (age < -5 * 60_000 || age > maxAge)) reasons.push("Real-time market intelligence is stale for this product.");
    if (input.product === "daily-market-brief" && (!Array.isArray(intelligence.catalysts) || intelligence.catalysts.length < 1 || intelligence.catalysts.length > 5)) reasons.push("Daily Market Brief requires 1–5 ranked catalysts.");
    if (input.product === "weekly-catalyst-calendar" && (!Array.isArray(intelligence.events) || intelligence.events.length === 0)) reasons.push("Weekly Catalysts requires at least one structured event.");
    if (input.product === "data-flash") {
      for (const field of ["actual", "forecast", "previous", "surprise", "deskView"]) if (!nonEmpty(intelligence.release?.[field])) reasons.push(`Data Flash requires release.${field}.`);
      if (!Array.isArray(intelligence.release?.initialReaction) || intelligence.release.initialReaction.length === 0) reasons.push("Data Flash requires a measured initial reaction.");
    }
    if (input.product === "market-follow-up") {
      for (const field of ["interpretation", "confirmation", "invalidation"]) if (!nonEmpty(intelligence.followUp?.[field])) reasons.push(`Market Follow-up requires followUp.${field}.`);
      if (!Array.isArray(intelligence.followUp?.marketMoves) || intelligence.followUp.marketMoves.length === 0) reasons.push("Market Follow-up requires measured market moves.");
    }
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

const PLAIN_PRODUCT_KICKERS = Object.freeze({
  "daily-market-brief": "DAILY MARKET BRIEF",
  "weekly-catalyst-calendar": "WEEKLY CATALYSTS",
  "data-flash": "DATA FLASH",
  "market-follow-up": "MARKET FOLLOW-UP",
});

function sourcesUsedByFacts(input) {
  const citedIds = new Set((input.facts ?? []).flatMap((fact) => fact.sourceRefs ?? []));
  return (input.sources ?? []).filter((source) => citedIds.has(source.id));
}

function appendPlainProductBody(lines, input) {
  const intelligence = input.intelligence ?? {};
  if (input.product === "daily-market-brief") {
    for (const [index, item] of (intelligence.catalysts ?? []).entries()) {
      lines.push("", `${String(index + 1).padStart(2, "0")} · ${item.headline}`, `WHAT HAPPENED  ${item.happened}`, `WHY IT MATTERS  ${item.whyItMatters}`, `IMPACT  ${(item.affectedAssets ?? []).join(" · ")}`, `WINDOW  ${item.horizon} · ${item.confidence} · ${item.importance}/5`, `WATCH  ${item.whatToWatch}`);
    }
  } else if (input.product === "weekly-catalyst-calendar") {
    for (const item of intelligence.events ?? []) {
      lines.push("", `${item.timeUtc ?? item.timeUtc8} · ${item.title}`, `PREV / CONS / ACTUAL  ${item.previous} / ${item.forecast} / ${item.actual}`, `IMPORTANCE  ${item.importance}/5`, `MARKETS  ${(item.markets ?? []).join(" · ")}`, `WHY IT MATTERS  ${item.whyItMatters}`, `SCENARIO MAP  ${item.scenarioMap}`);
    }
  } else if (input.product === "data-flash") {
    const release = intelligence.release ?? {};
    lines.push("", `ACTUAL  ${release.actual}`, `CONSENSUS  ${release.forecast}`, `PREVIOUS  ${release.previous}`, `SURPRISE  ${release.surprise}`, `INITIAL REACTION  ${(release.initialReaction ?? []).join(" · ")}`, `DESK VIEW  ${release.deskView}`);
  } else if (input.product === "market-follow-up") {
    const followUp = intelligence.followUp ?? {};
    lines.push("", `OBSERVATION WINDOW  ${input.observationWindow?.start} — ${input.observationWindow?.end}`, `MEASURED MOVE  ${(followUp.marketMoves ?? []).join(" · ")}`, `INTERPRETATION  ${followUp.interpretation}`, `CONFIRMS IF  ${followUp.confirmation}`, `INVALIDATES IF  ${followUp.invalidation}`, `CORRELATION NOTE  ${input.correlationStatement}`);
  }
}

function canonicalDocument(input) {
  const intelligence = input.intelligence ?? {};
  const lines = [
    `YUBIT ACADEMY · ${PLAIN_PRODUCT_KICKERS[input.product] ?? "MARKET INTELLIGENCE"}`,
    input.title,
    `UPDATED UTC  ${intelligence.updatedAt ?? ""}`,
    "",
    `BIAS  ${intelligence.bias?.asset ?? ""} · ${intelligence.bias?.direction ?? ""}`,
    `HORIZON  ${intelligence.horizon ?? ""}`,
    `CONFIDENCE  ${intelligence.confidence ?? ""}`,
    `IMPORTANCE  ${intelligence.importance ?? ""}/5`,
  ];
  appendPlainProductBody(lines, input);
  lines.push("", "WHAT TO WATCH");
  for (const item of intelligence.whatToWatch ?? []) lines.push(`• ${item}`);
  lines.push("", "VERIFIED FACTS");
  for (const fact of input.facts ?? []) lines.push(`• ${fact.text}`);
  lines.push("", `RISK BOUNDARY  ${input.risk}`, `INVALIDATION  ${input.invalidation}`);
  const citedSources = sourcesUsedByFacts(input);
  if (citedSources.length) {
    lines.push("", "SOURCES");
    for (const [index, source] of citedSources.entries()) lines.push(`[${index + 1}] ${source.title} — ${source.url}`);
  }
  lines.push("", `${input.cta.label}: ${input.cta.url}`);
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

const PRODUCT_ACCENTS = Object.freeze({
  "daily-market-brief": "🧭",
  "weekly-catalyst-calendar": "📅",
  "data-flash": "⚡",
  "market-follow-up": "🔎",
});

function escapedTelegramText(value) {
  return [...String(value ?? "")].map(escapeTelegramCharacter).join("");
}

function escapedDiscordText(value) {
  return [...String(value ?? "")].map(escapeDiscordCharacter).join("");
}

function formattedUpdatedUtc(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value ?? "");
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(date);
  return `${day} · ${time} UTC`;
}

function editorialRead(record) {
  const intelligence = record.intelligence ?? {};
  if (record.product === "data-flash") return intelligence.release?.deskView ?? intelligence.whyItMatters;
  if (record.product === "market-follow-up") return intelligence.followUp?.interpretation ?? intelligence.whyItMatters;
  return intelligence.whyItMatters;
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
  const accent = PRODUCT_ACCENTS[record.product] ?? "◆";
  const intelligence = record.intelligence ?? {};
  const importance = Number(intelligence.importance) || 0;
  const metadata = `<b>${escapedTelegramText(intelligence.bias?.asset)} · ${escapedTelegramText(String(intelligence.bias?.direction ?? "").toUpperCase())}</b>  |  ${escapedTelegramText(intelligence.horizon)}  |  ${escapedTelegramText(String(intelligence.confidence ?? "").toUpperCase())} CONF.  |  ${"●".repeat(importance)}${"○".repeat(Math.max(0, 5 - importance))}`;
  const title = escapedTelegramText(record.title);
  const updated = escapedTelegramText(formattedUpdatedUtc(intelligence.updatedAt));
  const blocks = [
    `<b>YUBIT ACADEMY  ·  ${accent} ${kicker}</b>`,
    title.length + updated.length + 31 <= 4096
      ? `<b>${title}</b>\n<i>Updated ${updated}</i>`
      : [...wrappedTelegramBlocks(record.title, { prefix: "<b>", suffix: "</b>" }), `<i>Updated ${updated}</i>`],
    ...wrappedTelegramBlocks(editorialRead(record), { prefix: "<blockquote><b>THE READ</b>\n", suffix: "</blockquote>" }),
    metadata,
  ].flat();
  if (record.product === "daily-market-brief") {
    for (const [index, item] of (intelligence.catalysts ?? []).entries()) {
      blocks.push(`<b>${String(index + 1).padStart(2, "0")}  ·  ${escapedTelegramText(String(item.headline ?? "").toUpperCase())}</b>`);
      blocks.push(...wrappedTelegramBlocks(item.happened, { prefix: "<b>WHAT HAPPENED</b>\n" }));
      blocks.push(...wrappedTelegramBlocks(item.whyItMatters, { prefix: "<b>WHY IT MATTERS</b>\n" }));
      blocks.push(`<i>${escapedTelegramText((item.affectedAssets ?? []).join(" · "))}  |  ${escapedTelegramText(item.horizon)} · ${escapedTelegramText(item.confidence)}</i>`);
    }
  } else if (record.product === "weekly-catalyst-calendar") {
    for (const item of intelligence.events ?? []) {
      const eventRail = [...(item.markets ?? []), `${item.importance}/5`].filter(nonEmpty).join("  |  ");
      blocks.push(`<b>${escapedTelegramText(item.timeUtc ?? item.timeUtc8)}  /  ${escapedTelegramText(String(item.title ?? "").toUpperCase())}</b>\n<b>PREV / CONS / ACTUAL</b>  ${escapedTelegramText(`${item.previous} / ${item.forecast} / ${item.actual}`)}\n<i>${escapedTelegramText(eventRail)}</i>`);
      blocks.push(...wrappedTelegramBlocks(item.whyItMatters, { prefix: "<b>WHY IT MATTERS</b>\n" }));
      blocks.push(...wrappedTelegramBlocks(item.scenarioMap, { prefix: "<b>SCENARIO</b>  " }));
    }
  } else if (record.product === "data-flash") {
    const release = intelligence.release ?? {};
    blocks.push(`<b>01  ·  RELEASE</b>\n<b>ACTUAL</b>  ${escapedTelegramText(release.actual)}  |  <b>CONS.</b>  ${escapedTelegramText(release.forecast)}\n<b>PREVIOUS</b>  ${escapedTelegramText(release.previous)}  |  <b>SURPRISE</b>  ${escapedTelegramText(release.surprise)}`);
    blocks.push(...wrappedTelegramBlocks((release.initialReaction ?? []).join(" · "), { prefix: "<b>02  ·  FIRST REACTION</b>\n" }));
    blocks.push(...wrappedTelegramBlocks((intelligence.whatToWatch ?? []).map((item) => `• ${item}`).join("\n"), { prefix: "<b>03  ·  WHAT TO WATCH</b>\n" }));
    blocks.push("<b>✓  VERIFIED EVIDENCE</b>");
    for (const fact of record.facts ?? []) blocks.push(...wrappedTelegramBlocks(fact.text, { prefix: "• " }));
  } else if (record.product === "market-follow-up") {
    const followUp = intelligence.followUp ?? {};
    blocks.push(...wrappedTelegramBlocks((followUp.marketMoves ?? []).join(" · "), { prefix: "<b>01  ·  MEASURED MOVE</b>\n" }));
    blocks.push(...wrappedTelegramBlocks(record.correlationStatement, { prefix: "<b>02  ·  CORRELATION CHECK</b>\n" }));
    blocks.push(...wrappedTelegramBlocks(followUp.confirmation, { prefix: "<b>03  ·  CONFIRMATION TEST</b>\n" }));
  }
  if (record.product !== "data-flash") {
    blocks.push(...wrappedTelegramBlocks((intelligence.whatToWatch ?? []).map((item) => `• ${item}`).join("\n"), { prefix: "<b>👀  WATCH NEXT</b>\n" }));
  }
  blocks.push(
    ...wrappedTelegramBlocks(record.risk, { prefix: "<b>⚠️  RISK BOUNDARY</b>\n" }),
    ...wrappedTelegramBlocks(record.invalidation, { prefix: "<i>Invalidates: ", suffix: "</i>" }),
  );
  const citedSources = sourcesUsedByFacts(record);
  if (citedSources.length) {
    blocks.push("<b>🔗  SOURCES</b>");
    for (const [index, source] of citedSources.entries()) {
      const label = escapedTelegramText(`${index + 1}. ${source.title}`);
      const url = escapedTelegramText(source.url);
      blocks.push(`<a href="${url}">${label}</a>`);
    }
  }
  const ctaUrl = escapedTelegramText(record.cta?.url);
  const ctaLabel = escapedTelegramText(record.cta?.label);
  const linkedCta = `<a href="${ctaUrl}">${ctaLabel}</a>`;
  blocks.push(linkedCta.length <= 4096
    ? linkedCta
    : wrappedTelegramBlocks(`${record.cta?.label}: ${record.cta?.url}`));
  return packTelegramBlocks(blocks);
}

function wrappedDiscordBlocks(value, { prefix = "", suffix = "", limit = 2000 } = {}) {
  const available = limit - prefix.length - suffix.length;
  if (available < 1) throw new RangeError("Discord wrapper exceeds the platform limit.");
  return escapedChunks(String(value ?? ""), available, escapeDiscordCharacter)
    .map((chunk) => `${prefix}${chunk}${suffix}`);
}

function packDiscordBlocks(blocks, limit = 2000) {
  const chunks = [];
  let current = "";
  for (const block of blocks.filter(Boolean).flat()) {
    if (block.length > limit) throw new RangeError("A Discord editorial block exceeds the platform limit.");
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

function discordEditorialChunks(record) {
  const kicker = PLAIN_PRODUCT_KICKERS[record.product] ?? "MARKET INTELLIGENCE";
  const accent = PRODUCT_ACCENTS[record.product] ?? "◆";
  const intelligence = record.intelligence ?? {};
  const importance = Number(intelligence.importance) || 0;
  const blocks = [
    `**YUBIT ACADEMY  ·  ${accent} ${kicker}**`,
    ...wrappedDiscordBlocks(record.title, { prefix: "**", suffix: "**" }),
    `*Updated ${escapedDiscordText(formattedUpdatedUtc(intelligence.updatedAt))}*`,
    ...wrappedDiscordBlocks(editorialRead(record), { prefix: "> **THE READ**\n> " }),
    `**${escapedDiscordText(intelligence.bias?.asset)} · ${escapedDiscordText(String(intelligence.bias?.direction ?? "").toUpperCase())}**  \\|  ${escapedDiscordText(intelligence.horizon)}  \\|  ${escapedDiscordText(String(intelligence.confidence ?? "").toUpperCase())} CONF.  \\|  ${"●".repeat(importance)}${"○".repeat(Math.max(0, 5 - importance))}`,
  ];
  if (record.product === "daily-market-brief") {
    for (const [index, item] of (intelligence.catalysts ?? []).entries()) {
      blocks.push(`**${String(index + 1).padStart(2, "0")}  ·  ${escapedDiscordText(String(item.headline ?? "").toUpperCase())}**`);
      blocks.push(...wrappedDiscordBlocks(item.happened, { prefix: "**WHAT HAPPENED**\n" }));
      blocks.push(...wrappedDiscordBlocks(item.whyItMatters, { prefix: "**WHY IT MATTERS**\n" }));
      blocks.push(`*${escapedDiscordText((item.affectedAssets ?? []).join(" · "))}  \\|  ${escapedDiscordText(item.horizon)} · ${escapedDiscordText(item.confidence)}*`);
    }
  } else if (record.product === "weekly-catalyst-calendar") {
    for (const item of intelligence.events ?? []) {
      const eventRail = [...(item.markets ?? []), `${item.importance}/5`].filter(nonEmpty).join("  |  ");
      blocks.push(`**${escapedDiscordText(item.timeUtc ?? item.timeUtc8)}  /  ${escapedDiscordText(String(item.title ?? "").toUpperCase())}**\n**PREV / CONS / ACTUAL**  ${escapedDiscordText(`${item.previous} / ${item.forecast} / ${item.actual}`)}\n*${escapedDiscordText(eventRail)}*`);
      blocks.push(...wrappedDiscordBlocks(item.whyItMatters, { prefix: "**WHY IT MATTERS**\n" }));
      blocks.push(...wrappedDiscordBlocks(item.scenarioMap, { prefix: "**SCENARIO**  " }));
    }
  } else if (record.product === "data-flash") {
    const release = intelligence.release ?? {};
    blocks.push(`**01  ·  RELEASE**\n**ACTUAL**  ${escapedDiscordText(release.actual)}  \\|  **CONS.**  ${escapedDiscordText(release.forecast)}\n**PREVIOUS**  ${escapedDiscordText(release.previous)}  \\|  **SURPRISE**  ${escapedDiscordText(release.surprise)}`);
    blocks.push(...wrappedDiscordBlocks((release.initialReaction ?? []).join(" · "), { prefix: "**02  ·  FIRST REACTION**\n" }));
    blocks.push(...wrappedDiscordBlocks((intelligence.whatToWatch ?? []).map((item) => `• ${item}`).join("\n"), { prefix: "**03  ·  WHAT TO WATCH**\n" }));
    blocks.push("**✓  VERIFIED EVIDENCE**");
    for (const fact of record.facts ?? []) blocks.push(...wrappedDiscordBlocks(fact.text, { prefix: "• " }));
  } else if (record.product === "market-follow-up") {
    const followUp = intelligence.followUp ?? {};
    blocks.push(...wrappedDiscordBlocks((followUp.marketMoves ?? []).join(" · "), { prefix: "**01  ·  MEASURED MOVE**\n" }));
    blocks.push(...wrappedDiscordBlocks(record.correlationStatement, { prefix: "**02  ·  CORRELATION CHECK**\n" }));
    blocks.push(...wrappedDiscordBlocks(followUp.confirmation, { prefix: "**03  ·  CONFIRMATION TEST**\n" }));
  }
  if (record.product !== "data-flash") {
    blocks.push(...wrappedDiscordBlocks((intelligence.whatToWatch ?? []).map((item) => `• ${item}`).join("\n"), { prefix: "**👀  WATCH NEXT**\n" }));
  }
  blocks.push(...wrappedDiscordBlocks(record.risk, { prefix: "**⚠️  RISK BOUNDARY**\n" }));
  blocks.push(...wrappedDiscordBlocks(record.invalidation, { prefix: "*Invalidates: ", suffix: "*" }));
  const citedSources = sourcesUsedByFacts(record);
  if (citedSources.length) {
    blocks.push("**🔗  SOURCES**");
    for (const [index, source] of citedSources.entries()) blocks.push(`${index + 1}\\. ${escapedDiscordText(source.title)} — <${source.url}>`);
  }
  blocks.push(`[${escapedDiscordText(record.cta?.label)}](${record.cta?.url})`);
  return packDiscordBlocks(blocks);
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
      sources: input.sources ?? [],
      facts: input.facts ?? [],
      inferences: input.inferences ?? [],
      risk: input.risk ?? "",
      invalidation: input.invalidation ?? "",
      cta: input.cta ?? null,
      intelligence: input.intelligence ?? null,
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

    const qualityReasons = validateQuality(input, timestamp());
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
        chunks: discordEditorialChunks(record),
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
