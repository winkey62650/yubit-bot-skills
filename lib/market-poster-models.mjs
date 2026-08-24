const EDITORIAL_CANVAS = Object.freeze({ width: 1200, height: 675 });
const EDITORIAL_PALETTE = Object.freeze({
  paper: "#EEF5F8",
  ink: "#071C32",
  muted: "#60798C",
  blue: "#0B5C89",
  cyan: "#16B8E7",
  gold: "#F5B83C",
  red: "#D85757",
  green: "#15936E",
});
const EDITORIAL_MASTHEAD = "MARKET INTELLIGENCE / VERIFIED RESEARCH";
const FACT_NUMBER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?|\.\d+)`;
const FACT_UNIT = String.raw`(?:%|bps|bp|pp|trillion|billion|million|[KMBT])`;
const FACT_SCALAR = String.raw`${FACT_NUMBER}(?:[ \t]?${FACT_UNIT})?`;
const FACT_PERCENT_RANGE = String.raw`${FACT_NUMBER}[ \t]?%[ \t]*[-–—][ \t]*${FACT_NUMBER}[ \t]?%`;
const FACT_TOKEN = [
  String.raw`(?:[01]?\d|2[0-3]):[0-5]\d(?:[ \t]+UTC)?`,
  FACT_PERCENT_RANGE,
  String.raw`(?:[+−-][$€£¥]|[$€£¥][+−-]?)[ \t]*${FACT_SCALAR}`,
  String.raw`[+−-]?${FACT_SCALAR}`,
].join("|");
const NUMERICAL_FACT = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?:${FACT_TOKEN})(?![\p{L}\p{N}_])`,
  "giu",
);
const TAPE_VERDICTS = new Set(["CONFIRMED", "DIVERGENT", "AWAITING CONFIRMATION"]);
const WORD_SEGMENTER = new Intl.Segmenter("en", { granularity: "word" });
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u;

function clean(value, fallback = "") {
  return String(value ?? fallback).replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.map((value) => clean(value)).filter(Boolean))];
}

function compareText(left, right) {
  const a = clean(left).normalize("NFC");
  const b = clean(right).normalize("NFC");
  return a.localeCompare(b, "en", { sensitivity: "variant" });
}

function canonicalUnique(values) {
  return unique(values).sort(compareText);
}

function clipped(value, maxLength, fallback = "") {
  const text = clean(value, fallback);
  if (text.length <= maxLength) return text;
  if (maxLength < 1) return "";
  if (maxLength === 1) return "…";
  let prefix = "";
  for (const { segment } of WORD_SEGMENTER.segment(text)) {
    if (prefix.length + segment.length > maxLength - 1) break;
    prefix += segment;
  }
  return `${prefix.trimEnd()}…`;
}

function numericalFacts(value) {
  return unique(clean(value).match(NUMERICAL_FACT) ?? []);
}

function packedFacts(facts, maxLength) {
  if (maxLength < 1 || !facts.length) return "";
  let lane = "";
  for (const fact of facts) {
    const next = lane ? `${lane} · ${fact}` : fact;
    if (next.length + 1 > maxLength) break;
    lane = next;
  }
  return lane ? `${lane}…` : "…";
}

function clippedFactText(value, maxLength, fallback = "") {
  const text = clean(value, fallback);
  const facts = numericalFacts(text);
  if (text.length <= maxLength) return { text, facts };
  if (!facts.length) return { text: clipped(text, maxLength), facts };

  const factLane = facts.join(" · ");
  if (factLane.length > maxLength) {
    return { text: packedFacts(facts, maxLength), facts };
  }
  const prefixLimit = maxLength - factLane.length - 3;
  if (prefixLimit < 1) return { text: factLane, facts };
  const prefix = clipped(text, prefixLimit).replace(/[\s,;:.\-–—]+$/u, "");
  const display = prefix && prefix !== "…" ? `${prefix} · ${factLane}` : factLane;
  return { text: display, facts };
}

