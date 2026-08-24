import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import * as automation from "../lib/automation-jobs.mjs";
import {
  WEEKLY_CALENDAR_META_KEY,
  markDataReleaseTargetPending,
  pollDataReleaseUpdates,
  prepareDataReleaseDelivery,
  prepareDataReleaseSend,
} from "../lib/data-release-monitor.mjs";
import { buildMarketPreviewFacts } from "../lib/distribution-ui.mjs";
import { JsonDistributionRepository } from "../lib/distribution-repository.mjs";
import { createObsidianContentStore } from "../lib/obsidian-content-store.mjs";
import { readJson, writeJson } from "../lib/json-store.js";

const { AUTOMATION_JOBS, automationSlot, automationTopicMatches } = automation;
const priorVaultPath = process.env.OBSIDIAN_VAULT_PATH;
const automationVaultPath = await mkdtemp(join(tmpdir(), "yubit-automation-vault-"));
await createObsidianContentStore({ vaultPath: automationVaultPath }).initialize();
process.env.OBSIDIAN_VAULT_PATH = automationVaultPath;
after(async () => {
  if (priorVaultPath === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
  else process.env.OBSIDIAN_VAULT_PATH = priorVaultPath;
  await rm(automationVaultPath, { recursive: true, force: true });
});

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
  assert.equal(url.searchParams.get("v"), "market-card-v5");
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
    templateVersion: "market-content-v2",
    contentPolicy: "fixed-template"
  });
  assert.deepEqual(automation.automationTemplateMetadata("weekly-calendar"), {
    templateVersion: "market-content-v2",
    contentPolicy: "fixed-template"
  });
  assert.deepEqual(automation.automationTemplateMetadata("data-release-updates"), {
    templateVersion: "market-content-v2",
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

function commercialReaction() {
  return verifiedReleaseReaction();
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

test("real market job previews preserve structured diagnostics for the distribution UI", async () => {
  const rss = `<?xml version="1.0"?><rss><channel><item><guid>btc-etf</guid><title>Bitcoin ETF records net inflow</title><link>https://example.com/etf</link><description>Institutional demand increased.</description><pubDate>Wed, 19 Aug 2026 06:00:00 GMT</pubDate></item></channel></rss>`;
  const daily = await automation.runAutomationJob("crypto-daily", {
    now: "2026-08-19T08:00:00Z",
    force: true,
    dryRun: true,
    repository: automationRepository(),
    fetchImpl: fixtureFetch(rss),
    targets: []
  });
  const dailyFacts = buildMarketPreviewFacts(daily.preview);

  assert.equal(daily.status, "success");
  assert.equal(daily.preview.diagnostics.candidates.length, 6);
  assert.equal(dailyFacts.candidateCount, 6);
  assert.equal(dailyFacts.selectedCount, 1);
  assert.equal(dailyFacts.missingCount, 2);
  assert.equal(dailyFacts.sources.length, 6);

  const unavailableCalendar = { result: [{
    id: "us-cpi-waiting",
    title: "US CPI YoY",
    country: "US",
    importance: 3,
    date: "2026-08-19T12:30:00Z",
    forecast: "2.8",
    previous: "2.9",
    unit: "%"
  }] };
  const unavailable = await automation.runAutomationJob("data-release-updates", {
    now: "2026-08-19T12:31:00Z",
    force: true,
    dryRun: true,
    repository: automationRepository(),
    fetchImpl: fixtureFetch(unavailableCalendar),
    fetchOfficialActual: async () => null,
    targets: []
  });
  const unavailableFacts = buildMarketPreviewFacts(unavailable.preview);

  assert.equal(unavailable.status, "skipped");
  assert.equal(unavailable.preview.skipReason, "official-actual-unavailable");
  assert.equal(unavailableFacts.candidateCount, 1);
  assert.equal(unavailableFacts.selectedCount, 0);
  assert.equal(unavailableFacts.missingCount, 1);
  assert.match(unavailableFacts.nextMonitoredEvent, /US CPI YoY/);
  assert.equal(unavailableFacts.sources[0].id, "tradingview-calendar");

  const conflictingCalendar = { result: ["2.7", "2.8"].map((actual, index) => ({
    id: "us-cpi-conflict",
    title: "US CPI YoY",
    country: "US",
    importance: 3,
    date: "2026-08-19T12:30:00Z",
    actual,
    forecast: "2.8",
    previous: "2.9",
    unit: "%",
    source: index ? "bls" : "tradingview"
  })) };
  const conflict = await automation.runAutomationJob("data-release-updates", {
    now: "2026-08-19T12:31:00Z",
    force: true,
    dryRun: true,
    repository: automationRepository(),
    fetchImpl: fixtureFetch(conflictingCalendar),
    targets: []
  });
  const conflictFacts = buildMarketPreviewFacts(conflict.preview);

  assert.equal(conflict.preview.skipReason, "official-actual-unavailable");
  assert.equal(conflictFacts.conflictCount, 0);
  assert.equal(conflictFacts.sources[0].id, "tradingview-calendar");

  const releasedCalendar = { result: [
    {
      id: "us-cpi",
      title: "US CPI YoY",
      country: "US",
      importance: 3,
      date: "2026-08-19T12:30:00Z",
      actual: "2.7",
      forecast: "2.8",
      previous: "2.9",
      unit: "%"
    },
    {
      id: "us-gdp-next",
      title: "US GDP",
      country: "US",
      importance: 3,
      date: "2026-08-19T14:00:00Z",
      forecast: "2.1",
      previous: "2.0",
      unit: "%"
    }
  ] };
  const released = await automation.runAutomationJob("data-release-updates", {
    now: "2026-08-19T12:31:00Z",
    force: true,
    dryRun: true,
    repository: automationRepository(),
    fetchCalendar: async () => ({
      events: [
        verifiedReleaseEvent(),
        verifiedReleaseEvent({ id: "us-gdp-next", indicator: "gdp", title: "US GDP", scheduledAt: "2026-08-19T14:00:00.000Z" }),
      ],
      sources: [{ id: "bls-calendar", status: "ok" }],
      warnings: [],
    }),
    fetchOfficialActual: async () => officialEvidence("2.7%"),
    fetchReaction: async () => commercialReaction(),
    targets: []
  });
  const releasedFacts = buildMarketPreviewFacts(released.preview);

  assert.equal(released.preview.publishable, true);
  assert.equal(releasedFacts.candidateCount, 1);
  assert.equal(releasedFacts.selectedCount, 1);
  assert.equal(releasedFacts.missingCount, 0);
  assert.match(releasedFacts.nextMonitoredEvent, /US GDP/);
});

test("read-only automation previews suppress the run audit log without changing normal dry-run auditing", async () => {
  const rss = `<?xml version="1.0"?><rss><channel><item><guid>btc-etf-readonly</guid><title>Bitcoin ETF records net inflow</title><link>https://example.com/etf-readonly</link><description>Institutional demand increased.</description><pubDate>Wed, 19 Aug 2026 06:00:00 GMT</pubDate></item></channel></rss>`;
  const logged = [];
  const options = {
    now: "2026-08-19T08:00:00Z",
    force: true,
    dryRun: true,
    repository: automationRepository(),
    fetchImpl: fixtureFetch(rss),
    targets: [{ chatId: "-1001", threadId: 8 }],
    runLogWriter: async (entry) => {
      logged.push(entry);
      return entry;
    }
  };
  const preview = await automation.runAutomationJob("crypto-daily", { ...options, readOnlyPreview: true });
  assert.equal(preview.status, "success");
  assert.equal(logged.length, 0);

  await automation.runAutomationJob("crypto-daily", options);
  assert.equal(logged.length, 1);
});

test("weekly diagnostics select the deduplicated sorted document events while retaining raw candidates", async () => {
  const calendar = { result: [
    { id: "gdp", title: "US GDP", country: "US", importance: 3, date: "2026-08-20T12:30:00Z", forecast: "2.1", previous: "2.0", unit: "%" },
    { id: "cpi-secondary", title: "US CPI YoY", country: "US", importance: 3, date: "2026-08-19T12:30:00Z", forecast: "2.8", previous: "2.9", unit: "%", source: "secondary" },
    { id: "cpi-primary", title: "US CPI YoY", country: "US", importance: 3, date: "2026-08-19T12:30:00Z", forecast: "2.8", previous: "2.9", unit: "%", source: "primary" },
    { id: "minor", title: "Minor survey", country: "US", importance: 1, date: "2026-08-19T09:00:00Z" }
  ] };

  const result = await automation.runAutomationJob("weekly-calendar", {
    now: "2026-08-19T08:00:00Z",
    force: true,
    dryRun: true,
    repository: automationRepository(),
    fetchImpl: fixtureFetch(calendar),
    targets: []
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.preview.skipReason, "official-schedule-unavailable");
  assert.equal(result.preview.diagnostics.candidates.length, 3);
  assert.deepEqual(result.preview.diagnostics.selected.map((event) => event.title), ["US CPI YoY", "US GDP"]);
  assert.equal(result.preview.diagnostics.nextMonitoredEvent.title, "US CPI YoY");
  assert.equal(result.preview.diagnostics.nextMonitoredEvent.scheduledAt, "2026-08-19T12:30:00.000Z");
  assert.equal(result.preview.sources[0].lastSuccessAt, "2026-08-19T08:00:00.000Z");
});

test("weekly diagnostics choose the earliest exact event at or after now", async () => {
  const calendar = { result: [
    { id: "past", title: "US Retail Sales", country: "US", importance: 3, date: "2026-08-19T11:00:00Z" },
    { id: "later", title: "US GDP", country: "US", importance: 3, date: "2026-08-19T14:00:00Z" },
    { id: "boundary", title: "US CPI YoY", country: "US", importance: 3, date: "2026-08-19T12:30:00Z" }
  ] };

  const result = await automation.runAutomationJob("weekly-calendar", {
    now: "2026-08-19T12:30:00Z",
    force: true,
    dryRun: true,
    repository: automationRepository(),
    fetchImpl: fixtureFetch(calendar),
    targets: []
  });

  assert.deepEqual(result.preview.diagnostics.selected.map((event) => event.title), [
    "US Retail Sales", "US CPI YoY", "US GDP"
  ]);
  assert.equal(result.preview.diagnostics.nextMonitoredEvent.title, "US CPI YoY");
  assert.equal(result.preview.diagnostics.nextMonitoredEvent.scheduledAt, "2026-08-19T12:30:00.000Z");
});

test("weekly publication blocks offsetless events before persistence or delivery", async () => {
  const calendar = { result: [
    { id: "past", title: "US CPI YoY", country: "US", importance: 3, date: "2026-08-19T12:30:00Z" },
    { id: "offsetless", title: "FOMC Minutes", country: "US", importance: 3, date: "2026-08-20T18:00:00" }
  ] };

  let sends = 0;
  const repository = automationRepository();
  const result = await automation.runAutomationJob("weekly-calendar", {
    now: "2026-08-19T15:00:00Z",
    force: true,
    dryRun: false,
    repository,
    fetchImpl: fixtureFetch(calendar),
    targets: [{ platform: "discord", guildId: "g1", channelId: "c1" }],
    discordSender: async () => { sends += 1; return { id: "unexpected" }; },
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.preview.skipReason, "official-schedule-unavailable");
  assert.equal(sends, 0);
  assert.equal(repository.writes.some(([key]) => String(key).startsWith("market-editorial-v1:")), false);
});

test("daily and weekly jobs fail closed without sending when every source is unavailable", async () => {
  const unavailableFetch = async () => new Response("unavailable", { status: 400 });
  for (const jobId of ["crypto-daily", "weekly-calendar"]) {
    let sends = 0;
    const result = await automation.runAutomationJob(jobId, {
      now: "2026-08-19T08:00:00Z",
      force: true,
      dryRun: false,
      repository: automationRepository(),
      fetchImpl: unavailableFetch,
      targets: [{ platform: "discord", guildId: "g1", channelId: "c1" }],
      discordSender: async () => { sends += 1; }
    });

    assert.equal(result.status, "skipped", jobId);
    assert.equal(result.preview.publishable, false, jobId);
    assert.equal(result.preview.skipReason, "sources-unavailable", jobId);
    assert.equal(result.preview.diagnostics.selected.length, 0, jobId);
    assert.equal(sends, 0, jobId);
  }
});

test("healthy sources with no significant market content skip as no-publishable-content", async () => {
  const emptyRss = `<?xml version="1.0"?><rss><channel></channel></rss>`;
  const cases = [
    ["crypto-daily", fixtureFetch(emptyRss)],
    ["weekly-calendar", fixtureFetch({ result: [] })]
  ];
  for (const [jobId, fetchImpl] of cases) {
    const result = await automation.runAutomationJob(jobId, {
      now: "2026-08-19T08:00:00Z",
      force: true,
      dryRun: true,
      repository: automationRepository(),
      fetchImpl,
      targets: []
    });
    assert.equal(result.status, "skipped", jobId);
    assert.equal(result.preview.skipReason, "no-publishable-content", jobId);
    assert.ok(result.preview.sources.some((source) => source.status === "ok"), jobId);
  }
});

test("weekly calendar caches only when persist is explicitly true", async () => {
  const calendar = { result: [{ id: "us-cpi", title: "US CPI YoY", country: "US", importance: 3, date: "2026-08-20T12:30:00Z", forecast: "2.8", previous: "2.9", unit: "%" }] };
  const repository = automationRepository();
  await automation.buildContent("weekly-calendar", new Date("2026-08-19T08:00:00Z"), { fetchImpl: fixtureFetch(calendar), repository, persist: false });
  assert.equal(repository.writes.length, 0);
  await automation.buildContent("weekly-calendar", new Date("2026-08-19T08:00:00Z"), { fetchImpl: fixtureFetch(calendar), repository, persist: true });
  assert.equal(repository.writes.filter(([key]) => key === "market-content:weekly-calendar:v1").length, 1);
});

test("weekly automation preserves a healthy cache when every current source fails", async () => {
  const cachedEvent = {
    id: "cached-cpi",
    sourceId: "cached-cpi",
    title: "US CPI YoY",
    country: "US",
    importance: 3,
    scheduledAt: "2026-08-19T12:30:00.000Z",
    values: { actual: null, forecast: "2.8%", previous: "2.9%" },
    rawValues: { actual: null, forecast: "2.8", previous: "2.9" }
  };
  const cachedCalendar = {
    calendarWeek: "2026-08-17",
    events: [cachedEvent],
    sources: [{ id: "tradingview-calendar", status: "ok" }],
    updatedAt: "2026-08-19T08:00:00.000Z"
  };
  const directory = await mkdtemp(join(tmpdir(), "weekly-cache-preservation-"));
  const previousDirectory = process.env.JSON_STORE_DIRECTORY;
  const previousBackend = process.env.JSON_STORE_BACKEND;
  process.env.JSON_STORE_DIRECTORY = directory;
  process.env.JSON_STORE_BACKEND = "local";
  try {
    const repository = new JsonDistributionRepository();
    await repository.setMeta(WEEKLY_CALENDAR_META_KEY, cachedCalendar);

    await automation.buildContent("weekly-calendar", new Date("2026-08-19T09:00:00Z"), {
      repository,
      persist: true,
      fetchImpl: async () => new Response("timeout", { status: 408 })
    });

    assert.deepEqual(await repository.getMeta(WEEKLY_CALENDAR_META_KEY), cachedCalendar);
    const monitored = await pollDataReleaseUpdates({
      now: "2026-08-19T12:26:00Z",
      repository,
      persist: false
    });
    assert.equal(monitored.nextMonitoredEvent.id, "cached-cpi");
  } finally {
    if (previousDirectory === undefined) delete process.env.JSON_STORE_DIRECTORY;
    else process.env.JSON_STORE_DIRECTORY = previousDirectory;
    if (previousBackend === undefined) delete process.env.JSON_STORE_BACKEND;
    else process.env.JSON_STORE_BACKEND = previousBackend;
    await rm(directory, { recursive: true, force: true });
  }
});

test("weekly automation persists healthy empty and mixed-source results, but not schema failures", async () => {
  const oldCalendar = {
    calendarWeek: "2026-08-17",
    events: [{ id: "old" }],
    updatedAt: "2026-08-19T07:00:00.000Z"
  };
  const schemaRepository = automationRepository({ [WEEKLY_CALENDAR_META_KEY]: oldCalendar });
  await automation.buildContent("weekly-calendar", new Date("2026-08-19T08:00:00Z"), {
    repository: schemaRepository,
    persist: true,
    fetchImpl: fixtureFetch({ unexpected: true })
  });
  assert.deepEqual(await schemaRepository.getMeta(WEEKLY_CALENDAR_META_KEY), oldCalendar);

  const emptyRepository = automationRepository({ [WEEKLY_CALENDAR_META_KEY]: oldCalendar });
  await automation.buildContent("weekly-calendar", new Date("2026-08-19T08:00:00Z"), {
    repository: emptyRepository,
    persist: true,
    fetchImpl: fixtureFetch({ result: [] })
  });
  assert.deepEqual((await emptyRepository.getMeta(WEEKLY_CALENDAR_META_KEY)).events, []);

  const mixedRepository = automationRepository({ [WEEKLY_CALENDAR_META_KEY]: oldCalendar });
  const mixedEvent = { id: "mixed-cpi", title: "US CPI YoY", country: "US", importance: 3, scheduledAt: "2026-08-20T12:30:00.000Z" };
  await automation.buildContent("weekly-calendar", new Date("2026-08-19T08:00:00Z"), {
    repository: mixedRepository,
    persist: true,
    fetchImpl: fixtureFetch({ result: [] }),
    fetchCalendar: async () => ({
      events: [mixedEvent],
      sources: [{ id: "primary", status: "timeout" }, { id: "fallback", status: "ok" }],
      warnings: ["primary timed out"]
    })
  });
  assert.deepEqual((await mixedRepository.getMeta(WEEKLY_CALENDAR_META_KEY)).events, [mixedEvent]);
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

test("data release polling excludes non-allowlist events before selecting a publishable release", async () => {
  const repository = automationRepository();
  const result = await automation.buildContent("data-release-updates", new Date("2026-08-19T12:31:00Z"), {
    repository,
    persist: false,
    fetchCalendar: async () => ({
      events: [
        { id: "a-confidence", title: "Consumer Confidence", country: "US", scheduledAt: "2026-08-19T12:30:00Z", values: { actual: "98", forecast: "96", previous: "95" }, source: { label: "Calendar", url: "https://calendar.example/confidence" } },
        verifiedReleaseEvent({ id: "z-cpi" }),
      ],
      sources: [{ id: "calendar", status: "ok" }],
      warnings: [],
    }),
    fetchReaction: async () => commercialReaction(),
    fetchOfficialActual: async () => officialEvidence("2.7%"),
  });

  assert.equal(result.publishable, true);
  assert.equal(result.event.id, "z-cpi");
  assert.equal(result.document.indicator, "cpi");
});

test("data release preserves successful receipts but never retries an uncertain failed send", async () => {
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
  const sends = new Map();
  const discordSender = async (channelId) => {
    sends.set(channelId, (sends.get(channelId) || 0) + 1);
    if (channelId === "c2") throw new Error("response timeout after remote accept");
    return { id: `message-${channelId}-${sends.get(channelId)}` };
  };
  const run = (now) => automation.runAutomationJob("data-release-updates", {
    now,
    force: true,
    dryRun: false,
    repository,
    ...verifiedDataReleaseOptions(repository),
    fetchImpl: fixtureFetch(actualCalendar),
    fetchReaction: async () => commercialReaction(),
    targets,
    discordSender
  });

  const uncertain = await run("2026-08-19T12:31:00Z");
  assert.equal(uncertain.status, "manual-reconciliation");
  assert.deepEqual((await repository.getMeta("market-content:release-state:v1")).publishedKeys, []);

  const retry = await run("2026-08-19T12:32:00Z");
  assert.ok(["manual-reconciliation", "skipped"].includes(retry.status));
  assert.deepEqual(Object.fromEntries(sends), {
    c1: uncertain.preview.deliveryPlans.find((plan) => plan.target.channelId === "c1").steps.length,
    c2: 1,
  });
  assert.deepEqual((await repository.getMeta("market-content:release-state:v1")).publishedKeys, []);
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
    ...verifiedDataReleaseOptions(repository),
    fetchImpl: fixtureFetch(calendar),
    fetchReaction: async () => commercialReaction(),
    targets: [{ id: "queued-release", chatId: "-1001", threadId: 8 }],
  };

  const queued = await automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:31:00Z" });
  const stillQueued = await automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:32:00Z" });

  assert.equal(queued.status, "queued");
  assert.equal(queued.preview.deliveryPlans.length, 1);
  assert.match(queued.preview.targetResults[0].releaseClaimToken, /^[0-9a-f-]{36}$/i);
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
    force: true, dryRun: false, repository, ...verifiedDataReleaseOptions(repository), fetchImpl: fixtureFetch(calendar),
    fetchReaction: async () => commercialReaction(),
    targets: [{ platform: "discord", guildId: "g1", channelId: "c1" }],
    discordSender: async () => ({ id: `message-${++sends}` }),
  };

  await assert.rejects(() => automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:31:00Z" }), /release state unavailable/);
  const retried = await automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:32:00Z" });
  assert.equal(retried.status, "success");
  assert.equal(sends, 1);
  assert.equal((await repository.getMeta("market-content:release-state:v1")).monitoredEvents[0].observedAt, "2026-08-19T12:30:00.000Z");
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
    force: true, dryRun: false, repository, ...verifiedDataReleaseOptions(repository), fetchImpl: fixtureFetch(calendar),
    fetchReaction: async () => commercialReaction(),
    targets: [{ platform: "discord", guildId: "g1", channelId: "c1" }],
    discordSender: async () => ({ id: `message-${++sends}` }),
  };

  const first = await automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:31:00Z" });
  const second = await automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:32:00Z" });

  assert.equal(first.status, "success");
  assert.equal(second.status, "skipped");
  assert.equal(sends, first.preview.deliveryPlans[0].steps.length);
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
    force: true, dryRun: false, repository, ...verifiedDataReleaseOptions(repository), fetchImpl: fixtureFetch(calendar),
    fetchReaction: async () => commercialReaction(),
    targets: [{ chatId: "-1001", threadId: 8 }],
    telegramSender: async () => ({ message_id: ++sends }),
  };

  const first = await automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:31:00Z" });
  const second = await automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:32:00Z" });

  repository.setMeta = base.setMeta.bind(base);
  const recovered = await automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:33:00Z" });

  assert.equal(first.status, "queued");
  assert.equal(first.preview.targetResults[0].receiptFinalizationPending, true);
  assert.equal(second.status, "queued");
  assert.equal(second.preview.deliveryPlans.length, 0);
  assert.equal(recovered.status, "success");
  assert.equal(recovered.preview.deliveryPlans.length, 0);
  assert.deepEqual((await repository.getMeta("market-content:release-state:v1")).publishedKeys, [recovered.preview.deduplicationKey]);
  assert.equal(sends, first.preview.deliveryPlans[0].steps.length);
});

test("a sending marker from a crash before the first send requires manual reconciliation", async () => {
  const calendar = { result: [{ id: "us-cpi-before-send-crash", title: "US CPI YoY", country: "US", importance: 3, date: "2026-08-19T12:30:00Z", actual: "2.7", forecast: "2.8", previous: "2.9", unit: "%" }] };
  const repository = automationRepository();
  const target = { platform: "discord", guildId: "g1", channelId: "c1" };
  const common = { force: true, repository, ...verifiedDataReleaseOptions(repository), fetchImpl: fixtureFetch(calendar), fetchReaction: async () => commercialReaction(), targets: [target] };
  const dryRun = await automation.runAutomationJob("data-release-updates", { ...common, dryRun: true, now: "2026-08-19T12:31:00Z" });
  const deduplicationKey = dryRun.preview.deduplicationKey;
  const event = dryRun.preview.event;
  const targetKey = "discord:g1:c1";
  await prepareDataReleaseDelivery({ repository, deduplicationKey, event, targetKeys: [targetKey], now: "2026-08-19T12:31:01Z" });
  await markDataReleaseTargetPending({ repository, deduplicationKey, targetKey, event, now: "2026-08-19T12:31:02Z" });
  await prepareDataReleaseSend({ repository, deduplicationKey, targetKey, now: "2026-08-19T12:31:03Z" });
  let sends = 0;

  const result = await automation.runAutomationJob("data-release-updates", { ...common, dryRun: false, now: "2026-08-19T12:32:00Z", discordSender: async () => ({ id: `message-${++sends}` }) });
  const retry = await automation.runAutomationJob("data-release-updates", { ...common, dryRun: false, now: "2026-08-19T12:33:00Z", discordSender: async () => ({ id: `message-${++sends}` }) });

  assert.equal(result.status, "manual-reconciliation");
  assert.equal(result.preview.targetResults[0].deliveryState, "uncertain-delivery");
  assert.equal(result.preview.targetResults[0].manualReconciliationRequired, true);
  assert.equal(retry.status, "manual-reconciliation");
  assert.equal(sends, 0);
  assert.deepEqual((await repository.getMeta("market-content:release-state:v1")).publishedKeys, []);
  assert.equal((await repository.getMeta("market-content:release-sent:v1")).entries[0].status, "sending");
});

test("a multi-step crash remains uncertain and never falsely acknowledges or resends", async () => {
  const calendar = { result: [{ id: "us-cpi-mid-send-crash", title: "US CPI YoY", country: "US", importance: 3, date: "2026-08-19T12:30:00Z", actual: "2.7", forecast: "2.8", previous: "2.9", unit: "%" }] };
  const repository = automationRepository();
  let sends = 0;
  const target = { platform: "discord", guildId: "g1", channelId: "c1" };
  const common = { force: true, repository, ...verifiedDataReleaseOptions(repository), fetchImpl: fixtureFetch(calendar), fetchReaction: async () => commercialReaction(), targets: [target] };
  const dryRun = await automation.runAutomationJob("data-release-updates", { ...common, dryRun: true, now: "2026-08-19T12:31:00Z" });
  const deduplicationKey = dryRun.preview.deduplicationKey;
  const event = dryRun.preview.event;
  const targetKey = "discord:g1:c1";
  await prepareDataReleaseDelivery({ repository, deduplicationKey, event, targetKeys: [targetKey], now: "2026-08-19T12:31:01Z" });
  await markDataReleaseTargetPending({ repository, deduplicationKey, targetKey, event, now: "2026-08-19T12:31:02Z" });
  await repository.setMeta("market-content:release-sent:v1", { version: 1, entries: [{ deduplicationKey, targetKey, status: "sending", messageIds: ["first-step-message"], updatedAt: "2026-08-19T12:31:03Z" }], updatedAt: "2026-08-19T12:31:03Z" });
  const first = await automation.runAutomationJob("data-release-updates", { ...common, dryRun: false, now: "2026-08-19T12:31:30Z", discordSender: async () => ({ id: `message-${++sends}` }) });
  const retry = await automation.runAutomationJob("data-release-updates", { ...common, dryRun: false, now: "2026-08-19T12:32:00Z", discordSender: async () => ({ id: `message-${++sends}` }) });

  assert.equal(first.status, "manual-reconciliation");
  assert.ok(["manual-reconciliation", "skipped"].includes(retry.status));
  assert.equal(sends, 0);
  assert.deepEqual((await repository.getMeta("market-content:release-state:v1")).publishedKeys, []);
  const marker = (await repository.getMeta("market-content:release-sent:v1")).entries[0];
  assert.equal(marker.status, "sending");
  assert.deepEqual(marker.messageIds, ["first-step-message"]);
});

for (const platform of ["Telegram", "Discord"]) {
  test(`${platform} accepted-then-timeout without an id remains uncertain and is never resent`, async () => {
    const calendar = { result: [{ id: `us-cpi-${platform.toLowerCase()}-timeout`, title: "US CPI YoY", country: "US", importance: 3, date: "2026-08-19T12:30:00Z", actual: "2.7", forecast: "2.8", previous: "2.9", unit: "%" }] };
    const repository = automationRepository();
    const target = platform === "Telegram"
      ? { chatId: "-1001", threadId: 8 }
      : { platform: "discord", guildId: "g1", channelId: "c1" };
    let calls = 0;
    const sender = async () => {
      calls += 1;
      throw new Error("response timeout after remote accept");
    };
    const options = {
      force: true,
      dryRun: false,
      repository,
      ...verifiedDataReleaseOptions(repository),
      fetchImpl: fixtureFetch(calendar),
      fetchReaction: async () => commercialReaction(),
      targets: [target],
      ...(platform === "Telegram" ? { telegramSender: sender } : { discordSender: sender }),
    };

    const first = await automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:31:00Z" });
    const second = await automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:32:00Z" });

    assert.equal(first.status, "manual-reconciliation");
    assert.equal(first.preview.targetResults[0].deliveryState, "uncertain-delivery");
    assert.equal(first.preview.targetResults[0].manualReconciliationRequired, true);
    assert.ok(["manual-reconciliation", "skipped"].includes(second.status));
    assert.equal(calls, 1);
    assert.deepEqual((await repository.getMeta("market-content:release-state:v1")).publishedKeys, []);
    assert.equal((await repository.getMeta("market-content:release-sent:v1")).entries[0].status, "sending");
  });
}

test("data-release run lease renews across its TTL and releases after an exception", async () => {
  const calendar = { result: [{ id: "us-cpi-lease-heartbeat", title: "US CPI YoY", country: "US", importance: 3, date: "2026-08-19T12:30:00Z", actual: "2.7", forecast: "2.8", previous: "2.9", unit: "%" }] };
  const meta = new Map();
  const repository = () => ({
    writes: [],
    async getMeta(key) { return structuredClone(meta.get(key) ?? null); },
    async setMeta(key, value) { this.writes.push([key, structuredClone(value)]); meta.set(key, structuredClone(value)); return value; },
    async acquireMetaLease(key, lease, now) {
      const current = meta.get(key);
      if (current?.leaseUntil && Date.parse(current.leaseUntil) > new Date(now).getTime()) return null;
      meta.set(key, structuredClone(lease));
      return structuredClone(lease);
    },
    async getMetaLease(key) { return structuredClone(meta.get(key) ?? null); },
    async renewMetaLease(key, leaseId, leaseUntil) {
      if (meta.get(key)?.leaseId !== leaseId) return null;
      const renewed = { ...meta.get(key), leaseUntil };
      meta.set(key, renewed);
      return structuredClone(renewed);
    },
    async releaseMetaLease(key, leaseId) {
      if (meta.get(key)?.leaseId !== leaseId) return false;
      meta.delete(key);
      return true;
    },
  });
  let sends = 0;
  let releaseFirstSend;
  const firstSendStarted = new Promise((resolve) => { releaseFirstSend = resolve; });
  const firstRepository = repository();
  const first = automation.runAutomationJob("data-release-updates", {
    now: "2026-08-19T12:31:00Z", force: true, dryRun: false, repository: firstRepository,
    ...verifiedDataReleaseOptions(firstRepository),
    releaseLeaseTtlMs: 100, releaseLeaseHeartbeatMs: 10,
    fetchImpl: fixtureFetch(calendar), fetchReaction: async () => commercialReaction(),
    targets: [{ platform: "discord", guildId: "g1", channelId: "c1" }],
    discordSender: async () => {
      sends += 1;
      releaseFirstSend();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { id: "message-1" };
    },
  });
  await firstSendStarted;
  await new Promise((resolve) => setTimeout(resolve, 150));
  const secondRepository = repository();
  const second = automation.runAutomationJob("data-release-updates", {
    now: "2026-08-19T12:31:00Z", force: true, dryRun: false, repository: secondRepository,
    ...verifiedDataReleaseOptions(secondRepository),
    releaseLeaseTtlMs: 100, releaseLeaseHeartbeatMs: 10,
    fetchImpl: fixtureFetch(calendar), fetchReaction: async () => commercialReaction(),
    targets: [{ platform: "discord", guildId: "g1", channelId: "c1" }],
    discordSender: async () => ({ id: `unexpected-${++sends}` }),
  });
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(({ status }) => status).sort(), ["skipped", "success"]);
  assert.equal(sends, results.find(({ status }) => status === "success").preview.deliveryPlans[0].steps.length);
  assert.equal(meta.has("market-content:release-run-lock:v1"), false);
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
    ...verifiedDataReleaseOptions(repository),
    fetchImpl: fixtureFetch(actualCalendar),
    fetchReaction: async () => commercialReaction(),
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
    writes: [],
    async getMeta(key) { return structuredClone(meta.get(key) ?? null); },
    async setMeta(key, value) { this.writes.push([key, structuredClone(value)]); meta.set(key, structuredClone(value)); return structuredClone(value); },
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
  const repositoryOne = repository();
  const repositoryTwo = repository();
  const baseOptions = {
    now: "2026-08-19T12:31:00Z", force: true, dryRun: false,
    fetchImpl: fixtureFetch(calendar),
    fetchReaction: async () => commercialReaction(),
    targets: [{ platform: "discord", guildId: "g1", channelId: "c1" }],
    discordSender: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { id: `message-${++sends}` };
    },
  };

  const results = await Promise.all([
    automation.runAutomationJob("data-release-updates", { ...baseOptions, repository: repositoryOne, ...verifiedDataReleaseOptions(repositoryOne) }),
    automation.runAutomationJob("data-release-updates", { ...baseOptions, repository: repositoryTwo, ...verifiedDataReleaseOptions(repositoryTwo) }),
  ]);

  assert.deepEqual(results.map(({ status }) => status).sort(), ["skipped", "success"]);
  assert.equal(sends, results.find(({ status }) => status === "success").preview.deliveryPlans[0].steps.length);
});

test("an injected Telegram sender runs without a production bot token", async () => {
  const rss = `<?xml version="1.0"?><rss><channel><item><guid>btc-etf-send</guid><title>Bitcoin ETF records net inflow</title><link>https://example.com/etf-send</link><description>Institutional demand increased.</description><pubDate>Wed, 19 Aug 2026 06:00:00 GMT</pubDate></item></channel></rss>`;
  let sends = 0;
  const controller = new AbortController();
  let senderSignal;
  const result = await automation.runAutomationJob("crypto-daily", {
    now: "2026-08-19T08:00:00Z",
    force: true,
    dryRun: false,
    fetchImpl: fixtureFetch(rss),
    targets: [{ chatId: "-1001", threadId: 8 }],
    signal: controller.signal,
    telegramSender: async (_token, _method, _payload, options) => {
      senderSignal = options.signal;
      return { message_id: ++sends };
    }
  });
  assert.equal(result.status, "success");
  assert.ok(sends > 0);
  assert.equal(senderSignal, controller.signal);
});

test("Telegram bot API delivery honors pre-abort and in-flight abort", async () => {
  const pre = new AbortController();
  pre.abort(new Error("TELEGRAM_PRE_ABORTED"));
  let preFetchCalls = 0;
  await assert.rejects(automation.telegramCall("token", "sendMessage", { chat_id: "-1001", text: "stop" }, async () => {
    preFetchCalls += 1;
  }, { signal: pre.signal, env: { TELEGRAM_PUBLISHER_MODE: "bot" } }), /TELEGRAM_PRE_ABORTED/);
  assert.equal(preFetchCalls, 0);

  const inflight = new AbortController();
  let observedSignal;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  const request = automation.telegramCall("token", "sendMessage", { chat_id: "-1001", text: "stop" }, async (_url, options) => {
    observedSignal = options.signal;
    markFetchStarted();
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  }, { signal: inflight.signal, env: { TELEGRAM_PUBLISHER_MODE: "bot" } });
  await fetchStarted;
  inflight.abort(new Error("TELEGRAM_INFLIGHT_ABORTED"));
  await assert.rejects(request, /TELEGRAM_INFLIGHT_ABORTED/);
  assert.equal(observedSignal, inflight.signal);
});

test("market plans use platform renderers, strict paragraph chunks, and one final CTA", () => {
  const document = {
    templateId: "crypto-daily",
    version: "market-content-v2",
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
  assert.deepEqual(telegram.steps.at(-1).ctaBoundary, {
    kind: "destination-cta",
    placement: "suffix",
    platform: "telegram",
    method: "sendMessage",
    field: "text",
    start: telegram.steps.at(-1).payload.text.indexOf("<b>Join YUBIT</b>"),
    end: telegram.steps.at(-1).payload.text.length,
    stepIndex: telegram.steps.length - 1,
    stepCount: telegram.steps.length,
  });
  assert.ok(discord.steps.length > 1);
  assert.ok(discord.steps.every((step) => step.payload.content.length < 2000));
  assert.equal(discord.steps.filter((step) => step.payload.content.includes("Join YUBIT")).length, 1);
  assert.match(discord.steps.at(-1).payload.content, /\*\*Join YUBIT\*\*/);
  assert.deepEqual(discord.steps.at(-1).ctaBoundary, {
    kind: "destination-cta",
    placement: "suffix",
    platform: "discord",
    method: "sendMessage",
    field: "content",
    start: discord.steps.at(-1).payload.content.indexOf("**Join YUBIT**"),
    end: discord.steps.at(-1).payload.content.length,
    stepIndex: discord.steps.length - 1,
    stepCount: discord.steps.length,
  });
});

test("market planners mark only the CTA they append, not an identical non-final heading", () => {
  const target = { platform: "telegram", chatId: "-1001", threadId: 8, ctaEnabled: true, ctaContent: "**BTC**" };
  const [plan] = automation.buildAutomationTelegramPlans("crypto-daily", {
    document: {
      templateId: "crypto-daily",
      version: "market-content-v2",
      nodes: [
        { type: "paragraph", text: `Opening ${"x".repeat(2050)}` },
        { type: "heading", text: "BTC" },
      ],
      sections: [{ nodes: [{ type: "paragraph", text: `Update ${"y".repeat(2050)}` }] }],
    },
  }, [target]);

  assert.ok(plan.steps.length > 1);
  assert.match(plan.steps[0].payload.text, /<b>BTC<\/b>$/);
  assert.equal(plan.steps[0].ctaBoundary, undefined);
  assert.equal(plan.steps.filter((step) => step.ctaBoundary).length, 1);
  assert.equal(plan.steps.at(-1).ctaBoundary.stepIndex, plan.steps.length - 1);
});

for (const jobId of ["crypto-daily", "weekly-calendar", "data-release-updates"]) {
  test(`${jobId} plans preserve platform formatting and append one CTA to each destination final chunk`, () => {
    const document = {
      templateId: jobId,
      version: "market-content-v2",
      nodes: [{ type: "heading", text: "Market <Update>" }],
      sections: [
        { nodes: [{ type: "paragraph", text: `A-${"x".repeat(1600)}` }] },
        { nodes: [{ type: "paragraph", text: `B-${"y".repeat(1600)}` }] },
        { nodes: [{ type: "paragraph", text: `C-${"z".repeat(1600)}` }] },
        { nodes: [{ type: "link", text: "Verified source", url: "https://example.com/source?a=1&b=2" }] },
      ],
    };
    const ctaContent = "**START TRADING NOW**\n[Open YUBIT](https://example.com/join?a=1&b=2)";
    const telegramPlans = automation.buildAutomationTelegramPlans(jobId, { document }, [
      { platform: "telegram", chatId: "-1001", threadId: 7, ctaEnabled: true, ctaContent },
      { platform: "telegram", chatId: "-1001", threadId: 8, ctaEnabled: true, ctaContent },
    ]);
    const discordPlans = automation.buildAutomationDiscordPlans(jobId, { document }, [
      { platform: "discord", guildId: "g1", channelId: "c1", ctaEnabled: true, ctaContent },
      { platform: "discord", guildId: "g1", channelId: "c2", ctaEnabled: true, ctaContent },
    ]);

    assert.deepEqual(telegramPlans.map((plan) => plan.target.threadId), [7, 8]);
    assert.deepEqual(discordPlans.map((plan) => plan.target.channelId), ["c1", "c2"]);
    for (const plan of telegramPlans) {
      assert.ok(plan.steps.length > 1);
      assert.ok(plan.steps.every((step) => step.payload.parse_mode === "HTML"));
      assert.match(plan.steps[0].payload.text, /<b>Market &lt;Update&gt;<\/b>/);
      assert.match(plan.steps.at(-1).payload.text, /<a href="https:\/\/example\.com\/join\?a=1&amp;b=2">Open YUBIT<\/a>/);
      assert.equal(plan.steps.filter((step) => step.payload.text.includes("START TRADING NOW")).length, 1);
      assert.doesNotMatch(plan.steps.map((step) => step.payload.text).join("\n"), /\[Open YUBIT\]\(/);
    }
    for (const plan of discordPlans) {
      assert.ok(plan.steps.length > 1);
      assert.match(plan.steps[0].payload.content, /\*\*Market \\<Update\\>\*\*/);
      assert.match(plan.steps.at(-1).payload.content, /\[Open YUBIT\]\(https:\/\/example\.com\/join\?a=1&b=2\)/);
      assert.equal(plan.steps.filter((step) => step.payload.content.includes("START TRADING NOW")).length, 1);
      assert.doesNotMatch(plan.steps.map((step) => step.payload.content).join("\n"), /<a href=/);
    }
  });

  test(`${jobId} plans add no CTA divider when destination CTA is empty`, () => {
    const document = {
      templateId: jobId,
      version: "market-content-v2",
      nodes: [{ type: "paragraph", text: "Verified update" }],
    };
    const [telegram] = automation.buildAutomationTelegramPlans(jobId, { document }, [
      { platform: "telegram", chatId: "-1001", threadId: 7, ctaEnabled: true, ctaContent: "" },
    ]);
    const [discord] = automation.buildAutomationDiscordPlans(jobId, { document }, [
      { platform: "discord", guildId: "g1", channelId: "c1", ctaEnabled: true, ctaContent: "" },
    ]);

    assert.equal(telegram.steps.length, 1);
    assert.equal(telegram.steps[0].payload.text, "Verified update");
    assert.equal(discord.steps.length, 1);
    assert.equal(discord.steps[0].payload.content, "Verified update");
  });
}

function marketDocumentWithParagraphs(lengths) {
  return {
    templateId: "crypto-daily",
    version: "market-content-v2",
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

test("verified market jobs deliver the community gateway document", () => {
  for (const jobId of ["weekly-calendar", "data-release-updates"]) {
    const generated = {
      document: { templateId: jobId, version: "market-content-v2", nodes: [{ type: "paragraph", text: "FULL ARTICLE" }] },
      communityDocument: { templateId: `${jobId}-community`, version: "market-editorial-v1", nodes: [{ type: "paragraph", text: "COMMUNITY GATEWAY" }] },
    };
    const [telegram] = automation.buildAutomationTelegramPlans(jobId, generated, [
      { platform: "telegram", chatId: "-1001", threadId: 7 },
    ]);
    const [discord] = automation.buildAutomationDiscordPlans(jobId, generated, [
      { platform: "discord", guildId: "g1", channelId: "c1" },
    ]);
    assert.match(telegram.steps[0].payload.text, /COMMUNITY GATEWAY/);
    assert.doesNotMatch(telegram.steps[0].payload.text, /FULL ARTICLE/);
    assert.match(discord.steps[0].payload.content, /COMMUNITY GATEWAY/);
    assert.doesNotMatch(discord.steps[0].payload.content, /FULL ARTICLE/);
  }
});

test("market delivery idempotency includes publication language platform and exact destination", () => {
  const key = automation.buildMarketDeliveryIdempotencyKey("weekly-calendar", {
    publication: { product: "weekly-calendar", slug: "2026-W34" }, language: "en",
  }, { platform: "telegram", chatId: "-1001", threadId: 77 });
  assert.equal(key, JSON.stringify(["market-delivery-v1", "weekly-calendar", "2026-W34", "en", "telegram", "-1001", "77"]));
});

function officialEvidence(value, {
  sourceId = "bls-cpi",
  sourceUrl = "https://www.bls.gov/news.release/cpi.nr0.htm",
  retrievedAt = "2026-08-19T12:31:00.000Z",
  publishedAt = "2026-08-19T12:30:00.000Z",
  authority = "official",
} = {}) {
  return {
    value,
    rawValue: String(value).replace("%", ""),
    unit: String(value).includes("%") ? "%" : null,
    status: "verified",
    authority,
    sourceId,
    sourceUrl,
    retrievedAt,
    publishedAt,
    comparisons: [],
  };
}

function verifiedWeeklyCalendarFixture() {
  const retrievedAt = "2026-08-19T08:00:00.000Z";
  const schedule = (value) => officialEvidence(value, {
    sourceId: "bls-calendar",
    sourceUrl: "https://www.bls.gov/schedule/news_release/cpi.htm",
    retrievedAt,
    publishedAt: "2026-08-19T07:00:00.000Z",
  });
  const event = (id, title, indicator, scheduledAt, impactScore) => ({
    id,
    title,
    indicator,
    country: "US",
    importance: 3,
    impactScore,
    scheduledAt,
    schedule: schedule(scheduledAt),
    values: {
      forecast: officialEvidence("2.8%", {
        sourceId: "consensus",
        sourceUrl: "https://consensus.example/calendar",
        retrievedAt,
        authority: "auxiliary",
      }),
      previous: officialEvidence("2.9%", { retrievedAt }),
    },
    source: {
      id: "bls-calendar",
      label: "BLS",
      kind: "official",
      url: "https://www.bls.gov/schedule/news_release/cpi.htm",
    },
    publishable: true,
  });
  const events = [
    event("cpi", "US CPI YoY", "cpi", "2026-08-19T12:30:00.000Z", 92),
    event("gdp", "US GDP", "gdp", "2026-08-20T12:30:00.000Z", 88),
    event("fomc", "FOMC Rate Decision", "fomc", "2026-08-21T18:00:00.000Z", 99),
  ];
  return {
    calendar: { source: schedule("official-calendar"), events },
    eligibility: { publishable: true, reason: null },
    events,
    sources: [{ id: "bls-calendar", status: "ok" }],
    sourceManifest: [
      { id: "bls-calendar", label: "BLS", type: "official", url: "https://www.bls.gov/schedule/news_release/cpi.htm", retrievedAt, status: "verified" },
      { id: "consensus", label: "Consensus", type: "auxiliary", url: "https://consensus.example/calendar", retrievedAt, status: "verified" },
    ],
    warnings: [],
  };
}

function crc32ForPublication(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function publicationPngChunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32ForPublication(Buffer.concat([typeBytes, data])), 8 + data.byteLength);
  return chunk;
}

function verifiedEditorialPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1200, 0);
  header.writeUInt32BE(675, 4);
  header[8] = 1;
  header[9] = 0;
  const pixels = Buffer.alloc((Math.ceil(1200 / 8) + 1) * 675);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    publicationPngChunk("IHDR", header),
    publicationPngChunk("IDAT", deflateSync(pixels)),
    publicationPngChunk("IEND"),
  ]);
}

function publicationResponse(body, { status = 200, contentType = "image/png", url = "" } = {}) {
  const response = new Response(body, { status, headers: { "content-type": contentType } });
  if (url) Object.defineProperty(response, "url", { value: url });
  return response;
}

function verifiedPublicationFetch(repository, calls = []) {
  const image = verifiedEditorialPng();
  return async (url) => {
    calls.push(url);
    if (url.includes("/api/media/editorial/")) return publicationResponse(image, { url });
    const publication = [...repository.writes].reverse()
      .find(([key]) => String(key).startsWith("market-editorial-v1:"))?.[1];
    return publicationResponse(`<article data-content-hash="${publication.contentHash}">verified</article>`, {
      contentType: "text/html; charset=utf-8",
      url,
    });
  };
}

function verifiedDataReleaseOptions(repository, actual = "2.7%") {
  return {
    fetchCalendar: async () => verifiedReleaseCalendar(),
    fetchOfficialActual: async () => officialEvidence(actual),
    publicationFetchImpl: verifiedPublicationFetch(repository),
    publicBaseUrl: "https://academy.example",
    allowedPublicOrigins: ["https://academy.example"],
  };
}

function verifiedReleaseEvent({
  id = "us-cpi-release",
  indicator = "cpi",
  title = "US CPI YoY",
  scheduledAt = "2026-08-19T12:30:00.000Z",
  ranking,
} = {}) {
  return {
    id,
    sourceId: id,
    title,
    indicator,
    jurisdiction: "US",
    country: "US",
    importance: 3,
    scheduledAt,
    scheduleSources: [officialEvidence(scheduledAt, {
      sourceId: "bls-calendar",
      sourceUrl: "https://www.bls.gov/schedule/news_release/",
      retrievedAt: "2026-08-19T12:00:00.000Z",
      publishedAt: "2026-08-19T11:00:00.000Z",
    })],
    forecastSources: [officialEvidence("2.8%", {
      sourceId: "consensus",
      sourceUrl: "https://consensus.example/calendar",
      authority: "auxiliary",
    })],
    previousSources: [officialEvidence("2.9%")],
    source: { id: "bls-calendar", label: "BLS", kind: "official", url: "https://www.bls.gov/schedule/news_release/" },
    ...(ranking ? { ranking } : {}),
  };
}

function verifiedReleaseCalendar(event = verifiedReleaseEvent()) {
  return {
    events: [event],
    sources: [{ id: "bls-calendar", status: "ok", url: "https://www.bls.gov/schedule/news_release/", checkedAt: "2026-08-19T12:31:00.000Z", lastSuccessAt: "2026-08-19T12:31:00.000Z" }],
    warnings: [],
  };
}

function verifiedReleaseReaction(warnings = []) {
  const marketSource = {
    source: "Market Data",
    sourceUrl: "https://market.example/cross-asset",
    observedAt: "2026-08-19T12:45:00.000Z",
  };
  return {
    window: { start: "2026-08-19T12:29:00.000Z", end: "2026-08-19T12:45:00.000Z" },
    prices: {
      BTC: {
        symbol: "BTC",
        beforePrice: 60000,
        beforePriceAt: "2026-08-19T12:29:00.000Z",
        price: 60300,
        changePercent: 0.5,
        source: "Binance",
        sourceUrl: "https://api.binance.com/api/v3/klines",
        observedAt: "2026-08-19T12:45:00.000Z",
      },
      DXY: {
        symbol: "DXY",
        beforePrice: 98.4,
        beforePriceAt: "2026-08-19T12:29:00.000Z",
        price: 98.2,
        changePercent: -0.2,
        ...marketSource,
      },
      US2Y: {
        symbol: "US2Y",
        beforePrice: 3.72,
        beforePriceAt: "2026-08-19T12:29:00.000Z",
        price: 3.69,
        changePercent: -0.81,
        ...marketSource,
      },
    },
    sources: [
      { id: "binance", label: "Binance", url: "https://api.binance.com/api/v3/klines", status: "ok", checkedAt: "2026-08-19T12:45:00.000Z", lastSuccessAt: "2026-08-19T12:45:00.000Z", freshnessSeconds: 0 },
      { id: "cross-asset", label: "Market Data", url: "https://market.example/cross-asset", status: "ok", checkedAt: "2026-08-19T12:45:00.000Z", lastSuccessAt: "2026-08-19T12:45:00.000Z", freshnessSeconds: 0 },
    ],
    warnings,
  };
}

test("weekly dry-run exposes a complete draft publication without persistence or delivery", async () => {
  const repository = automationRepository();
  let sends = 0;
  const result = await automation.runAutomationJob("weekly-calendar", {
    now: "2026-08-19T08:00:00.000Z",
    force: true,
    dryRun: true,
    repository,
    fetchCalendar: async () => verifiedWeeklyCalendarFixture(),
    publicBaseUrl: "https://academy.example",
    targets: [{ chatId: "-1001", threadId: 7 }],
    telegramSender: async () => { sends += 1; return { message_id: sends }; },
  });

  assert.equal(result.status, "success");
  assert.equal(result.preview.publication.status, "draft");
  assert.equal(result.preview.publication.product, "weekly-calendar");
  assert.equal(result.preview.articlePath, "/market-calendar/2026-W34");
  assert.equal(result.preview.imagePath, "/api/media/editorial/weekly-calendar/2026-W34");
  assert.equal(result.preview.articleUrl, "https://academy.example/market-calendar/2026-W34");
  assert.equal(result.preview.imageUrl, "https://academy.example/api/media/editorial/weekly-calendar/2026-W34");
  assert.equal(result.preview.article.priorityEvents.length, 3);
  assert.ok(result.preview.communityDocument.nodes.length > 0);
  assert.ok(result.preview.sourceManifest.length >= 2);
  assert.match(result.preview.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(repository.writes.length, 0);
  assert.equal(sends, 0);
});

test("weekly live delivery verifies the canonical page and editorial image before sending", async () => {
  const repository = automationRepository();
  const healthCalls = [];
  const payloads = [];
  const result = await automation.runAutomationJob("weekly-calendar", {
    now: "2026-08-19T08:00:00.000Z",
    force: true,
    dryRun: false,
    repository,
    fetchCalendar: async () => verifiedWeeklyCalendarFixture(),
    publicationFetchImpl: verifiedPublicationFetch(repository, healthCalls),
    publicBaseUrl: "https://academy.example",
    allowedPublicOrigins: ["https://academy.example"],
    targets: [{ chatId: "-1001", threadId: 7 }],
    telegramSender: async (_token, method, payload) => {
      payloads.push({ method, payload });
      return { message_id: payloads.length };
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.preview.publication.status, "verified");
  assert.deepEqual(result.preview.publication.health, { page: "ok", image: "ok", checkedAt: "2026-08-19T08:00:00.000Z" });
  assert.ok(repository.writes.some(([, value]) => value?.status === "draft"));
  assert.ok(repository.writes.some(([, value]) => value?.status === "rendered"));
  assert.ok(repository.writes.some(([, value]) => value?.status === "verified"));
  assert.ok(healthCalls.some((url) => url.endsWith(result.preview.articlePath)));
  assert.ok(healthCalls.some((url) => url.endsWith(result.preview.imagePath)));
  assert.equal(payloads[0].method, "sendPhoto");
  assert.equal(new URL(payloads[0].payload.photo).pathname, result.preview.imagePath);
  assert.equal(new URL(payloads[0].payload.photo).search, "");
});

test("weekly rerun in the same slot and destination is deduplicated after one verified delivery", async () => {
  const repository = automationRepository();
  let sends = 0;
  const options = {
    now: "2026-08-19T09:00:00.000Z",
    force: false,
    dryRun: false,
    stateKey: `task11-weekly-verified-dedup-${process.pid}`,
    repository,
    fetchCalendar: async () => verifiedWeeklyCalendarFixture(),
    publicationFetchImpl: verifiedPublicationFetch(repository),
    publicBaseUrl: "https://academy.example",
    allowedPublicOrigins: ["https://academy.example"],
    targets: [{ chatId: "-1001", threadId: 7711 }],
    telegramSender: async () => ({ message_id: ++sends }),
  };

  const first = await automation.runAutomationJob("weekly-calendar", options);
  const second = await automation.runAutomationJob("weekly-calendar", options);
  assert.equal(first.status, "success");
  assert.equal(second.status, "duplicate");
  assert.ok(sends > 0);
  assert.equal(sends, first.preview.deliveryPlans[0].steps.length);
});

test("weekly publication health failure is skipped before every external send", async () => {
  const repository = automationRepository();
  let sends = 0;
  const result = await automation.runAutomationJob("weekly-calendar", {
    now: "2026-08-19T08:00:00.000Z",
    force: true,
    dryRun: false,
    repository,
    fetchCalendar: async () => verifiedWeeklyCalendarFixture(),
    publicationFetchImpl: async () => new Response("unhealthy", { status: 503 }),
    publicBaseUrl: "https://academy.example",
    allowedPublicOrigins: ["https://academy.example"],
    targets: [{ platform: "discord", guildId: "g1", channelId: "c1" }],
    discordSender: async () => { sends += 1; return { id: "unexpected" }; },
  });

  assert.equal(result.status, "skipped");
  assert.match(result.preview.publicationError, /capture|HTTP 503|publication/i);
  assert.equal(sends, 0);
});

function verifiedWeeklyDeliveryOptions(repository, overrides = {}) {
  return {
    now: "2026-08-19T09:00:00.000Z",
    force: true,
    dryRun: false,
    repository,
    fetchCalendar: async () => verifiedWeeklyCalendarFixture(),
    publicationFetchImpl: verifiedPublicationFetch(repository),
    publicBaseUrl: "https://academy.example",
    allowedPublicOrigins: ["https://academy.example"],
    ...overrides,
  };
}

test("weekly durable identity sends a changed Telegram topic and Discord channel in the same slot", async () => {
  const repository = automationRepository();
  const telegramCalls = [];
  const discordCalls = [];
  const base = verifiedWeeklyDeliveryOptions(repository, {
    force: false,
    stateKey: `weekly-target-change-${process.pid}`,
    telegramSender: async (_token, method, payload) => {
      telegramCalls.push({ method, threadId: payload.message_thread_id });
      return { message_id: telegramCalls.length };
    },
    discordSender: async (channelId) => {
      discordCalls.push(channelId);
      return { id: `discord-${discordCalls.length}` };
    },
  });

  const first = await automation.runAutomationJob("weekly-calendar", {
    ...base,
    targets: [
      { chatId: "-1001", threadId: 91 },
      { platform: "discord", guildId: "g1", channelId: "c91" },
    ],
  });
  const changed = await automation.runAutomationJob("weekly-calendar", {
    ...base,
    targets: [
      { chatId: "-1001", threadId: 92 },
      { platform: "discord", guildId: "g1", channelId: "c92" },
    ],
  });

  assert.equal(first.status, "success");
  assert.equal(changed.status, "success");
  assert.ok(telegramCalls.some(({ threadId }) => threadId === 91));
  assert.ok(telegramCalls.some(({ threadId }) => threadId === 92));
  assert.ok(discordCalls.includes("c91"));
  assert.ok(discordCalls.includes("c92"));
});

test("weekly durable identity marks the same tuple and target duplicate even when forced", async () => {
  const repository = automationRepository();
  let sends = 0;
  const options = verifiedWeeklyDeliveryOptions(repository, {
    targets: [{ chatId: "-1001", threadId: 93 }],
    telegramSender: async () => ({ message_id: ++sends }),
  });

  const first = await automation.runAutomationJob("weekly-calendar", options);
  const sendsAfterFirst = sends;
  const duplicate = await automation.runAutomationJob("weekly-calendar", options);

  assert.equal(first.status, "success");
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.preview.deliveryPlans.length, 0);
  assert.equal(sends, sendsAfterFirst);
  const durableStore = await repository.getMeta("market-content:release-delivery:v1");
  const expectedIdentity = JSON.stringify([
    "market-delivery-v1",
    "weekly-calendar",
    "2026-W34",
    "en",
    "telegram",
    "-1001",
    "93",
  ]);
  assert.ok(durableStore.entries.some((entry) => (
    entry.deduplicationKey === expectedIdentity
      && entry.expectedTargetKeys.includes("telegram:-1001:93")
      && entry.targets["telegram:-1001:93"]?.status === "success"
  )));
});

test("concurrent weekly runs for one complete tuple perform one external delivery", async () => {
  const repository = automationRepository();
  let sends = 0;
  const options = verifiedWeeklyDeliveryOptions(repository, {
    targets: [{ chatId: "-1001", threadId: 94 }],
    telegramSender: async () => {
      sends += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return { message_id: sends };
    },
  });

  const results = await Promise.all([
    automation.runAutomationJob("weekly-calendar", options),
    automation.runAutomationJob("weekly-calendar", options),
  ]);
  const delivered = results.find(({ status }) => status === "success");

  assert.deepEqual(results.map(({ status }) => status).sort(), ["duplicate", "success"]);
  assert.equal(sends, delivered.preview.deliveryPlans[0].steps.length);
});

test("weekly partial restart skips a completed target and continues one never started", async () => {
  const baseRepository = automationRepository();
  let rejectSecondPreparation = true;
  const repository = {
    ...baseRepository,
    async setMeta(key, value) {
      const isSecondPreparation = key === "market-content:release-sent:v1"
        && value?.entries?.some((entry) => entry.targetKey.includes("telegram:-1001:96") && entry.status === "sending");
      if (isSecondPreparation && rejectSecondPreparation) {
        rejectSecondPreparation = false;
        throw new Error("durable marker temporarily unavailable");
      }
      return baseRepository.setMeta(key, value);
    },
  };
  const calls = new Map();
  const options = verifiedWeeklyDeliveryOptions(repository, {
    targets: [
      { chatId: "-1001", threadId: 95 },
      { chatId: "-1001", threadId: 96 },
    ],
    telegramSender: async (_token, _method, payload) => {
      const threadId = payload.message_thread_id;
      calls.set(threadId, (calls.get(threadId) ?? 0) + 1);
      return { message_id: [...calls.values()].reduce((sum, count) => sum + count, 0) };
    },
  });

  const first = await automation.runAutomationJob("weekly-calendar", options);
  const completedCalls = calls.get(95);
  assert.equal(first.status, "partial");
  assert.ok(completedCalls > 0);
  assert.equal(calls.get(96) ?? 0, 0);

  const restarted = await automation.runAutomationJob("weekly-calendar", options);
  assert.equal(restarted.status, "success");
  assert.equal(calls.get(95), completedCalls);
  assert.ok((calls.get(96) ?? 0) > 0);
});

test("weekly started delivery with an unknown result requires manual reconciliation without resend", async () => {
  const repository = automationRepository();
  let attempts = 0;
  const options = verifiedWeeklyDeliveryOptions(repository, {
    targets: [{ chatId: "-1001", threadId: 97 }],
    telegramSender: async () => {
      attempts += 1;
      throw new Error("connection closed after request write");
    },
  });

  const first = await automation.runAutomationJob("weekly-calendar", options);
  const attemptsAfterFirst = attempts;
  const restarted = await automation.runAutomationJob("weekly-calendar", options);

  assert.equal(first.status, "manual-reconciliation");
  assert.equal(first.preview.targetResults[0].manualReconciliationRequired, true);
  assert.equal(restarted.status, "manual-reconciliation");
  assert.equal(restarted.preview.deliveryPlans.length, 0);
  assert.equal(attempts, attemptsAfterFirst);
});

test("weekly durable receipt prevents a completed target repeating before slot state is available", async () => {
  const repository = automationRepository();
  let sends = 0;
  const base = verifiedWeeklyDeliveryOptions(repository, {
    force: false,
    targets: [{ chatId: "-1001", threadId: 98 }],
    telegramSender: async () => ({ message_id: ++sends }),
  });

  const first = await automation.runAutomationJob("weekly-calendar", {
    ...base,
    stateKey: `weekly-before-slot-a-${process.pid}`,
  });
  const sendsAfterFirst = sends;
  const restartedWithoutSlot = await automation.runAutomationJob("weekly-calendar", {
    ...base,
    stateKey: `weekly-before-slot-b-${process.pid}`,
  });

  assert.equal(first.status, "success");
  assert.equal(restartedWithoutSlot.status, "duplicate");
  assert.equal(sends, sendsAfterFirst);
});

test("weekly restart safely recovers an unclaimed pending receipt created before its send marker", async () => {
  const repository = automationRepository();
  const target = { chatId: "-1001", threadId: 981 };
  const generatedIdentity = {
    publication: { product: "weekly-calendar", slug: "2026-W34" },
    language: "en",
  };
  const deduplicationKey = automation.buildMarketDeliveryIdempotencyKey("weekly-calendar", generatedIdentity, target);
  const targetKey = "telegram:-1001:981";
  await prepareDataReleaseDelivery({ repository, deduplicationKey, targetKeys: [targetKey], now: "2026-08-19T08:58:00.000Z" });
  await markDataReleaseTargetPending({ repository, deduplicationKey, targetKey, now: "2026-08-19T08:59:00.000Z" });
  let sends = 0;

  const recovered = await automation.runAutomationJob("weekly-calendar", verifiedWeeklyDeliveryOptions(repository, {
    targets: [target],
    telegramSender: async () => ({ message_id: ++sends }),
  }));

  assert.equal(recovered.status, "success");
  assert.ok(sends > 0);
  assert.equal(recovered.preview.targetResults[0].manualReconciliationRequired, undefined);
  assert.equal(recovered.preview.deliveryReceipts[0].complete, true);
});

test("weekly legacy success migrates only its exact destinations and still sends a changed topic", async () => {
  const repository = automationRepository();
  const stateKey = `weekly-legacy-migration-${process.pid}`;
  const legacyTarget = { chatId: "-1001", threadId: 982 };
  const changedTarget = { chatId: "-1001", threadId: 983 };
  const storedState = await readJson("automation-state.json", {});
  await writeJson("automation-state.json", {
    ...storedState,
    [stateKey]: {
      slot: "2026-W34",
      at: "2026-08-18T00:30:00.000Z",
      status: "success",
      targets: [legacyTarget],
      targetResults: [{ target: legacyTarget, status: "success" }],
    },
  });
  const sentThreads = [];

  const upgraded = await automation.runAutomationJob("weekly-calendar", verifiedWeeklyDeliveryOptions(repository, {
    force: false,
    stateKey,
    targets: [legacyTarget, changedTarget],
    telegramSender: async (_token, _method, payload) => {
      sentThreads.push(payload.message_thread_id);
      return { message_id: sentThreads.length };
    },
  }));

  assert.equal(upgraded.status, "success");
  assert.deepEqual([...new Set(sentThreads)], [983]);
  assert.equal(upgraded.preview.targetResults.find(({ target }) => target.threadId === 982)?.receiptExisting, true);
  assert.ok(upgraded.preview.targetResults.some(({ target, status }) => target.threadId === 983 && status === "success"));
});

test("weekly legacy partial migrates explicitly successful targets and retries failed targets", async () => {
  const repository = automationRepository();
  const stateKey = `weekly-legacy-partial-migration-${process.pid}`;
  const successfulTarget = { chatId: "-1001", threadId: 985 };
  const failedTarget = { chatId: "-1001", threadId: 986 };
  const storedState = await readJson("automation-state.json", {});
  await writeJson("automation-state.json", {
    ...storedState,
    [stateKey]: {
      slot: "2026-W34",
      at: "2026-08-18T00:30:00.000Z",
      status: "partial",
      targets: [successfulTarget, failedTarget],
      targetResults: [
        { target: successfulTarget, status: "success" },
        { target: failedTarget, status: "failed" },
      ],
    },
  });
  const sentThreads = [];

  const upgraded = await automation.runAutomationJob("weekly-calendar", verifiedWeeklyDeliveryOptions(repository, {
    force: false,
    stateKey,
    targets: [successfulTarget, failedTarget],
    telegramSender: async (_token, _method, payload) => {
      sentThreads.push(payload.message_thread_id);
      return { message_id: sentThreads.length };
    },
  }));

  assert.equal(upgraded.status, "success");
  assert.deepEqual([...new Set(sentThreads)], [986]);
  assert.equal(upgraded.preview.targetResults.find(({ target }) => target.threadId === 985)?.receiptExisting, true);
  assert.ok(upgraded.preview.targetResults.some(({ target, status }) => target.threadId === 986 && status === "success"));
});

test("weekly canonicalizes duplicate Telegram and Discord destinations before planning and sending", async () => {
  const repository = automationRepository();
  const telegramCalls = [];
  const discordCalls = [];
  const duplicateTelegram = { chatId: "-1001", threadId: 984 };
  const duplicateDiscord = { platform: "discord", guildId: "g1", channelId: "c984" };

  const result = await automation.runAutomationJob("weekly-calendar", verifiedWeeklyDeliveryOptions(repository, {
    targets: [
      duplicateTelegram,
      { ...duplicateTelegram, platform: "telegram", group: "duplicate config" },
      duplicateDiscord,
      { ...duplicateDiscord, group: "duplicate config" },
    ],
    telegramSender: async (_token, method, payload) => {
      telegramCalls.push({ method, payload });
      return { message_id: telegramCalls.length };
    },
    discordSender: async (channelId, payload) => {
      discordCalls.push({ channelId, payload });
      return { id: `discord-${discordCalls.length}` };
    },
  }));

  assert.equal(result.status, "success");
  assert.equal(result.preview.deliveryPlans.length, 2);
  assert.equal(result.preview.targetResults.length, 2);
  assert.equal(telegramCalls.length, result.preview.deliveryPlans.find(({ target }) => target.chatId)?.steps.length);
  assert.equal(discordCalls.length, result.preview.deliveryPlans.find(({ target }) => target.channelId)?.steps.length);
});

test("partial release reaction remains publishable as Awaiting Confirmation and retains provider warnings", async () => {
  const scheduledAt = "2026-08-19T12:30:00.000Z";
  const checkedAt = "2026-08-19T12:31:00.000Z";
  const event = {
    id: "us-cpi-partial",
    sourceId: "us-cpi-partial",
    title: "US CPI YoY",
    indicator: "cpi",
    jurisdiction: "US",
    country: "US",
    importance: 3,
    scheduledAt,
    values: { actual: null, forecast: "2.8%", previous: "2.9%" },
    rawValues: { actual: null, forecast: "2.8", previous: "2.9", unit: "%" },
    source: { id: "tradingview-calendar", label: "TradingView", kind: "auxiliary", url: "https://www.tradingview.com/economic-calendar/" },
  };
  const providerWarning = "ETH and DXY providers unavailable";
  const result = await automation.buildContent("data-release-updates", new Date(checkedAt), {
    repository: automationRepository(),
    persist: false,
    fetchCalendar: async () => ({
      events: [event],
      sources: [{ id: "tradingview-calendar", status: "ok", url: "https://www.tradingview.com/economic-calendar/", checkedAt, lastSuccessAt: checkedAt }],
      warnings: [],
    }),
    fetchOfficialActual: async () => officialEvidence("2.7%"),
    fetchReaction: async () => ({
      window: { start: "2026-08-19T12:29:00.000Z", end: "2026-08-19T12:45:00.000Z" },
      prices: {
        BTC: {
          symbol: "BTC",
          beforePrice: 60000,
          beforePriceAt: "2026-08-19T12:29:00.000Z",
          price: 59880,
          changePercent: -0.2,
          source: "Binance",
          sourceUrl: "https://api.binance.com/api/v3/ticker/24hr",
          observedAt: "2026-08-19T12:45:00.000Z",
        },
      },
      sources: [{ id: "binance", url: "https://api.binance.com", status: "ok", checkedAt: "2026-08-19T12:45:00.000Z", lastSuccessAt: "2026-08-19T12:45:00.000Z", freshnessSeconds: 0 }],
      warnings: [providerWarning],
    }),
  });

  assert.equal(result.publishable, true);
  assert.equal(result.article.verdict, "Awaiting Confirmation");
  assert.ok(result.warnings.includes(providerWarning));
  assert.equal(result.eligibility.actual.authority, "official");
});

test("tier-one data release persists and verifies its article and asset before Telegram planning", async () => {
  const repository = automationRepository();
  const healthCalls = [];
  const payloads = [];
  const result = await automation.runAutomationJob("data-release-updates", {
    now: "2026-08-19T12:31:00.000Z",
    force: true,
    dryRun: false,
    repository,
    fetchCalendar: async () => verifiedReleaseCalendar(),
    fetchOfficialActual: async () => officialEvidence("2.7%"),
    fetchReaction: async () => verifiedReleaseReaction(),
    publicationFetchImpl: verifiedPublicationFetch(repository, healthCalls),
    publicBaseUrl: "https://academy.example",
    allowedPublicOrigins: ["https://academy.example"],
    targets: [{ chatId: "-1001", threadId: 81 }],
    telegramSender: async (_token, method, payload) => {
      payloads.push({ method, payload });
      return { message_id: payloads.length };
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.preview.publication.status, "verified");
  assert.equal(result.preview.publication.product, "data-update");
  assert.ok(result.preview.article);
  assert.match(result.preview.articlePath, /^\/data-updates\/us-cpi\/2026-08-19$/);
  assert.ok(healthCalls.some((url) => new URL(url).pathname === result.preview.articlePath));
  assert.ok(healthCalls.some((url) => new URL(url).pathname === result.preview.imagePath));
  assert.equal(payloads[0].method, "sendPhoto");
  assert.equal(new URL(payloads[0].payload.photo).pathname, result.preview.imagePath);
  assert.ok(result.preview.deliveryPlans[0].idempotencyKey.includes('"data-update"'));
  assert.deepEqual((await repository.getMeta("market-content:release-state:v1")).publishedKeys, [result.preview.deduplicationKey]);
});

test("secondary data release verifies only its card and emits no article link", async () => {
  const repository = automationRepository();
  const healthCalls = [];
  const payloads = [];
  const secondary = verifiedReleaseEvent({
    id: "us-cpi-secondary-release",
    indicator: "cpi",
    title: "US CPI YoY",
    ranking: { decision: "demoted", score: 48, reasons: ["Lower market-significance setup"] },
  });
  const result = await automation.runAutomationJob("data-release-updates", {
    now: "2026-08-19T12:31:00.000Z",
    force: true,
    dryRun: false,
    repository,
    fetchCalendar: async () => verifiedReleaseCalendar(secondary),
    fetchOfficialActual: async () => officialEvidence("2.7%"),
    fetchReaction: async () => verifiedReleaseReaction(),
    publicationFetchImpl: verifiedPublicationFetch(repository, healthCalls),
    publicBaseUrl: "https://academy.example",
    allowedPublicOrigins: ["https://academy.example"],
    targets: [{ chatId: "-1001", threadId: 82 }],
    telegramSender: async (_token, method, payload) => {
      payloads.push({ method, payload });
      return { message_id: payloads.length };
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.preview.event.tierDecision.tier, "secondary");
  assert.equal(result.preview.article, undefined);
  assert.equal(result.preview.articlePath, null);
  assert.equal(result.preview.articleUrl, null);
  assert.equal(result.preview.publication.status, "verified");
  assert.equal(result.preview.publication.article, null);
  assert.ok(healthCalls.every((url) => !new URL(url).pathname.startsWith("/data-updates/")));
  assert.equal(payloads[0].method, "sendPhoto");
  const communityText = payloads.filter(({ method }) => method === "sendMessage").map(({ payload }) => payload.text).join("\n");
  assert.doesNotMatch(communityText, /\/data-updates\/|read (?:the )?full/i);
  assert.match(communityText, /https:\/\/academy\.example\/academy/);
});

test("missing official actual blocks data publication persistence and every sender", async () => {
  const repository = automationRepository();
  let sends = 0;
  const result = await automation.runAutomationJob("data-release-updates", {
    now: "2026-08-19T12:31:00.000Z",
    force: true,
    dryRun: false,
    repository,
    fetchCalendar: async () => verifiedReleaseCalendar(),
    fetchOfficialActual: async () => null,
    fetchReaction: async () => verifiedReleaseReaction(),
    publicBaseUrl: "https://academy.example",
    targets: [{ chatId: "-1001", threadId: 83 }],
    telegramSender: async () => { sends += 1; return { message_id: sends }; },
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.preview.eligibility.reason, "official-actual-unavailable");
  assert.equal(repository.writes.some(([key]) => String(key).startsWith("market-editorial-v1:")), false);
  assert.equal(sends, 0);
});

test("data release restart finalizes a durable successful send without sending it twice", async () => {
  const base = automationRepository();
  let rejectTargetReceipt = true;
  const repository = {
    ...base,
    async setMeta(key, value) {
      const receipt = value?.entries?.[0]?.targets?.["telegram:-1001:84"];
      if (key === "market-content:release-delivery:v1" && receipt?.status === "success" && rejectTargetReceipt) {
        throw new Error("target receipt temporarily unavailable");
      }
      return base.setMeta(key, value);
    },
  };
  let sends = 0;
  const options = {
    force: true,
    dryRun: false,
    repository,
    fetchCalendar: async () => verifiedReleaseCalendar(),
    fetchOfficialActual: async () => officialEvidence("2.7%"),
    fetchReaction: async () => verifiedReleaseReaction(),
    publicationFetchImpl: verifiedPublicationFetch(repository),
    publicBaseUrl: "https://academy.example",
    allowedPublicOrigins: ["https://academy.example"],
    targets: [{ chatId: "-1001", threadId: 84 }],
    telegramSender: async () => ({ message_id: ++sends }),
  };

  const first = await automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:31:00.000Z" });
  const sendsAfterFirst = sends;
  rejectTargetReceipt = false;
  const restarted = await automation.runAutomationJob("data-release-updates", { ...options, now: "2026-08-19T12:32:00.000Z" });

  assert.equal(first.status, "queued");
  assert.equal(first.preview.targetResults[0].receiptFinalizationPending, true);
  assert.equal(restarted.status, "success");
  assert.equal(restarted.preview.deliveryPlans.length, 0);
  assert.equal(sends, sendsAfterFirst);
  assert.deepEqual((await repository.getMeta("market-content:release-state:v1")).publishedKeys, [restarted.preview.deduplicationKey]);
});

test("data release filtering narrows publication candidates without erasing the weekly calendar cache", async () => {
  const repository = automationRepository();
  const unsupported = verifiedReleaseEvent({
    id: "aaa-unsupported-release",
    indicator: "cpi",
    title: "AAA unsupported release",
  });
  const supported = verifiedReleaseEvent({
    id: "supported-release",
    indicator: "cpi",
    title: "Supported CPI release",
  });

  const result = await pollDataReleaseUpdates({
    now: "2026-08-19T12:31:00.000Z",
    repository,
    persist: true,
    eventFilter: (event) => event.id === "supported-release",
    fetchCalendar: async () => ({
      events: [unsupported, supported],
      sources: [{ id: "bls-calendar", status: "ok" }],
      warnings: [],
    }),
    fetchOfficialActual: async () => officialEvidence("2.7%"),
  });

  assert.equal(result.publishable, true);
  assert.equal(result.event.id, "supported-release");
  assert.deepEqual(
    (await repository.getMeta(WEEKLY_CALENDAR_META_KEY)).events.map(({ id }) => id),
    ["aaa-unsupported-release", "supported-release"],
  );
});
