import test from "node:test";
import assert from "node:assert/strict";

import {
  checkDiscordHealth,
  getDiscordConfig,
  getDiscordStatus,
  initializeDiscordGuild,
  refreshDiscordDemoTemplate,
  saveDiscordConfig,
  sendDiscordManualPublish,
  sendDiscordMessage,
} from "../lib/discord-service.mjs";
import { saveDiscordCredentials } from "../lib/discord-credentials.mjs";

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

test("Discord health verifies every initialized channel and applies permission overwrites", async () => {
  const repository = createRepository();
  await saveDiscordConfig({
    guilds: {
      "guild-1": {
        guildId: "guild-1",
        guildName: "Stored Demo",
        channels: [
          {
            templateKey: "discord:source-updates",
            sourceChannelId: "source-updates",
            sourceCategoryId: "source-category",
            channelId: "channel-ok",
            name: "updates",
          },
          { templateId: 2, channelId: "channel-blocked", name: "signals" },
        ],
      },
    },
  }, { repository });

  const result = await checkDiscordHealth({
    repository,
    token: "secret-token",
    fetchImpl: async (url) => {
      const path = String(url).replace("https://discord.com/api/v10", "");
      if (path === "/users/@me") return jsonResponse(200, { id: "bot-1", username: "Academy" });
      if (path === "/users/@me/guilds") return jsonResponse(200, [{ id: "guild-1", name: "Live Demo" }]);
      if (path === "/guilds/guild-1") return jsonResponse(200, { id: "guild-1", name: "Live Demo" });
      if (path === "/guilds/guild-1/channels") return jsonResponse(200, [
        { id: "channel-ok", name: "updates", type: 0, permission_overwrites: [] },
        { id: "channel-blocked", name: "signals", type: 0, permission_overwrites: [
          { id: "guild-1", type: 0, allow: "0", deny: "2048" },
        ] },
      ]);
      if (path === "/guilds/guild-1/roles") return jsonResponse(200, [
        { id: "guild-1", permissions: "52224" },
      ]);
      if (path === "/guilds/guild-1/members/bot-1") return jsonResponse(200, { roles: [] });
      return jsonResponse(404, { message: "Not found" });
    },
  });

  assert.equal(result.summary.totalChannels, 2);
  assert.equal(result.summary.sendableChannels, 1);
  assert.equal(result.summary.blockedChannels, 1);
  assert.equal(result.guilds[0].guildName, "Live Demo");
  assert.equal(result.guilds[0].channels[0].canSend, true);
  assert.equal(result.guilds[0].channels[0].templateKey, "discord:source-updates");
  assert.equal(result.guilds[0].channels[0].sourceChannelId, "source-updates");
  assert.equal("templateId" in result.guilds[0].channels[0], false);
  assert.equal(result.guilds[0].channels[1].canSend, false);
});

test("Discord health discovers newly joined Servers and their live channels before initialization", async () => {
  const repository = createRepository();
  await saveDiscordConfig({
    guilds: {
      "guild-1": { guildId: "guild-1", guildName: "Stored One", channels: [] },
    },
  }, { repository });

  const fetchImpl = async (url) => {
    const path = String(url).replace("https://discord.com/api/v10", "");
    if (path === "/users/@me") return jsonResponse(200, { id: "bot-1", username: "Academy" });
    if (path === "/users/@me/guilds") return jsonResponse(200, [
      { id: "guild-1", name: "Live One" },
      { id: "guild-2", name: "Newly Joined" },
    ]);
    if (path === "/guilds/guild-1") return jsonResponse(200, { id: "guild-1", name: "Live One" });
    if (path === "/guilds/guild-2") return jsonResponse(200, { id: "guild-2", name: "Newly Joined" });
    if (path === "/guilds/guild-1/channels") return jsonResponse(200, [
      { id: "one-general", name: "general", type: 0, permission_overwrites: [] },
    ]);
    if (path === "/guilds/guild-2/channels") return jsonResponse(200, [
      { id: "two-trades", name: "trade-setups", type: 0, permission_overwrites: [] },
      { id: "two-voice", name: "voice", type: 2, permission_overwrites: [] },
    ]);
    if (path.endsWith("/roles")) return jsonResponse(200, [
      { id: path.split("/")[2], permissions: "52224" },
    ]);
    if (path.endsWith("/members/bot-1")) return jsonResponse(200, { roles: [] });
    return jsonResponse(404, { message: "Not found" });
  };

  const result = await checkDiscordHealth({ repository, token: "secret", fetchImpl });

  assert.deepEqual(result.guilds.map((guild) => guild.guildName), ["Live One", "Newly Joined"]);
  assert.deepEqual(result.guilds[1].channels.map((channel) => channel.name), ["trade-setups"]);
  assert.equal(result.guilds[1].channels[0].canSend, true);
});

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

