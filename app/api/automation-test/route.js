import { NextResponse } from "next/server";
import {
  buildAutomationDiscordPlans,
  buildAutomationTelegramPlans,
  resolveAutomationPreviewBaseUrl,
  runAutomationJob
} from "../../../lib/automation-jobs.mjs";
import { hydrateDestinationCtas } from "../../../lib/destination-cta.mjs";
import { getDistributionRepository } from "../../../lib/distribution-repository.mjs";
import { buildMarketIntelligenceDemoPreview } from "../../../lib/market-intelligence-alerts.mjs";
import ctaPreviewEvidence from "../../../lib/cta-preview-evidence.cjs";

const { signCtaPreviewPlans } = ctaPreviewEvidence;

export const maxDuration = 60;
const MARKET_PREVIEW_JOBS = new Set(["crypto-daily", "weekly-calendar", "data-release-updates"]);
const ALERT_DEMO_JOB = "whale-hourly";

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    const repository = await getDistributionRepository();
    const previewRepository = typeof repository.getMeta === "function"
      ? { getMeta: repository.getMeta.bind(repository) }
      : {};
    const requestedTargets = Array.isArray(body.targets) ? body.targets : [];
    const hydratedTargets = await hydrateDestinationCtas(previewRepository, requestedTargets);
    const result = await runAutomationJob(String(body.jobId || ""), {
      dryRun: true,
      force: true,
      readOnlyPreview: true,
      repository: previewRepository,
      targets: hydratedTargets,
      textOnly: body.textOnly === true,
      demoShowcase: body.demoShowcase === true,
      demoAcceptanceBatchId: body.demoAcceptanceBatchId,
      publicBaseUrl: resolveAutomationPreviewBaseUrl(request.url)
    });
    const jobId = String(body.jobId || "");
    const isAlertDemoAcceptance = jobId === ALERT_DEMO_JOB && body.demoAcceptance === true;
    if (isAlertDemoAcceptance && result?.preview) {
      result.preview = buildMarketIntelligenceDemoPreview(result.preview, {
        acceptanceBatchId: body.demoAcceptanceBatchId,
      });
    }
    const shouldBuildPlans = result?.preview
      && hydratedTargets.length
      && (isAlertDemoAcceptance || (result.preview.publishable === true && MARKET_PREVIEW_JOBS.has(jobId)));
    if (shouldBuildPlans) {
      const planMedia = isAlertDemoAcceptance ? result.preview.imageUrl : result.preview.mediaDelivery;
      const deliveryPlans = [
        ...buildAutomationTelegramPlans(jobId, result.preview, hydratedTargets, planMedia),
        ...buildAutomationDiscordPlans(jobId, result.preview, hydratedTargets, planMedia)
      ];
      result.preview = {
        ...result.preview,
        targets: hydratedTargets,
        deliveryPlans: body.previewChallenge
          ? signCtaPreviewPlans(deliveryPlans, {
            secret: process.env.CTA_PREVIEW_EVIDENCE_SECRET,
            challenge: body.previewChallenge,
          })
          : deliveryPlans
      };
    } else if (result?.preview && (MARKET_PREVIEW_JOBS.has(jobId) || isAlertDemoAcceptance)) {
      result.preview = { ...result.preview, targets: hydratedTargets, deliveryPlans: [] };
    }
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
