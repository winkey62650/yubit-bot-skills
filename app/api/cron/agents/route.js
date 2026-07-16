import { NextResponse } from "next/server";
import { runAutomationJob } from "../../../../lib/automation-jobs.mjs";
import { cronSecretConfig } from "../../../../lib/deployment-config.mjs";

export const maxDuration = 60;

export async function GET(request) {
  if (!authorized(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, result: await runAutomationJob("agent-sync-4h", { dryRun: false }) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

function authorized(request) {
  const secret = cronSecretConfig(process.env).secret;
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}
