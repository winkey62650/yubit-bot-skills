import assert from "node:assert/strict";
import test from "node:test";
import { shouldCloseTopicAfterSetup } from "../lib/telegram-topic-policy.mjs";

test("new group setup closes only the read-first disclaimer topic", () => {
  assert.equal(shouldCloseTopicAfterSetup({ id: 1, name: "READ FIRST - DISCLAIMER", attribute: "关闭话题" }), true);
  assert.equal(shouldCloseTopicAfterSetup({ id: 3, name: "Market Events", attribute: "关闭话题" }), false);
  assert.equal(shouldCloseTopicAfterSetup({ id: 4, name: "Market Analysis", attribute: "关闭话题" }), false);
  assert.equal(shouldCloseTopicAfterSetup({ id: 6, name: "Smart Money Tracker", attribute: "关闭话题" }), false);
  assert.equal(shouldCloseTopicAfterSetup({ id: 7, name: "YUBIT Updates", attribute: "频道禁言" }), false);
});
