export const DEFAULT_SOURCE_TIMEOUT_MS = 8_000;

const MAX_GET_ATTEMPTS = 3;
const TRADINGVIEW_CALENDAR_URL = "https://economic-calendar.tradingview.com/events";
const BINANCE_API_URL = "https://api.binance.com";
const OKX_API_URL = "https://www.okx.com";
const DXY_API_URL = "https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB";

const DEFAULT_DAILY_FEEDS = Object.freeze([
  { id: "sec", label: "SEC", kind: "official", url: "https://www.sec.gov/news/pressreleases.rss" },
  { id: "cointelegraph", label: "Cointelegraph", kind: "industry", url: "https://cointelegraph.com/rss" },
]);

class SourceTimeoutError extends Error {
  constructor(url, timeoutMs) {
    super(`GET timeout after ${timeoutMs}ms: ${url}`);
    this.name = "SourceTimeoutError";
    this.code = "SOURCE_TIMEOUT";
  }
}

function validTimeout(timeoutMs) {
  const value = Number(timeoutMs);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SOURCE_TIMEOUT_MS;
}

function isoNow(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function sourceHealth({ id, url, status, checkedAt, lastSuccessAt = null, freshnessSeconds = null, fallbackFrom }) {
  return {
    id,
    url,
    status,
    checkedAt,
    lastSuccessAt,
    freshnessSeconds,
    ...(fallbackFrom ? { fallbackFrom } : {}),
  };
}

async function fetchOnce(url, { fetchImpl, timeoutMs, accept, type }) {
  const controller = new AbortController();
  const timeout = validTimeout(timeoutMs);
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SourceTimeoutError(url, timeout));
    }, timeout);
  });

  try {
    const requestAndBody = Promise.resolve().then(async () => {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { accept },
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response?.ok) {
        const error = new Error(`GET ${url} returned HTTP ${response?.status ?? "unknown"}`);
        error.status = response?.status;
        throw error;
      }
      return type === "json" ? response.json() : response.text();
    });
    return await Promise.race([requestAndBody, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function getWithRetry(url, { fetchImpl, timeoutMs, type }) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_GET_ATTEMPTS; attempt += 1) {
    try {
      const data = await fetchOnce(url, {
        fetchImpl,
        timeoutMs,
        type,
        accept: type === "json" ? "application/json" : "application/rss+xml, application/atom+xml, application/xml, text/xml",
      });
      return { data, attempts: attempt };
    } catch (error) {
      lastError = error;
    }
  }
  lastError.attempts = MAX_GET_ATTEMPTS;
  throw lastError;
}

function missingValue(value) {
  if (value === null || value === undefined) return true;
  const text = String(value).trim();
  return !text || /^(?:tbd|n\/?a|na|--?|null|undefined)$/i.test(text);
}

function normalizedValue(value, unit) {
  if (missingValue(value)) return null;
  const text = String(value).trim();
  const suffix = missingValue(unit) ? "" : String(unit).trim();
  return suffix && !text.endsWith(suffix) ? `${text}${suffix}` : text;
}

function normalizedScheduledAt(value) {
  if (missingValue(value)) return null;
  let date;
  if (typeof value === "number" || /^\d+$/.test(String(value).trim())) {
    const numeric = Number(value);
    date = new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric);
  } else {
    date = new Date(value);
  }
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizedImportance(value) {
  if (missingValue(value)) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const labels = { low: 1, medium: 2, high: 3 };
  return labels[String(value || "").trim().toLowerCase()] ?? null;
}

export function normalizeCalendarEvents(events = []) {
  if (!Array.isArray(events)) return [];
  return events.map((event = {}) => {
    const sourceId = event.id ?? event.eventId ?? event.event_id ?? null;
    const rawDate = event.date ?? event.datetime ?? event.timestamp ?? event.time ?? null;
    const scheduledAt = normalizedScheduledAt(rawDate);
    const unit = missingValue(event.unit) ? null : String(event.unit).trim();
    return {
      id: sourceId === null ? null : String(sourceId),
      sourceId,
      title: String(event.title ?? event.event ?? event.name ?? "").trim(),
      country: String(event.country ?? event.countryCode ?? event.country_code ?? "").trim() || null,
      importance: normalizedImportance(event.importance ?? event.impact),
      scheduledAt,
      timeLabel: scheduledAt || (missingValue(rawDate) ? "TBD" : String(rawDate).trim()),
      unit,
      values: {
        actual: normalizedValue(event.actual, unit),
        forecast: normalizedValue(event.forecast, unit),
        previous: normalizedValue(event.previous, unit),
      },
      rawValues: {
        actual: event.actual ?? null,
        forecast: event.forecast ?? null,
        previous: event.previous ?? null,
        unit: event.unit ?? null,
      },
    };
  });
}

