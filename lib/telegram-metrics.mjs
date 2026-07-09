const apiBase = "https://api.telegram.org/bot";

export async function getTelegramGroupMetrics(token) {
  if (!token) return { ok: false, error: "Missing bot token" };

  const updatesBody = await telegram(token, "getUpdates", {});
  const updates = updatesBody.result || [];
  const chats = collectChats(updates);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = nowSeconds - 7 * 24 * 60 * 60;
  const groups = [];

  for (const chat of chats.values()) {
    const chatUpdates = updates.filter((update) => messageFromUpdate(update)?.chat?.id === chat.id);
    const memberCount = await readMemberCount(token, chat.id);
    const messageEvents = chatUpdates
      .map(messageFromUpdate)
      .filter((message) => message?.message_id && !message.forum_topic_created);
    const sevenDayMessages = messageEvents.filter((message) => Number(message.date || 0) >= sevenDaysAgo);
    const activeUserIds = new Set(
      sevenDayMessages
        .map((message) => message.from)
        .filter((from) => from?.id && !from.is_bot)
        .map((from) => from.id)
    );
    const topicNames = new Set(
      chatUpdates
        .map(messageFromUpdate)
        .filter((message) => message?.forum_topic_created)
        .map((message) => message.forum_topic_created.name)
    );

    groups.push({
      id: chat.id,
      title: chat.title,
      type: chat.type,
      memberCount,
      visibleMessageCount: messageEvents.length,
      sevenDayActiveUsers: activeUserIds.size,
      sevenDayMessageCount: sevenDayMessages.length,
      topicCount: topicNames.size,
      status: memberCount == null ? "需检查" : "健康"
    });
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    sourceNote: "消息数和 7 天活跃用户基于 Bot API getUpdates 可见窗口统计，不代表 Telegram 全量历史。",
    groups
  };
}

function collectChats(updates) {
  const chats = new Map();
  for (const update of updates) {
    const message = messageFromUpdate(update);
    const chat = message?.chat;
    if (!chat || !["group", "supergroup", "channel"].includes(chat.type)) continue;
    chats.set(chat.id, {
      id: chat.id,
      type: chat.type,
      title: chat.title || chat.username || String(chat.id)
    });
  }
  return chats;
}

function messageFromUpdate(update) {
  return update.message || update.channel_post || update.edited_message || update.edited_channel_post || update.my_chat_member;
}

async function readMemberCount(token, chatId) {
  const response = await telegram(token, "getChatMemberCount", { chat_id: chatId }).catch(() => null);
  return response?.result ?? null;
}

async function telegram(token, method, payload) {
  const response = await fetch(`${apiBase}${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!body.ok) throw new Error(`${method} failed: ${body.description || "Unknown error"}`);
  return body;
}
