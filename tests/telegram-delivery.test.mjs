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

test("closed topics are temporarily reopened, sent to exactly, then closed again", async () => {
  const calls = [];
  const call = async (method, payload) => {
    calls.push({ method, payload });
    if (method === "sendMessage" && calls.filter((item) => item.method === "sendMessage").length === 1) {
      throw new Error("This topic was closed, you can't send messages to it anymore.");
    }
    return method === "sendMessage" ? { message_id: 903 } : true;
  };

  const payload = { chat_id: "-100111", message_thread_id: 17, text: "exact topic" };
  const result = await sendTelegramPreservingClosedTopic(call, "sendMessage", payload);

  assert.deepEqual(result, { message_id: 903 });
  assert.deepEqual(calls, [
    { method: "sendMessage", payload },
    { method: "reopenForumTopic", payload: { chat_id: "-100111", message_thread_id: 17 } },
    { method: "sendMessage", payload },
    { method: "closeForumTopic", payload: { chat_id: "-100111", message_thread_id: 17 } }
  ]);
});

test("a failed closed-topic retry still restores the closed state", async () => {
  const methods = [];
  await assert.rejects(
    () => sendTelegramPreservingClosedTopic(async (method) => {
      methods.push(method);
      if (method === "sendMessage") throw new Error("TOPIC_CLOSED");
      return true;
    }, "sendMessage", { chat_id: "-100111", message_thread_id: 17, text: "test" }),
    /TOPIC_CLOSED/
  );
  assert.deepEqual(methods, ["sendMessage", "reopenForumTopic", "sendMessage", "closeForumTopic"]);
});

test("failure to restore a closed topic is explicit and never treated as success", async () => {
  let attempts = 0;
  await assert.rejects(
    () => sendTelegramPreservingClosedTopic(async (method) => {
      if (method === "sendMessage" && attempts++ === 0) throw new Error("MESSAGE_THREAD_CLOSED");
      if (method === "closeForumTopic") throw new Error("restore denied");
      return { message_id: 904 };
    }, "sendMessage", { chat_id: "-100111", message_thread_id: 17, text: "test" }),
    (error) => error?.code === "TELEGRAM_TOPIC_RESTORE_FAILED"
  );
});
