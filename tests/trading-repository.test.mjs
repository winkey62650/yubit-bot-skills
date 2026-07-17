import assert from "node:assert/strict";
import test from "node:test";

import {
  JsonTradingRepository,
  PostgresTradingRepository,
  getTradingRepository,
  resetTradingRepositoryForTests,
} from "../lib/trading-repository.mjs";

function memoryRepository(now = () => new Date("2026-07-16T08:00:00.000Z")) {
  let value;
  return new JsonTradingRepository({
    now,
    readJsonImpl: async (_path, fallback) => value == null ? structuredClone(fallback) : structuredClone(value),
    writeJsonImpl: async (_path, next) => {
      value = structuredClone(next);
      return next;
    }
  });
}

test("Trader Telegram numeric ids are unique and status can be changed", async () => {
  const repository = memoryRepository();
  const trader = await repository.saveTrader({ displayName: "Alice", telegramUserId: "123456789", telegramUsername: "alice" });
  assert.equal(trader.status, "enabled");
  assert.equal((await repository.findTraderByTelegramUserId(123456789)).id, trader.id);

  await assert.rejects(
    repository.saveTrader({ displayName: "Duplicate", telegramUserId: "123456789" }),
    /Telegram.*已绑定/
  );
  await assert.rejects(repository.saveTrader({ displayName: "Bad", telegramUserId: "@alice" }), /数字 ID/);

  const disabled = await repository.saveTrader({ ...trader, status: "disabled" });
  assert.equal(disabled.status, "disabled");
});

test("account credentials are hidden by default and available only through explicit server reads", async () => {
  const repository = memoryRepository();
  const account = await repository.saveAccount({
    label: "Primary read-only",
    exchange: "yubit",
    credentialCiphertext: "ciphertext",
    credentialIv: "iv",
    credentialAuthTag: "tag",
    keyVersion: 1,
    apiKeyMasked: "abcd…wxyz",
    status: "verified"
  });

  assert.equal(account.apiKeyMasked, "abcd…wxyz");
  assert.equal(account.credentialCiphertext, undefined);
  assert.equal((await repository.getAccount(account.id)).credentialIv, undefined);
  assert.equal((await repository.listAccounts())[0].credentialAuthTag, undefined);

  const secret = await repository.getAccountWithCredentials(account.id);
  assert.equal(secret.credentialCiphertext, "ciphertext");
  assert.equal(secret.credentialIv, "iv");
  assert.equal(secret.credentialAuthTag, "tag");
});

test("account verification metadata can be explicitly cleared in the JSON repository", async () => {
  const repository = memoryRepository();
  const account = await repository.saveAccount({
    label: "Primary read-only",
    credentialCiphertext: "ciphertext",
    credentialIv: "iv",
    credentialAuthTag: "tag",
    apiKeyMasked: "abcd…wxyz",
    status: "invalid",
    lastVerifiedAt: null,
    lastErrorCode: "YUBIT_API_ERROR:old"
  });

  const verified = await repository.saveAccount({
    id: account.id,
    label: account.label,
    status: "verified",
    lastVerifiedAt: "2026-07-17T06:00:00.000Z",
    lastErrorCode: null
  });

  assert.equal(verified.status, "verified");
  assert.equal(verified.lastVerifiedAt, "2026-07-17T06:00:00.000Z");
  assert.equal(verified.lastErrorCode, null);
});

test("account verification metadata can be explicitly cleared in the Postgres repository", async () => {
  const repository = Object.create(PostgresTradingRepository.prototype);
  repository.getAccountWithCredentials = async () => ({
    id: "account-1",
    exchange: "yubit",
    label: "Primary read-only",
    credentialCiphertext: "ciphertext",
    credentialIv: "iv",
    credentialAuthTag: "tag",
    keyVersion: 1,
    apiKeyMasked: "abcd…wxyz",
    status: "invalid",
    lastVerifiedAt: null,
    lastErrorCode: "YUBIT_API_ERROR:old"
  });
  let writtenValues;
  repository.sql = {
    query: async (_statement, values) => {
      writtenValues = values;
      return [{
        id: values[0],
        exchange: values[1],
        label: values[2],
        credential_ciphertext: values[3],
        credential_iv: values[4],
        credential_auth_tag: values[5],
        key_version: values[6],
        api_key_masked: values[7],
        status: values[8],
        last_verified_at: values[9],
        last_error_code: values[10],
        created_at: "2026-07-16T08:00:00.000Z",
        updated_at: "2026-07-17T06:00:00.000Z"
      }];
    }
  };

  const verified = await repository.saveAccount({
    id: "account-1",
    label: "Primary read-only",
    status: "verified",
    lastVerifiedAt: "2026-07-17T06:00:00.000Z",
    lastErrorCode: null
  });

  assert.equal(writtenValues[10], null);
  assert.equal(verified.status, "verified");
  assert.equal(verified.lastErrorCode, null);
});

