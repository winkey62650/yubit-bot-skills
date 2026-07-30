import { createHash } from "node:crypto";
import { readJson, writeJson } from "./json-store.js";
import { getDistributionRepository } from "./distribution-repository.mjs";
import { createTelegramDelivery } from "./telegram-delivery.mjs";
import { telegramDeliveryEnvironment } from "./telegram-delivery-settings.mjs";
import { telegramMtprotoCall } from "./telegram-mtproto.mjs";
import {
  EDITORIAL_TEMPLATE_VERSION,
  marketStoryIndex,
  renderDailyAnalysisText,
  renderMarketEventsText,
  renderWhaleSignalText
} from "./editorial-template-contract.mjs";
import {
  normalizeSocialPackages,
  parseSocialFeed,
  renderAgentUpdateText,
  socialContentSnapshot,
  socialFetchPlan,
  socialUsername
} from "./social-sources.mjs";

const statePath = "automation-state.json";
const runsPath = "automation-runs.json";
const socialStatePath = "social-crawl-state.json";
const fallbackAppBaseUrl = "https://yubit-bot-skills-academy.vercel.app";
const marketCardTemplateVersion = "market-card-v4";
const FIXED_EDITORIAL_JOBS = new Set(["daily-events", "daily-analysis", "whale-hourly"]);

export const AUTOMATION_JOBS = [
  { id: "news-feed", name: "Crypto News", schedule: "最短每 5 分钟", cron: "*/5 * * * *", topic: "7. YUBIT Updates", bot: "SpeakerBot", content: "新闻图文" },
  { id: "daily-events", name: "Daily Events", schedule: "每日 08:00 UTC", cron: "0 8 * * *", topic: "3. Market Events", bot: "SpeakerBot", content: "图文同步" },
  { id: "daily-analysis", name: "Daily Analysis", schedule: "每日 08:00 UTC", cron: "0 8 * * *", topic: "4. Market Analysis - Crypto/Stocks/TradFi", bot: "SpeakerBot", content: "图文分析" },
  { id: "whale-hourly", name: "大户挂单 & 巨鲸数据", schedule: "每小时检查，重大异动才发布", cron: "0 * * * *", topic: "6. Smart Money Tracker", bot: "SpeakerBot", content: "英文异动图文" },
  { id: "agent-sync-4h", name: "代理群信息更新", schedule: "每小时", cron: "15 * * * *", topic: "2. CryptoGuy Trading Zone", bot: "SpeakerBot", content: "有更新时发布" }
];

export function automationSlot(jobId, date = new Date()) {
  const iso = date.toISOString();
  if (jobId === "news-feed") return `${iso.slice(0, 14)}${String(Math.floor(date.getUTCMinutes() / 5) * 5).padStart(2, "0")}`;
  if (jobId === "daily-events" || jobId === "daily-analysis") return iso.slice(0, 10);
  if (jobId === "whale-hourly" || jobId === "agent-sync-4h") return iso.slice(0, 13);
  const hour = Math.floor(date.getUTCHours() / 4) * 4;
  return `${iso.slice(0, 10)}T${String(hour).padStart(2, "0")}`;
}

export async function getAutomationStatus() {
  const [state, runs, rules] = await Promise.all([
    readJson(statePath, {}),
    readJson(runsPath, []),
    getDistributionRepository().then((repository) => repository.listRules("automation")).catch(() => [])
  ]);
  const targets = await Promise.all(AUTOMATION_JOBS.map(async (job) => {
    const current = distributionTargetsForJob(job, rules);
    return current.configured ? current : resolveTarget(job);
  }));
  return AUTOMATION_JOBS.map((job, index) => ({
    ...job,
    target: targets[index],
    lastRun: state[job.id] || null,
    recentRuns: runs.filter((run) => run.jobId === job.id).slice(0, 5)
  }));
}

const JOB_CONTENT_TYPES = Object.freeze({
  "news-feed": "news",
  "daily-events": "daily-events",
  "daily-analysis": "daily-analysis",
  "whale-hourly": "whale-signals",
  "agent-sync-4h": "agent-sync"
});

