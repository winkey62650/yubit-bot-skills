import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { missingDatabaseMessage, persistentDatabaseConfig } from "./deployment-config.mjs";
import { readJson, writeJson } from "./json-store.js";

const localStatePath = "trading-center.json";
const accountSecrets = ["credentialCiphertext", "credentialIv", "credentialAuthTag"];
const traderStatuses = new Set(["enabled", "disabled"]);
const accountStatuses = new Set(["pending", "verified", "invalid", "disabled"]);
let repositoryPromise;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function emptyState() {
  return {
    schemaVersion: 1,
    traders: [],
    accounts: [],
    traderAccounts: [],
    signals: [],
    events: [],
    destinations: [],
    deliveries: [],
    pnlPublications: [],
    webhookUpdates: [],
    meta: {},
    updatedAt: null
  };
}

function stamp(clock) {
  return new Date(clock()).toISOString();
}

function normalizeTelegramUserId(value) {
  const id = String(value ?? "").trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error("Telegram 用户必须使用数字 ID");
  return id;
}

function normalizeSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (!symbol) throw new Error("交易对不能为空");
  return symbol;
}

function normalizeOrderId(value) {
  const orderId = String(value ?? "").trim();
  if (!orderId) throw new Error("订单号不能为空");
  return orderId;
}

function safeAccount(account) {
  if (!account) return null;
  const result = clone(account);
  for (const key of accountSecrets) delete result[key];
  return result;
}

function signalKey(value) {
  return `${value.accountId}:${normalizeSymbol(value.symbol)}:${normalizeOrderId(value.exchangeOrderId)}`;
}

function destinationKey(value) {
  const scopeType = value.scopeType === "trader" ? "trader" : "workspace";
  const scopeId = scopeType === "trader" ? String(value.scopeId ?? "") : "";
  return [scopeType, scopeId, String(value.chatId ?? ""), Number(value.threadId ?? 0)].join(":");
}

function deliveryKey(value) {
  return [value.signalId, value.publicationType, value.destinationId].join(":");
}

function hydrateState(value) {
  const fallback = emptyState();
  const state = { ...fallback, ...(value ?? {}) };
  for (const key of ["traders", "accounts", "traderAccounts", "signals", "events", "destinations", "deliveries", "pnlPublications", "webhookUpdates"]) {
    if (!Array.isArray(state[key])) state[key] = [];
  }
  if (!state.meta || typeof state.meta !== "object" || Array.isArray(state.meta)) state.meta = {};
  return state;
}

export class JsonTradingRepository {
  constructor({
    path = localStatePath,
    now = () => new Date(),
    readJsonImpl = readJson,
    writeJsonImpl = writeJson
  } = {}) {
    this.path = path;
    this.now = now;
    this.readJsonImpl = readJsonImpl;
    this.writeJsonImpl = writeJsonImpl;
    this.writeQueue = Promise.resolve();
  }

  async read() {
    return hydrateState(await this.readJsonImpl(this.path, emptyState()));
  }

