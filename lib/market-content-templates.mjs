export const MARKET_CONTENT_TEMPLATE_VERSION = "market-content-v1";

export const CRYPTO_DAILY_SECTIONS = Object.freeze([
  "btc-etf-institutional",
  "regulation",
  "market-project",
]);

export const RELEASE_INDICATOR_ALLOWLIST = Object.freeze([
  "cpi",
  "core-cpi",
  "pce",
  "core-pce",
  "nonfarm-payrolls",
  "unemployment-rate",
  "average-hourly-earnings",
  "fomc-rate-decision",
  "fomc-statement",
  "gdp",
  "ppi",
  "retail-sales",
  "initial-jobless-claims",
]);

const SECTION_DETAILS = Object.freeze({
  "btc-etf-institutional": { title: "BTC ETF / Institutional", marker: "1\ufe0f\u20e3" },
  regulation: { title: "Regulation", marker: "2\ufe0f\u20e3" },
  "market-project": { title: "Market / Project", marker: "3\ufe0f\u20e3" },
});

const EMPTY_DAILY_SECTION = "No material verified update in the last 24 hours.";
const IMPACTS = new Set(["Bullish", "Neutral", "Bearish"]);
const IMPACT_DISPLAY = Object.freeze({ Bullish: "\ud83d\udfe2 Bullish", Neutral: "\ud83d\udfe1 Neutral", Bearish: "\ud83d\udd34 Bearish" });
const INFLATION_INDICATORS = new Set(["cpi", "core-cpi", "pce", "core-pce", "ppi"]);
const EMPLOYMENT_INDICATORS = new Set(["nonfarm-payrolls", "unemployment-rate", "average-hourly-earnings", "initial-jobless-claims"]);
const GROWTH_INDICATORS = new Set(["gdp", "retail-sales"]);
const NODE_TYPES = new Set(["heading", "paragraph", "link", "metric", "divider"]);

function text(value) {
  return String(value ?? "").trim();
}

