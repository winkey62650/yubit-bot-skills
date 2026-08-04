import process from "node:process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { telegramCall } from "./lib/telegram-client.mjs";

const chatId = process.env.TELEGRAM_CHAT_ID;
const threadId = Number(process.env.TELEGRAM_THREAD_ID || 18);
const shouldSend = process.env.SEND_TELEGRAM === "true";
const openAiKey = process.env.OPENAI_API_KEY;
const openAiModel = process.env.OPENAI_MODEL || "gpt-4o-mini";
const speakerMode = process.env.DISCUSSION_SPEAKER_MODE || "rotate";
const statePath = process.env.DISCUSSION_STATE_PATH || join(dirname(fileURLToPath(import.meta.url)), ".market-discussion-state.json");

const speakerTokens = [
  {
    key: "jack",
    name: "Jack",
    token: process.env.JACK_BOT_TOKEN,
    role: "active retail futures trader",
    style: "casual, asks sharp questions, watches momentum and liquidation risk"
  },
  {
    key: "tony",
    name: "Tony",
    token: process.env.TONY_BOT_TOKEN,
    role: "risk-first swing trader",
    style: "calm, practical, talks about levels, invalidation, and position sizing"
  },
  {
    key: "trader",
    name: "Trader",
    token: process.env.TRADER1_BOT_TOKEN,
    role: "YUBIT market bot",
    style: "concise market desk voice, summarizes trend and risk"
  }
].filter((speaker) => Boolean(speaker.token));

if (!chatId) {
  throw new Error("TELEGRAM_CHAT_ID is required");
}

if (!speakerTokens.length) {
  console.log("No speaker bot tokens found. Set JACK_BOT_TOKEN, TONY_BOT_TOKEN, or TRADER1_BOT_TOKEN.");
  process.exit(0);
}

const context = await buildMarketContext();
const activeSpeakers = speakerMode === "all" ? speakerTokens : [await pickNextSpeaker(speakerTokens)];
const messages = await buildConversation(context, activeSpeakers);

for (const item of messages) {
  const text = formatSpeakerMessage(item);
  console.log(`\n=== ${item.name} ===\n${text}`);
  if (shouldSend) {
    await postTelegram(item.token, text);
    await sleep(Number(process.env.DISCUSSION_DELAY_MS || 2500));
  }
}

async function buildMarketContext() {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  const rows = [];

  for (const symbol of symbols) {
    try {
      const params = new URLSearchParams({ symbol });
      const ticker = await getJson(`https://fapi.binance.com/fapi/v1/ticker/24hr?${params}`);
      rows.push({
        symbol,
        last: Number(ticker.lastPrice),
        changePct: Number(ticker.priceChangePercent),
        high: Number(ticker.highPrice),
        low: Number(ticker.lowPrice)
      });
    } catch (error) {
      rows.push({ symbol, error: error.message });
    }
  }

  return {
    time: new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC",
    rows
  };
}

async function buildConversation(context, speakers) {
  if (openAiKey) {
    try {
      return await buildAiConversation(context, speakers);
    } catch (error) {
      console.error(`AI generation failed, using fallback: ${error.message}`);
    }
  }

  return buildFallbackConversation(context, speakers);
}

async function buildAiConversation(context, speakers) {
  const prompt = [
    "Create a short Telegram market discussion between these YUBIT community participants.",
    "Each message must be 1-2 sentences, natural, useful, and feel like a reply in an active market discussion.",
    "Use 1-2 light emojis per message where natural.",
    "No guaranteed-profit claims, no direct financial advice, no fake insider information.",
    "Include risk awareness where relevant. Use English.",
    "",
    `Market context: ${JSON.stringify(context)}`,
    `Speakers: ${JSON.stringify(speakers.map(({ name, role, style }) => ({ name, role, style })))}`,
    "",
    "Return strict JSON only: [{\"name\":\"Jack\",\"text\":\"...\"}]."
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${openAiKey}`
    },
    body: JSON.stringify({
      model: openAiModel,
      input: prompt,
      temperature: 0.7
    })
  });

  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || `OpenAI request failed: ${response.status}`);

  const output = body.output_text || body.output?.flatMap((item) => item.content || []).map((item) => item.text).join("");
  const parsed = JSON.parse(extractJson(output));
  return parsed
    .filter((item) => speakers.some((speaker) => speaker.name === item.name))
    .map((item) => ({
      ...item,
      token: speakers.find((speaker) => speaker.name === item.name).token
    }));
}

function buildFallbackConversation(context, speakers) {
  const btc = context.rows.find((row) => row.symbol === "BTCUSDT") || {};
  const eth = context.rows.find((row) => row.symbol === "ETHUSDT") || {};
  const sol = context.rows.find((row) => row.symbol === "SOLUSDT") || {};
  const bias = Number(btc.changePct || 0) >= 0 ? "bid is holding better than expected" : "momentum is still heavy";
  const btcRange = btc.high && btc.low ? `${formatNumber(btc.low)}-${formatNumber(btc.high)}` : "the current intraday range";

  const drafts = {
    Jack: `BTC ${bias} here 👀 I am watching whether price can reclaim the mid-range before chasing any breakout.`,
    Tony: `I would keep size controlled until BTC clears the ${btcRange} range cleanly ⚖️ A tight invalidation matters more than being early.`,
    Trader: `Market desk note 📊 BTC ${formatPct(btc.changePct)}, ETH ${formatPct(eth.changePct)}, SOL ${formatPct(sol.changePct)} over 24h. Informational only, manage leverage and stops.`
  };

  return speakers.map((speaker) => ({
    name: speaker.name,
    token: speaker.token,
    text: drafts[speaker.name] || drafts.Trader
  }));
}

function formatSpeakerMessage(item) {
  return `<b>${escapeHtml(item.name)}</b>\n${escapeHtml(item.text)}`;
}

async function pickNextSpeaker(speakers) {
  const state = await readState();
  const previousIndex = Number.isInteger(state.nextIndex) ? state.nextIndex : 0;
  const index = previousIndex % speakers.length;
  const speaker = speakers[index];
  await writeState({
    nextIndex: (index + 1) % speakers.length,
    lastSpeaker: speaker.name,
    lastRunAt: new Date().toISOString()
  });
  return speaker;
}

async function readState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return {};
  }
}

async function writeState(state) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

async function postTelegram(token, text) {
  await telegramCall(token, "sendMessage", {
    chat_id: chatId,
    message_thread_id: threadId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function getJson(url) {
  const response = await fetch(url, { headers: { "user-agent": "YUBITCommunityBot/1.0" } });
  if (!response.ok) throw new Error(`${url} failed: ${response.status}`);
  return response.json();
}

function extractJson(text) {
  const trimmed = String(text || "").trim();
  if (trimmed.startsWith("[")) return trimmed;
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("AI response did not contain JSON");
  return match[0];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "n/a";
  if (value >= 100) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toPrecision(5);
}

function formatPct(value) {
  if (!Number.isFinite(Number(value))) return "n/a";
  return `${Number(value).toFixed(2)}%`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
