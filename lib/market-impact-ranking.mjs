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
  const systemicEvent = /\b(?:systemic|bankruptcy|liquidation cascade|short (?:squeeze|liquidations?)|broad (?:short )?liquidations?|stablecoin depeg)\b/.test(value);
  const macroContext = /\b(?:fomc|federal funds|interest rates?|policy rates?|rate path|rate (?:decision|cut|hike)|quantitative (?:easing|tightening)|balance sheet|treasury (?:buyback|issuance|refunding)|global liquidity|dollar liquidity|reserve balances?|repo (?:facility|market)|yield curve)\b/.test(value);
  const cryptoMarketContext = /\b(?:bitcoin|btc|ethereum|eth|crypto|digital assets?|stablecoin|token|blockchain|defi|spot etf|exchange-traded fund|market structure|derivatives?|futures?)\b/.test(value);
  const policyAction = /\b(?:regulat(?:e|es|ed|ing|ion|ions|or|ors|ory)|enforcement|approv(?:al|e|es|ed)|guidance|legislation|rulemaking|rules?|policy framework|court ruling)\b/.test(value);
  const regulatoryAction = /\b(?:regulat(?:e|es|ed|ing|ion|ions|or|ors|ory)|enforcement|guidance|legislation|rulemaking|rules?|policy framework|court ruling)\b/.test(value);
  if (systemicEvent || macroContext) return 1;
  if (official && cryptoMarketContext && policyAction) return 1;
  if (cryptoMarketContext && regulatoryAction) return 0.7;
  return 0;
}

function flowSignal(story) {
  if (Number.isFinite(Number(story?.capitalFlowScore))) return clamp01(story.capitalFlowScore);
  const value = corpus(story);
  const millionAmounts = [...value.matchAll(/(?:\$\s*)?(\d+(?:\.\d+)?)\s*(?:m\b|mn\b|million\b)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  if (/\b(?:billion|bn)\b|\$\s?\d+(?:\.\d+)?b\b|record (?:inflow|outflow)|broad liquidation/.test(value)
    || millionAmounts.some((amount) => amount >= 250)) return 1;
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
  if (hours <= 24) return 0.5;
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

function tierOneRelease(event) {
  const value = [event?.indicator, event?.id, event?.title, event?.name]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const fomcRelease = !/\b(?:preview|expectations?|watch|ahead of|what to expect|analysis)\b/.test(value)
    && /\bfomc\s+(?:(?:rate|policy)[-\s]+)?(?:decision|statement)\b/.test(value);
  return /\b(?:core\s+)?cpi\b/.test(value)
    || /\b(?:core\s+)?pce\b/.test(value)
    || /\b(?:nonfarm\s+payrolls?|nfp)\b/.test(value)
    || /\bunemployment(?:\s+rate)?\b/.test(value)
    || fomcRelease
    || /\bgdp\b/.test(value);
}

export function classifyDataReleaseTier(event = {}, ranking = {}) {
  const score = Number(ranking?.score);
  const normalizedScore = Number.isFinite(score) ? score : 0;
  const reasons = Array.isArray(ranking?.reasons)
    ? ranking.reasons.filter((reason) => typeof reason === "string" && reason.trim())
    : [];
  const promotionThreshold = Number.isFinite(Number(ranking?.promotionThreshold))
    ? Number(ranking.promotionThreshold)
    : 70;
  const decision = String(ranking?.decision ?? "");
  if (tierOneRelease(event)) {
    if (decision === "demoted" && reasons.length > 0) return { tier: "secondary", decision: "demoted", score: normalizedScore, reasons };
    return { tier: "tier-one", decision: "tier-one", score: normalizedScore, reasons };
  }
  if (decision === "promoted" && normalizedScore >= promotionThreshold && reasons.length > 0) {
    return { tier: "tier-one", decision: "promoted", score: normalizedScore, reasons };
  }
  return { tier: "secondary", decision: "not-promoted", score: normalizedScore, reasons };
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