test("Discord Demo refresh reads TheMoonShow channels and initial content", async () => {
  const repository = createRepository();
  const calls = [];
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    calls.push(pathname);
    if (pathname.endsWith("/users/@me/guilds")) return jsonResponse(200, [
      { id: "other", name: "Other Server" },
      { id: "moon", name: "TheMoonShow VIP Community" },
    ]);
    if (pathname.endsWith("/guilds/moon")) {
      return jsonResponse(200, { id: "moon", name: "TheMoonShow VIP Community" });
    }
    if (pathname.endsWith("/guilds/moon/channels")) return jsonResponse(200, [
      { id: "cat", name: "VIP", type: 4, position: 1 },
      { id: "trade", name: "trade-setups", type: 0, parent_id: "cat", position: 2 },
      { id: "voice", name: "lounge", type: 2, parent_id: "cat", position: 3 },
    ]);
    if (pathname.endsWith("/channels/trade/messages")) return jsonResponse(200, [
      { id: "m2", content: "Second", timestamp: "2026-08-14T02:00:00.000Z", attachments: [] },
      { id: "m1", content: "First", timestamp: "2026-08-14T01:00:00.000Z", attachments: [{ url: "https://cdn.example/chart.png" }] },
    ]);
    throw new Error(`Unexpected Discord request: ${pathname}`);
  };

  const result = await refreshDiscordDemoTemplate({
    repository,
    token: "secret",
    fetchImpl,
    now: new Date("2026-08-14T03:00:00.000Z"),
  });

  assert.equal(result.guildId, "moon");
  assert.deepEqual(result.channels.map((channel) => channel.name), ["trade-setups"]);
  assert.deepEqual(result.channels[0].messages.map((message) => message.sourceMessageId), ["m1", "m2"]);
  assert.equal(calls.includes("/channels/voice/messages"), false);
  const config = await getDiscordConfig({ repository });
  assert.equal(config.demoGuildId, "moon");
  assert.equal(config.demoTemplate.guildName, "TheMoonShow VIP Community");
  assert.equal(config.guilds.moon.channels[0].templateKey, "discord:trade");
});

test("Discord Demo refresh uses the Server explicitly selected by the operator", async () => {
  const repository = createRepository();
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/users/@me/guilds")) return jsonResponse(200, [
      { id: "moon", name: "TheMoonShow VIP Community" },
      { id: "custom", name: "Custom Demo" },
    ]);
    if (pathname.endsWith("/guilds/custom")) return jsonResponse(200, { id: "custom", name: "Custom Demo" });
    if (pathname.endsWith("/guilds/custom/channels")) return jsonResponse(200, [
      { id: "custom-news", name: "market-news", type: 0, position: 1 },
    ]);
    if (pathname.endsWith("/channels/custom-news/messages")) return jsonResponse(200, []);
    throw new Error(`Unexpected Discord request: ${pathname}`);
  };

  const result = await refreshDiscordDemoTemplate({
    guildId: "custom",
    repository,
    token: "secret",
    fetchImpl,
  });

  assert.equal(result.guildId, "custom");
  assert.equal(result.guildName, "Custom Demo");
  assert.equal((await getDiscordConfig({ repository })).demoGuildId, "custom");
});

