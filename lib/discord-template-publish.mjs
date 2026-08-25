import { randomUUID } from "node:crypto";

import { runAutomationJob } from "./automation-jobs.mjs";
import { hydrateDestinationCtas } from "./destination-cta.mjs";
import { getDistributionRepository } from "./distribution-repository.mjs";
import { checkDiscordHealth, prepareDiscordPosterAttachment } from "./discord-service.mjs";

const CONTENT_JOBS = Object.freeze({
  "crypto-daily": "crypto-daily",
  "weekly-calendar": "weekly-calendar",
  "data-release-updates": "data-release-updates",
  news: "news-feed",
  "daily-events": "daily-events",
  "daily-analysis": "daily-analysis",
  "whale-signals": "whale-hourly",
  "agent-sync": "agent-sync-4h",
});

async function resolveDiscordTemplateContext(input = {}, options = {}) {
  const contentType = String(input.contentType || "").trim();
  const jobId = CONTENT_JOBS[contentType];
  if (!jobId) throw new Error("请选择有效的 Discord 内容模板。");

  const channelIds = [...new Set((Array.isArray(input.channelIds) ? input.channelIds : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
  if (!channelIds.length) throw new Error("请至少选择一个可发送的 Discord Channel。");

  const health = options.health || await (options.checkHealth || checkDiscordHealth)();
  const available = new Map();
  for (const guild of health.guilds || []) {
    for (const channel of guild.channels || []) {
      available.set(String(channel.channelId), { guild, channel });
    }
  }

  const blocked = channelIds.filter((channelId) => {
    const channel = available.get(channelId)?.channel;
    return !channel?.permissionsOk || channel?.canAttach === false;
  });
  if (blocked.length) {
    throw new Error(`以下 Channel 未通过实时权限检测，无法发布：${blocked.join(", ")}`);
  }

  const repository = options.repository || await (options.getRepository || getDistributionRepository)();
  const targets = await hydrateDestinationCtas(repository, channelIds.map((channelId) => {
    const { guild, channel } = available.get(channelId);
    return {
      platform: "discord",
      guildId: String(guild.guildId),
      channelId,
      groupName: guild.guildName,
      topicName: channel.name,
      enabled: true,
    };
  }));

  return { contentType, jobId, channelIds, repository, targets };
}

export async function preflightDiscordTemplate(input = {}, options = {}) {
  const context = await resolveDiscordTemplateContext(input, options);
  const run = await (options.runJob || runAutomationJob)(context.jobId, {
    dryRun: true,
    force: true,
    readOnlyPreview: true,
    targets: context.targets,
    stateKey: `discord-template-preflight:${context.contentType}:${randomUUID()}`,
    publicBaseUrl: options.publicBaseUrl,
    repository: context.repository,
  });
  if (run?.status !== "success") {
    throw new Error(run?.message || "Discord 内容模板预检失败。");
  }
  const imageUrl = String(run?.preview?.mediaDelivery?.defaultUrl || run?.preview?.imageUrl || "").trim();
  if (!imageUrl) throw new Error("Discord 内容模板没有生成海报。");
  const attachment = await (options.preparePoster || prepareDiscordPosterAttachment)(imageUrl, {
    signal: options.signal,
  });
  return {
    contentType: context.contentType,
    jobId: context.jobId,
    guildId: context.targets[0]?.guildId || "",
    channelId: context.targets[0]?.channelId || "",
    poster: {
      bytes: attachment.data.length,
      contentType: attachment.contentType,
      filename: attachment.filename,
      urlLength: imageUrl.length,
    },
  };
}

export async function publishDiscordTemplate(input = {}, options = {}) {
  const context = await resolveDiscordTemplateContext(input, options);

  const run = await (options.runJob || runAutomationJob)(context.jobId, {
    dryRun: false,
    force: true,
    targets: context.targets,
    stateKey: `discord-template:${context.contentType}:${randomUUID()}`,
    publicBaseUrl: options.publicBaseUrl,
    repository: context.repository,
  });
  const targetResults = run?.preview?.targetResults || [];
  const results = targetResults.map((item) => {
    const target = item.target || {};
    return {
      ok: item.status === "success",
      status: item.status,
      guildId: target.guildId,
      channelId: target.channelId,
      guildName: target.groupName,
      channelName: target.topicName,
      messageId: item.messageId,
      messageIds: item.messageIds,
      error: item.error,
    };
  });

  return {
    contentType: context.contentType,
    jobId: context.jobId,
    status: run?.status || "unknown",
    message: run?.message || "",
    delivered: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  };
}
