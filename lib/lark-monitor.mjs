import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

import { readJson, writeJson } from "./json-store.js";

const settingsPath = "workspace-state/settings.json";
const monitorStatePath = "lark-monitor/status.json";
const frequencyMap = new Map([
  ["每 5 分钟", 5 * 60_000],
  ["每 15 分钟", 15 * 60_000],
  ["每 30 分钟", 30 * 60_000],
  ["每 1 小时", 60 * 60_000],
]);
const failureThresholdMap = new Map([
  ["1 次失败立即告警", 1],
  ["2 次连续失败告警", 2],
  ["3 次连续失败告警", 3],
]);

export function isLarkMonitorDue(settings = {}, state = {}, now = new Date()) {
  if (settings.status !== "启用" || !String(settings.webhook || "").trim()) return false;
  const lastRunAt = Date.parse(String(state.lastRunAt || ""));
  if (!Number.isFinite(lastRunAt)) return true;
  const intervalMs = frequencyMap.get(settings.frequency) || 5 * 60_000;
  return now.getTime() - lastRunAt >= intervalMs;
}

export async function sendLarkText(webhook, text, { fetchImpl = fetch } = {}) {
  const target = String(webhook || "").trim();
  if (!/^https:\/\/(?:open\.larksuite\.com|open\.feishu\.cn)\/open-apis\/bot\/v2\/hook\//.test(target)) {
    throw new Error("Lark Webhook 地址无效");
  }
  const response = await fetchImpl(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: { text } }),
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await response.text();
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = {};
  }
  const applicationCode = body.code ?? body.StatusCode ?? 0;
  if (!response.ok || Number(applicationCode) !== 0) {
    const message = body.msg || body.StatusMessage || raw || `HTTP ${response.status}`;
    throw new Error(`Lark 推送失败：${message}`);
  }
  return { ok: true, status: response.status, message: body.msg || body.StatusMessage || "success" };
}

export async function runLarkMonitor({
  settings = {},
  previousState = {},
  force = false,
  now = new Date(),
  performChecks = performProductionHealthChecks,
  sendText = (webhook, text) => sendLarkText(webhook, text),
} = {}) {
  const webhook = String(settings.webhook || "").trim();
  if (!webhook) throw new Error("请先保存 Lark Webhook");
  if (!force && !isLarkMonitorDue(settings, previousState, now)) {
    return { skipped: true, reason: settings.status === "启用" ? "not-due" : "paused", sent: false, state: previousState };
  }

  const checks = sanitizeChecks(await performChecks({ settings, now }));
  const failed = checks.filter((item) => !item.ok);
  const ok = failed.length === 0;
  const previousFailures = Math.max(0, Number(previousState.consecutiveFailures) || 0);
  const consecutiveFailures = ok ? 0 : previousFailures + 1;
  const threshold = failureThresholdMap.get(settings.failureThreshold) || 2;
  const shouldSend = force || shouldNotify({
    settings,
    previousState,
    now,
    ok,
    previousFailures,
    consecutiveFailures,
    threshold,
  });
  const text = formatMonitorText({ force, now, checks, ok, consecutiveFailures });
  if (shouldSend) await sendText(webhook, text);

  const timestamp = now.toISOString();
  const state = {
    schemaVersion: 1,
    lastRunAt: timestamp,
    lastSuccessAt: ok ? timestamp : previousState.lastSuccessAt || null,
    lastFailureAt: ok ? previousState.lastFailureAt || null : timestamp,
    lastNotificationAt: shouldSend ? timestamp : previousState.lastNotificationAt || null,
    lastSuccessfulNotificationAt: shouldSend ? timestamp : previousState.lastSuccessfulNotificationAt || null,
    webhookFingerprint: shouldSend ? fingerprintWebhook(webhook) : previousState.webhookFingerprint || null,
    consecutiveFailures,
    lastResult: {
      ok,
      sent: shouldSend,
      forced: Boolean(force),
      summary: `${checks.length - failed.length}/${checks.length} 项检查正常`,
      checks,
    },
  };
  return { skipped: false, sent: shouldSend, state };
}

export async function runSavedLarkMonitor({
  force = false,
  now = new Date(),
  fetchImpl = fetch,
  readJsonImpl = readJson,
  writeJsonImpl = writeJson,
  performChecks,
} = {}) {
  const settingsRecord = await readJsonImpl(settingsPath, null);
  const settings = settingsRecord?.state || {};
  const previousState = await readJsonImpl(monitorStatePath, {});
  try {
    const result = await runLarkMonitor({
      settings,
      previousState,
      force,
      now,
      performChecks: performChecks || (() => performProductionHealthChecks({ fetchImpl })),
      sendText: (webhook, text) => sendLarkText(webhook, text, { fetchImpl }),
    });
    if (!result.skipped) await writeJsonImpl(monitorStatePath, result.state);
    return safeMonitorResult(result, settings);
  } catch (error) {
    const timestamp = now.toISOString();
    const failedState = {
      ...previousState,
      schemaVersion: 1,
      lastAttemptAt: timestamp,
      lastRunAt: timestamp,
      lastFailureAt: timestamp,
      lastError: String(error?.message || error).slice(0, 500),
    };
    await writeJsonImpl(monitorStatePath, failedState);
    throw error;
  }
}

