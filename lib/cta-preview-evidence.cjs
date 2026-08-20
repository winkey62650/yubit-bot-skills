const { createHash, createHmac, timingSafeEqual } = require("node:crypto");

const EVIDENCE_VERSION = "cta-preview-v1";
const SECRET_ERROR = "CTA_PREVIEW_EVIDENCE_SECRET must be exactly 64 lowercase hexadecimal characters (32 random bytes) and must not be periodic";

function hasObviousShortPeriod(secret) {
  // Reject deterministic filler and repeated demo tokens while leaving the
  // full 256-bit output space from `openssl rand -hex 32` practically intact.
  for (let period = 1; period <= 16; period += 1) {
    if (secret.length % period === 0
      && secret === secret.slice(0, period).repeat(secret.length / period)) {
      return true;
    }
  }
  return false;
}

function assertStrongCtaPreviewEvidenceSecret(secret) {
  if (typeof secret !== "string"
    || !/^[0-9a-f]{64}$/.test(secret)
    || hasObviousShortPeriod(secret)) {
    throw new Error(SECRET_ERROR);
  }
  return secret;
}

function requireChallenge(challenge) {
  const value = String(challenge || "").trim();
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) {
    throw new Error("preview challenge must be an unpredictable base64url value");
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("base64url");
}

