import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDistributionSourceOptions,
  buildDistributionTargetOptions,
  buildBroadcastRouteSummary,
  buildSocialSourceReadiness,
  bulkDeleteNotice,
  failedBulkDeleteIds,
  getContentTemplate,
  orderedDistributionTopics,
  reconcileRuleSelection,
  recommendedScheduleFor
} from "../lib/distribution-ui.mjs";

test("rule selection keeps only unique rules that still exist", () => {
  assert.deepEqual(
    reconcileRuleSelection(["rule-a", "missing", "rule-a"], [{ id: "rule-a" }, { id: "rule-b" }]),
    ["rule-a"]
  );
});

test("bulk deletion helpers retain failures and produce an actionable notice", () => {
  const partial = {
    deleted: 2,
    failed: 1,
    results: [
      { id: "rule-a", ok: true },
      { id: "rule-b", ok: false, error: "database timeout" },
      { id: "rule-c", ok: true }
    ]
  };
  assert.deepEqual(failedBulkDeleteIds(partial), ["rule-b"]);
  assert.equal(bulkDeleteNotice(partial), "已删除 2 条，1 条失败：database timeout");
  assert.equal(bulkDeleteNotice({ deleted: 3, failed: 0, results: [] }), "已删除 3 条规则。");
});

test("distribution selectors exclude General Chat and follow the managed editorial order", () => {
  const topics = [
    { name: "General Chat", threadId: 1 },
    { name: "7. YUBIT Updates", threadId: 12 },
    { name: "2. CryptoGuy Trading Zone", threadId: 18 },
    { name: "3. Market Events", threadId: 8 },
    { name: "1. READ FIRST - DISCLAIMER", threadId: 6 },
    { name: "6. Smart Money Tracker", threadId: 16 },
    { name: "5. Community Signal", threadId: 14 },
    { name: "4. Market Analysis - Crypto/Stocks/TradFi", threadId: 10 }
  ];
  const expectedNames = [
    "1. READ FIRST - DISCLAIMER",
    "2. CryptoGuy Trading Zone",
    "3. Market Events",
    "4. Market Analysis - Crypto/Stocks/TradFi",
    "5. Community Signal",
    "6. Smart Money Tracker",
    "7. YUBIT Updates"
  ];
  const groups = [{ chatId: "-1001", title: "DEMO Academy", topics }];

  assert.deepEqual(orderedDistributionTopics(topics).map((topic) => topic.name), expectedNames);
  assert.deepEqual(buildDistributionTargetOptions(groups).map((option) => option.target.topicName), expectedNames);
  assert.deepEqual(buildDistributionSourceOptions(groups).slice(1).map((option) => option.source.topicName), expectedNames);
  assert.equal(buildDistributionSourceOptions(groups)[0].source.topicName, "整群");
  assert.equal(JSON.stringify(buildDistributionTargetOptions(groups)).includes("General Chat"), false);
});

test("every SpeakerBot content type points to its semantic numbered Topic", () => {
  assert.deepEqual(Object.fromEntries([
    "news",
    "daily-events",
    "daily-analysis",
    "whale-signals",
    "agent-sync"
  ].map((contentType) => [contentType, getContentTemplate(contentType).destinationHint])), {
    news: "7. YUBIT Updates",
    "daily-events": "3. Market Events",
    "daily-analysis": "4. Market Analysis - Crypto/Stocks/TradFi",
    "whale-signals": "6. Smart Money Tracker",
    "agent-sync": "2. CryptoGuy Trading Zone"
  });
});

test("social source readiness distinguishes stable sources from limited X fallback", () => {
  assert.deepEqual(buildSocialSourceReadiness([]), {
    total: 0,
    enabled: 0,
    stable: 0,
    limited: 0,
    ready: false
  });
  assert.deepEqual(buildSocialSourceReadiness([
    { platform: "YouTube", accountUrl: "https://youtube.com/@demo", status: "已启用" },
    { platform: "X", accountUrl: "https://x.com/demo", status: "已启用" },
    { platform: "X", accountUrl: "https://x.com/paused", feedUrl: "https://example.com/x.xml", status: "已暂停" }
  ]), {
    total: 3,
    enabled: 2,
    stable: 1,
    limited: 1,
    ready: true
  });
});

test("each automatic content template recommends the production schedule and real job", () => {
  assert.equal(recommendedScheduleFor("daily-events"), "daily-0800-utc");
  assert.equal(recommendedScheduleFor("whale-signals"), "hourly");
  assert.equal(recommendedScheduleFor("agent-sync"), "every-4-hours");
  assert.equal(getContentTemplate("daily-analysis").jobId, "daily-analysis");
  assert.match(getContentTemplate("news").runtimeNote, /执行时/);
});

