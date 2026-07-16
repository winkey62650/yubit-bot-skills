import assert from "node:assert/strict";
import test from "node:test";
import * as telegramDiscovery from "../lib/telegram-discovery.mjs";
import {
  collectTelegramChatCandidates,
  discoverTelegramChats,
  mergeBotGroupDiscoveries,
  mergeExpectedForumTopics,
  orderTopicsByTemplate,
  reconcileGroupWithSetupState
} from "../lib/telegram-discovery.mjs";

const oldId = "-5428066414";
const activeId = "-1004378187866";
const forumId = "-1003710405969";

test("suppresses a predecessor group after Telegram migration", () => {
  const updates = [
    { message: { chat: { id: Number(oldId), title: "CryptoGuy Academy", type: "group" }, migrate_to_chat_id: Number(activeId) } },
    { message: { chat: { id: Number(activeId), title: "CryptoGuy Academy", type: "supergroup" }, migrate_from_chat_id: Number(oldId) } },
    { message: { chat: { id: Number(forumId), title: "DEMO Academy", type: "supergroup" } } }
  ];
  const result = collectTelegramChatCandidates(updates);
  assert.deepEqual(result.active.map((chat) => chat.chatId).sort(), [activeId, forumId].sort());
  assert.deepEqual(result.active.find((chat) => chat.chatId === activeId).migratedFrom, [oldId]);
});

test("keeps only current memberships and distinguishes Forum from supergroup", async () => {
  const updates = [
    { message: { chat: { id: Number(activeId), title: "CryptoGuy Academy", type: "supergroup" } } },
    { message: { chat: { id: Number(forumId), title: "DEMO Academy", type: "supergroup" } } },
    { message: { chat: { id: -999, title: "Old group", type: "supergroup" } } }
  ];
  const telegram = async (_token, method, payload) => {
    if (method === "getChat") return { result: { id: Number(payload.chat_id), title: payload.chat_id === activeId ? "CryptoGuy Academy" : "DEMO Academy", type: "supergroup", is_forum: payload.chat_id === forumId } };
    if (method === "getChatMember") return { result: payload.chat_id === "-999" ? { status: "left" } : { status: "administrator", can_manage_topics: payload.chat_id === forumId } };
    throw new Error("unexpected method");
  };
  const result = await discoverTelegramChats({ token: "test", botId: 1, updates, telegram });
  assert.equal(result.groups.length, 2);
  assert.equal(result.groups.find((group) => group.chatId === activeId).canUseTopics, false);
  assert.equal(result.groups.find((group) => group.chatId === forumId).canManageTopics, true);
});

test("merges the three current bots into one live group view", () => {
  const bot = (name, username, groups) => ({ name, username, status: "在线", groups });
  const adminGroup = (chatId, title, canUseTopics = false) => ({
    chatId,
    title,
    type: "supergroup",
    membership: "administrator",
    canUseTopics,
    canManageTopics: canUseTopics,
    permissions: { canPinMessages: canUseTopics, canChangeInfo: canUseTopics }
  });
  const bots = [
    bot("AdminBot", "Bonnie_geniustrader_bot", [adminGroup(activeId, "CryptoGuy Academy"), adminGroup(forumId, "DEMO Academy", true)]),
    bot("SpeakerBot", "Satoshi_geniustrader_bot", [adminGroup(activeId, "CryptoGuy Academy"), adminGroup(forumId, "DEMO Academy", true)]),
    bot("ForwardBot", "Biupa_geniustrader_bot", [adminGroup(activeId, "CryptoGuy Academy"), adminGroup(forumId, "DEMO Academy", true)])
  ];

  const groups = mergeBotGroupDiscoveries(bots);

  assert.equal(groups.length, 2);
  assert.equal(groups.find((group) => group.chatId === activeId).allBotsAdmin, true);
  assert.equal(groups.find((group) => group.chatId === activeId).adminBotCount, 3);
  assert.equal(groups.find((group) => group.chatId === activeId).readyForInitialization, false);
  assert.match(groups.find((group) => group.chatId === activeId).initializationBlockReason, /Topics/);
  assert.deepEqual(groups.find((group) => group.chatId === activeId).bots.map((item) => item.name), ["AdminBot", "SpeakerBot", "ForwardBot"]);
  assert.equal(groups.find((group) => group.chatId === forumId).readyForInitialization, true);
  assert.equal(groups.find((group) => group.chatId === forumId).initializationBlockReason, "");
});

