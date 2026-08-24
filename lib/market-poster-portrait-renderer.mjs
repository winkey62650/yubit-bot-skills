function clean(value, fallback = "—", limit = 80) {
  const text = String(value ?? fallback).replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, limit);
}

function box(e, children, style = {}) {
  return e("div", { style: { position: "absolute", display: "flex", overflow: "hidden", fontFamily: "Arial, Helvetica, sans-serif", ...style } }, children);
}

function valueColor(value) {
  const text = String(value || "");
  if (/bullish|positive|\+|above|beat/i.test(text)) return "#0a7c64";
  if (/bearish|negative|(?:^|\s)[−-]\d|below|miss/i.test(text)) return "#a33c38";
  return "#182536";
}

function footerSource(model) {
  return clean(model?.footer?.sources?.filter(Boolean).join(" · "), "VERIFIED PUBLIC SOURCES", 88);
}

function updated(model) {
  return clean(model?.footer?.updatedAt?.replace("T", " ").replace(/\.\d{3}Z$/, " UTC").replace(/Z$/, " UTC"), "UTC", 32);
}

function compactTitle(value, fallback = "Verified market development", limit = 48) {
  return clean(value, fallback, 160)
    .replace(/^HISTORICAL REPLAY\s*[·:—-]\s*/i, "")
    .replace(/^DEMO REPLAY\s*[·:—-]\s*/i, "")
    .replace(/^(?:DATA FLASH|MARKET FOLLOW-UP|DAILY MARKET BRIEF|WEEKLY CATALYSTS)\s*[·:—-]\s*/i, "")
    .slice(0, limit);
}

function fill(e, children, style = {}) {
  return box(e, children, {
    background: "rgba(248, 250, 252, 0.94)",
    borderRadius: 6,
    padding: "3px 7px",
    ...style,
  });
}

function daily(e, model, artwork) {
  const stories = (model.stories ?? []).slice(0, 3);
  const positions = [474, 724, 962];
  const impactPositions = [594, 844, 1057];
  return e("div", { style: canvas() },
    background(e, artwork),
    box(e, clean(model.date, "UTC", 18), { left: 164, top: 246, width: 280, height: 28, alignItems: "center", color: "#657383", fontSize: 17, fontWeight: 800, letterSpacing: 1.5 }),
    ...stories.flatMap((story, index) => {
      const top = positions[index];
      return [
        fill(e, compactTitle(story.title, "Verified market development", 54), { left: 292, top, width: 410, height: 58, color: "#132335", fontSize: 20, lineHeight: 1.18, fontWeight: 900 }),
        fill(e, clean(`${story.impact || "NEUTRAL"} · ${story.affected || "CRYPTO"}`, "NEUTRAL", 45), { left: 292, top: impactPositions[index], width: 330, height: 28, alignItems: "center", color: valueColor(story.impact), fontSize: 14, fontWeight: 900, letterSpacing: .4 }),
      ];
    }),
    fill(e, clean(stories[0]?.confirmation, "Await cross-asset confirmation.", 62), { left: 235, top: 1152, width: 490, height: 28, alignItems: "center", color: "#17283a", fontSize: 14, fontWeight: 800 }),
    fill(e, clean(stories[0]?.invalidation, "Read weakens if the first move reverses.", 62), { left: 235, top: 1190, width: 490, height: 28, alignItems: "center", color: "#17283a", fontSize: 14, fontWeight: 800 }),
    portraitFooter(e, model));
}

function dataFlash(e, model, artwork) {
  const reactions = new Map((model.reactions ?? []).map((item) => [item.symbol, item.label]));
  return e("div", { style: canvas() },
    background(e, artwork),
    box(e, compactTitle(model.title, "Official data release", 48), { left: 178, top: 317, width: 650, height: 34, alignItems: "center", color: "#122436", fontSize: 24, fontWeight: 900 }),
    box(e, clean(model.reactionWindow?.label || updated(model), "UTC", 28), { left: 277, top: 404, width: 440, height: 24, alignItems: "center", color: "#647181", fontSize: 15, fontWeight: 800, letterSpacing: .8 }),
    metric(e, "ACTUAL", model.actual, 205), metric(e, "FORECAST", model.forecast, 493), metric(e, "PREVIOUS", model.previous, 781),
    reaction(e, reactions.get("BTC"), 918),
    reaction(e, reactions.get("DXY"), 976),
    reaction(e, reactions.get("NASDAQ") || reactions.get("ETH"), 1034),
    fill(e, clean(model.verdict, "Initial read; await cross-asset confirmation.", 104), { left: 575, top: 918, width: 330, height: 130, color: "#1a2c3d", fontSize: 16, lineHeight: 1.34, fontWeight: 800 }),
    statusStrip(e, "BTC IMPACT", clean(model.impact, "NEUTRAL", 18), 155, valueColor(model.impact)),
    statusStrip(e, "WINDOW", clean(model.reactionWindow?.label, "CURRENT SESSION", 24), 425),
    statusStrip(e, "CONFIDENCE", clean(model.verdictStatus, "MONITOR", 24), 695),
    portraitFooter(e, model, 1248));
}

