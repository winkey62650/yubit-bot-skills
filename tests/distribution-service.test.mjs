import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  JsonDistributionRepository,
  getDistributionRepository,
  resetDistributionRepositoryForTests
} from "../lib/distribution-repository.mjs";
import {
  backfillRule,
  claimDesktopPublisherDelivery,
  completeDesktopPublisherDelivery,
  createDistributionEngine,
  desktopPublisherHealth,
  ensureAutomationSchedules,
  expandAutomaticBroadcastTargets,
  parseBackfillReferences,
  processTelegramWebhookUpdate,
  repairAutomationTargetLabels,
  repairDemoToJennaXDirection,
  retryDistributionDelivery,
  resetAutomationManualReconciliation,
  runDueDistributionJobs,
  runDistributionAutomationRule,
  telegramCall,
  validateRuleRuntime,
  verifyTelegramWebhookSecret
} from "../lib/distribution-service.mjs";
import { MemoryDistributionRepository } from "../lib/distribution-engine.mjs";
import {
  RELEASE_STATE_META_KEY,
  acknowledgeDataReleaseTarget,
  buildReleaseDeduplicationKey,
  buildDataReleaseTargetKey,
  markDataReleaseTargetPending,
  pollDataReleaseUpdates,
  prepareDataReleaseDelivery,
} from "../lib/data-release-monitor.mjs";

test("distribution Telegram transport forwards AbortSignal and blocks an already-aborted fetch", async () => {
  const controller = new AbortController();
  controller.abort(new Error("DISTRIBUTION_TELEGRAM_ABORTED"));
  let fetchCalls = 0;

  await assert.rejects(telegramCall("forward-token", "sendMessage", {
    chat_id: "-1001",
    text: "stop"
  }, {
    signal: controller.signal,
    env: { TELEGRAM_PUBLISHER_MODE: "bot" },
    fetchImpl: async () => {
      fetchCalls += 1;
    }
  }), /DISTRIBUTION_TELEGRAM_ABORTED/);

  assert.equal(fetchCalls, 0);
});

test("desktop publisher health reflects a recent local bridge heartbeat", async () => {
  const repository = {
    async getMeta(key) {
      assert.equal(key, "desktop-publisher-v1");
      return {
        lastSeenAt: "2026-07-21T13:05:00.000Z",
        lastVerifiedAt: "2026-07-21T13:04:00.000Z",
        lastDeliveryStatus: "success",
        lastError: null
      };
    }
  };
  const env = {
    NODE_ENV: "production",
    TELEGRAM_PUBLISHER_MODE: "user",
    DESKTOP_PUBLISHER_SECRET: "desktop-secret",
    TELEGRAM_USER_PUBLISHER_TARGETS: "-1003710405969",
    TELEGRAM_USER_PUBLISHER_USERNAME: "Serenity_Crypto"
  };

  const health = await desktopPublisherHealth({
    repository,
    env,
    now: new Date("2026-07-21T13:10:00.000Z")
  });

  assert.equal(health.mode, "desktop");
  assert.equal(health.ready, true);
  assert.equal(health.authorized, true);
  assert.equal(health.bridgeActive, true);
  assert.equal(health.targetAuthorizationReady, true);
  assert.equal(health.username, "@Serenity_Crypto");
  assert.deepEqual(health.approvedTargetIds, ["-1003710405969"]);
  assert.equal(health.lastSeenAt, "2026-07-21T13:05:00.000Z");
});

test("desktop publisher health becomes offline after the heartbeat expires", async () => {
  const repository = {
    async getMeta() { return { lastSeenAt: "2026-07-21T12:40:00.000Z" }; }
  };
  const health = await desktopPublisherHealth({
    repository,
    env: {
      NODE_ENV: "production",
      TELEGRAM_PUBLISHER_MODE: "user",
      DESKTOP_PUBLISHER_SECRET: "desktop-secret",
      TELEGRAM_USER_PUBLISHER_TARGETS: "-1003710405969"
    },
    now: new Date("2026-07-21T13:10:00.000Z")
  });

  assert.equal(health.ready, false);
  assert.equal(health.authorized, false);
  assert.equal(health.bridgeActive, false);
  assert.equal(health.targetAuthorizationReady, true);
});

test("desktop publisher health keeps bridge availability separate from the latest delivery result", async () => {
  const stalledRepository = {
    async getMeta() {
      return {
        lastSeenAt: "2026-07-21T13:09:00.000Z",
        lastDeliveryStatus: "failed",
        lastError: "previous delivery failed"
      };
    },
    async listDeliveries({ status }) {
      assert.equal(status, "sending");
      return [{
        id: "delivery-stalled",
        ruleId: "rule-analysis",
        status: "sending",
        createdAt: "2026-07-21T12:40:00.000Z",
        updatedAt: "2026-07-21T12:55:00.000Z",
        publisherProgress: []
      }];
    }
  };
  const env = {
    NODE_ENV: "production",
    TELEGRAM_PUBLISHER_MODE: "user",
    DESKTOP_PUBLISHER_SECRET: "desktop-secret",
    TELEGRAM_USER_PUBLISHER_TARGETS: "-1003710405969"
  };

  const stalled = await desktopPublisherHealth({
    repository: stalledRepository,
    env,
    now: new Date("2026-07-21T13:10:00.000Z")
  });

  assert.equal(stalled.ready, true);
  assert.equal(stalled.operationalReady, false);
  assert.equal(stalled.operationalStatus, "stalled");
  assert.equal(stalled.activeDelivery.id, "delivery-stalled");
  assert.match(stalled.operationalError, /卡住/);

  const degraded = await desktopPublisherHealth({
    repository: {
      async getMeta() {
        return {
          lastSeenAt: "2026-07-21T13:09:00.000Z",
          lastDeliveryStatus: "failed",
          lastError: "previous delivery failed"
        };
      },
      async listDeliveries() { return []; }
    },
    env,
    now: new Date("2026-07-21T13:10:00.000Z")
  });

  assert.equal(degraded.operationalStatus, "online");
  assert.equal(degraded.operationalReady, true);
  assert.equal(degraded.operationalError, null);
  assert.equal(degraded.lastDeliveryStatus, "failed");
  assert.equal(degraded.lastError, "previous delivery failed");
});

test("desktop publisher health suppresses the obsolete Telegram window-title identity false positive", async () => {
  const repository = {
    async getMeta() {
      return {
        lastSeenAt: "2026-07-22T04:55:00.000Z",
        lastDeliveryAt: "2026-07-22T04:37:00.000Z",
        lastDeliveryStatus: "failed",
        lastError: "Telegram Desktop 当前显示 @Melody，无法可靠确认 @Serenity_Crypto 正以 DEMO Academy 群身份发送；未粘贴、未选图、未发送。"
      };
    },
    async listDeliveries() {
      return [];
    }
  };

  const health = await desktopPublisherHealth({
    repository,
    env: {
      NODE_ENV: "production",
      TELEGRAM_PUBLISHER_MODE: "user",
      DESKTOP_PUBLISHER_SECRET: "desktop-secret",
      TELEGRAM_USER_PUBLISHER_TARGETS: "-1003710405969",
      TELEGRAM_USER_PUBLISHER_USERNAME: "Serenity_Crypto"
    },
    now: new Date("2026-07-22T04:56:00.000Z")
  });

  assert.equal(health.operationalStatus, "online");
  assert.equal(health.lastDeliveryAt, null);
  assert.equal(health.lastDeliveryStatus, null);
  assert.equal(health.lastError, null);
});

test("automation targets repair only stale generic Topic labels", () => {
  const rule = {
    id: "events",
    kind: "automation",
    contentType: "daily-events",
    targets: [
      { id: "generic", threadId: 8, topicName: "Topic 8" },
      { id: "custom", threadId: 99, topicName: "Editorial Events" }
    ]
  };

  const repaired = repairAutomationTargetLabels(rule);

  assert.equal(repaired.targets[0].topicName, "3. Market Events");
  assert.equal(repaired.targets[1].topicName, "Editorial Events");
  assert.equal(rule.targets[0].topicName, "Topic 8");
});

test("Demo to JennaX rules repair an accidentally reversed source and target", () => {
  const reversed = {
    id: "smart-money-sync",
    kind: "broadcast",
    name: "Demo to JennaX Smart Money",
    source: {
      chatId: "-1003332783916",
      chatType: "supergroup",
      threadId: 22,
      groupName: "JennaX Trading Academy",
      topicName: "6. Smart Money Tracker"
    },
    targets: [{
      id: "target-smart-money",
      chatId: "-1003710405969",
      chatType: "supergroup",
      threadId: 16,
      groupName: "DEMO Academy",
      topicName: "6. Smart Money Tracker",
      enabled: true,
      order: 0
    }]
  };

  const repaired = repairDemoToJennaXDirection(reversed);

  assert.equal(repaired.source.chatId, "-1003710405969");
  assert.equal(repaired.source.threadId, 16);
  assert.equal(repaired.targets[0].chatId, "-1003332783916");
  assert.equal(repaired.targets[0].threadId, 22);
  assert.equal(repaired.targets[0].id, "target-smart-money");
  assert.equal(reversed.source.chatId, "-1003332783916");
});

test("manual backfill accepts IDs, ranges and Telegram links without exceeding 100 messages", () => {
  assert.deepEqual(parseBackfillReferences("77, 79-81\nhttps://t.me/c/12345/12/90"), [77, 79, 80, 81, 90]);
  assert.throws(() => parseBackfillReferences("1-101"), /最多 100/);
});

test("production backfill previews and publishes only to the approved Demo group", async () => {
  const demo = { id: "demo", chatId: "-1003710405969", threadId: 5 };
  const fight = { id: "fight", chatId: "-1004309440933", threadId: 5 };
  const rule = {
    id: "broadcast-demo-lock",
    kind: "broadcast",
    source: { chatId: "-100source" },
    targets: [demo, fight]
  };
  const repository = {
    async getRule() { return rule; },
    async findEventBySource() { return null; }
  };
  const env = { NODE_ENV: "production" };

  const preview = await backfillRule(rule.id, "492", { preview: true, repository, env });
  assert.deepEqual(preview.targets, [demo]);

  await assert.rejects(
    () => backfillRule(rule.id, "492", {
      preview: false,
      repository: { ...repository, async getRule() { return { ...rule, targets: [fight] }; } },
      env
    }),
    /DEMO_ONLY_TEST_POLICY/
  );
});

test("an explicit production distribution allowlist supersedes the implicit Demo group", async () => {
  const demo = { id: "demo", chatId: "-1003710405969", threadId: 10 };
  const cryptoAnalysis = { id: "crypto-analysis", chatId: "-1004378187866", threadId: 11 };
  const cryptoSmartMoney = { id: "crypto-smart-money", chatId: "-1004378187866", threadId: 19 };
  const cryptoTrader = { id: "crypto-trader", chatId: "-1004378187866", threadId: 17 };
  const fightAnalysis = { id: "fight-analysis", chatId: "-1004309440933", threadId: 70 };
  const rule = {
    id: "broadcast-approved-topics",
    kind: "broadcast",
    source: { chatId: "-100source" },
    targets: [demo, cryptoAnalysis, cryptoSmartMoney, cryptoTrader, fightAnalysis]
  };
  const repository = {
    async getRule() { return rule; },
    async findEventBySource() { return null; }
  };
  const env = {
    NODE_ENV: "production",
    TELEGRAM_DEMO_ONLY: "true",
    TELEGRAM_DISTRIBUTION_APPROVED_TARGETS: "-1004378187866:11,-1004378187866:19"
  };

  const preview = await backfillRule(rule.id, "492", { preview: true, repository, env });

  assert.deepEqual(preview.targets, [cryptoAnalysis, cryptoSmartMoney]);
  assert.equal(preview.targets.some((target) => target.id === "demo"), false);
  assert.equal(preview.targets.some((target) => target.id === "crypto-trader"), false);
  assert.equal(preview.targets.some((target) => target.id === "fight-analysis"), false);
});

test("production distribution allowlist can approve one whole private channel", async () => {
  const privateChannel = {
    id: "private-channel",
    chatId: "-1009001",
    chatType: "channel",
    threadId: null,
    groupName: "Private Distribution Test",
    topicName: "整个频道"
  };
  const unapprovedChannel = {
    id: "other-channel",
    chatId: "-1009002",
    chatType: "channel",
    threadId: null,
    groupName: "Other Channel",
    topicName: "整个频道"
  };
  const rule = {
    id: "broadcast-approved-channel",
    kind: "broadcast",
    source: { chatId: "-100source" },
    targets: [privateChannel, unapprovedChannel]
  };
  const repository = {
    async getRule() { return rule; },
    async findEventBySource() { return null; }
  };
  const env = {
    NODE_ENV: "production",
    TELEGRAM_DEMO_ONLY: "true",
    TELEGRAM_DISTRIBUTION_APPROVED_TARGETS: "-1009001:channel"
  };

  const preview = await backfillRule(rule.id, "492", { preview: true, repository, env });
  assert.deepEqual(preview.targets, [privateChannel]);
});

test("production retry refuses a failed delivery outside the Demo group", async () => {
  const repository = {
    async getDelivery() {
      return {
        id: "delivery-fight",
        eventId: "event-1",
        status: "failed",
        target: { id: "fight", chatId: "-1004309440933", threadId: 5 }
      };
    }
  };

  await assert.rejects(
    () => retryDistributionDelivery("delivery-fight", { repository, env: { NODE_ENV: "production" } }),
    /DEMO_ONLY_TEST_POLICY/
  );
});

test("data-release automation retry passes the active repository to its runner", async () => {
  const delivery = { id: "delivery-release-retry", eventId: "event-release-retry", status: "failed", attempts: 1, target: { id: "release-target", chatId: "-1001", threadId: 8 } };
  const event = { id: delivery.eventId, eventType: "automation", createdAt: "2026-08-19T12:31:00.000Z", payload: { jobId: "data-release-updates", slotAt: "2026-08-19T12:31:00.000Z" } };
  const repository = {
    async getDelivery() { return delivery; },
    async getEvent() { return event; },
    async claimDelivery() { return { ...delivery, status: "sending" }; },
    async updateDelivery(_id, patch) { return Object.assign(delivery, patch); },
  };
  let receivedRepository;
  await retryDistributionDelivery(delivery.id, {
    repository,
    env: { NODE_ENV: "test", DEMO_TELEGRAM_CHAT_ID: "-1001" },
    runner: async (_jobId, options) => {
      receivedRepository = options.repository;
      return { status: "success", preview: { targetResults: [{ target: delivery.target, status: "success", messageId: 1 }] } };
    },
  });
  assert.equal(receivedRepository, repository);
});

test("webhook secret verification rejects missing configuration and wrong values", () => {
  assert.equal(verifyTelegramWebhookSecret("a", "a"), true);
  assert.equal(verifyTelegramWebhookSecret("a", "b"), false);
  assert.equal(verifyTelegramWebhookSecret("", ""), false);
});

test("webhook delivery completes before best-effort group discovery and survives discovery failure", async () => {
  const calls = [];
  let deferredTask;
  const result = await processTelegramWebhookUpdate({ update_id: 42 }, {
    engineFactory: async () => ({
      async receiveUpdate(update) {
        calls.push(`deliver:${update.update_id}`);
        return { status: "delivered" };
      }
    }),
    register: async () => {
      calls.push("discover");
      throw new Error("temporary Blob failure");
    },
    defer(task) {
      deferredTask = task;
    },
    logger: { error() {} }
  });

  assert.deepEqual(result, { status: "delivered" });
  assert.deepEqual(calls, ["deliver:42"]);
  await assert.doesNotReject(() => deferredTask());
  assert.deepEqual(calls, ["deliver:42", "discover"]);
});

test("existing enabled rules with no next run are repaired without touching scheduled rules", async () => {
  const saved = [];
  const repository = {
    async listRules() {
      return [
        { id: "missing", kind: "automation", enabled: true, schedulePreset: "every-4-hours", nextRunAt: null },
        { id: "one-time", kind: "automation", enabled: true, runOnce: true, schedulePreset: "hourly", nextRunAt: null },
        { id: "ready", kind: "automation", enabled: true, schedulePreset: "hourly", nextRunAt: "2026-07-14T10:00:00.000Z" }
      ];
    },
    async saveRule(rule) { saved.push(rule); return rule; }
  };

  await ensureAutomationSchedules(repository, new Date("2026-07-14T08:03:00.000Z"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, "missing");
  assert.equal(saved[0].nextRunAt, "2026-07-14T12:00:00.000Z");
});

test("a due one-time automation executes once and is archived as completed", async () => {
  const target = { id: "target-once", chatId: "-1001", threadId: 8 };
  const rule = {
    id: "one-time-events",
    kind: "automation",
    name: "Daily Events · One-time",
    contentType: "daily-events",
    schedulePreset: "daily-0800-utc",
    enabled: true,
    runOnce: true,
    status: "ready",
    nextRunAt: "2026-07-17T12:00:00.000Z",
    targets: [target],
  };
  const savedRules = [];
  const claimOptions = [];
  let claimed = false;
  const events = [];
  const deliveries = [];
  const repository = {
    async cleanupExpired() {},
    async getMeta() { return { completedAt: "2026-07-01T00:00:00.000Z" }; },
    async claimDueAutomationRules(_now, options) {
      claimOptions.push(options);
      if (claimed) return [];
      claimed = true;
      return [rule];
    },
    async listRules() { return []; },
    async createEvent(event) { const saved = { id: "event-once", ...event }; events.push(saved); return saved; },
    async updateEvent(id, patch) { Object.assign(events.find((event) => event.id === id), patch); },
    async createDelivery(delivery) { const saved = { id: "delivery-once", ...delivery }; deliveries.push(saved); return saved; },
    async updateDelivery(id, patch) { return Object.assign(deliveries.find((delivery) => delivery.id === id), patch); },
    async saveMapping() {},
    async saveRule(saved) { savedRules.push(saved); return saved; },
  };
  const runner = async (jobId, options) => {
    assert.equal(jobId, "weekly-calendar");
    assert.deepEqual(options.targets, [target]);
    assert.equal(options.force, true);
    return { status: "success", preview: { targetResults: [{ target, status: "success", messageId: 700 }] } };
  };

  const first = await runDueDistributionJobs(new Date("2026-07-17T12:02:00.000Z"), { repository, runner });
  const second = await runDueDistributionJobs(new Date("2026-07-17T12:07:00.000Z"), { repository, runner });

  assert.equal(first.claimed, 1);
  assert.equal(first.results[0].status, "success");
  assert.equal(second.claimed, 0);
  assert.equal(events.length, 1);
  assert.equal(deliveries.length, 1);
  assert.equal(savedRules.length, 1);
  assert.equal(savedRules[0].enabled, false);
  assert.equal(savedRules[0].runOnce, true);
  assert.equal(savedRules[0].status, "completed");
  assert.equal(savedRules[0].nextRunAt, null);
  assert.equal(savedRules[0].leaseUntil, null);
  assert.deepEqual(claimOptions, [{ limit: 1 }, { limit: 1 }]);
});

test("a skipped one-time automation is requeued instead of being reported as completed", async () => {
  const rule = {
    id: "one-time-skipped-whale",
    kind: "automation",
    name: "Whale Signals · One-time",
    contentType: "whale-signals",
    enabled: true,
    runOnce: true,
    status: "running",
    nextRunAt: "2026-07-17T12:00:00.000Z",
    targets: [{ id: "target", chatId: "-1001", threadId: 16 }]
  };
  const events = [];
  const saved = [];
  const repository = {
    async cleanupExpired() {},
    async getMeta() { return { completedAt: "2026-07-01T00:00:00.000Z" }; },
    async claimDueAutomationRules() { return [rule]; },
    async listRules() { return []; },
    async createEvent(event) { const value = { id: "event-skipped", ...event }; events.push(value); return value; },
    async updateEvent(id, patch) { Object.assign(events.find((event) => event.id === id), patch); },
    async saveRule(value) { saved.push(value); return value; }
  };

  const result = await runDueDistributionJobs(new Date("2026-07-17T12:02:00.000Z"), {
    repository,
    runner: async (_jobId, options) => {
      assert.equal(options.force, true);
      return { status: "skipped", message: "no signal", preview: {} };
    }
  });

  assert.equal(result.results[0].status, "skipped");
  assert.equal(saved[0].enabled, true);
  assert.equal(saved[0].status, "retrying");
  assert.equal(saved[0].nextRunAt, "2026-07-17T12:07:00.000Z");
});

test("a failed one-time automation is requeued instead of being lost", async () => {
  const rule = {
    id: "one-time-retry",
    kind: "automation",
    name: "Daily Analysis · One-time",
    contentType: "daily-analysis",
    schedulePreset: "daily-0800-utc",
    enabled: true,
    runOnce: true,
    status: "running",
    nextRunAt: "2026-07-17T12:00:00.000Z",
    leaseUntil: "2026-07-17T12:06:00.000Z",
    targets: [{ id: "target", chatId: "-1001", threadId: 10 }]
  };
  const saved = [];
  const repository = {
    async cleanupExpired() {},
    async getMeta() { return { completedAt: "2026-07-01T00:00:00.000Z" }; },
    async claimDueAutomationRules() { return [rule]; },
    async listRules() { return []; },
    async saveRule(value) { saved.push(value); return value; }
  };

  const result = await runDueDistributionJobs(new Date("2026-07-17T12:02:00.000Z"), {
    repository,
    runner: async () => { throw new Error("temporary timeout"); }
  });

  assert.equal(result.results[0].status, "failed");
  assert.equal(saved[0].enabled, true);
  assert.equal(saved[0].status, "retrying");
  assert.equal(saved[0].nextRunAt, "2026-07-17T12:07:00.000Z");
  assert.equal(saved[0].leaseUntil, null);
});

test("a confirmed manual automation run bypasses the scheduled slot dedupe and creates real delivery records", async () => {
  const target = { id: "target-market", chatId: "-100200", threadId: 8 };
  const rule = {
    id: "rule-events",
    kind: "automation",
    name: "Daily Events",
    contentType: "daily-events",
    targets: [target]
  };
  const events = [];
  const deliveries = [];
  const repository = {
    async getRule(id) { return id === rule.id ? rule : null; },
    async listRules() { return []; },
    async createEvent(event) {
      const saved = { id: "event-1", createdAt: "2026-07-15T03:00:00.000Z", ...event };
      events.push(saved);
      return saved;
    },
    async updateEvent(id, patch) {
      Object.assign(events.find((event) => event.id === id), patch);
    },
    async createDelivery(delivery) {
      const saved = { id: "delivery-1", ...delivery };
      deliveries.push(saved);
      return saved;
    },
    async updateDelivery(id, patch) {
      return Object.assign(deliveries.find((delivery) => delivery.id === id), patch);
    },
    async saveMapping() {}
  };
  const runner = async (jobId, options) => {
    assert.equal(jobId, "weekly-calendar");
    assert.equal(options.dryRun, false);
    assert.equal(options.force, true);
    assert.deepEqual(options.targets, [target]);
    return {
      status: "success",
      preview: { targetResults: [{ target, status: "success", messageId: 321 }] }
    };
  };

  const result = await runDistributionAutomationRule(rule.id, {
    repository,
    runner,
    now: new Date("2026-07-15T03:00:00.000Z")
  });

  assert.equal(result.status, "success");
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "automation");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, "success");
  assert.equal(deliveries[0].targetMessageId, 321);
});

