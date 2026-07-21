import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramMtprotoTransport } from "../lib/telegram-mtproto.mjs";

const GROUP_ID = "-1003710405969";
const CHANNEL_ID = "-1003862539988";

function fakeClientHarness({
  authorized = true,
  username = "Serenity_Crypto",
  groupIdentityAvailable = true,
  broadcastTargets = []
} = {}) {
  const calls = [];
  const inputEntity = (value) => {
    if (value?.className === "InputPeerChannel") return value;
    if (value?.className === "PeerChannel") {
      return { className: "InputPeerChannel", channelId: value.channelId, accessHash: 22n };
    }
    return {
      className: "InputPeerChannel",
      channelId: BigInt(String(value).replace("-100", "")),
      accessHash: 22n
    };
  };
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
      return inputEntity(value);
    },
    async getEntity(value) {
      calls.push({ kind: "getEntity", value });
      const targetId = `-100${value.channelId}`;
      const broadcast = broadcastTargets.includes(targetId);
      return { className: "Channel", id: value.channelId, megagroup: !broadcast, broadcast };
    },
    async invoke(request) {
      calls.push({ kind: "invoke", request });
      const target = request.peer;
      return {
        peers: groupIdentityAvailable
          ? [{ className: "SendAsPeer", peer: { className: "PeerChannel", channelId: target.channelId } }]
          : [{ className: "SendAsPeer", peer: { className: "PeerUser", userId: 42n } }]
      };
    },
    async sendMessage(entity, options) {
      calls.push({ kind: "sendMessage", entity, options });
      return { id: 777 };
    },
    async sendFile(entity, options) {
      calls.push({ kind: "sendFile", entity, options });
      return { id: 778 };
    },
    async forwardMessages(entity, options) {
      calls.push({ kind: "forwardMessages", entity, options });
      return { id: 779 };
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

test("MTProto publisher restores the Serenity user session and sends as the Demo group", async () => {
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
  assert.equal(send.options.sendAs.className, "InputPeerChannel");
  assert.equal(send.options.sendAs.channelId, 3710405969n);
  assert.equal(
    harness.calls.some((call) => call.kind === "invoke" && call.request.className === "channels.GetSendAs"),
    true
  );
});

test("all new group content uses the official group identity", async () => {
  const harness = fakeClientHarness();
  const transport = createTelegramMtprotoTransport(configuredOptions(harness));

  await transport("ignored", "sendMessage", { chat_id: GROUP_ID, text: "group" });
  await transport("ignored", "sendPhoto", { chat_id: GROUP_ID, photo: "poster.jpg", caption: "brief" });
  await transport("ignored", "copyMessage", { chat_id: GROUP_ID, from_chat_id: GROUP_ID, message_id: 88 });

  const outboundCalls = harness.calls.filter((call) => ["sendMessage", "sendFile", "forwardMessages"].includes(call.kind));
  assert.equal(outboundCalls.length, 3);
  for (const call of outboundCalls) {
    assert.equal(call.options.sendAs.className, "InputPeerChannel", call.kind);
    assert.equal(call.options.sendAs.channelId, 3710405969n, call.kind);
  }
  assert.equal(harness.calls.filter((call) => call.kind === "createClient").length, 1);
});

test("official group publisher rejects Channels instead of exposing another sender identity", async () => {
  const harness = fakeClientHarness({ broadcastTargets: [CHANNEL_ID] });
  const transport = createTelegramMtprotoTransport(configuredOptions(harness));

  await assert.rejects(
    () => transport("ignored", "sendMessage", { chat_id: CHANNEL_ID, text: "must not publish" }),
    (error) => error?.code === "TELEGRAM_GROUP_TARGET_REQUIRED"
  );
  assert.equal(harness.calls.some((call) => call.kind === "sendMessage"), false);
});

test("official group publisher fails closed when Telegram does not offer the group send-as identity", async () => {
  const harness = fakeClientHarness({ groupIdentityAvailable: false });
  const transport = createTelegramMtprotoTransport(configuredOptions(harness));

  await assert.rejects(
    () => transport("ignored", "sendMessage", { chat_id: GROUP_ID, text: "must not publish" }),
    (error) => error?.code === "TELEGRAM_GROUP_IDENTITY_NOT_AVAILABLE"
  );
  assert.equal(harness.calls.some((call) => call.kind === "sendMessage"), false);
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

  await transport("ignored", "sendMessage", { chat_id: GROUP_ID, text: "Demo only" });

  const created = harness.calls.find((call) => call.kind === "createClient");
  assert.equal(created.options.apiId, 54321);
  assert.equal(created.options.apiHash, "persisted-api-hash");
});
