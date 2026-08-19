# Automatic Market Content Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy Crypto News and Daily Events automations with reliable Crypto Daily, weekly Crypto & Macro Calendar, and event-driven Data Release Updates that render correctly on Telegram and Discord, preserve one rich CTA per destination, and expose safe previews and source health in the Chinese admin UI.

**Architecture:** Add a source-adapter layer that normalizes free public feeds into typed records, a pure template layer that selects and renders platform-neutral documents, and a repository-backed release monitor that owns event windows and deduplication. Keep `runAutomationJob` as the single preview/manual/scheduled pipeline, pass the distribution repository into it for calendar/release state, and retain the existing Telegram/Discord delivery planners and destination CTA hydration. Migrate saved rules idempotently, with release updates created disabled.

**Tech Stack:** Node.js ESM, Next.js App Router/React, Node test runner, JSON/Postgres distribution repositories, Telegram Bot API HTML, Discord Markdown, Playwright release scripts, TradingView/BLS/BEA/Federal Reserve/RSS/Binance/OKX public sources.

---

## File map

**Create**

- `lib/market-content-sources.mjs` — timeouts, retries, source health, RSS/calendar/price normalization.
- `lib/market-content-templates.mjs` — deterministic selection, impact rules, structured documents, TG/DC renderers.
- `lib/data-release-monitor.mjs` — release window polling, cached weekly events, repository state, deduplication.
- `tests/fixtures/market-content/tradingview-calendar.json` — stable macro event fixture.
- `tests/fixtures/market-content/industry-feed.xml` — duplicate and category news cases.
- `tests/fixtures/market-content/official-feed.xml` — official-source replacement cases.
- `tests/fixtures/market-content/binance-tickers.json` — BTC/ETH reaction fixture.
- `tests/fixtures/market-content/okx-tickers.json` — fallback reaction fixture.
- `tests/market-content-sources.test.mjs` — adapter and degradation tests.
- `tests/market-content-templates.test.mjs` — template structure, escaping, and impact-rule tests.
- `tests/data-release-monitor.test.mjs` — event windows, persistence, and deduplication tests.
- `scripts/migrate-market-content-rules.cjs` — explicit dry-run/apply production migration command.

**Modify**

- `lib/automation-jobs.mjs` — register and run the three new jobs through the common structured pipeline.
- `lib/distribution-domain.mjs` — add weekly/event-driven schedules and idempotent rule migration.
- `lib/distribution-repository.mjs` — normalize migrated rules consistently in JSON and Postgres paths.
- `lib/distribution-service.mjs` — map new types, pass repository state, and reject non-publishable output.
- `lib/distribution-ui.mjs` — Chinese labels, fixed schedule metadata, previews, source-health presentation data.
- `lib/discord-template-publish.mjs` — use new job IDs in direct Discord publishing.
- `app/api/automation-test/route.js` — use repository-backed dry-run without mutating release state.
- `app/distribution/page.jsx` — replace old options and show structure/source/warning/next-event data.
- `app/discord/distribution/page.jsx` — replace legacy Discord template options.
- `scripts/provision-production-distribution.cjs` — plan new standard rules without enabling release updates.
- `scripts/audit-production-release.cjs` — audit new IDs, schedules, source health, and migration counts.
- `scripts/audit-distribution-templates.cjs` — preview the new templates without delivery.
- `scripts/reconcile-production-release.cjs` — require the new content types.
- `scripts/test-production-automation-delivery.cjs` — update explicit live-test targets but retain the live-send gate.
- `scripts/send-demo-template-previews.cjs` — update IDs only; do not run without explicit approval.
- `package.json` — syntax-check new modules and expose migration command.
- Existing tests in `tests/automation.test.mjs`, `tests/distribution-domain.test.mjs`, `tests/distribution-service.test.mjs`, `tests/distribution-ui.test.mjs`, `tests/distribution-page.test.mjs`, `tests/discord-template-publish.test.mjs`, `tests/distribution-repository.test.mjs`, and `tests/trading-operations.test.mjs`.

