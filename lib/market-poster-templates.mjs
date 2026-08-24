const PORTRAIT_CANVAS = Object.freeze({ width: 1080, height: 1350 });

const TEMPLATES = Object.freeze({
  "daily-market-brief": Object.freeze({
    id: "daily-market-brief-v3",
    product: "daily-market-brief",
    file: "01-daily-market-brief-v3.png",
    auto: true,
  }),
  "data-flash": Object.freeze({
    id: "data-flash-v3",
    product: "data-flash",
    file: "02-data-flash-v3.png",
    auto: true,
  }),
  "market-follow-up": Object.freeze({
    id: "market-follow-up-v3",
    product: "market-follow-up",
    file: "03-market-follow-up-v3.png",
    auto: true,
  }),
  "weekly-catalysts": Object.freeze({
    id: "weekly-catalysts-v3",
    product: "weekly-catalyst-calendar",
    file: "04-weekly-catalysts-v3.png",
    auto: true,
  }),
  "etf-flow-update": Object.freeze({ id: "etf-flow-update-v3", product: "specialist", file: "05-etf-flow-update-v3.png", auto: false }),
  "policy-alert": Object.freeze({ id: "policy-alert-v3", product: "specialist", file: "06-policy-alert-v3.png", auto: false }),
  "market-alert": Object.freeze({ id: "market-alert-v3", product: "specialist", file: "07-market-alert-v3.png", auto: false }),
});

function usable(value) {
  const text = String(value ?? "").trim();
  return Boolean(text && !["—", "N/A", "NOT AVAILABLE", "TBD"].includes(text.toUpperCase()));
}

function template(key, reason) {
  const item = TEMPLATES[key];
  return Object.freeze({
    ...item,
    canvas: { ...PORTRAIT_CANVAS },
    assetPath: `/templates/market-intelligence/${item.file}`,
    version: 3,
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
  return Object.values(TEMPLATES).map((item) => ({ ...item, canvas: { ...PORTRAIT_CANVAS } }));
}

export function marketPosterCanvas(model) {
  const canvas = model?.visualTemplate?.canvas;
  return canvas?.width === PORTRAIT_CANVAS.width && canvas?.height === PORTRAIT_CANVAS.height
    ? { ...PORTRAIT_CANVAS }
    : { width: 1200, height: 675 };
}
