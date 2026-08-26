export const ALERT_TYPES = Object.freeze({
  WHALE_FLOW: "WHALE_FLOW",
  LIQUIDITY_ALERT: "LIQUIDITY_ALERT",
  SMART_MONEY_POSITION: "SMART_MONEY_POSITION",
});

const SAFE_WALLET_LABELS = new Set(["Tracked Wallet", "Large Trader", "Whale"]);
const LIFECYCLES = new Set(["APPEARED", "INCREASED", "REDUCED", "MOVED", "FILLED", "CANCELLED", "EXPIRED", "REMOVED"]);
const DEMO_BATCH_PATTERN = /^[a-z0-9][a-z0-9-]{5,79}$/;

function decimal(value) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new TypeError(`Invalid decimal value: ${raw || "<empty>"}`);
  return {
    coefficient: BigInt(`${match[1] === "-" ? "-" : ""}${match[2]}${match[3] || ""}`),
    scale: (match[3] || "").length,
  };
}

function power10(value) {
  return 10n ** BigInt(value);
}

function roundToScale(coefficient, sourceScale, targetScale) {
  if (sourceScale <= targetScale) return coefficient * power10(targetScale - sourceScale);
  const divisor = power10(sourceScale - targetScale);
  const quotient = coefficient / divisor;
  const remainder = coefficient % divisor;
  const absoluteRemainder = remainder < 0n ? -remainder : remainder;
  if (absoluteRemainder * 2n < divisor) return quotient;
  return quotient + (coefficient < 0n ? -1n : 1n);
}

function formatFixed(coefficient, scale) {
  const negative = coefficient < 0n;
  const absolute = negative ? -coefficient : coefficient;
  const digits = absolute.toString().padStart(scale + 1, "0");
  const integer = scale ? digits.slice(0, -scale) : digits;
  const fraction = scale ? `.${digits.slice(-scale)}` : "";
  return `${negative ? "-" : ""}${integer}${fraction}`;
}

export function multiplyDecimal(left, right, outputScale = 2) {
  if (!Number.isSafeInteger(outputScale) || outputScale < 0) throw new TypeError("outputScale must be a non-negative integer");
  const a = decimal(left);
  const b = decimal(right);
  return formatFixed(roundToScale(a.coefficient * b.coefficient, a.scale + b.scale, outputScale), outputScale);
}

function decimalToScale(value, scale) {
  const parsed = decimal(value);
  return roundToScale(parsed.coefficient, parsed.scale, scale);
}

function alignedPair(left, right) {
  const a = decimal(left);
  const b = decimal(right);
  const scale = Math.max(a.scale, b.scale);
  return [a.coefficient * power10(scale - a.scale), b.coefficient * power10(scale - b.scale)];
}

function compareDecimal(left, right) {
  const [a, b] = alignedPair(left, right);
  return a === b ? 0 : a > b ? 1 : -1;
}

function ratioBps(numerator, denominator) {
  if (denominator <= 0n) return 0n;
  return (numerator * 10_000n + denominator / 2n) / denominator;
}

function distanceBps(price, markPrice) {
  const [priceValue, markValue] = alignedPair(price, markPrice);
  if (markValue <= 0n) throw new TypeError("markPrice must be positive");
  const delta = priceValue >= markValue ? priceValue - markValue : markValue - priceValue;
  return ratioBps(delta, markValue);
}

function formatBasisPoints(value, signed = false) {
  const amount = BigInt(value);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const prefix = negative ? "-" : signed && amount > 0n ? "+" : "";
  return `${prefix}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}%`;
}

function formatMoney(cents) {
  const amount = BigInt(cents);
  const dollars = amount / 100n;
  if (dollars >= 1_000_000_000n) return `${formatCompactRatio(dollars, 1_000_000_000n)}B`;
  if (dollars >= 1_000_000n) return `${formatCompactRatio(dollars, 1_000_000n)}M`;
  if (dollars >= 1_000n) return `${formatCompactRatio(dollars, 1_000n)}K`;
  return `${dollars.toString()}.${(amount % 100n).toString().padStart(2, "0")}`;
}

