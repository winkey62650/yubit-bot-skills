import assert from "node:assert/strict";
import test from "node:test";

import {
  isLarkMonitorDue,
  readLarkMonitorStatus,
  runLarkMonitor,
  runSavedLarkMonitor,
  sendLarkText,
} from "../lib/lark-monitor.mjs";

const enabledSettings = {
  webhook: "https://open.larksuite.com/open-apis/bot/v2/hook/test-token",
  frequency: "每 15 分钟",
  alertMode: "异常才推送",
  failureThreshold: "1 次失败立即告警",
  environment: "生产环境",
  status: "启用",
};

test("sendLarkText accepts a successful Lark application response", async () => {
  const requests = [];
  const result = await sendLarkText(enabledSettings.webhook, "test message", {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 });
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, enabledSettings.webhook);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    msg_type: "text",
    content: { text: "test message" },
  });
  assert.equal(result.ok, true);
});

test("sendLarkText rejects a Lark application error returned with HTTP 200", async () => {
  await assert.rejects(
    sendLarkText(enabledSettings.webhook, "test message", {
      fetchImpl: async () => new Response(JSON.stringify({ code: 19024, msg: "Key Words Not Found" }), { status: 200 }),
    }),
    /Key Words Not Found/,
  );
});

test("isLarkMonitorDue respects the saved frequency", () => {
  assert.equal(isLarkMonitorDue(enabledSettings, { lastRunAt: "2026-07-17T00:00:00.000Z" }, new Date("2026-07-17T00:14:59.000Z")), false);
  assert.equal(isLarkMonitorDue(enabledSettings, { lastRunAt: "2026-07-17T00:00:00.000Z" }, new Date("2026-07-17T00:15:00.000Z")), true);
  assert.equal(isLarkMonitorDue({ ...enabledSettings, status: "暂停" }, {}, new Date()), false);
});

test("runLarkMonitor forces a real test notification and records a safe result", async () => {
  const sent = [];
  const result = await runLarkMonitor({
    settings: enabledSettings,
    previousState: {},
    force: true,
    now: new Date("2026-07-17T01:00:00.000Z"),
    performChecks: async () => [{ name: "生产后台", target: "/login", ok: true, message: "200 OK", latencyMs: 12 }],
    sendText: async (webhook, text) => {
      sent.push({ webhook, text });
      return { ok: true };
    },
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Lark 推送测试/);
  assert.equal(result.sent, true);
  assert.equal(result.state.lastResult.ok, true);
  assert.equal(result.state.lastResult.sent, true);
  assert.equal(JSON.stringify(result).includes("test-token"), false);
});

test("runLarkMonitor only alerts after the configured consecutive-failure threshold", async () => {
  let sendCount = 0;
  const settings = { ...enabledSettings, failureThreshold: "2 次连续失败告警" };
  const first = await runLarkMonitor({
    settings,
    previousState: {},
    now: new Date("2026-07-17T01:00:00.000Z"),
    performChecks: async () => [{ name: "生产后台", ok: false, message: "timeout", latencyMs: 5000 }],
    sendText: async () => { sendCount += 1; return { ok: true }; },
  });
  const second = await runLarkMonitor({
    settings,
    previousState: first.state,
    now: new Date("2026-07-17T01:15:00.000Z"),
    performChecks: async () => [{ name: "生产后台", ok: false, message: "timeout", latencyMs: 5000 }],
    sendText: async () => { sendCount += 1; return { ok: true }; },
  });

  assert.equal(first.sent, false);
  assert.equal(second.sent, true);
  assert.equal(second.state.consecutiveFailures, 2);
  assert.equal(sendCount, 1);
});

test("saved monitor status only verifies the webhook that actually received a message", async () => {
  const store = new Map([
    ["workspace-state/settings.json", { state: enabledSettings }],
  ]);
  const readJsonImpl = async (pathname, fallback) => store.has(pathname) ? store.get(pathname) : fallback;
  const writeJsonImpl = async (pathname, value) => { store.set(pathname, value); return value; };

  await runSavedLarkMonitor({
    force: true,
    now: new Date("2026-07-17T02:00:00.000Z"),
    readJsonImpl,
    writeJsonImpl,
    performChecks: async () => [{ name: "生产后台", ok: true, message: "200 OK", latencyMs: 10 }],
    fetchImpl: async () => new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 }),
  });
  assert.equal((await readLarkMonitorStatus({ readJsonImpl })).verified, true);

  store.set("workspace-state/settings.json", { state: { ...enabledSettings, webhook: `${enabledSettings.webhook}-changed` } });
  assert.equal((await readLarkMonitorStatus({ readJsonImpl })).verified, false);
});