export function distributionTargetsForJob(job, rules = []) {
  const contentType = JOB_CONTENT_TYPES[job?.id];
  const matchingRules = (Array.isArray(rules) ? rules : [])
    .filter((rule) => rule?.kind === "automation" && rule?.contentType === contentType && rule?.enabled !== false);
  const seen = new Set();
  const targets = matchingRules.flatMap((rule) => (rule.targets || []).map((target) => ({
    chatId: target.chatId,
    chatType: target.chatType === "channel" ? "channel" : "supergroup",
    threadId: target.threadId,
    group: target.groupName || target.group || target.chatId,
    topic: target.topicName || target.topic || job?.topic,
    ruleId: rule.id,
    enabled: rule.enabled !== false
  }))).filter((target) => {
    const key = target.chatType === "channel"
      ? `${target.chatId}:channel`
      : `${target.chatId}:${target.threadId || 0}`;
    if (!isAutomationDestination(target) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const first = targets[0] || {};
  return {
    chatId: first.chatId || null,
    chatType: first.chatType || null,
    threadId: first.threadId ?? null,
    group: first.group || null,
    topic: first.topic || job?.topic,
    configured: targets.length > 0,
    enabled: matchingRules.some((rule) => rule.enabled !== false),
    count: targets.length,
    targets,
    source: targets.length ? "distribution-database" : null
  };
}

export function isAutomationDestination(target) {
  if (!target?.chatId) return false;
  if (target.chatType === "channel") return true;
  const resolvedThreadId = Number(target.threadId);
  return Number.isInteger(resolvedThreadId) && resolvedThreadId > 0;
}

export function telegramDestinationPayload(target) {
  const payload = { chat_id: target.chatId };
  const resolvedThreadId = Number(target.threadId);
  if (Number.isInteger(resolvedThreadId) && resolvedThreadId > 0) {
    payload.message_thread_id = resolvedThreadId;
  }
  return payload;
}

export async function runAutomationJob(jobId, options = {}) {
  const job = AUTOMATION_JOBS.find((item) => item.id === jobId);
  if (!job) throw new Error(`Unknown automation job: ${jobId}`);
  const dryRun = options.dryRun !== false;
  const force = options.force === true;
  const now = options.now ? new Date(options.now) : new Date();
  const slot = automationSlot(jobId, now);
  const stateKey = options.stateKey || jobId;
  const state = await readJson(statePath, {});

  if (!dryRun && !force && state[stateKey]?.slot === slot) {
    return logRun({ job, slot, dryRun, status: "duplicate", message: "当前时间窗口已执行，已阻止重复发送。", target: state[stateKey].target || null });
  }

  try {
    const targets = Array.isArray(options.targets) && options.targets.length
      ? options.targets
      : [await resolveTarget(job)].filter(Boolean);
    const target = targets[0] || null;
    const generated = await buildContent(jobId, now, { persist: !dryRun });
    const imageUrl = generated.imageKind
      ? buildCardUrl(generated.imageKind, generated.metrics, generated.poster, {
        baseUrl: options.publicBaseUrl,
        cacheKey: generated.contentHash,
      })
      : null;
    const preview = { ...generated, ...automationTemplateMetadata(jobId), imageUrl, target };

    if (dryRun) {
      return logRun({ job, slot, dryRun, status: "success", message: "Dry-run 通过：数据、文案、图片与目标解析正常，未发送 Telegram。", target, preview });
    }

    if (jobId === "news-feed" && generated.contentHash && state[stateKey]?.contentHash === generated.contentHash) {
      return logRun({ job, slot, dryRun, status: "duplicate", message: "新闻链接与内容未变化，已阻止重复发布。", target, preview });
    }

    if (jobId === "whale-hourly" && shouldSuppressWhaleSignal(generated, { force })) {
      return logRun({ job, slot, dryRun, status: "skipped", message: generated.suppressionReason || "本轮没有达到发布标准的巨鲸或大户挂单异动。", target, preview });
    }

    if (jobId === "whale-hourly" && generated.contentHash && state[stateKey]?.contentHash === generated.contentHash) {
      const previousAt = Date.parse(state[stateKey]?.at || "");
      const cooldownMs = Math.max(1, Number(process.env.WHALE_COOLDOWN_HOURS || 6)) * 60 * 60 * 1000;
      if (Number.isFinite(previousAt) && now.getTime() - previousAt < cooldownMs) {
        return logRun({ job, slot, dryRun, status: "duplicate", message: "同一巨鲸信号仍在冷却期内，已阻止重复发布。", target, preview });
      }
    }

    if (jobId === "agent-sync-4h") {
      const sendResult = await sendAgentUpdates(generated.updates || [], options.targets);
      const status = sendResult.targetResults.every((item) => item.status === "success") ? "success" : "partial";
      const next = { slot, at: now.toISOString(), status, target: sendResult.targets, sent: sendResult.sent, targetResults: sendResult.targetResults };
      state[stateKey] = next;
      await writeJson(statePath, state);
      return logRun({ job, slot, dryRun, status, message: sendResult.sent ? `已发送 ${sendResult.sent} 条代理更新。` : "已完成抓取，本轮没有新内容。", target: sendResult.targets, preview: { ...preview, targetResults: sendResult.targetResults } });
    }

    const configuredTargets = targets.filter(isAutomationDestination);
    if (!configuredTargets.length) {
      return logRun({ job, slot, dryRun, status: "skipped", message: `未找到 ${job.topic} 的群/Topic 绑定，未发送。`, target, preview });
    }
    const deliveryPlans = buildAutomationTelegramPlans(jobId, generated, configuredTargets, imageUrl);
    if (options.deferDelivery === true) {
      const targetResults = configuredTargets.map((item) => ({ target: item, status: "pending", messageId: null, messageIds: [] }));
      state[stateKey] = {
        slot,
        at: now.toISOString(),
        contentHash: generated.contentHash || null,
        status: "queued",
        targets: configuredTargets,
        targetResults
      };
      await writeJson(statePath, state);
      return logRun({
        job,
        slot,
        dryRun,
        status: "queued",
        message: `内容已生成并排队，等待管理员账号发送至 ${configuredTargets.length} 个 Demo Topic。`,
        target: configuredTargets,
        preview: { ...preview, deliveryPlans, targetResults }
      });
    }
    const token = tokenForBot(job.bot);
    if (!token) return logRun({ job, slot, dryRun, status: "skipped", message: `${job.bot} Token 未配置，未发送。`, target, preview });
    const targetResults = [];
    for (const item of configuredTargets) {
      const messageIds = [];
      try {
        const plan = deliveryPlans.find((entry) => entry.target === item)?.steps ?? [];
        for (const step of plan) {
          const sent = await telegramCall(token, step.method, step.payload);
          if (sent.message_id) messageIds.push(sent.message_id);
        }
        targetResults.push({ target: item, status: "success", messageId: messageIds[0] || null, messageIds });
      } catch (error) {
        targetResults.push({ target: item, status: "failed", messageId: messageIds[0] || null, messageIds, error: error.message });
      }
    }
    state[stateKey] = { slot, at: now.toISOString(), contentHash: generated.contentHash || null, status: targetResults.every((item) => item.status === "success") ? "success" : "partial", targets: configuredTargets, targetResults };
    await writeJson(statePath, state);
    return logRun({ job, slot, dryRun, status: targetResults.every((item) => item.status === "success") ? "success" : "partial", message: `Telegram 图文已发送至 ${targetResults.filter((item) => item.status === "success").length}/${targetResults.length} 个目标。`, target: configuredTargets, preview: { ...preview, targetResults } });
  } catch (error) {
    await logRun({ job, slot, dryRun, status: "failed", message: error.message });
    throw error;
  }
}

async function buildContent(jobId, now, options = {}) {
  if (jobId === "news-feed") return buildNewsFeed(now);
  if (jobId === "daily-events") return buildDailyEvents(now);
  if (jobId === "daily-analysis") return buildDailyAnalysis(now);
  if (jobId === "whale-hourly") return buildWhaleHourly(now);
  return buildAgentUpdates(now, options);
}

async function buildNewsFeed(now) {
  const sourceUrl = process.env.NEWS_RSS_URL || "https://cointelegraph.com/rss";
  const response = await fetchWithTimeout(sourceUrl, { headers: { "user-agent": "YUBITBot/1.0" } });
  if (!response.ok) throw new Error(`News feed returned HTTP ${response.status}`);
  const xml = await response.text();
  const items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].slice(0, Number(process.env.NEWS_LIMIT || 4)).map((match) => {
    const block = match[0];
    return {
      title: decodeXml(readXmlTag(block, "title")),
      link: decodeXml(readXmlTag(block, "link")).trim(),
      publishedAt: decodeXml(readXmlTag(block, "pubDate"))
    };
  }).filter((item) => item.title && item.link);
  if (!items.length) throw new Error("News feed did not return readable items");
  const contentHash = createHash("sha256").update(items.map((item) => `${item.link}\n${item.title}`).join("\n")).digest("hex");
  const lines = items.map((item, index) => `${index + 1}. <a href="${escapeHtml(item.link)}">${escapeHtml(item.title)}</a>`);
  return {
    imageKind: "news",
    metrics: ["MARKET HEADLINES", "SOURCE-LINKED"],
    caption: `<b>📰 Crypto News Update</b>\n\n${lines.join("\n\n")}\n\n<i>Source feed · Links and content hash are deduplicated.</i>`,
    items,
    contentHash
  };
}

function readXmlTag(block, tag) {
  return block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1]?.replace(/^<!\[CDATA\[|\]\]>$/g, "") || "";
}

function decodeXml(value) {
  return decodeEntities(String(value).replaceAll("&#8211;", "–").replaceAll("&#8212;", "—").replaceAll("&#039;", "'"));
}

async function buildDailyEvents(now) {
  const day = now.toISOString().slice(0, 10);
  let payload;
  if (process.env.DAILY_EVENTS_API_URL) {
    const headers = { accept: "application/json" };
    if (process.env.DAILY_EVENTS_API_TOKEN) {
      headers.authorization = `Bearer ${process.env.DAILY_EVENTS_API_TOKEN}`;
      headers["x-api-key"] = process.env.DAILY_EVENTS_API_TOKEN;
    }
    payload = await fetchJson(process.env.DAILY_EVENTS_API_URL, { headers });
  } else {
    const from = `${day}T00:00:00.000Z`;
    const to = `${day}T23:59:59.999Z`;
    const url = `https://economic-calendar.tradingview.com/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&countries=US,CN,GB,JP,EU`;
    const [calendarResult, newsResult] = await Promise.allSettled([
      fetchJson(url, { headers: { "user-agent": "Mozilla/5.0", origin: "https://www.tradingview.com", referer: "https://www.tradingview.com/" } }),
      fetchMarketNews(now)
    ]);
    const calendar = calendarResult.status === "fulfilled" ? calendarResult.value : {};
    const calendarStories = (calendar.result || calendar.events || [])
      .filter((event) => Number(event.importance ?? event.impact ?? 0) >= 1)
      .sort((a, b) => Number(b.importance ?? b.impact ?? 0) - Number(a.importance ?? a.impact ?? 0))
      .slice(0, 4)
      .map((event) => ({
        title: event.title || event.name || "Market catalyst",
        summary: `${event.country || event.currency || "Global"} catalyst${event.date || event.time ? ` scheduled for ${new Date(event.date || event.time).toISOString().slice(11, 16)} UTC` : ""}. Watch the release versus consensus and the immediate rates, equity and crypto response.`,
        source: "TradingView Economic Calendar",
        url: "https://www.tradingview.com/economic-calendar/",
        category: "Macro"
      }));
    const newsStories = newsResult.status === "fulfilled" ? newsResult.value : [];
    const stories = [...newsStories.slice(0, 6), ...calendarStories].slice(0, 8);
    if (!stories.length) throw new Error("No verified market-event source returned readable stories");
    payload = {
      date: day,
      stories,
      summary: buildMarketEventsExecutiveSummary(stories),
      subline: `${newsStories.length ? "CRYPTO" : "MARKETS"} · ${calendarStories.length ? "MACRO" : "CATALYSTS"} · VERIFIED SOURCES`
    };
  }
  return buildDailyMarketBrief(payload, now);
}

export function buildMarketEventsExecutiveSummary(stories = []) {
  const labels = [...new Set(stories.map((story) => String(story?.category || "").trim().toLowerCase()).filter(Boolean))]
    .slice(0, 3);
  const coverage = labels.length === 0
    ? "cross-asset developments"
    : labels.length === 1
      ? `${labels[0]} developments`
      : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)} developments`;
  return `Today's desk brief distills the most consequential ${coverage}, prioritizing market impact over volume. Each selected item includes a source link for verification before distribution.`;
}

