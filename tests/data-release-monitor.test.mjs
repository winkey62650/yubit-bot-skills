import assert from "node:assert/strict";
import test from "node:test";
import {
  DATA_RELEASE_DELIVERY_META_KEY,
  RELEASE_STATE_META_KEY,
  WEEKLY_CALENDAR_META_KEY,
  acknowledgeDataReleasePublished,
  acknowledgeDataReleaseTarget,
  buildDataReleaseTargetKey,
  buildReleaseDeduplicationKey,
  cacheWeeklyCalendar,
  prepareDataReleaseDelivery,
  pollDataReleaseUpdates as pollDataReleaseUpdatesImpl,
  releaseWindowStatus,
  selectReleasableEvents,
  withDataReleaseRunLease,
} from "../lib/data-release-monitor.mjs";

const scheduledAt = "2026-08-19T12:30:00.000Z";

function release(overrides = {}) {
  return {
    id: "us-cpi-yoy-2026-08",
    sourceId: "us-cpi-yoy-2026-08",
    title: "US CPI YoY",
    scheduledAt,
    importance: 3,
    values: { actual: null, forecast: "2.8%", previous: "2.9%" },
    rawValues: { actual: null, forecast: "2.8", previous: "2.9", unit: "%" },
    ...overrides,
  };
}

function repositoryDouble(initial = {}) {
  const meta = new Map(Object.entries(structuredClone(initial)));
  return {
    writes: [],
    async getMeta(key) { return structuredClone(meta.get(key) ?? null); },
    async setMeta(key, value) {
      const clone = structuredClone(value);
      this.writes.push([key, clone]);
      meta.set(key, clone);
      return structuredClone(value);
    },
  };
}

function calendarResult(events, extras = {}) {
  return {
    events,
    sources: [{ id: "tradingview-calendar", status: "ok", checkedAt: "2026-08-19T12:30:20.000Z" }],
    warnings: [],
    ...extras,
  };
}

function officialActual(rawValue = "2.7", overrides = {}) {
  const unit = overrides.unit ?? "%";
  return {
    value: `${rawValue}${unit}`,
    rawValue: String(rawValue),
    unit,
    status: "verified",
    authority: "official",
    sourceId: "bls-cpi",
    sourceUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
    retrievedAt: "2026-08-19T12:30:20.000Z",
    publishedAt: scheduledAt,
    ...overrides,
  };
}

async function legacyOfficialActual({ event }) {
  if (Array.isArray(event?.components) && event.components.length) {
    const values = event.components.map((component) => component?.rawValues?.actual ?? component?.values?.actual ?? null);
    if (values.some((value) => value === null || value === undefined || value === "")) return null;
    return officialActual(values.map(String).join("/"), {
      value: values.map(String).join("/"),
      unit: "composite",
      sourceId: "official-composite-fixture",
      publishedAt: event.actualObservedAt ?? event.observedAt ?? event.scheduledAt,
    });
  }
  const rawValue = event?.rawValues?.actual ?? event?.values?.actual ?? null;
  if (rawValue === null || rawValue === undefined || rawValue === "") return null;
  const unit = event?.rawValues?.unit ?? String(event?.values?.actual ?? "").match(/([%KMB])\s*$/i)?.[1] ?? null;
  return officialActual(String(rawValue).replace(new RegExp(`${unit ?? ""}$`), ""), {
    value: event?.values?.actual ?? `${rawValue}${unit ?? ""}`,
    unit,
    sourceId: "official-release-fixture",
    publishedAt: event.actualObservedAt ?? event.observedAt ?? event.scheduledAt,
  });
}

function pollDataReleaseUpdates(options = {}) {
  return pollDataReleaseUpdatesImpl({
    ...options,
    fetchOfficialActual: options.fetchOfficialActual ?? legacyOfficialActual,
  });
}

test("exports stable repository keys and builds the exact normalized release key", () => {
  assert.equal(DATA_RELEASE_DELIVERY_META_KEY, "market-content:release-delivery:v1");
  assert.equal(RELEASE_STATE_META_KEY, "market-content:release-state:v1");
  assert.equal(WEEKLY_CALENDAR_META_KEY, "market-content:weekly-calendar:v1");
  assert.equal(
    buildReleaseDeduplicationKey(release({ values: { actual: " 2.70 % " } })),
    '["us-cpi-yoy-2026-08","2026-08-19T12:30:00.000Z","2.7%"]',
  );
});

