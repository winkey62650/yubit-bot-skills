import assert from "node:assert/strict";
import test from "node:test";

import { JsonTradingRepository } from "../lib/trading-repository.mjs";
import {
  getTradingHealth,
  sanitizeTradingResponse,
  saveExchangeAccount,
  saveTrader,
  saveTradingDestination,
  testTradingDestination,
  verifyExchangeAccount,
  verifyTradingDestination,
} from "../lib/trading-service.mjs";

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const SPEAKER_TOKEN = "123456:telegram-speaker-secret";

function memoryRepository(now = () => new Date("2026-07-16T08:00:00.000Z")) {
  let value;
  const repository = new JsonTradingRepository({
    now,
    readJsonImpl: async (_path, fallback) => value == null ? structuredClone(fallback) : structuredClone(value),
    writeJsonImpl: async (_path, next) => {
      value = structuredClone(next);
      return next;
    },
  });
  return { repository, readState: () => structuredClone(value) };
}

function dependencies(repository, overrides = {}) {
  return {
    repository,
    env: {
      TRADER_CREDENTIALS_ENCRYPTION_KEY: ENCRYPTION_KEY,
      SPEAKER_BOT_TOKEN: SPEAKER_TOKEN,
      ...overrides.env,
    },
    now: () => new Date("2026-07-16T08:00:00.000Z"),
    ...overrides,
  };
}

test("Trader management validates numeric Telegram ids and writes a secret-safe audit trail", async () => {
  const { repository } = memoryRepository();
  const trader = await saveTrader({
    displayName: "Alice",
    telegramUserId: "123456789",
    telegramUsername: "@alice",
  }, dependencies(repository));

  assert.equal(trader.telegramUserId, "123456789");
  assert.equal(trader.telegramUsername, "alice");
  await assert.rejects(
    saveTrader({ displayName: "Bad", telegramUserId: "@alice" }, dependencies(repository)),
    /数字 ID/,
  );

  const audit = await repository.getMeta("trading-admin-audit");
  assert.equal(audit.at(-1).action, "save-trader");
  assert.equal(audit.at(-1).targetId, trader.id);
  assert.doesNotMatch(JSON.stringify(audit), /telegram-speaker-secret|apiSecret|ciphertext/i);
});

test("account creation encrypts credentials, links selected Traders, and returns only safe fields", async () => {
  const { repository, readState } = memoryRepository();
  const traderA = await repository.saveTrader({ displayName: "Alice", telegramUserId: "1001" });
  const traderB = await repository.saveTrader({ displayName: "Bob", telegramUserId: "1002" });
  const apiKey = "public-api-key-12345678";
  const apiSecret = "private-api-secret-never-return";

  const result = await saveExchangeAccount({
    label: "Shared Trading Desk",
    apiKey,
    apiSecret,
    traderIds: [traderA.id, traderB.id],
  }, dependencies(repository));

  assert.equal(result.account.apiKeyMasked, "publ***************5678");
  assert.deepEqual(result.traderIds.sort(), [traderA.id, traderB.id].sort());
  assert.equal((await repository.listAccountsForTrader(traderA.id))[0].id, result.account.id);
  assert.equal((await repository.listAccountsForTrader(traderB.id))[0].id, result.account.id);

  const responseText = JSON.stringify(result);
  for (const forbidden of [apiKey, apiSecret, "credentialCiphertext", "credentialIv", "credentialAuthTag", "ciphertext", "authTag"]) {
    assert.equal(responseText.includes(forbidden), false, `response leaked ${forbidden}`);
  }
  const stored = readState().accounts[0];
  assert.notEqual(stored.credentialCiphertext, apiSecret);
  assert.equal(JSON.stringify(stored).includes(apiSecret), false);
});

test("account verification decrypts server-side credentials and performs a read-only order-history check", async () => {
  const { repository } = memoryRepository();
  const account = await saveExchangeAccount({
    label: "Verification Desk",
    apiKey: "verification-key-1234",
    apiSecret: "verification-secret-5678",
    traderIds: [],
  }, dependencies(repository));
  const calls = [];

  const result = await verifyExchangeAccount({ accountId: account.account.id, symbol: "btcusdt" }, dependencies(repository, {
    yubitClientFactory: (credentials) => {
      calls.push(credentials);
      return {
        async getOrderHistory(input) {
          calls.push(input);
          return { list: [] };
        },
      };
    },
  }));

  assert.deepEqual(calls[0], {
    apiKey: "verification-key-1234",
    apiSecret: "verification-secret-5678",
  });
  assert.deepEqual(calls[1], { symbol: "BTCUSDT", limit: 1 });
  assert.equal(result.account.status, "verified");
  assert.equal(result.account.lastVerifiedAt, "2026-07-16T08:00:00.000Z");
  assert.equal(JSON.stringify(result).includes("verification-secret-5678"), false);
});

