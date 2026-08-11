import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_TOPIC_ROUTES,
  repairCanonicalTopicRouting,
  topicSequence
} from "../lib/canonical-topic-routing.mjs";

test("topic sequence accepts numbered names with leading emoji", () => {
  assert.equal(topicSequence("📈 4. Market Analysis"), 4);
  assert.equal(topicSequence("6、Smart Money Tracker"), 6);
  assert.equal(topicSequence("General"), null);
});

test("canonical routing preserves the confirmed non-numeric thread order", () => {
  const document = {
    groups: [
      {
        chatId: "-1003710405969",
        topics: Array.from({ length: 7 }, (_, index) => ({
          id: index + 1,
          threadId: index + 1,
          name: `${index + 1}. Demo Topic`,
          closed: index === 3
        }))
      },
      {
        chatId: "-1004378187866",
        topics: Array.from({ length: 7 }, (_, index) => ({
          name: `✨ ${index + 1}. CryptoGuy Topic`
        }))
      },
      { chatId: "-100999", topics: [{ id: 91, name: "1. Other" }] }
    ]
  };

  const repaired = repairCanonicalTopicRouting(document, {
    now: "2026-08-12T00:00:00.000Z"
  });

  assert.equal(repaired.changed, true);
  assert.deepEqual(
    repaired.value.groups[0].topics.map((topic) => topic.threadId),
    CANONICAL_TOPIC_ROUTES["-1003710405969"]
  );
  assert.deepEqual(
    repaired.value.groups[1].topics.map((topic) => topic.threadId),
    CANONICAL_TOPIC_ROUTES["-1004378187866"]
  );
  assert.equal(repaired.value.groups[0].topics[3].closed, true);
  assert.deepEqual(repaired.value.groups[2], document.groups[2]);
});

test("canonical routing is idempotent", () => {
  const original = {
    updatedAt: "2026-08-12T00:00:00.000Z",
    groups: [{
      chatId: "-1003710405969",
      source: "telegram-confirmed",
      detectedTopicThreadIds: [...CANONICAL_TOPIC_ROUTES["-1003710405969"]],
      topics: CANONICAL_TOPIC_ROUTES["-1003710405969"].map((threadId, index) => ({
        id: threadId,
        threadId,
        name: `${index + 1}. Topic`,
        source: "telegram-confirmed",
        verified: true
      })),
      topicCoverage: {
        knownCount: 7,
        resolvedCount: 7,
        detectedThreadCount: 7,
        complete: true
      }
    }]
  };

  const repaired = repairCanonicalTopicRouting(original);
  assert.equal(repaired.changed, false);
  assert.equal(repaired.value, original);
});
