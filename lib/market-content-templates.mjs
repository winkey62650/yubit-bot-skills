import { selectMarketImpactStories } from "./market-impact-ranking.mjs";

export const MARKET_CONTENT_TEMPLATE_VERSION = "market-content-v2";

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

function releaseValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Object.hasOwn(value, "value")) return releaseValue(value.value);
    if (Object.hasOwn(value, "rawValue")) {
      const raw = text(value.rawValue);
      const unit = text(value.unit);
      return raw && unit && !raw.toUpperCase().endsWith(unit.toUpperCase()) ? `${raw}${unit}` : raw;
    }
    return "";
  }
  return text(value);
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
  const hasCryptoContext = /\b(?:bitcoin|btc|ethereum|eth|crypto|blockchain|defi|stablecoin|token|protocol|mainnet)\b/.test(corpus);
  if (!hasCryptoContext) return null;
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
  const sourceId = slug(story?.source?.id ?? story?.sourceId ?? story?.source?.name ?? story?.source?.label ?? story?.sourceLabel);
  if (["official", "regulator", "government", "project-official"].includes(kind)) return true;
  if (/^(?:sec|cftc|bls|bea|federal-reserve|fed)$/.test(sourceId)) return true;
  try {
    const host = new URL(text(story?.source?.url ?? story?.sourceUrl ?? story?.url)).hostname.toLowerCase();
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

function canonicalSerialize(value) {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalSerialize(value[key])}`).join(",")}}`;
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

const DIRECTIONAL_EVIDENCE_PATTERNS = Object.freeze({
  Bullish: Object.freeze([
    ["net-inflow", /\bnet\s+inflows?\b/gu],
    ["approval", /\bapprov(?:al|e|ed|es)\b/gu],
    ["adoption", /\badoption\b/gu],
    ["launch-success", /\b(?<direction>successful(?:ly)?)\s+launch(?:ed|es|ing)?\b/gu],
    ["launch-success", /\blaunch(?:ed|es|ing)?(?:\s+[a-z]+){0,3}\s+(?<direction>successful(?:ly)?|succeeds?|succeeded)\b/gu],
    ["allocation-increase", /\ballocations?\s+increased\b/gu],
    ["demand-strength", /\bstronger\s+institutional\s+demand\b/gu],
  ]),
  Bearish: Object.freeze([
    ["net-outflow", /\bnet\s+outflows?\b/gu],
    ["security-incident", /\b(?:hack(?:ed|ing|s)?|exploit(?:ed|ing|s)?|breach(?:ed|ing|es)?)\b/gu],
    ["ban", /\bban(?:ned|s)?\b/gu],
    ["rejection", /\b(?:reject(?:ion|ed|s)?|den(?:y|ial|ied|ies))\b/gu],
    ["enforcement", /\benforcement\s+action\b/gu],
    ["shutdown", /\b(?:shutdown|shut(?:s|ting)?\s+down)\b/gu],
    ["launch-failure", /\b(?<direction>fail(?:ed|s|ure)?)(?:\s+[a-z]+){0,3}\s+launch(?:ed|es|ing)?\b/gu],
    ["launch-failure", /\blaunch(?:ed|es|ing)?(?:\s+[a-z]+){0,3}\s+(?<direction>fail(?:ed|s|ure)?)\b/gu],
    ["allocation-decrease", /\ballocations?\s+decreased\b/gu],
    ["demand-weakness", /\bweaken(?:ing|ed)?\s+institutional\s+demand\b/gu],
  ]),
});

function normalizedDirectionalEvidence(value) {
  return text(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\bcan't\b/gu, "can not")
    .replace(/\bwon't\b/gu, "will not")
    .replace(/\bshan't\b/gu, "shall not")
    .replace(/\b([a-z]+)n['’]t\b/gu, "$1 not");
}

function directionalMatchIsNegated(evidence, matchIndex) {
  const clausePrefix = evidence.slice(Math.max(0, matchIndex - 120), matchIndex).split(/[.!?;,:]/u).at(-1) ?? "";
  const words = clausePrefix.match(/\b[a-z]+(?:'[a-z]+)?\b/gu) ?? [];
  const window = words.slice(-6).join(" ");
  return /\b(?:no|not|never|without)\b/u.test(window)
    || /\b(?:fail(?:ed|s)?|failure)\s+to(?:\s+[a-z]+){0,4}$/u.test(window);
}

function directionalAssertions(value) {
  const evidence = normalizedDirectionalEvidence(value);
  const assertions = new Map();
  for (const [polarity, patterns] of Object.entries(DIRECTIONAL_EVIDENCE_PATTERNS)) {
    for (const [assertion, pattern] of patterns) {
      for (const match of evidence.matchAll(pattern)) {
        const direction = match.groups?.direction;
        const directionIndex = direction ? match.index + match[0].lastIndexOf(direction) : match.index;
        const key = `${polarity}:${assertion}`;
        const states = assertions.get(key) ?? new Set();
        states.add(directionalMatchIsNegated(evidence, directionIndex) ? "negated" : "affirmed");
        assertions.set(key, states);
      }
    }
  }
  return assertions;
}

function directionalPolarities(value) {
  const polarities = new Set();
  for (const [assertion, states] of directionalAssertions(value)) {
    if (states.has("affirmed")) polarities.add(assertion.split(":", 1)[0]);
  }
  return polarities;
}

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
  return {
    assertions: directionalAssertions(corpus),
    events,
    numbers: [...new Set(numbers)].sort(),
    entities: new Set(entities),
    polarities: directionalPolarities(corpus),
  };
}

function hasConflictingStoryDirection(leftFact, rightFact) {
  const conflictingPolarity = [...leftFact.polarities].some((leftPolarity) => (
    [...rightFact.polarities].some((rightPolarity) => leftPolarity !== rightPolarity)
  ));
  if (conflictingPolarity) return true;
  return [...leftFact.assertions].some(([assertion, leftStates]) => {
    const rightStates = rightFact.assertions.get(assertion);
    return rightStates && (
      leftStates.has("affirmed") !== rightStates.has("affirmed")
      || leftStates.has("negated") !== rightStates.has("negated")
    );
  });
}

function sameStoryFact(left, right) {
  const leftFact = storyFact(left);
  const rightFact = storyFact(right);
  if (hasConflictingStoryDirection(leftFact, rightFact)) return false;
  const sharedStrongIdentity = storyKey(left) === storyKey(right) && storyKey(left).startsWith("id:");
  if (sharedStrongIdentity) {
    if (leftFact.numbers.length && rightFact.numbers.length
      && leftFact.numbers.join("\u0000") !== rightFact.numbers.join("\u0000")) return false;
    return true;
  }
  const sharedEvents = [...leftFact.events].filter((event) => rightFact.events.has(event));
  if (!sharedEvents.length) return false;
  if (leftFact.numbers.length || rightFact.numbers.length) {
    if (leftFact.numbers.join("\u0000") !== rightFact.numbers.join("\u0000")) return false;
  }
  if (storyKey(left) === storyKey(right)) return true;
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
  const importanceDifference = (Number(right?.importance) || 0) - (Number(left?.importance) || 0);
  if (importanceDifference) return importanceDifference > 0 ? right : left;
  const evidenceCompleteness = (story) => [story?.rationale, story?.evidence, story?.summary]
    .reduce((score, value) => score + Number(Boolean(text(value))) * 1_000 + text(value).length, 0);
  const evidenceDifference = evidenceCompleteness(right) - evidenceCompleteness(left);
  if (evidenceDifference) return evidenceDifference > 0 ? right : left;
  const leftTime = Date.parse(left?.publishedAt);
  const rightTime = Date.parse(right?.publishedAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime > leftTime ? right : left;
  return canonicalSerialize(right).localeCompare(canonicalSerialize(left), "en") < 0 ? right : left;
}

const TRUSTED_SOURCE_IDENTITIES = new Map([
  ["id:sec", "official:sec"],
  ["name:sec", "official:sec"],
  ["name:u s securities and exchange commission", "official:sec"],
  ["domain:sec.gov", "official:sec"],
  ["id:cftc", "official:cftc"],
  ["name:cftc", "official:cftc"],
  ["name:u s commodity futures trading commission", "official:cftc"],
  ["domain:cftc.gov", "official:cftc"],
  ["id:bls", "official:bls"],
  ["name:bls", "official:bls"],
  ["name:u s bureau of labor statistics", "official:bls"],
  ["name:bureau of labor statistics", "official:bls"],
  ["domain:bls.gov", "official:bls"],
  ["id:bea", "official:bea"],
  ["name:bea", "official:bea"],
  ["name:u s bureau of economic analysis", "official:bea"],
  ["name:bureau of economic analysis", "official:bea"],
  ["domain:bea.gov", "official:bea"],
  ["id:fed", "official:federal-reserve"],
  ["id:federal-reserve", "official:federal-reserve"],
  ["name:federal reserve", "official:federal-reserve"],
  ["name:federal reserve board", "official:federal-reserve"],
  ["domain:federalreserve.gov", "official:federal-reserve"],
]);

function sourceIdentity(story) {
  const source = story?.source && typeof story.source === "object" ? story.source : {};
  const sourceId = text(source.id ?? story?.sourceId);
  const sourceName = text(source.name ?? source.label ?? story?.sourceName ?? story?.sourceLabel);
  const sourceUrl = text(source.url ?? story?.sourceUrl ?? story?.url);
  let hostname = "";
  try {
    hostname = new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    // Fall through to a stable URL or unknown-source identity.
  }
  const candidates = [
    sourceId && `id:${slug(sourceId)}`,
    sourceName && `name:${normalizedStoryTitle(sourceName)}`,
    hostname && `domain:${hostname}`,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const trustedIdentity = TRUSTED_SOURCE_IDENTITIES.get(candidate);
    if (trustedIdentity) return trustedIdentity;
  }
  if (sourceId) return `id:${sourceId.toLowerCase()}`;
  if (sourceName) return `name:${normalizedStoryTitle(sourceName)}`;
  if (hostname) return `domain:${hostname}`;
  return sourceUrl ? `url:${sourceUrl}` : "source:unknown";
}

export function deduplicateCryptoStories(stories) {
  const groups = [];
  const candidates = (Array.isArray(stories) ? stories : [])
    .filter((candidate) => candidate && text(candidate.title))
    .sort((left, right) => (
      stableStoryId(left).localeCompare(stableStoryId(right), "en")
      || canonicalSerialize(left).localeCompare(canonicalSerialize(right), "en")
    ));
  for (const candidate of candidates) {
    const index = groups.findIndex((group) => sameStoryFact(group.story, candidate));
    const existing = groups[index];
    if (!existing) {
      groups.push({
        story: { ...candidate, sourceConfirmations: 1 },
        sourceIdentities: new Set([sourceIdentity(candidate)]),
      });
      continue;
    }
    existing.sourceIdentities.add(sourceIdentity(candidate));
    const selected = preferredDuplicate(existing.story, candidate);
    const alternate = selected === existing.story ? candidate : existing.story;
    groups[index] = {
      story: {
        ...alternate,
        ...selected,
        sourceConfirmations: existing.sourceIdentities.size,
      },
      sourceIdentities: existing.sourceIdentities,
    };
  }
  return groups
    .map((group) => group.story)
    .sort((left, right) => storyKey(left).localeCompare(storyKey(right), "en"));
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
    return stableStoryId(left).localeCompare(stableStoryId(right), "en")
      || canonicalSerialize(left).localeCompare(canonicalSerialize(right), "en");
  });
}

function safeImpact(value) {
  const normalized = text(value).toLowerCase();
  if (normalized === "bullish") return "Bullish";
  if (normalized === "bearish") return "Bearish";
  return "Neutral";
}

function neutralImpactRationale(story) {
  const value = `${text(story?.title)} ${text(story?.summary)}`.toLowerCase();
  if (/stablecoin/.test(value) && /(?:payment|spending|card|agent)/.test(value)) {
    return "This is evidence of stablecoin utility and payment adoption, but it does not by itself establish a near-term BTC or ETH direction.";
  }
  if (/(?:study|survey|research)/.test(value) && /(?:investor|belief|allocation|purchase)/.test(value)) {
    return "This helps explain investor demand sensitivity and positioning behaviour, but it is not a standalone trading catalyst.";
  }
  if (/etf|inflow|outflow/.test(value)) {
    return "The flow is relevant to institutional demand, but direction requires confirmation from persistence, spot volume and market structure.";
  }
  if (/regulat|legislat|court|sec\b|cftc\b/.test(value)) {
    return "The policy development can change access or compliance conditions, but price direction depends on final scope and implementation.";
  }
  return "The development is relevant context, but available evidence does not establish a directional market impact.";
}

function storyImpactAssessment(story) {
  const supplied = safeImpact(story?.impact);
  const explicitNeutral = text(story?.impact).toLowerCase() === "neutral";
  const evidenceFields = [story?.rationale, story?.evidence, story?.title, story?.summary]
    .map((value) => ({ text: text(value), polarities: directionalPolarities(value) }))
    .filter((field) => field.text);
  const directions = new Set(evidenceFields.flatMap((field) => [...field.polarities]));
  if (directions.size > 1) {
    return {
      impact: "Neutral",
      rationale: "Verified directional evidence is conflicting, so no clear market impact is established.",
    };
  }
  const supported = directions.size === 1 ? [...directions][0] : "Neutral";
  const impact = explicitNeutral
    ? "Neutral"
    : supplied !== "Neutral" ? (supported === supplied ? supplied : "Neutral") : supported;
  if (impact !== "Neutral") {
    const support = evidenceFields.find((field) => field.polarities.has(impact));
    return { impact, rationale: support.text };
  }
  return {
    impact: "Neutral",
    rationale: neutralImpactRationale(story),
  };
}

function lowImpactTheme(story) {
  const value = `${text(story?.title)} ${text(story?.summary)}`.toLowerCase();
  if (/stablecoin/.test(value) && /(?:payment|spending|card|agent)/.test(value)) return "stablecoin-payments";
  if (/(?:study|survey|research)/.test(value) && /(?:investor|belief|allocation|purchase)/.test(value)) return "investor-behaviour";
  if (/etf|inflow|outflow/.test(value)) return "institutional-flows";
  return null;
}

function diversifyLowImpactStories(stories) {
  const seen = new Set();
  return stories.filter((story) => {
    const theme = lowImpactTheme(story);
    if (!theme || Number(story?.marketImpact?.score) >= 50) return true;
    if (seen.has(theme)) return false;
    seen.add(theme);
    return true;
  });
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
  const assessment = storyImpactAssessment(selected);
  return {
    id,
    title: details.title,
    impact: assessment.impact,
    storyId: text(selected.id) || storyKey(selected),
    nodes: [
      heading,
      { type: "paragraph", text: text(selected.title) },
      { type: "metric", label: "Market Impact", value: IMPACT_DISPLAY[assessment.impact] },
      { type: "paragraph", text: assessment.rationale },
      { type: "link", text: `Source: ${text(selected.source?.label ?? selected.source?.id)}`, url: text(selected.url) },
    ],
  };
}

function marketDecisionSection(story, index) {
  const assessment = story?.impactAssessment ?? storyImpactAssessment(story);
  const score = Math.round(Number(story?.marketImpact?.score) || 0);
  const affected = (Array.isArray(story?.affectedAssets) ? story.affectedAssets : story?.categories ?? [])
    .map(text).filter(Boolean).slice(0, 4).join(" · ") || "Crypto market";
  const whyItMatters = text(assessment.rationale) || text(story?.rationale) || text(story?.summary)
    || "This verified development ranks among today's highest-impact market signals.";
  return {
    id: `market-impact-${index + 1}`,
    title: text(story.title),
    story,
    storyId: text(story.id) || storyKey(story),
    impact: assessment.impact,
    nodes: [
      { type: "heading", text: `${String(index + 1).padStart(2, "0")}  ${text(story.title)}`, level: 2 },
      { type: "metric", label: "Impact Score", value: `${score}/100` },
      { type: "paragraph", text: whyItMatters },
      { type: "metric", label: "Affected", value: affected },
      { type: "metric", label: "Directional Read", value: IMPACT_DISPLAY[assessment.impact] },
      { type: "link", text: `Source: ${text(story.source?.label ?? story.source?.id)}`, url: text(story.url) },
    ],
  };
}

function enrichMarketDecisionStory(story) {
  const assessment = storyImpactAssessment(story);
  const category = classifyCryptoStory(story);
  const score = Math.round(Number(story?.marketImpact?.score) || 0);
  const official = officialStory(story);
  const confirmations = Number(story?.sourceConfirmations ?? story?.confirmations?.length ?? 1) || 1;
  const defaults = {
    "btc-etf-institutional": {
      affectedAssets: ["BTC", "ETH", "Broad Crypto"],
      whatToWatch: "Watch spot ETF flow persistence, BTC volume, and whether basis/open interest confirms rather than overheats.",
    },
    regulation: {
      affectedAssets: ["BTC", "ETH", "Affected Tokens"],
      whatToWatch: "Watch the final legal scope, effective date, enforcement follow-through, and any exchange or issuer response.",
    },
    "market-project": {
      affectedAssets: ["BTC", "ETH", "Altcoins"],
      whatToWatch: "Watch on-chain or exchange follow-through, volume breadth, and whether the first price move persists.",
    },
  }[category] ?? {
    affectedAssets: ["BTC", "ETH", "Altcoins"],
    whatToWatch: "Watch price persistence, volume retention, and confirmation across BTC, ETH and the dollar.",
  };
  return {
    ...story,
    impactAssessment: assessment,
    impact: assessment.impact,
    rationale: text(assessment.rationale) || text(story?.rationale) || text(story?.summary),
    affectedAssets: Array.isArray(story?.affectedAssets) && story.affectedAssets.length ? story.affectedAssets : defaults.affectedAssets,
    horizon: text(story?.horizon) || (score >= 80 ? "Current and next liquid session" : "Current session"),
    confidence: ["Low", "Medium", "High"].includes(story?.confidence)
      ? story.confidence
      : official || confirmations >= 2 ? "High" : "Medium",
    whatToWatch: text(story?.whatToWatch) || defaults.whatToWatch,
  };
}

export function buildCryptoDailyDocument({ now, candidates } = {}) {
  const generated = validDate(now) ?? new Date();
  const ranked = rankCryptoStories(deduplicateCryptoStories(candidates), generated);
  const windowStart = generated.getTime() - 24 * 60 * 60 * 1000;
  const eligible = ranked.filter((candidate) => {
    if (!traceableStory(candidate)) return false;
    if (!classifyCryptoStory(candidate)) return false;
    const publishedAt = Date.parse(candidate?.publishedAt);
    return Number.isFinite(publishedAt) && publishedAt >= windowStart && publishedAt <= generated.getTime();
  });
  const sections = CRYPTO_DAILY_SECTIONS.map((id) => cryptoSection(id, eligible.find((story) => classifyCryptoStory(story) === id)));
  const selectedStories = diversifyLowImpactStories(selectMarketImpactStories(eligible, generated)).map(enrichMarketDecisionStory);
  const decisionSections = selectedStories.map(marketDecisionSection);
  return {
    templateId: "crypto-daily",
    version: MARKET_CONTENT_TEMPLATE_VERSION,
    generatedAt: generated.toISOString(),
    title: `\ud83d\udcf0 Crypto Daily \u2014 ${formatMonthDay(generated)}`,
    nodes: [{ type: "heading", text: `\ud83d\udcf0 Crypto Daily \u2014 ${formatMonthDay(generated)}`, level: 1 }],
    sections,
    selectedStories,
    decisionSections,
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

function utcTime(value) {
  const scheduled = timedDate(value);
  return scheduled ? scheduled.toISOString().slice(11, 16) : "TBD";
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
  return Boolean(normalizedIndicator(event));
}

function materialIndicatorVariant(event) {
  const indicator = normalizedIndicator(event);
  const titleValue = text(event?.title).toLowerCase();
  if (indicator === "retail-sales" && /\belectronic card retail sales\b/.test(titleValue)) {
    return false;
  }
  if (indicator === "gdp" && /\b(?:capital expenditure|private consumption|external demand|inventor|price index|deflator|final sales)\b/.test(titleValue)) {
    return false;
  }
  return true;
}

export function isSupportedReleaseEvent(event) {
  const records = Array.isArray(event?.components) && event.components.length
    ? event.components
    : [event];
  return records.length > 0 && records.every((record) => (
    Boolean(normalizedIndicator(record)) && materialIndicatorVariant(record)
  ));
}

function indicatorVariantPriority(event) {
  const indicator = normalizedIndicator(event);
  const titleValue = text(event?.title).toLowerCase();
  const corePriority = indicator === "core-cpi" || indicator === "core-pce" ? 5 : 0;
  if (indicator === "gdp") {
    if (/gdp growth rate.*qoq|gdp.*annuali[sz]ed/.test(titleValue)) return 50;
    if (/gdp growth rate.*yoy/.test(titleValue)) return 40;
  }
  if (/\byoy\b/.test(titleValue)) return 30 + corePriority;
  if (/\bqoq\b/.test(titleValue)) return 20 + corePriority;
  if (/\bmom\b/.test(titleValue)) return 10 + corePriority;
  return corePriority;
}

function calendarIndicatorFamily(event) {
  const indicator = normalizedIndicator(event);
  if (indicator === "cpi" || indicator === "core-cpi") return "consumer-inflation";
  if (indicator === "pce" || indicator === "core-pce") return "pce-inflation";
  return indicator || normalizedStoryTitle(event?.title);
}

function presentValue(value) {
  const resolved = releaseValue(value);
  return value !== null && value !== undefined && resolved && !/^(?:null|undefined|tbd|n\/?a|--?)$/i.test(resolved);
}

function calendarEventRecord(event) {
  const scheduled = timedDate(event?.scheduledAt);
  const values = event?.values ?? {};
  const rawTitle = text(event?.title) || "Verified event";
  const country = text(event?.country ?? event?.region ?? event?.currency)
    || (/^(?:US\b|FOMC\b|Federal Reserve\b)/i.test(rawTitle) ? "US" : "");
  const countryName = {
    US: "United States", JP: "Japan", CN: "China", GB: "United Kingdom", UK: "United Kingdom",
    CA: "Canada", AU: "Australia", NZ: "New Zealand", DE: "Germany", FR: "France", EU: "Euro Area",
  }[country.toUpperCase()];
  const titleAlreadyLocalized = country && (
    rawTitle.toLowerCase().startsWith(country.toLowerCase())
    || (country === "US" && /^(?:U\.S\.|US)\b/i.test(rawTitle))
    || (countryName && rawTitle.toLowerCase().startsWith(countryName.toLowerCase()))
  );
  const titleValue = country && !titleAlreadyLocalized ? `${country} · ${rawTitle}` : rawTitle;
  const nodes = [
    { type: "heading", text: `${utcTime(scheduled)} UTC \u2014 ${titleValue}`, level: 3 },
  ];
  if (presentValue(event?.importance)) nodes.push({ type: "metric", label: "Importance", value: Number(event.importance) >= 3 ? "\ud83d\udd34 High" : text(event.importance) });
  for (const [label, key] of [["Actual", "actual"], ["Forecast", "forecast"], ["Previous", "previous"]]) {
    if (presentValue(values[key])) nodes.push({ type: "metric", label, value: releaseValue(values[key]) });
  }
  const sourceLabel = text(event?.source?.label ?? event?.sourceLabel ?? event?.source);
  const sourceUrl = text(event?.source?.url ?? event?.sourceUrl ?? event?.url);
  const indicator = normalizedIndicator(event);
  const eventReads = {
    cpi: ["Rates · DXY · BTC", "An inflation surprise can reprice the expected Fed path and global liquidity conditions."],
    "core-cpi": ["Rates · DXY · BTC", "Core inflation is a key persistence signal for the expected Fed path."],
    pce: ["Rates · DXY · BTC", "The Fed's preferred inflation gauge can shift policy-path expectations."],
    "core-pce": ["Rates · DXY · BTC", "Core PCE can change the market's view of persistent inflation and policy restraint."],
    ppi: ["Rates · DXY · Risk assets", "Producer prices can foreshadow pipeline inflation and change rate expectations."],
    "nonfarm-payrolls": ["Rates · DXY · BTC", "Payroll strength can change the expected pace and timing of Fed easing."],
    "unemployment-rate": ["Rates · DXY · BTC", "Labour-market slack is a key constraint on the expected Fed path."],
    "average-hourly-earnings": ["Rates · DXY · Risk assets", "Wage growth is a direct signal of services-inflation persistence."],
    "initial-jobless-claims": ["Rates · DXY · BTC", "A claims surprise can shift the near-term view of labour-market momentum."],
    gdp: ["Rates · Equities · BTC", "A growth surprise can reset demand expectations and the soft-landing narrative."],
    "retail-sales": ["Rates · Equities · BTC", "Consumer-demand momentum can change both growth and policy expectations."],
    "fomc-rate-decision": ["USD · Rates · Crypto", "The rate decision directly changes the price of liquidity across risk assets."],
    "fomc-statement": ["USD · Rates · Crypto", "Policy language can shift the expected path even when the policy rate is unchanged."],
  };
  const scenarioMaps = {
    cpi: "Hotter: yields/DXY up, BTC pressure. Cooler: yields/DXY down, BTC relief.",
    "core-cpi": "Hotter: yields/DXY up, BTC pressure. Cooler: yields/DXY down, BTC relief.",
    pce: "Hotter: policy easing repriced out. Cooler: easing odds and risk appetite improve.",
    "core-pce": "Hotter: policy easing repriced out. Cooler: easing odds and risk appetite improve.",
    ppi: "Hotter: pipeline-inflation risk rises. Cooler: rate pressure eases.",
    "nonfarm-payrolls": "Stronger: yields/DXY may rise. Weaker: yields may fall, unless recession risk dominates.",
    "unemployment-rate": "Lower: labour remains tight. Higher: easing odds rise, unless growth fear dominates.",
    "average-hourly-earnings": "Hotter wages: yields/DXY up. Cooler wages: rate pressure eases.",
    "initial-jobless-claims": "Lower claims: labour stays firm. Higher claims: easing odds rise, with growth-risk caveat.",
    gdp: "Stronger: demand assets benefit but yields may rise. Weaker: growth risk offsets easier-policy hopes.",
    "retail-sales": "Stronger: growth bid with higher yields. Weaker: demand concern with possible rate relief.",
    "fomc-rate-decision": "More hawkish: USD/yields up, crypto pressure. More dovish: liquidity expectations improve.",
    "fomc-statement": "More hawkish: USD/yields up, crypto pressure. More dovish: liquidity expectations improve.",
  };
  let [marketSensitivity, whyItMatters] = eventReads[indicator] ?? [
    text(event?.marketSensitivity) || "Rates · DXY · Crypto",
    text(event?.whyItMatters) || "This verified high-impact event can alter liquidity, volatility, or risk appetite.",
  ];
  const nonUsMacro = country && country !== "US" && slug(event?.kind ?? event?.type) !== "crypto";
  if (nonUsMacro) {
    marketSensitivity = `${country} rates · ${country} FX · Global risk`;
    whyItMatters = `A surprise can reprice ${country} rates and FX; crypto relevance requires confirmation through U.S. yields, DXY and BTC breadth.`;
  }
  nodes.push({ type: "metric", label: "Market sensitivity", value: marketSensitivity });
  nodes.push({ type: "paragraph", text: whyItMatters });
  const nonUsScenarioMaps = {
    cpi: `Hotter inflation can lift ${country} yields/FX; cooler inflation can ease local rate pressure.`,
    "core-cpi": `Hotter core inflation can lift ${country} yields/FX; cooler inflation can ease local rate pressure.`,
    pce: `Hotter inflation can lift ${country} yields/FX; cooler inflation can ease local rate pressure.`,
    "core-pce": `Hotter core inflation can lift ${country} yields/FX; cooler inflation can ease local rate pressure.`,
    ppi: `Hotter producer prices can lift ${country} rate expectations; cooler prices can ease them.`,
    "unemployment-rate": `Higher unemployment can raise ${country} easing odds; lower unemployment can support ${country} yields/FX.`,
    "initial-jobless-claims": `Higher claims can raise ${country} easing odds; lower claims can support ${country} yields/FX.`,
    "nonfarm-payrolls": `Stronger hiring can support ${country} yields/FX; weaker hiring can raise easing odds unless growth fear dominates.`,
    "average-hourly-earnings": `Hotter wages can lift ${country} yields/FX; cooler wages can ease local rate pressure.`,
    gdp: `Stronger growth can support ${country} yields/FX; weaker growth can raise easing odds unless recession fear dominates.`,
    "retail-sales": `Stronger demand can support ${country} yields/FX; weaker demand can raise easing odds unless growth fear dominates.`,
  };
  const scenarioMap = text(event?.scenarioMap) || (nonUsMacro
    ? `${nonUsScenarioMaps[indicator] ?? `Above consensus can lift ${country} yields/FX; below consensus can ease local rate pressure.`} Treat the crypto spillover as valid only if U.S. yields/DXY and BTC breadth confirm.`
    : scenarioMaps[indicator])
    || "Risk-on confirmation requires supportive rates, DXY and crypto breadth; reversal across those markets invalidates the first move.";
  nodes.push({ type: "metric", label: "Scenario map", value: scenarioMap });
  if (sourceLabel && sourceUrl) nodes.push({ type: "link", text: `Source: ${sourceLabel}`, url: sourceUrl });
  else if (sourceLabel) nodes.push({ type: "paragraph", text: `Source: ${sourceLabel}` });
  return {
    id: text(event?.id ?? event?.sourceId) || `${eventDate(event)}:${titleValue}`,
    title: titleValue,
    country: country || null,
    time: utcTime(scheduled),
    ...(scheduled ? { scheduledAt: scheduled.toISOString() } : {}),
    values: { ...values },
    importance: Number(event?.importance) || 0,
    indicator,
    eventKind: slug(event?.kind ?? event?.type),
    marketSensitivity,
    whyItMatters,
    scenarioMap,
    source: sourceLabel ? { label: sourceLabel, ...(sourceUrl ? { url: sourceUrl } : {}) } : null,
    nodes,
  };
}

function calendarMarketPriority(event) {
  const indicator = text(event?.indicator);
  const country = slug(event?.country);
  const importance = Math.max(0, Math.min(3, Number(event?.importance) || 0));
  if (event?.eventKind === "crypto") return 100 + importance * 10;
  if (indicator === "fomc-rate-decision" || indicator === "fomc-statement") return 120 + importance * 10;
  const isUnitedStates = ["us", "u-s", "united-states"].includes(country);
  if (isUnitedStates) return 100 + importance * 10;
  const majorEconomy = new Set([
    "australia", "canada", "china", "euro-area", "euro-zone", "germany", "japan", "united-kingdom", "uk",
  ]).has(country);
  const directMacroCatalyst = new Set([
    "cpi", "core-cpi", "pce", "core-pce", "nonfarm-payrolls", "unemployment-rate",
    "average-hourly-earnings", "initial-jobless-claims", "gdp", "retail-sales",
  ]).has(indicator);
  if (majorEconomy && directMacroCatalyst) return 75 + importance * 10;
  if (directMacroCatalyst) return 55 + importance * 10;
  if (indicator === "ppi" && majorEconomy) return 40 + importance * 10;
  if (indicator === "ppi") return 20 + importance * 10;
  return importance * 10;
}

function preferredCalendarEvent(left, right) {
  const variantDifference = indicatorVariantPriority(right) - indicatorVariantPriority(left);
  if (variantDifference) return variantDifference > 0 ? right : left;
  const leftOfficial = officialStory(left);
  const rightOfficial = officialStory(right);
  if (leftOfficial !== rightOfficial) return rightOfficial ? right : left;
  const traceability = (event) => Number(Boolean(
    text(event?.source?.label ?? event?.sourceLabel ?? event?.source)
    && text(event?.source?.url ?? event?.sourceUrl ?? event?.url)
  ));
  const traceabilityDifference = traceability(right) - traceability(left);
  if (traceabilityDifference) return traceabilityDifference > 0 ? right : left;
  const stable = (event) => [
    text(event?.source?.id ?? event?.sourceId),
    text(event?.source?.name ?? event?.source?.label ?? event?.sourceLabel),
    text(event?.source?.url ?? event?.sourceUrl ?? event?.url),
    text(event?.id),
  ].join("\u0000").toLowerCase();
  const stableDifference = stable(right).localeCompare(stable(left), "en");
  if (stableDifference) return stableDifference < 0 ? right : left;
  return canonicalSerialize(right).localeCompare(canonicalSerialize(left), "en") < 0 ? right : left;
}

function resolvedCalendarEvent(candidates) {
  const ordered = [...candidates].sort((left, right) => canonicalSerialize(left).localeCompare(canonicalSerialize(right), "en"));
  const selected = ordered.reduce((preferred, candidate) => preferredCalendarEvent(preferred, candidate));
  const resolved = { ...selected, values: { ...(selected?.values ?? {}) } };
  const resolveField = (read, write, remove) => {
    const supplied = ordered.map(read).filter(presentValue);
    const distinct = new Set(supplied.map(text));
    if (distinct.size > 1) remove();
    else if (supplied.length) write(supplied[0]);
    else remove();
  };
  resolveField(
    (event) => event?.importance,
    (value) => { resolved.importance = value; },
    () => { delete resolved.importance; },
  );
  for (const key of ["actual", "forecast", "previous"]) {
    resolveField(
      (event) => event?.values?.[key],
      (value) => { resolved.values[key] = value; },
      () => { delete resolved.values[key]; },
    );
  }
  return resolved;
}

export function buildWeeklyCalendarDocument({ now, events } = {}) {
  const shiftedNow = new Date((validDate(now) ?? new Date()).getTime() + 8 * 60 * 60 * 1000);
  const { start, end, endExclusive } = utcWeek(shiftedNow);
  const startLabel = start.toISOString().slice(0, 10);
  const endLabel = end.toISOString().slice(0, 10);
  const duplicateGroups = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const date = eventDate(event);
    if (!date || date < startLabel || date >= endExclusive.toISOString().slice(0, 10)) continue;
    if (!materialIndicatorVariant(event)) continue;
    const scheduled = timedDate(event?.scheduledAt);
    const family = calendarIndicatorFamily(event);
    const key = `${date}\u0000${scheduled?.toISOString() ?? "TBD"}\u0000${normalizedStoryTitle(event?.country ?? event?.asset)}\u0000${family}`;
    if (!duplicateGroups.has(key)) duplicateGroups.set(key, []);
    duplicateGroups.get(key).push(event);
  }
  const grouped = new Map();
  for (const [key, candidates] of [...duplicateGroups.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    const event = resolvedCalendarEvent(candidates);
    if (!importantCalendarEvent(event)) continue;
    const date = key.split("\u0000", 1)[0];
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date).push(calendarEventRecord(event));
  }
  const nowMs = timedDate(now)?.getTime() ?? Date.now();
  const selectionTime = ({ date, event }) => {
    const scheduled = timedDate(event?.scheduledAt)
      ?? (/^\d{2}:\d{2}$/.test(text(event?.time))
        ? timedDate(new Date(`${date}T${event.time}:00.000Z`).getTime() - 8 * 60 * 60 * 1000)
        : timedDate(`${date}T04:00:00.000Z`));
    return scheduled?.getTime() ?? Number.POSITIVE_INFINITY;
  };
  const selectedEventIds = new Set([...grouped.entries()]
    .flatMap(([date, dayEvents]) => dayEvents.map((event) => ({ date, event })))
    .sort((left, right) => {
      const impactDifference = calendarMarketPriority(right.event) - calendarMarketPriority(left.event);
      if (impactDifference) return impactDifference;
      const leftTime = selectionTime(left);
      const rightTime = selectionTime(right);
      const leftUpcoming = leftTime >= nowMs;
      const rightUpcoming = rightTime >= nowMs;
      if (leftUpcoming !== rightUpcoming) return leftUpcoming ? -1 : 1;
      if (leftTime !== rightTime) return leftUpcoming ? leftTime - rightTime : rightTime - leftTime;
      return left.event.id.localeCompare(right.event.id, "en");
    })
    .slice(0, 3)
    .map(({ date, event }) => `${date}\u0000${event.id}`));
  const days = [...grouped.entries()].map(([date, dayEvents]) => {
    const dateValue = new Date(`${date}T00:00:00.000Z`);
    const heading = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(dateValue).toUpperCase().replace(",", " \u00b7");
    return {
      date,
      nodes: [{ type: "heading", text: heading, level: 2 }],
      events: dayEvents.filter((event) => selectedEventIds.has(`${date}\u0000${event.id}`)),
    };
  }).filter((day) => day.events.length);
  const range = `${formatMonthDay(start)}\u2013${end.getUTCMonth() === start.getUTCMonth() ? end.getUTCDate() : formatMonthDay(end)}`;
  const title = `\ud83d\udcc5 Crypto & Macro Calendar \u2014 ${range}`;
  return {
    templateId: "weekly-calendar",
    version: MARKET_CONTENT_TEMPLATE_VERSION,
    generatedAt: isoNow(now),
    weekStart: startLabel,
    weekEnd: endLabel,
    title,
    timezone: "UTC",
    nodes: [{ type: "heading", text: title, level: 1 }, { type: "paragraph", text: "All times UTC" }],
    days,
  };
}

function numericValue(value) {
  const raw = releaseValue(value).replaceAll(",", "");
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

const CROSS_ASSET_REACTION_ORDER = Object.freeze(["BTC", "ETH", "NASDAQ", "DXY", "US2Y"]);

function reactionEntries(reaction) {
  const source = reaction?.prices ?? reaction?.data ?? reaction ?? {};
  return CROSS_ASSET_REACTION_ORDER.flatMap((symbol) => {
    const record = source[symbol];
    if (!record) return [];
    const basisPoints = Number(record.changeBasisPoints);
    if (symbol === "US2Y" && Number.isFinite(basisPoints)) {
      return [{ type: "metric", label: symbol, value: `${basisPoints >= 0 ? "+" : ""}${basisPoints.toFixed(1)}bp` }];
    }
    if (!presentValue(record.changePercent)) return [];
    const number = Number(record.changePercent);
    const formatted = Number.isFinite(number) ? `${number >= 0 ? "+" : ""}${number.toFixed(2)}%` : text(record.changePercent);
    return [{ type: "metric", label: symbol, value: formatted }];
  });
}

function releaseReactionAssessment(impact, reaction) {
  if (impact === "Neutral") return null;
  const source = reaction?.prices ?? reaction?.data ?? reaction ?? {};
  const changes = CROSS_ASSET_REACTION_ORDER.flatMap((symbol) => {
    const value = Number(source?.[symbol]?.changePercent);
    return Number.isFinite(value) ? [{ symbol, value }] : [];
  });
  if (changes.length < 2) return null;
  const expectedSign = (symbol) => impact === "Bullish"
    ? (["DXY", "US2Y"].includes(symbol) ? -1 : 1)
    : (["DXY", "US2Y"].includes(symbol) ? 1 : -1);
  const aligned = changes.filter(({ symbol, value }) => Math.sign(value) === expectedSign(symbol)).length;
  const opposed = changes.filter(({ symbol, value }) => Math.sign(value) === -expectedSign(symbol)).length;
  if (aligned >= 2) {
    return `The measured cross-asset reaction confirms the initial ${impact.toLowerCase()} data signal, but persistence through the confirmation levels is still required.`;
  }
  if (opposed >= 2) {
    return `The measured cross-asset reaction does not confirm the ${impact.toLowerCase()} data signal; concurrent catalysts may be dominating price action.`;
  }
  return `The measured cross-asset reaction is mixed and does not yet confirm the ${impact.toLowerCase()} data signal.`;
}

function releaseSurprise(actual, forecast) {
  const actualNumber = numericValue(actual);
  const forecastNumber = numericValue(forecast);
  if (actualNumber === null || forecastNumber === null) return null;
  const difference = Math.round((actualNumber - forecastNumber) * 100) / 100;
  const suffix = text(actual).includes("%") && text(forecast).includes("%") ? "pp" : "";
  return `${difference > 0 ? "+" : ""}${difference}${suffix}`;
}

export function buildDataReleaseDocument({ event, reaction } = {}) {
  const records = releaseRecords(event);
  if (!records.length || records.some((release) => !RELEASE_INDICATOR_ALLOWLIST.includes(release.indicator))) {
    throw new Error("Data release indicator is not in the release allowlist.");
  }
  const impact = evaluateReleaseImpact(event);
  const reactionAssessment = releaseReactionAssessment(impact.impact, reaction);
  const matchedForecast = records.every((release) => {
    const values = release.values ?? {};
    const actual = numericValue(values.actual ?? release.actual);
    const forecast = numericValue(values.forecast ?? release.forecast);
    return actual !== null && forecast !== null && actual === forecast;
  });
  const verdict = impact.impact === "Bullish"
    ? `${reactionAssessment ? `${reactionAssessment} ` : ""}${impact.explanation}`
    : impact.impact === "Bearish"
      ? `${reactionAssessment ? `${reactionAssessment} ` : ""}${impact.explanation}`
      : matchedForecast
        ? "The release matched the forecast, so the data surprise is neutral. The measured cross-asset move is context, not proof of causality; wait for sustained confirmation before assigning a trading bias."
        : `${impact.explanation} Treat the first move as unconfirmed until cross-asset direction aligns.`;
  const tapeStatus = !reactionAssessment
    ? "Awaiting Confirmation"
    : /mixed/i.test(reactionAssessment)
      ? "Awaiting Confirmation"
      : /does not confirm/i.test(reactionAssessment)
        ? "Divergent"
        : "Confirmed";
  const confirmation = impact.impact === "Bullish"
    ? "BTC and ETH hold above pre-release levels while DXY does not erase the supportive signal."
    : impact.impact === "Bearish"
      ? "BTC and ETH hold below pre-release levels while DXY or rates reinforce the defensive signal."
      : "At least two of BTC, ETH and DXY establish a consistent directional response after the release.";
  const invalidation = "The cross-asset move fades or reverses through pre-release levels, invalidating the initial read.";
  const eventTitle = text(event?.title) || text(records[0]?.title) || records[0].indicator;
  const title = `\ud83d\udea8 ${eventTitle} Released`;
  const nodes = [{ type: "heading", text: title, level: 1 }];
  for (const release of records) {
    nodes.push({ type: "heading", text: text(release.title) || release.indicator, level: 2 });
    const values = release.values ?? {};
    for (const [label, key] of [["Actual", "actual"], ["Consensus", "forecast"], ["Previous", "previous"]]) {
      if (presentValue(values[key] ?? release[key])) nodes.push({ type: "metric", label, value: releaseValue(values[key] ?? release[key]) });
    }
    const surprise = releaseSurprise(values.actual ?? release.actual, values.forecast ?? release.forecast);
    if (surprise) nodes.push({ type: "metric", label: "Surprise vs Forecast", value: surprise });
  }
  nodes.push({ type: "divider" });
  nodes.push({ type: "metric", label: "\ud83d\udcca Initial Data Signal", value: `${IMPACT_DISPLAY[impact.impact]} for Risk Assets` });
  nodes.push({ type: "metric", label: "Tape Verdict", value: tapeStatus });
  nodes.push({ type: "paragraph", text: verdict });
  const reactions = reactionEntries(reaction);
  if (reactions.length) nodes.push({ type: "paragraph", text: "Measured cross-asset reaction from the release benchmark to the latest available observation:" });
  nodes.push(...reactions);
  nodes.push({ type: "metric", label: "Confirmation", value: confirmation });
  nodes.push({ type: "metric", label: "Invalidation", value: invalidation });
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
    tapeStatus,
    verdict,
    confirmation,
    invalidation,
    indicator: records[0].indicator,
    values: { ...(records[0].values ?? {}) },
    source: event?.source ?? null,
    forecastSource: event?.forecastSource ?? null,
    reactionSources: Object.values(reaction?.prices ?? reaction?.data ?? reaction ?? {})
      .map((record) => text(record?.source)).filter(Boolean),
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
  const sections = Array.isArray(document?.decisionSections) && document.decisionSections.length
    ? document.decisionSections
    : document?.sections;
  if (Array.isArray(sections)) {
    for (const section of sections) blocks.push(section.nodes ?? []);
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
