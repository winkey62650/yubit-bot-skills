export const EDITORIAL_TEMPLATE_VERSION = "editorial-template-v1";

export const MARKET_EVENTS_DISCLAIMER = "Market commentary only.";
export const DAILY_ANALYSIS_DISCLAIMER = "Educational market commentary only. Not investment advice.";
export const WHALE_SIGNAL_DISCLAIMER = "⚠️ An order-book snapshot does not mean a trade has been executed, and visible orders can be changed or cancelled at any time. Market information only; not investment advice.";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function value(value, html) {
  return html ? escapeHtml(value) : String(value ?? "");
}

function bold(label, html) {
  return html ? `<b>${escapeHtml(label)}</b>` : label;
}

function italic(label, html) {
  return html ? `<i>${escapeHtml(label)}</i>` : label;
}

export function marketStoryIndex(index) {
  return `${String(index).padStart(2, "0")} ·`;
}

export function renderMarketEventsText({
  headline,
  stories = [],
  includeSources = true,
  footer = MARKET_EVENTS_DISCLAIMER,
  html = false
} = {}) {
  const blocks = stories.map((story, index) => {
    const item = typeof story === "string" ? { text: story } : (story || {});
    const category = item.category
      ? `${bold(String(item.category).toUpperCase(), html)} · `
      : "";
    let source = "";
    if (includeSources && item.source) {
      const sourceLabel = value(item.source, html);
      if (html && item.url) {
        source = `\n<i>Source: <a href="${escapeHtml(item.url)}">${sourceLabel}</a></i>`;
      } else {
        source = `\n${html ? "<i>" : ""}Source: ${sourceLabel}${html ? "</i>" : ""}`;
      }
    }
    return `${marketStoryIndex(index + 1)} ${category}${value(item.text, html)}${source}`;
  });
  return [
    `${html ? "<b>" : ""}🌅 ${value(headline, html)}${html ? "</b>" : ""}`,
    ...blocks,
    italic(footer, html)
  ].filter(Boolean).join("\n\n");
}

export function renderDailyAnalysisText({
  dateLabel,
  regime,
  rows = [],
  keyRead,
  levels,
  catalyst,
  html = false
} = {}) {
  const assetLines = rows.map((row) => {
    if (typeof row === "string") return row;
    return `• ${bold(row.symbol, html)} $${row.price} · ${row.change}% · ${row.trend} vs SMA20`;
  });
  return [
    `${html ? "<b>" : ""}📊 DAILY MARKET ANALYSIS · ${value(dateLabel, html)}${html ? "</b>" : ""}`,
    `${bold("Market regime:", html)} ${value(regime, html)}`,
    assetLines.join("\n"),
    `${bold("Key read:", html)} ${value(keyRead, html)}`,
    `${bold("Levels to watch:", html)} ${value(levels, html)}\n${bold("Catalyst:", html)} ${value(catalyst, html)}`,
    italic(DAILY_ANALYSIS_DISCLAIMER, html)
  ].filter(Boolean).join("\n\n");
}

export function renderWhaleSignalText({
  timestamp,
  pair = "BTC/USDT",
  concentrationRead,
  quantity,
  asset = "BTC",
  notional,
  action,
  price,
  state,
  imbalance,
  directionRead,
  watchNext,
  html = false
} = {}) {
  return [
    `${html ? "<b>" : ""}🐋 WHALE ALERT · SMART MONEY SIGNAL${html ? "</b>" : ""}`,
    `At ${value(timestamp, html)} UTC, the ${value(pair, html)} perpetual order book ${value(concentrationRead, html)}:`,
    [
      `▪️ ${bold("Visible size:", html)} ${value(quantity, html)} ${value(asset, html)} · approx. $${value(notional, html)}`,
      `▪️ ${bold("Key action:", html)} ${value(action, html)}`,
      `▪️ ${bold("Key level:", html)} $${value(price, html)}`,
      `▪️ ${bold("Current read:", html)} ${value(state, html)} near $${value(notional, html)}; top-100 depth imbalance ${value(imbalance, html)}%`
    ].join("\n"),
    value(directionRead, html),
    `${bold("What to watch next:", html)} ${value(watchNext, html)}`,
    value(WHALE_SIGNAL_DISCLAIMER, html)
  ].filter(Boolean).join("\n\n");
}