async function fetchMarketNews(now) {
  const sourceUrl = process.env.MARKET_EVENTS_RSS_URL || "https://cointelegraph.com/rss";
  const response = await fetchWithTimeout(sourceUrl, { headers: { accept: "application/rss+xml, text/xml", "user-agent": "YubitCommunityBot/2.0" } });
  if (!response.ok) throw new Error(`Market events feed returned HTTP ${response.status}`);
  const xml = await response.text();
  const cutoff = now.getTime() - 48 * 60 * 60 * 1000;
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => {
    const block = match[0];
    const publishedAt = decodeXml(readXmlTag(block, "pubDate"));
    const description = cleanFeedText(decodeXml(readXmlTag(block, "description")));
    return {
      title: cleanFeedText(decodeXml(readXmlTag(block, "title"))),
      summary: description.slice(0, 320),
      url: decodeXml(readXmlTag(block, "link")).trim(),
      source: new URL(sourceUrl).hostname.includes("cointelegraph") ? "Cointelegraph" : new URL(sourceUrl).hostname,
      category: "Crypto",
      publishedAt
    };
  }).filter((item) => item.title && item.url && (!Date.parse(item.publishedAt) || Date.parse(item.publishedAt) >= cutoff));
}

export function buildDailyMarketBrief(payload, now = new Date()) {
  const body = Array.isArray(payload) ? { stories: payload } : (payload?.data && !Array.isArray(payload.data) ? { ...payload.data, ...payload } : payload || {});
  const rawStories = body.stories || body.items || body.events || (Array.isArray(body.data) ? body.data : []);
  const normalized = rawStories.map((story) => {
    if (typeof story === "string") return { text: story.trim(), source: "", url: "", category: "" };
    const title = String(story?.title || story?.headline || story?.name || "").trim();
    const summary = String(story?.summary || story?.description || story?.detail || story?.content || "").trim();
    const text = title && summary && !summary.toLowerCase().startsWith(title.toLowerCase()) ? `${title}: ${summary}` : summary || title;
    return { text, source: String(story?.source || story?.publisher || "").trim(), url: safeExternalUrl(story?.url || story?.link), category: String(story?.category || "").trim() };
  }).filter((item) => item.text);
  const items = [];
  let used = 0;
  for (const item of normalized) {
    const next = `${formatMarketStoryIndex(items.length + 1)} ${item.text}`;
    if (used + next.length > 3400 && items.length) break;
    items.push(item);
    used += next.length + 2;
  }
  if (!items.length) items.push({ text: "No material market event was available from the configured source at publication time.", source: "", url: "", category: "" });
  const sourceDate = body.date ? new Date(`${String(body.date).slice(0, 10)}T00:00:00.000Z`) : new Date(now);
  const validDate = Number.isNaN(sourceDate.getTime()) ? new Date(now) : sourceDate;
  const dateLabel = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric" }).format(validDate).toUpperCase();
  const headline = `MORNING MARKET BRIEF · ${dateLabel}`;
  const summary = String(body.summary || body.overview || body.dek || items.slice(0, 3).map((item) => item.text).join(" ")).trim();
  const subline = String(body.subline || body.tagline || "GLOBAL MARKETS · CRYPTO · COMPANIES").trim().toUpperCase();
  const caption = buildMarketBriefPhotoCaption(headline, items);
  const fullText = renderMarketEventsText({
    headline,
    stories: items.map((item) => ({ ...item, url: compactSourceUrl(item.url) })),
    html: true
  });
  const contentHash = createHash("sha256").update(JSON.stringify({
    dateLabel,
    subline,
    stories: items.map((item) => ({ text: item.text, source: item.source, url: item.url, category: item.category })),
  })).digest("hex");
  return {
    imageKind: "events",
    metrics: [],
    poster: { dateLabel, subline },
    headline,
    dateLabel,
    subline,
    summary,
    caption,
    fullText,
    items: items.map((item) => item.text),
    stories: items,
    contentHash,
  };
}

