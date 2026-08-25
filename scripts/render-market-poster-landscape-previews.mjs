import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import React from "react";
import { ImageResponse } from "next/og.js";

import { assertLandscapeMarketPosterFits, renderLandscapeMarketPoster } from "../lib/market-poster-landscape-renderer.mjs";
import { loadMarketPosterMaster } from "../lib/market-poster-artwork.mjs";
import { selectMarketPosterTemplate } from "../lib/market-poster-templates.mjs";

const outputDirectory = resolve(process.argv[2] || "work/poster-preview-current");
const footer = { sources: ["BLS", "SEC", "Coinbase Exchange"], updatedAt: "2026-08-24T03:16:33.000Z" };

const previews = [
  ["daily-market-brief", {
    visualTemplate: { id: "daily-market-brief-v4" }, date: "24 AUG 2026 · 03:16 UTC", primaryBias: "NEUTRAL", footer,
    summary: "BTC leads; broader confirmation still depends on volume and macro.",
    stories: [
      { rank: "01", title: "BTC ETF demand remains the structural anchor", score: 83, impact: "BULLISH", source: "SEC", affected: "BTC", thesis: "ETF demand stays constructive; spot volume must confirm." },
      { rank: "02", title: "Macro liquidity keeps the near-term read balanced", score: 71, impact: "NEUTRAL", source: "BLS", affected: "ETH", thesis: "Rates and USD direction remain the next confirmation layer." },
      { rank: "03", title: "Altcoin breadth remains selective", score: 64, impact: "NEUTRAL", source: "Coinbase", affected: "SOL", thesis: "Leadership remains selective rather than market-wide." },
    ],
  }],
  ["weekly-catalysts", {
    visualTemplate: { id: "weekly-catalysts-v5" }, weekStart: "2026-08-24", highImpactCount: 5, peakDay: "WED 26",
    footer: { sources: ["U.S. BEA / Census", "U.S. BLS", "Federal Reserve"], updatedAt: "2026-08-25T08:00:00.000Z" },
    columns: [
      { label: "MON 24", events: [
        { id: "fed-h10", title: "Federal Reserve H.10 Foreign Exchange Rates", posterTitle: "Fed H.10 FX Rates", time: "20:15 UTC", importance: 1, source: "Federal Reserve", lane: "primary", affected: "DXY · FX" },
        { id: "fed-h15", title: "Federal Reserve H.15 Selected Interest Rates", posterTitle: "Fed H.15 Selected Rates", time: "20:15 UTC", importance: 1, source: "Federal Reserve", lane: "secondary", affected: "U.S. 2Y · DXY" },
      ] },
      { label: "TUE 25", events: [
        { id: "new-home-sales", title: "U.S. New Home Sales", posterTitle: "U.S. New Home Sales", time: "14:00 UTC", importance: 3, source: "U.S. Census Bureau", lane: "primary", affected: "BTC · DXY · U.S. 2Y", sensitivity: "Housing demand informs the growth and rates read." },
        { id: "fed-h6", title: "Federal Reserve H.6 Money Stock Measures", posterTitle: "Fed H.6 Money Stock", time: "17:00 UTC", importance: 1, source: "Federal Reserve", lane: "secondary", affected: "DXY · LIQUIDITY" },
      ] },
      { label: "WED 26", events: [
        { id: "gdp-second", title: "U.S. GDP Second Estimate", posterTitle: "U.S. GDP Second Estimate", time: "12:30 UTC", importance: 5, source: "U.S. BEA", lane: "primary", isPriority: true, affected: "BTC · DXY · U.S. 2Y", sensitivity: "The growth revision can reset rates and risk pricing." },
        { id: "pce-july", title: "U.S. Personal Income & Outlays", posterTitle: "Personal Income & Outlays", time: "12:30 UTC", importance: 5, source: "U.S. BEA", lane: "secondary", affected: "BTC · ETH · DXY" },
        { id: "durable-goods", title: "U.S. Durable Goods Orders", posterTitle: "Durable Goods Orders", time: "12:30 UTC", importance: 3, source: "U.S. Census Bureau", lane: "secondary", affected: "DXY · U.S. 2Y" },
      ] },
      { label: "THU 27", events: [
        { id: "advance-indicators", title: "U.S. Advance Economic Indicators", posterTitle: "Advance Economic Indicators", time: "12:30 UTC", importance: 3, source: "U.S. Census Bureau", lane: "primary", affected: "DXY · U.S. 2Y" },
        { id: "steel-imports", title: "Preliminary U.S. Steel Imports", posterTitle: "Preliminary Steel Imports", time: "14:00 UTC", importance: 1, source: "U.S. Census Bureau", lane: "secondary", affected: "DXY" },
        { id: "employment-projections", title: "U.S. Employment Projections", posterTitle: "Employment Projections", time: "14:00 UTC", importance: 1, source: "U.S. BLS", lane: "secondary", affected: "U.S. 2Y" },
      ] },
      { label: "FRI 28", events: [
        { id: "county-wages", title: "County Employment & Wages", posterTitle: "County Employment & Wages", time: "14:00 UTC", importance: 2, source: "U.S. BLS", lane: "primary", affected: "U.S. 2Y" },
        { id: "ces-benchmark", title: "CES Preliminary Benchmark", posterTitle: "CES Preliminary Benchmark", time: "14:00 UTC", importance: 2, source: "U.S. BLS", lane: "secondary", affected: "U.S. 2Y · DXY" },
        { id: "fed-h8", title: "Federal Reserve H.8 Bank Balance Sheets", posterTitle: "Fed H.8 Bank Balance Sheets", time: "20:15 UTC", importance: 1, source: "Federal Reserve", lane: "secondary", affected: "LIQUIDITY · U.S. BANKS" },
      ] },
      { label: "SAT 29", events: [] },
      { label: "SUN 30", events: [] },
    ],
  }],
  ["data-flash", {
    visualTemplate: { id: "data-flash-v4" }, title: "U.S. CPI at 2.7% YoY", indicator: "U.S. CPI", releaseTime: "2026-08-24T12:30:00.000Z", actual: "2.7%", forecast: "2.8%", previous: "2.9%", surprise: "−0.1pp", impact: "NEUTRAL", source: "U.S. BLS", footer,
    reactions: [{ symbol: "BTC", label: "−0.09%", value: -0.09 }, { symbol: "DXY", label: "+0.12%", value: 0.12 }, { symbol: "U.S. 2Y", label: "+3bp", value: 3 }, { symbol: "NASDAQ", label: "−0.18%", value: -0.18 }],
    verdict: "The softer headline is constructive, but the first cross-asset move remains mixed.",
    confirmation: "BTC holds the post-release range while yields and USD move in a consistent direction.",
    invalidation: "The first reaction reverses through the pre-release benchmark.", affected: "BTC · ETH · U.S. yields · DXY",
  }],
  ["market-follow-up", {
    visualTemplate: { id: "market-follow-up-v4" }, title: "Measured response after the U.S. CPI release", actual: "2.7%", source: "Coinbase Exchange", impact: "NEUTRAL", tapeStatus: "DIVERGENT", footer,
    reactionWindow: { label: "12:30–13:00 UTC · 30 MIN" }, reactions: [{ symbol: "BTC", label: "−0.09%", value: -0.09 }, { symbol: "ETH", label: "+0.04%", value: 0.04 }, { symbol: "DXY", label: "+0.12%", value: 0.12 }, { symbol: "NASDAQ", label: "−0.18%", value: -0.18 }],
    volatility: "NORMAL", volume: "0.8×", breadth: "MIXED",
    verdict: "Crypto and macro assets diverged during the completed reaction window.",
    posterVerdict: "Mixed move in the completed window.",
    confirmation: "Direction persists beyond the initial window with rates, USD and spot volume aligned.",
    posterConfirmation: "Needs sustained cross-asset alignment.",
    invalidation: "BTC and ETH cross back through their pre-release benchmarks.",
    posterInvalidation: "BTC and ETH reclaim pre-release levels.",
  }],
];

await mkdir(outputDirectory, { recursive: true });
for (const [name, model] of previews) {
  const jobId = name === "daily-market-brief" ? "crypto-daily" : name === "weekly-catalysts" ? "weekly-calendar" : "data-release-updates";
  const reaction = name === "market-follow-up" ? { prices: { BTC: { changePercent: -0.09 } } } : undefined;
  model.visualTemplate = selectMarketPosterTemplate({ jobId, poster: model, reaction });
  if (!model.visualTemplate) throw new Error(`No approved locked template selected for ${name}.`);
  const master = await loadMarketPosterMaster(model).catch((error) => {
    throw new Error(`${name}: ${error.message}`, { cause: error });
  });
  assertLandscapeMarketPosterFits(model);
  const response = new ImageResponse(renderLandscapeMarketPoster(React.createElement, model, master), { width: 1200, height: 675 });
  await writeFile(resolve(outputDirectory, `${name}.png`), Buffer.from(await response.arrayBuffer()));
}

console.log(outputDirectory);
