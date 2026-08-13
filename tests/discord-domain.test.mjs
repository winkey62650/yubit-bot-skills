import test from "node:test";
import assert from "node:assert/strict";

import {
  DISCORD_DEMO_GUILD_NAME,
  DISCORD_REQUIRED_PERMISSIONS,
  buildDiscordDemoSnapshot,
  buildDiscordInstallUrl,
  buildDiscordInitializationPlan,
  buildDiscordRelayPayload,
  findDiscordRoutesForMessage,
  normalizeDiscordConfig,
  normalizeDiscordChannelSelection,
} from "../lib/discord-domain.mjs";

test("Discord initialization uses TheMoonShow live categories, channels and readable content", () => {
  assert.equal(DISCORD_DEMO_GUILD_NAME, "TheMoonShow VIP Community");
  const snapshot = buildDiscordDemoSnapshot({
    guild: { id: "demo", name: DISCORD_DEMO_GUILD_NAME },
    channels: [
      { id: "cat-2", type: 4, name: "Research", position: 2 },
      { id: "cat-1", type: 4, name: "Start Here", position: 1 },
      { id: "ch-2", type: 0, name: "market-insights", parent_id: "cat-2", position: 2, topic: "Daily research" },
      { id: "ch-1", type: 0, name: "rules", parent_id: "cat-1", position: 1 },
      { id: "voice", type: 2, name: "Voice", parent_id: "cat-1", position: 3 },
    ],
    messagesByChannel: {
      "ch-1": [{ id: "m2", content: "Second", timestamp: "2026-08-14T02:00:00.000Z" }, { id: "m1", content: "First", timestamp: "2026-08-14T01:00:00.000Z" }],
      "ch-2": [{ id: "m3", content: "Chart", attachments: [{ url: "https://cdn.example/chart.png" }] }],
    },
    capturedAt: "2026-08-14T03:00:00.000Z",
  });
  assert.deepEqual(snapshot.categories.map(({ sourceCategoryId, name }) => ({ sourceCategoryId, name })), [
    { sourceCategoryId: "cat-1", name: "Start Here" },
    { sourceCategoryId: "cat-2", name: "Research" },
  ]);
  assert.deepEqual(snapshot.channels.map(({ templateKey, name }) => ({ templateKey, name })), [
    { templateKey: "discord:ch-1", name: "rules" },
    { templateKey: "discord:ch-2", name: "market-insights" },
  ]);
  assert.deepEqual(snapshot.channels[0].messages.map((message) => message.sourceMessageId), ["m1", "m2"]);
  assert.deepEqual(snapshot.channels[1].messages[0].attachmentUrls, ["https://cdn.example/chart.png"]);
});

test("Discord channel selection is unique, follows Demo order and rejects unknown keys", () => {
  const template = { channels: [
    { templateKey: "discord:a" },
    { templateKey: "discord:b" },
    { templateKey: "discord:c" },
  ] };
  assert.deepEqual(normalizeDiscordChannelSelection(["discord:c", "discord:a", "discord:a"], template), ["discord:a", "discord:c"]);
  assert.throws(
    () => normalizeDiscordChannelSelection([], template),
    /at least one Discord channel/i,
  );
  assert.throws(
    () => normalizeDiscordChannelSelection(["discord:a", "discord:missing"], template),
    /unknown Discord channel template/i,
  );
});

