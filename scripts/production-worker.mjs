#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULTS = Object.freeze({
  distributionIntervalMs: 15_000,
  tradingIntervalMs: 5 * 60_000,
  agentIntervalMs: 4 * 60 * 60_000,
  requestTimeoutMs: 90_000,
  maxDistributionClaims: 10,
});

function positiveInteger(value, fallback, minimum = 1_000) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

export function buildWorkerConfig(env = process.env) {
  const secret = String(env.CRON_SECRET || "").trim();
  if (!secret) throw new Error("CRON_SECRET is required by the production worker");

  const port = positiveInteger(env.PORT, 4174, 1);
  const baseUrl = String(env.WORKER_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/$/, "");
  if (!/^https?:\/\//.test(baseUrl)) throw new Error("WORKER_BASE_URL must be an HTTP(S) URL");

  return {
    baseUrl,
    secret,
    distributionIntervalMs: positiveInteger(
      env.WORKER_DISTRIBUTION_INTERVAL_MS,
      DEFAULTS.distributionIntervalMs,
    ),
    tradingIntervalMs: positiveInteger(env.WORKER_TRADING_INTERVAL_MS, DEFAULTS.tradingIntervalMs),
    agentIntervalMs: positiveInteger(env.WORKER_AGENT_INTERVAL_MS, DEFAULTS.agentIntervalMs),
    requestTimeoutMs: positiveInteger(env.WORKER_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs),
    maxDistributionClaims: positiveInteger(
      env.WORKER_MAX_DISTRIBUTION_CLAIMS,
      DEFAULTS.maxDistributionClaims,
      1,
    ),
  };
}

export async function callCronEndpoint({
  baseUrl,
  secret,
  path,
  timeoutMs = DEFAULTS.requestTimeoutMs,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${secret}`,
      "user-agent": "yubit-academy-production-worker/1.0",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { ok: false, error: `Non-JSON response (${response.status})` };
  }
  if (!response.ok || body?.ok === false) {
    throw new Error(String(body?.error || `HTTP ${response.status}`));
  }
  return body;
}

export async function drainDistributionQueue({ maxClaims = DEFAULTS.maxDistributionClaims, callEndpoint }) {
  let claimed = 0;
  let requests = 0;
  for (; requests < maxClaims; requests += 1) {
    const result = await callEndpoint("/api/cron/distribution");
    const currentClaimed = Math.max(0, Number(result?.claimed) || 0);
    claimed += currentClaimed;
    if (currentClaimed === 0) {
      return { requests: requests + 1, claimed, drained: true };
    }
  }
  return { requests, claimed, drained: false };
}

function structuredLogger(level, event, details = {}) {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details });
  (level === "error" ? console.error : console.log)(entry);
}

function delay(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function runLoop({ name, intervalMs, initialDelayMs, signal, task, logger }) {
  await delay(initialDelayMs, signal);
  while (!signal.aborted) {
    const startedAt = Date.now();
    try {
      const result = await task();
      logger("info", "worker.task.completed", { task: name, durationMs: Date.now() - startedAt, result });
    } catch (error) {
      logger("error", "worker.task.failed", {
        task: name,
        durationMs: Date.now() - startedAt,
        error: String(error?.message || error),
      });
    }
    const elapsed = Date.now() - startedAt;
    await delay(Math.max(1_000, intervalMs - elapsed), signal);
  }
}

export async function startProductionWorker({ env = process.env, fetchImpl = fetch, logger = structuredLogger } = {}) {
  const config = buildWorkerConfig(env);
  const controller = new AbortController();
  const callEndpoint = (path) => callCronEndpoint({
    baseUrl: config.baseUrl,
    secret: config.secret,
    path,
    timeoutMs: config.requestTimeoutMs,
    fetchImpl,
  });

  logger("info", "worker.started", {
    baseUrl: config.baseUrl,
    distributionIntervalMs: config.distributionIntervalMs,
    tradingIntervalMs: config.tradingIntervalMs,
    agentIntervalMs: config.agentIntervalMs,
  });

  const done = Promise.all([
    runLoop({
      name: "distribution",
      intervalMs: config.distributionIntervalMs,
      initialDelayMs: 0,
      signal: controller.signal,
      logger,
      task: () => drainDistributionQueue({
        maxClaims: config.maxDistributionClaims,
        callEndpoint,
      }),
    }),
    runLoop({
      name: "trading-reconcile",
      intervalMs: config.tradingIntervalMs,
      initialDelayMs: 30_000,
      signal: controller.signal,
      logger,
      task: () => callEndpoint("/api/cron/trading-reconcile"),
    }),
    runLoop({
      name: "agent-sync",
      intervalMs: config.agentIntervalMs,
      initialDelayMs: 60_000,
      signal: controller.signal,
      logger,
      task: () => callEndpoint("/api/cron/agents"),
    }),
  ]);

  return {
    config,
    done,
    stop() {
      if (!controller.signal.aborted) {
        logger("info", "worker.stopping");
        controller.abort();
      }
    },
  };
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return pathToFileURL(argvPath).href === moduleUrl;
  }
}

async function main() {
  const worker = await startProductionWorker();
  const stop = () => worker.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await worker.done;
}

if (isMainModule()) {
  main().catch((error) => {
    structuredLogger("error", "worker.crashed", { error: String(error?.message || error) });
    process.exitCode = 1;
  });
}
