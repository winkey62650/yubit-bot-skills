import test from "node:test";
import assert from "node:assert/strict";

import {
  getDiscordConfig,
  getDiscordStatus,
  initializeDiscordGuild,
  saveDiscordConfig,
} from "../lib/discord-service.mjs";

function createRepository() {
  const meta = new Map();
  return {
    async getMeta(key) {
      return meta.get(key) ?? null;
    },
    async setMeta(key, value) {
      meta.set(key, structuredClone(value));
      return value;
    },
  };
}

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Discord status verifies the bot and lists guilds without exposing the token", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/users/@me")) {
      return jsonResponse(200, {
        id: "bot-1",
        username: "Academy",
        discriminator: "0",
      });
    }
    return jsonResponse(200, [
      { id: "guild-2", name: "Target", owner: false, permissions: "0" },
      { id: "guild-1", name: "Demo", owner: false, permissions: "0" },
    ]);
  };

  const result = await getDiscordStatus({
    token: "secret-token",
    appId: "app-1",
    fetchImpl,
  });

  assert.equal(result.configured, true);
  assert.equal(result.connected, true);
  assert.equal(result.bot.username, "Academy");
  assert.deepEqual(
    result.guilds.map((guild) => guild.id),
    ["guild-1", "guild-2"],
  );
  assert.match(result.installUrl, /client_id=app-1/);
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
  assert.equal(
    requests.every(
      ({ options }) => options.headers.Authorization === "Bot secret-token",
    ),
    true,
  );
});

test("Discord config is persisted and normalized through repository meta", async () => {
  const repository = createRepository();
  const saved = await saveDiscordConfig(
    {
      demoGuildId: "demo",
      syncEnabled: true,
      guilds: {
        demo: {
          guildId: "demo",
          guildName: "Demo",
          categoryId: "cat-1",
          channels: [
            {
              templateId: 1,
              channelId: "channel-1",
              name: "1-read-first-disclaimer",
            },
          ],
        },
      },
      routes: [],
    },
    { repository },
  );

  assert.equal(saved.demoGuildId, "demo");
  assert.equal(saved.syncEnabled, true);
  assert.equal((await getDiscordConfig({ repository })).guilds.demo.guildName, "Demo");
});

test("Discord guild initialization supports dry-run without mutations", async () => {
  const repository = createRepository();
  const calls = [];
  const result = await initializeDiscordGuild(
    {
      guildId: "guild-1",
      selectedTemplateIds: [1, 3],
      dryRun: true,
    },
    {
      token: "secret",
      repository,
      fetchImpl: async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method ?? "GET" });
        if (String(url).endsWith("/guilds/guild-1")) {
          return jsonResponse(200, { id: "guild-1", name: "Demo" });
        }
        if (String(url).endsWith("/guilds/guild-1/channels")) {
          return jsonResponse(200, []);
        }
        throw new Error("unexpected mutation");
      },
    },
  );

  assert.equal(result.dryRun, true);
  assert.equal(result.plan.category.action, "create");
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET"]);
  assert.deepEqual(await getDiscordConfig({ repository }), {
    demoGuildId: "",
    syncEnabled: false,
    guilds: {},
    routes: [],
  });
});

test("Discord guild initialization creates missing category/channels and is idempotent", async () => {
  const repository = createRepository();
  const channels = [];
  const mutations = [];
  let nextId = 1;
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/guilds/guild-1") && !pathname.endsWith("/channels")) {
      return jsonResponse(200, { id: "guild-1", name: "Demo Server" });
    }
    if (pathname.endsWith("/guilds/guild-1/channels") && !options.method) {
      return jsonResponse(200, channels);
    }
    if (pathname.endsWith("/guilds/guild-1/channels") && options.method === "POST") {
      const body = JSON.parse(options.body);
      const created = {
        id: `created-${nextId++}`,
        parent_id: body.parent_id ?? null,
        ...body,
      };
      channels.push(created);
      mutations.push(created);
      return jsonResponse(201, created);
    }
    throw new Error(`Unexpected Discord request: ${pathname}`);
  };

  const first = await initializeDiscordGuild(
    {
      guildId: "guild-1",
      selectedTemplateIds: [1, 2],
      markAsDemo: true,
    },
    { token: "secret", repository, fetchImpl },
  );
  const second = await initializeDiscordGuild(
    {
      guildId: "guild-1",
      selectedTemplateIds: [1, 2],
      markAsDemo: true,
    },
    { token: "secret", repository, fetchImpl },
  );

  assert.equal(mutations.length, 3);
  assert.equal(first.guild.categoryId, "created-1");
  assert.deepEqual(
    first.guild.channels.map((channel) => channel.channelId),
    ["created-2", "created-3"],
  );
  assert.equal(second.plan.category.action, "reuse");
  assert.equal(second.plan.channels.every((channel) => channel.action === "reuse"), true);
  assert.equal((await getDiscordConfig({ repository })).demoGuildId, "guild-1");
});

test("Discord guild initialization preserves earlier partial channel selections", async () => {
  const repository = createRepository();
  const channels = [];
  let nextId = 1;
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/guilds/guild-1") && !pathname.endsWith("/channels")) {
      return jsonResponse(200, { id: "guild-1", name: "Demo Server" });
    }
    if (pathname.endsWith("/guilds/guild-1/channels") && !options.method) {
      return jsonResponse(200, channels);
    }
    if (pathname.endsWith("/guilds/guild-1/channels") && options.method === "POST") {
      const body = JSON.parse(options.body);
      const created = {
        id: `created-${nextId++}`,
        parent_id: body.parent_id ?? null,
        ...body,
      };
      channels.push(created);
      return jsonResponse(201, created);
    }
    throw new Error(`Unexpected Discord request: ${pathname}`);
  };

  await initializeDiscordGuild(
    { guildId: "guild-1", selectedTemplateIds: [1] },
    { token: "secret", repository, fetchImpl },
  );
  await initializeDiscordGuild(
    { guildId: "guild-1", selectedTemplateIds: [3] },
    { token: "secret", repository, fetchImpl },
  );

  assert.deepEqual(
    (await getDiscordConfig({ repository })).guilds["guild-1"].channels.map(
      (channel) => channel.templateId,
    ),
    [1, 3],
  );
});

test("Discord service reports an actionable missing-token status", async () => {
  const result = await getDiscordStatus({ token: "", appId: "app-1" });
  assert.equal(result.configured, false);
  assert.equal(result.connected, false);
  assert.match(result.error, /DISCORD_BOT_TOKEN/);
});
