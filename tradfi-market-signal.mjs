import process from "node:process";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const telegramBase = "https://api.telegram.org/bot";
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const threadId = Number(process.env.TELEGRAM_THREAD_ID || 12);
const shouldSend = process.env.SEND_TELEGRAM === "true";
const fastPeriod = Number(process.env.FAST_SMA || 20);
const slowPeriod = Number(process.env.SLOW_SMA || 50);
const yubitTradfiBaseUrl = process.env.YUBIT_TRADFI_BASE_URL || "https://www.yubit.com/tradfi";

const instruments = [
  ["SPY", "S&P 500 ETF", "SPX500.s"],
  ["QQQ", "Nasdaq 100 ETF", "NAS100.s"],
  ["DIA", "Dow Jones ETF", "DJI30.s"],
  ["IWM", "Russell 2000 ETF", "RUS2000.s"],
  ["TLT", "20Y Treasury ETF", "USBOND.s"],
  ["GLD", "Gold ETF", "XAUUSD.s"],
  ["USO", "Oil ETF", "USOIL.s"],
  ["UUP", "US Dollar ETF", "DXY.s"]
];

const rows = [];

for (const [symbol, label, yubitSymbol] of instruments) {
  const closes = await fetchYahooCloses(symbol);
  if (closes.length < slowPeriod) continue;

  const fast = sma(closes, fastPeriod);
  const slow = sma(closes, slowPeriod);
  const prevFast = sma(closes.slice(0, -1), fastPeriod);
  const prevSlow = sma(closes.slice(0, -1), slowPeriod);
  const last = closes.at(-1);
  const changePct = ((last / closes.at(-2) - 1) * 100).toFixed(2);

  rows.push({
    symbol,
    label,
    yubitSymbol,
    last,
    changePct,
    fast,
    slow,
    signal: classify(fast, slow, prevFast, prevSlow)
  });

  await sleep(200);
}

const message = formatSignal(rows);
console.log(message);

if (shouldSend) {
  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required when SEND_TELEGRAM=true");
  }
  const topSymbol = rows[0]?.yubitSymbol || "XAUUSD.s";
  const photoPath = await renderSignalCard(rows);
  const caption = formatSignalCaption(rows);
  await postTelegramPhoto(caption, photoPath, `${yubitTradfiBaseUrl}/${topSymbol}`);
}

async function fetchYahooCloses(symbol) {
  const params = new URLSearchParams({ range: "10d", interval: "1h" });
  let data;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`, {
        headers: { "user-agent": "YUBITCommunityBot/1.0" },
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`Yahoo chart failed for ${symbol}: ${response.status}`);
      data = await response.json();
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(3000 * attempt);
    }
  }
  const result = data.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  return closes.filter((value) => Number.isFinite(value));
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
    "<b>YUBIT TradFi Signal · 1H Dual SMA</b>",
    "",
    "Universe: SPY, QQQ, DIA, IWM, TLT, GLD, USO, UUP",
    `Rule: SMA${fastPeriod} vs SMA${slowPeriod} on 1h candles`,
    `Time: ${now}`,
    "",
    "<b>Summary</b>",
    `Bullish: ${bullish.length} · Bearish: ${bearish.length} · Fresh crosses: ${crosses.length}`,
    "",
    "<b>Instruments</b>"
  ];

  rows.forEach((row, index) => {
    const icon = row.signal.includes("Bullish") ? "🟢" : row.signal.includes("Bearish") ? "🔴" : "⚪️";
    lines.push(
      `${index + 1}. ${icon} <b>${row.symbol}</b> ${row.signal} | ${row.label} | Last ${formatNumber(row.last)} | 1h ${row.changePct}% | SMA${fastPeriod} ${formatNumber(row.fast)} / SMA${slowPeriod} ${formatNumber(row.slow)}`
    );
  });

  lines.push("", "Risk notice: informational only, not investment advice. Macro markets can gap around data releases.");
  return lines.join("\n");
}

function formatSignalCaption(rows) {
  const bullish = rows.filter((row) => row.signal.includes("Bullish"));
  const bearish = rows.filter((row) => row.signal.includes("Bearish"));
  const crosses = rows.filter((row) => row.signal.includes("cross"));
  const top = rows[0];
  return [
    "<b>YUBIT TradFi Signal · 1H Dual SMA</b>",
    `SPY QQQ DIA IWM TLT GLD USO UUP · SMA${fastPeriod}/SMA${slowPeriod}`,
    `Bullish ${bullish.length} · Bearish ${bearish.length} · Fresh crosses ${crosses.length}`,
    top ? `Lead instrument: <b>${top.symbol}</b> ${top.signal} · 1h ${top.changePct}%` : "",
    "Full table shown in image. Not investment advice."
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
  form.set("photo", new Blob([await readFile(photoPath)], { type: "image/png" }), "tradfi-signal.png");
  form.set(
    "reply_markup",
    JSON.stringify({
      inline_keyboard: [[{ text: "Open YUBIT TradFi", url: buttonUrl }]]
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
  const dir = await mkdtemp(join(tmpdir(), "yubit-tradfi-"));
  const payloadPath = join(dir, "payload.json");
  const outPath = join(dir, "tradfi-signal.png");
  const bullish = rows.filter((row) => row.signal.includes("Bullish"));
  const bearish = rows.filter((row) => row.signal.includes("Bearish"));
  const crosses = rows.filter((row) => row.signal.includes("cross"));
  const payload = {
    title: "YUBIT TradFi Signal",
    badge: "TRADFI",
    heroChip: "TradFi Signal Ready",
    section: "One market setup",
    actionText: "Review the 1H SMA signal, then tap the blue button below to open YUBIT TradFi.",
    subtitle: `SPY QQQ DIA IWM TLT GLD USO UUP · SMA${fastPeriod}/SMA${slowPeriod} · 1h`,
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