export function buildDailyMarketBriefTelegramPlan(generated, target, imageUrl) {
  return [
    { method: "sendPhoto", payload: {
      ...telegramDestinationPayload(target),
      photo: imageUrl
    } },
    { method: "sendMessage", payload: {
      ...telegramDestinationPayload(target),
      text: String(generated.fullText || "").slice(0, 4096),
      parse_mode: "HTML",
      disable_web_page_preview: true
    } }
  ];
}

export function buildAutomationTelegramPlans(jobId, generated, targets, imageUrl) {
  return (Array.isArray(targets) ? targets : []).map((target) => ({
    target,
    templateVersion: EDITORIAL_TEMPLATE_VERSION,
    contentPolicy: "fixed-template",
    steps: jobId === "daily-events"
      ? buildDailyMarketBriefTelegramPlan(generated, target, imageUrl)
      : [{ method: "sendPhoto", payload: {
        ...telegramDestinationPayload(target),
        photo: imageUrl,
        caption: trimTelegramCaption(generated?.caption),
        parse_mode: "HTML"
      } }]
  }));
}

export function automationTemplateMetadata(jobId) {
  return FIXED_EDITORIAL_JOBS.has(String(jobId || ""))
    ? { templateVersion: EDITORIAL_TEMPLATE_VERSION, contentPolicy: "fixed-template" }
    : {};
}

function buildMarketBriefPhotoCaption(headline, items) {
  const limit = 1024;
  const footer = "<i>Market commentary only.</i>";
  let caption = `<b>🌅 ${escapeHtml(headline)}</b>`;
  let included = 0;

  for (const item of items) {
    const separator = "\n\n";
    const available = limit - caption.length - separator.length - separator.length - footer.length;
    if (available < 80) break;

    let maxText = 180;
    let block = formatMarketBriefCaptionItem(item, included + 1, maxText, true);
    if (block.length > available) {
      maxText = Math.max(80, maxText - (block.length - available));
      block = formatMarketBriefCaptionItem(item, included + 1, maxText, true);
    }
    if (block.length > available) {
      block = formatMarketBriefCaptionItem(item, included + 1, maxText, false);
    }
    if (block.length > available) {
      maxText = Math.max(40, maxText - (block.length - available));
      block = formatMarketBriefCaptionItem(item, included + 1, maxText, false, false);
    }
    if (block.length > available) break;

    caption += `${separator}${block}`;
    included += 1;
  }

  if (!included) {
    const fallback = truncateAtWord(items[0]?.text || "No material market event was available.", 320);
    caption += `\n\n${formatMarketStoryIndex(1)} ${escapeHtml(fallback)}`;
  }
  return `${caption}\n\n${footer}`;
}

function formatMarketBriefCaptionItem(item, index, maxText, includeLink, includeSource = true) {
  const category = item.category ? `<b>${escapeHtml(item.category.toUpperCase())}</b> · ` : "";
  const text = escapeHtml(truncateAtWord(item.text, maxText));
  let source = "";
  if (includeSource && item.source) {
    const compactUrl = compactSourceUrl(item.url);
    source = includeLink && compactUrl
      ? `\n<i>Source: <a href="${escapeHtml(compactUrl)}">${escapeHtml(item.source)}</a></i>`
      : `\n<i>Source: ${escapeHtml(item.source)}</i>`;
  }
  return `${formatMarketStoryIndex(index)} ${category}${text}${source}`;
}

function formatMarketStoryIndex(index) {
  return marketStoryIndex(index);
}

function truncateAtWord(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, Math.max(1, maxLength - 1)).trimEnd();
  const wordBoundary = slice.lastIndexOf(" ");
  const shortened = wordBoundary >= Math.floor(maxLength * 0.6) ? slice.slice(0, wordBoundary) : slice;
  return `${shortened.trimEnd()}…`;
}

async function buildDailyAnalysis(now) {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  const rows = await Promise.all(symbols.map(fetchDailyMarketRow));
  return buildDailyAnalysisSnapshot(rows, now);
}