test("does not mark a group ready when any current bot is missing or not an administrator", () => {
  const groups = mergeBotGroupDiscoveries([
    { name: "AdminBot", status: "在线", groups: [{ chatId: activeId, title: "CryptoGuy Academy", membership: "administrator" }] },
    { name: "SpeakerBot", status: "在线", groups: [{ chatId: activeId, title: "CryptoGuy Academy", membership: "member" }] },
    { name: "ForwardBot", status: "需检查", groups: [] }
  ]);

  assert.equal(groups[0].adminBotCount, 1);
  assert.equal(groups[0].allBotsAdmin, false);
  assert.equal(groups[0].readyForInitialization, false);
});

test("does not mark a forum ready when AdminBot cannot manage topics", () => {
  const group = (canManageTopics) => ({
    chatId: forumId,
    title: "DEMO Academy",
    type: "supergroup",
    membership: "administrator",
    isForum: true,
    canUseTopics: true,
    canManageTopics,
    permissions: { canPinMessages: true, canChangeInfo: true }
  });
  const groups = mergeBotGroupDiscoveries([
    { name: "AdminBot", status: "在线", groups: [group(false)] },
    { name: "SpeakerBot", status: "在线", groups: [group(true)] },
    { name: "ForwardBot", status: "在线", groups: [group(true)] }
  ]);

  assert.equal(groups[0].allBotsAdmin, true);
  assert.equal(groups[0].readyForInitialization, false);
  assert.match(groups[0].initializationBlockReason, /AdminBot.*Manage Topics/);
});

test("does not mark a forum ready when an administrator token belongs to the wrong bot", () => {
  const group = {
    chatId: forumId,
    title: "DEMO Academy",
    type: "supergroup",
    membership: "administrator",
    isForum: true,
    canUseTopics: true,
    canManageTopics: true,
    permissions: { canPinMessages: true, canChangeInfo: true }
  };
  const groups = mergeBotGroupDiscoveries([
    { name: "AdminBot", status: "身份不匹配", groups: [group] },
    { name: "SpeakerBot", status: "在线", groups: [group] },
    { name: "ForwardBot", status: "在线", groups: [group] }
  ]);

  assert.equal(groups[0].allBotsAdmin, true);
  assert.equal(groups[0].readyForInitialization, false);
  assert.match(groups[0].initializationBlockReason, /身份/);
});

test("does not mark a forum ready when AdminBot cannot pin setup content", () => {
  const group = (name) => ({
    chatId: forumId,
    title: "Forum Group",
    type: "supergroup",
    isForum: true,
    canUseTopics: true,
    membership: "administrator",
    canManageTopics: true,
    permissions: { canPinMessages: name !== "AdminBot", canChangeInfo: true }
  });
  const bots = ["AdminBot", "SpeakerBot", "ForwardBot"].map((name) => ({ name, groups: [group(name)] }));

  const groups = mergeBotGroupDiscoveries(bots);

  assert.equal(groups[0].readyForInitialization, false);
  assert.match(groups[0].initializationBlockReason, /AdminBot.*Pin Messages/);
});

test("keeps an explicitly selected blocked group instead of silently switching targets", () => {
  assert.equal(typeof telegramDiscovery.selectPreferredInitializationGroup, "function");
  const groups = [
    { chatId: activeId, title: "CryptoGuy Academy", readyForInitialization: false },
    { chatId: forumId, title: "DEMO Academy", readyForInitialization: true }
  ];

  assert.equal(telegramDiscovery.selectPreferredInitializationGroup(groups, activeId).chatId, activeId);
  assert.equal(telegramDiscovery.selectPreferredInitializationGroup(groups, "").chatId, forumId);
});

test("does not replace an unrecognized saved group with a different live group", () => {
  const groups = [
    { chatId: activeId, title: "CryptoGuy Academy", readyForInitialization: true },
    { chatId: forumId, title: "DEMO Academy", readyForInitialization: true }
  ];

  assert.equal(telegramDiscovery.selectPreferredInitializationGroup(groups, "-1009999999999"), null);
});

test("keeps thread ids observed on ordinary forum messages", () => {
  const result = collectTelegramChatCandidates([
    {
      message: {
        chat: { id: Number(forumId), title: "DEMO Academy", type: "supergroup" },
        message_thread_id: 14,
        photo: [{ file_id: "photo" }]
      }
    }
  ]);

  assert.deepEqual(result.active[0].detectedTopicThreadIds, [14]);
});

