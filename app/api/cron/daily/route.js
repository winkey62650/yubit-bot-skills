import { NextResponse } from "next/server";
import { runAutomationJob } from "../../../../lib/automation-jobs.mjs";

export const maxDuration = 60;

export async function GET(request) {
  if (!authorized(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const results = await Promise.allSettled([
    runAutomationJob("daily-events", { dryRun: false }),
    runAutomationJob("daily-analysis", { dryRun: false }),
    runAutomationJob("whale-hourly", { dryRun: false })
  ]);
  return NextResponse.json({ ok: results.every((result) => result.status === "fulfilled"), results: results.map(serialize) });
}

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}

function serialize(result) {
  return result.status === "fulfilled" ? result.value : { status: "failed", message: result.reason?.message || "Unknown error" };
}
