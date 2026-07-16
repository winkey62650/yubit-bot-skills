import { timingSafeEqual } from "node:crypto";

import { decryptCredential, encryptCredential, maskApiKey } from "./trading-crypto.mjs";
import { deriveVerifiedOrder, formatVerifiedSignal, parseTraderMessage } from "./trading-domain.mjs";
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
    sleep: options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
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
  if (!response.ok || !body.ok) {
    const status = Number(response.status) || 0;
    const error = new Error(status === 429 ? "TELEGRAM_RATE_LIMITED" : `TELEGRAM_API_ERROR:${status}`);
    const retryAfter = Number(body?.parameters?.retry_after);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) error.retryAfter = retryAfter;
    throw error;
  }
  return body.result;
}

export function verifySpeakerWebhookSecret(actual, expected) {
  if (!actual || !expected) return false;
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

function listFromYubitResponse(value) {
  if (Array.isArray(value)) return value;
  for (const candidate of [value?.list, value?.rows, value?.result, value?.data?.list, value?.data?.rows]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function recordOrderId(record) {
  return String(record?.orderId ?? record?.id ?? "");
}

function recordSymbol(record) {
  return String(record?.symbol ?? "").toUpperCase();
}

function safeOpenedAt(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const milliseconds = number < 10_000_000_000 ? number * 1000 : number;
  const parsed = new Date(milliseconds);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function topicPayload(destination, text) {
  const payload = {
    chat_id: destination.chatId,
    text,
    disable_web_page_preview: true,
  };
  if (destination.threadId) payload.message_thread_id = destination.threadId;
  return payload;
}

async function sendTelegramWithRetry(dependencies, token, payload, maxAttempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const message = await dependencies.telegram(token, "sendMessage", payload);
      return { message, attempts: attempt };
    } catch (error) {
      lastError = error;
      const retryable = error?.retryAfter !== undefined || String(error?.message || "") === "TELEGRAM_RATE_LIMITED";
      if (!retryable || attempt >= maxAttempts) break;
      const retryAfter = Math.min(3, Math.max(0, Number(error?.retryAfter) || 0));
      await dependencies.sleep(retryAfter * 1000);
    }
  }
  if (lastError && typeof lastError === "object") lastError.telegramAttempts = maxAttempts;
  throw lastError ?? new Error("TELEGRAM_SEND_FAILED");
}

async function replyToTrader(dependencies, token, chatId, text) {
  try {
    await dependencies.telegram(token, "sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    });
    return true;
  } catch {
    return false;
  }
}

function traderHelp(accountCount) {
  return [
    "SpeakerBot verifies filled YUBIT orders before publishing them.",
    "",
    "Send:",
    "BTCUSDT 1234567890",
    "TP: 70100 (optional)",
    "SL: 66500 (optional)",
    "Rationale: Breakout retest confirmed (optional)",
    "",
    `Verified read-only accounts linked: ${accountCount}`,
  ].join("\n");
}

function findTraderSignal(signals, parsed) {
  return signals.find((signal) => (
    recordSymbol(signal) === parsed.symbol
    && String(signal.exchangeOrderId ?? "") === parsed.orderId
  ));
}

async function verifySubmittedOrder(parsed, accounts, dependencies) {
  const matches = [];
  const errors = [];
  const key = encryptionKey(dependencies.env);
  for (const account of accounts.filter((candidate) => candidate.status === "verified")) {
    let credentials;
    try {
      credentials = encryptedCredentials(account, key);
      const client = dependencies.yubitClientFactory(credentials);
      const orderResponse = await client.getOrderHistory({
        symbol: parsed.symbol,
        orderId: parsed.orderId,
        limit: 20,
      });
      const order = listFromYubitResponse(orderResponse).find((candidate) => (
        recordOrderId(candidate) === parsed.orderId
        && (!recordSymbol(candidate) || recordSymbol(candidate) === parsed.symbol)
      ));
      if (!order) continue;
      const executionResponse = await client.getExecutions({
        symbol: parsed.symbol,
        orderId: parsed.orderId,
        limit: 100,
      });
      const executions = listFromYubitResponse(executionResponse).filter((candidate) => {
        const orderId = recordOrderId(candidate);
        return (!orderId || orderId === parsed.orderId)
          && (!recordSymbol(candidate) || recordSymbol(candidate) === parsed.symbol);
      });
      matches.push({
        account,
        order,
        verified: deriveVerifiedOrder(order, executions),
      });
    } catch (error) {
      errors.push({ accountId: account.id, errorCode: safeErrorCode(error, "YUBIT_ORDER_VERIFICATION_FAILED") });
    } finally {
      credentials = null;
    }
  }
  return { matches, errors };
}

async function finishUpdate(repository, updateId, status, result = {}) {
  await repository.completeUpdate(updateId, { processingStatus: status });
  return { status, ...result };
}

export async function processSpeakerTelegramUpdate(update, options = {}) {
  const dependencies = await resolveDependencies(options);
  const repository = dependencies.repository;
  const updateId = update?.update_id;
  if (updateId === undefined || updateId === null || updateId === "") return { status: "ignored_invalid_update" };
  if (!(await repository.claimUpdate(String(updateId)))) return { status: "duplicate_update" };

  const token = speakerToken(dependencies.env);
  try {
    if (!token) throw new Error("TELEGRAM_TOKEN_REQUIRED");
    const message = update?.message;
    if (!message || message?.chat?.type !== "private") {
      return finishUpdate(repository, updateId, "ignored_non_private");
    }
    const telegramUserId = message?.from?.id;
    if (telegramUserId === undefined || telegramUserId === null) {
      return finishUpdate(repository, updateId, "ignored_missing_user");
    }

    const trader = await repository.findTraderByTelegramUserId(String(telegramUserId));
    if (!trader) {
      await replyToTrader(dependencies, token, message.chat.id, "This Telegram account is not authorized as a Trader.");
      return finishUpdate(repository, updateId, "unauthorized");
    }
    if (trader.status !== "enabled") {
      await replyToTrader(dependencies, token, message.chat.id, "Your Trader access is currently disabled. Please contact an administrator.");
      return finishUpdate(repository, updateId, "trader_disabled");
    }

    const accounts = await repository.listAccountCredentialsForTrader(trader.id);
    const text = String(message.text ?? message.caption ?? "").trim();
    if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
      await replyToTrader(dependencies, token, message.chat.id, traderHelp(accounts.filter((account) => account.status === "verified").length));
      return finishUpdate(repository, updateId, "help");
    }

    const parsed = parseTraderMessage(text);
    if (!parsed.ok) {
      await replyToTrader(dependencies, token, message.chat.id, parsed.help);
      return finishUpdate(repository, updateId, "invalid_format");
    }

    if (parsed.type === "status" || parsed.type === "refresh") {
      const signal = findTraderSignal(await repository.listSignals({ traderId: trader.id, limit: 200 }), parsed);
      const response = signal
        ? `${parsed.symbol} ${parsed.orderId}\nStatus: ${signal.status}\nLast checked: ${signal.lastCheckedAt || "pending"}`
        : "No verified order was found in your trading log for that reference.";
      await replyToTrader(dependencies, token, message.chat.id, response);
      return finishUpdate(repository, updateId, signal ? parsed.type : "signal_not_found");
    }

    const verifiedAccounts = accounts.filter((account) => account.status === "verified");
    if (verifiedAccounts.length === 0) {
      await replyToTrader(dependencies, token, message.chat.id, "No verified YUBIT read-only account is linked to this Trader.");
      return finishUpdate(repository, updateId, "no_verified_account");
    }

    const verification = await verifySubmittedOrder(parsed, verifiedAccounts, dependencies);
    if (verification.matches.length === 0) {
      await replyToTrader(dependencies, token, message.chat.id, "The order could not be verified as filled on a linked YUBIT account. Check the symbol and order ID, then try again.");
      return finishUpdate(repository, updateId, "order_not_verified", {
        errorCodes: verification.errors.map((item) => item.errorCode),
      });
    }
    if (verification.matches.length > 1) {
      await replyToTrader(dependencies, token, message.chat.id, "This order matched more than one linked account and needs administrator review. Nothing was published.");
      return finishUpdate(repository, updateId, "needs_review");
    }

    const { account, order, verified } = verification.matches[0];
    const now = nowDate(dependencies.now);
    const createdSignal = await repository.createSignal({
      traderId: trader.id,
      accountId: account.id,
      exchangeOrderId: parsed.orderId,
      symbol: parsed.symbol,
      side: verified.direction,
      positionIdx: Number.isFinite(Number(order.positionIdx)) ? Number(order.positionIdx) : null,
      leverage: verified.leverage,
      filledQty: verified.filledQty,
      avgEntryPrice: verified.entryPrice,
      tp: parsed.annotations.takeProfit ?? null,
      sl: parsed.annotations.stopLoss ?? null,
      rationale: parsed.annotations.rationale ?? null,
      status: "tracking",
      verificationPayload: {
        orderStatus: String(order.orderStatus ?? order.status ?? "Filled"),
        executionIds: verified.executionIds,
        verifiedAt: now.toISOString(),
      },
      sourceChatId: message.chat.id,
      sourceMessageId: message.message_id,
      openedAt: safeOpenedAt(verified.openedAt),
      nextCheckAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    });

    if (!createdSignal.created) {
      await replyToTrader(dependencies, token, message.chat.id, "This YUBIT order is already in the trading log. It was not published again.");
      return finishUpdate(repository, updateId, "existing_order", { signalId: createdSignal.signal.id });
    }

    const signal = createdSignal.signal;
    await repository.appendEvent({
      signalId: signal.id,
      eventType: "verified",
      actorType: "trader",
      actorId: trader.id,
      telegramUpdateId: updateId,
      payload: signal.verificationPayload,
    });

    const destinations = await repository.resolveDestinations(trader.id);
    const uniqueDestinations = [...new Map(destinations.map((destination) => [
      `${destination.chatId}:${destination.threadId ?? 0}`,
      destination,
    ])).values()];
    const publicText = formatVerifiedSignal({
      ...signal,
      orderId: signal.exchangeOrderId,
      entryPrice: signal.avgEntryPrice,
      annotations: parsed.annotations,
      direction: signal.side,
    }, trader);
    let delivered = 0;
    let failed = 0;
    for (const destination of uniqueDestinations) {
      const createdDelivery = await repository.createDelivery({
        signalId: signal.id,
        publicationType: "signal",
        destinationId: destination.id,
      });
      if (!createdDelivery.created) continue;
      const claimed = await repository.claimDelivery(createdDelivery.delivery.id);
      if (!claimed) continue;
      try {
        const sent = await sendTelegramWithRetry(dependencies, token, topicPayload(destination, publicText));
        await repository.updateDelivery(claimed.id, {
          status: "delivered",
          attempts: claimed.attempts + sent.attempts - 1,
          telegramMessageId: Number(sent.message?.message_id) || null,
          errorCode: null,
          errorMessageSafe: null,
        });
        delivered += 1;
      } catch (error) {
        const code = safeErrorCode(error, "TELEGRAM_SIGNAL_DELIVERY_FAILED");
        await repository.updateDelivery(claimed.id, {
          status: "failed",
          attempts: claimed.attempts + Math.max(0, Number(error?.telegramAttempts || 1) - 1),
          errorCode: code,
          errorMessageSafe: "Telegram delivery failed. Retry from the trading log.",
        });
        failed += 1;
      }
    }

    await replyToTrader(
      dependencies,
      token,
      message.chat.id,
      `Order verified and saved. Delivered to ${delivered} target(s)${failed ? `; ${failed} target(s) need retry` : ""}.`,
    );
    return finishUpdate(repository, updateId, "published", { signalId: signal.id, delivered, failed });
  } catch (error) {
    await repository.releaseUpdate(String(updateId));
    throw error;
  }
}

export async function configureSpeakerWebhook(options = {}) {
  const dependencies = await resolveDependencies(options);
  const token = speakerToken(dependencies.env);
  const secret = String(dependencies.env?.SPEAKER_TELEGRAM_WEBHOOK_SECRET || "").trim();
  if (!token) throw new Error("TELEGRAM_TOKEN_REQUIRED");
  if (!secret) throw new Error("TELEGRAM_WEBHOOK_SECRET_REQUIRED");
  const baseUrl = String(
    dependencies.env?.APP_BASE_URL
    || (dependencies.env?.VERCEL_PROJECT_PRODUCTION_URL ? `https://${dependencies.env.VERCEL_PROJECT_PRODUCTION_URL}` : "")
    || (dependencies.env?.VERCEL_URL ? `https://${dependencies.env.VERCEL_URL}` : ""),
  ).replace(/\/+$/, "");
  if (!baseUrl.startsWith("https://")) throw new Error("TELEGRAM_WEBHOOK_HTTPS_REQUIRED");
  const url = `${baseUrl}/api/telegram/speaker-webhook`;
  const configured = await dependencies.telegram(token, "setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  });
  return sanitizeTradingResponse({
    ok: configured !== false,
    url,
    configuredAt: nowDate(dependencies.now).toISOString(),
  }, [token, secret]);
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
