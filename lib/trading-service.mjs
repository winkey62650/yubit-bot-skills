import { timingSafeEqual } from "node:crypto";

import { decryptCredential, encryptCredential, maskApiKey } from "./trading-crypto.mjs";
import { getTradingRepository } from "./trading-repository.mjs";
import { YubitReadonlyClient } from "./yubit-readonly-client.mjs";

const AUDIT_META_KEY = "trading-admin-audit";
const SCHEDULER_META_KEY = "trading-reconcile";
const CREDENTIAL_ALGORITHM = "aes-256-gcm";
const SYMBOL_PATTERN = /^[A-Z0-9]{2,30}$/;
const ADMIN_STATUSES = new Set(["administrator", "creator"]);
const SECRET_KEY_PATTERN = /(?:^api[_-]?key$|api[_-]?secret|bot[_-]?token|webhook[_-]?secret|secret[_-]?token|credential|ciphertext|auth[_-]?tag|^iv$|encryption[_-]?key)/i;

function nowDate(value) {
  const candidate = typeof value === "function" ? value() : value;
  const date = candidate instanceof Date ? candidate : new Date(candidate ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error("系统时间无效");
  return date;
}

function normalizedSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(symbol)) throw new Error("交易对格式无效，例如 BTCUSDT");
  return symbol;
}

function speakerToken(env) {
  return String(env?.SPEAKER_BOT_TOKEN || env?.TRADER1_BOT_TOKEN || "").trim();
}

function encryptionKey(env) {
  const key = String(env?.TRADER_CREDENTIALS_ENCRYPTION_KEY || "").trim();
  if (!key) throw new Error("交易账户加密密钥未配置");
  return key;
}

async function resolveDependencies(options = {}) {
  const env = options.env ?? process.env;
  return {
    repository: options.repository ?? await getTradingRepository(),
    env,
    now: options.now ?? (() => new Date()),
    telegram: options.telegram ?? telegramCall,
    yubitClientFactory: options.yubitClientFactory ?? ((credentials) => new YubitReadonlyClient(credentials)),
  };
}

