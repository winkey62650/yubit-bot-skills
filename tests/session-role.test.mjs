import test from "node:test";
import assert from "node:assert/strict";

import { createSessionToken, verifySessionToken } from "../lib/session.js";

test("session token preserves account role", async () => {
  const token = await createSessionToken("publisher", "test-secret", "manual_publisher");
  const session = await verifySessionToken(token, "test-secret");
  assert.equal(session.sub, "publisher");
  assert.equal(session.role, "manual_publisher");
});

test("legacy session tokens default to admin", async () => {
  const token = await createSessionToken("admin", "test-secret");
  const session = await verifySessionToken(token, "test-secret");
  assert.equal(session.role, "admin");
});
