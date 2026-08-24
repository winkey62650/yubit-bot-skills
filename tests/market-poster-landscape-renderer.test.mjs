import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLandscapeMarketPosterFits,
  landscapePosterOverflowFields,
  renderLandscapeMarketPoster,
} from "../lib/market-poster-landscape-renderer.mjs";

function e(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined) };
}

function renderedText(model) {
  return JSON.stringify(renderLandscapeMarketPoster(e, model, LOCKED_MASTER));
}

function visibleText(model) {
  const strings = [];
  const visit = (node) => {
    if (typeof node === "string") strings.push(node);
    else if (node && typeof node === "object") (node.children || []).forEach(visit);
  };
  visit(renderLandscapeMarketPoster(e, model, LOCKED_MASTER));
  return strings.join(" | ");
}

function geometry(model) {
  const output = renderLandscapeMarketPoster(e, model, LOCKED_MASTER);
  return output.children.map((child) => ({
    key: child.props["data-dynamic-field"],
    left: child.props.style.left,
    top: child.props.style.top,
    width: child.props.style.width,
    height: child.props.style.height,
  }));
}

const footer = { sources: ["BLS", "Coinbase Exchange"], updatedAt: "2026-08-24T03:16:33.000Z" };
const LOCKED_MASTER = "data:image/png;base64,AAAA";

test("all four automatic posters render on the landscape canvas with their content-only titles", () => {
  const cases = [
    ["daily-market-brief-v4", "DAILY MARKET BRIEF", { stories: [{ rank: "01", title: "BTC ETF demand remains the structural anchor", score: 83, impact: "BULLISH", source: "SEC", affected: "BTC" }] }],
    ["weekly-catalysts-v4", "WEEKLY CATALYSTS", { columns: [{ label: "TUE 25", events: [{ title: "U.S. CPI", time: "12:30", importance: 3, source: "BLS", sensitivity: "Rates and USD repricing" }] }], highImpactCount: 1, peakDay: "TUE 25" }],
    ["data-flash-v4", "DATA FLASH", { title: "U.S. CPI at 2.7% YoY", actual: "2.7%", forecast: null, previous: null, impact: "Neutral", reactions: [] }],
    ["market-follow-up-v4", "MARKET FOLLOW-UP", { title: "U.S. CPI at 2.7% YoY", impact: "Neutral", reactions: [{ symbol: "BTC", label: "-0.09%", value: -0.09 }], reactionWindow: { label: "12:30–13:00 UTC" } }],
  ];

  for (const [id, title, fields] of cases) {
    const output = renderLandscapeMarketPoster(e, { ...fields, footer, visualTemplate: { id, canvas: { width: 1200, height: 675 } } }, LOCKED_MASTER);
    assert.equal(output.props.style.width, "100%");
    assert.equal(output.props.style.height, "100%");
    assert.match(JSON.stringify(output), new RegExp(title));
    assert.doesNotMatch(JSON.stringify(output), /YUBIT/i);
  }
});

