# Commercial Weekly Calendar and Data Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Weekly Calendar and Data Updates into source-transparent, commercially publishable English products with durable Yubit Academy pages, Editorial Research graphics, verified community briefs, and fail-closed automated distribution.

**Architecture:** Keep source retrieval, field-level provenance, editorial models, durable publication bundles, rendering, and delivery as separate layers. Calendar and release adapters normalize into a provenance-aware event contract; pure builders create the website article, community brief, and poster model; one locally persisted publication bundle becomes the source of truth for both public pages and image routes; automation may distribute only after the public page and stored image pass health checks. Tier-one releases receive a full article, while secondary releases receive only the stored card and short interpretation.

**Tech Stack:** Node.js 20, Next.js 15 App Router, React 18, `next/og` ImageResponse, local PostgreSQL-backed distribution repository, Node test runner, Telegram Bot API, free official/public HTTPS sources.

---

## Scope and execution boundary

This plan implements the approved specification in `docs/superpowers/specs/2026-08-21-weekly-calendar-data-updates-design.md`. It supersedes the Weekly Calendar and Data Updates portions of `docs/superpowers/plans/2026-08-20-market-impact-content.md`; the approved Market News implementation remains unchanged except where automation is generalized to accept any product's `communityDocument`.

The implementation phase ends with local dry-run evidence. GitHub push, production deployment, database mutation outside the local application database, and Telegram/Discord sending are a separate release phase and require a fresh explicit approval after the verification report is shown.

## Locked product contracts

### Weekly Calendar

- Canonical article path: `/market-calendar/{ISO-year}-W{ISO-week}`.
- Telegram brief: English, one core view, exactly three numbered events, confirmation, invalidation, and the verified article URL.
- Website: full weekly risk playbook, not a timestamp dump.
- Graphic: 1200×675 warm-gray Editorial Research layout, five weekday columns, and a `Crypto Weekend` block only when a material weekend event exists.

### Data Updates

- Tier-one canonical article path: `/data-updates/{release-slug}/{YYYY-MM-DD}`.
- Tier one: stored 1200×675 card, English Telegram brief, full website analysis.
- Secondary: stored 1200×675 card and short interpretation, with no standalone article and no fabricated `Read more` URL.
- Automatic publication requires an official actual value. A named auxiliary forecast is optional; if unavailable or conflicting, forecast and surprise claims are omitted.
- Reaction language always names the observation window and never claims causality from temporal coincidence alone.

### Free retrieval routes

- Calendar and expectation routes: TradingView Economic Calendar, Nasdaq Economic Calendar, and Federal Reserve meeting calendar. BLS and BEA official release pages augment the official schedule for their own releases.
- Official actual routes: BLS current CPI/Employment Situation release pages, BEA current Personal Income and Outlays/GDP release pages, and Federal Reserve FOMC statements/implementation notes. BLS Public Data API is a verification/backfill route, not the sole immediate-release route because its public database may lag the news release.
- Crypto reaction routes: Binance, OKX, and Coinbase Exchange public candles/ticker endpoints. Yahoo Finance remains an optional DXY cross-asset route and may never be used to invent missing rates or equity observations.
- Source authority is field-specific: official institution data wins for schedules and actual values; auxiliary calendars may supply a named forecast; market APIs supply only observed market fields.

## Target file map

### Create

- `lib/market-provenance.mjs`: provenance schema, authority ordering, freshness/unit/timezone validation, event reconciliation, and publication eligibility.
- `lib/market-official-releases.mjs`: BLS, BEA, and Federal Reserve official schedule/actual adapters and parsers.
- `lib/market-editorial-articles.mjs`: Weekly Calendar and Data Update article builders, tier classification, community-document builders, slugs, and repository keys.
- `lib/market-publication.mjs`: durable publication-bundle lifecycle, image capture, PNG validation, URL builders, and public health checks.
- `app/market-calendar/[week]/page.jsx`: durable Weekly Calendar article page.
- `app/data-updates/[release]/[date]/page.jsx`: durable tier-one Data Update article page.
- `app/api/media/editorial/[product]/[slug]/route.js`: persisted Editorial Research image endpoint.
- `tests/fixtures/market-content/bls-cpi-release.html`: stable official CPI parser fixture.
- `tests/fixtures/market-content/bls-employment-release.html`: stable official payroll/unemployment parser fixture.
- `tests/fixtures/market-content/bea-pce-release.html`: stable official PCE parser fixture.
- `tests/fixtures/market-content/bea-gdp-release.html`: stable official GDP parser fixture.
- `tests/fixtures/market-content/fomc-statement.html`: stable FOMC parser fixture.
- `tests/market-provenance.test.mjs`: field-level source authority and fail-closed tests.
- `tests/market-official-releases.test.mjs`: official adapter/parser tests.
- `tests/market-editorial-articles.test.mjs`: article and community-brief contract tests.
- `tests/market-publication.test.mjs`: persistence, stored-image, hash, and health-gate tests.
- `tests/market-editorial-pages.test.mjs`: canonical key/path and missing-record behavior tests that do not require a browser.

