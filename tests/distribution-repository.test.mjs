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
        error: params[5],
        delivered_at: params[6],
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
    deliveredAt: "2026-07-15T15:40:00.000Z"
  });

  assert.match(captured.sql, /target_message_ids/);
  assert.equal(captured.params[4], "[521,522]");
  assert.deepEqual(delivery.targetMessageIds, [521, 522]);
});
