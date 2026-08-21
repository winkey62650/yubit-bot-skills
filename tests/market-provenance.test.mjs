import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSourcedField,
  reconcileSourcedField,
  reconcileCalendarEvents,
  validateWeeklyPublication,
  validateDataReleasePublication,
} from "../lib/market-provenance.mjs";

const RETRIEVED_AT = "2026-08-12T12:30:05.000Z";
const PUBLISHED_AT = "2026-08-12T12:30:00.000Z";

function sourceInput(overrides = {}) {
  return {
    authority: "official",
    sourceId: "bls-cpi",
    sourceUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
    retrievedAt: RETRIEVED_AT,
    publishedAt: PUBLISHED_AT,
    comparisons: [],
    ...overrides,
  };
}

function sourcedField(overrides = {}) {
  return sourceInput({
    value: "3.4%",
    rawValue: "3.4",
    unit: "%",
    status: "verified",
    ...overrides,
  });
}

function verifiedSchedule(overrides = {}) {
  return sourceInput({
    value: "2026-08-12T12:30:00.000Z",
    rawValue: "2026-08-12T12:30:00.000Z",
    status: "verified",
    sourceId: "bls-calendar",
    sourceUrl: "https://www.bls.gov/schedule/news_release/",
    ...overrides,
  });
}

test("normalizes the sourced-field contract without dropping provenance", () => {
  assert.deepEqual(normalizeSourcedField({
    rawValue: "3.4",
    unit: "%",
    authority: "official",
    sourceId: "bls-cpi",
    sourceUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
    retrievedAt: RETRIEVED_AT,
    publishedAt: PUBLISHED_AT,
  }), sourcedField());
});

test("an official actual overrides an auxiliary actual while retaining the comparison", () => {
  const actual = reconcileSourcedField([
    sourcedField({ authority: "auxiliary", sourceId: "tradingview-calendar", sourceUrl: "https://www.tradingview.com/economic-calendar/", value: "3.3%", rawValue: "3.3" }),
    sourcedField(),
  ]);

  assert.equal(actual.value, "3.4%");
  assert.equal(actual.authority, "official");
  assert.equal(actual.status, "verified");
  assert.equal(actual.comparisons.length, 1);
  assert.equal(actual.comparisons[0].sourceId, "tradingview-calendar");
  assert.equal(actual.comparisons[0].value, "3.3%");
});

test("conflicting official actuals fail closed", () => {
  const actual = reconcileSourcedField([
    sourcedField(),
    sourcedField({ sourceId: "bls-cpi-revision", value: "3.5%", rawValue: "3.5" }),
  ]);

  assert.equal(actual.status, "conflicting");
  assert.equal(actual.publishable, false);
});

test("terminal field statuses cannot be laundered into verified fields", () => {
  const result = reconcileSourcedField([
    sourcedField({ status: "rejected" }),
    sourcedField({ authority: "auxiliary", sourceId: "tradingview-calendar" }),
  ]);

  assert.equal(result.status, "rejected");
  assert.equal(result.publishable, false);
});

test("an auxiliary field rejection remains a comparison and cannot veto an official actual", () => {
  const result = reconcileSourcedField([
    sourcedField(),
    sourcedField({ authority: "auxiliary", sourceId: "tradingview-calendar", status: "rejected" }),
  ]);

  assert.equal(result.status, "verified");
  assert.equal(result.publishable, true);
  assert.equal(result.comparisons[0].status, "rejected");
});

test("infers literal unit suffixes before reconciling equivalent and incompatible units", () => {
  const inferredPercent = normalizeSourcedField(sourceInput({ rawValue: "3.4%" }));
  const inferredThousands = normalizeSourcedField(sourceInput({ rawValue: "3.4K" }));
  const matching = reconcileSourcedField([
    sourceInput({ value: "3.4", rawValue: "3.4", unit: "%" }),
    sourceInput({ authority: "auxiliary", sourceId: "tradingview-calendar", rawValue: "3.4%" }),
  ]);
  const incompatible = reconcileSourcedField([
    sourceInput({ rawValue: "3.4%" }),
    sourceInput({ authority: "auxiliary", sourceId: "jobs-calendar", rawValue: "3.4K" }),
  ]);

  assert.deepEqual({ value: inferredPercent.value, rawValue: inferredPercent.rawValue, unit: inferredPercent.unit }, {
    value: "3.4%", rawValue: "3.4", unit: "%",
  });
  assert.deepEqual({ value: inferredThousands.value, rawValue: inferredThousands.rawValue, unit: inferredThousands.unit }, {
    value: "3.4K", rawValue: "3.4", unit: "K",
  });
  assert.equal(matching.status, "verified");
  assert.equal(matching.value, "3.4%");
  assert.equal(incompatible.status, "unit-conflict");
  assert.equal(incompatible.publishable, false);
});

