import test from "node:test";
import assert from "node:assert/strict";
import * as automation from "../lib/automation-jobs.mjs";

const { AUTOMATION_JOBS, automationSlot, automationTopicMatches } = automation;

test("all requested automation schedules are registered", () => {
  assert.deepEqual(AUTOMATION_JOBS.map((job) => job.id), ["crypto-daily", "weekly-calendar", "data-release-updates", "daily-analysis", "whale-hourly", "agent-sync-4h"]);
  assert.equal(AUTOMATION_JOBS.find((job) => job.id === "crypto-daily").schedule, "每日 08:00 UTC");
  assert.equal(AUTOMATION_JOBS.find((job) => job.id === "weekly-calendar").schedule, "每周一 00:30 UTC");
  assert.equal(AUTOMATION_JOBS.find((job) => job.id === "data-release-updates").schedule, "每分钟检查重点数据发布");
  assert.equal(AUTOMATION_JOBS.find((job) => job.id === "daily-analysis").schedule, "每日 08:00 UTC");
  assert.equal(AUTOMATION_JOBS.find((job) => job.id === "whale-hourly").schedule, "每小时检查，重大异动才发布");
  assert.equal(AUTOMATION_JOBS.find((job) => job.id === "agent-sync-4h").schedule, "每小时");
  assert.equal(AUTOMATION_JOBS.find((job) => job.id === "agent-sync-4h").cron, "15 * * * *");
  assert.deepEqual(AUTOMATION_JOBS.map(({ id, topic, bot }) => ({ id, topic, bot })), [
    { id: "crypto-daily", topic: "7. YUBIT Updates", bot: "SpeakerBot" },
    { id: "weekly-calendar", topic: "3. Market Events", bot: "SpeakerBot" },
    { id: "data-release-updates", topic: "3. Market Events", bot: "SpeakerBot" },
    { id: "daily-analysis", topic: "4. Market Analysis - Crypto/Stocks/TradFi", bot: "SpeakerBot" },
    { id: "whale-hourly", topic: "6. Smart Money Tracker", bot: "SpeakerBot" },
    { id: "agent-sync-4h", topic: "2. CryptoGuy Trading Zone", bot: "SpeakerBot" }
  ]);
  assert.equal(automationTopicMatches("CryptoGuy Trading Zone", "2. CryptoGuy Trading Zone"), true);
  assert.equal(automationTopicMatches("⚡️ 2. CryptoGuy Trading Zone", "CryptoGuy Trading Zone"), true);
});

test("idempotency slots follow weekly, daily, minute and hourly windows", () => {
  const now = new Date("2026-08-19T10:42:00.000Z");
  assert.equal(automationSlot("weekly-calendar", now), "2026-W34");
  assert.equal(automationSlot("crypto-daily", now), "2026-08-19");
  assert.equal(automationSlot("data-release-updates", now), "2026-08-19T10:42");
  assert.equal(automationSlot("daily-analysis", now), "2026-08-19");
  assert.equal(automationSlot("whale-hourly", now), "2026-08-19T10");
  assert.equal(automationSlot("agent-sync-4h", now), "2026-08-19T10");
});

test("agent updates use the compact platform, date and link template", () => {
  assert.equal(typeof automation.renderAgentUpdateText, "function");
  assert.equal(automation.renderAgentUpdateText({ platform: "X", publishedAt: "2026-08-04T01:20:00Z", url: "https://x.com/demo/status/1" }), "X Updated + 2026-08-04\nhttps://x.com/demo/status/1");
  assert.equal(automation.renderAgentUpdateText({ package: { platform: "YouTube" }, publishedAt: "2026-08-03T23:20:00Z", url: "https://youtu.be/demo" }), "YouTube Updated + 2026-08-03\nhttps://youtu.be/demo");
});

test("agent sync health never reports failed or missing sources as success", () => {
  assert.deepEqual(
    automation.evaluateAgentSyncHealth([{ status: "unchanged" }], 0),
    {
      status: "success",
      sourceCount: 1,
      healthyCount: 1,
      failedCount: 0,
      skippedCount: 0,
      updateCount: 0,
      message: "已完成抓取，本轮没有新内容。",
    },
  );
  assert.equal(automation.evaluateAgentSyncHealth([{ status: "failed" }], 0).status, "failed");
  assert.equal(automation.evaluateAgentSyncHealth([{ status: "skipped" }], 0).status, "failed");
  assert.equal(automation.evaluateAgentSyncHealth([
    { status: "unchanged" },
    { status: "failed" },
  ], 0).status, "partial");
  assert.equal(automation.evaluateAgentSyncHealth([
    { status: "updated" },
    { status: "failed" },
  ], 1).status, "partial");
});