function validDate(value) {
  if (value === null || value === undefined || text(value) === "") return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function timedDate(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  return validDate(value);
}

function isoNow(value) {
  return (validDate(value) ?? new Date()).toISOString();
}

function slug(value) {
  return text(value).toLowerCase().replaceAll("_", "-").replace(/\s+/g, "-");
}

function storyCorpus(story) {
  return [story?.title, story?.summary, ...(Array.isArray(story?.categories) ? story.categories : [])]
    .map(text)
    .join(" ")
    .toLowerCase();
}

export function classifyCryptoStory(story) {
  const categories = (Array.isArray(story?.categories) ? story.categories : []).map(slug);
  if (categories.includes("btc-etf-institutional")) return "btc-etf-institutional";
  if (categories.includes("regulation")) return "regulation";
  if (categories.includes("market-project")) return "market-project";
  const corpus = storyCorpus(story);
  if (!corpus) return null;
  if (/\b(?:bitcoin|btc)\b[\s\S]*\betf\b|\betf\b[\s\S]*\b(?:bitcoin|btc)\b|\binstitution(?:al|s)?\b|\bblackrock\b|\bfidelity\b/.test(corpus)) {
    return "btc-etf-institutional";
  }
  if (/\b(?:regulat(?:ion|or|ory)|sec|cftc|enforcement|lawsuit|court|legislation|compliance|license|ban)\b/.test(corpus)) {
    return "regulation";
  }
  if (/\b(?:bitcoin|btc|ethereum|eth|crypto|blockchain|defi|stablecoin|token|protocol|network|mainnet|exchange|project|upgrade|hack|exploit)\b/.test(corpus)) {
    return "market-project";
  }
  return null;
}

function officialStory(story) {
  const kind = slug(story?.source?.kind ?? story?.sourceKind);
  const sourceId = slug(story?.source?.id ?? story?.sourceId);
  if (["official", "regulator", "government", "project-official"].includes(kind)) return true;
  if (/^(?:sec|cftc|bls|bea|federal-reserve|fed)$/.test(sourceId)) return true;
  try {
    const host = new URL(text(story?.url)).hostname.toLowerCase();
    return host.endsWith(".gov") || host === "sec.gov" || host === "federalreserve.gov";
  } catch {
    return false;
  }
}

function normalizedStoryTitle(value) {
  return text(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b(?:breaking|exclusive|update)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function storyKey(story) {
  const explicit = text(story?.canonicalId ?? story?.eventId ?? story?.canonicalUrl);
  return explicit ? `id:${explicit.toLowerCase()}` : `title:${normalizedStoryTitle(story?.title)}`;
}

const STORY_EVENT_PATTERNS = Object.freeze([
  ["net-inflow", /\b(?:net\s+)?inflows?\b/],
  ["net-outflow", /\b(?:net\s+)?outflows?\b/],
  ["approval", /\bapprov(?:al|e|ed|es)\b/],
  ["rejection", /\b(?:reject(?:ion|ed|s)?|den(?:y|ial|ied))\b/],
  ["enforcement", /\benforcement\b/],
  ["lawsuit", /\b(?:lawsuit|sued|litigation)\b/],
  ["filing", /\bfil(?:ing|ed|es)\b/],
  ["guidance", /\bguidance\b/],
  ["launch", /\blaunch(?:ed|es)?\b/],
  ["upgrade", /\bupgrad(?:e|ed|es)\b/],
  ["security-incident", /\b(?:hack(?:ed)?|exploit(?:ed)?|breach(?:ed)?)\b/],
]);

const STORY_ENTITY_STOPWORDS = new Set([
  "after", "against", "august", "bitcoin", "challenges", "crypto", "daily", "day", "dollar", "dollars",
  "draws", "ethereum", "flow", "flows", "for", "from", "fund", "funds", "into", "million", "net",
  "publishes", "recorded", "records", "regulator", "report", "reports", "saw", "spot", "the", "their",
  "trust", "update", "verified", "with", "year",
]);

function storyFact(story) {
  const corpus = `${text(story?.title)} ${text(story?.summary)}`.normalize("NFKC").toLowerCase();
  const events = new Set(STORY_EVENT_PATTERNS.filter(([, pattern]) => pattern.test(corpus)).map(([event]) => event));
  const numbers = [...corpus.matchAll(/(?:\$\s*)?\b(\d+(?:\.\d+)?)\s*(billion|million|thousand|[kmb]|%)?\b/g)]
    .map((match) => `${Number(match[1])}${({ billion: "b", million: "m", thousand: "k" })[match[2]] ?? match[2] ?? ""}`);
  const entities = normalizedStoryTitle(corpus).split(" ").filter((token) => (
    token.length >= 3
    && !/^\d/.test(token)
    && !STORY_ENTITY_STOPWORDS.has(token)
    && !STORY_EVENT_PATTERNS.some(([, pattern]) => pattern.test(token))
  ));
  return { events, numbers: [...new Set(numbers)].sort(), entities: new Set(entities) };
}

function sameStoryFact(left, right) {
  if (storyKey(left) === storyKey(right)) return true;
  const leftFact = storyFact(left);
  const rightFact = storyFact(right);
  const sharedEvents = [...leftFact.events].filter((event) => rightFact.events.has(event));
  if (!sharedEvents.length) return false;
  if (leftFact.numbers.length || rightFact.numbers.length) {
    if (leftFact.numbers.join("\u0000") !== rightFact.numbers.join("\u0000")) return false;
  }
  const sharedEntities = [...leftFact.entities].filter((entity) => rightFact.entities.has(entity));
  const unionSize = new Set([...leftFact.entities, ...rightFact.entities]).size;
  const leftCoverage = sharedEntities.length / leftFact.entities.size;
  const rightCoverage = sharedEntities.length / rightFact.entities.size;
  const jaccard = sharedEntities.length / unionSize;
  return sharedEntities.length >= 2
    && jaccard >= 0.5
    && leftCoverage >= 2 / 3
    && rightCoverage >= 2 / 3;
}

function preferredDuplicate(left, right) {
  const leftOfficial = officialStory(left);
  const rightOfficial = officialStory(right);
  if (leftOfficial !== rightOfficial) return rightOfficial ? right : left;
  const leftTime = Date.parse(left?.publishedAt);
  const rightTime = Date.parse(right?.publishedAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime > leftTime ? right : left;
  const leftStable = `${text(left?.url)}\u0000${text(left?.id)}`;
  const rightStable = `${text(right?.url)}\u0000${text(right?.id)}`;
  return rightStable.localeCompare(leftStable, "en") < 0 ? right : left;
}

export function deduplicateCryptoStories(stories) {
  const groups = [];
  const candidates = (Array.isArray(stories) ? stories : [])
    .filter((candidate) => candidate && text(candidate.title))
    .sort((left, right) => stableStoryId(left).localeCompare(stableStoryId(right), "en"));
  for (const candidate of candidates) {
    const index = groups.findIndex((existing) => sameStoryFact(existing, candidate));
    const existing = groups[index];
    if (!existing) {
      groups.push({ ...candidate, sourceConfirmations: Math.max(1, Number(candidate.sourceConfirmations) || 1) });
      continue;
    }
    const selected = preferredDuplicate(existing, candidate);
    const alternate = selected === existing ? candidate : existing;
    groups[index] = {
      ...alternate,
      ...selected,
      sourceConfirmations: Math.max(
        Number(existing.sourceConfirmations) || 1,
        Number(candidate.sourceConfirmations) || 1,
        2,
      ),
    };
  }
  return groups.sort((left, right) => storyKey(left).localeCompare(storyKey(right), "en"));
}

function sourceRank(story) {
  if (officialStory(story)) return 2;
  return text(story?.url) && text(story?.source?.label ?? story?.source?.id) ? 1 : 0;
}

function stableStoryId(story) {
  return `${normalizedStoryTitle(story?.title)}\u0000${text(story?.url)}\u0000${text(story?.id)}`;
}

export function rankCryptoStories(stories, now) {
  const nowMs = (validDate(now) ?? new Date()).getTime();
  return [...(Array.isArray(stories) ? stories : [])].sort((left, right) => {
    const sourceDifference = sourceRank(right) - sourceRank(left);
    if (sourceDifference) return sourceDifference;
    const importanceDifference = (Number(right?.importance) || 0) - (Number(left?.importance) || 0);
    if (importanceDifference) return importanceDifference;
    const impactDifference = (Number(right?.impactScore ?? right?.eventImpact) || 0) - (Number(left?.impactScore ?? left?.eventImpact) || 0);
    if (impactDifference) return impactDifference;
    const confirmationsDifference = (Number(right?.sourceConfirmations) || 1) - (Number(left?.sourceConfirmations) || 1);
    if (confirmationsDifference) return confirmationsDifference;
    const leftTime = Date.parse(left?.publishedAt);
    const rightTime = Date.parse(right?.publishedAt);
    const leftFreshness = Number.isFinite(leftTime) ? Math.abs(nowMs - leftTime) : Number.POSITIVE_INFINITY;
    const rightFreshness = Number.isFinite(rightTime) ? Math.abs(nowMs - rightTime) : Number.POSITIVE_INFINITY;
    if (leftFreshness !== rightFreshness) return leftFreshness - rightFreshness;
    return stableStoryId(left).localeCompare(stableStoryId(right), "en");
  });
}

function safeImpact(value) {
  const normalized = text(value).toLowerCase();
  if (normalized === "bullish") return "Bullish";
  if (normalized === "bearish") return "Bearish";
  return "Neutral";
}

function inferredStoryImpact(story) {
  const supplied = safeImpact(story?.impact);
  if (supplied !== "Neutral" || text(story?.impact).toLowerCase() === "neutral") return supplied;
  const evidence = `${text(story?.title)} ${text(story?.summary)}`.toLowerCase();
  if (/\b(?:net inflow|approved|approval|adoption|launch(?:ed)? successfully)\b/.test(evidence)) return "Bullish";
  if (/\b(?:net outflow|hack(?:ed)?|exploit(?:ed)?|ban(?:ned)?|enforcement action|shutdown)\b/.test(evidence)) return "Bearish";
  return "Neutral";
}

function formatMonthDay(value) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(value);
}

function traceableStory(story) {
  if (!text(story?.url) || !text(story?.source?.label ?? story?.source?.id)) return false;
  try {
    return ["http:", "https:"].includes(new URL(story.url).protocol);
  } catch {
    return false;
  }
}

function cryptoSection(id, selected) {
  const details = SECTION_DETAILS[id];
  const heading = { type: "heading", text: `${details.marker} ${details.title}`, level: 2 };
  if (!selected) {
    return {
      id,
      title: details.title,
      impact: "Neutral",
      nodes: [heading, { type: "paragraph", text: EMPTY_DAILY_SECTION }, { type: "metric", label: "Market Impact", value: IMPACT_DISPLAY.Neutral }],
    };
  }
  const impact = inferredStoryImpact(selected);
  const rationale = text(selected.rationale) || text(selected.summary) || "Available evidence does not establish a directional market impact.";
  return {
    id,
    title: details.title,
    impact,
    storyId: text(selected.id) || storyKey(selected),
    nodes: [
      heading,
      { type: "paragraph", text: text(selected.title) },
      { type: "metric", label: "Market Impact", value: IMPACT_DISPLAY[impact] },
      { type: "paragraph", text: rationale },
      { type: "link", text: `Source: ${text(selected.source?.label ?? selected.source?.id)}`, url: text(selected.url) },
    ],
  };
}

export function buildCryptoDailyDocument({ now, candidates } = {}) {
  const generated = validDate(now) ?? new Date();
  const ranked = rankCryptoStories(deduplicateCryptoStories(candidates), generated);
  const windowStart = generated.getTime() - 24 * 60 * 60 * 1000;
  const eligible = ranked.filter((candidate) => {
    if (!traceableStory(candidate)) return false;
    const publishedAt = Date.parse(candidate?.publishedAt);
    return Number.isFinite(publishedAt) && publishedAt >= windowStart && publishedAt <= generated.getTime();
  });
  const sections = CRYPTO_DAILY_SECTIONS.map((id) => cryptoSection(id, eligible.find((story) => classifyCryptoStory(story) === id)));
  return {
    templateId: "crypto-daily",
    version: MARKET_CONTENT_TEMPLATE_VERSION,
    generatedAt: generated.toISOString(),
    title: `\ud83d\udcf0 Crypto Daily \u2014 ${formatMonthDay(generated)}`,
    nodes: [{ type: "heading", text: `\ud83d\udcf0 Crypto Daily \u2014 ${formatMonthDay(generated)}`, level: 1 }],
    sections,
  };
}

function utcWeek(now) {
  const current = validDate(now) ?? new Date();
  const day = current.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + mondayOffset));
  const endExclusive = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  const end = new Date(endExclusive.getTime() - 1);
  return { start, end, endExclusive };
}

function dateOnly(value) {
  const raw = text(value);
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/);
  return match?.[1] ?? "";
}

