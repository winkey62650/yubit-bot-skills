import { randomUUID } from "node:crypto";

export const RELEASE_STATE_META_KEY = "market-content:release-state:v1";
export const WEEKLY_CALENDAR_META_KEY = "market-content:weekly-calendar:v1";
export const DATA_RELEASE_DELIVERY_META_KEY = "market-content:release-delivery:v1";

const MINUTE_MS = 60_000;
const PRE_RELEASE_WINDOW_MS = 5 * MINUTE_MS;
const POST_RELEASE_WINDOW_MS = 15 * MINUTE_MS;
const CALENDAR_CACHE_TTL_MS = 6 * 60 * MINUTE_MS;
const repositoryPollLocks = new WeakMap();
const repositoryReceiptLocks = new WeakMap();
const repositoryRunLocks = new WeakMap();
const RELEASE_STATE_LEASE_KEY = "market-content:release-state-lock:v1";
const RELEASE_RECEIPT_LEASE_KEY = "market-content:release-delivery-lock:v1";
const RELEASE_RUN_LEASE_KEY = "market-content:release-run-lock:v1";
const META_LEASE_MS = 2 * 60_000;
const DELIVERY_RECEIPT_MAX_ENTRIES = 100;
const DELIVERY_RECEIPT_TTL_MS = 14 * 24 * 60 * 60_000;

function withMemoryLock(locks, repository, operation) {
  if ((typeof repository !== "object" && typeof repository !== "function") || repository === null) {
    return operation();
  }
  const previous = locks.get(repository) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  locks.set(repository, current);
  return current.finally(() => {
    if (locks.get(repository) === current) locks.delete(repository);
  });
}

