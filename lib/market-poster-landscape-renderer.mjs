const COLORS = Object.freeze({
  ink: "#071C32",
  navy: "#0B3154",
  blue: "#0B5C89",
  cyan: "#16B8E7",
  paper: "#EEF5F8",
  panel: "#FFFFFF",
  soft: "#E2EEF4",
  line: "#BFD0DB",
  muted: "#60798C",
  gold: "#F5B83C",
  green: "#15936E",
  red: "#D85757",
});

function usable(value) {
  const text = String(value ?? "").trim();
  return Boolean(text && !["—", "-", "N/A", "NOT AVAILABLE", "TBD", "NULL"].includes(text.toUpperCase()));
}

function clean(value, fallback = "", max = 120) {
  const text = usable(value) ? String(value).replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim() : fallback;
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trim()}…` : text;
}

function tone(value) {
  const normalized = String(value ?? "").toUpperCase();
  if (/(BULL|POSITIVE|CONFIRMED|UP)/.test(normalized)) return COLORS.green;
  if (/(BEAR|NEGATIVE|DIVERGENT|DOWN)/.test(normalized)) return COLORS.red;
  return COLORS.muted;
}

function canvas() {
  return { position: "relative", width: "100%", height: "100%", display: "flex", overflow: "hidden", color: COLORS.ink, background: `linear-gradient(135deg, ${COLORS.paper} 0%, #FFFFFF 54%, #DDECF3 100%)`, fontFamily: "Arial, sans-serif" };
}

function topRule(e, left, right, meta, light = false) {
  return e("div", { style: { position: "absolute", left: 56, right: 56, top: 34, display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 12, borderBottom: `1px solid ${light ? "rgba(255,255,255,.28)" : COLORS.line}`, color: light ? "#D8EEF8" : COLORS.muted, fontSize: 11, fontWeight: 900, letterSpacing: 2.8 } },
    e("span", { style: { display: "flex" } }, clean(left, "MARKET INTELLIGENCE", 48).toUpperCase()),
    e("span", { style: { display: "flex" } }, clean(right, meta || "VERIFIED · UTC", 52).toUpperCase())
  );
}

function footer(e, model, middle) {
  const sources = (model?.footer?.sources || []).filter(usable).slice(0, 3).join(" · ") || "VERIFIED PUBLIC SOURCES";
  const updated = clean(model?.footer?.updatedAt, "UTC", 32).replace("T", " ").replace(/\.000Z$/, " UTC");
  return e("div", { style: { position: "absolute", left: 56, right: 56, bottom: 22, display: "flex", justifyContent: "space-between", color: COLORS.muted, fontSize: 9, fontWeight: 900, letterSpacing: 1.55 } },
    e("span", { style: { display: "flex", maxWidth: 390 } }, clean(sources, "VERIFIED PUBLIC SOURCES", 66).toUpperCase()),
    e("span", { style: { display: "flex", color: COLORS.ink } }, clean(middle, "MARKET COMMENTARY", 66).toUpperCase()),
    e("span", { style: { display: "flex" } }, clean(updated, "UTC", 32).toUpperCase())
  );
}

function ringSlash(e, options = {}) {
  const size = options.size || 520;
  return [
    e("div", { key: "ring", style: { position: "absolute", right: options.right ?? -76, top: options.top ?? -165, width: size, height: size, display: "flex", border: `${options.stroke || 56}px solid rgba(22,184,231,.22)`, borderRadius: 999 } }),
    e("div", { key: "slash", style: { position: "absolute", right: options.slashRight ?? 132, top: options.slashTop ?? 123, width: options.slashWidth || 64, height: options.slashHeight || 410, display: "flex", background: `linear-gradient(180deg, ${COLORS.gold}, #D98A22)`, boxShadow: "0 18px 40px rgba(245,184,60,.28)", transform: `rotate(${options.rotation ?? 11}deg)` } }),
  ];
}

