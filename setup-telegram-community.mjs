import fs from "node:fs/promises";
import process from "node:process";
import { createHash } from "node:crypto";
import { readJson, writeJson } from "./lib/json-store.js";
import { resolveTopicProgress, setupTimingDefaults, topicActionPlan } from "./lib/telegram-setup-state.mjs";
import { resolveForumTopicIconId } from "./lib/telegram-topic-icons.mjs";

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
const telegramDelayMs = Number(process.env.TELEGRAM_DELAY_MS || setupTimingDefaults.apiDelayMs);
const telegramMessageDelayMs = Number(process.env.TELEGRAM_MESSAGE_DELAY_MS || setupTimingDefaults.messageDelayMs);
const topicDelayMs = Number(process.env.TELEGRAM_TOPIC_DELAY_MS || setupTimingDefaults.topicDelayMs);
const telegramNetworkMaxAttempts = Math.max(1, Number.parseInt(process.env.TELEGRAM_NETWORK_MAX_ATTEMPTS || "3", 10) || 3);
const telegramRequestTimeoutMs = Math.max(1000, Number.parseInt(process.env.TELEGRAM_REQUEST_TIMEOUT_MS || "10000", 10) || 10000);
const stateKey = process.env.YUBIT_SETUP_STATE_KEY || `setup-states/${String(chatId).replace(/[^0-9-]/g, "")}.json`;
const telegramReadMethods = new Set(["getMe", "getChat", "getChatMember", "getForumTopicIconStickers"]);

const createdTopics = [];
const warnings = [];
// A dry-run must never persist its synthetic topic IDs, otherwise a later real
// run could mistake them for real Telegram topics.
const state = dryRun ? { chatId, topics: {} } : await readState();

