import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readFirstMessages } from "../templates.mjs";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const statePath = ".runtime/setup-state.json";
if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required");

const state = JSON.parse(await readFile(statePath, "utf8"));
if (String(state.chatId) !== String(chatId)) throw new Error("Target chat does not match the saved setup state");
const topic = state.topics?.read_first_disclaimer || state.topics?.read_first_dislaimer;
if (!topic?.message_thread_id) throw new Error("Read First Topic was not found in the saved setup state");

await call("unpinAllForumTopicMessages", { chat_id: chatId, message_thread_id: topic.message_thread_id });
const sent = [];
for (const item of readFirstMessages) {
  const message = item.photo
    ? await call("sendPhoto", { chat_id: chatId, message_thread_id: topic.message_thread_id, photo: path.resolve(item.photo), caption: item.caption || "" }, true)
    : await call("sendMessage", { chat_id: chatId, message_thread_id: topic.message_thread_id, text: item.text || "" });
  await call("pinChatMessage", { chat_id: chatId, message_id: message.message_id, disable_notification: true });
  sent.push(message.message_id);
}
console.log(JSON.stringify({ ok: true, threadId: topic.message_thread_id, sent }, null, 2));

async function call(method, payload, multipart = false) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const request = multipart ? { method: "POST", body: await formData(payload) } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
  const response = await fetch(url, request);
  const body = await response.json();
  if (!body.ok) throw new Error(`${method} failed: ${body.description || "Unknown error"}`);
  return body.result;
}

async function formData(payload) {
  const form = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    if (key === "photo") form.append("photo", new Blob([await readFile(value)]), path.basename(value));
    else form.append(key, String(value));
  }
  return form;
}
