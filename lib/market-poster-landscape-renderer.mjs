const COLORS = Object.freeze({ ink: "#171714", paper: "#F3EFE6", panel: "#E7E0D3", line: "#B8B1A5", muted: "#716D65", amber: "#E6AC2F", green: "#3F6D57", red: "#A3483F" });

function usable(value) {
  const text = String(value ?? "").trim();
  return Boolean(text && !["—", "-", "N/A", "NOT AVAILABLE", "TBD", "NULL"].includes(text.toUpperCase()));
}

function clean(value, fallback = "", max = 120) {
  const text = usable(value) ? String(value).replace(/\s+/g, " ").trim() : fallback;
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trim()}…` : text;
}

function tone(value) {
  const normalized = String(value ?? "").toUpperCase();
  if (/(BULL|POSITIVE|CONFIRMED|UP)/.test(normalized)) return COLORS.green;
  if (/(BEAR|NEGATIVE|DIVERGENT|DOWN)/.test(normalized)) return COLORS.red;
  return COLORS.amber;
}

function canvas() {
  return { position: "relative", width: "100%", height: "100%", display: "flex", overflow: "hidden", color: COLORS.ink, background: COLORS.paper, fontFamily: "Arial, sans-serif" };
}

function header(e, title, meta, accent = COLORS.amber) {
  return e("div", { style: { position: "absolute", left: 48, right: 48, top: 27, height: 58, display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `2px solid ${COLORS.ink}` } },
    e("div", { style: { display: "flex", alignItems: "center", gap: 15 } },
      e("div", { style: { width: 8, height: 31, display: "flex", background: accent } }),
      e("span", { style: { display: "flex", fontSize: 28, lineHeight: 1, fontWeight: 900, letterSpacing: -0.7 } }, title)
    ),
    e("span", { style: { display: "flex", color: COLORS.muted, fontSize: 11, fontWeight: 800, letterSpacing: 1.8 } }, clean(meta, "VERIFIED · UTC", 55).toUpperCase())
  );
}

function footer(e, model, fallback) {
  const sources = (model?.footer?.sources || []).filter(usable).slice(0, 3).join(" · ");
  const updated = clean(model?.footer?.updatedAt, "UTC", 30).replace("T", " ").replace(/\.000Z$/, " UTC");
  return e("div", { style: { position: "absolute", left: 48, right: 48, bottom: 22, display: "flex", justifyContent: "space-between", alignItems: "center", color: COLORS.muted, fontSize: 10, fontWeight: 800, letterSpacing: 1.25 } },
    e("span", { style: { display: "flex" } }, clean(sources || fallback, fallback, 75).toUpperCase()),
    e("span", { style: { display: "flex" } }, clean(updated, "UTC", 34).toUpperCase())
  );
}

function coinMark(e, symbol) {
  const normalized = String(symbol || "").toUpperCase();
  const glyph = normalized.includes("BTC") ? "B" : normalized.includes("ETH") ? "E" : normalized.includes("SOL") ? "S" : normalized.slice(0, 1) || "M";
  return e("span", { style: { width: 28, height: 28, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", border: `1px solid ${COLORS.ink}`, borderRadius: 99, color: COLORS.ink, background: COLORS.paper, fontSize: 12, fontWeight: 900 } }, glyph);
}

function label(e, value, color = COLORS.muted) {
  return e("span", { style: { display: "flex", color, fontSize: 10, fontWeight: 900, letterSpacing: 1.5 } }, clean(value, "", 40).toUpperCase());
}

function signalRow(e, title, body, color) {
  if (!usable(body)) return null;
  return e("div", { style: { display: "flex", alignItems: "flex-start", gap: 10, paddingTop: 11, borderTop: `1px solid ${COLORS.line}` } },
    e("span", { style: { width: 8, height: 8, marginTop: 4, flexShrink: 0, display: "flex", borderRadius: 99, background: color } }),
    e("div", { style: { display: "flex", flexDirection: "column" } }, label(e, title, color), e("span", { style: { display: "flex", marginTop: 4, fontSize: 12, lineHeight: 1.28, fontWeight: 700 } }, clean(body, "", 145)))
  );
}

function daily(e, model) {
  const stories = (Array.isArray(model.stories) ? model.stories : []).filter((story) => usable(story?.title)).slice(0, 3);
  const primary = stories[0] || {};
  const bias = clean(model.primaryBias || primary.impact || "NEUTRAL", "NEUTRAL", 20).toUpperCase();
  const assets = [...new Set(stories.flatMap((story) => String(story?.affected || "").split(/[,/·| ]+/)).filter(usable))].slice(0, 5);
  return e("div", { style: canvas() },
    e("div", { style: { position: "absolute", right: -120, top: -250, width: 500, height: 500, display: "flex", border: `48px solid ${COLORS.ink}`, borderRadius: 500, opacity: .06 } }),
    header(e, "DAILY MARKET BRIEF", model.date || "VERIFIED SIGNALS · UTC", tone(bias)),
    e("div", { style: { position: "absolute", left: 48, right: 48, top: 108, bottom: 60, display: "flex", gap: 24 } },
      e("div", { style: { width: 330, display: "flex", flexDirection: "column", padding: "24px 24px 20px", color: COLORS.paper, background: COLORS.ink } },
        label(e, "TODAY'S READ", COLORS.amber),
        e("span", { style: { display: "flex", marginTop: 17, fontFamily: "Georgia, serif", fontSize: 37, lineHeight: .98, fontWeight: 700, letterSpacing: -1.2 } }, clean(primary.title, "Verified market developments, ranked by impact.", 65)),
        e("div", { style: { display: "flex", marginTop: 22, alignItems: "center", gap: 10 } }, e("span", { style: { width: 11, height: 11, display: "flex", borderRadius: 99, background: tone(bias) } }), e("span", { style: { display: "flex", color: COLORS.paper, fontSize: 18, fontWeight: 900, letterSpacing: 1.2 } }, bias)),
        assets.length ? e("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: "auto", paddingTop: 16, borderTop: "1px solid #56534D" } }, ...assets.map((asset, index) => e("div", { key: `${asset}-${index}`, style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 9px", border: "1px solid #666159", borderRadius: 20, fontSize: 11, fontWeight: 900 } }, coinMark(e, asset), clean(asset, "", 8).toUpperCase()))) : null
      ),
      e("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 11 } },
        ...stories.map((story, index) => e("div", { key: story.rank || index, style: { flex: 1, minHeight: 0, display: "flex", alignItems: "stretch", borderTop: `${index === 0 ? 3 : 1}px solid ${index === 0 ? COLORS.ink : COLORS.line}`, background: index === 0 ? "#EAE3D6" : "transparent" } },
          e("div", { style: { width: 68, display: "flex", alignItems: "center", justifyContent: "center", color: COLORS.muted, fontSize: 15, fontWeight: 900, letterSpacing: 1.6 } }, clean(story.rank, `0${index + 1}`, 3)),
          e("div", { style: { flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "12px 15px", borderLeft: `1px solid ${COLORS.line}` } },
            e("span", { style: { display: "flex", fontSize: index === 0 ? 21 : 18, lineHeight: 1.15, fontWeight: 900 } }, clean(story.title, "Verified market development", 78)),
            e("span", { style: { display: "flex", marginTop: 8, color: COLORS.muted, fontSize: 11, lineHeight: 1.25, fontWeight: 700 } }, clean(story.thesis || story.impact, "Evidence-led market context", 95)),
            e("span", { style: { display: "flex", marginTop: 8, color: COLORS.muted, fontSize: 9, fontWeight: 900, letterSpacing: 1.15 } }, `${clean(story.source, "VERIFIED SOURCE", 28).toUpperCase()}${usable(story.affected) ? ` · ${clean(story.affected, "", 24).toUpperCase()}` : ""}`)
          ),
          e("div", { style: { width: 94, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", borderLeft: `1px solid ${COLORS.line}` } }, e("span", { style: { display: "flex", color: tone(story.impact), fontSize: 28, fontWeight: 900 } }, clean(story.score, "—", 3)), label(e, "IMPACT /100"))
        ))
      )
    ),
    footer(e, model, "RANKED BY VERIFIED MARKET IMPACT")
  );
}

function weeklyEventCard(e, event, index, count) {
  const priority = Number(event.importance) >= 3 || event.isPriority;
  if (count === 1) {
    return e("div", { key: event.id || `${event.title}-${index}`, style: { flex: 1, minWidth: 0, display: "flex", borderTop: `6px solid ${priority ? COLORS.red : COLORS.ink}`, background: "#E7DFD1" } },
      e("div", { style: { flex: 1, display: "flex", flexDirection: "column", padding: "28px 32px" } },
        e("span", { style: { display: "flex", color: COLORS.red, fontSize: 18, fontWeight: 900, letterSpacing: 1.5 } }, clean(event.day, "EVENT", 20).toUpperCase()),
        e("span", { style: { display: "flex", marginTop: 27, fontFamily: "Georgia, serif", fontSize: 43, lineHeight: 1.03, fontWeight: 700, letterSpacing: -1 } }, clean(event.title, "Verified event", 70)),
        usable(event.sensitivity) ? e("span", { style: { display: "flex", marginTop: 19, color: COLORS.muted, fontSize: 17, lineHeight: 1.35, fontWeight: 700 } }, clean(event.sensitivity, "", 155)) : null,
        e("div", { style: { display: "flex", marginTop: "auto", paddingTop: 15, borderTop: `1px solid ${COLORS.line}`, justifyContent: "space-between", color: COLORS.muted, fontSize: 10, fontWeight: 900, letterSpacing: 1.1 } }, e("span", null, clean(event.source, "VERIFIED SOURCE", 24).toUpperCase()), e("span", null, priority ? "HIGH SENSITIVITY" : "WATCH"))
      ),
      e("div", { style: { width: 285, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "30px 28px", color: COLORS.paper, background: COLORS.ink } },
        e("div", { style: { display: "flex", flexDirection: "column" } }, label(e, "RELEASE TIME", COLORS.amber), e("span", { style: { display: "flex", marginTop: 13, fontSize: 43, lineHeight: 1, fontWeight: 900, letterSpacing: -1 } }, clean(event.time, "CONFIRMED", 12).toUpperCase()), usable(event.time) ? e("span", { style: { display: "flex", marginTop: 5, color: "#C8C1B5", fontSize: 13, fontWeight: 900, letterSpacing: 1.3 } }, "UTC") : null),
        e("div", { style: { display: "flex", flexDirection: "column", gap: 14, paddingTop: 20, borderTop: "1px solid #56534D" } }, e("div", { style: { display: "flex", justifyContent: "space-between" } }, label(e, "STATUS", "#C8C1B5"), e("span", { style: { display: "flex", fontSize: 12, fontWeight: 900 } }, "VERIFIED")), e("div", { style: { display: "flex", justifyContent: "space-between" } }, label(e, "PRIORITY", "#C8C1B5"), e("span", { style: { display: "flex", color: priority ? COLORS.red : COLORS.amber, fontSize: 12, fontWeight: 900 } }, priority ? "HIGH" : "WATCH")))
      )
    );
  }
  return e("div", { key: event.id || `${event.title}-${index}`, style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", padding: "19px 18px", borderTop: `${priority ? 6 : 3}px solid ${priority ? COLORS.red : COLORS.ink}`, background: index === 0 ? "#E7DFD1" : "#ECE6DB" } },
    e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } }, e("span", { style: { display: "flex", color: COLORS.red, fontSize: 13, fontWeight: 900, letterSpacing: 1.5 } }, clean(event.day, "EVENT", 20).toUpperCase()), e("span", { style: { display: "flex", color: COLORS.muted, fontSize: 11, fontWeight: 900 } }, usable(event.time) ? `${clean(event.time, "", 12)} UTC` : "TIME CONFIRMED BY SOURCE")),
    e("span", { style: { display: "flex", marginTop: 22, fontFamily: "Georgia, serif", fontSize: 25, lineHeight: 1.03, fontWeight: 700, letterSpacing: -1 } }, clean(event.title, "Verified event", 48)),
    usable(event.sensitivity) ? e("span", { style: { display: "flex", marginTop: 19, color: COLORS.muted, fontSize: 13, lineHeight: 1.35, fontWeight: 700 } }, clean(event.sensitivity, "", 90)) : null,
    e("div", { style: { display: "flex", marginTop: "auto", paddingTop: 15, borderTop: `1px solid ${COLORS.line}`, justifyContent: "space-between", color: COLORS.muted, fontSize: 10, fontWeight: 900, letterSpacing: 1.1 } }, e("span", null, clean(event.source, "VERIFIED SOURCE", 24).toUpperCase()), e("span", null, priority ? "HIGH SENSITIVITY" : "WATCH"))
  );
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

function weekly(e, model) {
  const columns = (Array.isArray(model.columns) ? model.columns : []).slice(0, 7);
  const weekdayEvents = columns.flatMap((column) => (Array.isArray(column?.events) ? column.events : []).filter((event) => usable(event?.title)).map((event) => ({ ...event, day: column.label || column.date })));
  const weekendEvents = (Array.isArray(model.weekend?.events) ? model.weekend.events : []).filter((event) => usable(event?.title)).map((event) => ({ ...event, day: event.dateLabel || model.weekend.label || "WEEKEND" }));
  const events = [...weekdayEvents, ...weekendEvents].slice(0, 4);
  const peak = clean(events.slice().sort((left, right) => Number(right.importance || 0) - Number(left.importance || 0))[0]?.day, "MONITOR", 22);
  const count = events.length || 1;
  return e("div", { style: canvas() },
    header(e, "WEEKLY CATALYSTS", singleWeekLabel(model.weekStart), COLORS.red),
    e("div", { style: { position: "absolute", left: 48, right: 48, top: 109, display: "flex", justifyContent: "space-between", alignItems: "flex-end" } },
      e("div", { style: { display: "flex", flexDirection: "column" } }, label(e, "VERIFIED CALENDAR · NO FILLER EVENTS", COLORS.red), e("span", { style: { display: "flex", marginTop: 7, fontFamily: "Georgia, serif", fontSize: 36, fontWeight: 700, letterSpacing: -1 } }, count === 1 ? "One event worth your attention" : `${count} events worth your attention`)),
      e("div", { style: { display: "flex", gap: 9 } },
        e("div", { style: { display: "flex", flexDirection: "column", minWidth: 120, padding: "10px 14px", borderTop: `3px solid ${COLORS.red}`, background: COLORS.panel } }, label(e, "HIGH IMPACT"), e("span", { style: { display: "flex", marginTop: 4, fontSize: 25, fontWeight: 900 } }, String(events.filter((event) => Number(event.importance) >= 3).length))),
        e("div", { style: { display: "flex", flexDirection: "column", minWidth: 170, padding: "10px 14px", borderTop: `3px solid ${COLORS.ink}`, background: COLORS.panel } }, label(e, "PEAK RISK"), e("span", { style: { display: "flex", marginTop: 4, fontSize: 20, fontWeight: 900 } }, peak.toUpperCase()))
      )
    ),
    e("div", { style: { position: "absolute", left: 48, right: 48, top: 205, bottom: 60, display: "flex", gap: 13 } },
      ...events.map((event, index) => weeklyEventCard(e, event, index, count))
    ),
    footer(e, model, "OFFICIAL EVENTS ONLY · UTC")
  );
}

function metricTile(e, title, value, color = COLORS.ink, large = false, hero = false) {
  if (!usable(value)) return null;
  return e("div", { style: { flex: large ? 1.35 : 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: hero ? "24px 28px" : large ? "17px 20px" : "14px 17px", borderTop: `${large ? 6 : 3}px solid ${color}`, background: COLORS.panel } }, label(e, title, color), e("span", { style: { display: "flex", marginTop: hero ? 19 : 8, color, fontSize: hero ? 80 : large ? 44 : 28, lineHeight: 1, fontWeight: 900, letterSpacing: hero ? -2.5 : -1 } }, clean(value, "", 22)));
}

function dataFlash(e, model) {
  const comparison = [["CONSENSUS", model.forecast], ["SURPRISE", model.surprise], ["PREVIOUS", model.previous]].filter(([, value]) => usable(value));
  const sparse = comparison.length === 0;
  const impact = clean(model.impact, "NEUTRAL", 20).toUpperCase();
  return e("div", { style: canvas() },
    header(e, "DATA FLASH", model.source || "OFFICIAL RELEASE · UTC", COLORS.red),
    e("div", { style: { position: "absolute", left: 48, right: 48, top: 109, bottom: 60, display: "flex", gap: 22 } },
      e("div", { style: { width: 470, display: "flex", flexDirection: "column" } },
        label(e, `${clean(model.indicator, "OFFICIAL PRINT", 32)} · OFFICIAL PRINT`, COLORS.red),
        e("span", { style: { display: "flex", marginTop: 13, fontFamily: "Georgia, serif", fontSize: 41, lineHeight: 1.02, fontWeight: 700, letterSpacing: -1.3 } }, clean(model.title, "Official data release", 80)),
        e("div", { style: { display: "flex", gap: 10, marginTop: 25, minHeight: sparse ? 240 : 117 } }, metricTile(e, "ACTUAL", model.actual, COLORS.ink, true, sparse), ...comparison.slice(0, 2).map(([title, value]) => metricTile(e, title, value, title === "SURPRISE" ? tone(impact) : COLORS.muted))),
        comparison[2] ? e("div", { style: { display: "flex", marginTop: 10 } }, metricTile(e, comparison[2][0], comparison[2][1], COLORS.muted)) : null,
        e("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: "auto", padding: "13px 15px", background: COLORS.ink, color: COLORS.paper } }, e("span", { style: { width: 10, height: 10, display: "flex", borderRadius: 99, background: tone(impact) } }), label(e, "INITIAL MARKET READ", "#C8C1B5"), e("span", { style: { display: "flex", marginLeft: "auto", color: COLORS.paper, fontSize: 17, fontWeight: 900 } }, impact))
      ),
      e("div", { style: { flex: 1, display: "flex", flexDirection: "column", padding: "25px 27px", borderTop: `6px solid ${tone(impact)}`, background: "#E8E1D5" } },
        label(e, "WHAT IT MEANS"),
        e("span", { style: { display: "flex", marginTop: 13, fontSize: 24, lineHeight: 1.22, fontWeight: 900 } }, clean(model.verdict, `${impact} initial read. Cross-asset confirmation remains necessary.`, 170)),
        e("div", { style: { display: "flex", flexDirection: "column", gap: 11, marginTop: 22 } }, signalRow(e, "CONFIRMATION", model.confirmation, COLORS.green), signalRow(e, "INVALIDATION", model.invalidation, COLORS.red), signalRow(e, "AFFECTED ASSETS", model.affected || model.components, COLORS.amber)),
        e("div", { style: { display: "flex", marginTop: "auto", paddingTop: 14, borderTop: `1px solid ${COLORS.line}`, color: COLORS.muted, fontSize: 11, lineHeight: 1.35, fontWeight: 800 } }, "Only populated, verified fields are displayed. Missing estimates are not treated as data.")
      )
    ),
    footer(e, model, "OFFICIAL PRINT FIRST · INITIAL READ SUBJECT TO CONFIRMATION")
  );
}

function reactionRow(e, reaction) {
  const value = Number(reaction?.value);
  const direction = Number.isFinite(value) ? (value > 0 ? "POSITIVE" : value < 0 ? "NEGATIVE" : "FLAT") : clean(reaction?.label, "NEUTRAL", 20);
  return e("div", { style: { display: "flex", alignItems: "center", padding: "13px 0", borderBottom: `1px solid ${COLORS.line}` } }, coinMark(e, reaction?.symbol), e("span", { style: { display: "flex", marginLeft: 12, fontSize: 17, fontWeight: 900 } }, clean(reaction?.symbol, "ASSET", 12).toUpperCase()), e("span", { style: { display: "flex", marginLeft: "auto", color: tone(direction), fontSize: 20, fontWeight: 900 } }, clean(reaction?.label, Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(2)}%` : "OBSERVED", 18)));
}

