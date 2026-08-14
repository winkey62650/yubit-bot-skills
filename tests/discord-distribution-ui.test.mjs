import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDiscordSocialTargetOptions,
  extractDistributionOverview,
  formatDiscordTargetLabel,
} from "../lib/discord-distribution-ui.mjs";

test("reads saved distribution records from the current top-level API response", () => {
  const overview = extractDistributionOverview({
    ok: true,
    rules: [{ id: "saved-rule" }],
    records: [{ id: "delivery" }],
  });

  assert.deepEqual(overview.rules, [{ id: "saved-rule" }]);
  assert.deepEqual(overview.records, [{ id: "delivery" }]);
});

test("remains compatible with legacy nested distribution responses", () => {
  const overview = extractDistributionOverview({
    result: { overview: { rules: [{ id: "legacy" }] } },
  });

  assert.deepEqual(overview.rules, [{ id: "legacy" }]);
});

test("builds explicit agent social targets only from writable Discord channels", () => {
  const options = buildDiscordSocialTargetOptions([
    {
      guildId: "guild-1",
      guildName: "Demo Server",
      channels: [
        { channelId: "channel-1", name: "news", permissionsOk: true, canEmbed: true },
        { channelId: "channel-2", name: "blocked", permissionsOk: false, canEmbed: true },
      ],
    },
  ]);

  assert.deepEqual(options, [
    {
      key: "discord:guild-1:channel-1",
      label: "Demo Server / #news",
      target: {
        platform: "discord",
        guildId: "guild-1",
        channelId: "channel-1",
        groupName: "Demo Server",
        topicName: "news",
        channelName: "news",
        enabled: true,
      },
    },
  ]);
});

test("formats every Discord target with explicit Server and Channel labels", () => {
  assert.equal(
    formatDiscordTargetLabel({
      groupName: "TheMoonShow VIP Community",
      topicName: "market-insights",
    }),
    "Discord Server：TheMoonShow VIP Community → Channel：#market-insights",
  );
  assert.equal(
    formatDiscordTargetLabel({ guildId: "guild-1", channelId: "channel-1" }),
    "Discord Server：guild-1 → Channel：#channel-1",
  );
});