test("Discord Demo refresh keeps channels whose message history is inaccessible", async () => {
  const repository = createRepository();
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/users/@me/guilds")) return jsonResponse(200, [
      { id: "moon", name: "TheMoonShow VIP Community" },
    ]);
    if (pathname.endsWith("/guilds/moon")) {
      return jsonResponse(200, { id: "moon", name: "TheMoonShow VIP Community" });
    }
    if (pathname.endsWith("/guilds/moon/channels")) return jsonResponse(200, [
      { id: "cat", name: "VIP", type: 4, position: 1 },
      { id: "public", name: "market-insights", type: 0, parent_id: "cat", position: 2 },
      { id: "private", name: "private-desk", type: 0, parent_id: "cat", position: 3 },
    ]);
    if (pathname.endsWith("/channels/public/messages")) return jsonResponse(200, [
      { id: "m1", content: "Market update", timestamp: "2026-08-14T01:00:00.000Z", attachments: [] },
    ]);
    if (pathname.endsWith("/channels/private/messages")) {
      return jsonResponse(403, { message: "Missing Access" });
    }
    throw new Error(`Unexpected Discord request: ${pathname}`);
  };

  const result = await refreshDiscordDemoTemplate({
    repository,
    token: "secret",
    fetchImpl,
    now: new Date("2026-08-14T03:00:00.000Z"),
  });

  assert.deepEqual(result.channels.map((channel) => channel.name), ["market-insights", "private-desk"]);
  assert.equal(result.channels[0].contentReadStatus, "ok");
  assert.equal(result.channels[0].messages.length, 1);
  assert.equal(result.channels[1].contentReadStatus, "unavailable");
  assert.deepEqual(result.channels[1].messages, []);
  assert.equal(result.unavailableContentChannelCount, 1);
});

test("dynamic Discord initialization mirrors Demo structure and seeds content only once", async () => {
  const repository = createRepository();
  await saveDiscordConfig({
    demoGuildId: "moon",
    demoTemplate: {
      guildId: "moon",
      guildName: "TheMoonShow VIP Community",
      capturedAt: "2026-08-14T03:00:00.000Z",
      categories: [{ templateKey: "category:cat", sourceCategoryId: "cat", name: "VIP", position: 1 }],
      channels: [{
        templateKey: "discord:trade",
        sourceChannelId: "trade",
        sourceCategoryId: "cat",
        name: "trade-setups",
        type: 0,
        position: 2,
        topic: "Trade ideas",
        nsfw: false,
        rateLimitPerUser: 0,
        messages: [
          { sourceMessageId: "m1", content: "First", attachmentUrls: ["https://cdn.example/chart.png"], embeds: [], createdAt: "2026-08-14T01:00:00.000Z" },
          { sourceMessageId: "m2", content: "Second", attachmentUrls: [], embeds: [], createdAt: "2026-08-14T02:00:00.000Z" },
        ],
      }],
    },
    guilds: {
      moon: {
        guildId: "moon",
        guildName: "TheMoonShow VIP Community",
        channels: [{ templateKey: "discord:trade", sourceChannelId: "trade", sourceCategoryId: "cat", channelId: "trade", name: "trade-setups" }],
      },
    },
  }, { repository });

  const liveChannels = [];
  const mutations = [];
  let nextId = 1;
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/guilds/target") && !pathname.endsWith("/channels")) {
      return jsonResponse(200, { id: "target", name: "Partner Server" });
    }
    if (pathname.endsWith("/guilds/target/channels") && !options.method) {
      return jsonResponse(200, liveChannels);
    }
    if (pathname.endsWith("/guilds/target/channels") && options.method === "POST") {
      const body = JSON.parse(options.body);
      const created = { id: `new-${nextId++}`, ...body, parent_id: body.parent_id ?? null };
      liveChannels.push(created);
      mutations.push({ kind: "channel", body });
      return jsonResponse(201, created);
    }
    if (pathname.endsWith("/channels/new-2/messages") && options.method === "POST") {
      const body = JSON.parse(options.body);
      mutations.push({ kind: "message", body });
      return jsonResponse(201, { id: `sent-${mutations.length}` });
    }
    throw new Error(`Unexpected Discord request: ${pathname}`);
  };

  await initializeDiscordGuild(
    { guildId: "target", selectedTemplateKeys: ["discord:trade"] },
    { token: "secret", repository, fetchImpl },
  );
  await initializeDiscordGuild(
    { guildId: "target", selectedTemplateKeys: ["discord:trade"] },
    { token: "secret", repository, fetchImpl },
  );

  assert.equal(mutations.filter((item) => item.kind === "channel").length, 2);
  assert.equal(mutations.filter((item) => item.kind === "message").length, 2);
  assert.deepEqual(mutations.filter((item) => item.kind === "message").map((item) => item.body.content), [
    "First\nhttps://cdn.example/chart.png",
    "Second",
  ]);
  const target = (await getDiscordConfig({ repository })).guilds.target;
  assert.deepEqual(target.channels[0].seededSourceMessageIds, ["m1", "m2"]);
});

