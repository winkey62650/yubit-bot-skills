import ctaPreviewEvidence from "./cta-preview-evidence.cjs";

const { verifyCtaPreviewBoundary } = ctaPreviewEvidence;

export const MARKET_INTELLIGENCE_DEMO_TARGET = Object.freeze({
  platform: "telegram",
  chatId: "-1003710405969",
  threadId: 16,
  groupName: "DEMO Academy",
  topicName: "6. Smart Money Tracker",
});
export const MARKET_INTELLIGENCE_DEMO_TEMPLATE = "market-intelligence-alert-v1";
const INTERNAL_URL_PATTERN = /152-32-161-174|sslip\.io|\/(?:admin|api)(?:\/|$)/i;

function enabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function approvedTargets(value) {
  return new Set(String(value || "").split(/[\s,]+/).map((item) => item.trim()).filter(Boolean));
}

function assertAcceptanceBatchId(value) {
  const batchId = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{5,79}$/.test(batchId)) {
    throw new Error("Market Intelligence Demo acceptance batch is invalid");
  }
  return batchId;
}

export function marketIntelligenceDemoClaimKey(acceptanceBatchId) {
  return `market-intelligence-demo-acceptance-v1:${assertAcceptanceBatchId(acceptanceBatchId)}`;
}

export function assertMarketIntelligenceDemoDelivery({
  plan,
  previewChallenge,
  acceptanceBatchId,
  env = process.env,
} = {}) {
  const batchId = assertAcceptanceBatchId(acceptanceBatchId);
  const challenge = String(previewChallenge || "").trim();
  if (!enabled(env.TELEGRAM_DEMO_ONLY) || !enabled(env.TRADING_DEMO_ONLY)) {
    throw new Error("Production Demo-only safety policy is not enabled");
  }
  if (String(env.ALLOW_LIVE_TELEGRAM || "").trim().toLowerCase() !== "false") {
    throw new Error("Persistent live Telegram sending must remain disabled");
  }
  const exactTarget = `${MARKET_INTELLIGENCE_DEMO_TARGET.chatId}:${MARKET_INTELLIGENCE_DEMO_TARGET.threadId}`;
  if (!approvedTargets(env.TELEGRAM_DISTRIBUTION_APPROVED_TARGETS).has(exactTarget)) {
    throw new Error("The Market Intelligence Demo topic is not approved");
  }
  if (!plan || plan.templateVersion !== MARKET_INTELLIGENCE_DEMO_TEMPLATE
    || plan.target?.platform !== MARKET_INTELLIGENCE_DEMO_TARGET.platform
    || String(plan.target?.chatId || "") !== MARKET_INTELLIGENCE_DEMO_TARGET.chatId
    || Number(plan.target?.threadId || 0) !== MARKET_INTELLIGENCE_DEMO_TARGET.threadId
    || plan.target?.ctaSource !== "destination-registry"
    || plan.target?.ctaEnabled !== true) {
    throw new Error("The signed Market Intelligence Demo plan escaped its target or template contract");
  }
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (steps.length !== 1 || steps[0]?.method !== "sendPhoto") {
    throw new Error("Market Intelligence Demo requires exactly one sendPhoto operation");
  }
  const step = steps[0];
  if (!verifyCtaPreviewBoundary({
    plan,
    step,
    stepIndex: 0,
    stepCount: 1,
    secret: env.CTA_PREVIEW_EVIDENCE_SECRET,
    challenge,
  })) {
    throw new Error("Market Intelligence Demo preview evidence is invalid");
  }
  const payload = step.payload || {};
  const photo = String(payload.photo || "");
  const caption = String(payload.caption || "");
  const posterUrl = new URL(photo);
  if (posterUrl.protocol !== "https:"
    || posterUrl.searchParams.get("demo") !== "1"
    || posterUrl.searchParams.get("batch") !== batchId
    || String(payload.chat_id || "") !== MARKET_INTELLIGENCE_DEMO_TARGET.chatId
    || Number(payload.message_thread_id || 0) !== MARKET_INTELLIGENCE_DEMO_TARGET.threadId
    || payload.parse_mode !== "HTML") {
    throw new Error("The signed Market Intelligence Demo payload is not pinned to its exact media and topic");
  }
  for (const marker of [
    "DEMO PREVIEW · FORMAT VALIDATION",
    "Current live order-book snapshot",
    "LIQUIDITY ALERT",
    "FACT",
    "INTERPRETATION",
    "WATCH NEXT",
    "SOURCE",
  ]) {
    if (!caption.includes(marker)) throw new Error(`Market Intelligence Demo caption is missing ${marker}`);
  }
  if (caption.length > 1024) throw new Error("Market Intelligence Demo caption exceeds Telegram's photo caption limit");
  if (INTERNAL_URL_PATTERN.test(caption)) throw new Error("Market Intelligence Demo caption exposes an internal backend URL");
  return { batchId, payload, plan, step };
}
