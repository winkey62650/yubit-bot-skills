import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelegramDelivery,
  isUserPublisherDelivery,
  sendTelegramPreservingClosedTopic,
  telegramUserPublisherStatus,
  userPublisherTargetIds
} from "../lib/telegram-delivery.mjs";

const DEMO_GROUP_ID = "-1003710405969";

function publisherEnv(overrides = {}) {
  return {
    NODE_ENV: "production",
    TELEGRAM_USER_PUBLISHER_REQUIRED: "true",
    TELEGRAM_USER_PUBLISHER_TARGETS: DEMO_GROUP_ID,
    TELEGRAM_API_ID: "12345",
    TELEGRAM_API_HASH: "api-hash",
    TELEGRAM_USER_SESSION_ENCRYPTION_KEY: "session-key",
    ...overrides
  };
}

test("approved Demo outbound messages use the Telegram user publisher", async () => {
  const calls = [];
  const delivery = createTelegramDelivery({
    env: publisherEnv(),
    botApiCall: async (...args) => calls.push({ transport: "bot", args }),
    userPublisherCall: async (...args) => {
      calls.push({ transport: "user", args });
      return { message_id: 901 };
    }
  });

  const result = await delivery("speaker-token", "sendMessage", {
    chat_id: DEMO_GROUP_ID,
    text: "test"
  });

  assert.deepEqual(result, { message_id: 901 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].transport, "user");
  assert.deepEqual(calls[0].args, ["speaker-token", "sendMessage", {
    chat_id: DEMO_GROUP_ID,
    text: "test"
  }]);
});

test("required user publishing never falls back to a visible Bot identity", async () => {
  let botCalls = 0;
  const delivery = createTelegramDelivery({
    env: publisherEnv(),
    botApiCall: async () => { botCalls += 1; }
  });

  await assert.rejects(
    () => delivery("speaker-token", "sendPhoto", {
      chat_id: DEMO_GROUP_ID,
      photo: "https://example.com/poster.jpg"
    }),
    (error) => error?.code === "TELEGRAM_USER_PUBLISHER_NOT_CONFIGURED"
  );
  assert.equal(botCalls, 0);
});

test("production publishing defaults to Bot when no delivery identity was explicitly selected", async () => {
  let botCalls = 0;
  const env = publisherEnv({
    TELEGRAM_USER_PUBLISHER_REQUIRED: undefined,
    TELEGRAM_USER_PUBLISHER_TARGETS: DEMO_GROUP_ID
  });
  const delivery = createTelegramDelivery({
    env,
    botApiCall: async () => { botCalls += 1; }
  });

  await delivery("speaker-token", "sendMessage", {
    chat_id: DEMO_GROUP_ID,
    text: "use the safe default Bot publisher"
  });
  assert.equal(botCalls, 1);
  assert.equal(telegramUserPublisherStatus(env).required, false);
});

test("production honors an explicit Bot publisher mode selected by the backend", async () => {
  let botCalls = 0;
  const env = publisherEnv({
    TELEGRAM_PUBLISHER_MODE: "bot",
    SPEAKER_BOT_TOKEN: "speaker-token",
    TELEGRAM_USER_PUBLISHER_REQUIRED: "true",
    TELEGRAM_USER_PUBLISHER_TARGETS: DEMO_GROUP_ID
  });
  const delivery = createTelegramDelivery({
    env,
    botApiCall: async () => { botCalls += 1; return { message_id: 902 }; }
  });

  const result = await delivery("speaker-token", "sendMessage", {
    chat_id: DEMO_GROUP_ID,
    text: "send through the selected Bot"
  });

  assert.deepEqual(result, { message_id: 902 });
  assert.equal(botCalls, 1);
  assert.deepEqual(telegramUserPublisherStatus(env), {
    mode: "bot",
    required: false,
    credentialsReady: true,
    encryptionReady: true,
    routingReady: true,
    ready: true,
    username: "@Satoshi_geniustrader_bot",
    approvedTargetIds: [DEMO_GROUP_ID]
  });
});

test("required user publishing allows an outbound destination outside the Demo allowlist", async () => {
  let botCalls = 0;
  let userCalls = 0;
  const delivery = createTelegramDelivery({
    env: publisherEnv(),
    botApiCall: async () => { botCalls += 1; },
    userPublisherCall: async () => { userCalls += 1; }
  });

  await delivery("speaker-token", "sendMessage", {
    chat_id: "-100999999",
    text: "must not escape Demo"
  });
  
  assert.equal(botCalls, 0);
  assert.equal(userCalls, 1);
});

test("Telegram reads continue to use Bot API", async () => {
  const calls = [];
  const delivery = createTelegramDelivery({
    env: publisherEnv(),
    botApiCall: async (...args) => {
      calls.push(args);
      return { ok: true };
    },
    userPublisherCall: async () => assert.fail("user publisher must not be used for reads")
  });

  await delivery("speaker-token", "getChat", { chat_id: DEMO_GROUP_ID });
  assert.equal(calls.length, 1);
});

test("user publisher routing recognizes all production send and copy methods", () => {
  const env = publisherEnv();
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
    assert.equal(isUserPublisherDelivery(method, { chat_id: DEMO_GROUP_ID }, env), true, method);
  }
  assert.equal(isUserPublisherDelivery("getChat", { chat_id: DEMO_GROUP_ID }, env), false);
});

test("publisher target parsing and status are safe for the admin UI", () => {
  const env = publisherEnv({
    TELEGRAM_USER_PUBLISHER_TARGETS: `${DEMO_GROUP_ID}, ${DEMO_GROUP_ID}`
  });

  assert.deepEqual(userPublisherTargetIds(env), [DEMO_GROUP_ID]);
  assert.deepEqual(telegramUserPublisherStatus(env), {
    mode: "user",
    required: true,
    credentialsReady: true,
    encryptionReady: true,
    routingReady: true,
    ready: true,
    username: "@Serenity_Crypto",
    approvedTargetIds: [DEMO_GROUP_ID]
  });
});

test("managed closed topics are sent once without changing topic state", async () => {
  const calls = [];
  const call = async (method, payload) => {
    calls.push({ method, payload });
    return { message_id: 903 };
  };

  const payload = { chat_id: "-100111", message_thread_id: 17, text: "exact topic" };
  const result = await sendTelegramPreservingClosedTopic(call, "sendMessage", payload);

  assert.deepEqual(result, { message_id: 903 });
  assert.deepEqual(calls, [{ method: "sendMessage", payload }]);
});

test("a closed-topic rejection propagates without changing topic state", async () => {
  const methods = [];
  await assert.rejects(
    () => sendTelegramPreservingClosedTopic(async (method) => {
      methods.push(method);
      if (method === "sendMessage") throw new Error("TOPIC_CLOSED");
      return true;
    }, "sendMessage", { chat_id: "-100111", message_thread_id: 17, text: "test" }),
    /TOPIC_CLOSED/
  );
  assert.deepEqual(methods, ["sendMessage"]);
});

test("non-topic delivery remains a single call", async () => {
  const calls = [];
  const payload = { chat_id: "-100111", text: "test" };
  const result = await sendTelegramPreservingClosedTopic(async (method, nextPayload) => {
    calls.push({ method, payload: nextPayload });
    return { message_id: 904 };
  }, "sendMessage", payload);
  assert.deepEqual(result, { message_id: 904 });
  assert.deepEqual(calls, [{ method: "sendMessage", payload }]);
});