test("Traders and accounts are linked many-to-many", async () => {
  const repository = memoryRepository();
  const traderA = await repository.saveTrader({ displayName: "Alice", telegramUserId: "1001" });
  const traderB = await repository.saveTrader({ displayName: "Bob", telegramUserId: "1002" });
  const accountA = await repository.saveAccount({ label: "Desk A", credentialCiphertext: "a", credentialIv: "i", credentialAuthTag: "t", apiKeyMasked: "aaa…111" });
  const accountB = await repository.saveAccount({ label: "Desk B", credentialCiphertext: "b", credentialIv: "i", credentialAuthTag: "t", apiKeyMasked: "bbb…222" });

  await repository.linkTraderAccounts(traderA.id, [accountA.id, accountB.id], accountB.id);
  await repository.linkTraderAccounts(traderB.id, [accountA.id], accountA.id);

  assert.deepEqual((await repository.listAccountsForTrader(traderA.id)).map((row) => row.id).sort(), [accountA.id, accountB.id].sort());
  assert.deepEqual((await repository.listTradersForAccount(accountA.id)).map((row) => row.id).sort(), [traderA.id, traderB.id].sort());
  assert.equal((await repository.listAccountCredentialsForTrader(traderA.id)).find((row) => row.id === accountB.id).isDefault, true);
});

test("enabled Trader destinations replace workspace defaults and disabled Trader destinations do not", async () => {
  const repository = memoryRepository();
  const trader = await repository.saveTrader({ displayName: "Alice", telegramUserId: "1001" });
  const workspace = await repository.saveDestination({ scopeType: "workspace", chatId: "-1001", threadId: 7, chatTitle: "Demo", topicTitle: "Signals" });
  const traderTarget = await repository.saveDestination({ scopeType: "trader", scopeId: trader.id, chatId: "-1002", threadId: 9, chatTitle: "VIP", topicTitle: "Alice" });

  assert.deepEqual((await repository.resolveDestinations(trader.id)).map((row) => row.id), [traderTarget.id]);
  await repository.saveDestination({ ...traderTarget, enabled: false });
  assert.deepEqual((await repository.resolveDestinations(trader.id)).map((row) => row.id), [workspace.id]);
});

test("Telegram update claims are idempotent and can be released after safe failure", async () => {
  const repository = memoryRepository();
  assert.equal(await repository.claimUpdate(987654), true);
  assert.equal(await repository.claimUpdate("987654"), false);
  await repository.releaseUpdate(987654);
  assert.equal(await repository.claimUpdate(987654), true);
});

test("account, symbol and order id uniquely identify a signal", async () => {
  const repository = memoryRepository();
  const first = await repository.createSignal({ accountId: "account-1", traderId: "trader-1", symbol: "BTCUSDT", exchangeOrderId: "ORDER-99", status: "verified" });
  const duplicate = await repository.createSignal({ accountId: "account-1", traderId: "trader-2", symbol: "btcusdt", exchangeOrderId: "ORDER-99", status: "verified" });

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.signal.id, first.signal.id);
  assert.equal(duplicate.signal.traderId, "trader-1");
});

test("trade events are append-only", async () => {
  const repository = memoryRepository();
  const first = await repository.appendEvent({ signalId: "signal-1", eventType: "verified", actorType: "system", payload: { status: "verified" } });
  const second = await repository.appendEvent({ signalId: "signal-1", eventType: "annotation", actorType: "operator", actorId: "ubuntu", payload: { note: "Watching TP" } });
  assert.notEqual(first.id, second.id);
  assert.deepEqual((await repository.listEvents("signal-1")).map((row) => row.eventType), ["verified", "annotation"]);
  assert.equal(typeof repository.updateEvent, "undefined");
});

