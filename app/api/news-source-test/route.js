import { NextResponse } from "next/server";
import { cryptoNewsSources } from "../../../crypto-news-sources.mjs";

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const source = cryptoNewsSources.find((item) => item.name === body.sourceName);
  if (!source) return NextResponse.json({ ok: false, error: "News source not found" }, { status: 404 });
  if (!source.kind.includes("RSS") || !/^https?:\/\//.test(source.endpoint) || source.endpoint.includes("$")) {
    return NextResponse.json({ ok: false, error: "这个来源需要 API Key 或专用适配器，暂不能公开 dry-run。" }, { status: 400 });
  }
  try {
    const response = await fetch(source.endpoint, { headers: { "user-agent": "Mozilla/5.0 (compatible; YUBITBot/1.0)" }, cache: "no-store", signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    const items = parseRssItems(xml, Math.min(Number(body.limit) || 5, 10));
    return NextResponse.json({ ok: true, dryRun: true, source, items, fetchedAt: new Date().toISOString(), format: "title / pubDate / description / link", testThreadId: null });
  } catch (error) {
    return NextResponse.json({ ok: false, error: `抓取失败：${error.message}` }, { status: 502 });
  }
}

export function parseRssItems(xml, limit = 5) {
  const entries = [...String(xml).matchAll(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi)].slice(0, limit);
  return entries.map((match) => {
    const block = match[0];
    return {
      title: clean(value(block, "title")),
      link: clean(value(block, "link") || block.match(/<link[^>]+href=["']([^"']+)/i)?.[1] || ""),
      pubDate: clean(value(block, "pubDate") || value(block, "updated") || value(block, "published")),
      description: clean(value(block, "description") || value(block, "summary") || value(block, "content")).slice(0, 500)
    };
  }).filter((item) => item.title);
}

function value(block, tag) {
  return block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, "i"))?.[1] || "";
}

function clean(input) {
  return String(input).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replace(/\s+/g, " ").trim();
}
