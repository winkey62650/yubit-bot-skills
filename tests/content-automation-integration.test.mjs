import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildContentProductInputs,
  governAutomationContent,
} from "../lib/content-automation-adapter.mjs";
import { buildAcademyDemoShowcaseContent } from "../lib/academy-demo-showcase.mjs";
import {
  assertNoInternalUrlsInDeliveryPlans,
  buildAutomationDiscordPlans,
  buildAutomationTelegramPlans,
  runAutomationJob,
} from "../lib/automation-jobs.mjs";
import { buildReleaseDeduplicationKey } from "../lib/data-release-monitor.mjs";
import {
  buildCryptoDailyPosterModel,
  buildDataUpdatePosterModel,
  buildWeeklyCalendarPosterModel,
} from "../lib/market-poster-models.mjs";
import { selectMarketPosterTemplate } from "../lib/market-poster-templates.mjs";
import { landscapePosterOverflowFields } from "../lib/market-poster-landscape-renderer.mjs";
import { GET as renderMediaCard } from "../app/api/media/card/route.js";

const NOW = "2026-08-23T12:31:00.000Z";
const OFFICIAL = {
  id: "bls-cpi",
  label: "U.S. Bureau of Labor Statistics",
  type: "official",
  url: "https://www.bls.gov/news.release/cpi.htm",
  retrievedAt: NOW,
  status: "verified",
};

function generated(templateId, overrides = {}) {
  return {
    templateId,
    generatedAt: NOW,
    publishable: true,
    document: {
      title: "Market update",
      nodes: [
        { type: "metric", label: "Actual", value: "2.7%" },
        { type: "paragraph", text: "The verified release is now available." },
      ],
    },
    sourceManifest: [OFFICIAL],
    sources: [OFFICIAL],
    ...overrides,
  };
}

const DAILY_RSS = `<?xml version="1.0"?><rss><channel><item><guid>governed-daily</guid><title>Bitcoin ETF records net inflow</title><link>https://example.com/governed-daily</link><description>Institutional demand increased.</description><pubDate>Sun, 23 Aug 2026 11:00:00 GMT</pubDate></item></channel></rss>`;

test("public message gate blocks the application origin but ignores poster transport URLs", () => {
  const internalOrigin = "https://internal.example";
  assert.throws(() => assertNoInternalUrlsInDeliveryPlans([{
    steps: [{ payload: { text: "Read more at https://internal.example/academy" } }],
  }], internalOrigin), /PUBLIC_MESSAGE_INTERNAL_URL_BLOCKED/);
  assert.doesNotThrow(() => assertNoInternalUrlsInDeliveryPlans([{
    steps: [{ payload: { content: "Join https://community.example/invite", imageUrl: "https://internal.example/api/media/card" } }],
  }], internalOrigin));
});

function rssFetch() {
  return Promise.resolve(new Response(DAILY_RSS, {
    status: 200,
    headers: { "content-type": "application/rss+xml" },
  }));
}

