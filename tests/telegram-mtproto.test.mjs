import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramMtprotoTransport } from "../lib/telegram-mtproto.mjs";

const GROUP_ID = "-1003710405969";
const CHANNEL_ID = "-1003862539988";

function fakeClientHarness({ authorized = true, username = "Serenity_Crypto" } = {}) {
  const calls = [];
  const client = {
    async connect() {
      calls.push({ kind: "connect" });
    },
    async checkAuthorization() {
      calls.push({ kind: "checkAuthorization" });
      return authorized;
    },
    async getMe() {
      calls.push({ kind: "getMe" });
      return { id: 42n, username, bot: false };
    },
    async getInputEntity(value) {
      calls.push({ kind: "entity", value });
      return { className: "InputPeerChannel", channelId: BigInt(String(value).replace("-100", "")), accessHash: 22n };
    },
    async sendMessage(entity, options) {
      calls.push({ kind: "sendMessage", entity, options });
      return { id: 777 };
    }
  };
  return { calls, client };
}

function configuredOptions(harness, extra = {}) {
  return {
    env: {
      TELEGRAM_API_ID: "12345",
      TELEGRAM_API_HASH: "hash",
      TELEGRAM_USER_PUBLISHER_USERNAME: "Serenity_Crypto"
    },
    loadSession: async () => ({
      session: "persisted-user-session",
      username: "Serenity_Crypto"
    }),
    createClient: async (options) => {
      harness.calls.push({ kind: "createClient", options });
      return harness.client;
    },
    ...extra
  };
}

test("MTProto publisher restores the Serenity user session instead of authenticating a Bot", async () => {
  const harness = fakeClientHarness();
  const transport = createTelegramMtprotoTransport(configuredOptions(harness));

  const result = await transport("speaker-bot-token-is-ignored", "sendMessage", {
    chat_id: GROUP_ID,
    message_thread_id: 14,
    text: "Signal"
  });

  assert.deepEqual(result, { message_id: 777 });
  const created = harness.calls.find((call) => call.kind === "createClient");
  assert.equal(created.options.session, "persisted-user-session");
  assert.equal(harness.calls.some((call) => call.kind === "start"), false);
  assert.equal(harness.calls.some((call) => call.kind === "connect"), true);
  assert.equal(harness.calls.some((call) => call.kind === "checkAuthorization"), true);
  const send = harness.calls.find((call) => call.kind === "sendMessage");
  assert.equal(send.options.message, "Signal");
  assert.equal(send.options.topMsgId, 14);
  assert.equal(send.options.replyTo, 14);
  assert.equal(send.options.sendAs, undefined);
});

test("native Telegram identity rules stay intact for channels and groups", async () => {
  const harness = fakeClientHarness();
  const transport = createTelegramMtprotoTransport(configuredOptions(harness));

  await transport("first-bot", "sendMessage", { chat_id: GROUP_ID, text: "group" });
  await transport("second-bot", "sendMessage", { chat_id: CHANNEL_ID, text: "channel" });

  const sends = harness.calls.filter((call) => call.kind === "sendMessage");
  assert.equal(sends.length, 2);
  assert.equal(sends[0].options.sendAs, undefined, "forum/group must display the user account");
  assert.equal(sends[1].options.sendAs, undefined, "channel must use Telegram's native channel identity");
  assert.equal(harness.calls.filter((call) => call.kind === "createClient").length, 1);
});

test("MTProto publisher refuses an unauthorized or wrong user session", async () => {
  const unauthorized = fakeClientHarness({ authorized: false });
  const unauthorizedTransport = createTelegramMtprotoTransport(configuredOptions(unauthorized));
  await assert.rejects(
    () => unauthorizedTransport("ignored", "sendMessage", { chat_id: GROUP_ID, text: "Signal" }),
    (error) => error?.code === "TELEGRAM_USER_SESSION_UNAUTHORIZED"
  );

  const wrongUser = fakeClientHarness({ username: "SomebodyElse" });
  const wrongUserTransport = createTelegramMtprotoTransport(configuredOptions(wrongUser));
  await assert.rejects(
    () => wrongUserTransport("ignored", "sendMessage", { chat_id: GROUP_ID, text: "Signal" }),
    (error) => error?.code === "TELEGRAM_USER_IDENTITY_MISMATCH"
  );
});

test("MTProto credentials and an encrypted persisted session are required before sending", async () => {
  let created = 0;
  const withoutCredentials = createTelegramMtprotoTransport({
    env: {},
    loadSession: async () => ({ session: "session", username: "Serenity_Crypto" }),
    createClient: async () => { created += 1; }
  });
  await assert.rejects(
    () => withoutCredentials("ignored", "sendMessage", { chat_id: GROUP_ID, text: "Signal" }),
    (error) => error?.code === "TELEGRAM_USER_PUBLISHER_NOT_CONFIGURED"
  );
  assert.equal(created, 0);

  const withoutSession = createTelegramMtprotoTransport({
    env: { TELEGRAM_API_ID: "12345", TELEGRAM_API_HASH: "hash" },
    loadSession: async () => { throw Object.assign(new Error("missing"), { code: "TELEGRAM_USER_SESSION_NOT_CONFIGURED" }); },
    createClient: async () => { created += 1; }
  });
  await assert.rejects(
    () => withoutSession("ignored", "sendMessage", { chat_id: GROUP_ID, text: "Signal" }),
    (error) => error?.code === "TELEGRAM_USER_SESSION_NOT_CONFIGURED"
  );
  assert.equal(created, 0);
});

test("MTProto publisher can restore encrypted API credentials saved by the web authorization flow", async () => {
  const harness = fakeClientHarness();
  const transport = createTelegramMtprotoTransport({
    env: { TELEGRAM_USER_PUBLISHER_USERNAME: "Serenity_Crypto" },
    loadSession: async () => ({
      session: "persisted-user-session",
      username: "Serenity_Crypto",
      apiId: 54321,
      apiHash: "persisted-api-hash"
    }),
    createClient: async (options) => {
      harness.calls.push({ kind: "createClient", options });
      return harness.client;
    }
  });

  await transport("ignored", "sendMessage", { chat_id: CHANNEL_ID, text: "Demo only" });

  const created = harness.calls.find((call) => call.kind === "createClient");
  assert.equal(created.options.apiId, 54321);
  assert.equal(created.options.apiHash, "persisted-api-hash");
});
