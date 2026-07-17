import assert from "node:assert/strict";
import test from "node:test";

import { JsonTradingRepository } from "../lib/trading-repository.mjs";
import {
  configureSpeakerWebhook,
  getTradingHealth,
  getTradingManagementOverview,
  getTradingSignalDetail,
  processSpeakerTelegramUpdate,
  refreshTradingSignal,
  retryTradingDelivery,
  runTradingReconciliation,
  sanitizeTradingResponse,
  saveExchangeAccount,
  saveTrader,
  saveTradingDestination,
  testTradingDestination,
  tradingErrorStatus,
  verifyExchangeAccount,
  verifyTradingDestination,
  verifySpeakerWebhookSecret,
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
    ...overrides,
    env: {
      TRADER_CREDENTIALS_ENCRYPTION_KEY: ENCRYPTION_KEY,
      SPEAKER_BOT_TOKEN: SPEAKER_TOKEN,
      ...overrides.env,
    },
    now: () => new Date("2026-07-16T08:00:00.000Z"),
    ...(overrides.now ? { now: overrides.now } : {}),
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

test("a successful YUBIT re-verification clears the previous validation error", async () => {
  const { repository } = memoryRepository();
  const account = await saveExchangeAccount({
    label: "Recovered Desk",
    apiKey: "recovered-key-1234",
    apiSecret: "recovered-secret-5678",
    traderIds: [],
  }, dependencies(repository));
  let shouldFail = true;
  const deps = dependencies(repository, {
    yubitClientFactory: () => ({
      async getOrderHistory() {
        if (shouldFail) throw new Error("YUBIT_API_ERROR:26200004");
        return { list: [] };
      },
    }),
  });

  await assert.rejects(
    verifyExchangeAccount({ accountId: account.account.id, symbol: "BTCUSDT" }, deps),
    /26200004/,
  );
  assert.equal((await repository.getAccount(account.account.id)).status, "invalid");
  assert.equal((await repository.getAccount(account.account.id)).lastErrorCode, "YUBIT_API_ERROR:26200004");

  shouldFail = false;
  const recovered = await verifyExchangeAccount({ accountId: account.account.id, symbol: "BTCUSDT" }, deps);
  assert.equal(recovered.account.status, "verified");
  assert.equal(recovered.account.lastErrorCode, null);
  assert.equal((await repository.getAccount(account.account.id)).lastErrorCode, null);
});

test("account credentials ignore accidental copy whitespace before YUBIT verification", async () => {
  const { repository } = memoryRepository();
  const account = await saveExchangeAccount({
    label: "Copied Credentials",
    apiKey: "  copied-key-1234\n",
    apiSecret: "\t copied-secret-5678 \r\n",
    traderIds: [],
  }, dependencies(repository));
  const credentialsSeen = [];

  await verifyExchangeAccount({ accountId: account.account.id, symbol: "BTCUSDT" }, dependencies(repository, {
    yubitClientFactory: (credentials) => {
      credentialsSeen.push(credentials);
      return {
        async getOrderHistory() {
          return { list: [] };
        },
      };
    },
  }));

  assert.deepEqual(credentialsSeen[0], {
    apiKey: "copied-key-1234",
    apiSecret: "copied-secret-5678",
  });
});

test("account save cannot bypass YUBIT verification by assigning a verified status", async () => {
  const { repository } = memoryRepository();
  const created = await saveExchangeAccount({
    label: "Unverified Desk",
    apiKey: "unverified-key-1234",
    apiSecret: "unverified-secret-5678",
    traderIds: [],
  }, dependencies(repository));

  const edited = await saveExchangeAccount({
    id: created.account.id,
    label: "Unverified Desk",
    status: "verified",
    traderIds: [],
  }, dependencies(repository));

  assert.equal(edited.account.status, "pending");
  assert.equal(edited.account.lastVerifiedAt, null);
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

  const result = await getTradingHealth(dependencies(repository, {
    env: {
      APP_BASE_URL: "https://example.test",
      CRON_SECRET: "configured-cron-secret",
      SPEAKER_TELEGRAM_WEBHOOK_SECRET: "speaker-webhook-secret",
    },
    telegram,
  }));
  assert.equal(result.database.ok, true);
  assert.equal(result.speakerBot.ok, true);
  assert.equal(result.speakerBot.webhookConfigured, true);
  assert.equal(result.speakerBot.webhookMatchesDeployment, true);
  assert.equal(result.speakerBot.configurationAllowed, true);
  assert.equal(result.scheduler.configured, true);
  assert.equal(result.scheduler.ok, true);
  assert.equal(result.scheduler.lastRunAt, "2026-07-16T07:55:00.000Z");
  assert.equal(result.accounts.length, 1);
  assert.equal(result.destinations.length, 1);
  const responseText = JSON.stringify(result);
  assert.equal(responseText.includes(SPEAKER_TOKEN), false);
  assert.equal(responseText.includes("health-api-secret-never-show"), false);
  assert.equal(/ciphertext|authTag|credentialIv/i.test(responseText), false);
});

test("health marks the scheduler unready when CRON_SECRET is missing", async () => {
  const { repository } = memoryRepository();
  const result = await getTradingHealth(dependencies(repository, {
    env: {
      APP_BASE_URL: "https://example.test",
      SPEAKER_TELEGRAM_WEBHOOK_SECRET: "speaker-webhook-secret",
    },
    telegram: async (_token, method) => {
      if (method === "getMe") return { id: 77, username: "speaker_test_bot" };
      if (method === "getWebhookInfo") return { url: "https://example.test/api/telegram/speaker-webhook" };
      throw new Error(`unexpected ${method}`);
    },
  }));

  assert.equal(result.scheduler.configured, false);
  assert.equal(result.scheduler.ok, false);
  assert.equal(result.scheduler.errorCode, "CRON_SECRET_REQUIRED");
  assert.equal(JSON.stringify(result).includes("configured-cron-secret"), false);
});

test("sanitizeTradingResponse recursively removes secret fields and exact secret values", () => {
  const apiKey = "leaky-api-key";
  const secret = "leaky-api-secret";
  const webhook = "leaky-webhook-token";
  const result = sanitizeTradingResponse({
    ok: false,
    apiKey,
    apiKeyMasked: "leak***-key",
    lastVerifiedAt: new Date("2026-07-17T05:00:00.000Z"),
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
  assert.equal(result.lastVerifiedAt, "2026-07-17T05:00:00.000Z");
  assert.equal(result.nested.apiSecret, undefined);
  assert.equal(result.nested.credentialCiphertext, undefined);
  assert.equal(result.nested.rows[0].botToken, undefined);
  assert.equal(result.nested.rows[0].lastErrorCode, "YUBIT_TIMEOUT");
  assert.equal(result.nested.message, "request failed for [REDACTED] with [REDACTED] and [REDACTED]");
});

test("SpeakerBot webhook secret verification fails closed", () => {
  assert.equal(verifySpeakerWebhookSecret("same-secret", "same-secret"), true);
  assert.equal(verifySpeakerWebhookSecret("", ""), false);
  assert.equal(verifySpeakerWebhookSecret("short", "different-length"), false);
  assert.equal(verifySpeakerWebhookSecret("same-secret", "other-secret"), false);
});

test("management errors map to safe operator HTTP statuses", () => {
  assert.equal(tradingErrorStatus(Object.assign(new Error("explicit"), { statusCode: 418 })), 418);
  assert.equal(tradingErrorStatus(new Error("Trader 不存在")), 404);
  assert.equal(tradingErrorStatus(new Error("该发送目标已存在")), 409);
  assert.equal(tradingErrorStatus(new Error("交易中心数据库未配置：请设置 DATABASE_URL")), 503);
  assert.equal(tradingErrorStatus(new Error("TELEGRAM_TOKEN_REQUIRED")), 503);
  assert.equal(tradingErrorStatus(new Error("交易对格式无效")), 400);
});

async function configuredTradingDesk() {
  const { repository, readState } = memoryRepository();
  const trader = await repository.saveTrader({ displayName: "Alice", telegramUserId: "1001" });
  const saved = await saveExchangeAccount({
    label: "Alice Desk",
    apiKey: "alice-key-123456",
    apiSecret: "alice-secret-123456",
    traderIds: [trader.id],
  }, dependencies(repository));
  await repository.saveAccount({ id: saved.account.id, label: saved.account.label, status: "verified" });
  const destinationA = await repository.saveDestination({
    scopeType: "workspace", chatId: "-100100", threadId: 70, chatTitle: "Demo", topicTitle: "Trading Zone",
  });
  const destinationB = await repository.saveDestination({
    scopeType: "workspace", chatId: "-100200", threadId: 71, chatTitle: "CryptoGuy", topicTitle: "Trading Zone",
  });
  return { repository, readState, trader, accountId: saved.account.id, destinations: [destinationA, destinationB] };
}

function privateUpdate(updateId, userId, text, messageId = updateId) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_768_000_000,
      chat: { id: userId, type: "private" },
      from: { id: userId, username: `user${userId}` },
      text,
    },
  };
}

