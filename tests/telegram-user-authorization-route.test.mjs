import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Telegram user authorization API is protected, node-only, and never returns raw errors", async () => {
  const [route, middleware] = await Promise.all([
    readFile(new URL("app/api/telegram/user-authorization/route.js", root), "utf8"),
    readFile(new URL("middleware.js", root), "utf8")
  ]);

  assert.match(route, /runtime\s*=\s*["']nodejs["']/);
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function POST/);
  assert.match(route, /createTelegramUserWebAuthorization/);
  assert.doesNotMatch(route, /console\./);
  assert.doesNotMatch(route, /error\?\.message|error\.message/);
  assert.doesNotMatch(middleware, /publicPaths[^;]*telegram\/user-authorization/);
});

test("publisher page reflects the multi-account login workflow", async () => {
  const [page, navigation] = await Promise.all([
    readFile(new URL("app/telegram-user-authorization/page.jsx", root), "utf8"),
    readFile(new URL("app/components/ConsoleShell.jsx", root), "utf8")
  ]);

  assert.match(page, /\/api\/telegram\/user-authorization/);
  assert.match(page, /添加 Telegram 账号/);
  assert.match(page, /已授权账号/);
  assert.match(page, /本机发布桥/);
  assert.match(page, /buildPublisherStatusChecks/);
  assert.match(page, /后台能力组件/);
  assert.match(page, /验证码/);
  assert.match(page, /type="password"/);
  assert.match(page, /-1003710405969/);
  assert.match(page, /Demo Academy Forum/);
  assert.match(page, /群名称和群头像/);
  assert.doesNotMatch(page, /Demo Channel/);
  assert.match(navigation, /\/telegram-user-authorization/);
  assert.match(navigation, /发布账号状态检测/);
});