async function withMetaLease(repository, key, locks, nowValue, operation) {
  if (!repository?.acquireMetaLease || !repository?.releaseMetaLease) {
    return withMemoryLock(locks, repository, operation);
  }
  const now = instant(nowValue) ?? new Date();
  const lease = { leaseId: randomUUID(), leaseUntil: new Date(now.getTime() + META_LEASE_MS).toISOString() };
  let acquired = null;
  for (let attempt = 0; attempt < 100 && !acquired; attempt += 1) {
    acquired = await repository.acquireMetaLease(key, lease, now);
    if (!acquired) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (!acquired) throw new Error(`DATA_RELEASE_LEASE_BUSY:${key}`);
  try {
    return await operation();
  } finally {
    await repository.releaseMetaLease(key, lease.leaseId);
  }
}

function withRepositoryPollLock(repository, now, operation) {
  return withMetaLease(repository, RELEASE_STATE_LEASE_KEY, repositoryPollLocks, now, operation);
}

function withRepositoryReceiptLock(repository, now, operation) {
  return withMetaLease(repository, RELEASE_RECEIPT_LEASE_KEY, repositoryReceiptLocks, now, operation);
}

export function withDataReleaseRunLease({ repository, now = new Date(), operation } = {}) {
  if (typeof operation !== "function") throw new TypeError("operation is required");
  return withMetaLease(repository, RELEASE_RUN_LEASE_KEY, repositoryRunLocks, now, operation);
}

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

export function buildDataReleaseTargetKey(target = {}) {
  if (target?.platform === "discord" || (target?.guildId && target?.channelId)) {
    const guildId = text(target.guildId);
    const channelId = text(target.channelId);
    return guildId && channelId ? `discord:${guildId}:${channelId}` : "";
  }
  const chatId = text(target.chatId);
  if (!chatId) return "";
  if (target?.chatType === "channel") return `telegram:${chatId}:channel`;
  const threadId = Number(target.threadId);
  return Number.isInteger(threadId) && threadId > 0 ? `telegram:${chatId}:${threadId}` : "";
}

function normalizeDeliveryStore(value, now) {
  const cutoff = now.getTime() - DELIVERY_RECEIPT_TTL_MS;
  const entries = Array.isArray(value?.entries) ? value.entries : [];
  return {
    version: 1,
    entries: entries
      .filter((entry) => text(entry?.deduplicationKey) && (Date.parse(entry?.updatedAt || "") >= cutoff))
      .slice(-DELIVERY_RECEIPT_MAX_ENTRIES)
      .map((entry) => ({
        deduplicationKey: text(entry.deduplicationKey),
        event: clone(entry.event) ?? null,
        expectedTargetKeys: [...new Set((entry.expectedTargetKeys || []).map(text).filter(Boolean))],
        targets: Object.fromEntries(Object.entries(entry.targets || {}).map(([key, record]) => [key, {
          status: ["ready", "pending", "success"].includes(record?.status) ? record.status : "ready",
          updatedAt: iso(record?.updatedAt) ?? now.toISOString(),
        }])),
        createdAt: iso(entry.createdAt) ?? now.toISOString(),
        updatedAt: iso(entry.updatedAt) ?? now.toISOString(),
      })),
    updatedAt: iso(value?.updatedAt) ?? now.toISOString(),
  };
}

function deliverySnapshot(entry) {
  const successfulTargetKeys = entry.expectedTargetKeys.filter((key) => entry.targets[key]?.status === "success");
  const pendingTargetKeys = entry.expectedTargetKeys.filter((key) => entry.targets[key]?.status === "pending");
  const readyTargetKeys = entry.expectedTargetKeys.filter((key) => !["success", "pending"].includes(entry.targets[key]?.status));
  return {
    deduplicationKey: entry.deduplicationKey,
    event: clone(entry.event),
    expectedTargetKeys: [...entry.expectedTargetKeys],
    successfulTargetKeys,
    pendingTargetKeys,
    readyTargetKeys,
    complete: entry.expectedTargetKeys.length > 0 && successfulTargetKeys.length === entry.expectedTargetKeys.length,
  };
}

async function mutateDeliveryReceipt(repository, deduplicationKey, event, nowValue, mutate) {
  if (!repository || typeof repository.getMeta !== "function" || typeof repository.setMeta !== "function") {
    throw new TypeError("repository with getMeta and setMeta is required");
  }
  const now = instant(nowValue);
  if (!now) throw new TypeError("now must be a valid date");
  if (event && buildReleaseDeduplicationKey(event) !== deduplicationKey) throw new TypeError("event does not match deduplicationKey");
  const store = normalizeDeliveryStore(await repository.getMeta(DATA_RELEASE_DELIVERY_META_KEY), now);
  let entry = store.entries.find((item) => item.deduplicationKey === deduplicationKey);
  if (!entry) {
    entry = { deduplicationKey, event: clone(event) ?? null, expectedTargetKeys: [], targets: {}, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    store.entries.push(entry);
  }
  if (event && !entry.event) entry.event = clone(event);
  mutate(entry, now);
  entry.updatedAt = now.toISOString();
  store.updatedAt = now.toISOString();
  store.entries = store.entries.slice(-DELIVERY_RECEIPT_MAX_ENTRIES);
  await repository.setMeta(DATA_RELEASE_DELIVERY_META_KEY, store);
  return deliverySnapshot(entry);
}

export function prepareDataReleaseDelivery({ repository, deduplicationKey, event, targetKeys = [], now = new Date() } = {}) {
  return withRepositoryReceiptLock(repository, now, () => mutateDeliveryReceipt(repository, deduplicationKey, event, now, (entry, stamp) => {
    const normalized = [...new Set(targetKeys.map(text).filter(Boolean))];
    if (!entry.expectedTargetKeys.length) entry.expectedTargetKeys = normalized;
    for (const key of entry.expectedTargetKeys) entry.targets[key] ||= { status: "ready", updatedAt: stamp.toISOString() };
  }));
}

export function markDataReleaseTargetPending({ repository, deduplicationKey, targetKey, event, now = new Date() } = {}) {
  return withRepositoryReceiptLock(repository, now, () => mutateDeliveryReceipt(repository, deduplicationKey, event, now, (entry, stamp) => {
    if (!entry.expectedTargetKeys.includes(targetKey)) throw new Error("release target is not expected");
    if (entry.targets[targetKey]?.status !== "success") entry.targets[targetKey] = { status: "pending", updatedAt: stamp.toISOString() };
  }));
}

export function releaseDataReleaseTargetClaim({ repository, deduplicationKey, targetKey, event, now = new Date() } = {}) {
  return withRepositoryReceiptLock(repository, now, () => mutateDeliveryReceipt(repository, deduplicationKey, event, now, (entry, stamp) => {
    if (entry.targets[targetKey]?.status === "pending") entry.targets[targetKey] = { status: "ready", updatedAt: stamp.toISOString() };
  }));
}

export function acknowledgeDataReleaseTarget({ repository, deduplicationKey, targetKey, event, now = new Date() } = {}) {
  return withRepositoryReceiptLock(repository, now, () => mutateDeliveryReceipt(repository, deduplicationKey, event, now, (entry, stamp) => {
    if (!entry.expectedTargetKeys.includes(targetKey)) throw new Error("release target is not expected");
    entry.targets[targetKey] = { status: "success", updatedAt: stamp.toISOString() };
  }));
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
        required: component?.required !== false,
      }));
    if (values.some(({ required, value }) => required && !value)) return null;
    const presentValues = values
      .filter(({ value }) => value)
      .sort((left, right) => left.id.localeCompare(right.id, "en"));
    return presentValues.length
      ? presentValues.map(({ id, value }) => `${id}=${value}`).join(";")
      : null;
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

