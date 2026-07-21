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

test("automatic publishing explains the official identity workflow and exact topic routing", () => {
  assert.match(pageSource, /服务器生成模板并排队/);
  assert.match(pageSource, /本机发布桥领取任务/);
  assert.match(pageSource, /Telegram Desktop 以 DEMO Academy 群身份发送/);
  assert.match(pageSource, /结果与消息编号回写后台/);
  assert.match(pageSource, /逐字发送，禁止翻译、摘要、改写、增删或重新排版/);
  assert.match(pageSource, /Daily Events → 3\. Market Events/);
  assert.match(pageSource, /Daily Analysis → 4\. Market Analysis - Crypto\/Stocks\/TradFi/);
  assert.match(pageSource, /Whale Signals → 6\. Smart Money Tracker/);
});
