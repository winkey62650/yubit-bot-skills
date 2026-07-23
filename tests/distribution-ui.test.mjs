import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDistributionTopicMappings,
  buildDistributionSourceOptions,
  buildDistributionTargetOptions,
  buildBroadcastRouteSummary,
  buildPublisherStatusChecks,
  buildSocialSourceReadiness,
  bulkDeleteNotice,
  failedBulkDeleteIds,
  filterBroadcastTargetOptions,
  getContentTemplate,
  isRetiredTelegramGroup,
  normalizeDistributionGroupTopics,
  orderedDistributionTopics,
  reconcileRuleSelection,
  recommendedScheduleFor,
  distributionDestinationLabel
} from "../lib/distribution-ui.mjs";

test("publisher status checks expose identity, bridge, session, routing and latest delivery independently", () => {
  const checks = buildPublisherStatusChecks({
    username: "@Serenity_Crypto",
    operationalStatus: "online",
    credentialsReady: true,
    authorized: true,
    lastSeenAt: "2026-07-22T08:00:00.000Z",
    routingReady: true,
    approvedTargetIds: ["-1003710405969"],
    lastDeliveryStatus: "success",
    lastDeliveryAt: "2026-07-22T07:55:00.000Z"
  });

  assert.deepEqual(checks.map((check) => check.key), ["identity", "bridge", "session", "routing", "delivery"]);
  assert.equal(checks.every((check) => check.ok === true), true);
  assert.equal(checks.find((check) => check.key === "routing").status, "1 个目标");

  const offline = buildPublisherStatusChecks({
    username: "@SomeoneElse",
    operationalStatus: "offline",
    credentialsReady: false,
    authorized: false,
    routingReady: false,
    approvedTargetIds: [],
    lastDeliveryStatus: "failed",
    lastError: "Telegram session unavailable"
  });
  assert.equal(offline.find((check) => check.key === "identity").ok, false);
  assert.equal(offline.find((check) => check.key === "bridge").ok, false);
  assert.equal(offline.find((check) => check.key === "delivery").status, "失败");

  const separated = buildPublisherStatusChecks({
    username: "@Serenity_Crypto",
    operationalStatus: "offline",
    credentialsReady: true,
    authorized: true,
    bridgeActive: false,
    lastSeenAt: "2026-07-22T02:44:51.676Z",
    targetAuthorizationReady: true,
    routingReady: true,
    approvedTargetIds: ["-1003710405969"]
  });
  assert.equal(separated.find((check) => check.key === "session").ok, false);
  assert.equal(separated.find((check) => check.key === "routing").ok, true);

  const recoveredBridge = buildPublisherStatusChecks({
    username: "@Serenity_Crypto",
    operationalStatus: "online",
    credentialsReady: true,
    bridgeActive: true,
    lastSeenAt: "2026-07-22T04:48:23.270Z",
    targetAuthorizationReady: true,
    approvedTargetIds: ["-1003710405969"],
    lastDeliveryStatus: "failed",
    lastError: "Telegram Desktop window title was misread as the username"
  });
  assert.equal(recoveredBridge.find((check) => check.key === "bridge").ok, true);
  assert.equal(recoveredBridge.find((check) => check.key === "delivery").ok, false);
  assert.equal(recoveredBridge.find((check) => check.key === "delivery").status, "历史失败");
  assert.match(recoveredBridge.find((check) => check.key === "identity").detail, /窗口标题不作为用户名依据/);
});

test("broadcast target options exclude every topic from the selected source group", () => {
  const options = [
    { key: "demo:8", target: { chatId: "-1001", threadId: 8 } },
    { key: "demo:10", target: { chatId: "-1001", threadId: 10 } },
    { key: "crypto:8", target: { chatId: "-1002", threadId: 8 } }
  ];

  assert.deepEqual(
    filterBroadcastTargetOptions(options, { chatId: "-1001", threadId: 8 }).map((option) => option.key),
    ["crypto:8"]
  );
  assert.deepEqual(filterBroadcastTargetOptions(options, {}).map((option) => option.key), [
    "demo:8",
    "demo:10",
    "crypto:8"
  ]);
});

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
  assert.deepEqual(buildDistributionSourceOptions(groups).map((option) => option.source.topicName), expectedNames);
  assert.equal(JSON.stringify(buildDistributionSourceOptions(groups)).includes("整群"), false);
  assert.equal(JSON.stringify(buildDistributionTargetOptions(groups)).includes("General Chat"), false);
});

