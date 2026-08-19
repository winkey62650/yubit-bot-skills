import assert from "node:assert/strict";
import test from "node:test";
import {
  RELEASE_STATE_META_KEY,
  WEEKLY_CALENDAR_META_KEY,
  buildReleaseDeduplicationKey,
  cacheWeeklyCalendar,
  pollDataReleaseUpdates,
  releaseWindowStatus,
  selectReleasableEvents,
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

test("exports stable repository keys and builds the exact normalized release key", () => {
  assert.equal(RELEASE_STATE_META_KEY, "market-content:release-state:v1");
  assert.equal(WEEKLY_CALENDAR_META_KEY, "market-content:weekly-calendar:v1");
  assert.equal(
    buildReleaseDeduplicationKey(release({ values: { actual: " 2.70 % " } })),
    '["us-cpi-yoy-2026-08","2026-08-19T12:30:00.000Z","2.7%"]',
  );
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

test("cacheWeeklyCalendar persists only when requested", async () => {
  const repository = repositoryDouble();
  const calendar = { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-17T00:30:00Z" };
  assert.deepEqual(await cacheWeeklyCalendar(repository, calendar), calendar);
  assert.deepEqual(await repository.getMeta(WEEKLY_CALENDAR_META_KEY), calendar);

  const dryRepository = repositoryDouble();
  assert.deepEqual(await cacheWeeklyCalendar(dryRepository, calendar, { persist: false }), calendar);
  assert.equal(await dryRepository.getMeta(WEEKLY_CALENDAR_META_KEY), null);
});

test("publishes a new Actual once and persists the exact state shape and deduplication key", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: {
      calendarWeek: "2026-08-17",
      events: [release()],
      updatedAt: "2026-08-17T00:30:00.000Z",
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

test("detects an Actual that appears on a later one-minute poll", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-17T00:30:00Z" },
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
  assert.equal(waiting.skipReason, "actual-unavailable");
  assert.equal(released.publishable, true);
});

test("never publishes an early Actual and rejects the unchanged value after release", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-17T00:30:00Z" },
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
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-17T00:30:00Z" },
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

test("rejects conflicting source Actual values and returns both raw values", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-17T00:30:00Z" },
  });
  const first = release({ values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" }, rawValues: { actual: "2.7", unit: "%" }, source: { id: "tv" } });
  const second = release({ values: { actual: "2.8%", forecast: "2.8%", previous: "2.9%" }, rawValues: { actual: "2.8", unit: "%" }, source: { id: "bls" } });
  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00Z", repository,
    fetchCalendar: async () => calendarResult([first, second]), persist: true,
  });
  assert.equal(result.publishable, false);
  assert.equal(result.skipReason, "source-conflict");
  assert.deepEqual(result.conflict.rawValues, ["2.7", "2.8"]);
});

test("does not report a conflict for equivalent numeric Actual formatting", async () => {
  const repository = repositoryDouble({
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-17T00:30:00Z" },
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
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-17T00:30:00Z" },
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
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-17T00:30:00Z" },
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
    [WEEKLY_CALENDAR_META_KEY]: { calendarWeek: "2026-08-17", events: [release()], updatedAt: "2026-08-17T00:30:00Z" },
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