function replaceSecretValues(value, secrets) {
  let result = String(value);
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

export function sanitizeTradingResponse(value, secrets = []) {
  const knownSecrets = [...new Set((secrets ?? []).filter((item) => typeof item === "string" && item.length >= 4))];
  const visit = (item, seen) => {
    if (typeof item === "string") return replaceSecretValues(item, knownSecrets);
    if (item === null || typeof item !== "object") return item;
    if (seen.has(item)) return "[Circular]";
    seen.add(item);
    if (Array.isArray(item)) {
      const output = item.map((entry) => visit(entry, seen));
      seen.delete(item);
      return output;
    }
    const output = {};
    for (const [key, entry] of Object.entries(item)) {
      if (key !== "apiKeyMasked" && SECRET_KEY_PATTERN.test(key)) continue;
      output[key] = visit(entry, seen);
    }
    seen.delete(item);
    return output;
  };
  return visit(value, new WeakSet());
}

function safeErrorCode(error, fallback) {
  const message = String(error?.message || "");
  const known = message.match(/(?:YUBIT|TELEGRAM|CREDENTIAL)_[A-Z0-9_]+(?::\d+)?/);
  return known?.[0] || fallback;
}

async function appendAdminAudit(repository, now, action, targetId, metadata = {}) {
  const current = await repository.getMeta(AUDIT_META_KEY);
  const rows = Array.isArray(current) ? current : [];
  rows.push(sanitizeTradingResponse({
    action,
    targetId: targetId == null ? null : String(targetId),
    metadata,
    createdAt: nowDate(now).toISOString(),
  }));
  await repository.setMeta(AUDIT_META_KEY, rows.slice(-200));
}

export async function telegramCall(botToken, method, payload = {}) {
  if (!botToken) throw new Error("TELEGRAM_TOKEN_REQUIRED");
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch {
    throw new Error("TELEGRAM_NETWORK_ERROR");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(`TELEGRAM_API_ERROR:${Number(response.status) || 0}`);
  return body.result;
}

export function verifySpeakerWebhookSecret(actual, expected) {
  if (!actual || !expected) return false;
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function saveTrader(input, options = {}) {
  const dependencies = await resolveDependencies(options);
  const trader = await dependencies.repository.saveTrader(input ?? {});
  await appendAdminAudit(dependencies.repository, dependencies.now, "save-trader", trader.id, {
    status: trader.status,
  });
  return sanitizeTradingResponse(trader);
}

function encryptedCredentials(account, key) {
  const plaintext = decryptCredential({
    version: 1,
    keyVersion: String(account.keyVersion ?? 1),
    algorithm: CREDENTIAL_ALGORITHM,
    iv: account.credentialIv,
    ciphertext: account.credentialCiphertext,
    authTag: account.credentialAuthTag,
  }, key);
  let parsed;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error("CREDENTIAL_DECRYPTION_FAILED");
  }
  if (!parsed?.apiKey || !parsed?.apiSecret) throw new Error("CREDENTIAL_DECRYPTION_FAILED");
  return { apiKey: String(parsed.apiKey), apiSecret: String(parsed.apiSecret) };
}

async function synchronizeAccountLinks(repository, accountId, desiredTraderIds, defaultTraderIds = []) {
  const desired = new Set((desiredTraderIds ?? []).map(String));
  const defaults = new Set((defaultTraderIds ?? []).map(String));
  const traders = await repository.listTraders();
  const known = new Set(traders.map((trader) => trader.id));
  for (const traderId of desired) if (!known.has(traderId)) throw new Error("Trader 不存在");
  for (const trader of traders) {
    const accounts = await repository.listAccountsForTrader(trader.id);
    const ids = accounts.map((account) => account.id).filter((id) => id !== accountId);
    if (desired.has(trader.id)) ids.push(accountId);
    const currentDefault = accounts.find((account) => account.isDefault && account.id !== accountId)?.id ?? null;
    const defaultAccountId = desired.has(trader.id) && (defaults.has(trader.id) || !currentDefault)
      ? accountId
      : currentDefault;
    await repository.linkTraderAccounts(trader.id, ids, defaultAccountId);
  }
}

export async function saveExchangeAccount(input, options = {}) {
  const dependencies = await resolveDependencies(options);
  const repository = dependencies.repository;
  const current = input?.id ? await repository.getAccountWithCredentials(String(input.id)) : null;
  if (input?.id && !current) throw new Error("YUBIT 账户不存在");
  const changingCredentials = Boolean(input?.apiKey || input?.apiSecret);
  if (!current && (!input?.apiKey || !input?.apiSecret)) throw new Error("API Key 和 API Secret 均为必填");
  if (changingCredentials && (!input?.apiKey || !input?.apiSecret)) throw new Error("更换凭证时必须同时填写 API Key 和 API Secret");

  let credentialFields = {};
  let apiKeyMasked = current?.apiKeyMasked ?? null;
  const secrets = [];
  if (!current || changingCredentials) {
    const apiKey = String(input.apiKey).trim();
    const apiSecret = String(input.apiSecret);
    if (!apiKey || !apiSecret) throw new Error("API Key 和 API Secret 均为必填");
    const keyVersion = 1;
    const encrypted = encryptCredential(JSON.stringify({ apiKey, apiSecret }), encryptionKey(dependencies.env), {
      keyVersion: String(keyVersion),
    });
    credentialFields = {
      credentialCiphertext: encrypted.ciphertext,
      credentialIv: encrypted.iv,
      credentialAuthTag: encrypted.authTag,
      keyVersion,
    };
    apiKeyMasked = maskApiKey(apiKey);
    secrets.push(apiKey, apiSecret);
  }

  const account = await repository.saveAccount({
    id: current?.id,
    exchange: "yubit",
    label: input?.label ?? current?.label,
    ...credentialFields,
    apiKeyMasked,
    status: changingCredentials || !current ? "pending" : (input?.status ?? current.status),
    lastVerifiedAt: changingCredentials ? null : current?.lastVerifiedAt,
    lastErrorCode: changingCredentials ? null : current?.lastErrorCode,
  });
  await synchronizeAccountLinks(repository, account.id, input?.traderIds ?? [], input?.defaultTraderIds ?? []);
  const linkedTraders = await repository.listTradersForAccount(account.id);
  await appendAdminAudit(repository, dependencies.now, "save-account", account.id, {
    linkedTraderCount: linkedTraders.length,
    credentialsChanged: !current || changingCredentials,
  });
  return sanitizeTradingResponse({ account, traderIds: linkedTraders.map((trader) => trader.id) }, secrets);
}

export async function verifyExchangeAccount(input, options = {}) {
  const dependencies = await resolveDependencies(options);
  const repository = dependencies.repository;
  const account = await repository.getAccountWithCredentials(String(input?.accountId ?? ""));
  if (!account) throw new Error("YUBIT 账户不存在");
  const symbol = normalizedSymbol(input?.symbol);
  let credentials;
  try {
    credentials = encryptedCredentials(account, encryptionKey(dependencies.env));
    const client = dependencies.yubitClientFactory(credentials);
    await client.getOrderHistory({ symbol, limit: 1 });
    const verified = await repository.saveAccount({
      id: account.id,
      label: account.label,
      status: "verified",
      lastVerifiedAt: nowDate(dependencies.now).toISOString(),
      lastErrorCode: null,
    });
    await appendAdminAudit(repository, dependencies.now, "verify-account", account.id, { ok: true, symbol });
    return sanitizeTradingResponse({ ok: true, account: verified }, [credentials.apiKey, credentials.apiSecret]);
  } catch (error) {
    const code = safeErrorCode(error, "YUBIT_ACCOUNT_VERIFICATION_FAILED");
    await repository.saveAccount({
      id: account.id,
      label: account.label,
      status: "invalid",
      lastVerifiedAt: null,
      lastErrorCode: code,
    });
    await appendAdminAudit(repository, dependencies.now, "verify-account", account.id, { ok: false, errorCode: code, symbol });
    const safeError = new Error(code);
    safeError.statusCode = 400;
    throw safeError;
  }
}

export async function saveTradingDestination(input, options = {}) {
  const dependencies = await resolveDependencies(options);
  if (input?.scopeType === "trader" && !(await dependencies.repository.getTrader(String(input.scopeId ?? "")))) {
    throw new Error("Trader 不存在");
  }
  const destination = await dependencies.repository.saveDestination(input ?? {});
  await appendAdminAudit(dependencies.repository, dependencies.now, "save-destination", destination.id, {
    scopeType: destination.scopeType,
    enabled: destination.enabled,
  });
  return sanitizeTradingResponse(destination);
}

export async function verifyTradingDestination(destinationId, options = {}) {
  const dependencies = await resolveDependencies(options);
  const repository = dependencies.repository;
  const destination = await repository.getDestination(String(destinationId ?? ""));
  if (!destination) throw new Error("发送目标不存在");
  const token = speakerToken(dependencies.env);
  if (!token) throw new Error("SpeakerBot 未配置");
  try {
    const me = await dependencies.telegram(token, "getMe", {});
    const chat = await dependencies.telegram(token, "getChat", { chat_id: destination.chatId });
    const member = await dependencies.telegram(token, "getChatMember", { chat_id: destination.chatId, user_id: me.id });
    const canPost = ADMIN_STATUSES.has(member?.status) && member?.can_post_messages !== false;
    if (!canPost) throw new Error("TELEGRAM_TARGET_PERMISSION_DENIED");
    if (destination.threadId) {
      await dependencies.telegram(token, "sendChatAction", {
        chat_id: destination.chatId,
        message_thread_id: destination.threadId,
        action: "typing",
      });
    }
    const saved = await repository.saveDestination({
      ...destination,
      chatTitle: chat?.title || destination.chatTitle,
      lastVerifiedAt: nowDate(dependencies.now).toISOString(),
      lastErrorCode: null,
    });
    await appendAdminAudit(repository, dependencies.now, "verify-destination", saved.id, { ok: true });
    return sanitizeTradingResponse({ ok: true, destination: saved, botUsername: me?.username || null }, [token]);
  } catch (error) {
    const code = safeErrorCode(error, "TELEGRAM_TARGET_VALIDATION_FAILED");
    const saved = await repository.saveDestination({ ...destination, lastVerifiedAt: null, lastErrorCode: code });
    await appendAdminAudit(repository, dependencies.now, "verify-destination", destination.id, { ok: false, errorCode: code });
    return sanitizeTradingResponse({ ok: false, destination: saved, errorCode: code }, [token]);
  }
}

export async function testTradingDestination(destinationId, options = {}) {
  const dependencies = await resolveDependencies(options);
  const destination = await dependencies.repository.getDestination(String(destinationId ?? ""));
  if (!destination) throw new Error("发送目标不存在");
  const token = speakerToken(dependencies.env);
  if (!token) throw new Error("SpeakerBot 未配置");
  const payload = {
    chat_id: destination.chatId,
    text: "✅ SpeakerBot 交易信号目标测试成功\n\n此消息仅用于确认群与 Topic 的发送权限。",
    disable_web_page_preview: true,
  };
  if (destination.threadId) payload.message_thread_id = destination.threadId;
  try {
    const message = await dependencies.telegram(token, "sendMessage", payload);
    await appendAdminAudit(dependencies.repository, dependencies.now, "test-destination", destination.id, { ok: true });
    return { ok: true, telegramMessageId: Number(message?.message_id) || null };
  } catch (error) {
    const code = safeErrorCode(error, "TELEGRAM_TEST_MESSAGE_FAILED");
    await appendAdminAudit(dependencies.repository, dependencies.now, "test-destination", destination.id, { ok: false, errorCode: code });
    const safeError = new Error(code);
    safeError.statusCode = 400;
    throw safeError;
  }
}

export async function getTradingHealth(options = {}) {
  const dependencies = await resolveDependencies(options);
  const repository = dependencies.repository;
  const token = speakerToken(dependencies.env);
  const [database, accounts, destinations, scheduler] = await Promise.all([
    repository.health().catch((error) => ({ ok: false, errorCode: safeErrorCode(error, "DATABASE_UNAVAILABLE") })),
    repository.listAccounts(),
    repository.listDestinations(),
    repository.getMeta(SCHEDULER_META_KEY),
  ]);
  let speakerBot = { ok: false, configured: Boolean(token), webhookConfigured: false, errorCode: token ? null : "TELEGRAM_TOKEN_REQUIRED" };
  if (token) {
    try {
      const [me, webhook] = await Promise.all([
        dependencies.telegram(token, "getMe", {}),
        dependencies.telegram(token, "getWebhookInfo", {}),
      ]);
      speakerBot = {
        ok: Boolean(me?.id && webhook?.url),
        configured: true,
        username: me?.username || null,
        webhookConfigured: Boolean(webhook?.url),
        pendingUpdates: Number(webhook?.pending_update_count ?? 0),
        lastErrorDate: webhook?.last_error_date ? new Date(Number(webhook.last_error_date) * 1000).toISOString() : null,
      };
    } catch (error) {
      speakerBot = { ok: false, configured: true, webhookConfigured: false, errorCode: safeErrorCode(error, "TELEGRAM_HEALTH_FAILED") };
    }
  }
  return sanitizeTradingResponse({
    database,
    speakerBot,
    scheduler: scheduler ?? { lastRunAt: null, nextRunAt: null, errorCode: "NOT_RUN_YET" },
    accounts: accounts.map((account) => ({
      id: account.id,
      label: account.label,
      apiKeyMasked: account.apiKeyMasked,
      status: account.status,
      lastVerifiedAt: account.lastVerifiedAt,
      lastErrorCode: account.lastErrorCode,
    })),
    destinations: destinations.map((destination) => ({
      id: destination.id,
      chatId: destination.chatId,
      threadId: destination.threadId,
      chatTitle: destination.chatTitle,
      topicTitle: destination.topicTitle,
      enabled: destination.enabled,
      lastVerifiedAt: destination.lastVerifiedAt,
      lastErrorCode: destination.lastErrorCode,
    })),
  }, [token, dependencies.env?.TRADER_CREDENTIALS_ENCRYPTION_KEY]);
}

export async function getTradingManagementOverview(options = {}) {
  const dependencies = await resolveDependencies(options);
  const repository = dependencies.repository;
  const [traders, accounts, destinations, signals, deliveries, health] = await Promise.all([
    repository.listTraders(),
    repository.listAccounts(),
    repository.listDestinations(),
    repository.listSignals({ limit: 200 }),
    repository.listDeliveries({ limit: 200 }),
    getTradingHealth(dependencies),
  ]);
  return sanitizeTradingResponse({ traders, accounts, destinations, signals, deliveries, health });
}
