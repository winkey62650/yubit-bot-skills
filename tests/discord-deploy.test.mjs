import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

function read(pathname) {
  return readFileSync(new URL(pathname, root), "utf8");
}

test("Discord Gateway 有独立常驻脚本和 npm 启动命令", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.scripts["discord:gateway"], "node scripts/discord-gateway.mjs");
  assert.match(packageJson.scripts.check, /discord-gateway/);
  assert.ok(existsSync(new URL("scripts/discord-gateway.mjs", root)));
});

test("DC no-send 部署保持 Discord systemd 生命周期原样不动", () => {
  const unit = read("deploy/systemd/yubit-academy-discord.service");
  const deploy = read("deploy/server/deploy.sh");

  assert.match(unit, /scripts\/discord-gateway\.mjs/);
  assert.match(unit, /EnvironmentFile=\/etc\/yubit-academy\/production\.env/);
  assert.match(deploy, /yubit-academy-discord\.service/);
  assert.match(deploy, /discord_state_before=/);
  assert.match(deploy, /discord_state_after=/);
  assert.match(deploy, /No-send deployment did not preserve the worker and Discord runtime state/);
  assert.doesNotMatch(deploy, /systemctl (?:enable|disable|stop|restart).*yubit-academy-discord/);
});

test("生产 no-send 部署不读取、不清除也不重写 Discord 凭证", () => {
  const workflow = read(".github/workflows/deploy-production-server.yml");
  const deploy = read("deploy/server/deploy.sh");

  assert.doesNotMatch(workflow, /secrets\.DISCORD_/);
  assert.doesNotMatch(workflow, /DISCORD_[A-Z_]+_B64/);
  assert.doesNotMatch(workflow, /printf 'DISCORD_[A-Z_]+=/);
  assert.doesNotMatch(deploy, /DISCORD_CREDENTIALS_ENCRYPTION_KEY|DISCORD_APP_ID\|DISCORD_PUBLIC_KEY\|DISCORD_BOT_TOKEN/);
  assert.match(deploy, /publisher_config_before=.*DISCORD_/);
  assert.match(deploy, /publisher_config_after=.*DISCORD_/);
});

test("生产部署由 GitHub Actions 上传固定提交，不依赖服务器访问 GitHub", () => {
  const workflow = read(".github/workflows/deploy-production-server.yml");
  const deploy = read("deploy/server/deploy.sh");

  assert.match(workflow, /DEPLOY_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /uses: actions\/checkout@v4/);
  assert.match(workflow, /tar --exclude="\.git" -czf "\$archive_path" \./);
  assert.match(workflow, /sshpass -e scp/);
  assert.match(workflow, /tar -xzf "\$REMOTE_ARCHIVE" -C "\$bootstrap_dir"/);
  assert.match(workflow, /SOURCE_DIR="\$bootstrap_dir"[\s\S]*EXPECTED_COMMIT="\$DEPLOY_SHA"[\s\S]*bash "\$bootstrap_dir\/deploy\/server\/deploy\.sh"/);
  assert.doesNotMatch(workflow, /git clone --quiet --depth 1 --branch code\/academy/);
  assert.doesNotMatch(workflow, /cd \/opt\/yubit-academy\/current/);
  assert.match(deploy, /SOURCE_DIR="\$\{SOURCE_DIR:-\}"/);
  assert.match(deploy, /EXPECTED_COMMIT/);
  assert.match(deploy, /\.release-commit/);
});

test("生产部署在切换版本前强制验证 CTA preview evidence secret", () => {
  const workflow = read(".github/workflows/deploy-production-server.yml");
  const deploy = read("deploy/server/deploy.sh");
  const envExample = read(".env.example");

  assert.doesNotMatch(workflow, /CTA_PREVIEW_EVIDENCE_SECRET|deployment_secrets_file|remote_secrets_file/);

  const validation = deploy.indexOf("assertStrongCtaPreviewEvidenceSecret");
  const installCurrent = deploy.indexOf('sudo ln -sfn "$release" "$APP_ROOT/current"');
  assert.ok(validation >= 0, "deployment must invoke the production strength validator");
  assert.ok(validation < installCurrent, "secret validation must happen before switching current release");
  assert.ok(validation < deploy.indexOf("sudo install -m 0600"), "secret validation must happen before production env updates");
  assert.match(deploy, /sudo install -m 0600[\s\S]*sudo mv -f [^\n]*"\$ENV_FILE"/);
  assert.match(deploy, /CTA_PREVIEW_EVIDENCE_SECRET/);
  assert.doesNotMatch(deploy, /echo[^\n]*\$cta_preview_evidence_secret/);
  assert.match(envExample, /exactly 64 lowercase hexadecimal characters/);
});

test("生产 no-send 部署不传输任何发布凭证且不写入 SSH argv", () => {
  const workflow = read(".github/workflows/deploy-production-server.yml");

  assert.doesNotMatch(workflow, /TELEGRAM_API_HASH_B64|telegram_api_hash_b64/);
  assert.doesNotMatch(workflow, /DESKTOP_SECRET_B64|desktop_secret_b64/);
  assert.doesNotMatch(workflow, /ssh[^\n]*(?:TELEGRAM_API_HASH|DESKTOP_PUBLISHER_SECRET)|(?:TELEGRAM_API_HASH|DESKTOP_PUBLISHER_SECRET)[^\n]*ssh/);
  assert.doesNotMatch(workflow, /TELEGRAM_API_HASH|DESKTOP_PUBLISHER_SECRET|CTA_PREVIEW_EVIDENCE_SECRET/);
  assert.match(workflow, /tar --exclude="\.git" -czf "\$archive_path" \./);
  assert.match(workflow, /publisher_config_before=.*TELEGRAM_.*DISCORD_/);
  assert.match(workflow, /publisher_config_after=.*TELEGRAM_.*DISCORD_/);
  assert.match(workflow, /No-send deployment changed Telegram or Discord configuration/);
});