test("SpeakerBot accepts only private enabled Traders and returns actionable help", async () => {
  const { repository, trader } = await configuredTradingDesk();
  const replies = [];
  const telegram = async (_token, method, payload) => {
    if (method === "sendMessage") {
      replies.push(payload);
      return { message_id: replies.length };
    }
    throw new Error(`unexpected ${method}`);
  };
  const deps = dependencies(repository, { telegram });

  const group = privateUpdate(1, 1001, "BTCUSDT 123456");
  group.message.chat.type = "supergroup";
  assert.equal((await processSpeakerTelegramUpdate(group, deps)).status, "ignored_non_private");
  assert.equal((await processSpeakerTelegramUpdate({ update_id: 2, message: { chat: { id: 2, type: "private" }, text: "/start" } }, deps)).status, "ignored_missing_user");
  assert.equal((await processSpeakerTelegramUpdate(privateUpdate(3, 9999, "/start"), deps)).status, "unauthorized");
  await repository.saveTrader({ ...trader, status: "disabled" });
  assert.equal((await processSpeakerTelegramUpdate(privateUpdate(4, 1001, "BTCUSDT 123456"), deps)).status, "trader_disabled");
  await repository.saveTrader({ ...trader, status: "enabled" });
  assert.equal((await processSpeakerTelegramUpdate(privateUpdate(5, 1001, "/start"), deps)).status, "help");
  assert.equal((await processSpeakerTelegramUpdate(privateUpdate(6, 1001, "bad"), deps)).status, "invalid_format");
  assert.match(replies.at(-1).text, /BTCUSDT 1234567890/);
  assert.doesNotMatch(JSON.stringify(replies), /alice-secret|alice-key/);
});

