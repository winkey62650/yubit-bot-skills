import test from "node:test";
import assert from "node:assert/strict";
import * as automation from "../lib/automation-jobs.mjs";

const { AUTOMATION_JOBS, automationSlot, automationTopicMatches } = automation;

test("all requested automation schedules are registered", () => {
  assert.deepEqual(AUTOMATION_JOBS.map((job) => job.id), ["news-feed", "daily-events", "daily-analysis", "whale-hourly", "agent-sync-4h"]);
  assert.equal(AUTOMATION_JOBS.find((job) => job.id === "news-feed").schedule, "最短每 5 分钟");
  assert.equal(AUTOMATION_JOBS.find((job) => job.id === "daily-events").schedule, "每日 08:00 UTC");
  assert.equal(AUTOMATION_JOBS.find((job) => job.id === "daily-analysis").schedule, "每日 08:00 UTC");
  assert.equal(AUTOMATION_JOBS.find((job) => job.id === "whale-hourly").schedule, "每小时检查，重大异动才发布");
  assert.equal(AUTOMATION_JOBS.find((job) => job.id === "agent-sync-4h").schedule, "每 4 小时");
  assert.deepEqual(AUTOMATION_JOBS.map(({ id, topic, bot }) => ({ id, topic, bot })), [
    { id: "news-feed", topic: "7. YUBIT Updates", bot: "SpeakerBot" },
    { id: "daily-events", topic: "3. Market Events", bot: "SpeakerBot" },
    { id: "daily-analysis", topic: "4. Market Analysis - Crypto/Stocks/TradFi", bot: "SpeakerBot" },
    { id: "whale-hourly", topic: "6. Smart Money Tracker", bot: "SpeakerBot" },
    { id: "agent-sync-4h", topic: "2. CryptoGuy Trading Zone", bot: "SpeakerBot" }
  ]);
  assert.equal(automationTopicMatches("CryptoGuy Trading Zone", "2. CryptoGuy Trading Zone"), true);
  assert.equal(automationTopicMatches("⚡️ 2. CryptoGuy Trading Zone", "CryptoGuy Trading Zone"), true);
});

test("idempotency slots follow daily, hourly and four-hour windows", () => {
  const now = new Date("2026-07-14T10:42:00.000Z");
  assert.equal(automationSlot("daily-events", now), "2026-07-14");
  assert.equal(automationSlot("daily-analysis", now), "2026-07-14");
  assert.equal(automationSlot("whale-hourly", now), "2026-07-14T10");
  assert.equal(automationSlot("agent-sync-4h", now), "2026-07-14T08");
  assert.equal(automationSlot("news-feed", now), "2026-07-14T10:40");
});

test("legacy automation status resolves every database-backed distribution target", () => {
  assert.equal(typeof automation.distributionTargetsForJob, "function");
  const job = AUTOMATION_JOBS.find((item) => item.id === "daily-analysis");
  const target = automation.distributionTargetsForJob(job, [{
    id: "analysis-rule",
    kind: "automation",
    contentType: "daily-analysis",
    enabled: true,
    targets: [
      { chatId: "-1001", threadId: 10, groupName: "DEMO Academy", topicName: "3. Market Analysis" },
      { chatId: "-1002", threadId: 11, groupName: "CryptoGuy Academy", topicName: "3. Market Analysis" }
    ]
  }]);

  assert.equal(target.configured, true);
  assert.equal(target.enabled, true);
  assert.equal(target.count, 2);
  assert.equal(target.group, "DEMO Academy");
  assert.equal(target.topic, "3. Market Analysis");
  assert.deepEqual(target.targets.map((item) => item.chatId), ["-1001", "-1002"]);
});

