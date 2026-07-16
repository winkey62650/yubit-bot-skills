import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  JsonDistributionRepository,
  getDistributionRepository,
  resetDistributionRepositoryForTests
} from "../lib/distribution-repository.mjs";
import {
  ensureAutomationSchedules,
  parseBackfillReferences,
  processTelegramWebhookUpdate,
  runDistributionAutomationRule,
  verifyTelegramWebhookSecret
} from "../lib/distribution-service.mjs";

test("manual backfill accepts IDs, ranges and Telegram links without exceeding 100 messages", () => {
  assert.deepEqual(parseBackfillReferences("77, 79-81\nhttps://t.me/c/12345/12/90"), [77, 79, 80, 81, 90]);
  assert.throws(() => parseBackfillReferences("1-101"), /最多 100/);
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

test("an automatic publishing rule can be run immediately with real per-target delivery records", async () => {
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
    assert.equal(options.force, false);
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

test("GitHub Actions invokes the durable distribution scheduler every five off-peak minutes", async () => {
  const workflow = await readFile(new URL("../.github/workflows/telegram-automations.yml", import.meta.url), "utf8");
  assert.match(workflow, /cron: "2\/5 \* \* \* \*"/);
  assert.match(workflow, /github\.event_name == 'schedule'/);
  assert.match(workflow, /\/api\/cron\/distribution/);
  assert.match(workflow, /secrets\.YUBIT_CRON_SECRET/);
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