const me = await call("getMe", {});
const chat = await call("getChat", { chat_id: chatId });
assertForumReady(chat);
await assertBotTopicPermissions(me);
const availableTopicIcons = await optionalCall("getForumTopicIconStickers", {}) || [];

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
  const progress = resolveTopicProgress(state.topics, topic);
  const topicKey = progress.topicKey || topic.key || slug(topic.name);
  const desiredTopic = {
    ...topic,
    iconCustomEmojiId: resolveForumTopicIconId(topic, availableTopicIcons),
    contentVersion: structuredContentVersion(topic)
  };
  let createdNow = false;
  let topicState = progress.topicState;
  if (progress.migratedKeys.length) {
    state.topics = { ...(state.topics || {}) };
    for (const legacyKey of progress.migratedKeys) delete state.topics[legacyKey];
    state.topics[topicKey] = { ...topicState };
    if (!dryRun) await writeState(state);
  }
  let actions = topicActionPlan(topicState, desiredTopic);

  // Telegram invalidates every stored message_thread_id when Topics are
  // disabled/re-enabled or a topic is deleted. Verify resumed state before
  // trusting it so a stale state file cannot produce a false-success run.
  if (!dryRun && !actions.create) {
    const topicStillExists = await verifySavedTopic(topicState, desiredTopic);
    if (!topicStillExists) {
      const staleThreadId = topicState.message_thread_id;
      state.topics = { ...(state.topics || {}) };
      delete state.topics[topicKey];
      await writeState(state);
      topicState = {};
      actions = topicActionPlan(topicState, desiredTopic);
      const warning = `stale topic state removed and will be rebuilt: ${desiredTopic.name} (thread ${staleThreadId})`;
      warnings.push(warning);
      console.error(warning);
    } else {
      topicState.configuredName = desiredTopic.name;
      topicState.configuredIconCustomEmojiId = desiredTopic.iconCustomEmojiId;
      topicState.verifiedAt = new Date().toISOString();
      await saveTopicProgress(topicKey, topicState);
      actions = topicActionPlan(topicState, desiredTopic);
    }
  }

  if (actions.create) {
    const createPayload = {
      chat_id: chatId,
      name: desiredTopic.name
    };
    if (desiredTopic.iconCustomEmojiId) createPayload.icon_custom_emoji_id = desiredTopic.iconCustomEmojiId;
    const forumTopic = await call("createForumTopic", createPayload);
    topicState = {
      ...topicState,
      ...forumTopic,
      configuredName: desiredTopic.name,
      configuredIconCustomEmojiId: desiredTopic.iconCustomEmojiId,
      imageSent: false,
      announcementSent: false,
      pinned: false,
      contentVersion: "",
      contentDraftVersion: "",
      contentMessageIds: [],
      pinnedContentMessageIds: [],
      closed: false,
      verifiedAt: new Date().toISOString()
    };
    createdNow = true;
    await saveTopicProgress(topicKey, topicState);
  } else {
    warnings.push(`topic reused from state: ${desiredTopic.name}`);
    console.error(`topic reused from state: ${desiredTopic.name}`);
  }

  actions = topicActionPlan(topicState, desiredTopic);

  if (actions.configure) {
    const editPayload = {
      chat_id: chatId,
      message_thread_id: topicState.message_thread_id,
      name: desiredTopic.name
    };
    if (desiredTopic.iconCustomEmojiId) editPayload.icon_custom_emoji_id = desiredTopic.iconCustomEmojiId;
    await call("editForumTopic", editPayload);
    topicState.configuredName = desiredTopic.name;
    topicState.configuredIconCustomEmojiId = desiredTopic.iconCustomEmojiId;
    topicState.verifiedAt = new Date().toISOString();
    await saveTopicProgress(topicKey, topicState);
  }

  actions = topicActionPlan(topicState, desiredTopic);

  createdTopics.push({
    key: topic.key,
    name: desiredTopic.name,
    icon_custom_emoji_id: desiredTopic.iconCustomEmojiId || null,
    message_thread_id: topicState?.message_thread_id ?? null
  });

  await sleep(topicDelayMs);

  if (actions.syncContent) {
    const contentVersion = desiredTopic.contentVersion;
    const contentMessages = desiredTopic.messages;
    if (topicState.contentDraftVersion !== contentVersion) {
      if (!createdNow) {
        await call("unpinAllForumTopicMessages", {
          chat_id: chatId,
          message_thread_id: topicState.message_thread_id
        });
      }
      topicState.contentDraftVersion = contentVersion;
      topicState.contentVersion = "";
      topicState.contentMessageIds = [];
      topicState.pinnedContentMessageIds = [];
      await saveTopicProgress(topicKey, topicState);
    }

    for (let index = 0; index < contentMessages.length; index += 1) {
      const contentMessage = contentMessages[index];
      let messageId = topicState.contentMessageIds?.[index] || null;
      if (!messageId) {
        const sent = await sendStructuredContentMessage(contentMessage, topicState.message_thread_id);
        messageId = sent?.message_id ?? null;
        if (!messageId) throw new Error(`Structured content message ${index + 1} did not return a message_id.`);
        topicState.contentMessageIds = [...(topicState.contentMessageIds || [])];
        topicState.contentMessageIds[index] = messageId;
        await saveTopicProgress(topicKey, topicState);
      }

      if (contentMessage.pin !== false && !(topicState.pinnedContentMessageIds || []).includes(messageId)) {
        await call("pinChatMessage", {
          chat_id: chatId,
          message_id: messageId,
          disable_notification: true
        });
        topicState.pinnedContentMessageIds = [...new Set([...(topicState.pinnedContentMessageIds || []), messageId])];
        await saveTopicProgress(topicKey, topicState);
      }
    }

    topicState.contentVersion = contentVersion;
    await saveTopicProgress(topicKey, topicState);
  }

  if (actions.sendImage) {
    await call("sendPhoto", {
        chat_id: chatId,
        message_thread_id: topicState?.message_thread_id,
        photo: topic.imageUrl,
        caption: `<b>${escapeHtml(topic.name)}</b>`,
        parse_mode: config.defaultParseMode || "HTML"
      });
    topicState.imageSent = true;
    await saveTopicProgress(topicKey, topicState);
  }

  if (actions.sendAnnouncement) {
    const message = await call("sendMessage", {
      chat_id: chatId,
      message_thread_id: topicState?.message_thread_id,
      text: topic.announcement,
      parse_mode: config.defaultParseMode || "HTML",
      disable_web_page_preview: true
    });
    topicState.announcementSent = true;
    topicState.announcementMessageId = message?.message_id ?? null;
    await saveTopicProgress(topicKey, topicState);
  }

  if (actions.pin && topicState.announcementMessageId) {
    const pinned = await optionalCall("pinChatMessage", {
      chat_id: chatId,
      message_id: topicState.announcementMessageId,
      disable_notification: true
    });
    if (pinned !== null) {
      topicState.pinned = true;
      await saveTopicProgress(topicKey, topicState);
    }
  }

  if (actions.close) {
    await call("closeForumTopic", {
      chat_id: chatId,
      message_thread_id: topicState?.message_thread_id
    });
    topicState.closed = true;
    await saveTopicProgress(topicKey, topicState);
  }

  await sleep(topicDelayMs);
}

console.log(JSON.stringify({ ok: true, dryRun, createdTopics, warnings }, null, 2));

