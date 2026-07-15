import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const mockFetch = new URL("./helpers/mock-telegram-fetch.mjs", import.meta.url).pathname;

test("safe new-group check reads real Telegram state without running mutations", () => {
  const result = runSetup();
  const methods = readFileSync(result.logPath, "utf8").trim().split("\n").filter(Boolean);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(methods, ["getMe", "getChat", "getChatMember", "getForumTopicIconStickers"]);
  assert.doesNotMatch(methods.join("\n"), /setChatTitle|createForumTopic|sendMessage/);
});

test("safe new-group check rejects a Telegram chat that does not exist", () => {
  const result = runSetup({ MOCK_TELEGRAM_CHAT: "missing" });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /chat not found/i);
});

test("safe new-group check rejects incomplete AdminBot permissions", () => {
  const result = runSetup({ MOCK_TELEGRAM_PERMISSION: "missing_pin" });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Pin Messages/i);
});

test("safe new-group check stops after bounded Telegram network retries", () => {
  const result = runSetup({
    MOCK_TELEGRAM_NETWORK: "offline",
    TELEGRAM_NETWORK_MAX_ATTEMPTS: "1"
  });

  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /network error.*1 attempt/i);
});

test("new-group UI includes Telegram stderr in the operator result", () => {
  const source = readFileSync(new URL("../app/new-group/page.jsx", import.meta.url), "utf8");

  assert.match(source, /data\.stderr/);
});

test("new-group UI never restores or persists production mode from a cloud draft", () => {
  const source = readFileSync(new URL("../app/new-group/page.jsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /setDryRun\(savedDraft\.dryRun !== false\)/);
  assert.match(source, /saveWorkspaceState\("new-group", \{[\s\S]*?dryRun: true,/);
  assert.match(source, /finally \{[\s\S]*?setDryRun\(true\);/);
});

test("new-group UI verifies the entered chat id through all three server-side bots before setup", () => {
  const source = readFileSync(new URL("../app/new-group/page.jsx", import.meta.url), "utf8");

  assert.match(source, /verifyEnteredGroup/);
  assert.match(source, /fetch\("\/api\/chats"/);
  assert.match(source, /verifiedGroup\.readyForInitialization/);
  assert.match(source, /无需在这台 Mac 登录/);
});

test("new-group UI never presents stale draft identity as an already recognized group", () => {
  const source = readFileSync(new URL("../app/new-group/page.jsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /setGroupName\(savedDraft\.groupName/);
  assert.doesNotMatch(source, /setChatId\(savedDraft\.chatId/);
  assert.match(source, /正在读取 Telegram 群/);
  assert.match(source, /setGroupName\(preferred\.title\)/);
});

function runSetup(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "yubit-setup-test-"));
  const configPath = join(dir, "config.json");
  const logPath = join(dir, "telegram-methods.log");
  writeFileSync(configPath, JSON.stringify({ topics: [] }));
  writeFileSync(logPath, "");

  const result = spawnSync(process.execPath, [
    "--import",
    mockFetch,
    "setup-telegram-community.mjs"
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_CHAT_ID: "-1001234567890",
      YUBIT_TG_CONFIG: configPath,
      DRY_RUN: "true",
      MOCK_TELEGRAM_LOG: logPath
    },
    timeout: 1500
  });

  return { ...result, logPath };
}
