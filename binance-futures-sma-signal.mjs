import process from "node:process";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const binanceBase = "https://fapi.binance.com";
const telegramBase = "https://api.telegram.org/bot";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const threadId = Number(process.env.TELEGRAM_THREAD_ID || 10);
const shouldSend = process.env.SEND_TELEGRAM === "true";
const interval = process.env.BINANCE_INTERVAL || "1h";
const fastPeriod = Number(process.env.FAST_SMA || 20);
const slowPeriod = Number(process.env.SLOW_SMA || 50);
const symbolLimit = Number(process.env.SYMBOL_LIMIT || 20);
const yubitFuturesBaseUrl = process.env.YUBIT_FUTURES_BASE_URL || "https://www.yubit.com/trade/usdt";

const exchangeInfo = await getJson(`${binanceBase}/fapi/v1/exchangeInfo`);
const tradableUsdtPerps = new Set(
  exchangeInfo.symbols
    .filter((item) => item.status === "TRADING" && item.contractType === "PERPETUAL" && item.quoteAsset === "USDT")
    .map((item) => item.symbol)
);

const tickers = await getJson(`${binanceBase}/fapi/v1/ticker/24hr`);
const topSymbols = tickers
  .filter((item) => tradableUsdtPerps.has(item.symbol))
  .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
  .slice(0, symbolLimit)
  .map((item) => item.symbol);

const rows = [];

for (const symbol of topSymbols) {
  const params = new URLSearchParams({ symbol, interval, limit: String(slowPeriod + 5) });
  const klines = await getJson(`${binanceBase}/fapi/v1/klines?${params}`);
  const closes = klines.map((kline) => Number(kline[4]));
  const fast = sma(closes, fastPeriod);
  const slow = sma(closes, slowPeriod);
  const prevFast = sma(closes.slice(0, -1), fastPeriod);
  const prevSlow = sma(closes.slice(0, -1), slowPeriod);
  const last = closes.at(-1);
  const changePct = ((last / closes.at(-2) - 1) * 100).toFixed(2);

  rows.push({
    symbol,
    last,
    changePct,
    fast,
    slow,
    signal: classify(fast, slow, prevFast, prevSlow)
  });

  await sleep(120);
}

const message = formatSignal(rows);
console.log(message);

if (shouldSend) {
  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required when SEND_TELEGRAM=true");
  }

  const topSymbol = rows[0]?.symbol || "BTCUSDT";
  const photoPath = await renderSignalCard(rows);
  const caption = formatSignalCaption(rows);
  await postTelegramPhoto(caption, photoPath, `${yubitFuturesBaseUrl}/${topSymbol}`);
}

function sma(values, period) {
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}

function classify(fast, slow, prevFast, prevSlow) {
  if (fast > slow && prevFast <= prevSlow) return "Bullish cross";
  if (fast < slow && prevFast >= prevSlow) return "Bearish cross";
  if (fast > slow) return "Bullish";
  if (fast < slow) return "Bearish";
  return "Neutral";
}

function formatSignal(rows) {
  const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const bullish = rows.filter((row) => row.signal.includes("Bullish"));
  const bearish = rows.filter((row) => row.signal.includes("Bearish"));
  const crosses = rows.filter((row) => row.signal.includes("cross"));
  const lines = [
    "<b>YUBIT Futures Signal · 1H Dual SMA</b>",
    "",
    `Universe: YUBIT USDT Futures Watchlist · Top ${rows.length} by reference liquidity`,
    `Rule: SMA${fastPeriod} vs SMA${slowPeriod} on ${interval} candles`,
    `Time: ${now}`,
    "",
    `<b>Summary</b>`,
    `Bullish: ${bullish.length} · Bearish: ${bearish.length} · Fresh crosses: ${crosses.length}`,
    "",
    "<b>Symbols</b>"
  ];

  rows.forEach((row, index) => {
    const icon = row.signal.includes("Bullish") ? "🟢" : row.signal.includes("Bearish") ? "🔴" : "⚪️";
    lines.push(
      `${index + 1}. ${icon} <b>${row.symbol}</b> ${row.signal} | Last ${formatNumber(row.last)} | 1h ${row.changePct}% | SMA${fastPeriod} ${formatNumber(row.fast)} / SMA${slowPeriod} ${formatNumber(row.slow)}`
    );
  });

  lines.push("", "Risk notice: informational only, not investment advice. Use position sizing, leverage control, and stop loss.");
  return lines.join("\n");
}