test("retired Telegram groups are excluded without hiding active or recoverable groups", () => {
  const retired = {
    chatId: "-1004309440933",
    title: "Fight Club",
    type: "supergroup",
    isForum: false,
    canUseTopics: false,
    topics: [],
    bots: [
      { name: "AdminBot", membership: "kicked" },
      { name: "SpeakerBot", membership: "not_found" },
      { name: "ForwardBot", membership: "kicked" }
    ]
  };
  const active = {
    chatId: "-1004378187866",
    title: "CryptoGuy Academy",
    type: "supergroup",
    isForum: true,
    canUseTopics: true,
    topics: [{ name: "3. Market Events", threadId: 8 }],
    bots: [
      { name: "AdminBot", membership: "member" },
      { name: "SpeakerBot", membership: "member" },
      { name: "ForwardBot", membership: "member" }
    ]
  };
  const recoverable = {
    chatId: "-1005000000000",
    title: "Saved Draft Group",
    type: "supergroup",
    topics: []
  };

  assert.equal(isRetiredTelegramGroup(retired), true);
  assert.equal(isRetiredTelegramGroup(active), false);
  assert.equal(isRetiredTelegramGroup(recoverable), false);
  assert.equal(buildDistributionTargetOptions([retired, active]).some((option) => option.target.chatId === retired.chatId), false);
  assert.equal(buildDistributionSourceOptions([retired, active]).some((option) => option.source.chatId === retired.chatId), false);
  assert.equal(buildDistributionTargetOptions([retired, active]).some((option) => option.target.chatId === active.chatId), true);
});

test("generic Demo Topic names are resolved to the managed editorial names", () => {
  const groups = [{
    chatId: "-1003710405969",
    title: "DEMO Academy",
    topics: [
      { name: "General Chat", threadId: 1 },
      { name: "Topic 12", threadId: 12 },
      { name: "Topic 18", threadId: 18 },
      { name: "Topic 8", threadId: 8 },
      { name: "Topic 6", threadId: 6 },
      { name: "Topic 16", threadId: 16 },
      { name: "Topic 14", threadId: 14 },
      { name: "Topic 10", threadId: 10 }
    ]
  }];
  const expectedNames = [
    "1. READ FIRST - DISCLAIMER",
    "2. CryptoGuy Trading Zone",
    "3. Market Events",
    "4. Market Analysis - Crypto/Stocks/TradFi",
    "5. Community Signal",
    "6. Smart Money Tracker",
    "7. YUBIT Updates"
  ];

  assert.deepEqual(buildDistributionTargetOptions(groups).map((option) => option.target.topicName), expectedNames);
  assert.deepEqual(buildDistributionSourceOptions(groups).map((option) => option.source.topicName), expectedNames);
  assert.deepEqual(
    buildDistributionTargetOptions(groups).map((option) => option.label),
    expectedNames.map((name) => `DEMO Academy / ${name}`)
  );
});

