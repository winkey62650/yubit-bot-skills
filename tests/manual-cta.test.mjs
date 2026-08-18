import assert from "node:assert/strict";
import test from "node:test";

import * as manualCta from "../lib/manual-cta.mjs";

const { composeManualMessage, isAllowedManualCtaUrl } = manualCta;

test("manual CTA is appended after the message body", () => {
  assert.equal(
    composeManualMessage("Market update", {
      ctaText: "Join YUBIT",
      ctaUrl: "https://yubit.com/join",
    }),
    "Market update\n\nJoin YUBIT\nhttps://yubit.com/join",
  );
});

test("manual CTA accepts one formatted multiline content block", () => {
  assert.equal(
    composeManualMessage("Market update", {
      ctaEnabled: true,
      ctaContent: "**Join YUBIT**\n\n[Open the community](https://yubit.com/join)",
    }),
    "Market update\n\n**Join YUBIT**\n\n[Open the community](https://yubit.com/join)",
  );
});

test("manual CTA supports text-only, link-only, and CTA-only messages", () => {
  assert.equal(composeManualMessage("News", { ctaText: "Read more" }), "News\n\nRead more");
  assert.equal(composeManualMessage("News", { ctaUrl: "https://example.com" }), "News\n\nhttps://example.com");
  assert.equal(composeManualMessage("", { ctaText: "Open desk" }), "Open desk");
});

test("manual CTA only accepts http and https links", () => {
  assert.equal(isAllowedManualCtaUrl("https://example.com/path"), true);
  assert.equal(isAllowedManualCtaUrl("http://example.com"), true);
  assert.equal(isAllowedManualCtaUrl("javascript:alert(1)"), false);
  assert.throws(
    () => composeManualMessage("News", { ctaUrl: "ftp://example.com" }),
    /http or https/,
  );
});

test("manual CTA keeps the full CTA while truncating an oversized body", () => {
  const result = composeManualMessage("A".repeat(30), {
    ctaText: "Join",
    ctaUrl: "https://x.co",
  }, { limit: 24 });

  assert.equal(result.length, 24);
  assert.match(result, /…\n\nJoin\nhttps:\/\/x\.co$/);
});

test("Telegram renderer turns the saved formatted CTA into safe HTML", () => {
  assert.equal(typeof manualCta.renderTelegramMarkdownHtml, "function");
  const content = [
    "_________________",
    "💎 **YUBIT | TRADE WITHOUT LIMITS**",
    "",
    "**Crypto · TradFi · One Exchange**",
    "",
    "👉 **[START TRADING NOW ↗](https://www.yubit.com/en-US/register?inviteCode=MJOD)**",
  ].join("\n");

  assert.equal(
    manualCta.renderTelegramMarkdownHtml(content),
    [
      "_________________",
      "💎 <b>YUBIT | TRADE WITHOUT LIMITS</b>",
      "",
      "<b>Crypto · TradFi · One Exchange</b>",
      "",
      "👉 <b><a href=\"https://www.yubit.com/en-US/register?inviteCode=MJOD\">START TRADING NOW ↗</a></b>",
    ].join("\n"),
  );
});