test("delivery receipts persist expected targets and preserve successful targets across retries", async () => {
  const repository = repositoryDouble();
  const event = release({ values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" } });
  const deduplicationKey = buildReleaseDeduplicationKey(event);
  const firstKey = buildDataReleaseTargetKey({ platform: "discord", guildId: "g1", channelId: "c1" });
  const secondKey = buildDataReleaseTargetKey({ chatId: "-1001", threadId: 8 });

  const prepared = await prepareDataReleaseDelivery({
    repository, deduplicationKey, event, targetKeys: [firstKey, secondKey], now: "2026-08-19T12:31:00Z",
  });
  assert.deepEqual(prepared.expectedTargetKeys, [firstKey, secondKey]);
  assert.deepEqual(prepared.successfulTargetKeys, []);

  const partial = await acknowledgeDataReleaseTarget({
    repository, deduplicationKey, targetKey: firstKey, event, now: "2026-08-19T12:31:05Z",
  });
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.successfulTargetKeys, [firstKey]);

  const retry = await prepareDataReleaseDelivery({
    repository, deduplicationKey, event, targetKeys: [firstKey, secondKey], now: "2026-08-19T12:32:00Z",
  });
  assert.deepEqual(retry.successfulTargetKeys, [firstKey]);
  assert.deepEqual(retry.readyTargetKeys, [secondKey]);
  assert.ok(await repository.getMeta(DATA_RELEASE_DELIVERY_META_KEY));
});

test("delivery receipt mutations are serialized across repository instances sharing one backend", async () => {
  const meta = new Map();
  const leases = new Map();
  const makeRepository = () => ({
    async getMeta(key) { await Promise.resolve(); return structuredClone(meta.get(key) ?? null); },
    async setMeta(key, value) { await Promise.resolve(); meta.set(key, structuredClone(value)); return value; },
    async acquireMetaLease(key, lease) {
      if (leases.has(key)) return null;
      leases.set(key, lease.leaseId);
      return lease;
    },
    async releaseMetaLease(key, leaseId) {
      if (leases.get(key) !== leaseId) return false;
      leases.delete(key);
      return true;
    },
  });
  const firstRepository = makeRepository();
  const secondRepository = makeRepository();
  const event = release({ values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" } });
  const deduplicationKey = buildReleaseDeduplicationKey(event);
  const targetKeys = ["discord:g1:c1", "discord:g1:c2"];
  await prepareDataReleaseDelivery({ repository: firstRepository, deduplicationKey, event, targetKeys, now: "2026-08-19T12:31:00Z" });

  await Promise.all(targetKeys.map((targetKey, index) => acknowledgeDataReleaseTarget({
    repository: index ? secondRepository : firstRepository,
    deduplicationKey,
    targetKey,
    event,
    now: `2026-08-19T12:31:0${index + 1}Z`,
  })));

  const snapshot = await prepareDataReleaseDelivery({ repository: firstRepository, deduplicationKey, event, targetKeys, now: "2026-08-19T12:31:10Z" });
  assert.deepEqual(snapshot.successfulTargetKeys.sort(), targetKeys);
});

test("data release run lease releases its owner record when the operation throws", async () => {
  const leases = new Map();
  const repository = {
    async acquireMetaLease(key, lease) {
      if (leases.has(key)) return null;
      leases.set(key, structuredClone(lease));
      return structuredClone(lease);
    },
    async getMetaLease(key) { return structuredClone(leases.get(key) ?? null); },
    async renewMetaLease(key, leaseId, leaseUntil) {
      const current = leases.get(key);
      if (current?.leaseId !== leaseId) return null;
      const renewed = { ...current, leaseUntil };
      leases.set(key, renewed);
      return structuredClone(renewed);
    },
    async releaseMetaLease(key, leaseId) {
      if (leases.get(key)?.leaseId !== leaseId) return false;
      leases.delete(key);
      return true;
    },
  };

  await assert.rejects(() => withDataReleaseRunLease({
    repository,
    leaseTtlMs: 20,
    heartbeatMs: 5,
    operation: async () => { throw new Error("operation failed"); },
  }), /operation failed/);
  assert.equal(leases.size, 0);
});

test("classifies the -5 minute through +15 minute release window inclusively", () => {
  assert.equal(releaseWindowStatus(release(), "2026-08-19T12:24:59.999Z"), "upcoming");
  assert.equal(releaseWindowStatus(release(), "2026-08-19T12:25:00.000Z"), "monitoring");
  assert.equal(releaseWindowStatus(release(), "2026-08-19T12:45:00.000Z"), "monitoring");
  assert.equal(releaseWindowStatus(release(), "2026-08-19T12:45:00.001Z"), "timed-out");
  assert.equal(releaseWindowStatus({ ...release(), scheduledAt: null }, "2026-08-19T12:30:00Z"), "unscheduled");
});

test("selects a new Actual, exposes the next event, and records end-window timeouts", () => {
  const live = release({ values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" } });
  const future = release({ id: "future", sourceId: "future", scheduledAt: "2026-08-19T14:00:00Z" });
  const expired = release({ id: "expired", sourceId: "expired", scheduledAt: "2026-08-19T11:00:00Z" });
  const selected = selectReleasableEvents([future, expired, live], {
    monitoredEvents: [], publishedKeys: [], timedOutKeys: [],
  }, "2026-08-19T12:31:00Z");

  assert.deepEqual(selected.releasableEvents, [live]);
  assert.equal(selected.nextMonitoredEvent.id, "future");
  assert.deepEqual(selected.timedOutKeys, ["expired|2026-08-19T11:00:00.000Z"]);
});

test("times out a previously monitored event after it disappears from the live snapshot", () => {
  const eventKey = "us-cpi-yoy-2026-08|2026-08-19T12:30:00.000Z";
  const selected = selectReleasableEvents([], {
    monitoredEvents: [{
      eventKey,
      id: "us-cpi-yoy-2026-08",
      scheduledAt,
      lastActual: null,
      observedAt: null,
    }],
    publishedKeys: [],
    timedOutKeys: [],
  }, "2026-08-19T12:45:00.001Z");

  assert.deepEqual(selected.monitoredEvents, []);
  assert.deepEqual(selected.timedOutKeys, [eventKey]);
  assert.deepEqual(selected.newlyTimedOutKeys, [eventKey]);
});

test("cacheWeeklyCalendar persists only when requested", async () => {
  const repository = repositoryDouble();
  const calendar = { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z" };
  assert.deepEqual(await cacheWeeklyCalendar(repository, calendar), calendar);
  assert.deepEqual(await repository.getMeta(WEEKLY_CALENDAR_META_KEY), calendar);

  const dryRepository = repositoryDouble();
  assert.deepEqual(await cacheWeeklyCalendar(dryRepository, calendar, { persist: false }), calendar);
  assert.equal(await dryRepository.getMeta(WEEKLY_CALENDAR_META_KEY), null);
});

test("prepares a release without publishing it, retries until acknowledged, then deduplicates", async () => {
  const live = release({ values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" } });
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: {
      calendarWeek: "2026-08-17",
      events: [release()],
      updatedAt: "2026-08-19T10:00:00.000Z",
    },
  });
  const fetchCalendar = async () => calendarResult([live]);

  const prepared = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository, fetchCalendar, persist: true,
  });
  assert.equal(prepared.publishable, true);
  assert.deepEqual((await repository.getMeta(RELEASE_STATE_META_KEY)).publishedKeys, []);

  const retry = await pollDataReleaseUpdates({
    now: "2026-08-19T12:32:00Z", repository, fetchCalendar, persist: true,
  });
  assert.equal(retry.publishable, true);
  assert.equal(retry.deduplicationKey, prepared.deduplicationKey);

  const acknowledged = await acknowledgeDataReleasePublished({
    repository,
    deduplicationKey: retry.deduplicationKey,
    event: retry.event,
    now: "2026-08-19T12:32:05Z",
  });
  assert.equal(acknowledged.acknowledged, true);
  assert.deepEqual((await repository.getMeta(RELEASE_STATE_META_KEY)).publishedKeys, [retry.deduplicationKey]);

  const duplicate = await pollDataReleaseUpdates({
    now: "2026-08-19T12:33:05Z", repository, fetchCalendar, persist: true,
  });
  assert.equal(duplicate.publishable, false);
  assert.equal(duplicate.skipReason, "duplicate-release");
});

test("publishes a new Actual once and persists the exact state shape and deduplication key", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: {
      calendarWeek: "2026-08-17",
      events: [release()],
      updatedAt: "2026-08-19T10:00:00.000Z",
    },
  });
  let calls = 0;
  const fetchCalendar = async () => {
    calls += 1;
    return calendarResult([release({ values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" } })]);
  };
  const fetchReaction = async ({ event }) => ({ eventId: event.id, prices: { BTC: { changePercent: 1.2 } } });

  const first = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository, fetchCalendar, fetchReaction, persist: true,
  });
  await acknowledgeDataReleasePublished({
    repository, deduplicationKey: first.deduplicationKey, event: first.event,
    now: "2026-08-19T12:31:05Z",
  });
  const second = await pollDataReleaseUpdates({
    now: "2026-08-19T12:32:00Z", repository, fetchCalendar, fetchReaction, persist: true,
  });

  assert.equal(calls, 2);
  assert.equal(first.publishable, true);
  assert.equal(first.event.values.actual, "2.7%");
  assert.equal(first.reaction.prices.BTC.changePercent, 1.2);
  assert.equal(second.publishable, false);
  assert.equal(second.skipReason, "duplicate-release");
  const state = await repository.getMeta(RELEASE_STATE_META_KEY);
  assert.deepEqual(Object.keys(state).sort(), ["calendarWeek", "monitoredEvents", "publishedKeys", "timedOutKeys", "updatedAt"]);
  assert.deepEqual(state.publishedKeys, [first.deduplicationKey]);
});

test("serializes concurrent polls for the same repository so only one can prepare", async () => {
  const live = release({ values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" } });
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: {
      calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z",
    },
  });
  const fetchCalendar = async () => {
    await Promise.resolve();
    return calendarResult([live]);
  };

  const results = await Promise.all([
    pollDataReleaseUpdates({
      now: "2026-08-19T12:31:00Z", repository, fetchCalendar, persist: true,
    }),
    pollDataReleaseUpdates({
      now: "2026-08-19T12:31:00Z", repository, fetchCalendar, persist: true,
    }),
  ]);

  assert.equal(results.filter(({ publishable }) => publishable).length, 1);
  assert.equal(results.filter(({ skipReason }) => skipReason === "poll-interval").length, 1);
  assert.deepEqual((await repository.getMeta(RELEASE_STATE_META_KEY)).publishedKeys, []);
  const prepared = results.find(({ publishable }) => publishable);
  await acknowledgeDataReleasePublished({
    repository, deduplicationKey: prepared.deduplicationKey, event: prepared.event,
    now: "2026-08-19T12:31:05Z",
  });
  assert.deepEqual((await repository.getMeta(RELEASE_STATE_META_KEY)).publishedKeys, [
    buildReleaseDeduplicationKey(live),
  ]);
});

test("releases the repository poll lock after an unexpected exception", async () => {
  const future = release({ scheduledAt: "2026-08-19T14:00:00Z" });
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: {
      calendarWeek: "2026-08-17", events: [future], updatedAt: "2026-08-19T10:00:00Z",
    },
  });
  const readMeta = repository.getMeta.bind(repository);
  let failNextRead = true;
  repository.getMeta = async (key) => {
    if (failNextRead) {
      failNextRead = false;
      throw new Error("repository read failed");
    }
    return readMeta(key);
  };

  await assert.rejects(
    pollDataReleaseUpdates({ now: "2026-08-19T12:00:00Z", repository, persist: true }),
    /repository read failed/,
  );
  const recovered = await pollDataReleaseUpdates({
    now: "2026-08-19T12:01:00Z", repository, persist: true,
  });

  assert.equal(recovered.publishable, false);
  assert.equal(recovered.nextMonitoredEvent.id, future.id);
});

test("publishes simultaneous CPI and Core CPI Actuals sequentially without losing either event", async () => {
  const cpi = release({
    id: "01-us-cpi-yoy-2026-08",
    sourceId: "01-us-cpi-yoy-2026-08",
    values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" },
  });
  const coreCpi = release({
    id: "02-us-core-cpi-yoy-2026-08",
    sourceId: "02-us-core-cpi-yoy-2026-08",
    title: "US Core CPI YoY",
    values: { actual: "2.8%", forecast: "2.9%", previous: "3.0%" },
  });
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: {
      calendarWeek: "2026-08-17",
      events: [cpi, coreCpi].map((event) => ({ ...event, values: { ...event.values, actual: null } })),
      updatedAt: "2026-08-19T10:00:00.000Z",
    },
  });
  const fetchCalendar = async () => calendarResult([cpi, coreCpi]);

  const first = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository, fetchCalendar, persist: true,
  });
  const stateAfterFirst = await repository.getMeta(RELEASE_STATE_META_KEY);
  await acknowledgeDataReleasePublished({
    repository, deduplicationKey: first.deduplicationKey, event: first.event,
    now: "2026-08-19T12:31:05Z",
  });
  const second = await pollDataReleaseUpdates({
    now: "2026-08-19T12:32:00Z", repository, fetchCalendar, persist: true,
  });
  await acknowledgeDataReleasePublished({
    repository, deduplicationKey: second.deduplicationKey, event: second.event,
    now: "2026-08-19T12:32:05Z",
  });
  const third = await pollDataReleaseUpdates({
    now: "2026-08-19T12:33:00Z", repository, fetchCalendar, persist: true,
  });

  const cpiKey = buildReleaseDeduplicationKey(cpi);
  const coreCpiKey = buildReleaseDeduplicationKey(coreCpi);
  assert.equal(first.event.id, cpi.id);
  assert.equal(second.event.id, coreCpi.id);
  assert.equal(third.publishable, false);
  assert.equal(third.skipReason, "duplicate-release");
  assert.equal(
    stateAfterFirst.monitoredEvents.find(({ id }) => id === coreCpi.id).lastActual,
    null,
  );
  const finalState = await repository.getMeta(RELEASE_STATE_META_KEY);
  assert.deepEqual(finalState.publishedKeys, [cpiKey, coreCpiKey]);
  assert.equal(finalState.publishedKeys.filter((key) => key === cpiKey).length, 1);
  assert.equal(finalState.publishedKeys.filter((key) => key === coreCpiKey).length, 1);
});