test("unknown content types return a safe incomplete template", () => {
  const template = getContentTemplate("missing-template");
  assert.equal(template.jobId, "");
  assert.equal(template.format, "待配置");
});

test("broadcast route is ready only after source and at least one target are set", () => {
  const incomplete = buildBroadcastRouteSummary({ source: {}, mode: "automatic", targets: [] });
  assert.equal(incomplete.ready, false);
  assert.deepEqual(incomplete.missing, ["来源", "至少一个目标"]);

  const ready = buildBroadcastRouteSummary({
    source: { chatId: "-1001", groupName: "Demo", topicName: "News" },
    mode: "review",
    targets: [{ chatId: "-1002", threadId: 8 }]
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.targetCount, 1);
  assert.equal(ready.sourceLabel, "Demo / News");
  assert.match(ready.processingLabel, /待审核/);
});

test("market events sample preserves the supplied July 7 briefing without imposing a fixed daily count", () => {
  const template = getContentTemplate("daily-events");
  const preview = template.preview;
  assert.equal(preview.language, "English");
  assert.ok(preview.items.length > 0);
  assert.match(template.itemCountPolicy, /动态/);
  assert.match(preview.caption, /^🌅 MORNING MARKET BRIEF · JULY 7/);
  assert.match(preview.caption, /1\. US equities rebounded/);
  assert.ok(preview.caption.length <= 1024);
  assert.doesNotMatch(preview.caption, /Executive read|full English brief follows|Story count|full 11-story/i);
  assert.match(preview.headline, /MORNING MARKET BRIEF/i);
  assert.match(preview.items.join(" "), /Nasdaq/i);
  assert.match(preview.items.join(" "), /BONKDAO/i);
  assert.match(preview.items.join(" "), /Samsung Electronics/i);
  assert.match(preview.items.join(" "), /ANSEM/i);
  assert.match(preview.items.join(" "), /SpaceX/i);
  assert.match(preview.items.join(" "), /Strategy/i);
  assert.match(preview.disclaimer, /verify/i);
  assert.match(template.runtimeNote, /先单独发送海报.*再发送.*英文/i);
  assert.doesNotMatch(template.runtimeNote, /合并成一条/);
});

test("events, analysis and whale templates are previewable before live data is requested", () => {
  for (const contentType of ["daily-events", "daily-analysis", "whale-signals"]) {
    const preview = getContentTemplate(contentType).preview;
    assert.equal(preview.branding, "neutral");
    assert.match(preview.imageUrl, /^\/(api\/media\/card\?kind=|templates\/)/);
    assert.ok(preview.caption.length > 80);
    assert.ok(preview.sections.length >= 3);
    assert.doesNotMatch(JSON.stringify(preview), /yubit/i);
  }
});

test("all three editorial samples use generated poster assets", () => {
  assert.match(getContentTemplate("daily-events").preview.imageUrl, /^\/api\/media\/card\?kind=events/);
  assert.match(getContentTemplate("daily-analysis").preview.imageUrl, /^\/api\/media\/card\?kind=analysis/);
  assert.match(getContentTemplate("whale-signals").preview.imageUrl, /^\/api\/media\/card\?kind=whale/);
});

test("whale preview exposes the approved poster and operating copy before publishing", () => {
  const template = getContentTemplate("whale-signals");
  const preview = template.preview;
  assert.equal(preview.language, "English");
  assert.match(preview.headline, /WHALE ALERT/);
  assert.match(preview.caption, /Visible size/);
  assert.match(preview.caption, /Key action/);
  assert.match(preview.caption, /Key level/);
  assert.match(preview.caption, /Current read/);
  assert.match(preview.caption, /What to watch next/);
  assert.doesNotMatch(preview.caption, /Data source|SOURCE URL/i);
  assert.doesNotMatch(preview.caption, /#\[ASSET\]|#\[VENUE\]|#WhaleAlert|#SmartMoney/i);
  assert.match(preview.caption, /not investment advice\.$/);
  assert.match(preview.disclaimer, /orders can be changed or cancelled/);
  assert.doesNotMatch(`${preview.headline}\n${preview.caption}`, /每小时|hourly|固定\s*\d+\s*条/i);
});

test("public editorial previews omit quotas, clock times and publishing frequency", () => {
  for (const contentType of ["daily-events", "daily-analysis", "whale-signals"]) {
    const preview = getContentTemplate(contentType).preview;
    const publicCopy = `${preview.headline}\n${preview.caption}`;
    assert.doesNotMatch(publicCopy, /\b11\s+(?:stories|items|events)\b|\{\{TIME_UTC\}\}|\d{1,2}:\d{2}\s*UTC|updates hourly|\bhourly\b/i);
  }
});
