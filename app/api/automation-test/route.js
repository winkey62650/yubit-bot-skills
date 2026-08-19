import { NextResponse } from "next/server";
import { resolveAutomationPreviewBaseUrl, runAutomationJob } from "../../../lib/automation-jobs.mjs";
import { getDistributionRepository } from "../../../lib/distribution-repository.mjs";

export const maxDuration = 30;

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    const repository = await getDistributionRepository();
    const previewRepository = typeof repository.getMeta === "function"
      ? { getMeta: repository.getMeta.bind(repository) }
      : {};
    const result = await runAutomationJob(String(body.jobId || ""), {
      dryRun: true,
      force: true,
      repository: previewRepository,
      publicBaseUrl: resolveAutomationPreviewBaseUrl(request.url)
    });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