test("SpeakerBot acknowledges a claimed update before running deferred work", async () => {
  const { repository } = await configuredTradingDesk();
  const replies = [];
  let deferredTask;
  const update = privateUpdate(10, 1001, "/start");
  const deps = dependencies(repository, {
    defer(task) {
      deferredTask = task;
    },
    telegram: async (_token, method, payload) => {
      assert.equal(method, "sendMessage");
      replies.push(payload);
      return { message_id: replies.length };
    },
  });

  const accepted = await processSpeakerTelegramUpdate(update, deps);
  assert.equal(accepted.status, "accepted");
  assert.equal(replies.length, 0);
  assert.equal(typeof deferredTask, "function");
  assert.equal((await processSpeakerTelegramUpdate(update, deps)).status, "duplicate_update");

  await deferredTask();
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /BTCUSDT 1234567890/);
});

test("Trader refresh command performs a fresh YUBIT reconciliation before replying", async () => {
  const { repository, trader, accountId } = await configuredTradingDesk();
  const signal = await createTrackingSignal(repository, trader, accountId, {
    exchangeOrderId: "refresh_1234",
  });
  const replies = [];
  let reconciliationCalls = 0;
  const result = await processSpeakerTelegramUpdate(
    privateUpdate(11, 1001, "/refresh BTCUSDT refresh_1234"),
    dependencies(repository, {
      telegram: async (_token, method, payload) => {
        assert.equal(method, "sendMessage");
        replies.push(payload);
        return { message_id: replies.length };
      },
      yubitClientFactory: () => ({
        async getClosedPnl() {
          reconciliationCalls += 1;
          return { list: [] };
        },
      }),
    }),
  );

  assert.equal(result.status, "refresh");
  assert.equal(reconciliationCalls, 1);
  const refreshed = await repository.getSignal(signal.id);
  assert.equal(refreshed.checkAttempts, 1);
  assert.equal(refreshed.lastCheckedAt, "2026-07-16T08:00:00.000Z");
  assert.match(replies[0].text, /Refresh: pending/);
  assert.match(replies[0].text, /Last checked: 2026-07-16T08:00:00.000Z/);
});

test("a verified filled order creates one immutable signal and delivers to every target", async () => {
  const { repository, trader, destinations } = await configuredTradingDesk();
  const calls = [];
  const telegram = async (_token, method, payload) => {
    assert.equal(method, "sendMessage");
    calls.push(payload);
    return { message_id: 9000 + calls.length };
  };
  const yubitClientFactory = () => ({
    async getOrderHistory({ symbol, orderId }) {
      return { list: [{ orderId, symbol, orderStatus: "Filled", side: "Buy", leverage: "10", createdTime: 1_768_000_000_000 }] };
    },
    async getExecutions({ symbol, orderId }) {
      return { list: [{ execId: "exec-1", orderId, symbol, execQty: "0.2", execPrice: "68000", execTime: 1_768_000_000_000 }] };
    },
  });

  const result = await processSpeakerTelegramUpdate(
    privateUpdate(20, 1001, "BTCUSDT order_12345\nTP: 70000\nSL: 66000\nRationale: Verified breakout"),
    dependencies(repository, { telegram, yubitClientFactory }),
  );

  assert.equal(result.status, "published");
  assert.equal(result.delivered, 2);
  assert.equal(result.failed, 0);
  const [signal] = await repository.listSignals({ traderId: trader.id });
  assert.equal(signal.status, "tracking");
  assert.equal(signal.exchangeOrderId, "order_12345");
  assert.equal((await repository.listEvents(signal.id))[0].eventType, "verified");
  const deliveries = await repository.listDeliveries({ signalId: signal.id });
  assert.equal(deliveries.length, destinations.length);
  assert.ok(deliveries.every((row) => row.status === "delivered"));
  const publicMessages = calls.filter((payload) => String(payload.chat_id).startsWith("-100"));
  assert.equal(publicMessages.length, 2);
  assert.ok(publicMessages.every((payload) => /Verified by YUBIT/.test(payload.text)));
  assert.ok(publicMessages.every((payload) => [70, 71].includes(payload.message_thread_id)));
});