function hero(e, title, kicker, meta) {
  return e("div", { style: { position: "absolute", left: 0, right: 0, top: 0, height: 220, display: "flex", overflow: "hidden", color: "#FFFFFF", background: `linear-gradient(112deg, ${COLORS.ink} 0%, ${COLORS.navy} 55%, ${COLORS.blue} 100%)` } },
    e("div", { style: { position: "absolute", left: 56, top: 82, display: "flex", flexDirection: "column" } },
      e("span", { style: { display: "flex", color: "#9EDDF3", fontSize: 11, fontWeight: 900, letterSpacing: 3 } }, clean(kicker, "VERIFIED MARKET INTELLIGENCE", 58).toUpperCase()),
      e("span", { style: { display: "flex", marginTop: 10, fontSize: 48, lineHeight: .96, fontWeight: 900, letterSpacing: -2.2 } }, clean(title, "MARKET INTELLIGENCE", 42).toUpperCase())
    ),
    usable(meta) ? e("span", { style: { position: "absolute", right: 56, bottom: 35, display: "flex", padding: "9px 14px", border: "1px solid rgba(255,255,255,.28)", borderRadius: 9, color: "#FFFFFF", background: "rgba(255,255,255,.08)", fontSize: 10, fontWeight: 900, letterSpacing: 1.4 } }, clean(meta, "", 44).toUpperCase()) : null,
    e("div", { style: { position: "absolute", right: 180, top: -115, width: 350, height: 350, display: "flex", border: `44px solid ${COLORS.cyan}`, borderRadius: 999, opacity: .18 } }),
    e("div", { style: { position: "absolute", right: 95, top: 52, width: 28, height: 185, display: "flex", background: COLORS.gold, transform: "rotate(15deg)", boxShadow: "0 15px 28px rgba(0,0,0,.18)" } })
  );
}

function label(e, value, color = COLORS.muted) {
  return e("span", { style: { display: "flex", color, fontSize: 9, fontWeight: 900, letterSpacing: 1.55 } }, clean(value, "", 64).toUpperCase());
}

function singleWeekLabel(value) {
  const input = clean(value, "THIS WEEK · UTC", 40);
  const match = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return input.toUpperCase();
  const start = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const startMonth = months[start.getUTCMonth()];
  const endMonth = months[end.getUTCMonth()];
  const startPart = startMonth === endMonth ? String(start.getUTCDate()).padStart(2, "0") : `${String(start.getUTCDate()).padStart(2, "0")} ${startMonth}`;
  return `${startPart}–${String(end.getUTCDate()).padStart(2, "0")} ${endMonth} ${end.getUTCFullYear()} · UTC`;
}

function daily(e, model) {
  const stories = (Array.isArray(model.stories) ? model.stories : []).filter((story) => usable(story?.title)).slice(0, 3);
  return e("div", { style: canvas() },
    hero(e, "DAILY MARKET BRIEF", "MARKET INTELLIGENCE · VERIFIED SIGNALS", `${clean(model.date, "UTC", 26)} · ${clean(model.primaryBias, "NEUTRAL", 16)}`),
    topRule(e, "MARKET INTELLIGENCE · 01 / DAILY", model.date || "VERIFIED · UTC", null, true),
    e("div", { style: { position: "absolute", left: 56, right: 56, top: 244, bottom: 66, display: "flex", gap: 16 } },
      ...stories.map((story, index) => e("div", { key: story.rank || index, style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", padding: "22px 20px 18px", border: `1px solid ${COLORS.line}`, borderRadius: 15, background: "rgba(255,255,255,.94)", boxShadow: "0 12px 28px rgba(7,28,50,.09)" } },
        e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
          e("span", { style: { display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: 999, color: "#FFFFFF", background: index === 0 ? COLORS.gold : COLORS.blue, fontSize: 15, fontWeight: 900 } }, clean(story.rank, `0${index + 1}`, 3)),
          e("span", { style: { display: "flex", color: tone(story.impact), fontSize: 10, fontWeight: 900, letterSpacing: 1.2 } }, clean(story.impact, "WATCH", 16).toUpperCase())
        ),
        e("span", { style: { display: "flex", marginTop: 18, fontSize: 22, lineHeight: 1.12, fontWeight: 900 } }, clean(story.title, "Verified market development", 72)),
        usable(story.thesis) ? e("span", { style: { display: "flex", marginTop: 13, color: COLORS.muted, fontSize: 12, lineHeight: 1.38, fontWeight: 650 } }, clean(story.thesis, "", 132)) : null,
        e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: "auto", paddingTop: 14, borderTop: `1px solid ${COLORS.line}` } },
          e("div", { style: { display: "flex", flexDirection: "column" } }, label(e, "AFFECTED"), e("span", { style: { display: "flex", marginTop: 6, color: COLORS.blue, fontSize: 13, fontWeight: 900 } }, clean(story.affected, "MARKET", 28).toUpperCase())),
          e("div", { style: { display: "flex", alignItems: "baseline" } }, e("span", { style: { display: "flex", color: COLORS.gold, fontSize: 28, fontWeight: 900 } }, clean(story.score, "0", 3)), e("span", { style: { display: "flex", marginLeft: 3, color: COLORS.muted, fontSize: 9, fontWeight: 800 } }, "/100"))
        )
      ))
    ),
    footer(e, model, "RANKED BY VERIFIED MARKET IMPACT")
  );
}

