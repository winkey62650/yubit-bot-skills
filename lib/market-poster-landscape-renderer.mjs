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

const TYPE = Object.freeze({
  display: '"Arial Narrow", "Helvetica Neue", Arial, sans-serif',
  text: '"Helvetica Neue", Arial, sans-serif',
  numeric: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
});

const EMPTY_UPDATE = "";

function usable(value) {
  const text = String(value ?? "").trim();
  return Boolean(text && !/^(?:—|-|N\/?A|NOT (?:AVAILABLE|PUBLISHED)|TBD|NULL|PENDING|AWAITING(?: .*)?)$/i.test(text));
}

function wordSafeClip(value, max) {
  const text = String(value ?? "").trim();
  if (text.length <= max) return text;
  const candidate = text.slice(0, Math.max(0, max - 1));
  const boundary = candidate.lastIndexOf(" ");
  const clipped = boundary > 0 ? candidate.slice(0, boundary) : "";
  return `${clipped.replace(/[,:;—-]+$/, "").trim()}…`;
}

function clean(value, fallback = "", max = 120) {
  const text = usable(value) ? String(value).replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim() : fallback;
  return wordSafeClip(text, max);
}

function compact(value, fallback = "", { words = 10, chars = 72 } = {}) {
  const source = (usable(value) ? String(value) : fallback).replace(/[-–—]+/g, " ");
  const normalized = source.replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim();
  const sentenceEnd = normalized.search(/[.!?](?:\s+|$)/);
  const sentence = sentenceEnd >= 12 ? normalized.slice(0, sentenceEnd + 1) : normalized;
  const firstThought = sentence.split(/\s+(?:while|although|because)\s+/i)[0].trim();
  const tokens = firstThought.split(/\s+/).filter(Boolean);
  const selected = tokens.slice(0, words).join(" ");
  const result = wordSafeClip(selected, chars);
  const shortened = firstThought !== normalized || tokens.length > words || result !== selected;
  return `${result.replace(/…$/, "").replace(/[,:;—-]+$/, "").trim()}${shortened ? "…" : ""}`;
}

function compactTitle(value, fallback = EMPTY_UPDATE) {
  const stopWords = new Set(["a", "an", "the", "is", "are", "was", "were", "has", "have", "had", "keeps", "remains"]);
  const source = usable(value) ? String(value) : fallback;
  const keywords = source.replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim()
    .split(" ")
    .filter((word) => !stopWords.has(word.toLowerCase()));
  return compact(keywords.join(" "), fallback, { words: 6, chars: 42 });
}

function posterCopy(value, fallback = "") {
  return (usable(value) ? String(value) : fallback)
    .replace(/[<>\r\n]/g, " ")
    .replace(/…+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
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
    throw new Error("The locked market poster master artwork is required.");
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
  const literal = String(value ?? options.fallback ?? "").replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim();
  const rendered = options.literal
    ? wordSafeClip(literal, options.max || 100)
    : clean(value, options.fallback || "", options.max || 100);
  return e("div", {
    key,
    "data-dynamic-field": key,
    "data-text-overflow": rendered.endsWith("…") ? "compacted" : "fit",
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
      fontFamily: options.fontFamily || TYPE.text,
      fontVariantNumeric: options.numeric ? "tabular-nums" : "normal",
      letterSpacing: options.letterSpacing || 0,
      textAlign: options.textAlign || "left",
      ...(options.border ? { border: options.border } : {}),
      ...(options.borderBottom ? { borderBottom: options.borderBottom } : {}),
      boxSizing: "border-box",
    },
  }, rendered);
}

function fixedSlots(values, length, fallbackFactory) {
  return Array.from({ length }, (_, index) => values[index] || fallbackFactory(index));
}

function sourceLine(model) {
  const sources = Array.isArray(model?.posterSources) && model.posterSources.length
    ? model.posterSources
    : model?.footer?.sources || [];
  return sources.filter(usable).slice(0, 3).join(" / ") || "VERIFIED MARKET INPUTS";
}

function singleWeekLabel(value) {
  const input = clean(value, "THIS WEEK", 40);
  const match = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return input.toUpperCase();
  const start = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const startMonth = months[start.getUTCMonth()];
  const endMonth = months[end.getUTCMonth()];
  const startPart = startMonth === endMonth ? String(start.getUTCDate()).padStart(2, "0") : `${String(start.getUTCDate()).padStart(2, "0")} ${startMonth}`;
  return `${startPart}–${String(end.getUTCDate()).padStart(2, "0")} ${endMonth} ${end.getUTCFullYear()}`;
}

