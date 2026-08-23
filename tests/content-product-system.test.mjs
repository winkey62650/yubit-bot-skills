import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTENT_PRODUCT_TYPES,
  createContentProductSystem,
} from "../lib/content-product-system.mjs";

function storeDouble() {
  const writes = [];
  const products = new Map();
  return {
    writes,
    async writeSource(value) { writes.push(["source", structuredClone(value)]); },
    async writeEvent(value) { writes.push(["event", structuredClone(value)]); },
    async writeProduct(value) {
      writes.push(["product", structuredClone(value)]);
      products.set(`${value.product}:${value.id}`, structuredClone(value));
    },
    async readProduct({ product, id }) { return structuredClone(products.get(`${product}:${id}`)); },
  };
}

function input(product, overrides = {}) {
  const eventId = product === "weekly-catalyst-calendar" ? "2026-W34" : "us-cpi-2026-08";
  return {
    product,
    event: {
      id: eventId,
      title: "US CPI release",
      occurredAt: "2026-08-23T12:30:00.000Z",
      actual: product === "data-flash" || product === "market-follow-up" ? "2.7%" : null,
    },
    title: `${product} title`,
    language: "en",
    sources: [{
      id: "bls-cpi-2026-08",
      title: "BLS CPI release",
      url: "https://www.bls.gov/news.release/cpi.htm",
      tier: "official",
      observedAt: "2026-08-23T12:31:00.000Z",
    }],
    facts: [{ text: "Headline CPI was 2.7% year over year.", sourceRefs: ["bls-cpi-2026-08"], actual: true }],
    inferences: [{ text: "The print may reduce near-term rate anxiety." }],
    risk: "A later official revision can change the reading.",
    invalidation: "Invalidate if the official release is revised.",
    cta: { label: "Discuss in the community", url: "https://academy.example/discuss" },
    intelligence: {
      updatedAt: "2026-08-23T12:45:00.000Z",
      importance: 5,
      horizon: product === "weekly-catalyst-calendar" ? "1–7D" : "0–4H",
      confidence: "Medium",
      bias: { asset: "BTC", direction: "Neutral" },
      affectedAssets: ["BTC", "ETH", "DXY", "US2Y"],
      whyItMatters: "The release can reprice the expected policy path and crypto liquidity conditions.",
      whatToWatch: ["DXY direction", "US2Y confirmation", "BTC hold versus the pre-release level"],
      catalysts: [{
        headline: "US CPI release",
        happened: "Headline CPI was 2.7% year over year.",
        importance: 5,
        horizon: "0–4H",
        confidence: "Medium",
        affectedAssets: ["BTC", "ETH", "DXY", "US2Y"],
        whyItMatters: "The print can reprice the expected policy path.",
        whatToWatch: "Watch DXY and US2Y confirmation.",
      }],
      events: [{
        timeUtc: "2026-08-23 12:30 UTC",
        title: "US CPI release",
        importance: 5,
        actual: "2.7%",
        forecast: "2.8%",
        previous: "2.9%",
        markets: ["BTC", "Nasdaq", "DXY", "US2Y"],
        whyItMatters: "The print can reprice the expected policy path.",
        scenarioMap: "Below consensus: risk-on; near consensus: neutral; above consensus: risk-off.",
      }],
      release: {
        actual: "2.7%",
        forecast: "2.8%",
        previous: "2.9%",
        surprise: "Below consensus",
        initialReaction: ["BTC +0.50%", "DXY -0.12%", "US2Y -4bp"],
        deskView: "The initial reaction is supportive but still needs cross-asset confirmation.",
      },
      followUp: {
        marketMoves: ["BTC +0.50%", "DXY -0.12%", "US2Y -4bp"],
        interpretation: "The cross-asset tape tentatively confirms the initial read.",
        confirmation: "BTC holds above its pre-release level while DXY and US2Y stay lower.",
        invalidation: "BTC reverses while DXY or US2Y erase the move.",
      },
    },
    ...(product === "market-follow-up" ? {
      originatingDataFlashId: "data-flash-us-cpi-2026-08",
      observationWindow: {
        start: "2026-08-23T12:30:00.000Z",
        end: "2026-08-23T13:00:00.000Z",
      },
      correlationStatement: "BTC rose during the observation window; this is correlation, not causation.",
    } : {}),
    ...overrides,
  };
}

