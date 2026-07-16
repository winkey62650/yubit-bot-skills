import { NextResponse } from "next/server";
import { runAutomationJob } from "../../../lib/automation-jobs.mjs";

export const maxDuration = 30;

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    const result = await runAutomationJob(String(body.jobId || ""), {
      dryRun: true,
      force: true,
      publicBaseUrl: new URL(request.url).origin
    });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
