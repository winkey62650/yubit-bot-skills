import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} must be declared`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return Function(`${source.slice(start, index + 1)}; return ${name};`)();
  }
  throw new Error(`${name} has no closing brace`);
}

test("manual recovery automation runs trading reconciliation with the protected cron secret", async () => {
  const workflow = await readFile(new URL(".github/workflows/telegram-automations.yml", root), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+schedule:/m);
  assert.match(workflow, /APP_BASE_URL: https:\/\/152-32-161-174\.sslip\.io/);
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
  assert.match(packageJson.scripts.check, /node --check lib\/release-info\.mjs/);
  assert.match(packageJson.scripts.check, /node --check scripts\/audit-production-release\.cjs/);
  assert.match(audit, /\/api\/release-info/);
  assert.match(audit, /evaluateReleaseFingerprint\(releaseInfo,\s*\{/);
  assert.match(audit, /expectedCommitSha:\s*process\.env\.EXPECTED_COMMIT_SHA/);
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

test("market content migration is dry-run by default and can never execute delivery", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const migration = await readFile(new URL("scripts/migrate-market-content-rules.cjs", root), "utf8");

  assert.equal(packageJson.scripts["release:migrate:market-content"], "node scripts/migrate-market-content-rules.cjs");
  assert.match(packageJson.scripts.check, /node --check scripts\/migrate-market-content-rules\.cjs/);
  for (const file of [
    "lib/market-content-templates.mjs",
    "lib/market-content-sources.mjs",
    "lib/data-release-monitor.mjs",
  ]) {
    assert.match(packageJson.scripts.check, new RegExp(`node --check ${file.replaceAll("/", "\\/")}`));
  }
  assert.match(migration, /MIGRATION_APPLY/);
  assert.match(migration, /authorizeProductionConfiguration/);
  assert.match(migration, /apply:\s*migrationApply/);
  assert.match(migration, /migrateMarketContentRules/);
  assert.match(migration, /data-release-updates/);
  assert.match(migration, /before:/);
  assert.match(migration, /after:/);
  assert.match(migration, /failedSaves/);
  assert.match(migration, /unsaved/);
  assert.doesNotMatch(migration, /run-now|\/api\/telegram|\/api\/discord/);
});

test("market preview release gates require at least one reliable source", async () => {
  for (const file of [
    "scripts/audit-production-release.cjs",
    "scripts/audit-distribution-templates.cjs",
    "scripts/send-demo-template-previews.cjs",
  ]) {
    const source = await readFile(new URL(file, root), "utf8");
    const hasReliableSource = extractFunction(source, "hasReliableSource");
    assert.equal(hasReliableSource([{ status: "error" }, { status: "timeout" }, { status: "schema-error" }]), false, file);
    assert.equal(hasReliableSource([{ status: "unknown" }]), false, file);
    assert.equal(hasReliableSource([{ status: "ok" }]), true, file);
    assert.equal(hasReliableSource([{ status: "timeout" }, { status: "ok" }]), true, file);
  }
});

test("run-now exists only in the explicitly authorized live automation test", async () => {
  const scriptsDirectory = new URL("scripts/", root);
  const entries = await readdir(scriptsDirectory, { withFileTypes: true });
  const offenders = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:cjs|mjs|js)$/.test(entry.name)) continue;
    const source = await readFile(new URL(entry.name, scriptsDirectory), "utf8");
    if (/run-now/.test(source)) offenders.push({ file: entry.name, source });
  }
  assert.deepEqual(offenders.map((item) => item.file), ["test-production-automation-delivery.cjs"]);
  assert.match(offenders[0].source, /authorizeLiveTelegramOperation/);
});

test("production distribution gates cover all six automations and seven broadcasts", async () => {
  const audit = await readFile(new URL("scripts/audit-production-release.cjs", root), "utf8");
  const provision = await readFile(new URL("scripts/provision-production-distribution.cjs", root), "utf8");
  const reconciliation = await readFile(new URL("scripts/reconcile-production-release.cjs", root), "utf8");
  const liveDelivery = await readFile(new URL("scripts/test-production-automation-delivery.cjs", root), "utf8");

  for (const contentType of [
    "crypto-daily",
    "weekly-calendar",
    "data-release-updates",
    "daily-analysis",
    "whale-signals",
    "agent-sync",
  ]) {
    assert.match(audit, new RegExp(contentType));
    assert.match(reconciliation, new RegExp(contentType));
  }
  for (const preset of ["daily-0800-utc", "weekly-monday-0030-utc", "event-driven", "hourly"]) {
    assert.match(audit, new RegExp(preset));
  }
  assert.match(audit, /expectedBroadcastCount:\s*7/);
  assert.match(audit, /sourceHealth/);
  assert.match(audit, /publishable/);
  assert.match(audit, /skipReason/);
  assert.match(audit, /duplicateDestinations/);
  assert.match(audit, /sourceValid/);
  assert.match(provision, /expectedAutomationCount:\s*6/);
  assert.match(provision, /expectedBroadcastCount:\s*7/);
  assert.match(reconciliation, /contentType:\s*"data-release-updates"[\s\S]*enabled:\s*false/);
  assert.match(liveDelivery, /authorizeLiveTelegramOperation/);
});

test("template audits and previews use dry-run automation preview without a delivery endpoint", async () => {
  for (const file of [
    "scripts/audit-production-release.cjs",
    "scripts/audit-distribution-templates.cjs",
    "scripts/send-demo-template-previews.cjs",
  ]) {
    const source = await readFile(new URL(file, root), "utf8");
    assert.match(source, /\/api\/automation-test/);
    assert.doesNotMatch(source, /run-now/);
  }
});

test("DEMO CTA acceptance requires enabled non-empty CTA hydrated into the final dry-run rendering", async () => {
  const acceptance = await readFile(new URL("scripts/accept-demo-target-cta.cjs", root), "utf8");
  const previewRoute = await readFile(new URL("app/api/automation-test/route.js", root), "utf8");
  const evaluateDemoCtaAcceptance = extractFunction(acceptance, "evaluateDemoCtaAcceptance");
  const telegramTarget = { platform: "telegram", chatId: "-1001", threadId: 8 };
  const discordTarget = { platform: "discord", guildId: "guild-1", channelId: "channel-1" };
  const telegramPreview = {
    deliveryPlans: [{
      target: { ...telegramTarget, ctaEnabled: true, ctaContent: "**LATEST TG CTA**\n[Join TG](https://example.com/tg)" },
      steps: [{ payload: { text: "Market update\n\n────────\n<b>LATEST TG CTA</b>\n<a href=\"https://example.com/tg\">Join TG</a>" } }]
    }]
  };
  const discordPreview = {
    deliveryPlans: [{
      target: { ...discordTarget, ctaEnabled: true, ctaContent: "**LATEST DC CTA**\n[Join DC](https://example.com/dc)" },
      steps: [{ payload: { content: "Market update\n\n────────\n**LATEST DC CTA**\n[Join DC](https://example.com/dc)" } }]
    }]
  };
  const telegramQueryCta = "**TRADE WITH YUBIT**\n[Register](https://example.com/register?ref=demo&source=tg)\n[View fees](https://example.com/fees?tier=vip&lang=en)";
  const telegramQueryPreview = {
    deliveryPlans: [{
      target: { ...telegramTarget, ctaEnabled: true, ctaContent: telegramQueryCta },
      steps: [{ payload: { text: "Market update\n\n────────\n<b>TRADE WITH YUBIT</b>\n<a href=\"https://example.com/register?ref=demo&amp;source=tg\">Register</a>\n<a href=\"https://example.com/fees?tier=vip&amp;lang=en\">View fees</a>" } }]
    }]
  };
  const bodyCollisionWithoutLink = {
    deliveryPlans: [{
      target: { ...telegramTarget, ctaEnabled: true, ctaContent: "**BTC**\n[Trade now](https://example.com/trade)" },
      steps: [{ payload: { text: "BTC market body only; the CTA link is absent." } }]
    }]
  };
  const plainTextBodyCollision = {
    deliveryPlans: [{
      target: { ...telegramTarget, ctaEnabled: true, ctaContent: "**BTC**" },
      steps: [{ payload: { text: "BTC surged today" } }]
    }]
  };
  const scatteredCtaTokens = {
    deliveryPlans: [{
      target: { ...telegramTarget, ctaEnabled: true, ctaContent: "**LATEST TG CTA**\n[Join TG](https://example.com/tg)" },
      steps: [{ payload: { text: "LATEST TG CTA\nUnrelated market analysis\nJoin TG https://example.com/tg" } }]
    }]
  };
  const ctaBeforeFinalStep = {
    deliveryPlans: [{
      target: { ...telegramTarget, ctaEnabled: true, ctaContent: "**LATEST TG CTA**\n[Join TG](https://example.com/tg)" },
      steps: [
        { payload: { text: "<b>LATEST TG CTA</b>\n<a href=\"https://example.com/tg\">Join TG</a>" } },
        { payload: { text: "Final market note without CTA" } }
      ]
    }]
  };

  assert.equal(evaluateDemoCtaAcceptance({ ctaEnabled: false, ctaContent: "LATEST TG CTA" }, telegramPreview, telegramTarget).passed, false);
  assert.equal(evaluateDemoCtaAcceptance({ ctaEnabled: true, ctaContent: "   \n " }, telegramPreview, telegramTarget).passed, false);
  assert.equal(evaluateDemoCtaAcceptance({ ctaEnabled: true, ctaContent: "**LATEST TG CTA**\n[Join TG](https://example.com/tg)" }, telegramPreview, telegramTarget).passed, true);
  assert.equal(evaluateDemoCtaAcceptance({ ctaEnabled: true, ctaContent: telegramQueryCta }, telegramQueryPreview, telegramTarget).passed, true);
  assert.equal(evaluateDemoCtaAcceptance({ ctaEnabled: true, ctaContent: "**LATEST DC CTA**\n[Join DC](https://example.com/dc)" }, discordPreview, discordTarget).passed, true);
  assert.equal(evaluateDemoCtaAcceptance({ ctaEnabled: true, ctaContent: "**BTC**\n[Trade now](https://example.com/trade)" }, bodyCollisionWithoutLink, telegramTarget).passed, false);
  assert.equal(evaluateDemoCtaAcceptance({ ctaEnabled: true, ctaContent: "**BTC**" }, plainTextBodyCollision, telegramTarget).passed, false);
  assert.equal(evaluateDemoCtaAcceptance({ ctaEnabled: true, ctaContent: "**LATEST TG CTA**\n[Join TG](https://example.com/tg)" }, scatteredCtaTokens, telegramTarget).passed, false);
  assert.equal(evaluateDemoCtaAcceptance({ ctaEnabled: true, ctaContent: "**LATEST TG CTA**\n[Join TG](https://example.com/tg)" }, ctaBeforeFinalStep, telegramTarget).passed, false);

  assert.match(acceptance, /data:\s*\{\s*jobId:\s*"crypto-daily",\s*targets:/);
  assert.match(previewRoute, /hydrateDestinationCtas/);
  assert.match(previewRoute, /targets:\s*hydratedTargets/);
  assert.match(previewRoute, /readOnlyPreview:\s*true/);
  assert.match(previewRoute, /buildAutomationTelegramPlans/);
  assert.match(previewRoute, /buildAutomationDiscordPlans/);
  assert.doesNotMatch(acceptance, /run-now|setMeta|saveRule|createDelivery/);
});
