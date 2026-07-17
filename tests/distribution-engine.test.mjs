import assert from "node:assert/strict";
import test from "node:test";
import { DistributionEngine, MemoryDistributionRepository } from "../lib/distribution-engine.mjs";

function messageUpdate(overrides = {}) {
  return {
    update_id: 9001,
    message: {
      message_id: 77,
      message_thread_id: 12,
      date: 1784016000,
      chat: { id: -1001, title: "Source", type: "supergroup" },
      from: { id: 42, is_bot: false },
      text: "hello",
      ...overrides
    }
  };
}

function broadcastRule(overrides = {}) {
  return {
    id: "rule-1",
    kind: "broadcast",
    name: "Source to targets",
    enabled: true,
    mode: "automatic",
    source: { chatId: "-1001", threadId: 12 },
    targets: [
      { id: "target-a", chatId: "-2001", threadId: 21 },
      { id: "target-b", chatId: "-2002", threadId: 22 }
    ],
    ...overrides
  };
}

test("a duplicate webhook update is accepted only once and fans out to every target", async () => {
  const repository = new MemoryDistributionRepository({ rules: [broadcastRule()] });
  const calls = [];
  const telegram = async (method, payload) => {
    calls.push({ method, payload });
    return { message_id: 500 + calls.length };
  };
  const engine = new DistributionEngine({ repository, telegram, forwardBotId: "999" });

  const first = await engine.receiveUpdate(messageUpdate());
  const duplicate = await engine.receiveUpdate(messageUpdate());

  assert.equal(first.status, "processed");
  assert.equal(duplicate.status, "duplicate");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((item) => item.payload.chat_id), ["-2001", "-2002"]);
  assert.equal((await repository.listDeliveries()).length, 2);
});

test("a delivery target filter keeps broadcast tests inside the approved DEMO group", async () => {
  const repository = new MemoryDistributionRepository({ rules: [broadcastRule()] });
  const calls = [];
  const engine = new DistributionEngine({
    repository,
    telegram: async (method, payload) => {
      calls.push({ method, payload });
      return { message_id: 700 + calls.length };
    },
    targetFilter: (target) => String(target.chatId) === "-2001",
  });

  await engine.receiveUpdate(messageUpdate());

  assert.deepEqual(calls.map((item) => item.payload.chat_id), ["-2001"]);
  assert.deepEqual((await repository.listDeliveries()).map((item) => item.target.chatId), ["-2001"]);
});

test("a broadcast webhook reuses an existing automatic-publishing mapping instead of sending a duplicate", async () => {
  const rule = broadcastRule({ targets: [{ id: "target-a", chatId: "-2001", threadId: 21 }] });
  const repository = new MemoryDistributionRepository({
    rules: [rule],
    mappings: [{
      ruleId: rule.id,
      sourceChatId: "-1001",
      sourceMessageId: 77,
      targetChatId: "-2001",
      targetThreadId: 21,
      targetMessageId: 501
    }]
  });
  const calls = [];
  const engine = new DistributionEngine({ repository, telegram: async (...args) => calls.push(args) });

  const result = await engine.receiveUpdate(messageUpdate());
  const [delivery] = await repository.listDeliveries();

  assert.equal(result.status, "processed");
  assert.equal(calls.length, 0);
  assert.equal(delivery.status, "success");
  assert.equal(delivery.targetMessageId, 501);
  assert.equal(delivery.attempts, 0);
});

test("a webhook update that crashes before processing can be retried", async () => {
  const repository = new MemoryDistributionRepository({ rules: [broadcastRule()] });
  const originalListRules = repository.listRules.bind(repository);
  let failOnce = true;
  repository.listRules = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("temporary database failure");
    }
    return originalListRules(...args);
  };
  const calls = [];
  const engine = new DistributionEngine({
    repository,
    telegram: async (method, payload) => {
      calls.push({ method, payload });
      return { message_id: 500 + calls.length };
    }
  });

  await assert.rejects(engine.receiveUpdate(messageUpdate()), /temporary database failure/);
  const retry = await engine.receiveUpdate(messageUpdate());

  assert.equal(retry.status, "processed");
  assert.equal(calls.length, 2);
});

test("topic-specific rules ignore messages from another thread", async () => {
  const repository = new MemoryDistributionRepository({ rules: [broadcastRule()] });
  const calls = [];
  const engine = new DistributionEngine({ repository, telegram: async (...args) => calls.push(args) });

  const result = await engine.receiveUpdate(messageUpdate({ message_thread_id: 99 }));

  assert.equal(result.status, "ignored");
  assert.equal(calls.length, 0);
});

test("review mode never sends before approval and concurrent approval is idempotent", async () => {
  const repository = new MemoryDistributionRepository({ rules: [broadcastRule({ mode: "review" })] });
  const calls = [];
  const engine = new DistributionEngine({
    repository,
    telegram: async (method, payload) => {
      calls.push({ method, payload });
      return { message_id: 800 + calls.length };
    }
  });

  const received = await engine.receiveUpdate(messageUpdate());
  assert.equal(received.status, "pending-review");
  assert.equal(calls.length, 0);

  const queue = await repository.listReviewQueue();
  await Promise.all([engine.approve(queue[0].id), engine.approve(queue[0].id)]);
  assert.equal(calls.length, 2, "two targets are delivered exactly once");
});