test("market automation jobs receive the repository and persist non-publishable preview telemetry without deliveries", async () => {
  const target = { id: "target-market-preview", chatId: "-100200", threadId: 8 };
  const cases = [
    { contentType: "crypto-daily", jobId: "crypto-daily", status: "skipped", skipReason: "insufficient-sources" },
    { contentType: "weekly-calendar", jobId: "weekly-calendar", status: "duplicate", skipReason: "already-published" },
    { contentType: "data-release-updates", jobId: "data-release-updates", status: "skipped", skipReason: "actual-not-available" }
  ];

  for (const scenario of cases) {
    const rule = {
      id: `rule-${scenario.contentType}`,
      kind: "automation",
      name: scenario.contentType,
      contentType: scenario.contentType,
      targets: [target]
    };
    const events = [];
    const deliveries = [];
    const repository = {
      async getRule(id) { return id === rule.id ? rule : null; },
      async listRules() { return []; },
      async createEvent(event) {
        const saved = { id: `event-${scenario.contentType}`, ...event };
        events.push(saved);
        return saved;
      },
      async updateEvent(id, patch) {
        Object.assign(events.find((event) => event.id === id), patch);
      },
      async createDelivery(delivery) {
        deliveries.push(delivery);
        return delivery;
      }
    };
    const preview = {
      templateId: scenario.contentType,
      templateVersion: "market-content-v2",
      sources: [{ name: "official-source", url: "https://example.test/source" }],
      warnings: ["sample warning"],
      deduplicationKey: `${scenario.contentType}:2026-08-19`,
      skipReason: scenario.skipReason,
      deliveryPlans: [{ target, steps: [] }]
    };

    const result = await runDistributionAutomationRule(rule.id, {
      repository,
      now: new Date("2026-08-19T10:40:37.000Z"),
      runner: async (jobId, options) => {
        assert.equal(jobId, scenario.jobId);
        assert.equal(options.repository, repository);
        return { status: scenario.status, preview };
      }
    });

    assert.equal(result.status, scenario.status);
    assert.equal(deliveries.length, 0);
    assert.match(events[0].payload.generation, /^[a-f0-9]{24}$/);
    assert.deepEqual(events[0].payload, {
      jobId: scenario.jobId,
      slotAt: "2026-08-19T10:40:37.000Z",
      trigger: "manual",
      generation: events[0].payload.generation,
      templateId: scenario.contentType,
      templateVersion: "market-content-v2",
      sources: preview.sources,
      warnings: preview.warnings,
      deduplicationKey: preview.deduplicationKey,
      skipReason: scenario.skipReason,
      preview,
      deliveryPlans: preview.deliveryPlans,
      outcome: scenario.status
    });
  }
});

test("non-publishable automation results never create deliveries when telemetry persistence fails", async () => {
  for (const status of ["skipped", "duplicate"]) {
    const rule = {
      id: `rule-${status}-telemetry-failure`,
      kind: "automation",
      name: `${status} telemetry failure`,
      contentType: "crypto-daily",
      enabled: true,
      status: "running",
      schedulePreset: "event-driven",
      nextRunAt: "2026-08-19T10:40:00.000Z",
      targets: [{ id: `target-${status}`, chatId: "-100200", threadId: 8 }]
    };
    const deliveries = [];
    const savedRules = [];
    const repository = {
      async cleanupExpired() {},
      async getMeta() { return { completedAt: "2026-08-01T00:00:00.000Z" }; },
      async claimDueAutomationRules() { return [rule]; },
      async listRules() { return []; },
      async createEvent(event) { return { id: `event-${status}`, ...event }; },
      async updateEvent() { throw new Error("EVENT_TELEMETRY_WRITE_FAILED"); },
      async createDelivery(delivery) {
        deliveries.push(delivery);
        return { id: `delivery-${deliveries.length}`, ...delivery };
      },
      async updateDelivery() {},
      async saveRule(saved) {
        savedRules.push(saved);
        return saved;
      }
    };

    const execution = await runDueDistributionJobs(new Date("2026-08-19T10:40:37.000Z"), {
      repository,
      runner: async () => ({
        status,
        preview: {
          templateId: "crypto-daily",
          skipReason: status === "skipped" ? "insufficient-sources" : "already-published",
          targetResults: []
        }
      })
    });
    const result = execution.results[0];

    assert.equal(result.status, status);
    assert.equal(result.telemetryPersisted, false);
    assert.equal(result.telemetryError, "EVENT_TELEMETRY_WRITE_FAILED");
    assert.equal(deliveries.length, 0);
    assert.equal(savedRules[0].status, "ready");
    assert.equal(savedRules[0].nextRunAt, "2026-08-19T10:41:00.000Z");
  }
});

test("a successful automation run without target receipts fails closed instead of inventing delivery success", async () => {
  const target = { id: "target-missing-receipt", chatId: "-100200", threadId: 8 };
  const rule = {
    id: "rule-missing-receipt",
    kind: "automation",
    name: "Missing receipt",
    contentType: "crypto-daily",
    targets: [target]
  };
  const deliveries = [];
  let updatedEvent = null;
  const repository = {
    async getRule(id) { return id === rule.id ? rule : null; },
    async listRules() { return []; },
    async createEvent(event) { return { id: "event-missing-receipt", ...event }; },
    async updateEvent(id, patch) { updatedEvent = { id, ...patch }; },
    async createDelivery(delivery) {
      const saved = { id: `delivery-${deliveries.length + 1}`, ...delivery };
      deliveries.push(saved);
      return saved;
    },
    async updateDelivery(id, patch) {
      Object.assign(deliveries.find((delivery) => delivery.id === id), patch);
    },
    async saveMapping() {}
  };

  const result = await runDistributionAutomationRule(rule.id, {
    repository,
    runner: async () => ({
      status: "success",
      preview: { targetResults: [] }
    })
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error, "AUTOMATION_TARGET_RESULT_MISSING");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, "failed");
  assert.equal(deliveries[0].targetMessageId, null);
  assert.equal(deliveries[0].deliveredAt, null);
  assert.equal(deliveries[0].error, "AUTOMATION_TARGET_RESULT_MISSING");
  assert.equal(updatedEvent.payload.outcome, "failed");
  assert.equal(updatedEvent.payload.outcomeError, "AUTOMATION_TARGET_RESULT_MISSING");
});

test("complete mixed target receipts aggregate to partial and keep a one-time rule retryable", async () => {
  const targets = [
    { id: "target-mixed-success", chatId: "-100200", threadId: 8 },
    { id: "target-mixed-failed", chatId: "-100201", threadId: 8 }
  ];
  const rule = {
    id: "rule-mixed-receipts",
    kind: "automation",
    name: "Mixed receipts",
    contentType: "crypto-daily",
    enabled: true,
    runOnce: true,
    status: "running",
    schedulePreset: "daily-1100",
    nextRunAt: "2026-08-19T10:40:00.000Z",
    targets
  };
  const events = [];
  const deliveries = [];
  const savedRules = [];
  const repository = {
    async cleanupExpired() {},
    async getMeta() { return { completedAt: "2026-08-01T00:00:00.000Z" }; },
    async claimDueAutomationRules() { return [rule]; },
    async listRules() { return []; },
    async createEvent(event) { const saved = { id: "event-mixed", ...event }; events.push(saved); return saved; },
    async updateEvent(id, patch) { Object.assign(events.find((event) => event.id === id), patch); },
    async createDelivery(delivery) { const saved = { id: `delivery-${deliveries.length + 1}`, ...delivery }; deliveries.push(saved); return saved; },
    async updateDelivery(id, patch) { Object.assign(deliveries.find((delivery) => delivery.id === id), patch); },
    async saveMapping() {},
    async saveRule(saved) { savedRules.push(saved); return saved; }
  };

  const execution = await runDueDistributionJobs(new Date("2026-08-19T10:40:37.000Z"), {
    repository,
    runner: async () => ({
      status: "success",
      preview: { targetResults: [
        { target: targets[0], status: "success", messageId: 801 },
        { target: targets[1], status: "failed", error: "TELEGRAM_REJECTED" }
      ] }
    })
  });

  assert.equal(execution.results[0].status, "partial");
  assert.equal(events[0].payload.outcome, "partial");
  assert.deepEqual(deliveries.map((delivery) => delivery.status), ["success", "failed"]);
  assert.equal(deliveries[0].targetMessageId, 801);
  assert.equal(deliveries[1].error, "TELEGRAM_REJECTED");
  assert.equal(savedRules[0].enabled, true);
  assert.equal(savedRules[0].status, "retrying");
  assert.equal(savedRules[0].nextRunAt, "2026-08-19T10:45:37.000Z");
});

test("a one-time partial retry sends only targets without a durable success receipt", async () => {
  const targets = [
    { id: "target-retry-a", chatId: "-100200", threadId: 8 },
    { id: "target-retry-b", chatId: "-100201", threadId: 8 }
  ];
  let rule = {
    id: "rule-targeted-retry",
    kind: "automation",
    contentType: "crypto-daily",
    enabled: true,
    runOnce: true,
    status: "ready",
    schedulePreset: "daily-1100",
    nextRunAt: "2026-08-19T10:40:00.000Z",
    targets
  };
  const meta = new Map();
  const events = [];
  const deliveries = [];
  const runnerTargetIds = [];
  const repository = {
    async cleanupExpired() {},
    async getMeta(key) { return structuredClone(meta.get(key) ?? (key === "legacy-migration-v1" ? { completedAt: "2026-08-01T00:00:00.000Z" } : null)); },
    async setMeta(key, value) { meta.set(key, structuredClone(value)); return value; },
    async claimDueAutomationRules(now) {
      if (!rule.enabled || Date.parse(rule.nextRunAt) > now.getTime()) return [];
      rule = { ...rule, status: "running" };
      return [structuredClone(rule)];
    },
    async listRules() { return []; },
    async listDeliveries() { return structuredClone(deliveries); },
    async createEvent(event) { const saved = { id: `event-${events.length + 1}`, ...event }; events.push(saved); return saved; },
    async updateEvent(id, patch) { Object.assign(events.find((event) => event.id === id), structuredClone(patch)); },
    async createDelivery(delivery) { const saved = { id: `delivery-${deliveries.length + 1}`, ...structuredClone(delivery) }; deliveries.push(saved); return saved; },
    async updateDelivery(id, patch) { return Object.assign(deliveries.find((delivery) => delivery.id === id), structuredClone(patch)); },
    async saveMapping() {},
    async saveRule(saved) { rule = structuredClone(saved); return saved; }
  };
  let run = 0;
  const runner = async (_jobId, options) => {
    run += 1;
    runnerTargetIds.push(options.targets.map((target) => target.id));
    if (run === 1) {
      return { status: "success", preview: { targetResults: [
        { target: targets[0], status: "success", messageId: 1001 },
        { target: targets[1], status: "failed", error: "TEMPORARY_FAILURE" }
      ] } };
    }
    return { status: "success", preview: { targetResults: [
      { target: targets[1], status: "success", messageId: 1002 }
    ] } };
  };

  const first = await runDueDistributionJobs(new Date("2026-08-19T10:40:37.000Z"), { repository, runner });
  const second = await runDueDistributionJobs(new Date("2026-08-19T10:45:37.000Z"), { repository, runner });

  assert.equal(first.results[0].status, "partial");
  assert.equal(second.results[0].status, "success");
  assert.deepEqual(runnerTargetIds, [["target-retry-a", "target-retry-b"], ["target-retry-b"]]);
  assert.equal(deliveries.filter((delivery) => delivery.targetId === "target-retry-a").length, 1);
  assert.equal(rule.enabled, false);
  assert.equal(rule.status, "completed");
});

test("a mixed external result survives delivery persistence failure and retries only the unsent target", async () => {
  const targets = [
    { id: "target-store-a", chatId: "-100210", threadId: 8 },
    { id: "target-store-b", chatId: "-100211", threadId: 8 }
  ];
  let rule = {
    id: "rule-store-targeted-retry", kind: "automation", contentType: "crypto-daily",
    enabled: true, runOnce: true, status: "ready", schedulePreset: "daily-1100",
    nextRunAt: "2026-08-19T10:40:00.000Z", targets
  };
  const meta = new Map();
  const events = [];
  const deliveries = [];
  const runnerTargetIds = [];
  let createAttempts = 0;
  const repository = {
    async cleanupExpired() {},
    async getMeta(key) { return structuredClone(meta.get(key) ?? (key === "legacy-migration-v1" ? { completedAt: "2026-08-01T00:00:00.000Z" } : null)); },
    async setMeta(key, value) { meta.set(key, structuredClone(value)); return value; },
    async claimDueAutomationRules(now) { if (!rule.enabled || Date.parse(rule.nextRunAt) > now.getTime()) return []; rule = { ...rule, status: "running" }; return [structuredClone(rule)]; },
    async listRules() { return []; }, async listDeliveries() { return structuredClone(deliveries); },
    async createEvent(event) { const saved = { id: `event-store-${events.length + 1}`, ...event }; events.push(saved); return saved; },
    async updateEvent(id, patch) { Object.assign(events.find((event) => event.id === id), structuredClone(patch)); },
    async createDelivery(delivery) {
      createAttempts += 1;
      if (createAttempts === 1) throw new Error("DELIVERY_STORE_UNAVAILABLE");
      const saved = { id: `delivery-store-${deliveries.length + 1}`, ...structuredClone(delivery) };
      deliveries.push(saved);
      return saved;
    },
    async updateDelivery(id, patch) { return Object.assign(deliveries.find((delivery) => delivery.id === id), structuredClone(patch)); },
    async saveMapping() {}, async saveRule(saved) { rule = structuredClone(saved); return saved; }
  };
  let run = 0;
  const runner = async (_jobId, options) => {
    run += 1;
    runnerTargetIds.push(options.targets.map((target) => target.id));
    return run === 1
      ? { status: "success", preview: { targetResults: [
        { target: targets[0], status: "success", messageId: 1101 },
        { target: targets[1], status: "failed", error: "TEMPORARY_FAILURE" }
      ] } }
      : { status: "success", preview: { targetResults: [{ target: targets[1], status: "success", messageId: 1102 }] } };
  };

  const first = await runDueDistributionJobs(new Date("2026-08-19T10:40:37.000Z"), { repository, runner });
  const second = await runDueDistributionJobs(new Date("2026-08-19T10:45:37.000Z"), { repository, runner });

  assert.equal(first.results[0].status, "partial");
  assert.equal(first.results[0].deliveryPersisted, false);
  assert.equal(second.results[0].status, "success");
  assert.deepEqual(runnerTargetIds, [["target-store-a", "target-store-b"], ["target-store-b"]]);
  assert.equal(events[0].payload.targetReceipts["-100210:8"].messageId, 1101);
  assert.equal(rule.status, "completed");
});

test("a partial target receipt set aggregates success plus a missing receipt to partial", async () => {
  const targets = [
    { id: "target-partial-present", chatId: "-100200", threadId: 8 },
    { id: "target-partial-missing", chatId: "-100201", threadId: 8 }
  ];
  const rule = { id: "rule-partial-missing", kind: "automation", contentType: "crypto-daily", targets };
  const deliveries = [];
  let outcome = null;
  const repository = {
    async getRule() { return rule; }, async listRules() { return []; },
    async createEvent(event) { return { id: "event-partial-missing", ...event }; },
    async updateEvent(_id, patch) { outcome = patch.payload.outcome; },
    async createDelivery(delivery) { const saved = { id: `delivery-${deliveries.length + 1}`, ...delivery }; deliveries.push(saved); return saved; },
    async updateDelivery(id, patch) { Object.assign(deliveries.find((delivery) => delivery.id === id), patch); },
    async saveMapping() {}
  };

  const result = await runDistributionAutomationRule(rule.id, {
    repository,
    runner: async () => ({ status: "success", preview: { targetResults: [
      { target: targets[0], status: "success", messageId: 811 }
    ] } })
  });

  assert.equal(result.status, "partial");
  assert.equal(outcome, "partial");
  assert.deepEqual(deliveries.map((delivery) => delivery.status), ["success", "failed"]);
  assert.equal(deliveries[1].error, "AUTOMATION_TARGET_RESULT_MISSING");
});

test("telemetry failure after reliable external receipts preserves delivery success and completes a one-time rule", async () => {
  const target = { id: "target-telemetry-after-send", chatId: "-100200", threadId: 8 };
  const rule = {
    id: "rule-telemetry-after-send",
    kind: "automation",
    contentType: "crypto-daily",
    enabled: true,
    runOnce: true,
    status: "running",
    schedulePreset: "daily-1100",
    targets: [target]
  };
  const deliveries = [];
  const savedRules = [];
  let runnerCalls = 0;
  const repository = {
    async cleanupExpired() {},
    async getMeta() { return { completedAt: "2026-08-01T00:00:00.000Z" }; },
    async claimDueAutomationRules() { return [rule]; },
    async listRules() { return []; },
    async createEvent(event) { return { id: "event-telemetry-after-send", ...event }; },
    async updateEvent() {
      assert.equal(deliveries[0]?.status, "success");
      assert.equal(deliveries[0]?.targetMessageId, 901);
      throw new Error("EVENT_TELEMETRY_WRITE_FAILED");
    },
    async createDelivery(delivery) { const saved = { id: "delivery-telemetry-after-send", ...delivery }; deliveries.push(saved); return saved; },
    async updateDelivery(id, patch) { Object.assign(deliveries.find((delivery) => delivery.id === id), patch); },
    async saveMapping() {},
    async saveRule(saved) { savedRules.push(saved); return saved; }
  };

  const execution = await runDueDistributionJobs(new Date("2026-08-19T10:40:37.000Z"), {
    repository,
    runner: async () => {
      runnerCalls += 1;
      return { status: "success", preview: { targetResults: [
        { target, status: "success", messageId: 901, messageIds: [901, 902] }
      ] } };
    }
  });
  const result = execution.results[0];

  assert.equal(runnerCalls, 1);
  assert.equal(result.status, "success");
  assert.equal(result.telemetryPersisted, false);
  assert.equal(result.telemetryError, "EVENT_TELEMETRY_WRITE_FAILED");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, "success");
  assert.equal(deliveries[0].targetMessageId, 901);
  assert.deepEqual(deliveries[0].targetMessageIds, [901, 902]);
  assert.ok(deliveries[0].deliveredAt);
  assert.equal(savedRules[0].enabled, false);
  assert.equal(savedRules[0].status, "completed");
  assert.equal(savedRules[0].nextRunAt, null);
});

test("delivery and receipt persistence failure requires manual reconciliation even when event telemetry succeeds", async () => {
  const target = { id: "target-delivery-store-after-send", chatId: "-100200", threadId: 8 };
  const rule = {
    id: "rule-delivery-store-after-send",
    kind: "automation",
    contentType: "crypto-daily",
    enabled: true,
    runOnce: true,
    status: "running",
    schedulePreset: "daily-1100",
    targets: [target]
  };
  const events = [];
  const savedRules = [];
  let runnerCalls = 0;
  const repository = {
    async cleanupExpired() {},
    async getMeta() { return { completedAt: "2026-08-01T00:00:00.000Z" }; },
    async claimDueAutomationRules() { return [rule]; },
    async listRules() { return []; },
    async createEvent(event) { const saved = { id: "event-delivery-store-after-send", ...event }; events.push(saved); return saved; },
    async updateEvent(id, patch) { Object.assign(events.find((event) => event.id === id), patch); },
    async createDelivery() { throw new Error("DELIVERY_RECEIPT_WRITE_FAILED"); },
    async saveMapping() {},
    async saveRule(saved) { savedRules.push(saved); return saved; }
  };

  const execution = await runDueDistributionJobs(new Date("2026-08-19T10:40:37.000Z"), {
    repository,
    runner: async () => {
      runnerCalls += 1;
      return { status: "success", preview: { targetResults: [
        { target, status: "success", messageId: 911, messageIds: [911] }
      ] } };
    }
  });
  const result = execution.results[0];

  assert.equal(runnerCalls, 1);
  assert.equal(result.status, "manual-reconciliation");
  assert.equal(result.deliveryPersisted, false);
  assert.equal(result.deliveryError, "DELIVERY_RECEIPT_WRITE_FAILED");
  assert.equal(result.telemetryPersisted, true);
  assert.equal(events[0].payload.outcome, "manual-reconciliation");
  assert.equal(savedRules[0].enabled, false);
  assert.equal(savedRules[0].status, "manual-reconciliation");
  assert.equal(savedRules[0].nextRunAt, null);
});

test("a stale manual invocation cannot resend after delivery and receipt persistence both fail", async () => {
  const target = { id: "stale-manual-target", chatId: "-100209", threadId: 8 };
  const staleRule = {
    id: "stale-manual-rule", kind: "automation", contentType: "crypto-daily", enabled: true,
    runOnce: true, status: "ready", schedulePreset: "daily-1100", targets: [target]
  };
  const harness = createAutomationReviewRepository(staleRule, { failMetaAfterRunner: true, failDeliveries: true });
  let runnerCalls = 0;
  const runner = async () => {
    runnerCalls += 1;
    harness.markRunnerStarted();
    return { status: "success", preview: { targetResults: [{ target, status: "success", messageId: 919 }] } };
  };

  const first = await runDistributionAutomationRule(staleRule.id, { repository: harness.repository, runner });
  const staleRepositoryView = {
    ...harness.repository,
    async claimDueAutomationRules() { return [structuredClone(staleRule)]; }
  };
  const second = await runDistributionAutomationRule(staleRule.id, { repository: staleRepositoryView, runner });

  assert.equal(first.status, "manual-reconciliation");
  assert.equal(second.status, "manual-reconciliation");
  assert.equal(harness.rule().status, "manual-reconciliation");
  assert.equal(harness.rule().enabled, false);
  assert.equal(runnerCalls, 1);
});

