import { NextResponse } from "next/server";
import { readJson, writeJson } from "../../../lib/json-store";

const pathname = "broadcast-rules.json";
export const dynamic = "force-dynamic";

export async function GET() {
  const config = await readJson(pathname, { rules: [], updatedAt: null });
  return NextResponse.json({
    ok: true,
    rules: normalizeRules(config.rules || config).filter((rule) => !isLegacySeedRule(rule)),
    updatedAt: config.updatedAt || null
  });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const rules = normalizeRules(body.rules || body);
  const config = { rules, updatedAt: new Date().toISOString() };
  await writeJson(pathname, config);
  return NextResponse.json({ ok: true, ...config });
}

function normalizeRules(rules) {
  return (Array.isArray(rules) ? rules : [])
    .map((rule, index) => ({
      name: String(rule?.name || `广播规则 ${index + 1}`).trim(),
      group: String(rule?.group || "").trim(),
      chatId: String(rule?.chatId || "").trim(),
      topic: String(rule?.topic || "").trim(),
      topicId: rule?.topicId ? Number(rule.topicId) : null,
      listen: "全部消息",
      bot: String(rule?.bot || "ForwardBot").trim(),
      frequency: String(rule?.frequency || "实时").trim(),
      status: String(rule?.status || "已启用").trim()
    }))
    .filter((rule) => rule.name && rule.chatId);
}

function isLegacySeedRule(rule) {
  return rule.chatId === "-1003710405969" && rule.topic === "test" && ["Demo Topic 全部消息广播", "Demo 群全部消息广播"].includes(rule.name);
}
