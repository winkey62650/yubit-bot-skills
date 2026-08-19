import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelegramMtprotoTransport,
  createTelegramSessionLoader,
  telegramEntityCanManageTopics
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
  dialogs = null,
  forumTopics = [],
  forumTopicsError = null
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
    if (value?.id !== undefined && (value?.megagroup === true || value?.broadcast === true)) {
      return { className: "InputPeerChannel", channelId: value.id, accessHash: value.accessHash ?? 22n };
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
      if (request.className === "messages.GetForumTopicsByID" || request.className === "messages.GetForumTopics") {
        if (forumTopicsError) throw forumTopicsError;
        return { topics: forumTopics };
      }
      if (request.className === "messages.EditForumTopic") return { ok: true };
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
      },
      {
        isGroup: true,
        isChannel: true,
        title: "Media-only Group",
        entity: {
          id: 444n,
          megagroup: true,
          broadcast: false,
          defaultBannedRights: { sendPlain: true }
        }
      },
      {
        isGroup: true,
        isChannel: true,
        title: "Topics Admin Group",
        entity: {
          id: 555n,
          megagroup: true,
          broadcast: false,
          adminRights: { manageTopics: true }
        }
      }
    ]
  });
  const transport = createTelegramMtprotoTransport(configuredOptions(harness));

  const dialogs = await transport(null, "getDialogs", {}, { userId: "8749261694" });

  assert.equal(dialogs.find((dialog) => dialog.id === "-100111").canSendMessages, true);
  assert.equal(dialogs.find((dialog) => dialog.id === "-100222").canSendMessages, false);
  assert.equal(dialogs.find((dialog) => dialog.id === "-100333").canSendMessages, true);
  assert.equal(dialogs.find((dialog) => dialog.id === "-100444").canSendMessages, false);
  assert.equal(dialogs.find((dialog) => dialog.id === "-100111").canManageTopics, true);
  assert.equal(dialogs.find((dialog) => dialog.id === "-100222").canManageTopics, false);
  assert.equal(dialogs.find((dialog) => dialog.id === "-100555").canManageTopics, true);
});

test("getDialogs excludes a writable supergroup when its official Send As identity is unavailable", async () => {
  const harness = fakeClientHarness({
    groupIdentityAvailable: false,
    dialogs: [{
      isGroup: true,
      isChannel: true,
      title: "Writable but not official",
      entity: {
        className: "Channel",
        id: 1702053978n,
        accessHash: 22n,
        megagroup: true,
        broadcast: false,
        adminRights: { postMessages: true }
      }
    }]
  });
  const transport = createTelegramMtprotoTransport(configuredOptions(harness));

  const dialogs = await transport(null, "getDialogs", {}, { userId: "8749261694" });

  assert.equal(dialogs[0].id, "-1001702053978");
  assert.equal(dialogs[0].canSendMessages, false);
  assert.equal(dialogs[0].canSendAsOfficialIdentity, false);
  assert.equal(dialogs[0].publishUnavailableReason, "official_identity_unavailable");
  assert.equal(
    harness.calls.some((call) => call.kind === "invoke" && call.request.className === "channels.GetSendAs"),
    true
  );
});

test("topic management permission accepts creators and manage-topics admins only", () => {
  assert.equal(telegramEntityCanManageTopics({ creator: true }), true);
  assert.equal(telegramEntityCanManageTopics({ adminRights: { manageTopics: true } }), true);
  assert.equal(telegramEntityCanManageTopics({ adminRights: { manage_topics: true } }), true);
  assert.equal(telegramEntityCanManageTopics({ adminRights: { postMessages: true } }), false);
  assert.equal(telegramEntityCanManageTopics({ creator: true, left: true }), false);
});

test("MTProto publisher never mutates the requested forum topic state", async () => {
  const harness = fakeClientHarness();
  const transport = createTelegramMtprotoTransport(configuredOptions(harness));

  for (const method of ["reopenForumTopic", "closeForumTopic"]) {
    await assert.rejects(
      () => transport(null, method, {
        chat_id: GROUP_ID,
        message_thread_id: 18
      }, { userId: "8749261694" }),
      (error) => error?.code === "TELEGRAM_TOPIC_STATE_MUTATION_DISABLED"
    );
  }

  assert.equal(
    harness.calls.some((call) => call.kind === "invoke" && call.request.className === "messages.EditForumTopic"),
    false
  );
});

test("getForumTopicsById reports exact open, closed and deleted topic states", async () => {
  const harness = fakeClientHarness({
    forumTopics: [
      { className: "ForumTopic", id: 7, title: "Signals", closed: false },
      { className: "ForumTopic", id: 8, title: "Archive", closed: true },
      { className: "ForumTopicDeleted", id: 9 }
    ]
  });
  const transport = createTelegramMtprotoTransport(configuredOptions(harness));

  const topics = await transport(null, "getForumTopicsById", {
    chat_id: GROUP_ID,
    thread_ids: [7, 8, 9]
  }, { userId: "8749261694" });

  assert.deepEqual(topics, [
    { threadId: 7, name: "Signals", closed: false, deleted: false, canSendMessages: true },
    { threadId: 8, name: "Archive", closed: true, deleted: false, canSendMessages: false },
    { threadId: 9, name: "", closed: false, deleted: true, canSendMessages: false }
  ]);
});

