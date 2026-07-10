import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { getTelegramGroupMetrics } from "./lib/telegram-metrics.mjs";
import { cryptoNewsSources } from "./crypto-news-sources.mjs";
import { defaultDailyReport, formatDailyReport } from "./daily-report.mjs";

const port = Number(process.env.PORT || 4173);
const root = process.env.YUBIT_ROOT || process.cwd();
const groupConfigPath = join(root, ".runtime", "group-config.json");
const newsConfigsPath = join(root, ".runtime", "news-configs.json");
const newsStatusPath = join(root, ".runtime", "news-status.json");
const broadcastRulesPath = join(root, ".runtime", "broadcast-rules.json");
const broadcastOffsetPath = join(root, ".runtime", "broadcast-offset.json");
const broadcastStatusPath = join(root, ".runtime", "broadcast-status.json");
const socialPackagesPath = join(root, ".runtime", "social-packages.json");
const socialStatusPath = join(root, ".runtime", "social-status.json");
const demoChatId = process.env.DEMO_TELEGRAM_CHAT_ID || "-1003710405969";
const demoTestTopicPath = join(root, ".runtime", "demo-test-topic.json");
const fallbackNewsImageUrl = "https://images.unsplash.com/photo-1640340434855-6084b1f4901c?auto=format&fit=crop&w=1200&q=80";
const defaultBindings = [
  { id: "news-market-events", group: "YUBIT test", topic: "Market Events", type: "新闻配置", config: "Crypto News Default", bot: "Trader1", status: "已启用" },
  { id: "signal-market-analysis", group: "YUBIT test", topic: "Market Analysis - Crypto/Stocks/TradFi", type: "信号配置", config: "Futures SMA", bot: "Trader1", status: "已启用" },
  { id: "broadcast-market-events", group: "YUBIT test", topic: "Market Events", type: "广播", config: "Demo 群全部消息广播", bot: "YUBITadmin", frequency: "实时", status: "已启用" },
  { id: "ricky-social", group: "YUBIT test", topic: "Ricky's Trading Zone", type: "代理社媒", config: "Ricky 社媒转发包", bot: "YUBITadmin", frequency: "每 5 分钟", status: "已启用" },
  { id: "official-updates", group: "YUBIT Winkey Main", topic: "YUBIT Updates", type: "新闻配置", config: "Official Updates", bot: "YUBITadmin", status: "待检查" }
];

const scriptMap = {
  newGroup: { label: "New Group Setup", command: ["scripts/new-group-setup.mjs"] },
  cleanupTopics: { label: "Cleanup Duplicate Topics", command: ["scripts/close-duplicate-topics.mjs"] },
  repairTopicNames: { label: "Repair Topic Names", command: ["scripts/repair-topic-names.mjs"] },
  tokens: { label: "Token Settings", command: ["scripts/token-settings.mjs"] },
  cardSender: { label: "Card Sender", command: ["scripts/card-sender.mjs"] },
  futuresCard: { label: "Futures Card", command: ["binance-futures-sma-signal.mjs"] },
  tradfiCard: { label: "TradFi Card", command: ["tradfi-market-signal.mjs"] },
  newsCard: { label: "News Card", command: ["news-poster.mjs"] },
  dailyReport: { label: "Daily Morning Brief", command: ["daily-report.mjs"] },
  dailyChartAnalysis: { label: "Daily Chart Analysis", command: ["daily-chart-analysis.mjs"] },
  smartMoneyMonitor: { label: "Smart Money Monitor", command: ["smart-money-monitor.mjs"] },
  cycle15m: { label: "15m Cycle", command: ["run-15m-cycle.mjs"] },
  bulkSend: { label: "Bulk Send", command: ["scripts/bulk-send.mjs"] },
  monitorHealth: { label: "Health Monitor", command: ["monitor-health-to-lark.mjs"] }
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "POST" && url.pathname === "/api/scripts") {
      const body = await readJson(request);
      const result = await runScript(body);
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/chats") {
      const result = await discoverChats();
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/group-metrics") {
      const result = await readGroupMetrics();
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/bot-groups") {
      const result = await readBotGroups();
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/news-source-preview") {
      const body = await readJson(request);
      const result = await previewNewsSource(body);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/news-source-test") {
      const body = await readJson(request);
      const result = await testNewsSource(body);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/news-configs") {
      const result = await readNewsConfigs();
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/news-status") {
      const result = readNewsStatus();
      sendJson(response, result.ok ? 200 : 500, result);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/daily-report-config") {
      const result = await readDailyReportConfig();
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/daily-report-config") {
      const body = await readJson(request);
      const result = await saveDailyReportConfig(body);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/daily-chart-analysis-config") {
      const result = await readDailyChartAnalysisConfig();
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/daily-chart-analysis-config") {
      const body = await readJson(request);
      const result = await saveDailyChartAnalysisConfig(body);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/news-configs") {
      const body = await readJson(request);
      const result = await saveNewsConfigs(body);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/signal-test") {
      const body = await readJson(request);
      const result = await testSignal(body);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/smart-money-test") {
      const body = await readJson(request);
      const result = await testSmartMoneyMonitor(body);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/daily-report-test") {
      const body = await readJson(request);
      const result = await testDailyReport(body);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/daily-chart-analysis-test") {
      const body = await readJson(request);
      const result = await testDailyChartAnalysis(body);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/group-config") {
      const result = await readLocalGroupConfig();
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/group-config") {
      const body = await readJson(request);
      const result = await saveLocalGroupConfig(body);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/broadcast-rules") {
      const result = await readBroadcastRules();
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/broadcast-rules") {
      const body = await readJson(request);
      const result = await saveBroadcastRules(body);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/broadcast-status") {
      const result = readBroadcastStatus();
      sendJson(response, result.ok ? 200 : 500, result);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/social-packages") {
      const result = await readSocialPackages();
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/social-status") {
      const result = readSocialStatus();
      sendJson(response, result.ok ? 200 : 500, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/social-packages") {
      const body = await readJson(request);
      const result = await saveSocialPackages(body);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }
    await serveStatic(url.pathname, response);
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error.message });
  }
});

server.listen(port, () => {
  console.log(`YUBIT local admin server running at http://localhost:${port}/admin-group-config.html`);
  startNewsDispatcher();
  startSocialDispatcher();
  startBroadcastPoller();
});

async function runScript(body) {
  const script = scriptMap[body?.scriptId];
  if (!script) return { ok: false, error: "Unknown scriptId" };
  const env = buildEnv(body.payload || {});
  const result = await runNode(script.command, env);
  if (body?.scriptId === "newGroup" && body?.payload?.chatId) {
    await rememberChatById(body.payload.chatId).catch(() => {});
  }
  return { ok: result.code === 0, label: script.label, ...result };
}

async function discoverChats() {
  const tokens = readTokenEnv(".env.telegram-tokens.local");
  const token = tokens.YUBITADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: "Missing YUBITADMIN_BOT_TOKEN" };
  const local = await readLocalGroupConfig();
  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const body = await response.json();
  if (!body.ok) return { ok: false, error: body.description || "getUpdates failed" };
  const chats = new Map();
  for (const update of body.result || []) {
    for (const msg of [update.message, update.channel_post, update.edited_message, update.edited_channel_post, update.my_chat_member].filter(Boolean)) {
      const chat = msg.chat;
      if (!chat) continue;
      const existing = chats.get(chat.id) || {};
      const topics = normalizeTopics(existing.topics || []);
      const topicName = msg.forum_topic_created?.name || msg.forum_topic_edited?.name || "";
      if (topicName && msg.message_thread_id) {
        topics.push({ id: msg.message_thread_id, threadId: msg.message_thread_id, name: topicName });
      }
      chats.set(chat.id, {
        id: chat.id,
        chatId: String(chat.id),
        type: chat.type,
        title: chat.title || chat.username || [chat.first_name, chat.last_name].filter(Boolean).join(" "),
        canUseTopics: chat.type === "supergroup",
        topics: normalizeTopics(topics)
      });
    }
  }
  const discovered = [];
  for (const chat of chats.values()) {
    discovered.push(normalizeGroup(await enrichDiscoveredChat(token, chat)));
  }
  const enrichedLocal = await enrichLocalGroups(token, local.groups || []);
  if (!discovered.length) {
    return { ok: true, chats: enrichedLocal, source: "local-getChat" };
  }
  const merged = normalizeGroups([...enrichedLocal, ...discovered]);
  return { ok: true, chats: merged, source: "telegram-updates" };
}

async function enrichLocalGroups(token, groups) {
  const enriched = [];
  for (const group of groups || []) {
    if (!group?.chatId) continue;
    enriched.push(normalizeGroup(await enrichDiscoveredChat(token, group)));
    await sleep(120);
  }
  return enriched;
}

async function enrichDiscoveredChat(token, chat) {
  try {
    const result = await telegram(token, "getChat", { chat_id: chat.chatId || chat.id });
    return {
      ...chat,
      type: result.type || chat.type,
      title: result.title || chat.title,
      canUseTopics: result.type === "supergroup" && result.is_forum === true
    };
  } catch {
    return chat;
  }
}

async function rememberChatById(chatId) {
  const tokens = readTokenEnv(".env.telegram-tokens.local");
  const token = tokens.YUBITADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return null;
  const chat = await telegram(token, "getChat", { chat_id: chatId });
  return saveLocalGroupConfig({
    chatId: String(chat.id || chatId),
    title: chat.title || String(chatId),
    type: chat.type || "unknown",
    canUseTopics: chat.type === "supergroup" && chat.is_forum === true,
    topics: []
  });
}

async function readGroupMetrics() {
  const tokens = readTokenEnv(".env.telegram-tokens.local");
  const token = tokens.YUBITADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  return getTelegramGroupMetrics(token);
}

