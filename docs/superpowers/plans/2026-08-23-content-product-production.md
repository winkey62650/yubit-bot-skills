# Obsidian Content Product Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Every behavior change starts with a failing test and ends with focused plus full verification.

**Goal:** Establish a production-ready content operating system in the existing YUBIT Academy backend, with Obsidian as the only editorial knowledge base, four governed content products, Telegram/Discord-only distribution, and a durable feedback loop.

**Architecture:** Preserve PostgreSQL as an operational ledger for locks, jobs, receipts, and metrics. Add a persistent Obsidian vault as the canonical editorial knowledge layer for sources, normalized events, product documents, distribution snapshots, and feedback. Existing market automation writes through a single content-product service before any delivery plan is eligible; the service validates evidence, product structure, channel constraints, and lifecycle state. Telegram and Discord remain the only renderers. Production deployment provisions the vault outside immutable releases and verifies the entire system without sending a message.

**Tech Stack:** Node.js 20, Next.js 15 App Router, local PostgreSQL, Markdown/YAML-compatible Obsidian vault files, Node test runner, Telegram Bot API, Discord Gateway/API, systemd, nginx, GitHub Actions.

---

## Locked scope and safety boundaries

- Supported products: `daily-market-brief`, `weekly-catalyst-calendar`, `data-flash`, `market-follow-up`.
- Supported channels: Telegram and Discord only.
- Obsidian is the sole editorial knowledge base. PostgreSQL may retain runtime publishing snapshots and delivery receipts, but those records are explicitly non-editorial caches/ledgers.
- Production vault path: `/var/lib/yubit-academy/obsidian-vault`; it survives immutable release replacement and rollback.
- Automatic publication is fail-closed when official evidence, content quality, target approval, or delivery identity is incomplete.
- This deployment performs no live Telegram or Discord send. Acceptance uses deterministic fixtures, dry-run plans, protected read-only endpoints, service health, and filesystem evidence.
- Existing DEMO Academy allowlist remains the only approved Telegram test surface; no rule or target is expanded by this change.

## Target file map

### Create

- `lib/obsidian-content-store.mjs`: safe paths, atomic Markdown writes, frontmatter parsing, immutable evidence notes, and vault readiness.
- `lib/content-product-system.mjs`: product registry, canonical lifecycle, quality gate, channel payloads, and write-through orchestration.
- `lib/content-feedback-loop.mjs`: converts delivery receipts/metrics into Obsidian feedback notes without duplicating the operational ledger.
- `scripts/initialize-content-vault.mjs`: idempotently creates the approved Obsidian folder/index/template structure.
- `scripts/audit-content-production.mjs`: no-send production readiness audit.
- `tests/obsidian-content-store.test.mjs`.
- `tests/content-product-system.test.mjs`.
- `tests/content-feedback-loop.test.mjs`.
- `tests/content-production-deploy.test.mjs`.
- `docs/operations/content-product-runbook.md`.

### Modify

- `lib/automation-jobs.mjs`: write canonical product records before TG/DC plan creation; map the current daily, weekly, and data outputs into the four-product contract; block delivery on failed quality state.
- `lib/distribution-service.mjs`: record successful/failed Telegram and Discord outcomes into the feedback loop after the operational receipt is settled.
- `deploy/server/deploy.sh`: provision the persistent vault, set `OBSIDIAN_VAULT_PATH`, initialize it, and run no-send readiness checks before/after switching the release.
- `.github/workflows/deploy-production-server.yml`: pass the exact release ref/SHA and surface content-vault audit evidence.
- `package.json`: include the new modules and audit script in checks.
- focused existing tests for automation and distribution integration.

---

### Task 1: Implement the Obsidian knowledge boundary

**Files:** Create `tests/obsidian-content-store.test.mjs`; create `lib/obsidian-content-store.mjs`; create `scripts/initialize-content-vault.mjs`; modify `package.json`.

- [ ] Write failing tests for vault initialization, exact folder/index creation, canonical YAML-compatible frontmatter, atomic replace, immutable evidence note identity, read-after-restart, path traversal rejection, symlink escape rejection, malformed note rejection, and concurrent writes.
- [ ] Define the vault structure: `00 System`, `10 Sources`, `20 Events`, `30 Products/{Daily Market Brief,Weekly Catalyst Calendar,Data Flash,Market Follow-up}`, `40 Distribution`, `50 Feedback`, `90 Archive`, and `_assets`.
- [ ] Export `createObsidianContentStore({ vaultPath, now })` with `initialize`, `health`, `writeSource`, `writeEvent`, `writeProduct`, `readProduct`, `writeDistribution`, and `writeFeedback`.
- [ ] Store queryable fields in frontmatter and a canonical JSON payload in a fenced block; do not accept arbitrary output paths from callers.
- [ ] Run `node --test tests/obsidian-content-store.test.mjs`; confirm RED then GREEN.
- [ ] Commit only task files.

### Task 2: Add the four-product contract and quality gate

**Files:** Create `tests/content-product-system.test.mjs`; create `lib/content-product-system.mjs`.

