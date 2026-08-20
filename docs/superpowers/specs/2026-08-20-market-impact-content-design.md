# Market-Impact Content Redesign

## Status

Approved by the user on 2026-08-20. The selected product direction is the hybrid format (direction A), market-impact-first ranking, and standard decision-brief density (option B).

## Goal

Replace the current single-feed, text-heavy market content with three resilient decision products:

1. Crypto Daily: three to five ranked developments in Telegram-native rich text.
2. Weekly Data Calendar: a 1200×675 visual calendar with no more than eight material events.
3. Data Updates: a 1200×675 decision card for high-impact or meaningfully surprising releases.

The first release is accepted only after one real delivery to the DEMO Academy `3. Market Events` topic. Production destinations remain out of scope for that acceptance send.

## Source Architecture

Sources are selected per field rather than by replacing the entire document with one fallback.

### Crypto Daily

- Authority layer: SEC, CFTC, and Federal Reserve official feeds establish regulatory and policy facts.
- Discovery layer: CoinDesk, Decrypt, and Cointelegraph provide independent industry coverage.
- Reaction layer: Binance, OKX, and CoinGecko provide price, volume, and breadth confirmation.
- A media headline cannot become important solely because it is recent or repeated.

### Weekly Calendar

- BLS release calendar/ICS supplies US labour and inflation schedules.
- BEA release schedule supplies GDP, income, consumption, and trade releases.
- Federal Reserve calendar supplies FOMC decisions and minutes.
- ECB statistical calendar supplies euro-area releases.
- TradingView is auxiliary only. Its failure must not empty the calendar.

### Data Updates

- Official BLS, BEA, ECB, and Federal Reserve publications are the sources of truth for actual, previous, and revised values.
- A forecast is optional. It is displayed only when a named auxiliary source provides it and is labelled `Auxiliary forecast`.
- When no reliable forecast exists, the card compares actual with previous/revised values. It must never invent or relabel a model estimate as market consensus.

Every product has at least three independent source routes. Adapter results expose source health, checked time, last success, and warnings. Cached last-known schedules may keep a calendar readable but must be visibly marked stale.

## Market-Impact Ranking

Crypto candidates receive a transparent 0–100 score:

- observed price/volume reaction: 35
- policy or systemic significance: 25
- capital flow and market breadth: 20
- independent corroboration: 10
- recency: 10

Market reaction measures proximity and magnitude, not causation. The copy says that a move occurred around the event and avoids claims such as “the headline caused BTC to rise.” The selector returns the top three items and may add up to two watch items above the publication threshold. It does not force category quotas or publish low-value filler.

Calendar events use a separate importance model based on indicator allowlist, central-bank status, country/market relevance, and schedule confidence. Data updates publish only allowlisted high-impact indicators or releases whose verified deviation crosses the configured threshold.

## Editorial Contract

Crypto Daily follows this order:

1. Executive takeaway: one sentence describing the dominant risk or opportunity.
2. Top developments: numbered 01–03, optionally 04–05 as watch items.
3. Each development: what happened, why it matters, affected assets/themes, observed reaction, source, and timestamp.
4. Watch boundary: what would confirm or invalidate the current interpretation.

Telegram delivery uses supported HTML rather than Markdown tables. It uses bold hierarchy, short blockquotes, numbered sections, and source links. Each paragraph remains within Telegram limits and links have tracking parameters removed.

The weekly calendar image is accompanied by a short caption containing the three most important moments and the source-health summary. The data update card is accompanied by a short impact pathway covering USD, rates, and crypto sensitivity without trade recommendations.

## Visual Philosophy

The reference image contributes its editorial language, not its literal artwork: warm white negative space, oversized black geometric forms, sculptural elements crossing those forms, asymmetrical magazine grids, tiny technical labels, and a restrained yellow accent.

The YUBIT interpretation replaces people and furniture with original market forms: price curves, macro capsules, data nodes, and event rails. It retains high contrast and generous space while ensuring the actual event values remain readable on a Telegram phone screen. The palette is warm white, carbon black, cool grey, with sparse YUBIT amber. The result must feel like an editorial object, not a generic dashboard.

The reusable visual philosophy is stored in `docs/design/yubit-editorial-markets.md`. Dynamic production assets are rendered with the existing Next.js `ImageResponse` route so Telegram can receive deterministic PNG files without an external image-generation dependency.

## Delivery and Failure Behaviour

- Weekly Calendar and Data Updates use `sendPhoto` with a concise caption.
- Crypto Daily uses a standalone poster followed by Telegram HTML text.
- Each delivery remains idempotent and preserves the existing destination lease/checkpoint behaviour.
- If verified content is below threshold, the job records `not publishable` instead of sending samples or filler.
- One failed adapter degrades source health; it does not fail the entire job when enough verified fields remain.
- A correction or official revision creates a versioned update rather than silently replacing a prior value.

## Verification

- Adapter contract tests use fixtures for normal, timeout, schema-drift, and stale-cache cases.
- Ranking tests verify market-impact order and no forced category filler.
- Template tests verify Telegram limits, source attribution, optional forecast semantics, and non-causal wording.
- Image-route tests verify the two new card kinds and dynamic fields.
- Automation tests verify that both visual products use `sendPhoto` and retain the correct topic destination.
- The full test suite, syntax checks, and production build must pass before the DEMO send.
- The DEMO acceptance send must use live source data, target chat `-1003710405969`, topic `8`, and produce exactly one current test set.

## Out of Scope

- Paid economic-calendar subscriptions.
- Fabricated consensus forecasts.
- Automated production-group delivery before the user reviews the DEMO result.
- Copying characters, illustrations, or exact layout from the supplied reference poster.