### Modify

- `lib/market-content-sources.mjs`: collect all calendar routes, preserve source health, add Coinbase reaction fallback, and attach provenance inputs.
- `lib/market-content-templates.mjs`: make Weekly Calendar exactly-three selection and Data Update verdict terminology conform to the approved contract.
- `lib/market-impact-ranking.mjs`: expose deterministic weekly ranking and release tier promotion/demotion evidence.
- `lib/market-poster-models.mjs`: five-weekday/optional-weekend model and Editorial Research data-card model.
- `lib/data-release-monitor.mjs`: require official actual eligibility before preparing a release and retain conflict evidence.
- `lib/automation-jobs.mjs`: build/persist product bundles, capture the image, health-check page and asset, generalize `communityDocument`, and block delivery before verification.
- `app/api/media/card/route.js`: use the Editorial Research renderer for preview-only Weekly Calendar and Data Update cards while preserving existing Market News behavior.
- `tests/market-content-sources.test.mjs`: all-route collection, Coinbase fallback, and degraded-source cases.
- `tests/market-content-templates.test.mjs`: exactly-three weekly brief, verdict names, missing forecast, and evidence-language cases.
- `tests/market-impact-ranking.test.mjs`: weekly ordering and tier promotion/demotion cases.
- `tests/market-poster-models.test.mjs`: layout limits and long/missing/negative value cases.
- `tests/data-release-monitor.test.mjs`: official actual, stale actual, unit conflict, timezone conflict, and parallel event cases.
- `tests/automation.test.mjs`: bundle persistence, health gate, generalized community documents, secondary release behavior, and delivery idempotency.
- `tests/media-card-template.test.mjs`: route/render contract and 1200×675 metadata.
- `package.json`: include the new pure `.mjs` modules in `npm run check`.

No SQL migration is required. One versioned JSON publication bundle is written through the existing repository `getMeta`/`setMeta` interface, which is backed by the local PostgreSQL primary store in production and the isolated JSON directory in tests.

---

### Task 1: Freeze the provenance and release-tier contracts

**Files:** Create `tests/market-provenance.test.mjs`; create `lib/market-provenance.mjs`; modify `tests/market-impact-ranking.test.mjs`; modify `lib/market-impact-ranking.mjs`.

- [ ] Add failing tests with these exact cases:

  1. An official BLS `actual=3.4%` overrides a TradingView `actual=3.3%`, while the auxiliary value remains in `comparisons`.
  2. Two official actuals with different normalized values return `status: "conflicting"` and `publishable: false`.
  3. `3.4` with unit `%` and `3.4%` reconcile; `3.4%` and `3.4K` produce `unit-conflict`.
  4. A date-only or timezone-ambiguous tier-one event produces `timezone-conflict` and cannot enter the top-three brief.
  5. A stale official schedule may support Weekly Calendar only when `ageSeconds <= 21600`, with `freshness: "stale"`; a cached actual cannot authorize a new Data Update.
  6. A missing forecast leaves `forecast: null`, `surprise: null`, and remains publishable when the official actual is valid.
  7. CPI, Core CPI, PCE, Core PCE, NFP, unemployment, FOMC decisions/statements, and GDP classify as tier one.
  8. A secondary event is promoted only when the ranking result records `decision: "promoted"`, a score at or above the configured threshold, and non-empty reasons; a tier-one demotion is also recorded rather than silently applied.