test("automation target resolution keeps a whole-channel destination", () => {
  const job = AUTOMATION_JOBS.find((item) => item.id === "daily-events");
  const target = automation.distributionTargetsForJob(job, [{
    id: "channel-events",
    kind: "automation",
    contentType: "daily-events",
    enabled: true,
    targets: [{
      chatId: "-1009001",
      chatType: "channel",
      threadId: null,
      groupName: "Private Distribution Test",
      topicName: "整个频道"
    }]
  }]);

  assert.equal(target.configured, true);
  assert.equal(target.count, 1);
  assert.equal(target.targets[0].chatType, "channel");
  assert.equal(target.targets[0].threadId, null);
});

test("whale alert turns a material order-book snapshot into approved English copy", () => {
  assert.equal(typeof automation.buildWhaleAlert, "function");
  const alert = automation.buildWhaleAlert({
    bids: [["60000", "20"], ["59900", "2"]],
    asks: [["60100", "3"], ["60500", "1"]],
    openInterest: 420000,
    funding: 0.0123,
    markPrice: 60050,
    source: "Binance"
  }, new Date("2026-07-15T08:00:00.000Z"));

  assert.equal(alert.imageKind, "whale");
  assert.equal(alert.poster.signal, "LARGE BID");
  assert.equal(alert.poster.pair, "BTC / USDT");
  assert.equal(alert.publishable, true);
  assert.match(alert.caption, /WHALE ALERT · SMART MONEY SIGNAL/);
  assert.match(alert.caption, /2026-07-15 08:00 UTC/);
  assert.match(alert.caption, /Large bid added/);
  assert.match(alert.caption, /Buy-wall support/);
  assert.match(alert.caption, /What to watch next/);
  assert.match(alert.caption, /does not mean a trade has been executed/);
  assert.doesNotMatch(alert.caption, /Data source|binance\.com\/en\/futures\/BTCUSDT/i);
  assert.doesNotMatch(alert.caption, /#BTC|#Binance|#WhaleAlert|#SmartMoney/i);
  assert.match(alert.caption, /not investment advice\.$/);
  assert.ok(alert.caption.length <= 1024);
});

test("whale alert suppresses ordinary order-book noise", () => {
  const alert = automation.buildWhaleAlert({
    bids: [["60000", "1"], ["59900", "1"]],
    asks: [["60100", "1"], ["60200", "1"]],
    openInterest: 420000,
    funding: 0.01,
    markPrice: 60050,
    source: "Binance"
  }, new Date("2026-07-15T09:00:00.000Z"));

  assert.equal(alert.publishable, false);
  assert.match(alert.suppressionReason, /threshold/i);
  assert.match(alert.caption, /largest visible liquidity concentration/i);
  assert.doesNotMatch(alert.caption, /material liquidity concentration/i);
});

test("a one-time acceptance run can publish the real best available whale snapshot", () => {
  assert.equal(typeof automation.shouldSuppressWhaleSignal, "function");
  assert.equal(automation.shouldSuppressWhaleSignal({ publishable: false }, { force: false }), true);
  assert.equal(automation.shouldSuppressWhaleSignal({ publishable: false }, { force: true }), false);
  assert.equal(automation.shouldSuppressWhaleSignal({ publishable: true }, { force: false }), false);
});

test("dynamic poster URLs pin the approved template version and content revision on the current deployment", () => {
  const url = new URL(automation.buildCardUrl("events", [], {
    dateLabel: "JULY 17",
    subline: "CRYPTO LEADS · EQUITIES FIRM"
  }, { baseUrl: "https://academy.example/releases/old", cacheKey: "abc123def4567890" }));

  assert.equal(url.origin, "https://academy.example");
  assert.equal(url.pathname, "/api/media/card");
  assert.equal(url.searchParams.get("kind"), "events");
  assert.equal(url.searchParams.get("date"), "JULY 17");
  assert.equal(url.searchParams.get("v"), "market-card-v4");
  assert.equal(url.searchParams.get("rev"), "abc123def4567890");
});

test("daily events normalize a flexible daily market brief instead of a fixed economic calendar", () => {
  assert.equal(typeof automation.buildDailyMarketBrief, "function");
  const brief = automation.buildDailyMarketBrief({
    date: "2026-07-15",
    summary: "Risk appetite improved as equities and crypto advanced while energy prices eased.",
    subline: "EQUITIES FIRM · CRYPTO ADVANCES · ENERGY EASES",
    stories: [
      { title: "Equities advanced", summary: "The Nasdaq led a broad risk-on session.", source: "Reuters", url: "https://www.reuters.com/markets/" },
      { title: "Bitcoin strengthened", summary: "Bitcoin recovered alongside technology shares." },
      { title: "Oil retreated", summary: "Crude prices gave back part of the recent rise." }
    ]
  }, new Date("2026-07-15T08:00:00.000Z"));

  assert.equal(brief.headline, "MORNING MARKET BRIEF · JULY 15");
  assert.equal(brief.dateLabel, "JULY 15");
  assert.equal(brief.items.length, 3);
  assert.match(brief.contentHash, /^[a-f0-9]{64}$/);
  assert.match(brief.caption, /<b>🌅 MORNING MARKET BRIEF · JULY 15<\/b>/);
  assert.match(brief.caption, /1\. Equities advanced: The Nasdaq led/);
  assert.match(brief.caption, /Source: <a href="https:\/\/www\.reuters\.com\/markets\/">Reuters<\/a>/);
  assert.ok(brief.caption.length <= 1024);
  assert.doesNotMatch(brief.caption, /Executive read|Today's desk brief|full English brief follows|Story count/i);
  assert.match(brief.fullText, /1\. Equities advanced: The Nasdaq led/);
  assert.match(brief.fullText, /Source: <a href="https:\/\/www\.reuters\.com\/markets\/">Reuters<\/a>/);
  assert.doesNotMatch(`${brief.subline}\n${brief.caption}`, /11 stories|08:00|hourly/i);
});

test("market events executive summary describes selected coverage, not the size of the candidate feed", () => {
  assert.equal(typeof automation.buildMarketEventsExecutiveSummary, "function");
  const stories = [
    ...Array.from({ length: 30 }, (_, index) => ({ title: `Candidate ${index + 1}`, category: "Crypto" })),
    { title: "Macro catalyst", category: "Macro" }
  ];
  const summary = automation.buildMarketEventsExecutiveSummary(stories.slice(0, 6).concat(stories.at(-1)));

  assert.match(summary, /crypto and macro developments/i);
  assert.match(summary, /market impact over volume/i);
  assert.doesNotMatch(summary, /30|31|candidate/i);
});

test("daily market brief delivery sends a standalone poster followed by the market event copy", () => {
  assert.equal(typeof automation.buildDailyMarketBriefTelegramPlan, "function");
  const target = { chatId: "-1004378187866", threadId: 8 };
  const plan = automation.buildDailyMarketBriefTelegramPlan({
    caption: "<b>Morning brief</b>\n\n1. First story\n\n2. Second story",
    fullText: "1. First story\n\n2. Second story"
  }, target, "https://example.com/poster.png");

  assert.deepEqual(plan.map((item) => item.method), ["sendPhoto", "sendMessage"]);
  assert.deepEqual(plan.map((item) => item.payload.chat_id), [target.chatId, target.chatId]);
  assert.deepEqual(plan.map((item) => item.payload.message_thread_id), [target.threadId, target.threadId]);
  assert.equal(plan[0].payload.photo, "https://example.com/poster.png");
  assert.equal(Object.hasOwn(plan[0].payload, "caption"), false);
  assert.equal(plan[1].payload.text, "1. First story\n\n2. Second story");
  assert.equal(plan[1].payload.parse_mode, "HTML");
  assert.equal(plan[1].payload.disable_web_page_preview, true);
});

test("desktop publisher plans preserve one target and every Telegram step", () => {
  assert.equal(typeof automation.buildAutomationTelegramPlans, "function");
  const target = {
    id: "demo-events",
    chatId: "-1003710405969",
    threadId: 8,
    groupName: "DEMO Academy",
    topicName: "3. Market Events"
  };
  const plans = automation.buildAutomationTelegramPlans("daily-events", {
    fullText: "<b>MARKET EVENTS</b>\n\n1. Verified story"
  }, [target], "https://example.com/events.png");

  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].target, target);
  assert.deepEqual(plans[0].steps.map((step) => step.method), ["sendPhoto", "sendMessage"]);
  assert.equal(plans[0].steps[0].payload.photo, "https://example.com/events.png");
  assert.equal(plans[0].steps[1].payload.text, "<b>MARKET EVENTS</b>\n\n1. Verified story");
});

