import assert from "node:assert/strict";
import test from "node:test";
import { classifyDataReleaseTier, scoreMarketImpact } from "../lib/market-impact-ranking.mjs";

const now = new Date("2026-08-21T08:00:00.000Z");

function officialStory(overrides = {}) {
  return {
    title: "Federal Reserve notice",
    summary: "A routine administrative notice.",
    publishedAt: "2026-08-21T06:00:00.000Z",
    url: "https://www.federalreserve.gov/newsevents/pressreleases/example.htm",
    source: { id: "federal-reserve", kind: "official", url: "https://www.federalreserve.gov" },
    ...overrides,
  };
}

test("official provenance alone does not create market-impact policy points", () => {
  const application = scoreMarketImpact(officialStory({
    title: "Federal Reserve Board announces approval of bank application",
    summary: "The Board approved an application by a commercial bank.",
  }), now);
  const employeeAction = scoreMarketImpact(officialStory({
    title: "Federal Reserve announces employee enforcement actions",
    summary: "The notices concern two former bank employees.",
  }), now);

  assert.equal(application.components.policySystemic, 0);
  assert.equal(employeeAction.components.policySystemic, 0);
});

test("a token-governance approval is not misread as regulatory policy", () => {
  const result = scoreMarketImpact({
    title: "Optimism vote approves moving $49 million in OP tokens",
    summary: "The governance plan reallocates tokens from future user airdrops to an ecosystem fund.",
    publishedAt: "2026-08-21T06:00:00.000Z",
    source: { id: "industry-wire", kind: "industry", url: "https://industry.example" },
  }, now);

  assert.equal(result.components.policySystemic, 0);
});

test("large ETF flows and broad short liquidations clear the decision threshold", () => {
  const etfFlow = scoreMarketImpact({
    title: "Bitcoin ETFs draw $517M in one-day inflow",
    summary: "US spot Bitcoin ETFs recorded $517 million in net inflows.",
    publishedAt: "2026-08-20T11:16:41.000Z",
  }, now);
  const squeeze = scoreMarketImpact({
    title: "Bitcoin breaks out as $3 billion in shorts get liquidated",
    summary: "The move produced broad short liquidations across crypto markets.",
    publishedAt: "2026-08-20T10:46:21.000Z",
  }, now);

  assert.equal(etfFlow.components.capitalFlow, 20);
  assert.ok(etfFlow.score >= 25);
  assert.equal(squeeze.components.policySystemic, 25);
  assert.ok(squeeze.score > etfFlow.score);
});

test("explicit monetary-policy and crypto-regulation actions retain full policy impact", () => {
  const rateDecision = scoreMarketImpact(officialStory({
    title: "FOMC rate decision changes the federal funds target range",
    summary: "The decision changes the policy rate and the outlook for dollar liquidity.",
  }), now);
  const cryptoRule = scoreMarketImpact(officialStory({
    title: "CFTC advances crypto market structure regulation",
    summary: "The rulemaking changes regulated access for digital-asset derivatives.",
    source: { id: "cftc", kind: "official", url: "https://www.cftc.gov" },
    url: "https://www.cftc.gov/PressRoom/PressReleases/example",
  }), now);

  assert.equal(rateDecision.components.policySystemic, 25);
  assert.equal(cryptoRule.components.policySystemic, 25);
});

test("CPI, Core CPI, PCE, Core PCE, NFP, unemployment, FOMC, and GDP are tier one", () => {
  const events = [
    "US CPI", "US Core CPI", "US PCE Price Index", "US Core PCE Price Index",
    "US Nonfarm Payrolls", "US Unemployment Rate", "FOMC Rate Decision", "FOMC Statement", "US GDP",
  ];

  for (const title of events) {
    assert.deepEqual(classifyDataReleaseTier({ title }, { score: 0, reasons: [] }), {
      tier: "tier-one", decision: "tier-one", score: 0, reasons: [],
    });
  }
});

test("secondary promotion and tier-one demotion retain explicit ranking evidence", () => {
  const promoted = classifyDataReleaseTier({ title: "US Retail Sales" }, {
    decision: "promoted", score: 80, reasons: ["marketReaction"], promotionThreshold: 75,
  });
  const insufficient = classifyDataReleaseTier({ title: "US Retail Sales" }, {
    decision: "promoted", score: 74, reasons: ["marketReaction"], promotionThreshold: 75,
  });
  const demoted = classifyDataReleaseTier({ title: "US CPI" }, {
    decision: "demoted", score: 20, reasons: ["official-calendar-correction"], promotionThreshold: 75,
  });

  assert.deepEqual(promoted, {
    tier: "tier-one", decision: "promoted", score: 80, reasons: ["marketReaction"],
  });
  assert.deepEqual(insufficient, {
    tier: "secondary", decision: "not-promoted", score: 74, reasons: ["marketReaction"],
  });
  assert.deepEqual(demoted, {
    tier: "secondary", decision: "demoted", score: 20, reasons: ["official-calendar-correction"],
  });
});

test("a promoted secondary event without ranking reasons remains secondary", () => {
  assert.deepEqual(classifyDataReleaseTier({ title: "US Retail Sales" }, {
    decision: "promoted", score: 80, reasons: [], promotionThreshold: 75,
  }), {
    tier: "secondary", decision: "not-promoted", score: 80, reasons: [],
  });
});