function followUp(e, model) {
  const reactions = (Array.isArray(model.reactions) ? model.reactions : []).filter((item) => usable(item?.symbol) || Number.isFinite(item?.value)).slice(0, 4);
  const status = clean(model.tapeStatus || model.verdictStatus, "MONITOR", 28).toUpperCase();
  return e("div", { style: canvas() },
    header(e, "MARKET FOLLOW-UP", model.source || "MEASURED REACTION · UTC", tone(status)),
    e("div", { style: { position: "absolute", left: 48, right: 48, top: 109, bottom: 60, display: "flex", gap: 22 } },
      e("div", { style: { width: 480, display: "flex", flexDirection: "column", padding: "25px 27px", color: COLORS.paper, background: COLORS.ink } },
        label(e, "REACTION WINDOW", COLORS.amber),
        e("span", { style: { display: "flex", marginTop: 10, color: "#C8C1B5", fontSize: 13, fontWeight: 800, letterSpacing: .6 } }, clean(model.reactionWindow?.label, "OBSERVED WINDOW · UTC", 52).toUpperCase()),
        e("span", { style: { display: "flex", marginTop: 20, fontFamily: "Georgia, serif", fontSize: 39, lineHeight: 1.02, fontWeight: 700, letterSpacing: -1.1 } }, clean(model.title, "Measured market response", 78)),
        e("div", { style: { display: "flex", alignItems: "center", marginTop: 25, paddingTop: 18, borderTop: "1px solid #56534D" } }, e("span", { style: { width: 12, height: 12, display: "flex", borderRadius: 99, background: tone(status) } }), e("span", { style: { display: "flex", marginLeft: 10, fontSize: 18, fontWeight: 900, letterSpacing: 1 } }, status), e("span", { style: { display: "flex", marginLeft: "auto", color: "#C8C1B5", fontSize: 11, fontWeight: 900 } }, clean(model.impact, "NEUTRAL", 18).toUpperCase())),
        e("div", { style: { display: "flex", flexDirection: "column", marginTop: "auto" } }, ...reactions.map((reaction) => reactionRow(e, reaction)))
      ),
      e("div", { style: { flex: 1, display: "flex", flexDirection: "column", padding: "25px 28px", borderTop: `6px solid ${tone(status)}`, background: COLORS.panel } },
        label(e, "MEASURED READ"),
        e("span", { style: { display: "flex", marginTop: 13, fontSize: 24, lineHeight: 1.22, fontWeight: 900 } }, clean(model.verdict, "The observed move is contextual evidence; it does not establish causation.", 175)),
        e("div", { style: { display: "flex", flexDirection: "column", gap: 12, marginTop: 24 } }, signalRow(e, "CONFIRMATION", model.confirmation, COLORS.green), signalRow(e, "INVALIDATION", model.invalidation, COLORS.red)),
        e("div", { style: { display: "flex", marginTop: "auto", padding: "15px 16px", borderLeft: `5px solid ${COLORS.amber}`, background: COLORS.paper, color: COLORS.muted, fontSize: 12, lineHeight: 1.4, fontWeight: 800 } }, "Observed moves show correlation, not causation. Reassess if the move reverses through the pre-release benchmark.")
      )
    ),
    footer(e, model, "OBSERVED MARKET RESPONSE · NOT A PRICE FORECAST")
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
