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

const neutralPreviews = {
  "daily-events": {
    branding: "neutral",
    language: "English",
    headline: "MORNING MARKET BRIEF · JULY 7",
    caption: "🌅 MORNING MARKET BRIEF · JULY 7\n\nRisk appetite recovered as US equities and semiconductors rallied, Bitcoin rebounded and WTI retreated. Crypto attention centered on the BONKDAO exploit, ANSEM's record valuation, chain activity and Strategy's reported BTC sales.\n\nThe full English brief follows as a second Telegram message. Story count is selected by significance, not a fixed quota.",
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
    language: "中文",
    headline: "🐋 巨鲸动了，市场正在重新定价",
    caption: "🐋 巨鲸动了，市场正在重新定价\n\n[更新时间]，[交易对]出现一笔值得关注的大额挂单：\n\n▪️ 异动规模：[数量] 枚 $[币种]，约合 [金额]\n▪️ 关键动作：[买单挂入 / 卖单挂入 / 大额撤单]\n▪️ 关键位置：$[挂单价位]\n▪️ 当前状态：[买墙支撑 / 卖墙压力]约 [金额或说明]\n\n如果这笔资金继续增加挂单，短线压力或支撑可能增强；若大单被快速承接、成交或撤销，则要警惕方向反转。\n\n下一步重点观察：[关键价位 / 挂单是否成交或撤销]。\n\n⚠️ 订单簿快照不等于已完成买卖，挂单也可能随时撤销。以上内容仅为市场信息追踪，不构成投资建议。\n\n📍数据来源：[来源链接]\n\n#[币种] #[平台] #WhaleAlert #SmartMoney",
    items: [],
    sections: ["异动规模", "关键动作与位置", "订单簿状态", "观察重点与来源"],
    disclaimer: "订单簿快照不等于已完成买卖，挂单也可能随时撤销。",
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
    description: "按当天重要性整理全球市场、加密资产与公司事件，生成动态日期海报、摘要和完整英文简报。",
    runtimeNote: "首条发送当天海报与摘要，第二条发送完整英文简报；实际内容每日刷新，条数按重要性动态决定。",
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
    format: "日更信号图文",
    recommendedSchedule: "daily-0800-utc",
    destinationHint: "Smart Money Tracker",
    description: "读取真实订单簿，选出最值得关注的大额买卖挂单，生成海报与中文风险解读。",
    runtimeNote: "模板结构可提前确认；每日 08:00 UTC 刷新数据并生成新海报与文案。",
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