function workWeekLabel(value) {
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

function uniqueAffected(stories) {
  const seen = new Set();
  return stories.flatMap((story) => String(story?.affected ?? "").split(/\s*[·,/|]\s*/u))
    .map((asset) => firstAffected(asset, ""))
    .filter((asset) => asset && !seen.has(asset) && seen.add(asset));
}

function utcTime(value) {
  if (!usable(value)) return "";
  const text = String(value).trim();
  const instant = new Date(text);
  if (Number.isFinite(instant.getTime())) return `${instant.toISOString().slice(11, 16)} UTC`;
  const match = text.match(/\b(\d{2}:\d{2})\b/);
  return match ? `${match[1]} UTC` : clean(text.replace(/\bUTC\b/gi, "").trim(), "", 12);
}

function daily(e, model, masterArtwork) {
  const stories = fixedSlots(
    (Array.isArray(model.stories) ? model.stories : []).filter((story) => usable(story?.title)).slice(0, 3),
    3,
    () => ({}),
  );
  const assets = uniqueAffected(stories);
  const lead = stories[0] || {};
  const watch = stories.find((story) => firstAffected(story?.affected, "") && firstAffected(story?.affected, "") !== assets[0]) || {};
  const xs = [35, 424, 813];
  const items = [
    field(e, "daily-date", `DATE · ${clean(model.date, "UTC", 26).replace(/UTC/gi, "").replace(/·/g, "").trim()}`, { x: 56, y: 174, w: 202, h: 31 }, { background: COLORS.dark, color: "#FFFFFF", size: 14, max: 28 }),
    field(e, "daily-time", `UTC · ${clean(model.footer?.updatedAt, "UTC", 28).match(/T(\d{2}:\d{2})/)?.[1] || "UTC"}`, { x: 275, y: 174, w: 170, h: 31 }, { background: COLORS.dark, color: "#FFFFFF", size: 14, max: 16 }),
    field(e, "daily-bias-mask", "", { x: 596, y: 178, w: 146, h: 29 }, { background: "#174984", size: 1, radius: 12 }),
    field(e, "daily-bias", usable(lead.title) ? `${firstAffected(lead.affected, "")} · ${clean(model.primaryBias, lead.impact || "NEUTRAL", 12).toUpperCase()}` : "", { x: 596, y: 178, w: 146, h: 29 }, { background: "#174984", color: "#FFFFFF", size: 13, justify: "center", radius: 12, max: 24 }),
    field(e, "daily-watch-mask", "", { x: 792, y: 178, w: 146, h: 29 }, { background: "#1F5E9C", size: 1, radius: 12 }),
    field(e, "daily-watch", usable(watch.title) ? `${firstAffected(watch.affected, "")} · ${clean(watch.impact, "WATCH", 12).toUpperCase()}` : "", { x: 792, y: 178, w: 146, h: 29 }, { background: "#1F5E9C", color: "#FFFFFF", size: 13, justify: "center", radius: 12, max: 24 }),
    field(e, "daily-market-mask", "", { x: 986, y: 178, w: 157, h: 29 }, { background: "#5090CD", size: 1, radius: 12 }),
    field(e, "daily-market", `MARKET · ${clean(model.primaryBias, "MIXED", 12).toUpperCase()}`, { x: 986, y: 178, w: 157, h: 29 }, { background: "#5090CD", color: "#FFFFFF", size: 13, justify: "center", radius: 12, max: 26 }),
  ];

  stories.forEach((story, index) => {
    const x = xs[index];
    items.push(
      field(e, `daily-${index + 1}-category`, clean(story.posterSource || story.source, "", 28).toUpperCase(), { x: x + 58, y: 244, w: 225, h: 25 }, { size: 14, letterSpacing: 1.1, max: 28 }),
      field(e, `daily-${index + 1}-title`, (usable(story.posterTitle) ? posterCopy(story.posterTitle) : compactTitle(story.title)).toUpperCase(), { x, y: 281, w: 272, h: 42 }, { size: 19, lineHeight: 1.04, weight: 900, align: "flex-start", padding: "1px 5px", max: 42 }),
      field(e, `daily-${index + 1}-thesis`, usable(story.posterThesis) ? posterCopy(story.posterThesis) : compact(story.thesis, "", { words: 10, chars: 64 }), { x, y: 326, w: 265, h: 58 }, { size: 13, lineHeight: 1.32, weight: 600, color: COLORS.ink, align: "flex-start", padding: "3px 5px", max: 64 }),
      field(e, `daily-${index + 1}-impact`, usable(story.title) ? `IMPACT · ${clean(story.impact, "NEUTRAL", 14).toUpperCase()}` : "", { x: x + 8, y: 479, w: 190, h: 29 }, { color: statusColor(story.impact), size: 12, letterSpacing: .6, max: 24 }),
      field(e, `daily-${index + 1}-status`, usable(story.title) ? (index === 0 ? `CONFIDENCE · ${Number(story.score) >= 75 ? "HIGH" : "MEDIUM"}` : index === 1 ? "STATUS · MONITOR" : "RISK · MODERATE") : "", { x: x + 181, y: 479, w: 170, h: 29 }, { color: COLORS.gold, size: 12, letterSpacing: .45, max: 28 }),
    );
  });

  items.push(
    field(e, "daily-read", compact(model.summary || model.read, "Confirmation still matters before conviction rises.", { words: 12, chars: 76 }), { x: 136, y: 559, w: 420, h: 48 }, { size: 16, lineHeight: 1.22, weight: 650, align: "flex-start", padding: "2px 4px", max: 76 }),
    field(e, "daily-watch-1-mask", "", { x: 661, y: 565, w: 124, h: 30 }, { size: 1 }),
    field(e, "daily-watch-2-mask", "", { x: 827, y: 565, w: 139, h: 30 }, { size: 1 }),
    field(e, "daily-watch-3-mask", "", { x: 1007, y: 565, w: 137, h: 30 }, { size: 1 }),
    ...stories.map((story, index) => field(e, `daily-watch-${index + 1}`, assets[index] || "", { x: [665, 841, 1014][index], y: 565, w: [120, 125, 130][index], h: 30 }, { size: 14, max: 18 })),
    field(e, "daily-source", `SOURCE · ${sourceLine(model)}`, { x: 74, y: 629, w: 310, h: 26 }, { size: 12, color: COLORS.muted, max: 44 }),
  );

  return e("div", masterCanvas(masterArtwork, "DAILY MARKET BRIEF"), ...items);
}

function weekly(e, model, masterArtwork) {
  const days = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
  const rawColumns = (Array.isArray(model.columns) ? model.columns : []).slice(0, 7);
  const columns = fixedSlots(rawColumns, 7, (index) => ({ label: days[index], events: [] }));
  const xs = [23, 189, 355, 521, 687, 853, 1019];
  const items = [
    field(e, "weekly-range", `WEEK · ${singleWeekLabel(model.weekStart)}`, { x: 60, y: 153, w: 214, h: 34 }, { background: COLORS.dark, color: "#FFFFFF", size: 13, weight: 700, letterSpacing: .35, numeric: true, max: 34 }),
    field(e, "weekly-grid-mask", "", { x: 14, y: 225, w: 1172, h: 307 }, { background: "#F4F8FC", size: 1, radius: 8 }),
  ];

  columns.forEach((column, index) => {
    const event = (Array.isArray(column.events) ? column.events : []).find((item) => usable(item?.title)) || {};
    const parts = clean(column.label || column.date, days[index], 18).toUpperCase().split(/\s+/);
    const day = parts[0] || days[index];
    const date = parts.find((part) => /^\d{1,2}$/.test(part)) || String(index + 1).padStart(2, "0");
    const hasEvent = usable(event.title);
    const impact = hasEvent ? (Number(event.importance) >= 4 ? "HIGH" : "MEDIUM") : "";
    const eventTime = utcTime(event.time);
    const cardBackground = hasEvent ? "#FFFBF2" : index >= 5 ? "#F5F8FC" : "#FAFCFE";
    const laneRule = "1px solid #E8EFF6";
    items.push(
      field(e, `weekly-day-${index + 1}-mask`, "", { x: xs[index], y: 225, w: 158, h: 307 }, { background: cardBackground, border: hasEvent ? "2px solid #D6A037" : "1px solid #DCE7F2", radius: 6, size: 1 }),
      field(e, `weekly-${index + 1}-day`, day, { x: xs[index] + 6, y: 233, w: 58, h: 30 }, { background: hasEvent ? COLORS.dark : "#C98A17", color: "#FFFFFF", size: 13, weight: 800, letterSpacing: .8, fontFamily: TYPE.display, justify: "center", radius: 4, max: 5 }),
      field(e, `weekly-${index + 1}-date`, date, { x: xs[index] + 111, y: 233, w: 38, h: 30 }, { background: "transparent", size: 20, weight: 500, letterSpacing: -.6, fontFamily: TYPE.numeric, numeric: true, color: COLORS.gold, justify: "center", max: 2 }),
      field(e, `weekly-${index + 1}-event`, hasEvent ? (usable(event.posterTitle) ? posterCopy(event.posterTitle) : compact(event.title, "", { words: 5, chars: 34 })) : "", { x: xs[index] + 7, y: 274, w: 144, h: 54 }, { background: "transparent", size: hasEvent ? 13 : 12, weight: 700, lineHeight: 1.24, align: "flex-start", padding: "3px 4px", borderBottom: laneRule, max: 38 }),
      field(e, `weekly-${index + 1}-time`, hasEvent ? eventTime : "", { x: xs[index] + 7, y: 331, w: 144, h: 24 }, { background: "transparent", color: COLORS.blue, size: 10, weight: 650, letterSpacing: .15, fontFamily: TYPE.numeric, numeric: true, borderBottom: laneRule, max: 18 }),
      field(e, `weekly-${index + 1}-impact`, hasEvent ? `IMPACT · ${impact}` : "", { x: xs[index] + 7, y: 361, w: 144, h: 25 }, { background: "transparent", color: statusColor(impact), size: 10, weight: 700, letterSpacing: .45, borderBottom: laneRule, max: 20 }),
      field(e, `weekly-${index + 1}-markets`, hasEvent && usable(event.posterMarkets || event.markets || event.affected) ? `MARKETS · ${posterCopy(event.posterMarkets || clean(event.markets || event.affected, "", 23)).toUpperCase()}` : "", { x: xs[index] + 7, y: 391, w: 144, h: 43 }, { background: "transparent", size: 10, weight: 650, letterSpacing: .1, lineHeight: 1.2, align: "flex-start", borderBottom: laneRule, max: 32 }),
      field(e, `weekly-${index + 1}-sensitivity`, hasEvent ? (usable(event.posterSensitivity) ? posterCopy(event.posterSensitivity) : compact(event.sensitivity, "", { words: 9, chars: 58 })) : "", { x: xs[index] + 7, y: 442, w: 144, h: 48 }, { background: "transparent", size: 10, weight: 500, lineHeight: 1.28, color: COLORS.muted, align: "flex-start", borderBottom: laneRule, max: 58 }),
      field(e, `weekly-${index + 1}-status`, hasEvent && usable(event.posterSource || event.source) ? `SOURCE · ${clean(event.posterSource || event.source, "", 18).toUpperCase()}` : "", { x: xs[index] + 7, y: 498, w: 144, h: 27 }, { background: hasEvent ? "#FFF1D2" : "transparent", size: 9, weight: 700, letterSpacing: .45, color: COLORS.blue, justify: hasEvent ? "center" : "flex-start", radius: hasEvent ? 10 : 2, max: 28 }),
    );
  });

  const events = columns.flatMap((column) => column.events || []).filter((event) => usable(event?.title));
  const priority = events.find((event) => Number(event.importance) >= 3 || event.isPriority) || events[0];
  items.push(
    field(e, "weekly-key-risk", usable(priority?.posterSensitivity) ? posterCopy(priority.posterSensitivity) : compact(priority?.sensitivity, "", { words: 12, chars: 76 }), { x: 118, y: 570, w: 450, h: 38 }, { size: 14, lineHeight: 1.28, weight: 550, max: 76 }),
    field(e, "weekly-plan-1-mask", "", { x: 680, y: 570, w: 112, h: 30 }, { size: 1 }),
    field(e, "weekly-plan-2-mask", "", { x: 846, y: 570, w: 132, h: 30 }, { size: 1 }),
    field(e, "weekly-plan-3-mask", "", { x: 1030, y: 570, w: 131, h: 30 }, { size: 1 }),
    field(e, "weekly-plan-1", "PREP LEVELS", { x: 692, y: 570, w: 100, h: 30 }, { size: 12, weight: 700, letterSpacing: .2, max: 18 }),
    field(e, "weekly-plan-2", "VERIFY RELEASE", { x: 854, y: 570, w: 124, h: 30 }, { size: 11, weight: 700, letterSpacing: .15, max: 20 }),
    field(e, "weekly-plan-3", "TRACK REACTION", { x: 1038, y: 570, w: 123, h: 30 }, { size: 11, weight: 700, letterSpacing: .15, max: 20 }),
    field(e, "weekly-source", `SOURCE · ${sourceLine(model)}`, { x: 73, y: 628, w: 330, h: 27 }, { size: 11, weight: 600, letterSpacing: .25, color: COLORS.muted, max: 48 }),
  );
  return e("div", masterCanvas(masterArtwork, "WEEKLY CATALYSTS"), ...items);
}

function weeklyCategory(event) {
  const text = `${event?.title || ""} ${event?.markets || ""}`.toUpperCase();
  if (/EARNINGS|RESULTS|REVENUE|EPS/.test(text)) return "EARNINGS";
  if (/FED|FOMC|SEC|POLICY|REGULAT|RATE DECISION/.test(text)) return "POLICY";
  if (/TOKEN|UNLOCK|ETF|CRYPTO|BITCOIN|ETHEREUM|BTC|ETH/.test(text)) return "CRYPTO";
  return "MACRO";
}

function weeklyImpact(importance) {
  const score = Math.max(1, Math.min(5, Number(importance) || 1));
  return {
    label: score >= 4 ? "HIGH" : score >= 2 ? "MEDIUM" : "LOW",
    score,
  };
}

function weeklyImpactDots(e, key, score, label, rect) {
  const active = Math.max(0, Math.min(5, Number(score) || 0));
  const color = statusColor(label);
  return e("div", {
    key,
    "data-dynamic-field": key,
    "data-text-overflow": "fit",
    style: {
      position: "absolute",
      left: rect.x,
      top: rect.y,
      width: rect.w,
      height: rect.h,
      display: "flex",
      alignItems: "center",
      justifyContent: "flex-start",
      gap: 5,
      overflow: "hidden",
      padding: "0 5px",
      backgroundColor: "#FBFCFF",
      boxSizing: "border-box",
    },
  }, ...Array.from({ length: 5 }, (_, index) => e("div", {
    key: `${key}-${index + 1}`,
    style: {
      width: 7,
      height: 7,
      flexShrink: 0,
      borderRadius: 999,
      backgroundColor: index < active ? color : "#FFFFFF",
      border: `1px solid ${index < active ? color : "#AFC1D7"}`,
      boxSizing: "border-box",
    },
  })));
}

function weeklyStatus(importance, hasEvent) {
  if (!hasEvent) return "";
  const score = Number(importance) || 0;
  if (score >= 5) return "FOCUS";
  if (score >= 4) return "PREPARE";
  if (score >= 3) return "WATCH";
  return "MONITOR";
}

function weeklyV5(e, model, masterArtwork) {
  const days = ["MON", "TUE", "WED", "THU", "FRI"];
  const columns = fixedSlots((Array.isArray(model.columns) ? model.columns : []).slice(0, 5), 5, (index) => ({ label: days[index], events: [] }));
  const xs = [11, 253, 486, 717, 949];
  const widths = [236, 226, 227, 228, 239];
  const items = [
    field(e, "weekly-v5-masthead", "MARKET INTELLIGENCE / CATALYST DESK", { x: 142, y: 17, w: 350, h: 21 }, { background: COLORS.dark, color: "#F5B83C", size: 12, weight: 650, letterSpacing: .45, max: 42 }),
    field(e, "weekly-v5-subtitle-mask", "", { x: 140, y: 96, w: 480, h: 50 }, { background: COLORS.dark, size: 1 }),
    field(e, "weekly-v5-subtitle", "KEY MACRO RELEASES & MARKET WATCHES", { x: 142, y: 101, w: 350, h: 34 }, { background: COLORS.dark, color: "#F5B83C", size: 14, weight: 650, letterSpacing: .15, max: 42 }),
    field(e, "weekly-range", `WEEK · ${workWeekLabel(model.weekStart)}`, { x: 716, y: 103, w: 200, h: 28 }, { background: COLORS.dark, color: "#FFFFFF", size: 13, weight: 650, justify: "center", numeric: true, max: 34 }),
  ];

  columns.forEach((column, index) => {
    const events = (Array.isArray(column.events) ? column.events : []).filter((event) => usable(event?.title)).slice(0, 3);
    const primary = events.find((event) => event.lane === "primary") || events[0] || {};
    const secondaries = events.filter((event) => event !== primary).slice(0, 2);
    const parts = clean(column.label || column.date, days[index], 18).toUpperCase().split(/\s+/);
    const day = parts[0] || days[index];
    const date = parts.find((part) => /^\d{1,2}$/.test(part)) || String(index + 1).padStart(2, "0");
    const hasEvent = usable(primary.title);
    const impact = weeklyImpact(primary.importance);
    const x = xs[index];
    const width = widths[index];
    const mainTitle = hasEvent ? `${utcTime(primary.time).replace(" UTC", "")} · ${posterCopy(primary.posterTitle || primary.title)}` : "";
    const markets = hasEvent ? posterCopy(primary.posterMarkets || primary.markets || primary.affected).toUpperCase() : "";
    const secondaryRows = fixedSlots(secondaries, 2, () => ({}));
    const status = weeklyStatus(primary.importance, hasEvent);

    items.push(
      field(e, `weekly-${index + 1}-day-mask`, "", { x: x + 47, y: 158, w: width - 95, h: 34 }, { background: "#FBFCFF", size: 1 }),
      field(e, `weekly-${index + 1}-day`, day, { x: x + 50, y: 161, w: 70, h: 27 }, { background: COLORS.blue, color: "#FFFFFF", size: 16, weight: 850, justify: "center", radius: 4, max: 5 }),
      field(e, `weekly-${index + 1}-date`, date, { x: x + width - 87, y: 159, w: 52, h: 30 }, { background: "#FBFCFF", color: COLORS.blue, size: 23, weight: 700, justify: "center", fontFamily: TYPE.numeric, numeric: true, max: 2 }),
      field(e, `weekly-${index + 1}-body-mask`, "", { x: x + 2, y: 196, w: width - 4, h: 310 }, { background: "#FBFCFF", size: 1 }),
      field(e, `weekly-${index + 1}-primary-label-mask`, "", { x: x + 16, y: 199, w: width - 30, h: 25 }, { background: "#FBFCFF", size: 1 }),
      field(e, `weekly-${index + 1}-primary-label`, "PRIMARY CATALYST", { x: x + 39, y: 199, w: width - 53, h: 25 }, { background: "#FBFCFF", color: COLORS.ink, size: 11, weight: 800, letterSpacing: .35, max: 20 }),
      field(e, `weekly-${index + 1}-main-mask`, "", { x: x + 16, y: 228, w: width - 30, h: 94 }, { background: "#FBFCFF", border: "1px solid #DDE8F4", radius: 6, size: 1 }),
      field(e, `weekly-${index + 1}-category`, hasEvent ? weeklyCategory(primary) : "", { x: x + 25, y: 236, w: 58, h: 25 }, { background: hasEvent ? "#EEF5FF" : "#FBFCFF", color: COLORS.blue, size: 9, weight: 850, justify: "center", radius: 4, max: 10 }),
      field(e, `weekly-${index + 1}-event`, mainTitle, { x: x + 88, y: 232, w: width - 103, h: 42 }, { background: "#FBFCFF", size: 10, lineHeight: 1.18, weight: 750, align: "flex-start", padding: "4px 2px", max: 44 }),
      field(e, `weekly-${index + 1}-impact`, hasEvent ? `IMPACT · ${impact.label}` : "", { x: x + 88, y: 275, w: width - 103, h: 20 }, { background: "#FBFCFF", color: statusColor(impact.label), size: 9, weight: 750, max: 20 }),
      weeklyImpactDots(e, `weekly-${index + 1}-impact-dots`, hasEvent ? impact.score : 0, impact.label, { x: x + 88, y: 295, w: width - 103, h: 19 }),
      field(e, `weekly-${index + 1}-markets`, markets ? `WATCH · ${markets}` : "", { x: x + 21, y: 322, w: width - 40, h: 22 }, { background: "#FBFCFF", color: COLORS.muted, size: 9, weight: 650, justify: "center", max: 30 }),
      field(e, `weekly-${index + 1}-secondary-label-mask`, "", { x: x + 16, y: 356, w: width - 30, h: 25 }, { background: "#FBFCFF", size: 1 }),
      field(e, `weekly-${index + 1}-secondary-label`, "SECONDARY WATCH", { x: x + 39, y: 356, w: width - 53, h: 25 }, { background: "#FBFCFF", color: COLORS.ink, size: 11, weight: 800, letterSpacing: .35, max: 20 }),
      field(e, `weekly-${index + 1}-secondary-mask`, "", { x: x + 16, y: 384, w: width - 30, h: 76 }, { background: "#FBFCFF", border: "1px solid #E4EBF4", radius: 6, size: 1 }),
      ...secondaryRows.map((event, row) => field(e, `weekly-${index + 1}-secondary-${row + 1}`, usable(event?.title) ? `${utcTime(event.time).replace(" UTC", "")} · ${posterCopy(event.posterTitle || event.title)}` : "", { x: x + 23, y: 390 + row * 32, w: width - 44, h: 28 }, { background: "#FBFCFF", color: row === 0 ? COLORS.ink : COLORS.muted, size: 10, weight: row === 0 ? 700 : 600, borderBottom: row === 0 ? "1px solid #E7EEF6" : undefined, max: 44 })),
      field(e, `weekly-${index + 1}-status-mask`, "", { x: x + 16, y: 466, w: width - 30, h: 34 }, { background: "#FBFCFF", size: 1 }),
      field(e, `weekly-${index + 1}-status`, status ? `STATUS · ${status}` : "", { x: x + 20, y: 469, w: width - 40, h: 27 }, { background: "#FBFCFF", color: statusColor(status), size: 11, weight: 750, letterSpacing: .25, max: 22 }),
    );
  });

  const events = columns.flatMap((column) => column.events || []).filter((event) => usable(event?.title));
  const priority = events.find((event) => Number(event.importance) >= 4 || event.isPriority) || events[0];
  const focus = usable(priority?.posterSensitivity)
    ? posterCopy(priority.posterSensitivity)
    : usable(priority?.title) ? `${posterCopy(priority.posterTitle || priority.title)} is the week's primary repricing watch.` : "";
  items.push(
    field(e, "weekly-focus-mask", "", { x: 145, y: 548, w: 320, h: 52 }, { background: "#FBFCFF", size: 1 }),
    field(e, "weekly-key-risk", focus, { x: 151, y: 548, w: 310, h: 52 }, { background: "#FBFCFF", color: COLORS.ink, size: 14, lineHeight: 1.25, weight: 550, align: "flex-start", max: 72 }),
    field(e, "weekly-source", `SOURCE · ${sourceLine(model)}`, { x: 74, y: 629, w: 390, h: 25 }, { background: "#FBFCFF", size: 11, weight: 600, letterSpacing: .25, color: COLORS.muted, max: 56 }),
  );
  return e("div", masterCanvas(masterArtwork, "WEEKLY CATALYSTS"), ...items);
}

function reactionFallback(index, symbols = ["BTC", "DXY", "NASDAQ", "US 2Y"]) {
  return { symbol: "", label: "", value: null, expectedSymbol: symbols[index] };
}

function dataFlash(e, model, masterArtwork) {
  const reactions = fixedSlots((Array.isArray(model.reactions) ? model.reactions : []).slice(0, 4), 4, reactionFallback);
  const impact = clean(model.impact, "NEUTRAL", 16).toUpperCase();
  const items = [
    field(e, "flash-release", usable(model.releaseTime || model.time) ? `RELEASE · ${utcTime(model.releaseTime || model.time)}` : "", { x: 57, y: 151, w: 204, h: 34 }, { background: COLORS.dark, color: "#FFFFFF", size: 14, max: 28 }),
    field(e, "flash-status", usable(model.actual) ? "STATUS · VERIFIED" : "", { x: 302, y: 151, w: 193, h: 34 }, { background: COLORS.dark, color: "#22D255", size: 14, max: 24 }),
    field(e, "flash-indicator", clean(model.indicator, "", 34).toUpperCase(), { x: 156, y: 215, w: 480, h: 35 }, { size: 25, weight: 900, justify: "center", max: 34 }),
    field(e, "flash-subtitle", (usable(model.posterTitle) ? posterCopy(model.posterTitle) : compact(model.title, "VERIFIED RELEASE SNAPSHOT", { words: 7, chars: 42 })).toUpperCase(), { x: 165, y: 251, w: 465, h: 25 }, { size: 14, color: COLORS.blue, justify: "center", max: 42 }),
    field(e, "flash-actual", clean(model.actual, "", 16), { x: 45, y: 314, w: 174, h: 70 }, { size: String(model.actual ?? "").length > 8 ? 32 : 48, color: COLORS.green, justify: "center", max: 16 }),
    field(e, "flash-forecast", usable(model.forecast) ? model.forecast : "NOT IN SOURCE", { x: 232, y: 314, w: 194, h: 70 }, { literal: true, size: usable(model.forecast) && String(model.forecast).length <= 8 ? 48 : 16, color: usable(model.forecast) ? COLORS.ink : COLORS.muted, justify: "center", max: 16 }),
    field(e, "flash-previous", usable(model.previous) ? model.previous : "NOT IN SOURCE", { x: 446, y: 314, w: 193, h: 70 }, { literal: true, size: usable(model.previous) && String(model.previous).length <= 8 ? 48 : 16, color: usable(model.previous) ? COLORS.ink : COLORS.muted, justify: "center", max: 16 }),
    field(e, "flash-surprise", usable(model.surprise) ? `SURPRISE · ${clean(model.surprise, "", 18).toUpperCase()}` : "", { x: 93, y: 400, w: 230, h: 25 }, { size: 13, color: statusColor(impact), justify: "center", max: 30 }),
    field(e, "flash-revision", usable(model.revision) ? `REVISION · ${clean(model.revision, "", 18).toUpperCase()}` : "", { x: 387, y: 400, w: 230, h: 25 }, { size: 13, color: COLORS.gold, justify: "center", max: 30 }),
  ];

  reactions.forEach((reaction, index) => {
    const y = 240 + index * 40;
    const available = usable(reaction?.symbol) && usable(reaction?.label);
    items.push(
      field(e, `flash-reaction-${index + 1}-symbol`, available ? clean(reaction.symbol, "", 10).toUpperCase() : reaction.expectedSymbol, { x: 731, y, w: 72, h: 28 }, { literal: !available, size: 14, max: 10 }),
      field(e, `flash-reaction-${index + 1}-mask`, "", { x: 812, y: y - 2, w: 360, h: 34 }, { size: 1 }),
      field(e, `flash-reaction-${index + 1}-observation`, available ? "VERIFIED WINDOW" : "AWAITING TAPE", { x: 818, y: y - 2, w: 192, h: 34 }, { literal: !available, size: 10, color: COLORS.muted, justify: "center", max: 28 }),
      field(e, `flash-reaction-${index + 1}-value`, available ? reaction.label : "—", { x: 1012, y: y - 2, w: 80, h: 34 }, { literal: !available, size: 16, color: available ? statusColor(reaction.label) : COLORS.muted, justify: "center", max: 12 }),
      field(e, `flash-reaction-${index + 1}-status`, available ? clean(reaction.status, "OBSERVED", 12).toUpperCase() : "PENDING", { x: 1103, y: y - 2, w: 69, h: 34 }, { literal: !available, size: available ? 12 : 9, color: available ? statusColor(reaction.label) : COLORS.muted, justify: "center", max: 12 }),
    );
  });

  items.push(
    field(e, "flash-release-time", utcTime(model.releaseTime || model.time), { x: 329, y: 470, w: 95, h: 38 }, { size: 14, justify: "center", max: 18 }),
    field(e, "flash-yoy-comparison-mask", "", { x: 430, y: 451, w: 219, h: 61 }, { size: 1 }),
    field(e, "flash-yoy-actual", clean(model.actual, "", 12), { x: 440, y: 459, w: 59, h: 40 }, { size: 18, color: COLORS.green, justify: "center", max: 12 }),
    field(e, "flash-yoy-forecast", usable(model.forecast) ? model.forecast : "—", { x: 515, y: 459, w: 59, h: 40 }, { literal: true, size: 18, color: COLORS.ink, justify: "center", max: 12 }),
    field(e, "flash-yoy-previous", usable(model.previous) ? model.previous : "—", { x: 590, y: 459, w: 59, h: 40 }, { literal: true, size: 18, color: COLORS.blue, justify: "center", max: 12 }),
    field(e, "flash-desk-view", usable(model.posterVerdict) ? posterCopy(model.posterVerdict) : compact(model.verdict || model.title, "", { words: 14, chars: 82 }), { x: 698, y: 444, w: 365, h: 58 }, { size: 15, lineHeight: 1.24, weight: 650, align: "flex-start", max: 82 }),
    field(e, "flash-bias", `BIAS · ${impact}`, { x: 698, y: 513, w: 137, h: 27 }, { size: 12, color: statusColor(impact), max: 24 }),
    field(e, "flash-horizon", "", { x: 854, y: 513, w: 145, h: 27 }, { size: 12, color: COLORS.blue, max: 22 }),
    field(e, "flash-confidence", `CONFIDENCE · ${usable(model.actual) ? "HIGH" : "LOW"}`, { x: 1014, y: 513, w: 154, h: 27 }, { size: 12, color: COLORS.green, max: 24 }),
    field(e, "flash-watch-1-mask", "", { x: 321, y: 575, w: 167, h: 30 }, { size: 1 }),
    field(e, "flash-watch-2-mask", "", { x: 580, y: 575, w: 220, h: 30 }, { size: 1 }),
    field(e, "flash-watch-3-mask", "", { x: 909, y: 575, w: 225, h: 30 }, { size: 1 }),
    field(e, "flash-watch-1", "RATE PRICING", { x: 321, y: 575, w: 167, h: 30 }, { size: 13, justify: "center", max: 20 }),
    field(e, "flash-watch-2", "DOLLAR FOLLOW-THROUGH", { x: 580, y: 575, w: 220, h: 30 }, { size: 13, justify: "center", max: 24 }),
    field(e, "flash-watch-3", `${firstAffected(model.affected, "BTC")} CONFIRMATION`, { x: 909, y: 575, w: 225, h: 30 }, { size: 13, justify: "center", max: 24 }),
    field(e, "flash-source", `SOURCE · ${posterCopy(model.posterSource || clean(model.source || model.officialSource, sourceLine(model), 36))}`, { x: 70, y: 628, w: 330, h: 27 }, { size: 12, color: COLORS.muted, max: 48 }),
  );
  return e("div", masterCanvas(masterArtwork, "DATA FLASH"), ...items);
}

function followUp(e, model, masterArtwork) {
  const reactions = fixedSlots((Array.isArray(model.reactions) ? model.reactions : []).slice(0, 4), 4, (index) => reactionFallback(index, ["BTC", "ETH", "DXY", "NASDAQ"]));
  const status = String(model.tapeStatus || model.verdictStatus || "AWAITING CONFIRMATION").replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
  const availableCount = reactions.filter((item) => usable(item?.symbol) && usable(item?.label)).length;
  const checkpoint = clean(model.reactionWindow?.label, "", 30).replace(/\s*[·|]\s*\d+\s*MIN(?:UTES?)?\s*$/i, "");
  const items = [
    field(e, "follow-checkpoint", checkpoint ? `CHECKPOINT · ${checkpoint}` : "", { x: 61, y: 137, w: 255, h: 36 }, { background: COLORS.dark, color: "#FFFFFF", size: 12, max: 36 }),
    field(e, "follow-updated", usable(model.footer?.updatedAt) ? `UPDATED · ${clean(model.footer.updatedAt, "", 28).replace("T", " ").replace(/\.000Z$/, " UTC")}` : "", { x: 299, y: 137, w: 321, h: 36 }, { background: COLORS.dark, color: "#FFFFFF", size: 12, max: 40 }),
  ];

  reactions.forEach((reaction, index) => {
    const y = 236 + index * 48;
    const available = usable(reaction?.symbol) && usable(reaction?.label);
    items.push(
      field(e, `follow-reaction-${index + 1}-symbol`, available ? clean(reaction.symbol, "", 10).toUpperCase() : reaction.expectedSymbol, { x: 81, y, w: 75, h: 30 }, { literal: !available, size: 15, max: 10 }),
      field(e, `follow-reaction-${index + 1}-value`, available ? reaction.label : "—", { x: 169, y, w: 72, h: 30 }, { literal: !available, size: available ? 17 : 14, color: available ? statusColor(reaction.label) : COLORS.muted, justify: "center", max: 12 }),
      field(e, `follow-reaction-${index + 1}-status`, available ? clean(reaction.status, "OBSERVED", 12).toUpperCase() : "NO DATA", { x: 248, y, w: 88, h: 30 }, { literal: !available, size: available ? 12 : 10, color: available ? statusColor(reaction.label) : COLORS.muted, justify: "center", max: 12 }),
      field(e, `follow-reaction-${index + 1}-window`, available ? "START → CURRENT" : "UNAVAILABLE", { x: 356, y: y - 2, w: 306, h: 35 }, { literal: !available, size: 10, color: COLORS.muted, justify: "center", max: 34 }),
    );
  });

  const changes = [
    usable(model.posterVerdict) ? posterCopy(model.posterVerdict) : compact(model.verdict, "", { words: 7, chars: 44 }),
    usable(model.posterConfirmation) ? posterCopy(model.posterConfirmation) : compact(model.confirmation, "Cross-asset tape unavailable.", { words: 7, chars: 44 }),
    usable(model.posterInvalidation) ? posterCopy(model.posterInvalidation) : compact(model.invalidation, "", { words: 7, chars: 44 }),
  ];
  changes.forEach((value, index) => {
    const y = 233 + index * 50;
    items.push(
      field(e, `follow-change-${index + 1}-title`, ["INITIAL MOVE", "FOLLOW-THROUGH", "REVERSAL RISK"][index], { x: 769, y, w: 195, h: 22 }, { size: 14, max: 20 }),
      field(e, `follow-change-${index + 1}-body`, value, { x: 769, y: y + 22, w: 312, h: 25 }, { size: 11, weight: 600, max: 62 }),
    );
  });

  items.push(
    field(e, "follow-volatility", usable(model.volatility) ? `VOLATILITY ${clean(model.volatility, "", 14).toUpperCase()}` : "VOLATILITY N/A", { x: 74, y: 440, w: 135, h: 52 }, { literal: !usable(model.volatility), size: 13, color: COLORS.gold, max: 26 }),
    field(e, "follow-volume", usable(model.volume) ? `VOLUME ${clean(model.volume, "", 14).toUpperCase()}` : "VOLUME N/A", { x: 307, y: 440, w: 110, h: 52 }, { literal: !usable(model.volume), size: 13, color: COLORS.green, max: 26 }),
    field(e, "follow-breadth", usable(model.breadth) ? `BREADTH ${clean(model.breadth, "", 14).toUpperCase()}` : `BREADTH ${availableCount} ASSET${availableCount === 1 ? "" : "S"}`, { x: 528, y: 440, w: 105, h: 52 }, { literal: !usable(model.breadth), size: 11, color: COLORS.gold, max: 26 }),
    field(e, "follow-conclusion", usable(model.posterVerdict) ? posterCopy(model.posterVerdict) : compact(model.verdict, "", { words: 13, chars: 76 }), { x: 725, y: 432, w: 250, h: 69 }, { size: 14, lineHeight: 1.22, weight: 650, align: "flex-start", max: 76 }),
    field(e, "follow-metrics-mask", "", { x: 705, y: 497, w: 305, h: 55 }, { fallback: "", size: 1 }),
    field(e, "follow-bias", `BIAS ${clean(model.impact, "NEUTRAL", 14).toUpperCase()}`, { x: 711, y: 497, w: 86, h: 55 }, { size: 11, color: statusColor(model.impact), justify: "center", textAlign: "center", max: 24 }),
    field(e, "follow-horizon", "", { x: 809, y: 497, w: 82, h: 55 }, { size: 11, color: COLORS.blue, justify: "center", textAlign: "center", max: 20 }),
    field(e, "follow-confidence", `COVERAGE ${availableCount}/4`, { x: 900, y: 497, w: 105, h: 55 }, { size: 11, color: COLORS.gold, justify: "center", textAlign: "center", max: 24 }),
    field(e, "follow-next-1-mask", "", { x: 270, y: 573, w: 192, h: 31 }, { size: 1 }),
    field(e, "follow-next-2-mask", "", { x: 570, y: 573, w: 203, h: 31 }, { size: 1 }),
    field(e, "follow-next-3-mask", "", { x: 889, y: 573, w: 200, h: 31 }, { size: 1 }),
    field(e, "follow-next-1", usable(reactions[0]?.symbol) ? `${firstAffected(reactions[0].symbol, "")} HOLDS RANGE` : "", { x: 270, y: 573, w: 192, h: 31 }, { size: 13, justify: "center", max: 22 }),
    field(e, "follow-next-2", "CROSS-ASSET ALIGNMENT", { x: 570, y: 573, w: 203, h: 31 }, { size: 13, justify: "center", max: 24 }),
    field(e, "follow-next-3", status, { x: 889, y: 573, w: 200, h: 31 }, { literal: true, size: 13, justify: "center", max: 24 }),
    field(e, "follow-source", `SOURCE · ${posterCopy(model.posterSource || clean(model.source, sourceLine(model), 36))}`, { x: 76, y: 628, w: 330, h: 27 }, { size: 12, color: COLORS.muted, max: 48 }),
  );
  return e("div", masterCanvas(masterArtwork, "MARKET FOLLOW-UP"), ...items);
}

export function renderLandscapeMarketPoster(e, model = {}, masterArtwork = "") {
  const id = String(model?.visualTemplate?.id || "");
  if (id === "daily-market-brief-v4") return daily(e, model, masterArtwork);
  if (id === "weekly-catalysts-v4") return weekly(e, model, masterArtwork);
  if (id === "weekly-catalysts-v5") return weeklyV5(e, model, masterArtwork);
  if (id === "data-flash-v4") return dataFlash(e, model, masterArtwork);
  if (id === "market-follow-up-v4") return followUp(e, model, masterArtwork);
  throw new Error("Unsupported landscape market poster template.");
}

function inspectionElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined) };
}

export function landscapePosterOverflowFields(model = {}) {
  const root = renderLandscapeMarketPoster(inspectionElement, model, "data:image/png;base64,INSPECTION");
  const overflowFields = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.props?.["data-text-overflow"] === "compacted") {
      overflowFields.push(String(node.props["data-dynamic-field"] || "unknown-field"));
    }
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return overflowFields;
}

export function assertLandscapeMarketPosterFits(model = {}) {
  const overflowFields = landscapePosterOverflowFields(model);
  if (overflowFields.length) {
    throw new Error(`Landscape poster visual gate rejected compacted fields: ${overflowFields.join(", ")}`);
  }
}