test("SpeakerBot retries an unfiltered order-history lookup when YUBIT returns no exact-query rows", async () => {
  const { repository } = await configuredTradingDesk();
  const orderId = "f48f4cac-ffd7-4bf4-84b2-46655e9bb02c";
  const orderQueries = [];
  const result = await processSpeakerTelegramUpdate(
    privateUpdate(21, 1001, `BTCUSDT ${orderId}`),
    dependencies(repository, {
      telegram: async () => ({ message_id: 9001 }),
      yubitClientFactory: () => ({
        async getOrderHistory(input) {
          orderQueries.push(input);
          if (input.orderId) return { list: [] };
          return {
            list: [{
              orderId,
              symbol: "BTCUSDT",
              orderStatus: "Filled",
              side: "Buy",
              leverage: "200",
              createdTime: 1_768_000_000_000,
            }],
          };
        },
        async getExecutions({ symbol, orderId: requestedOrderId }) {
          return {
            list: [{
              execId: "exec-fallback-1",
              orderId: requestedOrderId,
              symbol,
              execQty: "0.01",
              execPrice: "62829.9",
              execTime: 1_768_000_000_000,
            }],
          };
        },
      }),
    }),
  );

  assert.equal(result.status, "published");
  assert.deepEqual(orderQueries, [
    { symbol: "BTCUSDT", orderId, limit: 20 },
    { symbol: "BTCUSDT", limit: 100 },
  ]);
});

test("SpeakerBot treats separator variants of the same YUBIT symbol as equivalent", async () => {
  const { repository } = await configuredTradingDesk();
  const orderId = "f48f4cac-ffd7-4bf4-84b2-46655e9bb02c";
  const result = await processSpeakerTelegramUpdate(
    privateUpdate(221, 1001, `BTCUSDT ${orderId}`),
    dependencies(repository, {
      telegram: async () => ({ message_id: 9011 }),
      yubitClientFactory: () => ({
        async getOrderHistory() {
          return {
            list: [{
              orderId,
              symbol: "BTC-USDT",
              orderStatus: "Filled",
              side: "Buy",
              createdTime: 1_768_000_000_000,
            }],
          };
        },
        async getExecutions() {
          return {
            list: [{
              execId: "separator-symbol-exec",
              orderId,
              symbol: "BTC/USDT",
              execQty: "0.01",
              execPrice: "62829.9",
              execTime: 1_768_000_000_000,
            }],
          };
        },
      }),
    }),
  );

  assert.equal(result.status, "published");
});

test("SpeakerBot persists a safe YUBIT failure code when order verification fails", async () => {
  const { repository, readState } = await configuredTradingDesk();
  const result = await processSpeakerTelegramUpdate(
    privateUpdate(22, 1001, "BTCUSDT failed_lookup_1234"),
    dependencies(repository, {
      telegram: async () => ({ message_id: 9002 }),
      yubitClientFactory: () => ({
        async getOrderHistory() {
          throw new Error("YUBIT_API_ERROR:26200004");
        },
      }),
    }),
  );

  assert.equal(result.status, "order_not_verified");
  const webhookUpdate = readState().webhookUpdates.find((row) => row.updateId === "22");
  assert.equal(webhookUpdate.safeErrorCode, "YUBIT_API_ERROR:26200004");
});

test("order diagnostics expose only safe lookup metadata for a linked account", async () => {
  const service = await import("../lib/trading-service.mjs");
  assert.equal(typeof service.diagnoseExchangeOrder, "function");

  const { repository, accountId } = await configuredTradingDesk();
  const orderId = "diagnostic_order_1234";
  const result = await service.diagnoseExchangeOrder({
    accountId,
    symbol: "BTCUSDT",
    orderId,
  }, dependencies(repository, {
    yubitClientFactory: () => ({
      getOrderHistory: async ({ orderId: requestedOrderId }) => ({
        list: requestedOrderId ? [] : [{
          orderId,
          symbol: "BTCUSDT",
          orderStatus: "Filled",
          side: "Buy",
        }],
      }),
      getExecutions: async ({ orderId: requestedOrderId }) => ({
        list: requestedOrderId ? [{
          orderId,
          symbol: "BTCUSDT",
          execId: "diagnostic-exec",
          execQty: "1",
          execPrice: "100",
        }] : [],
      }),
    }),
  }));

  assert.equal(result.orderMatched, true);
  assert.equal(result.executionCount, 1);
  assert.deepEqual(result.orderLookup, { exactCount: 0, fallbackCount: 1 });
  assert.equal(JSON.stringify(result).includes("alice-secret"), false);
  assert.equal(JSON.stringify(result).includes("credentialCiphertext"), false);
});

