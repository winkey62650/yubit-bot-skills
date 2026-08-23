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
    document: { title: "Weekly catalysts", weekStart: "2026-08-17", days: [{ date: "2026-08-19", events: [{ id: "cpi", title: "US CPI", whyItMatters: "Rates may reprice.", scenarioMap: "Watch yields and DXY." }] }] },
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
  assert.deepEqual(release.map(({ product }) => product), ["data-flash", "market-follow-up"]);
  assert.equal(release[0].event.actual, "2.7%");
  assert.equal(release[0].facts.some((fact) => fact.actual === true), true);
  assert.equal(release[1].originatingDataFlashId, "data-flash-us-cpi-2026-08");
  const binanceSource = release[0].sources.find((source) => source.id.startsWith("binance-"));
  assert.ok(binanceSource);
  assert.deepEqual(release[1].facts[0].sourceRefs, [binanceSource.id]);
  assert.match(release[1].correlationStatement, /correlation, not causation/i);
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
  assert.equal(products.every(({ title }) => /DEMO REPLAY/i.test(title)), true);
  assert.equal(products.every(({ sources }) => sources.every(({ url }) => url.startsWith("https://"))), true);
  assert.equal(products.find(({ product }) => product === "data-flash")?.event.actual, "2.7% YoY");
  assert.match(products.find(({ product }) => product === "market-follow-up")?.correlationStatement || "", /correlation, not causation/i);
});

test("the Academy data replay uses the canonical release identity required by durable delivery", () => {
  const release = buildAcademyDemoShowcaseContent("data-release-updates", { now: NOW });

  assert.ok(release.event.scheduledAt);
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
