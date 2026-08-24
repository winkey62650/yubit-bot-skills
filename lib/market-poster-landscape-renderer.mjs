const COLORS = Object.freeze({
  ink: "#08224A",
  blue: "#0757A6",
  muted: "#59749A",
  gold: "#C98A17",
  green: "#14873A",
  red: "#D92C32",
  panel: "#F9FBFD",
  dark: "#052B56",
});

const EMPTY_UPDATE = "NO MATERIAL VERIFIED UPDATE";

function usable(value) {
  const text = String(value ?? "").trim();
  return Boolean(text && !["—", "-", "N/A", "NOT AVAILABLE", "TBD", "NULL"].includes(text.toUpperCase()));
}

function clean(value, fallback = "", max = 120) {
  const text = usable(value) ? String(value).replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim() : fallback;
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trim()}…` : text;
}

function statusColor(value) {
  const normalized = String(value ?? "").toUpperCase();
  if (/^[−-]/.test(normalized)) return COLORS.red;
  if (/^\+/.test(normalized)) return COLORS.green;
  if (/(BULL|POSITIVE|CONFIRMED|FIRM|UP|HIGH)/.test(normalized)) return COLORS.green;
  if (/(BEAR|NEGATIVE|DIVERGENT|SOFT|DOWN|RISK)/.test(normalized)) return COLORS.red;
  return COLORS.gold;
}

function masterCanvas(masterArtwork, label) {
  if (!String(masterArtwork || "").startsWith("data:image/png;base64,")) {
    throw new Error("The locked VIP Wide Dense V4 master artwork is required.");
  }
  return {
    "aria-label": `${label} poster`,
    style: {
      position: "relative",
      width: "100%",
      height: "100%",
      display: "flex",
      overflow: "hidden",
      color: COLORS.ink,
      backgroundImage: `url(${masterArtwork})`,
      backgroundSize: "1200px 675px",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
      fontFamily: "Arial, sans-serif",
    },
  };
}

function field(e, key, value, rect, options = {}) {
  return e("div", {
    key,
    "data-dynamic-field": key,
    style: {
      position: "absolute",
      left: rect.x,
      top: rect.y,
      width: rect.w,
      height: rect.h,
      display: "flex",
      alignItems: options.align || "center",
      justifyContent: options.justify || "flex-start",
      overflow: "hidden",
      padding: options.padding || "0 5px",
      color: options.color || COLORS.ink,
      backgroundColor: options.background || COLORS.panel,
      borderRadius: options.radius ?? 2,
      fontSize: options.size || 14,
      lineHeight: options.lineHeight || 1.15,
      fontWeight: options.weight || 800,
      letterSpacing: options.letterSpacing || 0,
      textAlign: options.textAlign || "left",
      boxSizing: "border-box",
    },
  }, clean(value, options.fallback || "", options.max || 100));
}

function fixedSlots(values, length, fallbackFactory) {
  return Array.from({ length }, (_, index) => values[index] || fallbackFactory(index));
}

function sourceLine(model) {
  return (model?.footer?.sources || []).filter(usable).slice(0, 2).join(" / ") || "VERIFIED MARKET INPUTS";
}

function singleWeekLabel(value) {
  const input = clean(value, "THIS WEEK", 40);
  const match = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return input.toUpperCase();
  const start = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const end = new Date(start.getTime() + 4 * 24 * 60 * 60 * 1000);
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const startMonth = months[start.getUTCMonth()];
  const endMonth = months[end.getUTCMonth()];
  const startPart = startMonth === endMonth ? String(start.getUTCDate()).padStart(2, "0") : `${String(start.getUTCDate()).padStart(2, "0")} ${startMonth}`;
  return `${startPart}–${String(end.getUTCDate()).padStart(2, "0")} ${endMonth} ${end.getUTCFullYear()}`;
}

function firstAffected(value, fallback = "MARKET") {
  return clean(value, fallback, 42).toUpperCase().split(/\s*[·,/]\s*|\s+/).filter(Boolean)[0] || fallback;
}

function daily(e, model, masterArtwork) {
  const stories = fixedSlots(
    (Array.isArray(model.stories) ? model.stories : []).filter((story) => usable(story?.title)).slice(0, 3),
    3,
    (index) => ({ rank: `0${index + 1}`, title: EMPTY_UPDATE, thesis: "No additional verified development met the publication threshold.", impact: "NEUTRAL", affected: "MARKET", score: "—", source: "VERIFIED INPUTS" }),
  );
  const xs = [35, 424, 813];
  const items = [
    field(e, "daily-date", `DATE · ${clean(model.date, "UTC", 26).replace(/UTC/gi, "").replace(/·/g, "").trim()}`, { x: 56, y: 174, w: 202, h: 31 }, { background: COLORS.dark, color: "#FFFFFF", size: 14, max: 28 }),
    field(e, "daily-time", `UTC · ${clean(model.footer?.updatedAt, "UTC", 28).match(/T(\d{2}:\d{2})/)?.[1] || "UTC"}`, { x: 275, y: 174, w: 170, h: 31 }, { background: COLORS.dark, color: "#FFFFFF", size: 14, max: 16 }),
    field(e, "daily-bias-mask", "", { x: 596, y: 178, w: 146, h: 29 }, { background: "#174984", size: 1, radius: 12 }),
    field(e, "daily-bias", `${firstAffected(stories[0].affected, "BTC")} · ${clean(model.primaryBias, stories[0].impact || "NEUTRAL", 12).toUpperCase()}`, { x: 596, y: 178, w: 146, h: 29 }, { background: "#174984", color: "#FFFFFF", size: 13, justify: "center", radius: 12, max: 24 }),
    field(e, "daily-watch-mask", "", { x: 792, y: 178, w: 146, h: 29 }, { background: "#1F5E9C", size: 1, radius: 12 }),
    field(e, "daily-watch", `${firstAffected(stories[1].affected, "ETH")} · ${clean(stories[1].impact, "WATCH", 12).toUpperCase()}`, { x: 792, y: 178, w: 146, h: 29 }, { background: "#1F5E9C", color: "#FFFFFF", size: 13, justify: "center", radius: 12, max: 24 }),
    field(e, "daily-market-mask", "", { x: 986, y: 178, w: 157, h: 29 }, { background: "#5090CD", size: 1, radius: 12 }),
    field(e, "daily-market", `MARKET · ${clean(model.primaryBias, "MIXED", 12).toUpperCase()}`, { x: 986, y: 178, w: 157, h: 29 }, { background: "#5090CD", color: "#FFFFFF", size: 13, justify: "center", radius: 12, max: 26 }),
  ];

  stories.forEach((story, index) => {
    const x = xs[index];
    items.push(
      field(e, `daily-${index + 1}-category`, clean(story.source, "VERIFIED INPUT", 28).toUpperCase(), { x: x + 58, y: 244, w: 225, h: 25 }, { size: 14, letterSpacing: 1.1, max: 28 }),
      field(e, `daily-${index + 1}-title`, clean(story.title, EMPTY_UPDATE, 52).toUpperCase(), { x, y: 281, w: 272, h: 42 }, { size: 22, lineHeight: 1.02, weight: 900, align: "flex-start", padding: "2px 5px", max: 52 }),
      field(e, `daily-${index + 1}-thesis`, story.thesis, { x, y: 326, w: 265, h: 58 }, { fallback: "Verified context remains subject to confirmation.", size: 12, lineHeight: 1.32, weight: 600, color: COLORS.ink, align: "flex-start", padding: "3px 5px", max: 108 }),
      field(e, `daily-${index + 1}-impact`, `IMPACT · ${clean(story.impact, "NEUTRAL", 14).toUpperCase()}`, { x: x + 8, y: 479, w: 190, h: 29 }, { color: statusColor(story.impact), size: 12, letterSpacing: .6, max: 24 }),
      field(e, `daily-${index + 1}-status`, index === 0 ? `CONFIDENCE · ${Number(story.score) >= 75 ? "HIGH" : "MEDIUM"}` : index === 1 ? "STATUS · MONITOR" : "RISK · MODERATE", { x: x + 181, y: 479, w: 170, h: 29 }, { color: COLORS.gold, size: 12, letterSpacing: .45, max: 28 }),
    );
  });

  items.push(
    field(e, "daily-read", stories[0].thesis, { x: 136, y: 559, w: 420, h: 48 }, { fallback: "Verified evidence must align before conviction rises.", size: 16, lineHeight: 1.22, weight: 650, align: "flex-start", padding: "2px 4px", max: 105 }),
    field(e, "daily-watch-1-mask", "", { x: 661, y: 565, w: 124, h: 30 }, { size: 1 }),
    field(e, "daily-watch-2-mask", "", { x: 827, y: 565, w: 139, h: 30 }, { size: 1 }),
    field(e, "daily-watch-3-mask", "", { x: 1007, y: 565, w: 137, h: 30 }, { size: 1 }),
    ...stories.map((story, index) => field(e, `daily-watch-${index + 1}`, firstAffected(story.affected), { x: [665, 841, 1014][index], y: 565, w: [120, 125, 130][index], h: 30 }, { size: 14, max: 18 })),
    field(e, "daily-source", `SOURCE · ${sourceLine(model)}`, { x: 74, y: 629, w: 310, h: 26 }, { size: 12, color: COLORS.muted, max: 44 }),
  );

  return e("div", masterCanvas(masterArtwork, "DAILY MARKET BRIEF"), ...items);
}

function weekly(e, model, masterArtwork) {
  const rawColumns = (Array.isArray(model.columns) ? model.columns : []).slice(0, 5);
  const columns = fixedSlots(rawColumns, 5, (index) => ({ label: ["MON", "TUE", "WED", "THU", "FRI"][index], events: [] }));
  const xs = [31, 268, 505, 735, 974];
  const items = [
    field(e, "weekly-range", `WEEK · ${singleWeekLabel(model.weekStart)}`, { x: 60, y: 153, w: 214, h: 34 }, { background: COLORS.dark, color: "#FFFFFF", size: 14, max: 34 }),
  ];

  columns.forEach((column, index) => {
    const event = (Array.isArray(column.events) ? column.events : []).find((item) => usable(item?.title)) || {};
    const parts = clean(column.label || column.date, ["MON", "TUE", "WED", "THU", "FRI"][index], 18).toUpperCase().split(/\s+/);
    const day = parts[0] || ["MON", "TUE", "WED", "THU", "FRI"][index];
    const date = parts.find((part) => /^\d{1,2}$/.test(part)) || String(index + 1).padStart(2, "0");
    const hasEvent = usable(event.title);
    const impact = hasEvent ? (Number(event.importance) >= 3 || event.isPriority ? "HIGH" : "MEDIUM") : "CLEAR";
    items.push(
      field(e, `weekly-${index + 1}-day`, day, { x: xs[index], y: 225, w: 66, h: 31 }, { background: "#C98A17", color: "#FFFFFF", size: 18, justify: "center", radius: 4, max: 5 }),
      field(e, `weekly-${index + 1}-date`, date, { x: xs[index] + 92, y: 225, w: 55, h: 31 }, { size: 24, color: COLORS.gold, justify: "center", max: 2 }),
      field(e, `weekly-${index + 1}-event`, hasEvent ? `${clean(event.time, "TIME", 8)} · ${clean(event.title, "VERIFIED EVENT", 38)}` : EMPTY_UPDATE, { x: xs[index] - 5, y: 261, w: 207, h: 34 }, { size: hasEvent ? 12 : 10, lineHeight: 1.12, align: "flex-start", padding: "3px 9px", max: 48 }),
      field(e, `weekly-${index + 1}-impact`, `IMPACT · ${impact}`, { x: xs[index], y: 294, w: 202, h: 38 }, { color: statusColor(impact), size: 12, max: 24 }),
      field(e, `weekly-${index + 1}-markets`, `MARKETS · ${clean(event.markets || event.affected, "MARKET", 25).toUpperCase()}`, { x: xs[index], y: 327, w: 202, h: 31 }, { size: 11, max: 34 }),
      field(e, `weekly-${index + 1}-status`, `STATUS · ${hasEvent ? (Number(event.importance) >= 3 || event.isPriority ? "FOCUS" : "MONITOR") : "CLEAR"}`, { x: xs[index] + 31, y: 505, w: 151, h: 27 }, { size: 13, color: hasEvent ? COLORS.blue : COLORS.muted, max: 24 }),
    );
  });

  const events = columns.flatMap((column) => column.events || []).filter((event) => usable(event?.title));
  const priority = events.find((event) => Number(event.importance) >= 3 || event.isPriority) || events[0];
  items.push(
    field(e, "weekly-key-risk", priority?.sensitivity, { x: 118, y: 570, w: 450, h: 38 }, { fallback: "No material verified catalyst currently changes the weekly risk map.", size: 14, lineHeight: 1.22, weight: 650, max: 100 }),
    field(e, "weekly-plan-1-mask", "", { x: 680, y: 570, w: 112, h: 30 }, { size: 1 }),
    field(e, "weekly-plan-2-mask", "", { x: 846, y: 570, w: 132, h: 30 }, { size: 1 }),
    field(e, "weekly-plan-3-mask", "", { x: 1030, y: 570, w: 131, h: 30 }, { size: 1 }),
    field(e, "weekly-plan-1", "PREP LEVELS", { x: 692, y: 570, w: 100, h: 30 }, { size: 13, max: 18 }),
    field(e, "weekly-plan-2", "VERIFY RELEASE", { x: 854, y: 570, w: 124, h: 30 }, { size: 12, max: 20 }),
    field(e, "weekly-plan-3", "TRACK REACTION", { x: 1038, y: 570, w: 123, h: 30 }, { size: 12, max: 20 }),
    field(e, "weekly-source", `SOURCE · ${sourceLine(model)}`, { x: 73, y: 628, w: 330, h: 27 }, { size: 12, color: COLORS.muted, max: 48 }),
  );
  return e("div", masterCanvas(masterArtwork, "WEEKLY CATALYSTS"), ...items);
}

function reactionFallback(index, symbols = ["BTC", "DXY", "NASDAQ", "US 2Y"]) {
  return { symbol: symbols[index], label: "PENDING", value: null };
}

function dataFlash(e, model, masterArtwork) {
  const reactions = fixedSlots((Array.isArray(model.reactions) ? model.reactions : []).slice(0, 4), 4, reactionFallback);
  const impact = clean(model.impact, "NEUTRAL", 16).toUpperCase();
  const items = [
    field(e, "flash-release", `RELEASE · ${clean(model.releaseTime || model.time, "UTC", 14)}`, { x: 57, y: 151, w: 204, h: 34 }, { background: COLORS.dark, color: "#FFFFFF", size: 14, max: 28 }),
    field(e, "flash-status", `STATUS · ${usable(model.actual) ? "VERIFIED" : "PENDING"}`, { x: 302, y: 151, w: 193, h: 34 }, { background: COLORS.dark, color: usable(model.actual) ? "#22D255" : "#FFFFFF", size: 14, max: 24 }),
    field(e, "flash-indicator", clean(model.indicator, "OFFICIAL RELEASE", 34).toUpperCase(), { x: 156, y: 215, w: 480, h: 35 }, { size: 25, weight: 900, justify: "center", max: 34 }),
    field(e, "flash-subtitle", clean(model.title, "VERIFIED RELEASE SNAPSHOT", 52).toUpperCase(), { x: 165, y: 251, w: 465, h: 25 }, { size: 14, color: COLORS.blue, justify: "center", max: 52 }),
    field(e, "flash-actual", clean(model.actual, "PENDING", 16), { x: 45, y: 314, w: 174, h: 70 }, { size: 48, color: COLORS.green, justify: "center", max: 16 }),
    field(e, "flash-forecast", clean(model.forecast, "NOT PUBLISHED", 16), { x: 232, y: 314, w: 194, h: 70 }, { size: usable(model.forecast) ? 48 : 16, justify: "center", max: 16 }),
    field(e, "flash-previous", clean(model.previous, "NOT PUBLISHED", 16), { x: 446, y: 314, w: 193, h: 70 }, { size: usable(model.previous) ? 48 : 16, justify: "center", max: 16 }),
    field(e, "flash-surprise", `SURPRISE · ${clean(model.surprise, "NOT PUBLISHED", 18).toUpperCase()}`, { x: 93, y: 400, w: 230, h: 25 }, { size: 13, color: statusColor(impact), justify: "center", max: 30 }),
    field(e, "flash-revision", `REVISION · ${clean(model.revision, "NOT PUBLISHED", 18).toUpperCase()}`, { x: 387, y: 400, w: 230, h: 25 }, { size: 13, color: COLORS.gold, justify: "center", max: 30 }),
  ];

  reactions.forEach((reaction, index) => {
    const y = 240 + index * 40;
    const available = usable(reaction?.label) && reaction.label.toUpperCase() !== "PENDING";
    items.push(
      field(e, `flash-reaction-${index + 1}-symbol`, clean(reaction.symbol, reactionFallback(index).symbol, 10).toUpperCase(), { x: 731, y, w: 72, h: 28 }, { size: 14, max: 10 }),
      field(e, `flash-reaction-${index + 1}-mask`, "", { x: 812, y: y - 2, w: 360, h: 34 }, { size: 1 }),
      field(e, `flash-reaction-${index + 1}-observation`, available ? "VERIFIED WINDOW" : "AWAITING VERIFIED REACTION", { x: 818, y: y - 2, w: 192, h: 34 }, { size: 10, color: COLORS.muted, justify: "center", max: 28 }),
      field(e, `flash-reaction-${index + 1}-value`, available ? reaction.label : "PENDING", { x: 1012, y: y - 2, w: 80, h: 34 }, { size: 16, color: available ? statusColor(reaction.label) : COLORS.muted, justify: "center", max: 12 }),
      field(e, `flash-reaction-${index + 1}-status`, available ? clean(reaction.status, "OBSERVED", 12).toUpperCase() : "WAIT", { x: 1103, y: y - 2, w: 69, h: 34 }, { size: 12, color: available ? statusColor(reaction.label) : COLORS.muted, justify: "center", max: 12 }),
    );
  });

  items.push(
    field(e, "flash-release-time", clean(model.releaseTime || model.time, "UTC", 14), { x: 329, y: 470, w: 95, h: 38 }, { size: 14, justify: "center", max: 18 }),
    field(e, "flash-yoy-comparison-mask", "", { x: 430, y: 451, w: 219, h: 61 }, { size: 1 }),
    field(e, "flash-yoy-actual", clean(model.actual, "PENDING", 12), { x: 440, y: 459, w: 59, h: 40 }, { size: 18, color: COLORS.green, justify: "center", max: 12 }),
    field(e, "flash-yoy-forecast", clean(model.forecast, "—", 12), { x: 515, y: 459, w: 59, h: 40 }, { size: 18, color: COLORS.ink, justify: "center", max: 12 }),
    field(e, "flash-yoy-previous", clean(model.previous, "—", 12), { x: 590, y: 459, w: 59, h: 40 }, { size: 18, color: COLORS.blue, justify: "center", max: 12 }),
    field(e, "flash-desk-view", model.verdict || model.title, { x: 698, y: 444, w: 365, h: 58 }, { fallback: `${impact} initial read; cross-asset confirmation remains necessary.`, size: 15, lineHeight: 1.24, weight: 650, align: "flex-start", max: 118 }),
    field(e, "flash-bias", `BIAS · ${impact}`, { x: 698, y: 513, w: 137, h: 27 }, { size: 12, color: statusColor(impact), max: 24 }),
    field(e, "flash-horizon", "HORIZON · 1–3D", { x: 854, y: 513, w: 145, h: 27 }, { size: 12, color: COLORS.blue, max: 22 }),
    field(e, "flash-confidence", `CONFIDENCE · ${usable(model.actual) ? "HIGH" : "LOW"}`, { x: 1014, y: 513, w: 154, h: 27 }, { size: 12, color: COLORS.green, max: 24 }),
    field(e, "flash-watch-1-mask", "", { x: 321, y: 575, w: 167, h: 30 }, { size: 1 }),
    field(e, "flash-watch-2-mask", "", { x: 580, y: 575, w: 220, h: 30 }, { size: 1 }),
    field(e, "flash-watch-3-mask", "", { x: 909, y: 575, w: 225, h: 30 }, { size: 1 }),
    field(e, "flash-watch-1", "RATE PRICING", { x: 321, y: 575, w: 167, h: 30 }, { size: 13, justify: "center", max: 20 }),
    field(e, "flash-watch-2", "DOLLAR FOLLOW-THROUGH", { x: 580, y: 575, w: 220, h: 30 }, { size: 13, justify: "center", max: 24 }),
    field(e, "flash-watch-3", `${firstAffected(model.affected, "BTC")} CONFIRMATION`, { x: 909, y: 575, w: 225, h: 30 }, { size: 13, justify: "center", max: 24 }),
    field(e, "flash-source", `SOURCE · ${clean(model.source || model.officialSource, sourceLine(model), 36)}`, { x: 70, y: 628, w: 330, h: 27 }, { size: 12, color: COLORS.muted, max: 48 }),
  );
  return e("div", masterCanvas(masterArtwork, "DATA FLASH"), ...items);
}

function followUp(e, model, masterArtwork) {
  const reactions = fixedSlots((Array.isArray(model.reactions) ? model.reactions : []).slice(0, 4), 4, (index) => reactionFallback(index, ["BTC", "ETH", "DXY", "NASDAQ"]));
  const status = clean(model.tapeStatus || model.verdictStatus, "MONITOR", 24).toUpperCase();
  const checkpoint = clean(model.reactionWindow?.label, "OBSERVED WINDOW · UTC", 30).replace(/\s*[·|]\s*\d+\s*MIN(?:UTES?)?\s*$/i, "");
  const items = [
    field(e, "follow-checkpoint", `CHECKPOINT · ${checkpoint}`, { x: 61, y: 137, w: 255, h: 36 }, { background: COLORS.dark, color: "#FFFFFF", size: 12, max: 36 }),
    field(e, "follow-updated", `UPDATED · ${clean(model.footer?.updatedAt, "UTC", 28).replace("T", " ").replace(/\.000Z$/, " UTC")}`, { x: 299, y: 137, w: 321, h: 36 }, { background: COLORS.dark, color: "#FFFFFF", size: 12, max: 40 }),
  ];

  reactions.forEach((reaction, index) => {
    const y = 236 + index * 48;
    const available = usable(reaction?.label) && reaction.label.toUpperCase() !== "PENDING";
    items.push(
      field(e, `follow-reaction-${index + 1}-symbol`, clean(reaction.symbol, reactionFallback(index).symbol, 10).toUpperCase(), { x: 81, y, w: 75, h: 30 }, { size: 15, max: 10 }),
      field(e, `follow-reaction-${index + 1}-value`, available ? reaction.label : "PENDING", { x: 169, y, w: 72, h: 30 }, { size: available ? 17 : 11, color: available ? statusColor(reaction.label) : COLORS.muted, justify: "center", max: 12 }),
      field(e, `follow-reaction-${index + 1}-status`, available ? clean(reaction.status, "OBSERVED", 12).toUpperCase() : "AWAITING", { x: 248, y, w: 88, h: 30 }, { size: 12, color: available ? statusColor(reaction.label) : COLORS.muted, justify: "center", max: 12 }),
      field(e, `follow-reaction-${index + 1}-window`, available ? "MEASURED FROM START → CURRENT" : "AWAITING VERIFIED WINDOW", { x: 356, y: y - 2, w: 306, h: 35 }, { size: 10, color: COLORS.muted, justify: "center", max: 34 }),
    );
  });

  const changes = [
    clean(model.verdict, "Initial move remains subject to confirmation.", 62),
    clean(model.confirmation, "Follow-through requires cross-asset alignment.", 62),
    clean(model.invalidation, "Reversal through the benchmark invalidates the read.", 62),
  ];
  changes.forEach((value, index) => {
    const y = 233 + index * 50;
    items.push(
      field(e, `follow-change-${index + 1}-title`, ["INITIAL MOVE", "FOLLOW-THROUGH", "REVERSAL RISK"][index], { x: 769, y, w: 195, h: 22 }, { size: 14, max: 20 }),
      field(e, `follow-change-${index + 1}-body`, value, { x: 769, y: y + 22, w: 312, h: 25 }, { size: 11, weight: 600, max: 62 }),
    );
  });

  items.push(
    field(e, "follow-volatility", `VOLATILITY ${clean(model.volatility, "OBSERVED", 14).toUpperCase()}`, { x: 74, y: 440, w: 135, h: 52 }, { size: 13, color: COLORS.gold, max: 26 }),
    field(e, "follow-volume", `VOLUME ${clean(model.volume, "MONITOR", 14).toUpperCase()}`, { x: 307, y: 440, w: 110, h: 52 }, { size: 13, color: COLORS.green, max: 26 }),
    field(e, "follow-breadth", `BREADTH ${clean(model.breadth, "MIXED", 14).toUpperCase()}`, { x: 528, y: 440, w: 105, h: 52 }, { size: 13, color: COLORS.gold, max: 26 }),
    field(e, "follow-conclusion", model.verdict, { x: 725, y: 432, w: 250, h: 69 }, { fallback: "Measured evidence remains mixed; confirmation is incomplete.", size: 14, lineHeight: 1.22, weight: 650, align: "flex-start", max: 105 }),
    field(e, "follow-metrics-mask", "", { x: 705, y: 497, w: 305, h: 55 }, { fallback: "", size: 1 }),
    field(e, "follow-bias", `BIAS ${clean(model.impact, "NEUTRAL", 14).toUpperCase()}`, { x: 711, y: 497, w: 86, h: 55 }, { size: 11, color: statusColor(model.impact), justify: "center", textAlign: "center", max: 24 }),
    field(e, "follow-horizon", "HORIZON 6–24H", { x: 809, y: 497, w: 82, h: 55 }, { size: 11, color: COLORS.blue, justify: "center", textAlign: "center", max: 20 }),
    field(e, "follow-confidence", `CONFIDENCE ${reactions.some((item) => usable(item?.label) && item.label !== "PENDING") ? "MEDIUM" : "LOW"}`, { x: 900, y: 497, w: 105, h: 55 }, { size: 11, color: COLORS.gold, justify: "center", textAlign: "center", max: 24 }),
    field(e, "follow-next-1-mask", "", { x: 270, y: 573, w: 192, h: 31 }, { size: 1 }),
    field(e, "follow-next-2-mask", "", { x: 570, y: 573, w: 203, h: 31 }, { size: 1 }),
    field(e, "follow-next-3-mask", "", { x: 889, y: 573, w: 200, h: 31 }, { size: 1 }),
    field(e, "follow-next-1", `${firstAffected(reactions[0].symbol, "BTC")} HOLDS RANGE`, { x: 270, y: 573, w: 192, h: 31 }, { size: 13, justify: "center", max: 22 }),
    field(e, "follow-next-2", "CROSS-ASSET ALIGNMENT", { x: 570, y: 573, w: 203, h: 31 }, { size: 13, justify: "center", max: 24 }),
    field(e, "follow-next-3", status, { x: 889, y: 573, w: 200, h: 31 }, { size: 13, justify: "center", max: 24 }),
    field(e, "follow-source", `SOURCE · ${clean(model.source, sourceLine(model), 36)}`, { x: 76, y: 628, w: 330, h: 27 }, { size: 12, color: COLORS.muted, max: 48 }),
  );
  return e("div", masterCanvas(masterArtwork, "MARKET FOLLOW-UP"), ...items);
}

export function renderLandscapeMarketPoster(e, model = {}, masterArtwork = "") {
  const id = String(model?.visualTemplate?.id || "");
  if (id === "daily-market-brief-v4") return daily(e, model, masterArtwork);
  if (id === "weekly-catalysts-v4") return weekly(e, model, masterArtwork);
  if (id === "data-flash-v4") return dataFlash(e, model, masterArtwork);
  if (id === "market-follow-up-v4") return followUp(e, model, masterArtwork);
  throw new Error("Unsupported landscape market poster template.");
}
