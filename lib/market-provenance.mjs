import { classifyDataReleaseTier } from "./market-impact-ranking.mjs";

const STALE_SCHEDULE_MAX_AGE_SECONDS = 21_600;
const BLOCKING_FIELD_STATUSES = new Set([
  "blocked", "cached", "conflicting", "error", "failed", "invalid", "pending",
  "rejected", "source-conflict", "stale", "timezone-conflict", "unit-conflict",
  "unavailable", "unverified",
]);
const SCHEDULE_STATUS_PRIORITY = [
  "unit-conflict", "conflicting", "timezone-conflict", "source-conflict",
  "rejected", "failed", "error", "invalid", "blocked", "unavailable",
  "unverified", "pending", "stale", "cached",
];

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function missing(value) {
  return !text(value) || /^(?:n\/?a|null|undefined|--?|tbd)$/i.test(text(value));
}

function iso(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function numericUnit(value) {
  const match = text(value).match(/([%KMB])\s*$/i);
  return match ? match[1] : null;
}

function normalizedValue(rawValue, unit) {
  const raw = text(rawValue);
  if (!raw) return null;
  return unit && !raw.endsWith(unit) ? `${raw}${unit}` : raw;
}

function sourceAuthority(input = {}) {
  return text(input.authority ?? input.source?.authority ?? input.source?.type ?? input.source?.kind).toLowerCase() || "auxiliary";
}

function sourceId(input = {}) {
  return input.sourceId ?? input.source?.id ?? null;
}

function sourceUrl(input = {}) {
  return input.sourceUrl ?? input.source?.url ?? input.url ?? null;
}

function httpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(text(value)).protocol);
  } catch {
    return false;
  }
}

function hasCompleteOfficialProvenance(field) {
  return field?.authority === "official"
    && Boolean(text(field.sourceId))
    && httpUrl(field.sourceUrl)
    && iso(field.retrievedAt) !== null
    && iso(field.publishedAt) !== null;
}

function statusOf(input) {
  return text(input?.status).toLowerCase();
}

function explicitVerifiedEvidence(candidates, selected) {
  return candidates.some((candidate) => {
    if (text(candidate?.status).toLowerCase() !== "verified") return false;
    const normalized = normalizeSourcedField(candidate);
    return normalized?.sourceId === selected?.sourceId
      && normalized?.sourceUrl === selected?.sourceUrl
      && canonicalFieldValue(normalized) === canonicalFieldValue(selected);
  });
}

function canonicalFieldValue(field) {
  const value = text(field?.rawValue ?? field?.value).replace(/\s+/g, "");
  const match = value.match(/^([-+]?\d+(?:\.\d+)?)([%KMB])?$/i);
  if (!match) return `${value.toLowerCase()}|${text(field?.unit)}`;
  const number = Number(match[1]);
  return `${Number.isFinite(number) ? number : match[1]}|${text(field?.unit ?? match[2])}`;
}

function withoutComparisons(field) {
  const { comparisons, publishable, ...comparison } = field;
  return comparison;
}

export function normalizeSourcedField(input = {}) {
  if (input === null || input === undefined) return null;
  const rawValue = input.rawValue ?? input.raw ?? input.value ?? null;
  const unit = text(input.unit) || numericUnit(input.value) || numericUnit(rawValue) || null;
  const normalized = normalizedValue(rawValue, unit);
  const comparisons = Array.isArray(input.comparisons)
    ? input.comparisons.map((comparison) => normalizeSourcedField({ ...comparison, comparisons: [] })).filter(Boolean)
    : [];
  return {
    value: normalized,
    rawValue: missing(rawValue) ? null : text(rawValue).replace(new RegExp(`${unit ?? ""}$`), "").trim() || text(rawValue),
    unit,
    status: statusOf(input) || (normalized ? "verified" : "unavailable"),
    authority: sourceAuthority(input),
    sourceId: sourceId(input) === null || sourceId(input) === undefined ? null : String(sourceId(input)),
    sourceUrl: sourceUrl(input) === null || sourceUrl(input) === undefined ? null : String(sourceUrl(input)),
    retrievedAt: iso(input.retrievedAt) ?? null,
    publishedAt: iso(input.publishedAt) ?? null,
    comparisons,
  };
}

export function reconcileSourcedField(candidates = []) {
  const fields = (Array.isArray(candidates) ? candidates : [candidates])
    .map(normalizeSourcedField)
    .filter((field) => field?.value !== null);
  if (!fields.length) return null;

  const official = fields.filter((field) => field.authority === "official");
  const authoritative = official.length ? official : fields;
  const preferred = authoritative[0];
  const units = new Set(fields.map((field) => field.unit ?? ""));
  const officialValues = new Set(official.map(canonicalFieldValue));
  const blockingStatus = ["unit-conflict", "conflicting"]
    .find((candidateStatus) => authoritative.some((field) => field.status === candidateStatus))
    ?? authoritative.find((field) => BLOCKING_FIELD_STATUSES.has(field.status))?.status;
  const status = blockingStatus
    ?? (units.size > 1
    ? "unit-conflict"
    : officialValues.size > 1
      ? "conflicting"
      : preferred.status === "cached"
        ? "cached"
        : "verified");
  return {
    ...preferred,
    status,
    comparisons: fields
      .filter((field) => field !== preferred)
      .map(withoutComparisons),
    publishable: status === "verified",
  };
}

