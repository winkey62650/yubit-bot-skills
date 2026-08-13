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
  assert.match(deploy, /is-active --quiet yubit-academy-discord/);
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

test("生产部署从 GitHub 目标提交启动，不调用服务器旧版脚本", () => {
  const workflow = read(".github/workflows/deploy-production-server.yml");
  const deploy = read("deploy/server/deploy.sh");

  assert.match(workflow, /DEPLOY_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /git clone --quiet --depth 1 --branch code\/academy/);
  assert.match(workflow, /actual_sha="\$\(git -C "\$bootstrap_dir" rev-parse HEAD\)"/);
  assert.match(workflow, /EXPECTED_COMMIT="\$DEPLOY_SHA" bash "\$bootstrap_dir\/deploy\/server\/deploy\.sh"/);
  assert.doesNotMatch(workflow, /cd \/opt\/yubit-academy\/current/);
  assert.match(deploy, /EXPECTED_COMMIT/);
  assert.match(deploy, /Resolved commit .* does not match requested commit/);
});