test("destination management prevents duplicates, validates permissions, and sends through SpeakerBot", async () => {
  const { repository } = memoryRepository();
  const destination = await saveTradingDestination({
    scopeType: "workspace",
    chatId: "-1001234567890",
    threadId: 42,
    chatTitle: "Demo Academy",
    topicTitle: "Trading Zone",
  }, dependencies(repository));
  await assert.rejects(
    saveTradingDestination({ scopeType: "workspace", chatId: "-1001234567890", threadId: 42 }, dependencies(repository)),
    /已存在/,
  );

  const calls = [];
  const telegram = async (botToken, method, payload) => {
    calls.push({ botToken, method, payload });
    if (method === "getMe") return { id: 77, username: "Satoshi_geniustrader_bot" };
    if (method === "getChat") return { id: payload.chat_id, title: "Demo Academy", type: "supergroup", is_forum: true };
    if (method === "getChatMember") return { status: "administrator", can_post_messages: true };
    if (method === "sendChatAction") return true;
    if (method === "sendMessage") return { message_id: 9001 };
    throw new Error(`unexpected ${method}`);
  };
  const deps = dependencies(repository, { telegram });

  const verified = await verifyTradingDestination(destination.id, deps);
  assert.equal(verified.ok, true);
  assert.equal(verified.destination.lastVerifiedAt, "2026-07-16T08:00:00.000Z");
  const sent = await testTradingDestination(destination.id, deps);
  assert.equal(sent.telegramMessageId, 9001);
  assert.equal(calls.find((call) => call.method === "sendMessage").payload.message_thread_id, 42);
  assert.ok(calls.every((call) => call.botToken === SPEAKER_TOKEN));
});

test("health summarizes database, SpeakerBot webhook, scheduler, accounts, and destinations without secrets", async () => {
  const { repository } = memoryRepository();
  await saveExchangeAccount({
    label: "Health Desk",
    apiKey: "health-api-key-123456",
    apiSecret: "health-api-secret-never-show",
    traderIds: [],
  }, dependencies(repository));
  await saveTradingDestination({ scopeType: "workspace", chatId: "-1001", threadId: 7 }, dependencies(repository));
  await repository.setMeta("trading-reconcile", {
    lastRunAt: "2026-07-16T07:55:00.000Z",
    nextRunAt: "2026-07-16T08:00:00.000Z",
    error: null,
  });
  const telegram = async (_botToken, method) => {
    if (method === "getMe") return { id: 77, username: "speaker_test_bot" };
    if (method === "getWebhookInfo") return { url: "https://example.test/api/telegram/speaker-webhook", pending_update_count: 0 };
    throw new Error(`unexpected ${method}`);
  };

  const result = await getTradingHealth(dependencies(repository, { telegram }));
  assert.equal(result.database.ok, true);
  assert.equal(result.speakerBot.ok, true);
  assert.equal(result.speakerBot.webhookConfigured, true);
  assert.equal(result.scheduler.lastRunAt, "2026-07-16T07:55:00.000Z");
  assert.equal(result.accounts.length, 1);
  assert.equal(result.destinations.length, 1);
  const responseText = JSON.stringify(result);
  assert.equal(responseText.includes(SPEAKER_TOKEN), false);
  assert.equal(responseText.includes("health-api-secret-never-show"), false);
  assert.equal(/ciphertext|authTag|credentialIv/i.test(responseText), false);
});

test("sanitizeTradingResponse recursively removes secret fields and exact secret values", () => {
  const apiKey = "leaky-api-key";
  const secret = "leaky-api-secret";
  const webhook = "leaky-webhook-token";
  const result = sanitizeTradingResponse({
    ok: false,
    apiKey,
    apiKeyMasked: "leak***-key",
    nested: {
      apiSecret: secret,
      credentialCiphertext: "encrypted-value",
      credentialIv: "iv-value",
      credentialAuthTag: "tag-value",
      message: `request failed for ${apiKey} with ${secret} and ${webhook}`,
      rows: [{ botToken: webhook, lastErrorCode: "YUBIT_TIMEOUT" }],
    },
  }, [apiKey, secret, webhook]);

  assert.equal(result.apiKey, undefined);
  assert.equal(result.apiKeyMasked, "leak***-key");
  assert.equal(result.nested.apiSecret, undefined);
  assert.equal(result.nested.credentialCiphertext, undefined);
  assert.equal(result.nested.rows[0].botToken, undefined);
  assert.equal(result.nested.rows[0].lastErrorCode, "YUBIT_TIMEOUT");
  assert.equal(result.nested.message, "request failed for [REDACTED] with [REDACTED] and [REDACTED]");
});
