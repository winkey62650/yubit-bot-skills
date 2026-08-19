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

function evaluateDemoCtaAcceptance(cta, preview, expectedTarget) {
  cta = cta || {};
  preview = preview || {};
  expectedTarget = expectedTarget || {};
  const normalize = (value) => String(value || "").replace(/\r\n?/g, "\n").trim();
  const decodeHtmlEntities = (value) => normalize(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
  const plainText = (value) => decodeHtmlEntities(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[\*_~`>#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const ctaContent = normalize(cta?.ctaContent);
  const usable = cta?.ctaEnabled === true && Boolean(ctaContent);
  const plans = Array.isArray(preview?.deliveryPlans) ? preview.deliveryPlans : [];
  const matchesTarget = (target) => {
    if (expectedTarget?.platform === "discord" || expectedTarget?.guildId) {
      return String(target?.guildId || "") === String(expectedTarget?.guildId || "")
        && (!expectedTarget?.channelId || String(target?.channelId || "") === String(expectedTarget.channelId));
    }
    return String(target?.chatId || "") === String(expectedTarget?.chatId || "")
      && (!expectedTarget?.threadId || String(target?.threadId || "") === String(expectedTarget.threadId));
  };
  const matchingPlans = plans.filter((plan) => matchesTarget(plan?.target));
  const hydrated = usable && matchingPlans.some((plan) => (
    plan?.target?.ctaEnabled === true && normalize(plan?.target?.ctaContent) === ctaContent
  ));
  const visibleLines = ctaContent.split("\n").map(plainText).filter(Boolean);
  const urls = [...new Set(Array.from(ctaContent.matchAll(/https?:\/\/[^\s)>]+/g), (match) => match[0]))];
  const containsCompleteCta = (value) => {
    const raw = normalize(value);
    const decodedRaw = decodeHtmlEntities(raw);
    const visible = plainText(raw);
    return Boolean(raw)
      && visibleLines.every((line) => visible.includes(line))
      && urls.every((url) => decodedRaw.includes(url));
  };
  const renderedSteps = matchingPlans.flatMap((plan) => {
    const steps = Array.isArray(plan?.steps) ? plan.steps : [];
    return steps.flatMap((step, index) => {
      const payload = step?.payload || {};
      const matched = [payload.text, payload.caption, payload.content].some(containsCompleteCta);
      return matched ? [{ index, lastIndex: steps.length - 1 }] : [];
    });
  });
  const rendered = Boolean(visibleLines.length || urls.length)
    && renderedSteps.length === 1
    && renderedSteps[0].index === renderedSteps[0].lastIndex;
  const marker = visibleLines[0] || urls[0] || "";
  return { passed: usable && hydrated && rendered, usable, hydrated, rendered, marker };
}

async function main() {
  const api = await request.newContext({
    baseURL: baseUrl,
    ...(protectionHeaders ? { extraHTTPHeaders: protectionHeaders } : {}),
  });
  try {
    await json(await api.post("/api/auth/login", { data: { username, password } }), "login");
    const [groupConfig, destinationCta] = await Promise.all([
      json(await api.get("/api/group-config"), "group config"),
      json(await api.get("/api/destination-cta"), "destination CTA"),
    ]);

    const demo = (groupConfig.groups || []).find((group) => /demo\s*academy/i.test(group.title || ""));
    if (!demo) throw new Error("DEMO Academy was not found");
    const ctaKey = `telegram:${String(demo.chatId)}`;
    const cta = destinationCta.registry?.[ctaKey] || null;
    const topic = (Array.isArray(demo.topics) ? demo.topics : []).find((item) => (
      Number.isInteger(Number(item?.threadId || item?.topicId || item?.id))
      && Number(item?.threadId || item?.topicId || item?.id) > 0
    ));
    const chatType = demo.chatType === "channel" || demo.type === "channel" ? "channel" : "supergroup";
    if (chatType !== "channel" && !topic) throw new Error("DEMO Academy has no valid Topic target for preview");
    const previewTarget = {
      platform: "telegram",
      chatId: String(demo.chatId),
      chatType,
      ...(topic ? { threadId: Number(topic.threadId || topic.topicId || topic.id) } : {}),
    };
    const previewPayload = await json(await api.post("/api/automation-test", {
      data: { jobId: "crypto-daily", targets: [previewTarget] },
      timeout: 60_000,
    }), "crypto daily preview");
    const preview = previewPayload.result?.preview || {};
    const sources = [preview.sources, preview.diagnostics?.sources, preview.document?.diagnostics?.sources]
      .find((items) => Array.isArray(items) && items.length > 0) || [];
    const publishable = preview.publishable ?? preview.document?.publishable ?? false;
    const skipReason = preview.skipReason || preview.document?.skipReason || null;
    const ctaAcceptance = evaluateDemoCtaAcceptance(cta || {}, preview, previewTarget);
    const passed = ctaAcceptance.passed
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
        hydrated: ctaAcceptance.hydrated,
        rendered: ctaAcceptance.rendered,
        marker: ctaAcceptance.marker,
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
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { evaluateDemoCtaAcceptance };
