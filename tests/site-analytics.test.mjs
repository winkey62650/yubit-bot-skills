import assert from "node:assert/strict";
import test from "node:test";

import { buildSiteAnalyticsUrl, fetchSiteAnalytics, normalizeSiteAnalyticsQuery } from "../lib/site-analytics.mjs";

test("site analytics query only accepts supported ranges and safe site ids", () => {
  assert.deepEqual(normalizeSiteAnalyticsQuery({ range: "7d", site: "crypto-guy" }), { range: "7d", site: "crypto-guy" });
  assert.deepEqual(normalizeSiteAnalyticsQuery({ range: "365d", site: "../../secret" }), { range: "30d", site: "all" });
});

test("site analytics URL defaults to the local collector without exposing credentials", () => {
  assert.equal(buildSiteAnalyticsUrl({ range: "90d", site: "all" }, {}), "http://127.0.0.1:4180/api/analytics?range=90d&site=all");
  assert.equal(buildSiteAnalyticsUrl({ range: "7d", site: "mmcrypto" }, { SITE_ANALYTICS_INTERNAL_URL: "http://analytics:4180/" }), "http://analytics:4180/api/analytics?range=7d&site=mmcrypto");
});

test("site analytics proxy unwraps the collector response", async () => {
  const expected = { kpis: { pv: 12 }, sites: [] };
  const data = await fetchSiteAnalytics({}, {
    env: {},
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: expected }) })
  });
  assert.deepEqual(data, expected);
});

test("site analytics proxy reports upstream failures", async () => {
  await assert.rejects(() => fetchSiteAnalytics({}, {
    env: {},
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: { message: "collector unavailable" } }) })
  }), /collector unavailable/);
});