test("maps the three automation jobs to exactly four governed content products", () => {
  const daily = buildContentProductInputs("crypto-daily", generated("crypto-daily"), { now: NOW, publicBaseUrl: "https://academy.example" });
  const weekly = buildContentProductInputs("weekly-calendar", generated("weekly-calendar", {
    document: { title: "Weekly catalysts", weekStart: "2026-08-17", days: [{ date: "2026-08-19", events: [{ id: "cpi", title: "US CPI", scheduledAt: "2026-08-19T12:30:00.000Z", values: { actual: { value: "2.7%" }, forecast: { rawValue: "2.8", unit: "%" }, previous: { value: "2.9%" } }, whyItMatters: "Rates may reprice.", scenarioMap: "Watch yields and DXY." }] }] },
  }), { now: NOW, publicBaseUrl: "https://academy.example" });
  const release = buildContentProductInputs("data-release-updates", generated("data-release-updates", {
    event: {
      id: "us-cpi-2026-08",
      indicator: "headline-cpi-yoy",
      title: "US CPI",
      releasedAt: NOW,
      values: { actual: "2.7%", forecast: "2.8%" },
      provenance: { actual: { value: "2.7%", sourceId: "bls-cpi", sourceUrl: OFFICIAL.url, retrievedAt: NOW, authority: "official" } },
    },
    document: { title: "US CPI released", verdict: "The first move remains unconfirmed.", invalidation: "Invalidate if price reverses.", values: { actual: "2.7%", forecast: "2.8%" }, nodes: [] },
    reaction: {
      window: { start: "2026-08-23T12:16:00.000Z", end: NOW },
      prices: { BTC: { changePercent: 0.5 } },
      sources: [{ id: "binance", title: "Binance", url: "https://api.binance.com", status: "ok", checkedAt: NOW, tier: "primary" }],
    },
  }), { now: NOW, publicBaseUrl: "https://academy.example" });

  assert.deepEqual(daily.map(({ product }) => product), ["daily-market-brief"]);
  assert.deepEqual(weekly.map(({ product }) => product), ["weekly-catalyst-calendar"]);
  assert.equal(weekly[0].intelligence.events[0].timeUtc, "2026-08-19 12:30 UTC");
  assert.equal(weekly[0].intelligence.events[0].actual, "2.7%");
  assert.equal(weekly[0].intelligence.events[0].forecast, "2.8%");
  assert.equal(weekly[0].intelligence.events[0].previous, "2.9%");
  assert.deepEqual(release.map(({ product }) => product), ["data-flash", "market-follow-up"]);
  assert.equal([daily, weekly, ...release].every((product) => !("cta" in product)), true);
  assert.equal(release[0].event.actual, "2.7%");
  assert.equal(release[0].intelligence.release.indicator, "headline-cpi-yoy");
  assert.equal(release[0].intelligence.release.releaseTime, NOW);
  assert.equal(release[0].facts.some((fact) => fact.actual === true), true);
  assert.equal(release[1].originatingDataFlashId, "data-flash-us-cpi-2026-08");
  const binanceSource = release[0].sources.find((source) => source.id.startsWith("binance-"));
  assert.ok(binanceSource);
  assert.deepEqual(release[1].facts[0].sourceRefs, [binanceSource.id]);
  assert.match(release[1].correlationStatement, /correlation, not causation/i);
});

test("keeps an initial reaction in Data Flash until the follow-up window is complete", () => {
  const products = buildContentProductInputs("data-release-updates", generated("data-release-updates", {
    event: {
      id: "us-cpi-initial-reaction",
      indicator: "headline-cpi-yoy",
      title: "US CPI",
      releasedAt: "2026-08-23T12:30:00.000Z",
      values: { actual: "2.7%", forecast: "2.8%", previous: "2.9%" },
    },
    reaction: {
      window: { start: "2026-08-23T12:29:00.000Z", end: NOW },
      prices: {
        BTC: { changePercent: 0.2 },
        DXY: { changePercent: -0.1 },
        US2Y: { changeBasisPoints: -1.2 },
      },
    },
  }), { now: NOW, publicBaseUrl: "https://academy.example" });

  assert.deepEqual(products.map(({ product }) => product), ["data-flash"]);
});