function timezoneUnambiguous(value) {
  const candidate = text(value);
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(candidate) && iso(candidate) !== null;
}

function scheduleCandidates(event) {
  const sources = event?.scheduledAtSources ?? event?.timeSources ?? event?.scheduleSources ?? [];
  const listed = Array.isArray(sources) ? [...sources] : [sources];
  const direct = event?.scheduledAt ?? event?.time ?? event?.dateTime ?? null;
  if (direct !== null && direct !== undefined) {
    listed.push(typeof direct === "object" ? direct : {
      value: direct,
      rawValue: direct,
      authority: event?.source?.authority ?? event?.source?.type ?? event?.source?.kind,
      source: event?.source,
      retrievedAt: event?.retrievedAt,
      publishedAt: event?.publishedAt,
    });
  }
  return listed.filter(Boolean);
}

function reconcileSchedule(event, tier) {
  const candidates = scheduleCandidates(event).map((candidate) => ({
    ...candidate,
    value: candidate.value ?? candidate.scheduledAt ?? candidate.time ?? candidate.rawValue,
    rawValue: candidate.rawValue ?? candidate.value ?? candidate.scheduledAt ?? candidate.time,
  })).filter((candidate) => !missing(candidate.value));
  if (!candidates.length) return { value: null, status: "unavailable", comparisons: [] };
  const official = candidates.filter((candidate) => sourceAuthority(candidate) === "official");
  const authoritative = official.length ? official : candidates;
  const clear = authoritative.filter((candidate) => timezoneUnambiguous(candidate.value));
  const ambiguous = authoritative.find((candidate) => !timezoneUnambiguous(candidate.value));
  const timezoneConflict = (tier === "tier-one" && Boolean(ambiguous)) || !clear.length;
  const timeConflict = new Set(clear.map((candidate) => iso(candidate.value))).size > 1;
  const blocking = SCHEDULE_STATUS_PRIORITY.map((status) => ({
    status,
    candidate: authoritative.find((candidate) => statusOf(candidate) === status),
  })).find(({ candidate }) => candidate);
  const preferred = timezoneConflict ? ambiguous ?? clear[0]
    : timeConflict ? clear[0]
      : blocking?.candidate ?? clear[0] ?? authoritative[0];
  const status = timezoneConflict ? "timezone-conflict"
    : timeConflict ? "conflicting"
      : blocking?.status ?? "verified";
  return {
    value: status === "timezone-conflict" ? null : iso(preferred.value),
    rawValue: text(preferred.rawValue),
    unit: null,
    status,
    authority: sourceAuthority(preferred),
    sourceId: sourceId(preferred),
    sourceUrl: sourceUrl(preferred),
    retrievedAt: iso(preferred.retrievedAt),
    publishedAt: iso(preferred.publishedAt),
    comparisons: candidates.filter((candidate) => candidate !== preferred).map((candidate) => ({
      value: iso(candidate.value), rawValue: text(candidate.rawValue), status: statusOf(candidate) || "verified", authority: sourceAuthority(candidate), sourceId: sourceId(candidate), sourceUrl: sourceUrl(candidate),
    })),
  };
}

function candidatesFor(event, key) {
  const direct = event?.[`${key}Sources`] ?? event?.provenance?.[key] ?? event?.values?.[key] ?? event?.[key] ?? null;
  if (direct === null || direct === undefined) return [];
  if (Array.isArray(direct)) return direct;
  if (typeof direct === "object") return [direct];
  return [{ value: direct, rawValue: event?.rawValues?.[key] ?? direct, unit: event?.rawValues?.unit ?? event?.unit, source: event?.source }];
}

export function reconcileCalendarEvents(events = [], { ranking = {} } = {}) {
  const reconciled = (Array.isArray(events) ? events : []).map((event) => {
    const tierDecision = classifyDataReleaseTier(event, event?.ranking ?? ranking?.[event?.id] ?? ranking);
    const schedule = reconcileSchedule(event, tierDecision.tier);
    const actual = reconcileSourcedField(candidatesFor(event, "actual"));
    const forecast = reconcileSourcedField(candidatesFor(event, "forecast"));
    const previous = reconcileSourcedField(candidatesFor(event, "previous"));
    const publishable = schedule.status === "verified" && actual?.status !== "conflicting" && actual?.status !== "unit-conflict";
    return {
      ...event,
      scheduledAt: schedule.value,
      schedule,
      values: { actual, forecast, previous },
      tierDecision,
      publishable,
    };
  });
  const eligible = reconciled.filter((event) => event.publishable);
  const topThree = [...eligible].sort((left, right) => (
    Number(right.impactScore ?? right.eventImpact ?? 0) - Number(left.impactScore ?? left.eventImpact ?? 0)
    || String(left.scheduledAt).localeCompare(String(right.scheduledAt))
  )).slice(0, 3);
  const counts = reconciled.reduce((total, event) => {
    if (!event.publishable) total.excluded += 1;
    else if (event.schedule.authority === "official") total.verified += 1;
    else total.degraded += 1;
    if (event.schedule.status !== "verified" || event.values.actual?.status === "conflicting") total.conflicting += 1;
    return total;
  }, { verified: 0, degraded: 0, conflicting: 0, excluded: 0 });
  return { events: reconciled, topThree, publishable: topThree.length > 0, reconciliation: counts };
}

