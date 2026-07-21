import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveDiscoveredGroups } from "../lib/group-config-policy.mjs";

test("group config reads are always dynamic so saved topic counts do not go stale", async () => {
  const source = await readFile(new URL("../app/api/group-config/route.js", import.meta.url), "utf8");
  assert.match(source, /export const dynamic = ["']force-dynamic["']/);
});

test("chat API exposes a direct server-side group verification endpoint", async () => {
  const source = await readFile(new URL("../app/api/chats/route.js", import.meta.url), "utf8");
  assert.match(source, /export async function POST/);
  assert.match(source, /probeGroupByChatId/);
});

test("group config UI can verify and save a group by chat id without a local Telegram login", async () => {
  const source = await readFile(new URL("../app/group-config/page.jsx", import.meta.url), "utf8");
  assert.match(source, /按群 ID 检测并保存/);
  assert.match(source, /method:\s*["']POST["']/);
  assert.match(source, /无需在这台 Mac 登录/);
});

test("group config shows SpeakerBot as the active Bot API publisher", async () => {
  const source = await readFile(new URL("../app/group-config/page.jsx", import.meta.url), "utf8");
  assert.match(source, /setPublisher/);
  assert.match(source, /\/api\/distribution/);
  assert.match(source, /@Satoshi_geniustrader_bot/);
  assert.match(source, /SpeakerBot/);
  assert.match(source, /Bot API/);
  assert.match(source, /显示 Channel 名称和头像/);
  assert.doesNotMatch(source, /Bot API 备用发帖权限/);
  assert.doesNotMatch(source, /@Serenity_Crypto/);
});

test("group config persistence keeps channel identity and publishing permissions", async () => {
  const source = await readFile(new URL("../app/api/group-config/route.js", import.meta.url), "utf8");
  assert.match(source, /isPrivateChannel/);
  assert.match(source, /channelPublishingReady/);
  assert.match(source, /distributionReady/);
  assert.match(source, /canPostMessages/);
  assert.match(source, /canEditMessages/);
});

test("a transient empty Telegram discovery never erases the last saved group configuration", () => {
  const existing = [{ chatId: "-1001", title: "CryptoGuy Academy" }];

  assert.deepEqual(resolveDiscoveredGroups(existing, []), {
    groups: existing,
    preservedExisting: true
  });
  assert.deepEqual(resolveDiscoveredGroups(existing, [{ chatId: "-1002", title: "DEMO Academy" }]), {
    groups: [{ chatId: "-1002", title: "DEMO Academy" }],
    preservedExisting: false
  });
});