export async function readLarkMonitorStatus({ readJsonImpl = readJson } = {}) {
  const [settingsRecord, state] = await Promise.all([
    readJsonImpl(settingsPath, null),
    readJsonImpl(monitorStatePath, {}),
  ]);
  const settings = settingsRecord?.state || {};
  return {
    configured: Boolean(String(settings.webhook || "").trim()),
    enabled: settings.status === "启用",
    verified: Boolean(state.lastSuccessfulNotificationAt && state.webhookFingerprint === fingerprintWebhook(settings.webhook)),
    frequency: settings.frequency || null,
    ...sanitizeState(state),
  };
}

function fingerprintWebhook(webhook) {
  const value = String(webhook || "").trim();
  return value ? createHash("sha256").update(value).digest("hex") : null;
}

export async function performProductionHealthChecks({ fetchImpl = fetch } = {}) {
  const baseUrl = String(process.env.MONITOR_HEALTH_URL || process.env.APP_BASE_URL || `http://127.0.0.1:${process.env.PORT || 4174}`).replace(/\/$/, "");
  const checks = [];
  const started = Date.now();
  try {
    const response = await fetchImpl(`${baseUrl}/login`, {
      headers: { "user-agent": "yubit-academy-lark-monitor/1.0" },
      signal: AbortSignal.timeout(8_000),
    });
    checks.push({ name: "生产后台", target: "/login", ok: response.ok, message: `${response.status} ${response.statusText}`.trim(), latencyMs: Date.now() - started });
  } catch (error) {
    checks.push({ name: "生产后台", target: "/login", ok: false, message: String(error?.message || error), latencyMs: Date.now() - started });
  }

  const files = [
    ["内容分发调度", "scripts/production-worker.mjs"],
    ["自动发布任务", "lib/automation-jobs.mjs"],
    ["新群初始化", "scripts/new-group-setup.mjs"],
    ["Lark 推送", "lib/lark-monitor.mjs"],
  ];
  for (const [name, target] of files) {
    const ok = existsSync(target);
    checks.push({ name, target, ok, message: ok ? "文件就绪" : "文件缺失", latencyMs: 0 });
  }
  return checks;
}

function shouldNotify({ settings, previousState, now, ok, previousFailures, consecutiveFailures, threshold }) {
  if (settings.alertMode === "每次检查都推送") return true;
  if (settings.alertMode === "每日汇总") {
    const lastNotification = Date.parse(String(previousState.lastNotificationAt || ""));
    return !Number.isFinite(lastNotification) || now.getTime() - lastNotification >= 24 * 60 * 60_000;
  }
  if (!ok) return consecutiveFailures >= threshold && previousFailures < threshold;
  return previousFailures >= threshold;
}

function formatMonitorText({ force, now, checks, ok, consecutiveFailures }) {
  const title = force ? "YUBIT Lark 推送测试" : `YUBIT 程序监控：${ok ? "正常" : "异常"}`;
  const failed = checks.filter((item) => !item.ok);
  const lines = [
    title,
    `时间：${now.toISOString()}`,
    `结果：${checks.length - failed.length}/${checks.length} 项检查正常`,
    ...(!ok ? [`连续失败：${consecutiveFailures} 次`] : []),
    "",
    ...checks.map((item) => `${item.ok ? "✅" : "❌"} ${item.name} · ${item.message} · ${item.latencyMs}ms`),
  ];
  return lines.join("\n");
}

function sanitizeChecks(checks) {
  return (Array.isArray(checks) ? checks : []).slice(0, 20).map((item) => ({
    name: String(item?.name || "未命名检查").slice(0, 100),
    target: String(item?.target || "").slice(0, 300),
    ok: item?.ok === true,
    message: String(item?.message || "").slice(0, 500),
    latencyMs: Math.max(0, Number(item?.latencyMs) || 0),
  }));
}

function safeMonitorResult(result, settings) {
  return {
    ...result,
    state: result.state ? sanitizeState(result.state) : result.state,
    configured: Boolean(String(settings.webhook || "").trim()),
    enabled: settings.status === "启用",
  };
}

function sanitizeState(state = {}) {
  return {
    schemaVersion: state.schemaVersion || 1,
    lastRunAt: state.lastRunAt || null,
    lastAttemptAt: state.lastAttemptAt || null,
    lastSuccessAt: state.lastSuccessAt || null,
    lastFailureAt: state.lastFailureAt || null,
    lastNotificationAt: state.lastNotificationAt || null,
    lastSuccessfulNotificationAt: state.lastSuccessfulNotificationAt || null,
    consecutiveFailures: Math.max(0, Number(state.consecutiveFailures) || 0),
    lastError: state.lastError || null,
    lastResult: state.lastResult ? {
      ok: state.lastResult.ok === true,
      sent: state.lastResult.sent === true,
      forced: state.lastResult.forced === true,
      summary: String(state.lastResult.summary || ""),
      checks: sanitizeChecks(state.lastResult.checks),
    } : null,
  };
}
