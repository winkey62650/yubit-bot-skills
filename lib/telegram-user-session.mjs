import { decryptCredential, encryptCredential, parseEncryptionKey } from "./trading-crypto.mjs";
import { telegramUserPublisherStatus } from "./telegram-delivery.mjs";

export const TELEGRAM_USER_SESSION_META_KEY = "telegram-user-publisher-v1";

function username(value) {
  return String(value || "").trim().replace(/^@/, "");
}

function mismatchError(expected, actual) {
  const error = new Error(`Telegram 登录账号必须是 @${expected}，当前是 @${actual || "unknown"}。`);
  error.code = "TELEGRAM_USER_IDENTITY_MISMATCH";
  return error;
}

function configurationError(message = "Telegram 用户会话加密密钥未配置。") {
  const error = new Error(message);
  error.code = "TELEGRAM_USER_SESSION_NOT_CONFIGURED";
  return error;
}

function invalidSessionError() {
  const error = new Error("Telegram 用户授权未返回有效会话，已停止保存。");
  error.code = "TELEGRAM_USER_SESSION_INVALID";
  return error;
}

export function createTelegramUserSessionStore(options = {}) {
  const repository = options.repository;
  const encryptionKey = String(options.encryptionKey || "").trim();
  const expectedUsername = username(options.expectedUsername || "Serenity_Crypto");
  const now = options.now ?? (() => new Date());

  if (!repository || typeof repository.getMeta !== "function" || typeof repository.setMeta !== "function") {
    throw new TypeError("repository with getMeta/setMeta is required");
  }

  function assertConfigured() {
    if (!encryptionKey) throw configurationError();
    try {
      parseEncryptionKey(encryptionKey);
    } catch {
      throw configurationError("Telegram 用户会话加密密钥格式无效，必须是 32 字节。");
    }
  }

  async function readRecord() {
    const record = await repository.getMeta(TELEGRAM_USER_SESSION_META_KEY);
    return record && typeof record === "object" ? record : null;
  }

  return {
    async save({ session, user, apiCredentials }) {
      assertConfigured();
      const serializedSession = String(session || "").trim();
      if (!serializedSession) throw invalidSessionError();
      const actualUsername = username(user?.username);
      if (user?.bot || actualUsername.toLowerCase() !== expectedUsername.toLowerCase()) {
        throw mismatchError(expectedUsername, actualUsername);
      }
      const apiId = Number(apiCredentials?.apiId);
      const apiHash = String(apiCredentials?.apiHash || "").trim();
      const record = {
        version: 2,
        username: actualUsername,
        userId: String(user?.id ?? ""),
        firstName: String(user?.firstName || user?.first_name || "").trim(),
        authorizedAt: now().toISOString(),
        lastVerifiedAt: null,
        lastError: null,
        encryptedSession: encryptCredential(serializedSession, encryptionKey, {
          keyVersion: "telegram-user-v1"
        })
      };
      if (Number.isSafeInteger(apiId) && apiId > 0 && apiHash) {
        record.apiId = apiId;
        record.encryptedApiHash = encryptCredential(apiHash, encryptionKey, {
          keyVersion: "telegram-api-hash-v1"
        });
      }
      await repository.setMeta(TELEGRAM_USER_SESSION_META_KEY, record);
      return this.status();
    },

    async load() {
      assertConfigured();
      const record = await readRecord();
      if (!record?.encryptedSession) throw configurationError("Telegram 用户账号尚未授权。");
      const restored = {
        session: decryptCredential(record.encryptedSession, encryptionKey),
        username: record.username,
        userId: record.userId,
        firstName: record.firstName,
        authorizedAt: record.authorizedAt,
        lastVerifiedAt: record.lastVerifiedAt,
        lastError: record.lastError
      };
      if (Number.isSafeInteger(Number(record.apiId)) && record.encryptedApiHash) {
        restored.apiId = Number(record.apiId);
        restored.apiHash = decryptCredential(record.encryptedApiHash, encryptionKey);
      }
      return restored;
    },

    async status() {
      const record = await readRecord();
      return {
        configured: Boolean(encryptionKey),
        credentialsConfigured: Boolean(record?.apiId && record?.encryptedApiHash),
        authorized: Boolean(record?.encryptedSession),
        expectedUsername,
        username: record?.username || null,
        userId: record?.userId || null,
        firstName: record?.firstName || null,
        authorizedAt: record?.authorizedAt || null,
        lastVerifiedAt: record?.lastVerifiedAt || null,
        lastError: record?.lastError || null
      };
    },

    async clear() {
      await repository.setMeta(TELEGRAM_USER_SESSION_META_KEY, null);
      return this.status();
    }
  };
}

export async function telegramUserPublisherHealth(options = {}) {
  const env = options.env ?? process.env;
  const routing = telegramUserPublisherStatus(env);
  const store = createTelegramUserSessionStore({
    repository: options.repository,
    encryptionKey: env.TELEGRAM_USER_SESSION_ENCRYPTION_KEY,
    expectedUsername: env.TELEGRAM_USER_PUBLISHER_USERNAME || "Serenity_Crypto"
  });
  const session = await store.status();
  const credentialsReady = routing.credentialsReady || session.credentialsConfigured;
  return {
    ...routing,
    credentialsReady,
    ready: routing.required
      && credentialsReady
      && routing.encryptionReady
      && routing.routingReady
      && session.authorized,
    configured: session.configured,
    authorized: session.authorized,
    username: session.username ? `@${username(session.username)}` : routing.username,
    userId: session.userId,
    firstName: session.firstName,
    authorizedAt: session.authorizedAt,
    lastVerifiedAt: session.lastVerifiedAt,
    lastError: session.lastError
  };
}
