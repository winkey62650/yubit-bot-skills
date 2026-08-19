const fs = require("node:fs");
const path = require("node:path");
const { request } = require("playwright");
const { authorizeLiveTelegramOperation } = require("../lib/release-gate.cjs");

const { baseUrl } = authorizeLiveTelegramOperation(process.env, {
  operation: "生产自动发布真群验收",
});
const username = process.env.TEST_USERNAME;
const password = process.env.TEST_PASSWORD;
const reportPath = path.resolve(process.env.TEST_REPORT_PATH || "artifacts/production-automation-delivery/report.json");

if (!username || !password) throw new Error("TEST_USERNAME and TEST_PASSWORD are required");

const requiredRules = [
  { contentType: "crypto-daily", label: "每日 Crypto 新闻", minimumTargetCount: 1 },
  { contentType: "weekly-calendar", label: "每周数据日历", minimumTargetCount: 1 },
  { contentType: "daily-analysis", label: "每日行情分析", minimumTargetCount: 1 },
  { contentType: "whale-signals", label: "巨鲸数据 / 大户挂单", minimumTargetCount: 1 },
  { contentType: "agent-sync", label: "Agent 同步", minimumTargetCount: 1 }
];

async function readJson(response, label) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok() || payload.ok === false) {
    throw new Error(`${label}: HTTP ${response.status()} · ${payload.error || "请求失败"}`);
  }
  return payload;
}

function targetKey(target) {
  return `${String(target?.chatId || "")}::${Number(target?.threadId || 0)}`;
}

function idsOf(result) {
  const ids = result?.messageIds?.length
    ? result.messageIds
    : (result?.targetMessageIds?.length
      ? result.targetMessageIds
      : (result?.messageId
        ? [result.messageId]
        : (result?.targetMessageId ? [result.targetMessageId] : [])));
  return ids.map(Number).filter(Number.isFinite);
}

(async () => {
  const api = await request.newContext({ baseURL: baseUrl });
  const report = {
    baseUrl,
    startedAt: new Date().toISOString(),
    results: [],
    failures: []
  };

  try {
    await readJson(await api.post("/api/auth/login", {
      data: { username, password },
      timeout: 30_000
    }), "登录");

    const overview = await readJson(await api.get("/api/distribution", { timeout: 30_000 }), "读取内容分发规则");
    const rules = overview.rules || [];

    for (const expected of requiredRules) {
      const candidates = rules.filter((rule) => rule.kind === "automation" && rule.contentType === expected.contentType);
      const rule = candidates.find((item) => item.enabled) || candidates[0];
      const item = {
        label: expected.label,
        contentType: expected.contentType,
        ruleId: rule?.id || null,
        ruleName: rule?.name || null,
        enabled: rule?.enabled === true,
        schedulePreset: rule?.schedulePreset || null,
        targets: (rule?.targets || []).map((target) => ({
          id: target.id,
          chatId: String(target.chatId),
          threadId: Number(target.threadId || 0),
          groupName: target.groupName,
          topicName: target.topicName
        })),
        validation: null,
        execution: null,
        deliveryLogs: [],
        ok: false
      };
      report.results.push(item);

      if (!rule) {
        report.failures.push(`${expected.label}：线上规则不存在`);
        continue;
      }
      if (!rule.enabled) report.failures.push(`${expected.label}：规则未启用`);
      if ((rule.targets || []).length < expected.minimumTargetCount) report.failures.push(`${expected.label}：没有有效目标`);

      const validationPayload = await readJson(await api.post("/api/distribution", {
        data: { action: "validate", id: rule.id },
        timeout: 60_000
      }), `验证 ${expected.label}`);
      item.validation = {
        ok: validationPayload.result?.ok === true,
        checks: (validationPayload.result?.checks || []).map(({ key, ok, message }) => ({ key, ok, message }))
      };
      if (!item.validation.ok) {
        report.failures.push(`${expected.label}：运行前校验失败`);
        continue;
      }

      const executionPayload = await readJson(await api.post("/api/distribution", {
        data: { action: "run-now", id: rule.id },
        timeout: 120_000
      }), `执行 ${expected.label}`);
      const execution = executionPayload.result || {};
      const targetResults = execution.run?.preview?.targetResults || [];
      item.execution = {
        status: execution.status || null,
        message: execution.run?.message || null,
        imageUrl: execution.run?.preview?.imageUrl || null,
        generatedAt: execution.run?.preview?.generatedAt || null,
        targets: targetResults.map((result) => ({
          target: {
            id: result.target?.id,
            chatId: String(result.target?.chatId || ""),
            threadId: Number(result.target?.threadId || 0),
            groupName: result.target?.groupName,
            topicName: result.target?.topicName
          },
          status: result.status,
          messageIds: idsOf(result),
          error: result.error || null
        }))
      };

      const deliveryPayload = await readJson(await api.get("/api/distribution/logs?limit=500", {
        timeout: 30_000
      }), `读取 ${expected.label} 投递记录`);
      const expectedByKey = new Map(item.execution.targets.map((result) => [targetKey(result.target), result]));
      item.deliveryLogs = (deliveryPayload.items || [])
        .filter((delivery) => delivery.ruleId === rule.id && expectedByKey.has(targetKey(delivery.target)))
        .filter((delivery) => {
          const expectedResult = expectedByKey.get(targetKey(delivery.target));
          const expectedIds = idsOf(expectedResult);
          const loggedIds = idsOf(delivery);
          return expectedIds.length > 0 && expectedIds.every((id) => loggedIds.includes(id));
        })
        .map((delivery) => ({
          id: delivery.id,
          status: delivery.status,
          attempts: delivery.attempts,
          target: delivery.target,
          targetMessageIds: idsOf(delivery),
          error: delivery.error || null,
          deliveredAt: delivery.deliveredAt || null
        }));

      const expectedKeys = new Set(item.targets.map(targetKey));
      const actualKeys = new Set(item.execution.targets.map((result) => targetKey(result.target)));
      const targetsOk = item.execution.targets.length === item.targets.length
        && [...expectedKeys].every((key) => actualKeys.has(key))
        && item.execution.targets.every((result) => result.status === "success" && result.messageIds.length > 0);
      const logsOk = item.deliveryLogs.length === item.targets.length
        && item.deliveryLogs.every((delivery) => delivery.status === "success" && delivery.targetMessageIds.length > 0);
      item.ok = rule.enabled === true
        && item.targets.length >= expected.minimumTargetCount
        && item.validation.ok
        && execution.status === "success"
        && targetsOk
        && logsOk;
      if (!item.ok) report.failures.push(`${expected.label}：真实投递或运行记录不完整`);
    }

    report.finishedAt = new Date().toISOString();
    report.ok = report.results.length === requiredRules.length
      && report.results.every((item) => item.ok)
      && report.failures.length === 0;
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    await api.dispose();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
