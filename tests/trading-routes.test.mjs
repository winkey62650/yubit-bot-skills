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

test("trading reconciliation cron requires CRON_SECRET and the PNL image route verifies a signed token", async () => {
  const cron = await readFile(new URL("../app/api/cron/trading-reconcile/route.js", import.meta.url), "utf8");
  const card = await readFile(new URL("../app/api/media/pnl-card/route.js", import.meta.url), "utf8");
  assert.match(cron, /process\.env\.CRON_SECRET/);
  assert.match(cron, /Bearer/);
  assert.match(cron, /runTradingReconciliation/);
  assert.match(card, /verifyPnlCardPayload/);
  assert.match(card, /process\.env\.PNL_CARD_SIGNING_SECRET/);
  assert.match(card, /new ImageResponse/);
  assert.match(card, /export const runtime = ["']nodejs["']/);
});