export function buildDailyAnalysisSnapshot(rows, now = new Date()) {
  const bullish = rows.filter((row) => row.trend === "Bullish").length;
  const regime = bullish >= 2 ? "RISK ON" : bullish === 1 ? "NEUTRAL" : "RISK OFF";
  const btc = rows[0];
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric"
  }).format(now).toUpperCase();
  const breadth = bullish === rows.length
    ? "All tracked assets are trading above their 20-day average."
    : `${bullish} of ${rows.length} tracked assets are trading above their 20-day average.`;
  const momentum = `BTC 24-hour momentum is ${signed(btc.change)}%, with the dashboard classified as ${regime.toLowerCase()}.`;
  const levels = `BTC spot $${formatNumber(btc.price)} · SMA20 $${formatNumber(btc.sma20)}`;
  const catalyst = "24H momentum and cross-asset flow";
  return {
    imageKind: "analysis",
    metrics: [`${bullish}/3 above SMA20`, `BTC ${signed(rows[0].change)}% 24h`],
    poster: {
      regime,
      levels,
      catalyst: "24H MOMENTUM · CROSS-ASSET FLOW"
    },
    caption: renderDailyAnalysisText({
      dateLabel,
      regime,
      rows: rows.map((row) => ({
        symbol: row.symbol,
        price: formatNumber(row.price),
        change: signed(row.change),
        trend: row.trend
      })),
      keyRead: `${breadth} ${momentum}`,
      levels,
      catalyst,
      html: true
    }),
    items: rows
  };
}

async function buildWhaleHourly(now) {
  return buildWhaleAlert(await fetchWhaleMarketData(), now);
}

export function buildWhaleAlert(market, now = new Date()) {
  const bids = market.bids.map(([price, qty]) => ({ price: Number(price), qty: Number(qty), notional: Number(price) * Number(qty) }));
  const asks = market.asks.map(([price, qty]) => ({ price: Number(price), qty: Number(qty), notional: Number(price) * Number(qty) }));
  const bidTotal = sum(bids.map((item) => item.notional));
  const askTotal = sum(asks.map((item) => item.notional));
  const imbalance = ((bidTotal - askTotal) / Math.max(bidTotal + askTotal, 1)) * 100;
  const largestBid = bids.sort((a, b) => b.notional - a.notional)[0];
  const largestAsk = asks.sort((a, b) => b.notional - a.notional)[0];
  const rows = { bidTotal, askTotal, imbalance, largestBid, largestAsk, openInterest: market.openInterest, funding: market.funding, markPrice: market.markPrice, source: market.source };
  const isBid = largestBid.notional >= largestAsk.notional;
  const order = isBid ? largestBid : largestAsk;
  const sourceName = String(market.source || "Market data").replace(/\s+fallback$/i, "");
  const timestamp = new Date(now).toISOString().replace("T", " ").slice(0, 16);
  const minNotional = Math.max(1, Number(process.env.WHALE_MIN_NOTIONAL_USD || 1_000_000));
  const minImbalance = Math.max(0, Number(process.env.WHALE_MIN_IMBALANCE_PCT || 15));
  const opposite = isBid ? largestAsk : largestBid;
  const publishable = order.notional >= minNotional && (Math.abs(imbalance) >= minImbalance || order.notional >= opposite.notional * 2);
  const action = isBid ? "Large bid added" : "Large ask added";
  const state = isBid ? "Buy-wall support" : "Sell-wall pressure";
  const directionRead = isBid
    ? "If the bid remains and grows, near-term support may strengthen. A rapid fill or cancellation would weaken that read and could signal a reversal."
    : "If the ask remains and grows, near-term selling pressure may intensify. Fast absorption or cancellation would weaken that read and could signal a reversal.";
  const concentrationRead = publishable
    ? "showed a material liquidity concentration"
    : "showed the largest visible liquidity concentration in the current snapshot";
  const caption = renderWhaleSignalText({
    timestamp,
    pair: "BTC/USDT",
    concentrationRead,
    quantity: formatQuantity(order.qty),
    asset: "BTC",
    notional: formatCompact(order.notional),
    action,
    price: formatNumber(order.price),
    state,
    imbalance: signed(imbalance),
    directionRead,
    watchNext: `Whether liquidity near $${formatNumber(order.price)} is filled, increased or cancelled.`,
    html: true
  });
  const contentHash = createHash("sha256").update(JSON.stringify({
    sourceName,
    side: isBid ? "bid" : "ask",
    priceBucket: Math.round(order.price / 100) * 100,
    notionalBucket: Math.round(order.notional / 250000) * 250000,
    imbalanceBucket: Math.round(imbalance / 5) * 5
  })).digest("hex");
  return {
    imageKind: "whale",
    metrics: [`Orderbook ${signed(imbalance)}%`, `OI ${formatCompact(rows.openInterest)} BTC`],
    poster: {
      pair: "BTC / USDT",
      signal: isBid ? "LARGE BID" : "LARGE ASK",
      amount: `$${formatCompact(order.notional)}`,
      price: `$${formatNumber(order.price)}`,
      status: isBid ? "BUY WALL SUPPORT" : "SELL WALL PRESSURE"
    },
    caption,
    items: rows,
    publishable,
    suppressionReason: publishable ? null : `Signal below publication threshold: minimum $${formatCompact(minNotional)} visible notional and ${minImbalance}% depth imbalance (or 2x opposing order).`,
    contentHash
  };
}

async function fetchDailyMarketRow(symbol) {
  try {
    const [ticker, candles] = await Promise.all([
      fetchJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`),
      fetchJson(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=21`)
    ]);
    const closes = candles.map((item) => Number(item[4]));
    const sma20 = average(closes.slice(-20));
    const price = Number(ticker.lastPrice);
    return { symbol: symbol.replace("USDT", ""), price, change: Number(ticker.priceChangePercent), sma20, trend: price >= sma20 ? "Bullish" : "Bearish", source: "Binance" };
  } catch {
    const asset = symbol.replace("USDT", "");
    const instId = `${asset}-USDT`;
    const [tickerBody, candlesBody] = await Promise.all([
      fetchJson(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`),
      fetchJson(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=1Dutc&limit=21`)
    ]);
    const ticker = tickerBody.data?.[0];
    const candles = candlesBody.data || [];
    if (!ticker || candles.length < 20) throw new Error(`OKX market data unavailable for ${instId}`);
    const closes = candles.map((item) => Number(item[4])).reverse();
    const price = Number(ticker.last);
    const open24h = Number(ticker.open24h);
    const change = open24h ? ((price - open24h) / open24h) * 100 : 0;
    const sma20 = average(closes.slice(-20));
    return { symbol: asset, price, change, sma20, trend: price >= sma20 ? "Bullish" : "Bearish", source: "OKX fallback" };
  }
}

