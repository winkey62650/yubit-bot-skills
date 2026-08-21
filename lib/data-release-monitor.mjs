import { randomUUID } from "node:crypto";
import { fetchOfficialActual as fetchOfficialActualDefault } from "./market-official-releases.mjs";
import { reconcileSourcedField, validateDataReleasePublication } from "./market-provenance.mjs";

export const RELEASE_STATE_META_KEY = "market-content:release-state:v1";
export const WEEKLY_CALENDAR_META_KEY = "market-content:weekly-calendar:v1";
export const DATA_RELEASE_DELIVERY_META_KEY = "market-content:release-delivery:v1";
export const DATA_RELEASE_SENT_META_KEY = "market-content:release-sent:v1";

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

async function withMetaLease(repository, key, locks, nowValue, operation, options = {}) {
  if (!repository?.acquireMetaLease || !repository?.releaseMetaLease) {
    return withMemoryLock(locks, repository, () => operation({ assertOwned: async () => true }));
  }
  const clock = typeof options.clock === "function" ? options.clock : () => new Date();
  const leaseTtlMs = Math.max(10, Number(options.leaseTtlMs) || META_LEASE_MS);
  const heartbeatMs = Math.max(2, Math.min(leaseTtlMs / 2, Number(options.heartbeatMs) || leaseTtlMs / 3));
  const initialNow = instant(clock()) ?? instant(nowValue) ?? new Date();
  const lease = { leaseId: randomUUID(), leaseUntil: new Date(initialNow.getTime() + leaseTtlMs).toISOString() };
  let acquired = null;
  for (let attempt = 0; attempt < 100 && !acquired; attempt += 1) {
    acquired = await repository.acquireMetaLease(key, lease, instant(clock()) ?? new Date());
    if (!acquired) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (!acquired) throw new Error(`DATA_RELEASE_LEASE_BUSY:${key}`);
  let renewal = Promise.resolve();
  let lost = null;
  const renew = async () => {
    if (!repository.renewMetaLease) return;
    const leaseUntil = new Date((instant(clock()) ?? new Date()).getTime() + leaseTtlMs).toISOString();
    const renewed = await repository.renewMetaLease(key, lease.leaseId, leaseUntil);
    if (!renewed) throw new Error(`DATA_RELEASE_LEASE_LOST:${key}`);
    lease.leaseUntil = renewed.leaseUntil ?? leaseUntil;
  };
  const scheduleRenewal = () => {
    renewal = renewal.then(renew).catch((error) => { lost ||= error; });
  };
  const timer = options.heartbeat === true || options.heartbeatMs || options.leaseTtlMs
    ? setInterval(scheduleRenewal, heartbeatMs)
    : null;
  timer?.unref?.();
  const assertOwned = async () => {
    await renewal;
    if (lost) throw lost;
    if (repository.getMetaLease) {
      const current = await repository.getMetaLease(key);
      const stamp = instant(clock()) ?? new Date();
      if (current?.leaseId !== lease.leaseId || Date.parse(current?.leaseUntil || "") <= stamp.getTime()) {
        throw new Error(`DATA_RELEASE_LEASE_LOST:${key}`);
      }
    }
    return true;
  };
  try {
    return await operation({ assertOwned, leaseId: lease.leaseId });
  } finally {
    if (timer) clearInterval(timer);
    await renewal;
    await repository.releaseMetaLease(key, lease.leaseId);
  }
}

function withRepositoryPollLock(repository, now, operation) {
  return withMetaLease(repository, RELEASE_STATE_LEASE_KEY, repositoryPollLocks, now, operation);
}

function withRepositoryReceiptLock(repository, now, operation) {
  return withMetaLease(repository, RELEASE_RECEIPT_LEASE_KEY, repositoryReceiptLocks, now, operation);
}

export function withDataReleaseRunLease({ repository, now = new Date(), operation, leaseTtlMs, heartbeatMs, clock } = {}) {
  if (typeof operation !== "function") throw new TypeError("operation is required");
  return withMetaLease(repository, RELEASE_RUN_LEASE_KEY, repositoryRunLocks, now, operation, {
    heartbeat: true, leaseTtlMs, heartbeatMs, clock,
  });
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
          ...(text(record?.claimToken) ? { claimToken: text(record.claimToken) } : {}),
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

export function markDataReleaseTargetPending({ repository, deduplicationKey, targetKey, event, claimToken, now = new Date() } = {}) {
  return withRepositoryReceiptLock(repository, now, () => mutateDeliveryReceipt(repository, deduplicationKey, event, now, (entry, stamp) => {
    if (!entry.expectedTargetKeys.includes(targetKey)) throw new Error("release target is not expected");
    if (entry.targets[targetKey]?.status !== "success") entry.targets[targetKey] = {
      status: "pending",
      updatedAt: stamp.toISOString(),
      ...(text(claimToken) ? { claimToken: text(claimToken) } : {}),
    };
  }));
}

export function releaseDataReleaseTargetClaim({ repository, deduplicationKey, targetKey, event, claimToken, now = new Date() } = {}) {
  return withRepositoryReceiptLock(repository, now, () => mutateDeliveryReceipt(repository, deduplicationKey, event, now, (entry, stamp) => {
    const current = entry.targets[targetKey];
    if (current?.status === "pending" && (!current.claimToken || current.claimToken === text(claimToken))) {
      entry.targets[targetKey] = { status: "ready", updatedAt: stamp.toISOString() };
    }
  }));
}

export function acknowledgeDataReleaseTarget({ repository, deduplicationKey, targetKey, event, claimToken, now = new Date() } = {}) {
  return withRepositoryReceiptLock(repository, now, () => mutateDeliveryReceipt(repository, deduplicationKey, event, now, (entry, stamp) => {
    if (!entry.expectedTargetKeys.includes(targetKey)) throw new Error("release target is not expected");
    const current = entry.targets[targetKey];
    if (current?.claimToken && current.claimToken !== text(claimToken)) return;
    entry.targets[targetKey] = { status: "success", updatedAt: stamp.toISOString() };
  }));
}

function normalizeSentStore(value, now) {
  const cutoff = now.getTime() - DELIVERY_RECEIPT_TTL_MS;
  return {
    version: 1,
    entries: (Array.isArray(value?.entries) ? value.entries : [])
      .filter((entry) => text(entry?.deduplicationKey) && text(entry?.targetKey) && Date.parse(entry?.updatedAt || "") >= cutoff)
      .slice(-DELIVERY_RECEIPT_MAX_ENTRIES)
      .map((entry) => ({
        deduplicationKey: text(entry.deduplicationKey),
        targetKey: text(entry.targetKey),
        status: entry.status === "sent" ? "sent" : "sending",
        messageIds: Array.isArray(entry.messageIds) ? [...entry.messageIds] : [],
        updatedAt: iso(entry.updatedAt) ?? now.toISOString(),
      })),
    updatedAt: iso(value?.updatedAt) ?? now.toISOString(),
  };
}

async function mutateSentMarker(repository, deduplicationKey, targetKey, nowValue, mutate) {
  const now = instant(nowValue);
  if (!now) throw new TypeError("now must be a valid date");
  return withRepositoryReceiptLock(repository, now, async () => {
    const store = normalizeSentStore(await repository.getMeta(DATA_RELEASE_SENT_META_KEY), now);
    const result = mutate(store, now);
    store.entries = store.entries.slice(-DELIVERY_RECEIPT_MAX_ENTRIES);
    store.updatedAt = now.toISOString();
    await repository.setMeta(DATA_RELEASE_SENT_META_KEY, store);
    return clone(result);
  });
}

export async function getDataReleaseSendMarker({ repository, deduplicationKey, targetKey, now = new Date() } = {}) {
  const stamp = instant(now);
  const store = normalizeSentStore(await repository.getMeta(DATA_RELEASE_SENT_META_KEY), stamp);
  return clone(store.entries.find((entry) => entry.deduplicationKey === deduplicationKey && entry.targetKey === targetKey) ?? null);
}

export function prepareDataReleaseSend({ repository, deduplicationKey, targetKey, now = new Date() } = {}) {
  return mutateSentMarker(repository, deduplicationKey, targetKey, now, (store, stamp) => {
    let entry = store.entries.find((item) => item.deduplicationKey === deduplicationKey && item.targetKey === targetKey);
    if (!entry) {
      entry = { deduplicationKey, targetKey, status: "sending", messageIds: [], updatedAt: stamp.toISOString() };
      store.entries.push(entry);
    }
    return entry;
  });
}

export function completeDataReleaseSend({ repository, deduplicationKey, targetKey, messageIds = [], now = new Date() } = {}) {
  return mutateSentMarker(repository, deduplicationKey, targetKey, now, (store, stamp) => {
    let entry = store.entries.find((item) => item.deduplicationKey === deduplicationKey && item.targetKey === targetKey);
    if (!entry) {
      entry = { deduplicationKey, targetKey, status: "sending", messageIds: [], updatedAt: stamp.toISOString() };
      store.entries.push(entry);
    }
    entry.status = "sent";
    entry.messageIds = [...messageIds];
    entry.updatedAt = stamp.toISOString();
    return entry;
  });
}

export function clearDataReleaseSend({ repository, deduplicationKey, targetKey, now = new Date() } = {}) {
  return mutateSentMarker(repository, deduplicationKey, targetKey, now, (store) => {
    store.entries = store.entries.filter((entry) => entry.deduplicationKey !== deduplicationKey || entry.targetKey !== targetKey);
    return null;
  });
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
  const actualAuthority = text(event?.eligibility?.actual?.authority).toLowerCase() || null;
  const recordedAuthority = acknowledgeActual && actual
    ? actualAuthority ?? previous?.lastActualAuthority ?? null
    : previous?.lastActualAuthority ?? null;
  return {
    eventKey: eventMonitorKey(event),
    id: eventSourceId(event),
    scheduledAt: eventSchedule(event),
    lastActual: acknowledgeActual ? actual ?? previous?.lastActual ?? null : previous?.lastActual ?? null,
    observedAt: acknowledgeActual
      ? iso(event?.actualObservedAt ?? event?.values?.actualObservedAt ?? event?.observedAt ?? now)
      : previous?.observedAt ?? null,
    ...(recordedAuthority ? { lastActualAuthority: recordedAuthority } : {}),
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

const OFFICIAL_RELEASE_INDICATORS = new Set([
  "cpi", "cpi-mom", "core-cpi", "core-cpi-mom", "pce", "pce-mom", "core-pce", "core-pce-mom",
  "nonfarm-payrolls", "nfp", "payrolls", "unemployment-rate", "fomc-rate-decision", "fomc-statement", "gdp",
]);

function officialIndicator(event = {}) {
  const direct = text(event.indicator ?? event.indicatorId ?? event.slug)
    .toLowerCase().replaceAll("_", "-").replace(/\s+/g, "-");
  const title = text(event.title).toLowerCase();
  let indicator = direct;
  if (!indicator) {
    const rules = [
      ["core-cpi", /\bcore cpi\b/], ["cpi", /\bcpi\b/], ["core-pce", /\bcore pce\b/], ["pce", /\bpce\b/],
      ["nonfarm-payrolls", /\b(?:nonfarm payrolls?|nfp)\b/], ["unemployment-rate", /\bunemployment rate\b/],
      ["fomc-rate-decision", /\b(?:fomc|fed)\b.*\b(?:rate|decision)\b/], ["fomc-statement", /\bfomc\b.*\bstatement\b/],
      ["gdp", /\bgdp\b/],
    ];
    indicator = rules.find(([, pattern]) => pattern.test(title))?.[0] ?? "";
  }
  if (/\b(?:mom|month[- ]over[- ]month|monthly)\b/i.test(title)
    && ["cpi", "core-cpi", "pce", "core-pce"].includes(indicator)) {
    indicator = `${indicator}-mom`;
  }
  return indicator;
}

function allowlistedOfficialEvent(event = {}) {
  const country = event.country ?? event.countryCode ?? event.country_code ?? event.jurisdiction;
  const countryAlias = country === undefined || country === null
    ? "us"
    : text(country).toLowerCase().replace(/[^a-z]/g, "");
  return ["us", "usa", "unitedstates", "unitedstatesofamerica"].includes(countryAlias)
    && OFFICIAL_RELEASE_INDICATORS.has(officialIndicator(event));
}

function actualCandidateForEvent(event) {
  const rawValue = rawActualValue(event);
  if (rawValue === null || rawValue === undefined || Array.isArray(rawValue)) return null;
  const source = event?.source ?? {};
  return {
    value: actualValue(event),
    rawValue,
    unit: event?.rawValues?.unit ?? event?.unit ?? null,
    status: text(event?.actualStatus ?? source?.status).toLowerCase() || "verified",
    authority: text(event?.actualAuthority ?? source?.authority ?? source?.type).toLowerCase() || "auxiliary",
    sourceId: source?.id ?? event?.calendarSourceId ?? null,
    sourceUrl: source?.url ?? event?.sourceUrl ?? null,
    retrievedAt: event?.retrievedAt ?? source?.retrievedAt ?? null,
    publishedAt: event?.actualObservedAt ?? event?.observedAt ?? null,
  };
}

function officialRecords(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (Array.isArray(value?.records)) return value.records.filter(Boolean);
  return value ? [value] : [];
}

function manifestRecord(source) {
  if (!source) return null;
  const nested = source.source ?? {};
  const id = source.sourceId ?? source.id ?? nested.id ?? null;
  const url = source.sourceUrl ?? source.url ?? nested.url ?? null;
  if (!id && !url) return null;
  return {
    id: id === null ? null : String(id),
    url: url === null ? null : String(url),
    authority: text(source.authority ?? nested.authority ?? nested.type).toLowerCase() || "auxiliary",
    status: text(source.status).toLowerCase() || "verified",
    retrievedAt: iso(source.retrievedAt) ?? null,
    publishedAt: iso(source.publishedAt) ?? null,
  };
}

function sourceManifestFor(calendarSources, candidates, selectedActual = null) {
  const manifest = [...(Array.isArray(calendarSources) ? calendarSources : []), ...candidates]
    .map(manifestRecord).filter(Boolean);
  const deduplicated = new Map();
  for (const record of manifest) {
    const key = `${record.id ?? ""}|${record.url ?? ""}`;
    const previous = deduplicated.get(key);
    if (!previous || (record.authority === "official" && previous.authority !== "official")) {
      deduplicated.set(key, record);
    } else if (record.authority === previous.authority) {
      const previousEvidence = Number(Boolean(previous.retrievedAt)) + Number(Boolean(previous.publishedAt));
      const currentEvidence = Number(Boolean(record.retrievedAt)) + Number(Boolean(record.publishedAt));
      if (currentEvidence > previousEvidence) deduplicated.set(key, record);
    }
  }
  const selectedRecord = manifestRecord(selectedActual);
  if (selectedRecord) {
    deduplicated.set(`${selectedRecord.id ?? ""}|${selectedRecord.url ?? ""}`, selectedRecord);
  }
  return [...deduplicated.values()];
}

const NON_RECONCILING_AUXILIARY_STATUSES = new Set([
  "blocked", "conflicting", "error", "failed", "invalid", "rejected", "source-conflict",
  "stale", "timezone-conflict", "unit-conflict", "unavailable", "unverified",
]);

function rejectedAuxiliaryComparisons(candidates) {
  return candidates.filter((candidate) => NON_RECONCILING_AUXILIARY_STATUSES.has(text(candidate?.status).toLowerCase()))
    .map((candidate) => reconcileSourcedField([candidate]))
    .filter(Boolean)
    .map(({ comparisons: _comparisons, publishable: _publishable, ...comparison }) => comparison);
}

function explicitTimezoneTimestamp(value) {
  const candidate = text(value);
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(candidate) && iso(candidate) !== null;
}

function tierOneEvent(event) {
  return allowlistedOfficialEvent(event)
    || text(event?.tierDecision?.tier ?? event?.tier).toLowerCase() === "tier-one"
    || Number(event?.importance ?? event?.impact ?? 0) >= 3;
}

function unambiguousScheduleTimezone(event) {
  const direct = event?.scheduledAt;
  if (explicitTimezoneTimestamp(direct)) return true;
  const evidence = [
    event?.schedule?.value,
    event?.schedule?.rawValue,
    ...(Array.isArray(event?.scheduledAtSources) ? event.scheduledAtSources : []),
    ...(Array.isArray(event?.timeSources) ? event.timeSources : []),
    ...(Array.isArray(event?.scheduleSources) ? event.scheduleSources : []),
  ];
  const scheduledInstant = iso(direct);
  return Boolean(scheduledInstant && evidence.some((candidate) => {
    const value = typeof candidate === "object"
      ? candidate?.value ?? candidate?.scheduledAt ?? candidate?.time ?? candidate?.rawValue
      : candidate;
    return explicitTimezoneTimestamp(value) && iso(value) === scheduledInstant;
  }));
}

function eventHasVerifiedOfficialActual(event) {
  const listed = Array.isArray(event?.actualSources) ? event.actualSources : [];
  const direct = actualCandidateForEvent(event);
  return [...listed, ...(direct ? [direct] : [])].some((candidate) => (
    text(candidate?.authority ?? candidate?.source?.authority).toLowerCase() === "official"
      && text(candidate?.status).toLowerCase() === "verified"
      && Boolean(candidate?.value ?? candidate?.rawValue)
  ));
}

function eventWithoutActual(event) {
  const components = Array.isArray(event?.components) ? event.components.map(eventWithoutActual) : event?.components;
  return {
    ...event,
    ...(components ? { components } : {}),
    values: { ...(event?.values ?? {}), actual: null },
    rawValues: { ...(event?.rawValues ?? {}), actual: null },
    actual: null,
  };
}

function eventWithOfficialActual(event, actual, eligibility, sourceManifest) {
  return {
    ...event,
    values: { ...(event?.values ?? {}), actual: actual.value },
    rawValues: { ...(event?.rawValues ?? {}), actual: actual.rawValue, unit: actual.unit },
    actualObservedAt: actual.publishedAt,
    actualSources: [actual, ...(actual.comparisons ?? [])],
    sourceManifest,
    eligibility,
  };
}

function groupedEvents(events) {
  const groups = new Map();
  for (const event of stableEvents(events)) {
    const key = eventMonitorKey(event);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  return [...groups.values()];
}

async function enforceOfficialEligibility(events, checkedAt, fetchOfficialActual, calendarSources, warnings) {
  const assessed = [];
  for (const candidates of groupedEvents(events)) {
    const event = candidates.find((candidate) => normalizedActual(candidate)) ?? candidates[0];
    if (tierOneEvent(event) && !unambiguousScheduleTimezone(event)) {
      const eligibility = { publishable: false, actual: null, forecast: null, surprise: null, reason: "timezone-ambiguous" };
      const sourceManifest = sourceManifestFor(calendarSources, []);
      const enriched = { ...eventWithoutActual(event), sourceManifest, eligibility };
      assessed.push({
        event: enriched,
        selectionEvent: { ...enriched, scheduledAt: null },
        eligibility,
        sourceManifest,
      });
      continue;
    }
    if (releaseWindowStatus(event, checkedAt) !== "monitoring") {
      const selectionEvent = allowlistedOfficialEvent(event) && !eventHasVerifiedOfficialActual(event)
        ? eventWithoutActual(event)
        : event;
      assessed.push({ event: selectionEvent, selectionEvent, eligibility: null, sourceManifest: sourceManifestFor(calendarSources, []) });
      continue;
    }
    const auxiliary = candidates.map(actualCandidateForEvent).filter(Boolean);
    let official = [];
    if (allowlistedOfficialEvent(event)) {
      try {
        official = officialRecords(await fetchOfficialActual({ event: clone(event), now: checkedAt.toISOString() }));
      } catch (error) {
        warnings.push(`Official actual unavailable: ${error?.message ?? String(error)}`);
      }
    }
    const reconcilingAuxiliary = auxiliary.filter(
      (candidate) => !NON_RECONCILING_AUXILIARY_STATUSES.has(text(candidate?.status).toLowerCase()),
    );
    const actualSources = [...official, ...auxiliary];
    const reconcilingSources = [...official, ...reconcilingAuxiliary];
    let actual = reconcileSourcedField(reconcilingSources);
    const rejectedComparisons = rejectedAuxiliaryComparisons(auxiliary);
    if (actual && rejectedComparisons.length) {
      actual = { ...actual, comparisons: [...(actual.comparisons ?? []), ...rejectedComparisons] };
    }
    let eligibility = validateDataReleasePublication({ actualSources: reconcilingSources });
    if (actual && eligibility.actual) eligibility = { ...eligibility, actual };
    if (!official.length) eligibility = { ...eligibility, publishable: false, reason: "official-actual-unavailable" };
    const scheduleReason = ["timezone-conflict", "unit-conflict", "source-conflict", "conflicting"]
      .includes(text(event?.schedule?.status).toLowerCase())
      ? (event.schedule.status === "conflicting" ? "source-conflict" : event.schedule.status)
      : null;
    const scheduled = instant(event.scheduledAt);
    const published = instant(actual?.publishedAt);
    const stale = Boolean(actual?.authority === "official" && scheduled && published && published < scheduled);
    if (scheduleReason) eligibility = { ...eligibility, publishable: false, reason: scheduleReason };
    else if (stale) eligibility = { ...eligibility, publishable: false, reason: "stale-actual" };
    const sourceManifest = sourceManifestFor(calendarSources, actualSources, eligibility.actual ?? actual);
    const enriched = eligibility.publishable
      ? eventWithOfficialActual(event, actual, eligibility, sourceManifest)
      : { ...eventWithoutActual(event), sourceManifest, eligibility };
    assessed.push({ event: enriched, selectionEvent: enriched, eligibility, sourceManifest });
  }
  return assessed;
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
      && !published.has(deduplicationKey)
      && !(prior?.lastActual === actual && prior?.lastActualAuthority === "official");
    const officialActualBeforeRelease = Boolean(actual && scheduledAt && checkedAt && checkedAt < scheduledAt
      && text(event?.eligibility?.actual?.authority).toLowerCase() === "official");
    monitoredEvents.push(monitoredRecord(event, prior, now, {
      acknowledgeActual: !releasable && !officialActualBeforeRelease,
    }));
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
  const fetchOfficialActual = typeof options.fetchOfficialActual === "function"
    ? options.fetchOfficialActual
    : fetchOfficialActualDefault;
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
      sources: clone(storedCalendar?.sources ?? []),
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
      return {
        publishable: false,
        skipReason: "calendar-unavailable",
        warnings: ["Weekly calendar bootstrap could not run: calendar adapter is unavailable."],
        sources: clone(storedCalendar?.sources ?? []),
        nextMonitoredEvent: null
      };
    }
    try {
      fetchResult = await fetchCalendar({ from: week.start.toISOString(), to: week.end.toISOString(), now: checkedAtIso });
    } catch (error) {
      await saveFailedCheck();
      return {
        publishable: false,
        skipReason: "calendar-unavailable",
        warnings: [`Weekly calendar bootstrap failed: ${error?.message ?? String(error)}`],
        sources: clone(storedCalendar?.sources ?? []),
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

  const sources = clone(fetchResult?.sources ?? storedCalendar?.sources ?? []);
  const assessments = await enforceOfficialEligibility(liveEvents, checkedAt, fetchOfficialActual, sources, warnings);
  const eligibleEvents = assessments.map(({ selectionEvent }) => selectionEvent);
  const selected = selectReleasableEvents(eligibleEvents, state, checkedAt);
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

  const publishableEvents = selected.releasableEvents;
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
      sources,
      sourceManifest: clone(event.sourceManifest ?? []),
      eligibility: clone(event.eligibility),
    };
  }

  const blocked = assessments.find(({ eligibility, selectionEvent }) => (
    eligibility && !eligibility.publishable && (
      eligibility.reason === "timezone-ambiguous"
      || releaseWindowStatus(selectionEvent, checkedAt) === "monitoring"
    )
  ));
  if (blocked) {
    const conflictingEvidence = [
      blocked.eligibility.actual,
      ...(blocked.eligibility.actual?.comparisons ?? []),
    ];
    const officialConflictingEvidence = conflictingEvidence.filter(
      (candidate) => candidate?.authority === "official",
    );
    const conflict = ["source-conflict", "unit-conflict"].includes(blocked.eligibility.reason)
      ? {
        eventKey: eventMonitorKey(blocked.event),
        rawValues: (officialConflictingEvidence.length ? officialConflictingEvidence : conflictingEvidence)
          .map((candidate) => candidate?.rawValue).filter((value) => value !== null && value !== undefined),
        events: clone([blocked.event]),
      }
      : null;
    await saveState();
    return {
      publishable: false,
      skipReason: blocked.eligibility.reason,
      ...(conflict ? { conflict } : {}),
      event: clone(blocked.event),
      eligibility: clone(blocked.eligibility),
      sourceManifest: clone(blocked.sourceManifest),
      warnings,
      sources,
      nextMonitoredEvent: conflict ? null : clone(selected.nextMonitoredEvent),
    };
  }

  const stale = eligibleEvents.find((candidate) => (
    releaseWindowStatus(candidate, checkedAt) === "monitoring" && actualIsStale(candidate)
  ));
  if (stale) {
    await saveState();
    return {
      publishable: false,
      skipReason: "stale-actual",
      event: clone(stale),
      warnings,
      sources,
      sourceManifest: clone(stale.sourceManifest ?? []),
      eligibility: clone(stale.eligibility),
      nextMonitoredEvent: clone(selected.nextMonitoredEvent),
    };
  }

  const duplicate = stableEvents(eligibleEvents).find((candidate) => {
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
      sources,
      sourceManifest: clone(duplicate.sourceManifest ?? []),
      eligibility: clone(duplicate.eligibility),
      nextMonitoredEvent: clone(selected.nextMonitoredEvent),
    };
  }

  await saveState();
  const hasActualInWindow = eligibleEvents.some((candidate) => (
    releaseWindowStatus(candidate, checkedAt) === "monitoring" && normalizedActual(candidate)
  ));
  return {
    publishable: false,
    skipReason: selected.newlyTimedOutKeys.length
      ? "release-timeout"
      : hasActualInWindow ? "stale-actual" : selected.nextMonitoredEvent ? "actual-unavailable" : "no-monitored-event",
    warnings,
    sources,
    sourceManifest: [],
    eligibility: null,
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
    const actualAuthority = text(event?.eligibility?.actual?.authority).toLowerCase();
    if (actualAuthority) monitored.lastActualAuthority = actualAuthority;
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
