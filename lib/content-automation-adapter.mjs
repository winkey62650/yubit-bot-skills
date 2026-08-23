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
  return text(
    generated?.event?.values?.actual
      ?? generated?.event?.actual
      ?? generated?.event?.provenance?.actual?.value
      ?? generated?.eligibility?.actual?.value
      ?? generated?.document?.values?.actual,
  );
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
  const factText = statements.filter((statement) => statement !== title).slice(0, 5);
  const facts = (factText.length ? factText : [title]).map((statement, index) => ({
    text: statement,
    sourceRefs: product === "data-flash" && index === 0 ? officialSourceRefs : allSourceRefs,
    ...(product === "data-flash" && index === 0 ? { actual: true } : {}),
  }));
  if (product === "data-flash" && actual) facts[0].text = `Official actual: ${actual}. ${facts[0].text}`;
  const ctaUrl = safeHttps(generated?.articleUrl) ?? new URL("/academy", `${new URL(publicBaseUrl ?? "https://academy.yubit.com").origin}/`).toString();
  return {
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
    cta: { label: "Discuss in the Academy community", url: ctaUrl },
  };
}

function followUpInput(dataFlash, generated) {
  const reaction = generated?.reaction;
  const start = canonicalInstant(reaction?.window?.start ?? generated?.event?.releasedAt, dataFlash.event.occurredAt);
  let end = canonicalInstant(reaction?.window?.end ?? generated?.generatedAt, generated?.generatedAt ?? dataFlash.event.occurredAt);
  if (new Date(end) <= new Date(start)) end = new Date(new Date(start).getTime() + 15 * 60_000).toISOString();
  const changes = Object.entries(reaction?.prices ?? {}).map(([symbol, value]) => `${symbol} ${Number(value?.changePercent) >= 0 ? "+" : ""}${value?.changePercent}%`).join(", ");
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
  };
}

export function buildContentProductInputs(jobId, generated, options = {}) {
  const primary = baseInput(jobId, generated, options);
  if (jobId !== "data-release-updates" || !generated?.reaction) return [primary];
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