function eventDate(event) {
  const scheduled = timedDate(event?.scheduledAt);
  if (scheduled) return scheduled.toISOString().slice(0, 10);
  return dateOnly(event?.scheduledAt) || dateOnly(event?.rawScheduledAt ?? event?.date);
}

function normalizedIndicator(event) {
  const direct = slug(event?.indicator ?? event?.indicatorId ?? event?.slug);
  if (RELEASE_INDICATOR_ALLOWLIST.includes(direct)) return direct;
  const titleValue = text(event?.title).toLowerCase();
  const rules = [
    ["core-cpi", /\bcore cpi\b/], ["cpi", /\bcpi\b/], ["core-pce", /\bcore pce\b/], ["pce", /\bpce\b/],
    ["nonfarm-payrolls", /\b(?:nonfarm payrolls?|nfp)\b/], ["unemployment-rate", /\bunemployment rate\b/],
    ["average-hourly-earnings", /\baverage hourly earnings\b/], ["fomc-rate-decision", /\b(?:fomc|fed)\b.*\b(?:rate|decision)\b/],
    ["fomc-statement", /\bfomc\b.*\b(?:statement|minutes)\b/], ["gdp", /\bgdp\b/], ["ppi", /\bppi\b/],
    ["retail-sales", /\bretail sales\b/], ["initial-jobless-claims", /\b(?:initial )?jobless claims\b/],
  ];
  return rules.find(([, pattern]) => pattern.test(titleValue))?.[0] ?? null;
}