- [ ] Use this normalized field shape in tests and implementation:

  ```js
  {
    value: "3.4%",
    rawValue: "3.4",
    unit: "%",
    status: "verified",
    authority: "official",
    sourceId: "bls-cpi",
    sourceUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
    retrievedAt: "2026-08-12T12:30:05.000Z",
    publishedAt: "2026-08-12T12:30:00.000Z",
    comparisons: []
  }
  ```

- [ ] Export these pure functions from `lib/market-provenance.mjs`: `normalizeSourcedField`, `reconcileSourcedField`, `reconcileCalendarEvents`, `validateWeeklyPublication`, and `validateDataReleasePublication`.
- [ ] Export `classifyDataReleaseTier(event, ranking)` from `lib/market-impact-ranking.mjs`; return `{ tier, decision, score, reasons }` and never only a boolean.
- [ ] Run `node --test tests/market-provenance.test.mjs tests/market-impact-ranking.test.mjs`; confirm the new tests fail before implementation and pass afterward.
- [ ] Commit only the task files with `git commit -m "feat: enforce market publication provenance"`.

### Task 2: Add official BLS, BEA, and Federal Reserve adapters

**Files:** Create `lib/market-official-releases.mjs`; create the five HTML fixtures; create `tests/market-official-releases.test.mjs`.

- [ ] Add failing parser tests for:

  - CPI headline month-over-month and year-over-year values plus Core CPI values from the BLS current release page.
  - Payroll change and unemployment rate from the BLS Employment Situation page.
  - Headline and Core PCE values from the BEA Personal Income and Outlays page.
  - Headline GDP annualized change from the BEA GDP page.
  - FOMC target range and statement URL from the official FOMC statement/implementation note.

- [ ] Assert every parser output contains `source.type: "official"`, stable official URL, retrieval time, release period, raw value, normalized value, and unit. A changed page shape must throw `OFFICIAL_RELEASE_SCHEMA_INVALID`; it must not return a partial guessed value.
- [ ] Implement these exports with injected `fetchImpl`, `now`, `timeoutMs`, and retry settings so all tests remain offline:

  ```js
  fetchBlsOfficialRelease({ indicator, fetchImpl, now, timeoutMs })
  fetchBeaOfficialRelease({ indicator, fetchImpl, now, timeoutMs })
  fetchFomcOfficialRelease({ fetchImpl, now, timeoutMs })
  fetchOfficialActual({ event, fetchImpl, now, timeoutMs })
  ```

- [ ] Use the no-auth official news-release pages for immediate values. Use `https://api.bls.gov/publicAPI/v2/timeseries/data/` only as later verification/backfill and attach `availabilityRole: "backfill"`; never wait for or substitute its potentially lagged value during the 15-minute release window.
- [ ] Do not make a BEA API key a release prerequisite. Read current public BEA release pages; if a future `BEA_API_KEY` is present, it may add a comparison record but cannot change the official page's authority without a separate reviewed change.
- [ ] Run `node --test tests/market-official-releases.test.mjs`; require all fixture cases and malformed-page cases to pass.
- [ ] Commit with `git commit -m "feat: ingest official macro releases"`.

### Task 3: Collect and reconcile all free calendar routes

**Files:** Modify `lib/market-content-sources.mjs`; modify `tests/market-content-sources.test.mjs`; modify `tests/market-provenance.test.mjs`.

- [ ] Replace the current first-non-empty `fetchMarketCalendar` behavior with parallel collection of TradingView, Nasdaq, and Federal Reserve results. Do not stop after TradingView returns events.
- [ ] Add official BLS and BEA schedule augmentation only for their covered indicators, then pass all events to `reconcileCalendarEvents`.
- [ ] Preserve every adapter's source-health record and warning in the combined envelope:

  ```js
  {
    data: reconciledEvents,
    events: reconciledEvents,
    sources: [...allSourceHealth],
    warnings: [...allWarnings],
    checkedAt,
    reconciliation: { verified, degraded, conflicting, excluded }
  }
  ```

