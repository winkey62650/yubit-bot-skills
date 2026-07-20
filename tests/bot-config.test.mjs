import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBotRoles,
  TELEGRAM_DISCOVERY_ALLOWED_UPDATES,
  shouldPollTelegramUpdates,
  verifyTelegramGroupByChatId
} from "../lib/telegram-group-service.mjs";

test("all three current bot roles resolve from server environment variables", () => {
  const roles = buildBotRoles({}, {
    YUBITADMIN_BOT_TOKEN: "admin-token",
    SPEAKER_BOT_TOKEN: "speaker-token",
    FORWARD_BOT_TOKEN: "forward-token"
  });

  assert.deepEqual(roles.map(({ name, expectedUsername, token }) => ({ name, expectedUsername, token })), [
    { name: "AdminBot", expectedUsername: "Bonnie_geniustrader_bot", token: "admin-token" },
    { name: "SpeakerBot", expectedUsername: "Satoshi_geniustrader_bot", token: "speaker-token" },
    { name: "ForwardBot", expectedUsername: "Biupa_geniustrader_bot", token: "forward-token" }
  ]);
});

test("local token file still takes precedence for development without leaking token values", () => {
  const [admin] = buildBotRoles({ YUBITADMIN_BOT_TOKEN: "local-admin" }, { YUBITADMIN_BOT_TOKEN: "server-admin" });
  assert.equal(admin.token, "local-admin");
});

test("a bot with an active webhook is not polled with getUpdates", () => {
  assert.equal(shouldPollTelegramUpdates({ url: "https://example.com/api/telegram/webhook" }), false);
  assert.equal(shouldPollTelegramUpdates({ url: "" }), true);
  assert.equal(shouldPollTelegramUpdates(null), true);
});

test("polling discovery explicitly requests channel posts and bot membership updates", () => {
  assert.deepEqual(TELEGRAM_DISCOVERY_ALLOWED_UPDATES, [
    "message",
    "edited_message",
    "channel_post",
    "edited_channel_post",
    "my_chat_member"
  ]);
});

test("direct group verification checks all three bots without getUpdates or a local Telegram session", async () => {
  const methods = [];
  const botRoles = buildBotRoles({}, {
    YUBITADMIN_BOT_TOKEN: "admin-token",
    SPEAKER_BOT_TOKEN: "speaker-token",
    FORWARD_BOT_TOKEN: "forward-token"
  });
  const telegram = async (token, method, payload) => {
    methods.push({ token, method, payload });
    if (method === "getMe") {
      const usernames = {
        "admin-token": "Bonnie_geniustrader_bot",
        "speaker-token": "Satoshi_geniustrader_bot",
        "forward-token": "Biupa_geniustrader_bot"
      };
      return { result: { id: token.length, username: usernames[token] } };
    }
    if (method === "getChat") {
      return { result: { id: Number(payload.chat_id), title: "New Academy", type: "supergroup", is_forum: true } };
    }
    if (method === "getChatMember") {
      return { result: { status: "administrator", can_manage_topics: true, can_pin_messages: true, can_change_info: true } };
    }
    throw new Error(`unexpected Telegram method: ${method}`);
  };

  const result = await verifyTelegramGroupByChatId("-1001234567890", { botRoles, telegram });

  assert.equal(result.group.chatId, "-1001234567890");
  assert.equal(result.group.adminBotCount, 3);
  assert.equal(result.group.readyForInitialization, true);
  assert.deepEqual(methods.map(({ method }) => method), [
    "getMe", "getMe", "getMe",
    "getChat", "getChatMember",
    "getChat", "getChatMember",
    "getChat", "getChatMember"
  ]);
  assert.equal(methods.some(({ method }) => method === "getUpdates"), false);
});

test("direct group verification rejects invalid supergroup ids before calling Telegram", async () => {
  let called = false;
  await assert.rejects(
    verifyTelegramGroupByChatId("not-a-group", {
      botRoles: buildBotRoles({}, {}),
      telegram: async () => { called = true; }
    }),
    /以 -100 开头/
  );
  assert.equal(called, false);
});