test("order diagnostics identify matching field names without exposing unmatched order values", async () => {
  const { diagnoseExchangeOrder } = await import("../lib/trading-service.mjs");
  const { repository, accountId } = await configuredTradingDesk();
  const orderId = "field_probe_order_1234";
  const result = await diagnoseExchangeOrder({ accountId, symbol: "BTCUSDT", orderId }, dependencies(repository, {
    yubitClientFactory: () => ({
      getOrderHistory: async ({ orderId: requestedOrderId }) => ({
        list: requestedOrderId ? [{
          externalOrderIdentifier: orderId,
          contractCode: "BTCUSDT",
          privateMemo: "must-not-leak",
        }] : [],
      }),
      getExecutions: async () => ({ list: [] }),
    }),
  }));

  assert.equal(result.orderMatched, false);
  assert.deepEqual(result.candidateOrderFieldKeys, ["contractCode", "externalOrderIdentifier", "privateMemo"]);
  assert.deepEqual(result.orderIdMatchingKeys, ["externalOrderIdentifier"]);
  assert.deepEqual(result.symbolMatchingKeys, ["contractCode"]);
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(result).includes(orderId), false);
});

test("duplicate updates and shared-account duplicate orders never republish", async () => {
  const { repository, trader, accountId } = await configuredTradingDesk();
  const second = await repository.saveTrader({ displayName: "Bob", telegramUserId: "1002" });
  await repository.linkTraderAccounts(second.id, [accountId], accountId);
  const sends = [];
  const telegram = async (_token, _method, payload) => {
    sends.push(payload);
    return { message_id: sends.length };
  };
  const client = () => ({
    getOrderHistory: async ({ orderId, symbol }) => ({ list: [{ orderId, symbol, orderStatus: "Filled", side: "Sell" }] }),
    getExecutions: async ({ orderId }) => ({ list: [{ orderId, execId: "e1", execQty: "1", execPrice: "100", execTime: 1_768_000_000_000 }] }),
  });
  const deps = dependencies(repository, { telegram, yubitClientFactory: client });

  const first = privateUpdate(30, Number(trader.telegramUserId), "ETHUSDT shared_1234");
  assert.equal((await processSpeakerTelegramUpdate(first, deps)).status, "published");
  const publicSendCount = sends.filter((payload) => String(payload.chat_id).startsWith("-100")).length;
  assert.equal((await processSpeakerTelegramUpdate(first, deps)).status, "duplicate_update");
  assert.equal((await processSpeakerTelegramUpdate(privateUpdate(31, 1002, "ETHUSDT shared_1234"), deps)).status, "existing_order");
  assert.equal(sends.filter((payload) => String(payload.chat_id).startsWith("-100")).length, publicSendCount);
  assert.equal((await repository.listSignals({})).length, 1);
});

test("one Telegram target failure is isolated and a bounded 429 retry succeeds", async () => {
  const { repository } = await configuredTradingDesk();
  const attempts = new Map();
  const telegram = async (_token, _method, payload) => {
    const key = String(payload.chat_id);
    attempts.set(key, (attempts.get(key) || 0) + 1);
    if (key === "-100100" && attempts.get(key) === 1) {
      const error = new Error("TELEGRAM_RATE_LIMITED");
      error.retryAfter = 0;
      throw error;
    }
    if (key === "-100200") throw new Error("TELEGRAM_API_ERROR:403");
    return { message_id: 777 };
  };
  const result = await processSpeakerTelegramUpdate(privateUpdate(40, 1001, "SOLUSDT retry_1234"), dependencies(repository, {
    telegram,
    sleep: async () => {},
    yubitClientFactory: () => ({
      getOrderHistory: async ({ orderId, symbol }) => ({ list: [{ orderId, symbol, orderStatus: "Filled", side: "Buy" }] }),
      getExecutions: async ({ orderId }) => ({ list: [{ orderId, execId: "e1", execQty: "2", execPrice: "150" }] }),
    }),
  }));
  assert.equal(result.delivered, 1);
  assert.equal(result.failed, 1);
  assert.equal(attempts.get("-100100"), 2);
  const deliveries = await repository.listDeliveries({});
  assert.deepEqual(deliveries.map((row) => row.status).sort(), ["delivered", "failed"]);
});

