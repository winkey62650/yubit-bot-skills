import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contentProductId, createContentProductSystem } from "./content-product-system.mjs";
import { createObsidianContentStore } from "./obsidian-content-store.mjs";

const JOB_PRODUCT = Object.freeze({
  "crypto-daily": "daily-market-brief",
  "weekly-calendar": "weekly-catalyst-calendar",
  "data-release-updates": "data-flash",
});

function text(value) {
  return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
}

function releaseValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Object.hasOwn(value, "value")) return releaseValue(value.value);
    if (Object.hasOwn(value, "rawValue")) {
      const raw = text(value.rawValue);
      const unit = text(value.unit);
      return raw && unit && !raw.toUpperCase().endsWith(unit.toUpperCase()) ? `${raw}${unit}` : raw;
    }
    return "";
  }
  return text(value);
}

function canonicalInstant(value, fallback) {
  const candidate = value === undefined || value === null || value === "" ? fallback : value;
  const parsed = new Date(candidate);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : String(candidate ?? "");
}

function safeHttps(value) {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function evidenceTier(source) {
  const value = text(source?.tier ?? source?.type ?? source?.kind ?? source?.authority).toLowerCase();
  if (value === "official") return "official";
  if (value === "primary") return "primary";
  return "secondary";
}

function normalizedSources(generated, now) {
  const actual = generated?.event?.provenance?.actual ?? generated?.eligibility?.actual;
  const raw = [
    ...(Array.isArray(generated?.sourceManifest) ? generated.sourceManifest : []),
    ...(Array.isArray(generated?.sources) ? generated.sources : []),
    ...(Array.isArray(generated?.reaction?.sources) ? generated.reaction.sources : []),
    ...(Array.isArray(generated?.document?.selectedStories) ? generated.document.selectedStories.map((story) => ({
      id: story?.source?.id ?? story?.id,
      title: story?.title,
      url: story?.url,
      tier: story?.source?.kind ?? story?.source?.type ?? "secondary",
      observedAt: story?.publishedAt,
    })) : []),
    ...(actual ? [{
      id: actual.sourceId,
      label: actual.sourceLabel ?? actual.sourceId,
      url: actual.sourceUrl,
      authority: actual.authority ?? "official",
      retrievedAt: actual.retrievedAt,
    }] : []),
  ];
  const sources = new Map();
  for (const source of raw) {
    const sourceStatus = text(source?.status).toLowerCase();
    if (["error", "failed", "unavailable"].includes(sourceStatus)) continue;
    const id = text(source?.id ?? source?.sourceId).replace(/[^A-Za-z0-9._:-]+/g, "-");
    const url = safeHttps(source?.url ?? source?.sourceUrl);
    if (!id || !url) continue;
    const observedAt = canonicalInstant(source?.observedAt ?? source?.retrievedAt ?? source?.checkedAt ?? source?.lastSuccessAt, now);
    const snapshot = createHash("sha256")
      .update(JSON.stringify({ id, url, tier: evidenceTier(source), observedAt }))
      .digest("hex")
      .slice(0, 16);
    const candidate = {
      id: `${id}-${snapshot}`,
      title: text(source?.title ?? source?.label ?? source?.name ?? id) || id,
      url,
      tier: evidenceTier(source),
      observedAt,
    };
    const previous = sources.get(candidate.id);
    if (!previous || ["secondary", "primary", "official"].indexOf(candidate.tier) > ["secondary", "primary", "official"].indexOf(previous.tier)) {
      sources.set(candidate.id, candidate);
    }
  }
  return [...sources.values()].sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function documentStatements(document) {
  const statements = [];
  const push = (value) => {
    const normalized = text(value);
    if (normalized && !statements.includes(normalized)) statements.push(normalized);
  };
  const visitNodes = (nodes) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (node?.type === "metric" && text(node.label) && text(node.value?.display ?? node.value?.value ?? node.value)) {
        push(`${text(node.label)}: ${text(node.value?.display ?? node.value?.value ?? node.value)}`);
      }
      else if (["paragraph", "heading"].includes(node?.type)) push(node.text);
    }
  };
  push(document?.title);
  push(document?.verdict);
  for (const section of Array.isArray(document?.sections) ? document.sections : []) visitNodes(section?.nodes);
  for (const section of Array.isArray(document?.decisionSections) ? document.decisionSections : []) visitNodes(section?.nodes);
  visitNodes(document?.nodes);
  for (const day of Array.isArray(document?.days) ? document.days : []) {
    for (const event of Array.isArray(day?.events) ? day.events : []) {
      push(`${day.date}: ${event.title}`);
      push(event.whyItMatters);
      push(event.scenarioMap);
    }
  }
  return statements.filter((statement) => statement.length >= 4).slice(0, 8);
}

