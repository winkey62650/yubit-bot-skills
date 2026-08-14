import assert from "node:assert/strict";
import test from "node:test";

import { mergeDiscordGuilds } from "../lib/discord-guild-list.mjs";

test("keeps a configured Demo Server when the current health response only contains another Server", () => {
  const guilds = mergeDiscordGuilds({
    configuredGuilds: [
      { guildId: "demo-1", guildName: "TheMoonShow VIP Community", channels: [{ channelId: "demo-channel" }] },
    ],
    discoveredGuilds: [
      { id: "target-1", name: "Trade Setups" },
    ],
    healthGuilds: [
      { guildId: "target-1", guildName: "Trade Setups", channels: [{ channelId: "target-channel", permissionsOk: true }] },
    ],
  });

  assert.deepEqual(guilds.map((guild) => guild.guildId).sort(), ["demo-1", "target-1"]);
  assert.equal(guilds.find((guild) => guild.guildId === "demo-1")?.channels[0]?.channelId, "demo-channel");
});

test("prefers the latest health name and channel permissions for the same Server", () => {
  const guilds = mergeDiscordGuilds({
    configuredGuilds: [
      { guildId: "demo-1", guildName: "Old Demo Name", channels: [{ channelId: "old-channel" }] },
    ],
    discoveredGuilds: [
      { id: "demo-1", name: "Discovered Demo Name" },
    ],
    healthGuilds: [
      { guildId: "demo-1", guildName: "TheMoonShow VIP Community", channels: [{ channelId: "live-channel", permissionsOk: true }] },
    ],
  });

  assert.equal(guilds.length, 1);
  assert.equal(guilds[0].guildName, "TheMoonShow VIP Community");
  assert.deepEqual(guilds[0].channels, [{ channelId: "live-channel", permissionsOk: true }]);
});

test("keeps discovered channels when a transient health response contains zero channels", () => {
  const guilds = mergeDiscordGuilds({
    configuredGuilds: [
      { guildId: "guild-1", guildName: "Configured", channels: [{ channelId: "configured-channel" }] },
    ],
    discoveredGuilds: [
      { id: "guild-1", name: "Discovered", channels: [{ id: "live-channel", name: "updates" }] },
    ],
    healthGuilds: [
      { guildId: "guild-1", guildName: "Live Server", channels: [], error: "temporary failure" },
    ],
  });

  assert.equal(guilds[0].guildName, "Live Server");
  assert.equal(guilds[0].channels.length, 1);
  assert.equal(guilds[0].channels[0].channelId, "live-channel");
});

test("hides a removed configured Server after authoritative discovery", () => {
  const guilds = mergeDiscordGuilds({
    configuredGuilds: [
      { guildId: "live", guildName: "Live Server" },
      { guildId: "removed", guildName: "Removed Server" },
    ],
    discoveredGuilds: [{ id: "live", name: "Live Server" }],
    healthGuilds: [
      { guildId: "live", guildName: "Live Server", available: true },
      { guildId: "removed", guildName: "Removed Server", available: false },
    ],
    discoveryAuthoritative: true,
  });

  assert.deepEqual(guilds.map((guild) => guild.guildId), ["live"]);
});

test("keeps configured Servers when live discovery is unavailable", () => {
  const guilds = mergeDiscordGuilds({
    configuredGuilds: [{ guildId: "configured", guildName: "Configured Server" }],
    discoveredGuilds: [],
    healthGuilds: [],
    discoveryAuthoritative: false,
  });

  assert.deepEqual(guilds.map((guild) => guild.guildId), ["configured"]);
});
