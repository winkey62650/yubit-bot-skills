const SYMBOL_PATTERN = /^[A-Z0-9]{2,30}$/;
const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;
const HELP = [
  "Send a filled YUBIT order in this format:",
  "BTCUSDT 1234567890",
  "TP: 70100 (optional)",
  "SL: 66500 (optional)",
  "Rationale: Breakout retest confirmed (optional)",
].join("\n");

function help(reason = "invalid_format") {
  return { ok: false, type: "help", reason, help: HELP };
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

function cleanDecimal(value, precision = 12) {
  const number = Number(value);
  if (!Number.isFinite(number)) return number;
  return Number(number.toPrecision(Math.min(15, Math.max(1, precision))));
}

function getFirst(source, keys) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source[key] !== null && source[key] !== "") {
      return source[key];
    }
  }
  return null;
}

function normalizeCommand(value) {
  const command = String(value || "").toLowerCase();
  if (command === "/status") return "status";
  if (command === "/refresh") return "refresh";
  return "submit";
}

export function parseTraderMessage(text) {
  if (typeof text !== "string" || !text.trim()) return help("empty_message");

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstLine = lines.shift() || "";
  const parts = firstLine.split(/\s+/);
  const type = normalizeCommand(parts[0]);
  const offset = type === "submit" ? 0 : 1;

  if (parts.length !== offset + 2) return help("missing_order_reference");
  const symbol = String(parts[offset] || "").toUpperCase();
  const orderId = String(parts[offset + 1] || "");
  if (!SYMBOL_PATTERN.test(symbol) || !ORDER_ID_PATTERN.test(orderId)) {
    return help("invalid_order_reference");
  }

  const annotations = {};
  if (type === "submit") {
    for (const line of lines) {
      const match = line.match(/^(TP|SL|Rationale)\s*:\s*(.+)$/i);
      if (!match) continue;
      const key = match[1].toLowerCase();
      const value = match[2].trim().slice(0, key === "rationale" ? 1000 : 100);
      if (key === "tp") annotations.takeProfit = value;
      if (key === "sl") annotations.stopLoss = value;
      if (key === "rationale") annotations.rationale = value;
    }
  }

  return { ok: true, type, symbol, orderId, annotations };
}

export function deriveVerifiedOrder(order, executions) {
  if (!order || typeof order !== "object") throw new Error("ORDER_NOT_FOUND");
  const status = String(getFirst(order, ["orderStatus", "status"]) || "").toLowerCase();
  if (status !== "filled") throw new Error("ORDER_NOT_FILLED");

  const validExecutions = Array.isArray(executions)
    ? executions
        .map((execution) => ({
          raw: execution,
          quantity: positiveNumber(getFirst(execution, ["execQty", "qty", "quantity", "size"])),
          price: positiveNumber(getFirst(execution, ["execPrice", "price", "executionPrice"])),
          time: finiteNumber(getFirst(execution, ["execTime", "executionTime", "createdTime", "updatedTime"])),
          id: getFirst(execution, ["execId", "executionId", "id"]),
        }))
        .filter((execution) => execution.quantity !== null && execution.price !== null)
    : [];
  if (validExecutions.length === 0) throw new Error("EXECUTIONS_NOT_FOUND");

  const filledQty = validExecutions.reduce((sum, execution) => sum + execution.quantity, 0);
  const notional = validExecutions.reduce(
    (sum, execution) => sum + execution.quantity * execution.price,
    0,
  );
  const side = String(getFirst(order, ["side", "orderSide"]) || "").toLowerCase();
  if (side !== "buy" && side !== "sell") throw new Error("ORDER_SIDE_UNSUPPORTED");

  const executionTimes = validExecutions.map((execution) => execution.time).filter(Number.isFinite);
  const orderTime = finiteNumber(getFirst(order, ["createdTime", "createdAt", "orderTime"]));
  const leverage = positiveNumber(order.leverage);

  return {
    symbol: String(order.symbol || "").toUpperCase(),
    orderId: String(getFirst(order, ["orderId", "id"]) || ""),
    direction: side === "buy" ? "Long" : "Short",
    filledQty: cleanDecimal(filledQty),
    entryPrice: cleanDecimal(notional / filledQty),
    leverage,
    openedAt: executionTimes.length > 0 ? Math.min(...executionTimes) : orderTime,
    executionIds: validExecutions.map((execution) => String(execution.id)).filter((id) => id !== "null"),
  };
}

function recordOrderId(record) {
  return String(getFirst(record, ["orderId", "openOrderId", "entryOrderId"]) || "");
}

function recordQuantity(record) {
  return positiveNumber(getFirst(record, ["qty", "closedSize", "size", "cumExecQty", "quantity"]));
}

function recordTime(record) {
  return finiteNumber(getFirst(record, ["updatedTime", "closedAt", "createdTime", "execTime", "orderTime"]));
}