function importantCalendarEvent(event) {
  if (slug(event?.kind ?? event?.type) === "crypto") {
    return officialStory(event) && Boolean(timedDate(event?.scheduledAt)) && Number(event?.importance) >= 2;
  }
  if (Number(event?.importance) >= 3 || normalizedIndicator(event)) return true;
  return false;
}

function presentValue(value) {
  return value !== null && value !== undefined && text(value) && !/^(?:null|undefined|tbd|n\/?a|--?)$/i.test(text(value));
}

function calendarEventRecord(event) {
  const scheduled = timedDate(event?.scheduledAt);
  const values = event?.values ?? {};
  const titleValue = text(event?.title) || "Verified event";
  const nodes = [
    { type: "heading", text: `${scheduled ? scheduled.toISOString().slice(11, 16) : "TBD"} \u2014 ${titleValue}`, level: 3 },
  ];
  if (presentValue(event?.importance)) nodes.push({ type: "metric", label: "Importance", value: Number(event.importance) >= 3 ? "\ud83d\udd34 High" : text(event.importance) });
  for (const [label, key] of [["Actual", "actual"], ["Forecast", "forecast"], ["Previous", "previous"]]) {
    if (presentValue(values[key])) nodes.push({ type: "metric", label, value: text(values[key]) });
  }
  const sourceLabel = text(event?.source?.label ?? event?.sourceLabel ?? event?.source);
  const sourceUrl = text(event?.source?.url ?? event?.sourceUrl ?? event?.url);
  if (sourceLabel && sourceUrl) nodes.push({ type: "link", text: `Source: ${sourceLabel}`, url: sourceUrl });
  else if (sourceLabel) nodes.push({ type: "paragraph", text: `Source: ${sourceLabel}` });
  return {
    id: text(event?.id ?? event?.sourceId) || `${eventDate(event)}:${titleValue}`,
    title: titleValue,
    time: scheduled ? scheduled.toISOString().slice(11, 16) : "TBD",
    nodes,
  };
}

