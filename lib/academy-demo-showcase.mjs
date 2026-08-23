import { buildReleaseDeduplicationKey } from "./data-release-monitor.mjs";

const BLS_CPI_URL = "https://www.bls.gov/news.release/archives/cpi_07152025.htm";
const FED_JUNE_URL = "https://www.federalreserve.gov/newsevents/pressreleases/monetary20250618a.htm";
const SEC_BITCOIN_ETP_URL = "https://www.sec.gov/newsroom/speeches-statements/gensler-statement-spot-bitcoin-011023";
const COINBASE_CANDLES_URL = "https://api.exchange.coinbase.com/products/BTC-USD/candles?start=2025-07-15T12:30:00Z&end=2025-07-15T13:00:00Z&granularity=60";

function canonicalNow(value) {
  const parsed = new Date(value ?? Date.now());
  if (!Number.isFinite(parsed.getTime())) throw new TypeError("Demo showcase requires a valid timestamp.");
  return parsed.toISOString();
}

function source(id, label, url, observedAt, tier = "official") {
  return { id, label, title: label, url, observedAt, retrievedAt: observedAt, status: "verified", tier, type: tier };
}

/**
 * A deliberately historical, clearly labelled fixture for one-off Academy DEMO
 * presentation checks. It must only be used behind the distribution demo safety
 * policy; it is not a live market-data fallback.
 */
