import assert from "node:assert/strict";
import test from "node:test";
import * as distributionDomain from "../lib/distribution-domain.mjs";
import {
  computeNextRunAt,
  ensureAutomationNextRunAt,
  migrateLegacyDistribution,
  normalizeDistributionRule,
  reconcileDistributionRouting,
  reconcileDistributionTargets,
  findDistributionTargetMismatches,
  validateDistributionRule
} from "../lib/distribution-domain.mjs";

function productionGroups() {
  const sourceTopics = [
    ["1. Demo Topic 1", 101],
    ["5. Community Signal", 105],
    ["4. Market Analysis - Crypto/Stocks/TradFi", 104],
    ["3. Market Events", 103],
    ["6. Smart Money Tracker", 106],
    ["7. YUBIT Updates", 107],
    ["2. CryptoGuy Trading Zone", 102],
  ];
  const targetTopics = [
    ["1. Target Topic 1", 201],
    ["5. Community Signal", 205],
    ["4. Market Analysis - Crypto/Stocks/TradFi", 204],
    ["3. Market Events", 203],
    ["6. Smart Money Tracker", 206],
    ["7. YUBIT Updates", 207],
    ["2. CryptoGuy Trading Zone", 202],
  ];
  return [
    {
      chatId: "-1003710405969",
      title: "DEMO Academy",
      topics: sourceTopics.map(([name, threadId]) => ({
        name,
        threadId,
        verified: true,
      })),
    },
    {
      chatId: "-1004378187866",
      title: "CryptoGuy Academy",
      topics: targetTopics.map(([name, threadId]) => ({
        name,
        threadId,
        verified: true,
      })),
    },
  ];
}

test("standard production provisioning keeps editorial SpeakerBot automations in DEMO and builds seven disabled one-to-one ForwardBot broadcasts", () => {
  assert.equal(typeof distributionDomain.buildStandardProductionDistributionRules, "function");
  const rules = distributionDomain.buildStandardProductionDistributionRules(productionGroups());
  const repeated = distributionDomain.buildStandardProductionDistributionRules(productionGroups());

  assert.equal(rules.length, 12);
  assert.ok(rules.every((rule) => rule.enabled === false));
  assert.deepEqual(rules.map((rule) => rule.id), repeated.map((rule) => rule.id));

  const automations = rules.filter((rule) => rule.kind === "automation");
  assert.deepEqual(automations.map(({ contentType, schedulePreset }) => ({ contentType, schedulePreset })), [
    { contentType: "news", schedulePreset: "every-5-minutes" },
    { contentType: "daily-events", schedulePreset: "daily-0800-utc" },
    { contentType: "daily-analysis", schedulePreset: "daily-0800-utc" },
    { contentType: "whale-signals", schedulePreset: "hourly" },
    { contentType: "agent-sync", schedulePreset: "hourly" },
  ]);
  assert.deepEqual(automations.map((rule) => rule.targets.map((target) => target.threadId)), [
    [107, 207],
    [103],
    [104],
    [106],
    [102, 202],
  ]);
  assert.deepEqual(
    automations
      .filter((rule) => ["daily-events", "daily-analysis", "whale-signals"].includes(rule.contentType))
      .map((rule) => rule.targets.map((target) => target.chatId)),
    [["-1003710405969"], ["-1003710405969"], ["-1003710405969"]],
  );
  assert.deepEqual(automations.map((rule) => rule.targets[0].topicName), [
    "7. YUBIT Updates",
    "3. Market Events",
    "4. Market Analysis - Crypto/Stocks/TradFi",
    "6. Smart Money Tracker",
    "2. CryptoGuy Trading Zone",
  ]);

  const broadcasts = rules.filter((rule) => rule.kind === "broadcast");
  assert.equal(broadcasts.length, 7);
  assert.ok(broadcasts.every((rule) => rule.mode === "automatic"));
  assert.deepEqual(broadcasts.map((rule) => [rule.source.threadId, rule.targets[0].threadId]), [
    [101, 201], [102, 202], [103, 203], [104, 204], [105, 205], [106, 206], [107, 207],
  ]);
  assert.deepEqual(broadcasts.map((rule) => rule.source.topicName), [
    "1. READ FIRST - DISCLAIMER",
    "2. CryptoGuy Trading Zone",
    "3. Market Events",
    "4. Market Analysis - Crypto/Stocks/TradFi",
    "5. Community Signal",
    "6. Smart Money Tracker",
    "7. YUBIT Updates",
  ]);
});

