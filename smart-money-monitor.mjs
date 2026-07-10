import process from "node:process";
import { smartMoneySources } from "./smart-money-sources.mjs";

const binanceFuturesBase = "https://fapi.binance.com";
const glassnodeBase = "https://api.glassnode.com/v1";
const coinglassBase = "https://open-api-v4.coinglass.com";
const telegramBase = "https://api.telegram.org/bot";

const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TRADER1_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const threadId = Number(process.env.TELEGRAM_THREAD_ID || 0);
const shouldSend = process.env.SEND_TELEGRAM === "true";
const symbols = parseList(process.env.SMART_MONEY_SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT");
const depthLimit = Number(process.env.ORDERBOOK_DEPTH_LIMIT || 1000);
const wallThresholdUsd = Number(process.env.ORDERBOOK_WALL_MIN_USD || 5_000_000);
const liquidationThresholdUsd = Number(process.env.LIQUIDATION_MIN_USD || 1_000_000);
const liquidationLookbackMinutes = Number(process.env.LIQUIDATION_LOOKBACK_MINUTES || 60);

const snapshot = await buildSnapshot();
const message = formatSnapshot(snapshot);

console.log(message);

if (shouldSend) {
  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN/TRADER1_BOT_TOKEN and TELEGRAM_CHAT_ID are required when SEND_TELEGRAM=true");
  }
  await postTelegram(message);
}

async function buildSnapshot() {
  const [orderBooks, liquidations, etfFlows] = await Promise.all([
    fetchOrderBookWalls(),
    fetchLiquidations(),
    fetchEtfFlows()
  ]);

  return {
    generatedAt: new Date().toISOString(),
    symbols,
    orderBooks,
    liquidations,
    etfFlows,
    sourceStatus: buildSourceStatus()
  };
}

async function fetchOrderBookWalls() {
  const rows = [];
  for (const symbol of symbols) {
    try {
      const params = new URLSearchParams({ symbol, limit: String(depthLimit) });
      const depth = await getJson(`${binanceFuturesBase}/fapi/v1/depth?${params}`);
      const bids = collectWalls(depth.bids || [], "bid", symbol);
      const asks = collectWalls(depth.asks || [], "ask", symbol);
      rows.push({ symbol, ok: true, walls: [...bids, ...asks].sort((a, b) => b.notionalUsd - a.notionalUsd).slice(0, 6) });
    } catch (error) {
      rows.push({ symbol, ok: false, error: error.message, walls: [] });
    }
    await sleep(150);
  }
  return rows;
}

function collectWalls(levels, side, symbol) {
  return levels
    .map(([priceRaw, qtyRaw]) => {
      const price = Number(priceRaw);
      const qty = Number(qtyRaw);
      return { symbol, side, price, qty, notionalUsd: price * qty };
    })
    .filter((row) => row.notionalUsd >= wallThresholdUsd);
}

async function fetchLiquidations() {
  const apiKey = process.env.COINGLASS_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      source: "CoinGlass",
      reason: "Missing COINGLASS_API_KEY. Binance liquidation data is available as a WebSocket stream, not a reliable one-shot REST snapshot.",
      rows: []
    };
  }

  const rows = [];
  for (const symbol of symbols) {
    try {
      const params = new URLSearchParams({
        exchange: "Binance",
        symbol,
        interval: normalizeLiquidationInterval(liquidationLookbackMinutes),
        limit: "1"
      });
      const body = await getJson(`${coinglassBase}/api/futures/liquidation/history?${params}`, {
        "CG-API-KEY": apiKey
      });
      const latest = Array.isArray(body.data) ? body.data.at(-1) : null;
      const longUsd = Number(latest?.long_liquidation_usd || 0);
      const shortUsd = Number(latest?.short_liquidation_usd || 0);
      rows.push({
        symbol,
        ok: Boolean(latest),
        source: "CoinGlass",
        time: Number(latest?.time || 0),
        longUsd,
        shortUsd,
        totalUsd: longUsd + shortUsd
      });
    } catch (error) {
      rows.push({ symbol, ok: false, error: error.message });
    }
    await sleep(150);
  }
  return { ok: true, source: "CoinGlass", rows };
}

async function fetchEtfFlows() {
  const apiKey = process.env.GLASSNODE_API_KEY;
  if (!apiKey) {
    return { ok: false, source: "Glassnode", reason: "Missing GLASSNODE_API_KEY", rows: [] };
  }

  const rows = [];
  for (const asset of ["BTC", "ETH"]) {
    try {
      const params = new URLSearchParams({
        a: asset,
        i: "24h",
        api_key: apiKey
      });
      const data = await getJson(`${glassnodeBase}/metrics/institutions/us_spot_etf_flows_net?${params}`);
      const latest = Array.isArray(data) ? data.at(-1) : null;
      rows.push({
        asset,
        ok: Boolean(latest),
        timestamp: latest?.t ? new Date(Number(latest.t) * 1000).toISOString() : "",
        netFlowUsd: Number(latest?.v ?? 0)
      });
    } catch (error) {
      rows.push({ asset, ok: false, error: error.message });
    }
    await sleep(150);
  }
  return { ok: true, source: "Glassnode", rows };
}

