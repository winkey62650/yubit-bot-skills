import { orderTopicsByTemplate } from "./telegram-discovery.mjs";
import {
  EDITORIAL_TEMPLATE_VERSION,
  renderDailyAnalysisText,
  renderWhaleSignalText
} from "./editorial-template-contract.mjs";
import {
  buildCryptoDailyDocument,
  buildDataReleaseDocument,
  buildWeeklyCalendarDocument,
  renderTelegramMarketDocument
} from "./market-content-templates.mjs";

const DISTRIBUTION_TOPIC_ORDER = [
  { id: "1", name: "1. READ FIRST - DISCLAIMER" },
  { id: "2", name: "2. CryptoGuy Trading Zone" },
  { id: "3", name: "3. Market Events" },
  { id: "4", name: "4. Market Analysis - Crypto/Stocks/TradFi" },
  { id: "5", name: "5. Community Signal" },
  { id: "6", name: "6. Smart Money Tracker" },
  { id: "7", name: "7. YUBIT Updates" }
];

const neutralPreviews = {
  "daily-analysis": {
    templateVersion: EDITORIAL_TEMPLATE_VERSION,
    branding: "neutral",
    language: "English",
    headline: "DAILY MARKET ANALYSIS · {{DATE_UTC}}",
    caption: renderDailyAnalysisText({
      dateLabel: "[DATE]",
      regime: "[RISK ON / NEUTRAL / RISK OFF]",
      rows: ["BTC", "ETH", "SOL"].map((symbol) => ({
        symbol,
        price: "[PRICE]",
        change: "[24H CHANGE]",
        trend: "[TREND]"
      })),
      keyRead: "[2–3 sentence cross-asset interpretation]",
      levels: "[SUPPORT] / [RESISTANCE]",
      catalyst: "[NEXT EVENT]"
    }),
    items: [],
    sections: ["Market regime", "Crypto dashboard", "Cross-asset read", "Levels & catalysts"],
    disclaimer: "All prices and levels refresh at runtime. Verify the data before publishing.",
    imageUrl: "/api/media/card?kind=analysis&regime=RISK%20ON&levels=BTC%20%2460%2C000%20%C2%B7%20SMA20%20%2458%2C400&catalyst=24H%20MOMENTUM%20%C2%B7%20CROSS-ASSET%20FLOW"
  },
  "whale-signals": {
    templateVersion: EDITORIAL_TEMPLATE_VERSION,
    branding: "neutral",
    language: "English",
    headline: "WHALE ALERT · SMART MONEY SIGNAL",
    caption: renderWhaleSignalText({
      timestamp: "[PUBLICATION TIME]",
      pair: "[PAIR]",
      concentrationRead: "has printed an order-book move worth tracking",
      quantity: "[QUANTITY]",
      asset: "[ASSET]",
      notional: "[NOTIONAL]",
      action: "[LARGE BID ADDED / LARGE ASK ADDED / LARGE ORDER PULLED]",
      price: "[PRICE]",
      state: "[BUY-WALL SUPPORT / SELL-WALL PRESSURE]",
      imbalance: "[IMBALANCE]",
      directionRead: "If liquidity continues to build, short-term support or pressure may strengthen. If the order is quickly filled or removed, watch for a reversal in positioning.",
      watchNext: "[KEY LEVEL / WHETHER THE ORDER FILLS OR IS PULLED]"
    }),
    items: [],
    sections: ["Signal size", "Action and key level", "Order-book setup", "What to watch and risk note"],
    disclaimer: "An order-book snapshot does not mean a trade has been executed, and visible orders can be changed or cancelled at any time.",
    imageUrl: "/api/media/card?kind=whale&pair=BTC%20%2F%20USDT&signal=LARGE%20BID&amount=%241.20M&price=%2460%2C000&status=BUY%20WALL%20SUPPORT"
  }
};

