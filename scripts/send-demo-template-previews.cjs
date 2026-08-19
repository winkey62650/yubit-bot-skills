const fs = require("node:fs");
const path = require("node:path");
const { request } = require("playwright");
const { authorizeProductionConfiguration, buildVercelProtectionHeaders } = require("../lib/release-gate.cjs");

const { baseUrl } = authorizeProductionConfiguration(process.env, { operation: "DEMO 模板安全预览", apply: false });
const username = process.env.TEST_USERNAME || process.env.AUTH_USERNAME;
const password = process.env.TEST_PASSWORD || process.env.AUTH_PASSWORD;
const artifactPath = path.resolve(process.env.TEST_REPORT_PATH || "artifacts/demo-template-preview-report.json");
const protectionHeaders = buildVercelProtectionHeaders(process.env.VERCEL_AUTOMATION_BYPASS_SECRET);
if (!username || !password) throw new Error("TEST_USERNAME/TEST_PASSWORD or AUTH_USERNAME/AUTH_PASSWORD are required");

const allTemplates = [
  { contentType: "crypto-daily", jobId: "crypto-daily" },
  { contentType: "weekly-calendar", jobId: "weekly-calendar" },
  { contentType: "data-release-updates", jobId: "data-release-updates" },
  { contentType: "daily-analysis", jobId: "daily-analysis" },
  { contentType: "whale-signals", jobId: "whale-hourly" },
  { contentType: "agent-sync", jobId: "agent-sync-4h" },
];
const selectedTypes = new Set(String(process.env.TEST_CONTENT_TYPES || "").split(",").map((value) => value.trim()).filter(Boolean));
const templates = selectedTypes.size ? allTemplates.filter((item) => selectedTypes.has(item.contentType)) : allTemplates;
if (!templates.length) throw new Error("TEST_CONTENT_TYPES did not match a supported template");

async function json(response, label) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok() || payload.ok === false) throw new Error(`${label}: HTTP ${response.status()} · ${payload.error || "请求失败"}`);
  return payload;
}

(async () => {
  const api = await request.newContext({ baseURL: baseUrl, ...(protectionHeaders ? { extraHTTPHeaders: protectionHeaders } : {}) });
  const report = { baseUrl, dryRun: true, startedAt: new Date().toISOString(), previews: [] };
  try {
    await json(await api.post("/api/auth/login", { data: { username, password } }), "登录");
    for (const template of templates) {
      const payload = await json(await api.post("/api/automation-test", {
        data: { jobId: template.jobId }, timeout: 60_000,
      }), `预览 ${template.contentType}`);
      const preview = payload.result?.preview || {};
      report.previews.push({
        ...template,
        publishable: preview.publishable ?? preview.document?.publishable ?? false,
        skipReason: preview.skipReason || preview.document?.skipReason || null,
        sources: preview.sources || preview.diagnostics?.sources || [],
        warnings: preview.warnings || preview.diagnostics?.warnings || [],
        document: preview.document || null,
      });
    }
    report.finishedAt = new Date().toISOString();
    report.ok = report.previews.length === templates.length
      && report.previews.every((item) => item.publishable || item.skipReason);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    await api.dispose();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
