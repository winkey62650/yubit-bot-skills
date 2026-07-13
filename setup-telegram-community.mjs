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
const telegramDelayMs = Number(process.env.TELEGRAM_DELAY_MS || 8000);
const topicDelayMs = Number(process.env.TELEGRAM_TOPIC_DELAY_MS || 12000);
const statePath = process.env.YUBIT_SETUP_STATE || ".runtime/setup-state.json";

const createdTopics = [];
const warnings = [];
const state = await readState();

const me = await call("getMe", {});
const chat = await call("getChat", { chat_id: chatId });
assertForumReady(chat);
await assertBotTopicPermissions(me);

if (config.chatTitle) {
  await optionalCall("setChatTitle", { chat_id: chatId, title: config.chatTitle });
}

if (config.chatDescription) {
  await optionalCall("setChatDescription", { chat_id: chatId, description: config.chatDescription });
}

if (config.generalTopicName) {
  await optionalCall("editGeneralForumTopic", { chat_id: chatId, name: config.generalTopicName });
}

for (const topic of config.topics ?? []) {
  const topicKey = topic.key || slug(topic.name);
  let forumTopic = state.topics?.[topicKey];

  if (!forumTopic) {
    forumTopic = await call("createForumTopic", {
      chat_id: chatId,
      name: topic.name
    });
    state.topics = { ...(state.topics || {}), [topicKey]: forumTopic };
    await writeState(state);
  } else {
    warnings.push(`topic reused from state: ${topic.name}`);
    console.error(`topic reused from state: ${topic.name}`);
  }

  createdTopics.push({
    key: topic.key,
    name: topic.name,
    message_thread_id: forumTopic?.message_thread_id ?? null
  });

  await sleep(topicDelayMs);

  if (!topic.announcement) continue;

  const message = await call("sendMessage", {
    chat_id: chatId,
    message_thread_id: forumTopic?.message_thread_id,
    text: topic.announcement,
    parse_mode: config.defaultParseMode || "HTML",
    disable_web_page_preview: true
  });

  if (topic.pin && message?.message_id) {
    await optionalCall("pinChatMessage", {
      chat_id: chatId,
      message_id: message.message_id,
      disable_notification: true
    });
  }

  if (topic.close) {
    await call("closeForumTopic", {
      chat_id: chatId,
      message_thread_id: forumTopic?.message_thread_id
    });
  }

  await sleep(topicDelayMs);
}

console.log(JSON.stringify({ ok: true, dryRun, createdTopics, warnings }, null, 2));

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

  while (true) {
    let body;
    try {
      const response = await fetch(`${apiBase}${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      body = await response.json();
    } catch (error) {
      console.error(`${method} network error: ${error.message}. Retrying after 10s.`);
      await sleep(10000);
      continue;
    }

    if (body.ok) {
      await sleep(telegramDelayMs);
      return body.result;
    }

    const descriptionLower = String(body.description || "").toLowerCase();
    if (descriptionLower.includes("not modified") || descriptionLower.includes("topic_not_modified")) {
      console.error(`${method} skipped: ${body.description}`);
      return {};
    }

    const retryAfter = body.parameters?.retry_after;
    if (retryAfter) {
      const waitMs = (Number(retryAfter) + 2) * 1000;
      console.error(`${method} rate limited. Retrying after ${retryAfter}s.`);
      await sleep(waitMs);
      continue;
    }

    const description = body.description || "Unknown Telegram API error";
    throw new Error(`${method} failed: ${description}`);
  }
}

async function optionalCall(method, payload) {
  try {
    return await call(method, payload);
  } catch (error) {
    const warning = `${method} skipped: ${error.message}`;
    warnings.push(warning);
    console.error(warning);
    return null;
  }
}

function redact(payload) {
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, key.toLowerCase().includes("token") ? "[redacted]" : value])
  );
}

async function readState() {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (parsed.chatId === chatId) return parsed;
  } catch {}
  return { chatId, topics: {} };
}

async function writeState(nextState) {
  const dir = statePath.split("/").slice(0, -1).join("/");
  if (dir) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(nextState, null, 2));
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "topic";
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertForumReady(chat) {
  if (dryRun && !chat?.type) return;
  const type = chat?.type || "unknown";
  if (type !== "supergroup") {
    exitWithHelp(`Target chat is "${type}", not a forum supergroup.

This setup needs Telegram Topics. Please:
  1. Open the target group in Telegram.
  2. Convert/upgrade it to a supergroup if Telegram has not done that yet.
  3. Enable Topics in group settings.
  4. Make sure the admin bot is an admin with Manage Topics permission.
  5. Send one message in the group, then click "配置群刷新" in the console.`);
  }

  if (chat.is_forum !== true) {
    exitWithHelp(`Target supergroup has not enabled Topics yet.

Please enable Topics in Telegram group settings, then run setup again.`);
  }
}

async function assertBotTopicPermissions(me) {
  if (dryRun || !me?.id) return;
  const member = await call("getChatMember", {
    chat_id: chatId,
    user_id: me.id
  });
  if (member?.status !== "administrator" && member?.status !== "creator") {
    exitWithHelp(`Admin bot is currently "${member?.status || "unknown"}", not an administrator.

Please promote the bot to admin before running setup.`);
  }
  if (member.status !== "creator" && member.can_manage_topics !== true) {
    exitWithHelp(`Admin bot is missing Manage Topics permission.

Please open Telegram group admin settings for ${me.username ? `@${me.username}` : "the admin bot"} and enable:
  - Manage Topics
  - Pin Messages
  - Change Group Info
  - Send Messages

Then run setup again.`);
  }
}
