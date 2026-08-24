import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import React from "react";
import { ImageResponse } from "next/og.js";

import { buildAcademyDemoShowcaseContent } from "../lib/academy-demo-showcase.mjs";
import {
  buildCryptoDailyPosterModel,
  buildDataUpdatePosterModel,
  buildWeeklyCalendarPosterModel,
} from "../lib/market-poster-models.mjs";
import {
  assertLandscapeMarketPosterFits,
  renderLandscapeMarketPoster,
} from "../lib/market-poster-landscape-renderer.mjs";
import { loadMarketPosterMaster } from "../lib/market-poster-artwork.mjs";
import { selectMarketPosterTemplate } from "../lib/market-poster-templates.mjs";

const outputDirectory = resolve(process.argv[2] || "work/academy-demo-showcase-previews");
const now = "2026-08-24T06:30:00.000Z";
const acceptanceBatchId = "local-visual-review";
const dailyReplay = buildAcademyDemoShowcaseContent("crypto-daily", { now, acceptanceBatchId });
const weeklyReplay = buildAcademyDemoShowcaseContent("weekly-calendar", { now, acceptanceBatchId });
const releaseReplay = buildAcademyDemoShowcaseContent("data-release-updates", { now, acceptanceBatchId });
const sourceById = (replay, sourceRef) => replay.sourceManifest.find(({ id }) => id === sourceRef?.id) ?? sourceRef;

const daily = buildCryptoDailyPosterModel({
  ...dailyReplay.document,
  generatedAt: dailyReplay.generatedAt,
  sources: dailyReplay.sourceManifest,
  selectedStories: dailyReplay.document.selectedStories.map((story) => ({
    ...story,
    source: sourceById(dailyReplay, story.source),
  })),
});
const weekly = buildWeeklyCalendarPosterModel({
  ...weeklyReplay.document,
  generatedAt: weeklyReplay.generatedAt,
  sources: weeklyReplay.sourceManifest,
  days: weeklyReplay.document.days.map((day) => ({
    ...day,
    events: day.events.map((event) => ({ ...event, source: sourceById(weeklyReplay, event.source) })),
  })),
});
const releaseInput = {
  ...releaseReplay.document,
  event: releaseReplay.event,
  source: releaseReplay.event.source,
  sources: releaseReplay.sourceManifest,
  updatedAt: releaseReplay.generatedAt,
};
const flash = buildDataUpdatePosterModel(releaseInput);
const followUp = buildDataUpdatePosterModel({
  ...releaseInput,
  reactions: [{ symbol: "BTC-USD", label: "-0.0929%", value: -0.0929 }],
  reactionWindow: releaseReplay.reaction.window,
  reactionSources: releaseReplay.reaction.sources.map(({ label }) => label),
});

const previews = [
  ["daily-market-brief", "crypto-daily", daily],
  ["weekly-catalysts", "weekly-calendar", weekly],
  ["data-flash", "data-release-updates", flash],
  ["market-follow-up", "data-release-updates", followUp, releaseReplay.reaction],
];

await mkdir(outputDirectory, { recursive: true });
for (const [name, jobId, poster, reaction] of previews) {
  poster.visualTemplate = selectMarketPosterTemplate({ jobId, poster, reaction });
  assertLandscapeMarketPosterFits(poster);
  const master = await loadMarketPosterMaster(poster);
  const response = new ImageResponse(renderLandscapeMarketPoster(React.createElement, poster, master), {
    width: 1200,
    height: 675,
  });
  await writeFile(resolve(outputDirectory, `${name}.png`), Buffer.from(await response.arrayBuffer()));
}

console.log(outputDirectory);