test("desktop publisher plans keep analysis and whale copy attached to the poster", () => {
  const target = { id: "demo-analysis", chatId: "-1003710405969", threadId: 10 };
  const [plan] = automation.buildAutomationTelegramPlans("daily-analysis", {
    caption: "<b>DAILY MARKET ANALYSIS</b>\n\nRegime: constructive"
  }, [target], "https://example.com/analysis.png");

  assert.deepEqual(plan.steps.map((step) => step.method), ["sendPhoto"]);
  assert.equal(plan.steps[0].payload.caption, "<b>DAILY MARKET ANALYSIS</b>\n\nRegime: constructive");
  assert.equal(plan.steps[0].payload.message_thread_id, 10);
});

test("channel delivery omits message_thread_id from every Telegram request", () => {
  const target = { chatId: "-1009001", chatType: "channel", threadId: null };
  const plan = automation.buildDailyMarketBriefTelegramPlan({
    fullText: "1. Private channel acceptance"
  }, target, "https://example.com/poster.png");

  assert.equal(plan.every((item) => item.payload.chat_id === target.chatId), true);
  assert.equal(plan.every((item) => !Object.hasOwn(item.payload, "message_thread_id")), true);
});

test("daily market brief keeps whole story blocks within Telegram photo caption limits", () => {
  const brief = automation.buildDailyMarketBrief({
    date: "2026-07-16",
    stories: Array.from({ length: 8 }, (_, index) => ({
      title: `Market event ${index + 1}`,
      summary: `${"A material cross-asset development changed positioning and liquidity conditions across crypto markets. ".repeat(5)}Final sentence.`,
      source: "Primary market source",
      url: `https://example.com/markets/${index + 1}`,
      category: "Crypto"
    }))
  }, new Date("2026-07-16T08:00:00.000Z"));

  assert.ok(brief.caption.length <= 1024);
  assert.match(brief.caption, /1\. <b>CRYPTO<\/b>/);
  assert.match(brief.caption, /Source: <a href="https:\/\/example\.com\/markets\/1">Primary market source<\/a>/);
  assert.match(brief.caption, /<i>Market commentary only\.<\/i>$/);
  assert.equal((brief.caption.match(/<a href=/g) || []).length, (brief.caption.match(/<\/a>/g) || []).length);
});