const marketPreviewNow = new Date("2026-08-19T13:00:00.000Z");
const marketDocuments = {
  "crypto-daily": buildCryptoDailyDocument({ now: marketPreviewNow, candidates: [] }),
  "weekly-calendar": buildWeeklyCalendarDocument({
    now: marketPreviewNow,
    events: [{
      id: "us-cpi",
      title: "US CPI YoY",
      indicator: "cpi",
      country: "US",
      importance: 3,
      scheduledAt: "2026-08-19T12:30:00.000Z",
      values: { forecast: "2.8%", previous: "2.9%" },
      source: { label: "BLS", url: "https://www.bls.gov/cpi/" }
    }]
  }),
  "data-release-updates": buildDataReleaseDocument({
    event: {
      title: "US CPI",
      indicator: "cpi",
      observedAt: marketPreviewNow,
      values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" },
      source: { label: "BLS", url: "https://www.bls.gov/cpi/" }
    },
    reaction: { BTC: "+1.2%", ETH: "+1.5%", DXY: "-0.4%" }
  })
};

function marketTemplatePreview(templateId, sections) {
  const document = marketDocuments[templateId];
  return {
    templateVersion: document.version,
    branding: "neutral",
    language: "English",
    headline: document.title,
    caption: renderTelegramMarketDocument(document),
    items: [],
    sections,
    disclaimer: "Verify source freshness and publication status before publishing.",
    imageUrl: ""
  };
}

export const CONTENT_TEMPLATES = {
  "crypto-daily": {
    label: "每日 Crypto 新闻",
    jobId: "crypto-daily",
    format: "每日 3 条重点新闻",
    recommendedSchedule: "daily-0800-utc",
    scheduleLocked: true,
    destinationHint: "7. YUBIT Updates",
    description: "每日筛选机构、监管和市场/项目三类可追溯的重要 Crypto 新闻。",
    runtimeNote: "执行时读取最新来源、去重并评估市场影响。",
    preview: marketTemplatePreview("crypto-daily", ["BTC ETF / Institutional", "Regulation", "Market / Project"])
  },
  "weekly-calendar": {
    label: "每周数据日历",
    jobId: "weekly-calendar",
    format: "每周重点宏观 + Crypto 日历",
    recommendedSchedule: "weekly-monday-0030-utc",
    scheduleLocked: true,
    destinationHint: "3. Market Events",
    description: "每周一汇总已验证时间的重点宏观数据、央行事件与 Crypto 事件。",
    runtimeNote: "仅采用可追溯来源，并在冲突时保守省略不确定字段。",
    preview: marketTemplatePreview("weekly-calendar", ["Macro releases", "Central banks", "Crypto events"])
  },
  "data-release-updates": {
    label: "数据公布快讯",
    jobId: "data-release-updates",
    format: "Actual / Forecast / Previous 快讯",
    recommendedSchedule: "event-driven",
    scheduleLocked: true,
    destinationHint: "3. Market Events",
    description: "重点数据公布后同步实际值、预期值、前值和跨资产市场影响。",
    runtimeNote: "仅在监控事件达到公布窗口且数据可验证时发布。",
    preview: marketTemplatePreview("data-release-updates", ["Actual / Forecast / Previous", "Market impact", "Cross-asset reaction"])
  },
  "daily-analysis": {
    label: "Daily Analysis",
    jobId: "daily-analysis",
    format: "行情图文",
    recommendedSchedule: "daily-0800-utc",
    destinationHint: "4. Market Analysis - Crypto/Stocks/TradFi",
    description: "生成 Crypto、Stocks 与 TradFi 的每日市场快照。",
    runtimeNote: "模板结构可提前确认；价格、涨跌和趋势会在每日 08:00 UTC 执行时刷新。",
    preview: neutralPreviews["daily-analysis"]
  },
  "whale-signals": {
    label: "大户挂单 & 巨鲸数据",
    jobId: "whale-hourly",
    format: "英文异动图文",
    recommendedSchedule: "hourly",
    destinationHint: "6. Smart Money Tracker",
    description: "每小时检查真实订单簿，只有大额且买卖盘失衡达到阈值时，才生成英文海报与风险解读。",
    runtimeNote: "无实质异动时不发布；相同信号在冷却期内不会重复发送。",
    preview: neutralPreviews["whale-signals"]
  },
  "agent-sync": {
    label: "代理群信息更新",
    jobId: "agent-sync-4h",
    format: "有更新才发布",
    recommendedSchedule: "hourly",
    destinationHint: "2. CryptoGuy Trading Zone",
    description: "检查已配置代理来源，只在发现新内容时发布。",
    runtimeNote: "每小时检查一次；没有新内容时不会打扰群成员。"
  }
};