test("standard production provisioning preserves existing rule identity and enabled state", () => {
  assert.equal(typeof distributionDomain.buildStandardProductionDistributionRules, "function");
  const existing = [
    normalizeDistributionRule({
      id: "existing-events",
      kind: "automation",
      name: "Old events",
      contentType: "daily-events",
      schedulePreset: "every-5-minutes",
      enabled: true,
      targets: [{ chatId: "-1", threadId: 1 }],
    }),
    normalizeDistributionRule({
      id: "temporary-events",
      kind: "automation",
      name: "Temporary events",
      contentType: "daily-events",
      schedulePreset: "daily-0800-utc",
      enabled: true,
      runOnce: true,
      nextRunAt: "2026-07-17T12:00:00.000Z",
      targets: [{ chatId: "-2", threadId: 2 }],
    }),
    normalizeDistributionRule({
      id: "existing-topic-one",
      kind: "broadcast",
      name: "Old topic one",
      source: { chatId: "-1003710405969", threadId: 101 },
      targets: [{ chatId: "-1", threadId: 1 }],
      enabled: true,
    }),
  ];
  const rules = distributionDomain.buildStandardProductionDistributionRules(productionGroups(), { currentRules: existing });

  const events = rules.find((rule) => rule.contentType === "daily-events");
  assert.equal(events.id, "existing-events");
  assert.equal(events.enabled, true);
  assert.equal(events.schedulePreset, "daily-0800-utc");
  assert.deepEqual(events.targets.map((target) => target.threadId), [103]);

  const topicOne = rules.find((rule) => rule.kind === "broadcast" && rule.source.threadId === 101);
  assert.equal(topicOne.id, "existing-topic-one");
  assert.equal(topicOne.enabled, true);
  assert.equal(topicOne.targets[0].threadId, 201);
});

test("standard production provisioning refuses missing or ambiguous numbered topics", () => {
  assert.equal(typeof distributionDomain.buildStandardProductionDistributionRules, "function");
  const missing = productionGroups();
  missing[1].topics = missing[1].topics.filter((topic) => !topic.name.startsWith("6."));
  assert.throws(
    () => distributionDomain.buildStandardProductionDistributionRules(missing),
    /CryptoGuy Academy.*6 号 Topic/,
  );

  const ambiguous = productionGroups();
  ambiguous[0].topics.push({ name: "2. Duplicate", threadId: 999, verified: true });
  assert.throws(
    () => distributionDomain.buildStandardProductionDistributionRules(ambiguous),
    /DEMO Academy.*2 号 Topic.*2 个/,
  );
});

test("an automatic job keeps every stable chat and thread target", () => {
  const rule = normalizeDistributionRule({
    id: "daily-events",
    kind: "automation",
    name: "Daily Events",
    contentType: "daily-events",
    schedulePreset: "daily-0800-utc",
    targets: [
      { chatId: -1001, threadId: 8, groupName: "Alpha", topicName: "Events" },
      { chatId: "-1002", threadId: "13", groupName: "Beta", topicName: "Events" }
    ]
  });

  assert.deepEqual(rule.targets.map(({ chatId, threadId }) => ({ chatId, threadId })), [
    { chatId: "-1001", threadId: 8 },
    { chatId: "-1002", threadId: 13 }
  ]);
  assert.deepEqual(validateDistributionRule(rule), []);
});

test("an automatic job can publish to Telegram and Discord without changing Telegram targets", () => {
  const rule = normalizeDistributionRule({
    id: "dual-platform-events",
    kind: "automation",
    name: "Daily Events",
    contentType: "daily-events",
    schedulePreset: "daily-0800-utc",
    targets: [
      { chatId: "-1001", threadId: 8, groupName: "Telegram Academy", topicName: "3. Market Events" },
      { platform: "discord", guildId: "guild-1", channelId: "channel-3", serverName: "Discord Academy", channelName: "market-events" },
    ],
  });

  assert.deepEqual(rule.targets[0], {
    id: rule.targets[0].id,
    chatId: "-1001",
    chatType: "supergroup",
    threadId: 8,
    groupName: "Telegram Academy",
    topicName: "3. Market Events",
    enabled: true,
    order: 0,
  });
  assert.deepEqual(rule.targets[1], {
    platform: "discord",
    id: rule.targets[1].id,
    guildId: "guild-1",
    channelId: "channel-3",
    groupName: "Discord Academy",
    topicName: "market-events",
    enabled: true,
    order: 1,
  });
  assert.deepEqual(validateDistributionRule(rule), []);
});

