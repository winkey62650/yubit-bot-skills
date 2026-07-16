# Multi-Trader Trading Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a production-ready trading center where authorized Traders submit a YUBIT symbol and order ID to SpeakerBot, the server verifies the real filled order through read-only YUBIT APIs, publishes the verified signal to configured Telegram Topics, tracks closure, and publishes exactly one PNL card only for realized profit.

**Architecture:** Add a separate trading domain beside the existing distribution domain. A Postgres repository owns Traders, encrypted exchange credentials, immutable signal events, destinations, deliveries, webhook idempotency, reconciliation leases, and PNL publication state; local development uses a JSON repository only outside production. A dedicated SpeakerBot webhook validates private-chat identity before calling a read-only YUBIT adapter. A five-minute authenticated scheduler reconciles open signals. The authenticated `/trading` UI manages configuration and displays safe, masked operational state.

**Tech Stack:** Next.js 15 App Router, React 18, Node.js 20 ESM, Neon Postgres, Telegram Bot API, YUBIT OpenAPI read-only contract endpoints, Web Crypto/Node crypto AES-256-GCM, `node:test`, Vercel, GitHub Actions scheduler.

---

## File map

New domain and services:

- `lib/trading-domain.mjs`: command parsing, normalization, status transitions, signal copy, closed-PNL matching, ROI calculation, safe error codes.
- `lib/trading-crypto.mjs`: AES-256-GCM credential encryption/decryption and API-key masking.
- `lib/yubit-readonly-client.mjs`: signed GET-only access to order history, executions, and closed PNL.
- `lib/trading-repository.mjs`: JSON development repository, Neon repository, schema initialization, idempotent claims and leases.
- `lib/trading-service.mjs`: Trader/account/destination management, SpeakerBot update handling, Telegram delivery, reconciliation, PNL publication, health checks.
- `lib/pnl-card.mjs`: signed public card payload and image display model.

New authenticated UI and APIs:

- `app/trading/page.jsx`: 交易日志、Trader 管理、发布目标、系统状态.
- `app/api/trading/route.js`: dashboard query and safe management actions.
- `app/api/trading/signals/[id]/route.js`: signal detail.
- `app/api/trading/signals/[id]/refresh/route.js`: manual reconciliation.
- `app/api/trading/deliveries/[id]/retry/route.js`: failed-target retry.
- `app/api/telegram/speaker-webhook/route.js`: public, secret-verified SpeakerBot updates.
- `app/api/cron/trading-reconcile/route.js`: authenticated five-minute reconciliation.
- `app/api/media/pnl-card/route.js`: signed public `ImageResponse` PNL card.

Changed integration files:

- `app/components/ConsoleShell.jsx`: add `/trading` navigation.
- `middleware.js`: allow only the SpeakerBot webhook, media, and cron endpoints through middleware; each public API verifies its own secret.
- `.env.example`: document required trading secrets without values.
- `.github/workflows/telegram-automations.yml`: call trading reconciliation alongside distribution every five minutes.
- `README.md`: operator setup, Webhook setup, Trader format, safety boundary, and release checklist.
- `package.json`: include new server modules in `npm run check`.

Tests:

- `tests/trading-domain.test.mjs`
- `tests/trading-crypto.test.mjs`
- `tests/yubit-readonly-client.test.mjs`
- `tests/trading-repository.test.mjs`
- `tests/trading-service.test.mjs`
- `tests/trading-routes.test.mjs`
- `tests/pnl-card.test.mjs`
- `tests/trading-ui.test.mjs`

## Task 1: Lock domain invariants with failing tests

**Files:**

- Create: `tests/trading-domain.test.mjs`
- Create: `lib/trading-domain.mjs`

- [ ] Add tests for `parseTraderMessage(text)`:
  - `BTCUSDT 1234567890` parses to a submit command.
  - optional `TP:`, `SL:`, and `Rationale:` lines are preserved as Trader annotations.
  - `/status` and `/refresh` require symbol and order ID.
  - missing symbol/order ID returns a safe help result.
  - symbol is uppercased and constrained to `[A-Z0-9]{2,30}`; order ID is constrained to `[A-Za-z0-9_-]{4,128}`.
- [ ] Add tests for `deriveVerifiedOrder(order, executions)`:
  - rejects missing order, non-filled order, and no executions.
  - calculates total filled quantity and weighted average entry from executions.
  - derives Long/Short from `side` and preserves official leverage only when finite.
- [ ] Add tests for `matchClosedPnl(signal, records)`:
  - direct unique order ID match wins.
  - otherwise a unique size/direction/time-window match wins.
  - zero candidates returns `pending`; multiple candidates returns `ambiguous`.
