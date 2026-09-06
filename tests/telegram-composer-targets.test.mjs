import assert from "node:assert/strict";
import test from "node:test";
import {
  accountCanSendToTarget,
  assertAccountCanSendToTargets,
  buildAccountTargetGroups,
  filterTelegramComposerTargets
} from "../lib/telegram-composer-targets.mjs";

test("composer can skip an unavailable automatic destination without rejecting the selected source", () => {
  const dialogs = [
    {
      id: "-100-source",
      isForum: true,
      canSendMessages: true,
      topics: [{ threadId: 12, availabilityStatus: "available", canSendMessages: true }]
    },
    {
      id: "-100-downstream",
      isForum: true,
      canSendMessages: true,
      topics: [{ threadId: 25, availabilityStatus: "closed", canSendMessages: false }]
    }
  ];

  assert.equal(accountCanSendToTarget(dialogs, "-100-source:12"), true);
  assert.equal(accountCanSendToTarget(dialogs, "-100-downstream:25"), false);
  assert.doesNotThrow(() => assertAccountCanSendToTargets(dialogs, ["-100-source:12"]));
});

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

test("composer directory contains only joined dialogs and keeps unwritable destinations disabled", () => {
  const groups = buildAccountTargetGroups(configuredGroups, [
    {
      id: "-100111",
      title: "Nicholas Academy",
      isForum: true,
      type: "supergroup",
      canSendMessages: true,
      topics: [{ threadId: 7, name: "Signals", availabilityStatus: "available", canSendMessages: true }]
    },
    { id: "-100333", title: "Nicholas Channel", isChannel: true, type: "channel", canSendMessages: true },
    { id: "-100444", title: "Read-only Channel", isChannel: true, type: "channel", canSendMessages: false }
  ]);

  assert.deepEqual(groups.map((group) => group.chatId), ["-100111", "-100333", "-100444"]);
  assert.deepEqual(groups[0].topics, [{
    threadId: 7,
    name: "Signals",
    liveName: "Signals",
    availabilityStatus: "available",
    canSendMessages: true
  }]);
  assert.equal(groups.some((group) => group.chatId === "-100222"), false);
  assert.equal(groups.find((group) => group.chatId === "-100444").canSendMessages, false);
});