function buildSourceStatus() {
  return smartMoneySources.map((source) => ({
    name: source.name,
    status: source.env ? (process.env[source.env] ? "configured" : "missing key") : "configured",
    coverage: source.coverage,
    env: source.env
  }));
}

function formatSnapshot(snapshot) {
  const time = snapshot.generatedAt.replace("T", " ").slice(0, 16) + " UTC";
  const lines = [
    "<b>YUBIT Smart Money Tracker</b>",
    "",
    `Time: ${time}`,
    `Watchlist: ${snapshot.symbols.join(", ")}`,
    "",
    "<b>Large Order-Book Walls</b>"
  ];

  const walls = snapshot.orderBooks.flatMap((item) => item.walls || []);
  if (!walls.length) {
    lines.push(`No Binance futures wall above ${formatUsd(wallThresholdUsd)} in current depth snapshot.`);
  } else {
    walls.slice(0, 12).forEach((wall, index) => {
      const side = wall.side === "bid" ? "BID support" : "ASK resistance";
      lines.push(`${index + 1}. <b>${wall.symbol}</b> ${side} @ ${formatPrice(wall.price)} | ${formatUsd(wall.notionalUsd)}`);
    });
  }

  lines.push("", "<b>Large Liquidations</b>");
  const liqs = snapshot.liquidations.rows || [];
  if (!liqs.length) {
    lines.push(escapeHtml(snapshot.liquidations.reason || "No liquidation data available."));
  } else {
    liqs.slice(0, 10).forEach((row, index) => {
      if (!row.ok) {
        lines.push(`${index + 1}. <b>${row.symbol}</b> unavailable (${escapeHtml(row.error || "no latest data")})`);
        return;
      }
      if (row.totalUsd < liquidationThresholdUsd) {
        lines.push(`${index + 1}. <b>${row.symbol}</b> below threshold | total ${formatUsd(row.totalUsd)} | long ${formatUsd(row.longUsd)} / short ${formatUsd(row.shortUsd)}`);
        return;
      }
      lines.push(`${index + 1}. <b>${row.symbol}</b> liquidation ${formatUsd(row.totalUsd)} | long ${formatUsd(row.longUsd)} / short ${formatUsd(row.shortUsd)} | ${formatTime(row.time)}`);
    });
  }

  lines.push("", "<b>ETF & Institution Flows</b>");
  if (snapshot.etfFlows.rows?.length) {
    snapshot.etfFlows.rows.forEach((row) => {
      if (!row.ok) {
        lines.push(`${row.asset}: unavailable (${escapeHtml(row.error || "no latest data")})`);
        return;
      }
      lines.push(`${row.asset} spot ETF net flow: <b>${formatUsd(row.netFlowUsd)}</b> · ${row.timestamp.slice(0, 10)}`);
    });
  } else {
    lines.push("Glassnode ETF flow adapter is ready, but GLASSNODE_API_KEY is not configured.");
  }

  lines.push("", "<b>Professional Sources Needed</b>");
  const missing = snapshot.sourceStatus
    .filter((source) => source.status === "missing key")
    .slice(0, 6)
    .map((source) => `${source.name}${source.env ? ` (${source.env})` : ""}`);
  lines.push(missing.length ? escapeHtml(missing.join(" · ")) : "All configured source keys are present.");
  lines.push("", "<i>Informational only. Not investment advice. Exchange-only data may miss OTC, cross-chain, and internal transfers.</i>");

  return trimTelegram(lines.join("\n"));
}

async function postTelegram(text) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  if (threadId) payload.message_thread_id = threadId;

  const response = await fetch(`${telegramBase}${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!body.ok) throw new Error(body.description || "Telegram sendMessage failed");
}

async function getJson(url, extraHeaders = {}) {
  const response = await fetch(url, {
    headers: { "user-agent": "YUBITSmartMoneyBot/1.0", ...extraHeaders },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function normalizeLiquidationInterval(minutes) {
  if (minutes <= 1) return "1m";
  if (minutes <= 3) return "3m";
  if (minutes <= 5) return "5m";
  if (minutes <= 15) return "15m";
  if (minutes <= 30) return "30m";
  if (minutes <= 60) return "1h";
  if (minutes <= 240) return "4h";
  if (minutes <= 360) return "6h";
  if (minutes <= 480) return "8h";
  if (minutes <= 720) return "12h";
  return "1d";
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function formatUsd(value) {
  const abs = Math.abs(Number(value || 0));
  const sign = Number(value || 0) < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function formatPrice(value) {
  const number = Number(value || 0);
  if (number >= 1000) return number.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (number >= 1) return number.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return number.toPrecision(5);
}

function formatTime(value) {
  if (!value) return "time n/a";
  return new Date(Number(value)).toISOString().slice(11, 16) + " UTC";
}

function trimTelegram(text) {
  return text.length > 3900 ? `${text.slice(0, 3850)}\n\n<i>Output trimmed for Telegram.</i>` : text;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
