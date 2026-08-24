const PORTRAIT_CANVAS = Object.freeze({ width: 1080, height: 1350 });
const LANDSCAPE_CANVAS = Object.freeze({ width: 1200, height: 675 });

const TEMPLATES = Object.freeze({
  "daily-market-brief": Object.freeze({
    id: "daily-market-brief-v4",
    product: "daily-market-brief",
    generated: true,
    version: 4,
    canvas: LANDSCAPE_CANVAS,
    auto: true,
  }),
  "data-flash": Object.freeze({
    id: "data-flash-v4",
    product: "data-flash",
    generated: true,
    version: 4,
    canvas: LANDSCAPE_CANVAS,
    auto: true,
  }),
  "market-follow-up": Object.freeze({
    id: "market-follow-up-v4",
    product: "market-follow-up",
    generated: true,
    version: 4,
    canvas: LANDSCAPE_CANVAS,
    auto: true,
  }),
  "weekly-catalysts": Object.freeze({
    id: "weekly-catalysts-v4",
    product: "weekly-catalyst-calendar",
    timeScope: "single-utc-week",
    generated: true,
    version: 4,
    canvas: LANDSCAPE_CANVAS,
    auto: true,
  }),
  "etf-flow-update": Object.freeze({ id: "etf-flow-update-v3", product: "specialist", file: "05-etf-flow-update-v3.png", version: 3, canvas: PORTRAIT_CANVAS, auto: false }),
  "policy-alert": Object.freeze({ id: "policy-alert-v3", product: "specialist", file: "06-policy-alert-v3.png", version: 3, canvas: PORTRAIT_CANVAS, auto: false }),
  "market-alert": Object.freeze({ id: "market-alert-v3", product: "specialist", file: "07-market-alert-v3.png", version: 3, canvas: PORTRAIT_CANVAS, auto: false }),
});

function usable(value) {
  const text = String(value ?? "").trim();
  return Boolean(text && !["—", "N/A", "NOT AVAILABLE", "TBD"].includes(text.toUpperCase()));
}

function template(key, reason) {
  const item = TEMPLATES[key];
  return Object.freeze({
    ...item,
    canvas: { ...item.canvas },
    assetPath: item.file ? `/templates/market-intelligence/${item.file}` : null,
    selectionReason: reason,
  });
}

export function selectMarketPosterTemplate({ jobId, poster, reaction } = {}) {
  if (!poster || typeof poster !== "object") return null;
  if (jobId === "crypto-daily") {
    return Array.isArray(poster.stories) && poster.stories.some((story) => usable(story?.title) && usable(story?.source))
      ? template("daily-market-brief", "verified-ranked-stories") : null;
  }
  if (jobId === "weekly-calendar") {
    const events = (Array.isArray(poster.columns) ? poster.columns : []).flatMap((column) => column?.events ?? []);
    return events.some((event) => usable(event?.title) && usable(event?.source))
      ? template("weekly-catalysts", "verified-calendar-events") : null;
  }
  if (jobId === "data-release-updates") {
    if (!usable(poster.actual) || !usable(poster.source || poster.officialSource)) return null;
    const hasReaction = Array.isArray(poster.reactions) && poster.reactions.length > 0
      && (reaction || poster.reactionWindow);
    return hasReaction
      ? template("market-follow-up", "measured-cross-asset-reaction")
      : template("data-flash", "verified-official-release");
  }
  return null;
}

export function approvedMarketPosterTemplates() {
  return Object.values(TEMPLATES).map((item) => ({ ...item, canvas: { ...item.canvas } }));
}

export function marketPosterCanvas(model) {
  const canvas = model?.visualTemplate?.canvas;
  if (canvas?.width === PORTRAIT_CANVAS.width && canvas?.height === PORTRAIT_CANVAS.height) return { ...PORTRAIT_CANVAS };
  return { ...LANDSCAPE_CANVAS };
}
