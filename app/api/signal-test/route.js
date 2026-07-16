import { NextResponse } from "next/server";
import { runAutomationJob } from "../../../lib/automation-jobs.mjs";

const mapping = {
  futuresCard: "daily-analysis",
  tradfiCard: "daily-analysis",
  dailyAnalysis: "daily-analysis",
  whaleHourly: "whale-hourly"
};

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const jobId = mapping[body.scriptId] || body.jobId;
  if (!jobId) return NextResponse.json({ ok: false, error: "Unknown signal strategy" }, { status: 400 });
  try {
    const result = await runAutomationJob(jobId, {
      dryRun: true,
      force: true,
      publicBaseUrl: new URL(request.url).origin
    });
    return NextResponse.json({ ok: true, dryRun: true, result, stdout: JSON.stringify(result.preview, null, 2), testThreadId: result.target?.threadId || null });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
