import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultForumTopicIconIds,
  resolveForumTopicIconId
} from "../lib/telegram-topic-icons.mjs";

test("the requested topic icons resolve to Telegram custom emoji ids", () => {
  for (const emoji of ["❗️", "📰", "💡", "🎉", "💰", "💎", "⚡️"]) {
    assert.match(resolveForumTopicIconId({ emoji }), /^\d+$/);
  }
});

test("Telegram live icon catalog takes precedence over the bundled fallback", () => {
  assert.equal(
    resolveForumTopicIconId(
      { emoji: "⚡" },
      [{ emoji: "⚡️", custom_emoji_id: "live-lightning" }]
    ),
    "live-lightning"
  );
  assert.equal(resolveForumTopicIconId({ iconCustomEmojiId: "explicit", emoji: "📰" }), "explicit");
  assert.equal(defaultForumTopicIconIds["📰"], "5434144690511290129");
});