function canonicalInstant(value) {
  const input = clean(value);
  const match = input.match(ISO_INSTANT);
  if (!match) return "";
  const [, year, month, day, hour, minute, second, milliseconds = "0"] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const local = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5], Number(milliseconds.padEnd(3, "0"))));
  if (local.getUTCFullYear() !== parts[0]
      || local.getUTCMonth() !== parts[1] - 1
      || local.getUTCDate() !== parts[2]
      || local.getUTCHours() !== parts[3]
      || local.getUTCMinutes() !== parts[4]
      || local.getUTCSeconds() !== parts[5]) return "";
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function sourceDetails(source, fallback = "") {
  const label = clean(typeof source === "string" ? source : source?.label ?? source?.name ?? source?.id, fallback);
  const freshness = clean(typeof source === "object" ? source?.freshness ?? source?.status : "").toLowerCase();
  const stale = freshness === "stale" || freshness === "stale source";
  return {
    label,
    footerLabel: label ? `${label}${stale ? " · STALE SOURCE" : ""}` : "",
    status: label ? (stale ? "STALE SOURCE" : "CURRENT") : "",
  };
}

function sourceLabels(sources) {
  return (Array.isArray(sources) ? sources : [])
    .map((source) => sourceDetails(source).footerLabel)
    .filter(Boolean);
}

function editorialFrame({ sources = [], updatedAt = "", canonicalSourceOrder = false } = {}) {
  return {
    canvas: { ...EDITORIAL_CANVAS },
    palette: { ...EDITORIAL_PALETTE },
    masthead: EDITORIAL_MASTHEAD,
    footer: {
      sources: canonicalSourceOrder ? canonicalUnique(sources) : unique(sources),
      timezone: "UTC",
      updatedAt: canonicalInstant(updatedAt),
    },
  };
}

function compactAmount(value) {
  return String(value)
    .replace(/\$(\d{1,3}),000\b/g, (_, amount) => `$${amount}K`)
    .replace(/\$(\d+(?:\.\d+)?)\s+billion\b/gi, (_, amount) => `$${amount}B`)
    .replace(/\$(\d+(?:\.\d+)?)\s+million\b/gi, (_, amount) => `$${amount}M`);
}

function compactMarketHeadline(value) {
  const original = compactAmount(clean(value).replace(/^Live updates:\s*/i, ""));
  const price = original.match(/\$\d+(?:\.\d+)?[KMB]?\b/i)?.[0];
  const amounts = [...original.matchAll(/\$\d+(?:\.\d+)?[KMB]?\b/gi)].map((match) => match[0]);
  if (/breaks? out|tops?/i.test(original) && /shorts?|liquidat/i.test(original) && price) {
    return clipped(`BTC clears ${price}; ${amounts[1] ?? "leveraged"} shorts liquidated`, 58);
  }
  if (/GENIUS Act/i.test(original) && /stablecoin/i.test(original) && /finaliz/i.test(original)) {
    return "GENIUS Act stablecoin rules near finalization";
  }
  if (/Bitcoin/i.test(original) && /ETFs?\s+(?:draw|record)/i.test(original) && price && amounts[1]) {
    return clipped(`BTC holds above ${price}; ETF inflows reach ${amounts[1]}`, 58);
  }
  return clipped(original.replace(/\bBitcoin\b/gi, "BTC").replace(/\bEthereum\b/gi, "ETH"), 58);
}