function calendarUrl(from, to) {
  const url = new URL(TRADINGVIEW_CALENDAR_URL);
  if (from !== undefined && from !== null && from !== "") url.searchParams.set("from", isoNow(from));
  if (to !== undefined && to !== null && to !== "") url.searchParams.set("to", isoNow(to));
  return url.toString();
}

export async function fetchTradingViewCalendar({ from, to, fetchImpl = fetch, timeoutMs } = {}) {
  const url = calendarUrl(from, to);
  const checkedAt = isoNow();
  try {
    const response = await getWithRetry(url, { fetchImpl, timeoutMs, type: "json" });
    const payload = Array.isArray(response.data) ? response.data : response.data?.result ?? response.data?.data ?? [];
    const data = normalizeCalendarEvents(payload);
    return {
      data,
      events: data,
      sources: [sourceHealth({
        id: "tradingview-calendar",
        url,
        status: "ok",
        checkedAt,
        lastSuccessAt: checkedAt,
        freshnessSeconds: 0,
      })],
      warnings: [],
    };
  } catch (error) {
    return {
      data: [],
      events: [],
      sources: [sourceHealth({
        id: "tradingview-calendar",
        url,
        status: error?.code === "SOURCE_TIMEOUT" ? "timeout" : "error",
        checkedAt,
      })],
      warnings: [`TradingView calendar unavailable: ${error.message}`],
    };
  }
}

function decodeXmlEntities(value) {
  let result = String(value ?? "");
  for (let pass = 0; pass < 2; pass += 1) {
    const decoded = result.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code) => {
      const lowered = code.toLowerCase();
      if (lowered === "amp") return "&";
      if (lowered === "lt") return "<";
      if (lowered === "gt") return ">";
      if (lowered === "quot") return '"';
      if (lowered === "apos") return "'";
      const numeric = lowered.startsWith("#x")
        ? Number.parseInt(lowered.slice(2), 16)
        : Number.parseInt(lowered.slice(1), 10);
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : entity;
    });
    if (decoded === result) break;
    result = decoded;
  }
  return result;
}

