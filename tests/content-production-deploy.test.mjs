import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (pathname) => readFileSync(new URL(pathname, root), "utf8");

test("production deploy provisions a persistent, confined Obsidian vault before release activation", () => {
  const deploy = read("deploy/server/deploy.sh");
  const envExample = read(".env.example");

  assert.match(deploy, /OBSIDIAN_VAULT_PATH="\$\{OBSIDIAN_VAULT_PATH:-\/var\/lib\/yubit-academy\/obsidian-vault\}"/);
  assert.match(deploy, /OBSIDIAN_VAULT_PATH" != \/*/);
  assert.match(deploy, /realpath -m -- "\$OBSIDIAN_VAULT_PATH"/);
  assert.match(deploy, /Vault path must remain under \/var\/lib\/yubit-academy/);
  assert.match(deploy, /Refusing symlinked Obsidian vault path/);
  assert.match(deploy, /install -d -m 0750 -o ubuntu -g ubuntu "\$OBSIDIAN_VAULT_PATH"/);
  assert.match(deploy, /sudo --user=ubuntu env[\s\S]*OBSIDIAN_VAULT_PATH="\$OBSIDIAN_VAULT_PATH"[\s\S]*initialize-content-vault\.mjs/);
  assert.match(deploy, /printf 'OBSIDIAN_VAULT_PATH=%s\\n' "\$OBSIDIAN_VAULT_PATH"/);

  const initializeVault = deploy.indexOf("initialize-content-vault.mjs");
  const switchRelease = deploy.indexOf('sudo ln -sfn "$release" "$APP_ROOT/current"');
  assert.ok(initializeVault >= 0 && initializeVault < switchRelease, "vault initialization must precede release switching");
  assert.match(envExample, /OBSIDIAN_VAULT_PATH=\/var\/lib\/yubit-academy\/obsidian-vault/);
});

test("DEPLOY_NO_SEND is mandatory and leaves worker and Discord lifecycle untouched", () => {
  const deploy = read("deploy/server/deploy.sh");

  assert.match(deploy, /DEPLOY_NO_SEND="\$\{DEPLOY_NO_SEND:-1\}"/);
  assert.match(deploy, /only permits DEPLOY_NO_SEND=1/);
  assert.doesNotMatch(deploy, /systemctl (stop|start|restart|enable|disable).*yubit-academy-(worker|discord)\.service/);
  assert.doesNotMatch(deploy, /install .*yubit-academy-(worker|discord)\.service/);
  assert.match(deploy, /delivery_count_before/);
  assert.match(deploy, /delivery_count_after/);
  assert.match(deploy, /capture_service_lifecycle_state/);
  assert.doesNotMatch(deploy, /property=ActiveState,SubState,MainPID/);
  assert.match(deploy, /Runtime services touched by deployment: false/);
});

test("production workflow defaults formal-server acceptance to no-send", () => {
  const workflow = read(".github/workflows/deploy-production-server.yml");

  assert.match(workflow, /DEPLOY_NO_SEND: "1"/);
  assert.match(workflow, /DEPLOY_NO_SEND='\$DEPLOY_NO_SEND'/);
  assert.match(workflow, /DEPLOY_NO_SEND="\$DEPLOY_NO_SEND"[\s\\]*SOURCE_DIR="\$bootstrap_dir"[\s\\]*EXPECTED_COMMIT="\$DEPLOY_SHA"/);
  assert.doesNotMatch(workflow, /TELEGRAM_BOT_TOKEN|DISCORD_BOT_TOKEN|DISCORD_APP_ID|DISCORD_PUBLIC_KEY/);
  assert.match(workflow, /publisher_config_before/);
  assert.match(workflow, /publisher_config_after/);
  assert.match(workflow, /TELEGRAM_\[\^=\]\*\|DISCORD_\[\^=\]\*/);
});

test("operator-triggered Academy DEMO acceptance is fenced to four poster products on Topics 8 and 10", () => {
  const workflow = read(".github/workflows/telegram-automations.yml");

  assert.match(workflow, /academy-demo/);
  assert.match(workflow, /accept-academy-demo-content\.cjs/);
  assert.match(workflow, /products \| length == 4/);
  assert.match(workflow, /executions \| length == 3/);
  assert.match(workflow, /mediaIncluded == true/);
  assert.match(workflow, /chatId == ["']-1003710405969["']/);
  assert.match(workflow, /threadId == 8 or \.threadId == 10/);
  assert.match(workflow, /ALLOW_LIVE_TELEGRAM=true/);
  assert.match(workflow, /publisher_config_before/);
  assert.match(workflow, /publisher_config_after/);
  assert.match(workflow, /report_file=.*sudo --user=ubuntu mktemp/);
  assert.match(workflow, /ALLOW_LIVE_TELEGRAM.*false/s);
  assert.doesNotMatch(workflow, /set_env_value\s+ALLOW_LIVE_TELEGRAM\s+true/);
  assert.match(workflow, /"product":"weekly-catalyst-calendar","templateId":"weekly-catalysts-v5","version":5/);
  assert.doesNotMatch(workflow, /"product":"weekly-catalyst-calendar","templateId":"weekly-catalysts-v4"/);
});

test("read-only Academy audit reports the failing endpoint and sanitized HTTP response body", () => {
  const workflow = read(".github/workflows/telegram-automations.yml");

  assert.match(workflow, /import urllib\.error/);
  assert.match(workflow, /except urllib\.error\.HTTPError as error:/);
  assert.match(workflow, /error\.read\(\)\.decode\("utf-8", errors="replace"\)/);
  assert.match(workflow, /sanitize_http_error/);
  assert.match(workflow, /HTTP \{error\.code\}/);
});

test("governed Telegram target policy includes House and rolls back on deployment failure", () => {
  const workflow = read(".github/workflows/deploy-production-server.yml");

  assert.match(workflow, /env_backup="\$\(mktemp\)"/);
  assert.match(workflow, /sudo cp -p "\$env_file" "\$env_backup"/);
  assert.match(workflow, /set_env_value TELEGRAM_DEMO_ONLY true/);
  assert.match(workflow, /set_env_value TRADING_DEMO_ONLY true/);
  assert.match(workflow, /expected_targets='-1003710405969:8,-1003710405969:10,-1003710405969:16,-1001702053978:309971'/);
  assert.match(workflow, /set_env_value TELEGRAM_DISTRIBUTION_APPROVED_TARGETS "\$expected_targets"/);
  assert.match(workflow, /set_env_value ALLOW_LIVE_TELEGRAM false/);
  assert.match(workflow, /systemctl restart yubit-academy-web\.service/);
  assert.match(workflow, /\[ -n "\$env_backup" \] && \[ "\$deployment_committed" != "1" \]/);
  const deployScript = read("deploy/server/deploy.sh");
  assert.match(deployScript, /expected_distribution_targets='-1003710405969:8,-1003710405969:10,-1003710405969:16,-1001702053978:309971'/);
  const auditScript = read("scripts/audit-content-production.mjs");
  assert.match(auditScript, /"-1001702053978:309971"/);
  assert.match(workflow, /sudo cp -p "\$env_backup" "\$env_file"/);
  assert.doesNotMatch(workflow, /sudo systemctl restart yubit-academy\.service/);
  assert.match(workflow, /deployment_committed=1/);
});

test("activation has an error trap that restores both release pointer and release environment", () => {
  const deploy = read("deploy/server/deploy.sh");

  assert.match(deploy, /rollback_activation\(\)/);
  assert.match(deploy, /trap rollback_activation EXIT/);
  assert.match(deploy, /ln -sfn "\$previous_release" "\$APP_ROOT\/current"/);
  assert.match(deploy, /deployment_backup_dir\/release\.env/);
  assert.match(deploy, /publisher_config_after.*publisher_config_before/s);
});

test("deployment records exact release and no-send evidence without invoking publication audits", () => {
  const deploy = read("deploy/server/deploy.sh");
  const packageJson = JSON.parse(read("package.json"));

  assert.match(deploy, /APP_RELEASE_SHA=%s/);
  assert.match(deploy, /\.release-commit/);
  assert.match(deploy, /Deployment mode: no-send/);
  assert.match(deploy, /audit-content-production\.mjs/);
  assert.match(deploy, /EXPECTED_COMMIT="\$commit"/);
  assert.match(deploy, /APP_RELEASE_SHA="\$commit"/);
  assert.equal(packageJson.scripts["content:audit:production"], "node scripts/audit-content-production.mjs");
  for (const pathname of [
    "lib/content-product-system.mjs",
    "lib/content-automation-adapter.mjs",
    "lib/content-feedback-loop.mjs",
    "scripts/audit-content-production.mjs",
  ]) {
    assert.match(packageJson.scripts.check, new RegExp(pathname.replaceAll(".", "\\.")));
  }
  assert.doesNotMatch(deploy, /release:audit:production:validation|release:test:automations|run-now/);
});

test("production deploy creates a recoverable Obsidian snapshot without following symlinks", () => {
  const deploy = read("deploy/server/deploy.sh");

  assert.match(deploy, /OBSIDIAN_BACKUP_ROOT="\$\{OBSIDIAN_BACKUP_ROOT:-\/var\/backups\/yubit-academy\/obsidian-vault\}"/);
  assert.match(deploy, /install -d -m 0750 -o ubuntu -g ubuntu "\$OBSIDIAN_BACKUP_ROOT"/);
  assert.match(deploy, /tar --create --gzip --file "\$vault_backup" --directory "\$OBSIDIAN_VAULT_PATH" \./);
  assert.doesNotMatch(deploy, /tar[^\n]*--dereference/);
  assert.match(deploy, /find "\$OBSIDIAN_BACKUP_ROOT"[^\n]*-delete/);
});
