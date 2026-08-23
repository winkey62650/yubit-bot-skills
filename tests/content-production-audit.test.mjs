import assert from "node:assert/strict";
import test from "node:test";
import { auditContentProduction } from "../scripts/audit-content-production.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function healthyOptions(overrides = {}) {
  return {
    expectedSha: SHA,
    releaseSha: SHA,
    deployNoSend: "1",
    telegramDemoOnly: "true",
    tradingDemoOnly: "true",
    approvedTelegramTargets: "-1003710405969:8,-1003710405969:10,-1003710405969:16",
    allowLiveTelegram: "false",
    deliveryCountBefore: "17",
    workerStateBefore: "ActiveState=inactive\nSubState=dead\nMainPID=0",
    workerStateAfter: "ActiveState=inactive\nSubState=dead\nMainPID=0",
    discordStateBefore: "ActiveState=active\nSubState=running\nMainPID=42",
    discordStateAfter: "ActiveState=active\nSubState=running\nMainPID=42",
    vaultPath: "/var/lib/yubit-academy/obsidian-vault",
    vaultStore: {
      async health() {
        return {
          ready: true,
          writable: true,
          checkedDirectories: 13,
          productDirectories: [
            "30 Products/Daily Market Brief",
            "30 Products/Weekly Catalyst Calendar",
            "30 Products/Data Flash",
            "30 Products/Market Follow-up",
          ],
        };
      },
    },
    query: async (statement) => {
      if (statement.includes("distribution_rules")) return [{ count: "4" }];
      if (statement.includes("distribution_deliveries")) return [{ count: "17" }];
      if (statement.includes("distribution_targets")) return [
        { platform: "telegram", chatId: "-1003710405969", threadId: "8" },
        { platform: "telegram", chatId: "-1003710405969", threadId: "10" },
        { platform: "telegram", chatId: "-1003710405969", threadId: "16" },
        { platform: "discord", guildId: "guild", channelId: "one" },
        { platform: "discord", guildId: "guild", channelId: "two" },
      ];
      throw new Error(`unexpected query: ${statement}`);
    },
    ...overrides,
  };
}

test("read-only production audit validates exact SHA, vault, database, and receipt count", async () => {
  const statements = [];
  const report = await auditContentProduction(healthyOptions({
    query: async (statement) => {
      statements.push(statement);
      if (statement.includes("distribution_rules")) return [{ count: "4" }];
      if (statement.includes("distribution_deliveries")) return [{ count: "17" }];
      return healthyOptions().query(statement);
    },
  }));

  assert.equal(report.ok, true);
  assert.equal(report.mode, "no-send-read-only");
  assert.equal(report.release.exactSha, true);
  assert.equal(report.vault.ready, true);
  assert.equal(report.database.ruleCount, 4);
  assert.equal(report.database.deliveryCount, 17);
  assert.equal(report.database.deliveryDelta, 0);
  assert.deepEqual(report.database.enabledTargetsByPlatform, { discord: 2, telegram: 3 });
  assert.deepEqual(report.products, [
    "daily-market-brief",
    "weekly-catalyst-calendar",
    "data-flash",
    "market-follow-up",
  ]);
  assert.equal(report.remoteMutationsPerformed, false);
  assert.equal(statements.length, 3);
  assert.ok(statements.every((statement) => /^SELECT\b/i.test(statement.trim())));
});

test("audit fails closed for mismatched SHA, writable-send mode, or unhealthy vault", async () => {
  const report = await auditContentProduction(healthyOptions({
    releaseSha: "ffffffffffffffffffffffffffffffffffffffff",
    deployNoSend: "0",
    vaultStore: {
      async health() {
        return { ready: false, writable: false, productDirectories: [], error: "missing index" };
      },
    },
  }));

  assert.equal(report.ok, false);
  assert.deepEqual(report.failures.map((entry) => entry.code), [
    "DEPLOY_NOT_NO_SEND",
    "RELEASE_SHA_MISMATCH",
    "OBSIDIAN_VAULT_UNHEALTHY",
    "OBSIDIAN_PRODUCT_STRUCTURE_MISMATCH",
  ]);
  assert.equal(report.remoteMutationsPerformed, false);
});

test("audit requires a confined production vault and at least one distribution rule", async () => {
  const report = await auditContentProduction(healthyOptions({
    vaultPath: "/tmp/content-vault",
    query: async (statement) => {
      if (statement.includes("distribution_rules")) return [{ count: "0" }];
      if (statement.includes("distribution_deliveries")) return [{ count: "17" }];
      return healthyOptions().query(statement);
    },
  }));

  assert.equal(report.ok, false);
  assert.deepEqual(report.failures.map((entry) => entry.code), [
    "OBSIDIAN_VAULT_OUTSIDE_PRODUCTION_ROOT",
    "DISTRIBUTION_RULES_MISSING",
  ]);
});

test("audit rejects traversal-like vault paths and unsupported enabled platforms", async () => {
  const report = await auditContentProduction(healthyOptions({
    vaultPath: "/var/lib/yubit-academy/../outside-vault",
    query: async (statement) => {
      if (statement.includes("distribution_rules")) return [{ count: "4" }];
      if (statement.includes("distribution_deliveries")) return [{ count: "17" }];
      if (statement.includes("distribution_targets")) return [
        { platform: "telegram", chatId: "-1003710405969", threadId: "8" },
        { platform: "slack", channelId: "legacy" },
      ];
      throw new Error(`unexpected query: ${statement}`);
    },
  }));

  assert.equal(report.ok, false);
  assert.deepEqual(report.failures.map((entry) => entry.code), [
    "OBSIDIAN_VAULT_OUTSIDE_PRODUCTION_ROOT",
    "UNSUPPORTED_DISTRIBUTION_PLATFORM",
  ]);
});

test("audit fails closed when deployment creates receipts, changes publishers, or exposes a broad Telegram target", async () => {
  const report = await auditContentProduction(healthyOptions({
    deliveryCountBefore: "16",
    discordStateAfter: "ActiveState=inactive\nSubState=dead\nMainPID=0",
    query: async (statement) => {
      if (statement.includes("distribution_rules")) return [{ count: "4" }];
      if (statement.includes("distribution_deliveries")) return [{ count: "17" }];
      return [{ platform: "telegram", chatId: "-1003710405969", threadId: null }];
    },
  }));

  assert.equal(report.ok, false);
  assert.deepEqual(report.failures.map((entry) => entry.code), [
    "PUBLISHER_RUNTIME_STATE_CHANGED",
    "DELIVERIES_CREATED_DURING_DEPLOY",
    "UNAPPROVED_TELEGRAM_TARGET",
  ]);
});
