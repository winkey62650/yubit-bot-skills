const PORTRAIT_CANVAS = Object.freeze({ width: 1080, height: 1350 });
const LANDSCAPE_CANVAS = Object.freeze({ width: 1200, height: 675 });

const TEMPLATES = Object.freeze({
  "daily-market-brief": Object.freeze({
    id: "daily-market-brief-v4",
    product: "daily-market-brief",
    file: "01-daily-market-brief-wide-v4.png",
    sha256: "8a378c4a4bcab99b92b005c383eae9fb483f8c6df36c1623f98d97f3b67c38ec",
    composition: "locked-master-fixed-field-overlay",
    version: 4,
    canvas: LANDSCAPE_CANVAS,
    auto: true,
  }),
  "data-flash": Object.freeze({
    id: "data-flash-v4",
    product: "data-flash",
    file: "02-data-flash-wide-v4.png",
    sha256: "85c3a05946f3f1b1b0071d85ad25e97c65c8acaa8198d97f6af09a8b6b6d1d57",
    composition: "locked-master-fixed-field-overlay",
    version: 4,
    canvas: LANDSCAPE_CANVAS,
    auto: true,
  }),
  "market-follow-up": Object.freeze({
    id: "market-follow-up-v4",
    product: "market-follow-up",
    file: "03-market-follow-up-wide-v4.png",
    sha256: "1d78546f6a9d10837550ebe78a938fafe7cdb1f1c7b33def61661550a05dca6e",
    composition: "locked-master-fixed-field-overlay",
    version: 4,
    canvas: LANDSCAPE_CANVAS,
    auto: true,
  }),
  "weekly-catalysts": Object.freeze({
    id: "weekly-catalysts-v4",
    product: "weekly-catalyst-calendar",
    timeScope: "single-utc-week",
    file: "04-weekly-catalysts-wide-v4.png",
    sha256: "bed57b795a96890772c4b27a5c3880d1bf7f360e82921011bc5431c76073b2b4",
    composition: "locked-master-fixed-field-overlay",
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
