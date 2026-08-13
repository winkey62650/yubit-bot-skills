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
  assert.match(workspace, /selectedTemplateKeys/);
  assert.match(workspace, /channel\.messages\?\.length/);
  assert.doesNotMatch(workspace, /initialMessages/);
  assert.doesNotMatch(workspace, /CHANNEL_TEMPLATES/);
  assert.doesNotMatch(workspace, /1-read-first-disclaimer/);
});

test("Discord 内容分发中心支持直接发布并独立管理自动发布与同步规则", () => {
  const page = read("app/discord/distribution/page.jsx");
  assert.match(page, /内容分发中心/);
  assert.match(page, /\/api\/discord/);
  assert.match(page, /直接发布到任意 Server \/ Channel/);
  assert.match(page, /direct-publish/);
  assert.match(page, /directChannelIds/);
  assert.match(page, /directContent/);
  assert.match(page, /directResults/);
  assert.match(page, /<details/);
  assert.match(page, /无需经过 Demo/);
  assert.match(page, /\/distribution\?view=automation&platform=discord/);
  assert.match(page, /Demo.*目标同步规则/s);
  assert.match(page, /Daily Events/);
  assert.match(page, /Daily Analysis/);
  assert.match(page, /Whale Signals/);
});

test("Discord 手动信息发布独立支持折叠 Server、多选 Channel 和逐目标结果", () => {
  const page = read("app/discord/manual/page.jsx");
  assert.match(page, /manual-publish/);
  assert.match(page, /manualChannelIds/);
  assert.match(page, /manualImageUrl/);
  assert.match(page, /manualResults/);
  assert.match(page, /<details/);
  assert.match(page, /发送到.*个频道/);
});

test("Discord 健康页实时检查每个 Server 与 Channel 的发送权限", () => {
  const page = read("app/discord/health/page.jsx");
  assert.match(page, /health-check/);
  assert.match(page, /实时检测/);
  assert.match(page, /canSend/);
  assert.match(page, /checkedAt/);
});

test("Discord 管理 API 只暴露受控动作", () => {
  const route = read("app/api/discord/route.js");
  assert.match(route, /getDiscordStatus/);
  assert.match(route, /initializeDiscordGuild/);
  assert.match(route, /updateDiscordSettings/);
  assert.match(route, /sendDiscordTestMessage/);
  assert.match(route, /sendDiscordManualPublish/);
  assert.match(route, /checkDiscordHealth/);
  assert.match(route, /initialize/);
  assert.match(route, /settings/);
  assert.match(route, /test-message/);
  assert.match(route, /manual-publish/);
  assert.match(route, /direct-publish/);
  assert.match(route, /health-check/);
  assert.match(route, /channelIds/);
  assert.match(route, /credential-save/);
  assert.match(route, /credential-clear/);
  assert.match(route, /template-refresh/);
  assert.match(route, /saveDiscordCredentials/);
  assert.match(route, /clearDiscordCredentials/);
  assert.match(route, /initialized/i);
});

test("Discord Bot 凭证可在后台安全配置且不会回显 Token", () => {
  const page = read("app/discord/page.jsx");
  assert.match(page, /type="password"/);
  assert.match(page, /credential-save/);
  assert.match(page, /credential-clear/);
  assert.match(page, /tokenConfigured/);
});
