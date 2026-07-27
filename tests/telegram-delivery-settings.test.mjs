import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyTelegramDeliveryMode,
  normalizeTelegramDeliverySettings
} from "../lib/telegram-delivery-settings.mjs";

test("backend delivery settings independently select publishing and forwarding identities", () => {
  assert.deepEqual(normalizeTelegramDeliverySettings({
    telegramPublishMode: "bot",
    telegramForwardMode: "user"
  }), {
    telegramPublishMode: "bot",
    telegramForwardMode: "user"
  });
});

test("Bot mode disables the user and desktop publisher without deleting credentials", () => {
  const env = applyTelegramDeliveryMode({
    TELEGRAM_DESKTOP_PUBLISHER_REQUIRED: "true",
    TELEGRAM_API_HASH: "preserved"
  }, {
    telegramPublishMode: "bot",
    telegramForwardMode: "user"
  }, "publish");

  assert.equal(env.TELEGRAM_PUBLISHER_MODE, "bot");
  assert.equal(env.TELEGRAM_USER_PUBLISHER_REQUIRED, "false");
  assert.equal(env.TELEGRAM_DESKTOP_PUBLISHER_REQUIRED, "false");
  assert.equal(env.TELEGRAM_API_HASH, "preserved");
});

test("human forwarding keeps the authorized desktop publisher enabled", () => {
  const env = applyTelegramDeliveryMode({ TELEGRAM_DESKTOP_PUBLISHER_REQUIRED: "true" }, {
    telegramPublishMode: "bot",
    telegramForwardMode: "user"
  }, "forward");
  assert.equal(env.TELEGRAM_PUBLISHER_MODE, "user");
  assert.equal(env.TELEGRAM_DESKTOP_PUBLISHER_REQUIRED, "true");
});

test("settings UI exposes both delivery identity controls", () => {
  const source = readFileSync(new URL("../app/settings/page.jsx", import.meta.url), "utf8");
  assert.match(source, /Telegram 自动发送身份/);
  assert.match(source, /telegramPublishMode/);
  assert.match(source, /telegramForwardMode/);
  assert.match(source, /使用 SpeakerBot/);
  assert.match(source, /使用 ForwardBot/);
  assert.match(source, /使用真人 TG 账号/);
});
