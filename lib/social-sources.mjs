import { createHash } from "node:crypto";

export function detectSocialPlatform(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("youtube.com") || text.includes("youtu.be") || text === "youtube") return "YouTube";
  if (text.includes("x.com") || text.includes("twitter.com") || text.includes("twitter") || text === "x") return "X";
  return "Other";
}

export function normalizeSocialTargets(targets) {
  const seen = new Set();
  return (Array.isArray(targets) ? targets : []).flatMap((target) => {
    const platform = target?.platform === "discord" || target?.guildId || target?.channelId
      ? "discord"
      : "telegram";
    if (platform === "discord") {
      const guildId = String(target?.guildId || target?.serverId || "").trim();
      const channelId = String(target?.channelId || "").trim();
      if (!guildId || !channelId) return [];
      const key = `discord:${guildId}:${channelId}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{
        platform: "discord",
        guildId,
        channelId,
        groupName: String(target?.groupName || target?.guildName || target?.serverName || "").trim(),
        topicName: String(target?.topicName || target?.channelName || target?.channel || "").trim()
      }];
    }
    const chatId = String(target?.chatId || "").trim();
    const chatType = target?.chatType === "channel" ? "channel" : "supergroup";
    const threadId = chatType === "channel" ? null : Number(target?.threadId);
    if (!chatId || (chatType !== "channel" && (!Number.isInteger(threadId) || threadId <= 0))) return [];
    const key = chatType === "channel" ? `${chatId}:channel` : `${chatId}:${threadId}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      chatId,
      chatType,
      threadId,
      groupName: String(target?.groupName || target?.group || "").trim(),
      topicName: String(target?.topicName || target?.topic || (chatType === "channel" ? "整个频道" : "")).trim()
    }];
  });
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
        frequency: "每小时",
        bot: "SpeakerBot",
        targets: normalizeSocialTargets(item?.targets || item?.destinations),
        status: pausedStatuses.has(String(item?.status || "").trim().toLowerCase()) ? "已暂停" : "已启用"
      };
    })
    .filter((item) => item.name && item.agent);
}

export function validateSocialPackageRoutes(packages) {
  const normalized = normalizeSocialPackages(packages);
  const unmapped = normalized.filter((item) => item.status === "已启用" && item.targets.length === 0);
  return {
    ok: unmapped.length === 0,
    unmapped: unmapped.map((item) => ({ id: item.id, name: item.name }))
  };
}

export function validateChangedSocialPackageRoutes(previousPackages, nextPackages) {
  const previous = new Map(
    normalizeSocialPackages(previousPackages).map((item) => [item.id, JSON.stringify(item)])
  );
  const changed = normalizeSocialPackages(nextPackages).filter(
    (item) => previous.get(item.id) !== JSON.stringify(item)
  );
  return validateSocialPackageRoutes(changed);
}

export function validateSocialSnapshotOwnership(source, snapshot) {
  const platform = detectSocialPlatform(`${source?.platform || ""} ${source?.accountUrl || ""}`);
  const expectedHandle = platform === "X" ? socialUsername(source) : "";
  const observedHandle = platform === "X" ? xStatusHandle(snapshot?.url) : "";
  if (!expectedHandle) return { ok: true, expectedHandle, observedHandle };
  if (!observedHandle) return { ok: false, expectedHandle, observedHandle };
  return {
    ok: expectedHandle.toLowerCase() === observedHandle.toLowerCase(),
    expectedHandle,
    observedHandle
  };
}

