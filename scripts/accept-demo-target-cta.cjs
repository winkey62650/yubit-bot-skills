const { request } = require("playwright");
const { authorizeProductionConfiguration, buildVercelProtectionHeaders } = require("../lib/release-gate.cjs");

const { baseUrl } = authorizeProductionConfiguration(process.env, {
  operation: "DEMO 群 CTA 只读预览审计",
  apply: false,
});
const username = process.env.TEST_USERNAME || process.env.AUTH_USERNAME;
const password = process.env.TEST_PASSWORD || process.env.AUTH_PASSWORD;
const protectionHeaders = buildVercelProtectionHeaders(process.env.VERCEL_AUTOMATION_BYPASS_SECRET);

if (!username || !password) {
  throw new Error("TEST_USERNAME/TEST_PASSWORD or AUTH_USERNAME/AUTH_PASSWORD are required");
}

async function json(response, label) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok() || payload.ok === false) {
    throw new Error(`${label}: HTTP ${response.status()} ${payload.error || "request failed"}`);
  }
  return payload;
}

function hasReliableSource(sources = []) {
  return Array.isArray(sources) && sources.some((source) => (
    ["ok", "healthy", "success"].includes(String(source?.status || "").trim().toLowerCase())
  ));
}

(async () => {
  const api = await request.newContext({
    baseURL: baseUrl,
    ...(protectionHeaders ? { extraHTTPHeaders: protectionHeaders } : {}),
  });
  try {
    await json(await api.post("/api/auth/login", { data: { username, password } }), "login");
    const [groupConfig, destinationCta, previewPayload] = await Promise.all([
      json(await api.get("/api/group-config"), "group config"),
      json(await api.get("/api/destination-cta"), "destination CTA"),
      json(await api.post("/api/automation-test", {
        data: { jobId: "crypto-daily" },
        timeout: 60_000,
      }), "crypto daily preview"),
    ]);

    const demo = (groupConfig.groups || []).find((group) => /demo\s*academy/i.test(group.title || ""));
    if (!demo) throw new Error("DEMO Academy was not found");
    const ctaKey = `telegram:${String(demo.chatId)}`;
    const cta = destinationCta.registry?.[ctaKey] || null;
    const preview = previewPayload.result?.preview || {};
    const sources = [preview.sources, preview.diagnostics?.sources, preview.document?.diagnostics?.sources]
      .find((items) => Array.isArray(items) && items.length > 0) || [];
    const publishable = preview.publishable ?? preview.document?.publishable ?? false;
    const skipReason = preview.skipReason || preview.document?.skipReason || null;
    const passed = Boolean(cta)
      && hasReliableSource(sources)
      && (publishable === true || Boolean(skipReason));

    process.stdout.write(`${JSON.stringify({
      passed,
      dryRun: true,
      deliveryAttempted: false,
      baseUrl,
      group: {
        chatId: String(demo.chatId),
        title: demo.title,
        topicCount: Array.isArray(demo.topics) ? demo.topics.length : 0,
      },
      cta: cta ? {
        scope: "telegram-group",
        enabled: cta.ctaEnabled === true,
        contentConfigured: Boolean(String(cta.ctaContent || "").trim()),
      } : null,
      preview: {
        publishable,
        skipReason,
        sourceHealthOk: hasReliableSource(sources),
        sources,
        warnings: preview.warnings || preview.diagnostics?.warnings || [],
        document: preview.document || null,
      },
    }, null, 2)}\n`);
    if (!passed) process.exitCode = 1;
  } finally {
    await api.dispose();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