export function buildWeeklyCalendarDocument({ now, events } = {}) {
  const { start, end, endExclusive } = utcWeek(now);
  const startLabel = start.toISOString().slice(0, 10);
  const endLabel = end.toISOString().slice(0, 10);
  const unique = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const date = eventDate(event);
    if (!date || date < startLabel || date >= endExclusive.toISOString().slice(0, 10) || !importantCalendarEvent(event)) continue;
    const scheduled = timedDate(event?.scheduledAt);
    const key = `${date}\u0000${scheduled?.toISOString() ?? "TBD"}\u0000${text(event?.country ?? event?.asset)}\u0000${text(event?.title).toLowerCase()}`;
    if (!unique.has(key)) unique.set(key, event);
  }
  const grouped = new Map();
  for (const [key, event] of [...unique.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    const date = key.split("\u0000", 1)[0];
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date).push(calendarEventRecord(event));
  }
  const days = [...grouped.entries()].map(([date, dayEvents]) => {
    const dateValue = new Date(`${date}T00:00:00.000Z`);
    const heading = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(dateValue).toUpperCase().replace(",", " \u00b7");
    return { date, nodes: [{ type: "heading", text: heading, level: 2 }], events: dayEvents };
  });
  const range = `${formatMonthDay(start)}\u2013${end.getUTCMonth() === start.getUTCMonth() ? end.getUTCDate() : formatMonthDay(end)}`;
  const title = `\ud83d\udcc5 Crypto & Macro Calendar \u2014 ${range}`;
  return {
    templateId: "weekly-calendar",
    version: MARKET_CONTENT_TEMPLATE_VERSION,
    generatedAt: isoNow(now),
    weekStart: startLabel,
    weekEnd: endLabel,
    title,
    nodes: [{ type: "heading", text: title, level: 1 }, { type: "paragraph", text: "All times UTC" }],
    days,
  };
}

function numericValue(value) {
  const raw = text(value).replaceAll(",", "");
  const match = raw.match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return null;
  const suffix = raw.slice(match.index + match[0].length).trim().toUpperCase();
  const multiplier = suffix.startsWith("K") ? 1_000 : suffix.startsWith("M") ? 1_000_000 : suffix.startsWith("B") ? 1_000_000_000 : 1;
  const valueNumber = Number(match[0]) * multiplier;
  return Number.isFinite(valueNumber) ? valueNumber : null;
}

