import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(new URL("../app/distribution/page.jsx", import.meta.url), "utf8");

test("automatic publishing and Telegram broadcast keep separate rule selections", () => {
  assert.match(pageSource, /selectedAutomationRules/);
  assert.match(pageSource, /selectedBroadcastRules/);
  assert.match(pageSource, /reconcileRuleSelection/);
});

test("rule lists expose accessible selection and select-all controls", () => {
  assert.match(pageSource, /aria-label={`选择规则：\$\{rule\.name\}`}/);
  assert.match(pageSource, /aria-label="选择当前列表全部规则"/);
  assert.match(pageSource, /全选当前列表/);
  assert.match(pageSource, /清空选择/);
});

test("bulk deletion confirms the count and sends one delete-many request", () => {
  assert.match(pageSource, /删除已选（\{selectedCount\}）/);
  assert.match(pageSource, /确认删除已选的 \$\{ids\.length\} 条\$\{kindLabel\}/);
  assert.match(pageSource, /action: "delete-many", ids/);
  assert.match(pageSource, /failedBulkDeleteIds\(result\)/);
  assert.match(pageSource, /bulkDeleteNotice\(result\)/);
});