async function fetchWhaleMarketData() {
  try {
    const [depth, openInterest, premium] = await Promise.all([
      fetchJson("https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=100"),
      fetchJson("https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT"),
      fetchJson("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT")
    ]);
    return {
      bids: depth.bids,
      asks: depth.asks,
      openInterest: Number(openInterest.openInterest),
      funding: Number(premium.lastFundingRate) * 100,
      markPrice: Number(premium.markPrice),
      source: "Binance"
    };
  } catch {
    const instId = "BTC-USDT-SWAP";
    const [booksBody, oiBody, fundingBody, markBody] = await Promise.all([
      fetchJson(`https://www.okx.com/api/v5/market/books?instId=${instId}&sz=100`),
      fetchJson(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${instId}`),
      fetchJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`),
      fetchJson(`https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=${instId}`)
    ]);
    const book = booksBody.data?.[0];
    const oi = oiBody.data?.[0];
    const funding = fundingBody.data?.[0];
    const mark = markBody.data?.[0];
    if (!book?.bids?.length || !book?.asks?.length || !mark) throw new Error("OKX whale data unavailable");
    const contractBtc = 0.01;
    return {
      bids: book.bids.map(([price, contracts]) => [price, Number(contracts) * contractBtc]),
      asks: book.asks.map(([price, contracts]) => [price, Number(contracts) * contractBtc]),
      openInterest: Number(oi?.oiCcy || Number(oi?.oi || 0) * contractBtc),
      funding: Number(funding?.fundingRate || 0) * 100,
      markPrice: Number(mark.markPx),
      source: "OKX fallback"
    };
  }
}

async function buildAgentUpdates(now, { persist = true } = {}) {
  const stored = await readJson("social-packages.json", { packages: [] });
  const packages = normalizeSocialPackages(Array.isArray(stored) ? stored : stored.packages || []);
  const previous = await readJson(socialStatePath, {});
  const next = { ...previous };
  const updates = [];
  const checks = [];

  for (const item of packages.filter((pkg) => pkg.status === "已启用")) {
    const urls = extractUrls(item.accountUrl);
    if (!urls.length && item.feedUrl) urls.push(item.feedUrl);
    if (!urls.length) {
      checks.push({ agent: item.agent, status: "skipped", reason: "未配置有效 URL" });
      continue;
    }
    for (const url of urls) {
      try {
        const snapshot = await fetchSocialSource({ ...item, accountUrl: url });
        const key = `${item.id || item.agent}:${url}`;
        const changed = Boolean(previous[key]?.hash && previous[key].hash !== snapshot.hash);
        next[key] = { ...snapshot, checkedAt: now.toISOString() };
        checks.push({ agent: item.agent, platform: item.platform, url, contentUrl: snapshot.url, reliability: snapshot.reliability, status: changed ? "updated" : previous[key] ? "unchanged" : "baseline", title: snapshot.title });
        if (changed) updates.push({ ...snapshot, agent: item.agent, package: item, accountUrl: url });
      } catch (error) {
        checks.push({ agent: item.agent, url, status: "failed", reason: error.message });
      }
    }
  }
  if (persist) await writeJson(socialStatePath, next);
  return {
    imageKind: null,
    metrics: [`${checks.length} sources`, `${updates.length} updates`],
    caption: `Agent sync checked ${checks.length} source(s); ${updates.length} update(s).`,
    items: checks,
    updates
  };
}

export async function previewSocialSource(source) {
  const [normalized] = normalizeSocialPackages([source]);
  if (!normalized) throw new Error("请填写代理名称和来源名称");
  if (!normalized.accountUrl && !normalized.feedUrl) throw new Error("请填写账号主页或 Feed 地址");
  const snapshot = await fetchSocialSource(normalized);
  return {
    agent: normalized.agent,
    platform: normalized.platform,
    title: snapshot.title,
    description: snapshot.description,
    url: snapshot.url,
    publishedAt: snapshot.publishedAt,
    reliability: snapshot.reliability,
    strategy: snapshot.strategy
  };
}

async function sendAgentUpdates(updates, configuredTargets) {
  let sent = 0;
  const targets = (Array.isArray(configuredTargets) ? configuredTargets : []).filter(Boolean);
  const targetKey = (target) => target?.chatType === "channel"
    ? `${target.chatId}:channel`
    : `${target.chatId}:${target.threadId}`;
  const resultMap = new Map(targets.map((target) => [targetKey(target), { target, status: "success", messageIds: [] }]));
  const token = tokenForBot("SpeakerBot");
  if (!token) return { sent, targets, targetResults: targets.map((target) => ({ target, status: "failed", error: "SpeakerBot Token 未配置" })) };
  for (const update of updates) {
    const resolvedTargets = Array.isArray(configuredTargets) && configuredTargets.length ? configuredTargets : [await resolveAgentTarget(update.agent)];
    for (const target of resolvedTargets) {
      if (!isAutomationDestination(target)) continue;
      const key = targetKey(target);
      if (!resultMap.has(key)) {
        targets.push(target);
        resultMap.set(key, { target, status: "success", messageIds: [] });
      }
      try {
        const message = await telegramCall(token, "sendMessage", {
          ...telegramDestinationPayload(target),
          text: escapeHtml(renderAgentUpdateText(update)),
          parse_mode: "HTML",
          disable_web_page_preview: false
        });
        resultMap.get(key).messageIds.push(message.message_id || null);
        sent += 1;
      } catch (error) {
        resultMap.set(key, { ...resultMap.get(key), status: "failed", error: error.message });
      }
    }
  }
  return { sent, targets, targetResults: [...resultMap.values()].map((item) => ({ ...item, messageId: item.messageIds.at(-1) || null })) };
}

