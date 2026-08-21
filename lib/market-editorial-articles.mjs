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
  const score = candidates.map(Number).find(Number.isFinite);
  return score ?? (Number(event?.importance) || 0) * 10;
}

function eventTimestamp(event) {
  return iso(fieldValue(event?.schedule) ?? event?.scheduledAt ?? event?.time, "Weekly Calendar event");
}

function weeklyEventRecord(event, rank) {
  const [defaultWhy, defaultTransmission, defaultAssets] = eventRead(event);
  const schedule = event?.schedule && typeof event.schedule === "object" ? event.schedule : event?.provenance?.schedule;
  const source = event?.source ?? {};
  const utcTime = eventTimestamp(event);
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
      ...(event?.values?.forecast ? { forecast: fieldProvenance(event.values.forecast, source) } : {}),
      ...(event?.values?.previous ? { previous: fieldProvenance(event.values.previous, source) } : {}),
    },
    values: {
      ...(fieldValue(event?.values?.forecast) !== undefined ? { forecast: fieldValue(event.values.forecast) } : {}),
      ...(fieldValue(event?.values?.previous) !== undefined ? { previous: fieldValue(event.values.previous) } : {}),
    },
  };
}

const COUNTRY_ABBREVIATIONS = new Set(["u.s.", "u.k."]);
const COUNTRY_FINANCIAL_MODIFIERS = new Set(["treasury"]);
const CONTINUING_ABBREVIATIONS = new Set(["e.g.", "i.e."]);

function dottedAbbreviationContinuesSentence(abbreviation, prefix, suffix) {
  if (!/^\s+/u.test(suffix)) return false;
  const normalized = abbreviation.toLowerCase();
  const nextWord = suffix.match(/^\s+([A-Za-z0-9][A-Za-z0-9-]*)/u)?.[1] ?? "";
  if (!nextWord) return false;
  if (CONTINUING_ABBREVIATIONS.has(normalized)) return true;
  if (!COUNTRY_ABBREVIATIONS.has(normalized)) return false;
  if (/\b(?:in|within|inside|outside|across|throughout)\s+(?:the\s+)?$/iu.test(prefix)) return false;
  return /^[a-z]/u.test(nextWord)
    || /^[A-Z0-9]{2,}$/u.test(nextWord)
    || /^\d+-(?:day|week|month|year)$/iu.test(nextWord)
    || COUNTRY_FINANCIAL_MODIFIERS.has(nextWord.toLowerCase());
}

