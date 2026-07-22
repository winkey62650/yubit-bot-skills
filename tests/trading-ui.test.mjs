import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("console navigation exposes the trading center after content distribution", async () => {
  const shell = await readFile(new URL("../app/components/ConsoleShell.jsx", import.meta.url), "utf8");
  const distribution = shell.indexOf('label: "内容分发中心"');
  const trading = shell.indexOf('label: "交易中心"');
  const bots = shell.indexOf('label: "后台能力"');
  assert.ok(distribution >= 0 && trading > distribution && bots > trading);
  assert.match(shell, /href: ["']\/trading["']/);
  assert.doesNotMatch(shell, /label: ["']群数据["']/);
});

test("login page describes the content operations workflow instead of the legacy bot console", async () => {
  const page = await readFile(new URL("../app/login/page.jsx", import.meta.url), "utf8");
  assert.match(page, /管理内容发布与群运营/);
  assert.doesNotMatch(page, /管理机器人与群配置/);
});

test("trading center provides accessible operator flows and durable refresh states", async () => {
  const page = await readFile(new URL("../app/trading/page.jsx", import.meta.url), "utf8");

  for (const label of ["交易日志", "Trader 管理", "发布目标", "系统状态"]) {
    assert.match(page, new RegExp(label));
  }
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
  assert.match(page, /预览环境必须使用独立测试 Bot/);
  assert.match(page, /configurationAllowed/);
  assert.match(page, /fetch\(["']\/api\/trading["'], \{ cache: ["']no-store["'] \}\)/);
  assert.match(page, /\/api\/trading\/signals\/\$\{.*\}\/refresh/);
  assert.match(page, /\/api\/trading\/deliveries\/\$\{.*\}\/retry/);

  assert.doesNotMatch(page, /credentialCiphertext|credentialIv|credentialAuthTag|apiSecretCiphertext/);
});