test("dynamic Discord initialization reuses matching categories/channels and preserves Demo order", () => {
  const plan = buildDiscordInitializationPlan({
    template: {
      categories: [
        { templateKey: "category:cat-a", sourceCategoryId: "cat-a", name: "Start Here", position: 1 },
        { templateKey: "category:cat-b", sourceCategoryId: "cat-b", name: "Research", position: 2 },
      ],
      channels: [
        { templateKey: "discord:source-a", sourceChannelId: "source-a", sourceCategoryId: "cat-a", name: "rules", position: 1, type: 0, messages: [] },
        { templateKey: "discord:source-b", sourceChannelId: "source-b", sourceCategoryId: "cat-b", name: "market-insights", position: 2, type: 0, messages: [] },
      ],
    },
    selectedTemplateKeys: ["discord:source-a", "discord:source-b"],
    existingChannels: [
      { id: "target-cat-a", type: 4, name: "Start Here" },
      { id: "target-rules", type: 0, name: "rules", parent_id: "target-cat-a" },
      { id: "wrong-market", type: 0, name: "market-insights", parent_id: "target-cat-a" },
    ],
  });

  assert.deepEqual(plan.categories.map(({ name, action, id }) => ({ name, action, id })), [
    { name: "Start Here", action: "reuse", id: "target-cat-a" },
    { name: "Research", action: "create", id: null },
  ]);
  assert.deepEqual(plan.channels.map(({ templateKey, action, id }) => ({ templateKey, action, id })), [
    { templateKey: "discord:source-a", action: "reuse", id: "target-rules" },
    { templateKey: "discord:source-b", action: "create", id: null },
  ]);
});

test("dynamic Discord initialization only reuses uncategorized channels for uncategorized Demo channels", () => {
  const plan = buildDiscordInitializationPlan({
    template: {
      categories: [],
      channels: [{ templateKey: "discord:lobby", sourceChannelId: "lobby", sourceCategoryId: "", name: "lobby", position: 1, type: 0, messages: [] }],
    },
    selectedTemplateKeys: ["discord:lobby"],
    existingChannels: [
      { id: "nested-lobby", type: 0, name: "lobby", parent_id: "some-category" },
      { id: "root-lobby", type: 0, name: "lobby", parent_id: null },
    ],
  });

  assert.equal(plan.channels[0].action, "reuse");
  assert.equal(plan.channels[0].id, "root-lobby");
});

test("Discord config preserves dynamic template bindings and message checkpoints", () => {
  const config = normalizeDiscordConfig({
    demoGuildId: "demo",
    demoTemplate: { guildId: "demo", guildName: DISCORD_DEMO_GUILD_NAME, categories: [], channels: [], capturedAt: "now" },
    guilds: {
      demo: {
        guildName: "TheMoonShow VIP Community",
        channels: [
          { templateKey: "discord:source-a", sourceChannelId: "source-a", channelId: "target-a", name: "rules", seededSourceMessageIds: ["m1", "m1", "m2"] },
        ],
      },
    },
  });

  assert.equal(config.demoGuildId, "demo");
  assert.equal(config.demoTemplate.guildName, DISCORD_DEMO_GUILD_NAME);
  assert.deepEqual(config.guilds.demo.channels[0].seededSourceMessageIds, ["m1", "m2"]);
});

test("Discord install URL uses official bot/application command scopes and least required permissions", () => {
  const url = new URL(buildDiscordInstallUrl("1530060451705262151"));
  assert.equal(url.origin, "https://discord.com");
  assert.equal(url.pathname, "/oauth2/authorize");
  assert.equal(url.searchParams.get("client_id"), "1530060451705262151");
  assert.deepEqual(
    new Set(url.searchParams.get("scope").split(" ")),
    new Set(["bot", "applications.commands"]),
  );
  assert.equal(url.searchParams.get("permissions"), String(DISCORD_REQUIRED_PERMISSIONS));
  assert.throws(() => buildDiscordInstallUrl(""), /App ID/i);
});