function directionMatches(signalDirection, record) {
  const direction = String(getFirst(record, ["direction", "positionSide"]) || "").toLowerCase();
  if (direction === "long" || direction === "short") {
    return direction === String(signalDirection || "").toLowerCase();
  }
  const side = String(getFirst(record, ["side", "orderSide"]) || "").toLowerCase();
  if (String(signalDirection).toLowerCase() === "long") return side === "sell";
  if (String(signalDirection).toLowerCase() === "short") return side === "buy";
  return false;
}

function quantitiesMatch(left, right) {
  const a = positiveNumber(left);
  const b = positiveNumber(right);
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= Math.max(1e-8, Math.max(a, b) * 1e-8);
}

export function matchClosedPnl(signal, records) {
  const candidates = Array.isArray(records) ? records.filter(Boolean) : [];
  const direct = candidates.filter(
    (record) => recordOrderId(record) && recordOrderId(record) === String(signal?.orderId || ""),
  );
  if (direct.length === 1) return { status: "matched", method: "order_id", record: direct[0] };
  if (direct.length > 1) return { status: "ambiguous", method: "order_id", candidates: direct };

  const openedAt = finiteNumber(signal?.openedAt);
  const matchUntil = finiteNumber(signal?.matchUntil) ?? Number.POSITIVE_INFINITY;
  const contextual = candidates.filter((record) => {
    const time = recordTime(record);
    return (
      quantitiesMatch(signal?.filledQty, recordQuantity(record)) &&
      directionMatches(signal?.direction, record) &&
      time !== null &&
      (openedAt === null || time >= openedAt) &&
      time <= matchUntil
    );
  });

  if (contextual.length === 1) {
    return { status: "matched", method: "size_direction_time", record: contextual[0] };
  }
  if (contextual.length > 1) {
    return { status: "ambiguous", method: "size_direction_time", candidates: contextual };
  }
  return { status: "pending", method: null, candidates: [] };
}

export function computeVerifiedRoi(signal, closedRecord) {
  const entryPrice = positiveNumber(signal?.entryPrice);
  const filledQty = positiveNumber(signal?.filledQty);
  const leverage = positiveNumber(signal?.leverage);
  const closedPnl = finiteNumber(getFirst(closedRecord, ["closedPnl", "realizedPnl", "pnl"]));
  if (entryPrice === null || filledQty === null || leverage === null || closedPnl === null) return null;
  const margin = (entryPrice * filledQty) / leverage;
  if (!Number.isFinite(margin) || margin <= 0) return null;
  return cleanDecimal((closedPnl / margin) * 100, 6);
}

function formatNumber(value, maximumFractionDigits = 8) {
  const number = finiteNumber(value);
  if (number === null) return "N/A";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(number);
}

function signedNumber(value, suffix = "") {
  const number = finiteNumber(value);
  if (number === null) return "N/A";
  const prefix = number > 0 ? "+" : "";
  return `${prefix}${formatNumber(number, 4)}${suffix}`;
}

export function maskOrderId(orderId) {
  const value = String(orderId || "");
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

export function formatVerifiedSignal(signal, trader) {
  const leverage = positiveNumber(signal?.leverage);
  const annotations = signal?.annotations || {};
  const noteLines = [
    annotations.takeProfit ? `TP: ${annotations.takeProfit}` : null,
    annotations.stopLoss ? `SL: ${annotations.stopLoss}` : null,
    annotations.rationale ? `Rationale: ${annotations.rationale}` : null,
  ].filter(Boolean);

  return [
    `\ud83d\udce1 ${signal?.symbol || "Unknown"} ${signal?.direction || ""}`.trim(),
    "Verified by YUBIT",
    "",
    `Trader: ${trader?.displayName || "Authorized Trader"}`,
    `Entry: ${formatNumber(signal?.entryPrice)}`,
    `Size: ${formatNumber(signal?.filledQty)}`,
    `Leverage: ${leverage === null ? "N/A" : `${formatNumber(leverage, 2)}x`}`,
    `Order ID: ${maskOrderId(signal?.orderId)}`,
    ...(noteLines.length > 0 ? ["", "Trader notes (not exchange-verified)", ...noteLines] : []),
    "",
    "Market information only. Not financial advice.",
  ].join("\n");
}

export function formatPnlCaption(signal, trader) {
  return [
    `\u2705 ${signal?.symbol || "Trade"} PROFIT CLOSED`,
    `Trader: ${trader?.displayName || "Authorized Trader"}`,
    `Direction: ${signal?.direction || "N/A"}`,
    `Realized PNL: ${signedNumber(signal?.realizedPnl, " USDT")}`,
    `ROI: ${signedNumber(signal?.roi, "%")}`,
    "Verified by YUBIT",
  ].join("\n");
}
