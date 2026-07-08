import fs from "node:fs/promises";
import process from "node:process";

const apiBase = "https://api.telegram.org/bot";
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const configPath = process.env.YUBIT_TG_CONFIG || new URL("./winkey-agent-topics.config.json", import.meta.url);
const delayMs = Number(process.env.TELEGRAM_DELAY_MS || 3500);

if (!token || !chatId) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID.");
  process.exit(1);
}

const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const applied = [];

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
  const editPayload = {
    chat_id: chatId,
    message_thread_id: topic.message_thread_id,
    name: topic.name
  };

  if (topic.icon_custom_emoji_id) {
    editPayload.icon_custom_emoji_id = topic.icon_custom_emoji_id;
  }

  await call("editForumTopic", editPayload);

  await call("unpinAllForumTopicMessages", {
    chat_id: chatId,
    message_thread_id: topic.message_thread_id
  });

  const message = await call("sendMessage", {
    chat_id: chatId,
    message_thread_id: topic.message_thread_id,
    text: topic.announcement,
    parse_mode: config.defaultParseMode || "HTML",
    disable_web_page_preview: true
  });

  await call("pinChatMessage", {
    chat_id: chatId,
    message_id: message.message_id,
    disable_notification: true
  });

  applied.push({
    name: topic.name,
    message_thread_id: topic.message_thread_id,
    announcement_message_id: message.message_id
  });

  await sleep(delayMs);
}

console.log(JSON.stringify({ ok: true, applied }, null, 2));

async function call(method, payload) {
  while (true) {
    let response;

    try {
      response = await fetch(`${apiBase}${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      await sleep(5000);
      continue;
    }

    const body = await response.json();

    if (body.ok) return body.result;
    const description = (body.description || "").toLowerCase();
    if (description.includes("not modified") || description.includes("not_modified")) return {};

    const retryAfter = body.parameters?.retry_after;
    if (retryAfter) {
      await sleep((retryAfter + 2) * 1000);
      continue;
    }

    throw new Error(`${method} failed: ${body.description || "Unknown Telegram API error"}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