test("deliveries are unique per signal, publication type and destination", async () => {
  const repository = memoryRepository();
  const first = await repository.createDelivery({ signalId: "signal-1", publicationType: "signal", destinationId: "target-1" });
  const duplicate = await repository.createDelivery({ signalId: "signal-1", publicationType: "signal", destinationId: "target-1" });
  const pnl = await repository.createDelivery({ signalId: "signal-1", publicationType: "pnl_card", destinationId: "target-1" });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.delivery.id, first.delivery.id);
  assert.notEqual(pnl.delivery.id, first.delivery.id);
});

test("only one PNL publication exists for a signal", async () => {
  const repository = memoryRepository();
  const first = await repository.createPnlPublication({ signalId: "signal-1", realizedPnl: "42.50", status: "generated" });
  const duplicate = await repository.createPnlPublication({ signalId: "signal-1", realizedPnl: "99.00", status: "generated" });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.publication.id, first.publication.id);
  assert.equal(duplicate.publication.realizedPnl, "42.50");
});

test("reconciliation leases prevent concurrent claims and expire safely", async () => {
  let now = new Date("2026-07-16T08:00:00.000Z");
  const repository = memoryRepository(() => new Date(now));
  await repository.createSignal({
    id: "due-signal",
    accountId: "account-1",
    traderId: "trader-1",
    symbol: "ETHUSDT",
    exchangeOrderId: "ORDER-100",
    status: "tracking",
    nextCheckAt: "2026-07-16T07:59:00.000Z"
  });

  assert.deepEqual((await repository.claimDueSignals(now, 10, 60_000)).map((row) => row.id), ["due-signal"]);
  assert.deepEqual(await repository.claimDueSignals(now, 10, 60_000), []);

  now = new Date("2026-07-16T08:01:01.000Z");
  assert.deepEqual((await repository.claimDueSignals(now, 10, 60_000)).map((row) => row.id), ["due-signal"]);
  const signal = await repository.getSignal("due-signal");
  assert.equal(signal.checkAttempts, 2);
  assert.equal(signal.lastCheckedAt, "2026-07-16T08:01:01.000Z");
});

test("manual reconciliation claims exactly one tracking signal", async () => {
  const now = new Date("2026-07-16T08:00:00.000Z");
  const repository = memoryRepository(() => now);
  await repository.createSignal({
    id: "manual-signal",
    accountId: "account-1",
    traderId: "trader-1",
    symbol: "BTCUSDT",
    exchangeOrderId: "ORDER-200",
    status: "tracking",
    nextCheckAt: "2026-07-17T08:00:00.000Z",
  });

  const claimed = await repository.claimSignalForCheck("manual-signal", now, 60_000);
  assert.equal(claimed.id, "manual-signal");
  assert.equal(claimed.checkAttempts, 1);
  assert.equal(await repository.claimSignalForCheck("manual-signal", now, 60_000), null);
  assert.equal(await repository.claimSignalForCheck("missing", now, 60_000), null);
});

test("trading preview refuses to reuse the generic production database URL", async () => {
  const original = {
    databaseUrl: process.env.DATABASE_URL,
    postgresUrl: process.env.POSTGRES_URL,
    previewDatabaseUrl: process.env.PREVIEW_DATABASE_URL,
    vercel: process.env.VERCEL,
    vercelEnv: process.env.VERCEL_ENV,
    nodeEnv: process.env.NODE_ENV,
    fallback: process.env.TRADING_ALLOW_JSON_FALLBACK,
    blobToken: process.env.BLOB_READ_WRITE_TOKEN,
  };

  try {
    process.env.DATABASE_URL = "not-a-database-url";
    delete process.env.POSTGRES_URL;
    delete process.env.PREVIEW_DATABASE_URL;
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    process.env.NODE_ENV = "production";
    delete process.env.TRADING_ALLOW_JSON_FALLBACK;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    resetTradingRepositoryForTests();

    await assert.rejects(
      () => getTradingRepository(),
      /PREVIEW_DATABASE_URL.*禁止复用生产数据库/
    );
  } finally {
    for (const [key, value] of Object.entries({
      DATABASE_URL: original.databaseUrl,
      POSTGRES_URL: original.postgresUrl,
      PREVIEW_DATABASE_URL: original.previewDatabaseUrl,
      VERCEL: original.vercel,
      VERCEL_ENV: original.vercelEnv,
      NODE_ENV: original.nodeEnv,
      TRADING_ALLOW_JSON_FALLBACK: original.fallback,
      BLOB_READ_WRITE_TOKEN: original.blobToken,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetTradingRepositoryForTests();
  }
});
