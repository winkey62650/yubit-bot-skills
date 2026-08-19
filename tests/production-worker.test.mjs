import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildWorkerConfig,
  callCronEndpoint,
  drainDistributionQueue,
  isMainModule,
} from "../scripts/production-worker.mjs";

test("buildWorkerConfig targets the private local web service", () => {
  const config = buildWorkerConfig({
    CRON_SECRET: "secret-value",
    PORT: "4174",
  });

  assert.equal(config.baseUrl, "http://127.0.0.1:4174");
  assert.equal(config.secret, "secret-value");
  assert.equal(config.distributionIntervalMs, 15_000);
  assert.equal(config.tradingIntervalMs, 300_000);
  assert.equal(config.agentIntervalMs, 3_600_000);
  assert.equal(config.larkIntervalMs, 60_000);
});

test("buildWorkerConfig rejects a missing cron secret", () => {
  assert.throws(() => buildWorkerConfig({}), /CRON_SECRET/);
});

test("worker entrypoint remains executable through the production current symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yubit-worker-"));
  const workerPath = fileURLToPath(new URL("../scripts/production-worker.mjs", import.meta.url));
  const symlinkPath = join(directory, "production-worker.mjs");
  try {
    await symlink(workerPath, symlinkPath);
    assert.equal(isMainModule(symlinkPath, new URL("../scripts/production-worker.mjs", import.meta.url).href), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker process stays alive between scheduled runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yubit-worker-process-"));
  const workerPath = fileURLToPath(new URL("../scripts/production-worker.mjs", import.meta.url));
  const symlinkPath = join(directory, "production-worker.mjs");
  await symlink(workerPath, symlinkPath);
  const child = spawn(process.execPath, [symlinkPath], {
    env: {
      ...process.env,
      CRON_SECRET: "test-cron-secret",
      WORKER_BASE_URL: "http://127.0.0.1:9",
      WORKER_DISTRIBUTION_INTERVAL_MS: "1000",
      WORKER_TRADING_INTERVAL_MS: "1000",
      WORKER_AGENT_INTERVAL_MS: "1000",
      WORKER_LARK_INTERVAL_MS: "1000",
      WORKER_REQUEST_TIMEOUT_MS: "1000",
    },
    stdio: "ignore",
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(child.exitCode, null);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("server deployment restarts both services after changing the current release", async () => {
  const deployScript = await readFile(
    fileURLToPath(new URL("../deploy/server/deploy.sh", import.meta.url)),
    "utf8",
  );

  assert.match(deployScript, /systemctl restart yubit-academy-web\.service/);
  assert.match(deployScript, /systemctl restart yubit-academy-worker\.service/);
  assert.doesNotMatch(deployScript, /enable --now yubit-academy-(?:web|worker)\.service/);
});

test("server deployment keeps the worker stopped until the web service is ready", async () => {
  const deployScript = await readFile(
    fileURLToPath(new URL("../deploy/server/deploy.sh", import.meta.url)),
    "utf8",
  );

  const stopWorker = deployScript.indexOf("systemctl stop yubit-academy-worker.service");
  const restartWeb = deployScript.indexOf("systemctl restart yubit-academy-web.service");
  const readinessProbe = deployScript.indexOf("http://127.0.0.1:4174/login");
  const restartWorker = deployScript.indexOf("systemctl restart yubit-academy-worker.service");

  assert.ok(stopWorker >= 0, "deployment must stop the worker before replacing the web process");
  assert.ok(stopWorker < restartWeb, "worker must stop before the web service restarts");
  assert.ok(restartWeb < readinessProbe, "web restart must happen before its readiness probe");
  assert.ok(readinessProbe < restartWorker, "worker must restart only after the web service is ready");
});

test("production web service runs the standalone bundle with its static assets", async () => {
  const unit = await readFile(
    fileURLToPath(new URL("../deploy/systemd/yubit-academy-web.service", import.meta.url)),
    "utf8",
  );
  const deployScript = await readFile(
    fileURLToPath(new URL("../deploy/server/deploy.sh", import.meta.url)),
    "utf8",
  );

  assert.match(unit, /Environment=HOSTNAME=127\.0\.0\.1/);
  assert.match(unit, /ExecStart=.*\/\.next\/standalone\/server\.js/);
  assert.doesNotMatch(unit, /next\/dist\/bin\/next start/);
  assert.match(deployScript, /\.next\/standalone\/\.next\/static/);
  assert.match(deployScript, /\.next\/standalone\/public/);
});

test("server deployment keeps mutable JSON state outside immutable releases", async () => {
  const deployScript = await readFile(
    fileURLToPath(new URL("../deploy/server/deploy.sh", import.meta.url)),
    "utf8",
  );

  assert.match(deployScript, /STATE_ROOT="\$\{STATE_ROOT:-\/var\/lib\/yubit-academy\/runtime\}"/);
  assert.match(deployScript, /JSON_STORE_BACKEND=local/);
  assert.match(deployScript, /JSON_STORE_DIRECTORY=%s/);
  assert.match(deployScript, /ln -s "\$STATE_ROOT" "\$release\/\.runtime"/);
});

test("server deployment removes conflicting JSON storage settings from the primary environment", async () => {
  const deployScript = await readFile(
    fileURLToPath(new URL("../deploy/server/deploy.sh", import.meta.url)),
    "utf8",
  );

  assert.match(deployScript, /awk .*JSON_STORE_BACKEND\|JSON_STORE_DIRECTORY/);
  assert.match(deployScript, /JSON_STORE_BACKEND=local/);
  assert.match(deployScript, /JSON_STORE_DIRECTORY=%s/);
  assert.match(deployScript, /install -m 0600 -o root -g root .*"\$env_pending"/);
  assert.match(deployScript, /mv -f "\$env_pending" "\$ENV_FILE"/);
});

test("server deployment can prune old releases containing root-owned build files", async () => {
  const deployScript = await readFile(
    fileURLToPath(new URL("../deploy/server/deploy.sh", import.meta.url)),
    "utf8",
  );

  assert.match(deployScript, /xargs -r sudo rm -rf/);
});

test("production redirects use the public HTTPS origin instead of the private listener", async () => {
  const middleware = await readFile(
    fileURLToPath(new URL("../middleware.js", import.meta.url)),
    "utf8",
  );
  const nginx = await readFile(
    fileURLToPath(new URL("../deploy/nginx/yubit-academy.conf", import.meta.url)),
    "utf8",
  );
  const deployScript = await readFile(
    fileURLToPath(new URL("../deploy/server/deploy.sh", import.meta.url)),
    "utf8",
  );

  assert.match(middleware, /process\.env\.APP_BASE_URL/);
  assert.doesNotMatch(middleware, /new URL\("\/login", request\.url\)/);
  assert.match(nginx, /return 30[18] https:\/\/__SERVER_NAME__\$request_uri;/);
  assert.doesNotMatch(nginx, /return 30[12] http:\/\/__SERVER_NAME__/);
  assert.match(deployScript, /public_location=.*https:\/\/\$SERVER_NAME\//s);
  assert.match(deployScript, /\$public_location" != "https:\/\/\$SERVER_NAME\/login/);
  assert.match(deployScript, /ip_location=.*http:\/\/\$SERVER_IP\//s);
  assert.match(deployScript, /\$ip_location" != "https:\/\/\$SERVER_NAME\//);
});

test("callCronEndpoint authenticates and validates the response", async () => {
  const requests = [];
  const result = await callCronEndpoint({
    baseUrl: "http://127.0.0.1:4174",
    secret: "worker-secret",
    path: "/api/cron/trading-reconcile",
    timeoutMs: 5_000,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ ok: true, reconciled: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(requests[0].url, "http://127.0.0.1:4174/api/cron/trading-reconcile");
  assert.equal(requests[0].options.headers.authorization, "Bearer worker-secret");
  assert.deepEqual(result, { ok: true, reconciled: 2 });
});

test("callCronEndpoint rejects HTTP and application failures", async () => {
  await assert.rejects(
    callCronEndpoint({
      baseUrl: "http://127.0.0.1:4174",
      secret: "secret",
      path: "/api/cron/agents",
      fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: "boom" }), { status: 500 }),
    }),
    /boom/,
  );
});

test("drainDistributionQueue keeps claiming until no work remains", async () => {
  const replies = [
    { ok: true, claimed: 1, results: [{ status: "sent" }] },
    { ok: true, claimed: 1, results: [{ status: "sent" }] },
    { ok: true, claimed: 0, results: [] },
  ];
  const calls = [];
  const result = await drainDistributionQueue({
    maxClaims: 10,
    callEndpoint: async (path) => {
      calls.push(path);
      return replies.shift();
    },
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(result, { requests: 3, claimed: 2, drained: true });
});

test("drainDistributionQueue enforces a bounded batch", async () => {
  const result = await drainDistributionQueue({
    maxClaims: 3,
    callEndpoint: async () => ({ ok: true, claimed: 1, results: [{ status: "sent" }] }),
  });

  assert.deepEqual(result, { requests: 3, claimed: 3, drained: false });
});