test("orders managed topics by semantic template slots instead of Telegram thread ids", () => {
  const expected = [
    "1. READ FIRST - DISCLAIMER",
    "5. Community Signal",
    "4. Market Analysis - Crypto/Stocks/TradFi",
    "3. Market Events",
    "6. Smart Money Tracker",
    "7. YUBIT Updates",
    "CryptoGuy Trading Zone"
  ].map((name) => ({ name }));
  const actual = [
    { name: "7. YUBIT Updates", threadId: 3 },
    { name: "2. Market Events", threadId: 4 },
    { name: "CryptoGuy Trading Zone", threadId: 5 },
    { name: "1. READ FIRST - DISCLAIMER", threadId: 6 },
    { name: "6. Smart Money Tracker", threadId: 7 },
    { name: "5. Community Signal", threadId: 8 },
    { name: "4. Market Analysis - Crypto/Stocks/TradFi", threadId: 9 }
  ];
  assert.deepEqual(orderTopicsByTemplate(actual, expected).map((topic) => topic.name), [
    "1. READ FIRST - DISCLAIMER",
    "5. Community Signal",
    "4. Market Analysis - Crypto/Stocks/TradFi",
    "2. Market Events",
    "6. Smart Money Tracker",
    "7. YUBIT Updates",
    "CryptoGuy Trading Zone"
  ]);
});

test("preserves the editorial order when expected topics carry numeric template ids", () => {
  const expected = [
    { id: "1", name: "1. READ FIRST - DISCLAIMER" },
    { id: "5", name: "5. Community Signal" },
    { id: "4", name: "4. Market Analysis - Crypto/Stocks/TradFi" },
    { id: "3", name: "3. Market Events" },
    { id: "6", name: "6. Smart Money Tracker" },
    { id: "7", name: "7. YUBIT Updates" },
    { id: "2", name: "CryptoGuy Trading Zone" }
  ];
  const actual = [
    { name: "7. YUBIT Updates", threadId: 12 },
    { name: "2. Market Events", threadId: 8 },
    { name: "7. xxx's Trading Zone", threadId: 18 },
    { name: "1. READ FIRST - DISCLAIMER", threadId: 6 },
    { name: "6. Smart Money Tracker", threadId: 16 },
    { name: "5. 7-Day PNL Challenge", threadId: 14 },
    { name: "3. Market Analysis - Crypto/Stocks/TradFi", threadId: 10 }
  ];
  assert.deepEqual(orderTopicsByTemplate(actual, expected).map((topic) => topic.name), [
    "1. READ FIRST - DISCLAIMER",
    "5. 7-Day PNL Challenge",
    "3. Market Analysis - Crypto/Stocks/TradFi",
    "2. Market Events",
    "6. Smart Money Tracker",
    "7. YUBIT Updates",
    "7. xxx's Trading Zone"
  ]);
});

test("loads the known forum catalog without claiming unresolved thread bindings", () => {
  const bot = (name) => ({
    name,
    status: "在线",
    groups: [{
      chatId: forumId,
      title: "DEMO Academy",
      type: "supergroup",
      membership: "administrator",
      isForum: true,
      canUseTopics: true,
      canManageTopics: true,
      topics: [],
      detectedTopicThreadIds: [14]
    }]
  });

  const groups = mergeBotGroupDiscoveries(
    [bot("AdminBot"), bot("SpeakerBot"), bot("ForwardBot")],
    {
      expectedForumTopics: [
        { name: "⚠️ 1. READ FIRST - DISCLAIMER" },
        { name: "📊 2. Market Analysis - Crypto/Stocks/TradFi" }
      ]
    }
  );

  assert.equal(groups[0].topics.length, 2);
  assert.deepEqual(groups[0].topics.map((topic) => topic.name), [
    "⚠️ 1. READ FIRST - DISCLAIMER",
    "📊 2. Market Analysis - Crypto/Stocks/TradFi"
  ]);
  assert.deepEqual(groups[0].topics.map((topic) => topic.threadId), [null, null]);
  assert.deepEqual(groups[0].topicCoverage, {
    knownCount: 2,
    resolvedCount: 0,
    detectedThreadCount: 1,
    complete: false
  });
});