function followUp(e, model, artwork) {
  const reactionMap = new Map((model.reactions ?? []).map((item) => [item.symbol, item.label]));
  const reactions = [reactionMap.get("BTC"), reactionMap.get("NASDAQ") || reactionMap.get("ETH"), reactionMap.get("DXY"), reactionMap.get("US2Y")];
  const positions = [461, 605, 750, 894];
  return e("div", { style: canvas() },
    background(e, artwork),
    box(e, compactTitle(model.title, "Measured market follow-up", 52), { left: 258, top: 302, width: 415, height: 34, alignItems: "center", color: "#122436", fontSize: 21, fontWeight: 900 }),
    ...positions.map((top, index) => box(e, clean(reactions[index], "—", 18), { left: 267, top, width: 92, height: 30, justifyContent: "center", alignItems: "center", background: "#f8fafc", color: valueColor(reactions[index]), fontSize: 20, fontWeight: 900 })),
    fill(e, e("div", { style: { display: "flex", flexDirection: "column" } },
      e("span", { style: { display: "flex", color: "#b37a1f", fontSize: 12, fontWeight: 900, letterSpacing: 1 } }, "CURRENT READ"),
      e("span", { style: { display: "flex", marginTop: 8, color: "#17283a", fontSize: 18, lineHeight: 1.32, fontWeight: 800 } }, clean(model.verdict, "Measured context; causation is not established.", 130))),
    { left: 488, top: 458, width: 410, height: 122 }),
    fill(e, e("div", { style: { display: "flex", flexDirection: "column" } },
      e("span", { style: { display: "flex", color: "#b37a1f", fontSize: 12, fontWeight: 900, letterSpacing: 1 } }, "CONFIRMATION"),
      e("span", { style: { display: "flex", marginTop: 7, color: "#506071", fontSize: 16, lineHeight: 1.3, fontWeight: 700 } }, clean(model.confirmation, "Await cross-asset confirmation.", 92))),
    { left: 488, top: 618, width: 410, height: 94 }),
    fill(e, e("div", { style: { display: "flex", flexDirection: "column" } },
      e("span", { style: { display: "flex", color: "#b37a1f", fontSize: 12, fontWeight: 900, letterSpacing: 1 } }, "INVALIDATION"),
      e("span", { style: { display: "flex", marginTop: 7, color: "#506071", fontSize: 16, lineHeight: 1.3, fontWeight: 700 } }, clean(model.invalidation, "Read weakens if the move reverses.", 92))),
    { left: 488, top: 758, width: 410, height: 94 }),
    fill(e, clean(model.reactionWindow?.label, "CURRENT SESSION", 30), { left: 175, top: 1090, width: 190, height: 34, alignItems: "center", justifyContent: "center", color: "#17283a", fontSize: 16, fontWeight: 900 }),
    box(e, "", { left: 430, top: 1058, width: 220, height: 155, background: "#f9fbfd" }),
    box(e, clean(model.impact, "NEUTRAL", 18), { left: 438, top: 1100, width: 205, height: 48, justifyContent: "center", alignItems: "center", color: valueColor(model.impact), fontSize: 22, fontWeight: 900 }),
    fill(e, clean(model.verdictStatus, "AWAITING CONFIRMATION", 24), { left: 718, top: 1090, width: 195, height: 58, justifyContent: "center", alignItems: "center", textAlign: "center", color: "#17283a", fontSize: 15, lineHeight: 1.22, fontWeight: 900 }),
    portraitFooter(e, model, 1248));
}

function weekly(e, model, artwork) {
  const columns = (model.columns ?? []).slice(0, 5);
  const rowY = [333, 483, 633, 783, 933];
  const events = columns.flatMap((column, index) => (column.events ?? []).slice(0, 2).map((event, slot) => ({ ...event, day: column.label, row: index, slot })));
  const end = columns.at(-1)?.date || "";
  return e("div", { style: canvas() },
    background(e, artwork),
    box(e, clean(`${model.weekStart || ""}${end ? ` — ${end}` : ""}`, "UTC", 32), { left: 260, top: 213, width: 540, height: 30, color: "#5e6c7b", fontSize: 17, fontWeight: 900, letterSpacing: 1 }),
    ...events.flatMap((event) => weeklyEventCells(e, event, rowY[event.row])),
    fill(e, clean(`Peak risk: ${model.peakDay || "—"} · ${model.highImpactCount ?? 0} high-impact event${model.highImpactCount === 1 ? "" : "s"}`, "Monitor event clusters.", 68), { left: 160, top: 1102, width: 325, height: 72, color: "#17283a", fontSize: 17, lineHeight: 1.32, fontWeight: 800 }),
    fill(e, "BTC · ETH · DXY · US2Y", { left: 575, top: 1102, width: 300, height: 36, alignItems: "center", color: "#17283a", fontSize: 17, fontWeight: 900 }),
    portraitFooter(e, model));
}