test("daily content maps each ranked story into decision fields and article-level evidence", () => {
  const [daily] = buildContentProductInputs("crypto-daily", generated("crypto-daily", {
    sourceManifest: [
      OFFICIAL,
      { id: "failed-feed", title: "Failed feed", url: "https://failed.example/feed", status: "error" },
    ],
    document: {
      title: "Daily brief",
      selectedStories: [{
        id: "stablecoin-cards",
        title: "Stablecoin card volume expands",
        summary: "Tracked payment volume passed $1 billion.",
        url: "https://news.example/stablecoin-cards",
        publishedAt: NOW,
        source: { id: "news-example", label: "News Example", kind: "secondary" },
        marketImpact: { score: 30 },
        impact: "Neutral",
        rationale: "Adoption is growing, while price direction remains unconfirmed.",
        affectedAssets: ["Stablecoins", "ETH"],
        horizon: "1–7D",
        confidence: "Medium",
        whatToWatch: "Watch settlement volume and merchant retention.",
      }],
    },
  }), { now: NOW, publicBaseUrl: "https://academy.example" });

  assert.equal(daily.intelligence.catalysts[0].happened, "Tracked payment volume passed $1 billion.");
  assert.equal(daily.intelligence.catalysts[0].horizon, "Current session");
  assert.equal(daily.intelligence.whyItMatters, "Adoption is growing, while price direction remains unconfirmed.");
  assert.deepEqual(daily.intelligence.affectedAssets, ["Stablecoins", "ETH"]);
  const articleSource = daily.sources.find((source) => source.url === "https://news.example/stablecoin-cards");
  assert.ok(articleSource);
  assert.deepEqual(daily.facts[0].sourceRefs, [articleSource.id]);
  assert.equal(daily.sources.some((source) => source.url === "https://failed.example/feed"), false);
});

test("daily community cards keep the evidence section to the top three ranked stories", () => {
  const stories = Array.from({ length: 4 }, (_, index) => ({
    id: `story-${index + 1}`,
    title: `Ranked story ${index + 1}`,
    summary: `Verified summary ${index + 1}.`,
    url: `https://news.example/story-${index + 1}`,
    publishedAt: NOW,
    source: { id: `source-${index + 1}`, kind: "secondary" },
    marketImpact: { score: 80 - index },
    impact: "Neutral",
  }));
  const [daily] = buildContentProductInputs("crypto-daily", generated("crypto-daily", {
    document: { title: "Daily brief", selectedStories: stories },
  }), { now: NOW, publicBaseUrl: "https://academy.example" });

  assert.equal(daily.intelligence.catalysts.length, 3);
  assert.equal(daily.facts.length, 3);
  assert.deepEqual(daily.intelligence.catalysts.map(({ headline }) => headline), stories.slice(0, 3).map(({ title }) => title));
});

const DEMO_ACCEPTANCE_BATCH_ID = "acceptance-32702768575";

test("the Academy demo showcase is an explicit historical replay that yields all four governed products", () => {
  const jobs = ["crypto-daily", "weekly-calendar", "data-release-updates"];
  const products = jobs.flatMap((jobId) => buildContentProductInputs(
    jobId,
    buildAcademyDemoShowcaseContent(jobId, { now: NOW, acceptanceBatchId: DEMO_ACCEPTANCE_BATCH_ID }),
    { now: NOW, publicBaseUrl: "https://academy.example" },
  ));

  assert.deepEqual(products.map(({ product }) => product), [
    "daily-market-brief",
    "weekly-catalyst-calendar",
    "data-flash",
    "market-follow-up",
  ]);
  assert.equal(products.every(({ title }) => /HISTORICAL REPLAY/i.test(title)), true);
  assert.equal(products.every(({ intelligence }) => intelligence.previewLabel === "DEMO PREVIEW · FORMAT TEST"), true);
  assert.equal(products.every(({ sources }) => sources.every(({ url }) => url.startsWith("https://"))), true);
  const dataFlash = products.find(({ product }) => product === "data-flash");
  assert.equal(dataFlash?.event.actual, "2.7%");
  assert.equal(dataFlash?.intelligence.release.forecast, "2.6%");
  assert.equal(dataFlash?.intelligence.release.previous, "2.4%");
  assert.equal(dataFlash?.intelligence.release.surprise, "2.7% vs 2.6%");
  assert.deepEqual(dataFlash?.intelligence.release.initialReaction, [
    "BTC-USD +0.40%",
    "ETH-USD +0.79%",
    "SOL-USD +0.89%",
    "XRP-USD +1.07%",
  ]);
  assert.match(products.find(({ product }) => product === "market-follow-up")?.correlationStatement || "", /correlation, not causation/i);
});