## Task 1: Normalize free public sources and health telemetry

**Files:**

- Create: `lib/market-content-sources.mjs`
- Create: `tests/fixtures/market-content/tradingview-calendar.json`
- Create: `tests/fixtures/market-content/industry-feed.xml`
- Create: `tests/fixtures/market-content/official-feed.xml`
- Create: `tests/fixtures/market-content/binance-tickers.json`
- Create: `tests/fixtures/market-content/okx-tickers.json`
- Create: `tests/market-content-sources.test.mjs`

- [ ] **Step 1: Write failing adapter tests**

Cover TradingView fields and units, `TBD` dates, RSS XML entities, source labels, bounded retry, timeout, Binance-to-OKX fallback, and optional DXY degradation. Use injected `fetchImpl`; tests must never call the network.

```js
test("normalizes calendar values without inventing missing fields", async () => {
  const result = normalizeCalendarEvents(fixture.result);
  assert.deepEqual(result[0].values, {
    actual: "2.7%",
    forecast: "2.8%",
    previous: "2.9%"
  });
  assert.equal(result[1].scheduledAt, null);
  assert.equal(result[1].timeLabel, "TBD");
});

test("falls back from Binance to OKX and treats DXY as optional", async () => {
  const result = await fetchMarketReaction({ fetchImpl, symbols: ["BTC", "ETH", "DXY"] });
  assert.equal(result.prices.BTC.source, "OKX");
  assert.equal(result.prices.DXY, undefined);
  assert.match(result.warnings[0], /DXY/);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test tests/market-content-sources.test.mjs`

Expected: `ERR_MODULE_NOT_FOUND` for `lib/market-content-sources.mjs`.

- [ ] **Step 3: Implement source adapters with stable return contracts**

Export `DEFAULT_SOURCE_TIMEOUT_MS = 8_000` plus these exact function signatures: `fetchTradingViewCalendar({ from, to, fetchImpl = fetch, timeoutMs } = {})`, `normalizeCalendarEvents(events = [])`, `parseRssFeed(xml, source)`, `fetchCryptoDailyCandidates({ now, fetchImpl = fetch, feeds, timeoutMs } = {})`, and `fetchMarketReaction({ beforeAt, now, fetchImpl = fetch, symbols = ["BTC", "ETH", "DXY"] } = {})`.

Every returned bundle must contain `data`, `sources`, and `warnings`. Each source record must contain `id`, `url`, `status`, `checkedAt`, `lastSuccessAt`, `freshnessSeconds`, and optional `fallbackFrom`. Retry only GET requests, at most twice, with an injected/no-op delay in tests. Preserve raw source IDs and raw values for later conflict reporting.

- [ ] **Step 4: Run adapter tests**

Run: `node --test tests/market-content-sources.test.mjs`

Expected: all tests pass with zero external requests.

- [ ] **Step 5: Commit**

```bash
git add lib/market-content-sources.mjs tests/fixtures/market-content tests/market-content-sources.test.mjs
git commit -m "feat: normalize market content sources"
```

## Task 2: Build deterministic documents and platform renderers

**Files:**

- Create: `lib/market-content-templates.mjs`
- Create: `tests/market-content-templates.test.mjs`

- [ ] **Step 1: Write failing pure-logic tests**

Test exactly three fixed Crypto Daily sections, neutral empty-section text, duplicate-story collapse, official-link replacement, Monday-to-Sunday UTC calendar grouping, missing-value omission, inflation/employment/growth/FOMC impact rules, neutral fallback, Telegram HTML escaping, and Discord Markdown escaping.

