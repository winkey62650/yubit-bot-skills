const marketEventsJuly7 = [
  "US equities rebounded: the Nasdaq gained more than 1%, the Dow set another record, the chip index rose over 2% and AMD closed 6.6% higher. Bitcoin briefly rebounded more than 4%, while WTI fell back to its lowest level since before the US–Iran conflict.",
  "BONKDAO's treasury was reportedly hit by a malicious governance proposal, with roughly $20 million in BONK tokens stolen.",
  "Samsung Electronics posted exceptionally strong preliminary Q2 results, with operating profit up more than 1,800% year over year. Full results are scheduled for July 30.",
  "ANSEM reached a record market capitalization of about $449 million after Ansem announced completion of a new airdrop, bringing cumulative distributions to roughly $7 million.",
  "CZ said he neither holds nor knows the newly issued CZ, TCC or AB meme coins on BNB Chain, adding that he simply interacts with active community members.",
  "Trump again highlighted Dell and Micron and encouraged people to buy a Dell computer. Asked whether a Trump Account could include Bitcoin, he said it could possibly happen.",
  "A Nasdaq-100 fund rebalance is set to add SpaceX, potentially creating about $4.3 billion in passive buying. Attention now turns to the August 6 earnings update and the expiry of internal share lock-ups.",
  "Serenity reiterated a long-term bullish view on Swedish photonics company Sivers Semiconductors (SIVE), describing it as a potential next Lumentum.",
  "Solana's seven-day active addresses rose 38% to about 31.39 million, with $13.63 billion in volume. BNB Chain's 24-hour volume climbed roughly 45%, from $240 million to $350 million, amid meme-coin activity.",
  "Lighter rebounded more than 2.5x from recent lows as markets discussed permanent buyback-and-burn tokenomics, Robinhood Wallet integration, an $11 million LIT rewards pool and favorable commentary from Vitalik.",
  "Strategy filings reportedly show that the company sold 3,588 BTC last week at around $59,000, leaving approximately 843,000 BTC on its balance sheet."
];

const marketEventsJuly7Caption = [
  "🌅 MORNING MARKET BRIEF · JULY 7",
  "",
  "1. US equities rebounded as the Nasdaq gained more than 1%, the Dow set another record and semiconductor shares led. Bitcoin also recovered while WTI retreated.",
  "",
  "2. BONKDAO's treasury was reportedly hit by a malicious governance proposal, with roughly $20 million in BONK tokens stolen.",
  "",
  "3. Samsung Electronics reported exceptionally strong preliminary Q2 profit growth ahead of its full July 30 results.",
  "",
  "Market commentary only."
].join("\n");

const neutralPreviews = {
  "daily-events": {
    branding: "neutral",
    language: "English",
    headline: "MORNING MARKET BRIEF · JULY 7",
    caption: marketEventsJuly7Caption,
    items: marketEventsJuly7,
    sections: ["Macro & equities", "Crypto & memecoins", "Companies & passive flows", "On-chain & derivatives"],
    disclaimer: "Market commentary only. Please verify every figure and claim against primary sources before publishing.",
    imageUrl: "/api/media/card?kind=events&date=JULY%207&subline=EQUITIES%20REBOUND%20%C2%B7%20SEMIS%20LEAD%20%C2%B7%20CRYPTO%20FIRMS"
  },
  "daily-analysis": {
    branding: "neutral",
    language: "English",
    headline: "DAILY MARKET ANALYSIS · {{DATE_UTC}}",
    caption: "📊 DAILY MARKET ANALYSIS · {{DATE_UTC}}\n\nMarket regime: {{RISK_ON / NEUTRAL / RISK_OFF}}\n\nBTC · {{PRICE}} · {{24H_CHANGE}}\nETH · {{PRICE}} · {{24H_CHANGE}}\nSOL · {{PRICE}} · {{24H_CHANGE}}\n\nKey read: {{2–3 sentence cross-asset interpretation}}\nLevels to watch: {{SUPPORT}} / {{RESISTANCE}}\nCatalyst: {{NEXT_EVENT}}\n\nEducational market commentary only. Not investment advice.",
    items: [],
    sections: ["Market regime", "Crypto dashboard", "Cross-asset read", "Levels & catalysts"],
    disclaimer: "All prices and levels refresh at runtime. Verify the data before publishing.",
    imageUrl: "/api/media/card?kind=analysis&regime=RISK%20ON&levels=BTC%20%2460%2C000%20%C2%B7%20SMA20%20%2458%2C400&catalyst=24H%20MOMENTUM%20%C2%B7%20CROSS-ASSET%20FLOW"
  },
  "whale-signals": {
    branding: "neutral",
    language: "English",
    headline: "WHALE ALERT · SMART MONEY SIGNAL",
    caption: "🐋 WHALE ALERT · SMART MONEY SIGNAL\n\n[PAIR] has printed an order-book move worth tracking:\n\n▪️ Visible size: [QUANTITY] $[ASSET] · approx. [NOTIONAL]\n▪️ Key action: [LARGE BID ADDED / LARGE ASK ADDED / LARGE ORDER PULLED]\n▪️ Key level: [PRICE]\n▪️ Current read: [BUY-WALL SUPPORT / SELL-WALL PRESSURE]\n\nIf liquidity continues to build, short-term support or pressure may strengthen. If the order is quickly filled or removed, watch for a reversal in positioning.\n\nWhat to watch next: [KEY LEVEL / WHETHER THE ORDER FILLS OR IS PULLED].\n\n⚠️ An order-book snapshot does not mean a trade has been executed, and visible orders can be changed or cancelled at any time. Market information only; not investment advice.",
    items: [],
    sections: ["Signal size", "Action and key level", "Order-book setup", "What to watch and risk note"],
    disclaimer: "An order-book snapshot does not mean a trade has been executed, and visible orders can be changed or cancelled at any time.",
    imageUrl: "/api/media/card?kind=whale&pair=BTC%20%2F%20USDT&signal=LARGE%20BID&amount=%241.20M&price=%2460%2C000&status=BUY%20WALL%20SUPPORT"
  }
};

