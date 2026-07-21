import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelegramUserSessionStore,
  telegramUserPublisherHealth
} from "../lib/telegram-user-session.mjs";

const ENCRYPTION_KEY = "11".repeat(32);

function repositoryHarness() {
  const values = new Map();
  return {
    values,
    repository: {
      async getMeta(key) {
        return values.get(key) ?? null;
      },
      async setMeta(key, value) {
        values.set(key, structuredClone(value));
        return value;
      }
    }
  };
}

test("Telegram user session is encrypted at rest and restores only for the expected account", async () => {
  const { values, repository } = repositoryHarness();
  const store = createTelegramUserSessionStore({
    repository,
    encryptionKey: ENCRYPTION_KEY,
    expectedUsername: "@Serenity_Crypto",
    now: () => new Date("2026-07-21T08:00:00.000Z")
  });

  await store.save({
    session: "sensitive-mtproto-session",
    user: { id: 901n, username: "Serenity_Crypto", firstName: "Serenity", bot: false }
  });

  const raw = values.get("telegram-user-publisher-v1");
  assert.equal(JSON.stringify(raw).includes("sensitive-mtproto-session"), false);
  assert.equal(raw.username, "Serenity_Crypto");
  assert.equal(raw.userId, "901");
  assert.equal(raw.authorizedAt, "2026-07-21T08:00:00.000Z");
  assert.ok(raw.encryptedSession.ciphertext);

  const restored = await store.load();
  assert.equal(restored.session, "sensitive-mtproto-session");
  assert.equal(restored.username, "Serenity_Crypto");
});

test("Telegram user session refuses a different account without persisting it", async () => {
  const { values, repository } = repositoryHarness();
  const store = createTelegramUserSessionStore({
    repository,
    encryptionKey: ENCRYPTION_KEY,
    expectedUsername: "Serenity_Crypto"
  });

  await assert.rejects(
    () => store.save({ session: "other-session", user: { id: 902, username: "someone_else", bot: false } }),
    (error) => error?.code === "TELEGRAM_USER_IDENTITY_MISMATCH"
  );
  assert.equal(values.has("telegram-user-publisher-v1"), false);
});

test("Telegram user session refuses an empty authorization payload", async () => {
  const { values, repository } = repositoryHarness();
  const store = createTelegramUserSessionStore({
    repository,
    encryptionKey: ENCRYPTION_KEY,
    expectedUsername: "Serenity_Crypto"
  });

  await assert.rejects(
    () => store.save({ session: "   ", user: { id: 901, username: "Serenity_Crypto", bot: false } }),
    (error) => error?.code === "TELEGRAM_USER_SESSION_INVALID"
  );
  assert.equal(values.has("telegram-user-publisher-v1"), false);
});

test("Telegram publisher health never exposes the encrypted session", async () => {
  const { repository } = repositoryHarness();
  const store = createTelegramUserSessionStore({
    repository,
    encryptionKey: ENCRYPTION_KEY,
    expectedUsername: "Serenity_Crypto"
  });
  await store.save({
    session: "server-session",
    user: { id: 901, username: "Serenity_Crypto", firstName: "Serenity", bot: false }
  });

  const health = await store.status();
  assert.deepEqual(health, {
    configured: true,
    authorized: true,
    expectedUsername: "Serenity_Crypto",
    username: "Serenity_Crypto",
    userId: "901",
    firstName: "Serenity",
    authorizedAt: health.authorizedAt,
    lastVerifiedAt: null,
    lastError: null
  });
  assert.equal(/session|cipher|authTag|\biv\b/i.test(JSON.stringify(health)), false);
});

test("publisher health combines safe persisted authorization with routing readiness", async () => {
  const { repository } = repositoryHarness();
  const env = {
    TELEGRAM_USER_PUBLISHER_REQUIRED: "true",
    TELEGRAM_USER_PUBLISHER_TARGETS: "-1003862539988",
    TELEGRAM_USER_PUBLISHER_USERNAME: "Serenity_Crypto",
    TELEGRAM_API_ID: "12345",
    TELEGRAM_API_HASH: "api-hash",
    TELEGRAM_USER_SESSION_ENCRYPTION_KEY: ENCRYPTION_KEY
  };
  const store = createTelegramUserSessionStore({
    repository,
    encryptionKey: ENCRYPTION_KEY,
    expectedUsername: "Serenity_Crypto"
  });
  await store.save({
    session: "never-return-this",
    user: { id: 901, username: "Serenity_Crypto", firstName: "Serenity", bot: false }
  });

  const health = await telegramUserPublisherHealth({ repository, env });
  assert.equal(health.ready, true);
  assert.equal(health.authorized, true);
  assert.equal(health.username, "@Serenity_Crypto");
  assert.deepEqual(health.approvedTargetIds, ["-1003862539988"]);
  assert.equal(JSON.stringify(health).includes("never-return-this"), false);
  assert.equal(/encryptedSession|ciphertext|authTag/i.test(JSON.stringify(health)), false);
});