function directionalSignal(release) {
  const indicator = normalizedIndicator(release);
  if (!indicator || !RELEASE_INDICATOR_ALLOWLIST.includes(indicator)) return null;
  if (indicator === "fomc-statement") {
    const tone = text(release?.statementTone ?? release?.tone).toLowerCase();
    if (tone === "dovish") return 1;
    if (tone === "hawkish") return -1;
    return null;
  }
  const actual = numericValue(release?.values?.actual ?? release?.actual);
  const forecast = numericValue(release?.values?.forecast ?? release?.forecast);
  if (actual === null || forecast === null || actual === forecast) return actual === forecast && actual !== null ? 0 : null;
  if (INFLATION_INDICATORS.has(indicator) || indicator === "nonfarm-payrolls" || indicator === "average-hourly-earnings") {
    return actual < forecast ? 1 : -1;
  }
  if (indicator === "unemployment-rate" || indicator === "initial-jobless-claims") return actual > forecast ? 1 : -1;
  if (GROWTH_INDICATORS.has(indicator)) return actual > forecast ? 1 : -1;
  if (indicator === "fomc-rate-decision") return actual < forecast ? 1 : -1;
  return null;
}

function impactExplanation(indicator, impact) {
  if (impact === "Neutral") return "Available verified evidence does not establish a clear directional impact for risk assets.";
  if (INFLATION_INDICATORS.has(indicator)) return impact === "Bullish"
    ? "Inflation came in below expectations, easing marginal pressure on the expected policy path."
    : "Inflation came in above expectations, increasing marginal pressure on the expected policy path.";
  if (EMPLOYMENT_INDICATORS.has(indicator)) return impact === "Bullish"
    ? "The employment reading was cooler than expected, easing marginal rate-pressure expectations."
    : "The employment reading was hotter than expected, increasing marginal rate-pressure expectations.";
  if (GROWTH_INDICATORS.has(indicator)) return impact === "Bullish"
    ? "Growth exceeded expectations, supporting the near-term demand outlook."
    : "Growth missed expectations, weakening the near-term demand outlook.";
  if (indicator?.startsWith("fomc")) return impact === "Bullish"
    ? "The verified FOMC outcome was more dovish than the available expectation benchmark."
    : "The verified FOMC outcome was more hawkish than the available expectation benchmark.";
  return "Available verified evidence does not establish a clear directional impact for risk assets.";
}

export function evaluateReleaseImpact(release) {
  const components = Array.isArray(release?.components) && release.components.length ? release.components : [release];
  const signals = components.map(directionalSignal);
  const impact = signals.includes(null) || signals.includes(0) || new Set(signals).size > 1
    ? "Neutral"
    : signals[0] > 0 ? "Bullish" : "Bearish";
  const indicator = normalizedIndicator(release) ?? normalizedIndicator(components[0]);
  return { impact, explanation: impactExplanation(indicator, impact) };
}

function releaseRecords(event) {
  const candidates = Array.isArray(event?.components) && event.components.length ? event.components : [event];
  return candidates.map((release) => ({ ...release, indicator: normalizedIndicator(release) })).filter((release) => release.indicator);
}

function reactionEntries(reaction) {
  const source = reaction?.prices ?? reaction?.data ?? reaction ?? {};
  return ["BTC", "ETH", "DXY"].flatMap((symbol) => {
    const record = source[symbol];
    if (!record || !presentValue(record.changePercent)) return [];
    const number = Number(record.changePercent);
    const formatted = Number.isFinite(number) ? `${number >= 0 ? "+" : ""}${number}%` : text(record.changePercent);
    return [{ type: "metric", label: symbol, value: formatted }];
  });
}

