import assert from "node:assert/strict";
import test from "node:test";

import { publishDiscordTemplate } from "../lib/discord-template-publish.mjs";

const health = {
  guilds: [
    {
      guildId: "guild-one",
      guildName: "Guild One",
      channels: [
        { channelId: "channel-market", name: "market", permissionsOk: true },
        { channelId: "channel-blocked", name: "blocked", permissionsOk: false },
      ],
    },
    {
      guildId: "guild-two",
      guildName: "Guild Two",
      channels: [
        { channelId: "channel-signals", name: "signals", permissionsOk: true },
      ],
    },
  ],
};

test("Discord template publishing rejects unknown templates", async () => {
  await assert.rejects(
    publishDiscordTemplate({ contentType: "custom", channelIds: ["channel-market"] }, { health }),
    /有效的 Discord 内容模板/,
  );
});

test("Discord template publishing rejects channels that fail the live permission check", async () => {
  await assert.rejects(
    publishDiscordTemplate({ contentType: "daily-events", channelIds: ["channel-blocked"] }, { health }),
    /channel-blocked/,
  );
});

test("Discord template publishing sends only the selected live channels", async () => {
  let capturedJobId;
  let capturedOptions;
  const runJob = async (jobId, options) => {
    capturedJobId = jobId;
    capturedOptions = options;
    return {
      status: "partial",
      message: "one target failed",
      preview: {
        targetResults: [
          {
            target: options.targets[0],
            status: "success",
            messageId: "message-one",
            messageIds: ["message-one"],
          },
          {
            target: options.targets[1],
            status: "failed",
            error: "missing permission",
          },
        ],
      },
    };
  };

  const result = await publishDiscordTemplate({
    contentType: "daily-events",
    channelIds: ["channel-market", "channel-signals", "channel-market"],
  }, { health, runJob });

  assert.equal(capturedJobId, "daily-events");
  assert.equal(capturedOptions.dryRun, false);
  assert.equal(capturedOptions.force, true);
  assert.deepEqual(capturedOptions.targets, [
    {
      platform: "discord",
      guildId: "guild-one",
      channelId: "channel-market",
      groupName: "Guild One",
      topicName: "market",
      enabled: true,
    },
    {
      platform: "discord",
      guildId: "guild-two",
      channelId: "channel-signals",
      groupName: "Guild Two",
      topicName: "signals",
      enabled: true,
    },
  ]);
  assert.equal(result.delivered, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].messageId, "message-one");
  assert.equal(result.results[1].error, "missing permission");
});
