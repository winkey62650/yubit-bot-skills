import { NextResponse } from "next/server";
import {
  buildAutomationDiscordPlans,
  buildAutomationTelegramPlans,
  resolveAutomationPreviewBaseUrl,
  runAutomationJob
} from "../../../lib/automation-jobs.mjs";
import { hydrateDestinationCtas } from "../../../lib/destination-cta.mjs";
import { getDistributionRepository } from "../../../lib/distribution-repository.mjs";

export const maxDuration = 30;
const MARKET_PREVIEW_JOBS = new Set(["crypto-daily", "weekly-calendar", "data-release-updates"]);

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
      repository: previewRepository,
      targets: hydratedTargets,
      publicBaseUrl: resolveAutomationPreviewBaseUrl(request.url)
    });
    const jobId = String(body.jobId || "");
    if (result?.preview && MARKET_PREVIEW_JOBS.has(jobId) && hydratedTargets.length) {
      result.preview = {
        ...result.preview,
        targets: hydratedTargets,
        deliveryPlans: [
          ...buildAutomationTelegramPlans(jobId, result.preview, hydratedTargets, result.preview.imageUrl),
          ...buildAutomationDiscordPlans(jobId, result.preview, hydratedTargets, result.preview.imageUrl)
        ]
      };
    }
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
