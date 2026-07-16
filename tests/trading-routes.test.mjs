import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("SpeakerBot webhook is public only at its dedicated secret-verified route", async () => {
  const route = await readFile(new URL("../app/api/telegram/speaker-webhook/route.js", import.meta.url), "utf8");
  const middleware = await readFile(new URL("../middleware.js", import.meta.url), "utf8");
  assert.match(route, /x-telegram-bot-api-secret-token/i);
  assert.match(route, /verifySpeakerWebhookSecret/);
  assert.match(route, /processSpeakerTelegramUpdate/);
  assert.match(route, /export const runtime = ["']nodejs["']/);
  assert.match(middleware, /\/api\/telegram\/speaker-webhook/);
  assert.doesNotMatch(middleware, /pathname\.startsWith\(["']\/api\/trading/);
});