async function resolveTarget(job) {
  const envPrefix = job.id.replaceAll("-", "_").toUpperCase();
  const envChatId = process.env[`${envPrefix}_CHAT_ID`];
  const envThreadId = Number(process.env[`${envPrefix}_THREAD_ID`] || 0);
  if (envChatId && envThreadId) return { chatId: envChatId, threadId: envThreadId, group: "Environment override", topic: job.topic, configured: true };

  const config = await readJson("group-config.json", {});
  const groups = Array.isArray(config.groups) ? config.groups : [];
  const bindings = Array.isArray(config.bindings) ? config.bindings : [];
  const binding = bindings.find((item) => item.status !== "暂停" && automationTopicMatches(item.topic, job.topic));
  if (!binding) return { configured: false, topic: job.topic };
  const group = groups.find((item) => item.title === binding.group);
  const topic = group?.topics?.find((item) => automationTopicMatches(item.name, binding.topic));
  const threadId = Number(binding.topicId || topic?.threadId || 0) || null;
  return { chatId: group?.chatId || null, threadId, group: binding.group, topic: binding.topic, configured: Boolean(group?.chatId && threadId) };
}

async function resolveAgentTarget(agent) {
  const config = await readJson("group-config.json", {});
  const groups = Array.isArray(config.groups) ? config.groups : [];
  const bindings = Array.isArray(config.bindings) ? config.bindings : [];
  const binding = bindings.find((item) => item.type === "代理社媒" && item.status !== "暂停" && (String(item.config).toLowerCase().includes(String(agent).toLowerCase()) || String(item.topic).toLowerCase().includes(String(agent).toLowerCase())));
  if (!binding) return { configured: false, agent };
  const group = groups.find((item) => item.title === binding.group);
  const topic = group?.topics?.find((item) => automationTopicMatches(item.name, binding.topic));
  const threadId = Number(binding.topicId || topic?.threadId || 0) || null;
  return { chatId: group?.chatId || null, threadId, group: binding.group, topic: binding.topic, configured: Boolean(group?.chatId && threadId), agent };
}

function comparableTopicName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/^[^\p{Letter}\p{Number}]+/u, "")
    .replace(/^\d+\s*[.、)]\s*/, "")
    .trim()
    .toLowerCase();
}

export function automationTopicMatches(value, expected) {
  const normalized = comparableTopicName(value);
  const wanted = comparableTopicName(expected);
  return Boolean(normalized && wanted && (
    normalized === wanted || normalized.includes(wanted) || wanted.includes(normalized)
  ));
}

async function logRun({ job, slot, dryRun, status, message, target = null, preview = null }) {
  const entry = { id: `${job.id}-${Date.now()}`, jobId: job.id, jobName: job.name, slot, dryRun, status, message, target, preview, createdAt: new Date().toISOString() };
  const runs = await readJson(runsPath, []);
  await writeJson(runsPath, [entry, ...(Array.isArray(runs) ? runs : [])].slice(0, 100));
  return entry;
}

export function buildCardUrl(kind, metrics = [], poster = {}, options = {}) {
  const query = new URLSearchParams({ kind, v: marketCardTemplateVersion });
  const cacheKey = String(options.cacheKey || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  if (cacheKey) query.set("rev", cacheKey);
  metrics.slice(0, 3).forEach((metric, index) => query.set(`m${index + 1}`, String(metric)));
  if (poster?.dateLabel) query.set("date", String(poster.dateLabel));
  if (poster?.subline) query.set("subline", String(poster.subline));
  for (const key of ["regime", "levels", "catalyst", "pair", "signal", "amount", "price", "status"]) {
    if (poster?.[key]) query.set(key, String(poster[key]));
  }
  return `${resolveAppBaseUrl(options.baseUrl)}/api/media/card?${query}`;
}

function resolveAppBaseUrl(explicitBaseUrl) {
  const candidates = [
    explicitBaseUrl,
    process.env.APP_BASE_URL,
    process.env.APP_DEPLOYMENT_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    fallbackAppBaseUrl
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(String(candidate));
      if (!/^https?:$/.test(url.protocol)) continue;
      url.username = "";
      url.password = "";
      url.pathname = "";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/, "");
    } catch {
      // Continue to the next trusted deployment URL.
    }
  }
  return fallbackAppBaseUrl;
}

export function resolveAutomationPreviewBaseUrl(requestUrl, env = process.env) {
  const publicBaseUrl = env.APP_BASE_URL || env.APP_DEPLOYMENT_URL || env.NEXT_PUBLIC_APP_URL;
  return resolveAppBaseUrl(publicBaseUrl || requestUrl);
}

export function shouldSuppressWhaleSignal(generated, options = {}) {
  return generated?.publishable === false && options.force !== true;
}

