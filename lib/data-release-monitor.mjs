export const RELEASE_STATE_META_KEY = "market-content:release-state:v1";
export const WEEKLY_CALENDAR_META_KEY = "market-content:weekly-calendar:v1";

const MINUTE_MS = 60_000;
const PRE_RELEASE_WINDOW_MS = 5 * MINUTE_MS;
const POST_RELEASE_WINDOW_MS = 15 * MINUTE_MS;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function instant(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function iso(value) {
  return instant(value)?.toISOString() ?? null;
}

function text(value) {
  return String(value ?? "").trim();
}

function actualValue(event) {
  return event?.values?.actual ?? event?.actual ?? null;
}

function presentActual(event) {
  const value = text(actualValue(event));
  return value && !/^(?:null|undefined|tbd|n\/?a|--?)$/i.test(value) ? value : null;
}

function normalizedActual(event) {
  const components = Array.isArray(event?.components) && event.components.length
    ? event.components
    : null;
  if (components) {
    const values = components
      .map((component) => ({
        id: eventSourceId(component) || text(component?.title),
        value: normalizedActual(component),
      }))
      .filter(({ value }) => value)
      .sort((left, right) => left.id.localeCompare(right.id, "en"));
    return values.length ? values.map(({ id, value }) => `${id}=${value}`).join(";") : null;
  }
  const value = presentActual(event);
  if (!value) return null;
  const compact = value.replaceAll(",", "").replace(/\s+/g, "");
  const numeric = compact.match(/^([+-]?\d+(?:\.\d+)?)(.*)$/);
  if (!numeric) return compact.toLowerCase();
  const number = Number(numeric[1]);
  return Number.isFinite(number) ? `${number}${numeric[2].toUpperCase()}` : compact.toLowerCase();
}

function eventSourceId(event) {
  return text(event?.sourceId ?? event?.eventId ?? event?.event_id ?? event?.id);
}

function eventSchedule(event) {
  return iso(event?.scheduledAt);
}

function eventMonitorKey(event) {
  const id = eventSourceId(event);
  const scheduledAt = eventSchedule(event);
  return id && scheduledAt ? `${id}|${scheduledAt}` : null;
}

function utcWeek(value) {
  const date = instant(value);
  if (!date) throw new TypeError("A valid UTC date is required.");
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = start.getUTCDay();
  start.setUTCDate(start.getUTCDate() - (day === 0 ? 6 : day - 1));
  const end = new Date(start.getTime() + 7 * 24 * 60 * MINUTE_MS);
  return { key: start.toISOString().slice(0, 10), start, end };
}

function emptyState(calendarWeek, now) {
  return {
    calendarWeek,
    monitoredEvents: [],
    publishedKeys: [],
    timedOutKeys: [],
    updatedAt: iso(now),
  };
}

function normalizeState(state, calendarWeek, now) {
  if (!state || state.calendarWeek !== calendarWeek) return emptyState(calendarWeek, now);
  return {
    calendarWeek,
    monitoredEvents: Array.isArray(state.monitoredEvents) ? clone(state.monitoredEvents) : [],
    publishedKeys: [...new Set(Array.isArray(state.publishedKeys) ? state.publishedKeys.map(text).filter(Boolean) : [])],
    timedOutKeys: [...new Set(Array.isArray(state.timedOutKeys) ? state.timedOutKeys.map(text).filter(Boolean) : [])],
    updatedAt: iso(state.updatedAt) ?? iso(now),
  };
}

function adapterEvents(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.events)) return result.events;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.calendar?.events)) return result.calendar.events;
  return [];
}

function adapterWarnings(result) {
  return Array.isArray(result?.warnings) ? result.warnings.map(String) : [];
}

function adapterSoftFailed(result) {
  const sources = Array.isArray(result?.sources) ? result.sources : [];
  if (!sources.length || adapterEvents(result).length) return false;
  return sources.every(({ status }) => ["error", "timeout"].includes(text(status).toLowerCase()));
}

function monitoredRecord(event, previous, now, { acknowledgeActual = true } = {}) {
  const actual = normalizedActual(event);
  return {
    eventKey: eventMonitorKey(event),
    id: eventSourceId(event),
    scheduledAt: eventSchedule(event),
    lastActual: acknowledgeActual ? actual ?? previous?.lastActual ?? null : previous?.lastActual ?? null,
    observedAt: acknowledgeActual
      ? iso(event?.actualObservedAt ?? event?.values?.actualObservedAt ?? event?.observedAt ?? now)
      : previous?.observedAt ?? null,
  };
}

