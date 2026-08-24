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
import { buildAutomationDiscordPlans, buildAutomationTelegramPlans, runAutomationJob } from "../lib/automation-jobs.mjs";
import { buildReleaseDeduplicationKey } from "../lib/data-release-monitor.mjs";

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
      title: "US CPI",
      releasedAt: NOW,
      values: { actual: "2.7%", forecast: "2.8%" },
      provenance: { actual: { value: "2.7%", sourceId: "bls-cpi", sourceUrl: OFFICIAL.url, retrievedAt: NOW, authority: "official" } },
    },
    document: { title: "US CPI released", verdict: "The first move remains unconfirmed.", invalidation: "Invalidate if price reverses.", values: { actual: "2.7%", forecast: "2.8%" }, nodes: [] },
    reaction: {
      window: { start: "2026-08-23T12:29:00.000Z", end: "2026-08-23T12:45:00.000Z" },
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
  assert.equal(release[0].event.actual, "2.7%");
  assert.equal(release[0].facts.some((fact) => fact.actual === true), true);
  assert.equal(release[1].originatingDataFlashId, "data-flash-us-cpi-2026-08");
  const binanceSource = release[0].sources.find((source) => source.id.startsWith("binance-"));
  assert.ok(binanceSource);
  assert.deepEqual(release[1].facts[0].sourceRefs, [binanceSource.id]);
  assert.match(release[1].correlationStatement, /correlation, not causation/i);
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

test("the Academy demo showcase is an explicit historical replay that yields all four governed products", () => {
  const jobs = ["crypto-daily", "weekly-calendar", "data-release-updates"];
  const products = jobs.flatMap((jobId) => buildContentProductInputs(
    jobId,
    buildAcademyDemoShowcaseContent(jobId, { now: NOW }),
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
  assert.equal(dataFlash?.event.actual, "2.7% YoY");
  assert.equal(dataFlash?.intelligence.release.surprise, "No comparable consensus");
  assert.match(products.find(({ product }) => product === "market-follow-up")?.correlationStatement || "", /correlation, not causation/i);
});

test("the Academy data replay uses the canonical release identity required by durable delivery", () => {
  const release = buildAcademyDemoShowcaseContent("data-release-updates", { now: NOW });

  assert.ok(release.event.scheduledAt);
  assert.equal(release.event.id, "demo-replay-us-cpi-june-2025-format-v4");
  assert.equal(release.deduplicationKey, buildReleaseDeduplicationKey(release.event));
});

test("the publisher-neutral v4 visual replay has fresh durable identities without disabling deduplication", () => {
  const daily = buildAcademyDemoShowcaseContent("crypto-daily", { now: NOW });
  const weekly = buildAcademyDemoShowcaseContent("weekly-calendar", { now: NOW });
  const release = buildAcademyDemoShowcaseContent("data-release-updates", { now: NOW });

  assert.equal(daily.deduplicationKey, "academy-demo-replay-daily-2025-07-15-format-v4");
  assert.equal(weekly.deduplicationKey, "academy-demo-replay-week-2025-07-14-format-v4");
  assert.match(release.deduplicationKey, /demo-replay-us-cpi-june-2025-format-v4/);
  assert.equal(release.deduplicationKey, buildReleaseDeduplicationKey(release.event));
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
