import assert from "node:assert/strict";
import { test } from "node:test";

const baseUrl = process.env.TEST_BASE_URL || "http://127.0.0.1:3100";

test("health and readiness endpoints report healthy", async () => {
  const [health, ready] = await Promise.all([
    fetch(`${baseUrl}/api/health`).then((response) => response.json()),
    fetch(`${baseUrl}/api/ready`).then((response) => response.json()),
  ]);
  assert.equal(health.ok, true);
  assert.equal(health.data.status, "ok");
  assert.equal(ready.ok, true);
  assert.equal(ready.data.checks.database, "ok");
});

test("dashboard API exposes complete metric contract without seeded business metrics", async () => {
  const response = await fetch(`${baseUrl}/api/analytics?range=30d&site=all`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.data.rangeDays, 30);
  assert.match(payload.data.dataMode, /^(empty|live)$/);
  assert.equal(payload.data.trend.length, 30);
  for (const field of ["pv", "uv", "ctaRate", "videoPlayRate", "avgDwellSeconds"]) {
    assert.equal(typeof payload.data.kpis[field], "number", `${field} should be numeric`);
  }
});

test("site registry and tracker are available", async () => {
  const sites = await fetch(`${baseUrl}/api/sites`).then((response) => response.json());
  assert.equal(sites.ok, true);
  assert.ok(sites.data.length >= 2);
  assert.ok(sites.data.some((site) => site.id === "crypto-guy"));

  const tracker = await fetch(`${baseUrl}/tracker.js?site=crypto-guy&key=test`);
  assert.equal(tracker.status, 200);
  assert.match(tracker.headers.get("content-type") || "", /javascript/);
  assert.match(await tracker.text(), /video_play/);
});

test("event ingestion rejects an invalid site key", async () => {
  const response = await fetch(`${baseUrl}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://crypto-guy.vercel.app" },
    body: JSON.stringify({
      siteId: "crypto-guy",
      key: "invalid-key",
      eventType: "page_view",
      anonymousId: "visitor-test",
      sessionId: "session-test",
      path: "/",
    }),
  });
  assert.equal(response.status, 403);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "FORBIDDEN");
});

test("a valid production event is reflected as live data without demo traffic", async () => {
  const suffix = Date.now().toString(36);
  const response = await fetch(`${baseUrl}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://crypto-guy.vercel.app" },
    body: JSON.stringify({
      siteId: "crypto-guy",
      key: "cg_local_7c2f4e91",
      eventType: "page_view",
      anonymousId: `visitor-${suffix}`,
      sessionId: `session-${suffix}`,
      path: "/acceptance-test",
    }),
  });
  assert.equal(response.status, 202);

  const payload = await fetch(`${baseUrl}/api/analytics?range=7d&site=crypto-guy`)
    .then((dashboardResponse) => dashboardResponse.json());
  assert.equal(payload.ok, true);
  assert.equal(payload.data.dataMode, "live");
  assert.ok(payload.data.kpis.pv >= 1);
});
