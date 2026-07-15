import assert from "node:assert/strict";
import test from "node:test";

import { PostgresDistributionRepository } from "../lib/distribution-repository.mjs";

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
