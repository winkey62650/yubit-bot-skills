export const MARKET_EDITORIAL_ARTICLE_VERSION = "market-editorial-v1";

const VERDICTS = new Set(["Confirmed", "Divergent", "Awaiting Confirmation"]);
const DISCLAIMER = "For informational and educational purposes only. This is not investment advice or a trading signal.";
const REACTION_SYMBOLS = ["BTC", "ETH", "DXY"];

function text(value) {
  return String(value ?? "").trim();
}

function unique(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}

function iso(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} requires a valid timestamp.`);
  return date.toISOString();
}

function absoluteHttpsUrl(value) {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function canonicalReleaseSlug(value) {
  const slug = text(value);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new TypeError("Data Update release slug must be canonical lowercase kebab-case.");
  }
  return slug;
}

function canonicalDate(value) {
  const date = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new TypeError("Data Update date must be canonical YYYY-MM-DD.");
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new TypeError("Data Update date must be canonical YYYY-MM-DD.");
  }
  return date;
}

function canonicalWeek(value) {
  const week = text(value);
  if (!/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(week)) {
    throw new TypeError("Weekly Calendar key requires a canonical ISO week slug.");
  }
  const [yearText, weekText] = week.split("-W");
  if (weekText === "53" && isoWeekSlug(`${yearText}-12-28T00:00:00.000Z`) !== week) {
    throw new TypeError("Weekly Calendar key requires a real canonical ISO week slug.");
  }
  return week;
}

function isoWeekSlug(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Weekly Calendar article requires a valid weekStart.");
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function fieldValue(value) {
  return value && typeof value === "object" && "value" in value ? value.value : value;
}

function sourceRecord(source) {
  const url = absoluteHttpsUrl(source?.url ?? source?.sourceUrl);
  if (!url) return null;
  return {
    id: text(source?.id ?? source?.sourceId) || new URL(url).hostname,
    label: text(source?.label ?? source?.name ?? source?.sourceId ?? source?.id) || new URL(url).hostname,
    type: text(source?.type ?? source?.kind ?? source?.authority) || "source",
    url,
    ...(text(source?.retrievedAt) ? { retrievedAt: iso(source.retrievedAt, "Source") } : {}),
    ...(text(source?.status) ? { status: text(source.status) } : {}),
  };
}

function dedupeSources(sources) {
  const byUrl = new Map();
  for (const candidate of sources) {
    const normalized = sourceRecord(candidate);
    if (normalized && !byUrl.has(normalized.url)) byUrl.set(normalized.url, normalized);
  }
  return [...byUrl.values()];
}

function fieldProvenance(field, fallbackSource) {
  const sourceUrl = absoluteHttpsUrl(field?.sourceUrl ?? fallbackSource?.url ?? fallbackSource?.sourceUrl);
  const sourceId = text(field?.sourceId ?? fallbackSource?.id ?? fallbackSource?.sourceId);
  if (!sourceId || !sourceUrl) throw new Error("Editorial event field provenance requires a sourceId and HTTPS sourceUrl.");
  return {
    sourceId,
    sourceUrl,
    status: text(field?.status) || "verified",
    authority: text(field?.authority ?? fallbackSource?.type ?? fallbackSource?.kind) || "source",
    ...(text(field?.retrievedAt) ? { retrievedAt: iso(field.retrievedAt, "Field provenance") } : {}),
    ...(text(field?.publishedAt) ? { publishedAt: iso(field.publishedAt, "Field provenance") } : {}),
  };
}

function factValuesMatch(left, right) {
  const promoteBaseCount = (measure) => measure?.dimension === "scalar"
    && Number.isInteger(measure.baseValue)
    && Math.abs(measure.baseValue) >= 1_000
    ? { ...measure, dimension: "count" }
    : measure;
  const leftMeasure = promoteBaseCount(measuredValue(left));
  const rightMeasure = promoteBaseCount(measuredValue(right));
  if (leftMeasure && rightMeasure) {
    return leftMeasure.dimension === rightMeasure.dimension
      && leftMeasure.baseValue === rightMeasure.baseValue;
  }
  return text(left) === text(right);
}

function literalMeasureUnit(value) {
  return text(value).match(/(%|K|M|B)$/iu)?.[1].toUpperCase() ?? "";
}

function provenanceValueMatches(adoptedValue, candidate, unit) {
  if (factValuesMatch(adoptedValue, candidate)) return true;
  if (["%", "K", "M", "B"].includes(unit) && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(text(candidate))) {
    return factValuesMatch(adoptedValue, `${text(candidate)}${unit}`);
  }
  return false;
}

function assertFieldProvenanceMatches(field, adoptedValue, fieldName) {
  if (!field || typeof field !== "object") return;
  const unit = text(field.unit).toUpperCase();
  for (const key of ["value", "rawValue"]) {
    if (!Object.hasOwn(field, key) || field[key] === null || field[key] === undefined || text(field[key]) === "") continue;
    const literalUnit = literalMeasureUnit(field[key]);
    if (unit && literalUnit && unit !== literalUnit) {
      throw new Error(`Editorial ${fieldName} provenance unit must match the adopted fact.`);
    }
    if (!provenanceValueMatches(adoptedValue, field[key], unit)) {
      throw new Error(`Editorial ${fieldName} provenance value must match the adopted fact.`);
    }
  }
  if (!Object.hasOwn(field, "unit") || field.unit === null || text(field.unit) === "") return;
  const rawMeasure = measuredValue(adoptedValue);
  const measure = rawMeasure?.dimension === "scalar"
    && Number.isInteger(rawMeasure.baseValue)
    && Math.abs(rawMeasure.baseValue) >= 1_000
    ? { ...rawMeasure, dimension: "count" }
    : rawMeasure;
  const compatible = unit === "%"
    ? measure?.dimension === "percent"
    : Object.hasOwn(UNIT_SCALE, unit)
      ? measure?.dimension === "count"
      : text(adoptedValue).toUpperCase().endsWith(unit);
  if (!compatible) throw new Error(`Editorial ${fieldName} provenance unit must match the adopted fact.`);
}

const JURISDICTION_ALIASES = Object.freeze({
  us: "us",
  usa: "us",
  unitedstates: "us",
  unitedstatesofamerica: "us",
  uk: "uk",
  gb: "uk",
  gbr: "uk",
  greatbritain: "uk",
  unitedkingdom: "uk",
});

function canonicalJurisdiction(value) {
  const token = text(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  const compactToken = token.replaceAll("-", "");
  return (JURISDICTION_ALIASES[compactToken] ?? token) || "global";
}

function eventIndicator(event) {
  return text(event?.indicator ?? event?.id).toLowerCase();
}

function eventRead(event) {
  const indicator = eventIndicator(event);
  const country = text(event?.jurisdiction ?? event?.country) || "Global";
  const catalog = {
    "fomc-rate-decision": [
      "The policy decision can reprice the global cost of dollar liquidity.",
      "Policy path → Treasury yields and DXY → risk appetite and crypto liquidity.",
      ["BTC", "ETH", "DXY", "US Treasuries"],
    ],
    "fomc-statement": [
      "Policy language can move the expected rate path even when the target range is unchanged.",
      "Policy language → rate expectations → DXY and global risk positioning.",
      ["BTC", "ETH", "DXY", "US Treasuries"],
    ],
    "nonfarm-payrolls": [
      "Labour-market momentum can change both rate expectations and the growth-risk balance.",
      "Employment data → Fed path → yields and DXY → crypto risk appetite.",
      ["BTC", "ETH", "DXY", "US Treasuries"],
    ],
    cpi: [
      "Inflation is a direct input into the expected policy path and real-rate outlook.",
      "Inflation → Fed path → yields and DXY → crypto valuation and liquidity.",
      ["BTC", "ETH", "DXY", "US Treasuries"],
    ],
    "core-cpi": [
      "Core inflation tests whether underlying price pressure is becoming persistent.",
      "Core inflation → Fed path → yields and DXY → crypto valuation and liquidity.",
      ["BTC", "ETH", "DXY", "US Treasuries"],
    ],
    pce: [
      "The Fed's preferred inflation measure can reset policy expectations.",
      "PCE inflation → Fed path → yields and DXY → crypto liquidity.",
      ["BTC", "ETH", "DXY", "US Treasuries"],
    ],
    "core-pce": [
      "Core PCE can change the market's view of persistent inflation and the policy path.",
      "Core PCE → Fed path → yields and DXY → crypto liquidity.",
      ["BTC", "ETH", "DXY", "US Treasuries"],
    ],
    gdp: [
      "Growth data tests the balance between resilient demand and restrictive financial conditions.",
      "Growth → rate expectations and earnings risk → broad risk appetite and crypto.",
      ["BTC", "ETH", "DXY", "Equities"],
    ],
  };
  const fallback = [
    `${country} data can alter rate, FX, and cross-asset risk expectations.`,
    `${country} macro signal → local rates and FX → global risk appetite and crypto.`,
    ["BTC", "ETH", `${country} FX`, `${country} rates`],
  ];
  return catalog[indicator] ?? fallback;
}

function eventImpactScore(event) {
  const candidates = [event?.marketImpact?.score, event?.impactScore, event?.ranking?.score, event?.score];
  const score = candidates
    .filter((candidate) => candidate !== null && candidate !== undefined && text(candidate) !== "")
    .map(Number)
    .find(Number.isFinite);
  return score ?? (Number(event?.importance) || 0) * 10;
}

function compareText(left, right) {
  const a = text(left);
  const b = text(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function stableFingerprint(value) {
  if (Array.isArray(value)) return `[${value.map(stableFingerprint).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableFingerprint(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function eventTimestamp(event) {
  return iso(fieldValue(event?.schedule) ?? event?.scheduledAt ?? event?.time, "Weekly Calendar event");
}

function weeklyEventRecord(event, rank) {
  const [defaultWhy, defaultTransmission, defaultAssets] = eventRead(event);
  const schedule = event?.schedule && typeof event.schedule === "object" ? event.schedule : event?.provenance?.schedule;
  const source = event?.source ?? {};
  const utcTime = eventTimestamp(event);
  const forecast = event?.values?.forecast;
  const previous = event?.values?.previous;
  const hasForecast = fieldValue(forecast) !== undefined && fieldValue(forecast) !== null && text(fieldValue(forecast)) !== "";
  const hasPrevious = fieldValue(previous) !== undefined && fieldValue(previous) !== null && text(fieldValue(previous)) !== "";
  assertFieldProvenanceMatches(schedule, utcTime, "schedule");
  if (hasForecast) assertFieldProvenanceMatches(
    forecast && typeof forecast === "object" ? forecast : event?.provenance?.forecast,
    fieldValue(forecast),
    "forecast",
  );
  if (hasPrevious) assertFieldProvenanceMatches(
    previous && typeof previous === "object" ? previous : event?.provenance?.previous,
    fieldValue(previous),
    "previous",
  );
  return {
    id: text(event?.id ?? event?.sourceId) || `event-${rank}`,
    rank,
    title: text(event?.title ?? event?.name) || "Verified market event",
    utcTime,
    jurisdiction: text(event?.jurisdiction ?? event?.country) || "Global",
    impactScore: eventImpactScore(event),
    whyItMatters: text(event?.whyItMatters) || defaultWhy,
    transmissionPath: text(event?.transmissionPath) || defaultTransmission,
    affectedAssets: unique(Array.isArray(event?.affectedAssets) ? event.affectedAssets : defaultAssets),
    scenarioMap: text(event?.scenarioMap) || "Confirmation requires rates, FX and crypto breadth to move consistently with the initial signal.",
    fieldProvenance: {
      schedule: fieldProvenance(schedule, source),
      ...(hasForecast ? { forecast: fieldProvenance(
        forecast && typeof forecast === "object" ? forecast : event?.provenance?.forecast,
      ) } : {}),
      ...(hasPrevious ? { previous: fieldProvenance(
        previous && typeof previous === "object" ? previous : event?.provenance?.previous,
      ) } : {}),
    },
    values: {
      ...(hasForecast ? { forecast: fieldValue(forecast) } : {}),
      ...(hasPrevious ? { previous: fieldValue(previous) } : {}),
    },
  };
}

const COUNTRY_ABBREVIATIONS = new Set(["u.s.", "u.k."]);
const CONTINUING_ABBREVIATIONS = new Set(["e.g.", "i.e.", "vs."]);

function abbreviationAtPeriod(sentence, index) {
  const prefix = sentence.slice(0, index + 1);
  return prefix.match(/(?:\b(?:e\.g|i\.e|u\.s|u\.k)|\bvs)\.$/iu)?.[0].toLowerCase() ?? "";
}

function countryAbbreviationContinuesSentence(abbreviation, prefix, suffix) {
  if (!COUNTRY_ABBREVIATIONS.has(abbreviation) || !/^\s+/u.test(suffix)) return false;
  const nextWord = suffix.match(/^\s+([A-Za-z0-9][A-Za-z0-9-]*)/u)?.[1] ?? "";
  if (!nextWord) return false;
  if (/^[a-z]/u.test(nextWord)) return true;
  if (/\b(?:in|within|inside|outside|across|throughout|around|near|from|into|toward|towards)\s+(?:the\s+)?$/iu.test(prefix)) {
    return false;
  }
  const precedingText = text(prefix);
  const countryIsSubjectModifier = !precedingText || /^(?:the|a|an)$/iu.test(precedingText);
  return /^\d+-(?:day|week|month|year)$/iu.test(nextWord)
    || (countryIsSubjectModifier && /^[A-Z0-9]/u.test(nextWord));
}

function isInternalSentenceBoundary(sentence, index) {
  const punctuation = sentence[index];
  const suffix = sentence.slice(index + 1);
  if (!suffix) return false;
  if (punctuation === "!" || punctuation === "?") return /^\s*\S/u.test(suffix);
  if (/\d/u.test(sentence[index - 1] ?? "") && /\d/u.test(sentence[index + 1] ?? "")) return false;
  if (/\d/u.test(sentence[index + 1] ?? "") && (!sentence[index - 1] || /[\s$([{=:+-]/u.test(sentence[index - 1]))) return false;
  if (/[A-Za-z]/u.test(sentence[index + 1] ?? "") && sentence[index + 2] === ".") return false;
  const abbreviation = abbreviationAtPeriod(sentence, index);
  if (CONTINUING_ABBREVIATIONS.has(abbreviation) && /^\s+\S/u.test(suffix)) return false;
  if (countryAbbreviationContinuesSentence(abbreviation, sentence.slice(0, index + 1 - abbreviation.length), suffix)) return false;
  return /^(?:["')\]]*)?(?:\s+\S|\S)/u.test(suffix);
}

function oneSentence(value, fallback) {
  const sentence = text(value || fallback).replace(/\s+/g, " ").replace(/[.!?。！？]+$/u, "");
  let hasInternalLatinBoundary = false;
  for (let index = 0; index < sentence.length; index += 1) {
    if (".!?".includes(sentence[index]) && isInternalSentenceBoundary(sentence, index)) {
      hasInternalLatinBoundary = true;
      break;
    }
  }
  if (hasInternalLatinBoundary || /[。！？]/u.test(sentence)) {
    throw new TypeError("Weekly Calendar core view must contain exactly one sentence.");
  }
  return `${sentence}.`;
}

function readableDate(value) {
  const date = new Date(`${canonicalDate(value)}T00:00:00.000Z`);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function weeklySources(events, manifest) {
  return dedupeSources([
    ...(Array.isArray(manifest) ? manifest : []),
    ...events.flatMap((event) => Object.values(event.fieldProvenance ?? {}).map((field) => ({
      id: field.sourceId,
      label: field.sourceId,
      type: field.authority,
      url: field.sourceUrl,
      retrievedAt: field.retrievedAt,
      status: field.status,
    }))),
  ]);
}

const EMBEDDED_URL = /(?:[a-z][a-z0-9+.-]*:\/\/|(?:^|[^\p{L}\p{N}_])(?:t\.me\/|www\.|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?=[/?#:.,;!?)\]}]|\s|$)))/iu;

function assertCommunityTextHasNoUrls(nodes) {
  for (const node of nodes) {
    if (node.type === "link") {
      if (EMBEDDED_URL.test(text(node.text))) throw new Error("Task5 community entry must contain exactly one URL in its link target.");
      continue;
    }
    for (const value of [node.text, node.label, node.value]) {
      if (EMBEDDED_URL.test(text(value))) throw new Error("Task5 community entry rejects embedded URLs outside its single article link.");
    }
  }
}

const TELEGRAM_MESSAGE_LIMIT = 4096;

function htmlBudgetEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function telegramNodeForBudget(node) {
  if (node.type === "heading") return `<b>${htmlBudgetEscape(node.text)}</b>`;
  if (node.type === "paragraph") return htmlBudgetEscape(node.text);
  if (node.type === "metric") return `<b>${htmlBudgetEscape(node.label)}:</b> ${htmlBudgetEscape(node.value)}`;
  if (node.type === "link") return `<a href="${htmlBudgetEscape(node.url)}">${htmlBudgetEscape(node.text)}</a>`;
  if (node.type === "divider") return "───";
  throw new Error(`Unsupported Task5 community node: ${node?.type ?? "missing"}`);
}

function telegramNodesLength(nodes) {
  return nodes.map(telegramNodeForBudget).join("\n").length;
}

function truncateText(value, limit) {
  const original = text(value);
  if (original.length <= limit) return original;
  return `${original.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function fitTelegramCommunityNodes(inputNodes) {
  const nodes = inputNodes.map((node) => {
    if (node.type === "heading") return { ...node, text: truncateText(node.text, 220) };
    if (node.type === "paragraph") return { ...node, text: truncateText(node.text, 480) };
    if (node.type === "metric") return { ...node, label: truncateText(node.label, 96), value: truncateText(node.value, 256) };
    if (node.type === "link") return { ...node, text: truncateText(node.text, 120) };
    return { ...node };
  });
  let length = telegramNodesLength(nodes);
  while (length > TELEGRAM_MESSAGE_LIMIT) {
    const candidates = nodes.flatMap((node) => {
      if (node.type === "paragraph" && !/not investment advice/i.test(node.text)) return [{ node, field: "text", minimum: /^\d+\. /u.test(node.text) ? 120 : 96 }];
      if (node.type === "metric") return [{ node, field: "value", minimum: 32 }];
      if (node.type === "heading") return [{ node, field: "text", minimum: 40 }];
      if (node.type === "link") return [{ node, field: "text", minimum: 20 }];
      return [];
    }).filter(({ node, field, minimum }) => text(node[field]).length > minimum)
      .sort((left, right) => text(right.node[right.field]).length - text(left.node[left.field]).length);
    if (!candidates.length) {
      throw new Error("Task5 community entry cannot fit Telegram's 4096-character limit without losing required facts.");
    }
    const { node, field, minimum } = candidates[0];
    const currentLength = text(node[field]).length;
    const reduction = Math.min(currentLength - minimum, Math.max(16, Math.ceil((length - TELEGRAM_MESSAGE_LIMIT) / 3)));
    node[field] = truncateText(node[field], currentLength - reduction);
    length = telegramNodesLength(nodes);
  }
  return nodes;
}

function dailyWatchlist(events) {
  const grouped = new Map();
  for (const event of events) {
    const date = event.utcTime.slice(0, 10);
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date).push(`${event.title} (${event.utcTime.slice(11, 16)} UTC)`);
  }
  return [...grouped.entries()].map(([date, items]) => ({ date, items }));
}

export function weeklyCalendarPublicationKey(week) {
  return `${MARKET_EDITORIAL_ARTICLE_VERSION}:weekly-calendar:${canonicalWeek(week)}`;
}

export function dataUpdatePublicationKey(release, date) {
  return `${MARKET_EDITORIAL_ARTICLE_VERSION}:data-update:${canonicalReleaseSlug(release)}:${canonicalDate(date)}`;
}

function weeklyPublicationIdentity(document) {
  const weekStart = canonicalDate(document?.weekStart);
  const weekEnd = canonicalDate(document?.weekEnd);
  const start = new Date(`${weekStart}T00:00:00.000Z`);
  const end = new Date(`${weekEnd}T00:00:00.000Z`);
  if (start.getUTCDay() !== 1) throw new TypeError("Weekly Calendar weekStart must be a canonical Monday.");
  if (end.getUTCDay() !== 0) throw new TypeError("Weekly Calendar weekEnd must be a canonical Sunday.");
  if (end.getTime() - start.getTime() !== 6 * 86400000) {
    throw new TypeError("Weekly Calendar range must cover one ordered seven-day Monday-to-Sunday week.");
  }
  const slug = canonicalWeek(isoWeekSlug(start));
  if (isoWeekSlug(end) !== slug) throw new TypeError("Weekly Calendar slug and date range identity must agree.");
  const hasSuppliedSlug = document && Object.hasOwn(document, "slug");
  const hasSuppliedWeek = document && Object.hasOwn(document, "week");
  const suppliedSlug = hasSuppliedSlug ? canonicalWeek(document.slug) : null;
  const suppliedWeek = hasSuppliedWeek ? canonicalWeek(document.week) : null;
  if (suppliedSlug !== null && suppliedWeek !== null && suppliedSlug !== suppliedWeek) {
    throw new TypeError("Weekly Calendar supplied slug and week identity must agree.");
  }
  if ((suppliedSlug !== null && suppliedSlug !== slug) || (suppliedWeek !== null && suppliedWeek !== slug)) {
    throw new TypeError("Weekly Calendar supplied slug and week must match its date range identity.");
  }
  return { slug, weekStart, weekEnd };
}

export function buildWeeklyCalendarArticle({ document, rankedEvents, sourceManifest, marketSetup } = {}) {
  const identity = weeklyPublicationIdentity(document);
  const weekStartTime = new Date(`${identity.weekStart}T00:00:00.000Z`).getTime();
  const weekEndTime = new Date(`${identity.weekEnd}T23:59:59.999Z`).getTime();
  const events = [];
  const canonicalIdentities = new Set();
  const semanticIdentities = new Set();
  for (const event of Array.isArray(rankedEvents) ? rankedEvents : []) {
    if (!text(event?.title ?? event?.name) || !(event?.scheduledAt || fieldValue(event?.schedule))) continue;
    const timestamp = eventTimestamp(event);
    const time = new Date(timestamp).getTime();
    if (time < weekStartTime || time > weekEndTime) continue;
    const normalizeIdentityPart = (value) => text(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
    const canonicalId = normalizeIdentityPart(event?.id ?? event?.sourceId);
    const semanticIdentity = [
      normalizeIdentityPart(eventIndicator(event)),
      canonicalJurisdiction(event?.jurisdiction ?? event?.country),
      timestamp,
    ].join("|");
    if (canonicalId && canonicalIdentities.has(canonicalId)) {
      throw new Error(`Weekly Calendar duplicate event identity conflict: ${canonicalId}.`);
    }
    if (semanticIdentities.has(semanticIdentity)) {
      throw new Error(`Weekly Calendar duplicate semantic event conflict: ${semanticIdentity}.`);
    }
    if (canonicalId) canonicalIdentities.add(canonicalId);
    semanticIdentities.add(semanticIdentity);
    events.push(event);
  }
  events.sort((left, right) => eventImpactScore(right) - eventImpactScore(left)
      || compareText(eventTimestamp(left), eventTimestamp(right))
      || compareText(left?.id, right?.id)
      || compareText(left?.title ?? left?.name, right?.title ?? right?.name)
      || compareText(left?.jurisdiction ?? left?.country, right?.jurisdiction ?? right?.country)
      || compareText(stableFingerprint(left), stableFingerprint(right)));
  if (events.length < 3) throw new Error("Weekly Calendar article requires at least three eligible events.");
  const impactRankedEvents = events.map(weeklyEventRecord);
  const priorityEvents = impactRankedEvents.slice(0, 3);
  const { slug, weekStart, weekEnd } = identity;
  const generatedAt = iso(document?.generatedAt, "Weekly Calendar article");
  const setupSummary = text(marketSetup?.summary) || "Cross-asset positioning remains conditional on verified macro catalysts and follow-through in rates, DXY and crypto breadth.";

  return {
    id: `weekly-calendar:${slug}`,
    type: "weekly-calendar-analysis",
    version: MARKET_EDITORIAL_ARTICLE_VERSION,
    slug,
    publishedAt: generatedAt,
    weekStart,
    weekEnd,
    kicker: "YUBIT ACADEMY / EDITORIAL RESEARCH",
    title: `Weekly Market Risk Playbook | ${slug}`,
    coreView: oneSentence(document?.coreView, `${priorityEvents[0].title} is the week's highest-impact catalyst, while confirmation still depends on rates, DXY and crypto breadth`),
    marketSetup: {
      summary: setupSummary,
      observedAt: iso(marketSetup?.observedAt ?? generatedAt, "Weekly market setup"),
      label: "Observed market setup",
    },
    priorityEvents,
    impactRankedEvents,
    tierOneAnalysis: priorityEvents.map((event) => ({
      id: event.id,
      headline: event.title,
      whyItMatters: event.whyItMatters,
      transmissionPath: event.transmissionPath,
      affectedAssets: event.affectedAssets,
      scenarioMap: event.scenarioMap,
      fieldProvenance: event.fieldProvenance,
    })),
    scenarios: [
      { id: "base", label: "Base case", condition: "The priority events land close to the available benchmark and cross-asset volatility remains contained.", implication: "Keep conviction conditional and focus on confirmed relative moves rather than the first headline reaction." },
      { id: "strengthening", label: "Strengthening", condition: "At least two of rates, DXY and crypto breadth reinforce the same directional read after the priority catalyst.", implication: "The week's dominant macro thesis gains credibility and may carry into the next liquidity session." },
      { id: "invalidation", label: "Invalidation", condition: "BTC returns through its pre-event range while rates or DXY reverse the initial signal.", implication: "Downgrade the initial narrative and reassess concurrent catalysts before taking a directional view." },
    ],
    dailyWatchlist: dailyWatchlist(impactRankedEvents),
    sources: weeklySources(impactRankedEvents, sourceManifest),
    limitations: [
      "Calendar times can change; every event time must be rechecked against the cited source before publication.",
      "Market-impact ranking is an editorial assessment, not a prediction of realized volatility or direction.",
    ],
    disclaimer: DISCLAIMER,
  };
}

export function buildWeeklyCalendarCommunityDocument(article, { articleUrl } = {}) {
  const url = absoluteHttpsUrl(articleUrl);
  if (!url) throw new TypeError("Weekly Calendar community entry requires an absolute HTTPS article link.");
  const priorities = Array.isArray(article?.priorityEvents) ? article.priorityEvents : [];
  if (priorities.length !== 3) throw new Error("Weekly Calendar community entry requires exactly three priority events.");
  const dateRange = `${readableDate(article.weekStart)} – ${readableDate(article.weekEnd)}`;
  const strengthening = article?.scenarios?.find((scenario) => scenario.id === "strengthening")?.condition;
  const invalidation = article?.scenarios?.find((scenario) => scenario.id === "invalidation")?.condition;
  const nodes = [
    { type: "heading", text: `📌 Weekly Market Calendar — ${dateRange}`, level: 1 },
    { type: "paragraph", text: `Core view: ${text(article.coreView)}` },
    { type: "heading", text: "The three events that matter most", level: 2 },
    ...priorities.map((event, index) => ({
      type: "paragraph",
      text: `${index + 1}. ${event.title} | ${event.utcTime.slice(0, 16).replace("T", " ")} UTC — ${event.whyItMatters} ${event.transmissionPath}`,
    })),
    { type: "paragraph", text: `Confirmation: ${text(strengthening)}` },
    { type: "paragraph", text: `Invalidation: ${text(invalidation)}` },
    { type: "link", text: "Read the full weekly playbook →", url },
    { type: "paragraph", text: "Market information only — not investment advice." },
  ];
  assertCommunityTextHasNoUrls(nodes);
  return {
    templateId: "weekly-calendar-community",
    version: MARKET_EDITORIAL_ARTICLE_VERSION,
    generatedAt: article.publishedAt,
    title: `📌 Weekly Market Calendar — ${dateRange}`,
    articleUrl: url,
    nodes: fitTelegramCommunityNodes(nodes),
  };
}

function releaseValues(event) {
  const values = event?.values ?? {};
  const provenance = event?.provenance ?? {};
  const read = (key) => fieldValue(values[key] ?? event?.[key] ?? provenance[key]);
  return { actual: read("actual"), forecast: read("forecast"), previous: read("previous") };
}

const UNIT_SCALE = Object.freeze({ K: 1_000, M: 1_000_000, B: 1_000_000_000 });

function measuredValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { baseValue: value, dimension: "scalar", scale: 1, unit: "" };
  }
  const match = text(value).replaceAll(",", "").match(/^([-+]?\d+(?:\.\d+)?)\s*(K|M|B|%)?$/iu);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "").toUpperCase();
  if (!Number.isFinite(amount)) return null;
  if (unit === "%") return { baseValue: amount, dimension: "percent", scale: 1, unit };
  if (UNIT_SCALE[unit]) return { baseValue: amount * UNIT_SCALE[unit], dimension: "count", scale: UNIT_SCALE[unit], unit };
  return { baseValue: amount, dimension: "scalar", scale: 1, unit: "" };
}

function conciseNumber(value) {
  const rounded = Math.round((Object.is(value, -0) ? 0 : value) * 10000) / 10000;
  return String(rounded);
}

function releaseComparison(actual, forecast) {
  let actualMeasure = measuredValue(actual);
  let forecastMeasure = measuredValue(forecast);
  if (!actualMeasure || !forecastMeasure) return null;
  if (actualMeasure.dimension !== forecastMeasure.dimension) {
    const promoteBaseCount = (measure) => measure.dimension === "scalar"
      && Number.isInteger(measure.baseValue)
      && Math.abs(measure.baseValue) >= 1_000
      ? { ...measure, dimension: "count" }
      : measure;
    actualMeasure = promoteBaseCount(actualMeasure);
    forecastMeasure = promoteBaseCount(forecastMeasure);
  }
  if (actualMeasure.dimension !== forecastMeasure.dimension) return null;
  const baseDifference = actualMeasure.baseValue - forecastMeasure.baseValue;
  const displayMeasure = actualMeasure.dimension === "count"
    ? (actualMeasure.unit ? actualMeasure : forecastMeasure)
    : actualMeasure;
  const difference = baseDifference / displayMeasure.scale;
  const suffix = actualMeasure.dimension === "percent" ? "pp" : displayMeasure.unit;
  return {
    baseDifference,
    direction: baseDifference === 0 ? "Matched forecast" : baseDifference > 0 ? "Above forecast" : "Below forecast",
    surprise: `${difference > 0 ? "+" : ""}${conciseNumber(difference)}${suffix}`,
  };
}

function releaseImpact(document, event) {
  const { actual, forecast } = releaseValues(event);
  const comparison = releaseComparison(actual, forecast);
  if (forecast !== undefined && forecast !== null && text(forecast) && !comparison) return "Neutral";
  const impact = text(document?.impact);
  if (["Bullish", "Bearish", "Neutral"].includes(impact)) return impact;
  if (!comparison || comparison.baseDifference === 0) return "Neutral";
  const indicator = eventIndicator(event);
  if (["cpi", "core-cpi", "pce", "core-pce", "ppi", "nonfarm-payrolls", "average-hourly-earnings"].includes(indicator)) {
    return comparison.baseDifference < 0 ? "Bullish" : "Bearish";
  }
  if (["unemployment-rate", "initial-jobless-claims"].includes(indicator)) return comparison.baseDifference > 0 ? "Bullish" : "Bearish";
  return comparison.baseDifference > 0 ? "Bullish" : "Bearish";
}

const PROVIDER_NAMES = Object.freeze({
  binance: "Binance",
  okx: "OKX",
  coinbase: "Coinbase",
  "yahoo finance": "Yahoo Finance",
});

const TASK4_PROVIDER_ALIASES = Object.freeze({
  binance: ["binance"],
  okx: ["okx"],
  "coinbase-exchange": ["coinbase-exchange", "coinbase"],
  "dxy-yahoo-finance": ["dxy-yahoo-finance", "yahoo-finance"],
});

function canonicalProviderName(value) {
  const normalized = text(value).replace(/\s+/g, " ").toLowerCase();
  if (!normalized) return "";
  return PROVIDER_NAMES[normalized]
    ?? normalized.split(" ").map((word) => word.length <= 3 ? word.toUpperCase() : `${word[0].toUpperCase()}${word.slice(1)}`).join(" ");
}

function strictFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value !== value.trim() || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function providerKey(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

function providerAliases(provider) {
  const aliases = unique([
    provider?.id,
    provider?.sourceId,
    provider?.name,
    provider?.label,
    provider?.provider,
  ].map(providerKey));
  const known = aliases.flatMap((alias) => TASK4_PROVIDER_ALIASES[alias] ?? []);
  return unique([...aliases, ...known].map(providerKey));
}

function hasSuccessfulProviderHealth(provider) {
  const status = text(provider?.status).toLowerCase();
  if (status !== "ok" && status !== "degraded") return false;
  if (!text(provider?.lastSuccessAt)) return false;
  try {
    iso(provider?.lastSuccessAt, "Market provider last success");
    return true;
  } catch {
    return false;
  }
}

function trustedProviderLookup(sourceManifest) {
  const byAlias = new Map();
  for (const provider of Array.isArray(sourceManifest) ? sourceManifest : []) {
    if (!provider || typeof provider !== "object") continue;
    const candidate = {
      id: text(provider.id ?? provider.sourceId),
      sourceUrl: absoluteHttpsUrl(provider.url ?? provider.sourceUrl),
      usable: hasSuccessfulProviderHealth(provider),
    };
    for (const alias of providerAliases(provider)) {
      const matches = byAlias.get(alias) ?? [];
      matches.push(candidate);
      byAlias.set(alias, matches);
    }
  }
  return (reference) => {
    const matches = byAlias.get(providerKey(reference)) ?? [];
    if (matches.length > 1) {
      throw new Error(`Data Update reaction provider '${text(reference)}' is ambiguous or duplicated in the source manifest.`);
    }
    const match = matches[0];
    return match ? { ...match, usable: match.usable && Boolean(match.sourceUrl) } : null;
  };
}

function reactionRecords(reaction, sourceManifest) {
  const source = reaction?.prices ?? reaction?.data ?? reaction ?? {};
  const findTrustedProvider = trustedProviderLookup(sourceManifest);
  return REACTION_SYMBOLS.flatMap((symbol) => {
    const record = source?.[symbol];
    const changePercent = strictFiniteNumber(record?.changePercent);
    const providerReference = record?.source ?? record?.provider;
    const providerName = canonicalProviderName(providerReference);
    const directSourceUrl = absoluteHttpsUrl(record?.sourceUrl ?? record?.url);
    const manifestProvider = findTrustedProvider(providerReference);
    const trustedProvider = manifestProvider?.usable ? manifestProvider : null;
    const sourceUrl = manifestProvider && !manifestProvider.usable
      ? ""
      : directSourceUrl || trustedProvider?.sourceUrl;
    const providerId = text(record?.provider) || trustedProvider?.id;
    const suppliedSymbol = text(record?.symbol).toUpperCase();
    if (suppliedSymbol && suppliedSymbol !== symbol) return [];
    const hasBefore = Boolean(text(record?.beforePriceAt));
    const hasObserved = Boolean(text(record?.observedAt));
    let beforePriceAt;
    let observedAt;
    if (hasBefore !== hasObserved) return [];
    if (hasBefore && hasObserved) {
      try {
        beforePriceAt = iso(record.beforePriceAt, "Data Update observation start");
        observedAt = iso(record.observedAt, "Data Update observation end");
        if (beforePriceAt >= observedAt) return [];
      } catch {
        return [];
      }
    }
    return record && changePercent !== null && providerName && sourceUrl
      ? [{
        ...record,
        symbol,
        changePercent,
        ...(providerId ? { provider: providerId } : {}),
        providerName,
        sourceUrl,
        ...(beforePriceAt ? { beforePriceAt, observedAt } : {}),
      }]
      : [];
  });
}

function reactionBounds(reaction, event, document, records) {
  const explicitStart = reaction?.window?.start ?? reaction?.window?.startAt ?? reaction?.start;
  const explicitEnd = reaction?.window?.end ?? reaction?.window?.endAt ?? reaction?.end;
  const starts = records.map((record) => record.beforePriceAt).filter((value) => text(value));
  const ends = records.map((record) => record.observedAt).filter((value) => text(value));
  const releasedAt = iso(event?.releasedAt ?? event?.observedAt, "Data Update release");
  const start = iso(explicitStart ?? (starts.length ? [...starts].sort()[0] : event?.releasedAt ?? event?.observedAt), "Data Update reaction window start");
  const end = iso(explicitEnd ?? (ends.length ? [...ends].sort().at(-1) : document?.generatedAt), "Data Update reaction window end");
  if (new Date(end).getTime() <= new Date(start).getTime()) throw new Error("Data Update reaction window must have a bounded end after start.");
  if (releasedAt < start || releasedAt > end) {
    throw new Error("Data Update reaction window must contain the release timestamp.");
  }
  return { start, end };
}

function recordsInsideBounds(records, bounds) {
  return records.filter((record) => !record.beforePriceAt
    || (record.beforePriceAt >= bounds.start && record.observedAt <= bounds.end));
}

function reactionWindow(bounds, records) {
  const providers = [...new Map(records
    .map((record) => [record.providerName.toLowerCase(), record.providerName])
    .sort(([left], [right]) => compareText(left, right))).values()];
  if (!providers.length) throw new Error("Data Update reaction window requires at least one named market provider.");
  return { ...bounds, providers };
}

function reactionVerdict(impact, records) {
  if (impact === "Neutral" || records.length < 2) return "Awaiting Confirmation";
  const expectedSign = (symbol) => impact === "Bullish" ? (symbol === "DXY" ? -1 : 1) : (symbol === "DXY" ? 1 : -1);
  const aligned = records.filter((record) => Math.sign(record.changePercent) === expectedSign(record.symbol)).length;
  const opposed = records.filter((record) => Math.sign(record.changePercent) === -expectedSign(record.symbol)).length;
  if (aligned >= 2) return "Confirmed";
  if (opposed >= 2) return "Divergent";
  return "Awaiting Confirmation";
}

function normalizedVerdict(document, impact, records) {
  const mapped = {
    CONFIRMED: "Confirmed",
    Confirmed: "Confirmed",
    UNCONFIRMED: "Divergent",
    Divergent: "Divergent",
    MIXED: "Awaiting Confirmation",
    "AWAITING CONFIRMATION": "Awaiting Confirmation",
    "Awaiting Confirmation": "Awaiting Confirmation",
  }[text(document?.tapeStatus)];
  const computed = reactionVerdict(impact, records);
  const verdict = mapped && mapped === computed ? mapped : computed;
  if (!VERDICTS.has(verdict)) throw new Error("Data Update verdict is outside the approved vocabulary.");
  return verdict;
}

function observedReactionSummary(records, window) {
  const moves = records.map(({ symbol, changePercent }) => `${symbol} ${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%`);
  return `Observed from ${window.start} to ${window.end}: ${moves.join(", ")}. This time-bounded observation does not by itself establish causality.`;
}

function releaseSourceCandidates(event, records, manifest) {
  return dedupeSources([
    ...(Array.isArray(manifest) ? manifest : []),
    event?.source,
    ...Object.values(event?.provenance ?? {}),
    ...records.map((record) => ({ id: record.provider ?? record.providerName.toLowerCase(), label: record.providerName, url: record.sourceUrl, type: "market-observation" })),
  ]);
}

function releaseDate(event, document) {
  return canonicalDate(iso(event?.releasedAt ?? event?.observedAt ?? document?.generatedAt, "Data Update release").slice(0, 10));
}

function releaseSlug(event) {
  const hasSuppliedSlug = event && Object.hasOwn(event, "slug");
  const indicator = canonicalReleaseSlug(text(event?.indicator ?? event?.id));
  const jurisdiction = canonicalJurisdiction(event?.jurisdiction ?? event?.country);
  const expected = indicator.startsWith(`${jurisdiction}-`) ? indicator : `${jurisdiction}-${indicator}`;
  if (hasSuppliedSlug) {
    const slug = canonicalReleaseSlug(text(event.slug));
    if (slug !== expected) throw new TypeError("Data Update release slug must match its jurisdiction and indicator identity.");
    return slug;
  }
  return expected;
}

function factsRecord(event) {
  const values = releaseValues(event);
  if (values.actual === undefined || values.actual === null || text(values.actual) === "") throw new Error("Data Update article requires an official actual value.");
  const provenance = event?.provenance ?? {};
  const actualProvenance = provenance.actual ?? (event?.values?.actual && typeof event.values.actual === "object" ? event.values.actual : null);
  if (!actualProvenance) throw new Error("Data Update article requires field provenance for the official actual value.");
  assertFieldProvenanceMatches(actualProvenance, values.actual, "actual");
  const previousProvenance = provenance.previous ?? (event?.values?.previous && typeof event.values.previous === "object" ? event.values.previous : null);
  if (values.previous !== undefined && values.previous !== null && text(values.previous)) {
    assertFieldProvenanceMatches(previousProvenance, values.previous, "previous");
  }
  const facts = {
    title: text(event?.title) || text(event?.indicator) || "Data release",
    jurisdiction: text(event?.jurisdiction ?? event?.country) || "Global",
    releasedAt: iso(event?.releasedAt ?? event?.observedAt, "Data Update facts"),
    actual: values.actual,
    ...(values.previous !== undefined && values.previous !== null && text(values.previous) ? { previous: values.previous } : {}),
    provenance: {
      actual: fieldProvenance(actualProvenance, event?.source),
      ...(values.previous !== undefined && values.previous !== null && text(values.previous)
        ? { previous: fieldProvenance(previousProvenance) }
        : {}),
    },
  };
  if (values.forecast !== undefined && values.forecast !== null && text(values.forecast)) {
    const forecastProvenance = provenance.forecast ?? (event?.values?.forecast && typeof event.values.forecast === "object" ? event.values.forecast : null);
    assertFieldProvenanceMatches(forecastProvenance, values.forecast, "forecast");
    const comparison = releaseComparison(values.actual, values.forecast);
    facts.forecast = values.forecast;
    facts.provenance.forecast = fieldProvenance(forecastProvenance);
    if (comparison) {
      facts.surprise = comparison.surprise;
      facts.surpriseDirection = comparison.direction;
    }
  }
  return facts;
}

function dataSignalSummary(impact, facts) {
  if (facts.forecast === undefined) {
    return `Inference: the verified release is ${impact.toLowerCase()} for risk assets on the available prior context; no consensus comparison claim is made.`;
  }
  if (facts.surprise === undefined) {
    return "Inference: no directional surprise is assigned because the verified actual and forecast units cannot be compared reliably.";
  }
  return `Inference: the release reads ${impact.toLowerCase()} for risk assets after comparing the official actual with the named auxiliary consensus benchmark.`;
}

function dataArticleModel({ document, event, reaction, tierDecision, sourceManifest, requireTierOne }) {
  if (requireTierOne && text(tierDecision?.tier) !== "tier-one") throw new Error("A standalone Data Update article requires a tier-one decision.");
  const facts = factsRecord(event);
  const candidates = reactionRecords(reaction, sourceManifest);
  const bounds = reactionBounds(reaction, event, document, candidates);
  const records = recordsInsideBounds(candidates, bounds);
  const window = reactionWindow(bounds, records);
  const impact = releaseImpact(document, event);
  const verdict = normalizedVerdict(document, impact, records);
  const slug = `${releaseSlug(event)}/${releaseDate(event, document)}`;
  const missingBenchmark = facts.forecast === undefined;
  return {
    id: `data-update:${slug}`,
    type: "data-update-analysis",
    version: MARKET_EDITORIAL_ARTICLE_VERSION,
    slug,
    publishedAt: iso(document?.generatedAt ?? event?.releasedAt, "Data Update article"),
    kicker: "YUBIT ACADEMY / EDITORIAL RESEARCH",
    title: `${facts.title} | Data Update`,
    tierDecision: { ...(tierDecision ?? {}) },
    verdict,
    facts,
    dataSignal: { label: "Editorial Inference", summary: dataSignalSummary(impact, facts), impact },
    marketConfirmation: { label: "Observed Market Confirmation", summary: observedReactionSummary(records, window), observations: records },
    reactionWindow: window,
    scenarioAnalysis: [
      { id: "base", label: "Base case", condition: "The first cross-asset move remains contained around the measured window.", implication: "Treat the release as context until the next liquid session confirms persistence." },
      { id: "strengthening", label: "Strengthening", condition: text(document?.confirmation) || "At least two of BTC, ETH and DXY sustain a direction consistent with the data read.", implication: `The ${impact.toLowerCase()} interpretation gains weight.` },
      { id: "invalidation", label: "Invalidation", condition: text(document?.invalidation) || "The cross-asset move reverses through its pre-release benchmark.", implication: "Downgrade the initial interpretation and reassess concurrent catalysts." },
    ],
    watchNext: [
      "Whether BTC and ETH hold their measured post-release direction through the next liquid session.",
      "Whether DXY confirms or rejects the crypto move.",
      "Whether rates and subsequent official data support the same macro interpretation.",
    ],
    invalidation: text(document?.invalidation) || "The cross-asset move reverses through its pre-release benchmark, invalidating the initial read.",
    sources: releaseSourceCandidates(event, records, sourceManifest),
    limitations: [
      "Observed market movements are time-bounded and do not prove that the release caused the move.",
      ...(missingBenchmark ? ["No sourced consensus benchmark was available; no comparison claim is made."] : []),
      "Provider coverage may be partial; conclusions must remain conditional on the named observations.",
    ],
    disclaimer: DISCLAIMER,
  };
}

export function buildDataUpdateArticle(input = {}) {
  return dataArticleModel({ ...input, requireTierOne: true });
}

function releaseCommunityNodes(article, { includeLink, articleUrl } = {}) {
  const facts = article.facts;
  const changedNodes = [];
  if (facts.forecast !== undefined) {
    changedNodes.push({ type: "metric", label: "Actual vs forecast", value: `${text(facts.actual)} vs ${text(facts.forecast)}` });
  } else {
    changedNodes.push({ type: "metric", label: "Actual", value: text(facts.actual) });
  }
  if (facts.previous !== undefined) {
    changedNodes.push({ type: "metric", label: "Previous", value: text(facts.previous) });
  }
  if (facts.forecast !== undefined && facts.surprise !== undefined) {
    changedNodes.push({ type: "metric", label: "Surprise", value: `${text(facts.surprise)} · ${text(facts.surpriseDirection)}` });
  }
  changedNodes.push({ type: "paragraph", text: `Time-bounded market reaction: ${text(article.marketConfirmation.summary)}` });
  const nodes = [
    { type: "heading", text: `📌 Data Update — ${facts.title} | ${facts.releasedAt.slice(0, 10)}`, level: 1 },
    { type: "paragraph", text: `Core read: ${article.verdict}. ${article.dataSignal.summary}` },
    { type: "heading", text: "What changed", level: 2 },
    ...changedNodes,
    { type: "paragraph", text: `Confirmation: ${article.scenarioAnalysis.find((scenario) => scenario.id === "strengthening")?.condition}` },
    { type: "paragraph", text: `Invalidation: ${article.invalidation}` },
  ];
  if (includeLink) nodes.push({ type: "link", text: "Read the full analysis →", url: articleUrl });
  nodes.push({ type: "paragraph", text: "Market information only — not investment advice." });
  return nodes;
}

export function buildDataUpdateCommunityDocument(article, { articleUrl } = {}) {
  if (text(article?.tierDecision?.tier) !== "tier-one") {
    throw new Error("Data Update community entry requires an explicit tier-one article decision.");
  }
  const url = absoluteHttpsUrl(articleUrl);
  if (!url) throw new TypeError("Data Update community entry requires an absolute HTTPS article link.");
  const nodes = releaseCommunityNodes(article, { includeLink: true, articleUrl: url });
  assertCommunityTextHasNoUrls(nodes);
  return {
    templateId: "data-update-community",
    version: MARKET_EDITORIAL_ARTICLE_VERSION,
    generatedAt: article.publishedAt,
    title: `📌 Data Update — ${article.facts.title}`,
    articleUrl: url,
    nodes: fitTelegramCommunityNodes(nodes),
  };
}

export function buildSecondaryDataUpdateCommunityDocument(input = {}) {
  if (text(input?.tierDecision?.tier) !== "secondary") {
    throw new Error("Secondary Data Update community entry requires an explicit secondary decision.");
  }
  const article = dataArticleModel({ ...input, sourceManifest: [], requireTierOne: false });
  const nodes = releaseCommunityNodes(article, { includeLink: false });
  assertCommunityTextHasNoUrls(nodes);
  return {
    templateId: "data-update-secondary-community",
    version: MARKET_EDITORIAL_ARTICLE_VERSION,
    generatedAt: article.publishedAt,
    title: `📌 Data Update — ${article.facts.title}`,
    nodes: fitTelegramCommunityNodes(nodes),
  };
}