function dataActual(generated) {
  return releaseValue(
    generated?.event?.values?.actual
      ?? generated?.event?.actual
      ?? generated?.event?.provenance?.actual?.value
      ?? generated?.eligibility?.actual?.value
      ?? generated?.document?.values?.actual,
  );
}

function nodeMetric(nodes, label) {
  const wanted = text(label).toLowerCase();
  const node = (Array.isArray(nodes) ? nodes : []).find((entry) => entry?.type === "metric" && text(entry.label).toLowerCase() === wanted);
  return text(node?.value?.display ?? node?.value?.value ?? node?.value);
}

function nodeParagraphs(nodes) {
  return (Array.isArray(nodes) ? nodes : []).filter((entry) => entry?.type === "paragraph").map((entry) => text(entry.text)).filter(Boolean);
}

function normalizedDirection(value) {
  const candidate = text(value).replace(/[🟢🔴⚪]/g, "").trim();
  if (/bullish|positive|supportive/i.test(candidate)) return "Slightly Bullish";
  if (/bearish|negative|defensive/i.test(candidate)) return "Slightly Bearish";
  return "Neutral";
}

function utcLabel(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "TBD UTC";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function reactionMoves(reaction) {
  return Object.entries(reaction?.prices ?? reaction?.data ?? {}).flatMap(([symbol, value]) => {
    const basisPoints = Number(value?.changeBasisPoints);
    if (symbol === "US2Y" && Number.isFinite(basisPoints)) {
      return [`US2Y ${basisPoints >= 0 ? "+" : ""}${basisPoints.toFixed(1)}bp`];
    }
    const change = Number(value?.changePercent);
    if (!Number.isFinite(change)) return [];
    return [`${symbol} ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`];
  });
}

const POSTER_PRODUCT = Object.freeze({
  "daily-market-brief-v4": "daily-market-brief",
  "weekly-catalysts-v4": "weekly-catalyst-calendar",
  "data-flash-v4": "data-flash",
  "market-follow-up-v4": "market-follow-up",
  "daily-market-brief-v3": "daily-market-brief",
  "weekly-catalysts-v3": "weekly-catalyst-calendar",
  "data-flash-v3": "data-flash",
  "market-follow-up-v3": "market-follow-up",
});

function mediaForProduct(generated, product) {
  const poster = generated?.posterVariants?.[product] ?? generated?.poster;
  const template = poster?.visualTemplate;
  if (!template || POSTER_PRODUCT[template.id] !== product || template.product !== product) return null;
  return {
    type: "market-poster",
    product,
    templateId: template.id,
    version: template.version,
    assetPath: template.assetPath,
    renderedImagePath: poster === generated?.poster ? generated?.imagePath ?? null : null,
    width: template.canvas?.width,
    height: template.canvas?.height,
    contentHash: generated?.contentHash ?? null,
  };
}

function publicHorizon(value, fallback) {
  const candidate = text(value);
  return /^(?:0|1)\s*[–—-]\s*(?:4H|7D)$/i.test(candidate) ? fallback : candidate || fallback;
}

function productHorizon(product) {
  if (product === "weekly-catalyst-calendar") return "Scheduled UTC window";
  if (product === "daily-market-brief") return "Current session";
  if (product === "market-follow-up") return "Observed UTC window";
  return "Release window";
}

function intelligencePayload(product, generated, { timestamp, occurredAt, title, facts }) {
  const document = generated?.document ?? {};
  const replay = generated?.demoShowcase === true || /DEMO REPLAY|HISTORICAL REPLAY/i.test(title);
  const common = {
    ...(replay ? { mode: "historical-replay" } : {}),
    ...(generated?.demoShowcase === true ? { previewLabel: "DEMO PREVIEW · FORMAT TEST" } : {}),
    updatedAt: timestamp,
    importance: product === "daily-market-brief" ? 4 : 5,
    horizon: productHorizon(product),
    confidence: "Medium",
    bias: { asset: "BTC", direction: normalizedDirection(document?.impact ?? document?.verdict) },
    affectedAssets: product === "weekly-catalyst-calendar" ? ["BTC", "Nasdaq", "DXY", "US2Y"] : ["BTC", "ETH", "Altcoins", "DXY"],
    whyItMatters: text(document?.verdict) || text(facts?.[0]?.text) || "This verified development can change liquidity, volatility, or crypto risk appetite.",
    whatToWatch: ["BTC response versus the event benchmark", "DXY and US2Y confirmation", "ETH and altcoin breadth"],
  };
  if (product === "daily-market-brief") {
    const selected = Array.isArray(document.selectedStories) && document.selectedStories.length
      ? document.selectedStories.slice(0, 3)
      : [{ title, summary: facts?.[0]?.text, impact: document?.impact, marketImpact: { score: 60 }, affectedAssets: common.affectedAssets }];
    const catalysts = selected.map((story) => ({
      headline: text(story.title) || title,
      happened: text(story.summary) || text(story.description) || text(story.title) || facts?.[0]?.text,
      importance: Math.max(1, Math.min(5, Math.ceil((Number(story?.marketImpact?.score) || 60) / 20))),
      horizon: publicHorizon(story.horizon, "Current session"),
      confidence: ["Low", "Medium", "High"].includes(story.confidence) ? story.confidence : "Medium",
      affectedAssets: (Array.isArray(story.affectedAssets) ? story.affectedAssets : story.categories ?? common.affectedAssets).map(text).filter(Boolean).slice(0, 5),
      whyItMatters: text(story.rationale) || text(story.summary) || "This ranked development can alter near-term positioning or volatility.",
      whatToWatch: text(story.whatToWatch) || "Watch price persistence, volume retention, and cross-asset confirmation.",
    }));
    const directions = selected.map((story) => normalizedDirection(story?.impact));
    const whatToWatch = [...new Set(catalysts.map((item) => item.whatToWatch).filter(Boolean))].slice(0, 3);
    const affectedAssets = [...new Set(catalysts.flatMap((item) => item.affectedAssets))].slice(0, 6);
    const strongest = catalysts[0];
    return {
      ...common,
      importance: Math.max(...catalysts.map((item) => item.importance)),
      confidence: strongest?.confidence ?? common.confidence,
      bias: { asset: "BTC", direction: directions.length && directions.every((item) => item === directions[0]) ? directions[0] : "Neutral" },
      affectedAssets,
      whyItMatters: strongest?.whyItMatters ?? common.whyItMatters,
      whatToWatch: whatToWatch.length ? whatToWatch : common.whatToWatch,
      catalysts,
    };
  }
  if (product === "weekly-catalyst-calendar") {
    const events = (document.days ?? []).flatMap((day) => (day.events ?? []).map((event) => ({
      timeUtc: utcLabel(event.scheduledAt ?? (/^\d{2}:\d{2}$/.test(text(event.time)) ? `${day.date}T${event.time}:00.000Z` : `${day.date}T00:00:00.000Z`)),
      title: text(event.title),
      importance: Math.max(1, Math.min(5, Number(event.importance) >= 3 ? 5 : Number(event.importance) || 4)),
      actual: releaseValue(event.values?.actual ?? nodeMetric(event.nodes, "Actual")) || "Pending",
      forecast: releaseValue(event.values?.forecast ?? nodeMetric(event.nodes, "Forecast")) || "No consensus",
      previous: releaseValue(event.values?.previous ?? nodeMetric(event.nodes, "Previous")) || "Not available",
      markets: text(event.marketSensitivity ?? nodeMetric(event.nodes, "Market sensitivity")).split(/[·,]/).map(text).filter(Boolean),
      whyItMatters: text(event.whyItMatters) || nodeParagraphs(event.nodes)[0] || common.whyItMatters,
      scenarioMap: text(event.scenarioMap ?? nodeMetric(event.nodes, "Scenario map")) || "Below consensus: risk-on; near consensus: neutral; above consensus: risk-off, subject to DXY and rates confirmation.",
    })));
    return { ...common, events };
  }
  const values = generated?.event?.values ?? document?.values ?? {};
  const moves = reactionMoves(product === "data-flash"
    ? generated?.initialReaction ?? generated?.reaction
    : generated?.reaction);
  const actual = releaseValue(values.actual);
  const forecast = releaseValue(values.forecast);
  const surprise = nodeMetric(document.nodes, "Surprise vs Forecast")
    || (!forecast ? "No comparable consensus" : actual === forecast ? "In line with consensus" : `${actual} vs ${forecast}`);
  if (product === "data-flash") return {
    ...common,
    release: {
      indicator: text(generated?.event?.indicator ?? generated?.event?.indicatorId ?? document?.indicator ?? generated?.event?.title ?? title),
      releaseTime: canonicalInstant(
        generated?.event?.releasedAt ?? generated?.event?.actualObservedAt ?? generated?.event?.scheduledAt,
        occurredAt,
      ),
      actual: actual || releaseValue(generated?.event?.actual) || "Not available",
      forecast: forecast || "No consensus",
      previous: releaseValue(values.previous) || "Not available",
      surprise,
      initialReaction: moves,
      deskView: text(document.verdict) || common.whyItMatters,
    },
  };
  return {
    ...common,
    followUp: {
      marketMoves: moves,
      interpretation: text(document.verdict) || "The measured tape is contextual evidence; cross-asset persistence determines whether the initial read is confirmed.",
      confirmation: text(document.confirmation) || "BTC holds the event-window direction while DXY or rates provide consistent confirmation.",
      invalidation: text(document.invalidation) || "The observed move reverses through the pre-release benchmark.",
    },
  };
}

function baseInput(jobId, generated, { now, publicBaseUrl }) {
  const product = JOB_PRODUCT[jobId];
  if (!product) throw new Error(`Unsupported governed automation job: ${jobId}`);
  const timestamp = canonicalInstant(now ?? generated?.generatedAt, generated?.generatedAt ?? new Date());
  const document = generated?.document ?? {};
  const actual = product === "data-flash" ? dataActual(generated) : "";
  const conflictValues = Array.isArray(generated?.conflict?.rawValues)
    ? generated.conflict.rawValues.map(text).filter(Boolean)
    : [];
  const identity = product === "weekly-catalyst-calendar"
    ? text(document.weekStart) || timestamp.slice(0, 10)
    : product === "daily-market-brief"
      ? timestamp.slice(0, 10)
      : text(generated?.event?.id ?? generated?.deduplicationKey) || timestamp;
  const occurredAt = canonicalInstant(
    generated?.event?.releasedAt
      ?? generated?.event?.actualObservedAt
      ?? generated?.event?.scheduledAt
      ?? (product === "weekly-catalyst-calendar" ? `${identity}T00:00:00.000Z` : timestamp),
    timestamp,
  );
  const sources = normalizedSources(generated, occurredAt);
  const allSourceRefs = sources.map(({ id }) => id);
  const officialSourceRefs = sources.filter(({ tier }) => ["official", "primary"].includes(tier)).map(({ id }) => id);
  const title = text(document.title ?? generated?.event?.title) || `${product} ${identity}`;
  const statements = documentStatements(document);
  const dailyFacts = product === "daily-market-brief" ? (document.selectedStories ?? []).slice(0, 3).map((story) => {
    const storyUrl = safeHttps(story?.url);
    const storySourceRefs = sources.filter((source) => storyUrl && source.url === storyUrl).map(({ id }) => id);
    return {
      text: `${text(story?.title)}${text(story?.summary) ? ` — ${text(story.summary)}` : ""}`,
      sourceRefs: storySourceRefs.length ? storySourceRefs : allSourceRefs,
    };
  }) : [];
  const factText = statements.filter((statement) => statement !== title).slice(0, 5);
  const facts = dailyFacts.length ? dailyFacts : (factText.length ? factText : [title]).map((statement, index) => ({
    text: statement,
    sourceRefs: product === "data-flash" && index === 0 ? officialSourceRefs : allSourceRefs,
    ...(product === "data-flash" && index === 0 ? { actual: true } : {}),
  }));
  if (product === "data-flash" && actual) facts[0].text = `Official actual: ${actual}. ${facts[0].text}`;
  const ctaUrl = safeHttps(generated?.articleUrl) ?? new URL("/academy", `${new URL(publicBaseUrl ?? "https://academy.yubit.com").origin}/`).toString();
  const base = {
    product,
    event: {
      id: identity,
      title: text(generated?.event?.title) || title,
      occurredAt,
      ...(product === "data-flash" ? {
        actual,
        ...(conflictValues.length ? { actualConflict: true, actualValues: conflictValues } : {}),
      } : {}),
    },
    title,
    language: "en",
    sources,
    facts,
    inferences: [{ text: text(document.verdict) || "The observed evidence may affect near-term market positioning; confirmation remains necessary." }],
    risk: "Market conditions, source revisions, or delayed cross-asset confirmation can change this interpretation.",
    invalidation: text(document.invalidation) || "Invalidate the initial read if official evidence changes or the observed market move reverses.",
    cta: { label: "Join the market discussion", url: ctaUrl },
    media: mediaForProduct(generated, product),
  };
  return { ...base, intelligence: intelligencePayload(product, generated, { timestamp, occurredAt, title, facts }) };
}

function followUpInput(dataFlash, generated) {
  const reaction = generated?.reaction;
  const start = canonicalInstant(reaction?.window?.start ?? generated?.event?.releasedAt, dataFlash.event.occurredAt);
  let end = canonicalInstant(reaction?.window?.end ?? generated?.generatedAt, generated?.generatedAt ?? dataFlash.event.occurredAt);
  if (new Date(end) <= new Date(start)) end = new Date(new Date(start).getTime() + 15 * 60_000).toISOString();
  const changes = reactionMoves(reaction).join(", ");
  const reactionSourceIds = new Set((Array.isArray(reaction?.sources) ? reaction.sources : [])
    .filter((source) => ["ok", "degraded", "verified"].includes(text(source?.status).toLowerCase()))
    .map((source) => text(source?.id ?? source?.sourceId).replace(/[^A-Za-z0-9._:-]+/g, "-"))
    .filter(Boolean));
  const reactionSourceRefs = (Array.isArray(dataFlash.sources) ? dataFlash.sources : [])
    .filter((source) => [...reactionSourceIds].some((id) => source.id === id || source.id.startsWith(`${id}-`)))
    .map((source) => source.id);
  return {
    ...dataFlash,
    product: "market-follow-up",
    title: `${dataFlash.event.title} — measured market follow-up`,
    facts: [{
      text: changes ? `Observed market change: ${changes}.` : "A bounded post-release observation window was recorded.",
      sourceRefs: reactionSourceRefs,
    }],
    inferences: [{ text: "The measured move is contextual evidence and does not establish that the release caused the move." }],
    originatingDataFlashId: contentProductId("data-flash", dataFlash.event.id),
    observationWindow: { start, end },
    correlationStatement: `${changes || "The market moved during the bounded window"}; this is correlation, not causation.`,
    media: mediaForProduct(generated, "market-follow-up"),
    intelligence: intelligencePayload("market-follow-up", generated, {
      timestamp: canonicalInstant(generated?.generatedAt, end),
      occurredAt: start,
      title: `${dataFlash.event.title} — measured market follow-up`,
      facts: dataFlash.facts,
    }),
  };
}

function hasCompletedFollowUpWindow(reaction, now) {
  const start = new Date(reaction?.window?.start);
  const end = new Date(reaction?.window?.end);
  const checkedAt = new Date(now);
  if (![start, end, checkedAt].every((value) => Number.isFinite(value.getTime()))) return false;
  const durationMinutes = (end.getTime() - start.getTime()) / 60_000;
  return durationMinutes >= 10 && durationMinutes <= 30 && end <= checkedAt;
}

export function buildContentProductInputs(jobId, generated, options = {}) {
  const primary = baseInput(jobId, generated, options);
  if (jobId !== "data-release-updates" || !generated?.reaction) return [primary];
  const checkedAt = options.now ?? generated?.generatedAt;
  if (!hasCompletedFollowUpWindow(generated.reaction, checkedAt)) return [primary];
  return [primary, followUpInput(primary, generated)];
}

export async function governAutomationContent(jobId, generated, options = {}) {
  const now = canonicalInstant(options.now ?? generated?.generatedAt, generated?.generatedAt ?? new Date());
  let temporaryVault = null;
  let system = options.dryRun === true ? null : options.system;
  try {
    if (!system) {
      const configuredVault = options.vaultPath ?? process.env.OBSIDIAN_VAULT_PATH;
      if (!configuredVault && options.dryRun !== true) {
        return { enabled: false, approved: false, reason: "OBSIDIAN_VAULT_PATH is required for live content governance.", products: [], channelPlans: [] };
      }
      const vaultPath = options.dryRun === true
        ? (temporaryVault = await mkdtemp(join(tmpdir(), "yubit-content-dry-run-")))
        : configuredVault;
      const store = createObsidianContentStore({ vaultPath, now: () => new Date(now) });
      const health = await store.initialize();
      if (!health.ready) throw new Error(health.error || "Obsidian vault is not ready");
      system = createContentProductSystem({ store, now: () => new Date(now) });
    }
    const products = [];
    const channelPlans = [];
    for (const input of buildContentProductInputs(jobId, generated, { ...options, now })) {
      const product = await system.prepare(input);
      products.push(product);
      if (product.status !== "distribution-ready" || product.gate?.approved !== true) {
        return {
          enabled: true,
          approved: false,
          reason: product.gate?.reasons?.join(" ") || `Content product ${product.id} did not reach distribution-ready.`,
          products,
          channelPlans,
        };
      }
      const rendered = system.renderChannels(product);
      if (rendered.contentHash !== product.contentHash) throw new Error("Governed channel content hash mismatch.");
      channelPlans.push({ productId: product.id, ...rendered });
    }
    return { enabled: true, approved: true, products, channelPlans, vaultPath: options.dryRun === true ? null : (options.vaultPath ?? process.env.OBSIDIAN_VAULT_PATH ?? null) };
  } finally {
    if (temporaryVault) await rm(temporaryVault, { recursive: true, force: true });
  }
}

export async function publishGovernedContent(contentGovernance, { vaultPath, now = new Date(), receipt = {} } = {}) {
  if (!contentGovernance?.approved || !Array.isArray(contentGovernance.products) || contentGovernance.products.length === 0) return [];
  const configuredVault = vaultPath ?? contentGovernance.vaultPath ?? process.env.OBSIDIAN_VAULT_PATH;
  if (!configuredVault) throw new Error("OBSIDIAN_VAULT_PATH is required to persist published content lifecycle.");
  const store = createObsidianContentStore({ vaultPath: configuredVault, now: () => new Date(now) });
  const health = await store.health();
  if (!health.ready) throw new Error(health.error || "Obsidian vault is not ready");
  const system = createContentProductSystem({ store, now: () => new Date(now) });
  const published = [];
  for (const product of contentGovernance.products) published.push(await system.publish(product, receipt));
  return published;
}