- [ ] Add failing tests proving:

  - Healthy results from all three existing routes are collected, deduplicated, and retain all three source records.
  - One timeout does not erase two healthy sources.
  - An official schedule wins over auxiliary time fields.
  - Two auxiliary times that disagree without an official time produce `Time under verification` and exclusion from the priority three.
  - An empty successful calendar is distinguished from a failed calendar.

- [ ] Run `node --test tests/market-content-sources.test.mjs tests/market-provenance.test.mjs`; require zero failures.
- [ ] Commit with `git commit -m "feat: reconcile multi-source market calendar"`.

### Task 4: Add Coinbase as the third crypto reaction route

**Files:** Modify `lib/market-content-sources.mjs`; modify `tests/market-content-sources.test.mjs`.

- [ ] Add failing tests for Coinbase Exchange public candles and ticker parsing using `BTC-USD` and `ETH-USD`.
- [ ] Implement `fetchCoinbaseReaction` with public `GET /products/{product_id}/candles` at 60-second granularity and public ticker data. Select the final completed candle at or before `beforeAt`; reject incomplete or non-positive observations.
- [ ] Use deterministic provider order Binance → OKX → Coinbase per crypto symbol. Record every attempted provider's health and the `fallbackFrom` chain.
- [ ] Add tests for Binance+OKX failure with Coinbase success, all-three failure, one-symbol partial failure, and Coinbase candle gaps.
- [ ] Keep Yahoo DXY optional. When DXY fails, return the crypto reaction plus a warning and ensure later verdict logic can become `Awaiting Confirmation` rather than fabricating cross-asset confirmation.
- [ ] Run `node --test tests/market-content-sources.test.mjs`; require zero failures.
- [ ] Commit with `git commit -m "feat: add third crypto reaction source"`.

### Task 5: Build the two editorial article models and community briefs

**Files:** Create `lib/market-editorial-articles.mjs`; create `tests/market-editorial-articles.test.mjs`; modify `lib/market-content-templates.mjs`; modify `tests/market-content-templates.test.mjs`.

- [ ] Define durable keys and canonical slugs with these exports:

  ```js
  weeklyCalendarPublicationKey("2026-W34")
  dataUpdatePublicationKey("us-cpi", "2026-08-12")
  buildWeeklyCalendarArticle({ document, rankedEvents, sourceManifest, marketSetup })
  buildWeeklyCalendarCommunityDocument(article, { articleUrl })
  buildDataUpdateArticle({ document, event, reaction, tierDecision, sourceManifest })
  buildDataUpdateCommunityDocument(article, { articleUrl })
  buildSecondaryDataUpdateCommunityDocument({ document, event, reaction, tierDecision })
  ```

- [ ] Add failing Weekly Calendar tests that require:

  - A one-sentence `coreView`.
  - Exactly three `priorityEvents`, ordered by market-impact score rather than time.
  - For every priority event: UTC time, jurisdiction, why it matters, transmission path, affected assets, and field provenance.
  - Sections for market setup, full impact-ranked table, tier-one analysis, base/strengthening/invalidation scenarios, daily watchlist, sources, limitations, and informational-purpose disclaimer.
  - The community renderer to match the approved English structure and contain one verified absolute HTTPS article link.

- [ ] Add failing Data Update tests that require:

  - `facts`, `dataSignal`, `marketConfirmation`, `scenarioAnalysis`, `watchNext`, `invalidation`, `sources`, `limitations`, and disclaimer sections.
  - Verdict vocabulary restricted to `Confirmed`, `Divergent`, and `Awaiting Confirmation`.
  - A bounded `reactionWindow` with start/end timestamps and provider names.
  - No forecast or surprise sentence when the forecast is missing.
  - An explicit inference label for interpretation; observed movements remain observations.
  - Tier-one documents have an article URL; secondary documents do not.

- [ ] Update `buildWeeklyCalendarDocument` so its selected priority set is exactly three while its article model may retain the full eligible week table. Rename old tape states (`MIXED`, `UNCONFIRMED`) into the approved verdict vocabulary without changing the factual inputs.
- [ ] Preserve the existing structured-node renderer and URL safety checks; do not hand-build raw Telegram HTML outside the renderer.
- [ ] Run `node --test tests/market-editorial-articles.test.mjs tests/market-content-templates.test.mjs`; require zero failures.
- [ ] Commit with `git commit -m "feat: build commercial calendar and data analysis"`.

