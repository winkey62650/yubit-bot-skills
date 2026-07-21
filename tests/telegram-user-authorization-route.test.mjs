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

test("authorization page keeps Telegram secrets in password fields and browser memory only", async () => {
  const [page, navigation] = await Promise.all([
    readFile(new URL("app/telegram-user-authorization/page.jsx", root), "utf8"),
    readFile(new URL("app/components/ConsoleShell.jsx", root), "utf8")
  ]);

  assert.match(page, /\/api\/telegram\/user-authorization/);
  assert.match(page, /type="password"/);
  assert.match(page, /autoComplete="new-password"/);
  assert.match(page, /autoComplete="one-time-code"/);
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
  assert.match(page, /-1003710405969/);
  assert.match(page, /Demo Academy Forum/);
  assert.match(page, /群名称和群头像/);
  assert.doesNotMatch(page, /Demo Channel/);
  assert.match(navigation, /\/telegram-user-authorization/);
});
