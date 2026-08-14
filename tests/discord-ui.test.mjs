import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

function read(pathname) {
  return readFileSync(new URL(pathname, root), "utf8");
}

test("后台导航将 Discord 工作台、内容分发、手动发布和健康检查拆成独立入口", () => {
  const shell = read("app/components/ConsoleShell.jsx");
  const i18n = read("lib/i18n.mjs");
  assert.match(shell, /href:\s*"\/discord"/);
  assert.match(shell, /href:\s*"\/discord\/distribution"/);
  assert.match(shell, /href:\s*"\/discord\/manual"/);
  assert.match(shell, /href:\s*"\/discord\/health"/);
  assert.match(shell, /label:\s*"nav\.discord"/);
  assert.match(i18n, /"nav\.discord": "Discord 社区"/);
  assert.match(i18n, /"nav\.discord": "Discord Community"/);
  assert.match(i18n, /"nav\.discordDistribution": "内容分发中心"/);
  assert.match(i18n, /"nav\.discordManual": "手动信息发布"/);
  assert.match(i18n, /"nav\.discordHealth": "Server 与 Channel 健康"/);
});

test("Discord 工作台只保留连接和初始化能力", () => {
  const workspace = read("app/discord/page.jsx");
  assert.match(workspace, /\/api\/discord/);
  assert.match(workspace, /安装 Bot/);
  assert.match(workspace, /初始化频道/);
  assert.match(workspace, /status\.gateway\?\.online/);
  assert.doesNotMatch(workspace, /manual-publish/);
  assert.doesNotMatch(workspace, /Demo.*目标同步规则/s);
  assert.match(workspace, /TheMoonShow VIP Community/);
  assert.match(workspace, /template-refresh/);
  assert.match(workspace, /demoGuildId/);
  assert.match(workspace, /guildId:\s*demoGuildId/);
  assert.match(workspace, /初始化 Demo Server/);
  assert.match(workspace, /初始化目标 Server/);
  assert.match(workspace, /selectedTemplateKeys/);
  assert.match(workspace, /channel\.messages\?\.length/);
  assert.doesNotMatch(workspace, /initialMessages/);
  assert.doesNotMatch(workspace, /CHANNEL_TEMPLATES/);
  assert.doesNotMatch(workspace, /1-read-first-disclaimer/);
});

