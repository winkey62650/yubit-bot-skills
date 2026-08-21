const EDITORIAL_CANVAS = Object.freeze({ width: 1200, height: 675 });
const EDITORIAL_PALETTE = Object.freeze({
  paper: "#E9E5DC",
  ink: "#171717",
  muted: "#6D6A63",
  red: "#A3483F",
  green: "#3F6D57",
});
const EDITORIAL_MASTHEAD = "YUBIT ACADEMY / EDITORIAL RESEARCH";
const NUMERICAL_FACT = /(?:[$€£¥]\s*)?[+-]?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|bps|bp|trillion|billion|million|[KMBT]))?/giu;
const TAPE_VERDICTS = new Set(["CONFIRMED", "DIVERGENT", "AWAITING CONFIRMATION"]);

function clean(value, fallback = "") {
  return String(value ?? fallback).replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.map((value) => clean(value)).filter(Boolean))];
}

function clipped(value, maxLength, fallback = "") {
  const text = clean(value, fallback);
  if (text.length <= maxLength) return text;
  const candidate = text.slice(0, Math.max(1, maxLength - 1));
  const boundary = candidate.lastIndexOf(" ");
  return `${candidate.slice(0, boundary > Math.floor(maxLength * 0.6) ? boundary : candidate.length).trimEnd()}…`;
}

function numericalFacts(value) {
  return unique(clean(value).match(NUMERICAL_FACT) ?? []);
}

function clippedWithFacts(value, maxLength, fallback = "") {
  const text = clean(value, fallback);
  if (text.length <= maxLength) return text;
  const facts = numericalFacts(text);
  if (!facts.length) return clipped(text, maxLength);

  const factLane = facts.join(" · ");
  const suffix = ` · ${factLane}`;
  const prefixLimit = maxLength - suffix.length - 1;
  if (prefixLimit < 1) return factLane;
  const candidate = text.slice(0, prefixLimit);
  const boundary = candidate.lastIndexOf(" ");
  const prefix = candidate
    .slice(0, boundary > Math.floor(prefixLimit * 0.5) ? boundary : candidate.length)
    .replace(/[\s,;:.\-–—]+$/u, "")
    .trimEnd();
  return `${prefix}…${suffix}`;
}

function sourceDetails(source, fallback = "") {
  const label = clean(typeof source === "string" ? source : source?.label ?? source?.name ?? source?.id, fallback);
  const freshness = clean(typeof source === "object" ? source?.freshness ?? source?.status : "").toLowerCase();
  const stale = freshness === "stale" || freshness === "stale source";
  return {
    label,
    footerLabel: label ? `${label}${stale ? " · STALE SOURCE" : ""}` : "",
    status: stale ? "STALE SOURCE" : "CURRENT",
  };
}

function sourceLabels(sources) {
  return (Array.isArray(sources) ? sources : [])
    .map((source) => sourceDetails(source).footerLabel)
    .filter(Boolean);
}

