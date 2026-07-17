import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
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
  assert.equal(config.agentIntervalMs, 14_400_000);
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
