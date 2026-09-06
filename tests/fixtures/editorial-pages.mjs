import { deflateSync } from "node:zlib";
const NOW = "2026-08-21T00:00:00.000Z";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.byteLength);
  return chunk;
}

export function png() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1200, 0);
  header.writeUInt32BE(675, 4);
  header[8] = 1;
  const pixels = Buffer.alloc((Math.ceil(1200 / 8) + 1) * 675);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND"),
  ]);
}

export function response(body, { contentType = "image/png", url = "" } = {}) {
  const value = new Response(body, { status: 200, headers: { "content-type": contentType } });
  if (url) Object.defineProperty(value, "url", { value: url });
  return value;
}

export function weeklyArticle(overrides = {}) {
  return {
    id: "weekly-calendar:2026-W34",
    type: "weekly-calendar-analysis",
    version: "market-editorial-v1",
    slug: "2026-W34",
    publishedAt: NOW,
    weekStart: "2026-08-17",
    weekEnd: "2026-08-23",
    kicker: "MARKET INTELLIGENCE / EDITORIAL RESEARCH",
    title: "Weekly Market Risk Playbook | 2026-W34",
    coreView: "Liquidity remains conditional on the week's highest-impact catalyst.",
    marketSetup: { label: "Observed market setup", summary: "Rates and DXY remain the confirmation layer.", observedAt: NOW },
    priorityEvents: [{
      id: "cpi",
      rank: 1,
      title: "US CPI",
      utcTime: "2026-08-19T12:30:00.000Z",
      jurisdiction: "US",
      impactScore: 96,
      whyItMatters: "Inflation reprices the rates path.",
      transmissionPath: "CPI → rates → DXY → crypto liquidity.",
      affectedAssets: ["BTC", "ETH", "DXY"],
      scenarioMap: "Confirm with rates and dollar follow-through.",
    }],
    impactRankedEvents: [{
      id: "cpi",
      rank: 1,
      title: "US CPI",
      utcTime: "2026-08-19T12:30:00.000Z",
      jurisdiction: "US",
      impactScore: 96,
      whyItMatters: "Inflation reprices the rates path.",
      transmissionPath: "CPI → rates → DXY → crypto liquidity.",
      affectedAssets: ["BTC", "ETH", "DXY"],
      scenarioMap: "Confirm with rates and dollar follow-through.",
      values: { forecast: "2.8%", previous: "2.7%" },
    }],
    tierOneAnalysis: [{ id: "cpi", headline: "US CPI", whyItMatters: "It reprices the rates path.", transmissionPath: "Inflation to yields to DXY to crypto.", affectedAssets: ["BTC", "ETH", "DXY"], scenarioMap: "Watch the first liquid-session follow-through." }],
    scenarios: [{ id: "base", label: "Base case", condition: "Data lands near consensus.", implication: "Keep conviction conditional." }],
    dailyWatchlist: [{ date: "2026-08-19", items: ["US CPI (12:30 UTC)"] }],
    sources: [{ label: "Official release", url: "https://example.com/cpi" }],
    limitations: ["Calendar times can change."],
    disclaimer: "For informational purposes only.",
    ...overrides,
  };
}

export function dataArticle(overrides = {}) {
  return {
    id: "data-update:us-cpi/2026-08-12",
    type: "data-update-analysis",
    version: "market-editorial-v1",
    slug: "us-cpi/2026-08-12",
    publishedAt: NOW,
    kicker: "MARKET INTELLIGENCE / EDITORIAL RESEARCH",
    title: "US CPI | Data Update",
    tierDecision: { tier: "tier-one" },
    verdict: "Confirmed",
    facts: { title: "US CPI", jurisdiction: "US", releasedAt: NOW, actual: "2.7%", forecast: "2.8%", previous: "2.9%", surprise: "-0.1pp", surpriseDirection: "Below forecast" },
    dataSignal: { label: "Editorial Inference", summary: "The inflation impulse cooled.", impact: "Bullish" },
    marketConfirmation: { label: "Observed Market Confirmation", summary: "BTC and ETH held the measured move.", observations: [{ symbol: "BTC", beforePrice: 70000, price: 71000, changePercent: 1.43, providerName: "Example", sourceUrl: "https://example.com/btc" }] },
    reactionWindow: { start: "2026-08-21T00:00:00.000Z", end: "2026-08-21T00:05:00.000Z", providers: ["Example"] },
    scenarioAnalysis: [{ id: "base", label: "Base case", condition: "The move remains bounded.", implication: "Wait for persistence." }],
    watchNext: ["Whether BTC holds the measured direction."],
    invalidation: "BTC reverses through its pre-release benchmark.",
    sources: [{ label: "Official release", url: "https://example.com/cpi" }],
    limitations: ["The observation does not establish causality."],
    disclaimer: "For informational purposes only.",
    ...overrides,
  };
}
