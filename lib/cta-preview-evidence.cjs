const { createHash, createHmac, timingSafeEqual } = require("node:crypto");

const EVIDENCE_VERSION = "cta-preview-v1";

function requireSecret(secret) {
  const value = String(secret || "");
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error("CTA_PREVIEW_EVIDENCE_SECRET must contain at least 32 bytes");
  }
  return value;
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

function resolvePlatform(target) {
  return target?.platform === "discord" || target?.guildId ? "discord" : "telegram";
}

function resolveField(platform, method) {
  if (platform === "telegram" && method === "sendMessage") return "text";
  if (platform === "telegram" && method === "sendPhoto") return "caption";
  if (platform === "discord" && method === "sendMessage") return "content";
  return null;
}

function targetIdentity(target, platform) {
  if (platform === "discord") {
    return JSON.stringify(["discord", String(target?.guildId || ""), String(target?.channelId || "")]);
  }
  return JSON.stringify(["telegram", String(target?.chatId || ""), String(target?.threadId ?? "")]);
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
  const payload = String(step?.payload?.[field] ?? "");
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
    payloadDigest: digest(payload),
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
  return createHmac("sha256", requireSecret(secret))
    .update(serializeClaims(claims), "utf8")
    .digest("base64url");
}

function signCtaPreviewPlans(plans, { secret, challenge } = {}) {
  requireSecret(secret);
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
    const actual = Buffer.from(String(evidence?.signature || ""), "utf8");
    const expected = Buffer.from(signClaims(secret, claims), "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

module.exports = {
  EVIDENCE_VERSION,
  signCtaPreviewPlans,
  verifyCtaPreviewBoundary,
};