test("registers exactly the four approved content products", () => {
  assert.deepEqual([...CONTENT_PRODUCT_TYPES], [
    "daily-market-brief",
    "weekly-catalyst-calendar",
    "data-flash",
    "market-follow-up",
  ]);
});

test("all four products reach distribution-ready only after governed Obsidian writes", async () => {
  for (const product of CONTENT_PRODUCT_TYPES) {
    const store = storeDouble();
    const system = createContentProductSystem({ store, now: () => new Date("2026-08-23T13:01:00.000Z") });
    const prepared = await system.prepare(input(product));

    assert.equal(prepared.status, "distribution-ready");
    assert.equal(prepared.gate.approved, true);
    assert.deepEqual(prepared.lifecycle.map(({ status }) => status), [
      "draft", "evidence-verified", "quality-approved", "distribution-ready",
    ]);
    assert.deepEqual(store.writes.map(([kind]) => kind), ["source", "event", "product"]);
    assert.equal(store.writes.at(-1)[1].status, "distribution-ready");
    assert.equal(store.writes.at(-1)[1].contentHash, prepared.contentHash);
  }
});

test("identity and content hash are deterministic across clocks and input key order", async () => {
  const first = await createContentProductSystem({ store: storeDouble(), now: () => new Date("2026-08-23T13:01:00Z") })
    .prepare(input("daily-market-brief"));
  const reordered = { ...input("daily-market-brief") };
  const second = await createContentProductSystem({ store: storeDouble(), now: () => new Date("2026-08-24T00:00:00Z") })
    .prepare(reordered);
  assert.equal(first.id, second.id);
  assert.equal(first.contentHash, second.contentHash);
});

test("missing, unknown, or secondary-only evidence blocks distribution fail-closed", async () => {
  for (const candidate of [
    input("data-flash", { sources: [] }),
    input("data-flash", { facts: [{ text: "Actual was 2.7%.", sourceRefs: ["unknown"], actual: true }] }),
    input("data-flash", { sources: [{ ...input("data-flash").sources[0], tier: "secondary" }] }),
    input("data-flash", {
      sources: [{ ...input("data-flash").sources[0], tier: "secondary" }],
      facts: [{ text: "Actual was 2.7%.", sourceRefs: ["bls-cpi-2026-08"] }],
    }),
    input("data-flash", { event: { ...input("data-flash").event, actual: null } }),
    input("data-flash", { event: { ...input("data-flash").event, actualValues: ["2.7%", "2.8%"] } }),
  ]) {
    const store = storeDouble();
    const prepared = await createContentProductSystem({ store }).prepare(candidate);
    assert.equal(prepared.status, "blocked");
    assert.equal(prepared.gate.approved, false);
    assert.ok(prepared.gate.reasons.length > 0);
    assert.equal(store.writes.some(([kind]) => kind === "product" && store.writes.at(-1)[1].status === "distribution-ready"), false);
  }
});

test("facts and inferences, timestamps, risk, invalidation, CTA, and language are mandatory", async () => {
  const invalidInputs = [
    input("daily-market-brief", { facts: [] }),
    input("daily-market-brief", { inferences: [] }),
    input("daily-market-brief", { risk: "" }),
    input("daily-market-brief", { invalidation: "" }),
    input("daily-market-brief", { language: "xx" }),
    input("daily-market-brief", { cta: { label: "Guaranteed profit", url: "http://unsafe.example" } }),
    input("daily-market-brief", { event: { ...input("daily-market-brief").event, occurredAt: "not-a-time" } }),
    input("daily-market-brief", { intelligence: { ...input("daily-market-brief").intelligence, horizon: "" } }),
    input("daily-market-brief", { intelligence: { ...input("daily-market-brief").intelligence, confidence: "Certain" } }),
    input("daily-market-brief", { intelligence: { ...input("daily-market-brief").intelligence, whatToWatch: [] } }),
  ];
  for (const candidate of invalidInputs) {
    const result = await createContentProductSystem({ store: storeDouble() }).prepare(candidate);
    assert.equal(result.status, "blocked");
  }
});