test("Telegram broadcast rules ignore Discord destinations", () => {
  const rule = normalizeDistributionRule({
    id: "telegram-only-broadcast",
    kind: "broadcast",
    name: "Telegram broadcast",
    source: { chatId: "-1001", threadId: 8 },
    targets: [
      { chatId: "-1002", threadId: 9 },
      { platform: "discord", guildId: "guild-1", channelId: "channel-3" },
    ],
  });

  assert.equal(rule.targets.length, 1);
  assert.equal(rule.targets[0].chatId, "-1002");
});

test("an automatic job keeps a channel destination without inventing a thread", () => {
  const rule = normalizeDistributionRule({
    id: "channel-events",
    kind: "automation",
    name: "Private channel events",
    contentType: "daily-events",
    schedulePreset: "daily-0800-utc",
    targets: [{
      chatId: "-1009001",
      chatType: "channel",
      threadId: null,
      groupName: "Private Distribution Test",
      topicName: "整个频道"
    }]
  });

  assert.equal(rule.targets[0].chatType, "channel");
  assert.equal(rule.targets[0].threadId, null);
  assert.deepEqual(validateDistributionRule(rule), []);
});

test("a supergroup destination must still select a Topic", () => {
  const rule = normalizeDistributionRule({
    id: "invalid-group-target",
    kind: "automation",
    name: "Invalid group target",
    contentType: "daily-events",
    schedulePreset: "daily-0800-utc",
    targets: [{ chatId: "-1001", chatType: "supergroup", threadId: null }]
  });

  assert.match(validateDistributionRule(rule).map((error) => error.message).join("\n"), /Topic/);
});

test("target identifiers are stable inside one rule and isolated between rules", () => {
  const input = {
    kind: "broadcast",
    name: "Shared destination",
    source: { chatId: "-1001" },
    targets: [{ chatId: "-2001", threadId: 21 }]
  };
  const first = normalizeDistributionRule({ ...input, id: "rule-a" });
  const repeated = normalizeDistributionRule(first);
  const otherRule = normalizeDistributionRule({ ...input, id: "rule-b" });

  assert.equal(first.targets[0].id, repeated.targets[0].id);
  assert.notEqual(first.targets[0].id, otherRule.targets[0].id);
});

test("stale target thread IDs follow the authoritative group topic name without changing target identity", () => {
  const rule = normalizeDistributionRule({
    id: "rule-analysis",
    kind: "automation",
    name: "Daily Analysis",
    contentType: "daily-analysis",
    schedulePreset: "daily-0800-utc",
    targets: [{
      id: "target-demo-analysis",
      chatId: "-1003710405969",
      threadId: 6,
      groupName: "DEMO Academy",
      topicName: "📊 3. Market Analysis - Crypto/Stocks/TradFi"
    }]
  });
  const groups = [{
    chatId: "-1003710405969",
    title: "DEMO Academy",
    topics: [{ name: "3. Market Analysis - Crypto/Stocks/TradFi", threadId: 10, verified: true }]
  }];

  assert.deepEqual(findDistributionTargetMismatches(rule, groups), [{
    targetId: "target-demo-analysis",
    chatId: "-1003710405969",
    topicName: "📊 3. Market Analysis - Crypto/Stocks/TradFi",
    configuredThreadId: 6,
    expectedThreadId: 10
  }]);

  const repaired = reconcileDistributionTargets(rule, groups);
  assert.equal(repaired.targets[0].id, "target-demo-analysis");
  assert.equal(repaired.targets[0].threadId, 10);
});

test("target reconciliation never guesses when the topic name is missing or ambiguous", () => {
  const rule = normalizeDistributionRule({
    id: "rule-whale",
    kind: "automation",
    name: "Whale",
    contentType: "whale-signals",
    schedulePreset: "hourly",
    targets: [{ id: "target-whale", chatId: "-1001", threadId: 12, topicName: "6. Smart Money Tracker" }]
  });
  const groups = [{
    chatId: "-1001",
    topics: [
      { name: "6. Smart Money Tracker", threadId: 16, verified: true },
      { name: "6. Smart Money Tracker", threadId: 116, verified: true }
    ]
  }];

  assert.equal(reconcileDistributionTargets(rule, groups).targets[0].threadId, 12);
  assert.deepEqual(findDistributionTargetMismatches(rule, groups), []);
});