test("publishes a valid event without letting a stale Actual in the same poll block it", async () => {
  const good = release({
    id: "01-good-cpi",
    sourceId: "01-good-cpi",
    values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" },
    observedAt: "2026-08-19T12:30:30Z",
  });
  const stale = release({
    id: "02-stale-core-cpi",
    sourceId: "02-stale-core-cpi",
    title: "US Core CPI YoY",
    values: { actual: "2.8%", forecast: "2.9%", previous: "3.0%" },
    observedAt: "2026-08-19T12:29:00Z",
  });
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: {
      calendarWeek: "2026-08-17", events: [good, stale], updatedAt: "2026-08-19T10:00:00Z",
    },
  });
  const fetchCalendar = async () => calendarResult([good, stale]);

  const first = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository, fetchCalendar, persist: true,
  });
  const stateAfterFirst = await repository.getMeta(RELEASE_STATE_META_KEY);
  await acknowledgeDataReleasePublished({
    repository, deduplicationKey: first.deduplicationKey, event: first.event,
    now: "2026-08-19T12:31:05Z",
  });
  const second = await pollDataReleaseUpdates({
    now: "2026-08-19T12:32:00Z", repository, fetchCalendar, persist: true,
  });

  assert.equal(first.publishable, true);
  assert.equal(first.event.id, good.id);
  assert.equal(
    stateAfterFirst.monitoredEvents.find(({ id }) => id === stale.id).observedAt,
    "2026-08-19T12:29:00.000Z",
  );
  assert.equal(second.publishable, false);
  assert.equal(second.skipReason, "stale-actual");
  assert.equal(second.event.id, stale.id);
});