```js
test("Crypto Daily always has the three approved sections", () => {
  const document = buildCryptoDailyDocument({ now, candidates });
  assert.deepEqual(document.sections.map((item) => item.id), [
    "btc-etf-institutional", "regulation", "market-project"
  ]);
  assert.equal(document.sections.length, 3);
});

test("renderers do not leak source Markdown across platforms", () => {
  const document = buildCryptoDailyDocument({ now, candidates: unsafeCandidates });
  assert.match(renderTelegramMarketDocument(document), /<a href=/);
  assert.doesNotMatch(renderTelegramMarketDocument(document), /\]\(https:/);
  assert.match(renderDiscordMarketDocument(document), /\]\(https:/);
  assert.doesNotMatch(renderDiscordMarketDocument(document), /<a href=/);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test tests/market-content-templates.test.mjs`

Expected: module-not-found failure.

- [ ] **Step 3: Implement the structured document contract**

Export the following APIs and keep all selection/rendering deterministic. Define the approved constants exactly as follows:

```js
export const MARKET_CONTENT_TEMPLATE_VERSION = "market-content-v1";
export const CRYPTO_DAILY_SECTIONS = Object.freeze([
  "btc-etf-institutional",
  "regulation",
  "market-project"
]);
export const RELEASE_INDICATOR_ALLOWLIST = Object.freeze([
  "cpi", "core-cpi", "pce", "core-pce", "nonfarm-payrolls",
  "unemployment-rate", "average-hourly-earnings", "fomc-rate-decision",
  "fomc-statement", "gdp", "ppi", "retail-sales", "initial-jobless-claims"
]);
```

The module must also export these exact functions: `classifyCryptoStory(story)`, `deduplicateCryptoStories(stories)`, `rankCryptoStories(stories, now)`, `buildCryptoDailyDocument({ now, candidates })`, `buildWeeklyCalendarDocument({ now, events })`, `evaluateReleaseImpact(release)`, `buildDataReleaseDocument({ event, reaction })`, `renderTelegramMarketDocument(document)`, and `renderDiscordMarketDocument(document)`.

Use concrete node objects such as `{ type: "heading", text: "Crypto Daily" }`, `{ type: "paragraph", text: "Verified update" }`, `{ type: "link", text: "Source", url: "https://example.com" }`, `{ type: "metric", label: "Actual", value: "2.7%" }`, and `{ type: "divider" }`; do not store prebuilt Markdown in the document. Unknown/missing evidence always becomes Neutral. Never emit `null`, `undefined`, or guessed times.

- [ ] **Step 4: Run pure template tests**

Run: `node --test tests/market-content-templates.test.mjs`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/market-content-templates.mjs tests/market-content-templates.test.mjs
git commit -m "feat: add structured market content templates"
```

## Task 3: Add repository-backed release monitoring and deduplication

**Files:**

- Create: `lib/data-release-monitor.mjs`
- Create: `tests/data-release-monitor.test.mjs`

- [ ] **Step 1: Write failing monitor tests with an in-memory repository double**

Cover the `-5m` to `+15m` window, one-minute polling, new Actual detection, conflicts, stale Actual rejection, end-of-window timeout, exact deduplication key, non-mutating dry-run, and a second poll that cannot publish twice.

```js
test("publishes a new Actual once and persists the deduplication key", async () => {
  const first = await pollDataReleaseUpdates({ now, repository, fetchCalendar, fetchReaction, persist: true });
  const second = await pollDataReleaseUpdates({ now: plusMinute(now), repository, fetchCalendar, fetchReaction, persist: true });
  assert.equal(first.publishable, true);
  assert.equal(second.publishable, false);
  assert.equal(second.skipReason, "duplicate-release");
});