test("Discord routes mirror matching Demo channels to every initialized target", () => {
  const config = normalizeDiscordConfig({
    demoGuildId: "demo",
    syncEnabled: true,
    guilds: {
      demo: {
        guildId: "demo",
        guildName: "Demo Academy",
        channels: [
          { templateKey: "discord:a", channelId: "demo-1", name: "rules" },
          { templateKey: "discord:b", channelId: "demo-3", name: "market-events" },
        ],
      },
      targetB: {
        guildId: "targetB",
        guildName: "Target B",
        channels: [
          { templateKey: "discord:a", channelId: "target-b-1", name: "rules" },
          { templateKey: "discord:c", channelId: "target-b-2", name: "signals" },
        ],
      },
      targetA: {
        guildId: "targetA",
        guildName: "Target A",
        channels: [
          { templateKey: "discord:a", channelId: "target-a-1", name: "rules" },
          { templateKey: "discord:b", channelId: "target-a-3", name: "market-events" },
        ],
      },
    },
  });

  assert.deepEqual(
    config.routes.map((route) => [
      route.sourceChannelId,
      route.targetGuildId,
      route.targetChannelId,
      route.templateKey,
    ]),
    [
      ["demo-1", "targetA", "target-a-1", "discord:a"],
      ["demo-3", "targetA", "target-a-3", "discord:b"],
      ["demo-1", "targetB", "target-b-1", "discord:a"],
    ],
  );
});

test("Discord routing accepts human messages from the configured Demo guild", () => {
  const config = {
    demoGuildId: "demo",
    syncEnabled: true,
    guilds: {
      demo: {
        guildId: "demo",
        channels: [{ templateId: 3, channelId: "demo-3", name: "3-market-events" }],
      },
      target: {
        guildId: "target",
        channels: [{ templateId: 3, channelId: "target-3", name: "3-market-events" }],
      },
    },
  };

  assert.equal(
    findDiscordRoutesForMessage(config, {
      guildId: "demo",
      channelId: "demo-3",
      author: { bot: false },
    }).length,
    1,
  );
  assert.deepEqual(
    findDiscordRoutesForMessage(config, {
      guildId: "demo",
      channelId: "demo-3",
      author: { bot: true },
    }),
    [],
  );
  assert.deepEqual(
    findDiscordRoutesForMessage(config, {
      guildId: "demo",
      channelId: "demo-3",
      webhookId: "webhook-1",
      author: { bot: false },
    }),
    [],
  );
  assert.deepEqual(
    findDiscordRoutesForMessage(config, {
      guildId: "target",
      channelId: "target-3",
      author: { bot: false },
    }),
    [],
  );
  assert.deepEqual(
    findDiscordRoutesForMessage({ ...config, syncEnabled: false }, {
      guildId: "demo",
      channelId: "demo-3",
      author: { bot: false },
    }),
    [],
  );
});

test("Discord routing permits the configured gateway bot but ignores other bots", () => {
  const config = {
    demoGuildId: "demo",
    syncEnabled: true,
    guilds: {
      demo: {
        guildId: "demo",
        channels: [{ templateId: 3, channelId: "demo-3", name: "3-market-events" }],
      },
      target: {
        guildId: "target",
        channels: [{ templateId: 3, channelId: "target-3", name: "3-market-events" }],
      },
    },
  };

  assert.equal(
    findDiscordRoutesForMessage(
      config,
      {
        guildId: "demo",
        channelId: "demo-3",
        author: { id: "gateway-bot", bot: true },
      },
      { botId: "gateway-bot" },
    ).length,
    1,
  );
  assert.deepEqual(
    findDiscordRoutesForMessage(
      config,
      {
        guildId: "demo",
        channelId: "demo-3",
        author: { id: "other-bot", bot: true },
      },
      { botId: "gateway-bot" },
    ),
    [],
  );
});

test("Discord relay payload preserves text and attachment URLs without mentions", () => {
  assert.deepEqual(
    buildDiscordRelayPayload({
      content: "Market update\nLine two",
      attachments: new Map([
        ["a", { url: "https://cdn.discordapp.com/a.png" }],
        ["b", { url: "https://cdn.discordapp.com/b.pdf" }],
      ]),
    }),
    {
      content: "Market update\nLine two",
      files: [
        "https://cdn.discordapp.com/a.png",
        "https://cdn.discordapp.com/b.pdf",
      ],
      allowedMentions: { parse: [] },
    },
  );
  assert.equal(buildDiscordRelayPayload({ content: "", attachments: [] }), null);
});