test("market follow-up requires an originating flash, bounded observation window, and non-causal wording", async () => {
  const candidates = [
    input("market-follow-up", { originatingDataFlashId: "" }),
    input("market-follow-up", { observationWindow: { start: "2026-08-23T13:00:00Z", end: "2026-08-23T12:00:00Z" } }),
    input("market-follow-up", { correlationStatement: "The CPI print caused BTC to rally." }),
  ];
  for (const candidate of candidates) {
    const result = await createContentProductSystem({ store: storeDouble() }).prepare(candidate);
    assert.equal(result.status, "blocked");
    assert.ok(result.gate.reasons.some((reason) => /follow-up|causal|observation/i.test(reason)));
  }
});

test("Telegram and Discord plans preserve canonical facts and respect channel limits", async () => {
  const longFact = `Observed value: ${"<&*_~|".repeat(900)} 2.7%.`;
  const system = createContentProductSystem({
    store: storeDouble(),
    now: () => new Date("2026-08-23T13:01:00.000Z"),
  });
  const prepared = await system.prepare(input("data-flash", {
    facts: [{ text: longFact, sourceRefs: ["bls-cpi-2026-08"], actual: true }],
  }));
  const rendered = system.renderChannels(prepared);

  assert.ok(rendered.telegram.chunks.length > 1);
  assert.ok(rendered.discord.chunks.length > 1);
  assert.ok(rendered.telegram.chunks.every((chunk) => chunk.length <= 4096));
  assert.ok(rendered.discord.chunks.every((chunk) => chunk.length <= 2000));
  assert.equal(rendered.canonicalText, prepared.canonicalText);
  assert.ok(rendered.canonicalText.includes(longFact));
  assert.ok(rendered.telegram.chunks.join("").includes("&lt;&amp;"));
  assert.ok(rendered.discord.chunks.join("").includes("\\*"));
});

test("editorial wrappers keep long titles and risk boundaries within channel limits", async () => {
  const system = createContentProductSystem({
    store: storeDouble(),
    now: () => new Date("2026-08-23T13:01:00.000Z"),
  });
  const prepared = await system.prepare(input("daily-market-brief", {
    title: `Long title ${"<&*".repeat(1_000)}`,
    risk: `Risk boundary ${"market conditions can change; ".repeat(180)}`,
    invalidation: `Invalidate when ${"the benchmark reverses; ".repeat(180)}`,
  }));
  const rendered = system.renderChannels(prepared);

  assert.ok(rendered.telegram.chunks.every((chunk) => chunk.length <= 4096));
  assert.ok(rendered.discord.chunks.every((chunk) => chunk.length <= 2000));
  assert.match(rendered.telegram.chunks.join(""), /RISK \/ INVALIDATION/);
  assert.match(rendered.discord.chunks.join(""), /RISK BOUNDARY/);
});

