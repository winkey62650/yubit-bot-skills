const cards = {
  news: {
    eyebrow: "LIVE · CONTENT DESK",
    title: "CRYPTO NEWS",
    subtitle: "Market headlines & ecosystem updates",
    accent: "#43d89b",
    note: "Source-linked · Verify before publishing",
    brandLabel: "MARKET INTELLIGENCE"
  },
  disclaimer: {
    eyebrow: "COMMUNITY SAFETY",
    title: "READ FIRST",
    subtitle: "COMMUNITY DISCLAIMER",
    accent: "#f4b53f",
    note: "Protect your account · Trade at your own risk",
    brandLabel: "COMMUNITY NOTICE"
  },
  events: {
    eyebrow: "GLOBAL MARKETS",
    title: "MORNING MARKET BRIEF",
    subtitle: "Global markets · Crypto · Companies",
    accent: "#46d4a1",
    note: "Market commentary · Verify before publishing",
    brandLabel: "MARKET INTELLIGENCE"
  },
  analysis: {
    eyebrow: "CROSS-ASSET SNAPSHOT",
    title: "MARKET ANALYSIS",
    subtitle: "Crypto · Stocks · TradFi",
    accent: "#55a7ff",
    note: "Data-led snapshot · Not investment advice",
    brandLabel: "MARKET INTELLIGENCE"
  },
  whale: {
    eyebrow: "VERIFIED MARKET DEPTH",
    title: "LIQUIDITY ALERT",
    subtitle: "VISIBLE ORDER-BOOK LEVEL",
    accent: "#35d9ff",
    note: "Visible orders may be cancelled · Not investment advice",
    brandLabel: "MARKET INTELLIGENCE"
  }
};

export function getMediaCardTemplate(kind) {
  return cards[kind] || cards.analysis;
}

const posterOperationsPattern = /(?:\b\d+\s+(?:key\s+events?|headlines?|stories?|items?|updates?|sources?)\b|\d+\s*条|\b\d{1,2}:\d{2}\s*(?:utc)?\b|\b(?:updates?\s+)?hourly\b|每\s*(?:1\s*)?小时)/i;

export function normalizePosterMetrics(metrics = []) {
  return metrics
    .map((metric) => String(metric || "").trim())
    .filter((metric) => metric && !posterOperationsPattern.test(metric));
}
