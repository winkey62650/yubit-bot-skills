import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_LOCALE, normalizeLocale, translate } from "../lib/i18n.mjs";

test("locale normalization is safe and defaults to Chinese", () => {
  assert.equal(DEFAULT_LOCALE, "zh-CN");
  assert.equal(normalizeLocale("en"), "en");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("zh-CN"), "zh-CN");
  assert.equal(normalizeLocale("fr"), "zh-CN");
});

test("English UI dictionary translates core publishing workflow and falls back safely", () => {
  assert.equal(translate("en", "nav.composer"), "Manual Publishing");
  assert.equal(translate("en", "composer.title"), "Message Publishing Center");
  assert.equal(translate("zh-CN", "composer.title"), "消息发布中心");
  assert.equal(translate("en", "missing.key"), "missing.key");
});
