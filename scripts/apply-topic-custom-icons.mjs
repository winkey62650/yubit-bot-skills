import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required");

const icons = {
  read_first_dislaimer: "5379748062124056162",
  market_events: "5433614043006903194",
  market_analysis_crypto_stocks_tradfi: "5312536423851630001",
  yubit_updates: "5309984423003823246",
  smart_money_tracker: "5309958691854754293",
  xxx_s_trading_zone: "5312016608254762256",
  "10k_to_100k_challenge": "5350452584119279096"
};

const statePath = ".runtime/setup-state.json";
const state = JSON.parse(await readFile(statePath, "utf8"));
const updated = [];

for (const [key, iconCustomEmojiId] of Object.entries(icons)) {
  const topic = state.topics?.[key];
  if (!topic?.message_thread_id) throw new Error(`Missing saved Topic for ${key}`);
  const response = await fetch(`https://api.telegram.org/bot${token}/editForumTopic`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_thread_id: topic.message_thread_id,
      icon_custom_emoji_id: iconCustomEmojiId
    })
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`${key}: ${result.description || "editForumTopic failed"}`);
  topic.icon_custom_emoji_id = iconCustomEmojiId;
  updated.push({ key, message_thread_id: topic.message_thread_id, icon_custom_emoji_id: iconCustomEmojiId });
}

await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, updated }, null, 2));
