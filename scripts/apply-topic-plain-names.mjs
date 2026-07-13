import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required");

const names = {
  read_first_dislaimer: "READ FIRST - DISLAIMER",
  market_events: "Market Events",
  market_analysis_crypto_stocks_tradfi: "Market Analysis - Crypto/Stocks/TradFi",
  yubit_updates: "YUBIT Updates",
  smart_money_tracker: "Smart Money Tracker",
  xxx_s_trading_zone: "xxx's Trading Zone",
  "10k_to_100k_challenge": "10k to 100k challenge"
};

const statePath = ".runtime/setup-state.json";
const state = JSON.parse(await readFile(statePath, "utf8"));
const updated = [];

for (const [key, name] of Object.entries(names)) {
  const topic = state.topics?.[key];
  if (!topic?.message_thread_id) throw new Error(`Missing saved Topic for ${key}`);
  const response = await fetch(`https://api.telegram.org/bot${token}/editForumTopic`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_thread_id: topic.message_thread_id, name })
  });
  const result = await response.json();
  if (!result.ok && !/not modified/i.test(result.description || "")) {
    throw new Error(`${key}: ${result.description || "editForumTopic failed"}`);
  }
  topic.name = name;
  updated.push({ key, message_thread_id: topic.message_thread_id, name });
}

await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, updated }, null, 2));
