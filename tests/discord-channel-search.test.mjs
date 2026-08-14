import assert from "node:assert/strict";
import test from "node:test";

import { filterDiscordGuildChannels } from "../lib/discord-channel-search.mjs";

const guilds = [
  {
    guildId: "guild-alpha",
    guildName: "Alpha Research",
    channels: [
      { channelId: "general", name: "general", permissionsOk: true },
      { channelId: "alerts", name: "whale-alerts", permissionsOk: true },
    ],
  },
  {
    guildId: "guild-beta",
    guildName: "Beta Signals",
    channels: [
      { channelId: "setups", name: "trade-setups", permissionsOk: true },
    ],
  },
];

test("频道名称命中时只保留匹配频道，不展示同 Server 的无关频道", () => {
  assert.deepEqual(filterDiscordGuildChannels(guilds, "  WHALE  "), [
    {
      ...guilds[0],
      channels: [guilds[0].channels[1]],
    },
  ]);
});

test("Server 名称命中时保留该 Server 的全部频道", () => {
  assert.deepEqual(filterDiscordGuildChannels(guilds, "beta"), [guilds[1]]);
});

test("空搜索保留完整列表", () => {
  assert.deepEqual(filterDiscordGuildChannels(guilds, ""), guilds);
});

test("无匹配频道时返回空结果", () => {
  assert.deepEqual(filterDiscordGuildChannels(guilds, "not-found"), []);
});
