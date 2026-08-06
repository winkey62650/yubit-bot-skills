import test from "node:test";
import assert from "node:assert/strict";
import { localizeUiText, localizeUiError } from "../lib/i18n.mjs";

test("full-site UI copy has deterministic English translations", () => {
  assert.equal(localizeUiText("en", "刷新状态"), "Refresh status");
  assert.equal(localizeUiText("en", "暂无自动任务。"), "No automated tasks yet.");
  assert.equal(localizeUiText("en", "已识别 3 个群；2 个群已满足初始化权限"), "3 groups detected; 2 are ready for initialization");
  assert.equal(localizeUiText("en", "已读取 5 个 Telegram 对象；当前只允许 Forum 群 / Topic 作为出站目标。"), "5 Telegram objects loaded; only Forum groups / Topics can currently be outbound destinations.");
  assert.equal(localizeUiText("en", "已恢复云端设置 · 8/5/2026, 8:36:40 PM"), "Cloud settings restored · 8/5/2026, 8:36:40 PM");
  assert.equal(localizeUiText("en", "1 分 24 秒"), "1m 24s");
  assert.equal(localizeUiText("en", "45 秒"), "45s");
  assert.equal(localizeUiText("en", "5/5 项检查正常"), "5/5 checks healthy");
  assert.equal(localizeUiText("zh-CN", "刷新状态"), "刷新状态");
});

test("English mode never exposes a Chinese server error", () => {
  assert.equal(localizeUiError("en", "群配置读取失败", "Unable to load group configuration"), "Unable to load group configuration");
  assert.equal(localizeUiError("en", "未知的上游错误", "Request failed"), "Request failed");
  assert.equal(localizeUiError("zh-CN", "群配置读取失败", "Unable to load group configuration"), "群配置读取失败");
});