- [ ] Add tests for `computeVerifiedRoi(signal, closedRecord)` returning a value only when entry, quantity, leverage, and PNL make the method auditable.
- [ ] Add tests for `formatVerifiedSignal(signal, trader)` and `formatPnlCaption(signal, trader)` so YUBIT-verified fields and Trader annotations are visibly separated.
- [ ] Run `node --test tests/trading-domain.test.mjs` and confirm failure because the module does not exist.
- [ ] Implement the pure functions without I/O or secrets.
- [ ] Run `node --test tests/trading-domain.test.mjs` and confirm pass.
- [ ] Commit: `feat: add verified trading domain rules`.

## Task 2: Encrypt credentials and implement the GET-only YUBIT adapter

**Files:**

- Create: `tests/trading-crypto.test.mjs`
- Create: `tests/yubit-readonly-client.test.mjs`
- Create: `lib/trading-crypto.mjs`
- Create: `lib/yubit-readonly-client.mjs`

- [ ] Test AES-256-GCM round trip, wrong-key rejection, invalid-key length rejection, key-version preservation, and `maskApiKey` output.
- [ ] Test signed YUBIT query payload ordering and headers against the official rule:
  - payload is sorted URL query parameters.
  - HMAC input is `timestamp + apiKey + recvWindow + payload`.
  - headers are `MF-ACCESS-API-KEY`, `MF-ACCESS-TIMESTAMP`, `MF-ACCESS-RECV-WINDOW`, and `MF-ACCESS-SIGN`.
- [ ] Test that the adapter exposes only:
  - `getOrderHistory({ symbol, orderId, limit })` -> `/oapi/contract/trade/private/v1/orders`.
  - `getExecutions({ symbol, orderId, limit })` -> `/oapi/contract/trade/private/v1/executions`.
  - `getClosedPnl({ symbol, startTime, endTime, limit })` -> `/oapi/contract/trade/private/v1/closed-pnl`.
- [ ] Test timeout, HTTP failure, YUBIT non-zero code, malformed JSON, and secret-safe error messages.
- [ ] Run the two tests and confirm failure.
- [ ] Implement credential encryption with `TRADER_CREDENTIALS_ENCRYPTION_KEY` accepting a 32-byte base64 or 64-character hex key.
- [ ] Implement `YubitReadonlyClient` with dependency-injected `fetch`, clock, 15-second timeout, `https://openapi.yubit.com` default, and no POST/trade methods.
- [ ] Run both tests and confirm pass.
- [ ] Commit: `feat: add encrypted yubit read-only access`.

## Task 3: Build durable trading persistence and idempotency

**Files:**

- Create: `tests/trading-repository.test.mjs`
- Create: `lib/trading-repository.mjs`

- [ ] Test repository contracts using the JSON repository:
  - Trader numeric Telegram ID uniqueness and enable/disable.
  - encrypted account persistence with safe reads that omit ciphertext unless explicitly requested by server code.
  - many-to-many Trader/account links.
  - destination scope resolution: enabled Trader destinations replace workspace defaults; otherwise defaults apply.
  - duplicate Telegram update claims return false.
  - duplicate `accountId + symbol + orderId` returns the existing signal.
  - events append but never update.
  - delivery idempotency is `signalId + publicationType + destinationId`.
  - one PNL publication per signal.
  - reconciliation lease prevents simultaneous claims and expires safely.
- [ ] Run the repository test and confirm failure.
- [ ] Implement `JsonTradingRepository` with serialized writes through the existing `readJson`/`writeJson` storage and schema version 1.
- [ ] Implement `PostgresTradingRepository.initialize()` with the nine tables from the confirmed design plus `next_check_at`, `lease_until`, `check_attempts`, `last_checked_at`, and a `trade_system_meta` table.
- [ ] Use database unique constraints for every idempotency invariant, not only application checks.
- [ ] Implement `getTradingRepository()` to require `DATABASE_URL`/`POSTGRES_URL` on Vercel or in production and allow JSON only in local/explicit preview fallback.
- [ ] Run `node --test tests/trading-repository.test.mjs` and confirm pass.
- [ ] Commit: `feat: persist multi-trader order tracking`.

## Task 4: Implement Trader, account, destination, and health services

**Files:**

- Create: `tests/trading-service.test.mjs`
- Create: `lib/trading-service.mjs`

- [ ] Test create/update Trader validation with numeric Telegram IDs and safe audit events.
- [ ] Test account creation encrypts credentials, returns only a mask, links selected Traders, and never returns `apiSecret`, ciphertext, IV, or auth tag.
- [ ] Test account verification with a signed read-only order-history request using a caller-provided validation symbol.
- [ ] Test destination CRUD, duplicate prevention, target permission validation, and test messages with SpeakerBot.
- [ ] Test health output for database, SpeakerBot token/Webhook, scheduler metadata, accounts, and destinations with no secrets.
- [ ] Implement the management and health functions with dependency injection for repository, YUBIT client, Telegram transport, clock, and environment.
- [ ] Add a recursive `sanitizeTradingResponse` guard and test that representative errors cannot leak API keys, secrets, webhook tokens, or encryption material.
- [ ] Run `node --test tests/trading-service.test.mjs` and confirm pass for management tests.
- [ ] Commit: `feat: manage traders accounts and targets`.