test("Discord service reports an actionable missing-token status", async () => {
  const result = await getDiscordStatus({
    token: "",
    appId: "app-1",
    repository: createRepository(),
  });
  assert.equal(result.configured, false);
  assert.equal(result.connected, false);
  assert.match(result.error, /credentials are not configured/i);
});

test("Discord service uses encrypted credentials saved from the backend", async () => {
  const repository = createRepository();
  const encryptionKey = "11".repeat(32);
  await saveDiscordCredentials(
    {
      appId: "111111111111111111",
      publicKey: "a".repeat(64),
      botToken: "stored-secret-token",
    },
    { repository, encryptionKey },
  );

  const result = await getDiscordStatus({
    repository,
    encryptionKey,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/users/@me")) {
        return jsonResponse(200, { id: "bot-1", username: "Academy" });
      }
      return jsonResponse(200, []);
    },
  });

  assert.equal(result.configured, true);
  assert.equal(result.connected, true);
  assert.equal(result.credentials.tokenConfigured, true);
  assert.equal(JSON.stringify(result).includes("stored-secret-token"), false);
});

test("Discord message delivery supports text and image embeds", async () => {
  let request;
  const result = await sendDiscordMessage(
    "channel-3",
    {
      content: "Daily market update",
      imageUrl: "https://cdn.example.com/market.png",
    },
    {
      token: "secret",
      fetchImpl: async (url, options) => {
        request = { url: String(url), options };
        return jsonResponse(200, { id: "message-1", channel_id: "channel-3" });
      },
    },
  );

  assert.equal(result.id, "message-1");
  assert.equal(request.url.endsWith("/channels/channel-3/messages"), true);
  assert.deepEqual(JSON.parse(request.options.body), {
    content: "Daily market update",
    embeds: [{ image: { url: "https://cdn.example.com/market.png" } }],
    allowed_mentions: { parse: [] },
  });
});

