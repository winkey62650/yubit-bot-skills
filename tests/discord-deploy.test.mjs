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

test("DC 部署始终保持 Discord systemd 常驻服务在线等待", () => {
  const unit = read("deploy/systemd/yubit-academy-discord.service");
  const deploy = read("deploy/server/deploy.sh");

  assert.match(unit, /scripts\/discord-gateway\.mjs/);
  assert.match(unit, /EnvironmentFile=\/etc\/yubit-academy\/production\.env/);
  assert.match(deploy, /yubit-academy-discord\.service/);
  assert.match(deploy, /enable yubit-academy-discord/);
  assert.match(deploy, /restart yubit-academy-discord/);
  assert.match(deploy, /systemctl is-active --quiet "\$service"/);
  assert.match(deploy, /wait_for_service_active yubit-academy-discord\.service/);
  assert.match(deploy, /journalctl -u "\$service" -n 100 --no-pager/);
  assert.doesNotMatch(deploy, /discord_gateway_enabled/);
  assert.doesNotMatch(deploy, /disable --now yubit-academy-discord/);
  assert.doesNotMatch(deploy, /Discord Gateway did not reach the ready state/);
});

test("生产部署清除旧 Discord 凭证并由后台配置新凭证", () => {
  const workflow = read(".github/workflows/deploy-production-server.yml");
  const deploy = read("deploy/server/deploy.sh");

  assert.doesNotMatch(workflow, /secrets\.DISCORD_/);
  assert.doesNotMatch(workflow, /DISCORD_[A-Z_]+_B64/);
  assert.doesNotMatch(workflow, /printf 'DISCORD_[A-Z_]+=/);
  assert.match(deploy, /DISCORD_CREDENTIALS_ENCRYPTION_KEY/);
  assert.match(deploy, /openssl rand -hex 32/);
  assert.match(deploy, /DISCORD_APP_ID\|DISCORD_PUBLIC_KEY\|DISCORD_BOT_TOKEN\|DISCORD_GATEWAY_ENABLED/);
});

test("生产部署由 GitHub Actions 上传固定提交，不依赖服务器访问 GitHub", () => {
  const workflow = read(".github/workflows/deploy-production-server.yml");
  const deploy = read("deploy/server/deploy.sh");

  assert.match(workflow, /DEPLOY_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /uses: actions\/checkout@v4/);
  assert.match(workflow, /tar --exclude="\.git" -czf "\$archive_path" \./);
  assert.match(workflow, /sshpass -e scp/);
  assert.match(workflow, /tar -xzf "\$REMOTE_ARCHIVE" -C "\$bootstrap_dir"/);
  assert.match(workflow, /SOURCE_DIR="\$bootstrap_dir" EXPECTED_COMMIT="\$DEPLOY_SHA" bash "\$bootstrap_dir\/deploy\/server\/deploy\.sh"/);
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

  assert.match(workflow, /CTA_PREVIEW_EVIDENCE_SECRET: \$\{\{ secrets\.CTA_PREVIEW_EVIDENCE_SECRET \}\}/);
  assert.match(workflow, /CTA_PREVIEW_EVIDENCE_SECRET is not configured/);
  assert.doesNotMatch(workflow, /CTA_PREVIEW_EVIDENCE_SECRET_B64|cta_preview_evidence_secret_b64/);
  assert.doesNotMatch(workflow, /CTA_PREVIEW_EVIDENCE_SECRET[^\n]*ssh|ssh[^\n]*CTA_PREVIEW_EVIDENCE_SECRET/);
  assert.match(workflow, /chmod 600 "\$deployment_secrets_file"/);
  assert.match(workflow, /cat >"\$remote_secrets_file"/);
  assert.match(workflow, /printf 'CTA_PREVIEW_EVIDENCE_SECRET=%s\\n'/);
  const workflowValidation = workflow.indexOf("assertStrongCtaPreviewEvidenceSecret");
  const archiveBuild = workflow.indexOf('archive_path="$RUNNER_TEMP');
  assert.ok(workflowValidation >= 0, "workflow must reject a weak secret before touching production");
  assert.ok(workflowValidation < archiveBuild, "workflow validation must happen before upload");
  assert.ok(workflowValidation < workflow.indexOf("sshpass -e scp"));
  assert.ok(workflowValidation < workflow.indexOf("sshpass -e ssh"));
  assert.match(workflow, /assertStrongCtaPreviewEvidenceSecret[\s\S]*sudo install -m 0600/);

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

test("生产部署通过受保护文件传输所有敏感发布凭证且不写入 SSH argv", () => {
  const workflow = read(".github/workflows/deploy-production-server.yml");

  assert.doesNotMatch(workflow, /TELEGRAM_API_HASH_B64|telegram_api_hash_b64/);
  assert.doesNotMatch(workflow, /DESKTOP_SECRET_B64|desktop_secret_b64/);
  assert.doesNotMatch(workflow, /ssh[^\n]*(?:TELEGRAM_API_HASH|DESKTOP_PUBLISHER_SECRET)|(?:TELEGRAM_API_HASH|DESKTOP_PUBLISHER_SECRET)[^\n]*ssh/);
  assert.match(workflow, /chmod 600 "\$deployment_secrets_file"/);
  assert.match(workflow, /printf '%s\\n' "\$TELEGRAM_API_HASH"/);
  assert.match(workflow, /printf '%s\\n' "\$DESKTOP_PUBLISHER_SECRET"/);
  assert.match(workflow, /printf '%s\\n' "\$CTA_PREVIEW_EVIDENCE_SECRET"/);
  assert.match(workflow, /cat >"\$remote_secrets_file"/);
  assert.match(workflow, /stat -c '%a' "\$DEPLOY_SECRETS_FILE"[\s\S]*!= "600"/);
  assert.match(workflow, /read -r telegram_api_hash[\s\S]*read -r desktop_publisher_secret[\s\S]*read -r cta_preview_evidence_secret/);

  const remoteValidation = workflow.indexOf("Telegram API hash staging is invalid.");
  const desktopValidation = workflow.indexOf("Desktop publisher secret staging is invalid.");
  const envInstall = workflow.indexOf("sudo install -m 0600");
  assert.ok(remoteValidation >= 0 && remoteValidation < envInstall, "Telegram API hash must be validated before production.env is written");
  assert.ok(desktopValidation >= 0 && desktopValidation < envInstall, "desktop secret must be validated before production.env is written");
  assert.match(workflow, /trap cleanup_remote EXIT[\s\S]*rm -f "\$DEPLOY_SECRETS_FILE"/);
  assert.match(workflow, /sudo install -m 0600[\s\S]*sudo mv -f [^\n]*"\$env_file"/);
});
