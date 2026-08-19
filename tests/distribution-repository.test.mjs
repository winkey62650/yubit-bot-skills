import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { JsonDistributionRepository, PostgresDistributionRepository } from "../lib/distribution-repository.mjs";

test("JSON reads expose migrated market rules without implicitly persisting them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "distribution-migration-"));
  const previousDirectory = process.env.JSON_STORE_DIRECTORY;
  const previousBackend = process.env.JSON_STORE_BACKEND;
  process.env.JSON_STORE_DIRECTORY = directory;
  process.env.JSON_STORE_BACKEND = "local";
  const stored = {
    schemaVersion: 1,
    rules: [{
      id: "json-events",
      kind: "automation",
      name: "JSON events",
      contentType: "daily-events",
      schedulePreset: "daily-0800-utc",
      targets: [{ chatId: "-1001", threadId: 3 }],
      enabled: true,
    }],
  };
  await writeFile(join(directory, "distribution-center.json"), JSON.stringify(stored));
  try {
    const state = await new JsonDistributionRepository().read();
    assert.deepEqual(state.rules.map((rule) => rule.contentType), ["weekly-calendar", "data-release-updates"]);
    assert.equal(state.rules[1].enabled, false);
    const unchanged = JSON.parse(await readFile(join(directory, "distribution-center.json"), "utf8"));
    assert.equal(unchanged.rules.length, 1);
    assert.equal(unchanged.rules[0].contentType, "daily-events");
  } finally {
    if (previousDirectory === undefined) delete process.env.JSON_STORE_DIRECTORY;
    else process.env.JSON_STORE_DIRECTORY = previousDirectory;
    if (previousBackend === undefined) delete process.env.JSON_STORE_BACKEND;
    else process.env.JSON_STORE_BACKEND = previousBackend;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Postgres listRules exposes migrated market rules without writing them", async () => {
  const repository = Object.create(PostgresDistributionRepository.prototype);
  const calls = [];
  repository.sql = { async query(sql) {
    calls.push(sql);
    if (/SELECT \* FROM distribution_rules/.test(sql)) return [{
      id: "pg-events", kind: "automation", name: "PG events", content_type: "daily-events",
      schedule_preset: "daily-0800-utc", enabled: true, run_once: false, status: "ready",
    }];
    if (/SELECT \* FROM distribution_targets/.test(sql)) return [{
      id: "pg-target", rule_id: "pg-events", platform: "telegram", chat_id: "-1001",
      chat_type: "supergroup", thread_id: 3, enabled: true, sort_order: 0,
    }];
    return [];
  } };

  const rules = await repository.listRules();
  assert.deepEqual(rules.map((rule) => rule.contentType), ["weekly-calendar", "data-release-updates"]);
  assert.equal(rules[1].enabled, false);
  assert.ok(calls.every((sql) => /^SELECT/.test(sql.trim())));
});

test("Postgres rules persist and claim one due automation with a recoverable lease", async () => {
  const repository = Object.create(PostgresDistributionRepository.prototype);
  const calls = [];
  repository.getRule = async () => ({ id: "one-time-events", runOnce: true });
  repository.sql = {
    async query(sql, params) {
      calls.push({ sql, params });
      return [];
    },
  };

  await repository.saveRule({
    id: "one-time-events",
    kind: "automation",
    name: "Daily Events · One-time",
    contentType: "daily-events",
    schedulePreset: "daily-0800-utc",
    enabled: true,
    runOnce: true,
    nextRunAt: "2026-07-17T12:00:00.000Z",
    targets: [{
      chatId: "-1001",
      threadId: 8,
      ctaEnabled: true,
      ctaText: "Open the report",
      ctaUrl: "https://example.com/report"
    }],
  });

  assert.match(calls[0].sql, /run_once/);
  assert.equal(calls[0].params[8], true);
  const targetInsert = calls.find((call) => /INSERT INTO distribution_targets/.test(call.sql));
  assert.match(targetInsert.sql, /cta_enabled,cta_text,cta_url/);
  assert.deepEqual(targetInsert.params.slice(10, 13), [true, "Open the report", "https://example.com/report"]);

  calls.length = 0;
  await repository.claimDueAutomationRules(new Date("2026-07-17T12:02:00.000Z"), { limit: 1, leaseMs: 240000 });
  assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(calls[0].sql, /LIMIT \$2/);
  assert.match(calls[0].sql, /lease_until = \$3/);
  assert.doesNotMatch(calls[0].sql, /enabled\s*=\s*false/);
  assert.doesNotMatch(calls[0].sql, /next_run_at\s*=\s*NULL/);
  assert.deepEqual(calls[0].params, [
    "2026-07-17T12:02:00.000Z",
    1,
    "2026-07-17T12:06:00.000Z"
  ]);
});