async function readBotGroups() {
  const tokens = readTokenEnv(".env.telegram-tokens.local");
  const localConfig = await readLocalGroupConfig();
  const localGroups = localConfig.groups || [];
  const botRoles = [
    { name: "YUBITadmin", role: "群管理 / 建群 / 公告", token: tokens.YUBITADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN },
    { name: "Trader1", role: "新闻 / 信号推送", token: tokens.TRADER1_BOT_TOKEN || process.env.TRADER1_BOT_TOKEN },
    { name: "MOD1", role: "人工管理辅助", token: tokens.MOD1_BOT_TOKEN || process.env.MOD1_BOT_TOKEN },
    { name: "Jack", role: "市场讨论", token: tokens.JACK_BOT_TOKEN || process.env.JACK_BOT_TOKEN },
    { name: "Tony", role: "风险讨论", token: tokens.TONY_BOT_TOKEN || process.env.TONY_BOT_TOKEN }
  ];
  const bots = await Promise.all(botRoles.map(async (bot) => {
    const tokenBotId = readBotIdFromToken(bot.token);
    if (!bot.token) {
      return { name: bot.name, role: bot.role, botId: "", status: "未配置", username: "", groups: [] };
    }
    try {
      const me = await telegram(bot.token, "getMe", {});
      let updates = { result: [] };
      try {
        updates = await telegram(bot.token, "getUpdates", {});
      } catch {
        updates = { result: [] };
      }
      const updateGroups = collectBotChats(updates.result || []);
      const memberGroups = await collectBotMemberGroups(bot.token, me.result?.id, localGroups);
      const groups = mergeBotGroups(updateGroups, memberGroups);
      return { name: bot.name, role: bot.role, botId: String(me.result?.id || tokenBotId || ""), status: "在线", username: me.result?.username || "", groups };
    } catch (error) {
      return { name: bot.name, role: bot.role, botId: tokenBotId, status: "需检查", username: "", groups: [], error: error.message };
    }
  }));
  return { ok: true, generatedAt: new Date().toISOString(), bots };
}

function readBotIdFromToken(token) {
  const match = String(token || "").match(/^(\d+):/);
  return match?.[1] || "";
}

async function previewNewsSource(body) {
  const source = cryptoNewsSources.find((item) => item.name === body?.sourceName);
  if (!source) return { ok: false, error: "Unknown source" };
  if (!source.kind.includes("RSS") || source.endpoint.includes("$") || !/^https?:\/\//.test(source.endpoint)) {
    return {
      ok: false,
      source,
      error: "This source needs an API key or custom adapter before preview."
    };
  }
  const response = await fetch(source.endpoint, {
    headers: { "user-agent": "YUBIT-Ops-Console/1.0" },
    signal: AbortSignal.timeout(10000)
  });
  const text = await response.text();
  if (!response.ok) return { ok: false, source, error: `${response.status} ${response.statusText}` };
  const items = (await enrichNewsItems(parseRssItems(text).slice(0, Number(body?.limit || 5))))
    .map((item) => ({ ...item, aiBrief: buildNewsBrief(source, item) }));
  return {
    ok: true,
    source,
    fetchedAt: new Date().toISOString(),
    format: "RSS item: title / link / pubDate / description",
    items
  };
}

async function testNewsSource(body) {
  const preview = await previewNewsSource({ sourceName: body?.sourceName, limit: 1 });
  if (!preview.ok) return preview;
  const item = preview.items?.[0];
  if (!item) return { ok: false, source: preview.source, error: "No news item found in this source." };
  const topic = await ensureDemoTestTopic();
  const tokens = readTokenEnv(".env.telegram-tokens.local");
  const token = tokens.TRADER1_BOT_TOKEN || tokens.YUBITADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: "Missing TRADER1_BOT_TOKEN or YUBITADMIN_BOT_TOKEN" };
  await sendSingleNewsToTelegram(token, demoChatId, topic.threadId, preview.source, item);
  return {
    ...preview,
    sent: true,
    testChatId: demoChatId,
    testThreadId: topic.threadId,
    testTopicName: topic.name,
    message: "测试已发送到 demo 群 test Topic"
  };
}

async function testSignal(body) {
  const allowedScripts = new Set(["futuresCard", "tradfiCard"]);
  const scriptId = allowedScripts.has(body?.scriptId) ? body.scriptId : "futuresCard";
  const topic = await ensureDemoTestTopic();
  const result = await runScript({
    scriptId,
    payload: {
      mode: "production",
      chatId: demoChatId,
      threadId: topic.threadId,
      botRole: "trader1",
      sendTelegram: true
    }
  });
  return {
    ...result,
    sent: result.ok,
    testChatId: demoChatId,
    testThreadId: topic.threadId,
    testTopicName: topic.name
  };
}

async function testSmartMoneyMonitor(body) {
  const topic = await ensureDemoTestTopic();
  const result = await runScript({
    scriptId: "smartMoneyMonitor",
    payload: {
      mode: "production",
      chatId: demoChatId,
      threadId: topic.threadId,
      botRole: "trader1",
      sendTelegram: body?.sendTelegram !== false
    }
  });
  return {
    ...result,
    sent: result.ok,
    testChatId: demoChatId,
    testThreadId: topic.threadId,
    testTopicName: topic.name
  };
}

async function testDailyReport(body) {
  const topic = await ensureDemoTestTopic();
  const config = body?.config || (await readDailyReportConfig()).config;
  const result = await runScript({
    scriptId: "dailyReport",
    payload: {
      mode: "production",
      chatId: demoChatId,
      threadId: topic.threadId,
      botRole: config.bot === "YUBITadmin" ? "admin" : "trader1",
      sendTelegram: body?.sendTelegram !== false,
      dailyReportTitle: config.title,
      dailyReportBody: config.body
    }
  });
  return {
    ...result,
    sent: result.ok,
    testChatId: demoChatId,
    testThreadId: topic.threadId,
    testTopicName: topic.name
  };
}

async function testDailyChartAnalysis(body) {
  const topic = await ensureDemoTestTopic();
  const config = body?.config || (await readDailyChartAnalysisConfig()).config;
  const result = await runScript({
    scriptId: "dailyChartAnalysis",
    payload: {
      mode: "production",
      chatId: demoChatId,
      threadId: topic.threadId,
      botRole: config.bot === "YUBITadmin" ? "admin" : "trader1",
      sendTelegram: body?.sendTelegram !== false,
      chartSymbols: config.symbols,
      chartInterval: config.chartInterval
    }
  });
  return {
    ...result,
    sent: result.ok,
    testChatId: demoChatId,
    testThreadId: topic.threadId,
    testTopicName: topic.name
  };
}

async function ensureDemoTestTopic() {
  const saved = readDemoTestTopic();
  if (saved?.threadId) return saved;
  const tokens = readTokenEnv(".env.telegram-tokens.local");
  const token = tokens.YUBITADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing YUBITADMIN_BOT_TOKEN for demo test Topic");
  const existing = await findDemoTestTopic(token);
  if (existing?.threadId) return saveDemoTestTopic(existing);
  const created = await telegram(token, "createForumTopic", {
    chat_id: demoChatId,
    name: "test"
  });
  const threadId = created.result?.message_thread_id;
  if (!threadId) throw new Error("createForumTopic did not return message_thread_id");
  return saveDemoTestTopic({ chatId: demoChatId, threadId, name: "test" });
}

function readDemoTestTopic() {
  if (!existsSync(demoTestTopicPath)) return null;
  try {
    const topic = JSON.parse(readFileSync(demoTestTopicPath, "utf8"));
    if (String(topic.chatId) !== String(demoChatId) || !topic.threadId) return null;
    return { chatId: demoChatId, threadId: Number(topic.threadId), name: topic.name || "test" };
  } catch {
    return null;
  }
}

async function findDemoTestTopic(token) {
  const updates = await telegram(token, "getUpdates", {});
  for (const update of updates.result || []) {
    for (const message of [update.message, update.channel_post, update.edited_message, update.edited_channel_post].filter(Boolean)) {
      if (String(message.chat?.id || "") !== String(demoChatId)) continue;
      const name = message.forum_topic_created?.name || message.forum_topic_edited?.name || "";
      if (name.trim().toLowerCase() === "test" && message.message_thread_id) {
        return { chatId: demoChatId, threadId: Number(message.message_thread_id), name: "test" };
      }
    }
  }
  return null;
}

async function saveDemoTestTopic(topic) {
  const normalized = {
    chatId: demoChatId,
    threadId: Number(topic.threadId),
    name: topic.name || "test",
    updatedAt: new Date().toISOString()
  };
  await mkdir(join(root, ".runtime"), { recursive: true });
  await writeFile(demoTestTopicPath, JSON.stringify(normalized, null, 2));
  return normalized;
}

function formatSingleNewsCaption(source, item) {
  const brief = buildNewsBrief(source, item);
  const sourceLine = formatNewsSourceLine(source, item);
  return [
    `📰 <b>${escapeTelegramHtml(cleanNewsTitle(item.title || "YUBIT Crypto News"))}</b>`,
    "",
    escapeTelegramHtml(brief),
    "",
    sourceLine,
    "<i>Market news only. Not financial advice.</i>"
  ].filter(Boolean).join("\n").slice(0, 1000);
}

function formatNewsSourceLine(source, item) {
  const label = item.source || source?.name || "Crypto News";
  const time = item.pubDate ? ` · ${escapeTelegramHtml(formatNewsDate(item.pubDate))}` : "";
  if (item.link && /^https?:\/\//i.test(item.link)) {
    return `<i>Source: <a href="${escapeTelegramAttr(item.link)}">${escapeTelegramHtml(label)}</a>${time}</i>`;
  }
  return `<i>Source: ${escapeTelegramHtml(label)}${time}</i>`;
}