function editorialFrame({ sources = [], updatedAt = "" } = {}) {
  return {
    canvas: { ...EDITORIAL_CANVAS },
    palette: { ...EDITORIAL_PALETTE },
    masthead: EDITORIAL_MASTHEAD,
    footer: {
      sources: unique(sources),
      timezone: "UTC",
      updatedAt: clean(updatedAt),
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

function materialWeekendEvent(event) {
  const tier = clean(event?.impactTier ?? event?.impact).toLowerCase();
  return event?.material === true || importanceOf(event) >= 2 || tier === "tier-one" || tier === "high";
}

function weeklyEvent(event, dayIndex) {
  const source = sourceDetails(event?.source);
  return {
    dayIndex,
    id: clean(event?.id, `${dayIndex}`),
    title: clipped(event?.title, 48, "Verified event"),
    time: clean(event?.time, "TBD"),
    importance: importanceOf(event),
    description: clippedWithFacts(event?.whyItMatters ?? event?.description ?? event?.marketSensitivity, 120),
    sensitivity: clippedWithFacts(event?.marketSensitivity, 54),
    scenario: clippedWithFacts(event?.scenarioMap, 100),
    source: source.label.toUpperCase(),
    sourceLabel: source.label,
    sourceFooterLabel: source.footerLabel,
    sourceStatus: source.status,
  };
}

export function buildWeeklyCalendarPosterModel(document = {}) {
  const suppliedDays = Array.isArray(document.days) ? document.days : [];
  const weekStart = clean(document.weekStart || suppliedDays[0]?.date);
  const sourceDays = Array.from({ length: 7 }, (_, index) => {
    const date = dateAt(weekStart, index) || clean(suppliedDays[index]?.date);
    return suppliedDays.find((day) => clean(day?.date) === date) ?? { date, events: [] };
  });
  const weekdayEvents = sourceDays.slice(0, 5).flatMap((day, dayIndex) =>
    (Array.isArray(day.events) ? day.events : []).map((event) => weeklyEvent(event, dayIndex)));
  const weekendEvents = sourceDays.slice(5).flatMap((day, offset) =>
    (Array.isArray(day.events) ? day.events : [])
      .filter(materialWeekendEvent)
      .map((event) => weeklyEvent(event, offset + 5)));
  const displayEvents = [...weekdayEvents, ...weekendEvents];
  const requestedPriorityIds = (Array.isArray(document.priorityEvents) ? document.priorityEvents : [])
    .map((event) => clean(event?.eventId ?? event?.id))
    .filter(Boolean);
  const rankedIds = displayEvents
    .slice()
    .sort((left, right) => right.importance - left.importance
      || left.dayIndex - right.dayIndex
      || left.time.localeCompare(right.time)
      || left.id.localeCompare(right.id))
    .map((event) => event.id);
  const priorityEventIds = unique([...requestedPriorityIds, ...rankedIds]).slice(0, Math.min(3, displayEvents.length));
  const priorityIds = new Set(priorityEventIds);
  const decorate = (event, date) => ({
    ...event,
    dateLabel: dayLabel(date, event.dayIndex),
    isPriority: priorityIds.has(event.id),
    visualWeight: priorityIds.has(event.id) ? "primary" : "secondary",
    accent: event.importance >= 3 ? "amber" : "carbon",
  });
  const columns = sourceDays.slice(0, 5).map((day, dayIndex) => ({
    date: clean(day.date),
    label: dayLabel(day.date, dayIndex),
    events: weekdayEvents
      .filter((event) => event.dayIndex === dayIndex)
      .sort((left, right) => left.time.localeCompare(right.time) || left.id.localeCompare(right.id))
      .map((event) => decorate(event, day.date)),
  }));
  const weekend = weekendEvents.length ? {
    label: "CRYPTO WEEKEND",
    events: weekendEvents
      .slice()
      .sort((left, right) => left.dayIndex - right.dayIndex || left.time.localeCompare(right.time) || left.id.localeCompare(right.id))
      .map((event) => decorate(event, sourceDays[event.dayIndex]?.date)),
  } : null;
  const eventSources = displayEvents.map((event) => event.sourceFooterLabel).filter(Boolean);
  const frame = editorialFrame({
    sources: [...eventSources, ...sourceLabels(document.sources)],
    updatedAt: document.updatedAt ?? document.generatedAt,
  });
  const model = {
    ...frame,
    kind: "weekly-calendar",
    title: clipped(document.title, 64, "WEEKLY MARKET CALENDAR"),
    weekStart,
    columns,
    priorityEventIds,
    highImpactCount: displayEvents.filter((event) => event.importance >= 3).length,
    peakDay: columns
      .map((column) => ({ label: column.label, score: column.events.reduce((sum, event) => sum + event.importance, 0) }))
      .sort((left, right) => right.score - left.score)[0]?.label ?? "—",
  };
  if (weekend) model.weekend = weekend;
  return model;
}

function signedMetric(value) {
  const numeric = Number(String(value ?? "").replace(/[^\d+.-]/g, ""));
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

function componentModel(component = {}) {
  const values = component.values ?? {};
  const actual = clean(values.actual, "—");
  const forecast = clean(values.forecast) || null;
  return {
    title: clipped(component.title ?? component.indicator, 34, "Release"),
    indicator: clean(component.indicator).replace(/-/g, " ").toUpperCase(),
    actual,
    forecast,
    previous: clean(values.previous) || null,
    surprise: forecast ? surpriseLabel(actual, forecast) : null,
  };
}

function reactionModel(reaction) {
  const symbol = clean(reaction?.symbol ?? reaction?.asset).toUpperCase();
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
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(11, 16) : "";
}

function reactionWindowModel(window = {}) {
  const start = clean(window.start);
  const end = clean(window.end);
  const providers = unique(window.providers ?? []);
  const startTime = utcTime(start);
  const endTime = utcTime(end);
  if (!start && !end && !providers.length && !clean(window.label)) return null;
  return {
    start,
    end,
    label: startTime && endTime ? `${startTime}–${endTime} UTC` : clean(window.label),
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
  const official = sourceDetails(input.source ?? input.event?.source, "OFFICIAL RELEASE");
  const reactionWindow = reactionWindowModel(input.reactionWindow ?? input.event?.reactionWindow);
  const otherSources = unique([
    ...sourceLabels(input.sources),
    ...(Array.isArray(input.reactionSources) ? input.reactionSources : []),
    ...(reactionWindow?.providers ?? []),
  ]);
  const status = verdictStatus(input.verdictStatus ?? input.tapeStatus ?? input.event?.tapeStatus);
  return {
    ...editorialFrame({
      sources: [official.footerLabel, ...otherSources],
      updatedAt: input.updatedAt ?? input.generatedAt ?? input.event?.generatedAt,
    }),
    kind: "data-update",
    title: clipped(input.title ?? input.event?.title, 72, "DATA UPDATE"),
    indicator: clean(input.indicator ?? input.event?.indicator ?? primary.indicator).replace(/-/g, " ").toUpperCase(),
    impact: clean(input.impact, "Neutral"),
    tapeStatus: status,
    verdictStatus: status,
    actual: primary.actual,
    previous: primary.previous,
    revised: clean(directValues.revised) || null,
    forecast: primary.forecast,
    forecastLabel: primary.forecast ? `AUXILIARY FORECAST${forecastSource ? ` · ${forecastSource.toUpperCase()}` : ""}` : null,
    source: official.label.toUpperCase(),
    officialSource: official.label.toUpperCase(),
    surprise: primary.surprise,
    components,
    reactions: marketReactions(input),
    reactionWindow,
    verdict: clippedWithFacts(input.verdict, 150),
    confirmation: clippedWithFacts(input.confirmation, 120),
    invalidation: clippedWithFacts(input.invalidation, 120),
  };
}

export function buildCryptoDailyPosterModel(document = {}) {
  const selected = Array.isArray(document.selectedStories)
    ? document.selectedStories
    : (Array.isArray(document.sections) ? document.sections.map((section) => section.story).filter(Boolean) : []);
  const stories = selected.slice(0, 3).map((story, index) => {
    const source = sourceDetails(story.source, "VERIFIED");
    return {
      rank: String(index + 1).padStart(2, "0"),
      title: compactMarketHeadline(story.title || "Verified market development"),
      score: Math.round(Number(story?.marketImpact?.score ?? story?.impactScore) || 0),
      impact: clean(story.impact, "Neutral").toUpperCase(),
      source: source.label.toUpperCase(),
      sourceLabel: source.label,
      sourceFooterLabel: source.footerLabel,
      affected: (Array.isArray(story.affectedAssets) ? story.affectedAssets : story.categories ?? [])
        .map((asset) => clean(asset).toUpperCase()).filter(Boolean).slice(0, 4).join(" · ") || "CRYPTO",
      thesis: clippedWithFacts(story.rationale ?? story.summary, 118, "Verified market development."),
      confirmation: clippedWithFacts(story.confirmation, 92, "Await cross-asset confirmation."),
      invalidation: clippedWithFacts(story.invalidation, 92, "First move reverses through the pre-event range."),
    };
  });
  const directional = stories.filter((story) => story.impact !== "NEUTRAL");
  const bullish = directional.filter((story) => story.impact === "BULLISH").length;
  const bearish = directional.filter((story) => story.impact === "BEARISH").length;
  return {
    ...editorialFrame({
      sources: stories.map((story) => story.sourceFooterLabel),
      updatedAt: document.updatedAt ?? document.generatedAt,
    }),
    kind: "crypto-daily",
    date: clean(document.generatedAt).slice(0, 10),
    title: "MARKET SIGNALS",
    primaryBias: bullish === bearish ? "NEUTRAL" : bullish > bearish ? "BULLISH" : "BEARISH",
    stories,
  };
}
