import assert from "node:assert/strict";
import test from "node:test";
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
    threadId: 8,
    groupName: "DEMO Academy",
    topicName: "2. Market Events"
  });
  assert.equal(repaired.targets[0].id, "target-events");
  assert.equal(repaired.targets[0].groupName, "CryptoGuy Academy");
  assert.equal(repaired.targets[0].topicName, "2. Market Events");
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

test("rejects a broadcast target that points back to its own source topic", () => {
  const errors = validateDistributionRule({
    kind: "broadcast",
    name: "Demo sync",
    source: { chatId: "-1001", threadId: 8 },
    targets: [{ chatId: "-1001", threadId: 8 }]
  });

  assert.deepEqual(errors, [{
    field: "targets",
    message: "来源 Topic 不能同时作为目标，请检查群和 Topic 绑定"
  }]);
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

test("legacy whale jobs migrate to the approved daily UTC schedule", () => {
  const migrated = migrateLegacyDistribution({
    groups: [{ title: "DEMO Academy", chatId: "-1001", topics: [{ name: "6. Smart Money Tracker", threadId: 16 }] }],
    bindings: [{ type: "自动发布", config: "大户挂单 & 巨鲸数据", group: "DEMO Academy", topic: "6. Smart Money Tracker", status: "已启用" }]
  });
  assert.equal(migrated.automaticRules[0].contentType, "whale-signals");
  assert.equal(migrated.automaticRules[0].schedulePreset, "daily-0800-utc");
});