const fallbackTemplate = {
  label: "未识别内容",
  jobId: "",
  format: "待配置",
  recommendedSchedule: "daily-0800-utc",
  destinationHint: "请先选择目标 Topic",
  description: "请选择一个可用的内容模板。",
  runtimeNote: "保存前需要确认模板、频率和目标。"
};

export function getContentTemplate(contentType) {
  return CONTENT_TEMPLATES[contentType] || fallbackTemplate;
}

export function recommendedScheduleFor(contentType) {
  return getContentTemplate(contentType).recommendedSchedule;
}

export function resolveScheduleForContentType(contentType, requestedSchedule) {
  const template = getContentTemplate(contentType);
  if (template.scheduleLocked) return template.recommendedSchedule;
  return String(requestedSchedule || "").trim() || template.recommendedSchedule;
}

function previewCollectionCount(value) {
  if (Array.isArray(value)) return value.length;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

function formatMonitoredEvent(value) {
  if (!value || typeof value !== "object") return value || null;
  const title = String(value.title || value.name || value.indicator || "").trim();
  const scheduledAt = new Date(value.scheduledAt || value.releaseAt || value.observedAt || "");
  if (!Number.isFinite(scheduledAt.getTime())) return title || null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dateLabel = `${months[scheduledAt.getUTCMonth()]} ${scheduledAt.getUTCDate()}, ${String(scheduledAt.getUTCHours()).padStart(2, "0")}:${String(scheduledAt.getUTCMinutes()).padStart(2, "0")} UTC`;
  return title ? `${title} · ${dateLabel}` : dateLabel;
}

function normalizedPreviewSources(preview) {
  const diagnosticHealth = preview?.diagnostics?.sourceHealth;
  const sourceRows = [
    preview?.sources,
    preview?.sourceHealth?.sources,
    preview?.diagnostics?.sources,
    Array.isArray(diagnosticHealth) ? diagnosticHealth : diagnosticHealth?.sources,
    preview?.document?.sources
  ]
    .find((value) => Array.isArray(value)) || [];
  return sourceRows.map((source, index) => ({
    id: String(source?.id || source?.name || `source-${index + 1}`),
    label: String(source?.label || source?.name || source?.id || `来源 ${index + 1}`),
    status: source?.status || "unknown",
    lastSuccess: source?.lastSuccessAt || source?.lastSuccess || null,
    freshness: source?.freshnessSeconds == null
      ? source?.freshness || source?.freshnessStatus || null
      : `${source.freshnessSeconds} 秒`,
    fallback: source?.fallbackFrom || source?.fallback || source?.fallbackSource || null
  }));
}

function documentPreviewFacts(document) {
  if (!document || typeof document !== "object") return {};
  if (document.templateId === "crypto-daily" && Array.isArray(document.sections)) {
    const selectedCount = document.sections.filter((section) => Boolean(String(section?.storyId || "").trim())).length;
    return {
      selectedCount,
      missingCount: document.sections.length - selectedCount
    };
  }
  if (document.templateId === "weekly-calendar" && Array.isArray(document.days)) {
    const events = document.days.flatMap((day) => (
      Array.isArray(day?.events) ? day.events.map((event) => ({ day, event })) : []
    ));
    const monitored = events
      .map(({ day, event }) => ({
        title: event?.title,
        scheduledAt: /^\d{2}:\d{2}$/.test(String(event?.time || ""))
          ? `${day?.date}T${event.time}:00.000Z`
          : null
      }))
      .filter((event) => Number.isFinite(new Date(event.scheduledAt || "").getTime()))
      .sort((left, right) => new Date(left.scheduledAt) - new Date(right.scheduledAt))[0];
    return {
      candidateCount: events.length,
      selectedCount: events.length,
      missingCount: 0,
      nextMonitoredEvent: monitored || null
    };
  }
  return {};
}

export function buildMarketPreviewFacts(preview = {}) {
  const diagnostics = preview.diagnostics || preview.previewFacts || preview.document?.diagnostics || {};
  const documentFacts = documentPreviewFacts(preview.document);
  const read = (...keys) => keys.map((key) => preview[key] ?? diagnostics[key]).find((value) => value !== undefined);
  const valueOrDocument = (value, key) => value === undefined ? documentFacts[key] : value;
  return {
    candidateCount: previewCollectionCount(valueOrDocument(read("candidateCount", "candidates"), "candidateCount")),
    selectedCount: previewCollectionCount(valueOrDocument(read("selectedCount", "selected"), "selectedCount")),
    missingCount: previewCollectionCount(valueOrDocument(read("missingCount", "missing"), "missingCount")),
    conflictCount: previewCollectionCount(read("conflictCount", "conflicts")),
    nextMonitoredEvent: formatMonitoredEvent(valueOrDocument(read("nextMonitoredEvent", "nextEvent"), "nextMonitoredEvent")),
    sources: normalizedPreviewSources(preview)
  };
}

export function buildMarketPreviewText(preview = {}) {
  if (typeof preview?.telegramHtml === "string" && preview.telegramHtml.trim()) return preview.telegramHtml;
  if (preview?.document && typeof preview.document === "object") {
    try {
      return renderTelegramMarketDocument(preview.document);
    } catch {
      return "";
    }
  }
  if (typeof preview?.caption === "string" && preview.caption.trim()) return preview.caption;
  const telegramPlan = (Array.isArray(preview?.deliveryPlans) ? preview.deliveryPlans : [])
    .find((plan) => plan?.platform === "telegram");
  return (Array.isArray(telegramPlan?.steps) ? telegramPlan.steps : [])
    .map((step) => step?.payload?.text || step?.payload?.caption)
    .filter(Boolean)
    .join("\n\n");
}

export function reconcileRuleSelection(selected, rules) {
  const visibleIds = new Set(
    (Array.isArray(rules) ? rules : []).map((rule) => String(rule.id))
  );
  return [...new Set(
    (Array.isArray(selected) ? selected : []).map((id) => String(id))
  )].filter((id) => visibleIds.has(id));
}

export function failedBulkDeleteIds(result) {
  return (Array.isArray(result?.results) ? result.results : [])
    .filter((item) => !item.ok)
    .map((item) => String(item.id));
}

export function bulkDeleteNotice(result) {
  const deleted = Number(result?.deleted || 0);
  const failed = Number(result?.failed || 0);
  if (!failed) return `已删除 ${deleted} 条规则。`;

  const errors = [...new Set(
    (Array.isArray(result?.results) ? result.results : [])
      .filter((item) => !item.ok)
      .map((item) => item.error)
      .filter(Boolean)
  )];
  return `已删除 ${deleted} 条，${failed} 条失败${errors.length ? `：${errors.join("；")}` : ""}`;
}

export function buildBroadcastRouteSummary({ source, mode, targets } = {}) {
  const normalizedTargets = Array.isArray(targets) ? targets : [];
  const sourceChatReady = Boolean(source?.chatId);
  const sourceTopicReady = source?.chatType === "channel" || Number(source?.threadId) > 0;
  const sourceReady = sourceChatReady && sourceTopicReady;
  const targetsReady = normalizedTargets.length > 0;
  return {
    ready: sourceReady && targetsReady,
    sourceLabel: sourceReady
      ? `${source.groupName || source.chatId} / ${source.chatType === "channel" ? "整个频道" : source.topicName || `Topic ${source.threadId}`}`
      : "尚未选择来源",
    processingLabel: mode === "review" ? "先进入待审核，批准后发送" : "新消息自动实时转发",
    targetCount: normalizedTargets.length,
    missing: [
      !sourceChatReady ? "来源" : null,
      sourceChatReady && !sourceTopicReady ? "来源 Topic" : null,
      !targetsReady ? "至少一个目标" : null
    ].filter(Boolean)
  };
}

export function filterBroadcastTargetOptions(options = [], source = {}) {
  const sourceChatId = String(source?.chatId || "");
  return (Array.isArray(options) ? options : []).filter((option) => (
    !sourceChatId || String(option?.target?.chatId || "") !== sourceChatId
  ));
}

export function buildPublisherStatusChecks(publisher = {}) {
  const username = String(publisher.username || "").trim();
  const identityReady = username.toLowerCase() === "@serenity_crypto";
  const operationalStatus = publisher.operationalStatus || "offline";
  const bridgeStates = {
    online: { status: "在线", ok: true },
    publishing: { status: "正在发布", ok: true },
    stalled: { status: "任务卡住", ok: false },
    degraded: { status: "最近发布失败", ok: false },
    offline: { status: "离线", ok: false }
  };
  const bridge = bridgeStates[operationalStatus] || bridgeStates.offline;
  const bridgeActive = publisher.bridgeActive == null
    ? publisher.authorized === true
    : publisher.bridgeActive === true;
  const sessionReady = bridgeActive && Boolean(publisher.lastSeenAt || publisher.lastVerifiedAt);
  const approvedTargets = Array.isArray(publisher.approvedTargetIds) ? publisher.approvedTargetIds : [];
  const routingReady = publisher.targetAuthorizationReady == null
    ? publisher.routingReady !== false && approvedTargets.length > 0
    : publisher.targetAuthorizationReady === true;
  const deliveryStates = {
    success: { status: "成功", ok: true },
    failed: { status: "失败", ok: false },
    pending: { status: "等待发布", ok: true },
    sending: { status: "正在发布", ok: true }
  };
  const delivery = deliveryStates[publisher.lastDeliveryStatus] || { status: "暂无记录", ok: null };
  const bridgeRecovered = ["online", "publishing"].includes(operationalStatus)
    && publisher.lastDeliveryStatus === "failed";

  return [
    {
      key: "identity",
      label: "发布账号配置",
      status: identityReady ? "已匹配" : "不匹配",
      ok: identityReady,
      blocking: true,
      detail: username
        ? `预期账号：${username}；Telegram Desktop 窗口标题不作为用户名依据`
        : "未配置 Telegram 发布账号"
    },
    {
      key: "bridge",
      label: "本机发布桥",
      status: bridge.status,
      ok: bridge.ok,
      blocking: true,
      detail: bridge.ok
        ? "发布桥可领取并回写服务端任务"
        : publisher.operationalError || publisher.lastError || (publisher.credentialsReady === false ? "发布桥密钥未配置" : "未收到发布桥运行状态")
    },
    {
      key: "session",
      label: "Telegram 会话",
      status: sessionReady ? "已连接" : "未连接",
      ok: sessionReady,
      blocking: true,
      detail: publisher.lastSeenAt || publisher.lastVerifiedAt
        ? `最近心跳：${publisher.lastSeenAt || publisher.lastVerifiedAt}`
        : "未收到本机 Telegram 会话心跳"
    },
    {
      key: "routing",
      label: "目标白名单",
      status: `${approvedTargets.length} 个目标`,
      ok: routingReady,
      blocking: true,
      detail: routingReady ? approvedTargets.join("、") : "尚无可安全发布的目标群"
    },
    {
      key: "delivery",
      label: "最近一次投递记录",
      status: bridgeRecovered ? "历史失败" : delivery.status,
      ok: delivery.ok,
      blocking: false,
      detail: publisher.lastError && publisher.lastDeliveryStatus === "failed"
        ? publisher.lastError
        : publisher.lastDeliveryAt || "尚无投递记录"
    }
  ];
}

export function arePublisherBlockingChecksHealthy(checks = []) {
  const requiredChecks = (Array.isArray(checks) ? checks : []).filter((check) => check.blocking !== false);
  return requiredChecks.length > 0 && requiredChecks.every((check) => check.ok === true);
}

export function buildSocialSourceReadiness(packages) {
  const values = Array.isArray(packages) ? packages : [];
  const enabled = values.filter((item) => item.status === "已启用");
  const stable = enabled.filter((item) => {
    const value = `${item.platform || ""} ${item.accountUrl || ""}`.toLowerCase();
    return Boolean(item.feedUrl) || value.includes("youtube") || value.includes("x.com") || value.includes("twitter.com") || String(item.platform || "").toLowerCase() === "x";
  }).length;
  return {
    total: values.length,
    enabled: enabled.length,
    stable,
    limited: enabled.length - stable,
    ready: enabled.length > 0
  };
}

function isSendableSocialTarget(target) {
  const chatId = String(target?.chatId || "").trim();
  if (!chatId) return false;
  return target?.chatType === "channel" || Number(target?.threadId) > 0;
}

export function buildSocialSourceRouteReadiness(packages) {
  const values = Array.isArray(packages) ? packages : [];
  const enabledSources = values.filter((item) => item.status === "已启用");
  const mappedSources = enabledSources.filter((item) =>
    (Array.isArray(item.targets) ? item.targets : []).some(isSendableSocialTarget)
  );
  const mappedIds = new Set(mappedSources.map((item) => String(item.id)));
  const unmappedIds = enabledSources
    .filter((item) => !mappedIds.has(String(item.id)))
    .map((item) => String(item.id));

  return {
    enabled: enabledSources.length,
    mapped: mappedSources.length,
    unmappedIds,
    ready: enabledSources.length > 0 && unmappedIds.length === 0
  };
}

export function orderedDistributionTopics(topics = []) {
  return orderTopicsByTemplate(topics, DISTRIBUTION_TOPIC_ORDER);
}

const DEMO_ACADEMY_CHAT_ID = "-1003710405969";
const DEMO_TOPIC_NAMES_BY_THREAD = new Map([
  [6, "1. READ FIRST - DISCLAIMER"],
  [18, "2. CryptoGuy Trading Zone"],
  [8, "3. Market Events"],
  [10, "4. Market Analysis - Crypto/Stocks/TradFi"],
  [14, "5. Community Signal"],
  [16, "6. Smart Money Tracker"],
  [12, "7. YUBIT Updates"]
]);

export function resolveDistributionTopic(group, topic) {
  const threadId = Number(topic?.threadId || topic?.topicId);
  const currentName = String(topic?.name || topic?.title || "").trim();
  if (
    String(group?.chatId) === DEMO_ACADEMY_CHAT_ID
    && /^Topic\s+\d+$/i.test(currentName)
    && DEMO_TOPIC_NAMES_BY_THREAD.has(threadId)
  ) {
    return { ...topic, name: DEMO_TOPIC_NAMES_BY_THREAD.get(threadId) };
  }
  return topic;
}

function distributionTopicIdentity(topic) {
  const name = String(topic?.name || topic?.title || "").trim();
  const sequence = name.match(/^(\d+)\s*\./)?.[1];
  return sequence
    ? `sequence:${sequence}`
    : `name:${name.toLocaleLowerCase()}`;
}

export function normalizeDistributionGroupTopics(group = {}) {
  const normalized = new Map();

  for (const rawTopic of Array.isArray(group?.topics) ? group.topics : []) {
    const topic = resolveDistributionTopic(group, rawTopic);
    const name = String(topic?.name || topic?.title || "").trim();
    if (!name || /^General Chat$/i.test(name)) continue;

    const identity = distributionTopicIdentity(topic);
    const existing = normalized.get(identity);
    const hasThreadId = Number(topic?.threadId || topic?.topicId) > 0;
    const existingHasThreadId = Number(existing?.threadId || existing?.topicId) > 0;
    if (!existing || (!existingHasThreadId && hasThreadId)) {
      normalized.set(identity, {
        ...topic,
        name
      });
    }
  }

  return orderedDistributionTopics([...normalized.values()]);
}

export function applyDistributionTopicMappings(groups = [], rules = []) {
  const mappingsByChat = new Map();

  for (const rule of Array.isArray(rules) ? rules : []) {
    for (const location of [rule?.source, ...(Array.isArray(rule?.targets) ? rule.targets : [])]) {
      const chatId = String(location?.chatId || "").trim();
      const threadId = Number(location?.threadId);
      const name = String(location?.topicName || "").trim();
      if (!chatId || threadId <= 0 || !name) continue;

      const chatMappings = mappingsByChat.get(chatId) || new Map();
      const existing = chatMappings.get(threadId);
      const existingIsGeneric = /^Topic\s+\d+$/i.test(String(existing?.name || ""));
      const incomingIsGeneric = /^Topic\s+\d+$/i.test(name);
      if (!existing || (existingIsGeneric && !incomingIsGeneric)) {
        chatMappings.set(threadId, {
          name,
          threadId,
          topicId: threadId,
          verified: true,
          mappingSource: "distribution-rule"
        });
      }
      mappingsByChat.set(chatId, chatMappings);
    }
  }

  return (Array.isArray(groups) ? groups : []).map((group) => {
    const chatMappings = mappingsByChat.get(String(group?.chatId || ""));
    const liveTopicsByThread = new Map(
      (Array.isArray(group?.topics) ? group.topics : [])
        .filter((topic) => {
          const threadId = Number(topic?.threadId || topic?.topicId);
          const name = String(topic?.name || topic?.title || "").trim();
          const source = String(topic?.source || "").toLowerCase();
          return threadId > 0
            && topic?.verified === true
            && source.includes("telegram")
            && !/^Topic\s+\d+$/i.test(name);
        })
        .map((topic) => [Number(topic.threadId || topic.topicId), topic])
    );
    const managedDemoTopics = String(group?.chatId || "") === DEMO_ACADEMY_CHAT_ID
      ? [...DEMO_TOPIC_NAMES_BY_THREAD].map(([threadId, name]) => ({
          name,
          threadId,
          topicId: threadId,
          verified: true,
          mappingSource: "managed-demo-template"
        }))
      : [];
    if (!chatMappings?.size && !managedDemoTopics.length) return group;

    const mappedTopics = [
      ...managedDemoTopics,
      ...(chatMappings ? [...chatMappings.values()].map((mapping) => (
        liveTopicsByThread.get(Number(mapping.threadId)) || mapping
      )) : [])
    ];
    const mappedThreadIds = new Set(mappedTopics.map((topic) => Number(topic.threadId)));
    const mappedIdentities = new Set(mappedTopics.map(distributionTopicIdentity));
    const remainingTopics = (Array.isArray(group?.topics) ? group.topics : []).filter((topic) => {
      const threadId = Number(topic?.threadId || topic?.topicId);
      if (threadId > 0 && mappedThreadIds.has(threadId)) return false;
      return !mappedIdentities.has(distributionTopicIdentity(topic));
    });
    const topics = normalizeDistributionGroupTopics({
      ...group,
      topics: [...mappedTopics, ...remainingTopics]
    });
    return { ...group, topics };
  });
}

const RETIRED_TELEGRAM_MEMBERSHIPS = new Set([
  "chat_not_found",
  "kicked",
  "left",
  "not_found",
  "unknown"
]);

export function isRetiredTelegramGroup(group = {}) {
  if (group?.type === "channel") return false;
  if (group?.isForum === true || group?.canUseTopics === true) return false;
  if (normalizeDistributionGroupTopics(group).length > 0) return false;

  const bots = Array.isArray(group?.bots) ? group.bots : [];
  if (!bots.length) return false;

  return bots.every((bot) => RETIRED_TELEGRAM_MEMBERSHIPS.has(
    String(bot?.membership || "unknown").trim().toLowerCase()
  ));
}

export function distributionDestinationLabel(value = {}) {
  if (value?.platform === "discord") {
    const channelName = String(value?.topicName || value?.channelName || value?.channelId || "")
      .trim()
      .replace(/^#/, "");
    return channelName ? `#${channelName}` : "未选择 Channel";
  }
  if (value?.chatType === "channel") return "整个频道";
  const topic = resolveDistributionTopic(
    { chatId: value?.chatId },
    {
      threadId: value?.threadId,
      topicId: value?.threadId,
      name: value?.topicName || (value?.threadId ? `Topic ${value.threadId}` : "")
    }
  );
  return topic?.name || topic?.title || value?.threadId || "未选择 Topic";
}

export function buildDiscordDistributionTargetOptions(discordState = {}) {
  const discoveredGuildNames = new Map(
    (Array.isArray(discordState?.guilds) ? discordState.guilds : [])
      .map((guild) => [String(guild?.id || ""), String(guild?.name || "").trim()])
      .filter(([guildId]) => guildId)
  );
  const configuredGuilds = discordState?.config?.guilds && typeof discordState.config.guilds === "object"
    ? discordState.config.guilds
    : {};

  return Object.entries(configuredGuilds)
    .flatMap(([guildId, guild = {}]) => {
      const groupLabel = discoveredGuildNames.get(String(guildId))
        || String(guild?.name || guild?.guildName || guildId).trim();
      const channels = Array.isArray(guild?.channels)
        ? guild.channels
        : Object.values(guild?.channels || {});

      return channels
        .filter((channel) => String(channel?.channelId || channel?.id || "").trim())
        .map((channel) => {
          const channelId = String(channel?.channelId || channel?.id).trim();
          const channelName = String(channel?.name || channel?.channelName || channelId)
            .trim()
            .replace(/^#/, "");
          return {
            key: `discord:${guildId}:${channelId}`,
            label: `#${channelName}`,
            groupLabel,
            platform: "discord",
            target: {
              platform: "discord",
              guildId: String(guildId),
              channelId,
              groupName: groupLabel,
              topicName: channelName
            }
          };
        });
    })
    .sort((left, right) => `${left.groupLabel}/${left.label}`.localeCompare(`${right.groupLabel}/${right.label}`));
}

export function buildDiscordDestinationCtaOptions(discordState = {}) {
  const discoveredGuildNames = new Map(
    (Array.isArray(discordState?.guilds) ? discordState.guilds : [])
      .map((guild) => [String(guild?.id || ""), String(guild?.name || "").trim()])
      .filter(([guildId]) => guildId)
  );
  const configuredGuilds = discordState?.config?.guilds && typeof discordState.config.guilds === "object"
    ? discordState.config.guilds
    : {};

  return Object.entries(configuredGuilds)
    .filter(([guildId, guild = {}]) => {
      const channels = Array.isArray(guild?.channels) ? guild.channels : Object.values(guild?.channels || {});
      return String(guildId).trim() && channels.some((channel) => String(channel?.channelId || channel?.id || "").trim());
    })
    .map(([guildId, guild = {}]) => {
      const groupLabel = discoveredGuildNames.get(String(guildId))
        || String(guild?.name || guild?.guildName || guildId).trim();
      return {
        key: `discord:${guildId}`,
        label: "所有 Channels",
        groupLabel,
        platform: "discord",
        target: {
          platform: "discord",
          guildId: String(guildId),
          channelId: "",
          groupName: groupLabel,
          topicName: "所有 Channels",
        },
      };
    })
    .sort((left, right) => left.groupLabel.localeCompare(right.groupLabel));
}

export function buildTelegramDestinationCtaOptions(groups = []) {
  return (Array.isArray(groups) ? groups : [])
    .filter((group) => !isRetiredTelegramGroup(group))
    .filter((group) => String(group?.chatId || "").trim())
    .map((group) => {
      const chatId = String(group.chatId).trim();
      const groupName = group.title || group.name || chatId;
      const isChannel = group?.type === "channel";
      return {
        key: `telegram:${chatId}`,
        label: isChannel ? "整个频道" : "所有 Topics",
        groupLabel: groupName,
        platform: "telegram",
        target: {
          platform: "telegram",
          chatId,
          chatType: isChannel ? "channel" : "supergroup",
          threadId: null,
          groupName,
          topicName: isChannel ? "整个频道" : "所有 Topics",
        },
      };
    });
}

export function buildDistributionTargetOptions(groups = []) {
  return (Array.isArray(groups) ? groups : [])
    .filter((group) => !isRetiredTelegramGroup(group))
    .flatMap((group) => {
    const groupName = group.title || group.name || String(group.chatId);
    if (group?.type === "channel") {
      const target = {
        chatId: String(group.chatId),
        chatType: "channel",
        threadId: null,
        groupName,
        topicName: "整个频道"
      };
      return [{ key: `${target.chatId}:channel`, label: `${groupName} / 整个频道`, target }];
    }
    return normalizeDistributionGroupTopics(group)
      .filter((topic) => Number(topic.threadId || topic.topicId) > 0)
      .map((topic) => {
        const target = {
          chatId: String(group.chatId),
          threadId: Number(topic.threadId || topic.topicId),
          groupName: group.title || group.name || "",
          topicName: topic.name || topic.title || ""
        };
        return {
          key: `${target.chatId}:${target.threadId}`,
          label: `${target.groupName} / ${target.topicName}`,
          target
        };
      });
  });
}

export function buildDistributionSourceOptions(groups = []) {
  return (Array.isArray(groups) ? groups : [])
    .filter((group) => !isRetiredTelegramGroup(group))
    .flatMap((group) => {
    const groupName = group.title || group.name || String(group.chatId);
    if (group?.type === "channel") {
      return [{
        key: `${group.chatId}:channel`,
        label: `${groupName} / 整个频道`,
        source: {
          chatId: String(group.chatId),
          chatType: "channel",
          threadId: null,
          groupName,
          topicName: "整个频道"
        }
      }];
    }
    return normalizeDistributionGroupTopics(group)
      .filter((topic) => Number(topic.threadId || topic.topicId) > 0)
      .map((topic) => ({
        key: `${group.chatId}:${topic.threadId || topic.topicId}`,
        label: `${groupName} / ${topic.name || topic.title || topic.threadId || topic.topicId}`,
        source: {
          chatId: String(group.chatId),
          threadId: Number(topic.threadId || topic.topicId),
          groupName,
          topicName: topic.name || topic.title || ""
        }
      }));
  });
}