test("timezone-ambiguous tier-one events are excluded from the priority three", () => {
  const result = reconcileCalendarEvents([
    { id: "us-cpi", title: "US CPI", scheduledAt: "2026-08-12", impactScore: 99 },
    { id: "pce", title: "US PCE", scheduledAt: "2026-08-13T12:30:00.000Z", impactScore: 98 },
    { id: "gdp", title: "US GDP", scheduledAt: "2026-08-14T12:30:00.000Z", impactScore: 97 },
    { id: "retail-sales", title: "US Retail Sales", scheduledAt: "2026-08-15T12:30:00.000Z", impactScore: 96 },
  ]);

  assert.equal(result.events[0].schedule.status, "timezone-conflict");
  assert.equal(result.events[0].publishable, false);
  assert.equal(result.topThree.some((event) => event.id === "us-cpi"), false);
});

test("weekly schedules allow a bounded stale official cache but data updates reject cached actuals", () => {
  const staleEvent = reconcileCalendarEvents([{
    id: "us-cpi", title: "US CPI", scheduledAtSources: [verifiedSchedule({ status: "cached" })],
  }]).events[0];
  const weekly = validateWeeklyPublication({
    events: [staleEvent],
    source: sourceInput({ cached: true, retrievedAt: "2026-08-12T06:30:00.000Z" }),
  }, { now: "2026-08-12T12:30:00.000Z" });
  const tooOld = validateWeeklyPublication({
    events: [staleEvent],
    source: sourceInput({ cached: true, retrievedAt: "2026-08-12T06:29:59.000Z" }),
  }, { now: "2026-08-12T12:30:00.000Z" });
  const dataUpdate = validateDataReleasePublication({ actual: sourcedField({ status: "cached" }) });

  assert.equal(staleEvent.schedule.status, "cached");
  assert.deepEqual({ publishable: weekly.publishable, freshness: weekly.freshness, ageSeconds: weekly.ageSeconds }, {
    publishable: true, freshness: "stale", ageSeconds: 21600,
  });
  assert.equal(tooOld.publishable, false);
  assert.equal(dataUpdate.publishable, false);
  assert.equal(dataUpdate.reason, "cached-actual");
});

test("authoritative schedule blocking statuses survive reconciliation and reject weekly publication", () => {
  for (const status of ["rejected", "conflicting"]) {
    const reconciled = reconcileCalendarEvents([{
      id: "us-cpi", title: "US CPI", scheduledAtSources: [verifiedSchedule({ status })],
    }]);
    const event = reconciled.events[0];
    const weekly = validateWeeklyPublication({
      events: [event],
      source: sourceInput({ retrievedAt: "2026-08-12T12:30:00.000Z" }),
    }, { now: "2026-08-12T12:30:00.000Z" });

    assert.equal(event.schedule.status, status);
    assert.equal(event.publishable, false);
    assert.equal(weekly.publishable, false);
  }
});

test("official schedule blockers and timezone ambiguity are order independent", () => {
  const source = sourceInput({ retrievedAt: "2026-08-12T12:30:00.000Z" });
  const verified = verifiedSchedule();
  const rejected = verifiedSchedule({ sourceId: "bls-calendar-revision", status: "rejected" });
  const ambiguous = verifiedSchedule({
    sourceId: "bls-calendar-revision",
    value: "2026-08-12",
    rawValue: "2026-08-12",
  });

  for (const sources of [[verified, rejected], [rejected, verified]]) {
    const event = reconcileCalendarEvents([{ id: "us-cpi", title: "US CPI", scheduledAtSources: sources }]).events[0];
    const weekly = validateWeeklyPublication({ events: [event], source }, { now: "2026-08-12T12:30:00.000Z" });

    assert.equal(event.schedule.status, "rejected");
    assert.equal(weekly.publishable, false);
  }

  for (const sources of [[verified, ambiguous], [ambiguous, verified]]) {
    const event = reconcileCalendarEvents([{ id: "us-cpi", title: "US CPI", scheduledAtSources: sources }]).events[0];
    const weekly = validateWeeklyPublication({ events: [event], source }, { now: "2026-08-12T12:30:00.000Z" });

    assert.equal(event.schedule.status, "timezone-conflict");
    assert.equal(weekly.publishable, false);
  }
});

