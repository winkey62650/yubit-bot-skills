import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const threadId = process.env.TELEGRAM_THREAD_ID;
const messageId = process.env.TELEGRAM_MESSAGE_ID;
const title = process.env.MARKET_EVENT_TITLE;
const imagePath = process.env.MARKET_EVENT_IMAGE || "assets/market-events/market-event-cover.jpg";
const highlights = JSON.parse(process.env.MARKET_EVENT_ITEMS_JSON || "[]");

if (!token || !chatId || !threadId || !title || !highlights.length) {
  throw new Error("TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_THREAD_ID, MARKET_EVENT_TITLE, and MARKET_EVENT_ITEMS_JSON are required");
}

const caption = [
  `📌 <b>${escapeHtml(title)}</b>`,
  "<i>Markets · Crypto · Macro</i>",
  "",
  ...highlights.map((item, index) => renderHighlight(item, index))
].join("\n\n");
if (caption.length > 1024) throw new Error(`Market Event caption is too long for a Telegram photo (${caption.length}/1024)`);

const response = messageId
  ? await fetch(`https://api.telegram.org/bot${token}/editMessageCaption`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: Number(messageId), caption, parse_mode: "HTML" })
    })
  : await sendPhoto();

const result = await response.json();
if (!result.ok) throw new Error(result.description || "sendPhoto failed");
console.log(JSON.stringify({ ok: true, messageId: result.result.message_id, threadId: Number(threadId), captionLength: caption.length, edited: Boolean(messageId) }, null, 2));

async function sendPhoto() {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("message_thread_id", String(threadId));
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("photo", new Blob([await readFile(imagePath)]), path.basename(imagePath));
  return fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form });
}

function renderHighlight(item, index) {
  if (typeof item === "string") return `<b>${index + 1}. ${escapeHtml(item)}</b>`;
  const heading = escapeHtml(item.heading || `Highlight ${index + 1}`);
  const detail = escapeHtml(item.detail || "");
  return `<b>${index + 1}. ${heading}</b>${detail ? `\n${detail}` : ""}`;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
