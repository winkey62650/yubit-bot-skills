const fs = require("node:fs");
const path = require("node:path");
const { request } = require("playwright");
const { authorizeLiveTelegramOperation } = require("../lib/release-gate.cjs");

const TARGET = Object.freeze({
  id: "market-intelligence-demo",
  platform: "telegram",
  chatId: "-1003710405969",
  threadId: 16,
  groupName: "DEMO Academy",
  topicName: "6. Smart Money Tracker",
});
const CTA_KEY = `telegram:${TARGET.chatId}`;
const TEMPLATE_VERSION = "market-intelligence-alert-v1";
const MAX_POSTER_BYTES = 5 * 1024 * 1024;
const INTERNAL_URL_PATTERN = /152-32-161-174|sslip\.io|\/(?:admin|api)(?:\/|$)/i;

const { baseUrl } = authorizeLiveTelegramOperation(process.env, {
  operation: "Market Intelligence Alert Demo 单次验收发送",
});
const username = String(process.env.TEST_USERNAME || "").trim();
const password = String(process.env.TEST_PASSWORD || "").trim();
const speakerBotToken = String(process.env.SPEAKER_BOT_TOKEN || "").trim();
const trader1BotToken = String(process.env.TRADER1_BOT_TOKEN || "").trim();
const expectedCommitSha = String(process.env.EXPECTED_COMMIT_SHA || "").trim().toLowerCase();
const acceptanceBatchId = String(process.env.MARKET_INTELLIGENCE_DEMO_ACCEPTANCE_BATCH_ID || "").trim().toLowerCase();
const reportPath = path.resolve(process.env.TEST_REPORT_PATH || "artifacts/market-intelligence-demo/report.json");

if (!username || !password) throw new Error("TEST_USERNAME and TEST_PASSWORD are required");
if (!speakerBotToken && !trader1BotToken) throw new Error("SPEAKER_BOT_TOKEN or TRADER1_BOT_TOKEN is required");
if (!/^[0-9a-f]{7,64}$/.test(expectedCommitSha)) throw new Error("EXPECTED_COMMIT_SHA is required");
if (!/^[a-z0-9][a-z0-9-]{5,79}$/.test(acceptanceBatchId)) throw new Error("MARKET_INTELLIGENCE_DEMO_ACCEPTANCE_BATCH_ID is invalid");

async function readJson(response, label) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok() || payload.ok === false) {
    throw new Error(`${label}: HTTP ${response.status()} · ${payload.error || payload.description || "request failed"}`);
  }
  return payload;
}

function assertRelease(release) {
  const actual = String(release?.commitSha || "").trim().toLowerCase();
  if (!actual || (!actual.startsWith(expectedCommitSha) && !expectedCommitSha.startsWith(actual))) {
    throw new Error("The production release does not match EXPECTED_COMMIT_SHA");
  }
  return { commitSha: actual, schemaVersion: release.schemaVersion || null };
}