function weeklyEventCells(e, event, top) {
  const offset = event.slot ? 365 : 0;
  const importance = Number(event.importance) >= 3 ? "HIGH" : Number(event.importance) >= 2 ? "MED" : "WATCH";
  const markets = /CPI|PCE|FOMC|RATE|PAYROLL|GDP|INFLATION/i.test(event.title) ? "BTC·DXY" : "BTC·ETH";
  const eventLabel = /\bCPI\b/i.test(event.title) ? "U.S. CPI" : /\bPCE\b/i.test(event.title) ? "U.S. PCE" : /\bFOMC\b|FED/i.test(event.title) ? "FED" : compactTitle(event.title, "EVENT", 11);
  return [
    fill(e, clean(event.time, "TBD", 8), { left: 231 + offset, top, width: 57, height: 27, justifyContent: "center", alignItems: "center", color: "#17283a", fontSize: 13, fontWeight: 900 }),
    fill(e, eventLabel, { left: 311 + offset, top, width: 82, height: 27, justifyContent: "center", alignItems: "center", color: "#17283a", fontSize: 11, lineHeight: 1.1, fontWeight: 900 }),
    fill(e, importance, { left: 411 + offset, top, width: 70, height: 27, justifyContent: "center", alignItems: "center", color: importance === "HIGH" ? "#a66c18" : "#17283a", fontSize: 12, fontWeight: 900 }),
    fill(e, markets, { left: 505 + offset, top, width: 65, height: 27, justifyContent: "center", alignItems: "center", color: "#17283a", fontSize: 11, fontWeight: 900 }),
  ];
}

function metric(e, label, value, left) {
  return fill(e, clean(value, "—", 16), {
    left: left - 32,
    top: 565,
    width: 255,
    height: 78,
    alignItems: "center",
    justifyContent: "center",
    color: valueColor(value),
    fontSize: 34,
    fontWeight: 900,
  });
}

function reaction(e, value, top) {
  return fill(e, clean(value, "—", 18), { left: 354, top, width: 115, height: 28, justifyContent: "center", alignItems: "center", background: "#f8fafc", color: valueColor(value), fontSize: 18, fontWeight: 900 });
}

function portraitFooter(e, model, top = 1288) {
  return [
    box(e, "", { left: 140, top, width: 800, height: 39, background: "rgba(248, 250, 252, 0.98)", borderRadius: 5 }),
    box(e, `SOURCE · ${footerSource(model)}`, { left: 155, top: top + 10, width: 570, height: 20, color: "#6b7784", fontSize: 10.5, fontWeight: 800 }),
    box(e, `UPDATED · ${updated(model)}`, { left: 735, top: top + 10, width: 190, height: 20, justifyContent: "flex-end", color: "#6b7784", fontSize: 10.5, fontWeight: 800 }),
  ];
}

function statusStrip(e, label, value, left, color = "#17283a") {
  return box(e, e("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" } },
    e("span", { style: { display: "flex", color: "#6b7784", fontSize: 11, fontWeight: 900, letterSpacing: .8 } }, label),
    e("span", { style: { display: "flex", marginTop: 5, color, fontSize: 14, fontWeight: 900, textAlign: "center" } }, value)),
  { left, top: 1148, width: 230, height: 66, justifyContent: "center", alignItems: "center", background: "#f8fafc" });
}

function background(e, artwork) {
  return e("img", { src: artwork, width: 1080, height: 1350, style: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" } });
}

function canvas() {
  return { position: "relative", width: "100%", height: "100%", display: "flex", overflow: "hidden", background: "#eef4f8", color: "#17283a" };
}

export function renderPortraitMarketPoster(e, model, artwork) {
  const id = model?.visualTemplate?.id;
  if (id === "daily-market-brief-v3") return daily(e, model, artwork);
  if (id === "weekly-catalysts-v3") return weekly(e, model, artwork);
  if (id === "market-follow-up-v3") return followUp(e, model, artwork);
  if (id === "data-flash-v3") return dataFlash(e, model, artwork);
  throw new Error("Market poster template is not renderable.");
}
