const COLORS = Object.freeze({
  ink: "#171714",
  paper: "#F4F0E7",
  panel: "#E8E2D6",
  soft: "#F6F2EA",
  line: "#B9B5AA",
  muted: "#77746C",
  gold: "#EFB62F",
  green: "#3F6D57",
  red: "#A3483F",
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
  return { position: "relative", width: "100%", height: "100%", display: "flex", overflow: "hidden", color: COLORS.ink, background: COLORS.paper, fontFamily: "Arial, sans-serif" };
}

function topRule(e, left, right, meta) {
  return e("div", { style: { position: "absolute", left: 56, right: 56, top: 34, display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 12, borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, fontSize: 11, fontWeight: 900, letterSpacing: 2.8 } },
    e("span", { style: { display: "flex" } }, clean(left, "MARKET INTELLIGENCE", 48).toUpperCase()),
    e("span", { style: { display: "flex" } }, clean(right, meta || "VERIFIED · UTC", 52).toUpperCase())
  );
}

function footer(e, model, middle) {
  const sources = (model?.footer?.sources || []).filter(usable).slice(0, 3).join(" · ") || "VERIFIED PUBLIC SOURCES";
  const updated = clean(model?.footer?.updatedAt, "UTC", 32).replace("T", " ").replace(/\.000Z$/, " UTC");
  return e("div", { style: { position: "absolute", left: 56, right: 56, bottom: 25, display: "flex", justifyContent: "space-between", color: COLORS.muted, fontSize: 9, fontWeight: 900, letterSpacing: 1.55 } },
    e("span", { style: { display: "flex", maxWidth: 390 } }, clean(sources, "VERIFIED PUBLIC SOURCES", 66).toUpperCase()),
    e("span", { style: { display: "flex", color: COLORS.ink } }, clean(middle, "MARKET COMMENTARY", 66).toUpperCase()),
    e("span", { style: { display: "flex" } }, clean(updated, "UTC", 32).toUpperCase())
  );
}

function ringSlash(e, options = {}) {
  const size = options.size || 520;
  return [
    e("div", { key: "ring", style: { position: "absolute", right: options.right ?? -76, top: options.top ?? -165, width: size, height: size, display: "flex", border: `${options.stroke || 56}px solid ${COLORS.ink}`, borderRadius: 999 } }),
    e("div", { key: "slash", style: { position: "absolute", right: options.slashRight ?? 132, top: options.slashTop ?? 123, width: options.slashWidth || 64, height: options.slashHeight || 410, display: "flex", background: COLORS.gold, transform: `rotate(${options.rotation ?? 11}deg)` } }),
  ];
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
    ...ringSlash(e),
    topRule(e, "DAILY MARKET BRIEF · 01 / DAILY", model.date || "VERIFIED · UTC"),
    e("div", { style: { position: "absolute", left: 56, top: 116, width: 620, display: "flex", flexDirection: "column" } },
      e("span", { style: { display: "flex", fontSize: 76, lineHeight: .86, fontWeight: 900, letterSpacing: -5 } }, "MARKET"),
      e("span", { style: { display: "flex", fontSize: 76, lineHeight: .86, fontWeight: 900, letterSpacing: -5 } }, "SIGNALS"),
      e("div", { style: { width: 620, marginTop: 37, display: "flex", flexDirection: "column", borderTop: `2px solid ${COLORS.ink}` } },
        ...stories.map((story, index) => e("div", { key: story.rank || index, style: { minHeight: 94, display: "flex", alignItems: "center", borderBottom: `1px solid ${COLORS.line}` } },
          e("span", { style: { width: 68, display: "flex", color: COLORS.muted, fontSize: 16, fontWeight: 800, letterSpacing: 2 } }, clean(story.rank, `0${index + 1}`, 3)),
          e("div", { style: { width: 465, display: "flex", flexDirection: "column" } },
            e("span", { style: { display: "flex", fontSize: 20, lineHeight: 1.2, fontWeight: 800 } }, clean(story.title, "Verified market development", 70)),
            usable(story.affected) ? e("span", { style: { display: "flex", marginTop: 5, color: COLORS.muted, fontSize: 9, fontWeight: 900, letterSpacing: 1.1 } }, clean(story.affected, "", 28).toUpperCase()) : null
          ),
          e("span", { style: { marginLeft: "auto", display: "flex", alignItems: "baseline", color: COLORS.gold, fontSize: 24, fontWeight: 900 } }, clean(story.score, "0", 3), e("span", { style: { display: "flex", marginLeft: 3, color: COLORS.muted, fontSize: 9, letterSpacing: 1 } }, "/100"))
        ))
      )
    ),
    footer(e, model, "RANKED BY VERIFIED MARKET IMPACT")
  );
}

