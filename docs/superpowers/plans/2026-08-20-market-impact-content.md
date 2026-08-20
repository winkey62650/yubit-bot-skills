# Market-Impact Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and DEMO-test three market-impact-first content products backed by at least three free source routes each.

**Architecture:** Source-specific adapters normalize official schedules, releases, industry stories, and market reaction into existing market document contracts. Pure ranking and poster-model functions keep editorial decisions testable, while the existing Next.js `ImageResponse` and Telegram delivery paths render and publish deterministic visuals.

**Tech Stack:** Node.js 20, Next.js 15, React 18, `next/og` ImageResponse, PostgreSQL repository, Node test runner, Telegram Bot API.

---

## File Structure

- `lib/market-content-sources.mjs`: free source adapters, normalization, health, and fallback composition.
- `lib/market-impact-ranking.mjs`: pure scoring and selection for news and calendar events.
- `lib/market-poster-models.mjs`: pure weekly-calendar and release-card view models.
- `lib/market-content-templates.mjs`: decision-brief document structure and Telegram rendering.
- `lib/automation-jobs.mjs`: job wiring, card URLs, and Telegram photo plans.
- `app/api/media/card/route.js`: deterministic `weekly-calendar` and `data-update` PNG layouts.
- `tests/market-content-sources.test.mjs`: adapter and degradation contracts.
- `tests/market-impact-ranking.test.mjs`: ranking and threshold contracts.
- `tests/market-poster-models.test.mjs`: poster view-model contracts.
- `tests/market-content-templates.test.mjs`: editorial and forecast semantics.
- `tests/automation.test.mjs`: URL and Telegram delivery contracts.

### Task 1: Market-impact ranking

**Files:** Create `lib/market-impact-ranking.mjs`; create `tests/market-impact-ranking.test.mjs`.

- [ ] Write tests proving reaction (35), policy/systemic (25), flow/breadth (20), corroboration (10), and recency (10) produce a 0–100 score and that the selector returns three to five items without category filler.
- [ ] Run `node --test tests/market-impact-ranking.test.mjs` and verify failure because the module is missing.
- [ ] Implement pure scoring, deterministic tie-breaking, thresholds, and reason labels.
- [ ] Re-run the test and verify all cases pass.
- [ ] Commit `test: define market impact ranking contract` and `feat: rank daily stories by market impact` as the red and green checkpoints where practical.

### Task 2: Multi-source ingestion and field-level fallback

**Files:** Modify `lib/market-content-sources.mjs`; modify `tests/market-content-sources.test.mjs`.

- [ ] Add failing fixtures/tests for SEC, CFTC, Fed, CoinDesk, Decrypt, and Cointelegraph feed composition; assert one failing feed does not erase healthy candidates.
- [ ] Add failing tests for BLS ICS, BEA schedule, Fed calendar, and ECB calendar normalization; assert TradingView is auxiliary.
- [ ] Add failing tests that official actual/previous values win field-level merging and that absent forecasts remain `null`.
- [ ] Run `node --test tests/market-content-sources.test.mjs` and confirm the new assertions fail for missing adapters.
- [ ] Implement the minimal adapters using the existing retry, timeout, schema validation, and source-health helpers.
- [ ] Re-run source tests and commit the source layer.

### Task 3: Decision-brief templates

**Files:** Modify `lib/market-content-templates.mjs`; modify `tests/market-content-templates.test.mjs`.

- [ ] Add failing tests for three-to-five ranked stories, no fixed empty categories, executive takeaway, affected assets/themes, observed-reaction wording, source/time, and watch boundary.
- [ ] Add failing tests for weekly maximum eight and release cards that label a supplied forecast as auxiliary while omitting a missing forecast.
- [ ] Run the focused test and verify the failures reflect the old fixed-section contract.
- [ ] Implement the new document and Telegram renderers while preserving structured nodes and URL safety.
- [ ] Re-run template tests and commit.

### Task 4: Poster models and visual routes

**Files:** Create `lib/market-poster-models.mjs`; create `tests/market-poster-models.test.mjs`; modify `app/api/media/card/route.js`; modify `lib/automation-jobs.mjs`; modify `tests/automation.test.mjs`.

- [ ] Add failing tests for a five-column weekly calendar model, eight-event cap, high-impact amber state, data-update actual/previous/revision fields, and optional auxiliary forecast.
- [ ] Add failing automation tests for `kind=weekly-calendar` and `kind=data-update` card URLs and `sendPhoto` plans.
- [ ] Run both focused test files and verify expected failures.
- [ ] Implement pure poster models, dynamic URL fields, and original Sculpted Signals layouts in `ImageResponse`.
- [ ] Re-run tests, start the app locally, download both PNG routes, and inspect them at 1200×675 for clipping and phone-scale legibility.
- [ ] Save the final representative PNG under `docs/design/` alongside the philosophy and commit.

### Task 5: Automation integration and degraded operation

**Files:** Modify `lib/automation-jobs.mjs`; modify `lib/data-release-monitor.mjs`; modify `tests/automation.test.mjs`; modify `tests/data-release-monitor.test.mjs`.

- [ ] Add failing tests that the three jobs consume normalized multi-source results, skip below-threshold content, and preserve source warnings.
- [ ] Add failing tests for idempotent revisions and cached/stale schedule labelling.
- [ ] Run focused tests and confirm expected failures.
- [ ] Wire the source composer, ranker, templates, posters, and existing repository checkpoints.
- [ ] Re-run focused tests and commit.

### Task 6: Release gate and real DEMO delivery

**Files:** Update operational documentation only if a newly required environment variable is introduced.

- [ ] Run `npm run check`.
- [ ] Run `npm test` and require zero failures.
- [ ] Run `npm run build` and require exit code 0.
- [ ] Start the release candidate on an accessible application origin and verify both PNG endpoints return `image/png` at 1200×675.
- [ ] Generate all three products from live sources; do not substitute sample records.
- [ ] Send exactly one test set to chat `-1003710405969`, topic `8`, then record Telegram message IDs and source-health evidence.
- [ ] Inspect the delivered result and report any degraded sources, omitted forecast fields, and the exact commit used.

## Self-Review

- Spec coverage: source diversity, ranking, three editorial products, visual reference, Telegram delivery, and DEMO-only acceptance each map to Tasks 1–6.
- Placeholder scan: the plan contains no deferred implementation markers; every task has explicit files, commands, and acceptance behaviour.
- Type consistency: `weekly-calendar` and `data-update` are the poster kinds throughout; source outputs preserve the existing `{events, sources, warnings}` envelope; forecasts remain nullable and explicitly auxiliary.