function buildNewsBrief(source, item) {
  const title = cleanNewsTitle(item.title || "");
  const description = compactText(item.description || "", 320);
  const sourceName = item.source || source?.name || "the source";
  const topic = inferNewsTopic(title, description);
  if (description) {
    return [
      description,
      `This matters for crypto markets because it touches ${topic}, which can shape short-term sentiment and liquidity expectations.`
    ].join("\n\n");
  }
  return [
    `${sourceName} reported: ${title}.`,
    `For crypto readers, the key angle is ${topic}; this can influence market awareness and broader narrative.`
  ].join("\n\n");
}

function inferNewsTopic(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  const matches = [
    [/bitcoin|btc|etf/, "Bitcoin flows, ETF demand, and institutional positioning"],
    [/ethereum|ether|eth|staking/, "Ethereum activity, staking demand, and on-chain sentiment"],
    [/xrp|ripple/, "token branding, regulatory perception, and retail attention"],
    [/stablecoin|usdt|usdc/, "stablecoin liquidity and payment rails"],
    [/fed|fomc|cpi|inflation|treasury|dollar|rates/, "macro liquidity, rate expectations, and risk appetite"],
    [/binance|coinbase|exchange|sec|regulat|policy|bill|senate|law/, "exchange operations, regulation, and compliance risk"],
    [/defi|protocol|token|airdrop|dao|blockchain/, "on-chain activity, protocol adoption, and token narratives"],
    [/hack|exploit|scam|security/, "security risk and user confidence"],
    [/ai|artificial intelligence|compute/, "AI-related crypto narratives and speculative demand"],
    [/sports|partnership|sponsor|brand|jersey/, "mainstream adoption, brand exposure, and retail awareness"]
  ];
  return matches.find(([pattern]) => pattern.test(text))?.[1] || "market sentiment, risk appetite, and sector rotation";
}

