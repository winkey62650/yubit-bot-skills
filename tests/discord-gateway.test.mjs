import assert from "node:assert/strict";
import test from "node:test";

import {
  relayDiscordMessage,
  writeDiscordGatewayHeartbeat,
} from "../lib/discord-gateway.mjs";

function createRepository(initialConfig = {}) {
  const state = new Map([
    ["discord:config", initialConfig],
    ["discord:gateway", {}],
  ]);

  return {
    async getMeta(key) {
      return state.has(key) ? structuredClone(state.get(key)) : null;
    },
    async setMeta(key, value) {
      state.set(key, structuredClone(value));
      return value;
    },
    read(key) {
      return state.get(key);
    },
  };
}

const configured = {
  version: 1,
  demoGuildId: "demo",
  syncEnabled: true,
  guilds: {
    demo: {
      guildId: "demo",
      guildName: "Demo",
      categoryId: "category-demo",
      initializedAt: "2026-07-24T00:00:00.000Z",
      channels: [{ templateId: 3, channelId: "source-3", name: "3-market-events" }],
    },
    "target-a": {
      guildId: "target-a",
      guildName: "Target A",
      categoryId: "category-target-a",
      initializedAt: "2026-07-24T00:00:00.000Z",
      channels: [{ templateId: 3, channelId: "target-a-3", name: "3-market-events" }],
    },
    "target-b": {
      guildId: "target-b",
      guildName: "Target B",
      categoryId: "category-target-b",
      initializedAt: "2026-07-24T00:00:00.000Z",
      channels: [{ templateId: 3, channelId: "target-b-3", name: "3-market-events" }],
    },
  },
};

test("relays a Demo message to every matching initialized target", async () => {
  const repository = createRepository(configured);
  const sent = [];
  const client = {
    user: { id: "bot-1" },
    guilds: { cache: { size: 3 } },
    channels: {
      async fetch(channelId) {
        return {
          async send(payload) {
            sent.push({ channelId, payload });
            return { id: `sent-${channelId}` };
          },
        };
      },
    },
  };

  const result = await relayDiscordMessage(
    {
      guildId: "demo",
      channelId: "source-3",
      content: "Market brief",
      author: { bot: false },
      webhookId: null,
      attachments: new Map([
        ["a", { url: "https://cdn.discordapp.com/file.png" }],
      ]),
    },
    { repository, client, now: new Date("2026-07-24T01:00:00.000Z") },
  );

  assert.equal(result.matched, 2);
  assert.equal(result.delivered, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(sent.map((item) => item.channelId), ["target-a-3", "target-b-3"]);
  assert.equal(sent[0].payload.content, "Market brief");
  assert.deepEqual(sent[0].payload.files, ["https://cdn.discordapp.com/file.png"]);
  assert.equal(
    repository.read("discord:gateway").lastDeliveryAt,
    "2026-07-24T01:00:00.000Z",
  );
});

test("isolates a failed target and records a sanitized error", async () => {
  const repository = createRepository(configured);
  const client = {
    user: { id: "bot-1" },
    guilds: { cache: { size: 3 } },
    channels: {
      async fetch(channelId) {
        return {
          async send() {
            if (channelId === "target-a-3") {
              throw new Error("Missing Access for token super-secret");
            }
            return { id: "ok" };
          },
        };
      },
    },
  };

  const result = await relayDiscordMessage(
    {
      guildId: "demo",
      channelId: "source-3",
      content: "Market brief",
      author: { bot: false },
      webhookId: null,
      attachments: new Map(),
    },
    {
      repository,
      client,
      token: "super-secret",
      now: new Date("2026-07-24T01:01:00.000Z"),
    },
  );

  assert.equal(result.delivered, 1);
  assert.equal(result.failed, 1);
  const storedError = repository.read("discord:gateway").lastError;
  assert.match(storedError, /Missing Access/);
  assert.doesNotMatch(storedError, /super-secret/);
});

test("does not relay messages from bots or webhooks", async () => {
  const repository = createRepository(configured);
  let sends = 0;
  const client = {
    channels: {
      async fetch() {
        return { async send() { sends += 1; } };
      },
    },
  };

  for (const message of [
    { author: { bot: true }, webhookId: null },
    { author: { bot: false }, webhookId: "webhook-1" },
  ]) {
    const result = await relayDiscordMessage(
      {
        guildId: "demo",
        channelId: "source-3",
        content: "ignored",
        attachments: new Map(),
        ...message,
      },
      { repository, client },
    );
    assert.equal(result.matched, 0);
  }

  assert.equal(sends, 0);
});

test("heartbeat records the connected bot without exposing credentials", async () => {
  const repository = createRepository(configured);
  const status = await writeDiscordGatewayHeartbeat(
    {
      user: { id: "bot-1", username: "Academy" },
      guilds: { cache: { size: 2 } },
    },
    {
      repository,
      token: "super-secret",
      now: new Date("2026-07-24T01:02:00.000Z"),
    },
  );

  assert.equal(status.state, "ready");
  assert.equal(status.botId, "bot-1");
  assert.equal(status.guildCount, 2);
  assert.equal(status.lastHeartbeatAt, "2026-07-24T01:02:00.000Z");
  assert.doesNotMatch(JSON.stringify(repository.read("discord:gateway")), /super-secret/);
});

test("heartbeat preserves an explicit runtime state and sanitizes its error", async () => {
  const repository = createRepository(configured);
  const status = await writeDiscordGatewayHeartbeat(
    { user: { id: "bot-1", username: "Academy" }, guilds: { cache: { size: 2 } } },
    {
      repository,
      token: "super-secret",
      state: "error",
      lastError: new Error("Gateway rejected super-secret"),
      now: new Date("2026-07-24T01:03:00.000Z"),
    },
  );

  assert.equal(status.state, "error");
  assert.match(status.lastError, /Gateway rejected/);
  assert.doesNotMatch(status.lastError, /super-secret/);
});
