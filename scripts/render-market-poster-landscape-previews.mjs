import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import React from "react";
import { ImageResponse } from "next/og.js";

import { renderLandscapeMarketPoster } from "../lib/market-poster-landscape-renderer.mjs";
import { loadMarketPosterMaster } from "../lib/market-poster-artwork.mjs";
import { selectMarketPosterTemplate } from "../lib/market-poster-templates.mjs";

const outputDirectory = resolve(process.argv[2] || "work/poster-preview-v4");
const footer = { sources: ["BLS", "SEC", "Coinbase Exchange"], updatedAt: "2026-08-24T03:16:33.000Z" };

const previews = [
  ["daily-market-brief", {
    visualTemplate: { id: "daily-market-brief-v4" }, date: "24 AUG 2026 · 03:16 UTC", primaryBias: "NEUTRAL", footer,
    stories: [
      { rank: "01", title: "BTC ETF demand remains the structural anchor", score: 83, impact: "BULLISH", source: "SEC", affected: "BTC", thesis: "Institutional demand remains constructive while confirmation from spot volume is still required." },
      { rank: "02", title: "Macro liquidity keeps the near-term read balanced", score: 71, impact: "NEUTRAL", source: "BLS", affected: "BTC ETH", thesis: "Rates and USD direction remain the next confirmation layer." },
      { rank: "03", title: "Altcoin breadth has not confirmed a broad risk-on move", score: 64, impact: "NEUTRAL", source: "Coinbase", affected: "ETH SOL", thesis: "Leadership remains selective rather than market-wide." },
    ],
  }],
  ["weekly-catalysts", {
    visualTemplate: { id: "weekly-catalysts-v4" }, weekStart: "2026-08-24", highImpactCount: 1, peakDay: "TUE 25", footer,
    columns: [
      { label: "MON 24", events: [] },
      { label: "TUE 25", events: [{ id: "cpi", title: "U.S. Consumer Price Index", time: "12:30", importance: 3, source: "U.S. BLS", isPriority: true, sensitivity: "Rates, USD and crypto risk appetite may reprice together. Watch the first 30-minute cross-asset confirmation window." }] },
      { label: "WED 26", events: [] }, { label: "THU 27", events: [] }, { label: "FRI 28", events: [] },
    ],
  }],
  ["data-flash", {
    visualTemplate: { id: "data-flash-v4" }, title: "U.S. CPI at 2.7% YoY", indicator: "U.S. CPI", actual: "2.7%", impact: "NEUTRAL", source: "U.S. BLS", footer,
    verdict: "The official print is verified. The initial crypto move is limited, so rates, USD and spot-volume confirmation matter more than the headline alone.",
    confirmation: "BTC holds the post-release range while yields and USD move in a consistent direction.",
    invalidation: "The first reaction reverses through the pre-release benchmark.", affected: "BTC · ETH · U.S. yields · DXY",
  }],
  ["market-follow-up", {
    visualTemplate: { id: "market-follow-up-v4" }, title: "Measured response after the U.S. CPI release", actual: "2.7%", source: "Coinbase Exchange", impact: "NEUTRAL", tapeStatus: "AWAITING CONFIRMATION", footer,
    reactionWindow: { label: "12:30–13:00 UTC · 30 MIN" }, reactions: [{ symbol: "BTC", label: "−0.09%", value: -0.09 }, { symbol: "ETH", label: "+0.04%", value: 0.04 }],
    verdict: "The measured move remains small and mixed. It is contextual evidence, not proof that the release caused a durable market repricing.",
    confirmation: "Direction persists beyond the initial window with rates, USD and spot volume aligned.",
    invalidation: "BTC and ETH cross back through their pre-release benchmarks.",
  }],
];

await mkdir(outputDirectory, { recursive: true });
for (const [name, model] of previews) {
  const jobId = name === "daily-market-brief" ? "crypto-daily" : name === "weekly-catalysts" ? "weekly-calendar" : "data-release-updates";
  const reaction = name === "market-follow-up" ? { prices: { BTC: { changePercent: -0.09 } } } : undefined;
  model.visualTemplate = selectMarketPosterTemplate({ jobId, poster: model, reaction });
  if (!model.visualTemplate) throw new Error(`No approved locked V4 template selected for ${name}.`);
  const master = await loadMarketPosterMaster(model).catch((error) => {
    throw new Error(`${name}: ${error.message}`, { cause: error });
  });
  const response = new ImageResponse(renderLandscapeMarketPoster(React.createElement, model, master), { width: 1200, height: 675 });
  await writeFile(resolve(outputDirectory, `${name}.png`), Buffer.from(await response.arrayBuffer()));
}

console.log(outputDirectory);