test("all four Telegram products render a structured text-only editorial layout", async () => {
  const expectedKickers = new Map([
    ["daily-market-brief", "📊 MARKET BRIEF"],
    ["weekly-catalyst-calendar", "🗓 WEEKLY CATALYSTS"],
    ["data-flash", "🚨 DATA FLASH"],
    ["market-follow-up", "MARKET FOLLOW-UP"],
  ]);
  const expectedEmojiCounts = new Map([
    ["daily-market-brief", 2],
    ["weekly-catalyst-calendar", 2],
    ["data-flash", 2],
    ["market-follow-up", 1],
  ]);
  const expectedAnalysisBlocks = new Map([
    ["daily-market-brief", /<b>WHY IT MATTERS<\/b>/],
    ["weekly-catalyst-calendar", /<b>WHY IT MATTERS<\/b>/],
    ["data-flash", /<b>03  ·  WHAT TO WATCH<\/b>/],
    ["market-follow-up", /<b>02  ·  CORRELATION CHECK<\/b>/],
  ]);

  for (const product of CONTENT_PRODUCT_TYPES) {
    const system = createContentProductSystem({ store: storeDouble(), now: () => new Date("2026-08-23T13:01:00.000Z") });
    const prepared = await system.prepare(input(product, {
      title: `Layout <check> & ${product}`,
    }));
    const rendered = system.renderChannels(prepared);
    const telegram = rendered.telegram.chunks.join("\n\n");

    assert.equal(rendered.telegram.parseMode, "HTML");
    assert.match(telegram, new RegExp(`<b>YUBIT ACADEMY  ·  ${expectedKickers.get(product)}</b>`));
    assert.match(telegram, /<b>Layout &lt;check&gt; &amp;[^<]+<\/b>\n<i>Updated 23 Aug 2026 · 12:45 UTC<\/i>/);
    assert.match(telegram, /<blockquote><b>THE READ<\/b>\n[^<]+<\/blockquote>/);
    assert.match(telegram, /<b>🟡 Neutral · BTC<\/b>  \|  (?:0–4H|1–7D)  \|  Medium confidence  \|  Importance 5\/5/);
    assert.doesNotMatch(telegram, /<b>BIAS<\/b>[\s\S]*<b>HORIZON<\/b>[\s\S]*<b>CONFIDENCE<\/b>/);
    assert.match(telegram, expectedAnalysisBlocks.get(product));
    assert.match(telegram, product === "data-flash" ? /<b>03  ·  WHAT TO WATCH<\/b>/ : /<b>WATCH NEXT<\/b>/);
    assert.match(telegram, /<b>RISK \/ INVALIDATION<\/b>/);
    assert.match(telegram, /<b>SOURCES<\/b>/);
    assert.doesNotMatch(telegram, /👀|⚠️|🔗|✓|🧭|📅|⚡|🔎/u);
    assert.equal((telegram.match(/\p{Extended_Pictographic}/gu) ?? []).length, expectedEmojiCounts.get(product));
    assert.match(rendered.discord.chunks.join("\n\n"), /\*\*YUBIT ACADEMY  ·/);
    assert.match(rendered.discord.chunks.join("\n\n"), /> \*\*THE READ\*\*/);
    assert.match(rendered.discord.chunks.join("\n\n"), /\*\*BTC · NEUTRAL\*\*  \\|  (?:0–4H|1–7D)  \\|  MEDIUM CONF\./);
    assert.match(rendered.discord.chunks.join("\n\n"), /WHAT HAPPENED|PREV \/ CONS \/ ACTUAL|01  ·  RELEASE|01  ·  MEASURED MOVE/);
    assert.match(telegram, /Layout &lt;check&gt; &amp;/);
    assert.doesNotMatch(telegram, /<img|sendPhoto|photo=/i);
  }
});

test("stale real-time intelligence is blocked while explicit historical replay remains labeled", async () => {
  const stale = input("daily-market-brief", {
    intelligence: { ...input("daily-market-brief").intelligence, updatedAt: "2026-08-20T12:45:00.000Z" },
  });
  const blocked = await createContentProductSystem({ store: storeDouble(), now: () => new Date("2026-08-23T13:01:00.000Z") }).prepare(stale);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.gate.reasons.join(" "), /stale/i);

  const replay = await createContentProductSystem({ store: storeDouble(), now: () => new Date("2026-08-23T13:01:00.000Z") }).prepare({
    ...stale,
    intelligence: { ...stale.intelligence, mode: "historical-replay" },
    title: "HISTORICAL REPLAY — US CPI",
  });
  assert.equal(replay.status, "distribution-ready");
  assert.match(replay.canonicalText, /HISTORICAL REPLAY/);
});

test("lifecycle is monotonic and published/blocked states are terminal", async () => {
  const store = storeDouble();
  const system = createContentProductSystem({ store });
  const ready = await system.prepare(input("daily-market-brief"));
  const published = await system.publish(ready, { targetCount: 2 });
  assert.equal(published.status, "published");
  assert.equal(store.writes.at(-1)[1].status, "published");
  assert.throws(() => system.transition(published, "distribution-ready", "rollback"), /transition/i);
  assert.throws(() => system.transition(ready, "evidence-verified", "rollback"), /transition/i);
});

test("distribution approval is denied when Obsidian readback differs from the exact canonical payload", async () => {
  const store = storeDouble();
  store.readProduct = async ({ product, id }) => ({ ...store.writes.at(-1)[1], product, id, canonicalText: "tampered" });
  const result = await createContentProductSystem({ store }).prepare(input("daily-market-brief"));
  assert.equal(result.status, "blocked");
  assert.match(result.gate.reasons.join(" "), /readback|canonical/i);
});