test("composer rejects targets that the selected account cannot write to", () => {
  const dialogs = [
    {
      id: "-100111",
      canSendMessages: true,
      topics: [{ threadId: 7, availabilityStatus: "available", canSendMessages: true }]
    },
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

test("composer rejects a closed or missing forum topic before any delivery starts", () => {
  const closedDialogs = [{
    id: "-100111",
    canSendMessages: true,
    topics: [{ threadId: 7, availabilityStatus: "closed", canSendMessages: false }]
  }];

  assert.throws(
    () => assertAccountCanSendToTargets(closedDialogs, ["-100111:7"]),
    (error) => error?.code === "TELEGRAM_TOPIC_NOT_WRITABLE"
  );
  assert.throws(
    () => assertAccountCanSendToTargets(closedDialogs, ["-100111:99"]),
    (error) => error?.code === "TELEGRAM_TOPIC_NOT_WRITABLE"
  );
});

test("composer allows a managed closed topic without a mutation marker", () => {
  const dialogs = [{
    id: "-100111",
    title: "Nicholas Academy",
    isForum: true,
    canSendMessages: true,
    topics: [{
      threadId: 7,
      name: "Signals",
      availabilityStatus: "managed-closed",
      canSendMessages: true
    }]
  }];

  assert.doesNotThrow(() => assertAccountCanSendToTargets(dialogs, ["-100111:7"]));
  const groups = buildAccountTargetGroups(configuredGroups, dialogs);
  assert.equal(groups[0].topics[0].availabilityStatus, "managed-closed");
  assert.equal("requiresTemporaryReopen" in groups[0].topics[0], false);
});

test("composer blocks forum topics whose live status cannot be verified", () => {
  const dialogs = [{
    id: "-100111",
    canSendMessages: true,
    topicStatusError: "network unavailable",
    topics: [{ threadId: 7, availabilityStatus: "unknown", canSendMessages: false }]
  }];

  assert.throws(
    () => assertAccountCanSendToTargets(dialogs, ["-100111:7"]),
    (error) => error?.code === "TELEGRAM_TOPIC_STATUS_UNAVAILABLE"
  );
});

test("composer requires an explicit verified topic for forum destinations", () => {
  const dialogs = [{
    id: "-100111",
    type: "supergroup",
    isForum: true,
    canSendMessages: true,
    topics: [{ threadId: 7, availabilityStatus: "available", canSendMessages: true }]
  }];

  assert.throws(
    () => assertAccountCanSendToTargets(dialogs, ["-100111:"]),
    (error) => error?.code === "TELEGRAM_FORUM_TOPIC_REQUIRED"
  );
});

test("composer still allows a writable channel without a topic", () => {
  const dialogs = [{
    id: "-100333",
    type: "channel",
    isChannel: true,
    canSendMessages: true
  }];

  assert.doesNotThrow(() => assertAccountCanSendToTargets(dialogs, ["-100333:"]));
});

test("composer exposes live topics from unconfigured forums and appends newly discovered topics", () => {
  const groups = buildAccountTargetGroups(configuredGroups, [
    {
      id: "-100111",
      title: "Nicholas Academy",
      isForum: true,
      canSendMessages: true,
      topics: [
        { threadId: 7, name: "Signals Live", availabilityStatus: "available", canSendMessages: true },
        { threadId: 8, name: "Wins", availabilityStatus: "available", canSendMessages: true }
      ]
    },
    {
      id: "-100999",
      title: "BTDcrypto x YUBIT Research",
      isForum: true,
      canSendMessages: true,
      topics: [
        { threadId: 4, name: "General", availabilityStatus: "available", canSendMessages: true },
        { threadId: 9, name: "Crypto Analysis", availabilityStatus: "available", canSendMessages: true }
      ]
    }
  ]);

  assert.deepEqual(groups[0].topics.map((topic) => [topic.threadId, topic.liveName]), [
    [7, "Signals Live"],
    [8, "Wins"]
  ]);
  assert.deepEqual(groups[1].topics.map((topic) => [topic.threadId, topic.liveName]), [
    [4, "General"],
    [9, "Crypto Analysis"]
  ]);
});

test("composer target search matches group and Topic names without mutating the source list", () => {
  const targetGroups = [
    {
      chatId: "-100111",
      title: "Nicholas Academy",
      options: [
        { id: "-100111:7", label: "Signals" },
        { id: "-100111:8", label: "Market News" }
      ]
    },
    {
      chatId: "-100222",
      title: "Serenity Research",
      options: [{ id: "-100222:9", label: "Crypto Analysis" }]
    }
  ];

  assert.equal(filterTelegramComposerTargets(targetGroups, " academy ")[0], targetGroups[0]);
  assert.deepEqual(
    filterTelegramComposerTargets(targetGroups, "analysis"),
    [{ ...targetGroups[1], options: [targetGroups[1].options[0]] }]
  );
  assert.deepEqual(filterTelegramComposerTargets(targetGroups, "missing"), []);
  assert.equal(filterTelegramComposerTargets(targetGroups, ""), targetGroups);
  assert.equal(targetGroups[1].options.length, 1);
});

test('composer retains joined but unwritable groups with an actionable reason', () => {
  const groups = buildAccountTargetGroups([], [{
    id:'-100777',title:'Joined restricted group',isForum:true,canSendMessages:false,
    publishUnavailableReason:'official_identity_unavailable',topics:[]
  }]);
  assert.equal(groups.length,1);
  assert.equal(groups[0].canSendMessages,false);
  assert.equal(groups[0].publishUnavailableReason,'official_identity_unavailable');
});