function actualObservationTime(event) {
  return instant(event?.actualObservedAt ?? event?.values?.actualObservedAt ?? event?.observedAt ?? event?.releasedAt);
}

function actualIsStale(event) {
  const observedAt = actualObservationTime(event);
  const scheduledAt = instant(event?.scheduledAt);
  return Boolean(normalizedActual(event) && observedAt && scheduledAt && observedAt < scheduledAt);
}

function stableEvents(events) {
  return [...events].sort((left, right) => {
    const timeDifference = (instant(left?.scheduledAt)?.getTime() ?? Infinity)
      - (instant(right?.scheduledAt)?.getTime() ?? Infinity);
    return timeDifference || eventSourceId(left).localeCompare(eventSourceId(right), "en");
  });
}

function conflictFor(events, now) {
  const groups = new Map();
  for (const event of events) {
    if (releaseWindowStatus(event, now) !== "monitoring") continue;
    const key = eventMonitorKey(event);
    const actual = normalizedActual(event);
    if (!key || !actual) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  for (const [eventKey, candidates] of groups) {
    const distinct = new Set(candidates.map(normalizedActual));
    if (distinct.size < 2) continue;
    const rawValues = candidates
      .map((candidate) => candidate?.rawValues?.actual ?? actualValue(candidate))
      .map((value) => value === null || value === undefined ? null : String(value))
      .sort((left, right) => String(left).localeCompare(String(right), "en"));
    return { eventKey, rawValues, events: clone(candidates) };
  }
  return null;
}

function collapseMatchingEvents(events) {
  const groups = new Map();
  for (const event of stableEvents(events)) {
    const key = eventMonitorKey(event);
    if (!key) continue;
    const previous = groups.get(key);
    if (!previous || (!normalizedActual(previous) && normalizedActual(event))) groups.set(key, event);
  }
  return [...groups.values()];
}

export function buildReleaseDeduplicationKey(event) {
  const id = eventSourceId(event);
  const scheduledAt = eventSchedule(event);
  const actual = normalizedActual(event);
  if (!id || !scheduledAt || !actual) return null;
  return JSON.stringify([id, scheduledAt, actual]);
}

export function releaseWindowStatus(event, now) {
  const scheduledAt = instant(event?.scheduledAt);
  const checkedAt = instant(now);
  if (!scheduledAt || !checkedAt) return "unscheduled";
  const difference = checkedAt.getTime() - scheduledAt.getTime();
  if (difference < -PRE_RELEASE_WINDOW_MS) return "upcoming";
  if (difference <= POST_RELEASE_WINDOW_MS) return "monitoring";
  return "timed-out";
}

export function selectReleasableEvents(events, state, now) {
  const priorMonitored = new Map(
    (Array.isArray(state?.monitoredEvents) ? state.monitoredEvents : [])
      .map((entry) => [entry?.eventKey, entry]),
  );
  const published = new Set(Array.isArray(state?.publishedKeys) ? state.publishedKeys : []);
  const priorTimeouts = new Set(Array.isArray(state?.timedOutKeys) ? state.timedOutKeys : []);
  const timedOutKeys = new Set(priorTimeouts);
  const monitoredEvents = [];
  const releasableEvents = [];
  const candidates = [];

  for (const event of stableEvents(collapseMatchingEvents(Array.isArray(events) ? events : []))) {
    const eventKey = eventMonitorKey(event);
    if (!eventKey) continue;
    const status = releaseWindowStatus(event, now);
    const actual = normalizedActual(event);
    const prior = priorMonitored.get(eventKey);
    if (status === "timed-out") {
      if (!actual || actualIsStale(event)) timedOutKeys.add(eventKey);
      continue;
    }
    if (status === "unscheduled") continue;
    candidates.push(event);
    const scheduledAt = instant(event?.scheduledAt);
    const checkedAt = instant(now);
    const deduplicationKey = buildReleaseDeduplicationKey(event);
    const releasable = status === "monitoring" && actual && scheduledAt && checkedAt
      && checkedAt >= scheduledAt && !actualIsStale(event)
      && !published.has(deduplicationKey) && prior?.lastActual !== actual;
    monitoredEvents.push(monitoredRecord(event, prior, now, { acknowledgeActual: !releasable }));
    if (releasable) releasableEvents.push(event);
  }

  const releasableKeys = new Set(releasableEvents.map(eventMonitorKey));
  const nextMonitoredEvent = candidates.find((event) => {
    const key = buildReleaseDeduplicationKey(event);
    return !releasableKeys.has(eventMonitorKey(event)) && (!key || !published.has(key));
  }) ?? null;
  return {
    releasableEvents,
    monitoredEvents,
    timedOutKeys: [...timedOutKeys].sort(),
    newlyTimedOutKeys: [...timedOutKeys].filter((key) => !priorTimeouts.has(key)).sort(),
    nextMonitoredEvent,
  };
}

export async function cacheWeeklyCalendar(repository, calendar, { persist = true } = {}) {
  const saved = clone(calendar);
  if (persist) {
    if (!repository || typeof repository.setMeta !== "function") {
      throw new TypeError("repository with setMeta is required when persist is true");
    }
    await repository.setMeta(WEEKLY_CALENDAR_META_KEY, saved);
  }
  return saved;
}

export async function pollDataReleaseUpdates(options = {}) {
  const {
    now = new Date(),
    repository,
    fetchCalendar,
    fetchReaction,
    persist = true,
  } = options;
  if (!repository || typeof repository.getMeta !== "function") {
    throw new TypeError("repository with getMeta is required");
  }
  if (persist && typeof repository.setMeta !== "function") {
    throw new TypeError("repository with setMeta is required when persist is true");
  }
  const checkedAt = instant(now);
  if (!checkedAt) throw new TypeError("now must be a valid date");
  const checkedAtIso = checkedAt.toISOString();
  const week = utcWeek(checkedAt);
  const [storedCalendar, storedState] = await Promise.all([
    repository.getMeta(WEEKLY_CALENDAR_META_KEY),
    repository.getMeta(RELEASE_STATE_META_KEY),
  ]);
  const state = normalizeState(storedState, week.key, checkedAt);
  const previousUpdate = storedState?.calendarWeek === week.key ? instant(storedState.updatedAt) : null;
  if (previousUpdate && checkedAt.getTime() - previousUpdate.getTime() < MINUTE_MS) {
    return {
      publishable: false,
      skipReason: "poll-interval",
      warnings: [],
      nextMonitoredEvent: null,
    };
  }

  const warnings = [];
  const cacheStale = !storedCalendar || storedCalendar.calendarWeek !== week.key;
  const cachedEvents = adapterEvents(storedCalendar);
  let fetchResult = null;
  if (cacheStale) {
    if (typeof fetchCalendar !== "function") {
      return { publishable: false, skipReason: "calendar-unavailable", warnings: ["Weekly calendar bootstrap could not run: calendar adapter is unavailable."], nextMonitoredEvent: null };
    }
    try {
      fetchResult = await fetchCalendar({ from: week.start.toISOString(), to: week.end.toISOString(), now: checkedAtIso });
    } catch (error) {
      return {
        publishable: false,
        skipReason: "calendar-unavailable",
        warnings: [`Weekly calendar bootstrap failed: ${error?.message ?? String(error)}`],
        nextMonitoredEvent: null,
      };
    }
    warnings.push(...adapterWarnings(fetchResult));
    if (adapterSoftFailed(fetchResult)) {
      return {
        publishable: false,
        skipReason: "calendar-unavailable",
        warnings,
        sources: clone(fetchResult?.sources ?? []),
        nextMonitoredEvent: null,
      };
    }
    warnings.push("Weekly calendar cache was absent or stale; bootstrap refresh completed.");
    await cacheWeeklyCalendar(repository, {
      calendarWeek: week.key,
      events: clone(adapterEvents(fetchResult)),
      sources: clone(fetchResult?.sources ?? []),
      updatedAt: checkedAtIso,
    }, { persist });
  }

  const inReleaseWindow = cachedEvents.some((event) => releaseWindowStatus(event, checkedAt) === "monitoring");
  if (!fetchResult && inReleaseWindow && typeof fetchCalendar === "function") {
    try {
      fetchResult = await fetchCalendar({ from: week.start.toISOString(), to: week.end.toISOString(), now: checkedAtIso });
    } catch (error) {
      return {
        publishable: false,
        skipReason: "calendar-unavailable",
        warnings: [`Live calendar refresh failed: ${error?.message ?? String(error)}`],
        sources: clone(storedCalendar?.sources ?? []),
        nextMonitoredEvent: clone(cachedEvents.find((event) => releaseWindowStatus(event, checkedAt) === "monitoring") ?? null),
      };
    }
    warnings.push(...adapterWarnings(fetchResult));
    if (adapterSoftFailed(fetchResult)) {
      return {
        publishable: false,
        skipReason: "calendar-unavailable",
        warnings,
        sources: clone(fetchResult?.sources ?? []),
        nextMonitoredEvent: clone(cachedEvents.find((event) => releaseWindowStatus(event, checkedAt) === "monitoring") ?? null),
      };
    }
  }
  const liveEvents = fetchResult ? adapterEvents(fetchResult) : adapterEvents(storedCalendar);
  if (!fetchResult && inReleaseWindow) warnings.push("Live calendar adapter was unavailable; cached schedule was used.");

  const conflict = conflictFor(liveEvents, checkedAt);
  const selected = selectReleasableEvents(liveEvents, state, checkedAt);
  const nextState = {
    calendarWeek: week.key,
    monitoredEvents: selected.monitoredEvents,
    publishedKeys: [...state.publishedKeys],
    timedOutKeys: selected.timedOutKeys,
    updatedAt: checkedAtIso,
  };
  const saveState = async () => {
    if (persist) await repository.setMeta(RELEASE_STATE_META_KEY, nextState);
  };

  if (conflict) {
    await saveState();
    return {
      publishable: false,
      skipReason: "source-conflict",
      conflict,
      warnings,
      nextMonitoredEvent: selected.nextMonitoredEvent,
    };
  }

  const stale = liveEvents.find((event) => releaseWindowStatus(event, checkedAt) === "monitoring" && actualIsStale(event));
  if (stale) {
    await saveState();
    return {
      publishable: false,
      skipReason: "stale-actual",
      event: clone(stale),
      warnings,
      nextMonitoredEvent: selected.nextMonitoredEvent,
    };
  }

  const event = selected.releasableEvents[0] ?? null;
  if (event) {
    const deduplicationKey = buildReleaseDeduplicationKey(event);
    let reaction = null;
    if (typeof fetchReaction === "function") {
      try {
        reaction = await fetchReaction({ event: clone(event), now: checkedAtIso });
      } catch (error) {
        warnings.push(`Market reaction unavailable: ${error?.message ?? String(error)}`);
      }
    }
    nextState.publishedKeys = [...new Set([...state.publishedKeys, deduplicationKey])];
    const publishedRecord = nextState.monitoredEvents.find(({ eventKey }) => eventKey === eventMonitorKey(event));
    if (publishedRecord) {
      publishedRecord.lastActual = normalizedActual(event);
      publishedRecord.observedAt = iso(
        event?.actualObservedAt ?? event?.values?.actualObservedAt ?? event?.observedAt ?? checkedAt,
      );
    }
    await saveState();
    return {
      publishable: true,
      event: clone(event),
      reaction: clone(reaction),
      deduplicationKey,
      warnings,
      nextMonitoredEvent: clone(selected.releasableEvents[1] ?? selected.nextMonitoredEvent),
      sources: clone(fetchResult?.sources ?? storedCalendar?.sources ?? []),
    };
  }

  const duplicate = stableEvents(liveEvents).find((candidate) => {
    if (releaseWindowStatus(candidate, checkedAt) !== "monitoring") return false;
    const key = buildReleaseDeduplicationKey(candidate);
    return key && state.publishedKeys.includes(key);
  });
  if (duplicate) {
    await saveState();
    return {
      publishable: false,
      skipReason: "duplicate-release",
      deduplicationKey: buildReleaseDeduplicationKey(duplicate),
      warnings,
      nextMonitoredEvent: selected.nextMonitoredEvent,
    };
  }

  await saveState();
  const hasActualInWindow = liveEvents.some((candidate) => (
    releaseWindowStatus(candidate, checkedAt) === "monitoring" && normalizedActual(candidate)
  ));
  return {
    publishable: false,
    skipReason: selected.newlyTimedOutKeys.length
      ? "release-timeout"
      : hasActualInWindow ? "stale-actual" : selected.nextMonitoredEvent ? "actual-unavailable" : "no-monitored-event",
    warnings,
    nextMonitoredEvent: clone(selected.nextMonitoredEvent),
  };
}