test("daily market brief removes tracking parameters so three priority stories fit the photo caption", () => {
  const brief = automation.buildDailyMarketBrief({
    date: "2026-07-16",
    stories: Array.from({ length: 3 }, (_, index) => ({
      title: `Priority event ${index + 1}`,
      summary: "A consequential crypto and macro development changed liquidity, positioning and the next market catalyst across major assets.",
      source: "Cointelegraph",
      url: `https://cointelegraph.com/news/priority-${index + 1}?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_partner_inbound`,
      category: "Crypto"
    }))
  }, new Date("2026-07-16T08:00:00.000Z"));

  assert.match(brief.caption, /3\. <b>CRYPTO<\/b> · Priority event 3/);
  assert.doesNotMatch(brief.caption, /utm_source|utm_medium|utm_campaign/);
  assert.doesNotMatch(brief.fullText, /utm_source|utm_medium|utm_campaign/);
  assert.ok(brief.caption.length <= 1024);
});

test("Telegram photo delivery uploads the poster when Telegram cannot fetch its URL", async () => {
  assert.equal(typeof automation.telegramCall, "function");
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ ok: false, description: "Bad Request: wrong type of the web page content" }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
    if (calls.length === 2) {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png" }
      });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 530 } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const result = await automation.telegramCall("speaker-token", "sendPhoto", {
    chat_id: "-1003710405969",
    message_thread_id: 8,
    photo: "https://example.com/events.png",
    caption: "Morning brief",
    parse_mode: "HTML"
  }, fetchImpl);

  assert.equal(result.message_id, 530);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url, "https://example.com/events.png");
  assert.ok(calls[2].options.body instanceof FormData);
  assert.equal(calls[2].options.body.get("chat_id"), "-1003710405969");
  assert.equal(calls[2].options.body.get("message_thread_id"), "8");
  assert.equal(calls[2].options.body.get("caption"), "Morning brief");
  assert.equal(calls[2].options.body.get("photo").type, "image/png");
});