  async mutate(callback) {
    const run = this.writeQueue.then(async () => {
      const state = await this.read();
      const result = await callback(state);
      state.schemaVersion = 1;
      state.updatedAt = stamp(this.now);
      await this.writeJsonImpl(this.path, state);
      return clone(result);
    });
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  async health() {
    await this.read();
    return { ok: true, driver: "json-local", durable: !process.env.VERCEL };
  }

  async saveTrader(input) {
    const telegramUserId = normalizeTelegramUserId(input.telegramUserId);
    const displayName = String(input.displayName ?? "").trim();
    if (!displayName) throw new Error("Trader 名称不能为空");
    const status = input.status ?? "enabled";
    if (!traderStatuses.has(status)) throw new Error("Trader 状态无效");
    return this.mutate((state) => {
      const id = input.id ?? randomUUID();
      const duplicate = state.traders.find((row) => row.telegramUserId === telegramUserId && row.id !== id);
      if (duplicate) throw new Error("该 Telegram 数字 ID 已绑定其他 Trader");
      const index = state.traders.findIndex((row) => row.id === id);
      const now = stamp(this.now);
      const row = {
        id,
        displayName,
        telegramUserId,
        telegramUsername: String(input.telegramUsername ?? "").trim().replace(/^@/, "") || null,
        status,
        createdAt: index >= 0 ? state.traders[index].createdAt : now,
        updatedAt: now
      };
      if (index >= 0) state.traders[index] = row;
      else state.traders.push(row);
      return row;
    });
  }

  async getTrader(id) {
    return clone((await this.read()).traders.find((row) => row.id === id) ?? null);
  }

  async findTraderByTelegramUserId(telegramUserId) {
    const id = String(telegramUserId ?? "").trim();
    return clone((await this.read()).traders.find((row) => row.telegramUserId === id) ?? null);
  }

  async listTraders() {
    return clone((await this.read()).traders.sort((a, b) => a.displayName.localeCompare(b.displayName)));
  }

  async saveAccount(input) {
    const label = String(input.label ?? "").trim();
    if (!label) throw new Error("账户名称不能为空");
    const status = input.status ?? "pending";
    if (!accountStatuses.has(status)) throw new Error("账户状态无效");
    return this.mutate((state) => {
      const id = input.id ?? randomUUID();
      const index = state.accounts.findIndex((row) => row.id === id);
      const current = index >= 0 ? state.accounts[index] : {};
      const now = stamp(this.now);
      const row = {
        ...current,
        id,
        exchange: input.exchange ?? current.exchange ?? "yubit",
        label,
        credentialCiphertext: input.credentialCiphertext ?? current.credentialCiphertext ?? null,
        credentialIv: input.credentialIv ?? current.credentialIv ?? null,
        credentialAuthTag: input.credentialAuthTag ?? current.credentialAuthTag ?? null,
        keyVersion: Number(input.keyVersion ?? current.keyVersion ?? 1),
        apiKeyMasked: input.apiKeyMasked ?? current.apiKeyMasked ?? null,
        status,
        lastVerifiedAt: input.lastVerifiedAt ?? current.lastVerifiedAt ?? null,
        lastErrorCode: input.lastErrorCode ?? current.lastErrorCode ?? null,
        createdAt: current.createdAt ?? now,
        updatedAt: now
      };
      if (index >= 0) state.accounts[index] = row;
      else state.accounts.push(row);
      return safeAccount(row);
    });
  }

  async getAccount(id) {
    return safeAccount((await this.read()).accounts.find((row) => row.id === id) ?? null);
  }

  async getAccountWithCredentials(id) {
    return clone((await this.read()).accounts.find((row) => row.id === id) ?? null);
  }

  async listAccounts() {
    return (await this.read()).accounts.map(safeAccount).sort((a, b) => a.label.localeCompare(b.label));
  }

  async linkTraderAccounts(traderId, accountIds, defaultAccountId = null) {
    return this.mutate((state) => {
      if (!state.traders.some((row) => row.id === traderId)) throw new Error("Trader 不存在");
      const uniqueIds = [...new Set((accountIds ?? []).map(String))];
      for (const accountId of uniqueIds) {
        if (!state.accounts.some((row) => row.id === accountId)) throw new Error("YUBIT 账户不存在");
      }
      if (defaultAccountId && !uniqueIds.includes(String(defaultAccountId))) throw new Error("默认账户必须先关联到 Trader");
      state.traderAccounts = state.traderAccounts.filter((row) => row.traderId !== traderId);
      const now = stamp(this.now);
      for (const [index, accountId] of uniqueIds.entries()) {
        state.traderAccounts.push({
          traderId,
          accountId,
          isDefault: defaultAccountId ? accountId === String(defaultAccountId) : index === 0,
          createdAt: now
        });
      }
      return state.traderAccounts.filter((row) => row.traderId === traderId);
    });
  }

  async listAccountsForTrader(traderId) {
    const state = await this.read();
    const links = new Map(state.traderAccounts.filter((row) => row.traderId === traderId).map((row) => [row.accountId, row]));
    return state.accounts.filter((row) => links.has(row.id)).map((row) => ({ ...safeAccount(row), isDefault: links.get(row.id).isDefault }));
  }

  async listAccountCredentialsForTrader(traderId) {
    const state = await this.read();
    const links = new Map(state.traderAccounts.filter((row) => row.traderId === traderId).map((row) => [row.accountId, row]));
    return clone(state.accounts.filter((row) => links.has(row.id)).map((row) => ({ ...row, isDefault: links.get(row.id).isDefault })));
  }

  async listTradersForAccount(accountId) {
    const state = await this.read();
    const ids = new Set(state.traderAccounts.filter((row) => row.accountId === accountId).map((row) => row.traderId));
    return clone(state.traders.filter((row) => ids.has(row.id)));
  }

  async saveDestination(input) {
    const scopeType = input.scopeType === "trader" ? "trader" : "workspace";
    const scopeId = scopeType === "trader" ? String(input.scopeId ?? "") : "";
    const chatId = String(input.chatId ?? "").trim();
    if (!chatId) throw new Error("目标群 ID 不能为空");
    if (scopeType === "trader" && !scopeId) throw new Error("Trader 专属目标缺少 Trader");
    return this.mutate((state) => {
      const id = input.id ?? randomUUID();
      const candidate = { ...input, id, scopeType, scopeId, chatId, threadId: Number(input.threadId ?? 0) || null };
      const duplicate = state.destinations.find((row) => destinationKey(row) === destinationKey(candidate) && row.id !== id);
      if (duplicate) throw new Error("该发送目标已存在");
      const index = state.destinations.findIndex((row) => row.id === id);
      const current = index >= 0 ? state.destinations[index] : {};
      const now = stamp(this.now);
      const row = {
        ...current,
        id,
        scopeType,
        scopeId,
        chatId,
        threadId: candidate.threadId,
        chatTitle: String(input.chatTitle ?? current.chatTitle ?? "").trim() || null,
        topicTitle: String(input.topicTitle ?? current.topicTitle ?? "").trim() || null,
        enabled: input.enabled ?? current.enabled ?? true,
        lastVerifiedAt: input.lastVerifiedAt ?? current.lastVerifiedAt ?? null,
        lastErrorCode: input.lastErrorCode ?? current.lastErrorCode ?? null,
        createdAt: current.createdAt ?? now,
        updatedAt: now
      };
      if (index >= 0) state.destinations[index] = row;
      else state.destinations.push(row);
      return row;
    });
  }

  async getDestination(id) {
    return clone((await this.read()).destinations.find((row) => row.id === id) ?? null);
  }

  async listDestinations() {
    return clone((await this.read()).destinations);
  }

  async resolveDestinations(traderId) {
    const enabled = (await this.read()).destinations.filter((row) => row.enabled !== false);
    const traderRows = enabled.filter((row) => row.scopeType === "trader" && row.scopeId === traderId);
    return clone(traderRows.length ? traderRows : enabled.filter((row) => row.scopeType === "workspace"));
  }

  async claimUpdate(updateId) {
    return this.mutate((state) => {
      const key = String(updateId);
      if (state.webhookUpdates.some((row) => row.updateId === key)) return false;
      state.webhookUpdates.push({ updateId: key, receivedAt: stamp(this.now), processingStatus: "processing", safeErrorCode: null });
      if (state.webhookUpdates.length > 10000) state.webhookUpdates = state.webhookUpdates.slice(-10000);
      return true;
    });
  }

  async releaseUpdate(updateId) {
    return this.mutate((state) => {
      state.webhookUpdates = state.webhookUpdates.filter((row) => row.updateId !== String(updateId));
      return true;
    });
  }

  async completeUpdate(updateId, { processingStatus = "completed", safeErrorCode = null } = {}) {
    return this.mutate((state) => {
      const row = state.webhookUpdates.find((item) => item.updateId === String(updateId));
      if (!row) return null;
      row.processingStatus = processingStatus;
      row.safeErrorCode = safeErrorCode;
      return row;
    });
  }

  async createSignal(input) {
    const candidate = { ...input, symbol: normalizeSymbol(input.symbol), exchangeOrderId: normalizeOrderId(input.exchangeOrderId) };
    return this.mutate((state) => {
      const existing = state.signals.find((row) => signalKey(row) === signalKey(candidate));
      if (existing) return { signal: existing, created: false };
      const now = stamp(this.now);
      const signal = {
        id: input.id ?? randomUUID(),
        traderId: input.traderId,
        accountId: input.accountId,
        exchangeOrderId: candidate.exchangeOrderId,
        symbol: candidate.symbol,
        side: input.side ?? null,
        positionIdx: input.positionIdx ?? null,
        leverage: input.leverage ?? null,
        filledQty: input.filledQty ?? null,
        avgEntryPrice: input.avgEntryPrice ?? null,
        avgExitPrice: input.avgExitPrice ?? null,
        tp: input.tp ?? null,
        sl: input.sl ?? null,
        rationale: input.rationale ?? null,
        status: input.status ?? "pending_verification",
        verificationPayload: clone(input.verificationPayload ?? null),
        verificationErrorCode: input.verificationErrorCode ?? null,
        sourceChatId: input.sourceChatId == null ? null : String(input.sourceChatId),
        sourceMessageId: input.sourceMessageId == null ? null : Number(input.sourceMessageId),
        openedAt: input.openedAt ?? null,
        closedAt: input.closedAt ?? null,
        realizedPnl: input.realizedPnl ?? null,
        roi: input.roi ?? null,
        roiMethod: input.roiMethod ?? null,
        nextCheckAt: input.nextCheckAt ?? null,
        leaseUntil: null,
        checkAttempts: 0,
        lastCheckedAt: null,
        createdAt: now,
        updatedAt: now
      };
      state.signals.push(signal);
      return { signal, created: true };
    });
  }

  async getSignal(id) {
    return clone((await this.read()).signals.find((row) => row.id === id) ?? null);
  }

  async listSignals({ traderId = "", status = "", limit = 200 } = {}) {
    const rows = (await this.read()).signals.filter((row) => (!traderId || row.traderId === traderId) && (!status || row.status === status));
    return clone(rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit));
  }