## Task 5: Implement SpeakerBot order intake and verified multi-target delivery

**Files:**

- Modify: `tests/trading-service.test.mjs`
- Modify: `lib/trading-service.mjs`
- Create: `app/api/telegram/speaker-webhook/route.js`
- Modify: `middleware.js`

- [ ] Test `verifySpeakerWebhookSecret(actual, expected)` rejects blank/mismatched values with constant-time comparison.
- [ ] Test webhook handling for wrong secret at the route boundary, duplicate update, non-private chat, missing user ID, unauthorized Trader, disabled Trader, `/start`, invalid format, and valid submit.
- [ ] Test valid submit searches only linked enabled accounts and requires exactly one verified match.
- [ ] Test shared-account duplicate order returns the existing owner safely and does not republish.
- [ ] Test successful verification creates the signal and verification event before delivery, resolves Trader override/default targets, and creates one delivery per unique target.
- [ ] Test one target failure does not roll back other delivered targets and Telegram 429 retry-after is honored within the bounded retry policy.
- [ ] Test replies to the Trader are safe and actionable while group signal copy is English and marked `Verified by YUBIT`.
- [ ] Implement `processSpeakerTelegramUpdate(update, dependencies)` and `configureSpeakerWebhook()`.
- [ ] Implement the route with `after()` for non-critical bookkeeping, `X-Telegram-Bot-Api-Secret-Token` verification, and a fast 200 response for already-claimed updates.
- [ ] Add `/api/telegram/speaker-webhook` to middleware public paths; do not make management APIs public.
- [ ] Run `node --test tests/trading-service.test.mjs tests/trading-routes.test.mjs` and confirm pass.
- [ ] Commit: `feat: verify and distribute trader orders`.

## Task 6: Reconcile closed orders and publish profitable PNL exactly once

**Files:**

- Modify: `tests/trading-service.test.mjs`
- Modify: `lib/trading-service.mjs`
- Create: `tests/pnl-card.test.mjs`
- Create: `lib/pnl-card.mjs`
- Create: `app/api/media/pnl-card/route.js`
- Create: `app/api/cron/trading-reconcile/route.js`

- [ ] Test the scheduler claims only due tracking signals and releases/advances leases after each outcome.
- [ ] Test zero closed-PNL candidates remains tracking with backoff; a unique audited candidate closes the signal; ambiguous candidates become `needs_review` and never publish.
- [ ] Test realized PNL `<= 0` creates a skipped PNL record and no Telegram card.
- [ ] Test realized PNL `> 0` creates one publication and one delivery per target; duplicate Cron and manual refresh do not create another publication or message.
- [ ] Test signed card payload HMAC verification, expiry, tamper rejection, field length limits, and the absence of API credentials.
- [ ] Implement `reconcileSignal`, `runTradingReconciliation`, and `refreshSignal`.
- [ ] Implement the card display model and `ImageResponse` at 1080x1440 using the supplied YUBIT PNL visual direction, with real verified fields only and no fabricated ROI.
- [ ] Implement the Cron route with the same Bearer `CRON_SECRET` pattern as existing automations and return a safe summary.
- [ ] Run the service/card/route tests and confirm pass.
- [ ] Commit: `feat: reconcile orders and publish profitable pnl`.

## Task 7: Expose safe authenticated management APIs

**Files:**

- Create: `tests/trading-routes.test.mjs`
- Create: `app/api/trading/route.js`
- Create: `app/api/trading/signals/[id]/route.js`
- Create: `app/api/trading/signals/[id]/refresh/route.js`
- Create: `app/api/trading/deliveries/[id]/retry/route.js`

- [ ] Test the dashboard route is dynamic, returns metrics/logs/Traders/accounts/destinations/health, and contains no credential material.
- [ ] Test POST actions `save-trader`, `save-account`, `verify-account`, `save-destination`, `verify-destination`, `test-destination`, and `configure-webhook` validate input and return Chinese operator messages.
- [ ] Test signal detail returns facts, annotations, immutable events, PNL state, and delivery rows.
- [ ] Test manual refresh and failed-delivery retry preserve idempotency.
- [ ] Implement thin route handlers that call the tested service functions and map safe domain errors to 400/404/409/503.
- [ ] Confirm all management paths remain protected by the existing session middleware.
- [ ] Run `node --test tests/trading-routes.test.mjs` and confirm pass.
- [ ] Commit: `feat: expose safe trading management api`.

