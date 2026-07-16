import { createHmac, timingSafeEqual } from "node:crypto";

const SYMBOL_PATTERN = /^[A-Z0-9]{2,30}$/;
const DIRECTIONS = new Set(["Long", "Short"]);
const MIN_SECRET_LENGTH = 32;

function validSecret(value) {
  const secret = String(value || "");
  if (secret.length < MIN_SECRET_LENGTH) throw new Error("PNL_CARD_SECRET_INVALID");
  return secret;
}

function nowSeconds(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error("PNL_CARD_TIME_INVALID");
  return Math.floor(date.getTime() / 1000);
}

function signature(body, secret) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function equalText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function cleanText(value, fallback, maxLength = 80) {
  const cleaned = String(value || "")
    .replace(/[<>]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  return cleaned || fallback;
}

function priceLabel(value) {
  const number = positiveNumber(value);
  if (number === null) return "N/A";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 8,
    minimumFractionDigits: 0,
  }).format(number);
}

function signedLabel(value, digits, suffix) {
  const number = finiteNumber(value);
  if (number === null) return null;
  const prefix = number > 0 ? "+" : "";
  return `${prefix}${number.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}${suffix}`;
}

export function signPnlCardPayload(payload, secretValue, { now = new Date(), ttlSeconds = 30 * 24 * 60 * 60 } = {}) {
  const secret = validSecret(secretValue);
  const issuedAt = nowSeconds(now);
  const ttl = Number(ttlSeconds);
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 365 * 24 * 60 * 60) {
    throw new Error("PNL_CARD_TTL_INVALID");
  }
  const body = Buffer.from(JSON.stringify({
    ...payload,
    v: 1,
    iat: issuedAt,
    exp: issuedAt + Math.floor(ttl),
  })).toString("base64url");
  return `${body}.${signature(body, secret)}`;
}

export function verifyPnlCardPayload(tokenValue, secretValue, { now = new Date() } = {}) {
  const secret = validSecret(secretValue);
  const token = String(tokenValue || "");
  const [body, suppliedSignature, extra] = token.split(".");
  if (!body || !suppliedSignature || extra !== undefined || !equalText(suppliedSignature, signature(body, secret))) {
    throw new Error("PNL_CARD_TOKEN_INVALID");
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("PNL_CARD_TOKEN_INVALID");
  }
  if (!decoded || decoded.v !== 1 || !Number.isFinite(Number(decoded.exp))) {
    throw new Error("PNL_CARD_TOKEN_INVALID");
  }
  if (nowSeconds(now) > Number(decoded.exp)) throw new Error("PNL_CARD_TOKEN_EXPIRED");
  const { v: _version, iat: _issuedAt, exp: _expiresAt, ...payload } = decoded;
  return payload;
}

export function buildPnlCardModel(payload) {
  const symbol = String(payload?.symbol || "").trim().toUpperCase();
  const direction = String(payload?.direction || "").trim();
  const realizedPnl = finiteNumber(payload?.realizedPnl);
  if (realizedPnl === null || realizedPnl <= 0) throw new Error("PNL_CARD_PROFIT_REQUIRED");
  if (!SYMBOL_PATTERN.test(symbol) || !DIRECTIONS.has(direction)) {
    throw new Error("PNL_CARD_PAYLOAD_INVALID");
  }

  const roi = payload?.roi === null || payload?.roi === undefined ? null : finiteNumber(payload.roi);
  if (payload?.roi !== null && payload?.roi !== undefined && roi === null) {
    throw new Error("PNL_CARD_PAYLOAD_INVALID");
  }
  const leverage = positiveNumber(payload?.leverage);
  const closedAt = new Date(payload?.closedAt || "");

  return {
    traderName: cleanText(payload?.traderName, "Authorized Trader"),
    symbol,
    direction,
    leverageLabel: leverage === null ? "N/A" : `${leverage.toLocaleString("en-US", { maximumFractionDigits: 2 })}x`,
    roi,
    roiLabel: roi === null ? null : signedLabel(roi, 2, "%"),
    pnlLabel: signedLabel(realizedPnl, 2, " USDT"),
    entryPriceLabel: priceLabel(payload?.entryPrice),
    exitPriceLabel: priceLabel(payload?.exitPrice),
    closedAtLabel: Number.isFinite(closedAt.getTime())
      ? closedAt.toISOString().replace("T", " ").slice(0, 16) + " UTC"
      : "Verified close",
  };
}
