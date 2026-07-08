import process from "node:process";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const telegramBase = "https://api.telegram.org/bot";
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const threadId = Number(process.env.TELEGRAM_THREAD_ID || 14);
const shouldSend = process.env.SEND_TELEGRAM === "true";
const mode = process.env.NEWS_MODE || "crypto";
const maxRecords = Number(process.env.NEWS_LIMIT || 6);

const presets = {
  crypto: {
    title: "YUBIT Crypto News",
    threadId: 14,
    query: '(cryptocurrency OR bitcoin OR ethereum OR stablecoin OR "spot ETF" OR blockchain OR DeFi OR Binance OR Coinbase) sourcelang:english',
    note: "Use official sources where possible. Avoid rumors, phishing links, and fake announcements."
  },
  tradfi: {
    title: "YUBIT Stocks & TradFi News",
    threadId: 16,
    query: '("Federal Reserve" OR FOMC OR CPI OR NFP OR "US stocks" OR Nasdaq OR "S&P 500" OR Treasury OR yields OR oil OR gold OR dollar) sourcelang:english',
    note: "Major data releases can increase volatility. Manage risk carefully."
  }
};

const preset = presets[mode] || presets.crypto;
const targetThreadId = Number(process.env.TELEGRAM_THREAD_ID || preset.threadId);
const articles = await fetchNews(preset, maxRecords);
const message = formatNews(preset, articles);

console.log(message);

if (shouldSend) {
  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required when SEND_TELEGRAM=true");
  }

  const photoPath = await renderNewsCard(preset, articles);
  await postTelegramPhoto(formatNewsCaption(preset, articles), targetThreadId, photoPath, articles[0]?.url);
}

async function fetchNews(preset, limit) {
  try {
    return await fetchGdelt(preset.query, limit);
  } catch (error) {
    return fetchGoogleNews(preset, limit);
  }
}

async function fetchGdelt(query, limit) {
  const params = new URLSearchParams({
    query,
    mode: "ArtList",
    format: "json",
    maxrecords: String(limit),
    sort: "HybridRel",
    timespan: "24h"
  });
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?${params}`;
  let data;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      const response = await fetch(url, {
        headers: { "user-agent": "YUBITCommunityBot/1.0" },
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`GDELT request failed: ${response.status}`);
      data = await response.json();
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(3000 * attempt);
    }
  }
  return (data.articles || []).slice(0, limit).map((article) => ({
    title: article.title,
    source: article.domain || article.sourceCountry || "source",
    url: article.url,
    seenDate: article.seendate
  }));
}

async function fetchGoogleNews(preset, limit) {
  const cleanQuery = preset.query
    .replaceAll("sourcelang:english", "")
    .replaceAll("(", "")
    .replaceAll(")", "")
    .replaceAll('"', "")
    .replaceAll(" OR ", " ");
  const params = new URLSearchParams({
    q: cleanQuery,
    hl: "en-US",
    gl: "US",
    ceid: "US:en"
  });
  const url = `https://news.google.com/rss/search?${params}`;
  const response = await fetch(url, { headers: { "user-agent": "YUBITCommunityBot/1.0" } });
  if (!response.ok) throw new Error(`Google News RSS failed: ${response.status}`);
  const xml = await response.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit);
  return items.map((item) => {
    const raw = item[1];
    return {
      title: decodeXml(matchTag(raw, "title")),
      source: decodeXml(matchTag(raw, "source")) || "Google News",
      url: decodeXml(matchTag(raw, "link")),
      seenDate: decodeXml(matchTag(raw, "pubDate"))
    };
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matchTag(raw, tag) {
  const match = raw.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match?.[1] || "";
}

function decodeXml(value) {
  return String(value)
    .replaceAll("<![CDATA[", "")
    .replaceAll("]]>", "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function formatNews(preset, articles) {
  const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const lines = [`<b>${preset.title}</b>`, "", `Window: latest 24h · Time: ${now}`, ""];

  if (!articles.length) {
    lines.push("No matching headlines found in the latest 24h.");
  }

  articles.forEach((article, index) => {
    lines.push(`${index + 1}. <b>${escapeHtml(article.title || "Untitled")}</b>`);
    lines.push(`Source: ${escapeHtml(article.source)} · ${article.url}`);
    lines.push("");
  });

  lines.push(`Note: ${preset.note}`);
  return lines.join("\n").trim();
}

function formatNewsCaption(preset, articles) {
  const top = articles[0];
  return [
    `<b>${preset.title}</b>`,
    "Latest headline card attached.",
    top ? `Top story: <b>${escapeHtml(top.title || "Untitled")}</b>` : "No matching headlines found.",
    preset.note
  ]
    .filter(Boolean)
    .join("\n");
}

async function postTelegram(text, messageThreadId) {
  const response = await fetch(`${telegramBase}${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_thread_id: messageThreadId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false
    })
  });

  const body = await response.json();
  if (!body.ok) throw new Error(body.description || "Telegram sendMessage failed");
}

async function postTelegramPhoto(caption, messageThreadId, photoPath, buttonUrl) {
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("message_thread_id", String(messageThreadId));
  form.set("caption", trimCaption(caption));
  form.set("parse_mode", "HTML");
  form.set("photo", new Blob([await readFile(photoPath)], { type: "image/png" }), "news-card.png");
  if (buttonUrl) {
    form.set(
      "reply_markup",
      JSON.stringify({
        inline_keyboard: [[{ text: "Open top story", url: buttonUrl }]]
      })
    );
  }

  const response = await fetch(`${telegramBase}${token}/sendPhoto`, {
    method: "POST",
    body: form
  });

  const body = await response.json();
  if (!body.ok) throw new Error(body.description || "Telegram sendPhoto failed");
}

async function renderNewsCard(preset, articles) {
  const dir = await mkdtemp(join(tmpdir(), "yubit-news-"));
  const payloadPath = join(dir, "payload.json");
  const outPath = join(dir, "news-card.png");
  const payload = {
    title: preset.title,
    time: new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC",
    note: preset.note,
    articles: articles.map((article) => ({
      title: article.title,
      source: article.source
    }))
  };
  await writeFile(payloadPath, JSON.stringify(payload));
  await runPython(["render-card.py", "news", payloadPath, outPath]);
  return outPath;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function trimCaption(text) {
  return text.length > 1000 ? `${text.slice(0, 930)}\n\nOpen the image for more headlines.` : text;
}

async function runPython(args) {
  const python = "/Users/winkey/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
  const child = spawn(python, args, { cwd: fileURLToPath(new URL(".", import.meta.url)) });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) throw new Error(stderr || `python exited ${code}`);
}
