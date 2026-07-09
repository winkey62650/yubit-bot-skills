import { mkdir, readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { defaultTopicTemplate } from "../templates.mjs";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const dryRun = process.env.DRY_RUN !== "false";
const templatePath = process.env.TOPIC_TEMPLATE_PATH || ".runtime/latest-topic-template.json";
const cleanupStatePath = process.env.YUBIT_TOPIC_CLEANUP_STATE || ".runtime/deleted-duplicate-topics.json";
const deleteTopics = process.env.DELETE_DUPLICATE_TOPICS !== "false";

if (!token || !chatId) {
  throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required");
}

const template = await readTemplate();
const expectedNames = new Set(template.map((topic) => topic.name));
const cleanupState = await readCleanupState();
const deletedThreadIds = new Set(cleanupState.deletedThreadIdsByChat?.[chatId] || []);
const updates = await telegram("getUpdates", {});
const seen = new Map();
const rawDuplicates = [];

for (const update of updates) {
  const message = update.message || update.channel_post;
  const topic = message?.forum_topic_created;
  if (!topic || message.chat?.id !== Number(chatId)) continue;
  const name = topic.name;
  if (!expectedNames.has(name)) continue;
  const threadId = message.message_thread_id;
  if (!seen.has(name)) {
    seen.set(name, threadId);
  } else {
    rawDuplicates.push({ name, threadId });
  }
}

const duplicates = rawDuplicates.filter((duplicate) => !deletedThreadIds.has(duplicate.threadId));
const skippedDeleted = rawDuplicates.length - duplicates.length;

console.log(JSON.stringify({ dryRun, action: deleteTopics ? "deleteForumTopic" : "closeForumTopic", duplicates }, null, 2));

for (const duplicate of duplicates) {
  if (dryRun) continue;
  await telegram(deleteTopics ? "deleteForumTopic" : "closeForumTopic", {
    chat_id: chatId,
    message_thread_id: duplicate.threadId
  }).catch(async (error) => {
    if (!deleteTopics) throw error;
    console.error(`deleteForumTopic skipped: ${error.message}. Closing topic instead.`);
    await telegram("closeForumTopic", {
      chat_id: chatId,
      message_thread_id: duplicate.threadId
    });
  });
  await markDeleted(duplicate.threadId);
  await sleep(5000);
}

if (skippedDeleted > 0) {
  console.error(`skipped ${skippedDeleted} duplicate topic records that were already cleaned`);
}

async function readTemplate() {
  try {
    return JSON.parse(await readFile(templatePath, "utf8"));
  } catch {
    return defaultTopicTemplate.map((topic) => ({
      ...topic,
      name: `${topic.emoji ? `${topic.emoji} ` : ""}${topic.name}`
    }));
  }
}

async function readCleanupState() {
  try {
    return JSON.parse(await readFile(cleanupStatePath, "utf8"));
  } catch {
    return { deletedThreadIdsByChat: {} };
  }
}

async function markDeleted(threadId) {
  cleanupState.deletedThreadIdsByChat = cleanupState.deletedThreadIdsByChat || {};
  const threadIds = new Set(cleanupState.deletedThreadIdsByChat[chatId] || []);
  threadIds.add(threadId);
  cleanupState.deletedThreadIdsByChat[chatId] = [...threadIds].sort((a, b) => Number(a) - Number(b));
  await mkdir(".runtime", { recursive: true });
  await writeFile(cleanupStatePath, JSON.stringify(cleanupState, null, 2));
}

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!body.ok) throw new Error(`${method} failed: ${body.description || "Unknown error"}`);
  return body.result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
