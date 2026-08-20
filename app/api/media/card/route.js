import React from "react";
import { ImageResponse } from "next/og";
import { getMediaCardTemplate, normalizePosterMetrics } from "../../../../lib/media-card-template.mjs";
import { loadMediaCardArtwork } from "../../../../lib/media-card-artwork.mjs";

export const runtime = "nodejs";

export async function GET(request) {
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const card = getMediaCardTemplate(kind);
  const metrics = normalizePosterMetrics([url.searchParams.get("m1"), url.searchParams.get("m2"), url.searchParams.get("m3")]);
  const artworkUrl = await loadMediaCardArtwork(kind);
  const e = React.createElement;
  const poster = decodePosterData(url.searchParams.get("data"));
  if (kind === "crypto-daily") {
    const stories = Array.isArray(poster.stories) ? poster.stories.slice(0, 3) : [];
    return new ImageResponse(
      e("div", { style: editorialCanvas() },
        e("div", { style: { position: "absolute", right: -58, top: -170, width: 570, height: 570, display: "flex", border: "58px solid #171714", borderRadius: "50%" } }),
        e("div", { style: { position: "absolute", right: 133, top: 126, width: 64, height: 410, display: "flex", background: "#efb62f", transform: "rotate(11deg)" } }),
        editorialHeader(e, "01 / DAILY", poster.date || "MARKET IMPACT"),
        e("div", { style: { position: "absolute", left: 56, top: 114, width: 680, display: "flex", flexDirection: "column" } },
          e("div", { style: { display: "flex", fontSize: 76, lineHeight: .86, fontWeight: 900, letterSpacing: -5 } }, "MARKET"),
          e("div", { style: { display: "flex", fontSize: 76, lineHeight: .86, fontWeight: 900, letterSpacing: -5 } }, "SIGNALS"),
          e("div", { style: { width: 620, marginTop: 38, display: "flex", flexDirection: "column", borderTop: "2px solid #171714" } },
            ...stories.map((story) => e("div", { key: story.rank, style: { display: "flex", alignItems: "center", minHeight: 96, borderBottom: "1px solid #b9b5aa" } },
              e("span", { style: { width: 68, display: "flex", color: "#77746c", fontSize: 16, fontWeight: 800, letterSpacing: 2 } }, story.rank),
              e("span", { style: { width: 465, display: "flex", fontSize: 20, lineHeight: 1.25, fontWeight: 800 } }, cleanPosterText(story.title, "Verified market development", 68)),
              e("span", { style: { marginLeft: "auto", display: "flex", alignItems: "baseline", color: "#ef9e00", fontSize: 24, fontWeight: 900 } },
                String(story.score ?? 0),
                e("span", { style: { display: "flex", marginLeft: 3, color: "#77746c", fontSize: 9, letterSpacing: 1 } }, "/100")
              )
            ))
          )
        ),
        editorialFooter(e, "RANKED BY VERIFIED MARKET IMPACT")
      ), { width: 1200, height: 675 }
    );
  }
  if (kind === "weekly-calendar") {
    const columns = Array.isArray(poster.columns) ? poster.columns.slice(0, 5) : [];
    return new ImageResponse(
      e("div", { style: editorialCanvas() },
        e("div", { style: { position: "absolute", left: 30, top: 100, display: "flex", color: "#ded9cc", fontSize: 310, lineHeight: .75, fontWeight: 900, letterSpacing: -28 } }, "W"),
        editorialHeader(e, "02 / WEEK", poster.weekStart || "UTC CALENDAR"),
        e("div", { style: { position: "absolute", left: 56, top: 118, display: "flex", fontSize: 57, lineHeight: .9, fontWeight: 900, letterSpacing: -3 } }, "MARKET\nCALENDAR"),
        e("div", { style: { position: "absolute", left: 56, right: 56, top: 270, bottom: 70, display: "flex", borderTop: "2px solid #171714" } },
          ...columns.map((column, columnIndex) => e("div", { key: columnIndex, style: { flex: 1, display: "flex", flexDirection: "column", borderLeft: columnIndex ? "1px solid #b9b5aa" : "none", padding: "18px 14px" } },
            e("div", { style: { display: "flex", fontSize: 14, fontWeight: 900, letterSpacing: 2 } }, column.label || `DAY ${columnIndex + 1}`),
            ...(column.events || []).map((event) => e("div", { key: event.id, style: { display: "flex", flexDirection: "column", marginTop: 18, padding: "10px 9px", borderLeft: `5px solid ${event.accent === "amber" ? "#efb62f" : "#171714"}`, background: "#ebe6da" } },
              e("span", { style: { display: "flex", color: "#77746c", fontSize: 11, fontWeight: 800 } }, event.time),
              e("span", { style: { display: "flex", marginTop: 4, fontSize: 14, lineHeight: 1.2, fontWeight: 800 } }, cleanPosterText(event.title, "Verified event", 44))
            ))
          ))
        ),
        editorialFooter(e, "TOP 8 · HIGH-IMPACT EVENTS FIRST")
      ), { width: 1200, height: 675 }
    );
  }
  if (kind === "data-update") {
    const impactColor = poster.impact === "Bullish" ? "#17845c" : poster.impact === "Bearish" ? "#b64232" : "#ef9e00";
    return new ImageResponse(
      e("div", { style: editorialCanvas() },
        e("div", { style: { position: "absolute", right: 72, top: 90, width: 425, height: 425, display: "flex", border: "54px solid #171714", borderRadius: "50%" } }),
        e("div", { style: { position: "absolute", right: 170, bottom: 50, width: 215, height: 82, display: "flex", background: "#efb62f", borderRadius: "50%" } }),
        editorialHeader(e, "03 / RELEASE", poster.source || "OFFICIAL DATA"),
        e("div", { style: { position: "absolute", left: 56, top: 118, width: 650, display: "flex", flexDirection: "column" } },
          e("div", { style: { display: "flex", color: "#77746c", fontSize: 16, fontWeight: 800, letterSpacing: 4 } }, poster.indicator || "DATA UPDATE"),
          e("div", { style: { display: "flex", marginTop: 10, fontSize: 112, lineHeight: .86, fontWeight: 900, letterSpacing: -7 } }, poster.actual || "—"),
          e("div", { style: { display: "flex", marginTop: 26, gap: 12 } },
            dataPill(e, "PREVIOUS", poster.previous || "—"),
            poster.forecast ? dataPill(e, "AUX FORECAST", poster.forecast) : null,
            dataPill(e, "IMPACT", poster.impact || "Neutral", impactColor)
          ),
          e("div", { style: { display: "flex", marginTop: 38, maxWidth: 620, fontSize: 25, lineHeight: 1.15, fontWeight: 900 } }, cleanPosterText(poster.title, "DATA UPDATE", 70))
        ),
        editorialFooter(e, "ACTUAL FIRST · FORECAST IS AUXILIARY")
      ), { width: 1200, height: 675 }
    );
  }
  if (kind === "events") {
    const dateLabel = cleanPosterText(url.searchParams.get("date"), "TODAY", 24);
    const subline = cleanPosterText(url.searchParams.get("subline"), "GLOBAL MARKETS · CRYPTO · COMPANIES", 72);
    return new ImageResponse(
      e("div", { style: { position: "relative", width: "100%", height: "100%", display: "flex", overflow: "hidden", color: "#f8fbff", background: "#020b19", fontFamily: "Arial" } },
        e("img", { src: artworkUrl, width: 1200, height: 675, style: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" } }),
        e("div", { style: { position: "absolute", inset: 0, display: "flex", background: "linear-gradient(90deg,rgba(1,7,18,.55) 0%,rgba(1,7,18,.28) 38%,rgba(1,7,18,0) 67%)" } }),
        e("div", { style: { position: "relative", width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: "62px 64px" } },
          e("div", { style: { width: 620, display: "flex", flexDirection: "column" } },
            e("div", { style: { display: "flex", alignItems: "center", gap: 12, marginBottom: 24, color: "#85a7c9", fontSize: 14, fontWeight: 700, letterSpacing: 4 } },
              e("span", { style: { width: 34, height: 2, display: "flex", background: "#f4a23d", boxShadow: "0 0 12px rgba(244,162,61,.75)" } }),
              e("span", null, "DAILY MARKET INTELLIGENCE")
            ),
            e("div", { style: { display: "flex", flexDirection: "column", fontSize: 73, lineHeight: 0.91, fontWeight: 900, letterSpacing: -3, textShadow: "0 5px 24px rgba(0,0,0,.75)" } },
              e("span", null, "MORNING"),
              e("span", null, "MARKET BRIEF")
            ),
            e("div", { style: { marginTop: 24, display: "flex", alignItems: "center", gap: 20 } },
              e("div", { style: { display: "flex", fontSize: 43, lineHeight: 1, fontWeight: 900, color: "#f4a23d", textShadow: "0 0 24px rgba(244,162,61,.24)" } }, dateLabel),
              e("div", { style: { width: 1, height: 32, display: "flex", background: "rgba(130,174,215,.42)" } }),
              e("div", { style: { maxWidth: 315, display: "flex", fontSize: 16, lineHeight: 1.35, fontWeight: 700, letterSpacing: 1.6, color: "#c8d9eb" } }, subline)
            )
          ),
          e("div", { style: { position: "absolute", left: 64, bottom: 66, width: 515, display: "flex", flexDirection: "column", gap: 14, padding: "24px 28px" } },
            e("div", { style: { display: "flex", alignItems: "center", gap: 16, fontSize: 21, fontWeight: 800, letterSpacing: 1.5 } },
              e("span", { style: { width: 4, height: 34, display: "flex", borderRadius: 4, background: "linear-gradient(180deg,#61c7ff,#f4a23d)", boxShadow: "0 0 15px rgba(83,190,255,.5)" } }),
              e("span", null, "KEY STORIES TO WATCH")
            ),
            e("div", { style: { display: "flex", paddingLeft: 20, fontSize: 13, fontWeight: 700, letterSpacing: 3.2, color: "#7897b6" } }, "MARKET COMMENTARY ONLY")
          )
        )
      ),
      { width: 1200, height: 675 }
    );
  }
  if (kind === "analysis") {
    const regime = cleanPosterText(url.searchParams.get("regime"), "MARKET REGIME", 24);
    const levels = cleanPosterText(url.searchParams.get("levels"), "KEY LEVELS", 52);
    const catalyst = cleanPosterText(url.searchParams.get("catalyst"), "NEXT CATALYST", 52);
    const values = [
      { value: regime, top: 270, color: "#75c7ff" },
      { value: levels, top: 479, color: "#58edf2" },
      { value: catalyst, top: 668, color: "#ffd26b" }
    ];
    return new ImageResponse(
      e("div", { style: { position: "relative", width: "100%", height: "100%", display: "flex", overflow: "hidden", color: "#f5fbff", background: "#020b18", fontFamily: "Arial" } },
        e("img", { src: artworkUrl, width: 1200, height: 675, style: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" } }),
        ...values.map((item) => e("div", {
          key: item.top,
          style: {
            position: "absolute",
            left: 905,
            top: Math.round(item.top * 0.75),
            width: 250,
            height: 70,
            display: "flex",
            alignItems: "center",
            color: item.color,
            fontSize: item.value.length > 28 ? 16 : 22,
            lineHeight: 1.25,
            fontWeight: 900,
            letterSpacing: 1.1,
            textShadow: "0 2px 12px rgba(0,0,0,.95)"
          }
        }, item.value))
      ),
      { width: 1200, height: 675 }
    );
  }
  if (kind === "whale") {
    const signal = cleanPosterText(url.searchParams.get("signal"), "LARGE ORDER", 24);
    const pair = cleanPosterText(url.searchParams.get("pair"), "BTC / USDT", 24);
    const amount = cleanPosterText(url.searchParams.get("amount"), "$—", 24);
    const price = cleanPosterText(url.searchParams.get("price"), "$—", 24);
    const status = cleanPosterText(url.searchParams.get("status"), "ORDER BOOK SNAPSHOT", 32);
    return new ImageResponse(
      e("div", { style: { position: "relative", width: "100%", height: "100%", display: "flex", overflow: "hidden", color: "#f5fbff", background: "#020914", fontFamily: "Arial" } },
        e("img", { src: artworkUrl, width: 1200, height: 675, style: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" } }),
        e("div", { style: { position: "absolute", inset: 0, display: "flex", background: "linear-gradient(90deg,rgba(1,6,16,.94) 0%,rgba(1,7,18,.75) 35%,rgba(1,7,18,.12) 65%,rgba(1,7,18,.02) 100%)" } }),
        e("div", { style: { position: "relative", width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: "52px 58px" } },
          e("div", { style: { display: "flex", alignItems: "center", gap: 14, color: "#6fcff2", fontSize: 13, fontWeight: 800, letterSpacing: 4.2 } },
            e("span", { style: { width: 38, height: 2, display: "flex", background: "#32dcff", boxShadow: "0 0 16px #32dcff" } }),
            e("span", null, "DATA-LED MARKET INTELLIGENCE")
          ),
          e("div", { style: { width: 560, marginTop: 26, display: "flex", flexDirection: "column" } },
            e("div", { style: { display: "flex", fontSize: 86, lineHeight: .82, fontWeight: 900, letterSpacing: -4, textShadow: "0 7px 30px rgba(0,0,0,.9)" } }, "WHALE ALERT"),
            e("div", { style: { marginTop: 24, display: "flex", alignItems: "center", gap: 14, color: "#38ddff", fontSize: 22, fontWeight: 800, letterSpacing: 7, textShadow: "0 0 18px rgba(50,220,255,.5)" } },
              e("span", { style: { width: 42, height: 1, display: "flex", background: "#38ddff" } }),
              e("span", null, "SMART MONEY SIGNAL")
            )
          ),
          e("div", { style: { position: "absolute", left: 58, bottom: 56, width: 560, display: "flex", flexDirection: "column", gap: 16 } },
            e("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
              e("div", { style: { display: "flex", padding: "10px 15px", border: "1px solid rgba(50,220,255,.7)", borderRadius: 5, background: "rgba(4,25,42,.72)", color: "#54e3ff", fontSize: 16, fontWeight: 900, letterSpacing: 2 } }, signal),
              e("div", { style: { display: "flex", fontSize: 20, fontWeight: 800, letterSpacing: 2.4, color: "#eef9ff" } }, pair)
            ),
            e("div", { style: { display: "flex", gap: 10 } },
              ...[["VISIBLE SIZE", amount], ["KEY LEVEL", price]].map(([label, value]) => e("div", { key: label, style: { width: 190, display: "flex", flexDirection: "column", gap: 5, padding: "13px 16px", borderTop: "1px solid rgba(91,188,225,.36)", background: "linear-gradient(180deg,rgba(8,26,44,.72),rgba(4,14,27,.6))" } },
                e("span", { style: { display: "flex", color: "#7397ab", fontSize: 10, fontWeight: 800, letterSpacing: 2.2 } }, label),
                e("span", { style: { display: "flex", color: "#f7fcff", fontSize: 26, fontWeight: 900 } }, value)
              )),
              e("div", { style: { flex: 1, display: "flex", alignItems: "center", padding: "13px 14px", borderLeft: "3px solid #36dcff", background: "rgba(4,19,34,.7)", color: "#a7dced", fontSize: 12, lineHeight: 1.35, fontWeight: 800, letterSpacing: 1.4 } }, status)
            )
          )
        )
      ),
      { width: 1200, height: 675 }
    );
  }
  return new ImageResponse(
    e("div", { style: { width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "64px", color: "#f5fbf8", background: "linear-gradient(135deg,#0b1712 0%,#10261d 58%,#17392a 100%)", fontFamily: "Arial" } },
      e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
        e("div", { style: { fontSize: 28, fontWeight: 800, letterSpacing: 4, color: card.accent } }, card.eyebrow),
        e("div", { style: { display: "flex", fontSize: 22, fontWeight: 800, letterSpacing: 2, color: "#c7d8d0" } }, card.brandLabel)
      ),
      e("div", { style: { display: "flex", flexDirection: "column" } },
        e("div", { style: { fontSize: 82, lineHeight: 1, fontWeight: 900, letterSpacing: -2 } }, card.title),
        e("div", { style: { marginTop: 18, fontSize: 34, color: "#b9d3c7" } }, card.subtitle),
        metrics.length ? e("div", { style: { display: "flex", gap: 18, marginTop: 42 } }, ...metrics.map((metric) => e("div", { key: metric, style: { display: "flex", padding: "16px 22px", border: "1px solid #416454", borderRadius: 16, background: "#173228", fontSize: 26, fontWeight: 700 } }, metric))) : null
      ),
      e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 24, color: "#91aa9f" } },
        e("div", null, card.note),
        e("div", { style: { color: card.accent } }, "EDITORIAL PREVIEW")
      )
    ),
    { width: 1200, height: 675 }
  );
}

function cleanPosterText(value, fallback, maxLength) {
  const text = String(value || fallback).replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, maxLength);
}

function decodePosterData(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function editorialCanvas() {
  return { position: "relative", width: "100%", height: "100%", display: "flex", overflow: "hidden", color: "#171714", background: "#f4f0e7", fontFamily: "Arial" };
}

function editorialHeader(e, section, meta) {
  return e("div", { style: { position: "absolute", left: 56, right: 56, top: 34, display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 12, borderBottom: "1px solid #b9b5aa", color: "#77746c", fontSize: 12, fontWeight: 900, letterSpacing: 3 } },
    e("span", null, `YUBIT MARKET INTELLIGENCE · ${section}`),
    e("span", null, cleanPosterText(meta, "VERIFIED", 52))
  );
}

function editorialFooter(e, label) {
  return e("div", { style: { position: "absolute", left: 56, right: 56, bottom: 28, display: "flex", justifyContent: "space-between", color: "#77746c", fontSize: 11, fontWeight: 900, letterSpacing: 2.2 } },
    e("span", null, label), e("span", null, "YUBIT · MARKET COMMENTARY")
  );
}

function dataPill(e, label, value, color = "#171714") {
  return e("div", { style: { minWidth: 150, display: "flex", flexDirection: "column", padding: "13px 15px", borderTop: `4px solid ${color}`, background: "#e8e2d6" } },
    e("span", { style: { display: "flex", color: "#77746c", fontSize: 10, fontWeight: 900, letterSpacing: 1.8 } }, label),
    e("span", { style: { display: "flex", marginTop: 5, color, fontSize: 25, fontWeight: 900 } }, value)
  );
}
