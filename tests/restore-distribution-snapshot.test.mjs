import assert from "node:assert/strict";
import test from "node:test";

import { restoreDistributionSnapshot } from "../scripts/restore-distribution-snapshot.mjs";

test("restores rules into an empty PostgreSQL repository and records archive metadata", async () => {
  const saved = [];
  const meta = [];
  const repository = {
    async initialize() {},
    async listRules() { return []; },
    async saveRule(rule) { saved.push(rule); },
    async setMeta(key, value) { meta.push([key, value]); },
  };
  const result = await restoreDistributionSnapshot({
    repository,
    snapshot: { rules: [{ id: "rule-1", name: "早报" }], deliveries: [{ id: "delivery-1" }] },
    sourceName: "distribution-backup.json",
    restoredAt: "2026-08-20T00:00:00.000Z",
  });

  assert.equal(result.restoredRules, 1);
  assert.equal(result.archivedDeliveries, 1);
  assert.deepEqual(saved, [{ id: "rule-1", name: "早报" }]);
  assert.equal(meta[0][0], "restore:distribution-snapshot-v1");
});

test("does not overwrite a non-empty local primary database", async () => {
  const repository = {
    async initialize() {},
    async listRules() { return [{ id: "existing" }]; },
  };
  await assert.rejects(
    restoreDistributionSnapshot({ repository, snapshot: { rules: [{ id: "rule-1" }] } }),
    /already contains distribution rules/i,
  );
});