test("SpeakerBot webhook configuration uses the dedicated public route and secret token", async () => {
  const { repository } = memoryRepository();
  const calls = [];
  const result = await configureSpeakerWebhook(dependencies(repository, {
    env: {
      NODE_ENV: "production",
      APP_BASE_URL: "https://academy.example",
      SPEAKER_BOT_TOKEN: "speaker-production-token",
      SPEAKER_TELEGRAM_WEBHOOK_SECRET: "speaker-webhook-secret",
    },
    telegram: async (_token, method, payload) => {
      calls.push({ method, payload });
      return true;
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.environment, "production");
  assert.equal(calls[0].method, "setWebhook");
  assert.equal(calls[0].payload.url, "https://academy.example/api/telegram/speaker-webhook");
  assert.equal(calls[0].payload.secret_token, "speaker-webhook-secret");
  assert.equal(JSON.stringify(result).includes("speaker-webhook-secret"), false);
});

test("Preview refuses to reuse the production SpeakerBot or production application URL", async () => {
  const { repository } = memoryRepository();
  const calls = [];

  await assert.rejects(
    configureSpeakerWebhook(dependencies(repository, {
      env: {
        VERCEL_ENV: "preview",
        VERCEL_URL: "academy-preview.vercel.app",
        APP_BASE_URL: "https://academy.example",
        SPEAKER_TELEGRAM_WEBHOOK_SECRET: "production-webhook-secret",
      },
      telegram: async (...args) => {
        calls.push(args);
        return true;
      },
    })),
    /SPEAKER_PREVIEW_WEBHOOK_DISABLED/,
  );
  assert.equal(calls.length, 0);
});

test("Preview webhook opt-in requires an isolated Bot and targets the immutable preview URL", async () => {
  const { repository } = memoryRepository();
  const calls = [];
  const result = await configureSpeakerWebhook(dependencies(repository, {
    env: {
      VERCEL_ENV: "preview",
      VERCEL_URL: "academy-preview.vercel.app",
      APP_BASE_URL: "https://academy.example",
      SPEAKER_PREVIEW_WEBHOOK_ENABLED: "true",
      SPEAKER_PREVIEW_BOT_TOKEN: "987654:preview-speaker-token",
      SPEAKER_PREVIEW_TELEGRAM_WEBHOOK_SECRET: "preview-webhook-secret",
    },
    telegram: async (token, method, payload) => {
      calls.push({ token, method, payload });
      return true;
    },
  }));

  assert.equal(result.url, "https://academy-preview.vercel.app/api/telegram/speaker-webhook");
  assert.equal(calls[0].token, "987654:preview-speaker-token");
  assert.equal(calls[0].payload.secret_token, "preview-webhook-secret");
  assert.equal(JSON.stringify(result).includes("preview-webhook-secret"), false);
});

test("health reports a stale SpeakerBot webhook instead of marking it healthy", async () => {
  const { repository } = memoryRepository();
  const telegram = async (_token, method) => {
    if (method === "getMe") return { id: 77, username: "speaker_test_bot" };
    if (method === "getWebhookInfo") return { url: "https://old-preview.vercel.app/api/telegram/speaker-webhook" };
    throw new Error(`unexpected ${method}`);
  };

  const result = await getTradingHealth(dependencies(repository, {
    env: {
      APP_BASE_URL: "https://academy.example",
      SPEAKER_TELEGRAM_WEBHOOK_SECRET: "speaker-webhook-secret",
    },
    telegram,
  }));

  assert.equal(result.speakerBot.webhookConfigured, true);
  assert.equal(result.speakerBot.webhookMatchesDeployment, false);
  assert.equal(result.speakerBot.ok, false);
  assert.equal(result.speakerBot.errorCode, "TELEGRAM_WEBHOOK_TARGET_MISMATCH");
  assert.equal(result.speakerBot.expectedWebhookUrl, "https://academy.example/api/telegram/speaker-webhook");
});

async function createTrackingSignal(repository, trader, accountId, overrides = {}) {
  return (await repository.createSignal({
    traderId: trader.id,
    accountId,
    exchangeOrderId: "close_1234",
    symbol: "BTCUSDT",
    side: "Long",
    leverage: 5,
    filledQty: 2,
    avgEntryPrice: 100,
    openedAt: "2026-07-16T07:00:00.000Z",
    status: "tracking",
    nextCheckAt: "2026-07-16T07:59:00.000Z",
    ...overrides,
  })).signal;
}

test("reconciliation keeps an open order tracking with a bounded next check", async () => {
  const { repository, trader, accountId } = await configuredTradingDesk();
  const signal = await createTrackingSignal(repository, trader, accountId);
  const result = await runTradingReconciliation(dependencies(repository, {
    yubitClientFactory: () => ({ getClosedPnl: async () => ({ list: [] }) }),
  }));

  assert.deepEqual(result, { claimed: 1, closed: 0, pending: 1, needsReview: 0, failed: 0 });
  const updated = await repository.getSignal(signal.id);
  assert.equal(updated.status, "tracking");
  assert.equal(updated.leaseUntil, null);
  assert.equal(updated.lastCheckedAt, "2026-07-16T08:00:00.000Z");
  assert.ok(Date.parse(updated.nextCheckAt) > Date.parse(updated.lastCheckedAt));
});

test("one verified profitable close publishes one signed PNL card to every target exactly once", async () => {
  const { repository, trader, accountId, destinations } = await configuredTradingDesk();
  const signal = await createTrackingSignal(repository, trader, accountId);
  const sends = [];
  const deps = dependencies(repository, {
    env: {
      APP_BASE_URL: "https://academy.example",
      PNL_CARD_SIGNING_SECRET: "pnl-card-signing-secret-with-enough-entropy",
    },
    telegram: async (_token, method, payload) => {
      sends.push({ method, payload });
      return { message_id: 7000 + sends.length };
    },
    yubitClientFactory: () => ({
      getClosedPnl: async ({ symbol }) => ({
        list: [{
          orderId: "close_1234",
          symbol,
          side: "Sell",
          closedSize: "2",
          avgExitPrice: "110",
          closedPnl: "20",
          updatedTime: 1_768_464_000_000,
        }],
      }),
    }),
  });

  const first = await runTradingReconciliation(deps);
  const second = await runTradingReconciliation(deps);
  assert.deepEqual(first, { claimed: 1, closed: 1, pending: 0, needsReview: 0, failed: 0 });
  assert.equal(second.claimed, 0);

  const updated = await repository.getSignal(signal.id);
  assert.equal(updated.status, "closed_profit");
  assert.equal(updated.realizedPnl, 20);
  assert.equal(updated.roi, 50);
  assert.equal(updated.avgExitPrice, 110);
  const publication = await repository.getPnlPublicationBySignal(signal.id);
  assert.equal(publication.status, "delivered");
  assert.match(publication.cardAssetUrl, /^https:\/\/academy\.example\/api\/media\/pnl-card\?token=/);
  assert.equal(JSON.stringify(publication.cardPayload).includes("signing-secret"), false);
  const deliveries = await repository.listDeliveries({ signalId: signal.id });
  const pnlDeliveries = deliveries.filter((row) => row.publicationType === "pnl_card");
  assert.equal(pnlDeliveries.length, destinations.length);
  assert.ok(pnlDeliveries.every((row) => row.status === "delivered"));
  assert.equal(sends.length, destinations.length);
  assert.ok(sends.every((call) => call.method === "sendPhoto"));
  assert.ok(sends.every((call) => /PROFIT CLOSED/.test(call.payload.caption)));
  assert.ok(sends.every((call) => call.payload.photo === publication.cardAssetUrl));
});

test("non-profit closes are logged but never create a Telegram PNL delivery", async () => {
  const { repository, trader, accountId } = await configuredTradingDesk();
  const signal = await createTrackingSignal(repository, trader, accountId, { exchangeOrderId: "loss_1234" });
  const sends = [];
  const result = await runTradingReconciliation(dependencies(repository, {
    telegram: async (...args) => { sends.push(args); return { message_id: 1 }; },
    yubitClientFactory: () => ({
      getClosedPnl: async () => ({ list: [{ orderId: "loss_1234", closedPnl: "-2", avgExitPrice: "99" }] }),
    }),
  }));

  assert.equal(result.closed, 1);
  assert.equal((await repository.getSignal(signal.id)).status, "closed_non_profit");
  assert.equal((await repository.getPnlPublicationBySignal(signal.id)).status, "skipped_non_profit");
  assert.equal((await repository.listDeliveries({ signalId: signal.id })).length, 0);
  assert.equal(sends.length, 0);
});

test("ambiguous close records pause the order for review and never publish", async () => {
  const { repository, trader, accountId } = await configuredTradingDesk();
  const signal = await createTrackingSignal(repository, trader, accountId, { exchangeOrderId: "ambiguous_1" });
  const result = await runTradingReconciliation(dependencies(repository, {
    yubitClientFactory: () => ({
      getClosedPnl: async () => ({ list: [
        { orderId: "ambiguous_1", closedPnl: "10" },
        { orderId: "ambiguous_1", closedPnl: "11" },
      ] }),
    }),
  }));

  assert.equal(result.needsReview, 1);
  assert.equal((await repository.getSignal(signal.id)).status, "needs_review");
  assert.equal(await repository.getPnlPublicationBySignal(signal.id), null);
});

test("management overview and signal detail expose joined operational facts without secrets", async () => {
  const { repository, trader, accountId, destinations } = await configuredTradingDesk();
  const signal = await createTrackingSignal(repository, trader, accountId);
  await repository.appendEvent({
    signalId: signal.id,
    eventType: "verified",
    actorType: "trader",
    actorId: trader.id,
    payload: { official: true },
  });
  await repository.createDelivery({
    signalId: signal.id,
    publicationType: "signal",
    destinationId: destinations[0].id,
    status: "failed",
    errorCode: "TELEGRAM_API_ERROR:403",
  });

  const deps = dependencies(repository, {
    telegram: async (_token, method) => {
      if (method === "getMe") return { id: 77, username: "speaker_test_bot" };
      if (method === "getWebhookInfo") return { url: "https://academy.example/api/telegram/speaker-webhook" };
      throw new Error(`unexpected ${method}`);
    },
  });
  const overview = await getTradingManagementOverview(deps);
  assert.equal(overview.metrics.totalSignals, 1);
  assert.equal(overview.metrics.failedDeliveries, 1);
  assert.equal(overview.metrics.orderReadyTraders, 1);
  assert.equal(overview.metrics.publishReadyTraders, 1);
  assert.equal(overview.traders[0].telegramReady, true);
  assert.equal(overview.traders[0].verifiedAccountCount, 1);
  assert.deepEqual(overview.traders[0].verifiedAccountIds, [accountId]);
  assert.equal(overview.traders[0].enabledDestinationCount, 2);
  assert.equal(overview.traders[0].canVerifyOrders, true);
  assert.equal(overview.traders[0].canPublish, true);
  assert.deepEqual(overview.accounts[0].traderIds, [trader.id]);
  assert.ok(Array.isArray(overview.logs));

  const detail = await getTradingSignalDetail(signal.id, deps);
  assert.equal(detail.signal.id, signal.id);
  assert.equal(detail.trader.displayName, "Alice");
  assert.equal(detail.account.id, accountId);
  assert.equal(detail.events[0].eventType, "verified");
  assert.equal(detail.deliveries[0].destination.chatId, destinations[0].chatId);
  assert.equal(/ciphertext|apiSecret|credentialIv|authTag/i.test(JSON.stringify({ overview, detail })), false);
});

test("Trader readiness uses a verified linked account even when an old linked account is invalid", async () => {
  const { repository } = memoryRepository();
  const trader = await repository.saveTrader({ displayName: "Hemant", telegramUserId: "1436978671" });
  const oldAccount = await saveExchangeAccount({
    label: "Hemant old account",
    apiKey: "same-api-key-1234",
    apiSecret: "old-wrong-secret",
    traderIds: [trader.id],
  }, dependencies(repository));
  await repository.saveAccount({
    id: oldAccount.account.id,
    label: oldAccount.account.label,
    status: "invalid",
    lastErrorCode: "YUBIT_API_ERROR:26200004",
  });
  const activeAccount = await saveExchangeAccount({
    label: "Trader main account",
    apiKey: "same-api-key-1234",
    apiSecret: "correct-secret",
    traderIds: [trader.id],
  }, dependencies(repository));
  await repository.saveAccount({
    id: activeAccount.account.id,
    label: activeAccount.account.label,
    status: "verified",
    lastVerifiedAt: "2026-07-16T08:00:00.000Z",
    lastErrorCode: null,
  });

  const overview = await getTradingManagementOverview(dependencies(repository));
  assert.equal(overview.metrics.orderReadyTraders, 1);
  assert.equal(overview.metrics.publishReadyTraders, 0);
  assert.equal(overview.traders[0].verifiedAccountCount, 1);
  assert.deepEqual(overview.traders[0].verifiedAccountIds, [activeAccount.account.id]);
  assert.equal(overview.traders[0].canVerifyOrders, true);
  assert.equal(overview.traders[0].canPublish, false);
});

test("manual refresh and failed delivery retry remain idempotent", async () => {
  const { repository, trader, accountId, destinations } = await configuredTradingDesk();
  const signal = await createTrackingSignal(repository, trader, accountId);
  const createdDelivery = await repository.createDelivery({
    signalId: signal.id,
    publicationType: "signal",
    destinationId: destinations[0].id,
  });
  await repository.updateDelivery(createdDelivery.delivery.id, {
    status: "failed",
    errorCode: "TELEGRAM_API_ERROR:403",
  });
  const sends = [];
  const deps = dependencies(repository, {
    telegram: async (_token, method, payload) => {
      if (method === "sendMessage") {
        sends.push(payload);
        return { message_id: 8080 };
      }
      if (method === "getMe") return { id: 77, username: "speaker_test_bot" };
      if (method === "getWebhookInfo") return { url: "https://academy.example/api/telegram/speaker-webhook" };
      throw new Error(`unexpected ${method}`);
    },
    yubitClientFactory: () => ({ getClosedPnl: async () => ({ list: [] }) }),
  });

  const refreshed = await refreshTradingSignal(signal.id, deps);
  assert.equal(refreshed.signal.status, "tracking");
  assert.equal(refreshed.signal.checkAttempts, 1);

  const firstRetry = await retryTradingDelivery(createdDelivery.delivery.id, deps);
  const secondRetry = await retryTradingDelivery(createdDelivery.delivery.id, deps);
  assert.equal(firstRetry.delivery.status, "delivered");
  assert.equal(secondRetry.alreadyDelivered, true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].message_thread_id, destinations[0].threadId);
});

test("manual retry validates its dependencies before claiming a delivery", async () => {
  const { repository, trader, accountId, destinations } = await configuredTradingDesk();
  const signal = await createTrackingSignal(repository, trader, accountId);
  const created = await repository.createDelivery({
    signalId: signal.id,
    publicationType: "unsupported",
    destinationId: destinations[0].id,
  });
  await repository.updateDelivery(created.delivery.id, {
    status: "failed",
    attempts: 2,
    errorCode: "LEGACY_DELIVERY_TYPE",
  });

  await assert.rejects(
    retryTradingDelivery(created.delivery.id, dependencies(repository)),
    /TRADING_DELIVERY_TYPE_UNSUPPORTED/,
  );
  const unchanged = await repository.getDelivery(created.delivery.id);
  assert.equal(unchanged.status, "failed");
  assert.equal(unchanged.attempts, 2);
});
