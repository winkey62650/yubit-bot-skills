import { createHmac } from "node:crypto";

const DEFAULT_BASE_URL = "https://openapi.yubit.com";
const DEFAULT_RECV_WINDOW = 5000;
const DEFAULT_TIMEOUT_MS = 15_000;
const SYMBOL_PATTERN = /^[A-Z0-9]{2,30}$/;
const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

const PATHS = Object.freeze({
  orders: "/oapi/contract/trade/private/v1/orders",
  executions: "/oapi/contract/trade/private/v1/executions",
  closedPnl: "/oapi/contract/trade/private/v1/closed-pnl",
});

function encodeQuery(params) {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== "")
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
    .join("&");
}

export function createYubitSignature({ apiKey, apiSecret, timestamp, recvWindow, params }) {
  const payload = encodeQuery(params || {});
  const signature = createHmac("sha256", String(apiSecret || ""))
    .update(`${timestamp}${apiKey}${recvWindow}${payload}`)
    .digest("hex");
  return { payload, signature };
}

function validateSymbol(value) {
  const symbol = String(value || "").toUpperCase();
  if (!SYMBOL_PATTERN.test(symbol)) throw new Error("YUBIT_INVALID_SYMBOL");
  return symbol;
}

function validateOrderId(value) {
  if (value === undefined || value === null || value === "") return null;
  const orderId = String(value);
  if (!ORDER_ID_PATTERN.test(orderId)) throw new Error("YUBIT_INVALID_ORDER_ID");
  return orderId;
}

function validateLimit(value) {
  const number = Number(value ?? 20);
  if (!Number.isInteger(number) || number < 1 || number > 100) throw new Error("YUBIT_INVALID_LIMIT");
  return String(number);
}

function validateTime(value, name) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`YUBIT_INVALID_${name}`);
  return String(Math.trunc(number));
}

export class YubitReadonlyClient {
  #apiKey;
  #apiSecret;
  #baseUrl;
  #fetch;
  #now;
  #recvWindow;
  #timeoutMs;

  constructor({
    apiKey,
    apiSecret,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    recvWindow = DEFAULT_RECV_WINDOW,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("YUBIT_API_KEY_REQUIRED");
    if (typeof apiSecret !== "string" || !apiSecret) throw new Error("YUBIT_API_SECRET_REQUIRED");
    if (typeof fetchImpl !== "function") throw new Error("YUBIT_FETCH_REQUIRED");
    const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
    if (!normalizedBaseUrl.startsWith("https://")) throw new Error("YUBIT_HTTPS_REQUIRED");

    this.#apiKey = apiKey.trim();
    this.#apiSecret = apiSecret;
    this.#baseUrl = normalizedBaseUrl;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#recvWindow = String(recvWindow);
    this.#timeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  }

  async getOrderHistory({ symbol, orderId, limit = 20 } = {}) {
    return this.#request(PATHS.orders, {
      symbol: validateSymbol(symbol),
      limit: validateLimit(limit),
      orderId: validateOrderId(orderId),
    });
  }

  async getExecutions({ symbol, orderId, limit = 20 } = {}) {
    return this.#request(PATHS.executions, {
      symbol: validateSymbol(symbol),
      limit: validateLimit(limit),
      orderId: validateOrderId(orderId),
    });
  }

  async getClosedPnl({ symbol, startTime, endTime, limit = 20 } = {}) {
    const start = validateTime(startTime, "START_TIME");
    const end = validateTime(endTime, "END_TIME");
    if (start !== null && end !== null && Number(start) > Number(end)) throw new Error("YUBIT_INVALID_TIME_RANGE");
    return this.#request(PATHS.closedPnl, {
      symbol: validateSymbol(symbol),
      limit: validateLimit(limit),
      startTime: start,
      endTime: end,
    });
  }

  async #request(path, params) {
    const timestamp = String(this.#now());
    const { payload, signature } = createYubitSignature({
      apiKey: this.#apiKey,
      apiSecret: this.#apiSecret,
      timestamp,
      recvWindow: this.#recvWindow,
      params,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}${payload ? `?${payload}` : ""}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "MF-ACCESS-API-KEY": this.#apiKey,
          "MF-ACCESS-TIMESTAMP": timestamp,
          "MF-ACCESS-RECV-WINDOW": this.#recvWindow,
          "MF-ACCESS-SIGN": signature,
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError" || controller.signal.aborted) throw new Error("YUBIT_TIMEOUT");
      throw new Error("YUBIT_NETWORK_ERROR");
    } finally {
      clearTimeout(timeout);
    }

    if (!response?.ok) throw new Error(`YUBIT_HTTP_ERROR:${Number(response?.status) || 0}`);
    let raw;
    try {
      raw = JSON.parse(await response.text());
    } catch {
      throw new Error("YUBIT_INVALID_RESPONSE");
    }
    if (!raw || typeof raw !== "object" || !("code" in raw)) throw new Error("YUBIT_INVALID_RESPONSE");
    if (Number(raw.code) !== 0) throw new Error(`YUBIT_API_ERROR:${String(raw.code).slice(0, 24)}`);
    return raw.data;
  }
}