function formatCompactRatio(value, unit) {
  const tenths = (value * 10n + unit / 2n) / unit;
  return tenths % 10n === 0n ? (tenths / 10n).toString() : `${tenths / 10n}.${tenths % 10n}`;
}

function formatPrice(value) {
  const cents = decimalToScale(value, 2);
  const integer = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = cents % 100n;
  return fraction === 0n ? integer : `${integer}.${fraction.toString().padStart(2, "0")}`;
}

function scoreSize(cents) {
  if (cents >= 1_000_000_000n) return 25;
  if (cents >= 500_000_000n) return 20;
  if (cents >= 200_000_000n) return 15;
  if (cents >= 100_000_000n) return 10;
  if (cents >= 50_000_000n) return 5;
  return 0;
}

function scoreRelative(shareBps) {
  if (shareBps >= 2_500n) return 20;
  if (shareBps >= 1_500n) return 15;
  if (shareBps >= 800n) return 10;
  return 0;
}

function scoreDistance(value) {
  if (value <= 25n) return 20;
  if (value <= 50n) return 16;
  if (value <= 100n) return 12;
  if (value <= 200n) return 8;
  return 0;
}

function scorePersistence(seconds) {
  if (seconds >= 60) return 15;
  if (seconds >= 30) return 12;
  if (seconds >= 20) return 10;
  if (seconds >= 10) return 5;
  return 0;
}

function scoreImbalance(value) {
  const absolute = value < 0n ? -value : value;
  if (absolute >= 3_000n) return 10;
  if (absolute >= 2_000n) return 8;
  if (absolute >= 1_000n) return 5;
  return 0;
}

function sourceIsComplete(source) {
  return Boolean(source?.provider && source?.endpoint && source?.sourceTimestamp && source?.receivedAt);
}

function scorePriority(score) {
  if (score >= 80) return "P1";
  if (score >= 65) return "P2";
  if (score >= 50) return "P3";
  return null;
}

function normalizeBook(rows, side) {
  if (!Array.isArray(rows) || rows.length === 0) throw new TypeError(`${side.toLowerCase()} order book is empty`);
  return rows.map(([price, quantity]) => {
    const cents = decimalToScale(multiplyDecimal(price, quantity, 2), 2);
    return { side, price: String(price), quantity: String(quantity), cents };
  });
}

export function normalizeWalletClassification({ requestedLabel, verified = false, evidence } = {}) {
  const label = String(requestedLabel || "").trim();
  if (verified === true && label === "Smart Money" && String(evidence || "").trim()) {
    return { label, verified: true, evidence: String(evidence).trim() };
  }
  return { label: SAFE_WALLET_LABELS.has(label) ? label : "Tracked Wallet", verified: false };
}

export function classifyLiquidityLifecycle(previous, current) {
  if (!previous || !current) return "APPEARED";
  if (previous.eventGroupKey !== current.eventGroupKey) return "MOVED";
  const comparison = compareDecimal(current.visibleNotional, previous.visibleNotional);
  if (comparison > 0) return "INCREASED";
  if (comparison < 0) return "REDUCED";
  return "APPEARED";
}

export function shouldPublishLiquidityUpdate(previous, current, now = new Date()) {
  if (!previous || !current) return true;
  if (previous.eventGroupKey !== current.eventGroupKey) return true;
  const previousAt = Date.parse(previous.publishedAt || "");
  const currentAt = new Date(now).getTime();
  if (!Number.isFinite(previousAt) || !Number.isFinite(currentAt)) return true;
  if (currentAt - previousAt >= 60 * 60 * 1000) return true;

  const [currentNotional, previousNotional] = alignedPair(current.visibleNotional, previous.visibleNotional);
  if (currentNotional * 2n >= previousNotional * 3n) return true;

  const priorityRank = { P1: 3, P2: 2, P3: 1 };
  if ((priorityRank[current.priority] || 0) > (priorityRank[previous.priority] || 0)) return true;

  const terminalLifecycle = new Set(["FILLED", "CANCELLED", "EXPIRED", "REMOVED"]);
  if (current.lifecycle !== previous.lifecycle && terminalLifecycle.has(current.lifecycle)) return true;
  return false;
}