function posterCopy(value, { words = 10, chars = 64, fallback = "" } = {}) {
  const normalized = clean(value, fallback)
    .replace(/^HISTORICAL REPLAY\s*[·:—–-]\s*/iu, "")
    .replace(/^DATA FLASH\s*[·:—–-]\s*/iu, "")
    .replace(/\s*[·|]\s*/gu, " ")
    .replace(/\s*[—–]\s*/gu, " ")
    .replace(/…+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  const selected = normalized.split(/\s+/).filter(Boolean).slice(0, words).join(" ");
  if (selected.length <= chars) return selected;
  const prefix = selected.slice(0, chars);
  const boundary = prefix.lastIndexOf(" ");
  return (boundary > 0 ? prefix.slice(0, boundary) : prefix).replace(/[,:;—–-]+$/u, "").trim();
}

function posterSentence(value, { kind = "generic", chars = 64, fallback = "Verified market development." } = {}) {
  const normalized = clean(value, fallback)
    .replace(/^HISTORICAL (?:LAYOUT|RELEASE|CALENDAR) REPLAY\s*[·:—–-]\s*/iu, "")
    .replace(/^HISTORICAL REPLAY\s*[·:—–-]\s*/iu, "")
    .trim();
  if (!normalized) return "";
  const rules = [
    [/inflation.*above.*(?:federal reserve|fed).*target|above.*target.*inflation/iu, "Above-target inflation keeps rates and USD sensitivity high."],
    [/restrictive policy|policy setting.*restrictive/iu, "Restrictive policy limits near-term liquidity easing."],
    [/regulated access|institutional market-structure/iu, "Regulated access improves structure, not today's signal."],
    [/(?:official print|official release).*verified.*(?:does not|doesn't) prove causation/iu, "Official print verified; BTC causation unproven."],
    [/archived.*not a current trading signal|not a current trading signal.*archived/iu, "Archived replay; not a live trading signal."],
  ];
  if (kind === "weekly" && /\bCPI\b|inflation|rates.*USD|USD.*rates/iu.test(normalized)) {
    return "CPI can reprice rates, USD and crypto risk.";
  }
  const matched = rules.find(([pattern]) => pattern.test(normalized));
  if (matched) return matched[1];

  const firstSentence = normalized.match(/^.*?[.!?](?:\s|$)/u)?.[0]?.trim() ?? normalized;
  if (firstSentence.length <= chars) return /[.!?]$/u.test(firstSentence) ? firstSentence : `${firstSentence}.`;
  const firstClause = firstSentence.split(/\s*(?:;|,\s+(?:while|but|because|keeping|which|so)\b)\s*/iu)[0].trim();
  if (firstClause.length <= chars && firstClause.split(/\s+/).length >= 4) {
    return `${firstClause.replace(/[,:;.!?]+$/u, "")}.`;
  }
  const compacted = posterCopy(firstClause, { words: 8, chars: Math.max(1, chars - 1), fallback });
  return `${compacted.replace(/\b(?:and|or|the|a|an|to|for|with|while|but|because|keeping)$/iu, "").replace(/[,:;.!?]+$/u, "").trim()}.`;
}

function weeklyPosterMarkets(event) {
  const supplied = Array.isArray(event?.markets)
    ? event.markets
    : clean(event?.markets ?? event?.affected).split(/\s*[·,/|]\s*/u);
  const normalized = unique(supplied).map((asset) => asset.toUpperCase());
  if (normalized.length) return normalized.slice(0, 3).join(" · ");
  const context = clean([event?.title, event?.whyItMatters, event?.marketSensitivity, event?.scenarioMap].join(" "));
  if (/\bCPI\b|inflation/iu.test(context)) return "BTC · DXY · US2Y";
  if (/federal reserve|\bFED\b|rates?/iu.test(context)) return "BTC · DXY · US2Y";
  if (/\bSEC\b|\bETP\b|\bETF\b/iu.test(context)) return "BTC · ETH";
  return "";
}

function posterSourceLabel(value) {
  const source = clean(value).replace(/\s*·\s*STALE SOURCE$/iu, "");
  if (/bureau of labor statistics|\bBLS\b/iu.test(source)) return "BLS";
  if (/federal reserve|\bFED\b/iu.test(source)) return "FED";
  if (/securities and exchange commission|\bSEC\b/iu.test(source)) return "SEC";
  if (/coinbase/iu.test(source)) return "COINBASE";
  const acronym = source.match(/\b[A-Z][A-Z0-9]{1,7}\b/u)?.[0];
  return acronym || posterCopy(source, { words: 2, chars: 18 });
}

function metric(nodes, label) {
  return (Array.isArray(nodes) ? nodes : []).find((node) => node?.type === "metric" && node?.label === label)?.value ?? null;
}

function dayLabel(date, index) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return `DAY ${index + 1}`;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", day: "2-digit" })
    .formatToParts(parsed);
  return `${parts.find((part) => part.type === "weekday")?.value ?? "DAY"} ${parts.find((part) => part.type === "day")?.value ?? index + 1}`.toUpperCase();
}

function dateAt(weekStart, index) {
  const start = new Date(`${weekStart}T00:00:00.000Z`);
  return Number.isFinite(start.getTime())
    ? new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10)
    : "";
}

function importanceOf(event) {
  const stated = Number(event?.importance);
  if (Number.isFinite(stated)) return stated;
  return metric(event?.nodes, "Importance")?.includes("High") ? 3 : 0;
}

function weeklyEvent(event, dayIndex) {
  const source = sourceDetails(event?.source);
  const description = clippedFactText(event?.whyItMatters ?? event?.description ?? event?.marketSensitivity, 120);
  const sensitivity = clippedFactText(event?.marketSensitivity, 54);
  const scenario = clippedFactText(event?.scenarioMap, 100);
  return {
    dayIndex,
    id: clean(event?.id, `${dayIndex}`),
    title: clipped(event?.title, 48, "Verified event"),
    posterTitle: posterCopy(event?.title, { words: 5, chars: 34, fallback: "Verified event" }),
    time: clean(event?.time),
    importance: importanceOf(event),
    description: description.text,
    descriptionFacts: description.facts,
    sensitivity: sensitivity.text,
    posterSensitivity: posterSentence(event?.marketSensitivity ?? event?.scenarioMap ?? event?.whyItMatters, { kind: "weekly", chars: 58, fallback: "" }),
    sensitivityFacts: sensitivity.facts,
    scenario: scenario.text,
    scenarioFacts: scenario.facts,
    markets: clean(Array.isArray(event?.markets) ? event.markets.join(" · ") : event?.markets ?? event?.affected),
    posterMarkets: weeklyPosterMarkets(event),
    source: source.label.toUpperCase(),
    posterSource: posterSourceLabel(source.footerLabel),
    sourceLabel: source.label,
    sourceFooterLabel: source.footerLabel,
    sourceStatus: source.status,
  };
}

function compareWeeklyEvent(left, right) {
  return left.dayIndex - right.dayIndex
    || compareText(left.time, right.time)
    || compareText(left.id, right.id)
    || compareText(left.title, right.title)
    || compareText(left.sourceLabel, right.sourceLabel)
    || compareText(left.description, right.description)
    || compareText(left.scenario, right.scenario);
}

function weeklyEventKey(event) {
  return [event.dayIndex, event.id, event.time, event.title, event.sourceLabel]
    .map((part) => encodeURIComponent(clean(part).normalize("NFC")))
    .join(":");
}

function keyedWeeklyEvents(events) {
  const seen = new Set();
  return events.slice().sort(compareWeeklyEvent).map((event) => {
    const eventKey = weeklyEventKey(event);
    if (seen.has(eventKey)) {
      throw new TypeError(`Weekly Calendar duplicate poster event identity: ${eventKey}.`);
    }
    seen.add(eventKey);
    return { ...event, eventKey };
  });
}

function priorityMatch(event, requested) {
  const requestedKey = clean(typeof requested === "object" ? requested?.eventKey : "");
  if (requestedKey) return event.eventKey === requestedKey;
  const id = clean(typeof requested === "string" ? requested : requested?.eventId ?? requested?.id);
  return Boolean(id && event.id === id);
}

export function buildWeeklyCalendarPosterModel(document = {}) {
  const suppliedDays = Array.isArray(document.days) ? document.days : [];
  const weekStart = clean(document.weekStart || suppliedDays[0]?.date);
  const sourceDays = Array.from({ length: 7 }, (_, index) => {
    const date = dateAt(weekStart, index) || clean(suppliedDays[index]?.date);
    return suppliedDays.find((day) => clean(day?.date) === date) ?? { date, events: [] };
  });
  const displayEvents = keyedWeeklyEvents(sourceDays.flatMap((day, dayIndex) => {
    const ranked = (Array.isArray(day.events) ? day.events : [])
      .map((event) => weeklyEvent(event, dayIndex))
      .filter((event) => event.importance >= 3)
      .sort((left, right) => right.importance - left.importance || compareWeeklyEvent(left, right));
    return ranked.slice(0, 1);
  }));
  const requestedPriorities = Array.isArray(document.priorityEvents) ? document.priorityEvents : [];
  const rankedEvents = displayEvents
    .slice()
    .sort((left, right) => right.importance - left.importance
      || compareWeeklyEvent(left, right));
  const selectedPriorityKeys = [];
  for (const requested of requestedPriorities) {
    const match = rankedEvents.find((event) => !selectedPriorityKeys.includes(event.eventKey) && priorityMatch(event, requested));
    if (match) selectedPriorityKeys.push(match.eventKey);
    if (selectedPriorityKeys.length === Math.min(3, displayEvents.length)) break;
  }
  for (const event of rankedEvents) {
    if (!selectedPriorityKeys.includes(event.eventKey)) selectedPriorityKeys.push(event.eventKey);
    if (selectedPriorityKeys.length === Math.min(3, displayEvents.length)) break;
  }
  const priorityKeys = new Set(selectedPriorityKeys);
  const priorityEventIds = selectedPriorityKeys.map((key) => displayEvents.find((event) => event.eventKey === key)?.id).filter(Boolean);
  const decorate = (event, date) => ({
    ...event,
    dateLabel: dayLabel(date, event.dayIndex),
    isPriority: priorityKeys.has(event.eventKey),
    visualWeight: priorityKeys.has(event.eventKey) ? "primary" : "secondary",
    accent: event.importance >= 3 ? "amber" : "carbon",
  });
  const columns = sourceDays.map((day, dayIndex) => ({
    date: clean(day.date),
    label: dayLabel(day.date, dayIndex),
    events: displayEvents
      .filter((event) => event.dayIndex === dayIndex)
      .sort(compareWeeklyEvent)
      .map((event) => decorate(event, day.date)),
  }));
  const eventSources = displayEvents.map((event) => event.sourceFooterLabel).filter(Boolean);
  const frame = editorialFrame({
    sources: [...eventSources, ...sourceLabels(document.sources)],
    updatedAt: document.updatedAt ?? document.generatedAt,
    canonicalSourceOrder: true,
  });
  const model = {
    ...frame,
    kind: "weekly-calendar",
    title: clipped(document.title, 64, "WEEKLY MARKET CALENDAR"),
    posterSources: canonicalUnique(frame.footer.sources.map(posterSourceLabel)),
    weekStart,
    columns,
    priorityEventIds,
    priorityEventKeys: selectedPriorityKeys,
    highImpactCount: displayEvents.filter((event) => event.importance >= 3).length,
    peakDay: displayEvents.length ? columns
      .map((column) => ({ label: column.label, score: column.events.reduce((sum, event) => sum + event.importance, 0) }))
      .sort((left, right) => right.score - left.score || compareText(left.label, right.label))[0]?.label ?? "" : "",
  };
  return model;
}

function signedMetric(value) {
  const input = clean(value).replace(/−/gu, "-");
  if (!input) return null;
  const match = input.match(/^(?:[$€£¥]\s*)?([+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+))(?:\s?(?:%|bps|bp|pp))?$/iu);
  if (!match) return null;
  const numeric = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function surpriseLabel(actual, forecast) {
  const actualNumber = signedMetric(actual);
  const forecastNumber = signedMetric(forecast);
  if (actualNumber === null || forecastNumber === null) return null;
  const difference = Math.round((actualNumber - forecastNumber) * 100) / 100;
  const suffix = String(actual).includes("%") && String(forecast).includes("%") ? "pp" : "";
  return `${difference > 0 ? "+" : ""}${difference}${suffix}`;
}

function observationValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return clean(value.value ?? value.rawValue);
  }
  return clean(value);
}

