import assert from "node:assert/strict";
import test from "node:test";
import {
  scoreMarketImpact,
  selectMarketImpactStories,
} from "../lib/market-impact-ranking.mjs";

const now = new Date("2026-08-20T10:00:00.000Z");

function candidate(id, overrides = {}) {
  return {
    id,
    title: `Story ${id}`,
    publishedAt: "2026-08-20T08:00:00.000Z",
    marketReaction: { magnitudeScore: 0 },
    policySystemicScore: 0,
    capitalFlowScore: 0,
    sourceConfirmations: 1,
    ...overrides,
  };
}

test("market-impact score applies the approved 35/25/20/10/10 weights", () => {
  const result = scoreMarketImpact(candidate("full", {
    marketReaction: { magnitudeScore: 1 },
    policySystemicScore: 1,
    capitalFlowScore: 1,
    sourceConfirmations: 3,
    publishedAt: "2026-08-20T09:00:00.000Z",
  }), now);

  assert.equal(result.score, 100);
  assert.deepEqual(result.components, {
    marketReaction: 35,
    policySystemic: 25,
    capitalFlow: 20,
    corroboration: 10,
    recency: 10,
  });
});

test("selector returns three core stories and at most two threshold-qualified watch items", () => {
  const candidates = [98, 86, 74, 63, 55, 20].map((value, index) => candidate(String(index), {
    impactScore: value,
  }));
  const selected = selectMarketImpactStories(candidates, now, { watchThreshold: 50 });

  assert.deepEqual(selected.map((item) => item.id), ["0", "1", "2", "3", "4"]);
  assert.deepEqual(selected.map((item) => item.selectionTier), ["core", "core", "core", "watch", "watch"]);
});

test("selector does not add category filler below the watch threshold", () => {
  const selected = selectMarketImpactStories([
    candidate("policy", { impactScore: 91, categories: ["regulation"] }),
    candidate("flow", { impactScore: 82, categories: ["btc-etf-institutional"] }),
    candidate("market", { impactScore: 77, categories: ["market-project"] }),
    candidate("filler", { impactScore: 12, categories: ["regulation"] }),
  ], now, { watchThreshold: 50 });

  assert.deepEqual(selected.map((item) => item.id), ["policy", "flow", "market"]);
});

test("equal scores are ordered deterministically by publication time then stable id", () => {
  const older = candidate("zulu", { impactScore: 60, publishedAt: "2026-08-20T07:00:00.000Z" });
  const newerB = candidate("bravo", { impactScore: 60, publishedAt: "2026-08-20T09:00:00.000Z" });
  const newerA = candidate("alpha", { impactScore: 60, publishedAt: "2026-08-20T09:00:00.000Z" });

  assert.deepEqual(
    selectMarketImpactStories([older, newerB, newerA], now).map((item) => item.id),
    ["alpha", "bravo", "zulu"],
  );
});

test("a publisher mentioning a regulator is not scored as an official policy source", () => {
  const result = scoreMarketImpact(candidate("industry-regulator-report", {
    title: "CFTC issues trading ban to former crypto executives",
    source: { id: "cointelegraph", url: "https://cointelegraph.com/news/example" },
  }), now);

  assert.equal(result.components.policySystemic, 0);
});