test("four failed persistence fences trip a repository-scoped circuit before a fresh manual generation can resend", async () => {
  const target = { id: "hard-persistence-target", chatId: "-100219", threadId: 8 };
  const rule = {
    id: "hard-persistence-rule", kind: "automation", contentType: "crypto-daily", enabled: true,
    runOnce: true, status: "ready", schedulePreset: "daily-1100", targets: [target]
  };
  const failures = {
    failMetaAfterRunner: true,
    failManualExecutionStateAfterRunner: true,
    failDeliveries: true,
    failRuleSavesAfterRunner: true
  };
  const harness = createAutomationReviewRepository(rule, failures);
  let runnerCalls = 0;
  const runner = async () => {
    runnerCalls += 1;
    harness.markRunnerStarted();
    return { status: "success", preview: { targetResults: [
      { target, status: "success", messageId: 929 }
    ] } };
  };

  // These are separate facades over the same backing store. A process safety
  // fence must not be bypassed just because request wiring creates a new object.
  const firstFacade = { ...harness.repository };
  const secondFacade = { ...harness.repository };
  const first = await runDistributionAutomationRule(rule.id, {
    repository: firstFacade, runner, now: new Date("2026-08-19T10:40:01.000Z")
  });
  const blocked = await runDistributionAutomationRule(rule.id, {
    repository: secondFacade, runner, now: new Date("2026-08-19T10:41:01.000Z")
  });

  assert.equal(first.status, "manual-reconciliation-unpersisted");
  assert.equal(first.error, "AUTOMATION_RECONCILIATION_PERSISTENCE_UNAVAILABLE");
  assert.equal(runnerCalls, 1);
  assert.equal(first.ruleReconciliationPersisted, false);
  assert.equal(first.rulePersistenceError, "RULE_STORE_UNAVAILABLE");
  assert.equal(first.executionStateError, "EXECUTION_STATE_STORE_UNAVAILABLE");
  assert.equal(first.telemetryPersisted, true);
  assert.equal(blocked.status, "manual-reconciliation-unpersisted");
  assert.equal(blocked.error, "AUTOMATION_RECONCILIATION_PERSISTENCE_UNAVAILABLE");
  assert.equal(blocked.circuitBreakerOpen, true);
  assert.equal(blocked.circuitRequiresRestart, true);
  assert.equal(blocked.ruleReconciliationPersisted, false);

  failures.failMetaAfterRunner = false;
  failures.failManualExecutionStateAfterRunner = false;
  failures.failDeliveries = false;
  failures.failRuleSavesAfterRunner = false;
  const recoveredFacade = { ...harness.repository };
  const recovered = await runDistributionAutomationRule(rule.id, {
    repository: recoveredFacade, runner, now: new Date("2026-08-19T10:42:01.000Z")
  });

  assert.equal(runnerCalls, 1);
  assert.equal(recovered.status, "manual-reconciliation-unpersisted");
  assert.equal(recovered.circuitBreakerOpen, true);
  assert.equal(recovered.circuitRequiresRestart, true);
  assert.equal(recovered.ruleReconciliationPersisted, false);
  assert.equal(harness.rule().status, "ready");
  assert.equal(harness.rule().enabled, true);
});

test("a foreign completed repository cannot clear an unscoped circuit for the same rule id", async () => {
  const rule = {
    id: "foreign-collision-rule", kind: "automation", contentType: "crypto-daily", enabled: true,
    runOnce: true, status: "ready", schedulePreset: "daily-1100",
    targets: [{ id: "foreign-collision-target", chatId: "-100230", threadId: 8 }]
  };
  const failures = {
    failMetaAfterRunner: true,
    failManualExecutionStateAfterRunner: true,
    failDeliveries: true,
    failRuleSavesAfterRunner: true
  };
  const owner = createAutomationReviewRepository(rule, failures);
  const foreign = createAutomationReviewRepository({ ...rule, enabled: false, status: "completed" });
  let runnerCalls = 0;
  const runner = async () => {
    runnerCalls += 1;
    owner.markRunnerStarted();
    return { status: "success", preview: { targetResults: [
      { target: rule.targets[0], status: "success", messageId: "953" }
    ] } };
  };

  const first = await runDistributionAutomationRule(rule.id, {
    repository: owner.repository, runner, now: new Date("2026-08-19T10:45:01.000Z")
  });
  const foreignCompleted = await runDistributionAutomationRule(rule.id, {
    repository: foreign.repository, runner, now: new Date("2026-08-19T10:45:02.000Z")
  });
  failures.failMetaAfterRunner = false;
  failures.failManualExecutionStateAfterRunner = false;
  failures.failDeliveries = false;
  failures.failRuleSavesAfterRunner = false;
  const ownerAgain = await runDistributionAutomationRule(rule.id, {
    repository: owner.repository, runner, now: new Date("2026-08-19T10:45:03.000Z")
  });

  assert.equal(first.status, "manual-reconciliation-unpersisted");
  assert.equal(foreignCompleted.status, "manual-reconciliation-unpersisted");
  assert.equal(foreignCompleted.error, "AUTOMATION_RECONCILIATION_PERSISTENCE_UNAVAILABLE");
  assert.equal(foreignCompleted.circuitRequiresRestart, true);
  assert.equal(ownerAgain.status, "manual-reconciliation-unpersisted");
  assert.equal(ownerAgain.circuitRequiresRestart, true);
  assert.equal(runnerCalls, 1);
});

test("operator reset cannot clear an unscoped fallback circuit without a process restart", async () => {
  const rule = {
    id: "fallback-reset-rule", kind: "automation", contentType: "crypto-daily", enabled: true,
    runOnce: true, status: "ready", schedulePreset: "daily-1100",
    targets: [{ id: "fallback-reset-target", chatId: "-100231", threadId: 8 }]
  };
  const failures = {
    failMetaAfterRunner: true,
    failManualExecutionStateAfterRunner: true,
    failDeliveries: true,
    failRuleSavesAfterRunner: true
  };
  const harness = createAutomationReviewRepository(rule, failures);
  let runnerCalls = 0;
  const first = await runDistributionAutomationRule(rule.id, {
    repository: harness.repository,
    now: new Date("2026-08-19T10:46:01.000Z"),
    runner: async () => {
      runnerCalls += 1;
      harness.markRunnerStarted();
      return { status: "success", preview: { targetResults: [
        { target: rule.targets[0], status: "success", messageId: "954" }
      ] } };
    }
  });

  failures.failMetaAfterRunner = false;
  failures.failManualExecutionStateAfterRunner = false;
  failures.failDeliveries = false;
  failures.failRuleSavesAfterRunner = false;
  harness.replaceRule({ ...rule, enabled: false, status: "manual-reconciliation" });
  await harness.repository.setMeta(`automation-execution-state-v1:${rule.id}`, {
    generation: first.generation,
    status: "manual-reconciliation",
    phase: "operator-required"
  });
  const reset = await resetAutomationManualReconciliation(rule.id, {
    repository: harness.repository,
    actor: "ops",
    expectedGeneration: first.generation,
    resolution: "acknowledge-sent",
    authorize: async () => true,
    now: new Date("2026-08-19T10:47:01.000Z")
  });
  const blocked = await runDistributionAutomationRule(rule.id, {
    repository: harness.repository,
    runner: async () => {
      runnerCalls += 1;
      throw new Error("must not run");
    }
  });

  assert.equal(reset.status, "completed");
  assert.equal(blocked.status, "manual-reconciliation-unpersisted");
  assert.equal(blocked.error, "AUTOMATION_RECONCILIATION_PERSISTENCE_UNAVAILABLE");
  assert.equal(blocked.circuitRequiresRestart, true);
  assert.equal(runnerCalls, 1);
});

test("explicit stable repository namespaces isolate tenants that reuse a rule id", async () => {
  const rule = {
    id: "shared-tenant-rule", kind: "automation", contentType: "crypto-daily", enabled: true,
    runOnce: true, status: "ready", schedulePreset: "daily-1100",
    targets: [{ id: "shared-tenant-target", chatId: "-100229", threadId: 8 }]
  };
  const failures = {
    failMetaAfterRunner: true,
    failManualExecutionStateAfterRunner: true,
    failDeliveries: true,
    failRuleSavesAfterRunner: true
  };
  const tenantA = createAutomationReviewRepository(rule, failures);
  const tenantB = createAutomationReviewRepository(rule);
  const repositoryA = { ...tenantA.repository, automationCircuitNamespace: "tenant-a-store" };
  const repositoryB = { ...tenantB.repository, automationCircuitNamespace: "tenant-b-store" };
  let tenantACalls = 0;
  let tenantBCalls = 0;

  const uncertain = await runDistributionAutomationRule(rule.id, {
    repository: repositoryA,
    now: new Date("2026-08-19T10:43:01.000Z"),
    runner: async () => {
      tenantACalls += 1;
      tenantA.markRunnerStarted();
      return { status: "success", preview: { targetResults: [
        { target: rule.targets[0], status: "success", messageId: "951" }
      ] } };
    }
  });
  const isolated = await runDistributionAutomationRule(rule.id, {
    repository: repositoryB,
    now: new Date("2026-08-19T10:43:02.000Z"),
    runner: async () => {
      tenantBCalls += 1;
      return { status: "success", preview: { targetResults: [
        { target: rule.targets[0], status: "success", messageId: "952" }
      ] } };
    }
  });

  assert.equal(uncertain.status, "manual-reconciliation-unpersisted");
  assert.equal(isolated.status, "success");
  assert.equal(tenantACalls, 1);
  assert.equal(tenantBCalls, 1);

  // Recover tenant A's store so its process-local entry is converted into the
  // durable manual fence and removed instead of leaking after this test.
  failures.failMetaAfterRunner = false;
  failures.failManualExecutionStateAfterRunner = false;
  failures.failDeliveries = false;
  failures.failRuleSavesAfterRunner = false;
  const recovered = await runDistributionAutomationRule(rule.id, {
    repository: repositoryA,
    now: new Date("2026-08-19T10:44:01.000Z"),
    runner: async () => { tenantACalls += 1; }
  });
  assert.equal(recovered.status, "manual-reconciliation");
  assert.equal(recovered.circuitRequiresRestart, undefined);
  assert.equal(tenantACalls, 1);
});

test("a scheduled rule save failure is reported without interrupting later claimed rules", async () => {
  const rules = [1, 2].map((index) => ({
    id: `scheduler-save-rule-${index}`, kind: "automation", contentType: "crypto-daily",
    enabled: true, runOnce: true, status: "ready", schedulePreset: "daily-1100",
    targets: [{ id: `scheduler-save-target-${index}`, chatId: `-10022${index}`, threadId: 8 }]
  }));
  let runnerCalls = 0;
  const deliveries = [];
  const repository = {
    async cleanupExpired() {},
    async getRule(id) { return structuredClone(rules.find((rule) => rule.id === id)); },
    async getMeta(key) { return key === "legacy-migration-v1" ? { completedAt: "2026-08-01T00:00:00.000Z" } : null; },
    async claimDueAutomationRules() { return structuredClone(rules); },
    async listRules() { return []; },
    async createEvent(event) { return { id: `scheduler-save-event-${event.ruleId}`, ...event }; },
    async updateEvent() {},
    async createDelivery(delivery) {
      const saved = { id: `scheduler-save-delivery-${deliveries.length + 1}`, ...structuredClone(delivery) };
      deliveries.push(saved);
      return saved;
    },
    async updateDelivery(id, patch) { Object.assign(deliveries.find((delivery) => delivery.id === id), patch); },
    async saveMapping() {},
    async saveRule(saved) {
      if (saved.id === rules[0].id) throw new Error("FIRST_RULE_SAVE_FAILED");
      return saved;
    }
  };

  const execution = await runDueDistributionJobs(new Date("2026-08-19T10:40:37.000Z"), {
    repository,
    limit: 2,
    runner: async (_jobId, input) => {
      runnerCalls += 1;
      return { status: "success", preview: { targetResults: input.targets.map((target, index) => ({
        target, status: "success", messageId: String(940 + runnerCalls + index)
      })) } };
    }
  });

  assert.equal(execution.claimed, 2);
  assert.equal(execution.results.length, 2);
  assert.equal(runnerCalls, 2);
  assert.equal(execution.results[0].status, "success");
  assert.equal(execution.results[0].rulePersistenceError, "FIRST_RULE_SAVE_FAILED");
  assert.equal(execution.results[1].status, "success");
});

test("missing empty and invalid runner statuses fail closed and schedule a retry", async () => {
  for (const status of [undefined, "", "not-a-status"]) {
    const suffix = status || "missing";
    const target = { id: `target-invalid-${suffix}`, chatId: "-100200", threadId: 8 };
    const rule = {
      id: `rule-invalid-${suffix}`,
      kind: "automation",
      contentType: "crypto-daily",
      enabled: true,
      runOnce: true,
      status: "running",
      schedulePreset: "daily-1100",
      targets: [target]
    };
    const events = [];
    const deliveries = [];
    const savedRules = [];
    const repository = {
      async cleanupExpired() {}, async getMeta() { return { completedAt: "2026-08-01T00:00:00.000Z" }; },
      async claimDueAutomationRules() { return [rule]; }, async listRules() { return []; },
      async createEvent(event) { const saved = { id: `event-${suffix}`, ...event }; events.push(saved); return saved; },
      async updateEvent(id, patch) { Object.assign(events.find((event) => event.id === id), patch); },
      async createDelivery(delivery) { const saved = { id: `delivery-${suffix}`, ...delivery }; deliveries.push(saved); return saved; },
      async updateDelivery(id, patch) { Object.assign(deliveries.find((delivery) => delivery.id === id), patch); },
      async saveMapping() {}, async saveRule(saved) { savedRules.push(saved); return saved; }
    };

    const execution = await runDueDistributionJobs(new Date("2026-08-19T10:40:37.000Z"), {
      repository,
      runner: async () => ({ status, preview: { targetResults: [] } })
    });

    assert.equal(execution.results[0].status, "failed");
    assert.equal(execution.results[0].error, "AUTOMATION_RUN_STATUS_INVALID");
    assert.equal(events[0].payload.outcome, "failed");
    assert.equal(events[0].payload.outcomeError, "AUTOMATION_RUN_STATUS_INVALID");
    assert.equal(deliveries[0].status, "failed");
    assert.equal(savedRules[0].status, "retrying");
    assert.equal(savedRules[0].nextRunAt, "2026-08-19T10:45:37.000Z");
  }
});

test("success target receipts without a valid message id fail closed", async () => {
  const invalidReceipts = [
    { messageId: null },
    { messageId: undefined },
    { messageId: 0 },
    { messageId: -1 },
    { messageId: 1.5 },
    { messageId: Number.NaN },
    { messageId: Number.MAX_SAFE_INTEGER + 1 },
    { messageId: "" },
    { messageId: "abc" },
    { messageId: "-1" },
    { messageId: "1.5" },
    { messageIds: [] },
    { messageIds: [""] },
    { messageIds: [null] }
  ];
  for (const [index, receipt] of invalidReceipts.entries()) {
    const target = { id: `target-invalid-receipt-${index}`, chatId: `-10030${index}`, threadId: 8 };
    const rule = { id: `rule-invalid-receipt-${index}`, kind: "automation", contentType: "crypto-daily", targets: [target] };
    const deliveries = [];
    let eventPayload = null;
    const repository = {
      async getRule() { return rule; }, async listRules() { return []; },
      async createEvent(event) { return { id: `event-invalid-receipt-${index}`, ...event }; },
      async updateEvent(_id, patch) { eventPayload = patch.payload; },
      async createDelivery(delivery) { const saved = { id: `delivery-invalid-receipt-${index}`, ...delivery }; deliveries.push(saved); return saved; },
      async updateDelivery(id, patch) { return Object.assign(deliveries.find((delivery) => delivery.id === id), patch); },
      async saveMapping() {}
    };

    const result = await runDistributionAutomationRule(rule.id, {
      repository,
      runner: async () => ({ status: "success", preview: { targetResults: [
        { target, status: "success", ...receipt }
      ] } })
    });

    assert.equal(result.status, "failed", `invalid receipt ${index}`);
    assert.equal(result.error, "AUTOMATION_SUCCESS_RECEIPT_INVALID", `invalid receipt ${index}`);
    assert.equal(deliveries[0].status, "failed", `invalid receipt ${index}`);
    assert.equal(deliveries[0].targetMessageId, null, `invalid receipt ${index}`);
    assert.equal(eventPayload.outcome, "failed", `invalid receipt ${index}`);
  }
});

test("Discord snowflake message ids remain exact decimal strings through delivery persistence", async () => {
  const target = { id: "discord-snowflake", platform: "discord", guildId: "987654321098765432", channelId: "123456789012345678" };
  const snowflake = "18446744073709551615";
  const deliveries = [];
  const repository = {
    async getRule() { return { id: "snowflake-rule", kind: "automation", contentType: "crypto-daily", targets: [target] }; },
    async getMeta() { return null; }, async createEvent(event) { return { id: "snowflake-event", ...event }; },
    async updateEvent() {}, async saveMapping() {},
    async createDelivery(value) { const saved = { id: "snowflake-delivery", ...value }; deliveries.push(saved); return saved; },
    async updateDelivery(id, patch) { Object.assign(deliveries.find((row) => row.id === id), patch); }
  };
  const result = await runDistributionAutomationRule("snowflake-rule", {
    repository,
    runner: async () => ({ status: "success", preview: { targetResults: [
      { target, status: "success", messageId: `000${snowflake}` }
    ] } })
  });

  assert.equal(result.status, "success");
  assert.equal(deliveries[0].targetMessageId, snowflake);
  assert.deepEqual(deliveries[0].targetMessageIds, [snowflake]);
});

test("an invalid runner envelope with reliable receipts completes without automatic resend", async () => {
  const target = { id: "target-invalid-envelope-sent", chatId: "-100400", threadId: 8 };
  const rule = {
    id: "rule-invalid-envelope-sent", kind: "automation", contentType: "crypto-daily",
    enabled: true, runOnce: true, status: "running", schedulePreset: "daily-1100", targets: [target]
  };
  const events = [];
  const deliveries = [];
  const savedRules = [];
  const meta = new Map();
  let runnerCalls = 0;
  const repository = {
    async cleanupExpired() {},
    async getMeta(key) { return structuredClone(meta.get(key) ?? (key === "legacy-migration-v1" ? { completedAt: "2026-08-01T00:00:00.000Z" } : null)); },
    async setMeta(key, value) { meta.set(key, structuredClone(value)); return value; },
    async claimDueAutomationRules() { return [rule]; }, async listRules() { return []; }, async listDeliveries() { return structuredClone(deliveries); },
    async createEvent(event) { const saved = { id: "event-invalid-envelope-sent", ...event }; events.push(saved); return saved; },
    async updateEvent(id, patch) { Object.assign(events.find((event) => event.id === id), structuredClone(patch)); },
    async createDelivery(delivery) { const saved = { id: "delivery-invalid-envelope-sent", ...delivery }; deliveries.push(saved); return saved; },
    async updateDelivery(id, patch) { return Object.assign(deliveries.find((delivery) => delivery.id === id), patch); },
    async saveMapping() {}, async saveRule(saved) { savedRules.push(saved); return saved; }
  };

  const execution = await runDueDistributionJobs(new Date("2026-08-19T10:40:37.000Z"), {
    repository,
    runner: async () => {
      runnerCalls += 1;
      return { status: "bogus", preview: { targetResults: [{ target, status: "success", messageId: 1201 }] } };
    }
  });

  assert.equal(runnerCalls, 1);
  assert.equal(execution.results[0].status, "success");
  assert.equal(execution.results[0].diagnostic, "AUTOMATION_RUN_STATUS_INVALID");
  assert.equal(deliveries[0].status, "success");
  assert.equal(events[0].payload.outcome, "success");
  assert.equal(events[0].payload.outcomeDiagnostic, "AUTOMATION_RUN_STATUS_INVALID");
  assert.equal(savedRules[0].enabled, false);
  assert.equal(savedRules[0].status, "completed");
  assert.equal(savedRules[0].nextRunAt, null);
});

function createAutomationReviewRepository(initialRule, options = {}) {
  let rule = structuredClone(initialRule);
  const meta = new Map();
  const leases = new Map();
  const events = [];
  const deliveries = [];
  let runnerStarted = false;
  const repository = {
    async cleanupExpired() {},
    async getRule() { return structuredClone(rule); },
    async getMeta(key) {
      if (key === "legacy-migration-v1") return { completedAt: "2026-08-01T00:00:00.000Z" };
      return structuredClone(meta.get(key) ?? null);
    },
    async setMeta(key, value) {
      if (runnerStarted && options.failMetaAfterRunner) throw new Error("META_STORE_UNAVAILABLE");
      meta.set(key, structuredClone(value));
      return value;
    },
    async compareAndSetMeta(key, expected, value) {
      if (runnerStarted && options.failManualExecutionStateAfterRunner
        && value?.status === "manual-reconciliation") {
        throw new Error("EXECUTION_STATE_STORE_UNAVAILABLE");
      }
      const current = meta.get(key) ?? null;
      if (expected?.absent === true && current !== null) return null;
      for (const [field, expectedValue] of Object.entries(expected ?? {})) {
        if (field === "absent") continue;
        if (current?.[field] !== expectedValue) return null;
      }
      meta.set(key, structuredClone(value));
      return structuredClone(value);
    },
    async deleteMeta(key) { return meta.delete(key); },
    async listMetaByPrefix(prefix) {
      return [...meta.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) }));
    },
    async acquireMetaLease(key, lease, now = new Date()) {
      const current = leases.get(key);
      const currentLeaseUntil = options.leaseTtlMs ? current?.testLeaseUntil : Date.parse(current?.leaseUntil ?? "");
      const clock = options.leaseTtlMs ? Date.now() : new Date(now).getTime();
      if (current && currentLeaseUntil > clock) return null;
      const saved = options.leaseTtlMs ? { ...lease, testLeaseUntil: Date.now() + options.leaseTtlMs } : lease;
      leases.set(key, structuredClone(saved));
      return structuredClone(saved);
    },
    async renewMetaLease(key, leaseId, leaseUntil) {
      const current = leases.get(key);
      if (current?.leaseId !== leaseId) return null;
      const renewed = {
        ...current,
        leaseUntil,
        ...(options.leaseTtlMs ? { testLeaseUntil: Date.now() + options.leaseTtlMs } : {})
      };
      leases.set(key, renewed);
      return structuredClone(renewed);
    },
    async releaseMetaLease(key, leaseId) {
      if (leases.get(key)?.leaseId !== leaseId) return false;
      leases.delete(key);
      return true;
    },
    async claimDueAutomationRules(now) {
      if (!rule.enabled || (rule.nextRunAt && Date.parse(rule.nextRunAt) > now.getTime())) return [];
      return [structuredClone(rule)];
    },
    async listRules() { return []; },
    async listDeliveries() {
      if (options.rejectUnscopedDeliveries) throw new Error("UNSCOPED_DELIVERY_QUERY_FORBIDDEN");
      return structuredClone(deliveries);
    },
    async createEvent(event) {
      const saved = { id: `review-event-${events.length + 1}`, ...structuredClone(event) };
      events.push(saved);
      return saved;
    },
    async updateEvent(id, patch) { Object.assign(events.find((event) => event.id === id), structuredClone(patch)); },
    async createDelivery(delivery) {
      if (options.failDeliveries) throw new Error("DELIVERY_STORE_UNAVAILABLE");
      const saved = { id: `review-delivery-${deliveries.length + 1}`, ...structuredClone(delivery) };
      deliveries.push(saved);
      return saved;
    },
    async updateDelivery(id, patch) { return Object.assign(deliveries.find((delivery) => delivery.id === id), structuredClone(patch)); },
    async saveMapping() {},
    async saveRule(saved) {
      if (runnerStarted && options.failRuleSavesAfterRunner) throw new Error("RULE_STORE_UNAVAILABLE");
      rule = structuredClone(saved);
      return structuredClone(saved);
    }
  };
  return {
    repository,
    events,
    deliveries,
    meta,
    markRunnerStarted() { runnerStarted = true; },
    rule() { return structuredClone(rule); },
    replaceRule(next) { rule = structuredClone(next); runnerStarted = false; }
  };
}

