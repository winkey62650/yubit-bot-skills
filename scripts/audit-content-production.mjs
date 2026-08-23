#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CONTENT_PRODUCT_TYPES } from "../lib/content-product-system.mjs";
import { createObsidianContentStore, OBSIDIAN_PRODUCT_DIRECTORIES } from "../lib/obsidian-content-store.mjs";
import { createPostgresClient } from "../lib/postgres-client.mjs";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const PRODUCTION_VAULT_PATH = "/var/lib/yubit-academy/obsidian-vault";
const DISTRIBUTION_PLATFORMS = new Set(["telegram", "discord"]);
const REQUIRED_TELEGRAM_TARGETS = new Set([
  "-1003710405969:8",
  "-1003710405969:10",
  "-1003710405969:16",
]);
const REQUIRED_APPROVED_TARGETS = [...REQUIRED_TELEGRAM_TARGETS].join(",");

function count(rows, label) {
  const value = Number(rows?.[0]?.count);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label} count returned by PostgreSQL`);
  }
  return value;
}

export async function auditContentProduction({
  expectedSha,
  releaseSha,
  deployNoSend,
  telegramDemoOnly,
  tradingDemoOnly,
  approvedTelegramTargets,
  allowLiveTelegram,
  deliveryCountBefore,
  workerStateBefore,
  workerStateAfter,
  discordStateBefore,
  discordStateAfter,
  vaultPath,
  vaultStore = createObsidianContentStore({ vaultPath }),
  query,
} = {}) {
  const failures = [];
  const pushFailure = (code, message) => failures.push({ code, message });

  if (deployNoSend !== "1") {
    pushFailure("DEPLOY_NOT_NO_SEND", "Production content audit requires DEPLOY_NO_SEND=1");
  }
  if (telegramDemoOnly !== "true" || tradingDemoOnly !== "true"
      || approvedTelegramTargets !== REQUIRED_APPROVED_TARGETS || allowLiveTelegram === "true") {
    pushFailure("TELEGRAM_SAFETY_POLICY_MISMATCH", "Telegram production policy is not locked to the DEMO group Topics 8/10/16");
  }
  if (workerStateBefore !== workerStateAfter || discordStateBefore !== discordStateAfter) {
    pushFailure("PUBLISHER_RUNTIME_STATE_CHANGED", "Worker or Discord runtime state changed during the no-send deployment");
  }
  const exactSha = SHA_PATTERN.test(String(expectedSha || ""))
    && SHA_PATTERN.test(String(releaseSha || ""))
    && expectedSha === releaseSha;
  if (!exactSha) {
    pushFailure("RELEASE_SHA_MISMATCH", "The activated release does not match the requested commit");
  }
  if (typeof vaultPath !== "string" || resolve(vaultPath) !== PRODUCTION_VAULT_PATH) {
    pushFailure("OBSIDIAN_VAULT_OUTSIDE_PRODUCTION_ROOT", "The Obsidian vault is outside the persistent production root");
  }

  const vault = await vaultStore.health();
  if (!vault.ready || !vault.writable) {
    pushFailure("OBSIDIAN_VAULT_UNHEALTHY", vault.error || "The Obsidian vault is not ready and writable");
  }
  const expectedProductDirectories = Object.values(OBSIDIAN_PRODUCT_DIRECTORIES);
  if (JSON.stringify(vault.productDirectories) !== JSON.stringify(expectedProductDirectories)) {
    pushFailure("OBSIDIAN_PRODUCT_STRUCTURE_MISMATCH", "The production vault does not expose the four required content product directories");
  }

  if (typeof query !== "function") {
    throw new TypeError("auditContentProduction requires a read-only PostgreSQL query function");
  }
  const ruleCount = count(
    await query("SELECT count(*)::text AS count FROM distribution_rules"),
    "distribution rule",
  );
  const deliveryCount = count(
    await query("SELECT count(*)::text AS count FROM distribution_deliveries"),
    "distribution delivery",
  );
  const parsedDeliveryCountBefore = Number(deliveryCountBefore);
  if (!Number.isSafeInteger(parsedDeliveryCountBefore) || parsedDeliveryCountBefore < 0) {
    pushFailure("INVALID_DELIVERY_BASELINE", "The pre-activation delivery receipt baseline is invalid");
  } else if (deliveryCount !== parsedDeliveryCountBefore) {
    pushFailure("DELIVERIES_CREATED_DURING_DEPLOY", "Delivery receipt count changed during the no-send deployment");
  }
  const targetRows = await query(
    `SELECT platform, chat_id AS "chatId", thread_id::text AS "threadId", guild_id AS "guildId", channel_id AS "channelId"
       FROM distribution_targets WHERE enabled = true
       ORDER BY platform, chat_id, thread_id, guild_id, channel_id`,
  );
  const enabledTargetsByPlatform = {};
  for (const row of targetRows ?? []) {
    const platform = String(row?.platform ?? "").trim().toLowerCase();
    if (!platform) throw new Error("Invalid enabled distribution target returned by PostgreSQL");
    enabledTargetsByPlatform[platform] = (enabledTargetsByPlatform[platform] ?? 0) + 1;
    if (!DISTRIBUTION_PLATFORMS.has(platform)) {
      pushFailure("UNSUPPORTED_DISTRIBUTION_PLATFORM", `Enabled distribution platform is not approved: ${platform}`);
    } else if (platform === "telegram") {
      const targetKey = `${String(row?.chatId ?? "")}:${String(row?.threadId ?? "")}`;
      if (!REQUIRED_TELEGRAM_TARGETS.has(targetKey)) {
        pushFailure("UNAPPROVED_TELEGRAM_TARGET", `Enabled Telegram target is outside the DEMO allowlist: ${targetKey}`);
      }
    }
  }
  if (ruleCount < 1) {
    pushFailure("DISTRIBUTION_RULES_MISSING", "PostgreSQL contains no distribution rules");
  }

  return {
    schema: "yubit-content-production-audit/v1",
    ok: failures.length === 0,
    mode: "no-send-read-only",
    auditMutationsPerformed: false,
    remoteMutationsPerformed: false,
    release: { expectedSha, releaseSha, exactSha },
    products: [...CONTENT_PRODUCT_TYPES],
    vault,
    database: {
      ruleCount,
      deliveryCount,
      deliveryCountBefore: parsedDeliveryCountBefore,
      deliveryDelta: Number.isSafeInteger(parsedDeliveryCountBefore) ? deliveryCount - parsedDeliveryCountBefore : null,
      enabledTargetsByPlatform,
    },
    runtime: { workerStateBefore, workerStateAfter, discordStateBefore, discordStateAfter },
    failures,
  };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL or POSTGRES_URL is required");
  const client = createPostgresClient(databaseUrl);
  try {
    const report = await auditContentProduction({
      expectedSha: process.env.EXPECTED_COMMIT,
      releaseSha: process.env.APP_RELEASE_SHA,
      deployNoSend: process.env.DEPLOY_NO_SEND,
      telegramDemoOnly: process.env.TELEGRAM_DEMO_ONLY,
      tradingDemoOnly: process.env.TRADING_DEMO_ONLY,
      approvedTelegramTargets: process.env.TELEGRAM_DISTRIBUTION_APPROVED_TARGETS,
      allowLiveTelegram: process.env.ALLOW_LIVE_TELEGRAM,
      deliveryCountBefore: process.env.DELIVERY_COUNT_BEFORE,
      workerStateBefore: process.env.WORKER_STATE_BEFORE,
      workerStateAfter: process.env.WORKER_STATE_AFTER,
      discordStateBefore: process.env.DISCORD_STATE_BEFORE,
      discordStateAfter: process.env.DISCORD_STATE_AFTER,
      vaultPath: process.env.OBSIDIAN_VAULT_PATH,
      query: (statement) => client.query(statement),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    await client.close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
