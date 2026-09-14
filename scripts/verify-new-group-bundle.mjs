import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Exercise the files that /api/scripts starts from the deployed server's cwd.
// Never inherit credentials: these checks must not call Telegram or write state.
const cwd = resolve(".next/standalone");
const checks = [
  ["scripts/new-group-setup.mjs", 0, /Missing TELEGRAM_CHAT_ID or TELEGRAM_BOT_TOKEN/],
  ["setup-telegram-community.mjs", 1, /Missing TELEGRAM_BOT_TOKEN/],
];

for (const [script, expectedStatus, expectedOutput] of checks) {
  const result = spawnSync(process.execPath, [script], {
    cwd,
    env: { DRY_RUN: "true" },
    encoding: "utf8",
    timeout: 10000,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, expectedStatus, `${script} failed to load from the deployment bundle:\n${output}`);
  assert.match(output, expectedOutput, `${script} did not reach its credential guard`);
  assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|SyntaxError/);
}

console.log("Deployment bundle: both Telegram initialization entrypoints load; no API calls or state changes.");
