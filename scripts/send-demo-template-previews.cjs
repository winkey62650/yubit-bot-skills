const fs = require("node:fs");
const path = require("node:path");
const { request } = require("playwright");

const baseUrl = String(process.env.TEST_BASE_URL || "").replace(/\/$/, "");
const username = process.env.TEST_USERNAME;
const password = process.env.TEST_PASSWORD;
const artifactPath = path.resolve(process.env.TEST_REPORT_PATH || "artifacts/demo-template-send-report.json");

if (!baseUrl || !username || !password) {
  throw new Error("TEST_BASE_URL, TEST_USERNAME and TEST_PASSWORD are required");
}

const allTemplates = [
  { contentType: "daily-events", label: "Daily Events", topicSequence: 2 },
  { contentType: "daily-analysis", label: "Daily Analysis", topicSequence: 3 },
  { contentType: "whale-signals", label: "Whale / Smart Money", topicSequence: 6 }
];
const selectedTypes = new Set(String(process.env.TEST_CONTENT_TYPES || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean));
const templates = selectedTypes.size
  ? allTemplates.filter((template) => selectedTypes.has(template.contentType))
  : allTemplates;

if (!templates.length) throw new Error("TEST_CONTENT_TYPES did not match a supported template");

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

(async () => {
  const api = await request.newContext({ baseURL: baseUrl });
  const report = {
    baseUrl,
    startedAt: new Date().toISOString(),
    group: null,
    sends: [],
    cleanup: []
  };

  try {
    await json(await api.post("/api/auth/login", { data: { username, password } }), "login");
    const groupPayload = await json(await api.get("/api/group-config"), "group config");
    const demo = (groupPayload.groups || []).find((group) => /demo\s*academy/i.test(group.title || ""));
    if (!demo) throw new Error("DEMO Academy was not found in the recognized groups");

    report.group = { title: demo.title, chatId: demo.chatId };

    for (const template of templates) {
      const topic = (demo.topics || []).find((item) => sequenceOf(item.name || item.title) === template.topicSequence);
      if (!topic?.threadId) {
        report.sends.push({ contentType: template.contentType, status: "skipped", error: `Topic ${template.topicSequence} was not found` });
        continue;
      }

      let ruleId = null;
      try {
        const saved = await json(await api.post("/api/distribution", {
          data: {
            rule: {
              kind: "automation",
              name: `DEMO template acceptance - ${template.label} - ${Date.now()}`,
              contentType: template.contentType,
              schedulePreset: template.contentType === "whale-signals" ? "hourly" : "daily-0800-utc",
              enabled: false,
              targets: [{
                chatId: String(demo.chatId),
                threadId: Number(topic.threadId),
                groupName: demo.title,
                topicName: topic.name || topic.title
              }]
            }
          }
        }), `save ${template.contentType}`);
        ruleId = saved.rule.id;

        const validation = await json(await api.post("/api/distribution", {
          data: { action: "validate", id: ruleId },
          timeout: 45_000
        }), `validate ${template.contentType}`);
        const checks = validation.result?.checks || [];
        if (!validation.result?.ok) {
          report.sends.push({
            contentType: template.contentType,
            topic: { name: topic.name || topic.title, threadId: topic.threadId },
            status: "validation-failed",
            checks
          });
          continue;
        }

        const execution = await json(await api.post("/api/distribution", {
          data: { action: "run-now", id: ruleId },
          timeout: 90_000
        }), `run ${template.contentType}`);
        const run = execution.result?.run || {};
        const targetResult = run.preview?.targetResults?.[0] || {};
        report.sends.push({
          contentType: template.contentType,
          topic: { name: topic.name || topic.title, threadId: topic.threadId },
          status: execution.result?.status,
          message: run.message,
          messageIds: targetResult.messageIds || (targetResult.messageId ? [targetResult.messageId] : []),
          imageUrl: run.preview?.imageUrl || null,
          checks
        });
      } catch (error) {
        report.sends.push({
          contentType: template.contentType,
          topic: { name: topic.name || topic.title, threadId: topic.threadId },
          status: "failed",
          error: error.message
        });
      } finally {
        if (ruleId) {
          try {
            const deleted = await json(await api.post("/api/distribution", {
              data: { action: "delete", id: ruleId }
            }), `delete ${template.contentType}`);
            report.cleanup.push({ contentType: template.contentType, deleted: Boolean(deleted.ok) });
          } catch (error) {
            report.cleanup.push({ contentType: template.contentType, deleted: false, error: error.message });
          }
        }
      }
    }

    const overview = await json(await api.get("/api/distribution"), "final overview");
    report.temporaryRulesRemaining = (overview.rules || [])
      .filter((rule) => String(rule.name || "").startsWith("DEMO template acceptance -"))
      .map((rule) => ({ id: rule.id, name: rule.name }));
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

    const allSent = report.sends.length === templates.length
      && report.sends.every((item) => item.status === "success" && item.messageIds.length > 0);
    const cleaned = report.cleanup.every((item) => item.deleted) && report.temporaryRulesRemaining.length === 0;
    if (!allSent || !cleaned) process.exitCode = 1;
  } finally {
    await api.dispose();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