test("publishes an independent valid event while preserving a separate source conflict", async () => {
  const conflictingA = release({
    id: "01-conflicted-cpi", sourceId: "01-conflicted-cpi",
    values: { actual: "2.7%" }, rawValues: { actual: "2.7", unit: "%" }, source: { id: "tv" },
  });
  const conflictingB = release({
    id: "01-conflicted-cpi", sourceId: "01-conflicted-cpi",
    values: { actual: "2.8%" }, rawValues: { actual: "2.8", unit: "%" }, source: { id: "bls" },
  });
  const good = release({
    id: "02-good-pce", sourceId: "02-good-pce", title: "US PCE YoY",
    values: { actual: "2.6%", forecast: "2.7%", previous: "2.8%" },
  });
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: {
      calendarWeek: "2026-08-17", events: [conflictingA, conflictingB, good], updatedAt: "2026-08-19T10:00:00Z",
    },
  });
  const fetchCalendar = async () => calendarResult([conflictingA, conflictingB, good]);
  const fetchOfficialActual = async ({ event }) => event.id === conflictingA.id
    ? [
      officialActual("2.7"),
      officialActual("2.8", { sourceId: "bls-cpi-revision" }),
    ]
    : officialActual("2.6", { sourceId: "bea-pce" });

  const first = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository, fetchCalendar, fetchOfficialActual, persist: true,
  });
  await acknowledgeDataReleasePublished({
    repository, deduplicationKey: first.deduplicationKey, event: first.event,
    now: "2026-08-19T12:31:05Z",
  });
  const second = await pollDataReleaseUpdates({
    now: "2026-08-19T12:32:00Z", repository, fetchCalendar, fetchOfficialActual, persist: true,
  });

  assert.equal(first.publishable, true);
  assert.equal(first.event.id, good.id);
  assert.deepEqual((await repository.getMeta(RELEASE_STATE_META_KEY)).publishedKeys, [
    buildReleaseDeduplicationKey(good),
  ]);
  assert.equal(second.publishable, false);
  assert.equal(second.skipReason, "source-conflict");
  assert.deepEqual(second.conflict.rawValues, ["2.7", "2.8"]);
});

test("detects an Actual that appears on a later one-minute poll", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z" },
  });
  let actual = null;
  const fetchCalendar = async () => calendarResult([
    release({ values: { actual, forecast: "2.8%", previous: "2.9%" } }),
  ]);
  const waiting = await pollDataReleaseUpdates({
    now: "2026-08-19T12:30:00Z", repository, fetchCalendar, persist: true,
  });
  actual = "2.7%";
  const released = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository, fetchCalendar, persist: true,
  });
  assert.equal(waiting.publishable, false);
  assert.equal(waiting.skipReason, "official-actual-unavailable");
  assert.equal(released.publishable, true);
});

test("never publishes an early Actual and rejects the unchanged value after release", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z" },
  });
  const fetchCalendar = async () => calendarResult([
    release({ values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" } }),
  ]);
  const early = await pollDataReleaseUpdates({
    now: "2026-08-19T12:29:00Z", repository, fetchCalendar, persist: true,
  });
  const unchanged = await pollDataReleaseUpdates({
    now: "2026-08-19T12:30:00Z", repository, fetchCalendar, persist: true,
  });
  assert.equal(early.publishable, false);
  assert.equal(early.skipReason, "stale-actual");
  assert.equal(unchanged.publishable, false);
  assert.equal(unchanged.skipReason, "stale-actual");
});

test("enforces one-minute polling without calling adapters or mutating state", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z" },
    [RELEASE_STATE_META_KEY]: {
      calendarWeek: "2026-08-17", monitoredEvents: [], publishedKeys: [], timedOutKeys: [], updatedAt: "2026-08-19T12:30:30.000Z",
    },
  });
  let calls = 0;
  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z",
    repository,
    fetchCalendar: async () => { calls += 1; return calendarResult([]); },
    persist: true,
  });
  assert.equal(result.publishable, false);
  assert.equal(result.skipReason, "poll-interval");
  assert.equal(calls, 0);
  assert.equal(repository.writes.length, 0);
});

test("dry-run reports the next event without mutating either metadata record", async () => {
  const repository = repositoryDouble();
  const fetchCalendar = async () => calendarResult([
    release({ scheduledAt: "2026-08-19T13:00:00Z" }),
  ]);
  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:00:00Z", repository, fetchCalendar, persist: false,
  });
  assert.equal(result.publishable, false);
  assert.equal(result.nextMonitoredEvent.id, "us-cpi-yoy-2026-08");
  assert.ok(result.warnings.some((warning) => /bootstrap/i.test(warning)));
  assert.equal(await repository.getMeta(RELEASE_STATE_META_KEY), null);
  assert.equal(await repository.getMeta(WEEKLY_CALENDAR_META_KEY), null);
  assert.equal(repository.writes.length, 0);
});

test("dry-run bypasses the production poll interval for an immediate preview", async () => {
  const live = release({ values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" } });
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: {
      calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z",
    },
    [RELEASE_STATE_META_KEY]: {
      calendarWeek: "2026-08-17", monitoredEvents: [], publishedKeys: [], timedOutKeys: [],
      updatedAt: "2026-08-19T12:30:45.000Z",
    },
  });

  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository,
    fetchCalendar: async () => calendarResult([live]), persist: false,
  });

  assert.equal(result.publishable, true);
  assert.equal(result.event.id, live.id);
  assert.equal(repository.writes.length, 0);
});

test("does not call the live Actual adapter outside cached release windows", async () => {
  for (const now of ["2026-08-19T12:24:59.999Z", "2026-08-19T12:45:00.001Z"]) {
    const repository = repositoryDouble({
      [WEEKLY_CALENDAR_META_KEY]: {
        calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z",
      },
    });
    let calls = 0;
    await pollDataReleaseUpdates({
      now, repository,
      fetchCalendar: async () => { calls += 1; return calendarResult([]); },
      persist: true,
    });
    assert.equal(calls, 0, `unexpected adapter call at ${now}`);
  }
});

