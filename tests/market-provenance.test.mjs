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
  const weekly = validateWeeklyPublication({
    events: [{ id: "us-cpi", title: "US CPI", scheduledAt: "2026-08-12T12:30:00.000Z" }],
    source: { authority: "official", cached: true, retrievedAt: "2026-08-12T06:30:00.000Z" },
  }, { now: "2026-08-12T12:30:00.000Z" });
  const tooOld = validateWeeklyPublication({
    events: [{ id: "us-cpi", title: "US CPI", scheduledAt: "2026-08-12T12:30:00.000Z" }],
    source: { authority: "official", cached: true, retrievedAt: "2026-08-12T06:29:59.000Z" },
  }, { now: "2026-08-12T12:30:00.000Z" });
  const dataUpdate = validateDataReleasePublication({ actual: sourcedField({ status: "cached" }) });

  assert.deepEqual({ publishable: weekly.publishable, freshness: weekly.freshness, ageSeconds: weekly.ageSeconds }, {
    publishable: true, freshness: "stale", ageSeconds: 21600,
  });
  assert.equal(tooOld.publishable, false);
  assert.equal(dataUpdate.publishable, false);
  assert.equal(dataUpdate.reason, "cached-actual");
});

test("a valid official actual remains publishable without a forecast or surprise", () => {
  const result = validateDataReleasePublication({ actual: sourcedField(), forecast: null });

  assert.equal(result.publishable, true);
  assert.equal(result.forecast, null);
  assert.equal(result.surprise, null);
});
