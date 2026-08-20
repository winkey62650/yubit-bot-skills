import assert from "node:assert/strict";
import test from "node:test";

import {
  checkProductionDatabase,
  classifyDatabaseFailure,
} from "../scripts/check-production-database.mjs";

test("database preflight rejects missing production configuration", async () => {
  await assert.rejects(
    checkProductionDatabase({ env: {}, query: async () => [{ ok: 1 }] }),
    /DATABASE_URL or POSTGRES_URL/,
  );
});

test("database preflight performs a real query", async () => {
  const calls = [];
  await checkProductionDatabase({
    env: { DATABASE_URL: "postgres://example.invalid/main" },
    query: async (url) => {
      calls.push(url);
      return [{ ok: 1 }];
    },
  });

  assert.deepEqual(calls, ["postgres://example.invalid/main"]);
});

test("database preflight classifies exhausted compute quota without leaking connection details", () => {
  const error = new Error(
    'Server error (HTTP status 402): {"message":"Your account or project has exceeded the compute time quota."}',
  );

  assert.equal(classifyDatabaseFailure(error), "compute quota exceeded");
});