test("refreshes an absent or stale weekly cache through the injected adapter and warns", async () => {
  for (const initial of [
    {},
    { [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-10", events: [], updatedAt: "2026-08-10T00:30:00Z" } },
  ]) {
    const repository = repositoryDouble(initial);
    const result = await pollDataReleaseUpdates({
      now: "2026-08-19T12:00:00Z",
      repository,
      fetchCalendar: async () => calendarResult([release({ scheduledAt: "2026-08-19T13:00:00Z" })]),
      persist: true,
    });
    assert.ok(result.warnings.some((warning) => /bootstrap/i.test(warning)));
    assert.equal((await repository.getMeta(WEEKLY_CALENDAR_META_KEY)).calendarWeek, "2026-08-17");
  }
});

test("refreshes a same-week calendar after its six-hour TTL expires", async () => {
  const future = release({ scheduledAt: "2026-08-19T14:00:00Z" });
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: {
      calendarWeek: "2026-08-17", events: [future], updatedAt: "2026-08-19T05:59:59.999Z",
    },
  });
  const calls = [];

  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:00:00Z", repository,
    fetchCalendar: async (request) => {
      calls.push(request);
      return calendarResult([future]);
    },
    persist: true,
  });

  assert.equal(calls.length, 1);
  assert.ok(result.warnings.some((warning) => /bootstrap/i.test(warning)));
  assert.equal((await repository.getMeta(WEEKLY_CALENDAR_META_KEY)).updatedAt, "2026-08-19T12:00:00.000Z");
});

test("keeps an in-window cached event across an empty TTL refresh until Actual arrives", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: {
      calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T06:30:59.999Z",
    },
  });
  let calls = 0;
  const fetchCalendar = async () => {
    calls += 1;
    return calendarResult(calls === 1 ? [] : [
      release({ values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" } }),
    ]);
  };

  const emptyRefresh = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository, fetchCalendar, persist: true,
  });
  const cachedAfterEmpty = await repository.getMeta(WEEKLY_CALENDAR_META_KEY);
  const actualRefresh = await pollDataReleaseUpdates({
    now: "2026-08-19T12:32:00Z", repository, fetchCalendar, persist: true,
  });

  assert.equal(emptyRefresh.publishable, false);
  assert.equal(cachedAfterEmpty.events.length, 1);
  assert.equal(cachedAfterEmpty.events[0].id, "us-cpi-yoy-2026-08");
  assert.equal(calls, 2);
  assert.equal(actualRefresh.publishable, true);
  assert.equal(actualRefresh.event.values.actual, "2.7%");
});

test("allows an empty TTL refresh to clear cached events outside their release window", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: {
      calendarWeek: "2026-08-17",
      events: [release({ scheduledAt: "2026-08-19T11:00:00Z" })],
      updatedAt: "2026-08-19T05:59:59.999Z",
    },
  });

  await pollDataReleaseUpdates({
    now: "2026-08-19T12:00:00Z", repository,
    fetchCalendar: async () => calendarResult([]), persist: true,
  });

  assert.deepEqual((await repository.getMeta(WEEKLY_CALENDAR_META_KEY)).events, []);
});

test("preserves a legacy auxiliary baseline across an empty snapshot and migrates it on official verification", async () => {
  const eventKey = "us-cpi-yoy-2026-08|2026-08-19T12:30:00.000Z";
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: {
      calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z",
    },
    [RELEASE_STATE_META_KEY]: {
      calendarWeek: "2026-08-17",
      monitoredEvents: [{
        eventKey, id: "us-cpi-yoy-2026-08", scheduledAt, lastActual: "2.7%",
        observedAt: "2026-08-19T12:30:10.000Z",
      }],
      publishedKeys: [], timedOutKeys: [], updatedAt: "2026-08-19T12:30:00.000Z",
    },
  });

  const empty = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository,
    fetchCalendar: async () => calendarResult([]), persist: true,
  });
  const stateAfterEmpty = await repository.getMeta(RELEASE_STATE_META_KEY);
  const unchanged = await pollDataReleaseUpdates({
    now: "2026-08-19T12:32:00Z", repository,
    fetchCalendar: async () => calendarResult([
      release({ values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" } }),
    ]),
    persist: true,
  });

  assert.equal(empty.publishable, false);
  assert.equal(stateAfterEmpty.monitoredEvents[0].lastActual, "2.7%");
  assert.equal(unchanged.publishable, true);
  assert.equal(unchanged.event.values.actual, "2.7%");
});

test("does not cache a soft-failed bootstrap response or overwrite the stale calendar", async () => {
  const staleCalendar = {
    calendarWeek: "2026-08-10", events: [release()], updatedAt: "2026-08-10T00:30:00Z",
  };
  const repository = repositoryDouble({ [WEEKLY_CALENDAR_META_KEY]: staleCalendar });
  let calls = 0;
  const fetchCalendar = async () => {
    calls += 1;
    return calendarResult([], {
      sources: [{ id: "tradingview-calendar", status: "timeout" }],
      warnings: ["TradingView calendar timed out."],
    });
  };
  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:00:00Z", repository,
    fetchCalendar,
    persist: true,
  });
  const throttled = await pollDataReleaseUpdates({
    now: "2026-08-19T12:00:30Z", repository, fetchCalendar, persist: true,
  });

  assert.equal(result.publishable, false);
  assert.equal(result.skipReason, "calendar-unavailable");
  assert.ok(result.warnings.some((warning) => /timed out/i.test(warning)));
  assert.deepEqual(await repository.getMeta(WEEKLY_CALENDAR_META_KEY), staleCalendar);
  assert.equal(repository.writes.some(([key]) => key === WEEKLY_CALENDAR_META_KEY), false);
  assert.equal(calls, 1);
  assert.equal(throttled.skipReason, "poll-interval");
  const state = await repository.getMeta(RELEASE_STATE_META_KEY);
  assert.deepEqual(Object.keys(state).sort(), ["calendarWeek", "monitoredEvents", "publishedKeys", "timedOutKeys", "updatedAt"]);
  assert.equal(state.updatedAt, "2026-08-19T12:00:00.000Z");
});

test("preserves a valid cached calendar when an in-window Actual refresh soft-fails", async () => {
  const cachedCalendar = {
    calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z",
  };
  const repository = repositoryDouble({ [WEEKLY_CALENDAR_META_KEY]: cachedCalendar });
  let calls = 0;
  const fetchCalendar = async () => {
    calls += 1;
    return calendarResult([], {
      sources: [{ id: "tradingview-calendar", status: "error" }],
      warnings: ["TradingView calendar failed."],
    });
  };
  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository,
    fetchCalendar,
    persist: true,
  });
  const throttled = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:30Z", repository, fetchCalendar, persist: true,
  });

  assert.equal(result.publishable, false);
  assert.equal(result.skipReason, "calendar-unavailable");
  assert.ok(result.warnings.some((warning) => /failed/i.test(warning)));
  assert.deepEqual(await repository.getMeta(WEEKLY_CALENDAR_META_KEY), cachedCalendar);
  assert.equal(repository.writes.some(([key]) => key === WEEKLY_CALENDAR_META_KEY), false);
  assert.equal(throttled.skipReason, "poll-interval");
  assert.equal(calls, 1);
});