function publishedEventMonitorKeys(publishedKeys) {
  const keys = new Set();
  for (const key of Array.isArray(publishedKeys) ? publishedKeys : []) {
    try {
      const [id, scheduledAt] = JSON.parse(key);
      const normalizedSchedule = iso(scheduledAt);
      if (text(id) && normalizedSchedule) keys.add(`${text(id)}|${normalizedSchedule}`);
    } catch {
      // Ignore legacy or malformed deduplication entries.
    }
  }
  return keys;
}

function mergeMonitoringCalendarEvents(freshEvents, cachedEvents, now) {
  const fresh = Array.isArray(freshEvents) ? freshEvents : [];
  const freshKeys = new Set(fresh.map(eventMonitorKey).filter(Boolean));
  const retained = (Array.isArray(cachedEvents) ? cachedEvents : []).filter((event) => {
    const key = eventMonitorKey(event);
    return key && !freshKeys.has(key) && releaseWindowStatus(event, now) === "monitoring";
  });
  return stableEvents([...fresh, ...retained]);
}

function rawActualValue(event) {
  if (Array.isArray(event?.components) && event.components.length) {
    return event.components.map((component) => ({
      id: eventSourceId(component) || text(component?.title),
      actual: clone(component?.rawValues?.actual ?? actualValue(component)),
    }));
  }
  const value = event?.rawValues?.actual ?? actualValue(event);
  return value === null || value === undefined ? null : String(value);
}