test("the exact four-product Academy demo fits every fixed V4 poster slot without compaction", () => {
  const dailyReplay = buildAcademyDemoShowcaseContent("crypto-daily", { now: NOW, acceptanceBatchId: DEMO_ACCEPTANCE_BATCH_ID });
  const weeklyReplay = buildAcademyDemoShowcaseContent("weekly-calendar", { now: NOW, acceptanceBatchId: DEMO_ACCEPTANCE_BATCH_ID });
  const releaseReplay = buildAcademyDemoShowcaseContent("data-release-updates", { now: NOW, acceptanceBatchId: DEMO_ACCEPTANCE_BATCH_ID });
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
  const flash = buildDataUpdatePosterModel({
    ...releaseInput,
    reactions: Object.entries(releaseReplay.initialReaction.prices).map(([symbol, value]) => ({
      symbol,
      label: `${value.changePercent >= 0 ? "+" : ""}${value.changePercent.toFixed(2)}%`,
      value: value.changePercent,
    })),
  });
  const followUp = buildDataUpdatePosterModel({
    ...releaseInput,
    source: releaseReplay.reaction.sources[0],
    tapeStatus: "CONFIRMED",
    reactions: Object.entries(releaseReplay.reaction.prices).map(([symbol, value]) => ({
      symbol,
      label: `${value.changePercent >= 0 ? "+" : ""}${value.changePercent.toFixed(2)}%`,
      value: value.changePercent,
    })),
    reactionWindow: releaseReplay.reaction.window,
    reactionSources: releaseReplay.reaction.sources.map(({ label }) => label),
  });
  const posters = [
    { jobId: "crypto-daily", poster: daily },
    { jobId: "weekly-calendar", poster: weekly },
    { jobId: "data-release-updates", poster: flash },
    { jobId: "data-release-updates", poster: followUp, reaction: releaseReplay.reaction },
  ].map(({ jobId, poster, reaction }) => ({
    ...poster,
    visualTemplate: selectMarketPosterTemplate({ jobId, poster, reaction }),
  }));

  assert.deepEqual(posters.map(({ visualTemplate }) => visualTemplate.product), [
    "daily-market-brief",
    "weekly-catalyst-calendar",
    "data-flash",
    "market-follow-up",
  ]);
  assert.deepEqual(daily.stories.map(({ posterThesis }) => posterThesis), [
    "Above-target inflation keeps rates and USD sensitivity high.",
    "Restrictive policy limits near-term liquidity easing.",
    "Regulated access improves structure, not today's signal.",
  ]);
  const weeklyEvent = weekly.columns[1].events[0];
  assert.equal(weeklyEvent.posterMarkets, "BTC · DXY · US2Y");
  assert.equal(weeklyEvent.posterSensitivity, "CPI can reprice rates, USD and crypto risk.");
  assert.equal(flash.releaseTime, "2025-07-15T12:30:00.000Z");
  assert.equal(flash.actual, "2.7%");
  assert.equal(flash.forecast, "2.6%");
  assert.equal(flash.previous, "2.4%");
  assert.deepEqual(flash.reactions.map(({ symbol }) => symbol), ["BTC", "ETH", "SOL", "XRP"]);
  assert.equal(flash.posterVerdict, "CPI beat consensus; crypto rose, causation unproven.");
  assert.deepEqual(followUp.reactions.map(({ symbol }) => symbol), ["BTC", "ETH", "SOL", "XRP"]);
  assert.equal(followUp.tapeStatus, "CONFIRMED");
  assert.equal(followUp.posterSource, "COINBASE");
  assert.equal(followUp.posterInvalidation, "Archived replay; not a live trading signal.");
  assert.deepEqual(posters.map((poster) => landscapePosterOverflowFields(poster)), [[], [], [], []]);
});

