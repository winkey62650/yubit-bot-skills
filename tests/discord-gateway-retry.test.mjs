import assert from "node:assert/strict";
import test from "node:test";

import { getDiscordGatewayRetryAt } from "../lib/discord-gateway-retry.mjs";

test("waits until the Discord session limit reset time before retrying", () => {
  const retryAt = getDiscordGatewayRetryAt(
    new Error("Not enough sessions remaining; resets at 2026-08-14T06:48:33.848Z"),
    { now: new Date("2026-08-14T06:00:00.000Z") },
  );

  assert.equal(retryAt.toISOString(), "2026-08-14T06:48:35.848Z");
});

test("uses a bounded fallback delay for other login failures", () => {
  const retryAt = getDiscordGatewayRetryAt(new Error("network unavailable"), {
    now: new Date("2026-08-14T06:00:00.000Z"),
  });

  assert.equal(retryAt.toISOString(), "2026-08-14T06:01:00.000Z");
});
