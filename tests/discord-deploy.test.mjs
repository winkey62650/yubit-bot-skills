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

test("DC 部署包含可选的 Discord systemd 常驻服务", () => {
  const unit = read("deploy/systemd/yubit-academy-discord.service");
  const deploy = read("deploy/server/deploy.sh");

  assert.match(unit, /scripts\/discord-gateway\.mjs/);
  assert.match(unit, /EnvironmentFile=\/etc\/yubit-academy\/production\.env/);
  assert.match(deploy, /yubit-academy-discord\.service/);
  assert.match(deploy, /DISCORD_GATEWAY_ENABLED/);
  assert.match(deploy, /if \[\[ "\$discord_gateway_enabled" == "true" \]\]/);
  assert.match(deploy, /enable yubit-academy-discord/);
  assert.match(deploy, /restart yubit-academy-discord/);
  assert.match(deploy, /disable --now yubit-academy-discord/);
  assert.match(deploy, /is-active --quiet yubit-academy-discord/);
  assert.match(deploy, /date '\+%Y-%m-%d %H:%M:%S'/);
  assert.doesNotMatch(deploy, /date --iso-8601=seconds/);
});

test("生产部署只在明确启用 Discord 时要求其凭证", () => {
  const workflow = read(".github/workflows/deploy-production-server.yml");

  assert.match(workflow, /DISCORD_GATEWAY_ENABLED: \$\{\{ vars\.DISCORD_GATEWAY_ENABLED \|\| 'false' \}\}/);
  assert.match(workflow, /if \[ "\$DISCORD_GATEWAY_ENABLED" = "true" \]/);
  assert.match(workflow, /DISCORD_GATEWAY_ENABLED=%s/);
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
