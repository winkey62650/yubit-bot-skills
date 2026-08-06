import test from "node:test";
import assert from "node:assert/strict";
import { localizeUiText, localizeUiError } from "../lib/i18n.mjs";

test("full-site UI copy has deterministic English translations", () => {
  assert.equal(localizeUiText("en", "刷新状态"), "Refresh status");
  assert.equal(localizeUiText("en", "暂无自动任务。"), "No automated tasks yet.");
  assert.equal(localizeUiText("en", "已识别 3 个群；2 个群已满足初始化权限"), "3 groups detected; 2 are ready for initialization");
  assert.equal(localizeUiText("zh-CN", "刷新状态"), "刷新状态");
});

test("English mode never exposes a Chinese server error", () => {
  assert.equal(localizeUiError("en", "群配置读取失败", "Unable to load group configuration"), "Unable to load group configuration");
  assert.equal(localizeUiError("en", "未知的上游错误", "Request failed"), "Request failed");
  assert.equal(localizeUiError("zh-CN", "群配置读取失败", "Unable to load group configuration"), "群配置读取失败");
});
