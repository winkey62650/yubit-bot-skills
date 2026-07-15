import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateSetupDurationMs,
  resolveTopicProgress,
  setupTimingDefaults,
  topicActionPlan
} from "../lib/telegram-setup-state.mjs";

test("a resumed setup skips every topic side effect that already completed", () => {
  const topic = {
    announcement: "Safety notice",
    imageUrl: "https://example.com/card.png",
    pin: true,
    close: true
  };
  const completed = {
    message_thread_id: 42,
    configuredName: "1. Safety",
    configuredIconCustomEmojiId: "icon-1",
    imageSent: true,
    announcementSent: true,
    announcementMessageId: 99,
    pinned: true,
    closed: true
  };

  assert.deepEqual(topicActionPlan(completed, { ...topic, name: "1. Safety", iconCustomEmojiId: "icon-1" }), {
    create: false,
    configure: false,
    syncContent: false,
    sendImage: false,
    sendAnnouncement: false,
    pin: false,
    close: false
  });
});

test("a partial setup resumes from the first unfinished side effect", () => {
  const topic = {
    announcement: "Safety notice",
    imageUrl: "https://example.com/card.png",
    pin: true,
    close: true
  };
  const partial = {
    message_thread_id: 42,
    configuredName: "1. Safety",
    configuredIconCustomEmojiId: "icon-1",
    imageSent: true,
    announcementSent: false,
    pinned: false,
    closed: false
  };

  assert.deepEqual(topicActionPlan(partial, { ...topic, name: "1. Safety", iconCustomEmojiId: "icon-1" }), {
    create: false,
    configure: false,
    syncContent: false,
    sendImage: false,
    sendAnnouncement: true,
    pin: true,
    close: true
  });
});

test("a resumed setup repairs the name and custom icon of an existing topic", () => {
  const progress = {
    message_thread_id: 42,
    configuredName: "⚠️ 1. READ FIRST - DISCLAIMER",
    configuredIconCustomEmojiId: ""
  };

  assert.equal(topicActionPlan(progress, {
    name: "1. READ FIRST - DISCLAIMER",
    iconCustomEmojiId: "5379748062124056162"
  }).configure, true);
});

test("structured Demo content replaces legacy image/text sending and resumes by version", () => {
  const topic = {
    name: "1. READ FIRST - DISCLAIMER",
    contentVersion: "demo-read-first-v1",
    messages: [
      { type: "photo", photo: "file-1", caption: "Part 1", pin: true },
      { type: "text", text: "Part 2", pin: true },
      { type: "photo", photo: "file-2", caption: "Part 3", pin: true }
    ],
    announcement: "legacy flattened text",
    imageUrl: "https://example.com/legacy-card.png",
    pin: true
  };

  const legacyProgress = {
    message_thread_id: 3,
    configuredName: topic.name,
    configuredIconCustomEmojiId: ""
  };
  assert.deepEqual(topicActionPlan(legacyProgress, topic), {
    create: false,
    configure: false,
    syncContent: true,
    sendImage: false,
    sendAnnouncement: false,
    pin: false,
    close: false
  });

  const completeProgress = {
    ...legacyProgress,
    contentVersion: topic.contentVersion,
    contentMessageIds: [101, 102, 103],
    pinnedContentMessageIds: [101, 102, 103]
  };
  assert.equal(topicActionPlan(completeProgress, topic).syncContent, false);
});

test("topic identity remains stable when its editable name changes", () => {
  const states = {
    "7_xxx_s_trading_zone": { message_thread_id: 22, announcementSent: true },
    "7_cryptoguy_trading_zone": { message_thread_id: 66, announcementSent: true }
  };

  assert.deepEqual(resolveTopicProgress(states, {
    key: "topic_7",
    legacyKeyPrefix: "7_"
  }), {
    topicKey: "topic_7",
    topicState: states["7_xxx_s_trading_zone"],
    migratedKeys: ["7_xxx_s_trading_zone", "7_cryptoguy_trading_zone"]
  });
});

test("seven-topic initialization fits inside the Vercel function window", () => {
  const duration = estimateSetupDurationMs({
    topicCount: 7,
    messageCount: 8,
    apiCallCount: 31
  });

  assert.ok(setupTimingDefaults.messageDelayMs >= 3000, "respect Telegram's 20 messages/minute group limit");
  assert.ok(duration < setupTimingDefaults.maxDurationSeconds * 1000 * 0.75, "leave at least 25% timeout headroom");
});