function weeklyEvent(e, event, index, count) {
  const priority = Number(event.importance) >= 3 || event.isPriority;
  const compact = count > 2;
  return e("div", { key: event.id || `${event.title}-${index}`, style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", padding: compact ? "16px 13px 13px" : "22px 22px 18px", border: `1px solid ${COLORS.line}`, borderRadius: 14, background: "rgba(255,255,255,.95)", boxShadow: "0 10px 24px rgba(7,28,50,.08)" } },
    e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", paddingBottom: 12, borderBottom: `1px solid ${COLORS.line}` } },
      e("span", { style: { display: "flex", color: priority ? COLORS.red : COLORS.ink, fontSize: compact ? 12 : 14, fontWeight: 900, letterSpacing: 1.4 } }, clean(event.day, "EVENT", 18).toUpperCase()),
      e("span", { style: { display: "flex", color: COLORS.muted, fontSize: 9, fontWeight: 800 } }, usable(event.time) ? `${clean(event.time, "", 10)} UTC` : "TIME VERIFIED")
    ),
    e("div", { style: { display: "flex", flexDirection: "column", marginTop: 14, padding: compact ? "13px 12px" : "20px 18px", borderLeft: `5px solid ${priority ? COLORS.gold : COLORS.cyan}`, borderRadius: 8, background: COLORS.soft } },
      label(e, priority ? "HIGH IMPACT" : "WATCH", priority ? COLORS.red : COLORS.muted),
      e("span", { style: { display: "flex", marginTop: 9, fontSize: compact ? 19 : 30, lineHeight: 1.08, fontWeight: 900 } }, clean(event.title, "Verified event", compact ? 56 : 82)),
      usable(event.sensitivity) ? e("span", { style: { display: "flex", marginTop: 13, color: COLORS.muted, fontSize: compact ? 11 : 14, lineHeight: 1.34, fontWeight: 650 } }, clean(event.sensitivity, "", compact ? 95 : 165)) : null
    ),
    e("div", { style: { display: "flex", marginTop: "auto", justifyContent: "space-between", paddingTop: 13, color: COLORS.muted, fontSize: 9, fontWeight: 900, letterSpacing: 1.1 } }, e("span", null, clean(event.source, "VERIFIED SOURCE", 24).toUpperCase()), e("span", null, priority ? "PRIORITY" : "MONITOR"))
  );
}

function weekly(e, model) {
  const columns = (Array.isArray(model.columns) ? model.columns : []).slice(0, 7);
  const weekdayEvents = columns.flatMap((column) => (Array.isArray(column?.events) ? column.events : []).filter((event) => usable(event?.title)).map((event) => ({ ...event, day: column.label || column.date })));
  const weekendEvents = (Array.isArray(model.weekend?.events) ? model.weekend.events : []).filter((event) => usable(event?.title)).map((event) => ({ ...event, day: event.dateLabel || model.weekend.label || "WEEKEND" }));
  const events = [...weekdayEvents, ...weekendEvents].slice(0, 5);
  return e("div", { style: canvas() },
    hero(e, "WEEKLY CATALYSTS", "ONE UTC WEEK · VERIFIED EVENTS", singleWeekLabel(model.weekStart)),
    topRule(e, "MARKET INTELLIGENCE · 02 / WEEK", singleWeekLabel(model.weekStart), null, true),
    e("div", { style: { position: "absolute", left: 56, right: 56, top: 236, height: 36, display: "flex", justifyContent: "space-between", alignItems: "center" } },
      label(e, "ONLY MATERIAL EVENTS · NO FILLER EVENTS", COLORS.ink),
      e("div", { style: { display: "flex", gap: 22 } }, label(e, `HIGH IMPACT ${events.filter((event) => Number(event.importance) >= 3 || event.isPriority).length}`, COLORS.red), label(e, `${events.length} EVENTS`, COLORS.blue))
    ),
    e("div", { style: { position: "absolute", left: 56, right: 56, top: 280, bottom: 64, display: "flex", gap: 12 } },
      ...events.map((event, index) => weeklyEvent(e, event, index, events.length))
    ),
    footer(e, model, "HIGH-IMPACT EVENTS FIRST · UTC")
  );
}