test("agent update plans support multiple groups and topics", () => {
  assert.equal(typeof automation.buildAgentUpdateTelegramPlans, "function");
  const targets = [
    { chatId: "-1001", threadId: 8, chatType: "supergroup" },
    { chatId: "-1002", threadId: 11, chatType: "supergroup" }
  ];
  const plans = automation.buildAgentUpdateTelegramPlans([
    { platform: "X", publishedAt: "2026-08-04T01:20:00Z", url: "https://x.com/demo/status/1" }
  ], targets);
  assert.equal(plans.length, 2);
  assert.deepEqual(plans.map((plan) => plan.target.chatId), ["-1001", "-1002"]);
  assert.ok(plans.every((plan) => plan.steps[0].payload.text === "X Updated + 2026-08-04\nhttps://x.com/demo/status/1"));
});

test("agent updates use source-specific destinations before the legacy default target", () => {
  assert.equal(typeof automation.buildAgentUpdateAssignments, "function");
  const sourceTarget = { chatId: "-1001", threadId: 17, chatType: "supergroup", groupName: "Wise Academy", topicName: "Trading Zone" };
  const fallbackTarget = { chatId: "-1002", threadId: 8, chatType: "supergroup", groupName: "Demo Academy", topicName: "Market Events" };
  const boundUpdate = { url: "https://x.com/wise/status/1", package: { targets: [sourceTarget] } };
  const legacyUpdate = { url: "https://x.com/legacy/status/2", package: { targets: [] } };

  const { assignments, unresolved } = automation.buildAgentUpdateAssignments([boundUpdate, legacyUpdate], [fallbackTarget]);

  assert.equal(unresolved.length, 0);
  assert.deepEqual(assignments, [
    { key: "-1001:17", target: sourceTarget, updates: [boundUpdate] },
    { key: "-1002:8", target: fallbackTarget, updates: [legacyUpdate] }
  ]);
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
  const job = AUTOMATION_JOBS.find((item) => item.id === "weekly-calendar");
  const target = automation.distributionTargetsForJob(job, [{
    id: "channel-events",
    kind: "automation",
    contentType: "weekly-calendar",
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

test("automation target resolution preserves mixed Telegram and Discord destinations", () => {
  const job = AUTOMATION_JOBS.find((item) => item.id === "daily-analysis");
  const target = automation.distributionTargetsForJob(job, [{
    id: "mixed-analysis",
    kind: "automation",
    contentType: "daily-analysis",
    enabled: true,
    targets: [
      { platform: "telegram", chatId: "-1001", threadId: 10, groupName: "DEMO Academy", topicName: "4. Market Analysis" },
      { platform: "discord", guildId: "guild-1", channelId: "channel-1", groupName: "Demo Discord", topicName: "market-analysis" }
    ]
  }]);

  assert.equal(target.count, 2);
  assert.deepEqual(target.targets.map((item) => item.platform), ["telegram", "discord"]);
  assert.equal(target.targets[1].guildId, "guild-1");
  assert.equal(target.targets[1].channelId, "channel-1");
});

test("Discord automation plans preserve the approved editorial message shapes", () => {
  const target = { platform: "discord", guildId: "guild-1", channelId: "channel-1" };
  const events = automation.buildAutomationDiscordPlans("daily-events", {
    fullText: "<b>Market Events</b>\n\n1. Event one"
  }, [target], "https://example.com/events.png");
  assert.deepEqual(events[0].steps, [
    { method: "sendMessage", payload: { imageUrl: "https://example.com/events.png" } },
    { method: "sendMessage", payload: { content: "**Market Events**\n\n1. Event one" } }
  ]);

  const analysis = automation.buildAutomationDiscordPlans("daily-analysis", {
    caption: "<b>Daily Market Analysis</b>\nMarket remains constructive."
  }, [target], "https://example.com/analysis.png");
  assert.deepEqual(analysis[0].steps, [{
    method: "sendMessage",
    payload: {
      content: "**Daily Market Analysis**\nMarket remains constructive.",
      imageUrl: "https://example.com/analysis.png"
    }
  }]);
});

test("automation plans append target-specific CTA blocks", () => {
  const telegramTargets = [
    {
      chatId: "-1001",
      threadId: 8,
      chatType: "supergroup",
      ctaEnabled: true,
      ctaText: "Join YUBIT",
      ctaUrl: "https://yubit.vip/join"
    },
    { chatId: "-1002", threadId: 8, chatType: "supergroup" }
  ];

  const analysis = automation.buildAutomationTelegramPlans("daily-analysis", {
    caption: "<b>Daily Market Analysis</b>\nMarket remains constructive."
  }, telegramTargets, "https://example.com/analysis.png");
  assert.match(analysis[0].steps[0].payload.caption, /<b>Join YUBIT<\/b>\nhttps:\/\/yubit\.vip\/join/);
  assert.doesNotMatch(analysis[1].steps[0].payload.caption, /Join YUBIT/);

  const events = automation.buildAutomationTelegramPlans("daily-events", {
    fullText: "<b>Market Events</b>\n\n1. Event one"
  }, [telegramTargets[0]], "https://example.com/events.png");
  assert.equal(events[0].steps[0].payload.caption, undefined);
  assert.match(events[0].steps[1].payload.text, /<b>Join YUBIT<\/b>\nhttps:\/\/yubit\.vip\/join/);

  const discord = automation.buildAutomationDiscordPlans("daily-analysis", {
    caption: "<b>Daily Market Analysis</b>\nMarket remains constructive."
  }, [{
    platform: "discord",
    guildId: "guild-1",
    channelId: "channel-1",
    ctaEnabled: true,
    ctaText: "Open VIP Desk",
    ctaUrl: "https://example.com/vip"
  }], "https://example.com/analysis.png");
  assert.match(discord[0].steps[0].payload.content, /\*\*Open VIP Desk\*\*\nhttps:\/\/example\.com\/vip/);
});

test("automation plans render one formatted CTA content block for Telegram and Discord", () => {
  const ctaContent = "**Join YUBIT**\n[Open community](https://example.com/join?from=cta&lang=en)";
  const telegram = automation.buildAutomationTelegramPlans("daily-analysis", {
    caption: "<b>Daily Market Analysis</b>\nMarket remains constructive."
  }, [{ chatId: "-1001", threadId: 8, chatType: "supergroup", ctaEnabled: true, ctaContent }], "https://example.com/analysis.png");
  assert.match(telegram[0].steps[0].payload.caption, /<b>Join YUBIT<\/b>\n<a href="https:\/\/example\.com\/join\?from=cta&amp;lang=en">Open community<\/a>$/);

  const discord = automation.buildAutomationDiscordPlans("daily-analysis", {
    caption: "<b>Daily Market Analysis</b>\nMarket remains constructive."
  }, [{ platform: "discord", guildId: "g1", channelId: "c1", ctaEnabled: true, ctaContent }], "https://example.com/analysis.png");
  assert.match(discord[0].steps[0].payload.content, /\*\*Join YUBIT\*\*\n\[Open community\]\(https:\/\/example\.com\/join\?from=cta&lang=en\)$/);
});

test("Telegram plans reserve space for each target CTA when generated content reaches platform limits", () => {
  const target = {
    chatId: "-1001",
    threadId: 8,
    chatType: "supergroup",
    ctaEnabled: true,
    ctaText: "Join Channel Alpha",
    ctaUrl: "https://example.com/alpha?source=demo&topic=events"
  };
  const longBody = Array.from({ length: 40 }, (_, index) => (
    `<b>Story ${index + 1}</b>\n${"Verified market context. ".repeat(12)}`
  )).join("\n\n");

  const events = automation.buildAutomationTelegramPlans("daily-events", {
    fullText: longBody
  }, [target], "https://example.com/events.png");
  const eventsText = events[0].steps[1].payload.text;
  assert.ok(eventsText.length <= 4096);
  assert.match(eventsText, /<b>Join Channel Alpha<\/b>\nhttps:\/\/example\.com\/alpha\?source=demo&amp;topic=events$/);

  const analysis = automation.buildAutomationTelegramPlans("daily-analysis", {
    caption: longBody
  }, [target], "https://example.com/analysis.png");
  const analysisCaption = analysis[0].steps[0].payload.caption;
  assert.ok(analysisCaption.length <= 1024);
  assert.match(analysisCaption, /<b>Join Channel Alpha<\/b>\nhttps:\/\/example\.com\/alpha\?source=demo&amp;topic=events$/);
});

test("Discord agent updates use the same fixed X and YouTube templates", () => {
  const plans = automation.buildAgentUpdateDiscordPlans([
    { platform: "X", publishedAt: "2026-08-04T01:20:00Z", url: "https://x.com/demo/status/1" },
    { platform: "YouTube", publishedAt: "2026-08-04T02:20:00Z", url: "https://youtu.be/demo" }
  ], [{ platform: "discord", guildId: "guild-1", channelId: "channel-1" }]);

  assert.deepEqual(plans[0].steps.map((step) => step.payload.content), [
    "X Updated + 2026-08-04\nhttps://x.com/demo/status/1",
    "YouTube Updated + 2026-08-04\nhttps://youtu.be/demo"
  ]);
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
  assert.match(brief.caption, /01 · Equities advanced: The Nasdaq led/);
  assert.match(brief.caption, /Source: <a href="https:\/\/www\.reuters\.com\/markets\/">Reuters<\/a>/);
  assert.ok(brief.caption.length <= 1024);
  assert.doesNotMatch(brief.caption, /Executive read|Today's desk brief|full English brief follows|Story count/i);
  assert.match(brief.fullText, /01 · Equities advanced: The Nasdaq led/);
  assert.doesNotMatch(brief.fullText, /^\d+\.\s/gm);
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
  assert.equal(plans[0].templateVersion, "editorial-template-v1");
  assert.equal(plans[0].contentPolicy, "fixed-template");
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
  assert.equal(plan.templateVersion, "editorial-template-v1");
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
  assert.match(brief.caption, /01 · <b>CRYPTO<\/b>/);
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

  assert.match(brief.caption, /03 · <b>CRYPTO<\/b> · Priority event 3/);
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

test("live automation previews expose the fixed editorial contract", () => {
  assert.deepEqual(automation.automationTemplateMetadata("crypto-daily"), {
    templateVersion: "market-content-v1",
    contentPolicy: "fixed-template"
  });
  assert.deepEqual(automation.automationTemplateMetadata("weekly-calendar"), {
    templateVersion: "market-content-v1",
    contentPolicy: "fixed-template"
  });
  assert.deepEqual(automation.automationTemplateMetadata("data-release-updates"), {
    templateVersion: "market-content-v1",
    contentPolicy: "fixed-template"
  });
  assert.deepEqual(automation.automationTemplateMetadata("daily-analysis"), {
    templateVersion: "editorial-template-v1",
    contentPolicy: "fixed-template"
  });
  assert.deepEqual(automation.automationTemplateMetadata("whale-hourly"), {
    templateVersion: "editorial-template-v1",
    contentPolicy: "fixed-template"
  });
});

test("automation preview prefers the public deployment URL over an internal proxy origin", () => {
  assert.equal(
    automation.resolveAutomationPreviewBaseUrl("http://localhost:4174/api/automation-test", {
      APP_BASE_URL: "https://152-32-161-174.sslip.io"
    }),
    "https://152-32-161-174.sslip.io"
  );
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

function automationRepository(initial = {}) {
  const meta = new Map(Object.entries(structuredClone(initial)));
  return {
    writes: [],
    async getMeta(key) { return structuredClone(meta.get(key) ?? null); },
    async setMeta(key, value) {
      const saved = structuredClone(value);
      this.writes.push([key, saved]);
      meta.set(key, saved);
      return structuredClone(saved);
    }
  };
}

function fixtureFetch(body) {
  return async () => new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": typeof body === "string" ? "application/xml" : "application/json" }
  });
}

const marketEnvelopeKeys = ["templateId", "document", "sources", "warnings", "deduplicationKey", "publishable", "generatedAt"];

test("fixture-backed market jobs return the common automation envelope", async () => {
  const rss = `<?xml version="1.0"?><rss><channel><item><guid>btc-etf</guid><title>Bitcoin ETF records net inflow</title><link>https://example.com/etf</link><description>Institutional demand increased.</description><pubDate>Wed, 19 Aug 2026 06:00:00 GMT</pubDate></item></channel></rss>`;
  const calendar = { result: [{ id: "us-cpi", title: "US CPI YoY", country: "US", importance: 3, date: "2026-08-20T12:30:00Z", forecast: "2.8", previous: "2.9", unit: "%" }] };
  const repository = automationRepository();
  const daily = await automation.buildContent("crypto-daily", new Date("2026-08-19T08:00:00Z"), { fetchImpl: fixtureFetch(rss), repository, persist: false });
  const weekly = await automation.buildContent("weekly-calendar", new Date("2026-08-19T08:00:00Z"), { fetchImpl: fixtureFetch(calendar), repository, persist: false });
  const release = await automation.buildContent("data-release-updates", new Date("2026-08-19T08:00:00Z"), { fetchImpl: fixtureFetch(calendar), repository, persist: false });

  for (const result of [daily, weekly, release]) {
    for (const key of marketEnvelopeKeys) assert.equal(Object.hasOwn(result, key), true, `${result.templateId} missing ${key}`);
    assert.ok(Array.isArray(result.sources));
    assert.ok(Array.isArray(result.warnings));
  }
  assert.equal(daily.document.templateId, "crypto-daily");
  assert.equal(weekly.document.templateId, "weekly-calendar");
  assert.equal(release.publishable, false);
  assert.equal(typeof release.skipReason, "string");
  assert.deepEqual([daily.generatedAt, weekly.generatedAt, release.generatedAt], [
    "2026-08-19T08:00:00.000Z",
    "2026-08-19T08:00:00.000Z",
    "2026-08-19T08:00:00.000Z"
  ]);
  assert.equal(repository.writes.length, 0);
});

test("weekly calendar caches only when persist is explicitly true", async () => {
  const calendar = { result: [{ id: "us-cpi", title: "US CPI YoY", country: "US", importance: 3, date: "2026-08-20T12:30:00Z", forecast: "2.8", previous: "2.9", unit: "%" }] };
  const repository = automationRepository();
  await automation.buildContent("weekly-calendar", new Date("2026-08-19T08:00:00Z"), { fetchImpl: fixtureFetch(calendar), repository, persist: false });
  assert.equal(repository.writes.length, 0);
  await automation.buildContent("weekly-calendar", new Date("2026-08-19T08:00:00Z"), { fetchImpl: fixtureFetch(calendar), repository, persist: true });
  assert.equal(repository.writes.filter(([key]) => key === "market-content:weekly-calendar:v1").length, 1);
});

test("non-publishable data releases are skipped before any sender is called", async () => {
  const repository = automationRepository();
  let sends = 0;
  const result = await automation.runAutomationJob("data-release-updates", {
    now: "2026-08-19T08:00:00Z",
    force: true,
    dryRun: false,
    repository,
    fetchImpl: fixtureFetch({ result: [] }),
    targets: [{ platform: "discord", guildId: "g1", channelId: "c1" }],
    discordSender: async () => { sends += 1; }
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.preview.skipReason, "no-monitored-event");
  assert.equal(sends, 0);
});

test("data release retries after send failure and acknowledges only after every target succeeds", async () => {
  const actualCalendar = { result: [{
    id: "us-cpi-retry",
    title: "US CPI YoY",
    country: "US",
    importance: 3,
    date: "2026-08-19T12:30:00Z",
    actual: "2.7",
    forecast: "2.8",
    previous: "2.9",
    unit: "%"
  }] };
  const repository = automationRepository();
  const targets = [
    { platform: "discord", guildId: "g1", channelId: "c1" },
    { platform: "discord", guildId: "g1", channelId: "c2" }
  ];
  let failSecondTarget = true;
  const sends = new Map();
  const discordSender = async (channelId) => {
    sends.set(channelId, (sends.get(channelId) || 0) + 1);
    if (channelId === "c2" && failSecondTarget) throw new Error("Discord unavailable");
    return { id: `message-${channelId}-${sends.get(channelId)}` };
  };
  const run = (now) => automation.runAutomationJob("data-release-updates", {
    now,
    force: true,
    dryRun: false,
    repository,
    fetchImpl: fixtureFetch(actualCalendar),
    fetchReaction: async () => ({ prices: {}, sources: [], warnings: [] }),
    targets,
    discordSender
  });

  const partial = await run("2026-08-19T12:31:00Z");
  assert.equal(partial.status, "partial");
  assert.deepEqual((await repository.getMeta("market-content:release-state:v1")).publishedKeys, []);

  failSecondTarget = false;
  const success = await run("2026-08-19T12:32:00Z");
  assert.equal(success.status, "success");
  assert.deepEqual(Object.fromEntries(sends), { c1: 1, c2: 2 });
  assert.deepEqual((await repository.getMeta("market-content:release-state:v1")).publishedKeys, [success.preview.deduplicationKey]);

  const sendsAfterSuccess = Object.fromEntries(sends);
  const duplicate = await run("2026-08-19T12:33:00Z");
  assert.equal(duplicate.status, "skipped");
  assert.equal(duplicate.preview.skipReason, "duplicate-release");
  assert.deepEqual(Object.fromEntries(sends), sendsAfterSuccess);
});

test("queued data release keeps its target claim and does not create another plan next minute", async () => {
  const calendar = { result: [{
    id: "us-cpi-queued",
    title: "US CPI YoY",
    country: "US",
    importance: 3,
    date: "2026-08-19T12:30:00Z",
    actual: "2.7",
    forecast: "2.8",
    previous: "2.9",
    unit: "%"
  }] };
  const repository = automationRepository();
  const options = {
    force: true,
    dryRun: false,
    deferDelivery: true,
    repository,
    fetchImpl: fixtureFetch(calendar),
    fetchReaction: async () => ({ prices: {}, sources: [], warnings: [] }),
    targets: [{ id: "queued-release", chatId: "-1001", threadId: 8 }],
  };

  const queued = await automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:31:00Z" });
  const stillQueued = await automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:32:00Z" });

  assert.equal(queued.status, "queued");
  assert.equal(queued.preview.deliveryPlans.length, 1);
  assert.equal(stillQueued.status, "queued");
  assert.equal(stillQueued.preview.deliveryPlans.length, 0);
  assert.equal(stillQueued.preview.targetResults[0].receiptExisting, true);
  assert.deepEqual(stillQueued.preview.deliveryReceipt.pendingTargetKeys, ["telegram:-1001:8"]);
});

test("data release retries only global acknowledgement when release-state persistence fails", async () => {
  const calendar = { result: [{ id: "us-cpi-ack-retry", title: "US CPI YoY", country: "US", importance: 3, date: "2026-08-19T12:30:00Z", actual: "2.7", forecast: "2.8", previous: "2.9", unit: "%" }] };
  const base = automationRepository();
  let rejectReleaseAck = true;
  const repository = {
    ...base,
    async setMeta(key, value) {
      if (key === "market-content:release-state:v1" && Array.isArray(value?.publishedKeys) && value.publishedKeys.length && rejectReleaseAck) {
        rejectReleaseAck = false;
        throw new Error("release state unavailable");
      }
      return base.setMeta(key, value);
    },
  };
  let sends = 0;
  const options = {
    force: true, dryRun: false, repository, fetchImpl: fixtureFetch(calendar),
    fetchReaction: async () => ({ prices: {}, sources: [], warnings: [] }),
    targets: [{ platform: "discord", guildId: "g1", channelId: "c1" }],
    discordSender: async () => ({ id: `message-${++sends}` }),
  };

  await assert.rejects(() => automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:31:00Z" }), /release state unavailable/);
  const retried = await automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:32:00Z" });
  assert.equal(retried.status, "success");
  assert.equal(sends, 1);
  assert.equal((await repository.getMeta("market-content:release-state:v1")).monitoredEvents[0].observedAt, "2026-08-19T12:31:00.000Z");
});

test("data release does not resend after an external send when target receipt persistence fails once", async () => {
  const calendar = { result: [{ id: "us-cpi-target-ack", title: "US CPI YoY", country: "US", importance: 3, date: "2026-08-19T12:30:00Z", actual: "2.7", forecast: "2.8", previous: "2.9", unit: "%" }] };
  const base = automationRepository();
  let rejectTargetAck = true;
  const repository = {
    ...base,
    async setMeta(key, value) {
      const target = value?.entries?.[0]?.targets?.["discord:g1:c1"];
      if (key === "market-content:release-delivery:v1" && target?.status === "success" && rejectTargetAck) {
        rejectTargetAck = false;
        throw new Error("target receipt unavailable");
      }
      return base.setMeta(key, value);
    },
  };
  let sends = 0;
  const options = {
    force: true, dryRun: false, repository, fetchImpl: fixtureFetch(calendar),
    fetchReaction: async () => ({ prices: {}, sources: [], warnings: [] }),
    targets: [{ platform: "discord", guildId: "g1", channelId: "c1" }],
    discordSender: async () => ({ id: `message-${++sends}` }),
  };

  const first = await automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:31:00Z" });
  const second = await automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:32:00Z" });

  assert.equal(first.status, "success");
  assert.equal(second.status, "skipped");
  assert.equal(sends, 1);
});

test("Telegram release remains fail-closed without resending while its success receipt cannot persist", async () => {
  const calendar = { result: [{ id: "us-cpi-tg-receipt", title: "US CPI YoY", country: "US", importance: 3, date: "2026-08-19T12:30:00Z", actual: "2.7", forecast: "2.8", previous: "2.9", unit: "%" }] };
  const base = automationRepository();
  const repository = {
    ...base,
    async setMeta(key, value) {
      const target = value?.entries?.[0]?.targets?.["telegram:-1001:8"];
      if (key === "market-content:release-delivery:v1" && target?.status === "success") {
        throw new Error("target receipt unavailable");
      }
      return base.setMeta(key, value);
    },
  };
  let sends = 0;
  const options = {
    force: true, dryRun: false, repository, fetchImpl: fixtureFetch(calendar),
    fetchReaction: async () => ({ prices: {}, sources: [], warnings: [] }),
    targets: [{ chatId: "-1001", threadId: 8 }],
    telegramSender: async () => ({ message_id: ++sends }),
  };

  const first = await automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:31:00Z" });
  const second = await automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:32:00Z" });

  assert.equal(first.status, "queued");
  assert.equal(first.preview.targetResults[0].receiptFinalizationPending, true);
  assert.equal(second.status, "queued");
  assert.equal(second.preview.deliveryPlans.length, 0);
  assert.equal(sends, 1);
});

test("concurrent data-release runs send once and acknowledge before the queued run polls", async () => {
  const actualCalendar = { result: [{
    id: "us-cpi-concurrent",
    title: "US CPI YoY",
    country: "US",
    importance: 3,
    date: "2026-08-19T12:30:00Z",
    actual: "2.7",
    forecast: "2.8",
    previous: "2.9",
    unit: "%"
  }] };
  const repository = automationRepository();
  let sends = 0;
  const options = {
    now: "2026-08-19T12:31:00Z",
    force: true,
    dryRun: false,
    repository,
    fetchImpl: fixtureFetch(actualCalendar),
    fetchReaction: async () => ({ prices: {}, sources: [], warnings: [] }),
    targets: [{ platform: "discord", guildId: "g1", channelId: "c1" }],
    discordSender: async () => {
      await Promise.resolve();
      sends += 1;
      return { id: `message-${sends}` };
    }
  };

  const results = await Promise.all([
    automation.runAutomationJob("data-release-updates", options),
    automation.runAutomationJob("data-release-updates", options),
  ]);

  assert.deepEqual(results.map(({ status }) => status).sort(), ["skipped", "success"]);
  const success = results.find(({ status }) => status === "success");
  assert.equal(sends, success.preview.deliveryPlans[0].steps.length);
  assert.deepEqual((await repository.getMeta("market-content:release-state:v1")).publishedKeys, [
    success.preview.deduplicationKey,
  ]);
});

test("data-release run lease serializes two repository instances on one backend", async () => {
  const calendar = { result: [{ id: "us-cpi-shared-workers", title: "US CPI YoY", country: "US", importance: 3, date: "2026-08-19T12:30:00Z", actual: "2.7", forecast: "2.8", previous: "2.9", unit: "%" }] };
  const meta = new Map();
  const repository = () => ({
    async getMeta(key) { return structuredClone(meta.get(key) ?? null); },
    async setMeta(key, value) { meta.set(key, structuredClone(value)); return structuredClone(value); },
    async acquireMetaLease(key, lease, now) {
      const current = meta.get(key);
      if (current?.leaseUntil && Date.parse(current.leaseUntil) > new Date(now).getTime()) return null;
      meta.set(key, structuredClone(lease));
      return structuredClone(lease);
    },
    async releaseMetaLease(key, leaseId) {
      if (meta.get(key)?.leaseId !== leaseId) return false;
      meta.delete(key);
      return true;
    },
  });
  let sends = 0;
  const baseOptions = {
    now: "2026-08-19T12:31:00Z", force: true, dryRun: false,
    fetchImpl: fixtureFetch(calendar),
    fetchReaction: async () => ({ prices: {}, sources: [], warnings: [] }),
    targets: [{ platform: "discord", guildId: "g1", channelId: "c1" }],
    discordSender: async () => ({ id: `message-${++sends}` }),
  };

  const results = await Promise.all([
    automation.runAutomationJob("data-release-updates", { ...baseOptions, repository: repository() }),
    automation.runAutomationJob("data-release-updates", { ...baseOptions, repository: repository() }),
  ]);

  assert.deepEqual(results.map(({ status }) => status).sort(), ["skipped", "success"]);
  assert.equal(sends, 1);
});

test("an injected Telegram sender runs without a production bot token", async () => {
  const rss = `<?xml version="1.0"?><rss><channel><item><guid>btc-etf-send</guid><title>Bitcoin ETF records net inflow</title><link>https://example.com/etf-send</link><description>Institutional demand increased.</description><pubDate>Wed, 19 Aug 2026 06:00:00 GMT</pubDate></item></channel></rss>`;
  let sends = 0;
  const result = await automation.runAutomationJob("crypto-daily", {
    now: "2026-08-19T08:00:00Z",
    force: true,
    dryRun: false,
    fetchImpl: fixtureFetch(rss),
    targets: [{ chatId: "-1001", threadId: 8 }],
    telegramSender: async () => ({ message_id: ++sends })
  });
  assert.equal(result.status, "success");
  assert.ok(sends > 0);
});

test("market plans use platform renderers, strict paragraph chunks, and one final CTA", () => {
  const document = {
    templateId: "crypto-daily",
    version: "market-content-v1",
    nodes: [{ type: "heading", text: "Crypto Daily" }],
    sections: [
      { nodes: [{ type: "paragraph", text: `A-${"x".repeat(1800)}` }] },
      { nodes: [{ type: "paragraph", text: `B-${"y".repeat(1800)}` }] },
      { nodes: [{ type: "paragraph", text: `C-${"z".repeat(1800)}` }] }
    ]
  };
  const ctaContent = "**Join YUBIT**\n[Open](https://example.com/join)";
  const generated = { document };
  const [telegram] = automation.buildAutomationTelegramPlans("crypto-daily", generated, [{ chatId: "-1001", threadId: 8, ctaEnabled: true, ctaContent }]);
  const [discord] = automation.buildAutomationDiscordPlans("crypto-daily", generated, [{ platform: "discord", guildId: "g1", channelId: "c1", ctaEnabled: true, ctaContent }]);

  assert.ok(telegram.steps.length > 1);
  assert.ok(telegram.steps.every((step) => step.method === "sendMessage" && step.payload.parse_mode === "HTML" && step.payload.text.length < 4096));
  assert.equal(telegram.steps.filter((step) => step.payload.text.includes("Join YUBIT")).length, 1);
  assert.match(telegram.steps.at(-1).payload.text, /<b>Join YUBIT<\/b>/);
  assert.ok(discord.steps.length > 1);
  assert.ok(discord.steps.every((step) => step.payload.content.length < 2000));
  assert.equal(discord.steps.filter((step) => step.payload.content.includes("Join YUBIT")).length, 1);
  assert.match(discord.steps.at(-1).payload.content, /\*\*Join YUBIT\*\*/);
});

function marketDocumentWithParagraphs(lengths) {
  return {
    templateId: "crypto-daily",
    version: "market-content-v1",
    nodes: [],
    sections: [{ nodes: lengths.map((length, index) => ({
      type: "paragraph",
      text: `${index + 1}-${String.fromCharCode(97 + index).repeat(length - 2)}`
    })) }]
  };
}

test("multiline CTA remains one indivisible final block on Telegram and Discord", () => {
  const ctaContent = `**CTA START**\n${"j".repeat(120)}\n\nCTA END\n${"k".repeat(120)}`;
  const [telegram] = automation.buildAutomationTelegramPlans("crypto-daily", {
    document: marketDocumentWithParagraphs([1900, 1900])
  }, [{ chatId: "-1001", threadId: 8, ctaEnabled: true, ctaContent }]);
  const [discord] = automation.buildAutomationDiscordPlans("crypto-daily", {
    document: marketDocumentWithParagraphs([1800])
  }, [{ platform: "discord", guildId: "g1", channelId: "c1", ctaEnabled: true, ctaContent }]);

  for (const steps of [telegram.steps, discord.steps]) {
    assert.equal(steps.filter((step) => JSON.stringify(step.payload).includes("CTA START")).length, 1);
    assert.equal(steps.filter((step) => JSON.stringify(step.payload).includes("CTA END")).length, 1);
    const finalPayload = JSON.stringify(steps.at(-1).payload);
    assert.match(finalPayload, /CTA START/);
    assert.match(finalPayload, /CTA END/);
  }
  assert.ok(telegram.steps.every((step) => step.payload.text.length <= 4096));
  assert.ok(discord.steps.every((step) => step.payload.content.length <= 2000));
});

test("oversized CTA fails safely instead of splitting or producing an over-limit send", () => {
  assert.throws(() => automation.buildAutomationTelegramPlans("crypto-daily", {
    document: marketDocumentWithParagraphs([20])
  }, [{ chatId: "-1001", threadId: 8, ctaEnabled: true, ctaContent: "t".repeat(4097) }]), /CTA block exceeds the 4096 character platform limit/);
  assert.throws(() => automation.buildAutomationDiscordPlans("crypto-daily", {
    document: marketDocumentWithParagraphs([20])
  }, [{ platform: "discord", guildId: "g1", channelId: "c1", ctaEnabled: true, ctaContent: "d".repeat(2001) }]), /CTA block exceeds the 2000 character platform limit/);
});
