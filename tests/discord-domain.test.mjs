import test from "node:test";
import assert from "node:assert/strict";

import {
  DISCORD_CATEGORY_NAME,
  DISCORD_CHANNEL_TEMPLATES,
  DISCORD_REQUIRED_PERMISSIONS,
  buildDiscordInstallUrl,
  buildDiscordInitializationPlan,
  buildDiscordRelayPayload,
  findDiscordRoutesForMessage,
  normalizeDiscordConfig,
  normalizeDiscordChannelSelection,
} from "../lib/discord-domain.mjs";

test("Discord channel template follows the canonical 1-7 order and excludes General Chat", () => {
  assert.equal(DISCORD_CATEGORY_NAME, "CryptoGuy Academy");
  assert.deepEqual(
    DISCORD_CHANNEL_TEMPLATES.map(({ id, name }) => ({ id, name })),
    [
      { id: 1, name: "1-read-first-disclaimer" },
      { id: 2, name: "2-cryptoguy-trading-zone" },
      { id: 3, name: "3-market-events" },
      { id: 4, name: "4-market-analysis" },
      { id: 5, name: "5-community-signal" },
      { id: 6, name: "6-smart-money-tracker" },
      { id: 7, name: "7-yubit-updates" },
    ],
  );
  assert.equal(
    DISCORD_CHANNEL_TEMPLATES.some((channel) => /general/i.test(channel.name)),
    false,
  );
});

test("Discord channel selection is unique, canonical and rejects unknown values", () => {
  assert.deepEqual(normalizeDiscordChannelSelection(["7", 2, 2, 1]), [1, 2, 7]);
  assert.throws(
    () => normalizeDiscordChannelSelection([]),
    /at least one Discord channel/i,
  );
  assert.throws(
    () => normalizeDiscordChannelSelection([1, 8]),
    /unknown Discord channel template/i,
  );
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

test("Discord initialization plan reuses matching resources and creates only missing selections", () => {
  const plan = buildDiscordInitializationPlan({
    guildId: "guild-1",
    selectedTemplateIds: [1, 2, 3],
    existingChannels: [
      { id: "category-1", type: 4, name: DISCORD_CATEGORY_NAME },
      {
        id: "channel-1",
        type: 0,
        name: "1-read-first-disclaimer",
        parent_id: "category-1",
      },
      {
        id: "wrong-parent",
        type: 0,
        name: "2-cryptoguy-trading-zone",
        parent_id: "another-category",
      },
    ],
  });

  assert.deepEqual(plan.category, {
    action: "reuse",
    id: "category-1",
    name: DISCORD_CATEGORY_NAME,
  });
  assert.deepEqual(
    plan.channels.map(({ templateId, action, id }) => ({
      templateId,
      action,
      id: id ?? null,
    })),
    [
      { templateId: 1, action: "reuse", id: "channel-1" },
      { templateId: 2, action: "create", id: null },
      { templateId: 3, action: "create", id: null },
    ],
  );
});

test("Discord initialization plan creates the category once for a new guild", () => {
  const plan = buildDiscordInitializationPlan({
    guildId: "guild-2",
    selectedTemplateIds: [3, 5],
    existingChannels: [],
  });
  assert.deepEqual(plan.category, {
    action: "create",
    id: null,
    name: DISCORD_CATEGORY_NAME,
  });
  assert.deepEqual(
    plan.channels.map((channel) => [channel.templateId, channel.position]),
    [
      [3, 2],
      [5, 4],
    ],
  );
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
          { templateId: 1, channelId: "demo-1", name: "1-read-first-disclaimer" },
          { templateId: 3, channelId: "demo-3", name: "3-market-events" },
        ],
      },
      targetB: {
        guildId: "targetB",
        guildName: "Target B",
        channels: [
          { templateId: 1, channelId: "target-b-1", name: "1-read-first-disclaimer" },
          { templateId: 2, channelId: "target-b-2", name: "2-cryptoguy-trading-zone" },
        ],
      },
      targetA: {
        guildId: "targetA",
        guildName: "Target A",
        channels: [
          { templateId: 1, channelId: "target-a-1", name: "1-read-first-disclaimer" },
          { templateId: 3, channelId: "target-a-3", name: "3-market-events" },
        ],
      },
    },
  });

  assert.deepEqual(
    config.routes.map((route) => [
      route.sourceChannelId,
      route.targetGuildId,
      route.targetChannelId,
      route.templateId,
    ]),
    [
      ["demo-1", "targetA", "target-a-1", 1],
      ["demo-3", "targetA", "target-a-3", 3],
      ["demo-1", "targetB", "target-b-1", 1],
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
