import assert from "node:assert/strict";
import test from "node:test";

import { PostgresDistributionRepository } from "../lib/distribution-repository.mjs";

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
    targets: [{ chatId: "-1001", threadId: 8 }],
  });

  assert.match(calls[0].sql, /run_once/);
  assert.equal(calls[0].params[8], true);

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
        error: params[6],
        delivered_at: params[7],
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
    deliveredAt: "2026-07-15T15:40:00.000Z"
  });

  assert.match(captured.sql, /target_message_ids/);
  assert.match(captured.sql, /publisher_progress/);
  assert.equal(captured.params[4], "[521,522]");
  assert.equal(captured.params[5], '[{"stepId":"1-photo-a1","checksum":"a1","targetMessageId":521}]');
  assert.deepEqual(delivery.targetMessageIds, [521, 522]);
  assert.deepEqual(delivery.publisherProgress, [{ stepId: "1-photo-a1", checksum: "a1", targetMessageId: 521 }]);
});

test("Postgres desktop publisher lease is atomic and only its owner can release it", async () => {
  const repository = Object.create(PostgresDistributionRepository.prototype);
  const calls = [];
  const lease = { leaseId: "lease-1", leaseUntil: "2026-07-21T12:30:00.000Z" };
  repository.sql = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/INSERT INTO distribution_meta/.test(sql)) return [{ value: lease }];
      if (/DELETE FROM distribution_meta/.test(sql)) return [{ key: params[0] }];
      return [];
    }
  };

  const acquired = await repository.acquireMetaLease("desktop-publisher-lock-v1", lease, new Date("2026-07-21T12:00:00.000Z"));
  assert.deepEqual(acquired, lease);
  assert.match(calls[0].sql, /ON CONFLICT\(key\)/);
  assert.match(calls[0].sql, /leaseUntil/);
  assert.deepEqual(calls[0].params, ["desktop-publisher-lock-v1", JSON.stringify(lease), "2026-07-21T12:00:00.000Z"]);

  assert.equal(await repository.releaseMetaLease("desktop-publisher-lock-v1", "lease-1"), true);
  assert.match(calls[1].sql, /value->>'leaseId'=\$2/);
  assert.deepEqual(calls[1].params, ["desktop-publisher-lock-v1", "lease-1"]);
});