test("Postgres target migrations and reads preserve per-target CTA fields", async () => {
  const repository = Object.create(PostgresDistributionRepository.prototype);
  const calls = [];
  repository.sql = {
    async query(sql) {
      calls.push(sql);
      if (/SELECT \* FROM distribution_rules WHERE id/.test(sql)) {
        return [{
          id: "cta-rule",
          kind: "automation",
          name: "CTA rule",
          content_type: "daily-analysis",
          schedule_preset: "daily-0800-utc",
          mode: "automatic",
          source: {},
          enabled: true,
          run_once: false,
          status: "ready"
        }];
      }
      if (/SELECT \* FROM distribution_targets WHERE rule_id/.test(sql)) {
        return [{
          id: "cta-target",
          platform: "telegram",
          chat_id: "-1001",
          chat_type: "supergroup",
          thread_id: 10,
          group_name: "DEMO Academy",
          topic_name: "4. Market Analysis",
          cta_enabled: true,
          cta_text: "Read more",
          cta_url: "https://example.com/analysis",
          enabled: true,
          sort_order: 0
        }];
      }
      return [];
    }
  };

  await repository.initialize();
  assert.ok(calls.some((sql) => /ADD COLUMN IF NOT EXISTS cta_enabled/.test(sql)));
  assert.ok(calls.some((sql) => /ADD COLUMN IF NOT EXISTS cta_text/.test(sql)));
  assert.ok(calls.some((sql) => /ADD COLUMN IF NOT EXISTS cta_url/.test(sql)));
  assert.ok(calls.some((sql) => /distribution_deliveries ADD COLUMN IF NOT EXISTS payload jsonb/.test(sql)));

  const rule = await repository.getRule("cta-rule");
  assert.equal(rule.targets[0].ctaEnabled, true);
  assert.equal(rule.targets[0].ctaText, "Read more");
  assert.equal(rule.targets[0].ctaUrl, "https://example.com/analysis");
});

test("Postgres delivery records preserve every Telegram message id", async () => {
  const repository = Object.create(PostgresDistributionRepository.prototype);
  let captured = null;
  repository.getDelivery = async () => ({
    id: "delivery-1",
    eventId: "event-1",
    ruleId: "rule-1",
    targetId: "target-1",
    target: { chatId: "-1001", threadId: 8 },
    status: "pending",
    attempts: 0,
    targetMessageId: null,
    targetMessageIds: [],
    publisherProgress: [],
    publisherVerification: null,
    payload: { releaseDeduplicationKey: "release-1" },
    error: null,
    deliveredAt: null
  });
  repository.sql = {
    async query(sql, params) {
      captured = { sql, params };
      return [{
        id: "delivery-1",
        event_id: "event-1",
        rule_id: "rule-1",
        target_id: "target-1",
        target: { chatId: "-1001", threadId: 8 },
        status: params[1],
        attempts: params[2],
        target_message_id: params[3],
        target_message_ids: JSON.parse(params[4]),
        publisher_progress: JSON.parse(params[5]),
        publisher_verification: JSON.parse(params[6]),
        payload: JSON.parse(params[7]),
        error: params[8],
        delivered_at: params[9],
        created_at: "2026-07-15T00:00:00.000Z",
        updated_at: "2026-07-15T00:00:00.000Z"
      }];
    }
  };

  const delivery = await repository.updateDelivery("delivery-1", {
    status: "success",
    attempts: 1,
    targetMessageId: 521,
    targetMessageIds: [521, 522],
    publisherProgress: [{ stepId: "1-photo-a1", checksum: "a1", targetMessageId: 521 }],
    publisherVerification: {
      leaseId: "lease-1",
      stepId: "1-photo-a1",
      observedGroupName: "DEMO Academy"
    },
    deliveredAt: "2026-07-15T15:40:00.000Z"
  });

  assert.match(captured.sql, /target_message_ids/);
  assert.match(captured.sql, /publisher_progress/);
  assert.equal(captured.params[4], "[521,522]");
  assert.equal(captured.params[5], '[{"stepId":"1-photo-a1","checksum":"a1","targetMessageId":521}]');
  assert.equal(captured.params[6], '{"leaseId":"lease-1","stepId":"1-photo-a1","observedGroupName":"DEMO Academy"}');
  assert.equal(captured.params[7], '{"releaseDeduplicationKey":"release-1"}');
  assert.deepEqual(delivery.targetMessageIds, [521, 522]);
  assert.deepEqual(delivery.publisherProgress, [{ stepId: "1-photo-a1", checksum: "a1", targetMessageId: 521 }]);
  assert.equal(delivery.publisherVerification.leaseId, "lease-1");
  assert.deepEqual(delivery.payload, { releaseDeduplicationKey: "release-1" });
});