function conflictsFor(events, now) {
  const groups = new Map();
  const conflicts = [];
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
    const rawValues = candidates.map(rawActualValue);
    if (rawValues.every((value) => typeof value === "string" || value === null)) {
      rawValues.sort((left, right) => String(left).localeCompare(String(right), "en"));
    }
    conflicts.push({ eventKey, rawValues, events: clone(candidates) });
  }
  return conflicts;
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
  const publishedEventKeys = publishedEventMonitorKeys(state?.publishedKeys);
  const priorTimeouts = new Set(Array.isArray(state?.timedOutKeys) ? state.timedOutKeys : []);
  const timedOutKeys = new Set(priorTimeouts);
  const monitoredEvents = [];
  const releasableEvents = [];
  const candidates = [];
  const seenEventKeys = new Set();

  for (const event of stableEvents(collapseMatchingEvents(Array.isArray(events) ? events : []))) {
    const eventKey = eventMonitorKey(event);
    if (!eventKey) continue;
    seenEventKeys.add(eventKey);
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

  for (const previous of priorMonitored.values()) {
    if (!previous?.eventKey || seenEventKeys.has(previous.eventKey)) continue;
    const status = releaseWindowStatus(previous, now);
    if (status === "monitoring") {
      monitoredEvents.push(clone(previous));
    } else if (status === "timed-out" && !publishedEventKeys.has(previous.eventKey)) {
      timedOutKeys.add(previous.eventKey);
    }
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

async function pollDataReleaseUpdatesUnlocked(options = {}) {
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
  if (persist && previousUpdate && checkedAt.getTime() - previousUpdate.getTime() < MINUTE_MS) {
    return {
      publishable: false,
      skipReason: "poll-interval",
      warnings: [],
      nextMonitoredEvent: null,
    };
  }
  const saveFailedCheck = async () => {
    if (!persist) return;
    await repository.setMeta(RELEASE_STATE_META_KEY, {
      ...state,
      updatedAt: checkedAtIso,
    });
  };

  const warnings = [];
  const cacheUpdatedAt = instant(storedCalendar?.updatedAt);
  const cacheStale = !storedCalendar
    || storedCalendar.calendarWeek !== week.key
    || !cacheUpdatedAt
    || checkedAt.getTime() - cacheUpdatedAt.getTime() >= CALENDAR_CACHE_TTL_MS;
  const cachedEvents = adapterEvents(storedCalendar);
  let fetchResult = null;
  let refreshedCacheEvents = null;
  if (cacheStale) {
    if (typeof fetchCalendar !== "function") {
      await saveFailedCheck();
      return { publishable: false, skipReason: "calendar-unavailable", warnings: ["Weekly calendar bootstrap could not run: calendar adapter is unavailable."], nextMonitoredEvent: null };
    }
    try {
      fetchResult = await fetchCalendar({ from: week.start.toISOString(), to: week.end.toISOString(), now: checkedAtIso });
    } catch (error) {
      await saveFailedCheck();
      return {
        publishable: false,
        skipReason: "calendar-unavailable",
        warnings: [`Weekly calendar bootstrap failed: ${error?.message ?? String(error)}`],
        nextMonitoredEvent: null,
      };
    }
    warnings.push(...adapterWarnings(fetchResult));
    if (adapterSoftFailed(fetchResult)) {
      await saveFailedCheck();
      return {
        publishable: false,
        skipReason: "calendar-unavailable",
        warnings,
        sources: clone(fetchResult?.sources ?? []),
        nextMonitoredEvent: null,
      };
    }
    warnings.push("Weekly calendar cache was absent or stale; bootstrap refresh completed.");
    const sameWeekCachedEvents = storedCalendar?.calendarWeek === week.key ? cachedEvents : [];
    refreshedCacheEvents = mergeMonitoringCalendarEvents(
      adapterEvents(fetchResult), sameWeekCachedEvents, checkedAt,
    );
    await cacheWeeklyCalendar(repository, {
      calendarWeek: week.key,
      events: clone(refreshedCacheEvents),
      sources: clone(fetchResult?.sources ?? []),
      updatedAt: checkedAtIso,
    }, { persist });
  }

  const inReleaseWindow = cachedEvents.some((event) => releaseWindowStatus(event, checkedAt) === "monitoring");
  if (!fetchResult && inReleaseWindow && typeof fetchCalendar === "function") {
    try {
      fetchResult = await fetchCalendar({ from: week.start.toISOString(), to: week.end.toISOString(), now: checkedAtIso });
    } catch (error) {
      await saveFailedCheck();
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
      await saveFailedCheck();
      return {
        publishable: false,
        skipReason: "calendar-unavailable",
        warnings,
        sources: clone(fetchResult?.sources ?? []),
        nextMonitoredEvent: clone(cachedEvents.find((event) => releaseWindowStatus(event, checkedAt) === "monitoring") ?? null),
      };
    }
  }
  const liveEvents = refreshedCacheEvents
    ?? (fetchResult ? adapterEvents(fetchResult) : adapterEvents(storedCalendar));
  if (!fetchResult && inReleaseWindow) warnings.push("Live calendar adapter was unavailable; cached schedule was used.");

  const conflicts = conflictsFor(liveEvents, checkedAt);
  const conflictedEventKeys = new Set(conflicts.map(({ eventKey }) => eventKey));
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

  const publishableEvents = selected.releasableEvents.filter(
    (candidate) => !conflictedEventKeys.has(eventMonitorKey(candidate)),
  );
  const selectedEvent = publishableEvents[0] ?? null;
  if (selectedEvent) {
    const event = {
      ...selectedEvent,
      actualObservedAt: iso(selectedEvent.actualObservedAt ?? selectedEvent.values?.actualObservedAt ?? selectedEvent.observedAt) ?? checkedAtIso,
    };
    const deduplicationKey = buildReleaseDeduplicationKey(event);
    let reaction = null;
    if (typeof fetchReaction === "function") {
      try {
        reaction = await fetchReaction({ event: clone(event), now: checkedAtIso });
      } catch (error) {
        warnings.push(`Market reaction unavailable: ${error?.message ?? String(error)}`);
      }
    }
    await saveState();
    return {
      publishable: true,
      event: clone(event),
      reaction: clone(reaction),
      deduplicationKey,
      warnings,
      nextMonitoredEvent: clone(publishableEvents[1] ?? selected.nextMonitoredEvent),
      sources: clone(fetchResult?.sources ?? storedCalendar?.sources ?? []),
    };
  }

  const conflict = conflicts[0] ?? null;
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

  const stale = liveEvents.find((candidate) => (
    releaseWindowStatus(candidate, checkedAt) === "monitoring" && actualIsStale(candidate)
  ));
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

export function pollDataReleaseUpdates(options = {}) {
  const repository = options?.repository;
  return withRepositoryPollLock(repository, options.now, () => pollDataReleaseUpdatesUnlocked(options));
}

async function acknowledgeDataReleasePublishedUnlocked(options = {}) {
  const { repository, deduplicationKey, event, now = new Date() } = options;
  if (!repository || typeof repository.getMeta !== "function" || typeof repository.setMeta !== "function") {
    throw new TypeError("repository with getMeta and setMeta is required");
  }
  const acknowledgedAt = instant(now);
  if (!acknowledgedAt) throw new TypeError("now must be a valid date");
  let identity;
  try {
    identity = JSON.parse(String(deduplicationKey));
  } catch {
    identity = null;
  }
  if (!Array.isArray(identity) || identity.length !== 3 || !text(identity[0]) || !iso(identity[1]) || !text(identity[2])) {
    throw new TypeError("deduplicationKey must be a valid release key");
  }
  if (event && buildReleaseDeduplicationKey(event) !== deduplicationKey) {
    throw new TypeError("event does not match deduplicationKey");
  }
  const storedState = await repository.getMeta(RELEASE_STATE_META_KEY);
  if (!storedState) throw new Error("release state is unavailable for acknowledgement");
  const calendarWeek = text(storedState.calendarWeek);
  if (!calendarWeek) throw new Error("release state calendar week is unavailable for acknowledgement");
  const state = normalizeState(storedState, calendarWeek, acknowledgedAt);
  const alreadyAcknowledged = state.publishedKeys.includes(deduplicationKey);
  const eventKey = `${text(identity[0])}|${iso(identity[1])}`;
  const monitored = state.monitoredEvents.find((record) => record.eventKey === eventKey);
  if (monitored) {
    monitored.lastActual = text(identity[2]);
    monitored.observedAt = iso(
      event?.actualObservedAt ?? event?.values?.actualObservedAt ?? event?.observedAt ?? acknowledgedAt,
    );
  }
  state.publishedKeys = [...new Set([...state.publishedKeys, deduplicationKey])];
  await repository.setMeta(RELEASE_STATE_META_KEY, state);
  return { acknowledged: !alreadyAcknowledged, deduplicationKey };
}

export function acknowledgeDataReleasePublished(options = {}) {
  const repository = options?.repository;
  return withRepositoryPollLock(repository, options.now, () => acknowledgeDataReleasePublishedUnlocked(options));
}