  async updateSignal(id, patch) {
    return this.mutate((state) => {
      const index = state.signals.findIndex((row) => row.id === id);
      if (index < 0) return null;
      const protectedFields = new Set(["id", "traderId", "accountId", "symbol", "exchangeOrderId", "createdAt", "checkAttempts", "lastCheckedAt", "leaseUntil"]);
      const safePatch = Object.fromEntries(Object.entries(clone(patch ?? {})).filter(([key]) => !protectedFields.has(key)));
      state.signals[index] = { ...state.signals[index], ...safePatch, updatedAt: stamp(this.now) };
      return state.signals[index];
    });
  }

  async appendEvent(input) {
    return this.mutate((state) => {
      const event = {
        id: input.id ?? randomUUID(),
        signalId: input.signalId,
        eventType: input.eventType,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        payload: clone(input.payload ?? {}),
        telegramUpdateId: input.telegramUpdateId == null ? null : String(input.telegramUpdateId),
        createdAt: input.createdAt ?? stamp(this.now)
      };
      state.events.push(event);
      return event;
    });
  }

  async listEvents(signalId) {
    return clone((await this.read()).events.filter((row) => row.signalId === signalId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }

  async createDelivery(input) {
    return this.mutate((state) => {
      const existing = state.deliveries.find((row) => deliveryKey(row) === deliveryKey(input));
      if (existing) return { delivery: existing, created: false };
      const now = stamp(this.now);
      const delivery = {
        id: input.id ?? randomUUID(),
        signalId: input.signalId,
        publicationType: input.publicationType,
        destinationId: input.destinationId,
        status: input.status ?? "pending",
        attempts: Number(input.attempts ?? 0),
        telegramMessageId: input.telegramMessageId ?? null,
        errorCode: input.errorCode ?? null,
        errorMessageSafe: input.errorMessageSafe ?? null,
        idempotencyKey: deliveryKey(input),
        createdAt: now,
        updatedAt: now
      };
      state.deliveries.push(delivery);
      return { delivery, created: true };
    });
  }

  async getDelivery(id) {
    return clone((await this.read()).deliveries.find((row) => row.id === id) ?? null);
  }

  async listDeliveries({ signalId = "", status = "", limit = 200 } = {}) {
    const rows = (await this.read()).deliveries.filter((row) => (!signalId || row.signalId === signalId) && (!status || row.status === status));
    return clone(rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit));
  }

  async updateDelivery(id, patch) {
    return this.mutate((state) => {
      const index = state.deliveries.findIndex((row) => row.id === id);
      if (index < 0) return null;
      const protectedFields = new Set(["id", "signalId", "publicationType", "destinationId", "idempotencyKey", "createdAt"]);
      const safePatch = Object.fromEntries(Object.entries(clone(patch ?? {})).filter(([key]) => !protectedFields.has(key)));
      state.deliveries[index] = { ...state.deliveries[index], ...safePatch, updatedAt: stamp(this.now) };
      return state.deliveries[index];
    });
  }

  async claimDelivery(id) {
    return this.mutate((state) => {
      const row = state.deliveries.find((item) => item.id === id);
      if (!row || !["pending", "failed"].includes(row.status)) return null;
      row.status = "sending";
      row.attempts += 1;
      row.updatedAt = stamp(this.now);
      return row;
    });
  }

  async createPnlPublication(input) {
    return this.mutate((state) => {
      const existing = state.pnlPublications.find((row) => row.signalId === input.signalId);
      if (existing) return { publication: existing, created: false };
      const now = stamp(this.now);
      const publication = {
        id: input.id ?? randomUUID(),
        signalId: input.signalId,
        realizedPnl: input.realizedPnl ?? null,
        roi: input.roi ?? null,
        cardAssetUrl: input.cardAssetUrl ?? null,
        cardPayload: clone(input.cardPayload ?? null),
        status: input.status ?? "pending",
        publishedAt: input.publishedAt ?? null,
        createdAt: now,
        updatedAt: now
      };
      state.pnlPublications.push(publication);
      return { publication, created: true };
    });
  }

  async getPnlPublicationBySignal(signalId) {
    return clone((await this.read()).pnlPublications.find((row) => row.signalId === signalId) ?? null);
  }

  async updatePnlPublication(id, patch) {
    return this.mutate((state) => {
      const index = state.pnlPublications.findIndex((row) => row.id === id);
      if (index < 0) return null;
      const safePatch = clone(patch ?? {});
      delete safePatch.id;
      delete safePatch.signalId;
      delete safePatch.createdAt;
      state.pnlPublications[index] = { ...state.pnlPublications[index], ...safePatch, updatedAt: stamp(this.now) };
      return state.pnlPublications[index];
    });
  }

  async claimDueSignals(now = this.now(), limit = 25, leaseMs = 60_000) {
    const at = new Date(now);
    const nowMs = at.getTime();
    if (!Number.isFinite(nowMs)) throw new Error("调度时间无效");
    return this.mutate((state) => {
      const due = state.signals
        .filter((row) => row.status === "tracking"
          && (!row.nextCheckAt || Date.parse(row.nextCheckAt) <= nowMs)
          && (!row.leaseUntil || Date.parse(row.leaseUntil) <= nowMs))
        .sort((a, b) => String(a.nextCheckAt ?? "").localeCompare(String(b.nextCheckAt ?? "")))
        .slice(0, Math.max(1, Math.min(Number(limit) || 25, 100)));
      for (const row of due) {
        row.leaseUntil = new Date(nowMs + leaseMs).toISOString();
        row.lastCheckedAt = at.toISOString();
        row.checkAttempts = Number(row.checkAttempts ?? 0) + 1;
        row.updatedAt = at.toISOString();
      }
      return due;
    });
  }

  async claimSignalForCheck(id, now = this.now(), leaseMs = 60_000) {
    const at = new Date(now);
    const nowMs = at.getTime();
    if (!Number.isFinite(nowMs)) throw new Error("调度时间无效");
    return this.mutate((state) => {
      const row = state.signals.find((item) => item.id === id);
      if (!row || row.status !== "tracking") return null;
      if (row.leaseUntil && Date.parse(row.leaseUntil) > nowMs) return null;
      row.leaseUntil = new Date(nowMs + leaseMs).toISOString();
      row.lastCheckedAt = at.toISOString();
      row.checkAttempts = Number(row.checkAttempts ?? 0) + 1;
      row.updatedAt = at.toISOString();
      return row;
    });
  }

  async completeSignalCheck(id, patch = {}) {
    return this.mutate((state) => {
      const row = state.signals.find((item) => item.id === id);
      if (!row) return null;
      const protectedFields = new Set(["id", "traderId", "accountId", "symbol", "exchangeOrderId", "createdAt", "checkAttempts", "lastCheckedAt"]);
      for (const [key, value] of Object.entries(clone(patch))) if (!protectedFields.has(key)) row[key] = value;
      row.leaseUntil = null;
      row.updatedAt = stamp(this.now);
      return row;
    });
  }

  async getMeta(key) {
    return clone((await this.read()).meta[key] ?? null);
  }

  async setMeta(key, value) {
    return this.mutate((state) => {
      state.meta[key] = clone(value);
      return value;
    });
  }
}

function rowTrader(row) {
  return row ? {
    id: row.id,
    displayName: row.display_name,
    telegramUserId: String(row.telegram_user_id),
    telegramUsername: row.telegram_username,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } : null;
}

function rowAccount(row, includeCredentials = false) {
  if (!row) return null;
  const result = {
    id: row.id,
    exchange: row.exchange,
    label: row.label,
    keyVersion: row.key_version,
    apiKeyMasked: row.api_key_masked,
    status: row.status,
    lastVerifiedAt: row.last_verified_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (includeCredentials) Object.assign(result, {
    credentialCiphertext: row.credential_ciphertext,
    credentialIv: row.credential_iv,
    credentialAuthTag: row.credential_auth_tag
  });
  if (row.is_default != null) result.isDefault = row.is_default;
  return result;
}

function rowDestination(row) {
  return row ? {
    id: row.id,
    scopeType: row.scope_type,
    scopeId: row.scope_id || "",
    chatId: row.chat_id,
    threadId: Number(row.thread_id) || null,
    chatTitle: row.chat_title,
    topicTitle: row.topic_title,
    enabled: row.enabled,
    lastVerifiedAt: row.last_verified_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } : null;
}

function rowSignal(row) {
  return row ? {
    id: row.id,
    traderId: row.trader_id,
    accountId: row.account_id,
    exchangeOrderId: row.exchange_order_id,
    symbol: row.symbol,
    side: row.side,
    positionIdx: row.position_idx,
    leverage: row.leverage,
    filledQty: row.filled_qty,
    avgEntryPrice: row.avg_entry_price,
    avgExitPrice: row.avg_exit_price,
    tp: row.tp,
    sl: row.sl,
    rationale: row.rationale,
    status: row.status,
    verificationPayload: row.verification_payload,
    verificationErrorCode: row.verification_error_code,
    sourceChatId: row.source_chat_id,
    sourceMessageId: row.source_message_id == null ? null : Number(row.source_message_id),
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    realizedPnl: row.realized_pnl,
    roi: row.roi,
    roiMethod: row.roi_method,
    nextCheckAt: row.next_check_at,
    leaseUntil: row.lease_until,
    checkAttempts: Number(row.check_attempts ?? 0),
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } : null;
}

function rowEvent(row) {
  return row ? {
    id: row.id,
    signalId: row.signal_id,
    eventType: row.event_type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    payload: row.payload,
    telegramUpdateId: row.telegram_update_id == null ? null : String(row.telegram_update_id),
    createdAt: row.created_at
  } : null;
}

function rowDelivery(row) {
  return row ? {
    id: row.id,
    signalId: row.signal_id,
    publicationType: row.publication_type,
    destinationId: row.destination_id,
    status: row.status,
    attempts: Number(row.attempts ?? 0),
    telegramMessageId: row.telegram_message_id == null ? null : Number(row.telegram_message_id),
    errorCode: row.error_code,
    errorMessageSafe: row.error_message_safe,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } : null;
}

function rowPnlPublication(row) {
  return row ? {
    id: row.id,
    signalId: row.signal_id,
    realizedPnl: row.realized_pnl,
    roi: row.roi,
    cardAssetUrl: row.card_asset_url,
    cardPayload: row.card_payload,
    status: row.status,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } : null;
}

export class PostgresTradingRepository {
  constructor(databaseUrl) {
    this.sql = neon(databaseUrl);
  }

  async initialize() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS trade_traders (
        id text PRIMARY KEY, display_name text NOT NULL, telegram_user_id text NOT NULL UNIQUE,
        telegram_username text, status text NOT NULL DEFAULT 'enabled',
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE TABLE IF NOT EXISTS trade_exchange_accounts (
        id text PRIMARY KEY, exchange text NOT NULL DEFAULT 'yubit', label text NOT NULL,
        credential_ciphertext text NOT NULL, credential_iv text NOT NULL, credential_auth_tag text NOT NULL,
        key_version integer NOT NULL DEFAULT 1, api_key_masked text NOT NULL,
        status text NOT NULL DEFAULT 'pending', last_verified_at timestamptz, last_error_code text,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE TABLE IF NOT EXISTS trade_trader_accounts (
        trader_id text NOT NULL REFERENCES trade_traders(id) ON DELETE CASCADE,
        account_id text NOT NULL REFERENCES trade_exchange_accounts(id) ON DELETE CASCADE,
        is_default boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(trader_id, account_id))`,
      `CREATE TABLE IF NOT EXISTS trade_signals (
        id text PRIMARY KEY, trader_id text NOT NULL REFERENCES trade_traders(id),
        account_id text NOT NULL REFERENCES trade_exchange_accounts(id), exchange_order_id text NOT NULL,
        symbol text NOT NULL, side text, position_idx integer, leverage numeric, filled_qty numeric,
        avg_entry_price numeric, avg_exit_price numeric, tp numeric, sl numeric, rationale text,
        status text NOT NULL DEFAULT 'pending_verification', verification_payload jsonb,
        verification_error_code text, source_chat_id text, source_message_id bigint,
        opened_at timestamptz, closed_at timestamptz, realized_pnl numeric, roi numeric, roi_method text,
        next_check_at timestamptz, lease_until timestamptz, check_attempts integer NOT NULL DEFAULT 0,
        last_checked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id, symbol, exchange_order_id))`,
      `CREATE TABLE IF NOT EXISTS trade_events (
        id text PRIMARY KEY, signal_id text NOT NULL REFERENCES trade_signals(id) ON DELETE CASCADE,
        event_type text NOT NULL, actor_type text NOT NULL, actor_id text, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        telegram_update_id bigint, created_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE TABLE IF NOT EXISTS trade_destinations (
        id text PRIMARY KEY, scope_type text NOT NULL, scope_id text NOT NULL DEFAULT '',
        chat_id text NOT NULL, thread_id bigint NOT NULL DEFAULT 0, chat_title text, topic_title text,
        enabled boolean NOT NULL DEFAULT true, last_verified_at timestamptz, last_error_code text,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(scope_type, scope_id, chat_id, thread_id))`,
      `CREATE TABLE IF NOT EXISTS trade_deliveries (
        id text PRIMARY KEY, signal_id text NOT NULL REFERENCES trade_signals(id) ON DELETE CASCADE,
        publication_type text NOT NULL, destination_id text NOT NULL REFERENCES trade_destinations(id),
        status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
        telegram_message_id bigint, error_code text, error_message_safe text,
        idempotency_key text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(signal_id, publication_type, destination_id))`,
      `CREATE TABLE IF NOT EXISTS trade_pnl_publications (
        id text PRIMARY KEY, signal_id text NOT NULL UNIQUE REFERENCES trade_signals(id) ON DELETE CASCADE,
        realized_pnl numeric, roi numeric, card_asset_url text, card_payload jsonb,
        status text NOT NULL DEFAULT 'pending', published_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE TABLE IF NOT EXISTS trade_webhook_updates (
        update_id bigint PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now(),
        processing_status text NOT NULL DEFAULT 'processing', safe_error_code text)`,
      `CREATE TABLE IF NOT EXISTS trade_system_meta (
        key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE INDEX IF NOT EXISTS trade_signals_due_idx ON trade_signals(status, next_check_at, lease_until)`,
      `CREATE INDEX IF NOT EXISTS trade_signals_trader_idx ON trade_signals(trader_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS trade_events_signal_idx ON trade_events(signal_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS trade_deliveries_status_idx ON trade_deliveries(status, created_at DESC)`
    ];
    for (const statement of statements) await this.sql.query(statement);
    return this;
  }

  async health() {
    await this.sql.query("SELECT 1 AS ok");
    return { ok: true, driver: "postgres", durable: true };
  }

  async saveTrader(input) {
    const id = input.id ?? randomUUID();
    const telegramUserId = normalizeTelegramUserId(input.telegramUserId);
    const displayName = String(input.displayName ?? "").trim();
    if (!displayName) throw new Error("Trader 名称不能为空");
    const status = input.status ?? "enabled";
    if (!traderStatuses.has(status)) throw new Error("Trader 状态无效");
    try {
      const rows = await this.sql.query(`INSERT INTO trade_traders(id,display_name,telegram_user_id,telegram_username,status)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET display_name=EXCLUDED.display_name,
        telegram_user_id=EXCLUDED.telegram_user_id,telegram_username=EXCLUDED.telegram_username,
        status=EXCLUDED.status,updated_at=now() RETURNING *`,
      [id, displayName, telegramUserId, String(input.telegramUsername ?? "").replace(/^@/, "") || null, status]);
      return rowTrader(rows[0]);
    } catch (error) {
      if (error?.code === "23505") throw new Error("该 Telegram 数字 ID 已绑定其他 Trader");
      throw error;
    }
  }

  async getTrader(id) {
    return rowTrader((await this.sql.query("SELECT * FROM trade_traders WHERE id=$1", [id]))[0]);
  }

  async findTraderByTelegramUserId(id) {
    return rowTrader((await this.sql.query("SELECT * FROM trade_traders WHERE telegram_user_id=$1", [String(id)]))[0]);
  }

  async listTraders() {
    return (await this.sql.query("SELECT * FROM trade_traders ORDER BY display_name")).map(rowTrader);
  }

  async saveAccount(input) {
    const id = input.id ?? randomUUID();
    const current = input.id ? await this.getAccountWithCredentials(id) : null;
    const values = {
      exchange: input.exchange ?? current?.exchange ?? "yubit",
      label: String(input.label ?? current?.label ?? "").trim(),
      credentialCiphertext: input.credentialCiphertext ?? current?.credentialCiphertext,
      credentialIv: input.credentialIv ?? current?.credentialIv,
      credentialAuthTag: input.credentialAuthTag ?? current?.credentialAuthTag,
      keyVersion: input.keyVersion ?? current?.keyVersion ?? 1,
      apiKeyMasked: input.apiKeyMasked ?? current?.apiKeyMasked,
      status: input.status ?? current?.status ?? "pending",
      lastVerifiedAt: input.lastVerifiedAt ?? current?.lastVerifiedAt,
      lastErrorCode: input.lastErrorCode ?? current?.lastErrorCode
    };
    if (!values.label || !values.credentialCiphertext || !values.credentialIv || !values.credentialAuthTag || !values.apiKeyMasked) throw new Error("账户凭证不完整");
    const rows = await this.sql.query(`INSERT INTO trade_exchange_accounts
      (id,exchange,label,credential_ciphertext,credential_iv,credential_auth_tag,key_version,api_key_masked,status,last_verified_at,last_error_code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET
      exchange=EXCLUDED.exchange,label=EXCLUDED.label,credential_ciphertext=EXCLUDED.credential_ciphertext,
      credential_iv=EXCLUDED.credential_iv,credential_auth_tag=EXCLUDED.credential_auth_tag,
      key_version=EXCLUDED.key_version,api_key_masked=EXCLUDED.api_key_masked,status=EXCLUDED.status,
      last_verified_at=EXCLUDED.last_verified_at,last_error_code=EXCLUDED.last_error_code,updated_at=now() RETURNING *`,
    [id, values.exchange, values.label, values.credentialCiphertext, values.credentialIv, values.credentialAuthTag,
      values.keyVersion, values.apiKeyMasked, values.status, values.lastVerifiedAt, values.lastErrorCode]);
    return rowAccount(rows[0]);
  }

  async getAccount(id) {
    return rowAccount((await this.sql.query("SELECT * FROM trade_exchange_accounts WHERE id=$1", [id]))[0]);
  }

  async getAccountWithCredentials(id) {
    return rowAccount((await this.sql.query("SELECT * FROM trade_exchange_accounts WHERE id=$1", [id]))[0], true);
  }

  async listAccounts() {
    return (await this.sql.query("SELECT * FROM trade_exchange_accounts ORDER BY label")).map(rowAccount);
  }

  async linkTraderAccounts(traderId, accountIds, defaultAccountId = null) {
    const ids = [...new Set((accountIds ?? []).map(String))];
    if (defaultAccountId && !ids.includes(String(defaultAccountId))) throw new Error("默认账户必须先关联到 Trader");
    await this.sql.query("DELETE FROM trade_trader_accounts WHERE trader_id=$1", [traderId]);
    for (const [index, accountId] of ids.entries()) {
      await this.sql.query(`INSERT INTO trade_trader_accounts(trader_id,account_id,is_default)
        VALUES($1,$2,$3) ON CONFLICT(trader_id,account_id) DO UPDATE SET is_default=EXCLUDED.is_default`,
      [traderId, accountId, defaultAccountId ? accountId === String(defaultAccountId) : index === 0]);
    }
    return this.listAccountsForTrader(traderId);
  }

  async listAccountsForTrader(traderId) {
    const rows = await this.sql.query(`SELECT a.*,ta.is_default FROM trade_exchange_accounts a
      JOIN trade_trader_accounts ta ON ta.account_id=a.id WHERE ta.trader_id=$1 ORDER BY ta.is_default DESC,a.label`, [traderId]);
    return rows.map((row) => rowAccount(row));
  }

  async listAccountCredentialsForTrader(traderId) {
    const rows = await this.sql.query(`SELECT a.*,ta.is_default FROM trade_exchange_accounts a
      JOIN trade_trader_accounts ta ON ta.account_id=a.id WHERE ta.trader_id=$1 ORDER BY ta.is_default DESC,a.label`, [traderId]);
    return rows.map((row) => rowAccount(row, true));
  }

  async listTradersForAccount(accountId) {
    return (await this.sql.query(`SELECT t.* FROM trade_traders t JOIN trade_trader_accounts ta ON ta.trader_id=t.id
      WHERE ta.account_id=$1 ORDER BY t.display_name`, [accountId])).map(rowTrader);
  }

  async saveDestination(input) {
    const id = input.id ?? randomUUID();
    const scopeType = input.scopeType === "trader" ? "trader" : "workspace";
    const scopeId = scopeType === "trader" ? String(input.scopeId ?? "") : "";
    if (scopeType === "trader" && !scopeId) throw new Error("Trader 专属目标缺少 Trader");
    try {
      const rows = await this.sql.query(`INSERT INTO trade_destinations
        (id,scope_type,scope_id,chat_id,thread_id,chat_title,topic_title,enabled,last_verified_at,last_error_code)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET
        scope_type=EXCLUDED.scope_type,scope_id=EXCLUDED.scope_id,chat_id=EXCLUDED.chat_id,
        thread_id=EXCLUDED.thread_id,chat_title=EXCLUDED.chat_title,topic_title=EXCLUDED.topic_title,
        enabled=EXCLUDED.enabled,last_verified_at=EXCLUDED.last_verified_at,last_error_code=EXCLUDED.last_error_code,
        updated_at=now() RETURNING *`,
      [id, scopeType, scopeId, String(input.chatId), Number(input.threadId ?? 0), input.chatTitle ?? null,
        input.topicTitle ?? null, input.enabled ?? true, input.lastVerifiedAt ?? null, input.lastErrorCode ?? null]);
      return rowDestination(rows[0]);
    } catch (error) {
      if (error?.code === "23505") throw new Error("该发送目标已存在");
      throw error;
    }
  }

  async getDestination(id) {
    return rowDestination((await this.sql.query("SELECT * FROM trade_destinations WHERE id=$1", [id]))[0]);
  }

  async listDestinations() {
    return (await this.sql.query("SELECT * FROM trade_destinations ORDER BY created_at")).map(rowDestination);
  }

  async resolveDestinations(traderId) {
    const rows = await this.sql.query(`WITH trader_targets AS (
      SELECT * FROM trade_destinations WHERE enabled=true AND scope_type='trader' AND scope_id=$1)
      SELECT * FROM trader_targets UNION ALL SELECT * FROM trade_destinations
      WHERE enabled=true AND scope_type='workspace' AND NOT EXISTS (SELECT 1 FROM trader_targets)
      ORDER BY created_at`, [traderId]);
    return rows.map(rowDestination);
  }

  async claimUpdate(updateId) {
    return Boolean((await this.sql.query(`INSERT INTO trade_webhook_updates(update_id) VALUES($1)
      ON CONFLICT DO NOTHING RETURNING update_id`, [updateId]))[0]);
  }

  async releaseUpdate(updateId) {
    await this.sql.query("DELETE FROM trade_webhook_updates WHERE update_id=$1", [updateId]);
    return true;
  }

  async completeUpdate(updateId, { processingStatus = "completed", safeErrorCode = null } = {}) {
    return (await this.sql.query(`UPDATE trade_webhook_updates SET processing_status=$2,safe_error_code=$3
      WHERE update_id=$1 RETURNING *`, [updateId, processingStatus, safeErrorCode]))[0] ?? null;
  }

  async createSignal(input) {
    const id = input.id ?? randomUUID();
    const symbol = normalizeSymbol(input.symbol);
    const orderId = normalizeOrderId(input.exchangeOrderId);
    const rows = await this.sql.query(`INSERT INTO trade_signals
      (id,trader_id,account_id,exchange_order_id,symbol,side,position_idx,leverage,filled_qty,avg_entry_price,
      avg_exit_price,tp,sl,rationale,status,verification_payload,verification_error_code,source_chat_id,
      source_message_id,opened_at,closed_at,realized_pnl,roi,roi_method,next_check_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21,$22,$23,$24,$25)
      ON CONFLICT(account_id,symbol,exchange_order_id) DO UPDATE SET updated_at=trade_signals.updated_at RETURNING *, (xmax = 0) AS inserted`,
    [id, input.traderId, input.accountId, orderId, symbol, input.side ?? null, input.positionIdx ?? null,
      input.leverage ?? null, input.filledQty ?? null, input.avgEntryPrice ?? null, input.avgExitPrice ?? null,
      input.tp ?? null, input.sl ?? null, input.rationale ?? null, input.status ?? "pending_verification",
      JSON.stringify(input.verificationPayload ?? null), input.verificationErrorCode ?? null,
      input.sourceChatId == null ? null : String(input.sourceChatId), input.sourceMessageId ?? null,
      input.openedAt ?? null, input.closedAt ?? null, input.realizedPnl ?? null, input.roi ?? null,
      input.roiMethod ?? null, input.nextCheckAt ?? null]);
    return { signal: rowSignal(rows[0]), created: Boolean(rows[0].inserted) };
  }

  async getSignal(id) {
    return rowSignal((await this.sql.query("SELECT * FROM trade_signals WHERE id=$1", [id]))[0]);
  }

  async listSignals({ traderId = "", status = "", limit = 200 } = {}) {
    const rows = await this.sql.query(`SELECT * FROM trade_signals WHERE ($1='' OR trader_id=$1)
      AND ($2='' OR status=$2) ORDER BY created_at DESC LIMIT $3`, [traderId, status, limit]);
    return rows.map(rowSignal);
  }

  async updateSignal(id, patch) {
    const current = await this.getSignal(id);
    if (!current) return null;
    const merged = { ...current, ...patch };
    const rows = await this.sql.query(`UPDATE trade_signals SET side=$2,position_idx=$3,leverage=$4,
      filled_qty=$5,avg_entry_price=$6,avg_exit_price=$7,tp=$8,sl=$9,rationale=$10,status=$11,
      verification_payload=$12::jsonb,verification_error_code=$13,opened_at=$14,closed_at=$15,
      realized_pnl=$16,roi=$17,roi_method=$18,next_check_at=$19,updated_at=now() WHERE id=$1 RETURNING *`,
    [id, merged.side, merged.positionIdx, merged.leverage, merged.filledQty, merged.avgEntryPrice,
      merged.avgExitPrice, merged.tp, merged.sl, merged.rationale, merged.status,
      JSON.stringify(merged.verificationPayload), merged.verificationErrorCode, merged.openedAt,
      merged.closedAt, merged.realizedPnl, merged.roi, merged.roiMethod, merged.nextCheckAt]);
    return rowSignal(rows[0]);
  }

  async appendEvent(input) {
    const rows = await this.sql.query(`INSERT INTO trade_events
      (id,signal_id,event_type,actor_type,actor_id,payload,telegram_update_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,COALESCE($8::timestamptz,now())) RETURNING *`,
    [input.id ?? randomUUID(), input.signalId, input.eventType, input.actorType, input.actorId ?? null,
      JSON.stringify(input.payload ?? {}), input.telegramUpdateId ?? null, input.createdAt ?? null]);
    return rowEvent(rows[0]);
  }

  async listEvents(signalId) {
    return (await this.sql.query("SELECT * FROM trade_events WHERE signal_id=$1 ORDER BY created_at,id", [signalId])).map(rowEvent);
  }

  async createDelivery(input) {
    const idempotencyKey = deliveryKey(input);
    const rows = await this.sql.query(`INSERT INTO trade_deliveries
      (id,signal_id,publication_type,destination_id,status,attempts,telegram_message_id,error_code,error_message_safe,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(signal_id,publication_type,destination_id)
      DO UPDATE SET updated_at=trade_deliveries.updated_at RETURNING *, (xmax = 0) AS inserted`,
    [input.id ?? randomUUID(), input.signalId, input.publicationType, input.destinationId, input.status ?? "pending",
      input.attempts ?? 0, input.telegramMessageId ?? null, input.errorCode ?? null,
      input.errorMessageSafe ?? null, idempotencyKey]);
    return { delivery: rowDelivery(rows[0]), created: Boolean(rows[0].inserted) };
  }

  async getDelivery(id) {
    return rowDelivery((await this.sql.query("SELECT * FROM trade_deliveries WHERE id=$1", [id]))[0]);
  }

  async listDeliveries({ signalId = "", status = "", limit = 200 } = {}) {
    return (await this.sql.query(`SELECT * FROM trade_deliveries WHERE ($1='' OR signal_id=$1)
      AND ($2='' OR status=$2) ORDER BY created_at DESC LIMIT $3`, [signalId, status, limit])).map(rowDelivery);
  }

  async updateDelivery(id, patch) {
    const current = await this.getDelivery(id);
    if (!current) return null;
    const merged = { ...current, ...patch };
    return rowDelivery((await this.sql.query(`UPDATE trade_deliveries SET status=$2,attempts=$3,
      telegram_message_id=$4,error_code=$5,error_message_safe=$6,updated_at=now() WHERE id=$1 RETURNING *`,
    [id, merged.status, merged.attempts, merged.telegramMessageId, merged.errorCode, merged.errorMessageSafe]))[0]);
  }

  async claimDelivery(id) {
    return rowDelivery((await this.sql.query(`UPDATE trade_deliveries SET status='sending',attempts=attempts+1,updated_at=now()
      WHERE id=$1 AND status IN ('pending','failed') RETURNING *`, [id]))[0]);
  }

  async createPnlPublication(input) {
    const rows = await this.sql.query(`INSERT INTO trade_pnl_publications
      (id,signal_id,realized_pnl,roi,card_asset_url,card_payload,status,published_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(signal_id) DO UPDATE
      SET updated_at=trade_pnl_publications.updated_at RETURNING *, (xmax = 0) AS inserted`,
    [input.id ?? randomUUID(), input.signalId, input.realizedPnl ?? null, input.roi ?? null,
      input.cardAssetUrl ?? null, JSON.stringify(input.cardPayload ?? null), input.status ?? "pending", input.publishedAt ?? null]);
    return { publication: rowPnlPublication(rows[0]), created: Boolean(rows[0].inserted) };
  }

  async getPnlPublicationBySignal(signalId) {
    return rowPnlPublication((await this.sql.query("SELECT * FROM trade_pnl_publications WHERE signal_id=$1", [signalId]))[0]);
  }

  async updatePnlPublication(id, patch) {
    const currentRows = await this.sql.query("SELECT * FROM trade_pnl_publications WHERE id=$1", [id]);
    const current = rowPnlPublication(currentRows[0]);
    if (!current) return null;
    const merged = { ...current, ...patch };
    return rowPnlPublication((await this.sql.query(`UPDATE trade_pnl_publications SET realized_pnl=$2,roi=$3,
      card_asset_url=$4,card_payload=$5::jsonb,status=$6,published_at=$7,updated_at=now() WHERE id=$1 RETURNING *`,
    [id, merged.realizedPnl, merged.roi, merged.cardAssetUrl, JSON.stringify(merged.cardPayload), merged.status, merged.publishedAt]))[0]);
  }

  async claimDueSignals(now = new Date(), limit = 25, leaseMs = 60_000) {
    const rows = await this.sql.query(`WITH due AS (
      SELECT id FROM trade_signals WHERE status='tracking' AND (next_check_at IS NULL OR next_check_at <= $1::timestamptz)
      AND (lease_until IS NULL OR lease_until <= $1::timestamptz) ORDER BY next_check_at NULLS FIRST
      FOR UPDATE SKIP LOCKED LIMIT $2)
      UPDATE trade_signals s SET lease_until=$1::timestamptz + ($3::bigint * interval '1 millisecond'),
      last_checked_at=$1::timestamptz,check_attempts=s.check_attempts+1,updated_at=now()
      FROM due WHERE s.id=due.id RETURNING s.*`, [new Date(now).toISOString(), Math.min(Number(limit) || 25, 100), leaseMs]);
    return rows.map(rowSignal);
  }

  async claimSignalForCheck(id, now = new Date(), leaseMs = 60_000) {
    const at = new Date(now);
    if (!Number.isFinite(at.getTime())) throw new Error("调度时间无效");
    return rowSignal((await this.sql.query(`UPDATE trade_signals SET
      lease_until=$2::timestamptz + ($3::bigint * interval '1 millisecond'),
      last_checked_at=$2::timestamptz,check_attempts=check_attempts+1,updated_at=now()
      WHERE id=$1 AND status='tracking'
      AND (lease_until IS NULL OR lease_until <= $2::timestamptz) RETURNING *`,
    [id, at.toISOString(), leaseMs]))[0]);
  }

  async completeSignalCheck(id, patch = {}) {
    const current = await this.getSignal(id);
    if (!current) return null;
    const updated = await this.updateSignal(id, patch);
    return rowSignal((await this.sql.query("UPDATE trade_signals SET lease_until=NULL WHERE id=$1 RETURNING *", [updated.id]))[0]);
  }

  async getMeta(key) {
    return (await this.sql.query("SELECT value FROM trade_system_meta WHERE key=$1", [key]))[0]?.value ?? null;
  }

  async setMeta(key, value) {
    await this.sql.query(`INSERT INTO trade_system_meta(key,value) VALUES($1,$2::jsonb)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [key, JSON.stringify(value)]);
    return value;
  }
}

export async function getTradingRepository() {
  if (!repositoryPromise) {
    repositoryPromise = (async () => {
      const database = persistentDatabaseConfig(process.env);
      if (database.url) return new PostgresTradingRepository(database.url).initialize();
      const previewFallback = process.env.VERCEL_ENV === "preview"
        && process.env.TRADING_ALLOW_JSON_FALLBACK === "true"
        && Boolean(process.env.BLOB_READ_WRITE_TOKEN);
      if (previewFallback) return new JsonTradingRepository();
      if (process.env.VERCEL || process.env.NODE_ENV === "production") {
        throw new Error(missingDatabaseMessage("交易中心", process.env));
      }
      return new JsonTradingRepository();
    })();
  }
  return repositoryPromise;
}

export function resetTradingRepositoryForTests() {
  repositoryPromise = undefined;
}
