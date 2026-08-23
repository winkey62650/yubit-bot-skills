import { createHash } from "node:crypto";
import { createObsidianContentStore } from "./obsidian-content-store.mjs";

const RECEIPT_SCHEMA = "yubit-distribution-receipt/v1";
const FEEDBACK_SCHEMA = "yubit-delivery-feedback/v1";
const RECEIPT_STATUSES = new Set(["success", "failed", "partial"]);

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("feedback receipt contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  throw new TypeError("feedback receipt must contain JSON-compatible values only");
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function requiredString(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function optionalString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeMessageId(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  const canonical = normalized.replace(/^0+(?=\d)/, "");
  return canonical === "0" ? null : canonical;
}

function normalizeEndpoint(receipt) {
  if (receipt.endpoint && typeof receipt.endpoint === "object") {
    if (receipt.platform === "discord") {
      return {
        platform: "discord",
        endpoint: {
          guildId: requiredString(receipt.endpoint.guildId, "endpoint.guildId"),
          channelId: requiredString(receipt.endpoint.channelId, "endpoint.channelId"),
        },
      };
    }
    if (receipt.platform === "telegram") {
      const chatId = requiredString(receipt.endpoint.chatId, "endpoint.chatId");
      const threadId = Number(receipt.endpoint.threadId);
      const endpoint = { chatId };
      if (Number.isInteger(threadId) && threadId > 0) endpoint.threadId = threadId;
      else if (receipt.endpoint.chatType === "channel") endpoint.chatType = "channel";
      else throw new TypeError("endpoint.threadId must be a positive integer for Telegram topics");
      return { platform: "telegram", endpoint };
    }
    throw new TypeError("receipt platform must be telegram or discord");
  }
  const target = receipt.target && typeof receipt.target === "object" ? receipt.target : {};
  const discord = target.platform === "discord" || target.guildId != null || target.channelId != null;
  if (discord) {
    return {
      platform: "discord",
      endpoint: {
        guildId: requiredString(target.guildId, "target.guildId"),
        channelId: requiredString(target.channelId, "target.channelId"),
      },
    };
  }
  const chatId = requiredString(target.chatId, "target.chatId");
  const threadId = Number(target.threadId);
  const endpoint = { chatId };
  if (Number.isInteger(threadId) && threadId > 0) endpoint.threadId = threadId;
  else if (target.chatType === "channel") endpoint.chatType = "channel";
  else throw new TypeError("target.threadId must be a positive integer for Telegram topics");
  return { platform: "telegram", endpoint };
}

function normalizeSteps(steps) {
  if (!steps || typeof steps !== "object") return null;
  const completed = [...new Set((Array.isArray(steps.completed) ? steps.completed : [])
    .map((step) => String(step ?? "").trim()).filter(Boolean))].sort();
  const total = Number(steps.total);
  if (!Number.isInteger(total) || total < completed.length) {
    throw new TypeError("steps.total must be an integer no smaller than completed steps");
  }
  return { completed, total };
}

function normalizeReceipt(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("delivery receipt must be an object");
  }
  const status = String(input.status ?? "").trim();
  if (!RECEIPT_STATUSES.has(status)) throw new TypeError("receipt status must be success, failed, or partial");
  const attempt = Number(input.attempt ?? input.attempts ?? 1);
  if (!Number.isInteger(attempt) || attempt < 1) throw new TypeError("receipt attempt must be a positive integer");
  const { platform, endpoint } = normalizeEndpoint(input);
  const messageIds = [...new Set((Array.isArray(input.messageIds) ? input.messageIds : [input.messageId])
    .map(normalizeMessageId).filter(Boolean))];
  const occurredAtValue = optionalString(input.occurredAt);
  const occurredAt = occurredAtValue ? new Date(occurredAtValue) : null;
  if (occurredAt && Number.isNaN(occurredAt.valueOf())) throw new TypeError("receipt occurredAt must be a valid date");
  const steps = normalizeSteps(input.steps);
  const error = optionalString(input.error);
  const contentProductId = optionalString(input.contentProductId);
  const contentHash = optionalString(input.contentHash);
  return {
    deliveryId: requiredString(input.deliveryId, "deliveryId"),
    eventId: requiredString(input.eventId, "eventId"),
    ruleId: requiredString(input.ruleId, "ruleId"),
    targetId: requiredString(input.targetId, "targetId"),
    platform,
    endpoint,
    status,
    attempt,
    messageIds,
    ...(contentProductId ? { contentProductId } : {}),
    ...(contentHash ? { contentHash } : {}),
    ...(steps ? { steps } : {}),
    ...(error ? { error } : {}),
    ...(occurredAt ? { occurredAt: occurredAt.toISOString() } : {}),
  };
}

function emptyAggregate(receipt, id, updatedAt) {
  return {
    id,
    schema: FEEDBACK_SCHEMA,
    deliveryId: receipt.deliveryId,
    eventId: receipt.eventId,
    ruleId: receipt.ruleId,
    targetId: receipt.targetId,
    ...(receipt.contentProductId ? { contentProductId: receipt.contentProductId } : {}),
    ...(receipt.contentHash ? { contentHash: receipt.contentHash } : {}),
    platforms: [receipt.platform],
    status: receipt.status,
    complete: false,
    receiptCount: 0,
    successfulReceipts: 0,
    failedReceipts: 0,
    partialReceipts: 0,
    attempts: 0,
    messageIds: [],
    completedSteps: [],
    totalSteps: 0,
    receiptIds: [],
    firstOccurredAt: receipt.occurredAt ?? null,
    lastOccurredAt: receipt.occurredAt ?? null,
    lastError: null,
    updatedAt,
  };
}

function updateAggregate(previous, receipt, receiptId, now) {
  const id = `feedback-${digest(receipt.deliveryId).slice(0, 32)}`;
  const base = previous ? structuredClone(previous) : emptyAggregate(receipt, id, now);
  if (base.id !== id || base.deliveryId !== receipt.deliveryId) {
    throw new Error("feedback aggregate does not belong to this delivery");
  }
  if (base.contentProductId && receipt.contentProductId && base.contentProductId !== receipt.contentProductId) {
    throw new Error("feedback aggregate content product identity conflict");
  }
  if (base.contentHash && receipt.contentHash && base.contentHash !== receipt.contentHash) {
    throw new Error("feedback aggregate content hash conflict");
  }
  if (base.receiptIds.includes(receiptId)) {
    return { ...base, updatedAt: now };
  }
  const messageIds = [...new Set([...base.messageIds, ...receipt.messageIds])];
  const completedSteps = [...new Set([
    ...base.completedSteps,
    ...(receipt.steps?.completed ?? []),
  ])].sort();
  const totalSteps = Math.max(Number(base.totalSteps ?? 0), Number(receipt.steps?.total ?? 0));
  return {
    ...base,
    ...(base.contentProductId || receipt.contentProductId
      ? { contentProductId: base.contentProductId ?? receipt.contentProductId }
      : {}),
    ...(base.contentHash || receipt.contentHash
      ? { contentHash: base.contentHash ?? receipt.contentHash }
      : {}),
    platforms: [...new Set([...base.platforms, receipt.platform])].sort(),
    status: receipt.status,
    complete: receipt.status === "success" && (totalSteps === 0 || completedSteps.length >= totalSteps),
    receiptCount: Number(base.receiptCount ?? 0) + 1,
    successfulReceipts: Number(base.successfulReceipts ?? 0) + (receipt.status === "success" ? 1 : 0),
    failedReceipts: Number(base.failedReceipts ?? 0) + (receipt.status === "failed" ? 1 : 0),
    partialReceipts: Number(base.partialReceipts ?? 0) + (receipt.status === "partial" ? 1 : 0),
    attempts: Math.max(Number(base.attempts ?? 0), receipt.attempt),
    messageIds,
    completedSteps,
    totalSteps,
    receiptIds: [...base.receiptIds, receiptId],
    firstOccurredAt: base.firstOccurredAt ?? receipt.occurredAt ?? null,
    lastOccurredAt: receipt.occurredAt ?? base.lastOccurredAt ?? null,
    lastError: receipt.error ?? null,
    updatedAt: now,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createContentFeedbackLoop({ store, vaultPath, now = () => new Date() } = {}) {
  const contentStore = store ?? createObsidianContentStore({ vaultPath, now });
  if (typeof contentStore?.initialize !== "function"
    || typeof contentStore?.writeDistribution !== "function"
    || typeof contentStore?.writeFeedback !== "function") {
    throw new TypeError("content feedback store is invalid");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  let initialization;
  const initialize = () => {
    initialization ??= Promise.resolve()
      .then(() => contentStore.initialize())
      .catch((error) => {
        initialization = null;
        throw error;
      });
    return initialization;
  };

  async function recordReceipt(input, { aggregate: previousAggregate = null } = {}) {
    const receipt = normalizeReceipt(input);
    const receiptId = `receipt-${digest(receipt).slice(0, 40)}`;
    const snapshot = {
      id: `distribution-${digest({ receiptId, receipt }).slice(0, 40)}`,
      schema: RECEIPT_SCHEMA,
      receiptId,
      ...receipt,
    };
    const stampValue = now();
    const stamp = stampValue instanceof Date ? stampValue : new Date(stampValue);
    if (Number.isNaN(stamp.valueOf())) throw new TypeError("now returned an invalid date");
    const aggregate = updateAggregate(previousAggregate, receipt, receiptId, stamp.toISOString());
    let distribution;
    try {
      await initialize();
      distribution = await contentStore.writeDistribution(snapshot);
    } catch (error) {
      return {
        status: "pending",
        retryable: true,
        phase: "distribution",
        error: errorMessage(error),
        receipt,
        snapshot,
        aggregate,
        distribution: null,
        feedback: null,
      };
    }
    try {
      const feedback = await contentStore.writeFeedback(aggregate);
      return {
        status: "synced",
        retryable: false,
        phase: null,
        error: null,
        receipt,
        snapshot,
        aggregate,
        distribution,
        feedback,
      };
    } catch (error) {
      return {
        status: "pending",
        retryable: true,
        phase: "feedback",
        error: errorMessage(error),
        receipt,
        snapshot,
        aggregate,
        distribution,
        feedback: null,
      };
    }
  }

  return Object.freeze({ recordReceipt });
}
