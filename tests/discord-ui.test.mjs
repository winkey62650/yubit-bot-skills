import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

function read(pathname) {
  return readFileSync(new URL(pathname, root), "utf8");
}

test("后台导航提供 Discord 社区入口", () => {
  const shell = read("app/components/ConsoleShell.jsx");
  assert.match(shell, /href:\s*"\/discord"/);
  assert.match(shell, /Discord 社区/);
});

test("Discord 页面覆盖连接、初始化、同步与测试闭环", () => {
  const page = read("app/discord/page.jsx");
  assert.match(page, /\/api\/discord/);
  assert.match(page, /安装 Bot/);
  assert.match(page, /Demo Server/);
  assert.match(page, /初始化频道/);
  assert.match(page, /Demo.*目标|同步规则/s);
  assert.match(page, /发送测试消息/);
  assert.match(page, /1-read-first-disclaimer/);
  assert.match(page, /7-yubit-updates/);
});

test("Discord 管理 API 只暴露受控动作", () => {
  const route = read("app/api/discord/route.js");
  assert.match(route, /getDiscordStatus/);
  assert.match(route, /initializeDiscordGuild/);
  assert.match(route, /updateDiscordSettings/);
  assert.match(route, /sendDiscordTestMessage/);
  assert.match(route, /initialize/);
  assert.match(route, /settings/);
  assert.match(route, /test-message/);
  assert.match(route, /initialized/i);
});