async function call(method, payload) {
  // A safe check still has to read Telegram. Only mutating methods are
  // simulated; otherwise a missing chat or missing permission would look valid.
  if (dryRun && !telegramReadMethods.has(method)) {
    console.log(`[dry-run] ${method}`, JSON.stringify(redact(payload)));
    if (method === "createForumTopic") {
      return { message_thread_id: Math.floor(Math.random() * 9000) + 1000 };
    }
    if (method === "sendMessage" || method === "sendPhoto") {
      return { message_id: Math.floor(Math.random() * 9000) + 1000 };
    }
    return {};
  }

  let networkAttempts = 0;
  while (true) {
    let body;
    try {
      const response = await fetch(`${apiBase}${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(telegramRequestTimeoutMs)
      });
      body = await response.json();
    } catch (error) {
      networkAttempts += 1;
      if (networkAttempts >= telegramNetworkMaxAttempts) {
        throw new Error(`${method} network error after ${networkAttempts} attempt(s): ${error.message}`);
      }
      console.error(`${method} network error: ${error.message}. Retrying after 10s.`);
      await sleep(10000);
      continue;
    }

    if (body.ok) {
      const delayMs = method === "sendMessage" || method === "sendPhoto"
        ? telegramMessageDelayMs
        : telegramDelayMs;
      await sleep(delayMs);
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

async function sendStructuredContentMessage(message, messageThreadId) {
  const common = {
    chat_id: chatId,
    message_thread_id: messageThreadId
  };
  if (message.type === "photo") {
    return call("sendPhoto", {
      ...common,
      photo: message.photo,
      ...(message.caption ? { caption: message.caption } : {}),
      ...(Array.isArray(message.captionEntities) ? { caption_entities: message.captionEntities } : {})
    });
  }
  if (message.type === "text") {
    return call("sendMessage", {
      ...common,
      text: message.text,
      ...(Array.isArray(message.entities) ? { entities: message.entities } : {}),
      disable_web_page_preview: true
    });
  }
  throw new Error(`Unsupported structured content message type: ${message.type}`);
}

async function verifySavedTopic(topicState, desiredTopic) {
  const payload = {
    chat_id: chatId,
    message_thread_id: topicState.message_thread_id,
    name: desiredTopic.name
  };
  if (desiredTopic.iconCustomEmojiId) payload.icon_custom_emoji_id = desiredTopic.iconCustomEmojiId;
  try {
    await call("editForumTopic", payload);
    return true;
  } catch (error) {
    if (/TOPIC_ID_INVALID|message thread not found|topic[^\n]*not found/i.test(String(error?.message || error))) {
      return false;
    }
    throw error;
  }
}

function structuredContentVersion(topic) {
  const messages = Array.isArray(topic?.messages) ? topic.messages : [];
  if (!messages.length) return "";
  return String(topic.contentVersion || `content-${createHash("sha256").update(JSON.stringify(messages)).digest("hex").slice(0, 16)}`);
}

function redact(payload) {
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, key.toLowerCase().includes("token") ? "[redacted]" : value])
  );
}

async function readState() {
  const parsed = await readJson(stateKey, null);
  if (parsed?.chatId === chatId) return parsed;
  return { chatId, topics: {} };
}

async function writeState(nextState) {
  await writeJson(stateKey, nextState);
}

async function saveTopicProgress(topicKey, topicState) {
  state.topics = { ...(state.topics || {}), [topicKey]: { ...topicState } };
  if (!dryRun) await writeState(state);
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
  if (dryRun) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function assertForumReady(chat) {
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
  if (!me?.id) return;
  const member = await call("getChatMember", {
    chat_id: chatId,
    user_id: me.id
  });
  if (member?.status !== "administrator" && member?.status !== "creator") {
    exitWithHelp(`Admin bot is currently "${member?.status || "unknown"}", not an administrator.

Please promote the bot to admin before running setup.`);
  }
  const missingPermissions = member.status === "creator" ? [] : [
    [member.can_manage_topics, "Manage Topics"],
    [member.can_pin_messages, "Pin Messages"],
    [member.can_change_info, "Change Group Info"]
  ].filter(([granted]) => granted !== true).map(([, label]) => label);
  if (missingPermissions.length) {
    exitWithHelp(`Admin bot is missing required permissions: ${missingPermissions.join(", ")}.

Please open Telegram group admin settings for ${me.username ? `@${me.username}` : "the admin bot"} and enable:
  - Manage Topics
  - Pin Messages
  - Change Group Info
  - Send Messages

Then run setup again.`);
  }
}
