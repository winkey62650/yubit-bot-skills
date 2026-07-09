import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

const groupConfigPath = join(process.cwd(), ".runtime", "group-config.json");
const defaultBindings = [
  { id: "news-market-events", group: "YUBIT test", topic: "Market Events", type: "新闻配置", config: "Crypto News Default", bot: "Trader1", status: "已启用" },
  { id: "signal-market-analysis", group: "YUBIT test", topic: "Market Analysis - Crypto/Stocks/TradFi", type: "信号配置", config: "Futures SMA", bot: "Trader1", status: "已启用" },
  { id: "broadcast-market-events", group: "YUBIT test", topic: "Market Events", type: "广播", config: "Demo 群全部消息广播", bot: "YUBITadmin", frequency: "实时", status: "已启用" },
  { id: "ricky-social", group: "YUBIT test", topic: "Ricky's Trading Zone", type: "代理社媒", config: "Ricky 社媒转发包", bot: "YUBITadmin", frequency: "每 5 分钟", status: "已启用" },
  { id: "official-updates", group: "YUBIT Winkey Main", topic: "YUBIT Updates", type: "新闻配置", config: "Official Updates", bot: "YUBITadmin", status: "待检查" }
];

export async function GET() {
  if (!existsSync(groupConfigPath)) {
    return NextResponse.json({ ok: true, groups: [], group: null });
  }
  const config = normalizeGroupConfig(JSON.parse(await readFile(groupConfigPath, "utf8")));
  return NextResponse.json({ ok: true, ...config });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const existingConfig = existsSync(groupConfigPath) ? normalizeGroupConfig(JSON.parse(await readFile(groupConfigPath, "utf8"))) : normalizeGroupConfig({});

  if (Array.isArray(body.groups)) {
    const groups = normalizeGroups(body.groups);
    const config = { groups, bindings: existingConfig.bindings, updatedAt: new Date().toISOString() };
    await mkdir(join(process.cwd(), ".runtime"), { recursive: true });
    await writeFile(groupConfigPath, JSON.stringify(config, null, 2));
    return NextResponse.json({ ok: true, ...normalizeGroupConfig(config) });
  }

  if (Array.isArray(body.bindings)) {
    const config = { groups: existingConfig.groups, bindings: normalizeBindings(body.bindings), updatedAt: new Date().toISOString() };
    await mkdir(join(process.cwd(), ".runtime"), { recursive: true });
    await writeFile(groupConfigPath, JSON.stringify(config, null, 2));
    return NextResponse.json({ ok: true, ...normalizeGroupConfig(config) });
  }

  const chatId = String(body.chatId || "").trim();
  if (!chatId) {
    return NextResponse.json({ ok: false, error: "Missing chatId" }, { status: 400 });
  }
  const group = normalizeGroup({
    chatId,
    title: String(body.title || "").trim() || chatId,
    type: String(body.type || "supergroup"),
    canUseTopics: body.canUseTopics !== false
  });
  const groups = [group, ...existingConfig.groups.filter((item) => item.chatId !== group.chatId)];
  const config = { groups, bindings: existingConfig.bindings, updatedAt: new Date().toISOString() };
  await mkdir(join(process.cwd(), ".runtime"), { recursive: true });
  await writeFile(groupConfigPath, JSON.stringify(config, null, 2));
  return NextResponse.json({ ok: true, ...normalizeGroupConfig(config) });
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
  return {
    chatId,
    title: String(group?.title || chatId).trim(),
    type: String(group?.type || "supergroup"),
    canUseTopics: group?.canUseTopics !== false,
    topics: normalizeTopics(group?.topics || []),
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