function componentModel(component = {}) {
  const values = component.values ?? {};
  const actual = observationValue(values.actual) || "—";
  const forecast = observationValue(values.forecast) || null;
  return {
    title: clipped(component.title ?? component.indicator, 34, "Release"),
    indicator: clean(component.indicator).replace(/-/g, " ").toUpperCase(),
    actual,
    forecast,
    previous: observationValue(values.previous) || null,
    surprise: forecast ? surpriseLabel(actual, forecast) : null,
  };
}

function reactionModel(reaction) {
  const rawSymbol = clean(reaction?.symbol ?? reaction?.asset).toUpperCase();
  const symbol = rawSymbol.match(/^(BTC|ETH)(?:[-/]?USD(?:T|C)?)$/u)?.[1] ?? rawSymbol;
  const label = clean(reaction?.label ?? reaction?.change ?? reaction?.changePercent ?? reaction?.value);
  const value = signedMetric(reaction?.value ?? reaction?.change ?? reaction?.changePercent ?? label);
  return symbol && label && value !== null ? { symbol, value, label } : null;
}

function marketReactions(input) {
  const nodes = input.nodes ?? input.event?.nodes;
  const nodeReactions = ["BTC", "ETH", "DXY"].flatMap((symbol) => {
    const label = metric(nodes, symbol);
    const value = signedMetric(label);
    return label && value !== null ? [{ symbol, value, label: clean(label) }] : [];
  });
  const supplied = (Array.isArray(input.reactions) ? input.reactions : input.marketConfirmation?.observations ?? [])
    .map(reactionModel)
    .filter(Boolean);
  const bySymbol = new Map([...nodeReactions, ...supplied].map((reaction) => [reaction.symbol, reaction]));
  return ["BTC", "ETH", "DXY"].flatMap((symbol) => bySymbol.has(symbol) ? [bySymbol.get(symbol)] : []);
}