function weeklyEvent(e, event, index, count) {
  const priority = Number(event.importance) >= 3 || event.isPriority;
  const compact = count > 2;
  return e("div", { key: event.id || `${event.title}-${index}`, style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", padding: compact ? "16px 13px 13px" : "22px 22px 18px", borderLeft: index ? `1px solid ${COLORS.line}` : "none" } },
    e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", paddingBottom: 12, borderBottom: `1px solid ${COLORS.line}` } },
      e("span", { style: { display: "flex", color: priority ? COLORS.red : COLORS.ink, fontSize: compact ? 12 : 14, fontWeight: 900, letterSpacing: 1.4 } }, clean(event.day, "EVENT", 18).toUpperCase()),
      e("span", { style: { display: "flex", color: COLORS.muted, fontSize: 9, fontWeight: 800 } }, usable(event.time) ? `${clean(event.time, "", 10)} UTC` : "TIME VERIFIED")
    ),
    e("div", { style: { display: "flex", flexDirection: "column", marginTop: 14, padding: compact ? "13px 12px" : "20px 18px", borderLeft: `5px solid ${priority ? COLORS.gold : COLORS.ink}`, background: COLORS.panel } },
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
    e("span", { style: { position: "absolute", left: 30, top: 69, display: "flex", color: "rgba(119,116,108,.13)", fontFamily: "Georgia, serif", fontSize: 292, lineHeight: 1, fontWeight: 400 } }, "W"),
    topRule(e, "WEEKLY CATALYSTS · 02 / WEEK", singleWeekLabel(model.weekStart)),
    e("span", { style: { position: "absolute", left: 56, top: 111, display: "flex", fontSize: 58, lineHeight: 1, fontWeight: 500, letterSpacing: -3.2 } }, "MARKET CALENDAR"),
    e("div", { style: { position: "absolute", left: 56, right: 56, top: 204, height: 54, display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: `2px solid ${COLORS.ink}`, borderBottom: `1px solid ${COLORS.line}` } },
      label(e, "SINGLE UTC WEEK · VERIFIED EVENTS · NO FILLER EVENTS", COLORS.ink),
      e("div", { style: { display: "flex", gap: 22 } }, label(e, `HIGH IMPACT ${events.filter((event) => Number(event.importance) >= 3 || event.isPriority).length}`, COLORS.red), label(e, `${events.length} EVENTS`, COLORS.muted))
    ),
    e("div", { style: { position: "absolute", left: 56, right: 56, top: 258, bottom: 65, display: "flex", borderBottom: `1px solid ${COLORS.line}` } },
      ...events.map((event, index) => weeklyEvent(e, event, index, events.length))
    ),
    footer(e, model, "HIGH-IMPACT EVENTS FIRST · UTC")
  );
}

function valueTile(e, labelText, value, color = COLORS.ink, width = 145) {
  if (!usable(value)) return null;
  return e("div", { style: { width, display: "flex", flexDirection: "column", padding: "13px 15px", borderTop: `4px solid ${color}`, background: COLORS.panel } },
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
    e("div", { style: { position: "absolute", right: 71, top: 58, width: 418, height: 418, display: "flex", border: `54px solid ${COLORS.ink}`, borderRadius: 999 } }),
    e("div", { style: { position: "absolute", right: 171, bottom: 83, width: 215, height: 52, display: "flex", borderRadius: 999, background: COLORS.gold } }),
    topRule(e, "DATA FLASH · 03 / RELEASE", model.source || "OFFICIAL SOURCE · UTC"),
    e("div", { style: { position: "absolute", left: 56, top: 90, width: 600, display: "flex", flexDirection: "column" } },
      e("span", { style: { display: "flex", color: COLORS.muted, fontSize: 16, fontWeight: 500, letterSpacing: 4 } }, clean(model.indicator, "OFFICIAL RELEASE", 30).toUpperCase()),
      e("span", { style: { display: "flex", marginTop: 12, fontSize: 82, lineHeight: .96, fontWeight: 500, letterSpacing: -4 } }, clean(model.actual, "OFFICIAL", 16)),
      e("div", { style: { display: "flex", gap: 11, marginTop: 18 } }, valueTile(e, "OFFICIAL PRINT", model.actual, COLORS.ink, 155), ...comparisons.map(([title, value, color]) => valueTile(e, title, value, color, comparisons.length > 2 ? 125 : 145))),
      e("span", { style: { display: "flex", marginTop: 28, fontSize: 25, lineHeight: 1.18, fontWeight: 500 } }, clean(model.verdict || model.title, `${impact} initial read; cross-asset confirmation remains necessary.`, 128)),
      signal(e, "CONFIRMATION", model.confirmation, COLORS.green),
      signal(e, "INVALIDATION", model.invalidation, COLORS.red),
      usable(model.affected) ? signal(e, "AFFECTED", model.affected, COLORS.gold) : null
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
    e("div", { style: { position: "absolute", right: -72, bottom: -235, width: 510, height: 510, display: "flex", border: `54px solid rgba(63,109,87,.10)`, borderRadius: 999 } }),
    e("div", { style: { position: "absolute", right: 122, top: 88, width: 47, height: 245, display: "flex", background: COLORS.gold, transform: "rotate(11deg)" } }),
    topRule(e, "MARKET FOLLOW-UP · 04 / REACTION", model.source || "MEASURED REACTION · UTC"),
    e("div", { style: { position: "absolute", left: 56, right: 56, top: 92, bottom: 65, display: "flex", gap: 38 } },
      e("div", { style: { width: 640, display: "flex", flexDirection: "column" } },
        label(e, clean(model.reactionWindow?.label, "OBSERVED WINDOW · UTC", 52), COLORS.red),
        e("span", { style: { display: "flex", marginTop: 10, fontFamily: "Georgia, serif", fontSize: 43, lineHeight: 1.02, fontWeight: 700, letterSpacing: -1.6 } }, clean(model.title, "Measured market response", 78)),
        e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 24, padding: "13px 0", borderTop: `2px solid ${COLORS.ink}`, borderBottom: `1px solid ${COLORS.line}` } }, label(e, "MEASURED READ", COLORS.ink), e("span", { style: { display: "flex", color: tone(status), fontSize: 16, fontWeight: 900, letterSpacing: 1.2 } }, status)),
        e("span", { style: { display: "flex", marginTop: 20, fontSize: 23, lineHeight: 1.22, fontWeight: 500 } }, clean(model.verdict, "The observed move is contextual evidence; it does not establish causation.", 175)),
        signal(e, "CONFIRMATION", model.confirmation, COLORS.green),
        signal(e, "INVALIDATION", model.invalidation, COLORS.red)
      ),
      e("div", { style: { width: 330, display: "flex", flexDirection: "column", padding: "18px 20px", borderTop: `3px solid ${COLORS.ink}`, borderBottom: `1px solid ${COLORS.line}`, background: "rgba(246,242,234,.88)" } },
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