async function fetchSocialSource(source) {
  const plan = socialFetchPlan(source);
  if (plan.kind === "feed" || plan.kind === "youtube-feed") {
    return fetchSocialFeed(plan.url, plan);
  }
  if (plan.kind === "youtube-page") {
    const response = await fetchWithTimeout(plan.url, { headers: browserHeaders() });
    if (!response.ok) throw new Error(`YouTube 主页返回 HTTP ${response.status}`);
    const html = (await response.text()).slice(0, 1000000);
    const channelId = html.match(/"channelId":"([^"]+)"/i)?.[1]
      || html.match(/channel_id=([^&"']+)/i)?.[1]
      || html.match(/youtube\.com\/channel\/([^/?#"']+)/i)?.[1];
    if (!channelId) throw new Error("无法从 YouTube 主页解析频道 ID，请填写 /channel/UC… 地址或自定义 Feed");
    return fetchSocialFeed(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, { kind: "youtube-feed", reliability: "stable" });
  }
  if (plan.kind === "x-api") return fetchLatestXPost(source);
  return fetchSocialPage(plan.url, plan);
}

async function fetchSocialFeed(url, plan) {
  const response = await fetchWithTimeout(url, { headers: { accept: "application/atom+xml, application/rss+xml, application/json, text/xml;q=0.9", "user-agent": "YubitCommunityBot/2.0" } });
  if (!response.ok) throw new Error(`内容 Feed 返回 HTTP ${response.status}`);
  const raw = await response.text();
  let item;
  try {
    const json = JSON.parse(raw);
    const values = Array.isArray(json) ? json : json.items || json.data?.items || json.data || [];
    const first = Array.isArray(values) ? values[0] : values;
    item = {
      externalId: first?.id || first?.guid || first?.url || first?.link,
      title: first?.title || first?.text || first?.content,
      description: first?.description || first?.summary || first?.text || "",
      url: first?.url || first?.link,
      publishedAt: first?.publishedAt || first?.published_at || first?.date || ""
    };
  } catch {
    item = parseSocialFeed(raw);
  }
  if (!item?.externalId || !item?.title || !item?.url) throw new Error("内容 Feed 最新项目缺少标题、链接或唯一编号");
  return socialContentSnapshot(item, { reliability: plan.reliability, strategy: plan.kind });
}

async function fetchLatestXPost(source) {
  const username = socialUsername(source);
  if (!username) throw new Error("无法识别 X 用户名，请填写完整的 x.com 主页地址");
  const headers = { accept: "application/json", authorization: `Bearer ${process.env.X_BEARER_TOKEN}`, "user-agent": "YubitCommunityBot/2.0" };
  const profile = await fetchJson(`https://api.x.com/2/users/by/username/${encodeURIComponent(username)}`, { headers });
  const userId = profile.data?.id;
  if (!userId) throw new Error(`X API 未找到 @${username}`);
  const timeline = await fetchJson(`https://api.x.com/2/users/${encodeURIComponent(userId)}/tweets?max_results=5&exclude=retweets,replies&tweet.fields=created_at`, { headers });
  const post = timeline.data?.[0];
  if (!post?.id || !post?.text) throw new Error(`X API 没有返回 @${username} 的新内容`);
  const url = `https://x.com/${username}/status/${post.id}`;
  return socialContentSnapshot({ externalId: post.id, title: post.text.slice(0, 180), description: post.text, url, publishedAt: post.created_at || "" }, { reliability: "stable", strategy: "x-api" });
}

async function fetchSocialPage(url, plan) {
  if (!url) throw new Error("账号主页地址未配置");
  const response = await fetchWithTimeout(url, { headers: browserHeaders() });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = (await response.text()).slice(0, 500000);
  const title = decodeEntities(matchMeta(html, "og:title") || matchTag(html, "title") || url);
  const description = decodeEntities(matchMeta(html, "og:description") || matchMeta(html, "description") || "").slice(0, 400);
  return socialContentSnapshot({ externalId: `${url}:${title}:${description}`, title, description, url, publishedAt: "" }, { reliability: plan.reliability, strategy: plan.kind });
}

function browserHeaders() {
  return { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0 (compatible; YubitCommunityBot/2.0)" };
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${response.status}`);
  return response.json();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    return await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

async function telegramBotApiCall(token, method, payload, fetchImpl = fetch) {
  const endpoint = `https://api.telegram.org/bot${token}/${method}`;
  const response = await fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const body = await response.json().catch(() => ({}));
  if ((!response.ok || !body.ok)
    && method === "sendPhoto"
    && /^https?:\/\//i.test(String(payload?.photo || ""))
    && /(failed to get HTTP URL content|wrong type of the web page content)/i.test(String(body.description || ""))) {
    const imageResponse = await fetchImpl(payload.photo, { cache: "no-store" });
    if (!imageResponse.ok) throw new Error(`${method} failed: ${body.description}; poster download HTTP ${imageResponse.status}`);
    const form = new FormData();
    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined || value === null) continue;
      if (key === "photo") {
        const contentType = imageResponse.headers.get("content-type") || "image/png";
        form.set("photo", new Blob([await imageResponse.arrayBuffer()], { type: contentType }), `poster.${contentType.includes("jpeg") ? "jpg" : "png"}`);
      } else {
        form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
    }
    const uploadResponse = await fetchImpl(endpoint, { method: "POST", body: form });
    const uploadBody = await uploadResponse.json().catch(() => ({}));
    if (!uploadResponse.ok || !uploadBody.ok) throw new Error(`${method} failed: ${uploadBody.description || `HTTP ${uploadResponse.status}`}`);
    return uploadBody.result || {};
  }
  if (!response.ok || !body.ok) throw new Error(`${method} failed: ${body.description || `HTTP ${response.status}`}`);
  return body.result || {};
}

export async function telegramCall(token, method, payload, fetchImpl = fetch, options = {}) {
  const env = await telegramDeliveryEnvironment("publish", options.env ?? process.env);
  const deliver = createTelegramDelivery({
    env,
    botApiCall: (botToken, botMethod, botPayload) => telegramBotApiCall(botToken, botMethod, botPayload, fetchImpl),
    userPublisherCall: options.userPublisherCall ?? options.groupIdentityCall ?? telegramMtprotoCall
  });
  return deliver(token, method, payload);
}

function tokenForBot(bot) {
  if (bot === "SpeakerBot") return process.env.SPEAKER_BOT_TOKEN || process.env.TRADER1_BOT_TOKEN;
  if (bot === "ForwardBot") return process.env.FORWARD_BOT_TOKEN;
  return process.env.YUBITADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
}

function extractUrls(value) {
  return String(value || "").match(/https?:\/\/[^\s,;]+/g) || [];
}

function matchMeta(html, key) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`, "i")
  ];
  return patterns.map((pattern) => html.match(pattern)?.[1]).find(Boolean) || "";
}

function matchTag(html, tag) {
  return html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, "i"))?.[1]?.replace(/<[^>]+>/g, "").trim() || "";
}

function decodeEntities(value) {
  return String(value).replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function cleanFeedText(value) {
  return decodeEntities(String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function compactSourceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
    }
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function trimTelegramCaption(value) {
  const text = String(value);
  return text.length <= 1024 ? text : `${text.slice(0, 1000)}\n…`;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function average(values) { return sum(values) / Math.max(values.length, 1); }
function sum(values) { return values.reduce((total, value) => total + Number(value || 0), 0); }
function formatNumber(value) { return Number(value).toLocaleString("en-US", { maximumFractionDigits: Number(value) < 10 ? 3 : 0 }); }
function formatCompact(value) { return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(Number(value)); }
function formatQuantity(value) { return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(Number(value)); }
function signed(value, digits = 2) { const number = Number(value); return `${number >= 0 ? "+" : ""}${number.toFixed(digits)}`; }