function valueTile(e, labelText, value, color = COLORS.ink, width = 145) {
  if (!usable(value)) return null;
  return e("div", { style: { width, display: "flex", flexDirection: "column", padding: "13px 15px", borderTop: `4px solid ${color}`, borderRadius: 10, background: COLORS.panel, boxShadow: "0 8px 20px rgba(7,28,50,.08)" } },
    label(e, labelText),
    e("span", { style: { display: "flex", marginTop: 7, color, fontSize: 26, fontWeight: 900 } }, clean(value, "", 20))
  );
}

function signal(e, title, body, color) {
  if (!usable(body)) return null;
  return e("div", { style: { display: "flex", alignItems: "flex-start", marginTop: 12 } },
    e("span", { style: { width: 100, flexShrink: 0, display: "flex", color, fontSize: 9, fontWeight: 900, letterSpacing: 1.15 } }, title),
    e("span", { style: { display: "flex", color: "#4B4944", fontSize: 11, lineHeight: 1.32, fontWeight: 650 } }, clean(body, "", 138))
  );
}

function dataFlash(e, model) {
  const impact = clean(model.impact, "NEUTRAL", 20).toUpperCase();
  const comparisons = [["CONSENSUS", model.forecast, COLORS.muted], ["SURPRISE", model.surprise, tone(impact)], ["PREVIOUS", model.previous, COLORS.muted]].filter(([, value]) => usable(value));
  return e("div", { style: canvas() },
    hero(e, "DATA FLASH", clean(model.indicator, "OFFICIAL RELEASE", 30), `${impact} · ${clean(model.source, "OFFICIAL SOURCE", 28)}`),
    topRule(e, "MARKET INTELLIGENCE · 03 / RELEASE", model.source || "OFFICIAL SOURCE · UTC", null, true),
    e("div", { style: { position: "absolute", left: 56, right: 56, top: 244, bottom: 64, display: "flex", gap: 26 } },
      e("div", { style: { width: 485, display: "flex", flexDirection: "column", padding: "22px", border: `1px solid ${COLORS.line}`, borderRadius: 15, background: "rgba(255,255,255,.96)", boxShadow: "0 12px 28px rgba(7,28,50,.09)" } },
      label(e, "OFFICIAL PRINT", COLORS.blue),
      e("span", { style: { display: "flex", marginTop: 6, fontSize: 64, lineHeight: .96, fontWeight: 900, letterSpacing: -3 } }, clean(model.actual, "OFFICIAL", 16)),
      e("div", { style: { display: "flex", gap: 10, marginTop: 18 } }, ...comparisons.map(([title, value, color]) => valueTile(e, title, value, color, comparisons.length > 2 ? 132 : 190)))
      ),
      e("div", { style: { flex: 1, display: "flex", flexDirection: "column", padding: "22px 24px", border: `1px solid ${COLORS.line}`, borderRadius: 15, background: "rgba(255,255,255,.86)" } },
      label(e, "DESK READ", COLORS.gold),
      e("span", { style: { display: "flex", marginTop: 13, fontSize: 24, lineHeight: 1.2, fontWeight: 800 } }, clean(model.verdict || model.title, `${impact} initial read; cross-asset confirmation remains necessary.`, 128)),
      signal(e, "CONFIRMATION", model.confirmation, COLORS.green),
      signal(e, "INVALIDATION", model.invalidation, COLORS.red),
      usable(model.affected) ? signal(e, "AFFECTED", model.affected, COLORS.gold) : null
      )
    ),
    footer(e, model, "ACTUAL FIRST · FORECAST IS AUXILIARY")
  );
}

function reactionRow(e, reaction) {
  const numeric = Number(reaction?.value);
  const color = Number.isFinite(numeric) && numeric < 0 ? COLORS.red : COLORS.green;
  const width = Math.min(100, Math.max(8, Math.abs(Number.isFinite(numeric) ? numeric : 0) * 120));
  return e("div", { style: { display: "flex", flexDirection: "column", padding: "11px 0", borderBottom: `1px solid ${COLORS.line}` } },
    e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
      e("span", { style: { display: "flex", fontSize: 14, fontWeight: 900, letterSpacing: 1.4 } }, clean(reaction?.symbol, "ASSET", 12).toUpperCase()),
      e("span", { style: { display: "flex", color, fontSize: 18, fontWeight: 900 } }, clean(reaction?.label, "OBSERVED", 18))
    ),
    e("div", { style: { width: "100%", height: 6, marginTop: 7, display: "flex", background: "#D7D1C6" } }, e("div", { style: { width: `${width}%`, height: "100%", display: "flex", background: color } }))
  );
}