function oneSentence(value, fallback) {
  const sentence = text(value || fallback).replace(/\s+/g, " ").replace(/[.!?。！？]+$/u, "");
  const boundaryProbe = sentence.replace(/\b(?:[A-Za-z]\.){2,}/gu, (abbreviation, offset, input) => {
    const prefix = input.slice(0, offset);
    const suffix = input.slice(offset + abbreviation.length);
    const continuesSentence = dottedAbbreviationContinuesSentence(abbreviation, prefix, suffix);
    const letters = abbreviation.slice(0, -1).replaceAll(".", "");
    return continuesSentence ? letters : `${letters}.`;
  });
  const hasInternalLatinBoundary = /[.!?](?:["')\]]*)(?:\s+\S|(?=[A-Z0-9]))/u.test(boundaryProbe);
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
    ...events.flatMap((event) => [event?.source, event?.schedule, event?.provenance?.schedule]),
  ]);
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

export function buildWeeklyCalendarArticle({ document, rankedEvents, sourceManifest, marketSetup } = {}) {
  const events = (Array.isArray(rankedEvents) ? rankedEvents : [])
    .filter((event) => text(event?.title ?? event?.name) && (event?.scheduledAt || fieldValue(event?.schedule)))
    .sort((left, right) => eventImpactScore(right) - eventImpactScore(left)
      || eventTimestamp(left).localeCompare(eventTimestamp(right), "en")
      || text(left?.id).localeCompare(text(right?.id), "en"));
  if (events.length < 3) throw new Error("Weekly Calendar article requires at least three eligible events.");
  const impactRankedEvents = events.map(weeklyEventRecord);
  const priorityEvents = impactRankedEvents.slice(0, 3);
  const slug = isoWeekSlug(document?.weekStart);
  const generatedAt = iso(document?.generatedAt, "Weekly Calendar article");
  const setupSummary = text(marketSetup?.summary) || "Cross-asset positioning remains conditional on verified macro catalysts and follow-through in rates, DXY and crypto breadth.";

  return {
    id: `weekly-calendar:${slug}`,
    type: "weekly-calendar-analysis",
    version: MARKET_EDITORIAL_ARTICLE_VERSION,
    slug,
    publishedAt: generatedAt,
    weekStart: canonicalDate(document?.weekStart),
    weekEnd: canonicalDate(document?.weekEnd),
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
    sources: weeklySources(events, sourceManifest),
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
  return {
    templateId: "weekly-calendar-community",
    version: MARKET_EDITORIAL_ARTICLE_VERSION,
    generatedAt: article.publishedAt,
    title: `📌 Weekly Market Calendar — ${dateRange}`,
    articleUrl: url,
    nodes: [
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
    ],
  };
}

function releaseValues(event) {
  const values = event?.values ?? {};
  const provenance = event?.provenance ?? {};
  const read = (key) => fieldValue(values[key] ?? event?.[key] ?? provenance[key]);
  return { actual: read("actual"), forecast: read("forecast"), previous: read("previous") };
}

function numericValue(value) {
  const match = text(value).replaceAll(",", "").match(/[-+]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function releaseImpact(document, event) {
  const impact = text(document?.impact);
  if (["Bullish", "Bearish", "Neutral"].includes(impact)) return impact;
  const { actual, forecast } = releaseValues(event);
  const actualNumber = numericValue(actual);
  const benchmark = numericValue(forecast);
  if (actualNumber === null || benchmark === null || actualNumber === benchmark) return "Neutral";
  const indicator = eventIndicator(event);
  if (["cpi", "core-cpi", "pce", "core-pce", "ppi", "nonfarm-payrolls", "average-hourly-earnings"].includes(indicator)) {
    return actualNumber < benchmark ? "Bullish" : "Bearish";
  }
  if (["unemployment-rate", "initial-jobless-claims"].includes(indicator)) return actualNumber > benchmark ? "Bullish" : "Bearish";
  return actualNumber > benchmark ? "Bullish" : "Bearish";
}

function reactionRecords(reaction) {
  const source = reaction?.prices ?? reaction?.data ?? reaction ?? {};
  return REACTION_SYMBOLS.flatMap((symbol) => {
    const record = source?.[symbol];
    const changePercent = Number(record?.changePercent);
    const providerName = text(record?.source ?? record?.provider);
    return record && Number.isFinite(changePercent) && providerName
      ? [{ symbol, ...record, changePercent, providerName }]
      : [];
  });
}

function reactionWindow(reaction, event, document) {
  const records = reactionRecords(reaction);
  const explicitStart = reaction?.window?.start ?? reaction?.window?.startAt ?? reaction?.start;
  const explicitEnd = reaction?.window?.end ?? reaction?.window?.endAt ?? reaction?.end;
  const starts = records.map((record) => record.beforePriceAt).filter(Boolean);
  const ends = records.map((record) => record.observedAt).filter(Boolean);
  const start = iso(explicitStart ?? (starts.length ? starts.sort()[0] : event?.releasedAt ?? event?.observedAt), "Data Update reaction window start");
  const end = iso(explicitEnd ?? (ends.length ? ends.sort().at(-1) : document?.generatedAt), "Data Update reaction window end");
  if (new Date(end).getTime() <= new Date(start).getTime()) throw new Error("Data Update reaction window must have a bounded end after start.");
  const providers = unique(records.map((record) => record.providerName));
  if (!providers.length) throw new Error("Data Update reaction window requires at least one named market provider.");
  return { start, end, providers };
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

function releaseSourceCandidates(event, reaction, manifest) {
  const records = reactionRecords(reaction);
  return dedupeSources([
    ...(Array.isArray(manifest) ? manifest : []),
    event?.source,
    ...Object.values(event?.provenance ?? {}),
    ...records.map((record) => ({ id: record.provider, label: record.providerName, url: record.url ?? record.sourceUrl, type: "market-observation" })),
  ]);
}

function releaseDate(event, document) {
  return canonicalDate(iso(event?.releasedAt ?? event?.observedAt ?? document?.generatedAt, "Data Update release").slice(0, 10));
}

function releaseSlug(event) {
  const supplied = text(event?.slug ?? event?.indicator ?? event?.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return canonicalReleaseSlug(supplied);
}

function factsRecord(event) {
  const values = releaseValues(event);
  if (values.actual === undefined || values.actual === null || text(values.actual) === "") throw new Error("Data Update article requires an official actual value.");
  const provenance = event?.provenance ?? {};
  const actualProvenance = provenance.actual ?? (event?.values?.actual && typeof event.values.actual === "object" ? event.values.actual : null);
  if (!actualProvenance) throw new Error("Data Update article requires field provenance for the official actual value.");
  const facts = {
    title: text(event?.title) || text(event?.indicator) || "Data release",
    jurisdiction: text(event?.jurisdiction ?? event?.country) || "Global",
    releasedAt: iso(event?.releasedAt ?? event?.observedAt, "Data Update facts"),
    actual: values.actual,
    ...(values.previous !== undefined && values.previous !== null && text(values.previous) ? { previous: values.previous } : {}),
    provenance: {
      actual: fieldProvenance(actualProvenance, event?.source),
      ...(values.previous !== undefined && values.previous !== null && text(values.previous)
        ? { previous: fieldProvenance(provenance.previous ?? event?.values?.previous, event?.source) }
        : {}),
    },
  };
  if (values.forecast !== undefined && values.forecast !== null && text(values.forecast)) {
    const actualNumber = numericValue(values.actual);
    const forecastNumber = numericValue(values.forecast);
    facts.forecast = values.forecast;
    facts.provenance.forecast = fieldProvenance(provenance.forecast ?? event?.values?.forecast, event?.forecastSource ?? event?.source);
    if (actualNumber !== null && forecastNumber !== null) {
      const suffix = text(values.actual).includes("%") && text(values.forecast).includes("%") ? "pp" : "";
      const difference = Math.round((actualNumber - forecastNumber) * 100) / 100;
      facts.surprise = `${difference > 0 ? "+" : ""}${difference}${suffix}`;
    }
  }
  return facts;
}

function dataSignalSummary(impact, facts) {
  if (facts.forecast === undefined) {
    return `Inference: the verified release is ${impact.toLowerCase()} for risk assets on the available prior context; no consensus comparison claim is made.`;
  }
  return `Inference: the release reads ${impact.toLowerCase()} for risk assets after comparing the official actual with the named auxiliary consensus benchmark.`;
}

function dataArticleModel({ document, event, reaction, tierDecision, sourceManifest, requireTierOne }) {
  if (requireTierOne && text(tierDecision?.tier) !== "tier-one") throw new Error("A standalone Data Update article requires a tier-one decision.");
  const facts = factsRecord(event);
  const records = reactionRecords(reaction);
  const window = reactionWindow(reaction, event, document);
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
    sources: releaseSourceCandidates(event, reaction, sourceManifest),
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
    const actual = numericValue(facts.actual);
    const forecast = numericValue(facts.forecast);
    const direction = actual === forecast ? "Matched forecast" : actual > forecast ? "Above forecast" : "Below forecast";
    changedNodes.push({ type: "metric", label: "Surprise", value: `${text(facts.surprise)} · ${direction}` });
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
  const url = absoluteHttpsUrl(articleUrl);
  if (!url) throw new TypeError("Data Update community entry requires an absolute HTTPS article link.");
  return {
    templateId: "data-update-community",
    version: MARKET_EDITORIAL_ARTICLE_VERSION,
    generatedAt: article.publishedAt,
    title: `📌 Data Update — ${article.facts.title}`,
    articleUrl: url,
    nodes: releaseCommunityNodes(article, { includeLink: true, articleUrl: url }),
  };
}

export function buildSecondaryDataUpdateCommunityDocument(input = {}) {
  const article = dataArticleModel({ ...input, sourceManifest: [], requireTierOne: false });
  if (text(input?.tierDecision?.tier) === "tier-one") throw new Error("Secondary Data Update community entry requires a non-tier-one decision.");
  return {
    templateId: "data-update-secondary-community",
    version: MARKET_EDITORIAL_ARTICLE_VERSION,
    generatedAt: article.publishedAt,
    title: `📌 Data Update — ${article.facts.title}`,
    nodes: releaseCommunityNodes(article, { includeLink: false }),
  };
}