test("a broadcast source is reconciled by the same authoritative group topic catalog", () => {
  const rule = normalizeDistributionRule({
    id: "rule-demo-analysis",
    kind: "broadcast",
    name: "Demo analysis sync",
    source: {
      chatId: "-1003710405969",
      threadId: 6,
      groupName: "DEMO Academy",
      topicName: "📊 3. Market Analysis - Crypto/Stocks/TradFi"
    },
    targets: [{ id: "target-crypto", chatId: "-1004378187866", threadId: 11, topicName: "3. Market Analysis - Crypto/Stocks/TradFi" }]
  });
  const groups = [{
    chatId: "-1003710405969",
    topics: [{ name: "3. Market Analysis - Crypto/Stocks/TradFi", threadId: 10, verified: true }]
  }];

  const repaired = reconcileDistributionRouting(rule, groups);
  assert.equal(repaired.source.threadId, 10);
  assert.equal(repaired.targets[0].threadId, 11);
});

test("stable chat and thread IDs refresh stale group and topic display names", () => {
  const rule = normalizeDistributionRule({
    id: "rule-display-refresh",
    kind: "broadcast",
    name: "Demo events sync",
    source: {
      chatId: "-1003710405969",
      threadId: 8,
      groupName: "Old demo name",
      topicName: "📅 2. Old Market Events"
    },
    targets: [{
      id: "target-events",
      chatId: "-1004378187866",
      threadId: 9,
      groupName: "Old target name",
      topicName: "📅 2. Old Market Events"
    }]
  });
  const groups = [
    {
      chatId: "-1003710405969",
      title: "DEMO Academy",
      topics: [{ name: "2. Market Events", threadId: 8, verified: true }]
    },
    {
      chatId: "-1004378187866",
      title: "CryptoGuy Academy",
      topics: [{ name: "2. Market Events", threadId: 9, verified: true }]
    }
  ];

  const repaired = reconcileDistributionRouting(rule, groups);
  assert.deepEqual(repaired.source, {
    chatId: "-1003710405969",
    chatType: "supergroup",
    threadId: 8,
    groupName: "DEMO Academy",
    topicName: "3. Market Events"
  });
  assert.equal(repaired.targets[0].id, "target-events");
  assert.equal(repaired.targets[0].groupName, "CryptoGuy Academy");
  assert.equal(repaired.targets[0].topicName, "3. Market Events");
});

test("numbered topic identity survives an editable topic name change", () => {
  const rule = normalizeDistributionRule({
    id: "rule-demo-trading",
    kind: "broadcast",
    name: "Demo trading sync",
    source: {
      chatId: "-1003710405969",
      threadId: 14,
      topicName: "⚡ 7. CryptoGuy Trading Zone"
    },
    targets: [{ chatId: "-1004378187866", threadId: 22, topicName: "7. CryptoGuy Trading Zone" }]
  });
  const groups = [{
    chatId: "-1003710405969",
    topics: [{ name: "7. xxx's Trading Zone", threadId: 18, verified: true }]
  }];

  assert.equal(reconcileDistributionRouting(rule, groups).source.threadId, 18);
});

test("rejects a broadcast target that points back to its own source group", () => {
  const errors = validateDistributionRule({
    kind: "broadcast",
    name: "Demo sync",
    source: { chatId: "-1001", threadId: 8 },
    targets: [{ chatId: "-1001", threadId: 8 }]
  });

  assert.deepEqual(errors, [{
    field: "targets",
    message: "来源群不能同时作为目标群，请选择其他群的 Topic"
  }]);
});

test("rejects cross-topic routing inside the source group to prevent broadcast loops", () => {
  const errors = validateDistributionRule({
    kind: "broadcast",
    name: "Unsafe Demo cross-topic sync",
    source: { chatId: "-1001", threadId: 8 },
    targets: [{ chatId: "-1001", threadId: 10 }]
  });

  assert.deepEqual(errors, [{
    field: "targets",
    message: "来源群不能同时作为目标群，请选择其他群的 Topic"
  }]);
});

test("a Forum group broadcast source must select an exact Topic", () => {
  const errors = validateDistributionRule({
    kind: "broadcast",
    name: "Unsafe whole-group sync",
    source: { chatId: "-1001", chatType: "supergroup" },
    targets: [{ chatId: "-1002", threadId: 8 }]
  });

  assert.deepEqual(errors, [{
    field: "source.threadId",
    message: "来源群必须选择 Topic"
  }]);
});