function followUp(e, model) {
  const reactions = (Array.isArray(model.reactions) ? model.reactions : []).filter((item) => usable(item?.symbol) || Number.isFinite(item?.value)).slice(0, 4);
  const status = clean(model.tapeStatus || model.verdictStatus, "MONITOR", 28).toUpperCase();
  return e("div", { style: canvas() },
    hero(e, "MARKET FOLLOW-UP", clean(model.indicator, "MEASURED MARKET REACTION", 34), clean(model.reactionWindow?.label, "OBSERVED WINDOW · UTC", 40)),
    topRule(e, "MARKET INTELLIGENCE · 04 / REACTION", model.source || "MEASURED REACTION · UTC", null, true),
    e("div", { style: { position: "absolute", left: 56, right: 56, top: 244, bottom: 64, display: "flex", gap: 22 } },
      e("div", { style: { width: 640, display: "flex", flexDirection: "column", padding: "21px 23px", border: `1px solid ${COLORS.line}`, borderRadius: 15, background: "rgba(255,255,255,.95)", boxShadow: "0 12px 28px rgba(7,28,50,.09)" } },
        label(e, clean(model.reactionWindow?.label, "OBSERVED WINDOW · UTC", 52), COLORS.red),
        e("span", { style: { display: "flex", marginTop: 10, fontFamily: "Georgia, serif", fontSize: 43, lineHeight: 1.02, fontWeight: 700, letterSpacing: -1.6 } }, clean(model.title, "Measured market response", 78)),
        e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 24, padding: "13px 0", borderTop: `2px solid ${COLORS.ink}`, borderBottom: `1px solid ${COLORS.line}` } }, label(e, "MEASURED READ", COLORS.ink), e("span", { style: { display: "flex", color: tone(status), fontSize: 16, fontWeight: 900, letterSpacing: 1.2 } }, status)),
        e("span", { style: { display: "flex", marginTop: 20, fontSize: 23, lineHeight: 1.22, fontWeight: 500 } }, clean(model.verdict, "The observed move is contextual evidence; it does not establish causation.", 175)),
        signal(e, "CONFIRMATION", model.confirmation, COLORS.green),
        signal(e, "INVALIDATION", model.invalidation, COLORS.red)
      ),
      e("div", { style: { width: 330, display: "flex", flexDirection: "column", padding: "18px 20px", border: `1px solid ${COLORS.line}`, borderTop: `4px solid ${COLORS.cyan}`, borderRadius: 15, background: "rgba(255,255,255,.92)", boxShadow: "0 12px 28px rgba(7,28,50,.08)" } },
        e("div", { style: { display: "flex", justifyContent: "space-between", paddingBottom: 13, borderBottom: `1px solid ${COLORS.line}` } }, e("span", { style: { display: "flex", fontFamily: "Georgia, serif", fontSize: 20, fontWeight: 700 } }, "CROSS-ASSET REACTION"), label(e, clean(model.impact, "NEUTRAL", 16), tone(model.impact))),
        e("div", { style: { display: "flex", flexDirection: "column", marginTop: 9 } }, ...reactions.map((reaction) => reactionRow(e, reaction))),
        e("span", { style: { display: "flex", marginTop: "auto", paddingTop: 14, borderTop: `1px solid ${COLORS.line}`, color: COLORS.muted, fontSize: 9, lineHeight: 1.4, fontWeight: 800, letterSpacing: 1.05 } }, "OBSERVED FROM THE PRE-RELEASE BENCHMARK · CORRELATION IS NOT CAUSATION")
      )
    ),
    footer(e, model, "MEASURED RESPONSE · NOT A PRICE FORECAST")
  );
}

export function renderLandscapeMarketPoster(e, model = {}) {
  const id = String(model?.visualTemplate?.id || "");
  if (id === "daily-market-brief-v4") return daily(e, model);
  if (id === "weekly-catalysts-v4") return weekly(e, model);
  if (id === "data-flash-v4") return dataFlash(e, model);
  if (id === "market-follow-up-v4") return followUp(e, model);
  throw new Error("Unsupported landscape market poster template.");
}
