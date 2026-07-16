import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultTopicTemplate,
  migrateTopicTemplate,
  readFirstContentVersion,
  readFirstPinnedMessages,
  topicDisplayName,
  topicNameWithSequence
} from "../templates.mjs";

test("new topics keep their sequence in the Telegram name and use the requested icon set", () => {
  assert.deepEqual(defaultTopicTemplate.map(({ id, emoji, name }) => ({ id, emoji, name })), [
    { id: "1", emoji: "❗️", name: "READ FIRST - DISCLAIMER" },
    { id: "5", emoji: "💰", name: "Community Signal" },
    { id: "4", emoji: "💡", name: "Market Analysis - Crypto/Stocks/TradFi" },
    { id: "3", emoji: "📰", name: "Market Events" },
    { id: "6", emoji: "💎", name: "Smart Money Tracker" },
    { id: "7", emoji: "🎉", name: "YUBIT Updates" },
    { id: "2", emoji: "⚡️", name: "CryptoGuy Trading Zone" }
  ]);
  for (const topic of defaultTopicTemplate) {
    const expectedName = `${topic.id}. ${topic.name}`;
    assert.equal(topicNameWithSequence(topic), expectedName);
    assert.equal(topicDisplayName(topic), expectedName);
  }
});

test("saved drafts migrate only the old default icons", () => {
  assert.equal(migrateTopicTemplate({ id: "1", emoji: "⚠️", name: "1. READ FIRST - DISCLAIMER" }).emoji, "❗️");
  assert.equal(migrateTopicTemplate({ id: "4", emoji: "📊", name: "4. Market Analysis - Crypto/Stocks/TradFi" }).emoji, "💡");
  assert.equal(migrateTopicTemplate({ id: "7", emoji: "📢", name: "7. YUBIT Updates" }).emoji, "🎉");
  assert.equal(migrateTopicTemplate({ id: "7", emoji: "🔥", name: "7. YUBIT Updates" }).emoji, "🔥");
});

test("topic sequence is not duplicated when the editable name already contains it", () => {
  assert.equal(topicNameWithSequence({ id: "1", name: "1. READ FIRST - DISCLAIMER" }), "1. READ FIRST - DISCLAIMER");
});

test("READ FIRST uses the complete default disclaimer", () => {
  const topic = defaultTopicTemplate.find((item) => item.name === "READ FIRST - DISCLAIMER");
  assert.ok(topic);
  assert.match(topic.announcement, /COMMUNITY DISCLAIMER/);
  assert.match(topic.announcement, /Anti-Scam Notice/);
});

test("READ FIRST preserves the three-message Demo snapshot and every pin", () => {
  const topic = defaultTopicTemplate.find((item) => item.name === "READ FIRST - DISCLAIMER");

  assert.equal(topic.contentVersion, readFirstContentVersion);
  assert.deepEqual(topic.messages, readFirstPinnedMessages);
  assert.deepEqual(topic.messages.map((message) => message.type), ["photo", "text", "photo"]);
  assert.deepEqual(topic.messages.map((message) => message.pin), [true, true, true]);
  assert.equal(topic.messages[0].caption.length, 1024, "Telegram photo caption must retain the exact Demo split");
  assert.match(topic.messages[1].text, /10\. Acknowledgement/);
  assert.match(topic.messages[2].caption, /Anti-Scam Notice/);
  assert.deepEqual(topic.messages[2].captionEntities, [
    { offset: 0, length: 19, type: "bold" },
    { offset: 94, length: 5, type: "bold" }
  ]);
});
