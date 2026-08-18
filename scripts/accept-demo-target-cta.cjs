const { request } = require("playwright");

const baseURL = String(process.env.TEST_BASE_URL || "").replace(/\/$/, "");
const username = process.env.TEST_USERNAME;
const password = process.env.TEST_PASSWORD;

if (!baseURL || !username || !password) {
  throw new Error("TEST_BASE_URL, TEST_USERNAME and TEST_PASSWORD are required");
}

function sequenceOf(name) {
  return Number(String(name || "").trim().match(/^(\d+)\s*[.\u3001)]/)?.[1] || 0);
}

async function json(response, label) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok() || payload.ok === false) {
    throw new Error(`${label}: HTTP ${response.status()} ${payload.error || "request failed"}`);
  }
  return payload;
}

function textsOf(plan) {
  return (plan?.steps || []).map((step) => String(step?.payload?.text || step?.payload?.caption || step?.payload?.content || "")).join("\n");
}

(async () => {
  const api = await request.newContext({ baseURL });
  try {
    await json(await api.post("/api/auth/login", { data: { username, password } }), "login");
    const config = await json(await api.get("/api/group-config"), "group config");
    const demo = (config.groups || []).find((group) => /demo\s*academy/i.test(group.title || "") && (group.topics || []).length >= 7);
    if (!demo) throw new Error("DEMO Academy with seven topics was not found");

    const targets = [
      {
        sequence: 3,
        ctaText: "View Market Events on YUBIT",
        ctaUrl: "https://www.yubit.vip/?utm_source=telegram&utm_medium=demo&utm_campaign=cta_acceptance&utm_content=market_events"
      },
      {
        sequence: 4,
        ctaText: "View Market Analysis on YUBIT",
        ctaUrl: "https://www.yubit.vip/?utm_source=telegram&utm_medium=demo&utm_campaign=cta_acceptance&utm_content=market_analysis"
      }
    ].map((definition) => {
      const topic = (demo.topics || []).find((item) => sequenceOf(item.name || item.title) === definition.sequence);
      if (!topic?.threadId) throw new Error(`DEMO topic ${definition.sequence} was not found`);
      return {
        platform: "telegram",
        chatId: String(demo.chatId),
        threadId: Number(topic.threadId),
        groupName: demo.title,
        topicName: topic.name || topic.title,
        ctaEnabled: true,
        ctaText: definition.ctaText,
        ctaUrl: definition.ctaUrl
      };
    });

    const name = `DEMO CTA multi-channel acceptance - ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;
    const saved = await json(await api.post("/api/distribution", { data: { rule: {
      kind: "automation",
      name,
      contentType: "daily-events",
      schedulePreset: "daily-0800-utc",
      enabled: false,
      targets
    } } }), "save rule");
    const ruleId = saved.rule?.id;
    if (!ruleId) throw new Error("saved rule did not return an id");

    const validation = await json(await api.post("/api/distribution", {
      data: { action: "validate", id: ruleId },
      timeout: 45_000
    }), "validate rule");
    if (!validation.result?.ok) throw new Error("runtime validation failed");

    const execution = await json(await api.post("/api/distribution", {
      data: { action: "run-now", id: ruleId },
      timeout: 120_000
    }), "run rule");
    const run = execution.result?.run || {};
    const plans = run.preview?.deliveryPlans || [];
    const results = run.preview?.targetResults || [];

    const targetChecks = targets.map((target) => {
      const plan = plans.find((item) => String(item.target?.chatId) === target.chatId && Number(item.target?.threadId) === target.threadId);
      const text = textsOf(plan);
      const other = targets.find((item) => item.threadId !== target.threadId);
      const result = results.find((item) => String(item.target?.chatId) === target.chatId && Number(item.target?.threadId) === target.threadId);
      return {
        topicName: target.topicName,
        threadId: target.threadId,
        ownCtaPresent: text.includes(target.ctaText) && text.includes(target.ctaUrl),
        otherCtaAbsent: !text.includes(other.ctaText) && !text.includes(other.ctaUrl),
        deliveryStatus: result?.status || "missing",
        messageIds: result?.messageIds || (result?.messageId ? [result.messageId] : [])
      };
    });

    const overview = await json(await api.get("/api/distribution"), "distribution overview");
    const persisted = (overview.rules || []).find((rule) => rule.id === ruleId);
    const savedCtas = persisted?.targets || [];
    const persistedCorrectly = targets.every((target) => savedCtas.some((savedTarget) =>
      String(savedTarget.chatId) === target.chatId
      && Number(savedTarget.threadId) === target.threadId
      && savedTarget.ctaEnabled === true
      && savedTarget.ctaText === target.ctaText
      && savedTarget.ctaUrl === target.ctaUrl
    ));

    const passed = execution.result?.status === "success"
      && persisted?.enabled === false
      && persistedCorrectly
      && targetChecks.every((item) => item.ownCtaPresent && item.otherCtaAbsent && item.deliveryStatus === "success" && item.messageIds.length > 0);

    const removedRuleIds = [];
    if (passed) {
      const staleRules = (overview.rules || []).filter((rule) =>
        rule.id !== ruleId && String(rule.name || "").startsWith("DEMO CTA multi-channel acceptance -")
      );
      for (const staleRule of staleRules) {
        await json(await api.post("/api/distribution", {
          data: { action: "delete", id: staleRule.id }
        }), `delete stale acceptance rule ${staleRule.id}`);
        removedRuleIds.push(staleRule.id);
      }
    }

    process.stdout.write(`${JSON.stringify({
      passed,
      ruleId,
      ruleName: name,
      ruleEnabled: persisted?.enabled,
      runtimeValidation: validation.result?.ok,
      executionStatus: execution.result?.status,
      persistedCorrectly,
      removedRuleIds,
      targets: targetChecks
    }, null, 2)}\n`);
    if (!passed) process.exitCode = 1;
  } finally {
    await api.dispose();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