function utcTime(value) {
  return canonicalInstant(value).slice(11, 16);
}

function reactionWindowModel(window = {}) {
  const start = canonicalInstant(window.start);
  const end = canonicalInstant(window.end);
  if (!start || !end || Date.parse(start) > Date.parse(end)) return null;
  const providers = canonicalUnique(window.providers ?? []);
  const startTime = utcTime(start);
  const endTime = utcTime(end);
  return {
    start,
    end,
    label: `${startTime}–${endTime} UTC`,
    providers,
  };
}

function verdictStatus(value) {
  const normalized = clean(value, "AWAITING CONFIRMATION").toUpperCase();
  return TAPE_VERDICTS.has(normalized) ? normalized : "AWAITING CONFIRMATION";
}

export function buildDataUpdatePosterModel(input = {}) {
  const suppliedComponents = input.components ?? input.event?.components;
  const directValues = input.values ?? input.event?.values ?? {};
  const directComponent = {
    title: input.title ?? input.event?.title,
    indicator: input.indicator ?? input.event?.indicator,
    values: directValues,
  };
  const components = (Array.isArray(suppliedComponents) && suppliedComponents.length ? suppliedComponents : [directComponent])
    .map(componentModel);
  const primary = components[0] ?? componentModel(directComponent);
  const forecastSource = clean(input.forecastSource ?? input.event?.forecastSource);
  const official = sourceDetails(input.source ?? input.event?.source);
  const reactionWindow = reactionWindowModel(input.reactionWindow ?? input.event?.reactionWindow);
  const otherSources = unique([
    ...sourceLabels(input.sources),
    ...(Array.isArray(input.reactionSources) ? input.reactionSources : []),
    ...(reactionWindow?.providers ?? []),
  ]);
  const status = verdictStatus(input.verdictStatus ?? input.tapeStatus ?? input.event?.tapeStatus);
  const verdict = clippedFactText(input.verdict, 150);
  const confirmation = clippedFactText(input.confirmation, 120);
  const invalidation = clippedFactText(input.invalidation, 120);
  const posterVerdict = posterSentence(input.verdict, { chars: 62, fallback: "" });
  const posterConfirmation = input.confirmation ? posterSentence(input.confirmation, { chars: 44, fallback: "" }) : "";
  const posterInvalidation = input.invalidation ? posterSentence(input.invalidation, { chars: 44, fallback: "" }) : "";
  const frame = editorialFrame({
    sources: [official.footerLabel, ...otherSources],
    updatedAt: input.updatedAt ?? input.generatedAt ?? input.event?.generatedAt,
    canonicalSourceOrder: true,
  });
  return {
    ...frame,
    kind: "data-update",
    title: clipped(input.title ?? input.event?.title, 72, "DATA UPDATE"),
    posterTitle: posterCopy(input.title ?? input.event?.title, { words: 7, chars: 42, fallback: "Verified release snapshot" }),
    posterSources: canonicalUnique(frame.footer.sources.map(posterSourceLabel)),
    indicator: clean(input.indicator ?? input.event?.indicator ?? primary.indicator).replace(/-/g, " ").toUpperCase(),
    releaseTime: canonicalInstant(input.releaseTime ?? input.releasedAt ?? input.event?.releasedAt ?? input.event?.scheduledAt),
    impact: clean(input.impact, "Neutral"),
    tapeStatus: status,
    verdictStatus: status,
    actual: primary.actual,
    previous: primary.previous,
    revised: clean(directValues.revised) || null,
    forecast: primary.forecast,
    forecastLabel: primary.forecast ? `AUXILIARY FORECAST${forecastSource ? ` · ${forecastSource.toUpperCase()}` : ""}` : null,
    source: official.label.toUpperCase(),
    posterSource: posterSourceLabel(official.footerLabel),
    officialSource: official.label.toUpperCase(),
    surprise: primary.surprise,
    components,
    reactions: marketReactions(input),
    reactionWindow,
    verdict: verdict.text,
    posterVerdict,
    verdictFacts: verdict.facts,
    confirmation: confirmation.text,
    posterConfirmation,
    confirmationFacts: confirmation.facts,
    invalidation: invalidation.text,
    posterInvalidation,
    invalidationFacts: invalidation.facts,
  };
}