test("one target failure does not block the other target and can be retried precisely", async () => {
  const repository = new MemoryDistributionRepository({ rules: [broadcastRule()] });
  let failTarget = true;
  const telegram = async (_method, payload) => {
    if (payload.chat_id === "-2001" && failTarget) throw new Error("Forbidden");
    return { message_id: payload.chat_id === "-2001" ? 501 : 502 };
  };
  const engine = new DistributionEngine({ repository, telegram });

  await engine.receiveUpdate(messageUpdate());
  let deliveries = await repository.listDeliveries();
  assert.deepEqual(deliveries.map((item) => item.status).sort(), ["failed", "success"]);

  failTarget = false;
  const failed = deliveries.find((item) => item.status === "failed");
  await engine.retryDelivery(failed.id);
  deliveries = await repository.listDeliveries();
  assert.equal(deliveries.find((item) => item.id === failed.id).status, "success");
  assert.equal(deliveries.find((item) => item.id !== failed.id).attempts, 1);
});

test("concurrent retries claim a failed target only once", async () => {
  const repository = new MemoryDistributionRepository({ rules: [broadcastRule({ targets: [{ id: "target-a", chatId: "-2001", threadId: 21 }] })] });
  let shouldFail = true;
  let calls = 0;
  const engine = new DistributionEngine({
    repository,
    telegram: async () => {
      calls += 1;
      if (shouldFail) throw new Error("temporary failure");
      return { message_id: 501 };
    }
  });

  await engine.receiveUpdate(messageUpdate());
  const [failed] = await repository.listDeliveries();
  shouldFail = false;
  await Promise.all([engine.retryDelivery(failed.id), engine.retryDelivery(failed.id)]);

  assert.equal(calls, 2, "one initial attempt and one claimed retry");
  assert.equal((await repository.getDelivery(failed.id)).status, "success");
});

test("whole-group rules accept any topic while service messages and bot loops are ignored", async () => {
  const repository = new MemoryDistributionRepository({
    rules: [broadcastRule({ source: { chatId: "-1001", threadId: null }, targets: [{ id: "target-a", chatId: "-2001", threadId: 21 }] })]
  });
  const calls = [];
  const engine = new DistributionEngine({ repository, forwardBotId: "999", telegram: async (...args) => calls.push(args) });

  const wholeGroup = await engine.receiveUpdate(messageUpdate({ message_thread_id: 99 }));
  const system = await engine.receiveUpdate({ ...messageUpdate({ message_id: 78, text: undefined, new_chat_members: [{ id: 7 }] }), update_id: 9002 });
  const loop = await engine.receiveUpdate({ ...messageUpdate({ message_id: 79, from: { id: 999, is_bot: true } }), update_id: 9003 });

  assert.equal(wholeGroup.status, "processed");
  assert.deepEqual(system, { status: "ignored", reason: "unsupported-message" });
  assert.deepEqual(loop, { status: "ignored", reason: "forward-loop" });
  assert.equal(calls.length, 1);
});

test("reply and edit updates use per-target message mappings", async () => {
  const repository = new MemoryDistributionRepository({ rules: [broadcastRule({ targets: [{ id: "target-a", chatId: "-2001", threadId: 21 }] })] });
  const calls = [];
  const engine = new DistributionEngine({
    repository,
    telegram: async (method, payload) => {
      calls.push({ method, payload });
      return { message_id: calls.length === 1 ? 501 : 502 };
    }
  });

  await engine.receiveUpdate(messageUpdate());
  await engine.receiveUpdate({ ...messageUpdate({ message_id: 78, reply_to_message: { message_id: 77 }, text: "reply" }), update_id: 9002 });
  await engine.receiveUpdate({ update_id: 9003, edited_message: messageUpdate({ message_id: 77, text: "edited" }).message });

  assert.deepEqual(calls[1].payload.reply_parameters, { message_id: 501 });
  assert.equal(calls[2].method, "editMessageText");
  assert.equal(calls[2].payload.message_id, 501);
  assert.equal(calls[2].payload.text, "edited");
});

test("a Telegram media group is copied once as an album and maps every message", async () => {
  const repository = new MemoryDistributionRepository({ rules: [broadcastRule({ targets: [{ id: "target-a", chatId: "-2001", threadId: 21 }] })] });
  const calls = [];
  const engine = new DistributionEngine({
    repository,
    mediaGroupDelayMs: 5,
    telegram: async (method, payload) => {
      calls.push({ method, payload });
      return [{ message_id: 601 }, { message_id: 602 }];
    }
  });

  await Promise.all([
    engine.receiveUpdate(messageUpdate({ message_id: 77, media_group_id: "album-1", photo: [{ file_id: "a" }], text: undefined })),
    engine.receiveUpdate({ ...messageUpdate({ message_id: 78, media_group_id: "album-1", photo: [{ file_id: "b" }], text: undefined }), update_id: 9002 })
  ]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "copyMessages");
  assert.deepEqual(calls[0].payload.message_ids, [77, 78]);
  const mapping = await repository.findMapping({ ruleId: "rule-1", sourceChatId: "-1001", sourceMessageId: 78, targetChatId: "-2001", targetThreadId: 21 });
  assert.equal(mapping.targetMessageId, 602);
});