test("the supplied VIP Wide Dense V4 template remains the visual source of truth", () => {
  const text = renderedText({
    visualTemplate: { id: "daily-market-brief-v4" },
    stories: [{ rank: "01", title: "Verified market development", score: 80, affected: "BTC" }],
    footer,
  });

  assert.match(text, /data:image\/png;base64,AAAA/);
  assert.match(text, /DAILY MARKET BRIEF/);
  assert.match(text, /data-dynamic-field/);
  assert.doesNotMatch(text, /linear-gradient|boxShadow/);
  assert.doesNotMatch(text, /#F4F0E7|YUBIT/i);
});

test("daily content can change without changing any field count or geometry", () => {
  const base = { visualTemplate: { id: "daily-market-brief-v4" }, footer };
  const sparse = geometry({ ...base, stories: [{ title: "BTC update", source: "SEC", affected: "BTC" }] });
  const dense = geometry({ ...base, stories: Array.from({ length: 3 }, (_, index) => ({
    title: `Story ${index + 1} with a much longer verified headline`,
    source: "Verified source",
    affected: index === 0 ? "BTC" : "ETH",
    thesis: "Different daily content must remain inside the exact same fixed slot.",
  })) });

  assert.deepEqual(dense, sparse);
  assert.equal(new Set(sparse.map(({ key }) => key)).size, sparse.length);
  assert.equal(sparse.every(({ key }) => Boolean(key)), true);
});

test("daily poster removes awkward title punctuation and does not repeat the lead thesis", () => {
  const text = visibleText({
    visualTemplate: { id: "daily-market-brief-v4" },
    footer,
    stories: [{ title: "Macro liquidity keeps the near-term read balanced", thesis: "Rates and USD direction remain the next confirmation layer.", affected: "BTC" }],
  });

  assert.match(text, /MACRO LIQUIDITY NEAR TERM READ/);
  assert.doesNotMatch(text, /NEAR-TERM|Rates and USD direction remain the next confirmation layer.*Rates and USD direction remain the next confirmation layer/);
  assert.match(text, /Confirmation still matters before conviction rises/);
});

test("all four V4 products keep identical dynamic-field geometry for sparse and dense input", () => {
  const cases = [
    ["daily-market-brief-v4",
      { stories: [] },
      { stories: Array.from({ length: 3 }, (_, index) => ({ title: `Verified story ${index + 1}`, source: "Official source", affected: "BTC", thesis: "Dense daily content stays in the same slot.", impact: "Positive", score: 82 })) }],
    ["weekly-catalysts-v4",
      { weekStart: "2026-08-24", columns: [] },
      { weekStart: "2026-08-24", columns: Array.from({ length: 7 }, (_, index) => ({ label: `${["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"][index]} ${24 + index}`, events: [{ title: `Verified event ${index + 1}`, time: "12:30", importance: 3, affected: "BTC", sensitivity: "Cross-asset repricing risk." }] })) }],
    ["data-flash-v4",
      { indicator: "CPI", reactions: [] },
      { indicator: "CPI", actual: "2.7%", forecast: "2.8%", previous: "2.9%", reactions: Array.from({ length: 4 }, (_, index) => ({ symbol: ["BTC", "DXY", "NASDAQ", "US 2Y"][index], label: "+0.10%", status: "Observed" })) }],
    ["market-follow-up-v4",
      { reactions: [] },
      { reactionWindow: { label: "12:30–13:00 UTC · 30 MIN" }, reactions: Array.from({ length: 4 }, (_, index) => ({ symbol: ["BTC", "ETH", "DXY", "NASDAQ"][index], label: "+0.10%", status: "Observed" })) }],
  ];

  for (const [id, sparseFields, denseFields] of cases) {
    const base = { visualTemplate: { id }, footer };
    const sparse = geometry({ ...base, ...sparseFields });
    const dense = geometry({ ...base, ...denseFields });
    assert.deepEqual(dense, sparse, `${id} must never reflow`);
    assert.equal(new Set(sparse.map(({ key }) => key)).size, sparse.length, `${id} fields must be uniquely addressable`);
  }
});

test("automatic posters fail closed when the locked V4 master is missing", () => {
  assert.throws(
    () => renderLandscapeMarketPoster(e, { visualTemplate: { id: "daily-market-brief-v4" }, stories: [] }),
    /locked VIP Wide Dense V4 master artwork is required/i,
  );
});

test("sparse weekly data preserves seven fixed UTC-day slots and leaves empty days blank", () => {
  const text = renderedText({
    visualTemplate: { id: "weekly-catalysts-v4" },
    weekStart: "2026-08-24",
    columns: [
      { label: "MON 24", events: [] },
      { label: "TUE 25", events: [{ title: "U.S. CPI", time: "12:30", importance: 3, source: "BLS", sensitivity: "Rates and USD repricing" }] },
      { label: "WED 26", events: [] },
      { label: "THU 27", events: [] },
      { label: "FRI 28", events: [] },
      { label: "SAT 29", events: [] },
      { label: "SUN 30", events: [] },
    ],
    highImpactCount: 1,
    peakDay: "TUE 25",
    footer,
  });

  assert.match(text, /U\.S\. CPI/);
  assert.doesNotMatch(text, /NO MAJOR EVENT|NO MATERIAL VERIFIED UPDATE|IMPACT · CLEAR|STATUS · CLEAR/i);
  assert.match(text, /weekly-1-day/);
  assert.match(text, /weekly-7-day/);
  assert.doesNotMatch(text, /TBD|N\/A|NOT AVAILABLE/);
});

test("weekly uses one clean seven-column content surface instead of exposing the five-column master grid", () => {
  const layout = geometry({
    visualTemplate: { id: "weekly-catalysts-v4" },
    weekStart: "2026-08-24",
    columns: Array.from({ length: 7 }, (_, index) => ({ label: `${["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"][index]} ${24 + index}`, events: [] })),
    footer,
  });
  const surface = layout.find(({ key }) => key === "weekly-grid-mask");
  const dayCards = layout.filter(({ key }) => /^weekly-day-\d+-mask$/.test(key));

  assert.deepEqual(surface, { key: "weekly-grid-mask", left: 14, top: 225, width: 1172, height: 307 });
  assert.equal(dayCards.length, 7);
  assert.equal(dayCards.every(({ width }) => width === 158), true);
  assert.equal(dayCards.every((card, index) => index === 0 || card.left >= dayCards[index - 1].left + dayCards[index - 1].width), true);
});

test("weekly catalysts renders one complete seven-day UTC week and never pulls a later event", () => {
  const text = renderedText({
    visualTemplate: { id: "weekly-catalysts-v4" },
    weekStart: "2026-08-24",
    columns: [
      ...Array.from({ length: 7 }, (_, index) => ({ label: `DAY ${index + 1}`, events: index === 0 ? [{ title: "This-week CPI", time: "12:30", importance: 3, source: "BLS" }] : [] })),
      { label: "DAY 8", events: [{ title: "Next-week event must not appear", time: "09:00", importance: 3, source: "Official source" }] },
    ],
    footer,
  });

  assert.match(text, /24–30 AUG 2026/);
  assert.match(text, /This week CPI/);
  assert.match(text, /weekly-7-day/);
  assert.doesNotMatch(text, /weekly-8-day/);
  assert.doesNotMatch(text, /Next-week event must not appear/);
});

test("missing flash comparisons remain explicit instead of looking like broken data", () => {
  const text = visibleText({
    visualTemplate: { id: "data-flash-v4" },
    title: "U.S. CPI at 2.7% YoY",
    indicator: "CPI",
    actual: "2.7% YoY",
    forecast: null,
    previous: null,
    impact: "Neutral",
    verdict: "The official print is verified; wait for cross-asset confirmation.",
    reactions: [],
    footer,
  });

  assert.match(text, /2\.7% YoY/);
  assert.match(text, /NOT IN SOURCE/);
  assert.match(text, /BTC.*DXY.*NASDAQ.*US 2Y/);
  assert.match(text, /AWAITING TAPE/);
  assert.match(text, /PENDING/);
});

test("poster compaction is word-safe, visibly marked, and never silently slices a token", () => {
  const text = visibleText({
    visualTemplate: { id: "daily-market-brief-v4" },
    stories: [{
      title: "Institutional accumulation strengthens materially as cross-asset confirmation develops",
      thesis: "Institutional participation strengthens materially as cross-asset confirmation develops across spot markets",
      source: "Official filing",
      affected: "BTC",
    }],
    footer,
  });

  assert.match(text, /…/u);
  assert.doesNotMatch(text, /INSTITUT…|confirmat…/u);
});

test("publish visual gate rejects any poster that still needs visible text compaction", () => {
  const overflowing = {
    visualTemplate: { id: "daily-market-brief-v4" },
    footer,
    stories: [{
      title: "This verified market headline is deliberately too long for the locked visual field",
      source: "Official source",
      affected: "BTC",
    }],
  };
  assert.deepEqual(landscapePosterOverflowFields(overflowing), ["daily-1-title"]);
  assert.throws(() => assertLandscapeMarketPosterFits(overflowing), /daily-1-title/);

  const fitting = {
    visualTemplate: { id: "market-follow-up-v4" },
    footer,
    posterVerdict: "Mixed move in completed window.",
    posterConfirmation: "Needs cross-asset alignment.",
    posterInvalidation: "BTC reclaims pre-release level.",
  };
  assert.deepEqual(landscapePosterOverflowFields(fitting), []);
  assert.doesNotThrow(() => assertLandscapeMarketPosterFits(fitting));
});

test("reaction boards label unmeasured fixed rows without inventing market values", () => {
  const flash = visibleText({ visualTemplate: { id: "data-flash-v4" }, indicator: "CPI", actual: "2.7%", reactions: [], footer });
  const follow = visibleText({ visualTemplate: { id: "market-follow-up-v4" }, reactions: [], footer });

  assert.match(flash, /BTC.*AWAITING TAPE.*PENDING/i);
  assert.match(follow, /BTC.*NO DATA.*UNAVAILABLE/i);
  assert.match(follow, /Cross[ -]asset tape unavailable/i);
  assert.doesNotMatch(`${flash} ${follow}`, /\+0\.00%|-0\.00%/i);
});

test("daily watch row flattens all verified affected assets", () => {
  const text = visibleText({
    visualTemplate: { id: "daily-market-brief-v4" },
    stories: [
      { title: "CPI", affected: "BTC · ETH · DXY", posterThesis: "Rates sensitivity remains high." },
      { title: "Policy", affected: "BTC · NASDAQ", posterThesis: "Liquidity repricing remains conditional." },
    ],
    footer,
  });

  assert.match(text, /BTC.*ETH.*DXY/);
});

test("poster copy stays concise and removes generic horizon labels", () => {
  const flash = visibleText({
    visualTemplate: { id: "data-flash-v4" },
    title: "A very long official release headline that should never crowd the fixed subtitle field",
    indicator: "CPI",
    actual: "2.7%",
    verdict: "The official print is verified while the first market response remains too limited to support a durable directional conclusion.",
    reactions: [],
    footer,
  });
  const follow = visibleText({
    visualTemplate: { id: "market-follow-up-v4" },
    verdict: "The measured move remains small and mixed while cross-asset confirmation is still incomplete and the evidence does not justify a durable directional conclusion.",
    reactions: [],
    footer,
  });

  assert.doesNotMatch(flash, /HORIZON|1–3D|AWAITING VERIFIED REACTION/i);
  assert.doesNotMatch(follow, /HORIZON|6–24H|AWAITING VERIFIED WINDOW/i);
  assert.match(follow, /AWAITING CONFIRMATION/i);
  assert.doesNotMatch(flash, /durable directional conclusion/i);
  assert.doesNotMatch(follow, /does not justify a durable directional conclusion/i);
});

test("follow-up uses concise poster fields and a completed tape status", () => {
  const text = visibleText({
    visualTemplate: { id: "market-follow-up-v4" },
    tapeStatus: "DIVERGENT",
    verdict: "A long verdict that should remain in the paired Telegram copy.",
    posterVerdict: "Small mixed move; confirmation incomplete.",
    posterConfirmation: "Needs sustained cross-asset alignment.",
    posterInvalidation: "BTC reclaims pre-release levels.",
    footer,
  });

  assert.match(text, /Small mixed move; confirmation incomplete/);
  assert.match(text, /DIVERGENT/);
  assert.doesNotMatch(text, /A long verdict|AWAITING CONFIRMATION/);
});