test("dry-run reports the next event without mutating meta", async () => {
  const result = await pollDataReleaseUpdates({ now, repository, fetchCalendar, persist: false });
  assert.ok(result.nextMonitoredEvent);
  assert.equal(await repository.getMeta(RELEASE_STATE_META_KEY), null);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test tests/data-release-monitor.test.mjs`

Expected: module-not-found failure.

- [ ] **Step 3: Implement the state machine**

Use these exact exports and signatures:

```js
export const RELEASE_STATE_META_KEY = "market-content:release-state:v1";
export const WEEKLY_CALENDAR_META_KEY = "market-content:weekly-calendar:v1";
```

The five functions are `buildReleaseDeduplicationKey(event)`, `releaseWindowStatus(event, now)`, `selectReleasableEvents(events, state, now)`, `cacheWeeklyCalendar(repository, calendar, { persist = true } = {})`, and `pollDataReleaseUpdates(options = {})`.

Persist `{ calendarWeek, monitoredEvents, publishedKeys, timedOutKeys, updatedAt }` through `getMeta`/`setMeta`. If the weekly cache is absent or stale, refresh the calendar through the injected adapter; this bootstrap is allowed but must be reported in `warnings`. If sources conflict, return `publishable: false`, `skipReason: "source-conflict"`, and both raw values.

- [ ] **Step 4: Run monitor tests**

Run: `node --test tests/data-release-monitor.test.mjs`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/data-release-monitor.mjs tests/data-release-monitor.test.mjs
git commit -m "feat: monitor scheduled data releases"
```

## Task 4: Replace legacy automation jobs with the common content pipeline

**Files:**

- Modify: `lib/automation-jobs.mjs`
- Modify: `tests/automation.test.mjs`

- [ ] **Step 1: Replace legacy job assertions with failing new-job assertions**

```js
assert.deepEqual(AUTOMATION_JOBS.map((job) => job.id), [
  "crypto-daily", "weekly-calendar", "data-release-updates",
  "daily-analysis", "whale-hourly", "agent-sync-4h"
]);
assert.equal(automationSlot("weekly-calendar", new Date("2026-08-19T10:00:00Z")), "2026-W34");
assert.equal(automationSlot("data-release-updates", new Date("2026-08-19T10:40:59Z")), "2026-08-19T10:40");
```

Add fixture-backed tests that all three jobs return `templateId`, `document`, `sources`, `warnings`, `deduplicationKey`, and `publishable`; ensure a non-publishable release produces `skipped` and invokes no sender.

- [ ] **Step 2: Run the focused test and confirm legacy failures**

Run: `node --test tests/automation.test.mjs`

Expected: assertions still see `news-feed` and `daily-events`.

- [ ] **Step 3: Register and generate the new jobs**

Update `AUTOMATION_JOBS`, `JOB_CONTENT_TYPES`, `FIXED_EDITORIAL_JOBS`, `automationSlot`, `buildContent`, duplicate handling, and `automationTemplateMetadata`. Change the call to:

```js
const generated = await buildContent(jobId, now, {
  persist: !dryRun,
  repository: options.repository,
  fetchImpl: options.fetchImpl
});
```

For `weekly-calendar`, cache monitored events only when `persist` is true. For `data-release-updates`, return `skipped` before delivery whenever `publishable !== true`, including the precise `skipReason` in the run log.

- [ ] **Step 4: Make both delivery planners consume the platform renderers**

Telegram must send `renderTelegramMarketDocument(document)` with `parse_mode: "HTML"`; Discord must send `renderDiscordMarketDocument(document)`. Append the already-hydrated target CTA after platform rendering. Split only at paragraph boundaries under Telegram 4096/Discord 2000 character limits and place CTA in the final chunk exactly once.

- [ ] **Step 5: Run automation tests**

Run: `node --test tests/automation.test.mjs tests/market-content-templates.test.mjs tests/data-release-monitor.test.mjs`

Expected: all tests pass, including TG/DC render snapshots and no-send skip cases.

- [ ] **Step 6: Commit**

```bash
git add lib/automation-jobs.mjs tests/automation.test.mjs
git commit -m "feat: run new market content automations"
```

## Task 5: Add schedules and idempotently migrate saved rules

**Files:**

- Modify: `lib/distribution-domain.mjs`
- Modify: `lib/distribution-repository.mjs`
- Modify: `tests/distribution-domain.test.mjs`
- Modify: `tests/distribution-repository.test.mjs`

- [ ] **Step 1: Write failing schedule and migration tests**

Test Monday `00:30 UTC` from every weekday/boundary, event-driven next-minute boundaries, legacy identity/targets/enabled-state preservation, release-rule default disabled, idempotency, and no recreation of targets absent from the original rule.

```js
assert.equal(
  computeNextRunAt("weekly-monday-0030-utc", new Date("2026-08-17T00:29:59Z")).toISOString(),
  "2026-08-17T00:30:00.000Z"
);
assert.equal(
  computeNextRunAt("event-driven", new Date("2026-08-19T10:40:01Z")).toISOString(),
  "2026-08-19T10:41:00.000Z"
);
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test tests/distribution-domain.test.mjs tests/distribution-repository.test.mjs`

Expected: unknown schedule/type and legacy count assertion failures.

- [ ] **Step 3: Implement schedule and migration APIs**

Add schedule entries:

```js
"weekly-monday-0030-utc": { label: "每周一 00:30 UTC", kind: "weekly" },
"event-driven": { label: "事件驱动，每分钟检查", minutes: 1, kind: "monitor" }
```

Export `migrateMarketContentRules(rules, now)` returning `{ rules, changes }`. Map `news -> crypto-daily` and `daily-events -> weekly-calendar`; create one deterministic sibling `data-release-updates` rule per migrated calendar using an ID derived from the calendar rule ID, copied targets, `enabled: false`, and `schedulePreset: "event-driven"`. Re-running returns `changes: []`.

- [ ] **Step 4: Apply migration normalization consistently**

Call the pure migration helper when loading JSON rules and when listing Postgres rules, but do not persist implicit changes there. Explicit persistence belongs to the migration/provision command in Task 9. Keep old fields readable for rollback.

- [ ] **Step 5: Update standard production specs**

Replace standard `news`/`daily-events` specs with `crypto-daily`, `weekly-calendar`, and disabled `data-release-updates`; keep Daily Analysis, Whale Signals, Agent Sync, and the seven broadcast rules unchanged. Update count and topic assertions.

- [ ] **Step 6: Run tests and commit**

Run: `node --test tests/distribution-domain.test.mjs tests/distribution-repository.test.mjs`

Expected: all tests pass.

```bash
git add lib/distribution-domain.mjs lib/distribution-repository.mjs tests/distribution-domain.test.mjs tests/distribution-repository.test.mjs
git commit -m "feat: migrate market content schedules"
```

## Task 6: Wire service execution, preview API, persistence, and skip logs

**Files:**

- Modify: `lib/distribution-service.mjs`
- Modify: `app/api/automation-test/route.js`
- Modify: `tests/distribution-service.test.mjs`

- [ ] **Step 1: Write failing service tests**

Cover new type-to-job mappings, repository passed to runner, dry-run preview with no external sends or meta mutation, non-publishable skip events, source/warning data stored in the event payload, and scheduled release rescheduling to the next minute.

```js
assert.equal(captured.jobId, "data-release-updates");
assert.equal(captured.options.repository, repository);
assert.equal(sendCalls.length, 0);
assert.equal(updatedEvent.payload.outcome, "skipped");
assert.equal(updatedEvent.payload.preview.skipReason, "actual-not-available");
```

- [ ] **Step 2: Run the service tests and confirm failure**

Run: `node --test tests/distribution-service.test.mjs`

Expected: unsupported `crypto-daily`, `weekly-calendar`, or `data-release-updates` failures.

- [ ] **Step 3: Implement the mappings and repository handoff**

Update `automationJobIds` to the new IDs and pass `repository` into `runner`. Persist preview telemetry in the existing event payload:

```js
payload: {
  ...event.payload,
  templateId: run.preview?.templateId,
  templateVersion: run.preview?.templateVersion,
  sources: run.preview?.sources ?? [],
  warnings: run.preview?.warnings ?? [],
  deduplicationKey: run.preview?.deduplicationKey ?? null,
  skipReason: run.preview?.skipReason ?? null,
  preview: run.preview ?? null,
  deliveryPlans,
  outcome: run.status
}
```

Do not create delivery rows for `skipped`/`duplicate` results. Existing target hydration remains the sole CTA lookup before running the job.

- [ ] **Step 4: Make preview use the same repository-backed path safely**

In `app/api/automation-test/route.js`, load `getDistributionRepository()` and call `runAutomationJob` with `repository`, `dryRun: true`, and `force: true`. Do not expose an API parameter that can turn dry-run off.

- [ ] **Step 5: Run service tests and commit**

Run: `node --test tests/distribution-service.test.mjs tests/automation.test.mjs`

Expected: all tests pass.

```bash
git add lib/distribution-service.mjs app/api/automation-test/route.js tests/distribution-service.test.mjs
git commit -m "feat: integrate market content distribution"
```

## Task 7: Optimize the Chinese admin configuration and preview experience

**Files:**

- Modify: `lib/distribution-ui.mjs`
- Modify: `app/distribution/page.jsx`
- Modify: `app/discord/distribution/page.jsx`
- Modify: `tests/distribution-ui.test.mjs`
- Modify: `tests/distribution-page.test.mjs`

- [ ] **Step 1: Write failing UI metadata and source-health tests**

Assert the old options are absent, the three Chinese labels and schedules are present, the default new rule is Crypto Daily, fixed schedules cannot drift, and preview facts expose candidates/selected/missing/conflicts/next event.

```js
assert.deepEqual(Object.keys(CONTENT_TEMPLATES).slice(0, 3), [
  "crypto-daily", "weekly-calendar", "data-release-updates"
]);
assert.equal(getContentTemplate("data-release-updates").scheduleLocked, true);
assert.deepEqual(buildMarketPreviewFacts(preview), {
  candidateCount: 12,
  selectedCount: 3,
  missingCount: 0,
  conflictCount: 0,
  nextMonitoredEvent: "US CPI · Aug 19 12:30 UTC"
});
```

- [ ] **Step 2: Run UI tests and confirm legacy failures**

Run: `node --test tests/distribution-ui.test.mjs tests/distribution-page.test.mjs`

Expected: old `news`/`daily-events` options are still present.

- [ ] **Step 3: Replace template metadata and options**

Use Chinese labels:

```js
["crypto-daily", "每日 Crypto 新闻"],
["weekly-calendar", "每周数据日历"],
["data-release-updates", "数据公布快讯"]
```

Set `scheduleLocked: true` for all three and add the two new schedules to the selector. Keep Daily Analysis, Whale Signals, and Agent Sync unchanged. Remove the old neutral Daily Events preview; use structure examples generated from the same document renderer.

- [ ] **Step 4: Add safe preview diagnostics**

Rename the preview action to `立即测试并预览`. Display `publishable`, source status/last success/freshness/fallback, candidate and selected counts, missing/conflict warnings, skip reason, and `nextMonitoredEvent`. Render returned Telegram HTML into safe readable plain text with existing `stripTelegramHtml`; never call a send endpoint from this button.

- [ ] **Step 5: Clarify fixed schedules and CTA scope**

Disable the schedule select when `template.scheduleLocked` or for Whale Signals. Show the existing notice that Telegram Topics share one group CTA and Discord channels share one server CTA. Do not add per-topic or per-channel CTA fields to automation rules.

- [ ] **Step 6: Run UI tests and commit**

Run: `node --test tests/distribution-ui.test.mjs tests/distribution-page.test.mjs`

Expected: all tests pass.

```bash
git add lib/distribution-ui.mjs app/distribution/page.jsx app/discord/distribution/page.jsx tests/distribution-ui.test.mjs tests/distribution-page.test.mjs
git commit -m "feat: update market automation admin UI"
```

## Task 8: Prove Telegram/Discord parity and destination CTA behavior

**Files:**

- Modify: `lib/discord-template-publish.mjs`
- Modify: `tests/discord-template-publish.test.mjs`
- Modify: `tests/destination-cta.test.mjs`
- Modify: `tests/automation.test.mjs`

- [ ] **Step 1: Write failing cross-platform regression tests**

For each new template, publish to two Telegram topics in one group and two Discord channels in one guild. Assert only one stored CTA key per group/guild, the current CTA is hydrated at send time, formatting is platform-correct, CTA appears once in the final chunk, and an empty CTA adds no divider.

```js
assert.equal(telegramPlans[0].steps.at(-1).payload.text.match(/START TRADING NOW/g).length, 1);
assert.equal(discordPlans[0].steps.at(-1).payload.content.match(/START TRADING NOW/g).length, 1);
assert.doesNotMatch(telegramPlans[0].steps.at(-1).payload.text, /\]\(https:/);
assert.doesNotMatch(discordPlans[0].steps.at(-1).payload.content, /<a href=/);
```

- [ ] **Step 2: Run tests and confirm mapping failures**

Run: `node --test tests/discord-template-publish.test.mjs tests/destination-cta.test.mjs tests/automation.test.mjs`

Expected: direct Discord publishing does not recognize the new types.

- [ ] **Step 3: Update direct Discord mappings and shared assertions**

Map `crypto-daily`, `weekly-calendar`, and `data-release-updates` to same-named jobs. Do not duplicate rendering or CTA logic in `discord-template-publish.mjs`; call `runAutomationJob` and use its planners.

- [ ] **Step 4: Run tests and commit**

Run: `node --test tests/discord-template-publish.test.mjs tests/destination-cta.test.mjs tests/automation.test.mjs`

Expected: all tests pass.

```bash
git add lib/discord-template-publish.mjs tests/discord-template-publish.test.mjs tests/destination-cta.test.mjs tests/automation.test.mjs
git commit -m "test: verify market templates across tg and discord"
```

## Task 9: Add safe production migration, provisioning, and audit commands

**Files:**

- Create: `scripts/migrate-market-content-rules.cjs`
- Modify: `scripts/provision-production-distribution.cjs`
- Modify: `scripts/audit-production-release.cjs`
- Modify: `scripts/audit-distribution-templates.cjs`
- Modify: `scripts/reconcile-production-release.cjs`
- Modify: `scripts/test-production-automation-delivery.cjs`
- Modify: `scripts/send-demo-template-previews.cjs`
- Modify: `package.json`
- Modify: `tests/trading-operations.test.mjs`
- Modify: `tests/release-gate.test.mjs`

- [ ] **Step 1: Write failing operational safety tests**

Assert migration defaults to dry-run, requires both `MIGRATION_APPLY=true` and the existing production configuration authorization to save, never calls `run-now`, creates release rules disabled, and audit/preview commands never call delivery endpoints.

- [ ] **Step 2: Run tests and confirm missing-command failures**

Run: `node --test tests/trading-operations.test.mjs tests/release-gate.test.mjs`

Expected: missing migration script/package command and legacy content type assertions.

- [ ] **Step 3: Implement the explicit migration command**

Add `release:migrate:market-content` to `package.json`. The script must log a comparable before/after plan by default and only POST saved rules when both apply gates pass. It must not delete old records, re-create missing demo/test destinations, enable release updates, or send messages.

```js
const apply = process.env.MIGRATION_APPLY === "true";
authorizeProductionConfiguration(process.env, {
  operation: "市场内容模板规则迁移",
  apply
});
```

- [ ] **Step 4: Update provisioning and audits**

Provision/audit the six automation types (three new plus Daily Analysis, Whale Signals, Agent Sync) and seven existing broadcasts. Audit exact schedules, disabled release rule, valid targets, source health, preview `publishable`/skip reason, and duplicate destination records. Keep `scripts/test-production-automation-delivery.cjs` behind `authorizeLiveTelegramOperation`; updating IDs does not authorize running it.

- [ ] **Step 5: Extend syntax checks**

Add all three new `lib/*.mjs` files and `scripts/migrate-market-content-rules.cjs` to `npm run check`.

- [ ] **Step 6: Run tests and commit**

Run: `node --test tests/trading-operations.test.mjs tests/release-gate.test.mjs`

Expected: all tests pass.

```bash
git add scripts package.json tests/trading-operations.test.mjs tests/release-gate.test.mjs
git commit -m "chore: add safe market content rollout"
```

## Task 10: Full verification, GitHub sync, production deploy, and read-only acceptance

**Files:**

- Modify only if failures expose a defect in files already listed above.

- [ ] **Step 1: Run all local quality gates**

```bash
npm test
npm run check
npm run build
git diff --check
```

Expected: all tests pass, syntax checks exit 0, Next.js build succeeds, and `git diff --check` is silent.

- [ ] **Step 2: Self-review against the approved specification**

Check every acceptance criterion in `docs/superpowers/specs/2026-08-19-automatic-market-content-templates-design.md`. Search for unfinished markers and legacy user-facing types:

```bash
rg -n "TODO|TBD_IMPLEMENTATION|PLACEHOLDER|news-feed|daily-events|Crypto News|Daily Events" lib app scripts tests package.json
```

Expected: no unfinished markers; legacy IDs remain only in explicit backward-compatibility migration tests/mappings, never as a new-rule UI option. Verify new function signatures match every caller and test double.

- [ ] **Step 3: Commit any verification fixes, then push GitHub**

```bash
git status --short
git push origin code/academy
git rev-parse HEAD
git rev-parse origin/code/academy
```

Expected: local and remote SHAs match and the working tree is clean.

- [ ] **Step 4: Back up and deploy production without live delivery**

Use the repository's existing release workflow and credentials. First capture the current production release/config audit artifact. Deploy the exact pushed SHA. Run the migration in dry-run, inspect counts/targets, then apply only the idempotent rule migration. Do **not** run `release:test:automations` or `send-demo-template-previews.cjs` without fresh explicit user approval.

- [ ] **Step 5: Perform read-only production acceptance**

Run the authenticated release audit and all three `/api/automation-test` previews. Reload the admin page after saving a disabled test configuration and verify the value persists. Confirm:

- new template labels and fixed schedules are visible;
- Crypto Daily returns exactly three sections;
- weekly calendar uses Monday–Sunday UTC text blocks;
- release preview shows next monitored event or a precise skip reason;
- source health/warnings are visible;
- migrated targets are unchanged and release rules remain disabled;
- TG group and Discord server CTA values remain present after reload;
- no production Telegram or Discord message was generated.

- [ ] **Step 6: Record release evidence and rollback coordinates**

Save pushed SHA, deployed SHA, migration before/after counts, audit output, preview timestamps, and backup reference in the existing release artifact location. If any gate fails, redeploy the previous production SHA; retain new disabled rules and logs for diagnosis, as specified in the design.

## Definition of done

- The admin can create only the three new market content templates (plus retained unrelated templates), using the approved fixed schedules.
- Preview, manual run, and scheduled run use the same generator and persisted configuration.
- Free sources are traceable; missing/conflicting/stale critical data never produces a publishable message.
- Telegram and Discord show native formatting, with no raw Markdown leakage.
- One current CTA per Telegram group or Discord server is appended once at send time across all topics/channels.
- Legacy rules migrate idempotently without recreating departed demo/test destinations; release updates start disabled.
- GitHub `code/academy` and production run the same verified SHA, with no real channel test message sent without explicit approval.