export const CONTENT_TEMPLATES = {
  news: {
    label: "Crypto News",
    jobId: "news-feed",
    format: "新闻图文",
    recommendedSchedule: "every-5-minutes",
    destinationHint: "YUBIT Updates",
    description: "抓取带来源链接的市场新闻，按链接与内容哈希去重。",
    runtimeNote: "标题、链接和配图会在每次执行时按最新数据生成。"
  },
  "daily-events": {
    label: "Daily Events",
    jobId: "daily-events",
    format: "市场简报图文",
    recommendedSchedule: "daily-0800-utc",
    itemCountPolicy: "按当天重要事件动态决定",
    destinationHint: "Market Events",
    description: "按当天重要性整理全球市场、加密资产与公司事件，生成动态日期海报和独立的英文 Market Events 简报。",
    runtimeNote: "先单独发送海报，再发送当天最重要的英文 Market Events 正文；实际内容每日刷新，条数按重要性动态决定。",
    preview: neutralPreviews["daily-events"]
  },
  "daily-analysis": {
    label: "Daily Analysis",
    jobId: "daily-analysis",
    format: "行情图文",
    recommendedSchedule: "daily-0800-utc",
    destinationHint: "Market Analysis",
    description: "生成 Crypto、Stocks 与 TradFi 的每日市场快照。",
    runtimeNote: "模板结构可提前确认；价格、涨跌和趋势会在每日 08:00 UTC 执行时刷新。",
    preview: neutralPreviews["daily-analysis"]
  },
  "whale-signals": {
    label: "大户挂单 & 巨鲸数据",
    jobId: "whale-hourly",
    format: "英文异动图文",
    recommendedSchedule: "hourly",
    destinationHint: "Smart Money Tracker",
    description: "每小时检查真实订单簿，只有大额且买卖盘失衡达到阈值时，才生成英文海报与风险解读。",
    runtimeNote: "无实质异动时不发布；相同信号在冷却期内不会重复发送。",
    preview: neutralPreviews["whale-signals"]
  },
  "agent-sync": {
    label: "代理群信息更新",
    jobId: "agent-sync-4h",
    format: "有更新才发布",
    recommendedSchedule: "every-4-hours",
    destinationHint: "Trading Zone",
    description: "检查已配置代理来源，只在发现新内容时发布。",
    runtimeNote: "每 4 小时检查一次；没有新内容时不会打扰群成员。"
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

export function buildBroadcastRouteSummary({ source, mode, targets } = {}) {
  const normalizedTargets = Array.isArray(targets) ? targets : [];
  const sourceReady = Boolean(source?.chatId);
  const targetsReady = normalizedTargets.length > 0;
  return {
    ready: sourceReady && targetsReady,
    sourceLabel: sourceReady
      ? `${source.groupName || source.chatId} / ${source.topicName || (source.threadId ? `Topic ${source.threadId}` : "整群")}`
      : "尚未选择来源",
    processingLabel: mode === "review" ? "先进入待审核，批准后发送" : "新消息自动实时转发",
    targetCount: normalizedTargets.length,
    missing: [!sourceReady ? "来源" : null, !targetsReady ? "至少一个目标" : null].filter(Boolean)
  };
}

export function buildSocialSourceReadiness(packages) {
  const values = Array.isArray(packages) ? packages : [];
  const enabled = values.filter((item) => item.status === "已启用");
  const stable = enabled.filter((item) => {
    const value = `${item.platform || ""} ${item.accountUrl || ""}`.toLowerCase();
    return Boolean(item.feedUrl) || value.includes("youtube");
  }).length;
  return {
    total: values.length,
    enabled: enabled.length,
    stable,
    limited: enabled.length - stable,
    ready: enabled.length > 0
  };
}
