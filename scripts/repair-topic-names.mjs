import { mkdir, readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { defaultTopicTemplate, topicDisplayName } from "../templates.mjs";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const dryRun = process.env.DRY_RUN !== "false";
const cleanupStatePath = process.env.YUBIT_TOPIC_CLEANUP_STATE || ".runtime/deleted-duplicate-topics.json";
const repairStatePath = process.env.YUBIT_TOPIC_REPAIR_STATE || ".runtime/repaired-topic-names.json";

if (!token || !chatId) {
  throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required");
}

const deletedThreadIds = await readDeletedThreadIds();
const repairState = await readRepairState();
const repairedThreadIds = new Set(repairState.repairedThreadIdsByChat?.[chatId] || []);
const expectedByOldName = new Map(
  defaultTopicTemplate.flatMap((topic) => {
    const expectedName = topicDisplayName(topic);
    return [
      [topic.name, expectedName],
      [`${topic.emoji ? `${topic.emoji} ` : ""}${topic.name}`, expectedName]
    ];
  })
);
// Older Demo/CryptoGuy groups were initialized with a different numbered
// order.  Match those exact legacy labels so the repair is deterministic and
// does not depend on Telegram's topic/thread ordering.
const legacySequenceRenames = new Map([
  ["2. Market Events", "3. Market Events"],
  ["3. Market Analysis - Crypto/Stocks/TradFi", "4. Market Analysis - Crypto/Stocks/TradFi"],
  ["4. YUBIT Updates", "7. YUBIT Updates"],
  ["5. 7-Day PNL Challenge", "5. Community Signal"],
  ["2. xxx's Trading Zone", "CryptoGuy Trading Zone"],
  ["7. xxx's Trading Zone", "CryptoGuy Trading Zone"],
  ["7. CryptoGuy Trading Zone", "CryptoGuy Trading Zone"]
]);
const updates = await telegram("getUpdates", {});
const edits = [];
const seenThreads = new Set();

for (const update of updates) {
  const message = update.message || update.channel_post;
  const topic = message?.forum_topic_created;
  const threadId = message?.message_thread_id;

  if (!topic || !threadId || message.chat?.id !== Number(chatId)) continue;
  if (deletedThreadIds.has(threadId) || repairedThreadIds.has(threadId) || seenThreads.has(threadId)) continue;

  const cleanTopic = cleanTopicName(topic.name);
  const cleanName = expectedByOldName.get(topic.name)
    || legacySequenceRenames.get(cleanTopic)
    || cleanTopic;
  if (!cleanName || cleanName === topic.name) continue;

  seenThreads.add(threadId);
  edits.push({ threadId, from: topic.name, to: cleanName });
}

console.log(JSON.stringify({ dryRun, edits }, null, 2));

for (const edit of edits) {
  if (dryRun) continue;
  await telegramWithRetry("editForumTopic", {
    chat_id: chatId,
    message_thread_id: edit.threadId,
    name: edit.to
  }).catch((error) => {
    const message = error.message.toLowerCase();
    if (message.includes("topic_not_modified") || message.includes("topic_id_invalid")) {
      return;
    }
    console.error(`editForumTopic skipped for ${edit.threadId}: ${error.message}`);
  });
  await markRepaired(edit.threadId);
  await sleep(5000);
}

async function readDeletedThreadIds() {
  try {
    const state = JSON.parse(await readFile(cleanupStatePath, "utf8"));
    return new Set(state.deletedThreadIdsByChat?.[chatId] || []);
  } catch {
    return new Set();
  }
}

async function readRepairState() {
  try {
    return JSON.parse(await readFile(repairStatePath, "utf8"));
  } catch {
    return { repairedThreadIdsByChat: {} };
  }
}

async function markRepaired(threadId) {
  repairState.repairedThreadIdsByChat = repairState.repairedThreadIdsByChat || {};
  const threadIds = new Set(repairState.repairedThreadIdsByChat[chatId] || []);
  threadIds.add(threadId);
  repairState.repairedThreadIdsByChat[chatId] = [...threadIds].sort((a, b) => Number(a) - Number(b));
  await mkdir(".runtime", { recursive: true });
  await writeFile(repairStatePath, JSON.stringify(repairState, null, 2));
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

async function telegramWithRetry(method, payload, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await telegram(method, payload);
    } catch (error) {
      lastError = error;
      const message = error.message.toLowerCase();
      if (message.includes("topic_not_modified") || message.includes("topic_id_invalid")) throw error;
      await sleep(5000 * attempt);
    }
  }
  throw lastError;
}

function cleanTopicName(value) {
  return String(value).replace(/^[^\p{Letter}\p{Number}]+/u, "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
