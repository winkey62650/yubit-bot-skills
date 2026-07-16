import test from "node:test";
import assert from "node:assert/strict";
import * as automation from "../lib/automation-jobs.mjs";

const { AUTOMATION_JOBS, automationSlot } = automation;

test("all requested automation schedules are registered", () => {
  assert.deepEqual(AUTOMATION_JOBS.map((job) => job.id), ["news-feed", "daily-events", "daily-analysis", "whale-hourly", "agent-sync-4h"]);
  assert.equal(AUTOMATION_JOBS.find((job) => job.id === "news-feed").schedule, "最短每 5 分钟");
  assert.equal(AUTOMATION_JOBS.find((job) => job.id === "daily-events").schedule, "每日 08:00 UTC");
  assert.equal(AUTOMATION_JOBS.find((job) => job.id === "daily-analysis").schedule, "每日 08:00 UTC");
  assert.equal(AUTOMATION_JOBS.find((job) => job.id === "whale-hourly").schedule, "每小时检查，重大异动才发布");
  assert.equal(AUTOMATION_JOBS.find((job) => job.id === "agent-sync-4h").schedule, "每 4 小时");
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
  assert.match(brief.caption, /full English brief follows as a second Telegram message/i);
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

test("daily market brief delivery sends the poster and full copy to the same Topic", () => {
  assert.equal(typeof automation.buildDailyMarketBriefTelegramPlan, "function");
  const target = { chatId: "-1004378187866", threadId: 8 };
  const plan = automation.buildDailyMarketBriefTelegramPlan({
    caption: "<b>Morning brief</b>",
    fullText: "1. First story\n\n2. Second story"
  }, target, "https://example.com/poster.png");

  assert.deepEqual(plan.map((item) => item.method), ["sendPhoto", "sendMessage"]);
  assert.deepEqual(plan.map((item) => item.payload.chat_id), [target.chatId, target.chatId]);
  assert.deepEqual(plan.map((item) => item.payload.message_thread_id), [target.threadId, target.threadId]);
  assert.equal(plan[0].payload.photo, "https://example.com/poster.png");
  assert.match(plan[1].payload.text, /Second story/);
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

test("daily analysis Telegram copy matches the complete approved preview structure", () => {
  assert.equal(typeof automation.buildDailyAnalysisSnapshot, "function");
  const snapshot = automation.buildDailyAnalysisSnapshot([
    { symbol: "BTC", price: 65479, change: 2.51, sma20: 62357, trend: "Bullish", source: "Binance" },
    { symbol: "ETH", price: 3450, change: 1.25, sma20: 3310, trend: "Bullish", source: "Binance" },
    { symbol: "SOL", price: 168, change: -0.4, sma20: 162, trend: "Bullish", source: "Binance" }
  ], new Date("2026-07-15T08:00:00.000Z"));

  assert.equal(snapshot.poster.regime, "RISK ON");
  assert.match(snapshot.caption, /DAILY MARKET ANALYSIS · JULY 15/);
  assert.match(snapshot.caption, /Market regime:<\/b> RISK ON/);
  assert.match(snapshot.caption, /BTC.*\+2\.51%/s);
  assert.match(snapshot.caption, /Key read:<\/b>/);
  assert.match(snapshot.caption, /Levels to watch:<\/b>/);
  assert.match(snapshot.caption, /Catalyst:<\/b>/);
  assert.match(snapshot.caption, /Not investment advice/);
  assert.doesNotMatch(snapshot.caption, /YUBIT|08:00 UTC|updates hourly/i);
});
