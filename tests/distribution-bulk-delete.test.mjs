import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  deleteDistributionRules,
  normalizeBulkDeleteIds
} from "../lib/distribution-bulk-delete.mjs";

test("bulk delete rejects empty, invalid, and oversized id lists", () => {
  assert.throws(() => normalizeBulkDeleteIds([]), /至少选择一条规则/);
  assert.throws(() => normalizeBulkDeleteIds(["rule-a", ""]), /非空字符串/);
  assert.throws(
    () => normalizeBulkDeleteIds(Array.from({ length: 101 }, (_, index) => `rule-${index}`)),
    /最多删除 100 条/
  );
});

test("bulk delete trims and de-duplicates rule ids", () => {
  assert.deepEqual(normalizeBulkDeleteIds([" rule-a ", "rule-a", "rule-b"]), ["rule-a", "rule-b"]);
});

test("bulk delete reports complete success", async () => {
  const repository = { deleteRule: async () => true };
  assert.deepEqual(await deleteDistributionRules(repository, ["rule-a", "rule-b"]), {
    ok: true,
    requested: 2,
    deleted: 2,
    failed: 0,
    results: [
      { id: "rule-a", ok: true },
      { id: "rule-b", ok: true }
    ]
  });
});

test("bulk delete continues after missing rules and exceptions", async () => {
  const repository = {
    async deleteRule(id) {
      if (id === "missing") return false;
      if (id === "broken") throw new Error("database timeout");
      return true;
    }
  };
  const result = await deleteDistributionRules(repository, ["kept", "missing", "broken"]);
  assert.equal(result.ok, false);
  assert.equal(result.deleted, 1);
  assert.equal(result.failed, 2);
  assert.deepEqual(result.results, [
    { id: "kept", ok: true },
    { id: "missing", ok: false, error: "规则不存在或已删除" },
    { id: "broken", ok: false, error: "database timeout" }
  ]);
});

test("bulk delete reports full failure without losing item details", async () => {
  const repository = { deleteRule: async () => false };
  const result = await deleteDistributionRules(repository, ["rule-a", "rule-b"]);
  assert.equal(result.ok, false);
  assert.equal(result.deleted, 0);
  assert.equal(result.failed, 2);
});

test("distribution management route exposes one-request batch deletion", async () => {
  const source = await readFile(new URL("../app/api/distribution/route.js", import.meta.url), "utf8");
  assert.match(source, /body\.action === ["']delete-many["']/);
  assert.match(source, /deleteDistributionRules\(repository, body\.ids\)/);
});

test("distribution run-now forwards the explicit exact-target safety fence", async () => {
  const source = await readFile(new URL("../app/api/distribution/route.js", import.meta.url), "utf8");
  assert.match(source, /exactTargets:\s*body\.exactTargets === true/);
  assert.match(source, /demoShowcase:\s*body\.demoShowcase === true/);
  assert.match(source, /demoAcceptanceBatchId:\s*body\.demoAcceptanceBatchId/);
});
