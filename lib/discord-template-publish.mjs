import { randomUUID } from "node:crypto";

import { runAutomationJob } from "./automation-jobs.mjs";
import { checkDiscordHealth } from "./discord-service.mjs";

const CONTENT_JOBS = Object.freeze({
  news: "news-feed",
  "daily-events": "daily-events",
  "daily-analysis": "daily-analysis",
  "whale-signals": "whale-hourly",
  "agent-sync": "agent-sync-4h",
});

export async function publishDiscordTemplate(input = {}, options = {}) {
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

  const blocked = channelIds.filter((channelId) => !available.get(channelId)?.channel?.permissionsOk);
  if (blocked.length) {
    throw new Error(`以下 Channel 未通过实时权限检测，无法发布：${blocked.join(", ")}`);
  }

  const targets = channelIds.map((channelId) => {
    const { guild, channel } = available.get(channelId);
    return {
      platform: "discord",
      guildId: String(guild.guildId),
      channelId,
      groupName: guild.guildName,
      topicName: channel.name,
      enabled: true,
    };
  });

  const run = await (options.runJob || runAutomationJob)(jobId, {
    dryRun: false,
    force: true,
    targets,
    stateKey: `discord-template:${contentType}:${randomUUID()}`,
    publicBaseUrl: options.publicBaseUrl,
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
    contentType,
    jobId,
    status: run?.status || "unknown",
    message: run?.message || "",
    delivered: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  };
}