test("Demo template placeholders and discovered threads collapse into one truthful 1-7 topic list", () => {
  const topics = [
    { name: "7. YUBIT Updates" },
    { name: "6. Smart Money Tracker" },
    { name: "5. Community Signal" },
    { name: "4. Market Analysis - Crypto/Stocks/TradFi" },
    { name: "3. Market Events" },
    { name: "2. CryptoGuy Trading Zone" },
    { name: "1. READ FIRST - DISCLAIMER" },
    { name: "Topic 8", threadId: 8 },
    { name: "Topic 10", threadId: 10 },
    { name: "Topic 14", threadId: 14 },
    { name: "Topic 16", threadId: 16 },
    { name: "General Chat", threadId: 1 }
  ];
  const normalized = normalizeDistributionGroupTopics({
    chatId: "-1003710405969",
    title: "DEMO Academy",
    topics
  });

  assert.deepEqual(normalized.map((topic) => topic.name), [
    "1. READ FIRST - DISCLAIMER",
    "2. CryptoGuy Trading Zone",
    "3. Market Events",
    "4. Market Analysis - Crypto/Stocks/TradFi",
    "5. Community Signal",
    "6. Smart Money Tracker",
    "7. YUBIT Updates"
  ]);
  assert.equal(normalized.length, 7);
  assert.equal(normalized.filter((topic) => topic.threadId).length, 4);
  assert.equal(normalized.find((topic) => topic.name === "3. Market Events").threadId, 8);
});

test("saved groups reconcile exact topic names and thread IDs from active distribution rules", () => {
  const groups = [{
    chatId: "-1003710405969",
    title: "DEMO Academy",
    topics: [
      { name: "1. READ FIRST - DISCLAIMER" },
      { name: "2. CryptoGuy Trading Zone" },
      { name: "3. Market Events" },
      { name: "4. Market Analysis - Crypto/Stocks/TradFi" },
      { name: "5. Community Signal" },
      { name: "6. Smart Money Tracker" },
      { name: "7. YUBIT Updates" },
      { name: "Topic 8", threadId: 8 },
      { name: "Topic 10", threadId: 10 }
    ]
  }];
  const rules = [
    {
      source: {
        chatId: "-1003710405969",
        threadId: 8,
        topicName: "3. Market Events"
      },
      targets: [{
        chatId: "-1004378187866",
        threadId: 8,
        topicName: "3. Market Events"
      }]
    },
    {
      source: {
        chatId: "-1003710405969",
        threadId: 10,
        topicName: "4. Market Analysis - Crypto/Stocks/TradFi"
      }
    },
    {
      source: {
        chatId: "-1003710405969",
        threadId: 14,
        topicName: "5. Community Signal"
      }
    }
  ];

  const [mapped] = applyDistributionTopicMappings(groups, rules);
  const topics = normalizeDistributionGroupTopics(mapped);
  assert.equal(topics.length, 7);
  assert.equal(topics.some((topic) => /^Topic\s+\d+$/i.test(topic.name)), false);
  assert.equal(topics.find((topic) => topic.name === "3. Market Events").threadId, 8);
  assert.equal(topics.find((topic) => topic.name === "4. Market Analysis - Crypto/Stocks/TradFi").threadId, 10);
  assert.equal(topics.find((topic) => topic.name === "5. Community Signal").threadId, 14);
});

test("distribution rules restore complete 1-7 selectors for every configured group", () => {
  const groups = [
    {
      chatId: "-1003710405969",
      title: "DEMO Academy",
      topics: [
        { name: "1. READ FIRST - DISCLAIMER" },
        { name: "2. CryptoGuy Trading Zone" },
        { name: "3. Market Events" },
        { name: "4. Market Analysis - Crypto/Stocks/TradFi" },
        { name: "5. Community Signal" },
        { name: "6. Smart Money Tracker" },
        { name: "7. YUBIT Updates" }
      ]
    },
    {
      chatId: "-1004378187866",
      title: "CryptoGuy Academy",
      topics: [
        { name: "1. READ FIRST - DISCLAIMER" },
        { name: "2. CryptoGuy Trading Zone" },
        { name: "3. Market Events" },
        { name: "4. Market Analysis - Crypto/Stocks/TradFi" },
        { name: "5. Community Signal" },
        { name: "6. Smart Money Tracker" },
        { name: "7. YUBIT Updates" }
      ]
    }
  ];
  const topicNames = groups[0].topics.map((topic) => topic.name);
  const rules = topicNames.map((topicName, index) => ({
    source: {
      chatId: "-1003710405969",
      threadId: 6 + index * 2,
      topicName
    },
    targets: [{
      chatId: "-1004378187866",
      threadId: 11 + index * 2,
      topicName
    }]
  }));

  const mapped = applyDistributionTopicMappings(groups, rules);
  const sources = buildDistributionSourceOptions(mapped);
  const targets = buildDistributionTargetOptions(mapped);

  assert.equal(sources.filter((option) => option.source.chatId === "-1003710405969").length, 7);
  assert.equal(sources.filter((option) => option.source.chatId === "-1004378187866").length, 7);
  assert.equal(targets.filter((option) => option.target.chatId === "-1003710405969").length, 7);
  assert.equal(targets.filter((option) => option.target.chatId === "-1004378187866").length, 7);
  assert.deepEqual(
    targets.filter((option) => option.target.chatId === "-1004378187866").map((option) => option.target.topicName),
    topicNames
  );
});