test("Discord manual publish deduplicates targets and isolates per-target failures", async () => {
  const repository = createRepository();
  await saveDiscordConfig(
    {
      guilds: {
        "guild-1": {
          guildId: "guild-1",
          guildName: "Demo",
      channels: [
        { templateId: 1, channelId: "channel-ok", name: "updates" },
        { templateId: 2, channelId: "channel-fail", name: "signals" },
          ],
        },
      },
    },
    { repository },
  );
  const requests = [];
  const result = await sendDiscordManualPublish(
    {
      channelIds: ["channel-ok", "channel-fail", "channel-ok", ""],
      content: "Manual update",
      imageUrl: "https://cdn.example.com/manual.png",
    },
    {
      token: "manual-secret-token",
      repository,
      fetchImpl: async (url) => {
        const channelId = String(url).match(/channels\/([^/]+)\/messages/)?.[1];
        if (channelId) requests.push(channelId);
        if (channelId === "channel-fail") {
          throw new Error("Missing Access manual-secret-token");
        }
        return jsonResponse(200, { id: `message-${channelId}`, channel_id: channelId });
      },
    },
  );

  assert.deepEqual(requests, ["channel-ok", "channel-fail"]);
  assert.equal(result.attempted, 2);
  assert.equal(result.delivered, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.results[0], {
    ok: true,
    channelId: "channel-ok",
    messageId: "message-channel-ok",
  });
  assert.equal(result.results[1].channelId, "channel-fail");
  assert.equal(result.results[1].ok, false);
  assert.match(result.results[1].error, /Missing Access/);
  assert.doesNotMatch(result.results[1].error, /manual-secret-token/);
});

test("Discord manual publish rejects channels outside initialized destinations", async () => {
  const repository = createRepository();
  await saveDiscordConfig(
    {
      guilds: {
        "guild-1": {
          guildId: "guild-1",
          guildName: "Demo",
      channels: [{ templateId: 1, channelId: "channel-allowed", name: "updates" }],
        },
      },
    },
    { repository },
  );
  const requests = [];

  const result = await sendDiscordManualPublish(
    {
      channelIds: ["channel-allowed", "channel-unknown"],
      content: "Manual update",
    },
    {
      token: "manual-secret-token",
      repository,
      fetchImpl: async (url) => {
        const channelId = String(url).match(/channels\/([^/]+)\/messages/)?.[1];
        if (channelId) requests.push(channelId);
        return jsonResponse(200, { id: `message-${channelId}`, channel_id: channelId });
      },
    },
  );

  assert.deepEqual(requests, ["channel-allowed"]);
  assert.equal(result.attempted, 2);
  assert.equal(result.delivered, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.results[1], {
    ok: false,
    channelId: "channel-unknown",
    error: "Discord channel is not an initialized destination.",
  });
});

test("Discord manual publish accepts a newly discovered channel when live permissions allow sending", async () => {
  const repository = createRepository();
  const requests = [];
  const result = await sendDiscordManualPublish(
    {
      channelIds: ["channel-live"],
      content: "Live destination update",
    },
    {
      token: "manual-secret-token",
      repository,
      fetchImpl: async (url) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname.endsWith("/users/@me")) return jsonResponse(200, { id: "bot-1" });
        if (pathname.endsWith("/users/@me/guilds")) return jsonResponse(200, [{ id: "guild-live", name: "New Server" }]);
        if (pathname.endsWith("/guilds/guild-live")) return jsonResponse(200, { id: "guild-live", name: "New Server", owner_id: "owner-1" });
        if (pathname.endsWith("/guilds/guild-live/channels")) return jsonResponse(200, [{ id: "channel-live", name: "updates", type: 0, position: 1, permission_overwrites: [] }]);
        if (pathname.endsWith("/guilds/guild-live/roles")) return jsonResponse(200, [{ id: "guild-live", permissions: String((1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 15n)) }]);
        if (pathname.endsWith("/guilds/guild-live/members/bot-1")) return jsonResponse(200, { roles: [] });
        if (pathname.endsWith("/channels/channel-live/messages")) {
          requests.push("channel-live");
          return jsonResponse(200, { id: "message-live", channel_id: "channel-live" });
        }
        return jsonResponse(404, { message: "not found" });
      },
    },
  );

  assert.deepEqual(requests, ["channel-live"]);
  assert.equal(result.delivered, 1);
  assert.equal(result.results[0].messageId, "message-live");
});