test("persists a live adapter exception as the last check and throttles the next poll", async () => {
  const cachedCalendar = {
    calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z",
  };
  const repository = repositoryDouble({ [WEEKLY_CALENDAR_META_KEY]: cachedCalendar });
  let calls = 0;
  const fetchCalendar = async () => {
    calls += 1;
    throw new Error("upstream unavailable");
  };

  const failed = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository, fetchCalendar, persist: true,
  });
  const throttled = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:30Z", repository, fetchCalendar, persist: true,
  });

  assert.equal(failed.skipReason, "calendar-unavailable");
  assert.equal(throttled.skipReason, "poll-interval");
  assert.equal(calls, 1);
  assert.deepEqual(await repository.getMeta(WEEKLY_CALENDAR_META_KEY), cachedCalendar);
  const state = await repository.getMeta(RELEASE_STATE_META_KEY);
  assert.deepEqual(Object.keys(state).sort(), ["calendarWeek", "monitoredEvents", "publishedKeys", "timedOutKeys", "updatedAt"]);
  assert.equal(state.updatedAt, "2026-08-19T12:31:00.000Z");
});

test("does not persist throttle state for a dry-run adapter failure", async () => {
  const repository = repositoryDouble();
  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:00:00Z", repository,
    fetchCalendar: async () => { throw new Error("offline"); },
    persist: false,
  });

  assert.equal(result.skipReason, "calendar-unavailable");
  assert.equal(repository.writes.length, 0);
  assert.equal(await repository.getMeta(RELEASE_STATE_META_KEY), null);
});

test("accepts and caches an empty calendar from a successful source", async () => {
  const repository = repositoryDouble();
  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:00:00Z", repository,
    fetchCalendar: async () => calendarResult([]), persist: true,
  });

  assert.equal(result.publishable, false);
  assert.equal(result.skipReason, "no-monitored-event");
  assert.deepEqual((await repository.getMeta(WEEKLY_CALENDAR_META_KEY)).events, []);
});

test("rejects conflicting source Actual values and returns both raw values", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z" },
  });
  const first = release({ values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" }, rawValues: { actual: "2.7", unit: "%" }, source: { id: "tv" } });
  const second = release({ values: { actual: "2.8%", forecast: "2.8%", previous: "2.9%" }, rawValues: { actual: "2.8", unit: "%" }, source: { id: "bls" } });
  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository,
    fetchCalendar: async () => calendarResult([first, second]),
    fetchOfficialActual: async () => [
      officialActual("2.7"),
      officialActual("2.8", { sourceId: "bls-cpi-revision" }),
    ],
    persist: true,
  });
  assert.equal(result.publishable, false);
  assert.equal(result.skipReason, "source-conflict");
  assert.deepEqual(result.conflict.rawValues, ["2.7", "2.8"]);
  assert.deepEqual(result.sources, calendarResult([]).sources);
  assert.equal(result.nextMonitoredEvent, null);
});

test("waits for every required composite Actual before publishing", async () => {
  const component = (id, actual) => ({
    id, sourceId: id, title: id,
    values: { actual, forecast: "2.9%", previous: "3.0%" },
    rawValues: { actual, unit: "%" },
  });
  const partial = release({
    components: [component("headline", "2.7%"), component("core", null)],
  });
  const complete = release({
    components: [component("headline", "2.7%"), component("core", "2.8%")],
  });
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: {
      calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z",
    },
  });

  const pending = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository,
    fetchCalendar: async () => calendarResult([partial]), persist: true,
  });
  const published = await pollDataReleaseUpdates({
    now: "2026-08-19T12:32:00Z", repository,
    fetchCalendar: async () => calendarResult([complete]), persist: true,
  });

  assert.equal(buildReleaseDeduplicationKey(partial), null);
  assert.equal(pending.publishable, false);
  assert.equal(pending.skipReason, "official-actual-unavailable");
  assert.deepEqual(pending.sources, calendarResult([]).sources);
  assert.equal(pending.nextMonitoredEvent.id, partial.id);
  assert.equal(published.publishable, true);
  assert.deepEqual(published.sources, calendarResult([]).sources);
  assert.equal(published.deduplicationKey, buildReleaseDeduplicationKey(complete));
});

test("returns the official component values for a composite source conflict", async () => {
  const composite = (source, headline, core) => release({
    source: { id: source },
    components: [
      {
        id: "headline", sourceId: "headline", values: { actual: `${headline}%` },
        rawValues: { actual: headline, unit: "%" },
      },
      {
        id: "core", sourceId: "core", values: { actual: `${core}%` },
        rawValues: { actual: core, unit: "%" },
      },
    ],
  });
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: {
      calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z",
    },
  });

  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository,
    fetchCalendar: async () => calendarResult([
      composite("tv", "2.7", "2.8"),
      composite("bls", "2.6", "2.9"),
    ]),
    fetchOfficialActual: async () => [
      officialActual("2.7/2.8", { value: "2.7/2.8", unit: "composite", sourceId: "bls-cpi" }),
      officialActual("2.6/2.9", { value: "2.6/2.9", unit: "composite", sourceId: "bls-cpi-revision" }),
    ],
    persist: true,
  });

  assert.equal(result.skipReason, "source-conflict");
  assert.deepEqual(result.conflict.rawValues, ["2.7/2.8", "2.6/2.9"]);
});

test("does not report a conflict for equivalent numeric Actual formatting", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z" },
  });
  const first = release({ values: { actual: "2.70%" }, rawValues: { actual: "2.70", unit: "%" } });
  const second = release({ values: { actual: "2.7 %" }, rawValues: { actual: "2.7", unit: "%" } });
  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository,
    fetchCalendar: async () => calendarResult([first, second]), persist: true,
  });
  assert.equal(result.publishable, true);
  assert.equal(result.skipReason, undefined);
});

test("rejects an Actual observed before release and does not fetch reaction", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z" },
  });
  let reactionCalls = 0;
  const stale = release({
    observedAt: "2026-08-19T12:29:00Z",
    values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" },
  });
  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository,
    fetchCalendar: async () => calendarResult([stale]),
    fetchReaction: async () => { reactionCalls += 1; return {}; },
    persist: true,
  });
  assert.equal(result.publishable, false);
  assert.equal(result.skipReason, "stale-actual");
  assert.equal(reactionCalls, 0);
});

test("records a timeout after the release window without publishing", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z" },
  });
  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:45:01Z", repository,
    fetchCalendar: async () => calendarResult([release()]), persist: true,
  });
  assert.equal(result.publishable, false);
  assert.equal(result.skipReason, "release-timeout");
  assert.deepEqual((await repository.getMeta(RELEASE_STATE_META_KEY)).timedOutKeys, [
    "us-cpi-yoy-2026-08|2026-08-19T12:30:00.000Z",
  ]);
});

