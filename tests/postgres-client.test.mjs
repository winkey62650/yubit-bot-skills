import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresClient, selectPostgresDriver } from "../lib/postgres-client.mjs";

test("local PostgreSQL URLs use the TCP pg driver", () => {
  assert.equal(selectPostgresDriver("postgresql://app@127.0.0.1/app"), "pg");
  assert.equal(selectPostgresDriver("postgresql://app@localhost/app"), "pg");
});

test("DATABASE_DRIVER overrides automatic driver selection", () => {
  assert.equal(selectPostgresDriver("postgresql://remote.example/app", { DATABASE_DRIVER: "pg" }), "pg");
  assert.equal(selectPostgresDriver("postgresql://127.0.0.1/app", { DATABASE_DRIVER: "neon" }), "neon");
});

test("pg query results are normalized to row arrays", async () => {
  const calls = [];
  const client = await createPostgresClient("postgresql://app@127.0.0.1/app", {
    env: {},
    createPool: () => ({
      async query(statement, params) {
        calls.push([statement, params]);
        return { rows: [{ ok: 1 }] };
      },
    }),
  });

  assert.deepEqual(await client.query("SELECT $1 AS ok", [1]), [{ ok: 1 }]);
  assert.deepEqual(calls, [["SELECT $1 AS ok", [1]]]);
});