test("Discord 内容分发中心通过模板、定时和目标频道创建自动任务", () => {
  const page = read("app/discord/distribution/page.jsx");
  assert.match(page, /内容分发中心/);
  assert.match(page, /\/api\/distribution/);
  assert.match(page, /contentType/);
  assert.match(page, /schedulePreset/);
  assert.match(page, /selectedChannelIds/);
  assert.match(page, /<details/);
  assert.match(page, /选择内容模板/);
  assert.match(page, /选择目标 Server \/ Channel/);
  assert.match(page, /Demo.*目标同步规则/s);
  assert.match(page, /Daily Events/);
  assert.match(page, /Daily Analysis/);
  assert.match(page, /Whale Signals/);
  assert.match(page, /mergeDiscordGuilds/);
  assert.match(page, /availableGuilds/);
  assert.match(page, /discoveredGuilds:\s*status\.guilds/);
  assert.match(page, /configuredGuilds:\s*Object\.values\(status\.config\.guilds/);
  assert.match(page, /extractDistributionOverview/);
  assert.match(page, /\/api\/social-packages/);
  assert.match(page, /SocialSourceManager/);
  assert.match(page, /buildDiscordSocialTargetOptions/);
  assert.match(page, /discoveryAuthoritative:\s*status\.connected === true/);
  assert.doesNotMatch(page, /value:\s*"agent-sync"/);
  assert.doesNotMatch(page, /directContent/);
  assert.doesNotMatch(page, /direct-publish/);
  assert.doesNotMatch(page, /<textarea/);
});

test("Discord Trader 手动信息发布可输入正文和图片并直接发布到可发送频道", () => {
  const page = read("app/discord/manual/page.jsx");
  assert.match(page, /\/api\/discord\/manual/);
  assert.match(page, /manualContent/);
  assert.match(page, /manualImageUrl/);
  assert.match(page, /manualImageFile/);
  assert.match(page, /type="file"/);
  assert.match(page, /accept="image\//);
  assert.match(page, /new FormData/);
  assert.match(page, /manualChannelIds/);
  assert.match(page, /manualResults/);
  assert.match(page, /<details/);
  assert.match(page, /发送到.*个频道/);
  assert.match(page, /guildSearch/);
  assert.match(page, /filteredGuilds/);
  assert.match(page, /filterDiscordGuildChannels/);
  assert.match(page, /搜索可发言频道/);
  assert.match(page, /open=\{guildSearch\.trim\(\) \? true : undefined\}/);
  assert.match(page, /discoveryAuthoritative:\s*status\.connected === true/);
  assert.match(page, /<textarea/);
  assert.doesNotMatch(page, /template-publish/);
  assert.doesNotMatch(page, /selectedTemplate/);
  assert.doesNotMatch(page, /TEMPLATE_OPTIONS/);
});

test("Discord Trader 手动发布使用独立的最小权限 API", () => {
  const route = read("app/api/discord/manual/route.js");
  assert.match(route, /getDiscordStatus/);
  assert.match(route, /checkDiscordHealth/);
  assert.match(route, /sendDiscordManualPublish/);
  assert.match(route, /request\.formData/);
  assert.match(route, /arrayBuffer/);
  assert.doesNotMatch(route, /saveDiscordCredentials/);
  assert.doesNotMatch(route, /initializeDiscordGuild/);
});

test("Discord 健康页实时检查完整权限并提供逐 Server 修复入口", () => {
  const page = read("app/discord/health/page.jsx");
  assert.match(page, /health-check/);
  assert.match(page, /实时检测/);
  assert.match(page, /canSend/);
  assert.match(page, /canManageChannels/);
  assert.match(page, /canReadHistory/);
  assert.match(page, /missingPermissions/);
  assert.match(page, /reauthorizeUrl/);
  assert.match(page, /sendableChannels/);
  assert.match(page, /blockedChannels/);
  assert.match(page, /checkedAt/);
});

test("Discord 管理 API 只暴露受控动作", () => {
  const route = read("app/api/discord/route.js");
  assert.match(route, /getDiscordStatus/);
  assert.match(route, /initializeDiscordGuild/);
  assert.match(route, /updateDiscordSettings/);
  assert.match(route, /sendDiscordTestMessage/);
  assert.match(route, /sendDiscordManualPublish/);
  assert.match(route, /publishDiscordTemplate/);
  assert.match(route, /checkDiscordHealth/);
  assert.match(route, /initialize/);
  assert.match(route, /settings/);
  assert.match(route, /test-message/);
  assert.match(route, /manual-publish/);
  assert.match(route, /direct-publish/);
  assert.match(route, /health-check/);
  assert.match(route, /template-publish/);
  assert.match(route, /channelIds/);
  assert.match(route, /credential-save/);
  assert.match(route, /credential-clear/);
  assert.match(route, /template-refresh/);
  assert.match(route, /saveDiscordCredentials/);
  assert.match(route, /clearDiscordCredentials/);
  assert.match(route, /initialized/i);
});

test("Discord 健康检查不会在完成后重复刷新 Bot 与 Server 状态", () => {
  const route = read("app/api/discord/route.js");
  assert.match(
    route,
    /action === "health-check"\) \{\s*const health = await checkDiscordHealth\(\);\s*return json\(\{ ok: true, result: \{ health \} \}\);/,
  );
});

test("Discord Bot 凭证可在后台安全配置且不会回显 Token", () => {
  const page = read("app/discord/page.jsx");
  assert.match(page, /type="password"/);
  assert.match(page, /credential-save/);
  assert.match(page, /credential-clear/);
  assert.match(page, /tokenConfigured/);
});