export function buildAcademyDemoShowcaseContent(jobId, { now } = {}) {
  const generatedAt = canonicalNow(now);
  const bls = source("bls-cpi-june-2025", "U.S. Bureau of Labor Statistics", BLS_CPI_URL, "2025-07-15T12:30:00.000Z");
  const fed = source("federal-reserve-june-2025", "Federal Reserve", FED_JUNE_URL, "2025-06-18T18:00:00.000Z");
  const sec = source("sec-spot-bitcoin-etp", "U.S. Securities and Exchange Commission", SEC_BITCOIN_ETP_URL, "2024-01-10T21:00:00.000Z");
  const coinbase = source("coinbase-btc-usd", "Coinbase Exchange BTC-USD candles", COINBASE_CANDLES_URL, "2025-07-15T13:00:00.000Z", "primary");

  if (jobId === "crypto-daily") {
    return {
      templateId: jobId,
      generatedAt,
      publishable: true,
      demoShowcase: true,
      deduplicationKey: "academy-demo-replay-daily-2025-07-15-format-v4",
      sourceManifest: [bls, fed, sec],
      sources: [bls, fed, sec],
      document: {
        title: "HISTORICAL REPLAY · Daily Market Brief — inflation, policy and crypto access",
        verdict: "Historical layout replay: inflation was still above target while policy remained restrictive; this is not a live trading signal.",
        invalidation: "Do not use this replay as a current-market view; any present-day decision requires fresh prices, policy and flow data.",
        selectedStories: [
          {
            id: "demo-cpi-june-2025",
            title: "U.S. CPI held at 2.7% YoY in June 2025",
            summary: "Headline CPI rose 0.3% month over month and 2.7% year over year; core CPI rose 0.2% and 2.9%.",
            rationale: "Inflation remained above the Federal Reserve's target, keeping rates and dollar sensitivity high for crypto risk assets.",
            whatToWatch: "Watch DXY and US2Y confirmation before treating the print as a durable liquidity signal.",
            impact: "Neutral",
            marketImpact: { score: 85 },
            horizon: "Intraday / 1–3D",
            confidence: "High",
            affectedAssets: ["BTC", "ETH", "DXY", "US2Y"],
            source: { id: bls.id, kind: "official" },
            url: bls.url,
            publishedAt: bls.observedAt,
          },
          {
            id: "demo-fed-june-2025",
            title: "Fed kept its target range at 4.25%–4.50%",
            summary: "On 18 June 2025, the Federal Reserve maintained the federal funds target range at 4.25%–4.50%.",
            rationale: "A restrictive policy setting limited the case for reading one softer data point as an immediate crypto liquidity pivot.",
            whatToWatch: "Watch rate-cut repricing, the dollar, and whether BTC holds gains beyond the first reaction window.",
            impact: "Neutral",
            marketImpact: { score: 80 },
            horizon: "1–4W",
            confidence: "High",
            affectedAssets: ["BTC", "Nasdaq", "DXY", "US2Y"],
            source: { id: fed.id, kind: "official" },
            url: fed.url,
            publishedAt: fed.observedAt,
          },
          {
            id: "demo-sec-bitcoin-etp",
            title: "Spot bitcoin ETP access remained a structural anchor",
            summary: "The SEC approved the listing and trading of a number of spot bitcoin ETP shares on 10 January 2024.",
            rationale: "Regulated access is a slower institutional market-structure driver, not proof of an immediate directional move.",
            whatToWatch: "Separate durable access and flow trends from short-lived headline reactions.",
            impact: "Supportive",
            marketImpact: { score: 65 },
            horizon: "1–12M",
            confidence: "High",
            affectedAssets: ["BTC", "Crypto ETPs"],
            source: { id: sec.id, kind: "official" },
            url: sec.url,
            publishedAt: sec.observedAt,
          },
        ],
        sections: [{
          nodes: [
            { type: "paragraph", text: "June 2025 U.S. CPI rose 0.3% month over month and 2.7% year over year; core CPI rose 0.2% and 2.9%." },
            { type: "paragraph", text: "On 18 June 2025, the Federal Reserve maintained the federal funds target range at 4.25%–4.50%." },
            { type: "paragraph", text: "The SEC approved the listing and trading of a number of spot bitcoin ETP shares on 10 January 2024." },
          ],
        }],
      },
    };
  }

  if (jobId === "weekly-calendar") {
    return {
      templateId: jobId,
      generatedAt,
      publishable: true,
      demoShowcase: true,
      // Version the immutable replay identity when the rendered editorial
      // contract changes. This permits one governed visual acceptance without
      // weakening durable duplicate protection for ordinary reruns.
      deduplicationKey: "academy-demo-replay-week-2025-07-14-format-v4",
      sourceManifest: [bls],
      sources: [bls],
      document: {
        title: "HISTORICAL REPLAY · Weekly Catalyst Calendar — 14–20 July 2025",
        weekStart: "2025-07-14",
        verdict: "Historical calendar replay: U.S. CPI was the week's primary scheduled macro catalyst in this acceptance sample.",
        invalidation: "This archived calendar is for layout validation only and must not be interpreted as a current event schedule.",
        days: [{
          date: "2025-07-15",
          events: [{
            id: "us-cpi-june-2025",
            title: "HISTORICAL REPLAY · U.S. CPI for June 2025 · 12:30 UTC",
            time: "12:30",
            whyItMatters: "The official release reported headline CPI at 2.7% year over year and core CPI at 2.9%.",
            scenarioMap: "Read the release together with rates, USD and risk-asset confirmation; one print alone does not establish a trend.",
          }],
        }],
      },
    };
  }

  if (jobId === "data-release-updates") {
    const event = {
      id: "demo-replay-us-cpi-june-2025-format-v4",
      title: "HISTORICAL REPLAY · U.S. CPI for June 2025",
      scheduledAt: "2025-07-15T12:30:00.000Z",
      releasedAt: "2025-07-15T12:30:00.000Z",
      values: { actual: "2.7% YoY", coreActual: "2.9% YoY" },
      provenance: {
        actual: {
          value: "2.7% YoY",
          sourceId: bls.id,
          sourceLabel: bls.label,
          sourceUrl: bls.url,
          retrievedAt: bls.retrievedAt,
          authority: "official",
        },
      },
    };
    return {
      templateId: jobId,
      generatedAt,
      publishable: true,
      demoShowcase: true,
      deduplicationKey: buildReleaseDeduplicationKey(event),
      sourceManifest: [bls, coinbase],
      sources: [bls, coinbase],
      event,
      document: {
        title: "HISTORICAL REPLAY · Data Flash — U.S. CPI at 2.7% YoY",
        verdict: "Historical release replay: the official print is verified; the immediate BTC move was small and does not prove causation.",
        invalidation: "This archived release and reaction window are not a current trading signal.",
        values: { actual: "2.7% YoY", coreActual: "2.9% YoY" },
        nodes: [
          { type: "metric", label: "Headline CPI", value: "2.7% YoY" },
          { type: "metric", label: "Core CPI", value: "2.9% YoY" },
          { type: "paragraph", text: "BLS reported headline CPI +0.3% month over month and core CPI +0.2% in June 2025." },
        ],
      },
      reaction: {
        window: { start: "2025-07-15T12:30:00.000Z", end: "2025-07-15T13:00:00.000Z" },
        prices: { "BTC-USD": { open: 117278.74, close: 117169.78, changePercent: -0.0929 } },
        sources: [{ ...coinbase, status: "ok", checkedAt: coinbase.observedAt }],
      },
    };
  }

  throw new Error(`Unsupported Academy demo showcase job: ${jobId}`);
}