### Task 6: Make poster models match the Editorial Research system

**Files:** Modify `lib/market-poster-models.mjs`; modify `tests/market-poster-models.test.mjs`.

- [ ] Add failing Weekly Calendar model tests for five weekday columns, top-three emphasis, optional weekend section, maximum line lengths, source footer, UTC timezone, update timestamp, and stale-source label.
- [ ] Add failing Data Update model tests for long titles, negative values, missing forecast, component releases such as CPI/Core CPI, partial BTC/ETH/DXY reaction, reaction window, official source, and the three verdicts.
- [ ] Make every poster model return explicit visual tokens rather than layout JSX:

  ```js
  {
    canvas: { width: 1200, height: 675 },
    palette: { paper: "#E9E5DC", ink: "#171717", muted: "#6D6A63", red: "#A3483F", green: "#3F6D57" },
    masthead: "YUBIT ACADEMY / EDITORIAL RESEARCH",
    footer: { sources, timezone: "UTC", updatedAt },
    ...productFields
  }
  ```

- [ ] Enforce content caps in the pure model so the route does not clip unpredictably: top-three event descriptions and confirmation/invalidation strings must use deterministic truncation that preserves complete words and never hides numerical facts.
- [ ] Run `node --test tests/market-poster-models.test.mjs`; require zero failures.
- [ ] Commit with `git commit -m "feat: model editorial research market cards"`.

### Task 7: Persist one durable publication bundle per product

**Files:** Create `lib/market-publication.mjs`; create `tests/market-publication.test.mjs`.

- [ ] Add failing repository tests for the lifecycle `draft → rendered → verified`, including restart recovery with a new repository instance.
- [ ] Persist one versioned bundle through `repository.setMeta(publicationKey, bundle)` with this contract:

  ```js
  {
    version: "market-publication-v1",
    product: "weekly-calendar",
    slug: "2026-W34",
    status: "verified",
    contentHash: "sha256-hex",
    article: {},
    communityDocument: {},
    posterModel: {},
    sourceManifest: [],
    imageAsset: {
      mimeType: "image/png",
      width: 1200,
      height: 675,
      byteLength: 123456,
      sha256: "sha256-hex",
      base64: "...",
      renderedAt: "2026-08-21T00:00:00.000Z"
    },
    health: { page: "ok", image: "ok", checkedAt: "2026-08-21T00:00:00.000Z" },
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z"
  }
  ```

- [ ] Implement canonical helpers `weeklyCalendarArticlePath`, `dataUpdateArticlePath`, and `editorialAssetPath`; reject malformed week/date/release slugs instead of normalizing arbitrary path input.
- [ ] Implement `captureEditorialImage`: fetch the public draft image route, require status 200 and `image/png`, parse the PNG IHDR bytes to require exactly 1200×675, cap the byte size, compute SHA-256, store base64 bytes locally, and advance to `rendered`.
- [ ] Implement `verifyPublicPublication`: fetch the canonical page for tier one, fetch the stored asset, require HTTPS/allowed public origin, status 200, correct content types, matching image hash, and article content hash marker; secondary releases verify only the asset endpoint.
- [ ] Ensure a failed capture or health check stores failure evidence but never changes the bundle to `verified`.
- [ ] Add tests for page 404, image 500, wrong MIME, wrong dimensions, hash mismatch, private/localhost production origin rejection, and successful secondary image-only verification.
- [ ] Run `node --test tests/market-publication.test.mjs`; require zero failures.
- [ ] Commit with `git commit -m "feat: persist verified market publications"`.

### Task 8: Add canonical public article pages

**Files:** Create `app/market-calendar/[week]/page.jsx`; create `app/data-updates/[release]/[date]/page.jsx`; create `tests/market-editorial-pages.test.mjs`.

- [ ] Extract or reuse the warm editorial primitives already proven in `app/market-news/[date]/page.jsx`; do not duplicate global navigation or create a conflicting brand system.
- [ ] Weekly page behavior:

  - Validate ISO week slugs.
  - Load `weeklyCalendarPublicationKey(week)` from the repository.
  - Return `notFound()` when no bundle/article exists.
  - Render core view, market setup, impact-ranked event table, tier-one analysis, scenario framework, daily watchlist, sources, limitations, and disclaimer.
  - Include `data-content-hash={bundle.contentHash}` on the article root for the health checker.

