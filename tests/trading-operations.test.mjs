import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("five-minute automation runs trading reconciliation with the protected cron secret", async () => {
  const workflow = await readFile(new URL(".github/workflows/telegram-automations.yml", root), "utf8");
  assert.match(workflow, /trading-reconcile/);
  assert.match(workflow, /YUBIT_CRON_SECRET:\s*\$\{\{ secrets\.YUBIT_CRON_SECRET \}\}/);
  assert.match(workflow, /inputs\.job == 'trading'/);
  assert.match(workflow, /curl --fail-with-body/);
});

test("example environment documents trading secrets without committing values", async () => {
  const example = await readFile(new URL(".env.example", root), "utf8");
  for (const name of [
    "TRADER_CREDENTIALS_ENCRYPTION_KEY",
    "SPEAKER_TELEGRAM_WEBHOOK_SECRET",
    "PNL_CARD_SIGNING_SECRET",
    "SPEAKER_BOT_TOKEN",
    "SPEAKER_PREVIEW_BOT_TOKEN",
    "SPEAKER_PREVIEW_TELEGRAM_WEBHOOK_SECRET",
    "SPEAKER_PREVIEW_WEBHOOK_ENABLED",
    "DATABASE_URL",
    "PREVIEW_DATABASE_URL",
    "CRON_SECRET",
    "PREVIEW_CRON_SECRET",
    "APP_BASE_URL",
  ]) {
    assert.match(example, new RegExp(`^${name}=`, "m"));
  }
  assert.match(example, /^YUBIT_API_BASE_URL=https:\/\/openapi\.yubit\.com$/m);
  assert.doesNotMatch(example, /\d{8,12}:AA[A-Za-z0-9_-]{20,}/);
});

test("operator guide states the read-only boundary and token-rotation gate", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");
  assert.match(readme, /交易中心/);
  assert.match(readme, /只读 API/);
  assert.match(readme, /不会自动开单|不自动开单/);
  assert.match(readme, /轮换.*Telegram Bot Token|Telegram Bot Token.*轮换/);
  assert.match(readme, /BTCUSDT 1234567890/);
});

test("syntax check covers every trading server module", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  for (const file of [
    "lib/trading-domain.mjs",
    "lib/deployment-config.mjs",
    "lib/trading-crypto.mjs",
    "lib/yubit-readonly-client.mjs",
    "lib/trading-repository.mjs",
    "lib/trading-service.mjs",
    "lib/pnl-card.mjs",
  ]) {
    assert.match(packageJson.scripts.check, new RegExp(`node --check ${file.replaceAll("/", "\\/")}`));
  }
});

test("production release audit is reproducible and includes trading readiness", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const audit = await readFile(new URL("scripts/audit-production-release.cjs", root), "utf8");
  const reconciliation = await readFile(new URL("scripts/reconcile-production-release.cjs", root), "utf8");
  const liveDelivery = await readFile(new URL("scripts/test-production-automation-delivery.cjs", root), "utf8");

  assert.equal(packageJson.scripts["release:audit"], "node scripts/audit-production-release.cjs");
  assert.match(packageJson.scripts["release:audit:preview"], /RELEASE_STAGE=preview.*RELEASE_AUDIT_MODE=validation/);
  assert.match(packageJson.scripts["release:audit:production"], /RELEASE_STAGE=production.*RELEASE_AUDIT_MODE=read-only/);
  assert.match(packageJson.scripts["release:audit:production:validation"], /RELEASE_STAGE=production.*RELEASE_AUDIT_MODE=validation/);
  assert.doesNotMatch(packageJson.scripts["release:audit:production:validation"], /ALLOW_PRODUCTION_AUDIT_WRITES=true/);
  assert.equal(packageJson.scripts["release:reconcile"], "node scripts/reconcile-production-release.cjs");
  assert.equal(packageJson.scripts["release:test:automations"], "node scripts/test-production-automation-delivery.cjs");
  assert.ok(packageJson.devDependencies?.playwright);
  assert.match(packageJson.scripts.check, /node --check lib\/release-gate\.cjs/);
  assert.match(packageJson.scripts.check, /node --check scripts\/audit-production-release\.cjs/);
  assert.match(audit, /\/api\/trading/);
  assert.match(audit, /evaluateTradingRelease\(trading\)/);
  assert.match(audit, /TEST_BROWSER_CHANNEL/);
  assert.match(audit, /channel: browserChannel/);
  assert.match(audit, /evaluatePreviewTradingIsolation\(trading\)/);
  assert.match(audit, /authorizeReleaseAuditMode/);
  assert.match(audit, /auditPolicy\.allowActiveValidation/);
  assert.match(audit, /remoteMutationsPerformed/);
  assert.match(reconciliation, /authorizeLiveTelegramOperation/);
  assert.match(liveDelivery, /authorizeLiveTelegramOperation/);
});

test("standard production distribution provisioning is preview-only until separately authorized to save", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(packageJson.scripts["release:provision"], "node scripts/provision-production-distribution.cjs");
  assert.match(packageJson.scripts.check, /node --check scripts\/provision-production-distribution\.cjs/);

  const script = await readFile(new URL("scripts/provision-production-distribution.cjs", root), "utf8");
  assert.match(script, /authorizeProductionConfiguration/);
  assert.match(script, /buildStandardProductionDistributionRules/);
  assert.match(script, /PROVISION_APPLY/);
  assert.match(script, /apply:\s*provisionApply/);
  assert.match(script, /TEST_USERNAME\s*\|\|\s*process\.env\.AUTH_USERNAME/);
  assert.match(script, /TEST_PASSWORD\s*\|\|\s*process\.env\.AUTH_PASSWORD/);
  assert.doesNotMatch(script, /authorizeLiveTelegramOperation/);
});