test("Postgres creates delivery rows with their queued release payload", async () => {
  const repository = Object.create(PostgresDistributionRepository.prototype);
  let captured;
  repository.sql = { async query(sql, params) {
    captured = { sql, params };
    return [{ id: "delivery-payload", event_id: "event-1", rule_id: "rule-1", target_id: "target-1", target: {}, payload: JSON.parse(params[7]), status: "pending", attempts: 0 }];
  } };
  const payload = { releaseDeduplicationKey: "release-1", releaseTargetKey: "telegram:-1001:8" };
  const delivery = await repository.createDelivery({ eventId: "event-1", ruleId: "rule-1", targetId: "target-1", target: {}, status: "pending", payload });
  assert.match(captured.sql, /payload/);
  assert.match(captured.sql, /EXCLUDED\.payload = '\{\}'::jsonb THEN distribution_deliveries\.payload/);
  assert.equal(captured.params[7], JSON.stringify(payload));
  assert.deepEqual(delivery.payload, payload);
});

test("Postgres delivery records hide legacy zero Telegram message ids", async () => {
  const repository = Object.create(PostgresDistributionRepository.prototype);
  repository.sql = {
    async query() {
      return [{
        id: "delivery-legacy-zero",
        event_id: "event-legacy-zero",
        rule_id: "rule-legacy-zero",
        target_id: "target-legacy-zero",
        target: { chatId: "-1001", threadId: 8 },
        status: "success",
        attempts: 1,
        target_message_id: 0,
        target_message_ids: [0],
        publisher_progress: [],
        publisher_verification: null,
        error: null,
        delivered_at: "2026-07-22T07:29:04.813Z",
        created_at: "2026-07-22T07:15:08.000Z",
        updated_at: "2026-07-22T07:29:04.813Z"
      }];
    }
  };

  const [delivery] = await repository.listDeliveries({ limit: 1 });

  assert.equal(delivery.targetMessageId, null);
  assert.deepEqual(delivery.targetMessageIds, []);
});

test("Postgres delivery updates keep a standalone Telegram message id", async () => {
  const repository = Object.create(PostgresDistributionRepository.prototype);
  let capturedParams = null;
  repository.getDelivery = async () => ({
    id: "delivery-standalone",
    status: "sending",
    attempts: 0,
    targetMessageId: null,
    targetMessageIds: [],
    publisherProgress: [],
    publisherVerification: null
  });
  repository.sql = {
    async query(_sql, params) {
      capturedParams = params;
      return [{
        id: "delivery-standalone",
        status: params[1],
        attempts: params[2],
        target_message_id: params[3],
        target_message_ids: JSON.parse(params[4]),
        publisher_progress: [],
        publisher_verification: JSON.parse(params[6]),
        error: null
      }];
    }
  };

  await repository.updateDelivery("delivery-standalone", { targetMessageId: 777 });

  assert.equal(capturedParams[3], 777);
  assert.equal(capturedParams[4], "[777]");
});

test("Postgres desktop publisher lease is atomic and only its owner can release it", async () => {
  const repository = Object.create(PostgresDistributionRepository.prototype);
  const calls = [];
  const lease = { leaseId: "lease-1", leaseUntil: "2026-07-21T12:30:00.000Z" };
  repository.sql = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/INSERT INTO distribution_meta/.test(sql)) return [{ value: lease }];
      if (/UPDATE distribution_meta/.test(sql)) return [{ value: { ...lease, leaseUntil: params[2] } }];
      if (/DELETE FROM distribution_meta/.test(sql)) return [{ key: params[0] }];
      return [];
    }
  };

  const acquired = await repository.acquireMetaLease("desktop-publisher-lock-v1", lease, new Date("2026-07-21T12:00:00.000Z"));
  assert.deepEqual(acquired, lease);
  assert.match(calls[0].sql, /ON CONFLICT\(key\)/);
  assert.match(calls[0].sql, /leaseUntil/);
  assert.deepEqual(calls[0].params, ["desktop-publisher-lock-v1", JSON.stringify(lease), "2026-07-21T12:00:00.000Z"]);

  const renewed = await repository.renewMetaLease("desktop-publisher-lock-v1", "lease-1", "2026-07-21T12:40:00.000Z");
  assert.equal(renewed.leaseUntil, "2026-07-21T12:40:00.000Z");
  assert.match(calls[1].sql, /UPDATE distribution_meta/);
  assert.match(calls[1].sql, /value->>'leaseId'=\$2/);
  assert.deepEqual(calls[1].params, ["desktop-publisher-lock-v1", "lease-1", "2026-07-21T12:40:00.000Z"]);

  assert.equal(await repository.releaseMetaLease("desktop-publisher-lock-v1", "lease-1"), true);
  assert.match(calls[2].sql, /value->>'leaseId'=\$2/);
  assert.deepEqual(calls[2].params, ["desktop-publisher-lock-v1", "lease-1"]);
});
