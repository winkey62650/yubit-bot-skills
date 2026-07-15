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
  assert.deepEqual(defaultTopicTemplate.map((topic) => topic.emoji), ["❗️", "📰", "💡", "🎉", "💰", "💎", "⚡️"]);
  for (const topic of defaultTopicTemplate) {
    assert.equal(topicNameWithSequence(topic), `${topic.id}. ${topic.name}`);
    assert.equal(topicDisplayName(topic), `${topic.id}. ${topic.name}`);
  }
});

test("saved drafts migrate only the old default icons", () => {
  assert.equal(migrateTopicTemplate({ id: "1", emoji: "⚠️", name: "1. READ FIRST - DISCLAIMER" }).emoji, "❗️");
  assert.equal(migrateTopicTemplate({ id: "4", emoji: "📢", name: "4. YUBIT Updates" }).emoji, "🎉");
  assert.equal(migrateTopicTemplate({ id: "4", emoji: "🔥", name: "4. YUBIT Updates" }).emoji, "🔥");
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