- [ ] Data Update page behavior:

  - Validate release slug and ISO date.
  - Load `dataUpdatePublicationKey(release, date)`.
  - Return `notFound()` for missing or secondary-only bundles.
  - Render the fact table, Data Signal, Market Confirmation, bounded reaction table, scenarios, watch-next, sources, limitations, and disclaimer.
  - Include the same content-hash marker.

- [ ] Add pure route/key tests for valid and invalid parameters. Rely on `npm run build` for App Router compilation and the later local-server health test for actual 200/404 behavior.
- [ ] Run `node --test tests/market-editorial-pages.test.mjs`; require zero failures.
- [ ] Commit with `git commit -m "feat: publish calendar and data analysis pages"`.

### Task 9: Serve the persisted image and retain preview compatibility

**Files:** Create `app/api/media/editorial/[product]/[slug]/route.js`; modify `app/api/media/card/route.js`; modify `tests/media-card-template.test.mjs`.

- [ ] Add route-contract tests that verify only `weekly-calendar` and `data-update` products are accepted and invalid slugs return 404/400 without repository lookups outside the expected key.
- [ ] Implement the durable route to:

  1. Load the publication bundle.
  2. Return stored PNG bytes with immutable ETag/cache headers when `imageAsset.base64` exists.
  3. Render the deterministic `posterModel` with `ImageResponse` only while the bundle is in `draft`, enabling `captureEditorialImage` to obtain the initial bytes.
  4. Return a non-200 response for missing or malformed records.

- [ ] Restyle only the `weekly-calendar` and `data-update` branches in `app/api/media/card/route.js` to the same warm paper, publication typography, restrained red/green, spacing, and footer system. Preserve Market News and unrelated card kinds.
- [ ] Keep the existing preview route dynamic and non-authoritative. Automation delivery must use `editorialAssetPath`, never a long query-string preview URL.
- [ ] Run `node --test tests/media-card-template.test.mjs tests/market-poster-models.test.mjs`; require zero failures.
- [ ] Commit with `git commit -m "feat: render durable editorial market cards"`.

### Task 10: Enforce official release eligibility in the monitor

**Files:** Modify `lib/data-release-monitor.mjs`; modify `tests/data-release-monitor.test.mjs`; modify `lib/market-official-releases.mjs` if a parser edge case is exposed.

- [ ] Add failing tests for these exact monitor outcomes:

  - Auxiliary actual present, official actual absent: `publishable: false`, `skipReason: "official-actual-unavailable"`.
  - Official actual arrives inside the release window: one releasable event is prepared.
  - Official actual timestamp predates scheduled time: `skipReason: "stale-actual"`.
  - Official and auxiliary values disagree: official value is selected and comparison evidence retained.
  - Two official values disagree: `skipReason: "source-conflict"`.
  - Unit or timezone ambiguity: the matching validation skip reason is returned.
  - Two simultaneous valid releases retain their existing sequential/idempotent behavior.

- [ ] Call `fetchOfficialActual` only for allowlisted events in the monitoring window, merge it through `market-provenance`, and carry `sourceManifest` and `eligibility` into the returned result.
- [ ] Preserve the current release lease, delivery receipt, durable send marker, timeout, and acknowledgment semantics. Do not weaken existing concurrency tests.
- [ ] Ensure a non-publishable result does not acknowledge or add the actual to `publishedKeys`; a later official value must remain eligible.
- [ ] Run `node --test tests/data-release-monitor.test.mjs`; require zero failures.
- [ ] Commit with `git commit -m "fix: block unverified data release publication"`.

### Task 11: Integrate article, asset, health, and community output into automation

**Files:** Modify `lib/automation-jobs.mjs`; modify `tests/automation.test.mjs`; modify `package.json`.

- [ ] Add failing Weekly Calendar automation tests for:

  - Dry-run returns article, poster, exactly-three community document, canonical page path, canonical asset path, source manifest, and does not persist or call external senders.
  - Live generation persists a draft, captures/stores the PNG, passes both public checks, then exposes `publishable: true`.
  - Page or image health failure returns `status: "skipped"` and sends nothing.
  - Re-running the same week/target/topic/language is deduplicated.