function cleanXmlText(value) {
  const withoutCdata = String(value ?? "").replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/i, "$1");
  return decodeXmlEntities(withoutCdata.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function xmlTag(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match?.[1] ?? "";
}

function xmlAttribute(block, tag, attribute) {
  const tagMatch = block.match(new RegExp(`<${tag}\\b([^>]*)\\/?\\s*>`, "i"));
  if (!tagMatch) return "";
  const attributeMatch = tagMatch[1].match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  return attributeMatch?.[2] ?? "";
}

function normalizedPublishedAt(value) {
  const raw = cleanXmlText(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizedFeedSource(source = {}) {
  const id = String(source.id ?? source.label ?? source.name ?? "rss").trim() || "rss";
  return {
    id,
    label: String(source.label ?? source.name ?? id).trim() || id,
    url: String(source.url ?? "").trim(),
  };
}

export function parseRssFeed(xml, source) {
  const sourceRecord = normalizedFeedSource(source);
  const blocks = String(xml ?? "").match(/<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  return blocks.map((block) => {
    const sourceId = cleanXmlText(xmlTag(block, "guid") || xmlTag(block, "id")) || null;
    const textLink = cleanXmlText(xmlTag(block, "link"));
    const attributeLink = decodeXmlEntities(xmlAttribute(block, "link", "href"));
    const rawCategories = [
      ...block.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi),
    ].map((match) => cleanXmlText(match[1])).filter(Boolean);
    const attributeCategories = [...block.matchAll(/<category\b([^>]*)\/?>/gi)]
      .map((match) => {
        const term = match[1].match(/\bterm\s*=\s*(["'])([\s\S]*?)\1/i);
        return term ? decodeXmlEntities(term[2]).trim() : "";
      })
      .filter(Boolean);
    const url = attributeLink || textLink;
    const stablePart = sourceId || url || cleanXmlText(xmlTag(block, "title"));
    return {
      id: `${sourceRecord.id}:${stablePart}`,
      sourceId,
      title: cleanXmlText(xmlTag(block, "title")),
      url,
      summary: cleanXmlText(xmlTag(block, "description") || xmlTag(block, "summary") || xmlTag(block, "content")),
      publishedAt: normalizedPublishedAt(xmlTag(block, "pubDate") || xmlTag(block, "published") || xmlTag(block, "updated")),
      categories: [...new Set([...rawCategories, ...attributeCategories])],
      source: sourceRecord,
    };
  });
}

function freshnessFromItems(items, checkedAt) {
  const latest = Math.max(...items.map((item) => Date.parse(item.publishedAt)).filter(Number.isFinite));
  if (!Number.isFinite(latest)) return null;
  return Math.max(0, Math.floor((Date.parse(checkedAt) - latest) / 1000));
}

export async function fetchCryptoDailyCandidates({ now, fetchImpl = fetch, feeds, timeoutMs } = {}) {
  const checkedAt = isoNow(now ?? new Date());
  const configuredFeeds = Array.isArray(feeds) ? feeds : DEFAULT_DAILY_FEEDS;
  const results = await Promise.all(configuredFeeds.map(async (feed) => {
    const source = normalizedFeedSource(feed);
    try {
      const response = await getWithRetry(source.url, { fetchImpl, timeoutMs, type: "text" });
      const items = parseRssFeed(response.data, source);
      return {
        items,
        source: sourceHealth({
          id: source.id,
          url: source.url,
          status: "ok",
          checkedAt,
          lastSuccessAt: checkedAt,
          freshnessSeconds: freshnessFromItems(items, checkedAt),
        }),
        warning: null,
      };
    } catch (error) {
      return {
        items: [],
        source: sourceHealth({
          id: source.id,
          url: source.url,
          status: error?.code === "SOURCE_TIMEOUT" ? "timeout" : "error",
          checkedAt,
        }),
        warning: `${source.label} RSS unavailable: ${error.message}`,
      };
    }
  }));
  const windowStart = Date.parse(checkedAt) - 24 * 60 * 60 * 1000;
  const data = results.flatMap((result) => result.items).filter((item) => {
    const publishedAt = Date.parse(item.publishedAt);
    return !Number.isFinite(publishedAt) || (publishedAt >= windowStart && publishedAt <= Date.parse(checkedAt));
  });
  return {
    data,
    candidates: data,
    sources: results.map((result) => result.source),
    warnings: results.map((result) => result.warning).filter(Boolean),
  };
}

function numberValue(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error(`Invalid ${label}`);
  return numeric;
}

function reactionRecord(symbol, beforePrice, price, source, observedAt) {
  return {
    symbol,
    beforePrice,
    price,
    changePercent: Number((((price - beforePrice) / beforePrice) * 100).toFixed(4)),
    source,
    observedAt,
  };
}

async function fetchBinanceReaction(symbol, beforeMs, observedAt, fetchImpl) {
  const pair = `${symbol}USDT`;
  const candleUrl = `${BINANCE_API_URL}/api/v3/klines?symbol=${pair}&interval=1m&endTime=${beforeMs}&limit=1`;
  const tickerUrl = `${BINANCE_API_URL}/api/v3/ticker/price?symbol=${pair}`;
  const candle = await getWithRetry(candleUrl, { fetchImpl, timeoutMs: DEFAULT_SOURCE_TIMEOUT_MS, type: "json" });
  const ticker = await getWithRetry(tickerUrl, { fetchImpl, timeoutMs: DEFAULT_SOURCE_TIMEOUT_MS, type: "json" });
  return reactionRecord(
    symbol,
    numberValue(candle.data?.[0]?.[4], `${symbol} Binance before price`),
    numberValue(ticker.data?.price, `${symbol} Binance latest price`),
    "Binance",
    observedAt,
  );
}

async function fetchOkxReaction(symbol, beforeMs, observedAt, fetchImpl) {
  const instrument = `${symbol}-USDT`;
  const candleUrl = `${OKX_API_URL}/api/v5/market/candles?instId=${instrument}&bar=1m&before=${beforeMs}&limit=1`;
  const tickerUrl = `${OKX_API_URL}/api/v5/market/ticker?instId=${instrument}`;
  const candle = await getWithRetry(candleUrl, { fetchImpl, timeoutMs: DEFAULT_SOURCE_TIMEOUT_MS, type: "json" });
  const ticker = await getWithRetry(tickerUrl, { fetchImpl, timeoutMs: DEFAULT_SOURCE_TIMEOUT_MS, type: "json" });
  return reactionRecord(
    symbol,
    numberValue(candle.data?.data?.[0]?.[4], `${symbol} OKX before price`),
    numberValue(ticker.data?.data?.[0]?.last, `${symbol} OKX latest price`),
    "OKX",
    observedAt,
  );
}

async function fetchDxyReaction(beforeMs, nowMs, observedAt, fetchImpl) {
  const url = new URL(DXY_API_URL);
  url.searchParams.set("period1", String(Math.floor((beforeMs - 5 * 60 * 1000) / 1000)));
  url.searchParams.set("period2", String(Math.floor((nowMs + 60 * 1000) / 1000)));
  url.searchParams.set("interval", "1m");
  const response = await getWithRetry(url.toString(), { fetchImpl, timeoutMs: DEFAULT_SOURCE_TIMEOUT_MS, type: "json" });
  const result = response.data?.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const points = timestamps.map((timestamp, index) => ({ timestamp: Number(timestamp) * 1000, value: Number(closes[index]) }))
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value) && point.value > 0);
  const beforePoint = points.filter((point) => point.timestamp <= beforeMs).at(-1);
  const latestPoint = points.filter((point) => point.timestamp <= nowMs).at(-1);
  if (!beforePoint || !latestPoint) throw new Error("DXY data unavailable for requested window");
  return reactionRecord("DXY", beforePoint.value, latestPoint.value, "Yahoo Finance", observedAt);
}

function providerState(id, url, checkedAt, fallbackFrom) {
  return { id, url, checkedAt, fallbackFrom, successes: 0, errors: [], timeout: false };
}

function providerHealth(state) {
  const ok = state.successes > 0 && state.errors.length === 0;
  const status = ok ? "ok" : state.timeout && state.successes === 0 ? "timeout" : state.successes > 0 ? "degraded" : "error";
  return sourceHealth({
    id: state.id,
    url: state.url,
    status,
    checkedAt: state.checkedAt,
    lastSuccessAt: state.successes > 0 ? state.checkedAt : null,
    freshnessSeconds: state.successes > 0 ? 0 : null,
    fallbackFrom: state.fallbackFrom,
  });
}

function noteProviderError(state, error) {
  state.errors.push(error);
  if (error?.code === "SOURCE_TIMEOUT") state.timeout = true;
}

export async function fetchMarketReaction({ beforeAt, now, fetchImpl = fetch, symbols = ["BTC", "ETH", "DXY"] } = {}) {
  const observedAt = isoNow(now ?? new Date());
  const nowMs = Date.parse(observedAt);
  const requestedBefore = beforeAt === undefined || beforeAt === null ? nowMs - 60_000 : new Date(beforeAt).getTime();
  const beforeMs = Number.isFinite(requestedBefore) ? requestedBefore : nowMs - 60_000;
  const normalizedSymbols = [...new Set((Array.isArray(symbols) ? symbols : []).map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean))];
  const data = {};
  const warnings = [];
  const providers = {
    binance: providerState("binance", BINANCE_API_URL, observedAt),
    okx: providerState("okx", OKX_API_URL, observedAt, "binance"),
    dxy: providerState("dxy-yahoo-finance", DXY_API_URL, observedAt),
  };

  for (const symbol of normalizedSymbols) {
    if (symbol === "DXY") {
      try {
        data.DXY = await fetchDxyReaction(beforeMs, nowMs, observedAt, fetchImpl);
        providers.dxy.successes += 1;
      } catch (error) {
        noteProviderError(providers.dxy, error);
        warnings.push(`DXY optional data unavailable: ${error.message}`);
      }
      continue;
    }

    try {
      data[symbol] = await fetchBinanceReaction(symbol, beforeMs, observedAt, fetchImpl);
      providers.binance.successes += 1;
      continue;
    } catch (error) {
      noteProviderError(providers.binance, error);
    }

    try {
      data[symbol] = await fetchOkxReaction(symbol, beforeMs, observedAt, fetchImpl);
      providers.okx.successes += 1;
    } catch (error) {
      noteProviderError(providers.okx, error);
      warnings.push(`${symbol} market reaction unavailable from Binance and OKX: ${error.message}`);
    }
  }

  const sources = [];
  if (normalizedSymbols.some((symbol) => symbol !== "DXY")) sources.push(providerHealth(providers.binance));
  if (providers.okx.successes || providers.okx.errors.length) sources.push(providerHealth(providers.okx));
  if (normalizedSymbols.includes("DXY")) sources.push(providerHealth(providers.dxy));
  return { data, prices: data, sources, warnings };
}