- [ ] Write failing contract tests for all four product types, deterministic content/event identity, lifecycle transitions, source-evidence completeness, fact/inference separation, timestamps, risk/invalidation, CTA restrictions, and language.
- [ ] Implement lifecycle `draft -> evidence-verified -> quality-approved -> distribution-ready -> published|blocked` with monotonic transitions and an auditable gate result.
- [ ] Require official/primary evidence for actual data claims; permit secondary sources only as named context. A missing or conflicting actual blocks `data-flash` and dependent `market-follow-up`.
- [ ] Render one canonical document into Telegram (4096-char chunks, safe HTML) and Discord (2000-char chunks, safe Markdown) without altering facts.
- [ ] Ensure `market-follow-up` references the originating `data-flash`, names its observation window, and describes correlation without claiming causality.
- [ ] Persist source, event, and product notes to Obsidian before returning `distribution-ready`.
- [ ] Run the focused test file; confirm RED then GREEN.
- [ ] Commit only task files.

### Task 3: Integrate existing automation and feedback

**Files:** Modify `lib/automation-jobs.mjs`; modify focused automation tests; create `lib/content-feedback-loop.mjs`; create `tests/content-feedback-loop.test.mjs`; modify `lib/distribution-service.mjs` and focused tests.

- [ ] Add failing integration tests proving `crypto-daily -> daily-market-brief`, `weekly-calendar -> weekly-catalyst-calendar`, release actual -> `data-flash`, and bounded reaction -> `market-follow-up`.
- [ ] Add a regression test proving Data Release filtering never writes a narrowed event set back into the Weekly Calendar shared cache. Filtering is local to the Data consumer or uses a distinct cache key.
- [ ] In dry-run, use an isolated temporary vault and never mutate the production vault.
- [ ] Before building TG/DC delivery plans, require a `distribution-ready` Obsidian product note whose hash matches the generated document.
- [ ] Preserve current durable delivery idempotency and exact target controls.
- [ ] Apply one channel-neutral defer decision: when the canonical product is not distribution-ready, both Telegram and Discord are blocked.
- [ ] Add failing feedback tests for TG/DC success, failure, retry, duplicate receipt, and partial multi-step delivery; write one immutable distribution snapshot plus an updatable aggregate feedback note.
- [ ] Ensure feedback recording failure is visible and retryable but never rewrites a successful external receipt as failed.
- [ ] Run focused automation/distribution tests; confirm RED then GREEN.
- [ ] Commit only task files.

### Task 4: Provision, audit, and document production

**Files:** Create `tests/content-production-deploy.test.mjs`; create `scripts/audit-content-production.mjs`; modify `deploy/server/deploy.sh`; modify `.github/workflows/deploy-production-server.yml`; create `docs/operations/content-product-runbook.md`.

- [ ] Write failing static/deploy tests for `/var/lib/yubit-academy/obsidian-vault`, owner `ubuntu:ubuntu`, mode `0750`, `OBSIDIAN_VAULT_PATH` in release environment, initialization before service start, no-send audit, and exact SHA evidence.
- [ ] Make deployment idempotently provision the vault and never remove it during release cleanup or rollback.
- [ ] Add `DEPLOY_NO_SEND=1`: in this mode deployment may switch and validate Web, but must not restart worker or Discord, execute run-now, or create a delivery receipt. Preserve already-running old runtime processes until the explicit activation step.
- [ ] Audit vault write/read health, four product registrations, PostgreSQL runtime health, worker/web/Discord service state, TG/DC allowlist configuration, and `SEND=false`/dry-run behavior.
- [ ] Document recovery, vault backup, blocked-content triage, manual review, rollback, and the hard rule that production run-now requires exact approved targets.
- [ ] Run focused deploy/audit tests; confirm RED then GREEN.
- [ ] Commit only task files.

### Task 5: Review, release, and no-send production acceptance

- [ ] Run every focused test from Tasks 1-4, `npm run check`, the complete `npm test`, and `npm run build` from a clean worktree.
- [ ] Perform specification review and code-quality review; resolve every material finding and re-run verification.
- [ ] Confirm the remote production branch has not moved, then fast-forward the exact reviewed SHA to `code/academy`.
- [ ] Trigger the manual production workflow for that exact SHA and wait for completion.
- [ ] Authenticate to the existing backend and verify `/api/release-info` reports the same SHA.
- [ ] Run the production audit in no-send mode and collect: vault health, initialized indexes, service health, database health, four-product registry, and zero new TG/DC delivery receipts caused by acceptance.
- [ ] After no-send acceptance, activate the reviewed worker/Discord services only if their due-job preflight reports no immediate live delivery; otherwise leave the deployment installed but runtime activation blocked for an explicit send decision.
- [ ] If any check fails, restore the previous `/opt/yubit-academy/current` symlink, restart services, and verify the previous SHA; preserve the vault and operational database.
- [ ] Write the deployment outcome and reusable lessons into `memory/2026-08-23.md` and keep `MEMORY.md` limited to durable policy changes.

## Definition of done

- The formal server runs the reviewed exact commit and exposes a healthy authenticated backend.
- The Obsidian vault is persistent, writable only through the safe adapter, initialized with all approved indexes, and survives release switching.
- All four products share one evidence/lifecycle/quality contract and produce valid TG/DC-only plans.
- Existing automation writes canonical notes before delivery eligibility and delivery feedback returns to the vault.
- No live message is sent during deployment acceptance; target allowlists are unchanged.
- Full tests, build, production service checks, exact-SHA check, vault audit, and rollback instructions are recorded.
