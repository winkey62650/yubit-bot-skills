import assert from "node:assert/strict";
import test from "node:test";

import { telegramCall as automationTelegramCall } from "../lib/automation-jobs.mjs";
import { telegramCall as distributionTelegramCall } from "../lib/distribution-service.mjs";
import { telegramCall as tradingTelegramCall } from "../lib/trading-service.mjs";

const DEMO_CHAT_ID = "-1003710405969";
const userPublisherEnv = {
  TELEGRAM_USER_PUBLISHER_REQUIRED: "true",
  TELEGRAM_USER_PUBLISHER_TARGETS: DEMO_CHAT_ID
};

function forbiddenBotApi() {
  throw new Error("Bot API must not be used for Demo Academy outbound messages");
}

function userPublisherRecorder(calls) {
  return async (token, method, payload) => {
    calls.push({ token, method, payload });
    return { message_id: 801 };
  };
}

test("automation delivery uses the Serenity user publisher", async () => {
  const calls = [];
  const result = await automationTelegramCall(
    "speaker-token",
    "sendMessage",
    { chat_id: DEMO_CHAT_ID, message_thread_id: 3, text: "Market event" },
    forbiddenBotApi,
    { env: userPublisherEnv, userPublisherCall: userPublisherRecorder(calls) }
  );

  assert.equal(result.message_id, 801);
  assert.deepEqual(calls.map(({ token, method }) => ({ token, method })), [
    { token: "speaker-token", method: "sendMessage" }
  ]);
});

test("trading delivery uses the Serenity user publisher", async () => {
  const calls = [];
  const result = await tradingTelegramCall(
    "speaker-token",
    "sendMessage",
    { chat_id: DEMO_CHAT_ID, message_thread_id: 5, text: "BTC/USDT Long" },
    { env: userPublisherEnv, fetchImpl: forbiddenBotApi, userPublisherCall: userPublisherRecorder(calls) }
  );

  assert.equal(result.message_id, 801);
  assert.equal(calls.length, 1);
});

test("broadcast delivery uses the Serenity user publisher", async () => {
  const calls = [];
  const result = await distributionTelegramCall(
    "forward-token",
    "copyMessage",
    { chat_id: DEMO_CHAT_ID, message_thread_id: 7, from_chat_id: "-1001", message_id: 42 },
    { env: userPublisherEnv, fetchImpl: forbiddenBotApi, userPublisherCall: userPublisherRecorder(calls) }
  );

  assert.equal(result.message_id, 801);
  assert.equal(calls.length, 1);
});
