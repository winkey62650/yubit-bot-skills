import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelegramDelivery,
  isGroupIdentityDelivery
} from "../lib/telegram-delivery.mjs";

const DEMO_CHAT_ID = "-1003710405969";

test("Demo Academy outbound messages use the group identity transport", async () => {
  const calls = [];
  const delivery = createTelegramDelivery({
    env: {
      NODE_ENV: "production",
      DEMO_TELEGRAM_CHAT_ID: DEMO_CHAT_ID,
      TELEGRAM_GROUP_IDENTITY_REQUIRED: "true"
    },
    botApiCall: async (...args) => calls.push({ transport: "bot", args }),
    groupIdentityCall: async (...args) => {
      calls.push({ transport: "group", args });
      return { message_id: 901 };
    }
  });

  const result = await delivery("speaker-token", "sendMessage", {
    chat_id: DEMO_CHAT_ID,
    message_thread_id: 14,
    text: "test"
  });

  assert.deepEqual(result, { message_id: 901 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].transport, "group");
  assert.deepEqual(calls[0].args, ["speaker-token", "sendMessage", {
    chat_id: DEMO_CHAT_ID,
    message_thread_id: 14,
    text: "test"
  }]);
});

test("Demo Academy delivery never falls back to a visible Bot identity", async () => {
  let botCalls = 0;
  const delivery = createTelegramDelivery({
    env: {
      NODE_ENV: "production",
      DEMO_TELEGRAM_CHAT_ID: DEMO_CHAT_ID,
      TELEGRAM_GROUP_IDENTITY_REQUIRED: "true"
    },
    botApiCall: async () => { botCalls += 1; }
  });

  await assert.rejects(
    () => delivery("speaker-token", "sendPhoto", {
      chat_id: DEMO_CHAT_ID,
      message_thread_id: 3,
      photo: "https://example.com/poster.jpg"
    }),
    (error) => error?.code === "TELEGRAM_GROUP_IDENTITY_NOT_CONFIGURED"
  );
  assert.equal(botCalls, 0);
});

test("Telegram reads and non-Demo destinations continue to use Bot API", async () => {
  const calls = [];
  const delivery = createTelegramDelivery({
    env: {
      NODE_ENV: "production",
      DEMO_TELEGRAM_CHAT_ID: DEMO_CHAT_ID,
      TELEGRAM_GROUP_IDENTITY_REQUIRED: "true"
    },
    botApiCall: async (...args) => {
      calls.push(args);
      return { ok: true };
    },
    groupIdentityCall: async () => assert.fail("group transport must not be used")
  });

  await delivery("speaker-token", "getChat", { chat_id: DEMO_CHAT_ID });
  await delivery("speaker-token", "sendMessage", { chat_id: "-100999", text: "other" });

  assert.equal(calls.length, 2);
});

test("group identity routing recognizes all production send and copy methods", () => {
  const env = {
    NODE_ENV: "production",
    DEMO_TELEGRAM_CHAT_ID: DEMO_CHAT_ID,
    TELEGRAM_GROUP_IDENTITY_REQUIRED: "true"
  };
  for (const method of [
    "sendMessage",
    "sendPhoto",
    "sendVideo",
    "sendDocument",
    "sendAnimation",
    "sendAudio",
    "sendVoice",
    "sendMediaGroup",
    "copyMessage",
    "copyMessages",
    "editMessageText",
    "editMessageCaption",
    "editMessageMedia"
  ]) {
    assert.equal(isGroupIdentityDelivery(method, { chat_id: DEMO_CHAT_ID }, env), true, method);
  }
  assert.equal(isGroupIdentityDelivery("getChat", { chat_id: DEMO_CHAT_ID }, env), false);
});
