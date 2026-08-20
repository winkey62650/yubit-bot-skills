const WEIGHTS = Object.freeze({
  marketReaction: 35,
  policySystemic: 25,
  capitalFlow: 20,
  corroboration: 10,
  recency: 10,
});

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

function corpus(story) {
  return [story?.title, story?.summary, story?.rationale, ...(story?.categories ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function reactionSignal(story) {
  const explicit = story?.marketReaction?.magnitudeScore ?? story?.reactionScore;
  if (Number.isFinite(Number(explicit))) return clamp01(explicit);
  const changes = Object.values(story?.marketReaction ?? story?.reaction ?? {})
    .map((item) => Math.abs(Number(item?.changePercent ?? item?.priceChangePct)))
    .filter(Number.isFinite);
  if (!changes.length) return 0;
  return clamp01(Math.max(...changes) / 5);
}

function policySignal(story) {
  if (Number.isFinite(Number(story?.policySystemicScore))) return clamp01(story.policySystemicScore);
  const value = corpus(story);
  const sourceIdentity = `${story?.source?.url ?? ""} ${story?.source?.id ?? ""} ${story?.source?.kind ?? ""}`;
  const official = /(?:\.gov\b|\bsec\b|\bcftc\b|federal reserve|\bfomc\b)/i.test(
    sourceIdentity,
  );
  if (/systemic|bankruptcy|liquidation cascade|stablecoin depeg|rate decision|court ruling/.test(value)) return 1;
  if (official && /regulat|enforcement|approval|guidance|policy|rate|legislation/.test(value)) return 1;
  return official ? 0.55 : 0;
}

function flowSignal(story) {
  if (Number.isFinite(Number(story?.capitalFlowScore))) return clamp01(story.capitalFlowScore);
  const value = corpus(story);
  if (/\b(?:billion|bn)\b|\$\s?\d+(?:\.\d+)?b\b|record (?:inflow|outflow)|broad liquidation/.test(value)) return 1;
  if (/\b(?:million|mn)\b|\$\s?\d+(?:\.\d+)?m\b|inflow|outflow|open interest|volume/.test(value)) return 0.65;
  return 0;
}

function corroborationSignal(story) {
  const count = Math.max(1, Number(story?.sourceConfirmations ?? story?.confirmations?.length ?? 1) || 1);
  return count >= 3 ? 1 : count === 2 ? 0.5 : 0;
}

function recencySignal(story, now) {
  const publishedAt = Date.parse(story?.publishedAt);
  const nowMs = new Date(now ?? Date.now()).getTime();
  if (!Number.isFinite(publishedAt) || !Number.isFinite(nowMs)) return 0;
  const hours = Math.max(0, nowMs - publishedAt) / 3_600_000;
  if (hours <= 6) return 1;
  if (hours <= 12) return 0.75;
  if (hours <= 24) return 0.4;
  return 0;
}

export function scoreMarketImpact(story, now = new Date()) {
  const signals = {
    marketReaction: reactionSignal(story),
    policySystemic: policySignal(story),
    capitalFlow: flowSignal(story),
    corroboration: corroborationSignal(story),
    recency: recencySignal(story, now),
  };
  const components = Object.fromEntries(
    Object.entries(WEIGHTS).map(([key, weight]) => [key, Math.round(signals[key] * weight * 10) / 10]),
  );
  const calculated = Object.values(components).reduce((sum, value) => sum + value, 0);
  const explicit = Number(story?.impactScore);
  const score = Number.isFinite(explicit) ? Math.min(100, Math.max(0, explicit)) : calculated;
  const reasons = Object.entries(components)
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([key]) => key);
  return { score: Math.round(score * 10) / 10, components, reasons };
}

export function selectMarketImpactStories(stories, now = new Date(), {
  coreCount = 3,
  maxCount = 5,
  watchThreshold = 50,
} = {}) {
  return (Array.isArray(stories) ? stories : [])
    .map((story) => ({ ...story, marketImpact: scoreMarketImpact(story, now) }))
    .sort((left, right) => (
      right.marketImpact.score - left.marketImpact.score
      || (Date.parse(right.publishedAt) || 0) - (Date.parse(left.publishedAt) || 0)
      || String(left.id ?? left.title ?? "").localeCompare(String(right.id ?? right.title ?? ""), "en")
    ))
    .filter((story, index) => index < coreCount || story.marketImpact.score >= watchThreshold)
    .slice(0, maxCount)
    .map((story, index) => ({ ...story, selectionTier: index < coreCount ? "core" : "watch" }));
}