function canonicalJson(value, ancestors = new Set()) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("CTA preview requires a canonical JSON payload");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new Error("CTA preview requires a canonical JSON payload");
  }
  if (ancestors.has(value)) throw new Error("CTA preview requires a canonical JSON payload");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownNames = Object.getOwnPropertyNames(value);
      const expectedNames = new Set(["length"]);
      for (let index = 0; index < value.length; index += 1) expectedNames.add(String(index));
      if (ownNames.length !== expectedNames.size
        || ownNames.some((name) => !expectedNames.has(name))
        || Object.getOwnPropertySymbols(value).length > 0) {
        throw new Error("CTA preview requires a canonical JSON payload");
      }
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error("CTA preview requires a canonical JSON payload");
        }
        items.push(canonicalJson(descriptor.value, ancestors));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("CTA preview requires a canonical JSON payload");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error("CTA preview requires a canonical JSON payload");
    }
    const names = Object.getOwnPropertyNames(value);
    const keys = Object.keys(value);
    if (names.length !== keys.length) throw new Error("CTA preview requires a canonical JSON payload");
    return `{${keys.sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new Error("CTA preview requires a canonical JSON payload");
      }
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function resolvePlatform(target) {
  const platform = target?.platform;
  const hasDiscordIdentity = String(target?.guildId ?? "").trim()
    && String(target?.channelId ?? "").trim();
  const hasTelegramIdentity = String(target?.chatId ?? "").trim();
  const hasAnyDiscordIdentity = String(target?.guildId ?? "").trim()
    || String(target?.channelId ?? "").trim();
  const hasAnyTelegramIdentity = String(target?.chatId ?? "").trim()
    || String(target?.threadId ?? "").trim()
    || String(target?.topicId ?? "").trim();
  if (platform === "discord" && hasDiscordIdentity && !hasAnyTelegramIdentity) return platform;
  if (platform === "telegram" && hasTelegramIdentity && !hasAnyDiscordIdentity) return platform;
  throw new Error("CTA preview target platform conflicts with its destination identity");
}

function resolveField(platform, method) {
  if (platform === "telegram" && method === "sendMessage") return "text";
  if (platform === "telegram" && method === "sendPhoto") return "caption";
  if (platform === "discord" && method === "sendMessage") return "content";
  return null;
}

function normalizeTelegramChat(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeTelegramThread(value) {
  if (value === undefined || value === null || value === "" || value === 0 || value === "0") return "";
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) return null;
  const threadId = Number(normalized);
  return Number.isSafeInteger(threadId) && threadId > 0 ? String(threadId) : null;
}

function normalizeTelegramTargetThread(target) {
  const threadId = normalizeTelegramThread(target?.threadId);
  const topicId = normalizeTelegramThread(target?.topicId);
  if (threadId === null || topicId === null) return null;
  if (threadId && topicId && threadId !== topicId) return null;
  return threadId || topicId;
}

function assertTelegramPayloadDestination(target, payload) {
  const targetChat = normalizeTelegramChat(target?.chatId);
  const payloadChat = normalizeTelegramChat(payload?.chat_id);
  const targetThread = normalizeTelegramTargetThread(target);
  const payloadThread = normalizeTelegramThread(payload?.message_thread_id);
  if (!targetChat || payloadChat !== targetChat || targetThread === null || payloadThread !== targetThread) {
    throw new Error("Telegram payload destination does not match its target");
  }
}

function targetIdentity(target, platform) {
  if (platform === "discord") {
    return JSON.stringify(["discord", String(target?.guildId || ""), String(target?.channelId || "")]);
  }
  return JSON.stringify([
    "telegram",
    normalizeTelegramChat(target?.chatId) || "",
    normalizeTelegramTargetThread(target) || "",
  ]);
}

function buildClaims({ plan, step, stepIndex, stepCount, challenge }) {
  const boundary = step?.ctaBoundary;
  const platform = resolvePlatform(plan?.target);
  const method = String(step?.method || "");
  const field = resolveField(platform, method);
  if (boundary?.kind !== "destination-cta"
    || boundary?.placement !== "suffix"
    || boundary?.platform !== platform
    || boundary?.method !== method
    || boundary?.field !== field
    || boundary?.stepIndex !== stepIndex
    || boundary?.stepCount !== stepCount
    || stepIndex !== stepCount - 1) {
    throw new Error("CTA preview boundary does not identify the final platform send step");
  }
  const payloadObject = step?.payload;
  if (platform === "telegram") assertTelegramPayloadDestination(plan?.target, payloadObject);
  const payload = String(payloadObject?.[field] ?? "");
  if (!Number.isSafeInteger(boundary.start)
    || !Number.isSafeInteger(boundary.end)
    || boundary.start < 0
    || boundary.start >= boundary.end
    || boundary.end !== payload.length) {
    throw new Error("CTA preview boundary range is invalid");
  }
  const cta = payload.slice(boundary.start, boundary.end);
  return {
    version: EVIDENCE_VERSION,
    challenge: requireChallenge(challenge),
    platform,
    method,
    field,
    start: boundary.start,
    end: boundary.end,
    stepIndex,
    stepCount,
    payloadDigest: digest(canonicalJson(payloadObject)),
    ctaDigest: digest(cta),
    targetDigest: digest(targetIdentity(plan?.target, platform)),
  };
}

function serializeClaims(claims) {
  return JSON.stringify([
    claims.version,
    claims.challenge,
    claims.platform,
    claims.method,
    claims.field,
    claims.start,
    claims.end,
    claims.stepIndex,
    claims.stepCount,
    claims.payloadDigest,
    claims.ctaDigest,
    claims.targetDigest,
  ]);
}

function signClaims(secret, claims) {
  return createHmac("sha256", Buffer.from(assertStrongCtaPreviewEvidenceSecret(secret), "hex"))
    .update(serializeClaims(claims), "utf8")
    .digest("base64url");
}

function signCtaPreviewPlans(plans, { secret, challenge } = {}) {
  assertStrongCtaPreviewEvidenceSecret(secret);
  requireChallenge(challenge);
  return (Array.isArray(plans) ? plans : []).map((plan) => {
    const steps = Array.isArray(plan?.steps) ? plan.steps : [];
    return {
      ...plan,
      steps: steps.map((step, stepIndex) => {
        if (!step?.ctaBoundary) return step;
        const claims = buildClaims({ plan, step, stepIndex, stepCount: steps.length, challenge });
        return {
          ...step,
          ctaBoundary: {
            ...step.ctaBoundary,
            evidence: {
              version: EVIDENCE_VERSION,
              payloadDigest: claims.payloadDigest,
              ctaDigest: claims.ctaDigest,
              targetDigest: claims.targetDigest,
              signature: signClaims(secret, claims),
            },
          },
        };
      }),
    };
  });
}

function verifyCtaPreviewBoundary({ plan, step, stepIndex, stepCount, secret, challenge } = {}) {
  try {
    const claims = buildClaims({ plan, step, stepIndex, stepCount, challenge });
    const evidence = step?.ctaBoundary?.evidence;
    if (evidence?.version !== EVIDENCE_VERSION
      || evidence?.payloadDigest !== claims.payloadDigest
      || evidence?.ctaDigest !== claims.ctaDigest
      || evidence?.targetDigest !== claims.targetDigest) return false;
    const signature = String(evidence?.signature || "");
    if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
    const actual = Buffer.from(signature, "base64url");
    const expected = Buffer.from(signClaims(secret, claims), "base64url");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

module.exports = {
  EVIDENCE_VERSION,
  assertStrongCtaPreviewEvidenceSecret,
  signCtaPreviewPlans,
  verifyCtaPreviewBoundary,
};