- [ ] Add failing Data Update automation tests for:

  - Tier one persists and verifies article + asset before preparing Telegram plans.
  - Secondary persists and verifies only the card; its community text has no article link.
  - Missing official actual blocks before persistence and delivery.
  - Partial market data yields `Awaiting Confirmation`, retains provider warnings, and may publish only when other evidence is valid.
  - Retry after successful external send remains protected by the existing durable send marker and target receipt.

- [ ] Generalize the current hard-coded Crypto Daily branch:

  ```js
  const marketDocument = generated?.communityDocument ?? generated?.document;
  ```

  Apply the same rule to Telegram and Discord plan builders without changing non-market jobs.

- [ ] Change each market job's build result to include `publication`, `articlePath`, `imagePath`, `articleUrl`, `imageUrl`, `communityDocument`, `sourceManifest`, and `contentHash` where applicable.
- [ ] For non-dry runs, enforce the sequence: validate → persist draft → capture image → health check → mark verified → build delivery plans → claim/send/acknowledge. Never send from a `draft` or `rendered` bundle.
- [ ] Use an idempotency key containing product, week or release identity, language, platform, chat/guild, and topic/channel. Preserve the existing stronger per-target data-release receipt logic.
- [ ] Add `lib/market-provenance.mjs`, `lib/market-official-releases.mjs`, `lib/market-editorial-articles.mjs`, and `lib/market-publication.mjs` to `npm run check`.
- [ ] Run `node --test tests/automation.test.mjs tests/data-release-monitor.test.mjs`; require zero failures.
- [ ] Commit with `git commit -m "feat: gate market delivery on verified publications"`.

### Task 12: Perform focused editorial and visual acceptance locally

**Files:** Test and evidence files only if an existing repository convention requires them; do not change product behavior during acceptance without returning to the corresponding task and tests.

- [ ] Run the focused product suite:

  ```bash
  node --test \
    tests/market-provenance.test.mjs \
    tests/market-official-releases.test.mjs \
    tests/market-content-sources.test.mjs \
    tests/market-impact-ranking.test.mjs \
    tests/market-content-templates.test.mjs \
    tests/market-editorial-articles.test.mjs \
    tests/market-poster-models.test.mjs \
    tests/market-publication.test.mjs \
    tests/market-editorial-pages.test.mjs \
    tests/data-release-monitor.test.mjs \
    tests/automation.test.mjs \
    tests/media-card-template.test.mjs
  ```

- [ ] Start the local application with a test-only repository and run both jobs in dry-run using fixed fixtures. Verify there are no network sends and capture the returned canonical page/asset paths.
- [ ] Open one Weekly Calendar page/card and three Data Update cases (complete forecast, missing forecast, partial reaction) locally. Inspect the 1200×675 PNGs at full size and at a 375-pixel mobile preview width.
- [ ] Apply the content acceptance checklist manually:

  - Exactly three Weekly Calendar priority events.
  - No unsourced actual/forecast/previous value.
  - Facts, observed reaction, and editorial inference are visibly separate.
  - Every reaction includes a time window.
  - Confirmation and invalidation are observable.
  - Secondary releases contain no dead article link.
  - Source footer and update timestamp remain legible.
  - Long names, negative values, missing forecasts, and weekend presence/absence do not clip.

- [ ] Record any failed item as a test first, fix in its owning module, rerun the focused suite, and only then continue.

### Task 13: Run the repository release gate and prepare a no-send handoff

**Files:** No product changes unless a gate fails.

- [ ] Run `npm run check`; expect exit code 0.
- [ ] Run `npm test`; expect zero failed tests.
- [ ] Run `npm run build`; expect exit code 0 and successful compilation of `/market-calendar/[week]`, `/data-updates/[release]/[date]`, and `/api/media/editorial/[product]/[slug]`.
- [ ] Scan for deferred markers and accidental secrets:

  ```bash
  rg -n "TODO|TBD|FIXME|example\\.com" lib app tests
  git diff --check
  git status --short
  ```

