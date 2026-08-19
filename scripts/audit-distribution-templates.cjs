const fs = require("node:fs");
const path = require("node:path");
const { request } = require("playwright");
const { authorizeProductionConfiguration, buildVercelProtectionHeaders } = require("../lib/release-gate.cjs");

const { baseUrl } = authorizeProductionConfiguration(process.env, { operation: "内容模板只读预览审计", apply: false });
const username = process.env.TEST_USERNAME || process.env.AUTH_USERNAME;
const password = process.env.TEST_PASSWORD || process.env.AUTH_PASSWORD;
const artifactDir = path.resolve(process.env.TEST_ARTIFACT_DIR || "artifacts/distribution-template-audit");
const protectionHeaders = buildVercelProtectionHeaders(process.env.VERCEL_AUTOMATION_BYPASS_SECRET);
if (!username || !password) throw new Error("TEST_USERNAME/TEST_PASSWORD or AUTH_USERNAME/AUTH_PASSWORD are required");

const expected = [
  { jobId: "crypto-daily", contentType: "crypto-daily" },
  { jobId: "weekly-calendar", contentType: "weekly-calendar" },
  { jobId: "data-release-updates", contentType: "data-release-updates" },
  { jobId: "daily-analysis", contentType: "daily-analysis" },
  { jobId: "whale-hourly", contentType: "whale-signals" },
  { jobId: "agent-sync-4h", contentType: "agent-sync" },
];

async function json(response, label) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok() || payload.ok === false) throw new Error(`${label}: HTTP ${response.status()} · ${payload.error || "请求失败"}`);
  return payload;
}

(async () => {
  fs.mkdirSync(artifactDir, { recursive: true });
  const api = await request.newContext({ baseURL: baseUrl, ...(protectionHeaders ? { extraHTTPHeaders: protectionHeaders } : {}) });
  try {
    await json(await api.post("/api/auth/login", { data: { username, password } }), "登录");
    const [groups, distribution] = await Promise.all([
      json(await api.get("/api/group-config"), "读取群配置"),
      json(await api.get("/api/distribution"), "读取规则"),
    ]);
    const templates = [];
    for (const item of expected) {
      const payload = await json(await api.post("/api/automation-test", {
        data: { jobId: item.jobId }, timeout: 60_000,
      }), `预览 ${item.contentType}`);
      const preview = payload.result?.preview || {};
      templates.push({
        ...item,
        publishable: preview.publishable ?? preview.document?.publishable ?? false,
        skipReason: preview.skipReason || preview.document?.skipReason || null,
        sources: preview.sources || preview.diagnostics?.sources || [],
        warnings: preview.warnings || preview.diagnostics?.warnings || [],
        document: preview.document || null,
      });
    }
    const report = {
      ok: templates.length === expected.length && templates.every((item) => item.publishable || item.skipReason),
      baseUrl, dryRun: true, groupCount: (groups.groups || []).length,
      ruleCount: (distribution.rules || []).length, templates,
    };
    fs.writeFileSync(path.join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await api.dispose();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
