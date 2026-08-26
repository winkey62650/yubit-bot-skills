import React from "react";
import { ImageResponse } from "next/og.js";
import { getMediaCardTemplate, normalizePosterMetrics } from "../../../../lib/media-card-template.mjs";
import { loadMediaCardArtwork } from "../../../../lib/media-card-artwork.mjs";
import { loadMarketPosterArtwork, loadMarketPosterMaster } from "../../../../lib/market-poster-artwork.mjs";
import { renderPortraitMarketPoster } from "../../../../lib/market-poster-portrait-renderer.mjs";
import { assertLandscapeMarketPosterFits, renderLandscapeMarketPoster } from "../../../../lib/market-poster-landscape-renderer.mjs";
import { approvedMarketPosterTemplates } from "../../../../lib/market-poster-templates.mjs";

export const runtime = "nodejs";

export async function GET(request) {
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const demo = url.searchParams.get("demo") === "1";
  const card = getMediaCardTemplate(kind);
  const metrics = normalizePosterMetrics([url.searchParams.get("m1"), url.searchParams.get("m2"), url.searchParams.get("m3")]);
  const artworkUrl = kind === "whale" ? null : await loadMediaCardArtwork(kind);
  const e = React.createElement;
  const poster = normalizeEditorialPreview(kind, decodePosterData(url.searchParams.get("data")));
  if (poster.visualTemplate?.composition === "locked-master-fixed-field-overlay") {
    assertLandscapeMarketPosterFits(poster);
    return new ImageResponse(renderLandscapeMarketPoster(e, poster, await loadMarketPosterMaster(poster)), {
      width: 1200,
      height: 675,
    });
  }
  if (poster.visualTemplate) {
    const artwork = await loadMarketPosterArtwork(poster);
    return new ImageResponse(renderPortraitMarketPoster(e, poster, artwork), {
      width: 1080,
      height: 1350,
    });
  }
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
        e("div", { style: { position: "absolute", right: -115, top: -155, width: 430, height: 430, display: "flex", border: "46px solid rgba(163,72,63,.10)", borderRadius: "50%" } }),
        editorialResearchHeader(e, "WEEKLY CALENDAR", poster.weekStart || "UTC", "MACRO CATALYSTS / MARKET RISK"),
        e("div", { style: { position: "absolute", left: 56, right: 56, top: 89, display: "flex", alignItems: "flex-end", justifyContent: "space-between" } },
          e("div", { style: { display: "flex", flexDirection: "column" } },
            e("span", { style: { display: "flex", color: "#171717", fontFamily: "Georgia", fontSize: 48, lineHeight: .92, fontWeight: 700, letterSpacing: -2 } }, "The Week Ahead"),
            e("span", { style: { display: "flex", marginTop: 10, color: "#6D6A63", fontSize: 11, fontWeight: 800, letterSpacing: 2.2 } }, "FIVE-DAY CATALYST MAP · PRIORITY EVENTS IN RED")
          ),
          e("div", { style: { display: "flex", gap: 10 } },
            editorialStat(e, "HIGH IMPACT", String(poster.highImpactCount ?? 0), "#A3483F"),
            editorialStat(e, "PEAK RISK", cleanPosterText(poster.peakDay, "—", 18), "#171717")
          )
        ),
        e("div", { style: { position: "absolute", left: 56, right: 56, top: 188, bottom: 69, display: "flex", borderTop: "2px solid #171717", borderBottom: "1px solid #B8B2A7" } },
          ...columns.map((column, columnIndex) => e("div", { key: column.date || columnIndex, style: { flex: 1, display: "flex", flexDirection: "column", padding: "16px 12px 12px", borderLeft: columnIndex ? "1px solid #C9C3B8" : "none" } },
            e("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", paddingBottom: 12, borderBottom: "1px solid #C9C3B8" } },
              e("span", { style: { display: "flex", color: column.label === poster.peakDay ? "#A3483F" : "#171717", fontSize: 14, fontWeight: 900, letterSpacing: 1.4 } }, cleanPosterText(column.label, `DAY ${columnIndex + 1}`, 16)),
              e("span", { style: { display: "flex", color: "#8B877F", fontSize: 9, fontWeight: 800 } }, cleanPosterText(column.date, "", 10))
            ),
            ...(column.events || []).slice(0, 3).map((event) => e("div", { key: event.eventKey || event.id, style: { display: "flex", flexDirection: "column", marginTop: 12, padding: "10px 10px 9px", borderLeft: `4px solid ${event.isPriority ? "#A3483F" : "#171717"}`, background: event.isPriority ? "#F2E4DF" : "#F6F2EA" } },
              e("div", { style: { display: "flex", justifyContent: "space-between", color: event.isPriority ? "#A3483F" : "#6D6A63", fontSize: 9, fontWeight: 900, letterSpacing: 1.1 } },
                e("span", null, `${cleanPosterText(event.time, "TBD", 10)} UTC`),
                e("span", null, event.isPriority ? "PRIORITY" : cleanPosterText(event.source, "VERIFIED", 14))
              ),
              e("span", { style: { display: "flex", marginTop: 6, color: "#171717", fontSize: 13, lineHeight: 1.18, fontWeight: 900 } }, cleanPosterText(event.title, "Verified event", 46)),
              event.sensitivity ? e("span", { style: { display: "flex", marginTop: 7, color: "#6D6A63", fontSize: 9, lineHeight: 1.28, fontWeight: 650 } }, cleanPosterText(event.sensitivity, "", 54)) : null
            ))
          ))
        ),
        editorialResearchFooter(e, poster.footer?.sources, poster.footer?.updatedAt, "UTC · OFFICIAL SOURCES · EDITORIAL PRIORITIZATION")
      ), { width: 1200, height: 675 }
    );
  }
  if (kind === "data-update") {
    const impactColor = String(poster.impact || "").toUpperCase() === "BULLISH"
      ? "#3F6D57"
      : String(poster.impact || "").toUpperCase() === "BEARISH"
        ? "#A3483F"
        : "#6D6A63";
    const tapeStatus = cleanPosterText(poster.tapeStatus, "AWAITING CONFIRMATION", 28);
    const tapeStatusColor = tapeStatus === "CONFIRMED" ? "#3F6D57" : tapeStatus === "DIVERGENT" ? "#A3483F" : "#6D6A63";
    return new ImageResponse(
      e("div", { style: editorialCanvas() },
        e("div", { style: { position: "absolute", right: -80, bottom: -235, width: 520, height: 520, display: "flex", border: "54px solid rgba(63,109,87,.09)", borderRadius: "50%" } }),
        editorialResearchHeader(e, "DATA UPDATE", poster.source || "OFFICIAL DATA", "ACTUAL / CONSENSUS / REACTION"),
        e("div", { style: { position: "absolute", left: 56, right: 56, top: 91, display: "flex", justifyContent: "space-between" } },
          e("div", { style: { width: 615, display: "flex", flexDirection: "column" } },
            e("span", { style: { display: "flex", color: "#A3483F", fontSize: 11, fontWeight: 900, letterSpacing: 2.7 } }, poster.indicator || "OFFICIAL RELEASE"),
            e("span", { style: { display: "flex", marginTop: 8, color: "#171717", fontFamily: "Georgia", fontSize: 43, lineHeight: 1.02, fontWeight: 700, letterSpacing: -1.5 } }, cleanPosterText(poster.title, "Data Update", 72)),
            e("div", { style: { display: "flex", marginTop: 23, gap: 9 } },
              editorialValue(e, "ACTUAL", poster.actual || "—", "#171717"),
              editorialValue(e, "CONSENSUS", poster.forecast || "—", "#6D6A63"),
              editorialValue(e, "SURPRISE", poster.surprise || "—", impactColor),
              editorialValue(e, "PREVIOUS", poster.previous || "—", "#6D6A63")
            ),
            e("div", { style: { display: "flex", minHeight: 74, marginTop: 20, padding: "13px 15px", borderLeft: `4px solid ${impactColor}`, background: "#F6F2EA", color: "#3B3935", fontSize: 12, lineHeight: 1.34, fontWeight: 650 } }, cleanPosterText(poster.verdict, `${poster.impact || "Neutral"} initial read; await cross-asset confirmation.`, 132)),
            editorialSignal(e, "CONFIRMATION", cleanPosterText(poster.confirmation, "Cross-asset move holds", 126), "#3F6D57"),
            editorialSignal(e, "INVALIDATION", cleanPosterText(poster.invalidation, "Move reverses through pre-release levels", 126), "#A3483F")
          ),
          e("div", { style: { width: 445, minHeight: 460, display: "flex", flexDirection: "column", padding: "19px 20px", borderTop: "3px solid #171717", borderBottom: "1px solid #B8B2A7", background: "rgba(246,242,234,.88)" } },
            e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", paddingBottom: 14, borderBottom: "1px solid #C9C3B8" } },
              e("span", { style: { display: "flex", color: "#171717", fontFamily: "Georgia", fontSize: 21, fontWeight: 700 } }, "CROSS-ASSET REACTION"),
              e("span", { style: { display: "flex", color: tapeStatusColor, fontSize: 13, fontWeight: 900, letterSpacing: 1.4 } }, tapeStatus)
            ),
            e("div", { style: { display: "flex", flexDirection: "column", marginTop: 19, gap: 17 } },
              ...(poster.reactions || []).map((reaction) => editorialReaction(e, reaction))
            ),
            e("div", { style: { display: "flex", marginTop: "auto", paddingTop: 17, borderTop: "1px solid #C9C3B8", color: "#6D6A63", fontSize: 9, lineHeight: 1.4, fontWeight: 800, letterSpacing: 1.2 } }, "OBSERVED FROM THE PRE-RELEASE BENCHMARK · NOT A PRICE FORECAST")
          )
        ),
        editorialResearchFooter(e, poster.footer?.sources, poster.footer?.updatedAt, "OFFICIAL PRINT FIRST · INITIAL READ SUBJECT TO CONFIRMATION")
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
    const evidence = poster.evidenceSnapshot && typeof poster.evidenceSnapshot === "object"
      ? poster.evidenceSnapshot
      : {};
    const rows = Array.isArray(evidence.rows)
      ? evidence.rows.filter(isEvidenceRow).slice(0, 8)
      : [];
    const signal = cleanPosterText(poster.signal || url.searchParams.get("signal"), "MONITOR", 24);
    const pair = cleanPosterText(poster.pair || url.searchParams.get("pair"), "BTC / USDT", 24);
    const amount = cleanPosterText(poster.amount || url.searchParams.get("amount"), "$—", 24);
    const price = cleanPosterText(poster.price || url.searchParams.get("price"), "$—", 24);
    const status = cleanPosterText(poster.status || url.searchParams.get("status"), "MONITOR", 38);
    const provider = cleanPosterText(evidence.provider, "SOURCE UNAVAILABLE", 34);
    const timestamp = formatEvidenceTimestamp(evidence.sourceTimestamp);
    const markPrice = formatEvidenceNumber(evidence.markPrice, 2);
    const maxNotional = Math.max(1, ...rows.map((row) => Number(row.visibleNotional) || 0));
    const focus = rows.find((row) => row.isFocus === true);
    const focusColor = focus?.side === "ASK" ? "#ff6577" : "#2dd9a0";
    const askRows = rows.filter((row) => row.side === "ASK");
    const bidRows = rows.filter((row) => row.side === "BID");
    const interpretation = cleanPosterText(
      poster.interpretation,
      focus?.side === "ASK"
        ? "Visible sell-side liquidity may reinforce nearby resistance while it remains."
        : "Visible buy-side liquidity may reinforce nearby support while it remains.",
      128,
    );
    return new ImageResponse(
      e("div", { style: { position: "relative", width: "100%", height: "100%", display: "flex", overflow: "hidden", color: "#e9eef6", background: "#071018", fontFamily: "Arial" } },
        e("div", { style: { position: "absolute", inset: 0, display: "flex", background: "linear-gradient(135deg,#071018 0%,#0b1620 62%,#0c1b26 100%)" } }),
        e("div", { style: { position: "relative", width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: "26px 34px 22px" } },
          e("div", { style: { height: 72, display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid #263541" } },
            e("div", { style: { display: "flex", alignItems: "center", gap: 18 } },
              e("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", width: 42, height: 42, border: "1px solid #3a4a57", borderRadius: 8, color: focusColor, fontSize: 13, fontWeight: 900, letterSpacing: .8 } }, "OB"),
              e("div", { style: { display: "flex", flexDirection: "column" } },
                e("span", { style: { display: "flex", color: "#f6f8fb", fontSize: 28, fontWeight: 900, letterSpacing: -.8 } }, "ORDER BOOK SNAPSHOT"),
                e("span", { style: { display: "flex", marginTop: 3, color: "#7e91a1", fontSize: 10, fontWeight: 800, letterSpacing: 2.1 } }, "VISIBLE LIQUIDITY · VERIFIABLE MARKET EVIDENCE")
              )
            ),
            e("div", { style: { display: "flex", alignItems: "center", gap: 20 } },
              demo ? e("span", { style: { display: "flex", padding: "7px 10px", border: "1px solid #475866", borderRadius: 4, color: "#aab9c5", fontSize: 9, fontWeight: 900, letterSpacing: 1.6 } }, "DEMO PREVIEW") : null,
              e("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end" } },
                e("span", { style: { display: "flex", color: "#dce4eb", fontSize: 12, fontWeight: 800 } }, provider),
                e("span", { style: { display: "flex", marginTop: 4, color: "#748898", fontSize: 10, fontFamily: "monospace" } }, timestamp)
              )
            )
          ),
          e("div", { style: { display: "flex", flex: 1, gap: 22, paddingTop: 20, minHeight: 0 } },
            e("div", { style: { width: 760, display: "flex", flexDirection: "column", border: "1px solid #263541", borderRadius: 8, overflow: "hidden", background: "#08121b" } },
              e("div", { style: { height: 38, display: "flex", alignItems: "center", padding: "0 16px", borderBottom: "1px solid #263541", color: "#6f8495", fontSize: 10, fontWeight: 800, letterSpacing: 1.4 } },
                e("span", { style: { width: 76, display: "flex" } }, "SIDE"),
                e("span", { style: { width: 190, display: "flex", justifyContent: "flex-end" } }, "PRICE (USDT)"),
                e("span", { style: { width: 190, display: "flex", justifyContent: "flex-end" } }, "SIZE (BTC)"),
                e("span", { style: { width: 250, display: "flex", justifyContent: "flex-end" } }, "VISIBLE VALUE")
              ),
              rows.length ? e("div", { style: { display: "flex", flexDirection: "column", flex: 1 } },
                ...askRows.map((row, index) => renderEvidenceRow(e, row, `ask-${index}`, maxNotional, focusColor)),
                askRows.length && bidRows.length
                  ? e("div", { style: { height: 31, display: "flex", alignItems: "center", justifyContent: "center", borderTop: "1px solid #263541", borderBottom: "1px solid #263541", background: "#0d1a24", color: "#b8c5cf", fontFamily: "monospace", fontSize: 13, fontWeight: 800, letterSpacing: .8 } }, `MARK  ${markPrice}`)
                  : null,
                ...bidRows.map((row, index) => renderEvidenceRow(e, row, `bid-${index}`, maxNotional, focusColor))
              ) : e("div", { style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#748898", fontSize: 16, fontWeight: 800, letterSpacing: 1.4 } }, "EVIDENCE SNAPSHOT UNAVAILABLE")
            ),
            e("div", { style: { flex: 1, display: "flex", flexDirection: "column", padding: "2px 0" } },
              e("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
                e("span", { style: { display: "flex", padding: "7px 10px", border: `1px solid ${focusColor}`, borderRadius: 4, color: focusColor, fontSize: 11, fontWeight: 900, letterSpacing: 1.3 } }, signal),
                e("span", { style: { display: "flex", color: "#f5f7fa", fontSize: 17, fontWeight: 900, letterSpacing: 1.2 } }, pair)
              ),
              e("div", { style: { marginTop: 24, display: "flex", flexDirection: "column", paddingBottom: 20, borderBottom: "1px solid #263541" } },
                e("span", { style: { display: "flex", color: "#748898", fontSize: 10, fontWeight: 900, letterSpacing: 1.8 } }, "VISIBLE SIZE"),
                e("span", { style: { display: "flex", marginTop: 5, color: "#ffffff", fontSize: 43, fontWeight: 900, letterSpacing: -1.5 } }, amount),
                e("span", { style: { display: "flex", marginTop: 10, color: "#748898", fontSize: 10, fontWeight: 900, letterSpacing: 1.8 } }, "AT KEY LEVEL"),
                e("span", { style: { display: "flex", marginTop: 5, color: focusColor, fontSize: 25, fontFamily: "monospace", fontWeight: 900 } }, price)
              ),
              e("div", { style: { marginTop: 20, display: "flex", flexDirection: "column" } },
                e("span", { style: { display: "flex", color: "#748898", fontSize: 10, fontWeight: 900, letterSpacing: 1.8 } }, "MARKET READ"),
                e("span", { style: { display: "flex", marginTop: 8, color: "#d3dde5", fontSize: 15, lineHeight: 1.42, fontWeight: 650 } }, interpretation)
              ),
              e("div", { style: { marginTop: "auto", display: "flex", flexDirection: "column", gap: 8, padding: "13px 14px", borderLeft: `3px solid ${focusColor}`, background: "#0d1a24" } },
                e("span", { style: { display: "flex", color: "#eef3f7", fontSize: 12, fontWeight: 900, letterSpacing: .8 } }, status),
                e("span", { style: { display: "flex", color: "#748898", fontSize: 9, lineHeight: 1.35, fontWeight: 700, letterSpacing: .7 } }, "TRACK WHETHER THIS LEVEL REMAINS, MOVES OR IS REMOVED")
              )
            )
          ),
          e("div", { style: { height: 38, display: "flex", alignItems: "flex-end", justifyContent: "space-between", color: "#718493", fontSize: 9, fontWeight: 800, letterSpacing: 1.2 } },
            e("span", null, `SOURCE · ${provider} · ${timestamp}`),
            e("span", { style: { color: "#9aaab6" } }, "VISIBLE ORDERS · NOT EXECUTED TRADES · CAN MOVE OR CANCEL")
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

function isEvidenceRow(row) {
  return row && ["ASK", "BID"].includes(row.side)
    && Number.isFinite(Number(row.price))
    && Number.isFinite(Number(row.quantity))
    && Number.isFinite(Number(row.visibleNotional));
}

function formatEvidenceNumber(value, maximumFractionDigits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(numeric);
}

function formatEvidenceTimestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "UTC TIME UNAVAILABLE";
  return `${parsed.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function renderEvidenceRow(e, row, key, maxNotional, focusColor) {
  const sideColor = row.side === "ASK" ? "#ff6577" : "#2dd9a0";
  const priceColor = row.side === "ASK" ? "#ff8795" : "#55e5b5";
  return e("div", { key, style: { position: "relative", minHeight: 48, display: "flex", alignItems: "center", padding: "0 16px", borderBottom: "1px solid rgba(38,53,65,.52)", background: row.isFocus ? "rgba(255,255,255,.035)" : "transparent" } },
    e("div", { style: { position: "absolute", right: 0, top: 5, bottom: 5, width: `${Math.max(4, Math.round(((Number(row.visibleNotional) || 0) / maxNotional) * 43))}%`, display: "flex", background: row.side === "ASK" ? "rgba(255,101,119,.10)" : "rgba(45,217,160,.10)" } }),
    row.isFocus ? e("div", { style: { position: "absolute", left: 0, top: 0, bottom: 0, width: 4, display: "flex", background: focusColor } }) : null,
    e("span", { style: { position: "relative", width: 76, display: "flex", color: sideColor, fontSize: row.isFocus ? 9 : 11, fontWeight: 900, letterSpacing: row.isFocus ? .7 : 1.2 } }, row.isFocus ? `${row.side} FOCUS` : row.side),
    e("span", { style: { position: "relative", width: 190, display: "flex", justifyContent: "flex-end", color: priceColor, fontFamily: "monospace", fontSize: 15, fontWeight: 700 } }, formatEvidenceNumber(row.price, 2)),
    e("span", { style: { position: "relative", width: 190, display: "flex", justifyContent: "flex-end", color: "#dce4eb", fontFamily: "monospace", fontSize: 14 } }, formatEvidenceNumber(row.quantity, 4)),
    e("span", { style: { position: "relative", width: 250, display: "flex", justifyContent: "flex-end", color: row.isFocus ? "#ffffff" : "#9fb0bd", fontFamily: "monospace", fontSize: 14, fontWeight: row.isFocus ? 900 : 600 } }, cleanPosterText(row.visibleNotionalLabel, "$—", 18))
  );
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

function isPreviewObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function previewText(value, fallback = "") {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return fallback;
}

function previewTextArray(value, limit = 6) {
  return (Array.isArray(value) ? value : [])
    .map((item) => previewText(item))
    .filter(Boolean)
    .slice(0, limit);
}

function previewDataComponents(value, limit = 6) {
  return (Array.isArray(value) ? value : [])
    .filter(isPreviewObject)
    .slice(0, limit)
    .map((component) => ({
      title: previewText(component.title, "Release"),
      indicator: previewText(component.indicator),
      actual: previewText(component.actual, "—"),
      forecast: previewText(component.forecast),
      previous: previewText(component.previous),
      surprise: previewText(component.surprise),
    }));
}

function previewFooter(value) {
  const footer = isPreviewObject(value) ? value : {};
  return {
    sources: (Array.isArray(footer.sources) ? footer.sources : [])
      .map((source) => previewText(source)).filter(Boolean),
    updatedAt: previewText(footer.updatedAt),
  };
}

const APPROVED_MARKET_POSTERS = new Map(approvedMarketPosterTemplates().map((template) => [template.id, template]));

function previewVisualTemplate(value) {
  if (!isPreviewObject(value)) return null;
  const approved = APPROVED_MARKET_POSTERS.get(previewText(value.id));
  if (!approved || (approved.file || "") !== previewText(value.file) || approved.product !== previewText(value.product)
      || value.canvas?.width !== approved.canvas.width || value.canvas?.height !== approved.canvas.height) return null;
  return {
    id: approved.id,
    product: approved.product,
    file: approved.file,
    sha256: approved.sha256,
    composition: approved.composition,
    canvas: { ...approved.canvas },
    assetPath: approved.file ? `/templates/market-intelligence/${approved.file}` : null,
    version: approved.version,
  };
}

function normalizeEditorialPreview(kind, value) {
  const poster = isPreviewObject(value) ? value : {};
  if (kind === "weekly-calendar") {
    const columns = (Array.isArray(poster.columns) ? poster.columns : [])
      .filter(isPreviewObject).slice(0, 7).map((column) => ({
        date: previewText(column.date),
        label: previewText(column.label),
        events: (Array.isArray(column.events) ? column.events : [])
          .filter(isPreviewObject).slice(0, 3).map((event, eventIndex) => ({
            id: previewText(event.id, `event-${eventIndex}`),
            eventKey: previewText(event.eventKey),
            title: previewText(event.title, "Verified event"),
            posterTitle: previewText(event.posterTitle),
            time: previewText(event.time, "TBD"),
            importance: Number.isFinite(event.importance) ? event.importance : 0,
            source: previewText(event.source, "VERIFIED"),
            posterSource: previewText(event.posterSource),
            sensitivity: previewText(event.sensitivity),
            posterSensitivity: previewText(event.posterSensitivity),
            markets: previewTextArray(event.markets, 4),
            posterMarkets: previewText(event.posterMarkets),
            isPriority: event.isPriority === true,
          })),
      }));
    return {
      columns,
      footer: previewFooter(poster.footer),
      highImpactCount: Number.isFinite(poster.highImpactCount) ? poster.highImpactCount : 0,
      peakDay: previewText(poster.peakDay, "—"),
      posterSources: previewTextArray(poster.posterSources, 6),
      title: previewText(poster.title, "Weekly Catalysts"),
      visualTemplate: previewVisualTemplate(poster.visualTemplate),
      weekStart: previewText(poster.weekStart, "UTC"),
      weekend: isPreviewObject(poster.weekend) ? {
        label: previewText(poster.weekend.label, "WEEKEND"),
        events: (Array.isArray(poster.weekend.events) ? poster.weekend.events : [])
          .filter(isPreviewObject).slice(0, 3).map((event, eventIndex) => ({
            id: previewText(event.id, `weekend-event-${eventIndex}`),
            eventKey: previewText(event.eventKey),
            title: previewText(event.title, "Verified event"),
            posterTitle: previewText(event.posterTitle),
            time: previewText(event.time),
            importance: Number.isFinite(event.importance) ? event.importance : 0,
            source: previewText(event.source, "VERIFIED"),
            posterSource: previewText(event.posterSource),
            sensitivity: previewText(event.sensitivity),
            posterSensitivity: previewText(event.posterSensitivity),
            markets: previewTextArray(event.markets, 4),
            posterMarkets: previewText(event.posterMarkets),
            dateLabel: previewText(event.dateLabel),
            isPriority: event.isPriority === true,
          })),
      } : null,
    };
  }
  if (kind === "data-update") {
    return {
      actual: previewText(poster.actual, "—"),
      affected: previewText(poster.affected),
      components: previewDataComponents(poster.components, 6),
      confirmation: previewText(poster.confirmation),
      posterConfirmation: previewText(poster.posterConfirmation),
      footer: previewFooter(poster.footer),
      forecast: previewText(poster.forecast, "—"),
      impact: previewText(poster.impact, "Neutral"),
      indicator: previewText(poster.indicator, "OFFICIAL RELEASE"),
      invalidation: previewText(poster.invalidation),
      posterInvalidation: previewText(poster.posterInvalidation),
      officialSource: previewText(poster.officialSource),
      previous: previewText(poster.previous, "—"),
      posterSources: previewTextArray(poster.posterSources, 6),
      posterTitle: previewText(poster.posterTitle),
      reactions: (Array.isArray(poster.reactions) ? poster.reactions : [])
        .filter(isPreviewObject).slice(0, 4).map((reaction) => ({
          label: previewText(reaction.label, "—"),
          status: previewText(reaction.status),
          symbol: previewText(reaction.symbol, "ASSET"),
          value: Number.isFinite(reaction.value) ? reaction.value : 0,
        })),
      releaseTime: previewText(poster.releaseTime),
      revised: previewText(poster.revised),
      source: previewText(poster.source, "OFFICIAL DATA"),
      posterSource: previewText(poster.posterSource),
      surprise: previewText(poster.surprise, "—"),
      tapeStatus: previewText(poster.tapeStatus, "AWAITING CONFIRMATION"),
      title: previewText(poster.title, "Data Update"),
      verdict: previewText(poster.verdict),
      posterVerdict: previewText(poster.posterVerdict),
      verdictStatus: previewText(poster.verdictStatus, "MONITOR"),
      reactionWindow: isPreviewObject(poster.reactionWindow) ? {
        start: previewText(poster.reactionWindow.start),
        end: previewText(poster.reactionWindow.end),
        label: previewText(poster.reactionWindow.label, "OBSERVED WINDOW · UTC"),
      } : null,
      volatility: previewText(poster.volatility),
      volume: previewText(poster.volume),
      breadth: previewText(poster.breadth),
      visualTemplate: previewVisualTemplate(poster.visualTemplate),
    };
  }
  return { ...poster, visualTemplate: previewVisualTemplate(poster.visualTemplate) };
}

function editorialCanvas() {
  return { position: "relative", width: "100%", height: "100%", display: "flex", overflow: "hidden", color: "#171714", background: "#f4f0e7", fontFamily: "Arial" };
}

function editorialHeader(e, section, meta) {
  return e("div", { style: { position: "absolute", left: 56, right: 56, top: 34, display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 12, borderBottom: "1px solid #b9b5aa", color: "#77746c", fontSize: 12, fontWeight: 900, letterSpacing: 3 } },
    e("span", null, `MARKET INTELLIGENCE · ${section}`),
    e("span", null, cleanPosterText(meta, "VERIFIED", 52))
  );
}

function editorialFooter(e, label) {
  return e("div", { style: { position: "absolute", left: 56, right: 56, bottom: 28, display: "flex", justifyContent: "space-between", color: "#77746c", fontSize: 11, fontWeight: 900, letterSpacing: 2.2 } },
    e("span", null, label), e("span", null, "MARKET COMMENTARY")
  );
}

function dataPill(e, label, value, color = "#171714") {
  return e("div", { style: { minWidth: 150, display: "flex", flexDirection: "column", padding: "13px 15px", borderTop: `4px solid ${color}`, background: "#e8e2d6" } },
    e("span", { style: { display: "flex", color: "#77746c", fontSize: 10, fontWeight: 900, letterSpacing: 1.8 } }, label),
    e("span", { style: { display: "flex", marginTop: 5, color, fontSize: 25, fontWeight: 900 } }, value)
  );
}

function editorialResearchHeader(e, section, meta, descriptor) {
  return e("div", { style: {
    position: "absolute", left: 56, right: 56, top: 31, display: "flex", justifyContent: "space-between",
    alignItems: "center", paddingBottom: 12, borderBottom: "1px solid #B8B2A7", color: "#6D6A63",
    fontSize: 10, fontWeight: 900, letterSpacing: 2,
  } },
  e("span", { style: { display: "flex", color: "#A3483F" } }, `EDITORIAL RESEARCH / ${section}`),
  e("span", { style: { display: "flex" } }, cleanPosterText(descriptor, "VERIFIED RESEARCH", 52)),
  e("span", { style: { display: "flex", color: "#171717" } }, cleanPosterText(meta, "UTC", 36)));
}

function editorialResearchFooter(e, sources, updatedAt, label) {
  const sourceLabel = (Array.isArray(sources) ? sources : [])
    .map((source) => cleanPosterText(source, "", 24)).filter(Boolean).join(" · ") || "VERIFIED PUBLIC SOURCES";
  const updatedLabel = cleanPosterText(String(updatedAt || "").replace("T", " ").replace(/\.000Z$/, " UTC"), "UTC", 32);
  return e("div", { style: {
    position: "absolute", left: 56, right: 56, bottom: 24, display: "flex", justifyContent: "space-between",
    color: "#6D6A63", fontSize: 9, fontWeight: 900, letterSpacing: 1.35,
  } },
  e("span", { style: { display: "flex", maxWidth: 445 } }, cleanPosterText(sourceLabel, "VERIFIED PUBLIC SOURCES", 72)),
  e("span", { style: { display: "flex", color: "#171717" } }, label),
  e("span", { style: { display: "flex" } }, updatedLabel));
}

function editorialStat(e, label, value, color) {
  return e("div", { style: { minWidth: 112, display: "flex", flexDirection: "column", padding: "8px 11px", borderTop: `3px solid ${color}`, background: "#F6F2EA" } },
    e("span", { style: { display: "flex", color: "#6D6A63", fontSize: 8, fontWeight: 900, letterSpacing: 1.2 } }, label),
    e("span", { style: { display: "flex", marginTop: 4, color, fontSize: 17, fontWeight: 900 } }, value));
}

function editorialValue(e, label, value, color) {
  return e("div", { style: { width: 138, display: "flex", flexDirection: "column", padding: "12px", borderTop: `3px solid ${color}`, background: "#F6F2EA" } },
    e("span", { style: { display: "flex", color: "#6D6A63", fontSize: 8, fontWeight: 900, letterSpacing: 1.25 } }, label),
    e("span", { style: { display: "flex", marginTop: 5, color, fontSize: 23, fontWeight: 900 } }, cleanPosterText(value, "—", 18)));
}

function editorialSignal(e, label, value, color) {
  return e("div", { style: { display: "flex", marginTop: 12, alignItems: "flex-start" } },
    e("span", { style: { width: 93, display: "flex", flexShrink: 0, color, fontSize: 9, fontWeight: 900, letterSpacing: 1.15 } }, label),
    e("span", { style: { display: "flex", color: "#4B4944", fontSize: 10, lineHeight: 1.3, fontWeight: 650 } }, value));
}

function editorialReaction(e, reaction) {
  const numeric = Number(reaction?.value) || 0;
  const color = numeric >= 0 ? "#3F6D57" : "#A3483F";
  const width = Math.min(100, Math.max(8, Math.abs(numeric) * 30));
  return e("div", { style: { display: "flex", flexDirection: "column" } },
    e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
      e("span", { style: { display: "flex", color: "#3B3935", fontSize: 12, fontWeight: 900, letterSpacing: 1.4 } }, cleanPosterText(reaction?.symbol, "ASSET", 12)),
      e("span", { style: { display: "flex", color, fontSize: 16, fontWeight: 900 } }, cleanPosterText(reaction?.label, "—", 18))),
    e("div", { style: { width: "100%", height: 7, marginTop: 8, display: "flex", background: "#D7D1C6" } },
      e("div", { style: { width: `${width}%`, height: "100%", display: "flex", background: color } })));
}