test("the exact production media URLs for all four Academy demo products render as PNG", async () => {
  const target = [{ channel: "telegram", chatId: "demo" }];
  const results = [];
  for (const jobId of ["crypto-daily", "weekly-calendar", "data-release-updates"]) {
    results.push(await runAutomationJob(jobId, {
      dryRun: true,
      readOnlyPreview: true,
      force: true,
      demoShowcase: true,
      demoAcceptanceBatchId: DEMO_ACCEPTANCE_BATCH_ID,
      targets: target,
      publicBaseUrl: "https://academy.example",
      now: new Date(NOW),
    }));
  }
  const urls = results.flatMap((result) => Object.values(result.preview.mediaDelivery.byTemplateId));

  assert.equal(urls.length, 4);
  assert.equal(new Set(urls).size, 4);
  for (const url of urls) {
    const response = await renderMediaCard(new Request(url));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /^image\/png\b/);
    assert.ok((await response.arrayBuffer()).byteLength > 1024);
  }
});

test("the Academy data replay uses the canonical release identity required by durable delivery", () => {
  const release = buildAcademyDemoShowcaseContent("data-release-updates", { now: NOW, acceptanceBatchId: DEMO_ACCEPTANCE_BATCH_ID });

  assert.ok(release.event.scheduledAt);
  assert.equal(release.event.id, `demo-replay-us-cpi-june-2025-poster-v7-batch-${DEMO_ACCEPTANCE_BATCH_ID}`);
  assert.equal(release.deduplicationKey, buildReleaseDeduplicationKey(release.event));
});

test("the publisher-neutral poster v7 replay has fresh durable identities without disabling deduplication", () => {
  const daily = buildAcademyDemoShowcaseContent("crypto-daily", { now: NOW, acceptanceBatchId: DEMO_ACCEPTANCE_BATCH_ID });
  const weekly = buildAcademyDemoShowcaseContent("weekly-calendar", { now: NOW, acceptanceBatchId: DEMO_ACCEPTANCE_BATCH_ID });
  const release = buildAcademyDemoShowcaseContent("data-release-updates", { now: NOW, acceptanceBatchId: DEMO_ACCEPTANCE_BATCH_ID });

  assert.equal(daily.deduplicationKey, `academy-demo-replay-daily-2025-07-15-poster-v7-batch-${DEMO_ACCEPTANCE_BATCH_ID}`);
  assert.equal(weekly.deduplicationKey, `academy-demo-replay-week-2025-07-14-poster-v7-batch-${DEMO_ACCEPTANCE_BATCH_ID}`);
  assert.match(release.deduplicationKey, new RegExp(`demo-replay-us-cpi-june-2025-poster-v7-batch-${DEMO_ACCEPTANCE_BATCH_ID}`));
  assert.equal(release.deduplicationKey, buildReleaseDeduplicationKey(release.event));
});

test("Academy demo acceptance batches are isolated while one batch remains idempotent", () => {
  const first = buildAcademyDemoShowcaseContent("crypto-daily", { now: NOW, acceptanceBatchId: "acceptance-101" });
  const retry = buildAcademyDemoShowcaseContent("crypto-daily", { now: NOW, acceptanceBatchId: "acceptance-101" });
  const next = buildAcademyDemoShowcaseContent("crypto-daily", { now: NOW, acceptanceBatchId: "acceptance-102" });

  assert.equal(first.deduplicationKey, retry.deduplicationKey);
  assert.notEqual(first.deduplicationKey, next.deduplicationKey);
  assert.throws(
    () => buildAcademyDemoShowcaseContent("crypto-daily", { now: NOW, acceptanceBatchId: "../unsafe" }),
    /ACADEMY_DEMO_ACCEPTANCE_BATCH_ID_INVALID/,
  );
});

test("a blocked governance result fails closed before distribution", async () => {
  const calls = [];
  const result = await governAutomationContent("data-release-updates", generated("data-release-updates", {
    event: { id: "us-cpi", title: "US CPI", releasedAt: NOW, values: { actual: "2.7%" } },
  }), {
    dryRun: false,
    now: NOW,
    publicBaseUrl: "https://academy.example",
    system: {
      async prepare(input) {
        calls.push(input.product);
        return { id: `${input.product}-${input.event.id}`, product: input.product, status: "blocked", gate: { approved: false, reasons: ["evidence missing"] } };
      },
      renderChannels() { throw new Error("must not render blocked content"); },
    },
  });
  assert.equal(result.approved, false);
  assert.deepEqual(calls, ["data-flash"]);
  assert.match(result.reason, /evidence missing/);
});

