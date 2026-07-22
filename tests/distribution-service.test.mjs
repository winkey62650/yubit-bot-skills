import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  desktopPublisherHealth,
  ensureAutomationSchedules,
  parseBackfillReferences,
  processTelegramWebhookUpdate,
  repairAutomationTargetLabels,
  retryDistributionDelivery,
  runDueDistributionJobs,
  runDistributionAutomationRule,
  verifyTelegramWebhookSecret
} from "../lib/distribution-service.mjs";

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

test("desktop publisher health reports stalled and degraded delivery state truthfully", async () => {
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

  assert.equal(degraded.operationalStatus, "degraded");
  assert.equal(degraded.operationalReady, false);
  assert.equal(degraded.operationalError, "previous delivery failed");
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

test("production distribution allowlist opens only the approved CryptoGuy topics", async () => {
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

  assert.deepEqual(preview.targets, [demo, cryptoAnalysis, cryptoSmartMoney]);
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
    assert.equal(jobId, "daily-events");
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
    assert.equal(jobId, "daily-events");
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
  assert.equal(claimed.contractVersion, "telegram-template-v1");
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

  const firstProgress = await completeDesktopPublisherDelivery("delivery-desktop", {
    status: "progress",
    leaseId: claimed.leaseId,
    stepId: claimed.steps[0].stepId,
    targetMessageId: 901
  }, { repository, env, now: "2026-07-21T12:07:00.000Z" });
  assert.equal(firstProgress.status, "sending");
  assert.deepEqual(firstProgress.publisherProgress.map((step) => step.stepId), [claimed.steps[0].stepId]);
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
    status: "progress",
    leaseId: resumed.leaseId,
    stepId: claimed.steps[1].stepId,
    targetMessageId: 902
  }, { repository, env, now: "2026-07-21T12:19:00.000Z" });

  const completed = await completeDesktopPublisherDelivery("delivery-desktop", {
    status: "success",
    leaseId: resumed.leaseId
  }, { repository, env, now: "2026-07-21T12:20:00.000Z" });
  assert.equal(completed.status, "success");
  assert.equal(completed.attempts, 1);
  assert.deepEqual(completed.targetMessageIds, [901, 902]);
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
    env: { NODE_ENV: "production", DEMO_TELEGRAM_CHAT_ID: delivery.target.chatId }
  });

  assert.equal(claimed.topicName, "3. Market Events");
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

test("automatic multi-target publishing records broadcast mappings before its source webhook arrives", async () => {
  const sourceTarget = { id: "target-demo", chatId: "-1001", threadId: 6 };
  const destinationTarget = { id: "target-crypto", chatId: "-2001", threadId: 11 };
  const rule = {
    id: "rule-analysis",
    kind: "automation",
    name: "Daily Analysis",
    contentType: "daily-analysis",
    targets: [sourceTarget, destinationTarget]
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

  await runDistributionAutomationRule(rule.id, {
    repository,
    now: new Date("2026-07-15T06:36:00.000Z"),
    runner: async () => ({
      status: "success",
      preview: {
        targetResults: [
          { target: sourceTarget, status: "success", messageId: 494 },
          { target: destinationTarget, status: "success", messageId: 89 }
        ]
      }
    })
  });

  assert.deepEqual(mappings, [{
    ruleId: broadcast.id,
    sourceChatId: sourceTarget.chatId,
    sourceMessageId: 494,
    targetChatId: destinationTarget.chatId,
    targetThreadId: destinationTarget.threadId,
    targetMessageId: 89
  }]);
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

test("production deployment uses the official Demo Forum group identity and keeps Trader Demo-only", async () => {
  const workflow = await readFile(new URL("../.github/workflows/deploy-production-server.yml", import.meta.url), "utf8");
  const desktopRoute = await readFile(new URL("../app/api/cron/desktop-publisher/route.js", import.meta.url), "utf8");

  assert.match(workflow, /vars\.TELEGRAM_DISTRIBUTION_APPROVED_TARGETS/);
  assert.match(workflow, /\(\[1-9\]\[0-9\]\*\|channel\)/);
  assert.match(workflow, /TELEGRAM_DEMO_ONLY=true/);
  assert.match(workflow, /TELEGRAM_DISTRIBUTION_APPROVED_TARGETS=%s/);
  assert.match(workflow, /TRADING_DEMO_ONLY=true/);
  assert.match(workflow, /TELEGRAM_PUBLISHER_MODE=user/);
  assert.match(workflow, /TELEGRAM_USER_PUBLISHER_USERNAME=Serenity_Crypto/);
  assert.match(workflow, /TELEGRAM_USER_PUBLISHER_REQUIRED=true/);
  assert.match(workflow, /TELEGRAM_USER_PUBLISHER_TARGETS=-1003710405969/);
  assert.match(workflow, /TELEGRAM_USER_SESSION_ENCRYPTION_KEY=%s/);
  assert.match(workflow, /TELEGRAM_DESKTOP_PUBLISHER_REQUIRED=true/);
  assert.match(workflow, /secrets\.DESKTOP_PUBLISHER_SECRET/);
  assert.match(workflow, /DESKTOP_PUBLISHER_SECRET=%s/);
  assert.match(desktopRoute, /process\.env\.DESKTOP_PUBLISHER_SECRET/);
  assert.match(desktopRoute, /leaseId: body\.leaseId/);
  assert.match(desktopRoute, /stepId: body\.stepId/);
  assert.match(desktopRoute, /targetMessageId: body\.targetMessageId/);
  assert.doesNotMatch(desktopRoute, /cronSecretConfig/);
  assert.doesNotMatch(workflow, /TELEGRAM_PUBLISHER_MODE=bot/);
  assert.doesNotMatch(workflow, /TELEGRAM_USER_PUBLISHER_TARGETS=-1003862539988/);
  assert.match(workflow, /sudo install -m 0600/);
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
