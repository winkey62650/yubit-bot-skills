# Content Product Production Runbook

## Operating boundary

YUBIT Academy supports four governed content products: Daily Market Brief, Weekly Catalyst Calendar, Data Flash, and Market Follow-up. Telegram and Discord are the only delivery channels. The Obsidian vault is the sole editorial knowledge base; PostgreSQL is limited to scheduling, locks, delivery receipts, runtime snapshots, and retry state.

Production uses `/var/lib/yubit-academy/obsidian-vault`. Releases must never place the vault below `/opt/yubit-academy/releases` or delete it during cleanup. The deploy job snapshots it into `/var/backups/yubit-academy/obsidian-vault` before switching releases and retains fourteen days of archives.

## Content lifecycle and quality gate

Every product follows this monotonic lifecycle:

`draft -> evidence-verified -> quality-approved -> distribution-ready -> published|blocked`

Before `distribution-ready`, the canonical service must verify source identity, timestamps, fact/inference separation, risk and invalidation language, safe CTA language, and Telegram/Discord length limits. Actual data claims require official or primary evidence. A missing or conflicting actual blocks Data Flash and its dependent Market Follow-up. Market Follow-up must reference the originating Data Flash, define an observation window, and state correlation without claiming causality.

The automation adapter writes source notes, a normalized event, and the product note before it returns a delivery plan. A dry-run always uses a temporary isolated vault and cannot modify production knowledge.

## Normal production flow

1. The worker generates a candidate from Daily, Weekly, or Data Release automation.
2. The content-product system verifies evidence and writes the canonical Obsidian notes.
3. Only a `distribution-ready` product whose stored hash matches the generated document can enter distribution.
4. Distribution enforces the existing exact target policy and records durable Telegram/Discord receipts in PostgreSQL.
5. The feedback loop writes one immutable distribution snapshot and an updatable aggregate feedback note. If this write fails, the external delivery remains successful and the feedback write stays retryable.

No other knowledge system or delivery channel may be added without a product decision and a migration plan.

## Telegram visual contract

Telegram text products use `Community Editorial Card v3`: black-and-white text hierarchy, short paragraphs, deliberate whitespace, one pull quote, and `01 / 02 / 03` evidence blocks. Each message may use only its fixed product marker and one bias dot:

- Market Brief: `📊`; Weekly Catalysts: `🗓`; Data Flash: `🚨`; Market Follow-up: no product emoji.
- Bias: `🟢 Positive`, `🟡 Neutral`, or `🔴 Negative`.
- `WATCH NEXT`, `RISK / INVALIDATION`, and `SOURCES` are plain bold labels. Decorative emoji are forbidden.

Historical format validation must show `DEMO PREVIEW · FORMAT TEST` near the top and retain `HISTORICAL REPLAY` in the title. It must never resemble a current trading signal. Discord retains safe Markdown, while facts, figures, bias, timestamps, sources, and risk language remain identical across both channels.

## Safe deployment and acceptance

Formal installation defaults to `DEPLOY_NO_SEND=1`. In this mode the deployment may build, initialize and back up the vault, switch the Web release, and run read-only checks. It must not stop, restart, enable, or otherwise change the worker or Discord gateway; it must not call run-now or create a test receipt.

Required release evidence:

- the GitHub Actions checkout SHA, uploaded archive SHA marker, `/etc/yubit-academy/release.env`, and authenticated `/api/release-info` all identify the same 40-character commit;
- `npm run check`, full `npm test`, and `npm run build` pass in the release;
- the vault health check confirms all governed indexes and write access for `ubuntu`;
- the content audit reports `mode=no-send-read-only`, PostgreSQL rule/delivery counts, and `remoteMutationsPerformed=false`;
- Web, PostgreSQL, backup timer, HTTPS redirect, and login health pass;
- Telegram target policy remains exact and no unsupported channel appears in distribution configuration.

The no-send audit command is:

```bash
sudo --user=ubuntu env \
  DEPLOY_NO_SEND=1 \
  EXPECTED_COMMIT="$EXPECTED_COMMIT" \
  APP_RELEASE_SHA="$APP_RELEASE_SHA" \
  OBSIDIAN_VAULT_PATH=/var/lib/yubit-academy/obsidian-vault \
  DATABASE_URL="$DATABASE_URL" \
  DATABASE_DRIVER=pg \
  /opt/yubit-node/bin/node scripts/audit-content-production.mjs
```

Do not use `release:audit:production:validation`, `release:test:automations`, or any run-now endpoint for no-send acceptance.

## Runtime activation

Worker and Discord activation is a separate controlled action. First inspect due rules and queued claims without leasing or updating them. If any rule can publish immediately, leave both services on the previous runtime and request an explicit production-send decision. A production run-now requires `exactTargets=true` and exact approved endpoints. Never infer send authorization from deployment authorization.

When activation is approved and the preflight is clean, restart one service at a time, verify its release SHA and health, then watch the first scheduling cycle. Do not broaden Telegram or Discord target allowlists during activation.

## Triage and recovery

For blocked content, inspect the product note and gate reasons in Obsidian. Repair the source/evidence record and regenerate through the normal automation; do not edit a product directly to force `distribution-ready`. Source and distribution evidence notes are immutable.

For feedback sync failure, retry the saved `contentFeedback.pendingReceipts`. The snapshot identity is deterministic, so replay does not duplicate receipt counts. Never change a confirmed external success to failed because the Obsidian feedback write failed.

For vault failure, stop content activation, check ownership and mode (`ubuntu:ubuntu`, `0750` directories), reject symlinked paths, and restore the newest verified archive into a new empty confined directory. Preserve the damaged vault for investigation.

For rollback:

1. Stop worker and Discord before changing their runtime.
2. Verify the old release `.release-commit` and point `/opt/yubit-academy/current` to that exact directory.
3. Update `/etc/yubit-academy/release.env` to the old SHA, restart Web, and verify login, release fingerprint, PostgreSQL, and vault health.
4. Restart worker and Discord only after the same activation preflight and authorization.

Do not roll back or delete the Obsidian vault or PostgreSQL merely because application code is rolled back.

## Ownership and acceptance

- Jobs owns the four-product contract and content lifecycle. Done means every product passes the same evidence and quality contract.
- LeiJun owns vault durability, PostgreSQL runtime health, deployment, service health, and rollback. Done means exact-SHA no-send installation is reproducible.
- MaYun owns Telegram/Discord targets, templates, and feedback interpretation. Done means configured endpoints are intentional and results return to Obsidian.
- Trump owns release gates. Done means full tests/build, read-only audit, service checks, and no-send evidence pass before activation.