test("a status-only cached source and accepted cached event are stale at zero age", () => {
  const event = reconcileCalendarEvents([{
    id: "us-cpi",
    title: "US CPI",
    scheduledAtSources: [verifiedSchedule({ status: "cached" })],
  }]).events[0];
  const weekly = validateWeeklyPublication({
    events: [event],
    source: sourceInput({ status: "cached", retrievedAt: "2026-08-12T12:30:00.000Z" }),
  }, { now: "2026-08-12T12:30:00.000Z" });

  assert.equal(weekly.publishable, true);
  assert.equal(weekly.ageSeconds, 0);
  assert.equal(weekly.freshness, "stale");
});

test("weekly publication rejects future retrieval timestamps and blocked sources", () => {
  const event = { id: "us-cpi", title: "US CPI", schedule: verifiedSchedule() };
  const future = validateWeeklyPublication({
    events: [event],
    source: sourceInput({ retrievedAt: "2026-08-12T12:31:00.000Z" }),
  }, { now: "2026-08-12T12:30:00.000Z" });
  const blocked = validateWeeklyPublication({
    events: [event],
    source: sourceInput({ retrievedAt: "2026-08-12T12:30:00.000Z", status: "conflicting" }),
  }, { now: "2026-08-12T12:30:00.000Z" });

  assert.equal(future.publishable, false);
  assert.equal(future.ageSeconds, -60);
  assert.equal(blocked.publishable, false);
});

test("weekly publication rejects empty or raw events without verified schedule provenance", () => {
  const source = sourceInput({ retrievedAt: "2026-08-12T12:30:00.000Z" });
  const empty = validateWeeklyPublication({ events: [], source }, { now: "2026-08-12T12:30:00.000Z" });
  const rawTierOne = validateWeeklyPublication({
    events: [{ id: "us-cpi", title: "US CPI", scheduledAt: "2026-08-12" }],
    source,
  }, { now: "2026-08-12T12:30:00.000Z" });

  assert.equal(empty.publishable, false);
  assert.equal(rawTierOne.publishable, false);
});

test("a valid official actual remains publishable without a forecast or surprise", () => {
  const result = validateDataReleasePublication({ actual: sourcedField(), forecast: null });

  assert.equal(result.publishable, true);
  assert.equal(result.forecast, null);
  assert.equal(result.surprise, null);
});

test("data updates require explicit verified status and complete official actual provenance", () => {
  const incompleteActuals = [
    sourceInput({ value: "3.4%", rawValue: "3.4", unit: "%" }),
    sourcedField({ status: undefined }),
    sourcedField({ sourceId: "" }),
    sourcedField({ sourceUrl: "not-a-url" }),
    sourcedField({ retrievedAt: "not-a-date" }),
    sourcedField({ publishedAt: null }),
  ];

  for (const actual of incompleteActuals) {
    assert.equal(validateDataReleasePublication({ actual }).publishable, false);
  }
});

test("conflicting or rejected forecasts are omitted with their surprise", () => {
  for (const status of ["conflicting", "rejected"]) {
    const result = validateDataReleasePublication({
      actual: sourcedField(),
      forecast: sourcedField({ authority: "auxiliary", sourceId: "tradingview-calendar", rawValue: "3.3", value: "3.3%", status }),
    });

    assert.equal(result.forecast, null);
    assert.equal(result.surprise, null);
  }
});

test("calendar reconciliation does not mutate schedule inputs and is idempotent", () => {
  const event = {
    id: "us-cpi",
    title: "US CPI",
    scheduledAt: "2026-08-12T12:30:00.000Z",
    scheduledAtSources: [verifiedSchedule()],
  };
  const before = structuredClone(event);
  const first = reconcileCalendarEvents([event]);
  const second = reconcileCalendarEvents([event]);

  assert.deepEqual(event, before);
  assert.deepEqual(second, first);
});