test("a Channel broadcast source does not invent a Topic", () => {
  assert.deepEqual(validateDistributionRule({
    kind: "broadcast",
    name: "Channel sync",
    source: { chatId: "-1009", chatType: "channel" },
    targets: [{ chatId: "-1002", threadId: 8 }]
  }), []);
});

test("preset schedules calculate the next UTC execution boundary", () => {
  const now = new Date("2026-07-14T08:03:00.000Z");
  assert.equal(computeNextRunAt("daily-0800-utc", now).toISOString(), "2026-07-15T08:00:00.000Z");
  assert.equal(computeNextRunAt("hourly", now).toISOString(), "2026-07-14T09:00:00.000Z");
  assert.equal(computeNextRunAt("every-4-hours", now).toISOString(), "2026-07-14T12:00:00.000Z");
  assert.equal(computeNextRunAt("every-5-minutes", now).toISOString(), "2026-07-14T08:05:00.000Z");
});

test("enabled automation rules receive a future first run while disabled rules stay unscheduled", () => {
  const now = new Date("2026-07-14T08:03:00.000Z");
  const enabled = ensureAutomationNextRunAt({ kind: "automation", enabled: true, schedulePreset: "hourly", nextRunAt: null }, now);
  const disabled = ensureAutomationNextRunAt({ kind: "automation", enabled: false, schedulePreset: "hourly", nextRunAt: null }, now);

  assert.equal(enabled.nextRunAt, "2026-07-14T09:00:00.000Z");
  assert.equal(disabled.nextRunAt, null);
});

test("one-time automation keeps its explicit execution time and requires one", () => {
  const scheduled = normalizeDistributionRule({
    id: "one-time-analysis",
    kind: "automation",
    name: "Daily Analysis · One-time",
    contentType: "daily-analysis",
    schedulePreset: "daily-0800-utc",
    enabled: true,
    runOnce: true,
    nextRunAt: "2026-07-17T12:34:00.000Z",
    targets: [{ chatId: "-1001", threadId: 10 }],
  });
  assert.equal(scheduled.runOnce, true);
  assert.equal(
    ensureAutomationNextRunAt(scheduled, new Date("2026-07-17T11:34:00.000Z")).nextRunAt,
    "2026-07-17T12:34:00.000Z",
  );

  const missingTime = { ...scheduled, nextRunAt: null };
  assert.deepEqual(validateDistributionRule(missingTime), [{
    field: "nextRunAt",
    message: "一次性任务必须设置执行时间",
  }]);
});

test("legacy bindings and broadcast rules migrate once and ambiguous rows stay disabled", () => {
  const input = {
    groups: [{
      title: "DEMO Academy",
      chatId: "-1001",
      topics: [{ name: "2. Market Events", threadId: 8 }]
    }],
    bindings: [
      { type: "新闻配置", config: "Daily Events", group: "DEMO Academy", topic: "2. Market Events", status: "已启用" },
      { type: "广播", config: "Unknown", group: "Missing", topic: "Missing", status: "已启用" }
    ],
    broadcastRules: [{ name: "Demo feed", chatId: "-2001", topicId: 12, topic: "Source" }]
  };

  const first = migrateLegacyDistribution(input);
  const second = migrateLegacyDistribution(input);
  assert.deepEqual(first, second);
  assert.equal(first.automaticRules[0].enabled, true);
  assert.deepEqual(first.automaticRules[0].targets[0], {
    chatId: "-1001",
    threadId: 8,
    groupName: "DEMO Academy",
    topicName: "2. Market Events"
  });
  assert.equal(first.pendingRules[0].enabled, false);
  assert.equal(first.broadcastRules[0].status, "pending-confirmation");
});

test("legacy whale jobs migrate to hourly monitoring with anomaly gating", () => {
  const migrated = migrateLegacyDistribution({
    groups: [{ title: "DEMO Academy", chatId: "-1001", topics: [{ name: "6. Smart Money Tracker", threadId: 16 }] }],
    bindings: [{ type: "自动发布", config: "大户挂单 & 巨鲸数据", group: "DEMO Academy", topic: "6. Smart Money Tracker", status: "已启用" }]
  });
  assert.equal(migrated.automaticRules[0].contentType, "whale-signals");
  assert.equal(migrated.automaticRules[0].schedulePreset, "hourly");
});
