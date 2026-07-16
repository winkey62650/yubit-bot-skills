import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  authorizeProductionConfiguration,
  buildVercelProtectionHeaders,
  PRODUCTION_RELEASE_PAGES,
  authorizeLiveTelegramOperation,
  evaluateConfiguredGroup,
  evaluatePreviewTradingIsolation,
  evaluateRequiredAutomationRule,
  evaluateTradingRelease,
  normalizeReleaseStage,
  selectAutomationRuleForReconciliation,
  withAsyncCleanup,
} = require("../lib/release-gate.cjs");

function standardTopics() {
  return Array.from({ length: 7 }, (_, index) => ({
    name: `${index + 1}. Topic ${index + 1}`,
    threadId: index + 10,
  }));
}

test("production release gate covers the trading center", () => {
  assert.ok(PRODUCTION_RELEASE_PAGES.includes("/trading"));
});

test("release audit only sends Vercel protection headers when a bypass secret is configured", () => {
  assert.equal(buildVercelProtectionHeaders(""), undefined);
  assert.deepEqual(buildVercelProtectionHeaders("  preview-secret  "), {
    "x-vercel-protection-bypass": "preview-secret",
    "x-vercel-set-bypass-cookie": "true",
  });
});

test("release stage defaults to strict production and rejects unknown values", () => {
  assert.equal(normalizeReleaseStage(), "production");
  assert.equal(normalizeReleaseStage(" PREVIEW "), "preview");
  assert.throws(() => normalizeReleaseStage("staging"), /RELEASE_STAGE/);
});

test("live Telegram operations require an explicit production double confirmation", () => {
  assert.throws(
    () => authorizeLiveTelegramOperation({}, { operation: "自动发布真群验收" }),
    /RELEASE_STAGE=production.*ALLOW_LIVE_TELEGRAM=true.*TEST_BASE_URL/s,
  );
  assert.throws(
    () => authorizeLiveTelegramOperation({
      RELEASE_STAGE: "preview",
      ALLOW_LIVE_TELEGRAM: "true",
      TEST_BASE_URL: "https://preview.example.com",
    }),
    /只能在 production 阶段运行/,
  );
  assert.throws(
    () => authorizeLiveTelegramOperation({
      RELEASE_STAGE: "production",
      ALLOW_LIVE_TELEGRAM: "true",
      TEST_BASE_URL: "http://example.com",
    }),
    /HTTPS/,
  );

  assert.deepEqual(authorizeLiveTelegramOperation({
    RELEASE_STAGE: "production",
    ALLOW_LIVE_TELEGRAM: "true",
    TEST_BASE_URL: "https://academy.example.com/",
  }), {
    stage: "production",
    baseUrl: "https://academy.example.com",
  });
});

test("production configuration planning is read-only by default and applying requires a separate confirmation", () => {
  assert.throws(
    () => authorizeProductionConfiguration({}, { operation: "生产标准规则初始化" }),
    /RELEASE_STAGE=production.*TEST_BASE_URL/s,
  );
  assert.deepEqual(authorizeProductionConfiguration({
    RELEASE_STAGE: "production",
    TEST_BASE_URL: "https://academy.example.com/",
  }, { operation: "生产标准规则初始化" }), {
    stage: "production",
    baseUrl: "https://academy.example.com",
    apply: false,
  });
  assert.throws(
    () => authorizeProductionConfiguration({
      RELEASE_STAGE: "production",
      TEST_BASE_URL: "https://academy.example.com",
    }, { operation: "生产标准规则初始化", apply: true }),
    /APPLY_PRODUCTION_CONFIGURATION=true/,
  );
  assert.deepEqual(authorizeProductionConfiguration({
    RELEASE_STAGE: "production",
    TEST_BASE_URL: "https://academy.example.com",
    APPLY_PRODUCTION_CONFIGURATION: "true",
  }, { operation: "生产标准规则初始化", apply: true }), {
    stage: "production",
    baseUrl: "https://academy.example.com",
    apply: true,
  });
});

test("release audit cleanup runs after both success and failure", async () => {
  const events = [];
  const result = await withAsyncCleanup(
    async () => ({ id: "browser" }),
    async (resource) => {
      events.push(`use:${resource.id}`);
      return "done";
    },
    async (resource) => events.push(`close:${resource.id}`),
  );
  assert.equal(result, "done");
  assert.deepEqual(events, ["use:browser", "close:browser"]);

  await assert.rejects(
    withAsyncCleanup(
      async () => ({ id: "failed-browser" }),
      async () => {
        throw new Error("login rejected");
      },
      async (resource) => events.push(`close:${resource.id}`),
    ),
    /login rejected/,
  );
  assert.equal(events.at(-1), "close:failed-browser");
});

