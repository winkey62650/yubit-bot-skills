import React from "react";
import { ImageResponse } from "next/og";

import { buildPnlCardModel, verifyPnlCardPayload } from "../../../../lib/pnl-card.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const h = React.createElement;

function row(label, value) {
  return h("div", {
    style: { display: "flex", alignItems: "baseline", gap: 18, fontSize: 35, color: "#81745f" },
  },
  h("span", { style: { minWidth: 230 } }, label),
  h("span", { style: { color: "#16130f", fontWeight: 700 } }, value));
}

function card(model) {
  const positiveMetric = model.roiLabel || model.pnlLabel;
  return h("div", {
    style: {
      width: "100%",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      background: "linear-gradient(145deg, #fffefb 0%, #f9f4ea 64%, #ead3a4 100%)",
      color: "#16130f",
      fontFamily: "Arial, sans-serif",
      position: "relative",
      overflow: "hidden",
    },
  },
  h("div", { style: { position: "absolute", right: -150, top: 180, width: 650, height: 650, borderRadius: 999, background: "radial-gradient(circle, rgba(222,175,75,.35), rgba(222,175,75,0) 70%)" } }),
  h("div", { style: { height: 24, background: "linear-gradient(90deg, #231a0d, #b18439, #f4da99, #68491d)" } }),
  h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "45px 62px 34px" } },
    h("div", { style: { display: "flex", alignItems: "center", gap: 20 } },
      h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", width: 68, height: 68, borderRadius: 20, background: "linear-gradient(145deg, #201508, #b48635)", color: "#f9df9d", fontSize: 40, fontWeight: 800 } }, "Y"),
      h("div", { style: { display: "flex", flexDirection: "column" } },
        h("span", { style: { fontSize: 38, fontWeight: 800, letterSpacing: 8 } }, "YUBIT"),
        h("span", { style: { fontSize: 17, letterSpacing: 4, color: "#9a783f" } }, "VERIFIED PERFORMANCE"))),
    h("span", { style: { fontSize: 25, color: "#756c5f" } }, model.closedAtLabel)),
  h("div", { style: { margin: "0 62px", height: 2, background: "linear-gradient(90deg, #c69a4c, rgba(198,154,76,0))" } }),
  h("div", { style: { display: "flex", flexDirection: "column", padding: "70px 68px 0", zIndex: 2 } },
    h("div", { style: { display: "flex", alignItems: "center", gap: 22, fontSize: 46, fontWeight: 800 } },
      h("span", null, model.symbol),
      h("span", { style: { color: "#c2a36a", fontWeight: 300 } }, "|"),
      h("span", { style: { color: "#08a875" } }, model.direction),
      h("span", { style: { color: "#c2a36a", fontWeight: 300 } }, "|"),
      h("span", null, model.leverageLabel)),
    h("div", { style: { fontSize: 25, color: "#8e7b5d", marginTop: 17, letterSpacing: 2 } }, `TRADER · ${model.traderName}`),
    h("div", { style: { fontSize: model.roiLabel ? 128 : 102, lineHeight: 1, color: "#08b77e", fontWeight: 850, marginTop: 85, letterSpacing: -5 } }, positiveMetric),
    model.roiLabel ? h("div", { style: { fontSize: 53, color: "#08a875", fontWeight: 750, marginTop: 34 } }, model.pnlLabel) : null),
  h("div", { style: { display: "flex", flex: 1, alignItems: "flex-end", padding: "0 68px 80px", zIndex: 2 } },
    h("div", { style: { display: "flex", flexDirection: "column", gap: 26, width: 510 } },
      row("Entry Price", model.entryPriceLabel),
      row("Exit Price", model.exitPriceLabel),
      h("div", { style: { marginTop: 18, borderRadius: 22, padding: "23px 28px", display: "flex", background: "rgba(255,255,255,.7)", border: "1px solid rgba(183,139,58,.28)", fontSize: 21, color: "#756a5b", lineHeight: 1.45 } }, "Closed result verified against the linked read-only YUBIT account.")),
    h("div", { style: { marginLeft: "auto", width: 350, height: 350, position: "relative", display: "flex", alignItems: "center", justifyContent: "center" } },
      h("div", { style: { position: "absolute", width: 320, height: 320, borderRadius: 999, border: "3px solid rgba(186,137,50,.35)", background: "radial-gradient(circle at 38% 32%, #fff4c8, #c99637 45%, #4d2d0d 78%)", boxShadow: "0 24px 70px rgba(119,72,13,.28)" } }),
      h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", width: 205, height: 205, borderRadius: 999, border: "5px solid #f8dfa0", color: "#fff7df", fontSize: 118, fontWeight: 900, zIndex: 2, textShadow: "0 6px 18px rgba(0,0,0,.3)" } }, "Y"))),
  h("div", { style: { height: 185, background: "linear-gradient(90deg, #d4aa61, #f0d497, #c09145)", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 68px" } },
    h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
      h("span", { style: { fontSize: 48, fontWeight: 850 } }, "Trade on YUBIT"),
      h("span", { style: { fontSize: 25, color: "#4a3922" } }, "Trade Crypto, Gold & Stocks on one platform")),
    h("div", { style: { fontSize: 23, fontWeight: 700, padding: "16px 22px", background: "rgba(255,255,255,.55)", borderRadius: 14 } }, "PROFIT ONLY")));
}

export async function GET(request) {
  try {
    const token = new URL(request.url).searchParams.get("token");
    const payload = verifyPnlCardPayload(token, process.env.PNL_CARD_SIGNING_SECRET);
    const model = buildPnlCardModel(payload);
    return new ImageResponse(card(model), {
      width: 1080,
      height: 1440,
      headers: { "cache-control": "private, max-age=300" },
    });
  } catch (error) {
    const expired = String(error?.message || "").includes("EXPIRED");
    return Response.json({ ok: false, error: expired ? "Card link expired" : "Invalid card link" }, { status: 401 });
  }
}
