import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const chatId = process.env.TELEGRAM_CHAT_ID;
if (!chatId) throw new Error("TELEGRAM_CHAT_ID is required");

const groupConfigPath = ".runtime/group-config.json";
const setupStatePath = ".runtime/setup-state.json";
const config = JSON.parse(await readFile(groupConfigPath, "utf8"));
let found = false;
config.groups = (config.groups || []).map((group) => {
  if (String(group.chatId) !== String(chatId)) return group;
  found = true;
  return { ...group, topics: [], savedAt: new Date().toISOString() };
});
if (!found) throw new Error("Target group was not found in the local group list");
await writeFile(groupConfigPath, JSON.stringify(config, null, 2));
try {
  const state = JSON.parse(await readFile(setupStatePath, "utf8"));
  if (String(state.chatId) === String(chatId)) await writeFile(setupStatePath, JSON.stringify({ chatId: String(chatId), topics: {} }, null, 2));
} catch {}
console.log(JSON.stringify({ ok: true, chatId, message: "Local Topic cache cleared" }, null, 2));
