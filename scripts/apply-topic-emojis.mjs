import { readFile } from "node:fs/promises";
import process from "node:process";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required");

const emojiByKey = {
  read_first_dislaimer: "❗",
  read_first_disclaimer: "❗",
  market_events: "🖼️",
  market_analysis_crypto_stocks_tradfi: "💡",
  yubit_updates: "🐲",
  smart_money_tracker: "💎",
  xxx_s_trading_zone: "⚡",
  "10k_to_100k_challenge": "💰",
  "7_day_pnl_challenge": "💰"
};
const state = JSON.parse(await readFile(".runtime/setup-state.json", "utf8"));
if (String(state.chatId) !== String(chatId)) throw new Error("Target chat does not match setup state");
const updated = [];
for (const [key, topic] of Object.entries(state.topics || {})) {
  const emoji = emojiByKey[key];
  if (!emoji || !topic?.message_thread_id) continue;
  const name = `${emoji} ${String(topic.name || "").replace(/^[^\p{Letter}\p{Number}]+/u, "").trim()}`;
  const response = await fetch(`https://api.telegram.org/bot${token}/editForumTopic`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, message_thread_id: topic.message_thread_id, name }) });
  const body = await response.json();
  if (!body.ok && !/not modified/i.test(body.description || "")) throw new Error(body.description || "editForumTopic failed");
  topic.name = name;
  updated.push({ threadId: topic.message_thread_id, name });
}
console.log(JSON.stringify({ ok: true, updated }, null, 2));