export function buildCryptoDailyPosterModel(document = {}) {
  const selected = Array.isArray(document.selectedStories)
    ? document.selectedStories
    : (Array.isArray(document.sections) ? document.sections.map((section) => section.story).filter(Boolean) : []);
  const stories = selected.slice(0, 3).map((story, index) => {
    const source = sourceDetails(story.source);
    const thesis = clippedFactText(story.rationale ?? story.summary, 118, "Verified market development.");
    const confirmation = clippedFactText(story.confirmation, 92, "Await cross-asset confirmation.");
    const invalidation = clippedFactText(story.invalidation, 92, "First move reverses through the pre-event range.");
    const title = compactMarketHeadline(story.title || "Verified market development");
    return {
      rank: String(index + 1).padStart(2, "0"),
      title,
      posterTitle: posterCopy(title, { words: 6, chars: 42, fallback: "Verified market development" }),
      score: Math.round(Number(story?.marketImpact?.score ?? story?.impactScore) || 0),
      impact: clean(story.impact, "Neutral").toUpperCase(),
      source: source.label.toUpperCase(),
      posterSource: posterSourceLabel(source.footerLabel),
      sourceLabel: source.label,
      sourceFooterLabel: source.footerLabel,
      sourceStatus: source.status,
      affected: (Array.isArray(story.affectedAssets) ? story.affectedAssets : story.categories ?? [])
        .map((asset) => clean(asset).toUpperCase()).filter(Boolean).slice(0, 4).join(" · ") || "CRYPTO",
      thesis: thesis.text,
      posterThesis: posterSentence(story.rationale ?? story.summary, { chars: 64, fallback: "Verified market development." }),
      thesisFacts: thesis.facts,
      confirmation: confirmation.text,
      confirmationFacts: confirmation.facts,
      invalidation: invalidation.text,
      invalidationFacts: invalidation.facts,
    };
  });
  const directional = stories.filter((story) => story.impact !== "NEUTRAL");
  const bullish = directional.filter((story) => story.impact === "BULLISH").length;
  const bearish = directional.filter((story) => story.impact === "BEARISH").length;
  const frame = editorialFrame({
      sources: stories.map((story) => story.sourceFooterLabel),
      updatedAt: document.updatedAt ?? document.generatedAt,
    });
  return {
    ...frame,
    kind: "crypto-daily",
    date: clean(document.generatedAt).slice(0, 10),
    title: "MARKET SIGNALS",
    primaryBias: bullish === bearish ? "NEUTRAL" : bullish > bearish ? "BULLISH" : "BEARISH",
    posterSources: unique(frame.footer.sources.map(posterSourceLabel)),
    stories,
  };
}
