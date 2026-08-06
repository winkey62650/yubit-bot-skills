import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAccountCanSendToTargets,
  buildAccountTargetGroups
} from "../lib/telegram-composer-targets.mjs";

const configuredGroups = [
  {
    chatId: "-100111",
    title: "Nicholas Academy",
    isForum: true,
    topics: [{ threadId: 7, name: "Signals" }]
  },
  {
    chatId: "-100222",
    title: "Serenity Academy",
    isForum: true,
    topics: [{ threadId: 9, name: "News" }]
  }
];

test("composer targets contain only writable dialogs for the selected account", () => {
  const groups = buildAccountTargetGroups(configuredGroups, [
    { id: "-100111", title: "Nicholas Academy", isForum: true, type: "supergroup", canSendMessages: true },
    { id: "-100333", title: "Nicholas Channel", isChannel: true, type: "channel", canSendMessages: true },
    { id: "-100444", title: "Read-only Channel", isChannel: true, type: "channel", canSendMessages: false }
  ]);

  assert.deepEqual(groups.map((group) => group.chatId), ["-100111", "-100333"]);
  assert.deepEqual(groups[0].topics, [{ threadId: 7, name: "Signals" }]);
  assert.equal(groups.some((group) => group.chatId === "-100222"), false);
  assert.equal(groups.some((group) => group.chatId === "-100444"), false);
});

test("composer rejects targets that the selected account cannot write to", () => {
  const dialogs = [
    { id: "-100111", canSendMessages: true },
    { id: "-100444", canSendMessages: false }
  ];

  assert.doesNotThrow(() => assertAccountCanSendToTargets(dialogs, ["-100111:7"]));
  assert.throws(
    () => assertAccountCanSendToTargets(dialogs, ["-100222:9"]),
    (error) => error?.code === "TELEGRAM_ACCOUNT_TARGET_FORBIDDEN"
  );
  assert.throws(
    () => assertAccountCanSendToTargets(dialogs, ["-100444:"]),
    (error) => error?.code === "TELEGRAM_ACCOUNT_TARGET_FORBIDDEN"
  );
});
