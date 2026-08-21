import { classifyDataReleaseTier } from "./market-impact-ranking.mjs";

const STALE_SCHEDULE_MAX_AGE_SECONDS = 21_600;

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
  const match = text(value).match(/(?:^|\s)([%KMB])\s*$/i);
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
    status: text(input.status) || (normalized ? "verified" : "unavailable"),
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
  const preferred = official[0] ?? fields[0];
  const units = new Set(fields.map((field) => field.unit ?? ""));
  const officialValues = new Set(official.map(canonicalFieldValue));
  const status = units.size > 1
    ? "unit-conflict"
    : officialValues.size > 1
      ? "conflicting"
      : preferred.status === "cached"
        ? "cached"
        : "verified";
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
  const listed = Array.isArray(sources) ? sources : [sources];
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
  const timezoneFailures = candidates.filter((candidate) => !timezoneUnambiguous(candidate.value));
  if (tier === "tier-one" && timezoneFailures.length) {
    const conflict = timezoneFailures[0];
    return {
      value: null,
      rawValue: text(conflict.rawValue),
      unit: null,
      status: "timezone-conflict",
      authority: sourceAuthority(conflict),
      sourceId: sourceId(conflict),
      sourceUrl: sourceUrl(conflict),
      retrievedAt: iso(conflict.retrievedAt),
      publishedAt: iso(conflict.publishedAt),
      comparisons: candidates.slice(1).map((candidate) => ({ rawValue: text(candidate.rawValue), value: text(candidate.value) })),
    };
  }
  const clear = candidates.filter((candidate) => timezoneUnambiguous(candidate.value));
  const official = clear.filter((candidate) => sourceAuthority(candidate) === "official");
  const preferred = official[0] ?? clear[0];
  if (!preferred) return { value: null, status: "timezone-conflict", comparisons: [] };
  const officialTimes = new Set(official.map((candidate) => iso(candidate.value)));
  const allTimes = new Set(clear.map((candidate) => iso(candidate.value)));
  const status = officialTimes.size > 1 || (!official.length && allTimes.size > 1) ? "conflicting" : "verified";
  return {
    value: iso(preferred.value),
    rawValue: text(preferred.rawValue),
    unit: null,
    status,
    authority: sourceAuthority(preferred),
    sourceId: sourceId(preferred),
    sourceUrl: sourceUrl(preferred),
    retrievedAt: iso(preferred.retrievedAt),
    publishedAt: iso(preferred.publishedAt),
    comparisons: clear.filter((candidate) => candidate !== preferred).map((candidate) => ({
      value: iso(candidate.value), rawValue: text(candidate.rawValue), authority: sourceAuthority(candidate), sourceId: sourceId(candidate), sourceUrl: sourceUrl(candidate),
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
  const nowMs = new Date(now).getTime();
  const retrievedMs = Date.parse(source.retrievedAt ?? calendar.retrievedAt);
  const ageSeconds = Number.isFinite(nowMs) && Number.isFinite(retrievedMs)
    ? Math.max(0, Math.floor((nowMs - retrievedMs) / 1000))
    : null;
  const stale = Boolean(source.cached) || (ageSeconds !== null && ageSeconds > 0);
  const authority = sourceAuthority(source);
  const events = Array.isArray(calendar.events) ? calendar.events : [];
  const hasScheduleConflict = events.some((event) => event?.schedule?.status && event.schedule.status !== "verified");
  const publishable = authority === "official" && ageSeconds !== null && (!stale || ageSeconds <= maxAgeSeconds) && !hasScheduleConflict;
  return {
    publishable,
    freshness: stale ? "stale" : "fresh",
    ageSeconds,
    reason: publishable ? null : authority !== "official" ? "official-schedule-unavailable" : ageSeconds === null ? "schedule-freshness-unavailable" : ageSeconds > maxAgeSeconds ? "stale-schedule" : "schedule-conflict",
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
  const actual = release?.actual ? normalizeSourcedField(release.actual) : reconcileSourcedField(candidatesFor(release, "actual"));
  const forecast = release?.forecast === null ? null : (release?.forecast ? normalizeSourcedField(release.forecast) : reconcileSourcedField(candidatesFor(release, "forecast")));
  const blockedStatus = actual?.status === "cached" ? "cached-actual" : actual?.status === "conflicting" ? "source-conflict" : actual?.status === "unit-conflict" ? "unit-conflict" : null;
  const publishable = Boolean(actual?.value) && actual.authority === "official" && actual.status === "verified";
  return {
    publishable,
    actual: actual ?? null,
    forecast: forecast?.status === "verified" ? forecast : null,
    surprise: surprise(actual, forecast),
    reason: publishable ? null : blockedStatus ?? (!actual?.value ? "official-actual-unavailable" : actual.authority !== "official" ? "official-actual-unavailable" : "actual-unavailable"),
  };
}