test("saved rule destinations display the semantic Demo topic instead of a generic thread label", () => {
  assert.equal(distributionDestinationLabel({
    chatId: "-1003710405969",
    threadId: 10,
    topicName: "Topic 10"
  }), "4. Market Analysis - Crypto/Stocks/TradFi");
  assert.equal(distributionDestinationLabel({
    chatId: "-100999",
    threadId: 10,
    topicName: "Signals"
  }), "Signals");
  assert.equal(distributionDestinationLabel({ chatType: "channel" }), "整个频道");
});

test("private channels are selectable as whole destinations without a fake Topic", () => {
  const groups = [{
    chatId: "-1009001",
    title: "Private Distribution Test",
    type: "channel",
    isPrivateChannel: true,
    topics: []
  }];

  assert.deepEqual(buildDistributionTargetOptions(groups), [{
    key: "-1009001:channel",
    label: "Private Distribution Test / 整个频道",
    target: {
      chatId: "-1009001",
      chatType: "channel",
      threadId: null,
      groupName: "Private Distribution Test",
      topicName: "整个频道"
    }
  }]);
  assert.deepEqual(buildDistributionSourceOptions(groups), [{
    key: "-1009001:channel",
    label: "Private Distribution Test / 整个频道",
    source: {
      chatId: "-1009001",
      chatType: "channel",
      threadId: null,
      groupName: "Private Distribution Test",
      topicName: "整个频道"
    }
  }]);
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
    source: { chatId: "-1001", threadId: 7, groupName: "Demo", topicName: "News" },
    mode: "review",
    targets: [{ chatId: "-1002", threadId: 8 }]
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.targetCount, 1);
  assert.equal(ready.sourceLabel, "Demo / News");
  assert.match(ready.processingLabel, /待审核/);

  const missingSourceTopic = buildBroadcastRouteSummary({
    source: { chatId: "-1001", chatType: "supergroup", groupName: "Demo" },
    mode: "automatic",
    targets: [{ chatId: "-1002", threadId: 8 }]
  });
  assert.equal(missingSourceTopic.ready, false);
  assert.deepEqual(missingSourceTopic.missing, ["来源 Topic"]);

  const channelSource = buildBroadcastRouteSummary({
    source: { chatId: "-1009", chatType: "channel", groupName: "Official", topicName: "整个频道" },
    mode: "automatic",
    targets: [{ chatId: "-1002", threadId: 8 }]
  });
  assert.equal(channelSource.ready, true);
});

test("market events sample preserves the supplied July 7 briefing without imposing a fixed daily count", () => {
  const template = getContentTemplate("daily-events");
  const preview = template.preview;
  assert.equal(preview.templateVersion, "editorial-template-v1");
  assert.equal(preview.language, "English");
  assert.ok(preview.items.length > 0);
  assert.match(template.itemCountPolicy, /动态/);
  assert.match(preview.caption, /^🌅 MORNING MARKET BRIEF · JULY 7/);
  assert.match(preview.caption, /01 · US equities rebounded/);
  assert.match(preview.caption, /Market commentary only\.$/);
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
    assert.equal(preview.templateVersion, "editorial-template-v1");
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
  assert.match(preview.caption, /top-100 depth imbalance/);
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
