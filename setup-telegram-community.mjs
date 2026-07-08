import fs from "node:fs/promises";
import process from "node:process";

const apiBase = "https://api.telegram.org/bot";
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const configPath = process.env.YUBIT_TG_CONFIG || new URL("./telegram-community.config.json", import.meta.url);

if (!token) {
  exitWithHelp("Missing TELEGRAM_BOT_TOKEN.");
}

if (!chatId) {
  exitWithHelp("Missing TELEGRAM_CHAT_ID.");
}

const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const dryRun = String(process.env.DRY_RUN ?? config.dryRun ?? "true") !== "false";

const createdTopics = [];

await call("getMe", {});
await call("getChat", { chat_id: chatId });

if (config.chatTitle) {
  await call("setChatTitle", { chat_id: chatId, title: config.chatTitle });
}

if (config.chatDescription) {
  await call("setChatDescription", { chat_id: chatId, description: config.chatDescription });
}

if (config.generalTopicName) {
  await call("editGeneralForumTopic", { chat_id: chatId, name: config.generalTopicName });
}

for (const topic of config.topics ?? []) {
  const forumTopic = await call("createForumTopic", {
    chat_id: chatId,
    name: topic.name
  });

  createdTopics.push({
    key: topic.key,
    name: topic.name,
    message_thread_id: forumTopic?.message_thread_id ?? null
  });

  if (!topic.announcement) continue;

  const message = await call("sendMessage", {
    chat_id: chatId,
    message_thread_id: forumTopic?.message_thread_id,
    text: topic.announcement,
    parse_mode: config.defaultParseMode || "HTML",
    disable_web_page_preview: true
  });

  if (topic.pin && message?.message_id) {
    await call("pinChatMessage", {
      chat_id: chatId,
      message_id: message.message_id,
      disable_notification: true
    });
  }
}

console.log(JSON.stringify({ ok: true, dryRun, createdTopics }, null, 2));

async function call(method, payload) {
  if (dryRun) {
    console.log(`[dry-run] ${method}`, JSON.stringify(redact(payload)));
    if (method === "createForumTopic") {
      return { message_thread_id: Math.floor(Math.random() * 9000) + 1000 };
    }
    if (method === "sendMessage") {
      return { message_id: Math.floor(Math.random() * 9000) + 1000 };
    }
    return {};
  }

  const response = await fetch(`${apiBase}${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  const body = await response.json();

  if (!body.ok) {
    const description = body.description || "Unknown Telegram API error";
    throw new Error(`${method} failed: ${description}`);
  }

  return body.result;
}

function redact(payload) {
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, key.toLowerCase().includes("token") ? "[redacted]" : value])
  );
}

function exitWithHelp(message) {
  console.error(`${message}

Usage:
  TELEGRAM_BOT_TOKEN="123:abc" TELEGRAM_CHAT_ID="-1001234567890" DRY_RUN=true node setup-telegram-community.mjs

To really apply changes:
  TELEGRAM_BOT_TOKEN="123:abc" TELEGRAM_CHAT_ID="-1001234567890" DRY_RUN=false node setup-telegram-community.mjs

Required Telegram setup:
  1. Add the bot to the target supergroup.
  2. Enable Topics in the group settings.
  3. Promote the bot to admin.
  4. Give it Manage Topics, Pin Messages, Change Group Info, and Send Messages permissions.
`);
  process.exit(1);
}