function formatSignalCaption(rows) {
  const bullish = rows.filter((row) => row.signal.includes("Bullish"));
  const bearish = rows.filter((row) => row.signal.includes("Bearish"));
  const crosses = rows.filter((row) => row.signal.includes("cross"));
  const top = rows[0];
  return [
    "📈 <b>YUBIT Futures Signal</b>",
    "",
    `<b>Timeframe</b>: 1H`,
    `<b>Strategy</b>: Dual SMA ${fastPeriod}/${slowPeriod}`,
    `<b>Universe</b>: YUBIT USDT Futures Watchlist · Top ${rows.length}`,
    "",
    `🟢 Bullish: <b>${bullish.length}</b>   🔴 Bearish: <b>${bearish.length}</b>   ⚡ Fresh crosses: <b>${crosses.length}</b>`,
    top ? `🔥 Lead pair: <b>${top.symbol}</b> · ${top.signal} · 1H ${top.changePct}%` : "",
    "",
    "Tap the button below to open YUBIT Futures.",
    "<i>Informational only. Not investment advice.</i>"
  ]
    .filter(Boolean)
    .join("\n");
}

function formatNumber(value) {
  if (value >= 100) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toPrecision(5);
}

async function postTelegram(text) {
  const response = await fetch(`${telegramBase}${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_thread_id: threadId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });

  const body = await response.json();
  if (!body.ok) throw new Error(body.description || "Telegram sendMessage failed");
}

async function postTelegramPhoto(caption, photoPath, buttonUrl) {
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("message_thread_id", String(threadId));
  form.set("caption", trimCaption(caption));
  form.set("parse_mode", "HTML");
  form.set("photo", new Blob([await readFile(photoPath)], { type: "image/png" }), "futures-signal.png");
  form.set(
    "reply_markup",
    JSON.stringify({
      inline_keyboard: [[{ text: "Open YUBIT Futures", url: buttonUrl }]]
    })
  );

  const response = await fetch(`${telegramBase}${token}/sendPhoto`, {
    method: "POST",
    body: form
  });

  const body = await response.json();
  if (!body.ok) throw new Error(body.description || "Telegram sendPhoto failed");
}

async function renderSignalCard(rows) {
  const dir = await mkdtemp(join(tmpdir(), "yubit-futures-"));
  const payloadPath = join(dir, "payload.json");
  const outPath = join(dir, "futures-signal.png");
  const bullish = rows.filter((row) => row.signal.includes("Bullish"));
  const bearish = rows.filter((row) => row.signal.includes("Bearish"));
  const crosses = rows.filter((row) => row.signal.includes("cross"));
  const payload = {
    title: "YUBIT Futures Signal",
    badge: "FUTURES",
    heroChip: "Futures Signal Ready",
    section: "One market setup",
    actionText: "Review the 1H SMA signal, then tap the blue button below to open YUBIT Futures.",
    subtitle: `YUBIT USDT Futures Watchlist Top ${rows.length} · SMA${fastPeriod}/SMA${slowPeriod} · ${interval}`,
    time: new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC",
    summary: { bullish: bullish.length, bearish: bearish.length, crosses: crosses.length },
    rows: rows.map((row) => ({
      symbol: row.symbol,
      signal: row.signal,
      last: formatNumber(row.last),
      changePct: row.changePct,
      fast: formatNumber(row.fast),
      slow: formatNumber(row.slow)
    }))
  };
  await writeFile(payloadPath, JSON.stringify(payload));
  await runPython(["render-card.py", "signal", payloadPath, outPath]);
  return outPath;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} failed: ${response.status}`);
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimCaption(text) {
  return text.length > 1000 ? `${text.slice(0, 950)}\n\nFull table shown in image.` : text;
}

async function runPython(args) {
  const python = "/Users/winkey/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
  const child = spawn(python, args, { cwd: fileURLToPath(new URL(".", import.meta.url)) });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) throw new Error(stderr || `python exited ${code}`);
}
