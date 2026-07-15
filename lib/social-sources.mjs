import { createHash } from "node:crypto";

export function detectSocialPlatform(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("youtube.com") || text.includes("youtu.be") || text === "youtube") return "YouTube";
  if (text.includes("x.com") || text.includes("twitter.com") || text.includes("twitter") || text === "x") return "X";
  return "Other";
}

export function normalizeSocialPackages(packages) {
  return (Array.isArray(packages) ? packages : [])
    .map((item, index) => {
      const accountUrl = String(item?.accountUrl || item?.url || "").trim();
      const detected = detectSocialPlatform(`${item?.platform || ""} ${accountUrl}`);
      const platform = detected === "Other" ? String(item?.platform || "Other").trim() : detected;
      const agent = String(item?.agent || "").trim();
      const pausedStatuses = new Set(["已暂停", "暂停", "待接入", "未启用", "disabled", "paused"]);
      return {
        id: String(item?.id || `social-${normalizeName(agent || item?.name || index + 1)}`),
        name: String(item?.name || `${agent || "代理"} ${platform}`).trim(),
        agent,
        platform,
        provider: String(item?.provider || "").trim(),
        userId: String(item?.userId || item?.twitterUserId || "").trim(),
        accountUrl,
        feedUrl: String(item?.feedUrl || item?.rssUrl || item?.providerUrl || "").trim(),
        contentType: String(item?.contentType || "全部新内容").trim(),
        frequency: "每 4 小时",
        bot: "SpeakerBot",
        status: pausedStatuses.has(String(item?.status || "").trim().toLowerCase()) ? "已暂停" : "已启用"
      };
    })
    .filter((item) => item.name && item.agent);
}

export function summarizeSocialSources(packages) {
  const values = Array.isArray(packages) ? packages : [];
  return {
    total: values.length,
    enabled: values.filter((item) => item.status === "已启用").length,
    x: values.filter((item) => detectSocialPlatform(item.platform || item.accountUrl) === "X").length,
    youtube: values.filter((item) => detectSocialPlatform(item.platform || item.accountUrl) === "YouTube").length
  };
}

export function socialFetchPlan(source, { hasXToken = Boolean(process.env.X_BEARER_TOKEN) } = {}) {
  const accountUrl = String(source?.accountUrl || "").trim();
  const feedUrl = String(source?.feedUrl || "").trim();
  const platform = detectSocialPlatform(`${source?.platform || ""} ${accountUrl}`);
  if (feedUrl) return { kind: "feed", url: feedUrl, reliability: "stable" };

  if (platform === "YouTube") {
    const channelId = accountUrl.match(/youtube\.com\/channel\/([^/?#]+)/i)?.[1] || String(source?.userId || "").trim();
    if (channelId) return { kind: "youtube-feed", url: `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, reliability: "stable" };
    return { kind: "youtube-page", url: accountUrl, reliability: "stable-after-resolution" };
  }

  if (platform === "X" && hasXToken) {
    return { kind: "x-api", username: socialUsername(source), reliability: "stable" };
  }
  return { kind: "page-fallback", url: accountUrl, reliability: "limited" };
}

export function parseSocialFeed(xml) {
  const body = String(xml || "");
  const block = body.match(/<item\b[\s\S]*?<\/item>/i)?.[0] || body.match(/<entry\b[\s\S]*?<\/entry>/i)?.[0];
  if (!block) throw new Error("Feed 中没有可读取的新内容");
  const url = decodeXml(readTag(block, "link") || readAttribute(block, "link", "href")).trim();
  const title = decodeXml(readTag(block, "title")).trim();
  const description = stripMarkup(decodeXml(readTag(block, "description") || readTag(block, "media:description") || readTag(block, "summary") || readTag(block, "content"))).slice(0, 800);
  const externalId = decodeXml(readTag(block, "guid") || readTag(block, "yt:videoId") || readTag(block, "id") || url).trim();
  const publishedAt = decodeXml(readTag(block, "pubDate") || readTag(block, "published") || readTag(block, "updated")).trim();
  if (!externalId || !title || !url) throw new Error("Feed 最新内容缺少标题、链接或唯一编号");
  return { externalId, title, description, url, publishedAt };
}

export function socialContentSnapshot(item, extra = {}) {
  const externalId = String(item?.externalId || item?.url || "").trim();
  const fingerprint = `${externalId}\n${item?.title || ""}\n${item?.description || ""}`;
  return {
    externalId,
    title: String(item?.title || "").slice(0, 180),
    description: String(item?.description || "").slice(0, 800),
    url: String(item?.url || "").trim(),
    publishedAt: String(item?.publishedAt || "").trim(),
    hash: createHash("sha256").update(fingerprint).digest("hex"),
    ...extra
  };
}

export function socialUsername(source) {
  const explicit = String(source?.userId || "").trim().replace(/^@/, "");
  if (explicit) return explicit;
  const match = String(source?.accountUrl || "").match(/(?:x\.com|twitter\.com)\/([^/?#]+)/i);
  return String(match?.[1] || "").replace(/^@/, "");
}

function readTag(block, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return unwrapCdata(block.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i"))?.[1] || "");
}

function readAttribute(block, tag, attribute) {
  const tagMatch = block.match(new RegExp(`<${tag}\\b[^>]*>`, "i"))?.[0] || "";
  return tagMatch.match(new RegExp(`${attribute}=["']([^"']+)["']`, "i"))?.[1] || "";
}

function unwrapCdata(value) {
  return String(value).replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "");
}

function stripMarkup(value) {
  return String(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeXml(value) {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
}