test("data release source conflicts are preserved for the quality gate", () => {
  const [input] = buildContentProductInputs("data-release-updates", generated("data-release-updates", {
    event: { id: "us-cpi-conflict", title: "US CPI", releasedAt: NOW, values: { actual: "2.7%" } },
    conflict: { rawValues: ["2.7%", "2.8%"] },
  }), { now: NOW });

  assert.equal(input.event.actualConflict, true);
  assert.deepEqual(input.event.actualValues, ["2.7%", "2.8%"]);
});

test("dry-run uses an isolated vault and never mutates the configured production vault", async () => {
  const productionVault = await mkdtemp(join(tmpdir(), "yubit-production-vault-"));
  try {
    const result = await governAutomationContent("crypto-daily", generated("crypto-daily"), {
      dryRun: true,
      now: NOW,
      publicBaseUrl: "https://academy.example",
      vaultPath: productionVault,
    });
    assert.equal(result.approved, true);
    assert.deepEqual(await readdir(productionVault), []);
    assert.equal(result.products[0].status, "distribution-ready");
    assert.equal(result.channelPlans[0].contentHash, result.products[0].contentHash);
  } finally {
    await rm(productionVault, { recursive: true, force: true });
  }
});

test("live governance gives changed source titles distinct immutable evidence identities", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "yubit-source-title-vault-"));
  const source = {
    id: "coindesk",
    url: "https://www.coindesk.com/markets/2026/08/23/market-update",
    tier: "secondary",
    observedAt: NOW,
    status: "verified",
  };
  const content = (title) => generated("crypto-daily", {
    sourceManifest: [{ ...source, title }],
    sources: [{ ...source, title }],
    document: {
      title: "Daily brief",
      selectedStories: [{
        id: "market-update",
        title,
        summary: "Verified market conditions changed during the session.",
        url: source.url,
        publishedAt: NOW,
        source: { id: source.id, label: "CoinDesk", kind: source.tier },
        rationale: "The update may affect near-term positioning.",
        affectedAssets: ["BTC"],
        confidence: "Medium",
        whatToWatch: "Watch spot volume and cross-asset confirmation.",
      }],
    },
  });

  try {
    const first = await governAutomationContent("crypto-daily", content("Bitcoin steadies after the open"), {
      dryRun: false,
      now: NOW,
      vaultPath,
    });
    const second = await governAutomationContent("crypto-daily", content("Bitcoin advances as volume returns"), {
      dryRun: false,
      now: NOW,
      vaultPath,
    });

    assert.equal(first.approved, true);
    assert.equal(second.approved, true);
    assert.notEqual(first.products[0].sources[0].id, second.products[0].sources[0].id);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("live governance fails closed when the Obsidian vault is not configured", async () => {
  const previous = process.env.OBSIDIAN_VAULT_PATH;
  delete process.env.OBSIDIAN_VAULT_PATH;
  try {
    const result = await governAutomationContent("crypto-daily", generated("crypto-daily"), { dryRun: false, now: NOW });
    assert.equal(result.approved, false);
    assert.match(result.reason, /OBSIDIAN_VAULT_PATH/);
  } finally {
    if (previous !== undefined) process.env.OBSIDIAN_VAULT_PATH = previous;
  }
});

test("market delivery plans use the approved canonical channel bytes and hash", () => {
  const governance = {
    approved: true,
    channelPlans: [{
      productId: "data-flash-us-cpi",
      contentHash: "sha256:canonical",
      telegram: { chunks: ["Approved &amp; canonical"] },
      discord: { chunks: ["Approved \\*canonical\\*"] },
    }],
  };
  const payload = { document: { title: "LEGACY MUST NOT SEND" }, contentGovernance: governance };
  const telegramTarget = { platform: "telegram", chatId: "-1003710405969", threadId: 10 };
  const discordTarget = { platform: "discord", guildId: "g", channelId: "c" };
  const [telegram] = buildAutomationTelegramPlans("data-release-updates", payload, [telegramTarget], null);
  const [discord] = buildAutomationDiscordPlans("data-release-updates", payload, [discordTarget], null);
  assert.equal(telegram.contentPolicy, "obsidian-canonical");
  assert.equal(discord.contentPolicy, "obsidian-canonical");
  assert.equal(telegram.contentHash, "sha256:canonical");
  assert.equal(telegram.steps[0].payload.text, "Approved &amp; canonical");
  assert.equal(discord.steps[0].payload.content, "Approved \\*canonical\\*");
  assert.doesNotMatch(telegram.steps[0].payload.text, /LEGACY/);
});

test("data release delivery includes both governed products and remains text-only when media is suppressed", () => {
  const governance = {
    approved: true,
    channelPlans: [
      {
        productId: "data-flash-us-cpi",
        contentHash: "sha256:flash",
        telegram: { chunks: ["<b>YUBIT ACADEMY · DATA FLASH</b>"] },
        discord: { chunks: ["**YUBIT ACADEMY · DATA FLASH**"] },
      },
      {
        productId: "market-follow-up-us-cpi",
        contentHash: "sha256:follow-up",
        telegram: { chunks: ["<b>YUBIT ACADEMY · MARKET FOLLOW-UP</b>"] },
        discord: { chunks: ["**YUBIT ACADEMY · MARKET FOLLOW-UP**"] },
      },
    ],
  };
  const payload = { document: { title: "legacy" }, contentGovernance: governance };
  const target = { platform: "telegram", chatId: "-1003710405969", threadId: 8 };
  const [plan] = buildAutomationTelegramPlans("data-release-updates", payload, [target], null);

  assert.deepEqual(plan.contentProductIds, ["data-flash-us-cpi", "market-follow-up-us-cpi"]);
  assert.deepEqual(plan.contentHashes, ["sha256:flash", "sha256:follow-up"]);
  assert.deepEqual(plan.steps.map(({ method }) => method), ["sendMessage", "sendMessage"]);
  assert.match(plan.steps[0].payload.text, /DATA FLASH/);
  assert.match(plan.steps[1].payload.text, /MARKET FOLLOW-UP/);
  assert.equal(plan.steps.some(({ payload }) => payload.photo || payload.imageUrl), false);
});

test("data flash and market follow-up each receive the matching poster on Telegram and Discord", () => {
  const governance = {
    approved: true,
    channelPlans: [
      {
        productId: "data-flash-us-cpi",
        contentHash: "sha256:flash",
        media: { templateId: "data-flash-v3" },
        telegram: { chunks: ["<b>🚨 DATA FLASH</b>"] },
        discord: { chunks: ["**🚨 DATA FLASH**"] },
      },
      {
        productId: "market-follow-up-us-cpi",
        contentHash: "sha256:follow-up",
        media: { templateId: "market-follow-up-v3" },
        telegram: { chunks: ["<b>MARKET FOLLOW-UP</b>"] },
        discord: { chunks: ["**MARKET FOLLOW-UP**"] },
      },
    ],
  };
  const media = {
    defaultUrl: "https://academy.example/data-flash.png",
    byTemplateId: {
      "data-flash-v3": "https://academy.example/data-flash.png",
      "market-follow-up-v3": "https://academy.example/market-follow-up.png",
    },
  };
  const payload = { document: { title: "legacy" }, contentGovernance: governance };
  const [telegram] = buildAutomationTelegramPlans("data-release-updates", payload, [
    { platform: "telegram", chatId: "-1003710405969", threadId: 8 },
  ], media);
  const [discord] = buildAutomationDiscordPlans("data-release-updates", payload, [
    { platform: "discord", guildId: "g", channelId: "c" },
  ], media);

  assert.deepEqual(telegram.steps.map(({ method }) => method), ["sendPhoto", "sendMessage", "sendPhoto", "sendMessage"]);
  assert.equal(telegram.steps[0].payload.photo, media.byTemplateId["data-flash-v3"]);
  assert.equal(telegram.steps[2].payload.photo, media.byTemplateId["market-follow-up-v3"]);
  assert.equal(discord.steps[0].payload.imageUrl, media.byTemplateId["data-flash-v3"]);
  assert.equal(discord.steps[1].payload.imageUrl, media.byTemplateId["market-follow-up-v3"]);
});

test("a missing product poster never falls back to another product's image", () => {
  const governance = {
    approved: true,
    channelPlans: [{
      productId: "market-follow-up-us-cpi",
      contentHash: "sha256:follow-up",
      media: { templateId: "market-follow-up-v3" },
      telegram: { chunks: ["<b>MARKET FOLLOW-UP</b>"] },
      discord: { chunks: ["**MARKET FOLLOW-UP**"] },
    }],
  };
  const media = {
    defaultUrl: "https://academy.example/data-flash.png",
    byTemplateId: { "data-flash-v3": "https://academy.example/data-flash.png" },
  };
  const payload = { document: { title: "legacy" }, contentGovernance: governance };
  const [telegram] = buildAutomationTelegramPlans("data-release-updates", payload, [
    { platform: "telegram", chatId: "-1003710405969", threadId: 8 },
  ], media);
  const [discord] = buildAutomationDiscordPlans("data-release-updates", payload, [
    { platform: "discord", guildId: "g", channelId: "c" },
  ], media);

  assert.deepEqual(telegram.steps.map(({ method }) => method), ["sendMessage"]);
  assert.equal(discord.steps[0].payload.imageUrl, undefined);
});

test("the automation runner records governed products before returning a preview", async () => {
  const result = await runAutomationJob("crypto-daily", {
    now: NOW,
    force: true,
    dryRun: true,
    readOnlyPreview: true,
    fetchImpl: rssFetch,
    targets: [],
  });

  assert.equal(result.status, "success");
  assert.equal(result.preview.contentGovernance.enabled, true);
  assert.equal(result.preview.contentGovernance.products[0].status, "distribution-ready");
  assert.equal(result.preview.contentGovernance.channelPlans[0].contentHash, result.preview.contentGovernance.products[0].contentHash);
});

test("the automation runner fails closed when content governance blocks a product", async () => {
  let discordSends = 0;
  const result = await runAutomationJob("crypto-daily", {
    now: NOW,
    force: true,
    dryRun: false,
    fetchImpl: rssFetch,
    targets: [{ platform: "discord", guildId: "g1", channelId: "c1" }],
    discordSender: async () => { discordSends += 1; return { id: "unexpected" }; },
    runLogWriter: async (entry) => entry,
    contentProductSystem: {
      async prepare(input) {
        return {
          id: `daily-market-brief-${input.event.id}`,
          product: input.product,
          status: "blocked",
          gate: { approved: false, reasons: ["editorial evidence is incomplete"] },
        };
      },
      renderChannels() { throw new Error("blocked content must not render"); },
    },
  });

  assert.equal(result.status, "skipped");
  assert.match(result.message, /governance/i);
  assert.match(result.preview.contentGovernance.reason, /evidence is incomplete/i);
  assert.equal(discordSends, 0);
});

test("deferred delivery fails Discord explicitly instead of creating an unclaimable queue item", async () => {
  let discordSends = 0;
  const vaultPath = await mkdtemp(join(tmpdir(), "yubit-live-vault-"));
  try {
    const result = await runAutomationJob("crypto-daily", {
      now: "2026-08-23T12:32:00.000Z",
      stateKey: `content-deferred-discord-${process.pid}`,
      force: true,
      dryRun: false,
      deferDelivery: true,
      obsidianVaultPath: vaultPath,
      fetchImpl: rssFetch,
      targets: [{ platform: "discord", guildId: "g1", channelId: "c1" }],
      discordSender: async () => { discordSends += 1; return { id: "unexpected" }; },
      runLogWriter: async (entry) => entry,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.preview.targetResults[0].status, "failed");
    assert.match(result.preview.targetResults[0].error, /does not support/i);
    assert.equal(discordSends, 0);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});