test("getForumTopics discovers topics when a forum is not configured yet", async () => {
  const harness = fakeClientHarness({
    forumTopics: [
      { className: "ForumTopic", id: 4, title: "General", closed: false },
      { className: "ForumTopic", id: 9, title: "Crypto Analysis", closed: false }
    ]
  });
  const transport = createTelegramMtprotoTransport(configuredOptions(harness));

  const topics = await transport(null, "getForumTopics", { chat_id: GROUP_ID }, { userId: "8749261694" });

  assert.deepEqual(topics.map((topic) => [topic.threadId, topic.name]), [
    [4, "General"],
    [9, "Crypto Analysis"]
  ]);
  const request = harness.calls.find(
    (call) => call.kind === "invoke" && call.request.className === "messages.GetForumTopics"
  ).request;
  assert.equal(request.limit, 100);
  assert.equal(request.offsetTopic, 0);
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

test("official publisher uses the native Channel identity for Channels", async () => {
  const harness = fakeClientHarness({ broadcastTargets: [CHANNEL_ID] });
  const transport = createTelegramMtprotoTransport(configuredOptions(harness));

  await transport("ignored", "sendMessage", { chat_id: CHANNEL_ID, text: "should publish as user" });
  
  const call = harness.calls.find((call) => call.kind === "sendMessage");
  assert.equal(call !== undefined, true);
  assert.equal(call.options.sendAs, undefined);
});

test("official group publisher refuses to fall back to user identity when group send-as is unavailable", async () => {
  const harness = fakeClientHarness({ groupIdentityAvailable: false });
  const transport = createTelegramMtprotoTransport(configuredOptions(harness));

  await assert.rejects(
    () => transport("ignored", "sendMessage", { chat_id: GROUP_ID, text: "must stay official" }),
    (error) => error?.code === "TELEGRAM_GROUP_IDENTITY_NOT_AVAILABLE"
  );
  assert.equal(harness.calls.some((call) => call.kind === "sendMessage"), false);
});

test("official group publisher refuses personal fallback when GetSendAs fails", async () => {
  const error = new Error("The provided peer id is invalid. (caused by channels.GetSendAs)");
  error.code = "PEER_ID_INVALID";
  error.name = "PeerIdInvalidError";
  const harness = fakeClientHarness({ getSendAsError: error });
  const transport = createTelegramMtprotoTransport(configuredOptions(harness));

  await assert.rejects(
    () => transport("ignored", "sendMessage", {
      chat_id: GROUP_ID,
      text: "must stay official"
    }),
    (caught) => caught?.code === "TELEGRAM_GROUP_IDENTITY_NOT_AVAILABLE"
  );
  assert.equal(harness.calls.some((call) => call.kind === "sendMessage"), false);
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

test("an already-aborted MTProto request does not load a session or call the shared client", async () => {
  const harness = fakeClientHarness();
  let sessionLoads = 0;
  const transport = createTelegramMtprotoTransport(configuredOptions(harness, {
    loadSession: async () => {
      sessionLoads += 1;
      return { session: "must-not-load" };
    }
  }));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => transport("ignored", "sendMessage", { chat_id: GROUP_ID, text: "stop" }, { signal: controller.signal }),
    (error) => error?.name === "AbortError"
  );

  assert.equal(sessionLoads, 0);
  assert.equal(harness.calls.length, 0);
});

test("inflight MTProto send and invoke boundaries reject promptly when aborted", async () => {
  const cases = [
    { method: "sendMessage", clientMethod: "sendMessage", payload: { chat_id: GROUP_ID, text: "message" } },
    { method: "sendPhoto", clientMethod: "sendFile", payload: { chat_id: GROUP_ID, photo: "poster.jpg" } },
    { method: "copyMessage", clientMethod: "forwardMessages", payload: { chat_id: GROUP_ID, from_chat_id: GROUP_ID, message_id: 42 } },
    { method: "getForumTopics", clientMethod: "invoke", payload: { chat_id: GROUP_ID } }
  ];

  for (const item of cases) {
    const harness = fakeClientHarness();
    let boundaryEntered;
    const entered = new Promise((resolve) => { boundaryEntered = resolve; });
    harness.client[item.clientMethod] = async () => {
      boundaryEntered();
      return new Promise(() => {});
    };
    const transport = createTelegramMtprotoTransport(configuredOptions(harness));
    const controller = new AbortController();
    const operation = transport("ignored", item.method, item.payload, { signal: controller.signal });
    await entered;

    const started = Date.now();
    controller.abort();
    await assert.rejects(operation, (error) => error?.name === "AbortError", item.clientMethod);
    assert.ok(Date.now() - started < 100, `${item.clientMethod} did not reject promptly`);
  }
});