async function sendSingleNewsToTelegram(token, chatId, threadId, source, item) {
  const caption = formatSingleNewsCaption(source, item);
  const photoPayload = {
    chat_id: chatId,
    ...(threadId ? { message_thread_id: Number(threadId) } : {}),
    photo: item.imageUrl || fallbackNewsImageUrl,
    caption,
    parse_mode: "HTML"
  };
  try {
    await telegram(token, "sendPhoto", photoPayload);
    return;
  } catch (error) {
    if (photoPayload.photo === fallbackNewsImageUrl) throw error;
  }
  try {
    await telegram(token, "sendPhoto", { ...photoPayload, photo: fallbackNewsImageUrl });
    return;
  } catch {
    await telegram(token, "sendMessage", {
      chat_id: chatId,
      ...(threadId ? { message_thread_id: Number(threadId) } : {}),
      text: caption,
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  }
}

function escapeTelegramHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeTelegramAttr(value) {
  return escapeTelegramHtml(value).replaceAll("\"", "&quot;");
}

function parseRssItems(xml) {
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => {
    const item = match[0];
    return {
      title: cleanXml(readXmlTag(item, "title")),
      link: cleanXml(readXmlTag(item, "link")),
      pubDate: cleanXml(readXmlTag(item, "pubDate")),
      source: cleanXml(readXmlTag(item, "source")),
      description: cleanXml(readXmlTag(item, "description")).slice(0, 520),
      imageUrl: extractRssImageUrl(item)
    };
  }).filter((item) => item.title);
}

async function enrichNewsItems(items) {
  const enriched = [];
  for (const item of items) {
    let imageUrl = item.imageUrl;
    if (isGoogleNewsUrl(item.link)) imageUrl = "";
    if (!imageUrl && item.link && !isGoogleNewsUrl(item.link)) imageUrl = await fetchOpenGraphImage(item.link).catch(() => "");
    enriched.push(normalizeNewsItem({ ...item, imageUrl }));
  }
  return enriched;
}

function normalizeNewsItem(item) {
  const title = cleanNewsTitle(item.title);
  const source = item.source || readSourceFromTitle(item.title);
  let description = String(item.description || "").replaceAll("&nbsp;", " ").replace(/\s+/g, " ").trim();
  const titleCore = title.toLowerCase();
  if (description.toLowerCase().includes(titleCore)) description = "";
  return { ...item, title, source, description };
}

function extractRssImageUrl(itemXml) {
  const candidates = [
    matchAttr(itemXml, /<media:content\b[^>]*\burl=["']([^"']+)["'][^>]*>/i),
    matchAttr(itemXml, /<media:thumbnail\b[^>]*\burl=["']([^"']+)["'][^>]*>/i),
    matchAttr(itemXml, /<enclosure\b(?=[^>]*\btype=["']image\/[^"']+["'])[^>]*\burl=["']([^"']+)["'][^>]*>/i),
    matchAttr(readXmlTag(itemXml, "description"), /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i),
    matchAttr(readXmlTag(itemXml, "content:encoded"), /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i)
  ];
  const imageUrl = candidates.find((url) => /^https?:\/\//i.test(url || "")) || "";
  return cleanXml(imageUrl);
}

async function fetchOpenGraphImage(url) {
  if (!/^https?:\/\//i.test(url)) return "";
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 YUBIT-Ops-Console/1.0" },
    redirect: "follow",
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) return "";
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) return "";
  const html = await response.text();
  const image = [
    matchAttr(html, /<meta\b[^>]*property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["'][^>]*>/i),
    matchAttr(html, /<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url)?["'][^>]*>/i),
    matchAttr(html, /<meta\b[^>]*name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["'][^>]*>/i),
    matchAttr(html, /<meta\b[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image(?::src)?["'][^>]*>/i)
  ].find(Boolean);
  return resolveUrl(url, cleanXml(image || ""));
}

function matchAttr(text, pattern) {
  return String(text || "").match(pattern)?.[1] || "";
}

function resolveUrl(base, value) {
  if (!value) return "";
  try {
    return new URL(value, base).toString();
  } catch {
    return "";
  }
}

function isGoogleNewsUrl(value) {
  try {
    return new URL(value).hostname === "news.google.com";
  } catch {
    return false;
  }
}

function compactText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

function formatNewsDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function readXmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1] || "";
}

function cleanXml(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanNewsTitle(value) {
  return String(value || "").replace(/\s+-\s+[^-]{2,60}$/g, "").trim();
}

function readSourceFromTitle(value) {
  const match = String(value || "").match(/\s+-\s+([^-]{2,60})$/);
  return match?.[1]?.trim() || "";
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

async function collectBotMemberGroups(token, botUserId, groups) {
  if (!token || !botUserId || !Array.isArray(groups)) return [];
  const checkedGroups = await Promise.all(groups.map(async (group) => {
    if (!group?.chatId) return null;
    try {
      const member = await telegram(token, "getChatMember", {
        chat_id: group.chatId,
        user_id: botUserId
      });
      if (["creator", "administrator", "member"].includes(member.result?.status)) {
        return {
          id: group.chatId,
          chatId: String(group.chatId),
          title: group.title || String(group.chatId),
          type: group.type || "supergroup",
          canUseTopics: group.canUseTopics !== false,
          topics: group.topics || []
        };
      }
    } catch {
      // The bot is not in this group, or it cannot inspect the member list.
    }
    return null;
  }));
  return checkedGroups.filter(Boolean);
}

function mergeBotGroups(...lists) {
  const groups = new Map();
  for (const list of lists) {
    for (const group of list || []) {
      const key = String(group.chatId || group.id || group.title);
      groups.set(key, {
        ...groups.get(key),
        ...group,
        chatId: String(group.chatId || group.id || key)
      });
    }
  }
  return [...groups.values()];
}

async function telegram(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!body.ok) throw new Error(body.description || `${method} failed`);
  return body;
}

async function readLocalGroupConfig() {
  if (!existsSync(groupConfigPath)) return { ok: true, groups: [], group: null };
  const config = normalizeGroupConfig(JSON.parse(await readFile(groupConfigPath, "utf8")));
  return { ok: true, ...config };
}

async function readBroadcastRules() {
  if (!existsSync(broadcastRulesPath)) {
    return { ok: true, rules: defaultBroadcastRules(), updatedAt: null };
  }
  const config = JSON.parse(await readFile(broadcastRulesPath, "utf8"));
  return {
    ok: true,
    rules: normalizeBroadcastRules(config.rules || config),
    updatedAt: config.updatedAt || null
  };
}

async function readSocialPackages() {
  if (!existsSync(socialPackagesPath)) {
    return { ok: true, packages: defaultSocialPackages(), updatedAt: null };
  }
  const config = JSON.parse(await readFile(socialPackagesPath, "utf8"));
  return {
    ok: true,
    packages: normalizeSocialPackages(config.packages || config),
    updatedAt: config.updatedAt || null
  };
}

async function saveSocialPackages(body) {
  const packages = normalizeSocialPackages(body?.packages || body);
  if (!packages.length) return { ok: false, error: "Missing social packages" };
  const config = { packages, updatedAt: new Date().toISOString() };
  await mkdir(join(root, ".runtime"), { recursive: true });
  await writeFile(socialPackagesPath, JSON.stringify(config, null, 2));
  return { ok: true, ...config };
}

function defaultSocialPackages() {
  return [
    { name: "Ricky 社媒转发包", agent: "Ricky", platform: "Twitter / X + YouTube", accountUrl: "https://x.com/Ricky / Ricky Channel", contentType: "全部新内容", frequency: "每 5 分钟", bot: "YUBITadmin", status: "已启用" },
    { name: "Jack 社媒转发包", agent: "Jack", platform: "Twitter / X", accountUrl: "待录入", contentType: "全部新内容", frequency: "每 5 分钟", bot: "YUBITadmin", status: "待接入" },
    { name: "Tony 社媒转发包", agent: "Tony", platform: "YouTube", accountUrl: "待录入", contentType: "全部新内容", frequency: "每 5 分钟", bot: "YUBITadmin", status: "待接入" }
  ];
}

function normalizeSocialPackages(packages) {
  return (Array.isArray(packages) ? packages : [])
    .map((item, index) => ({
      id: String(item?.id || `social-${normalizeName(item?.agent || item?.name || index + 1)}`),
      name: String(item?.name || `社媒转发包 ${index + 1}`).trim(),
      agent: String(item?.agent || "").trim(),
      platform: String(item?.platform || "Twitter / X").trim(),
      provider: String(item?.provider || "").trim(),
      userId: String(item?.userId || item?.twitterUserId || "").trim(),
      accountUrl: String(item?.accountUrl || item?.url || "").trim(),
      contentType: String(item?.contentType || "全部新内容").trim(),
      frequency: String(item?.frequency || "每 5 分钟").trim(),
      bot: String(item?.bot || "YUBITadmin").trim(),
      status: String(item?.status || "已启用").trim()
    }))
    .filter((item) => item.name && item.agent);
}

let socialDispatcherStarted = false;
let socialDispatcherBusy = false;

function startSocialDispatcher() {
  if (socialDispatcherStarted || process.env.DISABLE_SOCIAL_DISPATCHER === "true") return;
  socialDispatcherStarted = true;
  dispatchSocialBindings({ initialize: true }).catch((error) => {
    writeSocialStatus({ ok: false, error: error.message, stage: "initialize" }).catch(() => {});
  });
  setInterval(() => {
    if (socialDispatcherBusy) return;
    socialDispatcherBusy = true;
    dispatchSocialBindings().finally(() => {
      socialDispatcherBusy = false;
    });
  }, Number(process.env.SOCIAL_DISPATCH_INTERVAL_MS || 60000));
}

async function dispatchSocialBindings(options = {}) {
  const tokens = readTokenEnv(".env.telegram-tokens.local");
  const twitterApiKey = tokens.TWITTERAPI_IO_KEY || process.env.TWITTERAPI_IO_KEY;
  const groupConfig = await readLocalGroupConfig();
  const socialPackages = await readSocialPackages();
  const state = readSocialDispatchState();
  const now = Date.now();
  const sent = [];
  const skipped = [];
  const errors = [];
  const bindings = (groupConfig.bindings || []).filter((binding) => binding.type === "代理社媒" && binding.status !== "暂停");

  for (const binding of bindings) {
    const pkg = (socialPackages.packages || []).find((item) => item.name === binding.config);
    if (!pkg || pkg.status === "暂停" || pkg.status === "待接入") {
      skipped.push({ binding: binding.config, reason: "社媒包未启用或不存在" });
      continue;
    }
    if (!pkg.platform.toLowerCase().includes("twitter") && !pkg.platform.includes("X")) {
      skipped.push({ binding: binding.config, reason: "当前只支持 Twitter / X 自动转发" });
      continue;
    }
    if (!twitterApiKey) {
      errors.push({ binding: binding.config, error: "缺少 TWITTERAPI_IO_KEY" });
      continue;
    }

    const intervalMs = frequencyToMs(binding.frequency || pkg.frequency);
    const bindingKey = socialBindingKey(binding);
    const bindingState = state.dispatchState[bindingKey] || {};
    if (!options.initialize && bindingState.lastAttemptAt && now - Number(bindingState.lastAttemptAt) < intervalMs) {
      skipped.push({ binding: binding.config, reason: "未到发送频率" });
      continue;
    }
    bindingState.lastAttemptAt = now;
    state.dispatchState[bindingKey] = bindingState;

    const group = findGroupByTitle(groupConfig.groups || [], binding.group);
    if (!group?.chatId) {
      errors.push({ binding: binding.config, error: "找不到目标群" });
      continue;
    }
    const threadId = binding.topicId || findTopicId(group, binding.topic);
    if (!threadId) {
      errors.push({ binding: binding.config, group: binding.group, topic: binding.topic, error: "找不到目标 Topic" });
      continue;
    }
    const token = tokenForBotRole(tokens, binding.bot || pkg.bot);
    if (!token) {
      errors.push({ binding: binding.config, error: `缺少 ${binding.bot || pkg.bot} token` });
      continue;
    }

    try {
      const tweets = await fetchTwitterLatestTweets(twitterApiKey, pkg);
      const candidates = filterSocialTweets(tweets, pkg);
      if (options.initialize && !bindingState.sentIds?.length) {
        bindingState.sentIds = candidates.map((tweet) => socialTweetId(tweet)).filter(Boolean).slice(0, 50);
        bindingState.lastCheckedAt = now;
        bindingState.lastTitle = candidates[0]?.text?.slice(0, 120) || "";
        skipped.push({ binding: binding.config, reason: `初始化记录 ${bindingState.sentIds.length} 条历史推文` });
        continue;
      }

      const sentIds = new Set(bindingState.sentIds || []);
      const newTweets = candidates.filter((tweet) => !sentIds.has(socialTweetId(tweet))).slice(0, Number(process.env.SOCIAL_MAX_SEND_PER_BINDING || 3)).reverse();
      if (!newTweets.length) {
        skipped.push({ binding: binding.config, reason: "没有新的可转发推文" });
        continue;
      }
      for (const tweet of newTweets) {
        await sendTweetToTelegram(token, group.chatId, threadId, pkg, tweet);
        const id = socialTweetId(tweet);
        if (id) sentIds.add(id);
        sent.push({ binding: binding.config, group: binding.group, topic: binding.topic, bot: binding.bot || pkg.bot, tweetId: id, url: tweet.url });
        bindingState.lastSentAt = now;
        bindingState.lastTitle = String(tweet.text || "").slice(0, 120);
      }
      bindingState.sentIds = [...sentIds].slice(-50).reverse();
      bindingState.lastCheckedAt = now;
    } catch (error) {
      errors.push({ binding: binding.config, error: error.message });
    }
  }

  await writeSocialDispatchState(state);
  await writeSocialStatus({
    ok: errors.length === 0,
    checkedAt: new Date().toISOString(),
    bindingCount: bindings.length,
    sent: sent.length,
    sentItems: sent.slice(-10),
    skipped: skipped.slice(-10),
    errors: errors.slice(-10)
  });
}

async function fetchTwitterLatestTweets(apiKey, pkg) {
  const identity = resolveTwitterIdentity(pkg);
  if (!identity.userName && !identity.userId) throw new Error("缺少 Twitter userName 或 userId");
  const attempts = [];
  if (identity.userName) attempts.push({ userName: identity.userName });
  if (identity.userId) attempts.push({ userId: identity.userId });

  let lastMessage = "";
  for (const params of attempts) {
    const url = new URL("https://api.twitterapi.io/twitter/user/last_tweets");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("includeReplies", "false");
    const response = await fetch(url, {
      headers: { "X-API-Key": apiKey },
      signal: AbortSignal.timeout(Number(process.env.TWITTERAPI_TIMEOUT_MS || 12000))
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || body.msg || `TwitterAPI.io ${response.status}`);
    const tweets = normalizeTwitterApiTweets(body);
    if (tweets.length) return tweets;
    lastMessage = body.msg || body.message || "没有返回 tweets";
  }
  throw new Error(lastMessage || "TwitterAPI.io 没有返回 tweets");
}

function resolveTwitterIdentity(pkg) {
  const urlName = extractTwitterUserName(pkg.accountUrl);
  return {
    userName: urlName,
    userId: String(pkg.userId || "").trim()
  };
}

function extractTwitterUserName(value) {
  const text = String(value || "");
  const urlMatch = text.match(/(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/i);
  if (urlMatch) return urlMatch[1];
  const atMatch = text.match(/@([A-Za-z0-9_]{1,15})/);
  return atMatch?.[1] || "";
}

function normalizeTwitterApiTweets(body) {
  const tweets = body?.tweets || body?.data?.tweets || body?.data?.data || [];
  return (Array.isArray(tweets) ? tweets : []).filter((tweet) => tweet?.id || tweet?.url);
}

function filterSocialTweets(tweets, pkg) {
  const contentType = String(pkg.contentType || "");
  return tweets.filter((tweet) => {
    if (contentType.includes("排除") && (tweet.retweeted_tweet || tweet.retweetedTweet || tweet.type === "retweet")) return false;
    return true;
  });
}

function socialBindingKey(binding) {
  return [binding.group, binding.topic, binding.config].map((item) => normalizeName(item)).join(":");
}

function socialTweetId(tweet) {
  return String(tweet?.id || tweet?.url || "").trim();
}

async function sendTweetToTelegram(token, chatId, threadId, pkg, tweet) {
  await telegram(token, "sendMessage", {
    chat_id: chatId,
    ...(threadId ? { message_thread_id: Number(threadId) } : {}),
    text: formatTweetMessage(pkg, tweet),
    parse_mode: "HTML",
    disable_web_page_preview: false
  });
}

function formatTweetMessage(pkg, tweet) {
  const author = tweet.author?.userName || extractTwitterUserName(tweet.url) || pkg.agent || "Twitter / X";
  const text = compactText(String(tweet.text || "").replace(/\s+/g, " "), 3000);
  const time = tweet.createdAt ? `\n<i>${escapeTelegramHtml(formatNewsDate(tweet.createdAt))}</i>` : "";
  const link = tweet.url && /^https?:\/\//i.test(tweet.url) ? `\n<a href="${escapeTelegramAttr(tweet.url)}">View on X</a>` : "";
  return [
    `𝕏 <b>${escapeTelegramHtml(pkg.agent || author)}</b> <i>@${escapeTelegramHtml(author)}</i>`,
    "",
    escapeTelegramHtml(text || "(no text)"),
    time,
    link
  ].join("\n").slice(0, 4000);
}

function readSocialDispatchState() {
  if (!existsSync(socialStatusPath)) return { dispatchState: {} };
  try {
    const state = JSON.parse(readFileSync(socialStatusPath, "utf8"));
    return { dispatchState: state.dispatchState || {} };
  } catch {
    return { dispatchState: {} };
  }
}

async function writeSocialDispatchState(state) {
  await mkdir(join(root, ".runtime"), { recursive: true });
  const previous = readSocialStatus().status || {};
  await writeFile(socialStatusPath, JSON.stringify({ ...previous, dispatchState: state.dispatchState || {} }, null, 2));
}

async function writeSocialStatus(status) {
  await mkdir(join(root, ".runtime"), { recursive: true });
  const previous = readSocialStatus().status || {};
  await writeFile(socialStatusPath, JSON.stringify({ ...previous, ...status }, null, 2));
}

function readSocialStatus() {
  if (!existsSync(socialStatusPath)) return { ok: true, status: null };
  try {
    return { ok: true, status: JSON.parse(readFileSync(socialStatusPath, "utf8")) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function readNewsConfigs() {
  if (!existsSync(newsConfigsPath)) {
    return { ok: true, configs: defaultNewsConfigs(), updatedAt: null };
  }
  const config = JSON.parse(await readFile(newsConfigsPath, "utf8"));
  return {
    ok: true,
    configs: ensureBuiltinNewsConfigs(normalizeNewsConfigs(config.configs || config)),
    updatedAt: config.updatedAt || null
  };
}

async function saveNewsConfigs(body) {
  const configs = ensureBuiltinNewsConfigs(normalizeNewsConfigs(body?.configs || body));
  if (!configs.length) return { ok: false, error: "Missing news configs" };
  const config = { configs, updatedAt: new Date().toISOString() };
  await mkdir(join(root, ".runtime"), { recursive: true });
  await writeFile(newsConfigsPath, JSON.stringify(config, null, 2));
  return { ok: true, ...config };
}

async function readDailyReportConfig() {
  const newsConfigs = await readNewsConfigs();
  return {
    ok: true,
    config: findDailyReportConfig(newsConfigs.configs),
    updatedAt: newsConfigs.updatedAt || null
  };
}

async function saveDailyReportConfig(body) {
  const current = await readNewsConfigs();
  const nextDaily = normalizeDailyReportConfig({
    ...findDailyReportConfig(current.configs),
    ...body,
    kind: "daily-report",
    name: "Daily Morning Brief"
  });
  const configs = ensureBuiltinNewsConfigs([
    nextDaily,
    ...current.configs.filter((config) => config.name !== "Daily Morning Brief")
  ]);
  const saved = await saveNewsConfigs({ configs });
  return { ok: saved.ok, config: findDailyReportConfig(saved.configs), configs: saved.configs, updatedAt: saved.updatedAt };
}

async function readDailyChartAnalysisConfig() {
  const newsConfigs = await readNewsConfigs();
  return {
    ok: true,
    config: findDailyChartAnalysisConfig(newsConfigs.configs),
    updatedAt: newsConfigs.updatedAt || null
  };
}

async function saveDailyChartAnalysisConfig(body) {
  const current = await readNewsConfigs();
  const nextConfig = normalizeDailyChartAnalysisConfig({
    ...findDailyChartAnalysisConfig(current.configs),
    ...body,
    kind: "daily-chart-analysis",
    name: "Daily Chart Analysis"
  });
  const configs = ensureBuiltinNewsConfigs([
    nextConfig,
    ...current.configs.filter((config) => config.name !== "Daily Chart Analysis")
  ]);
  const saved = await saveNewsConfigs({ configs });
  return { ok: saved.ok, config: findDailyChartAnalysisConfig(saved.configs), configs: saved.configs, updatedAt: saved.updatedAt };
}

function defaultNewsConfigs() {
  const defaultSources = ["Google News RSS", "Cointelegraph RSS", "CoinDesk RSS", "CryptoSlate RSS", "Decrypt RSS"];
  return buildNewsConfigSet(defaultSources);
}

function buildNewsConfigSet(sourceNames) {
  const sources = [...new Set(sourceNames.filter(Boolean))];
  return [
    { name: "Crypto News Default", sources, bot: "Trader1", frequency: "每 15 分钟", status: "已启用" },
    ...sources.map((source) => ({ name: source, sources: [source], bot: "Trader1", frequency: "实时", status: "已启用" })),
    defaultSmartMoneyConfig(),
    defaultDailyReportConfig(),
    defaultDailyChartAnalysisConfig(),
    { name: "Official Updates", sources: [], bot: "YUBITadmin", frequency: "实时", status: "已启用" }
  ];
}

function normalizeNewsConfigs(configs) {
  return (Array.isArray(configs) ? configs : [])
    .map((config, index) => ({
      name: String(config?.name || `新闻配置 ${index + 1}`).trim(),
      kind: String(config?.kind || "news").trim(),
      sources: Array.isArray(config?.sources) ? config.sources.map((source) => String(source).trim()).filter(Boolean) : [],
      bot: String(config?.bot || "Trader1").trim(),
      frequency: String(config?.frequency || "每 15 分钟").trim(),
      status: String(config?.status || "已启用").trim(),
      reportTime: String(config?.reportTime || "08:30").trim(),
      timezone: String(config?.timezone || "Asia/Shanghai").trim(),
      title: String(config?.title || "").trim(),
      body: String(config?.body || "").trim(),
      symbols: Array.isArray(config?.symbols) ? config.symbols.map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean) : [],
      chartInterval: String(config?.chartInterval || "1h").trim(),
      stockUniverse: String(config?.stockUniverse || "").trim()
    }))
    .filter((config) => config.name);
}

function ensureBuiltinNewsConfigs(configs) {
  const normalized = normalizeNewsConfigs(configs);
  if (!normalized.some((config) => config.name === "Daily Morning Brief")) {
    normalized.push(defaultDailyReportConfig());
  }
  if (!normalized.some((config) => config.name === "Daily Chart Analysis")) {
    normalized.push(defaultDailyChartAnalysisConfig());
  }
  if (!normalized.some((config) => config.name === "Smart Money Tracker")) {
    normalized.push(defaultSmartMoneyConfig());
  }
  return normalized;
}

function defaultSmartMoneyConfig() {
  return {
    name: "Smart Money Tracker",
    kind: "smart-money",
    sources: [],
    bot: "Trader1",
    frequency: "每 15 分钟",
    status: "已启用",
    reportTime: "08:30",
    timezone: "Asia/Shanghai",
    title: "",
    body: "",
    symbols: [],
    chartInterval: "1h",
    stockUniverse: ""
  };
}

function defaultDailyReportConfig() {
  return normalizeDailyReportConfig({
    name: "Daily Morning Brief",
    kind: "daily-report",
    sources: [],
    bot: "Trader1",
    frequency: "每日 08:30",
    reportTime: "08:30",
    timezone: "Asia/Shanghai",
    title: "",
    body: defaultDailyReport,
    status: "已启用"
  });
}

function normalizeDailyReportConfig(config) {
  return {
    name: "Daily Morning Brief",
    kind: "daily-report",
    sources: [],
    bot: String(config?.bot || "Trader1").trim(),
    frequency: String(config?.frequency || `每日 ${config?.reportTime || "08:30"}`).trim(),
    status: String(config?.status || "已启用").trim(),
    reportTime: normalizeReportTime(config?.reportTime || "08:30"),
    timezone: String(config?.timezone || "Asia/Shanghai").trim(),
    title: String(config?.title || "").trim(),
    body: String(config?.body || defaultDailyReport).trim()
  };
}

function findDailyReportConfig(configs) {
  const found = (configs || []).find((config) => config.name === "Daily Morning Brief" || config.kind === "daily-report");
  return normalizeDailyReportConfig(found || defaultDailyReportConfig());
}

function defaultDailyChartAnalysisConfig() {
  return normalizeDailyChartAnalysisConfig({
    name: "Daily Chart Analysis",
    kind: "daily-chart-analysis",
    sources: [],
    bot: "Trader1",
    frequency: "每日 09:00",
    reportTime: "09:00",
    timezone: "Asia/Shanghai",
    title: "Daily BTC/ETH & US Stocks Chart Analysis",
    body: "Send chart cards for BTCUSDT, ETHUSDT and US stock market ETFs. Review trend, SMA20/SMA50 structure, fresh crosses and risk note.",
    symbols: ["BTCUSDT", "ETHUSDT"],
    chartInterval: "1h",
    stockUniverse: "SPY, QQQ, DIA, IWM, TLT, GLD, USO, UUP",
    status: "已启用"
  });
}

function normalizeDailyChartAnalysisConfig(config) {
  const symbols = Array.isArray(config?.symbols)
    ? config.symbols
    : String(config?.symbols || "BTCUSDT,ETHUSDT").split(",");
  const reportTime = normalizeReportTime(config?.reportTime || "09:00");
  return {
    name: "Daily Chart Analysis",
    kind: "daily-chart-analysis",
    sources: [],
    bot: String(config?.bot || "Trader1").trim(),
    frequency: String(config?.frequency || `每日 ${reportTime}`).trim(),
    status: String(config?.status || "已启用").trim(),
    reportTime,
    timezone: String(config?.timezone || "Asia/Shanghai").trim(),
    title: String(config?.title || "Daily BTC/ETH & US Stocks Chart Analysis").trim(),
    body: String(config?.body || "Send chart cards for BTCUSDT, ETHUSDT and US stock market ETFs.").trim(),
    symbols: symbols.map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean),
    chartInterval: String(config?.chartInterval || "1h").trim(),
    stockUniverse: String(config?.stockUniverse || "SPY, QQQ, DIA, IWM, TLT, GLD, USO, UUP").trim()
  };
}

function findDailyChartAnalysisConfig(configs) {
  const found = (configs || []).find((config) => config.name === "Daily Chart Analysis" || config.kind === "daily-chart-analysis");
  return normalizeDailyChartAnalysisConfig(found || defaultDailyChartAnalysisConfig());
}

function normalizeReportTime(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return "08:30";
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

let newsDispatcherStarted = false;
let newsDispatcherBusy = false;

function startNewsDispatcher() {
  if (newsDispatcherStarted || process.env.DISABLE_NEWS_DISPATCHER === "true") return;
  newsDispatcherStarted = true;
  dispatchNewsBindings({ initialize: true }).catch((error) => {
    writeNewsStatus({ ok: false, error: error.message, stage: "initialize" }).catch(() => {});
  });
  setInterval(() => {
    if (newsDispatcherBusy) return;
    newsDispatcherBusy = true;
    dispatchNewsBindings().finally(() => {
      newsDispatcherBusy = false;
    });
  }, Number(process.env.NEWS_DISPATCH_INTERVAL_MS || 60000));
}

async function dispatchNewsBindings(options = {}) {
  const tokens = readTokenEnv(".env.telegram-tokens.local");
  const groupConfig = await readLocalGroupConfig();
  const newsConfigs = await readNewsConfigs();
  const state = readNewsDispatchState();
  const now = Date.now();
  const sent = [];
  const skipped = [];
  const errors = [];
  const bindings = (groupConfig.bindings || []).filter((binding) => binding.type === "新闻配置" && binding.status !== "暂停");

  for (const binding of bindings) {
    const config = (newsConfigs.configs || []).find((item) => item.name === binding.config);
    if (!config || config.status === "暂停") {
      skipped.push({ binding: binding.config, reason: "新闻配置未启用或不存在" });
      continue;
    }
    const intervalMs = frequencyToMs(binding.frequency || config.frequency);
    const bindingKey = newsBindingKey(binding);
    const bindingState = state.dispatchState[bindingKey] || {};
    if (!options.initialize && bindingState.lastAttemptAt && now - Number(bindingState.lastAttemptAt) < intervalMs) {
      skipped.push({ binding: binding.config, reason: "未到发送频率" });
      continue;
    }
    bindingState.lastAttemptAt = now;
    state.dispatchState[bindingKey] = bindingState;

    const group = findGroupByTitle(groupConfig.groups || [], binding.group);
    if (!group?.chatId) {
      errors.push({ binding: binding.config, error: "找不到目标群" });
      continue;
    }
    const threadId = binding.topicId || findTopicId(group, binding.topic);
    if (!threadId) {
      errors.push({ binding: binding.config, group: binding.group, topic: binding.topic, error: "找不到目标 Topic" });
      continue;
    }
    const token = tokenForBotRole(tokens, binding.bot || config.bot);
    if (!token) {
      errors.push({ binding: binding.config, error: `缺少 ${binding.bot || config.bot} token` });
      continue;
    }

    if (config.kind === "daily-report") {
      const due = isDailyReportDue(config, bindingState, now);
      if (!due.ok) {
        skipped.push({ binding: binding.config, reason: due.reason });
        continue;
      }
      try {
        await sendTelegramText(token, group.chatId, threadId, formatDailyReport(config.title, config.body));
        bindingState.lastSentAt = now;
        bindingState.lastDailyDate = due.dateKey;
        bindingState.lastTitle = config.name;
        sent.push({ binding: binding.config, group: binding.group, topic: binding.topic, bot: binding.bot || config.bot, source: "daily-report", title: config.name });
        continue;
      } catch (error) {
        errors.push({ binding: binding.config, source: "daily-report", error: error.message });
        continue;
      }
    }

    if (config.kind === "daily-chart-analysis") {
      const due = isDailyReportDue(config, bindingState, now);
      if (!due.ok) {
        skipped.push({ binding: binding.config, reason: due.reason });
        continue;
      }
      try {
        const result = await runScript({
          scriptId: "dailyChartAnalysis",
          payload: {
            mode: "production",
            chatId: group.chatId,
            threadId,
            botRole: (binding.bot || config.bot) === "YUBITadmin" ? "admin" : "trader1",
            sendTelegram: true,
            chartSymbols: config.symbols,
            chartInterval: config.chartInterval
          }
        });
        if (!result.ok) throw new Error(result.stderr || result.error || "Daily chart analysis failed");
        bindingState.lastSentAt = now;
        bindingState.lastDailyDate = due.dateKey;
        bindingState.lastTitle = config.name;
        sent.push({ binding: binding.config, group: binding.group, topic: binding.topic, bot: binding.bot || config.bot, source: "daily-chart-analysis", title: config.name });
        continue;
      } catch (error) {
        errors.push({ binding: binding.config, source: "daily-chart-analysis", error: error.message });
        continue;
      }
    }

    if (config.kind === "smart-money") {
      try {
        const result = await runScript({
          scriptId: "smartMoneyMonitor",
          payload: {
            mode: "production",
            chatId: group.chatId,
            threadId,
            botRole: (binding.bot || config.bot) === "YUBITadmin" ? "admin" : "trader1",
            sendTelegram: true
          }
        });
        if (!result.ok) throw new Error(result.stderr || result.error || "Smart money monitor failed");
        bindingState.lastSentAt = now;
        bindingState.lastTitle = config.name;
        sent.push({ binding: binding.config, group: binding.group, topic: binding.topic, bot: binding.bot || config.bot, source: "smart-money", title: config.name });
        continue;
      } catch (error) {
        errors.push({ binding: binding.config, source: "smart-money", error: error.message });
        continue;
      }
    }

    const sourceNames = config.sources?.length ? config.sources : [config.name];
    let sentOne = false;
    for (const sourceName of sourceNames) {
      const source = cryptoNewsSources.find((item) => item.name === sourceName);
      if (!source || !source.kind.includes("RSS") || source.endpoint.includes("$")) continue;
      try {
        const preview = await previewNewsSource({ sourceName, limit: 5 });
        const items = preview.items || [];
        const sentIds = new Set(bindingState.sentIds || []);
        const item = items.find((candidate) => !sentIds.has(newsItemId(sourceName, candidate)));
        if (!item) continue;
        await sendSingleNewsToTelegram(token, group.chatId, threadId, preview.source, item);
        const id = newsItemId(sourceName, item);
        bindingState.sentIds = [id, ...(bindingState.sentIds || []).filter((value) => value !== id)].slice(0, 50);
        bindingState.lastSentAt = now;
        bindingState.lastSource = sourceName;
        bindingState.lastTitle = item.title;
        sent.push({ binding: binding.config, group: binding.group, topic: binding.topic, bot: binding.bot || config.bot, source: sourceName, title: item.title });
        sentOne = true;
        break;
      } catch (error) {
        errors.push({ binding: binding.config, source: sourceName, error: error.message });
      }
    }
    if (!sentOne) skipped.push({ binding: binding.config, reason: "没有新的可发送新闻" });
  }

  await writeNewsDispatchState(state);
  await writeNewsStatus({
    ok: errors.length === 0,
    checkedAt: new Date().toISOString(),
    bindingCount: bindings.length,
    sent: sent.length,
    sentItems: sent.slice(-10),
    skipped: skipped.slice(-10),
    errors: errors.slice(-10)
  });
}

async function sendTelegramText(token, chatId, threadId, text) {
  await telegram(token, "sendMessage", {
    chat_id: chatId,
    ...(threadId ? { message_thread_id: Number(threadId) } : {}),
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

function isDailyReportDue(config, bindingState, now) {
  const parts = getZonedDateParts(now, config.timezone || "Asia/Shanghai");
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  if (bindingState.lastDailyDate === dateKey) return { ok: false, reason: "今日日报已发送", dateKey };
  const [targetHour, targetMinute] = normalizeReportTime(config.reportTime).split(":").map(Number);
  const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const targetMinutes = targetHour * 60 + targetMinute;
  if (currentMinutes < targetMinutes) return { ok: false, reason: `未到日报发送时间 ${normalizeReportTime(config.reportTime)}`, dateKey };
  return { ok: true, dateKey };
}

function getZonedDateParts(timestamp, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute
  };
}

function frequencyToMs(value) {
  const text = String(value || "");
  if (text.includes("实时")) return Number(process.env.NEWS_REALTIME_INTERVAL_MS || 60000);
  if (text.includes("每日")) return 60 * 1000;
  const match = text.match(/(\d+)\s*分钟/);
  if (match) return Number(match[1]) * 60 * 1000;
  return 15 * 60 * 1000;
}

function newsBindingKey(binding) {
  return [binding.group, binding.topic, binding.config].map((item) => normalizeName(item)).join(":");
}

function newsItemId(sourceName, item) {
  return `${sourceName}:${item.title || item.link || item.pubDate}`;
}

function readNewsDispatchState() {
  if (!existsSync(newsStatusPath)) return { dispatchState: {} };
  try {
    const state = JSON.parse(readFileSync(newsStatusPath, "utf8"));
    return { dispatchState: state.dispatchState || {} };
  } catch {
    return { dispatchState: {} };
  }
}

async function writeNewsDispatchState(state) {
  await mkdir(join(root, ".runtime"), { recursive: true });
  const previous = readNewsStatus().status || {};
  await writeFile(newsStatusPath, JSON.stringify({ ...previous, dispatchState: state.dispatchState || {} }, null, 2));
}

async function writeNewsStatus(status) {
  await mkdir(join(root, ".runtime"), { recursive: true });
  const previous = readNewsStatus().status || {};
  await writeFile(newsStatusPath, JSON.stringify({ ...previous, ...status }, null, 2));
}

function readNewsStatus() {
  if (!existsSync(newsStatusPath)) return { ok: true, status: null };
  try {
    return { ok: true, status: JSON.parse(readFileSync(newsStatusPath, "utf8")) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function saveBroadcastRules(body) {
  const rules = normalizeBroadcastRules(body?.rules || body);
  if (!rules.length) return { ok: false, error: "Missing broadcast rules" };
  const config = { rules, updatedAt: new Date().toISOString() };
  await mkdir(join(root, ".runtime"), { recursive: true });
  await writeFile(broadcastRulesPath, JSON.stringify(config, null, 2));
  return { ok: true, ...config };
}

function defaultBroadcastRules() {
  return [
    { name: "Demo Topic 全部消息广播", group: "YUBIT × Agent Community DEMO", chatId: demoChatId, topic: "test", topicId: 330, listen: "全部消息", bot: "YUBITadmin", frequency: "实时", status: "已启用" },
    { name: "合约交易信号广播", group: "YUBIT × Agent Community DEMO", chatId: demoChatId, topic: "3. Market Analysis - Crypto/Stocks/TradFi", topicId: 10, listen: "全部消息", bot: "YUBITadmin", frequency: "实时", status: "已启用" }
  ];
}

function normalizeBroadcastRules(rules) {
  return (Array.isArray(rules) ? rules : [])
    .map((rule, index) => ({
      name: String(rule?.name || `广播规则 ${index + 1}`).trim(),
      group: String(rule?.group || "Demo 群").trim(),
      chatId: String(rule?.chatId || demoChatId).trim(),
      topic: String(rule?.topic || "").trim(),
      topicId: rule?.topicId ? Number(rule.topicId) : null,
      listen: "全部消息",
      bot: String(rule?.bot || "YUBITadmin").trim(),
      frequency: String(rule?.frequency || "实时").trim(),
      status: String(rule?.status || "已启用").trim()
    }))
    .filter((rule) => rule.name && rule.chatId && rule.status !== "暂停");
}

let broadcastPollerStarted = false;
let broadcastPollerBusy = false;

function startBroadcastPoller() {
  if (broadcastPollerStarted || process.env.DISABLE_BROADCAST_POLLER === "true") return;
  broadcastPollerStarted = true;
  pollBroadcastUpdates({ initialize: true }).catch((error) => {
    writeBroadcastStatus({ ok: false, error: error.message, stage: "initialize" }).catch(() => {});
  });
  setInterval(() => {
    if (broadcastPollerBusy) return;
    broadcastPollerBusy = true;
    pollBroadcastUpdates().finally(() => {
      broadcastPollerBusy = false;
    });
  }, Number(process.env.BROADCAST_POLL_INTERVAL_MS || 4000));
}

async function pollBroadcastUpdates(options = {}) {
  const tokens = readTokenEnv(".env.telegram-tokens.local");
  const pollToken = tokens.YUBITADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (!pollToken) {
    await writeBroadcastStatus({ ok: false, error: "Missing YUBITADMIN_BOT_TOKEN", checkedAt: new Date().toISOString() });
    return;
  }

  const offsetState = readBroadcastOffset();
  const updates = await telegram(pollToken, "getUpdates", {
    ...(offsetState.offset ? { offset: offsetState.offset } : {}),
    allowed_updates: ["message", "channel_post", "edited_message", "edited_channel_post"]
  });
  const result = updates.result || [];
  if (!result.length) {
    const previous = readBroadcastStatus().status || {};
    await writeBroadcastStatus({ ...previous, ok: true, checkedAt: new Date().toISOString(), processed: 0, copied: 0 });
    return;
  }

  const nextOffset = Math.max(...result.map((update) => Number(update.update_id || 0))) + 1;
  await writeBroadcastOffset(nextOffset);
  if (options.initialize && !offsetState.offset) {
    await writeBroadcastStatus({ ok: true, checkedAt: new Date().toISOString(), initialized: true, skippedOldUpdates: result.length, offset: nextOffset });
    return;
  }

  const rules = (await readBroadcastRules()).rules;
  const groupConfig = await readLocalGroupConfig();
  const copied = [];
  const errors = [];

  for (const update of result) {
    const message = update.message || update.channel_post || update.edited_message || update.edited_channel_post;
    if (!message?.message_id || !message.chat?.id) continue;
    if (isBroadcastSystemMessage(message)) continue;
    const sourceChatId = String(message.chat.id);
    const sourceThreadId = message.message_thread_id ? Number(message.message_thread_id) : null;
    const matchedRules = rules.filter((rule) => rule.chatId === sourceChatId && (!rule.topicId || Number(rule.topicId) === sourceThreadId));
    for (const rule of matchedRules) {
      await sendBroadcastSourceStatus(pollToken, sourceChatId, sourceThreadId, "收到").catch(() => {});
      const copyToken = tokenForBotRole(tokens, rule.bot);
      if (!copyToken) {
        errors.push({ rule: rule.name, error: `Missing token for ${rule.bot}` });
        await sendBroadcastSourceStatus(pollToken, sourceChatId, sourceThreadId, `转发失败：缺少 ${rule.bot} token`).catch(() => {});
        continue;
      }
      const targets = (groupConfig.bindings || []).filter((binding) => binding.type === "广播" && binding.config === rule.name && binding.status !== "暂停");
      let ruleCopied = 0;
      const ruleErrors = [];
      for (const target of targets) {
        const group = findGroupByTitle(groupConfig.groups || [], target.group);
        if (!group?.chatId) continue;
        const targetThreadId = target.topicId || findTopicId(group, target.topic);
        if (String(group.chatId) === sourceChatId && Number(targetThreadId || 0) === Number(sourceThreadId || 0)) continue;
        try {
          const copyResult = await copyBroadcastMessage(copyToken, {
            group,
            sourceChatId,
            messageId: message.message_id,
            targetTopic: target.topic,
            targetThreadId
          });
          copied.push({ rule: rule.name, bot: rule.bot, toGroup: group.title, toTopic: target.topic, targetThreadId: copyResult.threadId, retry: copyResult.retry, messageId: message.message_id });
          ruleCopied += 1;
        } catch (error) {
          const item = { rule: rule.name, toGroup: target.group, toTopic: target.topic, error: error.message };
          errors.push(item);
          ruleErrors.push(item);
        }
      }
      if (ruleCopied > 0) {
        await sendBroadcastSourceStatus(pollToken, sourceChatId, sourceThreadId, `已转发：${ruleCopied} 个目标`).catch(() => {});
      } else if (ruleErrors.length) {
        await sendBroadcastSourceStatus(pollToken, sourceChatId, sourceThreadId, `转发失败：${ruleErrors[0].error}`).catch(() => {});
      } else if (!targets.length) {
        await sendBroadcastSourceStatus(pollToken, sourceChatId, sourceThreadId, "转发失败：没有绑定目标群").catch(() => {});
      }
    }
  }

  await writeBroadcastStatus({
    ok: errors.length === 0,
    checkedAt: new Date().toISOString(),
    processed: result.length,
    copied: copied.length,
    copiedItems: copied.slice(-10),
    errors: errors.slice(-10)
  });
}

function findGroupByTitle(groups, title) {
  return groups.find((group) => group.title === title) || groups.find((group) => normalizeName(group.title) === normalizeName(title));
}

function isBroadcastSystemMessage(message) {
  const text = String(message.text || message.caption || "").trim();
  return text === "收到" || text.startsWith("已转发") || text.startsWith("转发失败");
}

async function sendBroadcastSourceStatus(token, chatId, threadId, text) {
  await telegram(token, "sendMessage", {
    chat_id: chatId,
    ...(threadId ? { message_thread_id: Number(threadId) } : {}),
    text
  });
}

async function copyBroadcastMessage(token, options) {
  const payload = {
    chat_id: options.group.chatId,
    from_chat_id: options.sourceChatId,
    message_id: options.messageId,
    ...(options.targetThreadId ? { message_thread_id: Number(options.targetThreadId) } : {})
  };
  try {
    await telegram(token, "copyMessage", payload);
    return { threadId: options.targetThreadId || null, retry: false };
  } catch (error) {
    if (!/message thread not found/i.test(error.message || "")) throw error;
    const fallbackThreadId = findLatestTopicId(options.group, options.targetTopic, options.targetThreadId);
    if (!fallbackThreadId || Number(fallbackThreadId) === Number(options.targetThreadId || 0)) throw error;
    await telegram(token, "copyMessage", {
      ...payload,
      message_thread_id: Number(fallbackThreadId)
    });
    return { threadId: fallbackThreadId, retry: true };
  }
}

function tokenForBotRole(tokens, role) {
  const normalized = String(role || "YUBITadmin").toLowerCase();
  if (normalized === "trader1") return tokens.TRADER1_BOT_TOKEN || process.env.TRADER1_BOT_TOKEN;
  if (normalized === "mod1") return tokens.MOD1_BOT_TOKEN || process.env.MOD1_BOT_TOKEN;
  if (normalized === "jack") return tokens.JACK_BOT_TOKEN || process.env.JACK_BOT_TOKEN;
  if (normalized === "tony") return tokens.TONY_BOT_TOKEN || process.env.TONY_BOT_TOKEN;
  return tokens.YUBITADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
}

function findTopicId(group, topicName) {
  return (group.topics || []).find((topic) => topic.name === topicName)?.threadId ||
    (group.topics || []).find((topic) => normalizeName(topic.name) === normalizeName(topicName))?.threadId ||
    null;
}

function findLatestTopicId(group, topicName, excludeThreadId) {
  const wanted = normalizeName(topicName);
  return (group.topics || [])
    .filter((topic) => topic.threadId && normalizeName(topic.name) === wanted && Number(topic.threadId) !== Number(excludeThreadId || 0))
    .sort((a, b) => Number(b.threadId) - Number(a.threadId))[0]?.threadId || null;
}

function normalizeName(value) {
  return String(value || "").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}

function readBroadcastOffset() {
  if (!existsSync(broadcastOffsetPath)) return {};
  try {
    return JSON.parse(readFileSync(broadcastOffsetPath, "utf8"));
  } catch {
    return {};
  }
}

async function writeBroadcastOffset(offset) {
  await mkdir(join(root, ".runtime"), { recursive: true });
  await writeFile(broadcastOffsetPath, JSON.stringify({ offset, updatedAt: new Date().toISOString() }, null, 2));
}

async function writeBroadcastStatus(status) {
  await mkdir(join(root, ".runtime"), { recursive: true });
  const previous = readBroadcastStatus().status || {};
  await writeFile(broadcastStatusPath, JSON.stringify({ ...previous, ...status }, null, 2));
}

function readBroadcastStatus() {
  if (!existsSync(broadcastStatusPath)) return { ok: true, status: null };
  try {
    return { ok: true, status: JSON.parse(readFileSync(broadcastStatusPath, "utf8")) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function saveLocalGroupConfig(body) {
  const existingConfig = existsSync(groupConfigPath) ? normalizeGroupConfig(JSON.parse(await readFile(groupConfigPath, "utf8"))) : normalizeGroupConfig({});

  if (Array.isArray(body?.groups)) {
    if (!body.groups.length && existingConfig.groups.length) {
      return { ok: true, ...existingConfig, warning: "Empty discovery result ignored; kept existing groups." };
    }
    const renamedGroups = new Map();
    const groups = normalizeGroups(body.groups.map((group) => {
      const existing = existingConfig.groups.find((item) => item.chatId === String(group?.chatId || group?.id || "").trim());
      const nextTitle = String(group?.title || group?.chatTitle || existing?.title || "").trim();
      if (existing?.title && nextTitle && existing.title !== nextTitle) {
        renamedGroups.set(existing.title, nextTitle);
      }
      return {
        ...existing,
        ...group,
        topics: Array.isArray(group?.topics) && group.topics.length ? group.topics : existing?.topics
      };
    }));
    const bindings = migrateBindingGroupNames(existingConfig.bindings, renamedGroups);
    const config = { groups, bindings, updatedAt: new Date().toISOString() };
    await mkdir(join(root, ".runtime"), { recursive: true });
    await writeFile(groupConfigPath, JSON.stringify(config, null, 2));
    return { ok: true, ...normalizeGroupConfig(config) };
  }

  if (Array.isArray(body?.bindings)) {
    const config = { groups: existingConfig.groups, bindings: normalizeBindings(body.bindings), updatedAt: new Date().toISOString() };
    await mkdir(join(root, ".runtime"), { recursive: true });
    await writeFile(groupConfigPath, JSON.stringify(config, null, 2));
    return { ok: true, ...normalizeGroupConfig(config) };
  }

  const chatId = String(body?.chatId || "").trim();
  if (!chatId) return { ok: false, error: "Missing chatId" };
  const group = normalizeGroup({
    chatId,
    title: String(body?.title || "").trim() || chatId,
    type: String(body?.type || "supergroup"),
    canUseTopics: body?.canUseTopics !== false,
    topics: body?.topics
  });
  const existing = existingConfig.groups.find((item) => item.chatId === group.chatId);
  const renamedGroups = new Map();
  if (existing?.title && existing.title !== group.title) renamedGroups.set(existing.title, group.title);
  const groups = [group, ...existingConfig.groups.filter((item) => item.chatId !== group.chatId)];
  const bindings = migrateBindingGroupNames(existingConfig.bindings, renamedGroups);
  const config = { groups, bindings, updatedAt: new Date().toISOString() };
  await mkdir(join(root, ".runtime"), { recursive: true });
  await writeFile(groupConfigPath, JSON.stringify(config, null, 2));
  return { ok: true, ...normalizeGroupConfig(config) };
}

function migrateBindingGroupNames(bindings, renamedGroups) {
  if (!renamedGroups?.size) return bindings;
  return normalizeBindings(bindings).map((binding) => ({
    ...binding,
    group: renamedGroups.get(binding.group) || binding.group
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeGroupConfig(config) {
  const groups = normalizeGroups(Array.isArray(config?.groups) ? config.groups : config?.chatId ? [config] : []);
  return {
    groups,
    group: groups[0] || null,
    bindings: normalizeBindings(Array.isArray(config?.bindings) ? config.bindings : defaultBindings),
    updatedAt: config?.updatedAt || config?.savedAt || null
  };
}

function normalizeGroups(groups) {
  const unique = new Map();
  for (const group of groups) {
    const normalized = normalizeGroup(group);
    if (normalized.chatId) unique.set(normalized.chatId, normalized);
  }
  return [...unique.values()];
}

function normalizeGroup(group) {
  const chatId = String(group?.chatId || group?.id || "").trim();
  const topics = normalizeTopics(group?.topics?.length ? group.topics : getLocalTopicHints(chatId));
  return {
    chatId,
    title: String(group?.title || chatId).trim(),
    type: String(group?.type || "supergroup"),
    canUseTopics: group?.canUseTopics !== false,
    topics,
    savedAt: group?.savedAt || new Date().toISOString()
  };
}

function normalizeBindings(bindings) {
  return bindings.map((binding, index) => ({
    id: String(binding?.id || `binding-${index + 1}`),
    group: String(binding?.group || ""),
    topic: String(binding?.topic || ""),
    topicId: binding?.topicId ? Number(binding.topicId) : null,
    type: String(binding?.type || ""),
    config: String(binding?.config || ""),
    bot: String(binding?.bot || ""),
    frequency: String(binding?.frequency || ""),
    status: String(binding?.status || "已启用")
  })).filter((binding) => binding.group && binding.topic && binding.config);
}

function normalizeTopics(topics) {
  const unique = new Map();
  for (const topic of Array.isArray(topics) ? topics : []) {
    const name = String(topic?.name || topic?.title || "").trim();
    const threadId = Number(topic?.threadId || topic?.message_thread_id || topic?.id || 0);
    if (!name) continue;
    const key = threadId ? String(threadId) : name;
    unique.set(key, { id: threadId || name, threadId: threadId || null, name });
  }
  return [...unique.values()].sort((a, b) => Number(a.threadId || 999999) - Number(b.threadId || 999999));
}

function getLocalTopicHints(chatId) {
  const setupStatePath = join(root, ".runtime", "setup-state.json");
  if (existsSync(setupStatePath)) {
    try {
      const state = JSON.parse(readFileSync(setupStatePath, "utf8"));
      if (!chatId || String(state.chatId || "") === String(chatId)) {
        return Object.values(state.topics || {}).map((topic) => ({
          threadId: topic.message_thread_id,
          name: topic.name
        }));
      }
    } catch {
      return [];
    }
  }
  return [];
}

function buildEnv(payload) {
  const tokens = readTokenEnv(".env.telegram-tokens.local");
  const dryRun = payload.mode !== "production";
  const roleToken = payload.botRole === "trader1" ? tokens.TRADER1_BOT_TOKEN : "";
  return {
    ...process.env,
    ...tokens,
    TELEGRAM_CHAT_ID: payload.chatId || process.env.TELEGRAM_CHAT_ID || "",
    TELEGRAM_BOT_TOKEN: payload.botToken || roleToken || tokens.YUBITADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "",
    TELEGRAM_THREAD_ID: String(payload.threadId || process.env.TELEGRAM_THREAD_ID || ""),
    DRY_RUN: dryRun ? "true" : "false",
    SEND_TELEGRAM: payload.sendTelegram === true && !dryRun ? "true" : "false",
    CARD_KIND: payload.cardKind || "news",
    NEWS_MODE: payload.newsMode || "crypto",
    NEWS_LIMIT: String(payload.newsLimit || process.env.NEWS_LIMIT || 4),
    CHART_SYMBOLS: Array.isArray(payload.chartSymbols) ? payload.chartSymbols.join(",") : payload.chartSymbols || process.env.CHART_SYMBOLS || "",
    CHART_INTERVAL: payload.chartInterval || process.env.CHART_INTERVAL || "",
    DAILY_REPORT_TITLE: payload.dailyReportTitle || process.env.DAILY_REPORT_TITLE || "",
    DAILY_REPORT_BODY: payload.dailyReportBody || process.env.DAILY_REPORT_BODY || "",
    SEND_LARK: payload.sendLark === true ? "true" : "false",
    LARK_WEBHOOK_URL: payload.larkWebhook || process.env.LARK_WEBHOOK_URL || "",
    ADMIN_HEALTH_URL: payload.adminHealthUrl || process.env.ADMIN_HEALTH_URL || "http://localhost:4173/admin-group-config.html",
    GROUP_NAME: payload.groupName || "",
    TOPIC_TEMPLATE_JSON: payload.topics ? JSON.stringify(payload.topics) : "",
    DELETE_DUPLICATE_TOPICS: payload.deleteTopics === false ? "false" : "true",
    TOKEN_FILE: ".env.telegram-tokens.local"
  };
}

function readTokenEnv(path) {
  const targetPath = path.startsWith("/") ? path : join(root, path);
  if (!existsSync(targetPath)) return {};
  const text = readFileSync(targetPath, "utf8");
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

function runNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

async function serveStatic(pathname, response) {
  const target = pathname === "/" ? "/admin-group-config.html" : pathname;
  const safePath = normalize(target).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, safePath);
  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const content = await readFile(filePath);
  response.writeHead(200, { "content-type": contentType(filePath) });
  response.end(content);
}

function contentType(path) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png"
  }[extname(path)] || "application/octet-stream";
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk.toString();
    });
    request.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