test("daily analysis delivery URL carries the latest dynamic poster fields", () => {
  assert.equal(typeof automation.buildCardUrl, "function");
  const url = new URL(automation.buildCardUrl("analysis", [], {
    regime: "RISK ON",
    levels: "BTC $60,000 · SMA20 $58,400",
    catalyst: "24H MOMENTUM · CROSS-ASSET FLOW"
  }));
  assert.equal(url.searchParams.get("kind"), "analysis");
  assert.equal(url.searchParams.get("regime"), "RISK ON");
  assert.equal(url.searchParams.get("levels"), "BTC $60,000 · SMA20 $58,400");
  assert.equal(url.searchParams.get("catalyst"), "24H MOMENTUM · CROSS-ASSET FLOW");
});

test("automation preview card URL stays on the immutable deployment origin", () => {
  const url = new URL(automation.buildCardUrl("events", ["CRYPTO", "MACRO"], {
    dateLabel: "JULY 16",
    subline: "MARKET IMPACT · VERIFIED SOURCES"
  }, {
    baseUrl: "https://academy-git-code-academy-immutable.vercel.app/api/automation-test?from=audit"
  }));

  assert.equal(url.origin, "https://academy-git-code-academy-immutable.vercel.app");
  assert.equal(url.pathname, "/api/media/card");
  assert.equal(url.searchParams.get("kind"), "events");
  assert.equal(url.searchParams.get("date"), "JULY 16");
});

test("daily analysis Telegram copy matches the complete approved preview structure", () => {
  assert.equal(typeof automation.buildDailyAnalysisSnapshot, "function");
  const snapshot = automation.buildDailyAnalysisSnapshot([
    { symbol: "BTC", price: 65479, change: 2.51, sma20: 62357, trend: "Bullish", source: "OKX fallback" },
    { symbol: "ETH", price: 3450, change: 1.25, sma20: 3310, trend: "Bullish", source: "OKX fallback" },
    { symbol: "SOL", price: 168, change: -0.4, sma20: 162, trend: "Bullish", source: "OKX fallback" }
  ], new Date("2026-07-15T08:00:00.000Z"));

  assert.equal(snapshot.poster.regime, "RISK ON");
  assert.match(snapshot.caption, /DAILY MARKET ANALYSIS · JULY 15/);
  assert.match(snapshot.caption, /Market regime:<\/b> RISK ON/);
  assert.match(snapshot.caption, /BTC.*\+2\.51%/s);
  assert.match(snapshot.caption, /Key read:<\/b>/);
  assert.match(snapshot.caption, /Levels to watch:<\/b>/);
  assert.match(snapshot.caption, /Catalyst:<\/b>/);
  assert.match(snapshot.caption, /Not investment advice/);
  assert.doesNotMatch(snapshot.caption, /OKX fallback|fallback market data/i);
  assert.doesNotMatch(snapshot.caption, /YUBIT|08:00 UTC|updates hourly/i);
});
