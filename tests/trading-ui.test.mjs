import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("console navigation groups Telegram, Discord, and operations destinations", async () => {
  const [shell, i18n] = await Promise.all([
    readFile(new URL("../app/components/ConsoleShell.jsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/i18n.mjs", import.meta.url), "utf8")
  ]);
  const telegram = shell.indexOf('key: "telegram"');
  const distribution = shell.indexOf('label: "nav.distribution"');
  const bots = shell.indexOf('label: "nav.capabilities"');
  const discord = shell.indexOf('key: "discord"');
  const discordWorkspace = shell.indexOf('label: "nav.discordWorkspace"');
  const operations = shell.indexOf('key: "operations"');
  const analytics = shell.indexOf('label: "nav.analytics"');
  const trading = shell.indexOf('label: "nav.trading"');
  assert.ok(telegram >= 0 && distribution > telegram && bots > distribution);
  assert.ok(discord > bots && discordWorkspace > discord);
  assert.ok(operations > discordWorkspace && analytics > operations && trading > analytics);
  assert.match(shell, /href: ["']\/distribution\?view=site-analytics["']/);
  assert.match(shell, /view: ["']site-analytics["']/);
  assert.match(shell, /href: ["']\/trading["']/);
  assert.doesNotMatch(shell, /label: ["']群数据["']/);
  assert.match(i18n, /"nav\.trading": "交易中心"/);
  assert.match(i18n, /"nav\.trading": "Trading Center"/);
});

test("login page describes the content operations workflow instead of the legacy bot console", async () => {
  const [page, i18n] = await Promise.all([
    readFile(new URL("../app/login/page.jsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/i18n.mjs", import.meta.url), "utf8")
  ]);
  assert.match(page, /t\("login\.subtitle"\)/);
  assert.match(i18n, /"login\.subtitle": "登录后管理内容发布与群运营"/);
  assert.match(i18n, /"login\.subtitle": "Manage publishing and community operations"/);
  assert.doesNotMatch(page, /管理机器人与群配置/);
});

test("trading center provides accessible operator flows and durable refresh states", async () => {
  const page = await readFile(new URL("../app/trading/page.jsx", import.meta.url), "utf8");

  for (const label of ["交易日志", "Trader 管理", "发布目标"]) {
    assert.match(page, new RegExp(label));
  }
  assert.doesNotMatch(page, /\["health",\s*"系统状态"\]/);
  assert.doesNotMatch(page, /function SystemHealth/);
  assert.match(page, /role=["']tablist["']/);
  assert.match(page, /aria-label=["']交易中心功能["']/);
  for (const label of ["Trader 名称", "Telegram 数字 ID", "账户名称", "API Key", "API Secret", "发布范围", "目标群 \/ Topic"]) {
    assert.match(page, new RegExp(label));
  }

  assert.match(page, /正在读取交易中心/);
  assert.match(page, /读取失败|加载失败/);
  assert.match(page, /暂无交易记录/);
  assert.match(page, /暂无 Trader/);
  assert.match(page, /暂无发布目标/);
  assert.match(page, /type=["']password["']/);
  assert.match(page, /关闭交易、转账和提现权限/);
  assert.match(page, /验证查询权限/);
  assert.match(page, /订单核验已就绪/);
  assert.match(page, /发布目标待配置/);
  assert.match(page, /verifiedAccountCount/);
  assert.match(page, /canVerifyOrders/);
  assert.match(page, /canPublish/);
  assert.match(page, /26200004/);
  assert.match(page, /首尾空格/);
  assert.match(page, /生产服务器公网 IP/);
  assert.doesNotMatch(page, /<option value="verified">已验证<\/option>/);
  assert.match(page, /apiKeyMasked/);
  assert.match(page, /navigator\.clipboard\.writeText/);
  assert.match(page, /window\.confirm/);
  assert.match(page, /fetch\(["']\/api\/trading["'], \{ cache: ["']no-store["'] \}\)/);
  assert.match(page, /\/api\/trading\/signals\/\$\{.*\}\/refresh/);
  assert.match(page, /\/api\/trading\/deliveries\/\$\{.*\}\/retry/);

  assert.doesNotMatch(page, /credentialCiphertext|credentialIv|credentialAuthTag|apiSecretCiphertext/);
});