function extractUrls(value) {
  return [...String(value || "").matchAll(/https?:\/\/[^\s<>)\]"']+/gi)]
    .map((match) => match[0].replace(/&amp;/g, "&"));
}

function inspectCta(registry) {
  const cta = registry?.[CTA_KEY];
  if (cta?.ctaEnabled !== true || !String(cta?.ctaContent || "").trim()) {
    throw new Error(`The saved destination CTA is unavailable for ${CTA_KEY}`);
  }
  if (INTERNAL_URL_PATTERN.test(cta.ctaContent)) throw new Error("The saved destination CTA exposes an internal backend URL");
  return cta;
}

function inspectPreview(payload, cta) {
  const preview = payload?.result?.preview;
  if (!preview || preview.demoAcceptance !== true || preview.currentData !== true || preview.historicalReplay !== false) {
    throw new Error("The preview is not an explicit current-data Demo acceptance artifact");
  }
  if (preview.acceptanceBatchId !== acceptanceBatchId) throw new Error("The Demo acceptance batch identity changed");
  const plans = Array.isArray(preview.deliveryPlans) ? preview.deliveryPlans : [];
  if (plans.length !== 1) throw new Error("Demo acceptance requires exactly one delivery plan");
  const plan = plans[0];
  if (plan.templateVersion !== TEMPLATE_VERSION
    || String(plan.target?.chatId || "") !== TARGET.chatId
    || Number(plan.target?.threadId || 0) !== TARGET.threadId
    || plan.target?.ctaSource !== "destination-registry"
    || plan.target?.ctaEnabled !== true
    || plan.target?.ctaContent !== cta.ctaContent) {
    throw new Error("The Demo plan escaped the approved target, CTA, or template contract");
  }
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (steps.length !== 1 || steps[0]?.method !== "sendPhoto") throw new Error("Demo acceptance must contain exactly one Telegram sendPhoto operation");
  const form = steps[0].payload || {};
  const photo = String(form.photo || "");
  const caption = String(form.caption || "");
  const posterUrl = new URL(photo);
  if (posterUrl.protocol !== "https:"
    || posterUrl.searchParams.get("demo") !== "1"
    || posterUrl.searchParams.get("batch") !== acceptanceBatchId
    || String(form.chat_id) !== TARGET.chatId
    || Number(form.message_thread_id) !== TARGET.threadId
    || form.parse_mode !== "HTML") {
    throw new Error("The Demo Telegram payload is not pinned to its exact acceptance media and topic");
  }
  for (const marker of ["DEMO PREVIEW · FORMAT VALIDATION", "Current live order-book snapshot", "LIQUIDITY ALERT", "FACT", "INTERPRETATION", "WATCH NEXT", "SOURCE"]) {
    if (!caption.includes(marker)) throw new Error(`The Demo caption is missing ${marker}`);
  }
  if (caption.length > 1024) throw new Error("The Demo caption exceeds Telegram's photo caption limit");
  if (INTERNAL_URL_PATTERN.test(caption)) throw new Error("The Demo caption exposes an internal backend URL");
  const expectedUrls = extractUrls(cta.ctaContent);
  const deliveredUrls = extractUrls(caption);
  if (expectedUrls.some((url) => !deliveredUrls.includes(url))) throw new Error("The saved destination CTA was not preserved in the final caption");
  return { preview, plan, form, photo, caption };
}

async function preflightPoster(api, photo) {
  const response = await api.get(photo, { timeout: 90_000 });
  const contentType = String(response.headers()["content-type"] || "").toLowerCase();
  const bytes = await response.body();
  if (!response.ok() || !contentType.startsWith("image/png") || bytes.byteLength < 1024 || bytes.byteLength > MAX_POSTER_BYTES) {
    throw new Error(`Demo poster preflight failed: HTTP ${response.status()} · ${contentType || "missing content-type"} · ${bytes.byteLength} bytes`);
  }
  return { status: response.status(), contentType, byteLength: bytes.byteLength, url: photo };
}

async function resolveSpeakerBot() {
  const candidates = [
    { role: "SpeakerBot.primary", token: speakerBotToken },
    { role: "SpeakerBot.fallback", token: trader1BotToken },
  ].filter((candidate, index, all) => candidate.token
    && all.findIndex((entry) => entry.token === candidate.token) === index);

  for (const candidate of candidates) {
    const telegram = await request.newContext({ baseURL: `https://api.telegram.org/bot${candidate.token}` });
    try {
      const identity = await readJson(await telegram.post("/getMe", { timeout: 30_000 }), "Telegram getMe");
      const botId = Number(identity.result?.id);
      if (!Number.isSafeInteger(botId) || botId <= 0) throw new Error("Telegram getMe returned an invalid bot identity");
      await readJson(await telegram.post("/getChat", {
        form: { chat_id: TARGET.chatId }, timeout: 30_000,
      }), "Telegram getChat");
      const membership = await readJson(await telegram.post("/getChatMember", {
        form: { chat_id: TARGET.chatId, user_id: botId }, timeout: 30_000,
      }), "Telegram getChatMember");
      const status = String(membership.result?.status || "");
      if (["left", "kicked"].includes(status)) throw new Error("SpeakerBot is not a member of the Demo group");
      return {
        telegram,
        identity: {
          role: candidate.role,
          id: botId,
          username: String(identity.result?.username || ""),
          membershipStatus: status,
        },
      };
    } catch {
      await telegram.dispose();
    }
  }
  throw new Error("No configured SpeakerBot credential passed Telegram identity and Demo-group access checks");
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.ACCEPTANCE_QUIET !== "true") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

(async () => {
  const api = await request.newContext({ baseURL: baseUrl });
  const report = {
    ok: false,
    operation: "market-intelligence-alert-demo-acceptance",
    acceptanceBatchId,
    currentData: true,
    historicalReplay: false,
    exactTargets: true,
    startedAt: new Date().toISOString(),
  };
  try {
    await readJson(await api.post("/api/auth/login", {
      data: { username, password }, timeout: 30_000,
    }), "login");
    report.release = assertRelease(await readJson(await api.get("/api/release-info", { timeout: 30_000 }), "release info"));
    const ctaRegistry = await readJson(await api.get("/api/destination-cta", { timeout: 30_000 }), "destination CTA");
    const cta = inspectCta(ctaRegistry.registry);
    const previewPayload = await readJson(await api.post("/api/automation-test", {
      data: {
        jobId: "whale-hourly",
        targets: [TARGET],
        textOnly: false,
        demoAcceptance: true,
        demoAcceptanceBatchId: acceptanceBatchId,
      },
      timeout: 90_000,
    }), "Market Intelligence Demo preview");
    const inspected = inspectPreview(previewPayload, cta);
    report.publicationGate = inspected.preview.alert?.publicationGate || inspected.preview.publicationGate || null;
    report.cta = { key: CTA_KEY, source: inspected.plan.target.ctaSource, enabled: true, urlCount: extractUrls(cta.ctaContent).length };
    report.mediaPreflight = await preflightPoster(api, inspected.photo);

    const resolvedBot = await resolveSpeakerBot();
    report.botIdentity = resolvedBot.identity;

    // All read-only gates have passed. This is the single authorized external mutation; there is deliberately no retry.
    const telegram = resolvedBot.telegram;
    try {
      const sent = await readJson(await telegram.post("/sendPhoto", {
        form: inspected.form,
        timeout: 90_000,
      }), "Telegram sendPhoto");
      const messageId = Number(sent.result?.message_id);
      const messageThreadId = Number(sent.result?.message_thread_id);
      if (!Number.isSafeInteger(messageId) || messageId <= 0 || messageThreadId !== TARGET.threadId) {
        throw new Error("Telegram did not return the expected Demo topic receipt");
      }
      report.delivery = {
        target: { chatId: TARGET.chatId, threadId: TARGET.threadId },
        messageId,
        messageThreadId,
        templateVersion: inspected.plan.templateVersion,
      };
    } finally {
      await telegram.dispose();
    }
    report.ok = true;
    report.completedAt = new Date().toISOString();
    writeReport(report);
  } catch (error) {
    report.error = error.message;
    report.completedAt = new Date().toISOString();
    writeReport(report);
    process.exitCode = 1;
  } finally {
    await api.dispose();
  }
})();