function xStatusHandle(value) {
  const match = String(value || "").match(
    /https?:\/\/(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/([^/?#]+)\/status\/\d+/i
  );
  return String(match?.[1] || "").replace(/^@/, "");
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
  if (platform === "X") {
    const username = socialUsername(source);
    if (username) {
      return {
        kind: "x-profile",
        username,
        url: `https://x.com/${encodeURIComponent(username)}`,
        reliability: "standard"
      };
    }
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

export function parseXSyndicationTimeline(html, username) {
  const body = String(html || "");
  const scripts = body.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  const nextData = scripts.find((script) => /\bid=["']__NEXT_DATA__["']/i.test(script));
  const payload = nextData?.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
  if (!payload) throw new Error("X 公开时间线缺少可读取的数据");

  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    throw new Error("X 公开时间线数据格式无效");
  }

  const expectedUser = String(username || "").replace(/^@/, "").toLowerCase();
  const entries = data?.props?.pageProps?.timeline?.entries;
  const posts = (Array.isArray(entries) ? entries : [])
    .map((entry) => entry?.content?.tweet)
    .filter((tweet) => {
      if (!tweet?.id_str || !tweet?.full_text) return false;
      const author = String(tweet?.user?.screen_name || "").toLowerCase();
      return !expectedUser || !author || author === expectedUser;
    });
  if (!posts.length) throw new Error(`X 公开时间线没有返回 @${username || "该账号"} 的内容`);

  const latest = posts.reduce((newest, candidate) => comparePostIds(candidate.id_str, newest.id_str) > 0 ? candidate : newest);
  const permalink = String(latest.permalink || "").trim();
  const url = permalink.startsWith("/")
    ? `https://x.com${permalink}`
    : permalink || `https://x.com/${encodeURIComponent(username)}/status/${latest.id_str}`;
  return {
    externalId: String(latest.id_str),
    title: String(latest.full_text),
    description: String(latest.full_text),
    url,
    publishedAt: String(latest.created_at || "")
  };
}

export function parseXProfileTimeline(html, username) {
  const body = String(html || "").replaceAll("\0", "");
  const articlePattern = /<article\b[^>]*itemType=["']https:\/\/schema\.org\/SocialMediaPosting["'][^>]*>/gi;
  const starts = [...body.matchAll(articlePattern)];
  const expectedUser = String(username || "").replace(/^@/, "").toLowerCase();
  const posts = starts.map((match, index) => {
    const segment = body.slice(match.index, starts[index + 1]?.index ?? body.length);
    const openingTag = match[0];
    const tweetId = readHtmlAttribute(openingTag, "data-tweet-id") || readMetaValue(segment, "identifier");
    const url = readMetaValue(segment, "url");
    const articleBody = readMetaValue(segment, "articleBody");
    const publishedAt = readMetaValue(segment, "datePublished") || readMetaValue(segment, "dateCreated");
    const urlUser = url.match(/x\.com\/([^/?#]+)\/status\/(\d+)/i)?.[1]?.toLowerCase();
    if (!tweetId || !articleBody || !url || (expectedUser && urlUser !== expectedUser)) return null;
    return {
      externalId: String(tweetId),
      title: articleBody,
      description: articleBody,
      url,
      publishedAt
    };
  }).filter(Boolean);
  if (!posts.length) throw new Error(`X 公开主页没有返回 @${username || "该账号"} 的可读取内容`);
  return posts.reduce((newest, candidate) => comparePostIds(candidate.externalId, newest.externalId) > 0 ? candidate : newest);
}

export function parseXReaderTimeline(markdown, username) {
  const expectedUser = String(username || "").trim().replace(/^@/, "");
  if (!expectedUser) throw new Error("X Reader 缺少账号名称");
  const escapedUser = expectedUser.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const statusPattern = new RegExp(`https://(?:x\\.com|(?:mobile\\.)?twitter\\.com)/${escapedUser}/status/(\\d+)`, "i");
  const posts = String(markdown || "")
    .split(/\r?\n/)
    .map((line) => {
      const status = line.match(statusPattern);
      if (!status) return null;
      const linkEnd = line.indexOf(")", (status.index || 0) + status[0].length);
      if (linkEnd < 0) return null;
      const primaryText = line
        .slice(linkEnd + 1)
        .split("[![", 1)[0]
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[*_`~]+/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!primaryText) return null;
      return {
        externalId: status[1],
        title: primaryText,
        description: primaryText,
        url: `https://x.com/${expectedUser}/status/${status[1]}`,
        publishedAt: xSnowflakeTimestamp(status[1])
      };
    })
    .filter(Boolean);
  if (!posts.length) throw new Error(`X Reader 没有返回 @${expectedUser} 的可读取内容`);
  return posts.reduce((newest, candidate) => comparePostIds(candidate.externalId, newest.externalId) > 0 ? candidate : newest);
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

function readMetaValue(block, property) {
  const tags = String(block || "").match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (readHtmlAttribute(tag, "itemProp") !== property) continue;
    return decodeXml(readHtmlAttribute(tag, "content")).trim();
  }
  return "";
}

function readHtmlAttribute(tag, attribute) {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(tag || "").match(new RegExp(`${escaped}=["']([^"']*)["']`, "i"))?.[1] || "";
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
    .replaceAll("&gt;", ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
}

function comparePostIds(left, right) {
  try {
    const first = BigInt(String(left));
    const second = BigInt(String(right));
    return first === second ? 0 : first > second ? 1 : -1;
  } catch {
    return String(left).localeCompare(String(right));
  }
}

function xSnowflakeTimestamp(id) {
  try {
    return new Date(Number((BigInt(String(id)) >> 22n) + 1288834974657n)).toISOString();
  } catch {
    return "";
  }
}