test("records a timeout when the only Actual is a stale pre-release observation", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z" },
  });
  const stale = release({
    observedAt: "2026-08-19T12:29:00Z",
    values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" },
  });
  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:45:01Z", repository,
    fetchCalendar: async () => calendarResult([stale]), persist: true,
  });
  assert.equal(result.publishable, false);
  assert.equal(result.skipReason, "release-timeout");
  assert.deepEqual((await repository.getMeta(RELEASE_STATE_META_KEY)).timedOutKeys, [
    "us-cpi-yoy-2026-08|2026-08-19T12:30:00.000Z",
  ]);
});

test("official eligibility blocks an auxiliary actual without acknowledging it and permits a later official actual", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z" },
  });
  const auxiliary = release({
    values: { actual: "2.8%", forecast: "2.8%", previous: "2.9%" },
    rawValues: { actual: "2.8", forecast: "2.8", previous: "2.9", unit: "%" },
    source: { id: "tradingview-calendar", authority: "auxiliary", url: "https://www.tradingview.com/economic-calendar/" },
  });
  let official = null;
  const fetchCalendar = async () => calendarResult([auxiliary]);
  const fetchOfficialActual = async () => official;

  const blocked = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository, fetchCalendar, fetchOfficialActual, persist: true,
  });
  const blockedState = await repository.getMeta(RELEASE_STATE_META_KEY);
  official = officialActual("2.7");
  const released = await pollDataReleaseUpdates({
    now: "2026-08-19T12:32:00Z", repository, fetchCalendar, fetchOfficialActual, persist: true,
  });

  assert.equal(blocked.publishable, false);
  assert.equal(blocked.skipReason, "official-actual-unavailable");
  assert.equal(blocked.eligibility.publishable, false);
  assert.deepEqual(blockedState.publishedKeys, []);
  assert.equal(blockedState.monitoredEvents[0].lastActual, null);
  assert.equal(released.publishable, true);
  assert.equal(released.event.values.actual, "2.7%");
});

test("official eligibility prepares one event when the official actual arrives inside the window", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z" },
  });
  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z",
    repository,
    fetchCalendar: async () => calendarResult([release()]),
    fetchOfficialActual: async () => officialActual("2.7"),
    persist: true,
  });

  assert.equal(result.publishable, true);
  assert.equal(result.event.values.actual, "2.7%");
  assert.equal(result.eligibility.publishable, true);
  assert.ok(result.sourceManifest.some((source) => source.id === "bls-cpi"));
});

test("official eligibility rejects an official actual timestamped before its schedule", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z" },
  });
  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z",
    repository,
    fetchCalendar: async () => calendarResult([release()]),
    fetchOfficialActual: async () => officialActual("2.7", { publishedAt: "2026-08-19T12:29:59.999Z" }),
    persist: true,
  });

  assert.equal(result.publishable, false);
  assert.equal(result.skipReason, "stale-actual");
  assert.equal(result.eligibility.publishable, false);
  assert.equal((await repository.getMeta(RELEASE_STATE_META_KEY)).monitoredEvents[0].lastActual, null);
});

test("official eligibility selects the official value and retains a disagreeing auxiliary comparison", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z" },
  });
  const auxiliary = release({
    values: { actual: "2.8%", forecast: "2.8%", previous: "2.9%" },
    rawValues: { actual: "2.8", forecast: "2.8", previous: "2.9", unit: "%" },
    source: { id: "tradingview-calendar", authority: "auxiliary", url: "https://www.tradingview.com/economic-calendar/" },
  });
  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository,
    fetchCalendar: async () => calendarResult([auxiliary]),
    fetchOfficialActual: async () => officialActual("2.7"),
    persist: true,
  });

  assert.equal(result.publishable, true);
  assert.equal(result.event.values.actual, "2.7%");
  assert.ok(result.eligibility.actual.comparisons.some((comparison) => (
    comparison.sourceId === "tradingview-calendar" && comparison.value === "2.8%"
  )));
});

test("official eligibility fails closed when two official actuals conflict", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z" },
  });
  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository,
    fetchCalendar: async () => calendarResult([release()]),
    fetchOfficialActual: async () => [
      officialActual("2.7"),
      officialActual("2.8", { sourceId: "bls-cpi-revision" }),
    ],
    persist: true,
  });

  assert.equal(result.publishable, false);
  assert.equal(result.skipReason, "source-conflict");
  assert.equal(result.eligibility.publishable, false);
  assert.deepEqual((await repository.getMeta(RELEASE_STATE_META_KEY)).publishedKeys, []);
});

test("official eligibility returns specific unit and timezone ambiguity reasons", async () => {
  for (const [candidate, official, expected] of [
    [release({
      values: { actual: "180K", forecast: "175K", previous: "170K" },
      rawValues: { actual: "180", forecast: "175", previous: "170", unit: "K" },
      source: { id: "tradingview-calendar", authority: "auxiliary", url: "https://www.tradingview.com/economic-calendar/" },
    }), officialActual("180", { unit: "%", value: "180%" }), "unit-conflict"],
    [release({ schedule: { status: "timezone-conflict" } }), officialActual("2.7"), "timezone-conflict"],
  ]) {
    const repository = repositoryDouble({
      [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z" },
    });
    const result = await pollDataReleaseUpdates({
      now: "2026-08-19T12:31:00Z", repository,
      fetchCalendar: async () => calendarResult([candidate]),
      fetchOfficialActual: async () => official,
      persist: true,
    });
    assert.equal(result.publishable, false);
    assert.equal(result.skipReason, expected);
  }
});

test("official eligibility preserves sequential idempotent publication for simultaneous releases", async () => {
  const core = release({ id: "us-core-cpi-yoy-2026-08", sourceId: "us-core-cpi-yoy-2026-08", title: "US Core CPI YoY" });
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release(), core], updatedAt: "2026-08-19T10:00:00Z" },
  });
  const fetchCalendar = async () => calendarResult([release(), core]);
  const fetchOfficialActual = async ({ event }) => (
    event.id === core.id
      ? officialActual("3.1", { sourceId: "bls-core-cpi" })
      : officialActual("2.7")
  );

  const first = await pollDataReleaseUpdates({ now: "2026-08-19T12:31:00Z", repository, fetchCalendar, fetchOfficialActual, persist: true });
  await acknowledgeDataReleasePublished({ repository, deduplicationKey: first.deduplicationKey, event: first.event, now: "2026-08-19T12:31:05Z" });
  const second = await pollDataReleaseUpdates({ now: "2026-08-19T12:32:00Z", repository, fetchCalendar, fetchOfficialActual, persist: true });
  await acknowledgeDataReleasePublished({ repository, deduplicationKey: second.deduplicationKey, event: second.event, now: "2026-08-19T12:32:05Z" });
  const duplicate = await pollDataReleaseUpdates({ now: "2026-08-19T12:33:00Z", repository, fetchCalendar, fetchOfficialActual, persist: true });

  assert.equal(first.publishable, true);
  assert.equal(second.publishable, true);
  assert.notEqual(first.event.id, second.event.id);
  assert.equal(duplicate.publishable, false);
  assert.equal(duplicate.skipReason, "duplicate-release");
  assert.equal((await repository.getMeta(RELEASE_STATE_META_KEY)).publishedKeys.length, 2);
});