test("manual and scheduled execution share one generation lease and call the runner once", async () => {
  const target = { id: "target-concurrent", chatId: "-100500", threadId: 8 };
  const rule = {
    id: "rule-concurrent", kind: "automation", contentType: "crypto-daily", schedulePreset: "daily-0800-utc",
    enabled: true, runOnce: true, status: "ready", nextRunAt: "2026-08-19T10:40:00.000Z", targets: [target]
  };
  const harness = createAutomationReviewRepository(rule);
  let runnerCalls = 0;
  let releaseRunner;
  const runnerGate = new Promise((resolve) => { releaseRunner = resolve; });
  let runnerEntered;
  const entered = new Promise((resolve) => { runnerEntered = resolve; });
  const runner = async () => {
    runnerCalls += 1;
    runnerEntered();
    await runnerGate;
    return { status: "success", preview: { targetResults: [{ target, status: "success", messageId: 1301 }] } };
  };

  const manual = runDistributionAutomationRule(rule.id, {
    repository: harness.repository, runner, now: new Date("2026-08-19T10:40:37.000Z")
  });
  await entered;
  const scheduledRun = runDueDistributionJobs(new Date("2026-08-19T10:40:37.000Z"), {
    repository: harness.repository, runner
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseRunner();
  const [scheduled] = await Promise.all([scheduledRun, manual]);

  assert.equal(runnerCalls, 1);
  assert.equal(scheduled.results[0].status, "busy");
});

test("the sending fence is persisted with compare-and-set before the runner starts", async () => {
  const target = { id: "target-cas", chatId: "-100505", threadId: 8 };
  const rule = {
    id: "rule-cas", kind: "automation", contentType: "crypto-daily", schedulePreset: "daily-0800-utc",
    enabled: true, runOnce: true, status: "ready", nextRunAt: "2026-08-19T10:40:00.000Z", targets: [target]
  };
  const harness = createAutomationReviewRepository(rule);
  const setMeta = harness.repository.setMeta;
  harness.repository.setMeta = async (key, value) => {
    if (value?.phase === "sending") throw new Error("SENDING_FENCE_MUST_USE_CAS");
    return setMeta(key, value);
  };
  let runnerCalls = 0;
  const result = await runDistributionAutomationRule(rule.id, {
    repository: harness.repository,
    now: new Date("2026-08-19T10:40:37.000Z"),
    runner: async () => {
      runnerCalls += 1;
      return { status: "success", preview: { targetResults: [{ target, status: "success", messageId: 1305 }] } };
    }
  });

  assert.equal(result.status, "success");
  assert.equal(runnerCalls, 1);
});

test("a completed receipt generation does not suppress a re-enabled changed generation", async () => {
  const target = { id: "target-generation", chatId: "-100510", threadId: 8 };
  const firstRule = {
    id: "rule-generation", kind: "automation", contentType: "crypto-daily", schedulePreset: "daily-0800-utc",
    enabled: true, runOnce: true, status: "ready", nextRunAt: "2026-08-19T10:40:00.000Z", targets: [target]
  };
  const harness = createAutomationReviewRepository(firstRule);
  let runnerCalls = 0;
  const runner = async () => ({
    status: "success",
    preview: { targetResults: [{ target, status: "success", messageId: 1400 + (++runnerCalls) }] }
  });

  await runDueDistributionJobs(new Date("2026-08-19T10:40:37.000Z"), { repository: harness.repository, runner });
  harness.replaceRule({
    ...harness.rule(), enabled: true, status: "ready", contentType: "weekly-calendar",
    schedulePreset: "weekly-monday-0030-utc", nextRunAt: "2026-08-26T10:40:00.000Z", leaseUntil: null
  });
  await runDueDistributionJobs(new Date("2026-08-26T10:40:37.000Z"), { repository: harness.repository, runner });

  assert.equal(runnerCalls, 2);
});

test("mixed receipts with both receipt and delivery persistence unavailable require manual reconciliation", async () => {
  const targets = [
    { id: "target-double-a", chatId: "-100520", threadId: 8 },
    { id: "target-double-b", chatId: "-100521", threadId: 8 }
  ];
  const rule = {
    id: "rule-double-failure", kind: "automation", contentType: "crypto-daily", schedulePreset: "daily-0800-utc",
    enabled: true, runOnce: true, status: "ready", nextRunAt: "2026-08-19T10:40:00.000Z", targets
  };
  const harness = createAutomationReviewRepository(rule, { failMetaAfterRunner: true, failDeliveries: true });
  let runnerCalls = 0;
  const runner = async () => {
    runnerCalls += 1;
    harness.markRunnerStarted();
    return { status: "success", preview: { targetResults: [
      { target: targets[0], status: "success", messageId: 1501 },
      { target: targets[1], status: "failed", error: "TEMPORARY_FAILURE" }
    ] } };
  };

  const first = await runDueDistributionJobs(new Date("2026-08-19T10:40:37.000Z"), { repository: harness.repository, runner });
  const second = await runDueDistributionJobs(new Date("2026-08-19T10:45:37.000Z"), { repository: harness.repository, runner });

  assert.equal(first.results[0].status, "manual-reconciliation");
  assert.equal(second.claimed, 0);
  assert.equal(runnerCalls, 1);
  assert.equal(harness.rule().enabled, false);
  assert.equal(harness.rule().status, "manual-reconciliation");
});

test("mixed receipts without a meta store fail closed when delivery persistence also fails", async () => {
  const targets = [
    { id: "target-no-meta-a", chatId: "-100522", threadId: 8 },
    { id: "target-no-meta-b", chatId: "-100523", threadId: 8 }
  ];
  let rule = {
    id: "rule-no-meta-double-failure", kind: "automation", contentType: "crypto-daily",
    enabled: true, runOnce: true, status: "ready", nextRunAt: "2026-08-19T10:40:00.000Z", targets
  };
  const events = [];
  const repository = {
    async cleanupExpired() {},
    async getMeta(key) { return key === "legacy-migration-v1" ? { completedAt: "2026-08-01T00:00:00.000Z" } : null; },
    async claimDueAutomationRules() { return rule.enabled ? [structuredClone(rule)] : []; },
    async listRules() { return []; },
    async createEvent(event) { const saved = { id: "event-no-meta", ...event }; events.push(saved); return saved; },
    async updateEvent(id, patch) { Object.assign(events.find((event) => event.id === id), structuredClone(patch)); },
    async createDelivery() { throw new Error("DELIVERY_STORE_UNAVAILABLE"); },
    async saveMapping() {},
    async saveRule(saved) { rule = structuredClone(saved); return saved; }
  };
  let runnerCalls = 0;
  const execution = await runDueDistributionJobs(new Date("2026-08-19T10:40:37.000Z"), {
    repository,
    runner: async () => {
      runnerCalls += 1;
      return { status: "success", preview: { targetResults: [
        { target: targets[0], status: "success", messageId: 1502 },
        { target: targets[1], status: "failed", error: "TEMPORARY_FAILURE" }
      ] } };
    }
  });

  assert.equal(execution.results[0].status, "manual-reconciliation");
  assert.equal(events[0].payload.outcome, "manual-reconciliation");
  assert.equal(runnerCalls, 1);
  assert.equal(rule.enabled, false);
  assert.equal(rule.status, "manual-reconciliation");
});

test("conflicting target ids fail closed before endpoint result matching", async () => {
  const targets = [
    { id: "duplicate-target-id", chatId: "-100530", threadId: 8 },
    { id: "duplicate-target-id", chatId: "-100531", threadId: 8 }
  ];
  const harness = createAutomationReviewRepository({
    id: "rule-target-id-conflict", kind: "automation", contentType: "crypto-daily", targets
  });
  let runnerCalls = 0;

  const result = await runDistributionAutomationRule("rule-target-id-conflict", {
    repository: harness.repository,
    runner: async () => { runnerCalls += 1; return { status: "success", preview: { targetResults: [] } }; }
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error, "AUTOMATION_TARGET_ID_CONFLICT");
  assert.equal(runnerCalls, 0);
});

test("receipt recovery never scans a truncated global delivery list", async () => {
  const target = { id: "target-no-global-scan", chatId: "-100540", threadId: 8 };
  const harness = createAutomationReviewRepository({
    id: "rule-no-global-scan", kind: "automation", contentType: "crypto-daily", runOnce: true, targets: [target]
  }, { rejectUnscopedDeliveries: true });
  let runnerCalls = 0;

  const result = await runDistributionAutomationRule("rule-no-global-scan", {
    repository: harness.repository,
    runner: async () => {
      runnerCalls += 1;
      return { status: "success", preview: { targetResults: [{ target, status: "success", messageId: 1601 }] } };
    }
  });

  assert.equal(result.status, "success");
  assert.equal(runnerCalls, 1);
});

test("recurring scheduled executions use distinct generations", async () => {
  const target = { id: "target-recurring-generation", chatId: "-100550", threadId: 8 };
  const harness = createAutomationReviewRepository({
    id: "rule-recurring-generation", kind: "automation", contentType: "crypto-daily", schedulePreset: "daily-0800-utc",
    enabled: true, runOnce: false, status: "ready", nextRunAt: "2026-08-19T08:00:00.000Z", targets: [target]
  });
  let runnerCalls = 0;
  const runner = async () => ({
    status: "success",
    preview: { targetResults: [{ target, status: "success", messageId: 1700 + (++runnerCalls) }] }
  });

  await runDueDistributionJobs(new Date("2026-08-19T08:00:01.000Z"), { repository: harness.repository, runner });
  await runDueDistributionJobs(new Date("2026-08-20T08:00:01.000Z"), { repository: harness.repository, runner });

  assert.equal(runnerCalls, 2);
});

test("automation execution lease heartbeat prevents a second repository runner after the lease TTL", async () => {
  const target = { id: "heartbeat-target", chatId: "-100560", threadId: 8 };
  const rule = {
    id: "heartbeat-rule", kind: "automation", contentType: "crypto-daily", runOnce: true,
    enabled: true, status: "ready", nextRunAt: "2026-08-19T08:00:00.000Z", targets: [target]
  };
  const harness = createAutomationReviewRepository(rule, { leaseTtlMs: 40 });
  const secondRepository = { ...harness.repository };
  let runnerCalls = 0;
  let releaseRunner;
  const gate = new Promise((resolve) => { releaseRunner = resolve; });
  let entered;
  const runnerEntered = new Promise((resolve) => { entered = resolve; });
  const runner = async () => {
    runnerCalls += 1;
    entered();
    await gate;
    return { status: "success", preview: { targetResults: [{ target, status: "success", messageId: 1801 }] } };
  };
  const env = { AUTOMATION_EXECUTION_LEASE_HEARTBEAT_MS: "10" };

  const first = runDistributionAutomationRule(rule.id, { repository: harness.repository, runner, env });
  await runnerEntered;
  await new Promise((resolve) => setTimeout(resolve, 75));
  const second = await runDistributionAutomationRule(rule.id, { repository: secondRepository, runner, env });
  releaseRunner();
  await first;

  assert.equal(runnerCalls, 1);
  assert.equal(second.status, "busy");
});

test("heartbeat and critical lease renewals never overlap", async () => {
  const target = { id: "slow-renew-target", chatId: "-100593", threadId: 8 };
  const harness = createAutomationReviewRepository({
    id: "slow-renew-rule", kind: "automation", contentType: "crypto-daily", runOnce: true,
    enabled: true, status: "ready", targets: [target]
  });
  const originalRenew = harness.repository.renewMetaLease;
  let active = 0;
  let maximumActive = 0;
  let releaseRenew;
  const renewGate = new Promise((resolve) => { releaseRenew = resolve; });
  let renewEntered;
  const firstRenew = new Promise((resolve) => { renewEntered = resolve; });
  harness.repository.renewMetaLease = async (...args) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    renewEntered();
    await renewGate;
    try { return await originalRenew(...args); }
    finally { active -= 1; }
  };
  const running = runDistributionAutomationRule("slow-renew-rule", {
    repository: harness.repository,
    env: { AUTOMATION_EXECUTION_LEASE_HEARTBEAT_MS: "5" },
    runner: async () => {
      await firstRenew;
      return { status: "success", preview: { targetResults: [{ target, status: "success", messageId: 1809 }] } };
    }
  });
  await firstRenew;
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseRenew();
  await running;

  assert.equal(maximumActive, 1);
});

test("a hung lease renewal is bounded and cannot hang the execution", async () => {
  const target = { id: "hung-renew-target", chatId: "-100594", threadId: 8 };
  const harness = createAutomationReviewRepository({
    id: "hung-renew-rule", kind: "automation", contentType: "crypto-daily", runOnce: true,
    enabled: true, status: "ready", targets: [target]
  });
  harness.repository.renewMetaLease = async () => new Promise(() => {});
  let runnerCalls = 0;

  const result = await Promise.race([
    runDistributionAutomationRule("hung-renew-rule", {
      repository: harness.repository,
      env: { AUTOMATION_EXECUTION_LEASE_RENEW_TIMEOUT_MS: "15", AUTOMATION_EXECUTION_LEASE_HEARTBEAT_MS: "5" },
      runner: async () => { runnerCalls += 1; return { status: "success", preview: { targetResults: [] } }; }
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("EXECUTION_HUNG")), 150))
  ]);

  assert.equal(result.status, "failed");
  assert.equal(result.error, "AUTOMATION_EXECUTION_LEASE_LOST");
  assert.equal(runnerCalls, 0);
});

test("lease release failure cannot overwrite a confirmed result or cause resend", async () => {
  const target = { id: "release-throw-target", chatId: "-100561", threadId: 8 };
  const harness = createAutomationReviewRepository({
    id: "release-throw-rule", kind: "automation", contentType: "crypto-daily", runOnce: true, targets: [target]
  });
  harness.repository.releaseMetaLease = async () => { throw new Error("LEASE_RELEASE_FAILED"); };
  let runnerCalls = 0;
  const runner = async () => ({ status: "success", preview: { targetResults: [
    { target, status: "success", messageId: 1802 + runnerCalls++ }
  ] } });

  const first = await runDistributionAutomationRule("release-throw-rule", { repository: harness.repository, runner });
  const second = await runDistributionAutomationRule("release-throw-rule", { repository: harness.repository, runner });

  assert.equal(first.status, "success");
  assert.ok(second.alreadyDelivered === true || second.status === "busy");
  assert.equal(runnerCalls, 1);
});

test("manual reconciliation can only be acknowledged as sent by an authorized operator and never retries", async () => {
  const targets = [
    { id: "manual-a", chatId: "-100562", threadId: 8 },
    { id: "manual-b", chatId: "-100563", threadId: 8 }
  ];
  const options = { failMetaAfterRunner: true, failDeliveries: true };
  const harness = createAutomationReviewRepository({
    id: "manual-reset-rule", kind: "automation", contentType: "crypto-daily", enabled: true,
    runOnce: true, status: "ready", nextRunAt: "2026-08-19T08:00:00.000Z", targets
  }, options);
  let runnerCalls = 0;
  const runner = async () => {
    runnerCalls += 1;
    harness.markRunnerStarted();
    return { status: "partial", preview: { targetResults: [
      { target: targets[0], status: "success", messageId: 1803 },
      { target: targets[1], status: "failed", error: "TEMP" }
    ] } };
  };

  const first = await runDueDistributionJobs(new Date("2026-08-19T08:00:01.000Z"), { repository: harness.repository, runner });
  const blocked = await runDistributionAutomationRule("manual-reset-rule", { repository: harness.repository, runner });
  options.failMetaAfterRunner = false;
  options.failDeliveries = false;
  const generation = first.results[0].generation;
  await assert.rejects(
    resetAutomationManualReconciliation("manual-reset-rule", { repository: harness.repository, expectedGeneration: generation }),
    /AUTOMATION_RECONCILIATION_ACTOR_REQUIRED/
  );
  await assert.rejects(
    resetAutomationManualReconciliation("manual-reset-rule", { repository: harness.repository, actor: "ops" }),
    /AUTOMATION_RECONCILIATION_GENERATION_REQUIRED/
  );
  await assert.rejects(
    resetAutomationManualReconciliation("manual-reset-rule", { repository: harness.repository, actor: "ops", expectedGeneration: "wrong", resolution: "acknowledge-sent", authorize: async () => true }),
    /AUTOMATION_RECONCILIATION_GENERATION_MISMATCH/
  );
  await assert.rejects(
    resetAutomationManualReconciliation("manual-reset-rule", { repository: harness.repository, actor: "ops", expectedGeneration: generation, resolution: "acknowledge-sent" }),
    /AUTOMATION_RECONCILIATION_AUTHORIZATION_REQUIRED/
  );
  await assert.rejects(
    resetAutomationManualReconciliation("manual-reset-rule", { repository: harness.repository, actor: "ops", expectedGeneration: generation, resolution: "retry", authorize: async () => true }),
    /AUTOMATION_RECONCILIATION_RESOLUTION_INVALID/
  );
  const reset = await resetAutomationManualReconciliation("manual-reset-rule", {
    repository: harness.repository, actor: "ops", expectedGeneration: generation,
    resolution: "acknowledge-sent", authorize: async ({ actor }) => actor === "ops",
    now: new Date("2026-08-19T09:00:00.000Z")
  });
  const afterReset = await runDistributionAutomationRule("manual-reset-rule", {
    repository: harness.repository,
    runner: async (_job, input) => {
      runnerCalls += 1;
      return { status: "success", preview: { targetResults: input.targets.map((target, index) => ({ target, status: "success", messageId: 1810 + index })) } };
    }
  });

  assert.equal(first.results[0].status, "manual-reconciliation");
  assert.equal(blocked.status, "manual-reconciliation");
  assert.equal(reset.status, "completed");
  assert.equal(reset.enabled, false);
  assert.equal(afterReset.alreadyDelivered, true);
  assert.equal(runnerCalls, 1);
});

test("acknowledging a recurring scheduled generation advances its schedule without disabling the rule", async () => {
  const targets = [
    { id: "recurring-manual-a", chatId: "-100595", threadId: 8 },
    { id: "recurring-manual-b", chatId: "-100596", threadId: 8 }
  ];
  const failureOptions = { failMetaAfterRunner: true, failDeliveries: true };
  const harness = createAutomationReviewRepository({
    id: "recurring-manual-rule", kind: "automation", contentType: "crypto-daily",
    schedulePreset: "daily-0800-utc", runOnce: false, enabled: true, status: "ready",
    nextRunAt: "2026-08-19T08:00:00.000Z", targets
  }, failureOptions);
  let runnerCalls = 0;
  const first = await runDueDistributionJobs(new Date("2026-08-19T08:00:01.000Z"), {
    repository: harness.repository,
    runner: async () => {
      runnerCalls += 1;
      harness.markRunnerStarted();
      return { status: "partial", preview: { targetResults: [
        { target: targets[0], status: "success", messageId: 1901 },
        { target: targets[1], status: "failed", error: "UNKNOWN_SEND_STATE" }
      ] } };
    }
  });
  failureOptions.failMetaAfterRunner = false;
  failureOptions.failDeliveries = false;
  const generation = first.results[0].generation;

  const reset = await resetAutomationManualReconciliation("recurring-manual-rule", {
    repository: harness.repository,
    actor: "operator@example.com",
    expectedGeneration: generation,
    resolution: "acknowledge-sent",
    authorize: async ({ actor }) => actor === "operator@example.com",
    now: new Date("2026-08-19T09:00:00.000Z")
  });
  const oldSlot = await runDueDistributionJobs(new Date("2026-08-19T09:00:01.000Z"), {
    repository: harness.repository,
    runner: async () => { runnerCalls += 1; throw new Error("OLD_GENERATION_RESENT"); }
  });

  assert.equal(reset.enabled, true);
  assert.equal(reset.status, "ready");
  assert.equal(reset.nextRunAt, "2026-08-20T08:00:00.000Z");
  assert.equal(oldSlot.claimed, 0);
  assert.equal(runnerCalls, 1);
});

test("runner timeout aborts the job and permanently fences the execution", async () => {
  const target = { id: "timeout-target", chatId: "-100590", threadId: 8 };
  const harness = createAutomationReviewRepository({
    id: "timeout-rule", kind: "automation", contentType: "crypto-daily", enabled: true,
    runOnce: true, status: "ready", targets: [target]
  });
  let calls = 0;
  let observedSignal;
  const runner = async (_job, options) => {
    calls += 1;
    observedSignal = options.signal;
    await new Promise(() => {});
  };

  const first = await runDistributionAutomationRule("timeout-rule", {
    repository: harness.repository, runner, env: { AUTOMATION_RUNNER_TIMEOUT_MS: "15" }
  });
  const second = await runDistributionAutomationRule("timeout-rule", {
    repository: harness.repository, runner, env: { AUTOMATION_RUNNER_TIMEOUT_MS: "15" }
  });

  assert.equal(first.status, "manual-reconciliation");
  assert.equal(first.error, "AUTOMATION_RUNNER_TIMEOUT");
  assert.equal(observedSignal.aborted, true);
  assert.equal(second.status, "manual-reconciliation");
  assert.equal(calls, 1);
});

test("a sending CAS that commits then throws is treated as uncertain and never invokes the runner", async () => {
  const target = { id: "commit-throw", chatId: "-100591", threadId: 8 };
  const harness = createAutomationReviewRepository({
    id: "commit-throw-rule", kind: "automation", contentType: "crypto-daily", enabled: true,
    runOnce: true, status: "ready", targets: [target]
  });
  const originalCas = harness.repository.compareAndSetMeta;
  harness.repository.compareAndSetMeta = async (key, expected, value) => {
    const result = await originalCas(key, expected, value);
    if (value?.phase === "sending") throw new Error("CLIENT_LOST_AFTER_COMMIT");
    return result;
  };
  let calls = 0;
  const result = await runDistributionAutomationRule("commit-throw-rule", {
    repository: harness.repository,
    runner: async () => { calls += 1; return {}; }
  });
  const retry = await runDistributionAutomationRule("commit-throw-rule", {
    repository: harness.repository,
    runner: async () => { calls += 1; return {}; }
  });

  assert.equal(result.status, "manual-reconciliation");
  assert.equal(result.error, "AUTOMATION_SENDING_FENCE_COMMIT_UNCERTAIN");
  assert.equal(retry.status, "manual-reconciliation");
  assert.equal(calls, 0);
});

test("repository-maintained updatedAt does not invalidate a partial retry generation", async () => {
  const targets = [
    { id: "stable-a", chatId: "-100580", threadId: 8 },
    { id: "stable-b", chatId: "-100581", threadId: 8 }
  ];
  const harness = createAutomationReviewRepository({
    id: "stable-revision-rule", kind: "automation", contentType: "crypto-daily", enabled: true,
    runOnce: true, status: "ready", updatedAt: "2026-08-19T07:00:00.000Z",
    nextRunAt: "2026-08-19T08:00:00.000Z", targets
  });
  const attempts = [];
  const runner = async (_job, input) => {
    attempts.push(input.targets.map((target) => target.id));
    return attempts.length === 1
      ? { status: "partial", preview: { targetResults: [
        { target: targets[0], status: "success", messageId: 1901 },
        { target: targets[1], status: "failed", error: "TEMP" }
      ] } }
      : { status: "success", preview: { targetResults: [{ target: targets[1], status: "success", messageId: 1902 }] } };
  };
  await runDueDistributionJobs(new Date("2026-08-19T08:00:01.000Z"), { repository: harness.repository, runner });
  harness.replaceRule({ ...harness.rule(), enabled: true, status: "retrying", updatedAt: "2026-08-19T08:05:00.000Z" });
  await runDistributionAutomationRule("stable-revision-rule", { repository: harness.repository, runner });
  assert.deepEqual(attempts, [["stable-a", "stable-b"], ["stable-b"]]);
});

test("JSON repository preserves a partial generation across automatic updatedAt changes and retries only B", async () => {
  const directory = await mkdtemp(join(tmpdir(), "distribution-json-partial-"));
  const previousDirectory = process.env.JSON_STORE_DIRECTORY;
  const previousBackend = process.env.JSON_STORE_BACKEND;
  process.env.JSON_STORE_DIRECTORY = directory;
  process.env.JSON_STORE_BACKEND = "local";
  try {
    const repository = new JsonDistributionRepository();
    const targets = [
      { id: "json-a", chatId: "-100570", threadId: 8 },
      { id: "json-b", chatId: "-100571", threadId: 8 }
    ];
    await repository.saveRule({
      id: "json-partial-rule", kind: "automation", contentType: "crypto-daily", enabled: true,
      runOnce: true, status: "ready", nextRunAt: "2026-08-19T08:00:00.000Z", targets
    });
    const attempts = [];
    const runner = async (_jobId, options) => {
      attempts.push(options.targets.map((target) => target.id));
      return attempts.length === 1
        ? { status: "partial", preview: { targetResults: [
            { target: options.targets[0], status: "success", messageId: "18446744073709551615" },
            { target: options.targets[1], status: "failed", error: "TEMP" }
          ] } }
        : { status: "success", preview: { targetResults: [
            { target: options.targets[0], status: "success", messageId: "18446744073709551616" }
          ] } };
    };

    const first = await runDistributionAutomationRule("json-partial-rule", {
      repository, runner, now: new Date("2026-08-19T08:00:01.000Z")
    });
    const stored = await repository.getRule("json-partial-rule");
    await repository.saveRule({ ...stored, status: "retrying", nextRunAt: "2026-08-19T08:05:01.000Z" });
    const second = await runDistributionAutomationRule("json-partial-rule", {
      repository, runner, now: new Date("2026-08-19T08:05:01.000Z")
    });

    assert.equal(first.status, "partial");
    assert.equal(second.status, "success");
    assert.deepEqual(attempts, [["json-a", "json-b"], ["json-b"]]);
    const deliveries = await repository.listDeliveries({ limit: 10 });
    assert.ok(deliveries.some((delivery) => delivery.targetMessageId === "18446744073709551615"));
    assert.ok(deliveries.some((delivery) => delivery.targetMessageId === "18446744073709551616"));
  } finally {
    if (previousDirectory === undefined) delete process.env.JSON_STORE_DIRECTORY;
    else process.env.JSON_STORE_DIRECTORY = previousDirectory;
    if (previousBackend === undefined) delete process.env.JSON_STORE_BACKEND;
    else process.env.JSON_STORE_BACKEND = previousBackend;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a late lease loser cannot overwrite a winner's execution or rule state", async () => {
  const target = { id: "late-loser", chatId: "-100572", threadId: 8 };
  const harness = createAutomationReviewRepository({
    id: "late-loser-rule", kind: "automation", contentType: "crypto-daily", enabled: true,
    runOnce: true, status: "ready", nextRunAt: "2026-08-19T08:00:00.000Z", targets: [target]
  });
  let renewals = 0;
  harness.repository.renewMetaLease = async (_key, leaseId) => (++renewals <= 2 ? { leaseId } : null);
  let casCalls = 0;
  const compareAndSetMeta = harness.repository.compareAndSetMeta;
  harness.repository.compareAndSetMeta = async (...args) => (++casCalls === 3 ? null : compareAndSetMeta(...args));
  let runnerCalls = 0;

  const result = await runDistributionAutomationRule("late-loser-rule", {
    repository: harness.repository,
    runner: async () => {
      runnerCalls += 1;
      return { status: "success", preview: { targetResults: [{ target, status: "success", messageId: 1901 }] } };
    }
  });

  assert.equal(result.status, "busy");
  assert.equal(result.error, "AUTOMATION_EXECUTION_FENCE_SUPERSEDED");
  assert.equal(runnerCalls, 1);
  assert.equal(harness.rule().status, "ready");
});

test("an unconfirmed sending phase fences every retry after the runner throws", async () => {
  const target = { id: "uncertain-target", chatId: "-100582", threadId: 8 };
  const harness = createAutomationReviewRepository({
    id: "uncertain-rule", kind: "automation", contentType: "crypto-daily", enabled: true,
    runOnce: true, status: "ready", nextRunAt: "2026-08-19T08:00:00.000Z", targets: [target]
  }, { leaseTtlMs: 10 });
  let runnerCalls = 0;
  const runner = async () => { runnerCalls += 1; throw new Error("CONNECTION_LOST_AFTER_SEND"); };
  const first = await runDistributionAutomationRule("uncertain-rule", { repository: harness.repository, runner });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await runDistributionAutomationRule("uncertain-rule", { repository: { ...harness.repository }, runner });
  assert.equal(first.status, "manual-reconciliation");
  assert.equal(second.status, "manual-reconciliation");
  assert.equal(runnerCalls, 1);
});

test("direct manual reconciliation durably blocks retries when execution meta cannot be updated", async () => {
  const targets = [
    { id: "direct-manual-a", chatId: "-100572", threadId: 8 },
    { id: "direct-manual-b", chatId: "-100573", threadId: 8 }
  ];
  const options = { failMetaAfterRunner: true, failDeliveries: true };
  const harness = createAutomationReviewRepository({
    id: "direct-manual-rule", kind: "automation", contentType: "crypto-daily", enabled: true,
    runOnce: true, status: "ready", targets
  }, options);
  let runnerCalls = 0;
  const runner = async () => {
    runnerCalls += 1;
    harness.markRunnerStarted();
    return { status: "partial", preview: { targetResults: [
      { target: targets[0], status: "success", messageId: 1809 },
      { target: targets[1], status: "failed", error: "TEMP" }
    ] } };
  };

  const first = await runDistributionAutomationRule("direct-manual-rule", { repository: harness.repository, runner });
  const second = await runDistributionAutomationRule("direct-manual-rule", { repository: harness.repository, runner });

  assert.equal(first.status, "manual-reconciliation");
  assert.equal(second.status, "manual-reconciliation");
  assert.equal(harness.rule().status, "manual-reconciliation");
  assert.equal(runnerCalls, 1);
});

test("active partial receipts remain durable after 31 days", async () => {
  const targets = [
    { id: "long-a", chatId: "-100564", threadId: 8 },
    { id: "long-b", chatId: "-100565", threadId: 8 }
  ];
  const harness = createAutomationReviewRepository({
    id: "long-retry-rule", kind: "automation", contentType: "crypto-daily", enabled: true,
    runOnce: true, status: "ready", nextRunAt: "2026-01-01T08:00:00.000Z", targets
  });
  const attempts = [];
  const runner = async (_job, input) => {
    attempts.push(input.targets.map((target) => target.id));
    if (attempts.length === 1) return { status: "partial", preview: { targetResults: [
      { target: targets[0], status: "success", messageId: 1821 },
      { target: targets[1], status: "failed", error: "TEMP" }
    ] } };
    return { status: "success", preview: { targetResults: [{ target: targets[1], status: "success", messageId: 1822 }] } };
  };

  await runDueDistributionJobs(new Date("2026-01-01T08:00:01.000Z"), { repository: harness.repository, runner });
  harness.replaceRule({ ...harness.rule(), enabled: true, nextRunAt: "2026-02-01T08:00:00.000Z" });
  await runDueDistributionJobs(new Date("2026-02-01T08:00:01.000Z"), { repository: harness.repository, runner });

  assert.deepEqual(attempts, [["long-a", "long-b"], ["long-b"]]);
});

test("a new scheduled anchor does not reuse an old partial generation", async () => {
  const targets = [
    { id: "anchor-a", chatId: "-100566", threadId: 8 },
    { id: "anchor-b", chatId: "-100567", threadId: 8 }
  ];
  const harness = createAutomationReviewRepository({
    id: "anchor-rule", kind: "automation", contentType: "crypto-daily", enabled: true,
    runOnce: true, status: "ready", nextRunAt: "2026-08-19T08:00:00.000Z", targets
  });
  const attempts = [];
  const runner = async (_job, input) => {
    attempts.push(input.targets.map((target) => target.id));
    return attempts.length === 1
      ? { status: "partial", preview: { targetResults: [
        { target: targets[0], status: "success", messageId: 1831 },
        { target: targets[1], status: "failed", error: "TEMP" }
      ] } }
      : { status: "success", preview: { targetResults: input.targets.map((target, index) => ({ target, status: "success", messageId: 1832 + index })) } };
  };

  await runDueDistributionJobs(new Date("2026-08-19T08:00:01.000Z"), { repository: harness.repository, runner });
  harness.replaceRule({ ...harness.rule(), enabled: true, status: "ready", nextRunAt: "2026-08-20T08:00:00.000Z" });
  await runDueDistributionJobs(new Date("2026-08-20T08:00:01.000Z"), { repository: harness.repository, runner });

  assert.deepEqual(attempts, [["anchor-a", "anchor-b"], ["anchor-a", "anchor-b"]]);
});

test("target migration keeps unchanged success receipts while CTA revision starts a new run", async () => {
  const a = { id: "revision-a", chatId: "-100568", threadId: 8 };
  const b = { id: "revision-b", chatId: "-100569", threadId: 8 };
  const c = { id: "revision-c", chatId: "-100570", threadId: 8 };
  const harness = createAutomationReviewRepository({
    id: "revision-rule", kind: "automation", contentType: "crypto-daily", enabled: true, runOnce: true,
    status: "ready", updatedAt: "2026-08-19T07:00:00.000Z", nextRunAt: "2026-08-19T08:00:00.000Z", targets: [a, b]
  });
  const attempts = [];
  const runner = async (_job, input) => {
    attempts.push(input.targets.map((target) => target.id));
    if (attempts.length === 1) return { status: "partial", preview: { targetResults: [
      { target: a, status: "success", messageId: 1841 }, { target: b, status: "failed", error: "TEMP" }
    ] } };
    return { status: "success", preview: { targetResults: input.targets.map((target, index) => ({ target, status: "success", messageId: 1842 + index })) } };
  };

  await runDueDistributionJobs(new Date("2026-08-19T08:00:01.000Z"), { repository: harness.repository, runner });
  harness.replaceRule({ ...harness.rule(), enabled: true, status: "ready", updatedAt: "2026-08-20T07:00:00.000Z", nextRunAt: "2026-08-20T08:00:00.000Z", targets: [a, c] });
  await runDueDistributionJobs(new Date("2026-08-20T08:00:01.000Z"), { repository: harness.repository, runner });
  harness.replaceRule({ ...harness.rule(), enabled: true, status: "ready", updatedAt: "2026-08-21T07:00:00.000Z", nextRunAt: "2026-08-21T08:00:00.000Z", targets: [{ ...a, ctaText: "new CTA" }, c] });
  await runDueDistributionJobs(new Date("2026-08-21T08:00:01.000Z"), { repository: harness.repository, runner });

  assert.deepEqual(attempts, [["revision-a", "revision-b"], ["revision-c"], ["revision-a", "revision-c"]]);
});

test("failed event telemetry is queued and flushed on the next execution", async () => {
  const target = { id: "telemetry-target", chatId: "-100571", threadId: 8 };
  const harness = createAutomationReviewRepository({
    id: "telemetry-rule", kind: "automation", contentType: "crypto-daily", runOnce: true, targets: [target]
  });
  const originalUpdateEvent = harness.repository.updateEvent;
  let failTelemetry = true;
  harness.repository.updateEvent = async (...args) => {
    if (failTelemetry) throw new Error("TELEMETRY_UNAVAILABLE");
    return originalUpdateEvent(...args);
  };
  let runnerCalls = 0;
  const runner = async () => ({ status: "success", preview: { targetResults: [
    { target, status: "success", messageId: 1851 + runnerCalls++ }
  ] } });

  const first = await runDistributionAutomationRule("telemetry-rule", { repository: harness.repository, runner });
  const queued = [...harness.meta.values()].find((value) => value?.kind === "automation-telemetry-pending");
  failTelemetry = false;
  const second = await runDistributionAutomationRule("telemetry-rule", { repository: harness.repository, runner });
  const remaining = [...harness.meta.values()].find((value) => value?.kind === "automation-telemetry-pending");

  assert.equal(first.telemetryQueued, true);
  assert.ok(queued);
  assert.equal(second.alreadyDelivered, true);
  assert.equal(remaining, undefined);
  assert.equal(runnerCalls, 1);
});

test("telemetry failures use independent event keys and a poison item does not block later items", async () => {
  const target = { id: "telemetry-isolated-target", chatId: "-100592", threadId: 8 };
  const harness = createAutomationReviewRepository({
    id: "telemetry-isolated-rule", kind: "automation", contentType: "crypto-daily", targets: [target]
  });
  let fail = true;
  const originalUpdate = harness.repository.updateEvent;
  harness.repository.updateEvent = async (...args) => {
    if (fail) throw new Error("TELEMETRY_DOWN");
    return originalUpdate(...args);
  };
  let message = 2000;
  const runner = async () => ({ status: "success", preview: { targetResults: [
    { target, status: "success", messageId: ++message }
  ] } });

  await runDistributionAutomationRule("telemetry-isolated-rule", { repository: harness.repository, runner, now: new Date("2026-08-19T08:00:00Z") });
  await runDistributionAutomationRule("telemetry-isolated-rule", { repository: harness.repository, runner, now: new Date("2026-08-20T08:00:00Z") });
  const queued = [...harness.meta.entries()].filter(([, value]) => value?.kind === "automation-telemetry-pending");
  assert.equal(queued.length, 2);
  assert.notEqual(queued[0][0], queued[1][0]);

  const poisonEventId = queued[0][1].eventId;
  fail = false;
  harness.repository.updateEvent = async (...args) => {
    if (args[0] === poisonEventId) throw new Error("POISON_TELEMETRY");
    return originalUpdate(...args);
  };
  await runDistributionAutomationRule("telemetry-isolated-rule", { repository: harness.repository, runner, now: new Date("2026-08-21T08:00:00Z") });
  const remaining = [...harness.meta.values()].filter((value) => value?.kind === "automation-telemetry-pending");
  assert.deepEqual(remaining.map((value) => value.eventId), [poisonEventId]);
});

test("telemetry rule scopes do not collide when one rule id prefixes another", async () => {
  const target = { id: "scope-target", chatId: "-100597", threadId: 8 };
  const short = createAutomationReviewRepository({ id: "a", kind: "automation", contentType: "crypto-daily", targets: [target] });
  const longRule = { id: "a:b", kind: "automation", contentType: "crypto-daily", targets: [target] };
  short.replaceRule({ id: "a", kind: "automation", contentType: "crypto-daily", targets: [target] });
  const rules = new Map([["a", short.rule()], ["a:b", longRule]]);
  const originalGetRule = short.repository.getRule;
  short.repository.getRule = async (id) => structuredClone(rules.get(id) ?? await originalGetRule(id));
  const originalUpdate = short.repository.updateEvent;
  let fail = true;
  short.repository.updateEvent = async (...args) => {
    if (fail) throw new Error("TELEMETRY_DOWN");
    return originalUpdate(...args);
  };
  let messageId = 2100;
  const runner = async () => ({ status: "success", preview: { targetResults: [{ target, status: "success", messageId: ++messageId }] } });

  await runDistributionAutomationRule("a", { repository: short.repository, runner, now: new Date("2026-08-19T08:00:00Z") });
  await runDistributionAutomationRule("a:b", { repository: short.repository, runner, now: new Date("2026-08-19T08:01:00Z") });
  fail = false;
  await runDistributionAutomationRule("a", { repository: short.repository, runner, now: new Date("2026-08-20T08:00:00Z") });

  const remaining = [...short.meta.values()].filter((value) => value?.kind === "automation-telemetry-pending");
  assert.deepEqual(remaining.map((value) => value.ruleId), ["a:b"]);
});

test("scheduled release checks are rescheduled at the next whole minute after a non-publishable result", async () => {
  const now = new Date("2026-08-19T10:40:37.000Z");
  const rule = {
    id: "release-poller",
    kind: "automation",
    name: "Data Release Updates",
    contentType: "data-release-updates",
    schedulePreset: "event-driven",
    enabled: true,
    status: "running",
    nextRunAt: "2026-08-19T10:40:00.000Z",
    targets: [{ id: "release-target", chatId: "-100200", threadId: 8 }]
  };
  const events = [];
  const savedRules = [];
  const deliveries = [];
  const repository = {
    async cleanupExpired() {},
    async getMeta() { return { completedAt: "2026-08-01T00:00:00.000Z" }; },
    async claimDueAutomationRules() { return [rule]; },
    async listRules() { return []; },
    async createEvent(event) {
      const saved = { id: "release-event", ...event };
      events.push(saved);
      return saved;
    },
    async updateEvent(id, patch) {
      Object.assign(events.find((event) => event.id === id), patch);
    },
    async createDelivery(delivery) {
      deliveries.push(delivery);
      return delivery;
    },
    async saveRule(saved) {
      savedRules.push(saved);
      return saved;
    }
  };

  const result = await runDueDistributionJobs(now, {
    repository,
    runner: async (jobId, options) => {
      assert.equal(jobId, "data-release-updates");
      assert.equal(options.repository, repository);
      return {
        status: "skipped",
        preview: {
          templateId: "data-release-updates",
          templateVersion: "market-content-v2",
          sources: [],
          warnings: [],
          deduplicationKey: null,
          skipReason: "actual-not-available",
          deliveryPlans: []
        }
      };
    }
  });

  assert.equal(result.results[0].status, "skipped");
  assert.equal(deliveries.length, 0);
  assert.equal(savedRules[0].status, "ready");
  assert.equal(savedRules[0].nextRunAt, "2026-08-19T10:41:00.000Z");
  assert.equal(events[0].payload.skipReason, "actual-not-available");
});

test("automation preview API is repository-backed and cannot disable dry-run", async () => {
  const source = await readFile(new URL("../app/api/automation-test/route.js", import.meta.url), "utf8");

  assert.match(source, /getDistributionRepository/);
  assert.match(source, /const repository = await getDistributionRepository\(\)/);
  assert.match(source, /const previewRepository =/);
  assert.match(source, /runAutomationJob\([\s\S]*?dryRun:\s*true/);
  assert.match(source, /runAutomationJob\([\s\S]*?force:\s*true/);
  assert.match(source, /runAutomationJob\([\s\S]*?readOnlyPreview:\s*true/);
  assert.match(source, /runAutomationJob\([\s\S]*?repository:\s*previewRepository/);
  assert.match(source, /hydrateDestinationCtas\(previewRepository/);
  assert.match(source, /targets:\s*hydratedTargets/);
  assert.match(source, /buildAutomationTelegramPlans/);
  assert.match(source, /buildAutomationDiscordPlans/);
  assert.doesNotMatch(source, /dryRun:\s*body\./);
  assert.doesNotMatch(source, /setMeta|sendMessage|createDelivery/);
});

test("desktop publishing queues generated content and completes only after a Demo administrator acknowledges it", async () => {
  const target = {
    id: "target-demo-events",
    chatId: "-1003710405969",
    threadId: 8,
    groupName: "DEMO Academy",
    topicName: "3. Market Events"
  };
  const rule = {
    id: "rule-events-desktop",
    kind: "automation",
    name: "Daily Events",
    contentType: "daily-events",
    targets: [target]
  };
  const events = [];
  const deliveries = [];
  const meta = new Map();
  const leases = new Map();
  const repository = {
    async getRule() { return rule; },
    async listRules() { return []; },
    async createEvent(event) {
      const saved = { id: "event-desktop", createdAt: "2026-07-21T12:00:00.000Z", ...event };
      events.push(saved);
      return saved;
    },
    async updateEvent(id, patch) { Object.assign(events.find((event) => event.id === id), patch); },
    async getEvent(id) { return events.find((event) => event.id === id) || null; },
    async createDelivery(delivery) {
      const saved = { id: "delivery-desktop", createdAt: "2026-07-21T12:00:01.000Z", ...delivery };
      deliveries.push(saved);
      return saved;
    },
    async updateDelivery(id, patch) { return Object.assign(deliveries.find((item) => item.id === id), patch, { updatedAt: "2026-07-21T12:00:02.000Z" }); },
    async getDelivery(id) { return deliveries.find((item) => item.id === id) || null; },
    async listDeliveries({ status } = {}) { return deliveries.filter((item) => !status || item.status === status); },
    async claimDelivery(id) {
      const row = deliveries.find((item) => item.id === id);
      if (!row || row.status !== "pending") return null;
      row.status = "sending";
      return row;
    },
    async getMeta(key) { return meta.get(key) || null; },
    async setMeta(key, value) { meta.set(key, value); return value; },
    async acquireMetaLease(key, lease, now = new Date()) {
      const current = leases.get(key);
      if (current?.leaseUntil && Date.parse(current.leaseUntil) > new Date(now).getTime()) return null;
      leases.set(key, lease);
      return lease;
    },
    async getMetaLease(key) { return leases.get(key) || null; },
    async renewMetaLease(key, leaseId, leaseUntil) {
      const current = leases.get(key);
      if (current?.leaseId !== leaseId) return null;
      const renewed = { ...current, leaseUntil };
      leases.set(key, renewed);
      return renewed;
    },
    async releaseMetaLease(key, leaseId) {
      if (leases.get(key)?.leaseId !== leaseId) return false;
      leases.delete(key);
      return true;
    },
    async saveMapping() {}
  };
  const env = {
    NODE_ENV: "production",
    TELEGRAM_PUBLISHER_MODE: "user",
    TELEGRAM_DESKTOP_PUBLISHER_REQUIRED: "true",
    DEMO_TELEGRAM_CHAT_ID: target.chatId,
    APP_BASE_URL: "https://academy.example.com"
  };
  let runnerOptions;

  const run = await runDistributionAutomationRule(rule.id, {
    repository,
    env,
    runner: async (_jobId, options) => {
      runnerOptions = options;
      return {
        status: "queued",
        preview: {
          deliveryPlans: [{
            target,
            steps: [
              { method: "sendPhoto", payload: { chat_id: target.chatId, message_thread_id: 8, photo: "https://academy.example.com/api/media/events.png" } },
              { method: "sendMessage", payload: { chat_id: target.chatId, message_thread_id: 8, text: "<b>Morning brief</b> &amp; verified", parse_mode: "HTML" } }
            ]
          }],
          targetResults: [{ target, status: "pending" }]
        }
      };
    }
  });

  assert.equal(run.status, "queued");
  assert.equal(runnerOptions.deferDelivery, true);
  assert.equal(runnerOptions.publicBaseUrl, env.APP_BASE_URL);
  assert.equal(deliveries[0].status, "pending");
  assert.equal(deliveries[0].attempts, 0);

  const claimedAt = "2026-07-21T12:05:00.000Z";
  const claimed = await claimDesktopPublisherDelivery({ repository, env, now: claimedAt });
  assert.equal(claimed.deliveryId, "delivery-desktop");
  assert.equal(claimed.groupName, "DEMO Academy");
  assert.equal(claimed.topicName, "3. Market Events");
  assert.equal(claimed.contractVersion, "telegram-template-v2");
  assert.equal(claimed.templateVersion, "editorial-template-v1");
  assert.equal(claimed.contentPolicy, "verbatim");
  assert.equal(claimed.identityPolicy, "group-official");
  assert.equal(claimed.inputPolicy, "clipboard-paste");
  assert.equal(claimed.newlinePolicy, "preserve");
  assert.ok(claimed.leaseId);
  assert.deepEqual(claimed.steps.map(({ kind, imageUrl, caption, text }) => ({ kind, imageUrl, caption, text })), [
    { kind: "photo", imageUrl: "https://academy.example.com/api/media/events.png", caption: "", text: undefined },
    { kind: "text", imageUrl: undefined, caption: undefined, text: "Morning brief & verified" }
  ]);
  assert.ok(claimed.steps.every((step) => step.stepId && step.checksum));
  assert.equal(deliveries[0].status, "sending");
  assert.ok(meta.get("desktop-publisher-v1").lastSeenAt);

  const busyClaim = await claimDesktopPublisherDelivery({ repository, env, now: "2026-07-21T12:06:00.000Z" });
  assert.equal(busyClaim, null);

  await assert.rejects(() => completeDesktopPublisherDelivery("delivery-desktop", {
    status: "progress",
    leaseId: claimed.leaseId,
    stepId: claimed.steps[0].stepId,
    targetMessageId: 901
  }, { repository, env, now: "2026-07-21T12:06:15.000Z" }), /DESKTOP_PUBLISHER_PREFLIGHT_REQUIRED/);

  await assert.rejects(() => completeDesktopPublisherDelivery("delivery-desktop", {
    status: "prepared",
    leaseId: claimed.leaseId,
    stepId: claimed.steps[0].stepId,
    observedGroupName: "CryptoGuy Academy",
    observedTopicName: claimed.topicName,
    observedSenderName: claimed.groupName
  }, { repository, env, now: "2026-07-21T12:06:30.000Z" }), /DESKTOP_PUBLISHER_GROUP_MISMATCH/);

  await assert.rejects(() => completeDesktopPublisherDelivery("delivery-desktop", {
    status: "prepared",
    leaseId: claimed.leaseId,
    stepId: claimed.steps[0].stepId,
    observedGroupName: claimed.groupName,
    observedTopicName: "4. Market Analysis - Crypto/Stocks/TradFi",
    observedSenderName: claimed.groupName
  }, { repository, env, now: "2026-07-21T12:06:35.000Z" }), /DESKTOP_PUBLISHER_TOPIC_MISMATCH/);

  await assert.rejects(() => completeDesktopPublisherDelivery("delivery-desktop", {
    status: "prepared",
    leaseId: claimed.leaseId,
    stepId: claimed.steps[0].stepId,
    observedGroupName: claimed.groupName,
    observedTopicName: claimed.topicName,
    observedSenderName: "Serenity_Crypto"
  }, { repository, env, now: "2026-07-21T12:06:40.000Z" }), /DESKTOP_PUBLISHER_SENDER_MISMATCH/);

  const prepared = await completeDesktopPublisherDelivery("delivery-desktop", {
    status: "prepared",
    leaseId: claimed.leaseId,
    stepId: claimed.steps[0].stepId,
    observedGroupName: claimed.groupName,
    observedTopicName: claimed.topicName,
    observedSenderName: claimed.groupName
  }, { repository, env, now: "2026-07-21T12:06:45.000Z" });
  assert.equal(prepared.publisherVerification.stepId, claimed.steps[0].stepId);
  assert.equal(prepared.publisherVerification.observedSenderName, "DEMO Academy");

  const firstProgress = await completeDesktopPublisherDelivery("delivery-desktop", {
    status: "progress",
    leaseId: claimed.leaseId,
    stepId: claimed.steps[0].stepId,
    targetMessageId: 901
  }, { repository, env, now: "2026-07-21T12:07:00.000Z" });
  assert.equal(firstProgress.status, "sending");
  assert.deepEqual(firstProgress.publisherProgress.map((step) => step.stepId), [claimed.steps[0].stepId]);
  assert.equal(firstProgress.publisherVerification, null);
  assert.equal(leases.get("desktop-publisher-lock-v1").leaseUntil, "2026-07-21T12:17:00.000Z");

  await assert.rejects(() => completeDesktopPublisherDelivery("delivery-desktop", {
    status: "success",
    leaseId: claimed.leaseId
  }, { repository, env, now: "2026-07-21T12:08:00.000Z" }), /all template steps/i);

  await assert.rejects(() => completeDesktopPublisherDelivery("delivery-desktop", {
    status: "progress",
    leaseId: "wrong-lease",
    stepId: claimed.steps[1].stepId,
    targetMessageId: 902
  }, { repository, env, now: "2026-07-21T12:09:00.000Z" }), /DESKTOP_PUBLISHER_LEASE_INVALID/);

  const stillBusy = await claimDesktopPublisherDelivery({ repository, env, now: "2026-07-21T12:16:00.000Z" });
  assert.equal(stillBusy, null);

  const resumed = await claimDesktopPublisherDelivery({ repository, env, now: "2026-07-21T12:18:00.000Z" });
  assert.equal(resumed.deliveryId, claimed.deliveryId);
  assert.notEqual(resumed.leaseId, claimed.leaseId);
  assert.deepEqual(resumed.completedSteps.map((step) => step.stepId), [claimed.steps[0].stepId]);

  await completeDesktopPublisherDelivery("delivery-desktop", {
    status: "prepared",
    leaseId: resumed.leaseId,
    stepId: claimed.steps[1].stepId,
    observedGroupName: resumed.groupName,
    observedTopicName: resumed.topicName,
    observedSenderName: resumed.groupName
  }, { repository, env, now: "2026-07-21T12:18:30.000Z" });

  await completeDesktopPublisherDelivery("delivery-desktop", {
    status: "progress",
    leaseId: resumed.leaseId,
    stepId: claimed.steps[1].stepId
  }, { repository, env, now: "2026-07-21T12:19:00.000Z" });

  const completed = await completeDesktopPublisherDelivery("delivery-desktop", {
    status: "success",
    leaseId: resumed.leaseId
  }, { repository, env, now: "2026-07-21T12:20:00.000Z" });
  assert.equal(completed.status, "success");
  assert.equal(completed.attempts, 1);
  assert.deepEqual(completed.targetMessageIds, [901]);
  assert.ok(completed.deliveredAt);
  assert.equal(meta.get("desktop-publisher-v1").lastDeliveryStatus, "success");
  assert.equal(meta.get("desktop-publisher-v1").lastError, null);
  assert.equal(leases.size, 0);
});

test("desktop publisher replaces stale generic Topic labels with the automation destination", async () => {
  const delivery = {
    id: "delivery-stale-topic",
    eventId: "event-stale-topic",
    ruleId: "rule-events",
    status: "pending",
    createdAt: "2026-07-21T12:00:00.000Z",
    target: {
      id: "demo-events",
      chatId: "-1003710405969",
      chatType: "supergroup",
      threadId: 8,
      groupName: "DEMO Academy",
      topicName: "Topic 8"
    }
  };
  const event = {
    id: delivery.eventId,
    payload: {
      jobId: "daily-events",
      deliveryPlans: [{
        target: delivery.target,
        steps: [{ method: "sendMessage", payload: { text: "Market brief" } }]
      }]
    }
  };
  const repository = {
    async listDeliveries() { return [delivery]; },
    async claimDelivery() { delivery.status = "sending"; return delivery; },
    async getEvent() { return event; },
    async updateDelivery(_id, patch) { return Object.assign(delivery, patch); }
  };

  const claimed = await claimDesktopPublisherDelivery({
    repository,
    env: { NODE_ENV: "production", DEMO_TELEGRAM_CHAT_ID: delivery.target.chatId },
    now: "2026-07-21T12:01:00.000Z"
  });

  assert.equal(claimed.topicName, "3. Market Events");
});

test("desktop publisher replaces a stale generic Topic label for a standard broadcast", async () => {
  const delivery = {
    id: "delivery-stale-broadcast-topic",
    eventId: "event-stale-broadcast-topic",
    ruleId: "production-broadcast-topic-5",
    status: "pending",
    createdAt: "2026-07-23T10:34:07.962Z",
    target: {
      id: "crypto-signal",
      chatId: "-1004378187866",
      chatType: "supergroup",
      threadId: 17,
      groupName: "CryptoGuy Academy",
      topicName: "Topic 17"
    }
  };
  const event = {
    id: delivery.eventId,
    payload: {
      deliveryPlans: [{
        target: delivery.target,
        steps: [{ method: "sendMessage", payload: { text: "Realtime community signal" } }]
      }]
    }
  };
  const repository = {
    async listDeliveries({ status } = {}) { return status === delivery.status ? [delivery] : []; },
    async claimDelivery() { delivery.status = "sending"; return delivery; },
    async getEvent() { return event; },
    async updateDelivery(_id, patch) { return Object.assign(delivery, patch); }
  };
  const env = {
    NODE_ENV: "production",
    DEMO_TELEGRAM_CHAT_ID: "-1003710405969",
    TELEGRAM_USER_PUBLISHER_TARGETS: "-1003710405969,-1004378187866"
  };

  const claimed = await claimDesktopPublisherDelivery({
    repository,
    env,
    now: "2026-07-23T10:35:00.000Z"
  });

  assert.equal(claimed.topicName, "5. Community Signal");
});

test("desktop publisher never claims a pending non-Demo delivery", async () => {
  const delivery = {
    id: "delivery-fight",
    eventId: "event-fight",
    status: "pending",
    createdAt: "2026-07-21T12:00:00.000Z",
    target: { id: "fight", chatId: "-1004309440933", threadId: 8, groupName: "Fight Club" }
  };
  const repository = {
    async listDeliveries() { return [delivery]; },
    async claimDelivery() { throw new Error("must not claim"); }
  };

  const result = await claimDesktopPublisherDelivery({
    repository,
    env: { NODE_ENV: "production", DEMO_TELEGRAM_CHAT_ID: "-1003710405969" }
  });
  assert.equal(result, null);
});

test("desktop publisher claims an explicitly approved CryptoGuy Topic delivery", async () => {
  const delivery = {
    id: "delivery-crypto-events",
    eventId: "event-crypto-events",
    ruleId: "rule-demo-to-crypto-events",
    status: "pending",
    createdAt: "2026-07-22T06:00:00.000Z",
    target: {
      id: "crypto-events",
      chatId: "-1004378187866",
      chatType: "supergroup",
      threadId: 8,
      groupName: "CryptoGuy Academy",
      topicName: "3. Market Events"
    }
  };
  const event = {
    id: delivery.eventId,
    payload: {
      deliveryPlans: [{
        target: delivery.target,
        steps: [{ method: "sendMessage", payload: { text: "Topic sync acceptance" } }]
      }]
    }
  };
  const repository = {
    async listDeliveries({ status } = {}) { return status === delivery.status ? [delivery] : []; },
    async claimDelivery() { delivery.status = "sending"; return delivery; },
    async getEvent() { return event; },
    async updateDelivery(_id, patch) { return Object.assign(delivery, patch); }
  };
  const env = {
    NODE_ENV: "production",
    DEMO_TELEGRAM_CHAT_ID: "-1003710405969",
    TELEGRAM_USER_PUBLISHER_TARGETS: "-1003710405969,-1004378187866"
  };

  const claimed = await claimDesktopPublisherDelivery({
    repository,
    env,
    now: "2026-07-22T06:01:00.000Z"
  });

  assert.equal(claimed.chatId, "-1004378187866");
  assert.equal(claimed.threadId, 8);
  assert.equal(claimed.groupName, "CryptoGuy Academy");
  assert.equal(claimed.topicName, "3. Market Events");
  assert.equal(claimed.steps[0].text, "Topic sync acceptance");
});

test("desktop publisher prioritizes a realtime broadcast over an older automation delivery", async () => {
  const automationDelivery = {
    id: "delivery-automation",
    eventId: "event-automation",
    ruleId: "rule-whale",
    status: "pending",
    createdAt: "2026-07-22T05:00:00.000Z",
    target: {
      id: "demo-whale",
      chatId: "-1003710405969",
      chatType: "supergroup",
      threadId: 16,
      groupName: "DEMO Academy",
      topicName: "6. Smart Money Tracker"
    }
  };
  const broadcastDelivery = {
    id: "delivery-broadcast",
    eventId: "event-broadcast",
    ruleId: "rule-community-signal",
    status: "pending",
    createdAt: "2026-07-22T06:00:00.000Z",
    target: {
      id: "crypto-signal",
      chatId: "-1004378187866",
      chatType: "supergroup",
      threadId: 17,
      groupName: "CryptoGuy Academy",
      topicName: "5. Community Signal"
    }
  };
  const deliveries = [automationDelivery, broadcastDelivery];
  const events = new Map([
    [automationDelivery.eventId, {
      id: automationDelivery.eventId,
      payload: {
        jobId: "whale-signals",
        deliveryPlans: [{
          target: automationDelivery.target,
          steps: [{ method: "sendMessage", payload: { text: "Scheduled whale signal" } }]
        }]
      }
    }],
    [broadcastDelivery.eventId, {
      id: broadcastDelivery.eventId,
      payload: {
        deliveryPlans: [{
          target: broadcastDelivery.target,
          steps: [{ method: "sendMessage", payload: { text: "Realtime community signal" } }]
        }]
      }
    }]
  ]);
  const rules = new Map([
    [automationDelivery.ruleId, { id: automationDelivery.ruleId, kind: "automation" }],
    [broadcastDelivery.ruleId, { id: broadcastDelivery.ruleId, kind: "broadcast" }]
  ]);
  const repository = {
    async listDeliveries({ status } = {}) {
      return deliveries.filter((delivery) => delivery.status === status);
    },
    async getRule(id) { return rules.get(id) || null; },
    async claimDelivery(id) {
      const delivery = deliveries.find((item) => item.id === id);
      delivery.status = "sending";
      return delivery;
    },
    async getEvent(id) { return events.get(id) || null; },
    async updateDelivery(id, patch) {
      return Object.assign(deliveries.find((item) => item.id === id), patch);
    }
  };
  const env = {
    NODE_ENV: "production",
    DEMO_TELEGRAM_CHAT_ID: "-1003710405969",
    TELEGRAM_USER_PUBLISHER_TARGETS: "-1003710405969,-1004378187866"
  };

  const claimed = await claimDesktopPublisherDelivery({
    repository,
    env,
    now: "2026-07-22T06:01:00.000Z"
  });

  assert.equal(claimed.deliveryId, broadcastDelivery.id);
  assert.equal(claimed.ruleId, broadcastDelivery.ruleId);
  assert.equal(automationDelivery.status, "pending");
});

test("desktop publisher archives a stale zero-progress delivery instead of blocking fresh work", async () => {
  const releaseEvent = { id: "expired-release", sourceId: "expired-release", scheduledAt: "2026-07-20T00:00:00.000Z", values: { actual: "2.7%" } };
  const releaseKey = buildReleaseDeduplicationKey(releaseEvent);
  const expiredDelivery = {
    id: "delivery-expired",
    eventId: "event-expired",
    ruleId: "rule-expired-whale",
    status: "sending",
    createdAt: "2026-07-20T00:00:00.000Z",
    attempts: 0,
    payload: { releaseDeduplicationKey: releaseKey, releaseTargetKey: "telegram:-1003710405969:16", releaseEvent },
    target: {
      id: "demo-whale",
      chatId: "-1003710405969",
      chatType: "supergroup",
      threadId: 16,
      groupName: "DEMO Academy",
      topicName: "6. Smart Money Tracker"
    }
  };
  const freshDelivery = {
    id: "delivery-fresh-broadcast",
    eventId: "event-fresh-broadcast",
    ruleId: "production-broadcast-topic-5",
    status: "pending",
    createdAt: "2026-07-22T06:00:00.000Z",
    target: {
      id: "crypto-signal",
      chatId: "-1004378187866",
      chatType: "supergroup",
      threadId: 17,
      groupName: "CryptoGuy Academy",
      topicName: "5. Community Signal"
    }
  };
  const deliveries = [expiredDelivery, freshDelivery];
  const events = new Map([
    [expiredDelivery.eventId, {
      id: expiredDelivery.eventId,
      payload: {
        jobId: "whale-signals",
        deliveryPlans: [{
          target: expiredDelivery.target,
          steps: [{ method: "sendMessage", payload: { text: "Expired signal" } }]
        }]
      }
    }],
    [freshDelivery.eventId, {
      id: freshDelivery.eventId,
      payload: {
        deliveryPlans: [{
          target: freshDelivery.target,
          steps: [{ method: "sendMessage", payload: { text: "Fresh community signal" } }]
        }]
      }
    }]
  ]);
  const meta = new Map();
  const repository = {
    async getMeta(key) { return structuredClone(meta.get(key) ?? null); },
    async setMeta(key, value) { meta.set(key, structuredClone(value)); return value; },
    async listDeliveries({ status } = {}) {
      return deliveries.filter((delivery) => delivery.status === status);
    },
    async getRule(id) {
      return id === freshDelivery.ruleId ? { id, kind: "broadcast" } : { id, kind: "automation" };
    },
    async claimDelivery(id) {
      const delivery = deliveries.find((item) => item.id === id);
      delivery.status = "sending";
      return delivery;
    },
    async getEvent(id) { return events.get(id) || null; },
    async updateDelivery(id, patch) {
      return Object.assign(deliveries.find((item) => item.id === id), patch);
    }
  };
  const env = {
    NODE_ENV: "production",
    DEMO_TELEGRAM_CHAT_ID: "-1003710405969",
    TELEGRAM_USER_PUBLISHER_TARGETS: "-1003710405969,-1004378187866"
  };
  await prepareDataReleaseDelivery({ repository, deduplicationKey: releaseKey, event: releaseEvent, targetKeys: [expiredDelivery.payload.releaseTargetKey], now: "2026-07-20T00:00:01Z" });
  await markDataReleaseTargetPending({ repository, deduplicationKey: releaseKey, targetKey: expiredDelivery.payload.releaseTargetKey, event: releaseEvent, now: "2026-07-20T00:00:02Z" });

  const claimed = await claimDesktopPublisherDelivery({
    repository,
    env,
    now: "2026-07-22T06:01:00.000Z"
  });

  assert.equal(claimed.deliveryId, freshDelivery.id);
  assert.equal(expiredDelivery.status, "failed");
  assert.equal(expiredDelivery.attempts, 1);
  assert.match(expiredDelivery.error, /安全归档/);
  const receipt = await prepareDataReleaseDelivery({ repository, deduplicationKey: releaseKey, event: releaseEvent, targetKeys: [expiredDelivery.payload.releaseTargetKey], now: "2026-07-22T06:01:01Z" });
  assert.deepEqual(receipt.readyTargetKeys, [expiredDelivery.payload.releaseTargetKey]);
});

test("desktop publisher releases a queued release claim when its plan is missing", async () => {
  const target = { id: "release-invalid", chatId: "-1001", threadId: 8, groupName: "DEMO Academy" };
  const eventData = { id: "invalid-release", sourceId: "invalid-release", scheduledAt: "2026-08-19T12:30:00.000Z", values: { actual: "2.7%" } };
  const deduplicationKey = buildReleaseDeduplicationKey(eventData);
  const targetKey = buildDataReleaseTargetKey(target);
  const meta = new Map();
  const delivery = { id: "delivery-invalid-release", eventId: "event-invalid-release", ruleId: "rule-invalid-release", status: "pending", attempts: 0, target, payload: { releaseDeduplicationKey: deduplicationKey, releaseTargetKey: targetKey, releaseEvent: eventData } };
  const repository = {
    async getMeta(key) { return structuredClone(meta.get(key) ?? null); }, async setMeta(key, value) { meta.set(key, structuredClone(value)); return value; },
    async listDeliveries({ status }) { return delivery.status === status ? [delivery] : []; }, async getRule() { return { kind: "automation" }; },
    async claimDelivery() { delivery.status = "sending"; return delivery; }, async getEvent() { return { id: delivery.eventId, payload: { deliveryPlans: [] } }; },
    async updateDelivery(_id, patch) { return Object.assign(delivery, patch); },
  };
  await prepareDataReleaseDelivery({ repository, deduplicationKey, event: eventData, targetKeys: [targetKey], now: "2026-08-19T12:30:00Z" });
  await markDataReleaseTargetPending({ repository, deduplicationKey, targetKey, event: eventData, now: "2026-08-19T12:30:01Z" });
  assert.equal(await claimDesktopPublisherDelivery({ repository, env: { TELEGRAM_USER_PUBLISHER_TARGETS: "-1001" }, now: "2026-08-19T12:31:00Z" }), null);
  const receipt = await prepareDataReleaseDelivery({ repository, deduplicationKey, event: eventData, targetKeys: [targetKey], now: "2026-08-19T12:31:01Z" });
  assert.deepEqual(receipt.readyTargetKeys, [targetKey]);
});

test("stale desktop cleanup retries the delivery update before releasing its receipt", async () => {
  const target = { id: "release-stale-compensation", chatId: "-1001", threadId: 8 };
  const eventData = { id: "stale-compensation", sourceId: "stale-compensation", scheduledAt: "2026-07-20T00:00:00.000Z", values: { actual: "2.7%" } };
  const deduplicationKey = buildReleaseDeduplicationKey(eventData);
  const targetKey = buildDataReleaseTargetKey(target);
  const meta = new Map();
  const delivery = { id: "delivery-stale-compensation", eventId: "event-stale-compensation", ruleId: "rule-stale-compensation", status: "sending", attempts: 0, createdAt: "2026-07-20T00:00:00.000Z", target, payload: { releaseDeduplicationKey: deduplicationKey, releaseTargetKey: targetKey, releaseEvent: eventData } };
  let updateFailures = 1;
  const repository = {
    async getMeta(key) { return structuredClone(meta.get(key) ?? null); }, async setMeta(key, value) { meta.set(key, structuredClone(value)); return value; },
    async listDeliveries({ status }) { return delivery.status === status ? [delivery] : []; },
    async updateDelivery(_id, patch) { if (updateFailures-- > 0) throw new Error("delivery update unavailable"); return Object.assign(delivery, patch); },
  };
  await prepareDataReleaseDelivery({ repository, deduplicationKey, event: eventData, targetKeys: [targetKey], now: "2026-07-20T00:00:00Z" });
  await markDataReleaseTargetPending({ repository, deduplicationKey, targetKey, event: eventData, now: "2026-07-20T00:00:01Z" });

  await assert.rejects(() => claimDesktopPublisherDelivery({ repository, env: { TELEGRAM_USER_PUBLISHER_TARGETS: "-1001" }, now: "2026-07-22T06:00:00Z" }), /delivery update unavailable/);
  let receipt = await prepareDataReleaseDelivery({ repository, deduplicationKey, event: eventData, targetKeys: [targetKey], now: "2026-07-22T06:00:01Z" });
  assert.deepEqual(receipt.pendingTargetKeys, [targetKey]);
  assert.equal(delivery.status, "sending");

  assert.equal(await claimDesktopPublisherDelivery({ repository, env: { TELEGRAM_USER_PUBLISHER_TARGETS: "-1001" }, now: "2026-07-22T06:00:02Z" }), null);
  receipt = await prepareDataReleaseDelivery({ repository, deduplicationKey, event: eventData, targetKeys: [targetKey], now: "2026-07-22T06:00:03Z" });
  assert.deepEqual(receipt.readyTargetKeys, [targetKey]);
  assert.equal(delivery.status, "failed");
});

test("failed desktop cleanup compensates a transient receipt release failure on the next pass", async () => {
  const target = { id: "release-receipt-compensation", chatId: "-1001", threadId: 8 };
  const eventData = { id: "receipt-compensation", sourceId: "receipt-compensation", scheduledAt: "2026-08-19T12:30:00.000Z", values: { actual: "2.7%" } };
  const deduplicationKey = buildReleaseDeduplicationKey(eventData);
  const targetKey = buildDataReleaseTargetKey(target);
  const meta = new Map();
  const delivery = { id: "delivery-receipt-compensation", eventId: "event-receipt-compensation", ruleId: "rule-receipt-compensation", status: "pending", attempts: 0, target, payload: { releaseDeduplicationKey: deduplicationKey, releaseTargetKey: targetKey, releaseEvent: eventData } };
  let receiptFailures = 0;
  let failReceiptRelease = false;
  const repository = {
    async getMeta(key) { return structuredClone(meta.get(key) ?? null); },
    async setMeta(key, value) {
      const targetStatus = value?.entries?.[0]?.targets?.[targetKey]?.status;
      if (failReceiptRelease && key === "market-content:release-delivery:v1" && targetStatus === "ready" && receiptFailures++ === 0) throw new Error("receipt store unavailable");
      meta.set(key, structuredClone(value)); return value;
    },
    async listDeliveries({ status }) { return delivery.status === status ? [delivery] : []; }, async getRule() { return { kind: "automation" }; },
    async claimDelivery() { delivery.status = "sending"; return delivery; }, async getEvent() { return { id: delivery.eventId, payload: { deliveryPlans: [] } }; },
    async updateDelivery(_id, patch) { return Object.assign(delivery, patch); },
  };
  await prepareDataReleaseDelivery({ repository, deduplicationKey, event: eventData, targetKeys: [targetKey], now: "2026-08-19T12:30:00Z" });
  await markDataReleaseTargetPending({ repository, deduplicationKey, targetKey, event: eventData, now: "2026-08-19T12:30:01Z" });
  failReceiptRelease = true;

  await assert.rejects(() => claimDesktopPublisherDelivery({ repository, env: { TELEGRAM_USER_PUBLISHER_TARGETS: "-1001" }, now: "2026-08-19T12:31:00Z" }), /receipt store unavailable/);
  assert.equal(delivery.status, "failed");
  assert.equal(await claimDesktopPublisherDelivery({ repository, env: { TELEGRAM_USER_PUBLISHER_TARGETS: "-1001" }, now: "2026-08-19T12:31:01Z" }), null);
  const receipt = await prepareDataReleaseDelivery({ repository, deduplicationKey, event: eventData, targetKeys: [targetKey], now: "2026-08-19T12:31:02Z" });
  assert.deepEqual(receipt.readyTargetKeys, [targetKey]);
});

test("an old failed desktop generation cannot release a newer pending claim during concurrent schedulers", async () => {
  const target = { id: "release-generation", chatId: "-1001", threadId: 8 };
  const eventData = { id: "release-generation", sourceId: "release-generation", scheduledAt: "2026-08-19T12:30:00.000Z", values: { actual: "2.7%" } };
  const deduplicationKey = buildReleaseDeduplicationKey(eventData);
  const targetKey = buildDataReleaseTargetKey(target);
  const oldDelivery = { id: "delivery-old", eventId: "event-old", ruleId: "rule-release", status: "failed", createdAt: "2026-08-19T12:30:00Z", target, payload: { releaseDeduplicationKey: deduplicationKey, releaseTargetKey: targetKey, releaseClaimToken: "old-generation", releaseEvent: eventData } };
  const newerDelivery = { id: "delivery-new", eventId: "event-new", ruleId: "rule-release", status: "pending", createdAt: "2026-08-19T12:31:00Z", target, payload: { releaseDeduplicationKey: deduplicationKey, releaseTargetKey: targetKey, releaseClaimToken: "new-generation", releaseEvent: eventData } };
  const deliveries = [oldDelivery, newerDelivery];
  const meta = new Map();
  const repository = {
    async getMeta(key) { return structuredClone(meta.get(key) ?? null); }, async setMeta(key, value) { meta.set(key, structuredClone(value)); return value; },
    async listDeliveries({ status }) { return deliveries.filter((item) => item.status === status); }, async getRule() { return { kind: "automation" }; },
    async claimDelivery(id) { const item = deliveries.find((row) => row.id === id); if (item.status !== "pending") return null; item.status = "sending"; return item; },
    async getEvent(id) { return { id, payload: { deliveryPlans: [{ target, steps: [{ method: "sendMessage", payload: { text: "release" } }] }] } }; },
    async updateDelivery(id, patch) { return Object.assign(deliveries.find((item) => item.id === id), patch); },
  };
  await prepareDataReleaseDelivery({ repository, deduplicationKey, event: eventData, targetKeys: [targetKey], now: "2026-08-19T12:30:00Z" });
  await markDataReleaseTargetPending({ repository, deduplicationKey, targetKey, event: eventData, claimToken: "new-generation", now: "2026-08-19T12:31:00Z" });

  const [first, second] = await Promise.all([
    claimDesktopPublisherDelivery({ repository, env: { TELEGRAM_USER_PUBLISHER_TARGETS: "-1001" }, now: "2026-08-19T12:31:01Z" }),
    claimDesktopPublisherDelivery({ repository, env: { TELEGRAM_USER_PUBLISHER_TARGETS: "-1001" }, now: "2026-08-19T12:31:01Z" }),
  ]);

  assert.equal([first, second].filter(Boolean).every((item) => item.deliveryId === newerDelivery.id), true);
  const receipt = await prepareDataReleaseDelivery({ repository, deduplicationKey, event: eventData, targetKeys: [targetKey], now: "2026-08-19T12:31:02Z" });
  assert.deepEqual(receipt.pendingTargetKeys, [targetKey]);
  assert.equal(newerDelivery.status, "sending");
});

test("desktop publisher resumes an old delivery when at least one step already succeeded", async () => {
  const delivery = {
    id: "delivery-old-progress",
    eventId: "event-old-progress",
    ruleId: "rule-old-progress",
    status: "sending",
    createdAt: "2026-07-20T00:00:00.000Z",
    publisherProgress: [{ stepId: "completed-step", completedAt: "2026-07-20T00:01:00.000Z" }],
    target: {
      id: "demo-events",
      chatId: "-1003710405969",
      chatType: "supergroup",
      threadId: 8,
      groupName: "DEMO Academy",
      topicName: "3. Market Events"
    }
  };
  const event = {
    id: delivery.eventId,
    payload: {
      jobId: "daily-events",
      deliveryPlans: [{
        target: delivery.target,
        steps: [{ method: "sendMessage", payload: { text: "Remaining step" } }]
      }]
    }
  };
  const repository = {
    async listDeliveries({ status } = {}) { return status === delivery.status ? [delivery] : []; },
    async claimDelivery() { throw new Error("sending delivery must be resumed"); },
    async getEvent() { return event; },
    async updateDelivery(_id, patch) { return Object.assign(delivery, patch); }
  };

  const claimed = await claimDesktopPublisherDelivery({
    repository,
    env: {
      NODE_ENV: "production",
      DEMO_TELEGRAM_CHAT_ID: "-1003710405969"
    },
    now: "2026-07-22T06:01:00.000Z"
  });

  assert.equal(claimed.deliveryId, delivery.id);
  assert.equal(claimed.completedSteps.length, 1);
  assert.equal(delivery.status, "sending");
});

test("broadcast validation checks ForwardBot on the source and the desktop publisher on the target", async () => {
  const source = {
    chatId: "-1003710405969",
    chatType: "supergroup",
    threadId: 8,
    topicName: "3. Market Events"
  };
  const target = {
    id: "crypto-events",
    chatId: "-1004378187866",
    chatType: "supergroup",
    threadId: 8,
    groupName: "CryptoGuy Academy",
    topicName: "3. Market Events"
  };
  const repository = new MemoryDistributionRepository({
    rules: [{
      id: "rule-demo-to-crypto-events",
      kind: "broadcast",
      enabled: true,
      mode: "automatic",
      source,
      targets: [target]
    }]
  });
  repository.health = async () => ({ ok: true });
  const env = {
    NODE_ENV: "production",
    TELEGRAM_PUBLISHER_MODE: "user",
    FORWARD_BOT_TOKEN: "123:forward-token",
    TELEGRAM_DESKTOP_PUBLISHER_REQUIRED: "true",
    TELEGRAM_USER_PUBLISHER_USERNAME: "Serenity_Crypto",
    TELEGRAM_USER_PUBLISHER_TARGETS: "-1003710405969,-1004378187866"
  };
  const calls = [];
  const telegram = async (_token, method, payload) => {
    calls.push({ method, payload });
    if (method === "getMe") return { id: 123, username: "Biupa_geniustrader_bot" };
    if (method === "getChat") return { id: Number(source.chatId), title: "DEMO Academy", type: "supergroup" };
    if (method === "getChatMember") return { status: "administrator" };
    if (method === "getWebhookInfo") return { url: "https://example.test/api/telegram/webhook" };
    throw new Error(`unexpected Telegram method: ${method}`);
  };

  const result = await validateRuleRuntime("rule-demo-to-crypto-events", {
    repository,
    env,
    telegram,
    publisherHealth: {
      operationalReady: true,
      operationalStatus: "online",
      username: "@Serenity_Crypto"
    },
    groupConfig: {
      groups: [
        { chatId: source.chatId, topics: [{ threadId: source.threadId, name: source.topicName }] },
        { chatId: target.chatId, topics: [{ threadId: target.threadId, name: target.topicName }] }
      ]
    }
  });

  assert.equal(result.ok, true);
  assert.equal(calls.filter((call) => call.method === "getChatMember").length, 1);
  assert.equal(calls.find((call) => call.method === "getChatMember").payload.chat_id, source.chatId);
  assert.match(result.checks.find((check) => check.key === `target:${target.id}`).message, /本机发布桥在线/);
});

test("automation validation reports a target blocked by the governed production allowlist", async () => {
  const target = {
    id: "house-market-events",
    chatId: "-1001702053978",
    chatType: "supergroup",
    threadId: 309971,
    groupName: "THE HOUSE OF CRYPTO",
    topicName: "3. Market Events"
  };
  const repository = new MemoryDistributionRepository({
    rules: [{
      id: "rule-house-daily",
      kind: "automation",
      enabled: true,
      mode: "automatic",
      contentType: "crypto-daily",
      targets: [target]
    }]
  });
  repository.health = async () => ({ ok: true });
  const calls = [];
  const result = await validateRuleRuntime("rule-house-daily", {
    repository,
    env: {
      NODE_ENV: "production",
      TELEGRAM_DEMO_ONLY: "true",
      TELEGRAM_DISTRIBUTION_APPROVED_TARGETS: "-1003710405969:8,-1003710405969:10,-1003710405969:16",
      SPEAKER_BOT_TOKEN: "123:speaker-token"
    },
    telegram: async (_token, method) => {
      calls.push(method);
      if (method === "getMe") return { id: 123, username: "Satoshi_geniustrader_bot" };
      throw new Error(`unexpected Telegram method: ${method}`);
    },
    groupConfig: { groups: [{ chatId: target.chatId, topics: [{ threadId: target.threadId, name: target.topicName }] }] }
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, ["getMe"]);
  assert.match(result.checks.find((check) => check.key === `target:${target.id}:policy`).message, /生产允许列表/);
});

test("a desktop broadcast webhook queues the exact approved target Topic for the local bridge", async () => {
  const source = { chatId: "-1003710405969", chatType: "supergroup", threadId: 8 };
  const target = {
    id: "crypto-events",
    chatId: "-1004378187866",
    chatType: "supergroup",
    threadId: 8,
    groupName: "CryptoGuy Academy",
    topicName: "3. Market Events"
  };
  const repository = new MemoryDistributionRepository({
    rules: [{
      id: "rule-demo-to-crypto-events",
      kind: "broadcast",
      enabled: true,
      mode: "automatic",
      source,
      targets: [target]
    }]
  });
  const telegramCalls = [];
  const env = {
    NODE_ENV: "production",
    TELEGRAM_PUBLISHER_MODE: "user",
    TELEGRAM_DESKTOP_PUBLISHER_REQUIRED: "true",
    TELEGRAM_USER_PUBLISHER_TARGETS: "-1003710405969,-1004378187866",
    DEMO_TELEGRAM_CHAT_ID: source.chatId
  };
  const engine = await createDistributionEngine({
    repository,
    env,
    telegram: async (...args) => telegramCalls.push(args)
  });

  const result = await engine.receiveUpdate({
    update_id: 2201,
    message: {
      message_id: 501,
      message_thread_id: source.threadId,
      date: 1784700000,
      chat: { id: Number(source.chatId), title: "DEMO Academy", type: "supergroup" },
      sender_chat: { id: Number(source.chatId), title: "DEMO Academy", type: "supergroup" },
      text: "  SYNC ACCEPTANCE TEST\n\nSecond line  "
    }
  });
  const [delivery] = await repository.listDeliveries();
  const [event] = repository.events;

  assert.equal(result.status, "processed");
  assert.equal(telegramCalls.length, 0);
  assert.equal(delivery.status, "pending");
  assert.deepEqual(event.payload.deliveryPlans[0].target, target);
  assert.deepEqual(event.payload.deliveryPlans[0].steps, [{
    method: "sendMessage",
    payload: {
      chat_id: target.chatId,
      message_thread_id: target.threadId,
      text: "  SYNC ACCEPTANCE TEST\n\nSecond line  "
    }
  }]);
});

test("a desktop photo broadcast preserves the source caption byte for byte", async () => {
  const source = { chatId: "-1003710405969", chatType: "supergroup", threadId: 16 };
  const target = {
    id: "crypto-whale",
    chatId: "-1004378187866",
    chatType: "supergroup",
    threadId: 19,
    groupName: "CryptoGuy Academy",
    topicName: "6. Smart Money Tracker"
  };
  const repository = new MemoryDistributionRepository({
    rules: [{ id: "rule-whale", kind: "broadcast", enabled: true, mode: "automatic", source, targets: [target] }]
  });
  const engine = await createDistributionEngine({
    repository,
    env: {
      NODE_ENV: "production",
      TELEGRAM_PUBLISHER_MODE: "user",
      TELEGRAM_DESKTOP_PUBLISHER_REQUIRED: "true",
      TELEGRAM_USER_PUBLISHER_TARGETS: `${source.chatId},${target.chatId}`,
      DEMO_TELEGRAM_CHAT_ID: source.chatId,
      APP_BASE_URL: "https://academy.example.com",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret"
    },
    telegram: async () => { throw new Error("desktop delivery must not call Bot API"); }
  });
  const caption = "  WHALE ALERT\n\n▪️ Visible size: 12 BTC  ";

  await engine.receiveUpdate({
    update_id: 2202,
    message: {
      message_id: 502,
      message_thread_id: source.threadId,
      date: 1784700001,
      chat: { id: Number(source.chatId), title: "DEMO Academy", type: "supergroup" },
      photo: [{ file_id: "small" }, { file_id: "large" }],
      caption
    }
  });
  const [event] = repository.events;

  assert.equal(event.payload.deliveryPlans[0].steps[0].payload.caption, caption);
});

test("a deduplicated or suppressed automation run creates no failed delivery records", async () => {
  const rule = {
    id: "rule-whale-suppressed",
    kind: "automation",
    name: "Whale monitor",
    contentType: "whale-signals",
    targets: [{ id: "target-whale", chatId: "-1001", threadId: 16 }]
  };
  const deliveries = [];
  const events = [];
  const repository = {
    async getRule() { return rule; },
    async listRules() { return []; },
    async createEvent(event) { const saved = { id: "event-suppressed", ...event }; events.push(saved); return saved; },
    async updateEvent(id, patch) { Object.assign(events.find((item) => item.id === id), patch); },
    async createDelivery(delivery) { deliveries.push(delivery); return delivery; },
    async updateDelivery() {},
    async saveMapping() {}
  };

  const result = await runDistributionAutomationRule(rule.id, {
    repository,
    runner: async () => ({ status: "skipped", message: "No material whale signal", preview: { publishable: false } })
  });

  assert.equal(result.status, "skipped");
  assert.equal(deliveries.length, 0);
  assert.equal(events[0].payload.outcome, "skipped");
});

test("queued release automation passes its repository and does not recreate an existing target claim", async () => {
  const target = { id: "release-target", chatId: "-1001", threadId: 8 };
  const targetKey = buildDataReleaseTargetKey(target);
  const eventData = { id: "us-cpi", sourceId: "us-cpi", scheduledAt: "2026-08-19T12:30:00.000Z", values: { actual: "2.7%" }, actualObservedAt: "2026-08-19T12:30:20.000Z" };
  const deduplicationKey = buildReleaseDeduplicationKey(eventData);
  const rule = { id: "release-rule", kind: "automation", contentType: "data-release-updates", targets: [target] };
  const events = [];
  const deliveries = [];
  const repository = {
    async getRule() { return rule; }, async listRules() { return []; },
    async createEvent(value) { const saved = { id: `event-${events.length + 1}`, ...value }; events.push(saved); return saved; },
    async updateEvent(id, patch) { return Object.assign(events.find((item) => item.id === id), patch); },
    async createDelivery(value) { const saved = { id: `delivery-${deliveries.length + 1}`, ...value }; deliveries.push(saved); return saved; },
    async updateDelivery(id, patch) { return Object.assign(deliveries.find((item) => item.id === id), patch); },
    async saveMapping() {},
  };
  let calls = 0;
  const runner = async (_jobId, options) => {
    calls += 1;
    assert.equal(options.repository, repository);
    return { status: "queued", preview: {
      event: eventData,
      deduplicationKey,
      deliveryReceipt: { deduplicationKey, event: eventData, expectedTargetKeys: [targetKey], pendingTargetKeys: [targetKey] },
      targetResults: [{ target, status: "pending", receiptExisting: calls > 1, releaseTargetKey: targetKey }],
      deliveryPlans: [{ target, steps: [{ method: "sendMessage", payload: { text: "release" } }] }],
    } };
  };

  const options = { repository, runner, env: { TELEGRAM_DESKTOP_PUBLISHER_REQUIRED: "true", TELEGRAM_USER_PUBLISHER_TARGETS: "-1001" } };
  await runDistributionAutomationRule(rule.id, options);
  await runDistributionAutomationRule(rule.id, options);

  assert.equal(deliveries.length, 1);
  assert.equal(events[0].payload.releaseDeduplicationKey, deduplicationKey);
  assert.deepEqual(events[0].payload.releaseExpectedTargetKeys, [targetKey]);
  assert.equal(deliveries[0].payload.releaseTargetKey, targetKey);
});

test("queued release claim is released when delivery persistence fails after the claim", async () => {
  const target = { id: "release-persist-failure", chatId: "-1001", threadId: 8 };
  const targetKey = buildDataReleaseTargetKey(target);
  const eventData = { id: "us-cpi-persist", sourceId: "us-cpi-persist", scheduledAt: "2026-08-19T12:30:00.000Z", values: { actual: "2.7%" } };
  const deduplicationKey = buildReleaseDeduplicationKey(eventData);
  const meta = new Map();
  const events = [];
  let createAttempts = 0;
  const rule = { id: "release-persist-rule", kind: "automation", contentType: "data-release-updates", targets: [target] };
  const repository = {
    async getMeta(key) { return structuredClone(meta.get(key) ?? null); }, async setMeta(key, value) { meta.set(key, structuredClone(value)); return value; },
    async getRule() { return rule; }, async listRules() { return []; },
    async createEvent(value) { const saved = { id: "event-persist", ...value }; events.push(saved); return saved; },
    async updateEvent(_id, patch) { Object.assign(events[0], patch); },
    async createDelivery(value) { createAttempts += 1; if (createAttempts === 1) throw new Error("delivery store unavailable"); return { id: `failed-${createAttempts}`, ...value }; },
    async updateDelivery(_id, patch) { return patch; }, async saveMapping() {},
  };
  const runner = async () => {
    await prepareDataReleaseDelivery({ repository, deduplicationKey, event: eventData, targetKeys: [targetKey], now: "2026-08-19T12:31:00Z" });
    await markDataReleaseTargetPending({ repository, deduplicationKey, targetKey, event: eventData, now: "2026-08-19T12:31:01Z" });
    return { status: "queued", preview: { event: eventData, deliveryReceipt: { deduplicationKey, event: eventData, expectedTargetKeys: [targetKey] }, targetResults: [{ target, status: "pending", releaseTargetKey: targetKey }], deliveryPlans: [{ target, steps: [{ method: "sendMessage", payload: { text: "release" } }] }] } };
  };
  const result = await runDistributionAutomationRule(rule.id, { repository, runner, env: { TELEGRAM_DESKTOP_PUBLISHER_REQUIRED: "true", TELEGRAM_USER_PUBLISHER_TARGETS: "-1001" } });
  assert.equal(result.status, "failed");
  const receipt = await prepareDataReleaseDelivery({ repository, deduplicationKey, event: eventData, targetKeys: [targetKey], now: "2026-08-19T12:32:00Z" });
  assert.deepEqual(receipt.readyTargetKeys, [targetKey]);
});

test("queued release rolls back every unsent target when the second delivery insert fails", async () => {
  const targets = [
    { id: "release-persist-a", chatId: "-1001", threadId: 8 },
    { id: "release-persist-b", chatId: "-1002", threadId: 8 },
  ];
  const targetKeys = targets.map(buildDataReleaseTargetKey);
  const eventData = { id: "us-cpi-multi-persist", sourceId: "us-cpi-multi-persist", scheduledAt: "2026-08-19T12:30:00.000Z", values: { actual: "2.7%" } };
  const deduplicationKey = buildReleaseDeduplicationKey(eventData);
  const meta = new Map();
  const events = [];
  const deliveries = [];
  let insertAttempt = 0;
  const rule = { id: "release-multi-persist-rule", kind: "automation", contentType: "data-release-updates", targets };
  const repository = {
    async getMeta(key) { return structuredClone(meta.get(key) ?? null); },
    async setMeta(key, value) { meta.set(key, structuredClone(value)); return value; },
    async getRule() { return rule; }, async listRules() { return []; },
    async createEvent(value) { const saved = { id: `event-multi-${events.length + 1}`, ...value }; events.push(saved); return saved; },
    async updateEvent(id, patch) { Object.assign(events.find((item) => item.id === id), patch); },
    async createDelivery(value) {
      insertAttempt += 1;
      if (insertAttempt === 2) throw new Error("second delivery insert unavailable");
      const saved = { id: `delivery-multi-${deliveries.length + 1}`, ...structuredClone(value) };
      deliveries.push(saved);
      return saved;
    },
    async updateDelivery(id, patch) { return Object.assign(deliveries.find((item) => item.id === id), patch); },
    async saveMapping() {},
  };
  const runner = async () => {
    await prepareDataReleaseDelivery({ repository, deduplicationKey, event: eventData, targetKeys, now: "2026-08-19T12:31:00Z" });
    for (const targetKey of targetKeys) {
      await markDataReleaseTargetPending({ repository, deduplicationKey, targetKey, event: eventData, now: "2026-08-19T12:31:01Z" });
    }
    return { status: "queued", preview: {
      event: eventData,
      deliveryReceipt: { deduplicationKey, event: eventData, expectedTargetKeys: targetKeys },
      targetResults: targets.map((target, index) => ({ target, status: "pending", releaseTargetKey: targetKeys[index] })),
      deliveryPlans: targets.map((target) => ({ target, steps: [{ method: "sendMessage", payload: { text: "release" } }] })),
    } };
  };

  const first = await runDistributionAutomationRule(rule.id, { repository, runner, env: { TELEGRAM_DESKTOP_PUBLISHER_REQUIRED: "true", TELEGRAM_USER_PUBLISHER_TARGETS: "-1001,-1002" } });
  assert.equal(first.status, "failed");
  const afterFailure = await prepareDataReleaseDelivery({ repository, deduplicationKey, event: eventData, targetKeys, now: "2026-08-19T12:32:00Z" });
  assert.deepEqual(afterFailure.readyTargetKeys.sort(), [...targetKeys].sort());
  assert.equal(deliveries[0].status, "failed");
  assert.equal(deliveries[0].payload.releaseDeduplicationKey, deduplicationKey);

  const recovered = await runDistributionAutomationRule(rule.id, { repository, runner, env: { TELEGRAM_DESKTOP_PUBLISHER_REQUIRED: "true", TELEGRAM_USER_PUBLISHER_TARGETS: "-1001,-1002" } });
  assert.equal(recovered.status, "queued");
  assert.equal(deliveries.filter((delivery) => delivery.status === "pending").length, 2);
});

test("desktop release completion records its target receipt and globally acknowledges the release", async () => {
  const target = { id: "release-target", chatId: "-1001", threadId: 8, groupName: "DEMO Academy" };
  const targetKey = buildDataReleaseTargetKey(target);
  const releaseEvent = {
    id: "us-cpi",
    sourceId: "us-cpi",
    indicator: "cpi",
    country: "US",
    scheduledAt: "2026-08-19T12:30:00.000Z",
    values: { actual: "2.7%" },
    actualObservedAt: "2026-08-19T12:30:20.000Z",
  };
  const deduplicationKey = buildReleaseDeduplicationKey(releaseEvent);
  const meta = new Map([[RELEASE_STATE_META_KEY, {
    calendarWeek: "2026-08-17", monitoredEvents: [{ eventKey: "us-cpi|2026-08-19T12:30:00.000Z", id: "us-cpi", scheduledAt: releaseEvent.scheduledAt, lastActual: null, observedAt: null }], publishedKeys: [], timedOutKeys: [], updatedAt: "2026-08-19T12:30:00.000Z",
  }]]);
  const delivery = { id: "delivery-release", status: "success", target, deliveredAt: "2026-08-19T12:31:00.000Z", payload: { releaseDeduplicationKey: deduplicationKey, releaseTargetKey: targetKey, releaseEvent, releaseExpectedTargetKeys: [targetKey] } };
  const repository = {
    async getMeta(key) { return structuredClone(meta.get(key) ?? null); },
    async setMeta(key, value) { meta.set(key, structuredClone(value)); return value; },
    async getDelivery() { return delivery; },
  };
  await prepareDataReleaseDelivery({ repository, deduplicationKey, event: releaseEvent, targetKeys: [targetKey], now: "2026-08-19T12:30:30Z" });
  await markDataReleaseTargetPending({ repository, deduplicationKey, targetKey, event: releaseEvent, now: "2026-08-19T12:30:31Z" });

  await completeDesktopPublisherDelivery(delivery.id, { status: "success" }, {
    repository, now: "2026-08-19T12:31:05Z", env: { TELEGRAM_USER_PUBLISHER_TARGETS: "-1001" },
  });

  assert.deepEqual((await repository.getMeta(RELEASE_STATE_META_KEY)).publishedKeys, [deduplicationKey]);
  assert.equal((await repository.getMeta(RELEASE_STATE_META_KEY)).monitoredEvents[0].observedAt, releaseEvent.actualObservedAt);
  const nextPoll = await pollDataReleaseUpdates({
    repository,
    now: "2026-08-19T12:32:06Z",
    fetchCalendar: async () => ({ events: [releaseEvent], sources: [] }),
    fetchOfficialActual: async () => ({
      value: "2.7%",
      rawValue: "2.7",
      unit: "%",
      status: "verified",
      authority: "official",
      sourceId: "bls-cpi",
      sourceUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
      publishedAt: releaseEvent.scheduledAt,
      retrievedAt: releaseEvent.actualObservedAt,
    }),
  });
  assert.equal(nextPoll.publishable, false);
  assert.equal(nextPoll.skipReason, "duplicate-release");
});

test("desktop release waits for every expected target receipt before global acknowledgement", async () => {
  const targets = [
    { id: "release-a", chatId: "-1001", threadId: 8, groupName: "DEMO Academy" },
    { id: "release-b", chatId: "-1002", threadId: 8, groupName: "DEMO Academy" },
  ];
  const targetKeys = targets.map(buildDataReleaseTargetKey);
  const releaseEvent = { id: "us-cpi-multi", sourceId: "us-cpi-multi", scheduledAt: "2026-08-19T12:30:00.000Z", values: { actual: "2.7%" }, actualObservedAt: "2026-08-19T12:30:20.000Z" };
  const deduplicationKey = buildReleaseDeduplicationKey(releaseEvent);
  const meta = new Map([[RELEASE_STATE_META_KEY, {
    calendarWeek: "2026-08-17", monitoredEvents: [], publishedKeys: [], timedOutKeys: [], updatedAt: "2026-08-19T12:30:00.000Z",
  }]]);
  const deliveries = targets.map((target, index) => ({
    id: `delivery-${index}`,
    status: "success",
    target,
    payload: {
      releaseDeduplicationKey: deduplicationKey,
      releaseTargetKey: targetKeys[index],
      releaseEvent,
      releaseExpectedTargetKeys: targetKeys,
    },
  }));
  const repository = {
    async getMeta(key) { return structuredClone(meta.get(key) ?? null); },
    async setMeta(key, value) { meta.set(key, structuredClone(value)); return value; },
    async getDelivery(id) { return deliveries.find((delivery) => delivery.id === id); },
  };
  await prepareDataReleaseDelivery({ repository, deduplicationKey, event: releaseEvent, targetKeys, now: "2026-08-19T12:30:30Z" });
  for (let index = 0; index < targets.length; index += 1) {
    await markDataReleaseTargetPending({ repository, deduplicationKey, targetKey: targetKeys[index], event: releaseEvent, now: `2026-08-19T12:30:3${index + 1}Z` });
  }

  await completeDesktopPublisherDelivery(deliveries[0].id, { status: "success" }, {
    repository, now: "2026-08-19T12:31:05Z", env: { TELEGRAM_USER_PUBLISHER_TARGETS: "-1001,-1002" },
  });
  assert.deepEqual((await repository.getMeta(RELEASE_STATE_META_KEY)).publishedKeys, []);

  await completeDesktopPublisherDelivery(deliveries[1].id, { status: "success" }, {
    repository, now: "2026-08-19T12:31:10Z", env: { TELEGRAM_USER_PUBLISHER_TARGETS: "-1001,-1002" },
  });
  assert.deepEqual((await repository.getMeta(RELEASE_STATE_META_KEY)).publishedKeys, [deduplicationKey]);
});

test("production automation execution filters every non-DEMO target until approval", async () => {
  const demo = { id: "target-demo", chatId: "-1001", threadId: 6 };
  const other = { id: "target-other", chatId: "-2001", threadId: 6 };
  const rule = {
    id: "rule-demo-lock",
    kind: "automation",
    name: "DEMO acceptance",
    contentType: "daily-analysis",
    targets: [demo, other],
  };
  const deliveries = [];
  const repository = {
    async getRule() { return rule; },
    async listRules() { return []; },
    async createEvent(event) { return { id: "event-demo-lock", ...event }; },
    async updateEvent() {},
    async createDelivery(delivery) { const row = { id: `delivery-${deliveries.length}`, ...delivery }; deliveries.push(row); return row; },
    async updateDelivery(id, patch) { return Object.assign(deliveries.find((item) => item.id === id), patch); },
    async saveMapping() {},
  };
  let receivedTargets;

  await runDistributionAutomationRule(rule.id, {
    repository,
    env: {
      NODE_ENV: "production",
      TELEGRAM_DEMO_ONLY: "true",
      DEMO_TELEGRAM_CHAT_ID: "-1001",
    },
    runner: async (_jobId, options) => {
      receivedTargets = options.targets;
      return { status: "success", preview: { targetResults: [{ target: demo, status: "success", messageId: 701 }] } };
    },
  });

  assert.deepEqual(receivedTargets, [demo]);
  assert.deepEqual(deliveries.map((item) => item.target.chatId), ["-1001"]);
});

test("automatic publishing expands enabled broadcast destinations and records mappings without a webhook", async () => {
  const sourceTarget = { id: "target-demo", chatId: "-1001", threadId: 6 };
  const destinationTarget = { id: "target-crypto", chatId: "-2001", threadId: 11 };
  const rule = {
    id: "rule-analysis",
    kind: "automation",
    name: "Daily Analysis",
    contentType: "daily-analysis",
    targets: [sourceTarget]
  };
  const broadcast = {
    id: "rule-demo-to-crypto",
    kind: "broadcast",
    enabled: true,
    source: { chatId: "-1001", threadId: 6 },
    targets: [destinationTarget]
  };
  const events = [];
  const deliveries = [];
  const mappings = [];
  const repository = {
    async getRule(id) { return id === rule.id ? rule : null; },
    async listRules(kind) { return kind === "broadcast" ? [broadcast] : []; },
    async createEvent(event) {
      const saved = { id: "event-automation", ...event };
      events.push(saved);
      return saved;
    },
    async updateEvent(id, patch) { Object.assign(events.find((event) => event.id === id), patch); },
    async createDelivery(delivery) {
      const saved = { id: `delivery-${deliveries.length + 1}`, ...delivery };
      deliveries.push(saved);
      return saved;
    },
    async updateDelivery(id, patch) { return Object.assign(deliveries.find((delivery) => delivery.id === id), patch); },
    async saveMapping(mapping) { mappings.push(mapping); return mapping; }
  };

  let receivedTargets;
  await runDistributionAutomationRule(rule.id, {
    repository,
    now: new Date("2026-07-15T06:36:00.000Z"),
    runner: async (_jobId, options) => {
      receivedTargets = options.targets;
      return ({
      status: "success",
      preview: {
        targetResults: [
          { target: sourceTarget, status: "success", messageId: 494 },
          { target: destinationTarget, status: "success", messageId: 89 }
        ]
      }
    }); }
  });

  assert.deepEqual(receivedTargets, [sourceTarget, destinationTarget]);

  assert.deepEqual(mappings, [{
    ruleId: broadcast.id,
    sourceChatId: sourceTarget.chatId,
    sourceMessageId: 494,
    targetChatId: destinationTarget.chatId,
    targetThreadId: destinationTarget.threadId,
    targetMessageId: 89
  }]);
});

test("exact-target automation execution never expands configured targets through broadcast rules", async () => {
  const sourceTarget = { id: "target-demo-exact", chatId: "-1003710405969", threadId: 8 };
  const destinationTarget = { id: "target-broadcast-excluded", chatId: "-1003332783916", threadId: 13 };
  const rule = {
    id: "rule-exact-market-events",
    kind: "automation",
    name: "Exact Market Events Test",
    contentType: "daily-analysis",
    targets: [sourceTarget]
  };
  const broadcast = {
    id: "rule-demo-broadcast",
    kind: "broadcast",
    enabled: true,
    source: { chatId: sourceTarget.chatId, threadId: sourceTarget.threadId },
    targets: [destinationTarget]
  };
  const repository = {
    async getRule(id) { return id === rule.id ? rule : null; },
    async listRules(kind) { return kind === "broadcast" ? [broadcast] : []; },
    async createEvent(event) { return { id: "event-exact-market-events", ...event }; },
    async updateEvent() {},
    async createDelivery(delivery) { return { id: "delivery-exact-market-events", ...delivery }; },
    async updateDelivery() {},
    async saveMapping() { throw new Error("exact target execution must not create broadcast mappings"); }
  };

  let receivedTargets;
  await runDistributionAutomationRule(rule.id, {
    repository,
    exactTargets: true,
    now: new Date("2026-08-22T00:00:00.000Z"),
    runner: async (_jobId, options) => {
      receivedTargets = options.targets;
      return {
        status: "success",
        preview: { targetResults: [{ target: sourceTarget, status: "success", messageId: 1273 }] }
      };
    }
  });

  assert.deepEqual(receivedTargets, [sourceTarget]);
});

test("manual Academy showcase execution passes the explicit poster delivery guard to the runner", async () => {
  const target = { id: "target-demo-text", chatId: "-1003710405969", threadId: 8 };
  const rule = {
    id: "rule-demo-text-only",
    kind: "automation",
    name: "Text-only demo",
    contentType: "daily-analysis",
    targets: [target],
  };
  const repository = {
    async getRule(id) { return id === rule.id ? rule : null; },
    async listRules() { return []; },
    async createEvent(event) { return { id: "event-demo-text-only", ...event }; },
    async updateEvent() {},
    async createDelivery(delivery) { return { id: "delivery-demo-text-only", ...delivery }; },
    async updateDelivery() {},
  };
  let receivedTextOnly;
  let receivedDemoShowcase;
  let receivedDemoAcceptanceBatchId;

  await runDistributionAutomationRule(rule.id, {
    repository,
    exactTargets: true,
    textOnly: false,
    demoShowcase: true,
    demoAcceptanceBatchId: "acceptance-32702768575",
    env: {
      TELEGRAM_DEMO_ONLY: "true",
      TELEGRAM_DISTRIBUTION_APPROVED_TARGETS: "-1003710405969:8,-1003710405969:10,-1003710405969:16",
    },
    now: new Date("2026-08-22T00:00:00.000Z"),
    runner: async (_jobId, options) => {
      receivedTextOnly = options.textOnly;
      receivedDemoShowcase = options.demoShowcase;
      receivedDemoAcceptanceBatchId = options.demoAcceptanceBatchId;
      return {
        status: "success",
        preview: { targetResults: [{ target, status: "success", messageId: 1274 }] },
      };
    },
  });

  assert.equal(receivedTextOnly, false);
  assert.equal(receivedDemoShowcase, true);
  assert.equal(receivedDemoAcceptanceBatchId, "acceptance-32702768575");
});

test("broadcast expansion is one hop, deduplicated, and never auto-publishes review rules", async () => {
  const source = { id: "source", chatId: "-1001", threadId: 10 };
  const destination = { id: "destination", chatId: "-2001", threadId: 17 };
  const secondHop = { id: "second-hop", chatId: "-3001", threadId: 20 };
  const repository = {
    async listRules() {
      return [
        { id: "automatic", enabled: true, mode: "automatic", source, targets: [destination, destination] },
        { id: "review", enabled: true, mode: "review", source, targets: [secondHop] },
        { id: "recursive", enabled: true, mode: "automatic", source: destination, targets: [secondHop] },
      ];
    },
  };

  assert.deepEqual(
    await expandAutomaticBroadcastTargets(repository, [source]),
    [source, destination]
  );
});

test("multi-message market briefs map both the poster and full brief to prevent broadcast duplicates", async () => {
  const sourceTarget = { id: "target-demo-events", chatId: "-1001", threadId: 8 };
  const destinationTarget = { id: "target-crypto-events", chatId: "-2001", threadId: 8 };
  const rule = { id: "rule-events-multi", kind: "automation", name: "Daily Events", contentType: "daily-events", targets: [sourceTarget, destinationTarget] };
  const broadcast = { id: "rule-events-broadcast", kind: "broadcast", enabled: true, source: { chatId: "-1001", threadId: 8 }, targets: [destinationTarget] };
  const mappings = [];
  const deliveries = [];
  const repository = {
    async getRule() { return rule; },
    async listRules(kind) { return kind === "broadcast" ? [broadcast] : []; },
    async createEvent(event) { return { id: "event-multi", ...event }; },
    async updateEvent() {},
    async createDelivery(delivery) { const saved = { id: `delivery-multi-${deliveries.length}`, ...delivery }; deliveries.push(saved); return saved; },
    async updateDelivery(id, patch) { return Object.assign(deliveries.find((item) => item.id === id), patch); },
    async saveMapping(mapping) { mappings.push(mapping); return mapping; }
  };

  await runDistributionAutomationRule(rule.id, {
    repository,
    runner: async () => ({
      status: "success",
      preview: { targetResults: [
        { target: sourceTarget, status: "success", messageId: 500, messageIds: [500, 501] },
        { target: destinationTarget, status: "success", messageId: 90, messageIds: [90, 91] }
      ] }
    })
  });

  assert.deepEqual(mappings.map((item) => [item.sourceMessageId, item.targetMessageId]), [[500, 90], [501, 91]]);
  assert.deepEqual(deliveries[0].targetMessageIds, [500, 501]);
});

test("GitHub Actions keeps distribution as a manual server recovery path", async () => {
  const workflow = await readFile(new URL("../.github/workflows/telegram-automations.yml", import.meta.url), "utf8");
  const distributionJob = workflow.split("  trading:")[0];
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+schedule:/m);
  assert.doesNotMatch(workflow, /github\.event_name == 'schedule'/);
  assert.match(distributionJob, /if: inputs\.job == 'distribution'/);
  assert.match(workflow, /APP_BASE_URL: https:\/\/152-32-161-174\.sslip\.io/);
  assert.match(workflow, /\/api\/cron\/distribution/);
  assert.match(workflow, /secrets\.YUBIT_CRON_SECRET/);
  assert.match(distributionJob, /--max-time 55/);
  assert.doesNotMatch(distributionJob, /--retry/);
  assert.match(distributionJob, /for attempt in 1 2 3/);
  assert.match(distributionJob, /claimed=.*\.claimed \/\/ 0/);
  assert.match(distributionJob, /if \[ "\$claimed" = "0" \]/);
});

test("production no-send deployment preserves the existing Telegram and Discord publisher configuration", async () => {
  const workflow = await readFile(new URL("../.github/workflows/deploy-production-server.yml", import.meta.url), "utf8");
  const desktopRoute = await readFile(new URL("../app/api/cron/desktop-publisher/route.js", import.meta.url), "utf8");

  assert.match(workflow, /expected_targets='-1003710405969:8,-1003710405969:10,-1003710405969:16,-1001702053978:309971'/);
  assert.match(workflow, /read_env TELEGRAM_DEMO_ONLY.*!= "true"/);
  assert.match(workflow, /read_env TRADING_DEMO_ONLY.*!= "true"/);
  assert.match(workflow, /read_env ALLOW_LIVE_TELEGRAM.*= "true"/);
  assert.match(workflow, /publisher_config_before=.*TELEGRAM_.*DISCORD_/);
  assert.match(workflow, /publisher_config_after=.*TELEGRAM_.*DISCORD_/);
  assert.match(workflow, /DEPLOY_NO_SEND: "1"/);
  assert.doesNotMatch(workflow, /TELEGRAM_PUBLISHER_MODE=|TELEGRAM_USER_PUBLISHER_|DESKTOP_PUBLISHER_SECRET=/);
  assert.match(desktopRoute, /process\.env\.DESKTOP_PUBLISHER_SECRET/);
  assert.match(desktopRoute, /leaseId: body\.leaseId/);
  assert.match(desktopRoute, /stepId: body\.stepId/);
  assert.match(desktopRoute, /targetMessageId: body\.targetMessageId/);
  assert.doesNotMatch(desktopRoute, /cronSecretConfig/);
});

test("preview can explicitly use durable Blob-backed JSON while production still requires Postgres", async () => {
  const original = {
    databaseUrl: process.env.DATABASE_URL,
    postgresUrl: process.env.POSTGRES_URL,
    vercel: process.env.VERCEL,
    vercelEnv: process.env.VERCEL_ENV,
    nodeEnv: process.env.NODE_ENV,
    fallback: process.env.DISTRIBUTION_ALLOW_JSON_FALLBACK,
    blobToken: process.env.BLOB_READ_WRITE_TOKEN
  };

  try {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    process.env.NODE_ENV = "production";
    process.env.DISTRIBUTION_ALLOW_JSON_FALLBACK = "true";
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test";
    resetDistributionRepositoryForTests();
    assert.ok((await getDistributionRepository()) instanceof JsonDistributionRepository);

    process.env.VERCEL_ENV = "production";
    resetDistributionRepositoryForTests();
    await assert.rejects(() => getDistributionRepository(), /DATABASE_URL/);
  } finally {
    for (const [key, value] of Object.entries({
      DATABASE_URL: original.databaseUrl,
      POSTGRES_URL: original.postgresUrl,
      VERCEL: original.vercel,
      VERCEL_ENV: original.vercelEnv,
      NODE_ENV: original.nodeEnv,
      DISTRIBUTION_ALLOW_JSON_FALLBACK: original.fallback,
      BLOB_READ_WRITE_TOKEN: original.blobToken
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetDistributionRepositoryForTests();
  }
});

test("preview refuses to reuse the generic production database URL", async () => {
  const original = {
    databaseUrl: process.env.DATABASE_URL,
    postgresUrl: process.env.POSTGRES_URL,
    previewDatabaseUrl: process.env.PREVIEW_DATABASE_URL,
    vercel: process.env.VERCEL,
    vercelEnv: process.env.VERCEL_ENV,
    nodeEnv: process.env.NODE_ENV,
    fallback: process.env.DISTRIBUTION_ALLOW_JSON_FALLBACK,
    blobToken: process.env.BLOB_READ_WRITE_TOKEN
  };

  try {
    process.env.DATABASE_URL = "not-a-database-url";
    delete process.env.POSTGRES_URL;
    delete process.env.PREVIEW_DATABASE_URL;
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    process.env.NODE_ENV = "production";
    delete process.env.DISTRIBUTION_ALLOW_JSON_FALLBACK;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    resetDistributionRepositoryForTests();

    await assert.rejects(
      () => getDistributionRepository(),
      /PREVIEW_DATABASE_URL.*禁止复用生产数据库/
    );
  } finally {
    for (const [key, value] of Object.entries({
      DATABASE_URL: original.databaseUrl,
      POSTGRES_URL: original.postgresUrl,
      PREVIEW_DATABASE_URL: original.previewDatabaseUrl,
      VERCEL: original.vercel,
      VERCEL_ENV: original.vercelEnv,
      NODE_ENV: original.nodeEnv,
      DISTRIBUTION_ALLOW_JSON_FALLBACK: original.fallback,
      BLOB_READ_WRITE_TOKEN: original.blobToken
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetDistributionRepositoryForTests();
  }
});