## Task 8: Build the non-technical trading-center UI

**Files:**

- Create: `tests/trading-ui.test.mjs`
- Create: `app/trading/page.jsx`
- Modify: `app/components/ConsoleShell.jsx`

- [ ] Test source-level accessibility and safety requirements: navigation label, four tabs, explicit labels, loading/empty/error states, secret password inputs, masked key copy, and no field rendering of ciphertext.
- [ ] Add the `交易中心` navigation item after `内容分发中心`.
- [ ] Implement a 1366×768-friendly layout:
  - overview metrics and filters in 交易日志;
  - expandable signal detail with facts/timeline/deliveries;
  - Trader form and status list;
  - read-only account form with clear “关闭交易/转账/提现权限” warning;
  - workspace/Trader destination setup from saved group Topics;
  - system health cards and Webhook setup action.
- [ ] Require explicit confirmation before disabling a Trader/account/destination and before sending a test message.
- [ ] Ensure long IDs wrap/copy safely and every mutation refreshes durable server state.
- [ ] Run `node --test tests/trading-ui.test.mjs` and confirm pass.
- [ ] Commit: `feat: add multi-trader operations console`.

## Task 9: Wire scheduler, environment, checks, and operator documentation

**Files:**

- Modify: `.github/workflows/telegram-automations.yml`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `package.json`

- [ ] Extend the existing five-minute GitHub Actions job to call `/api/cron/trading-reconcile` with `YUBIT_CRON_SECRET`; keep one concurrency group and independent failure visibility.
- [ ] Document variables:
  - `TRADER_CREDENTIALS_ENCRYPTION_KEY`
  - `SPEAKER_TELEGRAM_WEBHOOK_SECRET`
  - `PNL_CARD_SIGNING_SECRET`
  - `YUBIT_API_BASE_URL` (optional official default)
  - existing `SPEAKER_BOT_TOKEN`, `DATABASE_URL`, `CRON_SECRET`, `APP_BASE_URL`.
- [ ] Document token rotation as a production gate because old Telegram tokens were exposed outside the server environment.
- [ ] Document Bot command examples, Trader onboarding, target setup, failure handling, and the strict no-auto-trading boundary.
- [ ] Add all new server modules to `npm run check`.
- [ ] Add source tests asserting the scheduler route and secrets are present but no secret values are committed.
- [ ] Commit: `chore: wire trading production operations`.

## Task 10: Full verification, preview deployment, and production gate

**Files:**

- Modify only files required by failures found in verification.
- Create: `docs/testing/2026-07-16-trading-center-release.md`

- [ ] Run `npm test`; expected: all prior distribution/group tests plus new trading tests pass.
- [ ] Run `npm run check`; expected: exit 0.
- [ ] Run `npm run build`; expected: Next.js production build succeeds with all trading routes.
- [ ] Scan tracked files with `rg -n "(AA[A-Za-z0-9_-]{20,}|api[_-]?secret\s*=|api[_-]?key\s*=)"` and confirm no live secret values.
- [ ] Deploy a Vercel preview from the committed branch using the existing linked project; do not copy production secrets into logs.
- [ ] Verify preview login and the `/trading` workflow at 1366×768, including refresh persistence and masked network responses.
- [ ] Configure a preview SpeakerBot webhook only if a rotated test token and the required secrets are present; otherwise record the missing external credential as a release gate, not as a code pass.
- [ ] Run the real acceptance cases in designated test Topics: authorized filled order, unauthorized user, invalid order, partial target failure, profitable close exactly once, non-profit close no card, duplicate update/Cron.
- [ ] Record evidence, timestamps, safe message IDs, and outcomes in the release report without API keys or Bot tokens.
- [ ] Back up production data, rotate exposed tokens, configure production secrets, deploy production, set the SpeakerBot webhook, and observe one reconciliation cycle.
- [ ] Re-run the health page and production smoke tests; only then mark the goal complete.
- [ ] Commit: `test: certify trading center production release`.

## Plan self-review

- [ ] Every confirmed-spec requirement maps to a task and test.
- [ ] No automatic trading, transfer, withdrawal, Telegram user-account login, or manual PNL fabrication is introduced.
- [ ] All public routes verify an independent secret; all management routes remain session-protected.
- [ ] All credentials are encrypted at rest and excluded from response models.
- [ ] YUBIT closed-PNL matching reflects the official API signature and fails closed on ambiguity.
- [ ] Telegram update, order, delivery, lease, and PNL idempotency are enforced in storage.
- [ ] No task contains placeholders such as TODO, “similar to”, or omitted implementation details.
- [ ] Full regression, build, secret scan, preview, production, and real-environment evidence are required before completion.