test("configured group accepts extra topics when all seven template slots are valid", () => {
  const result = evaluateConfiguredGroup({
    title: "CryptoGuy Academy",
    chatId: "-1004378187866",
    topics: [
      { name: "❗ 1. READ FIRST - DISCLAIMER", threadId: 11 },
      ...standardTopics().slice(1),
      { name: "Topic 51", threadId: 51 },
      { name: "General Chat", threadId: null },
    ],
  }, { expectedTitle: "CryptoGuy Academy" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.missingTopicNumbers, []);
  assert.equal(result.topicCount, 9);
});

test("configured group rejects a missing template slot or a topic without a thread id", () => {
  const topics = standardTopics();
  topics[5] = { name: "6. Smart Money Tracker", threadId: 0 };
  const result = evaluateConfiguredGroup({
    title: "DEMO Academy",
    chatId: "-1003710405969",
    topics,
  }, { expectedTitle: "DEMO Academy" });

  assert.equal(result.ok, false);
  assert.deepEqual(result.missingTopicNumbers, [6]);
});

test("trading release gate accepts a healthy, configured production workflow", () => {
  const now = new Date("2026-07-16T12:00:00.000Z");
  const failures = evaluateTradingRelease({
    metrics: {
      enabledTraders: 1,
      verifiedAccounts: 1,
      enabledDestinations: 2,
    },
    health: {
      database: { ok: true, driver: "postgres", durable: true },
      speakerBot: { ok: true, configured: true, webhookMatchesDeployment: true },
      scheduler: {
        ok: true,
        configured: true,
        lastRunAt: "2026-07-16T11:55:00.000Z",
      },
    },
  }, { now });

  assert.deepEqual(failures, []);
});

test("trading release gate reports every missing production dependency", () => {
  const failures = evaluateTradingRelease({
    metrics: {
      enabledTraders: 0,
      verifiedAccounts: 0,
      enabledDestinations: 1,
    },
    health: {
      database: { ok: true, driver: "json-local", durable: false },
      speakerBot: { ok: false, configured: true, webhookMatchesDeployment: false },
      scheduler: {
        ok: true,
        configured: true,
        lastRunAt: "2026-07-16T11:00:00.000Z",
      },
    },
  }, { now: new Date("2026-07-16T12:00:00.000Z") });

  assert.deepEqual(failures, [
    "交易中心数据库不是健康的持久化 Postgres",
    "SpeakerBot Webhook 未正确指向当前生产环境",
    "交易订单核对调度超过 15 分钟未成功运行",
    "尚未启用 Trader",
    "尚未配置并验证 YUBIT 只读账户",
    "交易信号发布目标少于 2 个",
  ]);
});

test("preview trading gate requires an isolated database and a disabled SpeakerBot webhook", () => {
  assert.deepEqual(evaluatePreviewTradingIsolation({
    health: {
      database: { ok: true, driver: "postgres", durable: true },
      speakerBot: {
        environment: "preview",
        configured: false,
        configurationAllowed: false,
        errorCode: "SPEAKER_PREVIEW_WEBHOOK_DISABLED",
      },
    },
  }), []);

  assert.deepEqual(evaluatePreviewTradingIsolation({
    health: {
      database: { ok: true, driver: "json-local", durable: false },
      speakerBot: {
        environment: "preview",
        configured: true,
        configurationAllowed: true,
      },
    },
  }), [
    "Preview 交易中心数据库不是健康的持久化 Postgres",
    "Preview SpeakerBot Webhook 未保持隔离禁用状态",
  ]);
});

test("automation release gate requires exactly one enabled rule per content type", () => {
  const rules = [
    { id: "old", kind: "automation", contentType: "daily-analysis", enabled: false, schedulePreset: "daily-0800-utc", targets: [{}, {}] },
    { id: "active", kind: "automation", contentType: "daily-analysis", enabled: true, schedulePreset: "daily-0800-utc", targets: [{}, {}] },
  ];
  const healthy = evaluateRequiredAutomationRule(rules, {
    contentType: "daily-analysis",
    schedulePreset: "daily-0800-utc",
  });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.rule.id, "active");

  const duplicate = evaluateRequiredAutomationRule([
    ...rules,
    { ...rules[1], id: "duplicate" },
  ], {
    contentType: "daily-analysis",
    schedulePreset: "daily-0800-utc",
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.enabledCount, 2);
  assert.match(duplicate.failures.join(" "), /同时启用 2 条/);
});

test("reconciliation never enables multiple ambiguous automation rules", () => {
  const disabled = [
    { id: "one", kind: "automation", contentType: "daily-events", enabled: false },
    { id: "two", kind: "automation", contentType: "daily-events", enabled: false },
  ];
  assert.throws(
    () => selectAutomationRuleForReconciliation(disabled, "daily-events"),
    /存在 2 条待选规则/,
  );
  assert.equal(
    selectAutomationRuleForReconciliation([disabled[0]], "daily-events").id,
    "one",
  );
});
