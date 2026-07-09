import { existsSync, readFileSync } from "node:fs";
import { NextResponse } from "next/server";

const apiBase = "https://api.telegram.org/bot";

export async function GET() {
  const tokens = readTokenEnv(".env.telegram-tokens.local");
  const botRoles = [
    { name: "YUBITadmin", role: "群管理 / 建群 / 公告", token: tokens.YUBITADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN },
    { name: "Trader1", role: "新闻 / 信号推送", token: tokens.TRADER1_BOT_TOKEN || process.env.TRADER1_BOT_TOKEN },
    { name: "MOD1", role: "人工管理辅助", token: tokens.MOD1_BOT_TOKEN || process.env.MOD1_BOT_TOKEN },
    { name: "Jack", role: "市场讨论", token: tokens.JACK_BOT_TOKEN || process.env.JACK_BOT_TOKEN },
    { name: "Tony", role: "风险讨论", token: tokens.TONY_BOT_TOKEN || process.env.TONY_BOT_TOKEN }
  ];
  const bots = [];
  for (const bot of botRoles) {
    if (!bot.token) {
      bots.push({ name: bot.name, role: bot.role, status: "未配置", username: "", groups: [] });
      continue;
    }
    try {
      const me = await telegram(bot.token, "getMe", {});
      const updates = await telegram(bot.token, "getUpdates", {});
      bots.push({ name: bot.name, role: bot.role, status: "在线", username: me.result?.username || "", groups: collectBotChats(updates.result || []) });
    } catch (error) {
      bots.push({ name: bot.name, role: bot.role, status: "需检查", username: "", groups: [], error: error.message });
    }
  }
  return NextResponse.json({ ok: true, generatedAt: new Date().toISOString(), bots });
}

function collectBotChats(updates) {
  const chats = new Map();
  for (const update of updates) {
    for (const message of [update.message, update.channel_post, update.edited_message, update.edited_channel_post, update.my_chat_member].filter(Boolean)) {
      const chat = message.chat;
      if (!chat || !["group", "supergroup", "channel"].includes(chat.type)) continue;
      chats.set(String(chat.id), {
        id: chat.id,
        title: chat.title || chat.username || String(chat.id),
        type: chat.type,
        canUseTopics: chat.type === "supergroup"
      });
    }
  }
  return [...chats.values()];
}

async function telegram(token, method, payload) {
  const response = await fetch(`${apiBase}${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!body.ok) throw new Error(body.description || `${method} failed`);
  return body;
}

function readTokenEnv(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}
