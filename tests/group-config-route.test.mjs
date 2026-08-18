import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { removeTelegramGroupRecords, resolveDiscoveredGroups } from "../lib/group-config-policy.mjs";

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
  assert.match(source, /@Serenity_Crypto → 已授权群组 → Topic → 自动发布/);
  assert.match(source, /AdminBot/);
  assert.doesNotMatch(source, /三个 Bot 管理员|请确认三个 Bot 已加入|服务器上的三个 Bot/);
});

test("group config automatically persists a successful live Telegram reconciliation", async () => {
  const source = await readFile(new URL("../app/group-config/page.jsx", import.meta.url), "utf8");
  assert.match(source, /refreshLiveGroups\(\{ silent: true, persist: true \}\)/);
});

test("group config shows the user publisher and official Forum group identity", async () => {
  const source = await readFile(new URL("../app/group-config/page.jsx", import.meta.url), "utf8");
  assert.match(source, /setPublisher/);
  assert.match(source, /\/api\/distribution/);
  assert.match(source, /@Serenity_Crypto/);
  assert.match(source, /群名称和群头像/);
  assert.match(source, /匿名管理员/);
  assert.match(source, /Demo Academy 已授权/);
  assert.match(source, /本机发布桥离线/);
  assert.doesNotMatch(source, /待复核本群白名单/);
  assert.doesNotMatch(source, /群已在白名单，发布授权待恢复/);
  assert.match(source, /当前不作为出站目标/);
  assert.doesNotMatch(source, /并由 SpeakerBot 执行发布/);
  assert.doesNotMatch(source, /Channel 内容分发/);
  assert.doesNotMatch(source, /显示 Channel 名称和头像/);
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

test("a membership refresh cannot erase previously verified Topic thread IDs", () => {
  const existing = [{
    chatId: "-1001",
    title: "Old title",
    topics: [{ name: "3. Market Events", threadId: 8, verified: true }]
  }];
  const discovered = [{
    chatId: "-1001",
    title: "DEMO Academy",
    botCount: 3,
    topics: [{ name: "3. Market Events", threadId: null, verified: false }]
  }];

  assert.deepEqual(resolveDiscoveredGroups(existing, discovered), {
    groups: [{
      chatId: "-1001",
      title: "DEMO Academy",
      botCount: 3,
      topics: [{ name: "3. Market Events", threadId: 8, verified: true }]
    }],
    preservedExisting: false
  });
});

test("deleting Telegram destinations removes exact chat ids from saved config and discovery cache", () => {
  const chatIds = ["-1003862539988", "-1004499214183"];
  const groupConfig = {
    schemaVersion: 2,
    groups: [
      { chatId: "-1003710405969", title: "DEMO Academy", type: "supergroup" },
      { chatId: "-1003862539988", title: "DEMO Academy", type: "channel" },
      { chatId: "-1004499214183", title: "-test", type: "supergroup" }
    ],
    bindings: [{ id: "keep", group: "Other Group", topic: "News", config: "x" }]
  };
  const registry = {
    schemaVersion: 1,
    groups: [
      { chatId: "-1003710405969", title: "DEMO Academy" },
      { chatId: "-1003862539988", title: "DEMO Academy" },
      { chatId: "-1004499214183", title: "-test" }
    ]
  };

  assert.deepEqual(removeTelegramGroupRecords(groupConfig, registry, chatIds), {
    groupConfig: {
      ...groupConfig,
      groups: [{ chatId: "-1003710405969", title: "DEMO Academy", type: "supergroup" }]
    },
    registry: {
      ...registry,
      groups: [{ chatId: "-1003710405969", title: "DEMO Academy" }]
    },
    removed: {
      groupConfig: ["-1003862539988", "-1004499214183"],
      registry: ["-1003862539988", "-1004499214183"]
    }
  });
});

test("group config route exposes an exact-id deletion action", async () => {
  const source = await readFile(new URL("../app/api/group-config/route.js", import.meta.url), "utf8");
  assert.match(source, /body\.action === ["']delete["']/);
  assert.match(source, /removeTelegramGroupRecords/);
  assert.match(source, /telegram-group-registry\.json/);
});
