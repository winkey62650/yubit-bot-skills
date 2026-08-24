import assert from "node:assert/strict";
import test from "node:test";

import { preflightDiscordTemplate, publishDiscordTemplate } from "../lib/discord-template-publish.mjs";
import { saveDestinationCtaConfig } from "../lib/destination-cta.mjs";

const health = {
  guilds: [
    {
      guildId: "guild-one",
      guildName: "Guild One",
      channels: [
        { channelId: "channel-market", name: "market", permissionsOk: true },
        { channelId: "channel-research", name: "research", permissionsOk: true },
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

function ctaRepository() {
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

test("Discord template preflight prepares the generated poster without sending a message", async () => {
  let capturedOptions;
  let preparedUrl;
  const result = await preflightDiscordTemplate({
    contentType: "crypto-daily",
    channelIds: ["channel-market"],
  }, {
    health,
    publicBaseUrl: "https://academy.example",
    runJob: async (_jobId, options) => {
      capturedOptions = options;
      return {
        status: "success",
        preview: {
          imageUrl: "https://academy.example/api/media/card?data=poster",
        },
      };
    },
    preparePoster: async (url) => {
      preparedUrl = url;
      return { data: Buffer.alloc(1_024), filename: "market-card.png", contentType: "image/png" };
    },
  });

  assert.equal(capturedOptions.dryRun, true);
  assert.equal(capturedOptions.readOnlyPreview, true);
  assert.equal(preparedUrl, "https://academy.example/api/media/card?data=poster");
  assert.deepEqual(result.poster, {
    bytes: 1_024,
    contentType: "image/png",
    filename: "market-card.png",
    urlLength: preparedUrl.length,
  });
  assert.equal(result.channelId, "channel-market");
});

for (const jobId of ["crypto-daily", "weekly-calendar", "data-release-updates"]) {
  test(`Discord template publishing maps ${jobId} directly to its automation job`, async () => {
    let capturedJobId;
    let capturedOptions;
    const result = await publishDiscordTemplate({
      contentType: jobId,
      channelIds: ["channel-market"],
    }, {
      health,
      runJob: async (resolvedJobId, options) => {
        capturedJobId = resolvedJobId;
        capturedOptions = options;
        return { status: "success", preview: { targetResults: [] } };
      },
    });

    assert.equal(capturedJobId, jobId);
    assert.equal(result.jobId, jobId);
    assert.equal(capturedOptions.dryRun, false);
    assert.equal(capturedOptions.force, true);
    assert.deepEqual(capturedOptions.targets.map(({ guildId, channelId }) => ({ guildId, channelId })), [
      { guildId: "guild-one", channelId: "channel-market" },
    ]);
  });
}

for (const contentType of [
  "crypto-daily",
  "weekly-calendar",
  "data-release-updates",
  "news",
  "daily-events",
  "daily-analysis",
  "whale-signals",
  "agent-sync",
]) {
  test(`Discord template publishing hydrates the latest guild CTA and injects its repository for ${contentType}`, async () => {
    const repository = ctaRepository();
    await saveDestinationCtaConfig(repository, {
      platform: "discord",
      guildId: "guild-one",
      ctaEnabled: true,
      ctaContent: "**Stale CTA**",
    });
    await saveDestinationCtaConfig(repository, {
      platform: "discord",
      guildId: "guild-one",
      ctaEnabled: true,
      ctaContent: "**Latest CTA**\n[Join](https://example.com/latest)",
    });

    let capturedOptions;
    await publishDiscordTemplate({
      contentType,
      channelIds: ["channel-market", "channel-research"],
    }, {
      health,
      repository,
      runJob: async (_jobId, options) => {
        capturedOptions = options;
        return { status: "success", preview: { targetResults: [] } };
      },
    });

    assert.equal(capturedOptions.repository, repository);
    assert.deepEqual(capturedOptions.targets.map((target) => ({
      channelId: target.channelId,
      ctaEnabled: target.ctaEnabled,
      ctaContent: target.ctaContent,
    })), [
      { channelId: "channel-market", ctaEnabled: true, ctaContent: "**Latest CTA**\n[Join](https://example.com/latest)" },
      { channelId: "channel-research", ctaEnabled: true, ctaContent: "**Latest CTA**\n[Join](https://example.com/latest)" },
    ]);
  });
}

test("Discord template publishing preserves an empty guild CTA without adding destination content", async () => {
  const repository = ctaRepository();
  await saveDestinationCtaConfig(repository, {
    platform: "discord",
    guildId: "guild-one",
    ctaEnabled: false,
    ctaContent: "",
  });

  let capturedOptions;
  await publishDiscordTemplate({
    contentType: "crypto-daily",
    channelIds: ["channel-market", "channel-research"],
  }, {
    health,
    repository,
    runJob: async (_jobId, options) => {
      capturedOptions = options;
      return { status: "success", preview: { targetResults: [] } };
    },
  });

  assert.deepEqual(capturedOptions.targets.map((target) => ({
    channelId: target.channelId,
    ctaEnabled: target.ctaEnabled,
    ctaContent: target.ctaContent,
  })), [
    { channelId: "channel-market", ctaEnabled: false, ctaContent: "" },
    { channelId: "channel-research", ctaEnabled: false, ctaContent: "" },
  ]);
});
