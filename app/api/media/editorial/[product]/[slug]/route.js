import React from "react";
import { ImageResponse } from "next/og.js";
import { getDistributionRepository } from "../../../../../../lib/distribution-repository.mjs";
import { getMarketPublication, marketPublicationKey } from "../../../../../../lib/market-publication.mjs";
import { loadMarketPosterArtwork, loadMarketPosterMaster } from "../../../../../../lib/market-poster-artwork.mjs";
import { renderPortraitMarketPoster } from "../../../../../../lib/market-poster-portrait-renderer.mjs";
import { renderLandscapeMarketPoster } from "../../../../../../lib/market-poster-landscape-renderer.mjs";
import { marketPosterCanvas } from "../../../../../../lib/market-poster-templates.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRODUCTS = new Set(["weekly-calendar", "data-update"]);
const CANVAS = Object.freeze({ width: 1200, height: 675 });

function message(status, text) {
  return new Response(text, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function canonicalSlug(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 160) return null;
  if (!value.includes("%")) return value;
  try {
    const decoded = decodeURIComponent(value);
    return encodeURIComponent(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object"
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function isString(value) {
  return typeof value === "string";
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableString(value) {
  return value === null || isString(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(isString);
}

function hasEditorialFrame(model) {
  return isPlainObject(model)
    && isPlainObject(model.canvas)
    && model.canvas?.width === CANVAS.width
    && model.canvas?.height === CANVAS.height
    && isString(model.masthead)
    && model.masthead.length > 0
    && isPlainObject(model.palette)
    && ["paper", "ink", "muted", "red", "green"].every((token) => isString(model.palette[token]) && model.palette[token].length > 0)
    && isPlainObject(model.footer)
    && isStringArray(model.footer.sources)
    && isString(model.footer.updatedAt)
    && model.footer.timezone === "UTC";
}

function isWeeklyEvent(event) {
  return isPlainObject(event)
    && isString(event.id)
    && isString(event.eventKey)
    && isString(event.title)
    && isString(event.time)
    && typeof event.isPriority === "boolean"
    && ["sensitivity", "scenario", "source"].every((field) => isString(event[field]));
}

function isWeeklyColumn(column) {
  return isPlainObject(column)
    && isString(column.date)
    && isString(column.label)
    && Array.isArray(column.events)
    && column.events.every(isWeeklyEvent);
}

function isWeeklyWeekend(weekend) {
  return weekend === undefined || weekend === null || (
    isPlainObject(weekend)
    && isString(weekend.label)
    && Array.isArray(weekend.events)
    && weekend.events.every(isWeeklyEvent)
  );
}

function isDataComponent(component) {
  return isPlainObject(component)
    && ["title", "indicator", "actual"].every((field) => isString(component[field]))
    && ["forecast", "previous", "surprise"].every((field) => isNullableString(component[field]));
}

function isDataReaction(reaction) {
  return isPlainObject(reaction)
    && isString(reaction.symbol)
    && isString(reaction.label)
    && isFiniteNumber(reaction.value);
}

function isReactionWindow(window) {
  return window === null || (
    isPlainObject(window)
    && isString(window.label)
  );
}

function isRenderablePoster(product, model) {
  if (!hasEditorialFrame(model) || model.kind !== product) return false;
  if (product === "weekly-calendar") {
    return isString(model.title)
      && isString(model.weekStart)
      && isFiniteNumber(model.highImpactCount)
      && isString(model.peakDay)
      && Array.isArray(model.columns)
      && model.columns.length === 5
      && model.columns.every(isWeeklyColumn)
      && isWeeklyWeekend(model.weekend);
  }
  return [
    "title", "indicator", "impact", "actual", "verdictStatus", "verdict", "confirmation", "invalidation",
  ].every((field) => isString(model[field]))
    && ["previous", "forecast", "forecastLabel", "surprise"].every((field) => isNullableString(model[field]))
    && Array.isArray(model.components)
    && model.components.every(isDataComponent)
    && Array.isArray(model.reactions)
    && model.reactions.every(isDataReaction)
    && isReactionWindow(model.reactionWindow);
}

function sourceLine(footer) {
  const sources = footer.sources.filter((source) => typeof source === "string" && source.trim()).join(" · ");
  return sources || "VERIFIED PUBLIC SOURCES";
}

function updatedLine(footer) {
  const updated = typeof footer.updatedAt === "string" && footer.updatedAt
    ? footer.updatedAt.replace("T", " ").replace(/\.000Z$/, " UTC")
    : "UPDATE TIME UNAVAILABLE";
  return `${footer.timezone} · ${updated}`;
}

function canvasStyle(model) {
  return {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    position: "relative",
    overflow: "hidden",
    padding: "34px 42px 30px",
    background: model.palette.paper,
    color: model.palette.ink,
    fontFamily: "Arial, Helvetica, sans-serif",
  };
}

function masthead(e, model, section) {
  return e("div", {
    style: {
      height: 35,
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      borderBottom: `1px solid ${model.palette.ink}`,
      fontSize: 12,
      fontWeight: 800,
      letterSpacing: 1.8,
    },
  },
  e("span", { style: { display: "flex" } }, model.masthead),
  e("span", { style: { display: "flex", color: model.palette.muted } }, section));
}

function footer(e, model) {
  return e("div", {
    style: {
      position: "absolute",
      left: 42,
      right: 42,
      bottom: 24,
      display: "flex",
      justifyContent: "space-between",
      paddingTop: 9,
      borderTop: `1px solid ${model.palette.ink}`,
      color: model.palette.muted,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: 1.1,
    },
  },
  e("span", { style: { display: "flex", maxWidth: 760 } }, `SOURCES · ${sourceLine(model.footer)}`),
  e("span", { style: { display: "flex" } }, updatedLine(model.footer)));
}

function weeklyPoster(e, model) {
  const weekend = model.weekend?.events?.length ? model.weekend : null;
  return e("div", { style: canvasStyle(model) },
    masthead(e, model, `WEEK OF ${model.weekStart || "—"}`),
    e("div", {
      style: {
        height: 111,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        paddingBottom: 17,
      },
    },
    e("div", { style: { display: "flex", flexDirection: "column" } },
      e("span", { style: { display: "flex", fontSize: 47, lineHeight: 0.96, fontWeight: 900, letterSpacing: -2.2 } }, model.title),
      e("span", { style: { display: "flex", marginTop: 11, color: model.palette.muted, fontSize: 12, fontWeight: 700, letterSpacing: 1.6 } }, "IMPACT-RANKED CATALYSTS · TWO-SIDED SCENARIOS")),
    e("div", { style: { display: "flex", gap: 28, textAlign: "right" } },
      e("div", { style: { display: "flex", flexDirection: "column" } },
        e("span", { style: { display: "flex", color: model.palette.muted, fontSize: 10, fontWeight: 800, letterSpacing: 1.5 } }, "HIGH IMPACT"),
        e("span", { style: { display: "flex", justifyContent: "flex-end", marginTop: 3, color: model.palette.red, fontSize: 31, fontWeight: 900 } }, String(model.highImpactCount ?? 0))),
      e("div", { style: { display: "flex", flexDirection: "column" } },
        e("span", { style: { display: "flex", color: model.palette.muted, fontSize: 10, fontWeight: 800, letterSpacing: 1.5 } }, "PEAK RISK"),
        e("span", { style: { display: "flex", justifyContent: "flex-end", marginTop: 7, fontSize: 17, fontWeight: 900 } }, model.peakDay || "—")))),
    e("div", {
      style: {
        height: weekend ? 365 : 402,
        display: "flex",
        borderTop: `2px solid ${model.palette.ink}`,
        borderBottom: `1px solid ${model.palette.ink}`,
      },
    }, ...model.columns.map((column, columnIndex) => e("div", {
      key: `${column.date}:${column.label}`,
      style: {
        width: "20%",
        display: "flex",
        flexDirection: "column",
        padding: columnIndex === 0 ? "13px 12px 12px 0" : "13px 12px",
        borderLeft: columnIndex === 0 ? "none" : `1px solid ${model.palette.muted}66`,
      },
    },
    e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 11 } },
      e("span", { style: { display: "flex", fontSize: 14, fontWeight: 900, letterSpacing: 1 } }, column.label),
      e("span", { style: { display: "flex", color: model.palette.muted, fontSize: 9 } }, column.date)),
    ...(column.events.slice(0, 2).length
      ? column.events.slice(0, 2).map((event) => e("div", {
        key: event.eventKey || event.id,
        style: {
          display: "flex",
          flexDirection: "column",
          marginBottom: 10,
          padding: "10px 9px",
          borderTop: `3px solid ${event.isPriority ? model.palette.red : model.palette.muted}`,
          background: event.isPriority ? "rgba(163,72,63,.08)" : "rgba(255,255,255,.28)",
        },
      },
      e("div", { style: { display: "flex", justifyContent: "space-between", color: event.isPriority ? model.palette.red : model.palette.muted, fontSize: 9, fontWeight: 900, letterSpacing: 0.7 } },
        e("span", { style: { display: "flex" } }, event.time ? `${event.time} UTC` : "TIME TBD"),
        e("span", { style: { display: "flex" } }, event.isPriority ? "PRIORITY" : "WATCH")),
      e("span", { style: { display: "flex", marginTop: 7, fontSize: 14, lineHeight: 1.14, fontWeight: 900 } }, event.title),
      event.sensitivity ? e("span", { style: { display: "flex", marginTop: 7, color: model.palette.green, fontSize: 9, lineHeight: 1.25, fontWeight: 800 } }, event.sensitivity) : null,
      event.scenario ? e("span", { style: { display: "flex", marginTop: 6, color: model.palette.muted, fontSize: 9, lineHeight: 1.28 } }, event.scenario) : null,
      event.source ? e("span", { style: { display: "flex", marginTop: "auto", paddingTop: 7, color: model.palette.muted, fontSize: 8, fontWeight: 800 } }, `SOURCE · ${event.source}`) : null))
      : [e("span", { key: "empty", style: { display: "flex", marginTop: 8, color: model.palette.muted, fontSize: 10 } }, "NO MATERIAL EVENT")])))),
    weekend ? e("div", {
      style: {
        height: 38,
        display: "flex",
        alignItems: "center",
        marginTop: 8,
        padding: "0 12px",
        background: model.palette.ink,
        color: model.palette.paper,
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: 1.1,
      },
    }, `${weekend.label} · ${weekend.events.map((event) => `${event.time || "TBD"} ${event.title}`).join(" · ")}`) : null,
    footer(e, model));
}

function factBox(e, model, label, value, accent = model.palette.ink) {
  return e("div", {
    style: {
      flex: 1,
      display: "flex",
      flexDirection: "column",
      padding: "12px 13px",
      borderTop: `3px solid ${accent}`,
      background: "rgba(255,255,255,.32)",
    },
  },
  e("span", { style: { display: "flex", color: model.palette.muted, fontSize: 9, fontWeight: 800, letterSpacing: 1.1 } }, label),
  e("span", { style: { display: "flex", marginTop: 6, color: accent, fontSize: 28, fontWeight: 900, letterSpacing: -0.8 } }, value || "—"));
}

function dataPoster(e, model) {
  const impactColor = /bullish|positive/i.test(model.impact) ? model.palette.green
    : /bearish|negative/i.test(model.impact) ? model.palette.red : model.palette.ink;
  const statusColor = model.verdictStatus === "CONFIRMED" ? model.palette.green
    : model.verdictStatus === "DIVERGENT" ? model.palette.red : model.palette.muted;
  return e("div", { style: canvasStyle(model) },
    masthead(e, model, "OFFICIAL RELEASE · OBSERVED MARKET REACTION"),
    e("div", { style: { display: "flex", flex: 1, paddingTop: 24, paddingBottom: 50 } },
      e("div", { style: { width: 672, display: "flex", flexDirection: "column", paddingRight: 30, borderRight: `1px solid ${model.palette.muted}77` } },
        e("span", { style: { display: "flex", color: model.palette.muted, fontSize: 12, fontWeight: 800, letterSpacing: 2 } }, model.indicator || "DATA UPDATE"),
        e("span", { style: { display: "flex", marginTop: 7, minHeight: 74, fontSize: 43, lineHeight: 0.98, fontWeight: 900, letterSpacing: -2 } }, model.title),
        e("div", { style: { display: "flex", gap: 8, marginTop: 17 } },
          factBox(e, model, "ACTUAL", model.actual, impactColor),
          factBox(e, model, model.forecastLabel || "FORECAST", model.forecast),
          factBox(e, model, "SURPRISE", model.surprise, impactColor),
          factBox(e, model, "PREVIOUS", model.previous, model.palette.muted)),
        e("div", { style: { display: "flex", flexDirection: "column", marginTop: 18, padding: "14px 16px", borderLeft: `4px solid ${impactColor}`, background: "rgba(255,255,255,.32)" } },
          e("span", { style: { display: "flex", color: impactColor, fontSize: 10, fontWeight: 900, letterSpacing: 1.3 } }, `INITIAL DATA SIGNAL · ${(model.impact || "NEUTRAL").toUpperCase()}`),
          e("span", { style: { display: "flex", marginTop: 7, color: model.palette.ink, fontSize: 13, lineHeight: 1.32, fontWeight: 700 } }, model.verdict || "Interpretation awaits verified cross-asset evidence.")),
        e("div", { style: { display: "flex", gap: 12, marginTop: 14 } },
          e("div", { style: { flex: 1, display: "flex", flexDirection: "column", paddingTop: 9, borderTop: `2px solid ${model.palette.green}` } },
            e("span", { style: { display: "flex", color: model.palette.green, fontSize: 9, fontWeight: 900, letterSpacing: 1 } }, "CONFIRMATION"),
            e("span", { style: { display: "flex", marginTop: 5, color: model.palette.muted, fontSize: 10, lineHeight: 1.3 } }, model.confirmation || "Await sustained cross-asset confirmation.")),
          e("div", { style: { flex: 1, display: "flex", flexDirection: "column", paddingTop: 9, borderTop: `2px solid ${model.palette.red}` } },
            e("span", { style: { display: "flex", color: model.palette.red, fontSize: 9, fontWeight: 900, letterSpacing: 1 } }, "INVALIDATION"),
            e("span", { style: { display: "flex", marginTop: 5, color: model.palette.muted, fontSize: 10, lineHeight: 1.3 } }, model.invalidation || "First move reverses through the pre-release range."))),
      ),
      e("div", { style: { flex: 1, display: "flex", flexDirection: "column", paddingLeft: 30 } },
        e("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", paddingBottom: 13, borderBottom: `2px solid ${model.palette.ink}` } },
          e("span", { style: { display: "flex", fontSize: 18, fontWeight: 900 } }, "MARKET CONFIRMATION"),
          e("span", { style: { display: "flex", color: statusColor, fontSize: 11, fontWeight: 900, letterSpacing: 1.1 } }, model.verdictStatus)),
        e("span", { style: { display: "flex", marginTop: 13, color: model.palette.muted, fontSize: 10, fontWeight: 700 } }, model.reactionWindow?.label || "REACTION WINDOW NOT YET VERIFIED"),
        e("div", { style: { display: "flex", flexDirection: "column", marginTop: 14 } },
          ...model.reactions.slice(0, 4).map((reaction) => {
            const color = reaction.value > 0 ? model.palette.green : reaction.value < 0 ? model.palette.red : model.palette.muted;
            const width = `${Math.min(100, Math.max(8, Math.abs(reaction.value) * 28))}%`;
            return e("div", { key: reaction.symbol, style: { display: "flex", flexDirection: "column", marginBottom: 17 } },
              e("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 900 } },
                e("span", { style: { display: "flex" } }, reaction.symbol),
                e("span", { style: { display: "flex", color } }, reaction.label)),
              e("div", { style: { display: "flex", height: 5, marginTop: 7, background: `${model.palette.muted}33` } },
                e("div", { style: { display: "flex", width, background: color } })));
          })),
        e("div", { style: { display: "flex", flexDirection: "column", marginTop: "auto", padding: "13px 14px", background: model.palette.ink, color: model.palette.paper } },
          e("span", { style: { display: "flex", fontSize: 9, fontWeight: 900, letterSpacing: 1.2 } }, "OBSERVATION STANDARD"),
          e("span", { style: { display: "flex", marginTop: 6, color: model.palette.paper, fontSize: 10, lineHeight: 1.32 } }, "Price moves are observations inside the named window, not proof of causality."))),
    ),
    footer(e, model));
}

function renderPoster(model) {
  const e = React.createElement;
  return model.kind === "weekly-calendar" ? weeklyPoster(e, model) : dataPoster(e, model);
}

function etagMatches(request, etag) {
  const candidates = request.headers.get("if-none-match")?.split(",").map((value) => value.trim()) ?? [];
  const weakComparison = request.method === "GET" || request.method === "HEAD";
  const opaqueTag = (value) => value.startsWith("W/") ? value.slice(2) : value;
  return candidates.some((candidate) => candidate === "*"
    || (weakComparison ? opaqueTag(candidate) === opaqueTag(etag) : candidate === etag));
}

export async function GET(request, context = {}) {
  const params = await context.params;
  const product = params?.product;
  if (!PRODUCTS.has(product)) return message(404, "Editorial product not found.");

  const slug = canonicalSlug(params?.slug);
  if (!slug) return message(400, "Invalid editorial publication slug.");
  try {
    marketPublicationKey(product, slug);
  } catch {
    return message(400, "Invalid editorial publication slug.");
  }

  let bundle;
  try {
    const repository = context.repository ?? await getDistributionRepository();
    bundle = await getMarketPublication({ repository, product, slug });
  } catch {
    return message(500, "Editorial publication unavailable.");
  }
  if (bundle === null) return message(404, "Editorial publication not found.");
  if (!isRenderablePoster(product, bundle.posterModel)) {
    return message(422, "Editorial publication cannot be rendered.");
  }

  if (bundle.imageAsset?.base64) {
    const bytes = Buffer.from(bundle.imageAsset.base64, "base64");
    const etag = `"${bundle.imageAsset.sha256}"`;
    const headers = {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": String(bytes.byteLength),
      "Content-Type": "image/png",
      ETag: etag,
    };
    if (etagMatches(request, etag)) return new Response(null, { status: 304, headers });
    return new Response(bytes, { status: 200, headers });
  }

  if (bundle.status !== "draft") return message(409, "Editorial image is not available.");
  try {
    const canvas = marketPosterCanvas(bundle.posterModel);
    const rendered = bundle.posterModel.visualTemplate?.version === 4
      ? renderLandscapeMarketPoster(React.createElement, bundle.posterModel, await loadMarketPosterMaster(bundle.posterModel))
      : bundle.posterModel.visualTemplate
        ? renderPortraitMarketPoster(React.createElement, bundle.posterModel, await loadMarketPosterArtwork(bundle.posterModel))
        : renderPoster(bundle.posterModel);
    return new ImageResponse(rendered, {
      width: canvas.width,
      height: canvas.height,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return message(500, "Editorial image could not be rendered.");
  }
}