test("official eligibility only invokes the official adapter for allowlisted events in the monitoring window", async () => {
  const unsupported = release({ id: "consumer-confidence", sourceId: "consumer-confidence", title: "US Consumer Confidence" });
  const future = release({ scheduledAt: "2026-08-19T14:00:00Z" });
  const repository = repositoryDouble();
  let calls = 0;
  await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository,
    fetchCalendar: async () => calendarResult([unsupported, future]),
    fetchOfficialActual: async () => { calls += 1; return officialActual(); },
    persist: true,
  });
  assert.equal(calls, 0);
});

test("official eligibility records a timeout when only an auxiliary actual exists after the release window", async () => {
  const auxiliary = release({
    values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" },
    source: { id: "calendar", authority: "auxiliary", url: "https://calendar.example/cpi" },
  });
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [auxiliary], updatedAt: "2026-08-19T12:45:30Z" },
  });
  let officialCalls = 0;

  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:46:00Z", repository,
    fetchCalendar: async () => calendarResult([auxiliary]),
    fetchOfficialActual: async () => { officialCalls += 1; return officialActual(); },
    persist: true,
  });

  assert.equal(result.publishable, false);
  assert.equal(result.skipReason, "release-timeout");
  assert.equal(officialCalls, 0);
  assert.deepEqual((await repository.getMeta(RELEASE_STATE_META_KEY)).timedOutKeys, [
    "us-cpi-yoy-2026-08|2026-08-19T12:30:00.000Z",
  ]);
});

test("a rejected auxiliary unit cannot override a verified official actual", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z" },
  });
  const rejectedAuxiliary = release({
    values: { actual: "180K", forecast: "175K", previous: "170K" },
    rawValues: { actual: "180", forecast: "175", previous: "170", unit: "K" },
    actualStatus: "rejected",
    source: { id: "calendar", authority: "auxiliary", url: "https://calendar.example/cpi" },
  });

  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository,
    fetchCalendar: async () => calendarResult([rejectedAuxiliary]),
    fetchOfficialActual: async () => officialActual("2.7"),
    persist: true,
  });

  assert.equal(result.publishable, true);
  assert.equal(result.event.values.actual, "2.7%");
  assert.ok(result.eligibility.actual.comparisons.some(({ status, unit }) => status === "rejected" && unit === "K"));
});

test("source manifest keeps authoritative official metadata for a duplicate source identity", async () => {
  const official = officialActual("2.7");
  const duplicateAuxiliary = release({
    values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" },
    rawValues: { actual: "2.7", forecast: "2.8", previous: "2.9", unit: "%" },
    source: { id: official.sourceId, url: official.sourceUrl, authority: "auxiliary", status: "verified" },
  });
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z" },
  });

  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository,
    fetchCalendar: async () => calendarResult([duplicateAuxiliary], {
      sources: [{
        id: official.sourceId, url: official.sourceUrl, authority: "auxiliary", status: "verified",
        retrievedAt: "2026-08-19T12:30:19Z",
      }],
    }),
    fetchOfficialActual: async () => official,
    persist: true,
  });

  assert.equal(result.publishable, true);
  assert.deepEqual(result.sourceManifest.filter(({ id, url }) => id === official.sourceId && url === official.sourceUrl), [{
    id: official.sourceId,
    url: official.sourceUrl,
    authority: "official",
    status: "verified",
    retrievedAt: official.retrievedAt,
    publishedAt: official.publishedAt,
  }]);
});

test("tier-one schedules without an explicit timezone fail closed without using the host timezone", async () => {
  const ambiguous = release({ scheduledAt: "2026-08-19T20:30:00" });
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [ambiguous], updatedAt: "2026-08-19T10:00:00Z" },
  });
  let officialCalls = 0;

  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository,
    fetchCalendar: async () => calendarResult([ambiguous]),
    fetchOfficialActual: async () => { officialCalls += 1; return officialActual(); },
    persist: true,
  });

  assert.equal(result.publishable, false);
  assert.equal(result.skipReason, "timezone-ambiguous");
  assert.equal(result.eligibility.reason, "timezone-ambiguous");
  assert.equal(officialCalls, 0);
  assert.deepEqual((await repository.getMeta(RELEASE_STATE_META_KEY)).timedOutKeys, []);
});

test("legacy auxiliary lastActual does not suppress the first verified official publication", async () => {
  const eventKey = "us-cpi-yoy-2026-08|2026-08-19T12:30:00.000Z";
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-19T10:00:00Z" },
    [RELEASE_STATE_META_KEY]: {
      calendarWeek: "2026-08-17",
      monitoredEvents: [{ eventKey, id: "us-cpi-yoy-2026-08", scheduledAt, lastActual: "2.7%", observedAt: "2026-08-19T12:30:10Z" }],
      publishedKeys: [], timedOutKeys: [], updatedAt: "2026-08-19T12:30:00Z",
    },
  });

  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository,
    fetchCalendar: async () => calendarResult([release()]),
    fetchOfficialActual: async () => officialActual("2.7"),
    persist: true,
  });

  assert.equal(result.publishable, true);
  assert.equal(result.event.values.actual, "2.7%");
  await acknowledgeDataReleasePublished({
    repository,
    deduplicationKey: result.deduplicationKey,
    event: result.event,
    now: "2026-08-19T12:31:05Z",
  });
  const migratedState = await repository.getMeta(RELEASE_STATE_META_KEY);
  assert.equal(migratedState.monitoredEvents[0].lastActualAuthority, "official");
});

test("one official fetch failure does not block another simultaneous valid release", async () => {
  const core = release({ id: "us-core-cpi-yoy-2026-08", sourceId: "us-core-cpi-yoy-2026-08", title: "US Core CPI YoY" });
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release(), core], updatedAt: "2026-08-19T10:00:00Z" },
  });

  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository,
    fetchCalendar: async () => calendarResult([release(), core]),
    fetchOfficialActual: async ({ event }) => {
      if (event.id === "us-cpi-yoy-2026-08") throw new Error("BLS headline probe failed");
      return officialActual("3.1", { sourceId: "bls-core-cpi" });
    },
    persist: true,
  });

  assert.equal(result.publishable, true);
  assert.equal(result.event.id, core.id);
  assert.match(result.warnings.join("\n"), /BLS headline probe failed/);
});
