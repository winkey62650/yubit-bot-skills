import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildInitializationChecklist,
  getBotOperationalStatus,
  getFriendlyRefreshError,
  getLiveFreshness
} from "../lib/live-status.mjs";

const now = Date.parse("2026-07-17T05:30:00.000Z");

test("live freshness stops presenting expired or missing checks as current", () => {
  assert.deepEqual(getLiveFreshness("", { now }), {
    state: "unknown",
    tone: "amber",
    label: "尚未实时核验",
    ageMs: null
  });
  assert.equal(getLiveFreshness("2026-07-17T05:29:40.000Z", { now }).state, "fresh");
  assert.equal(getLiveFreshness("2026-07-17T05:27:00.000Z", { now }).state, "stale");
  assert.match(getLiveFreshness("2026-07-17T05:27:00.000Z", { now }).label, /状态已过期/);
});

test("refresh failures are converted to concise user-facing messages", () => {
  assert.equal(
    getFriendlyRefreshError("Vercel Blob: No blob credentials found. Pass a token option."),
    "服务端存储暂不可用"
  );
  assert.equal(getFriendlyRefreshError("Failed to fetch"), "网络连接失败");
  assert.equal(
    getFriendlyRefreshError("A very long internal failure ".repeat(10)),
    "实时核验暂时失败，请稍后重试"
  );
});

test("bot operational status distinguishes API reachability from target-group permissions", () => {
  const generatedAt = "2026-07-17T05:29:40.000Z";
  const bot = { name: "AdminBot", status: "在线", identityVerified: true };

  assert.equal(getBotOperationalStatus({ bot, generatedAt, now }).label, "API 可用");
  assert.deepEqual(getBotOperationalStatus({
    bot,
    generatedAt,
    now,
    group: {
      bots: [{ name: "AdminBot", membership: "administrator", isAdmin: true, canManageTopics: true }]
    }
  }), {
    label: "群权限正常",
    tone: "green",
    detail: "管理员 · 可管理 Topic"
  });
  assert.equal(getBotOperationalStatus({
    bot,
    generatedAt,
    now,
    group: { bots: [{ name: "AdminBot", membership: "member", isAdmin: false }] }
  }).label, "非管理员");
  assert.equal(getBotOperationalStatus({
    bot,
    generatedAt: "2026-07-17T05:27:00.000Z",
    now,
    group: { bots: [{ name: "AdminBot", isAdmin: true, canManageTopics: true }] }
  }).label, "状态已过期");
});

test("new-group checklist labels form preparation separately from live permission checks", () => {
  const checklist = buildInitializationChecklist({
    groupName: "CryptoGuy Academy",
    topics: [
      ["1", "❗", "1. READ FIRST - DISCLAIMER", "关闭话题", "Safety notice", "https://example.com/notice.jpg"],
      ["2", "⚡", "2. CryptoGuy Trading Zone", "交流频道", "", ""]
    ],
    group: { readyForInitialization: true },
    generatedAt: "2026-07-17T05:29:40.000Z",
    now
  });

  assert.deepEqual(checklist.map(({ label, value, kind }) => ({ label, value, kind })), [
    { label: "群资料", value: "已填写", kind: "configuration" },
    { label: "Topic 配置", value: "2 个已配置", kind: "configuration" },
    { label: "图文公告", value: "1 条已配置", kind: "configuration" },
    { label: "置顶信息", value: "1 条将置顶", kind: "configuration" },
    { label: "群权限（实时）", value: "已通过", kind: "live" }
  ]);
});

test("status pages auto-refresh and render freshness instead of permanent green snapshots", () => {
  for (const path of ["app/bots/page.jsx", "app/group-config/page.jsx", "app/groups/page.jsx"]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(source, /useLiveAutoRefresh/, `${path} must auto-refresh visible status data`);
    assert.match(source, /LiveStatusStamp/, `${path} must show when its live data was checked`);
  }

  const botSource = readFileSync(new URL("../app/bots/page.jsx", import.meta.url), "utf8");
  assert.match(botSource, /getBotOperationalStatus/);
  assert.doesNotMatch(botSource, /label="在线"/);

  const groupConfigSource = readFileSync(new URL("../app/group-config/page.jsx", import.meta.url), "utf8");
  assert.match(groupConfigSource, /getLiveFreshness/);
  assert.match(groupConfigSource, /状态已过期/);
});
