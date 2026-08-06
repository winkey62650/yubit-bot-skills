import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelegramMtprotoTransport,
  createTelegramSessionLoader
} from "../lib/telegram-mtproto.mjs";

const GROUP_ID = "-1003710405969";
const CHANNEL_ID = "-1003862539988";

test("default MTProto session loader preserves the selected Telegram user id", async () => {
  const calls = [];
  const loadSession = createTelegramSessionLoader(
    { TELEGRAM_USER_SESSION_ENCRYPTION_KEY: "test-key" },
    async (env, userId) => {
      calls.push({ env, userId });
      return { userId, session: "selected-session" };
    }
  );

  const stored = await loadSession("8749261694");

  assert.equal(stored.userId, "8749261694");
  assert.equal(calls[0].userId, "8749261694");
});

function fakeClientHarness({
  authorized = true,
  username = "Serenity_Crypto",
  groupIdentityAvailable = true,
  getSendAsError = null,
  broadcastTargets = [],
  requireDialogWarmup = false,
  dialogs = null
} = {}) {
  const calls = [];
  let dialogsLoaded = false;
  const inputEntity = (value) => {
    if (value?.className === "InputPeerChannel") return value;
    if (value?.className === "PeerChannel") {
      return { className: "InputPeerChannel", channelId: value.channelId, accessHash: 22n };
    }
    if (value?.className === "Channel") {
      return { className: "InputPeerChannel", channelId: value.id, accessHash: value.accessHash };
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
      if (requireDialogWarmup && typeof value === "string" && !dialogsLoaded) {
        throw new Error(`Could not find the input entity for ${value}`);
      }
      return inputEntity(value);
    },
    async getDialogs(options) {
      calls.push({ kind: "getDialogs", options });
      dialogsLoaded = true;
      return dialogs || [{
        isGroup: true,
        isChannel: true,
        title: "DEMO Academy",
        entity: {
          className: "Channel",
          id: 3710405969n,
          accessHash: 22n,
          megagroup: true,
          broadcast: false
        }
      }];
    },
    async getEntity(value) {
      calls.push({ kind: "getEntity", value });
      const targetId = `-100${value.channelId}`;
      const broadcast = broadcastTargets.includes(targetId);
      return { className: "Channel", id: value.channelId, megagroup: !broadcast, broadcast };
    },
    async invoke(request) {
      calls.push({ kind: "invoke", request });
      if (getSendAsError) throw getSendAsError;
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

test("getDialogs reports whether the selected account can publish to each dialog", async () => {
  const harness = fakeClientHarness({
    dialogs: [
      {
        isGroup: true,
        isChannel: true,
        title: "Writable Group",
        entity: { id: 111n, megagroup: true, broadcast: false, creator: true }
      },
      {
        isGroup: false,
        isChannel: true,
        title: "Read-only Channel",
        entity: { id: 222n, megagroup: false, broadcast: true, adminRights: null }
      },
      {
        isGroup: false,
        isChannel: true,
        title: "Writable Channel",
        entity: { id: 333n, megagroup: false, broadcast: true, adminRights: { postMessages: true } }
      }
    ]
  });
  const transport = createTelegramMtprotoTransport(configuredOptions(harness));

  const dialogs = await transport(null, "getDialogs", {}, { userId: "8749261694" });

  assert.equal(dialogs.find((dialog) => dialog.id === "-100111").canSendMessages, true);
  assert.equal(dialogs.find((dialog) => dialog.id === "-100222").canSendMessages, false);
  assert.equal(dialogs.find((dialog) => dialog.id === "-100333").canSendMessages, true);
});

test("MTProto publisher resolves a cold group entity from the selected account dialogs before sending", async () => {
  const harness = fakeClientHarness({ requireDialogWarmup: true });
  const transport = createTelegramMtprotoTransport(configuredOptions(harness));

  const result = await transport("ignored", "sendMessage", {
    chat_id: GROUP_ID,
    message_thread_id: 14,
    text: "Cold start"
  });

  assert.deepEqual(result, { message_id: 777 });
  assert.equal(harness.calls.filter((call) => call.kind === "getDialogs").length, 1);
  assert.equal(harness.calls.some((call) => call.kind === "sendMessage"), true);
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

test("official group publisher falls back to user identity for Channels", async () => {
  const harness = fakeClientHarness({ broadcastTargets: [CHANNEL_ID] });
  const transport = createTelegramMtprotoTransport(configuredOptions(harness));

  await transport("ignored", "sendMessage", { chat_id: CHANNEL_ID, text: "should publish as user" });
  
  const call = harness.calls.find((call) => call.kind === "sendMessage");
  assert.equal(call !== undefined, true);
  assert.equal(call.options.sendAs, undefined);
});

test("official group publisher falls back to user identity when Telegram does not offer the group send-as identity", async () => {
  const harness = fakeClientHarness({ groupIdentityAvailable: false });
  const transport = createTelegramMtprotoTransport(configuredOptions(harness));

  await transport("ignored", "sendMessage", { chat_id: GROUP_ID, text: "should publish as user" });
  
  const call = harness.calls.find((call) => call.kind === "sendMessage");
  assert.equal(call !== undefined, true);
  assert.equal(call.options.sendAs, undefined);
});

test("official group publisher continues when GetSendAs is unsupported for a normal supergroup", async () => {
  const error = new Error("The provided peer id is invalid. (caused by channels.GetSendAs)");
  error.code = "PEER_ID_INVALID";
  error.name = "PeerIdInvalidError";
  const harness = fakeClientHarness({ getSendAsError: error });
  const transport = createTelegramMtprotoTransport(configuredOptions(harness));

  const result = await transport("ignored", "sendMessage", {
    chat_id: GROUP_ID,
    text: "normal supergroup"
  });

  assert.deepEqual(result, { message_id: 777 });
  const call = harness.calls.find((candidate) => candidate.kind === "sendMessage");
  assert.equal(call.options.sendAs, undefined);
});

test("MTProto publisher refuses an unauthorized user session", async () => {
  const unauthorized = fakeClientHarness({ authorized: false });
  const unauthorizedTransport = createTelegramMtprotoTransport(configuredOptions(unauthorized));
  await assert.rejects(
    () => unauthorizedTransport("ignored", "sendMessage", { chat_id: GROUP_ID, text: "Signal" }),
    (error) => error?.code === "TELEGRAM_USER_SESSION_UNAUTHORIZED"
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