test("repairs a cached forum catalog that was previously saved with zero topics", () => {
  const topics = mergeExpectedForumTopics([], [
    { name: "⚠️ 1. READ FIRST - DISCLAIMER" },
    { name: "📅 2. Market Events" }
  ]);

  assert.deepEqual(topics.map((topic) => topic.name), [
    "⚠️ 1. READ FIRST - DISCLAIMER",
    "📅 2. Market Events"
  ]);
  assert.deepEqual(topics.map((topic) => topic.threadId), [null, null]);
  assert.deepEqual(topics.map((topic) => topic.verified), [false, false]);
});

test("collapses legacy template placeholders and duplicate numbered topic events", () => {
  const topics = mergeExpectedForumTopics([
    { name: "1. READ FIRST - DISCLAIMER", threadId: 3, source: "telegram-event", verified: true },
    { name: "2. Market Events", threadId: 8, source: "telegram-event", verified: true },
    { name: "3. Market Analysis - Crypto/Stocks/TradFi", threadId: 11, source: "telegram-event", verified: true },
    { name: "4. YUBIT Updates", threadId: 14, source: "telegram-event", verified: true },
    { name: "5. 7-Day PNL Challenge", threadId: 17, source: "telegram-event", verified: true },
    { name: "6. Smart Money Tracker", threadId: 19, source: "telegram-event", verified: true },
    { name: "7. CryptoGuy Trading Zone", threadId: 22, source: "telegram-event", verified: true },
    { name: "7. CryptoGuy Trading Zone", threadId: 51, source: "telegram-event", verified: true },
    { name: "7. CryptoGuy Trading Zone", threadId: 66, source: "telegram-event", verified: true },
    { name: "⚠️ 1. READ FIRST - DISCLAIMER", source: "template" },
    { name: "📅 2. Market Events", source: "template" }
  ], [
    { name: "1. READ FIRST - DISCLAIMER" },
    { name: "5. Community Signal" },
    { name: "4. Market Analysis - Crypto/Stocks/TradFi" },
    { name: "3. Market Events" },
    { name: "6. Smart Money Tracker" },
    { name: "7. YUBIT Updates" },
    { name: "CryptoGuy Trading Zone" }
  ]);

  assert.equal(topics.length, 7);
  assert.deepEqual(topics.map((topic) => topic.threadId), [3, 17, 11, 8, 19, 14, 22]);
  assert.equal(topics[0].name, "1. READ FIRST - DISCLAIMER");
  assert.equal(topics[1].name, "5. Community Signal");
  assert.equal(topics[3].name, "3. Market Events");
  assert.equal(topics[6].name, "CryptoGuy Trading Zone");
});

test("uses completed setup state as the authority for managed topic ids", () => {
  const group = {
    chatId: activeId,
    title: "CryptoGuy Academy",
    topics: [
      { name: "1. READ FIRST - DISCLAIMER", threadId: 3 },
      { name: "2. Market Events", threadId: 8 },
      { name: "7. CryptoGuy Trading Zone", threadId: 22 },
      { name: "7. CryptoGuy Trading Zone", threadId: 51 },
      { name: "7. CryptoGuy Trading Zone", threadId: 66 },
      { name: "📅 2. Market Events", threadId: null, source: "template" }
    ],
    detectedTopicThreadIds: [3, 8, 22, 51, 66]
  };
  const setupState = {
    chatId: activeId,
    topics: {
      topic_1: { message_thread_id: 3, configuredName: "1. READ FIRST - DISCLAIMER" },
      topic_2: { message_thread_id: 8, configuredName: "2. Market Events" },
      topic_7: { message_thread_id: 22, configuredName: "7. xxx's Trading Zone" }
    }
  };
  const expected = [
    { name: "1. READ FIRST - DISCLAIMER" },
    { name: "2. Market Events" },
    { name: "7. xxx's Trading Zone" }
  ];

  const reconciled = reconcileGroupWithSetupState(group, setupState, expected);

  assert.equal(reconciled.topics.length, 3);
  assert.deepEqual(reconciled.topics.map((topic) => topic.threadId), [3, 8, 22]);
  assert.equal(reconciled.topics[2].name, "7. CryptoGuy Trading Zone");
  assert.deepEqual(reconciled.detectedTopicThreadIds, [3, 8, 22]);
  assert.deepEqual(reconciled.topicCoverage, {
    knownCount: 3,
    resolvedCount: 3,
    detectedThreadCount: 3,
    complete: true
  });
});
