import assert from "node:assert/strict";
import test from "node:test";
import {
  hydrateTelegramTopicAvailability,
  topicIdsByChatFromConfiguredGroups,
  topicIdsByChatFromTargets
} from "../lib/telegram-topic-availability.mjs";

test("topic availability hydrates open, closed and missing topics for each forum", async () => {
  const calls = [];
  const dialogs = await hydrateTelegramTopicAvailability(
    [{ id: "-100111", isForum: true, canSendMessages: true, canManageTopics: true }],
    new Map([["-100111", [7, 8, 9]]]),
    {
      userId: "42",
      call: async (_token, method, payload, options) => {
        calls.push({ method, payload, options });
        return [
          { threadId: 7, name: "Signals", closed: false, deleted: false, canSendMessages: true },
          { threadId: 8, name: "Closed", closed: true, deleted: false, canSendMessages: false }
        ];
      }
    }
  );

  assert.deepEqual(calls[0], {
    method: "getForumTopics",
    payload: { chat_id: "-100111" },
    options: { userId: "42" }
  });
  assert.deepEqual(dialogs[0].topics.map((topic) => [topic.threadId, topic.availabilityStatus, topic.canSendMessages]), [
    [7, "available", true],
    [8, "managed-closed", true],
    [9, "missing", false]
  ]);
  assert.equal(typeof dialogs[0].topicStatusCheckedAt, "string");
  assert.equal(dialogs[0].topics[1].requiresTemporaryReopen, true);
});

test("closed topics remain unavailable without manage-topics permission", async () => {
  const dialogs = await hydrateTelegramTopicAvailability(
    [{ id: "-100111", isForum: true, canSendMessages: true, canManageTopics: false }],
    new Map([["-100111", [8]]]),
    { userId: "42", call: async () => [
      { threadId: 8, name: "Closed", closed: true, deleted: false, canSendMessages: false }
    ] }
  );
  assert.equal(dialogs[0].topics[0].availabilityStatus, "closed");
  assert.equal(dialogs[0].topics[0].canSendMessages, false);
});

test("topic availability fails closed when Telegram cannot verify a forum", async () => {
  const dialogs = await hydrateTelegramTopicAvailability(
    [{ id: "-100111", isForum: true, canSendMessages: true }],
    new Map([["-100111", [7]]]),
    { userId: "42", call: async () => { throw new Error("network unavailable"); } }
  );

  assert.equal(dialogs[0].topics[0].availabilityStatus, "unknown");
  assert.equal(dialogs[0].topics[0].canSendMessages, false);
  assert.match(dialogs[0].topicStatusError, /network unavailable/);
});

test("topic availability discovers every live topic for an unconfigured forum", async () => {
  const calls = [];
  const dialogs = await hydrateTelegramTopicAvailability(
    [{ id: "-100222", isForum: true, canSendMessages: true }],
    new Map(),
    {
      userId: "42",
      call: async (_token, method, payload, options) => {
        calls.push({ method, payload, options });
        return [
          { threadId: 3, name: "General", closed: false, deleted: false, canSendMessages: true },
          { threadId: 7, name: "Crypto Analysis", closed: false, deleted: false, canSendMessages: true }
        ];
      }
    }
  );

  assert.deepEqual(calls[0], {
    method: "getForumTopics",
    payload: { chat_id: "-100222" },
    options: { userId: "42" }
  });
  assert.deepEqual(dialogs[0].topics.map((topic) => [topic.threadId, topic.name, topic.availabilityStatus]), [
    [3, "General", "available"],
    [7, "Crypto Analysis", "available"]
  ]);
});

test("topic id collectors normalize configured groups and selected targets", () => {
  assert.deepEqual(
    [...topicIdsByChatFromConfiguredGroups([{ chatId: "-100111", topics: [{ threadId: 7 }, { threadId: "8" }] }])],
    [["-100111", [7, 8]]]
  );
  assert.deepEqual(
    [...topicIdsByChatFromTargets(["-100111:7", "-100111:8", "-100222:"])],
    [["-100111", [7, 8]]]
  );
});
