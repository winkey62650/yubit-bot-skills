import { decryptCredential, encryptCredential, parseEncryptionKey } from "./trading-crypto.mjs";
import { telegramUserPublisherStatus } from "./telegram-delivery.mjs";

export const TELEGRAM_USER_SESSION_META_KEY = "telegram-user-publisher-v1";

function username(value) {
  return String(value || "").trim().replace(/^@/, "");
}

function mismatchError(expected, actual) {
  const error = new Error(`Telegram login must be @${expected}, but is @${actual || "unknown"}.`);
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
      if (user?.bot) {
        throw new Error("Bot accounts are not supported for user sessions.");
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
      
      const userId = record.userId;
      await repository.setMeta(`telegram-session-v1:${userId}`, record);
      
      // Update catalog
      const accountsRecord = await repository.getMeta("telegram-authorized-accounts-v1") || { accounts: [] };
      const accounts = Array.isArray(accountsRecord.accounts) ? accountsRecord.accounts : [];
      const existingIndex = accounts.findIndex(a => a.userId === userId);
      const summary = {
        userId,
        username: record.username,
        firstName: record.firstName,
        authorizedAt: record.authorizedAt
      };
      if (existingIndex >= 0) {
        accounts[existingIndex] = summary;
      } else {
        accounts.push(summary);
      }
      await repository.setMeta("telegram-authorized-accounts-v1", { accounts });
      
      return this.status(userId);
    },

    async listAccounts() {
      assertConfigured();
      const accountsRecord = await repository.getMeta("telegram-authorized-accounts-v1") || { accounts: [] };
      return Array.isArray(accountsRecord.accounts) ? accountsRecord.accounts : [];
    },

    async load(userId) {
      assertConfigured();
      // If no userId provided, try to load the first available account
      if (!userId) {
         const accounts = await this.listAccounts();
         if (accounts.length > 0) {
           userId = accounts[0].userId;
         } else {
           throw configurationError("No Telegram accounts authorized.");
         }
      }
      
      const record = await repository.getMeta(`telegram-session-v1:${userId}`);
      if (!record?.encryptedSession) throw configurationError(`Telegram account (userId: ${userId}) not authorized.`);
      
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

    async status(userId) {
      assertConfigured();
      if (!userId) {
         const accounts = await this.listAccounts();
         if (accounts.length > 0) {
           userId = accounts[0].userId;
         }
      }
      let record = null;
      if (userId) {
         record = await repository.getMeta(`telegram-session-v1:${userId}`);
      }
      
      return {
        configured: Boolean(encryptionKey),
        credentialsConfigured: Boolean(record?.apiId && record?.encryptedApiHash),
        authorized: Boolean(record?.encryptedSession),
        expectedUsername: null,
        username: record?.username || null,
        userId: record?.userId || null,
        firstName: record?.firstName || null,
        authorizedAt: record?.authorizedAt || null,
        lastVerifiedAt: record?.lastVerifiedAt || null,
        lastError: record?.lastError || null
      };
    },

    async clear(userId) {
      if (!userId) throw new Error("userId required to clear session");
      await repository.setMeta(`telegram-session-v1:${userId}`, null);
      
      const accountsRecord = await repository.getMeta("telegram-authorized-accounts-v1") || { accounts: [] };
      const accounts = Array.isArray(accountsRecord.accounts) ? accountsRecord.accounts : [];
      const updatedAccounts = accounts.filter(a => a.userId !== userId);
      await repository.setMeta("telegram-authorized-accounts-v1", { accounts: updatedAccounts });
      
      return { authorized: false };
    }
  };
}

export async function telegramUserPublisherHealth(options = {}) {
  const env = options.env ?? process.env;
  const routing = telegramUserPublisherStatus(env);
  if (routing.mode === "bot") {
    return {
      ...routing,
      configured: routing.credentialsReady,
      authorized: routing.credentialsReady,
      userId: null,
      firstName: "SpeakerBot",
      authorizedAt: null,
      lastVerifiedAt: null,
      lastError: null
    };
  }
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