export function buildDataReleaseDocument({ event, reaction } = {}) {
  const records = releaseRecords(event);
  if (!records.length || records.some((release) => !RELEASE_INDICATOR_ALLOWLIST.includes(release.indicator))) {
    throw new Error("Data release indicator is not in the release allowlist.");
  }
  const impact = evaluateReleaseImpact(event);
  const eventTitle = text(event?.title) || text(records[0]?.title) || records[0].indicator;
  const title = `\ud83d\udea8 ${eventTitle} Released`;
  const nodes = [{ type: "heading", text: title, level: 1 }];
  for (const release of records) {
    nodes.push({ type: "heading", text: text(release.title) || release.indicator, level: 2 });
    const values = release.values ?? {};
    for (const [label, key] of [["Actual", "actual"], ["Forecast", "forecast"], ["Previous", "previous"]]) {
      if (presentValue(values[key] ?? release[key])) nodes.push({ type: "metric", label, value: text(values[key] ?? release[key]) });
    }
  }
  nodes.push({ type: "divider" });
  nodes.push({ type: "metric", label: "\ud83d\udcca Market Impact", value: `${IMPACT_DISPLAY[impact.impact]} for Risk Assets` });
  nodes.push({ type: "paragraph", text: impact.explanation });
  nodes.push(...reactionEntries(reaction));
  const sourceLabel = text(event?.source?.label ?? event?.sourceLabel ?? event?.source);
  const sourceUrl = text(event?.source?.url ?? event?.sourceUrl ?? event?.url);
  if (sourceLabel && sourceUrl) nodes.push({ type: "link", text: `Source: ${sourceLabel}`, url: sourceUrl });
  else if (sourceLabel) nodes.push({ type: "paragraph", text: `Source: ${sourceLabel}` });
  return {
    templateId: "data-release",
    version: MARKET_CONTENT_TEMPLATE_VERSION,
    generatedAt: isoNow(event?.observedAt ?? event?.releasedAt ?? new Date()),
    title,
    impact: impact.impact,
    nodes,
  };
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function markdownEscape(value) {
  return String(value ?? "").replace(/([\\`*_{}\[\]()<>#+\-.!|~>])/g, "\\$1");
}

function safeUrl(value) {
  try {
    const url = new URL(text(value));
    return ["http:", "https:"].includes(url.protocol) ? text(value) : null;
  } catch {
    return null;
  }
}

function discordUrl(value) {
  return encodeURI(value)
    .replace(/\\/g, "%5C")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\[/g, "%5B")
    .replace(/\]/g, "%5D")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
}

function documentBlocks(document) {
  const blocks = [];
  if (Array.isArray(document?.nodes)) blocks.push(document.nodes);
  if (Array.isArray(document?.sections)) {
    for (const section of document.sections) blocks.push(section.nodes ?? []);
  }
  if (Array.isArray(document?.days)) {
    for (const day of document.days) {
      blocks.push(day.nodes ?? []);
      for (const event of day.events ?? []) blocks.push(event.nodes ?? []);
    }
  }
  return blocks.filter((nodes) => Array.isArray(nodes) && nodes.length);
}

function renderNode(node, platform) {
  if (!node || !NODE_TYPES.has(node.type)) throw new Error(`Unsupported market document node: ${node?.type ?? "missing"}`);
  if (node.type === "divider") return "\u2500\u2500\u2500";
  if (platform === "telegram") {
    if (node.type === "heading") return `<b>${htmlEscape(node.text)}</b>`;
    if (node.type === "paragraph") return htmlEscape(node.text);
    if (node.type === "metric") return `<b>${htmlEscape(node.label)}:</b> ${htmlEscape(node.value)}`;
    const url = safeUrl(node.url);
    return url ? `<a href="${htmlEscape(url)}">${htmlEscape(node.text)}</a>` : htmlEscape(node.text);
  }
  if (node.type === "heading") return `**${markdownEscape(node.text)}**`;
  if (node.type === "paragraph") return markdownEscape(node.text);
  if (node.type === "metric") return `**${markdownEscape(node.label)}:** ${markdownEscape(node.value)}`;
  const url = safeUrl(node.url);
  return url ? `[${markdownEscape(node.text)}](${discordUrl(url)})` : markdownEscape(node.text);
}

function renderDocument(document, platform) {
  const blocks = documentBlocks(document);
  if (!blocks.length) throw new Error("Market document has no renderable nodes.");
  return blocks.map((nodes) => nodes.map((node) => renderNode(node, platform)).join("\n")).join("\n\n");
}

export function renderTelegramMarketDocument(document) {
  return renderDocument(document, "telegram");
}

export function renderDiscordMarketDocument(document) {
  return renderDocument(document, "discord");
}