export function buildLiquidityAlert({
  asset,
  pair,
  observedAt,
  source,
  markPrice,
  bids,
  asks,
  persistenceSeconds = 0,
  lifecycle = "APPEARED",
  priceReactionConfirmed = false,
} = {}) {
  const normalizedAsset = String(asset || "").trim().toUpperCase();
  const normalizedPair = String(pair || "").trim().toUpperCase();
  if (!normalizedAsset || !normalizedPair) throw new TypeError("asset and pair are required");
  if (!LIFECYCLES.has(lifecycle)) throw new TypeError(`Unsupported liquidity lifecycle: ${lifecycle}`);
  const normalizedBids = normalizeBook(bids, "BID");
  const normalizedAsks = normalizeBook(asks, "ASK");
  const bidTotal = normalizedBids.reduce((total, row) => total + row.cents, 0n);
  const askTotal = normalizedAsks.reduce((total, row) => total + row.cents, 0n);
  const largestBid = normalizedBids.reduce((largest, row) => row.cents > largest.cents ? row : largest);
  const largestAsk = normalizedAsks.reduce((largest, row) => row.cents > largest.cents ? row : largest);
  const focus = largestBid.cents >= largestAsk.cents ? largestBid : largestAsk;
  const sideTotal = focus.side === "BID" ? bidTotal : askTotal;
  const shareBps = ratioBps(focus.cents, sideTotal);
  const levelDistanceBps = distanceBps(focus.price, markPrice);
  const totalDepth = bidTotal + askTotal;
  const imbalanceBps = totalDepth > 0n ? ((bidTotal - askTotal) * 10_000n) / totalDepth : 0n;
  const persistence = Number.isSafeInteger(persistenceSeconds) && persistenceSeconds > 0 ? persistenceSeconds : 0;
  const scoreComponents = {
    absoluteSize: scoreSize(focus.cents),
    relativeSize: scoreRelative(shareBps),
    distance: scoreDistance(levelDistanceBps),
    persistence: scorePersistence(persistence),
    imbalance: scoreImbalance(imbalanceBps),
    priceConfirmation: priceReactionConfirmed === true ? 10 : 0,
  };
  const score = Object.values(scoreComponents).reduce((total, value) => total + value, 0);
  const requiredPersistence = ["BTC", "ETH"].includes(normalizedAsset) ? 20 : 30;
  let gateReason = null;
  if (!sourceIsComplete(source)) gateReason = "source-provenance-incomplete";
  else if (persistence < requiredPersistence) gateReason = "persistence-unverified";
  else if (scoreComponents.absoluteSize === 0) gateReason = "absolute-size-below-threshold";
  else if (shareBps < 800n) gateReason = "relative-size-below-threshold";
  else if (levelDistanceBps > 200n) gateReason = "level-too-far-from-mark";
  else if (score < 50) gateReason = "score-below-publication-threshold";
  const publishable = gateReason === null;
  const sideDescription = focus.side === "BID" ? "below" : "above";
  const directionalRead = focus.side === "BID" ? "nearby support" : "nearby resistance";

  return {
    eventType: ALERT_TYPES.LIQUIDITY_ALERT,
    eventGroupKey: `${ALERT_TYPES.LIQUIDITY_ALERT}|${normalizedPair}|${focus.side}|${focus.price}`,
    asset: normalizedAsset,
    pair: normalizedPair,
    wallet: null,
    observedAt: new Date(observedAt).toISOString(),
    source: { ...source },
    lifecycle,
    side: focus.side,
    price: focus.price,
    quantity: focus.quantity,
    visibleNotional: formatFixed(focus.cents, 2),
    visibleNotionalLabel: `$${formatMoney(focus.cents)}`,
    markPrice: String(markPrice),
    relativeSize: formatBasisPoints(shareBps),
    distanceFromMark: formatBasisPoints(levelDistanceBps),
    depthImbalance: formatBasisPoints(imbalanceBps, true),
    persistenceSeconds: persistence,
    scoreComponents,
    score,
    priority: scorePriority(score),
    strength: score >= 80 ? "HIGH" : score >= 65 ? "MEDIUM" : "LOW",
    bias: focus.side === "BID" ? "POSITIVE" : "NEGATIVE",
    fact: `${focus.quantity} ${normalizedAsset} (${`$${formatMoney(focus.cents)}`}) visible on the ${focus.side.toLowerCase()} at $${formatPrice(focus.price)}.`,
    interpretation: `A persistent concentration of visible liquidity sits ${sideDescription} mark price and may reinforce ${directionalRead} while it remains.`,
    watchNext: `Track whether the level at $${formatPrice(focus.price)} increases, moves, is absorbed or is removed.`,
    publicationGate: { passed: publishable, reason: gateReason },
    publishable,
  };
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function bold(value, html) {
  return html ? `<b>${escapeHtml(value)}</b>` : value;
}

function value(text, html) {
  return html ? escapeHtml(text) : String(text ?? "");
}

function sourceTimestamp(source) {
  const parsed = new Date(source?.sourceTimestamp);
  return Number.isNaN(parsed.getTime()) ? "timestamp unavailable" : `${parsed.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

export function renderMarketIntelligenceAlertText(alert, { html = false } = {}) {
  const title = `🚨 ${String(alert?.eventType || ALERT_TYPES.LIQUIDITY_ALERT).replaceAll("_", " ")}`;
  const lifecycle = `${alert?.pair || "—"} · ${alert?.lifecycle || "MONITOR"} · ${alert?.priority || "BELOW THRESHOLD"}`;
  return [
    bold(title, html),
    bold(lifecycle, html),
    `${bold("FACT", html)}\n${value(alert?.fact, html)}\nDepth share ${value(alert?.relativeSize, html)} · ${value(alert?.distanceFromMark, html)} from mark · ${value(alert?.depthImbalance, html)} depth imbalance.`,
    `${bold("INTERPRETATION", html)}\n${value(alert?.interpretation, html)}`,
    `${bold("WATCH NEXT", html)}\n${value(alert?.watchNext, html)}`,
    `${bold("SOURCE", html)}\n${value(alert?.source?.provider || "Unverified source", html)} · ${value(sourceTimestamp(alert?.source), html)}`,
    value("Visible orders can be changed, moved or cancelled. This is not evidence of an executed trade and is not investment advice.", html),
  ].join("\n\n");
}

export function buildMarketIntelligenceDemoPreview(preview, { acceptanceBatchId } = {}) {
  if (!preview || typeof preview !== "object") throw new TypeError("Market intelligence preview is required");
  const batchId = String(acceptanceBatchId || "").trim().toLowerCase();
  if (!DEMO_BATCH_PATTERN.test(batchId)) throw new TypeError("A valid Demo acceptance batch id is required");

  const imageUrl = new URL(String(preview.imageUrl || ""));
  if (imageUrl.protocol !== "https:") throw new TypeError("Demo poster must use HTTPS");
  imageUrl.searchParams.set("demo", "1");
  imageUrl.searchParams.set("batch", batchId);

  const gate = preview.alert?.publicationGate || preview.publicationGate || {};
  const gateReason = String(gate.reason || "publication threshold reached")
    .replaceAll("-", " ")
    .toUpperCase();
  const liveGate = gate.passed === true ? "PASSED" : `NOT TRIGGERED · ${gateReason}`;
  const caption = [
    "<b>DEMO PREVIEW · FORMAT VALIDATION</b>",
    `<i>Current live order-book snapshot · LIVE GATE: ${escapeHtml(liveGate)}</i>`,
    String(preview.caption || "").trim(),
  ].filter(Boolean).join("\n\n");
  if (caption.length > 1024) throw new RangeError("Demo alert caption exceeds Telegram's photo caption limit");

  return {
    ...preview,
    demoAcceptance: true,
    acceptanceBatchId: batchId,
    currentData: true,
    historicalReplay: false,
    caption,
    imageUrl: imageUrl.toString(),
    mediaDelivery: {
      ...(preview.mediaDelivery || {}),
      defaultUrl: imageUrl.toString(),
    },
  };
}