- [ ] Confirm no test wrote to production PostgreSQL, no Telegram/Discord sender was called, no GitHub push occurred, and no deployment command ran.
- [ ] Produce a handoff with commit SHA, test/build evidence, local preview paths, source-health matrix, known degraded routes, and the exact files changed.
- [ ] Stop and request explicit authorization for the release phase.

### Task 14: Separately authorized GitHub, production, and DEMO release

**Files:** Operational records only; this task is not authorized by approval of this implementation plan.

- [ ] After explicit release approval, push the reviewed commit to `code/academy`.
- [ ] Deploy the same commit SHA to production without replacing the local PostgreSQL primary database or deleting its volume.
- [ ] Run the existing production read-only release audit and verify the production SHA equals the pushed GitHub SHA.
- [ ] Generate the current live Weekly Calendar and an eligible live Data Update from real sources. If no official Data Update is eligible at release time, report that condition and do not substitute a fixture or stale event.
- [ ] Verify each production page and persisted asset over the public Academy origin before any community send.
- [ ] With separate Telegram-send approval, publish exactly one verified test set to the configured DEMO `market events` topic using the target-folder binding, not a hard-coded production audience.
- [ ] Record message IDs, idempotency keys, production URLs, image hashes, source health, timestamps, and the deployed SHA. Re-running the command must produce duplicate/skipped status rather than a second post.

---

## Ownership and acceptance

| Owner | Implementation responsibility | Acceptance evidence |
| --- | --- | --- |
| Jobs | Product coherence, tier rules, canonical information architecture | Weekly and Data Update products answer different reader questions without overlap or dead ends |
| MaYun | English editorial structure and commercial-quality community copy | Briefs meet exact structure, source discipline, and actionable confirmation/invalidation rules |
| LeiJun | Adapters, provenance, persistence, health gate, idempotency, production safety | Failure-path tests, restart persistence, page/asset verification, and no-send-before-ready proof |
| Musk | Editorial Research card system and responsive article pages | 1200×675 and 375-pixel inspections with no clipping or illegible metadata |
| Trump | Red/green test discipline and final release gate | Focused suite, full suite, checks, build, no-secret scan, and release authorization checkpoint |

These are ownership labels for execution and review, not an instruction to dispatch agents automatically.

## Risks and dependencies

- Official pages can change HTML structure. Parser schema failures must block release and expose a clear source-health error; fixture success alone does not justify lenient parsing.
- The BLS public time-series API can lag the release page, so it is a backfill/cross-check rather than the immediate publication authority.
- BEA and Federal Reserve releases are not uniform numerical APIs. FOMC prose interpretation must remain a labeled editorial inference and cannot be reduced to a guessed numeric surprise.
- Persisting base64 PNGs in JSONB increases row size. Enforce a byte cap, retain only the current version plus the existing repository's normal retention policy, and measure one representative asset before production release.
- Public health checks need the actual externally reachable Academy base URL. Localhost is allowed only in dry-run/local acceptance; non-dry production verification rejects private origins.
- Existing uncommitted work in the repository belongs to the user. Every task stages only its named paths and must inspect `git diff --cached --name-only` before committing.

## Self-review

- Spec coverage: both products map to source collection, provenance, ranking, article, community brief, card, persistence, health, automation, failure testing, and the separate release gate.
- Provider coverage: calendar/expectations have TradingView, Nasdaq, and Federal Reserve plus BLS/BEA official augmentation; immediate actuals have official BLS, BEA, and Federal Reserve adapters; crypto reaction has Binance, OKX, and Coinbase, with Yahoo DXY optional.
- Failure coverage: primary-source failure, stale cache, timezone conflict, unit conflict, missing forecast, missing official actual, official conflict, partial market data, malformed official HTML, page failure, asset failure, and retry duplication all have explicit tests.
- Type consistency: `weekly-calendar` and `data-update` remain the poster product names; article routes use `market-calendar` and `data-updates`; all community builders return the existing structured market-document contract.
- Persistence consistency: one versioned publication bundle stores article, community document, poster model, provenance, PNG bytes/hash, and health state through the existing local repository interface.
- Placeholder scan: the plan contains no implementation placeholders; live Data Update release remains deliberately conditional on a real, officially verified eligible event.
- Release safety: implementation approval does not authorize GitHub push, production deployment, or external community delivery.