export function validateWeeklyPublication(calendar = {}, { now = new Date(), maxAgeSeconds = STALE_SCHEDULE_MAX_AGE_SECONDS } = {}) {
  const source = calendar?.source ?? calendar?.schedule ?? {};
  const sourceStatus = statusOf(source);
  const events = Array.isArray(calendar.events) ? calendar.events : [];
  const nowMs = new Date(now).getTime();
  const retrievedMs = Date.parse(source.retrievedAt ?? calendar.retrievedAt);
  const ageSeconds = Number.isFinite(nowMs) && Number.isFinite(retrievedMs)
    ? Math.floor((nowMs - retrievedMs) / 1000)
    : null;
  const future = ageSeconds !== null && ageSeconds < 0;
  const acceptedCachedEvent = events.some((event) => statusOf(event?.schedule) === "cached")
    && (Boolean(source.cached) || sourceStatus === "cached");
  const stale = Boolean(source.cached) || sourceStatus === "cached" || acceptedCachedEvent || (ageSeconds !== null && ageSeconds > 0);
  const verifiedEvents = events.length > 0 && events.every((event) => (
    (statusOf(event?.schedule) === "verified" || (statusOf(event?.schedule) === "cached" && (Boolean(source.cached) || sourceStatus === "cached")))
    && timezoneUnambiguous(event.schedule.value)
    && hasCompleteOfficialProvenance(event.schedule)
  ));
  const publishable = hasCompleteOfficialProvenance(source)
    && ageSeconds !== null
    && !future
    && (!sourceStatus || sourceStatus === "verified" || sourceStatus === "cached")
    && (!stale || ageSeconds <= maxAgeSeconds)
    && verifiedEvents;
  return {
    publishable,
    freshness: future ? "future" : stale ? "stale" : "fresh",
    ageSeconds,
    reason: publishable ? null : !events.length ? "no-publication-eligible-events" : !hasCompleteOfficialProvenance(source) ? "official-schedule-unavailable" : ageSeconds === null ? "schedule-freshness-unavailable" : future ? "future-schedule" : sourceStatus && sourceStatus !== "verified" && sourceStatus !== "cached" ? "schedule-source-conflict" : ageSeconds > maxAgeSeconds ? "stale-schedule" : "schedule-conflict",
  };
}

function surprise(actual, forecast) {
  if (!actual || !forecast || actual.unit !== forecast.unit) return null;
  const actualNumber = Number(text(actual.rawValue).replace(/[^0-9+-.]/g, ""));
  const forecastNumber = Number(text(forecast.rawValue).replace(/[^0-9+-.]/g, ""));
  if (!Number.isFinite(actualNumber) || !Number.isFinite(forecastNumber)) return null;
  return Math.round((actualNumber - forecastNumber) * 100) / 100;
}

export function validateDataReleasePublication(release = {}) {
  const actualCandidates = release?.actual ? [release.actual] : candidatesFor(release, "actual");
  const actual = release?.actual ? normalizeSourcedField(release.actual) : reconcileSourcedField(actualCandidates);
  const forecast = release?.forecast === null ? null : (release?.forecast ? normalizeSourcedField(release.forecast) : reconcileSourcedField(candidatesFor(release, "forecast")));
  const blockedStatus = actual?.status === "cached" ? "cached-actual" : actual?.status === "conflicting" ? "source-conflict" : actual?.status === "unit-conflict" ? "unit-conflict" : null;
  const returnedForecast = forecast?.status === "verified" ? forecast : null;
  const publishable = Boolean(actual?.value)
    && actual.status === "verified"
    && hasCompleteOfficialProvenance(actual)
    && explicitVerifiedEvidence(actualCandidates, actual);
  return {
    publishable,
    actual: actual ?? null,
    forecast: returnedForecast,
    surprise: surprise(actual, returnedForecast),
    reason: publishable ? null : blockedStatus ?? (!actual?.value ? "official-actual-unavailable" : !hasCompleteOfficialProvenance(actual) || !explicitVerifiedEvidence(actualCandidates, actual) ? "official-actual-provenance-unavailable" : "actual-unavailable"),
  };
}
